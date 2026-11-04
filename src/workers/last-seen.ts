import { join } from 'node:path';
import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { isSlug, slug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { withFolderLock, writeInFolder } from '../core/safe-write.js';
import { describeIssues } from '../core/zod.js';
import { eventState, files, hookNames, lastSeen, privateFile, roles, schemaIds, type HookEvent } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import { listWorkerRecords, readWorkerFile } from './registry.js';

/**
 * The last-seen line of a session (design 4.6). The hook of Claude Code writes the last event and its time. The status
 * line writes the context percent and its time. Each write keeps the part that it does not set, so one file holds both.
 * The file is one JSON text in the heartbeat folder of the run-time folder, named by the session id. A worker has one more
 * file, a pointer in its own folder that holds the id of its newest session, so the line of a worker is found from the id
 * of the worker. This module is the only writer and the only reader of both files.
 *
 * The line also records its owner: the id that the session marker held when the line was made, which is the id of the node
 * for a coordinator session and the id of a worker for a worker session. A program in a worker pane can write the pointer of
 * its own worker, so a command that acts on a session of a worker (stop, resume) reads the line with `readOwnLastSeen`,
 * which accepts a session only when its line names this worker as the owner.
 */

const keys = lastSeen.keys;

const time = z.iso.datetime();

const lastSeenSchema = z
  .strictObject({
    [keys.schema]: z.literal(schemaIds.lastSeen),
    [keys.sessionId]: z.string().regex(lastSeen.sessionIdPattern, 'must be a UUID with lower case letters'),
    [keys.event]: z.enum(hookNames.events).nullable(),
    [keys.eventAt]: time.nullable(),
    [keys.contextPct]: z.number().min(lastSeen.minPercent).max(lastSeen.maxPercent).nullable(),
    [keys.pctAt]: time.nullable(),
    [keys.owner]: slug.optional(),
  })
  .superRefine((line, ctx) => {
    if ((line[keys.event] === null) !== (line[keys.eventAt] === null)) {
      ctx.addIssue({ code: 'custom', path: [keys.eventAt], message: 'must be set when the event is set, and only then' });
    }
    if ((line[keys.contextPct] === null) !== (line[keys.pctAt] === null)) {
      ctx.addIssue({ code: 'custom', path: [keys.pctAt], message: 'must be set when the percent is set, and only then' });
    }
  });

/** The last-seen line of one session. */
export type LastSeen = z.infer<typeof lastSeenSchema>;

/** What a read finds: a valid line, a file that is not valid and the reason, or no file. */
export type LastSeenRead =
  | { readonly state: 'valid'; readonly line: LastSeen }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'absent' };

/** What a write sets: the hook event with the time now, or the context percent (null for no percent) with the time now. */
export type LastSeenChange =
  | { readonly kind: 'event'; readonly event: HookEvent }
  | { readonly kind: 'percent'; readonly percent: number | null };

/**
 * The context percent of a status line input. A null, an absent or a non-numeric value means no percent (null). A number
 * outside 0-100 is a failure: the caller writes nothing.
 */
export const parsePercent = (value: unknown): CliResult<number | null> => {
  if (typeof value !== 'number' || Number.isNaN(value)) return ok(null);
  return value >= lastSeen.minPercent && value <= lastSeen.maxPercent
    ? ok(value)
    : failure(`the context percent ${value} is outside ${lastSeen.minPercent}-${lastSeen.maxPercent}`);
};

const isSessionId = (sessionId: string): boolean => lastSeen.sessionIdPattern.test(sessionId);

const invalid = (reason: string): CliResult<LastSeenRead> => ok({ state: 'invalid', reason });

/** The line of a file text, or the reason that the text is not a valid line of this session. */
const lineOf = (text: string, sessionId: string): CliResult<LastSeenRead> => {
  const json = parseJsonText(text);
  if (!json.ok) return invalid(json.error);
  const parsed = lastSeenSchema.safeParse(json.value);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  if (parsed.data[keys.sessionId] !== sessionId) return invalid('the session id differs from the file name');
  return ok({ state: 'valid', line: parsed.data });
};

