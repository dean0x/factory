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
import { boardKeys, files, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import type { WorkItem, WorkItemDisplay } from '../../src/workers/work-items.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { BOARD_PATH, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { HOME, linkAt } from '../helpers/guard-fixture.js';
import { countReadsOf } from '../helpers/read-count.js';
import { sampleBoard, sampleConfig, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { stripComments } from '../helpers/source-scan.js';
import { busyWith, knownItem, NONE, sampleDisplay, UNKNOWN } from '../helpers/work-item.js';

const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);

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

describe('the work item port of the board', () => {
  it('gives a worker the item in progress that its worker field names, and no item to a worker with no open work', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'doing'),
      owned('B-2', 'beta', 'done'),
      owned('B-3', 'other', 'doing'),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', knownItem('B-1', { display: sampleDisplay('B-1', 'doing') })],
      ['beta', knownItem(null, { closed: ['B-2'] })],
      ['gamma', NONE],
    ]);
  });

  it('names the item in progress before another open item, and keeps a worker with only an open item busy', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'open'),
      owned('B-2', 'alpha', 'doing'),
      owned('B-3', 'beta', 'blocked'),
      owned('B-4', 'beta', 'done'),
      owned('B-5', 'gamma', 'done'),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', knownItem('B-2', { display: sampleDisplay('B-2', 'doing') })],
      ['beta', knownItem('B-3', { closed: ['B-4'], display: sampleDisplay('B-3', 'blocked') })],
      ['gamma', knownItem(null, { closed: ['B-5'] })],
    ]);
  });

  it('counts a state that the setup does not declare as open work', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'archived')]);
    expect(await answersOf(repo, ['alpha'])).toEqual([['alpha', knownItem('B-1', { display: sampleDisplay('B-1', 'archived') })]]);
  });

  it('answers for each id that it is asked about, in the order of the ids', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    expect((await answersOf(repo, ['zed', 'alpha'])).map(([id]) => id)).toEqual(['zed', 'alpha']);
  });

  it('matches the whole worker id and ignores a worker field that is not text', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha-2', 'doing'),
      itemRecord('B-2', { status: 'doing', lane: 7 }),
      itemRecord('B-3', { status: 'doing' }),
    ]);
    expect(await answersOf(repo, ['alpha', 'alpha-2'])).toEqual([
      ['alpha', NONE],
      ['alpha-2', knownItem('B-1', { display: sampleDisplay('B-1', 'doing') })],
    ]);
  });
});

