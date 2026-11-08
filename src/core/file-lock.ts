import type { Deps, PathInfo } from './deps.js';
import { err, ok, type Result } from './result.js';

/**
 * The lock file. A process holds the lock while the lock file exists. The file is made with a name that must not exist, so
 * only one process makes it, and a link at that path is never followed. This module is the only owner of the take, of
 * the take-over of a stale lock, and of the removal of the lock file. A caller sets the bounds with a policy and frees the lock when
 * it has finished. The lock file holds the token of the process that made it, so a free step removes only the lock file that its own
 * take made: a holder that ran past the stale age and lost its lock does not remove the lock file of the process that took it over.
 */

/** The bytes of random text in a token. The token also holds the pid, which a person reads in the lock file. */
const TOKEN_BYTES = 8;

/** The most bytes of a lock file that a free step reads: a token and a line break fit, and a larger file is not a lock file of this module. */
const MAX_LOCK_BYTES = 256;

const lockText = (token: string): string => `${token}\n`;

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

/**
 * The end of a take: the lock is taken (with the token that the lock file holds and that `freeLock` needs), the lock stayed with
 * another process for all tries, or the lock path is a link.
 */
export type LockTake =
  | { readonly kind: 'taken'; readonly token: string }
  | { readonly kind: 'held' }
  | { readonly kind: 'link' };

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
 * the wait has a fixed bound. A stale lock is taken over, and the new lock file holds the token of this call. A lock path that
 * is a link ends the call at once with `link`, and the link is not followed. When the lock is taken, the caller must free it with
 * the token. The error is the reason that a call of the file system failed, or that there is no random text for the token: the
 * call takes no lock without a token.
 */
export const takeLock = async (deps: Deps, lockPath: string, policy: LockPolicy): Promise<Result<LockTake, string>> => {
  const random = deps.randomHex(TOKEN_BYTES);
  if (!random.ok) return err(random.error.message);
  const token = `${deps.pid}-${random.value}`;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const created = await deps.fs.writeTextExclusive(lockPath, lockText(token), policy.mode);
    if (!created.ok) return err(created.error.message);
    if (created.value) return ok({ kind: 'taken', token });
    const kind = await deps.fs.lstat(lockPath);
    if (!kind.ok) return err(kind.error.message);
    if (kind.value === 'link') return ok({ kind: 'link' });
    const dropped = await dropStaleLock(deps, lockPath, policy);
    if (!dropped.ok) return dropped;
    if (!dropped.value && attempt < policy.attempts) await deps.sleep(policy.waitMs);
  }
  return ok({ kind: 'held' });
};

/**
 * Free the lock that a take made with `token`: remove the lock file only when it holds that token. A lock file with another
 * text belongs to another process now (this lock went stale and that process took it over), so it stays, and that is no error. A
 * lock file that is gone, and a lock path that is not a plain file, need nothing. The error is the reason that the file system could
 * not read or remove the lock file of the caller. A caller that has finished its work treats this step as best effort.
 */
export const freeLock = async (deps: Deps, lockPath: string, token: string): Promise<Result<void, string>> => {
  const kind = await deps.fs.lstat(lockPath);
  if (!kind.ok) return err(kind.error.message);
  if (kind.value !== 'file') return ok(undefined);
  const held = await deps.fs.readTextLimited(lockPath, MAX_LOCK_BYTES);
  if (!held.ok) {
    // The file can go between the two calls: a lock file that is gone needs nothing.
    const left = await deps.fs.lstat(lockPath);
    return left.ok && left.value === null ? ok(undefined) : err(held.error.message);
  }
  if (held.value !== lockText(token)) return ok(undefined);
  const removed = await deps.fs.remove(lockPath);
  return removed.ok ? ok(undefined) : err(removed.error.message);
};
