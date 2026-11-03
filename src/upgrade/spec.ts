import { failure, type CliResult } from '../cli/errors.js';
import { LOCAL_SPEC, parseYamlText, SHARED_SPEC } from '../config/load.js';
import { renderLocalConfig, renderSharedConfig } from '../config/render.js';
import {
  localConfigSchema,
  parseConfig,
  sharedConfigSchema,
  splitConfigValue,
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
   * The managed blocks of the node that a config value describes, with the setup texts of the root. The value holds the
   * keys of both files, in the current schema versions.
   */
  blocksOf(config: unknown, setup: SetupTexts): CliResult<BlockSet>;
}

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
  };

/**
 * The blocks come from the merged config of the two files: the layer sets the role, the recipe sets the approval
 * points, the local file sets the owner prefix, and the shared file sets the context limits. The setup texts follow the
 * core blocks.
 */
const blocksOfNode = (config: unknown, setup: SetupTexts): CliResult<BlockSet> => {
  const { shared, local } = splitConfigValue(config);
  const parsed = parseConfig(shared, local);
  if (!parsed.success) return failure(describeIssues(parsed.error));
  const input = blockInputOf(parsed.data, setup);
  return ok({ templates: blockTemplatesFor(input), renames: roleBlockRenames(input.layer) });
};

/** A migrated value holds the keys of both files. The shared file takes its part of them. */
const sharedPartSchema: SchemaParser<SharedConfig> = {
  safeParse: (raw) => sharedConfigSchema.safeParse(splitConfigValue(raw).shared),
};

export const currentSpec: UpgradeSpec = {
  config: {
    spec: SHARED_SPEC,
    parse: parseYamlText,
    migrations: configMigrations,
    finish: finisher(sharedPartSchema, renderSharedConfig),
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
  blocksOf: blocksOfNode,
};
