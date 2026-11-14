import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { commands, env, hookNames, lastSeen, roles, roleText, type HookEvent } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import { writeCoordinatorSession, writeLastSeen, writeWorkerSession } from '../workers/last-seen.js';
import { readWorkerRecord } from '../workers/registry.js';
import { readRoleText, roleFaultReason } from '../workers/role-text.js';

/**
 * The hook of Claude Code (design 4.6): Claude Code runs `<program> hook <event>` at the events of the fixed list and passes
 * the event as JSON on stdin. The hook records the last-seen line of the session. It reads three fields of the input and no
 * other: the schema has no field for the path of the transcript, so that path is dropped unread and nothing opens the file.
 * The third field is the type of a `Notification`: the hook records that event only for a type that means a dialog waits.
 * Every refusal writes nothing. A person never runs it, and it never fails the session that runs it: the caller turns every
 * result into exit 0.
 * One event prints an output: the `SessionStart` of a worker that has a record. Its context is the role text of the worker, or
 * the fixed refusal text when a check of that text fails. A start, a resume, a clear and a compact all raise that event. The
 * session of the coordinator and every other event of a worker print nothing.
 * The checks of the role text are: no link in the path of the setup file, the owner and the mode of the file and its folders,
 * the size cap, the encoding, plain text with no control character, no block marker, the acceptance of the exact text, a read
 * that works, a config that can be used, and no throw in the worker branch. Each fault gives one fixed reason on stderr.
 */

const keys = hookNames.inputKeys;

const inputSchema = z.object({
  [keys.sessionId]: z.string().regex(lastSeen.sessionIdPattern, 'must be a UUID with lower case letters'),
  [keys.eventName]: z.enum(hookNames.events),
  [keys.notificationType]: z.string().optional(),
});

const isHookEvent = (word: string | undefined): word is HookEvent => hookNames.events.some((event) => event === word);

/** The event that carries a type in its input. */
const typedEvent: HookEvent = 'Notification';

/** The event that gives a worker its role text. */
export const startEvent: HookEvent = 'SessionStart';

/**
 * What a hook gives back. The context is the text that a session gets, or null for a hook that prints nothing. Each problem is
 * a reason that the caller prints as one line on stderr. A problem names no text of a file.
 */
export interface HookOutcome {
  readonly context: string | null;
  readonly problems: readonly string[];
}

const SILENT: HookOutcome = { context: null, problems: [] };

const out = hookNames.output;

/** The one JSON object that the hook prints for the context of a session start. */
export const hookOutputOf = (context: string) => ({
  [out.hookSpecificOutput]: { [out.hookEventName]: startEvent, [out.additionalContext]: context },
});

/** What the hook reads from its input: the session id, and the type of a notice (absent for an input with no type). */
interface HookInput {
  readonly sessionId: string;
  readonly notificationType: string | undefined;
}

/** The fields of the stdin of the hook. The input must name the event that the command line names. */
const readInput = async (deps: Deps, event: HookEvent): Promise<CliResult<HookInput>> => {
  const text = await deps.readStdin(hookNames.maxStdinBytes);
  if (!text.ok) return text;
  const json = parseJsonText(text.value);
  if (!json.ok) return failure(`the input is not valid: ${json.error}`);
  const parsed = inputSchema.safeParse(json.value);
  if (!parsed.success) return failure(`the input is not valid: ${describeIssues(parsed.error)}`);
  if (parsed.data[keys.eventName] !== event) {
    return failure(`the event of the input is not the event of the command line (${event})`);
  }
  return ok({ sessionId: parsed.data[keys.sessionId], notificationType: parsed.data[keys.notificationType] });
};

/**
 * True when the event is a record of the state of the session. A `Notification` counts only for a type of
 * `hookNames.notificationTypes`; a notice of another type, or with no type, says nothing about a dialog.
 */
const recordsState = (event: HookEvent, input: HookInput): boolean =>
  event !== typedEvent || hookNames.notificationTypes.some((type) => type === input.notificationType);

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
  // The hook belongs to the session that FACTORY_HOME names, also when the current folder is inside another factory folder.
  const located = await locateHomeFolder(deps, deps.env[env.home], readNodeId, commands.hook);
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
 * Record the event as the last-seen line of the session, then record the session as the newest session of its owner, the
 * worker or the coordinator, so a reader finds the line from the id of the worker or from the id of the node. The line
 * records the id of the session marker, and a session with one marker never rewrites the line of a session with another.
 */
