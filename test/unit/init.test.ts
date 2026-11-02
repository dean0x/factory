import { describe, expect, it } from 'vitest';
import { parseBlocks, verifyBlock } from '../../src/blocks/managed.js';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { applyInit, planInit, runInit, type InitOptions } from '../../src/commands/init.js';
import { checkHomeHoldsNoRepo } from '../../src/commands/init-home.js';
import { loadConfig } from '../../src/config/load.js';
import type { Deps } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { loadState } from '../../src/state/load.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { layer2Blocks } from '../helpers/blocks.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps, exited, withFailingWrites, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { captureSink } from '../helpers/sink.js';

const HOME = '/w/node';

const options = (extra: Partial<InitOptions> = {}): InitOptions => ({
  home: HOME,
  name: undefined,
  ownerName: 'Test Owner',
  ownerGithub: undefined,
  projects: [],
  yes: false,
  recipe: undefined,
  layer: undefined,
  ...extra,
});

const setup = (fixture: GitFixture = {}, extra: FakeOptions = {}) => {
  const { handler, log } = gitHandler(fixture);
  const deps = createFakeDeps({ cwd: '/w', run: handler, ...extra });
  return { deps, log };
};

const snapshot = (deps: FakeDeps): string =>
  JSON.stringify([[...deps.files.entries()].sort(), [...deps.dirs].sort()]);

const failingWrite = (deps: Deps, suffix: string): Deps => withFailingWrites(deps, (path) => path.endsWith(suffix));

const messageOf = (result: { ok: boolean; error?: { message: string; hint?: string } }): string =>
  `${result.error?.message ?? ''} ${result.error?.hint ?? ''}`;

describe('init: the files', () => {
  it('writes every file of the plan layout and leaves no staging folder', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);

    const expected = [
      'factory.yaml',
      'CLAUDE.md',
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
    expect([...deps.files.keys()].sort()).toEqual(expected.map((name) => `${HOME}/${name}`).sort());
    expect([...deps.dirs].some((dir) => dir.includes('.tmp-'))).toBe(false);
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
    expect(config.value.core.schema).toBe(2);
    expect(config.value.core.node.layer).toBe(1);
    expect(config.value.core.tracker).toEqual({ kind: 'local' });
    expect(config.value.core.approval).toEqual({ land: 'each' });
    expect(config.value.core.parent).toBeNull();
    expect(config.value.core.children).toEqual([]);
    expect(config.value.core.cells).toEqual({});
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
        blocks: { coordinator: 2, safety: 2, worker: 1 },
      },
    });
  });

  it('writes the managed blocks: coordinator and safety in CLAUDE.md, worker in roles/worker.md', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const claude = parseBlocks(deps.files.get(`${HOME}/CLAUDE.md`) ?? '');
    const worker = parseBlocks(deps.files.get(`${HOME}/.factory/roles/worker.md`) ?? '');
    expect(claude.ok && claude.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['coordinator', 'intact'],
      ['safety', 'intact'],
    ]);
    expect(worker.ok && worker.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['worker', 'intact'],
    ]);
  });

  it('writes the initial board, waiting and decision-log files', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const read = (name: string): unknown => JSON.parse(deps.files.get(`${HOME}/.factory/${name}`) ?? 'null');
    expect(read('board.json')).toEqual({ merge: [], items: [] });
    expect(read('waiting.json')).toEqual({ intro: '', groups: [], items: [] });
    expect(read('decision-log.json')).toEqual({ rows: [] });
    expect(deps.files.get(`${HOME}/.factory/.gitignore`)).toBe('state/\nlocks/\nbackups/\n');
    expect(deps.files.get(`${HOME}/.factory/orders/.gitkeep`)).toBe('');
  });

  it('holds none of the denied words in any generated file', async () => {
    const { deps } = setup({ gh: 'some-login' });
    await runInit(deps, options({ name: 'demo' }));
    for (const [path, text] of deps.files) {
      expect({ path, found: denyMatches(text) }).toEqual({ path, found: [] });
    }
  });

  it('keeps the text of an existing CLAUDE.md and adds the blocks at the end', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, '# My rules\n\nBe kind.\n');
    await runInit(deps, options());
    const text = deps.files.get(`${HOME}/CLAUDE.md`) ?? '';
    expect(text.startsWith('# My rules\n\nBe kind.\n\n')).toBe(true);
    const parsed = parseBlocks(text);
    expect(parsed.ok && parsed.value.map((block) => block.name)).toEqual(['coordinator', 'safety']);
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
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('already exists');
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses a second init in the same home', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const second = await runInit(deps, options());
    expect(second.ok).toBe(false);
    expect(messageOf(second)).toContain('factory.yaml already exists');
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
    second.deps.seed(`${HOME}/CLAUDE.md`, deps.files.get(`${HOME}/CLAUDE.md`) ?? '');
    const before = snapshot(second.deps);
    const result = await runInit(second.deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('already holds the block coordinator');
    expect(snapshot(second.deps)).toBe(before);
  });

  it('refuses a CLAUDE.md with a broken block marker', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n');
    const result = await runInit(deps, options());
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('CLAUDE.md: line 1');
  });
});

