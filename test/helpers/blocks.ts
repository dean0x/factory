import { blockTemplatesFor } from '../../src/templates/index.js';
import type { BlockTemplate } from '../../src/templates/types.js';

/** The managed blocks of a node on layer 1: coordinator, safety and worker. */
export const layer1Blocks: readonly BlockTemplate[] = blockTemplatesFor(1);

/** The managed blocks of a node on layer 2: manager and safety. */
export const layer2Blocks: readonly BlockTemplate[] = blockTemplatesFor(2);

/** Every block of the package once. */
export const allBlocks: readonly BlockTemplate[] = [
  ...layer1Blocks,
  ...layer2Blocks.filter((block) => !layer1Blocks.some((known) => known.name === block.name)),
];
