import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import { files as fileNames, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { HOME } from '../helpers/guard-fixture.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';

const BASE: ItemOptions = {
  home: HOME,
  words: ['list'],
  title: undefined,
  text: undefined,
  track: undefined,
  fields: [],
  state: undefined,
  stage: undefined,
  all: false,
  json: false,
};

const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const list = (repo: BoardRepo, overrides: Partial<ItemOptions> = {}): Promise<CliResult<CommandOutput>> =>
  runItem(repo.deps, { ...BASE, ...overrides }, recipes);

/** The lines of the output of `item list`. */
const linesOf = async (repo: BoardRepo, overrides: Partial<ItemOptions> = {}): Promise<string[]> =>
  plainText(valueOf(await list(repo, overrides))).trimEnd().split('\n');

/** The cells of a line of a table: the columns are parted by two spaces or more. */
const cellsOf = (line: string): string[] => line.split(/ {2,}/);

const track = (id: string, name = id, roadmap = false): Record<string, unknown> => ({ id, name, roadmap });

const tracksOf = (count: number): Record<string, unknown>[] => Array.from({ length: count }, (_, at) => track(`track${at + 1}`));

const CORE = [track('core', 'Core', true), track('docs', 'Docs')];

describe('item list hides closed items, and --all shows them (TP-47)', () => {
  const BOARD = boardText(
    [
      itemRecord('B-1', { track: 'core', stage: 'building' }),
      itemRecord('B-2', { track: 'core', stage: 'review', status: 'done' }),
      itemRecord('B-3', { stage: 'ticket' }),
    ],
    CORE,
  );

  it('M5-1b TP-47 hides the closed items of the board by default, and says how to show them', async () => {
    const lines = await linesOf(await boardNode({ board: BOARD }));
    expect(lines[0]).toBe('2 items in 2 tracks. Closed items are hidden. Use --all to show them.');
    expect(lines.join('\n')).not.toContain('B-2');
    expect(cellsOf(lines[2] ?? '')).toEqual(['core', '1', 'B-1 building: Item B-1']);
  });

  it('M5-1b TP-47 shows the closed items with --all, and has no hint then', async () => {
    const lines = await linesOf(await boardNode({ board: BOARD }), { all: true });
    expect(lines[0]).toBe('3 items in 2 tracks.');
    expect(cellsOf(lines[2] ?? '')).toEqual(['core', '2', 'building 1, review 1']);
  });

  it('M5-1b TP-47 hides the closed items of one track by default, and shows them with --all', async () => {
    const repo = await boardNode({ board: BOARD });
    expect((await linesOf(repo, { track: 'core' })).join('\n')).not.toContain('B-2');
    expect((await linesOf(repo, { track: 'core', all: true })).join('\n')).toContain('B-2');
  });

  it('M5-1b TP-47 prints at most 20 lines for a long track, and a last line that says how many items are not shown', async () => {
    const items = Array.from({ length: 25 }, (_, at) => itemRecord(`B-${at + 1}`, { track: 'core', stage: 'ticket' }));
    const repo = await boardNode({ board: boardText(items, CORE) });
    const text = plainText(valueOf(await list(repo, { track: 'core' })));
    expectShortOutput(text);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[19]).toBe('8 more items.');
  });

  it('M5-1b TP-47 prints one line and no table for a board with no item and no track', async () => {
    const lines = await linesOf(await boardNode());
    expect(lines).toEqual(['0 items in 0 tracks. Closed items are hidden. Use --all to show them.']);
  });
});

