import { guardOf, textRow } from '../../src/guards/build.js';
import type { RecipeEntry, RecipeRegistry } from '../../src/recipes/entry.js';
import { softwareRecipe } from '../../src/recipes/software/entry.js';

/**
 * A guard that only the tests know. Every guard of the package is wired, so a test of the path of a guard that this version cannot set
 * uses this guard: it is not wired, and it has one text row with no site.
 */
export const UNWIRED_GUARD = 'test-unsettable';

/** The software recipe with the test guard and its row after the guards and rows of the recipe. */
export const unwiredRecipe: RecipeEntry = {
  ...softwareRecipe,
  guards: [...softwareRecipe.guards, guardOf(UNWIRED_GUARD, 'Test guard', 'Test work stays safe.')],
  guardRows: [
    ...softwareRecipe.guardRows,
    textRow({ id: 'test-unsettable-text', guard: UNWIRED_GUARD, name: 'Test work stays safe', applies: 'Tests', harm: true, sites: [] }),
  ],
};

/** A registry with the recipe of the test guard in place of the software recipe. */
export const unwiredRegistry: RecipeRegistry = [unwiredRecipe];
