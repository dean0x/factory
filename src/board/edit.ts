import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { BoardConfig } from '../config/schema.js';
import { ok } from '../core/result.js';
import {
  boardIds,
  boardKeys,
  boardLimits,
  boardTextLimits,
  commandLines,
  commandText,
  decisionKeys,
  decisionLogKeys,
  files,
  flags,
  flagText,
  markLimits,
  maxBoardNumber,
  maxEchoChars,
  mergedStage,
  optionKeys,
  places,
  queueLimits,
  relayedMarker,
  requestDeciders,
  requestWords,
  roles,
  trackLimits,
  waitingKeys,
  workerFieldGuard,
} from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';
import { isPlainPath } from '../state/board-commit.js';
import type {
  BoardItem,
  DecisionAskInput,
  DecisionLogInput,
  FieldValues,
  ItemAddInput,
  ItemMove,
  ItemMoved,
  ItemPatch,
  QueueRowInput,
  QueueRowSet,
  RequestClosed,
  RequestDecider,
  RequestSettlement,
  TrackAddInput,
} from './contract.js';
import { declaredFields, itemTarget, resolveFields, rowTarget, type FieldInput } from './fields.js';
import type { BoardDoc, DecisionLogDoc, WaitingDoc } from './files.js';
import type { MergedPr } from './github-pr.js';
import { rowItemsOf, rowNameOf } from './queue.js';
import { requestTitleOf } from './requests.js';
import { firstStageOf, requireSettableStage, requireStage } from './stages.js';
import { holdsBreak, lineIssue } from './text.js';
import { trackIdIssue, trackNameIssue } from './tracks.js';

/**
 * The rules of a board write, as pure steps. A `check` step looks at the input alone, so a command runs it before it takes the lock:
 * a usage error never waits for the lock. An `In` step edits a file that was read under the lock. It gives the new top object of the
 * file, built from a copy of the top object that was read, so every key that the core does not own stays with its value and its place.
 * A step that changes nothing gives no top object, and the caller leaves the text of the file as it is.
 */

type Stored = Readonly<Record<string, unknown>>;

/** The setup that the rules read: the stage data of the recipe and the `board` block of the config. */
export interface BoardSetup {
  readonly recipe: RecipeBoard;
  readonly config: BoardConfig | undefined;
}

/** The result of an edit: the new top object, or null when the file stays as it is, and a value for the caller. */
export interface Edit<T> {
  readonly top: Stored | null;
  readonly value: T;
}

/** Typed text for a message: cleaned, cut and quoted. */
export const shown = (text: string): string => JSON.stringify(displayLine(text, maxEchoChars));

const NO_STATES = 'the setup declares no item states, so it can not add, move or close an item; see the sample setup in examples/';

const lineOf = (what: string, text: string, max: number): CliResult<string> => {
  const issue = lineIssue(text, max);
  return issue === null ? ok(text.trim()) : usageError(`the ${what} ${issue}`);
};

const optionalLineOf = (what: string, text: string | undefined, max: number): CliResult<string | undefined> =>
  text === undefined ? ok(undefined) : lineOf(what, text, max);

/** The fields of the contract as the typed text that `resolveFields` checks. */
const inputsOf = (fields: FieldValues | undefined): FieldInput[] =>
  Object.entries(fields ?? {}).map(([name, value]) => ({ name, value: String(value) }));

/** An item id of the form `B-n`. The form check comes first, because the id goes into the text of a commit. */
export const checkItemId = (id: string): CliResult<string> =>
  boardIds.item.test(id) ? ok(id) : usageError(`${shown(id)} is not an item id; an item id looks like B-12`);

// The input of a write, checked before the lock.

export interface NewItem {
  readonly title: string;
  readonly text: string | undefined;
  readonly track: string | undefined;
  readonly status: string;
  readonly stage: string | null;
  readonly fields: FieldValues;
}