describe('item list: one line for each track, with counts by stage (TP-82)', () => {
  it('M5-1b TP-82 prints a summary, a heading, and a line for each track with its counts by stage', async () => {
    const items = [
      itemRecord('B-1', { track: 'core', stage: 'building' }),
      itemRecord('B-2', { track: 'core', stage: 'building' }),
      itemRecord('B-3', { track: 'core', stage: 'review' }),
    ];
    const lines = await linesOf(await boardNode({ board: boardText(items, CORE) }));
    expect(cellsOf(lines[1] ?? '')).toEqual(['TRACK', 'ITEMS', 'STAGES']);
    expect(cellsOf(lines[2] ?? '')).toEqual(['core', '3', 'building 2, review 1']);
    expect(cellsOf(lines[3] ?? '')).toEqual(['docs', '0', '-']);
    expect(lines).toHaveLength(4);
  });

  it('M5-1b TP-82 shows the item and its stage on the line of a track with one item', async () => {
    const items = [itemRecord('B-4', { track: 'docs', stage: 'ticket', title: 'Write the guide' })];
    const lines = await linesOf(await boardNode({ board: boardText(items, CORE) }));
    expect(cellsOf(lines[3] ?? '')).toEqual(['docs', '1', 'B-4 ticket: Write the guide']);
  });

  it('M5-1b TP-82 puts the counts of the stages of the recipe in order, then the other stored stages, then no stage', async () => {
    const items = [
      itemRecord('B-1', { track: 'core' }),
      itemRecord('B-2', { track: 'core', stage: 'qa' }),
      itemRecord('B-3', { track: 'core', stage: 'review' }),
      itemRecord('B-4', { track: 'core', stage: 'ticket' }),
    ];
    const lines = await linesOf(await boardNode({ board: boardText(items, CORE) }));
    expect(cellsOf(lines[2] ?? '')).toEqual(['core', '4', 'ticket 1, review 1, qa* 1, no stage 1']);
  });
});

describe('item list caps the track lines at 17 (TP-83, TP-108)', () => {
  it('M5-1b TP-83 prints 17 track lines for 25 tracks, then one line that says 8 more and names the track flag', async () => {
    const repo = await boardNode({ board: boardText([], tracksOf(25)) });
    const text = plainText(valueOf(await list(repo)));
    expectShortOutput(text);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.slice(2, 19).map((line) => cellsOf(line)[0])).toEqual(tracksOf(17).map((entry) => entry['id']));
    expect(lines[19]).toContain('8 more tracks');
    expect(lines[19]).toContain('--track');
  });

  it('M5-1b TP-108 prints 17 track lines and no more line for exactly 17 tracks', async () => {
    const lines = await linesOf(await boardNode({ board: boardText([], tracksOf(17)) }));
    expect(lines).toHaveLength(19);
    expect(lines.join('\n')).not.toContain('more');
  });

  it('M5-1b TP-108 prints 17 track lines and one line that says 1 more for 18 tracks', async () => {
    const lines = await linesOf(await boardNode({ board: boardText([], tracksOf(18)) }));
    expect(lines).toHaveLength(20);
    expect(lines[19]).toContain('1 more track.');
  });

  it('M5-1b TP-108 counts the line of the items with no track as one of the 17 lines', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { stage: 'ticket' })], tracksOf(17)) });
    const lines = await linesOf(repo);
    expect(lines).toHaveLength(20);
    expect(cellsOf(lines[18] ?? '')).toEqual(['(no track)', '1', 'B-1 ticket: Item B-1']);
    expect(lines[19]).toContain('1 more track.');
  });

  it('M5-1b TP-83 keeps the first line within 120 characters, whatever the board holds', async () => {
    const long = 'x'.repeat(60);
    const board = boardText([], [track('core', long, true)]);
    const text = plainText(valueOf(await list(await boardNode({ board }), { track: 'core' })));
    expectShortOutput(text);
  });
});

