import { describe, expect, it } from 'vitest';
import { runNode, type NodeOptions } from '../../src/commands/node.js';
import { parseConfigText } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';

const HOME = '/w/mgr';
const CONFIG_PATH = `${HOME}/factory.yaml`;

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
    readonly text?: string;
    readonly cwd?: string;
  } = {},
): FakeDeps => {
  const deps = createFakeDeps({ cwd: options.cwd ?? '/w' });
  deps.seed(CONFIG_PATH, options.text ?? renderConfig(configOf('mgr', options.layer ?? 2, options.children)));
  for (const [path, config] of Object.entries(options.homes ?? {})) {
    deps.seedDir(path);
    if (config !== null) deps.seed(`${path}/factory.yaml`, typeof config === 'string' ? config : renderConfig(config));
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
  const parsed = parseConfigText(deps.files.get(CONFIG_PATH) ?? '');
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
    expect(deps.atomicWrites).toEqual([CONFIG_PATH]);
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
    const text = renderConfig(configOf('mgr', 2)).replace('children: []', '# my children, one for each shop\nchildren: []');
    const deps = make({ homes: webHome, text });
    await succeeded(deps, 'add-child', '/w/web-factory');
    const after = deps.files.get(CONFIG_PATH) ?? '';
    expect(after).toContain('# my children, one for each shop\nchildren:\n  - id: web');
    expect(after).toContain('# People edit this file.');
  });

  it('refuses on layer 1, because the children of a coordinator are cells', async () => {
    const deps = make({ layer: 1, homes: webHome });
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'add-child', '/w/web-factory');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toContain('its children are cells');
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
  });

  it('refuses a child on a layer that is not the layer below, and names both layers', async () => {
    for (const layer of [2, 3]) {
      const deps = make({ homes: { '/w/other': configOf('other', layer) } });
      const before = deps.files.get(CONFIG_PATH);
      const result = await node(deps, 'add-child', '/w/other');
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toBe(`the child is on layer ${layer}, but a node on layer 2 takes children on layer 1`);
      }
      expect(deps.files.get(CONFIG_PATH)).toBe(before);
    }
  });

  it('refuses a child that is more than one layer below, and changes nothing', async () => {
    const deps = make({ layer: 3, homes: { '/w/low': configOf('low', 1) } });
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'add-child', '/w/low');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) {
      expect(result.error.message).toBe('the child is on layer 1, but a node on layer 3 takes children on layer 2');
    }
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
  });

  it('refuses a child with the id of this node, tells how to fix it, and changes nothing', async () => {
    const deps = make({ homes: { '/w/same': configOf('mgr', 1) } });
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'add-child', '/w/same');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) {
      expect(result.error.message).toBe('the child has the id mgr, which is the id of this node');
      expect(result.error.hint).toContain('Change the id in the factory.yaml of the child');
    }
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
  });

  it('refuses a child whose folder does not exist, and says why', async () => {
    const result = await node(make(), 'add-child', '/w/none');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toBe('cannot add the child: no factory.yaml found there');
  });

  it('refuses a child whose config is not valid, and says why', async () => {
    const broken = renderConfig(configOf('bad', 1)).replace('effort: high', 'effort: wild');
    const result = await node(make({ homes: { '/w/bad': broken } }), 'add-child', '/w/bad');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toContain('factory.yaml is invalid');
  });

  it('tells which side needs the upgrade when the schema of the child is not the current one', async () => {
    const older = make({ homes: { '/w/old': 'schema: 1\n' } });
    const olderResult = await node(older, 'add-child', '/w/old');
    expect(olderResult).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!olderResult.ok) expect(olderResult.error.message).toContain('run "factory upgrade" in that node home');

    const newer = make({ homes: { '/w/new': 'schema: 3\n' } });
    const newerResult = await node(newer, 'add-child', '/w/new');
    expect(newerResult).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!newerResult.ok) expect(newerResult.error.message).toContain('upgrade factory');
  });

  it('refuses a child that is a child already', async () => {
    const deps = make({ children: [{ id: 'web', address: 'file:///w/web-factory' }], homes: webHome });
    const result = await node(deps, 'add-child', '/w/web-factory');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toBe('web is a child of this node already');
  });

  it('refuses another home with the id of a child', async () => {
    const deps = make({
      children: [{ id: 'web', address: 'file:///w/web-factory' }],
      homes: { ...webHome, '/w/web-two': configOf('web', 1) },
    });
    const result = await node(deps, 'add-child', '/w/web-two');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it.each([
    ['this home', '/w/mgr', 'is this node home, or inside it'],
    ['a folder inside this home', '/w/mgr/sub', 'is this node home, or inside it'],
    ['a folder above this home', '/w', 'holds this node home'],
    ['the root folder', '/', 'holds this node home'],
  ])('refuses %s', async (_name, path, message) => {
    const deps = make({ homes: { [path]: null } });
    const result = await node(deps, 'add-child', path);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it('compares real paths, so a link to this home is refused', async () => {
    const deps = createFakeDeps({ cwd: '/w', links: { '/w/link': HOME } });
    deps.seed(CONFIG_PATH, renderConfig(configOf('mgr', 2)));
    deps.seedDir('/w/link');
    const result = await node(deps, 'add-child', '/w/link');
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it.each([
    ['ssh', 'ssh://owner@host/srv/web-factory'],
    ['https', 'https://example.com/web-factory'],
    ['a host', 'file://host/w/web-factory'],
    ['a .. segment', 'file:///w/../w/web-factory'],
  ])('refuses %s as a usage error and changes nothing', async (_name, argument) => {
    const deps = make({ homes: webHome });
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'add-child', argument);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('keeps the config as it was when the new config would not be valid', async () => {
    const full = Array.from({ length: 200 }, (_value, index) => ({ id: `c${index}`, address: `file:///w/c${index}` }));
    const deps = make({ children: full, homes: webHome });
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'add-child', '/w/web-factory');
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.message).toContain('Nothing was changed');
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
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
    expect(deps.atomicWrites).toEqual([CONFIG_PATH]);
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
    const before = deps.files.get(CONFIG_PATH);
    const result = await node(deps, 'remove-child', 'nobody');
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) expect(result.error.message).toBe('nobody is not a child of this node');
    expect(deps.files.get(CONFIG_PATH)).toBe(before);
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
    expect(await node(make({ text: 'schema: 2\n' }), 'children')).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });
});
