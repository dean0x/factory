import { relative } from 'node:path';
import type { CliResult } from '../cli/errors.js';
import { declinedHookText, ensureHookSettings, requireHookConsent, type HookConsentRequest } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, hookSessions } from '../names.js';
import { layoutOf } from '../state/layout.js';

/**
 * The hook settings of the coordinator folder in `init`. The stop for a missing consent comes before the first write of the
 * command, like every other check. The question comes after the last write, because the coordinator folder exists then,
 * and it follows the setup acceptance. An answer of no does not fail the command.
 */

/** What the step did: the file that it wrote, relative to the factory folder, and the notices for the person. */
export interface HookStep {
  readonly written: readonly string[];
  readonly warnings: readonly string[];
}

const requestOf = (home: string, yes: boolean): HookConsentRequest => ({
  folder: layoutOf(home).coordinatorDir,
  session: hookSessions.coordinator,
  yes,
  command: commands.init,
});

/** Stop before the first write when the person can not give the consent later: no terminal window and no yes that counts. */
export const checkHookConsent = (deps: Deps, home: string, yes: boolean): Promise<CliResult<void>> =>
  requireHookConsent(deps, requestOf(home, yes));

/** Ask for the hook settings and write them, after the last write of the command. A no goes on with a notice. */
export const writeHookSettings = async (deps: Deps, home: string, yes: boolean): Promise<CliResult<HookStep>> => {
  const done = await ensureHookSettings(deps, { ...requestOf(home, yes), dryRun: false });
  if (!done.ok) return done;
  if (done.value.kind === 'written') return ok({ written: [relative(home, done.value.file)], warnings: [] });
  if (done.value.kind === 'declined') return ok({ written: [], warnings: [declinedHookText(done.value.file, commands.init)] });
  return ok({ written: [], warnings: [] });
};
