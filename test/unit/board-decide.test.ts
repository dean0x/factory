import { describe, expect, it } from 'vitest';
import {
  BLOCK_MARK,
  checkNote,
  chosenOptionOf,
  decideLogRow,
  recheckRequest,
  requestBlockLines,
  requestStateOf,
  requireLogRoom,
  requireOpen,
  strictRequestOf,
  type DecideRequest,
} from '../../src/board/decide.js';
import { parseDecisionLog, parseWaiting, type DecisionLogDoc, type WaitingDoc } from '../../src/board/files.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { commandLines, commandText, files, maxDisplayWidth, maxFileBytes } from '../../src/names.js';

/** Characters that tools and editors turn into other characters, so they are built from their code points. */
const at = (code: number): string => String.fromCodePoint(code);
const ZERO_WIDTH_SPACE = at(0x200b);
const BIDI_OVERRIDE = at(0x202e);
const TAG_LETTER = at(0xe0041);
const VARIATION_SELECTOR = at(0xfe0f);
const LINE_SEPARATOR = at(0x2028);
const ESCAPE = at(0x1b);

const unwrap = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

type Entry = Record<string, unknown>;

const canonicalOf = (stored: Entry): string => {
  const text = canonicalRequestText(stored);
  if (!text.ok) throw new Error(text.error);
  return text.value;
};

const entry = (changes: Entry = {}): Entry => ({
  id: 'D-3',
  title: 'Which database?',
  question: 'Which database do we use for the queue?',
  options: [
    { key: 'a', text: 'Use SQLite.', rec: true },
    { key: 'b', text: 'Use Postgres.' },
  ],
  ...changes,
});

const waitingOf = (...entries: readonly Entry[]): WaitingDoc =>
  unwrap(parseWaiting(JSON.stringify({ intro: 'Items that wait.', groups: [], items: entries })));

const logOf = (...rows: readonly Entry[]): DecisionLogDoc => unwrap(parseDecisionLog(JSON.stringify({ rows })));

const strictOf = (changes: Entry = {}): DecideRequest => unwrap(strictRequestOf(waitingOf(entry(changes)), 'D-3'));

