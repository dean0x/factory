import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardConnector, DecisionAskInput, ItemAddInput } from '../../src/board/contract.js';
import { resolveFields, declaredFields } from '../../src/board/fields.js';
import { parseBoard, parseDecisionLog, parseWaiting, readBoard, readDecisionLog, readWaiting } from '../../src/board/files.js';
import { boardJsonText } from '../../src/board/json.js';
import { createLocalBoard, type LocalBoardOptions } from '../../src/board/local.js';
import { firstStageOf, requireSettableStage, requireStage, stageShown, stagesOf, UNLISTED_MARK } from '../../src/board/stages.js';
import { trackIdIssue, trackNameIssue, tracksOf } from '../../src/board/tracks.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { commands, commandText, files as fileNames, stateLock, values } from '../../src/names.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { layoutOf } from '../../src/state/layout.js';
import { describeBoardContract } from '../contract/board-contract.js';
import { boardRepo, type BoardRepo } from '../helpers/board-repo.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { linkAt } from '../helpers/guard-fixture.js';
import { publishBoard } from '../helpers/publish-recipe.js';
import { sampleBoard } from '../helpers/sample-config.js';

const HOME = '/h/node';
const LAYOUT = layoutOf(HOME);
const BOARD_PATH = join(LAYOUT.stateDir, fileNames.board);
const WAITING_PATH = join(LAYOUT.stateDir, fileNames.waiting);
const LOG_PATH = join(LAYOUT.stateDir, fileNames.decisionLog);
const QUEUE = 'merge';

const jsonOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const item = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, title: `Item ${id}`, status: 'open', ...extra });

const boardOf = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ [QUEUE]: [], items: [item('B-1')], ...changes });

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const exitOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

describe('the board file: the keys and their order', () => {
  it('M5-1b TP-23 keeps the unknown keys of an item, and the order of the keys of the board and of the item', () => {
    const text = jsonOf({ tracks: [], items: [item('B-1', { zeta: 1, alpha: { k: [1, 2] } })], [QUEUE]: [] });
    const doc = valueOf(parseBoard(text, QUEUE));
    expect(Object.keys(doc.top)).toEqual(['tracks', 'items', QUEUE]);
    expect(Object.keys(doc.items[0]?.record ?? {})).toEqual(['id', 'title', 'status', 'zeta', 'alpha']);
    expect(doc.items[0]?.record['alpha']).toEqual({ k: [1, 2] });
  });

  it('M5-1b TP-24 refuses a top key that is not the queue key, items or tracks, and names the file and the key', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ extra: 1 })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('extra');
  });

  it('M5-1b TP-24 accepts the optional tracks key, and a board without it', () => {
    expect(parseBoard(jsonOf(boardOf({ tracks: [] })), QUEUE).ok).toBe(true);
    expect(parseBoard(jsonOf(boardOf()), QUEUE).ok).toBe(true);
  });

  it('M5-1b TP-24 refuses a board with no queue key, no items key or no JSON object, and names the file', () => {
    for (const text of [jsonOf({ items: [] }), jsonOf({ [QUEUE]: [] }), jsonOf([]), 'not json', jsonOf({ [QUEUE]: {}, items: [] })]) {
      const result = parseBoard(text, QUEUE);
      expect(exitOf(result), text).toBe(1);
      expect(errorOf(result).message, text).toContain(fileNames.board);
    }
  });

  it('M5-1b TP-57 stops a board that still has the old queue key with exit 1 and the remedy to upgrade', () => {
    const error = errorOf(parseBoard(jsonOf({ queue: [], items: [] }), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.hint).toContain(commandText(commands.upgrade));
  });

  it('M5-1b TP-57 takes the default key as the key of the board when the recipe gives that key', () => {
    expect(parseBoard(jsonOf({ queue: [], items: [] }), 'queue').ok).toBe(true);
  });
});

describe('the items of the board file', () => {
  it('M5-1b TP-24 refuses an item with no title, no state or an id that is not of the form B-n, and names the file', () => {
    const bad = [
      { id: 'B-1', status: 'open' },
      { id: 'B-1', title: 'T' },
      { id: 'b-1', title: 'T', status: 'open' },
      { id: 'B-', title: 'T', status: 'open' },
      { id: 'B-1234567890', title: 'T', status: 'open' },
      { id: 'B-1', title: '', status: 'open' },
      { id: 'B-1', title: 5, status: 'open' },
      'B-1',
    ];
    for (const entry of bad) {
      const result = parseBoard(jsonOf(boardOf({ items: [entry] })), QUEUE);
      expect(exitOf(result), JSON.stringify(entry)).toBe(1);
      expect(errorOf(result).message, JSON.stringify(entry)).toContain(fileNames.board);
    }
  });

  it('M5-1b TP-24 refuses a track or a stage that is not text', () => {
    for (const extra of [{ track: 3 }, { stage: ['a'] }]) {
      expect(exitOf(parseBoard(jsonOf(boardOf({ items: [item('B-1', extra)] })), QUEUE))).toBe(1);
    }
  });

  it('M5-1b TP-23 reads the track and the stage of an item, and null when they are not there', () => {
    const doc = valueOf(parseBoard(jsonOf(boardOf({ items: [item('B-1', { track: 'a', stage: 'building' }), item('B-2')] })), QUEUE));
    expect(doc.items.map(({ id, track, stage }) => [id, track, stage])).toEqual([
      ['B-1', 'a', 'building'],
      ['B-2', null, null],
    ]);
  });

  it('M5-1b TP-88 stops a board with a repeated item id, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ items: [item('B-1'), item('B-2'), item('B-2')] })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('B-2');
  });

  it('M5-1b TP-24 refuses a queue that is not a list of objects', () => {
    expect(exitOf(parseBoard(jsonOf(boardOf({ [QUEUE]: [1] })), QUEUE))).toBe(1);
  });
});

