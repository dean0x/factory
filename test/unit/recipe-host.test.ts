import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli/errors.js';
import { recipeHostFor } from '../../src/cli/recipe-host.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { commands, files } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { HOME, NODE } from '../helpers/slot-fixture.js';

const host = recipeHostFor(recipes);

const withProjects = (ids: readonly string[]): FactoryConfig => {
  const sample = sampleConfig();
  const [first] = sample.recipe.projects;
  if (first === undefined) throw new Error('the sample config holds no project');
  return {
    ...sample,
    recipe: { ...sample.recipe, projects: ids.map((id) => ({ ...first, id, path: id, url: `https://github.com/acme/${id}.git` })) },
  };
};

const nodeWith = (config: FactoryConfig = sampleConfig()): FakeDeps => {
  const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' } });
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, NODE);
  return deps;
};

describe('the host object of a recipe', () => {
  it('holds the registry that the command table was built from', () => {
    expect(host.registry).toBe(recipes);
  });

  describe('locateNode', () => {
    it('gives the folder of the node that the home flag names', async () => {
      const located = await host.locateNode(nodeWith(), HOME, commands.version);
      expect(located).toEqual({ ok: true, value: HOME });
    });

    it('exits 1 for a folder that holds no node, and names the command to run again', async () => {
      const located = await host.locateNode(nodeWith(), '/w/elsewhere', commands.version);
      expect(located.ok).toBe(false);
      if (located.ok) return;
      expect(exitCodeFor(located.error)).toBe(1);
      expect(located.error.message).toContain('/w/elsewhere is not a folder');
      expect(located.error.hint).toContain('"factory version" again');
    });
  });

  describe('loadProject', () => {
    it('gives the only project of the node when the person names none', async () => {
      const project = await host.loadProject(nodeWith(), HOME, undefined, commands.version);
      expect(project.ok && project.value.id).toBe('web');
    });

    it('gives the project that the person names', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, 'api', commands.version);
      expect(project.ok && project.value.id).toBe('api');
      expect(project.ok && project.value.url).toBe('https://github.com/acme/api.git');
    });

    it('exits 2 and lists the projects when the node has more than one and the person names none', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, undefined, commands.version);
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(2);
      expect(project.error.hint).toContain('api, web');
      expect(project.error.hint).toContain('Run "factory version" again with --project PROJECT.');
    });

    it('exits 2 for a project that the config does not list, and names the listed projects and the command to run again', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, 'other', commands.version);
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(2);
      expect(project.error.message).toContain('"other"');
      expect(project.error.hint).toContain('api, web');
      expect(project.error.hint).toContain('"factory version"');
    });

    it('exits 2 when the node lists no project, and names the command to run again', async () => {
      const project = await host.loadProject(nodeWith(withProjects([])), HOME, undefined, commands.version);
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(2);
      expect(project.error.hint).toContain('"factory version"');
    });

    it('exits 1 when the config of the node cannot be read, and names the file', async () => {
      const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' } });
      const project = await host.loadProject(deps, HOME, undefined, commands.version);
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(1);
      expect(project.error.message).toBe(`${files.config} not found`);
    });
  });
});
