import { describe, expect, it } from 'vitest';
import { boardKeys } from '../../src/names.js';
import { queueKeyOf, type RecipeEntry } from '../../src/recipes/entry.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareRecipe } from '../../src/recipes/software/entry.js';
import { publishRecipe } from '../helpers/publish-recipe.js';

const allRecipes: readonly RecipeEntry[] = [...recipes, publishRecipe];

describe('the board data of the software recipe', () => {
  it('lists the stages of an item in order', () => {
    expect(softwareRecipe.board.stages).toEqual([
      'ticket',
      'plan-approved',
      'building',
      'review',
      'fixes',
      'merged',
      'released',
    ]);
  });

  it('marks merged and released as flow-only, and names the flow of each', () => {
    const flowOnly = softwareRecipe.board.flowOnly ?? {};
    expect(Object.keys(flowOnly)).toEqual(['merged', 'released']);
    expect(Object.values(flowOnly).every((flow) => flow.trim() !== '')).toBe(true);
  });

  it('gives the merge word as the queue key', () => {
    expect(queueKeyOf(softwareRecipe)).toBe('merge');
  });
});

describe.each(allRecipes.map((recipe) => [recipe.id, recipe] as const))('the board data of the recipe %s', (_id, recipe) => {
  it('names listed stages only in its flow-only map', () => {
    const stages = recipe.board.stages ?? [];
    for (const stage of Object.keys(recipe.board.flowOnly ?? {})) expect(stages).toContain(stage);
  });

  it('gives a queue key that is no other top key of the board', () => {
    const key = queueKeyOf(recipe);
    expect(key).not.toBe('');
    expect([boardKeys.items, boardKeys.tracks]).not.toContain(key);
  });
});

describe('the queue key of the core', () => {
  it('is queue when the recipe gives no key', () => {
    expect(queueKeyOf({ ...softwareRecipe, board: {} })).toBe('queue');
  });

  it('is the key of the recipe when the recipe gives one', () => {
    expect(queueKeyOf({ ...softwareRecipe, board: { queueKey: 'proofs' } })).toBe('proofs');
  });
});