describe('the tracks of the board file', () => {
  const trackOf = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'core', name: 'Core', roadmap: true, ...changes });

  it('M5-1b TP-70 reads an absent tracks key as an empty list', () => {
    expect(valueOf(parseBoard(jsonOf(boardOf()), QUEUE)).tracks).toEqual([]);
  });

  it('M5-1b TP-71 reads the tracks, and keeps their order', () => {
    const doc = valueOf(parseBoard(jsonOf(boardOf({ tracks: [trackOf(), trackOf({ id: 'agent-cost', name: 'Agent cost', roadmap: false })] })), QUEUE));
    expect(doc.tracks).toEqual([
      { id: 'core', name: 'Core', roadmap: true },
      { id: 'agent-cost', name: 'Agent cost', roadmap: false },
    ]);
  });

  it('M5-1b TP-71 stops a tracks value that is not a list with exit 1, and names the file', () => {
    for (const tracks of [{}, 'core', 3, null, { id: 'core' }]) {
      const result = parseBoard(jsonOf(boardOf({ tracks })), QUEUE);
      expect(exitOf(result), JSON.stringify(tracks)).toBe(1);
      expect(errorOf(result).message, JSON.stringify(tracks)).toContain(fileNames.board);
    }
  });

  it('M5-1b TP-71 stops a track with a bad id, name or roadmap value with exit 1, and names the file', () => {
    const bad = [
      trackOf({ id: 'Core' }),
      trackOf({ id: '1core' }),
      trackOf({ id: '-core' }),
      trackOf({ id: 'a'.repeat(33) }),
      trackOf({ id: '' }),
      trackOf({ id: 7 }),
      trackOf({ name: '' }),
      trackOf({ name: 'a\nb' }),
      trackOf({ name: 'a'.repeat(61) }),
      trackOf({ name: 9 }),
      trackOf({ roadmap: 'yes' }),
      trackOf({ roadmap: 1 }),
      { id: 'core', name: 'Core' },
      'core',
    ];
    for (const entry of bad) {
      const result = parseBoard(jsonOf(boardOf({ tracks: [entry] })), QUEUE);
      expect(exitOf(result), JSON.stringify(entry)).toBe(1);
      expect(errorOf(result).message, JSON.stringify(entry)).toContain(fileNames.board);
    }
  });

  it('M5-1b TP-71 keeps a key of a track that the core does not own', () => {
    expect(parseBoard(jsonOf(boardOf({ tracks: [trackOf({ owner: 'x' })] })), QUEUE).ok).toBe(true);
  });

  it('M5-1b TP-88 stops a board with a repeated track id, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ tracks: [trackOf(), trackOf({ name: 'Other' })] })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('core');
  });

  it('M5-1b TP-80 takes a track id of 32 characters and not one of 33, and a name of 60 characters and not one of 61', () => {
    expect(trackIdIssue('a'.repeat(32))).toBeNull();
    expect(trackIdIssue('a'.repeat(33))).not.toBeNull();
    expect(trackIdIssue('a-1')).toBeNull();
    expect(trackIdIssue('A')).not.toBeNull();
    expect(trackNameIssue('n'.repeat(60))).toBeNull();
    expect(trackNameIssue('n'.repeat(61))).not.toBeNull();
    expect(trackNameIssue('one\rline')).not.toBeNull();
    expect(trackNameIssue('Agent cost')).toBeNull();
  });

  it('M5-1b TP-71 reads the tracks of a top object that has no tracks key as an empty list', () => {
    expect(valueOf(tracksOf({}))).toEqual([]);
  });
});

describe('the waiting file and the decision log', () => {
  const waiting = (items: readonly unknown[], extra: Record<string, unknown> = {}): string =>
    jsonOf({ intro: '', groups: [], items, ...extra });

  it('M5-1b TP-23 reads the waiting items with their ids, and keeps the stored keys', () => {
    const doc = valueOf(parseWaiting(waiting([{ id: 'D-1', title: 'T', zeta: 1 }, { id: 'D-2' }])));
    expect(doc.items.map((entry) => entry.id)).toEqual(['D-1', 'D-2']);
    expect(Object.keys(doc.items[0]?.record ?? {})).toEqual(['id', 'title', 'zeta']);
    expect(Object.keys(doc.top)).toEqual(['intro', 'groups', 'items']);
  });

  it('M5-1b TP-24 refuses a waiting file with another top key, a missing key or an id that is not of the form D-n', () => {
    for (const text of [
      waiting([], { extra: 1 }),
      jsonOf({ intro: '', items: [] }),
      jsonOf({ intro: 1, groups: [], items: [] }),
      waiting([{ id: 'B-1' }]),
      waiting([{ title: 'T' }]),
      waiting(['D-1']),
      'not json',
    ]) {
      const result = parseWaiting(text);
      expect(exitOf(result), text).toBe(1);
      expect(errorOf(result).message, text).toContain(fileNames.waiting);
    }
  });

  it('M5-1b TP-88 stops a waiting file with a repeated D-n, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseWaiting(waiting([{ id: 'D-1' }, { id: 'D-3' }, { id: 'D-3' }])));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.message).toContain('D-3');
  });

  it('M5-1b TP-23 reads the id at the start of the item text of each row of the log, and null when there is none', () => {
    const rows = [
      { item: 'D-132 Factory PR 20: paste the command', decision: 'x' },
      { item: 'D-7' },
      { item: 'D-12: a title' },
      { item: 'devflow #187 (a title)' },
      { item: 'D-1234567890 too long' },
      { item: 'D-5x not an id' },
      { decision: 'no item text' },
    ];
    const doc = valueOf(parseDecisionLog(jsonOf({ rows })));
    expect(doc.rows.map((row) => row.id)).toEqual(['D-132', 'D-7', 'D-12', null, null, null, null]);
  });

  it('M5-1b TP-88 stops a decision log with a repeated D-n, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseDecisionLog(jsonOf({ rows: [{ item: 'D-7 a' }, { item: 'D-8' }, { item: 'D-7 b' }] })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(error.message).toContain('D-7');
  });

  it('M5-1b TP-24 refuses a decision log with another top key, rows that are not a list or a row that is not an object', () => {
    for (const text of [jsonOf({ rows: [], extra: 1 }), jsonOf({ rows: {} }), jsonOf({}), jsonOf({ rows: ['D-1'] }), 'not json']) {
      const result = parseDecisionLog(text);
      expect(exitOf(result), text).toBe(1);
      expect(errorOf(result).message, text).toContain(fileNames.decisionLog);
    }
  });
});

