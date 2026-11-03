import { LineCounter, parseDocument } from 'yaml';
import { safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import type { NodeIdentity } from '../core/home.js';
import { err, ok, type Result } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { describeIssues } from '../core/zod.js';
import {
  inspectFile,
  inspectParsed,
  isRecord,
  refuse,
  type DocState,
  type VersionSpec,
} from '../migrate/inspect.js';
import { commands, commandText, files, flags, flagText, keys, localFileModes, program, roles } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { slug } from './primitives.js';
import {
  CONFIG_SCHEMA_VERSION,
  LOCAL_SCHEMA_VERSION,
  localConfigSchema,
  mergeConfig,
  mixConfigValue,
  sharedConfigSchema,
  type FactoryConfig,
  type LocalConfig,
  type SharedConfig,
} from './schema.js';

const CONFIG_LABEL = files.config;

/**
 * Parse YAML text. Aliases are not allowed, and duplicate keys are errors.
 * An error holds the line and the error code only, because the YAML message can repeat the source text.
 */
export const parseYamlText = (text: string): Result<unknown, string> => {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, lineCounter });
  const first = doc.errors[0];
  if (first !== undefined) {
    return err(`line ${lineCounter.linePos(first.pos[0]).line}: ${first.code}`);
  }
  try {
    return ok(doc.toJS({ maxAliasCount: 0 }));
  } catch {
    return err('aliases are not allowed');
  }
};

/** The shared file, `factory.yaml`: its own key `schema` and its own version. */
export const SHARED_SPEC: VersionSpec<SharedConfig> = {
  file: CONFIG_LABEL,
  key: keys.root.schema,
  supported: CONFIG_SCHEMA_VERSION,
  schema: sharedConfigSchema,
};

/** The local file, `factory.local.yaml`: its own key `schema` and its own version. */
export const LOCAL_SPEC: VersionSpec<LocalConfig> = {
  file: files.localConfig,
  key: keys.root.schema,
  supported: LOCAL_SCHEMA_VERSION,
  schema: localConfigSchema,
};

const stateOfText = <T>(text: string, spec: VersionSpec<T>): DocState<T> => {
  const raw = parseYamlText(text);
  return raw.ok ? inspectParsed(raw.value, spec) : { kind: 'unparsable', message: raw.error };
};

/** The state of the two files together. The first file that has a problem sets the state, and a problem of the local file names it. */
const combine = (shared: DocState<SharedConfig>, local: DocState<LocalConfig>): DocState<FactoryConfig> => {
  if (shared.kind !== 'valid') return shared;
  if (local.kind === 'missing') return { kind: 'missing', file: files.localConfig };
  if (local.kind !== 'valid') return { ...local, file: files.localConfig };
  const combined = mergeConfig(shared.value, local.value);
  if (!combined.success) {
    return { kind: 'invalid', raw: local.raw, message: describeIssues(combined.error), file: files.localConfig };
  }
  return { kind: 'valid', raw: mixConfigValue(shared.raw, local.raw), version: shared.version, value: combined.data };
};

/** The local file is missing next to the shared file: a usage error that names `init`. */
export const requireInit = (): CliResult<never> =>
  usageError(
    `${files.localConfig} not found`,
    `Run "${commandText(commands.init)} ${flagText(flags.home)} DIR" for the home of this ${roles.node}.`,
  );

/** The config from the state of its files. A missing local file is a usage error that names `init`. */
export const configResult = (state: DocState<FactoryConfig>): CliResult<FactoryConfig> => {
  if (state.kind === 'valid') return ok(state.value);
  if (state.kind === 'missing' && state.file === files.localConfig) return requireInit();
  return refuse(state, CONFIG_LABEL);
};

/** The config from the text of the two files: the YAML, the versions, the core, the recipe and the join of the two. */
export const parseConfigTexts = (sharedText: string, localText: string): CliResult<FactoryConfig> =>
  configResult(combine(stateOfText(sharedText, SHARED_SPEC), stateOfText(localText, LOCAL_SPEC)));

/** What the local file is, for the load. A file of another account, or one that others can write, is a refusal. */
export type LocalAccess =
  | { readonly kind: 'absent' }
  | { readonly kind: 'private' }
  /** Group or others can read the file. The value is the permission bits. */
  | { readonly kind: 'wide'; readonly mode: number };

const LOCAL_FILE_REMEDY = `Check the file, set the mode to 600 with "chmod 600 ${files.localConfig}", then run the command again.`;

/** The remedy line for a local file that is a link: the file is written again by `init`. */
const LOCAL_FILE_LINK_REMEDY = `Move ${files.localConfig} away, then run "${commandText(commands.init)}" to write a new one.`;

/**
 * What the local file is. A link stops the command first (exit 4), before the owner check and before any mode change,
 * because both would act on the target of the link.
 */