/**
 * Read the last-seen line of a session. The read caps the bytes, refuses a folder or a file that is a link, and never
 * follows a link. A session id that is not a UUID is invalid, and no path is touched. The failure is a fault of the file
 * system only.
 */
export const readLastSeen = async (deps: Deps, home: string, sessionId: string): Promise<CliResult<LastSeenRead>> => {
  if (!isSessionId(sessionId)) return invalid('the session id is not a UUID');
  const folder = layoutOf(home).heartbeatDir;
  const file = join(folder, sessionId);
  const folderKind = await deps.fs.lstat(folder);
  if (!folderKind.ok) return folderKind;
  if (folderKind.value === null) return ok({ state: 'absent' });
  if (folderKind.value === 'link') return invalid('the folder is a link');
  if (folderKind.value !== 'dir') return invalid('the folder is not a folder');
  const fileKind = await deps.fs.lstat(file);
  if (!fileKind.ok) return fileKind;
  if (fileKind.value === null) return ok({ state: 'absent' });
  if (fileKind.value === 'link') return invalid('it is a link');
  if (fileKind.value !== 'file') return invalid('it is not a file');
  const info = await deps.fs.statInfo(file);
  if (!info.ok) return info;
  if (info.value === null) return ok({ state: 'absent' });
  if (info.value.size > lastSeen.maxBytes) return invalid(`larger than ${lastSeen.maxBytes} bytes`);
  const text = await deps.fs.readTextLimited(file, lastSeen.maxBytes);
  return text.ok ? lineOf(text.value, sessionId) : text;
};

const lineWith = (
  sessionId: string,
  event: HookEvent | null,
  eventAt: string | null,
  percent: number | null,
  percentAt: string | null,
  owner: string | undefined,
): LastSeen => ({
  [keys.schema]: schemaIds.lastSeen,
  [keys.sessionId]: sessionId,
  [keys.event]: event,
  [keys.eventAt]: eventAt,
  [keys.contextPct]: percent,
  [keys.pctAt]: percentAt,
  ...(owner === undefined ? {} : { [keys.owner]: owner }),
});

/**
 * The line after a change: the part that the change does not set is the stored part, or empty when there is none. A stored
 * line keeps its owner, or keeps having none: a write never gives an owner to a line that has none. A line that is new, or
 * that replaces a text that is not valid, gets the owner of the writer.
 */
const changedLine = (
  stored: LastSeen | null,
  sessionId: string,
  change: LastSeenChange,
  at: string,
  writer: string | undefined,
): LastSeen => {
  const owner = stored === null ? writer : stored[keys.owner];
  return change.kind === 'event'
    ? lineWith(sessionId, change.event, at, stored?.[keys.contextPct] ?? null, stored?.[keys.pctAt] ?? null, owner)
    : lineWith(
        sessionId,
        stored?.[keys.event] ?? null,
        stored?.[keys.eventAt] ?? null,
        change.percent,
        change.percent === null ? null : at,
        owner,
      );
};

/** The line after a change, or the reason that the change is refused. */
const nextLine = (
  stored: LastSeen | null,
  sessionId: string,
  change: LastSeenChange,
  at: Date,
  writer: string | undefined,
): CliResult<LastSeen> => {
  const checked = lastSeenSchema.safeParse(changedLine(stored, sessionId, change, at.toISOString(), writer));
  return checked.success ? ok(checked.data) : failure(`cannot record the last-seen line: ${describeIssues(checked.error)}`);
};

