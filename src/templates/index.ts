import { CELL_LAYER, COORDINATOR_LAYER } from '../config/schema.js';
import type { BlockRename } from '../migrate/files.js';
import { blockNames } from '../names.js';
import { homeRoleBlockNames, roleForLayer } from '../recipes/software/recipe.js';
import { PROFILE_INDEX_LINES, PROFILE_README_LINES } from './decision-profile.js';
import { fillTemplate } from './fill.js';
import { ROADMAPS_README_LINES } from './roadmaps.js';
import { SAFETY_LINES } from './safety.js';
import type { BlockTemplate } from './types.js';

/** The safety block belongs to the core. Every role gets it. */
const safety: BlockTemplate = {
  name: blockNames.safety,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(SAFETY_LINES),
};

/**
 * The managed blocks of a node on this layer: its role block, the safety block, and, on layer 1,
 * the worker block. A cell has no home, so the node just above the cells holds the instructions that the cells follow.
 */
export const blockTemplatesFor = (layer: number): readonly BlockTemplate[] => [
  roleForLayer(layer),
  safety,
  ...(layer === COORDINATOR_LAYER ? [roleForLayer(CELL_LAYER)] : []),
];

/**
 * The role blocks that another layer would hold, each as the old name of the role block of this layer.
 * A node whose layer was changed by hand holds one of them.
 */
export const roleBlockRenames = (layer: number): readonly BlockRename[] => {
  const { name } = roleForLayer(layer);
  return homeRoleBlockNames.filter((other) => other !== name).map((from) => ({ from, to: name }));
};

export const fileTemplates = {
  profileReadme: fillTemplate(PROFILE_README_LINES),
  profileIndex: fillTemplate(PROFILE_INDEX_LINES),
  roadmapsReadme: fillTemplate(ROADMAPS_README_LINES),
} as const;
