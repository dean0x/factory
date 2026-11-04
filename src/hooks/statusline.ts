import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { loadConfig } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { hookNames, statuslineTextOf } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import { parsePercent, writeLastSeen } from '../workers/last-seen.js';
import { hasFactoryHome, sessionOwnerOf, type SessionOwner } from './hook.js';

/**
 * The status line wrapper (design 4.6): Claude Code runs `<program> hook statusline` and passes the status line input as
 * JSON on stdin. The wrapper records the context percent in the last-seen line of the session, then shows the status line:
 * the output of the command that the owner names in `session.statusline`, unchanged, or the short line `context N%`. It reads
 * the session id and the context window fields and no other: the schema has no field for the path of the transcript, so that
 * path is dropped unread and nothing opens the file. Every fault leaves the line on the screen, and the caller turns every
 * result into exit 0.
 */

const keys = hookNames.statuslineKeys;
const sessionKey = hookNames.inputKeys.sessionId;

/** A number, or nothing: a null, an absent key and a value of another type all count as no value. */
const count = z.number().optional().catch(undefined);

const usageSchema = z.object({
  [keys.inputTokens]: count,
  [keys.cacheCreationTokens]: count,
  [keys.cacheReadTokens]: count,
});

const windowSchema = z.object({
  [keys.usedPercentage]: count,
  [keys.windowSize]: count,
  [keys.currentUsage]: usageSchema.optional().catch(undefined),
});

const inputSchema = z.object({
  [sessionKey]: z.string().optional().catch(undefined),
  [keys.contextWindow]: windowSchema.optional().catch(undefined),
});

type StatuslineInput = z.infer<typeof inputSchema>;

/** What the wrapper shows: the text for stdout, and the reason for one line on stderr when a step failed (the first one). */
export interface StatuslineShown {
  readonly text: string;
  readonly note: string | null;
}

const parseInput = (text: string): CliResult<StatuslineInput> => {
  const json = parseJsonText(text);
  if (!json.ok) return failure(`the input is not valid: ${json.error}`);
  const parsed = inputSchema.safeParse(json.value);
  return parsed.success ? ok(parsed.data) : failure(`the input is not valid: ${describeIssues(parsed.error)}`);
};

/**
 * The context percent of the input, rounded to a whole number. It is `used_percentage` when that is a number. Else it is the
 * input tokens of the current usage (new, cache creation and cache read) divided by the size of the window, when the three
 * counts and a size above 0 are all numbers. No number gives no percent (null). A percent outside 0-100 is a failure.
 */
const percentOf = (input: StatuslineInput): CliResult<number | null> => {
  const window = input[keys.contextWindow];
  if (window === undefined) return ok(null);
  const given = window[keys.usedPercentage];
  if (given !== undefined) return parsePercent(Math.round(given));
  const usage = window[keys.currentUsage];
  const size = window[keys.windowSize];
  if (usage === undefined || size === undefined || size <= 0) return ok(null);
  const fresh = usage[keys.inputTokens];
  const created = usage[keys.cacheCreationTokens];
  const read = usage[keys.cacheReadTokens];
  if (fresh === undefined || created === undefined || read === undefined) return ok(null);
  return parsePercent(Math.round(((fresh + created + read) / size) * 100));
};

/** The owner of the session, or null outside a factory session. The error is the reason that the guards refuse the session. */
const ownerOfSession = async (deps: Deps, registry: RecipeRegistry): Promise<CliResult<SessionOwner | null>> =>
  hasFactoryHome(deps) ? sessionOwnerOf(deps, registry) : ok(null);

const record = async (deps: Deps, owner: SessionOwner, sessionId: string | undefined, percent: number): Promise<CliResult<void>> => {
  if (sessionId === undefined) return failure('the input holds no session id');
  const written = await writeLastSeen(deps, owner.home, sessionId, { kind: 'percent', percent }, owner.id);
  return written.ok ? ok(undefined) : written;
};

/** The command of the owner (`session.statusline`), or null when the config names none. */
const ownerCommandOf = async (deps: Deps, home: string, registry: RecipeRegistry): Promise<CliResult<string | null>> => {
  const config = await loadConfig(deps, home, registry);
  return config.ok ? ok(config.value.core.session.statusline) : config;
};

/**
 * The stdout of the command of the owner. The command gets the input text as it came and the environment of this process.
 * It runs in its own process group, so the time limit stops every process that a pipe or a list of the command starts.
 * The stop signal stops the group in the same way.
 */
const ownerOutputOf = async (deps: Deps, command: string, stdin: string, stop: AbortSignal): Promise<CliResult<string>> => {
  const ran = await deps.run(hookNames.shell, ['-c', command], {
    timeoutMs: hookNames.statuslineTimeoutMs,
    input: stdin,
    inheritEnv: true,
    processGroup: true,
    signal: stop,
  });
  if (!ran.ok) return failure(`the status line command failed: ${ran.error.message}`);
  if (ran.value.exitCode !== 0) return failure(`the status line command exited with code ${ran.value.exitCode}`);
  return ok(ran.value.stdout);
};

/**
 * Show the status line and record the context percent. The percent is written only for a session that passes the guards of
 * the hook: a factory folder in the environment that passes the registration check, a session marker that is the id of the
 * node, and a session id in the input that is a UUID. Only such a session reads the config and runs the command of the
 * owner. A failed write, a failed command and an input with no percent never change the exit code: the text is the output
 * of the command, else `context N%`, else `context ?%` when no percent is known.
 *
 * While it runs, the signals of `hookNames.stopSignals` stop the command group of the owner, so that no command stays
 * behind when Claude Code ends the wrapper. The wrapper then ends as usual, with the fallback line. Its handlers are
 * removed when it ends, also after a throw. A SIGKILL can not be caught, so it leaves the group running.
 */
export const runStatusline = async (deps: Deps, registry: RecipeRegistry): Promise<StatuslineShown> => {
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  for (const name of hookNames.stopSignals) deps.signals.on(name, onSignal);
  try {
    return await showStatusline(deps, registry, stop.signal);
  } finally {
    for (const name of hookNames.stopSignals) deps.signals.off(name, onSignal);
  }
};

const showStatusline = async (deps: Deps, registry: RecipeRegistry, stop: AbortSignal): Promise<StatuslineShown> => {
  const read = await deps.readStdin(hookNames.maxStdinBytes);
  if (!read.ok) return { text: statuslineTextOf(null), note: read.error.message };
  const stdin = read.value;

  const notes: string[] = [];
  const keep = <T>(result: CliResult<T>, otherwise: T): T => {
    if (result.ok) return result.value;
    notes.push(result.error.message);
    return otherwise;
  };

  const input = keep(parseInput(stdin), null);
  const percent = keep(input === null ? ok(null) : percentOf(input), null);
  const owner = keep(await ownerOfSession(deps, registry), null);

  const recorded: CliResult<void> =
    owner === null || percent === null ? ok(undefined) : await record(deps, owner, input?.[sessionKey], percent);
  keep(recorded, undefined);

  const command = owner === null ? null : keep(await ownerCommandOf(deps, owner.home, registry), null);
  const output = command === null ? null : keep(await ownerOutputOf(deps, command, stdin, stop), null);

  return { text: output ?? statuslineTextOf(percent), note: notes[0] ?? null };
};
