import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../src/cli/errors.js';
import { recipeHostFor } from '../../src/cli/recipe-host.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { commands } from '../../src/names.js';
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

    it('fails for a folder that holds no node', async () => {
      const located = await host.locateNode(nodeWith(), '/w/elsewhere', commands.version);
      expect(located.ok).toBe(false);
    });
  });

  describe('loadProject', () => {
    it('gives the only project of the node when the person names none', async () => {
      const project = await host.loadProject(nodeWith(), HOME, undefined);
      expect(project.ok && project.value.id).toBe('web');
    });

    it('gives the project that the person names', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, 'api');
      expect(project.ok && project.value.id).toBe('api');
      expect(project.ok && project.value.url).toBe('https://github.com/acme/api.git');
    });

    it('exits 2 and lists the projects when the node has more than one and the person names none', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, undefined);
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(2);
      expect(`${project.error.message} ${project.error.hint ?? ''}`).toContain('api, web');
    });

    it('exits 2 for a project that the config does not list', async () => {
      const project = await host.loadProject(nodeWith(withProjects(['api', 'web'])), HOME, 'other');
      expect(project.ok).toBe(false);
      if (project.ok) return;
      expect(exitCodeFor(project.error)).toBe(2);
      expect(project.error.message).toContain('"other"');
    });

    it('exits 2 when the node lists no project', async () => {
      const project = await host.loadProject(nodeWith(withProjects([])), HOME, undefined);
      expect(project.ok).toBe(false);
      if (!project.ok) expect(exitCodeFor(project.error)).toBe(2);
    });

    it('fails when the config of the node cannot be read', async () => {
      const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' } });
      const project = await host.loadProject(deps, HOME, undefined);
      expect(project.ok).toBe(false);
    });
  });
});
