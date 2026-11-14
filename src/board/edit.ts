import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { displayLine, removedByDisplay } from '../cli/output.js';
import type { BoardConfig } from '../config/schema.js';
import { dotRuleReason, type NameCompare } from '../core/place-rule.js';
import { projectFolderKey } from '../core/project-path.js';
import { ok, type Err } from '../core/result.js';
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
  optionKeys,
  places,
  queueLimits,
  relayedMarker,
  requestDeciders,
  requestGroups,
  requestWords,
  roles,
  trackLimits,
  waitingKeys,
  workerFieldGuard,
} from '../names.js';
import type { CheckedRecord, RecipeBoard } from '../recipes/entry.js';
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
  RequestGroup,
  RequestSettlement,
  TrackAddInput,
} from './contract.js';
import { declaredFields, itemTarget, resolveFields, rowTarget, type FieldInput } from './fields.js';
import type { BoardDoc, DecisionLogDoc, WaitingDoc } from './files.js';
import { rowItemsOf, rowNameOf, rowReleaseGroupOf } from './queue.js';
import { requestTitleOf } from './requests.js';
import { firstStageOf, requireSettableStage, requireStage, stagesOf } from './stages.js';
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

/** One line as `lineOf` checks it, and a view shows it whole: a character that the display removes is refused (exit 2). */
const shownLineOf = (what: string, text: string, max: number): CliResult<string> => {
  const line = lineOf(what, text, max);
  if (!line.ok) return line;
  return removedByDisplay(line.value) ? usageError(`the ${what} holds a character that the screen does not show`) : line;
};

const optionalShownLineOf = (what: string, text: string | undefined, max: number): CliResult<string | undefined> =>
  text === undefined ? ok(undefined) : shownLineOf(what, text, max);

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
  readonly epic: string | undefined;
  readonly status: string;
  readonly stage: string | null;
  /** The stage list of the recipe at the add. It is empty for a recipe with no list, and the item then stores no `stages` key. */
  readonly stages: readonly string[];
  readonly fields: FieldValues;
}

/**
 * A new item: the first state of the setup, the first stage of the recipe with a copy of the stage list, and the checked title,
 * text, epic and fields.
 */
