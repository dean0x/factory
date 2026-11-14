import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardWorkItems } from '../../src/board/work-items.js';
import { failure } from '../../src/cli/errors.js';
import { renderJson, type CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { runStatus, type StatusOptions } from '../../src/commands/status.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import type { PaneRow } from '../../src/launch/tmux.js';
import { files, schemaIds, type HookEvent } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession, type LastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord, type WorkerRecord } from '../../src/workers/registry.js';
import { buildStatus, type LineRead, type StatusInput } from '../../src/workers/status.js';
import type { WorkItem, WorkItemPort } from '../../src/workers/work-items.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { EMPTY_WAITING } from '../helpers/board-repo.js';
import { countReadsOf } from '../helpers/read-count.js';
import { createFakeDeps, registerRoot, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { sampleConfig, sampleConfigWithBoard, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { unknownPort } from '../helpers/unknown-port.js';
import { busyWith, knownItem, NONE, UNKNOWN } from '../helpers/work-item.js';

const HOME = '/w/node';
const NODE = sampleConfig().core.node.id;
const MINUTE = 60_000;
const LAYOUT = layoutOf(HOME);
const BOARD_PATH = join(LAYOUT.stateDir, files.board);
const WAITING_PATH = join(LAYOUT.stateDir, files.waiting);


describe('status: the builder', () => {
  const NOW = new Date('2030-01-02T12:00:00.000Z');
  const SESSION = '00000000-0000-4000-8000-000000000001';
  const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * MINUTE).toISOString();

  const record = (id: string, project = 'web'): WorkerRecord => ({
    id,
    project,
    workCopy: `${HOME}/work-copies/${project}/${id}`,
    branch: `worker/${id}`,
    createdAt: '2030-01-01T00:00:00.000Z',
  });

  const paneOf = (worker: string, change: Partial<PaneRow> = {}): PaneRow => ({
    paneId: '%7',
    pid: 4001,
    dead: false,
    worker,
    ...change,
  });

  /** A valid line. `event` and `percent` are a value and the minutes since it was written. */
  const lineOf = (fields: { event?: readonly [HookEvent, number]; percent?: readonly [number, number] }): LineRead => {
    const line: LastSeen = {
      schema: schemaIds.lastSeen,
      session_id: SESSION,
      event: fields.event?.[0] ?? null,
      event_at: fields.event === undefined ? null : minutesAgo(fields.event[1]),
      context_pct: fields.percent?.[0] ?? null,
      pct_at: fields.percent === undefined ? null : minutesAgo(fields.percent[1]),
      session_marker: 'alpha',
    };
    return { kind: 'line', line };
  };

  const inputOf = (change: Partial<StatusInput> = {}): StatusInput => ({
    records: [record('alpha')],
    panes: [paneOf('alpha')],
    lines: new Map(),
    workItems: new Map(),
    now: NOW,
    idleAfterMinutes: 120,
    limits: sampleConfig().core.limits,
    ...change,
  });

  const firstOf = (input: StatusInput) => {
    const built = buildStatus(input);
    const [entry] = built.entries;
    if (entry === undefined) throw new Error('no entry');
    return { entry, warnings: built.warnings };
  };

  describe('idle', () => {
    const idleOf = (change: Partial<StatusInput>): boolean => firstOf(inputOf(change)).entry.idle;
    const lineMap = (read: LineRead): ReadonlyMap<string, LineRead> => new Map([['alpha', read]]);

    it.each([
      ['an event older than idle_after', 121, true],
      ['an event of exactly idle_after', 120, false],
      ['an event newer than idle_after', 119, false],
      ['an event after the current time', -500, false],
    ] as const)('is idle for a live pane at the prompt with %s: %s', (_name, minutes, idle) => {
      expect(idleOf({ lines: lineMap(lineOf({ event: ['Stop', minutes] })) })).toBe(idle);
    });

    it('takes the event time, not the percent time: a fresh percent time does not keep a worker from being idle', () => {
      const { entry } = firstOf(inputOf({ lines: lineMap(lineOf({ event: ['Stop', 300], percent: [20, 10] })) }));
      expect(entry.idle).toBe(true);
      expect(entry.activityAt).toBe(minutesAgo(10));
    });

    it('is not idle for a session that works or waits for an answer, however old its event is', () => {
      expect(idleOf({ lines: lineMap(lineOf({ event: ['UserPromptSubmit', 600] })) })).toBe(false);
      expect(idleOf({ lines: lineMap(lineOf({ event: ['Notification', 600] })) })).toBe(false);
    });

    it('is not idle for a worker with a dead pane or no pane or no session', () => {
      const lines = lineMap(lineOf({ event: ['Stop', 600] }));
      expect(idleOf({ lines, panes: [paneOf('alpha', { dead: true })] })).toBe(false);
      expect(idleOf({ lines, panes: [] })).toBe(false);
      expect(idleOf({ lines, panes: null })).toBe(false);
    });

    it('is not idle for a worker with no usable last-seen line, or a line with a percent time only', () => {
      for (const read of [undefined, { kind: 'none' }, { kind: 'fault', reason: 'EIO' }, lineOf({ percent: [20, 600] })] as const) {
        const lines = read === undefined ? new Map<string, LineRead>() : lineMap(read);
        expect(idleOf({ lines })).toBe(false);
      }
    });

    it('is a fact of the session alone: the work item does not change it', () => {
      const lines = lineMap(lineOf({ event: ['Stop', 121] }));
      for (const workItem of [NONE, busyWith('W-1'), UNKNOWN]) {
        const { entry } = firstOf(inputOf({ lines, workItems: new Map([['alpha', workItem]]) }));
        expect(entry.idle).toBe(true);
        expect(entry.workItem).toEqual(workItem);
      }
    });

    it('counts the minutes of idle_after, not a fixed time', () => {
      const lines = lineMap(lineOf({ event: ['Stop', 31] }));
      expect(idleOf({ lines, idleAfterMinutes: 30 })).toBe(true);
      expect(idleOf({ lines, idleAfterMinutes: 32 })).toBe(false);
    });
  });

  describe('no open work', () => {
    const noOpenWorkOf = (workItems: StatusInput['workItems']): boolean => firstOf(inputOf({ workItems })).entry.noOpenWork;

    it('is true only for a work item that the board knows and that has no open item', () => {
      expect(noOpenWorkOf(new Map([['alpha', NONE]]))).toBe(true);
      expect(noOpenWorkOf(new Map([['alpha', busyWith('W-1')]]))).toBe(false);
      expect(noOpenWorkOf(new Map([['alpha', UNKNOWN]]))).toBe(false);
    });

    it('is false for a worker that the port gives no answer for', () => {
      expect(noOpenWorkOf(new Map())).toBe(false);
    });
  });

  describe('the pane', () => {
    it('shows each worker as not running when no session runs', () => {
      const built = buildStatus(inputOf({ panes: null, records: [record('alpha'), record('beta')] }));
      expect(built.entries.map((entry) => [entry.id, entry.pane, entry.running])).toEqual([
        ['alpha', null, false],
        ['beta', null, false],
      ]);
    });

    it('shows a worker with a live pane as running, and a worker with an ended pane as not running', () => {
      const built = buildStatus(
        inputOf({
          records: [record('alpha'), record('beta')],
          panes: [paneOf('alpha', { paneId: '%7' }), paneOf('beta', { paneId: '%8', dead: true })],
        }),
      );
      expect(built.entries.map((entry) => [entry.pane, entry.dead, entry.running])).toEqual([
        ['%7', false, true],
        ['%8', true, false],
      ]);
    });

    it('takes the first live pane, and names every pane of the worker in one warning', () => {
      const built = buildStatus(
        inputOf({ panes: [paneOf('alpha', { paneId: '%7', dead: true }), paneOf('alpha', { paneId: '%8' }), paneOf('alpha', { paneId: '%9' })] }),
      );
      expect(built.entries[0]?.pane).toBe('%8');
      expect(built.warnings).toHaveLength(1);
      for (const id of ['alpha', '%7', '%8', '%9']) expect(built.warnings[0]).toContain(id);
    });

    it('ignores a pane of a worker that has no record', () => {
      const built = buildStatus(inputOf({ panes: [paneOf('ghost')] }));
      expect(built.entries[0]?.pane).toBeNull();
      expect(built.warnings).toEqual([]);
    });
  });

  describe('the last-seen line', () => {
    it('reads the state, the percent and the mark from the line', () => {
      const { entry } = firstOf(inputOf({ lines: new Map([['alpha', lineOf({ event: ['UserPromptSubmit', 1], percent: [41, 1] })]]) }));
      expect(entry).toMatchObject({ state: 'busy', contextPct: 41, mark: 'MAX' });
    });

    it.each([
      ['Notification', 'waits'],
      ['PreToolUse', 'busy'],
    ] as const)('reads the state of a %s line as %s', (event, state) => {
      const { entry } = firstOf(inputOf({ lines: new Map([['alpha', lineOf({ event: [event, 1] })]]) }));
      expect(entry.state).toBe(state);
    });

    it('says unknown for a worker with no line, and for a line that the worker does not own', () => {
      for (const read of [undefined, { kind: 'none' }] as const) {
        const lines = read === undefined ? new Map<string, LineRead>() : new Map<string, LineRead>([['alpha', read]]);
        const built = buildStatus(inputOf({ lines }));
        expect(built.entries[0]).toMatchObject({ state: 'unknown', contextPct: null, mark: null });
        expect(built.warnings).toEqual([]);
      }
    });

    it('names the worker and the reason in a warning for a line that cannot be read', () => {
      const built = buildStatus(inputOf({ lines: new Map([['alpha', { kind: 'fault', reason: 'cannot stat: EIO' }]]) }));
      expect(built.entries[0]).toMatchObject({ state: 'unknown', contextPct: null });
      expect(built.warnings).toHaveLength(1);
      expect(built.warnings[0]).toContain('alpha');
      expect(built.warnings[0]).toContain('EIO');
    });
  });

  it('keeps the order of the records and changes none of its inputs', () => {
    const records = [record('beta'), record('alpha')];
    const lines = new Map<string, LineRead>([['alpha', lineOf({ event: ['Stop', 5] })]]);
    const input = inputOf({ records, lines });
    const before = JSON.stringify([input.records, input.panes, [...lines]]);
    const built = buildStatus(input);
    expect(built.entries.map((entry) => entry.id)).toEqual(['beta', 'alpha']);
    expect(JSON.stringify([input.records, input.panes, [...lines]])).toBe(before);
  });
});

interface WorkerSeed {
  readonly id: string;
  readonly project?: string;
  /** The line of the session. A seed with no line has no pointer either. */
  readonly line?: { readonly event?: HookEvent; readonly percent?: number };
}

interface Setup {
  readonly workers?: readonly WorkerSeed[];
  readonly panes?: readonly PaneFixture[];
  readonly tmux?: TmuxFixture;
  readonly config?: FactoryConfig;
  /** The current folder. Default: /w. */
  readonly cwd?: string;
  /** The projects that the factory list holds for the factory folder. */
  readonly projects?: readonly string[];
  readonly git?: GitFixture;
  /** True: the node has no state folder at all, so no board file either. A node with workers always has one. */
  readonly noState?: boolean;
  /** Links of the file system: a path under a key resolves to the same path under the value. */
  readonly links?: Readonly<Record<string, string>>;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
}

const sessionOf = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const pane = (worker: string, change: Partial<PaneFixture> = {}): PaneFixture => ({
  session: NODE,
  options: { '@worker': worker },
  ...change,
});

const withIdleAfter = (idleAfter: string): FactoryConfig => {
  const config = sampleConfig();
  return { ...config, core: { ...config.core, limits: { ...config.core.limits, idle_after: idleAfter } } };
};

const make = async (setup: Setup = {}): Promise<Made> => {
  const tmux = tmuxHandler({ sessions: { [NODE]: HOME }, panes: setup.panes ?? [], ...setup.tmux });
  const git = gitHandler(setup.git);
  const run: RunHandler = (call) => (call.command === 'git' ? git.handler(call) : tmux.handler(call));
  const cwd = setup.cwd ?? '/w';
  const deps = createFakeDeps({
    cwd,
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state' },
    run,
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id, setup.projects ?? []);
  if (setup.noState === true) {
    // `registerRoot` writes the marker file of the state folder. Take it away, so the node has no state folder.
    deps.files.delete(LAYOUT.nodeJson);
    deps.dirs.delete(LAYOUT.stateDir);
  } else {
    // `init` writes both board files, so a node has them, empty at the start.
    deps.seed(BOARD_PATH, boardText([]));
    deps.seed(WAITING_PATH, EMPTY_WAITING);
  }
  deps.seedDir(cwd);
  for (const project of setup.projects ?? []) deps.seedDir(`${project}/.git`);
  for (const [index, seed] of (setup.workers ?? []).entries()) {
    const project = seed.project ?? 'web';
    const written = await writeWorkerRecord(deps, HOME, {
      id: seed.id,
      project,
      workCopy: `${HOME}/work-copies/${project}/${seed.id}`,
      branch: `worker/${seed.id}`,
    });
    if (!written.ok) throw new Error(written.error.message);
    if (seed.line === undefined) continue;
    const session = sessionOf(index + 1);
    const pointer = await writeWorkerSession(deps, HOME, seed.id, session);
    if (!pointer.ok) throw new Error(pointer.error.message);
    if (seed.line.event !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'event', event: seed.line.event }, seed.id);
    if (seed.line.percent !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'percent', percent: seed.line.percent }, seed.id);
  }
  return { deps, tmux: tmux.log };
};

