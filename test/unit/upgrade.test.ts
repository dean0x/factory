import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inspectBlocks } from '../../src/blocks/status.js';
import { renderBlock } from '../../src/blocks/managed.js';
import { failure, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runInit } from '../../src/commands/init.js';
import { runUpgrade } from '../../src/commands/upgrade.js';
import { parseYamlText } from '../../src/config/load.js';
import { CONFIG_SCHEMA_VERSION, configSchema } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import type { Migration } from '../../src/migrate/runner.js';
import { jsonText } from '../../src/state/files.js';
import { parseJsonText } from '../../src/state/load.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { currentSpec, finisher, type UpgradeFile, type UpgradeSpec } from '../../src/upgrade/spec.js';
import type { BlockTemplate } from '../../src/templates/types.js';
import { layer1Blocks, layer2Blocks } from '../helpers/blocks.js';
import { createFakeDeps, exited, withFailingWrites, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { schema1Doc, schema1Paths, seedSchema1Node } from '../helpers/schema1.js';

/** The schema versions that this factory reads. A test migration starts from them. */
const C = CONFIG_SCHEMA_VERSION;
const S = STATE_SCHEMA_VERSION;

const HOME = '/w/node';
const CLAUDE = `${HOME}/CLAUDE.md`;
const WORKER = `${HOME}/.factory/roles/worker.md`;
const NODE_JSON = `${HOME}/.factory/node.json`;
const CONFIG = `${HOME}/factory.yaml`;
const BACKUP = `${HOME}/.factory/backups/2030-01-02T03-04-05-678Z`;
const COORDINATOR_LINE = 'Coordinate. Do not produce.';

interface Node {
  readonly deps: FakeDeps;
  /** The git command lines since the node was created. */
  readonly gitSince: () => string[];
}

const makeNode = async (
  options: { repo?: boolean; run?: (inner: RunHandler) => RunHandler } = {},
): Promise<Node> => {
  const { handler } = gitHandler();
  const deps = createFakeDeps({ cwd: '/w', env: { PATH: '/bin' }, run: options.run?.(handler) ?? handler });
  const init = await runInit(
    { ...deps, run: async (command, args, runOptions) => handler({ command, args, cwd: runOptions?.cwd }) },
    {
      home: HOME,
      name: 'demo',
      ownerName: 'Test Owner',
      ownerGithub: undefined,
      projects: [],
      yes: false,
      recipe: undefined,
      layer: undefined,
    },
  );
  expect(init.ok).toBe(true);
  if (options.repo !== false) deps.seedDir(`${HOME}/.factory/.git`);
  const first = deps.calls.length;
  return { deps, gitSince: () => deps.calls.slice(first).map((call) => call.args.slice(2).join(' ')) };
};

type UpgradeResult = Awaited<ReturnType<typeof runUpgrade>>;

const upgrade = (
  deps: FakeDeps,
  spec: UpgradeSpec = currentSpec,
  options: { dryRun?: boolean; overwrite?: readonly string[] } = {},
): Promise<UpgradeResult> => runUpgrade(deps, { home: HOME, dryRun: false, overwrite: [], ...options }, spec);

const success = (result: UpgradeResult): CommandOutput => {
  if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
};

const refusal = (result: UpgradeResult): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const text = (deps: FakeDeps, path: string): string => deps.files.get(path) ?? '';
const snapshot = (deps: FakeDeps): Map<string, string> => new Map(deps.files);
const lineTexts = (output: CommandOutput): string[] => output.lines.map((line) => line.text);

const edit = (deps: FakeDeps, path: string, from: string, to: string): void => {
  const before = text(deps, path);
  expect(before).toContain(from);
  deps.files.set(path, before.replace(from, to));
};

const versionOf = (name: string): number => layer1Blocks.find((template) => template.name === name)?.version ?? 0;

/** The templates of layer 1, with one block at its next version and a new text. */
const withBlock = (name: string, body: string): readonly BlockTemplate[] =>
  layer1Blocks.map((template) => (template.name === name ? { ...template, version: template.version + 1, body } : template));

/** The blocks that the spec gives for every config, whatever its layer. */
const fixedBlocks = (templates: readonly BlockTemplate[]): Pick<UpgradeSpec, 'blocksOf'> => ({
  blocksOf: () => ok({ templates, renames: [] }),
});

const blocksSpec = (templates: readonly BlockTemplate[]): UpgradeSpec => ({ ...currentSpec, ...fixedBlocks(templates) });

/** A migration that sets the version key and adds the fields in `extra`. */
const step = (key: string, from: number, extra: Record<string, unknown> = {}): Migration => ({
  from,
  to: from + 1,
  apply: (raw) => ok({ ...(raw as Record<string, unknown>), [key]: from + 1, ...extra }),
});

const brokenStep = (from: number): Migration => ({ from, to: from + 1, apply: () => failure('boom') });

const configAt = (target: number, migrations: readonly Migration[]): UpgradeFile => {
  const schema = z.looseObject({ schema: z.literal(target) });
  return {
    spec: { file: 'factory.yaml', key: 'schema', supported: target, schema },
    parse: parseYamlText,
    migrations,
    finish: finisher(schema, (value) => `${JSON.stringify(value)}\n`),
  };
};

const stateAt = (target: number, migrations: readonly Migration[]): UpgradeFile => {
  const schema = z.looseObject({ schema_version: z.literal(target), blocks: z.record(z.string(), z.number()) });
  return {
    spec: { file: '.factory/node.json', key: 'schema_version', supported: target, schema },
    parse: parseJsonText,
    migrations,
    finish: finisher(schema, jsonText),
  };
};

describe('upgrade: when nothing changes', () => {
  it('changes no file and runs no git command when all is current', async () => {
    const { deps, gitSince } = await makeNode();
    const before = snapshot(deps);
    const output = success(await upgrade(deps));
    expect(output.lines.at(-1)?.text).toBe('Nothing to upgrade.');
    expect(output.json).toMatchObject({
      schema: 'factory.upgrade/v1',
      home: HOME,
      changed: false,
      dryRun: false,
      backup: null,
      committed: false,
      config: { from: C, to: C },
      state: { from: S, to: S },
    });
    expect(output.failed).toBe(false);
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
  });

  it('skips a missing block with a warning, and does not create it', async () => {
    const { deps } = await makeNode();
    deps.files.delete(WORKER);
    const output = success(await upgrade(deps));
    expect(output.warnings).toEqual(['block worker is missing. Use --overwrite worker to add it.']);
    expect(output.json).toMatchObject({ changed: false });
    expect(deps.files.has(WORKER)).toBe(false);
  });
});

describe('upgrade: managed blocks', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));

  it('shows the plan in a dry run and changes no file', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const output = success(await upgrade(deps, newer, { dryRun: true }));
    expect(lineTexts(output)).toEqual(
      expect.arrayContaining([
        `factory.yaml: schema ${C} is current`,
        `.factory/node.json: schema_version ${S} is current`,
        `block coordinator: version ${versionOf('coordinator')} to ${versionOf('coordinator') + 1}`,
        `block safety: version ${versionOf('safety')} is current`,
        'Dry run: no file was changed.',
      ]),
    );
    expect(output.json).toMatchObject({ changed: true, dryRun: true, backup: null });
    expect(snapshot(deps)).toEqual(before);
  });

  it('replaces an intact older block, keeps the text of the owner, and records the version', async () => {
    const { deps, gitSince } = await makeNode();
    const original = text(deps, CLAUDE);
    deps.files.set(CLAUDE, `My own rules.\n\n${original}\nMore of my rules.\n`);

    const output = success(await upgrade(deps, newer));

    const claude = text(deps, CLAUDE);
    expect(claude.startsWith('My own rules.\n')).toBe(true);
    expect(claude.endsWith('\nMore of my rules.\n')).toBe(true);
    expect(claude).toContain(`<!-- factory:begin coordinator v${versionOf('coordinator') + 1} sha256=`);
    expect(claude).toContain('New coordinator text.');
    expect(claude).not.toContain(COORDINATOR_LINE);
    expect(claude).toContain(`<!-- factory:begin safety v${versionOf('safety')} sha256=`);
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toMatchObject({
      blocks: { coordinator: versionOf('coordinator') + 1, safety: versionOf('safety'), worker: versionOf('worker') },
    });
    expect(output.lines.at(-1)?.text).toBe('Changed 2 files. The backup is in .factory/backups/2030-01-02T03-04-05-678Z.');
    expect(output.json).toMatchObject({ changed: true, committed: true, backup: '.factory/backups/2030-01-02T03-04-05-678Z' });
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A']));
    expect(gitSince().some((command) => command.endsWith('chore: upgrade the state'))).toBe(true);

    const statuses = await inspectBlocks(deps, HOME, withBlock('coordinator', 'New coordinator text.'));
    expect(statuses.map((status) => status.kind)).toEqual(['intact', 'intact', 'intact']);
  });

  it('copies the config, CLAUDE.md and the state folder into the backup first, and not the old backups', async () => {
    const { deps } = await makeNode();
    const original = { claude: text(deps, CLAUDE), config: text(deps, CONFIG), node: text(deps, NODE_JSON) };
    deps.seed(`${HOME}/.factory/backups/older/factory.yaml`, 'old backup');
    success(await upgrade(deps, newer));
    expect(text(deps, `${BACKUP}/CLAUDE.md`)).toBe(original.claude);
    expect(text(deps, `${BACKUP}/factory.yaml`)).toBe(original.config);
    expect(text(deps, `${BACKUP}/.factory/node.json`)).toBe(original.node);
    expect([...deps.files.keys()].some((path) => path.startsWith(`${BACKUP}/.factory/backups`))).toBe(false);
  });

  it('leaves the run-time folders out of the backup, because upgrade never writes into them', async () => {
    const { deps } = await makeNode();
    deps.seed(`${HOME}/.factory/state/run.json`, '{}');
    deps.seed(`${HOME}/.factory/locks/cell.lock`, '1');
    success(await upgrade(deps, newer));
    const saved = [...deps.files.keys()].filter((path) => path.startsWith(`${BACKUP}/`));
    expect(saved).toContain(`${BACKUP}/.factory/node.json`);
    expect(saved.some((path) => path.startsWith(`${BACKUP}/.factory/state/`))).toBe(false);
    expect(saved.some((path) => path.startsWith(`${BACKUP}/.factory/locks/`))).toBe(false);
    expect(text(deps, `${HOME}/.factory/state/run.json`)).toBe('{}');
    expect(text(deps, `${HOME}/.factory/locks/cell.lock`)).toBe('1');
  });

  it('updates a block in the worker file', async () => {
    const { deps } = await makeNode();
    success(await upgrade(deps, blocksSpec(withBlock('worker', 'New worker text.'))));
    expect(text(deps, WORKER)).toContain(`<!-- factory:begin worker v${versionOf('worker') + 1} sha256=`);
    expect(text(deps, WORKER)).toContain('New worker text.');
  });

  it('refuses an edited block with a short diff, and changes nothing', async () => {
    const { deps, gitSince } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('block coordinator was edited');
    expect(error.message).toMatch(/^    file:     - Do as you like\. /m);
    expect(error.message).toMatch(/^    template: - Coordinate\. Do not produce\. /m);
    expect(error.hint).toContain('--overwrite coordinator');
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince()).toEqual([]);
  });

  it('refuses an edited block in a dry run too', async () => {
    const { deps } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    expect(refusal(await upgrade(deps, currentSpec, { dryRun: true })).kind).toBe('safety');
  });

  it('replaces an edited block when it is named, and does not commit a CLAUDE.md-only change', async () => {
    const { deps, gitSince } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const output = success(await upgrade(deps, currentSpec, { overwrite: ['coordinator'] }));
    expect(text(deps, CLAUDE)).toContain(COORDINATOR_LINE);
    expect(text(deps, CLAUDE)).not.toContain('Do as you like.');
    expect(output.lines.at(-1)?.text).toMatch(/^Changed 1 file\./);
    expect(output.json).toMatchObject({ committed: false });
    expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
    expect((await inspectBlocks(deps, HOME, layer1Blocks)).every((status) => status.kind === 'intact')).toBe(true);
  });

  it('still refuses another edited block that is not named', async () => {
    const { deps } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const claude = text(deps, CLAUDE);
    const safetyLine = claude.split('\n').find((line) => line.length > 20 && !line.startsWith('<!--') && !line.startsWith('Do as') && !line.startsWith('#')) ?? '';
    expect(safetyLine).not.toBe('');
    const safetyStart = claude.indexOf('<!-- factory:begin safety');
    deps.files.set(CLAUDE, `${claude.slice(0, safetyStart)}${claude.slice(safetyStart).replace(/\n([^<\n][^\n]*)\n/, '\nEdited safety line.\n')}`);
    const error = refusal(await upgrade(deps, currentSpec, { overwrite: ['coordinator'] }));
    expect(error.message).toContain('block safety was edited');
    expect(error.message).not.toContain('block coordinator was edited');
  });

  it('adds a missing block at the end of the file when it is named', async () => {
    const { deps } = await makeNode();
    const claude = text(deps, CLAUDE);
    const safetyStart = claude.indexOf('<!-- factory:begin safety');
    deps.files.set(CLAUDE, `Owner text.\n\n${claude.slice(0, safetyStart).trimEnd()}\n`);
    const output = success(await upgrade(deps, currentSpec, { overwrite: ['safety'] }));
    const after = text(deps, CLAUDE);
    expect(after.startsWith('Owner text.\n')).toBe(true);
    expect(after.trimEnd().endsWith('<!-- factory:end safety -->')).toBe(true);
    expect(lineTexts(output)).toContain(`block safety: add version ${versionOf('safety')}`);
  });

  it('creates a missing worker file when the block is named', async () => {
    const { deps } = await makeNode();
    deps.files.delete(WORKER);
    const output = success(await upgrade(deps, currentSpec, { overwrite: ['worker'] }));
    expect(text(deps, WORKER)).toContain(`<!-- factory:begin worker v${versionOf('worker')} sha256=`);
    expect(output.json).toMatchObject({ committed: true });
  });

  it('rejects the name of a block that does not exist', async () => {
    const { deps } = await makeNode();
    const error = refusal(await upgrade(deps, currentSpec, { overwrite: ['nope'] }));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain('unknown block nope');
    expect(error.hint).toBe('The blocks are: coordinator, safety, worker.');
  });

  it('fails when a block has a newer version than the template', async () => {
    const { deps } = await makeNode();
    const rendered = renderBlock({ name: 'coordinator', version: versionOf('coordinator') + 2, body: 'From the future.' });
    expect(rendered.ok).toBe(true);
    const claude = text(deps, CLAUDE);
    const start = claude.indexOf('<!-- factory:begin coordinator');
    const end = claude.indexOf('<!-- factory:end coordinator -->') + '<!-- factory:end coordinator -->'.length;
    deps.files.set(CLAUDE, `${claude.slice(0, start)}${rendered.ok ? rendered.value : ''}${claude.slice(end)}`);
    const error = refusal(await upgrade(deps, newer));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(`block coordinator has version ${versionOf('coordinator') + 2}`);
    expect(error.message).toContain('Upgrade factory.');
  });

  it('fails when the markers of a file are broken, and names the file', async () => {
    const { deps } = await makeNode();
    deps.files.set(CLAUDE, '<!-- factory:begin coordinator v1 sha256=zz -->\n');
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('CLAUDE.md');
  });
});

