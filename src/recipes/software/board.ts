import type { RecipeBoard } from '../entry.js';
import { softwareQueueKey } from './words.js';

/** The stages of an item on the software board, in order. A new item gets the first one. */
export const softwareStages = ['ticket', 'plan-approved', 'building', 'review', 'fixes', 'merged', 'released'] as const;

type SoftwareStage = (typeof softwareStages)[number];

/**
 * The stages that only a flow sets, each with the name of its flow. The merge flow and the release flow set them, and no
 * board command does. The key of each entry must be a listed stage.
 */
const softwareFlowOnly = {
  merged: 'merge flow',
  released: 'release flow',
} as const satisfies Partial<Record<SoftwareStage, string>>;

/** The board data of the software recipe: the merge word is the queue key. */
export const softwareBoard: RecipeBoard = {
  queueKey: softwareQueueKey,
  stages: softwareStages,
  flowOnly: softwareFlowOnly,
};
