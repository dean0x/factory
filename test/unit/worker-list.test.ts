import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { schemaIds, type HookEvent } from '../../src/names.js';
import { workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { runWorker } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
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
}

interface Setup {
  readonly workers?: readonly WorkerSeed[];
  readonly panes?: readonly PaneFixture[];
  readonly tmux?: TmuxFixture;
  readonly config?: FactoryConfig;
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
  const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run: handler });
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
    if (seed.line.event !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'event', event: seed.line.event });
    if (seed.line.percent !== undefined) await writeLastSeen(deps, HOME, session, { kind: 'percent', percent: seed.line.percent });
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
      workers: [{ id: 'alpha', project: 'web', pane: '%7', dead: false, state: 'busy', contextPct: 41, mark: 'MAX' }],
      invalid: [],
    });
  });
});

describe('worker list: the mark of the context percent (TP-22)', () => {
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
  ] as const)('shows %s as %s', async (event, state) => {
    const made = await make({ workers: [{ id: 'alpha', line: { event, percent: 10 } }] });
    expect(rowsOf(await listed(made))[0]?.state).toBe(state);
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
    await writeLastSeen(made.deps, HOME, sessionOf(2), { kind: 'event', event: 'UserPromptSubmit' });
    await writeWorkerSession(made.deps, HOME, 'alpha', sessionOf(2));
    expect(rowsOf(await listed(made))[0]).toMatchObject({ state: 'busy', context: '?', mark: '' });
  });

  it('shows unknown, and names the fault in a warning, when the file system fails on the pointer of one worker', async () => {
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
    expect(rowsOf(result.value)).toMatchObject([
      { id: 'alpha', state: 'unknown', context: '?' },
      { id: 'beta', state: 'at prompt', context: '6%' },
    ]);
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toContain('alpha');
    expect(result.value.warnings[0]).toContain('EIO');
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
