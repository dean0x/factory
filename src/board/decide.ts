import { failure, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { removedByDisplay, wrapText } from '../cli/output.js';
import { canonicalRequestText, requestHashOf } from '../core/request-hash.js';
import { ok, type Err } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';
import {
  boardIds,
  boardLimits,
  boardTextLimits,
  commandLines,
  commands,
  commandText,
  decisionKeys,
  decisionLogKeys,
  files,
  maxDisplayWidth,
  maxFileBytes,
  optionKeys,
  requestWords,
  roles,
  waitingKeys,
} from '../names.js';
import { shown } from './edit.js';
import type { DecisionRecordOption, DecisionRecordRequest } from './decision-record.js';
import type { DecisionLogDoc, WaitingDoc } from './files.js';
import { holdsBreak } from './text.js';

/**
 * The pure steps of `decide` (design 4.10, AC-14, AC-34, AC-35, AC-36, AC-39, AC-42, AC-43). Each step reads texts that the caller
 * has read and gives a result: none reads a file, a clock or the owner store. The caller runs them before the prompt and again
 * under the lock.
 *
 * `decide` shows exactly the text that the request hash covers. So the strict read refuses a text that the display changes, and
 * it never trims a text: the hash covers the stored strings. A message names a file and a part of the request and repeats no
 * stored text, except through the echo rule (`shown`).
 */

type Stored = Readonly<Record<string, unknown>>;

/** A request that passed the strict read, with its canonical text and the hash of that text (AC-39). */
export interface DecideRequest extends DecisionRecordRequest {
  /** The canonical request text. The log row keeps it as it is, and the owner record hash covers it. */
  readonly canonical: string;
  /** The request hash: SHA-256 of the canonical text, as lowercase hex. */
  readonly hash: string;
}

/**
 * Where a `D-n` stands in the waiting file and in the decision log. An `answered` row is a candidate only: a row names who
 * answered, but only a record in the owner store proves it, so the state is final after the store read. A row that holds
 * no `by` key is a close with no answer. The state holds no option: the option comes only from the store record.
 */
export type RequestState =
  | { readonly kind: 'open' }
  | { readonly kind: 'answered'; readonly date: string | null; readonly request: string | null }
  | { readonly kind: 'closed'; readonly date: string | null }
  | { readonly kind: 'unknown' };

const REQUEST_KEYS: readonly string[] = [waitingKeys.id, decisionKeys.title, decisionKeys.question, decisionKeys.options];
const OPTION_KEYS: readonly string[] = [optionKeys.key, optionKeys.text, optionKeys.rec];

/** The words as a phrase: "a, b or c". */
const listOf = (words: readonly string[]): string => `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`;

/** The remedy of a fault of the entry: restore the entry, or, when it was never changed, close it and add it again. */
const strictRemedy = (id: string): string =>
  `Restore the entry in ${files.waiting} from the last commit. If the ${requestWords.request} is not changed, close it with "${commandText(commandLines.requestClose)} ${id}" and add a new ${requestWords.request} with "${commandText(commandLines.requestAdd)}".`;

/** A fault of the entry of a request (exit 1). The phrase names a part of the entry and never repeats its text. */
const strictFault = (id: string, phrase: string): Err<CliError> => failure(`${files.waiting}: ${id} ${phrase}`, strictRemedy(id));

/** Why a text can not be one line of at most `max` characters that the display shows as it is, as a phrase, or null. The text is not trimmed. */
const textIssue = (text: string, max: number): string | null => {
  if (text.trim() === '') return 'is empty';
  if (holdsBreak(text)) return 'is not one line: it holds a line break, a control character or a mark of text direction';
  if (removedByDisplay(text)) return 'holds a character that the screen does not show';
  return text.length > max ? `is longer than ${max} characters` : null;
};

const textFieldOf = (id: string, value: unknown, label: string, max: number): CliResult<string> => {
  if (typeof value !== 'string') return strictFault(id, `has ${label} that is not text`);
  const issue = textIssue(value, max);
  return issue === null ? ok(value) : strictFault(id, `has ${label} that ${issue}`);
};

const optionOf = (id: string, value: unknown, position: number): CliResult<DecisionRecordOption> => {
  const label = `option ${position}`;
  if (!isRecord(value)) return strictFault(id, `has ${label} that is not an object`);
  if (Object.keys(value).some((key) => !OPTION_KEYS.includes(key))) {
    return strictFault(id, `has ${label} with a key other than ${listOf(OPTION_KEYS)}`);
  }
  const key = value[optionKeys.key];
  if (typeof key !== 'string' || !boardLimits.tokenPattern.test(key)) return strictFault(id, `has ${label} with a key that is not a token`);
  const text = textFieldOf(id, value[optionKeys.text], `the text of ${label}`, boardTextLimits.maxOptionChars);
  if (!text.ok) return text;
  const rec = value[optionKeys.rec];
  if (rec !== undefined && typeof rec !== 'boolean') {
    return strictFault(id, `has ${label} with a "${optionKeys.rec}" mark that is not true or false`);
  }
  return ok({ key, text: text.value, ...(rec === true ? { rec: true } : {}) });
};

const optionsOf = (id: string, value: unknown): CliResult<readonly DecisionRecordOption[]> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > boardTextLimits.maxOptions) {
    return strictFault(id, `has no list of 1 to ${boardTextLimits.maxOptions} options`);
  }
  const list: readonly unknown[] = value;
  const options: DecisionRecordOption[] = [];
  for (const [index, item] of list.entries()) {
    const option = optionOf(id, item, index + 1);
    if (!option.ok) return option;
    if (options.some((seen) => seen.key === option.value.key)) return strictFault(id, 'has an option key twice');
    options.push(option.value);
  }
  if (options.filter((option) => option.rec === true).length > 1) return strictFault(id, 'has more than one recommended option');
  return ok(options);
};

