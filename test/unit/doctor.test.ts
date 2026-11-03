import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import {
  checkBlocks,
  checkChildren,
  checkConfig,
  checkConfigVersion,
  checkIndex,
  checkLocalFile,
  checkNodeBlocks,
  checkPermissionMode,
  checkProjects,
  checkProjectUrls,
  checkProxies,
  checkProxyEnv,
  checkRoles,
  checkRoot,
  checkSecrets,
  checkState,
  checkStateRepo,
  checkTempFolders,
  checkTools,
  checkTracker,
  runDoctor,
  type CheckResult,
} from '../../src/commands/doctor.js';
import { runInit } from '../../src/commands/init.js';
import { inspectConfig } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { inspectState } from '../../src/state/load.js';
import { layer1Blocks, layer2Blocks } from '../helpers/blocks.js';
import { createFakeDeps, registerRoot, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';

const HOME = '/w/node';
const CLAUDE_MD = `${HOME}/coordinator/CLAUDE.md`;
const INDEX_FILE = '/state/factory/homes.json';
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
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
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

/** Write both config files of the root and register the root with the node id of the config. */
const writeConfig = (deps: FakeDeps, config: FactoryConfig): void => {
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
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
    expect(checkConfig(config)).toEqual({ id: 'config', level: 'ok', text: 'factory.yaml and factory.local.yaml are valid' });
    expect(checkConfigVersion(config)).toMatchObject({ id: 'config-version', level: 'ok' });
    expect(checkState(await inspectState(deps, HOME))).toMatchObject({ id: 'state', level: 'ok' });
  });

  it('fails when the config is missing, does not parse or is invalid', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(checkConfig(await inspectConfig(deps, HOME))).toMatchObject({ level: 'fail', text: 'factory.yaml not found' });

    deps.files.set(`${HOME}/factory.yaml`, 'a: [1\n');
    expect(checkConfig(await inspectConfig(deps, HOME))).toMatchObject({ level: 'fail' });

    deps.files.set(`${HOME}/factory.yaml`, renderConfig(sampleConfig()).shared.replace('effort: high', 'effort: wild'));
    const invalid = checkConfig(await inspectConfig(deps, HOME));
    expect(invalid.level).toBe('fail');
    expect(invalid.text).toContain('session.effort');
  });

  it('fails, and names init, when the local file is missing next to the shared file', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/factory.local.yaml`);
    const state = await inspectConfig(deps, HOME);
    const result = checkConfig(state);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('factory.local.yaml not found');
    expect(result.text).toContain('factory init');
    expect(checkConfigVersion(state)).toMatchObject({ level: 'warn', text: 'not checked: factory.local.yaml is not valid' });
  });

  it('fails, and names the local file, when the local file is invalid', async () => {
    const deps = await initialized();
    const path = `${HOME}/factory.local.yaml`;
    deps.files.set(path, (deps.files.get(path) ?? '').replace('proxy: none', 'proxy: nowhere'));
    const result = checkConfig(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('factory.local.yaml is invalid');
    expect(result.text).toContain('session.proxy');
  });

  it('fails, and names the key and the local file, for a local key in the shared file', async () => {
    const deps = await initialized();
    const path = `${HOME}/factory.yaml`;
    deps.files.set(path, `${deps.files.get(path) ?? ''}proxies: []\n`);
    const result = checkConfig(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('proxies: is a local key');
    expect(result.text).toContain('factory.local.yaml');
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
    const path = CLAUDE_MD;
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

    deps.files.set(CLAUDE_MD, '<!-- factory:begin x v1 sha256=zz -->\n');
    const broken = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(broken.text).toContain('coordinator (malformed');
    expect(broken.text).toContain('safety (malformed');
  });

  it('keeps the text of the owner out of the verdict', async () => {
    const deps = await initialized();
    const path = CLAUDE_MD;
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
    expect(result.text).toContain('coordinator (intact, in /w/node/coordinator/CLAUDE.md)');
    expect(result.text).toContain('needs the block manager');
  });

  it('is ok for the blocks of layer 2: manager and safety', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    const path = CLAUDE_MD;
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
      const address = 'file:///Users/example/Work/payments-team-factory-2';
      writeConfig(deps, withLinks(address, address));
      expect(checkSecrets(await inspectConfig(deps, HOME))).toMatchObject({ id: 'secrets', level: 'ok' });
    });

    it('fails and names the key when the address holds a token, never the value', async () => {
      const deps = await initialized();
      writeConfig(deps, withLinks('file:///w/up', `file:///Users/example/${secret}`));
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
    const USER_SETTINGS = '/users/example/.claude';
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
      const deps = makeDeps({ env: { HOME: '/users/example' }, links: { [`${HOME}/.claude`]: USER_SETTINGS } });
      deps.seedDir(`${HOME}/.claude`);
      deps.seed(`${USER_SETTINGS}/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const result = await checkPermissionMode(guarded, HOME);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
      expect(touched).toEqual([]);
    });

    it('skips a settings folder in other letter case on macOS', async () => {
      const deps = makeDeps({ env: { HOME: '/users/example' }, os: 'darwin' });
      deps.seed(`/Users/Example/.claude/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const result = await checkPermissionMode(guarded, '/Users/Example');
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
      expect(touched).toEqual([]);
    });

    it('compares the letters exactly on the other platforms', async () => {
      const deps = makeDeps({ env: { HOME: '/users/example' }, os: 'linux' });
      deps.seed(`/Users/Example/.claude/settings.json`, BYPASS);
      expect((await checkPermissionMode(deps, '/Users/Example')).level).toBe('fail');
    });

    it('skips a settings folder below the user settings folder', async () => {
      const deps = makeDeps({ env: { HOME: '/users/example' } });
      deps.seed(`${USER_SETTINGS}/node/.claude/settings.json`, BYPASS);
      const result = await checkPermissionMode(deps, `${USER_SETTINGS}/node`);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('not checked');
    });

    it('warns and reads nothing when it cannot resolve the links of the paths', async () => {
      const deps = makeDeps({ env: { HOME: '/users/example' } });
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
  const withProxies = (onFail: 'stop' | 'direct', workers: FactoryConfig['core']['workers'] = {}): FactoryConfig => {
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
        workers,
      },
    };
  };

  const stateOf = async (deps: FakeDeps, config: FactoryConfig) => {
    writeConfig(deps, config);
    return inspectConfig(deps, HOME);
  };

  it('says that no proxy is in use when the session names none', async () => {
    const deps = await initialized();
    const results = await checkProxies(deps, await inspectConfig(deps, HOME));
    expect(results).toEqual([{ id: 'proxy', level: 'ok', text: 'no proxy is in use' }]);
  });

  it('is ok when the proxy answers below 500, and sends one request to the health URL', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 404 }) });
    const results = await checkProxies(deps, await stateOf(deps, withProxies('stop')));
    expect(results).toEqual([{ id: 'proxy:local', level: 'ok', text: 'local (127.0.0.1:8787) answers' }]);
    expect(deps.fetched).toEqual(['http://127.0.0.1:8787/v1/health']);
  });

  it('fails when the proxy is down and on_fail is stop', async () => {
    const deps = makeDeps();
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('stop')));
    expect(result?.level).toBe('fail');
    expect(result?.text).toContain('local (127.0.0.1:8787) does not answer');
  });

  it('warns when the proxy is down and on_fail is direct', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 500 }) });
    const [result] = await checkProxies(deps, await stateOf(deps, withProxies('direct')));
    expect(result?.level).toBe('warn');
    expect(result?.text).toContain('on_fail is direct');
  });

  it('checks a proxy that only a worker uses, and skips a proxy that nothing uses', async () => {
    const deps = makeDeps({ fetch: () => ok({ status: 200 }) });
    const used = withProxies('stop', { 'web-search': { proxy: 'spare' } });
    const config = { ...used, core: { ...used.core, session: { ...sampleConfig().core.session } } };
    const results = await checkProxies(deps, await stateOf(deps, config));
    expect(results.map((result) => result.id)).toEqual(['proxy:spare']);
  });

  it('warns that it did not check when the config is not valid', async () => {
    const deps = makeDeps();
    deps.seed(`${HOME}/factory.yaml`, 'schema: 1\n');
    const results = await checkProxies(deps, await inspectConfig(deps, HOME));
    expect(results).toEqual([{ id: 'proxy', level: 'warn', text: 'not checked: factory.yaml is not valid' }]);
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

    it('sends the request when the config is in a parent folder of a registered root', async () => {
      const deps = await nodeWithProxy(`${HOME}/deep/er`);
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(levelOf(output.json['checks'] as CheckResult[], 'proxy:local')).toBe('ok');
      expect(output.lines[0]).toEqual({ level: 'text', text: `Config: ${HOME}/factory.yaml` });
      expect(output.failed).toBe(false);
    });

    it('sends the request when only FACTORY_HOME names the home of a registered root', async () => {
      const deps = await nodeWithProxy('/elsewhere', { FACTORY_HOME: HOME });
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(levelOf(output.json['checks'] as CheckResult[], 'proxy:local')).toBe('ok');
    });

    it('sends the request when the registered root comes from the index, by a project folder', async () => {
      const deps = await nodeWithProxy('/w/web/src');
      registerRoot(deps, HOME, 'demo', ['/w/web']);
      deps.seedDir('/w/web/src');
      const output = await run(deps, undefined);
      expect(deps.fetched).toEqual([PROXY_URL]);
      expect(output.json['home']).toBe(HOME);
    });

    it.each([
      ['--home', '/elsewhere', HOME, {}],
      ['the current folder', HOME, undefined, {}],
      ['a parent folder', `${HOME}/deep/er`, undefined, {}],
      ['FACTORY_HOME', '/elsewhere', undefined, { FACTORY_HOME: HOME }],
    ])('exits 4 and sends no request when the root with the proxy is not registered, from %s', async (_name, cwd, home, env) => {
      const deps = await nodeWithProxy(cwd, env);
      deps.files.delete(INDEX_FILE);
      const result = await runDoctor(deps, { home });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: expect.stringContaining('factory init') } });
      expect(deps.fetched).toEqual([]);
    });

    it('exits 4 and sends no request from a clone that holds its own config file with a proxy', async () => {
      const deps = await nodeWithProxy(`${HOME}/web/src`);
      registerRoot(deps, HOME, 'demo', [`${HOME}/web`]);
      seedConfig(deps, `${HOME}/web`, withProxies('stop'));
      deps.seedDir(`${HOME}/web/src`);
      const result = await runDoctor(deps, { home: undefined });
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!result.ok) {
        expect(result.error.message).toContain(`${HOME}/web/factory.yaml`);
        expect(result.error.hint).toBe(`Run the command from the factory folder ${HOME}, or name it with --home ${HOME}.`);
      }
      expect(deps.fetched).toEqual([]);
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

    describe('when the registered home is not the top folder of a git work tree', () => {
      /** The files of a node with a proxy, copied into deps where the home is a folder inside a work tree. */
      const inWorkTree = async (cwd: string): Promise<FakeDeps> => {
        const made = await nodeWithProxy(cwd);
        const deps = makeDeps({
          cwd,
          fetch: () => ok({ status: 200 }),
          git: { repos: { [HOME]: { topLevel: false } }, committed: [`${HOME}/.factory`] },
        });
        for (const dir of made.dirs) deps.seedDir(dir);
        for (const [path, text] of made.files) deps.seed(path, text);
        return deps;
      };

      it.each([
        ['the current folder', HOME, undefined],
        ['--home', '/elsewhere', HOME],
      ])('sends the request for a home inside a git work tree that comes from %s, and the root check warns', async (_name, cwd, home) => {
        const deps = await inWorkTree(cwd);
        const output = await run(deps, home);
        expect(deps.fetched).toEqual([PROXY_URL]);
        const checks = output.json['checks'] as CheckResult[];
        expect(levelOf(checks, 'root')).toBe('warn');
        expect(levelOf(checks, 'proxy:local')).toBe('ok');
        expect(output.failed).toBe(false);
      });

      it('reports that no proxy is in use when none is, even for a home that is not the top of a work tree', async () => {
        const deps = await inWorkTree(HOME);
        writeConfig(deps, sampleConfig());
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
    expect(result.text).toContain('tmux (the "factory start" command)');
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
  ])('warns for %s and names the start command', async (version, shown) => {
    const result = await checkTools(makeDeps({ tmux: { version } }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`${shown} is older than 3.0`);
    expect(result.text).toContain('"factory start"');
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

describe('doctor: the root', () => {
  const GITIGNORE = `${HOME}/.gitignore`;

  /** A root that init made, in a fake git that finds a work tree at the top of the root. */
  const rooted = (setup: Setup = {}): Promise<FakeDeps> => initialized({ ...setup, git: { repos: { [HOME]: {} } } });

  it('is ok for the top folder of its own work tree that holds the share list', async () => {
    expect(await checkRoot(await rooted(), HOME)).toEqual({
      id: 'root',
      level: 'ok',
      text: 'the factory folder is the top folder of its own git work tree and holds the share list',
    });
  });

  it('stays ok when a person adds lines after the share list', async () => {
    const deps = await rooted();
    deps.files.set(GITIGNORE, `${deps.files.get(GITIGNORE) ?? ''}\n!/notes.md\n`);
    expect((await checkRoot(deps, HOME)).level).toBe('ok');
  });

  it('warns, and does not fail, when the root is a folder inside another work tree', async () => {
    const deps = await initialized({ git: { repos: { [HOME]: { topLevel: false } } } });
    const result = await checkRoot(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`${HOME} is not the top folder of a git work tree of its own`);
  });

  it('warns when the root is in no work tree', async () => {
    const result = await checkRoot(await initialized(), HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('is not the top folder of a git work tree of its own');
  });

  it.each([
    ['is missing', undefined],
    ['holds no share list', '!/notes.md\n'],
    ['holds a share list that was changed', '# factory:begin share list\n/old\n# factory:end share list\n'],
    ['holds a marker line with no pair', '# factory:begin share list\n/*\n'],
  ])('warns when .gitignore %s', async (_name, text) => {
    const deps = await rooted();
    if (text === undefined) deps.files.delete(GITIGNORE);
    else deps.files.set(GITIGNORE, text);
    const result = await checkRoot(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('.gitignore has no intact share list');
    expect(oldWordsIn(result.text)).toEqual([]);
  });

  it('does not check the root when git is missing', async () => {
    const deps = await rooted({ tools: ['tmux', 'gh', 'claude'] });
    expect(await checkRoot(deps, HOME)).toEqual({ id: 'root', level: 'warn', text: 'not checked: git is missing' });
  });
});

describe('doctor: the temp folders of a stopped init (TP-73)', () => {
  it('is ok when the root holds no temp folder', async () => {
    expect(await checkTempFolders(await initialized(), HOME)).toEqual({
      id: 'temp-folder',
      level: 'ok',
      text: 'no temp folder of a stopped init in the factory folder',
    });
  });

  it('warns with the words "temp folder" for each leftover, and removes nothing', async () => {
    const deps = await initialized();
    const first = `${HOME}/.factory.tmp-4242`;
    const second = `${HOME}/.factory.tmp-77`;
    deps.seedDir(first);
    deps.seedDir(second);
    const result = await checkTempFolders(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`temp folder ${first}`);
    expect(result.text).toContain(`temp folder ${second}`);
    expect(oldWordsIn(result.text)).toEqual([]);
    expect(deps.dirs.has(first)).toBe(true);
    expect(deps.dirs.has(second)).toBe(true);
  });

  it('does not take the state folder or a folder with another name for a temp folder', async () => {
    const deps = await initialized();
    deps.seedDir(`${HOME}/.factory.tmp-x`);
    deps.seedDir(`${HOME}/web`);
    expect((await checkTempFolders(deps, HOME)).level).toBe('ok');
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
  const env = { XDG_STATE_HOME: '/state', HOME: '/users/example' };
  const indexOf = (...homes: string[]): string =>
    JSON.stringify({ schema: 1, homes: homes.map((home, i) => ({ home, id: `h${i}`, projects: ['/w/web'] })) });

  it('is ok when no variable names a folder for the index', async () => {
    const deps = makeDeps({ env: { XDG_STATE_HOME: undefined, HOME: undefined } });
    expect(await checkIndex(deps)).toMatchObject({ id: 'index', level: 'ok', text: expect.stringContaining('no home index is used') });
  });

  it('is ok when every home in the index is present', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf(HOME));
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await checkIndex(deps)).toMatchObject({ level: 'ok', text: '1 entry in the home index, all present' });
  });

  it('is ok when there is no index file yet', async () => {
    expect(await checkIndex(makeDeps({ env }))).toMatchObject({ level: 'ok', text: '0 entries in the home index, all present' });
  });

  it('warns on an entry whose home is gone, and names the home and the file', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf(HOME, '/w/gone'));
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    const result = await checkIndex(deps);
    expect(result).toMatchObject({ level: 'warn' });
    expect(result.text).toContain('/w/gone');
    expect(result.text).not.toContain(`${HOME},`);
    expect(result.text).toContain(INDEX);
  });

  it('warns when the file cannot be read', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, 'broken');
    expect(await checkIndex(deps)).toMatchObject({ level: 'warn', text: expect.stringContaining(`${INDEX} cannot be read`) });
  });

  it('warns when the place of the index is inside the folder of Claude Code', async () => {
    const deps = makeDeps({ env: { HOME: '/users/example', XDG_STATE_HOME: '/users/example/.claude/state' } });
    expect(await checkIndex(deps)).toMatchObject({ level: 'warn' });
  });

  it('exits 4 in the command when the index does not list the home, and names the remedy', async () => {
    const deps = await initialized({ env });
    deps.files.delete(INDEX);
    const result = await runDoctor(deps, { home: HOME });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: `Run "factory init" in the factory folder ${HOME}.` } });
  });

  it('is ok in the command right after init, because init lists the home', async () => {
    const deps = await initialized({ env });
    const result = await runDoctor(deps, { home: HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'index')).toBe('ok');
  });

  it('runs from a project folder through the index, and checks the proxy, because the root is registered', async () => {
    const deps = await initialized({ env, cwd: '/w/web/src', fetch: () => ok({ status: 200 }) });
    registerRoot(deps, HOME, 'demo', ['/w/web']);
    const local = deps.files.get(`${HOME}/factory.local.yaml`) ?? '';
    deps.seed(
      `${HOME}/factory.local.yaml`,
      local.replace('proxy: none', 'proxy: local').replace('proxies: []', 'proxies:\n  - id: local\n    base_url: "http://127.0.0.1:8787"\n    health: /health\n    on_fail: stop'),
    );
    const result = await runDoctor(deps, { home: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.json['home']).toBe(HOME);
    expect(deps.fetched).toHaveLength(1);
    expect(levelOf(result.value.json['checks'] as CheckResult[], 'proxy:local')).toBe('ok');
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
    seedConfig(deps, path, { ...config, core: { ...config.core, node: { id, layer } } });
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

  it('fails for a child on layer 1 under a node on layer 1, because workers are layer 0', async () => {
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

describe('doctor: projects that the factory can not share (F-17c)', () => {
  const WEB = sampleConfig().recipe.projects[0]!;
  const configWith = (projects: readonly Record<string, unknown>[], sources: Record<string, string> = {}): FactoryConfig => {
    const sample = sampleConfig();
    return {
      core: { ...sample.core, sources },
      recipe: { ...sample.recipe, projects: projects as unknown as FactoryConfig['recipe']['projects'] },
    };
  };
  const stateOf = async (config: FactoryConfig) => {
    const deps = makeDeps();
    writeConfig(deps, config);
    return { deps, state: await inspectConfig(deps, HOME) };
  };
  const noUrl = (id: string, path: string): Record<string, unknown> => {
    const { url: _url, ...rest } = WEB;
    return { ...rest, id, path };
  };

  it('is ok when each project has a URL that a host serves', async () => {
    const { state } = await stateOf(configWith([WEB]));
    expect(checkProjectUrls(state)).toEqual([
      { id: 'project-urls', level: 'ok', text: '1 project has a URL that can be shared' },
    ]);
  });

  it('is ok for a config without projects', async () => {
    const { state } = await stateOf(configWith([]));
    expect(checkProjectUrls(state)).toEqual([{ id: 'project-urls', level: 'ok', text: 'no project is configured' }]);
  });

  it('warns once per project with no URL, and names the project and the fix (TP-109)', async () => {
    const { state } = await stateOf(configWith([noUrl('lib', '../lib'), WEB, noUrl('tool', '../tool')]));
    const results = checkProjectUrls(state);
    expect(results.map((result) => [result.id, result.level])).toEqual([
      ['project-urls:lib', 'warn'],
      ['project-urls:tool', 'warn'],
    ]);
    expect(results[0]?.text).toContain('cannot be shared with the repo of the project lib');
    expect(results[0]?.text).toContain('Add an origin to the repo and set url for the project in factory.yaml');
    expect(results[0]?.text).toContain('factory doctor');
  });

  it.each([
    ['a file URL', 'file:///srv/acme/web.git', 'is a file URL'],
    ['a path of this machine', '/srv/acme/web', 'is a path of one machine'],
  ])('warns for %s in the url key', async (_name, url, reason) => {
    const { state } = await stateOf(configWith([{ ...WEB, url }]));
    const [result] = checkProjectUrls(state);
    expect(result).toMatchObject({ id: 'project-urls:web', level: 'warn' });
    expect(result?.text).toContain(reason);
  });

  it('names the local source from the local file in the fix, never in a tracked file', async () => {
    const { state, deps } = await stateOf(configWith([noUrl('lib', '../lib')], { '../lib': '/srv/code/lib' }));
    const [result] = checkProjectUrls(state);
    expect(result?.text).toContain('Add an origin to the repo (/srv/code/lib) and set url');
    expect(deps.files.get(`${HOME}/factory.yaml`)).not.toContain('/srv/code/lib');
  });

  it('finds the source when the key writes the project path another way', async () => {
    const { state } = await stateOf(configWith([noUrl('lib', '../lib')], { '../lib/': '/srv/code/lib' }));
    expect(checkProjectUrls(state)[0]?.text).toContain('(/srv/code/lib)');
  });

  it('is not checked when the config is not valid', async () => {
    const deps = makeDeps();
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect(checkProjectUrls(await inspectConfig(deps, HOME))).toMatchObject([{ id: 'project-urls', level: 'warn' }]);
  });

  it('warns in the command, does not fail it, and sets no exit code', async () => {
    const deps = makeDeps({ git: { repos: { '/w/lib': {} } } });
    writeConfig(deps, configWith([noUrl('lib', '../lib')]));
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'project-urls:lib')).toBe('warn');
    expect(output.lines.some((line) => line.level === 'warn' && line.text.includes('cannot be shared'))).toBe(true);
    expect(output.exitCode).toBeUndefined();
  });

  it('fails the config check for a URL with a token, and prints no part of the token (TP-24)', async () => {
    const deps = makeDeps();
    writeConfig(deps, sampleConfig());
    const path = `${HOME}/factory.yaml`;
    const text = deps.files.get(path) ?? '';
    expect(text).toContain('https://github.com/acme/web.git');
    deps.files.set(path, text.replace('https://github.com/', `https://${FAKE_GITHUB_TOKEN}@github.com/`));
    const output = await doctor(deps);
    const checks = output.json['checks'] as CheckResult[];
    expect(levelOf(checks, 'config')).toBe('fail');
    expect(checks.find((check) => check.id === 'config')?.text).toContain('recipe.projects.0.url');
    expect(output.failed).toBe(true);
    expect(JSON.stringify(output)).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe('doctor: the command', () => {
  it('passes on a fresh node: no failure, so it is not failed', async () => {
    const deps = await initialized({ git: { repos: { [HOME]: {} }, committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    const output = await doctor(deps);
    expect(output.failed).toBe(false);
    expect(output.json).toMatchObject({ schema: 'factory.doctor/v1', ok: true, home: HOME });
    const ids = (output.json['checks'] as CheckResult[]).map((result) => result.id);
    expect(ids).toEqual([
      'config',
      'config-version',
      'local-file',
      'state',
      'root',
      'temp-folder',
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
      'project-urls',
    ]);
    expect(output.lines.at(-1)?.text).toBe('19 ok, 0 warnings, 0 failures');
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
    expect(output.lines.filter((line) => line.level !== 'text')).toHaveLength(19);
  });

  it('finds the node by walking up from the current folder', async () => {
    const deps = await initialized();
    const inside = createFakeDeps({ cwd: `${HOME}/deep/er`, env: { XDG_STATE_HOME: '/state' } });
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

describe('doctor: the local file', () => {
  const LOCAL = `${HOME}/factory.local.yaml`;

  it('is ok for a file with mode 600 that the account owns', async () => {
    const deps = await initialized();
    expect(await checkLocalFile(deps, HOME)).toEqual({
      id: 'local-file',
      level: 'ok',
      text: 'factory.local.yaml has no group or other access',
    });
  });

  it('warns for a file that others can read, names the chmod command and changes no mode', async () => {
    const deps = await initialized({ git: { committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    deps.modes.set(LOCAL, 0o644);
    const result = await checkLocalFile(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('chmod 600 factory.local.yaml');
    expect(deps.modes.get(LOCAL)).toBe(0o644);
    const run = await doctor(deps);
    expect(levelOf(run.json['checks'] as CheckResult[], 'local-file')).toBe('warn');
    expect(run.failed).toBe(false);
    expect(deps.modes.get(LOCAL)).toBe(0o644);
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('fails for a file with %s, and names the chmod command', async (_name, change) => {
    const deps = await initialized();
    change(deps);
    const result = await checkLocalFile(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('factory.local.yaml');
    expect(result.text).toContain('chmod 600 factory.local.yaml');
    const run = await doctor(deps);
    expect(levelOf(run.json['checks'] as CheckResult[], 'config')).toBe('fail');
    expect(levelOf(run.json['checks'] as CheckResult[], 'local-file')).toBe('fail');
    expect(run.failed).toBe(true);
  });

  it('exits 2 when the shared file is there and the local file is not, and names init', async () => {
    const deps = await initialized();
    deps.files.delete(LOCAL);
    const run = await doctor(deps);
    expect(run.exitCode).toBe(2);
    expect(run.failed).toBe(true);
    const checks = run.json['checks'] as CheckResult[];
    expect(checks.find((result) => result.id === 'config')?.text).toContain('factory init');
    expect(levelOf(checks, 'local-file')).toBe('warn');
  });

  it('sets no exit code for a config that is intact, or that fails for another reason', async () => {
    const intact = await doctor(await initialized());
    expect(intact.exitCode).toBeUndefined();
    const broken = await initialized();
    broken.files.set(`${HOME}/factory.yaml`, 'a: [1\n');
    const run = await doctor(broken);
    expect(run.failed).toBe(true);
    expect(run.exitCode).toBeUndefined();
  });

  it('never reads or prints the content of a local file that it refuses', async () => {
    const deps = await initialized();
    deps.files.set(LOCAL, `${deps.files.get(LOCAL) ?? ''}extra: ${FAKE_GITHUB_TOKEN}\n`);
    deps.modes.set(LOCAL, 0o666);
    const run = await doctor(deps);
    expect(JSON.stringify(run)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('names the local file when a token is in it, never the value', async () => {
    const deps = await initialized();
    deps.files.set(LOCAL, deps.files.get(LOCAL)?.replace('sources: {}', `sources:\n  api: ${FAKE_GITHUB_TOKEN}`) ?? '');
    const result = checkSecrets(await inspectConfig(deps, HOME));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('sources.api');
    expect(result.text).toContain('factory.local.yaml');
    expect(result.text).not.toContain('ghp_');
  });
});
