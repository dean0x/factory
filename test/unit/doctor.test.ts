import { describe, expect, it } from 'vitest';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import {
  checkBlocks,
  checkConfig,
  checkConfigVersion,
  checkPermissionMode,
  checkProjects,
  checkProxies,
  checkProxyEnv,
  checkSecrets,
  checkState,
  checkStateRepo,
  checkTools,
  runDoctor,
  type CheckResult,
} from '../../src/commands/doctor.js';
import { runInit } from '../../src/commands/init.js';
import { inspectConfig } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { inspectState } from '../../src/state/load.js';
import { blockTemplates } from '../../src/templates/index.js';
import { createFakeDeps, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/w/node';
const TOOLS = ['git', 'tmux', 'gh', 'claude'];

interface Setup {
  readonly env?: Record<string, string | undefined>;
  readonly git?: GitFixture;
  readonly nodeVersion?: string;
  readonly fetch?: FetchHandler;
  readonly tools?: readonly string[];
  readonly cwd?: string;
}

const makeDeps = (setup: Setup = {}): FakeDeps => {
  const { handler } = gitHandler(setup.git ?? {});
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w',
    env: { PATH: '/bin', ...setup.env },
    run: handler,
    nodeVersion: setup.nodeVersion ?? 'v22.5.0',
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
  });
  for (const tool of setup.tools ?? TOOLS) deps.seed(`/bin/${tool}`, '');
  return deps;
};

const initialized = async (setup: Setup = {}): Promise<FakeDeps> => {
  const deps = makeDeps(setup);
  const result = await runInit(deps, {
    home: HOME,
    name: 'demo',
    ownerName: 'Test Owner',
    ownerGithub: undefined,
    projects: [],
  });
  expect(result.ok).toBe(true);
  return deps;
};

const levelOf = (results: readonly CheckResult[], id: string): string | undefined =>
  results.find((result) => result.id === id)?.level;

const writeConfig = (deps: FakeDeps, config: FactoryConfig): void => {
  deps.files.set(`${HOME}/factory.yaml`, renderConfig(config));
};

const doctor = async (deps: FakeDeps) => {
  const result = await runDoctor(deps, { home: HOME });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('doctor: config, version and state', () => {
  it('reports a valid config and current versions', async () => {
    const deps = await initialized();
    const config = await inspectConfig(deps, HOME);
    expect(checkConfig(config)).toEqual({ id: 'config', level: 'ok', text: 'factory.yaml is valid' });
    expect(checkConfigVersion(config)).toMatchObject({ id: 'config-version', level: 'ok' });
    expect(checkState(await inspectState(deps, HOME))).toMatchObject({ id: 'state', level: 'ok' });
  });

  it('fails when the config is missing, does not parse or is invalid', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(checkConfig(await inspectConfig(deps, HOME))).toMatchObject({ level: 'fail', text: 'factory.yaml not found' });

    deps.files.set(`${HOME}/factory.yaml`, 'a: [1\n');
    expect(checkConfig(await inspectConfig(deps, HOME))).toMatchObject({ level: 'fail' });

    deps.files.set(`${HOME}/factory.yaml`, renderConfig(sampleConfig()).replace('effort: high', 'effort: wild'));
    const invalid = checkConfig(await inspectConfig(deps, HOME));
    expect(invalid.level).toBe('fail');
    expect(invalid.text).toContain('session.effort');
  });

  it('fails the version check for a schema that is newer, and warns when it cannot check', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
    const newer = await inspectConfig(deps, HOME);
    expect(checkConfig(newer).level).toBe('ok');
    expect(checkConfigVersion(newer)).toMatchObject({ level: 'fail' });
    expect(checkConfigVersion(newer).text).toContain('Upgrade factory.');

    deps.files.set(`${HOME}/factory.yaml`, 'a: [1\n');
    expect(checkConfigVersion(await inspectConfig(deps, HOME)).level).toBe('warn');
  });

  it('fails the state check for a missing, broken or newer node.json', async () => {
    const deps = await initialized();
    const path = `${HOME}/.factory/node.json`;
    const original = deps.files.get(path) ?? '';

    deps.files.delete(path);
    expect(checkState(await inspectState(deps, HOME))).toMatchObject({ level: 'fail', text: '.factory/node.json not found' });
    deps.files.set(path, '{');
    expect(checkState(await inspectState(deps, HOME)).level).toBe('fail');
    deps.files.set(path, original.replace('"schema_version": 1', '"schema_version": 5'));
    const newer = checkState(await inspectState(deps, HOME));
    expect(newer.level).toBe('fail');
    expect(newer.text).toContain('Upgrade factory.');
  });
});

