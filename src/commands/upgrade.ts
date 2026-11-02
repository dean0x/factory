import { join, relative, resolve } from 'node:path';
import { fileOfTarget, inspectBlocks, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { commitPaths, hasIdentity, headOf, statusOf, unstagePaths, type RepoPaths } from '../core/git.js';
import { resolveHome } from '../core/home.js';
import { isSameOrInside } from '../core/paths.js';
import { ok } from '../core/result.js';
import { commands, commandText, dirs, flags, flagText, roles, schemaIds } from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
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
const MAX_SHOWN_PATHS = 5;

/** The paths of `paths` that are in the state repo, relative to it, each one once. */
const inStateRepo = (layout: Layout, paths: readonly string[]): readonly string[] => [
  ...new Set(paths.filter((path) => isSameOrInside(layout.stateDir, path)).map((path) => relative(layout.stateDir, path))),
];

const shownPaths = (paths: readonly string[]): string => {
  const shown = paths.slice(0, MAX_SHOWN_PATHS).join(', ');
  return paths.length > MAX_SHOWN_PATHS ? `${shown} and ${paths.length - MAX_SHOWN_PATHS} more` : shown;
};

/**
 * Refuse when the commit of the upgrade could take a change of the owner. The index of the state repo must hold no
 * staged change. A file that the upgrade changes must have no change of the owner, staged or not.
 */
const checkStateRepoReady = async (deps: Deps, layout: Layout, touched: readonly string[]): Promise<CliResult<void>> => {
  const status = await statusOf(deps, layout.stateDir);
  if (!status.ok) return status;
  const again = `Then run "${commandText(commands.upgrade)}" again.`;
  const staged = status.value.filter((entry) => ![' ', '?', '!'].includes(entry.index));
  if (staged.length > 0) {
    return failure(
      `${dirs.state} has staged changes: ${shownPaths(staged.map((entry) => entry.path))}`,
      `Commit them, or clear them with "git reset" in ${dirs.state}. ${again}`,
    );
  }
  const changed = status.value.filter((entry) =>
    touched.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
  );
  if (changed.length > 0) {
    return failure(
      `${dirs.state} has changes in files that the upgrade changes: ${shownPaths(changed.map((entry) => entry.path))}`,
      `Commit them, or put the files back with git in ${dirs.state}. ${again}`,
    );
  }
  return ok(undefined);
};

/** The commit of the upgrade: the id of HEAD before it, and the paths that it staged. */
interface CommitAttempt {
  readonly head: string | null;
  readonly paths: RepoPaths;
}

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
    // These are the files that the upgrade can change in the repo: the commit holds those and no other file.
    const touched = inStateRepo(layout, [
      ...files.value.moves.flatMap((move) => [move.fromPath, move.toPath]),
      ...(stateText.value === null ? [] : [layout.nodeJson]),
      ...changes.map((change) => fileOfTarget(layout, change.template.target)),
    ]);
    const ready = await checkStateRepoReady(deps, layout, touched);
    if (!ready.ok) return ready;
  }

  const backupDir = await backup(deps, home);
  if (!backupDir.ok) return backupDir;
  const backupPath = relative(home, backupDir.value);

  const written: Written[] = [];
  const moved: Moved[] = [];
  let commit: CommitAttempt | null = null;
  const abort = async (error: string): Promise<CliResult<never>> => {
    const attempt = commit;
    if (attempt !== null) {
      // The commit may have landed although git reported an error, for example when the time limit stopped git.
      const head = await headOf(deps, layout.stateDir);
      if (!head.ok) {
        return failure(
          `${error}. ${head.error.message}, so the files are not put back. ` +
            `Run "git log -1 --stat" in ${dirs.state} to see whether the upgrade commit is there. ` +
            `If it is not, restore the files from ${backupPath}.`,
        );
      }
      if (head.value !== attempt.head) {
        return failure(
          `${error}. The upgrade commit was made in ${dirs.state}, so the files stay upgraded. ` +
            `Run "git log -1 --stat" in ${dirs.state} to check it. ` +
            `Then run "${commandText(commands.upgrade)}" again: it must say that there is nothing to upgrade. ` +
            `The backup is in ${backupPath}.`,
        );
      }
    }
    const problems = await restore(deps, written, moved);
    const unstaged = attempt === null ? ok(undefined) : await unstagePaths(deps, layout.stateDir, attempt.paths);
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

  const paths: RepoPaths = {
    present: inStateRepo(layout, [...written.map((entry) => entry.path), ...moved.map((move) => move.to)]),
    gone: inStateRepo(layout, moved.map((move) => move.from)),
  };
  const stateChanged = paths.present.length > 0;
  if (stateChanged) {
    const head = await headOf(deps, layout.stateDir);
    if (!head.ok) return abort(head.error.message);
    commit = { head: head.value, paths };
    const committed = await commitPaths(deps, layout.stateDir, paths, COMMIT_MESSAGE);
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
