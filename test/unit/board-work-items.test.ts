import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardWorkItems } from '../../src/board/work-items.js';
import { exitCodeOf, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import { isSlug } from '../../src/config/primitives.js';
import type { BoardConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { files, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import type { WorkItem } from '../../src/workers/work-items.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { BOARD_PATH, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { HOME, linkAt } from '../helpers/guard-fixture.js';
import { sampleBoard, sampleConfig, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { stripComments } from '../helpers/source-scan.js';

const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);

const NONE: WorkItem = { state: 'known', item: null };
const UNKNOWN: WorkItem = { state: 'unknown' };
const busyWith = (item: string): WorkItem => ({ state: 'known', item });

/** An item that the worker `lane` of the sample board owns. */
const owned = (id: string, lane: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  itemRecord(id, { status, lane, ...extra });

const nodeWith = (items: readonly Record<string, unknown>[], board: BoardConfig = sampleBoard()): Promise<BoardRepo> =>
  boardNode({ board: boardText(items, []), config: sampleConfigWithBoard(board) });

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const ask = async (deps: Deps, ids: readonly string[]): Promise<ReadonlyMap<string, WorkItem>> =>
  valueOf(await boardWorkItems(recipes).itemsOf(deps, HOME, ids));

const answersOf = async (repo: BoardRepo, ids: readonly string[]): Promise<[string, WorkItem][]> => [...(await ask(repo.deps, ids))];

describe('the work item port of the board (TP-43)', () => {
  it('M5-1b TP-43 gives a worker the item in progress that its worker field names, and no item to a worker with no open work', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'doing'),
      owned('B-2', 'beta', 'done'),
      owned('B-3', 'other', 'doing'),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', busyWith('B-1')],
      ['beta', NONE],
      ['gamma', NONE],
    ]);
  });

  it('M5-1b TP-43 names the item in progress before another open item, and keeps a worker with only an open item busy', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'open'),
      owned('B-2', 'alpha', 'doing'),
      owned('B-3', 'beta', 'blocked'),
      owned('B-4', 'beta', 'done'),
      owned('B-5', 'gamma', 'done'),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', busyWith('B-2')],
      ['beta', busyWith('B-3')],
      ['gamma', NONE],
    ]);
  });

  it('M5-1b TP-43 counts a state that the setup does not declare as open work', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'archived')]);
    expect(await answersOf(repo, ['alpha'])).toEqual([['alpha', busyWith('B-1')]]);
  });

  it('M5-1b TP-43 answers for each id that it is asked about, in the order of the ids', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    expect((await answersOf(repo, ['zed', 'alpha'])).map(([id]) => id)).toEqual(['zed', 'alpha']);
  });

  it('M5-1b TP-43 matches the whole worker id and ignores a worker field that is not text', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha-2', 'doing'),
      itemRecord('B-2', { status: 'doing', lane: 7 }),
      itemRecord('B-3', { status: 'doing' }),
    ]);
    expect(await answersOf(repo, ['alpha', 'alpha-2'])).toEqual([
      ['alpha', NONE],
      ['alpha-2', busyWith('B-1')],
    ]);
  });
});

describe('the work item port of the board: no declaration, a missing board or a corrupt board (TP-44)', () => {
  /** The sample block without one key. */
  const without = (key: keyof BoardConfig): BoardConfig =>
    Object.fromEntries(Object.entries(sampleBoard()).filter(([name]) => name !== key)) as BoardConfig;

  it('M5-1b TP-44 gives every worker an unknown item when the setup has no board block', async () => {
    const repo = await boardNode({ board: boardText([owned('B-1', 'alpha', 'doing')], []), config: sampleConfig() });
    expect(await answersOf(repo, ['alpha', 'beta'])).toEqual([
      ['alpha', UNKNOWN],
      ['beta', UNKNOWN],
    ]);
  });

  const lane = sampleBoard().fields?.find((field) => field.name === 'lane');

  it.each([
    ['no states and no roles', { worker_field: 'lane', fields: lane === undefined ? [] : [lane] }],
    ['states and no roles and no worker field', { states: sampleBoard().states }],
    ['no item in progress', without('in_progress')],
    ['no closed state', without('closed')],
    ['no worker field', without('worker_field')],
    ['an empty block', {}],
  ] as const)('M5-1b TP-44 gives every worker an unknown item for %s', async (_name, board) => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing'), owned('B-2', 'beta', 'done')], board);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', UNKNOWN],
      ['beta', UNKNOWN],
      ['gamma', UNKNOWN],
    ]);
  });

  it.each([
    ['a board file that is not there', undefined],
    ['a board file that is not JSON', 'not json'],
    ['a board file with an item that has no status', boardText([{ id: 'B-1', title: 'No status', lane: 'alpha' }], [])],
  ])('M5-1b TP-44 fails the read for %s, so the caller makes every worker unknown', async (_name, text) => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    if (text === undefined) repo.deps.files.delete(BOARD_PATH);
    else repo.deps.seed(BOARD_PATH, text);
    const result = await boardWorkItems(recipes).itemsOf(repo.deps, HOME, ['alpha']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(files.board);
      expect(exitCodeOf[result.error.kind]).toBe(1);
    }
  });

  it('M5-1b TP-44 fails the read for a board file that is a link, with a security stop', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    const result = await boardWorkItems(recipes).itemsOf(linkAt(repo.deps, BOARD_PATH), HOME, ['alpha']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(exitCodeOf[result.error.kind]).toBe(4);
  });

  it('M5-1b TP-44 fails the read when the config is not there', async () => {
    const repo = await nodeWith([]);
    const result = await boardWorkItems(recipes).itemsOf(repo.deps, '/w/nothing', ['alpha']);
    expect(result.ok).toBe(false);
  });
});