describe('doctor: blocks', () => {
  it('is ok when all managed blocks are intact', async () => {
    const deps = await initialized();
    expect(checkBlocks(await inspectBlocks(deps, HOME, blockTemplates))).toMatchObject({
      id: 'blocks',
      level: 'ok',
      text: '3 managed blocks are intact',
    });
  });

  it('warns when a block was edited by hand, and names it', async () => {
    const deps = await initialized();
    const path = `${HOME}/CLAUDE.md`;
    deps.files.set(path, (deps.files.get(path) ?? '').replace('Coordinate. Do not produce.', 'Do as you like.'));
    const result = checkBlocks(await inspectBlocks(deps, HOME, blockTemplates));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('coordinator (edited');
    expect(result.text).not.toContain('safety');
  });

  it('warns when a block or its file is missing, and when the markers are broken', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/.factory/protocol.md`);
    const missing = checkBlocks(await inspectBlocks(deps, HOME, blockTemplates));
    expect(missing.level).toBe('warn');
    expect(missing.text).toContain('protocol (missing');

    deps.files.set(`${HOME}/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n');
    const broken = checkBlocks(await inspectBlocks(deps, HOME, blockTemplates));
    expect(broken.text).toContain('coordinator (malformed');
    expect(broken.text).toContain('safety (malformed');
  });

  it('keeps the text of the owner out of the verdict', async () => {
    const deps = await initialized();
    const path = `${HOME}/CLAUDE.md`;
    deps.files.set(path, `My own rules.\n\n${deps.files.get(path) ?? ''}\nMore of my rules.\n`);
    expect(checkBlocks(await inspectBlocks(deps, HOME, blockTemplates)).level).toBe('ok');
  });
});

describe('doctor: secrets', () => {
  const secret = FAKE_GITHUB_TOKEN;

  it('is ok for a clean config', async () => {
    const deps = await initialized();
    expect(checkSecrets(await inspectConfig(deps, HOME))).toMatchObject({ id: 'secrets', level: 'ok' });
  });

  it('fails and names the key, never the value', async () => {
    const deps = await initialized();
    writeConfig(deps, { ...sampleConfig(), projects: [{ ...sampleConfig().projects[0]!, heavy_test: `curl -H ${secret}` }] });
    const result = checkSecrets(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('projects.0.heavy_test');
    expect(result.text).not.toContain('ghp_');
  });

  it('scans a config that is invalid for other reasons', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, `schema: 1\nextra: ${secret}\n`);
    const result = checkSecrets(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('extra');
  });

  it('warns when the config does not parse', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, `a: [${secret}\n`);
    expect(checkSecrets(await inspectConfig(deps, HOME)).level).toBe('warn');
  });
});

