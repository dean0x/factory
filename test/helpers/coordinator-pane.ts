import { toolNames } from '../../src/core/tools.js';
import { launchArgv } from '../../src/launch/argv.js';
import { LAYOUT } from './board-repo.js';
import type { FakeDeps } from './fake-deps.js';
import { HOME } from './guard-fixture.js';
import { sampleConfigWithBoard } from './sample-config.js';
import { tmuxHandler } from './tmux-fake.js';

/** The node id of the sample config: the tmux session of the node has this name. */
export const NODE = sampleConfigWithBoard().core.node.id;

/** The program words of the coordinator pane, as the launch of the coordinator gives them. */
const coordinatorWords = (): readonly string[] => {
  const argv = launchArgv({
    effort: 'high',
    model: 'default',
    proxyBaseUrl: null,
    path: '/bin',
    agent: 'claude',
    home: HOME,
    coordinatorDir: LAYOUT.coordinatorDir,
    stateDir: LAYOUT.stateDir,
    sessionId: NODE,
    projects: [],
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

/**
 * The deps of a caller in a pane of a running session of the node. The pane `%0` is the pane of the coordinator. A tmux call goes to
 * the fake, and `tmuxCalls` gets its arguments. Any other program goes to the deps that the caller gave.
 */
export const inPane = (deps: FakeDeps, pane: string, tmuxCalls: (readonly string[])[] = []): FakeDeps => {
  const { handler } = tmuxHandler({ sessions: { [NODE]: HOME }, coordinatorCommands: { [NODE]: coordinatorWords() } });
  return {
    ...deps,
    env: { ...deps.env, TMUX_PANE: pane, FACTORY_SESSION: NODE },
    run: async (command, args, options) => {
      if (command !== toolNames.tmux) return deps.run(command, args, options);
      tmuxCalls.push(args);
      return handler({ command, args, cwd: options?.cwd });
    },
  };
};
