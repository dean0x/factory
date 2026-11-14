import { join } from 'node:path';
import { parseBlocks, sha256Hex } from '../blocks/managed.js';
import { renamedFromOf, type BlockStatus } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { localFileAccess, requireInit } from '../config/load.js';
import { mixConfigValue, SPLIT_SCHEMA_VERSION } from '../config/schema.js';
import { GIT_ENTRY } from '../core/git.js';
import { requireNoLinks } from '../core/root-paths.js';
import { stepsBetween, type FileStep, type RootMove } from '../migrate/files.js';
import { inspectFile, refuse } from '../migrate/inspect.js';
import { planMigrations, runMigrations, type Migration } from '../migrate/runner.js';
import {
  blockNames,
  boardKeys,
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  helpTopics,
  overwriteCommand,
  places,
  program,
  setupBlockNames,
  setupFileOf,
  stateGuard,
} from '../names.js';
import { readBoardFiles } from '../state/board-commit.js';
import { locateShareList } from '../state/files.js';
import { rootGitignoreOf, stateGitignoreOf } from '../state/gitignore.js';
import { guardFolderLabel, guardPlanOf, guardPlanWarnings, type GuardPlan } from '../state/guard.js';
import type { Layout } from '../state/layout.js';
import type { BlockTemplate, SetupTexts } from '../templates/types.js';
import { renameQueueKey } from './board-key.js';
import type { BlockSet, ModesOf, UpgradeFile, UpgradeSpec } from './spec.js';

const MAX_DIFF_LINES = 3;
const MAX_DIFF_WIDTH = 100;

export type FilePlan =
  | { readonly kind: 'current'; readonly version: number; readonly raw: unknown }
  | {
      readonly kind: 'migrate';
      readonly from: number;
      readonly to: number;
      readonly steps: readonly Migration[];
      readonly raw: unknown;
    };

/**
 * What the upgrade does with a block. An edited block of the fixed rules (the safety block) stops the command
 * (`refuse-edited`): an edited one can remove a rule. An edited setup block is put back (`replace`), because the setup
 * file holds its text. Any other edited block is kept, with a warning (`skip-edited`), until a person names it. A block
 * that `replace` writes over has its old text in a backup file. An intact block of the current version whose text differs
 * from the text that the package and the settings render is rendered again (`render`).
 */
export type BlockAction =
  | 'current'
  | 'update'
  | 'render'
  | 'replace'
  | 'add'
  | 'skip-missing'
  | 'skip-edited'
  | 'refuse-edited'
  | 'refuse-other';

export interface BlockPlan {
  readonly template: BlockTemplate;
  readonly status: BlockStatus;
  readonly action: BlockAction;
  /** The version in the file, or null when the block is missing. */
  readonly from: number | null;
  /** Why the block cannot be changed. */
  readonly reason?: string;
}

const CHANGING: readonly BlockAction[] = ['update', 'render', 'replace', 'add'];

export const isChange = (plan: BlockPlan): boolean => CHANGING.includes(plan.action);

