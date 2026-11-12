import { chmod, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGER_LAYER } from '../../src/config/schema.js';
import { makeSandbox, removeOpenSandboxes, withoutHookNotice, type RunResult, type Sandbox } from './harness.js';

let box: Sandbox;
let manager: string;
let shop: string;

beforeEach(async () => {
  box = await makeSandbox();
  manager = join(box.root, 'mgr');
  shop = join(box.root, 'web-factory');
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const initNode = async (home: string, name: string, layer: number): Promise<void> => {
  const args = ['init', '--yes', '--home', home, '--name', name, '--owner-name', 'Test Owner', '--layer', String(layer)];
  const result = await box.run(args);
  // A layer above 2 has no role template, and init warns about it. Any other layer prints nothing on stderr, but the
  // notice of the hook change that the yes flag prints.
  if (layer > MANAGER_LAYER) expect(result.stderr).toContain(`Layer ${layer} has no role template`);
  else expect(withoutHookNotice(result.stderr)).toBe('');
  expect(result.code).toBe(0);
};

const node = (...args: string[]): Promise<RunResult> => box.run(['node', ...args, '--home', manager]);

const childrenJson = async (): Promise<{ id: string; layer: number | null; status: string }[]> => {
  const result = await node('children', '--json');
  expect(result.code).toBe(0);
  return (JSON.parse(result.stdout) as { schema: string; children: { id: string; layer: number | null; status: string }[] })
    .children;
};

describe('factory node (built binary)', () => {
  it('adds a child of the layer below, lists it, and removes it again, with the comments of the owner kept', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    // The children of a node are in the local file. The command edits that file only.
    const configFile = join(manager, 'factory.local.yaml');
    const sharedFile = join(manager, 'factory.yaml');
    const withNote = (await readFile(configFile, 'utf8')).replace('children: []', '# my shops\nchildren: []');
    await writeFile(configFile, withNote);
    const sharedBefore = await readFile(sharedFile, 'utf8');
    const shopConfig = await readFile(join(shop, 'factory.yaml'), 'utf8');

    const added = await node('add-child', shop);
    expect(added.stderr).toBe('');
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Added the child web (layer 1).');
    const text = await readFile(configFile, 'utf8');
    expect(text).toContain(`# my shops\nchildren:\n  - id: web\n    address: "file://${shop}"\n`);
    expect(text).toContain('# People edit this file.');
    expect(await readFile(sharedFile, 'utf8')).toBe(sharedBefore);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(await childrenJson()).toEqual([{ id: 'web', address: `file://${shop}`, layer: 1, status: 'ok', reason: null }]);

    const listed = await node('children');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`web  file://${shop}  layer 1  ok`);

    const removed = await node('remove-child', 'web');
    expect(removed.code).toBe(0);
    expect(await childrenJson()).toEqual([]);
    expect(await readFile(configFile, 'utf8')).toContain('# my shops\nchildren: []');
    expect(await readFile(join(shop, 'factory.yaml'), 'utf8')).toBe(shopConfig);
  });

  it('prints the JSON document with its schema id', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', shop)).code).toBe(0);
    const result = await node('children', '--json');
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'factory.node-children/v1', home: manager, layer: 2 });
  });

  it('warns at a second add of the same child, exits 0 and changes nothing', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', shop)).code).toBe(0);
    const before = await readFile(join(manager, 'factory.local.yaml'), 'utf8');
    const again = await node('add-child', shop);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('web is a child of this node already. Nothing changed.');
    expect(await readFile(join(manager, 'factory.local.yaml'), 'utf8')).toBe(before);
  });

  it('exits 2 for a child on layer 1 of a node on layer 1, because its children are workers', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 1);
    const result = await node('add-child', shop);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('its children are workers');
  });

  it('exits 1 with a remedy for a child on another layer than the layer below', async () => {
    await initNode(shop, 'web', 3);
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', shop);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the child is on layer 3, but a node on layer 2 takes children on layer 1');
    expect(result.stderr).toContain('Add a node on layer 1, or change the layer of the child.');
  });

  it('exits 1 with a remedy for a folder that is no node', async () => {
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', join(box.root, 'nowhere'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no factory.yaml found there');
    expect(result.stderr).toContain('Start the child. Then run "factory node add-child" again.');
  });

  it('exits 1 with a remedy for this home as a child, and for a folder above it', async () => {
    await initNode(manager, 'mgr', 2);
    const inside = await node('add-child', manager);
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain('Name a folder outside this factory folder');
    const above = await node('add-child', box.root);
    expect(above.code).toBe(1);
    expect(above.stderr).toContain('Name a folder that does not hold this factory folder');
  });

  it('refuses an address that is not a file address with exit code 2', async () => {
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', 'ssh://owner@host/srv/web-factory');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('factory runs on one machine: use a file:// address');
  });

  it('exits 2 and names init when factory.yaml has no factory.local.yaml next to it', async () => {
    await initNode(manager, 'mgr', 2);
    await rm(join(manager, 'factory.local.yaml'));
    const result = await node('children');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('factory.local.yaml not found');
    expect(result.stderr).toContain('factory init');
  });

  it('exits 4 for a local file that others can write, and changes no mode', async () => {
    await initNode(manager, 'mgr', 2);
    const path = join(manager, 'factory.local.yaml');
    await chmod(path, 0o666);
    const result = await node('children');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('chmod 600 factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o666);
  });

  it('shows a child as unknown when its config is of an older schema', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', shop)).code).toBe(0);
    await writeFile(join(shop, 'factory.yaml'), 'schema: 1\n');
    const rows = await childrenJson();
    expect(rows).toMatchObject([{ id: 'web', layer: null, status: 'unknown' }]);
    const text = await node('children');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('unknown: factory.yaml has schema 1');
  });
});

