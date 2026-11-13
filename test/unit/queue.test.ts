import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import { runQueue, type QueueOptions } from '../../src/commands/queue.js';
import type { BoardConfig } from '../../src/config/schema.js';
import { commands, commandText, files as fileNames, queueCommands, queueLimits } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { withFsWatch } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { sampleBoard, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

const BASE: QueueOptions = { home: HOME, words: [], items: [], note: undefined, fields: [], position: undefined };

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const run = (repo: BoardRepo, overrides: Partial<QueueOptions>): Promise<CliResult<CommandOutput>> =>
  runQueue(repo.deps, { ...BASE, ...overrides }, recipes);

const linesOf = (output: CliResult<CommandOutput>): string[] => plainText(valueOf(output)).trimEnd().split('\n');

const ITEMS = [itemRecord('B-1'), itemRecord('B-2'), itemRecord('B-3', { status: 'done' })];

const row = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, items: [], ...extra });

/** A node whose board holds the three items B-1 to B-3 and the given queue rows. */
const nodeWith = (rows: readonly Record<string, unknown>[], config?: ReturnType<typeof sampleConfigWithBoard>): Promise<BoardRepo> =>
  boardNode({ board: boardText(ITEMS, [], rows), ...(config === undefined ? {} : { config }) });

const rowsOf = (repo: BoardRepo): Record<string, unknown>[] => (JSON.parse(repo.textOf(fileNames.board) ?? '') as { merge: Record<string, unknown>[] }).merge;

const ROWS = [
  row('Board connector', { items: ['B-1'], release: true, note: 'Merge after the review', unknownKey: { nested: [1, 2] } }),
  row('Docs', { note: 'Café notes' }),
];

const configWith = (board: BoardConfig): ReturnType<typeof sampleConfigWithBoard> => sampleConfigWithBoard(board);

