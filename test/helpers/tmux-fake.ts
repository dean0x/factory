import { tmuxNames } from '../../src/names.js';
import { exited, missingProgram, type RunCall, type RunHandler } from './fake-deps.js';

export interface TmuxFixture {
  /** The text that `tmux -V` prints. Null means that tmux is not installed. Default: `tmux 3.4`. */
  readonly version?: string | null;
  /** Sessions that run already, by name. The value is the node home in the session option, or null for no option. */
  readonly sessions?: Readonly<Record<string, string | null>>;
  /** The first word of a tmux command that fails with exit code 1. */
  readonly failing?: string;
}

export interface TmuxLog {
  readonly calls: RunCall[];
  /** The tmux commands as one line each, for example `has-session -t =demo`. */
  commands(): string[];
  /** The sessions that run now, with the node home of their option. */
  sessions(): Map<string, string | null>;
}

/** A fake of the tmux program: it knows sessions and their home option, and records every call. */
export const tmuxHandler = (fixture: TmuxFixture = {}): { handler: RunHandler; log: TmuxLog } => {
  const calls: RunCall[] = [];
  const sessions = new Map<string, string | null>(Object.entries(fixture.sessions ?? {}));
  const version = fixture.version === undefined ? 'tmux 3.4' : fixture.version;

  const targetSession = (args: readonly string[]): string => {
    const target = args[args.indexOf('-t') + 1] ?? '';
    return target.replace(/^=/, '').split(':')[0] ?? '';
  };

  const handler: RunHandler = (call) => {
    calls.push(call);
    if (call.command !== 'tmux' || version === null) return missingProgram(call.command);
    const [word, ...rest] = call.args;
    if (word === '-V') return exited(0, `${version}\n`);
    if (word === fixture.failing) return exited(1, '', `${word} failed\n`);
    switch (word) {
      case 'has-session':
        return sessions.has(targetSession(call.args)) ? exited(0) : exited(1, '', "can't find session\n");
      case 'show-options':
        return exited(0, `${sessions.get(targetSession(call.args)) ?? ''}\n`);
      case 'new-session': {
        const name = rest[rest.indexOf('-s') + 1] ?? '';
        if (sessions.has(name)) return exited(1, '', 'duplicate session\n');
        sessions.set(name, null);
        return exited(0);
      }
      case 'set-option':
        if (call.args.includes(tmuxNames.optionHome)) {
          sessions.set(targetSession(call.args), call.args.at(-1) ?? null);
        }
        return exited(0);
      case 'kill-session':
        sessions.delete(targetSession(call.args));
        return exited(0);
      default:
        return exited(0);
    }
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
