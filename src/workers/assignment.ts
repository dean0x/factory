import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { workTreeTop } from '../core/git.js';
import { comparable, isSameOrInside } from '../core/paths.js';
import { ok } from '../core/result.js';
import { assignmentSource, commandText, files, places } from '../names.js';
import { readCheckedFile } from './registry.js';

/**
 * The check of the source file of an assignment (`worker new --assignment FILE`). It runs before any write, and it hands back the text
 * of the file. The file is a path that a person gives, and its text goes into a folder that a worker session reads, so the check is a
 * trust boundary. In this order:
 * 1. the real path of the file is inside the factory folder, or inside the git work tree of the working folder (exit 4);
 * 2. no part of the path from that top down is a link (exit 4);
 * 3. no part below the top starts with a dot, except the orders folder below the factory folder, and the local config of the factory
 *    folder is never read (exit 4);
 * 4. the file is a plain file of at most `assignmentSource.maxBytes`, with valid UTF-8 text and no NUL (exit 2; a link is exit 4);
 * 5. the text is read once. After the read, the kind of the path and its real path are read again, and a change is exit 4.
 * The caller copies the text that this check returns, and never reads the file again. A message never holds a part of the text.
 */

/** The most levels of a path that the walk up from the file visits. A path with more levels is outside the tops. */
const MAX_LEVELS = 64;

/** The mark of the decoder for a byte sequence that is not UTF-8. */
const REPLACEMENT = '�';
const NUL = '\0';

export interface AssignmentRequest {
  /** The factory folder. */
  readonly home: string;
  /**
   * The path as the person wrote it. A path that is not absolute starts at the working folder, except a path whose first parts are
   * the orders folder, with no climb: it starts at the factory folder.
   */
  readonly path: string;
  /** The command to run again, without the program name: for example `worker new alpha --project web --assignment FILE`. */
  readonly again: string;
}

/** A top that the file can be in: its real path, and whether it is the factory folder. */
interface Top {
  readonly real: string;
  readonly isFactory: boolean;
}

const topOf = async (deps: Deps, path: string, isFactory: boolean): Promise<CliResult<Top>> => {
  const real = await deps.fs.realpath(path);
  return real.ok ? ok({ real: real.value, isFactory }) : real;
};

/** The factory folder, then the git work tree of the working folder when there is one. */
const topsOf = async (deps: Deps, home: string): Promise<CliResult<readonly Top[]>> => {
  const factory = await topOf(deps, home, true);
  if (!factory.ok) return factory;
  const treeTop = await workTreeTop(deps, deps.cwd);
  if (treeTop === null) return ok([factory.value]);
  const tree = await topOf(deps, treeTop, false);
  return tree.ok ? ok([factory.value, tree.value]) : tree;
};

const sameName = (deps: Deps, a: string, b: string): boolean => comparable(deps, a) === comparable(deps, b);

/**
 * The names of the written path from the top down to the file. The walk goes up from the file, one folder at a time, and stops at the
 * folder whose real path is the top. A part that is a link is a stop. The links above the top are no concern. The value is null when
 * the walk does not meet the top, which means that a link on the way leads into it.
 */
const namesBelow = async (
  deps: Deps,
  top: Top,
  source: string,
  refuseLink: () => CliResult<never>,
): Promise<CliResult<readonly string[] | null>> => {
  const names: string[] = [];
  let current = source;
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const real = await deps.fs.realpath(current);
    if (!real.ok) return real;
    if (sameName(deps, real.value, top.real)) return ok(names);
    const kind = await deps.fs.lstat(current);
    if (!kind.ok) return kind;
    if (kind.value === 'link') return refuseLink();
    names.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) return ok(null);
    current = parent;
  }
  return ok(null);
};

/** The reason that the names refuse, or null when the fixed rule lets them pass. */
const dotRuleReason = (deps: Deps, top: Top, names: readonly string[]): string | null => {
  const [first] = names;
  if (top.isFactory && names.length === 1 && first !== undefined && sameName(deps, first, files.localConfig)) {
    return `${files.localConfig} holds the settings of one person on one machine`;
  }
  const orders = assignmentSource.ordersParts;
  const inOrders =
    top.isFactory && names.length > orders.length && orders.every((part, index) => sameName(deps, names[index] ?? '', part));
  const hidden = names.slice(inOrders ? orders.length : 0).find((name) => name.startsWith(assignmentSource.dotMark));
  return hidden === undefined ? null : `${JSON.stringify(hidden)} starts with a dot`;
};

