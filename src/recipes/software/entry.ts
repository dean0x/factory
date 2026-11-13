import { keys, values } from '../../names.js';
import type { RecipeEntry } from '../entry.js';
import { softwareApprovalPoints } from './approval.js';
import { softwareBoard } from './board.js';
import { softwareRecipeSchema } from './config.js';
import { softwareRecordCheck } from './record.js';
import { softwareRoles } from './recipe.js';
import {
  mergeMethods,
  softwareGlossary,
  softwareProjectKeys,
  softwareSafetyLines,
  softwareWordList,
} from './words.js';

/** The software recipe: its block parser, its approval points, its words, its roles, its board and its record check. */
export const softwareRecipe: RecipeEntry = {
  id: values.recipes[0],
  schema: softwareRecipeSchema,
  approvalPoints: softwareApprovalPoints,
  words: softwareWordList,
  glossary: softwareGlossary,
  safetyLines: softwareSafetyLines,
  projectKeys: [softwareProjectKeys.mergeMethod],
  projectDefaults: { [softwareProjectKeys.mergeMethod]: mergeMethods[0] },
  initProjectKeys: [keys.project.url, keys.project.repo, keys.project.defaultBranch, keys.project.gate],
  roles: softwareRoles,
  board: softwareBoard,
  recordCheck: softwareRecordCheck,
};
