import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { boardKeys, files, schemaIds, watchPoll, workerRowKeys, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { readOwnLastSeen, writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { runWorker } from '../helpers/package-registry.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleConfig, sampleConfigWithBoard, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const NODE = sampleConfig().core.node.id;

/** One session id for each worker: a UUID with lower case letters. */
const sessionOf = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

interface WorkerSeed {
  readonly id: string;
  readonly project?: string;
  /** The line of the session: the last event and the context percent. A seed with no line has no pointer either. */
  readonly line?: { readonly event?: HookEvent; readonly percent?: number };
  /** The number of the session id, so two workers have two sessions. Default: the place of the seed in the list. */
  readonly session?: number;
  /** The session marker that the line records. Default: the id of the worker. `null`: the line records no marker. */
  readonly marker?: string | null;
}

interface Setup {
  readonly workers?: readonly WorkerSeed[];
  readonly panes?: readonly PaneFixture[];
  readonly tmux?: TmuxFixture;
  readonly config?: FactoryConfig;
  /** Paths that are links in the fake file system, each to its target. */
  readonly links?: Readonly<Record<string, string>>;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
}

const withLimits = (prepare: number, max: number): FactoryConfig => {
  const config = sampleConfig();
  return { ...config, core: { ...config.core, limits: { ...config.core.limits, context_prepare_pct: prepare, context_max_pct: max } } };
};

/** A mark of a pane for a worker, in the session of the node. */
const pane = (worker: string, change: Partial<PaneFixture> = {}): PaneFixture => ({
  session: NODE,
  options: { '@worker': worker },
  ...change,
});

const make = async (setup: Setup = {}): Promise<Made> => {
  const { handler, log } = tmuxHandler({ sessions: { [NODE]: HOME }, panes: setup.panes ?? [], ...setup.tmux });
  const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run: handler, ...(setup.links === undefined ? {} : { links: setup.links }) });
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
  for (const [index, seed] of (setup.workers ?? []).entries()) {
    const project = seed.project ?? 'web';
    const record = await writeWorkerRecord(deps, HOME, {
      id: seed.id,
      project,
      workCopy: `${HOME}/work-copies/${project}/${seed.id}`,
      branch: `worker/${seed.id}`,
    });
    if (!record.ok) throw new Error(record.error.message);
    if (seed.line === undefined) continue;
    const session = sessionOf(seed.session ?? index + 1);
    const pointer = await writeWorkerSession(deps, HOME, seed.id, session);
    if (!pointer.ok) throw new Error(pointer.error.message);
    const marker = seed.marker === undefined ? seed.id : (seed.marker ?? undefined);
    if (seed.line.event !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'event', event: seed.line.event }, marker);
    if (seed.line.percent !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'percent', percent: seed.line.percent }, marker);
  }
  return { deps, tmux: log };
};

const options = (change: Partial<WorkerOptions> = {}): WorkerOptions => ({
  home: HOME,
  words: ['list'],
  project: undefined,
  yes: false,
  duration: undefined,
  ...change,
});

