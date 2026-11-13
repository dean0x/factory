import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionLogInput } from '../../src/board/contract.js';
import { boardWorkItems } from '../../src/board/work-items.js';
import { exitCodeOf, failure, type CliError } from '../../src/cli/errors.js';
import { renderJson, type CommandOutput } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import type { DecisionLogPort } from '../../src/commands/board-open.js';
import { runDismiss, type DismissOptions } from '../../src/commands/dismiss.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { boardKeys, dismissWords, files, requestDeciders, schemaIds, stateLock, type HookEvent } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { withStateLock } from '../../src/state/state-lock.js';
import { fetchClone, freeWorker, inboxFilesIn, planDismiss, unpushedReasons, type DismissPlan, type FreeRequest } from '../../src/workers/dismiss.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { readPanes } from '../../src/workers/panes.js';
import { readWorkerRecord, writeWorkerRecord } from '../../src/workers/registry.js';
import type { WorkItem, WorkItemPort } from '../../src/workers/work-items.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { countReadsOf } from '../helpers/read-count.js';
import { createFakeDeps, registerRoot, type FakeDeps, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { FILE_MONITOR_OFF_WORD, gitHandler, type GitFixture, type GitLog } from '../helpers/git-fake.js';
import { sampleConfig, sampleConfigWithBoard, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { COORDINATOR_PANE, HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type PaneFixture, type PaneView, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { unknownPort } from '../helpers/unknown-port.js';
import { busyWith, knownItem, NONE } from '../helpers/work-item.js';
import { coordinatorWordsOf } from '../helpers/worker-launch-words.js';

const HOUR_MS = 3_600_000;
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

const cloneOf = (project: string): string => `${HOME}/${project}`;
const copyOf = (id: string, project = 'web'): string => `${HOME}/work-copies/${project}/${id}`;
/** The git folder that the clone keeps for a work copy, as `git worktree add` makes it. */
const adminOf = (id: string, project = 'web'): string => `${cloneOf(project)}/.git/worktrees/${id}`;

interface Seed {
  readonly id: string;
  readonly project?: string;
  /** The last event of the session. Default: Stop, so the session waits at its prompt. Null: the worker has no last-seen line. */
  readonly event?: HookEvent | null;
  /** A line that holds a context percent and no event: the state of the session is not known. */
  readonly percentOnly?: boolean;
  /** The line is newer than `idle_after`. Default: the line is old. */
  readonly recent?: boolean;
  /** The worker has a live pane. Default: true. */
  readonly pane?: boolean;
}

interface Setup {
  readonly workers?: readonly Seed[];
  readonly git?: GitFixture;
  readonly tmux?: TmuxFixture;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A person types at the terminal window, and the answer to the question of the pick step. */
  readonly terminal?: { readonly answer: string };
  readonly links?: Readonly<Record<string, string>>;
  readonly config?: FactoryConfig;
  /** Runs at each `git fetch`, after the run read the state of the workers. It stands for a change of the machine during the fetch. */
  readonly atFetch?: (made: Made) => void;
  /** Runs when the command asks the owner to pick, before the answer. It stands for a change of the machine while the owner types. */
  readonly atPrompt?: (made: Made) => void;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  readonly git: GitLog;
  /** The steps that change the machine, in order: `terminate` and `worktree-remove`. */
  readonly events: readonly string[];
  readonly sessions: ReadonlyMap<string, string>;
  /** The session of a worker works from now on: its last-seen line holds a busy event. Only a setup with `atFetch` or `atPrompt` has the lines. */
  readonly turnBusy: (id: string) => void;
}

const withProject = (config: FactoryConfig, id: string): FactoryConfig => {
  const [first] = config.recipe.projects;
  if (first === undefined) throw new Error('the sample config has no project');
  return {
    ...config,
    recipe: { ...config.recipe, projects: [...config.recipe.projects, { ...first, id, path: id, url: `https://github.com/acme/${id}.git` }] },
  };
};

const sessionOf = (index: number): string => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;

/** A git fixture in which every worker is pushed and clean: its head is the head of its remote branch. */
const pushedGit = (seeds: readonly Seed[], change: GitFixture = {}): GitFixture => {
  const projects = [...new Set(['web', ...seeds.map((seed) => seed.project ?? 'web')])];
  const copies = (project: string): Record<string, string> =>
    Object.fromEntries(seeds.filter((seed) => (seed.project ?? 'web') === project).map((seed) => [`worker/${seed.id}`, HEAD]));
  return {
    repos: Object.fromEntries(projects.map((project) => [cloneOf(project), {}])),
    heads: Object.fromEntries(seeds.map((seed) => [copyOf(seed.id, seed.project), HEAD])),
    remotes: Object.fromEntries(projects.map((project) => [cloneOf(project), { copies: copies(project) }])),
    ...change,
  };
};

const make = async (setup: Setup = {}): Promise<Made> => {
  const seeds = setup.workers ?? [];
  const events: string[] = [];
  const tmux = tmuxHandler({
    sessions: { [NODE]: HOME },
    panes: seeds.filter((seed) => seed.pane !== false).map((seed): PaneFixture => workerPane(seed.id)),
    ...setup.tmux,
  });
  const git = gitHandler(pushedGit(seeds, setup.git));
  const run: RunHandler = (call) => {
    if (call.command === 'git' && call.args[2] === 'worktree') events.push('worktree-remove');
    if (call.command === 'git' && call.args[2] === 'fetch') setup.atFetch?.(made);
    return call.command === 'git' ? git.handler(call) : tmux.handler(call);
  };
  const answer = setup.terminal?.answer;
  const base = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run,
    stdinIsTTY: answer !== undefined,
    stdoutIsTTY: answer !== undefined,
    prompt: () => {
      setup.atPrompt?.(made);
      return ok(answer ?? '');
    },
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  const deps: FakeDeps = {
    ...base,
    terminate: (pid) => {
      events.push('terminate');
      return base.terminate(pid);
    },
  };
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
  const sessions = new Map<string, string>();
  const write = async (seed: Seed, index: number): Promise<void> => {
    const session = sessionOf(index);
    const event = seed.event === undefined ? 'Stop' : seed.event;
    if (event === null && seed.percentOnly !== true) return;
    const pointer = await writeWorkerSession(deps, HOME, seed.id, session);
    if (!pointer.ok) throw new Error(pointer.error.message);
    const change = seed.percentOnly === true ? { kind: 'percent' as const, percent: 10 } : { kind: 'event' as const, event: event as HookEvent };
    const line = await writeLastSeen(deps, HOME, session, change, seed.id);
    if (!line.ok) throw new Error(line.error.message);
    sessions.set(seed.id, session);
  };
  for (const [index, seed] of seeds.entries()) {
    const project = seed.project ?? 'web';
    deps.seedDir(cloneOf(project));
    // As `git worktree add` makes them: the file `.git` of the work copy names the git folder of the clone, and that folder names the file back.
    deps.seed(`${copyOf(seed.id, project)}/.git`, `gitdir: ${adminOf(seed.id, project)}\n`);
    deps.seed(`${adminOf(seed.id, project)}/gitdir`, `${copyOf(seed.id, project)}/.git\n`);
    const written = await writeWorkerRecord(deps, HOME, { id: seed.id, project, workCopy: copyOf(seed.id, project), branch: `worker/${seed.id}` });
    if (!written.ok) throw new Error(written.error.message);
    if (seed.recent !== true) await write(seed, index);
  }
  deps.advance(3 * HOUR_MS);
  for (const [index, seed] of seeds.entries()) if (seed.recent === true) await write(seed, index);
  // The busy line of each worker, made now and kept aside: the idle line stays in place until `turnBusy` swaps them.
  const busyLines = new Map<string, { readonly file: string; readonly text: string }>();
  if (setup.atFetch !== undefined || setup.atPrompt !== undefined) {
    for (const [id, session] of sessions) {
      const file = `${layoutOf(HOME).heartbeatDir}/${session}`;
      const idleText = deps.files.get(file) ?? '';
      const line = await writeLastSeen(deps, HOME, session, { kind: 'event', event: 'UserPromptSubmit' }, id);
      if (!line.ok) throw new Error(line.error.message);
      busyLines.set(id, { file, text: deps.files.get(file) ?? '' });
      deps.seed(file, idleText);
    }
  }
  const turnBusy = (id: string): void => {
    const busy = busyLines.get(id);
    if (busy === undefined) throw new Error(`no busy line was made for ${id}`);
    deps.seed(busy.file, busy.text);
  };
  const made: Made = { deps, tmux: tmux.log, git: git.log, events, sessions, turnBusy };
  return made;
};

const portOf = (items: Readonly<Record<string, WorkItem>>): WorkItemPort => ({
  itemsOf: async (_deps, _home, ids) => ok(new Map(ids.flatMap((id) => (items[id] === undefined ? [] : [[id, items[id]] as const])))),
});

const optionsOf = (change: Partial<DismissOptions>): DismissOptions => ({ home: HOME, words: [], idle: false, yes: false, closed: false, ...change });

/** A decision log that a test that frees nothing in a session passes: a write of a row is a fault. */
const noLog: DecisionLogPort = { log: async () => failure('the test gives no decision log') };

const outputOf = async (
  made: Made,
  change: Partial<DismissOptions> = {},
  port: WorkItemPort = unknownPort,
  decisions: DecisionLogPort = noLog,
): Promise<CommandOutput> => {
  const result = await runDismiss(made.deps, optionsOf(change), recipes, decisions, port);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const errorOf = async (
  made: Made,
  change: Partial<DismissOptions> = {},
  port: WorkItemPort = unknownPort,
  decisions: DecisionLogPort = noLog,
): Promise<CliError> => {
  const result = await runDismiss(made.deps, optionsOf(change), recipes, decisions, port);
  if (result.ok) throw new Error(`the command did not fail: ${JSON.stringify(result.value.lines)}`);
  return result.error;
};

const textOf = (output: CommandOutput): string => output.lines.map((line) => line.text).join('\n');

const paneOf = (made: Made, id: string): PaneView => {
  const found = made.tmux.panes().find((pane) => pane.options['@worker'] === id);
  if (found === undefined) throw new Error(`no pane for ${id}`);
  return found;
};

const hasPane = (made: Made, id: string): boolean => made.tmux.panes().some((pane) => pane.options['@worker'] === id);

const removals = (made: Made): string[] => made.git.commands().filter((command) => command.startsWith('worktree remove'));

const recordState = async (made: Made, id: string): Promise<string> => {
  const read = await readWorkerRecord(made.deps, HOME, id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value.state;
};

const lineExists = (made: Made, id: string): boolean => {
  const session = made.sessions.get(id);
  return session !== undefined && made.deps.files.has(`${layoutOf(HOME).heartbeatDir}/${session}`);
};

/** Nothing of the machine changed: no process ended, no work copy removed, and every record is there. */
const expectNothingChanged = async (made: Made, ids: readonly string[]): Promise<void> => {
  expect(made.events).toEqual([]);
  expect(made.deps.terminated).toEqual([]);
  expect(removals(made)).toEqual([]);
  for (const id of ids) expect(await recordState(made, id)).toBe('valid');
};

/** The title line and the first `count` rows of the table, each cut into its cells. A column is cut at two spaces or more. */
const rowsOf = (output: CommandOutput, count: number): string[][] =>
  output.lines.slice(0, count + 1).map((line) => line.text.split(/\s{2,}/));

describe('dismiss: the words of the command line', () => {
  it.each<[string, Partial<DismissOptions>]>([
    ['no word and no --idle', { words: [] }],
    ['two words', { words: ['alpha', 'beta'] }],
    ['--idle with a word', { idle: true, words: ['alpha'] }],
    ['--idle with --yes', { idle: true, yes: true }],
  ])('refuses %s as a usage error and runs no program', async (_name, change) => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const error = await errorOf(made, change);
    expect(error.kind).toBe('usage');
    expect(made.git.commands()).toEqual([]);
    expect(made.tmux.commands()).toEqual([]);
  });

  it('refuses a worker that has no record as a usage error', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const error = await errorOf(made, { words: ['ghost'] });
    expect(error.kind).toBe('usage');
    expect(made.git.commands().filter((command) => command.startsWith('fetch'))).toEqual([]);
  });
});

describe('dismiss ID: the dry run', () => {
  it('says what it would end and free, and changes nothing', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const pane = paneOf(made, 'alpha');
    const output = await outputOf(made, { words: ['alpha'] });
    const text = textOf(output);
    expect(output.failed).toBe(false);
    expect(text).toContain(`Would end the pane ${pane.id}`);
    expect(text).toContain(`Would remove the work copy ${copyOf('alpha')}`);
    expect(text).toContain('Would delete the record');
    expect(text).toContain('dismiss alpha --yes');
    expect(output.json).toMatchObject({ schema: schemaIds.dismiss, freed: false });
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  it('names the ignored files that the removal deletes, at most the cap, says that there are more, and changes nothing (TP-56)', async () => {
    const files = Array.from({ length: dismissWords.maxIgnoredShown + 5 }, (_, index) => `cache/file-${String(index).padStart(2, '0')}.log`);
    const made = await make({ workers: [{ id: 'alpha' }], git: { ignoredFiles: { [copyOf('alpha')]: files } } });
    const text = textOf(await outputOf(made, { words: ['alpha'] }));
    const at = (index: number): string => files[index] ?? '';
    expect(text).toContain(at(0));
    expect(text).toContain(at(dismissWords.maxIgnoredShown - 1));
    expect(text).not.toContain(at(dismissWords.maxIgnoredShown));
    expect(text).toContain(`The removal deletes more than ${dismissWords.maxIgnoredShown} ignored files`);
    expect(text).toContain('and more');
    await expectNothingChanged(made, ['alpha']);
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  describe('an ignored file with a hidden character in its name (TP-91, TP-105)', () => {
    const BIDI = String.fromCodePoint(0x202e);
    const NAME = `cache/a${BIDI}b\nSTUCK c.log`;
    const dirtyCopy = async (): Promise<Made> =>
      make({ workers: [{ id: 'alpha' }], git: { ignoredFiles: { [copyOf('alpha')]: [NAME, 'dist/'] } } });

    it('M5-1b TP-91 prints the name as one clean line, and adds no line of its own', async () => {
      const output = await outputOf(await dirtyCopy(), { words: ['alpha'] });
      const line = output.lines.find((candidate) => candidate.text.startsWith('The removal deletes'));
      expect(line?.text).toBe('The removal deletes 2 ignored files: cache/ab STUCK c.log, dist/.');
      expect(output.lines.every((candidate) => !/[\n\r\t]/.test(candidate.text) && !candidate.text.includes(BIDI))).toBe(true);
    });

    it('M5-1b TP-105 removes only the hidden characters from the JSON, and keeps the line break as an escape', async () => {
      const output = await outputOf(await dirtyCopy(), { words: ['alpha'] });
      const text = renderJson(output.json);
      expect(text).not.toContain(BIDI);
      expect(text).toContain('cache/ab\\nSTUCK c.log');
    });
  });

  it('says nothing about ignored files when there are none, and says that the branch stays', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const text = textOf(await outputOf(made, { words: ['alpha'] }));
    expect(text).not.toContain('ignored');
    expect(text).toContain('worker/alpha');
  });

  it('is allowed inside a factory session: it changes nothing', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], env: { FACTORY_SESSION: 'demo' } });
    const output = await outputOf(made, { words: ['alpha'] });
    expect(output.failed).toBe(false);
    await expectNothingChanged(made, ['alpha']);
  });

  describe('the inbox files that the free deletes (TP-29)', () => {
    const inboxOf = (id: string): string => workerPathsOf(HOME, id).inboxDir;

    it('names them, carries them in the json, and keeps them', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      made.deps.seed(`${inboxOf('alpha')}/assignment.md`, 'Build the page.\n');
      made.deps.seed(`${inboxOf('alpha')}/review.md`, 'Looks fine.\n');
      const output = await outputOf(made, { words: ['alpha'] });
      expect(textOf(output)).toContain('The removal deletes 2 inbox files: assignment.md, review.md.');
      expect(output.json).toMatchObject({ workers: [expect.objectContaining({ inbox: ['assignment.md', 'review.md'] })] });
      expect(made.deps.files.has(`${inboxOf('alpha')}/review.md`)).toBe(true);
      await expectNothingChanged(made, ['alpha']);
    });

    it('says one file in the singular, and says nothing for an empty inbox', async () => {
      const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
      made.deps.seed(`${inboxOf('alpha')}/assignment.md`, 'x');
      expect(textOf(await outputOf(made, { words: ['alpha'] }))).toContain('The removal deletes 1 inbox file: assignment.md.');
      expect(textOf(await outputOf(made, { words: ['beta'] }))).not.toContain('inbox');
    });

    it('names at most the cap, and says that there are more', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      for (let index = 0; index < dismissWords.maxInboxShown + 3; index += 1) made.deps.seed(`${inboxOf('alpha')}/note-${String(index).padStart(2, '0')}.md`, 'x');
      const text = textOf(await outputOf(made, { words: ['alpha'] }));
      expect(text).toContain(`The removal deletes more than ${dismissWords.maxInboxShown} inbox files`);
      expect(text).toContain('and more');
      expect(text).toContain('note-00.md');
      expect(text).not.toContain(`note-${String(dismissWords.maxInboxShown).padStart(2, '0')}.md`);
    });

    it('is a failure when the inbox cannot be read, before any free', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      const broken: Made = {
        ...made,
        deps: { ...made.deps, fs: { ...made.deps.fs, listLimited: async () => failure('cannot list the inbox: EIO') } },
      };
      const error = await errorOf(broken, { words: ['alpha'] });
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('EIO');
      await expectNothingChanged(made, ['alpha']);
    });

    it('is a security stop when another user owns the inbox folder', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      made.deps.owners.set(inboxOf('alpha'), (made.deps.uid ?? 0) + 1);
      const error = await errorOf(made, { words: ['alpha'] });
      expect(exitCodeOf[error.kind]).toBe(4);
      await expectNothingChanged(made, ['alpha']);
    });

    it('is a security stop when the inbox is a link, so the files of another folder are never named', async () => {
      const links: Record<string, string> = {};
      const made = await make({ workers: [{ id: 'alpha' }], links });
      links[inboxOf('alpha')] = '/elsewhere';
      const error = await errorOf(made, { words: ['alpha'] });
      expect(exitCodeOf[error.kind]).toBe(4);
      await expectNothingChanged(made, ['alpha']);
    });

    it('is no fault when the worker has no inbox folder: there is nothing to delete', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      await made.deps.fs.remove(inboxOf('alpha'));
      const output = await outputOf(made, { words: ['alpha'] });
      expect(output.failed).toBe(false);
      expect(textOf(output)).not.toContain('inbox');
    });

    it('leaves the yes path as it was: it reads no inbox and names none', async () => {
      const made = await make({ workers: [{ id: 'alpha' }] });
      made.deps.seed(`${inboxOf('alpha')}/assignment.md`, 'x');
      const listed: string[] = [];
      const spy: Made = {
        ...made,
        deps: { ...made.deps, fs: { ...made.deps.fs, listLimited: async (path, limit) => (listed.push(path), made.deps.fs.listLimited(path, limit)) } },
      };
      const output = await outputOf(spy, { words: ['alpha'], yes: true });
      expect(output.failed).toBe(false);
      expect(textOf(output)).not.toContain('inbox');
      expect(listed).toEqual([]);
    });
  });
});

