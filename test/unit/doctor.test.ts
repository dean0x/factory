import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import {
  checkBlocks,
  checkChildren,
  checkConfig,
  checkConfigVersion,
  checkHome,
  checkIndex,
  checkNodeBlocks,
  checkPermissionMode,
  checkProjects,
  checkProxies,
  checkProxyEnv,
  checkRoles,
  checkSecrets,
  checkState,
  checkStateRepo,
  checkTools,
  checkTracker,
  proxyRequestRule,
  runDoctor,
  type CheckResult,
  type ProxyRequestRule,
} from '../../src/commands/doctor.js';
import { checkHomeLocation } from '../../src/commands/init-home.js';
import { runInit } from '../../src/commands/init.js';
import { inspectConfig } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { inspectState } from '../../src/state/load.js';
import { layer1Blocks, layer2Blocks } from '../helpers/blocks.js';
import { createFakeDeps, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/w/node';
const TOOLS = ['git', 'tmux', 'gh', 'claude'];

interface Setup {
  readonly env?: Record<string, string | undefined>;
  readonly git?: GitFixture;
  readonly tmux?: TmuxFixture;
  readonly nodeVersion?: string;
  readonly fetch?: FetchHandler;
  readonly tools?: readonly string[];
  readonly cwd?: string;
  readonly os?: string;
  readonly links?: Record<string, string>;
}

const makeDeps = (setup: Setup = {}): FakeDeps => {
  const git = gitHandler(setup.git ?? {});
  const tmux = tmuxHandler(setup.tmux);
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w',
    env: { PATH: '/bin', ...setup.env },
    run: (call) => (call.command === 'tmux' ? tmux.handler(call) : git.handler(call)),
    nodeVersion: setup.nodeVersion ?? 'v22.5.0',
    ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    ...(setup.os === undefined ? {} : { os: setup.os }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
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
    yes: false,
    recipe: undefined,
    layer: undefined,
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
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 3\n');
    const newer = await inspectConfig(deps, HOME);
    expect(checkConfig(newer).level).toBe('ok');
    expect(checkConfigVersion(newer)).toMatchObject({ level: 'fail' });
    expect(checkConfigVersion(newer).text).toContain('Upgrade factory.');

    deps.files.set(`${HOME}/factory.yaml`, 'a: [1\n');
    expect(checkConfigVersion(await inspectConfig(deps, HOME)).level).toBe('warn');
  });

  it('fails the version check for a schema 1 file and points to the upgrade command', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 1\n');
    const older = await inspectConfig(deps, HOME);
    expect(checkConfigVersion(older)).toMatchObject({ level: 'fail' });
    expect(checkConfigVersion(older).text).toContain('factory upgrade');
  });

  it('fails the state check for a missing, broken or newer node.json', async () => {
    const deps = await initialized();
    const path = `${HOME}/.factory/node.json`;
    const original = deps.files.get(path) ?? '';

    deps.files.delete(path);
    expect(checkState(await inspectState(deps, HOME))).toMatchObject({ level: 'fail', text: '.factory/node.json not found' });
    deps.files.set(path, '{');
    expect(checkState(await inspectState(deps, HOME)).level).toBe('fail');
    deps.files.set(path, original.replace(/"schema_version": \d+/, '"schema_version": 5'));
    const newer = checkState(await inspectState(deps, HOME));
    expect(newer.level).toBe('fail');
    expect(newer.text).toContain('Upgrade factory.');
  });
});

