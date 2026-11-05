import { join, relative } from 'node:path';
import { fileOfTarget, inspectBlocks, renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable, type CommandOutput, type OutLine } from '../cli/output.js';
import { ACCEPT_ANSWER, type Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { loadConfig, readNodeIdentity, settleLocalMode } from '../config/load.js';
import {
  commitPaths,
  GIT_ENTRY,
  headOf,
  requireStateRepoCommit,
  unstagePaths,
  type RepoPaths,
} from '../core/git.js';
import { locateHomeFolder, type NodeIdReader } from '../core/home.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { indexPathOf, originOfHome, recordNode, type Origin } from '../core/home-index.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import { requireNoRootLinks } from '../core/root-paths.js';
import { blockRenamesOf } from '../migrate/files.js';
import {
  blockNames,
  commands,
  commandText,
  dirs,
  flags,
  flagText,
  homeIndex,
  localFileModes,
  overwriteCommand,
  places,
  program,
  roles,
  rootRepo,
  schemaIds,
} from '../names.js';
import { layoutOf } from '../state/layout.js';
import type { SetupTexts } from '../templates/types.js';
import {
  applyMoves,
  backup,
  backupBlocks,
  blockFileTexts,
  configFileText,
  inStateRepo,
  localFileText,
  makeRootRepo,
  pruneBackups,
  pruneBlockBackups,
  restore,
  stateFileText,
  writeAll,
  type BlockBackup,
  type MadeRootRepo,
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
  planRoot,
  planRootMoves,
  planStateGitignore,
  refusalOf,
  settleSetupBlocks,
  type FilesPlan,
} from '../upgrade/plan.js';
import { applyHookSettings, hookPlanLines, planHookSettings } from '../upgrade/hook-settings.js';
import { specFor, type UpgradeSpec } from '../upgrade/spec.js';
import { acceptReason, checkRootSetup, settleSetup } from './setup-check.js';

export interface UpgradeOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
  readonly overwrite: readonly string[];
  /** The owner's yes to the registration of a folder that the factory list does not list. */
  readonly yes: boolean;
}

const COMMIT_MESSAGE = 'chore: upgrade the state';

/**
 * Put the upgraded home in the home index, as init does, so that a command finds the home from a project folder.
 * The home is upgraded already, so a problem here is a warning and not a failure.
 */
const indexUpgraded = async (
  deps: Deps,
  home: string,
  origin: Origin,
  registry: RecipeRegistry,
): Promise<readonly OutLine[]> => {
  const warn = (texts: readonly string[]): readonly OutLine[] => texts.map((text) => ({ level: 'warn', text }));
  const indexPath = await indexPathOf(deps);
  if (!indexPath.ok) return warn([`The ${places.list} was not updated: ${indexPath.error.message}`]);
  const config = await loadConfig(deps, home, registry);
  if (!config.ok) return warn([`The ${places.list} was not updated: ${config.error.message}`]);
  const recorded = await recordNode(deps, indexPath.value, {
    home,
    id: config.value.core.node.id,
    projects: config.value.recipe.projects.map((project) => project.path),
    origin,
  });
  return recorded.ok
    ? []
    : warn([`${recorded.error} Run "${commandText(commands.init)}" in the ${places.folder} ${home} to register it.`]);
};

/**
 * The origin that the upgrade asks for. A FAC-M1 folder that the list does not list is `own` only when it held no git
 * entry before the run, as every FAC-M1 home. A folder with a git entry may be a copy of another factory, so it is
 * `received`. A git entry that can not be read counts as present. A folder that the list lists keeps the origin of its
 * entry, because the list never takes `own` back from `received`.
 */