/** A port that answers from a table, and records the ids that it was asked about. A worker that the table lacks is not answered. */
const portOf = (items: Readonly<Record<string, WorkItem>>): { readonly port: WorkItemPort; readonly asked: (readonly string[])[] } => {
  const asked: (readonly string[])[] = [];
  const port: WorkItemPort = {
    itemsOf: async (_deps, _home, ids) => {
      asked.push(ids);
      const answers = ids.flatMap((id) => {
        const item = items[id];
        return item === undefined ? [] : [[id, item] as const];
      });
      return ok(new Map(answers));
    },
  };
  return { port, asked };
};

const options = (change: Partial<StatusOptions> = {}): StatusOptions => ({ home: HOME, ...change });

const statusOf = async (made: Made, port: WorkItemPort = unknownPort, change: Partial<StatusOptions> = {}): Promise<CommandOutput> => {
  const result = await runStatus(made.deps, options(change), recipes, port);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

interface Row {
  readonly id: string;
  readonly project: string;
  readonly state: string;
  readonly workItem: string;
  readonly idle: string;
}

/** The rows of the table, below the title line. A column is cut at two spaces or more. */
const rowsOf = (output: CommandOutput): Row[] =>
  output.lines.slice(1).map((line) => {
    const [id = '', project = '', state = '', workItem = '', idle = ''] = line.text.split(/\s{2,}/);
    return { id, project, state, workItem, idle };
  });

const titleOf = (output: CommandOutput): string[] => (output.lines[0]?.text ?? '').split(/\s{2,}/);

interface JsonWorker {
  readonly id: string;
  readonly project: string;
  readonly pane: string | null;
  readonly dead: boolean;
  readonly state: string;
  readonly contextPct: number | null;
  readonly mark: string | null;
  readonly activityAt: string | null;
  readonly workItem: WorkItem;
  readonly idle: boolean;
}

const jsonOf = (output: CommandOutput) =>
  output.json as unknown as {
    readonly schema: string;
    readonly home: string;
    readonly running: boolean;
    readonly workers: readonly JsonWorker[];
    readonly invalid: readonly { readonly name: string; readonly reason: string }[];
  };

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

const listCalls = (made: Made): string[] => made.tmux.commands().filter((command) => command.startsWith('list-panes'));

describe('status: the table', () => {
  it('lists the state, the work item and the idle state of each worker, in the order of the ids', async () => {
    const made = await make({
      workers: [
        { id: 'beta', project: 'api', line: { event: 'UserPromptSubmit', percent: 12 } },
        { id: 'alpha', project: 'web', line: { event: 'Stop', percent: 35 } },
      ],
      panes: [pane('alpha', { id: '%7' }), pane('beta', { id: '%9' })],
    });
    const { port } = portOf({ alpha: busyWith('W-7'), beta: NONE });
    const output = await statusOf(made, port);
    expect(titleOf(output)).toEqual(['ID', 'PROJECT', 'STATE', 'WORK ITEM', 'IDLE']);
    expect(rowsOf(output)).toEqual([
      { id: 'alpha', project: 'web', state: 'at prompt', workItem: 'W-7', idle: 'no' },
      { id: 'beta', project: 'api', state: 'busy', workItem: 'none', idle: 'no' },
    ]);
    expect(output.failed).toBe(false);
    expect(output.warnings).toEqual([]);
  });

  it('shows a worker as idle when its event is older than idle_after', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }], panes: [pane('alpha')] });
    made.deps.advance(121 * MINUTE);
    const output = await statusOf(made, portOf({ alpha: NONE }).port);
    expect(rowsOf(output)).toMatchObject([{ id: 'alpha', state: 'at prompt', workItem: 'none', idle: 'yes' }]);
  });

  it('does not show a worker as idle while its event is newer than idle_after', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(119 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('no');
  });

  it('shows a worker as idle by its session alone: open work on the board does not change the idle column', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: busyWith('W-2') }).port))).toMatchObject([{ workItem: 'W-2', idle: 'yes' }]);
  });

  it('does not show a worker as idle while its session works, however old its event is', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'UserPromptSubmit' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('no');
  });

  it('takes idle_after from the config', async () => {
    const made = await make({ config: withIdleAfter('30m'), workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(31 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('yes');
  });

  it('counts an idle_after in hours', async () => {
    const made = await make({ config: withIdleAfter('3h'), workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(179 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('no');
    made.deps.advance(2 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('yes');
  });

  it('says that there is no worker, with an empty list in the JSON', async () => {
    const output = await statusOf(await make());
    expect(output.lines.map((line) => line.text)).toEqual(['No workers yet.']);
    expect(jsonOf(output)).toMatchObject({ schema: schemaIds.status, home: HOME, running: true, workers: [], invalid: [] });
  });

  it('puts the same facts in the JSON, with the work item as it is', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'PreCompact', percent: 41 } }], panes: [pane('alpha', { id: '%7' })] });
    const output = await statusOf(made, portOf({ alpha: busyWith('W-3') }).port);
    expect(jsonOf(output)).toEqual({
      schema: schemaIds.status,
      home: HOME,
      running: true,
      workers: [
        {
          id: 'alpha',
          project: 'web',
          pane: '%7',
          dead: false,
          state: 'busy',
          contextPct: 41,
          mark: 'MAX',
          activityAt: made.deps.now().toISOString(),
          workItem: busyWith('W-3'),
          idle: false,
        },
      ],
      invalid: [],
    });
  });
});