describe('the strict read of a request (TP-168, TP-196)', () => {
  it('M5-1b TP-168 gives the request, its canonical text and its hash, with the stored strings as they are', () => {
    const padded = entry({ title: '  Which database?  ' });
    const request = unwrap(strictRequestOf(waitingOf(padded), 'D-3'));
    expect(request.id).toBe('D-3');
    expect(request.title).toBe('  Which database?  ');
    expect(request.question).toBe('Which database do we use for the queue?');
    expect(request.options).toEqual([
      { key: 'a', text: 'Use SQLite.', rec: true },
      { key: 'b', text: 'Use Postgres.' },
    ]);
    expect(request.canonical).toBe(canonicalOf(padded));
    expect(request.hash).toBe(requestHashOf(request.canonical));
  });

  it('M5-1b TP-168 hashes the same request to the same value, whatever the order of the keys', () => {
    const reordered = { options: entry().options, question: entry().question, title: entry().title, id: 'D-3' };
    expect(unwrap(strictRequestOf(waitingOf(reordered), 'D-3')).hash).toBe(strictOf().hash);
  });

  it('M5-1b TP-168 accepts one option, nine options and a rec mark of false', () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, text: `Option ${index}` }));
    expect(strictOf({ options: [{ key: 'a', text: 'Only.' }] }).options).toHaveLength(1);
    expect(strictOf({ options: nine }).options).toHaveLength(9);
    expect(strictOf({ options: [{ key: 'a', text: 'One.', rec: false }] }).options).toEqual([{ key: 'a', text: 'One.' }]);
  });

  it('M5-1b TP-168 gives exit 1 for a request that is not in the waiting file', () => {
    const error = errorOf(strictRequestOf(waitingOf(entry()), 'D-9'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
  });

  const LONG = (length: number): string => 'x'.repeat(length);

  const FAULTS: readonly (readonly [string, Entry])[] = [
    ['a key other than the four', entry({ extra: 'EVIL' })],
    ['a key with the name of a proto', JSON.parse('{"id":"D-3","title":"t","question":"q","options":[{"key":"a","text":"x"}],"__proto__":{"a":1}}') as Entry],
    ['an option with another key', entry({ options: [{ key: 'a', text: 'Use SQLite.', extra: 'EVIL' }] })],
    ['no title', { id: 'D-3', question: 'q', options: entry().options }],
    ['a title that is not text', entry({ title: 5 })],
    ['a question that is not text', entry({ question: ['EVIL'] })],
    ['a title with a line break', entry({ title: 'EVIL\nline' })],
    ['a question with a line separator', entry({ question: `EVIL${LINE_SEPARATOR}line` })],
    ['an option text with a tab', entry({ options: [{ key: 'a', text: 'EVIL\tcolumn' }] })],
    ['a title with a mark of text direction', entry({ title: `EVIL${BIDI_OVERRIDE}` })],
    ['an empty title', entry({ title: '' })],
    ['a title of spaces', entry({ title: '   ' })],
    ['a title over its cap', entry({ title: LONG(101) })],
    ['a question over its cap', entry({ question: LONG(501) })],
    ['an option text over its cap', entry({ options: [{ key: 'a', text: LONG(201) }] })],
    ['an option key that is not a token', entry({ options: [{ key: 'a b EVIL', text: 'x' }] })],
    ['an empty option key', entry({ options: [{ key: '', text: 'x' }] })],
    ['an option key that starts with a hyphen', entry({ options: [{ key: '-a', text: 'x' }] })],
    ['an option key that is not text', entry({ options: [{ key: 1, text: 'x' }] })],
    ['a repeated option key', entry({ options: [{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }] })],
    ['no options', entry({ options: [] })],
    ['ten options', entry({ options: Array.from({ length: 10 }, (_, index) => ({ key: `k${index}`, text: 'x' })) })],
    ['options that are not a list', entry({ options: 'EVIL' })],
    ['an option that is not an object', entry({ options: ['EVIL'] })],
    ['an option with no text', entry({ options: [{ key: 'a' }] })],
    ['a rec mark that is not true or false', entry({ options: [{ key: 'a', text: 'x', rec: 'EVIL' }] })],
    ['two rec marks', entry({ options: [{ key: 'a', text: 'x', rec: true }, { key: 'b', text: 'y', rec: true }] })],
    ['an id with a leading zero', entry({ id: 'D-05' })],
  ];

  it.each(FAULTS)('M5-1b TP-168 M5-1b TP-196 refuses %s with exit 1, names the waiting file and repeats no stored text', (_name, stored) => {
    const id = typeof stored['id'] === 'string' ? stored['id'] : 'D-3';
    const error = errorOf(strictRequestOf(waitingOf(stored), id));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).not.toContain('EVIL');
    expect(error.hint ?? '').not.toContain('EVIL');
  });

  it.each(FAULTS)('M5-1b TP-196 gives a second remedy sentence for %s: close the request that is not changed and add a new one', (_name, stored) => {
    const id = typeof stored['id'] === 'string' ? stored['id'] : 'D-3';
    const hint = errorOf(strictRequestOf(waitingOf(stored), id)).hint ?? '';
    expect(hint).toContain(`${commandText(commandLines.requestClose)} ${id}`);
    expect(hint).toContain(commandText(commandLines.requestAdd));
  });
});