const listed = async (made: Made, change: Partial<WorkerOptions> = {}): Promise<CommandOutput> => {
  const result = await runWorker(made.deps, options(change));
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

interface Row {
  readonly id: string;
  readonly project: string;
  readonly pane: string;
  readonly state: string;
  readonly context: string;
  readonly mark: string;
}

/** The rows of the table, below the title line. A column is cut at two spaces or more, and an empty last column is cut off. */
const rowsOf = (output: CommandOutput): Row[] =>
  output.lines.slice(1).map((line) => {
    const [id = '', project = '', paneId = '', state = '', context = '', mark = ''] = line.text.split(/\s{2,}/);
    return { id, project, pane: paneId, state, context, mark };
  });

const titleOf = (output: CommandOutput): string[] => (output.lines[0]?.text ?? '').split(/\s{2,}/);

type JsonWorker = {
  readonly id: string;
  readonly project: string;
  readonly pane: string | null;
  readonly dead: boolean;
  readonly state: string;
  readonly contextPct: number | null;
  readonly mark: string | null;
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly itemStatus: string | null;
  readonly stage: string | null;
  readonly stageAt: string | null;
  readonly parkedCount: number | null;
  readonly paneLive: boolean;
  readonly sessionState: string;
  readonly activityAt: string | null;
  readonly stalled: boolean;
  readonly hold: string | null;
};

const jsonOf = (output: CommandOutput) =>
  output.json as unknown as {
    readonly schema: string;
    readonly home: string;
    readonly running: boolean;
    readonly workers: readonly JsonWorker[];
    readonly invalid: readonly { readonly name: string; readonly reason: string }[];
  };

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

describe('worker list: the table', () => {
  it('shows the id, the project, the pane, the state, the context and the mark of each worker, in the order of the ids', async () => {
    const made = await make({
      workers: [
        { id: 'beta', project: 'api', line: { event: 'UserPromptSubmit', percent: 12 } },
        { id: 'alpha', project: 'web', line: { event: 'Stop', percent: 35 } },
      ],
      panes: [pane('alpha', { id: '%7' }), pane('beta', { id: '%9' })],
    });
    const output = await listed(made);
    expect(titleOf(output)).toEqual(['ID', 'PROJECT', 'PANE', 'STATE', 'CONTEXT', 'MARK']);
    expect(rowsOf(output)).toEqual([
      { id: 'alpha', project: 'web', pane: '%7', state: 'at prompt', context: '35%', mark: 'PREPARE' },
      { id: 'beta', project: 'api', pane: '%9', state: 'busy', context: '12%', mark: '' },
    ]);
    expect(output.failed).toBe(false);
    expect(output.warnings).toEqual([]);
  });

  it('keeps the columns in line when an id or a value is long', async () => {
    const made = await make({
      workers: [
        { id: 'a', line: { event: 'Stop', percent: 5 } },
        { id: 'a-very-long-worker-id', line: { event: 'Stop', percent: 100 } },
      ],
    });
    const output = await listed(made);
    const starts = output.lines.map((line) => line.text.search(/PROJECT|web/));
    expect(starts).toHaveLength(3);
    expect(new Set(starts).size).toBe(1);
    expect(starts[0]).toBeGreaterThan('a-very-long-worker-id'.length);
  });

  it('prints a short list in a short output', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }], panes: [pane('alpha')] });
    expectShortOutput(plainText(await listed(made)));
  });

  it('says that there is no worker, with an empty list in the JSON', async () => {
    const output = await listed(await make());
    expect(output.lines.map((line) => line.text)).toEqual(['No workers yet.']);
    expect(jsonOf(output)).toMatchObject({ schema: schemaIds.workerList, home: HOME, running: true, workers: [], invalid: [] });
    expect(output.failed).toBe(false);
  });

  it('puts the same facts in the JSON, with the pane id, the number of the percent and the mark', async () => {
    const made = await make({
      workers: [{ id: 'alpha', line: { event: 'PreCompact', percent: 41 } }],
      panes: [pane('alpha', { id: '%7' })],
    });
    expect(jsonOf(await listed(made))).toEqual({
      schema: schemaIds.workerList,
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
          itemId: null,
          itemTitle: null,
          itemStatus: null,
          stage: null,
          stageAt: null,
          parkedCount: null,
          paneLive: true,
          sessionState: 'busy',
          activityAt: made.deps.now().toISOString(),
          stalled: false,
          hold: 'none',
        },
      ],
      invalid: [],
    });
  });

  it('keeps the state key as the raw state and gives the pane and the stalled flag as separate facts', async () => {
    const made = await make({
      workers: [{ id: 'alpha', line: { event: 'UserPromptSubmit', percent: 10 } }, { id: 'beta', line: { event: 'Stop', percent: 10 } }],
      panes: [pane('alpha', { dead: true }), pane('beta')],
    });
    const [alpha, beta] = jsonOf(await listed(made)).workers;
    expect(alpha).toMatchObject({ state: 'busy', sessionState: 'busy', paneLive: false, stalled: false });
    expect(beta).toMatchObject({ state: 'at prompt', sessionState: 'at prompt', paneLive: true, stalled: false });
    const older = ['id', 'project', 'pane', 'dead', 'state', 'contextPct', 'mark'];
    for (const worker of [alpha, beta]) {
      expect(Object.keys(worker ?? {}).sort()).toEqual([...older, ...Object.values(workerRowKeys)].sort());
    }
  });

  it('says that a worker is stalled when its session is busy and its activity is older than the limit', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'UserPromptSubmit', percent: 10 } }], panes: [pane('alpha')] });
    made.deps.advance(watchPoll.stalledAfterMs);
    expect(jsonOf(await listed(made)).workers[0]?.stalled).toBe(false);
    made.deps.advance(1);
    expect(jsonOf(await listed(made)).workers[0]).toMatchObject({ stalled: true, sessionState: 'busy' });
  });
});

