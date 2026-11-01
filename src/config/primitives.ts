import { z } from 'zod';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG_RULE = 'must be a slug: a-z, 0-9 and hyphen, at most 40 characters, no leading hyphen';
const MAX_SLUG_LENGTH = 40;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export const isGithubLogin = (text: string): boolean => GITHUB_LOGIN_PATTERN.test(text);

export const isSlug = (text: string): boolean => SLUG_PATTERN.test(text);

export const isBranchName = (text: string): boolean => BRANCH_PATTERN.test(text);

/** Make a slug from free text, or null when nothing is left. */
export const slugify = (text: string): string | null => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? null : slug;
};

/** The schema pieces that the core and every recipe share. */
export const slug = z.string().regex(SLUG_PATTERN, SLUG_RULE);

export const githubLogin = z.string().regex(GITHUB_LOGIN_PATTERN, 'must be a GitHub login');

export const branchName = z.string().regex(BRANCH_PATTERN, 'must be a branch name');

/** Add an issue for each item that repeats the id of an earlier item of the same list. */
export const uniqueIds = (
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  idKey: string,
  items: readonly { readonly id: string }[],
): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate id', path: [...path, index, idKey] });
    }
    seen.add(item.id);
  });
};