/**
 * Write the last-seen line of a session. A hook write keeps the stored percent and its time. A status line write keeps the
 * stored event and its time, and a null percent clears the stored percent. A stored file that is not valid is replaced.
 * The write is refused, and nothing changes, for a session id that is not a UUID, an event off the list and a percent
 * outside 0-100. A folder or a file that is a link is a security stop (exit 4) from the safe write.
 *
 * The hook and the status line wrapper write at the same moments, so a lock file beside the line (`hookNames.heartbeatLock`)
 * lets one writer read, merge and write at a time. The writer reads the line again and takes the time inside the lock, so a
 * write never puts back older data. A writer that does not get the lock within the wait bound writes nothing, and the value
 * is a failure (exit 1): that update is skipped, and the next event or refresh sets it again. A lock path that is a link is a
 * security stop (exit 4). The value is the line.
 *
 * `owner` is the id of the session marker of the writer (a slug). A new line records it. A stored line that names another owner
 * is never changed: the write is a failure, so a session of one owner can not rewrite the line of a session of another.
 */
export const writeLastSeen = async (
  deps: Deps,
  home: string,
  sessionId: string,
  change: LastSeenChange,
  owner?: string,
): Promise<CliResult<LastSeen>> => {
  if (!isSessionId(sessionId)) return failure('cannot record the last-seen line: the session id is not a UUID');
  const allowed = nextLine(null, sessionId, change, deps.now(), owner);
  if (!allowed.ok) return allowed;
  const layout = layoutOf(home);
  const target = {
    parent: layout.runtimeDir,
    folder: layout.heartbeatDir,
    name: sessionId,
    mode: privateFile.fileMode,
    folderMode: privateFile.folderMode,
  };
  return withFolderLock(deps, target, hookNames.heartbeatLock, async () => {
    const stored = await readLastSeen(deps, home, sessionId);
    if (!stored.ok) return stored;
    const storedLine = stored.value.state === 'valid' ? stored.value.line : null;
    const storedOwner = storedLine?.[keys.owner];
    if (owner !== undefined && storedOwner !== undefined && storedOwner !== owner) {
      return failure(`cannot record the last-seen line: the session belongs to ${storedOwner}, not to ${owner}`);
    }
    const next = nextLine(storedLine, sessionId, change, deps.now(), owner);
    if (!next.ok) return next;
    const written = await writeInFolder(deps, target, `${JSON.stringify(next.value)}\n`);
    return written.ok ? next : written;
  });
};

/**
 * Record the newest session of a worker: the pointer in the folder of the worker holds the session id and a new line. The
 * file is replaced as a whole, so a reader sees the old id or the new id. The write is refused, and nothing changes, for a
 * worker id that is not a slug and a session id that is not a UUID. A folder or a file that is a link is a security stop
 * (exit 4) from the safe write. The caller has checked that the worker has a record.
 */
export const writeWorkerSession = async (
  deps: Deps,
  home: string,
  workerId: string,
  sessionId: string,
): Promise<CliResult<void>> => {
  if (!isSlug(workerId)) return failure(`cannot record the session of the ${roles.worker}: the id is not a slug`);
  if (!isSessionId(sessionId)) return failure(`cannot record the session of the ${roles.worker}: the session id is not a UUID`);
  return writeInFolder(
    deps,
    {
      parent: layoutOf(home).workersDir,
      folder: workerPathsOf(home, workerId).dir,
      name: files.workerLastSession,
      mode: privateFile.fileMode,
      folderMode: privateFile.folderMode,
    },
    `${sessionId}\n`,
  );
};

/**
 * Read the last-seen line of a worker: the pointer of the worker names its newest session, and the line of that session is
 * the value. The pointer and the line are each checked as `readLastSeen` checks a line, and the session id in the line must
 * be the id in the pointer. A pointer that is not valid, or a line that is not valid, gives invalid with the reason. No
 * pointer, or a pointer to a session with no line, gives absent. A line is a hint and never proof of which session wrote it:
 * a caller treats absent and invalid as unknown. The failure is a fault of the file system only.
 */
export const readWorkerLastSeen = async (deps: Deps, home: string, workerId: string): Promise<CliResult<LastSeenRead>> => {
  const pointer = await readPointer(deps, home, workerId);
  if (!pointer.ok) return pointer;
  if (pointer.value.state !== 'session') return ok(pointer.value);
  return readLastSeen(deps, home, pointer.value.sessionId);
};

