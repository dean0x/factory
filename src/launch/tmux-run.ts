import { failure, notReady, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { commands, commandText, keys, places, roles } from '../names.js';
import { coordinatorEndedArgs, hasSessionArgs, showHomeArgs, type TmuxArgs } from './tmux.js';

const TMUX_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARS = 200;

const detailOf = (stderr: string): string => {
  const line = stderr
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
    ?.trim()
    .slice(0, MAX_DETAIL_CHARS);
  return line === undefined ? '' : `: ${line}`;
};

export const tmuxCall = (deps: Deps, args: TmuxArgs) =>
  deps.run(toolNames.tmux, args, { inheritEnv: true, timeoutMs: TMUX_TIMEOUT_MS });

/** A tmux call that must work. The result is its output. */
export const tmuxStep = async (deps: Deps, args: TmuxArgs): Promise<CliResult<string>> => {
  const result = await tmuxCall(deps, args);
  if (!result.ok) return result;
  const { exitCode, stdout, stderr } = result.value;
  if (exitCode === 0) return ok(stdout);
  return failure(`${toolNames.tmux} ${args[0]} failed (exit code ${exitCode})${detailOf(stderr)}`);
};

/** True when a session with this exact name runs. A tmux that does not run counts as no session. */
export const sessionExists = async (deps: Deps, id: string): Promise<boolean> => {
  const result = await tmuxCall(deps, hasSessionArgs(id));
  return result.ok && result.value.exitCode === 0;
};

/** True when the program of the coordinator pane has ended. A pane that cannot be read counts as one that runs. */
export const coordinatorEnded = async (deps: Deps, id: string): Promise<boolean> => {
  const result = await tmuxCall(deps, coordinatorEndedArgs(id));
  return result.ok && result.value.exitCode === 0 && result.value.stdout.trim() === '1';
};

/** The session is of this home when its option holds this home, also through a link. */
export const isSameHome = async (deps: Deps, stored: string, home: string): Promise<boolean> => {
  if (stored === '') return false;
  if (stored === home) return true;
  const [a, b] = await Promise.all([deps.fs.realpath(stored), deps.fs.realpath(home)]);
  return a.ok && b.ok && a.value === b.value;
};

export const requireOwnSession = async (deps: Deps, id: string, home: string): Promise<CliResult<void>> => {
  const shown = await tmuxStep(deps, showHomeArgs(id));
  if (!shown.ok) return shown;
  if (await isSameHome(deps, shown.value.trim(), home)) return ok(undefined);
  return safetyRefusal(
    `a tmux session ${id} belongs to another ${places.folder}`,
    `Two ${roles.node}s on one machine need two ids. Change ${keys.root.node}.${keys.node.id} in the config of one of them, or stop the other session. Then run "${commandText(commands.start)}" again.`,
  );
};

/**
 * The tmux session of the node must run (exit 3, and the remedy names `start`), and it must be the session of this factory folder
 * (exit 4). `again` is the command line to run again after `start`.
 */
export const requireSession = async (deps: Deps, id: string, home: string, again: string): Promise<CliResult<void>> => {
  if (!(await sessionExists(deps, id))) {
    return notReady(
      `the tmux session ${id} of this ${roles.node} does not run`,
      `Run "${commandText(commands.start)}" to start it. Then run "${again}" again.`,
    );
  }
  return requireOwnSession(deps, id, home);
};
