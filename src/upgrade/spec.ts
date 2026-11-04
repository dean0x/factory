import { failure, type CliResult } from '../cli/errors.js';
import { LOCAL_SPEC, parseYamlText, sharedSpecFor } from '../config/load.js';
import { renderLocalConfig, renderSharedConfig } from '../config/render.js';
import {
  localConfigSchema,
  parseConfig,
  sharedConfigSchemaFor,
  splitConfigValue,
  type FactoryConfig,
  type SharedConfig,
} from '../config/schema.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { configMigrations } from '../migrate/config.js';
import { fileSteps, rootMoves, type BlockRename, type FileStep, type RootMove } from '../migrate/files.js';
import type { SchemaParser, TextParser, VersionSpec } from '../migrate/inspect.js';
import type { Migration } from '../migrate/runner.js';
import { stateMigrations } from '../migrate/state.js';
import { jsonText } from '../state/files.js';
import { STATE_SPEC, parseJsonText } from '../state/load.js';
import type { ApprovalModes, RecipeRegistry } from '../recipes/index.js';
import { nodeStateSchema } from '../state/schema.js';
import { blockInputOf, blockTemplatesFor, roleBlockRenames } from '../templates/index.js';
import type { BlockTemplate, SetupTexts } from '../templates/types.js';

/** How `upgrade` handles one versioned file. */
export interface UpgradeFile {
  readonly spec: VersionSpec<unknown>;
  readonly parse: TextParser;
  readonly migrations: readonly Migration[];
  /** Check a value against the schema, and give the new text of the file. */
  finish(raw: unknown): CliResult<string>;
}

/** The managed blocks of one node. */
export interface BlockSet {
  readonly templates: readonly BlockTemplate[];
  /** Role blocks that the node may hold under the name of another layer. Each one is renamed when found. */
  readonly renames: readonly BlockRename[];
}

export interface UpgradeSpec {
  /** The shared file. */
  readonly config: UpgradeFile;
  /** The local file. It is the only writer of that file. */
  readonly local: UpgradeFile;
  readonly state: UpgradeFile;
  /** The files that move, and the blocks that get a new name, when the state migrates. */
  readonly files: readonly FileStep[];
  /** The files that move outside the state folder. A move happens whatever the version of the state is. */
  readonly rootMoves: readonly RootMove[];
  /** The value of the local file, taken from a migrated config value that holds the keys of both files. */
  localPartOf(config: unknown): unknown;
  /**
   * The managed blocks of the node that a config value describes, with the setup texts of the root and the effective
   * mode of each approval point. The value holds the keys of both files, in the current schema versions. `modesOf` gets
   * the parsed config, because the effective modes follow its node id and its local values.
   */
  blocksOf(config: unknown, setup: SetupTexts, modesOf: ModesOf): Promise<CliResult<BlockSet>>;
}

/** The effective mode of each approval point of a parsed config. */
export type ModesOf = (config: FactoryConfig) => Promise<ApprovalModes>;

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
  };

/**
 * The blocks come from the combined config of the two files: the layer sets the role, the recipe sets the approval
 * points, the local file sets the owner prefix, and the shared file sets the context limits. The setup texts follow the
 * core blocks.
 */
const blocksOfNode =
  (registry: RecipeRegistry) =>
  async (config: unknown, setup: SetupTexts, modesOf: ModesOf): Promise<CliResult<BlockSet>> => {
    const { shared, local } = splitConfigValue(config);
    const parsed = parseConfig(shared, local, registry);
    if (!parsed.success) return failure(describeIssues(parsed.error));
    const input = blockInputOf(parsed.data, setup, await modesOf(parsed.data));
    return ok({ templates: blockTemplatesFor(input), renames: roleBlockRenames(parsed.data.entry, input.layer) });
  };

/** A migrated value holds the keys of both files. The shared file takes its part of them. */
const sharedPartSchema = (registry: RecipeRegistry): SchemaParser<SharedConfig> => {
  const schema = sharedConfigSchemaFor(registry);
  return { safeParse: (raw) => schema.safeParse(splitConfigValue(raw).shared) };
};

/** How `upgrade` handles the files of a node. The registry sets the recipes that the shared file can name. */
export const specFor = (registry: RecipeRegistry): UpgradeSpec => ({
  config: {
    spec: sharedSpecFor(registry),
    parse: parseYamlText,
    migrations: configMigrations,
    finish: finisher(sharedPartSchema(registry), renderSharedConfig),
  },
  local: {
    spec: LOCAL_SPEC,
    parse: parseYamlText,
    migrations: [],
    finish: finisher(localConfigSchema, renderLocalConfig),
  },
  state: {
    spec: STATE_SPEC,
    parse: parseJsonText,
    migrations: stateMigrations,
    finish: finisher(nodeStateSchema, jsonText),
  },
  files: fileSteps,
  rootMoves,
  localPartOf: (config) => splitConfigValue(config).local,
  blocksOf: blocksOfNode(registry),
});
