import type { Deps } from '../core/deps.js';
import { layoutOf, type Layout } from '../state/layout.js';
import type { BlockTemplate, BlockTarget } from '../templates/index.js';
import { parseBlocks, verifyBlock, type ParsedBlock } from './managed.js';

/** What one managed block looks like in its file. */
export type BlockStatus =
  | {
      readonly kind: 'intact' | 'edited';
      readonly template: BlockTemplate;
      readonly file: string;
      readonly block: ParsedBlock;
    }
  | { readonly kind: 'missing'; readonly template: BlockTemplate; readonly file: string }
  | { readonly kind: 'malformed'; readonly template: BlockTemplate; readonly file: string; readonly message: string };

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

/** The status of each template block in the files of the node. Each file is read once. */
export const inspectBlocks = async (
  deps: Deps,
  home: string,
  templates: readonly BlockTemplate[],
): Promise<readonly BlockStatus[]> => {
  const layout = layoutOf(home);
  const states = new Map<BlockTarget, FileState>();
  for (const template of templates) {
    if (!states.has(template.target)) {
      states.set(template.target, await readBlocks(deps, fileOfTarget(layout, template.target)));
    }
  }

  return templates.map((template): BlockStatus => {
    const file = fileOfTarget(layout, template.target);
    const state = states.get(template.target) ?? { kind: 'absent' };
    if (state.kind === 'broken') return { kind: 'malformed', template, file, message: state.message };
    if (state.kind === 'absent') return { kind: 'missing', template, file };
    const found = state.blocks.filter((block) => block.name === template.name);
    const [block] = found;
    if (block === undefined) return { kind: 'missing', template, file };
    if (found.length > 1) return { kind: 'malformed', template, file, message: `block ${template.name} appears twice` };
    return { kind: verifyBlock(block), template, file, block };
  });
};
