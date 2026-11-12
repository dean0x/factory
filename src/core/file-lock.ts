import { lockStaleWarning } from '../names.js';
import type { Deps, PathInfo } from './deps.js';
import { processStartOf } from './process-start.js';
import { err, ok, type Result } from './result.js';

/**
 * The lock file. A process holds the lock while the lock file exists. The file is made with a name that must not exist, so
 * only one process makes it, and a link at that path is never followed. This module is the only owner of the take, of
 * the take-over of a stale lock, and of the removal of the lock file. A caller sets the bounds with a policy and frees the lock when
 * it has finished. The lock file holds the token of the process that made it, so a free step removes only the lock file that its own
 * take made: a holder that ran past the stale age and lost its lock does not remove the lock file of the process that took it over.
 *
 * A policy has one of two rules for a stale lock. With no `liveness` option, a lock is stale when it is older than `staleMs`. With
 * the option, the age of a lock never makes it stale while its holder runs: the token holds the pid and the start time of the
 * holder, and a lock is stale only when that pid does not run, or runs with another start time.
 */

/** The bytes of random text in a token. The token also holds the pid, which a person reads in the lock file. */
const TOKEN_BYTES = 8;

/** The most bytes of a lock file that a free step reads: a token and a line break fit, and a larger file is not a lock file of this module. */
const MAX_LOCK_BYTES = 256;

/** The most digits of the start time in a token. The own start has fewer digits than this, so the own token always parses. */
const MAX_START_DIGITS = 15;

/** The token of a lock with liveness, as the lock file holds it: the pid, the start time in milliseconds, and the random text. */
const LIVE_TOKEN_TEXT = new RegExp(`^([0-9]{1,10})-([0-9]{1,${MAX_START_DIGITS}})-[0-9a-f]{${TOKEN_BYTES * 2}}\\n$`);

const lockText = (token: string): string => `${token}\n`;

/** The liveness rule of a lock: the holder is ended when its pid does not run, or runs with a start time that differs by more than this. */
export interface LockLiveness {
  readonly startToleranceMs: number;
}

/** The bounds of one lock. */
export interface LockPolicy {
  /** The call tries this many times, and waits `waitMs` between two tries. */
  readonly attempts: number;
  readonly waitMs: number;
  /**
   * A claim file that is older than this was left by a process that ended. With no `liveness`, a lock that is older than this was
   * left by a process that ended, and the next waiter takes it over. With `liveness`, only a lock file that holds no valid token is
   * judged by this age.
   */
  readonly staleMs: number;
  /** The claim file beside the lock file. Only the process that holds it removes a stale lock. */
  readonly takeoverSuffix: string;
  /** The permission bits of the lock file and of the claim file. */
  readonly mode: number;
  /** When set, a lock is stale by the state of its holder and never by its age. The caller of `takeLock` then gives a `LivenessInput`. */
  readonly liveness?: LockLiveness;
}

