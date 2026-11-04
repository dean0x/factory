import { join } from 'node:path';
import { inspectBlock, safetyStateOf } from '../blocks/status.js';
import { safetyRefusal, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { isTmuxNewEnough, MIN_TMUX, onPath, tmuxVersionOf, toolNames } from '../core/tools.js';
import { blockNames, capitalize, commands, commandText, dirs, files, overwriteCommand, program } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { safetyTemplateFor } from '../templates/index.js';
import { planBlock } from '../upgrade/plan.js';
import { writeBlockPlans } from '../upgrade/render.js';

/**
 * The checks that come before every launch of a session, after the root checks: the tools that the launch needs, and the
 * safety block of the coordinator file. `start` and `worker new` use them.
 */

const MIN_TMUX_TEXT = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;

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
 * after this check, because a missing file is a missing block. The value is the notes of a dry run.
 */
export const requireSafetyBlock = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  dryRun: boolean,
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
      if (dryRun) return ok([`The block ${name} in ${file} is out of date. A real run renders it again.`]);
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
