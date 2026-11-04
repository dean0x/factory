import type { RecipeProject } from '../recipes/index.js';
import { checkProjectUrl } from '../core/clone-url.js';
import { commands, commandText, files, keys, program } from '../names.js';

/** The reason a project can not be shared, as the warning says it. */
export type UnsharedReason = 'no-url' | 'file-url' | 'local-path';

const reasonText: Readonly<Record<UnsharedReason, string>> = {
  'no-url': 'the project has no URL to share',
  'file-url': `its ${keys.project.url} is a file URL, which works on one machine only`,
  'local-path': `its ${keys.project.url} is a path of one machine`,
};

/**
 * Why the project can not be shared, or null when its URL is one that a host serves. A project with no URL is no
 * error: it works on this machine only.
 */
export const unsharedReasonOf = (project: RecipeProject): UnsharedReason | null => {
  if (project.url === undefined) return 'no-url';
  const checked = checkProjectUrl(project.url);
  if (!checked.ok || checked.value.kind === 'remote') return null;
  return checked.value.kind === 'file' ? 'file-url' : 'local-path';
};

/**
 * The warning for a project that the factory can not share. It names the project and the fix. `source` is the local
 * folder of the repo, when the local file names one.
 */
export const unsharedWarning = (id: string, reason: UnsharedReason, source?: string): string =>
  `The ${program} cannot be shared with the repo of the project ${id}, because ${reasonText[reason]}. ` +
  `Add an origin to the repo${source === undefined ? '' : ` (${source})`} and set ${keys.project.url} ` +
  `for the project in ${files.config}, then run "${commandText(commands.doctor)}".`;

/**
 * The warning for a work tree that init cloned into the root. The old folder stays as it is, and it keeps the work that
 * is not pushed. `fromOrigin` is true when the clone started from the origin of the old folder.
 */
export const oldFolderWarning = (folder: string, fromOrigin: boolean): string =>
  `The old folder ${folder} keeps the work that is not pushed. ` +
  (fromOrigin
    ? 'The clone holds only what the origin holds.'
    : 'The clone holds only the commits of the old folder, and the work that is not committed stays there.');

/** The warning for an origin that held credentials. It names neither the user nor the token. */
export const originCredentialsWarning = (id: string): string =>
  `The origin of the project ${id} holds credentials. ${program} wrote its URL without them. ` +
  'Git keeps them in the file .git/config of the repo. Use "gh auth login" or an SSH key instead.';
