import { tmuxNames } from '../../src/names.js';
import { exited, missingProgram, type RunCall, type RunHandler } from './fake-deps.js';

export interface TmuxFixture {
  /** The text that `tmux -V` prints. Null means that tmux is not installed. Default: `tmux 3.4`. */
  readonly version?: string | null;
  /** Sessions that run already, by name. The value is the node home in the session option, or null for no option. */
  readonly sessions?: Readonly<Record<string, string | null>>;
  /** The first word of a tmux command that fails with exit code 1. */
  readonly failing?: string;
  /** Sessions whose coordinator program has ended. The pane stays, because of remain-on-exit. */
  readonly endedCoordinators?: readonly string[];
  /**
   * The program of a new session ends at once. Like tmux, the fake then ends the session too, unless the same call sets
   * remain-on-exit for the window. With remain-on-exit the session stays, and its coordinator counts as ended.
   */
  readonly programEndsAtOnce?: boolean;
}

export interface TmuxLog {
  readonly calls: RunCall[];
  /** The tmux commands as one line each, for example `has-session -t =demo`. A command chain keeps its `;` words. */
  commands(): string[];
  /** The sessions that run now, with the node home of their option. */
  sessions(): Map<string, string | null>;
}

/** The commands that fail for a session that does not exist. */
const NEEDS_SESSION = new Set([
  'set-environment',
  'set-option',
  'split-window',
  'new-window',
  'switch-client',
  'kill-session',
  'display-message',
]);

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

/** A fake of the tmux program: it knows sessions and their home option, and records every call. */
export const tmuxHandler = (fixture: TmuxFixture = {}): { handler: RunHandler; log: TmuxLog } => {
  const calls: RunCall[] = [];
  const sessions = new Map<string, string | null>(Object.entries(fixture.sessions ?? {}));
  const version = fixture.version === undefined ? 'tmux 3.4' : fixture.version;
  const endedCoordinators = new Set(fixture.endedCoordinators ?? []);

  const targetSession = (args: readonly string[]): string => {
    const target = args[args.indexOf('-t') + 1] ?? '';
    return target.replace(/^=/, '').split(':')[0] ?? '';
  };

  const execute = (command: readonly string[]) => {
    const [word, ...rest] = command;
    if (word === '-V') return exited(0, `${version}\n`);
    if (word === fixture.failing) return exited(1, '', `${word} failed\n`);
    if (word !== undefined && NEEDS_SESSION.has(word) && !sessions.has(targetSession(command))) {
      return exited(1, '', "can't find session\n");
    }
    switch (word) {
      case 'has-session':
        return sessions.has(targetSession(command)) ? exited(0) : exited(1, '', "can't find session\n");
      case 'show-options':
        return exited(0, `${sessions.get(targetSession(command)) ?? ''}\n`);
      case 'display-message':
        return exited(0, `${endedCoordinators.has(targetSession(command)) ? 1 : 0}\n`);
      case 'new-session': {
        const name = rest[rest.indexOf('-s') + 1] ?? '';
        if (sessions.has(name)) return exited(1, '', 'duplicate session\n');
        sessions.set(name, null);
        return exited(0);
      }
      case 'set-option':
        if (command.includes(tmuxNames.optionHome)) {
          sessions.set(targetSession(command), command.at(-1) ?? null);
        }
        return exited(0);
      case 'kill-session':
        sessions.delete(targetSession(command));
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
      if (chain.some(keepsPaneOnExit)) endedCoordinators.add(name);
      else sessions.delete(name);
    }
    return result;
  };
  return {
    handler,
    log: {
      calls,
      commands: () => calls.map((call) => `${call.command === 'tmux' ? '' : `${call.command} `}${call.args.join(' ')}`),
      sessions: () => sessions,
    },
  };
};
