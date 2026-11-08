import { join } from 'node:path';
import type { CliError, CliResult } from '../cli/errors.js';
import { detectStyle, displayLine, printable, type CommandOutput, type OutLine, type Style } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { files, followPollMs, maxDisplayWidth } from '../names.js';
import type { Layout } from '../state/layout.js';

/**
 * The follow loop of `item list --follow`: it draws the list of the board, and draws it again when the board file changes. It runs
 * until its reader goes, and it has no time limit. The end conditions are the signals SIGHUP and SIGTERM, a failed write to stdout,
 * a change of the parent process and a stdout that is not a terminal. Each tick checks the last three before it reads anything.
 * The time and the wait come from the deps, so a test runs the loop on a fake clock.
 */

/** The signals that end the loop. A handler for a signal replaces its default end of the process, so the loop removes its handlers. */
const END_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGTERM'];

/** Move the cursor to the top left. Erase to the end of a line. Erase from the cursor to the end of the screen. */
const CURSOR_HOME = '\x1b[H';
const ERASE_LINE = '\x1b[K';
const ERASE_BELOW = '\x1b[J';

/**
 * The text that the loop writes at each tick to see that its reader is there. It resets the text style, so it changes nothing on
 * the screen. A write of no text makes no system call and would never fail, so the check needs a text with a length.
 */
const READER_CHECK = '\x1b[0m';

export interface FollowInput {
  readonly layout: Layout;
  /** One draw of the view: the lines of the board as they are now. A fault of the board is an error, and the loop shows it. */
  readonly draw: () => Promise<CliResult<CommandOutput>>;
}

/** The lines for a draw that failed: the message of the fault, and its remedy line when it has one. */
const faultLines = (error: CliError): readonly OutLine[] => [
  { level: 'fail', text: displayLine(error.message, maxDisplayWidth) },
  ...(error.hint === undefined ? [] : [{ level: 'text' as const, text: displayLine(error.hint, maxDisplayWidth) }]),
];

const rowsOf = (lines: readonly OutLine[], style: Style): readonly string[] =>
  lines.map((line) => style.paint(line.level, printable(line.text)));

/**
 * The text of one frame. On a terminal the frame starts at the top left and each line erases the rest of its row, so a frame
 * that is shorter than the one before leaves nothing behind. Any other stdout gets the plain lines.
 */
const frameText = (rows: readonly string[], terminal: boolean): string =>
  terminal ? `${CURSOR_HOME}${rows.map((row) => `${row}${ERASE_LINE}\n`).join('')}${ERASE_BELOW}` : rows.map((row) => `${row}\n`).join('');

/**
 * What the loop compares between two ticks: the time of the last change and the size of the file. A file that is not there, and a
 * status that can not be read, have a value of their own, so each change to or from them draws the fault or the board.
 */
const signatureOf = async (deps: Deps, path: string): Promise<string> => {
  const info = await deps.fs.statInfo(path);
  if (!info.ok) return `fault ${info.error.message}`;
  return info.value === null ? 'absent' : `${info.value.mtimeMs}:${info.value.size}`;
};

/**
 * Draw the list, and draw it again after each change of the board file, until the reader goes. A fault of the board does not end
 * the loop: the frame shows the fault until the next change. The first draw is the exception for a usage error (a flag that names
 * a track that is not there): the call returns it, and nothing is drawn. Every other end is a value with no error, because nobody is
 * left to read an error.
 */
export const followBoard = async (deps: Deps, input: FollowInput): Promise<CliResult<void>> => {
  const boardPath = join(input.layout.stateDir, files.board);
  const parent = deps.parentPid();
  let stopped = false;
  let wake: () => void = () => undefined;
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const onSignal = (): void => {
    stopped = true;
    wake();
  };

  const readerGone = (): boolean => deps.parentPid() !== parent || !deps.stdoutIsTerminal();
  const ending = (): boolean => stopped || readerGone();

  /** Write one frame. The value is false when the write failed: the reader is gone. */
  const show = async (drawn: CliResult<CommandOutput>): Promise<boolean> => {
    const terminal = deps.stdoutIsTerminal();
    const rows = rowsOf(drawn.ok ? drawn.value.lines : faultLines(drawn.error), detectStyle(deps.env, terminal, false));
    return (await deps.writeStdout(frameText(rows, terminal))).ok;
  };

  const run = async (): Promise<CliResult<void>> => {
    // The status is read before the text, so a change between the two reads shows again at the next tick.
    let seen = await signatureOf(deps, boardPath);
    const first = await input.draw();
    if (!first.ok && first.error.kind === 'usage') return first;
    if (!(await show(first))) return ok(undefined);
    while (!ending()) {
      await Promise.race([deps.sleep(followPollMs), woken]);
      if (ending()) break;
      if (!(await deps.writeStdout(READER_CHECK)).ok) break;
      const now = await signatureOf(deps, boardPath);
      if (now === seen) continue;
      seen = now;
      if (!(await show(await input.draw()))) break;
    }
    return ok(undefined);
  };

  for (const signal of END_SIGNALS) deps.signals.on(signal, onSignal);
  try {
    return await run();
  } finally {
    for (const signal of END_SIGNALS) deps.signals.off(signal, onSignal);
  }
};
