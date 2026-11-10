import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';

/**
 * The text of a board file in the old form: 2-space indent, every character that is not ASCII written as a unicode escape (one for
 * each UTF-16 unit, four digits in lower case, as the older writers did), and one line break at the end. A text that is in this form
 * and read and written back with no change is the same bytes.
 *
 * The key order of an object is the order of its keys in memory. A key such as `"2"`, which is a whole number, goes before the other
 * keys of its object when the text is read, so a stored object that has such a key as an unknown key comes back in another order.
 * That is a change of order and not of data.
 */

const NON_ASCII = /[^\x00-\x7f]/g;

const escaped = (char: string): string => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/**
 * True when every number in the value is one that the text can hold exactly. A number above the safe range of whole numbers has been
 * rounded by the read, and a number that is not finite has no text, so a write would change data that the core does not own. The walk
 * has no recursion and ends: each value is visited once, and the value is a tree that a read made.
 */
const numbersAreExact = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'number' && (!Number.isFinite(next) || (Number.isInteger(next) && !Number.isSafeInteger(next)))) return false;
    if (Array.isArray(next)) for (const entry of next) pending.push(entry);
    else if (isRecord(next)) for (const entry of Object.values(next)) pending.push(entry);
  }
  return true;
};

/** The text of a value for a board file (see above). A value that holds a number it cannot keep exactly, or is too deep to write, is a failure. */
export const boardJsonText = (value: unknown): CliResult<string> => {
  if (!numbersAreExact(value)) return failure('the board holds a number that cannot be written back exactly');
  try {
    return ok(`${JSON.stringify(value, null, 2).replace(NON_ASCII, escaped)}\n`);
  } catch {
    return failure('the board is nested too deeply to write');
  }
};