describe('the read of the board files', () => {
  const seeded = (path: string, text: string) => {
    const deps = createFakeDeps({ cwd: HOME });
    deps.seed(path, text);
    return deps;
  };

  it('M5-1b TP-93 reads and parses the board file', async () => {
    const deps = seeded(BOARD_PATH, jsonOf(boardOf({ tracks: [{ id: 'core', name: 'Core', roadmap: true }] })));
    const doc = valueOf(await readBoard(deps, LAYOUT, QUEUE));
    expect(doc.items.map((entry) => entry.id)).toEqual(['B-1']);
    expect(doc.tracks.map((track) => track.id)).toEqual(['core']);
    expect(doc.queueKey).toBe(QUEUE);
  });

  it('M5-1b TP-93 reads and parses the waiting file and the decision log', async () => {
    const deps = createFakeDeps({ cwd: HOME });
    deps.seed(WAITING_PATH, jsonOf({ intro: '', groups: [], items: [{ id: 'D-1' }] }));
    deps.seed(LOG_PATH, jsonOf({ rows: [{ item: 'D-2 x' }] }));
    expect(valueOf(await readWaiting(deps, LAYOUT)).items.map((entry) => entry.id)).toEqual(['D-1']);
    expect(valueOf(await readDecisionLog(deps, LAYOUT)).rows.map((row) => row.id)).toEqual(['D-2']);
  });

  it('M5-1b TP-51 stops a file that is not JSON with exit 1, and names the file', async () => {
    const deps = seeded(BOARD_PATH, 'not json');
    const result = await readBoard(deps, LAYOUT, QUEUE);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.board);
  });

  it('M5-1b TP-51 stops a file that is not UTF-8 with exit 1, and names the file', async () => {
    const deps = seeded(WAITING_PATH, jsonOf({ intro: '', groups: [], items: [] }));
    deps.invalidUtf8.add(WAITING_PATH);
    const result = await readWaiting(deps, LAYOUT);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.waiting);
  });

  it('M5-1b TP-51 stops a file that is a link with exit 4, and names the file', async () => {
    const deps = createFakeDeps({ cwd: HOME, links: { [LOG_PATH]: '/elsewhere/log.json' } });
    deps.seed(LOG_PATH, jsonOf({ rows: [] }));
    const result = await readDecisionLog(deps, LAYOUT);
    expect(exitOf(result)).toBe(4);
    expect(errorOf(result).message).toContain(fileNames.decisionLog);
  });

  it('M5-1b TP-51 stops a state folder that is a link with exit 4', async () => {
    const deps = createFakeDeps({ cwd: HOME, links: { [LAYOUT.stateDir]: '/elsewhere/state' } });
    deps.seed(BOARD_PATH, jsonOf(boardOf()));
    expect(exitOf(await readBoard(deps, LAYOUT, QUEUE))).toBe(4);
  });

  it('M5-1b TP-51 stops a file that is not there with exit 1, and names the file', async () => {
    const result = await readBoard(createFakeDeps({ cwd: HOME }), LAYOUT, QUEUE);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.board);
  });

  it('M5-1b TP-57 stops a board with the old queue key with exit 1 and the remedy to upgrade', async () => {
    const deps = seeded(BOARD_PATH, jsonOf({ queue: [], items: [] }));
    const error = errorOf(await readBoard(deps, LAYOUT, QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.upgrade));
  });
});

describe('the stages of the recipe', () => {
  it('M5-1b TP-72 gives the stage list of the recipe, and an empty list for a recipe with no stages', () => {
    expect(stagesOf(softwareBoard)).toEqual(['ticket', 'plan-approved', 'building', 'review', 'fixes', 'merged', 'released']);
    expect(stagesOf({})).toEqual([]);
  });

  it('M5-1b TP-75 gives the first stage to a new item, and none for a recipe with no stages', () => {
    expect(firstStageOf(softwareBoard)).toBe('ticket');
    expect(firstStageOf(publishBoard)).toBe('draft');
    expect(firstStageOf({})).toBeNull();
  });

  it('M5-1b TP-74 takes a listed stage', () => {
    expect(valueOf(requireStage(softwareBoard, 'review'))).toBe('review');
  });

  it('M5-1b TP-74 refuses an unknown stage with exit 2 and lists the stages', () => {
    const result = requireStage(softwareBoard, 'nowhere');
    expect(exitOf(result)).toBe(2);
    for (const stage of stagesOf(softwareBoard)) expect(errorOf(result).message).toContain(stage);
  });

  it('M5-1b TP-74 refuses a stage of a recipe with no stage list with exit 2', () => {
    for (const board of [{}, { stages: [] }]) {
      const result = requireStage(board, 'building');
      expect(exitOf(result)).toBe(2);
    }
  });

  it('M5-1b TP-76 refuses a flow-only stage with exit 2, and names the flow that the recipe gives for it', () => {
    for (const [stage, flow] of Object.entries(softwareBoard.flowOnly ?? {})) {
      const result = requireSettableStage(softwareBoard, stage);
      expect(exitOf(result)).toBe(2);
      expect(errorOf(result).message).toContain(flow);
    }
    expect(valueOf(requireSettableStage(softwareBoard, 'building'))).toBe('building');
  });

  it('M5-1b TP-103 names the flow of a recipe whose flow-only mark names another flow', () => {
    const result = requireSettableStage(publishBoard, 'printed');
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('press flow');
    expect(errorOf(result).message).not.toContain('merge');
  });

  it('M5-1b TP-74 refuses an unknown stage before it looks at the flow-only marks, and still lists the stages', () => {
    const result = requireSettableStage(softwareBoard, 'nowhere');
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('ticket');
  });

  it('M5-1b TP-75 shows a stored stage as written, and a stored stage outside the list with a mark', () => {
    expect(stageShown(softwareBoard, 'building')).toBe('building');
    expect(stageShown(softwareBoard, 'merged')).toBe('merged');
    expect(stageShown(softwareBoard, 'odd')).toBe(`odd${UNLISTED_MARK}`);
    expect(stageShown({}, 'building')).toBe(`building${UNLISTED_MARK}`);
  });

  it('M5-1b TP-91 shows a stored stage with a bidi mark or a line break as one clean line', () => {
    expect(stageShown(softwareBoard, 'bui‮lding')).toBe(`building${UNLISTED_MARK}`);
    expect(stageShown(softwareBoard, 're\nview')).toBe(`re view${UNLISTED_MARK}`);
  });
});