describe('upgrade: migrations', () => {
  it('runs a chain of two steps, writes the config and keeps the other keys', async () => {
    const { deps, gitSince } = await makeNode();
    const original = text(deps, CONFIG);
    const spec: UpgradeSpec = {
      ...currentSpec,
      config: configAt(C + 2, [step('schema', C, { two: true }), step('schema', C + 1, { three: true })]),
    };
    const output = success(await upgrade(deps, spec));
    const written = parseJsonText(text(deps, CONFIG));
    expect(written.ok && written.value).toMatchObject({ schema: C + 2, two: true, three: true, node: { id: 'demo' } });
    expect(lineTexts(output)).toContain(`factory.yaml: schema ${C} to ${C + 2} (2 steps)`);
    expect(output.json).toMatchObject({ config: { from: C, to: C + 2 }, committed: false });
    expect(text(deps, `${BACKUP}/factory.yaml`)).toBe(original);
    expect(gitSince()).toEqual([]);
  });

  it('migrates the state and records the new block versions in one file', async () => {
    const { deps } = await makeNode();
    const spec: UpgradeSpec = {
      config: currentSpec.config,
      state: stateAt(S + 1, [step('schema_version', S, { note: 'x' })]),
      files: currentSpec.files,
      ...fixedBlocks(withBlock('safety', 'New safety text.')),
    };
    const output = success(await upgrade(deps, spec));
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toMatchObject({
      schema_version: S + 1,
      note: 'x',
      blocks: { coordinator: versionOf('coordinator'), safety: versionOf('safety') + 1, worker: versionOf('worker') },
    });
    expect(output.json).toMatchObject({ committed: true, state: { from: S, to: S + 1 } });
  });

  it('writes the config last', async () => {
    const { deps } = await makeNode();
    const first = deps.atomicWrites.length;
    const spec: UpgradeSpec = {
      config: configAt(C + 1, [step('schema', C)]),
      state: stateAt(S + 1, [step('schema_version', S)]),
      files: currentSpec.files,
      ...fixedBlocks(withBlock('coordinator', 'New coordinator text.')),
    };
    success(await upgrade(deps, spec));
    expect(deps.atomicWrites.slice(first)).toEqual([CLAUDE, NODE_JSON, CONFIG]);
  });

  it('fails on a gap in the chain, before it makes a backup', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 2, [step('schema', C)]) };
    const error = refusal(await upgrade(deps, spec));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe(`factory.yaml: no migration from version ${C + 1}`);
    expect(snapshot(deps)).toEqual(before);
  });

  it('stops at a failing step of the config, in the plan, before it makes a backup', async () => {
    const { deps, gitSince } = await makeNode();
    const before = snapshot(deps);
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 2, [step('schema', C), brokenStep(C + 1)]) };
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, spec, { dryRun }));
      expect(error.kind).toBe('failure');
      expect(error.message).toBe(`factory.yaml: migration from version ${C + 1} to ${C + 2} failed: boom`);
    }
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince()).toEqual([]);
  });

  it('stops at a failing step of the state, changes no file and keeps the backup', async () => {
    const { deps, gitSince } = await makeNode();
    const original = text(deps, NODE_JSON);
    const spec: UpgradeSpec = { ...currentSpec, state: stateAt(S + 2, [step('schema_version', S), brokenStep(S + 1)]) };
    const error = refusal(await upgrade(deps, spec));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(`.factory/node.json: migration from version ${S + 1} to ${S + 2} failed: boom`);
    expect(error.message).toContain('The files are as they were.');
    expect(error.message).toContain('.factory/backups/2030-01-02T03-04-05-678Z');
    expect(text(deps, NODE_JSON)).toBe(original);
    expect(text(deps, `${BACKUP}/.factory/node.json`)).toBe(original);
    expect(gitSince().some((command) => command.includes('commit'))).toBe(false);
  });

  it('fails when the migrated value does not pass the schema, and names the key', async () => {
    const { deps } = await makeNode();
    const original = text(deps, CONFIG);
    const sloppy: Migration = { from: C + 1, to: C + 2, apply: (raw) => ok(raw) };
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 2, [step('schema', C), sloppy]) };
    const error = refusal(await upgrade(deps, spec));
    expect(error.message).toContain('factory.yaml: schema:');
    expect(text(deps, CONFIG)).toBe(original);
  });

  it('fails for a file that is newer than this factory', async () => {
    const { deps } = await makeNode();
    deps.files.set(CONFIG, 'schema: 9\n');
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('Upgrade factory.');
    expect(text(deps, CONFIG)).toBe('schema: 9\n');
  });
});

