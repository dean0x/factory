import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withoutTmux, type Sandbox } from './harness.js';

/**
 * A fake terminal for the tests of a command that asks questions. The program `script` that comes with the OS gives the command
 * a pseudo terminal on its standard input, output and error. The helper answers each prompt once the prompt shows, and it fails
 * at once for a prompt that it does not know. It runs with the environment of the sandbox only, and it drops TMUX as `box.run` does.
 *
 * The standard input of `script` is an anonymous pipe from `cat`, not the pipe of `spawn`: that pipe is a socket, and the BSD
 * `script` stops with "Operation not supported on socket" when its standard input is a socket. The kernel of macOS builds a
 * FIFO on a socket, so a FIFO does not help. A pipe of the shell answers ENOTTY, and `script` goes on without a terminal.
 */

/** The two forms of the program `script`: the one of BSD and macOS, and the one of util-linux. */
export type ScriptForm = 'bsd' | 'util-linux';

/** The form of `script` for a platform, or null where the tests know none. */
export const scriptForm = (platform: NodeJS.Platform = process.platform): ScriptForm | null => {
  if (platform === 'darwin') return 'bsd';
  if (platform === 'linux') return 'util-linux';
  return null;
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** True when a folder of the search path holds an executable `script`. It reads the PATH of the test process only. */
export const hasScript = (searchPath: string = process.env['PATH'] ?? ''): boolean =>
  searchPath.split(delimiter).some((folder) => folder !== '' && isExecutable(join(folder, 'script')));

/**
 * What a file of tests does with the fake terminal: `run`, or `skip` when `script` is missing on a machine of a person, or `fail`
 * when it is missing and the variable CI is set. This is the only place that reads CI.
 */
export const scriptGate = (): 'run' | 'skip' | 'fail' => {
  if (scriptForm() !== null && hasScript()) return 'run';
  return (process.env['CI'] ?? '') === '' ? 'skip' : 'fail';
};

export interface Exchange {
  /** Matches the text that the program showed after the last matched prompt, with each run of white space cut to one space. */
  readonly prompt: RegExp;
  /** The line to write, or a function that gets the text shown since the last prompt and returns the line. It throws to stop the run. */
  readonly answer: string | ((shown: string) => string);
}

export interface TerminalOptions {
  /** The working folder of the command. The default is the root of the sandbox. */
  readonly cwd?: string;
  /** More variables for the command. HOME must stay inside the sandbox root. */
  readonly env?: Readonly<Record<string, string>>;
  /** The prompts in the order that the program shows them, and the answer to each. */
  readonly exchanges?: readonly Exchange[];
  /** The longest wait for one prompt. The wait for the first prompt starts when the command starts: its line `PID:` shows. */
  readonly promptMs?: number;
  /** The longest time of the whole run. */
  readonly totalMs?: number;
}

export interface TerminalResult {
  /** The exit code of the command, read from the EXIT line. */
  readonly code: number;
  /** All that the command showed, without escape sequences and without carriage returns. */
  readonly screen: string;
}

const PROMPT_MS = 15_000;
const TOTAL_MS = 90_000;
/** The step of the loop that reads the screen. */
const STEP_MS = 25;
/** Output that ends in a prompt shape and stays the same for this long is a prompt that the helper does not know. */
const QUIET_MS = 500;
const END_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;
/** The most characters of output that a run reads before it fails. */
const MAX_OUTPUT_CHARS = 1_000_000;
/** The most characters of the screen that an error shows: the end of the screen. */
const ERROR_SCREEN_CHARS = 4_000;

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** A sequence that the chunk cut off at its end: the next chunk finishes it, so it is not part of the screen yet. */
const CUT_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007]*)?$/;
const ESCAPE_PAIR = /\u001b[@-Z\\-_]/g;
const PROMPT_SHAPE = /[:?\]] ?$/;
const PID_LINE = /(?:^|\n)PID:(\d+)\n/;
const EXIT_LINE = /(?:^|\n)EXIT:(\d+)\n/;

const clean = (raw: string): string =>
  raw.replace(OSC, '').replace(CSI, '').replace(CUT_ESCAPE, '').replace(ESCAPE_PAIR, '').replace(/\r/g, '');

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

