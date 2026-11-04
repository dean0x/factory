import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import {
  killPaneArgs,
  paneBindArgs,
  paneListArgs,
  paneReadArgs,
  parsePaneBind,
  parsePaneListSoft,
  type PaneRow,
} from '../launch/tmux.js';
import { requireOwnSession, sessionExists, tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { commandText, program, roles, tmuxNames } from '../names.js';
import { startsWorker } from './binding.js';

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

/** The tmux command that a person runs to clear a mark that a program set on a pane. */
export const clearMarkText = (pane: string, option: string): string => `${toolNames.tmux} set-option -p -u -t ${pane} ${option}`;

/** What a read of a pane that must belong to a worker finds. */
export interface BoundPane {
  readonly paneId: string;
  /** The pid that tmux gave in this read. */
  readonly pid: number;
  readonly dead: boolean;
  /** True when the pane is in the window `view`: only a summon puts a pane of a worker there. */
  readonly inView: boolean;
}

export interface BindRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly paneId: string;
  readonly workerId: string;
  /** The command that a person runs again after a fix, without the program name (`commandText` adds it): for the end of the remedy. */
  readonly again: string;
}

/**
 * Reads one pane right before a command acts on it, and requires that the pane is a pane of this worker. The worker mark is text
 * that a program in any pane can set on any pane, so the mark alone binds nothing. The pane counts only when all of these hold:
 * tmux says that the pane has the mark of the worker (tmux compares it, so no text of a mark is read); the pane is not the pane
 * of the coordinator and not the board pane; and its start command, which tmux fixes when it makes the pane and which no program
 * in the pane can change, shows the launch of this worker (`startsWorker`). A pane that fails a check is a security stop (exit 4),
 * and the command sends nothing to it. The pid of the value is the pid of this read.
 */
export const requireBoundPane = async (deps: Deps, request: BindRequest): Promise<CliResult<BoundPane>> => {
  const { home, paneId, workerId, again } = request;
  const args = paneBindArgs(paneId, workerId);
  if (!args.ok) return failure(args.error);
  const read = await tmuxStep(deps, args.value);
  if (!read.ok) {
    return failure(
      `cannot read the pane ${paneId}: ${read.error.message}`,
      `The pane may have ended. Run "${commandText(again)}" again.`,
    );
  }
  const remedy =
    `Look at the pane in tmux. When it is not a pane of the ${roles.worker} ${workerId}, run "${clearMarkText(paneId, tmuxNames.optionWorker)}" ` +
    `to clear its mark. Then run "${commandText(again)}" again.`;
  const refuse = (why: string) =>
    safetyRefusal(`the pane ${paneId} carries the mark of the ${roles.worker} ${workerId}, but ${why}`, remedy);
  const bind = parsePaneBind(read.value);
  if (!bind.ok) return safetyRefusal(`the read of the pane ${paneId} gives text that is not the line of one pane`, remedy);
  if (bind.value.paneId !== paneId) return safetyRefusal(`the read of the pane ${paneId} gives another pane`, remedy);
  if (!bind.value.marked) {
    return safetyRefusal(`the pane ${paneId} does not show the mark of the ${roles.worker} ${workerId} when it is read again`, remedy);
  }
  if (bind.value.node) return refuse(`it is the pane of the ${roles.coordinator}`);
  if (bind.value.board) return refuse('it is the board pane');
  if (!startsWorker(bind.value.startCommand, home, workerId)) {
    return refuse(`${program} did not start it for that ${roles.worker}: its start command does not hold the launch of the ${roles.worker}`);
  }
  return ok({ paneId, pid: bind.value.pid, dead: bind.value.dead, inView: bind.value.view });
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