/** A new item: the first state of the setup, the first stage of the recipe, and the checked title, text and fields. */
export const checkNewItem = (setup: BoardSetup, input: ItemAddInput): CliResult<NewItem> => {
  const [status] = setup.config?.states ?? [];
  if (status === undefined) return usageError(NO_STATES);
  const title = lineOf('title', input.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const text = optionalLineOf('text', input.text, boardTextLimits.maxTextChars);
  if (!text.ok) return text;
  const fields = resolveFields(setup.config, itemTarget, inputsOf(input.fields), { complete: true });
  if (!fields.ok) return fields;
  return ok({ title: title.value, text: text.value, track: input.track, status, stage: firstStageOf(setup.recipe), fields: fields.value });
};

export interface ItemChanges {
  readonly title: string | undefined;
  readonly text: string | undefined;
  readonly track: string | undefined;
  readonly fields: FieldValues;
}

/** The parts of a change of an item. A part that is left out stays as it is. */
export const checkPatch = (setup: BoardSetup, patch: ItemPatch): CliResult<ItemChanges> => {
  const title = optionalLineOf('title', patch.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const text = optionalLineOf('text', patch.text, boardTextLimits.maxTextChars);
  if (!text.ok) return text;
  const fields = resolveFields(setup.config, itemTarget, inputsOf(patch.fields), { complete: false });
  if (!fields.ok) return fields;
  return ok({ title: title.value, text: text.value, track: patch.track, fields: fields.value });
};

/**
 * A move to a state of the setup, or to a stage that a command may set (a stage that only a flow sets is a usage error). The key is
 * the key of the item that the move sets: its status, or its stage.
 */
export interface CheckedMove {
  readonly key: typeof boardKeys.status | typeof boardKeys.stage;
  readonly value: string;
}

export const checkMove = (setup: BoardSetup, move: ItemMove): CliResult<CheckedMove> => {
  if ('stage' in move) {
    const stage = requireSettableStage(setup.recipe, move.stage);
    return stage.ok ? ok({ key: boardKeys.stage, value: stage.value }) : stage;
  }
  const states = setup.config?.states ?? [];
  if (states.length === 0) return usageError(NO_STATES);
  return states.includes(move.state)
    ? ok({ key: boardKeys.status, value: move.state })
    : usageError(`unknown state ${shown(move.state)}; the states are: ${states.join(', ')}`);
};

/** The closed state of the setup. */
export const checkClose = (setup: BoardSetup): CliResult<string> => {
  const closed = setup.config?.closed;
  return closed === undefined
    ? usageError('the setup names no closed state, so it can not close an item; see the sample setup in examples/')
    : ok(closed);
};

export const checkNewTrack = (input: TrackAddInput): CliResult<TrackAddInput> => {
  const idIssue = trackIdIssue(input.id);
  if (idIssue !== null) return usageError(`the track id ${shown(input.id)} is not valid: ${idIssue}`);
  const nameIssue = trackNameIssue(input.name);
  return nameIssue === null ? ok(input) : usageError(`the track name is not valid: ${nameIssue}`);
};

export interface CheckedDecision {
  readonly title: string;
  readonly question: string;
  /** The options as the waiting file stores them. */
  readonly options: readonly Stored[];
}

const optionOf = (option: DecisionAskInput['options'][number]): CliResult<Stored> => {
  if (!boardLimits.tokenPattern.test(option.key)) {
    return usageError(
      `the option key ${shown(option.key)} is not a token: 1 to ${boardLimits.maxTokenChars} letters, digits, dots, underscores or hyphens`,
    );
  }
  const text = lineOf(`text of option ${option.key}`, option.text, boardTextLimits.maxOptionChars);
  if (!text.ok) return text;
  return ok({ [optionKeys.key]: option.key, [optionKeys.text]: text.value, ...(option.rec === true ? { [optionKeys.rec]: true } : {}) });
};

/**
 * A decision for the owner: a one-line title, a one-line question and 1 to 9 options. A question with a line break is a failure
 * (exit 1) that names the waiting file, because the file would hold a question that a later read refuses. The other faults are usage
 * errors (exit 2).
 */
export const checkDecision = (input: DecisionAskInput): CliResult<CheckedDecision> => {
  const title = lineOf('title', input.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  if (holdsBreak(input.question.trim())) return failure(`cannot write ${files.waiting}: the question holds a line break, a control character or a mark of text direction`);
  const question = lineOf(decisionKeys.question, input.question, boardTextLimits.maxQuestionChars);
  if (!question.ok) return question;
  const { options } = input;
  if (options.length < 1 || options.length > boardTextLimits.maxOptions) {
    return usageError(`a decision needs 1 to ${boardTextLimits.maxOptions} options`);
  }
  const keys = new Set<string>();
  const stored: Stored[] = [];
  for (const option of options) {
    if (keys.has(option.key)) return usageError(`the option key ${shown(option.key)} is used twice`);
    keys.add(option.key);
    const record = optionOf(option);
    if (!record.ok) return record;
    stored.push(record.value);
  }
  if (options.filter((option) => option.rec === true).length > 1) return usageError('only one option can be the recommended one');
  return ok({ title: title.value, question: question.value, options: stored });
};

/** Why a path can not be linked, as a phrase for a message ("the path ..."), or null. The checks need no file. */
const docPathIssue = (path: string): string | null => {
  if (path === '') return 'is empty';
  if (holdsBreak(path)) return 'holds a line break, a control character or a mark of text direction';
  if (path.length > boardTextLimits.maxDocPathChars) return `is longer than ${boardTextLimits.maxDocPathChars} characters`;
  if (path.includes('\\')) return 'holds a backslash';
  return isPlainPath(path) ? null : `is not a plain relative path inside the ${places.folder}`;
};

export const checkDocPath = (path: string): CliResult<string> => {
  const issue = docPathIssue(path);
  return issue === null ? ok(path) : usageError(`the path ${shown(path)} ${issue}`);
};

/** A request id of the form `D-n`. The form check comes first, because the id goes into the text of a commit. */
export const checkRequestId = (id: string): CliResult<string> =>
  boardIds.request.test(id) ? ok(id) : usageError(`${shown(id)} is not a ${requestWords.request} id; a ${requestWords.request} id looks like D-12`);

/** The row of a queue write after its input check: the optional parts are as the person gave them. */
export interface CheckedRow {
  readonly name: string;
  readonly items: readonly string[] | undefined;
  readonly note: string | undefined;
  readonly fields: FieldValues;
  readonly position: number | undefined;
}

const rowItemsIssue = (items: readonly string[]): CliResult<void> => {
  if (items.length > queueLimits.maxRowItems) return usageError(`a row of the queue holds at most ${queueLimits.maxRowItems} items`);
  const seen = new Set<string>();
  for (const id of items) {
    const valid = checkItemId(id);
    if (!valid.ok) return valid;
    if (seen.has(id)) return usageError(`the item ${id} is named twice`);
    seen.add(id);
  }
  return ok(undefined);
};

/**
 * A queue write: a one-line name and note, item ids of the form `B-n` with no repeat, owner fields of the row that the setup
 * declares, and a position from 1. Whether the items are on the board, and whether a field is required, depend on the board and wait
 * for the edit under the lock.
 */
export const checkQueueRow = (setup: BoardSetup, input: QueueRowInput): CliResult<CheckedRow> => {
  const name = lineOf(boardKeys.name, input.name, boardTextLimits.maxTitleChars);
  if (!name.ok) return name;
  const note = optionalLineOf(boardKeys.note, input.note, boardTextLimits.maxTextChars);
  if (!note.ok) return note;
  if (input.items !== undefined) {
    const items = rowItemsIssue(input.items);
    if (!items.ok) return items;
  }
  const fields = resolveFields(setup.config, rowTarget, inputsOf(input.fields), { complete: false });
  if (!fields.ok) return fields;
  if (input.position !== undefined && !(Number.isInteger(input.position) && input.position >= 1)) {
    return usageError('the position is a whole number from 1');
  }
  return ok({ name: name.value, items: input.items, note: note.value, fields: fields.value, position: input.position });
};

// The edits of a file that was read under the lock.

const itemAt = (doc: BoardDoc, id: string): CliResult<BoardItem> => {
  const found = doc.items.find((candidate) => candidate.id === id);
  return found === undefined ? usageError(`${files.board} has no item ${shown(id)}`) : ok(found);
};

/** A track id of the board, else a usage error (exit 2) that lists the track ids. */
export const requireTrack = (doc: BoardDoc, track: string): CliResult<string> => {
  if (doc.tracks.some((candidate) => candidate.id === track)) return ok(track);
  const known = doc.tracks.length === 0 ? 'the board has no tracks' : `the tracks are: ${doc.tracks.map((entry) => entry.id).join(', ')}`;
  return usageError(`unknown track ${shown(track)}; ${known}`);
};

/** The id after the highest number among the ids, for the prefix `B-` or `D-`. The ids passed their form check, so each ends in digits. */
const nextId = (prefix: 'B-' | 'D-', ids: readonly (string | null)[]): CliResult<string> => {
  const highest = ids.reduce((top, id) => (id === null ? top : Math.max(top, Number(id.slice(prefix.length)))), 0);
  return highest >= maxBoardNumber ? failure(`the numbers of the ids ${prefix}n are used up`) : ok(`${prefix}${highest + 1}`);
};

const listAt = (top: Stored, key: string): readonly unknown[] => {
  const list = top[key];
  return Array.isArray(list) ? list : [];
};

/** The record with the given keys set. A key that the record has keeps its place, and a new key goes to the end. */
const withKeys = (record: Stored, entries: readonly (readonly [string, unknown])[]): { readonly record: Stored; readonly changed: boolean } => ({
  record: { ...record, ...Object.fromEntries(entries) },
  changed: entries.some(([key, value]) => !Object.hasOwn(record, key) || record[key] !== value),
});

const withItems = (doc: BoardDoc, items: readonly unknown[]): Stored => ({ ...doc.top, [boardKeys.items]: items });

/** The top object with the record of one item replaced. */
const withItem = (doc: BoardDoc, id: string, record: Stored): Stored =>
  withItems(doc, doc.items.map((item) => (item.id === id ? record : item.record)));

/** Add the item. The value is its new id: the number after the highest one on the board. */
export const addItemIn = (doc: BoardDoc, item: NewItem): CliResult<Edit<string>> => {
  if (item.track !== undefined) {
    const track = requireTrack(doc, item.track);
    if (!track.ok) return track;
  }
  const id = nextId('B-', doc.items.map((entry) => entry.id));
  if (!id.ok) return id;
  const entries: [string, unknown][] = [
    [boardKeys.id, id.value],
    [boardKeys.title, item.title],
    [boardKeys.status, item.status],
  ];
  if (item.stage !== null) entries.push([boardKeys.stage, item.stage]);
  if (item.track !== undefined) entries.push([boardKeys.track, item.track]);
  if (item.text !== undefined) entries.push([boardKeys.text, item.text]);
  entries.push(...Object.entries(item.fields));
  return ok({ top: withItems(doc, [...doc.items.map((entry) => entry.record), Object.fromEntries(entries)]), value: id.value });
};

/**
 * Change the title, the text, the track and the fields of an item. The value is the id.
 *
 * The worker field guard: when the patch holds the worker field, and the stored item has the key, a new value that differs from the
 * stored one is a usage error (exit 2) that names the command that takes a worker off an item. Only `unassignIn` removes a worker.
 * An item with no worker key takes a worker, and a patch with the stored value changes nothing. The guard reads the item that was
 * read under the lock, so a worker that arrived after the first look still stops the patch. A stored value of any kind counts, so
 * the guard does not lower for a value that is not text.
 */
export const changeItemIn = (
  doc: BoardDoc,
  id: string,
  changes: ItemChanges,
  workerField: string | undefined,
): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  if (
    workerField !== undefined &&
    Object.hasOwn(changes.fields, workerField) &&
    Object.hasOwn(found.value.record, workerField) &&
    changes.fields[workerField] !== found.value.record[workerField]
  ) {
    return usageError(workerFieldGuard.message(id), workerFieldGuard.remedy(id));
  }
  if (changes.track !== undefined) {
    const track = requireTrack(doc, changes.track);
    if (!track.ok) return track;
  }
  const entries: [string, unknown][] = [];
  if (changes.title !== undefined) entries.push([boardKeys.title, changes.title]);
  if (changes.track !== undefined) entries.push([boardKeys.track, changes.track]);
  if (changes.text !== undefined) entries.push([boardKeys.text, changes.text]);
  entries.push(...Object.entries(changes.fields));
  const next = withKeys(found.value.record, entries);
  return ok({ top: next.changed ? withItem(doc, id, next.record) : null, value: id });
};

/** Set the state or the stage of an item. The other of the two stays as it is. */
export const moveItemIn = (doc: BoardDoc, id: string, move: CheckedMove): CliResult<Edit<ItemMoved>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const from = move.key === boardKeys.status ? found.value.status : found.value.stage;
  const moved: ItemMoved = { id, from, to: move.value, changed: from !== move.value };
  if (!moved.changed) return ok({ top: null, value: moved });
  return ok({ top: withItem(doc, id, withKeys(found.value.record, [[move.key, move.value]]).record), value: moved });
};

/** Set the closed state of an item. The stage and every other key stay. The value is the id. */
export const closeItemIn = (doc: BoardDoc, id: string, closed: string): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const next = withKeys(found.value.record, [[boardKeys.status, closed]]);
  return ok({ top: next.changed ? withItem(doc, id, next.record) : null, value: id });
};

