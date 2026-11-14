import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/blocks/managed.js';
import { localConfigSchema, splitConfigValue } from '../../src/config/schema.js';
import { sharedConfigSchema } from '../helpers/package-registry.js';
import { configMigrations } from '../../src/migrate/config.js';
import { fileSteps, stepsBetween } from '../../src/migrate/files.js';
import { planMigrations, runMigrations } from '../../src/migrate/runner.js';
import { stateMigrations } from '../../src/migrate/state.js';
import { nodeStateSchema } from '../../src/state/schema.js';
import { fileTemplates } from '../../src/templates/index.js';
import { parseMixed, sampleConfig } from '../helpers/sample-config.js';
import { OLD_ROADMAPS_README, schema1Doc, schema1DocWithProject, schema1Project } from '../helpers/schema1.js';

const migrateConfig = (raw: unknown) => {
  const steps = planMigrations(1, 2, configMigrations);
  if (!steps.ok) throw new Error(steps.error.message);
  return runMigrations(raw, steps.value);
};

const migrateState = (raw: unknown) => {
  const steps = planMigrations(1, 2, stateMigrations);
  if (!steps.ok) throw new Error(steps.error.message);
  return runMigrations(raw, steps.value);
};

const valueOf = (result: ReturnType<typeof migrateConfig>): Record<string, any> => {
  if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value as Record<string, any>;
};

const messageOf = (result: ReturnType<typeof migrateConfig>): string => {
  if (result.ok) throw new Error('expected an error');
  return result.error.message;
};

describe('config migration, schema 1 to 2', () => {
  it('has one step from 1 to 2', () => {
    expect(configMigrations.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
  });

  it('gives a document that the schema 2 parser reads as the sample config with no project', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    const parsed = parseMixed(migrated);
    const sample = sampleConfig();
    expect(parsed.success && parsed.data).toEqual({ ...sample, recipe: { ...sample.recipe, projects: [] } });
  });

  it('turns the role into layer 1 and renames lanes to workers', () => {
    const doc = schema1Doc();
    doc.lanes = { 'worker-a': { proxy: 'none' } };
    const migrated = valueOf(migrateConfig(doc));
    expect(migrated.node).toEqual({ id: 'demo', layer: 1 });
    expect(migrated.workers).toEqual({ 'worker-a': { proxy: 'none' } });
    expect(migrated).not.toHaveProperty('lanes');
  });

  it('moves the empty project list into the software recipe', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    expect(migrated.recipe).toEqual({ id: 'software', variant: 'plain', projects: [] });
    expect(migrated).not.toHaveProperty('projects');
  });

  it('upgrades a node that has no projects key at all', () => {
    const doc = schema1Doc();
    delete doc.projects;
    const migrated = valueOf(migrateConfig(doc));
    expect(migrated.recipe).toEqual({ id: 'software', variant: 'plain', projects: [] });
    expect(parseMixed(migrated).success).toBe(true);
  });

  describe('a node that lists a project', () => {
    it('stops with a failure, says to make the node again with init, and gives no value', () => {
      const result = migrateConfig(schema1DocWithProject());
      expect(result.ok).toBe(false);
      const message = messageOf(result);
      expect(message).toContain('lists a project');
      expect(message).toContain('has no clone URL');
      expect(message).toContain('make the node again');
      expect(message).toContain('factory init');
    });

    it('stops for any number of projects, and does not repeat a path or an id', () => {
      const doc = schema1Doc();
      doc.projects = [
        { ...schema1Project(), id: 'secret-id', path: '../secret-path' },
        { ...schema1Project(), id: 'other', path: '../other' },
      ];
      const message = messageOf(migrateConfig(doc));
      expect(message).toContain('lists a project');
      expect(message).not.toContain('secret-id');
      expect(message).not.toContain('secret-path');
    });

    it('stops before the other checks of the projects, so a project that is not a mapping stops it too', () => {
      const doc = schema1Doc();
      doc.projects = ['web'];
      expect(messageOf(migrateConfig(doc))).toContain('lists a project');
    });

    it('does not change its input', () => {
      const doc = schema1DocWithProject();
      const before = JSON.parse(JSON.stringify(doc)) as unknown;
      migrateConfig(doc);
      expect(doc).toEqual(before);
    });
  });

  it('adds a local tracker and no parent, and no approval: the local file names the modes', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    expect(migrated.tracker).toEqual({ kind: 'local' });
    expect(migrated).not.toHaveProperty('approval');
    expect(migrated.parent).toBeNull();
    expect(migrated.schema).toBe(2);
  });

  it('gives a value that splits into a valid shared file and a valid local file', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    const { shared, local } = splitConfigValue(migrated);
    expect(sharedConfigSchema.safeParse(shared).success).toBe(true);
    expect(localConfigSchema.safeParse(local).success).toBe(true);
    expect(parseMixed(migrated).success).toBe(true);
  });

  it('stops when a node on layer 1 lists a child, also with a file address, and gives the remedy', () => {
    const doc = schema1Doc();
    doc.children = [{ id: 'team-a', address: 'file:///work/team-a' }];
    const message = messageOf(migrateConfig(doc));
    expect(message).toContain('children');
    expect(message).toContain('workers');
    expect(message).toContain('node.layer');
    expect(message).toContain('factory node add-child');
    expect(message).not.toContain('team-a');
    expect(message).not.toContain('/work/');
  });

  it.each([
    ['an ssh address', 'ssh://deploy:SECRET-TOKEN@host/work'],
    ['an https address', 'https://example.com/node'],
    ['a relative path', '../team-a'],
    ['a host', 'file://host/work'],
    ['a .. segment', 'file:///work/../etc'],
    ['a percent sign', 'file:///work/a%20b'],
    ['a query', 'file:///work?x=1'],
  ])('stops and names the child when its address is %s', (_label, address) => {
    const doc = schema1Doc();
    doc.children = [
      { id: 'team-a', address: 'file:///work/team-a' },
      { id: 'team-b', address },
    ];
    const message = messageOf(migrateConfig(doc));
    expect(message).toContain('children[1]');
    expect(message).toContain('"team-b"');
    expect(message).not.toContain('SECRET-TOKEN');
    expect(message).not.toContain(address);
  });

  it('does not change its input', () => {
    const doc = schema1Doc();
    doc.lanes = { 'worker-a': { proxy: 'none' } };
    const before = JSON.parse(JSON.stringify(doc)) as unknown;
    migrateConfig(doc);
    expect(doc).toEqual(before);
  });

  it('refuses a role other than coordinator', () => {
    const doc = schema1Doc();
    doc.node.role = 'worker';
    expect(messageOf(migrateConfig(doc))).toContain('node.role');
  });

  it.each(['workers', 'tracker', 'approval', 'recipe', 'parent'])('refuses a schema 1 document that holds %s', (key) => {
    const doc = schema1Doc();
    doc[key] = {};
    expect(messageOf(migrateConfig(doc))).toContain(key);
  });

  it('refuses a document and a node that are not mappings', () => {
    expect(messageOf(migrateConfig('text'))).toContain('mapping');
    const doc = schema1Doc();
    doc.node = 'demo';
    expect(messageOf(migrateConfig(doc))).toContain('node');
  });

  it('refuses projects and children that are not lists', () => {
    const projects = schema1Doc();
    projects.projects = {};
    expect(messageOf(migrateConfig(projects))).toContain('projects');
    const children = schema1Doc();
    children.children = 'none';
    expect(messageOf(migrateConfig(children))).toContain('children');
  });

  it('leaves an unknown key for the schema 2 parser to name', () => {
    const doc = schema1Doc();
    doc.extra = 1;
    const migrated = valueOf(migrateConfig(doc));
    const parsed = parseMixed(migrated);
    expect(parsed.success).toBe(false);
  });
});

