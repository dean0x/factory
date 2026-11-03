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

/** One entry of docs/glossary.md: `- **term** (was: old word): sentence`. The mark `(was: ...)` is optional. */
interface DocEntry {
  readonly term: string;
  readonly was: string | undefined;
  readonly text: string;
}

const ENTRY = /^- \*\*(.+?)\*\*(?: \(was: (.+?)\))?: (.+)$/;

const CORE_HEADING = '## Words of every factory';
const RECIPE_HEADING = '## Words of the software recipe';
const TABLE_HEADING = '## Plain words';

const glossaryLines = (): string[] =>
  readFileSync(join(__dirname, '..', '..', 'docs', 'glossary.md'), 'utf8').split('\n');

const parseEntry = (line: string): DocEntry | undefined => {
  const match = ENTRY.exec(line);
  if (match?.[1] === undefined || match[3] === undefined) return undefined;
  return { term: match[1], was: match[2], text: match[3] };
};

/** The entries between a heading of docs/glossary.md and the next heading. */
const partEntries = (heading: string): DocEntry[] => {
  const lines = glossaryLines();
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const part = end < 0 ? rest : rest.slice(0, end);
  return part.flatMap((line) => parseEntry(line) ?? []);
};

/** All entries of docs/glossary.md. */
const docEntries = (): DocEntry[] => glossaryLines().flatMap((line) => parseEntry(line) ?? []);

const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word !== '').length;

const run = async (argv: string[]) => {
  const sink = captureSink();
  const code = await runCli(argv, createFakeDeps(), sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('the glossary of the program', () => {
  it('has one entry for each term, in the order of the term list', () => {
    expect(glossary.map((word) => word.term)).toEqual([...terms]);
  });

  it.each([...terms])('has at most 25 words for "%s"', (term) => {
    const text = glossary.find((candidate) => candidate.term === term)?.text ?? '';
    const count = wordCount(text);
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

// TODO(code PR): the code PR renames the terms in `terms` (src/names.ts) and the texts in src/glossary.ts to the
// words of docs/glossary.md. It then restores the test that the program text equals the docs text for each term, and
// the test that the terms of the program are the entries of the docs, in the same order. It then removes the
// `(was: old word)` lookup of the tests below.
describe('docs/glossary.md', () => {
  it('has the part of every factory, the part of the software recipe and the plain-words table, in this order', () => {
    const lines = glossaryLines();
    const positions = [CORE_HEADING, RECIPE_HEADING, TABLE_HEADING].map((heading) => lines.indexOf(heading));
    expect(positions.every((position) => position >= 0), `a heading is missing: ${positions.join(', ')}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('has no entry outside the two parts', () => {
    expect(docEntries()).toEqual([...partEntries(CORE_HEADING), ...partEntries(RECIPE_HEADING)]);
  });

  it('has no entry twice', () => {
    const names = docEntries().map((entry) => entry.term);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it.each([...terms])('has exactly one entry for the term "%s" of the program, by the term or by its (was: term) mark', (term) => {
    const matches = docEntries().filter((entry) => entry.term === term || entry.was === term);
    expect(matches.map((entry) => entry.term)).toHaveLength(1);
  });

  it('does not define an old term of the program as the word of an entry', () => {
    const kept = ['node', 'owner', 'project', 'layer', 'recipe'];
    const old = terms.filter((term) => !kept.includes(term));
    expect(old.length).toBeGreaterThan(0);
    const defined = docEntries().filter((entry) => old.some((term) => term === entry.term));
    expect(defined.map((entry) => entry.term)).toEqual([]);
  });

  it('has at most 25 words in each entry', () => {
    const entries = docEntries();
    expect(entries.length).toBeGreaterThan(0);
    const tooLong = entries
      .filter((entry) => wordCount(entry.text) > MAX_WORDS)
      .map((entry) => `${entry.term}: ${wordCount(entry.text)} words`);
    expect(tooLong).toEqual([]);
  });

  it('teaches the new words of every factory in the first part', () => {
    const core = partEntries(CORE_HEADING).map((entry) => entry.term);
    const words = [
      'node',
      'owner',
      'project',
      'layer',
      'worker',
      'coordinator',
      'recipe',
      'setup',
      'request',
      'assignment',
      'session reset',
      'queue',
      'check',
      'approval point',
      'delegated',
      'board',
      'board connector',
      'factory folder',
      'work copy',
      'factory list',
      'registered factory',
      'factory marker',
      'registration check',
      'share list',
      'received factory',
      'moved factory',
      'setup acceptance',
      'hash',
      'fixed rules',
      'approval record',
      'owner input',
      'security stop',
      'backup file',
      'terminal window',
      'last seen',
      'worker window',
      'event file',
      'proxy',
    ];
    expect(words.filter((word) => !core.includes(word))).toEqual([]);
  });

  it('teaches the words of the software recipe in the second part', () => {
    const recipe = partEntries(RECIPE_HEADING).map((entry) => entry.term);
    const words = ['release check', 'release scope', 'merge check', 'pull request'];
    expect(words.filter((word) => !recipe.includes(word))).toEqual([]);
  });

  it('shows the old word of a new word in the mark (was: old word) after the bold term', () => {
    const marks = new Map(docEntries().map((entry) => [entry.term, entry.was]));
    expect(marks.get('worker')).toBe('cell');
    expect(marks.get('request')).toBe('andon');
    expect(marks.get('assignment')).toBe('work order');
    expect(marks.get('session reset')).toBe('changeover');
    expect(marks.get('queue')).toBe('staging');
    expect(marks.get('check')).toBe('inspect');
    expect(marks.get('release check')).toBe('ship');
    expect(marks.get('setup')).toBe('variant');
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
