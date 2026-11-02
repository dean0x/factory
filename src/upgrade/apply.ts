import { dirname, join, relative } from 'node:path';
import { fileOfTarget, renamedFromOf } from '../blocks/status.js';
import { appendBlocks, parseBlocks, renderBlock, replaceBlock, type ParsedBlock } from '../blocks/managed.js';
import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { inspectParsed, isRecord, requireValid } from '../migrate/inspect.js';
import { isTextMigration, runMigrations, runTextMigrations } from '../migrate/runner.js';
import { dirs, files, stateKeys } from '../names.js';
import { layoutOf } from '../state/layout.js';
import type { BlockPlan, FilePlan, MovePlan } from './plan.js';
import type { UpgradeFile, UpgradeSpec } from './spec.js';

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

  // A block is found by its name in the file: the name of the template, or the old name when the block gets a new one.
  const changeOf = (block: ParsedBlock): BlockPlan | undefined =>
    changes.find(
      (change) =>
        change.action !== 'add' && (change.template.name === block.name || renamedFromOf(change.status) === block.name),
    );
  const replaced = parsed.value
    .filter((block) => changeOf(block) !== undefined)
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, block) => replaceBlock(current, block, rendered.get(changeOf(block)?.template.name ?? '') ?? ''),
      text,
    );

  const added = changes.filter((change) => change.action === 'add').map((change) => rendered.get(change.template.name) ?? '');
  return ok(added.length === 0 ? replaced : appendBlocks(replaced, added));
};

/**
 * The new raw value of the state file: the migrated value and the versions of the changed blocks.
 * A block that gets a new name leaves its old name.
 */
const nextStateRaw = (migrated: unknown, changes: readonly BlockPlan[]): CliResult<unknown> => {
  if (changes.length === 0) return ok(migrated);
  if (!isRecord(migrated)) return failure(`${stateKeys.blocks}: the migrated state is not a mapping`);
  const current = migrated[stateKeys.blocks];
  const versions = Object.fromEntries(changes.map((change) => [change.template.name, change.template.version]));
  const oldNames = new Set(changes.flatMap((change) => renamedFromOf(change.status) ?? []));
  const kept = Object.entries(isRecord(current) ? current : {}).filter(([name]) => !oldNames.has(name));
  return ok({ ...migrated, [stateKeys.blocks]: { ...Object.fromEntries(kept), ...versions } });
};

const timestampOf = (deps: Deps): string => deps.now().toISOString().replace(/[:.]/g, '-');

/** The name of a backup folder: a timestamp. Any other name in the backups folder is not ours. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export const BACKUPS_KEPT = 5;

/**
 * Copy the files that upgrade can change. The run-time folders `state/` and `locks/` are left out:
 * upgrade writes only the config file, CLAUDE.md, the worker file and the state file, and it never writes into them.
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

/** A move that was done. The paths are absolute. */
export interface Moved {
  readonly from: string;
  readonly to: string;
  /** The folder that the move made for its target, or null when the folder was there. */
  readonly madeDir: string | null;
}

/** Move the files and the folders. Each move goes to `moved` as soon as it is done. */
export const applyMoves = async (deps: Deps, moves: readonly MovePlan[], moved: Moved[]): Promise<CliResult<void>> => {
  for (const move of moves) {
    const parent = dirname(move.toPath);
    const parentKind = await deps.fs.stat(parent);
    if (!parentKind.ok) return parentKind;
    const made = await deps.fs.mkdir(parent);
    if (!made.ok) return made;
    const madeDir = parentKind.value === null ? parent : null;
    const result = await deps.fs.rename(move.fromPath, move.toPath);
    if (!result.ok) {
      // The move did not happen, so the folder that it made is empty. Removing it is only tidiness.
      if (madeDir !== null) await deps.fs.removeEmptyDir(madeDir);
      return result;
    }
    moved.push({ from: move.fromPath, to: move.toPath, madeDir });
  }
  return ok(undefined);
};

/**
 * Put the old state back, newest change first: the old texts, then the moves back, then the folders that a move made.
 * Returns the messages of the failures.
 */
export const restore = async (
  deps: Deps,
  written: readonly Written[],
  moved: readonly Moved[] = [],
): Promise<readonly string[]> => {
  const problems: string[] = [];
  for (const entry of [...written].reverse()) {
    const result =
      entry.previous === null ? await deps.fs.remove(entry.path) : await deps.fs.writeTextAtomic(entry.path, entry.previous);
    if (!result.ok) problems.push(result.error.message);
  }
  for (const move of [...moved].reverse()) {
    const back = await deps.fs.rename(move.to, move.from);
    if (!back.ok) {
      problems.push(back.error.message);
      continue;
    }
    if (move.madeDir !== null) {
      const removed = await deps.fs.removeEmptyDir(move.madeDir);
      if (!removed.ok) problems.push(removed.error.message);
    }
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

/** The text, when it parses and holds a valid value of the current schema. */
const checkedText = (text: string, file: UpgradeFile): CliResult<string> => {
  const raw = file.parse(text);
  if (!raw.ok) return failure(`${file.spec.file} does not parse: ${raw.error}`);
  const checked = requireValid(inspectParsed(raw.value, file.spec), file.spec.file);
  return checked.ok ? ok(text) : checked;
};

/**
 * The new text of the config file. When every step can work on the text, the steps edit the text of the owner, so that
 * the comments and the order of the keys stay. Else the steps migrate the value and the file is written from it.
 * Either way, the new text is checked before the caller writes it.
 */
export const configFileText = async (
  deps: Deps,
  path: string,
  config: FilePlan,
  upgrade: UpgradeSpec,
): Promise<CliResult<string | null>> => {
  if (config.kind === 'current') return ok(null);
  const file = upgrade.config;
  const label = file.spec.file;

  const textSteps = config.steps.filter(isTextMigration);
  if (textSteps.length < config.steps.length) {
    const migrated = runMigrations(config.raw, config.steps);
    if (!migrated.ok) return failure(`${label}: ${migrated.error.message}`);
    const text = file.finish(migrated.value);
    return text.ok ? ok(text.value) : failure(`${label}: ${text.error.message}`);
  }

  const original = await readIfFile(deps, path);
  if (!original.ok) return original;
  if (original.value === null) return failure(`${label} not found`);
  const migrated = runTextMigrations(original.value, textSteps);
  if (!migrated.ok) return failure(`${label}: ${migrated.error.message}`);
  return checkedText(migrated.value, file);
};
