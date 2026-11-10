import { join } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { isRecord } from '../migrate/inspect.js';
import { boardIds, boardKeys, commands, commandText, decisionLogKeys, files, maxEchoChars, waitingKeys } from '../names.js';
import { readBoardFiles } from '../state/board-commit.js';
import type { Layout } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import type { BoardItem, BoardTrack } from './contract.js';
import { tracksOf } from './tracks.js';

/**
 * The read of the three files of the local board: the board, the waiting file and the decision log. A parse function checks the text
 * of one file and gives its typed view with the stored objects as they are, so a write keeps every key that the core does not own
 * and keeps the order of the keys. A reader takes no lock (`readBoardFiles`) and refuses a link (exit 4). Every fault of a file is a
 * failure (exit 1) that names the file. A message never repeats stored text, except an id that passed its form check.
 */

type Stored = Readonly<Record<string, unknown>>;

/** The board file as read: the queue key of the recipe, the queue rows, the items and the tracks. */
export interface BoardDoc {
  readonly queueKey: string;
  /** The queue rows as stored. The commands of the queue check the keys of a row. */
  readonly queue: readonly Stored[];
  readonly items: readonly BoardItem[];
  /** The tracks. An absent `tracks` key is an empty list. */
  readonly tracks: readonly BoardTrack[];
  /** The top object as stored, with every key in the order of the file. A write changes a copy of it. */
  readonly top: Stored;
}

export interface WaitingItem {
  /** The id of the form `D-n`. */
  readonly id: string;
  readonly record: Stored;
}

/** The waiting file as read. */
export interface WaitingDoc {
  readonly top: Stored;
  readonly items: readonly WaitingItem[];
}

export interface DecisionRow {
  /** The id at the start of the `item` text of the row, or null when the row names no decision. */
  readonly id: string | null;
  readonly record: Stored;
}

/** The decision log as read. */
export interface DecisionLogDoc {
  readonly top: Stored;
  readonly rows: readonly DecisionRow[];
}

/** A key of a file for a message: cleaned, cut and quoted. */
const quoted = (key: string): string => JSON.stringify(displayLine(key, maxEchoChars));

const topOf = (text: string, file: string): CliResult<Stored> => {
  const json = parseJsonText(text);
  if (!json.ok) return failure(`${file}: ${json.error}`);
  if (!isRecord(json.value)) return failure(`${file}: the top level is not an object`);
  return ok(json.value);
};

/** The top keys of a file are exactly the required keys and some of the optional keys. */
const requireTopKeys = (
  file: string,
  top: Stored,
  required: readonly string[],
  optional: readonly string[],
): CliResult<void> => {
  const known = [...required, ...optional];
  const other = Object.keys(top).find((key) => !known.includes(key));
  if (other !== undefined) return failure(`${file}: the top key ${quoted(other)} is not one of: ${known.join(', ')}`);
  const missing = required.find((key) => !Object.hasOwn(top, key));
  if (missing !== undefined) return failure(`${file}: the top key "${missing}" is missing`);
  return ok(undefined);
};

/** The list at `key`, with every entry an object. */
const recordsAt = (file: string, top: Stored, key: string): CliResult<readonly Stored[]> => {
  const list = top[key];
  if (!Array.isArray(list)) return failure(`${file}: "${key}" is not a list`);
  const records: Stored[] = [];
  for (const [at, entry] of list.entries()) {
    if (!isRecord(entry)) return failure(`${file}: entry ${at + 1} of "${key}" is not an object`);
    records.push(entry);
  }
  return ok(records);
};

/** The id of an entry of a list, when it has the form. `place` names the entry. An id that fails the form is never repeated. */
const idOf = (record: Stored, key: string, form: RegExp, place: string): CliResult<string> => {
  const id = record[key];
  return typeof id === 'string' && form.test(id) ? ok(id) : failure(`${place} has no id of the right form`);
};

const requireUnique = (file: string, ids: readonly (string | null)[]): CliResult<void> => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === null) continue;
    if (seen.has(id)) return failure(`${file}: the id ${id} is used twice`);
    seen.add(id);
  }
  return ok(undefined);
};

/** A key that is absent, or holds text. */
const optionalText = (file: string, record: Stored, key: string, id: string): CliResult<string | null> => {
  if (!Object.hasOwn(record, key)) return ok(null);
  const value = record[key];
  return typeof value === 'string' ? ok(value) : failure(`${file}: the "${key}" of ${id} is not text`);
};

const requiredText = (file: string, record: Stored, key: string, id: string): CliResult<string> => {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? ok(value) : failure(`${file}: ${id} has no "${key}" text`);
};

const itemOf = (file: string, record: Stored, at: number): CliResult<BoardItem> => {
  const id = idOf(record, boardKeys.id, boardIds.item, `${file}: item ${at + 1}`);
  if (!id.ok) return id;
  const title = requiredText(file, record, boardKeys.title, id.value);
  if (!title.ok) return title;
  const status = requiredText(file, record, boardKeys.status, id.value);
  if (!status.ok) return status;
  const track = optionalText(file, record, boardKeys.track, id.value);
  if (!track.ok) return track;
  const stage = optionalText(file, record, boardKeys.stage, id.value);
  if (!stage.ok) return stage;
  return ok({ id: id.value, title: title.value, status: status.value, track: track.value, stage: stage.value, record });
};

