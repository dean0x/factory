import { localFileModes } from '../names.js';
import type { Deps, PathInfo } from './deps.js';

/** What is wrong with a path for a reader that trusts it: another account owns it, or a group or other users can write it. */
export type AccessFault = 'otherOwner' | 'writableByOthers';

/**
 * The first fault in the owner and the mode of a path, or null. The owner must be the user of this process: a platform with no
 * user ids has no owner check. The mode check holds on every platform.
 */
export const accessFaultOf = (deps: Deps, info: PathInfo): AccessFault | null => {
  if (deps.uid !== null && info.uid !== deps.uid) return 'otherOwner';
  if ((info.mode & localFileModes.groupOtherWrite) !== 0) return 'writableByOthers';
  return null;
};