describe('inboxFilesIn', () => {
  it('lists the names of the files of the inbox of a worker, cut at the cap', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.seed(`${workerPathsOf(HOME, 'alpha').inboxDir}/a.md`, 'x');
    expect(await inboxFilesIn(made.deps, HOME, 'alpha')).toEqual({ ok: true, value: { paths: ['a.md'], reachedCap: false } });
  });

  it('reads one name more than the cap, to know that there are more', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const limits: number[] = [];
    const spy = { ...made.deps, fs: { ...made.deps.fs, listLimited: async (path: string, limit: number) => (limits.push(limit), made.deps.fs.listLimited(path, limit)) } };
    await inboxFilesIn(spy, HOME, 'alpha');
    expect(limits).toEqual([dismissWords.maxInboxShown + 1]);
  });
});

describe('dismiss ID: the work must be pushed', () => {
  const alpha = copyOf('alpha');
  /** The clone knows its default branch `main`, and the remote has it one commit ahead of the head of the worker. The branch of the worker is not on the remote. */
  const onDefault: GitFixture = {
    repos: { [cloneOf('web')]: { originHead: 'origin/main' } },
    remotes: { [cloneOf('web')]: { copies: { main: OLDER } } },
    ancestors: { [OLDER]: [HEAD] },
  };
  /** As `onDefault`, but the head of the worker is not below the default branch. */
  const offDefault: GitFixture = { ...onDefault, ancestors: {} };
  const cases: readonly (readonly [string, GitFixture, string])[] = [
    ['a worker with no commit of its own has an untracked file', { ...onDefault, status: { [alpha]: '?? notes/new.md\0' } }, 'notes/new.md'],
    ['a worker with no commit of its own has a changed file', { ...onDefault, status: { [alpha]: ' M src/changed.ts\0' } }, 'src/changed.ts'],
    ['a worker with no commit of its own sees an entry in the stash', { ...onDefault, stashes: { [cloneOf('web')]: 1 } }, 'stash'],
    ['the head is on no remote branch of the clone', offDefault, 'is not on the remote'],
    [
      'the remote dropped the branch, and the head is not on the default branch',
      { ...offDefault, remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': HEAD, main: OLDER }, now: { main: OLDER } } } },
      'is not on the remote',
    ],
    [
      'the head has commits that the remote branch and the default branch both lack',
      { ...offDefault, remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': OLDER, main: OLDER } } } },
      'commits that',
    ],
    ['the branch is not on the remote', { remotes: { [cloneOf('web')]: { copies: {} } } }, 'is not on the remote'],
    ['the head has commits that the remote branch lacks', { remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': OLDER } } } }, 'commits that'],
    ['the work copy has no commit', { heads: {} }, 'the work copy has no commit'],
    ['a tracked file changed', { status: { [alpha]: ' M src/changed.ts\0' } }, 'src/changed.ts'],
    ['an untracked file exists', { status: { [alpha]: '?? notes/new.md\0' } }, 'notes/new.md'],
    ['the stash holds an entry', { stashes: { [cloneOf('web')]: 1 } }, 'stash'],
    [
      'the remote ref is stale: the remote dropped the branch, and the fetch prunes the copy',
      { remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': HEAD }, now: {} } } },
      'is not on the remote',
    ],
  ];

  it.each(cases)('prints a STUCK line and frees nothing when %s (TP-54)', async (_name, git, reason) => {
    const made = await make({ workers: [{ id: 'alpha' }], git });
    const dry = await outputOf(made, { words: ['alpha'] });
    const dryStuck = dry.lines.filter((line) => line.text.startsWith(dismissWords.stuck));
    expect(dry.failed).toBe(true);
    expect(dry.exitCode).toBe(1);
    expect(dryStuck.map((line) => line.text).join('\n')).toContain(reason);

    const confirmed = await outputOf(made, { words: ['alpha'], yes: true });
    expect(confirmed.failed).toBe(true);
    expect(confirmed.exitCode).toBe(1);
    expect(confirmed.lines.some((line) => line.text.startsWith(dismissWords.stuck))).toBe(true);
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  it('prints one STUCK line for each reason (TP-54)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: { status: { [alpha]: ' M a.ts\0' }, stashes: { [cloneOf('web')]: 2 } } });
    const output = await outputOf(made, { words: ['alpha'] });
    expect(output.lines.filter((line) => line.text.startsWith(dismissWords.stuck))).toHaveLength(2);
  });

  it('frees a worker that has no commit of its own and was never pushed, because its head is below the default branch of the remote (TP-53)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: onDefault });
    const dry = await outputOf(made, { words: ['alpha'] });
    expect(dry.failed).toBe(false);
    expect(dry.lines.some((line) => line.text.startsWith(dismissWords.stuck))).toBe(false);
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(made.events).toEqual(['terminate', 'worktree-remove']);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it('frees a worker whose branch the remote dropped when its head is below the default branch (TP-53)', async () => {
    const git: GitFixture = { ...onDefault, remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': HEAD, main: OLDER }, now: { main: OLDER } } } };
    const made = await make({ workers: [{ id: 'alpha' }], git });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it('names the default branch in the reason when the head is on neither remote branch (TP-54)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: offDefault });
    const output = await outputOf(made, { words: ['alpha'] });
    const stuck = output.lines.filter((line) => line.text.startsWith(dismissWords.stuck)).map((line) => line.text);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toContain('worker/alpha is not on the remote origin');
    expect(stuck[0]).toContain('origin/main');
  });

  it('frees a worker with the plain rule when the clone knows no default branch and the branch is on the remote', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(made.git.calls.find((call) => call.args[2] === 'fetch')?.args.slice(3)).toEqual([
      '--prune',
      '--no-tags',
      'origin',
      '+refs/heads/worker/*:refs/remotes/origin/worker/*',
    ]);
  });

  it('fetches the worker branches and the default branch of the clone in one call before it reads the copies of the remote branches (TP-60)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: onDefault });
    await outputOf(made, { words: ['alpha'] });
    const commands = made.git.commands();
    const fetches = made.git.calls.filter((call) => call.args[2] === 'fetch');
    const fetchAt = commands.findIndex((command) => command.startsWith('fetch'));
    const copyAt = commands.findIndex((command) => command.startsWith('rev-parse --verify --quiet refs/remotes/origin/'));
    expect(fetches).toHaveLength(1);
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(copyAt);
    expect(fetches[0]?.args.slice(1)).toEqual([
      cloneOf('web'),
      'fetch',
      '--prune',
      '--no-tags',
      'origin',
      '+refs/heads/worker/*:refs/remotes/origin/worker/*',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
  });

  it('is a failure, with nothing freed, when the fetch fails', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }],
      git: { remotes: { [cloneOf('web')]: { copies: { 'worker/alpha': HEAD }, fetchExit: 128 } } },
    });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('fetch');
    await expectNothingChanged(made, ['alpha']);
  });
});

describe('dismiss ID --yes: the free', () => {
  it('ends the pane before it removes the work copy with no force, and deletes the record and its last-seen line (TP-53, TP-55, TP-57)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const pane = paneOf(made, 'alpha');
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    const text = textOf(output);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ schema: schemaIds.dismiss, freed: true });
    expect(made.events).toEqual(['terminate', 'worktree-remove']);
    expect(made.deps.terminated).toEqual([pane.pid]);
    expect(hasPane(made, 'alpha')).toBe(false);
    expect(removals(made)).toEqual([`worktree remove -- ${copyOf('alpha')}`]);
    expect(made.git.calls.find((call) => call.args[2] === 'worktree')?.args[1]).toBe(cloneOf('web'));
    expect(await recordState(made, 'alpha')).toBe('absent');
    expect(made.deps.dirs.has(workerPathsOf(HOME, 'alpha').dir)).toBe(false);
    expect(lineExists(made, 'alpha')).toBe(false);
    expect(text).toContain(`Ended the pane ${pane.id}`);
    expect(text).toContain(`Removed the work copy ${copyOf('alpha')}`);
    expect(text).not.toContain('ignored');
  });

  it('names the count and the first paths of the ignored files that the removal deletes, and carries them in the json', async () => {
    const files = ['cache/run.log', '.env.local', 'dist/'];
    const made = await make({ workers: [{ id: 'alpha' }], git: { ignoredFiles: { [copyOf('alpha')]: files } } });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(textOf(output)).toContain('The removal deleted 3 ignored files: cache/run.log, .env.local, dist/.');
    expect(output.json).toMatchObject({ freed: true, workers: [{ id: 'alpha', ignored: files }] });
    expect(removals(made)).toEqual([`worktree remove -- ${copyOf('alpha')}`]);
  });

  it('names at most the cap of the ignored files that the removal deletes, and says that there are more', async () => {
    const files = Array.from({ length: dismissWords.maxIgnoredShown + 5 }, (_, index) => `cache/file-${String(index).padStart(2, '0')}.log`);
    const made = await make({ workers: [{ id: 'alpha' }], git: { ignoredFiles: { [copyOf('alpha')]: files } } });
    const text = textOf(await outputOf(made, { words: ['alpha'], yes: true }));
    expect(text).toContain(`The removal deleted more than ${dismissWords.maxIgnoredShown} ignored files`);
    expect(text).toContain(files[0] ?? '');
    expect(text).toContain(files[dismissWords.maxIgnoredShown - 1] ?? '');
    expect(text).not.toContain(files[dismissWords.maxIgnoredShown] ?? '');
    expect(text).toContain('and more');
  });

  it('frees a worker whose work copy holds the excluded settings file, because git ignores it and the removal deletes it (TP-53)', async () => {
    const settings = '.claude/settings.local.json';
    const made = await make({ workers: [{ id: 'alpha' }], git: { ignoredFiles: { [copyOf('alpha')]: [settings] } } });
    const dry = await outputOf(made, { words: ['alpha'] });
    expect(dry.failed).toBe(false);
    expect(textOf(dry)).toContain(settings);
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(removals(made)).toEqual([`worktree remove -- ${copyOf('alpha')}`]);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it('keeps the branch, runs no branch command, and prints the command that deletes it', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const text = textOf(await outputOf(made, { words: ['alpha'], yes: true }));
    expect(made.git.commands().filter((command) => command.startsWith('branch') && command !== 'branch --show-current')).toEqual([]);
    expect(text).toContain(`git -C ${cloneOf('web')} branch -D worker/alpha`);
  });

  it('frees a worker that has no live pane with no process stopped', async () => {
    const made = await make({ workers: [{ id: 'alpha', pane: false }] });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
    expect(made.events).toEqual(['worktree-remove']);
    expect(await recordState(made, 'alpha')).toBe('absent');
    expect(textOf(output)).not.toContain('Ended the pane');
  });

  it('keeps the other workers: their records, panes and last-seen lines stay', async () => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    await outputOf(made, { words: ['alpha'], yes: true });
    expect(await recordState(made, 'beta')).toBe('valid');
    expect(hasPane(made, 'beta')).toBe(true);
    expect(lineExists(made, 'beta')).toBe(true);
  });

  it('is a security stop inside a factory session: no program runs and nothing changes', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], env: { FACTORY_SESSION: 'demo' } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(error.hint).toContain('outside');
    expect(made.git.commands()).toEqual([]);
    await expectNothingChanged(made, ['alpha']);
  });

  it('works with no terminal window, as the other commands with --yes do', async () => {
    const made = await make({ workers: [{ id: 'alpha', pane: false }] });
    expect(made.deps.stdinIsTTY).toBe(false);
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
  });

  it('leaves the work copy and the record when git refuses the removal, and says what ended before', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: { worktreeRemoveFails: { [cloneOf('web')]: 'fatal: contains modified or untracked files' } } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('contains modified or untracked files');
    expect(error.message).toContain('pane');
    expect(error.hint).toContain('dismiss alpha');
    expect(await recordState(made, 'alpha')).toBe('valid');
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  it('names the unlock command for a locked work copy, and the steps by hand for a work copy with submodules, when git refuses the removal', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: { worktreeRemoveFails: { [cloneOf('web')]: 'fatal: cannot remove a locked working tree' } } });
    const lineFile = `${layoutOf(HOME).heartbeatDir}/${made.sessions.get('alpha') ?? ''}`;
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    const hint = error.hint ?? '';
    expect(hint).toContain(`git -C ${cloneOf('web')} worktree unlock ${copyOf('alpha')}`);
    expect(hint).toContain('dismiss alpha" again');
    expect(hint).toContain(`git -C ${cloneOf('web')} worktree remove --force ${copyOf('alpha')}`);
    expect(hint).toContain(`${lineFile} and ${workerPathsOf(HOME, 'alpha').dir} by hand`);
    expect(removals(made)).toEqual([`worktree remove -- ${copyOf('alpha')}`]);
  });

  it('names no last-seen line to delete by hand when the worker has none', async () => {
    const made = await make({ workers: [{ id: 'alpha', event: null, pane: false }], git: { worktreeRemoveFails: { [cloneOf('web')]: 'fatal: contains submodules' } } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.hint).toContain(`Then delete ${workerPathsOf(HOME, 'alpha').dir} by hand`);
  });

  it.each<[string, 'line' | 'record']>([
    ['the last-seen line', 'line'],
    ['the record folder', 'record'],
  ])('names the paths to delete by hand, not a run of dismiss, when %s can not be deleted after the work copy is gone', async (_name, fails) => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const recordDir = workerPathsOf(HOME, 'alpha').dir;
    const lineFile = `${layoutOf(HOME).heartbeatDir}/${made.sessions.get('alpha') ?? ''}`;
    const failing = fails === 'line' ? lineFile : recordDir;
    const broken: FakeDeps = {
      ...made.deps,
      fs: { ...made.deps.fs, remove: async (path) => (path === failing ? failure('cannot remove it: EACCES') : made.deps.fs.remove(path)) },
    };
    const result = await runDismiss(broken, optionsOf({ words: ['alpha'], yes: true }), recipes, noLog, unknownPort);
    if (result.ok) throw new Error('the free did not fail');
    const { message, hint } = result.error;
    expect(removals(made)).toEqual([`worktree remove -- ${copyOf('alpha')}`]);
    expect(message).toContain(`removed the work copy ${copyOf('alpha')}`);
    expect(hint).toContain('by hand');
    expect(hint).toContain(recordDir);
    expect(hint).not.toContain('again.');
    if (fails === 'line') {
      expect(hint).toContain(lineFile);
    } else {
      expect(message).toContain('deleted the last-seen line');
      expect(hint).not.toContain(lineFile);
    }
  });
});

