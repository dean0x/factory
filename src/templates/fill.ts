import { capitalize, coordinatorTemplateValues, templateValues } from '../names.js';
import type { BlockInput } from './types.js';

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

/**
 * The values for the text of a worker: the paths are written from the factory folder, and the id of the node is filled in.
 * A value is put in the text as it is, and it is not read again for placeholders.
 */
export const workerValuesFor = (input: BlockInput): Readonly<Record<string, string>> => ({
  ...templateValues,
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
