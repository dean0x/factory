import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inspectBlocks } from '../../src/blocks/status.js';
import { renderBlock } from '../../src/blocks/managed.js';
import { exitCodeOf, failure, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runInit } from '../../src/commands/init.js';
import { runUpgrade } from '../../src/commands/upgrade.js';
import { parseConfigTexts, parseYamlText } from '../../src/config/load.js';
import { CONFIG_SCHEMA_VERSION } from '../../src/config/schema.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { ok } from '../../src/core/result.js';
import type { Migration } from '../../src/migrate/runner.js';
import { jsonText } from '../../src/state/files.js';
import { parseJsonText } from '../../src/state/load.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { backup } from '../../src/upgrade/apply.js';
import { currentSpec, finisher, type UpgradeFile, type UpgradeSpec } from '../../src/upgrade/spec.js';
import { fileTemplates } from '../../src/templates/index.js';
import type { BlockTemplate } from '../../src/templates/types.js';
import { layer1Blocks, layer2Blocks } from '../helpers/blocks.js';
import { createFakeDeps, exited, registerRoot, withFailingWrites, type FakeDeps, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { oldWordsIn } from '../helpers/old-words.js';
import {
  OLD_ROADMAPS_README,
  schema1Doc,
  schema1DocWithProject,
  schema1Paths,
  seedSchema1Node,
} from '../helpers/schema1.js';

/** The schema versions that this factory reads. A test migration starts from them. */
const C = CONFIG_SCHEMA_VERSION;
const S = STATE_SCHEMA_VERSION;

const HOME = '/w/node';
const CLAUDE = `${HOME}/CLAUDE.md`;
const WORKER = `${HOME}/.factory/roles/worker.md`;
const NODE_JSON = `${HOME}/.factory/node.json`;
const CONFIG = `${HOME}/factory.yaml`;
const LOCAL = `${HOME}/factory.local.yaml`;
const BACKUP = `${HOME}/.factory/backups/2030-01-02T03-04-05-678Z`;
const COORDINATOR_LINE = 'Coordinate. Do not produce.';
/** The variables that name the folder of the home index. */
const INDEX_ENV: Record<string, string | undefined> = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
const INDEX = '/state/factory/homes.json';

interface Node {
  readonly deps: FakeDeps;
  /** The git command lines since the node was created. */
  readonly gitSince: () => string[];
}

const makeNode = async (
  options: { repo?: boolean; run?: (inner: RunHandler) => RunHandler } = {},
): Promise<Node> => {
  const { handler } = gitHandler();
  const deps = createFakeDeps({ cwd: '/w', env: { PATH: '/bin', ...INDEX_ENV }, run: options.run?.(handler) ?? handler });
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
  options: { dryRun?: boolean; overwrite?: readonly string[]; yes?: boolean } = {},
): Promise<UpgradeResult> => runUpgrade(deps, { home: HOME, dryRun: false, overwrite: [], yes: true, ...options }, spec);

const success = (result: UpgradeResult): CommandOutput => {
  if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
};

const refusal = (result: UpgradeResult): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

/** The git commands that write: reads of the config and of the work tree do not count. */
const gitWrites = (commands: readonly string[]): string[] =>
  commands.filter(
    (command) => !command.startsWith('config') && !command.startsWith('rev-parse') && !command.startsWith('status'),
  );

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
    expect(gitWrites(gitSince())).toEqual([
      'add -A -- node.json',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: upgrade the state',
    ]);

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
    deps.seed(`${HOME}/.factory/locks/worker.lock`, '1');
    success(await upgrade(deps, newer));
    const saved = [...deps.files.keys()].filter((path) => path.startsWith(`${BACKUP}/`));
    expect(saved).toContain(`${BACKUP}/.factory/node.json`);
    expect(saved.some((path) => path.startsWith(`${BACKUP}/.factory/state/`))).toBe(false);
    expect(saved.some((path) => path.startsWith(`${BACKUP}/.factory/locks/`))).toBe(false);
    expect(text(deps, `${HOME}/.factory/state/run.json`)).toBe('{}');
    expect(text(deps, `${HOME}/.factory/locks/worker.lock`)).toBe('1');
  });

  it('updates a block in the worker file', async () => {
    const { deps } = await makeNode();
    success(await upgrade(deps, blocksSpec(withBlock('worker', 'New worker text.'))));
    expect(text(deps, WORKER)).toContain(`<!-- factory:begin worker v${versionOf('worker') + 1} sha256=`);
    expect(text(deps, WORKER)).toContain('New worker text.');
  });

  /** Change the first text line of the safety block, so that its text no longer matches its hash. */
  const editSafety = (deps: FakeDeps): void => {
    const claude = text(deps, CLAUDE);
    const safetyStart = claude.indexOf('<!-- factory:begin safety');
    expect(safetyStart).toBeGreaterThan(-1);
    deps.files.set(CLAUDE, `${claude.slice(0, safetyStart)}${claude.slice(safetyStart).replace(/\n([^<\n][^\n]*)\n/, '\nEdited safety line.\n')}`);
  };

  it('stops for an edited safety block with a short diff and the remedy command, and changes nothing', async () => {
    const { deps, gitSince } = await makeNode();
    editSafety(deps);
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('block safety was edited');
    expect(error.message).toMatch(/^    file:     Edited safety line\./m);
    expect(error.hint).toContain('Run "factory upgrade --overwrite safety"');
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince()).toEqual([]);
  });

  it('stops for an edited safety block in a dry run too', async () => {
    const { deps } = await makeNode();
    editSafety(deps);
    expect(refusal(await upgrade(deps, currentSpec, { dryRun: true })).kind).toBe('safety');
  });

  it('keeps an edited role block with a warning that names the overwrite flag, and goes on', async () => {
    const { deps } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const before = snapshot(deps);
    const output = success(await upgrade(deps));
    expect(output.lines).toContainEqual({
      level: 'warn',
      text: 'block coordinator was edited, so factory keeps it. Use --overwrite coordinator to replace it.',
    });
    expect(output.warnings).toContain('block coordinator was edited, so factory keeps it. Use --overwrite coordinator to replace it.');
    expect(snapshot(deps)).toEqual(before);
  });

  it('keeps an edited role block and still upgrades the other blocks', async () => {
    const { deps } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const spec = blocksSpec(withBlock('worker', 'New worker text.'));
    const output = success(await upgrade(deps, spec));
    expect(text(deps, CLAUDE)).toContain('Do as you like.');
    expect(text(deps, WORKER)).toContain('New worker text.');
    expect(output.json).toMatchObject({ changed: true });
  });

  it('replaces an edited block when it is named, and does not commit a CLAUDE.md-only change', async () => {
    const { deps, gitSince } = await makeNode();
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const output = success(await upgrade(deps, currentSpec, { overwrite: ['coordinator'] }));
    expect(text(deps, CLAUDE)).toContain(COORDINATOR_LINE);
    expect(text(deps, CLAUDE)).not.toContain('Do as you like.');
    expect(output.lines.at(-1)?.text).toMatch(/^Changed 1 file\./);
    expect(output.json).toMatchObject({ committed: false });
    expect(gitWrites(gitSince())).toEqual([]);
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
    expect(gitWrites(gitSince())).toEqual([]);
  });

  it('migrates the state and records the new block versions in one file', async () => {
    const { deps } = await makeNode();
    const spec: UpgradeSpec = {
      ...currentSpec,
      state: stateAt(S + 1, [step('schema_version', S, { note: 'x' })]),
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
      ...currentSpec,
      config: configAt(C + 1, [step('schema', C)]),
      state: stateAt(S + 1, [step('schema_version', S)]),
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

  it('stops at a failing step of the state, in the plan, before it makes a backup, also in a dry run', async () => {
    const { deps, gitSince } = await makeNode();
    const before = snapshot(deps);
    const spec: UpgradeSpec = { ...currentSpec, state: stateAt(S + 2, [step('schema_version', S), brokenStep(S + 1)]) };
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, spec, { dryRun }));
      expect(error.kind).toBe('failure');
      expect(error.message).toBe(`.factory/node.json: migration from version ${S + 1} to ${S + 2} failed: boom`);
    }
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince().some((command) => command.includes('commit'))).toBe(false);
  });

  it('fails when the migrated value does not pass the schema, and names the key, also in a dry run', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const sloppy: Migration = { from: C + 1, to: C + 2, apply: (raw) => ok(raw) };
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 2, [step('schema', C), sloppy]) };
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, spec, { dryRun }));
      expect(error.message).toContain('factory.yaml: schema:');
    }
    expect(snapshot(deps)).toEqual(before);
  });

  it('fails when the migrated state does not pass the schema, also in a dry run', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const sloppy: Migration = { from: S + 1, to: S + 2, apply: (raw) => ok(raw) };
    const spec: UpgradeSpec = { ...currentSpec, state: stateAt(S + 2, [step('schema_version', S), sloppy]) };
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, spec, { dryRun }));
      expect(error.message).toContain('.factory/node.json: schema_version:');
    }
    expect(snapshot(deps)).toEqual(before);
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

  it('keeps an edited coordinator block on layer 2 with a warning, and replaces it with the manager block when it is named', async () => {
    const { deps } = await makeNode();
    setLayer(deps, 2);
    edit(deps, CLAUDE, COORDINATOR_LINE, 'Do as you like.');
    const before = snapshot(deps);

    const kept = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(kept.lines).toContainEqual({
      level: 'warn',
      text: 'block coordinator was edited, so factory keeps it. Use --overwrite coordinator to replace it.',
    });
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
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A -- node.json', 'reset -q -- node.json']));
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
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A -- node.json', 'reset -q -- node.json']));
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

  it('touches the index of the owner only after it staged, and never before', async () => {
    const { deps, gitSince } = await makeNode();
    const failing = withFailingWrites(deps, (path, attempt) => path === NODE_JSON && attempt === 1);
    refusal(await upgrade(failing, newer));
    expect(gitWrites(gitSince())).toEqual([]);
  });

  it('clears the index when the staging fails, only for the paths that it stages', async () => {
    const { deps, gitSince } = await makeNode({
      run: (inner) => (call) => (call.args.includes('add') ? exited(128) : inner(call)),
    });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps, newer));
    expect(error.message).toContain('cannot stage the state files');
    expect(text(deps, NODE_JSON)).toBe(before.get(NODE_JSON));
    expect(gitWrites(gitSince())).toEqual(['add -A -- node.json', 'reset -q -- node.json']);
  });

  describe('when git is cut off after it wrote the commit', () => {
    /** A git that writes the commit and then fails, as git does when the time limit stops it: HEAD moves on. */
    const cutOff =
      (afterwards: (call: RunCall) => ReturnType<RunHandler>) =>
      (inner: RunHandler): RunHandler => {
        let committed = false;
        return (call) => {
          if (call.args.includes('commit')) {
            committed = true;
            return failure('cannot run git: SIGTERM');
          }
          if (committed && call.args.includes('HEAD')) return afterwards(call);
          return call.args.includes('HEAD') ? exited(0, 'abc123\n') : inner(call);
        };
      };

    it('keeps the new files, because the commit holds them, and says what to do', async () => {
      const { deps, gitSince } = await makeNode({ run: cutOff(() => exited(0, 'def456\n')) });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps, newer));
      expect(error.message).toContain('cannot commit the state files: cannot run git: SIGTERM');
      expect(error.message).toContain('The upgrade commit was made in .factory, so the files stay upgraded.');
      expect(error.message).toContain('"git log -1 --stat" in .factory');
      expect(error.message).toContain('"factory upgrade" again');
      expect(error.message).toContain('.factory/backups/2030-01-02T03-04-05-678Z');
      expect(error.message).not.toContain('The files are as they were');
      expect(text(deps, NODE_JSON)).not.toBe(before.get(NODE_JSON));
      expect(text(deps, CLAUDE)).not.toBe(before.get(CLAUDE));
      expect(gitSince().some((command) => command.startsWith('reset'))).toBe(false);
    });

    it('keeps the new files when the commit is the first commit of the repo', async () => {
      const { deps } = await makeNode({
        run: (inner) => {
          let committed = false;
          return (call) => {
            if (call.args.includes('commit')) {
              committed = true;
              return failure('cannot run git: SIGTERM');
            }
            if (call.args.includes('HEAD')) return committed ? exited(0, 'def456\n') : exited(128);
            return inner(call);
          };
        },
      });
      const before = snapshot(deps);
      expect(refusal(await upgrade(deps, newer)).message).toContain('The upgrade commit was made in .factory');
      expect(text(deps, NODE_JSON)).not.toBe(before.get(NODE_JSON));
    });

    it('keeps the new files and names the backup when it cannot read the last commit', async () => {
      const { deps, gitSince } = await makeNode({ run: cutOff(() => failure('cannot run git: SIGTERM')) });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps, newer));
      expect(error.message).toContain('cannot read the last commit');
      expect(error.message).toContain('"git log -1 --stat" in .factory');
      expect(error.message).toContain('restore the files from .factory/backups/2030-01-02T03-04-05-678Z');
      expect(text(deps, NODE_JSON)).not.toBe(before.get(NODE_JSON));
      expect(gitSince().some((command) => command.startsWith('reset'))).toBe(false);
    });

    it('puts the files back when the commit did not move HEAD', async () => {
      const { deps } = await makeNode({ run: cutOff(() => exited(0, 'abc123\n')) });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps, newer));
      expect(error.message).toContain('The files are as they were.');
      for (const [path, body] of before) expect(text(deps, path)).toBe(body);
    });
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

  it('exits 4, and names init, when the factory marker is missing, does not parse or is not valid', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    for (const marker of [null, '{', JSON.stringify({ schema_version: S })]) {
      if (marker === null) deps.files.delete(NODE_JSON);
      else deps.files.set(NODE_JSON, marker);
      const error = refusal(await upgrade(deps));
      expect(error.kind).toBe('safety');
      expect(error.message).toContain('factory marker .factory/node.json');
      expect(error.hint).toBe(`Run "factory init" in the factory folder ${HOME}.`);
    }
    deps.files.set(NODE_JSON, before.get(NODE_JSON) ?? '');
    expect(snapshot(deps)).toEqual(before);
  });

  it('finds the node from the current folder, and fails when there is none', async () => {
    const { deps } = await makeNode();
    const inside = createFakeDeps({ cwd: `${HOME}/deep`, env: INDEX_ENV });
    for (const [path, body] of deps.files) inside.seed(path, body);
    inside.seedDir(`${HOME}/deep`);
    const options = { home: undefined, dryRun: false, overwrite: [], yes: false };
    expect(success(await runUpgrade(inside, options, currentSpec)).json).toMatchObject({ home: HOME });
    const none = await runUpgrade(createFakeDeps({ cwd: '/empty' }), options, currentSpec);
    expect(refusal(none).hint).toContain('--home DIR');
  });
});

