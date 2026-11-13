import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LINES,
  JARGON_PATTERNS,
  OLD_WORD_LIST,
  PLAIN_WORDS,
  SCANNED_CHANGELOG_VERSION,
  SCANNED_DOCS,
  SCANNED_TOP_FILES,
  TABLE_HEADER,
  changelogPartOf,
  scanDoc,
  type DocHit,
} from '../helpers/plain-words.js';
import { OLD_WORD_LIST as SRC_OLD_WORD_LIST } from '../helpers/old-words.js';

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

describe('the glossary and the plain words (TP-110)', () => {
  /** Plain words that are no glossary entry: a phrase for one place, a command name, or the record of another owner. */
  const WITHOUT_ENTRY = new Set([
    'a setting that skips permission prompts',
    'a value that looks like a password or a token',
    'your own factory, received factory',
    'message',
    'doctor, `STUCK:`',
  ]);
  const STAYS = new Set(['stay', 'stays', 'stays in the design text only']);

  const entryNames = new Set(
    readDoc('glossary.md')
      .split('\n')
      .flatMap((line) => {
        const name = /^- \*\*([^*]+)\*\*/.exec(line)?.[1];
        return name === undefined ? [] : [name];
      }),
  );

  /** The glossary words that a row names: its plain word, or its own term when the term stays. */
  const wordsOf = (row: (typeof PLAIN_WORDS)[number]): string[] =>
    row.plain.startsWith('(') ? [] : (STAYS.has(row.plain) ? row.term : row.plain).split(', ');

  const entryFor = (word: string): string => (entryNames.has(word) ? word : word.replace(/ies$/, 'y'));

  it('gives each scanned jargon term a plain word that differs from the term', () => {
    const scanned = PLAIN_WORDS.filter((row) => row.scan === 'scanned');
    expect(scanned.length).toBeGreaterThan(15);
    for (const row of scanned) expect(row.plain.toLowerCase(), row.term).not.toBe(row.term.toLowerCase());
  });

  it('has a glossary entry for each plain word of the table, and for each term that stays', () => {
    const missing = PLAIN_WORDS.filter((row) => !WITHOUT_ENTRY.has(row.term) && !WITHOUT_ENTRY.has(row.plain))
      .flatMap(wordsOf)
      .filter((word) => !entryNames.has(entryFor(word)));
    expect(missing).toEqual([]);
  });

  it('reads the entry names from the glossary, and finds the words that have no entry', () => {
    expect(entryNames.has('worker')).toBe(true);
    expect(entryNames.has('factory folder')).toBe(true);
    expect(entryFor('work copies')).toBe('work copy');
    expect(entryNames.has(entryFor('home index'))).toBe(false);
  });
});