describe('a character that the display removes (TP-182)', () => {
  const HIDDEN = [
    ['a zero width space', ZERO_WIDTH_SPACE],
    ['a tag character', TAG_LETTER],
    ['a variation selector', VARIATION_SELECTOR],
    ['an escape', ESCAPE],
    ['a combining grapheme joiner', at(0x34f)],
    ['an unassigned default ignorable code point', at(0x2065)],
    ['a lone surrogate', at(0xd800)],
  ] as const;

  it.each(HIDDEN)('M5-1b TP-182 refuses %s in the title, the question and the text of an option, with exit 1', (_name, hidden) => {
    const changes: readonly Entry[] = [
      { title: `Which${hidden} database?` },
      { question: `Which${hidden} database?` },
      { options: [{ key: 'a', text: `Use${hidden} SQLite.` }] },
    ];
    for (const change of changes) {
      const error = errorOf(strictRequestOf(waitingOf(entry(change)), 'D-3'));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(files.waiting);
    }
  });

  it('M5-1b TP-182 refuses the joiner of an emoji, because the display removes it', () => {
    const error = errorOf(strictRequestOf(waitingOf(entry({ title: `a${at(0x200d)}b` })), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
  });
});

describe('the state of a request (TP-145, TP-167, TP-189)', () => {
  const ROW = { item: 'D-3: Which database?', decision: 'a', date: '2030-01-02' };

  it('M5-1b TP-145 is open for an entry that the log does not name', () => {
    expect(unwrap(requestStateOf(waitingOf(entry()), logOf(), 'D-3'))).toEqual({ kind: 'open' });
  });

  it('M5-1b TP-145 is unknown for a number that neither file holds', () => {
    expect(unwrap(requestStateOf(waitingOf(entry()), logOf(ROW), 'D-9'))).toEqual({ kind: 'unknown' });
  });

  it('M5-1b TP-145 is closed, with the date, for a row that has no by key', () => {
    expect(unwrap(requestStateOf(waitingOf(), logOf(ROW), 'D-3'))).toEqual({ kind: 'closed', date: '2030-01-02' });
  });

  it('M5-1b TP-145 is closed for a row that has a who key and no by key, because it gives no proof', () => {
    const row = { ...ROW, who: 'owner' };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3')).kind).toBe('closed');
  });

  it('M5-1b TP-145 has a null date for a row with no date text', () => {
    const row = { item: 'D-3: t', decision: 'a', date: 5 };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'closed', date: null });
  });

  it('M5-1b TP-189 is answered, a candidate only, for a row that has a by key, and gives the date and the request text of the row and no option', () => {
    const row = { ...ROW, decision: 'zzz-edited', by: 'owner', request: 'the text of the row' };
    const state = unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'));
    expect(state).toEqual({ kind: 'answered', date: '2030-01-02', request: 'the text of the row' });
    expect(JSON.stringify(state)).not.toContain('zzz-edited');
  });

  it('M5-1b TP-145 is answered for a row with a by key of any value, because the owner store decides', () => {
    const row = { ...ROW, by: 'someone else' };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'answered', date: '2030-01-02', request: null });
  });

  it('M5-1b TP-167 exits 1 and names both files for a number that is in the waiting file and in the log', () => {
    const error = errorOf(requestStateOf(waitingOf(entry()), logOf(ROW), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).toContain(files.decisionLog);
  });

  it('M5-1b TP-167 exits 1 for a number that is in both files, also when the row has a by key', () => {
    const row = { ...ROW, by: 'owner' };
    expect(exitCodeOf[errorOf(requestStateOf(waitingOf(entry()), logOf(row), 'D-3')).kind]).toBe(1);
  });
});

