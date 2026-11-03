import { z } from 'zod';
import { branchName, slug, uniqueIds } from '../../config/primitives.js';
import { checkProjectUrl, describeCloneIssue, normalFormOf } from '../../core/clone-url.js';
import { describeProjectPathIssue, projectFolderKey, projectPathIssue } from '../../core/project-path.js';
import { keys, roles, values } from '../../names.js';

const MAX_PROJECTS = 100;
/** The longest name of a folder that common file systems accept. */
const MAX_FOLDER_NAME_CHARS = 255;

/** The path of a project: one folder name inside the root, and not a reserved name (design 4.3). */
const projectPathSchema = z
  .string()
  .min(1)
  .max(MAX_FOLDER_NAME_CHARS)
  .superRefine((value, ctx) => {
    const issue = projectPathIssue(value);
    if (issue !== null) ctx.addIssue({ code: 'custom', message: describeProjectPathIssue(issue) });
  });

const variantSchema = z.enum(values.variants, { error: `must be one of: ${values.variants.join(', ')}` });

/** The clone URL of a project. The rules protect secrets, because the shared file goes to every machine. */
const cloneUrlSchema = z.string().superRefine((value, ctx) => {
  const checked = checkProjectUrl(value);
  if (!checked.ok) ctx.addIssue({ code: 'custom', message: describeCloneIssue(checked.error) });
});

const projectSchema = z.strictObject({
  [keys.project.id]: slug,
  [keys.project.url]: cloneUrlSchema.optional(),
  [keys.project.repo]: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, `must look like ${roles.owner}/name`)
    .optional(),
  [keys.project.path]: projectPathSchema,
  [keys.project.defaultBranch]: branchName,
  [keys.project.mergeMethod]: z.enum(values.mergeMethods, {
    error: `must be one of: ${values.mergeMethods.join(', ')}`,
  }),
  [keys.project.variant]: variantSchema.optional(),
  [keys.project.gate]: z.strictObject({ [keys.gate.checks]: z.array(z.string().min(1).max(500)).max(50) }),
  [keys.project.heavyTest]: z.string().min(1).max(500).optional(),
});

/** The normal form of a project URL, or null when the project has none or the URL does not parse. */
const normalUrlOf = (url: string | undefined): string | null => {
  const checked = url === undefined ? null : checkProjectUrl(url);
  return checked?.ok === true ? normalFormOf(checked.value) : null;
};

/**
 * Two projects can not share a repo, and they can not share a folder. A repo has one normal form for the scp form,
 * `ssh://` and `https://`. The message names the first project and never repeats the URL.
 */
const uniqueProjectTargets = (
  ctx: z.RefinementCtx,
  projects: readonly { readonly id: string; readonly path: string; readonly url?: string | undefined }[],
): void => {
  const urlOwners = new Map<string, string>();
  const pathOwners = new Map<string, string>();
  projects.forEach((project, index) => {
    const normal = normalUrlOf(project.url);
    const urlOwner = normal === null ? undefined : urlOwners.get(normal);
    if (normal !== null && urlOwner === undefined) urlOwners.set(normal, project.id);
    if (urlOwner !== undefined) {
      const message = `names the same repo as the project ${urlOwner}`;
      ctx.addIssue({ code: 'custom', message, path: [keys.recipe.projects, index, keys.project.url] });
    }
    const key = projectFolderKey(project.path);
    const pathOwner = pathOwners.get(key);
    if (pathOwner === undefined) pathOwners.set(key, project.id);
    else {
      const message = `names the same folder as the project ${pathOwner}`;
      ctx.addIssue({ code: 'custom', message, path: [keys.recipe.projects, index, keys.project.path] });
    }
  });
};

/** The `recipe` block of the software recipe. The core gives the whole block to this parser. */
export const softwareRecipeSchema = z
  .strictObject({
    [keys.recipe.id]: z.literal(values.recipes[0]),
    [keys.recipe.variant]: variantSchema,
    [keys.recipe.projects]: z.array(projectSchema).max(MAX_PROJECTS),
  })
  .superRefine((recipe, ctx) => {
    uniqueIds(ctx, [keys.recipe.projects], keys.project.id, recipe.projects);
    uniqueProjectTargets(ctx, recipe.projects);
  });

export type SoftwareRecipe = z.infer<typeof softwareRecipeSchema>;
export type ProjectConfig = SoftwareRecipe[typeof keys.recipe.projects][number];
