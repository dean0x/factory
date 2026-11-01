import type { BlockStatus } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { inspectFile, refuse } from '../migrate/inspect.js';
import { planMigrations, type Migration } from '../migrate/runner.js';
import { flags, flagText, program } from '../names.js';
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
      return { template, status, action: from < template.version ? 'update' : 'current', from };
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

export const refusalOf = (blocks: readonly BlockPlan[]): CliResult<void> => {
  const other = blocks.filter((plan) => plan.action === 'refuse-other');
  if (other.length > 0) return failure(other.map((plan) => plan.reason ?? plan.template.name).join('\n'));

  const edited = blocks.filter((plan) => plan.action === 'refuse-edited');
  if (edited.length === 0) return ok(undefined);
  const lines = edited.flatMap((plan) => [
    `block ${plan.template.name} was edited. ${program} did not change it.`,
    ...(plan.status.kind === 'edited' ? shortDiff(plan.status.block.body, plan.template.body) : []),
  ]);
  return safetyRefusal(
    lines.join('\n'),
    `Use ${flagText(flags.overwrite)} ${edited.map((plan) => plan.template.name).join(' ')} to replace the text with the template. ` +
      `Make a copy of your edits first.`,
  );
};

export const planLines = (config: FilePlan, state: FilePlan, blocks: readonly BlockPlan[], upgrade: UpgradeSpec): OutLine[] => {
  const fileLine = (plan: FilePlan, file: UpgradeFile): OutLine =>
    plan.kind === 'current'
      ? { level: 'ok', text: `${file.spec.file}: ${file.spec.key} ${plan.version} is current` }
      : {
          level: 'text',
          text: `${file.spec.file}: ${file.spec.key} ${plan.from} to ${plan.to} (${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'})`,
        };
  const blockLine = (plan: BlockPlan): OutLine => {
    const { name, version } = plan.template;
    switch (plan.action) {
      case 'current':
        return { level: 'ok', text: `block ${name}: version ${version} is current` };
      case 'update':
        return { level: 'text', text: `block ${name}: version ${plan.from} to ${version}` };
      case 'replace':
        return { level: 'text', text: `block ${name}: replace the edited text with version ${version}` };
      case 'add':
        return { level: 'text', text: `block ${name}: add version ${version}` };
      case 'skip-missing':
        return {
          level: 'warn',
          text: `block ${name} is missing. Use ${flagText(flags.overwrite)} ${name} to add it.`,
        };
      case 'refuse-edited':
        return { level: 'fail', text: `block ${name} was edited` };
      case 'refuse-other':
        return { level: 'fail', text: plan.reason ?? `block ${name} cannot change` };
      default: {
        const unreachable: never = plan.action;
        return unreachable;
      }
    }
  };
  return [fileLine(config, upgrade.config), fileLine(state, upgrade.state), ...blocks.map(blockLine)];
};