describe('the docs scan: what it finds', () => {
  it('has the eight old words', () => {
    expect([...OLD_WORD_LIST]).toEqual(['lane', 'pack', 'brief', 'cell', 'andon', 'staging', 'inspect', 'ship']);
  });

  it('has the same eight old words as the scan of the source, which the exit check also holds', () => {
    expect([...OLD_WORD_LIST]).toEqual([...SRC_OLD_WORD_LIST]);
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

  it('skips a quoted note of the owner in the trace only, and reads the other rows', () => {
    const first = '| Replace "lane" and "pack" with factory words |';
    const quoted = readDoc('intent-trace.md').split('\n').find((line) => line.startsWith(first)) ?? '';
    expect(quoted).not.toBe('');
    expect(scanDoc('intent-trace.md', `${quoted}\n`)).toEqual([]);
    expect(scanDoc('design.md', `${quoted}\n`).length).toBeGreaterThan(0);
    expect(scanDoc('intent-trace.md', '| A cell stops | §4.11 | FAC-M4 | covered |\n')).toHaveLength(1);
  });

  it.each(ALLOWED_LINES.map((entry) => entry.startsWith))('skips only the quote cell of the allowed trace row %s', (first) => {
    const row = `${first} §4.1 | FAC-M2 | covered |\n`;
    expect(scanDoc('roadmap-v2.md', row).length, 'the quote cell holds no old word').toBeGreaterThan(0);
    expect(scanDoc('intent-trace.md', row)).toEqual([]);
  });

  it.each([
    ['design section', 2],
    ['milestone', 3],
    ['status', 4],
  ] as const)('reads the %s cell of an allowed trace row', (_name, position) => {
    const cells = ['', ' Replace "lane" and "pack" with factory words ', ' §4.1 ', ' FAC-M2 ', ' covered ', ''];
    const row = cells.map((cell, index) => (index === position ? ' A cell works. ' : cell)).join('|');
    expect(scanDoc('intent-trace.md', `${row}\n`)).toEqual([
      { file: 'intent-trace.md', line: 1, word: 'cell', kind: 'old word' },
    ]);
  });

  it('reads a jargon word in the milestone cell of an allowed trace row', () => {
    const row =
      '| "I don\'t like lane, though." and "the thing that you called Andon. I don\'t know that word." | §7 | Design v3 PR: the heartbeat file | covered |\n';
    expect(scanDoc('intent-trace.md', row).map((hit) => hit.kind)).toEqual(['jargon']);
  });

  it('reads the whole line of a glossary entry that has no (was: old word) mark, also after the first bar', () => {
    expect(scanDoc('glossary.md', '- **cell**: A cell | a lane and a heartbeat.\n').map((hit) => hit.word)).toEqual([
      'cell',
      'cell',
      'lane',
      'heartbeat',
    ]);
  });
});

describe('the (was: old word) mark of a glossary entry', () => {
  it.each([...OLD_WORD_LIST, 'work order', 'changeover', 'heartbeat', 'bench window', 'outbox', 'adapter'])(
    'is not a hit right after the bold term of a glossary entry: (was: %s)',
    (word) => {
      expect(scanDoc('glossary.md', `- **new word** (was: ${word}): A plain sentence.\n`)).toEqual([]);
    },
  );

  it('is not a hit with a capital letter or a hyphen in the old word', () => {
    expect(scanDoc('glossary.md', '- **terminal window** (was: TTY): A plain sentence.\n')).toEqual([]);
    expect(scanDoc('glossary.md', '- **new word** (was: Pack-out): A plain sentence.\n')).toEqual([]);
  });

  it('is a hit in every doc except the glossary', () => {
    const line = '- **worker** (was: cell): A plain sentence.\n';
    expect(scanDoc('glossary.md', line)).toEqual([]);
    for (const doc of ['design.md', 'roadmap-v2.md', 'token-budget.md', 'intent-trace.md']) {
      expect(scanDoc(doc, line).map((hit) => hit.word), doc).toEqual(['cell']);
    }
  });

  it('is a hit when it is not right after the bold term', () => {
    expect(scanDoc('glossary.md', '- **worker**: A worker (was: cell) is a session.\n').map((hit) => hit.word)).toEqual([
      'cell',
    ]);
    expect(scanDoc('glossary.md', 'A line that is not an entry (was: cell).\n').map((hit) => hit.word)).toEqual(['cell']);
    expect(scanDoc('glossary.md', '  - **worker** (was: cell): A plain sentence.\n')).toHaveLength(1);
  });

  it('is a hit when the mark holds more than letters, spaces and hyphens', () => {
    const line = '- **worker** (was: cell, then a lane of work.): A plain sentence.\n';
    expect(scanDoc('glossary.md', line).map((hit) => hit.word)).toEqual(['cell', 'lane']);
  });

  it('keeps a hit for an old word elsewhere in the same entry', () => {
    const own = scanDoc('glossary.md', '- **worker** (was: cell): A worker is a cell in one lane.\n');
    expect(own.map((hit) => hit.word)).toEqual(['cell', 'lane']);
    const jargon = scanDoc('glossary.md', '- **event file** (was: outbox): The outbox holds the digest.\n');
    expect(jargon.map((hit) => [hit.kind, hit.word])).toEqual([['jargon', 'outbox']]);
  });

  it('keeps a hit for the old word in the bold term', () => {
    expect(scanDoc('glossary.md', '- **cell** (was: cell): A plain sentence.\n').map((hit) => hit.word)).toEqual(['cell']);
  });

  it('removes only the first mark of a line', () => {
    const line = '- **worker** (was: cell): A plain sentence (was: lane).\n';
    expect(scanDoc('glossary.md', line).map((hit) => hit.word)).toEqual(['lane']);
  });
});

describe('the docs scan: fenced code', () => {
  it('finds a fence that does not close, at the line of the opening fence', () => {
    const text = ['Before.', '```bash', 'factory cell new', 'After.', ''].join('\n');
    expect(scanDoc('design.md', text)).toEqual([{ file: 'design.md', line: 2, word: '```', kind: 'open fence' }]);
  });

  it('finds an open fence after a fence that closes', () => {
    const text = ['```', 'a lane', '```', 'A cell after it.', '```', 'a lane', ''].join('\n');
    expect(scanDoc('design.md', text)).toEqual([
      { file: 'design.md', line: 4, word: 'cell', kind: 'old word' },
      { file: 'design.md', line: 5, word: '```', kind: 'open fence' },
    ]);
  });

  it('gives no open fence when each fence closes', () => {
    const text = ['```', 'a lane', '```', '```bash', 'a cell', '```', ''].join('\n');
    expect(scanDoc('design.md', text)).toEqual([]);
  });

  it('accepts a fence only at the start of a line, as the checks of the docs script do', () => {
    const text = ['- A list item.', '  ```', '  a lane of work', '  ```', ''].join('\n');
    expect(scanDoc('design.md', text).map((hit) => [hit.line, hit.kind])).toEqual([[3, 'old word']]);
  });

  it('gives no open fence for a lone indented fence line', () => {
    expect(scanDoc('design.md', 'Text.\n  ```\nMore text.\n')).toEqual([]);
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
      expect(
        scanDoc('other.md', `${lines[0] ?? ''}\n`).length,
        'the line holds no old word and no jargon word: remove it from the list',
      ).toBeGreaterThan(0);
    },
  );

  it('holds only rows of the trace, and no line of the glossary', () => {
    expect(ALLOWED_LINES.map((entry) => entry.file)).toEqual(Array(ALLOWED_LINES.length).fill('intent-trace.md'));
  });

  it('holds no entry of the glossary: an old word there shows only in the (was: old word) mark', () => {
    const entries = readDoc('glossary.md')
      .split('\n')
      .filter((line) => line.startsWith('- **'));
    expect(entries.length).toBeGreaterThan(0);
    for (const line of entries) expect(scanDoc('glossary.md', `${line}\n`), line).toEqual([]);
  });
});

describe('the docs that the docs change reads', () => {
  it('reads the six docs of the docs change, the intent trace and the quick-start guide included', () => {
    expect([...SCANNED_DOCS]).toEqual([
      'design.md',
      'roadmap-v2.md',
      'token-budget.md',
      'intent-trace.md',
      'glossary.md',
      'quick-start.md',
    ]);
  });

  it.each(SCANNED_DOCS)('%s holds no old word and no scanned jargon word outside code spans and the mapping tables', (name) => {
    expect(describeHits(scanDoc(name, readDoc(name)))).toEqual([]);
  });
});

describe('the CHANGELOG part of one version', () => {
  const text = ['# Changelog', '', '## 0.3.0 (not released)', 'New cell.', '', '## 0.2.0 (not released)', 'A lane.', '', '## 0.1.0', 'A brief.'].join(
    '\n',
  );

  it('keeps the lines of the version and blanks every other line, so a hit keeps its line number', () => {
    const part = changelogPartOf(text, '0.2.0').split('\n');
    expect(part).toHaveLength(text.split('\n').length);
    expect(part.filter((line) => line !== '')).toEqual(['## 0.2.0 (not released)', 'A lane.']);
    expect(part[6]).toBe('A lane.');
  });

  it('reads the last part to the end of the file, and finds nothing for a version that the file does not hold', () => {
    expect(changelogPartOf(text, '0.1.0').split('\n').filter((line) => line !== '')).toEqual(['## 0.1.0', 'A brief.']);
    expect(changelogPartOf(text, '0.9.0')).toBe('');
    expect(changelogPartOf(text, '0.2')).toBe('');
  });

  it('finds an old word in the part of the version and not in the other parts', () => {
    const hits = scanDoc('CHANGELOG.md', changelogPartOf(text, '0.2.0'));
    expect(hits.map((hit) => [hit.line, hit.word])).toEqual([[7, 'lane']]);
    expect(scanDoc('CHANGELOG.md', changelogPartOf(text, '0.1.0')).map((hit) => hit.word)).toEqual(['brief']);
  });
});

describe('the README and the CHANGELOG part (TP-139)', () => {
  const readTop = (name: (typeof SCANNED_TOP_FILES)[number]): string => readFileSync(join(__dirname, '..', '..', name), 'utf8');

  it('reads the README and the CHANGELOG', () => {
    expect([...SCANNED_TOP_FILES]).toEqual(['README.md', 'CHANGELOG.md']);
    expect(SCANNED_CHANGELOG_VERSION).toBe('0.2.0');
  });

  it('finds the part of the version in the CHANGELOG', () => {
    const part = changelogPartOf(readTop('CHANGELOG.md'), SCANNED_CHANGELOG_VERSION);
    expect(part).toContain(`## ${SCANNED_CHANGELOG_VERSION} (not released)`);
    expect(part.split('\n').filter((line) => line !== '').length).toBeGreaterThan(10);
  });

  it('holds no old word and no scanned jargon word in the README, outside code spans and fenced code', () => {
    expect(describeHits(scanDoc('README.md', readTop('README.md')))).toEqual([]);
  });

  it('holds no old word and no scanned jargon word in the part of the CHANGELOG that is not released, outside code spans', () => {
    const part = changelogPartOf(readTop('CHANGELOG.md'), SCANNED_CHANGELOG_VERSION);
    expect(describeHits(scanDoc('CHANGELOG.md', part))).toEqual([]);
  });
});
