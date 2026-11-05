import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { commands, env, hookNames, lastSeen, roles, type HookEvent } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import { writeCoordinatorSession, writeLastSeen, writeWorkerSession } from '../workers/last-seen.js';
import { readWorkerRecord } from '../workers/registry.js';

/**
 * The hook of Claude Code (design 4.6): Claude Code runs `<program> hook <event>` at the events of the fixed list and passes
 * the event as JSON on stdin. The hook records the last-seen line of the session. It reads two fields of the input and no
 * other: the schema has no field for the path of the transcript, so that path is dropped unread and nothing opens the file.
 * Every refusal writes nothing. A person never runs it, and it never fails the session that runs it: the caller turns every
 * result into exit 0.
 */

const keys = hookNames.inputKeys;

const inputSchema = z.object({
  [keys.sessionId]: z.string().regex(lastSeen.sessionIdPattern, 'must be a UUID with lower case letters'),
  [keys.eventName]: z.enum(hookNames.events),
});

const isHookEvent = (word: string | undefined): word is HookEvent => hookNames.events.some((event) => event === word);

/** The session id from the stdin of the hook. The input must name the event that the command line names. */
const sessionIdOfInput = async (deps: Deps, event: HookEvent): Promise<CliResult<string>> => {
  const text = await deps.readStdin(hookNames.maxStdinBytes);
  if (!text.ok) return text;
  const json = parseJsonText(text.value);
  if (!json.ok) return failure(`the input is not valid: ${json.error}`);
  const parsed = inputSchema.safeParse(json.value);
  if (!parsed.success) return failure(`the input is not valid: ${describeIssues(parsed.error)}`);
  if (parsed.data[keys.eventName] !== event) {
    return failure(`the event of the input is not the event of the command line (${event})`);
  }
  return ok(parsed.data[keys.sessionId]);
};

/**
 * True when the environment names a factory folder, so the program started this session. Outside such a session a hook does
 * nothing. It is not `inFactorySession` of core/factory-session.ts: that check reads the session marker.
 */
export const hasFactoryHome = (deps: Deps): boolean => {
  const folder = deps.env[env.home];
  return folder !== undefined && folder !== '';
};

/**
 * True when the session marker is the id of a worker that has a valid record in the registry of the node. An id that is
 * not a slug, a missing record and an invalid or linked record are false. The failure is a fault of the file system only.
 */
const isRegisteredWorker = async (deps: Deps, home: string, session: string | undefined): Promise<CliResult<boolean>> => {
  if (session === undefined) return ok(false);
  const read = await readWorkerRecord(deps, home, session);
  return read.ok ? ok(read.value.state === 'valid') : read;
};

/** The factory folder of a session, the id that its marker holds, and the id of its worker (null for the session of the node). */
export interface SessionIdentity {
  readonly home: string;
  /** The id of the node, or the id of the worker: the value of the session marker. A last-seen line records it. */
  readonly marker: string;
  readonly worker: string | null;
}

/**
 * The identity of the session that runs a hook. The folder must pass the registration check, and the session marker must be the
 * id of the node, or the id of a worker that the registry of the node holds. The coordinator never reads the registry. The
 * error is the reason that the hook must write nothing. The caller has checked `hasFactoryHome` first.
 */
export const sessionIdentityOf = async (deps: Deps, registry: RecipeRegistry): Promise<CliResult<SessionIdentity>> => {
  const readNodeId = (readDeps: Deps, home: string) => readNodeIdentity(readDeps, home, registry);
  const located = await locateHomeFolder(deps, undefined, readNodeId, commands.hook);
  if (!located.ok) return located;
  const { home } = located.value;
  const identity = await readNodeId(deps, home);
  if (!identity.ok) return failure(`cannot read the id of the ${roles.node}: ${identity.error}`);
  const session = deps.env[env.session];
  if (session === identity.value.id) return ok({ home, marker: session, worker: null });
  const registered = await isRegisteredWorker(deps, home, session);
  if (!registered.ok) return registered;
  if (session === undefined || !registered.value) {
    return failure(`${env.session} is not the id of the ${roles.node} or of a ${roles.worker} of ${home}`);
  }
  return ok({ home, marker: session, worker: session });
};

/**
 * Record the event as the last-seen line of the session. Outside a factory session (no factory folder in the environment) it
 * does nothing and reads nothing. Otherwise the factory folder must pass the registration check, and the session marker must
 * be the id of the node or the id of a worker in its registry. The hook also records the session as the newest session of its
 * owner, the worker or the coordinator, after the line is written, so a reader finds the line from the id of the worker or
 * from the id of the node. The line records the id of the session marker, and a session with one marker never rewrites the
 * line of a session with another.
 * The value is nothing; an error is the reason that the hook wrote nothing, or that it did not write the pointer.
 */
export const runHook = async (deps: Deps, args: readonly string[], registry: RecipeRegistry): Promise<CliResult<void>> => {
  if (!hasFactoryHome(deps)) return ok(undefined);

  const [event, ...extra] = args;
  if (!isHookEvent(event) || extra.length > 0) return failure(`the command takes one event of: ${hookNames.events.join(', ')}`);

  const sessionId = await sessionIdOfInput(deps, event);
  if (!sessionId.ok) return sessionId;

  const identity = await sessionIdentityOf(deps, registry);
  if (!identity.ok) return identity;
  const { home, worker, marker } = identity.value;

  const written = await writeLastSeen(deps, home, sessionId.value, { kind: 'event', event }, marker);
  if (!written.ok) return written;
  return worker === null
    ? writeCoordinatorSession(deps, home, sessionId.value)
    : writeWorkerSession(deps, home, worker, sessionId.value);
};
