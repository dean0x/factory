import { describe, expect, it } from 'vitest';
import {
  inspectConfig,
  inspectSharedConfig,
  loadConfig,
  localFileAccess,
  parseConfigTexts,
  parseYamlText,
  readNodeIdentity,
  settleLocalMode,
} from '../../src/config/load.js';
import { renderConfig } from '../../src/config/render.js';
import { parseConfig, type FactoryConfig } from '../../src/config/schema.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { sampleConfig } from '../helpers/sample-config.js';

const HOME = '/node';
const SHARED = `${HOME}/factory.yaml`;
const LOCAL = `${HOME}/factory.local.yaml`;

/** The sample config with some core keys replaced. */
const withCore = (core: Partial<FactoryConfig['core']>): FactoryConfig => {
  const sample = sampleConfig();
  return { ...sample, core: { ...sample.core, ...core } };
};

/** A home with the texts of the two files. A null text leaves the file out. The default is the sample config. */
const withFiles = (shared: string | null, local: string | null, options: { uid?: number | null } = {}): FakeDeps => {
  const deps = createFakeDeps(options.uid === undefined ? {} : { uid: options.uid });
  deps.seedDir(HOME);
  if (shared !== null) deps.seed(SHARED, shared);
  if (local !== null) deps.seed(LOCAL, local);
  return deps;
};

const sample = (): { shared: string; local: string } => renderConfig(sampleConfig());

const withSample = (): FakeDeps => withFiles(sample().shared, sample().local);

