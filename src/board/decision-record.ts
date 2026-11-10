import { join } from 'node:path';
import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { isSlug, slugify } from '../config/primitives.js';
import { ok } from '../core/result.js';
import { boardIds, boardLimits, requestWords, roles } from '../names.js';
import { stateRel } from '../state/layout.js';

/**
 * The profile record of an owner decision (design 4.10, AC-16, AC-43): the text of one record file of the decision profile, its path,
 * and the new text of the log of the profile. The builder is pure: it writes no file and reads no clock, and the caller commits the
 * texts with the board files. The profile record is a display copy. The proof of an owner answer is only the record in the owner store.
 *
 * Every text of the request and the note come from the person or from a stored file, so none of them can change the shape of the
 * record. Each goes into the body as a JSON string after a fixed label. The brackets of the text are written as the six-character JSON
 * escapes, so a text can not make a link, and the separators of lines that JSON leaves as they are are escaped too, so a text stays on
 * its line in a reader that counts them as breaks. The frontmatter holds only values that the builder makes from a checked input.
 */

/** One option of the request, as the waiting entry holds it. */
export interface DecisionRecordOption {
  readonly key: string;
  readonly text: string;
  /** True for the option that the asker recommends. */
  readonly rec?: boolean;
}

/** The parts of a waiting entry that the record shows. */
export interface DecisionRecordRequest {
  readonly id: string;
  readonly title: string;
  readonly question: string;
  readonly options: readonly DecisionRecordOption[];
}

export interface DecisionRecordInput {
  /** The id of the node: the `context` of the record. */
  readonly node: string;
  readonly request: DecisionRecordRequest;
  /** The key of the chosen option. */
  readonly option: string;
  /** The time of the record, as the owner store holds it: an ISO time in UTC. */
  readonly at: string;
  /** The reason of the owner, or null when the owner gave none. The caller checked it. */
  readonly note: string | null;
  /** The text of the log of the profile now, or null when the file is not there. */
  readonly log: string | null;
}

export interface DecisionRecord {
  /** The path of the record file, relative to the state folder. */
  readonly path: string;
  /** The text of the record file. */
  readonly text: string;
  /** The new text of the log of the profile. */
  readonly log: string;
}

/** The first text of a log of the profile that is not there. */
const FIRST_LOG = '# Decision log\n\n';

const DATE_CHARS = 10;
const MD_SUFFIX = '.md';

/**
 * The characters that a JSON string leaves as they are and that a reader of the text can still take for a bracket or for the end of a
 * line: the brackets, the next-line character, the line separator and the paragraph separator.
 */
const ESCAPED = /[[\]\u0085\p{Zl}\p{Zp}]/gu;

/** The text as a JSON string literal on one line, with each bracket and each separator of lines as a six-character escape. */
const jsonText = (text: string): string =>
  JSON.stringify(text).replace(ESCAPED, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const isUtcTime = (text: string): boolean => z.iso.datetime().safeParse(text).success;

/** What the path of a record file comes from: the id and the title of the request, and the time of the record. */
export interface DecisionRecordPathInput {
  readonly id: string;
  readonly title: string;
  readonly at: string;
}

/**
 * The path of the record file of a decision, relative to the state folder: `decision-profile/decisions/<date>-d-<n>[-<slug>].md`.
 * The date is the UTC date of the time. The slug is the slug of the title, cut by the rule of `slugify`; a title with no slug gives a
 * name with no slug part. A fault is a failure (exit 1) that repeats no stored text.
 */
export const decisionRecordPath = (input: DecisionRecordPathInput): CliResult<string> => {
  if (!boardIds.canonicalRequest.test(input.id)) return failure('the decision id is not of the form D-n');
  if (!isUtcTime(input.at)) return failure('the time of the decision is not an ISO time in UTC');
  const slug = slugify(input.title);
  const name = `${input.at.slice(0, DATE_CHARS)}-${input.id.toLowerCase()}${slug === null ? '' : `-${slug}`}${MD_SUFFIX}`;
  return ok(join(stateRel.profileDecisions, name));
};

/** The line of the option list: the key, the text, and the marks. */
const optionLine = (option: DecisionRecordOption, chosen: string): string =>
  `- ${option.key}: ${jsonText(option.text)}${option.rec === true ? ' (recommended)' : ''}${option.key === chosen ? ' (chosen)' : ''}`;

/** Every input that the record shows, checked: the shown form of the node and of every option key never needs an escape. */
const checkedInput = (input: DecisionRecordInput): CliResult<void> => {
  if (!isSlug(input.node)) return failure(`the ${roles.node} id is not a slug`);
  if (input.request.options.some((option) => !boardLimits.tokenPattern.test(option.key))) {
    return failure(`an option key of the ${requestWords.request} is not a token`);
  }
  if (!input.request.options.some((option) => option.key === input.option)) {
    return failure(`the chosen option is not one of the options of the ${requestWords.request}`);
  }
  return ok(undefined);
};

/**
 * The new text of the log of the profile: one line at the top of the list, below the first heading of level one. A text with no such
 * heading gets the line at its start. A text that is not there gets the first text, then the line.
 */
const logWith = (current: string | null, line: string): string => {
  if (current === null) return `${FIRST_LOG}${line}\n`;
  const lines = current.split('\n');
  const heading = lines.findIndex((text) => text.startsWith('# '));
  if (heading === -1) return `${line}\n${current}`;
  if (lines.slice(heading + 1).every((text) => text === '')) return `${lines.slice(0, heading + 1).join('\n')}\n\n${line}\n`;
  const at = lines[heading + 1] === '' ? heading + 2 : heading + 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
};

/**
 * Build the record of an owner decision: its path, its text and the new text of the log of the profile. The frontmatter has the date,
 * the time, the node id as the context, an empty list of principles and the word that the owner decided. The body has the sections
 * of the template in order: the question, the options, the choice, the reason and the consequences. A fault is a failure (exit 1)
 * that repeats no stored text.
 */
export const buildDecisionRecord = (input: DecisionRecordInput): CliResult<DecisionRecord> => {
  const checked = checkedInput(input);
  if (!checked.ok) return checked;
  const { request, option, at, note } = input;
  const path = decisionRecordPath({ id: request.id, title: request.title, at });
  if (!path.ok) return path;

  const date = at.slice(0, DATE_CHARS);
  const text = [
    '---',
    `date: ${date}`,
    `time: ${at}`,
    `context: ${input.node}`,
    'principles: []',
    `decided_by: ${roles.owner}`,
    '---',
    '',
    '## Question',
    '',
    `Title: ${jsonText(request.title)}`,
    `Question: ${jsonText(request.question)}`,
    '',
    '## Options',
    '',
    ...request.options.map((each) => optionLine(each, option)),
    '',
    '## Choice',
    '',
    `Option: ${option}`,
    '',
    '## Reason',
    '',
    note === null ? `The ${roles.owner} gave no reason.` : `Note: ${jsonText(note)}`,
    '',
    '## Consequences or follow-ups',
    '',
    'None recorded.',
    '',
  ].join('\n');

  const stem = path.value.slice(path.value.lastIndexOf('/') + 1, -MD_SUFFIX.length);
  const line = `- ${date} ${request.id}: ${option} ([[${stem}]])`;
  return ok({ path: path.value, text, log: logWith(input.log, line) });
};