describe('init: the refusals of the home rules', () => {
  const refused = (result: { ok: boolean; error?: { kind: string } }): string | undefined => result.error?.kind;

  it('refuses a home inside another node home, names the rule and the path, and changes nothing', async () => {
    const { deps } = setup();
    deps.seed('/w/factory.yaml', 'schema: 1\n');
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(refused(result)).toBe('safety');
    expect(messageOf(result)).toContain(`${HOME} is inside another node home: /w/factory.yaml exists`);
    expect(snapshot(deps)).toBe(before);
  });

  it('finds the other node home several levels up', async () => {
    const { deps } = setup();
    deps.seed('/factory.yaml', 'schema: 1\n');
    const result = await planInit(deps, options({ home: '/w/a/b/c' }));
    expect(refused(result)).toBe('safety');
    expect(messageOf(result)).toContain('/factory.yaml exists');
  });

  it('refuses a home inside a git work tree, from the nearest folder that exists', async () => {
    const { deps } = setup({ repos: { '/w/web': {} } });
    deps.seedDir('/w/web/src');
    const before = snapshot(deps);
    for (const home of ['/w/web', '/w/web/src', '/w/web/src/deep/node']) {
      const result = await runInit(deps, options({ home }));
      expect(refused(result)).toBe('safety');
      expect(messageOf(result)).toContain(`${home} is inside the git work tree /w/web`);
      expect(messageOf(result)).toContain('outside every git work tree');
    }
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses a home that holds a project, and names the project', async () => {
    const { deps } = setup({ repos: { '/w/node/app': {} } });
    deps.seedDir('/w/node/app');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['/w/node/app'] }));
    expect(refused(result)).toBe('safety');
    expect(messageOf(result)).toContain(`${HOME} is the project folder /w/node/app, or holds it`);
    expect(snapshot(deps)).toBe(before);
  });

  it('compares real paths: a home that is a link to the parent of a project is refused', async () => {
    const { deps } = setup({ repos: { '/w/real/app': {} } }, { links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/real/app');
    deps.seedDir('/w/via');
    const result = await runInit(deps, options({ home: '/w/via', projects: ['/w/real/app'] }));
    expect(refused(result)).toBe('safety');
    expect(messageOf(result)).toContain('/w/via is the project folder /w/real/app, or holds it');
  });

  it('accepts a home beside its projects and outside every node home', async () => {
    const { deps } = setup({ repos: { '/w/web': {} } });
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result.ok).toBe(true);
  });

  it('still refuses with exit 1 when the home has a config file already', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    const result = await runInit(deps, options());
    expect(refused(result)).toBe('failure');
    expect(messageOf(result)).toContain('already exists');
  });
});

