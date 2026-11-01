import type { CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { inspectFile, requireValid, type DocState, type VersionSpec } from '../migrate/inspect.js';
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

export const STATE_SPEC: VersionSpec<NodeState> = {
  file: STATE_LABEL,
  key: stateKeys.schemaVersion,
  supported: STATE_SCHEMA_VERSION,
  schema: nodeStateSchema,
};

export const inspectState = (deps: Deps, home: string): Promise<DocState<NodeState>> =>
  inspectFile(deps, layoutOf(home).nodeJson, parseJsonText, STATE_SPEC);

export const loadState = async (deps: Deps, home: string): Promise<CliResult<NodeState>> =>
  requireValid(await inspectState(deps, home), STATE_LABEL);
