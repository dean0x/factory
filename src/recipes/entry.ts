import type { z } from 'zod';
import { keys, values } from '../names.js';
import type { BlockInput, BlockTemplate } from '../templates/types.js';

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

/**
 * One project of the `recipe` block, as the core reads it. A recipe adds keys of its own, and its entry names them in
 * `projectKeys`. The other keys are optional, because a recipe can leave them out.
 */
export interface RecipeProject {
  readonly id: string;
  readonly path: string;
  readonly url?: string | undefined;
  readonly repo?: string | undefined;
  readonly default_branch?: string | undefined;
  readonly variant?: string | undefined;
  readonly gate?: { readonly checks: readonly string[] } | undefined;
  readonly heavy_test?: string | undefined;
  readonly [key: string]: unknown;
}

/** The keys of a project that `init` fills from the clone and its origin. A recipe holds each of them or none. */
export type InitProjectKey =
  | typeof keys.project.url
  | typeof keys.project.repo
  | typeof keys.project.defaultBranch
  | typeof keys.project.gate;

/** The parsed `recipe` block, as the core reads it. */
export interface RecipeConfig {
  readonly id: string;
  readonly variant: string;
  readonly projects: readonly RecipeProject[];
}

/** One entry of the glossary of a recipe. The text holds placeholders such as {{owner}}. */
export interface GlossaryEntry {
  readonly term: string;
  readonly text: string;
}

/** How a recipe sets the role of each layer. */
export interface RecipeRoles {
  /** The name of the role block of a layer, or null when the layer has no role. */
  readonly nameForLayer: (layer: number) => string | null;
  /** The role block of the layer of `input`, or null when the layer has no role. */
  readonly templateFor: (input: BlockInput) => BlockTemplate | null;
  /** The role blocks that a node home can hold in its CLAUDE.md. */
  readonly homeBlockNames: readonly string[];
}

/**
 * What the core needs from a recipe. The core reads no other file of a recipe: it gets the entry from the registry.
 * - `schema` parses the `recipe` block of the shared file.
 * - `approvalPoints` lists the steps that need an approval.
 * - `words` lists the words that only this recipe uses. No core text holds one.
 * - `glossary` holds the plain description of each word of the recipe.
 * - `safetyLines` is the part of the safety block that belongs to the recipe.
 * - `projectKeys` names the keys that the recipe adds to a project, in the order of the file.
 * - `projectDefaults` gives the value of each of those keys for a new project.
 * - `initProjectKeys` names the keys of the core that `init` writes into a new project. A project of the recipe holds no other.
 * - `roles` sets the role of each layer.
 */
export interface RecipeEntry {
  readonly id: string;
  readonly schema: z.ZodType<RecipeConfig>;
  readonly approvalPoints: readonly ApprovalPoint[];
  readonly words: readonly string[];
  readonly glossary: readonly GlossaryEntry[];
  readonly safetyLines: readonly string[];
  readonly projectKeys: readonly string[];
  readonly projectDefaults: Readonly<Record<string, string>>;
  readonly initProjectKeys: readonly InitProjectKey[];
  readonly roles: RecipeRoles;
}

/** The recipes of a package, in the order of their ids. The first one is the default. */
export type RecipeRegistry = readonly [RecipeEntry, ...RecipeEntry[]];

export const recipeIds = (registry: RecipeRegistry): readonly string[] => registry.map((entry) => entry.id);

export const findRecipe = (registry: RecipeRegistry, id: string): RecipeEntry | undefined =>
  registry.find((entry) => entry.id === id);

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