describe('init: the proposed home in a git work tree', () => {
  const REPO = '/w/web';
  const PROPOSAL = '/w/web-factory';
  const repos = { [REPO]: { origin: 'git@github.com:acme/web.git' } };

  /** The command runs in a folder below the top of the work tree. */
  const inRepo = (extra: FakeOptions = {}, fixture: GitFixture = { repos }) => {
    const { handler } = gitHandler(fixture);
    const deps = createFakeDeps({ cwd: `${REPO}/src`, run: handler, ...extra });
    deps.seedDir(`${REPO}/src`);
    return deps;
  };

  const withHome = (extra: Partial<InitOptions> = {}): InitOptions => options({ home: undefined, ...extra });
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
  const answers = (answer: string): FakeOptions => ({ ...terminal, prompt: () => ok(answer) });
  const projectsOf = async (deps: FakeDeps) => {
    const config = await loadConfig(deps, PROPOSAL);
    return config.ok ? config.value.recipe.projects.map((project) => [project.id, project.path]) : null;
  };

  it('uses the folder beside the work tree for --yes, with the work tree as the first project', async () => {
    const deps = inRepo();
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result.ok && result.value.json['home']).toBe(PROPOSAL);
    expect(result.ok && result.value.json['nodeId']).toBe('web-factory');
    expect(await projectsOf(deps)).toEqual([['web', '../web']]);
    expect(deps.prompts).toEqual([]);
    const config = await loadConfig(deps, PROPOSAL);
    expect(config.ok && config.value.recipe.projects[0]?.repo).toBe('acme/web');
  });

  it('puts the work tree before every --project, and does not repeat it', async () => {
    const deps = inRepo({}, { repos: { ...repos, '/w/api': {} } });
    const result = await runInit(deps, withHome({ yes: true, projects: ['/w/api', '..', '/w/web'] }));
    expect(result.ok).toBe(true);
    expect(await projectsOf(deps)).toEqual([
      ['web', '../web'],
      ['api', '../api'],
    ]);
  });

  it('asks on a terminal and goes on for y and for yes in any case', async () => {
    for (const answer of ['y', 'yes', ' Y ', 'YES\n']) {
      const deps = inRepo(answers(answer));
      const result = await runInit(deps, withHome());
      expect({ answer, ok: result.ok }).toEqual({ answer, ok: true });
      expect(deps.prompts).toHaveLength(1);
      expect(deps.prompts[0]).toContain(`The proposed node home is ${PROPOSAL}`);
      expect(deps.prompts[0]).toContain('Create the node home here? [y/N]');
      expect(await projectsOf(deps)).toEqual([['web', '../web']]);
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
    expect(messageOf(result)).toContain(`The proposed node home is ${PROPOSAL}`);
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
    expect(deps.prompts).toEqual([]);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects).toEqual([]);
  });

  it('uses the current folder, and asks nothing, when the folder is in no work tree', async () => {
    const { deps } = setup();
    const result = await runInit(deps, withHome());
    expect(result.ok && result.value.json['home']).toBe('/w');
    expect(deps.prompts).toEqual([]);
  });

  it('refuses the proposal with exit 4 when it is inside another work tree', async () => {
    const deps = inRepo({}, { repos: { [REPO]: {}, '/w': {} } });
    const before = snapshot(deps);
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`${PROPOSAL} is inside the git work tree /w`);
    expect(snapshot(deps)).toBe(before);
  });

  it('fails with exit 1 when the proposed folder holds a node already', async () => {
    const deps = inRepo();
    deps.seed(`${PROPOSAL}/factory.yaml`, 'schema: 2\n');
    const result = await runInit(deps, withHome({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('already exists');
  });
});

describe('init: the layer and the recipe', () => {
  const files = (deps: FakeDeps): string[] => [...deps.files.keys()].map((path) => path.slice(HOME.length + 1)).sort();
  const claudeBlocks = (deps: FakeDeps): string[] => {
    const parsed = parseBlocks(deps.files.get(`${HOME}/CLAUDE.md`) ?? '');
    return parsed.ok ? parsed.value.map((block) => block.name) : [];
  };

  it('makes a node on layer 1 by default, with the coordinator, safety and worker blocks', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options())).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(1);
    expect(config.ok && config.value.recipe.id).toBe('software');
    expect(claudeBlocks(deps)).toEqual(['coordinator', 'safety']);
    expect(files(deps)).toContain('.factory/roles/worker.md');
  });

  it('makes a node on layer 2 with the manager and safety blocks and no worker file', async () => {
    const { deps } = setup();
    expect((await runInit(deps, options({ layer: '2' }))).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(2);
    expect(claudeBlocks(deps)).toEqual(['manager', 'safety']);
    expect(files(deps)).not.toContain('.factory/roles/worker.md');
    expect(files(deps)).toContain('.factory/node.json');
    const state = await loadState(deps, HOME);
    expect(state.ok && state.value.blocks).toEqual({ manager: 1, safety: 2 });
    const statuses = await inspectBlocks(deps, HOME, layer2Blocks);
    expect(statuses.map((status) => status.kind)).toEqual(['intact', 'intact']);
  });

  it('makes a node on layer 3 with the safety block only, no worker file, and a warning that names the layer', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options({ layer: '3' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.core.node.layer).toBe(3);
    expect(claudeBlocks(deps)).toEqual(['safety']);
    expect(files(deps)).not.toContain('.factory/roles/worker.md');
    const state = await loadState(deps, HOME);
    expect(state.ok && state.value.blocks).toEqual({ safety: 2 });
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

  it('describes a project: id, repo, relative path and default branch', async () => {
    const { deps } = setup({ repos });
    await runInit(deps, options({ projects: ['/w/web', 'api'] }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects).toEqual([
      {
        id: 'web',
        repo: 'acme/web',
        path: '../web',
        default_branch: 'trunk',
        merge_method: 'squash',
        gate: { checks: [] },
      },
      {
        id: 'api',
        repo: 'acme/api',
        path: '../api',
        default_branch: 'develop',
        merge_method: 'squash',
        gate: { checks: [] },
      },
    ]);
  });

  it('leaves the repo unset for a remote that is not on GitHub, and falls back to main', async () => {
    const { deps } = setup({ repos });
    await runInit(deps, options({ projects: ['/w/My Tool', '/w/lib'] }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((p) => [p.id, p.repo, p.default_branch])).toEqual([
      ['my-tool', undefined, 'main'],
      ['lib', undefined, 'main'],
    ]);
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

  it('refuses a project that is too far from the home, and names the key', async () => {
    const { deps } = setup({ repos: { '/elsewhere/deep/web': {} } });
    const result = await runInit(deps, options({ projects: ['/elsewhere/deep/web'] }));
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain('projects.0.path');
  });

  it('stores the path of a project relative to the home after the links are resolved', async () => {
    const { deps } = setup({ repos: { '/w/via/proj': {} } }, { links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/via/proj');
    deps.seedDir('/w/real');
    const result = await runInit(deps, options({ home: '/w/real/node', projects: ['/w/via/proj'] }));
    expect(result.ok).toBe(true);
    const config = await loadConfig(deps, '/w/real/node');
    expect(config.ok && config.value.recipe.projects.map((project) => project.path)).toEqual(['../proj']);
  });

  it('refuses two projects with the same id', async () => {
    const { deps } = setup({ repos: { '/w/web': {}, '/w/other/web': {} } });
    const result = await runInit(deps, options({ projects: ['/w/web', '/w/other/web'] }));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('projects.1.id: duplicate id');
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
      'config user.name',
      'config user.email',
      'add -A',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: initialize the state',
    ]);
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

  it('never runs a program through a shell', async () => {
    const { deps, log } = setup({ gh: 'x' });
    await runInit(deps, options());
    expect(new Set(log.calls.map((call) => call.command))).toEqual(new Set(['git', 'gh']));
  });
});

describe('init: rollback', () => {
  it('removes everything and restores CLAUDE.md when the config file cannot be written', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
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

  it('removes CLAUDE.md and the state folder when CLAUDE.md cannot be written', async () => {
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

  it('writes CLAUDE.md and then the config file with the atomic write', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.atomicWrites).toEqual([`${HOME}/CLAUDE.md`, `${HOME}/factory.yaml`]);
  });

  it('puts the old CLAUDE.md back with the atomic write', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await applyInit(failingWrite(deps, '/factory.yaml'), plan.value);
    expect(deps.atomicWrites).toEqual([`${HOME}/CLAUDE.md`, `${HOME}/CLAUDE.md`]);
    expect(deps.files.get(`${HOME}/CLAUDE.md`)).toBe('Owner text.\n');
  });

  it('names the file that it cannot put back, and does not say that nothing was changed', async () => {
    const { deps } = setup();
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
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
    expect(message).toContain(`cannot write ${HOME}/CLAUDE.md`);
    expect(deps.files.get(`${HOME}/CLAUDE.md`)).not.toBe('Owner text.\n');
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
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
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
    expect(deps.atomicWrites).toEqual([]);
  });

  it('leaves the folder as it was and says so when the first commit fails', async () => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({ cwd: '/w', run: (call) => (call.args.includes('commit') ? exited(1) : handler(call)) });
    deps.seed(`${HOME}/CLAUDE.md`, 'Owner text.\n');
    const before = snapshot(deps);
    const plan = await planInit(deps, options());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await applyInit(deps, plan.value);
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('cannot commit the state files');
    expect(messageOf(result)).toContain('nothing was changed');
    expect(snapshot(deps)).toBe(before);
    expect(deps.atomicWrites).toEqual([]);
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
    const deps = createFakeDeps({ cwd: WS, run: handler, ...extra });
    for (const path of Object.keys(fixture.repos ?? {})) deps.seedDir(`${path}/.git`);
    deps.seedDir('/ws/docs');
    return deps;
  };
  const withHome = (extra: Partial<InitOptions> = {}): InitOptions => options({ home: undefined, ...extra });
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
      ['api', '../api'],
      ['web', '../web'],
    ]);
    expect(result.ok && result.value.json['skipped']).toEqual([
      { path: '/ws/web-search', reason: 'it is one more checkout of the repo web' },
    ]);
    const text = result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';
    expect(text).toContain('Skipped /ws/web-search: it is one more checkout of the repo web.');
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
    expect(message).toContain(`The proposed node home is ${PROPOSAL}`);
    expect(message).toContain('/ws/web-search');
    expect(message).toContain('--yes');
    expect(snapshot(deps)).toBe(before);
  });

  it('asks on a terminal, shows the repos and the skipped folder, and goes on for y', async () => {
    const deps = inWorkspace({ ...terminal, prompt: () => ok('y') });
    const result = await runInit(deps, withHome());
    expect(result.ok).toBe(true);
    expect(deps.prompts).toHaveLength(1);
    expect(deps.prompts[0]).toContain('this folder holds the git repos api, web');
    expect(deps.prompts[0]).toContain('/ws/web-search');
    expect(deps.prompts[0]).toContain('Create the node home here? [y/N]');
  });

  it('replaces the control characters of a folder name in the question', async () => {
    const deps = inWorkspace({ ...terminal, prompt: () => ok('y') }, { repos: { '/ws/we\u001b[2Jb': {} } });
    const result = await runInit(deps, withHome());
    expect(result.ok).toBe(true);
    expect(deps.prompts).toHaveLength(1);
    expect(deps.prompts[0]).toContain('this folder holds the git repos we?[2Jb');
    expect(deps.prompts[0]).not.toContain('\u001b');
  });

  it('stops with exit 2 when the person does not accept', async () => {
    const deps = inWorkspace({ ...terminal, prompt: () => ok('n') });
    const before = snapshot(deps);
    expect(await runInit(deps, withHome())).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('never makes the workspace folder the home: --home on that folder exits 4 and names the rule', async () => {
    const deps = inWorkspace();
    const before = snapshot(deps);
    const result = await runInit(deps, withHome({ home: WS, yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('holds the git repo');
    expect(messageOf(result)).toContain('one level down');
    expect(snapshot(deps)).toBe(before);
  });

  it('uses the current folder when it holds no repo', async () => {
    const deps = inWorkspace({}, { repos: {} });
    const result = await runInit(deps, withHome());
    expect(result.ok && result.value.json['home']).toBe(WS);
    expect(deps.prompts).toEqual([]);
  });

  it('does not count the state folder of a node as a repo in the home', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory': {} } });
    expect(await checkHomeHoldsNoRepo(deps, WS)).toEqual({ ok: true, value: undefined });
  });

  it('counts a repo that sits in the home next to the state folder', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory': {}, '/ws/web': {} } });
    expect(await checkHomeHoldsNoRepo(deps, WS)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('names a staging folder that a stopped init left, says it can be removed by hand, and removes nothing', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory.tmp-4242': {} } });
    const before = snapshot(deps);
    const result = await checkHomeHoldsNoRepo(deps, WS);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    const message = messageOf(result);
    expect(message).toContain('/ws/.factory.tmp-4242');
    expect(message).toContain('left by a stopped init');
    expect(message).toContain('You can remove it by hand');
    expect(message).not.toContain('git repo');
    expect(snapshot(deps)).toBe(before);
  });

  it('names a real repo before a staging folder when the home holds both', async () => {
    const deps = inWorkspace({}, { repos: { '/ws/.factory.tmp-1': {}, '/ws/web': {} } });
    const message = messageOf(await checkHomeHoldsNoRepo(deps, WS));
    expect(message).toContain('holds the git repo web one level down');
    expect(message).not.toContain('left by a stopped init');
  });

  it.each([['.factory.tmp-'], ['.factory.tmp-4a'], ['.factory.tmp']])(
    'treats %s as a repo, because it is no staging folder',
    async (name) => {
      const deps = inWorkspace({}, { repos: { [`/ws/${name}`]: {} } });
      expect(messageOf(await checkHomeHoldsNoRepo(deps, WS))).toContain(`holds the git repo ${name} one level down`);
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
      const deps = createFakeDeps({ cwd: WS, run: handler });
      deps.seedDir('/ws/web/.git');
      deps.seedDir('/ws/.factory/.git');

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('.factory already exists in /ws');
    });

    it.each([[false], [true]])(
      'exits 4 for a folder below a node home, names that home and proposes nothing, with --yes %s',
      async (yes) => {
        const deps = inNode('/ws/sub', { ...terminal, prompt: () => ok('y') });
        const before = snapshot(deps);

        const result = await runInit(deps, withHome({ yes }));

        expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
        expect(messageOf(result)).toContain('/ws/sub is inside another node home: /ws/factory.yaml exists');
        expect(messageOf(result)).not.toContain('already exists');
        expect(messageOf(result)).not.toContain('proposed');
        expect(deps.prompts).toEqual([]);
        expect(snapshot(deps)).toBe(before);
      },
    );

    it('exits 4 for a folder below a node home before it scans the folder for repos', async () => {
      const deps = inWorkspace({ ...terminal, cwd: '/ws/sub', prompt: () => ok('y') }, { repos: { '/ws/sub/app': {} } });
      deps.seed('/ws/factory.yaml', 'schema: 2\n');
      const before = snapshot(deps);

      const result = await runInit(deps, withHome({ yes: true }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('is inside another node home');
      expect(deps.prompts).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    });

    it.each([
      ['a config file', (deps: FakeDeps) => deps.seed('/ws/sub/factory.yaml', 'schema: 2\n'), 'factory.yaml already exists in /ws/sub'],
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
    const targets = urls.map((url, i) => [`/ws/p${String(i).padStart(2, '0')}`, url] as const);
    const repos = Object.fromEntries([
      ...found.map((path) => [path, {}]),
      ...(cloned ? targets.map(([path, origin]) => [path, { origin }]) : []),
    ]);
    const { handler, log } = gitHandler({ repos });
    const deps = createFakeDeps({ cwd: WS, run: handler });
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

  it('clones next to the home with "--" before the URL, and stores the path relative to the home', async () => {
    const { deps, log, done } = run({ repos: { '/w/api': { origin: URL_API } } }, [URL_API]);
    const result = await done;
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', URL_API, '/w/api']]);
    expect(deps.calls.find((call) => call.args[0] === 'clone')?.timeoutMs).toBe(300_000);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((project) => [project.id, project.path])).toEqual([['api', '../api']]);
    expect(result.ok && result.value.json['cloned']).toEqual(['/w/api']);
  });

  it.each([
    ['https://host/acme/api', 'api'],
    ['https://host:8443/acme/api.git', 'api'],
    ['ssh://git@host/acme/api.git', 'api'],
    ['git@host.example:acme/api.git', 'api'],
  ])('accepts the form %s', async (url, name) => {
    const { log, done } = run({ repos: { [`/w/${name}`]: { origin: url } } }, [url]);
    expect((await done).ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', url, `/w/${name}`]]);
  });

  it('reuses a target that is a clone of the same URL, and runs no clone', async () => {
    const { deps, log } = setup({ repos: { '/w/api': { origin: URL_API } } });
    deps.seedDir('/w/api');
    const result = await runInit(deps, options({ projects: [URL_API] }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([]);
    expect(result.ok && result.value.json['cloned']).toEqual([]);
  });

  it('exits 4 and names the path when the target is a clone of another URL, and changes nothing', async () => {
    const { deps, log } = setup({ repos: { '/w/api': { origin: 'https://host/other/api.git' } } });
    deps.seedDir('/w/api');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: [URL_API] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('/w/api');
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 for a target that is a folder with no repo, and for a target that is a file', async () => {
    const folder = setup({});
    folder.deps.seedDir('/w/api');
    expect(await runInit(folder.deps, options({ projects: [URL_API] }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(folder.log.clones()).toEqual([]);

    const file = setup({});
    file.deps.seed('/w/api', 'x');
    expect(await runInit(file.deps, options({ projects: [URL_API] }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(file.log.clones()).toEqual([]);
  });

  it.each([
    ['a name with ..', 'https://host/acme/..'],
    ['a name with .. inside', 'https://host/acme/a..b.git'],
    ['a name that starts with a hyphen', 'https://host/acme/-x.git'],
    ['a name that is only .git', 'https://host/acme/.git'],
    ['a name that is too long', `https://host/acme/${'a'.repeat(101)}.git`],
    ['an http URL', 'http://host/acme/api.git'],
    ['a file URL', 'file:///srv/acme/api.git'],
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

  it('exits 2 when the repo would be cloned into the home itself', async () => {
    const { log, done } = run({}, ['https://host/acme/node.git']);
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
      const deps = cloneSetup({ repos: { '/w/api': { origin: URL_API }, '/w/docs': { origin: URL_DOCS } } });
      deps.seedDir('/w/docs');
      deps.seed('/w/docs/README.md', 'mine');

      const result = await runInit(failingWrite(deps, '/factory.yaml'), options({ projects: [URL_API, URL_DOCS] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(deps.dirs.has('/w/api')).toBe(false);
      expect(deps.files.has('/w/api/README.md')).toBe(false);
      expect(deps.dirs.has('/w/docs')).toBe(true);
      expect(deps.files.get('/w/docs/README.md')).toBe('mine');
      expect(messageOf(result)).toContain('Removed the clone that this run made: /w/api.');
      expect(messageOf(result)).not.toContain('/w/docs');
      expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    });

    it('removes the clone that an earlier URL made when a later clone fails', async () => {
      const deps = cloneSetup({}, URL_DOCS);

      const result = await runInit(deps, options({ projects: [URL_API, URL_DOCS] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('cannot clone https://host/acme/docs.git');
      expect(messageOf(result)).toContain('Removed the clone that this run made: /w/api.');
      expect(deps.dirs.has('/w/api')).toBe(false);
    });

    it('names a clone that it cannot remove', async () => {
      const deps = cloneSetup({ repos: { '/w/api': { origin: URL_API } } });
      const stuck: Deps = {
        ...deps,
        fs: { ...deps.fs, remove: async (path) => (path === '/w/api' ? failure('cannot remove /w/api: EBUSY') : deps.fs.remove(path)) },
      };

      const result = await runInit(failingWrite(stuck, '/factory.yaml'), options({ projects: [URL_API] }));

      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain('These clones could not be removed: /w/api (cannot remove /w/api: EBUSY).');
      expect(messageOf(result)).not.toContain('Removed the clone');
    });

    describe('the folders above the home', () => {
      const NESTED = '/w/new/deep/place';
      const nested = (): InitOptions => options({ home: NESTED, projects: [URL_API] });
      const repos = { '/w/new/deep/api': { origin: URL_API } };

      it('removes the folders that this run made, deepest first, when a later step fails', async () => {
        const deps = cloneSetup({ repos });

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
        expect(messageOf(result)).toContain('Removed the clone that this run made: /w/new/deep/api.');
        expect(messageOf(result)).toContain('Removed the folders that this run made: /w/new/deep, /w/new.');
        expect([...deps.dirs].filter((dir) => dir.startsWith('/w/new'))).toEqual([]);
        expect(deps.dirs.has('/w')).toBe(true);
      });

      it('removes the folders that this run made when a clone fails', async () => {
        const deps = cloneSetup({}, URL_API);

        const result = await runInit(deps, nested());

        expect(messageOf(result)).toContain('cannot clone https://host/acme/api.git');
        expect(messageOf(result)).toContain('Removed the folders that this run made: /w/new/deep, /w/new.');
        expect([...deps.dirs].filter((dir) => dir.startsWith('/w/new'))).toEqual([]);
      });

      it('never removes a folder that was there before the run', async () => {
        const deps = cloneSetup({ repos });
        deps.seedDir('/w/new');
        deps.seed('/w/new/mine.txt', 'mine');

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(messageOf(result)).toContain('Removed the folder that this run made: /w/new/deep.');
        expect(deps.dirs.has('/w/new/deep')).toBe(false);
        expect(deps.files.get('/w/new/mine.txt')).toBe('mine');
      });

      it('keeps a folder that this run made when it is not empty, and names it', async () => {
        const deps = cloneSetup({ repos }, undefined, (fake) => fake.seed('/w/new/stray.txt', 'x'));

        const result = await runInit(failingWrite(deps, '/factory.yaml'), nested());

        expect(deps.files.has('/w/new/stray.txt')).toBe(true);
        expect(deps.dirs.has('/w/new/deep')).toBe(false);
        expect(messageOf(result)).toContain('These folders could not be removed: /w/new (cannot remove /w/new: ENOTEMPTY).');
      });

      it('removes the folders that it made when it cannot make the next one, and runs no clone', async () => {
        const { deps, log } = setup({ repos });
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
        const deps = cloneSetup({ repos });

        const result = await runInit(deps, nested());

        expect(result.ok).toBe(true);
        expect(deps.files.has(`${NESTED}/factory.yaml`)).toBe(true);
        expect(deps.dirs.has('/w/new/deep/api')).toBe(true);
      });
    });
  });

  describe('a URL with credentials', () => {
    const TOKEN = 'ghp_S3cretT0kenValue';
    const URL_TOKEN = `https://${TOKEN}@github.com/acme/api.git`;
    const URL_SHOWN = 'https://github.com/acme/api.git';
    const INDEX = '/state/factory/homes.json';
    const env = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
    const echoed = { cloneExit: 128, cloneStderr: `fatal: unable to access '${URL_TOKEN}/': The requested URL returned error: 403\n` };

    /** Every text that the command shows or keeps: its result, and each file and folder of the file system. */
    const everythingOf = (deps: FakeDeps, result: unknown): string =>
      JSON.stringify([result, [...deps.files.entries()], [...deps.dirs]]);

    const initCli = async (fixture: GitFixture, json: boolean) => {
      const { deps } = setup(fixture, { env });
      const sink = captureSink();
      const argv = ['init', '--home', HOME, '--owner-name', 'Test Owner', '--project', URL_TOKEN, ...(json ? ['--json'] : [])];
      const code = await runCli(argv, deps, sink);
      return { deps, code, out: sink.out.join(''), err: sink.errors.join('') };
    };

    it('keeps the token out of the result and the written files, and warns without naming it', async () => {
      const { deps, done } = run({ repos: { '/w/api': { origin: URL_TOKEN } } }, [URL_TOKEN], { env });
      const result = await done;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(deps.files.get(`${HOME}/factory.yaml`)).toContain('acme/api');
      expect(deps.files.has(INDEX)).toBe(true);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
      expect(result.value.warnings).toHaveLength(1);
      expect(result.value.warnings[0]).toContain('.git/config');
      expect(result.value.warnings[0]).toContain('gh auth login');
      expect(result.value.warnings[0]).not.toContain(TOKEN);
    });

    it.each(['ssh://git@github.com/acme/api.git', 'git@github.com:acme/api.git', URL_SHOWN])(
      'does not warn for %s, which holds no credentials',
      async (url) => {
        const { done } = run({ repos: { '/w/api': { origin: url } } }, [url], { env });
        const result = await done;
        expect(result.ok && result.value.warnings).toEqual([]);
      },
    );

    it('prints the token on neither stdout nor stderr, and prints the warning on stderr', async () => {
      const { code, out, err } = await initCli({ repos: { '/w/api': { origin: URL_TOKEN } } }, false);
      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain(TOKEN);
      expect(err).toContain('warning: ');
      expect(err).toContain('gh auth login');
    });

    it('puts the warning in the JSON document, with no token', async () => {
      const { code, out, err } = await initCli({ repos: { '/w/api': { origin: URL_TOKEN } } }, true);
      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain(TOKEN);
      expect(out).toContain('gh auth login');
    });

    it('shows the token nowhere when the clone fails, also when git repeats the URL', async () => {
      const { deps, done } = run(echoed, [URL_TOKEN], { env });
      const result = await done;
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(messageOf(result)).toContain(`cannot clone ${URL_SHOWN}`);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
      expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(false);
    });

    it('prints the token on neither stdout nor stderr when the clone fails, in text and in JSON', async () => {
      for (const json of [false, true]) {
        const { code, out, err } = await initCli(echoed, json);
        expect(code).toBe(1);
        expect(`${out}${err}`).not.toContain(TOKEN);
        expect(err).toContain(`cannot clone ${URL_SHOWN}`);
      }
    });

    it('shows the token nowhere when the target holds a clone of another URL', async () => {
      const { deps } = setup({ repos: { '/w/api': { origin: 'https://host/other/api.git' } } }, { env });
      deps.seedDir('/w/api');
      const result = await runInit(deps, options({ projects: [URL_TOKEN] }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain(`is not a clone of ${URL_SHOWN}`);
      expect(everythingOf(deps, result)).not.toContain(TOKEN);
    });

    it('refuses the user:password form and does not repeat it', async () => {
      const { done } = run({}, ['https://user:tok3n@host/acme/api.git'], { env });
      const result = await done;
      expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
      expect(JSON.stringify(result)).not.toContain('tok3n');
    });

    it.each(['user:s3cr3t@host:acme/api.git', 'user:@host:acme/api.git', 'a:b@host'])(
      'refuses the form %s with a usage error that does not repeat it, and runs no clone',
      async (value) => {
        const { deps, log, done } = run({}, [value], { env });
        const result = await done;
        expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
        expect(messageOf(result)).toContain('this URL form is not accepted');
        expect(everythingOf(deps, result)).not.toContain(value);
        expect(log.clones()).toEqual([]);
      },
    );

    it('prints no part of a user:secret@host:path value on stdout or stderr', async () => {
      const { deps } = setup({}, { env });
      const sink = captureSink();
      const argv = ['init', '--home', HOME, '--owner-name', 'Test Owner', '--project', 'user:s3cr3t@host:acme/api.git'];
      expect(await runCli(argv, deps, sink)).toBe(2);
      expect(`${sink.out.join('')}${sink.errors.join('')}`).not.toContain('s3cr3t');
    });

    it('keeps a path that holds a colon and an @ as a path', async () => {
      const { deps, log } = setup({ repos: { '/w/odd:name@x': {} } });
      deps.seedDir('/w/odd:name@x');
      expect(await runInit(deps, options({ projects: ['/w/odd:name@x'] }))).toMatchObject({ ok: true });
      expect(log.clones()).toEqual([]);
    });
  });

  it('keeps a path as a path and a URL as a URL in one command', async () => {
    const { deps, log, done } = run({ repos: { '/w/web': {}, '/w/api': { origin: URL_API } } }, ['/w/web', URL_API]);
    expect((await done).ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.recipe.projects.map((project) => project.id)).toEqual(['web', 'api']);
    expect(log.clones()).toHaveLength(1);
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

  it('refuses a home inside a git work tree and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({ home: '/w/web/node' }, { repos: { '/w/web': {} } }, (deps) =>
      deps.seedDir('/w/web'),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('/w/web/node is inside the git work tree /w/web');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a home inside another node home and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({}, {}, (deps) => deps.seed('/w/factory.yaml', 'schema: 2\n'));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('is inside another node home');
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
    ['a config file', (deps: FakeDeps) => deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n'), 'factory.yaml already exists'],
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
    const { result, log } = await initWithUrl({ ownerName: undefined }, { identity: false }, (deps) =>
      deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n'),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.yaml already exists');
    expect(log.clones()).toEqual([]);
  });

  it.each([
    ['is not a file', (deps: FakeDeps) => deps.seedDir(`${HOME}/CLAUDE.md`), 'CLAUDE.md is not a file'],
    ['has a broken block marker', (deps: FakeDeps) => deps.seed(`${HOME}/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n'), 'CLAUDE.md: line 1'],
  ])('refuses a CLAUDE.md that %s and runs no clone', async (_name, prepare, text) => {
    const { result, log, changed } = await initWithUrl({}, {}, prepare);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain(text);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a CLAUDE.md that holds a block of the same name and runs no clone', async () => {
    const first = setup();
    await runInit(first.deps, options());
    const { result, log, changed } = await initWithUrl({}, {}, (deps) =>
      deps.seed(`${HOME}/CLAUDE.md`, first.deps.files.get(`${HOME}/CLAUDE.md`) ?? ''),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('already holds the block coordinator');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a home that holds a git repo one level down and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl({}, { repos: { [`${HOME}/app`]: {} } }, (deps) =>
      deps.seedDir(`${HOME}/app/.git`),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('holds the git repo app one level down');
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a home that holds a staging folder of a stopped init, names it and runs no clone', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const { result, log, changed } = await initWithUrl({}, { repos: { [staging]: {} } }, (deps) =>
      deps.seedDir(`${staging}/.git`),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`holds the staging folder ${staging}, left by a stopped init`);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('refuses a home that holds a project and runs no clone', async () => {
    const { result, log, changed } = await initWithUrl(
      { projects: ['/w/node/app', URL_API] },
      { repos: { [`${HOME}/app`]: {}, '/w/api': { origin: URL_API } } },
      (deps) => deps.seedDir(`${HOME}/app/.git`),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`${HOME} is the project folder /w/node/app, or holds it`);
    expect(log.clones()).toEqual([]);
    expect(changed).toBe(false);
  });

  it('still clones when every value is good', async () => {
    const { result, log } = await initWithUrl({ layer: '1', recipe: 'software' }, { repos: { '/w/api': { origin: URL_API } } });
    expect(result.ok).toBe(true);
    expect(log.clones()).toHaveLength(1);
  });
});

describe('init: the home index', () => {
  const INDEX = '/state/factory/homes.json';
  const env = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
  const repos = { '/w/web': {}, '/w/api': {} };
  const stored = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(INDEX) ?? 'null');

  it('records the home, its id and the real path of each project after it writes the node', async () => {
    const { deps } = setup({ repos }, { env });
    const result = await runInit(deps, options({ projects: ['/w/web', '/w/api'] }));
    expect(result.ok && result.value.warnings).toEqual([]);
    expect(stored(deps)).toEqual({ schema: 1, homes: [{ home: HOME, id: 'node', projects: ['/w/web', '/w/api'] }] });
    expect(deps.modes.get(INDEX)).toBe(0o600);
    expect(deps.modes.get('/state/factory')).toBe(0o700);
  });

  it('records the real paths when the folders are behind a link', async () => {
    const { deps } = setup({ repos: { '/w/via/proj': {} } }, { env, links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/via/proj');
    deps.seedDir('/w/real');
    await runInit(deps, options({ home: '/w/real/node', projects: ['/w/via/proj'] }));
    expect(stored(deps)).toEqual({ schema: 1, homes: [{ home: '/w/real/node', id: 'node', projects: ['/w/real/proj'] }] });
  });

  it('replaces the entry of the same home and keeps the entries of other homes', async () => {
    const { deps } = setup({ repos }, { env });
    deps.seed(INDEX, JSON.stringify({ schema: 1, homes: [{ home: '/h/other', id: 'other', projects: ['/h/x'] }] }));
    await runInit(deps, options({ projects: ['/w/web'] }));
    expect(stored(deps)).toEqual({
      schema: 1,
      homes: [
        { home: '/h/other', id: 'other', projects: ['/h/x'] },
        { home: HOME, id: 'node', projects: ['/w/web'] },
      ],
    });
  });

  it('warns and still creates the node when neither variable names a folder for the index', async () => {
    const { deps } = setup({ repos });
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join('\n')).toContain('The home index was not updated');
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
  });

  it('warns, keeps the file as it was and still creates the node when the index cannot be read', async () => {
    const { deps } = setup({ repos }, { env });
    deps.seed(INDEX, 'broken');
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join('\n')).toContain(`The home index ${INDEX} was not updated`);
    expect(deps.files.get(INDEX)).toBe('broken');
    expect(deps.files.has(`${HOME}/factory.yaml`)).toBe(true);
  });

  it('refuses with exit 4 an index path under the folder of Claude Code, before it writes anything', async () => {
    const { deps } = setup({ repos }, { env: { HOME: '/users/me', XDG_STATE_HOME: '/users/me/.claude/state' } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ projects: ['/w/web'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('lists the warning in the JSON document', async () => {
    const { deps } = setup({}, { env });
    deps.seed(INDEX, 'broken');
    const result = await runInit(deps, options());
    expect(result.ok && result.value.json['warnings']).toEqual([expect.stringContaining('was not updated')]);
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
      files: ['factory.yaml', 'CLAUDE.md', '.factory/'],
      committed: true,
    });
    expect(result.value.lines.map((line) => line.text).join('\n')).toContain('factory doctor --home /w/node');
  });
});
