import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { LOCAL_SPEC, parseYamlText, SHARED_SPEC } from '../config/load.js';
import { renderLocalConfig, renderSharedConfig } from '../config/render.js';
import {
  localConfigSchema,
  nodeSchema,
  sharedConfigSchema,
  splitConfigValue,
  type SharedConfig,
} from '../config/schema.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { configMigrations } from '../migrate/config.js';
import { fileSteps, type BlockRename, type FileStep } from '../migrate/files.js';
import type { SchemaParser, TextParser, VersionSpec } from '../migrate/inspect.js';
import type { Migration } from '../migrate/runner.js';
import { stateMigrations } from '../migrate/state.js';
import { keys, values } from '../names.js';
import { ownerModes, recipes } from '../recipes/index.js';
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
  /** The shared file. */
  readonly config: UpgradeFile;
  /** The local file. It is the only writer of that file. */
  readonly local: UpgradeFile;
  readonly state: UpgradeFile;
  /** The files that move, and the blocks that get a new name, when the state migrates. */
  readonly files: readonly FileStep[];
  /** The value of the local file, taken from a migrated config value that holds the keys of both files. */
  localPartOf(config: unknown): unknown;
  /**
   * The managed blocks of the node that a config value describes. The value holds the keys of both files, in the
   * current schema versions.
   */
  blocksOf(config: unknown): CliResult<BlockSet>;
  /** The paths of the projects that a config value lists, as the value holds them. The value holds the keys of both files. */
  projectPathsOf(config: unknown): CliResult<readonly string[]>;
}

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
  };

const blocksSchema = z.looseObject({
  [keys.root.node]: nodeSchema,
  [keys.root.recipe]: z.looseObject({ [keys.recipe.id]: z.enum(values.recipes) }),
});

/**
 * The blocks come from the layer of the node, which sets the role, and from the approval points of its recipe.
 * Every point waits for the owner here. The effective modes come in a later step.
 */
const blocksOfNode = (config: unknown): CliResult<BlockSet> => {
  const parsed = blocksSchema.safeParse(config);
  if (!parsed.success) return failure(describeIssues(parsed.error));
  const { layer } = parsed.data[keys.root.node];
  const modes = ownerModes(recipes[parsed.data[keys.root.recipe][keys.recipe.id]].approvalPoints);
  return ok({ templates: blockTemplatesFor(layer, modes), renames: roleBlockRenames(layer) });
};

const projectsSchema = z.looseObject({
  [keys.root.recipe]: z.looseObject({
    [keys.recipe.projects]: z.array(z.looseObject({ [keys.project.path]: z.string() })).default([]),
  }),
});

const projectPathsOfRecipe = (config: unknown): CliResult<readonly string[]> => {
  const parsed = projectsSchema.safeParse(config);
  if (!parsed.success) return failure(describeIssues(parsed.error));
  return ok(parsed.data[keys.root.recipe][keys.recipe.projects].map((project) => project[keys.project.path]));
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
  localPartOf: (config) => splitConfigValue(config).local,
  blocksOf: blocksOfNode,
  projectPathsOf: projectPathsOfRecipe,
};