/** The stage and the closed state that a merge record sets: the merged stage must be in the recipe, and the setup must name a closed state. */
export const checkMergeSetup = (setup: BoardSetup): CliResult<{ readonly stage: string; readonly closed: string }> => {
  const stage = requireStage(setup.recipe, mergedStage);
  if (!stage.ok) return stage;
  const closed = checkClose(setup);
  return closed.ok ? ok({ stage: stage.value, closed: closed.value }) : closed;
};

/** The worker field of the setup, else a usage error (exit 2): without a worker field no item has a worker to take off. */
export const checkWorkerField = (setup: BoardSetup): CliResult<string> => {
  const field = setup.config?.worker_field;
  return field === undefined ? usageError(`the setup names no ${roles.worker} field, so no item has a ${roles.worker}`) : ok(field);
};

/** The queue rows without the item. A row that lists it loses it, and a row that becomes empty goes. Every other row stays as it is. */
const queueWithout = (doc: BoardDoc, id: string): { readonly rows: readonly Stored[]; readonly changed: boolean } => {
  const rows: Stored[] = [];
  let changed = false;
  for (const row of doc.queue) {
    const listed = rowItemsOf(row);
    if (!listed.includes(id)) {
      rows.push(row);
      continue;
    }
    changed = true;
    const left = listed.filter((entry) => entry !== id);
    if (left.length > 0) rows.push({ ...row, [boardKeys.items]: left });
  }
  return { rows, changed };
};

