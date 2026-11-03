import { COORDINATOR_LAYER, WORKER_LAYER } from '../config/schema.js';
import type { BlockRename } from '../migrate/files.js';
import { blockNames } from '../names.js';
import type { ApprovalModes } from '../recipes/index.js';
import { approvalRules, homeRoleBlockNames, roleForLayer, roleNameForLayer } from '../recipes/software/recipe.js';
import { PROFILE_INDEX_LINES, PROFILE_README_LINES } from './decision-profile.js';
import { fillTemplate } from './fill.js';
import { ROADMAPS_README_LINES } from './roadmaps.js';
import { safetyLines } from './safety.js';
import type { BlockTemplate } from './types.js';

/** The safety block belongs to the core. Every role gets it. Its approval point lines follow the modes. */
const safetyFor = (modes: ApprovalModes): BlockTemplate => ({
  name: blockNames.safety,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(safetyLines(approvalRules(modes))),
});

/**
 * The managed blocks of a node on this layer: its role block, the safety block, and, on layer 1,
 * the worker block. A worker has no home, so the node just above the workers holds the instructions that the workers follow.
 * A layer with no role template has the safety block only. The text of the approval points follows `modes`,
 * the mode of each approval point by point id.
 */
export const blockTemplatesFor = (layer: number, modes: ApprovalModes): readonly BlockTemplate[] => {
  const role = roleForLayer(layer, modes);
  const worker = layer === COORDINATOR_LAYER ? roleForLayer(WORKER_LAYER, modes) : null;
  return [role, safetyFor(modes), worker].filter((template): template is BlockTemplate => template !== null);
};

/**
 * The role blocks that another layer would hold, each as the old name of the role block of this layer.
 * A node whose layer was changed by hand holds one of them. A layer with no role template renames nothing.
 */
export const roleBlockRenames = (layer: number): readonly BlockRename[] => {
  const name = roleNameForLayer(layer);
  if (name === null) return [];
  return homeRoleBlockNames.filter((other) => other !== name).map((from) => ({ from, to: name }));
};

export const fileTemplates = {
  profileReadme: fillTemplate(PROFILE_README_LINES),
  profileIndex: fillTemplate(PROFILE_INDEX_LINES),
  roadmapsReadme: fillTemplate(ROADMAPS_README_LINES),
} as const;