describe('the states that stop decide (TP-145, TP-148)', () => {
  it('M5-1b TP-145 lets an open request go on', () => {
    expect(requireOpen({ kind: 'open' }, 'D-3').ok).toBe(true);
  });

  it('M5-1b TP-145 exits 2 for an unknown number', () => {
    const error = errorOf(requireOpen({ kind: 'unknown' }, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('D-3');
  });

  it('M5-1b TP-145 exits 1 for a closed number and names the date', () => {
    const error = errorOf(requireOpen({ kind: 'closed', date: '2030-01-02' }, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-02');
  });

  it('M5-1b TP-148 shows a stored date through the echo rule: clean and cut', () => {
    const date = `${ESCAPE}[31mEVIL${'x'.repeat(100)}`;
    const message = errorOf(requireOpen({ kind: 'closed', date }, 'D-3')).message;
    expect(message).not.toContain(ESCAPE);
    expect(message).not.toContain('x'.repeat(60));
  });

  it('M5-1b TP-145 gives no pass to an answered row: the store read is the next step', () => {
    const state = { kind: 'answered', date: '2030-01-02', request: null } as const;
    expect(exitCodeOf[errorOf(requireOpen(state, 'D-3')).kind]).toBe(1);
  });
});

describe('the chosen option (TP-145)', () => {
  it('M5-1b TP-145 gives the option of the request', () => {
    expect(unwrap(chosenOptionOf(strictOf(), 'b'))).toEqual({ key: 'b', text: 'Use Postgres.' });
  });

  it('M5-1b TP-145 exits 2 for an option that the request does not have, and names the options', () => {
    const error = errorOf(chosenOptionOf(strictOf(), 'c'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('a, b');
  });

  it('M5-1b TP-148 shows a typed key through the echo rule', () => {
    const error = errorOf(chosenOptionOf(strictOf(), `${ESCAPE}[31m${'y'.repeat(100)}`));
    expect(error.message).not.toContain(ESCAPE);
    expect(error.message).not.toContain('y'.repeat(60));
  });
});

describe('the recheck under the lock (TP-147)', () => {
  const hashNow = strictOf().hash;

  it('M5-1b TP-147 gives the request again when nothing changed', () => {
    const request = unwrap(recheckRequest(waitingOf(entry()), logOf(), 'D-3', hashNow));
    expect(request.hash).toBe(hashNow);
    expect(request.canonical).toBe(strictOf().canonical);
  });

  it('M5-1b TP-147 exits 1 when the hash is not equal: the request changed after the prompt', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ question: 'Another question?' })), logOf(), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('changed after the prompt');
  });

  it('M5-1b TP-147 exits 1 when a moved separator or one more option changes the hash', () => {
    const more = entry({ options: [...(entry()['options'] as unknown[]), { key: 'c', text: 'Use a file.' }] });
    expect(exitCodeOf[errorOf(recheckRequest(waitingOf(more), logOf(), 'D-3', hashNow)).kind]).toBe(1);
  });

  it('M5-1b TP-147 exits 1 when the request is closed or answered after the prompt', () => {
    const row = { item: 'D-3: Which database?', decision: 'a', date: '2030-01-02', by: 'owner' };
    for (const [waiting, log] of [
      [waitingOf(), logOf()],
      [waitingOf(), logOf({ item: 'D-3: t', decision: 'closed', date: '2030-01-02' })],
      [waitingOf(), logOf(row)],
    ] as const) {
      const error = errorOf(recheckRequest(waiting, log, 'D-3', hashNow));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('changed after the prompt');
    }
  });

  it('M5-1b TP-147 exits 1 and names both files when the number is in both', () => {
    const row = { item: 'D-3: Which database?', decision: 'a', date: '2030-01-02' };
    const error = errorOf(recheckRequest(waitingOf(entry()), logOf(row), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.decisionLog);
  });

  it('M5-1b TP-168 runs the strict read again: an entry that breaks a rule exits 1 and names the waiting file', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ title: `Which${ZERO_WIDTH_SPACE}?` })), logOf(), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
  });

  it('M5-1b TP-147 gives a remedy line that names the decide command', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ title: 'Changed' })), logOf(), 'D-3', hashNow));
    expect(error.hint ?? '').toContain(commandText('decide'));
  });
});

describe('the room of the decision log (TP-192)', () => {
  it('M5-1b TP-192 accepts a text of exactly the cap in bytes', () => {
    expect(requireLogRoom('x'.repeat(maxFileBytes)).ok).toBe(true);
  });

  it('M5-1b TP-192 exits 1, names the file and the cap, and says not to remove rows, for a text over the cap', () => {
    const error = errorOf(requireLogRoom('x'.repeat(maxFileBytes + 1)));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.decisionLog);
    expect(error.message).toContain(String(maxFileBytes));
    expect(error.hint ?? '').toMatch(/do not remove rows/i);
  });

  it('M5-1b TP-192 counts bytes, not characters', () => {
    const twoBytes = 'é'.repeat(maxFileBytes / 2 + 1);
    expect(twoBytes.length).toBeLessThan(maxFileBytes);
    expect(exitCodeOf[errorOf(requireLogRoom(twoBytes)).kind]).toBe(1);
  });
});