const recordSession = async (
  deps: Deps,
  identity: SessionIdentity,
  sessionId: string,
  event: HookEvent,
): Promise<CliResult<void>> => {
  const { home, worker, marker } = identity;
  const written = await writeLastSeen(deps, home, sessionId, { kind: 'event', event }, marker);
  if (!written.ok) return written;
  return worker === null ? writeCoordinatorSession(deps, home, sessionId) : writeWorkerSession(deps, home, worker, sessionId);
};

/** The outcome of a worker that gets the refusal text. The reason is one fixed text of `roleText.reasons`. */
const refusedWith = (reason: string): HookOutcome => ({ context: roleText.refusal, problems: [reason] });

/**
 * The role text of the worker of a node: the text when every check of `readRoleText` passes, and the refusal text with one
 * fixed reason when one fails. A config that cannot be used, a store of acceptances that cannot be used and a throw each
 * give their own fixed reason. No text of a file, no path and no message of an error leaves this function.
 */
const roleOutcomeOf = async (deps: Deps, home: string, registry: RecipeRegistry): Promise<HookOutcome> => {
  try {
    const config = await loadConfig(deps, home, registry);
    if (!config.ok) return refusedWith(roleText.reasons.configNotUsable);
    const read = await readRoleText(deps, { home, config: config.value });
    if (!read.ok) return refusedWith(roleText.reasons.readFailed);
    return read.value.kind === 'ok'
      ? { context: read.value.text, problems: [] }
      : refusedWith(roleFaultReason(read.value.fault));
  } catch {
    return refusedWith(roleText.reasons.readFailed);
  }
};

/**
 * The start of a session of a worker: the role text and the record of the session. The two steps do not depend on each other.
 * A refused text does not stop the record, and a failed record does not stop the text: its message is one more problem. A
 * throw in the record gives the refusal text, because the worker branch must never leave a worker with no text and no refusal.
 */
const startOfWorker = async (
  deps: Deps,
  registry: RecipeRegistry,
  identity: SessionIdentity,
  sessionId: string,
): Promise<CliResult<HookOutcome>> => {
  try {
    const role = await roleOutcomeOf(deps, identity.home, registry);
    const recorded = await recordSession(deps, identity, sessionId, startEvent);
    return ok(recorded.ok ? role : { ...role, problems: [...role.problems, recorded.error.message] });
  } catch {
    return ok(refusedWith(roleText.reasons.readFailed));
  }
};

/**
 * Record the event as the last-seen line of the session. Outside a factory session (no factory folder in the environment) it
 * does nothing and reads nothing. Otherwise the factory folder must pass the registration check, and the session marker must
 * be the id of the node or the id of a worker in its registry. The hook also records the session as the newest session of its
 * owner after the line is written (see `recordSession`).
 * A `Notification` of a type that does not mean a dialog is a valid input that records nothing: the outcome is silent, and the
 * hook reads no file of the factory. An error is the reason that the hook wrote nothing, or that it did not write the pointer,
 * and it prints nothing to stdout.
 * The `SessionStart` of a worker is the one event that gives a context: the role text, or the refusal text. For that event
 * the failure of the record is a problem in the outcome, and no early return.
 */
export const runHook = async (deps: Deps, args: readonly string[], registry: RecipeRegistry): Promise<CliResult<HookOutcome>> => {
  if (!hasFactoryHome(deps)) return ok(SILENT);

  const [event, ...extra] = args;
  if (!isHookEvent(event) || extra.length > 0) return failure(`the command takes one event of: ${hookNames.events.join(', ')}`);

  const input = await readInput(deps, event);
  if (!input.ok) return input;
  if (!recordsState(event, input.value)) return ok(SILENT);
  const { sessionId } = input.value;

  const identity = await sessionIdentityOf(deps, registry);
  if (!identity.ok) return identity;
  if (identity.value.worker !== null && event === startEvent) return startOfWorker(deps, registry, identity.value, sessionId);

  const recorded = await recordSession(deps, identity.value, sessionId, event);
  return recorded.ok ? ok(SILENT) : recorded;
};
