import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure } from '../../src/cli/errors.js';
import type { NodeOptions } from '../../src/commands/node.js';
import { fileTransport, parseConfigTexts, runNode } from '../helpers/package-registry.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { childReasons, env, nodeInbox, nodeSendReasons } from '../../src/names.js';
import { STATE_GITIGNORE } from '../../src/state/files.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { workerPathsOf } from '../../src/state/layout.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';

const HOME = '/w/mgr';
const CONFIG_PATH = `${HOME}/factory.yaml`;
/** The children of a node are in the local file: the commands of `node` change only this file. */
const LOCAL_PATH = `${HOME}/factory.local.yaml`;

const configOf = (id: string, layer: number, children: FactoryConfig['core']['children'] = []): FactoryConfig => {
  const config = sampleConfig();
  return { ...config, core: { ...config.core, node: { id, layer }, children } };
};

/** A node home on layer 2 with the given children entries. Child homes exist at the paths in `homes`. */
const make = (
  options: {
    readonly layer?: number;
    readonly children?: FactoryConfig['core']['children'];
    readonly homes?: Readonly<Record<string, FactoryConfig | string | null>>;
    readonly sharedText?: string;
    readonly localText?: string;
    readonly cwd?: string;
    readonly links?: Readonly<Record<string, string>>;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): FakeDeps => {
  const deps = createFakeDeps({
    cwd: options.cwd ?? '/w',
    env: { XDG_STATE_HOME: '/state', ...options.env },
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  seedConfig(deps, HOME, configOf('mgr', options.layer ?? 2, options.children));
  registerRoot(deps, HOME, 'mgr');
  if (options.sharedText !== undefined) deps.seed(CONFIG_PATH, options.sharedText);
  if (options.localText !== undefined) deps.seed(LOCAL_PATH, options.localText);
  for (const [path, config] of Object.entries(options.homes ?? {})) {
    deps.seedDir(path);
    if (config === null) continue;
    if (typeof config === 'string') deps.seed(`${path}/factory.yaml`, config);
    else seedConfig(deps, path, config);
  }
  return deps;
};

const node = (deps: FakeDeps, ...words: string[]) => {
  const options: NodeOptions = { home: HOME, words };
  return runNode(deps, options);
};

const succeeded = async (deps: FakeDeps, ...words: string[]) => {
  const result = await node(deps, ...words);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const webHome = { '/w/web-factory': configOf('web', 1) };

const childrenInFile = (deps: FakeDeps): unknown => {
  const parsed = parseConfigTexts(deps.files.get(CONFIG_PATH) ?? '', deps.files.get(LOCAL_PATH) ?? '');
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.core.children;
};

describe('node children', () => {
  it('says so when there is no child', async () => {
    const output = await succeeded(make(), 'children');
    expect(output.lines).toEqual([{ level: 'text', text: 'No children.' }]);
    expect(output.json).toEqual({ schema: 'factory.node-children/v1', home: HOME, layer: 2, children: [] });
    expect(output.failed).toBe(false);
  });

  it('shows one row for each child: id, address, layer and state', async () => {
    const deps = make({
      children: [
        { id: 'web', address: 'file:///w/web-factory' },
        { id: 'api', address: 'file:///w/api-factory' },
      ],
      homes: { ...webHome, '/w/api-factory': null },
    });
    const output = await succeeded(deps, 'children');
    expect(output.lines).toEqual([
      { level: 'ok', text: 'web  file:///w/web-factory  layer 1  ok' },
      { level: 'warn', text: 'api  file:///w/api-factory  -  unknown: no factory.yaml found there' },
    ]);
    expect(output.json['children']).toEqual([
      { id: 'web', address: 'file:///w/web-factory', layer: 1, status: 'ok', reason: null },
      { id: 'api', address: 'file:///w/api-factory', layer: null, status: 'unknown', reason: 'no factory.yaml found there' },
    ]);
    expect(output.failed).toBe(false);
  });

  it('shows a child that holds another id as a mismatch with the fixed reason, as a warning', async () => {
    const deps = make({
      children: [{ id: 'web', address: 'file:///w/web-factory' }],
      homes: { '/w/web-factory': configOf('stranger', 1) },
    });
    const output = await succeeded(deps, 'children');
    expect(output.lines).toEqual([
      { level: 'warn', text: `web  file:///w/web-factory  -  mismatch: ${childReasons.otherId}` },
    ]);
    expect(output.json['children']).toEqual([
      { id: 'web', address: 'file:///w/web-factory', layer: null, status: 'mismatch', reason: childReasons.otherId },
    ]);
    expect(plainText(output)).not.toContain('stranger');
    expect(output.failed).toBe(false);
  });

  it('cleans each cell of a row before it measures the columns', async () => {
    const deps = make({
      children: [
        { id: 'web', address: 'file:///w/we‮b-factory' },
        { id: 'api', address: 'file:///w/api-factory' },
      ],
    });
    const output = await succeeded(deps, 'children');
    expect(output.lines.map((line) => line.text)).toEqual([
      'web  file:///w/web-factory  -  unknown: no factory.yaml found there',
      'api  file:///w/api-factory  -  unknown: no factory.yaml found there',
    ]);
  });

  it('cuts a cell of a row to the display width', async () => {
    const address = `file:///w/${'a'.repeat(300)}`;
    const deps = make({ children: [{ id: 'web', address }] });
    const output = await succeeded(deps, 'children');
    expect(output.lines).toEqual([
      { level: 'warn', text: `web  ${address.slice(0, 120)}  -  unknown: no factory.yaml found there` },
    ]);
  });

  it('prints a short output, with and without a child', async () => {
    expectShortOutput(plainText(await succeeded(make(), 'children')));
    const deps = make({
      children: [
        { id: 'web', address: 'file:///w/web-factory' },
        { id: 'api', address: 'file:///w/api-factory' },
      ],
      homes: { ...webHome, '/w/api-factory': null },
    });
    expectShortOutput(plainText(await succeeded(deps, 'children')));
  });

  it('pads the ids to one width', async () => {
    const deps = make({
      children: [
        { id: 'a', address: 'file:///w/a-factory' },
        { id: 'long-name', address: 'file:///w/web-factory' },
      ],
      homes: { ...webHome, '/w/a-factory': configOf('a', 1) },
    });
    const output = await succeeded(deps, 'children');
    expect(output.lines.map((line) => line.text.indexOf('file://'))).toEqual([11, 11]);
  });

  it('takes no argument', async () => {
    expect(await node(make(), 'children', 'extra')).toMatchObject({ ok: false, error: { kind: 'usage' } });
  });
});

describe('node add-child', () => {
  it('adds a child by its absolute path, with the id from the child, and writes the config atomically', async () => {
    const deps = make({ homes: webHome });
    const output = await succeeded(deps, 'add-child', '/w/web-factory');
    expect(childrenInFile(deps)).toEqual([{ id: 'web', address: 'file:///w/web-factory' }]);
    expect(deps.atomicWrites).toEqual([LOCAL_PATH]);
    expect(output.lines[0]).toEqual({ level: 'text', text: 'Added the child web (layer 1).' });
    expect(output.json).toMatchObject({
      schema: 'factory.node-children/v1',
      home: HOME,
      layer: 2,
      change: { action: 'add', id: 'web' },
      children: [{ id: 'web', address: 'file:///w/web-factory', layer: 1, status: 'ok', reason: null }],
    });
  });

  it('adds a child by a relative path and by a file address', async () => {
    const byPath = make({ homes: webHome });
    await succeeded(byPath, 'add-child', 'web-factory');
    expect(childrenInFile(byPath)).toEqual([{ id: 'web', address: 'file:///w/web-factory' }]);

    const byAddress = make({ homes: webHome });
    await succeeded(byAddress, 'add-child', 'file:///w/web-factory/');
    expect(childrenInFile(byAddress)).toEqual([{ id: 'web', address: 'file:///w/web-factory' }]);
  });

  it('keeps the comments of the owner in the config file', async () => {
    const localText = renderConfig(configOf('mgr', 2)).local.replace('children: []', '# my children, one for each shop\nchildren: []');
    const deps = make({ homes: webHome, localText });
    const shared = deps.files.get(CONFIG_PATH);
    await succeeded(deps, 'add-child', '/w/web-factory');
    const after = deps.files.get(LOCAL_PATH) ?? '';
    expect(after).toContain('# my children, one for each shop\nchildren:\n  - id: web');
    expect(after).toContain('# factory.local.yaml: the configuration of one person on this machine.');
    expect(deps.files.get(CONFIG_PATH)).toBe(shared);
  });

  it('refuses on layer 1 with a usage error, because the children of a coordinator are workers', async () => {
    const deps = make({ layer: 1, homes: webHome });
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'add-child', '/w/web-factory');
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) {
      expect(result.error.message).toContain('its children are workers');
      expect(result.error.hint).toContain('Run "factory node children" to see the children.');
    }
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
  });

  it('fails for a child on a layer that is not the layer below, names both layers and a remedy', async () => {
    for (const layer of [2, 3]) {
      const deps = make({ homes: { '/w/other': configOf('other', layer) } });
      const before = deps.files.get(LOCAL_PATH);
      const result = await node(deps, 'add-child', '/w/other');
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      if (!result.ok) {
        expect(result.error.message).toBe(`the child is on layer ${layer}, but a node on layer 2 takes children on layer 1`);
        expect(result.error.hint).toContain('layer 1');
      }
      expect(deps.files.get(LOCAL_PATH)).toBe(before);
    }
  });

  it('fails for a child that is more than one layer below, and changes nothing', async () => {
    const deps = make({ layer: 3, homes: { '/w/low': configOf('low', 1) } });
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'add-child', '/w/low');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('the child is on layer 1, but a node on layer 3 takes children on layer 2');
    }
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
  });

  it('fails for a child with the id of this node, tells how to fix it, and changes nothing', async () => {
    const deps = make({ homes: { '/w/same': configOf('mgr', 1) } });
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'add-child', '/w/same');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('the child has the id mgr, which is the id of this node');
      expect(result.error.hint).toContain('Change the id in the factory.yaml of the child');
    }
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
  });

  describe('one id space for workers and children (AC-2)', () => {
    const workerOf = (id: string) => ({
      id,
      project: 'web',
      workCopy: `${HOME}/work-copies/web/${id}`,
      branch: `worker/${id}`,
    });

    const expectRefused = async (deps: FakeDeps): Promise<void> => {
      const before = deps.files.get(LOCAL_PATH);
      const result = await node(deps, 'add-child', '/w/web-factory');
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      if (!result.ok) {
        expect(result.error.message).toBe('the child has the id web, which is the id of a worker of this node');
        expect(result.error.hint).toContain('Then run "factory node add-child" again.');
      }
      expect(deps.files.get(LOCAL_PATH)).toBe(before);
    };

    it('fails for a child whose id is the id of a worker with a record, and changes nothing', async () => {
      const deps = make({ homes: webHome });
      const written = await writeWorkerRecord(deps, HOME, workerOf('web'));
      expect(written.ok).toBe(true);
      await expectRefused(deps);
    });

    it('fails for a child whose id is a key of the workers in the config', async () => {
      const deps = make({ homes: webHome });
      const config = configOf('mgr', 2);
      seedConfig(deps, HOME, { ...config, core: { ...config.core, workers: { web: { proxy: 'none' } } } });
      await expectRefused(deps);
    });

    it('fails for a child whose id is the name of a worker folder with a record that is not valid', async () => {
      const deps = make({ homes: webHome });
      deps.seed(workerPathsOf(HOME, 'web').recordFile, 'not json');
      await expectRefused(deps);
    });

    it('adds a child when only another id is the id of a worker', async () => {
      const deps = make({ homes: webHome });
      const written = await writeWorkerRecord(deps, HOME, workerOf('alpha'));
      expect(written.ok).toBe(true);
      const output = await succeeded(deps, 'add-child', '/w/web-factory');
      expect(output.lines[0]).toEqual({ level: 'text', text: 'Added the child web (layer 1).' });
    });
  });

  it('fails for a child whose folder does not exist, says why and tells to start the child', async () => {
    const result = await node(make(), 'add-child', '/w/none');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe('cannot add the child: no factory.yaml found there');
      expect(result.error.hint).toBe('Start the child. Then run "factory node add-child" again.');
    }
  });

  it('fails for a child whose config is not valid, with the fixed reason and no key or value of the child file', async () => {
    const broken = renderConfig(configOf('bad', 1)).shared.replace('effort: high', 'effort: wild');
    const result = await node(make({ homes: { '/w/bad': broken } }), 'add-child', '/w/bad');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toBe(`cannot add the child: ${childReasons.configInvalid}`);
      expect(result.error.message).not.toContain('session.effort');
      expect(result.error.message).not.toContain('wild');
    }
  });

  it('tells which side needs the upgrade when the schema of the child is not the current one', async () => {
    const older = make({ homes: { '/w/old': 'schema: 1\n' } });
    const olderResult = await node(older, 'add-child', '/w/old');
    expect(olderResult).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!olderResult.ok) expect(olderResult.error.message).toContain('run "factory upgrade" in that factory folder');

    const newer = make({ homes: { '/w/new': 'schema: 3\n' } });
    const newerResult = await node(newer, 'add-child', '/w/new');
    expect(newerResult).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!newerResult.ok) expect(newerResult.error.message).toContain('upgrade factory');
  });

  it('warns, with exit 0 and no write, for a child that is a child already', async () => {
    const deps = make({ children: [{ id: 'web', address: 'file:///w/web-factory' }], homes: webHome });
    const before = deps.files.get(LOCAL_PATH);
    const output = await succeeded(deps, 'add-child', '/w/web-factory');
    expect(output.lines[0]).toEqual({ level: 'warn', text: 'web is a child of this node already. Nothing changed.' });
    expect(output.failed).toBe(false);
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('fails for another home with the id of a child, and names the command that removes the child', async () => {
    const deps = make({
      children: [{ id: 'web', address: 'file:///w/web-factory' }],
      homes: { ...webHome, '/w/web-two': configOf('web', 1) },
    });
    const result = await node(deps, 'add-child', '/w/web-two');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.hint).toBe('Run "factory node remove-child web", then add the child again.');
  });

  it.each([
    ['this home', '/w/mgr', 'is this factory folder, or inside it'],
    ['a folder inside this home', '/w/mgr/sub', 'is this factory folder, or inside it'],
    ['a folder above this home', '/w', 'holds this factory folder'],
    ['the root folder', '/', 'holds this factory folder'],
  ])('fails for %s, and names a remedy', async (_name, path, message) => {
    const deps = make({ homes: { [path]: null } });
    const result = await node(deps, 'add-child', path);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) {
      expect(result.error.message).toContain(message);
      expect(result.error.hint).toContain('Then run "factory node add-child" again.');
    }
  });

  it('compares real paths, so a link to this home is refused', async () => {
    const deps = createFakeDeps({ cwd: '/w', links: { '/w/link': HOME }, env: { XDG_STATE_HOME: '/state' } });
    seedConfig(deps, HOME, configOf('mgr', 2));
    registerRoot(deps, HOME, 'mgr');
    deps.seedDir('/w/link');
    const result = await node(deps, 'add-child', '/w/link');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each([
    ['ssh', 'ssh://owner@host/srv/web-factory'],
    ['https', 'https://example.com/web-factory'],
    ['a host', 'file://host/w/web-factory'],
    ['a .. segment', 'file:///w/../w/web-factory'],
  ])('refuses %s as a usage error and changes nothing', async (_name, argument) => {
    const deps = make({ homes: webHome });
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'add-child', argument);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('keeps the config as it was when the new config would not be valid', async () => {
    const full = Array.from({ length: 200 }, (_value, index) => ({ id: `c${index}`, address: `file:///w/c${index}` }));
    const deps = make({ children: full, homes: webHome });
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'add-child', '/w/web-factory');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('Nothing was changed');
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
  });

  it('needs one argument', async () => {
    expect(await node(make(), 'add-child')).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(await node(make(), 'add-child', 'a', 'b')).toMatchObject({ ok: false, error: { kind: 'usage' } });
  });
});

