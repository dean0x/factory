import type { DecisionLogInput, LocalBoard } from '../board/contract.js';
import { createLocalBoard } from '../board/local.js';
import type { CliResult } from '../cli/errors.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { commands, type CommandName } from '../names.js';
import { queueKeyOf, type RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';

/** The board of one node: its folder, its config and its connector. */
export interface OpenBoard {
  readonly home: string;
  readonly config: FactoryConfig;
  readonly connector: LocalBoard;
}

/**
 * The connector of the board of the node at `home`, for a config that is loaded. `command` is the command that a stop of the
 * connector tells the person to run again. The tracker kind of the config decides whether a write is allowed: only the kind `local`
 * writes.
 */
export const localBoardOf = (deps: Deps, home: string, config: FactoryConfig, command: CommandName): LocalBoard =>
  createLocalBoard(deps, layoutOf(home), {
    queueKey: queueKeyOf(config.entry),
    recipe: config.entry.board,
    config: config.core.board,
    command,
    tracker: config.core.tracker.kind,
    node: config.core.node.id,
  });

/**
 * Find the node folder, load its config and build the board connector for it. Every command that reads or changes the board opens
 * it here.
 */
export const openBoard = async (
  deps: Deps,
  homeFlag: string | undefined,
  registry: RecipeRegistry,
  command: CommandName,
): Promise<CliResult<OpenBoard>> => {
  const located = await locateHomeFolder(
    deps,
    homeFlag,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    command,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  return ok({ home, config, connector: localBoardOf(deps, home, config, command) });
};

/**
 * The port that `dismiss --closed` uses to write the decision row of a free, before the free. It is a parameter of the command, so a
 * test gives a log of its own, and the command never builds a connector itself.
 */
export interface DecisionLogPort {
  /** Adds one row to the decision log of the node at `home`, in one state commit. The value is the id of the new row. */
  log(deps: Deps, home: string, config: FactoryConfig, input: DecisionLogInput): Promise<CliResult<string>>;
}

/** The decision log of the local board. */
export const boardDecisionLog: DecisionLogPort = {
  log: (deps, home, config, input) => localBoardOf(deps, home, config, commands.dismiss).logDecision(input),
};
