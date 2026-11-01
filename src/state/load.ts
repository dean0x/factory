import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { inspectParsed, requireValid, type DocState } from '../migrate/inspect.js';
import { dirs, files, stateKeys } from '../names.js';
import { layoutOf } from './layout.js';
import { nodeStateSchema, STATE_SCHEMA_VERSION, type NodeState } from './schema.js';

export const STATE_LABEL = `${dirs.state}/${files.nodeState}`;

/** Parse JSON text. The error never repeats the text. */
export const parseJsonText = (text: string): Result<unknown, string> => {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err('the text is not valid JSON');
  }
};

export const inspectState = async (deps: Deps, home: string): Promise<DocState<NodeState>> => {
  const path = layoutOf(home).nodeJson;
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return { kind: 'unparsable', message: kind.error.message };
  if (kind.value !== 'file') return { kind: 'missing' };

  const text = await deps.fs.readText(path);
  if (!text.ok) return { kind: 'unparsable', message: text.error.message };
  const raw = parseJsonText(text.value);
  if (!raw.ok) return { kind: 'unparsable', message: raw.error };

  return inspectParsed(raw.value, {
    file: STATE_LABEL,
    key: stateKeys.schemaVersion,
    supported: STATE_SCHEMA_VERSION,
    schema: nodeStateSchema,
  });
};

export const loadState = async (deps: Deps, home: string): Promise<CliResult<NodeState>> =>
  requireValid(await inspectState(deps, home), STATE_LABEL);