describe('node remove-child', () => {
  const twoChildren = () =>
    make({
      children: [
        { id: 'web', address: 'file:///w/web-factory' },
        { id: 'api', address: 'file:///w/api-factory' },
      ],
      homes: { ...webHome, '/w/api-factory': configOf('api', 1) },
    });

  it('removes the entry of the id and keeps the other one', async () => {
    const deps = twoChildren();
    const output = await succeeded(deps, 'remove-child', 'web');
    expect(childrenInFile(deps)).toEqual([{ id: 'api', address: 'file:///w/api-factory' }]);
    expect(output.lines[0]).toEqual({ level: 'text', text: 'Removed the child web. Its files stay as they are.' });
    expect(output.json).toMatchObject({ change: { action: 'remove', id: 'web' } });
    expect(deps.atomicWrites).toEqual([LOCAL_PATH]);
  });

  it('never touches the files of the child', async () => {
    const deps = twoChildren();
    const childFiles = () => JSON.stringify([...deps.files].filter(([path]) => path.startsWith('/w/web-factory')));
    const before = childFiles();
    await succeeded(deps, 'remove-child', 'web');
    expect(childFiles()).toBe(before);
    expect(deps.dirs.has('/w/web-factory')).toBe(true);
  });

  it('refuses an id that is not a child, with a usage error, and changes nothing', async () => {
    const deps = twoChildren();
    const before = deps.files.get(LOCAL_PATH);
    const result = await node(deps, 'remove-child', 'nobody');
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) expect(result.error.message).toBe('nobody is not a child of this node');
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
  });

  it('works on a layer 1 node, where a person added children by hand', async () => {
    const deps = make({ layer: 1, children: [{ id: 'web', address: 'file:///w/web-factory' }] });
    await succeeded(deps, 'remove-child', 'web');
    expect(childrenInFile(deps)).toEqual([]);
  });

  it('needs one argument', async () => {
    expect(await node(make(), 'remove-child')).toMatchObject({ ok: false, error: { kind: 'usage' } });
  });
});

