import type { z } from 'zod';
import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { boardKeys, keys, values } from '../names.js';
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
 * How a recipe sets up the board of items. The core holds no word of a recipe: it reads these values.
 * - `queueKey` is the key of the queue in `board.json`. Without it the key is the default of the core (`queueKeyOf`).
 * - `stages` lists the stages of an item, in order. A new item gets the first one. Without it the recipe has no stages.
 * - `flowOnly` maps a stage that only a flow sets to the name of that flow. Each key is a listed stage.
 *   No board command sets such a stage.
 */
export interface RecipeBoard {
  readonly queueKey?: string | undefined;
  readonly stages?: readonly string[] | undefined;
  readonly flowOnly?: Readonly<Record<string, string>> | undefined;
}

declare const checkedBrand: unique symbol;

/**
 * The result of a check that passed. Only the `check` of a `RecordCheck` makes one, so a value of this type proves that the check
 * of the recipe ran and passed. The core writes only this type into the board (`recordCheckedIn`).
 * - `stage` is the stage that the record sets on the item: a stage of the recipe.
 * - `ref` is the reference that the person typed, as the recipe checked it.
 * - `head` is the value that the item keeps under `boardKeys.mergedPrHead`.
 * - `summary` is one line of facts for the output and for the commit message.
 */
export interface CheckedRecord {
  readonly [checkedBrand]: true;
  readonly stage: string;
  readonly ref: string;
  readonly head: string;
  readonly summary: string;
}

/**
 * What the core gives the check of a recipe. The core found the project and the branch from the item: the project comes from the
 * record of the worker that the item names, or from the project flag, and the branch is the branch of that worker.
 */
export interface RecordCheckInput {
  /** The reference as the person typed it. */
  readonly ref: string;
  readonly project: RecipeProject;
  /** The folder of the clone of the project. */
  readonly cloneDir: string;
  /** The branch of the worker that the item names, or undefined when the item names none. */
  readonly branch: string | undefined;
}

/**
 * The record check of a recipe: how `item record` proves that the work of an item is done, before the board records it. The core
 * keeps the locked write, the queue clean-up, the kept head, the worker binding and the rerun. The recipe keeps what is checked
 * and the words for it.
 * - `stage` is the stage that a passed check sets. The recipe must list it.
 * - `summary` is the part of the help of `item` that says what the recipe records.
 * - `refHelp` is the help of the reference flag for this recipe.
 * - `parseRef` checks the reference before the board is read. A bad reference is a usage error (exit 2).
 * - `check` reads the proof and gives a `CheckedRecord`, or a failure (exit 1) for every fault and every mismatch.
 */
export interface RecordCheck {
  readonly stage: string;
  readonly summary: string;
  readonly refHelp: string;
  readonly parseRef: (text: string) => CliResult<string>;
  readonly check: (deps: Deps, input: RecordCheckInput) => Promise<CliResult<CheckedRecord>>;
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
 * - `board` sets the queue key and the stages of the board.
 * - `recordCheck` is the check that `item record` runs. A recipe with none makes that command a usage error.
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
  readonly board: RecipeBoard;
  readonly recordCheck?: RecordCheck | undefined;
}

/** The key of the queue in `board.json`: the key of the recipe, or the default of the core when the recipe gives none. */
export const queueKeyOf = (recipe: RecipeEntry): string => recipe.board.queueKey ?? boardKeys.defaultQueue;

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
