import { err, ok, type Result } from '../core/result.js';
import { boardKeys } from '../names.js';

/** The text of a board is JSON with a list of items; each item is an object with a text `id`. */
const ITEMS_KEY = boardKeys.items;
const ID_KEY = boardKeys.id;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The item ids of a board text, in the order of the items. An id counts only at the item key position: the `id` of an entry of
 * the list `items`. An id in the text of another field, in a nested object or in another list is not read. Text that is not
 * valid JSON, and a board of any other shape, gives a reason and no ids. Every code path that reads ids uses this function.
 */
export const itemIdsOf = (text: string): Result<readonly string[], string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err('the text is not valid JSON');
  }
  if (!isRecord(parsed)) return err('the top level is not an object');
  const items = parsed[ITEMS_KEY];
  if (!Array.isArray(items)) return err(`"${ITEMS_KEY}" is not a list`);
  const ids: string[] = [];
  for (const [at, item] of items.entries()) {
    if (!isRecord(item)) return err(`item ${at + 1} is not an object`);
    const id = item[ID_KEY];
    if (typeof id !== 'string' || id === '') return err(`item ${at + 1} has no text "${ID_KEY}"`);
    ids.push(id);
  }
  return ok(ids);
};

/** Why a change could not be compared: which text was not usable, and the reason. */
export interface LostIdsFault {
  /** `before` is the text of the last commit. `after` is the new text. */
  readonly side: 'before' | 'after';
  readonly reason: string;
}

/**
 * The ids of `before` that `after` lacks, each one once, in the order of `before`. `before` is the text at the last commit, or null
 * when the last commit holds no board. `after` is the new text, or null when the new state holds no board.
 * - No board at the last commit: nothing can be lost. A new text that is not a board is still a fault.
 * - A new state with no board, while the last commit has one, is a fault: every id would be lost.
 * - A text that is not a board, on either side, is a fault. The change is not compared.
 * A closed item keeps its id, so closing an item loses nothing.
 */
export const lostItemIds = (before: string | null, after: string | null): Result<readonly string[], LostIdsFault> => {
  if (before === null) {
    if (after === null) return ok([]);
    const added = itemIdsOf(after);
    return added.ok ? ok([]) : err({ side: 'after', reason: added.error });
  }
  const previous = itemIdsOf(before);
  if (!previous.ok) return err({ side: 'before', reason: previous.error });
  if (after === null) return err({ side: 'after', reason: 'the file is removed' });
  const current = itemIdsOf(after);
  if (!current.ok) return err({ side: 'after', reason: current.error });
  const kept = new Set(current.value);
  return ok([...new Set(previous.value.filter((id) => !kept.has(id)))]);
};
