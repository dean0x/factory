import { join } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandText, dirs, files, maxFileBytes, type CommandName } from '../names.js';
import { withAddedLines, withShareList } from './files.js';
import type { Layout } from './layout.js';

/** A `.gitignore` as it is now, and as it is with the lines that the tool writes. */
export interface GitignoreTexts {
  /** The text of the file, or null when the file is not there. */
  readonly original: string | null;
  /** The new text. Every line that the tool does not write stays as it is. */
  readonly text: string;
}

/** The `.gitignore` of the state repo: the texts, and the lines that the new text adds to an existing file. */
export interface StateGitignoreTexts extends GitignoreTexts {
  readonly added: readonly string[];
}

/**
 * The text of a `.gitignore`, or null when the file is not there. `label` names the file for a person. A path that is not
 * a file and a file that is too large are errors (exit 1) with a remedy line.
 */
const readGitignore = async (
  deps: Deps,
  path: string,
  label: string,
  command: CommandName,
): Promise<CliResult<string | null>> => {
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return kind;
  if (kind.value !== null && kind.value !== 'file') {
    return failure(`${label} is not a file`, `Move it away, then run "${commandText(command)}" again.`);
  }
  return kind.value === 'file' ? deps.fs.readTextLimited(path, maxFileBytes) : ok(null);
};

/**
 * Read the root `.gitignore` and make its text with the current share list. `init` and `upgrade` use this one function,
 * so both keep the lines of a person the same way. It writes nothing. A path that is not a file, a file that is too
 * large and a marker line with no pair are errors (exit 1) with a remedy line.
 */
export const rootGitignoreOf = async (
  deps: Deps,
  layout: Layout,
  command: CommandName,
): Promise<CliResult<GitignoreTexts>> => {
  const original = await readGitignore(deps, layout.gitignoreFile, files.gitignore, command);
  if (!original.ok) return original;
  const withList = withShareList(original.value);
  if (!withList.ok) {
    return failure(withList.error, `Remove the marker lines from ${files.gitignore}, then run "${commandText(command)}" again.`);
  }
  return ok({ original: original.value, text: withList.value });
};

/**
 * Read the `.gitignore` of the state repo and make its text with each line that a later version added (the workers folder and
 * the inbox). Every other line stays as it is. It writes nothing. A path that is not a file and a file that is too large are
 * errors (exit 1) with a remedy line.
 */
export const stateGitignoreOf = async (
  deps: Deps,
  layout: Layout,
  command: CommandName,
): Promise<CliResult<StateGitignoreTexts>> => {
  const original = await readGitignore(deps, layout.stateGitignoreFile, join(dirs.state, files.gitignore), command);
  if (!original.ok) return original;
  return ok({ original: original.value, ...withAddedLines(original.value) });
};
