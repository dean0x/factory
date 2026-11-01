import { failure, type CliResult } from '../cli/errors.js';
import { CONFIG_SPEC, parseYamlText } from '../config/load.js';
import { renderConfig } from '../config/render.js';
import { configSchema } from '../config/schema.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { configMigrations } from '../migrate/config.js';
import { fileSteps, type FileStep } from '../migrate/files.js';
import type { SchemaParser, TextParser, VersionSpec } from '../migrate/inspect.js';
import type { Migration } from '../migrate/runner.js';
import { stateMigrations } from '../migrate/state.js';
import { jsonText } from '../state/files.js';
import { STATE_SPEC, parseJsonText } from '../state/load.js';
import { nodeStateSchema } from '../state/schema.js';
import { blockTemplates, type BlockTemplate } from '../templates/index.js';

/** How `upgrade` handles one versioned file. */
export interface UpgradeFile {
  readonly spec: VersionSpec<unknown>;
  readonly parse: TextParser;
  readonly migrations: readonly Migration[];
  /** Check a value against the schema, and give the new text of the file. */
  finish(raw: unknown): CliResult<string>;
}

export interface UpgradeSpec {
  readonly config: UpgradeFile;
  readonly state: UpgradeFile;
  /** The files that move, and the blocks that get a new name, when the state migrates. */
  readonly files: readonly FileStep[];
  readonly blocks: readonly BlockTemplate[];
}

export const finisher =
  <T>(schema: SchemaParser<T>, render: (value: T) => string) =>
  (raw: unknown): CliResult<string> => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(render(parsed.data)) : failure(describeIssues(parsed.error));
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
  blocks: blockTemplates,
};