export const checkNewItem = (setup: BoardSetup, input: ItemAddInput): CliResult<NewItem> => {
  const [status] = setup.config?.states ?? [];
  if (status === undefined) return usageError(NO_STATES);
  const title = lineOf('title', input.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const text = optionalLineOf('text', input.text, boardTextLimits.maxTextChars);
  if (!text.ok) return text;
  const epic = optionalShownLineOf(boardKeys.epic, input.epic, boardTextLimits.maxEpicChars);
  if (!epic.ok) return epic;
  const fields = resolveFields(setup.config, itemTarget, inputsOf(input.fields), { complete: true });
  if (!fields.ok) return fields;
  return ok({
    title: title.value,
    text: text.value,
    track: input.track,
    epic: epic.value,
    status,
    stage: firstStageOf(setup.recipe),
    stages: [...stagesOf(setup.recipe)],
    fields: fields.value,
  });
};

export interface ItemChanges {
  readonly title: string | undefined;
  readonly text: string | undefined;
  readonly track: string | undefined;
  readonly epic: string | undefined;
  readonly fields: FieldValues;
  /**
   * The refusal of an empty value for the worker field, held back until the item is read under the lock. An item that holds a worker
   * answers it with the remedy of the worker field guard, and any other item answers it with this refusal. No write holds an empty value.
   */
  readonly emptyWorker: Err<CliError> | undefined;
}

/**
 * The parts of a change of an item. A part that is left out stays as it is. An empty value for the worker field is not refused here:
 * `changeItemIn` refuses it once it knows whether the item holds a worker.
 */
export const checkPatch = (setup: BoardSetup, patch: ItemPatch): CliResult<ItemChanges> => {
  const title = optionalLineOf('title', patch.title, boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const text = optionalLineOf('text', patch.text, boardTextLimits.maxTextChars);
  if (!text.ok) return text;
  const epic = optionalShownLineOf(boardKeys.epic, patch.epic, boardTextLimits.maxEpicChars);
  if (!epic.ok) return epic;
  const inputs = inputsOf(patch.fields);
  const workerField = setup.config?.worker_field;
  const emptied = inputs.filter((input) => input.name === workerField && input.value === '');
  const held = emptied.length === 1 && inputs.filter((input) => input.name === workerField).length === 1;
  const fields = resolveFields(setup.config, itemTarget, held ? inputs.filter((input) => !emptied.includes(input)) : inputs, { complete: false });
  if (!fields.ok) return fields;
  const refusal = held ? resolveFields(setup.config, itemTarget, emptied, { complete: false }) : undefined;
  return ok({
    title: title.value,
    text: text.value,
    track: patch.track,
    epic: epic.value,
    fields: fields.value,
    emptyWorker: refusal === undefined || refusal.ok ? undefined : refusal,
  });
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
  readonly group: RequestGroup;
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
  return ok({ title: title.value, question: question.value, options: stored, group: input.group ?? requestGroups.now });
};

/**
 * Why a path can not be linked. A `form` fault is a path that is no plain path of the factory folder (a usage error, exit 2). A
 * `place` fault is a plain path that the place rule refuses (a security stop, exit 4). The reason is a phrase for a message
 * ("the path ... <reason>"). It holds no more of the path than one part, cut to the width of an echo.
 */
export interface DocPathIssue {
  readonly kind: 'form' | 'place';
  readonly reason: string;
}

/** The doc place rule compares a name with a fixed name in any letter case, on every platform. */
const sameDocName: NameCompare = (a, b) => projectFolderKey(a) === projectFolderKey(b);

const plainPathFault = (path: string): string | null => {
  if (path === '') return 'is empty';
  if (holdsBreak(path) || removedByDisplay(path)) return 'holds a line break, a control character, a hidden character or a mark of text direction';
  if (path.length > boardTextLimits.maxDocPathChars) return `is longer than ${boardTextLimits.maxDocPathChars} characters`;
  if (path.includes('\\')) return 'holds a backslash';
  return isPlainPath(path) ? null : `is not a plain relative path inside the ${places.folder}`;
};

/**
 * The one name check of the doc rule, or null for a path that passes. It reads the path text and no file. The write (`checkDocPath`)
 * and every view of a stored path call it, so they agree on each path. The checks run in this order: a plain path with no hidden
 * character, then the place rule. The place rule refuses the local config at the top of the factory folder, in any letter case, and
 * a part that starts with a dot. It has no exception for the orders folder.
 */
export const docPathIssue = (path: string): DocPathIssue | null => {
  const fault = plainPathFault(path);
  if (fault !== null) return { kind: 'form', reason: fault };
  const place = dotRuleReason(path.split('/'), { atFactoryTop: true, ordersException: false, sameName: sameDocName });
  return place === null ? null : { kind: 'place', reason: `is refused: ${displayLine(place, maxEchoChars)}` };
};

export const checkDocPath = (path: string): CliResult<string> => {
  const issue = docPathIssue(path);
  if (issue === null) return ok(path);
  const message = `the path ${shown(path)} ${issue.reason}`;
  return issue.kind === 'form'
    ? usageError(message)
    : safetyRefusal(
        message,
        `Link a file whose path has no part that starts with a dot. Do not link the ${files.localConfig} of the ${places.folder}. Then run "${commandText(commandLines.itemDoc)}" again with that file.`,
      );
};

/** A request id of the form `D-n`. The form check comes first, because the id goes into the text of a commit. */
export const checkRequestId = (id: string): CliResult<string> =>
  boardIds.request.test(id) ? ok(id) : usageError(`${shown(id)} is not a ${requestWords.request} id; a ${requestWords.request} id looks like D-12`);

/** The row of a queue write after its input check: the optional parts are as the person gave them. */
export interface CheckedRow {
  readonly name: string;
  readonly items: readonly string[] | undefined;
  readonly note: string | undefined;
  readonly releaseGroup: string | undefined;
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
 * A queue write: a one-line name and note, a release group of one clean line, item ids of the form `B-n` with no repeat, owner fields
 * of the row that the setup declares, and a position from 1. Whether the items are on the board, and whether a field is required,
 * depend on the board and wait for the edit under the lock.
 */
export const checkQueueRow = (setup: BoardSetup, input: QueueRowInput): CliResult<CheckedRow> => {
  const name = lineOf(boardKeys.name, input.name, boardTextLimits.maxTitleChars);
  if (!name.ok) return name;
  const note = optionalLineOf(boardKeys.note, input.note, boardTextLimits.maxTextChars);
  if (!note.ok) return note;
  const releaseGroup = optionalShownLineOf(boardKeys.releaseGroup, input.releaseGroup, boardTextLimits.maxReleaseGroupChars);
  if (!releaseGroup.ok) return releaseGroup;
  if (input.items !== undefined) {
    const items = rowItemsIssue(input.items);
    if (!items.ok) return items;
  }
  const fields = resolveFields(setup.config, rowTarget, inputsOf(input.fields), { complete: false });
  if (!fields.ok) return fields;
  if (input.position !== undefined && !(Number.isInteger(input.position) && input.position >= 1)) {
    return usageError('the position is a whole number from 1');
  }
  return ok({ name: name.value, items: input.items, note: note.value, releaseGroup: releaseGroup.value, fields: fields.value, position: input.position });
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

/**
 * Add the item. The value is its new id: the number after the highest one on the board. A new item that has a stage gets `at`, the
 * exact time of the add, as the time of its stage (`boardKeys.stageAt`). The item keeps a copy of the stage list of the recipe
 * (`boardKeys.stages`), fixed at the add, and a recipe with no list stores no key. The epic is stored only when the add has one.
 */
export const addItemIn = (doc: BoardDoc, item: NewItem, at: string): CliResult<Edit<string>> => {
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
  if (item.stage !== null) entries.push([boardKeys.stage, item.stage], [boardKeys.stageAt, at]);
  if (item.stages.length > 0) entries.push([boardKeys.stages, item.stages]);
  if (item.track !== undefined) entries.push([boardKeys.track, item.track]);
  if (item.text !== undefined) entries.push([boardKeys.text, item.text]);
  if (item.epic !== undefined) entries.push([boardKeys.epic, item.epic]);
  entries.push(...Object.entries(item.fields));
  return ok({ top: withItems(doc, [...doc.items.map((entry) => entry.record), Object.fromEntries(entries)]), value: id.value });
};

/**
 * Change the title, the text, the track, the epic and the fields of an item. The value is the id. An epic is set or replaced and is
 * never cleared, and the stage list of the item stays as the add stored it.
 *
 * The worker field guard: when the patch holds the worker field, and the stored item has the key, a new value that differs from the
 * stored one, or an empty value, is a usage error (exit 2) that names the command that takes a worker off an item. Only `unassignIn`
 * removes a worker. An empty value for an item with no worker key is refused as `checkPatch` held it back. An item with no worker key
 * takes a worker, and a patch with the stored value changes nothing. The guard reads the item that was
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
  if (workerField !== undefined && Object.hasOwn(found.value.record, workerField)) {
    const changed = Object.hasOwn(changes.fields, workerField) && changes.fields[workerField] !== found.value.record[workerField];
    if (changed || changes.emptyWorker !== undefined) return usageError(workerFieldGuard.message(id), workerFieldGuard.remedy(id));
  }
  if (changes.emptyWorker !== undefined) return changes.emptyWorker;
  if (changes.track !== undefined) {
    const track = requireTrack(doc, changes.track);
    if (!track.ok) return track;
  }
  const entries: [string, unknown][] = [];
  if (changes.title !== undefined) entries.push([boardKeys.title, changes.title]);
  if (changes.track !== undefined) entries.push([boardKeys.track, changes.track]);
  if (changes.text !== undefined) entries.push([boardKeys.text, changes.text]);
  if (changes.epic !== undefined) entries.push([boardKeys.epic, changes.epic]);
  entries.push(...Object.entries(changes.fields));
  const next = withKeys(found.value.record, entries);
  return ok({ top: next.changed ? withItem(doc, id, next.record) : null, value: id });
};

/**
 * Set the state or the stage of an item. The other of the two stays as it is. A move that changes the stage sets `at`, the exact
 * time of the move, as the time of the stage (`boardKeys.stageAt`). A move of the state, and a move to the stage that the item has,
 * leave the stored time as it is.
 */
export const moveItemIn = (doc: BoardDoc, id: string, move: CheckedMove, at: string): CliResult<Edit<ItemMoved>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const from = move.key === boardKeys.status ? found.value.status : found.value.stage;
  const moved: ItemMoved = { id, from, to: move.value, changed: from !== move.value };
  if (!moved.changed) return ok({ top: null, value: moved });
  const entries: (readonly [string, unknown])[] = [[move.key, move.value]];
  if (move.key === boardKeys.stage) entries.push([boardKeys.stageAt, at]);
  return ok({ top: withItem(doc, id, withKeys(found.value.record, entries).record), value: moved });
};

/** Set the closed state of an item. The stage and every other key stay. The value is the id. */
export const closeItemIn = (doc: BoardDoc, id: string, closed: string): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const next = withKeys(found.value.record, [[boardKeys.status, closed]]);
  return ok({ top: next.changed ? withItem(doc, id, next.record) : null, value: id });
};

/**
 * The stage and the closed state that a record sets: the stage of the record check must be in the recipe (also one that only a flow
 * sets), and the setup must name a closed state.
 */
export const checkRecordSetup = (
  setup: BoardSetup,
  recordStage: string,
): CliResult<{ readonly stage: string; readonly closed: string }> => {
  const stage = requireStage(setup.recipe, recordStage);
  if (!stage.ok) return stage;
  const closed = checkClose(setup);
  return closed.ok ? ok({ stage: stage.value, closed: closed.value }) : closed;
};

/** The setup check for a record that passed, before the lock: the stage of the record must be in the recipe, and the setup must name a closed state. */
export const checkRecorded = (setup: BoardSetup, checked: CheckedRecord): CliResult<void> => {
  const target = checkRecordSetup(setup, checked.stage);
  return target.ok ? ok(undefined) : target;
};

/** The message of the commit that records a passed check: the item, the stage and the summary of the check. */
export const recordMessage = (id: string, checked: CheckedRecord): string =>
  `chore: record item ${id} as ${checked.stage} (${checked.summary})`;

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

/** The id of an item other than `id` that records `head`, or undefined when no other item does. */
const headHolderIn = (doc: BoardDoc, id: string, head: string): string | undefined =>
  doc.items.find((other) => other.id !== id && other.record[boardKeys.mergedPrHead] === head)?.id;

/**
 * Record a passed check in the item and the queue, in one top object. The item gets the stage of the check (any listed stage, also
 * one that only a flow sets), the closed state and the head of the check (`checked.head`; the rest of the summary goes to the
 * message of the commit only). The id leaves each queue row that lists it. The value is true when the board changes.
 *
 * `workerName` is the worker that the check bound to the item (null for none). The item must still hold exactly that worker in the
 * worker field, else the check read another item than the one that is on the board now: exit 1, nothing changes. An item that
 * records another head is exit 1 too, and so is an item whose check gives a head that another item records already: a later guard
 * trusts the recorded head, so one head belongs to one item. This test reads the board under the lock, so it holds against a race.
 * An item that holds the stage, the state and the head already, and that no queue row lists, is a rerun: the edit gives no top object.
 * A rerun of an item that records the head is not tested against the other items, so it stays a success.
 *
 * The item gets `at`, the exact time of the record, as the time of its stage (`boardKeys.stageAt`) only when the stored stage differs
 * from the stage of the check. An item that holds the stage already keeps its stored time, so a rerun changes nothing.
 */
export const recordCheckedIn = (
  doc: BoardDoc,
  setup: BoardSetup,
  id: string,
  checked: CheckedRecord,
  workerName: string | null,
  at: string,
): CliResult<Edit<boolean>> => {
  const target = checkRecordSetup(setup, checked.stage);
  if (!target.ok) return target;
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const { record } = found.value;
  const workerField = setup.config?.worker_field;
  const holds = workerField !== undefined && Object.hasOwn(record, workerField) ? record[workerField] : null;
  if (holds !== workerName) {
    return failure(
      `the ${roles.worker} field of ${id} changed after the check`,
      `Run "${commandText(commandLines.itemRecord)} ${id} ${flagText(flags.ref)} ${displayLine(checked.ref, maxEchoChars)}" again.`,
    );
  }
  if (Object.hasOwn(record, boardKeys.mergedPrHead) && record[boardKeys.mergedPrHead] !== checked.head) {
    return failure(`${id} records another head already`);
  }
  const holder = record[boardKeys.mergedPrHead] === checked.head ? undefined : headHolderIn(doc, id, checked.head);
  if (holder !== undefined) {
    return failure(
      `the item ${holder} records the head of this check already`,
      `Check the item and the reference, then run "${commandText(commandLines.itemRecord)} ${id} ${flagText(flags.ref)} ${displayLine(checked.ref, maxEchoChars)}" again.`,
    );
  }
  const entries: (readonly [string, unknown])[] = [
    [boardKeys.status, target.value.closed],
    [boardKeys.stage, target.value.stage],
    [boardKeys.mergedPrHead, checked.head],
  ];
  if (record[boardKeys.stage] !== target.value.stage) entries.push([boardKeys.stageAt, at]);
  const next = withKeys(record, entries);
  const queue = queueWithout(doc, id);
  if (!next.changed && !queue.changed) return ok({ top: null, value: false });
  const top = withItem(doc, id, next.record);
  return ok({ top: queue.changed ? { ...top, [doc.queueKey]: queue.rows } : top, value: true });
};

/**
 * The former workers of an item, else a failure (exit 1) when the stored value is not a list of text. The remedy of the failure
 * names the command that the caller ran (a name from `commandLines`) and the words that follow it, so the person can run it again.
 */
export const formerWorkersOf = (record: Stored, id: string, command: string, rest: string): CliResult<readonly string[]> => {
  const stored = record[boardKeys.unassignedFrom];
  if (stored === undefined) return ok([]);
  if (Array.isArray(stored) && stored.every((entry): entry is string => typeof entry === 'string')) return ok(stored);
  return failure(
    `${files.board}: the "${boardKeys.unassignedFrom}" of ${id} is not a list of text`,
    `Check the item in ${files.board}, then run "${commandText(command)}${rest}" again.`,
  );
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
  const again = `${commandText(commandLines.itemUnassign)} ${id}`;
  if (!Object.hasOwn(record, workerField)) return usageError(`the item ${id} has no ${roles.worker} to take off`);
  const worker = record[workerField];
  if (typeof worker !== 'string') {
    return usageError(`the ${roles.worker} field of ${id} does not hold text`, `Check the item in ${files.board}, then run "${again}" again.`);
  }
  const former = formerWorkersOf(record, id, commandLines.itemUnassign, ` ${id}`);
  if (!former.ok) return former;
  const named = former.value.includes(worker);
  if (!named && former.value.length >= markLimits.maxFormerWorkers) {
    return usageError(
      `the item ${id} names ${markLimits.maxFormerWorkers} former ${roles.worker}s already, so it takes no more`,
      `Take a former ${roles.worker} out of the "${boardKeys.unassignedFrom}" of the item in ${files.board}, then run "${again}" again.`,
    );
  }
  const without = Object.fromEntries(Object.entries(record).filter(([key]) => key !== workerField));
  const marked = named ? without : withKeys(without, [[boardKeys.unassignedFrom, [...former.value, worker]]]).record;
  return ok({ top: withItem(doc, id, marked), value: worker });
};

/**
 * Add a path to the `docs` of an item. A path that the item has stays once. A new path is a usage error (exit 2) when the item holds
 * `boardTextLimits.maxItemDocs` paths already; a longer list that a hand edit made is read as it is. The value is the id.
 */
export const linkDocIn = (doc: BoardDoc, id: string, path: string): CliResult<Edit<string>> => {
  const found = itemAt(doc, id);
  if (!found.ok) return found;
  const docs = found.value.record[boardKeys.docs];
  if (docs !== undefined && !(Array.isArray(docs) && docs.every((entry) => typeof entry === 'string'))) {
    return failure(`${files.board}: the "${boardKeys.docs}" of ${id} is not a list of text`);
  }
  const current: readonly unknown[] = docs ?? [];
  if (current.includes(path)) return ok({ top: null, value: id });
  if (current.length >= boardTextLimits.maxItemDocs) {
    return usageError(
      `the item ${id} holds ${boardTextLimits.maxItemDocs} docs already, so it takes no more`,
      `Take a path out of the "${boardKeys.docs}" of the item in ${files.board}, then run "${commandText(commandLines.itemDoc)}" again with the new path.`,
    );
  }
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
 * the decision records of the owner (`storeIds`), counted on the texts that were read under the lock. The row holds the time of the
 * add (`at`, an exact `toISOString()` time) and the group. The value is the id.
 */
export const askIn = (
  waiting: WaitingDoc,
  log: DecisionLogDoc,
  decision: CheckedDecision,
  storeIds: readonly string[],
  at: string,
): CliResult<Edit<string> & { readonly top: Stored }> => {
  const id = nextId('D-', [...waiting.items.map((entry) => entry.id), ...log.rows.map((row) => row.id), ...storeIds]);
  if (!id.ok) return id;
  const stored = {
    [waitingKeys.id]: id.value,
    [decisionKeys.title]: decision.title,
    [decisionKeys.question]: decision.question,
    [decisionKeys.options]: decision.options,
    [decisionKeys.openedAt]: at,
    [decisionKeys.group]: decision.group,
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
  if (row.releaseGroup !== undefined) entries.push([boardKeys.releaseGroup, row.releaseGroup]);
  entries.push(...Object.entries(row.fields));
  const next = withKeys(current, entries);
  const others = created ? doc.queue : doc.queue.filter((_, at) => at !== old);
  const rows = [...others.slice(0, place - 1), next.record, ...others.slice(place - 1)];
  const changed = created || next.changed || place !== old + 1;
  const value: QueueRowSet = {
    name: row.name,
    position: place,
    items: rowItemsOf(next.record),
    releaseGroup: rowReleaseGroupOf(next.record),
    created,
    changed,
  };
  return ok({ top: changed ? { ...doc.top, [doc.queueKey]: rows } : null, value });
};
