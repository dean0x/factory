import { renderBlock } from '../../src/blocks/managed.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { defaultOwnerPrefix } from '../../src/names.js';
import { ownerModes, recipes, type ApprovalModes } from '../../src/recipes/index.js';
import { blockInputOf, blockTemplatesFor, fileTemplates } from '../../src/templates/index.js';
import type { BlockInput, BlockTarget, BlockTemplate, SetupTexts } from '../../src/templates/types.js';

/** The software recipe, the first recipe of the package. */
export const [softwareRecipe] = recipes;

/** The mode of each approval point of the software recipe, the default: every point waits for the owner. */
export const softwareOwnerModes: ApprovalModes = ownerModes(softwareRecipe.approvalPoints);

/** An owner prefix without a contraction, so that the style tests of the template texts check the template and not the value. */
export const plainOwnerPrefix = '[From {owner}, typed by {node}, {date}]';

/** The default owner prefix of a new node. */
export const initOwnerPrefix: string = defaultOwnerPrefix;

/** No setup text: no setup block. */
export const noSetupTexts: SetupTexts = { coordinator: null, worker: null };

/** The setup texts that `init` writes. */
export const initSetupTexts: SetupTexts = {
  coordinator: fileTemplates.setupCoordinator,
  worker: fileTemplates.setupWorker,
};

/** The input of the blocks of a node on this layer, with the defaults of a new node. `overrides` change single parts. */
export const blockInput = (layer: number, overrides: Partial<Omit<BlockInput, 'layer'>> = {}): BlockInput => ({
  recipe: softwareRecipe,
  layer,
  modes: softwareOwnerModes,
  ownerPrefix: plainOwnerPrefix,
  limits: { contextPreparePct: 30, contextMaxPct: 40 },
  setup: noSetupTexts,
  ...overrides,
});

/** The managed blocks of a node that `init` made on this layer: the default prefix, the default limits and the setup texts. */
export const freshBlocks = (layer: number): readonly BlockTemplate[] =>
  blockTemplatesFor(blockInput(layer, { ownerPrefix: initOwnerPrefix, setup: initSetupTexts }));

/**
 * The text of `coordinator/CLAUDE.md` as the package renders it for this config and these modes: the role block and the
 * safety block of the file, one after the other, with no setup text.
 */
export const claudeFileText = (config: FactoryConfig, modes: ApprovalModes = softwareOwnerModes): string =>
  fileTextOf('claudeFile', config, noSetupTexts, modes);

/** The text of `.factory/roles/worker.md` as the package renders it for this config and these setup texts. */
export const workerFileText = (
  config: FactoryConfig,
  texts: SetupTexts,
  modes: ApprovalModes = softwareOwnerModes,
): string => fileTextOf('workerFile', config, texts, modes);

const fileTextOf = (target: BlockTarget, config: FactoryConfig, texts: SetupTexts, modes: ApprovalModes): string => {
  const blocks = blockTemplatesFor(blockInputOf(config, texts, modes))
    .filter((template) => template.target === target)
    .map((template) => {
      const rendered = renderBlock(template);
      if (!rendered.ok) throw new Error(rendered.error.message);
      return rendered.value;
    });
  return `${blocks.join('\n\n')}\n`;
};

/** The managed blocks of a node on layer 1 that `init` made: coordinator, safety, worker, setup and setup-worker. */
export const layer1Blocks: readonly BlockTemplate[] = freshBlocks(1);

/** The managed blocks of a node on layer 2 that `init` made: manager, safety and setup. */
export const layer2Blocks: readonly BlockTemplate[] = freshBlocks(2);

const plainLayer1: readonly BlockTemplate[] = blockTemplatesFor(blockInput(1));
const plainLayer2: readonly BlockTemplate[] = blockTemplatesFor(blockInput(2));

/** Every core block of the package once, with an owner prefix that holds no contraction, for the style tests. */
export const allBlocks: readonly BlockTemplate[] = [
  ...plainLayer1,
  ...plainLayer2.filter((block) => !plainLayer1.some((known) => known.name === block.name)),
];