describe('status: the stub of the work item port', () => {
  it('shows the work item as unknown, and the idle state from the session alone', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 5 } },
        { id: 'beta', line: { event: 'Stop', percent: 6 } },
      ],
      panes: [pane('alpha'), pane('beta')],
    });
    made.deps.advance(24 * 60 * MINUTE);
    const output = await statusOf(made);
    expect(rowsOf(output)).toMatchObject([
      { id: 'alpha', workItem: 'unknown', idle: 'yes' },
      { id: 'beta', workItem: 'unknown', idle: 'yes' },
    ]);
    expect(jsonOf(output).workers.map((worker) => [worker.workItem, worker.idle])).toEqual([
      [{ state: 'unknown' }, true],
      [{ state: 'unknown' }, true],
    ]);
  });

  it('asks the port once, with the ids of all the workers', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }], panes: [pane('alpha')] });
    const { port, asked } = portOf({});
    await statusOf(made, port);
    expect(asked).toEqual([['alpha', 'beta', 'gamma']]);
  });

  it('treats a worker that the port does not answer for as unknown', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({}).port))).toMatchObject([{ workItem: 'unknown', idle: 'yes' }]);
  });

  it('warns and shows every work item as unknown when the port fails', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    const broken: WorkItemPort = { itemsOf: async () => failure('the board cannot be read: EIO') };
    const output = await statusOf(made, broken);
    expect(rowsOf(output)).toMatchObject([{ workItem: 'unknown', idle: 'yes' }]);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('EIO');
    expect(output.failed).toBe(false);
  });
});

