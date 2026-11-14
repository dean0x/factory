import { describe, expect, it } from 'vitest';
import { buildDecisionRecord, decisionRecordPath, type DecisionRecord, type DecisionRecordInput } from '../../src/board/decision-record.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { dirs, files } from '../../src/names.js';
import { stateRel } from '../../src/state/layout.js';

const AT = '2030-01-02T10:11:12.345Z';

/** The separators that JSON leaves as they are. They are built from their code points, so no editor or tool can turn them into a break. */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NEXT_LINE = String.fromCodePoint(0x85);

const REQUEST = {
  id: 'D-3',
  title: 'Which database?',
  question: 'Which database do we use for the queue?',
  options: [
    { key: 'a', text: 'Use SQLite.', rec: true as const },
    { key: 'b', text: 'Use Postgres.' },
  ],
};

const input = (changes: Partial<DecisionRecordInput> = {}): DecisionRecordInput => ({
  node: 'factory-one',
  request: REQUEST,
  option: 'a',
  at: AT,
  note: null,
  log: null,
  ...changes,
});

const built = (changes: Partial<DecisionRecordInput> = {}): DecisionRecord => {
  const result = buildDecisionRecord(input(changes));
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

const RECORD_PATH = 'decision-profile/decisions/2030-01-02-d-3-which-database.md';

describe('the profile paths', () => {
  it('names the decisions folder and the log of the profile in the state folder', () => {
    expect(stateRel.profileDecisions).toBe(`${dirs.profile}/${dirs.decisions}`);
    expect(stateRel.profileLog).toBe(`${dirs.profile}/${files.profileLog}`);
  });
});

describe('the profile record path', () => {
  it('is the date, the D-n and the slug of the title, in the decisions folder', () => {
    expect(built().path).toBe(RECORD_PATH);
  });

  it('gives the same path from the path function that the builder uses', () => {
    const path = decisionRecordPath({ id: 'D-3', title: 'Which database?', at: AT });
    expect(path.ok && path.value).toBe(RECORD_PATH);
  });

  it('has no slug part when the title gives no slug', () => {
    expect(built({ request: { ...REQUEST, title: '?!?' } }).path).toBe('decision-profile/decisions/2030-01-02-d-3.md');
  });

  it('cuts the slug to 40 characters with no hyphen at the end', () => {
    const title = `${'word '.repeat(20)}end`;
    const name = built({ request: { ...REQUEST, title } }).path.split('/').pop() ?? '';
    const slug = name.slice('2030-01-02-d-3-'.length, -'.md'.length);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.startsWith('word-word')).toBe(true);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('takes the UTC date of the time, so the last and the first moment of a day name two days', () => {
    expect(built({ at: '2030-01-02T23:59:59.999Z' }).path).toContain('/2030-01-02-d-3-');
    expect(built({ at: '2030-01-03T00:00:00.000Z' }).path).toContain('/2030-01-03-d-3-');
  });

  it.each([
    ['a text that is not a time', 'yesterday'],
    ['a date with no time', '2030-01-02'],
    ['a time with an offset', '2030-01-02T10:11:12+02:00'],
    ['a month that does not exist', '2030-13-02T10:11:12.000Z'],
  ])('refuses %s, with exit 1', (_name, at) => {
    const error = errorOf(decisionRecordPath({ id: 'D-3', title: 'T', at }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('time');
  });

  it.each(['D-0', 'D-03', 'D-', 'd-3', 'D-3/../x', 'D-1234567890'])('refuses the id %s, with exit 1', (id) => {
    const error = errorOf(decisionRecordPath({ id, title: 'T', at: AT }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('id');
  });
});

describe('the profile record text', () => {
  it('has the frontmatter and the sections of the template, in order', () => {
    expect(built({ note: 'The queue is small.' }).text).toBe(
      [
        '---',
        'date: 2030-01-02',
        `time: ${AT}`,
        'context: factory-one',
        'principles: []',
        'decided_by: owner',
        '---',
        '',
        '## Question',
        '',
        'Title: "Which database?"',
        'Question: "Which database do we use for the queue?"',
        '',
        '## Options',
        '',
        '- a: "Use SQLite." (recommended) (chosen)',
        '- b: "Use Postgres."',
        '',
        '## Choice',
        '',
        'Option: a',
        '',
        '## Reason',
        '',
        'Note: "The queue is small."',
        '',
        '## Consequences or follow-ups',
        '',
        'None recorded.',
        '',
      ].join('\n'),
    );
  });

  it('marks the chosen option when it is not the recommended one', () => {
    const text = built({ option: 'b' }).text;
    expect(text).toContain('- a: "Use SQLite." (recommended)\n');
    expect(text).toContain('- b: "Use Postgres." (chosen)\n');
    expect(text).toContain('Option: b\n');
  });

  it('says that the owner gave no reason when there is no note', () => {
    const text = built().text;
    expect(text).toContain('## Reason\n\nThe owner gave no reason.\n');
    expect(text).not.toContain('Note:');
  });

  it('changes no input', () => {
    const given = input();
    const before = JSON.stringify(given);
    buildDecisionRecord(given);
    expect(JSON.stringify(given)).toBe(before);
  });
});

describe('the log line', () => {
  const LINE = '- 2030-01-02 D-3: a ([[2030-01-02-d-3-which-database]])';

  it('gives a log that is not there the first text and the line', () => {
    expect(built({ log: null }).log).toBe(`# Decision log\n\n${LINE}\n`);
  });

  it('puts the line at the top of the list, below the first heading', () => {
    const log = '# Decision log\n\n- 2029-12-31 D-2: b ([[2029-12-31-d-2]])\n';
    expect(built({ log }).log).toBe(`# Decision log\n\n${LINE}\n- 2029-12-31 D-2: b ([[2029-12-31-d-2]])\n`);
  });

  it('puts the line right below a heading that has no blank line after it', () => {
    expect(built({ log: '# Decision log\n- old\n' }).log).toBe(`# Decision log\n${LINE}\n- old\n`);
  });

  it('keeps the text above the first heading and the text below the list', () => {
    const log = 'Intro line.\n\n# Decision log\n\n- old\n\nFooter.\n';
    expect(built({ log }).log).toBe(`Intro line.\n\n# Decision log\n\n${LINE}\n- old\n\nFooter.\n`);
  });

  it('gives a heading with no list a blank line and the line', () => {
    expect(built({ log: '# Decision log\n' }).log).toBe(`# Decision log\n\n${LINE}\n`);
  });

  it('puts the line at the start when the text has no heading', () => {
    expect(built({ log: '- old\n' }).log).toBe(`${LINE}\n- old\n`);
  });

  it('puts the line at the start of an empty text, which has no heading', () => {
    expect(built({ log: '' }).log).toBe(`${LINE}\n`);
  });

  it('does not take a heading of a deeper level for the first heading', () => {
    expect(built({ log: '## Part\n\n- old\n' }).log).toBe(`${LINE}\n## Part\n\n- old\n`);
  });
});

describe('hostile text in the record', () => {
  const HOSTILE_TITLE = 'T\n## Choice\n---\n[[firm-principle]]';
  const HOSTILE_QUESTION = `Q\r\n- decided_by: coordinator\n${LINE_SEPARATOR}## Reason ]] [[x]]`;
  const HOSTILE_OPTION = `O\n\n## Consequences or follow-ups\nprinciples: [[a]]${NEXT_LINE}---`;
  const HOSTILE_NOTE = 'N\n---\n## Options\n[[other-principle]] "quoted" \\ back';

  const hostile = (): DecisionRecord =>
    built({
      request: {
        id: 'D-3',
        title: HOSTILE_TITLE,
        question: HOSTILE_QUESTION,
        options: [
          { key: 'a', text: HOSTILE_OPTION, rec: true },
          { key: 'b', text: 'Plain.' },
        ],
      },
      note: HOSTILE_NOTE,
    });

  it('adds no section, no frontmatter line and no principle link', () => {
    const { text } = hostile();
    const lines = text.split(new RegExp(`[\\n${LINE_SEPARATOR}${NEXT_LINE}]`));
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '## Question',
      '## Options',
      '## Choice',
      '## Reason',
      '## Consequences or follow-ups',
    ]);
    expect(lines.filter((line) => line === '---')).toHaveLength(2);
    expect(lines.slice(0, 7)).toEqual(['---', 'date: 2030-01-02', `time: ${AT}`, 'context: factory-one', 'principles: []', 'decided_by: owner', '---']);
    // The empty list of the frontmatter holds the only brackets of the file.
    const body = text.split('\n---\n')[1] ?? '';
    expect(body).not.toMatch(/[[\]]/);
    expect(text).not.toContain('[[');
    expect(text).not.toContain('\r');
    expect(text).not.toContain(LINE_SEPARATOR);
    expect(text).not.toContain(NEXT_LINE);
  });

  it('keeps every text whole: a reader that decodes the JSON string gets the stored text back', () => {
    const { text } = hostile();
    const valueOf = (label: string, marks = ''): unknown => {
      const line = text.split('\n').find((candidate) => candidate.startsWith(label)) ?? '';
      return JSON.parse(line.slice(label.length, line.length - marks.length));
    };
    expect(valueOf('Title: ')).toBe(HOSTILE_TITLE);
    expect(valueOf('Question: ')).toBe(HOSTILE_QUESTION);
    expect(valueOf('- a: ', ' (recommended) (chosen)')).toBe(HOSTILE_OPTION);
    expect(valueOf('Note: ')).toBe(HOSTILE_NOTE);
  });

  it('writes the six-character escape for each bracket', () => {
    const { text } = built({ note: '[x]' });
    expect(text).toContain('Note: "\\u005bx\\u005d"');
  });

  it('writes the six-character escape for each angle bracket, so no autolink and no raw HTML stays live', () => {
    const autolink = '<https://x>';
    const markup = '<b>bold</b>';
    const { text } = built({
      request: { ...REQUEST, title: autolink, question: markup, options: [{ key: 'a', text: `${autolink} ${markup}` }] },
      note: `${autolink} ${markup}`,
    });
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain('Title: "\\u003chttps://x\\u003e"');
    expect(text).toContain('Question: "\\u003cb\\u003ebold\\u003c/b\\u003e"');
  });

  it('keeps a text with angle brackets whole: a reader that decodes the JSON string gets the stored text back', () => {
    const stored = '<https://x> and <b>bold</b> and a < b > c';
    const { text } = built({ note: stored });
    const label = 'Note: ';
    const line = text.split('\n').find((candidate) => candidate.startsWith(label)) ?? '';
    expect(JSON.parse(line.slice(label.length))).toBe(stored);
  });

  it('holds only the date, the D-n, the option key and the file name in the log line', () => {
    const { log, path } = hostile();
    const name = path.split('/').pop() ?? '';
    expect(log).toBe(`# Decision log\n\n- 2030-01-02 D-3: a ([[${name.slice(0, -'.md'.length)}]])\n`);
    expect(name).toMatch(/^2030-01-02-d-3-[a-z0-9-]*\.md$/);
  });
});

describe('a fault of the caller (fail closed)', () => {
  it('refuses a chosen option that the request does not have, with exit 1', () => {
    const error = errorOf(buildDecisionRecord(input({ option: 'z' })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('option');
  });

  it.each(['a\nb', 'a]]', '', 'a b', '-a'])('refuses the option key %j that is not a token, with exit 1', (key) => {
    const request = { ...REQUEST, options: [{ key, text: 'Text.' }] };
    const error = errorOf(buildDecisionRecord(input({ request, option: key })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('option key');
  });

  it('refuses a key that is not a token in an option that is not chosen', () => {
    const request = {
      ...REQUEST,
      options: [
        { key: 'a', text: 'Text.' },
        { key: 'b\n## Choice', text: 'Text.' },
      ],
    };
    expect(buildDecisionRecord(input({ request })).ok).toBe(false);
  });

  it.each(['Factory', 'a\nb', '', 'a/b', 'x'.repeat(41)])('refuses the node id %j that is not a slug, with exit 1', (node) => {
    const error = errorOf(buildDecisionRecord(input({ node })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('node');
  });

  it('repeats no stored text in a message', () => {
    const request = { ...REQUEST, title: 'SECRET-TITLE', options: [{ key: 'z\u0007', text: 'SECRET-TEXT' }] };
    const error = errorOf(buildDecisionRecord(input({ request, option: 'z\u0007' })));
    expect(error.message).not.toContain('SECRET');
    expect(error.message).not.toContain('\u0007');
  });
});