describe('upgrade: the blocks of a layer', () => {
  /** The owner changes the layer by hand. */
  const setLayer = (deps: FakeDeps, layer: number): void => {
    const before = text(deps, CONFIG);
    expect(before).toContain('layer: 1');
    deps.files.set(CONFIG, before.replace('layer: 1', `layer: ${layer}`));
  };

  const blocksOfState = (deps: FakeDeps): unknown => {
    const state = parseJsonText(text(deps, NODE_JSON));
    return state.ok ? (state.value as { blocks: unknown }).blocks : undefined;
  };

  it('keeps the coordinator, safety and worker blocks of layer 1', async () => {
    const { deps } = await makeNode();
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(lineTexts(output).filter((line) => line.startsWith('block '))).toEqual([
      `block coordinator: version ${versionOf('coordinator')} is current`,
      `block safety: version ${versionOf('safety')} is current`,
      `block worker: version ${versionOf('worker')} is current`,
    ]);
  });

  it('swaps an intact coordinator block for the manager block when the layer is 2, and keeps the owner text', async () => {
    const { deps, gitSince } = await makeNode();
    deps.files.set(CLAUDE, `My own rules.\n\n${text(deps, CLAUDE)}`);
    setLayer(deps, 2);

    const output = success(await upgrade(deps));

    const claude = text(deps, CLAUDE);
    expect(claude.startsWith('My own rules.\n')).toBe(true);
    expect(claude).toContain('<!-- factory:begin manager v1 sha256=');
    expect(claude).not.toContain('factory:begin coordinator');
    expect(claude).toContain(`<!-- factory:begin safety v${versionOf('safety')} sha256=`);
    expect(lineTexts(output)).toContain('block coordinator: becomes block manager, version 1');
    expect(blocksOfState(deps)).toEqual({ manager: 1, safety: versionOf('safety'), worker: versionOf('worker') });
    expect(output.json).toMatchObject({ committed: true });
    expect(gitSince().some((command) => command.endsWith('chore: upgrade the state'))).toBe(true);
    expect((await inspectBlocks(deps, HOME, layer2Blocks)).map((status) => status.kind)).toEqual(['intact', 'intact']);
  });

  it('lists the safety block only when the layer is 3, which has no role template', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 3);
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(lineTexts(output).filter((line) => line.startsWith('block '))).toEqual([
      `block safety: version ${versionOf('safety')} is current`,
    ]);
  });

  it('swaps an intact manager block for the coordinator block when the layer is 1', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 2);
    success(await upgrade(deps));
    // The fake clock stands still, so the second backup needs a free folder name.
    await deps.fs.remove(`${HOME}/.factory/backups`);
    deps.files.set(CONFIG, text(deps, CONFIG).replace('layer: 2', 'layer: 1'));
    const output = success(await upgrade(deps));
    expect(text(deps, CLAUDE)).toContain(`<!-- factory:begin coordinator v${versionOf('coordinator')} sha256=`);
    expect(text(deps, CLAUDE)).not.toContain('factory:begin manager');
    expect(lineTexts(output)).toContain(`block manager: becomes block coordinator, version ${versionOf('coordinator')}`);
    expect(blocksOfState(deps)).toEqual({
      coordinator: versionOf('coordinator'),
      safety: versionOf('safety'),
      worker: versionOf('worker'),
    });
  });

  it('shows the swap in a dry run and changes no file', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 2);
    const before = snapshot(deps);
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(lineTexts(output)).toContain('block coordinator: becomes block manager, version 1');
    expect(snapshot(deps)).toEqual(before);
  });

  it('refuses an edited coordinator block on layer 2, and replaces it with the manager block when it is named', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 2);
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const before = snapshot(deps);

    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('block coordinator was edited');
    expect(error.hint).toContain('--overwrite coordinator');
    expect(snapshot(deps)).toEqual(before);

    success(await upgrade(deps, currentSpec, { overwrite: ['manager'] }));
    expect(text(deps, CLAUDE)).toContain('factory:begin manager v1');
    expect(text(deps, CLAUDE)).not.toContain('Do as you like.');
    expect(blocksOfState(deps)).toMatchObject({ manager: 1 });
    expect(blocksOfState(deps)).not.toHaveProperty('coordinator');
  });

  it('knows the blocks of the layer: it rejects the worker block on layer 2 and lists the others', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 2);
    const error = refusal(await upgrade(deps, currentSpec, { overwrite: ['worker'] }));
    expect(error.kind).toBe('usage');
    expect(error.hint).toBe('The blocks are: manager, safety.');
  });

  it('fails and names the key when the layer of the config is not valid', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 99);
    const error = refusal(await upgrade(deps));
    expect(error.message).toContain('factory.yaml is invalid');
    expect(error.message).toContain('node.layer');
  });

  it('fails in the plan, before a backup, when a migration leaves a layer that no node has', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const spec: UpgradeSpec = {
      ...currentSpec,
      config: configAt(C + 1, [step('schema', C, { node: { id: 'demo', layer: 0 } })]),
    };
    const error = refusal(await upgrade(deps, spec));
    expect(error.message).toMatch(/^factory\.yaml: .*node\.layer/);
    expect(snapshot(deps)).toEqual(before);
  });
});

