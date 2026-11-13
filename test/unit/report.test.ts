import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalBoard } from '../../src/board/contract.js';
import { createLocalBoard } from '../../src/board/local.js';
import { failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { renderJson } from '../../src/cli/output.js';
import { parseReport, type NodeReport } from '../../src/comms/report-schema.js';
import type { PingResult, Transport } from '../../src/comms/transport.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { ok } from '../../src/core/result.js';
import { commands, files, reportKeys, reportLimits, schemaIds, values } from '../../src/names.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { checkReport, readNodeFacts, reportDocOf, reportTextOf, type NodeFacts } from '../../src/report/build.js';
import { writeReportFile } from '../../src/report/outbox.js';
import { layoutOf } from '../../src/state/layout.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import type { WorkItem, WorkItemPort } from '../../src/workers/work-items.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleBoard, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { allSourceFiles, importPathsOf } from '../helpers/source-scan.js';
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
  const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run: tmux.handler });
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
        workItem: 'B-1',
        idle: false,
      },
      { id: 'beta', project: 'web', state: 'stopped', contextPct: null, activityAt: null, workItem: null, idle: false },
      { id: 'gamma', project: 'web', state: 'stopped', contextPct: null, activityAt: null, workItem: null, idle: false },
    ]);
  });

  it('counts the board by state and by each owner field, and lists the items in progress', async () => {
    const report = await reportOf(await fixtureOf({ items }));
    expect(report.board).toEqual({
      states: [
        { name: 'doing', count: 2 },
        { name: 'done', count: 1 },
        { name: 'open', count: 1 },
      ],
      fields: [
        {
          field: 'priority',
          values: [
            { name: 'P0', count: 1 },
            { name: 'P1', count: 2 },
            { name: 'P2', count: 1 },
          ],
        },
        { field: 'type', values: [{ name: 'bug', count: 2 }] },
        {
          field: 'lane',
          values: [
            { name: 'alpha', count: 1 },
            { name: 'beta', count: 1 },
          ],
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
    expect(report.board).toEqual({ states: [{ name: 'open', count: 1 }], fields: [] });
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

  it('fails when a list is over its cap, and names the key', async () => {
    const many = Array.from({ length: reportLimits.maxItems + 1 }, (_, at) => itemRecord(`B-${at + 1}`, { status: 'doing' }));
    const error = errorOf(reportDocOf(await factsOf(await fixtureOf({ items: many }))));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(doc.inProgress);
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
