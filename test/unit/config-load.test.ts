import { describe, expect, it } from 'vitest';
import { inspectConfig, loadConfig, parseConfigText, parseYamlText } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import { configSchema, type FactoryConfig } from '../../src/config/schema.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/node';

/** The sample config with some core keys replaced. */
const withCore = (core: Partial<FactoryConfig['core']>): FactoryConfig => {
  const sample = sampleConfig();
  return { ...sample, core: { ...sample.core, ...core } };
};

const withFile = (text: string | null) => {
  const deps = createFakeDeps();
  deps.seedDir(HOME);
  if (text !== null) deps.seed(`${HOME}/factory.yaml`, text);
  return deps;
};

describe('parseConfigText', () => {
  it('gives the typed config for a valid text', () => {
    const parsed = parseConfigText(renderConfig(sampleConfig()));
    expect(parsed.ok && parsed.value.core.node.id).toBe('demo');
  });

  it('fails, and names the key, for a text that is not valid', () => {
    const parsed = parseConfigText(renderConfig(sampleConfig()).replace('effort: high', 'effort: wild'));
    expect(parsed).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!parsed.ok) expect(parsed.error.message).toContain('session.effort');
  });

  it('fails for a text that does not parse, and for an older schema', () => {
    const broken = parseConfigText('a: [1\n');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toContain('factory.yaml does not parse');
    const older = parseConfigText('schema: 1\n');
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error.message).toContain('factory upgrade');
  });
});

describe('parseYamlText', () => {
  it('parses a mapping', () => {
    expect(parseYamlText('a: 1\nb: [x, y]\n')).toEqual({ ok: true, value: { a: 1, b: ['x', 'y'] } });
  });

  it('returns the line of a syntax error', () => {
    const parsed = parseYamlText('a: [1, 2\nb: 3\n');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^line \d+:/);
  });

  it('rejects duplicate keys', () => {
    expect(parseYamlText('a: 1\na: 2\n').ok).toBe(false);
  });

  it('rejects aliases', () => {
    expect(parseYamlText('a: &x 1\nb: *x\n')).toEqual({ ok: false, error: 'aliases are not allowed' });
  });

  it('reports only the line and the error code, never the source text', () => {
    const parsed = parseYamlText(`a: |${FAKE_GITHUB_TOKEN}\n  body\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/^line 1: [A-Z_]+$/);
      expect(parsed.error).not.toContain(FAKE_GITHUB_TOKEN);
    }
  });

  it('does not repeat a duplicate key in the error', () => {
    const parsed = parseYamlText(`${FAKE_GITHUB_TOKEN}: 1\n${FAKE_GITHUB_TOKEN}: 2\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toContain(FAKE_GITHUB_TOKEN);
  });
});