describe('parseConfigTexts', () => {
  it('gives the typed config for the valid texts of both files', () => {
    const texts = sample();
    const parsed = parseConfigTexts(texts.shared, texts.local);
    expect(parsed.ok && parsed.value).toEqual(sampleConfig());
  });

  it('fails, and names the key and the file, for a shared text that is not valid', () => {
    const texts = sample();
    const parsed = parseConfigTexts(texts.shared.replace('effort: high', 'effort: wild'), texts.local);
    expect(parsed).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('factory.yaml is invalid');
      expect(parsed.error.message).toContain('session.effort');
    }
  });

  it('fails, and names the file of the local text, for a local text that is not valid', () => {
    const texts = sample();
    const parsed = parseConfigTexts(texts.shared, texts.local.replace('proxy: none', 'proxy: nowhere'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('factory.local.yaml is invalid');
      expect(parsed.error.message).toContain('session.proxy');
    }
  });

  it('fails for a text that does not parse, and for an older schema, and names the file', () => {
    const texts = sample();
    const broken = parseConfigTexts('a: [1\n', texts.local);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.message).toContain('factory.yaml does not parse');
    const brokenLocal = parseConfigTexts(texts.shared, 'a: [1\n');
    expect(brokenLocal.ok).toBe(false);
    if (!brokenLocal.ok) expect(brokenLocal.error.message).toContain('factory.local.yaml does not parse');
    const older = parseConfigTexts('schema: 1\n', texts.local);
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error.message).toContain('factory upgrade');
  });

  it('checks the approval points of the local text against the recipe', () => {
    const texts = sample();
    const parsed = parseConfigTexts(texts.shared, texts.local.replace(/approval:[\s\S]*?\n\n/, 'approval:\n  nope: owner\n\n'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain('approval.nope');
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
  it('loads two valid files', async () => {
    const deps = withSample();
    const state = await inspectConfig(deps, HOME);
    expect(state.kind).toBe('valid');
    const loaded = await loadConfig(deps, HOME);
    expect(loaded.ok && loaded.value).toEqual(sampleConfig());
  });

  it('reports a missing shared file', async () => {
    const deps = withFiles(null, sample().local);
    expect(await inspectConfig(deps, HOME)).toEqual({ kind: 'missing' });
    const loaded = await loadConfig(deps, HOME);
    expect(loaded).toMatchObject({ ok: false, error: { message: 'factory.yaml not found' } });
  });

  it('reports a folder named factory.yaml as missing', async () => {
    const deps = withFiles(null, null);
    deps.seedDir(SHARED);
    expect(await inspectConfig(deps, HOME)).toEqual({ kind: 'missing' });
  });

  it('exits 2 and names init for a shared file with no local file next to it', async () => {
    const deps = withFiles(sample().shared, null);
    expect(await inspectConfig(deps, HOME)).toEqual({ kind: 'missing', file: 'factory.local.yaml' });
    const loaded = await loadConfig(deps, HOME);
    expect(loaded).toMatchObject({ ok: false, error: { kind: 'usage', message: 'factory.local.yaml not found' } });
    if (!loaded.ok) expect(loaded.error.hint).toContain('factory init');
  });

  it('reports text that does not parse', async () => {
    const state = await inspectConfig(withFiles('a: [1\n', null), HOME);
    expect(state.kind).toBe('unparsable');
  });

  it('reports a local file that does not parse, with the file named', async () => {
    const state = await inspectConfig(withFiles(sample().shared, 'a: [1\n'), HOME);
    expect(state).toMatchObject({ kind: 'unparsable', file: 'factory.local.yaml' });
  });

  it('reports a newer schema with the upgrade-factory message', async () => {
    const state = await inspectConfig(withFiles('schema: 3\n', null), HOME);
    expect(state).toMatchObject({ kind: 'newer', version: 3 });
    const loaded = await loadConfig(withFiles('schema: 3\n', null), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('Upgrade factory.');
  });

  it('reports a newer local schema with the local file named', async () => {
    const deps = withFiles(sample().shared, 'schema: 2\n');
    const loaded = await loadConfig(deps, HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('factory.local.yaml has schema 2');
      expect(loaded.error.message).toContain('Upgrade factory.');
    }
  });

  it('reports a schema 1 file as older and points to the upgrade command', async () => {
    const state = await inspectConfig(withFiles('schema: 1\n', null), HOME);
    expect(state).toMatchObject({ kind: 'older', version: 1 });
    const loaded = await loadConfig(withFiles('schema: 1\n', null), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('factory upgrade');
  });

  it('loads the core and the recipe apart, with the recipe typed', async () => {
    const loaded = await loadConfig(withSample(), HOME);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.core.tracker).toEqual({ kind: 'local' });
    expect(loaded.value.recipe.projects.map((project) => project.id)).toEqual(['web']);
    expect(Object.keys(loaded.value.core)).not.toContain('recipe');
  });

  it('names a key of the recipe block with the path of the block in the file', async () => {
    const text = sample().shared.replace('path: "web"', 'path: "/abs/web"');
    const loaded = await loadConfig(withFiles(text, sample().local), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) expect(loaded.error.message).toContain('recipe.projects.0.path');
  });

  it('names the key of an address that is not a file address, and the local file', async () => {
    const config = withCore({ children: [{ id: 'far', address: 'ssh://host/srv/far-factory' }] });
    const loaded = await loadConfig(withFiles(renderConfig(config).shared, renderConfig(config).local), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('factory.local.yaml is invalid');
      expect(loaded.error.message).toContain('children.0.address: factory runs on one machine');
    }
  });

  it('reports a schema number below 1 as invalid', async () => {
    const state = await inspectConfig(withFiles('schema: 0\n', null), HOME);
    expect(state.kind).toBe('invalid');
  });

  it('reports a missing or bad schema key as invalid', async () => {
    expect((await inspectConfig(withFiles('node: {}\n', null), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFiles('schema: one\n', null), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFiles('- a\n- b\n', null), HOME)).kind).toBe('invalid');
    expect((await inspectConfig(withFiles('', null), HOME)).kind).toBe('invalid');
  });

  it('names the bad key in the error', async () => {
    const text = sample().shared.replace('effort: high', 'effort: wild');
    const loaded = await loadConfig(withFiles(text, sample().local), HOME);
    expect(loaded).toMatchObject({ ok: false });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('factory.yaml is invalid');
      expect(loaded.error.message).toContain('session.effort');
    }
  });

  it('hides a key that looks like a token in the error', async () => {
    const texts = sample();
    const unknownKey = await loadConfig(withFiles(`${texts.shared}${FAKE_GITHUB_TOKEN}: 1\n`, texts.local), HOME);
    const worker = withCore({ workers: { [FAKE_GITHUB_TOKEN]: { proxy: 'none' } } });
    const workerKey = await loadConfig(withFiles(renderConfig(worker).shared, renderConfig(worker).local), HOME);
    for (const loaded of [unknownKey, workerKey]) {
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.message).toContain('is invalid');
        expect(loaded.error.message).toContain('<key>');
        expect(loaded.error.message).not.toContain(FAKE_GITHUB_TOKEN);
      }
    }
  });

  it('keeps the raw document of an invalid file for the secret scan', async () => {
    const state = await inspectConfig(withFiles('schema: 2\nextra: ghp_x\n', null), HOME);
    expect(state.kind).toBe('invalid');
    if (state.kind === 'invalid') expect(state.raw).toMatchObject({ extra: 'ghp_x' });
  });

  it('keeps the keys of both files in the raw document of a valid state, for the secret scan', async () => {
    const state = await inspectConfig(withSample(), HOME);
    expect(state.kind === 'valid' && Object.keys(state.raw as object)).toEqual(
      expect.arrayContaining(['schema', 'node', 'owner', 'proxies', 'approval']),
    );
  });

  it('reads only the shared file for a ping, also when the local file is missing or unsafe', async () => {
    const deps = withFiles(sample().shared, null);
    expect((await inspectSharedConfig(deps, HOME)).kind).toBe('valid');
    deps.seed(LOCAL, sample().local);
    deps.modes.set(LOCAL, 0o666);
    expect((await inspectSharedConfig(deps, HOME)).kind).toBe('valid');
  });
});

