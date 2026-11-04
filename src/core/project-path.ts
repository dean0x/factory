import { places, reservedRootNames } from '../names.js';

/** Why a value is not a project path: it is not one folder name, it starts with a dot, or the root keeps the name. */
export type ProjectPathIssue = 'not-one-name' | 'leading-dot' | 'reserved';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * The key of a folder name: two names with one key are one folder. The letter case is gone, and so is the
 * difference between a letter and its compatible forms (a long s is an s), because a file system that ignores the
 * case of letters treats such names as one folder.
 */
export const projectFolderKey = (name: string): string => name.normalize('NFKC').toLowerCase();

const RESERVED = new Set(reservedRootNames.map(projectFolderKey));

/**
 * Check a project path. A project path is one folder name inside the root: no slash, no backslash, no control
 * character, no leading dot (so not `.` or `..`, and not `.git` or `.factory`), and not a reserved root name in any
 * letter case. The result is null when the path is good.
 */
export const projectPathIssue = (path: string): ProjectPathIssue | null => {
  if (path === '' || path.includes('/') || path.includes('\\') || CONTROL_CHARACTER.test(path)) return 'not-one-name';
  if (path.startsWith('.')) return 'leading-dot';
  return RESERVED.has(projectFolderKey(path)) ? 'reserved' : null;
};

const reasons: Readonly<Record<ProjectPathIssue, string>> = {
  'not-one-name': `must be one folder name inside the ${places.folder}, with no slash`,
  'leading-dot': 'must not start with a dot',
  reserved: `is a name that the ${places.folder} keeps for itself`,
};

/** The reason, as a phrase that follows the name of the key or of the folder. */
export const describeProjectPathIssue = (issue: ProjectPathIssue): string => reasons[issue];
