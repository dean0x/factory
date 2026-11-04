import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandText, files, maxFileBytes, type CommandName } from '../names.js';
import { withShareList } from './files.js';
import type { Layout } from './layout.js';

/** The root `.gitignore` as it is now, and as it is with the current share list. */
export interface RootGitignore {
  /** The text of the file, or null when the file is not there. */
  readonly original: string | null;
  /** The text with the current share list. Every line outside the part stays as it is. */
  readonly text: string;
}

/**
 * Read the root `.gitignore` and make its text with the current share list. `init` and `upgrade` use this one function,
 * so both keep the lines of a person the same way. It writes nothing. A path that is not a file, a file that is too
 * large and a marker line with no pair are errors (exit 1) with a remedy line.
 */
export const rootGitignoreOf = async (
  deps: Deps,
  layout: Layout,
  command: CommandName,
): Promise<CliResult<RootGitignore>> => {
  const kind = await deps.fs.stat(layout.gitignoreFile);
  if (!kind.ok) return kind;
  if (kind.value !== null && kind.value !== 'file') {
    return failure(`${files.gitignore} is not a file`, `Move it away, then run "${commandText(command)}" again.`);
  }
  let original: string | null = null;
  if (kind.value === 'file') {
    const read = await deps.fs.readTextLimited(layout.gitignoreFile, maxFileBytes);
    if (!read.ok) return read;
    original = read.value;
  }
  const withList = withShareList(original);
  if (!withList.ok) {
    return failure(withList.error, `Remove the marker lines from ${files.gitignore}, then run "${commandText(command)}" again.`);
  }
  return ok({ original, text: withList.value });
};