describe('upgrade: when a step fails after the backup', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));

  it('puts back every file that it wrote when a write fails', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const failing = withFailingWrites(deps, (path, attempt) => path === NODE_JSON && attempt === 1);
    const error = refusal(await upgrade(failing, newer));
    expect(error.message).toContain('disk full');
    expect(error.message).toContain('The files are as they were.');
    for (const [path, body] of before) expect(text(deps, path)).toBe(body);
    expect(text(deps, `${BACKUP}/CLAUDE.md`)).toBe(before.get(CLAUDE));
  });

  it('puts back every file and clears the index when the commit fails', async () => {
    const { deps, gitSince } = await makeNode({
      run: (inner) => (call) => (call.args.includes('commit') ? exited(1) : inner(call)),
    });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps, newer));
    expect(error.message).toContain('cannot commit the state files');
    expect(text(deps, CLAUDE)).toBe(before.get(CLAUDE));
    expect(text(deps, NODE_JSON)).toBe(before.get(NODE_JSON));
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A', 'reset -q']));
  });

  it('writes each changed file and puts it back with the atomic write', async () => {
    const { deps } = await makeNode({
      run: (inner) => (call) => (call.args.includes('commit') ? exited(1) : inner(call)),
    });
    const first = deps.atomicWrites.length;
    refusal(await upgrade(deps, newer));
    expect(deps.atomicWrites.slice(first)).toEqual([CLAUDE, NODE_JSON, NODE_JSON, CLAUDE]);
  });

  it('names the number of files and the backup folder when a file cannot be put back', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const failing = withFailingWrites(
      deps,
      (path, attempt) => (path === NODE_JSON && attempt === 1) || (path === CLAUDE && attempt === 2),
    );
    const error = refusal(await upgrade(failing, newer));
    expect(error.message).toContain('disk full');
    expect(error.message).not.toContain('The files are as they were');
    expect(error.message).toContain('1 file could not be restored');
    expect(error.message).toContain(`cannot write ${CLAUDE}`);
    expect(error.message).toContain('Restore it from .factory/backups/2030-01-02T03-04-05-678Z');
    expect(text(deps, NODE_JSON)).toBe(before.get(NODE_JSON));
    expect(text(deps, CLAUDE)).not.toBe(before.get(CLAUDE));
    expect(text(deps, `${BACKUP}/CLAUDE.md`)).toBe(before.get(CLAUDE));
  });

  it('says that the files could not be put back when two files fail', async () => {
    const { deps } = await makeNode();
    const failing = withFailingWrites(
      deps,
      (path, attempt) => (path === NODE_JSON && attempt >= 1) || (path === CLAUDE && attempt === 2),
    );
    const error = refusal(await upgrade(failing, newer));
    expect(error.message).toContain('2 files could not be restored');
    expect(error.message).toContain('Restore them from .factory/backups/');
  });

  it('does not say that the files are as they were when the index cannot be cleared', async () => {
    const { deps, gitSince } = await makeNode({
      run: (inner) => (call) => (call.args.includes('commit') || call.args.includes('reset') ? exited(1) : inner(call)),
    });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps, newer));
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A', 'reset -q']));
    expect(error.message).toContain('cannot commit the state files');
    expect(error.message).not.toContain('The files are as they were');
    expect(error.message).toContain('cannot clear the staged files');
    expect(error.message).toContain('git reset');
    expect(text(deps, CLAUDE)).toBe(before.get(CLAUDE));
  });

  it('removes a file that it created when it restores', async () => {
    const { deps } = await makeNode({
      run: (inner) => (call) => (call.args.includes('commit') ? exited(1) : inner(call)),
    });
    deps.files.delete(WORKER);
    refusal(await upgrade(deps, currentSpec, { overwrite: ['worker'] }));
    expect(deps.files.has(WORKER)).toBe(false);
  });
});

