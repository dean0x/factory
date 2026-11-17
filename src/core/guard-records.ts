import { safetyRefusal, type CliResult } from '../cli/errors.js';
import { commandText, env, files, guardRecordWords, type CommandText } from '../names.js';
import type { Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { isWrittenInside } from './paths.js';
import { userStatePlaceOf, type StateFilePlace } from './private-file.js';
import { ok } from './result.js';

/** Guard records always require their own input and output terminals, outside either session type. */
export const requireGuardChannel = (deps: Deps, command: CommandText): CliResult<void> => {
  const remedy = `${guardRecordWords.channelRemedy} Then run "${commandText(command)}".`;
  if (inFactorySession(deps)) return safetyRefusal(guardRecordWords.sessionRefused, remedy);
  const claudeCode = deps.env[env.claudeCode];
  if (claudeCode !== undefined && claudeCode !== '') return safetyRefusal(guardRecordWords.claudeRefused, remedy);
  if (!deps.stdinIsTTY) return safetyRefusal(guardRecordWords.inputRequired, remedy);
  if (!deps.stdoutIsTTY) return safetyRefusal(guardRecordWords.outputRequired, remedy);
  return ok(undefined);
};

/** A pure place check. Readers and writers must refuse an inside place before any store access. */
export const guardStorePathOf = (deps: Deps, root: string): StateFilePlace => {
  const place = userStatePlaceOf(deps, files.guardRecords);
  return { path: place.path, inside: place.inside || (place.path !== null && isWrittenInside(deps, root, place.path)) };
};
