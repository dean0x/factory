import { exitCodeFor, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, renderError, tableLines, type CommandOutput, type OutLine } from '../cli/output.js';
import { inspectSharedConfig, loadConfig, readNodeIdentity } from '../config/load.js';
import type { SharedConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { guardRowsFor, guardsFor } from '../guards/registry.js';
import type { Guard, GuardRow, GuardState, GuardValue } from '../guards/types.js';
import { isRecord, type DocState } from '../migrate/inspect.js';
import { commands, guardListWords, guardValues, harmMark, keys, maxGuardListLines, schemaIds } from '../names.js';
import { findRecipe, type RecipeEntry, type RecipeRegistry } from '../recipes/index.js';

export interface GuardListOptions {
  readonly home: string | undefined;
  readonly all: boolean;
  readonly family: string | undefined;
}

interface ListedGuard extends Omit<GuardState, 'value'> {
  readonly value: GuardValue | typeof guardListWords.unknown;
  readonly source: 'missing';
  readonly since: null;
}

/** A config with no guard keys uses the missing-key value and has no record time. */
const valueOf = (guard: Guard, loaded: boolean): ListedGuard => ({
  ...guard,
  settable: guard.wired,
  value: loaded ? guard.whenMissing : guardListWords.unknown,
  source: 'missing',
  since: null,
});

const text = (line: string): OutLine => ({ level: 'text', text: line });
const fail = (line: string): OutLine => ({ level: 'fail', text: line });
const cleanCells = (cells: readonly string[]): readonly string[] => cells.map((cell) => displayLine(cell));

const guardCells = (guard: ListedGuard): readonly string[] => cleanCells([
  guard.id,
  guard.value,
  guard.newNode,
  guard.harm ? harmMark : '',
  guard.settable ? guardListWords.sources[guard.source] : guardListWords.notSettable,
]);

const rowCells = (row: GuardRow): readonly string[] => cleanCells([
  row.id,
  row.kind,
  row.harm ? harmMark : '',
  row.name,
]);

/** Off guards come first, with marked guards first among them. Other guards keep the registry order. */
const orderOf = (first: ListedGuard, second: ListedGuard): number => {
  const firstOff = first.value === guardValues.off;
  const secondOff = second.value === guardValues.off;
  return Number(secondOff) - Number(firstOff) || (firstOff && secondOff ? Number(second.harm) - Number(first.harm) : 0);
};

/** The recipe id can select registry facts even when another config field is invalid. */
const recipeOf = (state: DocState<SharedConfig>, registry: RecipeRegistry): RecipeEntry => {
  if (state.kind === 'valid') return state.value.entry;
  if (!('raw' in state) || !isRecord(state.raw)) return registry[0];
  const recipe = state.raw[keys.root.recipe];
  if (!isRecord(recipe)) return registry[0];
  const id = recipe[keys.recipe.id];
  return (typeof id === 'string' ? findRecipe(registry, id) : undefined) ?? registry[0];
};

/** The list reads its config and registry facts only. It changes no file and runs no check. */
export const runGuardList = async (
  deps: Deps,
  options: GuardListOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.guard,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  const recipe = loaded.ok ? loaded.value.entry : recipeOf(await inspectSharedConfig(deps, home, registry), registry);
  const guards = guardsFor(recipe).map((guard) => valueOf(guard, loaded.ok));
  const rows = guardRowsFor(recipe);
  const family = options.family;
  if (family !== undefined && !guards.some((guard) => guard.id === family)) {
    return usageError(guardListWords.unknownFamily(displayLine(family)));
  }
  const errors = loaded.ok ? [] : [fail(renderError(loaded.error).split('\n')[0] ?? '')];
  const cap = options.all ? undefined : maxGuardListLines - errors.length;
  const off = guards.filter((guard) => guard.value === guardValues.off);
  const countLine = loaded.ok
    ? guardListWords.countLine(off.length, guards.length, off.filter((guard) => guard.harm).length)
    : guardListWords.unknownCountLine(guards.length);
  const table = family === undefined
    ? [...guards].sort(orderOf).map(guardCells)
    : rows.filter((row) => row.guard === family).map(rowCells);
  const shown = table.slice(0, cap);
  const columns = family === undefined ? guardListWords.columns : guardListWords.familyColumns;
  return ok({
    lines: [
      ...errors,
      ...tableLines(cleanCells(Object.values(columns)), shown),
      ...(shown.length < table.length ? [text(guardListWords.moreLine(table.length - shown.length))] : []),
      ...(family === undefined ? [text(countLine)] : []),
    ],
    json: {
      schema: schemaIds.guardList,
      home,
      error: loaded.ok ? null : loaded.error,
      guards,
      rows,
      unmatched: [],
      loosened: [],
    },
    warnings: loaded.ok || loaded.error.hint === undefined ? [] : [loaded.error.hint],
    failed: !loaded.ok,
    ...(loaded.ok ? {} : { exitCode: exitCodeFor(loaded.error) }),
  });
};