describe('status: the panes', () => {
  it('makes one list-panes call for three workers', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
      panes: [pane('alpha'), pane('beta'), pane('gamma')],
    });
    const output = await statusOf(made);
    expect(listCalls(made)).toHaveLength(1);
    expect(rowsOf(output).map((row) => row.state)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('shows each worker as stopped, and makes no list-panes call, when no tmux session runs', async () => {
    const made = await make({
      tmux: { sessions: {} },
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 31 } },
        { id: 'beta' },
        { id: 'gamma' },
      ],
    });
    const output = await statusOf(made);
    expect(rowsOf(output).map((row) => [row.id, row.state])).toEqual([
      ['alpha', 'stopped'],
      ['beta', 'stopped'],
      ['gamma', 'stopped'],
    ]);
    expect(output.failed).toBe(false);
    expect(jsonOf(output).running).toBe(false);
    expect(jsonOf(output).workers.map((worker) => worker.state)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(listCalls(made)).toEqual([]);
  });

  it('shows a worker with no pane, and a worker with an ended pane, as stopped', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop' } },
        { id: 'beta', line: { event: 'Stop' } },
        { id: 'gamma', line: { event: 'UserPromptSubmit' } },
      ],
      panes: [pane('beta', { id: '%8', dead: true }), pane('gamma', { id: '%9' })],
    });
    const output = await statusOf(made);
    expect(rowsOf(output).map((row) => [row.id, row.state])).toEqual([
      ['alpha', 'stopped'],
      ['beta', 'stopped'],
      ['gamma', 'busy'],
    ]);
    expect(jsonOf(output).workers[1]).toMatchObject({ pane: '%8', dead: true, state: 'stopped' });
  });

  it('shows a worker that waits at a dialog as waits, in the table and in the JSON', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Notification' } }], panes: [pane('alpha', { id: '%7' })] });
    const output = await statusOf(made);
    expect(rowsOf(output).map((row) => [row.id, row.state])).toEqual([['alpha', 'waits']]);
    expect(jsonOf(output).workers[0]).toMatchObject({ id: 'alpha', pane: '%7', state: 'waits' });
  });

  it('refuses a session of the same name that belongs to another factory folder, and lists no pane', async () => {
    const made = await make({ tmux: { sessions: { [NODE]: '/elsewhere' } }, workers: [{ id: 'alpha' }] });
    const result = await runStatus(made.deps, options(), recipes, unknownPort);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('safety');
    expect(listCalls(made)).toEqual([]);
  });

  it('calls no tmux command that changes a pane or a window', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], panes: [pane('alpha')] });
    await statusOf(made);
    expect(made.tmux.commands().filter((command) => !/^(has-session|show-options|list-panes)/.test(command))).toEqual([]);
  });
});

