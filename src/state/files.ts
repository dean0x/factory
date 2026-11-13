import { err, ok, type Result } from '../core/result.js';
import { boardKeys, dirs, files, marker, shareListLabel } from '../names.js';

export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The board of a new factory: an empty queue under the key that the caller gives, no items and no tracks. */
export const initialBoardText = (queueKey: string): string =>
  jsonText({ [queueKey]: [], [boardKeys.items]: [], [boardKeys.tracks]: [] });

export const initialWaitingText = (): string => jsonText({ intro: '', groups: [], items: [] });

export const initialDecisionLogText = (): string => jsonText({ rows: [] });

/** The folders that every state repo has ignored from the start. */
const FIRST_IGNORED_DIRS: readonly string[] = [dirs.runtime, dirs.locks, dirs.backups];

/** The line that keeps the inbox of a node out of its state repo. */
export const INBOX_GITIGNORE_LINE = `${dirs.inbox}/`;

/** The line that keeps the report file of a node out of its state repo. */
export const OUTBOX_GITIGNORE_LINE = `${dirs.outbox}/`;

/**
 * The lines that a later version added to `STATE_GITIGNORE`: the registry of the workers, the inbox of the messages from a parent
 * node, and the outbox that holds the report file. A state repo from before lacks them, and `upgrade` adds each one that is
 * missing. A later version adds its line to this list.
 */
export const ADDED_GITIGNORE_LINES: readonly string[] = [`${dirs.workers}/`, INBOX_GITIGNORE_LINE, OUTBOX_GITIGNORE_LINE];

/** The runtime folders, the backups, the registry of the workers, the inbox and the outbox are not part of the state repository. */
export const STATE_GITIGNORE: string = [...FIRST_IGNORED_DIRS.map((dir) => `${dir}/`), ...ADDED_GITIGNORE_LINES]
  .map((line) => `${line}\n`)
  .join('');

const WILDCARD = /[*?[]/;

/** A line as git reads it: without the CR of a CRLF line end and without the spaces before it. A tab and any other blank stay. */
const gitLineOf = (candidate: string): string => {
  let end = candidate.endsWith('\r') ? candidate.length - 1 : candidate.length;
  while (end > 0 && candidate[end - 1] === ' ') end -= 1;
  return candidate.slice(0, end);
};

/**
 * True when git ignores the path of `line` by this text: the last line that is `line`, or a negation that can match its name,
 * decides. A comment, a longer name and the name inside another line do not count. As in git, the CR of a CRLF line end and the
 * spaces before it are not part of a line, but a tab or any other blank is.
 *
 * The check is not a full matcher and it fails closed. A line that starts with `!` and holds the name, or a wildcard, may take
 * the path back into the repo, so it counts as a negation. A `!` line that is for another name does not.
 */
export const ignoresLine = (text: string, line: string): boolean => {
  const name = line.endsWith('/') ? line.slice(0, -1) : line;
  let ignored = false;
  for (const candidate of text.split('\n')) {
    const trimmed = gitLineOf(candidate);
    if (trimmed === line) ignored = true;
    else if (trimmed.startsWith('!') && (trimmed.includes(name) || WILDCARD.test(trimmed))) ignored = false;
  }
  return ignored;
};

/** The text of the state `.gitignore` and the lines that were added to it. */
export interface StateGitignoreText {
  readonly text: string;
  /** The lines of `ADDED_GITIGNORE_LINES` that the text did not hold. Empty for a new file and for a current file. */
  readonly added: readonly string[];
}

/**
 * The text of the state `.gitignore` with each line of `ADDED_GITIGNORE_LINES` that is missing. A missing file gets the lines
 * of a new state repo. A file that has every line stays as it is. Else the lines go to the end, after a line break when the
 * last line has none, so the old text is the start of the new text and every old line stays as it is.
 */
export const withAddedLines = (existing: string | null): StateGitignoreText => {
  if (existing === null) return { text: STATE_GITIGNORE, added: [] };
  const added = ADDED_GITIGNORE_LINES.filter((line) => !ignoresLine(existing, line));
  if (added.length === 0) return { text: existing, added };
  const lineEnd = existing === '' || existing.endsWith('\n') ? '' : '\n';
  return { text: `${existing}${lineEnd}${added.map((line) => `${line}\n`).join('')}`, added };
};

const markerLine = (kind: string): string => `# ${marker.prefix}${kind} ${shareListLabel}`;

export const SHARE_LIST_BEGIN: string = markerLine(marker.begin);
export const SHARE_LIST_END: string = markerLine(marker.end);

/** The paths at the top of the root that the root repo tracks. The share list ignores every other path. */
const SHARED_ROOT_PATHS: readonly { readonly path: string; readonly folder: boolean }[] = [
  { path: files.gitignore, folder: false },
  { path: files.config, folder: false },
  { path: dirs.setup, folder: true },
];

export const sharedRootPaths: readonly string[] = SHARED_ROOT_PATHS.map((shared) => shared.path);

const IGNORE_ALL = '/*';

/** The lines of the share list: the first marker line, an allow list, and the second marker line. */
const SHARE_LIST_LINES: readonly string[] = [
  SHARE_LIST_BEGIN,
  IGNORE_ALL,
  ...SHARED_ROOT_PATHS.map((shared) => `!/${shared.path}${shared.folder ? '/' : ''}`),
  SHARE_LIST_END,
];

/** The part of the root `.gitignore` that the tool writes. Everything is ignored, except the shared paths. */
export const SHARE_LIST_PART: string = `${SHARE_LIST_LINES.join('\n')}\n`;

/** Where the part is in the text of a `.gitignore`: the first and the last line of the part, from 0. */
export type ShareListAt =
  | { readonly kind: 'absent' }
  /** One marker line with no pair, two parts, or the second marker line before the first. */
  | { readonly kind: 'broken' }
  | { readonly kind: 'found'; readonly first: number; readonly last: number; readonly current: boolean };

const indexesOf = (lines: readonly string[], line: string): readonly number[] =>
  lines.flatMap((candidate, index) => (candidate === line ? [index] : []));

export const locateShareList = (text: string): ShareListAt => {
  const lines = text.split('\n');
  const begins = indexesOf(lines, SHARE_LIST_BEGIN);
  const ends = indexesOf(lines, SHARE_LIST_END);
  if (begins.length === 0 && ends.length === 0) return { kind: 'absent' };
  const [first] = begins;
  const [last] = ends;
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined || last < first) {
    return { kind: 'broken' };
  }
  const current = lines.slice(first, last + 1).join('\n') === SHARE_LIST_LINES.join('\n');
  return { kind: 'found', first, last, current };
};

/**
 * The text of the root `.gitignore` with the current share list. The part goes first, so the lines of a person that
 * follow it can allow more paths. A part that is there is replaced in its place, and every other line stays as it is.
 * A marker line with no pair is an error: the tool can not tell where the part ends.
 */
export const withShareList = (existing: string | null): Result<string, string> => {
  if (existing === null || existing.trim() === '') return ok(SHARE_LIST_PART);
  const at = locateShareList(existing);
  switch (at.kind) {
    case 'absent':
      return ok(`${SHARE_LIST_PART}\n${existing}`);
    case 'broken':
      return err(`${files.gitignore} holds a marker line of the ${shareListLabel} that has no pair`);
    case 'found': {
      const lines = existing.split('\n');
      return ok([...lines.slice(0, at.first), ...SHARE_LIST_LINES, ...lines.slice(at.last + 1)].join('\n'));
    }
    default: {
      const unreachable: never = at;
      return unreachable;
    }
  }
};