describe('upgrade: the number of backups', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));
  const BACKUPS = `${HOME}/.factory/backups`;
  const stamp = (day: number): string => `2029-01-${String(day).padStart(2, '0')}T00-00-00-000Z`;
  const kept = (deps: FakeDeps): string[] => {
    const names = new Set<string>();
    for (const path of deps.files.keys()) {
      if (path.startsWith(`${BACKUPS}/`)) names.add(path.slice(BACKUPS.length + 1).split('/')[0] ?? '');
    }
    return [...names].sort();
  };
  const seedBackups = (deps: FakeDeps, days: number): void => {
    for (let day = 1; day <= days; day += 1) deps.seed(`${BACKUPS}/${stamp(day)}/factory.yaml`, 'old backup');
  };

  it('keeps the last 5 backups and removes the older ones after a successful upgrade', async () => {
    const { deps } = await makeNode();
    seedBackups(deps, 7);
    success(await upgrade(deps, newer));
    expect(kept(deps)).toEqual([stamp(4), stamp(5), stamp(6), stamp(7), '2030-01-02T03-04-05-678Z']);
  });

  it('keeps the folders that are not backups of this tool', async () => {
    const { deps } = await makeNode();
    seedBackups(deps, 7);
    deps.seed(`${BACKUPS}/my-notes/readme.txt`, 'mine');
    success(await upgrade(deps, newer));
    expect(text(deps, `${BACKUPS}/my-notes/readme.txt`)).toBe('mine');
  });

  it('keeps every older backup when the upgrade fails', async () => {
    const { deps } = await makeNode({
      run: (inner) => (call) => (call.args.includes('commit') ? exited(1) : inner(call)),
    });
    seedBackups(deps, 7);
    refusal(await upgrade(deps, newer));
    expect(kept(deps)).toHaveLength(8);
  });

  it('removes no backup when nothing changes', async () => {
    const { deps } = await makeNode();
    seedBackups(deps, 7);
    success(await upgrade(deps));
    expect(kept(deps)).toHaveLength(7);
  });

  it('succeeds with a warning when an old backup cannot be removed', async () => {
    const { deps } = await makeNode();
    seedBackups(deps, 7);
    const stuck: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        remove: async (path) => (path === `${BACKUPS}/${stamp(1)}` ? failure(`cannot remove ${path}: EBUSY`) : deps.fs.remove(path)),
      },
    };
    const output = success(await upgrade(stuck, newer));
    expect(output.warnings.join('\n')).toContain(`cannot remove ${BACKUPS}/${stamp(1)}: EBUSY`);
    expect(kept(deps)).toEqual([stamp(1), stamp(4), stamp(5), stamp(6), stamp(7), '2030-01-02T03-04-05-678Z']);
  });
});