describe('the owner fields', () => {
  const board = sampleBoard();

  it('M5-1b TP-26 declares no field when the setup has no board block', () => {
    expect(declaredFields(undefined, 'item')).toEqual([]);
    expect(declaredFields({}, 'row')).toEqual([]);
  });

  it('M5-1b TP-26 declares the fields of one target', () => {
    expect(declaredFields(board, 'item').map((field) => field.name)).toEqual(['priority', 'type', 'lane']);
    expect(declaredFields(board, 'row').map((field) => field.name)).toEqual(['release']);
  });

  it('M5-1b TP-25 stores a value that the setup lists, and a token', () => {
    const values = valueOf(
      resolveFields(board, 'item', [{ name: 'priority', value: 'P1' }, { name: 'lane', value: 'lane-a' }], { complete: true }),
    );
    expect(values).toEqual({ priority: 'P1', lane: 'lane-a' });
  });

  it('M5-1b TP-28 reads a flag of a row as a boolean', () => {
    expect(valueOf(resolveFields(board, 'row', [{ name: 'release', value: 'true' }], { complete: true }))).toEqual({ release: true });
    expect(valueOf(resolveFields(board, 'row', [{ name: 'release', value: 'false' }], { complete: true }))).toEqual({ release: false });
    expect(exitOf(resolveFields(board, 'row', [{ name: 'release', value: 'maybe' }], { complete: true }))).toBe(2);
  });

  it('M5-1b TP-26 refuses a value outside the list with exit 2 and names the field', () => {
    const result = resolveFields(board, 'item', [{ name: 'priority', value: 'P9' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('priority');
  });

  it('M5-1b TP-26 refuses a token that is not a token with exit 2 and names the field', () => {
    for (const value of ['', 'has space', '-x', 'a'.repeat(33)]) {
      const result = resolveFields(board, 'item', [{ name: 'lane', value }], { complete: false });
      expect(exitOf(result), value).toBe(2);
      expect(errorOf(result).message, value).toContain('lane');
    }
  });

  it('M5-1b TP-26 refuses a field that the setup does not name with exit 2 and names the field', () => {
    const result = resolveFields(board, 'item', [{ name: 'colour', value: 'red' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('colour');
  });

  it('M5-1b TP-26 refuses every field when the setup has no board block', () => {
    const result = resolveFields(undefined, 'item', [{ name: 'priority', value: 'P1' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('priority');
    expect(valueOf(resolveFields(undefined, 'item', [], { complete: true }))).toEqual({});
  });

  it('M5-1b TP-26 refuses a field of the other target with exit 2', () => {
    expect(exitOf(resolveFields(board, 'item', [{ name: 'release', value: 'true' }], { complete: false }))).toBe(2);
    expect(exitOf(resolveFields(board, 'row', [{ name: 'priority', value: 'P1' }], { complete: false }))).toBe(2);
  });

  it('M5-1b TP-26 refuses a field that is given twice with exit 2', () => {
    const inputs = [{ name: 'priority', value: 'P1' }, { name: 'priority', value: 'P2' }];
    expect(exitOf(resolveFields(board, 'item', inputs, { complete: false }))).toBe(2);
  });

  it('M5-1b TP-26 refuses a name that is a member of Object.prototype, and does not reach it', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(exitOf(resolveFields(board, 'item', [{ name, value: 'x' }], { complete: false })), name).toBe(2);
    }
  });

  it('M5-1b TP-26 asks for each required field when the item is complete, and not when it is a change', () => {
    const missing = resolveFields(board, 'item', [{ name: 'type', value: 'bug' }], { complete: true });
    expect(exitOf(missing)).toBe(2);
    expect(errorOf(missing).message).toContain('priority');
    expect(valueOf(resolveFields(board, 'item', [{ name: 'type', value: 'bug' }], { complete: false }))).toEqual({ type: 'bug' });
  });
});

// The write part: the local connector over a fake state repo.

const SAMPLE = readFileSync(join(__dirname, '..', 'fixtures', 'board-sample.json'), 'utf8');
const EMPTY_BOARD = jsonOf({ [QUEUE]: [], items: [], tracks: [] });
const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);
const PRIORITY = { priority: 'P1' } as const;
const DOC_PATH = 'docs/design.md';

const DECISION: DecisionAskInput = {
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: [
    { key: 'a', text: 'Plan A', rec: true },
    { key: 'b', text: 'Plan B' },
  ],
};

const boardWith = (items: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): string =>
  jsonOf({ [QUEUE]: [], items, tracks: [], ...extra });

const connectorOf = (repo: BoardRepo, overrides: Partial<LocalBoardOptions> = {}): BoardConnector =>
  createLocalBoard(repo.deps, LAYOUT, {
    queueKey: QUEUE,
    recipe: softwareBoard,
    config: sampleBoard(),
    command: commands.start,
    tracker: values.trackerLocal,
    ...overrides,
  });

const repoWith = async (board: string, others: { waiting?: string; decisionLog?: string } = {}): Promise<BoardRepo> => {
  const repo = await boardRepo({ board, ...others });
  repo.deps.seed(join(HOME, DOC_PATH), '# Design\n');
  return repo;
};

/** The board file, the commits and the lock are as they were: the write stopped before it changed anything. */
const expectUntouched = (repo: BoardRepo, board: string): void => {
  expect(repo.commits).toEqual([]);
  expect(repo.textOf(fileNames.board)).toBe(board);
  expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
};

/** The lines that differ between two texts: what the first lost and what the second got, with the lines around them equal. */
const changedLines = (before: string, after: string): { removed: string[]; added: string[] } => {
  const old = before.split('\n');
  const now = after.split('\n');
  let head = 0;
  while (head < old.length && head < now.length && old[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < now.length - head && old[old.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  return { removed: old.slice(head, old.length - tail), added: now.slice(head, now.length - tail) };
};

describe('the local connector: the contract suite (TP-21)', () => {
  describeBoardContract('local', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    return {
      connector: connectorOf(repo),
      states: { first: 'open', other: 'doing', closed: 'done' },
      stages: { first: 'ticket', next: 'plan-approved' },
      fields: { add: { priority: 'P1' }, update: { priority: 'P2', type: 'bug' } },
      doc: DOC_PATH,
    };
  });
});

describe('the local connector: changes read (TP-21)', () => {
  it('M5-1b TP-21 reads no changes: an empty list and no cursor, with a cursor or without', async () => {
    const connector = connectorOf(await repoWith(EMPTY_BOARD));
    expect(valueOf(await connector.readChanges(null))).toEqual({ events: [], cursor: null });
    expect(valueOf(await connector.readChanges('c-1'))).toEqual({ events: [], cursor: null });
  });

  it('M5-1b TP-21 names the local kind, and the kind of the hosted tracker when the setup has one', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    expect(connectorOf(repo).kind).toBe('local');
    expect(connectorOf(repo, { tracker: 'github' }).kind).toBe('github');
  });
});

describe('the local connector: each write is one state commit of the local files (TP-66)', () => {
  type Write = (connector: BoardConnector) => Promise<CliResult<unknown>>;
  const WRITES: readonly (readonly [string, Write, readonly string[]])[] = [
    ['item add', (c) => c.addItem({ title: 'New', fields: PRIORITY }), [fileNames.board]],
    ['item update', (c) => c.updateItem('B-1', { title: 'Changed' }), [fileNames.board]],
    ['item move to a state', (c) => c.moveItem('B-1', { state: 'doing' }), [fileNames.board]],
    ['item move to a stage', (c) => c.moveItem('B-1', { stage: 'building' }), [fileNames.board]],
    ['item close', (c) => c.closeItem('B-1'), [fileNames.board]],
    ['track add', (c) => c.addTrack({ id: 'core', name: 'Core', roadmap: true }), [fileNames.board]],
    ['doc link', (c) => c.linkDoc({ id: 'B-1', path: DOC_PATH }), [fileNames.board]],
    ['decision ask', (c) => c.askDecision(DECISION), [fileNames.waiting]],
  ];

  it.each(WRITES)('M5-1b TP-66 %s makes one commit that holds only the local files, and prints no tracker line', async (_name, write, staged) => {
    const repo = await repoWith(boardWith([item('B-1', { stage: 'ticket' })]));
    const done = await write(connectorOf(repo));
    expect(done.ok).toBe(true);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([staged]);
    expect(repo.deps.warned).toEqual([]);
  });
});

describe('the local connector: the text of the board file (TP-23)', () => {
  it('M5-1b TP-23 writes the board of the fixture back byte for byte when nothing changes', () => {
    const doc = valueOf(parseBoard(SAMPLE, QUEUE));
    expect(valueOf(boardJsonText(doc.top))).toBe(SAMPLE);
  });

  it('M5-1b TP-23 changes only the title line of the item that an update changes, on a large board', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { title: 'Local board connector, write path' }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "title": "Local board connector",'],
      added: ['      "title": "Local board connector, write path",'],
    });
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-23 adds a new key at the end of the item, and leaves the unknown keys and their order as they are', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { text: 'New words' }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "count": 3'],
      added: ['      "count": 3,', '      "text": "New words"'],
    });
  });

  it('M5-1b TP-23 changes only the state line of the item for a move, and only the stage line for a stage move', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    valueOf(await connector.moveItem('B-3', { state: 'blocked' }));
    const afterState = repo.textOf(fileNames.board) ?? '';
    expect(changedLines(SAMPLE, afterState)).toEqual({ removed: ['      "status": "doing",'], added: ['      "status": "blocked",'] });
    valueOf(await connector.moveItem('B-3', { stage: 'review' }));
    expect(changedLines(afterState, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "stage": "building",'],
      added: ['      "stage": "review",'],
    });
  });

  it('M5-1b TP-23 changes only the value line of an owner field', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { fields: { priority: 'P2' } }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "priority": "P0",'],
      added: ['      "priority": "P2",'],
    });
  });

  it('M5-1b TP-23 escapes a title that is not ASCII, and keeps the pairs of the fixture that are escaped', async () => {
    const repo = await repoWith(SAMPLE);
    const title = 'Café 日本語 😀';
    valueOf(await connectorOf(repo).updateItem('B-4', { title }));
    const after = repo.textOf(fileNames.board) ?? '';
    expect(after).toContain('"title": "Caf\\u00e9 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00"');
    expect(after).toContain('"emoji": "\\ud83d\\ude00"');
    expect(/[^\x00-\x7f]/.test(after)).toBe(false);
    expect(valueOf(parseBoard(after, QUEUE)).items.find((entry) => entry.id === 'B-4')?.title).toBe(title);
  });

  it('M5-1b TP-23 makes no commit and leaves the text as it is for an update that sets the values that the item has', async () => {
    const repo = await repoWith(SAMPLE);
    const done = await connectorOf(repo).updateItem('B-3', { title: 'Local board connector', fields: { priority: 'P0' } });
    expect(done.ok).toBe(true);
    expectUntouched(repo, SAMPLE);
  });

  it('M5-1b TP-23 makes no commit and does not reformat a board that is not in the old form, when a move changes nothing', async () => {
    const wide = JSON.stringify(JSON.parse(SAMPLE) as unknown, null, 4);
    const repo = await repoWith(wide);
    const moved = valueOf(await connectorOf(repo).moveItem('B-3', { state: 'doing' }));
    expect(moved.changed).toBe(false);
    expectUntouched(repo, wide);
  });

  it('M5-1b TP-23 gives the new item the id after the highest one, and the keys in a fixed order', async () => {
    const repo = await repoWith(SAMPLE);
    const added = valueOf(await connectorOf(repo).addItem({ title: 'Brand new', text: 'Words', track: 'docs', fields: { priority: 'P1', type: 'bug', lane: 'w-1' } }));
    expect(added.id).toBe('B-17');
    expect(Object.keys(added.record)).toEqual(['id', 'title', 'status', 'stage', 'track', 'text', 'priority', 'type', 'lane']);
    expect(added.record['priority']).toBe('P1');
  });

  it.each([
    ['a whole number above the safe range', '12345678901234567890'],
    ['a number that is not finite', '1e999'],
  ])('M5-1b TP-23 refuses a write when the board holds %s, because it would not stay as it is', async (_name, number) => {
    const board = SAMPLE.replace('"count": 3', `"count": ${number}`);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'extra', name: 'Extra', roadmap: false }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expectUntouched(repo, board);
  });
});

