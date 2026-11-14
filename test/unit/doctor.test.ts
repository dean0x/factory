import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBlock } from '../../src/blocks/managed.js';
import { inspectBlocks } from '../../src/blocks/status.js';
import { failure } from '../../src/cli/errors.js';
import {
  checkAgentVersion,
  checkBlocks,
  checkBoardSize,
  checkConfig,
  checkConfigVersion,
  checkIndex,
  checkLessons,
  checkNodeId,
  checkInstructionFiles,
  checkLocalFile,
  checkNodeBlocks,
  checkProjects,
  checkProjectUrls,
  checkProxies,
  checkProxyEnv,
  checkRoleDelivery,
  checkRoles,
  checkRoot,
  checkSecrets,
  checkSetupText,
  checkState,
  checkStateGuard,
  checkStateRepo,
  checkTempFolders,
  checkTools,
  checkTracker,
  type CheckResult,
} from '../../src/commands/doctor.js';
import { renderConfig } from '../../src/config/render.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { instructionFileWarnings, scanInstructionFiles } from '../../src/core/instruction-files.js';
import { ok } from '../../src/core/result.js';
import { boardWarnPercent, checkIds, childReasons, dirs, files, instructionFiles, lessonLimits, maxFileBytes, roleText } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { inspectState } from '../../src/state/load.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { layer1Blocks, layer2Blocks } from '../helpers/blocks.js';
import { createFakeDeps, exited, registerRoot, withFsWatch, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { OWN_SETTINGS_TEXT, seedAcceptedSetup, seedOwnHooks, seedUnacceptedSetup, settingsFileOf } from '../helpers/role-delivery.js';
import { checkChildren, inspectConfig, runDoctor, runInit } from '../helpers/package-registry.js';
import { tmuxHandler, type TmuxFixture } from '../helpers/tmux-fake.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { ACCEPTANCES, acceptFiles } from '../helpers/setup-acceptance.js';

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
  /** What `claude --version` prints, or null when the program ends with a failure. */
  readonly agentVersion?: string | null;
}

const AGENT_VERSION_TEXT = '2.1.224 (Claude Code)\n';

/**
 * The setting `core.hooksPath` as git reads it from the state folder after `init`. The git fake keeps a setting that init writes under
 * the staging folder, and the staging folder is renamed afterwards, so the fixture names the setting of the final folder.
 */
const GUARD_ON: GitFixture = { hooksPath: { [`${HOME}/.factory`]: `${HOME}/.factory/.git/factory-guard` } };

const makeDeps = (setup: Setup = {}): FakeDeps => {
  const git = gitHandler(setup.git ?? {});
  const tmux = tmuxHandler(setup.tmux);
  const agentVersion = setup.agentVersion === undefined ? AGENT_VERSION_TEXT : setup.agentVersion;
  const deps = createFakeDeps({
    cwd: setup.cwd ?? '/w',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run: (call) => {
      if (call.command === 'claude') return agentVersion === null ? exited(1, '', 'broken') : exited(0, agentVersion);
      return call.command === 'tmux' ? tmux.handler(call) : git.handler(call);
    },
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
    yes: true,
    recipe: undefined,
    layer: undefined,
    approval: [],
  });
  expect(result.ok).toBe(true);
  return deps;
};

const levelOf = (results: readonly CheckResult[], id: string): string | undefined =>
  results.find((result) => result.id === id)?.level;