describe('readNodeIdentity', () => {
  it('gives the node id and the schema version of a valid shared file, and reads no local file', async () => {
    const identity = await readNodeIdentity(withFiles(sample().shared, null), HOME);
    expect(identity).toEqual({ ok: true, value: { id: sampleConfig().core.node.id, schema: 2 } });
  });

  it('gives the id and the version of a file of an older layout, which is not valid as a whole', async () => {
    const identity = await readNodeIdentity(withFiles('schema: 1\nnode:\n  id: demo\n  role: coordinator\n', null), HOME);
    expect(identity).toEqual({ ok: true, value: { id: 'demo', schema: 1 } });
  });

  it('gives the reason when the older file holds no node id, or an id that is not a slug', async () => {
    for (const text of ['schema: 1\n', 'schema: 1\nnode:\n  id: Not A Slug\n', 'schema: 1\nnode: demo\n']) {
      const identity = await readNodeIdentity(withFiles(text, null), HOME);
      expect(identity).toEqual({ ok: false, error: 'factory.yaml holds no node id' });
    }
  });

  it('gives the reason when the file is missing, a folder, newer, invalid or not parsable', async () => {
    const folder = withFiles(null, null);
    folder.seedDir(SHARED);
    const states: readonly [string, FakeDeps][] = [
      ['missing', withFiles(null, null)],
      ['a folder', folder],
      ['newer', withFiles('schema: 3\n', null)],
      ['invalid', withFiles('schema: 2\nnode: 3\n', null)],
      ['not parsable', withFiles('a: [1\n', null)],
    ];
    for (const [name, deps] of states) {
      const identity = await readNodeIdentity(deps, HOME);
      expect(identity.ok, name).toBe(false);
      if (!identity.ok) expect(identity.error, name).not.toBe('');
    }
  });
});

