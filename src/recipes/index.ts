import type { z } from 'zod';
import { values } from '../names.js';
import { softwareRecipeSchema, type SoftwareRecipe } from './software/config.js';

export type RecipeId = (typeof values.recipes)[number];

/** The parsed `recipe` block. It becomes a union of the recipe types when the package holds more than one recipe. */
export type RecipeConfig = SoftwareRecipe;

/**
 * Every recipe of the package, by id. The core reads only the id of the `recipe` block,
 * checks it against this registry, and gives the whole block to the parser of that recipe.
 */
export const recipeSchemas: Readonly<Record<RecipeId, z.ZodType<RecipeConfig>>> = {
  [values.recipes[0]]: softwareRecipeSchema,
};
