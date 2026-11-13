import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalBoard } from '../../src/board/contract.js';
import { createLocalBoard } from '../../src/board/local.js';
import { failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { renderJson } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { reportLines, runReport } from '../../src/commands/report.js';
import { parseReport, type NodeReport } from '../../src/comms/report-schema.js';
import type { PingResult, Transport } from '../../src/comms/transport.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { ok } from '../../src/core/result.js';
import { commands, files, reportKeys, reportLimits, schemaIds, values, workerRecord } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { checkReport, readNodeFacts, reportDocOf, reportTextOf, type NodeFacts } from '../../src/report/build.js';
import { writeReportFile } from '../../src/report/outbox.js';
import { layoutOf } from '../../src/state/layout.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import type { WorkItem, WorkItemPort } from '../../src/workers/work-items.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleBoard, sampleConfigWithBoard, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { allSourceFiles, importPathsOf, stripComments } from '../helpers/source-scan.js';
import { tmuxHandler, type PaneFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const LAYOUT = layoutOf(HOME);
const BOARD_FILE = `${LAYOUT.stateDir}/${files.board}`;
const WAITING_FILE = `${LAYOUT.stateDir}/${files.waiting}`;
const SRC = join(__dirname, '..', '..', 'src');

const doc = reportKeys.doc;

interface Fixture {
  readonly deps: FakeDeps;
  readonly board: LocalBoard;
  readonly config: FactoryConfig;
  readonly tmux: TmuxLog;
}

interface FixtureOptions {
  readonly config?: FactoryConfig;
  readonly items?: readonly Record<string, unknown>[];
  readonly requests?: readonly Record<string, unknown>[];
  /** The workers of the registry. A worker with an event has a last-seen line and a pane that runs. */
  readonly workers?: readonly { readonly id: string; readonly event?: 'PreToolUse' | 'Stop'; readonly percent?: number }[];
  /** Links of the file system: a path under a key resolves to the same path under the value. */
  readonly links?: Readonly<Record<string, string>>;
  /** The configs of the child homes, by home folder. The node home of a child is a folder with its config file. */
  readonly childHomes?: Readonly<Record<string, FactoryConfig>>;
}

const SESSION = '00000000-0000-4000-8000-000000000001';

const requestRecord = (id: string, title: string): Record<string, unknown> => ({
  id,
  title,
  question: 'Which one?',
  options: [{ key: 'a', text: 'First' }],
});

const waitingText = (requests: readonly Record<string, unknown>[]): string =>
  `${JSON.stringify({ intro: '', groups: [], items: requests }, null, 2)}\n`;

const fixtureOf = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const config = options.config ?? sampleConfigWithBoard();
  const workers = options.workers ?? [];
  const panes: PaneFixture[] = workers
    .filter((worker) => worker.event !== undefined)
    .map((worker) => ({ session: config.core.node.id, options: { '@worker': worker.id } }));
  const tmux = tmuxHandler({ sessions: { [config.core.node.id]: HOME }, panes });
  const deps = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state' },
    run: tmux.handler,
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
  for (const [path, childConfig] of Object.entries(options.childHomes ?? {})) {
    deps.seedDir(path);
    seedConfig(deps, path, childConfig);
  }
  deps.seedDir(LAYOUT.stateDir);
  deps.seed(BOARD_FILE, boardText(options.items ?? [], []));
  deps.seed(WAITING_FILE, waitingText(options.requests ?? []));
  for (const [index, worker] of workers.entries()) {
    const written = await writeWorkerRecord(deps, HOME, {
      id: worker.id,
      project: 'web',
      workCopy: `${HOME}/work-copies/web/${worker.id}`,
      branch: `worker/${worker.id}`,
    });
    if (!written.ok) throw new Error(written.error.message);
    if (worker.event === undefined) continue;
    const session = SESSION.replace(/1$/, String(index + 1));
    const pointer = await writeWorkerSession(deps, HOME, worker.id, session);
    if (!pointer.ok) throw new Error(pointer.error.message);
    await writeLastSeen(deps, HOME, session, { kind: 'event', event: worker.event }, worker.id);
    if (worker.percent !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'percent', percent: worker.percent }, worker.id);
  }
  const board = createLocalBoard(deps, LAYOUT, {
    queueKey: softwareQueueKey,
    recipe: config.entry.board,
    config: config.core.board,
    command: commands.report,
    tracker: config.core.tracker.kind,
    node: config.core.node.id,
  });
  return { deps, board, config, tmux: tmux.log };
};

const portOf = (items: Readonly<Record<string, WorkItem>>): WorkItemPort => ({
  itemsOf: async (_deps, _home, ids) => ok(new Map(ids.flatMap((id) => (items[id] === undefined ? [] : [[id, items[id] as WorkItem] as const])))),
});