/** One word of a shell string: in single quotes, each single quote written as '\'' . */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Wait for `done`, at most `ms`. The timer is cleared, so no timer stays after the wait. */
const settledWithin = async (done: Promise<void>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([done, new Promise<void>((finish) => (timer = setTimeout(finish, ms)))]);
  } finally {
    clearTimeout(timer);
  }
};

/** Kill a process group. Only an integer above 1 is a group: 0, 1 and -1 would reach other processes. A group that is gone is no fault. */
const killGroup = (group: number | null | undefined): void => {
  if (group === null || group === undefined || !Number.isInteger(group) || group <= 1) return;
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

/** Kill each process group, also after a kill that failed. Returns the first failure, or null when every kill worked. */
const killGroups = (groups: readonly (number | null | undefined)[]): Error | null => {
  let first: Error | null = null;
  for (const group of groups) {
    try {
      killGroup(group);
    } catch (error) {
      first ??= error as Error;
    }
  }
  return first;
};

/** The process group of the command: the number of the line `PID:` that the shell under `script` writes first. */
const groupFrom = (text: string): number | null => {
  const marked = PID_LINE.exec(text);
  return marked === null ? null : Number(marked[1]);
};

const insideRoot = (root: string, path: string | undefined): boolean => {
  if (path === undefined || path === '') return false;
  const below = relative(resolve(root), resolve(path));
  return below !== '' && !isAbsolute(below) && below.split(sep)[0] !== '..';
};

const scriptArguments = (form: ScriptForm, shell: string): readonly string[] =>
  form === 'bsd' ? ['-q', '/dev/null', '/bin/sh', '-c', shell] : ['-q', '-e', '-c', shell, '/dev/null'];

/**
 * The program that `spawn` starts: a shell with the pipeline `cat | script <arguments>`. `cat` reads the pipe of `spawn` and
 * writes to the pipe of the shell, and that pipe is the standard input of `script`.
 */
const PIPELINE = ['/bin/sh', '-c', '/bin/cat | script "$@"', 'sh'] as const;

/**
 * Run a command in a fake terminal and answer its prompts. `words` is the whole command: the program and its arguments, for
 * example `[process.execPath, DIST, 'init']`. The run is done at the line `EXIT:<code>` that the shell writes after the command.
 * The returned promise is rejected, with the screen in the error, for a prompt that no exchange names, a wait that is too
 * long, an exit before the last prompt, or HOME outside the sandbox.
 *
 * Each end of the run, also a failed one, kills the process group of `sh`, `cat` and `script`, and the process group of the shell
 * under `script` and the command (a command that leaves its group is not reached). The group of the command is known from the
 * line `PID:`, and the helper reads that line again after the kills, so a line that came after the last read of the loop counts. A
 * kill that fails does not stop the other kills or the bounded wait. Its error is thrown only when the run itself did not fail:
 * the error of the run is the one that the caller sees.
 */
export const runInTerminal = async (
  box: Sandbox,
  words: readonly string[],
  options: TerminalOptions = {},
): Promise<TerminalResult> => {
  const form = scriptForm();
  if (form === null) throw new Error(`fake terminal: no form of script is known for ${process.platform}`);
  if (words.length === 0) throw new Error('fake terminal: the command has no words');
  const env = withoutTmux({ ...box.env, ...options.env, SHELL: '/bin/sh', TERM: 'dumb' });
  if (!insideRoot(box.root, env['HOME'])) {
    throw new Error(`fake terminal: HOME (${env['HOME'] ?? 'unset'}) is not inside the sandbox root ${box.root}`);
  }
  const exchanges = options.exchanges ?? [];
  const promptMs = options.promptMs ?? PROMPT_MS;
  const totalMs = options.totalMs ?? TOTAL_MS;
  const matchers = exchanges.map((exchange) => new RegExp(exchange.prompt.source, exchange.prompt.flags.replace(/[gy]/g, '')));
  // The marker starts on a new line, also for a command whose last output has no line end.
  const shell = `echo "PID:$$"; ${words.map(quote).join(' ')}; printf '\\nEXIT:%s\\n' "$?"`;

  const [shellProgram, ...shellArguments] = PIPELINE;
  const child = spawn(shellProgram, [...shellArguments, ...scriptArguments(form, shell)], {
    cwd: options.cwd ?? box.root,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // One object: the handlers below change it, and a plain `let` would keep the type of its first value in the loop.
  const seen: { raw: string; changedAt: number; spawnError: Error | null; closed: boolean } = {
    raw: '',
    changedAt: Date.now(),
    spawnError: null,
    closed: false,
  };
  const collect = (chunk: string): void => {
    seen.raw += chunk;
    seen.changedAt = Date.now();
  };
  for (const pipe of [child.stdout, child.stderr]) {
    pipe.setEncoding('utf8');
    pipe.on('data', collect);
  }
  // A program that ends before it reads an answer closes the pipe, and the write then fails. That is no fault of the helper.
  child.stdin.on('error', () => undefined);
  child.once('error', (error) => {
    seen.spawnError = error;
  });
  const closed = new Promise<void>((done) =>
    child.once('close', () => {
      seen.closed = true;
      done();
    }),
  );

  const fail = (reason: string): never => {
    throw new Error(`fake terminal: ${reason}\nscreen (end):\n${clean(seen.raw).slice(-ERROR_SCREEN_CHARS)}`);
  };

  let commandGroup: number | null = null;
  let failed = false;
  try {
    let cursor = 0;
    let next = 0;
    // The wait for a prompt starts when the command starts (its PID line shows), and again after each answer.
    let promptSince: number | null = null;
    // The step count is the fixed upper bound, and the deadline in wall time is the limit: a late timer makes a step longer.
    const deadline = Date.now() + totalMs;
    const steps = Math.ceil(totalMs / STEP_MS);
    for (let step = 0; step < steps && Date.now() < deadline; step += 1) {
      await sleep(STEP_MS);
      if (seen.spawnError !== null) return fail(`the program script did not start: ${seen.spawnError.message}`);
      if (seen.raw.length > MAX_OUTPUT_CHARS) return fail(`the command wrote more than ${MAX_OUTPUT_CHARS} characters`);
      const text = clean(seen.raw);
      if (commandGroup === null) {
        commandGroup = groupFrom(text);
        if (commandGroup !== null) promptSince = Date.now();
      }
      const ended = EXIT_LINE.exec(text);
      if (ended !== null) {
        const pending = exchanges[next];
        if (pending !== undefined) return fail(`the command ended before the prompt ${pending.prompt}`);
        child.stdin.end();
        await settledWithin(closed, END_WAIT_MS);
        return { code: Number(ended[1]), screen: clean(seen.raw) };
      }
      if (seen.closed) return fail('the program script ended before the command wrote its EXIT line');
      const shown = text.slice(cursor);
      const expected = exchanges[next];
      const matcher = matchers[next];
      if (expected !== undefined && matcher !== undefined) {
        const collapsed = collapse(shown);
        if (matcher.test(collapsed)) {
          let line: string;
          try {
            line = typeof expected.answer === 'string' ? expected.answer : expected.answer(collapsed);
          } catch (error) {
            return fail(`the answer to the prompt ${expected.prompt} stopped the run: ${(error as Error).message}`);
          }
          child.stdin.write(`${line}\r`);
          next += 1;
          cursor = text.length;
          promptSince = Date.now();
          continue;
        }
        if (promptSince !== null && Date.now() - promptSince > promptMs) {
          return fail(`the prompt ${expected.prompt} did not show in ${promptMs} ms`);
        }
      }
      if (PROMPT_SHAPE.test(shown) && Date.now() - seen.changedAt >= QUIET_MS) {
        return fail(`the command shows a prompt that no exchange names (${collapse(shown).trim().slice(-200)})`);
      }
    }
    return fail(`the command did not end in ${totalMs} ms`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let fault = killGroups([commandGroup, child.pid]);
    await settledWithin(closed, KILL_WAIT_MS);
    // The pipes are read to their end now, so a PID line that came after the last read of the loop is known.
    if (commandGroup === null) fault ??= killGroups([groupFrom(clean(seen.raw))]);
    if (fault !== null && !failed) throw fault;
  }
};