/**
 * The board text as a typed view. The queue key comes from the recipe. The exact top keys are the queue key, `items` and the optional
 * `tracks`. A board that still has the old default queue key stops with the remedy to upgrade. Each item has a `B-n` id, a title and a
 * state, and no id is repeated. The tracks follow `tracksOf`. Text limits are the rules of a write and are not checked here, so a
 * stored long title never blocks a read.
 */
export const parseBoard = (text: string, queueKey: string): CliResult<BoardDoc> => {
  const file = files.board;
  const top = topOf(text, file);
  if (!top.ok) return top;
  if (queueKey !== boardKeys.defaultQueue && Object.hasOwn(top.value, boardKeys.defaultQueue) && !Object.hasOwn(top.value, queueKey)) {
    return failure(
      `${file} has the queue key "${boardKeys.defaultQueue}" and the setup uses "${queueKey}"`,
      `Run "${commandText(commands.upgrade)}" to rename the key.`,
    );
  }
  const keyed = requireTopKeys(file, top.value, [queueKey, boardKeys.items], [boardKeys.tracks]);
  if (!keyed.ok) return keyed;
  const queue = recordsAt(file, top.value, queueKey);
  if (!queue.ok) return queue;
  const records = recordsAt(file, top.value, boardKeys.items);
  if (!records.ok) return records;
  const items: BoardItem[] = [];
  for (const [at, record] of records.value.entries()) {
    const item = itemOf(file, record, at);
    if (!item.ok) return item;
    items.push(item.value);
  }
  const unique = requireUnique(file, items.map((item) => item.id));
  if (!unique.ok) return unique;
  const tracks = tracksOf(top.value);
  if (!tracks.ok) return tracks;
  return ok({ queueKey, queue: queue.value, items, tracks: tracks.value, top: top.value });
};

/** The waiting text as a typed view: the exact top keys, an `intro` text, a list of groups and a list of items with a `D-n` id each. */
export const parseWaiting = (text: string): CliResult<WaitingDoc> => {
  const file = files.waiting;
  const top = topOf(text, file);
  if (!top.ok) return top;
  const keyed = requireTopKeys(file, top.value, [waitingKeys.intro, waitingKeys.groups, waitingKeys.items], []);
  if (!keyed.ok) return keyed;
  if (typeof top.value[waitingKeys.intro] !== 'string') return failure(`${file}: "${waitingKeys.intro}" is not text`);
  const groups = recordsAt(file, top.value, waitingKeys.groups);
  if (!groups.ok) return groups;
  const records = recordsAt(file, top.value, waitingKeys.items);
  if (!records.ok) return records;
  const items: WaitingItem[] = [];
  for (const [at, record] of records.value.entries()) {
    const id = idOf(record, waitingKeys.id, boardIds.request, `${file}: entry ${at + 1}`);
    if (!id.ok) return id;
    items.push({ id: id.value, record });
  }
  const unique = requireUnique(file, items.map((item) => item.id));
  if (!unique.ok) return unique;
  return ok({ top: top.value, items });
};

const rowIdOf = (record: Stored): string | null => {
  const item = record[decisionLogKeys.item];
  return typeof item === 'string' ? (boardIds.requestAtStart.exec(item)?.[0] ?? null) : null;
};

/** The decision log text as a typed view: the exact top key `rows`, and a row that names a decision names it once. */
export const parseDecisionLog = (text: string): CliResult<DecisionLogDoc> => {
  const file = files.decisionLog;
  const top = topOf(text, file);
  if (!top.ok) return top;
  const keyed = requireTopKeys(file, top.value, [decisionLogKeys.rows], []);
  if (!keyed.ok) return keyed;
  const records = recordsAt(file, top.value, decisionLogKeys.rows);
  if (!records.ok) return records;
  const rows = records.value.map((record): DecisionRow => ({ id: rowIdOf(record), record }));
  const unique = requireUnique(file, rows.map((row) => row.id));
  if (!unique.ok) return unique;
  return ok({ top: top.value, rows });
};

/**
 * The text of one file of the state folder, read with no lock. A link in the path is a security stop (exit 4). A file that is not
 * there, is not UTF-8 or is too large is a failure (exit 1) that names the file.
 */
const textOfFile = async (deps: Deps, layout: Layout, file: string): Promise<CliResult<string>> => {
  const linked = await requireNoLinks(deps, layout.home, [join(layout.stateDir, file)]);
  if (!linked.ok) return linked;
  const read = await readBoardFiles(deps, layout, [file]);
  if (!read.ok) return read;
  const text = read.value.get(file);
  return text === null || text === undefined ? failure(`cannot read ${file}: the file is not there`) : ok(text);
};

/** Read and check the board file. The queue key comes from the recipe of the factory (`queueKeyOf`). */
export const readBoard = async (deps: Deps, layout: Layout, queueKey: string): Promise<CliResult<BoardDoc>> => {
  const text = await textOfFile(deps, layout, files.board);
  return text.ok ? parseBoard(text.value, queueKey) : text;
};

export const readWaiting = async (deps: Deps, layout: Layout): Promise<CliResult<WaitingDoc>> => {
  const text = await textOfFile(deps, layout, files.waiting);
  return text.ok ? parseWaiting(text.value) : text;
};

export const readDecisionLog = async (deps: Deps, layout: Layout): Promise<CliResult<DecisionLogDoc>> => {
  const text = await textOfFile(deps, layout, files.decisionLog);
  return text.ok ? parseDecisionLog(text.value) : text;
};
