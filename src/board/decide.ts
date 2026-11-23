import { failure, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { wrapText } from '../cli/output.js';
import type { DecisionRecord } from '../core/owner-record.js';
import { canonicalRequestText, requestHashOf } from '../core/request-hash.js';
import { err, ok, type Err, type Result } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';
import {
  approvalLinkLabels,
  approvalOptions,
  boardIds,
  boardLimits,
  boardTextLimits,
  commandLines,
  commands,
  commandText,
  decideDocContext,
  decideProof,
  type decideProofKinds,
  decideWords,
  decisionKeys,
  decisionLogKeys,
  files,
  flags,
  flagText,
  maxDisplayWidth,
  maxFileBytes,
  optionKeys,
  relayedMarker,
  requestFieldKeys,
  requestGroups,
  requestKinds,
  requestWords,
  roles,
  waitingKeys,
} from '../names.js';
import type { ApprovalMode } from '../recipes/entry.js';
import type { RequestDecider, RequestField, RequestGroup, RequestKind, RequestLink } from './contract.js';
import { docPathIssue, isDecider, shown } from './edit.js';
import { jsonText, type DecisionRecordOption, type DecisionRecordRequest } from './decision-record.js';
import type { DecisionLogDoc, WaitingDoc } from './files.js';
import { answeredRequestOf, approvalLinkRemedy, linkOfFields, linkOfRow, type RequestLinkRules } from './requests.js';
import { storedTimeOf } from './stored-time.js';
import { visibleLineIssue } from './text.js';

/**
 * The pure steps of `decide` (design 4.10). Each step reads texts that the caller
 * has read and gives a result: none reads a file, a clock or the owner store. The caller runs them before the prompt and again
 * under the lock.
 *
 * `decide` shows exactly the text that the request hash covers. So the strict read refuses a text that the display changes, and
 * it never trims a text: the hash covers the stored strings. A message names a file and a part of the request and repeats no
 * stored text, except through the echo rule (`shown`).
 */

type Stored = Readonly<Record<string, unknown>>;

/**
 * A request that passed the strict read, with its canonical text and the hash of that text. Missing context stays absent: the
 * open time, group, kind and fields are null, and docs is an empty list. The canonical text keeps the stored form.
 */
export interface DecideRequest extends DecisionRecordRequest {
  /** The time at which the request was added, as the row holds it, or null for a row with no such key. */
  readonly openedAt: string | null;
  /** The group of the request, or null for a row with no such key. */
  readonly group: RequestGroup | null;
  /** Checked paths only. The request and its hash do not cover the text of a doc. */
  readonly docs: readonly string[];
  /** The canonical request text. The log row keeps it as it is, and the owner record hash covers it. */
  readonly canonical: string;
  /** The request hash: SHA-256 of the canonical text, as lowercase hex. */
  readonly hash: string;
}

/**
 * Where a `D-n` stands in the waiting file and in the decision log. An `answered` row is a candidate only: a row names who
 * answered, but only a record in the owner store proves it, so the state is final after the store read. A row that holds
 * no `by` key is a close with no answer. A close with a decision of the coordinator or a delegate carries its `decider`, a value of
 * `requestDeciders`; any other stored value is dropped. A row with the `relayed` key (any value) is a close that the coordinator made
 * to pass on an answer of the owner: it is `relayed`, and it is no owner proof. The state holds no option: the option comes only from
 * the store record.
 */
export type RequestState =
  | { readonly kind: 'open' }
  | { readonly kind: 'answered'; readonly date: string | null; readonly request: string | null }
  | { readonly kind: 'closed'; readonly date: string | null; readonly decider?: RequestDecider; readonly relayed?: true }
  | { readonly kind: 'unknown' };

const REQUEST_KEYS: readonly string[] = [
  waitingKeys.id,
  decisionKeys.title,
  decisionKeys.question,
  decisionKeys.options,
  decisionKeys.openedAt,
  decisionKeys.group,
  decisionKeys.kind,
  decisionKeys.fields,
  decisionKeys.docs,
];
const OPTION_KEYS: readonly string[] = [optionKeys.key, optionKeys.text, optionKeys.rec, optionKeys.why];
const FIELD_KEYS: readonly string[] = [requestFieldKeys.label, requestFieldKeys.text];

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
  return visibleLineIssue(text) ?? (text.length > max ? `is longer than ${max} characters` : null);
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
  const why = Object.hasOwn(value, optionKeys.why)
    ? textFieldOf(id, value[optionKeys.why], `the "${optionKeys.why}" of ${label}`, boardTextLimits.maxWhyChars)
    : ok(undefined);
  if (!why.ok) return why;
  return ok({ key, text: text.value, ...(rec === true ? { rec: true } : {}), ...(why.value === undefined ? {} : { why: why.value }) });
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

/** The open time of the row: null when the row has no such key, else an exact stored time. A key with any other value is a fault. */
const openedAtOf = (id: string, record: Stored): CliResult<string | null> => {
  if (!Object.hasOwn(record, decisionKeys.openedAt)) return ok(null);
  const time = storedTimeOf(record[decisionKeys.openedAt]);
  return time === null ? strictFault(id, `has an "${decisionKeys.openedAt}" that is not an exact ISO time in UTC`) : ok(time);
};

/** The group of the row: null when the row has no such key, else a value of `requestGroups`. A key with any other value is a fault. */
const groupOf = (id: string, record: Stored): CliResult<RequestGroup | null> => {
  if (!Object.hasOwn(record, decisionKeys.group)) return ok(null);
  const value = record[decisionKeys.group];
  const group = Object.values(requestGroups).find((known) => known === value);
  return group === undefined ? strictFault(id, `has a "${decisionKeys.group}" that is not ${listOf(Object.values(requestGroups))}`) : ok(group);
};

/** The kind as stored, or null for an entry with no kind. No default changes the text of an old request. */
const kindOf = (id: string, record: Stored): CliResult<RequestKind | null> => {
  if (!Object.hasOwn(record, decisionKeys.kind)) return ok(null);
  const kind = Object.values(requestKinds).find((known) => known === record[decisionKeys.kind]);
  return kind === undefined ? strictFault(id, `has a "${decisionKeys.kind}" that is not ${listOf(Object.values(requestKinds))}`) : ok(kind);
};

const fieldsOf = (id: string, record: Stored): CliResult<readonly RequestField[] | null> => {
  if (!Object.hasOwn(record, decisionKeys.fields)) return ok(null);
  const value = record[decisionKeys.fields];
  if (!Array.isArray(value) || value.length > boardTextLimits.maxRequestFields) {
    return strictFault(id, `has no list of at most ${boardTextLimits.maxRequestFields} "${decisionKeys.fields}"`);
  }
  const list: readonly unknown[] = value;
  const fields: RequestField[] = [];
  for (const [index, field] of list.entries()) {
    const part = `field ${index + 1} of "${decisionKeys.fields}"`;
    if (!isRecord(field)) return strictFault(id, `has ${part} that is not an object`);
    if (Object.keys(field).some((key) => !FIELD_KEYS.includes(key))) {
      return strictFault(id, `has ${part} with a key other than ${listOf(FIELD_KEYS)}`);
    }
    const label = textFieldOf(id, field[requestFieldKeys.label], `the label of ${part}`, boardTextLimits.maxFieldLabelChars);
    if (!label.ok) return label;
    const text = textFieldOf(id, field[requestFieldKeys.text], `the text of ${part}`, boardTextLimits.maxFieldTextChars);
    if (!text.ok) return text;
    if (fields.some((seen) => seen.label === label.value)) return strictFault(id, `has a label twice in "${decisionKeys.fields}"`);
    fields.push({ label: label.value, text: text.value });
  }
  return ok(fields);
};

const docsOf = (id: string, record: Stored): CliResult<readonly string[]> => {
  if (!Object.hasOwn(record, decisionKeys.docs)) return ok([]);
  const value = record[decisionKeys.docs];
  if (!Array.isArray(value) || value.length > boardTextLimits.maxRequestDocs) {
    return strictFault(id, `has no list of at most ${boardTextLimits.maxRequestDocs} "${decisionKeys.docs}"`);
  }
  const list: readonly unknown[] = value;
  const docs: string[] = [];
  for (const path of list) {
    if (typeof path !== 'string' || docPathIssue(path) !== null) {
      return strictFault(id, `has a path in "${decisionKeys.docs}" that fails the doc path rule`);
    }
    if (docs.includes(path)) return strictFault(id, `has a path twice in "${decisionKeys.docs}"`);
    docs.push(path);
  }
  return ok(docs);
};

/**
 * The request of the waiting file, read strictly: exact request, option and field keys; a canonical id; one-line text within
 * the write caps, with no hidden character; 1 to 9 options with distinct token keys and at most one recommendation; an exact
 * stored time and a known group and kind when present; at most 6 fields with distinct labels; at most 5 distinct doc paths that
 * pass the write rule. Each fault is exit 1 with the restore, close and add remedy. No text is trimmed. The canonical text covers
 * the whole entry, so entries of four or six keys keep their text and hash. Doc text is not part of the entry or the hash.
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
  const openedAt = openedAtOf(id, record);
  if (!openedAt.ok) return openedAt;
  const group = groupOf(id, record);
  if (!group.ok) return group;
  const kind = kindOf(id, record);
  if (!kind.ok) return kind;
  const fields = fieldsOf(id, record);
  if (!fields.ok) return fields;
  const docs = docsOf(id, record);
  if (!docs.ok) return docs;
  const canonical = canonicalRequestText(record);
  if (!canonical.ok) return strictFault(id, `holds a value that JSON can not hold: ${canonical.error}`);
  return ok({
    id,
    title: title.value,
    question: question.value,
    options: options.value,
    openedAt: openedAt.value,
    group: group.value,
    kind: kind.value,
    fields: fields.value,
    docs: docs.value,
    canonical: canonical.value,
    hash: requestHashOf(canonical.value),
  });
};

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Where the `D-n` stands. A number in both files is exit 1 that names both files. A row with a `by` key is a candidate
 * answer, whatever its value, and any other row is a close. A close whose row has the `relayed` key is marked relayed, whatever the
 * value. The row gives its date and its request text and nothing else.
 */
export const requestStateOf = (waiting: WaitingDoc, log: DecisionLogDoc, id: string): CliResult<RequestState> => {
  const waits = waiting.items.some((item) => item.id === id);
  const row = log.rows.find((entry) => entry.id === id);
  if (row === undefined) return ok(waits ? { kind: 'open' } : { kind: 'unknown' });
  if (waits) {
    return failure(`${requestWords.request} ${id} is in ${files.waiting} and in ${files.decisionLog}; restore the files from the last commit`);
  }
  const date = textOrNull(row.record[decisionLogKeys.date]);
  const decider = row.record[decisionLogKeys.decider];
  return ok(
    Object.hasOwn(row.record, decisionLogKeys.by)
      ? { kind: 'answered', date, request: textOrNull(row.record[decisionLogKeys.request]) }
      : {
          kind: 'closed',
          date,
          ...(isDecider(decider) ? { decider } : {}),
          ...(Object.hasOwn(row.record, decisionLogKeys.relayed) ? { relayed: true as const } : {}),
        },
  );
};

interface ProofContext {
  readonly at: string | null;
  readonly link: RequestLink | null;
  readonly title: string | null;
  readonly question: string | null;
  readonly decision: string | null;
  readonly decider: RequestDecider | null;
}

export type RequestProof = ProofContext & (
  | { readonly kind: typeof decideProof.record; readonly option: string; readonly at: string }
  | { readonly kind: typeof decideProof.relayed; readonly option: null; readonly settled: boolean }
  | { readonly kind: Exclude<(typeof decideProofKinds)[number], typeof decideProof.record | typeof decideProof.relayed>; readonly option: null }
);

const emptyProofContext: ProofContext = { at: null, link: null, title: null, question: null, decision: null, decider: null };

type DecisionDocs = { readonly waiting: WaitingDoc; readonly log: DecisionLogDoc };
type StoredDecision = Result<{ readonly record: Readonly<DecisionRecord> | null }, string>;

/** Classify the board state against the scoped store record. A row is never proof on its own. */
export const proofOf = (
  id: string,
  docs: CliResult<DecisionDocs>,
  stored: StoredDecision,
  rules: RequestLinkRules | undefined,
): RequestProof => {
  const fault: RequestProof = { ...emptyProofContext, kind: decideProof.error, option: null };
  if (!docs.ok || !stored.ok) return fault;
  const { waiting, log } = docs.value;
  const parsed = requestStateOf(waiting, log, id);
  if (!parsed.ok) return fault;
  const state = parsed.value;
  const row = log.rows.find((entry) => entry.id === id)?.record ?? {};
  const rowLink = linkOfRow(row, rules);
  if (!rowLink.ok) return fault;
  const rowTitle = textOrNull(row[decisionLogKeys.item])?.slice(id.length).replace(/^:?\s*/u, '') ?? null;
  const relayed = Object.hasOwn(row, decisionLogKeys.relayed);
  const storedDecider = row[decisionLogKeys.decider];
  const decider = isDecider(storedDecider) ? storedDecider : null;
  if (Object.hasOwn(row, decisionLogKeys.decider) && decider === null) return fault;
  if (relayed && decider !== null && decider !== roles.coordinator) return fault;
  if (state.kind === 'closed' || relayed || decider !== null) {
    return {
      ...emptyProofContext,
      option: null, link: rowLink.value,
      at: textOrNull(row[decisionLogKeys.date]), title: rowTitle, decision: textOrNull(row[decisionLogKeys.decision]),
      ...(relayed ? {
        kind: decideProof.relayed, decider: roles.coordinator,
        // A marked row can appear in a read. Only a complete close can settle an approval request.
        settled: state.kind === 'closed' && decider === roles.coordinator && row[decisionLogKeys.relayed] === relayedMarker,
      } : { kind: decideProof.closed, decider }),
    };
  }

  const open = state.kind === 'open' ? strictRequestOf(waiting, id) : ok(null);
  if (!open.ok) return fault;
  const requestText = open.value?.canonical ?? (state.kind === 'answered' ? state.request : null);
  const answered = state.kind === 'answered' && requestText !== null ? answeredRequestOf(requestText) : ok(null);
  if (!answered.ok || (answered.value !== null && answered.value[waitingKeys.id] !== id)) return fault;
  const link = linkOfFields(open.value?.fields ?? answered.value?.[decisionKeys.fields], rules);
  if (!link.ok) return fault;
  const context: ProofContext = {
    ...emptyProofContext,
    link: link.value,
    title: open.value?.title ?? textOrNull(answered.value?.[decisionKeys.title]) ?? rowTitle,
    question: open.value?.question ?? textOrNull(answered.value?.[decisionKeys.question]),
    at: open.value?.openedAt ?? (state.kind === 'answered' ? state.date : null),
  };
  const record = stored.value.record;
  if (record === null) return { ...context, kind: state.kind === 'open' ? decideProof.open : decideProof.none, option: null };
  if (requestText === null || record.hash !== requestHashOf(requestText)) return { ...context, kind: decideProof.mismatch, option: null };
  return { ...context, kind: decideProof.record, option: record.option, at: record.at };
};

interface LinkedApproval {
  readonly id: string;
  readonly link: RequestLink;
}

interface LinkedApprovals {
  readonly open: CliResult<string | null>;
  readonly settled: CliResult<readonly LinkedApproval[]>;
}

/** Check which item a field names even if the rest of its link is invalid. */
const namesItem = (fields: unknown, item: string): boolean =>
  Array.isArray(fields) && fields.some((field: unknown) =>
    isRecord(field) && field[requestFieldKeys.label] === approvalLinkLabels.item && field[requestFieldKeys.text] === item,
  );

const approvalLinkFault = (id: string | null): Err<CliError> =>
  failure(
    id === null ? `a linked approval row has no ${requestWords.request} id` : `the link of ${requestWords.request} ${shown(id)} is invalid`,
    approvalLinkRemedy,
  );

const openApprovalOf = (waiting: WaitingDoc, item: string, point: string, rules: RequestLinkRules | undefined): CliResult<string | null> => {
  for (const { id, record } of waiting.items) {
    const fields = record[decisionKeys.fields];
    if (!namesItem(fields, item)) continue;
    const link = linkOfFields(fields, rules);
    if (!link.ok) return approvalLinkFault(id);
    if (link.value?.point === point) return ok(id);
  }
  return ok(null);
};

const settledLinkOf = (row: Stored, item: string, rules: RequestLinkRules | undefined): CliResult<RequestLink | null> => {
  const rowNamesItem = row[decisionLogKeys.boardItem] === item;
  if (!Object.hasOwn(row, decisionLogKeys.by)) return rowNamesItem ? linkOfRow(row, rules) : ok(null);

  // An answer takes its link from the request text, not from the display keys of the row.
  const text = textOrNull(row[decisionLogKeys.request]);
  const request = text === null ? failure(`the answer has no ${requestWords.request} text`) : answeredRequestOf(text);
  if (!request.ok) return rowNamesItem ? request : ok(null);
  const fields = request.value[decisionKeys.fields];
  return namesItem(fields, item) ? linkOfFields(fields, rules) : ok(null);
};

/** Select the open request or the settled rows in append order. The file size cap bounds both scans. */
export const linkedApprovalsOf = (
  waiting: WaitingDoc, log: DecisionLogDoc, item: string, point: string, rules: RequestLinkRules | undefined,
): LinkedApprovals => {
  const open = openApprovalOf(waiting, item, point, rules);
  if (!open.ok || open.value !== null) return { open, settled: ok([]) };

  const settled: LinkedApproval[] = [];
  for (const { id, record } of log.rows) {
    const link = settledLinkOf(record, item, rules);
    if (!link.ok) return { open, settled: approvalLinkFault(id) };
    if (link.value?.point !== point) continue;
    if (id === null) return { open, settled: approvalLinkFault(id) };
    settled.push({ id, link: link.value });
  }
  return { open, settled: ok(settled) };
};

export interface ApprovalCheck {
  readonly docs: DecisionDocs;
  readonly linked: LinkedApprovals;
  /** The store records for this node and real root. */
  readonly stored: Result<readonly DecisionRecord[], string>;
  readonly rules: RequestLinkRules | undefined;
  readonly mode: ApprovalMode;
  readonly ref: string;
  /** Null before the external check: defer both the reference and the head comparison. */
  readonly head: string | null;
}

export type SettledProof =
  | { readonly kind: typeof decideProof.record; readonly id: string; readonly decider: typeof roles.owner }
  | { readonly kind: typeof decideProof.relayed; readonly id: string; readonly decider: typeof roles.coordinator };

export interface ApprovalHashMismatch {
  readonly kind: 'failure';
  readonly reason: 'hash-mismatch';
  readonly message: string;
  readonly hint: string;
}

type ApprovalProofError = (CliError & { readonly reason?: never }) | ApprovalHashMismatch;

/** A CLI result that distinguishes a hash mismatch from other refusals. */
export type ApprovalProofResult = Result<SettledProof, ApprovalProofError>;

const sameApprovalLink = (first: RequestLink | null, second: RequestLink): boolean =>
  first?.item === second.item && first.point === second.point && first.ref === second.ref && first.head === second.head;

/** A stop blocks by id. To clear it, an approve needs proof for the same link. */
const ownerStopOf = (
  settled: readonly LinkedApproval[], link: RequestLink, records: ReadonlyMap<string, DecisionRecord>,
  docs: DecisionDocs, rules: RequestLinkRules | undefined, newestProof: RequestProof,
): string | null => {
  const last = settled.length - 1;
  for (let index = last; index >= 0; index -= 1) {
    const entry = settled[index];
    if (entry === undefined || !sameApprovalLink(entry.link, link)) continue;
    const record = records.get(entry.id);
    if (record?.option === approvalOptions.stop) return entry.id;
    if (record?.option !== approvalOptions.go) continue;
    const proof = index === last ? newestProof : proofOf(entry.id, ok(docs), ok({ record }), rules);
    if (proof.kind === decideProof.record && sameApprovalLink(proof.link, link)) return null;
  }
  return null;
};

const ADD_APPROVAL = `Add a linked ${requestWords.request} with "${commandText(commandLines.requestAdd)}" and the current head of the reference. Answer it with "${commandText(commands.decide)}", or relay a new go with "${commandText(commandLines.requestClose)} ${flagText(flags.relayed)}".`;

const openApprovalVerdict = (open: LinkedApprovals['open']): CliResult<void> => {
  if (!open.ok) return open;
  if (open.value === null) return ok(undefined);
  return failure(
    `${requestWords.request} ${shown(open.value)} is still open`,
    `Run "${commandText(commands.decide)}" with this id and an option. If it has an answer, run "${commandText(commands.decide)}" again with the same option.`,
  );
};

/** Require a settled go for this link, without a mode or guard skip. */
export const approvalProof = ({ docs, linked, stored, rules, ref, head }: Omit<ApprovalCheck, 'mode'>): ApprovalProofResult => {
  const open = openApprovalVerdict(linked.open);
  if (!open.ok) return open;
  if (!linked.settled.ok) return linked.settled;
  const newest = linked.settled.value.at(-1);
  if (newest === undefined) return failure(`there is no linked approval ${requestWords.request}`, ADD_APPROVAL);

  const { id, link } = newest;
  const name = `${requestWords.request} ${shown(id)}`;
  if (!stored.ok) {
    return failure(
      `cannot read the ${roles.owner} store for ${name}`,
      `Run "${commandText(commands.doctor)}" for diagnostics. Check the state path. Restore access to the ${roles.owner} store.`,
    );
  }
  const records = new Map(stored.value.map((record) => [record.id, record]));
  const record = records.get(id) ?? null;
  const proof = proofOf(id, ok(docs), ok({ record }), rules);
  const mismatch = (message: string, hint: string): Err<ApprovalHashMismatch> =>
    err({ kind: 'failure', reason: 'hash-mismatch', message, hint });
  const stop = ownerStopOf(linked.settled.value, link, records, docs, rules, proof);
  if (stop !== null) {
    const message = `the ${roles.owner} answered ${approvalOptions.stop} on ${requestWords.request} ${shown(stop)}`;
    const remedy = `Add a new linked approval ${requestWords.request} for the same reference and head. The ${roles.owner} must use "${commandText(commands.decide)}" to save an ${approvalOptions.go} answer in the ${roles.owner} store.`;
    return proof.kind === decideProof.mismatch ? mismatch(message, remedy) : failure(message, remedy);
  }
  if (proof.kind === decideProof.relayed && record !== null) {
    return failure(
      `${name} also has an ${roles.owner} store answer`,
      `Run "${commandText(commands.decide)} ${decideWords.read} ${id}" to see the answer. Ask the ${roles.owner} to resolve the conflict.`,
    );
  }
  const go = (proof.kind === decideProof.record && proof.option === approvalOptions.go) ||
    (proof.kind === decideProof.relayed && proof.settled && proof.decision === approvalOptions.go);
  if (!go || !sameApprovalLink(proof.link, link)) {
    const message = `${name} has no settled approval`;
    return proof.kind === decideProof.mismatch ? mismatch(message, ADD_APPROVAL) : failure(message, ADD_APPROVAL);
  }
  if (head !== null && (link.ref !== ref || link.head !== head)) {
    return failure(
      `${name} does not match the reference and head`,
      `Add a new ${requestWords.request} for the new head with "${commandText(commandLines.requestAdd)}".`,
    );
  }
  return proof.kind === decideProof.record
    ? ok({ kind: decideProof.record, id, decider: roles.owner })
    : ok({ kind: decideProof.relayed, id, decider: roles.coordinator });
};

/** Preserve the record check: delegated mode needs no settled proof, and a hash mismatch is a normal refusal. */
export const approvalVerdict = (check: ApprovalCheck): CliResult<void> => {
  if (check.mode !== roles.owner) return openApprovalVerdict(check.linked.open);
  const proof = approvalProof(check);
  if (proof.ok) return ok(undefined);
  return proof.error.reason === 'hash-mismatch' ? failure(proof.error.message, proof.error.hint) : proof;
};

export const addNewRemedy = `Add a new ${requestWords.request} with "${commandText(commandLines.requestAdd)}".`;

/** Who closed a request, as the end of a refusal: the relay words, the decider and its lack of authority, or nothing for a close with no answer. */
const closedBy = (state: Extract<RequestState, { readonly kind: 'closed' }>): string => {
  if (state.relayed === true) return `, ${relayedMarker}`;
  return state.decider === undefined ? '' : `, decided by the ${shown(state.decider)}, no ${roles.owner} authority`;
};

/**
 * The state that lets decide go on. An unknown number is exit 2 and a closed number is exit 1; a closed number with a decider names
 * the decider and says that the decider has no owner authority, and a relayed close says that it is an owner answer that the
 * coordinator relayed, with no owner proof. An answered row is never a pass: the
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
    case 'closed': {
      const date = state.date === null ? '' : ` (${shown(state.date)})`;
      return failure(`${name} is closed${date}${closedBy(state)}`, addNewRemedy);
    }
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
 * The recheck under the lock: the state is open, the strict read passes again, and the hash is the hash that the owner saw.
 * A changed request is not the one that the owner answered. Leave it open and write no answer.
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

/** The new text of the decision log must fit in the cap of a file. The count is in bytes. */
export const requireLogRoom = (logText: string): CliResult<void> =>
  Buffer.byteLength(logText, 'utf8') > maxFileBytes
    ? failure(`${files.decisionLog} would be larger than the cap of ${maxFileBytes} bytes`, LOG_ROOM_REMEDY)
    : ok(undefined);

/** The note of the owner: one line of 1 to 500 characters that the display shows as it is. A bad note is exit 2. The note is not trimmed. */
export const checkNote = (text: string): CliResult<string> => {
  const issue = textIssue(text, boardTextLimits.maxNoteChars);
  return issue === null ? ok(text) : usageError(`the note ${issue}`);
};

const DATE_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * The row of the decision log for an owner answer: `item`, `decision` (the option key), `date`, `by` and `request`.
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
const LABEL_OPENED = 'Opened:   ';
const LABEL_GROUP = 'Group:    ';
const LABEL_KIND = 'Kind:     ';
const LABEL_FIELD = 'Field:    ';
const LABEL_DOC = 'Doc:      ';
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
 * Show the request and option keys that the hash covers, plus the owner note. A view can supply a question for the selected
 * option without a change to the stored request. Context labels start before the option column. The option reason is indented
 * below its option. A field label uses the record escape to keep its separator distinct from the field text. Long text wraps
 * with no cut. Each line starts with `BLOCK_MARK`. The doc notice states that the proof does not cover the text of the docs.
 */
export const requestBlockLines = (request: DecideRequest, chosen: string, note: string | null, question = request.question): readonly string[] =>
  [
    `Decision ${request.id}`,
    ...labeled(LABEL_TITLE, request.title),
    ...labeled(LABEL_QUESTION, question),
    ...(request.openedAt === null ? [] : labeled(LABEL_OPENED, request.openedAt)),
    ...(request.group === null ? [] : labeled(LABEL_GROUP, request.group)),
    ...(request.kind === null ? [] : labeled(LABEL_KIND, request.kind)),
    ...(request.fields ?? []).flatMap((field) => labeled(LABEL_FIELD, `${jsonText(field.label)}: ${field.text}`)),
    ...request.docs.flatMap((path) => labeled(LABEL_DOC, path)),
    ...(request.docs.length === 0 ? [] : [decideDocContext]),
    'Options:',
    ...request.options.flatMap((option) => [
      ...labeled(optionLabel(option, chosen), option.text),
      ...(option.why === undefined ? [] : labeled(`    Why (${option.key}): `, option.why)),
    ]),
    ...(note === null ? [] : labeled(LABEL_NOTE, note)),
  ].map((line) => `${BLOCK_MARK}${line}`);
