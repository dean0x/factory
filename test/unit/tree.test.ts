import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildReportRead } from '../../src/comms/report-read.js';
import type { NodeReport } from '../../src/comms/report-schema.js';
import type { Transport } from '../../src/comms/transport.js';
import { childReasons, layers, reportLimits, reportWords, schemaIds, treeLimits, treeWords } from '../../src/names.js';
import { walkTree, type TreeEntry, type TreeRow, type TreeWalk } from '../../src/report/tree.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { fileTransport } from '../helpers/package-registry.js';
import { importPathsOf, stripComments } from '../helpers/source-scan.js';

const SRC = join(__dirname, '..', '..', 'src');
const HOME = '/w/root';
const OWN_ID = 'root';
const AGE = 60;
const BYTES = 100;
const STATES = reportWords.childStates;
const WARNING = treeWords.warning;

const pathOf = (name: string): string => `/w/${name}`;
const addressOf = (name: string): string => `file://${pathOf(name)}`;
const entryOf = (name: string, id = name): TreeEntry => ({ id, address: addressOf(name) });

const reportOf = (id: string, parts: Partial<NodeReport> = {}): NodeReport => ({
  schema: schemaIds.report,
  schemaVersion: reportLimits.schemaVersion,
  id,
  layer: layers.coordinator,
  factoryVersion: '1.0.0',
  cursor: null,
  workers: [],
  board: { states: [], statesOmitted: 0, fields: [] },
  inProgress: [],
  requests: [],
  events: [],
  children: [],
  ...parts,
});

const childRowOf = (entry: TreeEntry): NodeReport['children'][number] => ({
  id: entry.id,
  address: entry.address,
  state: STATES.ok,
  reason: null,
  counts: null,
  age: null,
});

const requestOf = (id: string, origin: string): NodeReport['requests'][number] => ({ id, title: null, origin });

const WORKER: NodeReport['workers'][number] = {
  id: 'w1',
  project: 'web',
  state: 'busy',
  contextPct: null,
  activityAt: null,
  workItem: { state: 'unknown' },
  idle: false,
};
const ITEM: NodeReport['inProgress'][number] = { id: 'B-1', title: 'Build', state: 'doing', track: null, stage: null };

const readOf = (report: NodeReport, bytes = BYTES, folder = report.id): ChildReportRead => ({
  state: 'read',
  report,
  age: AGE,
  bytes,
  source: `${pathOf(folder)}/report.json`,
});

type Entry = readonly [address: string, read: ChildReportRead];

/** A node with the folder name `name` as its id, whose report lists the children `children` by folder name. */
const nodeOf = (name: string, children: readonly string[] = [], parts: Partial<NodeReport> = {}): Entry => [
  addressOf(name),
  readOf(reportOf(name, { children: children.map((child) => childRowOf(entryOf(child))), ...parts }), BYTES, name),
];

interface ReadCall {
  readonly address: string;
  readonly maxBytes: number;
}

interface World {
  readonly deps: FakeDeps;
  readonly transport: Transport;
  readonly reads: ReadCall[];
}

interface WorldOptions {
  readonly links?: Readonly<Record<string, string>>;
  /** The folders that exist, besides the folders of the nodes. */
  readonly folders?: readonly string[];
}

/**
 * The nodes of a tree as fake report files, by address. A node that is not in the list has no report file. The `run` of the deps throws,
 * so a call to any process fails the test.
 */