/**
 * The request of the waiting file, read strictly (AC-36, AC-42): the id has no leading zero; the entry holds no key beyond the
 * four; a title, a question and the text of an option are one line, within their caps, with no character that the display removes;
 * the option keys are tokens and differ; there are 1 to 9 options; at most one is recommended. Each fault is exit 1 that names the
 * waiting file and says to close and add the request when it was not changed. The texts are not trimmed.
 */
export const strictRequestOf = (waiting: WaitingDoc, id: string): CliResult<DecideRequest> => {
  const found = waiting.items.find((item) => item.id === id);
  if (found === undefined) return failure(`${files.waiting} has no ${requestWords.request} ${shown(id)}`);
  const record: Stored = found.record;
  if (!boardIds.canonicalRequest.test(id)) return strictFault(id, 'has an id that is not of the form D-n with no leading zero');
  if (Object.keys(record).some((key) => !REQUEST_KEYS.includes(key))) {
    return strictFault(id, `has a key other than ${listOf(REQUEST_KEYS)}`);
  }
  const title = textFieldOf(id, record[decisionKeys.title], 'a title', boardTextLimits.maxTitleChars);
  if (!title.ok) return title;
  const question = textFieldOf(id, record[decisionKeys.question], 'a question', boardTextLimits.maxQuestionChars);
  if (!question.ok) return question;
  const options = optionsOf(id, record[decisionKeys.options]);
  if (!options.ok) return options;
  const canonical = canonicalRequestText(record);
  if (!canonical.ok) return strictFault(id, `holds a value that JSON can not hold: ${canonical.error}`);
  return ok({
    id,
    title: title.value,
    question: question.value,
    options: options.value,
    canonical: canonical.value,
    hash: requestHashOf(canonical.value),
  });
};

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Where the `D-n` stands (AC-35). A number in both files is exit 1 that names both files. A row with a `by` key is a candidate
 * answer, whatever its value, and any other row is a close. The row gives its date and its request text and nothing else.
 */
export const requestStateOf = (waiting: WaitingDoc, log: DecisionLogDoc, id: string): CliResult<RequestState> => {
  const waits = waiting.items.some((item) => item.id === id);
  const row = log.rows.find((entry) => entry.id === id);
  if (row === undefined) return ok(waits ? { kind: 'open' } : { kind: 'unknown' });
  if (waits) {
    return failure(`${requestWords.request} ${id} is in ${files.waiting} and in ${files.decisionLog}; restore the files from the last commit`);
  }
  const date = textOrNull(row.record[decisionLogKeys.date]);
  return ok(
    Object.hasOwn(row.record, decisionLogKeys.by)
      ? { kind: 'answered', date, request: textOrNull(row.record[decisionLogKeys.request]) }
      : { kind: 'closed', date },
  );
};

export const addNewRemedy = `Add a new ${requestWords.request} with "${commandText(commandLines.requestAdd)}".`;

/**
 * The state that lets decide go on. An unknown number is exit 2 and a closed number is exit 1. An answered row is never a pass: the
 * caller reads the owner store first and handles that state itself, so a call with it fails closed.
 */