/** What a take with `liveness` needs from its caller. */
export interface LivenessInput {
  /** The start of the process of the caller (see `processStartOf`), read once before the wait. It goes into the token. */
  readonly ownStartMs: number;
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
 * The text of the lock file, read through one path for the free step, the check of the holder and the check of the liveness: the
 * kind is read first and a link is never followed, then at most `MAX_LOCK_BYTES` bytes. The value is null when the lock path is gone or is
 * not a plain file. The error is the reason that the file system could not read the lock file.
 */
const readLockText = async (deps: Deps, lockPath: string): Promise<Result<string | null, string>> => {
  const kind = await deps.fs.lstat(lockPath);
  if (!kind.ok) return err(kind.error.message);
  if (kind.value !== 'file') return ok(null);
  const held = await deps.fs.readTextLimited(lockPath, MAX_LOCK_BYTES);
  if (held.ok) return ok(held.value);
  // The file can go between the two calls: a lock file that is gone has no text.
  const left = await deps.fs.lstat(lockPath);
  return left.ok && left.value === null ? ok(null) : err(held.error.message);
};

interface Holder {
  /** The token as the lock file holds it, with no line break. */
  readonly token: string;
  readonly pid: number;
  readonly startMs: number;
}

/** The holder that a lock file names, or null for text that is no token with a pid and a start time. */
const holderOf = (text: string): Holder | null => {
  const match = LIVE_TOKEN_TEXT.exec(text);
  if (match === null) return null;
  const [, pidText = '', startText = ''] = match;
  const [pid, startMs] = [Number(pidText), Number(startText)];
  return pid > 0 && Number.isSafeInteger(pid) && Number.isSafeInteger(startMs) ? { token: text.slice(0, -1), pid, startMs } : null;
};

/**
 * True only when the holder has ended: its pid does not run, or runs with a start time that differs from the recorded one by more than
 * the tolerance. An error from the running check and a failed read of the start are no proof that the holder ended, so they count as a
 * live holder. The start is read again on each call: a holder can end and its pid can go to another process between two tries, and
 * a start that an earlier try read would then match the recorded one. The pid of this process is never asked: the process runs, and
 * its start is the own start that the caller gave.
 */
const holderEnded = async (deps: Deps, holder: Holder, liveness: LockLiveness, input: LivenessInput): Promise<boolean> => {
  const differs = (observedMs: number): boolean => Math.abs(observedMs - holder.startMs) > liveness.startToleranceMs;
  if (holder.pid === deps.pid) return differs(input.ownStartMs);
  const running = deps.isRunning(holder.pid);
  if (!running.ok) return false;
  if (!running.value) return true;
  const observed = await processStartOf(deps, holder.pid);
  return observed.ok && differs(observed.value);
};

/** What the text of a lock file says about its holder: it runs (`live`), it ended (`ended`), or the text is no token with a pid and a start time (`invalid`). */
export type HolderState = 'live' | 'ended' | 'invalid';

/**
 * The state of the holder that the text of a lock file names, by the same rule as a take. A caller that only reads a file, such as the
 * check of a priority mark, uses it: the call takes no lock, removes nothing and signals no process.
 */
export const holderStateOf = async (deps: Deps, text: string, liveness: LockLiveness, input: LivenessInput): Promise<HolderState> => {
  const holder = holderOf(text);
  if (holder === null) return 'invalid';
  return (await holderEnded(deps, holder, liveness, input)) ? 'ended' : 'live';
};

/**
 * What the judge says of a lock that exists. A lock that is stale by the state of its holder also gives the text of the lock file that
 * the judge read, so the removal can check that the file still holds it. The text is null for a lock that the age rule judged.
 */
type Verdict = { readonly ended: false } | { readonly ended: true; readonly tokenText: string | null };

const STILL_HELD: Verdict = { ended: false };

/** The judge of a lock that exists: it gets the stat of the lock file, taken before the text is read, and says whether the lock is stale. */
type LockEnded = (seen: PathInfo) => Promise<Result<Verdict, string>>;

/** The liveness rule of a take: the option of the policy, and what the caller gave for it. */
interface LivenessRule {
  readonly liveness: LockLiveness;
  readonly input: LivenessInput;
}

/** The own start must be a whole number of milliseconds since the epoch with at most `MAX_START_DIGITS` digits, so the own token parses. */
const isOwnStart = (startMs: number): boolean => Number.isSafeInteger(startMs) && startMs >= 0 && String(startMs).length <= MAX_START_DIGITS;

/**
 * The liveness rule for a take, or null for a policy with no `liveness`. A policy with `liveness` needs a valid input: with none,
 * the result is an error, so no take falls back to the age rule.
 */
const livenessRuleOf = (policy: LockPolicy, input: LivenessInput | undefined): Result<LivenessRule | null, string> => {
  if (policy.liveness === undefined) return ok(null);
  if (input === undefined || !isOwnStart(input.ownStartMs)) {
    return err('cannot take the lock with liveness: the start time of this process is not a valid time');
  }
  return ok({ liveness: policy.liveness, input });
};

/**
 * The rule of the policy for one take. With no liveness rule, the age rule. With it, the holder of the token in the lock file decides. A
 * lock file that holds no valid token (it is empty, too large, not a plain file, or has any other text) is judged by its age, and the
 * first one that is stale gives one warning. The text is not read for a file over the byte cap.
 */
const lockEndedOf = (deps: Deps, lockPath: string, policy: LockPolicy, rule: LivenessRule | null): LockEnded => {
  if (rule === null) return async (seen) => ok(isStale(deps, seen, policy) ? { ended: true, tokenText: null } : STILL_HELD);
  let warned = false;
  return async (seen) => {
    const text = seen.kind === 'file' && seen.size <= MAX_LOCK_BYTES ? await readLockText(deps, lockPath) : ok(null);
    if (!text.ok) return text;
    const holder = text.value === null ? null : holderOf(text.value);
    if (holder !== null) return ok((await holderEnded(deps, holder, rule.liveness, rule.input)) ? { ended: true, tokenText: text.value } : STILL_HELD);
    if (!isStale(deps, seen, policy)) return ok(STILL_HELD);
    if (!warned) deps.warn(lockStaleWarning(lockPath));
    warned = true;
    return ok({ ended: true, tokenText: null });
  };
};

/**
 * Remove the lock only when it is still the stale lock that the caller saw. The caller holds the claim file, so no other
 * waiter removes the lock now. A lock that a waiter took over in the meantime stays. The value is true when the lock is
 * gone. Only a file is removed: a folder at the lock path stays with all that it holds, and the result is an error.
 *
 * The time stamp of a file can have a resolution of 1 s or 2 s, so a new lock can carry the time stamp of the old one. When the
 * judge read a token (`tokenText`), the file must also still hold that text.
 */
const removeSeenLock = async (deps: Deps, lockPath: string, seen: PathInfo, tokenText: string | null): Promise<Result<boolean, string>> => {
  const current = await deps.fs.statInfo(lockPath);
  if (!current.ok) return err(current.error.message);
  if (current.value === null) return ok(true);
  if (current.value.mtimeMs !== seen.mtimeMs) return ok(false);
  if (tokenText !== null) {
    const text = await readLockText(deps, lockPath);
    if (!text.ok) return err(text.error);
    if (text.value !== tokenText) return ok(false);
  }
  const removed = await deps.fs.removeFile(lockPath);
  return removed.ok ? ok(true) : err(removed.error.message);
};

/**
 * Another waiter holds the claim file: the caller waits. A claim that is stale is removed, because the process that made
 * it ended. Only a file is removed: a folder at the claim path stays, and the result is an error. The value is always false:
 * the caller tries again after the wait.
 */
const dropStaleClaim = async (deps: Deps, claimPath: string, policy: LockPolicy): Promise<Result<boolean, string>> => {
  const claim = await deps.fs.statInfo(claimPath);
  if (!claim.ok) return err(claim.error.message);
  if (claim.value === null || !isStale(deps, claim.value, policy)) return ok(false);
  const removed = await deps.fs.removeFile(claimPath);
  return removed.ok ? ok(false) : err(removed.error.message);
};

/**
 * Remove a stale lock: a process that ended left it (see `lockEndedOf` for the rule). Only the waiter that holds the claim file
 * beside the lock removes it, and only the stale lock that it saw, so a second waiter never removes the new lock of the
 * first. The value is true when the lock is gone and the caller may try to take it at once.
 */
const dropStaleLock = async (deps: Deps, lockPath: string, policy: LockPolicy, lockEnded: LockEnded): Promise<Result<boolean, string>> => {
  const seen = await deps.fs.statInfo(lockPath);
  if (!seen.ok) return err(seen.error.message);
  if (seen.value === null) return ok(true);
  const ended = await lockEnded(seen.value);
  if (!ended.ok) return err(ended.error);
  if (!ended.value.ended) return ok(false);

  const claimPath = `${lockPath}${policy.takeoverSuffix}`;
  const claimed = await deps.fs.writeTextExclusive(claimPath, `${deps.pid}\n`, policy.mode);
  if (!claimed.ok) return err(claimed.error.message);
  if (!claimed.value) return dropStaleClaim(deps, claimPath, policy);

  const dropped = await removeSeenLock(deps, lockPath, seen.value, ended.value.tokenText);
  const claimGone = await deps.fs.removeFile(claimPath);
  if (!dropped.ok) return dropped;
  return claimGone.ok ? dropped : err(claimGone.error.message);
};

/**
 * Take the lock file at the path. The call tries `policy.attempts` times and waits `policy.waitMs` between two tries, so
 * the wait has a fixed bound. A stale lock is taken over in the same try that removes it, and the new lock file holds the token of
 * this call. A lock path that
 * is a link ends the call at once with `link`, and the link is not followed. When the lock is taken, the caller must free it with
 * the token. The error is the reason that a call of the file system failed, or that there is no random text for the token: the
 * call takes no lock without a token. The call removes only files: a folder at the lock path stays, and when it is stale, the
 * call ends with an error and takes no lock.
 *
 * With `policy.liveness`, the caller gives `liveness`: its own start time, which goes into the token as `<pid>-<startMs>-<random>`.
 * The start of a holder is read again on each try. A policy with `liveness` and no valid input is an error, and no lock is taken.
 */
export const takeLock = async (
  deps: Deps,
  lockPath: string,
  policy: LockPolicy,
  liveness?: LivenessInput,
): Promise<Result<LockTake, string>> => {
  const rule = livenessRuleOf(policy, liveness);
  if (!rule.ok) return rule;
  const random = deps.randomHex(TOKEN_BYTES);
  if (!random.ok) return err(random.error.message);
  const token = (rule.value === null ? [deps.pid, random.value] : [deps.pid, rule.value.input.ownStartMs, random.value]).join('-');
  const lockEnded = lockEndedOf(deps, lockPath, policy, rule.value);
  const create = () => deps.fs.writeTextExclusive(lockPath, lockText(token), policy.mode);
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    const created = await create();
    if (!created.ok) return err(created.error.message);
    if (created.value) return ok({ kind: 'taken', token });
    const kind = await deps.fs.lstat(lockPath);
    if (!kind.ok) return err(kind.error.message);
    if (kind.value === 'link') return ok({ kind: 'link' });
    const dropped = await dropStaleLock(deps, lockPath, policy, lockEnded);
    if (!dropped.ok) return dropped;
    if (dropped.value) {
      // The lock is gone: make it in this try, so a stale lock does not cost a wait. One more create, never a loop.
      const again = await create();
      if (!again.ok) return err(again.error.message);
      if (again.value) return ok({ kind: 'taken', token });
    } else if (attempt < policy.attempts) {
      await deps.sleep(policy.waitMs);
    }
  }
  return ok({ kind: 'held' });
};