describe('dismiss ID: a worker that must not end', () => {
  it.each<[string, Seed, WorkItem | null]>([
    ['its session works', { id: 'alpha', event: 'UserPromptSubmit' }, null],
    ['its state is not known', { id: 'alpha', event: null }, null],
    ['it has open work', { id: 'alpha' }, busyWith('item 7')],
  ])('is a failure with a remedy when %s, and nothing ends', async (_name, seed, item) => {
    const made = await make({ workers: [seed] });
    const port = item === null ? unknownPort : portOf({ alpha: item });
    for (const yes of [false, true]) {
      const error = await errorOf(made, { words: ['alpha'], yes }, port);
      expect(error.kind).toBe('failure');
      expect(error.hint).toContain('dismiss alpha');
    }
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
  });

  it('TP-5: refuses a worker whose session shows a dialog with exit 1, also in the dry run, names its pane, and ends nothing', async () => {
    const made = await make({ workers: [{ id: 'alpha', event: 'Notification' }] });
    const pane = paneOf(made, 'alpha');
    for (const yes of [false, true]) {
      const error = await errorOf(made, { words: ['alpha'], yes });
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('dialog');
      expect(error.hint).toContain(`the pane ${pane.id}`);
      expect(error.hint).toContain('dismiss alpha');
    }
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
  });

  it('refuses a worker that turns busy after the first read of its state, ends nothing, and names the command to run again (TP-59)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], atFetch: (turned) => turned.turnBusy('alpha') });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('failure');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('busy');
    expect(error.message).toContain('Nothing was freed');
    expect(error.hint).toContain('dismiss alpha');
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  it('does not refuse a stopped worker whose last event is busy: it has no process to end', async () => {
    const made = await make({ workers: [{ id: 'alpha', event: 'UserPromptSubmit', pane: false }] });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.failed).toBe(false);
  });

  it('refuses a worker whose state is not known with exit 1 and a remedy that names its pane (TP-59)', async () => {
    const made = await make({ workers: [{ id: 'alpha', event: null }] });
    const pane = paneOf(made, 'alpha');
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(`the pane ${pane.id}`);
    expect(error.hint).toContain('dismiss alpha');
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
  });

  it('is a security stop and ends nothing when another folder owns the session of the node, so that session keeps running (TP-59)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], tmux: { sessions: { [NODE]: '/other/node' } } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(made.tmux.sessions().has(NODE)).toBe(true);
    await expectNothingChanged(made, ['alpha']);
    expect(hasPane(made, 'alpha')).toBe(true);
  });
});