describe('node: the subcommand and the home', () => {
  it('needs a subcommand and refuses an unknown one, as usage errors', async () => {
    expect(await node(make())).toMatchObject({ ok: false, error: { kind: 'usage' } });
    const unknown = await node(make(), 'frobnicate');
    expect(unknown).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!unknown.ok) expect(unknown.error.message).toContain('unknown subcommand');
  });

  it('fails when the config is missing or not valid', async () => {
    const missing = createFakeDeps({ cwd: '/w' });
    missing.seedDir(HOME);
    expect(await node(missing, 'children')).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(await node(make({ sharedText: 'schema: 2\n' }), 'children')).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('exits 2, and names init, when the local file is missing', async () => {
    const deps = make();
    deps.files.delete(LOCAL_PATH);
    const result = await node(deps, 'children');
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage', message: 'factory.local.yaml not found' } });
    if (!result.ok) expect(result.error.hint).toContain('factory init');
    expect(await node(deps, 'add-child', '/w/web-factory')).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.atomicWrites).toEqual([]);
  });
});

describe('node: the local file', () => {
  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL_PATH, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL_PATH, 0o602)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL_PATH, 0)],
  ])('refuses all three subcommands for a local file with %s, and changes nothing', async (_name, change) => {
    const deps = make({
      children: [{ id: 'web', address: 'file:///w/web-factory' }],
      homes: { ...webHome, '/w/api-factory': configOf('api', 1) },
    });
    change(deps);
    const before = deps.files.get(LOCAL_PATH);
    const mode = deps.modes.get(LOCAL_PATH);
    for (const words of [['children'], ['add-child', '/w/api-factory'], ['remove-child', 'web']]) {
      const result = await node(deps, ...words);
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) expect(result.error.hint).toContain('chmod 600 factory.local.yaml');
    }
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
    expect(deps.modes.get(LOCAL_PATH)).toBe(mode);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('refuses all three subcommands for a local file that is a link with one remedy line, before the owner check, and changes nothing (TP-147)', async () => {
    const deps = make({
      children: [{ id: 'web', address: 'file:///w/web-factory' }],
      homes: { ...webHome, '/w/api-factory': configOf('api', 1) },
      links: { [LOCAL_PATH]: '/outside/factory.local.yaml' },
    });
    deps.modes.set(LOCAL_PATH, 0o644);
    deps.owners.set(LOCAL_PATH, 0);
    const files = new Map(deps.files);
    for (const words of [['children'], ['add-child', '/w/api-factory'], ['remove-child', 'web']]) {
      const result = await node(deps, ...words);
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toBe('factory.local.yaml is a link, so factory does not use it');
        expect(result.error.hint).toBe('Move factory.local.yaml away, then run "factory init" to write a new one.');
      }
    }
    expect(deps.files).toEqual(files);
    expect(deps.modes.get(LOCAL_PATH)).toBe(0o644);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('sets a mode that others can read back to 600, with a notice, and then does the work', async () => {
    const deps = make({ homes: webHome });
    deps.modes.set(LOCAL_PATH, 0o644);
    const output = await succeeded(deps, 'add-child', '/w/web-factory');
    expect(deps.modes.get(LOCAL_PATH)).toBe(0o600);
    expect(JSON.stringify(output.warnings)).toContain('factory.local.yaml');
    expect(childrenInFile(deps)).toEqual([{ id: 'web', address: 'file:///w/web-factory' }]);
  });

  it('keeps the mode 600 of the local file after a change of the children', async () => {
    const deps = make({ homes: webHome });
    deps.modes.set(LOCAL_PATH, 0o600);
    await succeeded(deps, 'add-child', '/w/web-factory');
    expect(deps.modes.get(LOCAL_PATH)).toBe(0o600);
  });

  it('reads the two config files with the byte cap only, also when it changes them', async () => {
    for (const words of [['children'], ['add-child', '/w/web-factory'], ['remove-child', 'web']]) {
      const deps = make({ homes: webHome, children: [{ id: 'web', address: 'file:///w/web-factory' }] });
      const unbounded: string[] = [];
      const watched: FakeDeps = {
        ...deps,
        fs: {
          ...deps.fs,
          readText: async (path: string) => (unbounded.push(path), deps.fs.readText(path)),
        },
      };
      await node(watched, ...words);
      expect({ words, unbounded: unbounded.filter((path) => path === CONFIG_PATH || path === LOCAL_PATH) }).toEqual({
        words,
        unbounded: [],
      });
    }
  });

  it('never changes the shared file', async () => {
    const deps = make({ homes: webHome });
    const before = deps.files.get(CONFIG_PATH);
    await succeeded(deps, 'add-child', '/w/web-factory');
    await succeeded(deps, 'remove-child', 'web');
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
    expect(deps.atomicWrites).not.toContain(CONFIG_PATH);
  });
});