describe('status: the output is short', () => {
  const workers: readonly WorkerSeed[] = [
    { id: 'alpha', project: 'web', line: { event: 'Stop', percent: 35 } },
    { id: 'beta', project: 'api', line: { event: 'UserPromptSubmit', percent: 12 } },
    { id: 'gamma', project: 'web', line: { event: 'Stop', percent: 5 } },
  ];
  const fleet: Setup = {
    workers,
    panes: [pane('alpha', { id: '%7' }), pane('beta', { id: '%9' }), pane('gamma', { id: '%11' })],
  };
  const items = { alpha: busyWith('W-7'), beta: NONE, gamma: NONE };

  it('has a short first line and few lines for three workers, for a run with no session, and for a run with no worker', async () => {
    const shapes: readonly (readonly [Made, WorkItemPort])[] = [
      [await make(fleet), portOf(items).port],
      [await make({ workers, tmux: { sessions: {} } }), unknownPort],
      [await make(), unknownPort],
    ];
    for (const [made, port] of shapes) expectShortOutput(plainText(await statusOf(made, port)));
  });

  it('has the size of its output on the fixture of three workers in the token budget, row 2', async () => {
    const text = plainText(await statusOf(await make(fleet), portOf(items).port));
    const row = budgetRow(2);
    expect(row.command).toBe('`factory status`');
    expect(row.measured).toBe(tokensOf(text));
    expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
  });
});