describe('worker list: the mark of the context percent', () => {
  it.each([
    [29, ''],
    [30, 'PREPARE'],
    [40, 'PREPARE'],
    [41, 'MAX'],
  ])('with the limits 30 and 40, a percent of %i has the mark %j', async (percent, mark) => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent } }] });
    const output = await listed(made);
    expect(rowsOf(output)[0]).toMatchObject({ context: `${percent}%`, mark });
    expect(jsonOf(output).workers[0]?.mark).toBe(mark === '' ? null : mark);
  });

  it.each([
    [49, ''],
    [50, 'PREPARE'],
    [60, 'PREPARE'],
    [61, 'MAX'],
  ])('takes the limits from the config: with 50 and 60, a percent of %i has the mark %j', async (percent, mark) => {
    const made = await make({ config: withLimits(50, 60), workers: [{ id: 'alpha', line: { event: 'Stop', percent } }] });
    expect(rowsOf(await listed(made))[0]?.mark).toBe(mark);
  });

  it.each([
    [29.5, ''],
    [40.5, 'MAX'],
    [0, ''],
    [100, 'MAX'],
  ])('compares a percent of %f as it is', async (percent, mark) => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent } }] });
    expect(rowsOf(await listed(made))[0]?.mark).toBe(mark);
  });

  it('shows a question mark and no mark when the percent is not known', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop' } }] });
    const output = await listed(made);
    expect(rowsOf(output)[0]).toMatchObject({ context: '?', mark: '' });
    expect(jsonOf(output).workers[0]).toMatchObject({ contextPct: null, mark: null });
  });
});

