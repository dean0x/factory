import { err, ok, type Result } from '../core/result.js';

export const PROXY_URL_RULE = 'must be an http or https URL with no user info, query or fragment';

/** Parse a proxy base URL. The error never repeats the value: it can hold secrets. */
export const parseProxyUrl = (raw: string): Result<URL, string> => {
  if (!URL.canParse(raw) || /[@?#\s]/.test(raw)) return err(PROXY_URL_RULE);
  const url = new URL(raw);
  const allowedScheme = url.protocol === 'http:' || url.protocol === 'https:';
  if (!allowedScheme || url.hostname === '' || url.username !== '' || url.password !== '') {
    return err(PROXY_URL_RULE);
  }
  return ok(url);
};
