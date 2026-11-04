import { err, ok, type Result } from '../core/result.js';
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

/** In an argument list, this word ends a tmux command and starts the next one. */
const NEXT_COMMAND = ';';

/**
 * tmux reads a word that ends in a semicolon as the end of a command, and the words after it as the next command.
 * A word that comes from outside, such as a path, can end in a semicolon. A backslash before the last semicolon makes
 * the semicolon part of the word, and tmux drops the backslash. This keeps every path usable, and it needs no check.
 */
const literalWord = (word: string): string =>
  word.endsWith(NEXT_COMMAND) ? `${word.slice(0, -NEXT_COMMAND.length)}\\${NEXT_COMMAND}` : word;

/** One tmux command as an argument list. No word of it ends the command. */
const call = (...words: readonly string[]): TmuxArgs => words.map(literalWord);

/** The left pane of the view window is the coordinator, the right pane is the slot. */
const LEFT_PANE = '{left}';
const RIGHT_PANE = '{right}';

/** The pane of the coordinator: the left pane of the view window. */
const coordinatorPane = (id: string): string => `${windowTarget(id, tmuxNames.windowView)}.${LEFT_PANE}`;

export const hasSessionArgs = (id: string): TmuxArgs => call('has-session', '-t', sessionTarget(id));

/**
 * Asks whether the program of the coordinator pane has ended. The output is `1` for an ended program and `0` for a program
 * that runs. The pane stays after its program ended, because of remain-on-exit. `display-message` names the one pane
 * exactly, so the answer never comes from the slot pane.
 */
export const coordinatorEndedArgs = (id: string): TmuxArgs =>
  call('display-message', '-p', '-t', coordinatorPane(id), '#{pane_dead}');

/** The node home that a session holds in its option. `-q` gives an empty answer, not an error, for a session without the option. */
export const showHomeArgs = (id: string): TmuxArgs =>
  call('show-options', '-q', '-v', '-t', windowTarget(id, ''), tmuxNames.optionHome);

export const killSessionArgs = (id: string): TmuxArgs => call('kill-session', '-t', sessionTarget(id));

export const attachArgs = (id: string): TmuxArgs => call('attach', '-t', sessionTarget(id));

export const switchArgs = (id: string): TmuxArgs => call('switch-client', '-t', sessionTarget(id));

/** The command that a person types to attach to the session. */
export const attachHint = (id: string): string => `${toolNames.tmux} attach -t ${id}`;

/** The pane id of tmux: a percent sign and digits, for example `%12`. tmux makes the id, and a pane keeps it as long as it lives. */
const PANE_ID_PATTERN = /^%[0-9]+$/;

export const isPaneId = (text: string): boolean => PANE_ID_PATTERN.test(text);

/** The name of a pane option that factory sets: an at sign, then lower case letters, digits and underscores. */
const PANE_OPTION_PATTERN = /^@[a-z][a-z0-9_]{0,31}$/;

const MAX_SHELL_TEXT_CHARS = 1024;

const refuse = (what: string): Result<never, string> => err(`the tmux call refuses ${what}`);

/** A pane is a target only by its id. A name, an index or a position can match another pane. */
const paneTarget = (pane: string): Result<string, string> =>
  isPaneId(pane) ? ok(pane) : refuse('a pane id that is not a percent sign and digits');

const PANE_ID_FORMAT = '#{pane_id}';

/** The words of one line of the pane list. No valid value holds this word, and a printable word survives the output of tmux. */
const FIELD_SEPARATOR = '|';

/** The format of one line of the pane list. The worker option is last, because a person or a program can set its value. */
const PANE_LIST_FORMAT = [PANE_ID_FORMAT, '#{pane_pid}', '#{pane_dead}', `#{${tmuxNames.optionWorker}}`].join(FIELD_SEPARATOR);

/** Lists every pane of every window of the session, one line for each pane. `parsePaneList` reads the output. */
export const paneListArgs = (id: string): TmuxArgs =>
  call('list-panes', '-s', '-t', windowTarget(id, ''), '-F', PANE_LIST_FORMAT);