describe('factory node send (built binary)', () => {
  const BODY = 'Build the landing page.\r\nKeep it short.\n';

  /** A child on layer 1, a node on layer 2 that lists it, and a task file in the orders folder of the node. */
  const readyPair = async (): Promise<string> => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', shop)).code).toBe(0);
    const task = join(manager, '.factory', 'orders', 'task.md');
    await mkdir(join(manager, '.factory', 'orders'), { recursive: true });
    await writeFile(task, BODY);
    return task;
  };

  it('writes the task into the inbox of a real child folder, as a new file that git ignores', async () => {
    const task = await readyPair();
    const result = await node('send', 'web', '--file', task);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const inbox = join(await realpath(shop), '.factory', 'inbox');
    const names = await readdir(inbox);
    expect(names).toHaveLength(1);
    const file = join(inbox, names[0] ?? '');
    expect(names[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-mgr-[0-9a-f]{8}\.md$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(inbox)).mode & 0o777).toBe(0o700);
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines[0]).toBe('Sender node id: mgr');
    expect(lines[1]).toMatch(/^Sender node address: file:\/\//);
    expect(lines.slice(2)).toEqual(['Target node id: web', 'Message, no owner authority.', '', 'Build the landing page.', 'Keep it short.', '']);
    expect(result.stdout).toContain(`File: ${file}`);
    expect(result.stdout).toContain('Session: web');
    expect(result.stdout).toContain('Check with ListAgents that exactly one session has the name web.');
    const status = await box.git(join(shop, '.factory'), ['status', '--porcelain', '--untracked-files=all']);
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain('inbox');
  });

  it('prints the JSON document with its schema id', async () => {
    const task = await readyPair();
    const result = await node('send', 'web', '--file', task, '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'factory.node-send/v1', id: 'web', session: 'web' });
  });

  it('exits 4 for an inbox that is a link, and writes nothing through the link', async () => {
    const task = await readyPair();
    const elsewhere = join(box.root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(shop, '.factory', 'inbox'));
    const result = await node('send', 'web', '--file', task);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('is a link');
    expect(result.stderr).toContain('chmod go-w');
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('exits 3 and names factory upgrade for a child whose state repo does not ignore the inbox, and sends after the upgrade', async () => {
    const task = await readyPair();
    const state = join(shop, '.factory');
    // A state repo from before the inbox: it has every line of the .gitignore but "inbox/", and the rest of the folder is whole.
    await writeFile(join(state, '.gitignore'), 'state/\nlocks/\nbackups/\nworkers/\n');
    expect((await box.git(state, ['add', '.gitignore'])).code).toBe(0);
    expect((await box.git(state, ['commit', '-q', '-m', 'drop the inbox line'])).code).toBe(0);

    const refused = await node('send', 'web', '--file', task);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('factory upgrade');
    await expect(stat(join(state, 'inbox'))).rejects.toMatchObject({ code: 'ENOENT' });

    const upgraded = await box.run(['upgrade', '--home', shop]);
    expect(upgraded.code, upgraded.stderr).toBe(0);
    expect(await readFile(join(state, '.gitignore'), 'utf8')).toContain('inbox/\n');

    const sent = await node('send', 'web', '--file', task);
    expect(sent.stderr).toBe('');
    expect(sent.code).toBe(0);
    expect(await readdir(join(state, 'inbox'))).toHaveLength(1);
    const status = await box.git(state, ['status', '--porcelain', '--untracked-files=all']);
    expect(status.code).toBe(0);
    expect(status.stdout).not.toContain('inbox');
  });

  it('exits 3 and does not make the state folder of a child that has none', async () => {
    const task = await readyPair();
    await rm(join(shop, '.factory'), { recursive: true });
    const result = await node('send', 'web', '--file', task);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('factory upgrade');
    await expect(stat(join(shop, '.factory'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