describe('item list of one track, and the items with no track (TP-84)', () => {
  const ITEMS = [
    itemRecord('B-1', { track: 'core', stage: 'building', priority: 'P1', type: 'bug' }),
    itemRecord('B-2', { track: 'core', stage: 'review' }),
    itemRecord('B-3', { track: 'docs', stage: 'ticket' }),
    itemRecord('B-4', { stage: 'ticket' }),
  ];

  it('M5-1b TP-84 lists the items of the track with a stage column, and the fields of the setup', async () => {
    const lines = await linesOf(await boardNode({ board: boardText(ITEMS, CORE) }), { track: 'core' });
    expect(lines[0]).toBe('Track core: Core (roadmap). 2 items. Closed items are hidden. Use --all to show them.');
    expect(cellsOf(lines[1] ?? '')).toEqual(['ID', 'STAGE', 'STATUS', 'PRIORITY', 'TYPE', 'LANE', 'TITLE']);
    expect(cellsOf(lines[2] ?? '')).toEqual(['B-1', 'building', 'open', 'P1', 'bug', '-', 'Item B-1']);
    expect(cellsOf(lines[3] ?? '')).toEqual(['B-2', 'review', 'open', '-', '-', '-', 'Item B-2']);
    expect(lines).toHaveLength(4);
  });

  it('M5-1b TP-25 shows the priority and the type that item add stored', async () => {
    const repo = await boardNode({ board: boardText([], CORE) });
    valueOf(await runItem(repo.deps, { ...BASE, words: ['add'], title: 'New', track: 'core', fields: ['priority=P1', 'type=feature'] }, recipes));
    const lines = await linesOf(repo, { track: 'core' });
    expect(cellsOf(lines[2] ?? '')).toEqual(['B-1', 'ticket', 'open', 'P1', 'feature', '-', 'New']);
  });

  it('M5-1b TP-84 shows the items with no track under the no-track label', async () => {
    const lines = await linesOf(await boardNode({ board: boardText(ITEMS, CORE) }));
    expect(cellsOf(lines[lines.length - 1] ?? '')).toEqual(['(no track)', '1', 'B-4 ticket: Item B-4']);
  });

  it('M5-1b TP-84 shows an item with a track that the board does not list under the no-track label', async () => {
    const board = boardText([itemRecord('B-1', { track: 'gone', stage: 'ticket' })], CORE);
    const lines = await linesOf(await boardNode({ board }));
    expect(cellsOf(lines[lines.length - 1] ?? '')).toEqual(['(no track)', '1', 'B-1 ticket: Item B-1']);
  });

  it('M5-1b TP-84 exits 2 for an unknown track and lists the track ids', async () => {
    const error = errorOf(await list(await boardNode({ board: boardText(ITEMS, CORE) }), { track: 'nope' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('core, docs');
  });

  it('M5-1b TP-84 prints a summary alone for a track with no item', async () => {
    const lines = await linesOf(await boardNode({ board: boardText([], CORE) }), { track: 'docs', all: true });
    expect(lines).toEqual(['Track docs: Docs. 0 items.']);
  });
});

describe('item list shows a stage that the list does not hold as written, with a mark (TP-75)', () => {
  it('M5-1b TP-75 marks an unlisted stage on the line of a track with one item, and in the list of the track', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { track: 'core', stage: 'qa' })], CORE) });
    expect(cellsOf((await linesOf(repo))[2] ?? '')).toEqual(['core', '1', 'B-1 qa*: Item B-1']);
    expect(cellsOf((await linesOf(repo, { track: 'core' }))[2] ?? '')[1]).toBe('qa*');
  });

  it('M5-1b TP-75 shows a stage that only a flow sets as data, with no mark, because the list holds it', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { track: 'core', stage: 'merged' })], CORE) });
    expect(cellsOf((await linesOf(repo, { track: 'core' }))[2] ?? '')[1]).toBe('merged');
  });
});

describe('item list prints text from the board file as one clean line (TP-91)', () => {
  const BIDI = String.fromCodePoint(0x202e);

  it('M5-1b TP-91 cleans a title, a stage and a track name that hold a line break or a bidi mark', async () => {
    const items = [itemRecord('B-1', { track: 'core', title: `Two\nlines${BIDI} here`, stage: `re\nview${BIDI}` })];
    const repo = await boardNode({ board: boardText(items, [track('core', `Co${BIDI}re`, true)]) });
    for (const overrides of [{}, { track: 'core' }]) {
      const text = plainText(valueOf(await list(repo, overrides)));
      expect(text).not.toContain(BIDI);
      expect(text.trimEnd().split('\n').every((line) => !/[\r\t]/.test(line))).toBe(true);
    }
    expect((await linesOf(repo))[2]).toContain('B-1 re view*: Two lines here');
    expect((await linesOf(repo, { track: 'core' }))[0]).toContain('Track core: Core (roadmap).');
  });
});

describe('item list reads with no lock (TP-93)', () => {
  it('M5-1b TP-93 lists while another process holds the lock, does not wait, and leaves the lock file as it was', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1')], CORE) });
    repo.deps.seed(LOCK_FILE, '4242\n');
    const lines = await linesOf(repo);
    expect(lines[0]).toContain('1 item in 2 tracks');
    expect(repo.deps.files.get(LOCK_FILE)).toBe('4242\n');
    expect(repo.deps.sleeps).toEqual([]);
    expect(repo.commits).toEqual([]);
  });
});

describe('item list: faults of the board file', () => {
  it('M5-1b TP-47 exits 1 and names the board file for a board that is not valid JSON, and writes nothing', async () => {
    const repo = await boardNode({ board: 'not json' });
    const error = errorOf(await list(repo));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-47 has no JSON output: the flag is a usage error', async () => {
    const error = errorOf(await list(await boardNode({ board: boardText() }), { json: true }));
    expect(exitCodeOf[error.kind]).toBe(2);
  });
});