/**
 * True when the lock file holds `token`, so the take that made the token still has the lock. A lock file with another text
 * belongs to another process now (this lock went stale and that process took it over). A lock file that is gone, and a lock
 * path that is not a plain file, are not held, and a link is not followed. The error is the reason that the file system could
 * not read the lock file. This is the one compare of the token: `freeLock` and a check before a write both call it.
 */
export const holdsLock = async (deps: Deps, lockPath: string, token: string): Promise<Result<boolean, string>> => {
  const held = await readLockText(deps, lockPath);
  return held.ok ? ok(held.value === lockText(token)) : held;
};

/**
 * Free the lock that a take made with `token`: remove the lock file only when it holds that token (see `holdsLock`). A lock file
 * with another text stays, and that is no error. A lock file that is gone, and a lock path that is not a plain file, need nothing.
 * The error is the reason that the file system could not read or remove the lock file of the caller. A caller that has finished
 * its work treats this step as best effort.
 */
export const freeLock = async (deps: Deps, lockPath: string, token: string): Promise<Result<void, string>> => {
  const held = await holdsLock(deps, lockPath, token);
  if (!held.ok) return held;
  if (!held.value) return ok(undefined);
  const removed = await deps.fs.removeFile(lockPath);
  return removed.ok ? ok(undefined) : err(removed.error.message);
};