describe('dismiss ID: the path of the work copy', () => {
  it('is a security stop for a record whose work copy is outside work-copies/ (TP-55)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const file = workerPathsOf(HOME, 'alpha').recordFile;
    made.deps.seed(file, (made.deps.files.get(file) ?? '').replace(copyOf('alpha'), '/elsewhere/alpha'));
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(made.git.commands()).toEqual([]);
    await expectNothingChanged(made, []);
  });

  it('is a security stop when a folder above the work copy is a link, and the primary clone is untouched (TP-55)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [`${HOME}/work-copies/web`]: cloneOf('web') } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(made.git.commands()).toEqual([]);
    await expectNothingChanged(made, ['alpha']);
  });

  it('is a security stop when the real path of the work copy leaves work-copies/, whatever the checks of the path said (TP-55)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [`${HOME}/work-copies/web`]: '/elsewhere/web' } });
    // The link appears after the check of the path: lstat still says folder, and the real path leads outside.
    const hidden: FakeDeps = { ...made.deps, fs: { ...made.deps.fs, lstat: async (path) => (path === `${HOME}/work-copies/web` ? ok('dir' as const) : made.deps.fs.lstat(path)) } };
    made.deps.seedDir('/elsewhere/web/alpha');
    const result = await runDismiss(hidden, optionsOf({ words: ['alpha'], yes: true }), recipes, noLog, unknownPort);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('safety');
    expect(made.git.commands()).toEqual([]);
    await expectNothingChanged(made, ['alpha']);
  });

  it('is a security stop when the clone of the project is a link into the work copy, so the clone is never freed (TP-55)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [cloneOf('web')]: copyOf('alpha') } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.git.commands().some((command) => command.startsWith('fetch'))).toBe(false);
    await expectNothingChanged(made, ['alpha']);
  });

  it('removes the work copy by the real path that the checks proved, not by the path of the record rule (TP-55)', async () => {
    // The folder of the node is a link: every real path lies below another folder than the path of the record rule.
    const real = (path: string): string => (path.startsWith(HOME) ? `/real/node${path.slice(HOME.length)}` : path);
    const made = await make({ workers: [{ id: 'alpha' }], git: { heads: { [real(copyOf('alpha'))]: HEAD } } });
    const back = (path: string): string => (path.startsWith('/real/node') ? `${HOME}${path.slice('/real/node'.length)}` : path);
    const linked: FakeDeps = {
      ...made.deps,
      fs: {
        ...made.deps.fs,
        realpath: async (path) => {
          const resolved = await made.deps.fs.realpath(back(path));
          return resolved.ok ? ok(real(resolved.value)) : resolved;
        },
        lstat: (path) => made.deps.fs.lstat(back(path)),
        readTextLimited: (path, maxBytes) => made.deps.fs.readTextLimited(back(path), maxBytes),
      },
    };
    const result = await runDismiss(linked, optionsOf({ words: ['alpha'], yes: true }), recipes, noLog, unknownPort);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.failed).toBe(false);
    expect(removals(made)).toEqual([`worktree remove -- ${real(copyOf('alpha'))}`]);
    expect(textOf(result.value)).toContain(`Removed the work copy ${real(copyOf('alpha'))}`);
  });

  it('is a failure when the work copy is not a folder, and nothing changes', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.dirs.delete(copyOf('alpha'));
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('failure');
    expect(error.hint).toContain('dismiss alpha');
    await expectNothingChanged(made, ['alpha']);
  });

  it('is a failure when the project of the worker is not in the config', async () => {
    const made = await make({ workers: [{ id: 'alpha', project: 'api' }] });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('failure');
    await expectNothingChanged(made, ['alpha']);
  });
});

describe('dismiss ID: the git link of the work copy', () => {
  const alpha = copyOf('alpha');
  const link = `${alpha}/.git`;
  /** The git calls that run in the work copy. */
  const readsOf = (made: Made): readonly RunCall[] => made.git.calls.filter((call) => call.args[0] === '-C' && call.args[1] === alpha);

  it('reads the work copy from the git folder that the clone keeps for it, with the file monitor off, and reads the stash and the commits in the clone (TP-55)', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const output = await outputOf(made, { words: ['alpha'] });
    expect(output.failed).toBe(false);
    const reads = readsOf(made);
    expect(reads.map((call) => call.args[8])).toEqual(['rev-parse', 'status', 'status']);
    for (const call of reads) {
      expect(call.args.slice(2, 8)).toEqual(['-c', FILE_MONITOR_OFF_WORD, '--git-dir', adminOf('alpha'), '--work-tree', alpha]);
    }
  });

  it.each<[string, (made: Made) => void]>([
    [
      'names a folder inside the work copy that holds a matching back link',
      (made) => {
        made.deps.seed(link, `gitdir: ${alpha}/x\n`);
        made.deps.seed(`${alpha}/x/gitdir`, `${link}\n`);
      },
    ],
    [
      'names a relative folder inside the work copy that holds a matching back link',
      (made) => {
        made.deps.seed(link, 'gitdir: ./x\n');
        made.deps.seed(`${alpha}/x/gitdir`, `${link}\n`);
      },
    ],
    [
      'names the git folder of the clone itself',
      (made) => {
        made.deps.seed(link, `gitdir: ${cloneOf('web')}/.git\n`);
        made.deps.seed(`${cloneOf('web')}/.git/gitdir`, `${link}\n`);
      },
    ],
    [
      'names a folder that the clone keeps for another work copy',
      (made) => {
        made.deps.seed(link, `gitdir: ${adminOf('beta')}\n`);
      },
    ],
    [
      'names a folder of the clone whose back link names another file',
      (made) => {
        made.deps.seed(`${adminOf('alpha')}/gitdir`, `${copyOf('beta')}/.git\n`);
      },
    ],
    [
      'names a folder that does not exist',
      (made) => {
        made.deps.seed(link, `gitdir: ${cloneOf('web')}/.git/worktrees/ghost\n`);
      },
    ],
    [
      'holds no gitdir line',
      (made) => {
        made.deps.seed(link, 'not a link to a git folder\n');
      },
    ],
    [
      'is a folder',
      (made) => {
        made.deps.files.delete(link);
        made.deps.seedDir(link);
      },
    ],
    [
      'is missing',
      (made) => {
        made.deps.files.delete(link);
      },
    ],
  ])('is a security stop, with no git read of the work copy and no change, when the .git entry of the work copy %s (TP-55)', async (_name, change) => {
    const made = await make({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    change(made);
    for (const yes of [false, true]) {
      const error = await errorOf(made, { words: ['alpha'], yes });
      expect(error.kind).toBe('safety');
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.hint).toContain('dismiss alpha');
    }
    expect(readsOf(made)).toEqual([]);
    expect(made.git.commands().some((command) => command.startsWith('fetch'))).toBe(false);
    await expectNothingChanged(made, ['alpha', 'beta']);
    expect(hasPane(made, 'alpha')).toBe(true);
  });

  it('is a security stop when the .git entry of the work copy is a link', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [link]: `${adminOf('alpha')}/../../.git` } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.kind).toBe('safety');
    expect(readsOf(made)).toEqual([]);
    await expectNothingChanged(made, ['alpha']);
  });

  it('stops with exit 4 and runs no git read in the work copy when the owner picks a worker with a bad git link, so nothing ends', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], terminal: { answer: 'alpha' } });
    made.deps.seed(link, `gitdir: ${alpha}/x\n`);
    made.deps.seed(`${alpha}/x/gitdir`, `${link}\n`);
    const error = await errorOf(made, { idle: true }, portOf({ alpha: NONE }));
    expect(error.kind).toBe('safety');
    expect(readsOf(made)).toEqual([]);
    await expectNothingChanged(made, ['alpha']);
  });
});

