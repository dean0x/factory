import type { RecipeRegistry } from './entry.js';
import { softwareRecipe } from './software/entry.js';

export * from './entry.js';

/**
 * Every recipe of the package. The core reads only the id of the `recipe` block, checks it against the registry
 * that a command gets as a parameter, and gives the whole block to the parser of that recipe.
 */
export const recipes: RecipeRegistry = [softwareRecipe];
