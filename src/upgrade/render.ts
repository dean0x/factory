import { inspectBlocks } from '../blocks/status.js';
import type { CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import type { ApprovalModes } from '../recipes/index.js';
import { blockInputOf, blockTemplatesFor } from '../templates/index.js';
import type { SetupTexts } from '../templates/types.js';
import { blockFileTexts, writeAll, type Written } from './apply.js';
import { planBlock } from './plan.js';

/** The blocks of the coordinator file leave out the setup texts: a render of the modes never carries a text that is not accepted. */
const NO_SETUP: SetupTexts = { coordinator: null, worker: null };

/** The actions of `planBlock` that need no word from the owner: the block is current, it is rendered, or it is not there. */
const QUIET: readonly string[] = ['current', 'render', 'skip-missing'];

export interface CoordinatorRender {
  /** True when the render wrote the coordinator file. */
  readonly wrote: boolean;
  /** The names of the blocks that the render leaves as they are: edited, malformed, or of an older version. */
  readonly kept: readonly string[];
}

/**
 * Render the blocks of the coordinator file again for these modes. This is the render of `upgrade`: the same templates,
 * the same check of each block, the same edit and the same atomic write. It changes only a block that is intact, of the
 * current version and different from its template. A block that was edited, a file that is not valid and a block of an
 * older version stay as they are, and the result names them. A file or a block that is not there is not written.
 */
export const renderCoordinatorText = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  modes: ApprovalModes,
): Promise<CliResult<CoordinatorRender>> => {
  const templates = blockTemplatesFor(blockInputOf(config, NO_SETUP, modes)).filter((template) => template.target === 'claudeFile');
  const plans = (await inspectBlocks(deps, home, templates)).map((status) => planBlock(status, false));
  const kept = plans.filter((plan) => !QUIET.includes(plan.action)).map((plan) => plan.template.name);
  const changes = plans.filter((plan) => plan.action === 'render');
  if (changes.length === 0) return ok({ wrote: false, kept });

  const texts = await blockFileTexts(deps, home, changes);
  if (!texts.ok) return texts;
  const written: Written[] = [];
  const wrote = await writeAll(deps, home, texts.value, written);
  return wrote.ok ? ok({ wrote: written.length > 0, kept }) : wrote;
};