export const localFileAccess = async (deps: Deps, home: string): Promise<CliResult<LocalAccess>> => {
  const layout = layoutOf(home);
  const linked = await requireNoLinks(deps, home, [layout.localConfigFile], LOCAL_FILE_LINK_REMEDY);
  if (!linked.ok) return linked;
  const info = await deps.fs.statInfo(layout.localConfigFile);
  if (!info.ok) return info;
  if (info.value === null) return ok({ kind: 'absent' });
  if (info.value.kind !== 'file') return safetyRefusal(`${files.localConfig} is not a file`, LOCAL_FILE_REMEDY);
  if (deps.uid !== null && info.value.uid !== deps.uid) {
    return safetyRefusal(`${files.localConfig} belongs to another account, so ${program} does not read it`, LOCAL_FILE_REMEDY);
  }
  if ((info.value.mode & localFileModes.groupOtherWrite) !== 0) {
    return safetyRefusal(
      `${files.localConfig} can be changed by other accounts (mode ${info.value.mode.toString(8)}), so ${program} does not read it`,
      LOCAL_FILE_REMEDY,
    );
  }
  return (info.value.mode & localFileModes.groupOtherRead) !== 0
    ? ok({ kind: 'wide', mode: info.value.mode })
    : ok({ kind: 'private' });
};

/** The text for a local file with a group or other read bit. */
export const wideModeNote = (mode: number, fixed: boolean): string =>
  fixed
    ? `${program} set the mode of ${files.localConfig} to 600. It was ${mode.toString(8)}, so other accounts could read it.`
    : `${files.localConfig} has the mode ${mode.toString(8)}, so other accounts can read it. ` +
      `Run "chmod 600 ${files.localConfig}" in the ${roles.node} home.`;

/**
 * Deal with a local file that group or others can read. With `fix`, the mode goes back to 600. Else nothing changes,
 * and the note names the command. The notes are for the output of the command.
 */
export const settleLocalMode = async (deps: Deps, home: string, fix: boolean): Promise<CliResult<readonly string[]>> => {
  const access = await localFileAccess(deps, home);
  if (!access.ok) return access;
  if (access.value.kind !== 'wide') return ok([]);
  if (!fix) return ok([wideModeNote(access.value.mode, false)]);
  const changed = await deps.fs.chmod(layoutOf(home).localConfigFile, localFileModes.private);
  return changed.ok ? ok([wideModeNote(access.value.mode, true)]) : changed;
};

/** The shared file alone. A ping needs only the id and the layer of a node, and it reads no local file. */
export const inspectSharedConfig = (deps: Deps, home: string): Promise<DocState<SharedConfig>> =>
  inspectFile(deps, layoutOf(home).configFile, parseYamlText, SHARED_SPEC);

/** The node id of an older layout of the shared file, or null when the value holds none that is a valid id. */
const nodeIdOfRaw = (raw: unknown): string | null => {
  const node = isRecord(raw) ? raw[keys.root.node] : undefined;
  const id = isRecord(node) ? slug.safeParse(node[keys.node.id]) : undefined;
  return id?.success === true ? id.data : null;
};

/**
 * The node id and the schema version that the shared file states, for the registration check of the root. A file of
 * an older layout gives its id and its version too, so that `upgrade` can name it. The error is the reason when the
 * file gives no id. The local file is not read.
 */
export const readNodeIdentity = async (deps: Deps, home: string): Promise<Result<NodeIdentity, string>> => {
  const state = await inspectSharedConfig(deps, home);
  switch (state.kind) {
    case 'valid':
      return ok({ id: state.value.core.node.id, schema: state.version });
    case 'older': {
      const id = nodeIdOfRaw(state.raw);
      return id === null ? err(`${CONFIG_LABEL} holds no ${roles.node} id`) : ok({ id, schema: state.version });
    }
    case 'missing':
      return err(`${CONFIG_LABEL} not found`);
    case 'unparsable':
    case 'invalid':
    case 'newer':
    case 'unsafe':
      return err(state.message);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * Both files, as one state. The local file is read only after the check of its owner and its mode. The shared file
 * comes first: while it is not valid, the local file is not looked at.
 */
export const inspectConfig = async (deps: Deps, home: string): Promise<DocState<FactoryConfig>> => {
  const shared = await inspectSharedConfig(deps, home);
  if (shared.kind !== 'valid') return shared;
  const access = await localFileAccess(deps, home);
  if (!access.ok) {
    return access.error.kind === 'safety'
      ? { kind: 'unsafe', message: access.error.message, hint: access.error.hint, file: files.localConfig }
      : { kind: 'unparsable', message: access.error.message, file: files.localConfig };
  }
  if (access.value.kind === 'absent') return { kind: 'missing', file: files.localConfig };
  return combine(shared, await inspectFile(deps, layoutOf(home).localConfigFile, parseYamlText, LOCAL_SPEC));
};

export const loadConfig = async (deps: Deps, home: string): Promise<CliResult<FactoryConfig>> =>
  configResult(await inspectConfig(deps, home));