const noChildren: Transport = {
  ping: async () => ({ kind: 'unknown', reason: 'no answer' }),
  deliver: async () => {
    throw new Error('a report never delivers');
  },
};

const transportOf = (answers: Readonly<Record<string, PingResult>>): Transport => ({
  ...noChildren,
  ping: async (address) => answers[address] ?? { kind: 'unknown', reason: 'no answer' },
});

const factsOf = async (
  fixture: Fixture,
  parts: { readonly port?: WorkItemPort; readonly transport?: Transport } = {},
): Promise<NodeFacts> => {
  const read = await readNodeFacts(fixture.deps, {
    home: HOME,
    config: fixture.config,
    board: fixture.board,
    workItems: parts.port ?? portOf({}),
    transport: parts.transport ?? noChildren,
  });
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

const reportOf = async (fixture: Fixture, parts: Parameters<typeof factsOf>[1] = {}): Promise<NodeReport> =>
  valueOf(reportDocOf(await factsOf(fixture, parts)));

describe('report builder: the document (TP-10)', () => {
  const items = [
    itemRecord('B-1', { status: 'doing', lane: 'alpha', priority: 'P1', title: 'Build the page', track: 'web', stage: 'build' }),
    itemRecord('B-2', { status: 'doing', lane: 'beta', priority: 'P0', title: 'Fix the cart' }),
    itemRecord('B-3', { status: 'open', priority: 'P1', type: 'bug' }),
    itemRecord('B-4', { status: 'done', priority: 'P2', type: 'bug' }),
  ];

  it('has every key of the report for a node with workers and no children, with events empty and the cursor null', async () => {
    const fixture = await fixtureOf({
      items,
      workers: [{ id: 'alpha', event: 'PreToolUse' }, { id: 'beta' }],
    });
    const report = await reportOf(fixture, { port: portOf({ alpha: { state: 'known', item: 'B-1' }, beta: { state: 'known', item: null } }) });
    expect(Object.keys(report)).toEqual([
      'schema',
      'schemaVersion',
      'id',
      'layer',
      'factoryVersion',
      'cursor',
      'workers',
      'board',
      'inProgress',
      'requests',
      'events',
      'children',
    ]);
    expect(report).toMatchObject({
      schema: schemaIds.report,
      schemaVersion: 1,
      id: fixture.config.core.node.id,
      layer: fixture.config.core.node.layer,
      factoryVersion: FACTORY_VERSION,
      cursor: null,
      events: [],
      children: [],
    });
  });

  it('gives the state of each worker, its work item and its idle state', async () => {
    const fixture = await fixtureOf({
      items,
      workers: [{ id: 'alpha', event: 'PreToolUse', percent: 12 }, { id: 'beta' }, { id: 'gamma' }],
    });
    const report = await reportOf(fixture, {
      port: portOf({ alpha: { state: 'known', item: 'B-1' }, beta: { state: 'known', item: null } }),
    });
    expect(report.workers).toEqual([
      {
        id: 'alpha',
        project: 'web',
        state: 'busy',
        contextPct: 12,
        activityAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        workItem: { state: 'known', item: 'B-1' },
        idle: false,
      },
      {
        id: 'beta',
        project: 'web',
        state: 'stopped',
        contextPct: null,
        activityAt: null,
        workItem: { state: 'known', item: null },
        idle: false,
      },
      { id: 'gamma', project: 'web', state: 'stopped', contextPct: null, activityAt: null, workItem: { state: 'unknown' }, idle: false },
    ]);
  });

  it('shows the item of a work item as one clean line within the text cap, and keeps the state known', async () => {
    const item = `B-1\nline two ‮evil${'x'.repeat(reportLimits.maxTextChars)}`;
    const fixture = await fixtureOf({ workers: [{ id: 'alpha' }] });
    const report = await reportOf(fixture, { port: portOf({ alpha: { state: 'known', item } }) });
    const workItem = report.workers[0]?.workItem;
    if (workItem?.state !== 'known') throw new Error('the work item should be known');
    expect(workItem.item).toHaveLength(reportLimits.maxTextChars);
    expect(workItem.item?.startsWith('B-1 line two evilx')).toBe(true);
  });

  it('gives a row for each worker that the worker list can read, up to the most that it reads', async () => {
    const most = workerRecord.maxEntries;
    const workers = Array.from({ length: most }, (_, at) => ({ id: `w${String(at).padStart(3, '0')}` }));
    const report = await reportOf(await fixtureOf({ workers }));
    expect(report.workers).toHaveLength(most);
  });

  it('counts the board by state over all items and by each owner field over the open items, and lists the items in progress', async () => {
    const report = await reportOf(await fixtureOf({ items }));
    expect(report.board).toEqual({
      states: [
        { name: 'doing', count: 2 },
        { name: 'done', count: 1 },
        { name: 'open', count: 1 },
      ],
      statesOmitted: 0,
      fields: [
        {
          field: 'priority',
          values: [
            { name: 'P1', count: 2 },
            { name: 'P0', count: 1 },
          ],
          valuesOmitted: 0,
        },
        { field: 'type', values: [{ name: 'bug', count: 1 }], valuesOmitted: 0 },
        {
          field: 'lane',
          values: [
            { name: 'alpha', count: 1 },
            { name: 'beta', count: 1 },
          ],
          valuesOmitted: 0,
        },
      ],
    });
    expect(report.inProgress).toEqual([
      { id: 'B-1', title: 'Build the page', state: 'doing', track: 'web', stage: 'build' },
      { id: 'B-2', title: 'Fix the cart', state: 'doing', track: null, stage: null },
    ]);
  });

  it('counts by state only, and lists no item in progress, when the setup declares no owner field and no state in progress', async () => {
    const config = sampleConfigWithBoard({ states: ['open', 'done'], closed: 'done' });
    const report = await reportOf(await fixtureOf({ config, items: [itemRecord('B-1', { status: 'open' })] }));
    expect(report.board).toEqual({ states: [{ name: 'open', count: 1 }], statesOmitted: 0, fields: [] });
    expect(report.inProgress).toEqual([]);
  });

  it('gives each request with an origin of the node id and the request id', async () => {
    const fixture = await fixtureOf({ requests: [requestRecord('D-4', 'Pick a name'), requestRecord('D-9', 'Pick a color')] });
    const report = await reportOf(fixture);
    const node = fixture.config.core.node.id;
    expect(report.requests).toEqual([
      { id: 'D-4', title: 'Pick a name', origin: `${node}#D-4` },
      { id: 'D-9', title: 'Pick a color', origin: `${node}#D-9` },
    ]);
  });

  it('shows each text as one clean line within the text cap', async () => {
    const title = `Line one\nline two ‮evil${'x'.repeat(reportLimits.maxTextChars)}`;
    const report = await reportOf(await fixtureOf({ items: [itemRecord('B-1', { status: 'doing', title })] }));
    const [item] = report.inProgress;
    expect(item?.title).toHaveLength(reportLimits.maxTextChars);
    expect(item?.title.startsWith('Line one line two evil')).toBe(true);
  });

  it('gives a row for each child, with the answer of the ping and a clean reason, and no counts or age yet', async () => {
    const fixture = await fixtureOf();
    const children = [
      { id: 'api', address: 'file:///c/api' },
      { id: 'shop', address: 'file:///c/shop' },
    ];
    const config: FactoryConfig = { ...fixture.config, core: { ...fixture.config.core, children } };
    const transport = transportOf({
      'file:///c/api': { kind: 'known', id: 'api', layer: 1, schema: 2 },
      'file:///c/shop': { kind: 'unknown', reason: 'it does not parse\nFAKE: a second line ‮' },
    });
    const facts = valueOf(
      await readNodeFacts(fixture.deps, { home: HOME, config, board: fixture.board, workItems: portOf({}), transport }),
    );
    const report = valueOf(reportDocOf(facts));
    expect(report.children).toEqual([
      { id: 'api', address: 'file:///c/api', state: 'ok', reason: null, counts: null, age: null },
      { id: 'shop', address: 'file:///c/shop', state: 'unknown', reason: 'it does not parse FAKE: a second line ', counts: null, age: null },
    ]);
  });

  it('reads the facts of the workers once', async () => {
    const fixture = await fixtureOf({ workers: [{ id: 'alpha', event: 'Stop' }] });
    await factsOf(fixture);
    expect(fixture.tmux.commands().filter((line) => line.startsWith('list-panes'))).toHaveLength(1);
  });

  it('writes a text that the schema reads back as the same document', async () => {
    const report = await reportOf(await fixtureOf({ items, requests: [requestRecord('D-4', 'Pick a name')] }));
    const text = reportTextOf(report);
    expect(text).toBe(renderJson(report));
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseReport(JSON.parse(text));
    expect(parsed).toEqual({ ok: true, value: report });
  });
});

describe('report builder: the lists of counts', () => {
  const cap = reportLimits.maxCountRows;
  const lane = (report: NodeReport) => report.board.fields.find((field) => field.field === 'lane');
  const named = (rows: readonly { readonly name: string }[]): string[] => rows.map((row) => row.name);
  const distinctNames = (prefix: string, length: number): string[] =>
    Array.from({ length }, (_, at) => `${prefix}-${String(at).padStart(4, '0')}`);

  it('counts the values of an owner field over the open items only, and the states over all items', async () => {
    const items = [
      itemRecord('B-1', { status: 'done', lane: 'old' }),
      itemRecord('B-2', { status: 'doing', lane: 'alpha' }),
      itemRecord('B-3', { status: 'open', lane: 'alpha' }),
    ];
    const report = await reportOf(await fixtureOf({ items }));
    expect(lane(report)).toEqual({ field: 'lane', values: [{ name: 'alpha', count: 2 }], valuesOmitted: 0 });
    expect(report.board.states).toEqual([
      { name: 'doing', count: 1 },
      { name: 'done', count: 1 },
      { name: 'open', count: 1 },
    ]);
  });

  it('gives the report when the closed items hold more different values than the cap of a list', async () => {
    const lanes = distinctNames('lane', cap + 1);
    const closed = lanes.map((name, at) => itemRecord(`B-${at + 1}`, { status: 'done', lane: name }));
    const report = await reportOf(await fixtureOf({ items: closed }));
    expect(lane(report)).toEqual({ field: 'lane', values: [], valuesOmitted: 0 });
    expect(report.board.states).toEqual([{ name: 'done', count: closed.length }]);
  });

  it('keeps every different value of a field at the cap of a list, as every worker can have its own lane', async () => {
    const open = distinctNames('lane', cap).map((name, at) => itemRecord(`B-${at + 1}`, { status: 'open', lane: name }));
    const report = await reportOf(await fixtureOf({ items: open }));
    expect(lane(report)?.values).toHaveLength(cap);
    expect(lane(report)?.valuesOmitted).toBe(0);
    expect(cap).toBeGreaterThanOrEqual(reportLimits.maxWorkers);
  });

  it('keeps the values with the highest counts above the cap, and gives the exact number of the values that it left out', async () => {
    const left = 3;
    const singles = distinctNames('lane', cap + left - 1);
    const lanes = [...singles, 'zzz', 'zzz'];
    const open = lanes.map((name, at) => itemRecord(`B-${at + 1}`, { status: 'open', lane: name }));
    const report = await reportOf(await fixtureOf({ items: open }));
    expect(lane(report)?.valuesOmitted).toBe(left);
    expect(named(lane(report)?.values ?? [])).toEqual(['zzz', ...singles.slice(0, cap - 1)]);
    expect(lane(report)?.values[0]).toEqual({ name: 'zzz', count: 2 });
  });

  it('keeps every state at the cap of a list', async () => {
    const items = distinctNames('state', cap).map((name, at) => itemRecord(`B-${at + 1}`, { status: name }));
    const report = await reportOf(await fixtureOf({ items }));
    expect(report.board.states).toHaveLength(cap);
    expect(report.board.statesOmitted).toBe(0);
  });

  it('keeps the states with the highest counts above the cap, and gives the exact number of the states that it left out', async () => {
    const left = 4;
    const singles = distinctNames('state', cap + left - 1);
    const items = [...singles, 'zzz', 'zzz'].map((name, at) => itemRecord(`B-${at + 1}`, { status: name }));
    const report = await reportOf(await fixtureOf({ items }));
    expect(report.board.statesOmitted).toBe(left);
    expect(named(report.board.states)).toEqual(['zzz', ...singles.slice(0, cap - 1)]);
  });

  it('orders the rows by count, highest first, and then by name by code unit', async () => {
    const items = [
      itemRecord('B-1', { status: 'open', lane: 'b' }),
      itemRecord('B-2', { status: 'open', lane: 'a' }),
      itemRecord('B-3', { status: 'open', lane: 'c' }),
      itemRecord('B-4', { status: 'open', lane: 'c' }),
      itemRecord('B-5', { status: 'open', lane: 'B' }),
    ];
    const report = await reportOf(await fixtureOf({ items }));
    expect(lane(report)?.values).toEqual([
      { name: 'c', count: 2 },
      { name: 'B', count: 1 },
      { name: 'a', count: 1 },
      { name: 'b', count: 1 },
    ]);
  });
});

describe('report builder: faults', () => {
  it('fails when the board cannot be read, and never gives an empty board in its place', async () => {
    const fixture = await fixtureOf();
    fixture.deps.seed(BOARD_FILE, '{ not json');
    const facts = await factsOf(fixture);
    const error = errorOf(reportDocOf(facts));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(files.board);
  });

  it('fails when the waiting file cannot be read', async () => {
    const fixture = await fixtureOf();
    fixture.deps.seed(WAITING_FILE, '[]');
    const error = errorOf(reportDocOf(await factsOf(fixture)));
    expect(error.message).toContain(files.waiting);
  });

  it('keeps the facts of the workers when the board has a fault, so a caller can still show them', async () => {
    const fixture = await fixtureOf({ workers: [{ id: 'alpha' }] });
    fixture.deps.seed(BOARD_FILE, '{ not json');
    const facts = await factsOf(fixture);
    expect(facts.status.entries.map((entry) => entry.id)).toEqual(['alpha']);
  });

  it('fails when a list is over its cap, names the key, and gives a remedy that a person can do', async () => {
    const many = Array.from({ length: reportLimits.maxItems + 1 }, (_, at) => itemRecord(`B-${at + 1}`, { status: 'doing' }));
    const error = errorOf(reportDocOf(await factsOf(await fixtureOf({ items: many }))));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(doc.inProgress);
    expect(error.hint).toContain('state in progress');
  });

  it('refuses a report over the byte cap, and says how many bytes it has', async () => {
    const report = await reportOf(await fixtureOf());
    const long = 'x'.repeat(reportLimits.maxTextChars);
    const requests = Array.from({ length: reportLimits.maxRequests }, (_, at) => ({ id: `D-${at + 1}`, title: long, origin: `demo#D-${at + 1}` }));
    const inProgress = Array.from({ length: reportLimits.maxItems }, (_, at) => ({ id: `B-${at + 1}`, title: long, state: 'doing', track: long, stage: long }));
    const big = { ...report, requests, inProgress };
    expect(reportTextOf(big).length).toBeGreaterThan(reportLimits.maxBytes);
    const error = errorOf(checkReport(big));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(String(reportLimits.maxBytes));
  });
});

describe('report builder: nothing private reaches the report (TP-11)', () => {
  it('holds no owner prefix, no proxy, no session value and no approval value', async () => {
    const base = sampleConfigWithBoard(sampleBoard());
    const approval = Object.fromEntries(Object.keys(base.core.approval).map((point) => [point, values.approvalModes[1]]));
    const config: FactoryConfig = {
      ...base,
      core: {
        ...base.core,
        owner: { display: 'SENTINEL-OWNER-NAME', prefix: '[From {owner}, SENTINEL-OWNER-PREFIX]' },
        session: { ...base.core.session, model: 'SENTINEL-MODEL', proxy: 'sentinel-proxy', statusline: 'SENTINEL-STATUSLINE' },
        proxies: [{ id: 'sentinel-proxy', base_url: 'http://sentinel-host.invalid:9', health: '/health', on_fail: values.onFail[0] }],
        workers: { alpha: { proxy: 'sentinel-proxy' } },
        approval,
      } as FactoryConfig['core'],
    };
    const fixture = await fixtureOf({ config, workers: [{ id: 'alpha', event: 'PreToolUse', percent: 40 }] });
    const text = reportTextOf(valueOf(reportDocOf(await factsOf(fixture))));
    const forbidden = [
      'SENTINEL-OWNER-NAME',
      'SENTINEL-OWNER-PREFIX',
      'SENTINEL-MODEL',
      'sentinel-proxy',
      'sentinel-host',
      'SENTINEL-STATUSLINE',
      SESSION,
      '%',
      values.approvalModes[1],
      ...Object.keys(approval),
    ];
    for (const word of forbidden) expect(text, word).not.toContain(word);
  });

  it('refuses a document with a key that is not on the list of the schema', async () => {
    const report = await reportOf(await fixtureOf());
    for (const extra of [{ session: 'abc' }, { ownerPrefix: 'x' }, { proxy: 'p' }, { pane: '%1' }, { approval: {} }]) {
      expect(errorOf(checkReport({ ...report, ...extra })).kind).toBe('failure');
    }
    const [worker] = (await reportOf(await fixtureOf({ workers: [{ id: 'alpha' }] }))).workers;
    expect(errorOf(checkReport({ ...report, workers: [{ ...worker, session_id: SESSION }] })).kind).toBe('failure');
  });
});

describe('report builder: where it sits', () => {
  const reportFiles = allSourceFiles(join(SRC, 'report'));
  const importsOf = (path: string): string[] => importPathsOf(readFileSync(path, 'utf8'));

  it('imports no recipe module, and no tmux or subprocess module of its own', () => {
    expect(reportFiles.length).toBeGreaterThanOrEqual(2);
    for (const path of reportFiles) {
      const bad = importsOf(path).filter((importPath) => /recipes|launch|child_process/.test(importPath));
      expect(bad, relative(SRC, path)).toEqual([]);
    }
  });

  it('is imported by no module of comms', () => {
    for (const path of allSourceFiles(join(SRC, 'comms'))) {
      expect(importsOf(path).filter((importPath) => /report\//.test(importPath)), relative(SRC, path)).toEqual([]);
    }
  });
});

describe('report file writer: with the fake file system (TP-25)', () => {
  const reportOfNode = async (): Promise<NodeReport> => reportOf(await fixtureOf());
  const nodeWithState = (options: Parameters<typeof createFakeDeps>[0] = {}): FakeDeps => {
    const deps = createFakeDeps(options);
    deps.seedDir(HOME);
    deps.seedDir(LAYOUT.stateDir);
    return deps;
  };

  it('writes the report text to the file of the outbox, with mode 600 in a folder of mode 700, and leaves no temporary file', async () => {
    const report = await reportOfNode();
    const deps = nodeWithState();
    expect(valueOf(await writeReportFile(deps, HOME, report))).toBe('written');
    expect(deps.files.get(LAYOUT.reportFile)).toBe(reportTextOf(report));
    expect(deps.modes.get(LAYOUT.reportFile)).toBe(0o600);
    expect(deps.modes.get(LAYOUT.outboxDir)).toBe(0o700);
    expect([...deps.files.keys()]).toEqual([LAYOUT.reportFile]);
  });

  it('replaces the older report whole', async () => {
    const report = await reportOfNode();
    const deps = nodeWithState();
    deps.seed(LAYOUT.reportFile, 'old text\n');
    await writeReportFile(deps, HOME, report);
    expect(deps.files.get(LAYOUT.reportFile)).toBe(reportTextOf(report));
    expect([...deps.files.keys()]).toEqual([LAYOUT.reportFile]);
  });

  it('writes nothing, and makes no folder, when the factory folder is absent', async () => {
    const report = await reportOfNode();
    const deps = createFakeDeps();
    deps.seedDir(HOME);
    const folders = [...deps.dirs];
    expect(valueOf(await writeReportFile(deps, HOME, report))).toBe('skipped');
    expect(deps.files.size).toBe(0);
    expect([...deps.dirs]).toEqual(folders);
  });

  it.each([
    ['the file of the report', LAYOUT.reportFile],
    ['the outbox folder', LAYOUT.outboxDir],
    ['the factory folder', LAYOUT.stateDir],
  ])('stops with exit 4 when %s is a link, and leaves the target of the link as it was', async (_name, path) => {
    const report = await reportOfNode();
    const deps = nodeWithState({ links: { [path]: '/outside/place' } });
    deps.seedDir(LAYOUT.outboxDir);
    deps.seed('/outside/place', 'victim');
    const before = [...deps.files.entries()].sort();
    const error = errorOf(await writeReportFile(deps, HOME, report));
    expect(error.kind).toBe('safety');
    expect([...deps.files.entries()].sort()).toEqual(before);
  });

  it('refuses a report that is not on the list of the schema, and writes nothing', async () => {
    const report = await reportOfNode();
    const deps = nodeWithState();
    const error = errorOf(await writeReportFile(deps, HOME, { ...report, session: 'abc' } as NodeReport));
    expect(error.kind).toBe('failure');
    expect(deps.files.size).toBe(0);
  });

  it('refuses a report over the byte cap, and writes nothing', async () => {
    const report = await reportOfNode();
    const long = 'x'.repeat(reportLimits.maxTextChars);
    const big: NodeReport = {
      ...report,
      requests: Array.from({ length: reportLimits.maxRequests }, (_, at) => ({ id: `D-${at + 1}`, title: long, origin: `demo#D-${at + 1}` })),
      inProgress: Array.from({ length: reportLimits.maxItems }, (_, at) => ({ id: `B-${at + 1}`, title: long, state: 'doing', track: long, stage: long })),
    };
    const deps = nodeWithState();
    expect(errorOf(await writeReportFile(deps, HOME, big)).kind).toBe('failure');
    expect(deps.files.size).toBe(0);
  });

  it('is exit 1 for a write fault that is not a link, and leaves the older file', async () => {
    const report = await reportOfNode();
    const deps = nodeWithState();
    deps.seed(LAYOUT.reportFile, 'old text\n');
    const denied: Deps = { ...deps, fs: { ...deps.fs, writeTextExclusive: async () => failure('cannot write: ENOSPC') } };
    const error = errorOf(await writeReportFile(denied, HOME, report));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('ENOSPC');
    expect(deps.files.get(LAYOUT.reportFile)).toBe('old text\n');
  });
});

describe('report file writer: with the real file system (TP-25)', () => {
  const deps = createNodeDeps();
  let dir = '';
  let counter = 0;

  const freshHome = async (): Promise<string> => {
    const home = join(dir, `node-${(counter += 1)}`);
    await mkdir(join(home, '.factory'), { recursive: true });
    return home;
  };

  const sampleReport = async (): Promise<NodeReport> => reportOf(await fixtureOf());

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-report-')));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('makes the outbox folder with mode 700 and the file with mode 600, and the file holds the report text', async () => {
    const home = await freshHome();
    const report = await sampleReport();
    expect(valueOf(await writeReportFile(deps, home, report))).toBe('written');
    const outbox = join(home, '.factory', 'outbox');
    expect((await lstat(outbox)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(outbox, files.report))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(outbox, files.report), 'utf8')).toBe(reportTextOf(report));
    expect(await readdir(outbox)).toEqual([files.report]);
  });

  it('writes nothing when the factory folder is absent', async () => {
    const home = join(dir, 'bare');
    await mkdir(home);
    expect(valueOf(await writeReportFile(deps, home, await sampleReport()))).toBe('skipped');
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses a link at the file of the report, and never writes through it', async () => {
    const home = await freshHome();
    const outbox = join(home, '.factory', 'outbox');
    await mkdir(outbox);
    const victim = join(dir, `victim-${counter}.txt`);
    await writeFile(victim, 'victim\n');
    await symlink(victim, join(outbox, files.report));
    expect(errorOf(await writeReportFile(deps, home, await sampleReport())).kind).toBe('safety');
    expect(await readFile(victim, 'utf8')).toBe('victim\n');
    expect(await readdir(outbox)).toEqual([files.report]);
  });

  it('refuses a link at the outbox folder, and writes nothing into its target', async () => {
    const home = await freshHome();
    const target = join(dir, `target-${counter}`);
    await mkdir(target);
    await symlink(target, join(home, '.factory', 'outbox'));
    expect(errorOf(await writeReportFile(deps, home, await sampleReport())).kind).toBe('safety');
    expect(await readdir(target)).toEqual([]);
  });
});

