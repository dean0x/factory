import { values } from '../../names.js';
import type { RecipeEntry } from '../entry.js';
import { softwareApprovalPoints } from './approval.js';
import { softwareRecipeSchema } from './config.js';
import { softwareRoles } from './recipe.js';
import {
  mergeMethods,
  softwareGlossary,
  softwareProjectKeys,
  softwareSafetyLines,
  softwareWordList,
} from './words.js';

/** The software recipe: its block parser, its approval points, its words and its roles. */
export const softwareRecipe: RecipeEntry = {
  id: values.recipes[0],
  schema: softwareRecipeSchema,
  approvalPoints: softwareApprovalPoints,
  words: softwareWordList,
  glossary: softwareGlossary,
  safetyLines: softwareSafetyLines,
  projectKeys: [softwareProjectKeys.mergeMethod],
  projectDefaults: { [softwareProjectKeys.mergeMethod]: mergeMethods[0] },
  roles: softwareRoles,
};
