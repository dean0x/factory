import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { inspectBlocks } from '../../src/blocks/status.js';
import { renderBlock } from '../../src/blocks/managed.js';
import { failure, type CliError } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runInit } from '../../src/commands/init.js';
import { runUpgrade } from '../../src/commands/upgrade.js';
import { parseYamlText } from '../../src/config/load.js';
import { ok } from '../../src/core/result.js';
import type { Migration } from '../../src/migrate/runner.js';
import { jsonText } from '../../src/state/files.js';
import { parseJsonText } from '../../src/state/load.js';
import { currentSpec, finisher, type UpgradeFile, type UpgradeSpec } from '../../src/upgrade/spec.js';
import { blockTemplates, type BlockTemplate } from '../../src/templates/index.js';
import { createFakeDeps, exited, withFailingWrites, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';

const HOME = '/w/node';
const CLAUDE = `${HOME}/CLAUDE.md`;
const PROTOCOL = `${HOME}/.factory/protocol.md`;
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
    { home: HOME, name: 'demo', ownerName: 'Test Owner', ownerGithub: undefined, projects: [] },
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

const withBlock = (name: string, version: number, body: string): readonly BlockTemplate[] =>
  blockTemplates.map((template) => (template.name === name ? { ...template, version, body } : template));

const blocksSpec = (blocks: readonly BlockTemplate[]): UpgradeSpec => ({ ...currentSpec, blocks });

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
      config: { from: 1, to: 1 },
      state: { from: 1, to: 1 },
    });
    expect(output.failed).toBe(false);
    expect(snapshot(deps)).toEqual(before);
    expect(gitSince().filter((command) => !command.startsWith('config'))).toEqual([]);
  });

  it('skips a missing block with a warning, and does not create it', async () => {
    const { deps } = await makeNode();
    deps.files.delete(PROTOCOL);
    const output = success(await upgrade(deps));
    expect(output.warnings).toEqual(['block protocol is missing. Use --overwrite protocol to add it.']);
    expect(output.json).toMatchObject({ changed: false });
    expect(deps.files.has(PROTOCOL)).toBe(false);
  });
});

