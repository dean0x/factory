import { boardKeys } from '../names.js';
import type { QueueRow } from './contract.js';
import type { BoardDoc } from './files.js';

/**
 * The rows of the queue as the commands show them. The reader of the board checks that each row is an object and nothing else, so a
 * name or a note that is not text reads as null, and an item list that is not a list of text reads as an empty list.
 */

type Stored = Readonly<Record<string, unknown>>;

/** The name of a row, or null when the row has none. A name is matched as it is stored. */
export const rowNameOf = (record: Stored): string | null => {
  const name = record[boardKeys.name];
  return typeof name === 'string' ? name : null;
};

const textOf = (record: Stored, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' ? value : null;
};

/** The item ids of a row. A list that holds other than text reads as an empty list. */
export const rowItemsOf = (record: Stored): readonly string[] => {
  const items = record[boardKeys.items];
  return Array.isArray(items) && items.every((item) => typeof item === 'string') ? items : [];
};

export const queueRowsOf = (doc: BoardDoc): readonly QueueRow[] =>
  doc.queue.map((record, at) => ({
    position: at + 1,
    name: rowNameOf(record),
    items: rowItemsOf(record),
    note: textOf(record, boardKeys.note),
    record,
  }));
