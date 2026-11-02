import { join, resolve } from 'node:path';
import { inspectBlocks, NO_PENDING_FILES, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import type { CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { probeChildren } from '../comms/children.js';
import { fileTransport } from '../comms/transport.js';
import { inspectConfig } from '../config/load.js';
import { CONFIG_SCHEMA_VERSION, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { hasCommit, hasIdentity, isWorkTreeRoot } from '../core/git.js';
import { locateHomeFolder, type LocatedHome } from '../core/home.js';
import { goneHomes, indexPathOf, readHomeIndex } from '../core/home-index.js';
import { ok } from '../core/result.js';
import { isTmuxNewEnough, MIN_TMUX, onPath, tmuxVersionOf, toolNames } from '../core/tools.js';
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
import { blockTemplatesFor, roleBlockRenames } from '../templates/index.js';
import { checkHomeApart, checkHomeHoldsNoRepo, checkHomeLocation } from './init-home.js';

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

const UP_COMMAND = `"${commandText(commands.up)}" command`;

/** Programs that commands need. The text says which. */
const TOOLS: readonly { readonly name: string; readonly neededFor: string }[] = [
  { name: toolNames.git, neededFor: 'the state repository and the project checks' },
  { name: toolNames.tmux, neededFor: `the ${UP_COMMAND}` },
  { name: toolNames.gh, neededFor: 'the GitHub commands' },
  { name: toolNames.claude, neededFor: 'the launch of sessions' },
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

/**
 * The home is outside every git work tree and every other node home. When the config is valid, no project is the
 * home or inside it. These are the rules that `init` enforces, checked again for a home that was moved or edited.
 */
export const checkHome = async (deps: Deps, home: string, state: DocState<FactoryConfig>): Promise<CheckResult> => {
  const location = await checkHomeLocation(deps, home);
  if (!location.ok) return check(checkIds.home, 'fail', location.error.message);
  const holdsNoRepo = await checkHomeHoldsNoRepo(deps, home);
  if (!holdsNoRepo.ok) return check(checkIds.home, 'fail', holdsNoRepo.error.message);
  const where = `the ${roles.node} home is outside every git work tree and every other ${roles.node} home, and holds no git repo one level down`;
  if (state.kind !== 'valid') {
    return check(checkIds.home, 'ok', `${where}; the projects are not checked, because ${files.config} is not valid`);
  }
  const projects = state.value.recipe.projects.map((project) => resolve(home, project.path));
  const apart = await checkHomeApart(deps, home, projects);
  return apart.ok
    ? check(checkIds.home, 'ok', `${where}, and is apart from its projects`)
    : check(checkIds.home, 'fail', apart.error.message);
};

/**
 * The home index lets a command find a home from a project folder. An entry whose home is gone, and a file that
 * cannot be read, are warnings: the index is a cache, and a command that needs it says so.
 */
export const checkIndex = async (deps: Deps): Promise<CheckResult> => {
  const path = indexPathOf(deps.env);
  if (!path.ok) return check(checkIds.index, 'warn', path.error.message);
  if (path.value === null) {
    return check(checkIds.index, 'ok', `no home index is used: ${env.stateHome} and ${env.userHome} name no folder`);
  }
  const entries = await readHomeIndex(deps, path.value);
  if (!entries.ok) return check(checkIds.index, 'warn', `${path.value} cannot be read: ${entries.error}`);
  const gone = await goneHomes(deps, entries.value);
  if (gone.length > 0) {
    return check(
      checkIds.index,
      'warn',
      `the home index lists ${gone.join(', ')}, with no ${files.config}. Remove the ${plural(gone.length, 'entry', 'entries')} from ${path.value}.`,
    );
  }
  const count = entries.value.length;
  return check(checkIds.index, 'ok', `${count} ${plural(count, 'entry', 'entries')} in the home index, all present`);
};

/** Only the local tracker works in this version of factory. */
export const checkTracker = (state: DocState<FactoryConfig>): CheckResult => {
  if (state.kind !== 'valid') return notChecked(checkIds.tracker, `${files.config} is not valid`);
  const kind = state.value.core.tracker.kind;
  const name = `${keys.root.tracker}.${keys.tracker.kind}`;
  return kind === values.trackerLocal
    ? check(checkIds.tracker, 'ok', `${name} is ${kind}`)
    : check(checkIds.tracker, 'warn', `${name} is ${kind}: its connector comes in a later version of ${program}`);
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * Ping each child once. A child that does not answer is a warning, because a node can be off. A child on a layer other
 * than the one below this node is a failure, because the config is wrong.
 */
export const checkChildren = async (deps: Deps, state: DocState<FactoryConfig>): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.children, `${files.config} is not valid`);
  const { children, node } = state.value.core;
  if (children.length === 0) return check(checkIds.children, 'ok', 'no child is configured');

  const needed = node.layer - 1;
  const rows = await probeChildren(fileTransport(deps), children);
  const wrong = rows.flatMap((row) =>
    row.status === 'ok' && row.layer !== needed
      ? [`wrong layer: ${row.id} is on layer ${row.layer}, but layer ${needed} is needed`]
      : [],
  );
  const unknown = rows.flatMap((row) => (row.status === 'unknown' ? [`unknown: ${row.id} (${row.reason})`] : []));
  const problems = [...wrong, ...unknown];
  if (problems.length === 0) {
    return check(
      checkIds.children,
      'ok',
      `${rows.length} ${plural(rows.length, 'child answers', 'children answer')}, all on layer ${needed}`,
    );
  }
  return check(checkIds.children, wrong.length > 0 ? 'fail' : 'warn', problems.join('; '));
};

/** A block that is not as the layer needs it. A block under the name of another layer is a role block that does not match. */
const describeBlockProblem = (status: BlockStatus): string[] => {
  const old = renamedFromOf(status);
  if (old !== undefined) {
    return [`${old} (${status.kind}, in ${status.file}): the layer of this ${roles.node} needs the block ${status.template.name}`];
  }
  return status.kind === 'intact' ? [] : [`${status.template.name} (${status.kind}, in ${status.file})`];
};

export const checkBlocks = (statuses: readonly BlockStatus[]): CheckResult => {
  const problems = statuses.flatMap(describeBlockProblem);
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
  const userHome = deps.env[env.userHome];
  const userDir = userHome === undefined ? undefined : join(resolve(userHome), dirs.claude);
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

/** The blocks come from the layer of the node, so a config that is not valid gives no block list. */
export const checkNodeBlocks = async (
  deps: Deps,
  home: string,
  state: DocState<FactoryConfig>,
): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.blocks, `${files.config} is not valid`);
  const { layer } = state.value.core.node;
  const pending = { ...NO_PENDING_FILES, renames: roleBlockRenames(layer) };
  return checkBlocks(await inspectBlocks(deps, home, blockTemplatesFor(layer), pending));
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
  const { core } = state.value;
  const inUse = new Set([core.session.proxy, ...Object.values(core.cells).map((cell) => cell.proxy)]);
  inUse.delete(values.noProxy);
  const used = core.proxies.filter((proxy) => inUse.has(proxy.id));
  if (used.length === 0) return [check(checkIds.proxy, 'ok', 'no proxy is in use')];
  if (!mayRequest) {
    return [
      notChecked(
        checkIds.proxy,
        `the ${roles.node} home does not come from ${flagText(flags.home)} and is not the current folder. ` +
          `Run with ${flagText(flags.home)} DIR to check the proxy.`,
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

/** The problem of the tmux that is on PATH, or null: its version is not known, or it is older than the up command needs. */
const tmuxProblem = async (deps: Deps): Promise<string | null> => {
  const version = await tmuxVersionOf(deps);
  if (version === null) return `cannot read the version of ${toolNames.tmux}`;
  if (isTmuxNewEnough(version)) return null;
  const needed = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;
  return `${toolNames.tmux} ${version.major}.${version.minor} is older than ${needed} (the ${UP_COMMAND} needs ${needed} or newer)`;
};

export const checkTools = async (deps: Deps): Promise<CheckResult> => {
  const major = Number(/^v?(\d+)/.exec(deps.platform.nodeVersion)?.[1] ?? '0');
  if (major < MIN_NODE_MAJOR) {
    return check(checkIds.tools, 'fail', `Node.js ${MIN_NODE_MAJOR} or newer is needed, and this is Node.js ${major}`);
  }
  const missing: string[] = [];
  let tmuxFound = false;
  for (const tool of TOOLS) {
    if (!(await onPath(deps, tool.name))) missing.push(`${tool.name} (${tool.neededFor})`);
    else if (tool.name === toolNames.tmux) tmuxFound = true;
  }
  const problems = missing.length === 0 ? [] : [`missing: ${missing.join(', ')}`];
  const oldTmux = tmuxFound ? await tmuxProblem(deps) : null;
  if (oldTmux !== null) problems.push(oldTmux);
  return problems.length === 0
    ? check(checkIds.tools, 'ok', `Node.js ${major}, git, tmux, gh and claude are available`)
    : check(checkIds.tools, 'warn', problems.join('; '));
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
  const projects = state.value.recipe.projects;
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
  const [homeCheck, index, blocks, children, permission, proxies, tools, stateRepo, projects] = await Promise.all([
    checkHome(deps, home, config),
    checkIndex(deps),
    checkNodeBlocks(deps, home, config),
    checkChildren(deps, config),
    checkPermissionMode(deps, home),
    checkProxies(deps, config, source === 'flag' || source === 'cwd'),
    checkTools(deps),
    checkStateRepo(deps, home),
    checkProjects(deps, home, config),
  ]);
  return [
    checkConfig(config),
    checkConfigVersion(config),
    checkState(state),
    homeCheck,
    index,
    blocks,
    checkTracker(config),
    children,
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
  const located = await locateHomeFolder(deps, options.home);
  if (!located.ok) return located;
  const home = located.value.home;

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