export interface PaneRow {
  readonly paneId: string;
  /** The process id of the program of the pane. For a pane that has ended, it is the id that the program had. */
  readonly pid: number;
  readonly dead: boolean;
  /** The value of the worker option, or null for a pane with no worker, such as the coordinator and the slot. */
  readonly worker: string | null;
}

const PANE_FIELDS = 4;
/** A process id is a number from 1, with no leading zero and at most 10 digits. A pid of 0 would name a process group. */
const PID_PATTERN = /^[1-9][0-9]{0,9}$/;
/** A worker id: letters, digits, dots, underscores and dashes, with a letter or a digit first. */
const WORKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** What a reader of the list does with a worker mark that is not a worker id: refuse the list, or read the pane as no worker. */
type BadMark = 'refuse' | 'ignore';

const parsePaneLine = (line: string, badMark: BadMark): PaneRow | null => {
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length < PANE_FIELDS || (badMark === 'refuse' && fields.length > PANE_FIELDS)) return null;
  const [paneId = '', pid = '', dead = ''] = fields;
  if (!isPaneId(paneId) || !PID_PATTERN.test(pid)) return null;
  if (dead !== '0' && dead !== '1') return null;
  // The mark is the last field, and a program can set it to any text, also text with the separator. A reader that ignores
  // a bad mark takes the rest of the line as the mark, so that a bad mark never moves the id, the pid or the dead flag.
  const worker = fields.slice(PANE_FIELDS - 1).join(FIELD_SEPARATOR);
  const valid = worker === '' || WORKER_PATTERN.test(worker);
  if (!valid && badMark === 'refuse') return null;
  return { paneId, pid: Number(pid), dead: dead === '1', worker: valid && worker !== '' ? worker : null };
};

const parsePaneLines = (text: string, badMark: BadMark): Result<readonly PaneRow[], string> => {
  if (text === '') return ok([]);
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const rows: PaneRow[] = [];
  for (const [index, line] of lines.entries()) {
    const row = parsePaneLine(line, badMark);
    if (row === null) return err(`line ${index + 1} of the pane list is malformed`);
    rows.push(row);
  }
  return ok(rows);
};

/**
 * Reads the output of the call from `paneListArgs`. One malformed line refuses the whole list, so that a caller never
 * acts on a part of it. The error names the number of the line and never its text.
 */
export const parsePaneList = (text: string): Result<readonly PaneRow[], string> => parsePaneLines(text, 'refuse');

/**
 * Reads the same list as `parsePaneList`, with one change: a worker mark that is not a worker id makes the pane a pane with
 * no worker, and the list stays whole. The id, the pid and the dead flag stay strict. A command that only looks at the
 * panes, such as a launch, a list or a stop, uses this reader, so that a pane with a strange mark can not block it.
 */
export const parsePaneListSoft = (text: string): Result<readonly PaneRow[], string> => parsePaneLines(text, 'ignore');

export const killPaneArgs = (pane: string): Result<TmuxArgs, string> => {
  const target = paneTarget(pane);
  return target.ok ? ok(call('kill-pane', '-t', target.value)) : target;
};

/**
 * Makes a pane in the workers window of the session, in the folder, with the command as an argument list and no shell.
 * The pane does not become the active pane. The call prints the id of the new pane. A command that is empty makes tmux
 * start a shell, so the call refuses it.
 */
export const splitWorkerPaneArgs = (input: {
  readonly id: string;
  readonly cwd: string;
  readonly command: readonly string[];
}): Result<TmuxArgs, string> => {
  const { id, cwd, command } = input;
  if (command.length === 0) return refuse('a pane with no command');
  return ok(
    call('split-window', '-d', '-P', '-F', PANE_ID_FORMAT, '-t', windowTarget(id, tmuxNames.windowWorkers), '-c', cwd, '--', ...command),
  );
};

