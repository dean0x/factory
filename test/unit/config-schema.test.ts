import { describe, expect, it } from 'vitest';
import { isSlug, slugify } from '../../src/config/primitives.js';
import { configSchema } from '../../src/config/schema.js';
import { describeIssues } from '../../src/core/zod.js';
import { values } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { parseProxyUrl } from '../../src/safety/proxy.js';
import { sampleObject } from '../helpers/sample-config.js';

type Raw = Record<string, any>;
type Mutate = (raw: Raw) => void;

const check = (mutate: Mutate) => {
  const raw = sampleObject();
  mutate(raw);
  const parsed = configSchema.safeParse(raw);
  return parsed.success ? null : describeIssues(parsed.error);
};

const parsedOf = (raw: Raw) => {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  return parsed.data;
};

const hosted = (raw: Raw, extra: Raw = {}): void => {
  raw['tracker'] = { kind: 'github', items: 'acme/web', decisions: 'acme/decisions', ...extra };
};

describe('config schema 2', () => {
  it('accepts the sample config and returns the core and the recipe apart', () => {
    const parsed = configSchema.safeParse(sampleObject());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.core.node).toEqual({ id: 'demo', layer: 1 });
    expect(parsed.data.core.tracker).toEqual({ kind: 'local' });
    expect(parsed.data.recipe.id).toBe('software');
    expect(parsed.data.recipe.projects.map((project) => project.id)).toEqual(['web']);
    expect(Object.keys(parsed.data.core)).not.toContain('recipe');
  });

  it('fills the defaults of the optional keys', () => {
    const raw = sampleObject();
    for (const key of ['proxies', 'workers', 'children', 'parent', 'approval']) delete raw[key];
    const parsed = configSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.core.proxies).toEqual([]);
    expect(parsed.data.core.workers).toEqual({});
    expect(parsed.data.core.children).toEqual([]);
    expect(parsed.data.core.parent).toBeNull();
    expect(parsed.data.core.approval).toEqual({ land: 'each' });
  });

  it('accepts a full config with proxies, workers, links, a hosted tracker and a numeric load', () => {
    const message = check((raw) => {
      raw['proxies'] = [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health' }];
      raw['session'].proxy = 'local';
      raw['workers'] = { 'web-search': { proxy: 'none' } };
      raw['limits'].load_max = 6;
      raw['parent'] = { id: 'acme', address: 'file:///srv/nodes/acme-factory' };
      raw['children'] = [{ id: 'web', address: 'file:///srv/nodes/web-factory' }];
      raw['owner'].github = 'some-login';
      raw['approval'] = { land: 'approved-work' };
      hosted(raw, { watch_interval: '2h' });
      raw['recipe'].projects[0].repo = 'acme/web';
      raw['recipe'].projects[0].heavy_test = 'npm test';
      raw['recipe'].projects[0].variant = 'plain';
    });
    expect(message).toBeNull();
  });

  it('defaults on_fail to stop', () => {
    const raw = sampleObject();
    raw['proxies'] = [{ id: 'local', base_url: 'http://127.0.0.1:8787', health: '/health' }];
    const parsed = parsedOf(raw);
    expect(parsed.core.proxies[0]?.on_fail).toBe('stop');
  });

  describe('strictness', () => {
    it.each([
      ['top level', (raw: Raw) => (raw['extra'] = 1), 'extra: unknown key'],
      ['node', (raw: Raw) => (raw['node'].extra = 1), 'node.extra: unknown key'],
      ['owner', (raw: Raw) => (raw['owner'].extra = 1), 'owner.extra: unknown key'],
      ['session', (raw: Raw) => (raw['session'].extra = 1), 'session.extra: unknown key'],
      ['limits', (raw: Raw) => (raw['limits'].extra = 1), 'limits.extra: unknown key'],
      ['approval', (raw: Raw) => (raw['approval'].extra = 1), 'approval.extra: unknown key'],
      ['local tracker', (raw: Raw) => (raw['tracker'].extra = 1), 'tracker.extra: unknown key'],
      ['hosted tracker', (raw: Raw) => (hosted(raw), (raw['tracker'].extra = 1)), 'tracker.extra: unknown key'],
      ['recipe', (raw: Raw) => (raw['recipe'].extra = 1), 'recipe.extra: unknown key'],
      ['project', (raw: Raw) => (raw['recipe'].projects[0].extra = 1), 'recipe.projects.0.extra: unknown key'],
      ['gate', (raw: Raw) => (raw['recipe'].projects[0].gate.extra = 1), 'recipe.projects.0.gate.extra: unknown key'],
    ])('rejects an unknown key in %s and names it', (_name, mutate, expected) => {
      expect(check(mutate)).toContain(expected);
    });

    it('rejects an unknown key in a proxy, a worker, a child and the parent', () => {
      expect(
        check((raw) => {
          raw['proxies'] = [{ id: 'p', base_url: 'http://127.0.0.1:1', health: '/h', key: 'x' }];
        }),
      ).toContain('proxies.0.key: unknown key');
      expect(
        check((raw) => {
          raw['workers'] = { l: { proxy: 'none', extra: true } };
        }),
      ).toContain('workers.l.extra: unknown key');
      expect(
        check((raw) => {
          raw['children'] = [{ id: 'c', address: 'file:///a', extra: 1 }];
        }),
      ).toContain('children.0.extra: unknown key');
      expect(
        check((raw) => {
          raw['parent'] = { id: 'c', address: 'file:///a', extra: 1 };
        }),
      ).toContain('parent.extra: unknown key');
    });

    it('rejects a key of schema 1 that moved into the recipe block', () => {
      expect(check((raw) => (raw['projects'] = []))).toContain('projects: unknown key');
      expect(check((raw) => (raw['lanes'] = {}))).toContain('lanes: unknown key');
      expect(check((raw) => (raw['node'].role = 'coordinator'))).toContain('node.role: unknown key');
    });
  });

  describe('invalid values name the key', () => {
    it.each([
      ['schema 1', (raw: Raw) => (raw['schema'] = 1), 'schema:'],
      ['schema 3', (raw: Raw) => (raw['schema'] = 3), 'schema:'],
      ['node.id', (raw: Raw) => (raw['node'].id = 'Bad Id'), 'node.id:'],
      ['node.layer 0', (raw: Raw) => (raw['node'].layer = 0), 'node.layer:'],
      ['node.layer 17', (raw: Raw) => (raw['node'].layer = 17), 'node.layer:'],
      ['node.layer text', (raw: Raw) => (raw['node'].layer = 'coordinator'), 'node.layer:'],
      ['node.layer fraction', (raw: Raw) => (raw['node'].layer = 1.5), 'node.layer:'],
      ['owner.display empty', (raw: Raw) => (raw['owner'].display = ''), 'owner.display:'],
      ['owner.display long', (raw: Raw) => (raw['owner'].display = 'x'.repeat(81)), 'owner.display:'],
      ['owner.github', (raw: Raw) => (raw['owner'].github = '-bad'), 'owner.github:'],
      ['owner.prefix without {owner}', (raw: Raw) => (raw['owner'].prefix = '[From me]'), 'owner.prefix:'],
      ['owner.prefix two lines', (raw: Raw) => (raw['owner'].prefix = '{owner}\nx'), 'owner.prefix:'],
      ['permission_mode', (raw: Raw) => (raw['session'].permission_mode = 'bypassPermissions'), 'session.permission_mode:'],
      ['effort', (raw: Raw) => (raw['session'].effort = 'extreme'), 'session.effort:'],
      ['model', (raw: Raw) => (raw['session'].model = ''), 'session.model:'],
      ['memory pct', (raw: Raw) => (raw['limits'].memory_free_min_pct = 91), 'limits.memory_free_min_pct:'],
      ['disk gb', (raw: Raw) => (raw['limits'].disk_free_min_gb = -1), 'limits.disk_free_min_gb:'],
      ['load_max', (raw: Raw) => (raw['limits'].load_max = 'many'), 'limits.load_max:'],
      ['prepare pct 0', (raw: Raw) => (raw['limits'].context_prepare_pct = 0), 'limits.context_prepare_pct:'],
      ['max pct 101', (raw: Raw) => (raw['limits'].context_max_pct = 101), 'limits.context_max_pct:'],
      ['prepare >= max', (raw: Raw) => (raw['limits'].context_prepare_pct = 40), 'limits.context_prepare_pct:'],
      ['approval.land', (raw: Raw) => (raw['approval'].land = 'never'), 'approval.land:'],
      ['missing key', (raw: Raw) => delete raw['limits'], 'limits:'],
      ['missing tracker', (raw: Raw) => delete raw['tracker'], 'tracker:'],
      ['missing recipe', (raw: Raw) => delete raw['recipe'], 'recipe:'],
      ['child id', (raw: Raw) => (raw['children'] = [{ id: 'Bad', address: 'file:///a' }]), 'children.0.id:'],
      ['child address empty', (raw: Raw) => (raw['children'] = [{ id: 'c', address: '' }]), 'children.0.address:'],
      ['parent id', (raw: Raw) => (raw['parent'] = { id: 'Bad', address: 'file:///a' }), 'parent.id:'],
    ])('rejects %s', (_name, mutate, expected) => {
      expect(check(mutate)).toContain(expected);
    });
  });

  describe('tracker', () => {
    it.each(['items', 'decisions', 'watch_interval'])('refuses %s with the local tracker', (key) => {
      expect(check((raw) => (raw['tracker'][key] = key === 'watch_interval' ? '5m' : 'acme/web'))).toContain(
        `tracker.${key}: unknown key`,
      );
    });

    it.each(['github', 'jira', 'linear'])('accepts the %s tracker with its items and decisions', (kind) => {
      expect(check((raw) => hosted(raw, { kind }))).toBeNull();
    });

    it('needs items and decisions for a hosted tracker', () => {
      expect(check((raw) => (raw['tracker'] = { kind: 'github', decisions: 'acme/decisions' }))).toContain('tracker.items:');
      expect(check((raw) => (raw['tracker'] = { kind: 'jira', items: 'ACME' }))).toContain('tracker.decisions:');
    });

    it.each([
      ['items empty', { items: '' }, 'tracker.items:'],
      ['items long', { items: 'x'.repeat(201) }, 'tracker.items:'],
      ['decisions empty', { decisions: '' }, 'tracker.decisions:'],
      ['decisions long', { decisions: 'x'.repeat(201) }, 'tracker.decisions:'],
    ])('rejects %s', (_name, extra, expected) => {
      expect(check((raw) => hosted(raw, extra))).toContain(expected);
    });

    it('accepts items and decisions of 200 characters', () => {
      expect(check((raw) => hosted(raw, { items: 'x'.repeat(200), decisions: 'y'.repeat(200) }))).toBeNull();
    });

    it('rejects the kind desk: factory has no review desk', () => {
      expect(check((raw) => hosted(raw, { kind: 'desk' }))).toContain('tracker.kind:');
    });

    it('rejects a kind that does not exist and names the key', () => {
      expect(check((raw) => (raw['tracker'] = { kind: 'trello' }))).toContain('tracker.kind:');
      expect(check((raw) => (raw['tracker'] = {}))).toContain('tracker.kind:');
    });

    it('defaults watch_interval to 5m for a hosted tracker', () => {
      const raw = sampleObject();
      hosted(raw);
      const parsed = parsedOf(raw);
      expect(parsed.core.tracker).toEqual({ kind: 'github', items: 'acme/web', decisions: 'acme/decisions', watch_interval: '5m' });
    });

    it.each(['1m', '5m', '90m', '1440m', '1h', '12h', '24h'])('accepts the watch interval %s', (interval) => {
      expect(check((raw) => hosted(raw, { watch_interval: interval }))).toBeNull();
    });

    it.each(['0m', '1441m', '25h', '0h', '5', '5s', 'm', 'h', '-1m', '1.5h', '05m', ' 5m', '5m ', '5 m', 5])(
      'rejects the watch interval %s',
      (interval) => {
        expect(check((raw) => hosted(raw, { watch_interval: interval }))).toContain('tracker.watch_interval:');
      },
    );
  });

  describe('recipe', () => {
    it('names the key of a recipe id that is not in the registry', () => {
      expect(check((raw) => (raw['recipe'].id = 'devflow'))).toContain('recipe.id:');
      expect(check((raw) => delete raw['recipe'].id)).toContain('recipe.id:');
    });

    it('reads only the id in the core, then gives the block to the recipe parser', () => {
      expect(check((raw) => (raw['recipe'].projects[0].path = '/abs/web'))).toContain('recipe.projects.0.path:');
      expect(check((raw) => delete raw['recipe'].variant)).toContain('recipe.variant:');
    });

    it('reports the errors of the core before it reads the recipe', () => {
      const message = check((raw) => {
        raw['session'].effort = 'extreme';
        raw['recipe'].projects[0].path = '/abs/web';
      });
      expect(message).toContain('session.effort:');
      expect(message).not.toContain('recipe.projects');
    });

    it('has one entry in the registry for each recipe id that the core accepts, with a parser and a list of approval points', () => {
      expect(Object.keys(recipes)).toEqual([...values.recipes]);
      for (const entry of Object.values(recipes)) {
        expect(typeof entry.schema.safeParse).toBe('function');
        expect(entry.approvalPoints.length).toBeGreaterThan(0);
      }
    });

    it('accepts an empty list of projects', () => {
      expect(check((raw) => (raw['recipe'].projects = []))).toBeNull();
    });

    it('rejects more than 100 projects', () => {
      const message = check((raw) => {
        raw['recipe'].projects = Array.from({ length: 101 }, (_, index) => ({
          ...raw['recipe'].projects[0],
          id: `p${index}`,
        }));
      });
      expect(message).toContain('recipe.projects:');
    });
  });

  describe('recipe values', () => {
    it.each([
      ['recipe.variant', (raw: Raw) => (raw['recipe'].variant = 'devflow'), 'recipe.variant:'],
      ['project id', (raw: Raw) => (raw['recipe'].projects[0].id = '-x'), 'recipe.projects.0.id:'],
      ['project repo', (raw: Raw) => (raw['recipe'].projects[0].repo = 'no-slash'), 'recipe.projects.0.repo:'],
      ['project path absolute', (raw: Raw) => (raw['recipe'].projects[0].path = '/abs/web'), 'recipe.projects.0.path:'],
      ['project path leaves', (raw: Raw) => (raw['recipe'].projects[0].path = '../../web'), 'recipe.projects.0.path:'],
      ['project path tilde', (raw: Raw) => (raw['recipe'].projects[0].path = '~/web'), 'recipe.projects.0.path:'],
      ['project branch', (raw: Raw) => (raw['recipe'].projects[0].default_branch = '-x'), 'recipe.projects.0.default_branch:'],
      ['merge_method', (raw: Raw) => (raw['recipe'].projects[0].merge_method = 'fast'), 'recipe.projects.0.merge_method:'],
      ['project variant', (raw: Raw) => (raw['recipe'].projects[0].variant = 'devflow'), 'recipe.projects.0.variant:'],
      ['gate.checks', (raw: Raw) => (raw['recipe'].projects[0].gate.checks = [1]), 'recipe.projects.0.gate.checks.0:'],
      ['heavy_test', (raw: Raw) => (raw['recipe'].projects[0].heavy_test = ''), 'recipe.projects.0.heavy_test:'],
    ])('rejects %s', (_name, mutate, expected) => {
      expect(check(mutate)).toContain(expected);
    });

    it('accepts a project path with one .. and rejects two', () => {
      expect(check((raw) => (raw['recipe'].projects[0].path = '../web'))).toBeNull();
      expect(check((raw) => (raw['recipe'].projects[0].path = 'sub/web'))).toBeNull();
      expect(check((raw) => (raw['recipe'].projects[0].path = 'a/../../web'))).toBeNull();
      expect(check((raw) => (raw['recipe'].projects[0].path = 'a/../../../web'))).toContain('recipe.projects.0.path');
    });
  });

  describe('addresses (F-13)', () => {
    const SCHEME_HINT = 'factory runs on one machine: use a file:// address';
    const bad: readonly (readonly [string, string])[] = [
      ['ssh', 'ssh://owner@host/srv/web-factory'],
      ['https', 'https://example.com/web-factory'],
      ['a relative path', 'acme/node'],
      ['a host', 'file://host/srv/web-factory'],
      ['a .. segment', 'file:///srv/../etc'],
      ['a percent sign', 'file:///srv/web%2Ffactory'],
      ['a query', 'file:///srv/web-factory?x=1'],
      ['a fragment', 'file:///srv/web-factory#top'],
    ];

    it.each(bad)('refuses %s in a child and names the key', (_name, address) => {
      const message = check((raw) => {
        raw['children'] = [
          { id: 'one', address: 'file:///srv/one' },
          { id: 'two', address },
        ];
      });
      expect(message).toContain('children.1.address:');
      expect(message).not.toContain('children.0');
    });

    it.each(bad)('refuses %s in the parent and names the key', (_name, address) => {
      expect(check((raw) => (raw['parent'] = { id: 'up', address }))).toContain('parent.address:');
    });

    it('says that factory runs on one machine for any other scheme', () => {
      expect(check((raw) => (raw['children'] = [{ id: 'c', address: 'ssh://host/x' }]))).toContain(SCHEME_HINT);
    });

    it('does not repeat a rejected address', () => {
      const secret = 'sk-ant-api03-SECRETSECRETSECRET';
      expect(check((raw) => (raw['children'] = [{ id: 'c', address: `ssh://${secret}@host/x` }]))).not.toContain('SECRET');
    });
  });

  describe('cross checks', () => {
    it('rejects duplicate ids', () => {
      expect(
        check((raw) => {
          raw['recipe'].projects.push({ ...raw['recipe'].projects[0] });
        }),
      ).toContain('recipe.projects.1.id: duplicate id');
      expect(
        check((raw) => {
          const proxy = { id: 'p', base_url: 'http://127.0.0.1:1', health: '/h' };
          raw['proxies'] = [proxy, proxy];
        }),
      ).toContain('proxies.1.id: duplicate id');
      expect(
        check((raw) => {
          raw['children'] = [
            { id: 'c', address: 'file:///a' },
            { id: 'c', address: 'file:///b' },
          ];
        }),
      ).toContain('children.1.id: duplicate id');
    });

    it('rejects a session proxy that is not defined', () => {
      expect(check((raw) => (raw['session'].proxy = 'ghost'))).toContain('session.proxy: names a proxy');
    });

    it('rejects a worker proxy that is not defined', () => {
      expect(check((raw) => (raw['workers'] = { l: { proxy: 'ghost' } }))).toContain('workers.l.proxy: names a proxy');
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
        raw['approval'].land = secret;
        raw['owner'].github = secret;
      });
      expect(message).not.toBeNull();
      expect(message).not.toContain('SECRET');
    });

    it('does not echo a token in the tracker or in the recipe', () => {
      const secret = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
      expect(check((raw) => (raw['tracker'] = { kind: secret }))).not.toContain('SECRET');
      expect(check((raw) => hosted(raw, { watch_interval: secret }))).not.toContain('SECRET');
      const recipe = check((raw) => {
        raw['recipe'].variant = secret;
        raw['recipe'].projects[0].merge_method = secret;
      });
      expect(recipe).not.toBeNull();
      expect(recipe).not.toContain('SECRET');
      expect(check((raw) => (raw['recipe'].id = secret))).not.toContain('SECRET');
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
