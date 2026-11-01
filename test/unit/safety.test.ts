import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { checkProxyHealth, healthUrl, parseProxyUrl, proxyLabel } from '../../src/safety/proxy.js';
import { findTokenPaths, looksLikeToken } from '../../src/safety/secrets.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';

describe('looksLikeToken', () => {
  it.each([
    ['an Anthropic key', 'sk-ant-api03-abcdefghijklmnop'],
    ['a GitHub personal token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a GitHub OAuth token', 'gho_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a GitHub fine-grained token', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv'],
    ['a Slack bot token', 'xoxb-1234567890-abcdefghij'],
    ['a Slack app token', 'xoxa-1234567890-abcdefghij'],
    ['a Slack user token', 'xoxp-1234567890-abcdefghij'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a 40 character hex string', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['a long base64 string', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY12'],
    ['a token inside a URL', 'http://127.0.0.1:8787/ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a base64url string', 'Zm9vYmFyQmF6X3F1eC1URVNUMDEyMzQ1Njc4OWFiY2RlZg'],
  ])('is true for %s', (_name, text) => {
    expect(looksLikeToken(text)).toBe(true);
  });

  it.each([
    ['a slug', 'acme-web'],
    ['a prefix alone', 'sk-ant-'],
    ['AKIA alone', 'AKIA'],
    ['a plain URL', 'http://127.0.0.1:8787/health'],
    ['a relative path', '../some/long/folder/name/with/many/parts/of/a/path'],
    ['a long lower case branch name with digits', 'fix-the-thing-that-broke-in-release-2024-10-04-again-and-again'],
    ['a sentence', 'The quick brown fox jumps over the lazy dog and keeps running'],
    ['a short hex string', 'da39a3ee'],
    ['a command', 'npm run lint && npm test -- --coverage'],
    ['a name', 'Test Owner'],
    ['an empty string', ''],
  ])('is false for %s', (_name, text) => {
    expect(looksLikeToken(text)).toBe(false);
  });
});

describe('findTokenPaths', () => {
  it('returns the key paths and never a value', () => {
    const secret = FAKE_GITHUB_TOKEN;
    const paths = findTokenPaths({
      a: { b: [{ c: secret }, { c: 'fine' }] },
      d: secret,
      e: 5,
      f: null,
    });
    expect(paths).toEqual(['a.b.0.c', 'd']);
    expect(JSON.stringify(paths)).not.toContain('ghp_');
  });

  it('hides a key that looks like a token', () => {
    const key = FAKE_GITHUB_TOKEN;
    expect(findTokenPaths({ lanes: { [key]: 'sk-ant-api03-abcdefgh' } })).toEqual(['lanes.<key>']);
  });

  it('finds nothing in clean data and in a value that is not an object', () => {
    expect(findTokenPaths({ a: 'x' })).toEqual([]);
    expect(findTokenPaths('plain')).toEqual([]);
    expect(findTokenPaths(undefined)).toEqual([]);
  });

  it('stops at a fixed depth and a fixed node count', () => {
    let deep: unknown = 'sk-ant-api03-abcdefgh';
    for (let level = 0; level < 40; level += 1) deep = { next: deep };
    expect(findTokenPaths(deep)).toEqual([]);
    const wide = Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`k${i}`, i === 5999 ? 'sk-ant-api03-abcdefgh' : 'x']));
    expect(findTokenPaths(wide)).toEqual([]);
  });
});

describe('proxy label and health URL', () => {
  const parse = (text: string): URL => {
    const parsed = parseProxyUrl(text);
    if (!parsed.ok) throw new Error('bad test URL');
    return parsed.value;
  };

  it('shows only the id, the host and the port', () => {
    expect(proxyLabel('local', parse('http://127.0.0.1:8787/v1'))).toBe('local (127.0.0.1:8787)');
    expect(proxyLabel('edge', parse('https://proxy.example.com/v1'))).toBe('edge (proxy.example.com:443)');
    expect(proxyLabel('plain', parse('http://proxy.example.com'))).toBe('plain (proxy.example.com:80)');
  });

  it('joins the path of the base URL and the health path', () => {
    expect(healthUrl(parse('http://127.0.0.1:8787'), '/health')).toBe('http://127.0.0.1:8787/health');
    expect(healthUrl(parse('http://127.0.0.1:8787/v1/'), '/health')).toBe('http://127.0.0.1:8787/v1/health');
  });
});

describe('checkProxyHealth', () => {
  const deps = createNodeDeps();
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow') return;
      response.statusCode = request.url === '/broken' ? 500 : request.url === '/missing' ? 404 : 200;
      response.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const proxy = (health: string, baseUrl = base) => ({ id: 'local', base_url: baseUrl, health });

  it('is up for a 200 answer and for any answer below 500', async () => {
    expect((await checkProxyHealth(deps, proxy('/health'))).up).toBe(true);
    expect((await checkProxyHealth(deps, proxy('/missing'))).up).toBe(true);
  });

  it('is down for a 500 answer', async () => {
    expect((await checkProxyHealth(deps, proxy('/broken'))).up).toBe(false);
  });

  it('is down when nothing answers in time', async () => {
    expect((await checkProxyHealth(deps, proxy('/slow'), 150)).up).toBe(false);
  });

  it('is down when the port is closed', async () => {
    expect((await checkProxyHealth(deps, proxy('/health', 'http://127.0.0.1:1'), 1000)).up).toBe(false);
  });

  it('returns a label with the id, the host and the port only', async () => {
    const health = await checkProxyHealth(deps, proxy('/health'));
    expect(health.label).toBe(`local (127.0.0.1:${new URL(base).port})`);
  });

  it('is down, with the id as the label, for a base URL that is not valid', async () => {
    expect(await checkProxyHealth(deps, proxy('/health', 'http://user:pass@127.0.0.1:1'))).toEqual({
      up: false,
      label: 'local',
    });
  });
});