describe('worker list: the state from the last event', () => {
  it.each([
    ['SessionStart', 'at prompt'],
    ['Stop', 'at prompt'],
    ['UserPromptSubmit', 'busy'],
    ['PreCompact', 'busy'],
    ['PreToolUse', 'busy'],
    ['Notification', 'waits'],
  ] as const)('shows %s as %s', async (event, state) => {
    const made = await make({ workers: [{ id: 'alpha', line: { event, percent: 10 } }] });
    expect(rowsOf(await listed(made))[0]?.state).toBe(state);
  });

  it('puts the state waits in the JSON for a worker that waits at a dialog', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Notification', percent: 10 } }] });
    expect(jsonOf(await listed(made)).workers[0]).toMatchObject({ id: 'alpha', state: 'waits' });
  });

  it('shows unknown for a worker that has no last-seen line', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const output = await listed(made);
    expect(rowsOf(output)[0]).toMatchObject({ state: 'unknown', context: '?', mark: '' });
  });

  it('shows unknown for a line that has a percent and no event', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { percent: 31 } }] });
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'unknown', context: '31%', mark: 'PREPARE' });
  });

  it('shows unknown, and no percent, for a line that is not valid', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 99 } }] });
    made.deps.files.set(`/w/node/.factory/state/heartbeat/${sessionOf(1)}`, 'not json');
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'unknown', context: '?', mark: '' });
  });

  it('shows unknown for a pointer that names a session with no line', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    await writeWorkerSession(made.deps, HOME, 'alpha', sessionOf(5));
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'unknown', context: '?' });
  });

  it('shows unknown for a pointer that is not a session id', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.files.set(workerPathsOf(HOME, 'alpha').lastSessionFile, '../../etc/passwd\n');
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'unknown', context: '?' });
  });

  it('reads the line of the newest session when the worker has had two', async () => {
    const made = await make({ workers: [{ id: 'alpha', session: 1, line: { event: 'Stop', percent: 50 } }] });
    await writeLastSeen(made.deps, HOME, sessionOf(2), { kind: 'event', event: 'UserPromptSubmit' }, 'alpha');
    await writeWorkerSession(made.deps, HOME, 'alpha', sessionOf(2));
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'busy', context: '?', mark: '' });
  });

  it('shows unknown, and no percent, for a line that records no session marker', async () => {
    const made = await make({ workers: [{ id: 'alpha', marker: null, line: { event: 'Stop', percent: 99 } }] });
    const output = await listed(made);
    expect(rowsOf(output)[0]).toMatchObject({ state: 'unknown', context: '?', mark: '' });
    expect(output.warnings).toEqual([]);
  });

  it('shows unknown, and no percent, for a line that records the session marker of another worker or of the coordinator', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', marker: 'beta', line: { event: 'Stop', percent: 99 } },
        { id: 'beta', marker: NODE, line: { event: 'UserPromptSubmit', percent: 99 } },
      ],
    });
    const output = await listed(made);
    expect(rowsOf(output)).toMatchObject([
      { id: 'alpha', state: 'unknown', context: '?', mark: '' },
      { id: 'beta', state: 'unknown', context: '?', mark: '' },
    ]);
    expect(output.warnings).toEqual([]);
  });

  it('shows unknown for a worker whose session is the session that the pointer of another worker names', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 40 } },
        { id: 'beta', line: { event: 'UserPromptSubmit', percent: 5 } },
      ],
    });
    await writeWorkerSession(made.deps, HOME, 'beta', sessionOf(1));
    const output = await listed(made);
    expect(rowsOf(output)[0]).toMatchObject({ id: 'alpha', state: 'unknown', context: '?', mark: '' });
    expect(output.warnings).toEqual([]);
  });

  it('shows unknown for each line that stop and resume do not use, and the state of a line that they use', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 10 } },
        { id: 'beta', marker: null, line: { event: 'Stop', percent: 10 } },
        { id: 'gamma', marker: 'alpha', line: { event: 'Stop', percent: 10 } },
        { id: 'delta' },
      ],
    });
    const states = await Promise.all(
      ['alpha', 'beta', 'gamma', 'delta'].map(async (id) => {
        const read = await readOwnLastSeen(made.deps, HOME, id);
        return read.ok ? read.value.state : 'fault';
      }),
    );
    expect(states).toEqual(['valid', 'unknown', 'unknown', 'unknown']);
    expect(rowsOf(await listed(made)).map((row) => row.context)).toEqual(['10%', '?', '?', '?']);
  });

  it('shows unknown, and names the fault in a warning for each worker, when the file system fails on a pointer', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 5 } },
        { id: 'beta', line: { event: 'Stop', percent: 6 } },
      ],
    });
    const lstat = made.deps.fs.lstat;
    const broken: FakeDeps = {
      ...made.deps,
      fs: { ...made.deps.fs, lstat: async (path) => (path.includes('alpha/last-session') ? failure('cannot stat: EIO') : lstat(path)) },
    };
    const result = await runWorker(broken, options());
    if (!result.ok) throw new Error(result.error.message);
    // The ownership check of beta reads the pointer of alpha too, so the fault stops the state of both workers, as it does for stop.
    expect(rowsOf(result.value)).toMatchObject([
      { id: 'alpha', state: 'unknown', context: '?' },
      { id: 'beta', state: 'unknown', context: '?' },
    ]);
    expect(result.value.warnings).toHaveLength(2);
    expect(result.value.warnings[0]).toContain('alpha');
    expect(result.value.warnings[1]).toContain('beta');
    for (const warning of result.value.warnings) expect(warning).toContain('EIO');
  });

  it('never takes the line of another worker', async () => {
    const made = await make({
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 45 } },
        { id: 'beta', line: { event: 'UserPromptSubmit', percent: 5 } },
      ],
    });
    expect(rowsOf(await listed(made))).toMatchObject([
      { id: 'alpha', state: 'at prompt', context: '45%', mark: 'MAX' },
      { id: 'beta', state: 'busy', context: '5%', mark: '' },
    ]);
  });
});

