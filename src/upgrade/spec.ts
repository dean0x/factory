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
import { isRecord, type SchemaParser, type TextParser, type VersionSpec } from '../migrate/inspect.js';
import { allOn } from '../guards/effective.js';
import { retiredGuardIds } from '../guards/registry.js';
import type { GuardValues } from '../guards/types.js';
import { guardConfigWords, guardKeys } from '../names.js';
import type { Migration } from '../migrate/runner.js';
import { stateMigrations } from '../migrate/state.js';
import { jsonText } from '../state/files.js';
import { STATE_SPEC, parseJsonText } from '../state/load.js';
import { queueKeyOf, type ApprovalModes, type RecipeRegistry } from '../recipes/index.js';
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
  /** Notices about values that the finisher removes from the raw file. */
  notices?(raw: unknown): readonly string[];
}

/** The managed blocks of one node, and the key of the queue in its board file: the recipe of the config gives both. */
export interface BlockSet {
  readonly templates: readonly BlockTemplate[];
  /** Role blocks that the node may hold under the name of another layer. Each one is renamed when found. */
  readonly renames: readonly BlockRename[];
  /** The key of the queue in `board.json` (`queueKeyOf`). */
  readonly queueKey: string;
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
   * mode of each approval point and guard values. The value holds both files in the current schema versions.
   * Both callbacks get the parsed config, because their values follow its node id and local values.
   */
  blocksOf(config: unknown, setup: SetupTexts, modesOf: ModesOf, guardsOf?: GuardsOf): Promise<CliResult<BlockSet>>;
}

/** The effective mode of each approval point of a parsed config. */
export type ModesOf = (config: FactoryConfig) => Promise<ApprovalModes>;

/** The effective guard values of a parsed config. */
export type GuardsOf = (config: FactoryConfig) => Promise<GuardValues>;

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
  };

/** The local finisher removes only retired ids. Each other value still goes through the local schema. */
export const localFinisher = (retired: readonly string[] = retiredGuardIds): Required<Pick<UpgradeFile, 'finish' | 'notices'>> => {
  const finish = finisher(localConfigSchema, renderLocalConfig);
  const retiredIn = (raw: unknown): readonly string[] => {
    const values = isRecord(raw) ? raw[guardKeys.local] : undefined;
    return isRecord(values) ? Object.keys(values).filter((id) => retired.includes(id)) : [];
  };
  return {
    finish: (raw) => {
      if (!isRecord(raw)) return finish(raw);
      const values = raw[guardKeys.local];
      if (!isRecord(values)) return finish(raw);
      const kept = Object.fromEntries(Object.entries(values).filter(([id]) => !retired.includes(id)));
      return finish({ ...raw, [guardKeys.local]: kept });
    },
    notices: (raw) => {
      const removed = retiredIn(raw);
      return removed.length === 0 ? [] : [guardConfigWords.droppedRetired(removed)];
    },
  };
};

/**
 * The blocks come from the combined config of the two files: the layer sets the role, the recipe sets the approval
 * points, the local file sets the owner prefix, and the shared file sets the context limits. The setup texts follow the
 * core blocks.
 */
const blocksOfNode =
  (registry: RecipeRegistry) =>
  async (config: unknown, setup: SetupTexts, modesOf: ModesOf, guardsOf: GuardsOf = async () => allOn): Promise<CliResult<BlockSet>> => {
    const { shared, local } = splitConfigValue(config);
    const parsed = parseConfig(shared, local, registry);
    if (!parsed.success) return failure(describeIssues(parsed.error));
    const input = blockInputOf(parsed.data, setup, await modesOf(parsed.data), await guardsOf(parsed.data));
    return ok({
      templates: blockTemplatesFor(input),
      renames: roleBlockRenames(parsed.data.entry, input.layer),
      queueKey: queueKeyOf(parsed.data.entry),
    });
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
    ...localFinisher(),
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
