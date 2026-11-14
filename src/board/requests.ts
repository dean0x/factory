import { isRecord } from '../migrate/inspect.js';
import { decisionKeys, optionKeys, requestGroups } from '../names.js';
import type { BoardRequest, RequestGroup } from './contract.js';
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

export const requestsOf = (waiting: WaitingDoc): readonly BoardRequest[] =>
  waiting.items.map((item) => ({
    id: item.id,
    title: requestTitleOf(item),
    options: optionKeysOf(item),
    openedAt: storedTimeOf(item.record[decisionKeys.openedAt]),
    group: groupOf(item),
  }));
