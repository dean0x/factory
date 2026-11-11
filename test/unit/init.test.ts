import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBlocks, verifyBlock } from '../../src/blocks/managed.js';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { applyInit, type InitOptions } from '../../src/commands/init.js';
import { collectSetup, decideAcceptance } from '../../src/commands/init-received.js';
import { declinedHookText, ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { Deps } from '../../src/core/deps.js';
import { instructionFileWarnings, scanInstructionFiles } from '../../src/core/instruction-files.js';
import { effectiveModes } from '../../src/core/owner-record.js';
import { ok } from '../../src/core/result.js';
import { acceptanceState, manifestHash, type ManifestEntry } from '../../src/core/setup-acceptance.js';
import { commands, env, files as fileNames, hookNames, setupAcceptance, stateGuard, values } from '../../src/names.js';
import { SHARE_LIST_BEGIN, SHARE_LIST_END, SHARE_LIST_PART } from '../../src/state/files.js';
import { guardHookText } from '../../src/state/guard.js';
import { loadState } from '../../src/state/load.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { layer2Blocks } from '../helpers/blocks.js';
import { denyMatches } from '../helpers/deny-list.js';
import { loadConfig, planInit, runInit, runUpgrade } from '../helpers/package-registry.js';
import {
  createFakeDeps,
  exited,
  FAKE_PROGRAM_ARGV,
  registerRoot,
  withFailingRemoves,
  withFailingWrites,
  withFsWatch,
  type FakeDeps,
  type FakeOptions,
} from '../helpers/fake-deps.js';
import { gitHandler, STATE_GIT, STATE_READ, type GitFixture } from '../helpers/git-fake.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const HOME = '/w/node';
/** init writes the root into the factory list as its last step, so every run needs a place for the list. */
const ENV = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
const INDEX = '/state/factory/homes.json';
/** The guard folder of the state repo after the staging folder is renamed onto the state path. */
const GUARD_FOLDER = `${HOME}/.factory/.git/${stateGuard.folder}`;
const GUARD_HOOKS = stateGuard.hookFiles.map((name) => `${GUARD_FOLDER}/${name}`);
/** The hook files as they are written, in the staging folder, before the rename. */
const STAGING_HOOKS = stateGuard.hookFiles.map((name) => `${HOME}/.factory.tmp-4242/.git/${stateGuard.folder}/${name}`);

const options = (extra: Partial<InitOptions> = {}): InitOptions => ({
  home: HOME,
  name: undefined,
  ownerName: 'Test Owner',
  ownerGithub: undefined,
  projects: [],
  yes: true,
  recipe: undefined,
  layer: undefined,
  approval: [],
  ...extra,
});

/** The options of a test about the questions of init: the yes flag is off, so init asks. */
const asking = (extra: Partial<InitOptions> = {}): InitOptions => options({ yes: false, ...extra });

const setup = (fixture: GitFixture = {}, extra: FakeOptions = {}) => {
  const { handler, log } = gitHandler(fixture);
  const deps = createFakeDeps({ cwd: '/w', run: handler, env: ENV, ...extra });
  return { deps, log };
};

const snapshot = (deps: FakeDeps): string =>
  JSON.stringify([[...deps.files.entries()].sort(), [...deps.dirs].sort()]);

const failingWrite = (deps: Deps, suffix: string): Deps => withFailingWrites(deps, (path) => path.endsWith(suffix));

const messageOf = (result: { ok: boolean; error?: { message: string; hint?: string } }): string =>
  `${result.error?.message ?? ''} ${result.error?.hint ?? ''}`;

const APPROVAL_QUESTION = 'Approval point ';
/** The question about the hook settings starts with the line that shows the change. */
const HOOK_QUESTION = 'This changes the settings of Claude Code';
const isOtherQuestion = (question: string): boolean => !question.startsWith(APPROVAL_QUESTION) && !question.startsWith(HOOK_QUESTION);

/** A person who answers the question about the home with `answer`, takes the default for each approval point, and says no to the hook. */
const answerHome = (answer: string) => (question: string) =>
  ok(question.startsWith(APPROVAL_QUESTION) || question.startsWith(HOOK_QUESTION) ? '' : answer);

/** The questions that deps asked about the home, without the questions about the approval points and the hook settings. */
const homeQuestions = (deps: FakeDeps): string[] => deps.prompts.filter(isOtherQuestion);

/** The questions of the approval points that deps asked. */
const approvalQuestions = (deps: FakeDeps): string[] => deps.prompts.filter((question) => question.startsWith(APPROVAL_QUESTION));

describe('init: the files', () => {
  it('writes every file of the plan layout and leaves no staging folder', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);

    const expected = [
      'factory.yaml',
      'factory.local.yaml',
      '.gitignore',
      'setup/coordinator.md',
      'setup/roles/worker.md',
      'coordinator/CLAUDE.md',
      'coordinator/.claude/settings.local.json',
      ...stateGuard.hookFiles.map((name) => `.factory/.git/factory-guard/${name}`),
      '.factory/node.json',
      '.factory/roles/worker.md',
      '.factory/board.json',
      '.factory/waiting.json',
      '.factory/decision-log.json',
      '.factory/decision-profile/README-format.md',
      '.factory/decision-profile/index.md',
      '.factory/roadmaps/README.md',
      '.factory/orders/.gitkeep',
      '.factory/.gitignore',
    ];
    expect([...deps.files.keys()].sort()).toEqual(
      [...expected.map((name) => `${HOME}/${name}`), INDEX, '/state/factory/setup-acceptances.json'].sort(),
    );
    expect([...deps.dirs].some((dir) => dir.includes('.tmp-'))).toBe(false);
  });

  it('writes factory.local.yaml with mode 600, and the local keys in it only', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ ownerGithub: 'some-login' }))).ok).toBe(true);
    expect(deps.modes.get(`${HOME}/factory.local.yaml`)).toBe(0o600);
    const local = deps.files.get(`${HOME}/factory.local.yaml`) ?? '';
    const shared = deps.files.get(`${HOME}/factory.yaml`) ?? '';
    expect(local).toContain('schema: 1');
    expect(local).toContain('display: "Test Owner"');
    expect(local).toContain('github: "some-login"');
    expect(local).toContain('proxy: none');
    expect(local).toContain('children: []');
    for (const key of ['node', 'limits', 'tracker', 'recipe', 'permission_mode', 'agent', 'effort', 'model', 'idle_after']) {
      expect(local).not.toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
    expect(shared).toContain('schema: 2');
    for (const key of ['owner:', 'proxies:', 'workers:', 'approval:', 'parent:', 'children:', 'sources:', 'proxy:', 'statusline:']) {
      expect(shared).not.toContain(key);
    }
    expect(shared).not.toContain('some-login');
  });

  it('writes a config that loads, with the owner from the flag and the node id from the folder', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const config = await loadConfig(deps, HOME);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.core.node.id).toBe('node');
    expect(config.value.core.owner.display).toBe('Test Owner');
    expect(config.value.core.owner.github).toBeUndefined();
    expect(config.value.core.session.permission_mode).toBe('auto');
    expect(config.value.core.session.proxy).toBe('none');
    expect(config.value.recipe.projects).toEqual([]);
  });

  it('writes a schema 2 config: layer 1, a local tracker, the software recipe and no parent', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const config = await loadConfig(deps, HOME);
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.core.node.layer).toBe(1);
    expect(config.value.core.tracker).toEqual({ kind: 'local' });
    expect(config.value.core.approval).toEqual(sampleConfig().core.approval);
    expect(config.value.core.parent).toBeNull();
    expect(config.value.core.children).toEqual([]);
    expect(config.value.core.workers).toEqual({});
    expect(config.value.recipe).toMatchObject({ id: 'software', variant: 'plain' });
    const text = deps.files.get(`${HOME}/factory.yaml`) ?? '';
    expect(text).toContain('schema: 2');
    expect(text).toContain('recipe:\n  id: software');
  });

  it('writes node.json with the version, the creator and the block versions', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    expect(await loadState(deps, HOME)).toEqual({
      ok: true,
      value: {
        schema_version: STATE_SCHEMA_VERSION,
        created_with: FACTORY_VERSION,
        blocks: { coordinator: 3, safety: 2, worker: 2, setup: 1, 'setup-worker': 1 },
      },
    });
  });

  it('writes the managed blocks: coordinator, safety and setup in coordinator/CLAUDE.md, worker and setup-worker in roles/worker.md', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const claude = parseBlocks(deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? '');
    const worker = parseBlocks(deps.files.get(`${HOME}/.factory/roles/worker.md`) ?? '');
    expect(claude.ok && claude.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['coordinator', 'intact'],
      ['safety', 'intact'],
      ['setup', 'intact'],
    ]);
    expect(worker.ok && worker.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['worker', 'intact'],
      ['setup-worker', 'intact'],
    ]);
  });

  it('writes the initial board, waiting and decision-log files', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const read = (name: string): unknown => JSON.parse(deps.files.get(`${HOME}/.factory/${name}`) ?? 'null');
    expect(read('board.json')).toEqual({ merge: [], items: [], tracks: [] });
    expect(read('waiting.json')).toEqual({ intro: '', groups: [], items: [] });
    expect(read('decision-log.json')).toEqual({ rows: [] });
    expect(deps.files.get(`${HOME}/.factory/.gitignore`)).toBe('state/\nlocks/\nbackups/\nworkers/\n');
    expect(deps.files.get(`${HOME}/.factory/orders/.gitkeep`)).toBe('');
  });

  it('M5-1b TP-29 seeds the board with the queue key of the software recipe', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const board = JSON.parse(deps.files.get(`${HOME}/.factory/board.json`) ?? 'null') as Record<string, unknown>;
    expect(Object.keys(board)).toEqual(['merge', 'items', 'tracks']);
  });

  it('M5-1b TP-70 seeds the tracks of the board as an empty list', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const board = JSON.parse(deps.files.get(`${HOME}/.factory/board.json`) ?? 'null') as Record<string, unknown>;
    expect(board['tracks']).toEqual([]);
  });

  it('holds none of the denied words in any generated file', async () => {
    const { deps } = setup({ gh: 'some-login' });
    await runInit(deps, options({ name: 'demo' }));
    for (const [path, text] of deps.files) {
      expect({ path, found: denyMatches(text) }).toEqual({ path, found: [] });
    }
  });

  it('keeps the text of an existing coordinator/CLAUDE.md and adds the blocks at the end', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, '# My rules\n\nBe kind.\n');
    await runInit(deps, options());
    const text = deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? '';
    expect(text.startsWith('# My rules\n\nBe kind.\n\n')).toBe(true);
    const parsed = parseBlocks(text);
    expect(parsed.ok && parsed.value.map((block) => block.name)).toEqual(['coordinator', 'safety', 'setup']);
  });

  it('creates the home folder when it does not exist', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ home: '/w/new/place' }))).ok).toBe(true);
    expect(deps.files.has('/w/new/place/factory.yaml')).toBe(true);
  });

  it('uses the current folder when no home is given', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ home: undefined }))).ok).toBe(true);
    expect(deps.files.has('/w/factory.yaml')).toBe(true);
  });
});

describe('init: refusals', () => {
  it('refuses when the home already has a config file, and changes nothing', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 1\n');
    deps.seed(`${HOME}/factory.local.yaml`, 'schema: 1\n');
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('already exists');
    expect(snapshot(deps)).toBe(before);
  });

  it('treats a second init in the same home as a root that holds both config files, and refuses a flag that names a value of the root', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const before = snapshot(deps);
    const second = await runInit(deps, options());
    expect(second).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(second)).toContain('--owner-name');
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses when a state folder already exists', async () => {
    const { deps } = setup();
    deps.seedDir(`${HOME}/.factory`);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('.factory already exists');
  });

  it('refuses a home that is a file', async () => {
    const { deps } = setup();
    deps.seed(HOME, 'x');
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain(`${HOME} is not a folder`);
  });

  it('refuses a CLAUDE.md that already holds a block of the same name', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const second = setup();
    second.deps.seed(`${HOME}/coordinator/CLAUDE.md`, deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? '');
    const before = snapshot(second.deps);
    const result = await runInit(second.deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('already holds the block coordinator');
    expect(snapshot(second.deps)).toBe(before);
  });

  it('refuses a CLAUDE.md with a broken block marker', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n');
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('CLAUDE.md: line 1');
  });
});

describe('init: a new root inside a root that the factory list holds', () => {
  const refused = (result: { ok: boolean; error?: { kind: string } }): string | undefined => result.error?.kind;
  /** A root that the list holds and that still has its config file. */
  const listedRoot = (deps: FakeDeps, root: string): void => {
    deps.seed(`${root}/factory.yaml`, 'schema: 2\n');
    registerRoot(deps, root, 'listed');
  };

  it('refuses a home inside a listed root with exit 1, names both folders, and changes nothing', async () => {
    const { deps } = setup();
    listedRoot(deps, '/w');
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain(`the factory folder ${HOME} is inside the factory folder /w`);
    expect(messageOf(result)).toContain('Run "factory init" again with --home DIR to choose another folder.');
    expect(snapshot(deps)).toBe(before);
  });

  it('finds the listed root several levels up, also when the home does not exist yet', async () => {
    const { deps } = setup();
    listedRoot(deps, '/w');
    const result = await planInit(deps, options({ home: '/w/a/b/c' }));
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain('is inside the factory folder /w');
  });

  it('compares real paths: a home behind a link into a listed root is refused', async () => {
    const { deps } = setup({}, { links: { '/via': '/w/real' } });
    deps.seedDir('/w/real');
    listedRoot(deps, '/w/real');
    deps.seedDir('/via');
    const result = await runInit(deps, options({ home: '/via/node' }));
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain('is inside the factory folder /w/real');
  });

  it('ignores a listed root that no longer holds its config file', async () => {
    const { deps } = setup();
    registerRoot(deps, '/w', 'gone');
    expect((await runInit(deps, options())).ok).toBe(true);
  });

  it('accepts a home beside a listed root', async () => {
    const { deps } = setup();
    listedRoot(deps, '/w/other');
    expect((await runInit(deps, options())).ok).toBe(true);
  });

  it('accepts a home that the list holds already, and replaces its entry', async () => {
    const { deps } = setup();
    registerRoot(deps, HOME, 'old-id');
    // The folder is gone, and only the entry of the list is left.
    deps.files.delete(`${HOME}/.factory/${fileNames.nodeState}`);
    deps.dirs.delete(`${HOME}/.factory`);
    expect((await runInit(deps, options())).ok).toBe(true);
    const entries = JSON.parse(deps.files.get(INDEX) ?? 'null').homes as { home: string; id: string }[];
    expect(entries.filter((entry) => entry.home === HOME)).toEqual([expect.objectContaining({ id: 'node' })]);
  });

  it('stops before it writes anything when the factory list can not be read', async () => {
    const { deps } = setup();
    deps.seed(INDEX, 'broken');
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain(`the factory list ${INDEX} cannot be read`);
    expect(snapshot(deps)).toBe(before);
  });

  it('has no rule about a git work tree or about repos in the home: the root is a repo of its own', async () => {
    const { deps } = setup({ repos: { '/w/web': {}, '/w/web/src/node/app': {} } });
    deps.seedDir('/w/web/src');
    deps.seedDir('/w/web/src/node/app/.git');
    const result = await runInit(deps, options({ home: '/w/web/src/node' }));
    expect(result.ok).toBe(true);
  });

  it('still refuses with exit 1 when the home has a config file already', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    deps.seed(`${HOME}/factory.local.yaml`, 'schema: 1\n');
    const result = await runInit(deps, options());
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain('already exists');
  });
});

describe('init: a folder in the settings folder of Claude Code', () => {
  const CLAUDE = '/users/me/.claude';
  const CHANGES = new Set(['mkdir', 'writeText', 'writeTextExclusive', 'writeTextAtomic', 'rename', 'remove', 'chmod', 'copyTree']);
  const underClaude = (path: string): boolean => {
    const lower = path.toLowerCase();
    return lower === CLAUDE || lower.startsWith(`${CLAUDE}/`);
  };

  /** Run `init` on deps that note every file call, with a test home at `/users/me`. */
  const attempt = async (extra: FakeOptions, change: Partial<InitOptions>) => {
    const { deps } = setup({}, extra);
    const before = snapshot(deps);
    const seen: { readonly method: string; readonly path: string }[] = [];
    const result = await runInit(withFsWatch(deps, (method, path) => seen.push({ method, path })), options(change));
    return { deps, before, seen, result };
  };

  const expectStop = (run: Awaited<ReturnType<typeof attempt>>): void => {
    expect(run.result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(run.result)).toContain('the settings folder of Claude Code /users/me/.claude');
    expect(messageOf(run.result)).toContain('Then run "factory init".');
    expect(snapshot(run.deps)).toBe(run.before);
    expect(run.seen.filter((call) => CHANGES.has(call.method))).toEqual([]);
    expect(run.seen.filter((call) => underClaude(call.path))).toEqual([]);
    expect(run.deps.calls).toEqual([]);
  };

  it.each([CLAUDE, `${CLAUDE}/factory`, `${CLAUDE}/a/b/c`])(
    'stops with exit 4 for --home %s, writes nothing and makes no call at or under that folder',
    async (home) => {
      expectStop(await attempt({}, { home }));
    },
  );

  it('stops for a relative --home that resolves into that folder', async () => {
    expectStop(await attempt({ cwd: CLAUDE }, { home: 'factory' }));
  });

  it('stops with no --home when the current folder is in that folder, and runs no git command', async () => {
    expectStop(await attempt({ cwd: `${CLAUDE}/work` }, { home: undefined }));
  });

  it('stops for a folder that differs only in the case of letters on macOS', async () => {
    expectStop(await attempt({ os: 'darwin' }, { home: '/users/me/.CLAUDE/factory' }));
  });

  it('does not stop for a folder with the same start in its name, or for the case of letters on Linux', async () => {
    const beside = await attempt({}, { home: '/users/me/.claude-factory' });
    expect(beside.result.ok).toBe(true);
    const upper = await attempt({ os: 'linux' }, { home: '/users/me/.CLAUDE/factory' });
    expect(upper.result.ok).toBe(true);
  });

  it('does not stop when the variable of the user home is not set', async () => {
    const run = await attempt({ env: { XDG_STATE_HOME: '/state' } }, { home: `${CLAUDE}/factory` });
    expect(run.result.ok).toBe(true);
  });
});