describe('upgrade: when the state repo holds changes of the owner', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));

  /** A git that answers the status of the state repo with this text, in the form of `git status --porcelain -z`. */
  const statusIs =
    (...entries: readonly string[]) =>
    (inner: RunHandler): RunHandler =>
    (call) =>
      call.args.includes('status') ? exited(0, entries.map((entry) => `${entry}\0`).join('')) : inner(call);

  const refusedWith = async (entries: readonly string[], spec: UpgradeSpec = newer) => {
    const { deps, gitSince } = await makeNode({ run: statusIs(...entries) });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps, spec));
    expect(snapshot(deps)).toEqual(before);
    expect(gitWrites(gitSince())).toEqual([]);
    return error;
  };

  it('refuses before any change when a change is staged, and names the file', async () => {
    const error = await refusedWith(['M  board.md']);
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('.factory has staged changes: board.md');
    expect(error.hint).toContain('Commit them');
    expect(error.hint).toContain('factory upgrade');
  });

  it('refuses when a new file is staged', async () => {
    expect((await refusedWith(['A  notes.md'])).message).toBe('.factory has staged changes: notes.md');
  });

  it.each([
    ['a file with a change that is not staged', ' M node.json'],
    ['a file that git does not track', '?? node.json'],
    ['a file that the owner deleted', ' D node.json'],
  ])('refuses before any change for %s, when the upgrade changes that file', async (_name, entry) => {
    const error = await refusedWith([entry]);
    expect(error.message).toBe('.factory has changes in files that the upgrade changes: node.json');
    expect(error.hint).toContain('factory upgrade');
  });

  it('shows at most 5 paths', async () => {
    const entries = Array.from({ length: 8 }, (_, index) => `M  file${index}.md`);
    expect((await refusedWith(entries)).message).toBe(
      '.factory has staged changes: file0.md, file1.md, file2.md, file3.md, file4.md and 3 more',
    );
  });

  it('does not take a change that the upgrade does not touch, and commits only its own files', async () => {
    const { deps, gitSince } = await makeNode({ run: statusIs(' M board.md', '?? notes/idea.md') });
    const output = success(await upgrade(deps, newer));
    expect(output.json).toMatchObject({ committed: true });
    expect(gitWrites(gitSince())).toEqual([
      'add -A -- node.json',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: upgrade the state',
    ]);
  });

  it('does not look at the state repo in a dry run', async () => {
    const { deps, gitSince } = await makeNode({ run: statusIs('M  board.md') });
    expect(success(await upgrade(deps, newer, { dryRun: true })).json).toMatchObject({ changed: true, dryRun: true });
    expect(gitSince().some((command) => command.startsWith('status'))).toBe(false);
  });

  it('stops when git cannot give the status', async () => {
    const { deps } = await makeNode({ run: (inner) => (call) => (call.args.includes('status') ? exited(128) : inner(call)) });
    const before = snapshot(deps);
    expect(refusal(await upgrade(deps, newer)).message).toContain('cannot read the changes of the state repository');
    expect(snapshot(deps)).toEqual(before);
  });
});

