import { LineCounter, parseDocument } from 'yaml';
import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { inspectParsed, requireValid, type DocState } from '../migrate/inspect.js';
import { files, keys } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { CONFIG_SCHEMA_VERSION, configSchema, type FactoryConfig } from './schema.js';

export const CONFIG_LABEL = files.config;

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

export const inspectConfig = async (deps: Deps, home: string): Promise<DocState<FactoryConfig>> => {
  const path = layoutOf(home).configFile;
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return { kind: 'unparsable', message: kind.error.message };
  if (kind.value !== 'file') return { kind: 'missing' };

  const text = await deps.fs.readText(path);
  if (!text.ok) return { kind: 'unparsable', message: text.error.message };
  const raw = parseYamlText(text.value);
  if (!raw.ok) return { kind: 'unparsable', message: raw.error };

  return inspectParsed(raw.value, {
    file: CONFIG_LABEL,
    key: keys.root.schema,
    supported: CONFIG_SCHEMA_VERSION,
    schema: configSchema,
  });
};

export const loadConfig = async (deps: Deps, home: string): Promise<CliResult<FactoryConfig>> =>
  requireValid(await inspectConfig(deps, home), CONFIG_LABEL);
