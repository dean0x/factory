import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';

const MAX_PATH_CHARS = 4096;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG_RULE = 'must be a slug: a-z, 0-9 and hyphen, at most 40 characters, no leading hyphen';
const MAX_SLUG_LENGTH = 40;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export const isGithubLogin = (text: string): boolean => GITHUB_LOGIN_PATTERN.test(text);

export const isSlug = (text: string): boolean => SLUG_PATTERN.test(text);

export const isBranchName = (text: string): boolean => BRANCH_PATTERN.test(text);

const MAX_DURATION_DIGITS = 6;
const MINUTES_PER_HOUR = 60;
/** `<n>m` or `<n>h`, with no leading zero. The amount `0` has no leading zero, so the bounds of the caller refuse it. */
const DURATION_PATTERN = new RegExp(`^(0|[1-9][0-9]{0,${MAX_DURATION_DIGITS - 1}})([mh])$`);

/**
 * The minutes of a duration text `<n>m` or `<n>h`. The value is null for any other text, and for a duration below `min` or above
 * `max` minutes. The watch interval of a tracker, the idle limit of a worker and the time of a summon use this one reader.
 */
export const durationMinutes = (text: string, min: number, max: number): number | null => {
  const match = DURATION_PATTERN.exec(text);
  if (match === null) return null;
  const minutes = Number(match[1]) * (match[2] === 'h' ? MINUTES_PER_HOUR : 1);
  return minutes >= min && minutes <= max ? minutes : null;
};

/** A folder path without its `.` segments and its slashes at the end, so two ways to write one path give one key. */
export const folderKey = (path: string): string => posix.normalize(path).replace(/\/+$/, '');

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

/** An absolute path of at most 4096 characters, as a per-user file holds it. */
export const absolutePath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((path) => isAbsolute(path), 'must be an absolute path');

export const githubLogin =z.string().regex(GITHUB_LOGIN_PATTERN, 'must be a GitHub login');

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
