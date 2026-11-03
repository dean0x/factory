import type { z } from 'zod';
import { values } from '../names.js';
import { softwareApprovalPoints } from './software/approval.js';
import { softwareRecipeSchema, type SoftwareRecipe } from './software/config.js';

export type RecipeId = (typeof values.recipes)[number];

/** The parsed `recipe` block. It becomes a union of the recipe types when the package holds more than one recipe. */
export type RecipeConfig = SoftwareRecipe;

/** The mode of an approval point: `owner` or `delegated`. */
export type ApprovalMode = (typeof values.approvalModes)[number];

/** The mode of each approval point, by point id. A point that the map does not name is `owner`. */
export type ApprovalModes = Readonly<Record<string, ApprovalMode>>;

/**
 * A step of the work that needs an approval, as a recipe names it. The texts hold placeholders such as {{owner}}.
 * `ownerText` says what the text says when the point waits for the owner. `delegatedText` names the proof.
 */
export interface ApprovalPoint {
  readonly id: string;
  readonly label: string;
  readonly ownerText: string;
  readonly delegatedText: string;
  readonly proof: string;
}

/** What the core needs from a recipe: the parser of its `recipe` block and the list of its approval points. */
export interface RecipeEntry {
  readonly schema: z.ZodType<RecipeConfig>;
  readonly approvalPoints: readonly ApprovalPoint[];
}

/**
 * Every recipe of the package, by id. The core reads only the id of the `recipe` block,
 * checks it against this registry, and gives the whole block to the parser of that recipe.
 */
export const recipes: Readonly<Record<RecipeId, RecipeEntry>> = {
  [values.recipes[0]]: { schema: softwareRecipeSchema, approvalPoints: softwareApprovalPoints },
};

const [OWNER_MODE, DELEGATED_MODE] = values.approvalModes;

/** The modes of a list of points where every point waits for the owner. This is the default. */
export const ownerModes = (points: readonly ApprovalPoint[]): ApprovalModes =>
  Object.fromEntries(points.map((point) => [point.id, OWNER_MODE]));

/**
 * One line of text for each point, in the order of the recipe. The text follows the mode of the point,
 * and a point that the map does not name gets the `owner` text. The map can name a point that the list does not hold: it is left out.
 */
export const approvalLines = (points: readonly ApprovalPoint[], modes: ApprovalModes): readonly string[] =>
  points.map((point) => {
    const text = modes[point.id] === DELEGATED_MODE ? point.delegatedText : point.ownerText;
    return `- \`${point.id}\` (${point.label}): ${text}`;
  });
