import type { BlockSpec } from '../blocks/managed.js';

/** The file that holds a managed block. */
export type BlockTarget = 'claudeFile' | 'workerFile';

export interface BlockTemplate extends BlockSpec {
  readonly target: BlockTarget;
}