describe('a pulled change in the shared file', () => {
  it('fails the load when it adds a proxy entry, and names the key and the local file', async () => {
    const pulled = `${sample().shared}proxies:\n  - id: pulled\n    base_url: "http://203.0.113.9:8080"\n    health: /health\n`;
    const state = await inspectConfig(withFiles(pulled, sample().local), HOME);
    expect(state.kind).toBe('invalid');
    const loaded = await loadConfig(withFiles(pulled, sample().local), HOME);
    expect(loaded).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('proxies: is a local key');
      expect(loaded.error.message).toContain('factory.local.yaml');
      expect(loaded.error.message).not.toContain('203.0.113.9');
    }
  });

  it('fails the load when it sets the proxy of the session', async () => {
    const pulled = sample().shared.replace('  model: default\n', '  model: default\n  proxy: pulled\n');
    const loaded = await loadConfig(withFiles(pulled, sample().local), HOME);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain('session.proxy: is a local key');
  });

  it('says to make the node again for a config of the older layout, with exit 1', async () => {
    for (const older of ['cells: {}\n', 'approval:\n  land: each\n']) {
      const loaded = await loadConfig(withFiles(`${sample().shared}${older}`, sample().local), HOME);
      expect(loaded).toMatchObject({ ok: false, error: { kind: 'failure' } });
      if (!loaded.ok) {
        expect(loaded.error.message).toContain('older layout');
        expect(loaded.error.message).toContain('factory init');
      }
    }
  });
});

