import { displayLine, tableLines, type OutLine } from '../cli/output.js';
import type { BoardField } from '../config/schema.js';
import { flags, flagText, itemWords, maxDisplayWidth, maxTrackLines, queueWords, requestWords } from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';
import type { BoardItem, BoardRequest, BoardTrack, QueueRow } from './contract.js';
import { stageShown, stagesOf } from './stages.js';

/**
 * The text of `item list`, `request list` and `queue show`. It is short by design: at most 20 lines, and a first line of at most 120 characters. The summary line,
 * the heading line of the table and the more line take three of the lines, so the table holds at most `maxTrackLines` rows.
 * Every text from the board file is cleaned and cut by `displayLine` before it goes into a cell, and every line is cut to the
 * width of a line at the end.
 */

export interface ListInput {
  /** The items to show. The connector has hidden the closed items already, unless `all` is set. */
  readonly items: readonly BoardItem[];
  readonly tracks: readonly BoardTrack[];
  readonly board: RecipeBoard;
  /** The owner fields of an item that the setup declares. The list of one track shows them. */
  readonly fields: readonly BoardField[];
  /** True when the closed items are in `items`. */
  readonly all: boolean;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const itemsText = (count: number): string => plural(count, itemWords.item, itemWords.items);

/** The closed items are hidden unless the person asked for them: the summary says how to show them. */
const hiddenHint = (all: boolean): string => (all ? '' : ` Closed items are hidden. Use ${flagText(flags.all)} to show them.`);

const clean = (text: string, width: number): string => displayLine(text, width);

const lineOf = (text: string): OutLine => ({ level: 'text', text });

/** Clean every line of the output, and cut it to the width of a line. */
const framed = (lines: readonly OutLine[]): readonly OutLine[] => lines.map((line) => ({ ...line, text: clean(line.text, maxDisplayWidth) }));

const stageText = (board: RecipeBoard, stage: string | null): string =>
  stage === null ? itemWords.noStage : stageShown(board, stage);

/** The counts of a group of items by stage: the stages of the recipe in order, then the other stored stages, then no stage. */
const stageCounts = (board: RecipeBoard, items: readonly BoardItem[]): string => {
  const counts = new Map<string | null, number>();
  for (const item of items) counts.set(item.stage, (counts.get(item.stage) ?? 0) + 1);
  const listed = stagesOf(board).filter((stage) => counts.has(stage));
  const others = [...counts.keys()].filter((stage): stage is string => stage !== null && !listed.includes(stage));
  const order: readonly (string | null)[] = [...listed, ...others, ...(counts.has(null) ? [null] : [])];
  return order.map((stage) => `${stageText(board, stage)} ${counts.get(stage) ?? 0}`).join(', ');
};

/** The cell of a group: its stage counts, or, for a group of one item, the item and its stage. */
const groupCell = (board: RecipeBoard, items: readonly BoardItem[]): string => {
  const [only, ...rest] = items;
  if (only === undefined) return itemWords.empty;
  const text = rest.length === 0 ? `${clean(only.id, itemWords.maxCellChars)} ${stageText(board, only.stage)}: ${clean(only.title, itemWords.maxCellChars)}` : stageCounts(board, items);
  return clean(text, itemWords.maxCellChars);
};

/**
 * The items of each track and the items that are on no listed track. An item with a track that the board does not list is in the
 * second group, so no item is out of sight.
 */
const groupsOf = (tracks: readonly BoardTrack[], items: readonly BoardItem[]): { readonly byTrack: readonly (readonly BoardItem[])[]; readonly loose: readonly BoardItem[] } => {
  const ids = new Set(tracks.map((track) => track.id));
  return {
    byTrack: tracks.map((track) => items.filter((item) => item.track === track.id)),
    loose: items.filter((item) => item.track === null || !ids.has(item.track)),
  };
};

/**
 * The view of the whole board: a summary line, then a table with one row for each track and its counts by stage, then one more line
 * when tracks do not fit. A track with one item shows that item and its stage. The items on no listed track are the last row, and
 * that row takes one of the `maxTrackLines` rows. With no track and no item the output is the summary line alone.
 */
export const boardView = (input: ListInput): readonly OutLine[] => {
  const { items, tracks, board } = input;
  const summary = lineOf(`${itemsText(items.length)} in ${plural(tracks.length, itemWords.track, itemWords.tracks)}.${hiddenHint(input.all)}`);
  const { byTrack, loose } = groupsOf(tracks, items);
  if (tracks.length === 0 && loose.length === 0) return framed([summary]);
  const room = maxTrackLines - (loose.length > 0 ? 1 : 0);
  const rows = tracks.slice(0, room).map((track, at) => {
    const group = byTrack[at] ?? [];
    return [clean(track.id, itemWords.maxCellChars), String(group.length), groupCell(board, group)];
  });
  if (loose.length > 0) rows.push([itemWords.noTrack, String(loose.length), groupCell(board, loose)]);
  const hidden = tracks.length - room;
  const more = hidden > 0 ? [lineOf(`${plural(hidden, 'more track', 'more tracks')}. Use ${flagText(flags.track)} ID to list the items of one track.`)] : [];
  return framed([summary, ...tableLines(Object.values(itemWords.trackColumns), rows), ...more]);
};

/** The cell of an owner field: the value as text, or a dash for a field that the record does not hold. */
const fieldText = (record: Readonly<Record<string, unknown>>, field: BoardField): string => {
  const value = record[field.name];
  if (typeof value === 'string') return clean(value, itemWords.maxFieldChars);
  return typeof value === 'boolean' ? String(value) : itemWords.empty;
};

/**
 * The view of one track: a summary line, then a table with one row for each item, with its stage, its status and its owner fields,
 * then one more line when the items do not fit.
 */
export const trackView = (input: ListInput & { readonly track: BoardTrack }): readonly OutLine[] => {
  const { items, track, board, fields } = input;
  const roadmap = track.roadmap ? ' (roadmap)' : '';
  const summary = lineOf(`Track ${track.id}: ${clean(track.name, itemWords.maxCellChars)}${roadmap}. ${itemsText(items.length)}.${hiddenHint(input.all)}`);
  if (items.length === 0) return framed([summary]);
  const title = [
    itemWords.columns.id,
    itemWords.columns.stage,
    itemWords.columns.status,
    ...fields.map((field) => field.name.toUpperCase()),
    itemWords.columns.title,
  ];
  const rows = items.slice(0, maxTrackLines).map((item) => [
    clean(item.id, itemWords.maxCellChars),
    stageText(board, item.stage),
    clean(item.status, itemWords.maxStatusChars),
    ...fields.map((field) => fieldText(item.record, field)),
    clean(item.title, itemWords.maxCellChars),
  ]);
  const hidden = items.length - rows.length;
  const more = hidden > 0 ? [lineOf(`${plural(hidden, 'more item', 'more items')}.`)] : [];
  return framed([summary, ...tableLines(title, rows), ...more]);
};

/** A text or a dash: the cell of a part that a stored entry may lack. */
const orDash = (text: string | null, width: number): string => (text === null ? itemWords.empty : clean(text, width));

/**
 * The view of the requests: a summary line, then a table with one row for each request (its number, its title and the keys of its
 * options), then one more line when the requests do not fit. A part that an entry lacks shows as a dash.
 */
export const requestView = (requests: readonly BoardRequest[]): readonly OutLine[] => {
  const summary = lineOf(`${requests.length} open ${requests.length === 1 ? requestWords.request : requestWords.requests}.`);
  if (requests.length === 0) return framed([summary]);
  const rows = requests.slice(0, maxTrackLines).map((request) => [
    clean(request.id, requestWords.maxCellChars),
    orDash(request.title, requestWords.maxCellChars),
    request.options.length === 0 ? itemWords.empty : clean(request.options.join(requestWords.optionKeySeparator), requestWords.maxOptionsChars),
  ]);
  const hidden = requests.length - rows.length;
  const more = hidden > 0 ? [lineOf(`${plural(hidden, `more ${requestWords.request}`, `more ${requestWords.requests}`)}.`)] : [];
  return framed([summary, ...tableLines(Object.values(requestWords.columns), rows), ...more]);
};

export interface QueueViewInput {
  readonly rows: readonly QueueRow[];
  /** The owner fields of a row that the setup declares. */
  readonly fields: readonly BoardField[];
}

/** A line of the table of the queue: the heading of a group (text), or a row. */
type QueueEntry = string | QueueRow;

/**
 * The entries of a queue with at least one group: the rows of each group under the heading of the group, the groups in the order in
 * which their first rows appear, then the rows with no group under their own heading. A row keeps its stored place in its cell.
 */
const groupedEntries = (rows: readonly QueueRow[]): readonly QueueEntry[] => {
  const byGroup = new Map<string, QueueRow[]>();
  const ungrouped: QueueRow[] = [];
  for (const row of rows) {
    if (row.releaseGroup === null) {
      ungrouped.push(row);
      continue;
    }
    const members = byGroup.get(row.releaseGroup);
    if (members === undefined) byGroup.set(row.releaseGroup, [row]);
    else members.push(row);
  }
  const groups = [...byGroup].flatMap(([group, members]): QueueEntry[] => [`${queueWords.groupHeading}: ${clean(group, queueWords.maxCellChars)}`, ...members]);
  return ungrouped.length === 0 ? groups : [...groups, queueWords.ungroupedHeading, ...ungrouped];
};

/**
 * The entries that fit in the `maxTrackLines` lines of the table. A heading counts as a line. The heading of a group shows only with
 * its first row, so a heading that would be the last line is left out.
 */
const fittingEntries = (entries: readonly QueueEntry[]): readonly QueueEntry[] => {
  const fitting = entries.slice(0, maxTrackLines);
  return typeof fitting.at(-1) === 'string' ? fitting.slice(0, -1) : fitting;
};

/**
 * The view of the queue: a summary line, then a table with one row for each row of the queue (its place, its name, its items, its
 * owner fields and its note), then one more line when the rows do not fit. When a row has a release group, the rows go under one
 * heading for each group (the heading lines come inside the `maxTrackLines` lines of the table), and the rows with no group are last.
 */
export const queueView = (input: QueueViewInput): readonly OutLine[] => {
  const { rows, fields } = input;
  const summary = lineOf(`${plural(rows.length, queueWords.row, queueWords.rows)} in the ${queueWords.queue}.`);
  if (rows.length === 0) return framed([summary]);
  const title = [
    queueWords.columns.position,
    queueWords.columns.name,
    queueWords.columns.items,
    ...fields.map((field) => field.name.toUpperCase()),
    queueWords.columns.note,
  ];
  const shown = fittingEntries(rows.some((row) => row.releaseGroup !== null) ? groupedEntries(rows) : rows);
  const shownRows = shown.filter((entry): entry is QueueRow => typeof entry !== 'string');
  const cells = shownRows.map((row) => [
    String(row.position),
    orDash(row.name, queueWords.maxCellChars),
    row.items.length === 0 ? itemWords.empty : clean(row.items.join(queueWords.itemSeparator), queueWords.maxCellChars),
    ...fields.map((field) => fieldText(row.record, field)),
    orDash(row.note, queueWords.maxCellChars),
  ]);
  const table = tableLines(title, cells);
  // The table gives one line for each shown row, in order. The lines are taken in that order, and a heading of a group takes none.
  const rowLines = table.slice(1);
  const body = shown.flatMap((entry): OutLine[] => (typeof entry === 'string' ? [{ level: 'heading', text: entry }] : rowLines.splice(0, 1)));
  const hidden = rows.length - shownRows.length;
  const more = hidden > 0 ? [lineOf(`${plural(hidden, `more ${queueWords.row}`, `more ${queueWords.rows}`)}.`)] : [];
  return framed([summary, ...table.slice(0, 1), ...body, ...more]);
};