/** Sets a pane option on the pane, by its id. Only the options that factory sets are allowed: the name starts with an at sign. */
export const setPaneOptionArgs = (pane: string, option: string, value: string): Result<TmuxArgs, string> => {
  const target = paneTarget(pane);
  if (!target.ok) return target;
  if (!PANE_OPTION_PATTERN.test(option)) return refuse('a pane option that is not a name with an at sign');
  return ok(call('set-option', '-p', '-t', target.value, option, value));
};

/** Swaps two panes, by their ids. A pane keeps its id and its options. */
export const swapPaneArgs = (source: string, target: string): Result<TmuxArgs, string> => {
  const from = paneTarget(source);
  if (!from.ok) return from;
  const to = paneTarget(target);
  return to.ok ? ok(call('swap-pane', '-s', from.value, '-t', to.value)) : to;
};

/**
 * Runs a shell text in the background of the tmux server. The text goes to a shell, so the caller builds it from values that
 * it made: digits, a token and pane ids. The call refuses an empty text, a control character, and a text that is too long.
 */
export const runShellBackgroundArgs = (text: string): Result<TmuxArgs, string> => {
  if (text === '' || text.length > MAX_SHELL_TEXT_CHARS || /\p{Cc}/u.test(text)) {
    return refuse('a shell text that is empty, too long, or has a control character');
  }
  return ok(call('run-shell', '-b', text));
};

/** Makes a window in the background, in the folder. The empty window in the target makes it a window of the session. */
export const newWindowArgs = (id: string, name: string, cwd: string): TmuxArgs =>
  call('new-window', '-d', '-t', windowTarget(id, ''), '-n', name, '-c', cwd);

/**
 * The tmux calls that start the session of a node, in order. Each call is an argument list for a program that runs with no shell.
 * The view window holds the coordinator and the slot. The workers window holds the workers, which come in a later version.
 * The coordinator pane stays when its program ends, so that a person can read why it ended. The first call sets this
 * option after `new-session`, as a second command in the same argument list. A separate call would come too late for a
 * program that ends at once, and tmux would remove the session with it. The server runs both commands of one call before
 * it handles the end of a program.
 * The first pane runs the launch with no shell, and the launch clears the proxy variable. The call after the first one
 * removes the proxy variable from the environment of the session, so the shell of every later pane and window gets none.
 * The call after that puts the session marker in the environment of the session, before the second pane and before
 * every other window, so the shell of every later pane and window carries the marker.
 * Each call names the session and never the server: other sessions keep their environment.
 * Every word goes through `call`, so a path or a value that ends in a semicolon stays one word.
 * Every window starts in the coordinator folder. The session option holds the home, the root of the config repo.
 */
export const startSteps = (input: {
  readonly id: string;
  readonly home: string;
  readonly coordinatorDir: string;
  readonly launch: readonly string[];
}): readonly TmuxArgs[] => {
  const { id, home, coordinatorDir, launch } = input;
  const view = windowTarget(id, tmuxNames.windowView);
  return [
    [
      ...call('new-session', '-d', '-s', id, '-n', tmuxNames.windowView, '-c', coordinatorDir, '--', ...launch),
      NEXT_COMMAND,
      ...call('set-option', '-w', '-t', view, 'remain-on-exit', 'on'),
    ],
    call('set-environment', '-t', sessionTarget(id), '-r', env.proxyBaseUrl),
    call('set-environment', '-t', sessionTarget(id), env.session, id),
    call('set-option', '-p', '-t', coordinatorPane(id), tmuxNames.optionNode, id),
    call('set-option', '-t', windowTarget(id, ''), tmuxNames.optionHome, home),
    call('split-window', '-d', '-h', '-t', view, '-c', coordinatorDir),
    call('set-option', '-p', '-t', `${view}.${RIGHT_PANE}`, tmuxNames.optionSlot, tmuxNames.slotBoard),
    newWindowArgs(id, tmuxNames.windowWorkers, coordinatorDir),
  ];
};
