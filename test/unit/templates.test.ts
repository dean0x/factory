import { describe, expect, it } from 'vitest';
import { parseBlocks, renderBlock, verifyBlock } from '../../src/blocks/managed.js';
import { blockTemplates, fileTemplates } from '../../src/templates/index.js';
import { denyMatches } from '../helpers/deny-list.js';

const texts: readonly (readonly [string, string])[] = [
  ...blockTemplates.map((template) => [`block ${template.name}`, template.body] as const),
  ...Object.entries(fileTemplates).map(([name, text]) => [`file ${name}`, text] as const),
];

const MAX_WORDS_PER_SENTENCE = 25;

/** The prose sentences of a Markdown text: no code fences, no tables, no headings. */
const sentencesOf = (text: string): string[] => {
  const sentences: string[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('```')) {
      inFence = !inFence;
    } else if (!inFence && !raw.startsWith('|') && !raw.startsWith('#')) {
      const line = raw
        .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
        .replace(/`[^`]*`/g, 'X')
        .replace(/\*\*/g, '');
      sentences.push(...line.split(/[.!?;:]\s+|[.!?;:]$/).filter((part) => part.trim() !== ''));
    }
  }
  return sentences;
};

describe.each(texts)('template %s', (_name, text) => {
  it('holds none of the denied words', () => {
    expect(denyMatches(text)).toEqual([]);
  });

  it('has no contractions', () => {
    expect(text.match(/\b\w+n't\b|\b\w+'(?:ll|re|ve|d|s|m)\b/gi) ?? []).toEqual([]);
  });

  it('has no word in -ing form', () => {
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(prose.match(/\b[a-z]+ing\b/gi) ?? []).toEqual([]);
  });

  it('has short sentences', () => {
    const long = sentencesOf(text).filter((sentence) => sentence.trim().split(/\s+/).length > MAX_WORDS_PER_SENTENCE);
    expect(long).toEqual([]);
  });

  it('has no trailing blank line problems', () => {
    expect(text.includes('\r')).toBe(false);
  });
});

describe('block templates', () => {
  it('has the three blocks with version 1 and the right target', () => {
    expect(blockTemplates.map(({ name, version, target }) => [name, version, target])).toEqual([
      ['coordinator', 1, 'claudeFile'],
      ['safety', 1, 'claudeFile'],
      ['protocol', 1, 'protocolFile'],
    ]);
  });

  it.each([
    ['coordinator', 40, 60],
    ['safety', 12, 25],
    ['protocol', 40, 60],
  ])('keeps the %s block short (%i to %i lines)', (name, min, max) => {
    const template = blockTemplates.find((candidate) => candidate.name === name);
    const lines = template?.body.split('\n').length ?? 0;
    expect(lines).toBeGreaterThanOrEqual(min);
    expect(lines).toBeLessThanOrEqual(max);
  });

  it('renders and parses back as intact blocks', () => {
    for (const template of blockTemplates) {
      const rendered = renderBlock(template);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) return;
      const parsed = parseBlocks(rendered.value);
      expect(parsed.ok && parsed.value.map((block) => [block.name, verifyBlock(block)])).toEqual([
        [template.name, 'intact'],
      ]);
    }
  });

  it('states the safety rules of the design', () => {
    const safety = blockTemplates.find((template) => template.name === 'safety')?.body ?? '';
    expect(safety).toContain('auto permission mode');
    expect(safety).toContain('Never skip permissions');
    expect(safety).toContain('ANTHROPIC_BASE_URL');
    expect(safety).toContain('A merge waits for the go of the owner');
    expect(safety).toContain('A release waits for the go of the owner');
  });
});
