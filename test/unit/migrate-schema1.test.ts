import { describe, expect, it } from 'vitest';
import { parseYamlText } from '../../src/config/load.js';
import { configSchema } from '../../src/config/schema.js';
import { configMigrations } from '../../src/migrate/config.js';
import { fileSteps, stepsBetween } from '../../src/migrate/files.js';
import { planMigrations, runMigrations } from '../../src/migrate/runner.js';
import { stateMigrations } from '../../src/migrate/state.js';
import { nodeStateSchema } from '../../src/state/schema.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { schema1Doc } from '../helpers/schema1.js';

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

  it('gives a document that the schema 2 parser reads as the sample config', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    const parsed = configSchema.safeParse(migrated);
    expect(parsed.success && parsed.data).toEqual(sampleConfig());
  });

  it('turns the role into layer 1 and renames lanes to cells', () => {
    const doc = schema1Doc();
    doc.lanes = { 'cell-a': { proxy: 'none' } };
    const migrated = valueOf(migrateConfig(doc));
    expect(migrated.node).toEqual({ id: 'demo', layer: 1 });
    expect(migrated.cells).toEqual({ 'cell-a': { proxy: 'none' } });
    expect(migrated).not.toHaveProperty('lanes');
  });

  it('moves the projects into the software recipe and drops the pack of each project', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    expect(migrated.recipe).toMatchObject({ id: 'software', variant: 'plain' });
    expect(migrated.recipe.projects).toHaveLength(1);
    expect(migrated.recipe.projects[0]).not.toHaveProperty('pack');
    expect(migrated.recipe.projects[0]).not.toHaveProperty('variant');
    expect(migrated).not.toHaveProperty('projects');
  });

  it('keeps a project variant only when the pack differs from the recipe variant', () => {
    const doc = schema1Doc();
    doc.projects[0].pack = 'other';
    const migrated = valueOf(migrateConfig(doc));
    expect(migrated.recipe.projects[0].variant).toBe('other');
    const parsed = configSchema.safeParse(migrated);
    expect(parsed.success).toBe(false);
  });

  it('adds a local tracker, the approval of each merge, and no parent', () => {
    const migrated = valueOf(migrateConfig(schema1Doc()));
    expect(migrated.tracker).toEqual({ kind: 'local' });
    expect(migrated.approval).toEqual({ land: 'each' });
    expect(migrated.parent).toBeNull();
    expect(migrated.schema).toBe(2);
  });

  it('stops when a node on layer 1 lists a child, also with a file address, and gives the remedy', () => {
    const doc = schema1Doc();
    doc.children = [{ id: 'team-a', address: 'file:///work/team-a' }];
    const message = messageOf(migrateConfig(doc));
    expect(message).toContain('children');
    expect(message).toContain('cells');
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
    doc.lanes = { 'cell-a': { proxy: 'none' } };
    const before = JSON.parse(JSON.stringify(doc)) as unknown;
    migrateConfig(doc);
    expect(doc).toEqual(before);
  });

  it('refuses a role other than coordinator', () => {
    const doc = schema1Doc();
    doc.node.role = 'worker';
    expect(messageOf(migrateConfig(doc))).toContain('node.role');
  });

  it.each(['cells', 'tracker', 'approval', 'recipe', 'parent'])('refuses a schema 1 document that holds %s', (key) => {
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
    const parsed = configSchema.safeParse(migrated);
    expect(parsed.success).toBe(false);
  });
});

describe('config migration on the text, schema 1 to 2', () => {
  const [step] = configMigrations;

  const migrateText = (text: string) => {
    const applied = step?.applyText?.(text);
    if (applied === undefined) throw new Error('the step has no text form');
    return applied;
  };

  const textOf = (text: string): string => {
    const migrated = migrateText(text);
    if (!migrated.ok) throw new Error(`expected success, got: ${migrated.error.message}`);
    return migrated.value;
  };

  const SOURCE = `# Top note.
schema: 1    # Version note.

# Between note.
node:
  id: demo
  role: "coordinator"    # Role note.

# Lanes note.
lanes:
  cell-a: { proxy: none }

# Projects note.
projects:
  - id: web
    path: "../web"
    default_branch: "main"
    merge_method: squash
    pack: other
    gate: { checks: [] }
  - id: api
    path: "../api"
    default_branch: "main"
    merge_method: squash
    pack: plain
    gate: { checks: [] }
`;

  it('gives the same value as the step on the value', () => {
    const raw = parseYamlText(SOURCE);
    if (!raw.ok) throw new Error(raw.error);
    const written = parseYamlText(textOf(SOURCE));
    expect(written.ok && written.value).toEqual(valueOf(migrateConfig(raw.value)));
  });

  it('keeps every comment, and puts the renamed keys where the old keys were', () => {
    const migrated = textOf(SOURCE);
    for (const note of ['# Top note.', '# Version note.', '# Between note.', '# Role note.', '# Lanes note.', '# Projects note.']) {
      expect(migrated).toContain(note);
    }
    const written = parseYamlText(migrated);
    expect(written.ok && Object.keys(written.value as object)).toEqual([
      'schema',
      'node',
      'cells',
      'recipe',
      'tracker',
      'approval',
      'parent',
    ]);
    expect(migrated.indexOf('# Lanes note.')).toBeLessThan(migrated.indexOf('cells:'));
    expect(migrated.indexOf('# Projects note.')).toBeLessThan(migrated.indexOf('recipe:'));
  });

  it('turns the pack of a project into a variant only when it differs, in the place of the pack', () => {
    const written = parseYamlText(textOf(SOURCE));
    const recipe = (written.ok ? (written.value as Record<string, any>)['recipe'] : {}) as Record<string, any>;
    expect(Object.keys(recipe['projects'][0])).toEqual(['id', 'path', 'default_branch', 'merge_method', 'variant', 'gate']);
    expect(recipe['projects'][0]['variant']).toBe('other');
    expect(recipe['projects'][1]).not.toHaveProperty('variant');
    expect(recipe['projects'][1]).not.toHaveProperty('pack');
  });

  it('makes the role a number, also when the role was quoted', () => {
    const written = parseYamlText(textOf(SOURCE));
    expect(written.ok && (written.value as Record<string, any>)['node']).toEqual({ id: 'demo', layer: 1 });
    expect(written.ok && (written.value as Record<string, any>)['schema']).toBe(2);
  });

  it('refuses text that does not parse, and a role other than coordinator, without the text in the message', () => {
    const broken = migrateText('schema: 1\nnode: [SECRET-TOKEN\n');
    expect(!broken.ok && broken.error.message).not.toContain('SECRET-TOKEN');
    expect(broken.ok).toBe(false);
    const worker = migrateText(SOURCE.replace('"coordinator"', 'worker'));
    expect(!worker.ok && worker.error.message).toContain('node.role');
  });

  it('refuses a document that holds a key of schema 2', () => {
    const migrated = migrateText(`${SOURCE}tracker: { kind: local }\n`);
    expect(!migrated.ok && migrated.error.message).toContain('tracker');
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

  it('picks the steps between two versions', () => {
    expect(stepsBetween(fileSteps, 1, 2)).toEqual(fileSteps);
    expect(stepsBetween(fileSteps, 2, 2)).toEqual([]);
    expect(stepsBetween(fileSteps, 1, 1)).toEqual([]);
  });

  it('puts the steps in the order of their versions', () => {
    const later = { from: 2, to: 3, moves: [], renames: [] };
    const steps = [later, ...fileSteps];
    expect(stepsBetween(steps, 1, 3).map((step) => step.from)).toEqual([1, 2]);
  });
});
