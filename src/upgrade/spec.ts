import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { CONFIG_SPEC, parseYamlText } from '../config/load.js';
import { renderConfig } from '../config/render.js';
import { configSchema, nodeSchema } from '../config/schema.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { configMigrations } from '../migrate/config.js';
import { fileSteps, type BlockRename, type FileStep } from '../migrate/files.js';
import type { SchemaParser, TextParser, VersionSpec } from '../migrate/inspect.js';
import type { Migration } from '../migrate/runner.js';
import { stateMigrations } from '../migrate/state.js';
import { keys } from '../names.js';
import { jsonText } from '../state/files.js';
import { STATE_SPEC, parseJsonText } from '../state/load.js';
import { nodeStateSchema } from '../state/schema.js';
import { blockTemplatesFor, roleBlockRenames } from '../templates/index.js';
import type { BlockTemplate } from '../templates/types.js';

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
  readonly config: UpgradeFile;
  readonly state: UpgradeFile;
  /** The files that move, and the blocks that get a new name, when the state migrates. */
  readonly files: readonly FileStep[];
  /** The managed blocks of the node that a config value describes. The value has the current schema version. */
  blocksOf(config: unknown): CliResult<BlockSet>;
}

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
  };

const layerSchema = z.looseObject({ [keys.root.node]: nodeSchema });

/** The blocks come from the layer of the node: the layer sets the role. */
const blocksOfLayer = (config: unknown): CliResult<BlockSet> => {
  const parsed = layerSchema.safeParse(config);
  if (!parsed.success) return failure(describeIssues(parsed.error));
  const { layer } = parsed.data[keys.root.node];
  return ok({ templates: blockTemplatesFor(layer), renames: roleBlockRenames(layer) });
};

export const currentSpec: UpgradeSpec = {
  config: {
    spec: CONFIG_SPEC,
    parse: parseYamlText,
    migrations: configMigrations,
    finish: finisher(configSchema, renderConfig),
  },
  state: {
    spec: STATE_SPEC,
    parse: parseJsonText,
    migrations: stateMigrations,
    finish: finisher(nodeStateSchema, jsonText),
  },
  files: fileSteps,
  blocksOf: blocksOfLayer,
};