describe('upgrade: managed blocks', () => {
  const newer = blocksSpec(withBlock('coordinator', 2, 'New coordinator text.'));

  it('shows the plan in a dry run and changes no file', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const output = success(await upgrade(deps, newer, { dryRun: true }));
    expect(lineTexts(output)).toEqual(
      expect.arrayContaining([
        'factory.yaml: schema 1 is current',
        '.factory/node.json: schema_version 1 is current',
        'block coordinator: version 1 to 2',
        'block safety: version 1 is current',
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
    expect(claude).toContain('<!-- factory:begin coordinator v2 sha256=');
    expect(claude).toContain('New coordinator text.');
    expect(claude).not.toContain(COORDINATOR_LINE);
    expect(claude).toContain('<!-- factory:begin safety v1 sha256=');
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toMatchObject({ blocks: { coordinator: 2, safety: 1, protocol: 1 } });
    expect(output.lines.at(-1)?.text).toBe('Changed 2 files. The backup is in .factory/backups/2030-01-02T03-04-05-678Z.');
    expect(output.json).toMatchObject({ changed: true, committed: true, backup: '.factory/backups/2030-01-02T03-04-05-678Z' });
    expect(gitSince()).toEqual(expect.arrayContaining(['add -A']));
    expect(gitSince().some((command) => command.endsWith('chore: upgrade the state'))).toBe(true);

    const statuses = await inspectBlocks(deps, HOME, newer.blocks);
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

  it('updates a block in the protocol file', async () => {
    const { deps } = await makeNode();
    success(await upgrade(deps, blocksSpec(withBlock('protocol', 2, 'New protocol text.'))));
    expect(text(deps, PROTOCOL)).toContain('<!-- factory:begin protocol v2 sha256=');
    expect(text(deps, PROTOCOL)).toContain('New protocol text.');
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
    expect((await inspectBlocks(deps, HOME, blockTemplates)).every((status) => status.kind === 'intact')).toBe(true);
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
    expect(lineTexts(output)).toContain('block safety: add version 1');
  });

  it('creates a missing protocol file when the block is named', async () => {
    const { deps } = await makeNode();
    deps.files.delete(PROTOCOL);
    const output = success(await upgrade(deps, currentSpec, { overwrite: ['protocol'] }));
    expect(text(deps, PROTOCOL)).toContain('<!-- factory:begin protocol v1 sha256=');
    expect(output.json).toMatchObject({ committed: true });
  });

  it('rejects the name of a block that does not exist', async () => {
    const { deps } = await makeNode();
    const error = refusal(await upgrade(deps, currentSpec, { overwrite: ['nope'] }));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain('unknown block nope');
    expect(error.hint).toBe('The blocks are: coordinator, safety, protocol.');
  });

  it('fails when a block has a newer version than the template', async () => {
    const { deps } = await makeNode();
    const rendered = renderBlock({ name: 'coordinator', version: 3, body: 'From the future.' });
    expect(rendered.ok).toBe(true);
    const claude = text(deps, CLAUDE);
    const start = claude.indexOf('<!-- factory:begin coordinator');
    const end = claude.indexOf('<!-- factory:end coordinator -->') + '<!-- factory:end coordinator -->'.length;
    deps.files.set(CLAUDE, `${claude.slice(0, start)}${rendered.ok ? rendered.value : ''}${claude.slice(end)}`);
    const error = refusal(await upgrade(deps, newer));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('block coordinator has version 3');
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
  it('runs the chain 1 to 2 to 3, writes the config and keeps the other keys', async () => {
    const { deps, gitSince } = await makeNode();
    const original = text(deps, CONFIG);
    const spec: UpgradeSpec = {
      ...currentSpec,
      config: configAt(3, [step('schema', 1, { two: true }), step('schema', 2, { three: true })]),
    };
    const output = success(await upgrade(deps, spec));
    const written = parseJsonText(text(deps, CONFIG));
    expect(written.ok && written.value).toMatchObject({ schema: 3, two: true, three: true, node: { id: 'demo' } });
    expect(lineTexts(output)).toContain('factory.yaml: schema 1 to 3 (2 steps)');
    expect(output.json).toMatchObject({ config: { from: 1, to: 3 }, committed: false });
    expect(text(deps, `${BACKUP}/factory.yaml`)).toBe(original);
    expect(gitSince()).toEqual([]);
  });

  it('migrates the state and records the new block versions in one file', async () => {
    const { deps } = await makeNode();
    const spec: UpgradeSpec = {
      config: currentSpec.config,
      state: stateAt(2, [step('schema_version', 1, { note: 'x' })]),
      blocks: withBlock('safety', 2, 'New safety text.'),
    };
    const output = success(await upgrade(deps, spec));
    const state = parseJsonText(text(deps, NODE_JSON));
    expect(state.ok && state.value).toMatchObject({
      schema_version: 2,
      note: 'x',
      blocks: { coordinator: 1, safety: 2, protocol: 1 },
    });
    expect(output.json).toMatchObject({ committed: true, state: { from: 1, to: 2 } });
  });

  it('writes the config last', async () => {
    const { deps } = await makeNode();
    const first = deps.atomicWrites.length;
    const spec: UpgradeSpec = {
      config: configAt(2, [step('schema', 1)]),
      state: stateAt(2, [step('schema_version', 1)]),
      blocks: withBlock('coordinator', 2, 'New coordinator text.'),
    };
    success(await upgrade(deps, spec));
    expect(deps.atomicWrites.slice(first)).toEqual([CLAUDE, NODE_JSON, CONFIG]);
  });

  it('fails on a gap in the chain, before it makes a backup', async () => {
    const { deps } = await makeNode();
    const before = snapshot(deps);
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(3, [step('schema', 1)]) };
    const error = refusal(await upgrade(deps, spec));
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('factory.yaml: no migration from version 2');
    expect(snapshot(deps)).toEqual(before);
  });

  it('stops at a failing step, changes no file and keeps the backup', async () => {
    const { deps, gitSince } = await makeNode();
    const original = text(deps, CONFIG);
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(3, [step('schema', 1), brokenStep(2)]) };
    const error = refusal(await upgrade(deps, spec));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('factory.yaml: migration from version 2 to 3 failed: boom');
    expect(error.message).toContain('The files are as they were.');
    expect(error.message).toContain('.factory/backups/2030-01-02T03-04-05-678Z');
    expect(text(deps, CONFIG)).toBe(original);
    expect(text(deps, `${BACKUP}/factory.yaml`)).toBe(original);
    expect(gitSince()).toEqual([]);
  });

  it('fails when the migrated value does not pass the schema, and names the key', async () => {
    const { deps } = await makeNode();
    const original = text(deps, CONFIG);
    const sloppy: Migration = { from: 2, to: 3, apply: (raw) => ok(raw) };
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(3, [step('schema', 1), sloppy]) };
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

describe('upgrade: when a step fails after the backup', () => {
  const newer = blocksSpec(withBlock('coordinator', 2, 'New coordinator text.'));

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
    deps.files.delete(PROTOCOL);
    refusal(await upgrade(deps, currentSpec, { overwrite: ['protocol'] }));
    expect(deps.files.has(PROTOCOL)).toBe(false);
  });
});

describe('upgrade: before it changes anything', () => {
  const newer = blocksSpec(withBlock('coordinator', 2, 'New coordinator text.'));

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
    const spec: UpgradeSpec = { ...currentSpec, config: configAt(2, [step('schema', 1)]) };
    expect(success(await upgrade(deps, spec)).json).toMatchObject({ changed: true, committed: false });
  });

  it('fails when the state file is missing, invalid or unreadable', async () => {
    const { deps } = await makeNode();
    deps.files.delete(NODE_JSON);
    expect(refusal(await upgrade(deps)).message).toBe('.factory/node.json not found');
    deps.files.set(NODE_JSON, '{');
    expect(refusal(await upgrade(deps)).message).toContain('does not parse');
    deps.files.set(NODE_JSON, '{"schema_version":1}');
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