/** Write both config files of the root and register it as the own root of the user, with the node id of the config. */
const writeConfig = (deps: FakeDeps, config: FactoryConfig): void => {
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id, [], 'own');
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
      text: '5 managed blocks are intact',
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

  it('warns when a role block or its file is missing', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/.factory/roles/worker.md`);
    const missing = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(missing.level).toBe('warn');
    expect(missing.text).toContain('worker (missing');
  });

  it('fails when the markers of the file that holds the safety block are broken', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, '<!-- factory:begin x v1 sha256=zz -->\n');
    const broken = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
    expect(broken.level).toBe('fail');
    expect(broken.text).toContain('coordinator (malformed');
    expect(broken.text).toContain('safety (malformed');
  });

  describe('the safety block', () => {
    const editSafety = (deps: FakeDeps): void => {
      const claude = deps.files.get(CLAUDE_MD) ?? '';
      const at = claude.indexOf('<!-- factory:begin safety');
      expect(at).toBeGreaterThan(-1);
      deps.files.set(CLAUDE_MD, `${claude.slice(0, at)}${claude.slice(at).replace('Never skip permissions', 'Skip permissions')}`);
    };

    it('fails when the text does not match the hash of its marker, and names the command that puts it back and keeps the old text', async () => {
      const deps = await initialized();
      editSafety(deps);
      const result = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('safety (edited, in /w/node/coordinator/CLAUDE.md)');
      expect(result.text).toContain('Run "factory upgrade --overwrite safety" to replace the text. It keeps the old text in a backup file.');
    });

    it('fails when the file has no safety block', async () => {
      const deps = await initialized();
      const claude = deps.files.get(CLAUDE_MD) ?? '';
      const at = claude.indexOf('<!-- factory:begin safety');
      const end = claude.indexOf('<!-- factory:end safety -->') + '<!-- factory:end safety -->'.length;
      deps.files.set(CLAUDE_MD, `${claude.slice(0, at)}${claude.slice(end)}`);
      const result = checkBlocks(await inspectBlocks(deps, HOME, layer1Blocks));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('safety (missing, in /w/node/coordinator/CLAUDE.md)');
      expect(result.text).toContain('Run "factory upgrade --overwrite safety" to add it.');
    });

    it('fails when the file is not there', async () => {
      const deps = await initialized();
      deps.files.delete(CLAUDE_MD);
      const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('safety (missing');
    });

    it('fails the node check and the whole run for an edited block, and names the command in one line', async () => {
      const deps = await initialized();
      editSafety(deps);
      const output = await doctor(deps);
      expect(output.failed).toBe(true);
      const blocks = output.lines.find((line) => line.text.startsWith('blocks '));
      expect(blocks?.level).toBe('fail');
      expect(blocks?.text).toContain('factory upgrade --overwrite safety');
    });

    it('fails for an edited prefix line, because the owner prefix is part of the block', async () => {
      const deps = await initialized();
      const claude = deps.files.get(CLAUDE_MD) ?? '';
      expect(claude).toContain('- The owner prefix is');
      deps.files.set(CLAUDE_MD, claude.replace(/- The owner prefix is `[^`]*`/, '- The owner prefix is `[From anyone]`'));
      const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('safety (edited');
    });

    it('does not fail for an edited role block, which stays a warning', async () => {
      const deps = await initialized();
      deps.files.set(CLAUDE_MD, (deps.files.get(CLAUDE_MD) ?? '').replace('Coordinate. Do not produce.', 'Do as you like.'));
      expect((await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME))).level).toBe('warn');
    });
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

  it('checks the coordinator, safety, worker and setup blocks of a node on layer 1', async () => {
    const deps = await initialized();
    expect(await nodeBlocks(deps)).toMatchObject({ id: 'blocks', level: 'ok', text: '5 managed blocks are intact' });
  });

  it('warns that the role block does not match when the layer was changed by hand', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    const result = await nodeBlocks(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('coordinator (intact, in /w/node/coordinator/CLAUDE.md)');
    expect(result.text).toContain('needs the block manager');
  });

  const WORKER_FILE = `${HOME}/.factory/roles/worker.md`;

  /** The text of the file that holds the blocks of this target, as `init` writes it. */
  const fileOf = (target: 'claudeFile' | 'workerFile'): string => {
    const blocks = layer2Blocks
      .filter((block) => block.target === target)
      .map((block) => {
        const rendered = renderBlock(block);
        if (!rendered.ok) throw new Error(rendered.error.message);
        return rendered.value;
      });
    return `${blocks.join('\n\n')}\n`;
  };

  it('is ok for the blocks of layer 2: manager, safety, worker, setup and setup-worker', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    deps.files.set(CLAUDE_MD, fileOf('claudeFile'));
    deps.files.set(WORKER_FILE, fileOf('workerFile'));
    expect(await nodeBlocks(deps)).toMatchObject({ level: 'ok', text: '5 managed blocks are intact' });
  });

  it('warns that a node on layer 2 from before has no worker file, and names the commands that add it', async () => {
    const deps = await initialized();
    setLayer(deps, 2);
    deps.files.set(CLAUDE_MD, fileOf('claudeFile'));
    deps.files.delete(WORKER_FILE);
    const result = await nodeBlocks(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`worker (missing, in ${WORKER_FILE})`);
    expect(result.text).toContain('Run "factory upgrade --overwrite worker" to add it.');
    expect(result.text).toContain('Run "factory upgrade".');
  });

  it('does not check the blocks when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.delete(`${HOME}/factory.yaml`);
    expect(await nodeBlocks(deps)).toMatchObject({ id: 'blocks', level: 'warn', text: 'not checked: factory.yaml is not valid' });
  });

  describe('with a delegated value in the local file', () => {
    const STORE = '/state/factory/owner-records.json';

    const delegateInLocalFile = (deps: FakeDeps): void => {
      const path = `${HOME}/factory.local.yaml`;
      const text = deps.files.get(path) ?? '';
      expect(text).toContain('merge: owner');
      deps.files.set(path, text.replace('merge: owner', 'merge: delegated'));
    };

    const record = (point: string, mode: string): string =>
      `${JSON.stringify({ schema: 1, records: [{ kind: 'delegation', node: 'demo', root: HOME, point, mode, at: '2030-01-01T00:00:00.000Z' }] })}\n`;

    it('checks the blocks against the owner text when no record backs the value', async () => {
      const deps = await initialized();
      delegateInLocalFile(deps);
      expect(await nodeBlocks(deps)).toMatchObject({ id: 'blocks', level: 'ok', text: '5 managed blocks are intact' });
    });

    it('checks the blocks against the owner text when a record file lies inside the folder only', async () => {
      const deps = await initialized();
      delegateInLocalFile(deps);
      deps.seed(`${HOME}/owner-records.json`, record('merge', 'delegated'));
      expect(await nodeBlocks(deps)).toMatchObject({ level: 'ok' });
    });

    it('checks the blocks against the delegated text when a delegation record backs the value', async () => {
      const deps = await initialized();
      delegateInLocalFile(deps);
      deps.seed(STORE, record('merge', 'delegated'));
      const result = await nodeBlocks(deps);
      expect(result.level).toBe('warn');
      expect(result.text).toContain('coordinator');
    });

    it('checks the blocks against the owner text when the newest record has the mode owner', async () => {
      const deps = await initialized();
      delegateInLocalFile(deps);
      deps.seed(STORE, record('merge', 'owner'));
      expect(await nodeBlocks(deps)).toMatchObject({ level: 'ok' });
    });
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

describe('doctor: root checks and the settings of the session folders', () => {
  const BYPASS = '{"permissions":{"defaultMode":"bypassPermissions"}}';
  const ROOT_CHECKS = ['root-repo', 'root-files', 'project-paths', 'permission-mode', 'delegations'];

  const checksOf = async (deps: FakeDeps): Promise<readonly CheckResult[]> => (await doctor(deps)).json['checks'] as CheckResult[];

  const textOfCheck = (results: readonly CheckResult[], id: string): string => results.find((result) => result.id === id)?.text ?? '';

  /** The config with a proxy that the session uses. The root stays the own root that init registered. */
  const useProxy = (deps: FakeDeps): void => {
    const sample = sampleConfig();
    seedConfig(deps, HOME, {
      ...sample,
      core: {
        ...sample.core,
        session: { ...sample.core.session, proxy: 'local' },
        proxies: [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: 'stop' }],
      },
    });
  };

  it('has the five root checks, all ok, on a fresh node with no settings folder', async () => {
    const deps = await initialized();
    const results = await checksOf(deps);
    for (const id of ROOT_CHECKS) expect(levelOf(results, id)).toBe('ok');
  });

  it.each([
    ['bypassPermissions as the default mode', BYPASS],
    ['the skip flag in a command', '{"env":{"X":"--dangerously-skip-permissions"}}'],
    ['the skip prompt setting', '{"skipDangerousModePermissionPrompt": true}'],
  ])('fails for %s in settings.local.json', async (_name, json) => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.local.json`, json);
    const output = await doctor(deps);
    const results = output.json['checks'] as CheckResult[];
    expect(levelOf(results, 'permission-mode')).toBe('fail');
    expect(textOfCheck(results, 'permission-mode')).toContain('.claude/settings.local.json');
    expect(output.failed).toBe(true);
  });

  it('checks settings.json too, and ignores other files and safe settings', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/.claude/settings.json`, '{"permissions":{"disableBypassPermissionsMode":"disable"}}');
    deps.seed(`${HOME}/.claude/notes.txt`, 'bypassPermissions');
    expect(levelOf(await checksOf(deps), 'permission-mode')).toBe('ok');
    deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
    expect(textOfCheck(await checksOf(deps), 'permission-mode')).toContain('.claude/settings.json');
  });

  it('checks the coordinator folder and names the file', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/coordinator/.claude/settings.local.json`, BYPASS);
    const results = await checksOf(deps);
    expect(levelOf(results, 'permission-mode')).toBe('fail');
    expect(textOfCheck(results, 'permission-mode')).toContain('coordinator/.claude/settings.local.json');
  });

  it('checks a Claude settings path that the root repo tracks, at any depth', async () => {
    const tracked = 'tools/deep/.claude/settings.json';
    const deps = await initialized({ git: { tracked: { [HOME]: [tracked] } } });
    deps.seed(`${HOME}/${tracked}`, BYPASS);
    const results = await checksOf(deps);
    expect(levelOf(results, 'permission-mode')).toBe('fail');
    expect(textOfCheck(results, 'permission-mode')).toContain(tracked);
  });

  it('fails for the proxy variable and for a hook in the settings of a session folder', async () => {
    const proxy = await initialized();
    proxy.seed(`${HOME}/coordinator/.claude/settings.local.json`, '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1"}}');
    const proxyResults = await checksOf(proxy);
    expect(levelOf(proxyResults, 'permission-mode')).toBe('fail');
    expect(textOfCheck(proxyResults, 'permission-mode')).toContain('ANTHROPIC_BASE_URL');

    const hook = await initialized();
    hook.seed(`${HOME}/coordinator/.claude/settings.local.json`, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}');
    const hookResults = await checksOf(hook);
    expect(levelOf(hookResults, 'permission-mode')).toBe('fail');
    expect(textOfCheck(hookResults, 'permission-mode')).toContain('hooks');
  });

  it('fails, and names the command that fixes it, when git can not answer the ignore question', async () => {
    const deps = await initialized();
    const broken: FakeDeps = {
      ...deps,
      run: async (command, args, options) =>
        args.includes('check-ignore') ? exited(128, '', 'fatal: check-ignore failed') : deps.run(command, args, options),
    };
    const output = await doctor(broken);
    expect(levelOf(output.json['checks'] as CheckResult[], 'root-repo')).toBe('fail');
    expect(textOfCheck(output.json['checks'] as CheckResult[], 'root-repo')).toContain('run "factory doctor"');
    expect(output.failed).toBe(true);
  });

  it('fails when the root repo tracks the local file', async () => {
    const deps = await initialized({ git: { tracked: { [HOME]: ['factory.local.yaml', 'factory.yaml'] } } });
    const output = await doctor(deps);
    const results = output.json['checks'] as CheckResult[];
    expect(levelOf(results, 'root-repo')).toBe('fail');
    expect(textOfCheck(results, 'root-repo')).toContain('git rm --cached');
    expect(output.failed).toBe(true);
  });

  it('fails when the tracked files of a received root have no setup acceptance at all, and names init', async () => {
    const deps = await initialized({ git: { tracked: { [HOME]: ['scripts/run.sh', 'factory.yaml'] } } });
    registerRoot(deps, HOME, 'demo', [], 'received');
    deps.seed(`${HOME}/scripts/run.sh`, 'echo hi\n');
    await deps.fs.remove(ACCEPTANCES);
    const results = await checksOf(deps);
    expect(levelOf(results, 'root-repo')).toBe('fail');
    expect(textOfCheck(results, 'root-repo')).toContain('Run "factory init" in a terminal window');
    expect(textOfCheck(results, 'root-repo')).toContain('scripts/run.sh');
  });

  it('fails when the tracked files of a received root changed after an older acceptance, and names the accept command', async () => {
    const deps = await initialized({ git: { tracked: { [HOME]: ['scripts/run.sh', 'factory.yaml'] } } });
    registerRoot(deps, HOME, 'demo', [], 'received');
    deps.seed(`${HOME}/scripts/run.sh`, 'echo hi\n');
    const results = await checksOf(deps);
    expect(levelOf(results, 'root-repo')).toBe('fail');
    expect(textOfCheck(results, 'root-repo')).toContain(
      'Run "factory start" or "factory upgrade" in a terminal window outside a factory session.',
    );
    expect(textOfCheck(results, 'root-repo')).toContain('scripts/run.sh');
  });

  it.each([
    ['a changed tracked file', 'scripts/run.sh', 'echo one\n', 'echo two\n'],
    ['a changed tracked MCP config file', '.mcp.json', '{"mcpServers":{}}\n', '{"mcpServers":{"a":{}}}\n'],
  ])('fails for %s on a received root and never accepts it, also on a terminal window', async (_name, path, before, after) => {
    const deps = await initialized({ git: { tracked: { [HOME]: [path, 'factory.yaml'] } } });
    registerRoot(deps, HOME, 'demo', [], 'received');
    deps.seed(`${HOME}/${path}`, before);
    await acceptFiles(deps, HOME, 'demo', [path]);
    deps.seed(`${HOME}/${path}`, after);
    const stored = deps.files.get(ACCEPTANCES);
    const asking = { ...deps, stdinIsTTY: true, stdoutIsTTY: true, prompt: async () => ok('y') };
    const results = (await runDoctor(asking, { home: HOME }).then((result) => (result.ok ? result.value : null)))?.json['checks'] as CheckResult[];
    expect(levelOf(results, 'root-repo')).toBe('fail');
    expect(textOfCheck(results, 'root-repo')).toContain(path);
    expect(textOfCheck(results, 'root-repo')).toContain('Run "factory start" or "factory upgrade"');
    expect(deps.prompts).toEqual([]);
    expect(deps.files.get(ACCEPTANCES)).toBe(stored);
  });

  it('fails for a change of the setup text of an own root with the same line, and for a text with no acceptance at all', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/setup/coordinator.md`, 'A changed rule.\n');
    const changed = await checksOf(deps);
    expect(levelOf(changed, 'root-repo')).toBe('fail');
    expect(textOfCheck(changed, 'root-repo')).toContain('the setup text changed since the owner accepted it: setup/coordinator.md');
    expect(textOfCheck(changed, 'root-repo')).toContain('Run "factory start" or "factory upgrade" in a terminal window outside a factory session.');
    await deps.fs.remove(ACCEPTANCES);
    const none = await checksOf(deps);
    expect(textOfCheck(none, 'root-repo')).toContain('the owner has not accepted the setup text');
    expect(textOfCheck(none, 'root-repo')).toContain('Run "factory init" in a terminal window and accept the files.');
  });

  it('passes for the setup text that init accepted, and for a root with no setup text', async () => {
    const deps = await initialized();
    expect(levelOf(await checksOf(deps), 'root-repo')).toBe('ok');
    await deps.fs.remove(`${HOME}/setup`);
    await deps.fs.remove(ACCEPTANCES);
    expect(levelOf(await checksOf(deps), 'root-repo')).toBe('ok');
  });

  it('prints the mode of each approval point on the delegations line', async () => {
    const results = await checksOf(await initialized());
    expect(levelOf(results, 'delegations')).toBe('ok');
    expect(textOfCheck(results, 'delegations')).toContain('merge: owner');
    expect(textOfCheck(results, 'delegations')).toContain('release: owner');
  });

  it('sends no proxy health request when a root check fails, and the proxy line gives the reason', async () => {
    const deps = await initialized();
    useProxy(deps);
    deps.seed(`${HOME}/.claude/settings.local.json`, BYPASS);
    const results = await checksOf(deps);
    expect(deps.fetched).toEqual([]);
    expect(levelOf(results, 'proxy')).toBe('warn');
    expect(textOfCheck(results, 'proxy')).toContain('a check of the factory folder failed');
  });

  it('still sends the proxy health request when the root checks pass', async () => {
    const deps = await initialized();
    useProxy(deps);
    await checksOf(deps);
    expect(deps.fetched).toEqual(['http://127.0.0.1:8787/v1/health']);
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
        expect(result.error.hint).toBe(`Go to the factory folder ${HOME}, or name it with --home ${HOME}. Then run "factory doctor".`);
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

      it('fails the root check and sends no request for a received home that is not the top of a work tree', async () => {
        const deps = await inWorkTree(HOME);
        registerRoot(deps, HOME, 'demo', [], 'received');
        const output = await run(deps, undefined);
        const checks = output.json['checks'] as CheckResult[];
        expect(levelOf(checks, 'root-repo')).toBe('fail');
        expect(levelOf(checks, 'proxy')).toBe('warn');
        expect(deps.fetched).toEqual([]);
        expect(output.failed).toBe(true);
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

  describe('the version of git', () => {
    const versionCalls = (deps: FakeDeps) => deps.calls.filter((call) => call.command === 'git' && call.args[0] === '--version');

    it.each([
      ['git version 2.26.0\n'],
      ['git version 2.26\n'],
      ['git version 2.45.1\n'],
      ['git version 2.100.0\n'],
      ['git version 3.0.0\n'],
      ['git version 2.39.5 (Apple Git-154)\n'],
      ['git version 2.45.1.windows.1\n'],
    ])('is ok for %j', async (version) => {
      expect(await checkTools(makeDeps({ git: { version } }))).toMatchObject({ id: 'tools', level: 'ok' });
    });

    it.each([
      ['git version 2.25.1\n', 'git 2.25'],
      ['git version 2.9.5\n', 'git 2.9'],
      ['git version 1.8.3.1\n', 'git 1.8'],
      ['git version 1.99.0\n', 'git 1.99'],
    ])('fails for %j, names both versions and the fix', async (version, shown) => {
      const result = await checkTools(makeDeps({ git: { version } }));
      expect(result).toMatchObject({ id: 'tools', level: 'fail' });
      expect(result.text).toContain(`${shown} is older than 2.26`);
      expect(result.text).toContain('factory needs git 2.26 or later');
      expect(result.text).toContain('update git');
    });

    it.each([
      ['an empty output', ''],
      ['text with no version', 'hello\n'],
      ['a version word with no number', 'git version\n'],
      ['a number with no minor', 'git version 2\n'],
      ['a number that is no version', 'git version x.y.z\n'],
      ['digits that are too long for a version', 'git version 99999.1.0\n'],
      ['a version in a long output', `git version 2.45.1${' '.repeat(300)}`],
    ])('fails closed, and says so, for %s', async (_name, version) => {
      const result = await checkTools(makeDeps({ git: { version } }));
      expect(result).toMatchObject({ id: 'tools', level: 'fail' });
      expect(result.text).toContain('cannot read the version of git');
    });

    it('fails closed when the version command of git ends with a failure', async () => {
      const result = await checkTools(makeDeps({ git: { versionExit: 1 } }));
      expect(result).toMatchObject({ id: 'tools', level: 'fail' });
      expect(result.text).toContain('cannot read the version of git');
    });

    it('fails, and still names a missing program, when git is old and tmux is missing', async () => {
      const result = await checkTools(makeDeps({ tools: ['git', 'gh', 'claude'], git: { version: 'git version 2.25.1\n' } }));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('missing: tmux');
      expect(result.text).toContain('git 2.25 is older than 2.26');
    });

    it('does not read the version of a git that is missing, and names it once', async () => {
      const deps = makeDeps({ tools: ['tmux', 'gh', 'claude'] });
      const result = await checkTools(deps);
      expect(result.level).toBe('warn');
      expect(result.text.match(/git/g)).toHaveLength(1);
      expect(versionCalls(deps)).toEqual([]);
    });

    it('reads the version with one call that has no folder', async () => {
      const deps = makeDeps();
      await checkTools(deps);
      expect(versionCalls(deps).map((call) => call.args)).toEqual([['--version']]);
    });
  });
});

describe('doctor: the version of the agent', () => {
  const agentCheck = async (setup: Setup = {}) => {
    const deps = await initialized(setup);
    return { deps, result: await checkAgentVersion(deps, await inspectConfig(deps, HOME)) };
  };

  it.each([['2.1.224'], ['2.1.224 (Claude Code)\n'], ['2.2.0 (Claude Code)'], ['3.0.1']])('passes for %j', async (agentVersion) => {
    const { result } = await agentCheck({ agentVersion });
    expect(result).toMatchObject({ id: 'agent-version', level: 'ok' });
    expect(result.text).toContain('claude');
  });

  it.each([['2.1.223 (Claude Code)', '2.1.223'], ['2.0.999', '2.0.999'], ['1.0.0', '1.0.0']])(
    'warns for %j and names both versions',
    async (agentVersion, shown) => {
      const { result } = await agentCheck({ agentVersion });
      expect(result.level).toBe('warn');
      expect(result.text).toContain(`claude ${shown} is older than 2.1.224`);
      expect(result.text).toContain('messages between sessions');
    },
  );

  it.each([
    ['text with no version', 'unknown\n'],
    ['an empty output', ''],
    ['a version with more text', '2.1.224 (Claude Code) and more'],
    ['a version in a long output', `2.1.224${' '.repeat(300)}`],
    ['a failure of the program', null],
  ])('warns for %s', async (_name, agentVersion) => {
    const { result } = await agentCheck({ agentVersion });
    expect(result.level).toBe('warn');
    expect(result.text).toContain('cannot read the version of claude');
  });

  it('runs the agent program of the config with its version flag', async () => {
    const { deps } = await agentCheck();
    const config = await inspectConfig(deps, HOME);
    const agent = config.kind === 'valid' ? config.value.core.session.agent : '';
    expect(agent).not.toBe('');
    expect(deps.calls.filter((call) => call.command === agent).map((call) => call.args)).toEqual([['--version']]);
  });

  it('is not checked, and runs no program, when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
    const before = deps.calls.length;
    const result = await checkAgentVersion(deps, await inspectConfig(deps, HOME));
    expect(result).toEqual({ id: 'agent-version', level: 'warn', text: 'not checked: factory.yaml is not valid' });
    expect(deps.calls.length).toBe(before);
  });

  it('is not checked, and runs no program, when the agent is not on PATH', async () => {
    const { deps, result } = await agentCheck({ tools: ['git', 'tmux', 'gh'] });
    expect(result).toEqual({ id: 'agent-version', level: 'warn', text: 'not checked: claude is missing' });
    expect(deps.calls.filter((call) => call.command === 'claude')).toEqual([]);
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
    const result = await checkRoot(await initialized({ git: { noWorkTree: [HOME] } }), HOME);
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

describe('doctor: the temp folders of a stopped init', () => {
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
    expect(await checkIndex(deps)).toMatchObject({ id: 'index', level: 'ok', text: expect.stringContaining('no factory list is used') });
  });

  it('is ok when every home in the index is present', async () => {
    const deps = makeDeps({ env });
    deps.seed(INDEX, indexOf(HOME));
    deps.seed(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await checkIndex(deps)).toMatchObject({ level: 'ok', text: '1 entry in the factory list, all present' });
  });

  it('is ok when there is no index file yet', async () => {
    expect(await checkIndex(makeDeps({ env }))).toMatchObject({ level: 'ok', text: '0 entries in the factory list, all present' });
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

describe('doctor: the node id in the factory list', () => {
  const OTHER = '/w/other-node';

  it('is ok when no other factory in the list has the node id', async () => {
    const deps = await initialized();
    registerRoot(deps, OTHER, 'web');
    expect(await checkNodeId(deps, HOME, await inspectConfig(deps, HOME))).toEqual({
      id: 'node-id',
      level: 'ok',
      text: 'no other factory in the factory list has the node id demo',
    });
  });

  it('warns when another factory in the list has the node id, and names that factory', async () => {
    const deps = await initialized();
    registerRoot(deps, OTHER, 'demo');
    deps.seed(`${OTHER}/factory.yaml`, 'schema: 2\n');
    const result = await checkNodeId(deps, HOME, await inspectConfig(deps, HOME));
    expect(result).toMatchObject({ id: 'node-id', level: 'warn' });
    expect(result.text).toContain(OTHER);
    expect(result.text).toContain('demo');
    expect(result.text).not.toContain(`${HOME},`);
  });

  it('is ok for an entry with the node id whose folder is gone: the index check reports that entry', async () => {
    const deps = await initialized();
    registerRoot(deps, OTHER, 'demo');
    expect(await checkNodeId(deps, HOME, await inspectConfig(deps, HOME))).toMatchObject({ id: 'node-id', level: 'ok' });
  });

  it('is ok for a second entry of this folder through a link', async () => {
    const deps = await initialized({ links: { '/link/node': HOME } });
    registerRoot(deps, '/link/node', 'demo');
    expect(await checkNodeId(deps, HOME, await inspectConfig(deps, HOME))).toMatchObject({ id: 'node-id', level: 'ok' });
  });

  it('is ok on macOS for a second entry of this folder in other letter case', async () => {
    const deps = await initialized({ os: 'darwin' });
    registerRoot(deps, HOME.toUpperCase(), 'demo');
    // The fake file system knows case, so the folder in capitals gets a config: the entry is not gone.
    deps.seed(`${HOME.toUpperCase()}/factory.yaml`, 'schema: 2\n');
    expect(await checkNodeId(deps, HOME, await inspectConfig(deps, HOME))).toMatchObject({ id: 'node-id', level: 'ok' });
  });

  it('does not check when the config is not valid', async () => {
    const deps = await initialized();
    deps.seed(`${HOME}/factory.yaml`, 'schema: [\n');
    expect(await checkNodeId(deps, HOME, await inspectConfig(deps, HOME))).toMatchObject({
      id: 'node-id',
      level: 'warn',
      text: expect.stringContaining('not checked'),
    });
  });

  it('is ok when no variable names a folder for the list', async () => {
    const deps = await initialized();
    const bare = { ...deps, env: { ...deps.env, XDG_STATE_HOME: undefined, HOME: undefined } };
    expect(await checkNodeId(bare, HOME, await inspectConfig(deps, HOME))).toMatchObject({ id: 'node-id', level: 'ok' });
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

  const probe = async (deps: FakeDeps) => checkChildren(deps, HOME, await inspectConfig(deps, HOME));

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

  it('fails for a child that holds another id, and names the child and the fixed reason only', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }]));
    childAt(deps, '/w/web-factory', 'stranger', 1);
    const result = await probe(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toBe(`mismatch: web (${childReasons.otherId})`);
  });

  it('fails and lists both problems when one child holds another id and another is unknown', async () => {
    const deps = makeDeps();
    writeConfig(deps, layer2With([{ id: 'web', address: 'file:///w/web-factory' }, { id: 'api', address: 'file:///w/api-factory' }]));
    childAt(deps, '/w/web-factory', 'stranger', 1);
    const result = await probe(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toBe(`mismatch: web (${childReasons.otherId}); unknown: api (no factory.yaml found there)`);
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

  describe('one id space for workers and children', () => {
    const webChild = [{ id: 'web', address: 'file:///w/web-factory' }];

    it('fails for a child with the id of a worker that has a record, and names the id', async () => {
      const deps = makeDeps();
      writeConfig(deps, layer2With(webChild));
      childAt(deps, '/w/web-factory', 'web', 1);
      const written = await writeWorkerRecord(deps, HOME, {
        id: 'web',
        project: 'web',
        workCopy: `${HOME}/work-copies/web/web`,
        branch: 'worker/web',
      });
      expect(written.ok).toBe(true);
      expect(await probe(deps)).toEqual({
        id: 'children',
        level: 'fail',
        text: 'id overlap: web is the id of a child and of a worker',
      });
    });

    it('fails for a child with the id of a worker that the config names', async () => {
      const deps = makeDeps();
      const config = layer2With(webChild);
      writeConfig(deps, { ...config, core: { ...config.core, workers: { web: { proxy: 'none' } } } });
      childAt(deps, '/w/web-factory', 'web', 1);
      expect(await probe(deps)).toMatchObject({ level: 'fail', text: 'id overlap: web is the id of a child and of a worker' });
    });

    it('fails for a child with the name of a worker folder that holds a record that is not valid', async () => {
      const deps = makeDeps();
      writeConfig(deps, layer2With(webChild));
      childAt(deps, '/w/web-factory', 'web', 1);
      deps.seed(workerPathsOf(HOME, 'web').recordFile, 'not json');
      expect((await probe(deps)).level).toBe('fail');
    });

    it('stays ok when the worker ids and the child ids differ', async () => {
      const deps = makeDeps();
      writeConfig(deps, layer2With(webChild));
      childAt(deps, '/w/web-factory', 'web', 1);
      const written = await writeWorkerRecord(deps, HOME, {
        id: 'alpha',
        project: 'web',
        workCopy: `${HOME}/work-copies/web/alpha`,
        branch: 'worker/alpha',
      });
      expect(written.ok).toBe(true);
      expect((await probe(deps)).level).toBe('ok');
    });
  });
});

describe('doctor: state repository', () => {
  it('fails when the state folder is not a git repository', async () => {
    const deps = await initialized();
    expect((await deps.fs.remove(`${HOME}/.factory/.git`)).ok).toBe(true);
    expect(await checkStateRepo(deps, HOME)).toMatchObject({ id: 'state-repo', level: 'fail' });
  });

  it('is ok with a commit and an identity', async () => {
    const deps = await initialized({ git: { committed: [`${HOME}/.factory`] } });
    expect((await checkStateRepo(deps, HOME)).level).toBe('ok');
  });

  it('warns about a missing commit and a missing identity, and repeats both', async () => {
    const deps = await initialized({ git: { identity: false } });
    const result = await checkStateRepo(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('no commit yet');
    expect(result.text).toContain('no git identity');
  });

  it('warns when git is missing', async () => {
    const deps = await initialized({ tools: ['tmux'] });
    expect((await checkStateRepo(deps, HOME)).text).toContain('git is missing');
  });
});

describe('doctor: the delete guard of the state repository', () => {
  const HOOK = `${HOME}/.factory/.git/factory-guard/pre-commit`;

  it('is ok when init left the guard on', async () => {
    const deps = await initialized({ git: GUARD_ON });
    expect(await checkStateGuard(deps, HOME)).toMatchObject({ id: 'state-guard', level: 'ok' });
  });

  it('warns with the reason and the remedy when the guard is off, and never fails', async () => {
    const deps = await initialized({ git: GUARD_ON });
    deps.files.set(HOOK, '#!/bin/sh\nexit 0\n');
    const result = await checkStateGuard(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('The delete guard of .factory is off');
    expect(result.text).toContain('differs from the text of the package');
    expect(result.text).toContain('Run "factory upgrade".');
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'state-guard')).toBe('warn');
    expect(output.failed).toBe(false);
  });

  it('names the cause and the step by hand, and not factory upgrade, when the .git entry of the state folder is a link', async () => {
    const deps = await initialized({ git: GUARD_ON });
    const linked: Deps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (path === `${HOME}/.factory/.git` ? ok('link' as const) : deps.fs.lstat(path)) },
    };
    const result = await checkStateGuard(linked, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('The delete guard of .factory is off: the git folder of .factory is not the folder .git inside it.');
    expect(result.text).toContain('Make .factory/.git the git folder of .factory.');
    expect(result.text).not.toContain('factory upgrade');
  });

  it('warns when the setting that names the guard folder is not set', async () => {
    const deps = await initialized();
    const unset: Deps = {
      ...deps,
      run: async (command, args, options) =>
        command === 'git' && args.at(-2) === 'config' && args.at(-1) === 'core.hooksPath' ? exited(1) : deps.run(command, args, options),
    };
    const result = await checkStateGuard(unset, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('core.hooksPath is not set');
  });

  it('says that it did not check when the state folder is not a git repository', async () => {
    const deps = await initialized();
    expect((await deps.fs.remove(`${HOME}/.factory/.git`)).ok).toBe(true);
    expect(await checkStateGuard(deps, HOME)).toMatchObject({ id: 'state-guard', level: 'warn', text: expect.stringContaining('not checked') });
  });

  it('says that it did not check when git is missing', async () => {
    const deps = await initialized({ tools: ['tmux'] });
    expect(await checkStateGuard(deps, HOME)).toMatchObject({ level: 'warn', text: expect.stringContaining('git is missing') });
  });

  it('warns that it cannot check, and does not call the guard on, when git fails', async () => {
    const deps = await initialized();
    const broken = { ...deps, run: async () => failure('cannot run git: EACCES') };
    const result = await checkStateGuard(broken, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('The delete guard of .factory is not checked');
    expect(result.text).toContain('EACCES');
  });
});

describe('doctor: the size of the board files', () => {
  const STATE = `${HOME}/.factory`;
  const PATHS = {
    board: `${STATE}/${files.board}`,
    waiting: `${STATE}/${files.waiting}`,
    decisionLog: `${STATE}/${files.decisionLog}`,
  } as const;
  /** The first size that reaches the share of the cap, and the last size below it. */
  const WARN_AT = Math.ceil((maxFileBytes * boardWarnPercent) / 100);
  const bytes = (size: number): string => 'x'.repeat(size);

  it('passes with the board files that init made', async () => {
    const deps = await initialized();
    expect(await checkBoardSize(deps, HOME)).toMatchObject({ id: 'board-size', level: 'ok' });
  });

  it('passes for a board file one byte below 80 percent of the cap', async () => {
    const deps = await initialized();
    deps.files.set(PATHS.board, bytes(WARN_AT - 1));
    expect(await checkBoardSize(deps, HOME)).toMatchObject({ level: 'ok' });
  });

  it('warns for a board file at 80 percent of the cap, and names it', async () => {
    const deps = await initialized();
    deps.files.set(PATHS.board, bytes(WARN_AT));
    const result = await checkBoardSize(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`${files.board} is ${WARN_AT} bytes (80 percent of the cap)`);
    expect(result.text).not.toContain(files.waiting);
    expect(result.text).not.toContain(files.decisionLog);
  });

  it.each([
    ['the waiting file', 'waiting', files.waiting],
    ['the decision log', 'decisionLog', files.decisionLog],
  ] as const)('warns for %s at 80 percent of the cap, and names only that file', async (_label, key, name) => {
    const deps = await initialized();
    deps.files.set(PATHS[key], bytes(WARN_AT));
    const result = await checkBoardSize(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(name);
    expect(result.text.match(/\.json/g)).toHaveLength(1);
  });

  it('names each of the three files that reach 80 percent of the cap', async () => {
    const deps = await initialized();
    for (const path of Object.values(PATHS)) deps.files.set(path, bytes(WARN_AT));
    const result = await checkBoardSize(deps, HOME);
    expect(result.level).toBe('warn');
    for (const name of [files.board, files.waiting, files.decisionLog]) expect(result.text).toContain(name);
  });

  it('warns for a board file above the cap, which no command can read', async () => {
    const deps = await initialized();
    deps.files.set(PATHS.board, bytes(maxFileBytes + 1));
    const result = await checkBoardSize(deps, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(`${files.board} is ${maxFileBytes + 1} bytes`);
  });

  it('passes for a factory with no board files', async () => {
    const deps = await initialized();
    for (const path of Object.values(PATHS)) expect((await deps.fs.remove(path)).ok).toBe(true);
    expect(await checkBoardSize(deps, HOME)).toMatchObject({ level: 'ok' });
  });

  it('warns that it did not check, and does not fail, when the size of a file cannot be read', async () => {
    const deps = await initialized();
    const broken: Deps = { ...deps, fs: { ...deps.fs, statInfo: async () => failure('cannot read the size: EACCES') } };
    const result = await checkBoardSize(broken, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('not checked');
    expect(result.text).toContain('EACCES');
  });

  it('shows as a warning in the command, and the command is not failed', async () => {
    const deps = await initialized();
    deps.files.set(PATHS.board, bytes(WARN_AT));
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'board-size')).toBe('warn');
    expect(output.json).toMatchObject({ summary: { fail: 0 } });
    expect(output.failed).toBe(false);
  });
});

describe('doctor: the lessons file of the coordinator', () => {
  const LESSONS = `${HOME}/.factory/${files.lessons}`;
  /** `count` entries: each has a Rule line, a Why line and a How line. */
  const entries = (count: number): string =>
    Array.from({ length: count }, (_unused, index) => `${lessonLimits.entryMark} rule ${index}\nWhy: a reason\nHow: a step\n`).join('\n');

  it('passes when there is no lessons file yet', async () => {
    const deps = await initialized();
    expect(await checkLessons(deps, HOME)).toMatchObject({ id: 'lessons', level: 'ok' });
  });

  it('passes for a file with 40 entries, and counts the lines that start with Rule: only', async () => {
    const deps = await initialized();
    deps.files.set(LESSONS, entries(lessonLimits.maxEntries));
    expect(await checkLessons(deps, HOME)).toMatchObject({ level: 'ok' });
  });

  it('fails for a file with 41 entries, names the limit and the remedy, and leaves the file as it was', async () => {
    const deps = await initialized();
    const text = entries(lessonLimits.maxEntries + 1);
    deps.files.set(LESSONS, text);
    const result = await checkLessons(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain(`${dirs.state}/${files.lessons} holds 41 entries`);
    expect(result.text).toContain(`more than ${lessonLimits.maxEntries}`);
    expect(result.text).toContain('Remove old entries');
    expect(deps.files.get(LESSONS)).toBe(text);
  });

  it('passes for a file of exactly the size cap, and fails for a file of one byte more', async () => {
    const deps = await initialized();
    const atCap = `${entries(1)}${'x'.repeat(lessonLimits.maxBytes - entries(1).length)}`;
    expect(atCap.length).toBe(lessonLimits.maxBytes);
    deps.files.set(LESSONS, atCap);
    expect(await checkLessons(deps, HOME)).toMatchObject({ level: 'ok' });
    deps.files.set(LESSONS, `${atCap}x`);
    const result = await checkLessons(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain(`${lessonLimits.maxBytes + 1} bytes`);
    expect(result.text).toContain(`more than ${lessonLimits.maxBytes} bytes`);
    expect(deps.files.get(LESSONS)).toBe(`${atCap}x`);
  });

  it('fails for a link, also when the target is a good file, and reads nothing through the link', async () => {
    const TARGET = '/elsewhere/lessons.md';
    const deps = await initialized({ links: { [LESSONS]: TARGET } });
    deps.seed(TARGET, entries(1));
    const result = await checkLessons(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain(`${dirs.state}/${files.lessons} is a link`);
    expect(result.text).toContain('Replace it with a plain file');
    expect(deps.files.get(TARGET)).toBe(entries(1));
  });

  it('fails for a folder at the path of the file', async () => {
    const deps = await initialized();
    deps.seedDir(LESSONS);
    const result = await checkLessons(deps, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('is not a plain file');
  });

  it('fails, and does not pass, when the file cannot be looked at', async () => {
    const deps = await initialized();
    const broken: Deps = { ...deps, fs: { ...deps.fs, lstatInfo: async () => failure('cannot look at the file: EACCES') } };
    const result = await checkLessons(broken, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('EACCES');
  });

  it('fails, and does not pass, when the file cannot be read', async () => {
    const deps = await initialized();
    deps.files.set(LESSONS, entries(1));
    const broken: Deps = { ...deps, fs: { ...deps.fs, readTextLimited: async () => failure('cannot read the file: EIO') } };
    const result = await checkLessons(broken, HOME);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('EIO');
  });

  it('shows as a failure in the command, and the command is failed', async () => {
    const deps = await initialized();
    deps.files.set(LESSONS, entries(lessonLimits.maxEntries + 1));
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'lessons')).toBe('fail');
    expect(output.failed).toBe(true);
  });
});

describe('doctor: projects', () => {
  const withProject = (deps: FakeDeps) => {
    writeConfig(deps, sampleConfig());
    return inspectConfig(deps, HOME);
  };

  it('is ok when each project path is a git work tree', async () => {
    const deps = makeDeps({ git: { repos: { '/w/node/web': {} } } });
    expect(await checkProjects(deps, HOME, await withProject(deps))).toMatchObject({ id: 'projects', level: 'ok' });
  });

  it('fails and names the project when the path is not a git work tree', async () => {
    const deps = makeDeps();
    const result = await checkProjects(deps, HOME, await withProject(deps));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('web (web)');
  });

  it('is ok for a config without projects, and warns when the config is not valid', async () => {
    const deps = await initialized();
    expect((await checkProjects(deps, HOME, await inspectConfig(deps, HOME))).text).toBe('no project is configured');
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect((await checkProjects(deps, HOME, await inspectConfig(deps, HOME))).level).toBe('warn');
  });
});

describe('doctor: projects that the factory can not share', () => {
  const WEB = sampleConfig().recipe.projects[0]!;
  const configWith = (projects: readonly Record<string, unknown>[], sources: Record<string, string> = {}): FactoryConfig => {
    const sample = sampleConfig();
    return {
      entry: sample.entry,
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

  it('warns once per project with no URL, and names the project and the fix', async () => {
    const { state } = await stateOf(configWith([noUrl('lib', 'lib'), WEB, noUrl('tool', 'tool')]));
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
    const { state, deps } = await stateOf(configWith([noUrl('lib', 'lib')], { lib: '/srv/code/lib' }));
    const [result] = checkProjectUrls(state);
    expect(result?.text).toContain('Add an origin to the repo (/srv/code/lib) and set url');
    expect(deps.files.get(`${HOME}/factory.yaml`)).not.toContain('/srv/code/lib');
  });

  it('finds the source when the key writes the project path another way', async () => {
    const { state } = await stateOf(configWith([noUrl('lib', 'lib')], { 'lib/': '/srv/code/lib' }));
    expect(checkProjectUrls(state)[0]?.text).toContain('(/srv/code/lib)');
  });

  it('is not checked when the config is not valid', async () => {
    const deps = makeDeps();
    deps.files.set(`${HOME}/factory.yaml`, 'x: 1\n');
    expect(checkProjectUrls(await inspectConfig(deps, HOME))).toMatchObject([{ id: 'project-urls', level: 'warn' }]);
  });

  it('warns in the command, does not fail it, and sets no exit code', async () => {
    const deps = makeDeps({ git: { repos: { '/w/node/lib': {} } } });
    writeConfig(deps, configWith([noUrl('lib', 'lib')]));
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'project-urls:lib')).toBe('warn');
    expect(output.lines.some((line) => line.level === 'warn' && line.text.includes('cannot be shared'))).toBe(true);
    expect(output.exitCode).toBeUndefined();
  });

  it('fails the config check for a URL with a token, and prints no part of the token', async () => {
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

describe('doctor: a pulled change in the shared file of a registered root (S-S1)', () => {
  const ADDRESS = '203.0.113.9:8080';
  const PROXY_ENTRY = `proxies:\n  - id: pulled\n    base_url: "http://${ADDRESS}/v1"\n    health: /health\n`;

  /** A registered root whose shared file got a change from a pull. The fake fetch answers 200 to any request. */
  const pulledRoot = async (change: (shared: string) => string): Promise<FakeDeps> => {
    const deps = await initialized({ fetch: () => ok({ status: 200 }), git: { committed: [`${HOME}/.factory`] } });
    deps.seedDir(`${HOME}/.factory/.git`);
    const path = `${HOME}/factory.yaml`;
    deps.files.set(path, change(deps.files.get(path) ?? ''));
    return deps;
  };

  it.each([
    ['a proxies entry', (shared: string) => `${shared}${PROXY_ENTRY}`, 'proxies: is a local key'],
    [
      'the proxy of the session',
      (shared: string) => shared.replace('  model: default\n', `  model: default\n  proxy: pulled\n`),
      'session.proxy: is a local key',
    ],
  ])('fails the config check for %s, names the key and the local file, sends no request and prints no address', async (_name, change, key) => {
    const deps = await pulledRoot(change);
    const output = await doctor(deps);
    const checks = output.json['checks'] as CheckResult[];
    const config = checks.find((check) => check.id === 'config');
    expect(config?.level).toBe('fail');
    expect(config?.text).toContain(key);
    expect(config?.text).toContain('factory.local.yaml');
    expect(output.failed).toBe(true);
    expect(deps.fetched).toEqual([]);
    expect(checks.find((check) => check.id === 'proxy')).toMatchObject({
      level: 'warn',
      text: 'not checked: a check of the factory folder failed, so no health check went to a proxy',
    });
    expect(checks.find((check) => check.id === 'root-repo')?.text).toContain(
      'the setup text cannot be checked against the setup acceptance, because factory.yaml is not valid',
    );
    expect(checks.some((check) => check.id.startsWith('proxy:'))).toBe(false);
    const everything = JSON.stringify(output) + output.lines.map((line) => line.text).join('\n');
    expect(everything).not.toContain(ADDRESS);
    expect(everything).not.toContain('pulled');
  });
});

describe('doctor: instruction files at the root and above it', () => {
  /** The user home is another folder, so that the names in `.claude` count at every level above the root. */
  const withFiles = (...paths: readonly string[]): FakeDeps => {
    const deps = makeDeps({ env: { HOME: '/elsewhere/u' } });
    deps.seedDir(HOME);
    for (const path of paths) deps.seed(path, '');
    return deps;
  };
  const levels = [HOME, '/w', '/'];
  const spots = instructionFiles.flatMap((name) => levels.map((folder) => [name, folder] as const));

  it('is ok when no listed file is at the root or above it', async () => {
    const result = await checkInstructionFiles(withFiles(), HOME);
    expect(result).toMatchObject({ id: 'instruction-files', level: 'ok' });
  });

  it.each(spots)('warns with the check id for %s in %s', async (name, folder) => {
    const path = join(folder, name);
    const result = await checkInstructionFiles(withFiles(path), HOME);
    expect(result.id).toBe(checkIds.instructionFiles);
    expect(result.level).toBe('warn');
    expect(result.text).toContain(path);
  });

  it('names every file, from the root up, in one warning', async () => {
    const root = `${HOME}/CLAUDE.local.md`;
    const parent = '/w/AGENTS.md';
    const top = '/GEMINI.md';
    const result = await checkInstructionFiles(withFiles(top, parent, root), HOME);
    expect(result.level).toBe('warn');
    const positions = [root, parent, top].map((path) => result.text.indexOf(path));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('warns and does not fail when a folder above the root can not be read', async () => {
    const deps = withFiles();
    const unreadable: Deps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (dirname(path) === '/w' ? failure(`cannot stat ${path}: EACCES`) : deps.fs.lstat(path)) },
    };
    const result = await checkInstructionFiles(unreadable, HOME);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('/w');
    expect(result.text).toContain('EACCES');
  });

  it('warns that the walk stopped at 64 folders', async () => {
    const deep = `/${Array.from({ length: 70 }, (_, index) => `d${index}`).join('/')}`;
    const deps = withFiles();
    deps.seedDir(deep);
    const result = await checkInstructionFiles(deps, deep);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('64');
  });

  it('does not look inside the user Claude folder', async () => {
    const deps = makeDeps({ env: { HOME: '/w' } });
    deps.seedDir(HOME);
    deps.seed('/w/.claude/CLAUDE.md', '');
    deps.seed('/w/.claude/settings.json', '');
    const seen: string[] = [];
    const result = await checkInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), HOME);
    expect(result.level).toBe('ok');
    expect(seen.filter((path) => path === '/w/.claude' || path.startsWith('/w/.claude/'))).toEqual([]);
  });

  it('shows a warning line in the doctor command that does not fail it', async () => {
    const deps = await initialized({ env: { HOME: '/elsewhere/u' } });
    deps.seed('/w/AGENTS.md', '');
    deps.seedDir(`${HOME}/.factory/.git`);
    const output = await doctor(deps);
    const checks = output.json['checks'] as CheckResult[];
    expect(levelOf(checks, 'instruction-files')).toBe('warn');
    expect(output.lines.some((line) => line.level === 'warn' && line.text.startsWith('instruction-files') && line.text.includes('/w/AGENTS.md'))).toBe(true);
    expect(output.failed).toBe(false);
    expect(output.json['summary']).toMatchObject({ fail: 0 });
  });

  it('gives the same text as the warning that start and init print', async () => {
    const deps = withFiles('/w/CLAUDE.md');
    const result = await checkInstructionFiles(deps, HOME);
    const lines = instructionFileWarnings(await scanInstructionFiles(deps, HOME));
    expect(result.text).toBe(lines.join(' '));
  });
});

describe('doctor: the command', () => {
  it('passes on a fresh node: no failure, so it is not failed', async () => {
    const deps = await initialized({ git: { ...GUARD_ON, repos: { [HOME]: {} }, committed: [`${HOME}/.factory`] } });
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
      'node-id',
      'blocks',
      'setup-text',
      'role-delivery',
      'roles',
      'tracker',
      'children',
      'secrets',
      'root-repo',
      'root-files',
      'project-paths',
      'permission-mode',
      'delegations',
      'instruction-files',
      'proxy-env',
      'proxy',
      'tools',
      'agent-version',
      'state-repo',
      'state-guard',
      'board-size',
      'lessons',
      'projects',
      'project-urls',
    ]);
    expect(output.lines.at(-1)?.text).toBe('31 ok, 0 warnings, 0 failures');
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
    expect(output.lines.filter((line) => line.level !== 'text')).toHaveLength(31);
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

  it('reports a failing run of git as a warning of the state repo and as a failed tools check, not as a crash', async () => {
    const deps = await initialized();
    deps.seedDir(`${HOME}/.factory/.git`);
    const broken = { ...deps, run: async () => failure('cannot run git: EACCES') };
    const result = await runDoctor(broken, { home: HOME });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checks = result.value.json['checks'] as CheckResult[];
    expect(levelOf(checks, 'state-repo')).toBe('warn');
    expect(checks.find((entry) => entry.id === 'tools')).toMatchObject({ level: 'fail', text: expect.stringContaining('cannot read the version of git') });
    expect(result.value.failed).toBe(true);
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

  describe('when the local file is a link', () => {
    const linkedLocal = async (): Promise<FakeDeps> => {
      const links: Record<string, string> = {};
      const deps = await initialized({ links });
      links[LOCAL] = '/outside/factory.local.yaml';
      return deps;
    };

    it('exits 4, fails the config and local file checks, and names one remedy', async () => {
      const deps = await linkedLocal();
      const run = await doctor(deps);
      expect(run.exitCode).toBe(4);
      expect(run.failed).toBe(true);
      const checks = run.json['checks'] as CheckResult[];
      expect(levelOf(checks, 'config')).toBe('fail');
      expect(levelOf(checks, 'local-file')).toBe('fail');
      const text = checks.find((result) => result.id === 'local-file')?.text ?? '';
      expect(text).toContain('factory.local.yaml is a link');
      expect(text).toContain('factory init');
    });

    it('changes no mode: a link is checked before the mode', async () => {
      const deps = await linkedLocal();
      deps.modes.set(LOCAL, 0o644);
      await doctor(deps);
      expect(deps.modes.get(LOCAL)).toBe(0o644);
    });
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('exits 4 for a local file with %s', async (_name, change) => {
    const deps = await initialized();
    change(deps);
    expect((await doctor(deps)).exitCode).toBe(4);
  });

  it('sets no exit code for a local file with read bits only: it warns', async () => {
    const deps = await initialized();
    deps.modes.set(LOCAL, 0o644);
    const run = await doctor(deps);
    expect(run.exitCode).toBeUndefined();
    expect(levelOf(run.json['checks'] as CheckResult[], 'local-file')).toBe('warn');
  });
});

describe('doctor: the setup text and the rendered blocks', () => {
  const SETUP = `${HOME}/setup/coordinator.md`;
  const SETUP_WORKER = `${HOME}/setup/roles/worker.md`;
  const WORKER_MD = `${HOME}/.factory/roles/worker.md`;
  const LOCAL = `${HOME}/factory.local.yaml`;
  const setupCheck = async (deps: FakeDeps): Promise<CheckResult> => checkSetupText(deps, HOME);

  it('is ok on a new node, where every line is in a block', async () => {
    const deps = await initialized();
    expect(await setupCheck(deps)).toMatchObject({ id: 'setup-text', level: 'ok' });
  });

  it('warns when coordinator/CLAUDE.md holds text outside its blocks that the setup file does not hold, and names the setup file', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, `My own rules.\nA second rule.\n\n${deps.files.get(CLAUDE_MD) ?? ''}`);
    const result = await setupCheck(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toBe(
      'coordinator/CLAUDE.md holds 2 lines outside its blocks that setup/coordinator.md does not hold. ' +
        'Only the setup folder travels. Move the text to setup/coordinator.md, then run "factory upgrade".',
    );
  });

  it('never prints the text of the person', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, `A private line.\n\n${deps.files.get(CLAUDE_MD) ?? ''}`);
    const run = await doctor(deps);
    expect(JSON.stringify(run)).not.toContain('A private line.');
    expect(levelOf(run.json['checks'] as CheckResult[], 'setup-text')).toBe('warn');
  });

  it('counts a line once when it is singular, and names no line that the setup file holds', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, `Shared rule.\nOnly here.\n\n${deps.files.get(CLAUDE_MD) ?? ''}`);
    deps.files.set(SETUP, 'Shared rule.\n');
    const result = await setupCheck(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('holds 1 line outside its blocks');
  });

  it('is ok when the setup file holds every line that stands outside the blocks', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, `Shared rule.\n\n${deps.files.get(CLAUDE_MD) ?? ''}`);
    deps.files.set(SETUP, 'Shared rule.\n');
    expect((await setupCheck(deps)).level).toBe('ok');
  });

  it('does not count the lines inside a block, edited or not', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, (deps.files.get(CLAUDE_MD) ?? '').replace('Coordinate. Do not produce.', 'Do as you like.'));
    expect((await setupCheck(deps)).level).toBe('ok');
  });

  it('checks the worker file too, and names the worker text of the setup folder', async () => {
    const deps = await initialized();
    deps.files.set(WORKER_MD, `Notes of mine.\n\n${deps.files.get(WORKER_MD) ?? ''}`);
    const result = await setupCheck(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('.factory/roles/worker.md holds 1 line outside its blocks that setup/roles/worker.md does not hold');
    expect(result.text).toContain('Move the text to setup/roles/worker.md');
    expect(result.text).not.toContain('coordinator/CLAUDE.md');
  });

  it('names both setup files when both rendered files hold such text', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, `One.\n\n${deps.files.get(CLAUDE_MD) ?? ''}`);
    deps.files.set(WORKER_MD, `Two.\n\n${deps.files.get(WORKER_MD) ?? ''}`);
    const result = await setupCheck(deps);
    expect(result.text).toContain('Move the text to setup/coordinator.md or to setup/roles/worker.md');
  });

  it('is ok when the rendered files are not there', async () => {
    const deps = await initialized();
    deps.files.delete(CLAUDE_MD);
    deps.files.delete(WORKER_MD);
    expect((await setupCheck(deps)).level).toBe('ok');
  });

  it('leaves a file with broken markers to the blocks check', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, '<!-- factory:begin x v1 sha256=zz -->\nLoose text.\n');
    expect((await setupCheck(deps)).level).toBe('ok');
  });

  it('fails, and reads nothing, when the setup text is a link', async () => {
    const links: Record<string, string> = {};
    const deps = await initialized({ links });
    links[SETUP] = '/outside/notes.md';
    const result = await setupCheck(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('setup/coordinator.md is a link');
    const blocks = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(blocks.level).toBe('fail');
    expect(blocks.text).toContain('setup/coordinator.md is a link');
  });

  it('fails the blocks check for a setup file that holds a block marker, and names the file', async () => {
    const deps = await initialized();
    deps.files.set(SETUP, '<!-- factory:begin coordinator v1 sha256=abc -->\n');
    const blocks = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(blocks.level).toBe('fail');
    expect(blocks.text).toContain('setup/coordinator.md holds a line that starts a managed block');
  });

  it('warns that an intact safety block is out of date after a prefix change in the local file, and names upgrade', async () => {
    const deps = await initialized();
    const before = deps.files.get(LOCAL) ?? '';
    expect(before).toContain('typed by');
    deps.files.set(LOCAL, before.replace('typed by', 'sent by'));
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('safety (out of date, in /w/node/coordinator/CLAUDE.md)');
    expect(result.text).toContain('Run "factory upgrade".');
  });

  it('warns that a setup block is out of date after a change of the setup file, and names upgrade', async () => {
    const deps = await initialized();
    deps.files.set(SETUP, 'A new shared rule.\n');
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('setup (out of date');
    expect(result.text).toContain('Run "factory upgrade".');
    expect(result.text).not.toContain('--overwrite');
  });

  it('warns that an edited setup block is put back by upgrade, and names the setup file', async () => {
    const deps = await initialized();
    deps.files.set(CLAUDE_MD, (deps.files.get(CLAUDE_MD) ?? '').replace('Write your own text', 'Changed by hand'));
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('setup (edited, in /w/node/coordinator/CLAUDE.md)');
    expect(result.text).toContain(
      'Move your edit to setup/coordinator.md, then run "factory upgrade". It puts back the text of that file and keeps the old text in a backup file.',
    );
    expect(result.text).not.toContain('--overwrite');
  });

  it('names the worker setup file for an edited setup-worker block', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/.factory/roles/worker.md`, (deps.files.get(`${HOME}/.factory/roles/worker.md`) ?? '').replace('Write your own text', 'Changed by hand'));
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('setup-worker (edited');
    expect(result.text).toContain('Move your edit to setup/roles/worker.md');
  });

  it('names a block under the old name of an earlier version, and not a missing block, after an upgrade kept it', async () => {
    const deps = await initialized();
    const worker = renderBlock({ name: 'protocol', version: 1, body: 'Old rules.' });
    if (!worker.ok) throw new Error(worker.error.message);
    deps.files.set(`${HOME}/.factory/roles/worker.md`, `${worker.value.replace('Old rules.', 'Edited rules.')}\n`);
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.text).toContain('protocol (edited, in /w/node/.factory/roles/worker.md): the layer of this node needs the block worker');
    expect(result.text).toContain('Run "factory upgrade --overwrite protocol" to replace it.');
    expect(result.text).not.toMatch(/(^|; )worker \(missing/);
  });

  it('warns that a setup block that is not there is added by upgrade', async () => {
    const deps = await initialized();
    const claude = deps.files.get(CLAUDE_MD) ?? '';
    deps.files.set(CLAUDE_MD, claude.slice(0, claude.indexOf('<!-- factory:begin setup')));
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('setup (missing');
    expect(result.text).toContain('Run "factory upgrade".');
  });

  it('counts the worker setup file as the source of the worker setup block', async () => {
    const deps = await initialized();
    deps.files.set(SETUP_WORKER, 'A rule for every worker.\n');
    const result = await checkNodeBlocks(deps, HOME, await inspectConfig(deps, HOME));
    expect(result.text).toContain('setup-worker (out of date');
  });
});

describe('doctor: the path from the setup text to the sessions of the workers', () => {
  const copyOf = (id: string, project = 'web'): string => `${HOME}/work-copies/${project}/${id}`;
  const SETUP_TEXT = 'Write tests first.\n';

  /** A worker with a valid record. Its work copy holds no file yet. */
  const withWorker = async (deps: FakeDeps, id: string, project = 'web'): Promise<string> => {
    const workCopy = copyOf(id, project);
    const written = await writeWorkerRecord(deps, HOME, { id, project, workCopy, branch: `worker/${id}` });
    expect(written.ok).toBe(true);
    return workCopy;
  };

  /** The hook settings file of a work copy, with these hooks. */
  const seedHooks = (deps: FakeDeps, workCopy: string, hooks: Record<string, unknown>): void =>
    deps.seed(settingsFileOf(workCopy), JSON.stringify({ hooks }));

  const without = (event: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(ownSettingsEntries.hooks).filter(([name]) => name !== event));

  /** The same files, with a link at each of these paths. A fake file system takes its links at creation. */
  const withLinks = (source: FakeDeps, links: Record<string, string>): FakeDeps => {
    const linked = makeDeps({ links });
    for (const [path, text] of source.files) linked.seed(path, text);
    for (const dir of source.dirs) linked.seedDir(dir);
    return linked;
  };

  const check = async (deps: FakeDeps): Promise<CheckResult> => checkRoleDelivery(deps, HOME, await inspectConfig(deps, HOME));

  it('is ok for a node with no worker, and names the cap and where the acceptance is kept, in words and with no path', async () => {
    const deps = await initialized();
    const result = await check(deps);
    expect(result).toMatchObject({ id: 'role-delivery', level: 'ok' });
    expect(result.text).toMatch(/^SessionStart hook in 0 of 0 work copies; role text \d+ of 9000 characters/);
    expect(result.text).toContain(files.setupAcceptances);
    expect(result.text).not.toContain('/state');
  });

  it('is ok when every work copy holds the hook, and counts the copies', async () => {
    const deps = await initialized();
    seedOwnHooks(deps, await withWorker(deps, 'alpha'));
    seedOwnHooks(deps, await withWorker(deps, 'beta', 'api'));
    const result = await check(deps);
    expect(result.level).toBe('ok');
    expect(result.text).toContain('SessionStart hook in 2 of 2 work copies');
  });

  it('gives the size of the accepted text in the line', async () => {
    const deps = await initialized();
    const sizeOf = (text: string): number => Number(/role text (\d+) of/.exec(text)?.[1]);
    seedAcceptedSetup(deps, HOME, `${'x'.repeat(100)}\n`);
    const short = sizeOf((await check(deps)).text);
    seedAcceptedSetup(deps, HOME, `${'x'.repeat(300)}\n`);
    expect(sizeOf((await check(deps)).text)).toBe(short + 200);
  });

  it('warns for a work copy with no hook settings, counts it out, and gives one remedy: start over with a new worker', async () => {
    const deps = await initialized();
    seedOwnHooks(deps, await withWorker(deps, 'alpha'));
    await withWorker(deps, 'beta');
    const result = await check(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('SessionStart hook in 1 of 2 work copies');
    expect(result.text).toContain('beta');
    expect(result.text).toContain('Run "factory dismiss beta", then "factory worker new beta --project web"');
    expect(result.text).not.toContain('factory worker resume');
  });

  it('warns for a work copy that lacks only the SessionStart hook, and the remedy is upgrade, then resume', async () => {
    const deps = await initialized();
    seedHooks(deps, await withWorker(deps, 'alpha'), without('SessionStart'));
    const result = await check(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('SessionStart hook in 0 of 1 work copies');
    expect(result.text).toContain('Run "factory upgrade", then "factory worker resume alpha".');
    expect(result.text).not.toContain('factory dismiss');
  });

  it('counts a SessionStart hook under the startup matcher only as missing', async () => {
    const deps = await initialized();
    const hooks = { ...ownSettingsEntries.hooks, SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'factory hook SessionStart' }] }] };
    seedHooks(deps, await withWorker(deps, 'alpha'), hooks);
    const result = await check(deps);
    expect(result.level).toBe('warn');
    expect(result.text).toContain('SessionStart hook in 0 of 1 work copies');
  });

  it('does not warn for a work copy that lacks another hook: the check is about the role text', async () => {
    const deps = await initialized();
    seedHooks(deps, await withWorker(deps, 'alpha'), without('PreToolUse'));
    expect(await check(deps)).toMatchObject({ level: 'ok' });
  });

  it('warns for hook settings that are a link, reads nothing through the link, and names the link in its remedy', async () => {
    const TARGET = '/elsewhere/settings.json';
    const plain = await initialized();
    await withWorker(plain, 'alpha');
    plain.seedDir(`${copyOf('alpha')}/.claude`);
    plain.seed(TARGET, OWN_SETTINGS_TEXT);
    const result = await check(withLinks(plain, { [settingsFileOf(copyOf('alpha'))]: TARGET }));
    expect(result.level).toBe('warn');
    expect(result.text).toContain('SessionStart hook in 0 of 1 work copies');
    expect(result.text).toContain('Replace the hook settings file of alpha with a plain file');
  });

  it('fails for a setup text that the owner did not accept, and the one remedy accepts it and runs the check again', async () => {
    const deps = await initialized();
    seedUnacceptedSetup(deps, HOME, SETUP_TEXT);
    const result = await check(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('role text refused: the setup file is not accepted');
    expect(result.text).toContain('run "factory doctor" again.');
    expect(result.text).not.toContain(SETUP_TEXT.trim());
  });

  it('fails for a text above the cap, and names its size and the cap', async () => {
    const deps = await initialized();
    seedAcceptedSetup(deps, HOME, `${'x'.repeat(roleText.maxChars - 500)}\n`);
    const result = await check(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toMatch(/the role text has \d+ characters, and the cap is 9000 characters\. Shorten setup\/roles\/worker\.md to \d+ characters or fewer/);
  });

  it('fails for a setup file that is a link', async () => {
    const result = await check(withLinks(await initialized(), { [`${HOME}/setup/roles/worker.md`]: '/elsewhere/worker.md' }));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('role text refused: a link is in the path of the setup file');
  });

  it('fails for a role text fault, and still lists the work copy gaps with their remedies', async () => {
    const deps = await initialized();
    await withWorker(deps, 'alpha');
    seedUnacceptedSetup(deps, HOME, SETUP_TEXT);
    const result = await check(deps);
    expect(result.level).toBe('fail');
    expect(result.text).toContain('SessionStart hook in 0 of 1 work copies');
    expect(result.text).toContain('role text refused: the setup file is not accepted');
    expect(result.text).toContain('Run "factory dismiss alpha"');
  });

  describe('a work copy whose hook settings cannot be read', () => {
    /** The same files, with a read fault on the settings folder of this work copy. */
    const unreadable = (deps: FakeDeps, workCopy: string): FakeDeps => ({
      ...deps,
      fs: {
        ...deps.fs,
        lstat: async (path) => (path.startsWith(`${workCopy}/.claude`) ? failure('the folder cannot be read') : deps.fs.lstat(path)),
      },
    });

    it('warns, counts the copy out, and gives one remedy', async () => {
      const deps = await initialized();
      seedOwnHooks(deps, await withWorker(deps, 'alpha'));
      const beta = await withWorker(deps, 'beta');
      seedOwnHooks(deps, beta);
      const result = await check(unreadable(deps, beta));
      expect(result.level).toBe('warn');
      expect(result.text).toContain('SessionStart hook in 1 of 2 work copies');
      expect(result.text).toContain('beta: the hook settings of the work copy are not checked (the folder cannot be read).');
      expect(result.text).toContain('Make the hook settings of beta readable, then run "factory doctor" again.');
    });

    it('still fails for a role text fault', async () => {
      const deps = await initialized();
      const alpha = await withWorker(deps, 'alpha');
      seedOwnHooks(deps, alpha);
      seedUnacceptedSetup(deps, HOME, SETUP_TEXT);
      const result = await check(unreadable(deps, alpha));
      expect(result.level).toBe('fail');
      expect(result.text).toContain('role text refused: the setup file is not accepted');
      expect(result.text).toContain('alpha: the hook settings of the work copy are not checked');
    });
  });

  it('is ok for a layer with no worker file, and reads no work copy', async () => {
    const deps = await initialized();
    const config = await inspectConfig(deps, HOME);
    if (config.kind !== 'valid') throw new Error('the config is not valid');
    const bare = { ...config, value: { ...config.value, entry: { ...config.value.entry, roles: { ...config.value.entry.roles, templateFor: () => null } } } };
    const result = await checkRoleDelivery(deps, HOME, bare);
    expect(result).toMatchObject({ id: 'role-delivery', level: 'ok' });
    expect(result.text).toContain('no worker file');
  });

  it('is not checked when the config is not valid', async () => {
    const deps = await initialized();
    deps.files.set(`${HOME}/factory.yaml`, 'schema: 2\n');
    expect(await checkRoleDelivery(deps, HOME, await inspectConfig(deps, HOME))).toMatchObject({ id: 'role-delivery', level: 'warn' });
  });

  it('fails when the list of the workers cannot be read', async () => {
    const result = await check(withLinks(await initialized(), { [layoutOf(HOME).workersDir]: '/elsewhere/workers' }));
    expect(result.level).toBe('fail');
    expect(result.text).toContain('is a link');
  });

  it('writes nothing', async () => {
    const deps = await initialized();
    await withWorker(deps, 'alpha');
    seedUnacceptedSetup(deps, HOME, SETUP_TEXT);
    const before = new Map(deps.files);
    await check(deps);
    expect(deps.files).toEqual(before);
  });

  it('shows in the doctor command as a failure for a role text fault', async () => {
    const deps = await initialized();
    seedUnacceptedSetup(deps, HOME, SETUP_TEXT);
    const output = await doctor(deps);
    expect(levelOf(output.json['checks'] as CheckResult[], 'role-delivery')).toBe('fail');
    expect(output.failed).toBe(true);
  });
});