describe('inspectConfig and loadConfig', () => {
  it('loads a valid file', async () => {
    const deps = withFile(renderConfig(sampleConfig()));
    const state = await inspectConfig(deps, HOME);
    expect(state.kind).toBe('valid');
    const loaded = await loadConfig(deps, HOME);
    expect(loaded.ok && loaded.value.core.node.id).toBe('demo');
  });

  it('reports a missing file', async () => {
    const deps = withFile(null);
    expect(await inspectConfig(deps, HOME)).toEqual({ kind: 'missing' });
    const loaded = await loadConfig(deps, HOME);
    expect(loaded).toMatchObject({ ok: false, error: { message: 'factory.yaml not found' } });
  });

  it('reports a folder named factory.yaml as missing', async () => {
    const deps = withFile(null);
    deps.seedDir(`${HOME}/factory.yaml`);
    expect(await inspectConfig(deps, HOME)).toEqual({ kind: 'missing' });
  });

  it('reports text that does not parse', async () => {
    const state = await inspectConfig(withFile('a: [1\n'), HOME);
    expect(state.kind).toBe('unparsable');
  });

  it('reports a newer schema with the upgrade-factory message', async () => {
    const state = await inspectConfig(withFile('schema: 3\n'), HOME);
    expect(state).toMatchObject({ kind: 'newer', version: 3 });
    const loaded = await loadConfig(withFile('schema: 3\n'), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('Upgrade factory.');
  });

  it('reports a schema 1 file as older and points to the upgrade command', async () => {
    const state = await inspectConfig(withFile('schema: 1\n'), HOME);
    expect(state).toMatchObject({ kind: 'older', version: 1 });
    const loaded = await loadConfig(withFile('schema: 1\n'), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('factory upgrade');
  });

  it('loads the core and the recipe apart, with the recipe typed', async () => {
    const loaded = await loadConfig(withFile(renderConfig(sampleConfig())), HOME);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.core.tracker).toEqual({ kind: 'local' });
    expect(loaded.value.recipe.projects.map((project) => project.id)).toEqual(['web']);
    expect(Object.keys(loaded.value.core)).not.toContain('recipe');
  });

  it('names a key of the recipe block with the path of the block in the file', async () => {
    const text = renderConfig(sampleConfig()).replace('path: "../web"', 'path: "/abs/web"');
    const loaded = await loadConfig(withFile(text), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('recipe.projects.0.path');
  });

  it('names the key of an address that is not a file address', async () => {
    const config = withCore({ children: [{ id: 'far', address: 'ssh://host/srv/far-factory' }] });
    const loaded = await loadConfig(withFile(renderConfig(config)), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('children.0.address: factory runs on one machine');
  });

  it('reports a schema number below 1 as invalid', async () => {
    const state = await inspectConfig(withFile('schema: 0\n'), HOME);
    expect(state.kind).toBe('invalid');
  });

  it('reports a missing or bad schema key as invalid', async () => {
    expect((await inspectConfig(withFile('node: {}\n'), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFile('schema: one\n'), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFile('- a\n- b\n'), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFile(''), HOME)).kind).toBe('invalid');
  });

  it('names the bad key in the error', async () => {
    const text = renderConfig(sampleConfig()).replace('effort: high', 'effort: wild');
    const loaded = await loadConfig(withFile(text), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('factory.yaml is invalid');
      expect(loaded.error.message).toContain('session.effort');
    }
  });

  it('hides a key that looks like a token in the error', async () => {
    const unknownKey = await loadConfig(withFile(`${renderConfig(sampleConfig())}${FAKE_GITHUB_TOKEN}: 1\n`), HOME);
    const worker = await loadConfig(
      withFile(renderConfig(withCore({ workers: { [FAKE_GITHUB_TOKEN]: { proxy: 'none' } } }))),
      HOME,
    );
    for (const loaded of [unknownKey, worker]) {
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.message).toContain('factory.yaml is invalid');
        expect(loaded.error.message).toContain('<key>');
        expect(loaded.error.message).not.toContain(FAKE_GITHUB_TOKEN);
      }
    }
  });

  it('keeps the raw document of an invalid file for the secret scan', async () => {
    const state = await inspectConfig(withFile('schema: 2\nextra: ghp_x\n'), HOME);
    expect(state.kind).toBe('invalid');
    if (state.kind === 'invalid') expect(state.raw).toMatchObject({ extra: 'ghp_x' });
  });
});

describe('renderConfig', () => {
  const roundTrip = (config: FactoryConfig): FactoryConfig => {
    const parsed = parseYamlText(renderConfig(config));
    expect(parsed.ok).toBe(true);
    const checked = configSchema.safeParse(parsed.ok ? parsed.value : null);
    if (!checked.success) throw new Error('the rendered config does not parse');
    return checked.data;
  };

  const full = (): FactoryConfig => {
    const sample = sampleConfig();
    return {
      core: {
        ...sample.core,
        owner: { ...sample.core.owner, display: 'Name: "quoted" # not a comment', github: 'some-login' },
        session: { permission_mode: 'auto', effort: 'max', model: 'a model', proxy: 'local' },
        proxies: [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: 'direct' }],
        workers: { 'web-search': { proxy: 'none' }, no: { proxy: 'local' } },
        limits: { ...sample.core.limits, load_max: 7.5 },
        approval: { land: 'approved-work' },
        tracker: { kind: 'jira', items: 'ACME', decisions: 'ACME-DEC', watch_interval: '2h' },
        parent: { id: 'acme', address: 'file:///srv/nodes/acme-factory' },
        children: [{ id: 'web', address: 'file:///srv/nodes/web-factory' }],
      },
      recipe: {
        id: 'software',
        variant: 'plain',
        projects: [
          {
            id: '123',
            repo: 'acme/web',
            path: 'sub/web',
            default_branch: 'release/1.x',
            merge_method: 'rebase',
            variant: 'plain',
            gate: { checks: ['npm run lint', 'say "hi"'] },
            heavy_test: 'npm test',
          },
          { ...sample.recipe.projects[0]!, id: 'true' },
        ],
      },
    };
  };

  it('round-trips the sample config', () => {
    expect(roundTrip(sampleConfig())).toEqual(sampleConfig());
  });

  it('round-trips a full config', () => {
    expect(roundTrip(full())).toEqual(full());
  });

  it('round-trips a local tracker, a parent of null and no project', () => {
    const empty: FactoryConfig = { ...sampleConfig(), recipe: { ...sampleConfig().recipe, projects: [] } };
    expect(roundTrip(empty)).toEqual(empty);
  });

  it('writes comments and the empty sections', () => {
    const text = renderConfig(sampleConfig());
    expect(text).toContain('# factory.yaml: the configuration of this node.');
    expect(text).toContain('schema: 2');
    expect(text).toContain('proxies: []');
    expect(text).toContain('workers: {}');
    expect(text).toContain('parent: null');
    expect(text).toContain('children: []');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('writes the schema 2 sections in the order of the design', () => {
    const text = renderConfig(sampleConfig());
    const order = ['\nnode:', '\nowner:', '\nsession:', '\nproxies:', '\nworkers:', '\nlimits:', '\napproval:', '\ntracker:', '\nrecipe:', '\nparent:', '\nchildren:'];
    const positions = order.map((key) => text.indexOf(key));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('writes the recipe block with its id, its variant and its projects', () => {
    const text = renderConfig(sampleConfig());
    expect(text).toContain('recipe:\n  id: software\n  variant: plain');
    expect(text).toContain('  projects:\n    - id: web\n      path: "../web"');
    expect(text).toContain('tracker:\n  kind: local');
    expect(text).toContain('approval:\n  land: each');
  });

  it('writes a parent as a block and a child as a list item', () => {
    const text = renderConfig(full());
    expect(text).toContain('parent:\n  id: acme\n  address: "file:///srv/nodes/acme-factory"');
    expect(text).toContain('children:\n  - id: web\n    address: "file:///srv/nodes/web-factory"');
  });

  it('omits the optional keys that are not set', () => {
    const text = renderConfig(sampleConfig());
    expect(text).not.toContain('github:');
    expect(text).not.toContain('repo:');
    expect(text).not.toContain('heavy_test:');
  });
});
