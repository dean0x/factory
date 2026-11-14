import type { Deps } from '../core/deps.js';
import type { BlockRename } from '../migrate/files.js';
import { isRecord } from '../migrate/inspect.js';
import { blockNames, stateKeys } from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
import type { BlockTemplate, BlockTarget } from '../templates/types.js';
import { parseBlocks, verifyBlock, type ParsedBlock } from './managed.js';

/** What one managed block looks like in its file. */
export type BlockStatus =
  | {
      readonly kind: 'intact' | 'edited';
      readonly template: BlockTemplate;
      readonly file: string;
      readonly block: ParsedBlock;
      /** The old name of the block, when the file holds the block under it. */
      readonly renamedFrom?: string;
    }
  | {
      readonly kind: 'missing';
      readonly template: BlockTemplate;
      readonly file: string;
      /** True when the file itself is not there. */
      readonly fileAbsent: boolean;
    }
  | { readonly kind: 'malformed'; readonly template: BlockTemplate; readonly file: string; readonly message: string };

/** What an upgrade is about to change: files that move, and managed blocks that get a new name. */
export interface PendingFiles {
  /** Absolute paths. The file at `fromPath` is about to move to `toPath`. */
  readonly moves: readonly { readonly fromPath: string; readonly toPath: string }[];
  readonly renames: readonly BlockRename[];
}

export const NO_PENDING_FILES: PendingFiles = { moves: [], renames: [] };

/** The old name of a block that the file holds under it, or undefined. */
export const renamedFromOf = (status: BlockStatus): string | undefined =>
  status.kind === 'intact' || status.kind === 'edited' ? status.renamedFrom : undefined;

/**
 * The names of the blocks that the node state records, or null when the state holds no usable map of them. A block counts
 * as recorded when its own name is in the map, or when the map holds a name that the block replaced (`renames`). A caller
 * that gets null counts every block as recorded.
 */
export const recordedBlockNames = (raw: unknown, renames: readonly BlockRename[]): ReadonlySet<string> | null => {
  if (!isRecord(raw)) return null;
  const blocks = raw[stateKeys.blocks];
  if (!isRecord(blocks)) return null;
  const own = Object.keys(blocks);
  return new Set([...own, ...renames.filter((rename) => own.includes(rename.from)).map((rename) => rename.to)]);
};

/** True when the node state records the block, or when it is not known which blocks it records. */
export const isBlockRecorded = (recorded: ReadonlySet<string> | null, name: string): boolean =>
  recorded === null || recorded.has(name);

/**
 * True when a plain `upgrade` adds the block, because the node state never recorded it: the block is missing from a
 * file that is there, so it is new in this version of the package. A setup block has its own rule, which a caller applies
 * first. The safety block is never one: only the owner adds it, with `--overwrite`, outside a session.
 */
export const isAddedAsNewBlock = (status: BlockStatus, recorded: boolean): boolean =>
  status.kind === 'missing' && !status.fileAbsent && !recorded && status.template.name !== blockNames.safety;

/**
 * What the safety block is, against the text that the package renders for the node. Only an equal block needs no action.
 * A block that is intact but different is rendered again. An edited, a missing and a malformed block stop a launch: the
 * safety rules are a security boundary.
 */
export type SafetyState = 'equal' | 'different' | 'edited' | 'missing' | 'malformed';

export const safetyStateOf = (status: BlockStatus): SafetyState => {
  switch (status.kind) {
    case 'intact':
      return status.block.body === status.template.body ? 'equal' : 'different';
    case 'edited':
    case 'missing':
    case 'malformed':
      return status.kind;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

/**
 * The status of one block. A list of one template gives a list of one status; if it did not, the block counts as missing,
 * so a caller that stops on a missing block fails closed.
 */
export const inspectBlock = async (deps: Deps, home: string, template: BlockTemplate): Promise<BlockStatus> => {
  const [status] = await inspectBlocks(deps, home, [template]);
  return status ?? { kind: 'missing', template, file: fileOfTarget(layoutOf(home), template.target), fileAbsent: true };
};

const STOPPING_STATES: readonly SafetyState[] = ['edited', 'missing', 'malformed'];

/** True for the safety block when it is edited, missing or malformed: `start` exits 4 and `doctor` fails. */
export const isSafetyStop = (status: BlockStatus): boolean =>
  status.template.name === blockNames.safety && STOPPING_STATES.includes(safetyStateOf(status));

export const fileOfTarget = (layout: Layout, target: BlockTarget): string =>
  target === 'claudeFile' ? layout.claudeMd : layout.workerMd;

type FileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'parsed'; readonly blocks: readonly ParsedBlock[] }
  | { readonly kind: 'broken'; readonly message: string };

const readBlocks = async (deps: Deps, path: string): Promise<FileState> => {
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return { kind: 'broken', message: kind.error.message };
  if (kind.value !== 'file') return { kind: 'absent' };
  const text = await deps.fs.readText(path);
  if (!text.ok) return { kind: 'broken', message: text.error.message };
  const parsed = parseBlocks(text.value);
  return parsed.ok ? { kind: 'parsed', blocks: parsed.value } : { kind: 'broken', message: parsed.error.message };
};

/**
 * The status of each template block in the files of the node. Each file is read once.
 * With pending files, a file that is about to move is read at its old place, and a block that is about
 * to get a new name is found under its old name.
 */
export const inspectBlocks = async (
  deps: Deps,
  home: string,
  templates: readonly BlockTemplate[],
  pending: PendingFiles = NO_PENDING_FILES,
): Promise<readonly BlockStatus[]> => {
  const layout = layoutOf(home);
  const sourceOf = (path: string): string => pending.moves.find((move) => move.toPath === path)?.fromPath ?? path;
  const states = new Map<BlockTarget, FileState>();
  for (const template of templates) {
    if (!states.has(template.target)) {
      states.set(template.target, await readBlocks(deps, sourceOf(fileOfTarget(layout, template.target))));
    }
  }

  return templates.map((template): BlockStatus => {
    const file = fileOfTarget(layout, template.target);
    const state = states.get(template.target) ?? { kind: 'absent' };
    if (state.kind === 'broken') return { kind: 'malformed', template, file, message: state.message };
    if (state.kind === 'absent') return { kind: 'missing', template, file, fileAbsent: true };
    const oldName = pending.renames.find((rename) => rename.to === template.name)?.from;
    const found = state.blocks.filter((block) => block.name === template.name || block.name === oldName);
    const [block] = found;
    if (block === undefined) return { kind: 'missing', template, file, fileAbsent: false };
    if (found.length > 1) return { kind: 'malformed', template, file, message: `block ${template.name} appears twice` };
    const renamed = block.name === template.name ? {} : { renamedFrom: block.name };
    return { kind: verifyBlock(block), template, file, block, ...renamed };
  });
};
