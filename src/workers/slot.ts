import { failure, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import {
  parseSlotList,
  parseSummonMark,
  setPaneOptionArgs,
  slotListArgs,
  summonMarkText,
  summonTimerArgs,
  swapPaneArgs,
  unsetPaneOptionArgs,
  type SlotRow,
  type SummonMark,
} from '../launch/tmux.js';
import { requireSession, tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { commandLines, commands, commandText, program, roles, summonLimits, tmuxNames } from '../names.js';
import { closePane, readPanes } from './panes.js';

/**
 * The slot of the view window (design 4.11). The window `view` holds the coordinator and one slot. The slot shows the board, or
 * a worker pane on request: `summon` swaps the pane of a worker with the pane in the slot, writes the summon mark on the board
 * pane, and starts one timer. The summon mark is the pane id of the summoned pane and a random token. The timer swaps the panes
 * back only while the mark still holds its token, so a newer summon, or `layout`, makes an older timer do nothing.
 *
 * While a pane is summoned, the board pane sits in the window `workers`, and it keeps its board mark and its summon mark. The
 * marks are pane options, and a program in a pane can set them: a reader checks every mark, and a mark that factory did not
 * write is a stop.
 */

/** What the slot marks of the session say. */
export interface SlotState {
  readonly rows: readonly SlotRow[];
  /** The one pane that carries the board mark, or null for none. */
  readonly board: SlotRow | null;
  /** The summon mark of the board pane, or null for none. */
  readonly summon: SummonMark | null;
}

const layoutLine = (): string => commandText(commands.layout);

/** The command line that summons the worker: the line to run again after a fix. */
const summonLine = (workerId: string): string => `${commandText(commandLines.workerSummon)} ${workerId}`;

/** The tmux call that clears a mark by hand. */
const clearText = (pane: string, option: string): string => `${toolNames.tmux} set-option -p -u -t ${pane} ${option}`;

/** Every pane of the session with its window and its slot marks, from one list call. A list that does not parse is a failure. */
export const readSlotRows = async (deps: Deps, session: string): Promise<CliResult<readonly SlotRow[]>> => {
  const listed = await tmuxStep(deps, slotListArgs(session));
  if (!listed.ok) return listed;
  const rows = parseSlotList(listed.value);
  return rows.ok ? ok(rows.value) : failure(`cannot read the slot marks: ${rows.error}`);
};

/**
 * What the slot marks of the panes say. More than one pane with the board mark, and a summon mark that is not a pane id with a
 * token, are stops (exit 4): factory writes the board mark on one pane, and the summon mark only as a pair.
 */
export const slotStateOf = (rows: readonly SlotRow[]): CliResult<SlotState> => {
  const boards = rows.filter((row) => row.board);
  const [board] = boards;
  if (board === undefined) return ok({ rows, board: null, summon: null });
  if (boards.length > 1) {
    return safetyRefusal(
      `${boards.length} panes carry the board mark: ${boards.map((row) => row.paneId).join(', ')}`,
      `Keep one board pane. For each other pane, run "${clearText('PANE', tmuxNames.optionSlot)}" with the id of the pane. Then run "${layoutLine()}" to check the marks.`,
    );
  }
  const summon = parseSummonMark(board.summonText);
  if (!summon.ok) {
    return safetyRefusal(
      `the summon mark of the board pane ${board.paneId} is not a mark that ${program} wrote`,
      `Run "${clearText(board.paneId, tmuxNames.optionSummon)}" to clear it. Then run "${layoutLine()}" to check the marks.`,
    );
  }
  return ok({ rows, board, summon: summon.value });
};

const inView = (row: SlotRow): boolean => row.window === tmuxNames.windowView;

export interface SummonRequest {
  /** The factory folder: an absolute path. */
  readonly home: string;
  /** The tmux session of the node: the id of the node. */
  readonly session: string;
  /** The id of a worker: a slug. The caller has checked that the worker has a record. */
  readonly workerId: string;
  /** The time of the summon in minutes, within `summonLimits`. */
  readonly minutes: number;
}

export interface SummonOutcome {
  /** The pane of the worker that the slot shows now. */
  readonly pane: string;
  /** The board pane. */
  readonly board: string;
  readonly minutes: number;
  /** The time when the timer swaps the board back. */
  readonly until: Date;
  /** False when the pane was in the slot already: the call then only started a new timer with a new token. */
  readonly swapped: boolean;
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** The pane that holds the slot now: the board pane, or the pane that the summon mark names. Anything else is an error that names the fix. */
const holderOf = (rows: readonly SlotRow[], board: SlotRow, summon: SummonMark | null, workerId: string): CliResult<SlotRow> => {
  if (summon === null) {
    return inView(board)
      ? ok(board)
      : failure(
          `the board pane ${board.paneId} is not in the window ${tmuxNames.windowView}, and no pane is summoned`,
          `Join the pane ${board.paneId} to the window ${tmuxNames.windowView} with the tmux command join-pane. Then run "${summonLine(workerId)}" again.`,
        );
  }
  const holder = rows.find((row) => row.paneId === summon.pane);
  return holder !== undefined && inView(holder)
    ? ok(holder)
    : failure(
        `the summoned pane ${summon.pane} that the board pane ${board.paneId} records is not in the window ${tmuxNames.windowView}`,
        `Run "${layoutLine()}" to clear the record. Then join the board pane ${board.paneId} to the window ${tmuxNames.windowView} with the tmux command join-pane.`,
      );
};

/**
 * Shows the pane of a worker in the slot of the view window for `minutes`. In order:
 * 1. the tmux session of the node must run (exit 3) and belong to this factory folder (exit 4);
 * 2. the worker must have one live pane: none is exit 3 and names `worker resume`, and two are exit 2;
 * 3. the slot marks are read: one board pane, and a summon mark that factory wrote;
 * 4. the pane of the worker is swapped with the pane that holds the slot (the board pane, or the pane of an earlier summon), unless
 *    it holds the slot already;
 * 5. a new token goes into the summon mark of the board pane, and one timer starts. A failed mark swaps the panes back. A failed
 *    timer keeps the slot and names `layout`, which shows the board again.
 */
export const summonWorker = async (deps: Deps, request: SummonRequest): Promise<CliResult<SummonOutcome>> => {
  const { home, session, workerId, minutes } = request;
  const ready = await requireSession(deps, session, home, summonLine(workerId));
  if (!ready.ok) return ready;
  const panes = await readPanes(deps, session, home);
  if (!panes.ok) return panes;
  const live = (panes.value ?? []).filter((row) => row.worker === workerId && !row.dead);
  const [target] = live;
  if (target === undefined) {
    return notReady(
      `the ${roles.worker} ${workerId} has no pane that runs`,
      `Run "${commandText(commandLines.workerResume)} ${workerId}" to start it. Then run "${summonLine(workerId)}" again.`,
    );
  }
  if (live.length > 1) {
    return usageError(
      `the ${roles.worker} ${workerId} has ${live.length} live panes: ${live.map((row) => row.paneId).join(', ')}`,
      `Close all but one of these panes in tmux. Then run "${summonLine(workerId)}" again.`,
    );
  }

  const rows = await readSlotRows(deps, session);
  if (!rows.ok) return rows;
  const state = slotStateOf(rows.value);
  if (!state.ok) return state;
  const { board } = state.value;
  if (board === null) {
    return failure(
      `no pane of the tmux session ${session} carries the board mark`,
      `The window ${tmuxNames.windowView} needs the board pane that ${commandText(commands.start)} makes. End the tmux session, then run "${commandText(commands.start)}".`,
    );
  }
  if (board.paneId === target.paneId) {
    return safetyRefusal(
      `the pane ${board.paneId} carries the board mark and the mark of the ${roles.worker} ${workerId}`,
      `Clear one mark with "${clearText(board.paneId, tmuxNames.optionWorker)}" or "${clearText(board.paneId, tmuxNames.optionSlot)}". Then run "${summonLine(workerId)}" again.`,
    );
  }
  const holder = holderOf(state.value.rows, board, state.value.summon, workerId);
  if (!holder.ok) return holder;

  const token = deps.randomHex(summonLimits.tokenBytes);
  if (!token.ok) return token;
  const mark = summonMarkText(target.paneId, token.value);
  const swap = swapPaneArgs(target.paneId, holder.value.paneId);
  const set = mark.ok ? setPaneOptionArgs(board.paneId, tmuxNames.optionSummon, mark.value) : mark;
  const seconds = minutes * SECONDS_PER_MINUTE;
  const timer = summonTimerArgs({ seconds, board: board.paneId, pane: target.paneId, token: token.value });
  if (!swap.ok) return failure(swap.error);
  if (!set.ok) return failure(set.error);
  if (!timer.ok) return failure(timer.error);

  const swapped = holder.value.paneId !== target.paneId;
  if (swapped) {
    const done = await tmuxStep(deps, swap.value);
    if (!done.ok) return done;
  }
  const marked = await tmuxStep(deps, set.value);
  if (!marked.ok) {
    if (swapped) await tmuxCall(deps, swap.value);
    return marked;
  }
  const started = await tmuxStep(deps, timer.value);
  if (!started.ok) {
    return failure(
      `the timer of the summon did not start: ${started.error.message}`,
      `The slot keeps showing the ${roles.worker} ${workerId}. Run "${layoutLine()}" to show the board again.`,
    );
  }
  return ok({
    pane: target.paneId,
    board: board.paneId,
    minutes,
    until: new Date(deps.now().getTime() + seconds * MS_PER_SECOND),
    swapped,
  });
};

/** What `restoreSlot` did. */
export type RestoreOutcome =
  /** No pane was summoned: nothing changed. */
  | { readonly kind: 'none' }
  /** The summoned pane went back to its place, and the board is in the slot again. */
  | { readonly kind: 'restored'; readonly board: string; readonly pane: string }
  /** The summon mark named a pane that is not in the slot. The mark is unset, and no pane moved. */
  | { readonly kind: 'cleared'; readonly board: string; readonly pane: string; readonly reason: string };

/** Why a summon mark gets no swap: the summoned pane is gone, the board pane is in the view window already, or the pane is elsewhere. */
const notRestoredBecause = (held: SlotRow | undefined, board: SlotRow): string => {
  if (held === undefined) return 'the pane is gone';
  if (inView(board)) return `the board pane is in the window ${tmuxNames.windowView} already`;
  return `the pane is not in the window ${tmuxNames.windowView}`;
};

/**
 * Shows the board in the slot again, from the slot marks that the caller read. A summoned pane that holds the slot is swapped back
 * with the board pane, and the summon mark is unset, so a timer that is still waiting does nothing. A summon mark that names a pane
 * that is gone, or a pane that is not in the view window, is unset with no swap.
 */
export const restoreSlot = async (deps: Deps, state: SlotState): Promise<CliResult<RestoreOutcome>> => {
  const { board, summon, rows } = state;
  if (board === null || summon === null) return ok({ kind: 'none' });
  const unset = unsetPaneOptionArgs(board.paneId, tmuxNames.optionSummon);
  if (!unset.ok) return failure(unset.error);
  const held = rows.find((row) => row.paneId === summon.pane);
  if (held === undefined || !inView(held) || inView(board)) {
    const cleared = await tmuxStep(deps, unset.value);
    if (!cleared.ok) return cleared;
    return ok({ kind: 'cleared', board: board.paneId, pane: summon.pane, reason: notRestoredBecause(held, board) });
  }
  const swap = swapPaneArgs(held.paneId, board.paneId);
  if (!swap.ok) return failure(swap.error);
  const swapped = await tmuxStep(deps, swap.value);
  if (!swapped.ok) return swapped;
  const cleared = await tmuxStep(deps, unset.value);
  if (!cleared.ok) return cleared;
  return ok({ kind: 'restored', board: board.paneId, pane: held.paneId });
};

/**
 * Shows the board in the slot again when a summon put this pane in the slot, before a command closes the pane. A pane that is
 * closed in the slot leaves the view window with no slot, and then no command can bring the board back. A summon mark that names
 * another pane, or no summon mark, changes nothing. Slot marks that cannot be read, or that factory did not write, change nothing
 * too: the slot is never changed on marks that factory can not trust, and `layout` and `summon` name the fault of the marks.
 */
export const releaseSlot = async (deps: Deps, session: string, pane: string): Promise<CliResult<void>> => {
  const rows = await readSlotRows(deps, session);
  const state = rows.ok ? slotStateOf(rows.value) : rows;
  if (!state.ok || state.value.summon?.pane !== pane) return ok(undefined);
  const restored = await restoreSlot(deps, state.value);
  return restored.ok ? ok(undefined) : restored;
};

/** Closes a pane of a worker by its id (`closePane`), after `releaseSlot`: a pane is never closed while a summon holds it in the slot. */
export const closeWorkerPane = async (deps: Deps, session: string, pane: string): Promise<CliResult<'closed' | 'gone'>> => {
  const released = await releaseSlot(deps, session, pane);
  return released.ok ? closePane(deps, pane) : released;
};