describe('dismiss ID: the refusals of the path checks speak the words of dismiss', () => {
  const alpha = copyOf('alpha');
  const AGAIN = 'Run "factory dismiss alpha" again.';

  it('says dismiss in the failure for a work copy that is not a folder', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.dirs.delete(alpha);
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.message).toBe(`the work copy ${alpha} of the worker alpha is not a folder`);
    expect(error.hint).toBe(`Restore the folder. ${AGAIN}`);
  });

  it('says dismiss in the failure for a project that the config does not list', async () => {
    const made = await make({ workers: [{ id: 'alpha', project: 'api' }] });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.message).toBe('the project api of the worker alpha is not in the config of this node');
    expect(error.hint).toBe(`Add the project to the config. ${AGAIN}`);
  });

  it('says dismiss in the stop for a .git entry that does not name the folder of the clone', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    made.deps.seed(`${alpha}/.git`, 'not a link to a git folder\n');
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.message).toBe(
      `the file .git of the work copy ${alpha} of the worker alpha does not name the folder that the clone ${cloneOf('web')} keeps for it, so dismiss runs no git command there`,
    );
    expect(error.hint).toBe(`Check the file .git in the work copy. ${AGAIN}`);
  });

  it('says dismiss in the stop for a clone that lies inside the work copy', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [cloneOf('web')]: alpha } });
    const error = await errorOf(made, { words: ['alpha'], yes: true });
    expect(error.message).toBe(
      `the clone ${cloneOf('web')} of the project web lies inside the work copy of the worker alpha, so dismiss does not free it`,
    );
    expect(error.hint).toBe(`Check the path of the project in the config. ${AGAIN}`);
  });

  it('says dismiss in the stop for a work copy whose real path leaves work-copies/', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], links: { [`${HOME}/work-copies/web`]: '/elsewhere/web' } });
    const hidden: FakeDeps = { ...made.deps, fs: { ...made.deps.fs, lstat: async (path) => (path === `${HOME}/work-copies/web` ? ok('dir' as const) : made.deps.fs.lstat(path)) } };
    made.deps.seedDir('/elsewhere/web/alpha');
    const result = await runDismiss(hidden, optionsOf({ words: ['alpha'], yes: true }), recipes, noLog, unknownPort);
    if (result.ok) throw new Error('the command did not fail');
    expect(result.error.message).toBe(
      `the work copy ${alpha} of the worker alpha is not a folder of work-copies/<project>/alpha, so dismiss does not free it`,
    );
    expect(result.error.hint).toBe(`Check the folder and the links in its path. ${AGAIN}`);
  });
});

describe('dismiss --idle', () => {
  const fleet: readonly Seed[] = [
    { id: 'alpha' },
    { id: 'beta' },
    { id: 'gamma', project: 'api' },
    { id: 'delta', recent: true },
    { id: 'eps' },
  ];
  const items = { alpha: NONE, beta: NONE, gamma: NONE, delta: NONE, eps: busyWith('item 3') };
  const config = withProject(sampleConfig(), 'api');

  const idleFleet = (change: Partial<Setup> = {}): Promise<Made> => make({ workers: fleet, config, ...change });

  it('lists the idle workers with their state and whether the work is pushed, and changes nothing (TP-58)', async () => {
    const made = await idleFleet({ git: { status: { [copyOf('beta')]: ' M b.ts\0' } } });
    const output = await outputOf(made, { idle: true }, portOf(items));
    const rows = rowsOf(output, 3);
    expect(rows[0]).toEqual(Object.values(dismissWords.columns));
    expect(rows.slice(1)).toEqual([
      ['alpha', 'web', 'at prompt', 'yes', '0'],
      ['beta', 'web', 'at prompt', 'no', '-'],
      ['gamma', 'api', 'at prompt', 'yes', '0'],
    ]);
    expect(output.failed).toBe(false);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
    expect(made.deps.prompts).toEqual([]);
  });

  describe('the ignored files in the table (TP-29)', () => {
    const FILES = ['cache/run.log', 'dist/'];
    const MANY = Array.from({ length: dismissWords.maxIgnoredShown + 4 }, (_, index) => `cache/file-${String(index).padStart(2, '0')}.log`);

    it('shows the count of the ignored files that the free of each worker deletes', async () => {
      const made = await idleFleet({ git: { ignoredFiles: { [copyOf('alpha')]: FILES } } });
      const output = await outputOf(made, { idle: true }, portOf(items));
      expect(rowsOf(output, 3)[0]).toEqual(['ID', 'PROJECT', 'STATE', 'PUSHED', 'IGNORED']);
      expect(rowsOf(output, 3).slice(1).map((row) => [row[0], row[4]])).toEqual([
        ['alpha', '2'],
        ['beta', '0'],
        ['gamma', '0'],
      ]);
      expect(output.json).toMatchObject({
        workers: expect.arrayContaining([
          expect.objectContaining({ id: 'alpha', ignoredCount: 2, ignoredMore: false }),
          expect.objectContaining({ id: 'beta', ignoredCount: 0, ignoredMore: false }),
        ]),
      });
      await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
    });

    it('says "more than" the cap for a list that reached the cap', async () => {
      const made = await idleFleet({ git: { ignoredFiles: { [copyOf('alpha')]: MANY } } });
      const output = await outputOf(made, { idle: true }, portOf(items));
      expect(rowsOf(output, 3)[1]).toEqual(['alpha', 'web', 'at prompt', 'yes', `more than ${dismissWords.maxIgnoredShown}`]);
      expect(output.json).toMatchObject({
        workers: expect.arrayContaining([expect.objectContaining({ id: 'alpha', ignoredCount: dismissWords.maxIgnoredShown, ignoredMore: true })]),
      });
    });

    it('shows no count for a worker whose work is not pushed, and reads no ignored files of it', async () => {
      const made = await idleFleet({ git: { status: { [copyOf('beta')]: ' M b.ts\0' }, ignoredFiles: { [copyOf('beta')]: FILES } } });
      const output = await outputOf(made, { idle: true }, portOf(items));
      expect(rowsOf(output, 3)[2]).toEqual(['beta', 'web', 'at prompt', 'no', '-']);
      expect(output.json).toMatchObject({ workers: expect.arrayContaining([expect.objectContaining({ id: 'beta', ignoredCount: null, ignoredMore: false })]) });
    });

    it('writes the table before it asks which workers to dismiss', async () => {
      let shown = '';
      const made = await idleFleet({
        terminal: { answer: '' },
        git: { ignoredFiles: { [copyOf('alpha')]: FILES } },
        atPrompt: (typing) => {
          shown = typing.deps.written.join('');
        },
      });
      const output = await outputOf(made, { idle: true }, portOf(items));
      expect(shown).toContain('IGNORED');
      expect(shown.split('\n').find((line) => line.startsWith('alpha'))).toMatch(/yes\s+2$/);
      expect(textOf(output)).toContain('Nothing picked');
      expect(textOf(output)).not.toContain('IGNORED');
    });

    it('shows the table once also after a pick: the free lines follow it', async () => {
      const made = await idleFleet({ terminal: { answer: 'alpha' }, git: { ignoredFiles: { [copyOf('alpha')]: FILES } } });
      const output = await outputOf(made, { idle: true }, portOf(items));
      expect(made.deps.written.join('').match(/IGNORED/g)).toHaveLength(1);
      expect(textOf(output)).toContain('The removal deleted 2 ignored files: cache/run.log, dist/.');
    });
  });

  it('says so when no worker is idle', async () => {
    const made = await idleFleet();
    const output = await outputOf(made, { idle: true });
    expect(textOf(output)).toContain('No idle');
    expect(output.failed).toBe(false);
  });

  const fetchedBy = (made: Made): string[] => made.git.calls.filter((call) => call.args[2] === 'fetch').map((call) => call.args[1] ?? '').sort();

  it('fetches once for each clone to list the workers (TP-60)', async () => {
    const made = await idleFleet();
    await outputOf(made, { idle: true }, portOf(items));
    expect(fetchedBy(made)).toEqual([cloneOf('api'), cloneOf('web')]);
  });

  it('fetches again, once for each clone of a pick, after the pick, so the pushed test judges the remote of that time (TP-60)', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha beta' } });
    await outputOf(made, { idle: true }, portOf(items));
    expect(fetchedBy(made)).toEqual([cloneOf('api'), cloneOf('web'), cloneOf('web')]);
  });

  it('only lists with no terminal window, and tells the owner how to pick', async () => {
    const made = await idleFleet();
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.failed).toBe(false);
    expect(textOf(output)).toContain('terminal window');
    expect(made.deps.prompts).toEqual([]);
  });

  it('ends only the panes that the owner picks on a terminal window, and frees those workers (TP-58)', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha gamma' } });
    const pane = (id: string) => paneOf(made, id).pid;
    const [alphaPid, gammaPid] = [pane('alpha'), pane('gamma')];
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.failed).toBe(false);
    expect(made.deps.prompts).toHaveLength(1);
    expect(made.deps.terminated.sort()).toEqual([alphaPid, gammaPid].sort());
    for (const id of ['beta', 'delta', 'eps']) {
      expect(hasPane(made, id)).toBe(true);
      expect(await recordState(made, id)).toBe('valid');
    }
    for (const id of ['alpha', 'gamma']) {
      expect(hasPane(made, id)).toBe(false);
      expect(await recordState(made, id)).toBe('absent');
    }
    expect(removals(made).sort()).toEqual([`worktree remove -- ${copyOf('alpha')}`, `worktree remove -- ${copyOf('gamma', 'api')}`].sort());
  });

  it('names the count and the first paths of the ignored files that each free deletes, and carries them in the json', async () => {
    const alphaFiles = ['cache/run.log', 'dist/'];
    const gammaFiles = ['.env.local'];
    const made = await idleFleet({
      terminal: { answer: 'alpha gamma' },
      git: { ignoredFiles: { [copyOf('alpha')]: alphaFiles, [copyOf('gamma', 'api')]: gammaFiles } },
    });
    const output = await outputOf(made, { idle: true }, portOf(items));
    const text = textOf(output);
    expect(output.failed).toBe(false);
    expect(text).toContain('The removal deleted 2 ignored files: cache/run.log, dist/.');
    expect(text).toContain('The removal deleted 1 ignored file: .env.local.');
    expect(output.json).toMatchObject({
      freed: true,
      workers: expect.arrayContaining([
        expect.objectContaining({ id: 'alpha', ignored: alphaFiles }),
        expect.objectContaining({ id: 'gamma', ignored: gammaFiles }),
      ]),
    });
    expect(removals(made)).toHaveLength(2);
  });

  it('changes nothing for an empty answer', async () => {
    const made = await idleFleet({ terminal: { answer: '   ' } });
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(textOf(output)).toContain('Nothing picked');
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });

  it('keeps the pane of a picked worker whose work is not pushed, prints STUCK, and still frees the others', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha beta' }, git: { status: { [copyOf('beta')]: ' M b.ts\0' } } });
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(1);
    expect(output.lines.filter((line) => line.text.startsWith(dismissWords.stuck))).toHaveLength(1);
    expect(hasPane(made, 'beta')).toBe(true);
    expect(await recordState(made, 'beta')).toBe('valid');
    expect(hasPane(made, 'alpha')).toBe(false);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it('reads the state of the workers again after the pick, and refuses a pick that turned busy while the owner typed, with nothing ended (TP-59)', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha beta' }, atPrompt: (turned) => turned.turnBusy('alpha') });
    const error = await errorOf(made, { idle: true }, portOf(items));
    expect(error.kind).toBe('failure');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('alpha');
    expect(error.hint).toContain('dismiss --idle');
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
    expect(hasPane(made, 'alpha')).toBe(true);
    expect(hasPane(made, 'beta')).toBe(true);
  });

  it('checks the pushed test again after the pick: work that the owner left changed while typing keeps its pane, and the others are freed (TP-54)', async () => {
    const status: Record<string, string> = {};
    const made = await idleFleet({
      terminal: { answer: 'alpha beta' },
      git: { status },
      atPrompt: () => {
        status[copyOf('beta')] = '?? late.md\0';
      },
    });
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(1);
    expect(output.lines.filter((line) => line.text.startsWith(dismissWords.stuck)).map((line) => line.text).join('\n')).toContain('late.md');
    expect(hasPane(made, 'beta')).toBe(true);
    expect(await recordState(made, 'beta')).toBe('valid');
    expect(hasPane(made, 'alpha')).toBe(false);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it.each<[string, string, Seed, string]>([
    ['a worker that is not listed', 'ghost', { id: 'alpha' }, 'status'],
    ['a worker that is not idle', 'delta', { id: 'delta', recent: true }, 'status'],
    ['a busy worker', 'alpha', { id: 'alpha', event: 'UserPromptSubmit' }, 'dismiss --idle'],
    ['a worker whose state is not known', 'alpha', { id: 'alpha', event: null, percentOnly: true }, 'status'],
    ['a worker with no live pane', 'alpha', { id: 'alpha', pane: false }, 'status'],
  ])('refuses the pick of %s with a remedy, exit 1, and ends nothing (TP-59)', async (_name, pick, seed, remedy) => {
    const made = await make({ workers: [seed, { id: 'zed' }], terminal: { answer: `${pick} zed` } });
    const error = await errorOf(made, { idle: true }, portOf({ alpha: NONE, delta: NONE, zed: NONE }));
    expect(error.kind).toBe('failure');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(remedy);
    await expectNothingChanged(made, [seed.id, 'zed']);
    expect(hasPane(made, 'zed')).toBe(true);
  });

  it('does not list a worker with no live pane, or a state that is not known', async () => {
    const made = await make({
      workers: [{ id: 'alpha', pane: false }, { id: 'beta', event: null, percentOnly: true }],
    });
    const output = await outputOf(made, { idle: true }, portOf({ alpha: NONE, beta: NONE }));
    expect(textOf(output)).toContain('No idle');
    expect(output.json).toMatchObject({ workers: [] });
  });

  describe('the work item gates the list and the pick (TP-28)', () => {
    const TWO: readonly Seed[] = [{ id: 'alpha' }, { id: 'beta' }];

    it('lists no worker with open work and no worker with an unknown work item, though each is idle', async () => {
      const made = await make({ workers: [...TWO, { id: 'gamma' }] });
      const output = await outputOf(made, { idle: true }, portOf({ alpha: NONE, beta: busyWith('item 3') }));
      expect(rowsOf(output, 1).slice(1)).toEqual([['alpha', 'web', 'at prompt', 'yes', '0']]);
      expect(output.json).toMatchObject({ workers: [{ id: 'alpha' }] });
    });

    it('lists a worker with a known work item and no open work, whatever else the board holds of it', async () => {
      const made = await make({ workers: TWO });
      const done = knownItem(null, { closed: ['B-1'], parked: ['B-2'], mergedPrHeads: [HEAD] });
      const output = await outputOf(made, { idle: true }, portOf({ alpha: done, beta: NONE }));
      expect(output.json).toMatchObject({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    });

    it('refuses the pick of an idle worker that has open work, and ends nothing', async () => {
      const made = await make({ workers: TWO, terminal: { answer: 'alpha beta' } });
      const error = await errorOf(made, { idle: true }, portOf({ alpha: busyWith('item 3'), beta: NONE }));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('alpha');
      await expectNothingChanged(made, ['alpha', 'beta']);
    });

    it('refuses the pick of an idle worker that has an unknown work item, and ends nothing', async () => {
      const made = await make({ workers: TWO, terminal: { answer: 'alpha beta' } });
      const error = await errorOf(made, { idle: true }, portOf({ beta: NONE }));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('alpha');
      await expectNothingChanged(made, ['alpha', 'beta']);
    });

    it('reads the work items again at the pick, and refuses a worker whose work item is unknown then', async () => {
      let reads = 0;
      const port: WorkItemPort = {
        itemsOf: async (_deps, _home, ids) => {
          reads += 1;
          return ok(new Map(reads === 1 ? ids.map((id) => [id, NONE] as const) : []));
        },
      };
      const made = await make({ workers: TWO, terminal: { answer: 'alpha' } });
      const error = await errorOf(made, { idle: true }, port);
      expect(reads).toBe(2);
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('alpha');
      await expectNothingChanged(made, ['alpha', 'beta']);
    });
  });

  it('lists, then stops with exit 4 in a factory session, and asks nothing (TP-60)', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha' }, env: { FACTORY_SESSION: 'demo' } });
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(4);
    expect(textOf(output)).toContain('alpha');
    expect(textOf(output)).toContain('outside');
    expect(made.deps.prompts).toEqual([]);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });

  it('stops with exit 4 in a factory session also when no worker is idle, so the exit code does not depend on the list (TP-60)', async () => {
    const made = await idleFleet({ env: { FACTORY_SESSION: 'demo' } });
    const output = await outputOf(made, { idle: true });
    expect(textOf(output)).toContain('No idle');
    expect(output.failed).toBe(true);
    expect(output.exitCode).toBe(4);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });

  it('ends nothing when another folder owns the session of the node, so that session keeps running (TP-59)', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha' }, tmux: { sessions: { [NODE]: '/other/node' } } });
    const error = await errorOf(made, { idle: true }, portOf(items));
    expect(error.kind).toBe('safety');
    expect(made.tmux.sessions().has(NODE)).toBe(true);
    expect(made.deps.prompts).toEqual([]);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });

  it('reports a json object with the idle workers and what the owner picked', async () => {
    const made = await idleFleet({ terminal: { answer: 'alpha' } });
    const output = await outputOf(made, { idle: true }, portOf(items));
    expect(output.json).toMatchObject({ schema: schemaIds.dismiss, idle: true });
    expect(JSON.stringify(output.json)).toContain('alpha');
  });
});

