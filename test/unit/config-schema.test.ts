import { describe, expect, it } from 'vitest';
import { durationMinutes, isSlug, slugify } from '../../src/config/primitives.js';
import { CONFIG_SCHEMA_VERSION, localConfigSchema, mergeConfig, splitConfigValue } from '../../src/config/schema.js';
import { describeIssues } from '../../src/core/zod.js';
import { boardLimits, files, reservedFieldNames, values } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { parseProxyUrl } from '../../src/safety/proxy.js';
import { parseConfig, sharedConfigSchema } from '../helpers/package-registry.js';
import { parseMixed, sampleBoard, sampleConfig, sampleFiles, sampleObject } from '../helpers/sample-config.js';

type Raw = Record<string, any>;
type Mutate = (raw: Raw) => void;

/** The id of an approval point of the sample recipe. */
const POINT = Object.keys(sampleConfig().core.approval)[0] ?? '';

const check = (mutate: Mutate) => {
  const raw = sampleObject();
  mutate(raw);
  const parsed = parseMixed(raw);
  return parsed.success ? null : describeIssues(parsed.error);
};

const parsedOf = (raw: Raw) => {
  const parsed = parseMixed(raw);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  return parsed.data;
};

const hosted = (raw: Raw, extra: Raw = {}): void => {
  raw['tracker'] = { kind: 'github', items: 'acme/web', decisions: 'acme/decisions', ...extra };
};