export const planFile = async (deps: Deps, path: string, file: UpgradeFile): Promise<CliResult<FilePlan>> => {
  const state = await inspectFile(deps, path, file.parse, file.spec);
  switch (state.kind) {
    case 'valid':
      return ok({ kind: 'current', version: state.version, raw: state.raw });
    case 'older': {
      const steps = planMigrations(state.version, file.spec.supported, file.migrations);
      if (!steps.ok) return failure(`${file.spec.file}: ${steps.error.message}`);
      return ok({ kind: 'migrate', from: state.version, to: file.spec.supported, steps: steps.value, raw: state.raw });
    }
    case 'missing':
    case 'unparsable':
    case 'invalid':
    case 'newer':
    case 'unsafe':
      return refuse(state, file.spec.file);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/**
 * What the upgrade does with the local file. A root from before the split has no local file: the upgrade makes one
 * from the local keys of its config. A root from after the split must have one, and the upgrade never makes it.
 */
export type LocalPlan = FilePlan | { readonly kind: 'create' };

/**
 * Plan the local file. A local file that another account owns, or that others can write, stops the upgrade (exit 4).
 * A missing local file next to a current shared file stops it too (exit 2), and nothing is written.
 */
export const planLocal = async (
  deps: Deps,
  layout: Layout,
  config: FilePlan,
  upgrade: UpgradeSpec,
): Promise<CliResult<LocalPlan>> => {
  const access = await localFileAccess(deps, layout.home);
  if (!access.ok) return access;
  if (config.kind === 'migrate' && config.from < SPLIT_SCHEMA_VERSION) {
    return access.value.kind === 'absent'
      ? ok({ kind: 'create' })
      : failure(
          `${upgrade.local.spec.file} exists already, but ${upgrade.config.spec.file} has ${upgrade.config.spec.key} ${config.from}`,
          `Move ${upgrade.local.spec.file} away, then run "${commandText(commands.upgrade)}" again.`,
        );
  }
  return access.value.kind === 'absent' ? requireInit() : planFile(deps, layout.localConfigFile, upgrade.local);
};

/** The value of a file as it is after the migrations. A failing migration stops the upgrade here. */
export const migratedFile =(plan: FilePlan, file: UpgradeFile): CliResult<unknown> => {
  const migrated = plan.kind === 'migrate' ? runMigrations(plan.raw, plan.steps) : ok(plan.raw);
  return migrated.ok ? migrated : failure(`${file.spec.file}: ${migrated.error.message}`);
};

/** The keys of both files in one value, as they are after the migrations. */
const migratedConfig = (config: FilePlan, local: LocalPlan, upgrade: UpgradeSpec): CliResult<unknown> => {
  const shared = migratedFile(config, upgrade.config);
  if (!shared.ok) return shared;
  // A root of schema 1 migrates as one value that holds the keys of both files.
  if (local.kind === 'create') return shared;
  const localValue = migratedFile(local, upgrade.local);
  return localValue.ok ? ok(mixConfigValue(shared.value, localValue.value)) : localValue;
};

/** The managed blocks of the node, as its config is after the migrations, with the setup texts of the root. */
export const planBlockSet = async (
  config: FilePlan,
  local: LocalPlan,
  upgrade: UpgradeSpec,
  setup: SetupTexts,
  modesOf: ModesOf,
): Promise<CliResult<BlockSet>> => {
  const migrated = migratedConfig(config, local, upgrade);
  if (!migrated.ok) return migrated;
  const set = await upgrade.blocksOf(migrated.value, setup, modesOf);
  return set.ok ? set : failure(`${upgrade.config.spec.file}: ${set.error.message}`);
};

/** A file or a folder that moves. `from` and `to` are paths inside the node home, for the output. */
export interface MovePlan {
  readonly from: string;
  readonly to: string;
  readonly fromPath: string;
  readonly toPath: string;
}

/**
 * A file that gets a new text. `path` is inside the node home, for the output. The file is replaced when it still holds
 * the text that the old version wrote, and kept when anything else is in it.
 */
export interface ReplacePlan {
  readonly path: string;
  readonly filePath: string;
  readonly action: 'replace' | 'keep';
  readonly text: string;
}

export interface FilesPlan {
  readonly moves: readonly MovePlan[];
  readonly replaces: readonly ReplacePlan[];
}

export const NO_FILES_PLAN: FilesPlan = { moves: [], replaces: [] };

/**
 * The moves outside the state folder. A source that is not a file, or that holds no managed block, is skipped: a file
 * of the owner stays where it is. A target that exists stops the upgrade, and nothing changes.
 */
export const planRootMoves = async (
  deps: Deps,
  layout: Layout,
  moves: readonly RootMove[],
): Promise<CliResult<readonly MovePlan[]>> => {
  const planned: MovePlan[] = [];
  for (const move of moves) {
    const fromPath = join(layout.home, move.from);
    const toPath = join(layout.home, move.to);
    // A link is not ours to move: the move would put the link into the coordinator folder.
    const own = await deps.fs.lstat(fromPath);
    if (!own.ok) return own;
    if (own.value === 'link') continue;
    const source = await deps.fs.stat(fromPath);
    if (!source.ok) return source;
    if (source.value !== 'file') continue;
    const text = await deps.fs.readText(fromPath);
    if (!text.ok) return text;
    const blocks = parseBlocks(text.value);
    if (blocks.ok && blocks.value.length === 0) continue;
    const target = await deps.fs.stat(toPath);
    if (!target.ok) return target;
    if (target.value !== null) {
      return failure(
        `cannot move ${move.from} to ${move.to}: the target exists`,
        `Move or remove one of the two files, then run "${commandText(commands.upgrade)}" again.`,
      );
    }
    planned.push({ from: move.from, to: move.to, fromPath, toPath });
  }
  return ok(planned);
};

/**
 * What the run does to the root `.gitignore`: make the file, add the share list at its top, render the part between the
 * marker lines again, or nothing because the part is current.
 */
export type GitignoreAction = 'create' | 'add' | 'render' | 'current';

export interface GitignorePlan {
  readonly action: GitignoreAction;
  readonly filePath: string;
  /** The text to write. It is null when the file holds the current share list. */
  readonly text: string | null;
}

/** The root files that are not part of the state: the `.gitignore` and the git repo of the root. */
export interface RootPlan {
  readonly gitignore: GitignorePlan;
  /** True when the root holds no git entry of any kind: the run makes the root repo. */
  readonly repo: boolean;
}

const gitignoreActionOf = (original: string | null, text: string): GitignoreAction => {
  if (original === null) return 'create';
  if (original === text) return 'current';
  return locateShareList(original).kind === 'found' ? 'render' : 'add';
};

/**
 * The plan for the root `.gitignore` and the root repo. The `.gitignore` keeps every line outside the share list as it is.
 * A marker line with no pair stops the plan, and nothing changes. A root that holds a git entry keeps it: the run makes a
 * repo only where there is none, and it never touches the repo that is there. The plan reads only.
 */
export const planRoot = async (deps: Deps, layout: Layout): Promise<CliResult<RootPlan>> => {
  const current = await rootGitignoreOf(deps, layout, commands.upgrade);
  if (!current.ok) return current;
  const { original, text } = current.value;
  const action = gitignoreActionOf(original, text);
  const entry = await deps.fs.lstat(join(layout.home, GIT_ENTRY));
  if (!entry.ok) return entry;
  return ok({
    gitignore: { action, filePath: layout.gitignoreFile, text: action === 'current' ? null : text },
    repo: entry.value === null,
  });
};

/** What the run does to the `.gitignore` of the state repo: make the file, add the lines that are missing, or nothing. */
export type StateGitignoreAction = 'create' | 'add' | 'current';

export interface StateGitignorePlan {
  readonly action: StateGitignoreAction;
  readonly filePath: string;
  /** The text to write. It is null when the file holds the lines already. */
  readonly text: string | null;
  /** The lines that the run adds to an existing file, in the order of the list. Empty for the other actions. */
  readonly added: readonly string[];
}

const stateGitignoreActionOf = (original: string | null, text: string): StateGitignoreAction => {
  if (original === null) return 'create';
  return original === text ? 'current' : 'add';
};

/**
 * The plan for the `.gitignore` of the state repo. A state repo from before the registry of the workers or before the inbox
 * lacks a line: the plan adds each missing line and keeps every other line as it is. A link at the path stops the plan
 * (exit 4), and a path that is not a file stops it too (exit 1). The plan reads only.
 */
export const planStateGitignore = async (deps: Deps, layout: Layout): Promise<CliResult<StateGitignorePlan>> => {
  const plain = await requireNoLinks(deps, layout.home, [layout.stateGitignoreFile]);
  if (!plain.ok) return plain;
  const current = await stateGitignoreOf(deps, layout, commands.upgrade);
  if (!current.ok) return current;
  const { original, text, added } = current.value;
  const action = stateGitignoreActionOf(original, text);
  return ok({ action, filePath: layout.stateGitignoreFile, text: action === 'current' ? null : text, added });
};

/** What the run does to the queue key of the board file: rename it to the key of the recipe (`rename`), or nothing (`current`). */
export type BoardQueueKeyAction = 'rename' | 'current';

export interface BoardQueueKeyPlan {
  readonly action: BoardQueueKeyAction;
  readonly filePath: string;
  /** The key that the recipe gives for the queue. */
  readonly queueKey: string;
  /** The new text of the board file. It is null when the key is current. */
  readonly text: string | null;
}

/**
 * The plan for the queue key of `board.json`. An old board holds the queue under the default key of the core, and the recipe may give
 * another key: the plan renames it and keeps every other byte (`renameQueueKey`). A board with both keys, and a board that can not be
 * read, stop the plan (exit 1) and name the file. A factory with no board file has nothing to rename. A recipe whose key is the default
 * has nothing to rename either, and the plan then reads no file. The plan reads with no lock: the run reads the file again inside the
 * state lock and builds the text to write from that read.
 */
export const planBoardQueueKey = async (deps: Deps, layout: Layout, queueKey: string): Promise<CliResult<BoardQueueKeyPlan>> => {
  const filePath = join(layout.stateDir, files.board);
  const current: BoardQueueKeyPlan = { action: 'current', filePath, queueKey, text: null };
  if (queueKey === boardKeys.defaultQueue) return ok(current);
  const read = await readBoardFiles(deps, layout, [files.board]);
  if (!read.ok) return read;
  const text = read.value.get(files.board);
  if (text === null || text === undefined) return ok(current);
  const renamed = renameQueueKey(text, queueKey);
  if (!renamed.ok) return renamed;
  return ok(renamed.value === null ? current : { action: 'rename', filePath, queueKey, text: renamed.value });
};

/** What the run does to the delete guard of the state repo: write it again (`install`), nothing (`current`), or only warn (`unsupported`). */
export type StateGuardPlan = GuardPlan;

/**
 * The plan for the delete guard of the state repo: `install` when the state folder is a repo and the guard is off (another setting,
 * other hook bytes, a missing or extra file), else `current`. A guard that the install refuses (a git folder that is not the folder
 * `.git`, a guard folder that is a link, a program path that is not known) is `unsupported`: the run warns with the cause and the
 * step by hand, and goes on. A state folder with no git entry is no repo, so it has no guard to write. The plan reads only. The
 * step is not a change of the saved state: it writes inside the git folder, so it needs no backup and no commit.
 */
export const planStateGuard = (deps: Deps, layout: Layout): Promise<CliResult<StateGuardPlan>> => guardPlanOf(deps, layout.stateDir);

/**
 * The file moves and the new file texts of the steps that take the state to the current version.
 * A source that does not exist is skipped. A target that exists stops the upgrade. A file to replace that does not
 * exist is skipped, and one that a person edited is kept.
 */
export const planFiles = async (
  deps: Deps,
  layout: Layout,
  state: FilePlan,
  steps: readonly FileStep[],
): Promise<CliResult<FilesPlan>> => {
  if (state.kind !== 'migrate') return ok(NO_FILES_PLAN);
  const chosen = stepsBetween(steps, state.from, state.to);
  const moves: MovePlan[] = [];
  for (const move of chosen.flatMap((step) => step.moves)) {
    const from = join(dirs.state, move.from);
    const to = join(dirs.state, move.to);
    const fromPath = join(layout.stateDir, move.from);
    const toPath = join(layout.stateDir, move.to);
    const source = await deps.fs.stat(fromPath);
    if (!source.ok) return source;
    if (source.value === null) continue;
    const target = await deps.fs.stat(toPath);
    if (!target.ok) return target;
    if (target.value !== null) {
      return failure(
        `cannot move ${from} to ${to}: the target exists`,
        `Move or remove ${to}, then run "${commandText(commands.upgrade)}" again.`,
      );
    }
    moves.push({ from, to, fromPath, toPath });
  }
  const replaces: ReplacePlan[] = [];
  for (const replace of chosen.flatMap((step) => step.replaces)) {
    const filePath = join(layout.stateDir, replace.path);
    const kind = await deps.fs.stat(filePath);
    if (!kind.ok) return kind;
    if (kind.value !== 'file') continue;
    const current = await deps.fs.readText(filePath);
    if (!current.ok) return current;
    const action = sha256Hex(current.value) === replace.oldSha256 ? 'replace' : 'keep';
    replaces.push({ path: join(dirs.state, replace.path), filePath, action, text: replace.text });
  }
  return ok({ moves, replaces });
};

/**
 * Plan one block. `recorded` says whether the node state records the block. A caller that does not read the state keeps
 * the default, which counts every block as recorded.
 */
export const planBlock = (status: BlockStatus, overwrite: boolean, recorded = true): BlockPlan => {
  const { template } = status;
  switch (status.kind) {
    case 'malformed':
      return { template, status, action: 'refuse-other', from: null, reason: `${status.file}: ${status.message}` };
    case 'missing': {
      // The setup text is written to be rendered, so a block of it that is not there yet is added to a file that is there.
      // A block that the state never recorded is new in this version of the package, so it is added to a file that is there too.
      // A block that the state records, and that the file lacks, was removed by the owner: only a person who names it adds it.
      const isNew = setupBlockNames.includes(template.name) || !recorded;
      const add = overwrite || (isNew && !status.fileAbsent);
      return { template, status, action: add ? 'add' : 'skip-missing', from: null };
    }
    case 'intact':
    case 'edited': {
      const from = status.block.version;
      const renamed = renamedFromOf(status) !== undefined;
      // The version of a block under its old name has its own numbers, so it says nothing about the new block.
      if (from > template.version && !renamed) {
        return {
          template,
          status,
          action: 'refuse-other',
          from,
          reason: `block ${template.name} has version ${from}, but this ${program} has version ${template.version}. Upgrade ${program}.`,
        };
      }
      if (status.kind === 'edited') {
        // The text of a setup block comes from its setup file, so the setup file is where a person edits it. An edit in
        // the rendered file is put back, and the old text goes to a backup file.
        if (setupBlockNames.includes(template.name)) return { template, status, action: 'replace', from };
        const kept = template.name === blockNames.safety ? 'refuse-edited' : 'skip-edited';
        return { template, status, action: overwrite ? 'replace' : kept, from };
      }
      if (from < template.version || renamed) return { template, status, action: 'update', from };
      // The text depends on the package, on the settings and on the setup text. An intact block of this version that
      // differs from the rendered text is out of date, whatever its marker says.
      return { template, status, action: status.block.body === template.body ? 'current' : 'render', from };
    }
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

/**
 * A setup block goes into a file that is there, or into a file that this run makes. A setup block of a file that is not
 * there stays missing, unless another block is added to that file in the same run.
 */
export const settleSetupBlocks = (plans: readonly BlockPlan[]): readonly BlockPlan[] =>
  plans.map((plan) => {
    const waiting = plan.action === 'skip-missing' && setupBlockNames.includes(plan.template.name);
    const fileComes = plans.some((other) => other.action === 'add' && other.template.target === plan.template.target);
    return waiting && fileComes ? { ...plan, action: 'add' } : plan;
  });

const clip = (line: string): string =>
  line.length > MAX_DIFF_WIDTH ? `${line.slice(0, MAX_DIFF_WIDTH)}...` : line;

/** The first lines that differ between the text in the file and the template. */
const shortDiff = (found: string, wanted: string): string[] => {
  const foundLines = found.split('\n');
  const wantedLines = wanted.split('\n');
  const removed = foundLines.filter((line) => !wantedLines.includes(line)).slice(0, MAX_DIFF_LINES);
  const added = wantedLines.filter((line) => !foundLines.includes(line)).slice(0, MAX_DIFF_LINES);
  return [...removed.map((line) => `    file:     ${clip(line)}`), ...added.map((line) => `    template: ${clip(line)}`)];
};

/** The name that the file holds for the block: the old name, when the block is about to get a new name. */
const labelOf = (plan: BlockPlan): string => renamedFromOf(plan.status) ?? plan.template.name;

export const refusalOf = (blocks: readonly BlockPlan[]): CliResult<void> => {
  const other = blocks.filter((plan) => plan.action === 'refuse-other');
  if (other.length > 0) return failure(other.map((plan) => plan.reason ?? plan.template.name).join('\n'));

  const edited = blocks.filter((plan) => plan.action === 'refuse-edited');
  if (edited.length === 0) return ok(undefined);
  const lines = edited.flatMap((plan) => [
    `block ${labelOf(plan)} was edited. ${program} did not change it.`,
    ...(plan.status.kind === 'edited' ? shortDiff(plan.status.block.body, plan.template.body) : []),
  ]);
  return safetyRefusal(
    lines.join('\n'),
    `Run "${commandText(commands.upgrade)} ${flagText(flags.overwrite)} ${blockNames.safety}" to replace the text with the template. ` +
      `Make a copy of your edits first.`,
  );
};

/** The lines for the root files. A current `.gitignore` and a root that holds a repo already give no line. */
const rootLines = (root: RootPlan): OutLine[] => {
  const ignore = files.gitignore;
  const gitignore: Readonly<Record<GitignoreAction, readonly string[]>> = {
    create: [`${ignore}: new file, with the share list`],
    add: [`${ignore}: add the share list at the top. Your lines stay below it.`],
    render: [`${ignore}: render the share list again. Your lines stay as they are.`],
    current: [],
  };
  const repo = root.repo ? [`make the ${places.folder} a git repo, with a first commit of the shared files`] : [];
  return [...gitignore[root.gitignore.action], ...repo].map((text): OutLine => ({ level: 'text', text }));
};

/** The lines for the `.gitignore` of the state repo: one for each added line. A current file gives no line. */
const stateGitignoreLines = (plan: StateGitignorePlan): OutLine[] => {
  const path = join(dirs.state, files.gitignore);
  const lines: Readonly<Record<StateGitignoreAction, readonly string[]>> = {
    create: [`${path}: new file, with the lines of a new state repo`],
    add: plan.added.map((line) => `${path}: add the line ${line}. Your lines stay as they are.`),
    current: [],
  };
  return lines[plan.action].map((text): OutLine => ({ level: 'text', text }));
};

/** The line for the queue key of the board file. A current key gives no line. */
const boardQueueKeyLines = (plan: BoardQueueKeyPlan): OutLine[] =>
  plan.action === 'rename'
    ? [
        {
          level: 'text',
          text: `${join(dirs.state, files.board)}: rename the queue key "${boardKeys.defaultQueue}" to "${plan.queueKey}". Your other text stays.`,
        },
      ]
    : [];

/** The lines for the delete guard of the state repo. A guard that is on gives no line. A guard that only a person can repair gives a warning. */
const stateGuardLines = (plan: StateGuardPlan): OutLine[] => {
  const warnings = guardPlanWarnings(plan).map((text): OutLine => ({ level: 'warn', text }));
  if (plan.action === 'install') {
    const write = `${guardFolderLabel}: write the delete guard hook and point ${stateGuard.hooksPathKey} at it`;
    return [{ level: 'text', text: write }, ...warnings];
  }
  return warnings;
};

export const planLines = (
  config: FilePlan,
  local: LocalPlan,
  state: FilePlan,
  files: FilesPlan,
  stateGitignore: StateGitignorePlan,
  boardKey: BoardQueueKeyPlan,
  guard: StateGuardPlan,
  root: RootPlan,
  blocks: readonly BlockPlan[],
  upgrade: UpgradeSpec,
): OutLine[] => {
  const fileLine = (plan: LocalPlan, file: UpgradeFile): OutLine => {
    switch (plan.kind) {
      case 'current':
        return { level: 'ok', text: `${file.spec.file}: ${file.spec.key} ${plan.version} is current` };
      case 'create':
        return {
          level: 'text',
          text: `${file.spec.file}: new file, with mode 600, from the local keys of ${upgrade.config.spec.file}`,
        };
      case 'migrate':
        return {
          level: 'text',
          text: `${file.spec.file}: ${file.spec.key} ${plan.from} to ${plan.to} (${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'})`,
        };
      default: {
        const unreachable: never = plan;
        return unreachable;
      }
    }
  };
  const blockLine = (plan: BlockPlan): OutLine => {
    const { name, version } = plan.template;
    const old = renamedFromOf(plan.status);
    switch (plan.action) {
      case 'current':
        return { level: 'ok', text: `block ${name}: version ${version} is current` };
      case 'update':
        return {
          level: 'text',
          text:
            old === undefined
              ? `block ${name}: version ${plan.from} to ${version}`
              : `block ${old}: becomes block ${name}, version ${version}`,
        };
      case 'render':
        return { level: 'text', text: `block ${name}: render the text again, because the package or a setting changed it` };
      case 'replace':
        if (setupBlockNames.includes(name)) {
          return {
            level: 'text',
            text: `block ${name}: put back the text of ${setupFileOf(name)}. The edited text goes to a backup file.`,
          };
        }
        return {
          level: 'text',
          text:
            old === undefined
              ? `block ${name}: replace the edited text with version ${version}`
              : `block ${old}: replace the edited text with block ${name}, version ${version}`,
        };
      case 'add':
        return { level: 'text', text: `block ${name}: add version ${version}` };
      case 'skip-missing':
        return {
          level: 'warn',
          text: `block ${name} is missing. Run "${overwriteCommand(name)}" to add it.`,
        };
      case 'skip-edited':
        return {
          level: 'warn',
          text: `block ${old ?? name} was edited, so ${program} keeps it. Run "${overwriteCommand(old ?? name)}" to replace it.`,
        };
      case 'refuse-edited':
        return { level: 'fail', text: `block ${old ?? name} was edited` };
      case 'refuse-other':
        return { level: 'fail', text: plan.reason ?? `block ${name} cannot change` };
      default: {
        const unreachable: never = plan.action;
        return unreachable;
      }
    }
  };
  const moveLines = files.moves.map((move): OutLine => ({ level: 'text', text: `move ${move.from} to ${move.to}` }));
  const replaceLine = (replace: ReplacePlan): OutLine =>
    replace.action === 'replace'
      ? { level: 'text', text: `replace ${replace.path} with the new text` }
      : {
          level: 'warn',
          text:
            `${replace.path} was edited, so ${program} keeps it. It can hold old names: ` +
            `run "${commandText(commands.help)} ${helpTopics.words}" for the current names.`,
        };
  return [
    fileLine(config, upgrade.config),
    fileLine(local, upgrade.local),
    fileLine(state, upgrade.state),
    ...moveLines,
    ...files.replaces.map(replaceLine),
    ...stateGitignoreLines(stateGitignore),
    ...boardQueueKeyLines(boardKey),
    ...stateGuardLines(guard),
    ...rootLines(root),
    ...blocks.map(blockLine),
  ];
};
