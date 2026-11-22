import { prefixPlaceholders } from '../names.js';

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
