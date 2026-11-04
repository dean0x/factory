import type { FactoryConfig } from '../../src/config/schema.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { createFakeDeps, registerRoot, type FakeDeps } from './fake-deps.js';
import { sampleConfig, seedConfig } from './sample-config.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from './tmux-fake.js';

export const HOME = '/w/node';
/** The id of the node, and so the name of its tmux session. */
export const NODE = sampleConfig().core.node.id;

export interface SlotSetup {
  /** The ids of the workers that have a record. */
  readonly workers?: readonly string[];
  /** More panes in the session of the node. A pane with no window is a pane of the workers window. */
  readonly panes?: readonly PaneFixture[];
  readonly tmux?: TmuxFixture;
  readonly config?: FactoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SlotMade {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** Runs one tmux call, as the tmux server would run a call of its own. The result is the exit code and the texts. */
  readonly serverCall: (args: readonly string[]) => { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}

/** A pane of a worker, in the session of the node. The first one that a setup lists gets `%3`, because the session holds `%0` to `%2`. */
export const workerPane = (worker: string, change: Partial<PaneFixture> = {}): PaneFixture => ({
  session: NODE,
  options: { '@worker': worker },
  ...change,
});

/** A factory folder with a running tmux session of the node, the records of the workers of the setup, and the panes of the setup. */
export const makeSlot = async (setup: SlotSetup = {}): Promise<SlotMade> => {
  const sessions = setup.tmux?.sessions ?? { [NODE]: HOME };
  // The panes of the setup belong to the session of the node, so a setup with no such session has no panes.
  const panes = NODE in sessions ? (setup.panes ?? []) : [];
  const { handler, log } = tmuxHandler({ sessions, panes, ...setup.tmux });
  const deps = createFakeDeps({
    cwd: '/w',
    os: 'darwin',
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', ...setup.env },
    run: handler,
  });
  const config = setup.config ?? sampleConfig();
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
  for (const id of setup.workers ?? []) {
    const written = await writeWorkerRecord(deps, HOME, {
      id,
      project: 'web',
      workCopy: `${HOME}/work-copies/web/${id}`,
      branch: `worker/${id}`,
    });
    if (!written.ok) throw new Error(written.error.message);
  }
  const serverCall = (args: readonly string[]) => {
    const result = handler({ command: 'tmux', args, cwd: undefined });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { deps, tmux: log, serverCall };
};