describe('queue set (TP-22, TP-28)', () => {
  it('M5-1b TP-22 adds a row at the end with its name, items and note, prints one line, and makes one commit that holds only the board file', async () => {
    const repo = await nodeWith(ROWS);
    expect(linesOf(await run(repo, { words: ['set', 'Release'], items: ['B-2', 'B-1'], note: 'Last one' }))).toEqual(['Added row 3 to the queue: Release']);
    expect(rowsOf(repo)[2]).toEqual({ name: 'Release', items: ['B-2', 'B-1'], note: 'Last one' });
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
  });

  it('M5-1b TP-22 adds the first row to an empty queue, with no items', async () => {
    const repo = await nodeWith([]);
    expect(linesOf(await run(repo, { words: ['set', 'First'] }))).toEqual(['Added row 1 to the queue: First']);
    expect(rowsOf(repo)).toEqual([{ name: 'First', items: [] }]);
  });

  it('M5-1b TP-28 keeps the release flag and every other key of a row through queue set', async () => {
    const repo = await nodeWith(ROWS);
    expect(linesOf(await run(repo, { words: ['set', 'Board connector'], note: 'New note', items: ['B-1', 'B-2'] }))).toEqual([
      'Saved row 1 of the queue: Board connector',
    ]);
    expect(rowsOf(repo)[0]).toEqual({ ...ROWS[0], note: 'New note', items: ['B-1', 'B-2'] });
    expect(rowsOf(repo)[0]?.['release']).toBe(true);
    expect(rowsOf(repo)[1]).toEqual(ROWS[1]);
  });

  it('M5-1b TP-28 keeps the release flag of a row through an item update', async () => {
    const repo = await nodeWith(ROWS);
    const options: ItemOptions = {
      home: HOME,
      words: ['update', 'B-1'],
      title: 'A new title',
      text: undefined,
      track: undefined,
      fields: [],
      state: undefined,
      stage: undefined,
      all: false,
      follow: false,
      ref: undefined,
      project: undefined,
      json: false,
    };
    valueOf(await runItem(repo.deps, options, recipes));
    expect(rowsOf(repo)).toEqual(ROWS);
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-28 sets the release flag of a row with the field flag, and a later set of the note keeps it', async () => {
    const repo = await nodeWith([row('Docs')]);
    valueOf(await run(repo, { words: ['set', 'Docs'], fields: ['release=true'] }));
    expect(rowsOf(repo)[0]).toEqual({ name: 'Docs', items: [], release: true });
    valueOf(await run(repo, { words: ['set', 'Docs'], note: 'Later' }));
    expect(rowsOf(repo)[0]).toEqual({ name: 'Docs', items: [], release: true, note: 'Later' });
    valueOf(await run(repo, { words: ['set', 'Docs'], fields: ['release=false'] }));
    expect(rowsOf(repo)[0]?.['release']).toBe(false);
  });

  it('M5-1b TP-22 changes nothing and makes no commit for a set that holds the values of the row already', async () => {
    const repo = await nodeWith(ROWS);
    const before = repo.textOf(fileNames.board);
    expect(linesOf(await run(repo, { words: ['set', 'Board connector'], note: 'Merge after the review', items: ['B-1'], fields: ['release=true'] }))).toEqual([
      'Row 1 of the queue: Board connector (no change)',
    ]);
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-22 prints the JSON document of a set', async () => {
    const repo = await nodeWith(ROWS);
    expect(valueOf(await run(repo, { words: ['set', 'Docs'], items: ['B-3'] })).json).toEqual({
      schema: 'factory.queue/v1',
      action: 'set',
      row: { name: 'Docs', position: 2, items: ['B-3'], created: false, changed: true },
    });
  });

  it('M5-1b TP-22 keeps the old form of the file: 2-space indent, non-ASCII escaped, and a line break at the end', async () => {
    const repo = await nodeWith(ROWS);
    valueOf(await run(repo, { words: ['set', 'Café 日本語'] }));
    const text = repo.textOf(fileNames.board) ?? '';
    expect(text).toContain('"name": "Caf\\u00e9 \\u65e5\\u672c\\u8a9e"');
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('queue set: the position of a row', () => {
  it('moves a row to the place that the position flag names, and keeps the other rows in order', async () => {
    const repo = await nodeWith([row('One'), row('Two'), row('Three')]);
    expect(linesOf(await run(repo, { words: ['set', 'Three'], position: '1' }))).toEqual(['Saved row 1 of the queue: Three']);
    expect(rowsOf(repo).map((entry) => entry['name'])).toEqual(['Three', 'One', 'Two']);
  });

  it('puts a new row at the place that the position flag names', async () => {
    const repo = await nodeWith([row('One'), row('Two')]);
    expect(linesOf(await run(repo, { words: ['set', 'New'], position: '2' }))).toEqual(['Added row 2 to the queue: New']);
    expect(rowsOf(repo).map((entry) => entry['name'])).toEqual(['One', 'New', 'Two']);
  });

  it('makes no commit for a row that is at its place already', async () => {
    const repo = await nodeWith([row('One'), row('Two')]);
    expect(linesOf(await run(repo, { words: ['set', 'Two'], position: '2' }))).toEqual(['Row 2 of the queue: Two (no change)']);
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['a place after the end for an old row', 'One', '3'],
    ['a place two after the end for a new row', 'New', '4'],
  ])('refuses %s with exit 2 and the range, and writes nothing', async (_name, name, position) => {
    const repo = await nodeWith([row('One'), row('Two')]);
    const before = repo.textOf(fileNames.board);
    const error = errorOf(await run(repo, { words: ['set', name], position }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('1 to');
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('queue set: the rules of the input (TP-28)', () => {
  const REFUSED: readonly (readonly [string, Partial<QueueOptions>, string])[] = [
    ['an item that the board does not hold', { items: ['B-9'] }, 'B-9'],
    ['an item id of a bad form', { items: ['x-1'] }, 'item id'],
    ['an item that the line names twice', { items: ['B-1', 'B-1'] }, 'twice'],
    ['more items than a row holds', { items: Array.from({ length: queueLimits.maxRowItems + 1 }, (_, at) => `B-${at + 1}`) }, String(queueLimits.maxRowItems)],
    ['a note with a line break', { note: 'Two\nlines' }, 'note'],
    ['a note of more than the most characters', { note: 'x'.repeat(501) }, 'note'],
    ['a field that the setup does not declare for a row', { fields: ['priority=P1'] }, 'priority'],
    ['a field that the setup does not name', { fields: ['nope=1'] }, 'nope'],
    ['a value that the flag field does not take', { fields: ['release=maybe'] }, 'release'],
    ['a field that is given twice', { fields: ['release=true', 'release=false'] }, 'twice'],
  ];

  it.each(REFUSED)('M5-1b TP-28 refuses %s with exit 2, names the cause, and writes nothing', async (_name, overrides, message) => {
    const repo = await nodeWith(ROWS);
    const before = repo.textOf(fileNames.board);
    const error = errorOf(await run(repo, { words: ['set', 'Docs'], ...overrides }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['an empty name', ' '],
    ['a name with a line break', 'Two\nlines'],
    ['a name of more than the most characters', 'x'.repeat(101)],
  ])('M5-1b TP-28 refuses %s with exit 2 and writes nothing', async (_name, name) => {
    const repo = await nodeWith(ROWS);
    const before = repo.textOf(fileNames.board);
    expect(exitCodeOf[errorOf(await run(repo, { words: ['set', name] })).kind]).toBe(2);
    expect(repo.textOf(fileNames.board)).toBe(before);
  });

  it('accepts a closed item in a row, because the board keeps it', async () => {
    const repo = await nodeWith(ROWS);
    valueOf(await run(repo, { words: ['set', 'Docs'], items: ['B-3'] }));
    expect(rowsOf(repo)[1]?.['items']).toEqual(['B-3']);
  });

  it('refuses a name that two rows hold, with exit 2, and writes nothing', async () => {
    const repo = await nodeWith([row('Same'), row('Same')]);
    const before = repo.textOf(fileNames.board);
    const error = errorOf(await run(repo, { words: ['set', 'Same'], note: 'x' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('two rows');
    expect(repo.textOf(fileNames.board)).toBe(before);
  });

  it('refuses a new row when the queue holds the most rows already, and still changes an old row', async () => {
    const rows = Array.from({ length: queueLimits.maxRows }, (_, at) => row(`Row ${at + 1}`));
    const repo = await nodeWith(rows);
    const error = errorOf(await run(repo, { words: ['set', 'One more'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(String(queueLimits.maxRows));
    expect(repo.commits).toEqual([]);
    valueOf(await run(repo, { words: ['set', 'Row 1'], note: 'still works' }));
    expect(repo.commits).toHaveLength(1);
  });

  it('refuses a new row that lacks a field that the setup requires for a row, and still changes an old row', async () => {
    const board = sampleBoard();
    const config = configWith({ ...board, fields: [...(board.fields ?? []), { name: 'gate', target: 'row', kind: 'flag', required: true }] });
    const repo = await nodeWith([row('Old')], config);
    const error = errorOf(await run(repo, { words: ['set', 'Fresh'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('gate');
    expect(repo.commits).toEqual([]);
    valueOf(await run(repo, { words: ['set', 'Old'], note: 'fine' }));
    valueOf(await run(repo, { words: ['set', 'Fresh'], fields: ['gate=false'] }));
    expect(repo.commits).toHaveLength(2);
  });
});

describe('the words and the flags of queue', () => {
  const BAD: readonly (readonly [string, Partial<QueueOptions>, string])[] = [
    ['no subcommand', { words: [] }, 'needs a subcommand'],
    ['an unknown subcommand', { words: ['remove', 'Docs'] }, 'unknown subcommand'],
    ['set with no name', { words: ['set'] }, 'one argument'],
    ['set with two names', { words: ['set', 'One', 'Two'] }, 'one argument'],
    ['set with a position that is not a number', { words: ['set', 'Docs'], position: 'x' }, '--position'],
    ['set with the position zero', { words: ['set', 'Docs'], position: '0' }, '--position'],
    ['set with a field word that has no value', { words: ['set', 'Docs'], fields: ['release'] }, 'NAME=VALUE'],
    ['show with an argument', { words: ['show', 'Docs'] }, 'takes no argument'],
    ['show with the item flag', { words: ['show'], items: ['B-1'] }, '--item is not for'],
    ['show with the note flag', { words: ['show'], note: 'x' }, '--note is not for'],
    ['show with the field flag', { words: ['show'], fields: ['release=true'] }, '--field is not for'],
    ['show with the position flag', { words: ['show'], position: '1' }, '--position is not for'],
  ];

  it.each(BAD)('M5-1b TP-22 %s exits 2 and touches no file', async (_name, overrides, message) => {
    const repo = await nodeWith(ROWS);
    const touched: string[] = [];
    const error = errorOf(await runQueue(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...overrides }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(error.hint).toContain(commandText(commands.queue));
    expect(touched).toEqual([]);
  });

  it('lists set and show for an unknown subcommand', async () => {
    const repo = await nodeWith(ROWS);
    expect(errorOf(await run(repo, { words: ['remove'] })).message).toContain(Object.values(queueCommands).join(', '));
  });
});

describe('queue show (TP-25, TP-91)', () => {
  it('M5-1b TP-25 shows the rows with their places, names, items, owner fields and notes, and makes no commit', async () => {
    const repo = await nodeWith(ROWS);
    const lines = linesOf(await run(repo, { words: ['show'] }));
    expect(lines[0]).toBe('2 rows in the queue.');
    expect(lines.slice(1).map((line) => line.split(/ {2,}/))).toEqual([
      ['NO', 'NAME', 'ITEMS', 'RELEASE', 'NOTE'],
      ['1', 'Board connector', 'B-1', 'true', 'Merge after the review'],
      ['2', 'Docs', '-', '-', 'Café notes'],
    ]);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-25 says that the queue is empty for a board with no row', async () => {
    const repo = await nodeWith([]);
    expect(linesOf(await run(repo, { words: ['show'] }))).toEqual(['0 rows in the queue.']);
  });

  it('M5-1b TP-91 prints a name with a bidi mark and a line break as one clean line', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const repo = await nodeWith([row(`Doc${bidi}\ns`, { note: `A${bidi}\tnote` })]);
    const text = plainText(valueOf(await run(repo, { words: ['show'] })));
    expect(text).not.toContain(bidi);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('Doc s');
    expect(lines[2]).toContain('A note');
  });

  it('M5-1b TP-91 shows a row with no name, no note and a bad item list as a dash', async () => {
    const repo = await nodeWith([{ items: 'B-1' }]);
    expect(linesOf(await run(repo, { words: ['show'] })).slice(2).map((line) => line.split(/ {2,}/))).toEqual([['1', '-', '-', '-', '-']]);
  });

  it('M5-1b TP-91 prints at most 20 lines for a long queue, and a last line that says how many rows are not shown', async () => {
    const repo = await nodeWith(Array.from({ length: 25 }, (_, at) => row(`Row ${at + 1}`)));
    const lines = linesOf(await run(repo, { words: ['show'] }));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('25 rows in the queue.');
    expect(lines[19]).toBe('8 more rows.');
  });

  it('M5-1b TP-91 prints the JSON document with each row as it is stored', async () => {
    const repo = await nodeWith(ROWS);
    const json = valueOf(await run(repo, { words: ['show'] })).json;
    expect(json['schema']).toBe('factory.queue-show/v1');
    expect(json['rows']).toEqual([
      { position: 1, name: 'Board connector', items: ['B-1'], note: 'Merge after the review', fields: { release: true } },
      { position: 2, name: 'Docs', items: [], note: 'Café notes', fields: {} },
    ]);
  });
});

describe('queue: an old queue key and a hosted tracker kind (TP-57, TP-67)', () => {
  it('M5-1b TP-57 exits 1 with the remedy to upgrade for a board that has the old queue key, and writes nothing', async () => {
    const repo = await boardNode({ board: `${JSON.stringify({ queue: [], items: [] }, null, 2)}\n` });
    const before = repo.textOf(fileNames.board);
    for (const overrides of [{ words: ['set', 'Docs'] }, { words: ['show'] }]) {
      const error = errorOf(await run(repo, overrides));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain(commandText(commands.upgrade));
    }
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-67 refuses queue set with exit 4 and writes nothing, and queue show still works', async () => {
    const base = sampleConfigWithBoard();
    const config = { ...base, core: { ...base.core, tracker: { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
    const repo = await boardNode({ config, board: boardText(ITEMS, [], ROWS) });
    const before = repo.textOf(fileNames.board);
    const error = errorOf(await run(repo, { words: ['set', 'Docs'], note: 'x' }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('FAC-M3 (provider plugin)');
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
    expect(linesOf(await run(repo, { words: ['show'] }))[0]).toBe('2 rows in the queue.');
  });
});
