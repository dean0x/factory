import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';

const PROXY_URL_RULE = 'must be an http or https URL with no user info, query or fragment';

const PROXY_HEALTH_TIMEOUT_MS = 3000;
const HTTP_SERVER_ERROR = 500;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

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

/** The proxy as output shows it: the id, the host and the port. Nothing else of the URL. */
export const proxyLabel = (id: string, url: URL): string =>
  `${id} (${url.hostname}:${url.port === '' ? (DEFAULT_PORTS[url.protocol] ?? '') : url.port})`;

/** The URL of the health path: the path of the base URL, then the health path. */
export const healthUrl = (base: URL, health: string): string =>
  `${base.origin}${base.pathname.replace(/\/+$/, '')}${health}`;

export interface ProxyHealth {
  readonly up: boolean;
  /** The id, host and port. Safe to print. */
  readonly label: string;
}

/** One GET to the health path. Any HTTP answer below 500 means the proxy is up. */
export const checkProxyHealth = async (
  deps: Deps,
  proxy: { readonly id: string; readonly base_url: string; readonly health: string },
  timeoutMs: number = PROXY_HEALTH_TIMEOUT_MS,
): Promise<ProxyHealth> => {
  const base = parseProxyUrl(proxy.base_url);
  if (!base.ok) return { up: false, label: proxy.id };
  const answer = await deps.fetch(healthUrl(base.value, proxy.health), timeoutMs);
  return {
    up: answer.ok && answer.value.status < HTTP_SERVER_ERROR,
    label: proxyLabel(proxy.id, base.value),
  };
};
