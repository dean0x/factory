import { prefixPlaceholders } from '../names.js';

interface PrefixValues {
  readonly owner: string;
  readonly node: string;
  readonly date: string;
}

/** Fill the slots once. Text in a value stays literal. */
export const fillOwnerPrefix = (template: string, { owner, node, date }: PrefixValues): string =>
  template.replace(/\{owner\}|\{node\}|\{date\}/g, (slot) => {
    if (slot === prefixPlaceholders.owner) return owner;
    if (slot === prefixPlaceholders.node) return node;
    return date;
  });

/** Only the node and date slots vary. The literal parts must occur in order, with the exact letter case. */
export const hasOwnerPrefix = (decision: string, prefix: string, display: string): boolean => {
  const parts = prefix.split(prefixPlaceholders.node).flatMap((part) => part.split(prefixPlaceholders.date));
  let offset = 0;
  for (const part of parts) {
    const text = part.replaceAll(prefixPlaceholders.owner, () => display);
    const found = decision.indexOf(text, offset);
    if (found === -1) return false;
    offset = found + text.length;
  }
  return true;
};
