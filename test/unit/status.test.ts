import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { runStatus, type StatusOptions } from '../../src/commands/status.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import type { PaneRow } from '../../src/launch/tmux.js';
import { schemaIds, type HookEvent } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { writeLastSeen, writeWorkerSession, type LastSeen } from '../../src/workers/last-seen.js';
import { writeWorkerRecord, type WorkerRecord } from '../../src/workers/registry.js';
import { buildStatus, type LineRead, type StatusInput } from '../../src/workers/status.js';
import { unknownWorkItems, type WorkItem, type WorkItemPort } from '../../src/workers/work-items.js';
import { createFakeDeps, registerRoot, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const NODE = sampleConfig().core.node.id;
const MINUTE = 60_000;

const NONE: WorkItem = { state: 'known', item: null };
const UNKNOWN: WorkItem = { state: 'unknown' };
const busyWith = (item: string): WorkItem => ({ state: 'known', item });

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

  describe('idle (TP-48, TP-49)', () => {
    it.each([
      ['activity older than idle_after and no open work', 121, NONE, true],
      ['activity of exactly idle_after', 120, NONE, false],
      ['activity newer than idle_after', 119, NONE, false],
      ['old activity and open work', 121, busyWith('W-1'), false],
      ['old activity and an unknown work item', 121, UNKNOWN, false],
    ])('is %s: idle is %s', (_name, minutes, workItem, idle) => {
      const { entry } = firstOf(
        inputOf({
          lines: new Map([['alpha', lineOf({ event: ['Stop', minutes] })]]),
          workItems: new Map([['alpha', workItem]]),
        }),
      );
      expect(entry.idle).toBe(idle);
      expect(entry.workItem).toEqual(workItem);
    });

    it('never calls a worker idle when the port has no answer for it', () => {
      const { entry } = firstOf(inputOf({ lines: new Map([['alpha', lineOf({ event: ['Stop', 600] })]]) }));
      expect(entry.workItem).toEqual(UNKNOWN);
      expect(entry.idle).toBe(false);
    });

    it('never calls a worker idle when it has no usable last-seen line, also with no open work', () => {
      for (const read of [undefined, { kind: 'none' }, { kind: 'fault', reason: 'EIO' }] as const) {
        const lines = read === undefined ? new Map<string, LineRead>() : new Map<string, LineRead>([['alpha', read]]);
        const { entry } = firstOf(inputOf({ lines, workItems: new Map([['alpha', NONE]]) }));
        expect(entry.idle).toBe(false);
        expect(entry.activityAt).toBeNull();
      }
    });

    it('takes the newer of the event time and the percent time as the activity', () => {
      const { entry } = firstOf(
        inputOf({
          lines: new Map([['alpha', lineOf({ event: ['Stop', 300], percent: [20, 10] })]]),
          workItems: new Map([['alpha', NONE]]),
        }),
      );
      expect(entry.activityAt).toBe(minutesAgo(10));
      expect(entry.idle).toBe(false);
    });

    it('counts the minutes of idle_after, not a fixed time', () => {
      const lines = new Map([['alpha', lineOf({ event: ['Stop', 31] })]]);
      const workItems = new Map([['alpha', NONE]]);
      expect(firstOf(inputOf({ lines, workItems, idleAfterMinutes: 30 })).entry.idle).toBe(true);
      expect(firstOf(inputOf({ lines, workItems, idleAfterMinutes: 32 })).entry.idle).toBe(false);
    });

    it('does not call a worker idle when its activity is after the current time', () => {
      const { entry } = firstOf(
        inputOf({
          lines: new Map([['alpha', lineOf({ event: ['Stop', -500] })]]),
          workItems: new Map([['alpha', NONE]]),
        }),
      );
      expect(entry.idle).toBe(false);
    });
  });

  describe('the pane (TP-50)', () => {
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
    ] as const)('TP-5: reads the state of a %s line as %s', (event, state) => {
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
  const deps = createFakeDeps({ cwd, os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run });
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id, setup.projects ?? []);
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

const statusOf = async (made: Made, port: WorkItemPort = unknownWorkItems, change: Partial<StatusOptions> = {}): Promise<CommandOutput> => {
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

describe('status: the table (TP-48)', () => {
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

  it('shows a worker as idle when its activity is older than idle_after and the work item is known and has no open work', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }], panes: [pane('alpha')] });
    made.deps.advance(121 * MINUTE);
    const output = await statusOf(made, portOf({ alpha: NONE }).port);
    expect(rowsOf(output)).toMatchObject([{ id: 'alpha', state: 'at prompt', workItem: 'none', idle: 'yes' }]);
  });

  it('does not show a worker as idle while its activity is newer than idle_after', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(119 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: NONE }).port))[0]?.idle).toBe('no');
  });

  it('does not show a worker as idle while the board gives it open work', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    expect(rowsOf(await statusOf(made, portOf({ alpha: busyWith('W-2') }).port))).toMatchObject([{ workItem: 'W-2', idle: 'no' }]);
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
          workItem: { state: 'known', item: 'W-3' },
          idle: false,
        },
      ],
      invalid: [],
    });
  });
});

