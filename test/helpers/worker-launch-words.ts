import { workerLaunchArgv } from '../../src/launch/argv.js';

/**
 * The program words of the launch of a worker: the argument list that `launchWorker` gives to tmux. A pane fixture that holds these
 * words as its command is a pane that the launch of that worker made, so a command that checks the start command of the pane
 * accepts it. A pane with other words, or with none, is a pane that the launch did not make.
 */
export const launchWordsOf = (home: string, workerId: string): readonly string[] => {
  const argv = workerLaunchArgv({
    home,
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