/** The check of the place of the file: the top that holds it, and the names below the top. A refusal is exit 4. */
const placeOf = async (
  deps: Deps,
  request: AssignmentRequest,
  source: string,
  real: string,
): Promise<CliResult<{ readonly top: Top; readonly names: readonly string[] }>> => {
  const copy = `Copy the task into ${assignmentSource.ordersShown} of the ${places.folder}, or into your work tree. Then run "${commandText(request.again)}" with the path of the copy.`;
  const refuseLink = (): CliResult<never> =>
    safetyRefusal(
      `cannot use ${source}: a link is on its path below the ${places.folder} or the work tree`,
      `Use the path of the file itself, with no link. ${copy}`,
    );
  const tops = await topsOf(deps, request.home);
  if (!tops.ok) return tops;
  for (const top of tops.value) {
    if (!isSameOrInside(comparable(deps, top.real), comparable(deps, real))) continue;
    const names = await namesBelow(deps, top, source, refuseLink);
    if (!names.ok) return names;
    if (names.value === null || !sameName(deps, join(top.real, ...names.value), real)) return refuseLink();
    const reason = dotRuleReason(deps, top, names.value);
    if (reason !== null) return safetyRefusal(`cannot use ${source}: ${reason}`, copy);
    return ok({ top, names: names.value });
  }
  return safetyRefusal(`cannot use ${source}: it is not inside the ${places.folder} or the work tree of the working folder`, copy);
};

/**
 * The absolute path of the file. A relative path whose first parts are the orders folder names a file of the orders folder of the
 * factory folder, from any working folder: the help and the coordinator block name it so. Every other relative path starts at the
 * working folder. The parts are compared after `normalize`, so a path that only reaches the orders folder by a climb (`x/..`)
 * starts at the working folder too.
 */
const sourceOf = (deps: Deps, home: string, path: string): string => {
  if (isAbsolute(path)) return resolve(path);
  const parts = normalize(path).split(sep);
  const orders = assignmentSource.ordersParts;
  const inOrders = parts.length > orders.length && orders.every((part, index) => sameName(deps, parts[index] ?? '', part));
  return inOrders && !path.split(sep).includes('..') ? resolve(home, path) : resolve(deps.cwd, path);
};

const changed = (source: string, again: string): CliResult<never> =>
  safetyRefusal(`cannot use ${source}: it changed while it was read`, `Check who changes the file. Then run "${commandText(again)}" again.`);

/**
 * The text of the assignment file, after every check of the list above. Nothing is written. A fault of the file system is exit 1.
 */
export const readAssignment = async (deps: Deps, request: AssignmentRequest): Promise<CliResult<string>> => {
  const { path, again } = request;
  const line = commandText(again);
  if (path === '') return usageError('the path of the assignment file is empty', `Name a file. Then run "${line}".`);
  const source = sourceOf(deps, request.home, path);
  const kind = await deps.fs.lstat(source);
  if (!kind.ok) return kind;
  if (kind.value === null) return usageError(`the assignment file ${source} does not exist`, `Check the path. Then run "${line}".`);
  if (kind.value === 'link') {
    return safetyRefusal(
      `cannot use ${source}: it is a link`,
      `Use the file that the link names, or copy it into ${assignmentSource.ordersShown} of the ${places.folder}. Then run "${line}" with that path.`,
    );
  }
  const real = await deps.fs.realpath(source);
  if (!real.ok) return real;
  // The place rule guards against a mistake of the caller. It checks the file by its path, and the caller can write the inbox folder
  // directly, so the rule is not a limit on what the caller can do.
  const place = await placeOf(deps, request, source, real.value);
  if (!place.ok) return place;

  const read = await readCheckedFile(deps, [], { path: real.value, what: 'the assignment file' }, assignmentSource.maxBytes);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return changed(source, again);
  if (read.value.state === 'invalid') {
    return read.value.cause === 'link'
      ? changed(source, again)
      : usageError(`cannot use ${source}: ${read.value.reason}`, `Name a plain text file of at most ${assignmentSource.maxBytes} bytes. Then run "${line}".`);
  }
  const { text } = read.value;
  if (text.includes(NUL) || text.includes(REPLACEMENT)) {
    return usageError(
      `cannot use ${source}: it is not plain UTF-8 text`,
      `Name a text file with no NUL byte and no byte that is not UTF-8. Then run "${line}".`,
    );
  }

  const after = await deps.fs.lstat(source);
  if (!after.ok) return after;
  if (after.value !== 'file') return changed(source, again);
  const afterReal = await deps.fs.realpath(source);
  if (!afterReal.ok) return afterReal;
  if (afterReal.value !== real.value) return changed(source, again);
  return ok(text);
};
