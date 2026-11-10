import type { FieldValues } from '../board/contract.js';
import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { ok } from '../core/result.js';
import { commandText, flags, flagText, itemWords, maxEchoChars, type CommandName } from '../names.js';

/** The words that the commands of the board share: a usage error with its hint, typed text in a message, and the field words. */

/** Typed text for a message: cleaned, cut and quoted. */
export const shown = (text: string): string => JSON.stringify(displayLine(text, maxEchoChars));

/** A usage error (exit 2) of one command. Its hint tells the person to run the help of the command. */
export type NeedsUsage = (what: string) => CliResult<never>;

export const usageFor =
  (command: CommandName): NeedsUsage =>
  (what) =>
    usageError(what, `Run "${commandText(command)} ${flagText(flags.help)}".`);

/** The `NAME=VALUE` words of the field flag as the typed values of the fields. A word with no name and a repeated name are usage errors. */
export const parseFieldWords = (needsUsage: NeedsUsage, inputs: readonly string[]): CliResult<FieldValues> => {
  const given = new Map<string, string>();
  for (const input of inputs) {
    const at = input.indexOf(itemWords.fieldSeparator);
    if (at <= 0) return needsUsage(`${flagText(flags.field)} takes NAME${itemWords.fieldSeparator}VALUE, not ${shown(input)}`);
    const name = input.slice(0, at);
    if (given.has(name)) return needsUsage(`the field ${shown(name)} is given twice`);
    given.set(name, input.slice(at + itemWords.fieldSeparator.length));
  }
  return ok(Object.fromEntries(given));
};
