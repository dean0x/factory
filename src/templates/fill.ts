import { capitalize, templateValues } from '../names.js';

const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/**
 * Join the lines of a template and fill its placeholders. {{cell}} gives the
 * value, and {{Cell}} gives the value with a capital first letter. An unknown
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
