import { isPaneId } from '../../src/launch/tmux.js';
import { tmuxNames } from '../../src/names.js';
import { exited, missingProgram, type RunCall, type RunHandler } from './fake-deps.js';

/** A pane that exists at the start, in a session of the fixture. */
export interface PaneFixture {
  /** The pane id, for example `%7`. Default: the next free id. */
  readonly id?: string;
  /** A session of the fixture. */
  readonly session: string;
  /** The window that holds the pane. A window that does not exist yet is made. Default: the workers window. */
  readonly window?: string;
  /** The pane options, for example `{ '@worker': 'alpha' }`. */
  readonly options?: Readonly<Record<string, string>>;
  /** The process id of the program of the pane. Default: the next free number from 4000. */
  readonly pid?: number;
  /** True for a pane whose program has ended. The pane stays, because of remain-on-exit. */
  readonly dead?: boolean;
  readonly cwd?: string;
}

export interface TmuxFixture {
  /** The text that `tmux -V` prints. Null means that tmux is not installed. Default: `tmux 3.4`. */
  readonly version?: string | null;
  /**
   * Sessions that run already, by name. The value is the node home in the session option, or null for no option. Each
   * session has the windows that `start` makes: the view window with two panes, and the workers window with one pane.
   */
  readonly sessions?: Readonly<Record<string, string | null>>;
  /** More panes, in the sessions of the fixture. */
  readonly panes?: readonly PaneFixture[];
  /** The first word of a tmux command that fails with exit code 1. */
  readonly failing?: string;
  /** Sessions whose coordinator program has ended. The pane stays, because of remain-on-exit. */
  readonly endedCoordinators?: readonly string[];
  /**
   * The program of a new session ends at once. Like tmux, the fake then ends the session too, unless the same call sets
   * remain-on-exit for the window. With remain-on-exit the session stays, and its coordinator counts as ended.
   */
  readonly programEndsAtOnce?: boolean;
  /** The program of each pane that `split-window` makes ends at once. The pane stays, as a dead pane. */
  readonly newPanesEndAtOnce?: boolean;
  /**
   * How many times `split-window` can split a window before a `select-layout` is needed. Each split halves the pane that it
   * splits, and a detached window has a fixed size, so a window that is never tiled has room for a few splits only. After that
   * count, `split-window` fails with `no space for new pane`, as tmux does, until `select-layout` gives the window room again.
   * Default: no limit.
   */
  readonly splitsBeforeTile?: number;
}

/** The state of one pane, as the log shows it. */
export interface PaneView {
  readonly id: string;
  readonly session: string;
  readonly window: string;
  readonly options: Readonly<Record<string, string>>;
  readonly pid: number;
  readonly dead: boolean;
  readonly cwd: string | null;
  /** The words after `--` in the call that made the pane. Empty for a pane that runs the shell. */
  readonly command: readonly string[];
}

export interface TmuxLog {
  readonly calls: RunCall[];
  /** The tmux commands as one line each, for example `has-session -t =demo`. A command chain keeps its `;` words. */
  commands(): string[];
  /** The sessions that run now, with the node home of their option. */
  sessions(): Map<string, string | null>;
  /** The panes that exist now, in the order of their making. A swap exchanges the places of two panes in this list. */
  panes(): readonly PaneView[];
  /** The layout that `select-layout` set, by `session:window`. A window that got no layout is not in the map. */
  layouts(): Readonly<Record<string, string>>;
  /** The id of the active pane of a window: the pane that gets the keys of the person. Undefined for a window with no pane. */
  activePane(session: string, window: string): string | undefined;
  /** The panes that show a mode screen, from the pane id to the text of the screen. A `run-shell` text that exits with a code other than 0 makes one. */
  modes(): Readonly<Record<string, string>>;
  /** Every run of a shell text by `runShell`, with the exit code of the shell, in order. */
  shellRuns(): readonly ShellRun[];
}