describe('status: a record that is not valid', () => {
  it('names the folder and the reason, and lists the other workers', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }] });
    made.deps.seed('/w/node/.factory/workers/broken/worker.json', 'not json');
    const output = await statusOf(made);
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha']);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('broken');
    expect(jsonOf(output).invalid).toEqual([{ name: 'broken', reason: expect.stringContaining('not valid JSON') }]);
  });
});

describe('status: it changes only the report file', () => {
  const alpha: Setup = { workers: [{ id: 'alpha', line: { event: 'Stop', percent: 33 } }], panes: [pane('alpha', { id: '%7' })] };
  const reportJsonOf = async (made: Made): Promise<string> => {
    const sink = captureSink();
    expect(await runCli(['report', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    return sink.out.join('');
  };

  it('writes the report file and no other file and no other folder', async () => {
    const made = await make(alpha);
    const filesBefore = new Map(made.deps.files);
    const foldersBefore = new Set(made.deps.dirs);
    await statusOf(made, portOf({ alpha: NONE }).port);
    const changed = [...made.deps.files].filter(([path, text]) => filesBefore.get(path) !== text).map(([path]) => path);
    expect(changed).toEqual([LAYOUT.reportFile]);
    expect([...made.deps.dirs].filter((path) => !foldersBefore.has(path))).toEqual([LAYOUT.outboxDir]);
    expect(made.deps.modes.get(LAYOUT.reportFile)).toBe(0o600);
    expect(made.deps.modes.get(LAYOUT.outboxDir)).toBe(0o700);
  });

  it('writes the same document that report prints with the flag --json', async () => {
    const made = await make(alpha);
    await statusOf(made, boardWorkItems(recipes));
    const fromStatus = made.deps.files.get(LAYOUT.reportFile);
    expect(fromStatus).toBeDefined();
    expect(await reportJsonOf(made)).toBe(fromStatus);
  });

  it('writes no file and no folder, and keeps its exit code, when the node has no factory folder', async () => {
    const made = await make({ noState: true });
    const before = snapshot(made.deps);
    const sink = captureSink();
    // The step that finds the factory folder stops the command first, so the report writer does not run here.
    // The tests of the writer call it direct for its `skipped` result.
    expect(await runCli(['status', '--home', HOME], made.deps, sink)).toBe(4);
    expect(sink.errors.join('')).toContain('marker');
    expect(sink.out.join('')).toBe('');
    expect(snapshot(made.deps)).toBe(before);
  });

  it('stops with exit 4 when the outbox folder is a link, and writes nothing into its target', async () => {
    const made = await make({ ...alpha, links: { [LAYOUT.outboxDir]: '/outside/place' } });
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME], made.deps, sink)).toBe(4);
    expect(sink.errors.join('')).toContain('link');
    expect([...made.deps.files.keys()].filter((path) => path.startsWith('/outside') || path === LAYOUT.reportFile)).toEqual([]);
  });

  it('gives a warning line and the same exit code and output, when the file cannot be written for a reason that is not a link', async () => {
    const made = await make(alpha);
    made.deps.seed(LAYOUT.outboxDir, 'a file where the folder should be');
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toMatch(/alpha\s+web\s+at prompt\s+unknown\s+no/);
    const warnings = sink.errors.join('').split('\n').filter((line) => line !== '');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^warning: the report file was not written: /);
    expect(made.deps.files.get(LAYOUT.outboxDir)).toBe('a file where the folder should be');
  });

  it('gives a warning line, writes no file and keeps its exit code, when the board cannot be read', async () => {
    const made = await make(alpha);
    made.deps.files.delete(BOARD_PATH);
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toMatch(/alpha\s+web\s+at prompt/);
    expect(sink.errors.join('')).toMatch(/^warning: the report file was not written: .*board\.json/m);
    expect(made.deps.files.has(LAYOUT.reportFile)).toBe(false);
  });
});

