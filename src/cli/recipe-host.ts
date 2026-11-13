import { loadConfig, readNodeIdentity } from '../config/load.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { files, flags, flagText, roles } from '../names.js';
import type { RecipeHost, RecipeProject, RecipeRegistry } from '../recipes/index.js';
import { usageError, type CliResult } from './errors.js';

const listedIds = (projects: readonly RecipeProject[]): string => projects.map((project) => project.id).join(', ');

/** The project that the id names. Without an id, the only project of the node. */
const projectOf = (projects: readonly RecipeProject[], projectId: string | undefined): CliResult<RecipeProject> => {
  if (projectId !== undefined) {
    const named = projects.find((candidate) => candidate.id === projectId);
    return named === undefined
      ? usageError(
          `the project ${JSON.stringify(projectId)} is not listed in the config of this ${roles.node}`,
          projects.length === 0 ? `The config lists no project.` : `The listed projects are: ${listedIds(projects)}.`,
        )
      : ok(named);
  }
  const [only, ...others] = projects;
  if (only === undefined) {
    return usageError(`the config of this ${roles.node} lists no project`, `Add a project to ${files.config}.`);
  }
  return others.length === 0
    ? ok(only)
    : usageError(
        `this ${roles.node} lists more than one project, so the command needs ${flagText(flags.project)}`,
        `The listed projects are: ${listedIds(projects)}. Run the command again with ${flagText(flags.project)} PROJECT.`,
      );
};

/**
 * The host object that the command table gives to the `commands` hook of each recipe. It carries the node lookup and the config
 * loader into the recipe, so a recipe imports neither.
 */
export const recipeHostFor = (registry: RecipeRegistry): RecipeHost => ({
  registry,
  locateNode: async (deps, home, command) => {
    const located = await locateHomeFolder(deps, home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), command);
    return located.ok ? ok(located.value.home) : located;
  },
  loadProject: async (deps, home, projectId) => {
    const config = await loadConfig(deps, home, registry);
    return config.ok ? projectOf(config.value.recipe.projects, projectId) : config;
  },
});