/** One run of the shell text of a `run-shell` call. */
export interface ShellRun {
  readonly text: string;
  /** The exit code of the shell: the code of its last command. */
  readonly exitCode: number;
}

/** The commands that fail for a session that does not exist, when their target names a session. */
const NEEDS_SESSION = new Set([
  'set-environment',
  'set-option',
  'split-window',
  'new-window',
  'switch-client',
  'kill-session',
  'display-message',
  'list-panes',
  'select-layout',
]);

const DEFAULT_LIST_FORMAT = '#{session_name}:#{window_name}.#{pane_index}';
const FIRST_PID = 4000;

/**
 * A command chain is a list of commands in one argument list. tmux reads the list this way: a word that ends in a
 * semicolon ends the command, with the word before the semicolon as its last word. A backslash before that semicolon
 * makes the semicolon part of the word, and the backslash goes away.
 */
export const chainOf = (args: readonly string[]): readonly (readonly string[])[] => {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (!arg.endsWith(';')) {
      commands.at(-1)?.push(arg);
      continue;
    }
    const body = arg.slice(0, -1);
    if (body.endsWith('\\')) {
      commands.at(-1)?.push(`${body.slice(0, -1)};`);
      continue;
    }
    if (body !== '') commands.at(-1)?.push(body);
    commands.push([]);
  }
  return commands.filter((command) => command.length > 0);
};

const keepsPaneOnExit = (command: readonly string[]): boolean =>
  command[0] === 'set-option' && command.includes('remain-on-exit') && command.includes('on');

interface FakePane {
  readonly id: string;
  session: string;
  window: string;
  readonly options: Map<string, string>;
  readonly pid: number;
  dead: boolean;
  readonly cwd: string | null;
  readonly command: readonly string[];
}

/** The word after a flag, or an empty text. */
const after = (command: readonly string[], flag: string): string => command[command.indexOf(flag) + 1] ?? '';

/** True when the command has the flag. The words after `--` are the program of a new pane, so they are not flags. */
const hasFlag = (command: readonly string[], flag: string): boolean =>
  (command.includes('--') ? command.slice(0, command.indexOf('--')) : command).includes(flag);

/** What a new pane can have besides its place. */
type PaneMore = Omit<PaneFixture, 'session' | 'window'> & {
  /** The program of the pane, as an argument list. Empty for the shell. */
  readonly command?: readonly string[];
};

/** The words after `--`: the program of a new pane. */
const programOf = (command: readonly string[]): readonly string[] =>
  command.includes('--') ? command.slice(command.indexOf('--') + 1) : [];

/** The characters that tmux reads as one character when a hash sign comes before them: `##` is `#`, `#,` is `,` and `#}` is `}`. */
const ESCAPED_AFTER_HASH = new Set(['#', ',', '}']);

/** True when the text holds an escape pair (`##`, `#,` or `#}`) at the index. */
const isEscapeAt = (text: string, index: number): boolean =>
  text.charAt(index) === '#' && ESCAPED_AFTER_HASH.has(text.charAt(index + 1));

