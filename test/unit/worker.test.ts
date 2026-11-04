import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError } from '../../src/cli/errors.js';
import type { WorkerOptions } from '../../src/commands/worker.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
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
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { tmuxHandler, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

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
  /** The text of a settings file that the checkout puts into the new work copy. */
  readonly checkout?: string;
  readonly claudeFile?: string | false;
  /** What a program of the machine check prints. A null text leaves the program out. */
  readonly machine?: Partial<Record<FactName, string | null>>;
  /** The path whose exclusive write fails. */
  readonly failWrite?: string;
  /** True: git says that the project folder is not the top of a work tree. */
  readonly notRepo?: boolean;
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
    if (setup.checkout !== undefined) made().seed(`${folder}/.claude/settings.local.json`, setup.checkout);
    return exited(0, 'Preparing worktree\n');
  }
  if (command.startsWith('rev-parse --verify --quiet refs/heads/')) {
    return (setup.branches ?? []).includes(command.slice('rev-parse --verify --quiet refs/heads/'.length)) ? exited(0, 'abc123\n') : exited(1);
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
  return { deps, tmux: log, events, files: new Map(base.files), dirs: new Set(base.dirs) };
};

const options = (change: Partial<WorkerOptions> = {}): WorkerOptions => ({
  home: HOME,
  words: ['new', 'alpha'],
  project: 'web',
  yes: true,
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
      'Made the worker alpha in work-copies/web/alpha on the branch worker/alpha.\nIt runs in the pane %3 of the window workers.\n',
    );
    expect(output.json).toEqual({
      schema: 'factory.worker-new/v1',
      id: 'alpha',
      project: 'web',
      workCopy: COPY,
      branch: BRANCH,
      pane: FIRST_NEW_PANE,
      proxy: null,
    });
    expect(output.failed).toBe(false);
  });
});

describe('worker new: the output is short (TP-63)', () => {
  it('has a short first line and few lines, also with warnings', async () => {
    const made = make({ machine: { memory: 'System-wide memory free percentage: 5%\n', disk: null } });
    const output = await succeeded(made);
    expectShortOutput(plainText(output));
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

  it('does not render a safety block that is out of date, and says nothing: the next start renders it', async () => {
    const config = sampleConfig();
    const older = claudeFileText({ ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[From {owner} at {node} on {date}]' } } });
    expect(older).not.toBe(claudeFileText(config));
    const made = make({ claudeFile: older });
    await succeeded(made);
    expect(made.deps.files.get('/w/node/coordinator/CLAUDE.md')).toBe(older);
    expect(made.deps.warned.join(' ')).not.toContain('Rendered the block');
    expect(made.deps.warned.join(' ')).not.toContain('out of date');
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

  it('goes on without the settings file after a no, names the effect on the worker, and still starts the pane', async () => {
    const made = make({ tty: true, prompt: () => ok('n') });
    const output = await succeeded(made, { yes: false });
    expect(made.deps.files.has(SETTINGS_FILE)).toBe(false);
    expect(made.deps.warned.join('\n')).toContain('last-seen record of the worker');
    expect(made.deps.warned.join('\n')).toContain('end the worker and run "factory worker new" again for a new worker');
    expect(made.events).toContain('tmux split-window');
    expect(output.json).toMatchObject({ pane: FIRST_NEW_PANE });
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

  it('exits 2 inside a factory session for a work copy that the checkout gave a settings file (TP-13), and keeps the copy', async () => {
    const made = make({ ...NO_TERMINAL, env: { FACTORY_SESSION: 'demo' }, checkout: '{"permissions":{"allow":["Read"]}}\n' });
    const error = await failed(made, { yes: true });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain('factory dismiss alpha');
    expect(made.deps.files.get(SETTINGS_FILE)).toBe('{"permissions":{"allow":["Read"]}}\n');
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.events).not.toContain('tmux split-window');
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

  it('stops before any write when the settings of the work copy is a skip setting', async () => {
    const made = make({ checkout: '{"permissions":{"defaultMode":"bypassPermissions"}}\n', tty: true, prompt: () => ok('y') });
    const error = await failed(made, { yes: false });
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.events).not.toContain('tmux split-window');
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

  it('stops with exit 4 and keeps the copy and the record for an exclude file that is a link', async () => {
    const made = make({ links: { [EXCLUDE]: '/elsewhere/exclude' }, seed: { '/elsewhere/exclude': TEMPLATE } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('factory dismiss alpha');
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
  it('keeps the copy and the record when the pane does not start, and names factory dismiss', async () => {
    const made = make({ tmux: { failing: 'split-window' } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.hint).toContain('"factory dismiss alpha"');
    expect(error.hint).toContain('stay');
    expect(made.deps.dirs.has(COPY)).toBe(true);
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(made.deps.files.get(SETTINGS_FILE)).toBe(OWN_SETTINGS);
    expect(made.deps.files.get(EXCLUDE)).toBe(`${TEMPLATE}${ENTRY}\n`);
  });

  it('undoes nothing: it runs no remove call and no git call besides the first one', async () => {
    const made = make({ tmux: { failing: 'split-window' } });
    await failed(made);
    expect(made.events.filter((event) => event.startsWith('remove ') && !event.endsWith('.lock'))).toEqual([]);
    expect(made.deps.calls.filter((call) => call.command === 'git' && call.args[2] === 'worktree')).toHaveLength(1);
  });

  it('names the resume command and the dismiss command when the proxy does not answer', async () => {
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
    expect(error.hint).toContain('"factory worker resume alpha"');
    expect(error.hint).toContain('"factory dismiss alpha"');
    expect(made.deps.files.has(RECORD)).toBe(true);
    expect(JSON.stringify(error)).not.toContain('secret-path');
  });

  it('fails before it writes anything when git can not make the work copy', async () => {
    const made = make({ worktreeExit: 128 });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('cannot make the work copy');
    expect(error.hint).toContain('factory worker new');
    expectNothingChanged({ ...made, events: made.events.filter((event) => event !== 'git worktree-add') });
  });

  it('names the git command that removes the copy when the record can not be written', async () => {
    const made = make({ failWrite: RECORD });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.hint).toContain(`git -C ${CLONE} worktree remove ${COPY}`);
    expect(error.hint).not.toContain('factory dismiss');
    expect(made.deps.files.has(RECORD)).toBe(false);
    expect(made.events).not.toContain('tmux split-window');
  });
});