/**
 * Record a merge in the item and the queue, in one top object. The item gets the merged stage (any listed stage, also one that only
 * a flow sets), the closed state and the head sha of the PR (`merged.prHead`; the merge commit goes to the message of the commit
 * only). The id leaves each queue row that lists it. The value is true when the board changes.
 *
 * `workerName` is the worker that the merge check bound to the item (null for none). The item must still hold exactly that worker
 * in the worker field, else the merge check read another item than the one that is on the board now: exit 1, nothing changes. An
 * item that records another head sha is exit 1 too. An item that holds the stage, the state and the head sha already, and that no
 * queue row lists, is a rerun: the edit gives no top object.
 */
export const recordMergeIn = (
  doc: BoardDoc,
  setup: BoardSetup,
  id: string,
  merged: MergedPr,
  workerName: string | null,
): CliResult<Edit<boolean>> => {
  const target = checkMergeSetup(setup);
  if (!target.ok) return target;
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const { record } = found.value;
  const workerField = setup.config?.worker_field;
  const holds = workerField !== undefined && Object.hasOwn(record, workerField) ? record[workerField] : null;
  if (holds !== workerName) {
    return failure(
      `the ${roles.worker} field of ${id} changed after the merge check`,
      `Run "${commandText(commandLines.itemMerged)} ${id} ${flagText(flags.pr)} ${merged.number}" again.`,
    );
  }
  if (Object.hasOwn(record, boardKeys.mergedPrHead) && record[boardKeys.mergedPrHead] !== merged.prHead) {
    return failure(`${id} records the merge of another PR head already`);
  }
  const next = withKeys(record, [
    [boardKeys.status, target.value.closed],
    [boardKeys.stage, target.value.stage],
    [boardKeys.mergedPrHead, merged.prHead],
  ]);
  const queue = queueWithout(doc, id);
  if (!next.changed && !queue.changed) return ok({ top: null, value: false });
  const top = withItem(doc, id, next.record);
  return ok({ top: queue.changed ? { ...top, [doc.queueKey]: queue.rows } : top, value: true });
};

