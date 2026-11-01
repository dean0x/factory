import { describe, expect, it } from 'vitest';
import { inspectConfig, loadConfig, parseYamlText } from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import { configSchema, type FactoryConfig } from '../../src/config/schema.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/node';

const withFile = (text: string | null) => {
  const deps = createFakeDeps();
  deps.seedDir(HOME);
  if (text !== null) deps.seed(`${HOME}/factory.yaml`, text);
  return deps;
};

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
});

describe('inspectConfig and loadConfig', () => {
  it('loads a valid file', async () => {
    const deps = withFile(renderConfig(sampleConfig()));
    const state = await inspectConfig(deps, HOME);
    expect(state.kind).toBe('valid');
    const loaded = await loadConfig(deps, HOME);
    expect(loaded.ok && loaded.value.node.id).toBe('demo');
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
    const state = await inspectConfig(withFile('schema: 2\n'), HOME);
    expect(state).toMatchObject({ kind: 'newer', version: 2 });
    const loaded = await loadConfig(withFile('schema: 2\n'), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('Upgrade factory.');
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

  it('keeps the raw document of an invalid file for the secret scan', async () => {
    const state = await inspectConfig(withFile('schema: 1\nextra: ghp_x\n'), HOME);
    expect(state.kind).toBe('invalid');
    if (state.kind === 'invalid') expect(state.raw).toMatchObject({ extra: 'ghp_x' });
  });
});

describe('renderConfig', () => {
  const roundTrip = (config: FactoryConfig): FactoryConfig => {
    const parsed = parseYamlText(renderConfig(config));
    expect(parsed.ok).toBe(true);
    return configSchema.parse(parsed.ok ? parsed.value : null);
  };

  it('round-trips the sample config', () => {
    expect(roundTrip(sampleConfig())).toEqual(sampleConfig());
  });

  it('round-trips a full config', () => {
    const full: FactoryConfig = {
      ...sampleConfig(),
      owner: { ...sampleConfig().owner, display: 'Name: "quoted" # not a comment', github: 'some-login' },
      session: { permission_mode: 'auto', effort: 'max', model: 'a model', proxy: 'local' },
      proxies: [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: 'direct' }],
      lanes: { 'web-lane': { proxy: 'none' }, no: { proxy: 'local' } },
      limits: { ...sampleConfig().limits, load_max: 7.5 },
      projects: [
        {
          id: '123',
          repo: 'acme/web',
          path: 'sub/web',
          default_branch: 'release/1.x',
          merge_method: 'rebase',
          pack: 'plain',
          gate: { checks: ['npm run lint', 'say "hi"'] },
          heavy_test: 'npm test',
        },
        { ...sampleConfig().projects[0]!, id: 'true' },
      ],
      children: [{ id: 'acme', address: 'acme/node' }],
    };
    expect(roundTrip(full)).toEqual(full);
  });

  it('writes comments and the empty sections', () => {
    const text = renderConfig(sampleConfig());
    expect(text).toContain('# factory.yaml: the configuration of this node.');
    expect(text).toContain('proxies: []');
    expect(text).toContain('lanes: {}');
    expect(text).toContain('children: []');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('omits the optional keys that are not set', () => {
    const text = renderConfig(sampleConfig());
    expect(text).not.toContain('github:');
    expect(text).not.toContain('repo:');
    expect(text).not.toContain('heavy_test:');
  });
});
