import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import type { FakeDeps } from './fake-deps.js';
import type { TmuxLog } from './tmux-fake.js';

/**
 * What the program of a new worker pane does while the launch waits for it. The fake clock moves only when the code sleeps, so a
 * program acts at the wait that a test names: the first wait is 1. Without a program, a pane stays alive and writes nothing.
 */
export interface Wait {
  /** The count of waits since the start of the run, counting the one that just ended. The first is 1. */
  readonly count: number;
  /** The deps of the run. A write through them has the time of the fake clock, which already includes this wait. */
  readonly deps: FakeDeps;
  /** The id of the newest pane that `split-window` made. */
  readonly pane: string | undefined;
  /** The session id that the newest launch gave to `--resume`, or undefined for a launch with no `--resume`. */
  readonly resumeId: string | undefined;
}

export type Program = (wait: Wait) => Promise<void> | void;

const RESUME_FLAG = '--resume';

const resumeIdOf = (deps: FakeDeps): string | undefined => {
  const split = [...deps.calls].reverse().find((call) => call.command === 'tmux' && call.args[0] === 'split-window');
  const at = split?.args.indexOf(RESUME_FLAG) ?? -1;
  return at < 0 ? undefined : split?.args[at + 1];
};

/** The deps whose `sleep` runs the program after each wait. */
export const withProgram = (deps: FakeDeps, tmux: TmuxLog, program: Program): FakeDeps => {
  let count = 0;
  const wrapped: FakeDeps = {
    ...deps,
    sleep: async (ms) => {
      await deps.sleep(ms);
      count += 1;
      await program({ count, deps: wrapped, pane: tmux.panes().at(-1)?.id, resumeId: resumeIdOf(deps) });
    },
  };
  return wrapped;
};

/** Runs the action at the wait with this count, and at no other wait. */
export const atWait =
  (count: number, action: Program): Program =>
  async (wait) => {
    if (wait.count === count) await action(wait);
  };

/**
 * The session of a launch that starts: the SessionStart hook writes the pointer of the worker and the last-seen line, as the
 * hook of the program does. A launch with `--resume` writes the line of the session that it resumes.
 */
export const startsSession =
  (home: string, workerId: string, marker: string = workerId): Program =>
  async ({ deps, resumeId }) => {
    if (resumeId === undefined) return;
    const pointer = await writeWorkerSession(deps, home, workerId, resumeId);
    if (!pointer.ok) throw new Error(pointer.error.message);
    const line = await writeLastSeen(deps, home, resumeId, { kind: 'event', event: 'SessionStart' }, marker);
    if (!line.ok) throw new Error(line.error.message);
  };

/**
 * The sessions of a run that resumes more than one worker: `byResume` maps the session id of a resume to the worker that resumes
 * it, and the launch with that id starts as `startsSession` does for that worker. A launch with an id that the map lacks does nothing.
 */
export const startsSessions =
  (home: string, byResume: Readonly<Record<string, string>>): Program =>
  async (wait) => {
    const worker = wait.resumeId === undefined ? undefined : byResume[wait.resumeId];
    if (worker !== undefined) await startsSession(home, worker)(wait);
  };

/** The program of the pane ends and tmux removes the pane, as it does in a window that does not keep ended panes. */
export const endsPane: Program = async ({ deps, pane }) => {
  if (pane === undefined) throw new Error('no pane to end');
  const killed = await deps.run('tmux', ['kill-pane', '-t', pane]);
  if (!killed.ok) throw new Error(killed.error.message);
};