describe('init: the proposed home in a git work tree', () => {
  const REPO = '/w/web';
  const PROPOSAL = '/w/web-factory';
  const repos = { [REPO]: { origin: 'git@github.com:acme/web.git' } };

  /** The command runs in a folder below the top of the work tree. */
  const inRepo = (extra: FakeOptions = {}, fixture: GitFixture = { repos }) => {
    const { handler } = gitHandler(fixture);
    const deps = createFakeDeps({ cwd: `${REPO}/src`, run: handler, env: ENV, ...extra });
    deps.seedDir(`${REPO}/src`);
    return deps;
  };

  const withHome = (extra: Partial<InitOptions> = {}): InitOptions => options({ home: undefined, yes: false, ...extra });
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const answers = (answer: string): FakeOptions => ({ ...terminal, prompt: answerHome(answer) });
  const projectsOf = async (deps: FakeDeps) => {
    const config = await loadConfig(deps, PROPOSAL);
    return config.ok ? config.value.recipe.projects.map((project) => [project.id, project.path]) : null;
  };

  const ORIGIN = 'git@github.com:acme/web.git';

  it('uses the folder beside the work tree for --yes, and clones the repo into the root from its origin (TP-13)', async () => {
    const { handler, log } = gitHandler({ repos });
    const deps = createFakeDeps({ cwd: `${REPO}/src`, run: handler, env: ENV });
    deps.seedDir(`${REPO}/src`);
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe(PROPOSAL);
    expect(result.ok && result.value.json['nodeId']).toBe('web-factory');
    expect(log.clones()).toEqual([['clone', '--', ORIGIN, `${PROPOSAL}/web`]]);
    expect(await projectsOf(deps)).toEqual([['web', 'web']]);
    expect(deps.prompts).toEqual([]);
    const config = await loadConfig(deps, PROPOSAL);
    expect(config.ok && config.value.recipe.projects[0]?.repo).toBe('acme/web');
    expect(config.ok && config.value.recipe.projects[0]?.url).toBe(ORIGIN);
    expect(config.ok && config.value.core.sources).toEqual({});
  });

  it('warns that the old folder keeps the work that is not pushed, and leaves the old folder as it is (TP-13)', async () => {
    const deps = inRepo();
    const inOldFolder = ([path]: [string, string]): boolean => path.startsWith(`${REPO}/`);
    const before = [...deps.files.entries()].filter(inOldFolder);
    const result = await runInit(deps, withHome({ yes: true }));
    const warnings = result.ok ? result.value.warnings : [];
    expect(warnings).toContain(
      `The old folder ${REPO} keeps the work that is not pushed. The clone holds only what the origin holds.`,
    );
    expect([...deps.files.entries()].filter(inOldFolder)).toEqual(before);
  });

  it('with no origin clones from the local folder, keeps the source in the local file only, and warns (TP-13)', async () => {
    const { handler, log } = gitHandler({ repos: { [REPO]: {} } });
    const deps = createFakeDeps({ cwd: `${REPO}/src`, run: handler, env: ENV });
    deps.seedDir(`${REPO}/src`);
    const result = await runInit(deps, withHome({ yes: true }));
    expect(log.clones()).toEqual([['clone', '--', REPO, `${PROPOSAL}/web`]]);
    const warnings = result.ok ? result.value.warnings : [];
    expect(warnings.filter((text) => text.includes('cannot be shared'))).toHaveLength(1);
    expect(warnings).toContain(
      `The old folder ${REPO} keeps the work that is not pushed. ` +
        'The clone holds only the commits of the old folder, and the work that is not committed stays there.',
    );
    const config = await loadConfig(deps, PROPOSAL);
    expect(config.ok && config.value.recipe.projects[0]?.url).toBeUndefined();
    expect(config.ok && config.value.core.sources).toEqual({ web: REPO });
    expect(deps.files.get(`${PROPOSAL}/factory.yaml`)).not.toContain(REPO);
    expect(deps.files.get(`${PROPOSAL}/factory.local.yaml`)).toContain(`"web": "${REPO}"`);
  });

  it('puts the work tree before every --project, and does not repeat it', async () => {
    const deps = inRepo({}, { repos: { ...repos, '/w/api': {} } });
    const result = await runInit(deps, withHome({ yes: true, projects: ['/w/api', '..', '/w/web'] }));
    expect(result.ok).toBe(true);
    expect(await projectsOf(deps)).toEqual([
      ['web', 'web'],
      ['api', 'api'],
    ]);
  });

  it('asks on a terminal and goes on for y and for yes in any case', async () => {
    for (const answer of ['y', 'yes', ' Y ', 'YES\n']) {
      const deps = inRepo(answers(answer));
      const result = await runInit(deps, withHome());
      expect({ answer, ok: result.ok }).toEqual({ answer, ok: true });
      expect(homeQuestions(deps)).toHaveLength(1);
      expect(deps.prompts[0]).toContain(`The proposed factory folder is ${PROPOSAL}`);
      expect(deps.prompts[0]).toContain('Create the factory folder here? [y/N]');
      expect(await projectsOf(deps)).toEqual([['web', 'web']]);
    }
  });

  it.each(['n', 'no', '', 'maybe', 'yess', 'y y'])('stops with exit 2 and writes nothing for the answer "%s"', async (answer) => {
    const deps = inRepo(answers(answer));
    const before = snapshot(deps);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain(`${PROPOSAL} was not accepted`);
    expect(messageOf(result)).toContain('--home DIR');
    expect(snapshot(deps)).toBe(before);
  });

  it('does not ask when --yes is given, also on a terminal', async () => {
    const deps = inRepo(answers('n'));
    expect((await runInit(deps, withHome({ yes: true }))).ok).toBe(true);
    expect(deps.prompts).toEqual([]);
  });

  it.each([
    ['no terminal at all', {}],
    ['a terminal for the input only', { stdinIsTTY: true }],
    ['a terminal for the output only', { stdoutIsTTY: true }],
  ])('prints the proposal and exits 2 with %s and no --yes', async (_name, extra) => {
    const deps = inRepo({ ...extra, prompt: () => ok('y') });
    const before = snapshot(deps);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain(`The proposed factory folder is ${PROPOSAL}`);
    expect(messageOf(result)).toContain('--yes');
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('fails when the question gets no answer', async () => {
    const deps = inRepo(terminal);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.prompts).toHaveLength(1);
  });

  it('makes no proposal when the home is given, and adds no first project', async () => {
    const deps = inRepo(answers('y'));
    const result = await runInit(deps, withHome({ home: HOME }));
    expect(result.ok).toBe(true);
    expect(homeQuestions(deps)).toEqual([]);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects).toEqual([]);
  });

  it('uses the current folder, and asks nothing, when the folder is in no work tree', async () => {
    const { deps } = setup();
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe('/w');
    expect(deps.prompts).toEqual([]);
  });

  it('accepts the proposal when it is inside another work tree: the root is a repo of its own', async () => {
    const deps = inRepo({}, { repos: { [REPO]: {}, '/w': {} } });
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe(PROPOSAL);
  });

  it('fails with exit 1 when the proposed folder holds a node already', async () => {
    const deps = inRepo();
    deps.seed(`${PROPOSAL}/factory.yaml`, 'schema: 2\n');
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('already exists');
  });

  it('fails with exit 1, and proposes nothing, when the top of the work tree holds a config file', async () => {
    const deps = inRepo(answers('y'));
    deps.seed(`${REPO}/factory.yaml`, 'schema: 2\n');
    deps.seed(`${REPO}/factory.local.yaml`, 'schema: 1\n');
    const before = snapshot(deps);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(`factory.yaml already exists in ${REPO}`);
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('fails with exit 1 when the proposal is inside a root that the factory list holds', async () => {
    const deps = inRepo();
    deps.seed('/w/factory.yaml', 'schema: 2\n');
    registerRoot(deps, '/w', 'listed');
    const before = snapshot(deps);
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(`${PROPOSAL} is inside the factory folder /w`);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the layer and the recipe', () => {
  const files = (deps: FakeDeps): string[] => [...deps.files.keys()].map((path) => path.slice(HOME.length + 1)).sort();
  const claudeBlocks = (deps: FakeDeps): string[] => {
    const parsed = parseBlocks(deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? '');
    return parsed.ok ? parsed.value.map((block) => block.name) : [];
  };

  it('makes a node on layer 1 by default, with the coordinator, safety and worker blocks', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(1);
    expect(config.ok && config.value.recipe.id).toBe('software');
    expect(claudeBlocks(deps)).toEqual(['coordinator', 'safety', 'setup']);
    expect(files(deps)).toContain('.factory/roles/worker.md');
  });

  it('makes a node on layer 2 with the manager and safety blocks and a worker file', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ layer: '2' }))).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(2);
    expect(claudeBlocks(deps)).toEqual(['manager', 'safety', 'setup']);
    expect(files(deps)).toContain('.factory/roles/worker.md');
    expect(files(deps)).toContain('.factory/node.json');
    const state = await loadState(deps, HOME);
    expect(state.ok && state.value.blocks).toEqual({ manager: 1, safety: 2, worker: 2, setup: 1, 'setup-worker': 1 });
    const statuses = await inspectBlocks(deps, HOME, layer2Blocks);
    expect(statuses.map((status) => status.kind)).toEqual(['intact', 'intact', 'intact', 'intact', 'intact']);
  });

  it('makes a node on layer 3 with the safety block in CLAUDE.md, a worker file, and a warning that names the layer', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options({ layer: '3' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(3);
    expect(claudeBlocks(deps)).toEqual(['safety', 'setup']);
    expect(files(deps)).toContain('.factory/roles/worker.md');
    const state = await loadState(deps, HOME);
    expect(state.ok && state.value.blocks).toEqual({ safety: 2, worker: 2, setup: 1, 'setup-worker': 1 });
    expect(result.value.warnings).toContain('Layer 3 has no role template: CLAUDE.md holds the safety block only.');
    expect(result.value.json['warnings']).toEqual(result.value.warnings);
  });

  it('gives no role warning for layers 1 and 2', async () => {
    for (const layer of ['1', '2']) {
      const { deps } = setup();
      const result = await runInit(deps, options({ layer }));
      expect(result.ok && result.value.warnings.filter((text) => text.includes('role template'))).toEqual([]);
    }
  });

  it('makes a node on the highest layer', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options({ layer: '16' }));
    expect(result.ok && result.value.warnings.join('\n')).toContain('Layer 16 has no role template');
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(16);
  });

  it.each(['0', '17', '-1', '1.5', 'x', '', ' 2', '2 ', '0x2', '00020', '1000'])(
    'rejects the layer "%s" with exit 2 and names the flag',
    async (layer) => {
      const { deps } = setup();
      const before = snapshot(deps);
      const result = await runInit(deps, options({ layer }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('--layer: must be a whole number from 1 to 16');
      expect(snapshot(deps)).toBe(before);
    },
  );

  it('accepts --recipe software and rejects any other recipe with exit 2', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ recipe: 'software' }))).ok).toBe(true);
    const other = setup();
    const result = await runInit(other.deps, options({ recipe: 'research' }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--recipe: the recipe must be one of: software');
  });
});

