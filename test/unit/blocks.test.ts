import { describe, expect, it } from 'vitest';
import {
  appendBlocks,
  insertBlocksBefore,
  parseBlocks,
  renderBlock,
  replaceBlock,
  sha256Hex,
  verifyBlock,
} from '../../src/blocks/managed.js';
import { inspectBlocks, isAddedAsNewBlock, safetyStateOf, type BlockStatus } from '../../src/blocks/status.js';
import { blockNames } from '../../src/names.js';
import { blockInputOf, safetyTemplateFor } from '../../src/templates/index.js';
import type { BlockTemplate } from '../../src/templates/types.js';
import { noSetupTexts, softwareOwnerModes } from '../helpers/blocks.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';

const rendered = (name: string, version: number, body: string): string => {
  const result = renderBlock({ name, version, body });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('renderBlock', () => {
  it('writes the begin marker with the version and the hash of the body, then the end marker', () => {
    const text = rendered('safety', 2, 'line one\nline two');
    expect(text).toBe(
      `<!-- factory:begin safety v2 sha256=${sha256Hex('line one\nline two')} -->\nline one\nline two\n<!-- factory:end safety -->`,
    );
  });

  it('refuses a body that holds a factory marker', () => {
    const result = renderBlock({ name: 'x', version: 1, body: 'a\n<!-- factory:end x -->' });
    expect(result.ok).toBe(false);
  });

  it('refuses a bad name and a bad version', () => {
    expect(renderBlock({ name: 'Bad Name', version: 1, body: 'x' }).ok).toBe(false);
    expect(renderBlock({ name: 'x', version: 0, body: 'x' }).ok).toBe(false);
    expect(renderBlock({ name: 'x', version: 1.5, body: 'x' }).ok).toBe(false);
  });
});

describe('parseBlocks', () => {
  it('round-trips render and parse, including an empty body', () => {
    const text = `${rendered('a', 1, 'alpha\n\nbeta')}\n\n${rendered('b', 3, '')}\n`;
    const parsed = parseBlocks(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((block) => [block.name, block.version, block.body])).toEqual([
      ['a', 1, 'alpha\n\nbeta'],
      ['b', 3, ''],
    ]);
    expect(parsed.value.every((block) => verifyBlock(block) === 'intact')).toBe(true);
  });

  it('gives the position of each block in the text', () => {
    const first = rendered('a', 1, 'x');
    const text = `owner text\n\n${first}\nafter\n`;
    const parsed = parseBlocks(text);
    expect(parsed.ok && text.slice(parsed.value[0]!.start, parsed.value[0]!.end)).toBe(first);
  });

  it('returns no blocks for text without markers', () => {
    expect(parseBlocks('# Title\n\nSome text.\n')).toEqual({ ok: true, value: [] });
  });

  it('ignores a line that only mentions a marker inside other text', () => {
    expect(parseBlocks('see the line <!-- factory:begin x v1 --> in the docs\n')).toEqual({ ok: true, value: [] });
  });

  it('reads blocks with CRLF line ends as intact', () => {
    const crlf = rendered('a', 1, 'x\ny').replace(/\n/g, '\r\n');
    const parsed = parseBlocks(`owner\r\n${crlf}\r\n`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((block) => [block.name, block.body, verifyBlock(block)])).toEqual([['a', 'x\ny', 'intact']]);
  });

  it.each([
    ['an unterminated block', '<!-- factory:begin a v1 sha256=' + 'a'.repeat(64) + ' -->\nbody\n', 'is not closed'],
    ['an end without a begin', '<!-- factory:end a -->\n', 'has no begin'],
    [
      'a nested begin',
      `${'<!-- factory:begin a v1 sha256=' + 'a'.repeat(64) + ' -->'}\n${'<!-- factory:begin b v1 sha256=' + 'b'.repeat(64) + ' -->'}\n`,
      'inside block',
    ],
    [
      'an end with another name',
      '<!-- factory:begin a v1 sha256=' + 'a'.repeat(64) + ' -->\nx\n<!-- factory:end b -->\n',
      'does not match',
    ],
    ['a garbled begin marker', '<!-- factory:begin a v1 sha256=zz -->\nx\n', 'malformed'],
  ])('returns an error for %s', (_name, text, expected) => {
    const parsed = parseBlocks(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain(expected);
  });
});

describe('verifyBlock', () => {
  it('reports an edit in the body', () => {
    const text = rendered('a', 1, 'keep this').replace('keep this', 'keep that');
    const parsed = parseBlocks(text);
    expect(parsed.ok && verifyBlock(parsed.value[0]!)).toBe('edited');
  });

  it('reports an edit in the body of a block with CRLF line ends', () => {
    const crlf = rendered('a', 1, 'keep this\nand this').replace(/\n/g, '\r\n');
    const parsed = parseBlocks(`owner\r\n${crlf}\r\n`.replace('and this', 'and that'));
    expect(parsed.ok && verifyBlock(parsed.value[0]!)).toBe('edited');
  });

  it('reports a changed hash in the marker', () => {
    const text = rendered('a', 1, 'x').replace(/sha256=[0-9a-f]{64}/, `sha256=${'0'.repeat(64)}`);
    const parsed = parseBlocks(text);
    expect(parsed.ok && verifyBlock(parsed.value[0]!)).toBe('edited');
  });
});

describe('replaceBlock', () => {
  it('replaces one block and keeps the text around it', () => {
    const text = `before\n\n${rendered('a', 1, 'old')}\n\nmiddle\n\n${rendered('b', 1, 'other')}\n\nafter\n`;
    const parsed = parseBlocks(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = replaceBlock(text, parsed.value[0]!, rendered('a', 2, 'new'));
    expect(next).toBe(`before\n\n${rendered('a', 2, 'new')}\n\nmiddle\n\n${rendered('b', 1, 'other')}\n\nafter\n`);
  });
});

describe('replaceBlock in a file with CRLF line ends', () => {
  it('keeps the owner text and leaves a file whose blocks all read as intact', () => {
    const crlf = (text: string): string => text.replace(/\n/g, '\r\n');
    const text = crlf(`before\n\n${rendered('a', 1, 'old\nbody')}\n\nafter\n`);
    const parsed = parseBlocks(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const next = replaceBlock(text, parsed.value[0]!, rendered('a', 2, 'new\nbody'));
    const reread = parseBlocks(next);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.map((block) => [block.name, block.version, block.body, verifyBlock(block)])).toEqual([
      ['a', 2, 'new\nbody', 'intact'],
    ]);
    expect(next.startsWith('before\r\n\r\n')).toBe(true);
    expect(next.endsWith('\r\nafter\r\n')).toBe(true);
  });
});

describe('appendBlocks', () => {
  const [a, b] = [rendered('a', 1, 'x'), rendered('b', 1, 'y')];

  it('writes only the blocks for an empty file', () => {
    expect(appendBlocks('', [a, b])).toBe(`${a}\n\n${b}\n`);
  });

  it('keeps the owner text and adds the blocks at the end', () => {
    expect(appendBlocks('# Mine\n\nMy rules.\n', [a])).toBe(`# Mine\n\nMy rules.\n\n${a}\n`);
  });

  it('adds a newline when the owner text has none at the end', () => {
    expect(appendBlocks('My rules.', [a])).toBe(`My rules.\n\n${a}\n`);
  });
});

describe('insertBlocksBefore', () => {
  const [a, b, setup] = [rendered('a', 1, 'x'), rendered('b', 1, 'y'), rendered('setup', 1, 'z')];

  /** Insert the blocks before the setup block of the text. */
  const insertBeforeSetup = (text: string, blocks: readonly string[]): string => {
    const parsed = parseBlocks(text);
    const target = parsed.ok ? parsed.value.find((block) => block.name === 'setup') : undefined;
    if (target === undefined) throw new Error('the text has no setup block');
    return insertBlocksBefore(text, target, blocks);
  };

  it('puts the blocks first when nothing comes before the block', () => {
    expect(insertBeforeSetup(`${setup}\n`, [a, b])).toBe(`${a}\n\n${b}\n\n${setup}\n`);
  });

  it('adds a blank line after owner text that ends with one line break', () => {
    expect(insertBeforeSetup(`My rules.\n${setup}\n`, [a])).toBe(`My rules.\n\n${a}\n\n${setup}\n`);
  });

  it('keeps the blank line that is already there, and adds no other', () => {
    expect(insertBeforeSetup(`${b}\n\n${setup}\n\nMore of mine.\n`, [a])).toBe(`${b}\n\n${a}\n\n${setup}\n\nMore of mine.\n`);
  });
});

describe('safetyStateOf', () => {
  const HOME = '/w/node';
  const CLAUDE = `${HOME}/coordinator/CLAUDE.md`;
  const config = sampleConfig();
  const safety = safetyTemplateFor(config, softwareOwnerModes);
  const stateWith = async (text: string | null, template = safety) => {
    const deps = createFakeDeps();
    if (text !== null) deps.seed(CLAUDE, text);
    const [status] = await inspectBlocks(deps, HOME, [template]);
    if (status === undefined) throw new Error('no status');
    return safetyStateOf(status);
  };

  it('is built from the config, the modes and the prefix, and does not depend on the setup texts', () => {
    const blocks = blockInputOf(config, noSetupTexts, softwareOwnerModes);
    expect(safety.name).toBe(blockNames.safety);
    expect(safety.target).toBe('claudeFile');
    expect(safety.body).toContain(blocks.ownerPrefix);
  });

  it('is equal for an intact block with the rendered text', async () => {
    expect(await stateWith(`${rendered(safety.name, safety.version, safety.body)}\n`)).toBe('equal');
  });

  it('is different for an intact block whose hash matches another text', async () => {
    expect(await stateWith(`${rendered(safety.name, safety.version, `${safety.body}\nAn extra rule.`)}\n`)).toBe('different');
  });

  it('is different for an intact block after a change of the owner prefix', async () => {
    const other = safetyTemplateFor({ ...config, core: { ...config.core, owner: { ...config.core.owner, prefix: '[From {owner}, other]' } } }, softwareOwnerModes);
    expect(await stateWith(`${rendered(safety.name, safety.version, safety.body)}\n`, other)).toBe('different');
  });

  it('is edited when the text does not match the hash of its marker', async () => {
    const text = rendered(safety.name, safety.version, safety.body).replace('Never skip permissions', 'Skip permissions');
    expect(text).not.toContain('Never skip permissions');
    expect(await stateWith(`${text}\n`)).toBe('edited');
  });

  it('is missing when the file holds no safety block', async () => {
    expect(await stateWith(`${rendered('coordinator', 1, 'Text.')}\n`)).toBe('missing');
  });

  it('is missing when the file is not there', async () => {
    expect(await stateWith(null)).toBe('missing');
  });

  it('is malformed when the markers of the file are broken', async () => {
    expect(await stateWith('<!-- factory:begin safety v2 sha256=zz -->\n')).toBe('malformed');
  });
});

describe('isAddedAsNewBlock', () => {
  const safety = safetyTemplateFor(sampleConfig(), softwareOwnerModes);
  const rules = { ...safety, name: 'work-rules' };
  const FILE = '/w/node/coordinator/CLAUDE.md';
  const missing = (template: BlockTemplate, fileAbsent: boolean): BlockStatus => ({ kind: 'missing', template, file: FILE, fileAbsent });

  it('is true for a missing block that the state never recorded, when its file is there', () => {
    expect(isAddedAsNewBlock(missing(rules, false), false)).toBe(true);
  });

  it('is false for a block that the state records', () => {
    expect(isAddedAsNewBlock(missing(rules, false), true)).toBe(false);
  });

  it('is false when the file of the block is not there', () => {
    expect(isAddedAsNewBlock(missing(rules, true), false)).toBe(false);
  });

  it('is false for the safety block, whether or not the state records it', () => {
    expect(isAddedAsNewBlock(missing(safety, false), false)).toBe(false);
    expect(isAddedAsNewBlock(missing(safety, false), true)).toBe(false);
  });

  it('is false for a block that the file holds', () => {
    const block = parseBlocks(`${rendered('work-rules', 1, 'Text.')}\n`);
    if (!block.ok || block.value[0] === undefined) throw new Error('no block');
    expect(isAddedAsNewBlock({ kind: 'intact', template: rules, file: FILE, block: block.value[0] }, false)).toBe(false);
  });
});
