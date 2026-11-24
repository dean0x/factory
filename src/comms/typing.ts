import { z } from 'zod';
import { failure, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { allOn, isGuardOn } from '../guards/effective.js';
import type { GuardValues } from '../guards/types.js';
import { capturePaneArgs, chainedArgs, isPaneId, paneModeArgs, paneSyncArgs, parsePaneMode, type TmuxArgs } from '../launch/tmux.js';
import { tmuxCall, tmuxStep } from '../launch/tmux-run.js';
import { boardIds, boardLimits, commandLines, commands, commandText, guardIds, keys, relayWords, typing } from '../names.js';
import { fillOwnerPrefix, hasOwnerPrefix } from '../safety/owner-prefix.js';

/**
 * Only this module holds the tmux input verb. It types fixed lines and lines built from parts of a recorded owner decision.
 * Both entries check the line before any tmux call. No entry accepts an arbitrary line.
 */
const SEND_KEYS = 'send-keys';

/** One of the fixed lines that the module types. */
export type TypedLine = (typeof typing.lines)[keyof typeof typing.lines];

const FIXED_LINES: readonly string[] = Object.values(typing.lines);

declare const relayLineBrand: unique symbol;
type RelayLine = string & { readonly [relayLineBrand]: true };

interface RelayParts {
  readonly template: string;
  readonly display: string;
  readonly node: string;
  readonly at: string;
  readonly id: string;
  readonly option: string;
}

const recordTime = z.iso.datetime({ offset: true });
const checkRecord = `Run "${commandText(commands.doctor)}" to check the decision record.`;
const checkPrefix = `Check ${keys.root.owner}.${keys.owner.display} and ${keys.root.owner}.${keys.owner.prefix} in the local config. Run "${commandText(commands.doctor)}" to check the config.`;

const utcDateOf = (at: string): string | null => {
  if (!recordTime.safeParse(at).success) return null;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return iso[10] === 'T' ? iso.slice(0, 10) : null;
};

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

/** Build the relay line before any read of the pane. Only the stored option key goes in the pointer. */
export const relayLineOf = ({ template, display, node, at, id, option }: RelayParts): CliResult<RelayLine> => {
  if (!boardIds.canonicalRequest.test(id)) return usageError('the relay needs a canonical decision id', relayWords.useDecisionId());
  if (!boardLimits.tokenPattern.test(option)) return safetyRefusal('the recorded option key is invalid', checkRecord);
  const date = utcDateOf(at);
  if (date === null) return safetyRefusal('the recorded decision time is invalid', checkRecord);

  const prefix = fillOwnerPrefix(template, { owner: display, node, date });
  if (!hasOwnerPrefix(prefix, template, display)) return failure('the filled relay prefix does not match the template', checkPrefix);
  const line = `${prefix} ${relayWords.pointer(id, option)}`;
  const problem = lineProblem(line);
  if (problem !== null) return failure(`the relay line is refused: it ${problem}`, checkPrefix);
  if (line.startsWith(' ') || line.startsWith('!') || line.startsWith('/') || line.startsWith('@')) {
    return safetyRefusal('the relay line must not start with a space, !, / or @', checkPrefix);
  }
  if (line.includes('@')) return safetyRefusal('the relay line must not contain @', checkPrefix);
  return ok(line as RelayLine);
};

/** One call of the input verb for one pane. The target is the pane id, and the words are key names or the text. */
const sendWords = (pane: string, ...words: readonly string[]): readonly string[] => [SEND_KEYS, '-t', pane, ...words];

/** The clean-up call: it clears the input line of the pane. */
const clearArgs = (pane: string): TmuxArgs => chainedArgs([sendWords(pane, typing.keys.clearLine)]);

/** Clear the input line, type the text as it is, end the line. One tmux run, so no other input comes between the three calls. */
const typeArgs = (pane: string, line: TypedLine | RelayLine): TmuxArgs =>
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
 * list with no pointer line, for example the end of an answer, is no dialog. With a line check, the choices must be consecutive.
 * One choice line or the prompt directly above the choices must pass the line check.
 */
export const showsChoiceList = (screen: string, matchesDialogLine?: (line: string) => boolean): boolean => {
  let pointer = false;
  let numbered = false;
  let matches = matchesDialogLine === undefined;
  for (const line of bottomLines(screen)) {
    const isPointer = typing.optionList.pointerLine.test(line);
    const isNumbered = typing.optionList.numberedLine.test(line);
    if (isPointer || isNumbered) {
      pointer ||= isPointer;
      numbered ||= isNumbered;
      matches ||= matchesDialogLine?.(line) ?? false;
      if (pointer && numbered && matches) return true;
    } else if (matchesDialogLine !== undefined) {
      pointer = false;
      numbered = false;
      matches = matchesDialogLine(line);
    }
  }
  return false;
};

/**
 * Reads whether the pane is in a mode of tmux, for example the copy mode. The keys of a pane in a mode go to the mode, not to the
 * session. A failed read, and an answer with no text (tmux has no such pane), are exit 1. The answer `0` passes. The answer `1` is
 * exit 3 while pane safety is on, and passes while it is off. Any other answer is exit 3 with every value.
 */
const requireNoMode = async (deps: Deps, pane: string, thenAgain: string, guards: GuardValues): Promise<CliResult<void>> => {
  const read = paneModeArgs(pane);
  if (!read.ok) return failure(read.error);
  const answer = await tmuxStep(deps, read.value);
  if (!answer.ok) return answer;
  const mode = parsePaneMode(answer.value);
  const inMode = (): CliResult<void> =>
    notReady(
      `the pane ${pane} is in a mode of tmux, so the keys would not reach the session`,
      `Press q in pane ${pane} to leave the mode. ${thenAgain}`,
    );
  switch (mode) {
    case 'none':
      return ok(undefined);
    case 'absent':
      return failure(`the mode of the pane ${pane} cannot be read: tmux has no such pane`);
    case 'active':
      return isGuardOn(guards, guardIds.paneSafety) ? inMode() : ok(undefined);
    case 'unknown':
      return inMode();
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
};

/**
 * One capture of the screen before the keys: a screen that shows a list of choices is exit 3, because a dialog may
 * take the keys. A failed capture is exit 1 (also for a pane that does not exist).
 */
const requireNoChoiceList = async (deps: Deps, pane: string, thenAgain: string): Promise<CliResult<void>> => {
  const capture = capturePaneArgs(pane);
  if (!capture.ok) return failure(capture.error);
  const screen = await tmuxStep(deps, capture.value);
  if (!screen.ok) return screen;
  return showsChoiceList(screen.value)
    ? notReady(
        `the pane ${pane} shows a numbered list of choices, so a dialog may wait there`,
        `Look at pane ${pane} and answer the dialog there. ${thenAgain}`,
      )
    : ok(undefined);
};

/**
 * Types one of the fixed lines into a pane and ends it with Enter. `thenAgain` is the clause that ends each remedy of an exit 3,
 * and it names the command that the caller runs again. The checks run in this order, and a refusal types nothing:
 * the line (printable ASCII, at most `typing.maxChars` signs, no final semicolon, one of `typing.lines`) and the pane id, which
 * are exit 1; one read of the mode of the pane, which is exit 1 when it fails and exit 3 for a pane in a mode of tmux, because the
 * keys would not reach the session; one capture of the screen, which is the last read before the keys, and it is exit 1 when it
 * fails (also for a pane that does not exist); a screen that shows a list of choices, which is exit 3, because a dialog may take the
 * keys. The keys go in one tmux run. If the run fails, exactly one clean-up call clears the input line, and the result is exit 1.
 * A mode or a dialog that opens after its read and before the keys is not seen. `guards` are the values of the caller: while pane
 * safety is off, a pane in a mode passes. The line, pane id, mode answer and screen checks run with every guard value.
 */
export const typeLine = async (
  deps: Deps,
  pane: string,
  line: TypedLine,
  thenAgain: string,
  guards: GuardValues = allOn,
): Promise<CliResult<void>> => {
  const problem = lineProblem(line);
  if (problem !== null) return failure(`the line to type is refused: it ${problem}`);
  if (!FIXED_LINES.includes(line)) return failure('the line to type is refused: it is not one of the fixed lines');
  const ready = await requireTypedPane(deps, pane, thenAgain, guards);
  return ready.ok ? sendCheckedLine(deps, pane, line) : ready;
};

/** Relay keys must go to one pane. An absent flag or an unreadable flag gives no such assurance. */
const requireSingleInput = async (deps: Deps, pane: string): Promise<CliResult<void>> => {
  const args = paneSyncArgs(pane);
  if (!args.ok) return failure(args.error);
  const read = await tmuxCall(deps, args.value);
  return read.ok && read.value.exitCode === 0 && read.value.stdout.trim() === '0'
    ? ok(undefined)
    : safetyRefusal(
        `cannot confirm single-pane input for pane ${pane}`,
        `Check that synchronize-panes is off for pane ${pane}. Then retry with "${commandText(commandLines.workerRelay)}".`,
      );
};

/** Check the line and screen, bind the target once more, then submit. Date the submit, not its checks. */
export const typeRelayLine = async (
  deps: Deps,
  pane: string,
  parts: RelayParts,
  thenAgain: string,
  rebind: () => Promise<CliResult<unknown>>,
  guards: GuardValues = allOn,
): Promise<CliResult<Date>> => {
  const line = relayLineOf(parts);
  if (!line.ok) return line;
  const ready = await requireTypedPane(deps, pane, thenAgain, guards);
  if (!ready.ok) return ready;
  const single = await requireSingleInput(deps, pane);
  if (!single.ok) return single;
  const bound = await rebind();
  if (!bound.ok) return bound;
  const typedAt = deps.now();
  const typed = await sendCheckedLine(deps, pane, line.value, `tmux ${SEND_KEYS} failed for pane ${pane}`);
  return typed.ok ? ok(typedAt) : typed;
};

const requireTypedPane = async (deps: Deps, pane: string, thenAgain: string, guards: GuardValues): Promise<CliResult<void>> => {
  if (!isPaneId(pane)) return failure('the target of the typed line is not a pane id');
  const mode = await requireNoMode(deps, pane, thenAgain, guards);
  return mode.ok ? requireNoChoiceList(deps, pane, thenAgain) : mode;
};

/** Keep the tmux detail for a fixed line. A relay fault must not repeat the submitted text. */
const sendCheckedLine = async (deps: Deps, pane: string, line: TypedLine | RelayLine, fixedFault?: string): Promise<CliResult<void>> => {
  const typed = await tmuxStep(deps, typeArgs(pane, line));
  if (typed.ok) return ok(undefined);
  const cleaned = await tmuxCall(deps, clearArgs(pane));
  const fault = fixedFault === undefined ? typed : failure(fixedFault);
  if (cleaned.ok && cleaned.value.exitCode === 0) return fault;
  return failure(`${fault.error.message}; the input line of pane ${pane} may still hold text`);
};
