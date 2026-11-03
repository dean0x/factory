import { join, relative } from 'node:path';
import { fileOfTarget, inspectBlocks, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable, type CommandOutput, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { loadConfig, readNodeIdentity, settleLocalMode } from '../config/load.js';
import { commitPaths, hasIdentity, headOf, statusOf, unstagePaths, type RepoPaths } from '../core/git.js';
import { locateHomeFolder } from '../core/home.js';
import { indexPathOf, recordNode } from '../core/home-index.js';
import { isSameOrInside } from '../core/paths.js';
import { ok } from '../core/result.js';
import {
  commands,
  commandText,
  dirs,
  env,
  flags,
  flagText,
  localFileModes,
  places,
  program,
  roles,
  schemaIds,
} from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
import {
  applyMoves,
  backup,
  blockFileTexts,
  configFileText,
  localFileText,
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
  planLocal,
  planRootMoves,
  refusalOf,
  type FilesPlan,
} from '../upgrade/plan.js';
import { currentSpec, type UpgradeSpec } from '../upgrade/spec.js';
import { ACCEPT_ANSWER } from './init-home.js';

export interface UpgradeOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
  readonly overwrite: readonly string[];
  /** The owner's yes to the registration of a folder that the factory list does not list. */
  readonly yes: boolean;
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

/**
 * Put the upgraded home in the home index, as init does, so that a command finds the home from a project folder.
 * The home is upgraded already, so a problem here is a warning and not a failure.
 */
const indexUpgraded = async (deps: Deps, home: string): Promise<readonly OutLine[]> => {
  const warn = (texts: readonly string[]): readonly OutLine[] => texts.map((text) => ({ level: 'warn', text }));
  const indexPath = await indexPathOf(deps);
  if (!indexPath.ok) return warn([`The home index was not updated: ${indexPath.error.message}`]);
  const config = await loadConfig(deps, home);
  if (!config.ok) return warn([`The home index was not updated: ${config.error.message}`]);
  return warn(
    await recordNode(deps, indexPath.value, {
      home,
      id: config.value.core.node.id,
      projects: config.value.recipe.projects.map((project) => project.path),
    }),
  );
};

/** The commit of the upgrade: the id of HEAD before it, and the paths that it staged. */
interface CommitAttempt {
  readonly head: string | null;
  readonly paths: RepoPaths;
}

/**
 * The owner's yes for a folder that the factory list does not list. `upgrade` registers the folder at its end, so the
 * owner must say yes first: on a terminal window after a question (the default is no), or with the yes flag. A factory
 * session never says it, and a dry run writes nothing, so it asks nothing.
 */
const requireRegistrationConsent = async (
  deps: Deps,
  home: string,
  options: UpgradeOptions,
): Promise<CliResult<void>> => {
  const inSession = deps.env[env.session];
  if (inSession !== undefined && inSession !== '') {
    return safetyRefusal(
      `${home} is not in the ${places.list}, and a ${places.session} can not register it`,
      `Run "${commandText(commands.upgrade)} ${flagText(flags.home)} ${home}" in a terminal window outside a ${places.session}.`,
    );
  }
  if (options.dryRun || options.yes) return ok(undefined);
  const again = `Run "${commandText(commands.upgrade)} ${flagText(flags.home)} ${home}" in a terminal window, or add ${flagText(flags.yes)}.`;
  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return usageError(`${home} is not in the ${places.list}, and ${program} registers it only after your yes`, again);
  }
  const identity = await readNodeIdentity(deps, home);
  const who = identity.ok ? ` (${roles.node} id ${identity.value.id})` : '';
  const answer = await deps.prompt(
    printable(`The ${places.list} has no entry for ${home}${who}. Upgrade it and register it? [y/N] `),
  );
  if (!answer.ok) return answer;
  return ACCEPT_ANSWER.test(answer.value.trim()) ? ok(undefined) : usageError(`${home} was not registered. Nothing changed`, again);
};

