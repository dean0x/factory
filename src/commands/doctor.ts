import { join, resolve } from 'node:path';
import { linesOutsideBlocks, parseBlocks } from '../blocks/managed.js';
import { inspectBlocks, isSafetyStop, NO_PENDING_FILES, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { exitCodeOf, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { probeChildren } from '../comms/children.js';
import { fileTransport } from '../comms/transport.js';
import { inspectConfig, localFileAccess, readNodeIdentity, wideModeNote } from '../config/load.js';
import { folderKey } from '../config/primitives.js';
import { CONFIG_SCHEMA_VERSION, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { GIT_ENTRY, gitVersionProblem, hasCommit, hasIdentity, isWorkTreeRoot } from '../core/git.js';
import { locateHomeFolder } from '../core/home.js';
import { goneHomes, indexPathOf, readHomeIndex } from '../core/home-index.js';
import { folderKeyOf } from '../core/paths.js';
import { instructionFileWarnings, scanInstructionFiles } from '../core/instruction-files.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { requireNoRootLinks } from '../core/root-paths.js';
import {
  agentVersionOf,
  isAgentNewEnough,
  isTmuxNewEnough,
  MIN_AGENT_VERSION,
  MIN_TMUX,
  onPath,
  tmuxVersionOf,
  toolNames,
} from '../core/tools.js';
import { blockRenamesOf, fileSteps } from '../migrate/files.js';
import type { DocState } from '../migrate/inspect.js';
import {
  blockNames,
  boardWarnPercent,
  checkIds,
  commandText,
  commands,
  dirs,
  env,
  files,
  flags,
  flagText,
  homeIndex,
  keys,
  maxFileBytes,
  overwriteCommand,
  places,
  program,
  roles,
  schemaIds,
  setupBlockNames,
  setupFileOf,
  shareListLabel,
  values,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { checkProxyHealth } from '../safety/proxy.js';
import { findTokenPaths } from '../safety/secrets.js';
import { locateShareList } from '../state/files.js';
import { guardWarning } from '../state/guard.js';
import { layoutOf } from '../state/layout.js';
import { inspectState, STATE_LABEL } from '../state/load.js';
import { STATE_SCHEMA_VERSION, type NodeState } from '../state/schema.js';
import { readSetupFile, readSetupTexts } from '../state/setup-text.js';
import { blockInputOf, blockTemplatesFor, roleBlockRenames } from '../templates/index.js';
import { leftoverTempFolders, tempFolderWarning } from './init-home.js';
import { unsharedReasonOf, unsharedWarning } from './project-url.js';
import { hasRootFailure, rootCheckResults, scanRoot } from './root-content.js';

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

const START_COMMAND = `"${commandText(commands.start)}" command`;

/** Programs that commands need. The text says which. */
const TOOLS: readonly { readonly name: string; readonly neededFor: string }[] = [
  { name: toolNames.git, neededFor: 'the state repository and the project checks' },
  { name: toolNames.tmux, neededFor: `the ${START_COMMAND}` },
  { name: toolNames.gh, neededFor: 'the GitHub commands' },
  { name: toolNames.claude, neededFor: 'the launch of sessions' },
];

const check = (id: string, level: CheckLevel, text: string): CheckResult => ({ id, level, text });

const notChecked = (id: string, reason: string): CheckResult => check(id, 'warn', `not checked: ${reason}`);

/** The file that a state that is not valid is about. The shared file is the default. */
const fileOf = (state: Exclude<DocState<unknown>, { kind: 'valid' }>): string => state.file ?? files.config;

/** True when the shared file is there and the local file is not. A command that needs both exits 2 and names `init`. */
export const isLocalFileMissing = (state: DocState<FactoryConfig>): boolean =>
  state.kind === 'missing' && state.file === files.localConfig;

export const checkConfig = (state: DocState<FactoryConfig>): CheckResult => {
  switch (state.kind) {
    case 'missing':
      return isLocalFileMissing(state)
        ? check(
            checkIds.config,
            'fail',
            `${files.localConfig} not found. Run "${commandText(commands.init)} ${flagText(flags.home)} DIR" for this ${places.folder}.`,
          )
        : check(checkIds.config, 'fail', `${files.config} not found`);
    case 'unparsable':
      return check(checkIds.config, 'fail', `${fileOf(state)} does not parse: ${state.message}`);
    case 'invalid':
      return check(checkIds.config, 'fail', `${fileOf(state)} is invalid: ${state.message}`);
    case 'unsafe':
      return check(checkIds.config, 'fail', `${state.message}.${state.hint === undefined ? '' : ` ${state.hint}`}`);
    case 'valid':
      return check(checkIds.config, 'ok', `${files.config} and ${files.localConfig} are valid`);
    case 'older':
    case 'newer':
      return check(checkIds.config, 'ok', `${fileOf(state)} parses; ${checkIds.configVersion} checks its version`);
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
    case 'unsafe':
      return notChecked(checkIds.configVersion, `${fileOf(state)} is not valid`);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * The local file: mode 600, and the owner of the process owns it. A file of another account, or one that others can
 * write, fails. A file that others can read is a warning, and doctor changes no mode: it names the command.
 */
export const checkLocalFile = async (deps: Deps, home: string): Promise<CheckResult> => {
  const access = await localFileAccess(deps, home);
  if (!access.ok) {
    const { message, hint } = access.error;
    return check(checkIds.localFile, 'fail', `${message}.${hint === undefined ? '' : ` ${hint}`}`);
  }
  switch (access.value.kind) {
    case 'absent':
      return notChecked(checkIds.localFile, `${files.localConfig} not found`);
    case 'wide':
      return check(checkIds.localFile, 'warn', wideModeNote(access.value.mode, false));
    case 'private':
      return check(checkIds.localFile, 'ok', `${files.localConfig} has no group or other access`);
    default: {
      const unreachable: never = access.value;
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
    case 'unsafe':
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
 * The root is the top folder of a git work tree of its own, and its `.gitignore` holds the share list. A root that
 * breaks this rule is a warning: it is a layout problem and no security stop. The checks of tracked paths come later.
 */
export const checkRoot = async (deps: Deps, home: string): Promise<CheckResult> => {
  if (!(await onPath(deps, toolNames.git))) return notChecked(checkIds.root, `${toolNames.git} is missing`);
  const problems: string[] = [];
  if (!(await isWorkTreeRoot(deps, home))) {
    problems.push(`the ${places.folder} ${home} is not the top folder of a git work tree of its own. Run "git init" in it.`);
  }
  const { gitignoreFile } = layoutOf(home);
  const kind = await deps.fs.stat(gitignoreFile);
  if (!kind.ok) return notChecked(checkIds.root, kind.error.message);
  const text = kind.value === 'file' ? await deps.fs.readTextLimited(gitignoreFile, maxFileBytes) : null;
  if (text !== null && !text.ok) return notChecked(checkIds.root, text.error.message);
  const at = locateShareList(text === null ? '' : text.value);
  if (at.kind !== 'found' || !at.current) {
    problems.push(
      `${files.gitignore} has no intact ${shareListLabel}, the lines between the two marker lines. ` +
        `Copy the part from the ${files.gitignore} of a new ${places.folder} that "${commandText(commands.init)}" made.`,
    );
  }
  return problems.length === 0
    ? check(checkIds.root, 'ok', `the ${places.folder} is the top folder of its own git work tree and holds the ${shareListLabel}`)
    : check(checkIds.root, 'warn', problems.join(' '));
};

/** A temp folder of a stopped `init` is a warning. Nothing is removed. */
export const checkTempFolders = async (deps: Deps, home: string): Promise<CheckResult> => {
  const found = await leftoverTempFolders(deps, home);
  if (!found.ok) return notChecked(checkIds.tempFolder, found.error.message);
  return found.value.length === 0
    ? check(checkIds.tempFolder, 'ok', `no temp folder of a stopped ${commands.init} in the ${places.folder}`)
    : check(checkIds.tempFolder, 'warn', found.value.map(tempFolderWarning).join(' '));
};

/**
 * The home index lets a command find a home from a project folder. An entry whose home is gone, and a file that
 * cannot be read, are warnings. A home that the index does not list never reaches this check: the command exits 4
 * before it runs (the registration check of the lookup).
 */
export const checkIndex = async (deps: Deps): Promise<CheckResult> => {
  const path = await indexPathOf(deps);
  if (!path.ok) return check(checkIds.index, 'warn', path.error.message);
  if (path.value === null) {
    return check(checkIds.index, 'ok', `no ${places.list} is used: ${env.stateHome} and ${env.userHome} name no folder`);
  }
  const entries = await readHomeIndex(deps, path.value);
  if (!entries.ok) return check(checkIds.index, 'warn', `${path.value} cannot be read: ${entries.error}`);
  const problems: string[] = [];
  const gone = await goneHomes(deps, entries.value);
  if (gone.length > 0) {
    problems.push(
      `the ${places.list} lists ${gone.join(', ')}, with no ${files.config}. Remove the ${plural(gone.length, 'entry', 'entries')} from ${path.value}.`,
    );
  }
  if (problems.length > 0) return check(checkIds.index, 'warn', problems.join(' '));
  const count = entries.value.length;
  return check(checkIds.index, 'ok', `${count} ${plural(count, 'entry', 'entries')} in the ${places.list}, all present`);
};

/**
 * The node id against the other entries of the home index. The session names come from the node id, so two nodes with one id
 * give their sessions the same names, and the tmux session of one node stops the start of the other. It is a warning, because
 * the start already stops the second node.
 */
export const checkNodeId = async (deps: Deps, home: string, state: DocState<FactoryConfig>): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.nodeId, `${files.config} is not valid`);
  const id = state.value.core.node.id;
  const path = await indexPathOf(deps);
  if (!path.ok) return notChecked(checkIds.nodeId, path.error.message);
  if (path.value === null) return check(checkIds.nodeId, 'ok', `no ${places.list} is used, so no other ${roles.node} id is known`);
  const entries = await readHomeIndex(deps, path.value);
  if (!entries.ok) return notChecked(checkIds.nodeId, `${path.value} cannot be read`);
  const ownKey = await folderKeyOf(deps, home);
  const gone = await goneHomes(deps, entries.value);
  const others: string[] = [];
  for (const entry of entries.value) {
    const other = entry[homeIndex.keys.home];
    if (entry[homeIndex.keys.id] !== id || gone.includes(other) || others.includes(other)) continue;
    // An entry for this folder by another path, a link or another case on macOS, is this node.
    if ((await folderKeyOf(deps, other)) !== ownKey) others.push(other);
  }
  if (others.length === 0) return check(checkIds.nodeId, 'ok', `no other ${program} in the ${places.list} has the ${roles.node} id ${id}`);
  return check(
    checkIds.nodeId,
    'warn',
    `the ${places.list} also gives the ${roles.node} id ${id} to ${others.join(', ')}. The sessions of these ${roles.node}s get the same names, ` +
      `so only one of them can run at a time. Give each ${roles.node} its own id.`,
  );
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
export const checkChildren = async (
  deps: Deps,
  state: DocState<FactoryConfig>,
  registry: RecipeRegistry,
): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.children, `${files.config} is not valid`);
  const { children, node } = state.value.core;
  if (children.length === 0) return check(checkIds.children, 'ok', 'no child is configured');

  const needed = node.layer - 1;
  const rows = await probeChildren(fileTransport(deps, registry), children);
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

/** A block that is not as the layer needs it, and the command that fixes it. */
interface BlockProblem {
  readonly text: string;
  readonly remedy: string;
}

const UPGRADE_REMEDY = `Run "${commandText(commands.upgrade)}".`;

/**
 * The remedy for an edited block. The safety block is a fixed rule: the owner replaces it, and the old text stays in a
 * backup file. The text of a setup block comes from its setup file, so `upgrade` puts the file text back by itself.
 */
const editedRemedy = (name: string): string => {
  if (name === blockNames.safety) {
    return `Run "${overwriteCommand(name)}" to replace the text. It keeps the old text in a backup file.`;
  }
  if (setupBlockNames.includes(name)) {
    return (
      `Move your edit to ${setupFileOf(name)}, then run "${commandText(commands.upgrade)}". ` +
      'It puts back the text of that file and keeps the old text in a backup file.'
    );
  }
  return `Move your edits to the setup folder, then run "${overwriteCommand(name)}" to replace the text.`;
};

/**
 * A block that is not as the layer needs it. A block under the name of another layer is a role block that does not
 * match. An intact block whose text differs from the rendered text is out of date: `upgrade` renders it again. An edited
 * block stays as it is until the person names it with `--overwrite`.
 */
const describeBlockProblem = (status: BlockStatus): BlockProblem[] => {
  const name = status.template.name;
  const where = `${status.kind}, in ${status.file}`;
  const old = renamedFromOf(status);
  if (old !== undefined) {
    // An edited block under an old name stays until a person names it, so `upgrade` alone does not fix it.
    const remedy = status.kind === 'edited' ? `Run "${overwriteCommand(old)}" to replace it.` : UPGRADE_REMEDY;
    return [{ text: `${old} (${where}): the layer of this ${roles.node} needs the block ${name}`, remedy }];
  }
  switch (status.kind) {
    case 'intact':
      return status.block.body === status.template.body
        ? []
        : [{ text: `${name} (out of date, in ${status.file})`, remedy: UPGRADE_REMEDY }];
    case 'edited':
      return [{ text: `${name} (${where})`, remedy: editedRemedy(name) }];
    case 'missing':
      return [
        {
          text: `${name} (${where})`,
          remedy: setupBlockNames.includes(name) ? UPGRADE_REMEDY : `Run "${overwriteCommand(name)}" to add it.`,
        },
      ];
    case 'malformed':
      return [{ text: `${name} (${where})`, remedy: `Fix the marker lines in ${status.file}, then run "${commandText(commands.upgrade)}".` }];
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

/** A safety block that is edited, missing or malformed fails the check. Any other block problem is a warning. */
export const checkBlocks = (statuses: readonly BlockStatus[]): CheckResult => {
  const problems = statuses.flatMap(describeBlockProblem);
  return problems.length === 0
    ? check(checkIds.blocks, 'ok', `${statuses.length} managed blocks are intact`)
    : check(
        checkIds.blocks,
        statuses.some(isSafetyStop) ? 'fail' : 'warn',
        `${problems.map((problem) => problem.text).join('; ')}. ${[...new Set(problems.map((problem) => problem.remedy))].join(' ')}`,
      );
};

/** The layer of the node sets its role. A layer with no role template gets the safety block only. */
export const checkRoles = (state: DocState<FactoryConfig>): CheckResult => {
  if (state.kind !== 'valid') return notChecked(checkIds.roles, `${files.config} is not valid`);
  const { layer } = state.value.core.node;
  const role = state.value.entry.roles.nameForLayer(layer);
  return role === null
    ? check(checkIds.roles, 'warn', `layer ${layer} has no role template: ${files.claudeMd} holds the safety block only`)
    : check(checkIds.roles, 'ok', `layer ${layer} has the ${role} role template`);
};

export const checkSecrets = (state: DocState<FactoryConfig>): CheckResult => {
  if (state.kind === 'missing' || state.kind === 'unparsable' || state.kind === 'unsafe') {
    return notChecked(checkIds.secrets, `${fileOf(state)} does not parse`);
  }
  const where = `${files.config} or ${files.localConfig}`;
  const paths = findTokenPaths(state.raw);
  return paths.length === 0
    ? check(checkIds.secrets, 'ok', `no value in ${where} looks like a token`)
    : check(
        checkIds.secrets,
        'fail',
        `${paths.join(', ')} in ${where} look${paths.length === 1 ? 's' : ''} like a token. Remove it.`,
      );
};

/**
 * An instruction file of an agent in the root or in a folder above it reaches every session of the factory. It is a
 * warning only, never a failure (F-17c): the file is the choice of the person who owns that folder.
 */
export const checkInstructionFiles = async (deps: Deps, home: string): Promise<CheckResult> => {
  const lines = instructionFileWarnings(await scanInstructionFiles(deps, home));
  return lines.length === 0
    ? check(checkIds.instructionFiles, 'ok', `no agent instruction file is in the ${places.folder} or above it`)
    : check(checkIds.instructionFiles, 'warn', lines.join(' '));
};

/** A failed check from an error of a command, with its remedy line. */
const failedFrom = (id: string, error: CliError): CheckResult =>
  check(id, 'fail', `${error.message}.${error.hint === undefined ? '' : ` ${error.hint}`}`);

/**
 * The blocks come from the config of the node and from the setup texts, so a config that is not valid gives no block
 * list. A link in the paths that the check reads fails the check, and nothing is read through it.
 */
export const checkNodeBlocks = async (
  deps: Deps,
  home: string,
  state: DocState<FactoryConfig>,
): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.blocks, `${files.config} is not valid`);
  const layout = layoutOf(home);
  const plain = await requireNoRootLinks(deps, layout);
  if (!plain.ok) return failedFrom(checkIds.blocks, plain.error);
  const setup = await readSetupTexts(deps, layout, commands.doctor);
  if (!setup.ok) return failedFrom(checkIds.blocks, setup.error);
  const input = blockInputOf(state.value, setup.value, await effectiveModes(deps, home, state.value));
  const pending = { ...NO_PENDING_FILES, renames: [...blockRenamesOf(fileSteps), ...roleBlockRenames(input.recipe, input.layer)] };
  return checkBlocks(await inspectBlocks(deps, home, blockTemplatesFor(input), pending));
};

/** A rendered file, the setup file that its text comes from, and the names of both for the output. */
interface RenderedPair {
  readonly rendered: string;
  readonly renderedName: string;
  readonly setup: string;
  readonly setupName: string;
}

const renderedPairs = (home: string): readonly RenderedPair[] => {
  const layout = layoutOf(home);
  return [
    {
      rendered: layout.claudeMd,
      renderedName: join(dirs.coordinator, files.claudeMd),
      setup: layout.setupCoordinatorFile,
      setupName: join(dirs.setup, files.setupCoordinator),
    },
    {
      rendered: layout.workerMd,
      renderedName: join(dirs.state, dirs.roles, files.worker),
      setup: layout.setupWorkerFile,
      setupName: join(dirs.setup, dirs.roles, files.worker),
    },
  ];
};

/** The lines of a rendered file that no block holds and that its setup file does not hold. Null when there is no file. */
const strayLinesOf = async (deps: Deps, home: string, pair: RenderedPair): Promise<CliResult<number | null>> => {
  const kind = await deps.fs.stat(pair.rendered);
  if (!kind.ok) return kind;
  if (kind.value !== 'file') return ok(null);
  const rendered = await deps.fs.readTextLimited(pair.rendered, maxFileBytes);
  if (!rendered.ok) return rendered;
  const blocks = parseBlocks(rendered.value);
  // A file with broken markers is the business of the blocks check.
  if (!blocks.ok) return ok(null);
  const setup = await readSetupFile(deps, layoutOf(home), pair.setup, commands.doctor);
  if (!setup.ok) return setup;
  const known = new Set((setup.value ?? '').split('\n').map((line) => line.trim()));
  return ok(linesOutsideBlocks(rendered.value, blocks.value).filter((line) => !known.has(line)).length);
};

/**
 * Only the setup folder travels. A line that a person wrote in `coordinator/CLAUDE.md` or in the worker file, outside the
 * managed blocks, stays on this machine, unless the setup file holds it too. This is a warning. It names the count and
 * the file, never the text.
 */
export const checkSetupText = async (deps: Deps, home: string): Promise<CheckResult> => {
  const plain = await requireNoRootLinks(deps, layoutOf(home));
  if (!plain.ok) return failedFrom(checkIds.setupText, plain.error);
  const problems: string[] = [];
  const targets: string[] = [];
  for (const pair of renderedPairs(home)) {
    const stray = await strayLinesOf(deps, home, pair);
    if (!stray.ok) return notChecked(checkIds.setupText, stray.error.message);
    if (stray.value === null || stray.value === 0) continue;
    problems.push(`${pair.renderedName} holds ${stray.value} ${plural(stray.value, 'line', 'lines')} outside its blocks that ${pair.setupName} does not hold`);
    targets.push(pair.setupName);
  }
  return problems.length === 0
    ? check(checkIds.setupText, 'ok', 'no text outside the managed blocks stays on this machine')
    : check(
        checkIds.setupText,
        'warn',
        `${problems.join('; ')}. Only the setup folder travels. Move the text to ${targets.join(' or to ')}, then run "${commandText(commands.upgrade)}".`,
      );
};

export const checkProxyEnv = (deps: Deps): CheckResult => {
  const value = deps.env[env.proxyBaseUrl];
  return value === undefined || value === ''
    ? check(checkIds.proxyEnv, 'ok', `${env.proxyBaseUrl} is not set in the shell`)
    : check(checkIds.proxyEnv, 'warn', `${env.proxyBaseUrl} is set in the shell. ${program} clears it at launch.`);
};

/**
 * One health request for each proxy in use. The home passed the registration check of the lookup, so its config
 * counts as chosen by the user, whatever way the lookup found it.
 */
export const checkProxies = async (deps: Deps, state: DocState<FactoryConfig>): Promise<readonly CheckResult[]> => {
  if (state.kind !== 'valid') return [notChecked(checkIds.proxy, `${files.config} is not valid`)];
  const { core } = state.value;
  const inUse = new Set([core.session.proxy, ...Object.values(core.workers).map((worker) => worker.proxy)]);
  inUse.delete(values.noProxy);
  const used = core.proxies.filter((proxy) => inUse.has(proxy.id));
  if (used.length === 0) return [check(checkIds.proxy, 'ok', 'no proxy is in use')];

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

/** The problem of the tmux that is on PATH, or null: its version is not known, or it is older than the start command needs. */
const tmuxProblem = async (deps: Deps): Promise<string | null> => {
  const version = await tmuxVersionOf(deps);
  if (version === null) return `cannot read the version of ${toolNames.tmux}`;
  if (isTmuxNewEnough(version)) return null;
  const needed = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;
  return `${toolNames.tmux} ${version.major}.${version.minor} is older than ${needed} (the ${START_COMMAND} needs ${needed} or newer)`;
};

export const checkTools = async (deps: Deps): Promise<CheckResult> => {
  const major = Number(/^v?(\d+)/.exec(deps.platform.nodeVersion)?.[1] ?? '0');
  if (major < MIN_NODE_MAJOR) {
    return check(checkIds.tools, 'fail', `Node.js ${MIN_NODE_MAJOR} or newer is needed, and this is Node.js ${major}`);
  }
  const missing: string[] = [];
  let tmuxFound = false;
  let gitFound = false;
  for (const tool of TOOLS) {
    if (!(await onPath(deps, tool.name))) missing.push(`${tool.name} (${tool.neededFor})`);
    else if (tool.name === toolNames.tmux) tmuxFound = true;
    else if (tool.name === toolNames.git) gitFound = true;
  }
  const problems = missing.length === 0 ? [] : [`missing: ${missing.join(', ')}`];
  const oldTmux = tmuxFound ? await tmuxProblem(deps) : null;
  if (oldTmux !== null) problems.push(oldTmux);
  // The state steps need git 2.26: a git that is older, or whose version is not read, is a failure and not a warning.
  const oldGit = gitFound ? await gitVersionProblem(deps) : null;
  if (oldGit !== null) problems.push(oldGit);
  if (problems.length === 0) return check(checkIds.tools, 'ok', `Node.js ${major}, git, tmux, gh and claude are available`);
  return check(checkIds.tools, oldGit === null ? 'warn' : 'fail', problems.join('; '));
};

/**
 * The version of the agent program of the config. A version below `MIN_AGENT_VERSION`, and an output that is no version, are
 * warnings. The agent program comes from the config, so a config that is not valid gives no check, and a program that is not
 * on PATH is named once by the tools check.
 */
export const checkAgentVersion = async (deps: Deps, state: DocState<FactoryConfig>): Promise<CheckResult> => {
  if (state.kind !== 'valid') return notChecked(checkIds.agentVersion, `${files.config} is not valid`);
  const agent = state.value.core.session.agent;
  if (!(await onPath(deps, agent))) return notChecked(checkIds.agentVersion, `${agent} is missing`);
  const version = await agentVersionOf(deps, agent);
  if (version === null) return check(checkIds.agentVersion, 'warn', `cannot read the version of ${agent}`);
  const shown = `${version.major}.${version.minor}.${version.patch}`;
  if (isAgentNewEnough(version)) return check(checkIds.agentVersion, 'ok', `${agent} ${shown} is new enough`);
  const needed = `${MIN_AGENT_VERSION.major}.${MIN_AGENT_VERSION.minor}.${MIN_AGENT_VERSION.patch}`;
  return check(
    checkIds.agentVersion,
    'warn',
    `${agent} ${shown} is older than ${needed} (the messages between sessions need ${needed} or newer)`,
  );
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

/**
 * The delete guard of the state repo. An off guard is a warning with the remedy, never a failure: a factory with the guard off keeps
 * working, and only the commands that change the board refuse. The state-repo check names a folder that is no repo, and a missing git.
 */
export const checkStateGuard = async (deps: Deps, home: string): Promise<CheckResult> => {
  const stateDir = layoutOf(home).stateDir;
  const repo = await deps.fs.stat(join(stateDir, GIT_ENTRY));
  if (!repo.ok || repo.value === null) return notChecked(checkIds.stateGuard, `${dirs.state} is not a git repository`);
  if (!(await onPath(deps, 'git'))) return notChecked(checkIds.stateGuard, 'git is missing');
  const warning = await guardWarning(deps, stateDir);
  return warning === null
    ? check(checkIds.stateGuard, 'ok', `the delete guard of ${dirs.state} is on`)
    : check(checkIds.stateGuard, 'warn', warning);
};

/**
 * The size of the board, the waiting file and the decision log against the read cap. A file that reaches `boardWarnPercent` of
 * `maxFileBytes` is a warning that names it: a command refuses to read a file above the cap, and a write that would make one is
 * refused. A file that is not there is no fault. The check is a warning at most, and it writes nothing.
 */
export const checkBoardSize = async (deps: Deps, home: string): Promise<CheckResult> => {
  const stateDir = layoutOf(home).stateDir;
  const near: string[] = [];
  for (const name of [files.board, files.waiting, files.decisionLog]) {
    const info = await deps.fs.statInfo(join(stateDir, name));
    if (!info.ok) return notChecked(checkIds.boardSize, `${dirs.state}/${name}: ${info.error.message}`);
    if (info.value === null || info.value.size * 100 < maxFileBytes * boardWarnPercent) continue;
    const percent = Math.floor((info.value.size * 100) / maxFileBytes);
    near.push(`${dirs.state}/${name} is ${info.value.size} bytes (${percent} percent of the cap)`);
  }
  return near.length === 0
    ? check(checkIds.boardSize, 'ok', `the board files are below ${boardWarnPercent} percent of the cap of ${maxFileBytes} bytes`)
    : check(checkIds.boardSize, 'warn', `${near.join('; ')}. A file above ${maxFileBytes} bytes cannot be read.`);
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

/**
 * A project with no URL that a host serves works on this machine, but the factory can not be shared with its repo.
 * This is a warning for each such project, never an error. The fix names the local source when the local file has one.
 */
export const checkProjectUrls = (state: DocState<FactoryConfig>): readonly CheckResult[] => {
  if (state.kind !== 'valid') return [notChecked(checkIds.projectUrls, `${files.config} is not valid`)];
  const { projects } = state.value.recipe;
  const sources = new Map(Object.entries(state.value.core.sources).map(([path, source]) => [folderKey(path), source]));
  const warnings = projects.flatMap((project) => {
    const reason = unsharedReasonOf(project);
    const text = reason === null ? null : unsharedWarning(project.id, reason, sources.get(folderKey(project.path)));
    return text === null ? [] : [check(`${checkIds.projectUrls}:${project.id}`, 'warn', text)];
  });
  if (warnings.length > 0) return warnings;
  const count = projects.length;
  const text =
    count === 0
      ? 'no project is configured'
      : `${count} ${plural(count, 'project has a URL', 'projects have a URL')} that can be shared`;
  return [check(checkIds.projectUrls, 'ok', text)];
};

interface CheckRun {
  readonly results: readonly CheckResult[];
  readonly localMissing: boolean;
  /** True when the local file is a link, of another account, or open to write: a security stop. */
  readonly localUnsafe: boolean;
}

/**
 * A failed root check sends no proxy health request: the proxy line says why. The root checks run first, because a
 * request to a proxy is a step toward a launch that the failure forbids.
 */
const skippedProxyCheck = (): CheckResult =>
  notChecked(checkIds.proxy, `a check of the ${places.folder} failed, so no health check went to a proxy`);

const runChecks = async (deps: Deps, home: string, registry: RecipeRegistry): Promise<CheckRun> => {
  const config = await inspectConfig(deps, home, registry);
  const state = await inspectState(deps, home);
  const rootScan = await scanRoot(deps, home, config.kind === 'valid' ? config.value : null);
  const [
    root,
    tempFolder,
    index,
    nodeId,
    blocks,
    setupText,
    children,
    instructionFileCheck,
    proxies,
    tools,
    agentVersion,
    stateRepo,
    stateGuard,
    boardSize,
    projects,
    localFile,
  ] = await Promise.all([
    checkRoot(deps, home),
    checkTempFolders(deps, home),
    checkIndex(deps),
    checkNodeId(deps, home, config),
    checkNodeBlocks(deps, home, config),
    checkSetupText(deps, home),
    checkChildren(deps, config, registry),
    checkInstructionFiles(deps, home),
    hasRootFailure(rootScan) ? Promise.resolve([skippedProxyCheck()]) : checkProxies(deps, config),
    checkTools(deps),
    checkAgentVersion(deps, config),
    checkStateRepo(deps, home),
    checkStateGuard(deps, home),
    checkBoardSize(deps, home),
    checkProjects(deps, home, config),
    checkLocalFile(deps, home),
  ]);
  const results = [
    checkConfig(config),
    checkConfigVersion(config),
    localFile,
    checkState(state),
    root,
    tempFolder,
    index,
    nodeId,
    blocks,
    setupText,
    checkRoles(config),
    checkTracker(config),
    children,
    checkSecrets(config),
    ...rootCheckResults(rootScan),
    instructionFileCheck,
    checkProxyEnv(deps),
    ...proxies,
    tools,
    agentVersion,
    stateRepo,
    stateGuard,
    boardSize,
    projects,
    ...checkProjectUrls(config),
  ];
  return {
    results,
    localMissing: isLocalFileMissing(config),
    localUnsafe: config.kind === 'unsafe' && config.file === files.localConfig,
  };
};

const count = (results: readonly CheckResult[], level: CheckLevel): number =>
  results.filter((result) => result.level === level).length;

export const runDoctor = async (
  deps: Deps,
  options: DoctorOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.doctor,
  );
  if (!located.ok) return located;
  const home = located.value.home;

  const { results, localMissing, localUnsafe } = await runChecks(deps, home, registry);
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
    // The check names `init`: the person has to run it, so this is a usage problem and not a failed check of a good setup.
    ...(localMissing ? { exitCode: exitCodeOf.usage } : {}),
    // A local file that others can write, that another account owns, or that is a link breaks the security rule.
    ...(localUnsafe && !localMissing ? { exitCode: exitCodeOf.safety } : {}),
  });
};
