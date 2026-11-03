import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGER_LAYER } from '../../src/config/schema.js';
import { makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

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
  const args = ['init', '--home', home, '--name', name, '--owner-name', 'Test Owner', '--layer', String(layer)];
  const result = await box.run(args);
  // A layer above 2 has no role template, and init warns about it. Any other layer prints nothing on stderr.
  if (layer > MANAGER_LAYER) expect(result.stderr).toContain(`Layer ${layer} has no role template`);
  else expect(result.stderr).toBe('');
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
    const configFile = join(manager, 'factory.yaml');
    const withNote = (await readFile(configFile, 'utf8')).replace('children: []', '# my shops\nchildren: []');
    await writeFile(configFile, withNote);
    const shopConfig = await readFile(join(shop, 'factory.yaml'), 'utf8');

    const added = await node('add-child', shop);
    expect(added.stderr).toBe('');
    expect(added.code).toBe(0);
    expect(added.stdout).toContain('Added the child web (layer 1).');
    const text = await readFile(configFile, 'utf8');
    expect(text).toContain(`# my shops\nchildren:\n  - id: web\n    address: "file://${shop}"\n`);
    expect(text).toContain('# People edit this file.');
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

  it('refuses a second add of the same child with exit code 4', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', shop)).code).toBe(0);
    const again = await node('add-child', shop);
    expect(again.code).toBe(4);
    expect(again.stderr).toContain('web is a child of this node already');
  });

  it('refuses a child on layer 1 for a node on layer 1, because its children are workers', async () => {
    await initNode(shop, 'web', 1);
    await initNode(manager, 'mgr', 1);
    const result = await node('add-child', shop);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('its children are workers');
  });

  it('refuses a child on another layer than the layer below', async () => {
    await initNode(shop, 'web', 3);
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', shop);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('the child is on layer 3, but a node on layer 2 takes children on layer 1');
  });

  it('refuses a folder that is no node, with exit code 4', async () => {
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', join(box.root, 'nowhere'));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('no factory.yaml found there');
  });

  it('refuses this home as a child, and a folder above it', async () => {
    await initNode(manager, 'mgr', 2);
    expect((await node('add-child', manager)).code).toBe(4);
    expect((await node('add-child', box.root)).code).toBe(4);
  });

  it('refuses an address that is not a file address with exit code 2', async () => {
    await initNode(manager, 'mgr', 2);
    const result = await node('add-child', 'ssh://owner@host/srv/web-factory');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('factory runs on one machine: use a file:// address');
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