describe('status: the command line', () => {
  it('is in the help, with its summary', async () => {
    const sink = captureSink();
    expect(await runCli(['--help'], (await make()).deps, sink)).toBe(0);
    expect(sink.out.join('')).toMatch(/^ {2}status {4}\S/m);
  });

  it('takes no argument', async () => {
    const sink = captureSink();
    expect(await runCli(['status', 'alpha', '--home', HOME], (await make()).deps, sink)).toBe(2);
  });

  it('prints the JSON through runCli with the flag --json, and the work item as unknown', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 30 } }], panes: [pane('alpha', { id: '%7' })] });
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toMatchObject({
      schema: schemaIds.status,
      workers: [{ id: 'alpha', pane: '%7', state: 'at prompt', workItem: { state: 'unknown' }, idle: false }],
    });
  });

  it('prints the table through runCli', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toMatch(/ID\s+PROJECT\s+STATE\s+WORK ITEM\s+IDLE/);
    expect(sink.out.join('')).toMatch(/alpha\s+web\s+at prompt\s+unknown\s+no/);
  });
});

describe('status: the folder', () => {
  const PROJECT = '/w/web';
  const TREE = '/elsewhere/web-fix';

  const fromTree = async (commonDir: string): Promise<Made> => {
    const made = await make({
      cwd: TREE,
      projects: [PROJECT],
      git: { repos: { [TREE]: { commonDir } } },
      workers: [{ id: 'alpha', line: { event: 'Stop' } }],
      panes: [pane('alpha')],
    });
    return made;
  };

  it('finds the factory from a separate git work tree of a listed project, and exits 0', async () => {
    const made = await fromTree(`${PROJECT}/.git`);
    const sink = captureSink();
    expect(await runCli(['status', '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toMatchObject({ schema: schemaIds.status, home: HOME, workers: [{ id: 'alpha' }] });
  });

  it('exits 2 with the hint from a git work tree of no listed project', async () => {
    const made = await fromTree('/w/other/.git');
    const sink = captureSink();
    expect(await runCli(['status'], made.deps, sink)).toBe(2);
    expect(sink.errors.join('')).toContain('factory init');
    expect(sink.out.join('')).toBe('');
  });
});

describe('status: the work items come from the board', () => {
  const BOARD_FILE = join(layoutOf(HOME).stateDir, files.board);
  const WORKERS = [
    { id: 'alpha', line: { event: 'Stop', percent: 5 } },
    { id: 'beta', line: { event: 'Stop', percent: 6 } },
    { id: 'gamma', line: { event: 'Stop', percent: 7 } },
  ] as const;
  const BOARD = boardText([
    itemRecord('B-1', { status: 'doing', lane: 'alpha' }),
    itemRecord('B-2', { status: 'done', lane: 'gamma' }),
  ]);

  /** A factory with the three workers, a long quiet time, and the board file `text` (none: no board file). */
  const withBoard = async (text: string | undefined, config: FactoryConfig = sampleConfigWithBoard()): Promise<Made> => {
    const made = await make({ workers: WORKERS, panes: WORKERS.map((worker) => pane(worker.id)), config });
    if (text === undefined) made.deps.files.delete(BOARD_FILE);
    else made.deps.seed(BOARD_FILE, text);
    made.deps.advance(24 * 60 * MINUTE);
    return made;
  };

  it('shows the item in progress of a worker, and idle yes for each worker at its prompt with an old event', async () => {
    const made = await withBoard(BOARD);
    const output = await statusOf(made, boardWorkItems(recipes));
    expect(rowsOf(output)).toMatchObject([
      { id: 'alpha', workItem: 'B-1', idle: 'yes' },
      { id: 'beta', workItem: 'none', idle: 'yes' },
      { id: 'gamma', workItem: 'none', idle: 'yes' },
    ]);
    expect(jsonOf(output).workers.map((worker) => worker.workItem)).toEqual([busyWith('B-1'), NONE, knownItem(null, { closed: ['B-2'] })]);
    expect(output.warnings).toEqual([]);
  });

  it('gives the board to the command line: status through runCli shows the item in progress', async () => {
    const made = await withBoard(BOARD);
    const sink = captureSink();
    expect(await runCli(['status', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toMatchObject({
      workers: [
        { id: 'alpha', workItem: busyWith('B-1'), idle: true },
        { id: 'beta', workItem: NONE, idle: true },
        { id: 'gamma', workItem: knownItem(null, { closed: ['B-2'] }), idle: true },
      ],
    });
  });

  it('shows every worker as unknown, with the idle state of its session, when the setup has no board block', async () => {
    const made = await withBoard(BOARD, sampleConfig());
    const output = await statusOf(made, boardWorkItems(recipes));
    expect(rowsOf(output).map((row) => [row.workItem, row.idle])).toEqual([
      ['unknown', 'yes'],
      ['unknown', 'yes'],
      ['unknown', 'yes'],
    ]);
    expect(output.warnings).toEqual([]);
  });

  it.each([
    ['a board file that is not there', undefined],
    ['a board file that is not JSON', 'not json'],
  ])('shows every worker as unknown, with the idle state of its session and a warning, for %s', async (_name, text) => {
    const made = await withBoard(text);
    const output = await statusOf(made, boardWorkItems(recipes));
    expect(rowsOf(output).map((row) => [row.workItem, row.idle])).toEqual([
      ['unknown', 'yes'],
      ['unknown', 'yes'],
      ['unknown', 'yes'],
    ]);
    // The first warning is the one of the work items. The second one says that the report file is not written, for the same fault.
    expect(output.warnings).toHaveLength(2);
    expect(output.warnings[0]).toContain(files.board);
    expect(output.warnings[1]).toMatch(/^the report file was not written: .*board\.json/);
  });

  it('reads the board file once for the work items and once for the report, and changes no file but the report file', async () => {
    const made = await withBoard(BOARD);
    const filesBefore = new Map(made.deps.files);
    const counted = countReadsOf(made.deps, BOARD_FILE);
    const result = await runStatus(counted.deps, options(), recipes, boardWorkItems(recipes));
    expect(result.ok).toBe(true);
    expect(counted.count()).toBe(2);
    expect([...made.deps.files].filter(([path, text]) => filesBefore.get(path) !== text).map(([path]) => path)).toEqual([LAYOUT.reportFile]);
  });
});

describe('status: the text of a work item prints clean', () => {
  const BIDI = String.fromCodePoint(0x202e);
  const LONG = `B-${'x'.repeat(300)}`;
  const WORKERS = [
    { id: 'alpha', line: { event: 'Stop', percent: 5 } },
    { id: 'beta', line: { event: 'Stop', percent: 6 } },
  ] as const;
  const dirty = { alpha: busyWith(`B-1${BIDI}\n9`), beta: busyWith(LONG) };
  const fleet = (): Promise<Made> => make({ workers: WORKERS, panes: WORKERS.map((worker) => pane(worker.id)) });

  it('prints a work item with a line break and a bidi mark as one clean cell', async () => {
    const output = await statusOf(await fleet(), portOf(dirty).port);
    const text = plainText(output);
    expect(text).not.toContain(BIDI);
    expect(output.lines.every((line) => !/[\n\r\t]/.test(line.text))).toBe(true);
    expect(rowsOf(output).map((row) => row.workItem)).toEqual(['B-1 9', LONG.slice(0, 120)]);
  });

  it('removes only the hidden characters from the string values of the JSON, and cuts no string', async () => {
    const output = await statusOf(await fleet(), portOf(dirty).port);
    const text = renderJson(output.json);
    expect(text).not.toContain(BIDI);
    expect(text).toContain('B-1\\n9');
    expect(JSON.parse(text).workers.map((worker: JsonWorker) => worker.workItem)).toEqual([busyWith('B-1\n9'), busyWith(LONG)]);
  });
});
