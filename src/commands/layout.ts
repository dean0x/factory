import type { CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { newWindowArgs, tileWorkersArgs } from '../launch/tmux.js';
import { requireSession, tmuxStep } from '../launch/tmux-run.js';
import { commands, commandText, roles, schemaIds, tmuxNames } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { boardJoinHint, readSlotRows, restoreSlot, slotStateOf, type RestoreOutcome } from '../workers/slot.js';

export interface LayoutOptions {
  readonly home: string | undefined;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** What the command says about the slot: a line for a board that came back, a warning for a summon mark that it had to clear. */
const slotOutput = (outcome: RestoreOutcome): { readonly lines: readonly OutLine[]; readonly warnings: readonly string[] } => {
  switch (outcome.kind) {
    case 'none':
      return { lines: [], warnings: [] };
    case 'restored':
      return { lines: [text(`The board is in the slot of the window ${tmuxNames.windowView} again (pane ${outcome.board}).`)], warnings: [] };
    case 'cleared':
      return {
        lines: [],
        warnings: [
          `The summon mark of the board pane ${outcome.board} named the pane ${outcome.pane}, but ${outcome.reason}. ` +
            `The mark is cleared, and no pane moved.`,
        ],
      };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
};

/**
 * `layout`: makes the windows of the tmux session of the node again, as far as it can. In order:
 * 1. the tmux session of the node must run (exit 3) and belong to this factory folder (exit 4);
 * 2. a missing window `workers` is made, in the folder of the coordinator, and its panes are tiled. The window `view` holds the
 *    coordinator, so `start` makes it, and a session that lacks it gets a warning;
 * 3. a pane that a summon put in the slot goes back, and the board is in the slot again. The summon mark is unset, so the timer
 *    of the summon does nothing. A board pane that is still outside the window `view` (the summoned pane is gone, or a person
 *    moved the board) gets a warning that names the tmux command that joins it to the window again.
 * It works on a session that has only the window `view`, and it writes no file.
 */
export const runLayout = async (deps: Deps, options: LayoutOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.layout,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const session = loaded.value.core.node.id;
  const ready = await requireSession(deps, session, home, commandText(commands.layout));
  if (!ready.ok) return ready;
  const rows = await readSlotRows(deps, session);
  if (!rows.ok) return rows;

  const hasWindow = (name: string): boolean => rows.value.some((row) => row.window === name);
  const workers = hasWindow(tmuxNames.windowWorkers) ? 'present' : 'made';
  if (workers === 'made') {
    const made = await tmuxStep(deps, newWindowArgs(session, tmuxNames.windowWorkers, layoutOf(home).coordinatorDir));
    if (!made.ok) return made;
  }
  const tiled = await tmuxStep(deps, tileWorkersArgs(session));
  if (!tiled.ok) return tiled;

  // The windows are made before the marks are read, so a mark that is not valid stops the command only after the windows exist.
  const state = slotStateOf(rows.value);
  if (!state.ok) return state;
  const restored = await restoreSlot(deps, state.value);
  if (!restored.ok) return restored;

  const view = hasWindow(tmuxNames.windowView) ? 'present' : 'missing';
  const slot = slotOutput(restored.value);
  const joinHint = boardJoinHint(state.value, restored.value);
  const viewWarning =
    view === 'missing'
      ? [
          `The window ${tmuxNames.windowView} does not exist, so the ${roles.coordinator} and the slot are missing. ` +
            `End the tmux session, then run "${commandText(commands.start)}".`,
        ]
      : [];
  return ok({
    lines: [
      text(workers === 'made' ? `Made the window ${tmuxNames.windowWorkers}.` : `The window ${tmuxNames.windowWorkers} exists.`),
      text(`Tiled the panes of the window ${tmuxNames.windowWorkers}.`),
      ...slot.lines,
    ],
    json: {
      schema: schemaIds.layout,
      workers,
      view,
      slot: restored.value.kind,
      ...(restored.value.kind === 'none' ? {} : { board: restored.value.board, pane: restored.value.pane }),
    },
    warnings: [...viewWarning, ...slot.warnings, ...(joinHint === null ? [] : [joinHint])],
    failed: false,
  });
};