describe('doctor: blocks', () => {
  it('is ok when all managed blocks are intact', async () => {
    const deps = await initialized();
    expect(checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks))).toMatchObject({
      id: 'blocks',
      level: 'ok',
      text: '3 managed blocks are intact',
    });
  });

  it('warns when a block was edited by hand, and names it', async () => {
    const deps = await initialized();
    const path = `${HOME}/CLAUDE.md`;
    deps.files.set(path, (deps.files.get(path) ?? '').replace('Coordinate. Do not produce.', 'Do as you like.'));
    const result = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('coordinator (edited');
    expect(result.text).not.toContain('safety');
  });

  it('warns when a block or its file is missing, and when the markers are broken', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/.factory/roles/worker.md`);
    const missing = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(missing.level).toBe('warn');
    expect(missing.text).toContain('worker (missing');

    deps.files.set(`${HOME}/CLAUDE.md`, '<!-- factory:begin x v1 sha256=zz -->\n');
    const broken = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(broken.text).toContain('coordinator (malformed');
    expect(broken.text).toContain('safety (malformed');
  });

  it('keeps the text of the owner out of the verdict', async () => {
    const deps = await initialized();
    const path = `${HOME}/CLAUDE.md`;
    deps.files.set(path, `My own rules.\n\n${deps.files.get(path) ?? ''}\nMore of my rules.\n`);
    expect(checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks)).level).toBe('ok');
  });
});

describe('doctor: the blocks of a layer', () => {
  const setLayer = (deps: FakeDeps, layer: number): void => {
    const path = `${HOME}/factory.yaml`;
    deps.files.set(path, (deps.files.get(path) ?? '').replace('layer: 1', `layer: ${layer}`));
  };

  const nodeBlocks = async (deps: FakeDeps) => checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));

  it('checks the coordinator, safety and worker blocks of a node on layer 1', async () => {
    const deps = await initialized();
    expect(await nodeBlocks(deps)).toMatchObject({ id: 'blocks', level: 'ok', text: '3 managed blocks are intact' });
  });

  it('warns that the role block does not match when the layer was changed by hand', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    const result = await nodeBlocks(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('coordinator (intact, in /w/node/CLAUDE.md)');
    expect(result.text).toContain('needs the block manager');
  });

  it('is ok for the blocks of layer 2: manager and safety', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    const path = `${HOME}/CLAUDE.md`;
    const blocks = layer2Blocks.map((block) => {
      const rendered = renderBlock(block);
      if (!rendered.ok) throw new Error(rendered.error.message);
      return rendered.value;
    });
    deps.files.set(path, `${blocks.join('\n\n')}\n`);
    expect(await nodeBlocks(deps)).toMatchObject({ level: 'ok', text: '2 managed blocks are intact' });
  });

  it('does not check the blocks when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(await nodeBlocks(deps)).toMatchObject({ id: 'blocks', level: 'warn', text: 'not checked: factory.yaml is not valid' });
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
    const sample = sampleConfig();
    const project = { ...sample.recipe.projects[0]!, heavy_test: `curl -H ${secret}` };
    writeConfig(deps, { ...sample, recipe: { ...sample.recipe, projects: [project] } });
    const result = checkSecrets(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('recipe.projects.0.heavy_test');
    expect(result.text).not.toContain('ghp_');
  });

  describe('the address of a node link', () => {
    const withLinks = (parent: string, child: string): FactoryConfig => {
      const config = sampleConfig();
      return {
        ...config,
        core: {
          ...config.core,
          node: { id: 'mgr', layer: 2 },
          parent: { id: 'up', address: parent },
          children: [{ id: 'web', address: child }],
        },
      };
    };

    it('is ok for a long file address of this machine', async () => {
      const deps = await initialized();
      const address = 'file:///Users/Dean/Work/payments-team-factory-2';
      writeConfig(deps, withLinks(address, address));
      expect(checkSecrets(await inspectConfig(deps, HOME))).toMatchObject({ id: 'secrets', level: 'ok' });
    });

    it('fails and names the key when the address holds a token, never the value', async () => {
      const deps = await initialized();
      writeConfig(deps, withLinks('file:///w/up', `file:///Users/Dean/${secret}`));
      const result = checkSecrets(await inspectConfig(deps, HOME));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('children.0.address');
      expect(result.text).not.toContain('ghp_');
    });
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

  describe('the user settings folder of Claude Code, written in another way', () => {
    const USER_SETTINGS = '/users/me/.claude';
    const BYPASS = '{"permissions":{"defaultMode":"bypassPermissions"}}';

    /** Deps that count every list and read inside a settings folder. */
    const watched = (deps: FakeDeps) => {
      const touched: string[] = [];
      const guarded = {
        ...deps,
        fs: {
          ...deps.fs,
          list: async (path: string) => {
            touched.push(path);
            return deps.fs.list(path);
          },
          readText: async (path: string) => {
            touched.push(path);
            return deps.fs.readText(path);
          },
        },
      };
      return { guarded, touched };
    };

    it('skips a settings folder that is a link to the user settings folder', async () => {
      const deps = makeDeps({ env: { HOME: '/users/me' }, links: { [`${HOME}/.claude`]: USER_SETTINGS } });
      deps.seedDir(`${HOME}/.claude`);
      deps.seed(`${USER_SETTINGS}/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const result = await checkPermissionMode(guarded, HOME);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
      expect(touched).toEqual([]);
    });

    it('skips a settings folder in other letter case on macOS', async () => {
      const deps = makeDeps({ env: { HOME: '/users/me' }, os: 'darwin' });
      deps.seed(`/Users/Me/.claude/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const result = await checkPermissionMode(guarded, '/Users/Me');
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
      expect(touched).toEqual([]);
    });

    it('compares the letters exactly on the other platforms', async () => {
      const deps = makeDeps({ env: { HOME: '/users/me' }, os: 'linux' });
      deps.seed(`/Users/Me/.claude/settings.json`, BYPASS);
      expect((await checkPermissionMode(deps, '/Users/Me')).level).toBe('fail');
    });

    it('skips a settings folder below the user settings folder', async () => {
      const deps = makeDeps({ env: { HOME: '/users/me' } });
      deps.seed(`${USER_SETTINGS}/node/.claude/settings.json`, BYPASS);
      const result = await checkPermissionMode(deps, `${USER_SETTINGS}/node`);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
    });

    it('warns and reads nothing when it cannot resolve the links of the paths', async () => {
      const deps = makeDeps({ env: { HOME: '/users/me' } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      const denied = { ...deps, fs: { ...deps.fs, realpath: async () => failure('cannot resolve /: EACCES') } };
      const { guarded, touched } = watched(denied as FakeDeps);
      const result = await checkPermissionMode(guarded, HOME);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('EACCES');
      expect(touched).toEqual([]);
    });
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
  const withProxies = (onFail: 'stop' | 'direct', cells: FactoryConfig['core']['cells'] = {}): FactoryConfig => {
    const sample = sampleConfig();
    return {
      ...sample,
      core: {
        ...sample.core,
        session: { ...sample.core.session, proxy: 'local' },
        proxies: [
          { id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: onFail },
          { id: 'spare', base_url: 'http://127.0.0.1:9999', health: '/health', on_fail: 'stop' },
        ],
        cells,
      },
    };
  };

  const stateOf = async (deps: FakeDeps, config: FactoryConfig) => {
    writeConfig(deps, config);
    return inspectConfig(deps, HOME);
  };

  const MAY: ProxyRequestRule = { may: true };

  it('says that no proxy is in use when the session names none', async () => {
    const deps = await initialized();
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), MAY);
    expect(results).toEqual([{ id: 'proxy', level: 'ok', text: 'no proxy is in use' }]);
  });

  it('is ok when the proxy answers below 500, and sends one request to the health URL', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 404 }) });
    const results = await checkProxies(deps, await stateOf(deps, withProxies('stop')), MAY);
    expect(results).toEqual([{ id: 'proxy:local', level: 'ok', text: 'local (127.0.0.1:8787) answers' }]);
    expect(deps.fetched).toEqual(['http://127.0.0.1:8787/v1/health']);
  });

  it('fails when the proxy is down and on_fail is stop', async () => {
    const deps = makeDeps();
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('stop')), MAY);
    expect(result?.level).toBe('fail');
    expect(result?.text).toContain('local (127.0.0.1:8787) does not answer');
  });

  it('warns when the proxy is down and on_fail is direct', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 500 }) });
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('direct')), MAY);
    expect(result?.level).toBe('warn');
    expect(result?.text).toContain('on_fail is direct');
  });

  it('checks a proxy that only a cell uses, and skips a proxy that nothing uses', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 200 }) });
    const used = withProxies('stop', { 'web-cell': { proxy: 'spare' } });
    const config = { ...used, core: { ...used.core, session: { ...sampleConfig().core.session } } };
    const results = await checkProxies(deps, await stateOf(deps, config), MAY);
    expect(results.map((result) => result.id)).toEqual(['proxy:spare']);
  });

  it('warns that it did not check when the config is not valid', async () => {
    const deps = makeDeps();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 1\n');
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), MAY);
    expect(results).toEqual([{ id: 'proxy', level: 'warn', text: 'not checked: factory.yaml is not valid' }]);
  });

  it('sends no request when it may not, and gives the reason', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 200 }) });
    const rule: ProxyRequestRule = { may: false, reason: 'a reason' };
    const results = await checkProxies(deps, await stateOf(deps, withProxies('stop')), rule);
    expect(results).toEqual([{ id: 'proxy', level: 'warn', text: 'not checked: a reason' }]);
    expect(deps.fetched).toEqual([]);
  });

  it('has nothing to skip when no proxy is in use', async () => {
    const deps = await initialized();
    const results = await checkProxies(deps, await inspectConfig(deps, HOME), { may: false, reason: 'a reason' });
    expect(results).toEqual([{ id: 'proxy', level: 'ok', text: 'no proxy is in use' }]);
  });

  describe('the rule for a request', () => {
    const accepted = ok(undefined);

    it.each(['flag', 'cwd'] as const)('allows the request for a home from %s that the up command accepts', (source) => {
      expect(proxyRequestRule(source, accepted)).toEqual({ may: true });
    });

    it.each(['env', 'ancestor', 'index'] as const)('tells the user to give the home when it comes from %s', (source) => {
      const rule = proxyRequestRule(source, accepted);
      expect(rule.may).toBe(false);
      if (!rule.may) expect(rule.reason).toContain('--home DIR');
    });

    it.each(['flag', 'cwd', 'env'] as const)('refuses the request for a home that fails the place check, from %s', (source) => {
      const rule = proxyRequestRule(source, failure('the node home /w/node is inside the git work tree /w'));
      expect(rule).toEqual({
        may: false,
        reason: 'the node home /w/node is inside the git work tree /w, so factory sends no request',
      });
    });
  });

  describe('in the doctor command, by where the config comes from', () => {
    const PROXY_URL = 'http://127.0.0.1:8787/v1/health';

    const nodeWithProxy = async (cwd: string, env: Setup['env'] = {}): Promise<FakeDeps> => {
      const deps = await initialized({
        cwd,
        env,
        fetch: () => ok({ status: 200 }),
        git: { committed: [`${HOME}/.factory`] },
      });
      deps.seedDir(`${HOME}/.factory/.git`);
      const proxied = withProxies('stop');
      writeConfig(deps, { ...proxied, recipe: { ...proxied.recipe, projects: [] } });
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

    it('sends no request when only FACTORY_HOME names the home, and warns', async () => {
      const deps = await nodeWithProxy('/elsewhere', { FACTORY_HOME: HOME });
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([]);
      const proxy = (output.json['checks'] as CheckResult[]).find((result) => result.id === 'proxy');
      expect(proxy?.level).toBe('warn');
      expect(proxy?.text).toContain('--home DIR');
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
    });

    it('sends the request when FACTORY_HOME names the current folder', async () => {
      const deps = await nodeWithProxy(HOME, { FACTORY_HOME: HOME });
      await run(deps, undefined);
      expect(deps.fetched).toEqual([PROXY_URL]);
    });

    it('takes --home before FACTORY_HOME, and sends the request', async () => {
      const deps = await nodeWithProxy('/elsewhere', { FACTORY_HOME: '/not/a/node' });
      const output = await run(deps, HOME);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
    });

    describe('when the home is in a place that the up command refuses', () => {
      /** The files of a node with a proxy, copied into deps where a git work tree holds /w. */
      const inWorkTree = async (cwd: string): Promise<FakeDeps> => {
        const made = await nodeWithProxy(cwd);
        const deps = makeDeps({
          cwd,
          fetch: () => ok({ status: 200 }),
          git: { repos: { '/w': {} }, committed: [`${HOME}/.factory`] },
        });
        for (const dir of made.dirs) deps.seedDir(dir);
        for (const [path, text] of made.files) deps.seed(path, text);
        return deps;
      };

      /** The same files, with the config of another node home in the parent folder. */
      const inNodeHome = async (cwd: string): Promise<FakeDeps> => {
        const deps = await nodeWithProxy(cwd);
        deps.seed('/w/factory.yaml', 'schema: 2\n');
        return deps;
      };

      it.each([
        ['the current folder', HOME, undefined],
        ['--home', '/elsewhere', HOME],
      ])('sends no request for a home inside a git work tree that comes from %s, and the home check fails', async (_name, cwd, home) => {
        const deps = await inWorkTree(cwd);
        const output = await run(deps, home);
        expect(deps.fetched).toEqual([]);
        const checks = output.json['checks'] as CheckResult[];
        expect(levelOf(checks, 'home')).toBe('fail');
        const proxy = checks.find((result) => result.id === 'proxy');
        expect(proxy?.level).toBe('warn');
        expect(proxy?.text).toContain('not checked');
        expect(proxy?.text).toContain('is inside the git work tree /w');
        expect(output.failed).toBe(true);
      });

      it.each([
        ['the current folder', HOME, undefined],
        ['--home', '/elsewhere', HOME],
      ])('sends no request for a home inside another node home that comes from %s, and the home check fails', async (_name, cwd, home) => {
        const deps = await inNodeHome(cwd);
        const output = await run(deps, home);
        expect(deps.fetched).toEqual([]);
        const checks = output.json['checks'] as CheckResult[];
        expect(levelOf(checks, 'home')).toBe('fail');
        const proxy = checks.find((result) => result.id === 'proxy');
        expect(proxy?.level).toBe('warn');
        expect(proxy?.text).toContain('is inside another node home');
      });

      it('reports that no proxy is in use when none is, even for a refused home', async () => {
        const deps = await inWorkTree(HOME);
        deps.files.set(`${HOME}/factory.yaml`, renderConfig(sampleConfig()));
        const output = await run(deps, undefined);
        const checks = output.json['checks'] as CheckResult[];
        expect(checks.find((result) => result.id === 'proxy')).toEqual({ id: 'proxy', level: 'ok', text: 'no proxy is in use' });
      });
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
    expect(result.text).toContain('tmux (the "factory up" command)');
    expect(result.text).toContain('gh (the GitHub commands)');
    expect(result.text).not.toContain('git (');
  });

  it.each([['tmux 3.0'], ['tmux 3.5a'], ['tmux next-3.7'], ['tmux 4.1']])('is ok for %s', async (version) => {
    expect(await checkTools(makeDeps({ tmux: { version } }))).toMatchObject({ id: 'tools', level: 'ok' });
  });

  it.each([
    ['tmux 2.9a', 'tmux 2.9'],
    ['tmux 1.8', 'tmux 1.8'],
    ['tmux 2.99', 'tmux 2.99'],
  ])('warns for %s and names the up command', async (version, shown) => {
    const result = await checkTools(makeDeps({ tmux: { version } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`${shown} is older than 3.0`);
    expect(result.text).toContain('"factory up"');
  });

  it('warns when the version of tmux cannot be read', async () => {
    const result = await checkTools(makeDeps({ tmux: { version: 'tmux master' } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('cannot read the version of tmux');
  });

  it('does not read the version of a tmux that is missing, and names it once', async () => {
    const result = await checkTools(makeDeps({ tools: ['git', 'gh', 'claude'] }));
    expect(result.text.match(/tmux/g)).toHaveLength(1);
  });

  it('keeps the failure for Node.js older than 22 before any other result', async () => {
    const result = await checkTools(makeDeps({ nodeVersion: 'v20.1.0', tmux: { version: 'tmux 1.8' } }));
    expect(result.level).toBe('fail');
  });

  it('warns for every program when PATH is empty', async () => {
    const result = await checkTools(makeDeps({ env: { PATH: undefined } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('git (');
  });
});

describe('doctor: the home', () => {
  const validConfig = (deps: FakeDeps) => inspectConfig(deps, HOME);

  const homeCheck = async (deps: FakeDeps) =>
    checkHome(deps, HOME, await validConfig(deps), await checkHomeLocation(deps, HOME));

  /** A node that init made, seen by a git that finds a work tree at /w. Init refuses this place, so the files are copied. */
  const inRepo = async (): Promise<FakeDeps> => {
    const made = await initialized();
    const deps = makeDeps({ git: { repos: { '/w': {} } } });
    for (const dir of made.dirs) deps.seedDir(dir);
    for (const [path, text] of made.files) deps.seed(path, text);
    return deps;
  };

  it('is ok for a home outside every work tree and every other home, apart from the projects', async () => {
    const deps = await initialized();
    expect(await homeCheck(deps)).toEqual({
      id: 'home',
      level: 'ok',
      text: 'the node home is outside every git work tree and every other node home, and holds no git repo one level down, and is apart from its projects',
    });
  });

  it('fails when the home is inside a git work tree', async () => {
    const deps = await inRepo();
    const result = await homeCheck(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('is inside the git work tree /w');
  });

  it('fails when the home holds a git repo one level down, and not for its own state folder', async () => {
    const own = makeDeps({ git: { repos: { [`${HOME}/.factory`]: {} } } });
    const made = await initialized();
    for (const dir of made.dirs) own.seedDir(dir);
    for (const [path, text] of made.files) own.seed(path, text);
    own.seedDir(`${HOME}/.factory/.git`);
    expect((await homeCheck(own)).level).toBe('ok');

    const holding = makeDeps({ git: { repos: { [`${HOME}/.factory`]: {}, [`${HOME}/web`]: {} } } });
    for (const dir of made.dirs) holding.seedDir(dir);
    for (const [path, text] of made.files) holding.seed(path, text);
    holding.seedDir(`${HOME}/.factory/.git`);
    holding.seedDir(`${HOME}/web/.git`);
    const result = await homeCheck(holding);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('holds the git repo web one level down');
  });

  it('fails when the home is inside another node home', async () => {
    const deps = await initialized();
    deps.seed('/w/factory.yaml', 'schema: 2\n');
    const result = await homeCheck(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('is inside another node home');
  });

  it.each([
    ['a project inside the home', 'sub'],
    ['the home as a project', '.'],
  ])('fails for %s', async (_name, path) => {
    const deps = await initialized();
    const config = sampleConfig();
    const project = { ...config.recipe.projects[0]!, path };
    writeConfig(deps, { ...config, recipe: { ...config.recipe, projects: [project] }, core: { ...config.core, node: { id: 'demo', layer: 1 } } });
    const result = await homeCheck(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('is the project folder');
  });

  it('checks the place of the home when the config is not valid, and says that the projects are not checked', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect(await homeCheck(deps)).toMatchObject({
      level: 'ok',
      text: expect.stringContaining('the projects are not checked'),
    });
    const inside = await inRepo();
    inside.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect((await homeCheck(inside)).level).toBe('fail');
  });
});

describe('doctor: the role of the layer', () => {
  const stateWithLayer = async (layer: number) => {
    const deps = await initialized();
    const config = sampleConfig();
    writeConfig(deps, { ...config, core: { ...config.core, node: { id: 'demo', layer } } });
    return inspectConfig(deps, HOME);
  };

  it.each([
    [1, 'coordinator'],
    [2, 'manager'],
  ])('is ok for layer %i, and names the role template', async (layer, role) => {
    expect(checkRoles(await stateWithLayer(layer))).toEqual({
      id: 'roles',
      level: 'ok',
      text: `layer ${layer} has the ${role} role template`,
    });
  });

  it.each([3, 16])('warns for layer %i, which has no role template, and names the layer', async (layer) => {
    const result = checkRoles(await stateWithLayer(layer));
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`layer ${layer} has no role template`);
    expect(result.text).toContain('safety block only');
  });

  it('is not checked when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect(checkRoles(await inspectConfig(deps, HOME))).toMatchObject({ level: 'warn', text: expect.stringContaining('not checked') });
  });

  it('shows in the doctor run of a layer-3 node as a warning, not as a failure', async () => {
    const deps = await initialized({ git: { committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    const text = deps.files.get(`${HOME}/factory.yaml`) ?? '';
    expect(text).toContain('layer: 1');
    deps.files.set(`${HOME}/factory.yaml`, text.replace('layer: 1', 'layer: 3'));
    const output = await doctor(deps);
    const checks = output.json['checks'] as CheckResult[];
    expect(levelOf(checks, 'roles')).toBe('warn');
    expect(output.failed).toBe(false);
  });
});

describe('doctor: the home index', () => {
  const INDEX = '/state/factory/homes.json';
  const env = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
  const indexOf = (...homes: string[]): string =>
    JSON.stringify({ schema: 1, homes: homes.map((home, i) => ({ home, id: `h${i}`, projects: ['/w/web'] })) });

  it('is ok when no variable names a folder for the index', async () => {
    expect(await checkIndex(makeDeps(), HOME)).toMatchObject({ id: 'index', level: 'ok', text: expect.stringContaining('no home index is used') });
  });

  it('is ok when this home is in the index and every home in it is present', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf(HOME));
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await checkIndex(deps, HOME)).toMatchObject({ level: 'ok', text: '1 entry in the home index, all present' });
  });

  it('warns when there is no index file yet, because this home is not in it', async () => {
    const deps = makeDeps({ env });
    const result = await checkIndex(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(HOME);
    expect(result.text).toContain(INDEX);
  });

  it('warns when the index lists other homes but not this one, and says how to fix it', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf('/w/other'));
    deps.seed('/w/other/factory.yaml', 'schema: 2\n');
    const result = await checkIndex(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`does not list ${HOME}`);
    expect(result.text).toContain('--home DIR');
    expect(result.text).toContain(INDEX);
  });

  it('finds this home in the index by its real path', async () => {
    const deps = makeDeps({ env, links: { '/link': '/real' } });
    deps.seed(INDEX, indexOf('/real/node'));
    deps.seed('/real/node/factory.yaml', 'schema: 2\n');
    deps.seedDir('/link/node');
    expect((await checkIndex(deps, '/link/node')).level).toBe('ok');
  });

  it('ignores the case of letters on macOS when it looks for this home, and not on other systems', async () => {
    for (const [os, level] of [['darwin', 'ok'], ['linux', 'warn']] as const) {
      const deps = makeDeps({ env, os });
      deps.seed(INDEX, indexOf('/w/NODE'));
      deps.seed('/w/NODE/factory.yaml', 'schema: 2\n');
      expect((await checkIndex(deps, '/w/node')).level).toBe(level);
    }
  });

  it('names both problems in one warning', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf('/w/gone'));
    const result = await checkIndex(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('/w/gone');
    expect(result.text).toContain(`does not list ${HOME}`);
  });

  it('warns on an entry whose home is gone, and names the home and the file', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf(HOME, '/w/gone'));
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    const result = await checkIndex(deps, HOME);
    expect(result).toMatchObject({ level: 'warn' });
    expect(result.text).toContain('/w/gone');
    expect(result.text).not.toContain(`${HOME},`);
    expect(result.text).toContain(INDEX);
  });

  it('warns when the file cannot be read', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, 'broken');
    expect(await checkIndex(deps, HOME)).toMatchObject({ level: 'warn', text: expect.stringContaining(`${INDEX} cannot be read`) });
  });

  it('warns when the place of the index is inside the folder of Claude Code', async () => {
    const deps = makeDeps({ env: { HOME: '/users/me', XDG_STATE_HOME: '/users/me/.claude/state' } });
    expect(await checkIndex(deps, HOME)).toMatchObject({ level: 'warn' });
  });

  it('warns in the command when the index does not list the home', async () => {
    const deps = await initialized({ env });
    deps.files.delete(INDEX);
    const result = await runDoctor(deps, { home: HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'index')).toBe('warn');
  });

  it('is ok in the command right after init, because init lists the home', async () => {
    const deps = await initialized({ env });
    const result = await runDoctor(deps, { home: HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'index')).toBe('ok');
  });

  it('runs from a project folder through the index, and sends no network request', async () => {
    const config = (await initialized()).files.get(`${HOME}/factory.yaml`) ?? '';
    const deps = makeDeps({ env, cwd: '/w/web/src', fetch: () => ok({ status: 200 }) });
    deps.seedDir('/w/web/src');
    deps.seed(INDEX, indexOf(HOME));
    deps.seed(
      `${HOME}/factory.yaml`,
      config.replace('proxy: none', 'proxy: local').replace('proxies: []', 'proxies:\n  - id: local\n    base_url: "http://127.0.0.1:8787"\n    health: /health\n    on_fail: stop'),
    );
    const result = await runDoctor(deps, { home: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.json['home']).toBe(HOME);
    expect(deps.fetched).toEqual([]);
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'proxy')).toBe('warn');
  });
});

describe('doctor: the tracker', () => {
  const hosted = (kind: 'github' | 'jira'): FactoryConfig => {
    const config = sampleConfig();
    return { ...config, core: { ...config.core, tracker: { kind, items: 'acme/items', decisions: 'acme/decisions', watch_interval: '5m' } } };
  };

  it('is ok for the local tracker', async () => {
    const deps = await initialized();
    expect(checkTracker(await inspectConfig(deps, HOME))).toEqual({
      id: 'tracker',
      level: 'ok',
      text: 'tracker.kind is local',
    });
  });

  it.each([['github'], ['jira']] as const)('warns for %s: its connector comes in a later version', async (kind) => {
    const deps = await initialized();
    writeConfig(deps, hosted(kind));
    const result = checkTracker(await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toBe(`tracker.kind is ${kind}: its connector comes in a later version of factory`);
  });

  it('warns that it cannot check when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect(checkTracker(await inspectConfig(deps, HOME)).level).toBe('warn');
  });
});

describe('doctor: the children', () => {
  const layer2With = (children: FactoryConfig['core']['children']): FactoryConfig => {
    const config = sampleConfig();
    return { ...config, core: { ...config.core, node: { id: 'mgr', layer: 2 }, children } };
  };

  const childAt = (deps: FakeDeps, path: string, id: string, layer: number): void => {
    const config = sampleConfig();
    deps.seed(`${path}/factory.yaml`, renderConfig({ ...config, core: { ...config.core, node: { id, layer } } }));
  };

  const probe = async (deps: FakeDeps) => checkChildren(deps, await inspectConfig(deps, HOME));

  it('is ok for a node without children', async () => {
    const deps = await initialized();
    expect(await probe(deps)).toEqual({ id: 'children', level: 'ok', text: 'no child is configured' });
  });

  it('is ok when each child answers and is on the layer below', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }, { id: 'api', address: 'file:///w/api-factory' }]));
    childAt(deps, '/w/web-factory', 'web', 1);
    childAt(deps, '/w/api-factory', 'api', 1);
    expect(await probe(deps)).toEqual({ id: 'children', level: 'ok', text: '2 children answer, all on layer 1' });
  });

  it('warns for a child that is unknown, and names the child and the reason', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }]));
    const result = await probe(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toBe('unknown: web (no factory.yaml found there)');
  });

  it('fails for a child on the wrong layer, and names the layer that is needed', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }]));
    childAt(deps, '/w/web-factory', 'web', 3);
    const result = await probe(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toBe('wrong layer: web is on layer 3, but layer 1 is needed');
  });

  it('fails and lists both problems when one child has the wrong layer and another is unknown', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }, { id: 'api', address: 'file:///w/api-factory' }]));
    childAt(deps, '/w/web-factory', 'web', 2);
    const result = await probe(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('wrong layer: web is on layer 2');
    expect(result.text).toContain('unknown: api (');
  });

  it('fails for a child on layer 1 under a node on layer 1, because cells are layer 0', async () => {
    const deps = makeDeps();
    const config = sampleConfig();
    writeConfig(deps, { ...config, core: { ...config.core, children: [{ id: 'web', address: 'file:///w/web-factory' }] } });
    childAt(deps, '/w/web-factory', 'web', 1);
    expect((await probe(deps)).level).toBe('fail');
  });

  it('warns that it cannot check when the config is not valid', async () => {
    const deps = makeDeps();
    deps.seed(`${HOME}/factory.yaml`, 'x: 1\n');
    expect((await probe(deps)).level).toBe('warn');
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
      'home',
      'index',
      'blocks',
      'roles',
      'tracker',
      'children',
      'secrets',
      'permission-mode',
      'proxy-env',
      'proxy',
      'tools',
      'state-repo',
      'projects',
    ]);
    expect(output.lines.at(-1)?.text).toBe('16 ok, 0 warnings, 0 failures');
  });

  it('is failed when one check fails, and not failed for warnings only', async () => {
    const warned = await initialized({ env: { ANTHROPIC_BASE_URL: 'http://x' } });
    warned.seedDir(`${HOME}/.factory/.git`);
    const warnedOutput = await doctor(warned);
    expect(warnedOutput.json['summary']).toMatchObject({ fail: 0 });
    expect(warnedOutput.failed).toBe(false);

    const broken = await initialized();
    broken.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
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
    expect(output.lines.filter((line) => line.level !== 'text')).toHaveLength(16);
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
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    if (!result.ok) expect(result.error.hint).toContain('--home DIR');
  });

  it('fails when the home is not a folder', async () => {
    const deps = makeDeps();
    deps.seed('/w/file', 'x');
    const file = await runDoctor(deps, { home: '/w/file' });
    expect(file).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!file.ok) expect(file.error.message).toContain('/w/file is not a folder');
    const none = await runDoctor(deps, { home: '/w/none' });
    expect(none).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!none.ok) expect(none.error.message).toContain('/w/none is not a folder');
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
