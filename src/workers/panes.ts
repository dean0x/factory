import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import {
  coordinatorReadArgs,
  killPaneArgs,
  paneBindArgs,
  paneAbsent,
  paneListArgs,
  paneReadArgs,
  parseCoordinatorPane,
  parsePaneBind,
  parsePaneListSoft,
  type CoordinatorPane,
  type PaneRow,
} from '../launch/tmux.js';
import { requireOwnSession, sessionExists, tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { commandText, program, roles, tmuxNames } from '../names.js';
import { startsWorker } from './binding.js';

/**
 * The panes of the tmux session, from one list call, for a caller that has checked already that the session runs and belongs to
 * its factory folder. A pane with a bad worker mark is a pane with no worker, and the list stays whole.
 */
export const listPanes = async (deps: Deps, id: string): Promise<CliResult<readonly PaneRow[]>> => {
  const listed = await tmuxStep(deps, paneListArgs(id));
  if (!listed.ok) return listed;
  const rows = parsePaneListSoft(listed.value);
  return rows.ok ? ok(rows.value) : failure(`cannot read the list of panes: ${rows.error}`);
};

/**
 * The panes of the tmux session of the node, from one list call, or null when no session of this factory runs. A session of
 * the same name that belongs to another factory folder is a stop (exit 4). A pane with a bad worker mark is a pane with no
 * worker, and the list stays whole. `again` is the command line to run again after the fix of a session of another folder.
 */
export const readPanes = async (
  deps: Deps,
  id: string,
  home: string,
  again?: string,
): Promise<CliResult<readonly PaneRow[] | null>> => {
  if (!(await sessionExists(deps, id))) return ok(null);
  const own = await requireOwnSession(deps, id, home, again);
  if (!own.ok) return own;
  return listPanes(deps, id);
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
  if (!read.ok || paneAbsent(read.value)) {
    return failure(
      `cannot read the pane ${paneId}: ${read.ok ? 'tmux has no such pane' : read.error.message}`,
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
 * What one read of a pane that a launch made finds: `running` (the program runs and the start command is the launch of the
 * worker), `ended` (the program ended and tmux keeps the pane), `gone` (tmux has no such pane any more) or `other` (the pane is
 * there, but its start command is not the launch of the worker).
 */
export type PaneLife = 'running' | 'ended' | 'gone' | 'other';

/**
 * Reads the pane that a launch made, by its id, and tells if the program of the launch of this worker still runs in it. The pane
 * id was printed by the launch itself, so a pane that tmux can not read is `gone`: tmux removes a pane when its program ends,
 * unless the window keeps it. The mark of the pane is not read, because the question is only if the launch still runs. A call that
 * tmux does not answer, and an answer that is not the line of this pane, are failures.
 */
export const readPaneLife = async (deps: Deps, request: Omit<BindRequest, 'again'>): Promise<CliResult<PaneLife>> => {
  const { home, paneId, workerId } = request;
  const args = paneBindArgs(paneId, workerId);
  if (!args.ok) return failure(args.error);
  const read = await tmuxCall(deps, args.value);
  if (!read.ok) return failure(`cannot read the pane ${paneId}: ${read.error.message}`);
  if (read.value.exitCode !== 0 || paneAbsent(read.value.stdout)) return ok('gone');
  const bind = parsePaneBind(read.value.stdout);
  if (!bind.ok) return failure(`cannot read the pane ${paneId}: ${bind.error}`);
  if (bind.value.paneId !== paneId) return failure(`cannot read the pane ${paneId}: the read gives another pane`);
  if (!startsWorker(bind.value.startCommand, home, workerId)) return ok('other');
  return ok(bind.value.dead ? 'ended' : 'running');
};

/**
 * Reads the pane of the coordinator, the left pane of the window `view`, right before a stop acts on it. The pane counts only when
 * tmux says that it carries the node mark of this session (tmux compares the mark, so no text of a mark is read): the pane that
 * `start` made for the coordinator. The value is null when tmux has no such pane or the pane does not carry the mark, and the stop
 * then sends nothing. A call that tmux does not answer, and an answer that is not the line of one pane, are failures. The pid of the
 * value is the pid of this read.
 */
export const readCoordinatorPane = async (deps: Deps, session: string): Promise<CliResult<CoordinatorPane | null>> => {
  const read = await tmuxCall(deps, coordinatorReadArgs(session));
  if (!read.ok) return read;
  if (read.value.exitCode !== 0 || paneAbsent(read.value.stdout)) return ok(null);
  const parsed = parseCoordinatorPane(read.value.stdout);
  if (!parsed.ok) return failure(`cannot read the pane of the ${roles.coordinator} of the session ${session}: ${parsed.error}`);
  return ok(parsed.value.node ? parsed.value : null);
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
  // The call failed. When tmux has no such pane any more, it is gone, and that is the result that the caller wants. tmux exits 0
  // for the read of a pane id that does not exist, so the answer must hold a pane id. Any other failure stays a failure.
  const read = paneReadArgs(pane);
  if (!read.ok) return failure(read.error);
  const still = await tmuxCall(deps, read.value);
  if (!still.ok) return still;
  if (still.value.exitCode !== 0 || paneAbsent(still.value.stdout)) return ok('gone');
  return failure(`${toolNames.tmux} ${kill.value[0]} failed for the pane ${pane} (exit code ${closed.value.exitCode})`);
};