/** What the pointer of a worker holds: a session id, a file that is not valid and the reason, or no file. */
type PointerRead =
  | { readonly state: 'session'; readonly sessionId: string }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'absent' };

const readPointer = async (deps: Deps, home: string, workerId: string): Promise<CliResult<PointerRead>> => {
  const pointer = await readWorkerFile(deps, home, workerId, {
    of: 'lastSessionFile',
    what: 'the pointer',
    maxBytes: lastSeen.pointerMaxBytes,
  });
  if (!pointer.ok) return pointer;
  if (pointer.value.state !== 'text') return ok(pointer.value);
  const sessionId = pointer.value.text.endsWith('\n') ? pointer.value.text.slice(0, -1) : pointer.value.text;
  return isSessionId(sessionId)
    ? ok({ state: 'session', sessionId })
    : ok({ state: 'invalid', reason: 'the pointer does not hold a session id' });
};

/** What a command may use of the newest session of a worker: its line, or the reason that there is no line it may use. */
export type OwnSessionRead =
  | { readonly state: 'valid'; readonly line: LastSeen }
  | {
      readonly state: 'unknown';
      /** `no-line`: there is no valid line. `not-owned`: there is a line, and it does not belong to this worker. */
      readonly why: 'no-line' | 'not-owned';
      readonly reason: string;
    };

const unknown = (why: 'no-line' | 'not-owned', reason: string): CliResult<OwnSessionRead> => ok({ state: 'unknown', why, reason });

/** The id of another worker whose pointer names the session, or null when no other pointer names it. */
const otherHolderOf = async (deps: Deps, home: string, workerId: string, sessionId: string): Promise<CliResult<string | null>> => {
  const listed = await listWorkerRecords(deps, home);
  if (!listed.ok) return listed;
  for (const record of listed.value.workers) {
    if (record.id === workerId) continue;
    const pointer = await readPointer(deps, home, record.id);
    if (!pointer.ok) return pointer;
    if (pointer.value.state === 'session' && pointer.value.sessionId === sessionId) return ok(record.id);
  }
  return ok(null);
};

/**
 * The last-seen line of the newest session of a worker, for a command that acts on that session (stop, resume). A program in a
 * worker pane can write the pointer of its own worker, so the line counts only when all of these hold:
 * - the pointer and the line are valid (`readWorkerLastSeen`), else the state is unknown with `no-line`;
 * - the line records this worker as its owner. A session of the coordinator, of another worker, and a line that records no
 *   owner all fail here, so the state is unknown with `not-owned`;
 * - no other worker has a pointer that names the same session.
 * The failure is a fault of the file system only.
 */
export const readOwnLastSeen = async (deps: Deps, home: string, workerId: string): Promise<CliResult<OwnSessionRead>> => {
  const read = await readWorkerLastSeen(deps, home, workerId);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return unknown('no-line', `the ${roles.worker} has no last-seen line`);
  if (read.value.state === 'invalid') return unknown('no-line', `the last-seen line is not valid: ${read.value.reason}`);
  const { line } = read.value;
  const owner = line[keys.owner];
  if (owner !== workerId) {
    return unknown('not-owned', owner === undefined ? 'the last-seen line records no owner' : `the last-seen line belongs to the session of ${owner}`);
  }
  const holder = await otherHolderOf(deps, home, workerId, line[keys.sessionId]);
  if (!holder.ok) return holder;
  return holder.value === null
    ? ok({ state: 'valid', line })
    : unknown('not-owned', `the pointer of the ${roles.worker} ${holder.value} names the same session`);
};

/**
 * What the last event of a line says: the session waits at the prompt (`prompt`) or it works (`busy`). A line with no event,
 * which holds only a percent, says nothing (null). The rule is the table `eventState` of names.ts.
 */
export const promptStateOf = (line: LastSeen): 'prompt' | 'busy' | null => {
  const event = line[keys.event];
  return event === null ? null : eventState[event];
};
