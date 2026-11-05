import { failure, notReady, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { capturePaneArgs, chainedArgs, isPaneId, type TmuxArgs } from '../launch/tmux.js';
import { tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { typing } from '../names.js';

/**
 * The tmux input verb. This module is the one place in the source that holds an input verb, and a unit test keeps the verbs out
 * of every other module. A caller passes one of the lines `typing.lines`. The module refuses any text that `lineProblem` does
 * not allow, so a wrong call can type nothing else.
 */
const SEND_KEYS = 'send-keys';

/** The signs from space to tilde: the printable ASCII signs, with no control sign and no new line. */
const PRINTABLE = /^[ -~]+$/;

const TRAILING_RETURN = /\r$/;

/** The reason that a line is not allowed, or null. A final semicolon would end the tmux command and start another one. */
const lineProblem = (line: string): string | null => {
  if (line === '') return 'is empty';
  if (!PRINTABLE.test(line)) return 'has a sign that is not a printable ASCII sign';
  if (line.length > typing.maxChars) return `has more than ${typing.maxChars} signs`;
  if (line.endsWith(';')) return 'ends with a semicolon';
  return null;
};

/** One call of the input verb for one pane. The target is the pane id, and the words are key names or the text. */
const sendWords = (pane: string, ...words: readonly string[]): readonly string[] => [SEND_KEYS, '-t', pane, ...words];

/** The clean-up call: it clears the input line of the pane. */
const clearArgs = (pane: string): TmuxArgs => chainedArgs([sendWords(pane, typing.keys.clearLine)]);

/** Clear the input line, type the text as it is, end the line. One tmux run, so no other input comes between the three calls. */
const typeArgs = (pane: string, line: string): TmuxArgs =>
  chainedArgs([
    sendWords(pane, typing.keys.clearLine),
    sendWords(pane, '-l', '--', line),
    sendWords(pane, typing.keys.enter),
  ]);

/**
 * The bottom lines of a screen: the last `typing.captureLines` lines that are left after the empty lines at the end are cut. A
 * dialog can stand in the upper part of a tall pane, with empty rows below it.
 */
const bottomLines = (screen: string): readonly string[] => {
  const lines = screen.split('\n').map((line) => line.replace(TRAILING_RETURN, ''));
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(Math.max(0, end - typing.captureLines), end);
};

/**
 * True when the bottom lines hold a list of choices of a dialog: one line starts with a pointer, then digits and a dot, and
 * another line starts with digits and a dot. A pointer line never starts with a digit, so the two lines are two lines. A numbered
 * list with no pointer line, for example the end of an answer, is no dialog.
 */
const showsChoiceList = (screen: string): boolean => {
  const lines = bottomLines(screen);
  return (
    lines.some((line) => typing.optionList.pointerLine.test(line)) &&
    lines.some((line) => typing.optionList.numberedLine.test(line))
  );
};

/**
 * Types one line into a pane and ends it with Enter. The checks run in this order, and a refusal types nothing:
 * the line (printable ASCII, at most `typing.maxChars` signs, no final semicolon) and the pane id, which are exit 1;
 * one capture of the screen, which is the last read before the keys, and it is exit 1 when it fails (also for a pane that
 * does not exist); a screen that shows a list of choices, which is exit 3, because a dialog may take the keys.
 * The keys go in one tmux run. If the run fails, exactly one clean-up call clears the input line, and the result is exit 1.
 * A dialog that opens after the capture and before the keys is not seen.
 */
export const typeLine = async (deps: Deps, pane: string, line: string): Promise<CliResult<void>> => {
  const problem = lineProblem(line);
  if (problem !== null) return failure(`the line to type is refused: it ${problem}`);
  if (!isPaneId(pane)) return failure('the target of the typed line is not a pane id');
  const capture = capturePaneArgs(pane);
  if (!capture.ok) return failure(capture.error);

  const screen = await tmuxStep(deps, capture.value);
  if (!screen.ok) return screen;
  if (showsChoiceList(screen.value)) {
    return notReady(
      `the pane ${pane} shows a numbered list of choices, so a dialog may wait there`,
      `Look at pane ${pane} and answer the dialog there. Then type the line again.`,
    );
  }

  const typed = await tmuxStep(deps, typeArgs(pane, line));
  if (typed.ok) return ok(undefined);
  const cleaned = await tmuxCall(deps, clearArgs(pane));
  if (cleaned.ok && cleaned.value.exitCode === 0) return typed;
  return failure(`${typed.error.message}; the input line of pane ${pane} may still hold text`);
};
