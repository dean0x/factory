import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
import { launchConfirm, maxFileBytes, roleText, schemaIds, stopPoll, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { claudeFileText } from '../helpers/blocks.js';
import {
  createFakeDeps,
  exited,
  missingProgram,
  registerRoot,
  withFsWatch,
  type FakeDeps,
  type FetchHandler,
  type PromptHandler,
  type RunCall,
} from '../helpers/fake-deps.js';
import { runWorker } from '../helpers/package-registry.js';
import { seedAcceptedSetup, seedUnacceptedSetup } from '../helpers/role-delivery.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { launchWordsOf } from '../helpers/worker-launch-words.js';
import { atWait, endsPane, startsSession, withProgram, type Program } from '../helpers/worker-program.js';

const HOME = '/w/node';
const CLONE = '/w/node/web';
const COPIES = '/w/node/work-copies';
const PROJECT_COPIES = '/w/node/work-copies/web';
const COPY = '/w/node/work-copies/web/alpha';
const SETTINGS_FILE = '/w/node/work-copies/web/alpha/.claude/settings.local.json';
const EXCLUDE = '/w/node/web/.git/info/exclude';
const ENTRY = '/.claude/settings.local.json';
const RECORD = '/w/node/.factory/workers/alpha/worker.json';
const INBOX = '/w/node/.factory/workers/alpha/inbox';
const BRANCH = 'worker/alpha';
const COORDINATOR_SETTINGS = '/w/node/coordinator/.claude/settings.local.json';
const OWN_SETTINGS = `${JSON.stringify(ownSettingsEntries, null, 2)}\n`;
const TEMPLATE = '# exclude patterns for git\n*.log\n';
const FIRST_NEW_PANE = '%3';
const PROXY_URL = 'http://127.0.0.1:8080/secret-path';

const FIXTURES = join(__dirname, '..', 'fixtures', 'machine', 'macos');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** One path of the last commit of the clone. A text makes it a file that the checkout puts into the new work copy. */
interface HeadEntry {
  readonly path: string;
  /** The git mode: 100644 for a file (the default) and 120000 for a link. */
  readonly mode?: string;
  readonly text?: string;
}

const LINK_MODE = '120000';
const hex = (index: number): string => index.toString(16).padStart(40, '0');

/** The tracked entries of the last commit below `.claude`, as the setup gives them. */
const headOf = (setup: Setup): readonly HeadEntry[] => [
  ...(setup.checkout === undefined ? [] : [{ path: '.claude/settings.local.json', text: setup.checkout }]),
  ...(setup.head ?? []),
];

/** The answer of `git ls-tree -z -l HEAD -- <path>`: the entry `.claude` itself, or the entries one level below `.claude/`. */
const listHead = (entries: readonly HeadEntry[], path: string): string => {
  const line = (entry: HeadEntry, shown: string): string => {
    const text = entry.text ?? '';
    return `${entry.mode ?? '100644'} blob ${hex(entries.indexOf(entry) + 1)} ${String(text.length).padStart(7)}\t${shown}\0`;
  };
  if (path === '.claude') {
    const own = entries.find((entry) => entry.path === '.claude');
    if (own !== undefined) return line(own, '.claude');
    return entries.some((entry) => entry.path.startsWith('.claude/')) ? `040000 tree ${hex(0)}       -\t.claude\0` : '';
  }
  return entries
    .filter((entry) => entry.path.startsWith('.claude/') && !entry.path.slice('.claude/'.length).includes('/'))
    .map((entry) => line(entry, entry.path))
    .join('');
};

type FactName = 'memory' | 'disk' | 'load' | 'cpus';

interface Setup {
  readonly tty?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly tmux?: TmuxFixture;
  readonly config?: FactoryConfig;
  readonly links?: Record<string, string>;
  /** Files (text) and folders (null) to put in the file system before the run. */
  readonly seed?: Readonly<Record<string, string | null>>;
  readonly prompt?: PromptHandler;
  readonly fetch?: FetchHandler;
  /** The programs on PATH. Default: tmux and claude. */
  readonly tools?: readonly string[];
  /** The paths that git tracks in the home, the paths that it ignores, and the origin of the home. */
  readonly tracked?: readonly string[];
  readonly ignored?: readonly string[];
  readonly origin?: 'own' | 'received';
  /** The local branches that the clone has already. */
  readonly branches?: readonly string[];
  /** The exit code of `git worktree add`. Default: 0. */
  readonly worktreeExit?: number;
  /** The text of the file `.claude/settings.local.json` that the last commit of the clone tracks, and the checkout puts into the new work copy. */
  readonly checkout?: string;
  /** More paths that the last commit of the clone tracks at or below `.claude`. */
  readonly head?: readonly HeadEntry[];
  /** True: git can not read the last commit of the clone. */
  readonly headFails?: boolean;
  readonly claudeFile?: string | false;
  /** What a program of the machine check prints. A null text leaves the program out. */
  readonly machine?: Partial<Record<FactName, string | null>>;
  /** The path whose exclusive write fails. */
  readonly failWrite?: string;
  /** True: git says that the project folder is not the top of a work tree. */
  readonly notRepo?: boolean;
  /** After a TERM, a process still runs for this many checks, and then it ends. Default: 0. */
  readonly termEndsAfterChecks?: number;
  /** What the program of a new pane does while the launch waits. Default: nothing, the pane stays alive and writes nothing. */
  readonly program?: Program;
  /** The top folder of the git work tree of the working folder, as `git rev-parse --show-toplevel` prints it. Default: no work tree. */
  readonly tree?: string;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** What happened, in order: `git worktree-add`, `tmux <command>`, `warn` and each write of the file system. */
  readonly events: string[];
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
}

const WRITES = new Set(['writeText', 'writeTextAtomic', 'writeTextExclusive', 'rename', 'mkdir', 'remove', 'chmod']);

const machineAnswers = (given: Setup['machine'] = {}): Record<FactName, string | null> => ({
  memory: fixture('memory_pressure.txt'),
  disk: fixture('df.txt'),
  load: fixture('sysctl-loadavg.txt'),
  cpus: fixture('sysctl-ncpu.txt'),
  ...given,
});

/**
 * The fake of git: the home is a work tree that tracks and ignores what the setup says, the clone is a work tree with a
 * common git folder, and `worktree add` makes the folder of the work copy, as git does.
 */
const gitAnswer = (setup: Setup, made: () => FakeDeps) => (call: RunCall) => {
  const command = call.args.slice(2).join(' ');
  if (call.args[2] === 'worktree') {
    if ((setup.worktreeExit ?? 0) !== 0) return exited(setup.worktreeExit ?? 0, '', 'fatal: cannot make the work copy\n');
    const folder = call.args[call.args.length - 1] ?? '';
    made().seedDir(folder);
    for (const entry of headOf(setup)) {
      if (entry.text !== undefined && entry.mode !== LINK_MODE) made().seed(`${folder}/${entry.path}`, entry.text);
    }
    return exited(0, 'Preparing worktree\n');
  }
  if (call.args[2] === 'ls-tree') {
    if (setup.headFails === true) return exited(128, '', 'fatal: not a valid object name HEAD\n');
    return exited(0, listHead(headOf(setup), call.args[call.args.length - 1] ?? ''));
  }
  if (call.args[2] === 'cat-file') {
    const entries = headOf(setup);
    const entry = entries.find((candidate) => hex(entries.indexOf(candidate) + 1) === call.args[4]);
    return entry?.text === undefined ? exited(128, '', 'fatal: Not a valid object name\n') : exited(0, entry.text);
  }
  if (command.startsWith('rev-parse --verify --quiet refs/heads/')) {
    return (setup.branches ?? []).includes(command.slice('rev-parse --verify --quiet refs/heads/'.length)) ? exited(0, 'abc123\n') : exited(1);
  }
  if (command === 'rev-parse --show-toplevel') {
    return setup.tree === undefined ? exited(128, '', 'fatal: not a git repository\n') : exited(0, `${setup.tree}\n`);
  }
  if (command === 'rev-parse --git-common-dir') return exited(0, '.git\n');
  if (command === 'rev-parse --is-inside-work-tree --show-prefix') {
    return setup.notRepo === true && call.args[1] === CLONE ? exited(128, '', 'fatal: not a git repository\n') : exited(0, 'true\n\n');
  }
  if (command === 'ls-files -z') return exited(0, (setup.tracked ?? []).map((path) => `${path}\0`).join(''));
  if (call.args[2] === 'check-ignore') {
    const asked = call.args.slice(call.args.indexOf('--') + 1);
    return asked.every((path) => setup.ignored === undefined || setup.ignored.includes(path)) ? exited(0) : exited(1);
  }
  return exited(128, '', 'fatal: not a git repository\n');
};

const make = (setup: Setup = {}): Made => {
  const { handler, log } = tmuxHandler({ sessions: { demo: HOME }, ...setup.tmux });
  const events: string[] = [];
  let base: FakeDeps | undefined;
  const git = gitAnswer(setup, () => {
    if (base === undefined) throw new Error('the deps are not made yet');
    return base;
  });
  const answers = machineAnswers(setup.machine);
  const machine = (call: RunCall) => {
    const source: FactName | null =
      call.command === 'memory_pressure'
        ? 'memory'
        : call.command === 'df'
          ? 'disk'
          : call.command === 'sysctl'
            ? call.args.includes('vm.loadavg')
              ? 'load'
              : 'cpus'
            : null;
    const text = source === null ? null : answers[source];
    return text === null ? missingProgram(call.command) : exited(0, text);
  };
  const tty = setup.tty ?? false;
  base = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run: (call) => {
      if (call.command === 'git') {
        if (call.args[2] === 'worktree') events.push('git worktree-add');
        return git(call);
      }
      if (call.command === 'tmux') {
        events.push(`tmux ${call.args[0]}`);
        return handler(call);
      }
      events.push(`machine ${call.command}`);
      return machine(call);
    },
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    ...(setup.termEndsAfterChecks === undefined ? {} : { termEndsAfterChecks: setup.termEndsAfterChecks }),
    ...(setup.prompt === undefined
      ? {}
      : {
          prompt: (question: string) => {
            events.push('prompt');
            return setup.prompt?.(question) ?? failure('no answer');
          },
        }),
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  for (const tool of setup.tools ?? ['tmux', 'claude']) base.seed(`/bin/${tool}`, '');
  const config = setup.config ?? sampleConfig();
  seedConfig(base, HOME, config);
  base.seedDir('/w/node/coordinator');
  if (setup.claudeFile !== false) base.seed('/w/node/coordinator/CLAUDE.md', setup.claudeFile ?? claudeFileText(config));
  base.seed(COORDINATOR_SETTINGS, OWN_SETTINGS);
  base.seedDir(CLONE);
  base.seedDir(`${CLONE}/.git`);
  base.seed(EXCLUDE, TEMPLATE);
  registerRoot(base, HOME, config.core.node.id, [], setup.origin);
  for (const [path, text] of Object.entries(setup.seed ?? {})) {
    if (text === null) base.seedDir(path);
    else base.seed(path, text);
  }
  const watched = withFsWatch(base, (method, path) => {
    if (WRITES.has(method)) events.push(`${method} ${path}`);
  });
  const failing = setup.failWrite;
  const deps: FakeDeps = {
    ...watched,
    fs:
      failing === undefined
        ? watched.fs
        : {
            ...watched.fs,
            writeTextExclusive: async (path, text, mode) =>
              path === failing ? failure(`cannot write ${path}: disk full`) : watched.fs.writeTextExclusive(path, text, mode),
          },
    warn: (message) => {
      events.push(`warn: ${message}`);
      base?.warn(message);
    },
  };
  return {
    deps: setup.program === undefined ? deps : withProgram(deps, log, setup.program),
    tmux: log,
    events,
    files: new Map(base.files),
    dirs: new Set(base.dirs),
  };
};

/** The coordinator file of an earlier package: the safety block is intact, but its text differs from the one that the package renders. */
const olderClaudeFile = (): string => {
  const config = sampleConfig();
  const older = claudeFileText({ ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[From {owner} at {node} on {date}]' } } });
  expect(older).not.toBe(claudeFileText(config));
  return older;
};

/** The warning for a safety block that is out of date: this command renders nothing, and start or reboot outside the session does. */
const OUT_OF_DATE_NOTE =
  'The block safety in coordinator/CLAUDE.md is out of date. A command that starts a worker does not render it again. ' +
  '"factory start" does, and so does "factory reboot" outside the session.';

const options = (change: Partial<WorkerOptions> = {}): WorkerOptions => ({
  home: HOME,
  words: ['new', 'alpha'],
  project: 'web',
  yes: true,
  duration: undefined,
  ...change,
});

const run = (made: Made, change: Partial<WorkerOptions> = {}) => runWorker(made.deps, options(change));

const succeeded = async (made: Made, change: Partial<WorkerOptions> = {}) => {
  const result = await run(made, change);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const failed = async (made: Made, change: Partial<WorkerOptions> = {}): Promise<CliError> => {
  const result = await run(made, change);
  if (result.ok) throw new Error('the command should have failed');
  return result.error;
};

/** The command made no change: no file, no folder, no git call that writes and no pane. */
const expectNothingChanged = (made: Made): void => {
  expect(new Map(made.deps.files)).toEqual(made.files);
  expect(new Set(made.deps.dirs)).toEqual(made.dirs);
  expect(made.events).not.toContain('git worktree-add');
  expect(made.events).not.toContain('tmux split-window');
};

const indexOf = (made: Made, fragment: string): number => made.events.findIndex((event) => event.includes(fragment));

const recordOf = (made: Made): Record<string, unknown> => JSON.parse(made.deps.files.get(RECORD) ?? 'null') as Record<string, unknown>;

const RESUME = '"factory worker resume alpha"';
const REMOVE_COPY = `git -C ${CLONE} worktree remove ${COPY}`;
const DELETE_BRANCH = `git -C ${CLONE} branch -D ${BRANCH}`;
const RECORD_DIR = '/w/node/.factory/workers/alpha';

/**
 * The remedy of a step that failed after the work copy, the branch and the record exist: nothing is undone, and the hint names the
 * command that frees the worker once its branch is pushed, and the steps that remove the worker by hand, in the order that works.
 */
const expectKeptCopyHint = (error: CliError): void => {
  const hint = error.hint ?? '';
  expect(hint).toContain('Nothing is undone: the work copy, the branch and the record of the worker stay.');
  expect(hint).toContain('After its branch is pushed, factory can remove it: run "factory dismiss alpha" to see the steps');
  expect(hint).toContain('then add --yes in a terminal window outside a factory session.');
  expect(hint).toContain(
    'The coordinator may instead run "factory dismiss alpha --closed" in its factory session, only when an item of the worker is closed and its branch is pushed.',
  );
  expect(hint).toContain(`To remove the worker by hand, run "${REMOVE_COPY}" and then "${DELETE_BRANCH}". Then delete the folder ${RECORD_DIR}.`);
};

describe('worker new: the work, in order (TP-5)', () => {
  it('makes the work copy, the record, the exclude entry, the settings file and the pane, in this order', async () => {
    const made = make();
    await succeeded(made);
    const order = [
      indexOf(made, 'git worktree-add'),
      indexOf(made, `writeTextExclusive ${RECORD}`),
      indexOf(made, `writeTextExclusive ${EXCLUDE}.tmp-`),
      indexOf(made, `writeTextExclusive ${SETTINGS_FILE}.tmp-`),
      indexOf(made, 'tmux split-window'),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(indexOf(made, 'tmux set-option')).toBeGreaterThan(order[4] ?? 0);
  });

  it('makes the work copy of the listed clone on a new branch, in work-copies/<project>/<id>', async () => {
    const made = make();
    await succeeded(made);
    const git = made.deps.calls.filter((call) => call.command === 'git' && call.args[2] === 'worktree');
    expect(git.map((call) => call.args)).toEqual([['-C', CLONE, 'worktree', 'add', '-b', BRANCH, COPY]]);
  });

  it('writes the record of the worker, with its project, work copy and branch, and makes its inbox', async () => {
    const made = make();
    await succeeded(made);
    expect(recordOf(made)).toEqual({
      schema: 'factory.worker/v1',
      id: 'alpha',
      project: 'web',
      work_copy: COPY,
      branch: BRANCH,
      created_at: '2030-01-02T03:04:05.678Z',
    });
    expect(made.deps.dirs.has(INBOX)).toBe(true);
  });

  it('makes one pane in the workers window, in the work copy, marked with the id of the worker', async () => {
    const made = make();
    await succeeded(made);
    expect(made.tmux.panes().at(-1)).toMatchObject({
      id: FIRST_NEW_PANE,
      window: 'workers',
      cwd: COPY,
      options: { '@worker': 'alpha' },
    });
    const split = made.tmux.calls.find((call) => call.args[0] === 'split-window');
    expect(split?.args).toContain('FACTORY_SESSION=alpha');
    expect(split?.args).toContain(`FACTORY_INBOX=${INBOX}`);
  });

  it('writes the hook settings into the work copy and nowhere else in it', async () => {
    const made = make();
    await succeeded(made);
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
    expect([...made.deps.files.keys()].filter((path) => path.startsWith(`${COPY}/`))).toEqual([SETTINGS_FILE]);
    expect(made.deps.files.get(COORDINATOR_SETTINGS)).toBe(OWN_SETTINGS);
  });

  it('shows the change to the settings file before it writes it, when the yes flag agrees', async () => {
    const made = make();
    await succeeded(made);
    expect(made.deps.warned.join('\n')).toContain(`This changes the settings of Claude Code in ${SETTINGS_FILE}`);
    expect(made.deps.prompts).toEqual([]);
  });

  it('makes two workers of one project: two records, two work copies and one exclude entry', async () => {
    const made = make();
    await succeeded(made);
    await succeeded(made, { words: ['new', 'beta'] });
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.files.has('/w/node/.factory/workers/beta/worker.json')).toBe(true);
    expect(made.deps.dirs.has('/w/node/work-copies/web/beta')).toBe(true);
    expect((made.deps.files.get(EXCLUDE) ?? '').split('\n').filter((line) => line === ENTRY)).toHaveLength(1);
  });

  it('reports the work in its output and its JSON document', async () => {
    const made = make();
    const output = await succeeded(made);
    expect(plainText(output)).toBe(
      'Made the worker alpha in work-copies/web/alpha on the branch worker/alpha.\nIt runs in the pane %3 of the window workers.\n' +
        'If Claude Code asks to trust the folder, the owner answers once in the pane %3. Then run "factory worker watch --ready alpha".\n',
    );
    expect(output.json).toEqual({
      schema: 'factory.worker-new/v1',
      id: 'alpha',
      project: 'web',
      workCopy: COPY,
      branch: BRANCH,
      pane: FIRST_NEW_PANE,
      proxy: null,
      assignment: null,
    });
    expect(output.failed).toBe(false);
  });
});

describe('worker new: a node on a layer of 2 or more holds workers (AC-1)', () => {
  const layerOf = (layer: number): FactoryConfig => {
    const config = sampleConfig();
    return { ...config, core: { ...config.core, node: { ...config.core.node, layer } } };
  };

  it.each([1, 2, 3])('makes a worker on a node on layer %i', async (layer) => {
    const made = make({ config: layerOf(layer) });
    await succeeded(made);
    expect(recordOf(made)).toMatchObject({ project: 'web', branch: BRANCH });
    expect(indexOf(made, 'tmux split-window')).toBeGreaterThanOrEqual(0);
  });
});

describe('worker new: the output is short (TP-63)', () => {
  it('has a short first line and few lines, also with warnings', async () => {
    const made = make({ machine: { memory: 'System-wide memory free percentage: 5%\n', disk: null } });
    const output = await succeeded(made);
    expectShortOutput(plainText(output));
  });

  it('has the size of its output on this fixture in the token budget, row 4 (TP-64)', async () => {
    const text = plainText(await succeeded(make()));
    const row = budgetRow(4);
    expect(row.command).toBe('`factory worker new`');
    expect(row.measured).toBe(tokensOf(text));
    expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
  });
});

describe('worker new --assignment: the source check and the copy (TP-32, TP-33, TP-34)', () => {
  const TASK = '# Task\n\nFix the build.\n';
  const TREE = '/w/tree';
  const ASSIGNMENT = `${INBOX}/assignment.md`;
  const SOURCE = `${TREE}/docs/task.md`;
  const WITH_SOURCE = { tree: TREE, seed: { [SOURCE]: TASK } } as const;

  it('TP-33: copies a file of the git work tree of the working folder to the inbox, after the record and before the exclude entry and the launch', async () => {
    const made = make(WITH_SOURCE);
    await succeeded(made, { assignment: SOURCE });
    expect(made.deps.files.get(ASSIGNMENT)).toBe(TASK);
    const order = [
      indexOf(made, `writeTextExclusive ${RECORD}`),
      indexOf(made, `writeTextExclusive ${ASSIGNMENT}.tmp-`),
      indexOf(made, `writeTextExclusive ${EXCLUDE}.tmp-`),
      indexOf(made, 'tmux split-window'),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('TP-33: reads a path that starts at the working folder', async () => {
    const made = make(WITH_SOURCE);
    await succeeded(made, { assignment: 'tree/docs/task.md' });
    expect(made.deps.files.get(ASSIGNMENT)).toBe(TASK);
  });

  it('TP-33: copies a file of the orders folder of the factory folder', async () => {
    const orders = '/w/node/.factory/orders/task.md';
    const made = make({ seed: { [orders]: TASK } });
    await succeeded(made, { assignment: orders });
    expect(made.deps.files.get(ASSIGNMENT)).toBe(TASK);
  });

  it('TP-33: names the copy in one more line of the output and in the JSON document, and makes no assignment file without the flag', async () => {
    const withFile = await succeeded(make(WITH_SOURCE), { assignment: SOURCE });
    expect(plainText(withFile)).toBe(
      'Made the worker alpha in work-copies/web/alpha on the branch worker/alpha.\n' +
        'It runs in the pane %3 of the window workers.\n' +
        'If Claude Code asks to trust the folder, the owner answers once in the pane %3. Then run "factory worker watch --ready alpha".\n' +
        'Copied the assignment to .factory/workers/alpha/inbox/assignment.md.\n',
    );
    expect(withFile.json).toMatchObject({ assignment: ASSIGNMENT });
    const without = make(WITH_SOURCE);
    const plain = await succeeded(without);
    expect(plain.json).toMatchObject({ assignment: null });
    expect(without.deps.files.has(ASSIGNMENT)).toBe(false);
  });

  it('TP-33: the flag --assignment reaches the command through the command line', async () => {
    const made = make(WITH_SOURCE);
    const sink = captureSink();
    const code = await runCli(
      ['worker', 'new', 'alpha', '--project', 'web', '--home', HOME, '--yes', '--assignment', SOURCE, '--json'],
      made.deps,
      sink,
    );
    expect(code).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toMatchObject({ assignment: ASSIGNMENT });
    expect(made.deps.files.get(ASSIGNMENT)).toBe(TASK);
  });

  it.each([
    ['a file outside both tops', '/w/other/task.md', 4],
    ['a path with a dot part', `${TREE}/.secret/task.md`, 4],
    ['the local config of the factory folder', '/w/node/factory.local.yaml', 4],
    ['a file that does not exist', `${TREE}/none.md`, 2],
  ])('TP-32: refuses %s before any write', async (_name, path, code) => {
    const made = make({ tree: TREE, seed: { '/w/other/task.md': TASK, [`${TREE}/.secret/task.md`]: TASK } });
    const error = await failed(made, { assignment: path });
    expect(exitCodeOf[error.kind], error.message).toBe(code);
    expectNothingChanged(made);
  });

  it('TP-32: runs the source check before the question for the consent', async () => {
    const made = make({ tree: TREE, tty: true, prompt: () => ok('y'), seed: { '/w/other/task.md': TASK, [TREE]: null } });
    const error = await failed(made, { assignment: '/w/other/task.md', yes: false });
    expect(exitCodeOf[error.kind], error.message).toBe(4);
    expect(made.events).not.toContain('prompt');
    expectNothingChanged(made);
  });

  it('TP-34: a copy that fails is exit 1, keeps the worker, does not launch it, and names the copy by hand and then worker resume', async () => {
    const made = make({ ...WITH_SOURCE, failWrite: `${ASSIGNMENT}.tmp-4242-0` });
    const error = await failed(made, { assignment: SOURCE });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('disk full');
    expect(error.hint).toContain(`Copy the assignment file by hand to ${ASSIGNMENT}.`);
    expect(error.hint).toContain(`To start the worker, run ${RESUME}.`);
    expect((error.hint ?? '').indexOf('Copy the assignment file by hand')).toBeLessThan((error.hint ?? '').indexOf(RESUME));
    expectKeptCopyHint(error);
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.dirs.has(COPY)).toBe(true);
    expect(made.deps.files.has(ASSIGNMENT)).toBe(false);
    expect(indexOf(made, 'tmux split-window')).toBe(-1);
    expect(indexOf(made, `writeTextExclusive ${EXCLUDE}.tmp-`)).toBe(-1);
  });
});

describe('worker new: the root checks come first (TP-130)', () => {
  it('stops with exit 4 for a failing root check, and changes nothing', async () => {
    const made = make({ origin: 'own', tracked: ['factory.local.yaml'] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('factory.local.yaml');
    expect(error.hint).toContain('git rm --cached');
    expect(made.tmux.calls).toEqual([]);
    expectNothingChanged(made);
  });

  it('prints a root warning and goes on', async () => {
    const all = ['factory.local.yaml', '.factory/node.json', 'coordinator/CLAUDE.md', 'work-copies/probe', 'web/CLAUDE.md'];
    const made = make({ ignored: all.filter((path) => path !== 'coordinator/CLAUDE.md') });
    await succeeded(made);
    expect(made.deps.warned.join(' ')).toContain('coordinator/');
    expect(made.deps.files.has(RECORD)).toBe(true);
  });

  it('stops with exit 4 for an edited safety block, before any change', async () => {
    const edited = claudeFileText(sampleConfig()).replace('Never skip permissions', 'Skip permissions');
    expect(edited).not.toBe(claudeFileText(sampleConfig()));
    const made = make({ claudeFile: edited });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toBe('the block safety in coordinator/CLAUDE.md was edited');
    expect(error.hint).toBe('Run "factory upgrade --overwrite safety" to replace the text. It keeps the old text in a backup file.');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a missing safety block', async () => {
    const made = make({ claudeFile: false });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toBe('the block safety is missing in coordinator/CLAUDE.md');
    expectNothingChanged(made);
  });

  it('does not render a safety block that is out of date, and warns that the next start renders it', async () => {
    const made = make({ claudeFile: olderClaudeFile() });
    await succeeded(made);
    expect(made.deps.files.get('/w/node/coordinator/CLAUDE.md')).toBe(olderClaudeFile());
    expect(made.deps.warned.join(' ')).not.toContain('Rendered the block');
    expect(made.deps.warned).toContain(OUT_OF_DATE_NOTE);
  });

  it('stops for a missing program before any change, and names the check command', async () => {
    const made = make({ tools: ['tmux'] });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('claude is not on PATH');
    expect(error.hint).toContain('factory doctor');
    expectNothingChanged(made);
  });

  it('warns about an instruction file above the factory folder, as start does', async () => {
    const made = make({ seed: { '/w/CLAUDE.md': 'rules\n' } });
    await succeeded(made);
    expect(made.deps.warned.join(' ')).toContain('CLAUDE.md');
  });
});

describe('worker new: the tmux session of the factory', () => {
  it('exits 3 and names factory start when no session of the node runs', async () => {
    const made = make({ tmux: { sessions: {} } });
    const error = await failed(made);
    expect(error.kind).toBe('not-ready');
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('demo');
    expect(error.hint).toContain('"factory start"');
    expectNothingChanged(made);
  });

  it('exits 4 for a session of that name that belongs to another factory folder', async () => {
    const made = make({ tmux: { sessions: { demo: '/w/other' } } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('belongs to another factory folder');
    expectNothingChanged(made);
  });
});

describe('worker new: the command line', () => {
  const usage = async (change: Partial<WorkerOptions>): Promise<CliError> => {
    const made = make();
    const error = await failed(made, change);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(made.deps.calls).toEqual([]);
    return error;
  };

  it('needs a subcommand, and names the subcommands', async () => {
    const error = await usage({ words: [] });
    expect(error.message).toContain('needs a subcommand: new');
    expect(error.hint).toContain('factory worker --help');
  });

  it('refuses a subcommand that it does not know', async () => {
    expect((await usage({ words: ['fly'] })).message).toContain('unknown subcommand "fly"');
  });

  it.each([[[] as string[]], [['alpha', 'beta']]])('needs exactly one id: %j', async (args) => {
    expect((await usage({ words: ['new', ...args] })).message).toContain('takes one argument');
  });

  it('needs the project flag', async () => {
    const error = await usage({ project: undefined });
    expect(error.message).toContain('--project');
  });
});

describe('worker new: the checks before any write (TP-6, TP-7, TP-8)', () => {
  it('exits 2 for a project that the config does not list (TP-6), names the listed projects, and changes nothing', async () => {
    const made = make();
    const error = await failed(made, { project: 'nope' });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('"nope" is not listed');
    expect(error.hint).toContain('web');
    expect(error.hint).toContain('factory worker new');
    expectNothingChanged(made);
  });

  it.each([['Alpha'], ['a b'], ['-a'], ['x'.repeat(41)]])('exits 2 for the id %j, which is not a slug', async (id) => {
    const made = make();
    const error = await failed(made, { words: ['new', id] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('is not a slug');
    expectNothingChanged(made);
  });

  it('exits 2 for the id of the node (TP-7), and changes nothing', async () => {
    const made = make();
    const error = await failed(made, { words: ['new', 'demo'] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('the id of this node');
    expectNothingChanged(made);
  });

  it('exits 2 for the id of a child (AC-2), names a remedy, and changes nothing', async () => {
    const config = sampleConfig();
    const made = make({
      config: {
        ...config,
        core: {
          ...config.core,
          node: { ...config.core.node, layer: 2 },
          children: [{ id: 'alpha', address: 'file:///w/alpha-factory' }],
        },
      },
    });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe('the id alpha is the id of a child of this node');
    expect(error.hint).toContain('factory worker new');
    expectNothingChanged(made);
  });

  it('exits 2 for an id that has a record (TP-7), and changes nothing more', async () => {
    const made = make();
    await succeeded(made);
    const before = { files: new Map(made.deps.files), dirs: new Set(made.deps.dirs), splits: made.events.filter((e) => e === 'tmux split-window').length };
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('has a record already');
    expect(error.hint).toContain('factory worker new');
    expect(new Map(made.deps.files)).toEqual(before.files);
    expect(new Set(made.deps.dirs)).toEqual(before.dirs);
    expect(made.events.filter((e) => e === 'git worktree-add')).toHaveLength(1);
    expect(made.events.filter((e) => e === 'tmux split-window')).toHaveLength(before.splits);
  });

  it('exits 2 for an id whose work copy folder exists (TP-7)', async () => {
    const made = make({ seed: { [COPY]: null } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('work-copies/web/alpha exists already');
    expectNothingChanged(made);
  });

  it('exits 2 for an id whose branch exists in the clone (TP-7)', async () => {
    const made = make({ branches: [BRANCH] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(`the branch ${BRANCH} exists already in the project web`);
    expectNothingChanged(made);
  });

  it('exits 2 for an id whose record is not valid, and does not write over it', async () => {
    const made = make({ seed: { [RECORD]: '{"broken"' } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('record that is not valid');
    expect(made.deps.files.get(RECORD)).toBe('{"broken"');
    expectNothingChanged(made);
  });

  it.each([
    ['work-copies is a link', { links: { [COPIES]: '/elsewhere' } }, 'work-copies is a link'],
    ['work-copies/web is a link', { seed: { [COPIES]: null }, links: { [PROJECT_COPIES]: '/elsewhere' } }, 'work-copies/web is a link'],
    ['work-copies is a file', { seed: { [COPIES]: 'text' } }, 'work-copies is not a folder'],
    ['work-copies/web is a file', { seed: { [PROJECT_COPIES]: 'text' } }, 'work-copies/web is not a folder'],
  ] as const)('exits 4 when %s (TP-8), and changes nothing', async (_name, setup, message) => {
    const made = make(setup);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(message);
    expect(error.hint).toContain('factory');
    expectNothingChanged(made);
  });

  it('exits 4 for a project clone that is a link, and for a record folder that is a link', async () => {
    for (const links of [{ [CLONE]: '/elsewhere' }, { '/w/node/.factory/workers/alpha': '/elsewhere' }]) {
      const made = make({ links, seed: { '/w/node/.factory/workers': null } });
      const error = await failed(made);
      expect(exitCodeOf[error.kind]).toBe(4);
      expectNothingChanged(made);
    }
  });

  it('fails for a project folder that is not the top of a git work tree, before any change', async () => {
    const made = make({ notRepo: true });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('the clone of the project web');
    expect(error.message).toContain('is not a git work tree');
    expect(error.hint).toContain('factory worker new');
    expectNothingChanged(made);
  });
});

describe('worker new: the consent for the hook settings (TP-12, TP-13)', () => {
  const NO_TERMINAL = { tty: false } as const;

  it('writes nothing and exits 2 with no terminal window and no yes flag (TP-12), and shows the change', async () => {
    const made = make(NO_TERMINAL);
    const error = await failed(made, { yes: false });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(`This changes the settings of Claude Code in ${SETTINGS_FILE}`);
    expect(error.hint).toBe('Run "factory worker new" in a terminal window, or add --yes.');
    expectNothingChanged(made);
  });

  it('writes only the settings file in the work copy with the yes flag (TP-12)', async () => {
    const made = make(NO_TERMINAL);
    await succeeded(made, { yes: true });
    expect([...made.deps.files.keys()].filter((path) => path.startsWith(`${COPY}/`))).toEqual([SETTINGS_FILE]);
    expect(JSON.parse(made.deps.files.get(SETTINGS_FILE) ?? '')).toEqual(JSON.parse(JSON.stringify(ownSettingsEntries)));
  });

  it('asks on a terminal window with no yes flag, after the work copy and the record exist, and writes on a yes', async () => {
    const asked: string[] = [];
    const made = make({
      tty: true,
      prompt: (question) => {
        asked.push(question);
        return ok('y');
      },
    });
    await succeeded(made, { yes: false });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`This changes the settings of Claude Code in ${SETTINGS_FILE}`);
    expect(asked[0]).toContain('Write this change? [y/N]');
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
    const order = [indexOf(made, 'git worktree-add'), indexOf(made, `writeTextExclusive ${RECORD}`), indexOf(made, 'prompt'), indexOf(made, 'tmux split-window')];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('fails closed after a no: the launch stops with exit 3 before any pane, names the lost role text, and keeps the work copy and the record', async () => {
    const made = make({ tty: true, prompt: () => ok('n') });
    const error = await failed(made, { yes: false });
    expect(made.deps.files.has(SETTINGS_FILE)).toBe(false);
    const warned = made.deps.warned.join('\n');
    expect(warned).toContain('last-seen record of the worker');
    expect(warned).toContain('gets no role text');
    expect(warned).toContain('dismiss the worker with "factory dismiss ID"');
    expect(warned).toContain('run "factory worker new" again for a new worker and answer yes');
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('lack the events');
    expect(error.hint?.split('\n')).toEqual(
      expect.arrayContaining(['factory upgrade', 'factory worker resume alpha', 'factory dismiss alpha', 'factory worker new alpha --project web']),
    );
    expect(made.events).not.toContain('tmux split-window');
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.dirs.has(COPY)).toBe(true);
  });

  it('counts the yes flag inside a factory session for a work copy that has no settings file (TP-13)', async () => {
    const made = make({ ...NO_TERMINAL, env: { FACTORY_SESSION: 'demo' } });
    await succeeded(made, { yes: true });
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
  });

  it('exits 2 inside a factory session with no yes flag and no terminal, before any write, and offers the yes flag that counts', async () => {
    const made = make({ ...NO_TERMINAL, env: { FACTORY_SESSION: 'demo' } });
    const error = await failed(made, { yes: false });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toBe('Run "factory worker new" in a terminal window, or add --yes.');
    expectNothingChanged(made);
  });

  it('exits 2 inside a factory session for a work copy that the checkout gives a settings file (TP-13), before the work copy exists', async () => {
    const made = make({ ...NO_TERMINAL, env: { FACTORY_SESSION: 'demo' }, checkout: '{"permissions":{"allow":["Read"]}}\n' });
    const error = await failed(made, { yes: true });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain('--yes gives no consent inside a factory session');
    expectNothingChanged(made);
  });

  it('keeps the other keys of a settings file that the checkout gave, and adds the own entries', async () => {
    const made = make({ tty: true, prompt: () => ok('y'), checkout: '{"permissions":{"allow":["Read"]}}\n' });
    await succeeded(made, { yes: false });
    const written = JSON.parse(made.deps.files.get(SETTINGS_FILE) ?? '') as Record<string, unknown>;
    expect(written['permissions']).toEqual({ allow: ['Read'] });
    expect(written['hooks']).toEqual(JSON.parse(JSON.stringify(ownSettingsEntries)).hooks);
  });

  it('asks nothing and writes nothing to the settings file when the checkout gave the own entries already', async () => {
    const made = make({ tty: true, prompt: () => ok('y'), checkout: OWN_SETTINGS });
    await succeeded(made, { yes: false });
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
    expect(made.events.filter((event) => event.includes(`${SETTINGS_FILE}.tmp-`))).toEqual([]);
    expect(made.events).not.toContain('prompt');
  });

});

describe('worker new: the settings that the clone tracks stop the command before the work copy exists', () => {
  const SKIP = '{"permissions":{"defaultMode":"bypassPermissions"}}\n';

  it('stops with exit 4 for a tracked settings file that skips the permission checks, and makes no work copy, record or branch', async () => {
    const made = make({ checkout: SKIP, tty: true, prompt: () => ok('y') });
    const error = await failed(made, { yes: false });
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.local.json');
    expectNothingChanged(made);
  });

  it('checks every tracked settings file, not only the local one', async () => {
    const made = make({ head: [{ path: '.claude/settings.json', text: SKIP }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.json');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a tracked .claude that is a link, and makes no work copy, record or branch', async () => {
    const made = make({ head: [{ path: '.claude', mode: LINK_MODE, text: '../elsewhere' }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude is a link');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a tracked .claude that is a file, and makes no work copy', async () => {
    const made = make({ head: [{ path: '.claude', text: 'not a folder\n' }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude is not a folder');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a tracked settings file that is a link', async () => {
    const made = make({ head: [{ path: '.claude/settings.local.json', mode: LINK_MODE, text: '../../elsewhere.json' }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('settings.local.json (a link)');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a tracked settings file that is larger than the check reads, and does not read it', async () => {
    const made = make({ head: [{ path: '.claude/settings.json', text: ' '.repeat(maxFileBytes + 1) }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.json (cannot be read)');
    expect(made.deps.calls.filter((call) => call.command === 'git' && call.args[2] === 'cat-file')).toEqual([]);
    // No diff of the file maps here: a failing run would print the large file.
    expect(made.events).not.toContain('git worktree-add');
    expect(made.deps.dirs.has(COPY)).toBe(false);
    expect(made.deps.files.has(RECORD)).toBe(false);
  });

  it('stops with exit 4 for a settings folder with more settings files than the check reads', async () => {
    const head = Array.from({ length: 65 }, (_, index) => ({ path: `.claude/settings${index}.json`, text: '{}\n' }));
    const made = make({ head });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('holds more than 64 settings files');
    expectNothingChanged(made);
  });

  it('exits 1 for a tracked settings file that is not a JSON object, before the work copy exists', async () => {
    const made = make({ checkout: 'not json\n' });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('is not a JSON object');
    expectNothingChanged(made);
  });

  it('fails when git can not read the last commit of the clone, and makes no work copy', async () => {
    const made = make({ headFails: true });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('cannot read');
    expectNothingChanged(made);
  });

  it('goes on for a tracked settings file with no finding, and the launch reads the file in the work copy', async () => {
    const made = make({ head: [{ path: '.claude/settings.json', text: '{"permissions":{"allow":["Read"]}}\n' }] });
    const output = await succeeded(made);
    expect(output.json).toMatchObject({ pane: FIRST_NEW_PANE });
    expect(made.deps.files.get('/w/node/work-copies/web/alpha/.claude/settings.json')).toBe('{"permissions":{"allow":["Read"]}}\n');
  });
});

describe('worker new: the role text of the new worker stops the command before the work copy exists', () => {
  const HOOKS_OFF = '{"disableAllHooks":true}\n';

  it('stops with exit 4 for a tracked local settings file that turns off every hook, and makes no work copy, record or branch', async () => {
    const made = make({ checkout: HOOKS_OFF });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.local.json');
    expect(error.message).toContain('turns off every hook');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a tracked project settings file that turns off every hook, and makes no work copy, record or branch', async () => {
    const made = make({ head: [{ path: '.claude/settings.json', text: HOOKS_OFF }] });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.json');
    expect(error.message).toContain('turns off every hook');
    expectNothingChanged(made);
  });

  it('stops with exit 4 for a setup text that the owner did not accept, and makes no work copy, record or branch', async () => {
    const made = make();
    seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toBe(roleText.reasons.notAccepted);
    expect(error.hint).toContain('"factory worker new alpha --project web"');
    expect(new Map(made.deps.files).has(RECORD)).toBe(false);
    expect(made.events).not.toContain('git worktree-add');
    expect(made.events).not.toContain('tmux split-window');
    expect(made.deps.dirs.has(COPY)).toBe(false);
  });

  it('stops with exit 1 for a text above the cap, names its size and the cap, and makes no work copy, record or branch', async () => {
    const made = make();
    seedAcceptedSetup(made.deps, HOME, `${'x'.repeat(roleText.maxChars - 500)}\n`);
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toMatch(/^the role text has \d+ characters, and the cap is 9000 characters$/);
    expect(made.deps.files.has(RECORD)).toBe(false);
    expect(made.events).not.toContain('git worktree-add');
    expect(made.deps.dirs.has(COPY)).toBe(false);
  });

  it('stops with exit 1 for a setup text that holds a block marker, and makes no work copy, record or branch', async () => {
    const made = make();
    seedAcceptedSetup(made.deps, HOME, '<!-- factory:begin worker v1 sha256=00 -->\n');
    expect(exitCodeOf[(await failed(made)).kind]).toBe(1);
    expect(made.events).not.toContain('git worktree-add');
    expect(made.deps.files.has(RECORD)).toBe(false);
  });

  it('asks no question about the hook settings and writes nothing for a refused role text', async () => {
    const asked: string[] = [];
    const made = make({
      tty: true,
      prompt: (question) => {
        asked.push(question);
        return ok('y');
      },
    });
    seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
    await failed(made, { yes: false });
    expect(asked).toEqual([]);
    expect(made.deps.files.has(SETTINGS_FILE)).toBe(false);
  });

  it('prints no text of the setup file', async () => {
    const made = make();
    seedUnacceptedSetup(made.deps, HOME, 'SECRET-LINE\n');
    expect(JSON.stringify(await failed(made))).not.toContain('SECRET-LINE');
  });

  it('starts the worker for the setup text that the owner accepted', async () => {
    const made = make();
    seedAcceptedSetup(made.deps, HOME, 'Write tests first.\n');
    await succeeded(made);
    expect(made.events).toContain('tmux split-window');
  });
});

describe('worker new: the exclude entry of the clone (TP-14)', () => {
  it('keeps every line of the exclude file and adds the entry once', async () => {
    const made = make();
    await succeeded(made);
    expect(made.deps.files.get(EXCLUDE)).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('writes nothing to the exclude file when it has the entry, also for a second worker', async () => {
    const made = make({ seed: { [EXCLUDE]: `${TEMPLATE}${ENTRY}\n` } });
    await succeeded(made);
    expect(made.events.filter((event) => event.includes(EXCLUDE))).toEqual([]);
    expect(made.deps.files.get(EXCLUDE)).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('writes the exclude file for the first worker of a clone only: the second worker finds the entry', async () => {
    const made = make();
    await succeeded(made);
    await succeeded(made, { words: ['new', 'beta'] });
    expect(made.events.filter((event) => event.startsWith(`writeTextExclusive ${EXCLUDE}.tmp-`))).toHaveLength(1);
  });

  it('stops with exit 4 and keeps the copy and the record for an exclude file that is a link, and the remedy names factory dismiss (TP-136)', async () => {
    const made = make({ links: { [EXCLUDE]: '/elsewhere/exclude' }, seed: { '/elsewhere/exclude': TEMPLATE } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expectKeptCopyHint(error);
    expect(error.hint).toContain(`To start the worker, run ${RESUME}. That command does not make the exclude entry or the hook settings again.`);
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.dirs.has(COPY)).toBe(true);
    expect(made.deps.files.has(SETTINGS_FILE)).toBe(false);
    expect(made.events).not.toContain('tmux split-window');
  });
});

describe('worker new: the machine warning (TP-21)', () => {
  it('prints nothing about the machine when every limit holds', async () => {
    const made = make();
    await succeeded(made);
    expect(made.deps.warned.filter((line) => line.startsWith('machine '))).toEqual([]);
  });

  it('warns for a failed limit, goes on, and warns before the pane starts', async () => {
    const made = make({ machine: { memory: 'System-wide memory free percentage: 5%\n' } });
    const output = await succeeded(made);
    expect(made.deps.warned).toContain('machine memory: 5% free, at least 20% needed');
    expect(output.failed).toBe(false);
    expect(indexOf(made, 'warn: machine memory')).toBeGreaterThanOrEqual(0);
    expect(indexOf(made, 'tmux split-window')).toBeGreaterThan(indexOf(made, 'warn: machine memory'));
    expect(made.deps.files.has(RECORD)).toBe(true);
  });

  it('warns for each fact that it can not read, and goes on', async () => {
    const made = make({ machine: { memory: null, disk: null, load: null, cpus: null } });
    await succeeded(made);
    const lines = made.deps.warned.filter((line) => line.startsWith('machine '));
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.includes('unknown'))).toBe(true);
    expect(made.events).toContain('tmux split-window');
  });

  it('checks the machine after the record, the exclude entry and the settings file, and before the pane', async () => {
    const made = make({ machine: { memory: 'System-wide memory free percentage: 5%\n' } });
    await succeeded(made);
    const order = [
      indexOf(made, `writeTextExclusive ${RECORD}`),
      indexOf(made, `writeTextExclusive ${EXCLUDE}.tmp-`),
      indexOf(made, `writeTextExclusive ${SETTINGS_FILE}.tmp-`),
      indexOf(made, 'machine memory_pressure'),
      indexOf(made, 'warn: machine memory'),
      indexOf(made, 'tmux split-window'),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('worker new: a failure after the work copy exists', () => {
  it('keeps the copy and the record when the pane does not start, and names the steps that remove the worker by hand', async () => {
    const made = make({ tmux: { failing: 'split-window' } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expectKeptCopyHint(error);
    expect(error.hint).not.toContain('does not make the exclude entry');
    expect(made.deps.dirs.has(COPY)).toBe(true);
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
    expect(made.deps.files.get(EXCLUDE)).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('fails when the new pane ends after the start, and names the steps that remove the worker by hand', async () => {
    const made = make({ program: atWait(1, endsPane) });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} of the worker alpha is gone`);
    expectKeptCopyHint(error);
    expect(error.hint).toContain(RESUME);
    expect(made.deps.dirs.has(COPY)).toBe(true);
    expect(made.deps.files.has(RECORD)).toBe(true);
  });

  it('fails when the program of the new pane ended at once and tmux keeps the pane', async () => {
    const made = make({ tmux: { newPanesEndAtOnce: true } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} of the worker alpha ended`);
    expectKeptCopyHint(error);
  });

  it('checks the new pane once, after one wait, and then reports the worker', async () => {
    const made = make();
    const output = await succeeded(made);
    expect(plainText(output)).toContain(`It runs in the pane ${FIRST_NEW_PANE}`);
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs]);
  });

  it('undoes nothing: it runs no remove call and no git call besides the first one', async () => {
    const made = make({ tmux: { failing: 'split-window' } });
    await failed(made);
    expect(made.events.filter((event) => event.startsWith('remove ') && !event.endsWith('.lock'))).toEqual([]);
    expect(made.deps.calls.filter((call) => call.command === 'git' && call.args[2] === 'worktree')).toHaveLength(1);
  });

  it('names the resume command and the steps that remove the worker by hand when the proxy does not answer', async () => {
    const config = sampleConfig();
    const made = make({
      config: {
        ...config,
        core: {
          ...config.core,
          proxies: [{ id: 'local', base_url: PROXY_URL, health: '/health', on_fail: 'stop' }],
          session: { ...config.core.session, proxy: 'local' },
        },
      },
      fetch: () => failure('no answer'),
    });
    const error = await failed(made);
    expect(error.message).toContain('does not answer');
    expect(error.hint).toContain(RESUME);
    expectKeptCopyHint(error);
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(JSON.stringify(error)).not.toContain('secret-path');
  });

  it('puts a path with a brace and a comma in quotes in the steps that remove the worker by hand', async () => {
    const config = sampleConfig();
    const made = make({ tmux: { failing: 'split-window' }, config: { ...config, recipe: { ...config.recipe, projects: [{ ...config.recipe.projects[0]!, path: 'we{b,c}' }] } } });
    made.deps.seedDir('/w/node/we{b,c}');
    made.deps.seedDir('/w/node/we{b,c}/.git');
    const error = await failed(made);
    expect(error.hint).toContain("git -C '/w/node/we{b,c}' worktree remove");
  });

  it('fails before it writes anything when git can not make the work copy, and says what git can keep and how to remove it', async () => {
    const made = make({ worktreeExit: 128 });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('cannot make the work copy');
    expect(error.hint).toContain(`Git can keep the branch ${BRANCH} and the folder ${COPY} after a failure.`);
    expect(error.hint).toContain(`"${REMOVE_COPY}"`);
    expect(error.hint).toContain(`"${DELETE_BRANCH}"`);
    expect(error.hint).toContain('"factory worker new alpha --project web" again');
    expectNothingChanged({ ...made, events: made.events.filter((event) => event !== 'git worktree-add') });
  });

  it('names the git commands that remove the copy and the branch when the record can not be written', async () => {
    const made = make({ failWrite: RECORD });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.hint).toContain(`The work copy ${COPY} and the branch ${BRANCH} stay, and the worker has no record.`);
    expect(error.hint).toContain(`"${REMOVE_COPY}"`);
    expect(error.hint).toContain(`"${DELETE_BRANCH}"`);
    expect(error.hint).toContain('"factory worker new alpha --project web" again');
    expect(error.hint).not.toContain('dismiss');
    expect(made.deps.files.has(RECORD)).toBe(false);
    expect(made.events).not.toContain('tmux split-window');
  });

  it('says that the record stays when only the inbox folder can not be made, and names the steps that remove the worker by hand', async () => {
    const made = make({ seed: { [INBOX]: 'in the way\n' } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(`cannot write in ${INBOX}`);
    expectKeptCopyHint(error);
    expect(error.hint).not.toContain('has no record');
    expect(error.hint).not.toContain('does not make the exclude entry');
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.events).not.toContain('tmux split-window');
  });
});

const ALPHA_PANE = '%3';
const ALPHA_PID = 4777;
/** The id of a pane that a resume makes while the fixture holds the pane %3: the three panes that start with the session take %4 to %6. */
const NEW_PANE = '%7';
/** The coordinator pane of the session in that fixture. */
const COORDINATOR_PANE = '%4';
const ALPHA_SESSION = 'a3f1c2d4-1b2c-4d5e-8f90-123456789abc';
const BETA_SESSION = 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd';
const COORDINATOR_SESSION = '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const SEEN_AT = '2030-01-02T03:04:05.678Z';

/** The pane of alpha: the launch of alpha made it, so its start command is the launch words. */
const alphaPane = (change: Partial<PaneFixture> = {}): PaneFixture => ({
  id: ALPHA_PANE,
  session: 'demo',
  options: { '@worker': 'alpha' },
  pid: ALPHA_PID,
  command: launchWordsOf(HOME, 'alpha'),
  ...change,
});

/** One last-seen line in the heartbeat folder. */
interface SeedLine {
  readonly session: string;
  /** The last hook event. Null: the line holds only a context percent. Default: Stop. */
  readonly event?: HookEvent | null;
  /** The session marker of the line. Null: the line has none. Default: alpha. */
  readonly marker?: string | null;
  /** The time of the event. Default: `SEEN_AT`, which is the time of the fake clock at the start of a run. */
  readonly at?: string;
}

interface Seeded {
  /** False: the worker alpha has no record. */
  readonly record?: boolean;
  /** The session that the pointer of alpha names. Null: alpha has no pointer. Default: the session of alpha. */
  readonly pointer?: string | null;
  /** The session that the pointer of the worker beta names. Default: beta has no pointer. */
  readonly betaPointer?: string;
  /** The lines of the heartbeat folder. Default: one idle line of the session of alpha, with the marker alpha. */
  readonly lines?: readonly SeedLine[];
}

const lineText = (line: SeedLine): string => {
  const event = line.event === undefined ? 'Stop' : line.event;
  const marker = line.marker === undefined ? 'alpha' : line.marker;
  return `${JSON.stringify({
    schema: schemaIds.lastSeen,
    session_id: line.session,
    event,
    event_at: event === null ? null : (line.at ?? SEEN_AT),
    context_pct: event === null ? 40 : null,
    pct_at: event === null ? SEEN_AT : null,
    ...(marker === null ? {} : { session_marker: marker }),
  })}\n`;
};

/**
 * The made fake, with the records of the workers alpha (unless the setup says no) and beta, the work copy of alpha with its
 * settings file, and the pointers and lines of the setup. The files and the events of the setup do not count as changes.
 * The program of a pane that resumes a session starts that session, unless the setup gives another program.
 */
const withWorkers = async (setup: Setup = {}, change: Seeded = {}): Promise<Made> => {
  const made = make({ program: startsSession(HOME, 'alpha'), ...setup });
  const { deps } = made;
  const must = (result: { readonly ok: boolean; readonly error?: { readonly message: string } }): void => {
    if (!result.ok) throw new Error(result.error?.message ?? 'the seed failed');
  };
  for (const id of change.record === false ? ['beta'] : ['alpha', 'beta']) {
    must(await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy: `${PROJECT_COPIES}/${id}`, branch: `worker/${id}` }));
  }
  deps.seedDir(COPY);
  deps.seed(SETTINGS_FILE, OWN_SETTINGS);
  const pointer = change.pointer === undefined ? ALPHA_SESSION : change.pointer;
  if (pointer !== null) must(await writeWorkerSession(deps, HOME, 'alpha', pointer));
  if (change.betaPointer !== undefined) must(await writeWorkerSession(deps, HOME, 'beta', change.betaPointer));
  for (const line of change.lines ?? [{ session: ALPHA_SESSION }]) {
    deps.seed(`${layoutOf(HOME).heartbeatDir}/${line.session}`, lineText(line));
  }
  made.events.splice(0);
  return { ...made, files: new Map(deps.files), dirs: new Set(deps.dirs) };
};

const stopOf = (made: Made) => run(made, { words: ['stop', 'alpha'] });
const resumeOf = (made: Made) => run(made, { words: ['resume', 'alpha'] });

const stopped = async (made: Made) => {
  const result = await stopOf(made);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const stopFailed = async (made: Made): Promise<CliError> => {
  const result = await stopOf(made);
  if (result.ok) throw new Error('the stop should have failed');
  return result.error;
};

const resumed = async (made: Made) => {
  const result = await resumeOf(made);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const resumeFailed = async (made: Made): Promise<CliError> => {
  const result = await resumeOf(made);
  if (result.ok) throw new Error('the resume should have failed');
  return result.error;
};

const killed = (made: Made): string[] => made.tmux.commands().filter((command) => command.startsWith('kill-pane'));

/** The program words of the newest pane: the words after `--` in the call that made it. */
const launchWords = (made: Made): readonly string[] => made.tmux.panes().at(-1)?.command ?? [];

const SESSION_STATES: readonly (readonly [HookEvent, string])[] = [
  ['Stop', 'idle'],
  ['UserPromptSubmit', 'busy'],
];

describe('worker stop: the stop of one worker (TP-26)', () => {
  for (const [event, state] of SESSION_STATES) {
    it(`sends TERM to the process of the pane for a session that is ${state}, then closes the pane`, async () => {
      const made = await withWorkers({ tmux: { panes: [alphaPane()] } }, { lines: [{ session: ALPHA_SESSION, event }] });
      const output = await stopped(made);
      expect(made.deps.terminated).toEqual([ALPHA_PID]);
      expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
      expect(output.failed).toBe(false);
      expect(output.json).toEqual({
        schema: schemaIds.workerStop,
        id: 'alpha',
        outcome: 'stopped',
        pane: ALPHA_PANE,
        pid: ALPHA_PID,
        way: 'kill -TERM',
        state,
      });
    });
  }

  it('sends TERM before it closes the pane, and writes no file', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } });
    await stopped(made);
    expect(new Map(made.deps.files)).toEqual(made.files);
    expect(made.deps.terminated).toEqual([ALPHA_PID]);
    expect(indexOf(made, 'tmux kill-pane')).toBeGreaterThan(indexOf(made, 'tmux display-message'));
  });

  it('says in a short output what it ended', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } });
    const text = plainText(await stopped(made));
    expect(text).toContain('Stopped the worker alpha.');
    expect(text).toContain(`${ALPHA_PID}`);
    expect(text).toContain(ALPHA_PANE);
    expectShortOutput(text);
  });

  it('says that a worker with no pane has nothing to stop, and sends and changes nothing', async () => {
    const made = await withWorkers();
    const output = await stopped(made);
    expect(plainText(output)).toContain('has no pane');
    expect(output.json).toEqual({ schema: schemaIds.workerStop, id: 'alpha', outcome: 'no-pane' });
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('says the same when no tmux session of the node runs', async () => {
    const made = await withWorkers({ tmux: { sessions: {} } });
    expect((await stopped(made)).json).toEqual({ schema: schemaIds.workerStop, id: 'alpha', outcome: 'no-pane' });
    expect(made.deps.terminated).toEqual([]);
  });

  it('closes a pane whose program ended already, and sends no signal', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane({ dead: true })] } });
    const output = await stopped(made);
    expect(output.json).toEqual({ schema: schemaIds.workerStop, id: 'alpha', outcome: 'closed-dead', panes: [ALPHA_PANE] });
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
  });

  it('exits 2 for a worker that has no record, and sends nothing', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } }, { record: false });
    const error = await stopFailed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('alpha');
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it.each([[[] as string[]], [['alpha', 'beta']]])('needs exactly one id: %j', async (args) => {
    const made = await withWorkers();
    const error = await failed(made, { words: ['stop', ...args] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('takes one argument');
    expect(made.tmux.calls).toEqual([]);
  });

  it('refuses to end the pane that it runs in (exit 2), and sends nothing', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] }, env: { TMUX_PANE: ALPHA_PANE } });
    const error = await stopFailed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('own pane');
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('stops a worker from another pane of the same session', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] }, env: { TMUX_PANE: COORDINATOR_PANE } });
    await stopped(made);
    expect(made.deps.terminated).toEqual([ALPHA_PID]);
  });
});

describe('worker stop: a state that is not known is exit 3 (TP-28)', () => {
  it('exits 3 and names the pane and the process when the worker has no last-seen line', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } }, { pointer: null, lines: [] });
    const error = await stopFailed(made);
    expect(error.kind).toBe('not-ready');
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(ALPHA_PANE);
    expect(error.message).toContain(`${ALPHA_PID}`);
    expect(error.hint).toContain(`kill -TERM ${ALPHA_PID}`);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('exits 3 for a last-seen line with no event', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } }, { lines: [{ session: ALPHA_SESSION, event: null }] });
    expect(exitCodeOf[(await stopFailed(made)).kind]).toBe(3);
    expect(made.deps.terminated).toEqual([]);
  });

  it('exits 3 for a pointer that names the session of the coordinator', async () => {
    const made = await withWorkers(
      { tmux: { panes: [alphaPane()] } },
      { pointer: COORDINATOR_SESSION, lines: [{ session: COORDINATOR_SESSION, marker: 'demo' }] },
    );
    expect(exitCodeOf[(await stopFailed(made)).kind]).toBe(3);
    expect(made.deps.terminated).toEqual([]);
  });

  it('exits 3 for a pointer that names the session of another worker', async () => {
    const made = await withWorkers(
      { tmux: { panes: [alphaPane()] } },
      { pointer: BETA_SESSION, betaPointer: BETA_SESSION, lines: [{ session: BETA_SESSION, marker: 'beta' }] },
    );
    expect(exitCodeOf[(await stopFailed(made)).kind]).toBe(3);
    expect(made.deps.terminated).toEqual([]);
  });
});

describe('worker stop: a process that does not end is exit 1 (TP-29)', () => {
  it('names the process, sends no KILL, and keeps the pane', async () => {
    const made = await withWorkers(
      { tmux: { panes: [alphaPane()] }, termEndsAfterChecks: stopPoll.attempts + 10 },
    );
    const error = await stopFailed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(`${ALPHA_PID}`);
    expect(error.hint).toContain('never sends KILL');
    expect(made.deps.terminated).toEqual([ALPHA_PID]);
    expect(made.deps.sleeps).toHaveLength(stopPoll.attempts);
    expect(killed(made)).toEqual([]);
  });

  it('closes the pane when the process ends in the last check', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] }, termEndsAfterChecks: stopPoll.attempts - 1 });
    await stopped(made);
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
  });
});

describe('worker resume: the root checks and the session come first (TP-130)', () => {
  it('stops with exit 4 for a failing root check, and changes nothing', async () => {
    const made = await withWorkers({ origin: 'own', tracked: ['factory.local.yaml'] });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('factory.local.yaml');
    expect(made.tmux.calls).toEqual([]);
    expectNothingChanged(made);
  });

  it('checks the root before it looks for the record of the worker', async () => {
    const made = await withWorkers({ origin: 'own', tracked: ['factory.local.yaml'] }, { record: false });
    expect(exitCodeOf[(await resumeFailed(made)).kind]).toBe(4);
  });

  it('exits 3 and names factory start when no session of the node runs', async () => {
    const made = await withWorkers({ tmux: { sessions: {} } });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.hint).toContain('"factory start"');
    expect(error.hint).toContain('"factory worker resume alpha"');
    expectNothingChanged(made);
  });

  it('exits 2 for a worker that has no record, and starts nothing', async () => {
    const made = await withWorkers({}, { record: false });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('alpha');
    expectNothingChanged(made);
  });

  it.each([[[] as string[]], [['alpha', 'beta']]])('needs exactly one id: %j', async (args) => {
    const made = await withWorkers();
    const error = await failed(made, { words: ['resume', ...args] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('takes one argument');
    expect(made.tmux.calls).toEqual([]);
  });

  it('exits 2 for a worker that runs in a live pane, and starts nothing', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(`runs already in the pane ${ALPHA_PANE}`);
    expect(error.hint).toContain('"factory worker stop alpha"');
    expect(made.events).not.toContain('tmux split-window');
    expect(killed(made)).toEqual([]);
  });
});

describe('worker resume: the session of the worker (TP-30)', () => {
  it('starts the program with --resume and the session id of the last-seen line, in a marked pane', async () => {
    const made = await withWorkers();
    const output = await resumed(made);
    const words = launchWords(made);
    expect(words).toContain('--resume');
    expect(words[words.indexOf('--resume') + 1]).toBe(ALPHA_SESSION);
    expect(made.tmux.panes().at(-1)).toMatchObject({ id: FIRST_NEW_PANE, window: 'workers', cwd: COPY, options: { '@worker': 'alpha' } });
    expect(output.warnings).toEqual([]);
    expect(output.failed).toBe(false);
  });

  it('reports the resume in a short output and a JSON document', async () => {
    const made = await withWorkers();
    const output = await resumed(made);
    expect(plainText(output)).toContain('Resumed the worker alpha in the pane %3 of the window workers.');
    expectShortOutput(plainText(output));
    expect(output.json).toEqual({
      schema: schemaIds.workerResume,
      id: 'alpha',
      pane: FIRST_NEW_PANE,
      resumed: true,
      sessionId: ALPHA_SESSION,
      proxy: null,
    });
  });

  it('makes no work copy, no record and no file, besides the line that the hook of the new session writes', async () => {
    const made = await withWorkers();
    await resumed(made);
    const heartbeat = `${layoutOf(HOME).heartbeatDir}/`;
    const withoutLines = (files: ReadonlyMap<string, string>): Map<string, string> =>
      new Map([...files].filter(([path]) => !path.startsWith(heartbeat)));
    expect(withoutLines(made.deps.files)).toEqual(withoutLines(made.files));
    expect(made.events).not.toContain('git worktree-add');
  });

  it('removes an old pane of the worker whose program ended, by its id, before it starts the new pane', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane({ dead: true })] } });
    const output = await resumed(made);
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
    expect(indexOf(made, 'tmux kill-pane')).toBeLessThan(indexOf(made, 'tmux split-window'));
    expect(output.json).toMatchObject({ pane: NEW_PANE });
    expect(made.tmux.panes().filter((pane) => pane.options['@worker'] === 'alpha').map((pane) => pane.id)).toEqual([NEW_PANE]);
  });

  it('leaves the panes of another worker alone', async () => {
    const other = alphaPane({ id: '%9', options: { '@worker': 'beta' }, pid: 4888 });
    const made = await withWorkers({ tmux: { panes: [alphaPane({ dead: true }), other] } });
    await resumed(made);
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
    expect(made.tmux.panes().some((pane) => pane.id === '%9')).toBe(true);
  });

  it('brings the board back into the slot before it removes an old pane that a summon left there', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane({ dead: true })] } });
    // The board pane of the fixture is %5. A summon swapped it with the pane of alpha, whose program then ended in the slot.
    const board = '%5';
    await made.deps.run('tmux', ['swap-pane', '-s', ALPHA_PANE, '-t', board]);
    await made.deps.run('tmux', ['set-option', '-p', '-t', board, '@slot_summon', `${ALPHA_PANE}:${'ab'.repeat(16)}`]);
    made.events.splice(0);
    await resumed(made);
    const boardPane = made.tmux.panes().find((pane) => pane.id === board);
    expect(boardPane).toMatchObject({ window: 'view', options: { '@slot': 'board' } });
    expect(boardPane?.options['@slot_summon']).toBeUndefined();
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
    expect(indexOf(made, 'tmux swap-pane')).toBeLessThan(indexOf(made, 'tmux kill-pane'));
  });

  it('warns that a safety block that is out of date is not rendered by this command, and goes on', async () => {
    const made = await withWorkers({ claudeFile: olderClaudeFile() });
    const output = await resumed(made);
    expect(made.deps.warned).toContain(OUT_OF_DATE_NOTE);
    expect(made.deps.files.get('/w/node/coordinator/CLAUDE.md')).toBe(olderClaudeFile());
    expect(output.failed).toBe(false);
    expect(made.events).toContain('tmux split-window');
  });

  it('names the resume command when the proxy does not answer', async () => {
    const config = sampleConfig();
    const made = await withWorkers({
      config: {
        ...config,
        core: {
          ...config.core,
          proxies: [{ id: 'local', base_url: PROXY_URL, health: '/health', on_fail: 'stop' }],
          session: { ...config.core.session, proxy: 'local' },
        },
      },
      fetch: () => failure('no answer'),
    });
    const error = await resumeFailed(made);
    expect(error.message).toContain('does not answer');
    expect(error.hint).toContain('"factory worker resume alpha"');
    expect(made.events).not.toContain('tmux split-window');
  });
});

describe('worker resume: the command says Resumed only when the session wrote its SessionStart line (bounded wait)', () => {
  const POINTER_FILE = `${RECORD_DIR}/last-session`;
  const LINE_FILE = `${layoutOf(HOME).heartbeatDir}/${ALPHA_SESSION}`;
  /** A time after the start of the run: the fake clock starts at `SEEN_AT`. */
  const LATER = '2030-01-02T03:04:07.000Z';
  const EARLIER = '2030-01-02T03:04:04.000Z';

  /** The program writes this text as the line of the session at the first wait. */
  const writesLine = (text: string): Program =>
    atWait(1, ({ deps }) => {
      deps.seed(LINE_FILE, text);
    });

  /** The resume must stop as "not confirmed": exit 3, the pane stays, and the text never says Resumed. */
  const notConfirmed = async (made: Made): Promise<CliError> => {
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain('resume not confirmed');
    expect(error.message).toContain(FIRST_NEW_PANE);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('Resumed');
    expect(made.tmux.panes().some((pane) => pane.id === FIRST_NEW_PANE)).toBe(true);
    expect(killed(made)).toEqual([]);
    return error;
  };

  it('says Resumed at the wait where the line appears, and not before', async () => {
    const made = await withWorkers({ program: atWait(3, startsSession(HOME, 'alpha')) });
    const output = await resumed(made);
    expect(plainText(output)).toContain('Resumed the worker alpha');
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs, launchConfirm.intervalMs, launchConfirm.intervalMs]);
  });

  it('waits before the first check, so that the program has time to start', async () => {
    const made = await withWorkers();
    await resumed(made);
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs]);
  });

  it('says "resume not confirmed" with the pane id and a manual step, and no Resumed, when the line never appears', async () => {
    const made = await withWorkers({ program: () => undefined });
    const error = await notConfirmed(made);
    expect(error.message).toContain(`${(launchConfirm.attempts * launchConfirm.intervalMs) / 1000} seconds`);
    expect(error.hint).toContain('"factory worker summon alpha"');
    expect(error.hint).toContain('"factory worker stop alpha"');
    expect(error.hint).toContain(POINTER_FILE);
    expect(error.hint).toContain(RESUME);
    expect(error.hint).not.toContain('dismiss');
    expect(made.deps.sleeps).toHaveLength(launchConfirm.attempts);
  });

  it('keeps the old line when the pointer names a session that the program did not start again', async () => {
    const made = await withWorkers({ program: () => undefined });
    await notConfirmed(made);
    expect(made.deps.files.get(LINE_FILE)).toBe(lineText({ session: ALPHA_SESSION }));
  });

  it('counts a line that is not valid as not confirmed', async () => {
    const error = await notConfirmed(await withWorkers({ program: writesLine('not json\n') }));
    expect(error.message).toContain('not valid');
  });

  it('counts a line of another session marker as not confirmed, also with the right event and a later time', async () => {
    const other = lineText({ session: ALPHA_SESSION, event: 'SessionStart', marker: 'beta', at: LATER });
    const error = await notConfirmed(await withWorkers({ program: writesLine(other) }));
    expect(error.message).toContain('beta');
  });

  it('counts a line with no session marker as not confirmed', async () => {
    const bare = lineText({ session: ALPHA_SESSION, event: 'SessionStart', marker: null, at: LATER });
    await notConfirmed(await withWorkers({ program: writesLine(bare) }));
  });

  it.each([[EARLIER], [SEEN_AT]])('counts a SessionStart line of the time %s, which is not after the launch, as not confirmed', async (at) => {
    const made = await withWorkers({ program: () => undefined }, { lines: [{ session: ALPHA_SESSION, event: 'SessionStart', at }] });
    await notConfirmed(made);
  });

  it('counts a line of a later time with another event as not confirmed', async () => {
    const stop = lineText({ session: ALPHA_SESSION, event: 'Stop', at: LATER });
    const error = await notConfirmed(await withWorkers({ program: writesLine(stop) }));
    expect(error.message).toContain('Stop');
  });

  it('fails the resume when the pane is gone at the second wait, and names the pointer file that starts a new conversation', async () => {
    const made = await withWorkers({ program: atWait(2, endsPane) });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('resume failed');
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} of the worker alpha is gone`);
    expect(error.hint).toContain(`delete the file ${POINTER_FILE}`);
    expect(error.hint).toContain(RESUME);
    expect(error.hint).not.toContain('dismiss');
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('Resumed');
    expect(made.deps.sleeps).toHaveLength(2);
  });

  it('fails the resume when the program ended at once and tmux keeps the pane', async () => {
    const made = await withWorkers({ tmux: { newPanesEndAtOnce: true } });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} of the worker alpha ended`);
    expect(error.hint).toContain(POINTER_FILE);
    expect(killed(made)).toEqual([]);
  });

  it('counts a pane that tmux can not read as gone, and fails the resume', async () => {
    const made = await withWorkers({ tmux: { failing: 'display-message' } });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('is gone');
  });

  it('checks the pane only, after one wait, for a new conversation, because no line of an earlier session can confirm it', async () => {
    const made = await withWorkers({}, { pointer: null, lines: [] });
    const output = await resumed(made);
    expect(plainText(output)).toContain('Started the worker alpha again');
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs]);
  });

  it('fails a new conversation when its pane ends, and does not name the pointer file', async () => {
    const made = await withWorkers({ program: atWait(1, endsPane) }, { pointer: null, lines: [] });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} of the worker alpha is gone`);
    expect(error.hint).toBe('Run "factory worker resume alpha" to try again.');
  });
});

describe('worker resume: a conversation that does not belong to the worker is not resumed', () => {
  const expectNewConversation = (made: Made, warning: readonly string[], forbidden: readonly string[] = []): void => {
    const words = launchWords(made);
    expect(words.length).toBeGreaterThan(0);
    expect(words).not.toContain('--resume');
    for (const session of forbidden) expect(words).not.toContain(session);
    expect(warning.join('\n')).toContain('NOT resumed');
    expect(warning.join('\n')).toContain('A new conversation starts');
  };

  it('starts with no --resume and says why, when the worker has no valid last-seen line', async () => {
    const made = await withWorkers({}, { pointer: null, lines: [] });
    const output = await resumed(made);
    expectNewConversation(made, output.warnings);
    expect(output.warnings.join('\n')).toContain('no valid last-seen line');
    expect(output.json).toMatchObject({ resumed: false, sessionId: null });
    expect(plainText(output)).toContain('starts a new conversation');
  });

  it('starts with no --resume when the pointer names a file that holds no valid line', async () => {
    const made = await withWorkers({}, { lines: [] });
    made.deps.seed(`${layoutOf(HOME).heartbeatDir}/${ALPHA_SESSION}`, 'not json\n');
    const output = await resumed(made);
    expectNewConversation(made, output.warnings);
    expect(output.warnings.join('\n')).toContain('no valid last-seen line');
  });

  it('does not resume the session of the coordinator that a pointer names, and says that the line does not belong to the worker', async () => {
    const made = await withWorkers(
      {},
      { pointer: COORDINATOR_SESSION, lines: [{ session: COORDINATOR_SESSION, marker: 'demo' }] },
    );
    const output = await resumed(made);
    expectNewConversation(made, output.warnings, [COORDINATOR_SESSION]);
    expect(output.warnings.join('\n')).toContain('does not belong to this worker');
    expect(output.json).toMatchObject({ resumed: false, sessionId: null });
  });

  it('does not resume a session of the coordinator whose line has no session marker', async () => {
    const made = await withWorkers({}, { pointer: COORDINATOR_SESSION, lines: [{ session: COORDINATOR_SESSION, marker: null }] });
    const output = await resumed(made);
    expectNewConversation(made, output.warnings, [COORDINATOR_SESSION]);
    expect(output.warnings.join('\n')).toContain('does not belong to this worker');
  });

  it('does not resume the session of another worker that a pointer names', async () => {
    const made = await withWorkers(
      {},
      { pointer: BETA_SESSION, betaPointer: BETA_SESSION, lines: [{ session: BETA_SESSION, marker: 'beta' }] },
    );
    const output = await resumed(made);
    expectNewConversation(made, output.warnings, [BETA_SESSION]);
    expect(output.warnings.join('\n')).toContain('does not belong to this worker');
  });

  it('does not resume a session that the pointer of another worker names too, also when the line has the mark of this worker', async () => {
    const made = await withWorkers({}, { betaPointer: ALPHA_SESSION });
    const output = await resumed(made);
    expectNewConversation(made, output.warnings, [ALPHA_SESSION]);
    expect(output.warnings.join('\n')).toContain('does not belong to this worker');
    expect(output.warnings.join('\n')).toContain('beta');
  });

  it('says once that the earlier conversation is not resumed', async () => {
    const made = await withWorkers({}, { pointer: null, lines: [] });
    expect((await resumed(made)).warnings).toHaveLength(1);
  });
});

describe('worker resume: a pane that the launch of the worker did not make', () => {
  /** The coordinator pane after a program in a worker pane set the mark of alpha on it: it has the node mark, and it was not launched for alpha. */
  const coordinatorWithMark = (change: Partial<PaneFixture> = {}): PaneFixture => ({
    id: '%8',
    session: 'demo',
    window: 'view',
    options: { '@worker': 'alpha', '@node': 'demo' },
    pid: 4999,
    command: ['claude'],
    ...change,
  });

  /** The resume must stop with exit 4, close no pane and start no pane. */
  const refused = async (made: Made): Promise<CliError> => {
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(killed(made)).toEqual([]);
    expect(made.events).not.toContain('tmux split-window');
    expect(made.deps.terminated).toEqual([]);
    return error;
  };

  it('refuses a pane that carries the mark of the worker and the node mark, and names the pane', async () => {
    const error = await refused(await withWorkers({ tmux: { panes: [coordinatorWithMark()] } }));
    expect(error.message).toContain('%8');
  });

  it('refuses the mark on a pane whose program ended, and does not close it', async () => {
    await refused(await withWorkers({ tmux: { panes: [coordinatorWithMark({ dead: true })] } }));
  });

  it('refuses a pane of the shell that carries the mark of the worker', async () => {
    await refused(await withWorkers({ tmux: { panes: [alphaPane({ command: [] })] } }));
  });

  it('refuses the forged pane as exit 4, and not as a worker that runs already (exit 2), when the pane of the worker runs too', async () => {
    const error = await refused(await withWorkers({ tmux: { panes: [alphaPane(), coordinatorWithMark()] } }));
    expect(error.message).not.toContain('runs already');
    expect(error.hint).not.toContain('worker stop');
  });

  it('names the tmux command that clears the mark, and the command to run again', async () => {
    const error = await refused(await withWorkers({ tmux: { panes: [coordinatorWithMark()] } }));
    expect(error.hint).toContain('set-option -p -u -t %8 @worker');
    expect(error.hint).toContain('worker resume alpha');
  });

  it('still says that the worker runs already, with exit 2, for a pane that the launch made', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } });
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('runs already');
    expect(made.events).not.toContain('tmux split-window');
  });

  it('closes a pane that the launch made and that ended, and starts the worker again', async () => {
    const made = await withWorkers({ tmux: { panes: [alphaPane({ dead: true })] } });
    await resumed(made);
    expect(killed(made)).toEqual([`kill-pane -t ${ALPHA_PANE}`]);
    expect(made.tmux.panes().at(-1)).toMatchObject({ id: NEW_PANE });
  });
});

describe('worker stop and resume: a record that is not the record of its worker is exit 4', () => {
  /** The record of alpha as the file holds it, with the fields of the change. A program with write access to the state folder can do this. */
  const forge = (made: Made, fields: Record<string, unknown>): void => {
    const record = JSON.parse(made.deps.files.get(RECORD) ?? 'null') as Record<string, unknown>;
    made.deps.seed(RECORD, `${JSON.stringify({ ...record, ...fields })}\n`);
  };

  const FORGED: readonly (readonly [string, Record<string, unknown>])[] = [
    ['the home folder of the user', { work_copy: '/Users/someone' }],
    ['the factory folder', { work_copy: HOME }],
    ['the coordinator folder', { work_copy: `${HOME}/coordinator` }],
    ['a folder of another project', { work_copy: `${COPIES}/api/alpha` }],
    ['a path with a dot-dot part', { work_copy: `${PROJECT_COPIES}/../web/alpha` }],
    ['a branch of another worker', { branch: 'worker/beta' }],
  ];

  it.each(FORGED)('refuses to resume a worker whose record has %s, names the file, and starts nothing', async (_name, fields) => {
    const made = await withWorkers();
    forge(made, fields);
    const error = await resumeFailed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(RECORD);
    expect(error.message).toMatch(/work copy|branch/);
    expect(made.events).not.toContain('tmux split-window');
    expect(made.tmux.panes()).toHaveLength(3);
  });

  it.each(FORGED)('refuses to stop a worker whose record has %s, and sends nothing', async (_name, fields) => {
    const made = await withWorkers({ tmux: { panes: [alphaPane()] } });
    forge(made, fields);
    const error = await stopFailed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(RECORD);
    expect(made.deps.terminated).toEqual([]);
    expect(killed(made)).toEqual([]);
  });

  it('resumes the worker whose record has the work copy and the branch that its project and id give', async () => {
    const made = await withWorkers();
    expect(await resumed(made)).toMatchObject({ failed: false });
    expect(made.tmux.panes().at(-1)).toMatchObject({ cwd: COPY });
  });
});
