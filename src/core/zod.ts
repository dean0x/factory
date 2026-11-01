import type { z } from 'zod';

const MAX_ISSUES_SHOWN = 5;

const joinPath = (path: readonly PropertyKey[]): string => path.map(String).join('.');

/** One line for each issue, with the key path. The text never repeats the rejected value. */
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