describe('dismiss --idle: the work items come from the board (TP-44, TP-64)', () => {
  const BOARD_FILE = join(layoutOf(HOME).stateDir, files.board);
  const WORKERS: readonly Seed[] = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }];
  /** Alpha has no item, beta has an item in progress, and gamma has a closed item. */
  const BOARD = boardText([itemRecord('B-1', { status: 'doing', lane: 'beta' }), itemRecord('B-2', { status: 'done', lane: 'gamma' })]);

  const withBoard = async (text: string | undefined, change: Partial<Setup> = {}): Promise<Made> => {
    const made = await make({ workers: WORKERS, config: sampleConfigWithBoard(), ...change });
    if (text !== undefined) made.deps.seed(BOARD_FILE, text);
    return made;
  };

  /** The ids in the rows of the table, which are the lines after the title line that start with a worker id. */
  const idsOf = (output: CommandOutput): string[] =>
    output.lines.slice(1).flatMap((line) => WORKERS.filter((worker) => line.text.startsWith(worker.id)).map((worker) => worker.id));

  const BOARD_PORT = boardWorkItems(recipes);

  it('M5-1b TP-44 lists the workers that the board says have no open work, and not the worker with an item in progress', async () => {
    const made = await withBoard(BOARD);
    const output = await outputOf(made, { idle: true }, BOARD_PORT);
    expect(idsOf(output)).toEqual(['alpha', 'gamma']);
    expect(output.warnings).toEqual([]);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });

  it('M5-1b TP-44 gives the board to the command line: dismiss --idle through runCli lists the idle workers', async () => {
    const made = await withBoard(BOARD);
    const sink = captureSink();
    expect(await runCli(['dismiss', '--idle', '--home', HOME, '--json'], made.deps, sink)).toBe(0);
    const json: { readonly workers: readonly { readonly id: string }[] } = JSON.parse(sink.out.join(''));
    expect(json.workers.map((worker) => worker.id)).toEqual(['alpha', 'gamma']);
  });

  it('M5-1b TP-44 lists no worker when the setup has no board block', async () => {
    const made = await withBoard(BOARD, { config: sampleConfig() });
    const output = await outputOf(made, { idle: true }, BOARD_PORT);
    expect(textOf(output)).toContain('No idle');
    expect(output.warnings).toEqual([]);
  });

  it.each([
    ['a board file that is not there', undefined],
    ['a board file that is not JSON', 'not json'],
  ])('M5-1b TP-44 lists no worker, with a warning that names the board file, for %s', async (_name, text) => {
    const made = await withBoard(text);
    const output = await outputOf(made, { idle: true }, BOARD_PORT);
    expect(textOf(output)).toContain('No idle');
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain(files.board);
  });

  it('M5-1b TP-64 reads the board file once to list the idle workers, and once more just before the stops', async () => {
    const listed = await withBoard(BOARD);
    const listReads = countReadsOf(listed.deps, BOARD_FILE);
    await runDismiss(listReads.deps, optionsOf({ idle: true }), recipes, noLog, BOARD_PORT);
    expect(listReads.count()).toBe(1);
    const picked = await withBoard(BOARD, { terminal: { answer: 'alpha' } });
    const pickReads = countReadsOf(picked.deps, BOARD_FILE);
    const result = await runDismiss(pickReads.deps, optionsOf({ idle: true }), recipes, noLog, BOARD_PORT);
    expect(result.ok).toBe(true);
    expect(pickReads.count()).toBe(2);
  });

  it('M5-1b TP-44 refuses a pick of a worker that got an item in progress while the owner typed, with nothing ended', async () => {
    const made = await withBoard(BOARD, {
      terminal: { answer: 'alpha gamma' },
      atPrompt: (typing) => typing.deps.seed(BOARD_FILE, boardText([itemRecord('B-1', { status: 'doing', lane: 'alpha' })])),
    });
    const error = await errorOf(made, { idle: true }, BOARD_PORT);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('alpha');
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
  });
});

describe('the accepted heads of the pushed test (TP-38)', () => {
  const alpha = copyOf('alpha');
  /** The merge commit of a squash merge: a commit that the work copy never held. */
  const MERGE = 'c'.repeat(40);
  /** The remote dropped the branch of the worker after the squash merge, and its head is not below the default branch. */
  const squashed: GitFixture = {
    repos: { [cloneOf('web')]: { originHead: 'origin/main' } },
    remotes: { [cloneOf('web')]: { copies: { main: MERGE } } },
  };

  const planOf = async (made: Made): Promise<DismissPlan> => {
    const plan = await planDismiss(made.deps, HOME, sampleConfig(), { id: 'alpha', project: 'web' });
    if (!plan.ok) throw new Error(plan.error.message);
    const fetched = await fetchClone(made.deps, plan.value);
    if (!fetched.ok) throw new Error(fetched.error.message);
    return plan.value;
  };

  const reasonsOf = async (made: Made, accepted?: readonly string[]): Promise<readonly string[]> => {
    const reasons = await unpushedReasons(made.deps, await planOf(made), accepted);
    if (!reasons.ok) throw new Error(reasons.error.message);
    return reasons.value;
  };

  it('stops a head that is on no remote branch when no head is accepted, as the owner path does', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: squashed });
    expect(await reasonsOf(made)).toEqual([expect.stringContaining('is not on the remote')]);
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.exitCode).toBe(1);
    expect(output.lines.some((line) => line.text.startsWith(dismissWords.stuck))).toBe(true);
    await expectNothingChanged(made, ['alpha']);
  });

  it('passes a head that equals an accepted head', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: squashed });
    expect(await reasonsOf(made, [OLDER, HEAD])).toEqual([]);
  });

  it('stops a head that is not an accepted head, the merge commit included', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: squashed });
    expect(await reasonsOf(made, [MERGE])).toEqual([expect.stringContaining('is not on the remote')]);
    expect(await reasonsOf(made, [])).toEqual([expect.stringContaining('is not on the remote')]);
  });

  it('does not clear the clean test: an accepted head with a changed file or a stash entry is still stuck', async () => {
    const dirty = await make({ workers: [{ id: 'alpha' }], git: { ...squashed, status: { [alpha]: ' M src/changed.ts\0' } } });
    expect(await reasonsOf(dirty, [HEAD])).toEqual([expect.stringContaining('src/changed.ts')]);
    const stashed = await make({ workers: [{ id: 'alpha' }], git: { ...squashed, stashes: { [cloneOf('web')]: 1 } } });
    expect(await reasonsOf(stashed, [HEAD])).toEqual([expect.stringContaining('stash')]);
  });

  it('does not clear a work copy with no commit', async () => {
    const made = await make({ workers: [{ id: 'alpha' }], git: { ...squashed, heads: {} } });
    expect(await reasonsOf(made, [HEAD])).toEqual(['the work copy has no commit']);
  });
});

