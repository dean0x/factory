import { join, relative, resolve } from 'node:path';
import { inspectBlocks, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { commitAll, hasIdentity, unstageAll } from '../core/git.js';
import { resolveHome } from '../core/home.js';
import { ok } from '../core/result.js';
import { commands, commandText, dirs, flags, flagText, roles, schemaIds } from '../names.js';
import { layoutOf } from '../state/layout.js';
import {
  applyMoves,
  backup,
  blockFileTexts,
  configFileText,
  pruneBackups,
  restore,
  stateFileText,
  writeAll,
  type Moved,
  type NewFile,
  type Written,
} from '../upgrade/apply.js';
import {
  isChange,
  planBlock,
  planBlockSet,
  planFile,
  planFiles,
  planLines,
  planProjectPaths,
  refusalOf,
  type FilePlan,
} from '../upgrade/plan.js';
import { currentSpec, type UpgradeSpec } from '../upgrade/spec.js';
import { checkHomeApart, checkHomeHoldsNoRepo, checkHomeLocation } from './init-home.js';

export interface UpgradeOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
  readonly overwrite: readonly string[];
}

const COMMIT_MESSAGE = 'chore: upgrade the state';

/**
 * A warning for each home rule that the home breaks. The upgrade still runs, because the owner moves the home.
 * The paths of the projects are those of the config after the migrations.
 */
const homeRuleLines = async (
  deps: Deps,
  home: string,
  config: FilePlan,
  upgrade: UpgradeSpec,
): Promise<CliResult<readonly OutLine[]>> => {
  const paths = planProjectPaths(config, upgrade);
  if (!paths.ok) return paths;
  const projects = paths.value.map((path) => resolve(home, path));
  const remedy =
    `${commandText(commands.doctor)} fails for this home. Move the home to a folder beside the projects, ` +
    `outside every git work tree and every other ${roles.node} home, and fix the project paths in ${upgrade.config.spec.file}.`;

  const results = [
    await checkHomeLocation(deps, home),
    await checkHomeHoldsNoRepo(deps, home),
    await checkHomeApart(deps, home, projects),
  ];
  const lines: OutLine[] = [];
  for (const result of results) {
    if (result.ok) continue;
    if (result.error.kind !== 'safety') return result;
    lines.push({ level: 'warn', text: `${result.error.message}. ${remedy}` });
  }
  return ok(lines);
};

