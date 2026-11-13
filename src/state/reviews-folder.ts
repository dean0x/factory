import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { accessFaultOf } from '../core/access.js';
import type { Deps } from '../core/deps.js';
import { LINK_REMEDY } from '../core/safe-write.js';
import { commands, commandText, privateFile } from '../names.js';
import { layoutOf } from './layout.js';

/**
 * Makes the folder of the review results of a node ready: it is made when it is missing, and it gets mode 0700 whether it is new or
 * not. The folder stays when a worker is freed, because the free deletes the inbox of the worker. A link, a folder that another
 * user owns and a folder that a group or other users can write are a security stop (exit 4), as for the inbox of a node. A path
 * that is no folder is a failure. The state folder is there already: only the last part is made.
 */
export const ensureReviewsFolder = async (deps: Deps, home: string): Promise<CliResult<void>> => {
  const folder = layoutOf(home).reviewsDir;
  const found = await deps.fs.lstat(folder);
  if (!found.ok) return found;
  if (found.value === 'link') return safetyRefusal(`cannot use ${folder}: it is a link`, LINK_REMEDY);
  if (found.value !== null && found.value !== 'dir') return failure(`cannot use ${folder}: it is not a folder`);
  if (found.value === null) {
    const made = await deps.fs.mkdirOne(folder, privateFile.folderMode);
    if (!made.ok) return made;
  }
  const info = await deps.fs.statInfo(folder);
  if (!info.ok) return info;
  if (info.value === null) return failure(`cannot use ${folder}: the folder is gone`);
  const fault = accessFaultOf(deps, info.value);
  if (fault !== null) {
    return safetyRefusal(
      `cannot use ${folder}: ${fault === 'otherOwner' ? 'it belongs to another user' : 'a group or other users can write it'}`,
      `Check who holds the folder and its mode, or remove it. Then run "${commandText(commands.start)}" again.`,
    );
  }
  return deps.fs.chmod(folder, privateFile.folderMode);
};