/** The former workers of an item, else a failure (exit 1) when the stored value is not a list of text. */
const formerWorkersOf = (record: Stored, id: string): CliResult<readonly string[]> => {
  const stored = record[boardKeys.unassignedFrom];
  if (stored === undefined) return ok([]);
  if (Array.isArray(stored) && stored.every((entry): entry is string => typeof entry === 'string')) return ok(stored);
  return failure(`${files.board}: the "${boardKeys.unassignedFrom}" of ${id} is not a list of text`);
};

/**
 * Take the worker off an item: delete the worker key and add the worker to the list of former workers of the item, once. The state,
 * the stage and every other key stay. A worker field that does not hold text is a usage error (exit 2), and so is a list of former
 * workers that is full and does not name the worker (`markLimits.maxFormerWorkers`): the edit then stops, so the worker field
 * stays guarded. A stored list that is not a list of text is a failure (exit 1). The value is the former worker.
 */
export const unassignIn = (doc: BoardDoc, id: string, workerField: string): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const { record } = found.value;
  const worker = Object.hasOwn(record, workerField) ? record[workerField] : undefined;
  if (typeof worker !== 'string') return usageError(`the item ${id} has no ${roles.worker} to take off`);
  const former = formerWorkersOf(record, id);
  if (!former.ok) return former;
  const named = former.value.includes(worker);
  if (!named && former.value.length >= markLimits.maxFormerWorkers) {
    return usageError(`the item ${id} names ${markLimits.maxFormerWorkers} former ${roles.worker}s already, so it takes no more`);
  }
  const without = Object.fromEntries(Object.entries(record).filter(([key]) => key !== workerField));
  const marked = named ? without : withKeys(without, [[boardKeys.unassignedFrom, [...former.value, worker]]]).record;
  return ok({ top: withItem(doc, id, marked), value: worker });
};

