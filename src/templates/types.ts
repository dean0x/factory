import type { BlockSpec } from '../blocks/managed.js';
import type { ApprovalModes, RecipeEntry } from '../recipes/index.js';

/** The file that holds a managed block. */
export type BlockTarget = 'claudeFile' | 'workerFile';

export interface BlockTemplate extends BlockSpec {
  readonly target: BlockTarget;
}

/**
 * The texts that a person writes in the setup folder and shares, as they go into a block: the line ends are LF, and a
 * file that is absent or empty gives null, which renders no block.
 */
export interface SetupTexts {
  readonly coordinator: string | null;
  readonly worker: string | null;
}

/** The context limits of the shared file that the coordinator text states. */
export interface ContextLimits {
  readonly contextPreparePct: number;
  readonly contextMaxPct: number;
}

/**
 * What the text of the managed blocks of a node depends on: the recipe, the layer, the id of the node, the mode of each
 * approval point, the owner prefix of the local file, the context limits of the shared file and the setup texts.
 */
export interface BlockInput {
  readonly recipe: RecipeEntry;
  readonly layer: number;
  /** The id of the node. The session of the coordinator has this name, and the session of a worker has `<node id>-<worker id>`. */
  readonly nodeId: string;
  readonly modes: ApprovalModes;
  readonly ownerPrefix: string;
  readonly limits: ContextLimits;
  readonly setup: SetupTexts;
}