describe('upgrade: before it changes anything', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));

  it('needs a git repository in the state folder', async () => {
    const { deps } = await makeNode({ repo: false });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps, newer));
    expect(error.message).toBe('.factory is not a git repository');
    expect(snapshot(deps)).toEqual(before);
  });

  it('needs a git identity', async () => {
    const { deps } = await makeNode({ run: (inner) => (call) => (call.args.includes('config') ? exited(1) : inner(call)) });
    const before = snapshot(deps);
    expect(refusal(await upgrade(deps, newer)).message).toBe('git has no user.name and user.email');
    expect(snapshot(deps)).toEqual(before);
  });

  it('does not need the repository for a change of the config only', async () => {
    const { deps } = await makeNode({ repo: false });
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 1, [step('schema', C)]) };
    expect(success(await upgrade(deps, spec)).json).toMatchObject({ changed: true, committed: false });
  });

  it('fails when the state file is missing, invalid or unreadable', async () => {
    const { deps } = await makeNode();
    deps.files.delete(NODE_JSON);
    expect(refusal(await upgrade(deps)).message).toBe('.factory/node.json not found');
    deps.files.set(NODE_JSON, '{');
    expect(refusal(await upgrade(deps)).message).toContain('does not parse');
    deps.files.set(NODE_JSON, JSON.stringify({ schema_version: S }));
    expect(refusal(await upgrade(deps)).message).toContain('is invalid');
  });

  it('finds the node from the current folder, and fails when there is none', async () => {
    const { deps } = await makeNode();
    const inside = createFakeDeps({ cwd: `${HOME}/deep` });
    for (const [path, body] of deps.files) inside.seed(path, body);
    inside.seedDir(`${HOME}/deep`);
    expect(success(await runUpgrade(inside, { home: undefined, dryRun: false, overwrite: [] }, currentSpec)).json).toMatchObject({
      home: HOME,
    });
    const none = await runUpgrade(createFakeDeps({ cwd: '/empty' }), { home: undefined, dryRun: false, overwrite: [] }, currentSpec);
    expect(refusal(none).hint).toContain('--home DIR');
  });
});

