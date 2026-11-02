import { posix } from 'node:path';
import { z } from 'zod';
import { branchName, slug, uniqueIds } from '../../config/primitives.js';
import { keys, roles, values } from '../../names.js';

const MAX_PROJECTS = 100;

const isProjectPath = (value: string): boolean => {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('~') || posix.isAbsolute(value)) {
    return false;
  }
  return posix.normalize(value).split('/').filter((part) => part === '..').length <= 1;
};

const variantSchema = z.enum(values.variants, { error: `must be one of: ${values.variants.join(', ')}` });

const projectSchema = z.strictObject({
  [keys.project.id]: slug,
  [keys.project.repo]: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, `must look like ${roles.owner}/name`)
    .optional(),
  [keys.project.path]: z
    .string()
    .min(1)
    .max(4096)
    .refine(isProjectPath, {
      error: `must be a relative path that does not leave the parent folder of the ${roles.node} home`,
    }),
  [keys.project.defaultBranch]: branchName,
  [keys.project.mergeMethod]: z.enum(values.mergeMethods, {
    error: `must be one of: ${values.mergeMethods.join(', ')}`,
  }),
  [keys.project.variant]: variantSchema.optional(),
  [keys.project.gate]: z.strictObject({ [keys.gate.checks]: z.array(z.string().min(1).max(500)).max(50) }),
  [keys.project.heavyTest]: z.string().min(1).max(500).optional(),
});

/** The `recipe` block of the software recipe. The core gives the whole block to this parser. */
export const softwareRecipeSchema = z
  .strictObject({
    [keys.recipe.id]: z.literal(values.recipes[0]),
    [keys.recipe.variant]: variantSchema,
    [keys.recipe.projects]: z.array(projectSchema).max(MAX_PROJECTS),
  })
  .superRefine((recipe, ctx) => {
    uniqueIds(ctx, [keys.recipe.projects], keys.project.id, recipe.projects);
  });

export type SoftwareRecipe = z.infer<typeof softwareRecipeSchema>;
export type ProjectConfig = SoftwareRecipe[typeof keys.recipe.projects][number];