const worldOf = (nodes: readonly Entry[], options: WorldOptions = {}): World => {
  const reads: ReadCall[] = [];
  const reports = new Map(nodes);
  const deps = createFakeDeps({
    run: () => {
      throw new Error('the walk starts no process');
    },
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  deps.seedDir(HOME);
  for (const [address] of nodes) deps.seedDir(address.slice('file://'.length));
  for (const folder of options.folders ?? []) deps.seedDir(folder);
  const transport: Transport = {
    ping: async () => {
      throw new Error('the walk never pings');
    },
    deliver: async () => {
      throw new Error('the walk never delivers');
    },
    report: async (address, maxBytes) => {
      reads.push({ address, maxBytes });
      return reports.get(address) ?? { state: 'unknown', reason: childReasons.noReport, age: null, bytes: 0, source: null };
    },
  };
  return { deps, transport, reads };
};

const walkOf = (world: World, children: readonly TreeEntry[], deps: FakeDeps = world.deps): Promise<TreeWalk> =>
  walkTree(deps, { home: HOME, id: OWN_ID, children, transport: world.transport });

const names = (...folders: readonly string[]): TreeEntry[] => folders.map((folder) => entryOf(folder));

const shapeOf = (walk: TreeWalk): string[] => walk.rows.map((row) => `${row.depth} ${row.report.id} ${row.state}`);

const readAddresses = (world: World): string[] => world.reads.map((read) => read.address);

const rowAt = (walk: TreeWalk, at: number): TreeRow => {
  const row = walk.rows[at];
  if (row === undefined) throw new Error(`the walk has no row ${at}`);
  return row;
};

describe('tree walk: the entries of the lists', () => {
  it('gives no row for a node with no child, and reads nothing', async () => {
    const world = worldOf([]);
    expect(await walkOf(world, [])).toEqual({ rows: [], omitted: 0 });
    expect(world.reads).toEqual([]);
  });

  it('walks the entries in the order of each list, depth first, with one row for each node', async () => {
    const world = worldOf([nodeOf('a', ['c']), nodeOf('b'), nodeOf('c', ['d']), nodeOf('d')]);
    const walk = await walkOf(world, names('a', 'b'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 c ok', '3 d ok', '1 b ok']);
    expect(readAddresses(world)).toEqual(['a', 'c', 'd', 'b'].map(addressOf));
    expect(walk.omitted).toBe(0);
  });

  it('gives the layer, the counts, the age and the report path of a node, and the address of its entry', async () => {
    const world = worldOf([
      nodeOf('a', ['b'], {
        layer: layers.manager,
        workers: [WORKER, { ...WORKER, id: 'w2' }],
        inProgress: [ITEM],
        requests: [requestOf('D-1', 'a#D-1')],
      }),
      nodeOf('b'),
    ]);
    const [row] = (await walkOf(world, names('a'))).rows;
    expect(row).toEqual({
      depth: 1,
      state: STATES.ok,
      reason: null,
      report: {
        source: `${pathOf('a')}/report.json`,
        id: 'a',
        address: addressOf('a'),
        layer: layers.manager,
        counts: { workers: 2, inProgress: 1, requests: 1, children: 1 },
        age: AGE,
        reportedBy: null,
      },
    });
  });

  it('reads only the folders that a list names, and asks the file system for nothing but their real path', async () => {
    const world = worldOf([nodeOf('a'), nodeOf('b')], { folders: [pathOf('extra'), `${pathOf('a')}/sub`] });
    const touched: string[] = [];
    const watched = withFsWatch(world.deps, (method, path) => void touched.push(`${method} ${path}`));
    const walk = await walkOf(world, names('a', 'b'), watched);
    expect(shapeOf(walk)).toEqual(['1 a ok', '1 b ok']);
    expect(readAddresses(world)).toEqual([addressOf('a'), addressOf('b')]);
    expect(touched).toEqual([`realpath ${HOME}`, `realpath ${pathOf('a')}`, `realpath ${pathOf('b')}`]);
  });

  it('starts no process and no timer', async () => {
    const world = worldOf([nodeOf('a', ['b']), nodeOf('b')]);
    await walkOf(world, names('a'));
    expect(world.deps.calls).toEqual([]);
    expect(world.deps.sleeps).toEqual([]);
  });

  it('still gives the answer of the report read for a node whose folder cannot be resolved', async () => {
    const world = worldOf([]);
    const walk = await walkOf(world, names('gone'));
    expect(walk.rows).toEqual([
      {
        depth: 1,
        state: STATES.unknown,
        reason: childReasons.noReport,
        report: { source: null, id: 'gone', address: addressOf('gone'), layer: null, counts: null, age: null, reportedBy: null },
      },
    ]);
  });
});

describe('tree walk: a node that does not read, or that is another node', () => {
  it('gives an unknown row with the fixed reason and the age of the file, and goes no deeper', async () => {
    const world = worldOf([
      [addressOf('a'), { state: 'unknown', reason: childReasons.reportInvalid, age: 30, bytes: 40, source: `${pathOf('a')}/report.json` }],
      nodeOf('b'),
    ]);
    const walk = await walkOf(world, names('a', 'b'));
    expect(shapeOf(walk)).toEqual(['1 a unknown', '1 b ok']);
    expect(rowAt(walk, 0)).toMatchObject({
      reason: childReasons.reportInvalid,
      report: { source: `${pathOf('a')}/report.json`, layer: null, counts: null, age: 30 },
    });
  });

  it('gives a mismatch row for a report with another id, shows no text of the child, and goes no deeper', async () => {
    const world = worldOf([nodeOf('a', ['x'], { id: 'stranger', workers: [WORKER] }), nodeOf('x')]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a mismatch']);
    expect(rowAt(walk, 0)).toMatchObject({ reason: childReasons.otherId, report: { layer: null, counts: null, age: AGE } });
    expect(JSON.stringify(walk)).not.toContain('stranger');
    expect(readAddresses(world)).toEqual([addressOf('a')]);
  });

  it('gives only fixed reasons, so no text of a child reaches a reason', async () => {
    const hostile = 'file:///w/evil-marker\nline two ‮';
    const world = worldOf([
      nodeOf('a', ['b'], { requests: [requestOf('D-1', 'evil-marker#D-1')] }),
      nodeOf('c', [], { id: 'evil-marker' }),
      [addressOf('b'), { state: 'unknown', reason: childReasons.reportNotJson, age: null, bytes: 0, source: null }],
    ]);
    const walk = await walkOf(world, [entryOf('a'), entryOf('c'), { id: 'evil-marker', address: hostile }]);
    expect(shapeOf(walk)).toEqual(['1 a ok', '1 a warning', '2 b unknown', '1 c mismatch', '1 evil-marker unknown']);
    const fixed: string[] = Object.values(childReasons);
    for (const row of walk.rows) {
      if (row.reason === null) continue;
      expect(fixed.includes(row.reason) || row.reason.startsWith(treeWords.requestsDropped), row.reason).toBe(true);
    }
    expect(walk.rows.map((row) => row.reason).join('\n')).not.toContain('evil-marker');
  });
});

describe('tree walk: the address of an entry', () => {
  it.each([
    ['another scheme', 'ssh://host/w/x'],
    ['no absolute path', 'file://relative/x'],
    ['a .. segment', 'file:///w/a/../x'],
    ['a percent sign', 'file:///w/x%2Fy'],
    ['a line break', 'file:///w/x\nevil'],
    ['a fragment', 'file:///w/x#frag'],
  ])('gives an unknown row with a fixed reason, and reads nothing, for an address with %s', async (_what, address) => {
    const world = worldOf([nodeOf('a')]);
    const own = await walkOf(world, [{ id: 'x', address }]);
    expect(own.rows).toEqual([
      {
        depth: 1,
        state: STATES.unknown,
        reason: childReasons.addressInvalid,
        report: { source: null, id: 'x', address, layer: null, counts: null, age: null, reportedBy: null },
      },
    ]);
    expect(world.reads).toEqual([]);
  });

  it('gives the same row for a bad address in the report of a child, with the mark of the node that reported it', async () => {
    const bad = { id: 'x', address: 'ssh://host/w/x' };
    const world = worldOf([[addressOf('a'), readOf(reportOf('a', { children: [childRowOf(bad), childRowOf(entryOf('b'))] }))], nodeOf('b')]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 x unknown', '2 b ok']);
    expect(rowAt(walk, 1)).toMatchObject({
      reason: childReasons.addressInvalid,
      report: { address: bad.address, source: null, reportedBy: 'a' },
    });
    expect(readAddresses(world)).toEqual([addressOf('a'), addressOf('b')]);
  });
});

describe('tree walk: rows below a child', () => {
  it('marks every row below a direct child with the id of the node whose report gave the address, and no row above', async () => {
    const world = worldOf([nodeOf('a', ['b']), nodeOf('b', ['c']), nodeOf('c')]);
    const walk = await walkOf(world, names('a'));
    expect(walk.rows.map((row) => [row.depth, row.report.id, row.report.reportedBy])).toEqual([
      [1, 'a', null],
      [2, 'b', 'a'],
      [3, 'c', 'b'],
    ]);
  });
});

describe('tree walk: a cycle and a duplicate id', () => {
  it('stops a cycle with a row, and reads the folder once', async () => {
    const world = worldOf([nodeOf('a', ['b']), nodeOf('b', ['a'])]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 b ok', '3 a warning']);
    expect(rowAt(walk, 2).reason).toBe(childReasons.cycle);
    expect(readAddresses(world)).toEqual([addressOf('a'), addressOf('b')]);
  });

  it('stops a child that names the own home with a cycle row', async () => {
    const world = worldOf([nodeOf('a', [OWN_ID])]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', `2 ${OWN_ID} warning`]);
    expect(rowAt(walk, 1).reason).toBe(childReasons.cycle);
    expect(readAddresses(world)).toEqual([addressOf('a')]);
  });

  it('finds a cycle by the real path, also when a link gives the folder another address', async () => {
    const world = worldOf([nodeOf('a', ['alias'])], { links: { [pathOf('alias')]: pathOf('a') }, folders: [pathOf('alias')] });
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 alias warning']);
    expect(rowAt(walk, 1).reason).toBe(childReasons.cycle);
    expect(readAddresses(world)).toEqual([addressOf('a')]);
  });

  it('gives a warning row for a new folder with an id that the walk saw, and reads that folder not', async () => {
    const world = worldOf([
      [addressOf('x1'), readOf(reportOf('x'))],
      [addressOf('x2'), readOf(reportOf('x'))],
    ]);
    const walk = await walkOf(world, [entryOf('x1', 'x'), entryOf('x2', 'x')]);
    expect(shapeOf(walk)).toEqual(['1 x ok', '1 x warning']);
    expect(rowAt(walk, 1).reason).toBe(childReasons.duplicateId);
    expect(readAddresses(world)).toEqual([addressOf('x1')]);
  });

  it('gives a warning row for a child with the id of the own node, and reads it not', async () => {
    const world = worldOf([nodeOf('twin', [], { id: OWN_ID })]);
    const walk = await walkOf(world, [entryOf('twin', OWN_ID)]);
    expect(shapeOf(walk)).toEqual([`1 ${OWN_ID} warning`]);
    expect(rowAt(walk, 0).reason).toBe(childReasons.duplicateId);
    expect(world.reads).toEqual([]);
  });
});

describe('tree walk: the caps', () => {
  it('stops at the depth cap with one row, and reads no node below it', async () => {
    const chain = Array.from({ length: treeLimits.maxDepth + 4 }, (_, at) => `c${at + 1}`);
    const nodes = chain.map((name, at) => nodeOf(name, at + 1 < chain.length ? [`c${at + 2}`] : []));
    const world = worldOf(nodes);
    const walk = await walkOf(world, names('c1'));
    expect(walk.rows).toHaveLength(treeLimits.maxDepth + 1);
    expect(walk.rows.slice(0, treeLimits.maxDepth).map((row) => [row.depth, row.state])).toEqual(
      Array.from({ length: treeLimits.maxDepth }, (_, at) => [at + 1, STATES.ok]),
    );
    expect(walk.rows.at(-1)).toMatchObject({ depth: treeLimits.maxDepth, state: WARNING, reason: childReasons.depthCap });
    expect(world.reads).toHaveLength(treeLimits.maxDepth);
  });

  it('gives no depth cap row for a node at the depth cap that lists no child', async () => {
    const chain = Array.from({ length: treeLimits.maxDepth }, (_, at) => `c${at + 1}`);
    const world = worldOf(chain.map((name, at) => nodeOf(name, at + 1 < chain.length ? [`c${at + 2}`] : [])));
    const walk = await walkOf(world, names('c1'));
    expect(walk.rows.every((row) => row.state === STATES.ok)).toBe(true);
    expect(walk.rows).toHaveLength(treeLimits.maxDepth);
  });

  it('stops at the node cap with one row, and reads no more than the cap', async () => {
    const middles = Array.from({ length: 200 }, (_, at) => `m${at}`);
    const leavesOf = (at: number): string[] => Array.from({ length: 5 }, (_, leaf) => `l${at}-${leaf}`);
    const nodes = [...middles.map((name, at) => nodeOf(name, leavesOf(at))), ...middles.flatMap((_, at) => leavesOf(at).map((name) => nodeOf(name)))];
    const world = worldOf(nodes);
    const walk = await walkOf(world, names(...middles));
    expect(world.reads).toHaveLength(treeLimits.maxNodes);
    const capRows = walk.rows.filter((row) => row.reason === childReasons.nodeCap);
    expect(capRows).toHaveLength(1);
    expect(capRows[0]?.state).toBe(WARNING);
    expect(walk.rows.at(-1)).toBe(capRows[0]);
    expect(walk.rows).toHaveLength(treeLimits.maxNodes + 1);
  });

  it('gives each read the bytes that are left of the walk cap, at most the cap of one report, and stops with one row when none is left', async () => {
    const world = worldOf([
      [addressOf('a'), readOf(reportOf('a', { children: [childRowOf(entryOf('b'))] }), treeLimits.maxWalkBytes - 1_000)],
      [addressOf('b'), readOf(reportOf('b', { children: [childRowOf(entryOf('c'))] }), 1_000)],
      nodeOf('c'),
      nodeOf('d'),
    ]);
    const walk = await walkOf(world, names('a', 'd'));
    expect(world.reads).toEqual([
      { address: addressOf('a'), maxBytes: reportLimits.maxBytes },
      { address: addressOf('b'), maxBytes: 1_000 },
    ]);
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 b ok', '3 c warning']);
    expect(rowAt(walk, 2).reason).toBe(childReasons.byteCap);
  });

  it('stops with one byte cap row, and reads no more, when a report is larger than the bytes that are left', async () => {
    const tooLarge: ChildReportRead = { state: 'unknown', reason: childReasons.reportTooLarge, age: 9, bytes: 0, source: `${pathOf('b')}/report.json` };
    const world = worldOf([
      [addressOf('a'), readOf(reportOf('a', { children: [childRowOf(entryOf('b'))] }), treeLimits.maxWalkBytes - 1_000)],
      [addressOf('b'), tooLarge],
      nodeOf('c'),
    ]);
    const walk = await walkOf(world, names('a', 'c'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 b warning']);
    expect(rowAt(walk, 1)).toMatchObject({ reason: childReasons.byteCap, report: { source: tooLarge.source, age: 9 } });
    expect(readAddresses(world)).toEqual([addressOf('a'), addressOf('b')]);
  });

  it('keeps the reason of a report that is larger than the cap of one report, and walks on', async () => {
    const tooLarge: ChildReportRead = { state: 'unknown', reason: childReasons.reportTooLarge, age: 9, bytes: 0, source: `${pathOf('a')}/report.json` };
    const world = worldOf([[addressOf('a'), tooLarge], nodeOf('b')]);
    const walk = await walkOf(world, names('a', 'b'));
    expect(shapeOf(walk)).toEqual(['1 a unknown', '1 b ok']);
    expect(rowAt(walk, 0).reason).toBe(childReasons.reportTooLarge);
  });

  it('keeps at most the line cap of rows, and counts the rows that it left out', async () => {
    const bad = Array.from({ length: reportLimits.maxChildren }, (_, at) => ({ id: `x${at}`, address: 'ssh://host/x' }));
    const folders = Array.from({ length: 11 }, (_, at) => `p${at}`);
    const world = worldOf(folders.map((name) => nodeOf(name, [], { children: bad.map(childRowOf) })));
    const walk = await walkOf(world, names(...folders));
    const total = folders.length * (1 + reportLimits.maxChildren);
    expect(total).toBeGreaterThan(treeLimits.maxLines);
    expect(walk.rows).toHaveLength(treeLimits.maxLines);
    expect(walk.omitted).toBe(total - treeLimits.maxLines);
    expect(shapeOf(walk).slice(0, 3)).toEqual(['1 p0 ok', '2 x0 unknown', '2 x1 unknown']);
  });

  it('counts no omitted row for a list within the line cap', async () => {
    const world = worldOf([nodeOf('a')]);
    expect((await walkOf(world, names('a'))).omitted).toBe(0);
  });
});

describe('tree walk: the bytes of files that do not read', () => {
  it('counts the bytes of a file that is not UTF-8, so the walk stops at the byte cap with one row', async () => {
    const fullReports = treeLimits.maxWalkBytes / reportLimits.maxBytes;
    const folders = Array.from({ length: fullReports + 1 }, (_, at) => `n${at}`);
    const deps = createFakeDeps();
    deps.seedDir(HOME);
    for (const folder of folders) {
      const { reportFile } = layoutOf(pathOf(folder));
      deps.seed(reportFile, ' '.repeat(reportLimits.maxBytes));
      deps.invalidUtf8.add(reportFile);
    }
    const walk = await walkTree(deps, { home: HOME, id: OWN_ID, children: names(...folders), transport: fileTransport(deps) });
    expect(walk.rows).toHaveLength(fullReports + 1);
    expect(walk.rows.slice(0, fullReports).map((row) => row.reason)).toEqual(Array(fullReports).fill(childReasons.reportUnreadable));
    expect(walk.rows.at(-1)).toMatchObject({ state: WARNING, reason: childReasons.byteCap });
  });
});

describe('tree walk: the origin of a request', () => {
  const cases: readonly (readonly [what: string, id: string, origin: string, passes: boolean])[] = [
    ['the node id and the request id', '1', 'a#1', true],
    ['a deeper node after a slash', '1', 'a/deep#1', true],
    ['a node id that only starts with the id of the node', '2', 'ab#2', false],
    ['another node id', '1', 'b#1', false],
    ['a request id that differs from the id after the hash', '1', 'a#2', false],
    ['no hash', '1', 'a', false],
    ['no node id', '1', '#1', false],
    ['a leading slash', '1', '/a#1', false],
    ['a segment that is not a slug', '1', 'a/Bad_Segment#1', false],
    ['an empty segment', '1', 'a//deep#1', false],
    ['a deeper node first', '1', 'deep/a#1', false],
  ];

  it.each(cases)('handles %s', async (_what, id, origin, passes) => {
    const world = worldOf([nodeOf('a', [], { requests: [requestOf(id, origin)] })]);
    const walk = await walkOf(world, names('a'));
    expect(rowAt(walk, 0).report.counts?.requests).toBe(passes ? 1 : 0);
    expect(walk.rows).toHaveLength(passes ? 1 : 2);
    if (!passes) {
      expect(rowAt(walk, 1)).toMatchObject({
        depth: 1,
        state: WARNING,
        reason: `${treeWords.requestsDropped}: 1`,
        report: { id: 'a', reportedBy: null },
      });
    }
  });

  it('counts only the requests that pass in the row of the node, and gives one warning row with the count of the others', async () => {
    const requests = [requestOf('1', 'a#1'), requestOf('2', 'ab#2'), requestOf('3', 'a/deep#3'), requestOf('4', 'c#4'), requestOf('5', 'a')];
    const world = worldOf([nodeOf('a', ['b'], { requests }), nodeOf('b')]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '1 a warning', '2 b ok']);
    expect(rowAt(walk, 0).report.counts).toEqual({ workers: 0, inProgress: 0, requests: 2, children: 1 });
    expect(rowAt(walk, 1).reason).toBe(`${treeWords.requestsDropped}: 3`);
  });

  it('checks the origin against the id of the node that reports it, at each depth', async () => {
    const world = worldOf([nodeOf('a', ['b']), nodeOf('b', [], { requests: [requestOf('1', 'a#1'), requestOf('2', 'b#2')] })]);
    const walk = await walkOf(world, names('a'));
    expect(shapeOf(walk)).toEqual(['1 a ok', '2 b ok', '2 b warning']);
    expect(rowAt(walk, 1).report.counts?.requests).toBe(1);
    expect(rowAt(walk, 2)).toMatchObject({ reason: `${treeWords.requestsDropped}: 1`, report: { reportedBy: 'a' } });
  });
});

describe('tree walk: where it sits', () => {
  const FILES = [join(SRC, 'report', 'tree.ts'), join(SRC, 'comms', 'report-read.ts')];
  const FORBIDDEN_IMPORT = /tmux|launch|child_process|recipes|panes|status-read|(^|\/)build\.js$/;
  const FORBIDDEN_CALL = /\b(setTimeout|setInterval|setImmediate|sleep|spawn|execFile|exec|runAttached)\b|\.run\(/;

  it.each(FILES)('imports no tmux, launch, subprocess, recipe or builder module: %s', (path) => {
    const bad = importPathsOf(readFileSync(path, 'utf8')).filter((importPath) => FORBIDDEN_IMPORT.test(importPath));
    expect(bad).toEqual([]);
  });

  it.each(FILES)('starts no process and no timer: %s', (path) => {
    expect(FORBIDDEN_CALL.exec(stripComments(readFileSync(path, 'utf8')))).toBeNull();
  });
});