describe('doctor: permission mode', () => {
  it('is ok when the home has no settings folder', async () => {
    const deps = await initialized();
    expect((await checkPermissionMode(deps, HOME)).level).toBe('ok');
  });

  it.each([
    ['bypassPermissions as the default mode', '{"permissions":{"defaultMode":"bypassPermissions"}}'],
    ['the skip flag in a command', '{"env":{"X":"--dangerously-skip-permissions"}}'],
    ['the skip prompt setting', '{"skipDangerousModePermissionPrompt": true}'],
  ])('fails for %s in settings.local.json', async (_name, json) => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.local.json`, json);
    const result = await checkPermissionMode(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('.claude/settings.local.json');
  });

  it('checks settings.json too, and ignores other files and safe settings', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.json`, '{"permissions":{"disableBypassPermissionsMode":"disable"}}');
    deps.seed(`${HOME}/.claude/notes.txt`, 'bypassPermissions');
    expect((await checkPermissionMode(deps, HOME)).level).toBe('ok');
    deps.seed(`${HOME}/.claude/settings.json`, '{"permissions":{"defaultMode":"bypassPermissions"}}');
    expect((await checkPermissionMode(deps, HOME)).text).toContain('.claude/settings.json');
  });

  it('does not read the user settings folder of Claude Code when the home is the user HOME', async () => {
    const deps = makeDeps({ env: { HOME } });
    deps.seed(`${HOME}/.claude/settings.json`, '{"permissions":{"defaultMode":"bypassPermissions"}}');
    const result = await checkPermissionMode(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('not checked');
  });

  it('warns when it cannot tell whether the settings folder exists', async () => {
    const deps = await initialized();
    const denied = { ...deps, fs: { ...deps.fs, stat: async () => failure('cannot stat /w/node/.claude: EACCES') } };
    const result = await checkPermissionMode(denied, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('not checked');
    expect(result.text).toContain('EACCES');
  });

  it('warns when the settings folder cannot be listed', async () => {
    const deps = await initialized();
    deps.seedDir(`${HOME}/.claude`);
    const denied = { ...deps, fs: { ...deps.fs, list: async () => failure('cannot list /w/node/.claude: EACCES') } };
    const result = await checkPermissionMode(denied, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('not checked');
    expect(result.text).toContain('EACCES');
  });

  it('warns and names the settings file that it cannot read', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.json`, '{}');
    deps.seed(`${HOME}/.claude/settings.local.json`, '{}');
    const readText = async (path: string) =>
      path.endsWith('settings.local.json') ? failure(`cannot read ${path}: EACCES`) : deps.fs.readText(path);
    const result = await checkPermissionMode({ ...deps, fs: { ...deps.fs, readText } }, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('.claude/settings.local.json');
    expect(result.text).not.toContain('.claude/settings.json');
  });

  it('fails for a settings file that skips the checks, even when another file cannot be read', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.json`, '{"permissions":{"defaultMode":"bypassPermissions"}}');
    deps.seed(`${HOME}/.claude/settings.local.json`, '{}');
    const readText = async (path: string) =>
      path.endsWith('settings.local.json') ? failure(`cannot read ${path}: EACCES`) : deps.fs.readText(path);
    const result = await checkPermissionMode({ ...deps, fs: { ...deps.fs, readText } }, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('.claude/settings.json');
  });
});