export const runUpgrade = async (
  deps: Deps,
  options: UpgradeOptions,
  upgrade: UpgradeSpec = currentSpec,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(deps, options.home, readNodeIdentity, { allowUnregisteredSchema1: true });
  if (!located.ok) return located;
  const home = located.value.home;
  if (located.value.unregistered) {
    const consent = await requireRegistrationConsent(deps, home, options);
    if (!consent.ok) return consent;
  }
  const layout = layoutOf(home);

  const config = await planFile(deps, layout.configFile, upgrade.config);
  if (!config.ok) return config;
  const local = await planLocal(deps, layout, config.value, upgrade);
  if (!local.ok) return local;
  // A real run sets a wide mode of the local file back to 600. A dry run only names the command.
  const modeNotes = await settleLocalMode(deps, home, !options.dryRun);
  if (!modeNotes.ok) return modeNotes;
  const state = await planFile(deps, layout.nodeJson, upgrade.state);
  if (!state.ok) return state;
  const stateFiles = await planFiles(deps, layout, state.value, upgrade.files);
  if (!stateFiles.ok) return stateFiles;
  const rootMoved = await planRootMoves(deps, layout, upgrade.rootMoves);
  if (!rootMoved.ok) return rootMoved;
  // The moves outside the state folder come first. A block file is read at its old place until the move is done.
  const files: FilesPlan = { ...stateFiles.value, moves: [...rootMoved.value, ...stateFiles.value.moves] };
  const blockSet = planBlockSet(config.value, local.value, upgrade);
  if (!blockSet.ok) return blockSet;

  const known = blockSet.value.templates.map((template) => template.name);
  const oldNames = [...upgrade.files.flatMap((step) => step.renames), ...blockSet.value.renames].map((rename) => rename.from);  const unknown = options.overwrite.filter((name) => !known.includes(name) && !oldNames.includes(name));
  if (unknown.length > 0) {
    return usageError(`${flagText(flags.overwrite)}: unknown block ${unknown.join(', ')}`, `The blocks are: ${known.join(', ')}.`);
  }

  // A block that gets a new name is named by its old name or its new name.
  const named = (status: BlockStatus): boolean =>
    options.overwrite.some((name) => name === status.template.name || name === renamedFromOf(status));
  const pending = { ...files, renames: [...files.renames, ...blockSet.value.renames] };
  const blocks = (await inspectBlocks(deps, home, blockSet.value.templates, pending)).map((status) =>
    planBlock(status, named(status)),
  );

  const refused = refusalOf(blocks);
  if (!refused.ok) return refused;

  const changes = blocks.filter(isChange);
  const changed =
    config.value.kind === 'migrate' ||
    local.value.kind !== 'current' ||
    state.value.kind === 'migrate' ||
    files.moves.length > 0 ||
    changes.length > 0;

  // The new texts come from pure functions. The dry run makes them too, so that it reports what the real run refuses.
  const stateText = stateFileText(state.value, upgrade, changes);
  if (!stateText.ok) return stateText;
  const configText = await configFileText(deps, layout.configFile, config.value, upgrade);
  if (!configText.ok) return configText;
  const localText = localFileText(config.value, local.value, upgrade);
  if (!localText.ok) return localText;

  const lines: OutLine[] = [
    ...planLines(config.value, local.value, state.value, files, blocks, upgrade),
    ...modeNotes.value.map((text): OutLine => ({ level: 'warn', text })),
  ];
  const warnings = lines.filter((line) => line.level === 'warn').map((line) => line.text);
  const summary = {
    config: { from: config.value.kind === 'current' ? config.value.version : config.value.from, to: upgrade.config.spec.supported },
    local: {
      from: local.value.kind === 'current' ? local.value.version : local.value.kind === 'create' ? null : local.value.from,
      to: upgrade.local.spec.supported,
    },
    state: { from: state.value.kind === 'current' ? state.value.version : state.value.from, to: upgrade.state.spec.supported },
    moves: files.moves.map((move) => ({ from: move.from, to: move.to })),
    replaces: files.replaces.map((replace) => ({ path: replace.path, action: replace.action })),
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

  const replacements = files.replaces.filter((replace) => replace.action === 'replace');
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
      ...files.moves.flatMap((move) => [move.fromPath, move.toPath]),
      ...replacements.map((replace) => replace.filePath),
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

  const movedFiles = await applyMoves(deps, files.moves, moved);
  if (!movedFiles.ok) return abort(movedFiles.error.message);
  const blockTexts = await blockFileTexts(deps, home, changes);
  if (!blockTexts.ok) return abort(blockTexts.error.message);

  const newFiles: NewFile[] = [
    ...blockTexts.value,
    ...replacements.map((replace) => ({ path: replace.filePath, text: replace.text })),
    ...(stateText.value === null ? [] : [{ path: layout.nodeJson, text: stateText.value }]),
    // The local file comes before the shared file, which is the last to change. A run that stops between the two leaves
    // the old shared file with all its keys.
    ...(localText.value === null
      ? []
      : [{ path: layout.localConfigFile, text: localText.value, mode: localFileModes.private }]),
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
  const indexed = await indexUpgraded(deps, home);
  return done(
    [
      { level: 'ok', text: `Changed ${count} ${count === 1 ? 'file' : 'files'}. The backup is in ${backupPath}.` },
      ...(pruned.length === 0
        ? []
        : [{ level: 'warn' as const, text: `Old ${dirs.backups} could not be removed: ${pruned.join('; ')}.` }]),
      ...indexed,
    ],
    backupPath,
    stateChanged,
  );
};