describe('the note (TP-184)', () => {
  it('M5-1b TP-184 gives a note of one line as typed, with no trim', () => {
    expect(unwrap(checkNote(' Cheaper to run. '))).toBe(' Cheaper to run. ');
    expect(unwrap(checkNote('x'))).toBe('x');
    expect(unwrap(checkNote('é'.repeat(500)))).toHaveLength(500);
  });

  const BAD = [
    ['no text', ''],
    ['only spaces', '   '],
    ['more than 500 characters', 'x'.repeat(501)],
    ['a line break', 'one\ntwo'],
    ['a carriage return', 'one\rtwo'],
    ['a tab', 'one\ttwo'],
    ['a control character', `one${at(7)}two`],
    ['a line separator', `one${LINE_SEPARATOR}two`],
    ['a mark of text direction', `one${BIDI_OVERRIDE}two`],
    ['a zero width space', `one${ZERO_WIDTH_SPACE}two`],
    ['a tag character', `one${TAG_LETTER}two`],
    ['an escape', `${ESCAPE}[31mred`],
  ] as const;

  it.each(BAD)('M5-1b TP-184 exits 2 for a note with %s', (_name, text) => {
    const error = errorOf(checkNote(text));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).not.toContain(ESCAPE);
  });
});

describe('the log row of an owner answer (TP-154, TP-173, TP-189)', () => {
  const request = strictOf();

  it('M5-1b TP-154 holds item, decision, date, by and request, and no other key', () => {
    const row = unwrap(decideLogRow(request, 'b', '2030-01-02'));
    expect(Object.keys(row).sort()).toEqual(['by', 'date', 'decision', 'item', 'request']);
    expect(row['decision']).toBe('b');
    expect(row['date']).toBe('2030-01-02');
    expect(row['by']).toBe('owner');
    expect(row['item']).toBe('D-3: Which database?');
  });

  it('M5-1b TP-154 puts the canonical text in request exactly as the hash covers it', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    expect(row['request']).toBe(request.canonical);
    expect(row['request']).toBe(canonicalOf(entry()));
  });

  it('M5-1b TP-173 lets a consumer hash the stored text with no other step and get the hash of the request', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    expect(requestHashOf(String(row['request']))).toBe(request.hash);
  });

  it('M5-1b TP-173 gives a different hash for a row text that was edited', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    const edited = String(row['request']).replace('SQLite', 'Oracle');
    expect(requestHashOf(edited)).not.toBe(request.hash);
  });

  it('M5-1b TP-173 reads back as an answered row with the same request text, through the file readers', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    const log = logOf(row);
    expect(log.rows[0]?.id).toBe('D-3');
    expect(unwrap(requestStateOf(waitingOf(), log, 'D-3'))).toEqual({ kind: 'answered', date: '2030-01-02', request: request.canonical });
  });

  it('M5-1b TP-154 exits 1 for an option that the request does not have', () => {
    expect(exitCodeOf[errorOf(decideLogRow(request, 'zzz', '2030-01-02')).kind]).toBe(1);
  });

  it.each(['2030-1-2', '2030-01-02T10:00:00Z', '', 'today'])('M5-1b TP-154 exits 1 for the date %j', (date) => {
    expect(exitCodeOf[errorOf(decideLogRow(request, 'a', date)).kind]).toBe(1);
  });
});