describe('the work item port of the board: no declaration, a missing board or a corrupt board', () => {
  /** The sample block without one key. */
  const without = (key: keyof BoardConfig): BoardConfig =>
    Object.fromEntries(Object.entries(sampleBoard()).filter(([name]) => name !== key)) as BoardConfig;

  it('gives every worker an unknown item when the setup has no board block', async () => {
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
  ] as const)('gives every worker an unknown item for %s', async (_name, board) => {
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
  ])('fails the read for %s, so the caller makes every worker unknown', async (_name, text) => {
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

  it('fails the read for a board file that is a link, with a security stop', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    const result = await boardWorkItems(recipes).itemsOf(linkAt(repo.deps, BOARD_PATH), HOME, ['alpha']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(exitCodeOf[result.error.kind]).toBe(4);
  });

  it('fails the read when the config is not there', async () => {
    const repo = await nodeWith([]);
    const result = await boardWorkItems(recipes).itemsOf(repo.deps, '/w/nothing', ['alpha']);
    expect(result.ok).toBe(false);
  });
});

describe('the work item port of the board: a stage is display data and never proof', () => {
  const STAGES = ['ticket', 'building', 'review', 'merged', 'released', 'not-in-the-list'];

  const BOARD = (extra: Record<string, unknown>): Record<string, unknown>[] => [
    owned('B-1', 'busy', 'doing', extra),
    owned('B-2', 'quiet', 'done', extra),
    owned('B-3', 'waits', 'open', extra),
  ];

  /** The answers as the evidence alone: the display data is left out, because a stage shows there and nowhere else. */
  const evidenceOnly = (answers: readonly (readonly [string, WorkItem])[]): [string, WorkItem][] =>
    answers.map(([id, work]) => [
      id,
      work.state === 'known' ? knownItem(work.item, { closed: work.closed, parked: work.parked, mergedPrHeads: work.mergedPrHeads }) : work,
    ]);

  it.each(STAGES)('leaves the evidence of a busy worker and of an idle worker as it was for the stage %s', async (stage) => {
    const plain = await answersOf(await nodeWith(BOARD({})), ['busy', 'quiet', 'waits']);
    const staged = await answersOf(await nodeWith(BOARD({ stage })), ['busy', 'quiet', 'waits']);
    expect(evidenceOnly(staged)).toEqual(evidenceOnly(plain));
    expect(evidenceOnly(staged)).toEqual([
      ['busy', busyWith('B-1')],
      ['quiet', knownItem(null, { closed: ['B-2'] })],
      ['waits', busyWith('B-3')],
    ]);
    expect(staged).toEqual([
      ['busy', knownItem('B-1', { display: sampleDisplay('B-1', 'doing', { stage }) })],
      ['quiet', knownItem(null, { closed: ['B-2'] })],
      ['waits', knownItem('B-3', { display: sampleDisplay('B-3', 'open', { stage }) })],
    ]);
  });

  it('does not read the track of an item either', async () => {
    const plain = await answersOf(await nodeWith(BOARD({})), ['busy', 'quiet', 'waits']);
    const tracked = await answersOf(await nodeWith(BOARD({ track: 'core' })), ['busy', 'quiet', 'waits']);
    expect(tracked).toEqual(plain);
  });

  it('holds no read of the stage key or the track key in the source of the port', () => {
    const source = stripComments(readFileSync(join(__dirname, '..', '..', 'src', 'board', 'work-items.ts'), 'utf8'));
    expect(source).not.toMatch(/\bstage\b/i);
    expect(source).not.toMatch(/\btrack\b/i);
    expect(source).not.toMatch(/boardKeys\.(stage|track)\b/);
  });
});

describe('the work item port of the board: the display data of the item in progress', () => {
  const STAGE_TIME = '2030-01-02T10:11:12.345Z';
  const STAGED = { stage: 'building', [boardKeys.stageAt]: STAGE_TIME };
  /** The display data and nothing else of the work of a worker, or undefined when the work has none. */
  const displayIn = async (repo: BoardRepo, id: string): Promise<WorkItemDisplay | undefined> => {
    const work = (await ask(repo.deps, [id])).get(id);
    return work?.state === 'known' ? work.display : undefined;
  };

  it('gives the title, the stage, the time of the stage and the status of the open item in a nested display object', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing', STAGED)]);
    expect(await answersOf(repo, ['alpha'])).toEqual([
      ['alpha', knownItem('B-1', { display: { title: 'Item B-1', stage: 'building', stageAt: STAGE_TIME, status: 'doing' } })],
    ]);
  });

  it('shows the item that the port names: the item in progress before another open item', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'open', STAGED), owned('B-2', 'alpha', 'doing', { stage: 'review' })]);
    expect(await displayIn(repo, 'alpha')).toEqual(sampleDisplay('B-2', 'doing', { stage: 'review' }));
  });

  it('shows a state that the setup does not declare as the status of the item', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'archived')]);
    expect(await displayIn(repo, 'alpha')).toEqual(sampleDisplay('B-1', 'archived'));
  });

  it('gives no display key to a worker with no open item, to a worker that no item names, or to an unknown worker', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'done', STAGED)]);
    const known = await ask(repo.deps, ['alpha', 'gamma']);
    expect(known.get('alpha')).not.toHaveProperty('display');
    expect(known.get('gamma')).not.toHaveProperty('display');
    const unknown = await boardNode({ board: boardText([owned('B-1', 'alpha', 'doing')], []), config: sampleConfig() });
    expect((await ask(unknown.deps, ['alpha'])).get('alpha')).not.toHaveProperty('display');
  });

  it('shows no stage and no stage time for an item that stores neither, with no migration of the board file', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    expect(await displayIn(repo, 'alpha')).toEqual({ title: 'Item B-1', stage: null, stageAt: null, status: 'doing' });
  });

  it('shows a stage that has no stage time with a stage time of null', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing', { stage: 'building' })]);
    expect(await displayIn(repo, 'alpha')).toEqual(sampleDisplay('B-1', 'doing', { stage: 'building' }));
  });

  it.each<[string, unknown]>([
    ['a date only', '2030-01-02'],
    ['a time with an offset', '2030-01-02T10:11:12.345+00:00'],
    ['a time with no milliseconds', '2030-01-02T10:11:12Z'],
    ['text that is no time', 'x'.repeat(24)],
    ['a time that does not exist', '2030-02-31T10:11:12.345Z'],
    ['a number', 1893579072345],
    ['a list', [STAGE_TIME]],
    ['an empty text', ''],
  ])('reads the stored stage time as null for %s, and the list still answers', async (_name, stored) => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing', { stage: 'building', [boardKeys.stageAt]: stored })]);
    expect(await displayIn(repo, 'alpha')).toEqual(sampleDisplay('B-1', 'doing', { stage: 'building' }));
  });

  it('comes from the one read of the board file that gives the evidence', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing', STAGED)]);
    const counted = countReadsOf(repo.deps, BOARD_PATH);
    await ask(counted.deps, ['alpha', 'beta']);
    expect(counted.count()).toBe(1);
  });
});

