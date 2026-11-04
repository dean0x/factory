import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { killPaneArgs, paneListArgs, paneReadArgs, parsePaneListSoft, type PaneRow } from '../launch/tmux.js';
import { requireOwnSession, sessionExists, tmuxCall, tmuxStep } from '../launch/tmux-run.js';

/**
 * The panes of the tmux session of the node, from one list call, or null when no session of this factory runs. A session of
 * the same name that belongs to another factory folder is a stop (exit 4). A pane with a bad worker mark is a pane with no
 * worker, and the list stays whole.
 */
export const readPanes = async (deps: Deps, id: string, home: string): Promise<CliResult<readonly PaneRow[] | null>> => {
  if (!(await sessionExists(deps, id))) return ok(null);
  const own = await requireOwnSession(deps, id, home);
  if (!own.ok) return own;
  const listed = await tmuxStep(deps, paneListArgs(id));
  if (!listed.ok) return listed;
  const rows = parsePaneListSoft(listed.value);
  return rows.ok ? ok(rows.value) : failure(`cannot read the list of panes: ${rows.error}`);
};

/**
 * Ends a pane by its id. A pane id is never used again by the same tmux server, so the id names this pane and no other. The value
 * is `gone` when the pane did not exist any more: tmux removes a pane when its program ends, unless the window keeps it.
 */
export const closePane = async (deps: Deps, pane: string): Promise<CliResult<'closed' | 'gone'>> => {
  const kill = killPaneArgs(pane);
  if (!kill.ok) return failure(kill.error);
  const closed = await tmuxCall(deps, kill.value);
  if (!closed.ok) return closed;
  if (closed.value.exitCode === 0) return ok('closed');
  // The call failed. When the pane can not be read either, it is gone, and that is the result that the caller wants.
  const read = paneReadArgs(pane);
  if (!read.ok) return failure(read.error);
  const still = await tmuxCall(deps, read.value);
  if (!still.ok) return still;
  if (still.value.exitCode !== 0) return ok('gone');
  return failure(`${toolNames.tmux} ${kill.value[0]} failed for the pane ${pane} (exit code ${closed.value.exitCode})`);
};
