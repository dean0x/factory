import { inspectBlocks } from '../blocks/status.js';
import { failure, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { commitPaths, requireStateRepoCommit, unstagePaths, type RepoPaths } from '../core/git.js';
import { ok } from '../core/result.js';
import { setupBlockNames, type CommandName } from '../names.js';
import type { ApprovalModes } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { blockInputOf, blockTemplatesFor } from '../templates/index.js';
import type { BlockTemplate, SetupTexts } from '../templates/types.js';
import { blockFileTexts, inStateRepo, restore, writeAll, type Written } from './apply.js';
import { planBlock, type BlockPlan } from './plan.js';

/** The blocks of the coordinator file leave out the setup texts: a render of the modes never carries a text that is not accepted. */
const NO_SETUP: SetupTexts = { coordinator: null, worker: null };

/** The actions of `planBlock` that need no word from the owner: the block is current, or it is not there. */
const QUIET: readonly BlockPlan['action'][] = ['current', 'skip-missing'];

/** The actions of `planBlock` that the render of the text of the modes writes: an intact block that differs from its template. */
const MODE_WRITES: readonly BlockPlan['action'][] = ['render'];

/** The actions that the render of the setup text writes: a changed text, and a block that is not there yet. */
const SETUP_WRITES: readonly BlockPlan['action'][] = ['render', 'add'];

const COMMIT_MESSAGE = 'chore: render the state text';

/**
 * Write the new text of each file that holds one of these planned blocks: the same edit and the same atomic write as
 * `upgrade`. A file in the state repo is committed with the same steps as `upgrade`; a file outside it is not. A failed
 * write or commit puts every file back as it was. `command` is the command that the person runs again after a stop. The
 * value is true when a file was written.
 */
export const writeBlockPlans = async (
  deps: Deps,
  home: string,
  changes: readonly BlockPlan[],
  command: CommandName,
): Promise<CliResult<boolean>> => {
  const texts = await blockFileTexts(deps, home, changes);
  if (!texts.ok) return texts;
  const layout = layoutOf(home);
  const touched = inStateRepo(layout, texts.value.map((file) => file.path));
  if (touched.length > 0) {
    const ready = await requireStateRepoCommit(deps, layout.stateDir, touched, 'the render', command);
    if (!ready.ok) return ready;
  }

  const written: Written[] = [];
  const wrote = await writeAll(deps, home, texts.value, written);
  const paths: RepoPaths = { present: inStateRepo(layout, written.map((entry) => entry.path)), gone: [] };
  const committed = wrote.ok && paths.present.length > 0 ? await commitPaths(deps, layout.stateDir, paths, COMMIT_MESSAGE) : wrote;
  if (committed.ok) return ok(written.length > 0);

  const problems = await restore(deps, home, written);
  const unstaged = wrote.ok ? await unstagePaths(deps, layout.stateDir, paths) : ok(undefined);
  const notes = [...problems, ...(unstaged.ok ? [] : [unstaged.error.message])];
  return notes.length === 0 ? committed : failure(`${committed.error.message}. ${notes.join('; ')}`);
};

export interface CoordinatorRender {
  /** True when the render wrote a file. */
  readonly wrote: boolean;
  /** The names of the blocks that the render leaves as they are: edited, malformed, or of an older version. */
  readonly kept: readonly string[];
}

/**
 * Render these templates again with the checks of `upgrade`: the same templates, the same check of each block, the same
 * edit and the same atomic write. It writes a block only when its plan has one of the `writes` actions. A block that was
 * edited, a file that is not valid and a block of an older version stay as they are, and the result names them. A file or
 * a block that is not there is not written, unless the actions say so.
 */
const renderTemplates = async (
  deps: Deps,
  home: string,
  templates: readonly BlockTemplate[],
  writes: readonly BlockPlan['action'][],
  command: CommandName,
): Promise<CliResult<CoordinatorRender>> => {
  const plans = (await inspectBlocks(deps, home, templates)).map((status) => planBlock(status, false));
  const kept = plans.filter((plan) => ![...QUIET, ...writes].includes(plan.action)).map((plan) => plan.template.name);
  const changes = plans.filter((plan) => writes.includes(plan.action));
  if (changes.length === 0) return ok({ wrote: false, kept });

  const wrote = await writeBlockPlans(deps, home, changes, command);
  return wrote.ok ? ok({ wrote: wrote.value, kept }) : wrote;
};

/**
 * Render the blocks of the coordinator file again for these modes. This is the render of `upgrade`. It changes only a block
 * that is intact, of the current version and different from its template.
 */
export const renderCoordinatorText = (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  modes: ApprovalModes,
  command: CommandName,
): Promise<CliResult<CoordinatorRender>> =>
  renderTemplates(
    deps,
    home,
    blockTemplatesFor(blockInputOf(config, NO_SETUP, modes)).filter((template) => template.target === 'claudeFile'),
    MODE_WRITES,
    command,
  );

/**
 * Render the setup blocks again from the texts that the owner accepted: the coordinator text and the worker text. These are
 * the bytes that the hash of the acceptance covers. A setup block that a person edited stays as it is, and the result names
 * it, because `upgrade` puts the text back and keeps the edit in a backup file.
 */
export const renderSetupText = (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  modes: ApprovalModes,
  texts: SetupTexts,
  command: CommandName,
): Promise<CliResult<CoordinatorRender>> =>
  renderTemplates(
    deps,
    home,
    blockTemplatesFor(blockInputOf(config, texts, modes)).filter((template) => setupBlockNames.includes(template.name)),
    SETUP_WRITES,
    command,
  );