describe('init: defaults from the system', () => {
  it('takes the owner name from git config when no flag is given', async () => {
    const { deps } = setup({ userName: 'From Git' });
    await runInit(deps, options({ ownerName: undefined }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.owner.display).toBe('From Git');
  });

  it('fails and names the flag when there is no owner name', async () => {
    const { deps } = setup({ identity: false });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ ownerName: undefined }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--owner-name');
    expect(snapshot(deps)).toBe(before);
  });

  it('takes the GitHub login from gh, and ignores a login that is not valid', async () => {
    const good = setup({ gh: 'some-login' });
    await runInit(good.deps, options());
    expect(await loadConfig(good.deps, HOME)).toMatchObject({
      value: { core: { owner: { github: 'some-login' } } },
    });

    for (const gh of [null, 'not a login!', undefined]) {
      const other = setup(gh === undefined ? {} : { gh });
      await runInit(other.deps, options());
      const config = await loadConfig(other.deps, HOME);
      expect(config.ok && config.value.core.owner.github).toBeUndefined();
    }
  });

  it('prefers the GitHub flag over gh and does not run gh', async () => {
    const { deps, log } = setup({ gh: 'from-gh' });
    await runInit(deps, options({ ownerGithub: 'from-flag' }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.owner.github).toBe('from-flag');
    expect(log.calls.some((call) => call.command === 'gh')).toBe(false);
  });

  it('makes the node id from the folder name, and fails when nothing is left', async () => {
    const named = setup();
    await runInit(named.deps, options({ home: '/w/My Project_2' }));
    const config = await loadConfig(named.deps, '/w/My Project_2');
    expect(config.ok && config.value.core.node.id).toBe('my-project-2');

    const empty = setup();
    const result = await runInit(empty.deps, options({ home: '/w/***' }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--name');
  });

  it('rejects a node id from the flag that is not a slug, and names the key', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options({ name: 'Bad Id' }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('node.id');
  });
});

describe('init: projects', () => {
  const repos = {
    '/w/web': { origin: 'git@github.com:acme/web.git', originHead: 'origin/trunk', branch: 'feature' },
    '/w/api': { origin: 'https://github.com/acme/api', branch: 'develop' },
    '/w/lib': {},
    '/w/sub': { topLevel: false },
    '/w/My Tool': { origin: 'https://example.com/x.git' },
  };

  /** What the clones in the root are, as real git makes them: the origin is the place the clone came from. */
  const clones = {
    '/w/node/web': { origin: 'git@github.com:acme/web.git', originHead: 'origin/trunk' },
    '/w/node/api': { origin: 'https://github.com/acme/api', branch: 'develop' },
  };

  it('clones each work tree into the root from its origin, and describes it: id, repo, folder name, default branch', async () => {
    const { deps, log } = setup({ repos: { ...repos, ...clones } });
    await runInit(deps, options({ projects: ['/w/web', 'api'] }));
    expect(log.clones()).toEqual([
      ['clone', '--', 'git@github.com:acme/web.git', '/w/node/web'],
      ['clone', '--', 'https://github.com/acme/api', '/w/node/api'],
    ]);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects).toEqual([
      {
        id: 'web',
        url: 'git@github.com:acme/web.git',
        repo: 'acme/web',
        path: 'web',
        default_branch: 'trunk',
        merge_method: 'squash',
        gate: { checks: [] },
      },
      {
        id: 'api',
        url: 'https://github.com/acme/api',
        repo: 'acme/api',
        path: 'api',
        default_branch: 'develop',
        merge_method: 'squash',
        gate: { checks: [] },
      },
    ]);
  });

  it('names the folder of the clone after the repo in the origin, not after the old folder', async () => {
    const { deps, log } = setup({ repos: { '/w/web-old': { origin: 'https://github.com/acme/web.git' } } });
    await runInit(deps, options({ projects: ['/w/web-old'] }));
    expect(log.clones()).toEqual([['clone', '--', 'https://github.com/acme/web.git', '/w/node/web']]);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((p) => [p.id, p.path])).toEqual([['web', 'web']]);
  });

  it('leaves the repo unset for a remote that is not on GitHub, and falls back to main', async () => {
    const { deps } = setup({ repos });
    await runInit(deps, options({ projects: ['/w/My Tool', '/w/lib'] }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((p) => [p.id, p.repo, p.default_branch])).toEqual([
      ['x', undefined, 'main'],
      ['lib', undefined, 'main'],
    ]);
  });

  it('writes the url of a remote that is not on GitHub', async () => {
    const { deps } = setup({ repos });
    await runInit(deps, options({ projects: ['/w/My Tool'] }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((p) => p.url)).toEqual(['https://example.com/x.git']);
  });

  it('refuses a folder that is not a git work tree, or not its top folder', async () => {
    const { deps } = setup({ repos });
    const before = snapshot(deps);
    for (const project of ['/w/nowhere', '/w/sub']) {
      const result = await runInit(deps, options({ projects: [project] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('not the top folder of a git work tree');
    }
    expect(snapshot(deps)).toBe(before);
  });

  it('takes the folder name and the clone source from the real folder when the work tree is behind a link', async () => {
    const { deps, log } = setup({ repos: { '/w/via/proj': {}, '/w/real/proj': {} } }, { links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/via/proj');
    deps.seedDir('/w/real');
    const result = await runInit(deps, options({ home: '/w/real/node', projects: ['/w/via/proj'] }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', '/w/real/proj', '/w/real/node/proj']]);
    const config = await loadConfig(deps, '/w/real/node');
    expect(config.ok && config.value.recipe.projects.map((project) => project.path)).toEqual(['proj']);
  });

  it('refuses two projects that take one folder, whatever the letter case, and clones nothing', async () => {
    const { deps, log } = setup({ repos: { '/w/web': {}, '/w/other/Web': {} } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['/w/web', '/w/other/Web'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('two projects take the folder Web');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  describe('a work tree that is in the root already', () => {
    it('is the project: no clone runs and no warning names an old folder', async () => {
      const { deps, log } = setup({ repos: { '/w/node/web': { origin: 'git@github.com:acme/web.git' } } });
      deps.seedDir('/w/node/web');
      const result = await runInit(deps, options({ projects: ['/w/node/web'] }));
      expect(result.ok).toBe(true);
      expect(log.clones()).toEqual([]);
      expect(result.ok && result.value.warnings.filter((text) => text.includes('old folder'))).toEqual([]);
      const config = await loadConfig(deps, HOME);
      expect(config.ok && config.value.recipe.projects.map((project) => project.path)).toEqual(['web']);
    });

    it('is refused with exit 4 when it is a link to a folder outside the root', async () => {
      const origin = 'git@github.com:acme/web.git';
      const { deps, log } = setup({ repos: { '/w/node/web': { origin }, '/out/web': { origin } } }, { links: { '/w/node/web': '/out/web' } });
      deps.seedDir('/w/node/web');
      const before = snapshot(deps);
      const result = await runInit(deps, options({ projects: [origin] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('is outside the factory folder');
      expect(messageOf(result)).toContain('/out/web');
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });
  });
});

describe('init: the project path rule (TP-28)', () => {
  const REMEDY = 'Use one folder name that is not reserved';

  it.each([
    ['setup', 'keeps for itself'],
    ['coordinator', 'keeps for itself'],
    ['work-copies', 'keeps for itself'],
    ['factory.yaml', 'keeps for itself'],
    ['factory.local.yaml', 'keeps for itself'],
    ['CLAUDE.md', 'keeps for itself'],
    ['CLAUDE.local.md', 'keeps for itself'],
    ['AGENTS.md', 'keeps for itself'],
    ['Setup', 'keeps for itself'],
    ['COORDINATOR', 'keeps for itself'],
    ['Claude.MD', 'keeps for itself'],
    ['agents.MD', 'keeps for itself'],
    ['.hidden', 'must not start with a dot'],
    ['.factory', 'must not start with a dot'],
    ['.git', 'must not start with a dot'],
  ])('refuses a work tree whose folder is named %s with exit 4, and clones nothing', async (name, reason) => {
    const { deps, log } = setup({ repos: { [`/w/${name}`]: {} } });
    deps.seedDir(`/w/${name}`);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: [`/w/${name}`] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`the project folder name "${name}"`);
    expect(messageOf(result)).toContain(reason);
    expect(messageOf(result)).toContain(REMEDY);
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['https://host/acme/setup.git', 'setup'],
    ['git@host:acme/Work-Copies.git', 'Work-Copies'],
    ['ssh://git@host/acme/AGENTS.md.git', 'AGENTS.md'],
  ])('refuses the URL %s, because its repo name is reserved, with exit 4 and no clone', async (url, name) => {
    const { deps, log } = setup({});
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: [url] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`the project folder name "${name}"`);
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses a reserved name that only a compatible form of a letter separates from the reserved name', async () => {
    const { deps, log } = setup({ repos: { '/w/ſetup': {} } });
    const result = await runInit(deps, options({ projects: ['/w/ſetup'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(log.clones()).toEqual([]);
  });

  it('refuses a reserved name before any clone, also when an earlier project is good', async () => {
    const { deps, log } = setup({ repos: { '/w/web': {}, '/w/setup': {} } });
    const result = await runInit(deps, options({ projects: ['/w/web', '/w/setup'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(log.clones()).toEqual([]);
  });

  it('accepts names that only look like a reserved name', async () => {
    const names = ['setups', 'my-setup', 'coordinator2', 'work-copies-old', 'CLAUDE.mdx'];
    const { deps } = setup({ repos: Object.fromEntries(names.map((name) => [`/w/${name}`, {}])) });
    const result = await runInit(deps, options({ projects: names.map((name) => `/w/${name}`) }));
    expect(result.ok).toBe(true);
  });
});

describe('init: a project with no URL to share (F-17c, AC-11)', () => {
  const FILE_ORIGIN = 'file:///srv/acme/api.git';
  const SHARED = `${HOME}/factory.yaml`;
  const LOCAL = `${HOME}/factory.local.yaml`;
  const NOT_SHARED = 'cannot be shared';

  const initWith = async (repos: NonNullable<GitFixture['repos']>, projects: readonly string[]) => {
    const { deps, log } = setup({ repos });
    const result = await runInit(deps, options({ projects }));
    const config = await loadConfig(deps, HOME);
    return { deps, log, result, config };
  };

  const sharedWarnings = (result: Awaited<ReturnType<typeof runInit>>): string[] =>
    result.ok ? result.value.warnings.filter((warning) => warning.includes(NOT_SHARED)) : [];

  it('warns once per project that the factory can not be shared with the repo, and goes on (TP-109)', async () => {
    const { result } = await initWith({ '/w/lib': {}, '/w/tool': {}, '/w/web': { origin: 'git@host:acme/web.git' } }, [
      '/w/lib',
      '/w/tool',
      '/w/web',
    ]);
    expect(result.ok).toBe(true);
    const warnings = sharedWarnings(result);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('lib');
    expect(warnings[1]).toContain('tool');
  });

  it('names the fix: an origin for the repo and the url key of the project in factory.yaml', async () => {
    const { result } = await initWith({ '/w/lib': {} }, ['/w/lib']);
    const [warning] = sharedWarnings(result);
    expect(warning).toContain('origin');
    expect(warning).toContain('url');
    expect(warning).toContain('factory.yaml');
    expect(warning).toContain('factory doctor');
  });

  it('puts the warning in the JSON document, and the exit stays 0', async () => {
    const { deps } = setup({ repos: { '/w/lib': {} } });
    const sink = captureSink();
    const code = await runCli(['init', '--yes', '--home', HOME, '--owner-name', 'Test Owner', '--project', '/w/lib', '--json'], deps, sink);
    expect(code).toBe(0);
    expect(JSON.parse(sink.out.join('')).warnings.join(' ')).toContain(NOT_SHARED);
  });

  it('gives no such warning for a project with a URL to share', async () => {
    const { result } = await initWith({ '/w/web': { origin: 'git@host:acme/web.git' } }, ['/w/web']);
    expect(result.ok).toBe(true);
    expect(sharedWarnings(result)).toEqual([]);
  });

  it('refuses a project flag with a control character, and clones nothing', async () => {
    const { deps, log } = setup({ repos: { '/w/we\u001b[2Jb': {} } });
    const result = await runInit(deps, options({ projects: ['/w/we\u001b[2Jb'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(log.clones()).toEqual([]);
  });

  it('writes the project with no url, and no local path in factory.yaml, for a repo with no origin (TP-135)', async () => {
    const { deps, config } = await initWith({ '/w/lib': {} }, ['/w/lib']);
    expect(config.ok && config.value.recipe.projects.map((project) => project.url)).toEqual([undefined]);
    const shared = deps.files.get(SHARED) ?? '';
    expect(shared).not.toContain('url:');
    expect(shared).not.toContain('/w/lib');
    expect(shared).not.toContain('file:');
  });

  it('keeps the local source of a repo with no origin in the local file only (TP-135)', async () => {
    const { deps, config } = await initWith({ '/w/lib': {} }, ['/w/lib']);
    expect(config.ok && config.value.core.sources).toEqual({ lib: '/w/lib' });
    expect(deps.files.get(LOCAL)).toContain('"lib": "/w/lib"');
  });

  it('treats a file URL as the origin like no origin: no url in factory.yaml, the URL as the local source (TP-135)', async () => {
    const { deps, config, result, log } = await initWith({ '/w/api': { origin: FILE_ORIGIN } }, ['/w/api']);
    expect(log.clones()).toEqual([['clone', '--', FILE_ORIGIN, '/w/node/api']]);
    expect(config.ok && config.value.recipe.projects.map((project) => project.url)).toEqual([undefined]);
    expect(config.ok && config.value.core.sources).toEqual({ api: FILE_ORIGIN });
    expect(deps.files.get(SHARED)).not.toContain('file:');
    expect(deps.files.get(SHARED)).not.toContain('/srv/acme');
    expect(sharedWarnings(result)).toHaveLength(1);
  });

  it.each([
    ['a local path', '/srv/acme/api.git'],
    ['an http URL', 'http://host/acme/api.git'],
    ['a git transport helper', 'ext::sh -c x'],
  ])('treats %s as the origin like no origin, and keeps the folder as the local source', async (_name, origin) => {
    const { deps, config, result, log } = await initWith({ '/w/api': { origin } }, ['/w/api']);
    expect(log.clones()).toEqual([['clone', '--', '/w/api', '/w/node/api']]);
    expect(config.ok && config.value.recipe.projects.map((project) => project.url)).toEqual([undefined]);
    expect(config.ok && config.value.core.sources).toEqual({ api: '/w/api' });
    expect(deps.files.get(SHARED)).not.toContain(origin);
    expect(sharedWarnings(result)).toHaveLength(1);
  });

  it('clones a file URL of the project flag, writes no url, keeps the URL as the local source, and warns (TP-135)', async () => {
    const { deps, log } = setup({});
    const result = await runInit(deps, options({ projects: [FILE_ORIGIN] }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', FILE_ORIGIN, '/w/node/api']]);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((project) => project.url)).toEqual([undefined]);
    expect(config.ok && config.value.core.sources).toEqual({ api: FILE_ORIGIN });
    expect(deps.files.get(SHARED)).not.toContain('file:');
    expect(sharedWarnings(result)).toHaveLength(1);
  });

  it('keeps one source for each project with no URL, and none for a project with a URL', async () => {
    const { config } = await initWith(
      { '/w/a': {}, '/w/b': { origin: FILE_ORIGIN }, '/w/c': { origin: 'git@host:acme/c.git' } },
      ['/w/a', '/w/b', '/w/c'],
    );
    expect(config.ok && config.value.core.sources).toEqual({ a: '/w/a', api: FILE_ORIGIN });
  });

  it('writes the local source of a project into the local file with mode 600', async () => {
    const { deps } = await initWith({ '/w/lib': {} }, ['/w/lib']);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
  });

  it('refuses two projects with one repo, whatever the form of the URL: both take one folder', async () => {
    const { result, log } = await initWith(
      { '/w/web': { origin: 'git@host:acme/web.git' }, '/w/web2': { origin: 'https://host/acme/web' } },
      ['/w/web', '/w/web2'],
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('two projects take the folder web');
    expect(log.clones()).toEqual([]);
  });
});

describe('init: the state repository', () => {
  it('creates the repository in the staging folder and makes the first commit when there is an identity', async () => {
    const { deps, log } = setup();
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['committed']).toBe(true);
    const staging = `${HOME}/.factory.tmp-4242`;
    const git = log.calls.filter((call) => call.command === 'git' && call.args[1] === staging);
    expect(git.map((call) => call.args.slice(2).join(' '))).toEqual([
      'init -q',
      'rev-parse --is-inside-work-tree --show-prefix',
      // A git template can copy a key that names a program into the config of the new repository: the check comes before any step that stages.
      `${STATE_GIT} config --list --show-scope --includes -z`,
      // The plan of the guard reads the git folder and the setting, and again for the hooks that stop. The install reads the git folder
      // once more and sets the path.
      `${STATE_GIT} rev-parse --absolute-git-dir`,
      `${STATE_READ} config core.hooksPath`,
      `${STATE_GIT} rev-parse --absolute-git-dir`,
      `${STATE_READ} config core.hooksPath`,
      `${STATE_GIT} rev-parse --absolute-git-dir`,
      `${STATE_GIT} config -- core.hooksPath ${GUARD_FOLDER}`,
      'config user.name',
      'config user.email',
      `${STATE_GIT} add -A`,
      `${STATE_GIT} -c commit.gpgsign=false commit -q -m chore: initialize the state`,
    ]);
  });

  describe('a git template that copied a program key into the config of the new repository', () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const copied = (key: string) => setup({ configList: { [staging]: `local\0${key}\ncat\0` } });

    it.each(['filter.x.clean', 'hook.x.command'])('stops with exit 4 for %s, names the key, and stages and commits nothing', async (key) => {
      const { deps, log } = copied(key);
      const result = await runInit(deps, options());
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', message: expect.stringContaining(key) } });
      expect(log.commands().some((line) => line.startsWith('add') || line.includes('commit -q'))).toBe(false);
      expect(deps.files.has(`${HOME}/.factory/node.json`)).toBe(false);
    });

    it('tells the person to clean the git template, because the new repository is removed', async () => {
      const { deps } = copied('filter.x.clean');
      const result = await runInit(deps, options());
      expect(messageOf(result)).toContain('git template');
      expect(messageOf(result)).toContain('Then run "factory init" again.');
    });

    it('checks the config after the work tree check and before the guard is written', async () => {
      const { deps, log } = setup();
      expect((await runInit(deps, options())).ok).toBe(true);
      const lines = log.commands();
      const check = lines.indexOf('config --list --show-scope --includes -z');
      expect(check).toBeGreaterThan(lines.indexOf('rev-parse --is-inside-work-tree --show-prefix'));
      expect(check).toBeLessThan(lines.findIndex((line) => line.startsWith('config -- core.hooksPath')));
      expect(check).toBeLessThan(lines.findIndex((line) => line.startsWith('add')));
    });
  });

  it('writes the package hook text as each hook file in the guard folder of the git folder, with mode 755, and sets the path (TP-1)', async () => {
    const { deps, log } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const expected = guardHookText(FAKE_PROGRAM_ARGV);
    expect(expected.ok).toBe(true);
    for (const hook of GUARD_HOOKS) {
      expect(deps.files.get(hook)).toBe(expected.ok ? expected.value : null);
      expect(deps.modes.get(hook)).toBe(0o755);
    }
    expect(await deps.fs.list(GUARD_FOLDER)).toEqual({ ok: true, value: [...stateGuard.hookFiles].sort() });
    expect(log.commands()).toContain(`config -- core.hooksPath ${GUARD_FOLDER}`);
  });

  it('keeps the guard out of what git tracks: the hook is inside the git folder, and no state file names it (TP-1)', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const outside = [...deps.files.keys()].filter((path) => path.startsWith(`${HOME}/.factory/`) && !path.startsWith(`${HOME}/.factory/.git/`));
    expect(outside.some((path) => path.includes(stateGuard.folder) || stateGuard.hookFiles.some((name) => path.endsWith(name)))).toBe(false);
    expect(GUARD_FOLDER.startsWith(`${HOME}/.factory/.git/`)).toBe(true);
  });

  it('names the final state folder in the setting, not the staging folder, and the hook stays in place after the rename (TP-3)', async () => {
    const { deps, log } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const staging = `${HOME}/.factory.tmp-4242`;
    const setCalls = log.calls.filter((call) => call.args.includes('core.hooksPath') && call.args.includes('--'));
    expect(setCalls.map((call) => call.args[1])).toEqual([staging]);
    expect(setCalls.map((call) => call.args.at(-1))).toEqual([GUARD_FOLDER]);
    expect(GUARD_FOLDER).not.toContain('/hooks');
    expect(GUARD_HOOKS.every((hook) => deps.files.has(hook))).toBe(true);
    expect([...deps.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false);
  });

  it('writes the hook before the first commit, so the first commit of the folder runs with the hook in place (TP-1)', async () => {
    const { deps, log } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const lines = log.commands();
    const setting = lines.findIndex((line) => line.startsWith('config -- core.hooksPath'));
    expect(setting).toBeGreaterThanOrEqual(0);
    expect(setting).toBeLessThan(lines.findIndex((line) => line.includes('commit -q')));
  });

  it('goes on with a warning that names the program, and writes no hook, when the program path is not known (TP-1)', async () => {
    const { deps } = setup({}, { programArgv: [] });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const warnings = result.ok ? result.value.warnings : [];
    expect(warnings.filter((line) => line.includes('can not write it'))).toEqual([
      expect.stringContaining('absolute path of its own program'),
    ]);
    expect(warnings.join('\n')).not.toContain('factory upgrade');
    expect([...deps.files.keys()].some((path) => path.includes(stateGuard.folder))).toBe(false);
    expect(deps.files.has(`${HOME}/.factory/node.json`)).toBe(true);
  });

  it('goes on with a warning that names the link, and leaves the folder of the link as it was, when the guard folder is a link (TP-53)', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const guard = `${staging}/.git/${stateGuard.folder}`;
    const { deps } = setup({}, { links: { [guard]: '/elsewhere/folder' } });
    deps.seed('/elsewhere/folder/keep.txt', 'keep');
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.warnings : []).toEqual(
      expect.arrayContaining([expect.stringContaining(`${guard} is a link`)]),
    );
    expect(deps.files.get('/elsewhere/folder/keep.txt')).toBe('keep');
    expect([...deps.files.keys()].filter((path) => path.startsWith('/elsewhere/'))).toEqual(['/elsewhere/folder/keep.txt']);
  });

  it('warns that a hook file of the default hooks folder stops, which git copies from a template, and leaves that file as it was', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const hook = `${staging}/.git/hooks/pre-push`;
    const { handler } = gitHandler();
    // Git copies the hook files of its template folder when it makes the repository, so they appear at `git init`.
    const deps = createFakeDeps({
      cwd: '/w',
      env: ENV,
      run: (call) => {
        if (call.args[2] === 'init') {
          deps.seed(hook, '#!/bin/sh\n');
          deps.seed(`${staging}/.git/hooks/pre-commit.sample`, 'x');
        }
        return handler(call);
      },
    });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const stops = (result.ok ? result.value.warnings : []).filter((line) => line.includes('stop running when'));
    expect(stops).toEqual([expect.stringContaining('.factory/.git/hooks/pre-push')]);
    expect(stops[0]).not.toContain('pre-commit.sample');
    expect(deps.files.get(`${HOME}/.factory/.git/hooks/pre-push`)).toBe('#!/bin/sh\n');
  });

  it('warns that the hooks of a core.hooksPath of another level stop', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const { deps } = setup({ otherLevelHooksPath: { [staging]: '/global/hooks' } });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const stops = (result.ok ? result.value.warnings : []).filter((line) => line.includes('stop running when'));
    expect(stops).toEqual([expect.stringContaining('the hooks in /global/hooks')]);
  });

  it('warns of no stopped hook for a new state repository that has only the example files of git', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect((result.ok ? result.value.warnings : []).filter((line) => line.includes('stop running when'))).toEqual([]);
  });

  it('warns and makes no commit when there is no git identity', async () => {
    const { deps, log } = setup({ identity: false });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.json['committed']).toBe(false);
    expect(result.value.warnings.join('\n')).toContain('No git identity');
    expect(log.commands().some((line) => line.includes('commit'))).toBe(false);
  });

  it('makes the root a repo of its own and commits the three shared paths by name, after all files are there (TP-10)', async () => {
    const { deps, log } = setup();
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['rootCommitted']).toBe(true);
    const rootInit = log.calls.findIndex((call) => call.args[1] === HOME && call.args.includes('init'));
    const lastStateCall = log.calls.map((call) => call.args[1]).lastIndexOf(`${HOME}/.factory.tmp-4242`);
    expect(rootInit).toBeGreaterThan(lastStateCall);
    expect(log.calls.slice(rootInit).map((call) => call.args.slice(2).join(' '))).toEqual([
      'init -q -b main',
      'config user.name',
      'config user.email',
      'add -- .gitignore factory.yaml setup',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: initialize the config repo',
    ]);
  });

  it('stages no path that the share list ignores', async () => {
    const { deps, log } = setup();
    await runInit(deps, options());
    const staged = log.commands().filter((line) => line.startsWith('add'));
    const root = staged.find((line) => line.startsWith('add --'));
    expect(root).toBe('add -- .gitignore factory.yaml setup');
    for (const name of ['factory.local.yaml', 'coordinator', '.factory', 'work-copies']) {
      expect(root?.split(' ')).not.toContain(name);
    }
    expect(staged.filter((line) => line.includes('-A'))).toEqual(['add -A']);
  });

  it('warns and makes no root commit when there is no git identity, and the repo of the root is there', async () => {
    const { deps, log } = setup({ identity: false });
    const result = await runInit(deps, options({ ownerName: 'Test Owner' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.json['rootCommitted']).toBe(false);
    expect(result.value.warnings.join('\n')).toContain('the first commit of the config repo was not made');
    const rootInit = log.calls.findIndex((call) => call.args[1] === HOME && call.args.includes('init'));
    expect(log.calls.slice(rootInit).map((call) => call.args.slice(2).join(' '))).toEqual([
      'init -q -b main',
      'config user.name',
      'config user.email',
    ]);
  });

  it('never runs a program through a shell', async () => {
    const { deps, log } = setup({ gh: 'x' });
    await runInit(deps, options());
    expect(new Set(log.calls.map((call) => call.command))).toEqual(new Set(['git', 'gh']));
  });
});

describe('init: rollback', () => {
  it('removes everything and restores CLAUDE.md when the config file cannot be written', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
  });

  it('removes the new home folder when the first write fails', async () => {
    const { deps } = setup();
    const before = snapshot(deps);
    const plan = await planInit(deps, options({ home: '/w/fresh/home' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/node.json'), plan.value);
    expect(result.ok).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('removes the coordinator folder and the state folder when CLAUDE.md cannot be written', async () => {
    const { deps } = setup();
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/CLAUDE.md'), plan.value);
    expect(result.ok).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('removes the new folders when the config file cannot be written', async () => {
    const { deps } = setup();
    const before = snapshot(deps);
    const plan = await planInit(deps, options({ home: '/w/fresh/home' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
  });

  it('keeps a file that another writer put in the new home folder, and names the folders that stay', async () => {
    const { deps } = setup();
    const plan = await planInit(deps, options({ home: '/w/fresh/home' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    deps.seed('/w/fresh/home/other.txt', 'not from this run');
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(result.ok).toBe(false);
    expect(deps.files.get('/w/fresh/home/other.txt')).toBe('not from this run');
    expect([...deps.files.keys()].some((path) => path.includes('.factory'))).toBe(false);
    const message = messageOf(result);
    expect(message).not.toContain('nothing was changed');
    expect(message).toContain('/w/fresh/home: ENOTEMPTY');
    expect(message).toContain('/w/fresh: ENOTEMPTY');
  });

  it('writes CLAUDE.md, .gitignore, the local file, the shared file, the factory list and then the setup acceptance with the atomic write', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.atomicWrites).toEqual([
      ...STAGING_HOOKS,
      `${HOME}/coordinator/CLAUDE.md`,
      `${HOME}/.gitignore`,
      `${HOME}/factory.local.yaml`,
      `${HOME}/factory.yaml`,
      INDEX,
      '/state/factory/setup-acceptances.json',
    ]);
  });

  it('removes the local file and restores CLAUDE.md when the shared file cannot be written', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(result.ok).toBe(false);
    expect(deps.files.has(`${HOME}/factory.local.yaml`)).toBe(false);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    expect(deps.files.get(`${HOME}/coordinator/CLAUDE.md`)).toBe('Owner text.\n');
  });

  it('removes .gitignore, the setup text and the new folders when the shared file cannot be written', async () => {
    const { deps } = setup();
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('nothing was changed');
    for (const path of ['.gitignore', 'setup/coordinator.md', 'coordinator/CLAUDE.md']) {
      expect(deps.files.has(`${HOME}/${path}`)).toBe(false);
    }
    for (const dir of ['setup', 'coordinator', '.factory']) expect(deps.dirs.has(`${HOME}/${dir}`)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('puts the text of a person back into .gitignore, and keeps a setup text that was there, when the shared file cannot be written', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/.gitignore`, '!/notes.md\n');
    deps.seed(`${HOME}/setup/coordinator.md`, 'My shared text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(result.ok).toBe(false);
    expect(deps.files.get(`${HOME}/.gitignore`)).toBe('!/notes.md\n');
    expect(deps.files.get(`${HOME}/setup/coordinator.md`)).toBe('My shared text.\n');
    expect(deps.dirs.has(`${HOME}/setup`)).toBe(true);
  });

  it('removes the git folder of the root that this run made when the first commit of the root fails', async () => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({
      cwd: '/w',
      env: ENV,
      run: (call) => (call.args.includes('commit') && call.args[1] === HOME ? exited(1) : handler(call)),
    });
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const before = snapshot(deps);
    const result = await applyInit(deps, plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('cannot commit the config files');
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
  });

  it('never removes a git folder that was in the root before the run, and changes nothing else', async () => {
    const { deps } = setup();
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    deps.seed(`${HOME}/.git/HEAD`, 'ref: refs/heads/trunk\n');
    const before = snapshot(deps);
    const result = await applyInit(deps, plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('holds a git repository already');
    expect(deps.files.get(`${HOME}/.git/HEAD`)).toBe('ref: refs/heads/trunk\n');
    expect(snapshot(deps)).toBe(before);
  });

  it('writes no shared file, and leaves no local file, when the local file cannot be written', async () => {
    const { deps } = setup();
    const before = snapshot(deps);
    const plan = await planInit(deps, options({ home: '/w/fresh/home' }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failingWrite(deps, '/factory.local.yaml'), plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
    expect(deps.files.has('/w/fresh/home/factory.yaml')).toBe(false);
  });

  it('puts the old CLAUDE.md back with the atomic write', async () => {
    const { deps } = setup();
    const claude = `${HOME}/coordinator/CLAUDE.md`;
    deps.seed(claude, 'Owner text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(deps.atomicWrites).toEqual([...STAGING_HOOKS, claude, `${HOME}/.gitignore`, `${HOME}/factory.local.yaml`, claude]);
    expect(deps.files.get(claude)).toBe('Owner text.\n');
  });

  it('names the file that it cannot put back, and does not say that nothing was changed', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const failing = withFailingWrites(
      deps,
      (path, attempt) => path.endsWith('/factory.yaml') || (path.endsWith('/CLAUDE.md') && attempt === 2),
    );
    const result = await applyInit(failing, plan.value);
    expect(result.ok).toBe(false);
    const message = messageOf(result);
    expect(message).not.toContain('nothing was changed');
    expect(message).toContain(`cannot write ${HOME}/factory.yaml`);
    expect(message).toContain(`cannot write ${HOME}/coordinator/CLAUDE.md`);
    expect(deps.files.get(`${HOME}/coordinator/CLAUDE.md`)).not.toBe('Owner text.\n');
  });

  it('names the folder that it cannot remove, and does not say that nothing was changed', async () => {
    const { deps } = setup();
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const stuck: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        remove: async (path) => (path === `${HOME}/.factory` ? failure(`cannot remove ${path}: EBUSY`) : deps.fs.remove(path)),
      },
    };
    const result = await applyInit(failingWrite(stuck, '/factory.yaml'), plan.value);
    expect(result.ok).toBe(false);
    const message = messageOf(result);
    expect(message).not.toContain('nothing was changed');
    expect(message).toContain(`cannot remove ${HOME}/.factory: EBUSY`);
  });

  it('leaves the folder as it was and says so when the staging folder cannot be renamed', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const failing: Deps = {
      ...deps,
      fs: { ...deps.fs, rename: async (from) => failure(`cannot rename ${from}: EXDEV`) },
    };
    const result = await applyInit(failing, plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain(`cannot rename ${HOME}/.factory.tmp-4242: EXDEV`);
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
    expect(deps.atomicWrites).toEqual(STAGING_HOOKS);
  });

  it('leaves the folder as it was and says so when the first commit fails', async () => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({
      cwd: '/w',
      env: ENV,
      run: (call) => (call.args.includes('commit') ? exited(1) : handler(call)),
    });
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(deps, plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('cannot commit the state files');
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
    expect(deps.atomicWrites).toEqual(STAGING_HOOKS);
  });

  it('leaves no node when git cannot create the repository', async () => {
    const { deps } = setup();
    const failing: Deps = {
      ...deps,
      run: async (command, args, runOptions) =>
        args.includes('init') ? failure('git is broken') : deps.run(command, args, runOptions),
    };
    const before = snapshot(deps);
    const plan = await planInit(failing, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(failing, plan.value);
    expect(result.ok).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: a workspace folder that holds several repos', () => {
  const WS = '/ws';
  const PROPOSAL = '/ws/ws-factory';
  const repos = {
    '/ws/web': { origin: 'git@github.com:acme/web.git' },
    '/ws/api': {},
    '/ws/web-search': { commonDir: '/ws/web/.git' },
  };

  const inWorkspace = (extra: FakeOptions = {}, fixture: GitFixture = { repos }) => {
    const { handler } = gitHandler(fixture);
    const deps = createFakeDeps({ cwd: WS, run: handler, env: ENV, ...extra });
    for (const path of Object.keys(fixture.repos ?? {})) deps.seedDir(`${path}/.git`);
    deps.seedDir('/ws/docs');
    return deps;
  };
  const withHome = (extra: Partial<InitOptions> = {}): InitOptions => options({ home: undefined, yes: false, ...extra });
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const projectsOf = async (deps: FakeDeps) => {
    const config = await loadConfig(deps, PROPOSAL);
    return config.ok ? config.value.recipe.projects.map((project) => [project.id, project.path]) : null;
  };

  it('uses ./<folder>-factory for --yes, lists each repo as a project and names the skipped checkout', async () => {
    const deps = inWorkspace();
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe(PROPOSAL);
    expect(await projectsOf(deps)).toEqual([
      ['api', 'api'],
      ['web', 'web'],
    ]);
    expect(result.ok && result.value.json['skipped']).toEqual([
      { path: '/ws/web-search', reason: 'it is one more work tree of the repo web' },
    ]);
    const text = result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';
    expect(text).toContain('Skipped /ws/web-search: it is one more work tree of the repo web.');
    expect(deps.files.has('/ws/factory.yaml')).toBe(false);
  });

  it('puts the repos of the folder before every --project, and does not repeat one', async () => {
    const deps = inWorkspace({}, { repos: { ...repos, '/ws/more/lib': {} } });
    const result = await runInit(deps, withHome({ yes: true, projects: ['/ws/more/lib', '/ws/web'] }));
    expect(result.ok).toBe(true);
    expect((await projectsOf(deps))?.map(([id]) => id)).toEqual(['api', 'web', 'lib']);
  });

  it('prints the proposal and exits 2 without a terminal and without --yes, and writes nothing', async () => {
    const deps = inWorkspace();
    const before = snapshot(deps);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    const message = messageOf(result);
    expect(message).toContain('this folder holds the git repos api, web');
    expect(message).toContain(`The proposed factory folder is ${PROPOSAL}`);
    expect(message).toContain('/ws/web-search');
    expect(message).toContain('--yes');
    expect(snapshot(deps)).toBe(before);
  });

  it('lists the repos of the user home as the folder, and makes no file call at or under its settings folder', async () => {
    const user = '/users/me';
    const { handler } = gitHandler({ repos: { [`${user}/web`]: {} } });
    const deps = createFakeDeps({ cwd: user, run: handler, env: ENV });
    deps.seedDir(`${user}/web/.git`);
    deps.seedDir(`${user}/.claude/.git`);
    const seen: string[] = [];
    const result = await runInit(withFsWatch(deps, (_method, path) => seen.push(path)), withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('this folder holds the git repos web');
    expect(seen.filter((path) => path === `${user}/.claude` || path.startsWith(`${user}/.claude/`))).toEqual([]);
  });

  it('asks on a terminal, shows the repos and the skipped folder, and goes on for y', async () => {
    const deps = inWorkspace({ ...terminal, prompt: answerHome('y') });
    const result = await runInit(deps, withHome());
    expect(result.ok).toBe(true);
    expect(homeQuestions(deps)).toHaveLength(1);
    expect(deps.prompts[0]).toContain('this folder holds the git repos api, web');
    expect(deps.prompts[0]).toContain('/ws/web-search');
    expect(deps.prompts[0]).toContain('Create the factory folder here? [y/N]');
  });

  it('replaces the control characters of a folder name in the question', async () => {
    const deps = inWorkspace({ ...terminal, prompt: answerHome('y') }, { repos: { '/ws/we\u001b[2Jb': {} } });
    await runInit(deps, withHome());
    expect(homeQuestions(deps)).toHaveLength(1);
    expect(deps.prompts[0]).toContain('this folder holds the git repos we?[2Jb');
    expect(deps.prompts[0]).not.toContain('\u001b');
  });

  it('refuses a folder whose name holds a control character with exit 2, repeats no control character, and writes nothing', async () => {
    const deps = inWorkspace({ ...terminal, prompt: () => ok('y') }, { repos: { '/ws/we\u001b[2Jb': {} } });
    const before = snapshot(deps);
    const result = await runInit(deps, withHome());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).not.toContain('\u001b');
    expect(deps.calls.filter((call) => call.args[0] === 'clone')).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 2 when the person does not accept', async () => {
    const deps = inWorkspace({ ...terminal, prompt: () => ok('n') });
    const before = snapshot(deps);
    expect(await runInit(deps, withHome())).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('makes the workspace folder the root when --home names it, and lists no project that the person did not name', async () => {
    const deps = inWorkspace();
    const result = await runInit(deps, withHome({ home: WS, yes: true }));
    expect(result.ok && result.value.json['home']).toBe(WS);
    const config = await loadConfig(deps, WS);
    expect(config.ok && config.value.recipe.projects).toEqual([]);
  });

  it('uses the current folder when it holds no repo', async () => {
    const deps = inWorkspace({}, { repos: {} });
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe(WS);
    expect(deps.prompts).toEqual([]);
  });

  it('does not stop for a temp folder that a stopped init left, names it with the words temp folder, and removes nothing (TP-12, TP-73)', async () => {
    // The pid of the fake run is 4242, so a temp folder of another pid is a leftover.
    const deps = inWorkspace({}, { repos: { '/ws/.factory.tmp-77': {} } });
    deps.seedDir('/ws/.factory.tmp-77');
    deps.seed('/ws/.factory.tmp-77/mine.txt', 'left by a stopped run');
    const result = await runInit(deps, withHome({ home: WS, yes: true }));
    expect(result.ok).toBe(true);
    const warnings = result.ok ? result.value.warnings : [];
    expect(warnings.some((text) => text.includes('the temp folder /ws/.factory.tmp-77'))).toBe(true);
    expect(deps.files.get('/ws/.factory.tmp-77/mine.txt')).toBe('left by a stopped run');
  });

  it('plans a warning, not a stop, for a temp folder of a stopped init, and the plan removes nothing', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory.tmp-4242': {} } });
    const before = snapshot(deps);
    const plan = await planInit(deps, options({ home: WS }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const warning = plan.value.warnings.find((text) => text.includes('temp folder'));
    expect(warning).toBe(
      'The factory folder holds the temp folder /ws/.factory.tmp-4242, left by a stopped init. ' +
        'Remove /ws/.factory.tmp-4242 by hand when no init runs.',
    );
    expect(oldWordsIn(warning ?? '')).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('warns about a temp folder that comes after the first 200 names of the folder', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory.tmp-4243': {} } });
    for (let i = 0; i < 205; i += 1) deps.seedDir(`/ws/.a${String(i).padStart(3, '0')}`);
    const plan = await planInit(deps, options({ home: WS }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.warnings.some((text) => text.includes('the temp folder /ws/.factory.tmp-4243'))).toBe(true);
  });

  it.each([['.factory.tmp-'], ['.factory.tmp-4a'], ['.factory.tmp']])(
    'does not call %s a temp folder, because the name is not the name of a temp folder',
    async (name) => {
      const deps = inWorkspace({}, { repos: { [`/ws/${name}`]: {} } });
      const plan = await planInit(deps, options({ home: WS }));
      expect(plan.ok && plan.value.warnings.some((text) => text.includes('temp folder'))).toBe(false);
    },
  );

  it('reports a folder with more entries than the scan reads', async () => {
    const deps = inWorkspace();
    for (let i = 0; i < 205; i += 1) deps.seedDir(`/ws/z${String(i).padStart(3, '0')}`);
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.warnings.join('\n')).toContain('Only the first 200 entries');
  });

  describe('in a folder that is a node home already', () => {
    const inNode = (cwd: string = WS, extra: FakeOptions = {}) => {
      const deps = inWorkspace({ ...extra, cwd }, { repos: { ...repos, '/ws/.factory': {} } });
      deps.seed('/ws/factory.yaml', 'schema: 2\n');
      deps.seed('/ws/factory.local.yaml', 'schema: 1\n');
      deps.seedDir('/ws/sub');
      return deps;
    };

    it.each([[false], [true]])('exits 1 with "already exists" and proposes no home, with --yes %s', async (yes) => {
      const deps = inNode(WS, { ...terminal, prompt: () => ok('y') });
      const before = snapshot(deps);

      const result = await runInit(deps, withHome({ yes }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('factory.yaml already exists in /ws');
      expect(messageOf(result)).toContain('factory doctor');
      expect(messageOf(result)).not.toContain('proposed');
      expect(deps.prompts).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });

    it('exits 1 for a folder that holds a state folder and no config file', async () => {
      const { handler } = gitHandler({ repos: { '/ws/web': {}, '/ws/.factory': {} } });
      const deps = createFakeDeps({ cwd: WS, run: handler, env: ENV });
      deps.seedDir('/ws/web/.git');
      deps.seedDir('/ws/.factory/.git');

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('.factory already exists in /ws');
    });

    it('exits 1 for a folder below a root that the factory list holds, names that root, and writes nothing', async () => {
      const deps = inNode('/ws/sub', { ...terminal, prompt: () => ok('y') });
      registerRoot(deps, '/ws', 'ws');
      const before = snapshot(deps);

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('/ws/sub is inside the factory folder /ws');
      expect(messageOf(result)).not.toContain('already exists');
      expect(snapshot(deps)).toBe(before);
    });

    it('exits 1 for a repo-holding folder below a listed root, and clones nothing', async () => {
      const { handler, log } = gitHandler({ repos: { '/ws/sub/app': { origin: 'git@host:acme/app.git' } } });
      const deps = createFakeDeps({ cwd: '/ws/sub', run: handler, env: ENV });
      deps.seedDir('/ws/sub/app/.git');
      deps.seed('/ws/factory.yaml', 'schema: 2\n');
      registerRoot(deps, '/ws', 'ws');
      const before = snapshot(deps);

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('is inside the factory folder /ws');
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });

    it.each([
      [
        'a config file',
        (deps: FakeDeps) => {
          deps.seed('/ws/sub/factory.yaml', 'schema: 2\n');
          deps.seed('/ws/sub/factory.local.yaml', 'schema: 1\n');
        },
        'factory.yaml already exists in /ws/sub',
      ],
      ['a state folder', (deps: FakeDeps) => deps.seedDir('/ws/sub/.factory'), '.factory already exists in /ws/sub'],
    ])('exits 1 for a folder that holds %s, also when a folder above it is a node home', async (_name, prepare, text) => {
      const deps = inNode('/ws/sub');
      prepare(deps);

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain(text);
      expect(deps.prompts).toEqual([]);
    });
  });

  /** A workspace folder with 60 repos, and `count` URLs. A URL target is a clone already when `cloned` is true. */
  const crowded = (count: number, cloned: boolean) => {
    const found = Array.from({ length: 60 }, (_, i) => `/ws/r${String(i).padStart(2, '0')}`);
    const urls = Array.from({ length: count }, (_, i) => `https://host/acme/p${String(i).padStart(2, '0')}.git`);
    const targets = urls.map((url, i) => [`${PROPOSAL}/p${String(i).padStart(2, '0')}`, url] as const);
    const repos = Object.fromEntries([
      ...found.map((path) => [path, {}]),
      ...(cloned ? targets.map(([path, origin]) => [path, { origin }]) : []),
    ]);
    const { handler, log } = gitHandler({ repos });
    const deps = createFakeDeps({ cwd: WS, run: handler, env: ENV });
    for (const path of found) deps.seedDir(`${path}/.git`);
    if (cloned) for (const [path] of targets) deps.seedDir(`${path}/.git`);
    return { deps, log, urls };
  };

  it('counts the repos of the folder and the --project values together, and runs no clone above 100', async () => {
    const { deps, log, urls } = crowded(41, false);
    const before = snapshot(deps);

    const result = await runInit(deps, withHome({ yes: true, projects: urls }));

    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('at most 100 projects are allowed');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('accepts exactly 100 projects in all', async () => {
    const { deps, urls } = crowded(40, true);
    const result = await runInit(deps, withHome({ yes: true, projects: urls }));
    expect(result.ok && result.value.json['home']).toBe(PROPOSAL);
  });
});

describe('init: a project URL', () => {
  const URL_API = 'https://host/acme/api.git';
  const run = (fixture: GitFixture, projects: readonly string[], extra: FakeOptions = {}) => {
    const { deps, log } = setup(fixture, extra);
    return { deps, log, done: runInit(deps, options({ projects })) };
  };

  it('clones into the root with "--" before the URL, and stores the folder name as the path', async () => {
    const { deps, log, done } = run({ repos: { '/w/node/api': { origin: URL_API } } }, [URL_API]);
    const result = await done;
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', URL_API, '/w/node/api']]);
    expect(deps.calls.find((call) => call.args[0] === 'clone')?.timeoutMs).toBe(300_000);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((project) => [project.id, project.path])).toEqual([['api', 'api']]);
    expect(result.ok && result.value.json['cloned']).toEqual(['/w/node/api']);
  });

  it.each([
    ['https://host/acme/api', 'api'],
    ['https://host:8443/acme/api.git', 'api'],
    ['ssh://git@host/acme/api.git', 'api'],
    ['git@host.example:acme/api.git', 'api'],
  ])('accepts the form %s', async (url, name) => {
    const { log, done } = run({ repos: { [`/w/node/${name}`]: { origin: url } } }, [url]);
    expect((await done).ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', url, `/w/node/${name}`]]);
  });

  it('clones a repo that has the name of the root into the root', async () => {
    const { log, done } = run({}, ['https://host/acme/node.git']);
    expect((await done).ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', 'https://host/acme/node.git', '/w/node/node']]);
  });

  it('reuses a target that is a clone of the same URL, and runs no clone', async () => {
    const { deps, log } = setup({ repos: { '/w/node/api': { origin: URL_API } } });
    deps.seedDir('/w/node/api');
    const result = await runInit(deps, options({ projects: [URL_API] }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([]);
    expect(result.ok && result.value.json['cloned']).toEqual([]);
  });

  it('exits 1 and names the path when the target is a clone of another URL, and changes nothing', async () => {
    const { deps, log } = setup({ repos: { '/w/node/api': { origin: 'https://host/other/api.git' } } });
    deps.seedDir('/w/node/api');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: [URL_API] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('/w/node/api');
    expect(messageOf(result)).toContain('Move the folder, or choose another repo.');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 1 for a target that is a folder with no repo, and for a target that is a file', async () => {
    const folder = setup({});
    folder.deps.seedDir('/w/node/api');
    expect(await runInit(folder.deps, options({ projects: [URL_API] }))).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(folder.log.clones()).toEqual([]);

    const file = setup({});
    file.deps.seed('/w/node/api', 'x');
    expect(await runInit(file.deps, options({ projects: [URL_API] }))).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(file.log.clones()).toEqual([]);
  });

  it.each([
    ['a name with ..', 'https://host/acme/..'],
    ['a name with .. inside', 'https://host/acme/a..b.git'],
    ['a name that starts with a hyphen', 'https://host/acme/-x.git'],
    ['a name that is only .git', 'https://host/acme/.git'],
    ['a name that is too long', `https://host/acme/${'a'.repeat(101)}.git`],
    ['an http URL', 'http://host/acme/api.git'],
    ['a file URL with a host', 'file://host/srv/acme/api.git'],
    ['a transport helper', 'ext::sh -c touch% /tmp/x'],
    ['a host that starts with a hyphen', 'ssh://-oProxyCommand=x/acme/api.git'],
    ['a user that starts with a hyphen', '-oProxyCommand=x@host:acme/api.git'],
  ])('exits 2 and clones nothing for %s', async (_name, url) => {
    const { deps, log, done } = run({}, [url]);
    const before = snapshot(deps);
    const result = await done;
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 2 for two URLs that name the same folder', async () => {
    const { log, done } = run({}, [URL_API, 'git@host:other/api.git']);
    expect(await done).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(log.clones()).toEqual([]);
  });

  it('fails with exit 1 when the clone fails, and writes no node file', async () => {
    const { deps, done } = run({ cloneExit: 128 }, [URL_API]);
    const result = await done;
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('cannot clone');
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
  });

  describe('the undo of the clones', () => {
    const URL_DOCS = 'https://host/acme/docs.git';

    /** The fake git makes the folder of a clone, as the real git does. A clone of `failingUrl` fails. */
    const cloneSetup = (fixture: GitFixture, failingUrl?: string, afterClone?: (deps: FakeDeps, target: string) => void) => {
      const { handler } = gitHandler(fixture);
      const deps: FakeDeps = createFakeDeps({
        cwd: '/w',
        env: ENV,
        run: (call) => {
          if (call.command === 'git' && call.args[0] === 'clone') {
            if (call.args[2] === failingUrl) return exited(128, '', 'fatal: could not read from the remote repository\n');
            const target = call.args[3] ?? '';
            deps.seedDir(target);
            deps.seed(`${target}/README.md`, 'cloned');
            afterClone?.(deps, target);
          }
          return handler(call);
        },
      });
      return deps;
    };

    it('removes the clone that this run made when a later step fails, and keeps a folder that was there before', async () => {
      const deps = cloneSetup({ repos: { '/w/node/docs': { origin: URL_DOCS } } });
      deps.seedDir('/w/node/docs');
      deps.seed('/w/node/docs/README.md', 'mine');

      const result = await runInit(failingWrite(deps, '/factory.yaml'), options({ projects: [URL_API, URL_DOCS] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(deps.dirs.has('/w/node/api')).toBe(false);
      expect(deps.files.has('/w/node/api/README.md')).toBe(false);
      expect(deps.dirs.has('/w/node/docs')).toBe(true);
      expect(deps.files.get('/w/node/docs/README.md')).toBe('mine');
      expect(messageOf(result)).toContain('Removed the clone that this run made: /w/node/api.');
      expect(messageOf(result)).not.toContain('/w/node/docs');
      expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    });

    it('removes the clone that an earlier URL made when a later clone fails', async () => {
      const deps = cloneSetup({}, URL_DOCS);

      const result = await runInit(deps, options({ projects: [URL_API, URL_DOCS] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('cannot clone https://host/acme/docs.git');
      expect(messageOf(result)).toContain('Removed the clone that this run made: /w/node/api.');
      expect(deps.dirs.has('/w/node/api')).toBe(false);
    });

    it('names a clone that it cannot remove', async () => {
      const deps = cloneSetup({});
      const stuck: Deps = {
        ...deps,
        fs: {
          ...deps.fs,
          remove: async (path) => (path === '/w/node/api' ? failure('cannot remove /w/node/api: EBUSY') : deps.fs.remove(path)),
        },
      };

      const result = await runInit(failingWrite(stuck, '/factory.yaml'), options({ projects: [URL_API] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('These clones could not be removed: /w/node/api (cannot remove /w/node/api: EBUSY).');
      expect(messageOf(result)).not.toContain('Removed the clone');
    });

    describe('the folders above the clones', () => {
      const NESTED = '/w/new/deep/place';
      const nested = (): InitOptions => options({ home: NESTED, projects: [URL_API] });

      it('removes the folders that this run made, deepest first, when a later step fails', async () => {
        const deps = cloneSetup({});

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
        expect(messageOf(result)).toContain('Removed the clone that this run made: /w/new/deep/place/api.');
        expect(messageOf(result)).toContain('Removed the folders that this run made: /w/new/deep/place, /w/new/deep, /w/new.');
        expect([...deps.dirs].filter((dir) => dir.startsWith('/w/new'))).toEqual([]);
        expect(deps.dirs.has('/w')).toBe(true);
      });

      it('removes the folders that this run made when a clone fails', async () => {
        const deps = cloneSetup({}, URL_API);

        const result = await runInit(deps, nested());

        expect(messageOf(result)).toContain('cannot clone https://host/acme/api.git');
        expect(messageOf(result)).toContain('Removed the folders that this run made: /w/new/deep/place, /w/new/deep, /w/new.');
        expect([...deps.dirs].filter((dir) => dir.startsWith('/w/new'))).toEqual([]);
      });

      it('never removes a folder that was there before the run', async () => {
        const deps = cloneSetup({});
        deps.seedDir('/w/new');
        deps.seed('/w/new/mine.txt', 'mine');

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(messageOf(result)).toContain('Removed the folders that this run made: /w/new/deep/place, /w/new/deep.');
        expect(deps.dirs.has('/w/new/deep')).toBe(false);
        expect(deps.files.get('/w/new/mine.txt')).toBe('mine');
      });

      it('keeps a folder that this run made when it is not empty, and names it', async () => {
        const deps = cloneSetup({}, undefined, (fake) => fake.seed('/w/new/stray.txt', 'x'));

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(deps.files.has('/w/new/stray.txt')).toBe(true);
        expect(deps.dirs.has('/w/new/deep')).toBe(false);
        expect(messageOf(result)).toContain('These folders could not be removed: /w/new (cannot remove /w/new: ENOTEMPTY).');
      });

      it('removes the folders that it made when it cannot make the next one, and runs no clone', async () => {
        const { deps, log } = setup({});
        const stuck: Deps = {
          ...deps,
          fs: {
            ...deps.fs,
            mkdir: async (path, mode) =>
              path === '/w/new/deep' ? failure('cannot create /w/new/deep: EACCES') : deps.fs.mkdir(path, mode),
          },
        };

        const result = await runInit(stuck, nested());

        expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
        expect(messageOf(result)).toContain('cannot create /w/new/deep: EACCES');
        expect(messageOf(result)).toContain('Removed the folder that this run made: /w/new.');
        expect(deps.dirs.has('/w/new')).toBe(false);
        expect(log.clones()).toEqual([]);
      });

      it('keeps the folders and the home when the run succeeds', async () => {
        const deps = cloneSetup({});

        const result = await runInit(deps, nested());

        expect(result.ok).toBe(true);
        expect(deps.files.has(`${NESTED}/factory.yaml`)).toBe(true);
        expect(deps.dirs.has('/w/new/deep/place/api')).toBe(true);
      });
    });
  });

  describe('a URL with credentials', () => {
    const TOKEN = 'ghp_S3cretT0kenValue';
    const URL_TOKEN = `https://${TOKEN}@github.com/acme/api.git`;
    const URL_SHOWN = 'https://github.com/acme/api.git';
    const echoed ={ cloneExit: 128, cloneStderr: `fatal: unable to access '${URL_TOKEN}/': The requested URL returned error: 403\n` };

    /** Every text that the command shows or keeps: its result, and each file and folder of the file system. */
    const everythingOf = (deps: FakeDeps, result: unknown): string =>
      JSON.stringify([result, [...deps.files.entries()], [...deps.dirs]]);

    /** A folder whose origin holds a token. The token reaches init through the origin, never through the project flag. */
    const WITH_TOKEN = { repos: { '/w/api': { origin: URL_TOKEN } } };

    const initCli = async (fixture: GitFixture, json: boolean, project: string = URL_TOKEN) => {
      const { deps } = setup(fixture);
      const sink = captureSink();
      const argv = ['init', '--yes', '--home', HOME, '--owner-name', 'Test Owner', '--project', project, ...(json ? ['--json'] : [])];
      const code = await runCli(argv, deps, sink);
      return { deps, code, out: sink.out.join(''), err: sink.errors.join('') };
    };

    it('refuses a project flag with a token, exits 2, clones nothing, and changes nothing (TP-26)', async () => {
      const { deps, log, done } = run({}, [URL_TOKEN]);
      const before = snapshot(deps);
      const result = await done;
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
      expect(messageOf(result)).toContain('--project');
      expect(messageOf(result)).toContain('holds a user name, a password or a token');
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
    });

    it('names the remedy of a refused project flag', async () => {
      const { done } = run({}, [URL_TOKEN]);
      const result = await done;
      expect(!result.ok && result.error.hint).toContain('https URL with no user name, or an ssh URL');
      expect(!result.ok && result.error.hint).toContain('Then run "factory init" again.');
    });

    it.each([
      ['an https URL with a user and a password', `https://user:${TOKEN}@github.com/acme/api.git`],
      ['an https URL with a user name only', 'https://someone@github.com/acme/api.git'],
      ['an ssh URL with a password', `ssh://git:${TOKEN}@github.com/acme/api.git`],
      ['the scp form with a password', `git:${TOKEN}@github.com:acme/api.git`],
    ])('refuses %s before any clone, with exit 2 and without the secret', async (_name, url) => {
      const { deps, log, done } = run({}, [url]);
      const result = await done;
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(log.clones()).toEqual([]);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
    });

    it('refuses a project flag with a token before a good URL clones, so no clone runs for the pair', async () => {
      const { log, done } = run({}, [URL_API, URL_TOKEN]);
      expect(await done).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(log.clones()).toEqual([]);
    });

    it('writes the url of an origin with a token without the token, and warns without naming it (TP-26)', async () => {
      const { deps, log, done } = run(WITH_TOKEN, ['/w/api']);
      const result = await done;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(deps.files.get(`${HOME}/factory.yaml`)).toContain('acme/api');
      expect(deps.files.get(`${HOME}/factory.yaml`)).toContain(`url: "${URL_SHOWN}"`);
      expect(deps.files.has(INDEX)).toBe(true);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
      expect(JSON.stringify(log.calls)).not.toContain(TOKEN);
      expect(log.clones()).toEqual([['clone', '--', URL_SHOWN, '/w/node/api']]);
      const warnings = result.value.warnings.filter((warning) => warning.includes('.git/config'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('api');
      expect(warnings[0]).toContain('gh auth login');
      expect(warnings[0]).not.toContain(TOKEN);
    });

    it('cuts only the secret part of an ssh origin and keeps the user name that ssh needs', async () => {
      const origin = `ssh://git:${TOKEN}@github.com/acme/api.git`;
      const { deps, log, done } = run({ repos: { '/w/api': { origin } } }, ['/w/api']);
      const result = await done;
      expect(result.ok && result.value.warnings.filter((warning) => warning.includes('.git/config'))).toHaveLength(1);
      expect(deps.files.get(`${HOME}/factory.yaml`)).toContain('url: "ssh://git@github.com/acme/api.git"');
      expect(log.clones()).toEqual([['clone', '--', 'ssh://git@github.com/acme/api.git', '/w/node/api']]);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
    });

    it.each(['ssh://git@github.com/acme/api.git', 'git@github.com:acme/api.git', URL_SHOWN])(
      'does not warn about credentials for %s, which holds none',
      async (url) => {
        const { done } = run({ repos: { '/w/api': { origin: url } } }, ['/w/api']);
        const result = await done;
        expect(result.ok && result.value.warnings.filter((warning) => warning.includes('.git/config'))).toEqual([]);
      },
    );

    it('prints the token on neither stdout nor stderr, and prints the warning on stderr', async () => {
      const { code, out, err } = await initCli(WITH_TOKEN, false, '/w/api');
      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain(TOKEN);
      expect(err).toContain('warning: ');
      expect(err).toContain('gh auth login');
    });

    it('puts the warning in the JSON document, with no token', async () => {
      const { code, out, err } = await initCli(WITH_TOKEN, true, '/w/api');
      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain(TOKEN);
      expect(out).toContain('gh auth login');
    });

    it('exits 2 for a project flag with a token, and prints the reason and the remedy but not the token', async () => {
      for (const json of [false, true]) {
        const { deps, code, out, err } = await initCli(echoed, json);
        expect(code).toBe(2);
        expect(`${out}${err}`).not.toContain(TOKEN);
        expect(`${out}${err}`).toContain('holds a user name, a password or a token');
        expect(`${out}${err}`).toContain('https URL with no user name, or an ssh URL');
        expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
      }
    });

    it('refuses the user:password form and does not repeat it', async () => {
      const { done } = run({}, ['https://user:tok3n@host/acme/api.git']);
      const result = await done;
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(JSON.stringify(result)).not.toContain('tok3n');
    });

    it.each(['user:s3cr3t@host:acme/api.git', 'user:@host:acme/api.git', 'a:b@host'])(
      'refuses the form %s with a usage error that does not repeat it, and runs no clone',
      async (value) => {
        const { deps, log, done } = run({}, [value]);
        const result = await done;
        expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
        expect(messageOf(result)).toContain('holds a user name, a password or a token');
        expect(everythingOf(deps, result)).not.toContain(value);
        expect(log.clones()).toEqual([]);
      },
    );

    it('prints no part of a user:secret@host:path value on stdout or stderr', async () => {
      const { deps } = setup({});
      const sink = captureSink();
      const argv = ['init', '--home', HOME, '--owner-name', 'Test Owner', '--project', 'user:s3cr3t@host:acme/api.git'];
      expect(await runCli(argv, deps, sink)).toBe(2);
      expect(`${sink.out.join('')}${sink.errors.join('')}`).not.toContain('s3cr3t');
    });

    it('keeps a path that holds a colon and an @ as a path', async () => {
      const { deps, log } = setup({ repos: { '/w/odd:name@x': {} } });
      deps.seedDir('/w/odd:name@x');
      expect(await runInit(deps, options({ projects: ['/w/odd:name@x'] }))).toMatchObject({ ok: true });
      expect(log.clones()).toEqual([['clone', '--', '/w/odd:name@x', '/w/node/odd:name@x']]);
    });
  });

  it('keeps a path as a path and a URL as a URL in one command', async () => {
    const { deps, log, done } = run({ repos: { '/w/web': {} } }, ['/w/web', URL_API]);
    expect((await done).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((project) => project.id)).toEqual(['web', 'api']);
    expect(log.clones()).toEqual([
      ['clone', '--', '/w/web', '/w/node/web'],
      ['clone', '--', URL_API, '/w/node/api'],
    ]);
  });
});

describe('init: the checks before a clone', () => {
  const URL_API = 'https://host/acme/api.git';

  /** Run init with a URL project and the given options. The result, the git log and the change of the file system. */
  const initWithUrl = async (extra: Partial<InitOptions>, fixture: GitFixture = {}, prepare?: (deps: FakeDeps) => void) => {
    const { deps, log } = setup(fixture);
    prepare?.(deps);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: [URL_API], ...extra }));
    return { result, log, changed: snapshot(deps) !== before };
  };

  it.each([['0'], ['17'], ['x'], ['1.5']])('gives the error of --layer %s and runs no clone', async (layer) => {
    const { result, log, changed } = await initWithUrl({ layer });
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--layer');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('gives the error of --recipe and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({ recipe: 'no-such-recipe' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--recipe');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('gives the error for a missing owner name and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({ ownerName: undefined }, { identity: false });
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--owner-name');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a home inside a root that the factory list holds and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({}, {}, (deps) => {
      deps.seed('/w/factory.yaml', 'schema: 2\n');
      registerRoot(deps, '/w', 'listed');
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(`the factory folder ${HOME} is inside the factory folder /w`);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('gives the error for a home name that makes no node id and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({ home: '/w/___' });
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('cannot make a node id from the folder name');
    expect(messageOf(result)).toContain('--name');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it.each([
    ['--name', { name: 'Not A Slug' }],
    ['--owner-github', { ownerGithub: '-no-login' }],
    ['--owner-name', { ownerName: 'x'.repeat(81) }],
  ])('gives the error for a bad value of %s and runs no clone', async (_flag, extra) => {
    const { result, log, changed } = await initWithUrl(extra);
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('invalid settings');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it.each([
    [
      'a config file',
      (deps: FakeDeps) => {
        deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
        deps.seed(`${HOME}/factory.local.yaml`, 'schema: 1\n');
      },
      'factory.yaml already exists',
    ],
    ['a state folder', (deps: FakeDeps) => deps.seedDir(`${HOME}/.factory`), '.factory already exists'],
    ['a home that is a file', (deps: FakeDeps) => deps.seed(HOME, 'x'), `${HOME} is not a folder`],
  ])('refuses %s with exit 1 and runs no clone', async (_name, prepare, text) => {
    const { result, log, changed } = await initWithUrl({}, {}, prepare);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(text);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('gives "already exists" before the error for a missing owner name', async () => {
    const { result, log } = await initWithUrl({ ownerName: undefined }, { identity: false }, (deps) => {
      deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
      deps.seed(`${HOME}/factory.local.yaml`, 'schema: 1\n');
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.yaml already exists');
    expect(log.clones()).toEqual([]);
  });

  it.each([
    ['is not a file', (deps: FakeDeps) => deps.seedDir(`${HOME}/coordinator/CLAUDE.md`), 'CLAUDE.md is not a file'],
    [
      'has a broken block marker',
      (deps: FakeDeps) => deps.seed(`${HOME}/coordinator/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n'),
      'CLAUDE.md: line 1',
    ],
  ])('refuses a CLAUDE.md that %s and runs no clone', async (_name, prepare, text) => {
    const { result, log, changed } = await initWithUrl({}, {}, prepare);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(text);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it.each([
    ['a .gitignore that is a folder', (deps: FakeDeps) => deps.seedDir(`${HOME}/.gitignore`), '.gitignore is not a file'],
    [
      'a .gitignore with a marker line of the share list that has no pair',
      (deps: FakeDeps) => deps.seed(`${HOME}/.gitignore`, '# factory:begin share list\n/*\n'),
      '.gitignore holds a marker line of the share list that has no pair',
    ],
    ['a setup path that is a file', (deps: FakeDeps) => deps.seed(`${HOME}/setup`, 'x'), 'setup is not a folder'],
    [
      'a setup text that is a folder',
      (deps: FakeDeps) => deps.seedDir(`${HOME}/setup/coordinator.md`),
      'setup/coordinator.md is not a file',
    ],
  ])('refuses %s and runs no clone', async (_name, prepare, text) => {
    const { result, log, changed } = await initWithUrl({}, {}, prepare);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(text);
    expect(messageOf(result)).toContain('then run "factory init" again');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a CLAUDE.md that holds a block of the same name and runs no clone', async () => {
    const first = setup();
    await runInit(first.deps, options());
    const { result, log, changed } = await initWithUrl({}, {}, (deps) =>
      deps.seed(`${HOME}/coordinator/CLAUDE.md`, first.deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? ''),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('already holds the block coordinator');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('warns about a temp folder of a stopped init, does not stop for it, and keeps the folder (TP-73)', async () => {
    const leftover = `${HOME}/.factory.tmp-77`;
    const { deps } = setup({ repos: { [leftover]: {} } });
    deps.seedDir(`${leftover}/.git`);
    const result = await runInit(deps, options({ projects: [URL_API] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join('\n')).toContain(`temp folder ${leftover}, left by a stopped init`);
    expect(deps.dirs.has(`${leftover}/.git`)).toBe(true);
  });

  it('refuses a project folder name that the root keeps for itself and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({ projects: [URL_API, 'https://host/acme/setup.git'] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('setup');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('still clones when every value is good', async () => {
    const { result, log } = await initWithUrl({ layer: '1', recipe: 'software' });
    expect(result.ok).toBe(true);
    expect(log.clones()).toHaveLength(1);
  });
});

describe('init: the factory list', () => {
  const repos = { '/w/web': { origin: 'git@host:acme/web.git' }, '/w/api': { origin: 'git@host:acme/api.git' } };
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');

  it('records the root, its id and the path of each project clone after it writes the node', async () => {
    const { deps } = setup({ repos });
    const result = await runInit(deps, options({ projects: ['/w/web', '/w/api'] }));
    expect(result.ok && result.value.warnings).toEqual([
      'The old folder /w/web keeps the work that is not pushed. The clone holds only what the origin holds.',
      'The old folder /w/api keeps the work that is not pushed. The clone holds only what the origin holds.',
    ]);
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: [{ home: HOME, id: 'node', projects: ['/w/node/web', '/w/node/api'], origin: 'own' }],
    });
    expect(deps.modes.get(INDEX)).toBe(0o600);
    expect(deps.modes.get('/state/factory')).toBe(0o700);
  });

  it('records the real paths when the folders are behind a link', async () => {
    const { deps } = setup({ repos: { '/w/via/proj': {}, '/w/real/proj': {} } }, { links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/via/proj');
    deps.seedDir('/w/real');
    await runInit(deps, options({ home: '/w/real/node', projects: ['/w/via/proj'] }));
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: [{ home: '/w/real/node', id: 'node', projects: ['/w/real/node/proj'], origin: 'own' }],
    });
  });

  it('replaces the entry of the same home and keeps the entries of other homes', async () => {
    const { deps } = setup({ repos });
    deps.seed(INDEX, JSON.stringify({ schema: 1, homes: [{ home: '/h/other', id: 'other', projects: ['/h/x'] }] }));
    await runInit(deps, options({ projects: ['/w/web'] }));
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: [
        { home: '/h/other', id: 'other', projects: ['/h/x'] },
        { home: HOME, id: 'node', projects: ['/w/node/web'], origin: 'own' },
      ],
    });
  });

  it('exits 1 before it writes or clones anything when neither variable names a folder for the list', async () => {
    const { deps, log } = setup({ repos }, { env: {} });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('the factory list has no place');
    expect(messageOf(result)).toContain('XDG_STATE_HOME or HOME');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses with exit 4 a list path under the folder of Claude Code, before it writes anything', async () => {
    const { deps } = setup({ repos }, { env: { HOME: '/users/me', XDG_STATE_HOME: '/users/me/.claude/state' } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('puts no warning about the list in the JSON document when the write works', async () => {
    const { deps } = setup({});
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['warnings']).toEqual([]);
  });
});

describe('init: when the factory list can not be written (TP-74, TP-94)', () => {
  /** The fake git makes the `.git` folder of the root, as real git does. */
  const withRootRepo = (seed?: (deps: FakeDeps) => void) => {
    const { handler, log } = gitHandler();
    const deps: FakeDeps = createFakeDeps({
      cwd: '/w',
      env: ENV,
      run: (call) => {
        if (call.args[0] === '-C' && call.args[1] === HOME && call.args[2] === 'init') deps.seed(`${HOME}/.git/HEAD`, 'ref\n');
        return handler(call);
      },
    });
    seed?.(deps);
    return { deps, log };
  };
  const listFails = <T extends Deps>(deps: T): T => withFailingWrites(deps, (path) => path.endsWith('/homes.json'));

  it('exits 1, removes what the run made with the root repo, and prints no success line (TP-74)', async () => {
    const { deps } = withRootRepo();
    const before = snapshot(deps);
    const result = await runInit(listFails(deps), options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(`The factory list ${INDEX} was not updated`);
    expect(messageOf(result)).toContain('nothing was changed');
    expect(messageOf(result)).not.toContain('Created the node');
    expect(deps.files.has(`${HOME}/.git/HEAD`)).toBe(false);
    expect(deps.files.has(INDEX)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('through the command line prints the error and no success line, and exits 1 (TP-74)', async () => {
    const { deps } = withRootRepo();
    const sink = captureSink();
    const code = await runCli(['init', '--yes', '--home', HOME, '--owner-name', 'Test Owner'], listFails(deps), sink);
    expect(code).toBe(1);
    expect(sink.out.join('')).not.toContain('Created the node');
    expect(sink.errors.join('')).toContain('was not updated');
  });

  it('counts the entry as saved when only its lock file stays: it keeps the files, exits 0 and warns with the lock file', async () => {
    const { deps } = withRootRepo();
    const result = await runInit(withFailingRemoves(deps, (path) => path === `${INDEX}.lock`), options());
    expect(result.ok).toBe(true);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
    expect(deps.files.has(`${HOME}/.git/HEAD`)).toBe(true);
    expect(JSON.parse(deps.files.get(INDEX) ?? 'null')).toMatchObject({ homes: [{ home: HOME }] });
    const warnings = result.ok ? result.value.warnings.join('\n') : '';
    expect(warnings).toContain(`${INDEX}.lock`);
    expect(warnings).not.toContain('was not updated');
    expect(result.ok && result.value.json['warnings']).toEqual(expect.arrayContaining([expect.stringContaining(`${INDEX}.lock`)]));
  });

  it('through the command line exits 0 and prints the lock file as a warning when only the lock file of the entry stays', async () => {
    const { deps } = withRootRepo();
    const sink = captureSink();
    const code = await runCli(
      ['init', '--yes', '--home', HOME, '--owner-name', 'Test Owner'],
      withFailingRemoves(deps, (path) => path === `${INDEX}.lock`),
      sink,
    );
    expect(code).toBe(0);
    expect(sink.out.join('')).toContain('Created the node');
    expect(sink.errors.join('')).toContain(`${INDEX}.lock`);
    expect(sink.errors.join('')).not.toContain('was not updated');
  });

  it('lets a second init in the same folder succeed (TP-74)', async () => {
    const { deps } = withRootRepo();
    expect((await runInit(listFails(deps), options())).ok).toBe(false);
    const second = await runInit(deps, options());
    expect(second.ok).toBe(true);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
  });

  it('removes the clones and the folders that the run made, and keeps a clone that was there before (TP-74)', async () => {
    const url = 'https://host/acme/api.git';
    const { handler } = gitHandler();
    const deps: FakeDeps = createFakeDeps({
      cwd: '/w',
      env: ENV,
      run: (call) => {
        if (call.command === 'git' && call.args[0] === 'clone') deps.seed(`${call.args[3]}/README.md`, 'cloned');
        return handler(call);
      },
    });
    const result = await runInit(listFails(deps), options({ home: '/w/new/root', projects: [url] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('Removed the clone that this run made: /w/new/root/api.');
    expect([...deps.dirs, ...deps.files.keys()].filter((path) => path.startsWith('/w/new'))).toEqual([]);
    expect(deps.dirs.has('/w')).toBe(true);
  });

  it('keeps a local file and a coordinator folder that were there before the run, byte for byte (TP-94)', async () => {
    const { deps } = withRootRepo((fake) => {
      fake.seed(`${HOME}/coordinator/notes.txt`, 'my notes\n');
      fake.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
      fake.seed(`${HOME}/setup/coordinator.md`, 'My shared text.\n');
    });
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // A local file appears after the plan: another program made it.
    deps.seed(`${HOME}/factory.local.yaml`, 'owner: mine\n');
    const before = snapshot(deps);

    const result = await applyInit(deps, plan.value);

    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.local.yaml was made by another program during the run');
    expect(deps.files.get(`${HOME}/factory.local.yaml`)).toBe('owner: mine\n');
    expect(deps.files.get(`${HOME}/coordinator/notes.txt`)).toBe('my notes\n');
    expect(deps.files.get(`${HOME}/coordinator/CLAUDE.md`)).toBe('Owner text.\n');
    expect(deps.files.get(`${HOME}/setup/coordinator.md`)).toBe('My shared text.\n');
    expect(deps.dirs.has(`${HOME}/coordinator`)).toBe(true);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    expect(deps.files.has(`${HOME}/.git/HEAD`)).toBe(false);
    expect(deps.files.has(INDEX)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['coordinator/CLAUDE.md', 'Owner text.\n', 'coordinator/CLAUDE.md was made or changed by another program'],
    ['.gitignore', '!/notes.md\n', '.gitignore was made or changed by another program'],
  ])('keeps %s when another program makes it after the plan, and removes nothing of it (TP-94)', async (name, text, message) => {
    const { deps } = withRootRepo();
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    deps.seed(`${HOME}/${name}`, text);
    const result = await applyInit(deps, plan.value);
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain(message);
    expect(deps.files.get(`${HOME}/${name}`)).toBe(text);
    expect(deps.files.has(INDEX)).toBe(false);
  });

  it('keeps a shared file that appeared after the plan, and writes no list entry (TP-94)', async () => {
    const { deps } = withRootRepo();
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    const result = await applyInit(deps, plan.value);
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain('factory.yaml was made by another program during the run');
    expect(deps.files.get(`${HOME}/factory.yaml`)).toBe('schema: 2\n');
    expect(deps.files.has(INDEX)).toBe(false);
    expect(deps.files.has(`${HOME}/factory.local.yaml`)).toBe(false);
  });

  it('keeps a state folder that appeared after the plan, and removes nothing of it (TP-94)', async () => {
    const { deps } = withRootRepo();
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    deps.seed(`${HOME}/.factory/mine.txt`, 'my state\n');
    const result = await applyInit(deps, plan.value);
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain('.factory was made by another program during the run');
    expect(deps.files.get(`${HOME}/.factory/mine.txt`)).toBe('my state\n');
    expect(deps.files.has(INDEX)).toBe(false);
  });

  it('removes the paths that it made but not the ones around them: the list write fails last (TP-94)', async () => {
    const { deps } = withRootRepo((fake) => {
      fake.seed(`${HOME}/coordinator/notes.txt`, 'my notes\n');
      fake.seed(`${HOME}/.gitignore`, '!/notes.md\n');
      fake.seed(`${HOME}/readme.txt`, 'not from this run\n');
    });
    const before = snapshot(deps);
    const result = await runInit(listFails(deps), options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.get(`${HOME}/coordinator/notes.txt`)).toBe('my notes\n');
    expect(deps.files.get(`${HOME}/.gitignore`)).toBe('!/notes.md\n');
    expect(deps.files.get(`${HOME}/readme.txt`)).toBe('not from this run\n');
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    expect(deps.files.has(`${HOME}/factory.local.yaml`)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: output', () => {
  it('prints a summary and a JSON document with a schema field', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.json).toMatchObject({
      schema: 'factory.init/v1',
      home: HOME,
      nodeId: 'node',
      files: [
        'factory.yaml',
        'factory.local.yaml',
        '.gitignore',
        'setup/coordinator.md',
        'setup/roles/worker.md',
        'coordinator/CLAUDE.md',
        '.factory/',
        'coordinator/.claude/settings.local.json',
      ],
      committed: true,
      rootCommitted: true,
    });
    expect(result.value.lines.map((line) => line.text).join('\n')).toContain('factory doctor --home /w/node');
  });

  it('does not list a setup text that was there before the run', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/setup/coordinator.md`, 'My shared text.\n');
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['files']).toEqual([
      'factory.yaml',
      'factory.local.yaml',
      '.gitignore',
      'setup/roles/worker.md',
      'coordinator/CLAUDE.md',
      '.factory/',
      'coordinator/.claude/settings.local.json',
    ]);
    expect(deps.files.get(`${HOME}/setup/coordinator.md`)).toBe('My shared text.\n');
  });

  it('does not list a worker text that was there before the run', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/setup/roles/worker.md`, 'My text for every worker.\n');
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['files']).toEqual([
      'factory.yaml',
      'factory.local.yaml',
      '.gitignore',
      'setup/coordinator.md',
      'coordinator/CLAUDE.md',
      '.factory/',
      'coordinator/.claude/settings.local.json',
    ]);
    expect(deps.files.get(`${HOME}/setup/roles/worker.md`)).toBe('My text for every worker.\n');
  });
});

describe('init: the root .gitignore and the setup text (TP-10, TP-69)', () => {
  const GITIGNORE = `${HOME}/.gitignore`;

  it('writes the share list as the whole .gitignore of a new root, with mode 644 for the setup text', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(GITIGNORE)).toBe(SHARE_LIST_PART);
    expect(deps.modes.get(`${HOME}/setup/coordinator.md`)).toBe(0o644);
    expect(deps.files.get(`${HOME}/setup/coordinator.md`)).toContain('Write your own text');
    expect(deps.modes.get(`${HOME}/setup/roles/worker.md`)).toBe(0o644);
    expect(deps.files.get(`${HOME}/setup/roles/worker.md`)).toContain('Write your own text');
  });

  it('puts the share list before the lines of a person, and keeps those lines as they are', async () => {
    const { deps } = setup();
    deps.seed(GITIGNORE, '!/notes.md\n# mine\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(GITIGNORE)).toBe(`${SHARE_LIST_PART}\n!/notes.md\n# mine\n`);
  });

  it('puts a changed share list right in its place, and keeps the lines around it', async () => {
    const { deps } = setup();
    deps.seed(GITIGNORE, `# top\n${SHARE_LIST_BEGIN}\n/old\n${SHARE_LIST_END}\n!/notes.md\n`);
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(GITIGNORE)).toBe(`# top\n${SHARE_LIST_PART.trimEnd()}\n!/notes.md\n`);
  });

  it('keeps a setup text that is there, and writes no other file in the setup folder than the worker text', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/setup/coordinator.md`, 'My shared text.\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(`${HOME}/setup/coordinator.md`)).toBe('My shared text.\n');
    expect([...deps.files.keys()].filter((path) => path.startsWith(`${HOME}/setup/`)).sort()).toEqual([
      `${HOME}/setup/coordinator.md`,
      `${HOME}/setup/roles/worker.md`,
    ]);
  });

  it('writes no instruction file at the top of the root, and no file in work-copies', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.has(`${HOME}/CLAUDE.md`)).toBe(false);
    expect([...deps.files.keys()].filter((path) => path.startsWith(`${HOME}/work-copies`))).toEqual([]);
  });

  it('keeps the owner text of a coordinator/CLAUDE.md that was there, and the folder when the run fails', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/coordinator/CLAUDE.md`, 'Owner text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(deps.dirs.has(`${HOME}/coordinator`)).toBe(true);
    expect(deps.files.get(`${HOME}/coordinator/CLAUDE.md`)).toBe('Owner text.\n');
  });
});

describe('init: a local file that is there already', () => {
  const LOCAL = `${HOME}/factory.local.yaml`;

  it('stops, and changes nothing, for a local file with no shared file next to it', async () => {
    const { deps } = setup();
    deps.seed(LOCAL, 'schema: 1\n');
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.local.yaml already exists');
    expect(snapshot(deps)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('stops with exit 4 and one remedy line for a local file with %s, and changes no mode', async (_name, change) => {
    const { deps } = setup();
    deps.seed(LOCAL, 'schema: 1\n');
    change(deps);
    const mode = deps.modes.get(LOCAL);
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('chmod 600 factory.local.yaml');
    expect(deps.modes.get(LOCAL)).toBe(mode);
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 and one remedy line for a local file that is a link, and changes nothing (TP-147)', async () => {
    const links: Record<string, string> = { [LOCAL]: '/outside/factory.local.yaml' };
    const { deps } = setup({}, { links });
    deps.seed(LOCAL, 'schema: 1\n');
    deps.modes.set(LOCAL, 0o644);
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory.local.yaml is a link, so factory does not use it');
    expect(messageOf(result)).toContain('Move factory.local.yaml away, then run "factory init" to write a new one.');
    expect(deps.modes.get(LOCAL)).toBe(0o644);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the setup texts and the link rule (TP-102, TP-130)', () => {
  const SETUP = `${HOME}/setup/coordinator.md`;
  const SETUP_WORKER = `${HOME}/setup/roles/worker.md`;
  const CLAUDE = `${HOME}/coordinator/CLAUDE.md`;
  const WORKER = `${HOME}/.factory/roles/worker.md`;
  const blockNamesIn = (deps: FakeDeps, path: string): string[] => {
    const parsed = parseBlocks(deps.files.get(path) ?? '');
    return parsed.ok ? parsed.value.map((block) => block.name) : [];
  };
  const bodyOf = (deps: FakeDeps, path: string, name: string): string | undefined => {
    const parsed = parseBlocks(deps.files.get(path) ?? '');
    return parsed.ok ? parsed.value.find((block) => block.name === name)?.body : undefined;
  };

  it('renders the setup coordinator text into the setup block of coordinator/CLAUDE.md after the core blocks', async () => {
    const { deps } = setup();
    deps.seed(SETUP, 'Our team rules.\nSecond rule.\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(blockNamesIn(deps, CLAUDE)).toEqual(['coordinator', 'safety', 'setup']);
    expect(bodyOf(deps, CLAUDE, 'setup')?.trimEnd()).toBe('Our team rules.\nSecond rule.');
    expect(deps.files.get(SETUP)).toBe('Our team rules.\nSecond rule.\n');
  });

  it('renders the setup worker text into the setup-worker block of the worker file after the worker block', async () => {
    const { deps } = setup();
    deps.seed(SETUP_WORKER, 'Every worker keeps notes.\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(blockNamesIn(deps, WORKER)).toEqual(['worker', 'setup-worker']);
    expect(bodyOf(deps, WORKER, 'setup-worker')?.trimEnd()).toBe('Every worker keeps notes.');
  });

  it('puts the setup text in the block as it is written, and records the version of each setup block', async () => {
    const { deps } = setup();
    deps.seed(SETUP, 'One.\r\nTwo.\r\n');
    await runInit(deps, options());
    expect(bodyOf(deps, CLAUDE, 'setup')?.trimEnd()).toBe('One.\nTwo.');
    const state = await loadState(deps, HOME);
    expect(state.ok && state.value.blocks).toMatchObject({ setup: 1, 'setup-worker': 1 });
  });

  it('renders no setup block for a setup file that is empty, and keeps the file', async () => {
    const { deps } = setup();
    deps.seed(SETUP, '\n\n');
    deps.seed(SETUP_WORKER, '');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(blockNamesIn(deps, CLAUDE)).toEqual(['coordinator', 'safety']);
    expect(blockNamesIn(deps, WORKER)).toEqual(['worker']);
    expect(deps.files.get(SETUP)).toBe('\n\n');
    const state = await loadState(deps, HOME);
    expect(state.ok && Object.keys(state.value.blocks).sort()).toEqual(['coordinator', 'safety', 'worker']);
  });

  it('renders the worker setup block into the worker file of a node on layer 2, and writes no worker setup file text into CLAUDE.md', async () => {
    const { deps } = setup();
    deps.seed(SETUP_WORKER, 'Worker text.\n');
    expect((await runInit(deps, options({ layer: '2' }))).ok).toBe(true);
    expect(deps.files.get(WORKER)).toContain('Worker text.');
    expect(deps.files.get(CLAUDE)).not.toContain('Worker text.');
  });

  it.each([
    ['the coordinator text', SETUP, '<!-- factory:begin coordinator v2 sha256=abc -->\n', 'setup/coordinator.md'],
    ['the worker text', SETUP_WORKER, 'Fine.\n<!-- factory:end worker -->\n', 'setup/roles/worker.md'],
  ])('exits 1 with a remedy line for %s that holds a block marker, runs no clone and writes nothing', async (_name, path, text, shown) => {
    const { deps, log } = setup();
    deps.seed(path, text);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['https://host/acme/api.git'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(`${shown} holds a line that starts a managed block`);
    expect(messageOf(result)).toContain(`Remove the marker lines from ${shown}, then run "factory init" again.`);
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 1 for a setup text over the size bound or with a control character, and writes nothing', async () => {
    for (const text of ['x'.repeat(65_537), 'a\u001bb']) {
      const { deps } = setup();
      deps.seed(SETUP, text);
      const before = snapshot(deps);
      const result = await runInit(deps, options());
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(snapshot(deps)).toBe(before);
    }
  });

  it.each([
    ['the setup folder', `${HOME}/setup`, 'setup'],
    ['the setup text of the coordinator', SETUP, 'setup/coordinator.md'],
    ['the roles folder of the setup', `${HOME}/setup/roles`, 'setup/roles'],
    ['the setup text of the workers', SETUP_WORKER, 'setup/roles/worker.md'],
    ['the coordinator folder', `${HOME}/coordinator`, 'coordinator'],
    ['the coordinator CLAUDE.md', CLAUDE, 'coordinator/CLAUDE.md'],
    ['the state folder', `${HOME}/.factory`, '.factory'],
    ['the worker file', WORKER, '.factory/roles/worker.md'],
    ['the backup folder', `${HOME}/.factory/backups`, '.factory/backups'],
  ])('exits 4 for a link at %s, runs no clone and writes nothing', async (_name, path, shown) => {
    const links: Record<string, string> = { [path]: '/outside/target' };
    const { deps, log } = setup({}, { links });
    // A link can only stand in a folder that exists.
    deps.seedDir(dirname(path));
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['https://host/acme/api.git'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`${shown} is a link, so factory does not use it`);
    expect(messageOf(result)).toContain('Replace the link with a plain file inside the factory folder, then run "factory doctor".');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
    expect(deps.files.has(INDEX)).toBe(false);
  });

  it('works for a factory folder that sits under a linked parent folder (TP-149)', async () => {
    const links: Record<string, string> = { '/w/linked': '/w/real' };
    // The person says no to the hook settings: the fake file system keeps no file under the real path of a link.
    // Git prints the real path of its git folder, so the fixture names the real staging folder.
    const gitDirs = { '/w/linked/node/.factory.tmp-4242': '/w/real/node/.factory.tmp-4242/.git' };
    const { deps } = setup({ gitDirs }, { links, stdinIsTTY: true, stdoutIsTTY: true, prompt: answerHome('y') });
    deps.seedDir('/w/real');
    const result = await runInit(deps, asking({ home: '/w/linked/node' }));
    expect(result.ok ? 'ok' : result.error.message).toBe('ok');
  });
});

describe('init: the approval points (TP-37, TP-38, TP-81, TP-91)', () => {
  const STORE = '/state/factory/owner-records.json';
  const ACCEPTANCES = '/state/factory/setup-acceptances.json';
  const [owner, delegated] = values.approvalModes;
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const inSession = { ...ENV, [env.session]: 'demo' };
  /** The tests of this group are about the questions, so the yes flag is off unless a test sets it. */
  const options = asking;

  /**
   * A person who types the answers in the list, one for each question. A question after the last answer gets none. The
   * person says no to the question about the hook settings, which is not in the list.
   */
  const typing = (answers: readonly string[]): FakeOptions => {
    const queue = [...answers];
    return {
      ...terminal,
      prompt: (question) => {
        if (question.startsWith(HOOK_QUESTION)) return ok('');
        return queue.length === 0 ? failure('no answer was given') : ok(queue.shift() ?? '');
      },
    };
  };

  const modesIn = async (deps: Deps, home = HOME) => {
    const config = await loadConfig(deps, home);
    return config.ok ? config.value.core.approval : null;
  };

  const recordsIn = (deps: FakeDeps): unknown[] =>
    (JSON.parse(deps.files.get(STORE) ?? '{"records":[]}') as { records: unknown[] }).records;

  const delegation = (point: string, mode: string) =>
    expect.objectContaining({ kind: 'delegation', node: 'node', root: HOME, point, mode });

  describe('a terminal window (TP-37)', () => {
    it('asks owner or delegated for each point of the recipe, in order, with owner as the default', async () => {
      const { deps } = setup({}, typing(['', '']));
      const result = await runInit(deps, options());
      expect(result.ok).toBe(true);
      const questions = approvalQuestions(deps);
      expect(questions).toHaveLength(2);
      expect(questions[0]).toContain('merge');
      expect(questions[1]).toContain('release');
      for (const question of questions) {
        expect(question).toContain(`${owner} or ${delegated}`);
        expect(question).toContain(`[${owner}]`);
      }
      expect(await modesIn(deps)).toEqual({ merge: owner, release: owner });
    });

    it('writes the answer of each point to the local file and records it through the owner record writer', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(await modesIn(deps)).toEqual({ merge: delegated, release: owner });
      expect(recordsIn(deps)).toEqual([delegation('merge', delegated), delegation('release', owner)]);
      const config = await loadConfig(deps, HOME);
      expect(config.ok && (await effectiveModes(deps, HOME, config.value))).toEqual({ merge: delegated, release: owner });
    });

    it('takes an answer in any letter case, with blanks, or as its first letter', async () => {
      const { deps } = setup({}, typing([' D ', 'OWNER\n']));
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(await modesIn(deps)).toEqual({ merge: delegated, release: owner });
    });

    it('asks again for an answer that is neither, and stops with exit 2 and no file after three of them', async () => {
      const { deps } = setup({}, typing(['maybe', 'yes', 'no', owner, owner]));
      const before = snapshot(deps);
      const result = await runInit(deps, options());
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('merge');
      expect(deps.prompts).toHaveLength(3);
      expect(snapshot(deps)).toBe(before);
    });

    it('goes on after one bad answer', async () => {
      const { deps } = setup({}, typing(['maybe', delegated, owner]));
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(approvalQuestions(deps)).toHaveLength(3);
      expect(await modesIn(deps)).toEqual({ merge: delegated, release: owner });
    });

    it('fails with exit 1 and writes nothing when a question gets no answer', async () => {
      const { deps } = setup({}, { ...terminal });
      const before = snapshot(deps);
      const result = await runInit(deps, options());
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(snapshot(deps)).toBe(before);
    });

    it('lets the flag set one point and asks only for the other points', async () => {
      const { deps } = setup({}, typing([owner]));
      const result = await runInit(deps, options({ approval: [`merge=${delegated}`] }));
      expect(result.ok).toBe(true);
      expect(approvalQuestions(deps)).toHaveLength(1);
      expect(approvalQuestions(deps)[0]).toContain('release');
      expect(await modesIn(deps)).toEqual({ merge: delegated, release: owner });
      expect(recordsIn(deps)).toEqual([delegation('merge', delegated), delegation('release', owner)]);
    });

    it('asks nothing when the flags name every point', async () => {
      const { deps } = setup({}, typing([]));
      const result = await runInit(deps, options({ approval: [`release=${delegated}`, `merge=${owner}`] }));
      expect(result.ok).toBe(true);
      expect(approvalQuestions(deps)).toEqual([]);
      expect(await modesIn(deps)).toEqual({ merge: owner, release: delegated });
    });

    it('asks after the checks of the home, so a refused home gets no question', async () => {
      const { deps } = setup({}, typing([owner, owner]));
      deps.seed(`${HOME}/factory.yaml`, 'schema: 1\n');
      deps.seed(`${HOME}/factory.local.yaml`, 'schema: 1\n');
      const result = await runInit(deps, options());
      expect(result.ok).toBe(false);
      expect(deps.prompts).toEqual([]);
    });

    it('asks before the first clone', async () => {
      const { deps, log } = setup({}, { ...terminal, prompt: () => failure('no answer was given') });
      const result = await runInit(deps, options({ projects: ['https://host/acme/api.git'] }));
      expect(result.ok).toBe(false);
      expect(log.clones()).toEqual([]);
    });

    it('names the effective mode of each point in the output', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(deps, options());
      expect(result.ok && result.value.json['approval']).toEqual({ merge: delegated, release: owner });
      expect(result.ok && result.value.lines.map((line) => line.text)).toContain(
        `Approval points: merge ${delegated}, release ${owner}.`,
      );
    });

    it('says that the text of the coordinator follows the delegation after an upgrade', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(deps, options());
      const lines = result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';
      expect(lines).toContain('factory upgrade');
      const none = setup({}, typing([owner, owner]));
      const second = await runInit(none.deps, options());
      expect(second.ok && second.value.lines.map((line) => line.text).join('\n')).not.toContain('factory upgrade');
    });
  });

  describe('no terminal window, or the yes flag (TP-37)', () => {
    it('writes owner for each point with the yes flag and no terminal window, asks nothing, and writes no record', async () => {
      const { deps } = setup();
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(await modesIn(deps)).toEqual({ merge: owner, release: owner });
      expect(deps.prompts).toEqual([]);
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('writes owner for each point with the yes flag on a terminal, asks nothing, and writes no record', async () => {
      const { deps } = setup({}, { ...terminal, prompt: () => ok(delegated) });
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(await modesIn(deps)).toEqual({ merge: owner, release: owner });
      expect(deps.prompts).toEqual([]);
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('takes the flag with the value owner with the yes flag, and writes no record', async () => {
      const { deps } = setup();
      expect((await runInit(deps, options({ yes: true, approval: [`merge=${owner}`] }))).ok).toBe(true);
      expect(await modesIn(deps)).toEqual({ merge: owner, release: owner });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('stops with exit 2 before any write when the flag comes from a terminal for the input only, because the hook settings need a full terminal window (TP-16)', async () => {
      const { deps } = setup({}, { stdinIsTTY: true });
      const before = snapshot(deps);
      const result = await runInit(deps, options({ approval: [`merge=${delegated}`] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('--yes');
      expect(snapshot(deps)).toBe(before);
    });
  });

  describe('a delegated choice that the writer would refuse (TP-38)', () => {
    it('exits 4 with no terminal window, names the point and the remedy, and writes no file', async () => {
      const { deps, log } = setup();
      const before = snapshot(deps);
      const result = await runInit(deps, options({ approval: [`release=${delegated}`], projects: ['https://host/acme/api.git'] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('release');
      expect(messageOf(result)).toContain('Run "factory init" in a terminal window outside a factory session.');
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('exits 4 inside a factory session although a terminal window is there, and writes no file', async () => {
      const { deps, log } = setup({}, { ...terminal, env: inSession });
      const before = snapshot(deps);
      const result = await runInit(deps, options({ approval: [`merge=${delegated}`], projects: ['https://host/acme/api.git'] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('factory session');
      expect(log.clones()).toEqual([]);
      expect(deps.prompts).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });

    it('exits 4 before any question when one point asks for delegated and the terminal window is not usable', async () => {
      const { deps } = setup({}, { stdoutIsTTY: true, prompt: () => ok(owner) });
      const result = await runInit(deps, options({ approval: [`release=${delegated}`] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.prompts).toEqual([]);
    });

    it('asks nothing in a factory session, writes owner for each point, and writes no record', async () => {
      const { deps } = setup({}, { ...terminal, env: inSession, prompt: () => ok(delegated) });
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(approvalQuestions(deps)).toEqual([]);
      expect(await modesIn(deps)).toEqual({ merge: owner, release: owner });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('takes the flag with the value owner in a factory session, and writes no record', async () => {
      const { deps } = setup({}, { ...terminal, env: inSession, prompt: answerHome('') });
      expect((await runInit(deps, options({ approval: [`merge=${owner}`] }))).ok).toBe(true);
      expect(deps.files.has(STORE)).toBe(false);
    });
  });

  describe('the yes flag with delegated (TP-81)', () => {
    it.each([
      ['no terminal window', {}],
      ['a terminal window', terminal],
    ])('exits 2 with %s, names the remedy, and writes no file', async (_name, extra) => {
      const { deps, log } = setup({}, extra);
      const before = snapshot(deps);
      const result = await runInit(deps, options({ yes: true, approval: [`merge=${owner}`, `release=${delegated}`], projects: ['https://host/acme/api.git'] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('--yes');
      expect(messageOf(result)).toContain('release');
      expect(messageOf(result)).toContain('Run "factory init --approval <point>=delegated" in a terminal window, with no --yes.');
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('exits 2 and not 4 inside a factory session', async () => {
      const { deps } = setup({}, { ...terminal, env: inSession });
      const result = await runInit(deps, options({ yes: true, approval: [`merge=${delegated}`] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    });
  });

  describe('the flag values', () => {
    it.each([
      ['no sign'],
      ['merge='],
      ['=owner'],
      ['merge=maybe'],
      ['merge=Owner'],
      ['merge=owner=owner'],
      ['deploy=owner'],
      ['Merge=owner'],
      [''],
    ])('exits 2 for "%s" and writes nothing', async (text) => {
      const { deps, log } = setup();
      const before = snapshot(deps);
      const result = await runInit(deps, options({ approval: [text], projects: ['https://host/acme/api.git'] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(messageOf(result)).toContain('--approval');
      expect(log.clones()).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });

    it('names the points of the recipe for a point that it does not list', async () => {
      const { deps } = setup();
      const result = await runInit(deps, options({ approval: [`deploy=${owner}`] }));
      expect(messageOf(result)).toContain('The points are: merge, release');
    });

    it('names the modes for a mode that is not one', async () => {
      const { deps } = setup();
      const result = await runInit(deps, options({ approval: ['merge=maybe'] }));
      expect(messageOf(result)).toContain(`${owner}, ${delegated}`);
    });

    it('repeats no control character of the value', async () => {
      const { deps } = setup();
      const result = await runInit(deps, options({ approval: ['merge=\u001b[2J'] }));
      expect(messageOf(result)).not.toContain('\u001b');
    });

    it('exits 2 for a point that two flags name, also with the same mode', async () => {
      for (const approval of [[`merge=${owner}`, `merge=${delegated}`], [`merge=${owner}`, `merge=${owner}`]]) {
        const { deps } = setup();
        const before = snapshot(deps);
        const result = await runInit(deps, options({ approval }));
        expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
        expect(messageOf(result)).toContain('merge');
        expect(snapshot(deps)).toBe(before);
      }
    });
  });

  describe('when the records are written (TP-91)', () => {
    const listFails = (deps: Deps): Deps => failingWrite(deps, '/homes.json');

    it('writes the records after the factory list, and no record before it', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      expect((await runInit(deps, options())).ok).toBe(true);
      const order = deps.atomicWrites.filter((path) => path === INDEX || path === STORE);
      expect(order).toEqual([INDEX, STORE, STORE]);
    });

    it('writes no record and no setup acceptance when the factory list can not be written', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(listFails(deps), options());
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(deps.files.has(STORE)).toBe(false);
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
      expect(deps.atomicWrites.filter((path) => path === STORE)).toEqual([]);
    });

    it('writes no record when the flag names the points and the factory list can not be written', async () => {
      const { deps } = setup({}, { ...terminal });
      const flags = [`merge=${delegated}`, `release=${owner}`];
      const result = await runInit(listFails(deps), options({ approval: flags }));
      expect(result.ok).toBe(false);
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('lets a second init in the same folder succeed, and then writes the records', async () => {
      const { deps } = setup({}, typing([delegated, owner, delegated, owner]));
      expect((await runInit(listFails(deps), options())).ok).toBe(false);
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(recordsIn(deps)).toEqual([delegation('merge', delegated), delegation('release', owner)]);
    });
  });

  describe('when a record can not be written after the factory list (TP-91)', () => {
    const storeFails = (deps: Deps): Deps => failingWrite(deps, '/owner-records.json');

    it('still succeeds, warns and names the point, and keeps the node', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(storeFails(deps), options());
      expect(result.ok).toBe(true);
      const warnings = result.ok ? result.value.warnings : [];
      const merge = warnings.filter((warning) => warning.includes('merge'));
      expect(merge).toHaveLength(1);
      expect(merge[0]).toContain(`counts as ${owner}`);
      expect(merge[0]).toContain('Run "factory init" in a terminal window outside a factory session');
      expect(warnings.filter((warning) => warning.includes('release'))).toHaveLength(1);
      expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
      expect(deps.files.has(INDEX)).toBe(true);
    });

    it('counts the point as owner: the local file keeps the choice and the effective mode is owner', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(storeFails(deps), options());
      expect(result.ok && result.value.json['approval']).toEqual({ merge: owner, release: owner });
      expect(await modesIn(deps)).toEqual({ merge: delegated, release: owner });
      const config = await loadConfig(deps, HOME);
      expect(config.ok && (await effectiveModes(deps, HOME, config.value))).toEqual({ merge: owner, release: owner });
      expect(deps.files.has(STORE)).toBe(false);
    });

    it('does not say that the text follows a delegation that was not recorded', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      const result = await runInit(storeFails(deps), options());
      expect(result.ok && result.value.lines.map((line) => line.text).join('\n')).not.toContain('factory upgrade');
    });
  });

  describe('the text of the coordinator', () => {
    it('names the owner for each point at the end of init, also for a recorded delegation', async () => {
      const { deps } = setup({}, typing([delegated, delegated]));
      expect((await runInit(deps, options())).ok).toBe(true);
      const claude = deps.files.get(`${HOME}/coordinator/CLAUDE.md`) ?? '';
      expect(claude).toContain('A merge waits for the go of the owner.');
      expect(claude).toContain('A release waits for the go of the owner.');
    });

    it('is rendered again by upgrade for a recorded delegation, as the line of init says', async () => {
      const { deps } = setup({}, typing([delegated, owner]));
      expect((await runInit(deps, options())).ok).toBe(true);
      const upgraded = await runUpgrade(deps, { home: HOME, dryRun: true, overwrite: [], yes: false });
      const lines = upgraded.ok ? upgraded.value.lines.map((line) => line.text).join('\n') : '';
      expect(lines).toContain('block safety: render the text again');
    });

    it('is current for upgrade when every point is owner', async () => {
      const { deps } = setup({}, typing([owner, owner]));
      expect((await runInit(deps, options())).ok).toBe(true);
      const upgraded = await runUpgrade(deps, { home: HOME, dryRun: true, overwrite: [], yes: false });
      const lines = upgraded.ok ? upgraded.value.lines.map((line) => line.text).join('\n') : '';
      expect(lines).toContain('block safety: version 2 is current');
    });
  });
});

describe('init: the first acceptance of the setup text on a new root', () => {
  const ACCEPTANCES = '/state/factory/setup-acceptances.json';
  const [COORDINATOR, WORKER] = setupAcceptance.setupTextFiles;
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const inSession = { ...ENV, [env.session]: 'demo' };
  /** A person who takes the default for each question, and a script that is never asked. */
  const person = (extra: FakeOptions = {}): FakeOptions => ({ ...extra, prompt: () => ok('') });

  interface Stored {
    readonly root: string;
    readonly node: string;
    readonly file: string;
    readonly hash: string;
    readonly reason: string;
    readonly manifest: readonly { readonly path: string }[];
  }

  const acceptancesOf = (deps: FakeDeps): Stored[] =>
    (JSON.parse(deps.files.get(ACCEPTANCES) ?? '{"acceptances":[]}') as { acceptances: Stored[] }).acceptances;

  const entryOf = (path: string, text: string): ManifestEntry => ({
    path,
    type: 'file',
    size: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    blob: null,
  });

  /** The hash of the two setup files as they are on disk after the run. */
  const diskHash = (deps: FakeDeps): string =>
    manifestHash([COORDINATOR, WORKER].map((path) => entryOf(path, deps.files.get(`${HOME}/${path}`) ?? '')));

  const linesOf = (result: Awaited<ReturnType<typeof runInit>>): string =>
    result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';

  const warningsOf = (result: Awaited<ReturnType<typeof runInit>>): string[] => (result.ok ? [...result.value.warnings] : []);

  it.each([
    ['no terminal window', {}, {}],
    ['no terminal window and the yes flag', {}, { yes: true }],
    ['a terminal window', terminal, {}],
    ['a terminal window and the yes flag', terminal, { yes: true }],
  ])('accepts the hash of the setup text that it wrote, with %s', async (_name, window, flagValues) => {
    const { deps } = setup({}, person(window));
    const result = await runInit(deps, options(flagValues));
    expect(result.ok).toBe(true);
    expect(acceptancesOf(deps)).toEqual([
      expect.objectContaining({ root: HOME, node: 'node', file: COORDINATOR, hash: diskHash(deps) }),
    ]);
    expect(acceptancesOf(deps)[0]?.manifest.map((entry) => entry.path)).toEqual([COORDINATOR, WORKER]);
    expect(result.ok && result.value.json['accepted']).toBe(true);
  });

  it('hashes the bytes that it wrote: the files on disk give the hash of the acceptance, and a second run has nothing to accept', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const set = await collectSetup(deps, HOME, [COORDINATOR, WORKER], commands.init);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.collected.manifest.hash).toBe(acceptancesOf(deps)[0]?.hash);
    expect(await acceptanceState(deps, { root: HOME, node: 'node', hash: set.value.collected.manifest.hash })).toMatchObject({
      ok: true,
      value: { state: 'accepted' },
    });
    // With no terminal window and no yes flag, a set without an acceptance would stop here with exit 4.
    expect(await decideAcceptance(deps, { home: HOME, node: 'node', yes: false, setup: set.value })).toMatchObject({
      ok: true,
      value: { kind: 'already' },
    });
  });

  it('prints the files, the hash, the folder, the node id and the reason', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    const lines = linesOf(result);
    expect(lines).toContain(`${COORDINATOR}, ${WORKER}`);
    expect(lines).toContain(diskHash(deps));
    expect(lines).toContain(`${HOME}`);
    expect(lines).toContain('node id: node');
    expect(lines).toContain(acceptancesOf(deps)[0]?.reason ?? 'missing');
  });

  it('writes the acceptance after the entry in the factory list', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.atomicWrites.filter((path) => path === INDEX || path === ACCEPTANCES)).toEqual([INDEX, ACCEPTANCES]);
  });

  it.each([{}, { yes: true }])('writes no acceptance when the factory list can not be written (%j)', async (flagValues) => {
    const { deps } = setup();
    const result = await runInit(failingWrite(deps, '/homes.json'), options(flagValues));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
    expect(deps.atomicWrites.filter((path) => path === ACCEPTANCES)).toEqual([]);
  });

  it('still succeeds, warns and names the command in a terminal window when the acceptance can not be written', async () => {
    const { deps } = setup();
    const result = await runInit(failingWrite(deps, '/setup-acceptances.json'), options());
    expect(result.ok).toBe(true);
    const warnings = warningsOf(result).filter((warning) => warning.includes('setup acceptance'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Run "factory init" in a terminal window');
    expect(result.ok && result.value.json['accepted']).toBe(false);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
    expect(deps.files.has(INDEX)).toBe(true);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
  });

  it.each([
    ['no terminal window', {}],
    ['a terminal window', terminal],
  ])('counts the acceptance as saved when only its lock file stays, with %s: accepted, a warning that names the lock file, and no advice to run init', async (_name, window) => {
    const { deps } = setup({}, person(window));
    const result = await runInit(withFailingRemoves(deps, (path) => path === `${ACCEPTANCES}.lock`), options());
    expect(result.ok).toBe(true);
    expect(acceptancesOf(deps)).toHaveLength(1);
    expect(result.ok && result.value.json['accepted']).toBe(true);
    expect(warningsOf(result).join('\n')).toContain(`${ACCEPTANCES}.lock`);
    expect(warningsOf(result).join('\n')).not.toContain('was not written');
    expect(warningsOf(result).join('\n')).not.toContain('Run "factory init" in a terminal window');
    expect(linesOf(result)).toContain('Accepted the setup text');
  });

  it('writes no acceptance in a factory session on a new root, still succeeds, and warns (TP-83)', async () => {
    const { deps } = setup({}, person({ ...terminal, env: inSession }));
    const result = await runInit(deps, options({ yes: false }));
    expect(result.ok).toBe(true);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
    expect(warningsOf(result).join('\n')).toContain('factory session');
    expect(result.ok && result.value.json['accepted']).toBe(false);
  });

  it.each([
    ['the coordinator text', { [COORDINATOR]: 'My own rules.\n' }],
    ['the worker text', { [WORKER]: 'My own worker rules.\n' }],
    ['both texts', { [COORDINATOR]: 'My own rules.\n', [WORKER]: 'My own worker rules.\n' }],
  ])('does not accept a setup file that was there before the run (%s): no acceptance, a warning that names the command (TP-157)', async (_name, before) => {
    const { deps } = setup();
    for (const [path, text] of Object.entries(before)) deps.seed(`${HOME}/${path}`, text);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
    const warning = warningsOf(result).find((text) => text.includes('did not write'));
    expect(warning).toContain(Object.keys(before).join(', '));
    expect(warning).toContain('Run "factory init" in a terminal window');
    expect(result.ok && result.value.json['accepted']).toBe(false);
  });

  it('accepts the one text that it wrote when the other file holds only white space', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/${COORDINATOR}`, '  \n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(acceptancesOf(deps)).toEqual([expect.objectContaining({ hash: expect.any(String) })]);
    expect(acceptancesOf(deps)[0]?.manifest.map((entry) => entry.path)).toEqual([WORKER]);
    const set = await collectSetup(deps, HOME, [COORDINATOR, WORKER], commands.init);
    expect(set.ok && set.value.collected.manifest.hash).toBe(acceptancesOf(deps)[0]?.hash);
  });

  it('makes no second first acceptance: an acceptance of the folder under another node id stays, and the run warns', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ name: 'first' }))).ok).toBe(true);
    const before = deps.files.get(ACCEPTANCES);
    const other = setup();
    other.deps.seed(ACCEPTANCES, before ?? '');
    const result = await runInit(other.deps, options({ name: 'second' }));
    expect(result.ok).toBe(true);
    expect(other.deps.files.get(ACCEPTANCES)).toBe(before);
    expect(warningsOf(result).join('\n')).toContain('Run "factory init" in a terminal window');
  });
});

describe('init: instruction files at the root and above it (TP-33)', () => {
  const ABOVE = '/w/CLAUDE.md';
  const WRITES = new Set(['mkdir', 'writeText', 'writeTextExclusive', 'writeTextAtomic', 'rename', 'remove', 'chmod', 'copyTree']);
  const GIT_ACTIONS = new Set(['init', 'clone', 'add', 'commit']);

  /** The warnings about instruction files: the notice of the hook change that the yes flag prints is no part of them. */
  const fileWarnings = (deps: FakeDeps): string[] => deps.warned.filter((text) => !text.startsWith(HOOK_QUESTION));

  /** The deps that note how many warnings were printed when the command first changed a file or ran a git action. */
  const noteWarningsAtFirstAction = (deps: FakeDeps): { readonly watched: FakeDeps; readonly seen: number[] } => {
    const seen: number[] = [];
    const note = (): void => {
      if (seen.length === 0) seen.push(deps.warned.length);
    };
    const running: FakeDeps = {
      ...deps,
      run: async (command, args, runOptions) => {
        if (command === 'git' && GIT_ACTIONS.has(args[0] ?? '')) note();
        return deps.run(command, args, runOptions);
      },
    };
    return {
      watched: withFsWatch(running, (method) => {
        if (WRITES.has(method)) note();
      }),
      seen,
    };
  };

  it('prints the warning before the first change, and makes the factory', async () => {
    const { deps } = setup();
    deps.seed(ABOVE, '');
    const { watched, seen } = noteWarningsAtFirstAction(deps);
    const result = await runInit(watched, options());
    expect(result.ok).toBe(true);
    expect(seen).toEqual([1]);
    expect(fileWarnings(deps)).toEqual(instructionFileWarnings(await scanInstructionFiles(deps, HOME)));
    expect(deps.warned[0]).toContain(ABOVE);
    if (result.ok) expect(result.value.warnings.join(' ')).not.toContain(ABOVE);
  });

  it('prints it before the question about an approval point', async () => {
    const { deps } = setup({}, { stdinIsTTY: true, stdoutIsTTY: true, prompt: () => ok('') });
    deps.seed(ABOVE, '');
    const asked: number[] = [];
    const asking: FakeDeps = {
      ...deps,
      prompt: async (question) => {
        asked.push(deps.warned.length);
        return deps.prompt(question);
      },
    };
    await runInit(asking, options({ yes: false }));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((count) => count === 1)).toBe(true);
  });

  it('prints nothing when no listed file is at the root or above it', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(fileWarnings(deps)).toEqual([]);
  });

  it('prints it also for a file in the folder of the new root, and for a root that is there already', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/AGENTS.md`, '');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(fileWarnings(deps)).toHaveLength(1);
    expect(fileWarnings(deps)[0]).toContain(`${HOME}/AGENTS.md`);
    const again = await runInit(deps, options({ ownerName: undefined }));
    expect(again.ok ? 'ok' : again.error.message).toBe('ok');
    expect(fileWarnings(deps)).toHaveLength(2);
    expect(fileWarnings(deps)[1]).toBe(fileWarnings(deps)[0]);
  });

  it('makes the factory when a folder above the root can not be read, and warns', async () => {
    const { deps } = setup();
    const unreadable: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        lstat: async (path) => (dirname(path) === '/w' && path !== HOME ? failure(`cannot stat ${path}: EACCES`) : deps.fs.lstat(path)),
      },
    };
    expect((await runInit(unreadable, options())).ok).toBe(true);
    expect(deps.warned.join(' ')).toContain('EACCES');
  });
});

describe('init: the hook settings of the coordinator on a new root (TP-16)', () => {
  const FILE = `${HOME}/coordinator/.claude/settings.local.json`;
  const ACCEPTANCES = '/state/factory/setup-acceptances.json';
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const events = hookNames.events;

  /** A person who gives `hook` as the answer to the question about the hook settings, and takes the default for every other question. */
  const answering = (hook: string) => (question: string) => ok(question.startsWith(HOOK_QUESTION) ? hook : '');

  const settingsOf = (deps: FakeDeps): Record<string, unknown> => JSON.parse(deps.files.get(FILE) ?? 'null') as Record<string, unknown>;

  it('writes the own entries with the yes flag, prints the change and the target first, and asks nothing', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(settingsOf(deps)).toEqual(ownSettingsEntries);
    expect(deps.prompts).toEqual([]);
    const shown = deps.warned.filter((text) => text.startsWith(HOOK_QUESTION));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(FILE);
    for (const event of events) expect(shown[0]).toContain(`factory hook ${event}`);
    expect(result.ok && result.value.json['files']).toContain('coordinator/.claude/settings.local.json');
  });

  it('asks on a terminal window after the setup acceptance and the entry in the factory list, and writes after a yes', async () => {
    const seen: { question: string; accepted: boolean; listed: boolean; written: boolean }[] = [];
    const { deps } = setup({}, terminal);
    const asking: FakeDeps = {
      ...deps,
      prompt: async (question) => {
        seen.push({ question, accepted: deps.files.has(ACCEPTANCES), listed: deps.files.has(INDEX), written: deps.files.has(FILE) });
        return answering('y')(question);
      },
    };
    const result = await runInit(asking, options({ yes: false }));
    expect(result.ok).toBe(true);
    const hook = seen.filter((entry) => entry.question.startsWith(HOOK_QUESTION));
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ accepted: true, listed: true, written: false });
    expect(hook[0]?.question).toContain(FILE);
    expect(hook[0]?.question).toContain('[y/N]');
    expect(seen.at(-1)?.question).toBe(hook[0]?.question);
    expect(settingsOf(deps)).toEqual(ownSettingsEntries);
    expect(result.ok && result.value.json['files']).toContain('coordinator/.claude/settings.local.json');
  });

  it('goes on after a no: the node stays, the file is not written, and the notice names the effect and the command', async () => {
    const { deps } = setup({}, { ...terminal, prompt: answering('n') });
    const result = await runInit(deps, options({ yes: false }));
    expect(result.ok).toBe(true);
    expect(deps.files.has(FILE)).toBe(false);
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
    expect(deps.files.has(INDEX)).toBe(true);
    const warnings = result.ok ? result.value.warnings : [];
    expect(warnings).toContain(declinedHookText(FILE, commands.init));
    expect(declinedHookText(FILE, commands.init)).toContain('run "factory init" again and answer yes');
    expect(result.ok && result.value.json['files']).not.toContain('coordinator/.claude/settings.local.json');
  });

  it('stops with exit 2 before any write with no terminal window and no yes flag, and shows the change, the target and the remedy', async () => {
    const { deps, log } = setup();
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: false, projects: ['https://host/acme/api.git'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain(FILE);
    for (const event of events) expect(messageOf(result)).toContain(`factory hook ${event}`);
    expect(messageOf(result)).toContain('Run "factory init" in a terminal window, or add --yes.');
    expect(log.clones()).toEqual([]);
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 2 before any write with a terminal for the output only', async () => {
    const { deps } = setup({}, { stdoutIsTTY: true });
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: false }))).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 2 before any write inside a factory session although the yes flag is there, because the flag gives no consent there', async () => {
    const { deps } = setup({}, { env: { ...ENV, [env.session]: 'demo' } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--yes gives no consent inside a factory session');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 2 before any write on a terminal window inside a factory session with the yes flag, and asks nothing', async () => {
    const { deps } = setup({}, { ...terminal, env: { ...ENV, [env.session]: 'demo' }, prompt: answering('y') });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--yes gives no consent inside a factory session');
    expect(deps.prompts.filter((question) => question.startsWith(HOOK_QUESTION))).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('keeps the other keys of a settings file that is there already', async () => {
    const { deps } = setup();
    deps.seed(FILE, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }));
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    const settings = settingsOf(deps);
    expect(settings['model']).toBe('opus');
    expect((settings['hooks'] as Record<string, unknown[]>)['Stop']).toHaveLength(2);
    expect(settings['statusLine']).toEqual(ownSettingsEntries.statusLine);
  });

  it('stops with exit 1 before any write for a settings file that is not a JSON object, and keeps its bytes', async () => {
    const { deps } = setup();
    deps.seed(FILE, '[]');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 before any write when the .claude folder of the coordinator is a link', async () => {
    const { deps } = setup({}, { links: { [`${HOME}/coordinator/.claude`]: '/elsewhere' } });
    deps.seedDir(`${HOME}/coordinator`);
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  describe('a failure of the hook step after the last write: the node stays made and listed', () => {
    /** The command line of a person on a terminal window: the questions get their defaults, and the hook question gets a yes. */
    const runOnTerminal = async (deps: FakeDeps) => {
      const sink = captureSink();
      const code = await runCli(['init', '--home', HOME, '--owner-name', 'Test Owner'], deps, sink);
      return { code, shown: sink.errors.join('') };
    };

    const expectNodeKept = (deps: FakeDeps): void => {
      expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
      expect(deps.files.has(`${HOME}/.factory/node.json`)).toBe(true);
      expect((JSON.parse(deps.files.get(INDEX) ?? '{}') as { homes: unknown[] }).homes).toEqual([expect.objectContaining({ home: HOME })]);
    };

    it('exits 1 and names the cause when the question gets no answer, and writes no settings file', async () => {
      const { deps } = setup({}, { ...terminal, prompt: answering('y') });
      const asked: string[] = [];
      const silent: FakeDeps = {
        ...deps,
        prompt: async (question) => {
          if (!question.startsWith(HOOK_QUESTION)) return deps.prompt(question);
          asked.push(question);
          return failure('no answer was given');
        },
      };
      const { code, shown } = await runOnTerminal(silent);
      expect(code).toBe(1);
      expect(shown).toContain('error: no answer was given');
      expect(asked).toHaveLength(1);
      expectNodeKept(deps);
      expect(deps.files.has(FILE)).toBe(false);
    });

    it('exits 1 and names the file and the cause when the write of the settings file fails, and writes no settings file', async () => {
      const { deps } = setup({}, { ...terminal, prompt: answering('y') });
      const full: FakeDeps = {
        ...deps,
        fs: {
          ...deps.fs,
          writeTextExclusive: async (path, text, mode) =>
            path.includes('settings.local.json') ? failure(`cannot write ${path}: disk full`) : deps.fs.writeTextExclusive(path, text, mode),
        },
      };
      const { code, shown } = await runOnTerminal(full);
      expect(code).toBe(1);
      expect(shown).toContain('error: cannot write');
      expect(shown).toContain('settings.local.json');
      expect(shown).toContain('disk full');
      expectNodeKept(deps);
      expect(deps.files.has(FILE)).toBe(false);
      expect([...deps.files.keys()].filter((path) => path.includes('settings.local.json'))).toEqual([]);
    });

    it('exits 1 with the remedy line when the file changes while the question waits, and keeps the file as the other program left it', async () => {
      const { deps } = setup({}, { ...terminal, prompt: answering('y') });
      const saved = JSON.stringify({ model: 'opus', ...ownSettingsEntries });
      const changing: FakeDeps = {
        ...deps,
        prompt: async (question) => {
          if (question.startsWith(HOOK_QUESTION)) deps.seed(FILE, saved);
          return deps.prompt(question);
        },
      };
      const { code, shown } = await runOnTerminal(changing);
      expect(code).toBe(1);
      expect(shown).toContain(`error: cannot write ${FILE}: it changed while the question waited`);
      expect(shown).toContain('Then run "factory init" again.');
      expectNodeKept(deps);
      expect(deps.files.get(FILE)).toBe(saved);
    });
  });
});
