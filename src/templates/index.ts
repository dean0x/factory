import { COORDINATOR_LAYER, WORKER_LAYER, type FactoryConfig } from '../config/schema.js';
import type { BlockRename } from '../migrate/files.js';
import { blockNames } from '../names.js';
import { approvalLines, ownerModes, type ApprovalModes, type RecipeEntry } from '../recipes/index.js';
import { PROFILE_INDEX_LINES, PROFILE_README_LINES } from './decision-profile.js';
import { coordinatorValuesFor, fillTemplate } from './fill.js';
import { ROADMAPS_README_LINES } from './roadmaps.js';
import { safetyLines } from './safety.js';
import { SETUP_COORDINATOR_LINES, SETUP_WORKER_LINES } from './setup.js';
import type { BlockInput, BlockTemplate, SetupTexts } from './types.js';

/**
 * The safety block belongs to the core. Every role gets it. Its approval point lines follow the modes, the recipe adds
 * its own lines, and it holds the owner prefix. It lives in the coordinator folder, so its paths are written from that folder.
 */
const safetyFor = (input: BlockInput): BlockTemplate => ({
  name: blockNames.safety,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(
    safetyLines(approvalLines(input.recipe.approvalPoints, input.modes), input.recipe.safetyLines),
    coordinatorValuesFor(input),
  ),
});

const NO_SETUP: SetupTexts = { coordinator: null, worker: null };

/**
 * The safety block as this package renders it for the config and the effective modes. The setup texts do not change it,
 * so a caller that checks the safety block alone needs none.
 */
export const safetyTemplateFor = (config: FactoryConfig, modes: ApprovalModes): BlockTemplate =>
  safetyFor(blockInputOf(config, NO_SETUP, modes));

/** The block of a setup text, or none when the text is absent or empty. The body is the text as it is. */
const setupBlock = (name: string, target: BlockTemplate['target'], text: string | null): readonly BlockTemplate[] =>
  text === null ? [] : [{ name, version: 1, target, body: text }];

/**
 * The managed blocks of a node on this layer: its role block, the safety block, and, on layer 1 and above, the worker
 * block. A worker has no home, so the node that holds the workers has the instructions that the workers follow. A node
 * on layer 2 or above can hold workers and child nodes at the same time. A layer with no role template has the safety block
 * and the worker block. After the core blocks come the blocks of the setup texts: the coordinator text goes into the
 * coordinator file, and the worker text goes into the worker file of a node that has one. The text of the blocks follows
 * `input`.
 */
export const blockTemplatesFor = (input: BlockInput): readonly BlockTemplate[] => {
  const role = input.recipe.roles.templateFor(input);
  const worker =
    input.layer >= COORDINATOR_LAYER
      ? input.recipe.roles.templateFor({ ...input, layer: WORKER_LAYER, holderLayer: input.layer })
      : null;
  const core = [role, safetyFor(input), worker].filter((template): template is BlockTemplate => template !== null);
  const hasWorkerFile = core.some((template) => template.target === 'workerFile');
  return [
    ...core,
    ...setupBlock(blockNames.setup, 'claudeFile', input.setup.coordinator),
    ...(hasWorkerFile ? setupBlock(blockNames.setupWorker, 'workerFile', input.setup.worker) : []),
  ];
};

/**
 * The blocks of the worker file of a node, as this package renders them for the config and the worker setup text: the
 * worker block, then the setup worker block when the text is not absent. No text of the worker file follows the approval
 * modes, so the function applies the modes of the owner and a caller reads no mode.
 */
export const workerFileTemplatesFor = (config: FactoryConfig, setupWorker: string | null): readonly BlockTemplate[] =>
  blockTemplatesFor(
    blockInputOf(config, { coordinator: null, worker: setupWorker }, ownerModes(config.entry.approvalPoints)),
  ).filter((template) => template.target === 'workerFile');

/**
 * What the blocks of a node depend on, from its config, its setup texts and the effective mode of each approval point.
 * The text names the proof of a point only when its effective mode is `delegated`.
 */
export const blockInputOf = (config: FactoryConfig, setup: SetupTexts, modes: ApprovalModes): BlockInput => ({
  recipe: config.entry,
  layer: config.core.node.layer,
  nodeId: config.core.node.id,
  modes,
  ownerPrefix: config.core.owner.prefix,
  limits: {
    contextPreparePct: config.core.limits.context_prepare_pct,
    contextMaxPct: config.core.limits.context_max_pct,
  },
  setup,
});

/**
 * The role blocks that another layer would hold, each as the old name of the role block of this layer.
 * A node whose layer was changed by hand holds one of them. A layer with no role template renames nothing.
 */
export const roleBlockRenames = (recipe: RecipeEntry, layer: number): readonly BlockRename[] => {
  const name = recipe.roles.nameForLayer(layer);
  if (name === null) return [];
  return recipe.roles.homeBlockNames.filter((other) => other !== name).map((from) => ({ from, to: name }));
};

export const fileTemplates = {
  profileReadme: fillTemplate(PROFILE_README_LINES),
  profileIndex: fillTemplate(PROFILE_INDEX_LINES),
  roadmapsReadme: fillTemplate(ROADMAPS_README_LINES),
  setupCoordinator: fillTemplate(SETUP_COORDINATOR_LINES),
  setupWorker: fillTemplate(SETUP_WORKER_LINES),
} as const;
