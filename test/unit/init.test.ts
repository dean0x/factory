import { describe, expect, it } from 'vitest';
import { parseBlocks, verifyBlock } from '../../src/blocks/managed.js';
import { failure } from '../../src/cli/errors.js';
import { applyInit, planInit, runInit, type InitOptions } from '../../src/commands/init.js';
import { loadConfig } from '../../src/config/load.js';
import type { Deps } from '../../src/core/deps.js';
import { loadState } from '../../src/state/load.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps, exited, withFailingWrites, type FakeDeps } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';

const HOME = '/w/node';

const options = (extra: Partial<InitOptions> = {}): InitOptions => ({
  home: HOME,
  name: undefined,
  ownerName: 'Test Owner',
  ownerGithub: undefined,
  projects: [],
  ...extra,
});

const setup = (fixture: GitFixture = {}) => {
  const { handler, log } = gitHandler(fixture);
  const deps = createFakeDeps({ cwd: '/w', run: handler });
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
      '.factory/protocol.md',
      '.factory/board.json',
      '.factory/waiting.json',
      '.factory/decision-log.json',
      '.factory/decision-profile/README-format.md',
      '.factory/decision-profile/index.md',
      '.factory/roadmaps/README.md',
      '.factory/briefs/.gitkeep',
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
    expect(config.value.node.id).toBe('node');
    expect(config.value.owner.display).toBe('Test Owner');
    expect(config.value.owner.github).toBeUndefined();
    expect(config.value.session.permission_mode).toBe('auto');
    expect(config.value.session.proxy).toBe('none');
    expect(config.value.projects).toEqual([]);
  });

  it('writes node.json with the version, the creator and the block versions', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    expect(await loadState(deps, HOME)).toEqual({
      ok: true,
      value: {
        schema_version: 1,
        created_with: FACTORY_VERSION,
        blocks: { coordinator: 1, safety: 1, protocol: 1 },
      },
    });
  });

  it('writes the managed blocks: coordinator and safety in CLAUDE.md, protocol in protocol.md', async () => {
    const { deps } = setup();
    await runInit(deps, options());
    const claude = parseBlocks(deps.files.get(`${HOME}/CLAUDE.md`) ?? '');
    const protocol = parseBlocks(deps.files.get(`${HOME}/.factory/protocol.md`) ?? '');
    expect(claude.ok && claude.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['coordinator', 'intact'],
      ['safety', 'intact'],
    ]);
    expect(protocol.ok && protocol.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
      ['protocol', 'intact'],
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
    expect(deps.files.get(`${HOME}/.factory/briefs/.gitkeep`)).toBe('');
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
    expect((await runInit(deps, options())).ok).toBe(false);
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

describe('init: a parent folder with a config file', () => {
  it('succeeds, warns with the path of the parent file, and writes no parent link', async () => {
    const { deps } = setup();
    deps.seed('/w/factory.yaml', 'schema: 1\n');
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toBe(false);
    expect(result.value.warnings.join('\n')).toContain('/w/factory.yaml');
    expect(result.value.json['warnings']).toEqual(result.value.warnings);

    expect(deps.files.get('/w/factory.yaml')).toBe('schema: 1\n');
    const config = deps.files.get(`${HOME}/factory.yaml`) ?? '';
    expect(config).not.toMatch(/parent/i);
    expect(config).not.toContain('/w/factory.yaml');
    const state = JSON.parse(deps.files.get(`${HOME}/.factory/node.json`) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(['blocks', 'created_with', 'schema_version']);
  });

  it('finds a config file several levels up', async () => {
    const { deps } = setup();
    deps.seed('/factory.yaml', 'schema: 1\n');
    const result = await planInit(deps, options({ home: '/w/a/b/c' }));
    expect(result.ok && result.value.warnings.join('\n')).toContain('/factory.yaml');
  });

  it('gives no warning when no parent has a config file', async () => {
    const { deps } = setup();
    const result = await runInit(deps, options());
    expect(result.ok && result.value.warnings).toEqual([]);
  });
});

describe('init: defaults from the system', () => {
  it('takes the owner name from git config when no flag is given', async () => {
    const { deps } = setup({ userName: 'From Git' });
    await runInit(deps, options({ ownerName: undefined }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.owner.display).toBe('From Git');
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
    expect((await loadConfig(good.deps, HOME)).ok && (await loadConfig(good.deps, HOME))).toMatchObject({
      value: { owner: { github: 'some-login' } },
    });

    for (const gh of [null, 'not a login!', undefined]) {
      const other = setup(gh === undefined ? {} : { gh });
      await runInit(other.deps, options());
      const config = await loadConfig(other.deps, HOME);
      expect(config.ok && config.value.owner.github).toBeUndefined();
    }
  });

  it('prefers the GitHub flag over gh and does not run gh', async () => {
    const { deps, log } = setup({ gh: 'from-gh' });
    await runInit(deps, options({ ownerGithub: 'from-flag' }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.owner.github).toBe('from-flag');
    expect(log.calls.some((call) => call.command === 'gh')).toBe(false);
  });

  it('makes the node id from the folder name, and fails when nothing is left', async () => {
    const named = setup();
    await runInit(named.deps, options({ home: '/w/My Project_2' }));
    const config = await loadConfig(named.deps, '/w/My Project_2');
    expect(config.ok && config.value.node.id).toBe('my-project-2');

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
    expect(config.ok && config.value.projects).toEqual([
      {
        id: 'web',
        repo: 'acme/web',
        path: '../web',
        default_branch: 'trunk',
        merge_method: 'squash',
        pack: 'plain',
        gate: { checks: [] },
      },
      {
        id: 'api',
        repo: 'acme/api',
        path: '../api',
        default_branch: 'develop',
        merge_method: 'squash',
        pack: 'plain',
        gate: { checks: [] },
      },
    ]);
  });

  it('leaves the repo unset for a remote that is not on GitHub, and falls back to main', async () => {
    const { deps } = setup({ repos });
    await runInit(deps, options({ projects: ['/w/My Tool', '/w/lib'] }));
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.projects.map((p) => [p.id, p.repo, p.default_branch])).toEqual([
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

  it('refuses two projects with the same id', async () => {
    const { deps } = setup({ repos: { '/w/web': {}, '/other/web': {} } });
    const result = await runInit(deps, options({ projects: ['/w/web', '/other/web'] }));
    expect(result.ok).toBe(false);
  });

  it('stores a project inside the home as a path below the home', async () => {
    const { deps } = setup({ repos: { '/w/node/app': {}, '/w/node': {} } });
    const result = await runInit(deps, options({ projects: ['/w/node/app', '/w/node'] }));
    expect(result.ok).toBe(true);
    const config = await loadConfig(deps, HOME);
    expect(config.ok && config.value.projects.map((project) => [project.id, project.path])).toEqual([
      ['app', 'app'],
      ['node', '.'],
    ]);
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
      '-c commit.gpgsign=false commit -q -m chore: initialize the state',
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
