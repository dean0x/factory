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

/**
 * True when the text looks like a token: a known prefix, a hex run of 40 characters or more,
 * or a long base64 run. A long name in lower case with hyphens, or a path, is not a token.
 */
export const looksLikeToken = (text: string): boolean =>
  TOKEN_PREFIXES.some((pattern) => pattern.test(text)) ||
  HEX_RUN.test(text) ||
  (text.match(BASE64_RUN) ?? []).some(isRandomLooking);

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
      if (looksLikeToken(value)) found.push(path.join('.'));
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
