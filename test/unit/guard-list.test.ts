import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config/load.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { guardRowsFor, guardsFor } from '../../src/guards/registry.js';
import { guardOf } from '../../src/guards/build.js';
import type { Guard } from '../../src/guards/types.js';
import { dirs, files, guardConfigWords, guardIds, guardListWords, schemaIds } from '../../src/names.js';
import { recipes, type RecipeEntry, type RecipeRegistry } from '../../src/recipes/index.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { publishRecipe, twoRecipeRegistry } from '../helpers/publish-recipe.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, OFF_GUARD, OTHER_NODE_ID, withFirstConfigReadFault } from '../helpers/guarded-node.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { UNWIRED_GUARD, unwiredRegistry } from '../helpers/unwired-guard.js';

const HOME = '/w/node';
const STORE = `/state/factory/${files.guardRecords}`;
const AT = '2030-01-02T03:04:05.678Z';
const seedRecord = (deps: FakeDeps, values: Readonly<Record<string, 'on' | 'off'>>): void => {
  deps.seed(STORE, JSON.stringify({ schema: 1, records: [{ node: 'demo', root: HOME, prefix: null,
    values: Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, at: AT }])),
  }] }));
};
const make = (config: FactoryConfig = sampleConfig(), links: Readonly<Record<string, string>> = {}): FakeDeps => {
  const deps = createFakeDeps({ cwd: HOME, env: { XDG_STATE_HOME: '/state' }, links });
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, config.core.node.id);
  return deps;
};

const publishingConfig = (): FactoryConfig => {
  const config = sampleConfig();
  return { ...config, core: { ...config.core, approval: {} }, recipe: { id: publishRecipe.id, variant: 'plain', projects: [] }, entry: publishRecipe };
};

const run = async (deps = make(), flags: readonly string[] = [], registry: RecipeRegistry = recipes) => {
  const sink = captureSink();
  const code = await runCli(['guard', 'list', ...flags], deps, sink, registry);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

const linesOf = (out: string): string[] => out.trimEnd().split('\n');
const cellsOf = (line: string): string[] => line.split(/\s{2,}/);
const rowCells = (title: string, line: string): string[] => {
  const starts = cellsOf(title).map((cell) => title.indexOf(cell));
  return starts.map((start, index) => line.slice(start, starts[index + 1]).trim());
};
const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files, [...deps.dirs], [...deps.modes]]);
/** The place cell of a guard that no value names: a fixed guard, a guard with no key, or a guard that this version cannot set. */
const placeOf = (guard: { readonly fixed: boolean; readonly wired: boolean }): string =>
  guard.fixed ? guardListWords.fixed : guard.wired ? 'no key' : 'not settable in this version';
/**
 * The JSON form of a guard when the config does not load: the value is unknown and the source names the fault, except for a fixed
 * guard, which is always on with the fixed word as its source.
 */
const unloadedOf = (guard: Guard) => ({
  ...guard,
  settable: guard.wired,
  value: guard.fixed ? 'on' : 'unknown',
  source: guard.fixed ? guardListWords.fixed : 'notLoaded',
  since: null,
});

const expectUnknown = async (deps: FakeDeps, registry: RecipeRegistry = recipes) => {
  const loaded = await loadConfig(deps, HOME, registry);
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  const result = await run(deps, [], registry);
  expect(linesOf(result.out)[0]).toContain(loaded.error.message);
  const fixedIds = guardsFor(registry[0]).filter((guard) => guard.fixed).map((guard) => guard.id);
  const cells = linesOf(result.out).slice(2, -2).map(cellsOf);
  expect(cells.every((row) => row[1] === (fixedIds.includes(row[0] ?? '') ? 'on' : 'unknown'))).toBe(true);
  expect(result.out).not.toContain('no key');
  expect(result.out).toContain('config not loaded');
  expect(linesOf(result.out).slice(2, -2).length).toBeGreaterThan(0);
  expectShortOutput(result.out);
  return result;
};

