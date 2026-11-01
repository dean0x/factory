import type { z } from 'zod';
import { looksLikeToken } from '../safety/secrets.js';

const MAX_ISSUES_SHOWN = 5;
const HIDDEN_KEY = '<key>';

/** A key that looks like a token is replaced, so the error text never repeats it. */
const hideTokenKey = (segment: PropertyKey): string => {
  const text = String(segment);
  return looksLikeToken(text) ? HIDDEN_KEY : text;
};

const joinPath = (path: readonly PropertyKey[]): string => path.map(hideTokenKey).join('.');

/**
 * One line for each issue, with the key path. A key that looks like a token is hidden.
 * The text never repeats a rejected value, because the Zod messages name the rule, not the value.
 */
export const describeIssues = (error: z.ZodError): string => {
  const lines = error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => `${joinPath([...issue.path, key])}: unknown key`)
      : [`${joinPath(issue.path) || '(top level)'}: ${issue.message}`],
  );
  const shown = lines.slice(0, MAX_ISSUES_SHOWN).join('; ');
  const hidden = lines.length - MAX_ISSUES_SHOWN;
  return hidden > 0 ? `${shown}; and ${hidden} more` : shown;
};