describe('the work item port of the board: a stage is display data and never proof (TP-78)', () => {
  const STAGES = ['ticket', 'building', 'review', 'merged', 'released', 'not-in-the-list'];

  const BOARD = (extra: Record<string, unknown>): Record<string, unknown>[] => [
    owned('B-1', 'busy', 'doing', extra),
    owned('B-2', 'quiet', 'done', extra),
    owned('B-3', 'waits', 'open', extra),
  ];

  it.each(STAGES)('M5-1b TP-78 leaves a busy worker busy and an idle worker idle for the stage %s', async (stage) => {
    const plain = await answersOf(await nodeWith(BOARD({})), ['busy', 'quiet', 'waits']);
    const staged = await answersOf(await nodeWith(BOARD({ stage })), ['busy', 'quiet', 'waits']);
    expect(staged).toEqual(plain);
    expect(staged).toEqual([
      ['busy', busyWith('B-1')],
      ['quiet', NONE],
      ['waits', busyWith('B-3')],
    ]);
  });

  it('M5-1b TP-78 does not read the track of an item either', async () => {
    const plain = await answersOf(await nodeWith(BOARD({})), ['busy', 'quiet', 'waits']);
    const tracked = await answersOf(await nodeWith(BOARD({ track: 'core' })), ['busy', 'quiet', 'waits']);
    expect(tracked).toEqual(plain);
  });

  it('M5-1b TP-78 holds no read of the stage key or the track key in the source of the port', () => {
    const source = stripComments(readFileSync(join(__dirname, '..', '..', 'src', 'board', 'work-items.ts'), 'utf8'));
    expect(source).not.toMatch(/\bstage\b/i);
    expect(source).not.toMatch(/\btrack\b/i);
    expect(source).not.toMatch(/boardKeys/);
  });
});

describe('the work item port of the board: it reads with no lock (TP-93)', () => {
  it('M5-1b TP-93 answers while another process holds the state lock, does not wait, and leaves the lock file as it was', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    repo.deps.seed(LOCK_FILE, '4242\n');
    expect(await answersOf(repo, ['alpha'])).toEqual([['alpha', busyWith('B-1')]]);
    expect(repo.deps.files.get(LOCK_FILE)).toBe('4242\n');
    expect(repo.deps.sleeps).toEqual([]);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-93 changes no file and makes no commit', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    const before = JSON.stringify([...repo.deps.files.entries()].sort());
    await ask(repo.deps, ['alpha']);
    expect(JSON.stringify([...repo.deps.files.entries()].sort())).toBe(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('the work item port of the board: a worker id of 40 characters (TP-139)', () => {
  const BASE: ItemOptions = {
    home: HOME,
    words: [],
    title: undefined,
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

  const run = (repo: BoardRepo, change: Partial<ItemOptions>): Promise<CliResult<CommandOutput>> =>
    runItem(repo.deps, { ...BASE, ...change }, recipes);

  /** The longest worker id: a slug of 40 characters. */
  const LONGEST = `w${'0'.repeat(39)}`;

  it('M5-1b TP-139 uses an id that is the longest slug', () => {
    expect(LONGEST).toHaveLength(40);
    expect(isSlug(LONGEST)).toBe(true);
    expect(isSlug(`${LONGEST}0`)).toBe(false);
  });

  it('M5-1b TP-139 stores the id in the worker field, and the port shows the item in progress, not unknown', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    valueOf(await run(repo, { words: ['add'], title: 'Long id', fields: ['priority=P1', `lane=${LONGEST}`] }));
    valueOf(await run(repo, { words: ['move', 'B-1'], state: 'doing' }));
    expect(JSON.parse(repo.textOf(files.board) ?? '{}').items[0].lane).toBe(LONGEST);
    expect(await answersOf(repo, [LONGEST])).toEqual([[LONGEST, busyWith('B-1')]]);
  });

  it('M5-1b TP-139 refuses a worker field value of 41 characters with exit 2 and writes nothing', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const result = await run(repo, { words: ['add'], title: 'Too long', fields: ['priority=P1', `lane=${LONGEST}0`] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(exitCodeOf[result.error.kind]).toBe(2);
      expect(result.error.message).toContain('lane');
    }
    expect(repo.commits).toEqual([]);
  });
});