describe('upgrade: a node of schema 1', () => {
  const OLD = schema1Paths(HOME);
  const ROLES = `${HOME}/.factory/roles`;
  const ORDERS_KEEP = `${HOME}/.factory/orders/.gitkeep`;
  const BACKUPS_DIR = `${HOME}/.factory/backups/`;
  const workerBody = layer1Blocks.find((template) => template.name === 'worker')?.body ?? '';
  const workerLine = workerBody.split('\n').find((line) => line.length > 20 && !line.startsWith('#')) ?? '';

  const makeOldNode = (
    options: { run?: (inner: RunHandler) => RunHandler; doc?: Record<string, any> } = {},
  ): Node => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({ cwd: '/w', env: { PATH: '/bin' }, run: options.run?.(handler) ?? handler });
    seedSchema1Node(deps, HOME, options.doc);
    const first = deps.calls.length;
    return { deps, gitSince: () => deps.calls.slice(first).map((call) => call.args.slice(2).join(' ')) };
  };

  /** The files of the node, without the backups. */
  const live = (deps: FakeDeps): Map<string, string> =>
    new Map([...deps.files].filter(([path]) => !path.startsWith(BACKUPS_DIR)));

  it('has a worker line to edit', () => {
    expect(workerLine).not.toBe('');
  });

  it('shows the moves and the renamed block in a dry run, and changes no file', async () => {
    const { deps } = makeOldNode();
    const before = snapshot(deps);
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(lineTexts(output)).toEqual(
      expect.arrayContaining([
        `factory.yaml: schema 1 to ${C} (1 step)`,
        `.factory/node.json: schema_version 1 to ${S} (1 step)`,
        'move .factory/protocol.md to .factory/roles/worker.md',
        'move .factory/briefs to .factory/orders',
        `block protocol: becomes block worker, version ${versionOf('worker')}`,
        `block coordinator: version 1 to ${versionOf('coordinator')}`,
        `block safety: version 1 to ${versionOf('safety')}`,
        'Dry run: no file was changed.',
      ]),
    );
    expect(output.json).toMatchObject({
      changed: true,
      dryRun: true,
      moves: [
        { from: '.factory/protocol.md', to: '.factory/roles/worker.md' },
        { from: '.factory/briefs', to: '.factory/orders' },
      ],
    });
    expect(snapshot(deps)).toEqual(before);
  });

  it('moves the files, migrates the config and the state, renames the block, and commits once', async () => {
    const { deps, gitSince } = makeOldNode();
    const output = success(await upgrade(deps));

    expect(deps.files.has(OLD.protocol)).toBe(false);
    expect(deps.files.has(OLD.briefsKeep)).toBe(false);
    expect(deps.files.has(ORDERS_KEEP)).toBe(true);
    const worker = text(deps, WORKER);
    expect(worker).toContain(`<!-- factory:begin worker v${versionOf('worker')} sha256=`);
    expect(worker).not.toContain('factory:begin protocol');
    expect((await inspectBlocks(deps, HOME, layer1Blocks)).map((status) => status.kind)).toEqual([
      'intact',
      'intact',
      'intact',
    ]);

    const config = parseYamlText(text(deps, CONFIG));
    expect(config.ok && configSchema.safeParse(config.value).success).toBe(true);
    expect(config.ok && config.value).toMatchObject({
      schema: C,
      node: { id: 'demo', layer: 1 },
      tracker: { kind: 'local' },
      approval: { land: 'each' },
      parent: null,
      recipe: { id: 'software', variant: 'plain' },
    });
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toEqual({
      schema_version: S,
      created_with: '0.1.0',
      blocks: { coordinator: versionOf('coordinator'), safety: versionOf('safety'), worker: versionOf('worker') },
    });

    expect(output.lines.at(-1)?.text).toBe('Changed 6 files. The backup is in .factory/backups/2030-01-02T03-04-05-678Z.');
    expect(output.json).toMatchObject({ committed: true, config: { from: 1, to: C }, state: { from: 1, to: S } });
    expect(gitSince().filter((command) => command === 'add -A')).toHaveLength(1);
    expect(gitSince().some((command) => command.endsWith('chore: upgrade the state'))).toBe(true);
    expect(text(deps, `${BACKUP}/.factory/protocol.md`)).toContain('factory:begin protocol');
    expect(deps.files.has(`${BACKUP}/.factory/briefs/.gitkeep`)).toBe(true);
  });

  it('has nothing to upgrade the second time', async () => {
    const { deps } = makeOldNode();
    success(await upgrade(deps));
    const before = snapshot(deps);
    expect(success(await upgrade(deps)).lines.at(-1)?.text).toBe('Nothing to upgrade.');
    expect(snapshot(deps)).toEqual(before);
  });

  it('refuses the edited protocol block with the old name in the hint, and changes nothing', async () => {
    const { deps, gitSince } = makeOldNode();
    edit(deps, OLD.protocol, workerLine, 'My own rule for the workers.');
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('block protocol was edited');
    expect(error.hint).toContain('--overwrite protocol');
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
    expect(refusal(await upgrade(deps, currentSpec, { dryRun: true })).kind).toBe('safety');
  });

  it.each(['protocol', 'worker'])('replaces the edited protocol block when %s is named', async (name) => {
    const { deps } = makeOldNode();
    edit(deps, OLD.protocol, workerLine, 'My own rule for the workers.');
    success(await upgrade(deps, currentSpec, { overwrite: [name] }));
    expect(text(deps, WORKER)).toContain(workerLine);
    expect(text(deps, WORKER)).not.toContain('My own rule for the workers.');
    expect(deps.files.has(OLD.protocol)).toBe(false);
    expect((await inspectBlocks(deps, HOME, layer1Blocks)).every((status) => status.kind === 'intact')).toBe(true);
  });

  it('keeps the text around the protocol block', async () => {
    const { deps } = makeOldNode();
    deps.files.set(OLD.protocol, `My notes.\n\n${text(deps, OLD.protocol)}\nMore notes.\n`);
    success(await upgrade(deps));
    expect(text(deps, WORKER).startsWith('My notes.\n')).toBe(true);
    expect(text(deps, WORKER).endsWith('\nMore notes.\n')).toBe(true);
  });

  it.each([
    ['the worker file', `${ROLES}/worker.md`, '.factory/protocol.md to .factory/roles/worker.md'],
    ['the orders folder', `${HOME}/.factory/orders/note.md`, '.factory/briefs to .factory/orders'],
  ])('refuses a move onto %s that exists, and changes nothing', async (_label, target, moveText) => {
    const { deps } = makeOldNode();
    deps.seed(target, 'mine');
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe(`cannot move ${moveText}: the target exists`);
    expect(snapshot(deps)).toEqual(before);
    expect(refusal(await upgrade(deps, currentSpec, { dryRun: true })).message).toContain('the target exists');
  });

  it('skips a move whose source is missing, and warns about the missing block', async () => {
    const { deps } = makeOldNode();
    deps.files.delete(OLD.protocol);
    const output = success(await upgrade(deps));
    expect(deps.files.has(WORKER)).toBe(false);
    expect(deps.files.has(ORDERS_KEEP)).toBe(true);
    expect(output.warnings).toEqual(['block worker is missing. Use --overwrite worker to add it.']);
    expect(output.json).toMatchObject({ moves: [{ from: '.factory/briefs', to: '.factory/orders' }] });
  });

  it('stops on a child with an address that is not a file address, and moves nothing', async () => {
    const doc = schema1Doc();
    doc.children = [{ id: 'team-a', address: 'ssh://deploy:SECRET-TOKEN@host/work' }];
    const { deps } = makeOldNode({ doc });
    const before = live(deps);
    const error = refusal(await upgrade(deps));
    expect(error.message).toContain('factory.yaml: migration from version 1 to 2 failed');
    expect(error.message).toContain('children[0] "team-a"');
    expect(error.message).not.toContain('SECRET-TOKEN');
    expect(live(deps)).toEqual(before);
  });

  it('restores the moved files and the written files when a write fails in the middle', async () => {
    const { deps, gitSince } = makeOldNode();
    const before = live(deps);
    const failing = withFailingWrites(deps, (path, attempt) => path === CONFIG && attempt === 1);
    const error = refusal(await upgrade(failing));
    expect(error.message).toContain('The files are as they were.');
    expect(live(deps)).toEqual(before);
    expect(deps.dirs.has(ROLES)).toBe(false);
    expect(gitSince()).toContain('reset -q');
  });

  it('puts the first move back when the second move fails', async () => {
    const { deps } = makeOldNode();
    const before = live(deps);
    const stuck: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        rename: async (from, to) =>
          from.endsWith('/briefs') ? failure(`cannot rename ${from}: EXDEV`) : deps.fs.rename(from, to),
      },
    };
    const error = refusal(await upgrade(stuck));
    expect(error.message).toContain('EXDEV');
    expect(error.message).toContain('The files are as they were.');
    expect(live(deps)).toEqual(before);
    expect(deps.dirs.has(ROLES)).toBe(false);
  });

  it('leaves no empty roles folder when the first move fails', async () => {
    const { deps } = makeOldNode();
    const before = live(deps);
    const stuck: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        rename: async (from, to) => (from === OLD.protocol ? failure(`cannot rename ${from}: EXDEV`) : deps.fs.rename(from, to)),
      },
    };
    expect(refusal(await upgrade(stuck)).message).toContain('EXDEV');
    expect(live(deps)).toEqual(before);
    expect(deps.dirs.has(ROLES)).toBe(false);
  });

  it('names the backup when a moved file cannot be put back', async () => {
    const { deps } = makeOldNode();
    const failing = withFailingWrites(deps, (path, attempt) => path === CONFIG && attempt === 1);
    const stuck: FakeDeps = {
      ...failing,
      fs: {
        ...failing.fs,
        rename: async (from, to) =>
          to === OLD.protocol ? failure(`cannot rename ${from}: EBUSY`) : deps.fs.rename(from, to),
      },
    };
    const error = refusal(await upgrade(stuck));
    expect(error.message).toContain('1 file could not be restored');
    expect(error.message).toContain('EBUSY');
    expect(error.message).toContain('Restore it from .factory/backups/2030-01-02T03-04-05-678Z.');
    expect(text(deps, `${BACKUP}/.factory/protocol.md`)).toContain('factory:begin protocol');
  });
});
