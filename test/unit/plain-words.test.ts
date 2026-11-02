import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LINES,
  JARGON_PATTERNS,
  OLD_WORD_LIST,
  PLAIN_WORDS,
  SCANNED_DOCS,
  TABLE_HEADER,
  scanDoc,
  type DocHit,
} from '../helpers/plain-words.js';

const DOCS = join(__dirname, '..', '..', 'docs');
const readDoc = (name: string): string => readFileSync(join(DOCS, name), 'utf8');

/** The rows of the plain-words table in a doc, as four cells each. */
const tableRows = (text: string): string[][] => {
  const lines = text.split('\n');
  const start = lines.indexOf(TABLE_HEADER);
  if (start < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, line.length - 1).split('|').map((cell) => cell.trim()));
  }
  return rows;
};

const describeHits = (hits: readonly DocHit[]): string[] =>
  hits.slice(0, 40).map((hit) => `${hit.file}:${hit.line} ${hit.kind} "${hit.word}"`);

describe('the plain-words table', () => {
  it('has the same rows in docs/glossary.md and in the helper, in the same order', () => {
    expect(tableRows(readDoc('glossary.md'))).toEqual(
      PLAIN_WORDS.map((row) => [row.term, row.plain, row.scan, row.note]),
    );
  });

  it('gives each row a term, a plain word and a scan mark', () => {
    for (const row of PLAIN_WORDS) {
      expect(row.term, 'a row has no term').not.toBe('');
      expect(row.plain, `the row "${row.term}" has no plain word`).not.toBe('');
      expect(['scanned', 'by hand', '-']).toContain(row.scan);
    }
  });

  it('has no term twice', () => {
    const terms = PLAIN_WORDS.map((row) => row.term);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('marks as scanned each row that has a docs pattern, and as by hand each word with a common meaning', () => {
    const scanned = new Set(PLAIN_WORDS.filter((row) => row.scan === 'scanned').map((row) => row.term));
    for (const { term } of JARGON_PATTERNS) expect(scanned.has(term), `"${term}" is not a scanned row`).toBe(true);
    const byHand = PLAIN_WORDS.filter((row) => row.scan === 'by hand').map((row) => row.term);
    expect(byHand).toEqual(
      expect.arrayContaining(['variant', 'home, root (of a factory)', 'tracker', 'checkouts', 'TTY']),
    );
  });

  it('leaves out of the docs scan only the software recipe word', () => {
    const patterned = new Set(JARGON_PATTERNS.map((entry) => entry.term));
    const left = PLAIN_WORDS.filter((row) => row.scan === 'scanned' && !patterned.has(row.term)).map((row) => row.term);
    expect(left).toEqual(['release scope']);
  });
});

describe('the docs scan: what it finds', () => {
  it('has the eight old words', () => {
    expect([...OLD_WORD_LIST]).toEqual(['lane', 'pack', 'brief', 'cell', 'andon', 'staging', 'inspect', 'ship']);
  });

  it.each(OLD_WORD_LIST)('finds the old word "%s", also in a capital letter, a plural and a past form', (word) => {
    const forms = [word, `${word[0]?.toUpperCase()}${word.slice(1)}`, `${word}s`, `${word}ed`];
    for (const form of forms) {
      const hits = scanDoc('design.md', `A line with ${form} in it.\n`);
      expect(hits.length, `the form "${form}" is not found`).toBeGreaterThan(0);
      expect(hits[0]?.kind).toBe('old word');
    }
  });

  it.each(['shipping', 'shipped', 'packing', 'briefing', 'inspecting'])('finds the -ing and -ped form "%s"', (form) => {
    expect(scanDoc('design.md', `We are ${form} it.\n`)).toHaveLength(1);
  });

  it.each([
    ['changeover', 'A changeover is a clear.'],
    ['work order', 'Send a work order.'],
    ['heartbeat', 'The heartbeat hook runs.'],
    ['bench window', 'The bench window has panes.'],
    ['outbox', 'It writes the outbox.'],
    ['adapter', 'One adapter contract.'],
    ['home index', 'The home index lists it.'],
    ['registered root', 'A registered root counts.'],
    ['state marker', 'The state marker is valid.'],
    ['root rule', 'The root rule stops it.'],
    ['allow list', 'The allow list ignores it.'],
    ['allow list', 'The allow-list file ignores it.'],
    ['owner record', 'The owner record writer.'],
    ['owner channel', 'Through the owner channel.'],
    ['core block', 'The core block is fixed.'],
    ['trust step', 'The trust step asks.'],
    ['permission-skip list', 'The permission-skip list stops it.'],
    ['token-like value', 'A token-like value stops it.'],
  ])('finds the jargon word "%s" in "%s"', (term, text) => {
    const hits = scanDoc('design.md', `${text}\n`);
    expect(hits.map((hit) => hit.kind)).toEqual(['jargon']);
    expect(JARGON_PATTERNS.some((entry) => entry.term === term)).toBe(true);
  });

  it('names the file, the line and the word of a hit', () => {
    const hits = scanDoc('roadmap-v2.md', 'Clean line.\nA cell works.\n');
    expect(hits).toEqual([{ file: 'roadmap-v2.md', line: 2, word: 'cell', kind: 'old word' }]);
  });

  it.each(['The package is built.', 'It is briefly done.', 'The cellar is cold.', 'Unpack it.', 'The relationship holds.', 'A planet.'])(
    'does not find a word that only holds an old word: "%s"',
    (text) => {
      expect(scanDoc('design.md', `${text}\n`)).toEqual([]);
    },
  );
});

describe('the docs scan: what it skips', () => {
  it('skips a code span, also with double backticks', () => {
    expect(scanDoc('design.md', 'Run `factory cell stop` or ``factory ship`` now.\n')).toEqual([]);
  });

  it('finds a word next to a code span', () => {
    expect(scanDoc('design.md', 'The `x` cell and `y`.\n')).toHaveLength(1);
  });

  it('skips a fenced code block and reads the text after it', () => {
    const text = ['Before.', '```', 'factory cell new', 'a lane of work', '```', 'After with a lane.', ''].join('\n');
    expect(scanDoc('design.md', text).map((hit) => hit.line)).toEqual([6]);
  });

  it('skips the table rows of design 7 and 7.1, and reads the text around them', () => {
    const text = [
      '## 7. Generic names',
      'A lane before the table.',
      '| Today | In factory |',
      '| lane | worker |',
      '### 7.1 Shop-floor words',
      '| 5 | staging areas | Used as staging |',
      '## 8. Migration',
      '| lane | still a hit after section 7 |',
      '',
    ].join('\n');
    expect(scanDoc('design.md', text).map((hit) => hit.line)).toEqual([2, 8]);
  });

  it('reads a table of section 7 in another doc', () => {
    expect(scanDoc('roadmap-v2.md', '## 7. Generic names\n| lane | worker |\n')).toHaveLength(1);
  });

  it('skips the rows of the plain-words table and reads the text after the table', () => {
    const text = [TABLE_HEADER, '|---|---|---|---|', '| cell | worker | scanned | a cell |', 'A cell after the table.', ''].join(
      '\n',
    );
    expect(scanDoc('glossary.md', text).map((hit) => hit.line)).toEqual([4]);
  });

  it('skips a line of the allow list in its own file only', () => {
    const line = '- **cell**: A cell is a worker session.\n';
    expect(scanDoc('glossary.md', line)).toEqual([]);
    expect(scanDoc('design.md', line).length).toBeGreaterThan(0);
  });
});

describe('the allow list', () => {
  it.each(ALLOWED_LINES.map((entry) => [entry.file, entry.startsWith] as const))(
    'has a reason, one line in its file, and a word on that line: %s %s',
    (file, startsWith) => {
      const entry = ALLOWED_LINES.find((candidate) => candidate.file === file && candidate.startsWith === startsWith);
      expect(entry?.reason.length ?? 0).toBeGreaterThan(20);
      const lines = readDoc(file).split('\n').filter((line) => line.startsWith(startsWith));
      expect(lines, 'the line is not in the doc, or it is there twice').toHaveLength(1);
      expect(scanDoc('other.md', `${lines[0] ?? ''}\n`).length, 'the line holds no old word: remove it from the list').toBeGreaterThan(0);
    },
  );
});

describe('the docs that the docs change reads', () => {
  it.each(SCANNED_DOCS)('%s holds no old word and no scanned jargon word outside code spans and the mapping tables', (name) => {
    expect(describeHits(scanDoc(name, readDoc(name)))).toEqual([]);
  });
});