describe('worker list: the pane column', () => {
  it('shows none for a worker that has no pane', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }], panes: [pane('beta', { id: '%7' })] });
    expect(rowsOf(await listed(made)).map((row) => row.pane)).toEqual(['none', '%7']);
  });

  it('shows dead for a pane whose program has ended, and keeps its id in the JSON', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], panes: [pane('alpha', { id: '%7', dead: true })] });
    const output = await listed(made);
    expect(rowsOf(output)[0]?.pane).toBe('dead');
    expect(jsonOf(output).workers[0]).toMatchObject({ pane: '%7', dead: true });
  });

  it('ignores a pane whose mark names no worker with a record', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], panes: [pane('ghost', { id: '%7' })] });
    const output = await listed(made);
    expect(rowsOf(output).map((row) => row.pane)).toEqual(['none']);
    expect(output.warnings).toEqual([]);
  });

  it('skips a pane with a bad mark, and lists every worker all the same', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }, { id: 'beta' }],
      panes: [
        pane('alpha', { id: '%7' }),
        { session: NODE, id: '%8', options: { '@worker': 'bad|mark with spaces' } },
        { session: NODE, id: '%10', options: { '@worker': '../escape' } },
        pane('beta', { id: '%9' }),
      ],
    });
    const output = await listed(made);
    expect(rowsOf(output).map((row) => [row.id, row.pane])).toEqual([
      ['alpha', '%7'],
      ['beta', '%9'],
    ]);
    expect(output.failed).toBe(false);
  });

  it('shows the first live pane and names every pane when two panes have the mark of one worker', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }],
      panes: [pane('alpha', { id: '%7', dead: true }), pane('alpha', { id: '%8' }), pane('alpha', { id: '%9' })],
    });
    const output = await listed(made);
    expect(rowsOf(output)[0]?.pane).toBe('%8');
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('alpha');
    for (const id of ['%7', '%8', '%9']) expect(output.warnings[0]).toContain(id);
  });

  it('makes one list-panes call, however many workers there are', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
      panes: [pane('alpha'), pane('beta'), pane('gamma')],
    });
    await listed(made);
    expect(made.tmux.commands().filter((command) => command.startsWith('list-panes'))).toHaveLength(1);
  });

  it('calls no tmux command that changes a pane or a window', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], panes: [pane('alpha')] });
    await listed(made);
    const changing = made.tmux.commands().filter((command) => !/^(has-session|show-options|list-panes)/.test(command));
    expect(changing).toEqual([]);
  });
});

describe('worker list: no tmux session of this factory', () => {
  it('lists the records with the pane none, and exits 0, when no session runs', async () => {
    const made = await make({
      tmux: { sessions: {} },
      workers: [
        { id: 'alpha', line: { event: 'Stop', percent: 31 } },
        { id: 'beta' },
      ],
    });
    const output = await listed(made);
    expect(rowsOf(output)).toMatchObject([
      { id: 'alpha', pane: 'none', state: 'at prompt', context: '31%', mark: 'PREPARE' },
      { id: 'beta', pane: 'none', state: 'unknown' },
    ]);
    expect(output.failed).toBe(false);
    expect(jsonOf(output).running).toBe(false);
    expect(made.tmux.commands().filter((command) => command.startsWith('list-panes'))).toEqual([]);
  });

  it('lists the records when tmux is not installed', async () => {
    const made = await make({ tmux: { sessions: {}, version: null }, workers: [{ id: 'alpha' }] });
    expect(rowsOf(await listed(made))[0]?.pane).toBe('none');
  });

  it('refuses a session of the same name that belongs to another factory folder, and names no pane', async () => {
    const made = await make({ tmux: { sessions: { [NODE]: '/elsewhere' } }, workers: [{ id: 'alpha' }] });
    const result = await runWorker(made.deps, options());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('safety');
    expect(made.tmux.commands().filter((command) => command.startsWith('list-panes'))).toEqual([]);
  });

  it('fails with the text of tmux when the pane list does not run', async () => {
    const made = await make({ tmux: { failing: 'list-panes' }, workers: [{ id: 'alpha' }] });
    const result = await runWorker(made.deps, options());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('list-panes');
  });
});

