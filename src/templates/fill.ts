import type { GuardValues } from '../guards/types.js';
import { capitalize, coordinatorTemplateValues, guardValues, layers, roles, templateValues } from '../names.js';
import type { BlockInput } from './types.js';

/** A piece of one line: plain text, or text that a guard keeps. */
export type TextSegment = string | { readonly guards: readonly string[]; readonly text: string };

/** A line, a group of lines that a guard keeps, or one line made of segments. */
export type TextPart =
  | string
  | { readonly guards: readonly string[]; readonly lines: readonly string[] }
  | { readonly segments: readonly TextSegment[] };

/** True for no guards, or for at least one guard on. An absent value means on. */
const keeps = (guards: readonly string[], values: GuardValues): boolean =>
  guards.length === 0 || guards.some((id) => values[id] !== guardValues.off);

const segmentText = (segment: TextSegment, values: GuardValues): string => {
  if (typeof segment === 'string') return segment;
  return keeps(segment.guards, values) ? segment.text : '';
};

/** Keep an unguarded group, or a group with at least one guard on. A line of segments keeps each segment by the same rule. */
export const linesFor = (parts: readonly TextPart[], values: GuardValues): readonly string[] =>
  parts.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if ('segments' in part) return [part.segments.map((segment) => segmentText(segment, values)).join('')];
    return keeps(part.guards, values) ? part.lines : [];
  });

const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/**
 * Join the lines of a template and fill its placeholders. {{worker}} gives the
 * value, and {{Worker}} gives the value with a capital first letter. An unknown
 * placeholder stays in the text, and a unit test finds it.
 */
export const fillTemplate = (
  lines: readonly string[],
  values: Readonly<Record<string, string>> = templateValues,
): string =>
  lines.join('\n').replace(PLACEHOLDER, (whole: string, name: string) => {
    const lower = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    const value = values[lower];
    if (value === undefined) return whole;
    return lower === name ? value : capitalize(value);
  });

/** The role word of the session that holds the workers: the manager on the manager layer, and the coordinator on any other layer. */
const contactWordOf = (holderLayer: number | undefined): string =>
  holderLayer === layers.manager ? roles.manager : roles.coordinator;

/**
 * The values for the text of a worker: the paths are written from the factory folder, and the id of the node is filled in.
 * The word `coordinator` is the role word of the session that the worker reports to, which follows the layer of the node that
 * holds the worker. A value is put in the text as it is, and it is not read again for placeholders.
 */
export const workerValuesFor = (input: BlockInput): Readonly<Record<string, string>> => ({
  ...templateValues,
  coordinator: contactWordOf(input.holderLayer),
  nodeId: input.nodeId,
});

/**
 * The values for the texts in the coordinator folder: the paths are written from that folder, and the id of the node, the
 * owner prefix of the local file and the context limits of the shared file are filled in. A value is put in the text as
 * it is, and it is not read again for placeholders.
 */
export const coordinatorValuesFor = (input: BlockInput): Readonly<Record<string, string>> => ({
  ...coordinatorTemplateValues,
  nodeId: input.nodeId,
  ownerPrefix: input.ownerPrefix,
  preparePct: String(input.limits.contextPreparePct),
  maxPct: String(input.limits.contextMaxPct),
});
