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
import { writeLastSeen } from '../workers/last-seen.js';

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
 * Record the event as the last-seen line of the session. Outside a factory session (no factory folder in the environment) it
 * does nothing and reads nothing. Otherwise the factory folder must pass the registration check, and the session marker must
 * be the id of the node. The value is nothing; an error is the reason that the hook wrote nothing.
 */
export const runHook = async (deps: Deps, args: readonly string[], registry: RecipeRegistry): Promise<CliResult<void>> => {
  const folder = deps.env[env.home];
  if (folder === undefined || folder === '') return ok(undefined);

  const [event, ...extra] = args;
  if (!isHookEvent(event) || extra.length > 0) return failure(`the command takes one event of: ${hookNames.events.join(', ')}`);

  const sessionId = await sessionIdOfInput(deps, event);
  if (!sessionId.ok) return sessionId;

  const readNodeId = (readDeps: Deps, home: string) => readNodeIdentity(readDeps, home, registry);
  const located = await locateHomeFolder(deps, undefined, readNodeId, commands.hook);
  if (!located.ok) return located;
  const identity = await readNodeId(deps, located.value.home);
  if (!identity.ok) return failure(`cannot read the id of the ${roles.node}: ${identity.error}`);
  if (deps.env[env.session] !== identity.value.id) {
    return failure(`${env.session} is not the id of the ${roles.node} of ${located.value.home}`);
  }

  const written = await writeLastSeen(deps, located.value.home, sessionId.value, { kind: 'event', event });
  return written.ok ? ok(undefined) : written;
};