describe('config migration, the form of the step', () => {
  it('is a pure step on one value, with no step on the text: the upgrade splits the value into two files', () => {
    expect(configMigrations.every((step) => step.applyText === undefined)).toBe(true);
  });
});

describe('state migration, schema 1 to 2', () => {
  const state = (blocks: Record<string, number>) => ({ schema_version: 1, created_with: '0.1.0', blocks });

  it('has one step from 1 to 2', () => {
    expect(stateMigrations.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
  });

  it('raises the version and renames the protocol block to worker with its version', () => {
    const result = migrateState(state({ coordinator: 1, safety: 1, protocol: 3 }));
    expect(result).toEqual({
      ok: true,
      value: { schema_version: 2, created_with: '0.1.0', blocks: { coordinator: 1, safety: 1, worker: 3 } },
    });
    expect(result.ok && nodeStateSchema.safeParse(result.value).success).toBe(true);
  });

  it('keeps the blocks when there is no protocol block', () => {
    const result = migrateState(state({ coordinator: 1 }));
    expect(result).toEqual({
      ok: true,
      value: { schema_version: 2, created_with: '0.1.0', blocks: { coordinator: 1 } },
    });
  });

  it('refuses a state that holds a worker block already', () => {
    const result = migrateState(state({ protocol: 1, worker: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('worker');
  });

  it('refuses a state that is not a mapping, and blocks that are not a mapping', () => {
    expect(migrateState([]).ok).toBe(false);
    expect(migrateState({ schema_version: 1, blocks: [] }).ok).toBe(false);
  });

  it('does not change its input', () => {
    const input = Object.freeze(state({ protocol: 1 }));
    migrateState(input);
    expect(input.blocks).toEqual({ protocol: 1 });
  });
});

describe('file steps', () => {
  it('moves the protocol file into roles as the worker file, and briefs to orders, at state 1 to 2', () => {
    expect(fileSteps).toHaveLength(1);
    const [step] = fileSteps;
    expect(step).toMatchObject({ from: 1, to: 2 });
    expect(step?.moves).toEqual([
      { from: 'protocol.md', to: 'roles/worker.md' },
      { from: 'briefs', to: 'orders' },
    ]);
    expect(step?.renames).toEqual([{ from: 'protocol', to: 'worker' }]);
  });

  it('replaces roadmaps/README.md with the new template, only while it holds the text of 0.1.0', () => {
    const [step] = fileSteps;
    expect(step?.replaces).toEqual([
      {
        path: 'roadmaps/README.md',
        oldSha256: sha256Hex(OLD_ROADMAPS_README),
        text: fileTemplates.roadmapsReadme,
      },
    ]);
    expect(step?.replaces[0]?.text).not.toBe(OLD_ROADMAPS_README);
  });

  it('picks the steps between two versions', () => {
    expect(stepsBetween(fileSteps, 1, 2)).toEqual(fileSteps);
    expect(stepsBetween(fileSteps, 2, 2)).toEqual([]);
    expect(stepsBetween(fileSteps, 1, 1)).toEqual([]);
  });

  it('puts the steps in the order of their versions', () => {
    const later = { from: 2, to: 3, moves: [], renames: [], replaces: [] };
    const steps = [later, ...fileSteps];
    expect(stepsBetween(steps, 1, 3).map((step) => step.from)).toEqual([1, 2]);
  });
});