describe('the local connector: the checks of a write (TP-24)', () => {
  const fields = PRIORITY;
  const REFUSED: readonly (readonly [string, ItemAddInput, string])[] = [
    ['an empty title', { title: '  ', fields }, 'title'],
    ['a title of 101 characters', { title: 'x'.repeat(101), fields }, 'title'],
    ['a title with a line break', { title: 'one\ntwo', fields }, 'title'],
    ['a title with a line separator', { title: `one${String.fromCodePoint(0x2028)}two`, fields }, 'title'],
    ['a title with a paragraph separator', { title: `one${String.fromCodePoint(0x2029)}two`, fields }, 'title'],
    ['a text with a line break', { title: 'ok', text: 'one\r\ntwo', fields }, 'text'],
    ['a text of 501 characters', { title: 'ok', text: 'x'.repeat(501), fields }, 'text'],
    ['a field that the setup does not declare', { title: 'ok', fields: { priority: 'P1', colour: 'red' } }, 'colour'],
    ['a value outside the list', { title: 'ok', fields: { priority: 'P9' } }, 'priority'],
    ['a missing required field', { title: 'ok' }, 'priority'],
    ['a track that is not on the board', { title: 'ok', fields, track: 'missing' }, 'missing'],
  ];

  it.each(REFUSED)('M5-1b TP-24 refuses an item with %s with exit 2, and changes no file', async (_name, input, named) => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo).addItem(input));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(named);
    expectUntouched(repo, EMPTY_BOARD);
  });

  it('M5-1b TP-24 takes a title of 100 characters and a text of 500 characters', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const added = valueOf(await connectorOf(repo).addItem({ title: 'x'.repeat(100), text: 'y'.repeat(500), fields }));
    expect([added.title.length, added.record['text']]).toEqual([100, 'y'.repeat(500)]);
  });

  it('M5-1b TP-24 refuses a change of an item with a long title, a line break or an unknown field, and changes no file', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    expect(exitOf(await connector.updateItem('B-3', { title: 'x'.repeat(101) }))).toBe(2);
    expect(exitOf(await connector.updateItem('B-3', { text: 'a\nb' }))).toBe(2);
    expect(exitOf(await connector.updateItem('B-3', { fields: { colour: 'red' } }))).toBe(2);
    expectUntouched(repo, SAMPLE);
  });

  it('M5-1b TP-24 refuses every write on a board with a top key that is not the queue key, items or tracks', async () => {
    const board = jsonOf({ [QUEUE]: [], items: [item('B-1')], extra: 1 });
    const repo = await repoWith(board);
    const connector = connectorOf(repo);
    const refused: CliResult<unknown>[] = [
      await connector.addItem({ title: 'New', fields }),
      await connector.updateItem('B-1', { title: 'Changed' }),
      await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }),
    ];
    for (const done of refused) {
      const error = errorOf(done);
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(fileNames.board);
      expect(error.message).toContain('extra');
    }
    expectUntouched(repo, board);
  });

  it('M5-1b TP-24 accepts a board with the tracks key and a board without it', async () => {
    for (const board of [jsonOf({ [QUEUE]: [], items: [], tracks: [] }), jsonOf({ [QUEUE]: [], items: [] })]) {
      const repo = await repoWith(board);
      expect((await connectorOf(repo).addItem({ title: 'New', fields })).ok).toBe(true);
    }
  });

  it('M5-1b TP-24 refuses an item when the setup declares no states, and points to the sample setup', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo, { config: undefined }).addItem({ title: 'New' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('examples/');
    expectUntouched(repo, EMPTY_BOARD);
  });

  it('M5-1b TP-24 refuses to close an item when the setup names no closed state, with exit 2', async () => {
    const repo = await repoWith(boardWith([item('B-1')]));
    const { closed: _closed, ...config } = sampleBoard();
    expect(exitOf(await connectorOf(repo, { config }).closeItem('B-1'))).toBe(2);
    expect(repo.commits).toEqual([]);
  });

  const REFUSED_DECISIONS: readonly (readonly [string, DecisionAskInput, number, string])[] = [
    ['a question with a line break', { ...DECISION, question: 'one\ntwo' }, 1, fileNames.waiting],
    ['a question of 501 characters', { ...DECISION, question: 'q'.repeat(501) }, 2, 'question'],
    ['an empty title', { ...DECISION, title: ' ' }, 2, 'title'],
    ['a title with a line break', { ...DECISION, title: 'a\nb' }, 2, 'title'],
    ['no option', { ...DECISION, options: [] }, 2, 'options'],
    ['ten options', { ...DECISION, options: Array.from({ length: 10 }, (_, at) => ({ key: `k${at}`, text: `Option ${at}` })) }, 2, 'options'],
    ['an option key that is not a token', { ...DECISION, options: [{ key: 'a b', text: 'x' }] }, 2, 'option key'],
    ['an option key used twice', { ...DECISION, options: [{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }] }, 2, 'twice'],
    ['an option text with a line break', { ...DECISION, options: [{ key: 'a', text: 'x\ny' }] }, 2, 'option'],
    ['two recommended options', { ...DECISION, options: [{ key: 'a', text: 'x', rec: true }, { key: 'b', text: 'y', rec: true }] }, 2, 'recommend'],
  ];

  it.each(REFUSED_DECISIONS)('M5-1b TP-24 refuses a decision with %s, and changes no file', async (_name, input, exit, named) => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo).askDecision(input));
    expect(exitCodeOf[error.kind]).toBe(exit);
    expect(error.message).toContain(named);
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(fileNames.waiting)).toBe(`${JSON.stringify({ intro: '', groups: [], items: [] }, null, 2)}\n`);
  });
});