describe('node: the registration check', () => {
  const words = [['children'], ['add-child', '/w/web-factory'], ['remove-child', 'web']];
  const withChild = { children: [{ id: 'web', address: 'file:///w/web-factory' }], homes: webHome };

  it.each([
    ['no entry in the factory list', (deps: FakeDeps) => deps.files.delete('/state/factory/homes.json')],
    ['an entry with another node id', (deps: FakeDeps) => registerRoot(deps, HOME, 'other')],
    ['no factory marker', (deps: FakeDeps) => deps.files.delete(`${HOME}/.factory/node.json`)],
  ])('exits 4 for all three subcommands with %s, names the file and writes nothing', async (_name, change) => {
    const deps = make(withChild);
    change(deps);
    const before = deps.files.get(LOCAL_PATH);
    for (const subcommand of words) {
      const result = await node(deps, ...subcommand);
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toContain(CONFIG_PATH);
        expect(result.error.hint).toContain('factory init');
      }
    }
    expect(deps.files.get(LOCAL_PATH)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('exits 4 when the config comes from a folder above the current folder and is not registered', async () => {
    const deps = make({ cwd: `${HOME}/deep`, ...withChild });
    deps.seedDir(`${HOME}/deep`);
    deps.files.delete('/state/factory/homes.json');
    const result = await runNode(deps, { home: undefined, words: ['children'] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});

describe('node send', () => {
  const CHILD = '/w/web-factory';
  const INBOX = `${CHILD}/.factory/inbox`;
  const TASK = `${HOME}/.factory/orders/task.md`;
  const SENT = `${INBOX}/2030-01-02T03-04-05-678Z-mgr-00000001.md`;
  const HEADER = ['Sender node id: mgr', `Sender node address: file://${HOME}`, 'Target node id: web', 'Message, no owner authority.'];

  interface Setup extends NonNullable<Parameters<typeof make>[0]> {
    /** The text of the task file. */
    readonly task?: string;
    /** The text of the .gitignore in the state folder of the child. Null: the child has no state folder at all. */
    readonly stateGitignore?: string | null;
  }

  /** The .gitignore of a state repo from before the inbox: it has every line but `inbox/`. */
  const GITIGNORE_WITHOUT_INBOX = 'state/\nlocks/\nbackups/\nworkers/\n';

  /** A node with one child that is ready for a send, and a task file in the orders folder of the node. */
  const sendable = ({ task = 'Build the page.\n', stateGitignore = STATE_GITIGNORE, ...options }: Setup = {}): FakeDeps => {
    const deps = make({ children: [{ id: 'web', address: `file://${CHILD}` }], homes: webHome, ...options });
    if (stateGitignore !== null) deps.seed(`${CHILD}/.factory/.gitignore`, stateGitignore);
    deps.seed(TASK, task);
    return deps;
  };

  const sendOf = (deps: Deps, words: readonly string[] = ['send', 'web'], file: string | undefined = TASK) =>
    runNode(deps, { home: HOME, words, file });

  const sent = async (deps: Deps) => {
    const result = await sendOf(deps);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  const refused = async (deps: Deps, words?: readonly string[], file?: string) => {
    const result = await sendOf(deps, words, file);
    if (result.ok) throw new Error('the send was not refused');
    return result.error;
  };

  const inboxFiles = (deps: FakeDeps): string[] => [...deps.files.keys()].filter((path) => path.startsWith(`${INBOX}/`));

  it('TP-3: writes the task as a new file with mode 600, the fixed header and a name that the program made', async () => {
    const deps = sendable();
    const output = await sent(deps);
    expect(deps.files.get(SENT)).toBe(`${HEADER.join('\n')}\n\nBuild the page.\n`);
    expect(deps.modes.get(SENT)).toBe(0o600);
    expect(inboxFiles(deps)).toEqual([SENT]);
    expect(output.failed).toBe(false);
  });

  it('TP-3: prints the file, the name of the session, the ListAgents check line and the SendMessage line', async () => {
    const output = await sent(sendable());
    const text = plainText(output);
    expectShortOutput(text);
    expect(output.lines[0]).toEqual({ level: 'ok', text: 'Wrote the task for web as a new file in its inbox.' });
    expect(text).toContain(`File: ${SENT}`);
    expect(text).toContain('Session: web');
    expect(text).toMatch(/Check with ListAgents that exactly one session has the name web\./);
    expect(text).toMatch(/Then send one SendMessage to web that names the file\./);
    expect(output.json).toMatchObject({ schema: 'factory.node-send/v1', home: HOME, id: 'web', session: 'web', file: SENT });
    expect(output.json['steps']).toEqual([expect.stringContaining('ListAgents'), expect.stringContaining('SendMessage')]);
  });

  it('TP-3: never replaces a file that has the name, and exits 1', async () => {
    const deps = sendable();
    deps.seed(SENT, 'old\n');
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(deps.files.get(SENT)).toBe('old\n');
  });

  it('TP-26: works inside a session of the program, where the session marker is set', async () => {
    const deps = sendable({ env: { [env.session]: 'mgr' } });
    await sent(deps);
    expect(deps.files.has(SENT)).toBe(true);
  });

  it('TP-26: exits 3 and names factory upgrade when the state repo of the child does not ignore the inbox yet', async () => {
    const deps = sendable({ stateGitignore: GITIGNORE_WITHOUT_INBOX });
    expect(deps.files.get(`${CHILD}/.factory/.gitignore`)).toBe(GITIGNORE_WITHOUT_INBOX);
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(nodeSendReasons.notIgnored);
    expect(error.hint).toContain('factory upgrade');
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('TP-26: exits 3 and names factory upgrade when the child has no state folder, and does not make one', async () => {
    const deps = sendable({ stateGitignore: null });
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(nodeSendReasons.notIgnored);
    expect(error.hint).toContain('factory upgrade');
    expect(deps.dirs.has(`${CHILD}/.factory`)).toBe(false);
  });

  it('sends the text with LF line ends when the file has CRLF, and accepts a tab', async () => {
    const deps = sendable({ task: 'one\r\n\ttwo\r\n' });
    await sent(deps);
    expect(deps.files.get(SENT)).toBe(`${HEADER.join('\n')}\n\none\n\ttwo\n`);
  });

  it.each([
    ['a C0 control character', 'a\u0001b'],
    ['an escape character', 'a\u001b[31mb'],
    ['a DEL character', 'a\u007fb'],
    ['a C1 control character', 'a\u0085b'],
    ['a carriage return that is no part of CRLF', 'a\rb'],
    ['a bidi control character', 'a‮b'],
    ['a bidi isolate', 'a⁦b'],
    ['a zero width space', 'a​b'],
    ['a line separator', 'a b'],
    ['a byte order mark', '﻿a'],
  ])('TP-6: exits 2 for %s in the task, and writes nothing', async (_name, task) => {
    const deps = sendable({ task });
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(nodeSendReasons.controlChars);
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('TP-6: exits 4 for token-shaped text, and no output repeats the value', async () => {
    const deps = sendable({ task: `Push with ${FAKE_GITHUB_TOKEN} now.\n` });
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(nodeSendReasons.token);
    expect(JSON.stringify(error)).not.toContain('a'.repeat(20));
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('TP-6: exits 3 when the inbox of the child holds the most files', async () => {
    const deps = sendable();
    for (let index = 0; index < nodeInbox.maxFiles; index += 1) deps.seed(`${INBOX}/old-${index}.md`, 'x');
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(nodeSendReasons.full);
    expect(inboxFiles(deps)).toHaveLength(nodeInbox.maxFiles);
  });

  it('TP-23: exits 3 with a fixed reason for a child whose config does not parse, and shows no text of the parse', async () => {
    const deps = sendable({ homes: { [CHILD]: 'key: [unclosed\n' } });
    const ping = await fileTransport(deps).ping(`file://${CHILD}`);
    if (ping.kind !== 'unknown') throw new Error('the config must not parse');
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(nodeSendReasons.notAnswering);
    const shown = `${error.message}\n${error.hint ?? ''}`;
    expect(shown).not.toContain(ping.reason.slice(ping.reason.indexOf(': ') + 2));
    expect(shown).not.toContain('parse');
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('shows the fixed reason, and no text of the ping, for a child whose config is of an older schema', async () => {
    const error = await refused(sendable({ homes: { [CHILD]: 'schema: 1\n' } }));
    expect(error.message).toContain(nodeSendReasons.notAnswering);
    expect(`${error.message}${error.hint}`).not.toContain('schema 1');
  });

  it('exits 4 for a child that shows another layer than the layer below, and writes nothing', async () => {
    const deps = sendable({ homes: { [CHILD]: configOf('web', 2) } });
    const error = await refused(deps);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(nodeSendReasons.mismatch);
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('TP-5: removes the file and exits 4 when the child shows another id after the write', async () => {
    const deps = sendable();
    const racing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          const made = await deps.fs.writeTextExclusive(path, text, mode);
          deps.seed(`${CHILD}/factory.yaml`, renderConfig(configOf('other', 1)).shared);
          return made;
        },
      },
    };
    const error = await refused(racing);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(nodeSendReasons.mismatch);
    expect(inboxFiles(deps)).toEqual([]);
  });

  it('TP-5: exits 4 and names the file and the delete step when the removal fails', async () => {
    const deps = sendable();
    const racing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          const made = await deps.fs.writeTextExclusive(path, text, mode);
          deps.seed(`${CHILD}/factory.yaml`, renderConfig(configOf('other', 1)).shared);
          return made;
        },
        removeFile: async () => failure('cannot remove: EIO'),
      },
    };
    const error = await refused(racing);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(nodeSendReasons.removeFailed);
    expect(error.message).toContain(SENT);
    expect(error.hint).toContain(`rm ${SENT}`);
    expect(deps.files.has(SENT)).toBe(true);
  });

  const CASES: readonly (readonly [string, number, string | null, () => { deps: Deps; words?: readonly string[]; file?: string }])[] = [
    ['the name of the file is taken', 1, nodeSendReasons.io, () => {
      const deps = sendable();
      deps.seed(SENT, 'old\n');
      return { deps };
    }],
    ['an id that is not a child', 2, nodeSendReasons.notChild, () => ({ deps: sendable(), words: ['send', 'nobody'] })],
    ['a task file that does not exist', 2, null, () => ({ deps: sendable(), file: `${HOME}/.factory/orders/none.md` })],
    ['a control character in the task', 2, nodeSendReasons.controlChars, () => ({ deps: sendable({ task: 'a\u0001b' }) })],
    ['a child that does not answer', 3, nodeSendReasons.notAnswering, () => ({ deps: sendable({ homes: { [CHILD]: null } }) })],
    ['a full inbox', 3, nodeSendReasons.full, () => {
      const deps = sendable();
      for (let index = 0; index < nodeInbox.maxFiles; index += 1) deps.seed(`${INBOX}/old-${index}.md`, 'x');
      return { deps };
    }],
    ['a state repo that does not ignore the inbox', 3, nodeSendReasons.notIgnored, () => ({ deps: sendable({ stateGitignore: GITIGNORE_WITHOUT_INBOX }) })],
    ['a child with no state folder', 3, nodeSendReasons.notIgnored, () => ({ deps: sendable({ stateGitignore: null }) })],
    ['another id in the child', 4, nodeSendReasons.mismatch, () => ({ deps: sendable({ homes: { [CHILD]: configOf('other', 1) } }) })],
    ['a link as the inbox', 4, nodeSendReasons.unsafe, () => {
      const deps = sendable({ links: { [INBOX]: '/elsewhere' } });
      deps.seedDir(INBOX);
      return { deps };
    }],
    ['a child folder that another user owns', 4, nodeSendReasons.unsafe, () => {
      const deps = sendable();
      deps.owners.set(CHILD, 0);
      return { deps };
    }],
    ['a token in the task', 4, nodeSendReasons.token, () => ({ deps: sendable({ task: `${FAKE_GITHUB_TOKEN}\n` }) })],
  ];

  it.each(CASES)('TP-7: exits with the right code for %s, and the remedy names a command', async (_name, code, reason, build) => {
    const { deps, words, file } = build();
    const error = await refused(deps, words, file);
    expect(exitCodeOf[error.kind]).toBe(code);
    expect(error.hint).toMatch(/"[a-z]+ [^"]+"/);
    if (reason !== null) expect(error.message).toContain(reason);
  });

  it('TP-7: exits 2 for a missing id, a missing --file and an extra word', async () => {
    const deps = sendable();
    const options: readonly NodeOptions[] = [
      { home: HOME, words: ['send'], file: TASK },
      { home: HOME, words: ['send', 'web'] },
      { home: HOME, words: ['send', 'web', 'extra'], file: TASK },
    ];
    for (const option of options) {
      expect(await runNode(deps, option)).toMatchObject({ ok: false, error: { kind: 'usage' } });
    }
    expect(deps.dirs.has(INBOX)).toBe(false);
  });

  it('refuses --file for the other subcommands with exit 2', async () => {
    const deps = sendable();
    for (const words of [['children'], ['add-child', CHILD], ['remove-child', 'web']]) {
      expect(await sendOf(deps, words)).toMatchObject({ ok: false, error: { kind: 'usage' } });
    }
    expect(deps.atomicWrites).toEqual([]);
  });
});
