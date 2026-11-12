import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import type { Deps } from '../../src/core/deps.js';
import { files as fileNames, followPollMs, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { BOARD_PATH, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import type { FakeDeps } from '../helpers/fake-deps.js';
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
  follow: false,
  ref: undefined,
  project: undefined,
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

  it('M5-1b TP-91 cleans a title and a stage that hold a line break or a bidi mark', async () => {
    const items = [itemRecord('B-1', { track: 'core', title: `Two\nlines${BIDI} here`, stage: `re\nview${BIDI}` })];
    const repo = await boardNode({ board: boardText(items, [track('core', 'Core', true)]) });
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

describe('item list --follow', () => {
  const ESCAPE = String.fromCharCode(27);
  const CONTROL_SEQUENCES = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, 'g');
  const withoutControl = (text: string): string => text.replace(CONTROL_SEQUENCES, '');
  const writeFailure = (code: string): CliResult<void> => failure(`cannot write to the output: ${code}`);

  /** A frame is a write of text lines. The write that only checks the reader holds no line. */
  const framesOf = (deps: FakeDeps): string[] => deps.written.filter((text) => text.includes('\n')).map(withoutControl);

  interface Followed {
    readonly result: CliResult<CommandOutput>;
    readonly deps: FakeDeps;
    /** The reads of the status of the board file, in all. The read of the text makes some of them too. */
    readonly stats: number;
    /** The value of `stats` at the end of each wait, before the tick does anything. */
    readonly statsAtWait: readonly number[];
    /** The reads of the text of the board file, in all. One draw of the list makes more than one. */
    readonly reads: number;
    /** The value of `reads` at the end of each wait, before the tick does anything. */
    readonly readsAtWait: readonly number[];
  }

  interface Drive {
    /** Runs after each wait of the loop. `waits` is the number of waits so far, from 1. */
    readonly afterWait?: (waits: number) => void;
    /** Change the deps that the command gets. */
    readonly wrap?: (deps: FakeDeps) => Deps;
    readonly options?: Partial<ItemOptions>;
    /** A person reads a terminal. Default: true. */
    readonly terminal?: boolean;
  }

  /** Run the follow loop on the fake clock: a wait moves the clock, and no wait takes real time. */
  const follow = async (repo: BoardRepo, drive: Drive = {}): Promise<Followed> => {
    const base = repo.deps;
    base.setStdoutTerminal(drive.terminal ?? true);
    let stats = 0;
    let reads = 0;
    let waits = 0;
    const statsAtWait: number[] = [];
    const readsAtWait: number[] = [];
    const watched: FakeDeps = {
      ...base,
      fs: {
        ...base.fs,
        statInfo: async (path) => {
          if (path === BOARD_PATH) stats += 1;
          return base.fs.statInfo(path);
        },
        readTextLimited: async (path, maxBytes, decode) => {
          if (path === BOARD_PATH) reads += 1;
          return base.fs.readTextLimited(path, maxBytes, decode);
        },
      },
      sleep: async (ms) => {
        await base.sleep(ms);
        waits += 1;
        statsAtWait.push(stats);
        readsAtWait.push(reads);
        drive.afterWait?.(waits);
      },
    };
    const result = await runItem((drive.wrap ?? ((deps) => deps))(watched), { ...BASE, follow: true, ...drive.options }, recipes);
    return { result, deps: base, stats, statsAtWait, reads, readsAtWait };
  };

  const endAt = (repo: BoardRepo, waits: number, signal: NodeJS.Signals = 'SIGTERM') => (count: number): void => {
    if (count === waits) repo.deps.signals.emit(signal);
  };

  const BOARD = boardText([itemRecord('B-1', { track: 'core', stage: 'building' })], CORE);
  const MORE = boardText([itemRecord('B-1', { track: 'core', stage: 'building' }), itemRecord('B-2', { track: 'docs', stage: 'ticket' })], CORE);

  describe('the end (TP-56)', () => {
    it.each<NodeJS.Signals>(['SIGHUP', 'SIGTERM'])('M5-1b TP-56 ends with no error on %s, takes no more wait, and removes its signal handlers', async (signal) => {
      const repo = await boardNode({ board: BOARD });
      const during: number[] = [];
      const run = await follow(repo, {
        afterWait: (waits) => {
          during.push(repo.deps.signals.listenerCount('SIGHUP'), repo.deps.signals.listenerCount('SIGTERM'));
          endAt(repo, 2, signal)(waits);
        },
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(2);
      expect(during).toEqual([1, 1, 1, 1]);
      expect(repo.deps.signals.listenerCount('SIGHUP')).toBe(0);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('M5-1b TP-56 ends at once on a signal that comes while the loop waits, with no wait to run out', async () => {
      const repo = await boardNode({ board: BOARD });
      setImmediate(() => repo.deps.signals.emit('SIGTERM'));
      const run = await follow(repo, { wrap: (deps) => ({ ...deps, sleep: () => new Promise<void>(() => undefined) }) });
      expect(run.result.ok).toBe(true);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it.each(['EPIPE', 'EIO'])('M5-1b TP-56 ends with no error on a failed write of a frame with %s', async (code) => {
      const repo = await boardNode({ board: BOARD });
      let writes = 0;
      const run = await follow(repo, {
        // The board changes at the first wait, so the second frame is the write that fails. The write that checks the reader is before it.
        afterWait: (waits) => {
          if (waits === 1) repo.deps.seed(BOARD_PATH, MORE);
        },
        wrap: (deps) => ({
          ...deps,
          writeStdout: async (text) => {
            writes += 1;
            return text.includes('\n') && writes > 1 ? writeFailure(code) : deps.writeStdout(text);
          },
        }),
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(1);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('M5-1b TP-56 keeps running on a board fault, shows the fault and the file, and draws the board when it is mended', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, {
        afterWait: (waits) => {
          if (waits === 1) repo.deps.seed(BOARD_PATH, 'not json');
          if (waits === 2) repo.deps.seed(BOARD_PATH, MORE);
          endAt(repo, 3)(waits);
        },
      });
      expect(run.result.ok).toBe(true);
      const frames = framesOf(run.deps);
      expect(frames).toHaveLength(3);
      expect(frames[0]).toContain('1 item in 2 tracks');
      expect(frames[1]).toContain(fileNames.board);
      expect(frames[1]).not.toContain('items in');
      expect(frames[2]).toContain('2 items in 2 tracks');
    });

    it('M5-1b TP-56 keeps running when the board file is not there, and draws it when it comes back', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, {
        afterWait: (waits) => {
          if (waits === 1) repo.deps.files.delete(BOARD_PATH);
          if (waits === 2) repo.deps.seed(BOARD_PATH, MORE);
          endAt(repo, 3)(waits);
        },
      });
      expect(run.result.ok).toBe(true);
      const frames = framesOf(run.deps);
      expect(frames[1]).toContain(fileNames.board);
      expect(frames[2]).toContain('2 items in 2 tracks');
    });
  });

  describe('the poll (TP-65)', () => {
    it('M5-1b TP-65 waits the named poll time of 2 seconds between its ticks', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { afterWait: endAt(repo, 4) });
      expect(followPollMs).toBe(2000);
      expect(run.deps.sleeps).toEqual([followPollMs, followPollMs, followPollMs, followPollMs]);
    });

    it('M5-1b TP-65 keeps no promise that gains one more reaction at each tick, over 1000 ticks that end on a signal', async () => {
      const repo = await boardNode({ board: BOARD });
      // A promise that the loop waits on at every tick keeps one reaction for each tick, and the memory grows for the whole session.
      const reactions = new Map<object, number>();
      const original = Promise.prototype.then;
      Promise.prototype.then = function (this: Promise<unknown>, ...args: Parameters<typeof original>) {
        reactions.set(this, (reactions.get(this) ?? 0) + 1);
        return original.apply(this, args);
      } as typeof original;
      const run = await follow(repo, { afterWait: endAt(repo, 1000) }).finally(() => {
        Promise.prototype.then = original;
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(1000);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
      const most = [...reactions.values()].reduce((largest, count) => Math.max(largest, count), 0);
      expect(most).toBeLessThanOrEqual(4);
    });

    it('M5-1b TP-65 reads the status of the file at each tick, and rereads it only after a change of the time or the size', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, {
        afterWait: (waits) => {
          if (waits === 3) repo.deps.files.set(BOARD_PATH, MORE);
          if (waits === 5) repo.deps.mtimes.set(BOARD_PATH, 1234);
          endAt(repo, 7)(waits);
        },
      });
      // Every tick but the last one read the status. The last tick got the signal first.
      expect(run.statsAtWait).toHaveLength(7);
      expect(run.statsAtWait.every((count, at) => at === 0 || count > (run.statsAtWait[at - 1] ?? 0))).toBe(true);
      expect(run.stats).toBe(run.statsAtWait[6]);
      // The text was read for frame 1, for the change of the size (tick 3) and for the change of the time (tick 5). The other ticks read none.
      const perDraw = run.readsAtWait[0] ?? 0;
      expect(perDraw).toBeGreaterThan(0);
      expect([...run.readsAtWait, run.reads]).toEqual([1, 1, 1, 2, 2, 3, 3, 3].map((draws) => draws * perDraw));
      const frames = framesOf(run.deps);
      expect(frames).toHaveLength(3);
      expect(frames[1]).toContain('2 items in 2 tracks');
      expect(frames[2]).toBe(frames[1]);
    });

    it('M5-1b TP-65 draws no frame at a tick with no change', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { afterWait: endAt(repo, 3) });
      expect(framesOf(run.deps)).toHaveLength(1);
      expect(run.reads).toBe(run.readsAtWait[0]);
    });

    it('M5-1b TP-65 keeps the cap of 20 lines on each redraw, for the board and for one track', async () => {
      const items = Array.from({ length: 25 }, (_, at) => itemRecord(`B-${at + 1}`, { track: 'track1', stage: 'ticket' }));
      const big = boardText(items, tracksOf(25));
      for (const options of [{}, { track: 'track1' }]) {
        const repo = await boardNode({ board: boardText([itemRecord('B-1', { track: 'track1', stage: 'ticket' })], tracksOf(25)) });
        const run = await follow(repo, {
          options,
          afterWait: (waits) => {
            if (waits === 1) repo.deps.seed(BOARD_PATH, big);
            endAt(repo, 2)(waits);
          },
        });
        const frames = framesOf(run.deps);
        expect(frames).toHaveLength(2);
        for (const frame of frames) expectShortOutput(frame);
      }
    });

    it('M5-1b TP-65 draws the same lines as item list, with the cursor sequences around them on a terminal', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { afterWait: endAt(repo, 1) });
      expect(framesOf(run.deps)[0]).toBe(plainText(valueOf(await list(repo))));
      const [first = ''] = repo.deps.written;
      expect(first.startsWith(`${ESCAPE}[H`)).toBe(true);
      expect(first.endsWith(`${ESCAPE}[J`)).toBe(true);
    });
  });

  describe('the reader goes (TP-102)', () => {
    it('M5-1b TP-102 ends at the first tick after the parent process changes, and makes no poll after it', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, {
        afterWait: (waits) => {
          if (waits === 2) repo.deps.setParentPid(1);
        },
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(2);
      // The first tick read the status. The tick of the change read nothing.
      expect(run.statsAtWait[1]).toBeGreaterThan(run.statsAtWait[0] ?? 0);
      expect(run.stats).toBe(run.statsAtWait[1]);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('M5-1b TP-102 ends at the first tick after stdout stops being a terminal, and makes no poll after it', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, {
        afterWait: (waits) => {
          if (waits === 2) repo.deps.setStdoutTerminal(false);
        },
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(2);
      expect(run.stats).toBe(run.statsAtWait[1]);
    });

    it.each(['EPIPE', 'EIO', 'ENOSPC'])('M5-1b TP-102 ends at the first tick after a write fails with %s, with no board change, and makes no poll after it', async (code) => {
      const repo = await boardNode({ board: BOARD });
      let writes = 0;
      const run = await follow(repo, {
        wrap: (deps) => ({
          ...deps,
          // Write 1 is the frame, write 2 is the check of the first tick, write 3 is the check of the second tick.
          writeStdout: async (text) => {
            writes += 1;
            return writes === 3 ? writeFailure(code) : deps.writeStdout(text);
          },
        }),
      });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toHaveLength(2);
      expect(run.stats).toBe(run.statsAtWait[1]);
      expect(run.reads).toBe(run.readsAtWait[0]);
    });

    it('M5-1b TP-102 draws one frame for a stdout that is not a terminal, and ends at once with no wait', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { terminal: false });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toEqual([]);
      expect(run.deps.written).toEqual([plainText(valueOf(await list(repo)))]);
      expect(repo.deps.signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('M5-1b TP-102 ends with no frame when the first write fails', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { wrap: (deps) => ({ ...deps, writeStdout: async () => writeFailure('EPIPE') }) });
      expect(run.result.ok).toBe(true);
      expect(run.deps.sleeps).toEqual([]);
    });
  });

  describe('the flags', () => {
    it('M5-1b TP-56 shows the items of one track with --track, and the closed items with --all', async () => {
      const repo = await boardNode({ board: boardText([itemRecord('B-1', { track: 'core' }), itemRecord('B-2', { track: 'core', status: 'done' })], CORE) });
      const run = await follow(repo, { options: { track: 'core', all: true }, terminal: false });
      expect(run.deps.written[0]).toContain('B-2');
      expect(run.deps.written[0]).toContain('Track core: Core');
    });

    it('M5-1b TP-56 exits 2 for an unknown track and draws no frame', async () => {
      const repo = await boardNode({ board: BOARD });
      const run = await follow(repo, { options: { track: 'nope' } });
      expect(exitCodeOf[errorOf(run.result).kind]).toBe(2);
      expect(run.deps.written).toEqual([]);
    });
  });
});