describe('the mode and the owner of the local file', () => {
  const wide = (mode: number): FakeDeps => {
    const deps = withSample();
    deps.modes.set(LOCAL, mode);
    return deps;
  };

  it.each([0o644, 0o640, 0o604, 0o604 | 0o040])('loads a file with only group or other read bits (mode %o) and reports it as wide', async (mode) => {
    const deps = wide(mode);
    expect((await loadConfig(deps, HOME)).ok).toBe(true);
    expect(await localFileAccess(deps, HOME)).toEqual({ ok: true, value: { kind: 'wide', mode } });
  });

  it('reports mode 600, mode 400 and a missing file as not wide', async () => {
    expect(await localFileAccess(wide(0o600), HOME)).toEqual({ ok: true, value: { kind: 'private' } });
    expect(await localFileAccess(wide(0o400), HOME)).toEqual({ ok: true, value: { kind: 'private' } });
    expect(await localFileAccess(withFiles(sample().shared, null), HOME)).toEqual({ ok: true, value: { kind: 'absent' } });
  });

  it('sets a wide mode back to 600 with a notice that names the file and the old mode', async () => {
    const deps = wide(0o644);
    const notes = await settleLocalMode(deps, HOME, true);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(notes.ok && notes.value).toHaveLength(1);
    if (notes.ok) {
      expect(notes.value[0]).toContain('factory.local.yaml');
      expect(notes.value[0]).toContain('644');
    }
  });

  it('changes no mode in a dry run, and names the chmod command', async () => {
    const deps = wide(0o644);
    const notes = await settleLocalMode(deps, HOME, false);
    expect(deps.modes.get(LOCAL)).toBe(0o644);
    expect(notes.ok && notes.value[0]).toContain('chmod 600 factory.local.yaml');
  });

  it('gives no notice and changes nothing for a private file', async () => {
    const deps = wide(0o600);
    expect(await settleLocalMode(deps, HOME, true)).toEqual({ ok: true, value: [] });
    expect(deps.modes.get(LOCAL)).toBe(0o600);
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
    ['a group write bit with the read bits', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o666)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('refuses a local file with %s, with exit 4 and one remedy line, and changes no mode', async (_name, change) => {
    const deps = withSample();
    change(deps);
    const before = deps.modes.get(LOCAL);
    const loaded = await loadConfig(deps, HOME);
    expect(loaded).toMatchObject({ ok: false, error: { kind: 'safety' } });
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('factory.local.yaml');
      expect(loaded.error.hint).toContain('chmod 600 factory.local.yaml');
    }
    expect(deps.modes.get(LOCAL)).toBe(before);
    expect(await settleLocalMode(deps, HOME, true)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.modes.get(LOCAL)).toBe(before);
  });

  describe('when the local file is a link', () => {
    const linkedLocal = (extra: Record<string, string> = {}): FakeDeps => {
      const deps = createFakeDeps({ links: { [LOCAL]: '/outside/local.yaml', ...extra } });
      deps.seedDir(HOME);
      deps.seed(SHARED, sample().shared);
      deps.seed(LOCAL, sample().local);
      return deps;
    };

    it('refuses the load with exit 4 and one remedy line that tells to move the file away', async () => {
      const loaded = await loadConfig(linkedLocal(), HOME);
      expect(loaded).toMatchObject({ ok: false, error: { kind: 'safety' } });
      if (!loaded.ok && loaded.error.kind === 'safety') {
        expect(loaded.error.message).toBe('factory.local.yaml is a link, so factory does not use it');
        expect(loaded.error.hint).toBe('Move factory.local.yaml away, then run "factory init" to write a new one.');
      }
    });

    it('refuses before the check of the owner and before the mode fix', async () => {
      const deps = linkedLocal();
      deps.owners.set(LOCAL, 0);
      deps.modes.set(LOCAL, 0o644);
      const access = await localFileAccess(deps, HOME);
      expect(access).toMatchObject({ ok: false, error: { kind: 'safety', message: 'factory.local.yaml is a link, so factory does not use it' } });
      expect(await settleLocalMode(deps, HOME, true)).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.modes.get(LOCAL)).toBe(0o644);
    });

    it('refuses a link whose target does not exist', async () => {
      const deps = createFakeDeps({ links: { [LOCAL]: '/outside/gone.yaml' } });
      deps.seedDir(HOME);
      deps.seed(SHARED, sample().shared);
      expect(await localFileAccess(deps, HOME)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    });

    it('does not read the content, and gives the state unsafe', async () => {
      const state = await inspectConfig(linkedLocal(), HOME);
      expect(state).toMatchObject({ kind: 'unsafe', file: 'factory.local.yaml' });
      expect(state).not.toHaveProperty('raw');
    });

    it('loads a local file that is a plain file when the folder above the factory folder is a link', async () => {
      const deps = createFakeDeps({ links: { '/via': '/real' } });
      deps.seedDir('/via/node');
      deps.seed('/via/node/factory.yaml', sample().shared);
      deps.seed('/via/node/factory.local.yaml', sample().local);
      expect((await loadConfig(deps, '/via/node')).ok).toBe(true);
    });
  });

  it('does not read the content of a file that it refuses', async () => {
    const deps = withSample();
    deps.modes.set(LOCAL, 0o666);
    const state = await inspectConfig(deps, HOME);
    expect(state).toMatchObject({ kind: 'unsafe', file: 'factory.local.yaml' });
    expect(state).not.toHaveProperty('raw');
  });

  it('skips the owner check on a platform with no user ids, and still refuses a write bit', async () => {
    const deps = withFiles(sample().shared, sample().local, { uid: null });
    deps.owners.set(LOCAL, 0);
    expect((await loadConfig(deps, HOME)).ok).toBe(true);
    deps.modes.set(LOCAL, 0o620);
    expect(await loadConfig(deps, HOME)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('refuses a local file that is a folder', async () => {
    const deps = withFiles(sample().shared, null);
    deps.seedDir(LOCAL);
    expect(await loadConfig(deps, HOME)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });
});

describe('renderConfig', () => {
  const roundTrip = (config: FactoryConfig): FactoryConfig => {
    const texts = renderConfig(config);
    const shared = parseYamlText(texts.shared);
    const local = parseYamlText(texts.local);
    expect(shared.ok && local.ok).toBe(true);
    const checked = parseConfig(shared.ok ? shared.value : null, local.ok ? local.value : null);
    if (!checked.success) throw new Error('the rendered config does not parse');
    return checked.data;
  };

  const full = (): FactoryConfig => {
    const base = sampleConfig();
    const [firstPoint] = Object.keys(base.core.approval);
    return {
      core: {
        ...base.core,
        owner: { ...base.core.owner, display: 'Name: "quoted" # not a comment', github: 'some-login' },
        session: { permission_mode: 'auto', effort: 'max', model: 'a model', proxy: 'local', statusline: 'my-status --short' },
        proxies: [{ id: 'local', base_url: 'http://127.0.0.1:8787/v1', health: '/health', on_fail: 'direct' }],
        workers: { 'web-search': { proxy: 'none' }, no: { proxy: 'local' } },
        limits: { ...base.core.limits, load_max: 7.5 },
        approval: { ...base.core.approval, [firstPoint ?? '']: 'delegated' },
        tracker: { kind: 'jira', items: 'ACME', decisions: 'ACME-DEC', watch_interval: '2h' },
        parent: { id: 'acme', address: 'file:///srv/nodes/acme-factory' },
        children: [{ id: 'web', address: 'file:///srv/nodes/web-factory' }],
        sources: { 'web-app': '/srv/code/"web"' },
      },
      recipe: {
        id: 'software',
        variant: 'plain',
        projects: [
          {
            id: '123',
            repo: 'acme/web',
            path: 'web-app',
            default_branch: 'release/1.x',
            merge_method: 'rebase',
            variant: 'plain',
            gate: { checks: ['npm run lint', 'say "hi"'] },
            heavy_test: 'npm test',
          },
          { ...base.recipe.projects[0]!, id: 'true' },
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

  it('writes comments and the empty sections in the right file', () => {
    const texts = sample();
    expect(texts.shared).toContain('# factory.yaml: the shared configuration of this node.');
    expect(texts.shared).toContain('schema: 2');
    expect(texts.local).toContain('# factory.local.yaml: the configuration of one person on this machine.');
    expect(texts.local).toContain('schema: 1');
    expect(texts.local).toContain('proxies: []');
    expect(texts.local).toContain('workers: {}');
    expect(texts.local).toContain('sources: {}');
    expect(texts.local).toContain('parent: null');
    expect(texts.local).toContain('children: []');
    expect(texts.shared.endsWith('\n')).toBe(true);
    expect(texts.local.endsWith('\n')).toBe(true);
  });

  it('writes no local key in the shared file and no shared key in the local file', () => {
    const shared = parseYamlText(sample().shared);
    const local = parseYamlText(sample().local);
    expect(shared.ok && Object.keys(shared.value as object)).toEqual(['schema', 'node', 'session', 'limits', 'tracker', 'recipe']);
    expect(local.ok && Object.keys(local.value as object)).toEqual([
      'schema',
      'owner',
      'session',
      'proxies',
      'workers',
      'approval',
      'sources',
      'parent',
      'children',
    ]);
    expect(shared.ok && Object.keys((shared.value as Record<string, object>)['session'] ?? {})).toEqual([
      'permission_mode',
      'effort',
      'model',
    ]);
  });

  it('writes the sections of the shared file in the order of the design', () => {
    const text = sample().shared;
    const order = ['\nnode:', '\nsession:', '\nlimits:', '\ntracker:', '\nrecipe:'];
    const positions = order.map((key) => text.indexOf(key));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('writes the recipe block with its id, its variant and its projects', () => {
    const text = sample().shared;
    expect(text).toContain('recipe:\n  id: software\n  variant: plain');
    expect(text).toContain('  projects:\n    - id: web\n      url: "https://github.com/acme/web.git"\n      path: "web"');
    expect(text).toContain('tracker:\n  kind: local');
  });

  it('writes the mode of each approval point in the local file', () => {
    const [point] = Object.keys(sampleConfig().core.approval);
    expect(sample().local).toContain(`approval:\n  ${point}: owner`);
  });

  it('writes a parent as a block and a child as a list item in the local file', () => {
    const text = renderConfig(full()).local;
    expect(text).toContain('parent:\n  id: acme\n  address: "file:///srv/nodes/acme-factory"');
    expect(text).toContain('children:\n  - id: web\n    address: "file:///srv/nodes/web-factory"');
  });

  it('omits the optional keys that are not set', () => {
    const texts = sample();
    expect(texts.local).not.toContain('github:');
    expect(texts.shared).not.toContain('repo:');
    expect(texts.shared).not.toContain('heavy_test:');
  });
});
