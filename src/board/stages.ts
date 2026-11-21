import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { ok } from '../core/result.js';
import { allOn, isGuardOn } from '../guards/effective.js';
import type { GuardValues } from '../guards/types.js';
import { guardIds, maxEchoChars } from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';

/**
 * The stages of an item. The recipe gives the list, the first stage of a new item and the stages that only a flow sets. The core
 * holds no stage word and no flow name: it reads them from the recipe data. A stage is display data and never proof.
 */

/** The mark after a stored stage that the list of the recipe does not hold. */
export const UNLISTED_MARK = '*';

/** The stages of the recipe, in order. A recipe with no stage list gives none. */
export const stagesOf = (board: RecipeBoard): readonly string[] => board.stages ?? [];

/** The stage of a new item: the first of the list, or null when the recipe has no stage list. */
export const firstStageOf = (board: RecipeBoard): string | null => stagesOf(board)[0] ?? null;

const flowOf = (board: RecipeBoard, stage: string): string | undefined =>
  board.flowOnly !== undefined && Object.hasOwn(board.flowOnly, stage) ? board.flowOnly[stage] : undefined;

/** A listed stage, else a usage error (exit 2) that lists the stages. A recipe with no stage list is a usage error too. */
export const requireStage = (board: RecipeBoard, stage: string): CliResult<string> => {
  const stages = stagesOf(board);
  if (stages.length === 0) return usageError('this setup has no stage list');
  if (!stages.includes(stage)) {
    return usageError(`unknown stage ${JSON.stringify(displayLine(stage, maxEchoChars))}; the stages are: ${stages.join(', ')}`);
  }
  return ok(stage);
};

/**
 * A stage that a command may set: a listed stage that no flow reserves. A stage that only a flow sets is a usage error (exit 2) that
 * names the flow, as the recipe gives it. While the guard of board edits is off in `guards`, a command may set such a stage too; the
 * stage must still be listed. The check needs no lock, so a command runs it before it takes the lock.
 */
export const requireSettableStage = (board: RecipeBoard, stage: string, guards: GuardValues = allOn): CliResult<string> => {
  const listed = requireStage(board, stage);
  if (!listed.ok) return listed;
  const flow = flowOf(board, stage);
  return flow === undefined || !isGuardOn(guards, guardIds.boardEdits) ? listed : usageError(`the stage ${stage} is set only by the ${flow}`);
};

/**
 * A stored stage for a line of output: cleaned for display, as written, and with `UNLISTED_MARK` after it when the list of the
 * recipe does not hold it. The list is the recipe's, and a stored value is data, so an unlisted stage is shown and never refused.
 */
export const stageShown = (board: RecipeBoard, stored: string): string =>
  `${displayLine(stored)}${stagesOf(board).includes(stored) ? '' : UNLISTED_MARK}`;