describe('doctor: proxy variable in the shell', () => {
  it('warns when the variable is set, and names only the variable', () => {
    const value = 'http://user:topsecret@proxy.example.com:9';
    const result = checkProxyEnv(makeDeps({ env: { ANTHROPIC_BASE_URL: value } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('ANTHROPIC_BASE_URL');
    expect(result.text).not.toContain('topsecret');
    expect(result.text).not.toContain('proxy.example.com');
  });

  it('is ok when the variable is not set or is empty', () => {
    expect(checkProxyEnv(makeDeps()).level).toBe('ok');
    expect(checkProxyEnv(makeDeps({ env: { ANTHROPIC_BASE_URL: '' } })).level).toBe('ok');
  });
});

describe('doctor: proxies', () => {
  const withProxies = (onFail: 'stop' | 'direct', lanes: FactoryConfig['lanes'] = {}): FactoryConfig => ({
    ...sampleConfig(),
    session: { ...sampleConfig().session, proxy: 'local' },
    proxies: [
      { id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: onFail },
      { id: 'spare', base_url: 'http://127.0.0.1:9999', health: '/health', on_fail: 'stop' },
    ],
    lanes,
  });

  const stateOf = async (deps: FakeDeps, config: FactoryConfig) => {
    writeConfig(deps, config);
    return inspectConfig(deps, HOME);
  };

  it('says that no proxy is in use when the session names none', async () => {
    const deps = await initialized();
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), true);
    expect(results).toEqual([{ id: 'proxy', level: 'ok', text: 'no proxy is in use' }]);
  });

  it('is ok when the proxy answers below 500, and sends one request to the health URL', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 404 }) });
    const results = await checkProxies(deps, await stateOf(deps, withProxies('stop')), true);
    expect(results).toEqual([{ id: 'proxy:local', level: 'ok', text: 'local (127.0.0.1:8787) answers' }]);
    expect(deps.fetched).toEqual(['http://127.0.0.1:8787/v1/health']);
  });

  it('fails when the proxy is down and on_fail is stop', async () => {
    const deps = makeDeps();
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('stop')), true);
    expect(result?.level).toBe('fail');
    expect(result?.text).toContain('local (127.0.0.1:8787) does not answer');
  });

  it('warns when the proxy is down and on_fail is direct', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 500 }) });
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('direct')), true);
    expect(result?.level).toBe('warn');
    expect(result?.text).toContain('on_fail is direct');
  });

  it('checks a proxy that only a lane uses, and skips a proxy that nothing uses', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 200 }) });
    const config = { ...withProxies('stop', { 'web-lane': { proxy: 'spare' } }), session: { ...sampleConfig().session } };
    const results = await checkProxies(deps, await stateOf(deps, config), true);
    expect(results.map((result) => result.id)).toEqual(['proxy:spare']);
  });

  it('warns that it did not check when the config is not valid', async () => {
    const deps = makeDeps();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 1\n');
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), true);
    expect(results).toEqual([{ id: 'proxy', level: 'warn', text: 'not checked: factory.yaml is not valid' }]);
  });

  it('sends no request when it may not, and tells the user to give the home', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 200 }) });
    const [result, ...rest] = await checkProxies(deps, await stateOf(deps, withProxies('stop')), false);
    expect(rest).toEqual([]);
    expect(result?.id).toBe('proxy');
    expect(result?.level).toBe('warn');
    expect(result?.text).toContain('not checked');
    expect(result?.text).toContain('--home DIR');
    expect(deps.fetched).toEqual([]);
  });

  it('has nothing to skip when no proxy is in use', async () => {
    const deps = await initialized();
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), false);
    expect(results).toEqual([{ id: 'proxy', level: 'ok', text: 'no proxy is in use' }]);
  });

  describe('in the doctor command, by where the config comes from', () => {
    const PROXY_URL = 'http://127.0.0.1:8787/v1/health';

    const nodeWithProxy = async (cwd: string): Promise<FakeDeps> => {
      const deps = await initialized({
        cwd,
        fetch: () => ok({ status: 200 }),
        git: { committed: [`${HOME}/.factory`] },
      });
      deps.seedDir(`${HOME}/.factory/.git`);
      writeConfig(deps, { ...withProxies('stop'), projects: [] });
      return deps;
    };

    const run = async (deps: FakeDeps, home: string | undefined) => {
      const result = await runDoctor(deps, { home });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    it('sends the request when the home comes from --home', async () => {
      const deps = await nodeWithProxy('/elsewhere');
      const output = await run(deps, HOME);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(levelOf(output.json['checks'] as CheckResult[], 'proxy:local')).toBe('ok');
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
    });

    it('sends the request when the config is in the current folder', async () => {
      const deps = await nodeWithProxy(HOME);
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(levelOf(output.json['checks'] as CheckResult[], 'proxy:local')).toBe('ok');
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
    });

    it('sends no request when the config is in a parent folder, and warns', async () => {
      const deps = await nodeWithProxy(`${HOME}/deep/er`);
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([]);
      const proxy = (output.json['checks'] as CheckResult[]).find((result) => result.id === 'proxy');
      expect(proxy?.level).toBe('warn');
      expect(proxy?.text).toContain('--home DIR');
      expect(output.lines.some((line) => line.level === 'warn' && line.text.includes('--home DIR'))).toBe(true);
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
      expect(output.failed).toBe(false);
    });
  });
});

