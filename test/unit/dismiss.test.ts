import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runDismiss, type DismissOptions } from '../../src/commands/dismiss.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { dismissWords, schemaIds, type HookEvent } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { readWorkerRecord, writeWorkerRecord } from '../../src/workers/registry.js';
import { unknownWorkItems, type WorkItem, type WorkItemPort } from '../../src/workers/work-items.js';
import { createFakeDeps, registerRoot, type FakeDeps, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture, type GitLog } from '../helpers/git-fake.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { HOME, NODE, workerPane } from '../helpers/slot-fixture.js';
import { tmuxHandler, type PaneFixture, type PaneView, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';

const HOUR_MS = 3_600_000;
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);

const NONE: WorkItem = { state: 'known', item: null };
const busyWith = (item: string): WorkItem => ({ state: 'known', item });

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

const optionsOf = (change: Partial<DismissOptions>): DismissOptions => ({ home: HOME, words: [], idle: false, yes: false, ...change });

const outputOf = async (made: Made, change: Partial<DismissOptions> = {}, port: WorkItemPort = unknownWorkItems): Promise<CommandOutput> => {
  const result = await runDismiss(made.deps, optionsOf(change), recipes, port);
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const errorOf = async (made: Made, change: Partial<DismissOptions> = {}, port: WorkItemPort = unknownWorkItems): Promise<CliError> => {
  const result = await runDismiss(made.deps, optionsOf(change), recipes, port);
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
    expect(text).toContain('and more');
    await expectNothingChanged(made, ['alpha']);
    expect(lineExists(made, 'alpha')).toBe(true);
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
  it('ends the pane, removes the work copy with no force, and deletes the record and its last-seen line, in this order (TP-53, TP-55, TP-57)', async () => {
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
    const result = await runDismiss(broken, optionsOf({ words: ['alpha'], yes: true }), recipes, unknownWorkItems);
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
    const port = item === null ? unknownWorkItems : portOf({ alpha: item });
    for (const yes of [false, true]) {
      const error = await errorOf(made, { words: ['alpha'], yes }, port);
      expect(error.kind).toBe('failure');
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
    const result = await runDismiss(hidden, optionsOf({ words: ['alpha'], yes: true }), recipes, unknownWorkItems);
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
    const result = await runDismiss(linked, optionsOf({ words: ['alpha'], yes: true }), recipes, unknownWorkItems);
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
      expect(call.args.slice(2, 8)).toEqual(['-c', 'core.fsmonitor=false', '--git-dir', adminOf('alpha'), '--work-tree', alpha]);
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
      ['alpha', 'web', 'at prompt', 'yes'],
      ['beta', 'web', 'at prompt', 'no'],
      ['gamma', 'api', 'at prompt', 'yes'],
    ]);
    expect(output.failed).toBe(false);
    await expectNothingChanged(made, ['alpha', 'beta', 'gamma']);
    expect(made.deps.prompts).toEqual([]);
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
    ['a worker whose state is not known', 'alpha', { id: 'alpha', event: null, percentOnly: true }, 'pane'],
    ['a worker with no live pane', 'alpha', { id: 'alpha', pane: false }, 'dismiss alpha'],
  ])('refuses the pick of %s with a remedy, exit 1, and ends nothing (TP-59)', async (_name, pick, seed, remedy) => {
    const made = await make({ workers: [seed, { id: 'zed' }], terminal: { answer: `${pick} zed` } });
    const error = await errorOf(made, { idle: true }, portOf({ alpha: NONE, delta: NONE, zed: NONE }));
    expect(error.kind).toBe('failure');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(remedy);
    await expectNothingChanged(made, [seed.id, 'zed']);
    expect(hasPane(made, 'zed')).toBe(true);
  });

  it('lists a worker with no live pane, and an unknown state, but offers no pick for them', async () => {
    const made = await make({
      workers: [{ id: 'alpha', pane: false }, { id: 'beta', event: null, percentOnly: true }],
    });
    const output = await outputOf(made, { idle: true }, portOf({ alpha: NONE, beta: NONE }));
    expect(rowsOf(output, 2).slice(1)).toEqual([
      ['alpha', 'web', 'stopped', 'yes'],
      ['beta', 'web', 'unknown', 'yes'],
    ]);
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
