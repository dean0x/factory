import { address, keys } from '../names.js';

const TOKEN_PREFIXES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{4,}/,
  /gh[po]_[A-Za-z0-9]{8,}/,
  /github_pat_[A-Za-z0-9_]{8,}/,
  /xox[abp]-[A-Za-z0-9-]{8,}/,
  /AKIA[A-Z0-9]{8,}/,
  /AIza[A-Za-z0-9_-]{35}/,
];

const HEX_RUN = /[0-9a-fA-F]{40,}/;
const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}/g;
const MAX_DEPTH = 16;
const MAX_NODES = 5000;
const HIDDEN_KEY = '<key>';

/** A long run that mixes lower case, upper case and digits looks like random data. */
const isRandomLooking = (run: string): boolean => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);

/** True when the text holds a known token prefix or a hex run of 40 characters or more. */
const hasKnownTokenShape = (text: string): boolean =>
  TOKEN_PREFIXES.some((pattern) => pattern.test(text)) || HEX_RUN.test(text);

/**
 * True when the text looks like a token: a known prefix, a hex run of 40 characters or more,
 * or a long base64 run. A long name in lower case with hyphens, or a path, is not a token.
 */
export const looksLikeToken = (text: string): boolean =>
  hasKnownTokenShape(text) || (text.match(BASE64_RUN) ?? []).some(isRandomLooking);

/** A run with a slash and no plus sign is a path or a URL: the base64 alphabet needs a plus sign to hold a slash. */
const isPathLike = (run: string): boolean => run.includes('/') && !run.includes('+');

/**
 * True when the text of a file holds a token: a known prefix, a hex run of 40 characters or more, or a long base64 run.
 * A text holds paths and URLs, and a long path with mixed letters and digits looks like random data, so a run that is a
 * path (see `isPathLike`) is not a token. The check is for the tracked text files of the root.
 */
export const textHasToken = (text: string): boolean =>
  hasKnownTokenShape(text) || (text.match(BASE64_RUN) ?? []).some((run) => !isPathLike(run) && isRandomLooking(run));

const ITEM_INDEX = /^\d+$/;

/** The key path of the address of a node link: `parent.address` or `children.<n>.address`. */
const isLinkAddressPath = (path: readonly string[]): boolean => {
  const [first, ...rest] = path;
  if (first === keys.root.parent) return rest.length === 1 && rest[0] === keys.link.address;
  return first === keys.root.children && rest.length === 2 && ITEM_INDEX.test(rest[0] ?? '') && rest[1] === keys.link.address;
};

/** The key path of the local source of a project: `sources.<project path>`. */
const isSourcePath = (path: readonly string[]): boolean => path.length === 2 && path[0] === keys.root.sources;

/** The key path of the clone URL of a project: `recipe.projects.<n>.url`. */
const isCloneUrlPath = (path: readonly string[]): boolean => {
  const [first, second, index, last, ...rest] = path;
  return (
    first === keys.root.recipe &&
    second === keys.recipe.projects &&
    ITEM_INDEX.test(index ?? '') &&
    last === keys.project.url &&
    rest.length === 0
  );
};

/**
 * A file address of a node link, the local source of a project and the clone URL of a project are long paths, and a
 * path holds `/` like base64 does. The schema checks the user and the secret part of the last two. So these values get
 * the tests of the known prefix and of the hex run only. Any other value gets all the tests.
 */
const looksLikeTokenAt = (path: readonly string[], text: string): boolean => {
  const isPathValue =
    (isLinkAddressPath(path) && text.startsWith(address.scheme)) || isSourcePath(path) || isCloneUrlPath(path);
  return isPathValue ? hasKnownTokenShape(text) : looksLikeToken(text);
};

/** A key that looks like a token is replaced, so a path or an error text never repeats it. */
export const hideTokenKey = (segment: PropertyKey): string => {
  const text = String(segment);
  return looksLikeToken(text) ? HIDDEN_KEY : text;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The key paths of the string values that look like tokens, for example `proxies.0.base_url`.
 * The result never holds a value. A key that looks like a token is hidden.
 */
export const findTokenPaths = (raw: unknown): readonly string[] => {
  const found: string[] = [];
  let budget = MAX_NODES;

  const visit = (value: unknown, path: readonly string[], depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH) return;
    budget -= 1;
    if (typeof value === 'string') {
      if (looksLikeTokenAt(path, value)) found.push(path.join('.'));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, [...path, hideTokenKey(key)], depth + 1);
      }
    }
  };

  visit(raw, [], 0);
  return found;
};