describe('report: the command (TP-12, TP-13, TP-14)', () => {
  const nodeConfig = (children: FactoryConfig['core']['children'] = []): FactoryConfig => {
    const config = sampleConfigWithBoard();
    return { ...config, core: { ...config.core, node: { id: 'mgr', layer: 2 }, children } };
  };
  const childConfig = (): FactoryConfig => {
    const config = sampleConfigWithBoard();
    return { ...config, core: { ...config.core, node: { id: 'web', layer: 1 } } };
  };
  const WEB = { id: 'web', address: 'file:///w/web-factory' };
  const API = { id: 'api', address: 'file:///w/api-factory' };

  const run = async (fixture: Fixture, ...words: string[]) => {
    const sink = captureSink();
    const code = await runCli(['report', '--home', HOME, ...words], fixture.deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  const fileOf = (fixture: Fixture): string | undefined => fixture.deps.files.get(LAYOUT.reportFile);

  it('starts the text with the OK line when the node has no child, and prints no table', async () => {
    const fixture = await fixtureOf({ config: nodeConfig(), workers: [{ id: 'alpha', event: 'Stop' }] });
    const result = await run(fixture);
    expect(result.code).toBe(0);
    expect(result.out.split('\n')[0]).toMatch(/^OK: mgr \(layer 2\): workers 1, in progress 0, requests 0, children 0$/);
    expect(result.out.split('\n').filter((line) => line !== '')).toHaveLength(1);
  });

  it('starts the text with the CHECK line, then one row for each child, when a child does not answer', async () => {
    const fixture = await fixtureOf({
      config: nodeConfig([WEB, API]),
      childHomes: { '/w/web-factory': childConfig() },
    });
    const result = await run(fixture);
    expect(result.code).toBe(0);
    const lines = result.out.split('\n').filter((line) => line !== '');
    expect(lines[0]).toMatch(/^CHECK: mgr \(layer 2\): workers 0, in progress 0, requests 0, children 2 \(1 not ok\)$/);
    expect(lines[1]).toMatch(/^ID\s+STATE\s+WORKERS\s+ITEMS\s+REQUESTS\s+CHILDREN\s+AGE\s+REASON$/);
    expect(lines[2]).toMatch(/^web\s+ok\s+-\s+-\s+-\s+-\s+-\s+-$/);
    expect(lines[3]).toMatch(/^api\s+unknown\s+-\s+-\s+-\s+-\s+-\s+\S/);
    expect(lines).toHaveLength(4);
  });

  it('prints with the flag --json the document that the file holds, and the file has mode 600 in a folder of mode 700', async () => {
    const fixture = await fixtureOf({ workers: [{ id: 'alpha', event: 'Stop', percent: 20 }], items: [itemRecord('B-1', { status: 'doing', lane: 'alpha', priority: 'P1' })] });
    const result = await run(fixture, '--json');
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.out) as NodeReport;
    expect(printed.schema).toBe(schemaIds.report);
    expect(printed.workers.map((worker) => worker.id)).toEqual(['alpha']);
    expect(fileOf(fixture)).toBe(result.out);
    expect(fileOf(fixture)).toBe(reportTextOf(printed));
    expect(fixture.deps.modes.get(LAYOUT.reportFile)).toBe(0o600);
    expect(fixture.deps.modes.get(LAYOUT.outboxDir)).toBe(0o700);
  });

  it('writes the file on each run of the text output too, and replaces the older file whole', async () => {
    const fixture = await fixtureOf();
    fixture.deps.seed(LAYOUT.reportFile, 'old text\n');
    expect((await run(fixture)).code).toBe(0);
    const written = parseReport(JSON.parse(fileOf(fixture) ?? 'null'));
    expect(written.ok && written.value.id).toBe(fixture.config.core.node.id);
    expect([...fixture.deps.files.keys()].filter((path) => path.startsWith(LAYOUT.outboxDir))).toEqual([LAYOUT.reportFile]);
  });

  it('stops with exit 4 when the outbox folder is a link, and writes nothing into its target', async () => {
    const fixture = await fixtureOf({ links: { [LAYOUT.outboxDir]: '/outside/place' } });
    const result = await run(fixture, '--json');
    expect(result.code).toBe(4);
    expect(fileOf(fixture)).toBeUndefined();
    expect([...fixture.deps.files.keys()].filter((path) => path.startsWith('/outside'))).toEqual([]);
  });

  it('exits 1 with the error of the board, and writes no file, when the board cannot be read', async () => {
    const fixture = await fixtureOf();
    fixture.deps.files.delete(BOARD_FILE);
    const result = await run(fixture);
    expect(result.code).toBe(1);
    expect(result.err).toContain(files.board);
    expect(fileOf(fixture)).toBeUndefined();
  });

  it('exits 1, and keeps the older file, for a write fault that is not a link', async () => {
    const fixture = await fixtureOf();
    fixture.deps.seed(LAYOUT.reportFile, 'old text\n');
    const denied: Deps = { ...fixture.deps, fs: { ...fixture.deps.fs, writeTextExclusive: async () => failure('cannot write: ENOSPC') } };
    const result = await runReport(denied, { home: HOME, since: undefined }, recipes, portOf({}));
    expect(errorOf(result).kind).toBe('failure');
    expect(fileOf(fixture)).toBe('old text\n');
  });

  it('exits 2 for the flag --since, with a remedy that names the command, and writes no file', async () => {
    const fixture = await fixtureOf();
    const result = await run(fixture, '--since', 'cursor-1');
    expect(result.code).toBe(2);
    expect(result.err).toContain('--since');
    expect(result.err).toContain('"factory report"');
    expect(result.err).not.toContain('cursor-1');
    expect(result.out).toBe('');
    expect(fileOf(fixture)).toBeUndefined();
  });

  it('shows the report in the help, with its flag', async () => {
    const sink = captureSink();
    expect(await runCli(['report', '--help'], (await fixtureOf()).deps, sink)).toBe(0);
    expect(sink.out.join('')).toContain('factory report [--home DIR] [--since CURSOR]');
  });

  it('shows the counts and the age of a child, when the child row holds them', async () => {
    const report = await reportOf(await fixtureOf());
    const withCounts: NodeReport = {
      ...report,
      children: [{ id: 'web', address: 'file:///w/web-factory', state: 'ok', reason: null, counts: { workers: 3, inProgress: 2, requests: 1, children: 0 }, age: 90 }],
    };
    const lines = reportLines(withCounts, { notValid: 0, hasWarnings: false }).map((line) => line.text);
    expect(lines[0]).toMatch(/^OK: /);
    expect(lines[2]).toMatch(/^web\s+ok\s+3\s+2\s+1\s+0\s+90s\s+-$/);
  });
});

describe('report: one builder for status and report (TP-12)', () => {
  const sourceOf = (name: string): string => stripComments(readFileSync(join(SRC, 'commands', name), 'utf8'));

  it.each(['status.ts', 'report.ts'])('%s reads the facts with the one builder, and never calls readStatus itself', (name) => {
    const source = sourceOf(name);
    expect(importPathsOf(source).some((path) => /report\/build/.test(path))).toBe(true);
    expect(source).toMatch(/\breadNodeFacts\(/);
    expect(source).not.toMatch(/\breadStatus\b/);
    expect(importPathsOf(source).filter((path) => /status-read/.test(path))).toEqual([]);
  });
});
