import { toolNames } from '../../src/core/tools.js';
import type { HookEvent } from '../../src/names.js';
import { writeLastSeen, writeWorkerSession } from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { NODE } from './coordinator-pane.js';
import type { FakeDeps } from './fake-deps.js';
import { tmuxHandler } from './tmux-fake.js';

/**
 * The state of one worker as the program and the hooks leave it: the record of the worker, its session pointer and its last-seen
 * lines. The lines get the time of the fake clock at the call.
 */

const SESSION = '00000000-0000-4000-8000-000000000001';

export interface WorkerSessionSeed {
  readonly id: string;
  readonly project?: string;
  /** The last hook event of the session. */
  readonly event: HookEvent;
  /** The context percent of the last-seen line. */
  readonly percent: number;
}

export const seedWorkerSession = async (deps: FakeDeps, home: string, seed: WorkerSessionSeed): Promise<void> => {
  const project = seed.project ?? 'web';
  const record = await writeWorkerRecord(deps, home, {
    id: seed.id,
    project,
    workCopy: `${home}/work-copies/${project}/${seed.id}`,
    branch: `worker/${seed.id}`,
  });
  if (!record.ok) throw new Error(record.error.message);
  const pointer = await writeWorkerSession(deps, home, seed.id, SESSION);
  if (!pointer.ok) throw new Error(pointer.error.message);
  const event = await writeLastSeen(deps, home, SESSION, { kind: 'event', event: seed.event }, seed.id);
  if (!event.ok) throw new Error(event.error.message);
  const percent = await writeLastSeen(deps, home, SESSION, { kind: 'percent', percent: seed.percent }, seed.id);
  if (!percent.ok) throw new Error(percent.error.message);
};

/**
 * The deps with a running tmux session of the node that holds one live pane for each worker id. A tmux call goes to the fake. Any
 * other program goes to the deps that the caller gave, and the clock and the files stay shared with them.
 */
export const withWorkerPanes = (deps: FakeDeps, home: string, workerIds: readonly string[]): FakeDeps => {
  const { handler } = tmuxHandler({
    sessions: { [NODE]: home },
    panes: workerIds.map((id) => ({ session: NODE, options: { '@worker': id } })),
  });
  return {
    ...deps,
    run: async (command, args, options) =>
      command === toolNames.tmux ? handler({ command, args, cwd: options?.cwd }) : deps.run(command, args, options),
  };
};