export const runUpgrade = async (
  deps: Deps,
  options: UpgradeOptions,
  upgrade: UpgradeSpec = currentSpec,
): Promise<CliResult<CommandOutput>> => {
  const resolved = await resolveHome(deps, options.home);
  if (!resolved.ok) return resolved;
  const home = resolved.value;
  const folder = await deps.fs.stat(home);
  if (!folder.ok) return folder;
  if (folder.value !== 'dir') return failure(`${home} is not a folder`);
  const layout = layoutOf(home);

  const config = await planFile(deps, layout.configFile, upgrade.config);
  if (!config.ok) return config;
  const state = await planFile(deps, layout.nodeJson, upgrade.state);
  if (!state.ok) return state;
  const files = await planFiles(deps, layout, state.value, upgrade.files);
  if (!files.ok) return files;
  const blockSet = planBlockSet(config.value, upgrade);
  if (!blockSet.ok) return blockSet;

  const known = blockSet.value.templates.map((template) => template.name);
  const oldNames = [...upgrade.files.flatMap((step) => step.renames), ...blockSet.value.renames].map((rename) => rename.from);
  const unknown = options.overwrite.filter((name) => !known.includes(name) && !oldNames.includes(name));
  if (unknown.length > 0) {
    return usageError(`${flagText(flags.overwrite)}: unknown block ${unknown.join(', ')}`, `The blocks are: ${known.join(', ')}.`);
  }

  // A block that gets a new name is named by its old name or its new name.
  const named = (status: BlockStatus): boolean =>
    options.overwrite.some((name) => name === status.template.name || name === renamedFromOf(status));
  const pending = { ...files.value, renames: [...files.value.renames, ...blockSet.value.renames] };
  const blocks = (await inspectBlocks(deps, home, blockSet.value.templates, pending)).map((status) =>
    planBlock(status, named(status)),
  );

  const refused = refusalOf(blocks);
  if (!refused.ok) return refused;

  const changes = blocks.filter(isChange);
  const changed = config.value.kind === 'migrate' || state.value.kind === 'migrate' || changes.length > 0;

  // The new texts come from pure functions. The dry run makes them too, so that it reports what the real run refuses.
  const stateText = stateFileText(state.value, upgrade, changes);
  if (!stateText.ok) return stateText;
  const configText = await configFileText(deps, layout.configFile, config.value, upgrade);
  if (!configText.ok) return configText;

  const homeLines = changed ? await homeRuleLines(deps, home, config.value, upgrade) : ok<readonly OutLine[]>([]);
  if (!homeLines.ok) return homeLines;

  const lines = [...planLines(config.value, state.value, files.value, blocks, upgrade), ...homeLines.value];
  const warnings = lines.filter((line) => line.level === 'warn').map((line) => line.text);
  const summary = {
    config: { from: config.value.kind === 'current' ? config.value.version : config.value.from, to: upgrade.config.spec.supported },
    state: { from: state.value.kind === 'current' ? state.value.version : state.value.from, to: upgrade.state.spec.supported },
    moves: files.value.moves.map((move) => ({ from: move.from, to: move.to })),
    blocks: blocks.map((plan) => ({
      name: plan.template.name,
      action: plan.action,
      from: plan.from,
      to: plan.template.version,
      renamedFrom: renamedFromOf(plan.status) ?? null,
    })),
  };
  const done = (extra: readonly OutLine[], backupPath: string | null, committed: boolean): CliResult<CommandOutput> =>
    ok({
      lines: [...lines, ...extra],
      json: { schema: schemaIds.upgrade, home, dryRun: options.dryRun, changed, ...summary, backup: backupPath, committed },
      warnings: [...warnings, ...extra.filter((line) => line.level === 'warn').map((line) => line.text)],
      failed: false,
    });

  if (!changed) return done([{ level: 'text', text: 'Nothing to upgrade.' }], null, false);
  if (options.dryRun) return done([{ level: 'text', text: 'Dry run: no file was changed.' }], null, false);

  const touchesState = state.value.kind === 'migrate' || changes.length > 0;
  if (touchesState) {
    const repo = await deps.fs.stat(join(layout.stateDir, '.git'));
    if (!repo.ok) return repo;
    if (repo.value === null) {
      return failure(`${dirs.state} is not a git repository`, `Run "${commandText(commands.doctor)}".`);
    }
    if (!(await hasIdentity(deps, layout.stateDir))) {
      return failure('git has no user.name and user.email', 'Set both with "git config --global", then run the command again.');
    }
  }

  const backupDir = await backup(deps, home);
  if (!backupDir.ok) return backupDir;
  const backupPath = relative(home, backupDir.value);

  const written: Written[] = [];
  const moved: Moved[] = [];
  const abort = async (error: string): Promise<CliResult<never>> => {
    const problems = await restore(deps, written, moved);
    const unstaged = touchesState ? await unstageAll(deps, layout.stateDir) : ok(undefined);
    const notes: string[] = [];
    if (problems.length > 0) {
      const many = problems.length > 1;
      notes.push(
        `${problems.length} ${many ? 'files' : 'file'} could not be restored: ${problems.join('; ')}. ` +
          `Restore ${many ? 'them' : 'it'} from ${backupPath}.`,
      );
    }
    if (!unstaged.ok) {
      notes.push(`${unstaged.error.message}. Run "git reset" in ${dirs.state} to clear the staged files.`);
    }
    return failure(
      notes.length === 0
        ? `${error}. The files are as they were. The backup is in ${backupPath}.`
        : `${error}. ${notes.join(' ')}`,
    );
  };

  const movedFiles = await applyMoves(deps, files.value.moves, moved);
  if (!movedFiles.ok) return abort(movedFiles.error.message);
  const blockTexts = await blockFileTexts(deps, home, changes);
  if (!blockTexts.ok) return abort(blockTexts.error.message);

  const newFiles: NewFile[] = [
    ...blockTexts.value,
    ...(stateText.value === null ? [] : [{ path: layout.nodeJson, text: stateText.value }]),
    ...(configText.value === null ? [] : [{ path: layout.configFile, text: configText.value }]),
  ];
  const wrote = await writeAll(deps, newFiles, written);
  if (!wrote.ok) return abort(wrote.error.message);

  const stateChanged =
    moved.length > 0 || written.some((entry) => !relative(layout.stateDir, entry.path).startsWith('..'));
  if (stateChanged) {
    const committed = await commitAll(deps, layout.stateDir, COMMIT_MESSAGE);
    if (!committed.ok) return abort(committed.error.message);
  }

  const count = written.length + moved.length;
  const pruned = await pruneBackups(deps, home, backupDir.value);
  return done(
    [
      { level: 'ok', text: `Changed ${count} ${count === 1 ? 'file' : 'files'}. The backup is in ${backupPath}.` },
      ...(pruned.length === 0
        ? []
        : [{ level: 'warn' as const, text: `Old ${dirs.backups} could not be removed: ${pruned.join('; ')}.` }]),
    ],
    backupPath,
    stateChanged,
  );
};