describe('status: the stub of the work item port (TP-49)', () => {
  it('shows the work item as unknown and no worker as idle, however old the activity is', async () => {
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
      { id: 'alpha', workItem: 'unknown', idle: 'no' },
      { id: 'beta', workItem: 'unknown', idle: 'no' },
    ]);
    expect(jsonOf(output).workers.map((worker) => [worker.workItem, worker.idle])).toEqual([
      [{ state: 'unknown' }, false],
      [{ state: 'unknown' }, false],
    ]);
  });

  it('answers unknown for every id that it is asked about', async () => {
    const answers = await unknownWorkItems.itemsOf(createFakeDeps(), HOME, ['alpha', 'beta']);
    expect(answers.ok && [...answers.value]).toEqual([
      ['alpha', UNKNOWN],
      ['beta', UNKNOWN],
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
    expect(rowsOf(await statusOf(made, portOf({}).port))).toMatchObject([{ workItem: 'unknown', idle: 'no' }]);
  });

  it('warns and shows every work item as unknown when the port fails', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }], panes: [pane('alpha')] });
    made.deps.advance(600 * MINUTE);
    const broken: WorkItemPort = { itemsOf: async () => failure('the board cannot be read: EIO') };
    const output = await statusOf(made, broken);
    expect(rowsOf(output)).toMatchObject([{ workItem: 'unknown', idle: 'no' }]);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('EIO');
    expect(output.failed).toBe(false);
  });
});

describe('status: the panes (TP-50)', () => {
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

  it('TP-5: shows a worker that waits at a dialog as waits, in the table and in the JSON', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Notification' } }], panes: [pane('alpha', { id: '%7' })] });
    const output = await statusOf(made);
    expect(rowsOf(output).map((row) => [row.id, row.state])).toEqual([['alpha', 'waits']]);
    expect(jsonOf(output).workers[0]).toMatchObject({ id: 'alpha', pane: '%7', state: 'waits' });
  });

  it('refuses a session of the same name that belongs to another factory folder, and lists no pane', async () => {
    const made = await make({ tmux: { sessions: { [NODE]: '/elsewhere' } }, workers: [{ id: 'alpha' }] });
    const result = await runStatus(made.deps, options(), recipes);
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

describe('status: the output is short (TP-63, TP-64)', () => {
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

  it('has a short first line and few lines for three workers, for a run with no session, and for a run with no worker (TP-63)', async () => {
    const shapes: readonly (readonly [Made, WorkItemPort])[] = [
      [await make(fleet), portOf(items).port],
      [await make({ workers, tmux: { sessions: {} } }), unknownWorkItems],
      [await make(), unknownWorkItems],
    ];
    for (const [made, port] of shapes) expectShortOutput(plainText(await statusOf(made, port)));
  });

  it('has the size of its output on the fixture of three workers in the token budget, row 2 (TP-64)', async () => {
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

describe('status: it is a read-only command', () => {
  it('changes no file and no folder', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 33 } }], panes: [pane('alpha', { id: '%7' })] });
    const before = snapshot(made.deps);
    await statusOf(made, portOf({ alpha: NONE }).port);
    expect(snapshot(made.deps)).toBe(before);
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

describe('status: the folder (TP-51, TP-52)', () => {
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
