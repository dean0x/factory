import { join } from 'node:path';
import { renamedFromOf, type BlockStatus, type PendingFiles } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { stepsBetween, type FileStep } from '../migrate/files.js';
import { inspectFile, refuse } from '../migrate/inspect.js';
import { planMigrations, type Migration } from '../migrate/runner.js';
import { dirs, flags, flagText, program } from '../names.js';
import type { Layout } from '../state/layout.js';
import type { BlockTemplate } from '../templates/index.js';
import type { UpgradeFile, UpgradeSpec } from './spec.js';

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
      return refuse(state, file.spec.file);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/** A file or a folder that moves. `from` and `to` are paths inside the node home, for the output. */
export interface MovePlan {
  readonly from: string;
  readonly to: string;
  readonly fromPath: string;
  readonly toPath: string;
}

export interface FilesPlan extends PendingFiles {
  readonly moves: readonly MovePlan[];
}

export const NO_FILES_PLAN: FilesPlan = { moves: [], renames: [] };

/**
 * The file moves and the block renames of the steps that take the state to the current version.
 * A source that does not exist is skipped. A target that exists stops the upgrade.
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
  return ok({ moves, renames: chosen.flatMap((step) => step.renames) });
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
      if (from > template.version) {
        return {
          template,
          status,
          action: 'refuse-other',
          from,
          reason: `block ${template.name} has version ${from}, but this ${program} has version ${template.version}. Upgrade ${program}.`,
        };
      }
      if (status.kind === 'edited') return { template, status, action: overwrite ? 'replace' : 'refuse-edited', from };
      const renamed = renamedFromOf(status) !== undefined;
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
  state: FilePlan,
  files: FilesPlan,
  blocks: readonly BlockPlan[],
  upgrade: UpgradeSpec,
): OutLine[] => {
  const fileLine = (plan: FilePlan, file: UpgradeFile): OutLine =>
    plan.kind === 'current'
      ? { level: 'ok', text: `${file.spec.file}: ${file.spec.key} ${plan.version} is current` }
      : {
          level: 'text',
          text: `${file.spec.file}: ${file.spec.key} ${plan.from} to ${plan.to} (${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'})`,
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
  return [fileLine(config, upgrade.config), fileLine(state, upgrade.state), ...moveLines, ...blocks.map(blockLine)];
};
