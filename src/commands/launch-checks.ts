import { join } from 'node:path';
import { inspectBlock, safetyStateOf } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { loadConfig, settleLocalMode } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { warnInstructionFiles } from '../core/instruction-files.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { shellWord } from '../core/shell-word.js';
import { isTmuxNewEnough, MIN_TMUX, onPath, tmuxVersionOf, toolNames } from '../core/tools.js';
import { requireSession } from '../launch/tmux-run.js';
import {
  blockNames,
  capitalize,
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  overwriteCommand,
  program,
  roles,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { safetyTemplateFor } from '../templates/index.js';
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
  dryRun: boolean,
  renderedBy: string = RENDERED_BY_REAL_RUN,
): Promise<CliResult<readonly string[]>> => {
  const { claudeMd } = layoutOf(home);
  const plain = await requireNoLinks(deps, home, [claudeMd]);
  if (!plain.ok) return plain;
  const name = blockNames.safety;
  const file = join(dirs.coordinator, files.claudeMd);
  const status = await inspectBlock(deps, home, safetyTemplateFor(config, await effectiveModes(deps, home, config)));
  const state = safetyStateOf(status);
  switch (state) {
    case 'equal':
      return ok([]);
    case 'different': {
      if (dryRun) return ok([`The block ${name} in ${file} is out of date. ${renderedBy}`]);
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
export const requireLaunchReady = async (deps: Deps, home: string, config: FactoryConfig): Promise<CliResult<void>> => {
  const scan = await scanRoot(deps, home, config);
  for (const notice of rootNotices(scan)) deps.warn(notice);
  const clean = requireRootClean(scan);
  if (!clean.ok) return clean;
  const safety = await requireSafetyBlock(deps, home, config, true, RENDERED_BY_START);
  if (!safety.ok) return safety;
  for (const note of safety.value) deps.warn(note);
  const problems = await toolProblems(deps, true);
  if (problems.length > 0) {
    return failure(
      problems.join('. '),
      `Run "${commandText(commands.doctor)} ${flagText(flags.home)} ${shellWord(home)}" to check the tools.`,
    );
  }
  return ok(undefined);
};

/** The config of a factory folder that passed the checks before a launch, and the notes of the local file. */
export interface Prepared {
  readonly config: FactoryConfig;
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
  const ready = await requireLaunchReady(deps, home, config);
  if (!ready.ok) return ready;
  return ok({ config, notes: notes.value });
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
  const session = await requireSession(deps, prepared.value.config.core.node.id, home, again);
  return session.ok ? prepared : session;
};