/** Add a path to the `docs` of an item. A path that the item has stays once. The value is the id. */
export const linkDocIn = (doc: BoardDoc, id: string, path: string): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const docs = found.value.record[boardKeys.docs];
  if (docs !== undefined && !(Array.isArray(docs) && docs.every((entry) => typeof entry === 'string'))) {
    return failure(`${files.board}: the "${boardKeys.docs}" of ${id} is not a list of text`);
  }
  const current: readonly unknown[] = docs ?? [];
  if (current.includes(path)) return ok({ top: null, value: id });
  return ok({ top: withItem(doc, id, withKeys(found.value.record, [[boardKeys.docs, [...current, path]]]).record), value: id });
};

/**
 * Add a track at the end of the list. The first track creates the `tracks` key at the end of the file. A track id that exists, and a
 * 31st track, are usage errors (exit 2). The value is the id.
 */
export const addTrackIn = (doc: BoardDoc, track: TrackAddInput): CliResult<Edit<string>> => {
  if (doc.tracks.some((entry) => entry.id === track.id)) return usageError(`the track ${track.id} exists already`);
  if (doc.tracks.length >= trackLimits.maxTracks) return usageError(`the board has at most ${trackLimits.maxTracks} tracks`);
  const stored = { [boardKeys.id]: track.id, [boardKeys.name]: track.name, [boardKeys.roadmap]: track.roadmap };
  return ok({ top: { ...doc.top, [boardKeys.tracks]: [...listAt(doc.top, boardKeys.tracks), stored] }, value: track.id });
};

/**
 * Add a decision to the waiting file. Its id is the number after the highest `D-n` of the waiting file, of the decision log and of
 * the decision records of the owner (`storeIds`), counted on the texts that were read under the lock. The value is the id.
 */
export const askIn = (
  waiting: WaitingDoc,
  log: DecisionLogDoc,
  decision: CheckedDecision,
  storeIds: readonly string[],
): CliResult<Edit<string> & { readonly top: Stored }> => {
  const id = nextId('D-', [...waiting.items.map((entry) => entry.id), ...log.rows.map((row) => row.id), ...storeIds]);
  if (!id.ok) return id;
  const stored = {
    [waitingKeys.id]: id.value,
    [decisionKeys.title]: decision.title,
    [decisionKeys.question]: decision.question,
    [decisionKeys.options]: decision.options,
  };
  return ok({ top: { ...waiting.top, [waitingKeys.items]: [...listAt(waiting.top, waitingKeys.items), stored] }, value: id.value });
};

/** The new top objects of the waiting file and of the decision log after a close, and the request that the close took off. */
export interface RequestCloseEdit {
  readonly waiting: Stored;
  readonly log: Stored;
  readonly closed: RequestClosed;
}

/**
 * The new top objects of the waiting file and of the decision log when a request leaves the waiting file and a row takes its place at
 * the end of the log. Every other entry of both files stays as it is. A close and an answer of the owner both use it.
 */
export const settleRequestIn = (
  waiting: WaitingDoc,
  log: DecisionLogDoc,
  id: string,
  row: Stored,
): { readonly waiting: Stored; readonly log: Stored } => ({
  waiting: { ...waiting.top, [waitingKeys.items]: waiting.items.filter((entry) => entry.id !== id).map((entry) => entry.record) },
  log: { ...log.top, [decisionLogKeys.rows]: [...listAt(log.top, decisionLogKeys.rows), row] },
});

