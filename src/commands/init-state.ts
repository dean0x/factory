import { dirname, join } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { commitAll, gitInit, hasIdentity, requireStateConfigSafe, requireWorkTreeTop } from '../core/git.js';
import { ok } from '../core/result.js';
import { commands, commandText, dirs } from '../names.js';
import { guardPlanOf, guardPlanWarnings, installGuard } from '../state/guard.js';
import type { Layout } from '../state/layout.js';
import type { StateFile } from './init.js';

const FIRST_COMMIT_MESSAGE = 'chore: initialize the state';

/**
 * The remedy of a key that names a program in the config of the new repository. The repository has only the settings that git copied
 * from its template folder, and this run removes the staging folder, so the key is removed at its source.
 */
const TEMPLATE_REMEDY = `Remove the filter and hook settings from the git template folder (init.templateDir). Then run "${commandText(commands.init)}" again.`;

/**
 * What the new state folder holds: whether its first commit was made (git makes none when it has no identity), and the warnings
 * about the delete guard. A guard that only a person can repair is a warning, and the folder is made without it.
 */
export interface MadeState {
  readonly committed: boolean;
  readonly warnings: readonly string[];
}

/**
 * Make the state folder. The state files go into a staging folder first. The staging folder becomes a git repo, holds
 * the first commit when git has an identity, and is then renamed onto the state path. The staging folder can sit in a
 * folder of a repo (the root repo), so a commit waits until the folder is the top of its own work tree. The config of the new repo
 * must name no program that has no switch to turn it off for one call (a filter or a config hook, from a git template): the run
 * stops with a security stop before it stages a file. The delete guard is
 * written into the staging folder before the first commit (when the install can write it, see `guardPlanOf`); its setting names the
 * path that the folder has after the rename.
 * The rename needs an absent target: a state folder that another program made during the run is never replaced. A run that
 * fails may leave the staging folder, and the caller removes it.
 */
export const makeStateFolder = async (
  deps: Deps,
  layout: Layout,
  staging: string,
  stateFiles: readonly StateFile[],
): Promise<CliResult<MadeState>> => {
  const cleared = await deps.fs.remove(staging);
  if (!cleared.ok) return cleared;
  for (const file of stateFiles) {
    const target = join(staging, file.rel);
    const folder = await deps.fs.mkdir(dirname(target));
    if (!folder.ok) return folder;
    const written = await deps.fs.writeText(target, file.text);
    if (!written.ok) return written;
  }

  const initialized = await gitInit(deps, staging);
  if (!initialized.ok) return initialized;
  const top = await requireWorkTreeTop(deps, staging, dirs.state);
  if (!top.ok) return top;
  // A git template folder can put a key that names a program (a filter) into the config of the new repository, and the first
  // `git add` would run it. So the config is checked before any step that stages a file.
  const safe = await requireStateConfigSafe(deps, staging, commands.init);
  if (!safe.ok) return safe.error.kind === 'safety' ? safetyRefusal(safe.error.message, TEMPLATE_REMEDY) : safe;
  const guard = await guardPlanOf(deps, staging);
  if (!guard.ok) return guard;
  if (guard.value.action === 'install') {
    const guarded = await installGuard(deps, staging, layout.stateDir);
    if (!guarded.ok) return guarded;
  }
  const committed = await hasIdentity(deps, staging);
  if (committed) {
    const first = await commitAll(deps, staging, FIRST_COMMIT_MESSAGE);
    if (!first.ok) return first;
  }

  const target = await deps.fs.stat(layout.stateDir);
  if (!target.ok) return target;
  if (target.value !== null) return failure(`${dirs.state} was made by another program during the run`);
  const moved = await deps.fs.rename(staging, layout.stateDir);
  return moved.ok ? ok({ committed, warnings: guardPlanWarnings(guard.value) }) : moved;
};
