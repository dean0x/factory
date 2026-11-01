import type { Deps } from '../core/deps.js';
import type { BlockRename } from '../migrate/files.js';
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
  | { readonly kind: 'missing'; readonly template: BlockTemplate; readonly file: string }
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
    if (state.kind === 'absent') return { kind: 'missing', template, file };
    const oldName = pending.renames.find((rename) => rename.to === template.name)?.from;
    const found = state.blocks.filter((block) => block.name === template.name || block.name === oldName);
    const [block] = found;
    if (block === undefined) return { kind: 'missing', template, file };
    if (found.length > 1) return { kind: 'malformed', template, file, message: `block ${template.name} appears twice` };
    const renamed = block.name === template.name ? {} : { renamedFrom: block.name };
    return { kind: verifyBlock(block), template, file, block, ...renamed };
  });
};
