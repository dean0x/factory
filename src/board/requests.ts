import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';
import {
  approvalLinkLabels,
  boardIds,
  boardTextLimits,
  decisionKeys,
  decisionLogKeys,
  optionKeys,
  requestFieldKeys,
  requestGroups,
  requestHash,
  requestKinds,
  requestWords,
} from '../names.js';
import { parseJsonText } from '../state/load.js';
import type { BoardRequest, RequestGroup, RequestKind, RequestLink } from './contract.js';
import type { WaitingDoc, WaitingItem } from './files.js';
import { storedTimeOf } from './stored-time.js';

/**
 * The requests of the waiting file as the commands show them. The reader of the file checks the id of an entry and nothing else, so
 * a key that a hand edit left out, or a key with a value of another type, reads as null and never stops a list.
 */

/** The title of a waiting entry, or null when the entry has none. */
export const requestTitleOf = (item: WaitingItem): string | null => {
  const title = item.record[decisionKeys.title];
  return typeof title === 'string' && title.trim() !== '' ? title : null;
};

/** The keys of the options of a waiting entry, in order. An option with no text key is left out. */
const optionKeysOf = (item: WaitingItem): readonly string[] => {
  const options = item.record[decisionKeys.options];
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): string[] => {
    if (!isRecord(option)) return [];
    const key = option[optionKeys.key];
    return typeof key === 'string' ? [key] : [];
  });
};

/** The group of a waiting entry: a word of `requestGroups`. A group that is missing, or is any other value, reads as `now`. */
const groupOf = (item: WaitingItem): RequestGroup => {
  const group = item.record[decisionKeys.group];
  return Object.values(requestGroups).find((known) => known === group) ?? requestGroups.now;
};

/** A missing or unknown kind reads as decision for the list. The strict read checks the stored kind. */
const kindOf = (item: WaitingItem): RequestKind => {
  const kind = item.record[decisionKeys.kind];
  return Object.values(requestKinds).find((known) => known === kind) ?? requestKinds.decision;
};

const questionOf = (item: WaitingItem): string | null => {
  const question = item.record[decisionKeys.question];
  return typeof question === 'string' ? question : null;
};

export const requestsOf = (waiting: WaitingDoc): readonly BoardRequest[] =>
  waiting.items.map((item) => ({
    id: item.id,
    title: requestTitleOf(item),
    options: optionKeysOf(item),
    openedAt: storedTimeOf(item.record[decisionKeys.openedAt]),
    group: groupOf(item),
    kind: kindOf(item),
    question: questionOf(item),
  }));

/** The recipe supplies its approval point ids and its reference and head parsers. */
export interface RequestLinkRules {
  readonly points: readonly string[];
  readonly parseRef: (text: string) => CliResult<string>;
  readonly parseHead: (text: string) => CliResult<string>;
}

const LINK_LABELS: ReadonlySet<string> = new Set(Object.values(approvalLinkLabels));
const LOG_LINK_KEYS = [decisionLogKeys.point, decisionLogKeys.boardItem, decisionLogKeys.ref, decisionLogKeys.head];

type LinkParts = Readonly<Record<keyof RequestLink, unknown>>;
const linkFault = (reason: string) => failure(`the ${requestWords.request} link ${reason}`);

/** Stored faults are failures, never usage errors. No stored value supplies the error text. */
const linkOfParts = (parts: LinkParts, rules: RequestLinkRules | undefined): CliResult<RequestLink> => {
  if (rules === undefined) return linkFault('has no approval link rules');
  if (typeof parts.point !== 'string' || !rules.points.includes(parts.point)) return linkFault('has an invalid approval point');
  if (typeof parts.item !== 'string' || !boardIds.item.test(parts.item)) return linkFault('has an invalid board item');
  if (typeof parts.ref !== 'string') return linkFault('has no reference text');
  const ref = rules.parseRef(parts.ref);
  if (!ref.ok) return linkFault('has an invalid reference');
  if (typeof parts.head !== 'string') return linkFault('has no head text');
  const head = rules.parseHead(parts.head);
  if (!head.ok) return linkFault('has an invalid head');
  return ok({ point: parts.point, item: parts.item, ref: ref.value, head: head.value });
};

/** No board item label means no link. Once present, every link label must occur once with a valid value. */
export const linkOfFields = (fields: unknown, rules: RequestLinkRules | undefined): CliResult<RequestLink | null> => {
  if (fields === undefined || fields === null) return ok(null);
  if (!Array.isArray(fields) || fields.length > boardTextLimits.maxRequestFields) {
    return linkFault(`needs a list of at most ${boardTextLimits.maxRequestFields} fields`);
  }
  const list: readonly unknown[] = fields;
  if (!list.some((field) => isRecord(field) && field[requestFieldKeys.label] === approvalLinkLabels.item)) return ok(null);
  const values = new Map<string, unknown>();
  for (const field of list) {
    if (!isRecord(field)) continue;
    const label = field[requestFieldKeys.label];
    if (typeof label !== 'string' || !LINK_LABELS.has(label)) continue;
    if (values.has(label)) return linkFault('has a duplicate label');
    values.set(label, field[requestFieldKeys.text]);
  }
  return linkOfParts({
    point: values.get(approvalLinkLabels.point), item: values.get(approvalLinkLabels.item),
    ref: values.get(approvalLinkLabels.ref), head: values.get(approvalLinkLabels.head),
  }, rules);
};

/** Old rows have no link keys. Any partial link is a fault, not an old row. The row remains a display copy. */
export const linkOfRow = (row: Readonly<Record<string, unknown>>, rules: RequestLinkRules | undefined): CliResult<RequestLink | null> => {
  if (!LOG_LINK_KEYS.some((key) => Object.hasOwn(row, key))) return ok(null);
  if (!LOG_LINK_KEYS.every((key) => Object.hasOwn(row, key))) return linkFault('lacks one or more keys in the decision log');
  return linkOfParts({
    point: row[decisionLogKeys.point],
    item: row[decisionLogKeys.boardItem],
    ref: row[decisionLogKeys.ref],
    head: row[decisionLogKeys.head],
  }, rules);
};

/** Read only the request inside the hash wrapper. */
export const answeredRequestOf = (requestText: string): CliResult<Readonly<Record<string, unknown>>> => {
  const parsed = parseJsonText(requestText);
  if (!parsed.ok) return failure(parsed.error);
  const wrapper = parsed.value;
  if (
    !isRecord(wrapper) || Object.keys(wrapper).length !== Object.keys(requestHash.keys).length ||
    wrapper[requestHash.keys.tag] !== requestHash.tag || wrapper[requestHash.keys.version] !== requestHash.version
  ) {
    return failure(`the answered ${requestWords.request} text has an invalid hash wrapper`);
  }
  const request = wrapper[requestHash.keys.request];
  if (!isRecord(request)) return failure(`the hash wrapper has no ${requestWords.request} object`);
  return ok(request);
};
