import { createHash } from 'node:crypto';
import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { marker } from '../names.js';
import { BLOCK_NAME_PATTERN } from '../state/schema.js';

export interface BlockSpec {
  readonly name: string;
  readonly version: number;
  readonly body: string;
}

export interface ParsedBlock extends BlockSpec {
  /** The hash that the begin marker holds. */
  readonly sha: string;
  /** Offset of the begin marker in the text. */
  readonly start: number;
  /** Offset after the end marker. */
  readonly end: number;
}

export type BlockIntegrity = 'intact' | 'edited';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MARKER_PREFIX = `<!-- ${marker.prefix}`;
const BEGIN_PATTERN = new RegExp(
  `^${escapeRegex(MARKER_PREFIX)}${marker.begin} ([a-z][a-z0-9-]{0,31}) v([1-9][0-9]{0,5}) ${marker.hash}=([0-9a-f]{64}) -->\\r?$`,
);
const END_PATTERN = new RegExp(`^${escapeRegex(MARKER_PREFIX)}${marker.end} ([a-z][a-z0-9-]{0,31}) -->\\r?$`);

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** True when the text holds the start of a managed-block marker. A body with one would break the parse of its block. */
export const holdsBlockMarker = (text: string): boolean => text.includes(MARKER_PREFIX);

export const renderBlock = ({ name, version, body }: BlockSpec): CliResult<string> => {
  if (!BLOCK_NAME_PATTERN.test(name)) return failure(`"${name}" is not a block name`);
  if (!Number.isInteger(version) || version < 1) return failure(`block ${name} needs a version of 1 or more`);
  if (holdsBlockMarker(body)) return failure(`the body of block ${name} holds a managed-block marker`);
  return ok(
    `${MARKER_PREFIX}${marker.begin} ${name} v${version} ${marker.hash}=${sha256Hex(body)} -->\n${body}\n${MARKER_PREFIX}${marker.end} ${name} -->`,
  );
};

interface OpenBlock {
  readonly name: string;
  readonly version: number;
  readonly sha: string;
  readonly start: number;
  readonly firstBodyLine: number;
}

/** The body joins its lines with LF. A CRLF line end in the text gives the same body as an LF line end. */
export const parseBlocks = (text: string): CliResult<readonly ParsedBlock[]> => {
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  let open: OpenBlock | null = null;
  let offset = 0;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const begin = BEGIN_PATTERN.exec(line);
    const end = END_PATTERN.exec(line);
    if (begin !== null) {
      if (open !== null) return failure(`line ${lineNumber}: a block begins inside block ${open.name}`);
      open = {
        name: begin[1] ?? '',
        version: Number(begin[2]),
        sha: begin[3] ?? '',
        start: offset,
        firstBodyLine: index + 1,
      };
    } else if (end !== null) {
      if (open === null) return failure(`line ${lineNumber}: a block end has no begin`);
      if (end[1] !== open.name) {
        return failure(`line ${lineNumber}: the end of block ${end[1]} does not match block ${open.name}`);
      }
      blocks.push({
        name: open.name,
        version: open.version,
        sha: open.sha,
        body: lines
          .slice(open.firstBodyLine, index)
          .map((bodyLine) => bodyLine.replace(/\r$/, ''))
          .join('\n'),
        start: open.start,
        end: offset + line.length,
      });
      open = null;
    } else if (line.startsWith(MARKER_PREFIX)) {
      return failure(`line ${lineNumber}: a managed-block marker is malformed`);
    }
    offset += line.length + 1;
  }

  return open === null ? ok(blocks) : failure(`block ${open.name} is not closed`);
};

export const verifyBlock = (block: ParsedBlock): BlockIntegrity =>
  sha256Hex(block.body) === block.sha ? 'intact' : 'edited';

export const replaceBlock = (text: string, block: ParsedBlock, rendered: string): string =>
  `${text.slice(0, block.start)}${rendered}${text.slice(block.end)}`;

/**
 * The lines of the text that no block holds: the text of the person. Each line is trimmed, and a blank line is left out.
 * `blocks` are the blocks that `parseBlocks` found in the same text.
 */
export const linesOutsideBlocks = (text: string, blocks: readonly ParsedBlock[]): readonly string[] => {
  const outside = [...blocks]
    .sort((left, right) => right.start - left.start)
    .reduce((current, block) => `${current.slice(0, block.start)}\n${current.slice(block.end)}`, text);
  return outside
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
};

/** Add rendered blocks before `block`. The text around them stays as it is, and a blank line keeps them apart. */
export const insertBlocksBefore = (text: string, block: ParsedBlock, rendered: readonly string[]): string => {
  const head = text.slice(0, block.start);
  const breaks = /\n*$/.exec(head)?.[0].length ?? 0;
  const gap = head.trim() === '' ? '' : '\n'.repeat(Math.max(0, 2 - breaks));
  return `${head}${gap}${rendered.join('\n\n')}\n\n${text.slice(block.start)}`;
};

/** Add rendered blocks at the end of the text. The text before them stays as it is. */
export const appendBlocks = (text: string, rendered: readonly string[]): string => {
  const joined = rendered.join('\n\n');
  if (text.trim() === '') return `${joined}\n`;
  const base = text.endsWith('\n') ? text : `${text}\n`;
  return `${base}\n${joined}\n`;
};