describe('the work item port of the board: the evidence of closed and parked work', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);

  it('lists the closed items whose worker field holds the id, in the order of the board, and not an open item', async () => {
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'done'),
      owned('B-2', 'alpha', 'doing'),
      owned('B-3', 'beta', 'done'),
      owned('B-4', 'alpha', 'done'),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta'])).toEqual([
      ['alpha', knownItem('B-2', { closed: ['B-1', 'B-4'], display: sampleDisplay('B-2', 'doing') })],
      ['beta', knownItem(null, { closed: ['B-3'] })],
    ]);
  });

  it('lists the items that are not closed and carry the unassign mark of the worker as parked, and no closed item', async () => {
    const mark = (...ids: readonly string[]): Record<string, unknown> => ({ [boardKeys.unassignedFrom]: ids });
    const repo = await nodeWith([
      itemRecord('B-1', { status: 'open', ...mark('alpha', 'beta') }),
      owned('B-2', 'beta', 'done', mark('alpha')),
      owned('B-3', 'gamma', 'doing', mark('beta')),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta', 'gamma'])).toEqual([
      ['alpha', knownItem(null, { parked: ['B-1'] })],
      ['beta', knownItem(null, { parked: ['B-1', 'B-3'], closed: ['B-2'] })],
      ['gamma', knownItem('B-3', { display: sampleDisplay('B-3', 'doing') })],
    ]);
  });

  it('fills the parked list from a mark that is a list, and from its text entries only', async () => {
    const repo = await nodeWith([
      itemRecord('B-1', { [boardKeys.unassignedFrom]: 'alpha' }),
      itemRecord('B-2', { [boardKeys.unassignedFrom]: [7, null, 'alpha', { id: 'alpha' }] }),
      itemRecord('B-3', { [boardKeys.unassignedFrom]: { alpha: true } }),
      itemRecord('B-4', { [boardKeys.unassignedFrom]: ['alpha-2'] }),
    ]);
    expect(await answersOf(repo, ['alpha'])).toEqual([['alpha', knownItem(null, { parked: ['B-2'] })]]);
  });

  it('lists the recorded heads of the closed items of the worker, and only those that are a full commit id', async () => {
    const head = (value: unknown): Record<string, unknown> => ({ [boardKeys.mergedPrHead]: value });
    const repo = await nodeWith([
      owned('B-1', 'alpha', 'done', head(HEAD_A)),
      owned('B-2', 'alpha', 'done', head('not-a-commit')),
      owned('B-3', 'alpha', 'done', head(7)),
      owned('B-4', 'alpha', 'doing', head(HEAD_B)),
      owned('B-5', 'beta', 'done', head(HEAD_B)),
      owned('B-6', 'alpha', 'done'),
      owned('B-7', 'alpha', 'done', head(HEAD_A.toUpperCase())),
    ]);
    expect(await answersOf(repo, ['alpha', 'beta'])).toEqual([
      [
        'alpha',
        knownItem('B-4', { closed: ['B-1', 'B-2', 'B-3', 'B-6', 'B-7'], mergedPrHeads: [HEAD_A], display: sampleDisplay('B-4', 'doing') }),
      ],
      ['beta', knownItem(null, { closed: ['B-5'], mergedPrHeads: [HEAD_B] })],
    ]);
  });

  it('gives a worker that no item names an empty list of each kind', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'done', { [boardKeys.mergedPrHead]: HEAD_A })]);
    expect(await answersOf(repo, ['gamma'])).toEqual([['gamma', NONE]]);
  });
});

describe('the work item port of the board: it reads with no lock', () => {
  it('answers while another process holds the state lock, does not wait, and leaves the lock file as it was', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    repo.deps.seed(LOCK_FILE, '4242\n');
    expect(await answersOf(repo, ['alpha'])).toEqual([['alpha', knownItem('B-1', { display: sampleDisplay('B-1', 'doing') })]]);
    expect(repo.deps.files.get(LOCK_FILE)).toBe('4242\n');
    expect(repo.deps.sleeps).toEqual([]);
    expect(repo.commits).toEqual([]);
  });

  it('changes no file and makes no commit', async () => {
    const repo = await nodeWith([owned('B-1', 'alpha', 'doing')]);
    const before = JSON.stringify([...repo.deps.files.entries()].sort());
    await ask(repo.deps, ['alpha']);
    expect(JSON.stringify([...repo.deps.files.entries()].sort())).toBe(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('the work item port of the board: a worker id of 40 characters', () => {
  const BASE: ItemOptions = {
    home: HOME,
    words: [],
    title: undefined,
    text: undefined,
    track: undefined,
    epic: undefined,
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

  it('uses an id that is the longest slug', () => {
    expect(LONGEST).toHaveLength(40);
    expect(isSlug(LONGEST)).toBe(true);
    expect(isSlug(`${LONGEST}0`)).toBe(false);
  });

  it('stores the id in the worker field, and the port shows the item in progress, not unknown', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    valueOf(await run(repo, { words: ['add'], title: 'Long id', fields: ['priority=P1', `lane=${LONGEST}`] }));
    valueOf(await run(repo, { words: ['move', 'B-1'], state: 'doing' }));
    expect(JSON.parse(repo.textOf(files.board) ?? '{}').items[0].lane).toBe(LONGEST);
    expect(await answersOf(repo, [LONGEST])).toEqual([[LONGEST, expect.objectContaining(busyWith('B-1'))]]);
  });

  it('refuses a worker field value of 41 characters with exit 2 and writes nothing', async () => {
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
