import { failure, notReady, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { capturePaneArgs, chainedArgs, isPaneId, paneModeArgs, parsePaneMode, type TmuxArgs } from '../launch/tmux.js';
import { tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { typing } from '../names.js';

/**
 * The tmux input verb. This module is the one place in the source that holds an input verb, and a unit test keeps the verbs out
 * of every other module. A caller passes one of the lines `typing.lines`, and the module types no other text: a line that is not
 * one of them is refused before any tmux call. `lineProblem` is a second check on the line, so a change of the fixed lines can
 * never allow a line with a control sign, a new line or a final semicolon.
 */
const SEND_KEYS = 'send-keys';

/** One of the fixed lines that the module types. */
export type TypedLine = (typeof typing.lines)[keyof typeof typing.lines];

const FIXED_LINES: readonly string[] = Object.values(typing.lines);

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
 * Reads whether the pane is in a mode of tmux, for example the copy mode. The keys of a pane in a mode go to the mode, not to the
 * session. A failed read, and an answer with no text (tmux has no such pane), are exit 1. Only the answer `0` passes, and any other
 * answer is exit 3.
 */
const requireNoMode = async (deps: Deps, pane: string, thenAgain: string): Promise<CliResult<void>> => {
  const read = paneModeArgs(pane);
  if (!read.ok) return failure(read.error);
  const answer = await tmuxStep(deps, read.value);
  if (!answer.ok) return answer;
  const mode = parsePaneMode(answer.value);
  switch (mode) {
    case 'none':
      return ok(undefined);
    case 'absent':
      return failure(`the mode of the pane ${pane} cannot be read: tmux has no such pane`);
    case 'active':
      return notReady(
        `the pane ${pane} is in a mode of tmux, so the keys would not reach the session`,
        `Press q in pane ${pane} to leave the mode. ${thenAgain}`,
      );
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
};

/**
 * Types one of the fixed lines into a pane and ends it with Enter. `thenAgain` is the clause that ends each remedy of an exit 3,
 * and it names the command that the caller runs again. The checks run in this order, and a refusal types nothing:
 * the line (one of `typing.lines`, then printable ASCII, at most `typing.maxChars` signs, no final semicolon) and the pane id, which
 * are exit 1; one read of the mode of the pane, which is exit 1 when it fails and exit 3 for a pane in a mode of tmux, because the
 * keys would not reach the session; one capture of the screen, which is the last read before the keys, and it is exit 1 when it
 * fails (also for a pane that does not exist); a screen that shows a list of choices, which is exit 3, because a dialog may take the
 * keys. The keys go in one tmux run. If the run fails, exactly one clean-up call clears the input line, and the result is exit 1.
 * A mode or a dialog that opens after its read and before the keys is not seen.
 */
export const typeLine = async (deps: Deps, pane: string, line: TypedLine, thenAgain: string): Promise<CliResult<void>> => {
  if (!FIXED_LINES.includes(line)) return failure('the line to type is refused: it is not one of the fixed lines');
  const problem = lineProblem(line);
  if (problem !== null) return failure(`the line to type is refused: it ${problem}`);
  if (!isPaneId(pane)) return failure('the target of the typed line is not a pane id');
  const noMode = await requireNoMode(deps, pane, thenAgain);
  if (!noMode.ok) return noMode;
  const capture = capturePaneArgs(pane);
  if (!capture.ok) return failure(capture.error);

  const screen = await tmuxStep(deps, capture.value);
  if (!screen.ok) return screen;
  if (showsChoiceList(screen.value)) {
    return notReady(
      `the pane ${pane} shows a numbered list of choices, so a dialog may wait there`,
      `Look at pane ${pane} and answer the dialog there. ${thenAgain}`,
    );
  }

  const typed = await tmuxStep(deps, typeArgs(pane, line));
  if (typed.ok) return ok(undefined);
  const cleaned = await tmuxCall(deps, clearArgs(pane));
  if (cleaned.ok && cleaned.value.exitCode === 0) return typed;
  return failure(`${typed.error.message}; the input line of pane ${pane} may still hold text`);
};
