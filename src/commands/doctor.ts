import { delimiter, join, resolve } from 'node:path';
import { inspectBlocks, type BlockStatus } from '../blocks/status.js';
import { failure, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { inspectConfig } from '../config/load.js';
import { CONFIG_SCHEMA_VERSION, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { hasCommit, hasIdentity, isWorkTreeRoot } from '../core/git.js';
import { locateHome, type LocatedHome } from '../core/home.js';
import { ok } from '../core/result.js';
import type { DocState } from '../migrate/inspect.js';
import {
  checkIds,
  claudeSettings,
  commandText,
  commands,
  dirs,
  env,
  files,
  flags,
  flagText,
  keys,
  program,
  roles,
  schemaIds,
  values,
} from '../names.js';
import { checkProxyHealth } from '../safety/proxy.js';
import { findTokenPaths } from '../safety/secrets.js';
import { layoutOf } from '../state/layout.js';
import { inspectState, STATE_LABEL } from '../state/load.js';
import { STATE_SCHEMA_VERSION, type NodeState } from '../state/schema.js';
import { blockTemplates } from '../templates/index.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  readonly id: string;
  readonly level: CheckLevel;
  readonly text: string;
}

export interface DoctorOptions {
  readonly home: string | undefined;
}

const MIN_NODE_MAJOR = 22;
const MAX_PATH_ENTRIES = 256;

/** Programs that later commands need. The text says which. */
const TOOLS: readonly { readonly name: string; readonly neededFor: string }[] = [
  { name: 'git', neededFor: 'the state repository and the project checks' },
  { name: 'tmux', neededFor: `the ${roles.lane} commands` },
  { name: 'gh', neededFor: 'the GitHub commands' },
  { name: 'claude', neededFor: 'the launch of sessions' },
];

/** Patterns of Claude Code settings that skip the permission checks. */
const BYPASS_PATTERNS: readonly RegExp[] = [
  /bypassPermissions/,
  /dangerously-skip-permissions/,
  /"skipDangerousModePermissionPrompt"\s*:\s*true/,
  /"dangerouslySkipPermissions"\s*:\s*true/,
];

const check = (id: string, level: CheckLevel, text: string): CheckResult => ({ id, level, text });

const notChecked = (id: string, reason: string): CheckResult => check(id, 'warn', `not checked: ${reason}`);

export const checkConfig = (state: DocState<FactoryConfig>): CheckResult => {
  switch (state.kind) {
    case 'missing':
      return check(checkIds.config, 'fail', `${files.config} not found`);
    case 'unparsable':
      return check(checkIds.config, 'fail', `${files.config} does not parse: ${state.message}`);
    case 'invalid':
      return check(checkIds.config, 'fail', `${files.config} is invalid: ${state.message}`);
    case 'valid':
      return check(checkIds.config, 'ok', `${files.config} is valid`);
    case 'older':
    case 'newer':
      return check(checkIds.config, 'ok', `${files.config} parses; ${checkIds.configVersion} checks its version`);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

export const checkConfigVersion = (state: DocState<FactoryConfig>): CheckResult => {
  switch (state.kind) {
    case 'valid':
      return check(checkIds.configVersion, 'ok', `${keys.root.schema} ${CONFIG_SCHEMA_VERSION} is current`);
    case 'older':
    case 'newer':
      return check(checkIds.configVersion, 'fail', state.message);
    case 'missing':
    case 'unparsable':
    case 'invalid':
      return notChecked(checkIds.configVersion, `${files.config} is not valid`);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

export const checkState = (state: DocState<NodeState>): CheckResult => {
  switch (state.kind) {
    case 'missing':
      return check(checkIds.state, 'fail', `${STATE_LABEL} not found`);
    case 'unparsable':
      return check(checkIds.state, 'fail', `${STATE_LABEL} does not parse: ${state.message}`);
    case 'invalid':
      return check(checkIds.state, 'fail', `${STATE_LABEL} is invalid: ${state.message}`);
    case 'older':
    case 'newer':
      return check(checkIds.state, 'fail', state.message);
    case 'valid':
      return check(checkIds.state, 'ok', `${keys.root.schema} ${STATE_SCHEMA_VERSION} is current`);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

export const checkBlocks = (statuses: readonly BlockStatus[]): CheckResult => {
  const problems = statuses.flatMap((status) =>
    status.kind === 'intact' ? [] : [`${status.template.name} (${status.kind}, in ${status.file})`],
  );
  return problems.length === 0
    ? check(checkIds.blocks, 'ok', `${statuses.length} managed blocks are intact`)
    : check(
        checkIds.blocks,
        'warn',
        `${problems.join('; ')}. Move edits out of the block, then run "${commandText(commands.upgrade)}".`,
      );
};

export const checkSecrets = (state: DocState<FactoryConfig>): CheckResult => {
  if (state.kind === 'missing' || state.kind === 'unparsable') {
    return notChecked(checkIds.secrets, `${files.config} does not parse`);
  }
  const paths = findTokenPaths(state.raw);
  return paths.length === 0
    ? check(checkIds.secrets, 'ok', `no value in ${files.config} looks like a token`)
    : check(
        checkIds.secrets,
        'fail',
        `${paths.join(', ')} in ${files.config} look${paths.length === 1 ? 's' : ''} like a token. Remove it.`,
      );
};

export const checkPermissionMode = async (deps: Deps, home: string): Promise<CheckResult> => {
  const settingsDir = join(home, dirs.claude);
  const userDir = deps.env['HOME'] === undefined ? undefined : join(resolve(deps.env['HOME']), dirs.claude);
  if (userDir !== undefined && resolve(settingsDir) === userDir) {
    return notChecked(checkIds.permissionMode, `${settingsDir} holds the user settings of Claude Code`);
  }
  const folder = await deps.fs.stat(settingsDir);
  if (!folder.ok) return notChecked(checkIds.permissionMode, folder.error.message);
  if (folder.value === null) return check(checkIds.permissionMode, 'ok', `no ${dirs.claude} folder in the ${program} home`);
  const names = await deps.fs.list(settingsDir);
  if (!names.ok) return notChecked(checkIds.permissionMode, names.error.message);

  const settings = names.value.filter(
    (name) => name.startsWith(claudeSettings.prefix) && name.endsWith(claudeSettings.suffix),
  );
  const bad: string[] = [];
  const unreadable: string[] = [];
  for (const name of settings) {
    const text = await deps.fs.readText(join(settingsDir, name));
    if (!text.ok) unreadable.push(`${dirs.claude}/${name}`);
    else if (BYPASS_PATTERNS.some((pattern) => pattern.test(text.value))) bad.push(`${dirs.claude}/${name}`);
  }
  if (bad.length > 0) {
    return check(checkIds.permissionMode, 'fail', `${bad.join(', ')} skips the permission checks. Remove the setting.`);
  }
  return unreadable.length === 0
    ? check(checkIds.permissionMode, 'ok', 'no settings file skips the permission checks')
    : notChecked(checkIds.permissionMode, `cannot read ${unreadable.join(', ')}`);
};

export const checkProxyEnv = (deps: Deps): CheckResult => {
  const value = deps.env[env.proxyBaseUrl];
  return value === undefined || value === ''
    ? check(checkIds.proxyEnv, 'ok', `${env.proxyBaseUrl} is not set in the shell`)
    : check(checkIds.proxyEnv, 'warn', `${env.proxyBaseUrl} is set in the shell. ${program} clears it at launch.`);
};

/**
 * One health request for each proxy in use. When `mayRequest` is false, the config does not come from a place the
 * user chose, so its URLs are not requested.
 */
export const checkProxies = async (
  deps: Deps,
  state: DocState<FactoryConfig>,
  mayRequest: boolean,
): Promise<readonly CheckResult[]> => {
  if (state.kind !== 'valid') return [notChecked(checkIds.proxy, `${files.config} is not valid`)];
  const config = state.value;
  const inUse = new Set([config.session.proxy, ...Object.values(config.lanes).map((lane) => lane.proxy)]);
  inUse.delete(values.noProxy);
  const used = config.proxies.filter((proxy) => inUse.has(proxy.id));
  if (used.length === 0) return [check(checkIds.proxy, 'ok', 'no proxy is in use')];
  if (!mayRequest) {
    return [
      notChecked(
        checkIds.proxy,
        `${files.config} was found in a parent folder. Run with ${flagText(flags.home)} DIR to check the proxy.`,
      ),
    ];
  }

  return Promise.all(
    used.map(async (proxy): Promise<CheckResult> => {
      const id = `${checkIds.proxy}:${proxy.id}`;
      const health = await checkProxyHealth(deps, proxy);
      if (health.up) return check(id, 'ok', `${health.label} answers`);
      const fix = `Start the proxy, or set ${keys.session.proxy} to ${values.noProxy} for the session.`;
      return proxy.on_fail === values.onFail[1]
        ? check(id, 'warn', `${health.label} does not answer. ${keys.proxy.onFail} is ${proxy.on_fail}: sessions start without it.`)
        : check(id, 'fail', `${health.label} does not answer. ${fix}`);
    }),
  );
};

/** True when an executable file with this name is in a folder of PATH. */
const onPath = async (deps: Deps, name: string): Promise<boolean> => {
  const folders = (deps.env['PATH'] ?? '').split(delimiter).filter((folder) => folder !== '');
  for (const folder of folders.slice(0, MAX_PATH_ENTRIES)) {
    const kind = await deps.fs.stat(join(folder, name));
    if (kind.ok && kind.value === 'file') return true;
  }
  return false;
};

export const checkTools = async (deps: Deps): Promise<CheckResult> => {
  const major = Number(/^v?(\d+)/.exec(deps.platform.nodeVersion)?.[1] ?? '0');
  if (major < MIN_NODE_MAJOR) {
    return check(checkIds.tools, 'fail', `Node.js ${MIN_NODE_MAJOR} or newer is needed, and this is Node.js ${major}`);
  }
  const missing: string[] = [];
  for (const tool of TOOLS) {
    if (!(await onPath(deps, tool.name))) missing.push(`${tool.name} (${tool.neededFor})`);
  }
  return missing.length === 0
    ? check(checkIds.tools, 'ok', `Node.js ${major}, git, tmux, gh and claude are available`)
    : check(checkIds.tools, 'warn', `missing: ${missing.join(', ')}`);
};

export const checkStateRepo = async (deps: Deps, home: string): Promise<CheckResult> => {
  const stateDir = layoutOf(home).stateDir;
  const repo = await deps.fs.stat(join(stateDir, '.git'));
  if (!repo.ok || repo.value === null) {
    return check(checkIds.stateRepo, 'fail', `${dirs.state} is not a git repository`);
  }
  if (!(await onPath(deps, 'git'))) {
    return check(checkIds.stateRepo, 'warn', 'git is missing: the repository cannot be checked');
  }
  const problems: string[] = [];
  if (!(await hasCommit(deps, stateDir))) problems.push('no commit yet');
  if (!(await hasIdentity(deps, stateDir))) problems.push('no git identity (set user.name and user.email)');
  return problems.length === 0
    ? check(checkIds.stateRepo, 'ok', `${dirs.state} is a git repository with a commit`)
    : check(checkIds.stateRepo, 'warn', `${dirs.state}: ${problems.join('; ')}`);
};

export const checkProjects = async (
  deps: Deps,
  home: string,
  state: DocState<FactoryConfig>,
): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.projects, `${files.config} is not valid`);
  const projects = state.value.projects;
  const bad: string[] = [];
  for (const project of projects) {
    if (!(await isWorkTreeRoot(deps, resolve(home, project.path)))) bad.push(`${project.id} (${project.path})`);
  }
  if (projects.length === 0) return check(checkIds.projects, 'ok', 'no project is configured');
  return bad.length === 0
    ? check(checkIds.projects, 'ok', `${projects.length} project paths are git work trees`)
    : check(checkIds.projects, 'fail', `not a git work tree: ${bad.join(', ')}`);
};

const runChecks = async (deps: Deps, located: LocatedHome): Promise<readonly CheckResult[]> => {
  const { home, source } = located;
  const config = await inspectConfig(deps, home);
  const state = await inspectState(deps, home);
  const blocks = await inspectBlocks(deps, home, blockTemplates);
  const [permission, proxies, tools, stateRepo, projects] = await Promise.all([
    checkPermissionMode(deps, home),
    checkProxies(deps, config, source !== 'parent'),
    checkTools(deps),
    checkStateRepo(deps, home),
    checkProjects(deps, home, config),
  ]);
  return [
    checkConfig(config),
    checkConfigVersion(config),
    checkState(state),
    checkBlocks(blocks),
    checkSecrets(config),
    permission,
    checkProxyEnv(deps),
    ...proxies,
    tools,
    stateRepo,
    projects,
  ];
};

const count = (results: readonly CheckResult[], level: CheckLevel): number =>
  results.filter((result) => result.level === level).length;

export const runDoctor = async (deps: Deps, options: DoctorOptions): Promise<CliResult<CommandOutput>> => {
  const located = await locateHome(deps, options.home);
  if (!located.ok) return located;
  const home = located.value.home;
  const folder = await deps.fs.stat(home);
  if (!folder.ok) return folder;
  if (folder.value !== 'dir') return failure(`${home} is not a folder`);

  const results = await runChecks(deps, located.value);
  const summary = { ok: count(results, 'ok'), warn: count(results, 'warn'), fail: count(results, 'fail') };
  const width = Math.max(...results.map((result) => result.id.length));
  const lines: OutLine[] = [
    { level: 'text', text: `Config: ${layoutOf(home).configFile}` },
    ...results.map((result) => ({ level: result.level, text: `${result.id.padEnd(width)}  ${result.text}` })),
    {
      level: 'text',
      text: `${summary.ok} ok, ${summary.warn} warnings, ${summary.fail} failures`,
    },
  ];
  return ok({
    lines,
    json: { schema: schemaIds.doctor, home, ok: summary.fail === 0, summary, checks: results },
    warnings: [],
    failed: summary.fail > 0,
  });
};
