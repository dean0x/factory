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
import { removeGuardKeysText } from '../config/edit.js';
import { guardsFor, retiredGuardIds } from '../guards/registry.js';
import type { GuardValues } from '../guards/types.js';
import { files, guardConfigWords, guardKeys } from '../names.js';
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
  /**
   * Notices about values that the finisher removes from the raw file. A current file with a notice is written again with no
   * migration step.
   */
  notices?(raw: unknown): readonly string[];
  /** The step of `finish` that removes values, on the text of a file that people edit: its comments and key order stay. */
  finishText?(text: string): CliResult<string>;
}

/** The managed blocks of one node, and the key of the queue in its board file: the recipe of the config gives both. */
export interface BlockSet {
  readonly templates: readonly BlockTemplate[];
  /** Role blocks that the node may hold under the name of another layer. Each one is renamed when found. */
  readonly renames: readonly BlockRename[];
  /** The key of the queue in `board.json` (`queueKeyOf`). */
  readonly queueKey: string;
  /**
   * `BlockSet` describes the managed blocks, and this field is the settings value that the same parse gives: the value of
   * `session.idle_compaction` that the hook settings of the session folders get.
   */
  readonly idleCompaction: boolean;
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
   * Await guardsOf before a successful result. It supplies the prefix check and the guard values.
   */
  blocksOf(config: unknown, setup: SetupTexts, modesOf: ModesOf, guardsOf: GuardsOf): Promise<CliResult<BlockSet>>;
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

/** The ids of the guard map under `key` of a raw file that `drop` names. */
const idsIn = (raw: unknown, key: string, drop: readonly string[]): readonly string[] => {
  const values = isRecord(raw) ? raw[key] : undefined;
  return isRecord(values) ? Object.keys(values).filter((id) => drop.includes(id)) : [];
};

/** The raw file with no id of `drop` in the guard map under `key`. A raw file of another form stays, so the schema refuses it. */
const withoutIds = (raw: unknown, key: string, drop: readonly string[]): unknown => {
  const values = isRecord(raw) ? raw[key] : undefined;
  if (!isRecord(raw) || !isRecord(values)) return raw;
  return { ...raw, [key]: Object.fromEntries(Object.entries(values).filter(([id]) => !drop.includes(id))) };
};

/** The upgrade line for the keys of fixed guards in one file, or none. */
const fixedNotices = (raw: unknown, file: string, key: string, fixed: readonly string[]): readonly string[] => {
  const found = idsIn(raw, key, fixed);
  return found.length === 0 ? [] : [guardConfigWords.droppedFixed(file, found.map((id) => `${key}.${id}`))];
};

/** The fixed guards of the recipes of a registry. A fixed guard has no setting, so the upgrade removes a key of one. */
const fixedIdsOf = (registry: RecipeRegistry): readonly string[] => [
  ...new Set(registry.flatMap((entry) => guardsFor(entry).filter((guard) => guard.fixed).map((guard) => guard.id))),
];

/** The text step of a finisher: it removes the ids of `drop` from the guard map under `key`, and every other line stays. */
const keysRemovedText = (key: string, drop: readonly string[]) => (text: string): CliResult<string> => {
  const edited = removeGuardKeysText(text, key, drop);
  return edited.ok ? edited : failure(edited.error);
};

/**
 * The local finisher removes only retired ids and the keys of fixed guards, on the value and on the text. Each other value still
 * goes through the local schema.
 */
export const localFinisher = (
  retired: readonly string[] = retiredGuardIds,
  fixed: readonly string[] = [],
): Required<Pick<UpgradeFile, 'finish' | 'notices' | 'finishText'>> => {
  const finish = finisher(localConfigSchema, renderLocalConfig);
  return {
    finish: (raw) => finish(withoutIds(raw, guardKeys.local, [...retired, ...fixed])),
    finishText: keysRemovedText(guardKeys.local, [...retired, ...fixed]),
    notices: (raw) => {
      const removed = idsIn(raw, guardKeys.local, retired);
      return [
        ...(removed.length === 0 ? [] : [guardConfigWords.droppedRetired(removed)]),
        ...fixedNotices(raw, files.localConfig, guardKeys.local, fixed),
      ];
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
  async (config: unknown, setup: SetupTexts, modesOf: ModesOf, guardsOf: GuardsOf): Promise<CliResult<BlockSet>> => {
    const { shared, local } = splitConfigValue(config);
    const parsed = parseConfig(shared, local, registry);
    if (!parsed.success) return failure(describeIssues(parsed.error));
    const input = blockInputOf(parsed.data, setup, await modesOf(parsed.data), await guardsOf(parsed.data));
    return ok({
      templates: blockTemplatesFor(input),
      renames: roleBlockRenames(parsed.data.entry, input.layer),
      queueKey: queueKeyOf(parsed.data.entry),
      idleCompaction: parsed.data.core.session.idle_compaction,
    });
  };

/** A migrated value holds the keys of both files. The shared file takes its part of them. */
const sharedPartSchema = (registry: RecipeRegistry): SchemaParser<SharedConfig> => {
  const schema = sharedConfigSchemaFor(registry);
  return { safeParse: (raw) => schema.safeParse(splitConfigValue(raw).shared) };
};

/** The shared finisher removes only the keys of fixed guards, on the value and on the text. */
const sharedFinisher = (registry: RecipeRegistry): Required<Pick<UpgradeFile, 'finish' | 'notices' | 'finishText'>> => {
  const finish = finisher(sharedPartSchema(registry), renderSharedConfig);
  const fixed = fixedIdsOf(registry);
  return {
    finish: (raw) => finish(withoutIds(raw, guardKeys.shared, fixed)),
    notices: (raw) => fixedNotices(raw, files.config, guardKeys.shared, fixed),
    finishText: keysRemovedText(guardKeys.shared, fixed),
  };
};

/** How `upgrade` handles the files of a node. The registry sets the recipes that the shared file can name. */
export const specFor = (registry: RecipeRegistry): UpgradeSpec => ({
  config: {
    spec: sharedSpecFor(registry),
    parse: parseYamlText,
    migrations: configMigrations,
    ...sharedFinisher(registry),
  },
  local: {
    spec: LOCAL_SPEC,
    parse: parseYamlText,
    migrations: [],
    ...localFinisher(retiredGuardIds, fixedIdsOf(registry)),
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