describe('freeWorker: the check before the removal', () => {
  const requestOf = async (made: Made, beforeRemoval?: NonNullable<FreeRequest['beforeRemoval']>): Promise<FreeRequest> => {
    const plan = await planDismiss(made.deps, HOME, sampleConfig(), { id: 'alpha', project: 'web' });
    if (!plan.ok) throw new Error(plan.error.message);
    const panes = await readPanes(made.deps, NODE, HOME);
    if (!panes.ok) throw new Error(panes.error.message);
    return { home: HOME, session: NODE, plan: plan.value, panes: panes.value, lineSession: made.sessions.get('alpha') ?? null, ...(beforeRemoval === undefined ? {} : { beforeRemoval }) };
  };

  it('runs after the pane ends and before the work copy is removed', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const seen: string[][] = [];
    const freed = await freeWorker(made.deps, await requestOf(made, async () => (seen.push([...made.events]), ok(undefined))));
    expect(freed.ok).toBe(true);
    expect(seen).toEqual([['terminate']]);
    expect(made.events).toEqual(['terminate', 'worktree-remove']);
    expect(await recordState(made, 'alpha')).toBe('absent');
  });

  it('keeps the work copy and the record when the check fails, and names what ended before', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const freed = await freeWorker(made.deps, await requestOf(made, async () => failure('the board changed')));
    expect(freed.ok).toBe(false);
    if (freed.ok) return;
    expect(freed.error.kind).toBe('failure');
    expect(exitCodeOf[freed.error.kind]).toBe(1);
    expect(freed.error.message).toContain('the board changed');
    expect(freed.error.message).toContain('Done before this fault: ended the pane');
    expect(freed.error.hint).toContain('dismiss alpha');
    expect(made.events).toEqual(['terminate']);
    expect(removals(made)).toEqual([]);
    expect(await recordState(made, 'alpha')).toBe('valid');
    expect(lineExists(made, 'alpha')).toBe(true);
  });

  it('keeps the remedy that the check gives', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    const freed = await freeWorker(made.deps, await requestOf(made, async () => failure('the board changed', 'Ask the owner.')));
    expect(!freed.ok && freed.error.hint).toBe('Ask the owner.');
  });

  it('runs no check when none is given, so the owner path frees as before', async () => {
    const made = await make({ workers: [{ id: 'alpha' }] });
    expect((await freeWorker(made.deps, await requestOf(made))).ok).toBe(true);
    expect(made.events).toEqual(['terminate', 'worktree-remove']);
  });
});