declare const checkedSettlementMark: unique symbol;

/** A settlement that `checkSettlement` made: its decider is a value of `requestDeciders` and its decision is one clean line. */
export type CheckedSettlement = RequestSettlement & { readonly [checkedSettlementMark]: true };

const DECIDERS: readonly string[] = Object.values(requestDeciders);

/** True for a value that is a decider of `requestDeciders`. Any other value is not a decider. */
export const isDecider = (value: unknown): value is RequestDecider => typeof value === 'string' && DECIDERS.includes(value);

/**
 * The checked form of a settlement: the decider is a value of `requestDeciders`, so the owner is never one, and the decision text is
 * one line of at most `boardTextLimits.maxTextChars`. A relayed settlement has the coordinator as its decider. A fault is a usage
 * error (exit 2). This is the only function that makes a `CheckedSettlement`, so `closeRequestIn` and `logDecisionIn` take no
 * settlement that skipped the check.
 */
const settle = (settlement: RequestSettlement): CliResult<CheckedSettlement> => {
  if (!isDecider(settlement.decider)) return usageError(`the decider must be ${DECIDERS.join(' or ')}`);
  if (settlement.relayed === true && settlement.decider !== requestDeciders.coordinator) {
    return usageError(`a relayed answer names the ${requestDeciders.coordinator} as its decider`);
  }
  const decision = lineOf(decisionLogKeys.decision, settlement.decision, boardTextLimits.maxTextChars);
  if (!decision.ok) return decision;
  return ok({
    decider: settlement.decider,
    decision: decision.value,
    ...(settlement.relayed === true ? { relayed: true } : {}),
  } as CheckedSettlement);
};

/** The settlement of a close, checked before the lock. A close with no settlement stays with none. */
export const checkSettlement = (settlement: RequestSettlement | undefined): CliResult<CheckedSettlement | undefined> =>
  settlement === undefined ? ok(undefined) : settle(settlement);

/** The title and the settlement of a logged decision, checked before the lock. */
export interface CheckedLogEntry {
  readonly title: string;
  readonly settlement: CheckedSettlement;
}

