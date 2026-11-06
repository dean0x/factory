import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { glossary, recipeGlossary } from '../../src/glossary.js';
import { schemaIds, terms } from '../../src/names.js';
import { softwareGlossary } from '../../src/recipes/software/words.js';
import { softwareRecipe } from '../helpers/blocks.js';
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

  it('TP-41: says in the entry for an assignment that a worker gets it as a file in its assignment folder', () => {
    const text = glossary.find((word) => word.term === 'assignment')?.text ?? '';
    expect(text).toContain('A worker gets it as a file in its assignment folder.');
  });

  it.each(['worker', 'session reset'])('TP-41: does not call the built word "%s" unbuilt', (term) => {
    const text = glossary.find((word) => word.term === term)?.text ?? '';
    expect(text.length, term).toBeGreaterThan(0);
    expect(text, term).not.toContain('Not built yet');
  });

  it.each(['worker', 'assignment', 'session reset'])('TP-41: holds the same text as docs/glossary.md for "%s"', (term) => {
    const program = glossary.find((word) => word.term === term)?.text;
    const entry = partEntries(CORE_HEADING).find((candidate) => candidate.term === term);
    expect(entry, term).toBeDefined();
    expect(entry?.text).toBe(program);
  });

  it('TP-41: has no entry for the doorbell, and the inbox is the assignment folder of a worker', () => {
    const entries = partEntries(CORE_HEADING);
    expect(entries.find((entry) => entry.term === 'doorbell')).toBeUndefined();
    expect(entries.find((entry) => entry.term === 'inbox')?.text).toContain('assignment folder of a worker');
  });

  it('uses the word worker once in the sentence for a worker', () => {
    const text = glossary.find((word) => word.term === 'worker')?.text ?? '';
    expect(text.match(/\bworker\b/gi) ?? []).toHaveLength(1);
  });

  it('names no software word in the sentences for a queue and a check', () => {
    for (const term of ['queue', 'check']) {
      const text = glossary.find((word) => word.term === term)?.text ?? '';
      expect(text.length, term).toBeGreaterThan(0);
      expect(text, term).not.toMatch(/\b(?:merge|merged|pull request|release|git|CI)\b/i);
    }
  });

  it('has no placeholder left in any text', () => {
    for (const word of glossary) expect(word.text).not.toMatch(/\{\{|\}\}/);
  });
});

describe('the glossary of the software recipe', () => {
  const recipeWords = recipeGlossary(softwareRecipe);

  it('has one entry for each word of the recipe, in the order of the second part of docs/glossary.md', () => {
    expect(recipeWords.map((word) => word.term)).toEqual(partEntries(RECIPE_HEADING).map((entry) => entry.term));
    expect(recipeWords.map((word) => word.term)).toEqual(softwareGlossary.map((entry) => entry.term));
  });

  it('holds the same text in the recipe and in the second part of docs/glossary.md for each word', () => {
    expect(recipeWords.map((word) => word.text)).toEqual(partEntries(RECIPE_HEADING).map((entry) => entry.text));
  });

  it('has at most 25 words in each text, and no placeholder left', () => {
    for (const word of recipeWords) {
      expect(wordCount(word.text), word.term).toBeGreaterThan(0);
      expect(wordCount(word.text), word.term).toBeLessThanOrEqual(MAX_WORDS);
      expect(word.text, word.term).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('has no word of the recipe in the list of terms of every factory', () => {
    const recipeTerms = recipeWords.map((word) => word.term);
    expect(terms.filter((term) => recipeTerms.includes(term))).toEqual([]);
  });
});

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

  it.each([...terms])('has exactly one entry for the term "%s" of the program', (term) => {
    expect(docEntries().filter((entry) => entry.term === term)).toHaveLength(1);
  });

  it.each([...terms])('holds the same text in the program and in docs/glossary.md for "%s"', (term) => {
    const word = glossary.find((candidate) => candidate.term === term);
    const entry = docEntries().find((candidate) => candidate.term === term);
    expect(word?.text).toBeDefined();
    expect(word?.text).toBe(entry?.text);
  });

  it('has the entry of a term in the first part, in the order of the term list', () => {
    const core = partEntries(CORE_HEADING).map((entry) => entry.term);
    expect(core.filter((term) => (terms as readonly string[]).includes(term))).toEqual([...terms]);
  });

  it('has no entry of the second part in the first part', () => {
    const core = partEntries(CORE_HEADING).map((entry) => entry.term);
    const recipe = partEntries(RECIPE_HEADING).map((entry) => entry.term);
    expect(recipe.filter((term) => core.includes(term))).toEqual([]);
  });

  it('does not define an old word as the word of an entry, and the program has none as a term', () => {
    const old = docEntries().flatMap((entry) => (entry.was === undefined ? [] : [entry.was]));
    expect(old.length).toBeGreaterThan(0);
    expect(docEntries().filter((entry) => old.includes(entry.term)).map((entry) => entry.term)).toEqual([]);
    expect(terms.filter((term) => old.includes(term))).toEqual([]);
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

  it('does not call the software recipe unbuilt, and names the config key of the setup', () => {
    const texts = new Map(glossary.map((word) => [word.term, word.text]));
    expect(texts.get('recipe')).not.toContain('Not built yet');
    expect(texts.get('setup')).toContain('`recipe.variant`');
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
  const lineOf = (word: { readonly term: string; readonly text: string }): string => `${word.term}: ${word.text}`;

  it('prints the heading, one line for each term, then the part of the recipe, and exits 0', async () => {
    const result = await run(['help', 'words']);
    expect(result.code).toBe(0);
    const lines = result.out.trimEnd().split('\n');
    expect(lines[0]).toBe('factory words');
    expect(lines.slice(1, terms.length + 1)).toEqual(glossary.map(lineOf));
    expect(lines.slice(terms.length + 1)).toEqual(['software recipe', ...recipeGlossary(softwareRecipe).map(lineOf)]);
  });

  it('prints no software word in the part of every factory', async () => {
    const lines = (await run(['help', 'words'])).out.trimEnd().split('\n');
    expect(lines.slice(0, terms.length + 1).filter((line) => /\b(?:merge|release|pull request)/i.test(line))).toEqual([]);
  });

  it('prints no word of the deny list', async () => {
    expect(denyMatches((await run(['help', 'words'])).out)).toEqual([]);
  });

  it('prints one JSON document with the term and the text of each word for --json', async () => {
    const result = await run(['help', 'words', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      schema: schemaIds.words,
      words: glossary,
      recipes: [{ recipe: 'software', words: recipeGlossary(softwareRecipe) }],
    });
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