describe('worker list: a record that is not valid', () => {
  const broken = (made: Made, name: string, text: string): void => {
    made.deps.seed(`/w/node/.factory/workers/${name}/worker.json`, text);
  };

  it('names the folder and the reason, and lists the other workers', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }] });
    broken(made, 'broken', 'not json');
    const output = await listed(made);
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha']);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('broken');
    expect(output.warnings[0]).toContain('not valid JSON');
    expect(jsonOf(output).invalid).toEqual([{ name: 'broken', reason: expect.stringContaining('not valid JSON') }]);
    expect(output.failed).toBe(false);
  });

  it('names a worker whose record points to a work copy that is not its own, and lists the other workers', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }, { id: 'beta' }] });
    const forged = JSON.parse(made.deps.files.get('/w/node/.factory/workers/beta/worker.json') ?? 'null') as Record<string, unknown>;
    broken(made, 'beta', `${JSON.stringify({ ...forged, work_copy: HOME })}\n`);
    const output = await listed(made);
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha']);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('beta');
    expect(output.warnings[0]).toContain('work copy');
    expect(jsonOf(output).invalid).toEqual([{ name: 'beta', reason: expect.stringContaining('work copy') }]);
    expect(output.failed).toBe(false);
  });

  it('names a folder that holds no record', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.seedDir('/w/node/.factory/workers/empty');
    const output = await listed(made);
    expect(output.warnings.join('\n')).toContain('empty');
    expect(jsonOf(output).invalid.map((entry) => entry.name)).toEqual(['empty']);
  });

  it('says that there is no worker when the only folder has an invalid record', async () => {
    const made = await make();
    broken(made, 'broken', '{}');
    const output = await listed(made);
    expect(output.lines.map((line) => line.text)).toEqual(['No workers yet.']);
    expect(output.warnings).toHaveLength(1);
  });

  it('shows a name with a control character as text, cut and escaped', async () => {
    const made = await make();
    broken(made, 'bad\u001b[31mname', '{}');
    const output = await listed(made);
    expect(output.warnings.join('')).not.toContain('\u001b');
  });
});

describe('worker list: it is a read-only command', () => {
  it('changes no file and no folder', async () => {
    const made = await make({
      workers: [{ id: 'alpha', line: { event: 'Stop', percent: 33 } }],
      panes: [pane('alpha', { id: '%7' })],
    });
    const before = snapshot(made.deps);
    await listed(made);
    expect(snapshot(made.deps)).toBe(before);
  });
});

describe('worker list: the command line', () => {
  it('takes no argument', async () => {
    const result = await runWorker((await make()).deps, options({ words: ['list', 'alpha'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('usage');
      expect(result.error.message).toContain('takes no argument');
    }
  });

  it('is named in the subcommands of an unknown subcommand', async () => {
    const result = await runWorker((await make()).deps, options({ words: ['nope'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('new, list');
  });

  it('is in the usage of the command', async () => {
    const made = await make();
    const sink = captureSink();
    expect(await runCli(['worker', '--help'], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toContain('worker list');
  });

  it('prints the JSON through runCli with the flag --json', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 30 } }], panes: [pane('alpha', { id: '%7' })] });
    const sink = captureSink();
    expect(await runCli(['worker', 'list', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toMatchObject({
      schema: schemaIds.workerList,
      workers: [{ id: 'alpha', pane: '%7', state: 'at prompt', contextPct: 30, mark: 'PREPARE' }],
    });
  });

  it('prints the table through runCli, and the warnings of a bad record on stderr', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 30 } }] });
    made.deps.seed('/w/node/.factory/workers/broken/worker.json', 'not json');
    const sink = captureSink();
    expect(await runCli(['worker', 'list', '--home', HOME], made.deps, sink)).toBe(0);
    expect(sink.out.join('')).toContain('alpha');
    expect(sink.errors.join('')).toMatch(/^warning: .*broken/);
  });
});

