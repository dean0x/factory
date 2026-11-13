import { launchArgv, workerLaunchArgv } from '../../src/launch/argv.js';
import { layoutOf } from '../../src/state/layout.js';

/**
 * The program words of the launch of a worker: the argument list that `launchWorker` gives to tmux. A pane fixture that holds these
 * words as its command is a pane that the launch of that worker made, so a command that checks the start command of the pane
 * accepts it. A pane with other words, or with none, is a pane that the launch did not make.
 */
export const launchWordsOf = (home: string, workerId: string): readonly string[] => {
  const argv = workerLaunchArgv({
    home,
    nodeId: 'demo',
    workerId,
    effort: 'high',
    model: 'default',
    proxyBaseUrl: null,
    path: '/bin',
    agent: 'claude',
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};

/**
 * The program words of the launch of the coordinator of the node at `home`: the start command of the pane that `start` made for it.
 * A pane fixture that holds these words passes the check of the caller rule of the commands that only the coordinator runs.
 */
export const coordinatorWordsOf = (home: string, nodeId: string): readonly string[] => {
  const argv = launchArgv({
    effort: 'high',
    model: 'default',
    proxyBaseUrl: null,
    path: '/bin',
    agent: 'claude',
    home,
    coordinatorDir: layoutOf(home).coordinatorDir,
    stateDir: layoutOf(home).stateDir,
    sessionId: nodeId,
    projects: [],
  });
  if (!argv.ok) throw new Error(argv.error);
  return argv.value;
};