export const requireOpen = (state: RequestState, id: string): CliResult<void> => {
  const name = `${requestWords.request} ${shown(id)}`;
  switch (state.kind) {
    case 'open':
      return ok(undefined);
    case 'unknown':
      return usageError(
        `${files.waiting} has no ${name}`,
        `Run "${commandText(commandLines.requestList)}" to see the open ${requestWords.requests}.`,
      );
    case 'closed':
      return failure(`${name} is closed${state.date === null ? '' : ` (${shown(state.date)})`}`, addNewRemedy);
    case 'answered':
      return failure(`${name} has an answer row in ${files.decisionLog}`, addNewRemedy);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/** The option that the owner chose. An option that the request does not have is exit 2. */
export const chosenOptionOf = (request: DecideRequest, key: string): CliResult<DecisionRecordOption> => {
  const found = request.options.find((option) => option.key === key);
  return found === undefined
    ? usageError(`${shown(key)} is not an option of ${request.id}; the options are: ${request.options.map((option) => option.key).join(', ')}`)
    : ok(found);
};

const CHANGED = `the ${requestWords.request} changed after the prompt`;
const DECIDE_AGAIN = `Run "${commandText(commands.decide)}" again to see the ${requestWords.request} as it is now.`;

/**
 * The recheck under the lock (AC-14): the state is open, the strict read passes again, and the hash is the hash that the owner saw.
 * Any change after the prompt is exit 1, and the request that it gives is the one to record.
 */
export const recheckRequest = (waiting: WaitingDoc, log: DecisionLogDoc, id: string, hash: string): CliResult<DecideRequest> => {
  const state = requestStateOf(waiting, log, id);
  if (!state.ok) return state;
  if (state.value.kind !== 'open') return failure(`${CHANGED}: ${requestWords.request} ${id} is not open now`, DECIDE_AGAIN);
  const request = strictRequestOf(waiting, id);
  if (!request.ok) return request;
  return request.value.hash === hash ? request : failure(CHANGED, DECIDE_AGAIN);
};

const LOG_ROOM_REMEDY = `Do not remove rows from ${files.decisionLog}: the log gives the next D-n and the state of each ${requestWords.request}. "${commandText(commands.doctor)}" shows how full the board files are.`;

/** The new text of the decision log must fit in the cap of a file (AC-34). The count is in bytes. */
export const requireLogRoom = (logText: string): CliResult<void> =>
  Buffer.byteLength(logText, 'utf8') > maxFileBytes
    ? failure(`${files.decisionLog} would be larger than the cap of ${maxFileBytes} bytes`, LOG_ROOM_REMEDY)
    : ok(undefined);

/** The note of the owner (AC-43): one line of 1 to 500 characters that the display shows as it is. A bad note is exit 2. The note is not trimmed. */
export const checkNote = (text: string): CliResult<string> => {
  const issue = textIssue(text, boardTextLimits.maxNoteChars);
  return issue === null ? ok(text) : usageError(`the note ${issue}`);
};

const DATE_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * The row of the decision log for an owner answer (AC-15, AC-39): `item`, `decision` (the option key), `date`, `by` and `request`.
 * `request` is the canonical text as it is, so a consumer hashes the stored text with no other step. The row is a display copy: the
 * owner record is the proof. The option must be one of the request, and the date is `yyyy-mm-dd`.
 */
export const decideLogRow = (request: DecideRequest, option: string, date: string): CliResult<Stored> => {
  if (!request.options.some((entry) => entry.key === option)) {
    return failure(`${files.decisionLog}: the option of the row is not an option of ${request.id}`);
  }
  if (!DATE_FORM.test(date)) return failure(`${files.decisionLog}: the date of the row is not of the form yyyy-mm-dd`);
  return ok({
    [decisionLogKeys.item]: `${request.id}: ${request.title.trim()}`,
    [decisionLogKeys.decision]: option,
    [decisionLogKeys.date]: date,
    [decisionLogKeys.by]: roles.owner,
    [decisionLogKeys.request]: request.canonical,
  });
};

const LABEL_TITLE = 'Title:    ';
const LABEL_QUESTION = 'Question: ';
const LABEL_NOTE = 'Note:     ';

/**
 * The mark at the start of each line of the request block. A terminal narrower than the block breaks a long line, and the rest of
 * that line has no mark. So no text of the request can look like an option line or a mark of the block.
 */
export const BLOCK_MARK = '> ';

/** The text after a label, wrapped to the width of a line with no character dropped. A line that goes on is indented as the label is wide. */
const labeled = (label: string, text: string): readonly string[] =>
  wrapText(text, maxDisplayWidth - BLOCK_MARK.length - label.length).map(
    (line, index) => `${index === 0 ? label : ' '.repeat(label.length)}${line}`,
  );

const optionLabel = (option: DecisionRecordOption, chosen: string): string =>
  `  ${option.key}${option.rec === true ? ' (recommended)' : ''}${option.key === chosen ? ' (chosen)' : ''}: `;

/**
 * The block that decide shows before it asks (AC-42): the number, the title, the full question, every option with its key and its
 * text (the recommended one and the chosen one marked) and the note. A long text wraps and no text is cut. Each line starts with
 * `BLOCK_MARK`. The request passed the strict read, so the display shows exactly the text that the hash covers.
 */
export const requestBlockLines = (request: DecisionRecordRequest, chosen: string, note: string | null): readonly string[] =>
  [
    `Decision ${request.id}`,
    ...labeled(LABEL_TITLE, request.title),
    ...labeled(LABEL_QUESTION, request.question),
    'Options:',
    ...request.options.flatMap((option) => labeled(optionLabel(option, chosen), option.text)),
    ...(note === null ? [] : labeled(LABEL_NOTE, note)),
  ].map((line) => `${BLOCK_MARK}${line}`);
