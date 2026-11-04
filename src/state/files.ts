import { err, ok, type Result } from '../core/result.js';
import { dirs, files, marker, shareListLabel } from '../names.js';

export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const initialBoardText = (): string => jsonText({ queue: [], items: [] });

export const initialWaitingText = (): string => jsonText({ intro: '', groups: [], items: [] });

export const initialDecisionLogText = (): string => jsonText({ rows: [] });

/** The runtime folders, the backups and the registry of the workers are not part of the state repository. */
export const STATE_GITIGNORE: string = [dirs.runtime, dirs.locks, dirs.backups, dirs.workers].map((dir) => `${dir}/\n`).join('');

/** The line of `STATE_GITIGNORE` that a state repo from before the registry of the workers lacks. */
export const WORKERS_GITIGNORE_LINE = `${dirs.workers}/`;

const hasWorkersLine = (text: string): boolean => text.split('\n').some((line) => line.trimEnd() === WORKERS_GITIGNORE_LINE);

/**
 * The text of the state `.gitignore` with the line for the workers folder. A missing file gets the lines of a new state
 * repo. A file that has the line stays as it is. Else the line goes to the end, after a line break when the last line has
 * none, so the old text is the start of the new text and every old line stays as it is.
 */
export const withWorkersLine = (existing: string | null): string => {
  if (existing === null) return STATE_GITIGNORE;
  if (hasWorkersLine(existing)) return existing;
  const lineEnd = existing === '' || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${lineEnd}${WORKERS_GITIGNORE_LINE}\n`;
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
