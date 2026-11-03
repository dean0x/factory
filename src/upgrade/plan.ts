import { join } from 'node:path';
import { sha256Hex } from '../blocks/managed.js';
import { renamedFromOf, type BlockStatus, type PendingFiles } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { localFileAccess, requireInit } from '../config/load.js';
import { mixConfigValue, SPLIT_SCHEMA_VERSION } from '../config/schema.js';
import { stepsBetween, type FileStep } from '../migrate/files.js';
import { inspectFile, refuse } from '../migrate/inspect.js';
import { planMigrations, runMigrations, type Migration } from '../migrate/runner.js';
import { commands, commandText, dirs, flags, flagText, helpTopics, program } from '../names.js';
import type { Layout } from '../state/layout.js';
import type { BlockTemplate } from '../templates/types.js';
import type { BlockSet, UpgradeFile, UpgradeSpec } from './spec.js';

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

export type BlockAction = 'current' | 'update' | 'replace' | 'add' | 'skip-missing' | 'refuse-edited' | 'refuse-other';

export interface BlockPlan {
  readonly template: BlockTemplate;
  readonly status: BlockStatus;
  readonly action: BlockAction;
  /** The version in the file, or null when the block is missing. */
  readonly from: number | null;
  /** Why the block cannot be changed. */
  readonly reason?: string;
}

const CHANGING: readonly BlockAction[] = ['update', 'replace', 'add'];

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
          `Move ${upgrade.local.spec.file} away, then run the command again.`,
        );
  }
  return access.value.kind === 'absent' ? requireInit() : planFile(deps, layout.localConfigFile, upgrade.local);
};

/** The config as it is after the migrations. A failing migration stops the upgrade here. */
const migratedFile = (plan: FilePlan, file: UpgradeFile): CliResult<unknown> => {
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

/** The managed blocks of the node, as its config is after the migrations. */
export const planBlockSet = (config: FilePlan, local: LocalPlan, upgrade: UpgradeSpec): CliResult<BlockSet> => {
  const migrated = migratedConfig(config, local, upgrade);
  if (!migrated.ok) return migrated;
  const set = upgrade.blocksOf(migrated.value);
  return set.ok ? set : failure(`${upgrade.config.spec.file}: ${set.error.message}`);
};

/** The paths of the projects, as the config holds them after the migrations. */
export const planProjectPaths = (
  config: FilePlan,
  local: LocalPlan,
  upgrade: UpgradeSpec,
): CliResult<readonly string[]> => {
  const migrated = migratedConfig(config, local, upgrade);
  if (!migrated.ok) return migrated;
  const paths = upgrade.projectPathsOf(migrated.value);
  return paths.ok ? paths : failure(`${upgrade.config.spec.file}: ${paths.error.message}`);
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

export interface FilesPlan extends PendingFiles {
  readonly moves: readonly MovePlan[];
  readonly replaces: readonly ReplacePlan[];
}

export const NO_FILES_PLAN: FilesPlan = { moves: [], renames: [], replaces: [] };

/**
 * The file moves, the new file texts and the block renames of the steps that take the state to the current version.
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
      return failure(`cannot move ${from} to ${to}: the target exists`, `Move or remove ${to}, then run the command again.`);
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
  return ok({ moves, renames: chosen.flatMap((step) => step.renames), replaces });
};

export const planBlock = (status: BlockStatus, overwrite: boolean): BlockPlan => {
  const { template } = status;
  switch (status.kind) {
    case 'malformed':
      return { template, status, action: 'refuse-other', from: null, reason: `${status.file}: ${status.message}` };
    case 'missing':
      return { template, status, action: overwrite ? 'add' : 'skip-missing', from: null };
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
      if (status.kind === 'edited') return { template, status, action: overwrite ? 'replace' : 'refuse-edited', from };
      return { template, status, action: from < template.version || renamed ? 'update' : 'current', from };
    }
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

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
    `Use ${flagText(flags.overwrite)} ${edited.map(labelOf).join(' ')} to replace the text with the template. ` +
      `Make a copy of your edits first.`,
  );
};

export const planLines = (
  config: FilePlan,
  local: LocalPlan,
  state: FilePlan,
  files: FilesPlan,
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
      case 'replace':
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
          text: `block ${name} is missing. Use ${flagText(flags.overwrite)} ${name} to add it.`,
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
    ...blocks.map(blockLine),
  ];
};
