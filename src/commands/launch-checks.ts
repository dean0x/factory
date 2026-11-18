import { join } from 'node:path';
import { sha256Hex } from '../blocks/managed.js';
import { inspectBlock, inspectBlocks, safetyStateOf, type BlockStatus } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { loadConfig, settleLocalMode } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { readGuardState, type GuardReadState } from '../core/guard-records.js';
import { warnInstructionFiles } from '../core/instruction-files.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { shellWord } from '../core/shell-word.js';
import { isTmuxNewEnough, MIN_TMUX, onPath, tmuxVersionOf, toolNames } from '../core/tools.js';
import { guardsFor } from '../guards/registry.js';
import type { GuardValues } from '../guards/types.js';
import { requireSession } from '../launch/tmux-run.js';
import {
  blockNames,
  capitalize,
  commands,
  commandLines,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  overwriteCommand,
  program,
  roles,
} from '../names.js';
import type { ApprovalModes, RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { blockInputOf, blockTemplatesFor, safetyTemplateFor } from '../templates/index.js';
import { planBlock } from '../upgrade/plan.js';
import { writeBlockPlans } from '../upgrade/render.js';
import { requireRootClean, rootNotices, scanRoot } from './root-content.js';

/**
 * The checks that come before every launch of a session, after the root checks: the tools that the launch needs, and the
 * safety block of the coordinator file. `start` uses them. A command that starts a worker pane uses `prepareLaunch`, which makes
 * the same checks in the order of `start`.
 */

const MIN_TMUX_TEXT = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;

/** The end of the note of a dry run of `start`, which a real run of the same command renders again. */
const RENDERED_BY_REAL_RUN = 'A real run renders it again.';

/** The tools that a launch needs. A real run also reads the version of tmux. A dry run starts no tmux command for it. */
export const toolProblems = async (deps: Deps, readVersion: boolean): Promise<readonly string[]> => {
  const problems: string[] = [];
  if (!(await onPath(deps, toolNames.tmux))) {
    problems.push(`${toolNames.tmux} is not on PATH. Install ${toolNames.tmux} ${MIN_TMUX_TEXT} or newer`);
  } else if (readVersion) {
    const version = await tmuxVersionOf(deps);
    if (version === null) {
      problems.push(`cannot read the version of ${toolNames.tmux}`);
    } else if (!isTmuxNewEnough(version)) {
      problems.push(
        `${toolNames.tmux} ${version.major}.${version.minor} is too old. ${capitalize(program)} needs ${toolNames.tmux} ${MIN_TMUX_TEXT} or newer`,
      );
    }
  }
  if (!(await onPath(deps, toolNames.claude))) problems.push(`${toolNames.claude} is not on PATH`);
  return problems;
};

/** A launch uses only the prefix whose exact text the owner confirmed. A store fault stops every launch. */
export const requireConfirmedPrefix = (config: FactoryConfig, guards: GuardReadState): CliResult<void> => {
  if (guards.fault !== null) {
    return safetyRefusal(guards.fault, `Run "${commandText(commands.doctor)}" to check the guard store.`);
  }
  if (guards.prefix !== null && guards.prefix.hash !== sha256Hex(config.core.owner.prefix)) {
    return safetyRefusal(`the ${roles.owner} prefix differs from its record`, `Run "${commandText(commandLines.guardConfirm)}" to confirm the ${roles.owner} prefix.`);
  }
  return ok(undefined);
};

const roleTemplates = (config: FactoryConfig, modes: ApprovalModes, values: GuardValues) =>
  blockTemplatesFor(blockInputOf(config, { coordinator: null, worker: null }, modes, values))
    .filter((template) => template.name !== blockNames.safety);

/** Compare the on and off renders to find the text that each on H guard requires in a role block. */
const missingRoleGuard = (
  config: FactoryConfig, modes: ApprovalModes, values: GuardValues, status: Extract<BlockStatus, { readonly kind: 'intact' | 'edited' | 'missing' }>,
): string | null => {
  for (const guard of guardsFor(config.entry)) {
    if (!guard.harm || values[guard.id] === 'off') continue;
    const on = roleTemplates(config, modes, { ...values, [guard.id]: 'on' }).find((block) => block.name === status.template.name);
    const off = roleTemplates(config, modes, { ...values, [guard.id]: 'off' }).find((block) => block.name === status.template.name);
    if (on === undefined || off === undefined) continue;
    const offLines = new Set(off.body.split('\n'));
    const required = on.body.split('\n').filter((line) => line.trim() !== '' && !offLines.has(line));
    const found = new Set(status.kind === 'missing' ? [] : status.block.body.split('\n'));
    if (required.some((line) => !found.has(line))) return guard.id;
  }
  return null;
};

/** Check role blocks against the effective guard values for every launch. Pane launches never write them. */
export const requireRoleBlocks = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  guards: GuardReadState,
  modes: ApprovalModes,
  dryRun: boolean,
  renderedBy: string,
): Promise<CliResult<readonly string[]>> => {
  const templates = roleTemplates(config, modes, guards.values);
  const layout = layoutOf(home);
  const plain = await requireNoLinks(deps, home, [layout.claudeMd, layout.workerMd]);
  if (!plain.ok) return plain;
  const statuses = await inspectBlocks(deps, home, templates);
  for (const status of statuses) {
    if (status.kind === 'malformed') {
      return safetyRefusal(`the role block ${status.template.name} can not be read`, `Run "${overwriteCommand(status.template.name)}" to replace it.`);
    }
    if (status.kind === 'edited' || status.kind === 'missing') {
      const missing = missingRoleGuard(config, modes, guards.values, status);
      if (missing !== null) {
        const remedy = status.kind === 'missing' ? 'add it.' : 'replace it. It keeps the old text in a backup file.';
        return safetyRefusal(`the ${status.kind} block ${status.template.name} lacks the text of the on guard ${missing}`, `Run "${overwriteCommand(status.template.name)}" to ${remedy}`);
      }
    }
  }
  const plans = statuses.map((status) => planBlock(status, false));
  const notes: string[] = [];
  for (const plan of plans) {
    if (plan.action === 'skip-edited') {
      notes.push(`The block ${plan.template.name} was edited, so it stays. Run "${overwriteCommand(plan.template.name)}" to replace it.`);
    } else if (plan.action === 'skip-missing') {
      notes.push(`The block ${plan.template.name} is missing. Run "${overwriteCommand(plan.template.name)}" to add it.`);
    } else if (plan.action !== 'current' && plan.action !== 'render') {
      notes.push(`The block ${plan.template.name} stays. Run "${commandText(commands.upgrade)}" to update it.`);
    }
  }
  const changes = plans.filter((plan) => plan.action === 'render');
  if (changes.length === 0) return ok(notes);
  if (dryRun) return ok([...notes, `The role blocks are out of date after a guard change or a package change. ${renderedBy}`]);
  const written = await writeBlockPlans(deps, home, changes, commands.start);
  if (!written.ok) return written;
  const values = guardsFor(config.entry).filter((guard) => guard.wired)
    .map((guard) => `${guard.id} ${guards.values[guard.id] ?? 'on'}`).join(', ');
  deps.warn(`Rendered the role blocks again after a guard change or a package change: ${values}.`);
  return ok(notes);
};

