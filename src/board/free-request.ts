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

/** Keep every id in the proof. A display count does not identify the closed items. */
export const closedItemsText = (ids: readonly string[]): string => ids.join(', ');

const FREE_OPTIONS = [requestWords.freeDone, requestWords.freeKept] as const;

const FREE_FIELDS = [
  [requestWords.freeWorkerLabel, ({ id }: FreeRequestFacts) => id],
  [requestWords.freeProjectLabel, ({ project }: FreeRequestFacts) => project],
  [requestWords.freeClosedItemsLabel, ({ closed }: FreeRequestFacts) => closedItemsText(closed)],
  [requestWords.freePushedHeadLabel, ({ head }: FreeRequestFacts) => head],
  [requestWords.freeChecksLabel, () => CHECKS_PASSED],
  [requestWords.freeCheckedAtLabel, ({ checkedAt }: FreeRequestFacts) => checkedAt],
] as const;

export const freeRequestOf = (facts: FreeRequestFacts): DecisionAskInput => ({
  title: freeTitleOf(facts.id),
  question: requestWords.freeQuestion,
  kind: requestKinds.command,
  group: requestGroups.now,
  options: FREE_OPTIONS,
  fields: FREE_FIELDS.map(([label, textOf]) => ({ label, text: textOf(facts) })),
});

const freeLabelKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

const FREE_TITLE_KEY = freeLabelKey(requestWords.freeTitle);
const FREE_FIELD_KEY = freeLabelKey(requestWords.freeWorkerLabel);

const isFreeTitle = (title: string): boolean => {
  const key = freeLabelKey(title);
  return key === FREE_TITLE_KEY || key.startsWith(`${FREE_TITLE_KEY} `);
};

const isFreeField = (field: RequestField): boolean => freeLabelKey(field.label) === FREE_FIELD_KEY;

export const isReservedFreeForm = (title: string, fields: readonly RequestField[]): boolean =>
  isFreeTitle(title) || fields.some(isFreeField);

/** Check the form and read the command target. This check does not prove the stored facts. */
export const freeWorkerOf = (request: DecideRequest): CliResult<string | null> => {
  const fields = request.fields ?? [];
  const workerFields = fields.filter(isFreeField);
  if (workerFields.length === 0 && !isFreeTitle(request.title)) return ok(null);
  if (request.docs.length > 0) return failure(`the ${roles.worker} free ${requestWords.request} cannot have a doc`);
  const [field] = workerFields;
  if (workerFields.length !== 1 || field === undefined || !isSlug(field.text)) {
    return failure(`the ${roles.worker} free ${requestWords.request} needs one "${requestWords.freeWorkerLabel}" field with a ${roles.worker} id`);
  }
  if (request.kind !== requestKinds.command || freeLabelKey(request.title) !== freeLabelKey(freeTitleOf(field.text))) {
    return failure(`the ${roles.worker} free ${requestWords.request} has the wrong title or kind`);
  }
  if (request.question !== requestWords.freeQuestion) {
    return failure(`the ${roles.worker} free ${requestWords.request} has the wrong question`);
  }
  if (request.options.length !== FREE_OPTIONS.length || !FREE_OPTIONS.every(({ key, text }) => request.options.some(
    (option) => option.key === key && option.text === text && option.why === undefined && option.rec !== true,
  ))) {
    return failure(`the ${roles.worker} free ${requestWords.request} needs the fixed options ${requestWords.freeDone.key} and ${requestWords.freeKept.key}`);
  }
  if (fields.length !== FREE_FIELDS.length || !FREE_FIELDS.every(([label]) => fields.some((field) => field.label === label))) {
    return failure(`the ${roles.worker} free ${requestWords.request} needs the six fields of the form`);
  }
  return ok(field.text);
};

export const homeIssue = (home: string): string | null => visibleLineIssue(home);

/** The owner can use either answer from a terminal outside the factory folder. */
export const freeAnswerLine = (request: string, key: typeof requestWords.freeDone.key | typeof requestWords.freeKept.key, home: string): string =>
  `${commandText(commands.decide)} ${request} ${key} ${flagText(flags.home)} ${shellWord(home)}`;

/** Build command lines from the checked worker id and the checked board home. */
export const freeCommandLines = (id: string, home: string): readonly [string, string] => {
  const dryRun = `${commandText(commands.dismiss)} ${shellWord(id)} ${flagText(flags.home)} ${shellWord(home)}`;
  return [dryRun, `${dryRun} ${flagText(flags.yes)}`];
};
