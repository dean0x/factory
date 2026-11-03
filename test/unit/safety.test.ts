import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { checkProxyHealth, healthUrl, parseProxyUrl, proxyLabel } from '../../src/safety/proxy.js';
import { findTokenPaths, looksLikeToken, textHasToken } from '../../src/safety/secrets.js';
import { FAKE_GITHUB_OAUTH_TOKEN, FAKE_GITHUB_TOKEN, FAKE_GOOGLE_API_KEY } from '../helpers/fake-secret.js';

describe('looksLikeToken', () => {
  it.each([
    ['an Anthropic key', 'sk-ant-api03-abcdefghijklmnop'],
    ['a GitHub personal token', FAKE_GITHUB_TOKEN],
    ['a GitHub OAuth token', FAKE_GITHUB_OAUTH_TOKEN],
    ['a GitHub fine-grained token', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv'],
    ['a Slack bot token', 'xoxb-1234567890-abcdefghij'],
    ['a Slack app token', 'xoxa-1234567890-abcdefghij'],
    ['a Slack user token', 'xoxp-1234567890-abcdefghij'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a Google API key', FAKE_GOOGLE_API_KEY],
    ['a 40 character hex string', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['a long base64 string', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY12'],
    ['a token inside a URL', `http://127.0.0.1:8787/${FAKE_GITHUB_TOKEN}`],
    ['a base64url string', 'Zm9vYmFyQmF6X3F1eC1URVNUMDEyMzQ1Njc4OWFiY2RlZg'],
  ])('is true for %s', (_name, text) => {
    expect(looksLikeToken(text)).toBe(true);
  });

  it.each([
    ['a slug', 'acme-web'],
    ['a prefix alone', 'sk-ant-'],
    ['AKIA alone', 'AKIA'],
    ['AIza alone', 'AIza'],
    ['a Google key prefix with 34 characters', FAKE_GOOGLE_API_KEY.slice(0, -1)],
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

describe('textHasToken (TP-45)', () => {
  it.each([
    ['a GitHub token in a line', `token: ${FAKE_GITHUB_TOKEN}\n`],
    ['an Anthropic key in a sentence', 'Use sk-ant-api03-abcdefghijklmnop for the proxy.'],
    ['a 40 character hex run', 'key = da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['a base64 secret with a plus sign', 'secret: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY12'],
    ['a base64url run', 'value: Zm9vYmFyQmF6X3F1eC1URVNUMDEyMzQ1Njc4OWFiY2RlZg'],
    ['a token on the last line of many', `${'a line of text\n'.repeat(200)}${FAKE_GOOGLE_API_KEY}`],
  ])('is true for %s', (_name, text) => {
    expect(textHasToken(text)).toBe(true);
  });

  it.each([
    ['a long path with upper case, lower case and digits', 'See /var/folders/fn/xhrkn4ys4d37t9fd8kfmd4rw0000gn/T/Work/payments-team-factory-2 for it.'],
    ['a long URL', 'https://github.com/Payments-Team-Org/payments-team-factory-service-2'],
    ['plain prose', 'The quick brown fox jumps over the lazy dog and keeps running.'],
    ['a short hex string', 'commit da39a3ee'],
    ['a prefix alone', 'The key starts with sk-ant- and goes on.'],
    ['an empty text', ''],
  ])('is false for %s', (_name, text) => {
    expect(textHasToken(text)).toBe(false);
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
    expect(findTokenPaths({ workers: { [key]: 'sk-ant-api03-abcdefgh' } })).toEqual(['workers.<key>']);
  });

  describe('the local source and the clone URL of a project', () => {
    const LONG_FOLDER = '/var/folders/fn/xhrkn4ys4d37t9fd8kfmd4rw0000gn/T/Work/payments-team-factory-2';
    const LONG_URL = 'https://github.com/Payments-Team-Org/payments-team-factory-service-2';

    it('is not a token when it is a long path with upper case, lower case and digits', () => {
      expect(looksLikeToken(LONG_FOLDER)).toBe(true);
      expect(looksLikeToken(LONG_URL)).toBe(true);
      expect(
        findTokenPaths({
          sources: { '../web': LONG_FOLDER, '../api': `file://${LONG_FOLDER}` },
          recipe: { projects: [{ id: 'web', url: LONG_URL, path: '../web' }] },
        }),
      ).toEqual([]);
    });

    it('is a token when it holds a known prefix or a hex run', () => {
      const hex = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      expect(
        findTokenPaths({
          sources: { '../web': `/Users/example/${FAKE_GITHUB_TOKEN}`, '../api': `/Users/example/${hex}` },
          recipe: { projects: [{ id: 'web', url: `https://github.com/acme/${FAKE_GITHUB_TOKEN}` }] },
        }),
      ).toEqual(['sources.../web', 'sources.../api', 'recipe.projects.0.url']);
    });

    it('keeps the base64 test for the same text in any other place', () => {
      expect(
        findTokenPaths({
          sources: { '../web': { nested: LONG_FOLDER } },
          recipe: { projects: [{ id: 'web', path: LONG_FOLDER, repo: LONG_URL }], url: LONG_URL },
          url: LONG_URL,
        }),
      ).toEqual(['sources.../web.nested', 'recipe.projects.0.path', 'recipe.projects.0.repo', 'recipe.url', 'url']);
    });
  });

  describe('the address of a node link', () => {
    const LONG_ADDRESS = 'file:///Users/example/Work/payments-team-factory-2';

    it('is not a token when it is a long path with upper case, lower case and digits', () => {
      expect(findTokenPaths({ parent: { id: 'up', address: LONG_ADDRESS } })).toEqual([]);
      expect(
        findTokenPaths({
          children: [
            { id: 'a', address: 'file:///w/a' },
            { id: 'b', address: LONG_ADDRESS },
          ],
        }),
      ).toEqual([]);
    });

    it('is a token when it holds a known prefix or a hex run', () => {
      const hex = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      expect(
        findTokenPaths({
          parent: { id: 'up', address: `file:///Users/example/${FAKE_GITHUB_TOKEN}` },
          children: [
            { id: 'a', address: `file:///Users/example/${hex}` },
            { id: 'b', address: 'file:///Users/example/sk-ant-api03-abcdefgh' },
          ],
        }),
      ).toEqual(['parent.address', 'children.0.address', 'children.1.address']);
    });

    it('keeps the base64 test for an address that is not a file address', () => {
      expect(findTokenPaths({ parent: { id: 'up', address: 'https://host/Users/example/Work/payments-team-factory-2' } })).toEqual([
        'parent.address',
      ]);
    });

    it('keeps the base64 test for the same text in any other place', () => {
      expect(looksLikeToken(LONG_ADDRESS)).toBe(true);
      expect(
        findTokenPaths({
          recipe: { projects: [{ path: LONG_ADDRESS }] },
          parent: { id: LONG_ADDRESS },
          children: [{ id: 'a', note: LONG_ADDRESS }],
          address: LONG_ADDRESS,
        }),
      ).toEqual(['recipe.projects.0.path', 'parent.id', 'children.0.note', 'address']);
    });
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
