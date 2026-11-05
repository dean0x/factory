import { join } from 'node:path';
import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { isSlug, slug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { withFolderLock, writeInFolder, type FolderTarget } from '../core/safe-write.js';
import { describeIssues } from '../core/zod.js';
import { eventState, files, hookNames, lastSeen, privateFile, roles, schemaIds, type HookEvent } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import { listWorkerRecords, readCheckedFile, readWorkerFile, type WorkerFileRead } from './registry.js';

/**
 * The last-seen line of a session (design 4.6). The hook of Claude Code writes the last event and its time. The status
 * line writes the context percent and its time. Each write keeps the part that it does not set, so one file holds both.
 * The file is one JSON text in the heartbeat folder of the run-time folder, named by the session id. A worker has one more
 * file, a pointer in its own folder that holds the id of its newest session, so the line of a worker is found from the id
 * of the worker. The coordinator has the same pointer in the run-time folder, so its newest session is found from the id of the
 * node. This module is the only writer and the only reader of these files.
 *
 * The line also records the session marker: the id that the session marker held when the line was made, which is the id of the
 * node for a coordinator session and the id of a worker for a worker session. A program in a worker pane can write the pointer
 * of its own worker, so a command that acts on a session of a worker (stop, resume) reads the line with `readOwnLastSeen`,
 * which accepts a session only when the line carries the id of this worker as its session marker. A command that resumes the
 * coordinator reads the line with `readOwnCoordinatorSession`, which accepts a session only when the line carries the id of
 * the node.
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
    [keys.sessionMarker]: slug.optional(),
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

/**
 * Remove the last-seen file of one session. A session id that is not a UUID is a failure, and no path is touched. A file or a folder
 * that is not there is removed already. A heartbeat folder or a file that is a link, or a file of another kind, is a failure, and
 * nothing is removed.
 */
export const removeLastSeen = async (deps: Deps, home: string, sessionId: string): Promise<CliResult<void>> => {
  if (!isSessionId(sessionId)) return failure('cannot remove a last-seen line: the session id is not a UUID');
  const folder = layoutOf(home).heartbeatDir;
  const file = join(folder, sessionId);
  for (const [path, kind, article] of [[folder, 'dir', 'a folder'], [file, 'file', 'a file']] as const) {
    const found = await deps.fs.lstat(path);
    if (!found.ok) return found;
    if (found.value === null) return ok(undefined);
    if (found.value !== kind) {
      const reason = found.value === 'link' ? 'is a link' : `is not ${article}`;
      return failure(`cannot remove ${file}: ${path} ${reason}`);
    }
  }
  return deps.fs.remove(file);
};

const lineWith = (
  sessionId: string,
  event: HookEvent | null,
  eventAt: string | null,
  percent: number | null,
  percentAt: string | null,
  marker: string | undefined,
): LastSeen => ({
  [keys.schema]: schemaIds.lastSeen,
  [keys.sessionId]: sessionId,
  [keys.event]: event,
  [keys.eventAt]: eventAt,
  [keys.contextPct]: percent,
  [keys.pctAt]: percentAt,
  ...(marker === undefined ? {} : { [keys.sessionMarker]: marker }),
});

/**
 * The line after a change: the part that the change does not set is the stored part, or empty when there is none. A stored
 * line keeps its session marker, or keeps having none: a write never gives a marker to a line that has none. A line that is
 * new, or that replaces a text that is not valid, gets the marker of the writer.
 */
const changedLine = (
  stored: LastSeen | null,
  sessionId: string,
  change: LastSeenChange,
  at: string,
  writer: string | undefined,
): LastSeen => {
  const marker = stored === null ? writer : stored[keys.sessionMarker];
  return change.kind === 'event'
    ? lineWith(sessionId, change.event, at, stored?.[keys.contextPct] ?? null, stored?.[keys.pctAt] ?? null, marker)
    : lineWith(
        sessionId,
        stored?.[keys.event] ?? null,
        stored?.[keys.eventAt] ?? null,
        change.percent,
        change.percent === null ? null : at,
        marker,
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
 * `marker` is the id that the session marker of the writer holds (a slug). A new line records it. A stored line that records
 * another marker is never changed: the write is a failure, so a session of one node or worker can not rewrite the line of a
 * session of another.
 */
export const writeLastSeen = async (
  deps: Deps,
  home: string,
  sessionId: string,
  change: LastSeenChange,
  marker?: string,
): Promise<CliResult<LastSeen>> => {
  if (!isSessionId(sessionId)) return failure('cannot record the last-seen line: the session id is not a UUID');
  const allowed = nextLine(null, sessionId, change, deps.now(), marker);
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
    const storedMarker = storedLine?.[keys.sessionMarker];
    if (marker !== undefined && storedMarker !== undefined && storedMarker !== marker) {
      return failure(`cannot record the last-seen line: the session belongs to ${storedMarker}, not to ${marker}`);
    }
    const next = nextLine(storedLine, sessionId, change, deps.now(), marker);
    if (!next.ok) return next;
    const written = await writeInFolder(deps, target, `${JSON.stringify(next.value)}\n`);
    return written.ok ? next : written;
  });
};

/** Write a pointer file: the session id and a new line, replaced as a whole. `who` names the owner in the failure. */
const writePointer = async (deps: Deps, who: string, target: FolderTarget, sessionId: string): Promise<CliResult<void>> => {
  if (!isSessionId(sessionId)) return failure(`cannot record the session of the ${who}: the session id is not a UUID`);
  return writeInFolder(deps, target, `${sessionId}\n`);
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
  return writePointer(
    deps,
    roles.worker,
    {
      parent: layoutOf(home).workersDir,
      folder: workerPathsOf(home, workerId).dir,
      name: files.workerLastSession,
      mode: privateFile.fileMode,
      folderMode: privateFile.folderMode,
    },
    sessionId,
  );
};

/**
 * Record the newest session of the coordinator: the pointer in the run-time folder holds the session id and a new line. The
 * rules are those of `writeWorkerSession`: the file is replaced as a whole, a session id that is not a UUID is refused and
 * nothing changes, and a folder or a file that is a link is a security stop (exit 4). The caller has written the last-seen
 * line of the session first, under the session marker of the node.
 */
export const writeCoordinatorSession = async (deps: Deps, home: string, sessionId: string): Promise<CliResult<void>> => {
  const layout = layoutOf(home);
  return writePointer(
    deps,
    roles.coordinator,
    {
      parent: layout.stateDir,
      folder: layout.runtimeDir,
      name: files.coordinatorLastSession,
      mode: privateFile.fileMode,
      folderMode: privateFile.folderMode,
    },
    sessionId,
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
  const pointer = await readPointer(deps, home, workerPointer(workerId));
  if (!pointer.ok) return pointer;
  if (pointer.value.state !== 'found') return ok(pointer.value);
  return readLastSeen(deps, home, pointer.value.sessionId);
};

/** What the pointer holds: a session id, a file that is not valid and the reason, or no file. */
type PointerRead =
  | { readonly state: 'found'; readonly sessionId: string }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'absent' };

/** Whose pointer to read: the pointer of a worker, or the pointer of the coordinator. */
type PointerOwner =
  | { readonly kind: typeof roles.worker; readonly id: string }
  | { readonly kind: typeof roles.coordinator };

const workerPointer = (id: string): PointerOwner => ({ kind: roles.worker, id });
const COORDINATOR_POINTER: PointerOwner = { kind: roles.coordinator };

const POINTER_WHAT = 'the pointer';

/** The pointer file of the owner, read with the link and size checks of `readCheckedFile`. */
const readPointerFile = (deps: Deps, home: string, owner: PointerOwner): Promise<CliResult<WorkerFileRead>> => {
  if (owner.kind === roles.worker) {
    return readWorkerFile(deps, home, owner.id, { of: 'lastSessionFile', what: POINTER_WHAT, maxBytes: lastSeen.pointerMaxBytes });
  }
  const layout = layoutOf(home);
  return readCheckedFile(
    deps,
    [{ path: layout.runtimeDir, what: 'the run-time folder' }],
    { path: layout.coordinatorLastSessionFile, what: POINTER_WHAT },
    lastSeen.pointerMaxBytes,
  );
};

const readPointer = async (deps: Deps, home: string, owner: PointerOwner): Promise<CliResult<PointerRead>> => {
  const pointer = await readPointerFile(deps, home, owner);
  if (!pointer.ok) return pointer;
  if (pointer.value.state !== 'text') return ok(pointer.value);
  const sessionId = pointer.value.text.endsWith('\n') ? pointer.value.text.slice(0, -1) : pointer.value.text;
  return isSessionId(sessionId)
    ? ok({ state: 'found', sessionId })
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

/** Why a line is not the line of the owner: it records no session marker, or the marker of another session. */
const foreignMarkerReason = (marker: string | undefined): string =>
  marker === undefined ? 'the last-seen line records no session marker' : `the last-seen line belongs to the session of ${marker}`;

/** The id of another worker whose pointer names the session, or null when no other pointer names it. */
const otherHolderOf = async (deps: Deps, home: string, workerId: string, sessionId: string): Promise<CliResult<string | null>> => {
  const listed = await listWorkerRecords(deps, home);
  if (!listed.ok) return listed;
  for (const record of listed.value.workers) {
    if (record.id === workerId) continue;
    const pointer = await readPointer(deps, home, workerPointer(record.id));
    if (!pointer.ok) return pointer;
    if (pointer.value.state === 'found' && pointer.value.sessionId === sessionId) return ok(record.id);
  }
  return ok(null);
};

/**
 * The last-seen line of the newest session of a worker, for a command that acts on that session (stop, resume). A program in a
 * worker pane can write the pointer of its own worker, so the line counts only when all of these hold:
 * - the pointer and the line are valid (`readWorkerLastSeen`), else the state is unknown with `no-line`;
 * - the line records the id of this worker as its session marker. A session of the coordinator, of another worker, and a line
 *   that records no session marker all fail here, so the state is unknown with `not-owned`;
 * - no other worker has a pointer that names the same session.
 * The failure is a fault of the file system only.
 */
export const readOwnLastSeen = async (deps: Deps, home: string, workerId: string): Promise<CliResult<OwnSessionRead>> => {
  const read = await readWorkerLastSeen(deps, home, workerId);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return unknown('no-line', `the ${roles.worker} has no last-seen line`);
  if (read.value.state === 'invalid') return unknown('no-line', `the last-seen line is not valid: ${read.value.reason}`);
  const { line } = read.value;
  const marker = line[keys.sessionMarker];
  if (marker !== workerId) return unknown('not-owned', foreignMarkerReason(marker));
  const holder = await otherHolderOf(deps, home, workerId, line[keys.sessionId]);
  if (!holder.ok) return holder;
  return holder.value === null
    ? ok({ state: 'valid', line })
    : unknown('not-owned', `the pointer of the ${roles.worker} ${holder.value} names the same session`);
};

/** What a command may use of the newest session of the coordinator: its id and line, or the reason that there is none it may use. */
export type CoordinatorSessionRead =
  | { readonly state: 'valid'; readonly sessionId: string; readonly line: LastSeen }
  /** There is no pointer: the coordinator never ran a session that recorded one. */
  | { readonly state: 'absent' }
  /** The pointer, or the line that it names, can not be used: not valid, a link, or a pointer to a session with no line. */
  | { readonly state: 'invalid'; readonly reason: string }
  /** There is a valid line, and it does not belong to the coordinator of this node. */
  | { readonly state: 'not-owned'; readonly reason: string };

/**
 * The newest session of the coordinator, for a command that resumes it. The pointer in the run-time folder is a hint, so the id
 * counts only when the line that it names records the id of the node (`nodeId`) as its session marker. A session of a worker, of
 * another node, and a line with no session marker are not owned. The check does not prove who wrote the line.
 * No pointer is absent: the caller starts a new conversation. The failure is a fault of the file system only.
 */
export const readOwnCoordinatorSession = async (
  deps: Deps,
  home: string,
  nodeId: string,
): Promise<CliResult<CoordinatorSessionRead>> => {
  const pointer = await readPointer(deps, home, COORDINATOR_POINTER);
  if (!pointer.ok) return pointer;
  if (pointer.value.state === 'absent') return ok({ state: 'absent' });
  if (pointer.value.state === 'invalid') return ok({ state: 'invalid', reason: pointer.value.reason });
  const { sessionId } = pointer.value;
  const read = await readLastSeen(deps, home, sessionId);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return ok({ state: 'invalid', reason: 'the pointer names a session that has no last-seen line' });
  if (read.value.state === 'invalid') return ok({ state: 'invalid', reason: `the last-seen line is not valid: ${read.value.reason}` });
  const { line } = read.value;
  const marker = line[keys.sessionMarker];
  return marker === nodeId
    ? ok({ state: 'valid', sessionId, line })
    : ok({ state: 'not-owned', reason: foreignMarkerReason(marker) });
};

/**
 * What the last event of a line says: the session waits at the prompt (`prompt`) or it works (`busy`). A line with no event,
 * which holds only a percent, says nothing (null). The rule is the table `eventState` of names.ts.
 */
export const promptStateOf = (line: LastSeen): 'prompt' | 'busy' | null => {
  const event = line[keys.event];
  return event === null ? null : eventState[event];
};