describe('the request block (TP-181)', () => {
  /** The block lines without the mark, after a check that every line starts with it and stays inside the width. */
  const blockOf = (...args: Parameters<typeof requestBlockLines>): readonly string[] => {
    const lines = requestBlockLines(...args);
    expect(lines.every((line) => line.startsWith(BLOCK_MARK) && line.length <= maxDisplayWidth)).toBe(true);
    return lines.map((line) => line.slice(BLOCK_MARK.length));
  };

  const sectionOf = (lines: readonly string[], label: string, next: string): string => {
    const start = lines.findIndex((line) => line.startsWith(label));
    const end = lines.findIndex((line, index) => index > start && line.startsWith(next));
    return lines
      .slice(start, end === -1 ? undefined : end)
      .map((line) => line.slice(label.length))
      .join('');
  };

  it('M5-1b TP-181 shows the number, the title, the question, every option and the note', () => {
    const lines = blockOf(strictOf(), 'a', 'Cheaper to run.');
    expect(lines[0]).toBe('Decision D-3');
    expect(lines).toContain('Title:    Which database?');
    expect(lines).toContain('Question: Which database do we use for the queue?');
    expect(lines).toContain('Options:');
    expect(lines).toContain('  a (recommended) (chosen): Use SQLite.');
    expect(lines).toContain('  b: Use Postgres.');
    expect(lines).toContain('Note:     Cheaper to run.');
  });

  it('M5-1b TP-181 marks the chosen option when it is not the recommended one', () => {
    const lines = blockOf(strictOf(), 'b', null);
    expect(lines).toContain('  a (recommended): Use SQLite.');
    expect(lines).toContain('  b (chosen): Use Postgres.');
  });

  it('M5-1b TP-181 shows no note line when there is no note', () => {
    expect(blockOf(strictOf(), 'a', null).some((line) => line.startsWith('Note:'))).toBe(false);
  });

  it('M5-1b TP-181 wraps a question of 500 characters and cuts no text', () => {
    const question = Array.from({ length: 500 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
    const lines = blockOf(strictOf({ question }), 'a', null);
    const shown = lines.slice(lines.findIndex((line) => line.startsWith('Question:')), lines.indexOf('Options:'));
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.map((line) => line.slice('Question: '.length)).join('')).toBe(question);
  });

  it('M5-1b TP-181 wraps a title, an option text and a note at the width and cuts no text', () => {
    const title = 'T'.repeat(100);
    const text = 'o'.repeat(200);
    const note = 'n'.repeat(500);
    const request = strictOf({ title, options: [{ key: 'a', text }, { key: 'b', text: 'short' }] });
    const lines = blockOf(request, 'a', note);
    expect(sectionOf(lines, 'Title:    ', 'Question:')).toBe(title);
    expect(sectionOf(lines, 'Note:     ', 'zzz-no-next')).toBe(note);
    const first = lines.findIndex((line) => line.startsWith('  a (chosen): '));
    const second = lines.findIndex((line) => line.startsWith('  b: '));
    const prefix = '  a (chosen): ';
    expect(
      lines
        .slice(first, second)
        .map((line) => line.slice(prefix.length))
        .join(''),
    ).toBe(text);
  });

  it('M5-1b TP-181 wraps at the width also for the longest option key and both marks', () => {
    const key = 'k'.repeat(40);
    const text = 'z'.repeat(200);
    const request = strictOf({ options: [{ key, text, rec: true }] });
    const lines = blockOf(request, key, null);
    expect(lines.join('').split('z').length - 1).toBe(200);
  });

  it('M5-1b TP-181 marks every line, so a text that looks like an option line cannot pass for one in a narrow terminal', () => {
    const terminalWidth = 80;
    const fake = '  b (chosen): Use Postgres.';
    const question = `${'x'.repeat(terminalWidth - BLOCK_MARK.length - 'Question: '.length)}${fake}`;
    const lines = requestBlockLines(strictOf({ question }), 'a', null);
    const shown = lines.flatMap((line) => line.match(new RegExp(`.{1,${terminalWidth}}`, 'g')) ?? []);
    expect(shown).toContain(fake);
    expect(lines.every((line) => line.startsWith(BLOCK_MARK))).toBe(true);
    expect(shown.filter((line) => line.startsWith(BLOCK_MARK) && line.includes('(chosen)'))).toEqual([`${BLOCK_MARK}  a (recommended) (chosen): Use SQLite.`]);
  });
});