describe('doctor: tools', () => {
  it('fails for Node.js older than 22', async () => {
    const result = await checkTools(makeDeps({ nodeVersion: 'v20.11.1' }));
    expect(result).toMatchObject({ id: 'tools', level: 'fail' });
    expect(result.text).toContain('Node.js 22');
  });

  it('is ok when all programs are on PATH', async () => {
    expect((await checkTools(makeDeps())).level).toBe('ok');
  });

  it('warns for a missing program and names the commands that need it', async () => {
    const result = await checkTools(makeDeps({ tools: ['git', 'claude'] }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('tmux (the lane commands)');
    expect(result.text).toContain('gh (the GitHub commands)');
    expect(result.text).not.toContain('git (');
  });

  it('warns for every program when PATH is empty', async () => {
    const result = await checkTools(makeDeps({ env: { PATH: undefined } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('git (');
  });
});

describe('doctor: state repository', () => {
  it('fails when the state folder is not a git repository', async () => {
    const deps = await initialized();
    expect(await checkStateRepo(deps, HOME)).toMatchObject({ id: 'state-repo', level: 'fail' });
  });

  it('is ok with a commit and an identity', async () => {
    const deps = await initialized({ git: { committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    expect((await checkStateRepo(deps, HOME)).level).toBe('ok');
  });

  it('warns about a missing commit and a missing identity, and repeats both', async () => {
    const deps = await initialized({ git: { identity: false } });
    deps.seedDir(`${HOME}/.factory/.git`);
    const result = await checkStateRepo(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('no commit yet');
    expect(result.text).toContain('no git identity');
  });

  it('warns when git is missing', async () => {
    const deps = await initialized({ tools: ['tmux'] });
    deps.seedDir(`${HOME}/.factory/.git`);
    expect((await checkStateRepo(deps, HOME)).text).toContain('git is missing');
  });
});

describe('doctor: projects', () => {
  const withProject = (deps: FakeDeps) => {
    writeConfig(deps, sampleConfig());
    return inspectConfig(deps, HOME);
  };

  it('is ok when each project path is a git work tree', async () => {
    const deps = makeDeps({ git: { repos: { '/w/web': {} } } });
    expect(await checkProjects(deps, HOME, await withProject(deps))).toMatchObject({ id: 'projects', level: 'ok' });
  });

  it('fails and names the project when the path is not a git work tree', async () => {
    const deps = makeDeps();
    const result = await checkProjects(deps, HOME, await withProject(deps));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('web (../web)');
  });

  it('is ok for a config without projects, and warns when the config is not valid', async () => {
    const deps = await initialized();
    expect((await checkProjects(deps, HOME, await inspectConfig(deps, HOME))).text).toBe('no project is configured');
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect((await checkProjects(deps, HOME, await inspectConfig(deps, HOME))).level).toBe('warn');
  });
});

describe('doctor: the command', () => {
  it('passes on a fresh node: no failure, so it is not failed', async () => {
    const deps = await initialized({ git: { committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    const output = await doctor(deps);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ schema: 'factory.doctor/v1', ok: true, home: HOME });
    const ids = (output.json['checks'] as CheckResult[]).map((result) => result.id);
    expect(ids).toEqual([
      'config',
      'config-version',
      'state',
      'blocks',
      'secrets',
      'permission-mode',
      'proxy-env',
      'proxy',
      'tools',
      'state-repo',
      'projects',
    ]);
    expect(output.lines.at(-1)?.text).toBe('11 ok, 0 warnings, 0 failures');
  });

  it('is failed when one check fails, and not failed for warnings only', async () => {
    const warned = await initialized({ env: { ANTHROPIC_BASE_URL: 'http://x' } });
    warned.seedDir(`${HOME}/.factory/.git`);
    const warnedOutput = await doctor(warned);
    expect(warnedOutput.json['summary']).toMatchObject({ fail: 0 });
    expect(warnedOutput.failed).toBe(false);

    const broken = await initialized();
    broken.files.set(`${HOME}/factory.yaml`, 'schema: 1\n');
    const output = await doctor(broken);
    expect(output.failed).toBe(true);
    expect(levelOf(output.json['checks'] as CheckResult[], 'config')).toBe('fail');
  });

  it('prints one line for each check with its level, and never an environment value', async () => {
    const deps = await initialized({ env: { ANTHROPIC_BASE_URL: 'http://user:topsecret@h:1', GH_TOKEN: 'ghp_zzzzzzzzzzzz' } });
    const output = await doctor(deps);
    const text = JSON.stringify(output);
    expect(text).not.toContain('topsecret');
    expect(text).not.toContain('ghp_zzzz');
    expect(output.lines.filter((line) => line.level !== 'text')).toHaveLength(11);
  });

  it('finds the node by walking up from the current folder', async () => {
    const deps = await initialized();
    const inside = createFakeDeps({ cwd: `${HOME}/deep/er` });
    for (const [path, text] of deps.files) inside.seed(path, text);
    for (const dir of deps.dirs) inside.seedDir(dir);
    inside.seedDir(`${HOME}/deep/er`);
    const result = await runDoctor(inside, { home: undefined });
    expect(result.ok && result.value.json['home']).toBe(HOME);
  });

  it('fails when no config file is found and no home is given', async () => {
    const result = await runDoctor(createFakeDeps({ cwd: '/empty' }), { home: undefined });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!result.ok) expect(result.error.hint).toContain('--home DIR');
  });

  it('fails when the home is not a folder', async () => {
    const deps = makeDeps();
    deps.seed('/w/file', 'x');
    expect(await runDoctor(deps, { home: '/w/file' })).toMatchObject({ ok: false });
    expect(await runDoctor(deps, { home: '/w/none' })).toMatchObject({ ok: false });
  });

  it('reports a failing run of git as a warning, not as a crash', async () => {
    const deps = await initialized();
    deps.seedDir(`${HOME}/.factory/.git`);
    const broken = { ...deps, run: async () => failure('cannot run git: EACCES') };
    const result = await runDoctor(broken, { home: HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'state-repo')).toBe('warn');
    expect(result.value.failed).toBe(false);
  });
});