/** The index of the brace that closes the format whose text starts at `from`, just after its `#{`. -1 when no brace closes it. */
const closingBrace = (text: string, from: number): number => {
  let depth = 1;
  for (let index = from; index < text.length; index += 1) {
    if (isEscapeAt(text, index)) {
      index += 1;
    } else if (text.startsWith('#{', index)) {
      depth += 1;
      index += 1;
    } else if (text.charAt(index) === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/** The two parts of the text of a comparison, split at the first comma that is not inside a nested format. */
const splitComparison = (text: string): readonly [string, string] => {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isEscapeAt(text, index)) {
      index += 1;
    } else if (text.startsWith('#{', index)) {
      depth += 1;
      index += 1;
    } else if (text.charAt(index) === '}') {
      depth -= 1;
    } else if (text.charAt(index) === ',' && depth === 0) {
      return [text.slice(0, index), text.slice(index + 1)];
    }
  }
  return [text, ''];
};

/**
 * Expands the formats of a text as tmux does: an escape pair gives its one character, a comparison `#{==:a,b}` of two texts that
 * can hold formats gives `1` or `0`, and any other format gives the value of its key.
 */
const expandFormat = (format: string, valueOf: (key: string) => string): string => {
  let text = '';
  for (let index = 0; index < format.length; index += 1) {
    if (isEscapeAt(format, index)) {
      text += format.charAt(index + 1);
      index += 1;
      continue;
    }
    if (!format.startsWith('#{', index)) {
      text += format.charAt(index);
      continue;
    }
    const end = closingBrace(format, index + 2);
    if (end < 0) {
      text += format.slice(index);
      break;
    }
    const inner = format.slice(index + 2, end);
    if (inner.startsWith('==:')) {
      const [left, right] = splitComparison(inner.slice('==:'.length));
      text += expandFormat(left, valueOf) === expandFormat(right, valueOf) ? '1' : '0';
    } else {
      text += valueOf(inner);
    }
    index = end;
  }
  return text;
};

/** The shell text of a summon: a wait, one tmux call, and an optional `; true` after the call. The call is the lazy group. */
const SHELL_TEXT_PATTERN = /^sleep [0-9]+; tmux (.*?)( *; true)?$/s;

/** What the shell of a summon runs: the tmux call as an argument list, and whether `; true` comes after it. */
interface ShellText {
  readonly call: readonly string[];
  readonly endsWithTrue: boolean;
}

/**
 * Reads the shell text of a summon: `sleep N; tmux ...`, with an optional `; true`. A word in single quotes is one word.
 *
 * tmux `run-shell` expands the formats of its text before the shell gets it, in the context of the pane that ran the summon. That
 * pane has no summon mark, so the fake expands each format of a key to an empty text. A format that the text does not escape
 * (`##{` for `#{`) is gone before the wait starts, as with real tmux.
 */
const parseShellText = (shellText: string): ShellText => {
  const text = expandFormat(shellText, () => '');
  const match = SHELL_TEXT_PATTERN.exec(text);
  if (match === null) throw new Error('the text is not the shell text of a summon');
  const words: string[] = [];
  let word = '';
  let started = false;
  let quoted = false;
  for (const char of match[1] ?? '') {
    if (char === "'") {
      quoted = !quoted;
      started = true;
    } else if (char === ' ' && !quoted) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return { call: words, endsWithTrue: match[2] !== undefined };
};

/**
 * The tmux call inside the shell text of a summon, as an argument list, with no wait. A test runs this call at once, as the shell
 * would run it after the wait. The `; true` after the call is not part of the call.
 */
export const tmuxCallOfShellText = (shellText: string): readonly string[] => parseShellText(shellText).call;

/** A fake of the tmux program: it knows sessions, their home option, their windows and panes, and records every call. */
export const tmuxHandler = (
  fixture: TmuxFixture = {},
): { handler: RunHandler; log: TmuxLog; runShell: (shellText: string, from: string) => number } => {
  const calls: RunCall[] = [];
  const sessions = new Map<string, string | null>();
  const version = fixture.version === undefined ? 'tmux 3.4' : fixture.version;
  const endedCoordinators = new Set(fixture.endedCoordinators ?? []);
  /** The windows of each session, in order. */
  const windows = new Map<string, string[]>();
  const panes: FakePane[] = [];
  const layouts = new Map<string, string>();
  /** The id of the active pane of each window, by `session:window`. A window with no entry has its first pane active. */
  const activeIds = new Map<string, string>();
  /** The mode screens: the pane id and the text of the screen. */
  const modeScreens = new Map<string, string>();
  const runs: ShellRun[] = [];
  /** The splits of each window since its last `select-layout`, by `session:window`. */
  const splitsSinceTile = new Map<string, number>();

  const explicitIds = (fixture.panes ?? []).flatMap((pane) => (pane.id === undefined ? [] : [pane.id]));
  for (const id of explicitIds) {
    if (!isPaneId(id)) throw new Error(`the pane fixture has the id ${id}, which is not a pane id`);
  }
  if (new Set(explicitIds).size !== explicitIds.length) throw new Error('the pane fixture has the same pane id twice');
  let nextId = Math.max(-1, ...explicitIds.map((id) => Number(id.slice(1)))) + 1;
  let nextPid = FIRST_PID;

  const panesOfWindow = (session: string, window: string): FakePane[] =>
    panes.filter((pane) => pane.session === session && pane.window === window);

  /** The active pane of a window: the pane of the entry, or the first pane when the entry is gone or was never made. */
  const activeIn = (session: string, window: string): FakePane | undefined => {
    const inWindow = panesOfWindow(session, window);
    return inWindow.find((pane) => pane.id === activeIds.get(`${session}:${window}`)) ?? inWindow[0];
  };

  const makeActive = (pane: FakePane): void => {
    activeIds.set(`${pane.session}:${pane.window}`, pane.id);
  };

  const addPane = (session: string, window: string, more: PaneMore = {}): FakePane => {
    const names = windows.get(session) ?? [];
    if (!names.includes(window)) windows.set(session, [...names, window]);
    const pane: FakePane = {
      id: more.id ?? `%${nextId++}`,
      session,
      window,
      options: new Map(Object.entries(more.options ?? {})),
      pid: more.pid ?? nextPid++,
      dead: more.dead ?? false,
      cwd: more.cwd || null,
      command: more.command ?? [],
    };
    panes.push(pane);
    return pane;
  };

  const dropSession = (name: string): void => {
    sessions.delete(name);
    windows.delete(name);
    for (let index = panes.length - 1; index >= 0; index -= 1) if (panes[index]?.session === name) panes.splice(index, 1);
  };

  /** A window with no pane is gone, and a session with no window is gone. */
  const dropEmpty = (session: string): void => {
    const names = (windows.get(session) ?? []).filter((name) => panesOfWindow(session, name).length > 0);
    if (names.length === 0) dropSession(session);
    else windows.set(session, names);
  };

  const markCoordinatorEnded = (session: string): void => {
    endedCoordinators.add(session);
    const coordinator = panesOfWindow(session, tmuxNames.windowView)[0];
    if (coordinator !== undefined) coordinator.dead = true;
  };

  for (const [name, home] of Object.entries(fixture.sessions ?? {})) {
    sessions.set(name, home);
    // The marks that `start` sets: the node on the coordinator pane, and the board on the slot pane.
    addPane(name, tmuxNames.windowView, { options: { [tmuxNames.optionNode]: name } });
    addPane(name, tmuxNames.windowView, { options: { [tmuxNames.optionSlot]: tmuxNames.slotBoard } });
    addPane(name, tmuxNames.windowWorkers);
    if (endedCoordinators.has(name)) markCoordinatorEnded(name);
  }
  for (const { session, window, ...more } of fixture.panes ?? []) {
    if (!sessions.has(session)) throw new Error(`the pane fixture names the session ${session}, which is not in the fixture`);
    addPane(session, window ?? tmuxNames.windowWorkers, more);
  }

  const targetOf = (command: readonly string[]): string => after(command, '-t');

  const targetSession = (command: readonly string[]): string =>
    targetOf(command).replace(/^=/, '').split(':')[0] ?? '';

  /** A pane id, or a position in a window such as `=demo:view.{left}`. A position that holds no pane gives undefined. */
  const resolvePane = (target: string): FakePane | undefined => {
    if (isPaneId(target)) return panes.find((pane) => pane.id === target);
    const match = /^=?([^:]+):([^.]*)(?:\.(.+))?$/.exec(target);
    if (match === null) return undefined;
    const [, session = '', window = '', spec = ''] = match;
    const inWindow = panesOfWindow(session, window);
    if (spec === '' || spec === '{left}') return inWindow[0];
    if (spec === '{right}') return inWindow[1];
    return /^[0-9]+$/.test(spec) ? inWindow[Number(spec)] : undefined;
  };

  /** The window that a target names: a pane id gives the window of the pane, and `=session:window` names it. */
  const resolveWindow = (target: string): { readonly session: string; readonly window: string } | undefined => {
    if (isPaneId(target)) {
      const pane = panes.find((candidate) => candidate.id === target);
      return pane === undefined ? undefined : { session: pane.session, window: pane.window };
    }
    const session = target.replace(/^=/, '').split(':')[0] ?? '';
    const named = target.includes(':') ? (target.split(':')[1] ?? '').split('.')[0] ?? '' : '';
    const window = named === '' ? windows.get(session)?.[0] : named;
    return window !== undefined && (windows.get(session) ?? []).includes(window) ? { session, window } : undefined;
  };

  const valueOf = (key: string, pane: FakePane): string => {
    switch (key) {
      case 'pane_id':
        return pane.id;
      case 'pane_pid':
        return String(pane.pid);
      case 'pane_dead':
        return pane.dead ? '1' : '0';
      case 'pane_active':
        return activeIn(pane.session, pane.window) === pane ? '1' : '0';
      case 'pane_in_mode':
        return modeScreens.has(pane.id) ? '1' : '0';
      case 'pane_current_path':
        return pane.cwd ?? '';
      case 'pane_index':
        return String(panesOfWindow(pane.session, pane.window).indexOf(pane));
      case 'session_name':
        return pane.session;
      case 'window_name':
        return pane.window;
      default:
        return key.startsWith('@') ? (pane.options.get(key) ?? '') : '';
    }
  };

  /** Expands the formats of a text for a pane: a key of the pane, an escape pair, and a comparison `#{==:a,b}`. */
  const expand = (format: string, pane: FakePane): string => expandFormat(format, (key) => valueOf(key, pane));

  const printed = (command: readonly string[], pane: FakePane) =>
    command.includes('-P') ? exited(0, `${expand(after(command, '-F') || DEFAULT_LIST_FORMAT, pane)}\n`) : exited(0);

  const cantFindPane = (target: string) => exited(1, '', `can't find pane: ${target}\n`);

  const execute = (command: readonly string[]): ReturnType<RunHandler> => {
    const [word, ...rest] = command;
    if (word === '-V') return exited(0, `${version}\n`);
    if (word === fixture.failing) return exited(1, '', `${word} failed\n`);
    if (
      word !== undefined &&
      NEEDS_SESSION.has(word) &&
      !isPaneId(targetOf(command)) &&
      !sessions.has(targetSession(command))
    ) {
      return exited(1, '', "can't find session\n");
    }
    switch (word) {
      case 'has-session':
        return sessions.has(targetSession(command)) ? exited(0) : exited(1, '', "can't find session\n");
      case 'show-options':
        return exited(0, `${sessions.get(targetSession(command)) ?? ''}\n`);
      case 'display-message': {
        // A pane id as the target prints the format of that pane. Any other target is the coordinator pane of a session.
        if (isPaneId(targetOf(command))) {
          const pane = resolvePane(targetOf(command));
          return pane === undefined ? cantFindPane(targetOf(command)) : exited(0, `${expand(command.at(-1) ?? '', pane)}\n`);
        }
        return exited(0, `${endedCoordinators.has(targetSession(command)) ? 1 : 0}\n`);
      }
      case 'new-session': {
        const name = after(rest, '-s');
        if (sessions.has(name)) return exited(1, '', 'duplicate session\n');
        sessions.set(name, null);
        addPane(name, after(rest, '-n') || '0', { cwd: after(rest, '-c'), command: programOf(rest) });
        return exited(0);
      }
      case 'new-window': {
        const session = targetSession(command);
        const name = after(rest, '-n') || String((windows.get(session) ?? []).length);
        if ((windows.get(session) ?? []).includes(name)) return exited(1, '', `duplicate window: ${name}\n`);
        return printed(command, addPane(session, name, { cwd: after(rest, '-c'), command: programOf(rest) }));
      }
      case 'split-window': {
        const where = resolveWindow(targetOf(command));
        if (where === undefined) return exited(1, '', `can't find window: ${targetOf(command)}\n`);
        const splits = splitsSinceTile.get(`${where.session}:${where.window}`) ?? 0;
        if (fixture.splitsBeforeTile !== undefined && splits >= fixture.splitsBeforeTile) {
          return exited(1, '', 'no space for new pane\n');
        }
        splitsSinceTile.set(`${where.session}:${where.window}`, splits + 1);
        const pane = addPane(where.session, where.window, {
          cwd: after(rest, '-c'),
          command: programOf(rest),
          dead: fixture.newPanesEndAtOnce === true,
        });
        // Like tmux: the new pane gets the focus, unless the call has -d.
        if (!hasFlag(command, '-d')) makeActive(pane);
        return printed(command, pane);
      }
      case 'list-panes': {
        const wholeSession = command.includes('-s');
        const where = wholeSession ? undefined : resolveWindow(targetOf(command));
        if (!wholeSession && where === undefined) return exited(1, '', `can't find window: ${targetOf(command)}\n`);
        const session = where?.session ?? targetSession(command);
        const listed = (windows.get(session) ?? []).flatMap((window) =>
          where === undefined || where.window === window ? panesOfWindow(session, window) : [],
        );
        const format = after(command, '-F') || DEFAULT_LIST_FORMAT;
        return exited(0, listed.map((pane) => `${expand(format, pane)}\n`).join(''));
      }
      case 'set-option': {
        if (command.includes(tmuxNames.optionHome)) {
          sessions.set(targetSession(command), command.at(-1) ?? null);
        } else if (command.includes('-p')) {
          const pane = resolvePane(targetOf(command));
          if (pane === undefined && isPaneId(targetOf(command))) return cantFindPane(targetOf(command));
          if (command.includes('-u')) pane?.options.delete(command.at(-1) ?? '');
          else pane?.options.set(command.at(-2) ?? '', command.at(-1) ?? '');
        }
        return exited(0);
      }
      case 'select-layout': {
        const where = resolveWindow(targetOf(command));
        if (where === undefined) return exited(1, '', `can't find window: ${targetOf(command)}\n`);
        layouts.set(`${where.session}:${where.window}`, command.at(-1) ?? '');
        splitsSinceTile.delete(`${where.session}:${where.window}`);
        return exited(0);
      }
      case 'if-shell': {
        // Only the form that tmux runs without a shell: a format as the condition (`-F`), then the command, then an optional else command.
        if (!command.includes('-F')) return exited(1, '', 'the fake runs only if-shell with -F\n');
        const pane = resolvePane(targetOf(command));
        if (pane === undefined) return cantFindPane(targetOf(command));
        const texts: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          const word = rest[index] ?? '';
          if (word === '-t') index += 1;
          else if (!word.startsWith('-')) texts.push(word);
        }
        const [condition = '', thenText = '', elseText] = texts;
        const value = expand(condition, pane);
        const branch = value !== '' && value !== '0' ? thenText : elseText;
        let result = exited(0);
        for (const next of chainOf((branch ?? '').split(/\s+/).filter((word) => word !== ''))) {
          result = execute(next);
          if (!result.ok || result.value.exitCode !== 0) return result;
        }
        return result;
      }
      case 'kill-pane': {
        const pane = resolvePane(targetOf(command));
        if (pane === undefined) return cantFindPane(targetOf(command));
        panes.splice(panes.indexOf(pane), 1);
        dropEmpty(pane.session);
        return exited(0);
      }
      case 'swap-pane': {
        const source = resolvePane(after(rest, '-s'));
        const target = resolvePane(targetOf(command));
        if (source === undefined) return cantFindPane(after(rest, '-s'));
        if (target === undefined) return cantFindPane(targetOf(command));
        const [sourceActive, targetActive] = [activeIn(source.session, source.window), activeIn(target.session, target.window)];
        const [session, window] = [source.session, source.window];
        [source.session, source.window] = [target.session, target.window];
        [target.session, target.window] = [session, window];
        const [from, to] = [panes.indexOf(source), panes.indexOf(target)];
        [panes[from], panes[to]] = [target, source];
        // The focus, as in the source of tmux. Without -d, each window gives the focus to the pane that came into it. With -d, a
        // window keeps the focus on its place: the pane that took the place of the active pane gets it, and no other pane gets it.
        if (hasFlag(command, '-d')) {
          if (sourceActive === source) makeActive(target);
          if (targetActive === target) makeActive(source);
        } else {
          makeActive(target);
          makeActive(source);
        }
        return exited(0);
      }
      case 'select-pane': {
        const pane = resolvePane(targetOf(command));
        if (pane === undefined) return cantFindPane(targetOf(command));
        makeActive(pane);
        return exited(0);
      }
      case 'kill-session':
        dropSession(targetSession(command));
        return exited(0);
      default:
        return exited(0);
    }
  };

  const handler: RunHandler = (call) => {
    calls.push(call);
    if (call.command !== 'tmux' || version === null) return missingProgram(call.command);
    const chain = chainOf(call.args);
    let result = exited(0);
    for (const command of chain) {
      result = execute(command);
      if (!result.ok || result.value.exitCode !== 0) return result;
    }
    const created = chain.find((command) => command[0] === 'new-session');
    if (fixture.programEndsAtOnce === true && created !== undefined) {
      const name = created[created.indexOf('-s') + 1] ?? '';
      if (chain.some(keepsPaneOnExit)) markCoordinatorEnded(name);
      else dropSession(name);
    }
    return result;
  };

  /**
   * Runs the shell text of a `run-shell` call as its shell runs it after the wait: the tmux call of the text, then `true` when the
   * text ends with `; true`. The exit code of the shell is the code of its last command. Like tmux, a code other than 0 puts the
   * pane that ran `run-shell` (`from`, a pane id) in view mode, with a screen that names the text and the code. A pane that is
   * gone shows nothing. The result is the exit code of the shell.
   */
  const runShell = (shellText: string, from: string): number => {
    const { call, endsWithTrue } = parseShellText(shellText);
    const result = handler({ command: 'tmux', args: call, cwd: undefined });
    const callCode = result.ok ? result.value.exitCode : 1;
    const exitCode = endsWithTrue ? 0 : callCode;
    runs.push({ text: shellText, exitCode });
    if (exitCode !== 0 && panes.some((pane) => pane.id === from)) {
      modeScreens.set(from, `'${shellText}' returned ${exitCode}`);
    }
    return exitCode;
  };

  return {
    handler,
    runShell,
    log: {
      calls,
      commands: () => calls.map((call) => `${call.command === 'tmux' ? '' : `${call.command} `}${call.args.join(' ')}`),
      sessions: () => sessions,
      layouts: () => Object.fromEntries(layouts),
      activePane: (session, window) => activeIn(session, window)?.id,
      modes: () => Object.fromEntries([...modeScreens].filter(([id]) => panes.some((pane) => pane.id === id))),
      shellRuns: () => runs,
      panes: () =>
        panes.map((pane) => ({
          id: pane.id,
          session: pane.session,
          window: pane.window,
          options: Object.fromEntries(pane.options),
          pid: pane.pid,
          dead: pane.dead,
          cwd: pane.cwd,
          command: pane.command,
        })),
    },
  };
};
