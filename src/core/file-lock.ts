import type { Deps, PathInfo } from './deps.js';
import { err, ok, type Result } from './result.js';

/**
 * The lock file. A process holds the lock while the lock file exists. The file is made with a name that must not exist, so
 * only one process makes it, and a link at that path is never followed. This module is the only owner of the take and of
 * the take-over of a stale lock. A caller sets the bounds with a policy and removes the lock file when it has finished.
 */

/** The bounds of one lock. */
export interface LockPolicy {
  /** The call tries this many times, and waits `waitMs` between two tries. */
  readonly attempts: number;
  readonly waitMs: number;
  /** A lock that is older than this was left by a process that ended. The next waiter takes it over. */
  readonly staleMs: number;
  /** The claim file beside the lock file. Only the process that holds it removes a stale lock. */
  readonly takeoverSuffix: string;
  /** The permission bits of the lock file and of the claim file. */
  readonly mode: number;
}

/** The end of a take: the lock is taken, the lock stayed with another process for all tries, or the lock path is a link. */
export type LockTake = 'taken' | 'held' | 'link';

/** True when a lock or a claim file is older than the stale age: a process that ended left it. */
const isStale = (deps: Deps, info: PathInfo, policy: LockPolicy): boolean => deps.now().getTime() - info.mtimeMs > policy.staleMs;

/**
 * Remove the lock only when it is still the stale lock that the caller saw. The caller holds the claim file, so no other
 * waiter removes the lock now. A lock that a waiter took over in the meantime stays. The value is true when the lock is
 * gone.
 */
const removeSeenLock = async (deps: Deps, lockPath: string, seen: PathInfo): Promise<Result<boolean, string>> => {
  const current = await deps.fs.statInfo(lockPath);
  if (!current.ok) return err(current.error.message);
  if (current.value === null) return ok(true);
  if (current.value.mtimeMs !== seen.mtimeMs) return ok(false);
  const removed = await deps.fs.remove(lockPath);
  return removed.ok ? ok(true) : err(removed.error.message);
};

/**
 * Another waiter holds the claim file: the caller waits. A claim that is stale is removed, because the process that made
 * it ended. The value is always false: the caller tries again after the wait.
 */
const dropStaleClaim = async (deps: Deps, claimPath: string, policy: LockPolicy): Promise<Result<boolean, string>> => {
  const claim = await deps.fs.statInfo(claimPath);
  if (!claim.ok) return err(claim.error.message);
  if (claim.value === null || !isStale(deps, claim.value, policy)) return ok(false);
  const removed = await deps.fs.remove(claimPath);
  return removed.ok ? ok(false) : err(removed.error.message);
};

/**
 * Remove a lock that is older than the stale age: a process that ended left it. Only the waiter that holds the claim file
 * beside the lock removes it, and only the stale lock that it saw, so a second waiter never removes the new lock of the
 * first. The value is true when the lock is gone and the caller may try to take it at once.
 */
const dropStaleLock = async (deps: Deps, lockPath: string, policy: LockPolicy): Promise<Result<boolean, string>> => {
  const seen = await deps.fs.statInfo(lockPath);
  if (!seen.ok) return err(seen.error.message);
  if (seen.value === null) return ok(true);
  if (!isStale(deps, seen.value, policy)) return ok(false);

  const claimPath = `${lockPath}${policy.takeoverSuffix}`;
  const claimed = await deps.fs.writeTextExclusive(claimPath, `${deps.pid}\n`, policy.mode);
  if (!claimed.ok) return err(claimed.error.message);
  if (!claimed.value) return dropStaleClaim(deps, claimPath, policy);

  const dropped = await removeSeenLock(deps, lockPath, seen.value);
  const claimGone = await deps.fs.remove(claimPath);
  if (!dropped.ok) return dropped;
  return claimGone.ok ? dropped : err(claimGone.error.message);
};

/**
 * Take the lock file at the path. The call tries `policy.attempts` times and waits `policy.waitMs` between two tries, so
 * the wait has a fixed bound. A stale lock is taken over. A lock path that is a link ends the call at once with `link`, and
 * the link is not followed. When the lock is taken, the caller must remove the lock file. The error is the reason that a
 * call of the file system failed.
 */
export const takeLock = async (deps: Deps, lockPath: string, policy: LockPolicy): Promise<Result<LockTake, string>> => {
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const created = await deps.fs.writeTextExclusive(lockPath, `${deps.pid}\n`, policy.mode);
    if (!created.ok) return err(created.error.message);
    if (created.value) return ok('taken');
    const kind = await deps.fs.lstat(lockPath);
    if (!kind.ok) return err(kind.error.message);
    if (kind.value === 'link') return ok('link');
    const dropped = await dropStaleLock(deps, lockPath, policy);
    if (!dropped.ok) return dropped;
    if (!dropped.value && attempt < policy.attempts) await deps.sleep(policy.waitMs);
  }
  return ok('held');
};
