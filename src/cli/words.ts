import { inspectSharedConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { glossary, recipeGlossary, type Word } from '../glossary.js';
import { commands, commandText, helpTopics, roles, schemaIds } from '../names.js';
import type { RecipeEntry, RecipeRegistry } from '../recipes/index.js';
import type { CommandOutput, OutLine } from './output.js';

/**
 * The recipe of the factory that the command finds from the current folder, or null. Help never fails: a folder with
 * no factory, a config that is not valid and a recipe that the registry does not hold all give null.
 */
const foundRecipe = async (deps: Deps, registry: RecipeRegistry): Promise<RecipeEntry | null> => {
  const located = await locateHomeFolder(
    deps,
    undefined,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.help,
  );
  if (!located.ok) return null;
  const shared = await inspectSharedConfig(deps, located.value.home, registry);
  return shared.kind === 'valid' ? shared.value.entry : null;
};

const wordLines = (words: readonly Word[]): readonly OutLine[] =>
  words.map((word) => ({ level: 'text' as const, text: `${word.term}: ${word.text}` }));

/**
 * The output of `factory help words`: the heading, one line for each term of every factory, then one part for the recipe
 * of the factory that the command finds. With no factory found, there is one part for each recipe of the registry.
 * A part has a heading with the name of the recipe, then one line for each word of the recipe.
 */
export const wordsOutput = async (deps: Deps, registry: RecipeRegistry): Promise<CommandOutput> => {
  const found = await foundRecipe(deps, registry);
  const shown = found === null ? registry : [found];
  const parts = shown.map((recipe) => ({ id: recipe.id, heading: `${recipe.id} ${roles.recipe}`, words: recipeGlossary(recipe) }));
  return {
    lines: [
      { level: 'heading', text: commandText(helpTopics.words) },
      ...wordLines(glossary),
      ...parts.flatMap((part) => [{ level: 'heading' as const, text: part.heading }, ...wordLines(part.words)]),
    ],
    json: {
      schema: schemaIds.words,
      words: glossary,
      recipes: parts.map((part) => ({ recipe: part.id, words: part.words })),
    },
    warnings: [],
    failed: false,
  };
};