describe('the local connector: the ids of a write (TP-88, TP-89)', () => {
  it('M5-1b TP-89 refuses a track id that exists with exit 2, and a 31st track with exit 2, and writes nothing', async () => {
    const tracks = Array.from({ length: 30 }, (_, at) => ({ id: `t${at}`, name: `Track ${at}`, roadmap: false }));
    const board = boardWith([], { tracks });
    const repo = await repoWith(board);
    const connector = connectorOf(repo);
    const again = errorOf(await connector.addTrack({ id: 't3', name: 'Again', roadmap: false }));
    expect(exitCodeOf[again.kind]).toBe(2);
    expect(again.message).toContain('t3');
    const more = errorOf(await connector.addTrack({ id: 'extra', name: 'Extra', roadmap: false }));
    expect(exitCodeOf[more.kind]).toBe(2);
    expect(more.message).toContain('30');
    expectUntouched(repo, board);
  });

  it('M5-1b TP-70 creates the tracks key at the end of the board on the first track add, and keeps the other keys', async () => {
    const board = jsonOf({ [QUEUE]: [], items: [item('B-1')] });
    const repo = await repoWith(board);
    valueOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    const top = JSON.parse(repo.textOf(fileNames.board) ?? '') as Record<string, unknown>;
    expect(Object.keys(top)).toEqual([QUEUE, 'items', 'tracks']);
    expect(top['tracks']).toEqual([{ id: 'core', name: 'Core', roadmap: true }]);
  });

  it('M5-1b TP-23 keeps the keys of a track that the core does not own when another track is added', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).addTrack({ id: 'extra', name: 'Extra', roadmap: false }));
    const before = JSON.parse(SAMPLE) as { tracks: unknown[] };
    const after = JSON.parse(repo.textOf(fileNames.board) ?? '') as { tracks: unknown[] };
    expect(after.tracks).toEqual([...before.tracks, { id: 'extra', name: 'Extra', roadmap: false }]);
    expect(after.tracks[0]).toEqual({ id: 'core', name: 'Core', roadmap: true, colour: 'blue' });
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '').removed).toEqual([]);
  });

  it('M5-1b TP-99 gives a decision the id after the highest D-n of the waiting file and the log', async () => {
    const waiting = jsonOf({ intro: '', groups: [], items: [{ id: 'D-3' }, { id: 'D-5' }] });
    const decisionLog = jsonOf({ rows: [{ item: 'D-9 An old plan' }, { item: 'no id' }] });
    const repo = await repoWith(EMPTY_BOARD, { waiting, decisionLog });
    expect(valueOf(await connectorOf(repo).askDecision(DECISION))).toBe('D-10');
  });

  it('M5-1b TP-99 gives the first decision the id D-1, and stores it with its options', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    expect(valueOf(await connectorOf(repo).askDecision(DECISION))).toBe('D-1');
    const waiting = valueOf(parseWaiting(repo.textOf(fileNames.waiting) ?? ''));
    expect(waiting.items.map((entry) => entry.record)).toEqual([
      {
        id: 'D-1',
        title: 'Pick a plan',
        question: 'Which plan do we build?',
        options: [{ key: 'a', text: 'Plan A', rec: true }, { key: 'b', text: 'Plan B' }],
      },
    ]);
    expect(repo.textOf(fileNames.decisionLog)).toBe(jsonOf({ rows: [] }));
  });

  it('M5-1b TP-88 stops a decision when the waiting file holds a D-n twice, with exit 1, and writes nothing', async () => {
    const waiting = jsonOf({ intro: '', groups: [], items: [{ id: 'D-1' }, { id: 'D-1' }] });
    const repo = await repoWith(EMPTY_BOARD, { waiting });
    const error = errorOf(await connectorOf(repo).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-88 stops a write on a board with a repeated item id, with exit 1, and writes nothing', async () => {
    const board = boardWith([item('B-1'), item('B-1')]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-1');
    expectUntouched(repo, board);
  });
});

