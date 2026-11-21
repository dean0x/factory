import { localFileModes } from '../names.js';
import type { CheckedFault, CheckedOpenRequest, Deps, PathInfo } from './deps.js';

/** What is wrong with a path for a reader that trusts it: another account owns it, or a group or other users can write it. */
export type AccessFault = 'otherOwner' | 'writableByOthers';

/**
 * The first fault in the owner and the mode of a path, or null. The owner must be `uid`: a platform with no user ids (`uid` is null)
 * has no owner check. The mode check holds on every platform.
 */
export const accessFaultCore = (uid: number | null, info: PathInfo): AccessFault | null => {
  if (uid !== null && info.uid !== uid) return 'otherOwner';
  if ((info.mode & localFileModes.groupOtherWrite) !== 0) return 'writableByOthers';
  return null;
};

/** The row caller for the owner and mode checks. */
export const accessFaultFor = (uid: number | null, info: PathInfo): AccessFault | null => accessFaultCore(uid, info);

/** The first fault in the owner and the mode of a path, or null. The owner must be the user of this process. */
export const accessFaultOf = (deps: Deps, info: PathInfo): AccessFault | null => accessFaultFor(deps.uid, info);

/**
 * The first fault of an open file: kind, owner and mode for a private read, then size. The facts come from the open handle.
 */
export const checkedFaultCore = (request: CheckedOpenRequest, info: PathInfo): CheckedFault | null => {
  if (info.kind !== 'file') return 'wrong-kind';
  if (request.access !== 'content') {
    const access = accessFaultCore(request.uid, info);
    if (access !== null) return access;
  }
  return request.maxBytes !== null && info.size > request.maxBytes ? 'size' : null;
};

/** The row caller uses the same checks as the always-on core. */
export const checkedFaultOf = (request: CheckedOpenRequest, info: PathInfo): CheckedFault | null =>
  checkedFaultCore(request, info);
