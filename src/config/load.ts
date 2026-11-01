import { LineCounter, parseDocument } from 'yaml';
import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { inspectFile, requireValid, type DocState, type VersionSpec } from '../migrate/inspect.js';
import { files, keys } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { CONFIG_SCHEMA_VERSION, configSchema, type FactoryConfig } from './schema.js';

const CONFIG_LABEL = files.config;

/** Parse YAML text. Aliases are not allowed, and duplicate keys are errors. */
export const parseYamlText = (text: string): Result<unknown, string> => {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, lineCounter });
  const first = doc.errors[0];
  if (first !== undefined) {
    return err(`line ${lineCounter.linePos(first.pos[0]).line}: ${first.message}`);
  }
  try {
    return ok(doc.toJS({ maxAliasCount: 0 }));
  } catch {
    return err('aliases are not allowed');
  }
};

export const CONFIG_SPEC: VersionSpec<FactoryConfig> = {
  file: CONFIG_LABEL,
  key: keys.root.schema,
  supported: CONFIG_SCHEMA_VERSION,
  schema: configSchema,
};

export const inspectConfig = (deps: Deps, home: string): Promise<DocState<FactoryConfig>> =>
  inspectFile(deps, layoutOf(home).configFile, parseYamlText, CONFIG_SPEC);

export const loadConfig = async (deps: Deps, home: string): Promise<CliResult<FactoryConfig>> =>
  requireValid(await inspectConfig(deps, home), CONFIG_LABEL);