describe('dismiss ID --closed: the in-session free of a finished worker (TP-32 to TP-39)', () => {
  const BOARD_FILE = join(layoutOf(HOME).stateDir, files.board);
  const BOARD_PORT = boardWorkItems(recipes);
  const alpha = copyOf('alpha');
  const inbox = workerPathsOf(HOME, 'alpha').inboxDir;
  const MERGE = 'c'.repeat(40);

  /** The board of a worker that finished: its one item is closed. */
  const CLOSED = boardText([itemRecord('B-1', { status: 'done', lane: 'alpha' })]);
  /** The caller is the coordinator pane of the node: the env of its pane, and the start command that `start` gives it. */
  const AS_COORDINATOR: Partial<Setup> = {
    tmux: { coordinatorCommands: { [NODE]: coordinatorWordsOf(HOME, NODE) } },
    env: { TMUX_PANE: COORDINATOR_PANE, FACTORY_SESSION: NODE },
  };

  interface Logged {
    readonly input: DecisionLogInput;
    /** The steps that changed the machine before the row was written. */
    readonly eventsBefore: readonly string[];
  }

  interface World {
    readonly made: Made;
    readonly rows: readonly Logged[];
    readonly log: DecisionLogPort;
  }

  /**
   * A node with a board that holds `board`, the worker alpha, and a decision log that keeps its rows. `between` runs when the row is
   * written: it stands for a change of the machine after the checks and before the removal.
   */
  const world = async (change: Partial<Setup> = {}, board: string | null = CLOSED, between?: (made: Made) => void): Promise<World> => {
    const made = await make({ workers: [{ id: 'alpha' }], config: sampleConfigWithBoard(), ...AS_COORDINATOR, ...change });
    if (board !== null) made.deps.seed(BOARD_FILE, board);
    const rows: Logged[] = [];
    const log: DecisionLogPort = {
      log: async (_deps, _home, _config, input) => {
        rows.push({ input, eventsBefore: [...made.events] });
        between?.(made);
        return ok('D-7');
      },
    };
    return { made, rows, log };
  };

  const closedOutput = (given: World, change: Partial<DismissOptions> = {}): Promise<CommandOutput> =>
    outputOf(given.made, { words: ['alpha'], closed: true, ...change }, BOARD_PORT, given.log);
  const closedError = (given: World, change: Partial<DismissOptions> = {}): Promise<CliError> =>
    errorOf(given.made, { words: ['alpha'], closed: true, ...change }, BOARD_PORT, given.log);

  /** The worker is as it was: its pane lives, its copy and its record stay, and no row is written. */
  const expectKept = async (given: World): Promise<void> => {
    await expectNothingChanged(given.made, ['alpha']);
    expect(given.rows).toEqual([]);
    expect(hasPane(given.made, 'alpha')).toBe(true);
    expect(lineExists(given.made, 'alpha')).toBe(true);
  };

  it('TP-32 writes one decision row that the coordinator decides, and then frees the worker', async () => {
    const given = await world({ git: { ignoredFiles: { [alpha]: ['cache/a.log'] } } });
    given.made.deps.seed(`${inbox}/review.md`, 'Looks fine.\n');
    const output = await closedOutput(given);
    expect(output.failed).toBe(false);
    expect(given.rows).toEqual([
      {
        eventsBefore: [],
        input: {
          title: 'Free the worker alpha',
          decider: requestDeciders.coordinator,
          decision: `Free the worker alpha. Closed items: B-1. Pushed head: ${HEAD}. Ignored files: 1. Inbox files: 1.`,
        },
      },
    ]);
    expect(given.made.events).toEqual(['terminate', 'worktree-remove']);
    expect(await recordState(given.made, 'alpha')).toBe('absent');
    expect(lineExists(given.made, 'alpha')).toBe(false);
    const text = textOf(output);
    expect(text).toContain('Logged the decision D-7 to free the worker alpha.');
    expect(text).toContain(`Removed the work copy ${alpha}.`);
    expect(text).toContain('The removal deleted 1 ignored file: cache/a.log.');
    expect(text).toContain('The removal deleted 1 inbox file: review.md.');
    expect(output.json).toMatchObject({
      schema: schemaIds.dismiss,
      closed: true,
      freed: true,
      workers: [expect.objectContaining({ id: 'alpha', ended: true, ignored: ['cache/a.log'], inbox: ['review.md'] })],
    });
  });

  it('keeps the other workers: their records and panes stay', async () => {
    const given = await world({ workers: [{ id: 'alpha' }, { id: 'beta' }] });
    await closedOutput(given);
    expect(await recordState(given.made, 'beta')).toBe('valid');
    expect(hasPane(given.made, 'beta')).toBe(true);
  });

  it.each<[string, string | null, Partial<Setup>]>([
    ['TP-33 an item that was assigned and then unassigned', boardText([itemRecord('B-1', { status: 'doing', [boardKeys.unassignedFrom]: ['alpha'] })]), {}],
    [
      'TP-34 an old closed item that was assigned after an unassign',
      boardText([itemRecord('B-1', { status: 'open', [boardKeys.unassignedFrom]: ['alpha'] }), itemRecord('B-2', { status: 'done', lane: 'alpha' })]),
      {},
    ],
    ['TP-34 a worker that no item names', boardText([itemRecord('B-1', { status: 'done', lane: 'beta' })]), {}],
    ['TP-36 a setup with no worker field', CLOSED, { config: sampleConfig() }],
    ['TP-36 a board that cannot be read', null, {}],
    ['TP-36 a board that is not JSON', 'not json', {}],
  ])('%s is refused with exit 4, the owner remedy, and nothing is written or freed', async (_name, board, change) => {
    const given = await world(change, board);
    const error = await closedError(given);
    expect(error.kind).toBe('safety');
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('dismiss alpha --yes');
    expect(error.hint).toContain('terminal window');
    await expectKept(given);
  });

  it('TP-35 refuses a worker that still holds an open item, and frees nothing', async () => {
    const given = await world({}, boardText([itemRecord('B-1', { status: 'doing', lane: 'alpha' }), itemRecord('B-2', { status: 'done', lane: 'alpha' })]));
    const error = await closedError(given);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('open work: B-1');
    await expectKept(given);
  });

  it('TP-36 refuses a caller in a worker pane before it reads the board or the work copy', async () => {
    const given = await world({ env: { TMUX_PANE: '%3', FACTORY_SESSION: NODE } });
    const reads = countReadsOf(given.made.deps, BOARD_FILE);
    const result = await runDismiss(reads.deps, optionsOf({ words: ['alpha'], closed: true }), recipes, given.log, BOARD_PORT);
    expect(!result.ok && result.error.kind).toBe('usage');
    expect(reads.count()).toBe(0);
    expect(given.made.git.commands()).toEqual([]);
    await expectKept(given);
  });

  it('is a flag of the command line: it reaches the caller rule, whose remedy names the closed command', async () => {
    const given = await world({ env: { TMUX_PANE: undefined, FACTORY_SESSION: undefined } });
    const sink = captureSink();
    expect(await runCli(['dismiss', 'alpha', '--closed', '--home', HOME], given.made.deps, sink)).toBe(2);
    expect(sink.errors.join('')).toContain('factory dismiss alpha --closed');
    expect(given.made.git.commands()).toEqual([]);
  });

  it('TP-36 refuses a caller outside every session before it reads the board or the work copy', async () => {
    const given = await world({ env: { TMUX_PANE: undefined, FACTORY_SESSION: undefined } });
    const error = await closedError(given);
    expect(error.kind).toBe('usage');
    expect(given.made.git.commands()).toEqual([]);
    await expectKept(given);
  });

  it.each<[string, Partial<DismissOptions>]>([
    ['--yes', { yes: true }],
    ['--idle', { idle: true, words: [] }],
    ['no id', { words: [] }],
    ['two ids', { words: ['alpha', 'beta'] }],
  ])('TP-39 takes %s as a usage error and runs no program', async (_name, change) => {
    const given = await world();
    const error = await closedError(given, change);
    expect(error.kind).toBe('usage');
    expect(given.made.git.commands()).toEqual([]);
    expect(given.made.tmux.commands()).toEqual([]);
    await expectKept(given);
  });

  it('prints STUCK with the remedy of the closed path for work that is not clean, writes no row and frees nothing', async () => {
    const given = await world({ git: { status: { [alpha]: ' M src/page.ts\0' } } });
    const output = await closedOutput(given);
    expect(output.exitCode).toBe(1);
    expect(output.failed).toBe(true);
    expect(output.lines.filter((line) => line.text.startsWith(dismissWords.stuck)).map((line) => line.text).join('\n')).toContain('src/page.ts');
    expect(textOf(output)).toContain('dismiss alpha --closed');
    expect(output.json).toMatchObject({ closed: true, freed: false });
    await expectKept(given);
  });

  it('TP-38 frees a squashed branch that the remote dropped only when its head is the recorded head', async () => {
    const squashed: GitFixture = {
      repos: { [cloneOf('web')]: { originHead: 'origin/main' } },
      remotes: { [cloneOf('web')]: { copies: { main: MERGE } } },
    };
    const recorded = (head: string): string => boardText([itemRecord('B-1', { status: 'done', lane: 'alpha', [boardKeys.mergedPrHead]: head })]);

    const same = await world({ git: squashed }, recorded(HEAD));
    expect((await closedOutput(same)).failed).toBe(false);
    expect(same.rows).toHaveLength(1);
    expect(await recordState(same.made, 'alpha')).toBe('absent');

    const other = await world({ git: squashed }, recorded(MERGE));
    const stuck = await closedOutput(other);
    expect(stuck.exitCode).toBe(1);
    expect(textOf(stuck)).toContain(`${dismissWords.stuck} the branch worker/alpha is not on the remote`);
    await expectKept(other);

    const none = await world({ git: squashed });
    expect((await closedOutput(none)).exitCode).toBe(1);
    await expectKept(none);
  });

  it('TP-38 keeps the owner yes path as it was for the same squashed branch', async () => {
    const made = await make({
      workers: [{ id: 'alpha' }],
      git: { repos: { [cloneOf('web')]: { originHead: 'origin/main' } }, remotes: { [cloneOf('web')]: { copies: { main: MERGE } } } },
    });
    const output = await outputOf(made, { words: ['alpha'], yes: true });
    expect(output.exitCode).toBe(1);
    expect(textOf(output)).toContain(`${dismissWords.stuck} the branch worker/alpha is not on the remote`);
    await expectNothingChanged(made, ['alpha']);
  });

  describe('the check right before the removal (TP-37)', () => {
    const expectStopped = async (given: World, reason: string): Promise<void> => {
      const error = await closedError(given);
      expect(error.kind).toBe('failure');
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(reason);
      expect(error.message).toContain('the worker alpha was not freed');
      expect(error.message).toContain('The decision D-7 stays in the log');
      expect(given.rows).toHaveLength(1);
      expect(removals(given.made)).toEqual([]);
      expect(await recordState(given.made, 'alpha')).toBe('valid');
      expect(lineExists(given.made, 'alpha')).toBe(true);
    };

    it('stops when the board gives the worker an open item after the first check', async () => {
      const given = await world({}, CLOSED, (made) =>
        made.deps.seed(BOARD_FILE, boardText([itemRecord('B-1', { status: 'done', lane: 'alpha' }), itemRecord('B-2', { status: 'doing', lane: 'alpha' })])),
      );
      await expectStopped(given, 'open work: B-2');
    });

    it('stops when the board cannot be read the second time', async () => {
      const given = await world({}, CLOSED, (made) => made.deps.seed(BOARD_FILE, 'not json'));
      await expectStopped(given, 'cannot read the board');
    });

    it('stops when the work copy gets a commit that the remote lacks after the first check', async () => {
      const heads: Record<string, string> = { [alpha]: HEAD };
      const given = await world({ git: { heads } }, CLOSED, () => {
        heads[alpha] = OLDER;
      });
      await expectStopped(given, `the head of the work copy moved from ${HEAD} to ${OLDER} after the first check`);
    });

    it('stops when the head moves after the first check to a commit that the copy of the remote branch also holds', async () => {
      const heads: Record<string, string> = { [alpha]: HEAD };
      const given = await world({ git: { heads, ancestors: { [HEAD]: [OLDER] } } }, CLOSED, () => {
        heads[alpha] = OLDER;
      });
      await expectStopped(given, `the head of the work copy moved from ${HEAD} to ${OLDER} after the first check`);
      expect(given.rows[0]?.input.decision).toContain(`Pushed head: ${HEAD}.`);
    });

    it('stops when the work copy gets a changed file after the first check', async () => {
      const status: Record<string, string> = {};
      const given = await world({ git: { status } }, CLOSED, () => {
        status[alpha] = ' M late.ts\0';
      });
      await expectStopped(given, 'late.ts');
    });
  });

  describe('the head that the pushed test judged', () => {
    /** The deps in which the head of the work copy moves right after the first read of it: the read of the pushed test. */
    const movingHead = (made: Made, move: () => void): FakeDeps => {
      let reads = 0;
      return {
        ...made.deps,
        run: async (command, args, options) => {
          const result = await made.deps.run(command, args, options);
          if (command === 'git' && args.includes(alpha) && args.includes('rev-parse') && args.includes('HEAD')) {
            reads += 1;
            if (reads === 1) move();
          }
          return result;
        },
      };
    };

    it('names that head in the row, and stops the free when the head moved after the test, though the new head is pushed too', async () => {
      const heads: Record<string, string> = { [alpha]: HEAD };
      const given = await world({ git: { heads, ancestors: { [HEAD]: [OLDER] } } });
      const moving = movingHead(given.made, () => {
        heads[alpha] = OLDER;
      });
      const result = await runDismiss(moving, optionsOf({ words: ['alpha'], closed: true }), recipes, given.log, BOARD_PORT);
      expect(given.rows.map((row) => row.input.decision)).toEqual([expect.stringContaining(`Pushed head: ${HEAD}.`)]);
      expect(!result.ok && result.error.message).toContain(`the head of the work copy moved from ${HEAD} to ${OLDER} after the first check`);
      expect(removals(given.made)).toEqual([]);
      expect(await recordState(given.made, 'alpha')).toBe('valid');
    });
  });

  describe('the state lock of the free', () => {
    const LOCK_FILE = join(layoutOf(HOME).locksDir, `${stateLock.name}${stateLock.lock.suffix}`);
    const lineFile = (made: Made): string => `${layoutOf(HOME).heartbeatDir}/${made.sessions.get('alpha') ?? ''}`;
    const recordDir = workerPathsOf(HOME, 'alpha').dir;
    const lockWord = (made: Made): string => (made.deps.files.has(LOCK_FILE) ? 'held' : 'free');
    /** A board writer: it takes the state lock as `commitBoardChange` does. */
    const writer = (made: Made) => (): Promise<boolean> => withStateLock(made.deps, layoutOf(HOME), async () => ok(undefined)).then((result) => result.ok);

    /** The deps that note the state of the lock at the read of the board, and before each step that removes something. */
    const lockTrail = (made: Made, trail: string[]): FakeDeps => {
      const note = (step: string): void => {
        trail.push(`${step}:${lockWord(made)}`);
      };
      return {
        ...made.deps,
        run: (command, args, options) => {
          if (command === 'git' && args.includes('worktree') && args.includes('remove')) note('remove the work copy');
          return made.deps.run(command, args, options);
        },
        fs: {
          ...made.deps.fs,
          readTextLimited: (path, maxBytes, decode) => {
            if (path === BOARD_FILE) note('read the board');
            return made.deps.fs.readTextLimited(path, maxBytes, decode);
          },
          remove: (path) => {
            if (path === lineFile(made)) note('delete the line');
            if (path === recordDir) note('delete the record');
            return made.deps.fs.remove(path);
          },
        },
      };
    };

    it('holds the lock from the second read of the board to the delete of the record, and not while the row is written', async () => {
      const given = await world();
      const trail: string[] = [];
      const log: DecisionLogPort = {
        log: async () => {
          trail.push(`write the row:${lockWord(given.made)}`);
          return ok('D-7');
        },
      };
      const result = await runDismiss(lockTrail(given.made, trail), optionsOf({ words: ['alpha'], closed: true }), recipes, log, BOARD_PORT);
      expect(result.ok).toBe(true);
      const at = trail.indexOf('write the row:free');
      expect(at).toBeGreaterThan(0);
      expect(trail.slice(0, at).every((step) => step.endsWith(':free'))).toBe(true);
      expect(trail.slice(at + 1)).toEqual([
        'read the board:held',
        'remove the work copy:held',
        'delete the line:held',
        'delete the record:held',
      ]);
      expect(lockWord(given.made)).toBe('free');
    });

    it('makes a board writer wait while the work copy is removed, so no item can name the worker before its record is gone', async () => {
      const given = await world();
      const blocked: boolean[] = [];
      const competing = writer(given.made);
      const moving: FakeDeps = {
        ...given.made.deps,
        run: async (command, args, options) => {
          if (command === 'git' && args.includes('worktree') && args.includes('remove')) blocked.push(!(await competing()));
          return given.made.deps.run(command, args, options);
        },
      };
      const result = await runDismiss(moving, optionsOf({ words: ['alpha'], closed: true }), recipes, given.log, BOARD_PORT);
      expect(result.ok).toBe(true);
      expect(blocked).toEqual([true]);
      expect(await competing()).toBe(true);
    });

    it('frees nothing more when another process holds the lock: the work copy and the record stay, and the fault names the pane that ended', async () => {
      const given = await world();
      given.made.deps.seed(LOCK_FILE, 'another-holder\n');
      const error = await closedError(given);
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('another process holds the lock');
      expect(error.message).toContain('Done before this fault: ended the pane');
      expect(error.message).toContain('The decision D-7 stays in the log');
      expect(removals(given.made)).toEqual([]);
      expect(await recordState(given.made, 'alpha')).toBe('valid');
      expect(lineExists(given.made, 'alpha')).toBe(true);
    });
  });

  it('names the owner for a removal that git refuses, and gives the coordinator no unlock, no force and no delete by hand', async () => {
    const given = await world({ git: { worktreeRemoveFails: { [cloneOf('web')]: 'fatal: cannot remove a locked working tree' } } });
    const error = await closedError(given);
    const hint = error.hint ?? '';
    expect(error.kind).toBe('failure');
    expect(hint).toContain('The owner runs "factory dismiss alpha --yes" in a terminal window outside a factory session');
    expect(hint).not.toContain('--force');
    expect(hint).not.toContain('unlock');
    expect(hint).not.toContain('by hand');
    expect(removals(given.made)).toEqual([`worktree remove -- ${alpha}`]);
    expect(await recordState(given.made, 'alpha')).toBe('valid');
  });

  it('writes no row and frees nothing when the decision log fails', async () => {
    const given = await world();
    const error = await errorOf(given.made, { words: ['alpha'], closed: true }, BOARD_PORT, noLog);
    expect(error.message).toContain('the test gives no decision log');
    await expectNothingChanged(given.made, ['alpha']);
    expect(hasPane(given.made, 'alpha')).toBe(true);
  });
});