/** A logged decision: a one-line title, and a decision with a decider that is never the owner. A fault is a usage error (exit 2). */
export const checkLogEntry = (input: DecisionLogInput): CliResult<CheckedLogEntry> => {
  const title = lineOf('title', input.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const settlement = settle({ decider: input.decider, decision: input.decision });
  return settlement.ok ? ok({ title: title.value, settlement: settlement.value }) : settlement;
};

/**
 * Take a request off the waiting file and add a row for it to the decision log, so the number of the request stays used. The row
 * holds the id and the title in its `item` text, the decision text and the date. With a settlement, the decision text is the text of
 * the settlement and the row names its decider; without one, the text says that the request closed with no answer. A relayed
 * settlement adds the fixed relayed marker (`relayedMarker`) to the row. The row never holds the owner key `by`, so no reader counts
 * it as an owner answer. A request that is not in the waiting file is a usage error (exit 2).
 * A log that names the id already is a failure (exit 1), because the log would name the id twice. Every other entry of both files
 * stays as it is.
 */
export const closeRequestIn = (
  waiting: WaitingDoc,
  log: DecisionLogDoc,
  id: string,
  date: string,
  settlement?: CheckedSettlement,
): CliResult<RequestCloseEdit> => {
  const found = waiting.items.find((entry) => entry.id === id);
  if (found === undefined) return usageError(`${files.waiting} has no ${requestWords.request} ${shown(id)}`);
  if (log.rows.some((row) => row.id === id)) return failure(`${files.decisionLog}: the id ${id} is used already`);
  const title = requestTitleOf(found);
  const row = {
    [decisionLogKeys.item]: title === null ? id : `${id}: ${title.trim()}`,
    [decisionLogKeys.decision]: settlement?.decision ?? requestWords.closedDecision,
    [decisionLogKeys.date]: date,
    ...(settlement === undefined ? {} : { [decisionLogKeys.decider]: settlement.decider }),
    ...(settlement?.relayed === true ? { [decisionLogKeys.relayed]: relayedMarker } : {}),
  };
  return ok({ ...settleRequestIn(waiting, log, id, row), closed: { id, title, decider: settlement?.decider ?? null } });
};

/**
 * Add a row to the decision log for a decision that no request asked for. The id is the number after the highest `D-n` of the waiting
 * file, of the decision log and of the decision records of the owner (`storeIds`), as `askIn` counts. The row holds the id and the
 * title in its `item` text, the decision, the date and the decider. It holds no owner key, and the waiting file gets no entry. The
 * value is the new id.
 */
export const logDecisionIn = (
  waiting: WaitingDoc,
  log: DecisionLogDoc,
  settlement: CheckedSettlement,
  title: string,
  date: string,
  storeIds: readonly string[],
): CliResult<Edit<string> & { readonly top: Stored }> => {
  const id = nextId('D-', [...waiting.items.map((entry) => entry.id), ...log.rows.map((row) => row.id), ...storeIds]);
  if (!id.ok) return id;
  const row = {
    [decisionLogKeys.item]: `${id.value}: ${title}`,
    [decisionLogKeys.decision]: settlement.decision,
    [decisionLogKeys.date]: date,
    [decisionLogKeys.decider]: settlement.decider,
  };
  return ok({ top: { ...log.top, [decisionLogKeys.rows]: [...listAt(log.top, decisionLogKeys.rows), row] }, value: id.value });
};

/** True when the stored value is a list that holds exactly these ids, in this order. */
const holdsItems = (stored: unknown, items: readonly string[]): boolean =>
  Array.isArray(stored) && stored.length === items.length && items.every((id, at) => stored[at] === id);

/** A required field of the rows that the new row does not set, or undefined. */
const missingRowField = (setup: BoardSetup, fields: FieldValues): string | undefined =>
  declaredFields(setup.config, rowTarget).find((field) => field.required && !Object.hasOwn(fields, field.name))?.name;

/**
 * Add a row to the queue, change a row, or move it. The row is found by its name: a name that no row has makes a new row, and a name
 * that two rows have is a usage error. Every item id must be on the board (a closed item is). A new row needs every required field of
 * the rows, and the queue holds at most `queueLimits.maxRows` rows. A part that is left out stays as it is, and a change keeps every
 * other key of the row, the release flag among them. A row with the values that it has, at the place that it has, changes nothing.
 */
export const setRowIn = (doc: BoardDoc, setup: BoardSetup, row: CheckedRow): CliResult<Edit<QueueRowSet>> => {
  const matches = doc.queue.flatMap((record, at) => (rowNameOf(record) === row.name ? [at] : []));
  if (matches.length > 1) return usageError(`the queue has two rows with the name ${shown(row.name)}`);
  const unknown = row.items?.find((id) => !doc.items.some((item) => item.id === id));
  if (unknown !== undefined) return usageError(`${files.board} has no item ${unknown}`);
  const old = matches[0];
  const created = old === undefined;
  if (created) {
    if (doc.queue.length >= queueLimits.maxRows) return usageError(`the queue has at most ${queueLimits.maxRows} rows`);
    const missing = missingRowField(setup, row.fields);
    if (missing !== undefined) return usageError(`the field ${missing} is required`);
  }
  // The places are counted from 1. A new row can go after the last row, and an old row stays in the places of the queue.
  const lastPlace = created ? doc.queue.length + 1 : doc.queue.length;
  if (row.position !== undefined && row.position > lastPlace) return usageError(`the position is 1 to ${lastPlace}`);
  const place = row.position ?? (created ? lastPlace : old + 1);
  const current: Stored = created ? { [boardKeys.name]: row.name } : (doc.queue[old] ?? {});
  const entries: [string, unknown][] = [];
  const itemsChanged = created || (row.items !== undefined && !holdsItems(current[boardKeys.items], row.items));
  if (itemsChanged) entries.push([boardKeys.items, row.items ?? []]);
  if (row.note !== undefined) entries.push([boardKeys.note, row.note]);
  entries.push(...Object.entries(row.fields));
  const next = withKeys(current, entries);
  const others = created ? doc.queue : doc.queue.filter((_, at) => at !== old);
  const rows = [...others.slice(0, place - 1), next.record, ...others.slice(place - 1)];
  const changed = created || next.changed || place !== old + 1;
  const value: QueueRowSet = { name: row.name, position: place, items: rowItemsOf(next.record), created, changed };
  return ok({ top: changed ? { ...doc.top, [doc.queueKey]: rows } : null, value });
};