/** A config of schema 1 that the owner edited: notes on top, inline and between the keys, and an own key order. */
const OWNER_CONFIG = `# My factory config.
schema: 1

# The note on the node.
node:
  id: demo    # The inline note on the id.
  role: coordinator    # The inline note on the role.

# The note on the limits.
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count
  context_prepare_pct: 30
  context_max_pct: 40

# The note on the lanes.
lanes: {}

owner:
  display: "Test Owner"
  # The note on the prefix.
  prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]"

session:
  permission_mode: auto
  effort: high
  model: default
  proxy: none

proxies: []

# The note on the projects.
projects: []

# The note on the children.
children: []
`;

describe('upgrade: a node of schema 1', () => {
  const OLD = schema1Paths(HOME);
  const ROLES = `${HOME}/.factory/roles`;
  const ORDERS_KEEP = `${HOME}/.factory/orders/.gitkeep`;
  const BACKUPS_DIR = `${HOME}/.factory/backups/`;
  const workerBody = layer1Blocks.find((template) => template.name === 'worker')?.body ?? '';
  const workerLine = workerBody.split('\n').find((line) => line.length > 20 && !line.startsWith('#')) ?? '';

  const makeOldNode = (
    options: {
      run?: (inner: RunHandler) => RunHandler;
      doc?: Record<string, any>;
      git?: GitFixture;
      env?: Record<string, string | undefined>;
    } = {},
  ): Node => {
    const { handler } = gitHandler(options.git);
    const deps = createFakeDeps({
      cwd: '/w',
      env: { PATH: '/bin', ...(options.env ?? INDEX_ENV) },
      run: options.run?.(handler) ?? handler,
    });
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
        'replace .factory/roadmaps/README.md with the new text',
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

    expect(parseConfigTexts(text(deps, CONFIG), text(deps, LOCAL)).ok).toBe(true);
    const shared = parseYamlText(text(deps, CONFIG));
    expect(shared.ok && shared.value).toMatchObject({
      schema: C,
      node: { id: 'demo', layer: 1 },
      tracker: { kind: 'local' },
      recipe: { id: 'software', variant: 'plain' },
    });
    const local = parseYamlText(text(deps, LOCAL));
    expect(local.ok && local.value).toMatchObject({
      schema: 1,
      owner: { display: 'Test Owner' },
      session: { proxy: 'none' },
      approval: {},
      parent: null,
      children: [],
    });
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(text(deps, `${BACKUP}/factory.yaml`)).toContain('schema: 1');
    expect(deps.files.has(`${BACKUP}/factory.local.yaml`)).toBe(false);
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toEqual({
      schema_version: S,
      created_with: '0.1.0',
      blocks: { coordinator: versionOf('coordinator'), safety: versionOf('safety'), worker: versionOf('worker') },
    });

    expect(output.lines.at(-1)?.text).toBe('Changed 8 files. The backup is in .factory/backups/2030-01-02T03-04-05-678Z.');
    expect(output.json).toMatchObject({ committed: true, config: { from: 1, to: C }, state: { from: 1, to: S } });
    expect(gitWrites(gitSince())).toEqual([
      'rm -r -q --cached --ignore-unmatch -- protocol.md briefs',
      'add -A -- roles/worker.md roadmaps/README.md node.json orders',
      '-c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m chore: upgrade the state',
    ]);
    expect(text(deps, `${BACKUP}/.factory/protocol.md`)).toContain('factory:begin protocol');
    expect(deps.files.has(`${BACKUP}/.factory/briefs/.gitkeep`)).toBe(true);
  });

  describe('the roadmap README', () => {
    const owned = `${OLD_ROADMAPS_README}\n## Our own track rules\n`;

    it('is the text of version 0.1.0 in the fixture, with old words that the new text does not have', () => {
      expect(oldWordsIn(OLD_ROADMAPS_README).length).toBeGreaterThan(0);
      expect(oldWordsIn(fileTemplates.roadmapsReadme)).toEqual([]);
    });

    it('is replaced with the new text when it is still the text of version 0.1.0, and the commit holds it', async () => {
      const { deps, gitSince } = makeOldNode();
      const output = success(await upgrade(deps));
      expect(text(deps, OLD.roadmaps)).toBe(fileTemplates.roadmapsReadme);
      expect(oldWordsIn(text(deps, OLD.roadmaps))).toEqual([]);
      expect(output.json).toMatchObject({ replaces: [{ path: '.factory/roadmaps/README.md', action: 'replace' }] });
      expect(output.warnings).toEqual([]);
      expect(gitWrites(gitSince())[1]).toContain('roadmaps/README.md');
      expect(text(deps, `${BACKUP}/.factory/roadmaps/README.md`)).toBe(OLD_ROADMAPS_README);
    });

    it('is kept when the owner edited it, with a note that names the file and the help for the words', async () => {
      const { deps, gitSince } = makeOldNode();
      deps.files.set(OLD.roadmaps, owned);
      const output = success(await upgrade(deps));
      expect(text(deps, OLD.roadmaps)).toBe(owned);
      expect(output.json).toMatchObject({ replaces: [{ path: '.factory/roadmaps/README.md', action: 'keep' }] });
      const note = output.lines.find((line) => line.text.includes('roadmaps/README.md was edited'));
      expect(note?.level).toBe('warn');
      expect(note?.text).toContain('factory help words');
      expect(output.warnings).toEqual([note?.text]);
      expect(output.lines.at(-1)?.text).toBe('Changed 7 files. The backup is in .factory/backups/2030-01-02T03-04-05-678Z.');
      expect(gitWrites(gitSince())[1]).toBe('add -A -- roles/worker.md node.json orders');
    });

    it('is kept when its text differs in one character, also a trailing newline', async () => {
      const { deps } = makeOldNode();
      deps.files.set(OLD.roadmaps, OLD_ROADMAPS_README.trimEnd());
      success(await upgrade(deps));
      expect(text(deps, OLD.roadmaps)).toBe(OLD_ROADMAPS_README.trimEnd());
    });

    it('shows the note for an edited file in a dry run, and changes no file', async () => {
      const { deps } = makeOldNode();
      deps.files.set(OLD.roadmaps, owned);
      const before = snapshot(deps);
      const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
      expect(output.lines.some((line) => line.level === 'warn' && line.text.includes('roadmaps/README.md was edited'))).toBe(true);
      expect(output.lines.some((line) => line.text.startsWith('replace '))).toBe(false);
      expect(snapshot(deps)).toEqual(before);
    });

    it('is skipped when the file is missing', async () => {
      const { deps } = makeOldNode();
      deps.files.delete(OLD.roadmaps);
      const output = success(await upgrade(deps));
      expect(deps.files.has(OLD.roadmaps)).toBe(false);
      expect(output.json).toMatchObject({ replaces: [] });
      expect(output.warnings).toEqual([]);
    });

    it('refuses before any change when git reports a change in the file that the upgrade replaces', async () => {
      const { deps, gitSince } = makeOldNode({
        run: (inner) => (call) => (call.args.includes('status') ? exited(0, ' M roadmaps/README.md\0') : inner(call)),
      });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps));
      expect(error.message).toBe('.factory has changes in files that the upgrade changes: roadmaps/README.md');
      expect(snapshot(deps)).toEqual(before);
      expect(gitWrites(gitSince())).toEqual([]);
    });

    it('does not stop for a change in the file when the owner edited it, because the upgrade leaves it', async () => {
      const { deps } = makeOldNode({
        run: (inner) => (call) => (call.args.includes('status') ? exited(0, ' M roadmaps/README.md\0') : inner(call)),
      });
      deps.files.set(OLD.roadmaps, owned);
      success(await upgrade(deps));
      expect(text(deps, OLD.roadmaps)).toBe(owned);
    });
  });

  it.each([
    ['a file that moves', ' M protocol.md', 'protocol.md'],
    ['a file below a folder that moves', '?? briefs/today.md', 'briefs/today.md'],
  ])('refuses before any change for a change in %s', async (_name, entry, path) => {
    const { deps, gitSince } = makeOldNode({
      run: (inner) => (call) => (call.args.includes('status') ? exited(0, `${entry}\0 M board.md\0`) : inner(call)),
    });
    const before = snapshot(deps);
    const error = refusal(await upgrade(deps));
    expect(error.message).toBe(`.factory has changes in files that the upgrade changes: ${path}`);
    expect(snapshot(deps)).toEqual(before);
    expect(gitWrites(gitSince())).toEqual([]);
  });

  describe('the home index', () => {
    /** The entries of the home index file. */
    const indexed = (deps: FakeDeps): unknown => {
      const index = parseJsonText(text(deps, INDEX));
      return index.ok ? (index.value as { homes: unknown }).homes : undefined;
    };

    it('records the home after a real upgrade, with the id and the projects of the upgraded config', async () => {
      const { deps } = makeOldNode();
      expect(deps.files.has(INDEX)).toBe(false);
      const output = success(await upgrade(deps));
      expect(indexed(deps)).toEqual([{ home: HOME, id: 'demo', projects: [] }]);
      expect(output.warnings).toEqual([]);
    });

    it('writes no index in a dry run', async () => {
      const { deps } = makeOldNode();
      success(await upgrade(deps, currentSpec, { dryRun: true }));
      expect(deps.files.has(INDEX)).toBe(false);
    });

    it('writes no index when the upgrade fails', async () => {
      const { deps } = makeOldNode();
      const failing = withFailingWrites(deps, (path, attempt) => path === CONFIG && attempt === 1);
      refusal(await upgrade(failing));
      expect(deps.files.has(INDEX)).toBe(false);
    });

    it('writes no index when there is nothing to upgrade', async () => {
      const { deps } = makeOldNode();
      success(await upgrade(deps));
      const written = deps.atomicWrites.filter((path) => path === INDEX).length;
      expect(success(await upgrade(deps)).lines.at(-1)?.text).toBe('Nothing to upgrade.');
      expect(deps.atomicWrites.filter((path) => path === INDEX)).toHaveLength(written);
    });

    it('warns, and still succeeds, when the index cannot be written', async () => {
      const { deps } = makeOldNode();
      const failing = withFailingWrites(deps, (path) => path === INDEX);
      const output = success(await upgrade(failing));
      expect(output.json).toMatchObject({ changed: true, committed: true });
      expect(output.warnings).toHaveLength(1);
      expect(output.warnings[0]).toContain(`The home index ${INDEX} was not updated`);
      expect(output.warnings[0]).toContain('disk full');
      expect(output.lines.some((line) => line.level === 'warn' && line.text === output.warnings[0])).toBe(true);
    });

    it('exits 4 and changes no file when no folder is named for the index, because it can not register the folder', async () => {
      const { deps } = makeOldNode({ env: {} });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps));
      expect(error.kind).toBe('safety');
      expect(error.message).toContain('XDG_STATE_HOME and HOME name no folder');
      expect(snapshot(deps)).toEqual(before);
    });

    it('exits 4 and changes no file when the index would be inside the folder of Claude Code', async () => {
      const { deps } = makeOldNode({ env: { XDG_STATE_HOME: '/users/me/.claude/state', HOME: '/users/me' } });
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps));
      expect(error.kind).toBe('safety');
      expect(error.message).toContain('/users/me/.claude');
      expect(snapshot(deps)).toEqual(before);
    });
  });

  describe('the registration check', () => {
    const upgradeAsOwner = (deps: FakeDeps, options: { yes?: boolean; dryRun?: boolean; answer?: string; home?: string | undefined } = {}) => {
      const asked = options.answer !== undefined;
      const terminal = asked
        ? {
            stdinIsTTY: true,
            stdoutIsTTY: true,
            prompt: async (question: string) => {
              deps.prompts.push(question);
              return ok(options.answer ?? '');
            },
          }
        : {};
      return runUpgrade(
        { ...deps, ...terminal },
        { home: 'home' in options ? options.home : HOME, dryRun: options.dryRun ?? false, overwrite: [], yes: options.yes ?? false },
        currentSpec,
      );
    };

    it('exits 4 for a folder of the current schema that the factory list does not list, and writes nothing (TP-88)', async () => {
      const { deps } = await makeNode();
      deps.files.delete(INDEX);
      const before = snapshot(deps);
      const error = refusal(await upgrade(deps));
      expect(error.kind).toBe('safety');
      expect(error.hint).toBe(`Run "factory init" in the factory folder ${HOME}.`);
      expect(snapshot(deps)).toEqual(before);
    });

    it('exits 4 for an unregistered folder of schema 1 that the home flag does not name (TP-88)', async () => {
      const { deps } = makeOldNode();
      const before = snapshot(deps);
      const inFolder = { ...deps, cwd: HOME };
      const fromEnvironment = { ...deps, env: { ...deps.env, FACTORY_HOME: HOME } };
      for (const caller of [inFolder, fromEnvironment]) {
        const result = await runUpgrade(caller, { home: undefined, dryRun: false, overwrite: [], yes: true }, currentSpec);
        expect(refusal(result).kind).toBe('safety');
      }
      expect(snapshot(deps)).toEqual(before);
    });

    it('exits 4 and writes nothing with FACTORY_SESSION set, also with the yes flag and in a dry run (TP-89)', async () => {
      const { deps } = makeOldNode();
      const before = snapshot(deps);
      const inSession = { ...deps, env: { ...deps.env, FACTORY_SESSION: 'demo' } };
      for (const options of [{ yes: true }, { yes: false }, { yes: true, dryRun: true }]) {
        const error = refusal(await upgradeAsOwner(inSession, options));
        expect(error.kind).toBe('safety');
        expect(error.hint).toContain('outside a factory session');
      }
      expect(snapshot(deps)).toEqual(before);
      expect(deps.prompts).toEqual([]);
    });

    it('runs with the yes flag and the home flag, and registers the folder (TP-89)', async () => {
      const { deps } = makeOldNode();
      const output = success(await upgradeAsOwner(deps, { yes: true }));
      expect(output.json).toMatchObject({ changed: true });
      expect(text(deps, INDEX)).toContain(`"home": "${HOME}"`);
      expect(deps.prompts).toEqual([]);
    });

    it('exits 2 and writes nothing with no terminal window and no yes flag', async () => {
      const { deps } = makeOldNode();
      const before = snapshot(deps);
      const error = refusal(await upgradeAsOwner(deps));
      expect(error.kind).toBe('usage');
      expect(error.hint).toContain('--yes');
      expect(snapshot(deps)).toEqual(before);
    });

    it('asks on a terminal window with the folder and the node id, and runs after a yes', async () => {
      const { deps } = makeOldNode();
      const output = success(await upgradeAsOwner(deps, { answer: 'y' }));
      expect(output.json).toMatchObject({ changed: true });
      expect(deps.prompts).toHaveLength(1);
      expect(deps.prompts[0]).toContain(HOME);
      expect(deps.prompts[0]).toContain('node id demo');
      expect(deps.prompts[0]).toContain('[y/N]');
      expect(text(deps, INDEX)).toContain(`"home": "${HOME}"`);
    });

    it.each(['', 'n', 'no', 'maybe'])('writes nothing when the answer is "%s", because the default is no', async (answer) => {
      const { deps } = makeOldNode();
      const before = snapshot(deps);
      const error = refusal(await upgradeAsOwner(deps, { answer }));
      expect(error.kind).toBe('usage');
      expect(error.message).toContain('Nothing changed');
      expect(snapshot(deps)).toEqual(before);
    });

    it('asks nothing and writes nothing in a dry run', async () => {
      const { deps } = makeOldNode();
      const before = snapshot(deps);
      success(await upgradeAsOwner(deps, { dryRun: true, answer: 'y' }));
      expect(deps.prompts).toEqual([]);
      expect(snapshot(deps)).toEqual(before);
    });

    it('asks nothing for a folder that the factory list lists', async () => {
      const { deps } = makeOldNode();
      registerRoot(deps, HOME, 'demo');
      const output = success(await upgradeAsOwner(deps));
      expect(output.json).toMatchObject({ changed: true });
      expect(deps.prompts).toEqual([]);
    });
  });

  it('splits a config that the owner edited into a shared file and a local file, with every value in its file', async () => {
    const { deps } = makeOldNode();
    deps.files.set(CONFIG, OWNER_CONFIG);
    success(await upgrade(deps));

    expect(parseConfigTexts(text(deps, CONFIG), text(deps, LOCAL)).ok).toBe(true);
    const shared = parseYamlText(text(deps, CONFIG));
    const sharedValue = shared.ok ? (shared.value as Record<string, Record<string, unknown>>) : {};
    expect(Object.keys(sharedValue)).toEqual(['schema', 'node', 'session', 'limits', 'tracker', 'recipe']);
    expect(Object.keys(sharedValue['node'] ?? {})).toEqual(['id', 'layer']);
    expect(Object.keys(sharedValue['session'] ?? {})).toEqual(['permission_mode', 'effort', 'model']);
    expect(sharedValue['recipe']).toMatchObject({ projects: [] });

    const local = parseYamlText(text(deps, LOCAL));
    const localValue = local.ok ? (local.value as Record<string, Record<string, unknown>>) : {};
    expect(Object.keys(localValue)).toEqual([
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
    expect(Object.keys(localValue['owner'] ?? {})).toEqual(['display', 'prefix']);
    expect(Object.keys(localValue['session'] ?? {})).toEqual(['proxy', 'statusline']);
  });

  it('writes no local key into the shared file, and no shared key into the local file', async () => {
    const { deps } = makeOldNode();
    success(await upgrade(deps));
    const sharedText = text(deps, CONFIG);
    for (const key of ['owner:', 'proxies:', 'workers:', 'approval:', 'parent:', 'children:', 'sources:', 'proxy:', 'statusline:']) {
      expect(sharedText).not.toContain(`\n${key}`);
      expect(sharedText).not.toContain(`  ${key}`);
    }
    const localText = text(deps, LOCAL);
    for (const key of ['node', 'limits', 'tracker', 'recipe', 'permission_mode', 'effort', 'model']) {
      expect(localText).not.toMatch(new RegExp(`^\\s*${key}:`, 'm'));
    }
  });

  it('checks the new text of the config with the schema before it writes, also in a dry run, and changes no file', async () => {
    const doc = schema1Doc();
    doc.extra = 1;
    const { deps } = makeOldNode({ doc });
    const before = live(deps);
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
      expect(error.message).toContain('factory.yaml: extra');
    }
    expect(live(deps)).toEqual(before);
  });

  it('stops a node that lists a project with a failure, names the init command, and changes no file (TP-62)', async () => {
    const { deps, gitSince } = makeOldNode({ doc: schema1DocWithProject() });
    const before = live(deps);
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
      expect(error.kind).toBe('failure');
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('lists a project');
      expect(error.message).toContain('factory init');
    }
    expect(live(deps)).toEqual(before);
    expect(deps.files.has(LOCAL)).toBe(false);
    expect(gitWrites(gitSince())).toEqual([]);
  });

  describe('the home rules', () => {
    const homeWarnings = async (deps: FakeDeps, dryRun: boolean): Promise<readonly string[]> =>
      success(await upgrade(deps, currentSpec, { dryRun })).warnings;

    it('gives no warning when the home follows the rules', async () => {
      const { deps } = makeOldNode();
      expect(await homeWarnings(deps, true)).toEqual([]);
      expect(await homeWarnings(deps, false)).toEqual([]);
    });

    it('warns when the home is inside a git work tree, with the remedy, and still upgrades', async () => {
      const { deps } = makeOldNode({ git: { repos: { '/w': {} } } });
      const [warning, ...others] = await homeWarnings(deps, true);
      expect(others).toEqual([]);
      expect(warning).toContain('is inside the git work tree /w');
      expect(warning).toContain('Move the home');
      expect(warning).toContain('fix the project paths in factory.yaml');
      expect(text(deps, CONFIG)).toContain('schema: 1');

      expect(await homeWarnings(deps, false)).toEqual([warning]);
      expect(text(deps, CONFIG)).toContain('schema: 2');
    });

    it('warns when the home is inside another node home', async () => {
      const { deps } = makeOldNode();
      deps.seed('/w/factory.yaml', 'schema: 2\n');
      const [warning, ...others] = await homeWarnings(deps, false);
      expect(others).toEqual([]);
      expect(warning).toContain('is inside another node home: /w/factory.yaml exists');
    });

    it('warns when a project is inside the home', async () => {
      const { deps } = await makeNode();
      edit(
        deps,
        CONFIG,
        '  projects: []',
        '  projects: [{ id: web, url: "https://example.com/team/web", path: web, default_branch: main, merge_method: squash, gate: { checks: [] } }]',
      );
      const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));
      const [warning, ...others] = success(await upgrade(deps, newer)).warnings;
      expect(others).toEqual([]);
      expect(warning).toContain('is the project folder /w/node/web, or holds it');
    });

    it('warns when the home holds a git repo one level down', async () => {
      const { deps } = makeOldNode({ git: { repos: { '/w/node/other': {} } } });
      deps.seedDir('/w/node/other/.git');
      const [warning, ...others] = await homeWarnings(deps, false);
      expect(others).toEqual([]);
      expect(warning).toContain('holds the git repo other one level down');
    });

    it('does not check the home when nothing is upgraded', async () => {
      const { deps, gitSince } = await makeNode();
      expect(success(await upgrade(deps)).warnings).toEqual([]);
      expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
    });
  });

  it('names the old name of a renamed block in the JSON', async () => {
    const { deps } = makeOldNode();
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(output.json).toMatchObject({
      blocks: [
        { name: 'coordinator', renamedFrom: null },
        { name: 'safety', renamedFrom: null },
        { name: 'worker', renamedFrom: 'protocol' },
      ],
    });
  });

  it('has nothing to upgrade the second time', async () => {
    const { deps } = makeOldNode();
    success(await upgrade(deps));
    const before = snapshot(deps);
    expect(success(await upgrade(deps)).lines.at(-1)?.text).toBe('Nothing to upgrade.');
    expect(snapshot(deps)).toEqual(before);
  });

  it('keeps the edited protocol block, warns with the old name in the flag, and moves the file with the text', async () => {
    const { deps } = makeOldNode();
    edit(deps, OLD.protocol, workerLine, 'My own rule for the workers.');
    const dry = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(dry.lines).toContainEqual({
      level: 'warn',
      text: 'block protocol was edited, so factory keeps it. Use --overwrite protocol to replace it.',
    });
    success(await upgrade(deps));
    expect(text(deps, WORKER)).toContain('My own rule for the workers.');
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

  it('stops on a child with a file address, because the children of layer 1 are workers, and changes nothing', async () => {
    const doc = schema1Doc();
    doc.children = [{ id: 'team-a', address: 'file:///work/team-a' }];
    const { deps } = makeOldNode({ doc });
    const before = live(deps);
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
      expect(error.message).toContain('factory.yaml: migration from version 1 to 2 failed');
      expect(error.message).toContain('this list must be empty');
      expect(error.message).toContain('factory node add-child');
    }
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
    expect(gitWrites(gitSince())).toEqual([]);
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

describe('upgrade: the backup folder', () => {
  const newer = blocksSpec(withBlock('coordinator', 'New coordinator text.'));
  const BACKUPS = `${HOME}/.factory/backups`;
  const holdsBackup = (deps: FakeDeps): boolean =>
    deps.dirs.has(BACKUP) || [...deps.files.keys()].some((path) => path.startsWith(`${BACKUP}/`));

  /** Deps whose copy of one path fails after the copy was made, as a disk that fills up does. */
  const failingCopy = (deps: FakeDeps, failsFor: string): FakeDeps => ({
    ...deps,
    fs: {
      ...deps.fs,
      copyTree: async (from, to, skip) => {
        const copied = await deps.fs.copyTree(from, to, skip);
        return from === failsFor ? failure(`cannot copy ${from}: ENOSPC`) : copied;
      },
    },
  });

  it('removes the backup folder that this run made when a copy fails, and keeps the other backups', async () => {
    const { deps } = await makeNode();
    deps.seed(`${BACKUPS}/older/factory.yaml`, 'old backup');
    const before = snapshot(deps);
    const error = refusal(await upgrade(failingCopy(deps, `${HOME}/.factory`), newer));
    expect(error.message).toContain('ENOSPC');
    expect(holdsBackup(deps)).toBe(false);
    expect(snapshot(deps)).toEqual(before);
  });

  it('removes the backup folder that this run made when a file cannot be examined', async () => {
    const { deps } = await makeNode();
    const unreadable: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        // CLAUDE.md is read before the backup is made, so only the stat call that follows the backup folder fails.
        stat: async (path) => (path === CLAUDE && deps.dirs.has(BACKUP) ? failure(`cannot stat ${path}: EIO`) : deps.fs.stat(path)),
      },
    };
    const error = refusal(await upgrade(unreadable, newer));
    expect(error.message).toContain('EIO');
    expect(holdsBackup(deps)).toBe(false);
  });

  it('says so when the part-copied folder cannot be removed', async () => {
    const { deps } = await makeNode();
    const copying = failingCopy(deps, `${HOME}/.factory`);
    const stuck: FakeDeps = {
      ...copying,
      fs: { ...copying.fs, remove: async (path) => (path === BACKUP ? failure(`cannot remove ${path}: EBUSY`) : deps.fs.remove(path)) },
    };
    const error = refusal(await upgrade(stuck, newer));
    expect(error.message).toContain('ENOSPC');
    expect(error.message).toContain('EBUSY');
    expect(error.message).toContain('.factory/backups/2030-01-02T03-04-05-678Z');
  });

  it('removes nothing when a folder has the name of the backup already', async () => {
    const { deps } = await makeNode();
    deps.seed(`${BACKUP}/factory.yaml`, 'a folder that this run did not make');
    const error = refusal(await upgrade(deps, newer));
    expect(error.message).toContain('exists already');
    expect(text(deps, `${BACKUP}/factory.yaml`)).toBe('a folder that this run did not make');
  });
});

describe('upgrade: the backup on a real disk', () => {
  const real = createNodeDeps();
  const OLDER = '2029-01-01T00-00-00-000Z';
  let root = '';
  let counter = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'factory-upgrade-backup-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A node home with a config file, a state folder, an older backup, and CLAUDE.md as a link to a file outside the home. */
  const linkedHome = async (): Promise<{ home: string; shared: string }> => {
    const base = join(root, `case-${(counter += 1)}`);
    const home = join(base, 'home');
    const shared = join(base, 'shared', 'CLAUDE.md');
    await mkdir(join(home, '.factory', 'backups', OLDER), { recursive: true });
    await mkdir(join(base, 'shared'), { recursive: true });
    await writeFile(join(home, 'factory.yaml'), 'schema: 2\n', 'utf8');
    await writeFile(join(home, '.factory', 'node.json'), '{}\n', 'utf8');
    await writeFile(join(home, '.factory', 'backups', OLDER, 'factory.yaml'), 'old backup', 'utf8');
    await writeFile(shared, 'shared claude text\n', 'utf8');
    await symlink(shared, join(home, 'CLAUDE.md'));
    return { home, shared };
  };

  it('holds the content of a linked CLAUDE.md as a regular file', async () => {
    const { home } = await linkedHome();
    const result = await backup(real, home);
    expect(result.ok).toBe(true);
    const made = result.ok ? result.value : '';
    expect((await lstat(join(made, 'CLAUDE.md'))).isFile()).toBe(true);
    expect(await readFile(join(made, 'CLAUDE.md'), 'utf8')).toBe('shared claude text\n');
    expect(await readFile(join(made, 'factory.yaml'), 'utf8')).toBe('schema: 2\n');
    expect(await readFile(join(made, '.factory', 'node.json'), 'utf8')).toBe('{}\n');
    expect((await lstat(join(home, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
  });

  it('leaves no part-copied folder when a link in the state folder stops the copy', async () => {
    const { home, shared } = await linkedHome();
    await symlink(shared, join(home, '.factory', 'inner-link'));
    const result = await backup(real, home);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOTSUP');
    expect(await readdir(join(home, '.factory', 'backups'))).toEqual([OLDER]);
    expect(await readFile(join(home, '.factory', 'backups', OLDER, 'factory.yaml'), 'utf8')).toBe('old backup');
  });
});

describe('upgrade: the two config files', () => {
  /** The local file at another version, with its own steps. */
  const localAt = (target: number, migrations: readonly Migration[]): UpgradeFile => {
    const schema = z.looseObject({ schema: z.literal(target) });
    return {
      spec: { file: 'factory.local.yaml', key: 'schema', supported: target, schema },
      parse: parseYamlText,
      migrations,
      finish: finisher(schema, (value) => `${JSON.stringify(value)}\n`),
    };
  };

  const L = 1;

  /** A node from before the split: one config file of schema 1. */
  const makeOldNodeForTwoFiles = (): Node => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({ cwd: '/w', env: { PATH: '/bin', ...INDEX_ENV }, run: handler });
    seedSchema1Node(deps, HOME);
    const first = deps.calls.length;
    return { deps, gitSince: () => deps.calls.slice(first).map((call) => call.args.slice(2).join(' ')) };
  };

  it('exits 2, names init and writes nothing for a root of the current schema with no local file, also in a dry run', async () => {
    const { deps, gitSince } = await makeNode();
    deps.files.delete(LOCAL);
    const before = snapshot(deps);
    const written = deps.atomicWrites.length;
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
      expect(error.kind).toBe('usage');
      expect(error.message).toBe('factory.local.yaml not found');
      expect(error.hint).toContain('factory init');
    }
    expect(snapshot(deps)).toEqual(before);
    expect(deps.files.has(LOCAL)).toBe(false);
    expect(deps.atomicWrites.slice(written)).toEqual([]);
    expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
  });

  it('plans the shared file and the local file apart: only the local file migrates, and it is written with mode 600', async () => {
    const { deps } = await makeNode();
    const sharedBefore = text(deps, CONFIG);
    const original = text(deps, LOCAL);
    const first = deps.atomicWrites.length;
    const spec: UpgradeSpec = { ...currentSpec, local: localAt(L + 1, [step('schema', L, { added: true })]) };
    const output = success(await upgrade(deps, spec));
    expect(lineTexts(output)).toContain(`factory.local.yaml: schema ${L} to ${L + 1} (1 step)`);
    expect(lineTexts(output)).toContain(`factory.yaml: schema ${C} is current`);
    expect(output.json).toMatchObject({ config: { from: C, to: C }, local: { from: L, to: L + 1 }, changed: true });
    expect(text(deps, CONFIG)).toBe(sharedBefore);
    expect(deps.atomicWrites.slice(first)).not.toContain(CONFIG);
    expect(deps.atomicWrites.slice(first)).toContain(LOCAL);
    const written = parseJsonText(text(deps, LOCAL));
    expect(written.ok && written.value).toMatchObject({ schema: L + 1, added: true });
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(text(deps, `${BACKUP}/factory.local.yaml`)).toBe(original);
  });

  it('plans the shared file alone when only the shared file migrates, and keeps the local file as it is', async () => {
    const { deps } = await makeNode();
    const localBefore = text(deps, LOCAL);
    const first = deps.atomicWrites.length;
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(C + 1, [step('schema', C)]) };
    const output = success(await upgrade(deps, spec));
    expect(output.json).toMatchObject({ config: { from: C, to: C + 1 }, local: { from: L, to: L } });
    expect(lineTexts(output)).toContain(`factory.local.yaml: schema ${L} is current`);
    expect(text(deps, LOCAL)).toBe(localBefore);
    expect(deps.atomicWrites.slice(first)).not.toContain(LOCAL);
  });

  it('writes the local file before the shared file', async () => {
    const { deps } = await makeNode();
    const first = deps.atomicWrites.length;
    const spec: UpgradeSpec = {
      ...currentSpec,
      config: configAt(C + 1, [step('schema', C)]),
      local: localAt(L + 1, [step('schema', L)]),
    };
    success(await upgrade(deps, spec));
    const writes = deps.atomicWrites.slice(first);
    expect(writes.indexOf(LOCAL)).toBeGreaterThan(-1);
    expect(writes.indexOf(LOCAL)).toBeLessThan(writes.indexOf(CONFIG));
  });

  it('shows the new local file of a root of schema 1 in a dry run, with mode 600, and writes nothing', async () => {
    const { deps } = makeOldNodeForTwoFiles();
    const before = snapshot(deps);
    const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
    expect(lineTexts(output)).toContain(
      'factory.local.yaml: new file, with mode 600, from the local keys of factory.yaml',
    );
    expect(output.json).toMatchObject({ local: { from: null, to: L }, dryRun: true });
    expect(snapshot(deps)).toEqual(before);
    expect(deps.files.has(LOCAL)).toBe(false);
  });

  it('stops for a root of schema 1 when a local file is there already, and changes nothing', async () => {
    const { deps } = makeOldNodeForTwoFiles();
    deps.seed(LOCAL, 'schema: 1\n');
    const before = snapshot(deps);
    for (const dryRun of [false, true]) {
      const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
      expect(error.kind).toBe('failure');
      expect(error.message).toBe('factory.local.yaml exists already, but factory.yaml has schema 1');
    }
    expect(snapshot(deps)).toEqual(before);
  });

  describe('the mode and the owner of the local file', () => {
    it('sets a mode that others can read back to 600, with a notice, in a real run', async () => {
      const { deps } = await makeNode();
      deps.modes.set(LOCAL, 0o644);
      const output = success(await upgrade(deps));
      expect(deps.modes.get(LOCAL)).toBe(0o600);
      expect(output.warnings.join('\n')).toContain('factory.local.yaml');
      expect(output.warnings.join('\n')).toContain('644');
    });

    it('warns, names the chmod command and changes no mode in a dry run', async () => {
      const { deps } = await makeNode();
      deps.modes.set(LOCAL, 0o644);
      const output = success(await upgrade(deps, currentSpec, { dryRun: true }));
      expect(deps.modes.get(LOCAL)).toBe(0o644);
      expect(output.warnings.join('\n')).toContain('chmod 600 factory.local.yaml');
    });

    it.each([
      ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
      ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
      ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
    ])('stops with exit 4 and one remedy line for a local file with %s, and changes nothing', async (_name, change) => {
      const { deps, gitSince } = await makeNode();
      change(deps);
      const mode = deps.modes.get(LOCAL);
      const before = snapshot(deps);
      for (const dryRun of [false, true]) {
        const error = refusal(await upgrade(deps, currentSpec, { dryRun }));
        expect(error.kind).toBe('safety');
        expect(error.hint).toContain('chmod 600 factory.local.yaml');
      }
      expect(deps.modes.get(LOCAL)).toBe(mode);
      expect(snapshot(deps)).toEqual(before);
      expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
    });
  });
});
