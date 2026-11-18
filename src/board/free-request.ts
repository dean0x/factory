import { failure, type CliResult } from '../cli/errors.js';
import { isSlug } from '../config/primitives.js';
import { ok } from '../core/result.js';
import { shellWord } from '../core/shell-word.js';
import { commands, commandText, dismissWords, flags, flagText, requestGroups, requestKinds, requestWords, roles } from '../names.js';
import type { DecisionAskInput, RequestField } from './contract.js';
import type { DecideRequest } from './decide.js';
import { visibleLineIssue } from './text.js';

interface FreeRequestFacts {
  readonly id: string;
  readonly project: string;
  readonly closed: readonly string[];
  readonly head: string;
  readonly checkedAt: string;
}

const CHECKS_PASSED = [
  'coordinator-caller',
  'dismiss-endable',
  'dismiss-work-item-unknown',
  'dismiss-closed-proof',
  'dismiss-paths',
  'dismiss-pushed',
].join(', ');

export const freeTitleOf = (id: string): string => `${requestWords.freeTitle} ${id}`;

/** List at most the display cap of item ids and give the count of the rest. */
export const namedItems = (ids: readonly string[]): string => {
  const { maxItemsNamed: max } = dismissWords;
  const names = ids.slice(0, max).join(', ');
  return ids.length > max ? `${names} and ${ids.length - max} more` : names;
};

export const freeRequestOf = ({ id, project, closed, head, checkedAt }: FreeRequestFacts): DecisionAskInput => ({
  title: freeTitleOf(id),
  question: requestWords.freeQuestion,
  kind: requestKinds.command,
  group: requestGroups.now,
  options: [requestWords.freeDone, requestWords.freeKept],
  fields: [
    { label: requestWords.freeWorkerLabel, text: id },
    { label: requestWords.freeProjectLabel, text: project },
    { label: requestWords.freeClosedItemsLabel, text: namedItems(closed) },
    { label: requestWords.freePushedHeadLabel, text: head },
    { label: requestWords.freeChecksLabel, text: CHECKS_PASSED },
    { label: requestWords.freeCheckedAtLabel, text: checkedAt },
  ],
});

export const freeLabelKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

const FREE_TITLE_KEY = freeLabelKey(requestWords.freeTitle);
const FREE_FIELD_KEY = freeLabelKey(requestWords.freeWorkerLabel);

const isFreeTitle = (title: string): boolean => {
  const key = freeLabelKey(title);
  return key === FREE_TITLE_KEY || key.startsWith(`${FREE_TITLE_KEY} `);
};

const isFreeField = (field: RequestField): boolean => freeLabelKey(field.label) === FREE_FIELD_KEY;

export const isReservedFreeForm = (title: string, fields: readonly RequestField[]): boolean =>
  isFreeTitle(title) || fields.some(isFreeField);

/** Read the command target from a strict request. No other stored text forms part of the command. */
export const freeWorkerOf = (request: DecideRequest): CliResult<string | null> => {
  const fields = request.fields?.filter(isFreeField) ?? [];
  if (fields.length === 0 && !isFreeTitle(request.title)) return ok(null);
  if (request.docs.length > 0) return failure(`the ${roles.worker} free ${requestWords.request} cannot have a doc`);
  const [field] = fields;
  if (fields.length !== 1 || field === undefined || !isSlug(field.text)) {
    return failure(`the ${roles.worker} free ${requestWords.request} needs one "${requestWords.freeWorkerLabel}" field with a ${roles.worker} id`);
  }
  return ok(field.text);
};

export const homeIssue = (home: string): string | null => visibleLineIssue(home);

/** Build command lines from the checked worker id and the checked board home. */
export const freeCommandLines = (id: string, home: string): readonly [string, string] => {
  const dryRun = `${commandText(commands.dismiss)} ${shellWord(id)} ${flagText(flags.home)} ${shellWord(home)}`;
  return [dryRun, `${dryRun} ${flagText(flags.yes)}`];
};
