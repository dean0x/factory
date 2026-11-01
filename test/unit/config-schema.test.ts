import { describe, expect, it } from 'vitest';
import { configSchema, isSlug, slugify } from '../../src/config/schema.js';
import { describeIssues } from '../../src/core/zod.js';
import { parseProxyUrl } from '../../src/safety/proxy.js';
import { sampleObject } from '../helpers/sample-config.js';

type Mutate = (raw: Record<string, any>) => void;

const check = (mutate: Mutate) => {
  const raw = sampleObject();
  mutate(raw);
  const parsed = configSchema.safeParse(raw);
  return parsed.success ? null : describeIssues(parsed.error);
};

describe('config schema', () => {
  it('accepts the sample config and fills the defaults', () => {
    const raw = sampleObject();
    delete raw['proxies'];
    delete raw['cells'];
    delete raw['children'];
    const parsed = configSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.proxies).toEqual([]);
      expect(parsed.data.cells).toEqual({});
      expect(parsed.data.children).toEqual([]);
    }
  });

  it('accepts a full config with proxies, cells, children and a numeric load', () => {
    const message = check((raw) => {
      raw['proxies'] = [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health' }];
      raw['session'].proxy = 'local';
      raw['cells'] = { 'web-cell': { proxy: 'none' } };
      raw['limits'].load_max = 6;
      raw['children'] = [{ id: 'acme', address: 'acme/node' }];
      raw['owner'].github = 'some-login';
      raw['projects'][0].repo = 'acme/web';
      raw['projects'][0].heavy_test = 'npm test';
    });
    expect(message).toBeNull();
  });

  it('defaults on_fail to stop', () => {
    const raw = sampleObject();
    raw['proxies'] = [{ id: 'local', base_url: 'http://127.0.0.1:8787', health: '/health' }];
    const parsed = configSchema.parse(raw);
    expect(parsed.proxies[0]?.on_fail).toBe('stop');
  });

  describe('strictness', () => {
    it.each([
      ['top level', (raw: Record<string, any>) => (raw['extra'] = 1), 'extra: unknown key'],
      ['node', (raw: Record<string, any>) => (raw['node'].extra = 1), 'node.extra: unknown key'],
      ['owner', (raw: Record<string, any>) => (raw['owner'].extra = 1), 'owner.extra: unknown key'],
      ['session', (raw: Record<string, any>) => (raw['session'].extra = 1), 'session.extra: unknown key'],
      ['limits', (raw: Record<string, any>) => (raw['limits'].extra = 1), 'limits.extra: unknown key'],
      ['project', (raw: Record<string, any>) => (raw['projects'][0].extra = 1), 'projects.0.extra: unknown key'],
      ['gate', (raw: Record<string, any>) => (raw['projects'][0].gate.extra = 1), 'projects.0.gate.extra: unknown key'],
    ])('rejects an unknown key in %s and names it', (_name, mutate, expected) => {
      expect(check(mutate)).toContain(expected);
    });

    it('rejects an unknown key in a proxy, a cell and a child', () => {
      expect(
        check((raw) => {
          raw['proxies'] = [{ id: 'p', base_url: 'http://127.0.0.1:1', health: '/h', key: 'x' }];
        }),
      ).toContain('proxies.0.key: unknown key');
      expect(
        check((raw) => {
          raw['cells'] = { l: { proxy: 'none', extra: true } };
        }),
      ).toContain('cells.l.extra: unknown key');
      expect(
        check((raw) => {
          raw['children'] = [{ id: 'c', address: 'a', extra: 1 }];
        }),
      ).toContain('children.0.extra: unknown key');
    });
  });

  describe('invalid values name the key', () => {
    it.each([
      ['schema', (raw: Record<string, any>) => (raw['schema'] = 2), 'schema:'],
      ['node.id', (raw: Record<string, any>) => (raw['node'].id = 'Bad Id'), 'node.id:'],
      ['node.layer 0', (raw: Record<string, any>) => (raw['node'].layer = 0), 'node.layer:'],
      ['node.layer 17', (raw: Record<string, any>) => (raw['node'].layer = 17), 'node.layer:'],
      ['node.layer text', (raw: Record<string, any>) => (raw['node'].layer = 'coordinator'), 'node.layer:'],
      ['owner.display empty', (raw: Record<string, any>) => (raw['owner'].display = ''), 'owner.display:'],
      ['owner.display long', (raw: Record<string, any>) => (raw['owner'].display = 'x'.repeat(81)), 'owner.display:'],
      ['owner.github', (raw: Record<string, any>) => (raw['owner'].github = '-bad'), 'owner.github:'],
      ['owner.prefix without {owner}', (raw: Record<string, any>) => (raw['owner'].prefix = '[From me]'), 'owner.prefix:'],
      ['owner.prefix two lines', (raw: Record<string, any>) => (raw['owner'].prefix = '{owner}\nx'), 'owner.prefix:'],
      ['permission_mode', (raw: Record<string, any>) => (raw['session'].permission_mode = 'bypassPermissions'), 'session.permission_mode:'],
      ['effort', (raw: Record<string, any>) => (raw['session'].effort = 'extreme'), 'session.effort:'],
      ['model', (raw: Record<string, any>) => (raw['session'].model = ''), 'session.model:'],
      ['memory pct', (raw: Record<string, any>) => (raw['limits'].memory_free_min_pct = 91), 'limits.memory_free_min_pct:'],
      ['disk gb', (raw: Record<string, any>) => (raw['limits'].disk_free_min_gb = -1), 'limits.disk_free_min_gb:'],
      ['load_max', (raw: Record<string, any>) => (raw['limits'].load_max = 'many'), 'limits.load_max:'],
      ['prepare pct 0', (raw: Record<string, any>) => (raw['limits'].context_prepare_pct = 0), 'limits.context_prepare_pct:'],
      ['max pct 101', (raw: Record<string, any>) => (raw['limits'].context_max_pct = 101), 'limits.context_max_pct:'],
      ['prepare >= max', (raw: Record<string, any>) => (raw['limits'].context_prepare_pct = 40), 'limits.context_prepare_pct:'],
      ['project id', (raw: Record<string, any>) => (raw['projects'][0].id = '-x'), 'projects.0.id:'],
      ['project repo', (raw: Record<string, any>) => (raw['projects'][0].repo = 'no-slash'), 'projects.0.repo:'],
      ['project path absolute', (raw: Record<string, any>) => (raw['projects'][0].path = '/abs/web'), 'projects.0.path:'],
      ['project path leaves', (raw: Record<string, any>) => (raw['projects'][0].path = '../../web'), 'projects.0.path:'],
      ['project path tilde', (raw: Record<string, any>) => (raw['projects'][0].path = '~/web'), 'projects.0.path:'],
      ['project branch', (raw: Record<string, any>) => (raw['projects'][0].default_branch = '-x'), 'projects.0.default_branch:'],
      ['merge_method', (raw: Record<string, any>) => (raw['projects'][0].merge_method = 'fast'), 'projects.0.merge_method:'],
      ['variant', (raw: Record<string, any>) => (raw['projects'][0].variant = 'devflow'), 'projects.0.variant:'],
      ['gate.checks', (raw: Record<string, any>) => (raw['projects'][0].gate.checks = [1]), 'projects.0.gate.checks.0:'],
      ['heavy_test', (raw: Record<string, any>) => (raw['projects'][0].heavy_test = ''), 'projects.0.heavy_test:'],
      ['missing key', (raw: Record<string, any>) => delete raw['limits'], 'limits:'],
      ['child address', (raw: Record<string, any>) => (raw['children'] = [{ id: 'c', address: '' }]), 'children.0.address:'],
    ])('rejects %s', (_name, mutate, expected) => {
      expect(check(mutate)).toContain(expected);
    });

    it('accepts a project path with one .. and rejects two', () => {
      expect(check((raw) => (raw['projects'][0].path = '../web'))).toBeNull();
      expect(check((raw) => (raw['projects'][0].path = 'sub/web'))).toBeNull();
      expect(check((raw) => (raw['projects'][0].path = 'a/../../web'))).toBeNull();
      expect(check((raw) => (raw['projects'][0].path = 'a/../../../web'))).toContain('projects.0.path');
    });
  });

  describe('cross checks', () => {
    it('rejects duplicate ids', () => {
      expect(
        check((raw) => {
          raw['projects'].push({ ...raw['projects'][0] });
        }),
      ).toContain('projects.1.id: duplicate id');
      expect(
        check((raw) => {
          const proxy = { id: 'p', base_url: 'http://127.0.0.1:1', health: '/h' };
          raw['proxies'] = [proxy, proxy];
        }),
      ).toContain('proxies.1.id: duplicate id');
      expect(
        check((raw) => {
          raw['children'] = [
            { id: 'c', address: 'a' },
            { id: 'c', address: 'b' },
          ];
        }),
      ).toContain('children.1.id: duplicate id');
    });

    it('rejects a session proxy that is not defined', () => {
      expect(check((raw) => (raw['session'].proxy = 'ghost'))).toContain('session.proxy: names a proxy');
    });

    it('rejects a cell proxy that is not defined', () => {
      expect(check((raw) => (raw['cells'] = { l: { proxy: 'ghost' } }))).toContain('cells.l.proxy: names a proxy');
    });

    it('reserves the id none', () => {
      expect(
        check((raw) => {
          raw['proxies'] = [{ id: 'none', base_url: 'http://127.0.0.1:1', health: '/h' }];
        }),
      ).toContain('proxies.0.id: none is reserved');
    });
  });

  describe('proxy rules', () => {
    const withProxy = (base_url: string, health = '/health') =>
      check((raw) => {
        raw['proxies'] = [{ id: 'p', base_url, health }];
      });

    it('accepts http and https URLs with a port and a path', () => {
      expect(withProxy('http://127.0.0.1:8787')).toBeNull();
      expect(withProxy('https://proxy.example.com/v1')).toBeNull();
    });

    it.each([
      ['user info', 'http://user:pass@127.0.0.1:8787'],
      ['user name only', 'http://user@127.0.0.1:8787'],
      ['query', 'http://127.0.0.1:8787/?key=abc'],
      ['fragment', 'http://127.0.0.1:8787/#x'],
      ['other scheme', 'ftp://127.0.0.1'],
      ['not a URL', 'not a url'],
    ])('rejects a base_url with %s and does not repeat it', (_name, url) => {
      const message = withProxy(url);
      expect(message).toContain('proxies.0.base_url:');
      expect(message).not.toContain(url);
    });

    it.each([['health'], ['//evil.example.com'], ['/h?x=1'], ['/h h']])('rejects the health path %s', (health) => {
      expect(withProxy('http://127.0.0.1:1', health)).toContain('proxies.0.health:');
    });

    it('parseProxyUrl returns the URL for a valid value', () => {
      const parsed = parseProxyUrl('http://127.0.0.1:8787/v1');
      expect(parsed.ok && parsed.value.port).toBe('8787');
    });
  });

  describe('messages never repeat a rejected value', () => {
    it('does not echo a token in an enum, a literal, a regex or a number field', () => {
      const secret = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
      const message = check((raw) => {
        raw['session'].effort = secret;
        raw['session'].permission_mode = secret;
        raw['node'].id = secret;
        raw['limits'].load_max = secret;
        raw['projects'][0].merge_method = secret;
        raw['owner'].github = secret;
      });
      expect(message).not.toBeNull();
      expect(message).not.toContain('SECRET');
    });
  });
});

describe('slugs', () => {
  it('recognizes slugs', () => {
    expect(isSlug('web')).toBe(true);
    expect(isSlug('a-b-1')).toBe(true);
    expect(isSlug('-a')).toBe(false);
    expect(isSlug('A')).toBe(false);
    expect(isSlug('a'.repeat(41))).toBe(false);
  });

  it('makes slugs from folder names', () => {
    expect(slugify('My Project_2')).toBe('my-project-2');
    expect(slugify('--x--')).toBe('x');
    expect(slugify('***')).toBeNull();
    expect(slugify('a'.repeat(60))).toBe('a'.repeat(40));
    expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });
});