describe('config schema 2', () => {
  it('accepts the sample config and returns the core and the recipe apart', () => {
    const parsed = parseMixed(sampleObject());
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
    for (const key of ['proxies', 'workers', 'children', 'parent', 'approval', 'sources', 'session']) delete raw[key];
    raw['session'] = { permission_mode: 'auto', effort: 'high', model: 'default' };
    const parsed = parseMixed(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.core.proxies).toEqual([]);
    expect(parsed.data.core.workers).toEqual({});
    expect(parsed.data.core.children).toEqual([]);
    expect(parsed.data.core.parent).toBeNull();
    expect(parsed.data.core.sources).toEqual({});
    expect(parsed.data.core.session).toMatchObject({ proxy: 'none', statusline: null });
  });

  it('fills owner for each approval point that the local file does not name, and keeps a named point', () => {
    const raw = sampleObject();
    raw['approval'] = { [POINT]: 'delegated' };
    const modes = parsedOf(raw).core.approval;
    expect(modes[POINT]).toBe('delegated');
    const others = Object.entries(modes).filter(([id]) => id !== POINT);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every(([, mode]) => mode === 'owner')).toBe(true);
    expect(Object.keys(modes).sort()).toEqual(recipes[0].approvalPoints.map((point) => point.id).sort());
  });

  it('refuses an approval point that the recipe does not list, names the key, and puts the issue in the local file', () => {
    const raw = sampleObject();
    raw['approval'] = { 'not-a-point': 'owner' };
    const parsed = parseMixed(raw);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.file).toBe(files.localConfig);
    expect(describeIssues(parsed.error)).toContain('approval.not-a-point');
    expect(describeIssues(parsed.error)).toContain(POINT);
  });

  it('refuses a mode that is not owner or delegated', () => {
    expect(check((raw) => (raw['approval'][POINT] = 'never'))).toContain(`approval.${POINT}:`);
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
      raw['approval'] = { [POINT]: 'delegated' };
      raw['sources'] = { web: '/srv/code/web' };
      raw['session'].statusline = 'my-status --short';
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
      ['agent', (raw: Raw) => (raw['session'].agent = 'codex'), 'session.agent:'],
      ['idle_after 0m', (raw: Raw) => (raw['limits'].idle_after = '0m'), 'limits.idle_after:'],
      ['idle_after 25h', (raw: Raw) => (raw['limits'].idle_after = '25h'), 'limits.idle_after:'],
      ['memory pct', (raw: Raw) => (raw['limits'].memory_free_min_pct = 91), 'limits.memory_free_min_pct:'],
      ['disk gb', (raw: Raw) => (raw['limits'].disk_free_min_gb = -1), 'limits.disk_free_min_gb:'],
      ['load_max', (raw: Raw) => (raw['limits'].load_max = 'many'), 'limits.load_max:'],
      ['prepare pct 0', (raw: Raw) => (raw['limits'].context_prepare_pct = 0), 'limits.context_prepare_pct:'],
      ['max pct 101', (raw: Raw) => (raw['limits'].context_max_pct = 101), 'limits.context_max_pct:'],
      ['prepare >= max', (raw: Raw) => (raw['limits'].context_prepare_pct = 40), 'limits.context_prepare_pct:'],
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

  describe('session.agent (AC-1, TP-2)', () => {
    it('accepts claude, and defaults to claude when the key is missing', () => {
      expect(parsedOf(sampleObject()).core.session.agent).toBe('claude');
      const raw = sampleObject();
      delete raw['session'].agent;
      expect(parsedOf(raw).core.session.agent).toBe('claude');
    });

    it.each(['codex', 'Claude', '', 'claude ', 'claude-code', 1, true, null, ['claude']])(
      'refuses the agent %j, and names the key as a bad value, not as an unknown key',
      (agent) => {
        const message = check((raw) => (raw['session'].agent = agent));
        expect(message).toContain('session.agent:');
        expect(message).not.toContain('unknown key');
      },
    );
  });

  describe('limits.idle_after (AC-2, TP-4)', () => {
    it('defaults to 2h when the key is missing', () => {
      const raw = sampleObject();
      delete raw['limits'].idle_after;
      expect(parsedOf(raw).core.limits.idle_after).toBe('2h');
    });

    it.each(['1m', '90m', '1440m', '1h', '2h', '24h'])('accepts %s', (idle) => {
      expect(check((raw) => (raw['limits'].idle_after = idle))).toBeNull();
      const raw = sampleObject();
      raw['limits'].idle_after = idle;
      expect(parsedOf(raw).core.limits.idle_after).toBe(idle);
    });

    it.each(['0m', '0h', '1441m', '25h', '100h', '2d', '2', 'h', '1.5h', '-1m', ' 2h', '2h ', '01h', 2, 0, true, null, ['2h']])(
      'refuses %j, and names the key as a bad value, not as an unknown key',
      (idle) => {
        const message = check((raw) => (raw['limits'].idle_after = idle));
        expect(message).toContain('limits.idle_after:');
        expect(message).not.toContain('unknown key');
      },
    );
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
      expect(recipes.map((entry) => entry.id)).toEqual([...values.recipes]);
      for (const entry of recipes) {
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

  });

  describe('project path (AC-12, TP-28)', () => {
    const withPath = (path: unknown): Mutate => (raw) => {
      raw['recipe'].projects[0].path = path;
    };

    it.each(['web', 'web-app', 'web_app', 'web.app', 'Web2', 'a', 'node'])('accepts the folder name %s', (path) => {
      expect(check(withPath(path))).toBeNull();
    });

    it.each([
      ['a relative path with a slash', 'sub/web'],
      ['a path above the root', '../web'],
      ['a path above the root, twice', '../../web'],
      ['a path with a .. inside', 'a/../web'],
      ['an absolute path', '/abs/web'],
      ['a tilde path', '~/web'],
      ['a name with a trailing slash', 'web/'],
      ['a name with a leading ./', './web'],
      ['a Windows path', 'sub\\web'],
      ['a Windows path above the root', '..\\web'],
      ['the empty name', ''],
      ['a name with a control character', 'we\u001bb'],
      ['a name with a line break', 'we\nb'],
    ])('refuses %s as a path that is not one folder name', (_name, path) => {
      const message = check(withPath(path));
      expect(message).toContain('recipe.projects.0.path:');
      if (path !== '') expect(message).toMatch(/one folder name|must not start with a dot|at least 1/);
    });

    it.each(['.', '..', '.git', '.factory', '.gitignore', '.claude', '.factory.tmp-4242', '.web'])(
      'refuses the name %s, which starts with a dot',
      (path) => {
        expect(check(withPath(path))).toContain('recipe.projects.0.path: must not start with a dot');
      },
    );

    it.each([
      'coordinator',
      'work-copies',
      'setup',
      'factory.yaml',
      'factory.local.yaml',
      'CLAUDE.md',
      'CLAUDE.local.md',
      'AGENTS.md',
    ])('refuses the reserved name %s', (path) => {
      expect(check(withPath(path))).toContain('recipe.projects.0.path: is a name that the factory folder keeps for itself');
    });

    it.each(['Coordinator', 'COORDINATOR', 'Work-Copies', 'SETUP', 'Factory.YAML', 'claude.md', 'Agents.MD', 'CLAUDE.LOCAL.MD'])(
      'refuses the reserved name %s in another letter case',
      (path) => {
        expect(check(withPath(path))).toContain('keeps for itself');
      },
    );

    it('refuses a reserved name that only a compatible form of a letter separates from the reserved name', () => {
      // A long s (U+017F) folds to s, so this name is "setup" on a file system that folds compatible forms.
      expect(check(withPath('ſetup'))).toContain('keeps for itself');
      // A full-width letter folds to the plain letter.
      expect(check(withPath('ｃoordinator'))).toContain('keeps for itself');
    });

    it('accepts names that only look like a reserved name', () => {
      for (const path of ['coordinator2', 'my-setup', 'setup.d', 'work-copies-old', 'CLAUDE', 'AGENTS', 'factory']) {
        expect(check(withPath(path))).toBeNull();
      }
    });

    it('refuses a path that is not a string', () => {
      expect(check(withPath(7))).toContain('recipe.projects.0.path:');
      expect(check(withPath(null))).toContain('recipe.projects.0.path:');
    });

    it('refuses a name longer than a folder name can be', () => {
      expect(check(withPath('a'.repeat(255)))).toBeNull();
      expect(check(withPath('a'.repeat(256)))).toContain('recipe.projects.0.path:');
    });

  });

  describe('clone URLs (AC-11)', () => {
    const SECRET = 'ghp_S3cretT0kenValue';
    const withUrl = (url: unknown): Mutate => (raw) => {
      raw['recipe'].projects[0].url = url;
    };
    /** The sample project, and a second project with its own id, path and URL. */
    const twoProjects = (first: string, second: string, paths: [string, string] = ['web', 'api']): Mutate => (raw) => {
      const [web] = raw['recipe'].projects;
      raw['recipe'].projects = [
        { ...web, url: first, path: paths[0] },
        { ...web, id: 'api', url: second, path: paths[1] },
      ];
    };

    it('takes the url as an optional key, and keeps it in the parsed project', () => {
      expect(check((raw) => delete raw['recipe'].projects[0].url)).toBeNull();
      const parsed = parsedOf((() => {
        const raw = sampleObject();
        raw['recipe'].projects[0].url = 'git@host:acme/web.git';
        return raw;
      })());
      expect(parsed.recipe.projects[0]?.url).toBe('git@host:acme/web.git');
    });

    it.each([
      'https://github.com/acme/web.git',
      'https://host:8443/acme/web',
      'git@github.com:acme/web.git',
      'ssh://git@github.com/acme/web.git',
      'ssh://github.com/acme/web',
      'file:///srv/acme/web.git',
      '/srv/acme/web',
    ])('accepts the url %s', (url) => {
      expect(check(withUrl(url))).toBeNull();
    });

    it.each([
      ['an https URL with a user name', `https://${SECRET}@github.com/acme/web.git`],
      ['an https URL with a user and a password', `https://user:${SECRET}@github.com/acme/web.git`],
      ['an ssh URL with a password', `ssh://git:${SECRET}@github.com/acme/web.git`],
      ['the scp form with a password', `git:${SECRET}@github.com:acme/web.git`],
      ['a scheme that is not https, ssh or file', `http://github.com/acme/${SECRET}`],
      ['a git transport helper', `ext::sh -c ${SECRET}`],
      ['a leading hyphen', `-oProxyCommand=${SECRET}`],
      ['a relative path', `../${SECRET}`],
      ['a value that is not a string', 5],
      ['a value over the length bound', `https://host/${'a'.repeat(2100)}`],
    ])('refuses %s, names the key and does not repeat the value', (_name, url) => {
      const message = check(withUrl(url));
      expect(message).toContain('recipe.projects.0.url:');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('aaaaaaaaaa');
    });

    it('tells the person how to fix a URL with credentials or a scheme that is not allowed', () => {
      expect(check(withUrl(`https://${SECRET}@github.com/acme/web.git`))).toContain('https URL with no user name, or an ssh URL');
      expect(check(withUrl('http://github.com/acme/web.git'))).toContain('https URL with no user name, or an ssh URL');
    });

    it('accepts two projects with two repos', () => {
      expect(check(twoProjects('git@host:acme/web.git', 'git@host:acme/api.git'))).toBeNull();
      expect(check(twoProjects('https://host/acme/web.git', 'https://host:8443/acme/web.git'))).toBeNull();
    });

    it.each([
      ['the scp form and the https form of one repo', 'git@github.com:acme/web.git', 'https://github.com/acme/web'],
      ['a different case of the host', 'https://GitHub.com/acme/web.git', 'https://github.com/acme/web/'],
      ['ssh with a user and ssh with none', 'ssh://git@github.com/acme/web', 'ssh://github.com/acme/web.git'],
    ])('refuses two entries with one clone URL in normal form: %s', (_name, first, second) => {
      const message = check(twoProjects(first, second));
      expect(message).toContain('recipe.projects.1.url:');
      expect(message).toContain('web');
      expect(message).not.toContain('github.com');
    });

    it('refuses two entries with one path, also when the letter case differs', () => {
      expect(check(twoProjects('git@host:acme/web.git', 'git@host:acme/api.git', ['web', 'web']))).toContain(
        'recipe.projects.1.path: names the same folder as the project web',
      );
      expect(check(twoProjects('git@host:acme/web.git', 'git@host:acme/api.git', ['web', 'WEB']))).toContain(
        'recipe.projects.1.path: names the same folder as the project web',
      );
    });

    it('lets two entries with no url stand, because a project with no url is no refusal', () => {
      const raw = sampleObject();
      const { url: _url, ...web } = raw['recipe'].projects[0];
      raw['recipe'].projects = [web, { ...web, id: 'api', path: 'api' }];
      expect(parseMixed(raw).success).toBe(true);
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
        raw['approval'][POINT] = secret;
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

describe('the board block (AC-12)', () => {
  /** The mixed sample document with the sample board block, changed by `mutate`. */
  const checkBoard = (mutate: Mutate): string | null =>
    check((raw) => {
      raw['board'] = sampleBoard();
      mutate(raw['board']);
    });

  const tokens = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

  /** Text that is not a token: empty, a space, a hyphen or underscore first, a line break, a non-ASCII letter, or 33 characters. */
  const BAD_TOKENS = ['', 'a b', ' a', '-a', '_a', 'a\nb', 'café', 'x'.repeat(33)];

  it('M5-1b TP-27 accepts the block with its states, roles and fields, and keeps it in the core', () => {
    const parsed = parseMixed({ ...sampleObject(), board: sampleBoard() });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.core.board).toEqual(sampleBoard());
  });

  it('M5-1b TP-27 has no default: a config with no board block has no board key', () => {
    const parsed = parseMixed(sampleObject());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect('board' in parsed.data.core).toBe(false);
  });

  it('M5-1b TP-27 accepts the block with every tracker kind', () => {
    expect(check((raw) => (raw['board'] = sampleBoard()))).toBeNull();
    expect(
      check((raw) => {
        hosted(raw);
        raw['board'] = sampleBoard();
      }),
    ).toBeNull();
  });

  it('M5-1b TP-27 reads an empty block as a block that declares nothing', () => {
    const parsed = parseMixed({ ...sampleObject(), board: {} });
    expect(parsed.success && parsed.data.core.board).toEqual({});
  });

  it('M5-1b TP-27 refuses a block that is not a mapping', () => {
    for (const value of [[], 'open', 3, null]) {
      expect(check((raw) => (raw['board'] = value))).toContain('board:');
    }
  });

  it('M5-1b TP-27 refuses a name, a state and a value that is not a token, and names the key', () => {
    for (const bad of BAD_TOKENS) {
      expect(checkBoard((board) => (board.fields[0].name = bad))).toContain('board.fields.0.name:');
      expect(checkBoard((board) => (board.states[0] = bad))).toContain('board.states.0:');
      expect(checkBoard((board) => (board.fields[0].values[0] = bad))).toContain('board.fields.0.values.0:');
    }
  });

  it('M5-1b TP-27 accepts a token of 32 characters and refuses one of 33', () => {
    const edge = 'a'.repeat(32);
    expect(checkBoard((board) => (board.fields[1].name = edge))).toBeNull();
    expect(checkBoard((board) => (board.fields[1].name = `${edge}a`))).toContain('board.fields.1.name:');
  });

  it('M5-1b TP-27 refuses a role and a worker field that are not tokens', () => {
    for (const bad of BAD_TOKENS) {
      expect(checkBoard((board) => (board.in_progress = bad))).toContain('board.in_progress:');
      expect(checkBoard((board) => (board.closed = bad))).toContain('board.closed:');
      expect(checkBoard((board) => (board.worker_field = bad))).toContain('board.worker_field:');
    }
  });

  it('M5-1b TP-27 never repeats a rejected value in the message', () => {
    const secret = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
    const message = checkBoard((board) => {
      board.fields[0].name = secret;
      board.states[0] = secret;
      board.fields[0].values[0] = secret;
    });
    expect(message).not.toBeNull();
    expect(message).not.toContain('SECRET');
  });

  it('M5-1b TP-27 refuses too many states, too many fields and too many values of one field', () => {
    expect(checkBoard((board) => (board.states = tokens(boardLimits.maxStates + 1, 's')))).toContain('board.states:');
    expect(
      checkBoard((board) => {
        board.fields = tokens(boardLimits.maxFields + 1, 'f').map((name) => ({ name, target: 'item', kind: 'flag' }));
        delete board.worker_field;
      }),
    ).toContain('board.fields:');
    expect(checkBoard((board) => (board.fields[0].values = tokens(boardLimits.maxValues + 1, 'v')))).toContain(
      'board.fields.0.values:',
    );
  });

  it('M5-1b TP-27 accepts the most states, the most fields and the most values', () => {
    expect(
      checkBoard((board) => {
        board.states = tokens(boardLimits.maxStates, 's');
        board.in_progress = 's0';
        board.closed = 's1';
        board.fields[0].values = tokens(boardLimits.maxValues, 'v');
      }),
    ).toBeNull();
    expect(
      checkBoard((board) => {
        board.fields = tokens(boardLimits.maxFields, 'f').map((name) => ({ name, target: 'item', kind: 'flag' }));
        delete board.worker_field;
      }),
    ).toBeNull();
  });

  it('M5-1b TP-27 refuses an empty list of values and an empty list of states', () => {
    expect(checkBoard((board) => (board.fields[0].values = []))).toContain('board.fields.0.values:');
    expect(
      checkBoard((board) => {
        board.states = [];
        delete board.in_progress;
        delete board.closed;
      }),
    ).toContain('board.states:');
  });

  it('M5-1b TP-27 refuses tracks, track and stage as the name of a field', () => {
    for (const name of ['tracks', 'track', 'stage']) {
      expect(reservedFieldNames).toContain(name);
      expect(checkBoard((board) => (board.fields[1].name = name))).toContain('board.fields.1.name:');
    }
  });

  it('M5-1b TP-27 refuses every reserved name as the name of a field, and accepts a name next to it', () => {
    for (const name of reservedFieldNames) {
      expect(checkBoard((board) => (board.fields[1].name = name))).toContain('board.fields.1.name:');
    }
    expect(checkBoard((board) => (board.fields[1].name = 'stages'))).toBeNull();
  });

  it('M5-1b TP-27 refuses a role with no declared state', () => {
    expect(checkBoard((board) => (board.in_progress = 'nowhere'))).toContain('board.in_progress:');
    expect(checkBoard((board) => (board.closed = 'nowhere'))).toContain('board.closed:');
    expect(
      checkBoard((board) => {
        delete board.states;
      }),
    ).toContain('board.in_progress:');
  });

  it('M5-1b TP-27 refuses a worker field that is not a declared field, or that is not a field of an item', () => {
    expect(checkBoard((board) => (board.worker_field = 'nowhere'))).toContain('board.worker_field:');
    expect(checkBoard((board) => (board.worker_field = 'release'))).toContain('board.worker_field:');
    expect(
      checkBoard((board) => {
        delete board.fields;
      }),
    ).toContain('board.worker_field:');
  });

  it('M5-1b TP-27 refuses a repeated field name, a repeated state and a repeated value', () => {
    expect(checkBoard((board) => (board.fields[1].name = 'priority'))).toContain('board.fields.1.name:');
    expect(checkBoard((board) => (board.states[1] = 'open'))).toContain('board.states:');
    expect(checkBoard((board) => (board.fields[0].values[1] = 'P0'))).toContain('board.fields.0.values:');
  });

  it('M5-1b TP-27 refuses an unknown key in the block and in a field', () => {
    expect(checkBoard((board) => (board.extra = 1))).toContain('board.extra: unknown key');
    expect(checkBoard((board) => (board.fields[0].extra = 1))).toContain('board.fields.0.extra: unknown key');
  });

  it('M5-1b TP-27 refuses a field with a bad target or kind, a values field with no list, and a list on another kind', () => {
    expect(checkBoard((board) => (board.fields[0].target = 'track'))).toContain('board.fields.0.target:');
    expect(checkBoard((board) => (board.fields[0].kind = 'text'))).toContain('board.fields.0.kind:');
    expect(checkBoard((board) => delete board.fields[0].values)).toContain('board.fields.0.values:');
    expect(checkBoard((board) => (board.fields[2].values = ['a']))).toContain('board.fields.2.values: unknown key');
    expect(checkBoard((board) => (board.fields[3].values = ['a']))).toContain('board.fields.3.values: unknown key');
  });

  it('M5-1b TP-27 reads required as false when it is absent, and refuses a value that is not a boolean', () => {
    const parsed = parseMixed({
      ...sampleObject(),
      board: { fields: [{ name: 'lane', target: 'item', kind: 'token' }] },
    });
    expect(parsed.success && parsed.data.core.board?.fields?.[0]?.required).toBe(false);
    expect(checkBoard((board) => (board.fields[0].required = 'yes'))).toContain('board.fields.0.required:');
  });

  it('M5-1b TP-27 keeps the schema version at 2: a board block loads with version 2 and not with another version', () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(2);
    expect(check((raw) => (raw['board'] = sampleBoard()))).toBeNull();
    expect(check((raw) => ((raw['board'] = sampleBoard()), (raw['schema'] = 3)))).toContain('schema:');
  });

  it('M5-1b TP-27 keeps the block in the shared file and refuses it in the local file', () => {
    const files = sampleFiles({ ...sampleObject(), board: sampleBoard() });
    expect(Object.keys(files.shared)).toContain('board');
    expect(Object.keys(files.local)).not.toContain('board');
    const local = localConfigSchema.safeParse({ ...sampleFiles().local, board: sampleBoard() });
    expect(local.success).toBe(false);
    expect(!local.success && describeIssues(local.error)).toContain('board: unknown key');
  });
});

describe('the shared file and the local file (design 4.4)', () => {
  const sharedOf = (change: Mutate = () => undefined) => {
    const raw = sampleFiles().shared;
    change(raw);
    return sharedConfigSchema.safeParse(raw);
  };
  const localOf = (change: Mutate = () => undefined) => {
    const raw = sampleFiles().local;
    change(raw);
    return localConfigSchema.safeParse(raw);
  };
  const messageOf = (parsed: { success: boolean; error?: Parameters<typeof describeIssues>[0] }): string =>
    parsed.success || parsed.error === undefined ? '' : describeIssues(parsed.error);

  it('accepts the shared part of the sample and the local part of the sample', () => {
    expect(sharedOf().success).toBe(true);
    expect(localOf().success).toBe(true);
  });

  it('keeps the tracker, the project list, the session way of working and the limits in the shared file', () => {
    const raw = sampleFiles().shared;
    expect(Object.keys(raw).sort()).toEqual(['limits', 'node', 'recipe', 'schema', 'session', 'tracker']);
    expect(Object.keys(raw['session']).sort()).toEqual(['agent', 'effort', 'model', 'permission_mode']);
    expect(Object.keys(raw['limits'])).toContain('idle_after');
    expect(
      sharedOf((shared) => {
        shared['tracker'] = { kind: 'github', items: 'acme/web', decisions: 'acme/decisions' };
        shared['session'] = { permission_mode: 'auto', effort: 'max', model: 'opus' };
      }).success,
    ).toBe(true);
  });

  it('loads a shared file with no agent key and no idle_after key, as every node of an older version has', () => {
    const parsed = sharedOf((shared) => {
      delete shared['session'].agent;
      delete shared['limits'].idle_after;
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.core.session.agent).toBe('claude');
    expect(parsed.data.core.limits.idle_after).toBe('2h');
  });

  it('keeps session.agent in the shared file: the local file refuses it, and the shared file does not call it local', () => {
    expect(sharedOf((raw) => (raw['session'].agent = 'claude')).success).toBe(true);
    expect(messageOf(sharedOf((raw) => (raw['session'].agent = 'claude')))).not.toContain('is a local key');
    expect(messageOf(localOf((raw) => (raw['session'].agent = 'claude')))).toContain('session.agent: unknown key');
    expect(messageOf(localOf((raw) => (raw['limits'] = { idle_after: '2h' })))).toContain('limits: unknown key');
  });

  it.each([
    ['owner', 'owner', (raw: Raw) => (raw['owner'] = { display: 'x', prefix: '{owner}' })],
    ['session.proxy', 'session.proxy', (raw: Raw) => (raw['session'].proxy = 'none')],
    ['session.statusline', 'session.statusline', (raw: Raw) => (raw['session'].statusline = null)],
    ['state.remote', 'state.remote', (raw: Raw) => (raw['state'] = { remote: null })],
    ['proxies', 'proxies', (raw: Raw) => (raw['proxies'] = [])],
    ['workers', 'workers', (raw: Raw) => (raw['workers'] = {})],
    ['approval', 'approval', (raw: Raw) => (raw['approval'] = {})],
    ['parent', 'parent', (raw: Raw) => (raw['parent'] = null)],
    ['children', 'children', (raw: Raw) => (raw['children'] = [])],
    ['sources', 'sources', (raw: Raw) => (raw['sources'] = {})],
  ])('refuses %s in the shared file, and names the key and the local file', (_name, path, change) => {
    const message = messageOf(sharedOf(change));
    expect(message).toContain(`${path}: is a local key`);
    expect(message).toContain(files.localConfig);
    expect(message).toContain(files.config);
  });

  it('names every local key that it finds, not only the first', () => {
    const message = messageOf(
      sharedOf((raw) => {
        raw['proxies'] = [];
        raw['owner'] = {};
      }),
    );
    expect(message).toContain('proxies: is a local key');
    expect(message).toContain('owner: is a local key');
  });

  it('refuses a pulled proxy entry in the shared file before it reads the entry', () => {
    const message = messageOf(
      sharedOf((raw) => {
        raw['proxies'] = [{ id: 'pulled', base_url: 'http://203.0.113.9:8080', health: '/health' }];
      }),
    );
    expect(message).toContain('proxies: is a local key');
    expect(message).not.toContain('203.0.113.9');
  });

  it('refuses a permission mode that is not auto, and accepts the model, the effort and the limits', () => {
    expect(messageOf(sharedOf((raw) => (raw['session'].permission_mode = 'default')))).toContain('session.permission_mode:');
    expect(messageOf(sharedOf((raw) => (raw['session'].effort = 'wild')))).toContain('session.effort:');
    expect(sharedOf((raw) => (raw['limits'].load_max = 4)).success).toBe(true);
  });

  it('takes only the proxy and the status line in the session block of the local file', () => {
    expect(localOf((raw) => (raw['session'] = { proxy: 'none', statusline: 'my-status' })).success).toBe(true);
    for (const key of ['model', 'effort', 'permission_mode']) {
      expect(messageOf(localOf((raw) => (raw['session'][key] = 'auto')))).toContain(`session.${key}: unknown key`);
    }
  });

  it('refuses a shared key in the local file', () => {
    for (const key of ['node', 'tracker', 'limits', 'recipe']) {
      expect(messageOf(localOf((raw) => (raw[key] = sampleFiles().shared[key])))).toContain(`${key}: unknown key`);
    }
  });

  it('gives each file its own schema key and version', () => {
    expect(messageOf(sharedOf((raw) => (raw['schema'] = 1)))).toContain('schema:');
    expect(messageOf(localOf((raw) => (raw['schema'] = 2)))).toContain('schema:');
    expect(sampleFiles().local['schema']).toBe(1);
    expect(sampleFiles().shared['schema']).toBe(2);
  });

  it('refuses a status line over one line, and a source with a line break', () => {
    expect(messageOf(localOf((raw) => (raw['session'].statusline = 'a\nb')))).toContain('session.statusline:');
    expect(messageOf(localOf((raw) => (raw['sources'] = { api: '/a\n/b' })))).toContain('sources.api:');
  });

  it('refuses the keys of the older layout with the remake message, and names init', () => {
    const cells = messageOf(sharedOf((raw) => (raw['cells'] = {})));
    expect(cells).toContain('cells: is from an older layout');
    expect(cells).toContain('factory init');
    const land = messageOf(sharedOf((raw) => (raw['approval'] = { land: 'each' })));
    expect(land).toContain('approval.land: is from an older layout');
    expect(land).not.toContain('is a local key');
  });

  it('merges the two files into the config that the commands use', () => {
    const { shared, local } = splitConfigValue(sampleObject());
    const parsed = parseConfig(shared, local);
    expect(parsed.success && parsed.data).toEqual(sampleConfig());
  });

  it('names the file that holds the first problem', () => {
    const { shared, local } = sampleFiles();
    const badShared = parseConfig({ ...shared, tracker: { kind: 'nope' } }, local);
    expect(!badShared.success && badShared.file).toBe(files.config);
    const badLocal = parseConfig(shared, { ...local, parent: { id: 'Bad', address: 'file:///a' } });
    expect(!badLocal.success && badLocal.file).toBe(files.localConfig);
  });

  it('merges nothing when the local file names a point that the recipe does not list', () => {
    const shared = sharedConfigSchema.safeParse(sampleFiles().shared);
    const local = localConfigSchema.safeParse({ ...sampleFiles().local, approval: { nope: 'owner' } });
    if (!shared.success || !local.success) throw new Error('the sample must parse');
    expect(mergeConfig(shared.data, local.data).success).toBe(false);
  });

  describe('sources: the local source of a project with no URL (AC-11)', () => {
    const TOKEN = 'ghp_S3cretT0kenValue';
    /** The sample project sits at `web`, so a key of `sources` can name it. */
    const parsedWith = (sources: unknown, change: Mutate = () => undefined) => {
      const raw = sampleObject();
      raw['recipe'].projects[0].path = 'web';
      change(raw);
      raw['sources'] = sources;
      return parseMixed(raw);
    };
    const messageWith = (sources: unknown, change?: Mutate): string => {
      const parsed = parsedWith(sources, change);
      return parsed.success ? '' : describeIssues(parsed.error);
    };

    it.each([
      ['an absolute path', '/srv/code/web'],
      ['a path with a space', '/srv/my code/web'],
      ['a file URL', 'file:///srv/code/web.git'],
    ])('accepts %s for a listed project', (_name, source) => {
      const parsed = parsedWith({ web: source });
      expect(parsed.success && parsed.data.core.sources).toEqual({ web: source });
    });

    it('accepts a key that writes the project path another way', () => {
      expect(parsedWith({ './web/': '/srv/code/web' }).success).toBe(true);
    });

    it.each([
      ['a leading hyphen', '-oProxyCommand=x'],
      ['user information in an https URL', `https://user:${TOKEN}@host/acme/web`],
      ['a user name in an https URL', `https://${TOKEN}@host/acme/web`],
      ['a password in an ssh URL', `ssh://git:${TOKEN}@host/acme/web`],
      ['a relative path', 'code/web'],
      ['a path that starts with a tilde', '~/code/web'],
      ['a .. segment', '/srv/code/../web'],
      ['a URL of a host', 'https://host/acme/web'],
      ['the scp form', 'git@host:acme/web'],
      ['a scheme that is not allowed', 'http://host/acme/web'],
      ['a value over the length bound', `/${'a'.repeat(4100)}`],
    ])('refuses %s, names the key and does not repeat the value', (_name, source) => {
      const message = messageWith({ web: source });
      expect(message).toContain('sources.web:');
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('aaaaaaaaaa');
    });

    it('puts the problem of a value in the local file', () => {
      const raw = sampleObject();
      raw['recipe'].projects[0].path = 'web';
      raw['sources'] = { web: 'code/web' };
      const parsed = parseMixed(raw);
      expect(!parsed.success && parsed.file).toBe(files.localConfig);
    });

    it('refuses a key that names no listed project, and names the key and the local file', () => {
      const raw = sampleObject();
      raw['recipe'].projects[0].path = 'web';
      raw['sources'] = { api: '/srv/code/api' };
      const parsed = parseMixed(raw);
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.file).toBe(files.localConfig);
      expect(describeIssues(parsed.error)).toContain('sources.api:');
    });

    it('refuses a map with more entries than the project list has', () => {
      const message = messageWith({ web: '/srv/code/web', './web': '/srv/other/web' });
      expect(message).toContain('sources:');
      expect(message).toContain('more entries than');
    });

    it('refuses a source when the project list is empty', () => {
      expect(messageWith({ web: '/srv/code/web' }, (raw) => (raw['recipe'].projects = []))).toContain('sources.web:');
    });

    it('bounds the map by itself when it holds more than 200 entries', () => {
      const sources = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`p${index}`, `/srv/p${index}`]));
      expect(messageOf(localOf((raw) => (raw['sources'] = sources)))).toContain('sources:');
    });

    it('accepts one source for each of 100 projects', () => {
      const projects = Array.from({ length: 100 }, (_, index) => ({
        ...sampleObject()['recipe'].projects[0],
        id: `p${index}`,
        url: `https://github.com/acme/p${index}`,
        path: `p${index}`,
      }));
      const sources = Object.fromEntries(projects.map((project) => [project.path, `/srv/${project.id}`]));
      expect(messageWith(sources, (raw) => (raw['recipe'].projects = projects))).toBe('');
    });
  });
});

describe('the minutes of a duration', () => {
  it.each([
    ['1m', 1],
    ['90m', 90],
    ['1h', 60],
    ['2h', 120],
    ['24h', 1440],
  ])('reads %s as %d minutes', (text, minutes) => {
    expect(durationMinutes(text, 1, 1440)).toBe(minutes);
  });

  it('refuses a value outside the bounds, and the bounds themselves are in', () => {
    expect(durationMinutes('0m', 1, 120)).toBeNull();
    expect(durationMinutes('1m', 1, 120)).toBe(1);
    expect(durationMinutes('120m', 1, 120)).toBe(120);
    expect(durationMinutes('121m', 1, 120)).toBeNull();
    expect(durationMinutes('3h', 1, 120)).toBeNull();
  });

  it.each(['', '5', '5s', 'm', 'h', '-1m', '1.5h', '05m', ' 5m', '5m ', '5 m', '1e1m', '1234567m', '+5m'])('refuses the text %j', (text) => {
    expect(durationMinutes(text, 0, 1_000_000)).toBeNull();
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
