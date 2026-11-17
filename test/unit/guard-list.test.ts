import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import { loadConfig } from '../../src/config/load.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { guardRowsFor, guardsFor } from '../../src/guards/registry.js';
import { dirs, files, guardIds, guardListWords, schemaIds } from '../../src/names.js';
import { recipes, type RecipeRegistry } from '../../src/recipes/index.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { publishRecipe, publishRegistry, twoRecipeRegistry } from '../helpers/publish-recipe.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';

const HOME = '/w/node';
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

const expectUnknown = async (deps: FakeDeps, registry: RecipeRegistry = recipes) => {
  const loaded = await loadConfig(deps, HOME, registry);
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  const result = await run(deps, [], registry);
  expect(linesOf(result.out)[0]).toContain(loaded.error.message);
  expect(linesOf(result.out).slice(2, -2).map(cellsOf).every((cells) => cells[1] === 'unknown')).toBe(true);
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
    expect(lines.slice(1, -2).map((line) => rowCells(lines[0] ?? '', line))).toEqual(guards.slice(0, 17).map((guard) => [guard.id, 'on', guard.newNode, guard.harm ? 'H' : '', 'no key']));
    expect(lines.at(-2)).toBe('and 14 more: run with --all or --json');
    expect(lines.at(-1)).toBe('0 of 31 guards are off. 0 of them have the mark H.');
    expectShortOutput(result.out);
  });

  it('shows every guard with all, without a more line', async () => {
    const result = await run(make(), ['--all']);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(lines.slice(1, -1).map((line) => cellsOf(line)[0])).toEqual(guardsFor(recipes[0]).map((guard) => guard.id));
    expect(lines.at(-1)).toBe(guardListWords.countLine(0, guardsFor(recipes[0]).length, 0));
  });

  it('takes the guards and the count from the recipe of the config', async () => {
    const result = await run(make(publishingConfig()), ['--all'], twoRecipeRegistry);
    expect(result.code).toBe(0);
    expect(linesOf(result.out).slice(1, -1).map((line) => cellsOf(line)[0])).toEqual(guardsFor(publishRecipe).map((guard) => guard.id));
    expect(linesOf(result.out).at(-1)).toBe('0 of 28 guards are off. 0 of them have the mark H.');
  });

  it('gives every guard fact and every row fact in JSON without line numbers or text output', async () => {
    const result = await run(make(), ['--json']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toEqual({
      schema: schemaIds.guardList,
      home: HOME,
      guards: guardsFor(recipes[0]).map((guard) => ({ ...guard, value: 'on', source: 'missing', since: null })),
      rows: guardRowsFor(recipes[0]),
      unmatched: [],
      loosened: [],
    });
  });

  it('keeps the complete JSON with family and all flags', async () => {
    const result = await run(make(), ['--family', guardIds.boardEdits, '--all', '--json']);
    expect(result.code).toBe(0);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(recipes[0]).map((guard) => ({ id: guard.id })), rows: guardRowsFor(recipes[0]) });
  });

  it('shows the rows of a family with each row kind, harm mark and safe outcome', async () => {
    const result = await run(make(), ['--family', guardIds.boardEdits]);
    const rows = guardRowsFor(recipes[0]).filter((row) => row.guard === guardIds.boardEdits);
    const lines = linesOf(result.out);
    expect(result.code).toBe(0);
    expect(cellsOf(lines[0] ?? '')).toEqual(['ROW', 'KIND', 'H', 'KEEPS SAFE']);
    for (const [index, row] of rows.entries()) {
      expect(rowCells(lines[0] ?? '', lines[index + 1] ?? '')).toEqual([row.id, row.kind, row.harm ? 'H' : '', row.name]);
    }
    expect(lines).toHaveLength(rows.length + 1);
    expectShortOutput(result.out);
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

  it('uses the default recipe when the config does not name one', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.config}`, 'schema: [');
    const result = await run(deps, ['--all', '--json'], publishRegistry);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({
      guards: guardsFor(publishRecipe).map((guard) => ({ ...guard, value: 'unknown', source: 'missing', since: null })),
      rows: guardRowsFor(publishRecipe),
    });
  });

  it('keeps the named recipe when the local config does not load', async () => {
    const deps = make(publishingConfig());
    deps.seed(`${HOME}/${files.localConfig}`, 'schema: [');
    const result = await run(deps, ['--json'], twoRecipeRegistry);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(publishRecipe).map((guard) => ({ ...guard, value: 'unknown', source: 'missing', since: null })) });
  });

  it('keeps a named recipe when another shared config field is invalid', async () => {
    const deps = make();
    deps.seed(`${HOME}/${files.config}`, 'schema: 2\nnode: {id: demo, layer: 0}\nrecipe: {id: publishing, variant: plain, projects: []}\n');
    const result = await run(deps, ['--json'], twoRecipeRegistry);
    expect(result.code).toBe(1);
    const doc: unknown = JSON.parse(result.out);
    expect(doc).toMatchObject({ guards: guardsFor(publishRecipe).map((guard) => ({ ...guard, value: 'unknown', source: 'missing', since: null })) });
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
    const recipe = { ...publishRecipe, guards: [{ id: 'sample\n\u001b[31m‮', name: 'Sample', keepsSafe: 'Sample data stays private.', newNode: 'on' as const, whenMissing: 'on' as const, related: [] }], guardRows: [{ id: 'sample-row\t\u001b', guard: 'sample\n\u001b[31m‮', name: 'Data\n\t\u001b‮stays private.', applies: 'Sample', kind: 'text' as const, harm: true, sites: [] }] };
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
