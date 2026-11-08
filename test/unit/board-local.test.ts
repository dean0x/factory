import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFields, declaredFields } from '../../src/board/fields.js';
import { parseBoard, parseDecisionLog, parseWaiting, readBoard, readDecisionLog, readWaiting } from '../../src/board/files.js';
import { firstStageOf, requireSettableStage, requireStage, stageShown, stagesOf, UNLISTED_MARK } from '../../src/board/stages.js';
import { trackIdIssue, trackNameIssue, tracksOf } from '../../src/board/tracks.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import { commands, commandText, files as fileNames } from '../../src/names.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
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
