import { localFileModes } from '../names.js';
import type { CheckedFault, Deps, PathInfo } from './deps.js';

/** What is wrong with a path for a reader that trusts it: another account owns it, or a group or other users can write it. */
export type AccessFault = 'otherOwner' | 'writableByOthers';

/**
 * The first fault in the owner and the mode of a path, or null. The owner must be `uid`: a platform with no user ids (`uid` is null)
 * has no owner check. The mode check holds on every platform.
 */
export const accessFaultFor = (uid: number | null, info: PathInfo): AccessFault | null => {
  if (uid !== null && info.uid !== uid) return 'otherOwner';
  if ((info.mode & localFileModes.groupOtherWrite) !== 0) return 'writableByOthers';
  return null;
};

/** The first fault in the owner and the mode of a path, or null. The owner must be the user of this process. */
export const accessFaultOf = (deps: Deps, info: PathInfo): AccessFault | null => accessFaultFor(deps.uid, info);

/**
 * The first reason to refuse a file that was opened, or null: the kind, then the owner, then the mode, then the size. A `maxBytes` of
 * null has no size check. The facts are those of the open handle, so the answer holds for the bytes that are read from it.
 */
export const checkedFaultOf = (uid: number | null, info: PathInfo, maxBytes: number | null): CheckedFault | null => {
  if (info.kind !== 'file') return 'wrong-kind';
  const access = accessFaultFor(uid, info);
  if (access !== null) return access;
  return maxBytes !== null && info.size > maxBytes ? 'size' : null;
};
