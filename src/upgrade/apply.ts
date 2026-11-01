import { join, relative } from 'node:path';
import { fileOfTarget } from '../blocks/status.js';
import { appendBlocks, parseBlocks, renderBlock, replaceBlock } from '../blocks/managed.js';
import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { runMigrations } from '../migrate/runner.js';
import { dirs, files, stateKeys } from '../names.js';
import { layoutOf } from '../state/layout.js';
import type { BlockPlan, FilePlan } from './plan.js';
import type { UpgradeSpec } from './spec.js';

export interface Written {
  readonly path: string;
  /** The text before the change, or null when the file did not exist. */
  readonly previous: string | null;
}

const readIfFile = async (deps: Deps, path: string): Promise<CliResult<string | null>> => {
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return kind;
  return kind.value === 'file' ? deps.fs.readText(path) : ok(null);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The new text of a file that holds managed blocks. */
const editBlockFile = (text: string, changes: readonly BlockPlan[]): CliResult<string> => {
  const parsed = parseBlocks(text);
  if (!parsed.ok) return parsed;
  const rendered = new Map<string, string>();
  for (const change of changes) {
    const block = renderBlock(change.template);
    if (!block.ok) return block;
    rendered.set(change.template.name, block.value);
  }

  const replaced = parsed.value
    .filter((block) => changes.some((change) => change.template.name === block.name && change.action !== 'add'))
    .sort((left, right) => right.start - left.start)
    .reduce((current, block) => replaceBlock(current, block, rendered.get(block.name) ?? ''), text);

  const added = changes.filter((change) => change.action === 'add').map((change) => rendered.get(change.template.name) ?? '');
  return ok(added.length === 0 ? replaced : appendBlocks(replaced, added));
};

/** The new raw value of the state file: the migrated value and the versions of the changed blocks. */
const nextStateRaw = (migrated: unknown, changes: readonly BlockPlan[]): CliResult<unknown> => {
  if (changes.length === 0) return ok(migrated);
  if (!isRecord(migrated)) return failure(`${stateKeys.blocks}: the migrated state is not a mapping`);
  const current = migrated[stateKeys.blocks];
  const versions = Object.fromEntries(changes.map((change) => [change.template.name, change.template.version]));
  return ok({ ...migrated, [stateKeys.blocks]: { ...(isRecord(current) ? current : {}), ...versions } });
};

const timestampOf = (deps: Deps): string => deps.now().toISOString().replace(/[:.]/g, '-');

/** The name of a backup folder: a timestamp. Any other name in the backups folder is not ours. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export const BACKUPS_KEPT = 5;

/**
 * Copy the files that upgrade can change. The run-time folders `state/` and `locks/` are left out:
 * upgrade writes only the config file, CLAUDE.md, the protocol file and the state file, and it never writes into them.
 */
export const backup = async (deps: Deps, home: string): Promise<CliResult<string>> => {
  const layout = layoutOf(home);
  const target = join(layout.backupsDir, timestampOf(deps));
  const exists = await deps.fs.stat(target);
  if (!exists.ok) return exists;
  if (exists.value !== null) return failure(`the backup folder ${relative(home, target)} exists already`);
  const made = await deps.fs.mkdir(target);
  if (!made.ok) return made;

  const copies: readonly (readonly [string, string, readonly string[]])[] = [
    [layout.configFile, join(target, files.config), []],
    [layout.claudeMd, join(target, files.claudeMd), []],
    [layout.stateDir, join(target, dirs.state), [layout.backupsDir, layout.runtimeDir, layout.locksDir]],
  ];
  for (const [from, to, skip] of copies) {
    const kind = await deps.fs.stat(from);
    if (!kind.ok) return kind;
    if (kind.value === null) continue;
    const copied = await deps.fs.copyTree(from, to, skip);
    if (!copied.ok) return copied;
  }
  return ok(target);
};

/**
 * Remove the oldest backups, so that at most `BACKUPS_KEPT` stay and the current one is one of them.
 * Folders with another name stay. Returns the messages of the failures.
 */
export const pruneBackups = async (deps: Deps, home: string, current: string): Promise<readonly string[]> => {
  const { backupsDir } = layoutOf(home);
  const names = await deps.fs.list(backupsDir);
  if (!names.ok) return [names.error.message];
  const older = names.value.filter((name) => BACKUP_NAME.test(name) && join(backupsDir, name) !== current);
  const problems: string[] = [];
  for (const name of older.slice(0, Math.max(0, older.length - (BACKUPS_KEPT - 1)))) {
    const removed = await deps.fs.remove(join(backupsDir, name));
    if (!removed.ok) problems.push(removed.error.message);
  }
  return problems;
};

/** Put the old text back, newest change first. Returns the messages of the failures. */
export const restore = async (deps: Deps, written: readonly Written[]): Promise<readonly string[]> => {
  const problems: string[] = [];
  for (const entry of [...written].reverse()) {
    const result =
      entry.previous === null ? await deps.fs.remove(entry.path) : await deps.fs.writeTextAtomic(entry.path, entry.previous);
    if (!result.ok) problems.push(result.error.message);
  }
  return problems;
};

export interface NewFile {
  readonly path: string;
  readonly text: string;
}

/** Write the files whose text changes. Each old text goes to `written` first. */
export const writeAll = async (deps: Deps, newFiles: readonly NewFile[], written: Written[]): Promise<CliResult<void>> => {
  for (const file of newFiles) {
    const previous = await readIfFile(deps, file.path);
    if (!previous.ok) return previous;
    if (previous.value === file.text) continue;
    written.push({ path: file.path, previous: previous.value });
    const result = await deps.fs.writeTextAtomic(file.path, file.text);
    if (!result.ok) return result;
  }
  return ok(undefined);
};

export const blockFileTexts = async (
  deps: Deps,
  home: string,
  changes: readonly BlockPlan[],
): Promise<CliResult<readonly NewFile[]>> => {
  const layout = layoutOf(home);
  const paths = [...new Set(changes.map((change) => fileOfTarget(layout, change.template.target)))];
  const result: NewFile[] = [];
  for (const path of paths) {
    const text = await readIfFile(deps, path);
    if (!text.ok) return text;
    const edited = editBlockFile(
      text.value ?? '',
      changes.filter((change) => fileOfTarget(layout, change.template.target) === path),
    );
    if (!edited.ok) return failure(`${relative(home, path)}: ${edited.error.message}`);
    result.push({ path, text: edited.value });
  }
  return ok(result);
};

export const stateFileText = (state: FilePlan, upgrade: UpgradeSpec, changes: readonly BlockPlan[]): CliResult<string | null> => {
  if (state.kind === 'current' && changes.length === 0) return ok(null);
  const migrated = state.kind === 'migrate' ? runMigrations(state.raw, state.steps) : ok(state.raw);
  if (!migrated.ok) return failure(`${upgrade.state.spec.file}: ${migrated.error.message}`);
  const next = nextStateRaw(migrated.value, changes);
  if (!next.ok) return next;
  const text = upgrade.state.finish(next.value);
  return text.ok ? ok(text.value) : failure(`${upgrade.state.spec.file}: ${text.error.message}`);
};

export const configFileText = (config: FilePlan, upgrade: UpgradeSpec): CliResult<string | null> => {
  if (config.kind === 'current') return ok(null);
  const migrated = runMigrations(config.raw, config.steps);
  if (!migrated.ok) return failure(`${upgrade.config.spec.file}: ${migrated.error.message}`);
  const text = upgrade.config.finish(migrated.value);
  return text.ok ? ok(text.value) : failure(`${upgrade.config.spec.file}: ${text.error.message}`);
};