describe('the local connector: an old queue key (TP-57)', () => {
  it('M5-1b TP-57 stops every write with exit 1 and the remedy to upgrade, and writes nothing', async () => {
    const board = jsonOf({ queue: [], items: [item('B-1')], tracks: [] });
    const repo = await repoWith(board);
    const connector = connectorOf(repo);
    const stopped: CliResult<unknown>[] = [
      await connector.addItem({ title: 'New', fields: PRIORITY }),
      await connector.updateItem('B-1', { title: 'Changed' }),
      await connector.moveItem('B-1', { state: 'doing' }),
      await connector.moveItem('B-1', { stage: 'building' }),
      await connector.closeItem('B-1'),
      await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }),
      await connector.linkDoc({ id: 'B-1', path: DOC_PATH }),
      await connector.askDecision(DECISION),
    ];
    for (const done of stopped) {
      const error = errorOf(done);
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain(commandText(commands.upgrade));
    }
    expectUntouched(repo, board);
    expect(repo.textOf(fileNames.waiting)).toBe(jsonOf({ intro: '', groups: [], items: [] }));
  });
});

describe('the local connector: a file that cannot be read (TP-51)', () => {
  it('M5-1b TP-51 stops a write on a board that is not JSON with exit 1, names the file, and writes nothing', async () => {
    const repo = await repoWith('not json');
    const error = errorOf(await connectorOf(repo).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expectUntouched(repo, 'not json');
  });

  it('M5-1b TP-51 stops a decision when the waiting file is not UTF-8 with exit 1, names the file, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    repo.deps.invalidUtf8.add(join(LAYOUT.stateDir, fileNames.waiting));
    const error = errorOf(await connectorOf(repo).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-51 stops a write on a board file that is a link, names the file, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const linked = createLocalBoard(linkAt(repo.deps, join(LAYOUT.stateDir, fileNames.board)), LAYOUT, {
      queueKey: QUEUE,
      recipe: softwareBoard,
      config: sampleBoard(),
      command: commands.start,
      tracker: values.trackerLocal,
    });
    const error = errorOf(await linked.addItem({ title: 'New', fields: PRIORITY }));
    expect([1, 4]).toContain(exitCodeOf[error.kind]);
    expect(error.message).toContain(fileNames.board);
    expect(repo.commits).toEqual([]);
  });
});

describe('the local connector: the lost-id check (TP-60)', () => {
  it('M5-1b TP-60 refuses with exit 4 a write on a board that lost an item id since the last commit, and writes nothing', async () => {
    const head = boardWith([item('B-1'), item('B-2')]);
    const board = boardWith([item('B-1')]);
    const repo = await boardRepo({ board, head });
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('B-2');
    expectUntouched(repo, board);
  });

  it('M5-1b TP-60 refuses with exit 4 a write on a board where an item id differs in case from the last commit', async () => {
    const head = boardWith([{ id: 'b-1', title: 'Old form', status: 'open' }]);
    const board = boardWith([item('B-1')]);
    const repo = await boardRepo({ board, head });
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('b-1');
    expectUntouched(repo, board);
  });

  it('M5-1b TP-60 lets a track add, a state move and a stage move pass, because they keep every item id', async () => {
    const board = boardWith([item('B-1'), item('B-2')]);
    const repo = await boardRepo({ board });
    const connector = connectorOf(repo);
    valueOf(await connector.addTrack({ id: 'core', name: 'Core', roadmap: true }));
    valueOf(await connector.moveItem('B-1', { state: 'doing' }));
    valueOf(await connector.moveItem('B-2', { stage: 'review' }));
    expect(repo.commits).toHaveLength(3);
  });
});

describe('the local connector: an item that is not on the board', () => {
  it('M5-1b TP-24 refuses an id that is not on the board, or not of the form B-n, with exit 2, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const connector = connectorOf(repo);
    for (const id of ['B-9', 'b-1', 'B-', 'x'.repeat(200), 'B-1\nB-2']) {
      expect(exitOf(await connector.updateItem(id, { title: 'No' })), id).toBe(2);
      expect(exitOf(await connector.moveItem(id, { state: 'doing' })), id).toBe(2);
      expect(exitOf(await connector.closeItem(id)), id).toBe(2);
      expect(exitOf(await connector.linkDoc({ id, path: DOC_PATH })), id).toBe(2);
    }
    expectUntouched(repo, EMPTY_BOARD);
  });

  it('M5-1b TP-76 refuses a stage that only a flow sets with exit 2, names the flow, and takes no lock', async () => {
    const repo = await repoWith(boardWith([item('B-1')]));
    const error = errorOf(await connectorOf(repo).moveItem('B-1', { stage: 'merged' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('merge flow');
    expect(repo.gitCommands()).toEqual([]);
    expect(repo.commits).toEqual([]);
  });
});

describe('the local connector: a link to a file of the factory (doc link)', () => {
  const link = async (repo: BoardRepo, path: string): Promise<CliResult<unknown>> => connectorOf(repo).linkDoc({ id: 'B-1', path });

  it('M5-1b TP-24 stores the relative path in the docs of the item, and stores a path once', async () => {
    const repo = await repoWith(boardWith([item('B-1', { docs: ['docs/a.md'] })]));
    valueOf(await link(repo, DOC_PATH));
    valueOf(await link(repo, DOC_PATH));
    const doc = valueOf(parseBoard(repo.textOf(fileNames.board) ?? '', QUEUE));
    expect(doc.items[0]?.record['docs']).toEqual(['docs/a.md', DOC_PATH]);
    expect(repo.commits).toHaveLength(1);
  });

  it.each([
    ['an empty path', ''],
    ['an absolute path', '/etc/passwd'],
    ['a path above the factory folder', '../outside.md'],
    ['a path with a dotted part', 'docs/../docs/design.md'],
    ['a path with a part of one dot', './docs/design.md'],
    ['a path with an empty part', 'docs//design.md'],
    ['a path in the git folder', 'docs/.git/config'],
    ['a path with a backslash', 'docs\\design.md'],
    ['a path with a line break', 'docs/design.md\nx'],
    ['a path of 201 characters', `${'d'.repeat(198)}.md`],
    ['a file that is not there', 'docs/missing.md'],
    ['a folder', 'docs'],
  ])('M5-1b TP-24 refuses %s with exit 2, and writes nothing', async (_name, path) => {
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    repo.deps.seedDir(join(HOME, 'docs'));
    expect(exitOf(await link(repo, path))).toBe(2);
    expectUntouched(repo, board);
  });

  it('M5-1b TP-24 refuses a file in a folder that is a link with exit 4, and writes nothing', async () => {
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    const linked = createLocalBoard(linkAt(repo.deps, join(HOME, 'docs')), LAYOUT, {
      queueKey: QUEUE,
      recipe: softwareBoard,
      config: sampleBoard(),
      command: commands.start,
      tracker: values.trackerLocal,
    });
    expect(exitOf(await linked.linkDoc({ id: 'B-1', path: DOC_PATH }))).toBe(4);
    expectUntouched(repo, board);
  });
});

describe('the local connector: a list', () => {
  it('M5-1b TP-47 hides the items of the closed state, and shows them when the list asks for all', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    const open = valueOf(await connector.listItems({ all: false })).map((entry) => entry.id);
    const all = valueOf(await connector.listItems({ all: true })).map((entry) => entry.id);
    expect(all).toHaveLength(14);
    expect(open).toEqual(all.filter((id) => !['B-1', 'B-2', 'B-5'].includes(id)));
  });

  it('M5-1b TP-84 lists the items of one track and refuses an unknown track with exit 2 that lists the track ids', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    const listed = valueOf(await connector.listItems({ all: true, track: 'docs' })).map((entry) => entry.id);
    expect(listed).toEqual(['B-9', 'B-11', 'B-14', 'B-16']);
    const error = errorOf(await connector.listItems({ all: false, track: 'nothing' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('core, board, docs');
  });

  it('M5-1b TP-93 reads the list and the tracks while another process holds the state lock, and does not wait', async () => {
    const repo = await repoWith(SAMPLE);
    repo.deps.seed(LOCK_FILE, '1\n');
    const slept = repo.deps.sleeps.length;
    const connector = connectorOf(repo);
    expect(valueOf(await connector.listItems({ all: true }))).toHaveLength(14);
    expect(valueOf(await connector.listTracks()).map((track) => track.id)).toEqual(['core', 'board', 'docs']);
    expect(repo.deps.sleeps.length).toBe(slept);
    expect(repo.deps.files.get(LOCK_FILE)).toBe('1\n');
  });
});