const originBeforeRun = async (deps: Deps, home: string, unregistered: boolean): Promise<Origin> => {
  if (!unregistered) return homeIndex.origins.own;
  const entry = await deps.fs.lstat(join(home, GIT_ENTRY));
  return entry.ok && entry.value === null ? homeIndex.origins.own : homeIndex.origins.received;
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
  registry: RecipeRegistry,
): Promise<CliResult<void>> => {
  if (inFactorySession(deps)) {
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
  const identity = await readNodeIdentity(deps, home, registry);
  const who = identity.ok ? ` (${roles.node} id ${identity.value.id})` : '';
  const answer = await deps.prompt(
    printable(`The ${places.list} has no entry for ${home}${who}. Upgrade it and register it? [y/N] `),
  );
  if (!answer.ok) return answer;
  return ACCEPT_ANSWER.test(answer.value.trim()) ? ok(undefined) : usageError(`${home} was not registered. Nothing changed`, again);
};

/** The line for the root repo that the run made. Git with no identity makes the repo and no commit, which is a warning. */
const rootRepoLine = (made: MadeRootRepo): OutLine =>
  made.committed
    ? { level: 'ok', text: `Made the ${places.folder} a git repo. Its first commit holds ${made.paths.join(', ')}.` }
    : { level: 'warn', text: rootRepo.noIdentity };

const NO_SETUP_TEXTS: SetupTexts = { coordinator: null, worker: null };

/**
 * The setup texts that this run may render. The text goes into session instructions, so it needs the owner's acceptance
 * before the run renders it. The check comes before any plan or write, also in a dry run. A first acceptance belongs to
 * `init`, and a change is accepted here only by the owner on a terminal window.
 * A folder that the factory list does not list yet is a FAC-M1 folder: it holds no setup text, and the files that its git
 * repo tracks get their acceptance from `init` once the upgrade has made the layout. A config that names no node id fails
 * the plan with its own message, and until then the run renders no setup text.
 */
const acceptedSetupTexts = async (
  deps: Deps,
  home: string,
  unregistered: boolean,
  dryRun: boolean,
  registry: RecipeRegistry,
): Promise<CliResult<SetupTexts>> => {
  const identity = await readNodeIdentity(deps, home, registry);
  if (!identity.ok) return ok(NO_SETUP_TEXTS);
  const node = identity.value.id;
  const received = !unregistered && (await originOfHome(deps, home)) === homeIndex.origins.received;
  const check = await checkRootSetup(deps, { home, node, received });
  const settled = await settleSetup(deps, { home, node, check, dryRun, reason: acceptReason(commands.upgrade) });
  return settled.ok ? ok(settled.value.texts) : settled;
};

export const runUpgrade = async (
  deps: Deps,
  options: UpgradeOptions,
  registry: RecipeRegistry,
  upgrade: UpgradeSpec = specFor(registry),
): Promise<CliResult<CommandOutput>> => {
  // The safety rules are a security boundary, so only the owner replaces the block, outside a session, also with yes.
  if (inFactorySession(deps) && options.overwrite.includes(blockNames.safety)) {
    return safetyRefusal(
      `a ${places.session} can not replace the ${blockNames.safety} block`,
      `Run "${overwriteCommand(blockNames.safety)}" in a terminal window outside a ${places.session}.`,
    );
  }
  const readIdentity: NodeIdReader = (readDeps, folder) => readNodeIdentity(readDeps, folder, registry);
  const located = await locateHomeFolder(deps, options.home, readIdentity, commands.upgrade, { allowUnregisteredSchema1: true });
  if (!located.ok) return located;
  const home = located.value.home;
  if (located.value.unregistered) {
    const consent = await requireRegistrationConsent(deps, home, options, registry);
    if (!consent.ok) return consent;
  }
  const origin = await originBeforeRun(deps, home, located.value.unregistered);
  const layout = layoutOf(home);
  // The link rule comes first, also in a dry run: no read or write below goes through a link.
  const plain = await requireNoRootLinks(deps, layout);
  if (!plain.ok) return plain;
  const setup = await acceptedSetupTexts(deps, home, located.value.unregistered, options.dryRun, registry);
  if (!setup.ok) return setup;

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
  const root = await planRoot(deps, layout);
  if (!root.ok) return root;
  const stateGitignore = await planStateGitignore(deps, layout);
  if (!stateGitignore.ok) return stateGitignore;
  const blockSet = await planBlockSet(config.value, local.value, upgrade, setup.value, (parsed) =>
    effectiveModes(deps, home, parsed),
  );
  if (!blockSet.ok) return blockSet;

  const known = blockSet.value.templates.map((template) => template.name);
  // A block can hold an old name from an earlier run, so the old names of every step count, not those of this run only.
  const renames = [...blockRenamesOf(upgrade.files), ...blockSet.value.renames];
  const unknown = options.overwrite.filter((name) => !known.includes(name) && !renames.some((rename) => rename.from === name));
  if (unknown.length > 0) {
    return usageError(`${flagText(flags.overwrite)}: unknown block ${unknown.join(', ')}`, `The blocks are: ${known.join(', ')}.`);
  }

  // A block that gets a new name is named by its old name or its new name.
  const named = (status: BlockStatus): boolean =>
    options.overwrite.some((name) => name === status.template.name || name === renamedFromOf(status));
  const pending = { moves: files.moves, renames };
  const blocks = settleSetupBlocks(
    (await inspectBlocks(deps, home, blockSet.value.templates, pending)).map((status) => planBlock(status, named(status))),
  );

  const refused = refusalOf(blocks);
  if (!refused.ok) return refused;

  // The hook settings are planned with no write, so a stop of a check comes before the first write of the run.
  const hooks = await planHookSettings(deps, home, options.yes);
  if (!hooks.ok) return hooks;

  const changes = blocks.filter(isChange);
  const stateChanges =
    config.value.kind === 'migrate' ||
    local.value.kind !== 'current' ||
    state.value.kind === 'migrate' ||
    files.moves.length > 0 ||
    stateGitignore.value.action !== 'current' ||
    root.value.gitignore.action !== 'current' ||
    root.value.repo ||
    changes.length > 0;
  const changed = stateChanges || hooks.value.length > 0;

  // The new texts come from pure functions. The dry run makes them too, so that it reports what the real run refuses.
  const stateText = stateFileText(state.value, upgrade, changes);
  if (!stateText.ok) return stateText;
  const configText = await configFileText(deps, layout.configFile, config.value, upgrade);
  if (!configText.ok) return configText;
  const localText = localFileText(config.value, local.value, upgrade);
  if (!localText.ok) return localText;

  const lines: OutLine[] = [
    ...planLines(config.value, local.value, state.value, files, stateGitignore.value, root.value, blocks, upgrade),
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
    stateGitignore: stateGitignore.value.action,
    gitignore: root.value.gitignore.action,
    rootRepo: root.value.repo,
    blocks: blocks.map((plan) => ({
      name: plan.template.name,
      action: plan.action,
      from: plan.from,
      to: plan.template.version,
      renamedFrom: renamedFromOf(plan.status) ?? null,
    })),
  };
  const done = (
    extra: readonly OutLine[],
    backupPath: string | null,
    committed: boolean,
    blockBackups: readonly BlockBackup[] = [],
    hookSettings: readonly string[] = [],
  ): CliResult<CommandOutput> =>
    ok({
      lines: [...lines, ...extra],
      json: {
        schema: schemaIds.upgrade,
        home,
        dryRun: options.dryRun,
        changed,
        ...summary,
        backup: backupPath,
        blockBackups: blockBackups.map((saved) => saved.path),
        committed,
        hookSettings,
      },
      warnings: [...warnings, ...extra.filter((line) => line.level === 'warn').map((line) => line.text)],
      failed: false,
    });

  if (!changed) return done([{ level: 'text', text: 'Nothing to upgrade.' }], null, false);
  if (options.dryRun) {
    const dryLines = [...hookPlanLines(hooks.value, options.yes), { level: 'text' as const, text: 'Dry run: no file was changed.' }];
    return done(dryLines, null, false, [], hooks.value.map((change) => change.file));
  }
  if (!stateChanges) {
    // Only the hook settings change: the run makes no backup and no commit.
    const applied = await applyHookSettings(deps, hooks.value, options.yes);
    return applied.ok ? done(applied.value.lines, null, false, [], applied.value.changed) : applied;
  }

  const replacements = files.replaces.filter((replace) => replace.action === 'replace');
  const touchesState = state.value.kind === 'migrate' || changes.length > 0 || stateGitignore.value.text !== null;
  if (touchesState) {
    // These are the files that the upgrade can change in the repo: the commit holds those and no other file.
    const touched = inStateRepo(layout, [
      ...files.moves.flatMap((move) => [move.fromPath, move.toPath]),
      ...replacements.map((replace) => replace.filePath),
      ...(stateGitignore.value.text === null ? [] : [stateGitignore.value.filePath]),
      ...(stateText.value === null ? [] : [layout.nodeJson]),
      ...changes.map((change) => fileOfTarget(layout, change.template.target)),
    ]);
    const ready = await requireStateRepoCommit(deps, layout.stateDir, touched, 'the upgrade', commands.upgrade);
    if (!ready.ok) return ready;
  }

  // The paths are checked once more before the first write, because a path can change while the command plans.
  const stillPlain = await requireNoRootLinks(deps, layout);
  if (!stillPlain.ok) return stillPlain;
  const backupDir = await backup(deps, home);
  if (!backupDir.ok) return backupDir;
  const backupPath = relative(home, backupDir.value);
  // The old text of a block that this run replaces is kept before the first write. A stop here changed no file.
  const savedBlocks = await backupBlocks(deps, home, changes);
  if (!savedBlocks.ok) return savedBlocks;

  const written: Written[] = [];
  const moved: Moved[] = [];
  let commit: CommitAttempt | null = null;
  // The root repo that this run made, which a later failure removes.
  let rootMade: MadeRootRepo | null = null;
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
    const repoGone = rootMade === null ? ok(undefined) : await deps.fs.remove(join(home, GIT_ENTRY));
    const problems = await restore(deps, home, written, moved);
    const unstaged = attempt === null ? ok(undefined) : await unstagePaths(deps, layout.stateDir, attempt.paths);
    const notes: string[] = [];
    if (!repoGone.ok) {
      notes.push(`${repoGone.error.message}. Remove ${GIT_ENTRY} in ${home} by hand.`);
    }
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
    ...(stateGitignore.value.text === null ? [] : [{ path: stateGitignore.value.filePath, text: stateGitignore.value.text }]),
    ...(root.value.gitignore.text === null ? [] : [{ path: root.value.gitignore.filePath, text: root.value.gitignore.text }]),
    // The local file comes before the shared file, which is the last to change. A run that stops between the two leaves
    // the old shared file with all its keys.
    ...(localText.value === null
      ? []
      : [{ path: layout.localConfigFile, text: localText.value, mode: localFileModes.private }]),
    ...(configText.value === null ? [] : [{ path: layout.configFile, text: configText.value }]),
  ];
  const wrote = await writeAll(deps, home, newFiles, written, commands.upgrade);
  if (!wrote.ok) return abort(wrote.error.message);

  // The root repo comes after the files that its first commit holds, and before the commit of the state repo.
  if (root.value.repo) {
    const madeRepo = await makeRootRepo(deps, home);
    if (!madeRepo.ok) return abort(madeRepo.error.message);
    rootMade = madeRepo.value;
  }

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
  const pruned = [...(await pruneBackups(deps, home, backupDir.value)), ...(await pruneBlockBackups(deps, home))];
  const indexed = await indexUpgraded(deps, home, origin, registry);
  // The hook settings come last: the state is upgraded and registered by now, and a stop here names what is left to do.
  const hookApplied = await applyHookSettings(deps, hooks.value, options.yes);
  if (!hookApplied.ok) return hookApplied;
  return done(
    [
      ...savedBlocks.value.map((saved): OutLine => ({
        level: 'ok',
        text: `Kept the old text of block ${saved.block} in ${saved.path}.`,
      })),
      ...(rootMade === null ? [] : [rootRepoLine(rootMade)]),
      { level: 'ok', text: `Changed ${count} ${count === 1 ? 'file' : 'files'}. The backup is in ${backupPath}.` },
      ...(pruned.length === 0
        ? []
        : [{ level: 'warn' as const, text: `Old ${dirs.backups} could not be removed: ${pruned.join('; ')}.` }]),
      ...indexed,
      ...hookApplied.value.lines,
    ],
    backupPath,
    stateChanged,
    savedBlocks.value,
    hookApplied.value.changed,
  );
};