describe('worker list: the board port', () => {
  const BOARD_FILE = join(layoutOf(HOME).stateDir, files.board);
  const WORKERS = [
    { id: 'alpha', line: { event: 'Stop', percent: 5 } },
    { id: 'beta', line: { event: 'Stop', percent: 6 } },
  ] as const;
  const BOARD = boardText([itemRecord('B-1', { status: 'doing', lane: 'alpha' })]);

  /** A factory with two workers and a board block (or none), and the board file `text` (none: no board file). */
  const withBoard = async (text: string | undefined, config: FactoryConfig = sampleConfigWithBoard()): Promise<Made> => {
    const made = await make({ workers: WORKERS, config });
    if (text !== undefined) made.deps.seed(BOARD_FILE, text);
    return made;
  };

  it('lists the workers with no warning when the board is whole', async () => {
    const output = await listed(await withBoard(BOARD));
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha', 'beta']);
    expect(output.warnings).toEqual([]);
  });

  it('lists the workers with no warning when the setup has no board block', async () => {
    const output = await listed(await withBoard(BOARD, sampleConfig()));
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha', 'beta']);
    expect(output.warnings).toEqual([]);
  });

  it.each([
    ['a board file that is not there', undefined],
    ['a board file that is not JSON', 'not json'],
  ])('lists the workers, with one warning that names the board file, for %s', async (_name, text) => {
    const output = await listed(await withBoard(text));
    expect(rowsOf(output).map((row) => row.id)).toEqual(['alpha', 'beta']);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain(files.board);
    expect(output.failed).toBe(false);
  });

  it('gives the item, its title, its status, its stage and the stage time of a worker in the row', async () => {
    const stageTime = '2030-01-01T09:30:00.000Z';
    const board = boardText([
      itemRecord('B-1', { status: 'doing', lane: 'alpha', stage: 'build', stage_at: stageTime }),
      itemRecord('B-0', { status: 'open', [boardKeys.unassignedFrom]: ['alpha'] }),
    ]);
    const [alpha, beta] = jsonOf(await listed(await withBoard(board))).workers;
    expect(alpha).toMatchObject({
      itemId: 'B-1',
      itemTitle: 'Item B-1',
      itemStatus: 'doing',
      stage: 'build',
      stageAt: stageTime,
      parkedCount: 1,
    });
    expect(beta).toMatchObject({ itemId: null, itemTitle: null, stage: null, stageAt: null, parkedCount: 0 });
  });

  it('gives null item fields and a count of null for a worker whose board is not read', async () => {
    const [alpha] = jsonOf(await listed(await withBoard(undefined))).workers;
    expect(alpha).toMatchObject({ itemId: null, itemTitle: null, itemStatus: null, stage: null, stageAt: null, parkedCount: null });
  });

  it('reads the board file once, and changes no file', async () => {
    const made = await withBoard(BOARD);
    const before = snapshot(made.deps);
    const counted = countReadsOf(made.deps, BOARD_FILE);
    const result = await runWorker(counted.deps, options());
    expect(result.ok).toBe(true);
    expect(counted.count()).toBe(1);
    expect(snapshot(made.deps)).toBe(before);
  });
});

