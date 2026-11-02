import { toolNames } from '../core/tools.js';
import { env, tmuxNames } from '../names.js';

export type TmuxArgs = readonly string[];

/** The target of a session by its exact name. A bare name would also match the start of another name. */
export const sessionTarget = (id: string): string => `=${id}`;

/**
 * A window of the session. The colon makes the target a window, also when the name is empty.
 * The commands for options and new windows take a pane or window target, which a bare `=name` is not.
 */
const windowTarget = (id: string, window: string): string => `${sessionTarget(id)}:${window}`;

/** The left pane of the view window is the coordinator, the right pane is the slot. */
const LEFT_PANE = '{left}';
const RIGHT_PANE = '{right}';

/** The pane of the coordinator: the left pane of the view window. */
const coordinatorPane = (id: string): string => `${windowTarget(id, tmuxNames.windowView)}.${LEFT_PANE}`;

export const hasSessionArgs = (id: string): TmuxArgs => ['has-session', '-t', sessionTarget(id)];

/**
 * Asks whether the program of the coordinator pane has ended. The output is `1` for an ended program and `0` for a program
 * that runs. The pane stays after its program ended, because of remain-on-exit. `display-message` takes a pane target,
 * but `list-panes` takes a window target, which cannot name one pane.
 */
export const coordinatorEndedArgs = (id: string): TmuxArgs => [
  'display-message',
  '-p',
  '-t',
  coordinatorPane(id),
  '#{pane_dead}',
];

/** The node home that a session holds in its option. `-q` gives an empty answer, not an error, for a session without the option. */
export const showHomeArgs = (id: string): TmuxArgs => [
  'show-options',
  '-q',
  '-v',
  '-t',
  windowTarget(id, ''),
  tmuxNames.optionHome,
];

export const killSessionArgs = (id: string): TmuxArgs => ['kill-session', '-t', sessionTarget(id)];

export const attachArgs = (id: string): TmuxArgs => ['attach', '-t', sessionTarget(id)];

export const switchArgs = (id: string): TmuxArgs => ['switch-client', '-t', sessionTarget(id)];

/** The command that a person types to attach to the session. */
export const attachHint = (id: string): string => `${toolNames.tmux} attach -t ${id}`;

/**
 * The tmux calls that start the session of a node, in order. Each call is an argument list for a program that runs with no shell.
 * The view window holds the coordinator and the slot. The bench window holds the cells, which come in a later version.
 * The coordinator pane stays when its program ends, so that a person can read why it ended.
 * The first pane runs the launch with no shell, and the launch clears the proxy variable. The call after `new-session`
 * removes the variable from the environment of the session, so the shell of every later pane and window gets none.
 * The call names the session and never the server: other sessions keep their environment.
 */
export const startSteps = (input: {
  readonly id: string;
  readonly home: string;
  readonly launch: readonly string[];
}): readonly TmuxArgs[] => {
  const { id, home, launch } = input;
  const view = windowTarget(id, tmuxNames.windowView);
  return [
    ['new-session', '-d', '-s', id, '-n', tmuxNames.windowView, '-c', home, '--', ...launch],
    ['set-environment', '-t', sessionTarget(id), '-r', env.proxyBaseUrl],
    ['set-option', '-w', '-t', view, 'remain-on-exit', 'on'],
    ['set-option', '-p', '-t', coordinatorPane(id), tmuxNames.optionNode, id],
    ['set-option', '-t', windowTarget(id, ''), tmuxNames.optionHome, home],
    ['split-window', '-d', '-h', '-t', view, '-c', home],
    ['set-option', '-p', '-t', `${view}.${RIGHT_PANE}`, tmuxNames.optionSlot, tmuxNames.slotBoard],
    ['new-window', '-d', '-t', windowTarget(id, ''), '-n', tmuxNames.windowBench, '-c', home],
  ];
};