describe('guard list', () => {
  it('shows a short table with the value, default, harm mark, source, more line and count', async () => {
    const result = await run();
    const lines = linesOf(result.out);
    const guards = guardsFor(recipes[0]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(cellsOf(lines[0] ?? '')).toEqual(['GUARD', 'VALUE', 'DEFAULT', 'H', 'SET IN']);
    expect(lines.slice(1, -2).map((line) => rowCells(lines[0] ?? '', line))).toEqual(guards.slice(0, 17).map((guard) => [guard.id, 'on', guard.newNode, guard.harm ? 'H' : '', placeOf(guard)]));
    expect(lines.at(-2)).toBe('and 15 more: run with --all or --json');
    expect(lines.at(-1)).toBe('0 of 32 guards are off. 0 of them have the mark H.');
    expectShortOutput(result.out);
  });

  it('shows every guard with all, without a more line', async () => {
    const result = await run(make(), ['--all']);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(lines.slice(1, -1).map((line) => cellsOf(line)[0])).toEqual(guardsFor(recipes[0]).map((guard) => guard.id));
    expect(lines.at(-1)).toBe(guardListWords.countLine(0, guardsFor(recipes[0]).length, 0));
  });

  it('shows marked off guards, unmarked off guards and on guards in that order, with their counts', async () => {
    const recipe: RecipeEntry = {
      ...publishRecipe,
      guards: [
        { id: 'unmarked-off', name: 'Unmarked', keepsSafe: 'Sample data stays safe.', wired: true, fixed: false, newNode: 'on', whenMissing: 'off', related: [] },
        { id: 'sample-on', name: 'On', keepsSafe: 'Sample data stays safe.', wired: true, fixed: false, newNode: 'on', whenMissing: 'on', related: [] },
        { id: 'marked-off', name: 'Marked', keepsSafe: 'Sample data stays private.', wired: true, fixed: false, newNode: 'on', whenMissing: 'off', related: [] },
      ],
      guardRows: [
        { id: 'unmarked-row', guard: 'unmarked-off', name: 'Sample data stays safe.', applies: 'Sample', kind: 'text', harm: false, alwaysOn: false, sites: [] },
        { id: 'on-row', guard: 'sample-on', name: 'Sample data stays safe.', applies: 'Sample', kind: 'text', harm: false, alwaysOn: false, sites: [] },
        { id: 'marked-row', guard: 'marked-off', name: 'Sample data stays private.', applies: 'Sample', kind: 'text', harm: true, alwaysOn: false, sites: [] },
      ],
    };
    const config = publishingConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { 'marked-off': 'off', 'unmarked-off': 'off' } } });
    seedRecord(deps, { 'marked-off': 'off', 'unmarked-off': 'off' });
    const result = await run(deps, ['--all'], [recipe]);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(lines.slice(1, -1).map((line) => rowCells(lines[0] ?? '', line))).toEqual([
      ['marked-off', 'off', 'on', 'H', 'factory.local.yaml and record'],
      ['unmarked-off', 'off', 'on', '', 'factory.local.yaml and record'],
      ...guardsFor({ ...publishRecipe, guards: [], guardRows: [] }).map((guard) => [guard.id, 'on', guard.newNode, guard.harm ? 'H' : '', placeOf(guard)]),
      ['sample-on', 'on', 'on', '', 'no key'],
    ]);
    expect(lines.at(-1)).toBe(guardListWords.countLine(2, 31, 1));
  });

  it('takes the guards and the count from the recipe of the config', async () => {
    const result = await run(make(publishingConfig()), ['--all'], twoRecipeRegistry);
    expect(result.code).toBe(0);
    expect(linesOf(result.out).slice(1, -1).map((line) => cellsOf(line)[0])).toEqual(guardsFor(publishRecipe).map((guard) => guard.id));
    expect(linesOf(result.out).at(-1)).toBe('0 of 30 guards are off. 0 of them have the mark H.');
  });

  it('gives every guard fact and every row fact in JSON without line numbers or text output', async () => {
    const result = await run(make(), ['--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toEqual({
      schema: schemaIds.guardList,
      home: HOME,
      error: null,
      guards: guardsFor(recipes[0]).map((guard) => ({
        ...guard, settable: guard.wired, value: 'on', source: guard.fixed ? guardListWords.fixed : 'missing', since: null,
      })),
      rows: guardRowsFor(recipes[0]),
      unmatched: [],
      loosened: [],
    });
  });

  it('reports a recipe guard as settable only when it is wired', async () => {
    const recipe: RecipeEntry = {
      ...publishRecipe,
      guards: [{ ...guardOf('sample-guard', 'Sample', 'Sample data stays safe.'), wired: true }],
    };
    const result = await run(make(publishingConfig()), ['--json'], [recipe]);
    expect(result.code).toBe(0);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: [
      ...guardsFor({ ...recipe, guards: [] }).map((guard) => ({ id: guard.id, settable: guard.wired })),
      { id: 'sample-guard', wired: true, settable: true, value: 'on', source: 'missing', since: null },
    ] });
  });

  it('shows a guard that this version cannot set as on and not settable even with a local off value', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { [UNWIRED_GUARD]: 'off' } } });
    const json = await run(deps, ['--json'], unwiredRegistry);
    expect(json.code).toBe(0);
    const doc: unknown = JSON.parse(json.out);
    expect(doc).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id: UNWIRED_GUARD, wired: false, settable: false, value: 'on' }),
    ]) });
    const text = await run(deps, ['--all'], unwiredRegistry);
    expect(text.code).toBe(0);
    const lines = linesOf(text.out);
    const row = lines.find((line) => line.startsWith(UNWIRED_GUARD)) ?? '';
    expect(rowCells(lines[0] ?? '', row)).toEqual([UNWIRED_GUARD, 'on', 'on', 'H', 'not settable in this version']);
  });

  it.each(['board-edits', 'merge-quality', 'dismiss', 'session-checks', 'owner-go', 'task-files', 'pr-rules', 'work-conduct'])('shows %s as settable', async (id) => {
    const json = await run(make(sampleConfig()), ['--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id, wired: true, settable: true, value: 'on' }),
    ]) });
  });

  it('shows the effective value, source and time from one guard store read', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { [guardIds.installRules]: 'off', [guardIds.resumeRoutines]: 'off' } } });
    seedRecord(deps, { [guardIds.installRules]: 'off', [guardIds.resumeRoutines]: 'off' });
    const counted = countReadsOf(deps, STORE);
    const result = await run(counted.deps, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id: guardIds.installRules, value: 'off', source: 'local', since: AT, settable: true }),
      expect.objectContaining({ id: guardIds.resumeRoutines, value: 'off', source: 'local', since: AT }),
    ]), unmatched: [], loosened: expect.arrayContaining([guardIds.installRules, guardIds.resumeRoutines]) });
    expect(counted.count()).toBe(1);
  });

  it.each([{}, { [UNWIRED_GUARD]: 'off' as const }])('reads no guard store without a wired local off value: %j', async (guards) => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards } });
    seedRecord(deps, { [guardIds.installRules]: 'off' });
    const counted = countReadsOf(deps, STORE);
    expect((await run(counted.deps, [], unwiredRegistry)).code).toBe(0);
    expect(counted.count()).toBe(0);
  });

  it('keeps an unmatched local off value on and lists a direct proxy', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { [guardIds.installRules]: 'off' }, proxies: [
      { id: 'sample', base_url: 'http://localhost:4000', health: '/health', on_fail: 'direct' },
    ] } });
    const result = await run(deps, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id: guardIds.installRules, value: 'on', source: 'noRecord', since: null }),
    ]), unmatched: [guardIds.installRules], loosened: ['direct proxy sample'] });
  });

  it('lets the shared on value override a matching local off record', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core,
      guards: { [guardIds.installRules]: 'off' }, shared_guards: { [guardIds.installRules]: 'on' },
    } });
    seedRecord(deps, { [guardIds.installRules]: 'off' });
    const result = await run(deps, ['--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id: guardIds.installRules, value: 'on', source: 'shared', since: null }),
    ]), loosened: [] });
  });

  it('keeps all guards on without a read through a linked guard store', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { [guardIds.installRules]: 'off' } } }, { [STORE]: '/outside/store' });
    deps.seed('/outside/store', 'not read');
    const target = countReadsOf(deps, '/outside/store');
    const result = await run(target.deps);
    expect(result.code).toBe(0);
    expect(result.err).toContain(STORE);
    expect(result.out).toContain('0 of 32 guards are off.');
    expect(target.count()).toBe(0);
  });

  it('shows all guards on with one warning and exit zero when the guard store is invalid', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, guards: { [guardIds.installRules]: 'off' } } });
    deps.seed(STORE, 'not json');
    const counted = countReadsOf(deps, STORE);
    const result = await run(counted.deps);
    expect(result.code).toBe(0);
    expect(result.err).toContain(STORE);
    expect(result.err.trim().split('\n')).toHaveLength(1);
    expect(result.out).toContain('0 of 32 guards are off.');
    expectShortOutput(result.out);
    expect(counted.count()).toBe(1);
    const all = linesOf((await run(deps, ['--all'])).out);
    const row = all.find((line) => line.startsWith(`${guardIds.installRules} `)) ?? '';
    expect(rowCells(all[0] ?? '', row).at(-1)).toBe('factory.local.yaml, records not read');
  });

  it('keeps the complete JSON with family and all flags', async () => {
    const result = await run(make(), ['--family', guardIds.boardEdits, '--all', '--json']);
    expect(result.code).toBe(0);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(recipes[0]).map((guard) => ({ id: guard.id })), rows: guardRowsFor(recipes[0]) });
  });

  it('shows the rows of a family with each row kind, the fixed mark of an always-on row, the harm mark and safe outcome', async () => {
    const result = await run(make(), ['--family', guardIds.boardEdits]);
    const rows = guardRowsFor(recipes[0]).filter((row) => row.guard === guardIds.boardEdits);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(cellsOf(lines[0] ?? '')).toEqual(['ROW', 'KIND', 'H', 'KEEPS SAFE']);
    for (const [index, row] of rows.entries()) {
      const kind = row.alwaysOn ? `${guardListWords.fixed} ${row.kind}` : row.kind;
      expect(rowCells(lines[0] ?? '', lines[index + 1] ?? '')).toEqual([row.id, kind, row.harm ? 'H' : '', row.name]);
    }
    expect(lines.find((line) => line.startsWith('board-reserved-names '))).toContain(`${guardListWords.fixed} code`);
    expect(lines).toHaveLength(rows.length + 1);
    expectShortOutput(result.out);
  });

  it('shows each fixed guard as on with the fixed word and no key, in the table, the family view and JSON', async () => {
    const all = linesOf((await run(make(), ['--all'])).out);
    const json: unknown = JSON.parse((await run(make(), ['--json'])).out);
    for (const id of [guardIds.cloneRules, guardIds.hookRuntime]) {
      const row = all.find((line) => line.startsWith(`${id} `)) ?? '';
      expect(rowCells(all[0] ?? '', row)).toEqual([id, 'on', 'on', '', guardListWords.fixed]);
      expect(json).toMatchObject({ guards: expect.arrayContaining([
        expect.objectContaining({ id, fixed: true, key: null, wired: false, settable: false, value: 'on', source: guardListWords.fixed }),
      ]) });
      const family = linesOf((await run(make(), ['--family', id, '--all'])).out);
      expect(family.slice(1).map((line) => rowCells(family[0] ?? '', line)[1])).toEqual(
        guardRowsFor(recipes[0]).filter((item) => item.guard === id).map((item) => `${guardListWords.fixed} ${item.kind}`),
      );
    }
  });

  it.each([
    ['the local file, with the value off and a matching record', 'guards', files.localConfig],
    ['the shared file', 'shared_guards', files.config],
  ] as const)('shows a fixed guard as on and warns for its key in %s', async (_name, key, file) => {
    const config = sampleConfig();
    const id = guardIds.cloneRules;
    const deps = make({ ...config, core: { ...config.core, ...(key === 'guards' ? { guards: { [id]: 'off' } } : { shared_guards: { [id]: 'on' } }) } });
    seedRecord(deps, { [id]: 'off' });
    const result = await run(deps, ['--all']);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(rowCells(lines[0] ?? '', lines.find((line) => line.startsWith(`${id} `)) ?? '')).toEqual([id, 'on', 'on', '', guardListWords.fixed]);
    expect(lines.at(-1)).toBe(guardListWords.countLine(0, guardsFor(recipes[0]).length, 0));
    expect(result.err).toContain(guardConfigWords.fixedKey(file, key, id));
    const json: unknown = JSON.parse((await run(deps, ['--json'])).out);
    expect(json).toMatchObject({ guards: expect.arrayContaining([
      expect.objectContaining({ id, value: 'on', source: guardListWords.fixed }),
    ]) });
  });

  it('caps the rows of a large family and names the rest in a more line', async () => {
    const result = await run(make(), ['--family', guardIds.fileLinkSafety]);
    const rows = guardRowsFor(recipes[0]).filter((row) => row.guard === guardIds.fileLinkSafety);
    expect(result.code).toBe(0);
    expect(linesOf(result.out).slice(1, -1).map((line) => cellsOf(line)[0])).toEqual(rows.slice(0, 17).map((row) => row.id));
    expect(linesOf(result.out).at(-1)).toBe(guardListWords.moreLine(rows.length - 17));
    expectShortOutput(result.out);
  });

  it('shows every row of a family with all', async () => {
    const result = await run(make(), ['--family', guardIds.fileLinkSafety, '--all']);
    const rows = guardRowsFor(recipes[0]).filter((row) => row.guard === guardIds.fileLinkSafety);
    expect(result.code).toBe(0);
    expect(linesOf(result.out).slice(1).map((line) => cellsOf(line)[0])).toEqual(rows.map((row) => row.id));
  });

  it('refuses an unknown family with the name of the list command', async () => {
    const result = await run(make(), ['--family', 'not-a-guard']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('not-a-guard');
    expect(result.err).toContain('factory guard list');
  });

  it('uses the home flag to select its folder', async () => {
    const deps = make();
    const result = await run({ ...deps, cwd: '/elsewhere' }, ['--home', HOME]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('GUARD');
  });

  it('reads no work copy, child, owner store or check and writes nothing', async () => {
    const config = sampleConfig();
    const deps = make({ ...config, core: { ...config.core, children: [{ id: 'child', address: 'file:///w/child' }] } });
    const seen: string[] = [];
    const before = snapshot(deps);
    const result = await run(withFsWatch(deps, (method, path) => { if (method.startsWith('read') || method === 'openChecked' || method.startsWith('list')) seen.push(path); }));
    expect(result.code).toBe(0);
    expect(seen.filter((path) => path.startsWith(`${HOME}/`)).every((path) => [files.config, files.localConfig, `${dirs.state}/${files.nodeState}`].some((file) => path === `${HOME}/${file}`))).toBe(true);
    expect(seen.some((path) => /work-copies|child|owner/.test(path))).toBe(false);
    expect(snapshot(deps)).toBe(before);
    expect(deps.calls).toEqual([]);
    expect(deps.prompts).toEqual([]);
    expect(deps.fetched).toEqual([]);
    expect(deps.atomicWrites).toEqual([]);
  });

  it.each([files.config, files.localConfig])('shows unknown values after a parse error in %s', async (file) => {
    const deps = make();
    deps.seed(`${HOME}/${file}`, 'schema: [');
    const result = await expectUnknown(deps);
    expect(result?.code).toBe(1);
  });

  it('shows the load error with quiet', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.localConfig}`, 'schema: [');
    const loaded = await loadConfig(deps, HOME, recipes);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    const result = await run(deps, ['--quiet']);
    expect(result.code).toBe(1);
    expect(result.out).toBe(`[FAIL] error: ${loaded.error.message}\n`);
  });

  it('gives the exact load error in JSON', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.localConfig}`, 'schema: [');
    const loaded = await loadConfig(deps, HOME, recipes);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    const result = await run(deps, ['--json']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toEqual({
      schema: schemaIds.guardList,
      home: HOME,
      error: loaded.error,
      guards: guardsFor(recipes[0]).map(unloadedOf),
      rows: guardRowsFor(recipes[0]),
      unmatched: [],
      loosened: [],
    });
  });

  it('shows an unknown off count when the config does not load', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.localConfig}`, 'schema: [');
    const result = await run(deps);
    expect(result.code).toBe(1);
    expect(linesOf(result.out).at(-1)).toBe('The off count is unknown for 29 guards. The off count with the mark H is unknown.');
  });

  it.each([
    ['the config does not parse', 'schema: ['],
    ['the config is not an object', '- sample\n'],
    ['the config has no recipe', 'schema: 2\n'],
    ['the recipe is not an object', 'schema: 2\nrecipe: plain\n'],
    ['the recipe id is not a string', 'schema: 2\nrecipe: {id: 42}\n'],
    ['the recipe id is unknown', 'schema: 2\nrecipe: {id: unknown-recipe}\n'],
  ])('uses the first recipe when %s', async (_name, config) => {
    const deps = make();
    deps.seed(`${HOME}/${files.config}`, config);
    const result = await run(deps, ['--all', '--json'], [publishRecipe, ...recipes]);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({
      guards: guardsFor(publishRecipe).map(unloadedOf),
      rows: guardRowsFor(publishRecipe),
    });
  });

  it('keeps the named recipe when the local config does not load', async () => {
    const deps = make(publishingConfig());
    deps.seed(`${HOME}/${files.localConfig}`, 'schema: [');
    const result = await run(deps, ['--json'], twoRecipeRegistry);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(publishRecipe).map(unloadedOf) });
  });

  it('keeps a named recipe when another shared config field is invalid', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.config}`, 'schema: 2\nnode: {id: demo, layer: 0}\nrecipe: {id: publishing, variant: plain, projects: []}\n');
    const result = await run(deps, ['--json'], twoRecipeRegistry);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(publishRecipe).map(unloadedOf) });
  });

  it('shows unknown values and exit 2 for a missing local config', async () => {
    const deps = make();
    deps.files.delete(`${HOME}/${files.localConfig}`);
    const result = await expectUnknown(deps);
    expect(result?.code).toBe(2);
  });

  it('shows unknown values and exit 1 for a config read failure', async () => {
    const deps = make();
    const read = deps.fs.readTextLimited;
    const broken = { ...deps, fs: { ...deps.fs, readTextLimited: (...args: Parameters<typeof read>) => args[0] === `${HOME}/${files.localConfig}` ? Promise.resolve(failure('cannot read local config')) : read(...args) } };
    const result = await expectUnknown(broken);
    expect(result?.code).toBe(1);
  });

  it.each(['link', 'other owner', 'writable mode'])('refuses a local config with %s and shows unknown values', async (fault) => {
    const path = `${HOME}/${files.localConfig}`;
    const deps = make(sampleConfig(), fault === 'link' ? { [path]: '/outside/config' } : {});
    if (fault === 'other owner') deps.owners.set(path, 2000);
    if (fault === 'writable mode') deps.modes.set(path, 0o666);
    const seen: string[] = [];
    const watched = withFsWatch(deps, (method, file) => { if (method.startsWith('read') || method === 'openChecked') seen.push(file); });
    const result = await expectUnknown(watched);
    expect(result?.code).toBe(4);
    expect(seen).not.toContain(path);
    expect(seen).not.toContain('/outside/config');
  });

  it('keeps the home registration check', async () => {
    const deps = make();
    deps.seed('/state/factory/homes.json', '{"schema":1,"homes":[]}');
    const result = await run(deps);
    expect(result.code).toBe(4);
    expect(result.out).toBe('');
  });

  it('shows hidden characters and line breaks in no table cell', async () => {
    const recipe = { ...publishRecipe, guards: [{ id: 'sample\n\u001b[31m‮', name: 'Sample', keepsSafe: 'Sample data stays private.', wired: false, fixed: false, newNode: 'on' as const, whenMissing: 'on' as const, related: [] }], guardRows: [{ id: 'sample-row\t\u001b', guard: 'sample\n\u001b[31m‮', name: 'Data\n\t\u001b‮stays private.', applies: 'Sample', kind: 'text' as const, harm: true, alwaysOn: false, sites: [] }] };
    const registry: RecipeRegistry = [recipe];
    const deps = make(publishingConfig());
    for (const flags of [['--all'], ['--family', recipe.guards[0]?.id ?? '', '--all']]) {
      const result = await run(deps, flags, registry);
      expect(result.code).toBe(0);
      expect(result.out).not.toMatch(/[\u001b‮\t]/);
      expect(result.out).toContain(flags.includes('--family') ? 'Data  stays private.' : 'sample [31m');
    }
  });
});

describe.each(FOLDER_ORIGINS)('guard list in %s', (_folder, origin) => {
  it('shows an off guard with a matching record as on when only the proof finds that the factory list names another node id', async () => {
    const deps = guardedNode({}, { origin, listed: OTHER_NODE_ID });
    const result = await run(withFirstConfigReadFault(deps), ['--home', GUARDED_HOME, '--json']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ guards: expect.arrayContaining([expect.objectContaining({ id: OFF_GUARD, value: 'on' })]) });
  });
});