describe('worker list: the name of a folder prints clean', () => {
  const BIDI = String.fromCodePoint(0x202e);
  const NAME = `bad${BIDI}na\nme`;

  it('shows the name of a folder with a bidi mark and a line break as one clean text in the warning', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }] });
    made.deps.seed(`/w/node/.factory/workers/${NAME}/worker.json`, '{}');
    const output = await listed(made);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('"badna\\nme"');
    expect(output.warnings[0]).not.toMatch(/[\n\r\t]/);
    expect(output.warnings[0]).not.toContain(BIDI);
  });

  it('prints no hidden character in the JSON, for the name of a folder that has some', async () => {
    const made = await make({ workers: [{ id: 'alpha', line: { event: 'Stop', percent: 5 } }] });
    made.deps.seed(`/w/node/.factory/workers/${NAME}/worker.json`, '{}');
    const sink = captureSink();
    expect(await runCli(['worker', 'list', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    const text = sink.out.join('');
    expect(text).not.toContain(BIDI);
    expect(JSON.parse(text).invalid).toEqual([{ name: '"badna\\nme"', reason: expect.any(String) }]);
  });
});

describe('worker mark: the hold word of a worker', () => {
  const holdFile = (id: string): string => workerPathsOf(HOME, id).holdFile;

  const marked = async (made: Made, id: string, word: string): Promise<CommandOutput> => {
    const result = await runWorker(made.deps, options({ words: ['mark', id, word] }));
    if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
    return result.value;
  };

  const holdsOf = async (made: Made): Promise<readonly (string | null)[]> =>
    jsonOf(await listed(made)).workers.map((worker) => worker.hold);

  it('shows none for a worker with no mark', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    expect(await holdsOf(made)).toEqual(['none', 'none']);
  });

  it('sets each mark, and worker list --json shows it for that worker only', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    for (const word of ['parked', 'on-hold']) {
      const output = await marked(made, 'alpha', word);
      expect(output.json).toEqual({ schema: schemaIds.workerMark, id: 'alpha', hold: word });
      expect(output.lines.map((line) => line.text)).toEqual([`The worker alpha has the hold word ${word}.`]);
      expect(made.deps.files.get(holdFile('alpha'))).toBe(`${word}\n`);
      expect(await holdsOf(made)).toEqual([word, 'none']);
    }
  });

  it('clears the mark with none, and none on a worker with no mark changes nothing', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    await marked(made, 'alpha', 'parked');
    const output = await marked(made, 'alpha', 'none');
    expect(output.json).toEqual({ schema: schemaIds.workerMark, id: 'alpha', hold: 'none' });
    expect(output.lines.map((line) => line.text)).toEqual(['The worker alpha has no hold word.']);
    expect(made.deps.files.has(holdFile('alpha'))).toBe(false);
    expect(await holdsOf(made)).toEqual(['none']);
    expect((await marked(made, 'alpha', 'none')).json).toMatchObject({ hold: 'none' });
    expect(await holdsOf(made)).toEqual(['none']);
  });

  it('runs from the command line and prints the hold in the JSON of worker list', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    expect(await runCli(['worker', 'mark', 'alpha', 'on-hold', '--home', HOME], made.deps, captureSink())).toBe(0);
    const sink = captureSink();
    expect(await runCli(['worker', 'list', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    expect(JSON.parse(sink.out.join('')).workers[0].hold).toBe('on-hold');
  });

  it('refuses a word that is not a mark, and a wrong count of words, with exit 2 and no write', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    for (const words of [['mark', 'alpha', 'held'], ['mark', 'alpha'], ['mark', 'alpha', 'parked', 'extra'], ['mark']]) {
      const result = await runWorker(made.deps, options({ words }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('usage');
    }
    expect(made.deps.files.has(holdFile('alpha'))).toBe(false);
  });

  it('refuses a worker with no record with exit 2, and writes no folder for it', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const result = await runWorker(made.deps, options({ words: ['mark', 'ghost', 'parked'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('usage');
    expect(made.deps.dirs.has(workerPathsOf(HOME, 'ghost').dir)).toBe(false);
    expect(made.deps.files.has(holdFile('ghost'))).toBe(false);
  });

  it('gives null and a warning for a hold file that holds no hold word, and lists the other workers', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    made.deps.seed(holdFile('alpha'), 'parked and more\n');
    const output = await listed(made);
    expect(jsonOf(output).workers.map((worker) => worker.hold)).toEqual([null, 'none']);
    expect(output.warnings).toEqual(['cannot read the hold word of the worker alpha: the hold file holds no hold word']);
    expect(output.warnings[0]).not.toContain('more');
  });

  it('gives null and a warning for a hold file that is a link, and does not follow it', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [holdFile('alpha')]: '/elsewhere/hold' } });
    const output = await listed(made);
    expect(jsonOf(output).workers[0]?.hold).toBeNull();
    expect(output.warnings).toEqual(['cannot read the hold word of the worker alpha: the hold file is a link']);
  });
});
