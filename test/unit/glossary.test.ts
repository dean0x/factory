import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { glossary } from '../../src/glossary.js';
import { schemaIds, templateValues, terms } from '../../src/names.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { captureSink } from '../helpers/sink.js';

const MAX_WORDS = 25;
const ENTRY = /^- \*\*(.+?)\*\*: (.+)$/;

/** The entries of docs/glossary.md: a line `- **term**: sentence`. */
const docEntries = (): Map<string, string> => {
  const text = readFileSync(join(__dirname, '..', '..', 'docs', 'glossary.md'), 'utf8');
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = ENTRY.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[1], match[2]);
  }
  return entries;
};

const run = async (argv: string[]) => {
  const sink = captureSink();
  const code = await runCli(argv, createFakeDeps(), sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('the glossary', () => {
  it('has one entry for each term, in the order of the term list', () => {
    expect(glossary.map((word) => word.term)).toEqual([...terms]);
  });

  it('has an entry in docs/glossary.md for each term, and no other entry', () => {
    expect([...docEntries().keys()]).toEqual([...terms]);
  });

  it.each([...terms])('holds the same text in the program and in docs/glossary.md for "%s"', (term) => {
    const word = glossary.find((candidate) => candidate.term === term);
    expect(word?.text).toBe(docEntries().get(term));
  });

  it.each([...terms])('has at most 25 words for "%s"', (term) => {
    const text = glossary.find((candidate) => candidate.term === term)?.text ?? '';
    const count = text.split(/\s+/).filter((word) => word !== '').length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(MAX_WORDS);
  });

  it('names the orders folder in the entry for a work order', () => {
    const text = glossary.find((word) => word.term === 'work order')?.text ?? '';
    expect(text).toContain(templateValues.ordersDir);
  });

  it('has no placeholder left in any text', () => {
    for (const word of glossary) expect(word.text).not.toMatch(/\{\{|\}\}/);
  });
});

describe('factory help words', () => {
  it('prints the heading and one line for each term, and exits 0', async () => {
    const result = await run(['help', 'words']);
    expect(result.code).toBe(0);
    const lines = result.out.trimEnd().split('\n');
    expect(lines[0]).toBe('factory words');
    expect(lines.slice(1)).toEqual(glossary.map((word) => `${word.term}: ${word.text}`));
    expect(lines).toHaveLength(terms.length + 1);
  });

  it('prints no word of the deny list', async () => {
    expect(denyMatches((await run(['help', 'words'])).out)).toEqual([]);
  });

  it('prints one JSON document with the term and the text of each word for --json', async () => {
    const result = await run(['help', 'words', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ schema: schemaIds.words, words: glossary });
  });

  it('exits 2 and names the flag for a flag that does not exist', async () => {
    const result = await run(['help', 'words', '--frobnicate']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--frobnicate');
  });

  it('is named in the general help', async () => {
    expect((await run(['help'])).out).toContain('factory help words');
  });
});
