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
import { commandLines, commandText, files, maxDisplayWidth, maxFileBytes, relayedMarker, requestDeciders, roles } from '../../src/names.js';

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

describe('the strict read of a request', () => {
  it('gives the request, its canonical text and its hash, with the stored strings as they are', () => {
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

  it('hashes the same request to the same value, whatever the order of the keys', () => {
    const reordered = { options: entry().options, question: entry().question, title: entry().title, id: 'D-3' };
    expect(unwrap(strictRequestOf(waitingOf(reordered), 'D-3')).hash).toBe(strictOf().hash);
  });

  it('accepts one option, nine options and a rec mark of false', () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, text: `Option ${index}` }));
    expect(strictOf({ options: [{ key: 'a', text: 'Only.' }] }).options).toHaveLength(1);
    expect(strictOf({ options: nine }).options).toHaveLength(9);
    expect(strictOf({ options: [{ key: 'a', text: 'One.', rec: false }] }).options).toEqual([{ key: 'a', text: 'One.' }]);
  });

  const OPENED_AT = '2030-01-02T10:11:12.345Z';

  it('keeps the canonical text and the hash of a row of four keys, and gives no open time and no group', () => {
    const request = strictOf();
    expect(request.openedAt).toBeNull();
    expect(request.group).toBeNull();
    expect(request.canonical).toBe(
      '{"request":{"id":"D-3","options":[{"key":"a","rec":true,"text":"Use SQLite."},{"key":"b","text":"Use Postgres."}],"question":"Which database do we use for the queue?","title":"Which database?"},"tag":"factory.decision-request","version":1}',
    );
    expect(request.hash).toBe('5dd3bf677d8d1f74b648f6a6d24b92bbf8eb5dfab95f31ae142e544b2b4f0efb');
  });

  it('gives the open time and the group of a row of six keys, and hashes the whole row', () => {
    const six = entry({ opened_at: OPENED_AT, group: 'later' });
    const request = unwrap(strictRequestOf(waitingOf(six), 'D-3'));
    expect(request.openedAt).toBe(OPENED_AT);
    expect(request.group).toBe('later');
    expect(request.canonical).toBe(canonicalOf(six));
    expect(request.canonical).toContain(`"opened_at":"${OPENED_AT}"`);
    expect(request.hash).not.toBe(strictOf().hash);
  });

  it.each(['now', 'later'])('accepts the group %s alone, and the open time alone', (group) => {
    expect(strictOf({ group }).group).toBe(group);
    expect(strictOf({ group }).openedAt).toBeNull();
    expect(strictOf({ opened_at: OPENED_AT }).openedAt).toBe(OPENED_AT);
    expect(strictOf({ opened_at: OPENED_AT }).group).toBeNull();
  });

  it.each([
    ['text', 'EVIL'],
    ['a number', 5],
    ['null', null],
    ['a time without milliseconds', '2030-01-02T10:11:12Z'],
    ['a time with an offset', '2030-01-02T10:11:12.345+00:00'],
    ['a time with a lower case z', '2030-01-02T10:11:12.345z'],
    ['a time that does not exist', '2030-02-30T10:11:12.345Z'],
    ['a time with a space in front', ' 2030-01-02T10:11:12.34Z'],
    ['a time of a long year', '+012030-01-02T10:11:12.345Z'],
  ])('refuses an open time of %s with exit 1, names the key and repeats no value', (_name, openedAt) => {
    const error = errorOf(strictRequestOf(waitingOf(entry({ opened_at: openedAt })), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).toContain('opened_at');
    expect(error.message).not.toContain(String(openedAt));
    expect(error.hint ?? '').toContain(commandText(commandLines.requestClose));
  });

  it.each([
    ['another word', 'EVIL'],
    ['a word in upper case', 'Now'],
    ['a word with a space', 'now '],
    ['a number', 1],
    ['null', null],
    ['a list', ['now']],
  ])('refuses a group of %s with exit 1, names the key and repeats no value', (_name, group) => {
    const error = errorOf(strictRequestOf(waitingOf(entry({ group })), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).toContain('group');
    expect(error.message).not.toContain('EVIL');
    expect(error.hint ?? '').toContain(commandText(commandLines.requestClose));
  });

  it('refuses a hand-set key beside the two new keys, with exit 1', () => {
    const error = errorOf(strictRequestOf(waitingOf(entry({ opened_at: OPENED_AT, group: 'now', extra: 'EVIL' })), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('a key other than');
    expect(error.message).toContain('opened_at');
    expect(error.message).toContain('group');
    expect(error.message).not.toContain('EVIL');
  });

  it('gives exit 1 for a request that is not in the waiting file', () => {
    const error = errorOf(strictRequestOf(waitingOf(entry()), 'D-9'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
  });

  const LONG = (length: number): string => 'x'.repeat(length);

  const FAULTS: readonly (readonly [string, Entry])[] = [
    ['a key outside the allowed keys', entry({ extra: 'EVIL' })],
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

  it.each(FAULTS)('refuses %s with exit 1, names the waiting file and repeats no stored text', (_name, stored) => {
    const id = typeof stored['id'] === 'string' ? stored['id'] : 'D-3';
    const error = errorOf(strictRequestOf(waitingOf(stored), id));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).not.toContain('EVIL');
    expect(error.hint ?? '').not.toContain('EVIL');
  });

  it.each(FAULTS)('gives a second remedy sentence for %s: close the request that is not changed and add a new one', (_name, stored) => {
    const id = typeof stored['id'] === 'string' ? stored['id'] : 'D-3';
    const hint = errorOf(strictRequestOf(waitingOf(stored), id)).hint ?? '';
    expect(hint).toContain(`${commandText(commandLines.requestClose)} ${id}`);
    expect(hint).toContain(commandText(commandLines.requestAdd));
  });
});

describe('a character that the display removes', () => {
  const HIDDEN = [
    ['a zero width space', ZERO_WIDTH_SPACE],
    ['a tag character', TAG_LETTER],
    ['a variation selector', VARIATION_SELECTOR],
    ['an escape', ESCAPE],
    ['a combining grapheme joiner', at(0x34f)],
    ['an unassigned default ignorable code point', at(0x2065)],
    ['a lone surrogate', at(0xd800)],
  ] as const;

  it.each(HIDDEN)('refuses %s in the title, the question and the text of an option, with exit 1', (_name, hidden) => {
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

  it('refuses the joiner of an emoji, because the display removes it', () => {
    const error = errorOf(strictRequestOf(waitingOf(entry({ title: `a${at(0x200d)}b` })), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
  });
});

describe('the state of a request', () => {
  const ROW = { item: 'D-3: Which database?', decision: 'a', date: '2030-01-02' };

  it('is open for an entry that the log does not name', () => {
    expect(unwrap(requestStateOf(waitingOf(entry()), logOf(), 'D-3'))).toEqual({ kind: 'open' });
  });

  it('is unknown for a number that neither file holds', () => {
    expect(unwrap(requestStateOf(waitingOf(entry()), logOf(ROW), 'D-9'))).toEqual({ kind: 'unknown' });
  });

  it('is closed, with the date, for a row that has no by key', () => {
    expect(unwrap(requestStateOf(waitingOf(), logOf(ROW), 'D-3'))).toEqual({ kind: 'closed', date: '2030-01-02' });
  });

  it('is closed for a row that has a who key and no by key, because it gives no proof', () => {
    const row = { ...ROW, who: 'owner' };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3')).kind).toBe('closed');
  });

  it('has a null date for a row with no date text', () => {
    const row = { item: 'D-3: t', decision: 'a', date: 5 };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'closed', date: null });
  });

  it.each(Object.values(requestDeciders))('is closed, with the decider %s, for a row that names the decider and holds no by key', (decider) => {
    const row = { ...ROW, decider };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'closed', date: '2030-01-02', decider });
  });

  it.each(['owner', 'someone', 5, null])('is closed with no decider for a row whose decider %j is no value of the deciders', (decider) => {
    const row = { ...ROW, decider };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'closed', date: '2030-01-02' });
  });

  it('is answered, a candidate only, for a row that has a by key, and gives the date and the request text of the row and no option', () => {
    const row = { ...ROW, decision: 'zzz-edited', by: 'owner', request: 'the text of the row' };
    const state = unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'));
    expect(state).toEqual({ kind: 'answered', date: '2030-01-02', request: 'the text of the row' });
    expect(JSON.stringify(state)).not.toContain('zzz-edited');
  });

  it('is answered for a row with a by key of any value, because the owner store decides', () => {
    const row = { ...ROW, by: 'someone else' };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({ kind: 'answered', date: '2030-01-02', request: null });
  });

  it('is closed and relayed for a row that holds the relayed key, with the decider of the row', () => {
    const row = { ...ROW, decider: requestDeciders.coordinator, relayed: relayedMarker };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3'))).toEqual({
      kind: 'closed',
      date: '2030-01-02',
      decider: requestDeciders.coordinator,
      relayed: true,
    });
  });

  it.each(['', 7, null, 'any other text'])('is closed and relayed for a row whose relayed key holds %j, because the key is the mark', (relayed) => {
    const state = unwrap(requestStateOf(waitingOf(), logOf({ ...ROW, relayed }), 'D-3'));
    expect(state).toEqual({ kind: 'closed', date: '2030-01-02', relayed: true });
  });

  it('stays a candidate answer for a row that holds the by key and the relayed key, because only the owner store proves an answer', () => {
    const row = { ...ROW, by: 'owner', relayed: relayedMarker };
    expect(unwrap(requestStateOf(waitingOf(), logOf(row), 'D-3')).kind).toBe('answered');
  });

  it('exits 1 and names both files for a number that is in the waiting file and in the log', () => {
    const error = errorOf(requestStateOf(waitingOf(entry()), logOf(ROW), 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
    expect(error.message).toContain(files.decisionLog);
  });

  it('exits 1 for a number that is in both files, also when the row has a by key', () => {
    const row = { ...ROW, by: 'owner' };
    expect(exitCodeOf[errorOf(requestStateOf(waitingOf(entry()), logOf(row), 'D-3')).kind]).toBe(1);
  });
});

describe('the states that stop decide', () => {
  it('lets an open request go on', () => {
    expect(requireOpen({ kind: 'open' }, 'D-3').ok).toBe(true);
  });

  it('exits 2 for an unknown number', () => {
    const error = errorOf(requireOpen({ kind: 'unknown' }, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('D-3');
  });

  it('exits 1 for a closed number and names the date', () => {
    const error = errorOf(requireOpen({ kind: 'closed', date: '2030-01-02' }, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-02');
  });

  it('shows a stored date through the echo rule: clean and cut', () => {
    const date = `${ESCAPE}[31mEVIL${'x'.repeat(100)}`;
    const message = errorOf(requireOpen({ kind: 'closed', date }, 'D-3')).message;
    expect(message).not.toContain(ESCAPE);
    expect(message).not.toContain('x'.repeat(60));
  });

  it.each(Object.values(requestDeciders))('names the decider %s of a closed number, and says that the decider has no owner authority', (decider) => {
    const error = errorOf(requireOpen({ kind: 'closed', date: '2030-01-02', decider }, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`decided by the "${decider}"`);
    expect(error.message).toContain(`no ${roles.owner} authority`);
  });

  it('says that the closed number holds an owner answer that the coordinator relayed, with no owner proof, and keeps the remedy to add a new request', () => {
    const state = { kind: 'closed', date: '2030-01-02', decider: requestDeciders.coordinator, relayed: true } as const;
    const error = errorOf(requireOpen(state, 'D-3'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(relayedMarker);
    expect(error.message).toContain('2030-01-02');
    expect(error.hint).toContain(commandText(commandLines.requestAdd));
  });

  it('names no decider for a closed number that holds none', () => {
    expect(errorOf(requireOpen({ kind: 'closed', date: '2030-01-02' }, 'D-3')).message).not.toContain('decided by');
  });

  it('gives no pass to an answered row: the store read is the next step', () => {
    const state = { kind: 'answered', date: '2030-01-02', request: null } as const;
    expect(exitCodeOf[errorOf(requireOpen(state, 'D-3')).kind]).toBe(1);
  });
});

describe('the chosen option', () => {
  it('gives the option of the request', () => {
    expect(unwrap(chosenOptionOf(strictOf(), 'b'))).toEqual({ key: 'b', text: 'Use Postgres.' });
  });

  it('exits 2 for an option that the request does not have, and names the options', () => {
    const error = errorOf(chosenOptionOf(strictOf(), 'c'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('a, b');
  });

  it('shows a typed key through the echo rule', () => {
    const error = errorOf(chosenOptionOf(strictOf(), `${ESCAPE}[31m${'y'.repeat(100)}`));
    expect(error.message).not.toContain(ESCAPE);
    expect(error.message).not.toContain('y'.repeat(60));
  });
});

describe('the recheck under the lock', () => {
  const hashNow = strictOf().hash;

  it('gives the request again when nothing changed', () => {
    const request = unwrap(recheckRequest(waitingOf(entry()), logOf(), 'D-3', hashNow));
    expect(request.hash).toBe(hashNow);
    expect(request.canonical).toBe(strictOf().canonical);
  });

  it('exits 1 when the hash is not equal: the request changed after the prompt', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ question: 'Another question?' })), logOf(), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('changed after the prompt');
  });

  it('exits 1 when the group changes after the prompt, because the hash covers the whole row', () => {
    const six = { opened_at: '2030-01-02T10:11:12.345Z', group: 'now' };
    const shown = strictOf(six).hash;
    expect(unwrap(recheckRequest(waitingOf(entry(six)), logOf(), 'D-3', shown)).hash).toBe(shown);
    const error = errorOf(recheckRequest(waitingOf(entry({ ...six, group: 'later' })), logOf(), 'D-3', shown));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('changed after the prompt');
  });

  it('exits 1 when a moved separator or one more option changes the hash', () => {
    const more = entry({ options: [...(entry()['options'] as unknown[]), { key: 'c', text: 'Use a file.' }] });
    expect(exitCodeOf[errorOf(recheckRequest(waitingOf(more), logOf(), 'D-3', hashNow)).kind]).toBe(1);
  });

  it('exits 1 when the request is closed or answered after the prompt', () => {
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

  it('exits 1 and names both files when the number is in both', () => {
    const row = { item: 'D-3: Which database?', decision: 'a', date: '2030-01-02' };
    const error = errorOf(recheckRequest(waitingOf(entry()), logOf(row), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.decisionLog);
  });

  it('runs the strict read again: an entry that breaks a rule exits 1 and names the waiting file', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ title: `Which${ZERO_WIDTH_SPACE}?` })), logOf(), 'D-3', hashNow));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.waiting);
  });

  it('gives a remedy line that names the decide command', () => {
    const error = errorOf(recheckRequest(waitingOf(entry({ title: 'Changed' })), logOf(), 'D-3', hashNow));
    expect(error.hint ?? '').toContain(commandText('decide'));
  });
});

describe('the room of the decision log', () => {
  it('accepts a text of exactly the cap in bytes', () => {
    expect(requireLogRoom('x'.repeat(maxFileBytes)).ok).toBe(true);
  });

  it('exits 1, names the file and the cap, and says not to remove rows, for a text over the cap', () => {
    const error = errorOf(requireLogRoom('x'.repeat(maxFileBytes + 1)));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(files.decisionLog);
    expect(error.message).toContain(String(maxFileBytes));
    expect(error.hint ?? '').toMatch(/do not remove rows/i);
  });

  it('counts bytes, not characters', () => {
    const twoBytes = 'é'.repeat(maxFileBytes / 2 + 1);
    expect(twoBytes.length).toBeLessThan(maxFileBytes);
    expect(exitCodeOf[errorOf(requireLogRoom(twoBytes)).kind]).toBe(1);
  });
});

describe('the note', () => {
  it('gives a note of one line as typed, with no trim', () => {
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

  it.each(BAD)('exits 2 for a note with %s', (_name, text) => {
    const error = errorOf(checkNote(text));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).not.toContain(ESCAPE);
  });
});

describe('the log row of an owner answer', () => {
  const request = strictOf();

  it('holds item, decision, date, by and request, and no other key', () => {
    const row = unwrap(decideLogRow(request, 'b', '2030-01-02'));
    expect(Object.keys(row).sort()).toEqual(['by', 'date', 'decision', 'item', 'request']);
    expect(row['decision']).toBe('b');
    expect(row['date']).toBe('2030-01-02');
    expect(row['by']).toBe('owner');
    expect(row['item']).toBe('D-3: Which database?');
  });

  it('puts the canonical text in request exactly as the hash covers it', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    expect(row['request']).toBe(request.canonical);
    expect(row['request']).toBe(canonicalOf(entry()));
  });

  it('lets a consumer hash the stored text with no other step and get the hash of the request', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    expect(requestHashOf(String(row['request']))).toBe(request.hash);
  });

  it('gives a different hash for a row text that was edited', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    const edited = String(row['request']).replace('SQLite', 'Oracle');
    expect(requestHashOf(edited)).not.toBe(request.hash);
  });

  it('reads back as an answered row with the same request text, through the file readers', () => {
    const row = unwrap(decideLogRow(request, 'a', '2030-01-02'));
    const log = logOf(row);
    expect(log.rows[0]?.id).toBe('D-3');
    expect(unwrap(requestStateOf(waitingOf(), log, 'D-3'))).toEqual({ kind: 'answered', date: '2030-01-02', request: request.canonical });
  });

  it('exits 1 for an option that the request does not have', () => {
    expect(exitCodeOf[errorOf(decideLogRow(request, 'zzz', '2030-01-02')).kind]).toBe(1);
  });

  it.each(['2030-1-2', '2030-01-02T10:00:00Z', '', 'today'])('exits 1 for the date %j', (date) => {
    expect(exitCodeOf[errorOf(decideLogRow(request, 'a', date)).kind]).toBe(1);
  });
});

describe('the request block', () => {
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

  it('shows the number, the title, the question, every option and the note', () => {
    const lines = blockOf(strictOf(), 'a', 'Cheaper to run.');
    expect(lines[0]).toBe('Decision D-3');
    expect(lines).toContain('Title:    Which database?');
    expect(lines).toContain('Question: Which database do we use for the queue?');
    expect(lines).toContain('Options:');
    expect(lines).toContain('  a (recommended) (chosen): Use SQLite.');
    expect(lines).toContain('  b: Use Postgres.');
    expect(lines).toContain('Note:     Cheaper to run.');
  });

  it('shows the open time and the group between the question and the options when the row holds them', () => {
    const lines = blockOf(strictOf({ opened_at: '2030-01-02T10:11:12.345Z', group: 'later' }), 'a', null);
    expect(lines).toContain('Opened:   2030-01-02T10:11:12.345Z');
    expect(lines).toContain('Group:    later');
    const question = lines.findIndex((line) => line.startsWith('Question:'));
    expect(lines.slice(question + 1, lines.indexOf('Options:'))).toEqual(['Opened:   2030-01-02T10:11:12.345Z', 'Group:    later']);
  });

  it('shows the group alone and the open time alone when the row holds one of them', () => {
    const groupOnly = blockOf(strictOf({ group: 'now' }), 'a', null);
    expect(groupOnly).toContain('Group:    now');
    expect(groupOnly.some((line) => line.startsWith('Opened:'))).toBe(false);
    const openedOnly = blockOf(strictOf({ opened_at: '2030-01-02T10:11:12.345Z' }), 'a', null);
    expect(openedOnly).toContain('Opened:   2030-01-02T10:11:12.345Z');
    expect(openedOnly.some((line) => line.startsWith('Group:'))).toBe(false);
  });

  it('shows neither line for a row of four keys', () => {
    const lines = blockOf(strictOf(), 'a', null);
    expect(lines.some((line) => line.startsWith('Opened:') || line.startsWith('Group:'))).toBe(false);
  });

  it('marks the chosen option when it is not the recommended one', () => {
    const lines = blockOf(strictOf(), 'b', null);
    expect(lines).toContain('  a (recommended): Use SQLite.');
    expect(lines).toContain('  b (chosen): Use Postgres.');
  });

  it('shows no note line when there is no note', () => {
    expect(blockOf(strictOf(), 'a', null).some((line) => line.startsWith('Note:'))).toBe(false);
  });

  it('wraps a question of 500 characters and cuts no text', () => {
    const question = Array.from({ length: 500 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
    const lines = blockOf(strictOf({ question }), 'a', null);
    const shown = lines.slice(lines.findIndex((line) => line.startsWith('Question:')), lines.indexOf('Options:'));
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.map((line) => line.slice('Question: '.length)).join('')).toBe(question);
  });

  it('wraps a title, an option text and a note at the width and cuts no text', () => {
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

  it('wraps at the width also for the longest option key and both marks', () => {
    const key = 'k'.repeat(40);
    const text = 'z'.repeat(200);
    const request = strictOf({ options: [{ key, text, rec: true }] });
    const lines = blockOf(request, key, null);
    expect(lines.join('').split('z').length - 1).toBe(200);
  });

  it('marks every line, so a text that looks like an option line cannot pass for one in a narrow terminal', () => {
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