/**
 * The safety block, for every launch (design 4.8). A launch never goes on with a safety body that differs from the text
 * that the package renders for the config, the effective approval modes and the owner prefix:
 * - equal: no action;
 * - intact but different (the package, a mode or the prefix changed): render the block again, print a notice and go on;
 *   a dry run writes nothing and returns a note;
 * - edited, missing or not readable: exit 4, because the safety rules are a security boundary.
 * A link at the coordinator file is a stop first: nothing is read or written through it. The coordinator folder exists
 * after this check, because a missing file is a missing block. The value is the notes of a dry run. The note ends with
 * `renderedBy`: the sentence that says which command renders the block again.
 */
export const requireSafetyBlock = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  guards: GuardReadState,
  dryRun: boolean,
  renderedBy: string = RENDERED_BY_REAL_RUN,
): Promise<CliResult<readonly string[]>> => {
  const confirmed = requireConfirmedPrefix(config, guards);
  if (!confirmed.ok) return confirmed;
  const { claudeMd } = layoutOf(home);
  const plain = await requireNoLinks(deps, home, [claudeMd]);
  if (!plain.ok) return plain;
  const name = blockNames.safety;
  const file = join(dirs.coordinator, files.claudeMd);
  const modes = await effectiveModes(deps, home, config);
  const status = await inspectBlock(deps, home, safetyTemplateFor(config, modes, guards.values));
  const state = safetyStateOf(status);
  const roleBlocks = state === 'equal' || state === 'different'
    ? await requireRoleBlocks(deps, home, config, guards, modes, dryRun, renderedBy) : ok<readonly string[]>([]);
  if (!roleBlocks.ok) return roleBlocks;
  if (!dryRun) for (const note of roleBlocks.value) deps.warn(note);
  switch (state) {
    case 'equal':
      return roleBlocks;
    case 'different': {
      if (dryRun) return ok([...roleBlocks.value, `The block ${name} in ${file} is out of date. ${renderedBy}`]);
      const written = await writeBlockPlans(deps, home, [planBlock(status, false)], commands.start);
      if (!written.ok) return written;
      deps.warn(`Rendered the block ${name} in ${file} again, because the package or a setting changed its text.`);
      return ok([]);
    }
    case 'edited':
      return safetyRefusal(
        `the block ${name} in ${file} was edited`,
        `Run "${overwriteCommand(name)}" to replace the text. It keeps the old text in a backup file.`,
      );
    case 'missing':
      return safetyRefusal(`the block ${name} is missing in ${file}`, `Run "${overwriteCommand(name)}" to add it.`);
    case 'malformed':
      return safetyRefusal(
        `the block ${name} in ${file} can not be read${status.kind === 'malformed' ? `: ${status.message}` : ''}`,
        `Fix the marker lines in ${file}, then run "${commandText(commands.doctor)}".`,
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * The end of the warning for a safety block that is out of date: a command that starts a worker does not render it. `start` does,
 * and so does `reboot` outside the session, because it starts the coordinator with the steps of `start`.
 */
const RENDERED_BY_START =
  `A command that starts a ${roles.worker} does not render it again. "${commandText(commands.start)}" does, ` +
  `and so does "${commandText(commands.reboot)}" outside the session.`;

/**
 * The checks of the root and of the tools, as `start` makes them. A failing root check is a stop (exit 4) with one remedy
 * line, a warning is printed, and nothing changes. The owner accepts a change of the setup text with `start` or `upgrade`:
 * this command asks nothing about it. The safety block is checked and never rendered again here: a block that is out of
 * date gives a warning, and `start` or a `reboot` outside the session renders it.
 */
export const requireLaunchReady = async (
  deps: Deps, home: string, config: FactoryConfig, guards: GuardReadState,
): Promise<CliResult<readonly string[]>> => {
  const scan = await scanRoot(deps, home, config);
  for (const notice of rootNotices(scan)) deps.warn(notice);
  const clean = requireRootClean(scan);
  if (!clean.ok) return clean;
  const safety = await requireSafetyBlock(deps, home, config, guards, true, RENDERED_BY_START);
  if (!safety.ok) return safety;
  const problems = await toolProblems(deps, true);
  if (problems.length > 0) {
    return failure(
      problems.join('. '),
      `Run "${commandText(commands.doctor)} ${flagText(flags.home)} ${shellWord(home)}" to check the tools.`,
    );
  }
  return safety;
};

/** The config of a factory folder that passed the checks before a launch, and the notes of the local file. */
export interface Prepared {
  readonly config: FactoryConfig;
  readonly guards: GuardReadState;
  /** Notes for a launch that does not render the blocks. A render supplies its own notices. */
  readonly launchNotes: readonly string[];
  readonly notes: readonly string[];
}

/**
 * The checks of a command that starts a pane, up to the tmux session, in this order: the warning about instruction files, the
 * config, the local mode, the root and the tools (exit 4, and nothing changes). A command that has no session to check yet
 * (`reboot` with no session) uses this one, and `prepareLaunch` adds the session check.
 */
export const prepareRoot = async (deps: Deps, home: string, registry: RecipeRegistry): Promise<CliResult<Prepared>> => {
  // The warning about instruction files comes before any change or launch, and it never stops the command.
  await warnInstructionFiles(deps, home);
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const notes = await settleLocalMode(deps, home, true);
  if (!notes.ok) return notes;
  const guards = await readGuardState(deps, home, config, 'always');
  const ready = await requireLaunchReady(deps, home, config, guards);
  if (!ready.ok) return ready;
  return ok({ config, guards, launchNotes: ready.value, notes: notes.value });
};

/**
 * Everything that a command that starts a pane checks before its own checks: the checks of `prepareRoot`, then the tmux session of
 * the node (exit 3). `again` is the command line that a person runs again after a fix.
 */
export const prepareLaunch = async (
  deps: Deps,
  home: string,
  registry: RecipeRegistry,
  again: string,
): Promise<CliResult<Prepared>> => {
  const prepared = await prepareRoot(deps, home, registry);
  if (!prepared.ok) return prepared;
  for (const note of prepared.value.launchNotes) deps.warn(note);
  const session = await requireSession(deps, prepared.value.config.core.node.id, home, again);
  return session.ok ? prepared : session;
};
