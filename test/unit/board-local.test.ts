import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  BoardConnector,
  DecisionAskInput,
  DecisionProofWriter,
  DecisionRecordCall,
  ItemAddInput,
  LocalBoard,
  RequestDecider,
  RequestSettlement,
} from '../../src/board/contract.js';
import { strictRequestOf, type DecideRequest } from '../../src/board/decide.js';
import { changeItemIn, checkPatch, checkSettlement, closeRequestIn } from '../../src/board/edit.js';
import { resolveFields, declaredFields } from '../../src/board/fields.js';
import { parseBoard, parseDecisionLog, parseWaiting, readBoard, readDecisionLog, readWaiting } from '../../src/board/files.js';
import { boardJsonText } from '../../src/board/json.js';
import { createLocalBoard, type LocalBoardOptions } from '../../src/board/local.js';
import { firstStageOf, requireSettableStage, requireStage, stageShown, stagesOf, UNLISTED_MARK } from '../../src/board/stages.js';
import { trackIdIssue, trackNameIssue, tracksOf } from '../../src/board/tracks.js';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import type { DecisionInput, DecisionWrite } from '../../src/core/owner-record.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { ok } from '../../src/core/result.js';
import {
  commandLines,
  commands,
  commandText,
  dirs,
  env,
  files as fileNames,
  maxBoardNumber,
  markLimits,
  maxFileBytes,
  relayedMarker,
  requestDeciders,
  stateLock,
  values,
  workerFieldGuard,
  type CommandName,
} from '../../src/names.js';
import type { CheckedRecord } from '../../src/recipes/entry.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { layoutOf, stateRel } from '../../src/state/layout.js';
import { describeBoardContract } from '../contract/board-contract.js';
import { boardRepo, type BoardRepo } from '../helpers/board-repo.js';
import { createFakeDeps, exited, withFailingWrites } from '../helpers/fake-deps.js';
import { HOOK, linkAt } from '../helpers/guard-fixture.js';
import { publishBoard } from '../helpers/publish-recipe.js';
import { sampleBoard } from '../helpers/sample-config.js';

const HOME = '/h/node';
const LAYOUT = layoutOf(HOME);
const BOARD_PATH = join(LAYOUT.stateDir, fileNames.board);
const WAITING_PATH = join(LAYOUT.stateDir, fileNames.waiting);
const LOG_PATH = join(LAYOUT.stateDir, fileNames.decisionLog);
const QUEUE = 'merge';
const NODE = 'demo';

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
  it('keeps the unknown keys of an item, and the order of the keys of the board and of the item', () => {
    const text = jsonOf({ tracks: [], items: [item('B-1', { zeta: 1, alpha: { k: [1, 2] } })], [QUEUE]: [] });
    const doc = valueOf(parseBoard(text, QUEUE));
    expect(Object.keys(doc.top)).toEqual(['tracks', 'items', QUEUE]);
    expect(Object.keys(doc.items[0]?.record ?? {})).toEqual(['id', 'title', 'status', 'zeta', 'alpha']);
    expect(doc.items[0]?.record['alpha']).toEqual({ k: [1, 2] });
  });

  it('refuses a top key that is not the queue key, items or tracks, and names the file and the key', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ extra: 1 })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('extra');
  });

  it('accepts the optional tracks key, and a board without it', () => {
    expect(parseBoard(jsonOf(boardOf({ tracks: [] })), QUEUE).ok).toBe(true);
    expect(parseBoard(jsonOf(boardOf()), QUEUE).ok).toBe(true);
  });

  it('refuses a board with no queue key, no items key or no JSON object, and names the file', () => {
    for (const text of [jsonOf({ items: [] }), jsonOf({ [QUEUE]: [] }), jsonOf([]), 'not json', jsonOf({ [QUEUE]: {}, items: [] })]) {
      const result = parseBoard(text, QUEUE);
      expect(exitOf(result), text).toBe(1);
      expect(errorOf(result).message, text).toContain(fileNames.board);
    }
  });

  it('stops a board that still has the old queue key with exit 1 and the remedy to upgrade', () => {
    const error = errorOf(parseBoard(jsonOf({ queue: [], items: [] }), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.hint).toContain(commandText(commands.upgrade));
  });

  it('takes the default key as the key of the board when the recipe gives that key', () => {
    expect(parseBoard(jsonOf({ queue: [], items: [] }), 'queue').ok).toBe(true);
  });
});

describe('the items of the board file', () => {
  it('refuses an item with no title, no state or an id that is not of the form B-n, and names the file', () => {
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

  it('refuses a track or a stage that is not text', () => {
    for (const extra of [{ track: 3 }, { stage: ['a'] }]) {
      expect(exitOf(parseBoard(jsonOf(boardOf({ items: [item('B-1', extra)] })), QUEUE))).toBe(1);
    }
  });

  it('reads the track and the stage of an item, and null when they are not there', () => {
    const doc = valueOf(parseBoard(jsonOf(boardOf({ items: [item('B-1', { track: 'a', stage: 'building' }), item('B-2')] })), QUEUE));
    expect(doc.items.map(({ id, track, stage }) => [id, track, stage])).toEqual([
      ['B-1', 'a', 'building'],
      ['B-2', null, null],
    ]);
  });

  it('stops a board with a repeated item id, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ items: [item('B-1'), item('B-2'), item('B-2')] })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('B-2');
  });

  it('refuses a queue that is not a list of objects', () => {
    expect(exitOf(parseBoard(jsonOf(boardOf({ [QUEUE]: [1] })), QUEUE))).toBe(1);
  });
});

describe('the tracks of the board file', () => {
  const trackOf = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'core', name: 'Core', roadmap: true, ...changes });

  it('reads an absent tracks key as an empty list', () => {
    expect(valueOf(parseBoard(jsonOf(boardOf()), QUEUE)).tracks).toEqual([]);
  });

  it('reads the tracks, and keeps their order', () => {
    const doc = valueOf(parseBoard(jsonOf(boardOf({ tracks: [trackOf(), trackOf({ id: 'agent-cost', name: 'Agent cost', roadmap: false })] })), QUEUE));
    expect(doc.tracks).toEqual([
      { id: 'core', name: 'Core', roadmap: true },
      { id: 'agent-cost', name: 'Agent cost', roadmap: false },
    ]);
  });

  it('stops a tracks value that is not a list with exit 1, and names the file', () => {
    for (const tracks of [{}, 'core', 3, null, { id: 'core' }]) {
      const result = parseBoard(jsonOf(boardOf({ tracks })), QUEUE);
      expect(exitOf(result), JSON.stringify(tracks)).toBe(1);
      expect(errorOf(result).message, JSON.stringify(tracks)).toContain(fileNames.board);
    }
  });

  it('stops a track with a bad id, name or roadmap value with exit 1, and names the file', () => {
    const bad = [
      trackOf({ id: 'Core' }),
      trackOf({ id: '1core' }),
      trackOf({ id: '-core' }),
      trackOf({ id: 'a'.repeat(33) }),
      trackOf({ id: '' }),
      trackOf({ id: 7 }),
      trackOf({ name: '' }),
      trackOf({ name: 'a\nb' }),
      trackOf({ name: `a${String.fromCodePoint(0x2028)}b` }),
      trackOf({ name: `a${String.fromCodePoint(0x2029)}b` }),
      trackOf({ name: `a${String.fromCodePoint(0x202e)}b` }),
      trackOf({ name: `a${String.fromCodePoint(0x2067)}b` }),
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

  it('keeps a key of a track that the core does not own', () => {
    expect(parseBoard(jsonOf(boardOf({ tracks: [trackOf({ owner: 'x' })] })), QUEUE).ok).toBe(true);
  });

  it('stops a board with a repeated track id, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseBoard(jsonOf(boardOf({ tracks: [trackOf(), trackOf({ name: 'Other' })] })), QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expect(error.message).toContain('core');
  });

  it('takes a track id of 32 characters and not one of 33, and a name of 60 characters and not one of 61', () => {
    expect(trackIdIssue('a'.repeat(32))).toBeNull();
    expect(trackIdIssue('a'.repeat(33))).not.toBeNull();
    expect(trackIdIssue('a-1')).toBeNull();
    expect(trackIdIssue('A')).not.toBeNull();
    expect(trackNameIssue('n'.repeat(60))).toBeNull();
    expect(trackNameIssue('n'.repeat(61))).not.toBeNull();
    expect(trackNameIssue('one\rline')).not.toBeNull();
    expect(trackNameIssue('Agent cost')).toBeNull();
  });

  it('reads the tracks of a top object that has no tracks key as an empty list', () => {
    expect(valueOf(tracksOf({}))).toEqual([]);
  });
});

describe('the waiting file and the decision log', () => {
  const waiting = (items: readonly unknown[], extra: Record<string, unknown> = {}): string =>
    jsonOf({ intro: '', groups: [], items, ...extra });

  it('reads the waiting items with their ids, and keeps the stored keys', () => {
    const doc = valueOf(parseWaiting(waiting([{ id: 'D-1', title: 'T', zeta: 1 }, { id: 'D-2' }])));
    expect(doc.items.map((entry) => entry.id)).toEqual(['D-1', 'D-2']);
    expect(Object.keys(doc.items[0]?.record ?? {})).toEqual(['id', 'title', 'zeta']);
    expect(Object.keys(doc.top)).toEqual(['intro', 'groups', 'items']);
  });

  it('refuses a waiting file with another top key, a missing key or an id that is not of the form D-n', () => {
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

  it('stops a waiting file with a repeated D-n, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseWaiting(waiting([{ id: 'D-1' }, { id: 'D-3' }, { id: 'D-3' }])));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.message).toContain('D-3');
  });

  it('reads the id at the start of the item text of each row of the log, and null when there is none', () => {
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

  it('stops a decision log with a repeated D-n, with exit 1, and names the file and the id', () => {
    const error = errorOf(parseDecisionLog(jsonOf({ rows: [{ item: 'D-7 a' }, { item: 'D-8' }, { item: 'D-7 b' }] })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(error.message).toContain('D-7');
  });

  it('refuses a decision log with another top key, rows that are not a list or a row that is not an object', () => {
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

  it('reads and parses the board file', async () => {
    const deps = seeded(BOARD_PATH, jsonOf(boardOf({ tracks: [{ id: 'core', name: 'Core', roadmap: true }] })));
    const doc = valueOf(await readBoard(deps, LAYOUT, QUEUE));
    expect(doc.items.map((entry) => entry.id)).toEqual(['B-1']);
    expect(doc.tracks.map((track) => track.id)).toEqual(['core']);
    expect(doc.queueKey).toBe(QUEUE);
  });

  it('reads and parses the waiting file and the decision log', async () => {
    const deps = createFakeDeps({ cwd: HOME });
    deps.seed(WAITING_PATH, jsonOf({ intro: '', groups: [], items: [{ id: 'D-1' }] }));
    deps.seed(LOG_PATH, jsonOf({ rows: [{ item: 'D-2 x' }] }));
    expect(valueOf(await readWaiting(deps, LAYOUT)).items.map((entry) => entry.id)).toEqual(['D-1']);
    expect(valueOf(await readDecisionLog(deps, LAYOUT)).rows.map((row) => row.id)).toEqual(['D-2']);
  });

  it('stops a file that is not JSON with exit 1, and names the file', async () => {
    const deps = seeded(BOARD_PATH, 'not json');
    const result = await readBoard(deps, LAYOUT, QUEUE);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.board);
  });

  it('stops a file that is not UTF-8 with exit 1, and names the file', async () => {
    const deps = seeded(WAITING_PATH, jsonOf({ intro: '', groups: [], items: [] }));
    deps.invalidUtf8.add(WAITING_PATH);
    const result = await readWaiting(deps, LAYOUT);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.waiting);
  });

  it('stops a file that is a link with exit 4, and names the file', async () => {
    const deps = createFakeDeps({ cwd: HOME, links: { [LOG_PATH]: '/elsewhere/log.json' } });
    deps.seed(LOG_PATH, jsonOf({ rows: [] }));
    const result = await readDecisionLog(deps, LAYOUT);
    expect(exitOf(result)).toBe(4);
    expect(errorOf(result).message).toContain(fileNames.decisionLog);
  });

  it('stops a state folder that is a link with exit 4', async () => {
    const deps = createFakeDeps({ cwd: HOME, links: { [LAYOUT.stateDir]: '/elsewhere/state' } });
    deps.seed(BOARD_PATH, jsonOf(boardOf()));
    expect(exitOf(await readBoard(deps, LAYOUT, QUEUE))).toBe(4);
  });

  it('stops a file that is not there with exit 1, and names the file', async () => {
    const result = await readBoard(createFakeDeps({ cwd: HOME }), LAYOUT, QUEUE);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain(fileNames.board);
  });

  it('stops a board with the old queue key with exit 1 and the remedy to upgrade', async () => {
    const deps = seeded(BOARD_PATH, jsonOf({ queue: [], items: [] }));
    const error = errorOf(await readBoard(deps, LAYOUT, QUEUE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.upgrade));
  });
});

describe('the stages of the recipe', () => {
  it('gives the stage list of the recipe, and an empty list for a recipe with no stages', () => {
    expect(stagesOf(softwareBoard)).toEqual(['ticket', 'plan-approved', 'building', 'review', 'fixes', 'merged', 'released']);
    expect(stagesOf({})).toEqual([]);
  });

  it('gives the first stage to a new item, and none for a recipe with no stages', () => {
    expect(firstStageOf(softwareBoard)).toBe('ticket');
    expect(firstStageOf(publishBoard)).toBe('draft');
    expect(firstStageOf({})).toBeNull();
  });

  it('takes a listed stage', () => {
    expect(valueOf(requireStage(softwareBoard, 'review'))).toBe('review');
  });

  it('refuses an unknown stage with exit 2 and lists the stages', () => {
    const result = requireStage(softwareBoard, 'nowhere');
    expect(exitOf(result)).toBe(2);
    for (const stage of stagesOf(softwareBoard)) expect(errorOf(result).message).toContain(stage);
  });

  it('refuses a stage of a recipe with no stage list with exit 2', () => {
    for (const board of [{}, { stages: [] }]) {
      const result = requireStage(board, 'building');
      expect(exitOf(result)).toBe(2);
    }
  });

  it('refuses a flow-only stage with exit 2, and names the flow that the recipe gives for it', () => {
    for (const [stage, flow] of Object.entries(softwareBoard.flowOnly ?? {})) {
      const result = requireSettableStage(softwareBoard, stage);
      expect(exitOf(result)).toBe(2);
      expect(errorOf(result).message).toContain(flow);
    }
    expect(valueOf(requireSettableStage(softwareBoard, 'building'))).toBe('building');
  });

  it('names the flow of a recipe whose flow-only mark names another flow', () => {
    const result = requireSettableStage(publishBoard, 'printed');
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('press flow');
    expect(errorOf(result).message).not.toContain('merge');
  });

  it('refuses an unknown stage before it looks at the flow-only marks, and still lists the stages', () => {
    const result = requireSettableStage(softwareBoard, 'nowhere');
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('ticket');
  });

  it('shows a stored stage as written, and a stored stage outside the list with a mark', () => {
    expect(stageShown(softwareBoard, 'building')).toBe('building');
    expect(stageShown(softwareBoard, 'merged')).toBe('merged');
    expect(stageShown(softwareBoard, 'odd')).toBe(`odd${UNLISTED_MARK}`);
    expect(stageShown({}, 'building')).toBe(`building${UNLISTED_MARK}`);
  });

  it('shows a stored stage with a bidi mark or a line break as one clean line', () => {
    expect(stageShown(softwareBoard, 'bui‮lding')).toBe(`building${UNLISTED_MARK}`);
    expect(stageShown(softwareBoard, 're\nview')).toBe(`re view${UNLISTED_MARK}`);
  });
});

describe('the owner fields', () => {
  const board = sampleBoard();

  it('declares no field when the setup has no board block', () => {
    expect(declaredFields(undefined, 'item')).toEqual([]);
    expect(declaredFields({}, 'row')).toEqual([]);
  });

  it('declares the fields of one target', () => {
    expect(declaredFields(board, 'item').map((field) => field.name)).toEqual(['priority', 'type', 'lane']);
    expect(declaredFields(board, 'row').map((field) => field.name)).toEqual(['release']);
  });

  it('stores a value that the setup lists, and a token', () => {
    const values = valueOf(
      resolveFields(board, 'item', [{ name: 'priority', value: 'P1' }, { name: 'lane', value: 'lane-a' }], { complete: true }),
    );
    expect(values).toEqual({ priority: 'P1', lane: 'lane-a' });
  });

  it('reads a flag of a row as a boolean', () => {
    expect(valueOf(resolveFields(board, 'row', [{ name: 'release', value: 'true' }], { complete: true }))).toEqual({ release: true });
    expect(valueOf(resolveFields(board, 'row', [{ name: 'release', value: 'false' }], { complete: true }))).toEqual({ release: false });
    expect(exitOf(resolveFields(board, 'row', [{ name: 'release', value: 'maybe' }], { complete: true }))).toBe(2);
  });

  it('refuses a value outside the list with exit 2 and names the field', () => {
    const result = resolveFields(board, 'item', [{ name: 'priority', value: 'P9' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('priority');
  });

  it('refuses a token that is not a token with exit 2 and names the field', () => {
    for (const value of ['', 'has space', '-x', 'a'.repeat(41)]) {
      const result = resolveFields(board, 'item', [{ name: 'lane', value }], { complete: false });
      expect(exitOf(result), value).toBe(2);
      expect(errorOf(result).message, value).toContain('lane');
    }
  });

  it('refuses a field that the setup does not name with exit 2 and names the field', () => {
    const result = resolveFields(board, 'item', [{ name: 'colour', value: 'red' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('colour');
  });

  it('refuses every field when the setup has no board block', () => {
    const result = resolveFields(undefined, 'item', [{ name: 'priority', value: 'P1' }], { complete: false });
    expect(exitOf(result)).toBe(2);
    expect(errorOf(result).message).toContain('priority');
    expect(valueOf(resolveFields(undefined, 'item', [], { complete: true }))).toEqual({});
  });

  it('refuses a field of the other target with exit 2', () => {
    expect(exitOf(resolveFields(board, 'item', [{ name: 'release', value: 'true' }], { complete: false }))).toBe(2);
    expect(exitOf(resolveFields(board, 'row', [{ name: 'priority', value: 'P1' }], { complete: false }))).toBe(2);
  });

  it('refuses a field that is given twice with exit 2', () => {
    const inputs = [{ name: 'priority', value: 'P1' }, { name: 'priority', value: 'P2' }];
    expect(exitOf(resolveFields(board, 'item', inputs, { complete: false }))).toBe(2);
  });

  it('refuses a name that is a member of Object.prototype, and does not reach it', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(exitOf(resolveFields(board, 'item', [{ name, value: 'x' }], { complete: false })), name).toBe(2);
    }
  });

  it('asks for each required field when the item is complete, and not when it is a change', () => {
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

const connectorOf = (repo: BoardRepo, overrides: Partial<LocalBoardOptions> = {}): LocalBoard =>
  createLocalBoard(repo.deps, LAYOUT, {
    queueKey: QUEUE,
    recipe: softwareBoard,
    config: sampleBoard(),
    command: commands.start,
    tracker: values.trackerLocal,
    node: NODE,
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

describe('the local connector: the contract suite', () => {
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

describe('the local connector: changes read', () => {
  it('reads no changes: an empty list and no cursor, with a cursor or without', async () => {
    const connector = connectorOf(await repoWith(EMPTY_BOARD));
    expect(valueOf(await connector.readChanges(null))).toEqual({ events: [], cursor: null });
    expect(valueOf(await connector.readChanges('c-1'))).toEqual({ events: [], cursor: null });
  });

  it('names the local kind, and the kind of the hosted tracker when the setup has one', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    expect(connectorOf(repo).kind).toBe('local');
    expect(connectorOf(repo, { tracker: 'github' }).kind).toBe('github');
  });
});

describe('the local connector: each write is one state commit of the local files', () => {
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

  it.each(WRITES)('%s makes one commit that holds only the local files, and prints no tracker line', async (_name, write, staged) => {
    const repo = await repoWith(boardWith([item('B-1', { stage: 'ticket' })]));
    const done = await write(connectorOf(repo));
    expect(done.ok).toBe(true);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([staged]);
    expect(repo.deps.warned).toEqual([]);
  });
});

describe('the local connector: the text of the board file', () => {
  it('writes the board of the fixture back byte for byte when nothing changes', () => {
    const doc = valueOf(parseBoard(SAMPLE, QUEUE));
    expect(valueOf(boardJsonText(doc.top))).toBe(SAMPLE);
  });

  it('changes only the title line of the item that an update changes, on a large board', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { title: 'Local board connector, write path' }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "title": "Local board connector",'],
      added: ['      "title": "Local board connector, write path",'],
    });
    expect(repo.commits).toHaveLength(1);
  });

  it('adds a new key at the end of the item, and leaves the unknown keys and their order as they are', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { text: 'New words' }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "count": 3'],
      added: ['      "count": 3,', '      "text": "New words"'],
    });
  });

  it('changes only the state line of the item for a move, and only the stage line for a stage move', async () => {
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

  it('changes only the value line of an owner field', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).updateItem('B-3', { fields: { priority: 'P2' } }));
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '')).toEqual({
      removed: ['      "priority": "P0",'],
      added: ['      "priority": "P2",'],
    });
  });

  it('escapes a title that is not ASCII, and keeps the pairs of the fixture that are escaped', async () => {
    const repo = await repoWith(SAMPLE);
    const title = 'Café 日本語 😀';
    valueOf(await connectorOf(repo).updateItem('B-4', { title }));
    const after = repo.textOf(fileNames.board) ?? '';
    expect(after).toContain('"title": "Caf\\u00e9 \\u65e5\\u672c\\u8a9e \\ud83d\\ude00"');
    expect(after).toContain('"emoji": "\\ud83d\\ude00"');
    expect(/[^\x00-\x7f]/.test(after)).toBe(false);
    expect(valueOf(parseBoard(after, QUEUE)).items.find((entry) => entry.id === 'B-4')?.title).toBe(title);
  });

  it('makes no commit and leaves the text as it is for an update that sets the values that the item has', async () => {
    const repo = await repoWith(SAMPLE);
    const done = await connectorOf(repo).updateItem('B-3', { title: 'Local board connector', fields: { priority: 'P0' } });
    expect(done.ok).toBe(true);
    expectUntouched(repo, SAMPLE);
  });

  it('makes no commit and does not reformat a board that is not in the old form, when a move changes nothing', async () => {
    const wide = JSON.stringify(JSON.parse(SAMPLE) as unknown, null, 4);
    const repo = await repoWith(wide);
    const moved = valueOf(await connectorOf(repo).moveItem('B-3', { state: 'doing' }));
    expect(moved.changed).toBe(false);
    expectUntouched(repo, wide);
  });

  it('gives the new item the id after the highest one, and the keys in a fixed order', async () => {
    const repo = await repoWith(SAMPLE);
    const added = valueOf(await connectorOf(repo).addItem({ title: 'Brand new', text: 'Words', track: 'docs', fields: { priority: 'P1', type: 'bug', lane: 'w-1' } }));
    expect(added.id).toBe('B-17');
    expect(Object.keys(added.record)).toEqual(['id', 'title', 'status', 'stage', 'track', 'text', 'priority', 'type', 'lane']);
    expect(added.record['priority']).toBe('P1');
  });

  it.each([
    ['a whole number above the safe range', '12345678901234567890'],
    ['a number that is not finite', '1e999'],
  ])('refuses a write when the board holds %s, because it would not stay as it is', async (_name, number) => {
    const board = SAMPLE.replace('"count": 3', `"count": ${number}`);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'extra', name: 'Extra', roadmap: false }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expectUntouched(repo, board);
  });
});

describe('the local connector: the checks of a write', () => {
  const fields = PRIORITY;
  const REFUSED: readonly (readonly [string, ItemAddInput, string])[] = [
    ['an empty title', { title: '  ', fields }, 'title'],
    ['a title of 101 characters', { title: 'x'.repeat(101), fields }, 'title'],
    ['a title with a line break', { title: 'one\ntwo', fields }, 'title'],
    ['a title with a line separator', { title: `one${String.fromCodePoint(0x2028)}two`, fields }, 'title'],
    ['a title with a paragraph separator', { title: `one${String.fromCodePoint(0x2029)}two`, fields }, 'title'],
    ['a title with a right-to-left override', { title: `one${String.fromCodePoint(0x202e)}two`, fields }, 'title'],
    ['a title with a pop of a direction isolate', { title: `one${String.fromCodePoint(0x2069)}two`, fields }, 'title'],
    ['a text with a left-to-right embedding', { title: 'ok', text: `one${String.fromCodePoint(0x202a)}two`, fields }, 'text'],
    ['a text with a line break', { title: 'ok', text: 'one\r\ntwo', fields }, 'text'],
    ['a text of 501 characters', { title: 'ok', text: 'x'.repeat(501), fields }, 'text'],
    ['a field that the setup does not declare', { title: 'ok', fields: { priority: 'P1', colour: 'red' } }, 'colour'],
    ['a value outside the list', { title: 'ok', fields: { priority: 'P9' } }, 'priority'],
    ['a missing required field', { title: 'ok' }, 'priority'],
    ['a track that is not on the board', { title: 'ok', fields, track: 'missing' }, 'missing'],
  ];

  it.each(REFUSED)('refuses an item with %s with exit 2, and changes no file', async (_name, input, named) => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo).addItem(input));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(named);
    expectUntouched(repo, EMPTY_BOARD);
  });

  it('takes a title of 100 characters and a text of 500 characters', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const added = valueOf(await connectorOf(repo).addItem({ title: 'x'.repeat(100), text: 'y'.repeat(500), fields }));
    expect([added.title.length, added.record['text']]).toEqual([100, 'y'.repeat(500)]);
  });

  it('takes a title with an emoji sequence that holds zero-width joiners', async () => {
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map((code) => String.fromCodePoint(code)).join('');
    const repo = await repoWith(EMPTY_BOARD);
    const added = valueOf(await connectorOf(repo).addItem({ title: `Team ${family}`, fields }));
    expect(added.title).toBe(`Team ${family}`);
  });

  it('refuses a change of an item with a long title, a line break or an unknown field, and changes no file', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    expect(exitOf(await connector.updateItem('B-3', { title: 'x'.repeat(101) }))).toBe(2);
    expect(exitOf(await connector.updateItem('B-3', { text: 'a\nb' }))).toBe(2);
    expect(exitOf(await connector.updateItem('B-3', { fields: { colour: 'red' } }))).toBe(2);
    expectUntouched(repo, SAMPLE);
  });

  it('refuses every write on a board with a top key that is not the queue key, items or tracks', async () => {
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

  it('accepts a board with the tracks key and a board without it', async () => {
    for (const board of [jsonOf({ [QUEUE]: [], items: [], tracks: [] }), jsonOf({ [QUEUE]: [], items: [] })]) {
      const repo = await repoWith(board);
      expect((await connectorOf(repo).addItem({ title: 'New', fields })).ok).toBe(true);
    }
  });

  it('refuses an item when the setup declares no states, and points to the sample setup', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo, { config: undefined }).addItem({ title: 'New' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('examples/');
    expectUntouched(repo, EMPTY_BOARD);
  });

  it('refuses to close an item when the setup names no closed state, with exit 2', async () => {
    const repo = await repoWith(boardWith([item('B-1')]));
    const { closed: _closed, ...config } = sampleBoard();
    expect(exitOf(await connectorOf(repo, { config }).closeItem('B-1'))).toBe(2);
    expect(repo.commits).toEqual([]);
  });

  const REFUSED_DECISIONS: readonly (readonly [string, DecisionAskInput, number, string])[] = [
    ['a question with a line break', { ...DECISION, question: 'one\ntwo' }, 1, fileNames.waiting],
    ['a question of 501 characters', { ...DECISION, question: 'q'.repeat(501) }, 2, 'question'],
    ['an empty title', { ...DECISION, title: ' ' }, 2, 'title'],
    ['a question with a direction isolate', { ...DECISION, question: `one${String.fromCodePoint(0x2066)}two` }, 1, fileNames.waiting],
    ['a title with a line break', { ...DECISION, title: 'a\nb' }, 2, 'title'],
    ['a title with a right-to-left override', { ...DECISION, title: `a${String.fromCodePoint(0x202e)}b` }, 2, 'title'],
    ['no option', { ...DECISION, options: [] }, 2, 'options'],
    ['ten options', { ...DECISION, options: Array.from({ length: 10 }, (_, at) => ({ key: `k${at}`, text: `Option ${at}` })) }, 2, 'options'],
    ['an option key that is not a token', { ...DECISION, options: [{ key: 'a b', text: 'x' }] }, 2, 'option key'],
    ['an option key used twice', { ...DECISION, options: [{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }] }, 2, 'twice'],
    ['an option text with a line break', { ...DECISION, options: [{ key: 'a', text: 'x\ny' }] }, 2, 'option'],
    ['an option text with a direction isolate', { ...DECISION, options: [{ key: 'a', text: `x${String.fromCodePoint(0x2066)}y` }] }, 2, 'option'],
    ['two recommended options', { ...DECISION, options: [{ key: 'a', text: 'x', rec: true }, { key: 'b', text: 'y', rec: true }] }, 2, 'recommend'],
  ];

  it.each(REFUSED_DECISIONS)('refuses a decision with %s, and changes no file', async (_name, input, exit, named) => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await connectorOf(repo).askDecision(input));
    expect(exitCodeOf[error.kind]).toBe(exit);
    expect(error.message).toContain(named);
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(fileNames.waiting)).toBe(`${JSON.stringify({ intro: '', groups: [], items: [] }, null, 2)}\n`);
  });
});

describe('the local connector: the ids of a write', () => {
  it('refuses a track id that exists with exit 2, and a 31st track with exit 2, and writes nothing', async () => {
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

  it('creates the tracks key at the end of the board on the first track add, and keeps the other keys', async () => {
    const board = jsonOf({ [QUEUE]: [], items: [item('B-1')] });
    const repo = await repoWith(board);
    valueOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    const top = JSON.parse(repo.textOf(fileNames.board) ?? '') as Record<string, unknown>;
    expect(Object.keys(top)).toEqual([QUEUE, 'items', 'tracks']);
    expect(top['tracks']).toEqual([{ id: 'core', name: 'Core', roadmap: true }]);
  });

  it('keeps the keys of a track that the core does not own when another track is added', async () => {
    const repo = await repoWith(SAMPLE);
    valueOf(await connectorOf(repo).addTrack({ id: 'extra', name: 'Extra', roadmap: false }));
    const before = JSON.parse(SAMPLE) as { tracks: unknown[] };
    const after = JSON.parse(repo.textOf(fileNames.board) ?? '') as { tracks: unknown[] };
    expect(after.tracks).toEqual([...before.tracks, { id: 'extra', name: 'Extra', roadmap: false }]);
    expect(after.tracks[0]).toEqual({ id: 'core', name: 'Core', roadmap: true, colour: 'blue' });
    expect(changedLines(SAMPLE, repo.textOf(fileNames.board) ?? '').removed).toEqual([]);
  });

  it('gives a decision the id after the highest D-n of the waiting file and the log', async () => {
    const waiting = jsonOf({ intro: '', groups: [], items: [{ id: 'D-3' }, { id: 'D-5' }] });
    const decisionLog = jsonOf({ rows: [{ item: 'D-9 An old plan' }, { item: 'no id' }] });
    const repo = await repoWith(EMPTY_BOARD, { waiting, decisionLog });
    expect(valueOf(await connectorOf(repo).askDecision(DECISION))).toBe('D-10');
  });

  it('gives the first decision the id D-1, and stores it with its options', async () => {
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

  it('stops an item add when the numbers B-n are used up, with exit 1, and writes nothing', async () => {
    const board = boardWith([item(`B-${maxBoardNumber}`)]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('used up');
    expectUntouched(repo, board);
  });

  it('stops a decision when the numbers D-n are used up, with exit 1, and writes nothing', async () => {
    const waiting = jsonOf({ intro: '', groups: [], items: [{ id: `D-${maxBoardNumber}` }] });
    const repo = await repoWith(EMPTY_BOARD, { waiting });
    const error = errorOf(await connectorOf(repo).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('used up');
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(fileNames.waiting)).toBe(waiting);
  });

  it('stops a decision when the waiting file holds a D-n twice, with exit 1, and writes nothing', async () => {
    const waiting = jsonOf({ intro: '', groups: [], items: [{ id: 'D-1' }, { id: 'D-1' }] });
    const repo = await repoWith(EMPTY_BOARD, { waiting });
    const error = errorOf(await connectorOf(repo).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(repo.commits).toEqual([]);
  });

  it('stops a write on a board with a repeated item id, with exit 1, and writes nothing', async () => {
    const board = boardWith([item('B-1'), item('B-1')]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-1');
    expectUntouched(repo, board);
  });
});

describe('the local connector: an old queue key', () => {
  it('stops every write with exit 1 and the remedy to upgrade, and writes nothing', async () => {
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

describe('the local connector: a file that cannot be read', () => {
  it('stops a write on a board that is not JSON with exit 1, names the file, and writes nothing', async () => {
    const repo = await repoWith('not json');
    const error = errorOf(await connectorOf(repo).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expectUntouched(repo, 'not json');
  });

  it('stops a decision when the waiting file is not UTF-8 with exit 1, names the file, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    repo.deps.invalidUtf8.add(join(LAYOUT.stateDir, fileNames.waiting));
    const error = errorOf(await connectorOf(repo).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(repo.commits).toEqual([]);
  });

  const linkedConnector = (repo: BoardRepo, file: string): BoardConnector =>
    createLocalBoard(linkAt(repo.deps, join(LAYOUT.stateDir, file)), LAYOUT, {
      queueKey: QUEUE,
      recipe: softwareBoard,
      config: sampleBoard(),
      command: commands.start,
      tracker: values.trackerLocal,
      node: NODE,
    });

  it('stops a write on a board file that is a link with exit 4, names the file, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await linkedConnector(repo, fileNames.board).addItem({ title: 'New', fields: PRIORITY }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(fileNames.board);
    expect(error.hint).toContain('Replace the link');
    expect(repo.commits).toEqual([]);
  });

  it('stops a decision when the waiting file is a link with exit 4, names the file, and writes nothing', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const error = errorOf(await linkedConnector(repo, fileNames.waiting).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.hint).toContain('Replace the link');
    expect(repo.commits).toEqual([]);
  });
});

describe('the local connector: the lost-id check', () => {
  it('refuses with exit 4 a write on a board that lost an item id since the last commit, and writes nothing', async () => {
    const head = boardWith([item('B-1'), item('B-2')]);
    const board = boardWith([item('B-1')]);
    const repo = await boardRepo({ board, head });
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('B-2');
    expectUntouched(repo, board);
  });

  it('refuses with exit 4 a write on a board where an item id differs in case from the last commit', async () => {
    const head = boardWith([{ id: 'b-1', title: 'Old form', status: 'open' }]);
    const board = boardWith([item('B-1')]);
    const repo = await boardRepo({ board, head });
    const error = errorOf(await connectorOf(repo).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('b-1');
    expectUntouched(repo, board);
  });

  it('lets a track add, a state move and a stage move pass, because they keep every item id', async () => {
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
  it('refuses an id that is not on the board, or not of the form B-n, with exit 2, and writes nothing', async () => {
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

  it('refuses a stage that only a flow sets with exit 2, names the flow, and takes no lock', async () => {
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

  it('stores the relative path in the docs of the item, and stores a path once', async () => {
    const repo = await repoWith(boardWith([item('B-1', { docs: ['docs/a.md'] })]));
    valueOf(await link(repo, DOC_PATH));
    valueOf(await link(repo, DOC_PATH));
    const doc = valueOf(parseBoard(repo.textOf(fileNames.board) ?? '', QUEUE));
    expect(doc.items[0]?.record['docs']).toEqual(['docs/a.md', DOC_PATH]);
    expect(repo.commits).toHaveLength(1);
  });

  it('refuses a path with a right-to-left override, also when the file is there, with exit 2, and writes nothing', async () => {
    const path = `docs/design${String.fromCodePoint(0x202e)}.md`;
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    repo.deps.seed(join(HOME, path), '# Design\n');
    expect(exitOf(await link(repo, path))).toBe(2);
    expectUntouched(repo, board);
  });

  it('stops a link when the docs of the item is not a list of text, with exit 1, names the file, and changes nothing', async () => {
    const board = boardWith([item('B-1', { docs: 'a.md' })]);
    const repo = await repoWith(board);
    const error = errorOf(await link(repo, DOC_PATH));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
    expectUntouched(repo, board);
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
  ])('refuses %s with exit 2, and writes nothing', async (_name, path) => {
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    repo.deps.seedDir(join(HOME, 'docs'));
    expect(exitOf(await link(repo, path))).toBe(2);
    expectUntouched(repo, board);
  });

  it('refuses a file in a folder that is a link with exit 4, and writes nothing', async () => {
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    const linked = createLocalBoard(linkAt(repo.deps, join(HOME, 'docs')), LAYOUT, {
      queueKey: QUEUE,
      recipe: softwareBoard,
      config: sampleBoard(),
      command: commands.start,
      tracker: values.trackerLocal,
      node: NODE,
    });
    expect(exitOf(await linked.linkDoc({ id: 'B-1', path: DOC_PATH }))).toBe(4);
    expectUntouched(repo, board);
  });
});

describe('the local connector: a list', () => {
  it('hides the items of the closed state, and shows them when the list asks for all', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    const open = valueOf(await connector.listItems({ all: false })).map((entry) => entry.id);
    const all = valueOf(await connector.listItems({ all: true })).map((entry) => entry.id);
    expect(all).toHaveLength(14);
    expect(open).toEqual(all.filter((id) => !['B-1', 'B-2', 'B-5'].includes(id)));
  });

  it('lists the items of one track and refuses an unknown track with exit 2 that lists the track ids', async () => {
    const repo = await repoWith(SAMPLE);
    const connector = connectorOf(repo);
    const listed = valueOf(await connector.listItems({ all: true, track: 'docs' })).map((entry) => entry.id);
    expect(listed).toEqual(['B-9', 'B-11', 'B-14', 'B-16']);
    const error = errorOf(await connector.listItems({ all: false, track: 'nothing' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('core, board, docs');
  });

  it('reads the list and the tracks while another process holds the state lock, and does not wait', async () => {
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

// The decision operations: read an open request, and record the answer of the owner.

const PERSON_ENV = { [env.stateHome]: '/state', [env.userHome]: '/home/me' };
const DECISIONS_PATH = '/state/factory/owner-decisions.json';
const PROFILE_DIR = join(LAYOUT.stateDir, dirs.profile);
const DECISIONS_DIR = join(LAYOUT.stateDir, stateRel.profileDecisions);
const PROFILE_LOG_PATH = join(LAYOUT.stateDir, stateRel.profileLog);
const RECORD_NAME = '2030-01-02-d-1-pick-a-plan.md';
const RECORD_PATH = join(stateRel.profileDecisions, RECORD_NAME);
const RECORD_FILE = join(LAYOUT.stateDir, RECORD_PATH);
const AT = '2030-01-02T03:04:05.678Z';

const ENTRY = {
  id: 'D-1',
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: [{ key: 'a', text: 'Plan A', rec: true }, { key: 'b', text: 'Plan B' }],
};
const CHANGED_ENTRY = { ...ENTRY, question: 'Which plan do we drop?' };

const requestTextOf = (entry: Record<string, unknown>): string => {
  const text = canonicalRequestText(entry);
  if (!text.ok) throw new Error(text.error);
  return text.value;
};
const TEXT = requestTextOf(ENTRY);
const HASH = requestHashOf(TEXT);

const waitingOf = (...entries: readonly Record<string, unknown>[]): string => jsonOf({ intro: '', groups: [], items: entries });
const logOf = (...rows: readonly Record<string, unknown>[]): string => jsonOf({ rows });
const answerRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item: 'D-1: Pick a plan',
  decision: 'a',
  date: '2030-01-02',
  by: 'owner',
  request: TEXT,
  ...overrides,
});
const closedRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item: 'D-1: Pick a plan',
  decision: 'closed',
  date: '2030-01-02',
  ...overrides,
});
const storedRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  node: NODE,
  root: HOME,
  id: 'D-1',
  option: 'a',
  hash: HASH,
  at: AT,
  ...overrides,
});
const storeOf = (...records: readonly Record<string, unknown>[]): string => jsonOf({ schema: 1, records });

interface DecideSetup {
  readonly waiting?: string;
  readonly decisionLog?: string;
  readonly store?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** False: the profile folder is not there. */
  readonly profile?: boolean;
  readonly profileLog?: string;
}

const decideRepo = async (setup: DecideSetup = {}): Promise<BoardRepo> => {
  const repo = await boardRepo({
    board: EMPTY_BOARD,
    waiting: setup.waiting ?? waitingOf(ENTRY),
    ...(setup.decisionLog === undefined ? {} : { decisionLog: setup.decisionLog }),
    env: setup.env ?? PERSON_ENV,
  });
  if (setup.profile !== false) repo.deps.seedDir(PROFILE_DIR);
  if (setup.store !== undefined) repo.deps.seed(DECISIONS_PATH, setup.store);
  if (setup.profileLog !== undefined) repo.deps.seed(PROFILE_LOG_PATH, setup.profileLog);
  return repo;
};

/** The command that `localOf` gives the connector, which the remedy line of a stop names. */
const PASSED_COMMAND = commands.start;

const localOf = (deps: Deps, command: CommandName = PASSED_COMMAND): LocalBoard =>
  createLocalBoard(deps, LAYOUT, {
    queueKey: QUEUE,
    recipe: softwareBoard,
    config: sampleBoard(),
    command,
    tracker: values.trackerLocal,
    node: NODE,
  });

const requestOf = (entry: Record<string, unknown>): DecideRequest =>
  valueOf(strictRequestOf(valueOf(parseWaiting(waitingOf(entry))), String(entry['id'])));

const callOf = (overrides: Partial<DecisionRecordCall> = {}): DecisionRecordCall => ({
  request: requestOf(ENTRY),
  option: 'a',
  note: null,
  at: AT,
  ...overrides,
});

interface ProofSpy {
  readonly writer: DecisionProofWriter;
  readonly calls: DecisionInput[];
}

/** A writer of the owner record that keeps its inputs. It stands in for the writer that the command of decide gives. */
const proofSpy = (
  result: CliResult<DecisionWrite> = ok({ outcome: 'stored', warning: null }),
  during: () => Promise<void> = async () => undefined,
): ProofSpy => {
  const calls: DecisionInput[] = [];
  return {
    calls,
    writer: async (input) => {
      calls.push(input);
      await during();
      return result;
    },
  };
};

const kindAt = async (repo: BoardRepo, path: string): Promise<string | null> => valueOf(await repo.deps.fs.lstat(path));

describe('the local connector: an open request for the owner', () => {
  it('reads an open request with its canonical text, its hash, no stored record and the place, and writes nothing', async () => {
    const repo = await decideRepo();
    const before = new Map(repo.deps.files);
    const read = valueOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(read.request).toMatchObject({ id: 'D-1', title: 'Pick a plan', canonical: TEXT, hash: HASH });
    expect(read.stored).toEqual({ kind: 'none' });
    expect(read.place).toEqual({ node: NODE, root: HOME, path: DECISIONS_PATH });
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('gives the record of the store for the same request text, with the stored option and time', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ option: 'b' })) });
    const read = valueOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(read.stored).toEqual({ kind: 'record', node: NODE, root: HOME, id: 'D-1', option: 'b', at: AT });
  });

  it('gives a mismatch with the stored option and time for a record of another request text', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ hash: requestHashOf(requestTextOf(CHANGED_ENTRY)) })) });
    const read = valueOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(read.stored).toEqual({ kind: 'mismatch', option: 'a', at: AT });
  });

  it.each([
    ['another node', { node: 'other' }],
    ['another root', { root: '/h/other' }],
  ])('does not count a record of %s', async (_name, overrides) => {
    const repo = await decideRepo({ store: storeOf(storedRecord(overrides)) });
    expect(valueOf(await localOf(repo.deps).decisionRequest('D-1')).stored).toEqual({ kind: 'none' });
  });

  it('stops with exit 4 when the delete guard is off, and changes nothing', async () => {
    const repo = await decideRepo({ store: storeOf() });
    repo.deps.files.delete(HOOK);
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(repo.deps.files).toEqual(before);
  });

  it('exits 2 for a number that no file and no store record holds', async () => {
    const repo = await decideRepo();
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-9'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(fileNames.waiting);
  });

  it('exits 1 for a closed number and names its date', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(closedRow()) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('closed');
    expect(error.message).toContain('2030-01-02');
  });

  it('shows the date of a closed row cleaned of an escape sequence', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(closedRow({ date: '2030\u001b[31m-01-02' })) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(error.message).not.toContain('\u001b');
  });

  it('reports a closed number before it looks for the place of the decision file', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(closedRow()), env: {} });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(error.message).toContain('closed');
  });

  it('exits 1 for a number that only the store holds, and names the stored time', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), store: storeOf(storedRecord()) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(AT);
  });

  it('exits 1 for an answered row with a matching store record, and names the date of the answer', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(answerRow()), store: storeOf(storedRecord()) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-02');
    expect(error.hint).toContain(commandText(commandLines.requestAdd));
  });

  it.each([
    ['no record in the store', answerRow(), storeOf()],
    ['no decision file', answerRow(), undefined],
    ['a record of another request text', answerRow({ request: requestTextOf(CHANGED_ENTRY) }), storeOf(storedRecord())],
    ['a row with no request text', Object.fromEntries(Object.entries(answerRow()).filter(([key]) => key !== 'request')), storeOf(storedRecord())],
    ['another value of the by key', answerRow({ by: 'coordinator' }), storeOf()],
  ])('exits 1 for a row with %s: it is not an owner answer, and the remedy adds a new request', async (_name, row, store) => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(row), ...(store === undefined ? {} : { store }) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('not an owner answer');
    expect(error.hint).toContain(commandText(commandLines.requestAdd));
  });

  it.each([
    ['an open request', waitingOf(ENTRY), logOf()],
    ['an answered row', waitingOf(), logOf(answerRow())],
    ['a number that is in no file', waitingOf(), logOf()],
  ])('exits 1 and names the decision file when it cannot be read, for %s', async (_name, waiting, decisionLog) => {
    const repo = await decideRepo({ waiting, decisionLog, store: 'not json' });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(DECISIONS_PATH);
  });

  it('exits 1 before the prompt when no variable names a state folder', async () => {
    const repo = await decideRepo({ env: {} });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('no variable names a state folder');
    expect(error.hint).toContain(env.stateHome);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 4 when the decision file would be inside the factory folder', async () => {
    const repo = await decideRepo({ env: { [env.stateHome]: `${HOME}/state`, [env.userHome]: '/home/me' } });
    expect(exitOf(await localOf(repo.deps).decisionRequest('D-1'))).toBe(4);
  });

  it('exits 1 and names both files for a number that is in the waiting file and in the log', async () => {
    const repo = await decideRepo({ decisionLog: logOf(closedRow()) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1 and names the waiting file for an entry with a key that the strict read refuses', async () => {
    const repo = await decideRepo({ waiting: waitingOf({ ...ENTRY, extra: 1 }) });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.hint).toContain(commandText(commandLines.requestClose));
  });

  it('reads the strict entry before the store: a bad entry exits 1 with no record needed', async () => {
    const repo = await decideRepo({ waiting: waitingOf({ ...ENTRY, title: 'two\nlines' }), store: 'not json' });
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(error.message).toContain(fileNames.waiting);
  });

  it('stops on a board with the old queue key, as a write does', async () => {
    const repo = await decideRepo();
    repo.deps.seed(BOARD_PATH, jsonOf({ queue: [], items: [] }));
    const error = errorOf(await localOf(repo.deps).decisionRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
  });

  it('reads while another process holds the state lock, and does not wait', async () => {
    const repo = await decideRepo();
    repo.deps.seed(LOCK_FILE, '1\n');
    const slept = repo.deps.sleeps.length;
    expect(valueOf(await localOf(repo.deps).decisionRequest('D-1')).request.id).toBe('D-1');
    expect(repo.deps.sleeps.length).toBe(slept);
    expect(repo.deps.files.get(LOCK_FILE)).toBe('1\n');
  });
});

describe('the local connector: record the answer of the owner', () => {
  const filesOf = (repo: BoardRepo): string[] => [...repo.deps.files.keys()].sort();

  it('writes the record file and a line at the top of log.md in the same commit as the board files', async () => {
    const repo = await decideRepo();
    const spy = proofSpy();
    const recorded = valueOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
    expect(recorded).toEqual({ id: 'D-1', option: 'a', path: RECORD_PATH, outcome: 'stored', warning: null });
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]?.message).toBe('chore: record decision D-1');
    expect([...(repo.commits[0]?.staged ?? [])].sort()).toEqual(
      [fileNames.waiting, fileNames.decisionLog, RECORD_PATH, stateRel.profileLog].sort(),
    );
    const record = repo.textOf(RECORD_PATH) ?? '';
    expect(record).toContain('decided_by: owner');
    expect(record).toContain(`context: ${NODE}`);
    expect(record).toContain(`time: ${AT}`);
    expect(repo.textOf(stateRel.profileLog)).toBe(`# Decision log\n\n- 2030-01-02 D-1: a ([[${RECORD_NAME.slice(0, -3)}]])\n`);
    expect(spy.calls).toEqual([{ id: 'D-1', option: 'a', hash: HASH, at: AT }]);
  });

  it('takes the request off the waiting file and adds the row with by, the option and the canonical text', async () => {
    const repo = await decideRepo({ waiting: waitingOf(ENTRY, { ...ENTRY, id: 'D-2' }) });
    valueOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
    expect(valueOf(parseWaiting(repo.textOf(fileNames.waiting) ?? '')).items.map((entry) => entry.id)).toEqual(['D-2']);
    const row = valueOf(parseDecisionLog(repo.textOf(fileNames.decisionLog) ?? '')).rows[0]?.record;
    expect(row).toEqual(answerRow());
    expect(row?.['request']).toBe(TEXT);
    expect(requestHashOf(String(row?.['request']))).toBe(HASH);
  });

  it('keeps the rows and the lines that were there, and puts the new line at the top of the list', async () => {
    const old = closedRow({ item: 'D-0: Old' });
    const repo = await decideRepo({ decisionLog: logOf(old), profileLog: '# Decision log\n\n- 2029-12-31 D-0: a ([[older]])\n' });
    valueOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
    expect(valueOf(parseDecisionLog(repo.textOf(fileNames.decisionLog) ?? '')).rows.map((row) => row.record)).toEqual([old, answerRow()]);
    expect(repo.textOf(stateRel.profileLog)).toBe(
      `# Decision log\n\n- 2030-01-02 D-1: a ([[${RECORD_NAME.slice(0, -3)}]])\n- 2029-12-31 D-0: a ([[older]])\n`,
    );
  });

  it('makes the decisions folder and gives log.md its first text after a fresh init', async () => {
    const repo = await decideRepo();
    expect(await kindAt(repo, DECISIONS_DIR)).toBeNull();
    expect(repo.deps.files.has(PROFILE_LOG_PATH)).toBe(false);
    valueOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
    expect(await kindAt(repo, DECISIONS_DIR)).toBe('dir');
    expect(repo.textOf(stateRel.profileLog)).toContain('# Decision log');
  });

  it('puts the note in the record and the date of the time in the file name', async () => {
    const repo = await decideRepo();
    valueOf(await localOf(repo.deps).recordDecision(callOf({ note: 'cheaper', at: '2030-03-04T23:59:59.000Z' }), proofSpy().writer));
    const path = join(stateRel.profileDecisions, '2030-03-04-d-1-pick-a-plan.md');
    expect(repo.textOf(path)).toContain('Note: "cheaper"');
    expect(repo.textOf(fileNames.decisionLog)).toContain('"date": "2030-03-04"');
  });

  it('writes the owner record first: under the state lock, with the folder made and no board file changed yet', async () => {
    const repo = await decideRepo();
    const seen: unknown[] = [];
    const spy = proofSpy(undefined, async () => {
      seen.push(
        repo.deps.files.has(LOCK_FILE),
        await kindAt(repo, DECISIONS_DIR),
        repo.textOf(fileNames.waiting),
        repo.textOf(fileNames.decisionLog),
        repo.deps.files.has(RECORD_FILE),
        repo.commits.length,
      );
    });
    valueOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
    expect(seen).toEqual([true, 'dir', waitingOf(ENTRY), jsonOf({ rows: [] }), false, 0]);
    expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('gives the warning of the writer to the result and still writes the board copies', async () => {
    const repo = await decideRepo();
    const spy = proofSpy(ok({ outcome: 'stored', warning: 'the lock file stays' }));
    const recorded = valueOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
    expect(recorded.warning).toBe('the lock file stays');
    expect(repo.commits).toHaveLength(1);
  });

  it('completes the copies of an orphan record: the writer says existing, and the result says so', async () => {
    const repo = await decideRepo();
    const spy = proofSpy(ok({ outcome: 'existing', warning: null }));
    const recorded = valueOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
    expect(recorded.outcome).toBe('existing');
    expect(repo.commits).toHaveLength(1);
  });

  describe('a check that fails under the lock makes no folder, no store write and no commit', () => {
    const BIG_LOG_ROW = closedRow({ item: 'D-9: Big', pad: 'x'.repeat(maxFileBytes - 200) });
    const CASES: readonly (readonly [string, DecideSetup, Partial<DecisionRecordCall>, string])[] = [
      ['the request changed after the prompt', { waiting: waitingOf(CHANGED_ENTRY) }, {}, 'changed after the prompt'],
      ['the request closed after the prompt', { waiting: waitingOf(), decisionLog: logOf(closedRow()) }, {}, 'not open'],
      ['the new text of the decision log is over the cap', { decisionLog: logOf(BIG_LOG_ROW) }, {}, fileNames.decisionLog],
      [
        'the new text of log.md is over the cap',
        { profileLog: `# Decision log\n\n${'x'.repeat(maxFileBytes - 20)}` },
        {},
        stateRel.profileLog,
      ],
      ['the option is not one of the request', {}, { option: 'z' }, 'option'],
    ];

    it.each(CASES)('refuses when %s, exit 1, and writes nothing', async (_name, setup, overrides, phrase) => {
      const repo = await decideRepo(setup);
      const before = new Map(repo.deps.files);
      const spy = proofSpy();
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(overrides), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(phrase);
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
      expect(await kindAt(repo, DECISIONS_DIR)).toBeNull();
      expect(repo.deps.files).toEqual(before);
    });

    it('names the cap and says how to make room, for the text of log.md', async () => {
      const repo = await decideRepo({ profileLog: `# Decision log\n\n${'x'.repeat(maxFileBytes - 20)}` });
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
      expect(error.message).toContain(String(maxFileBytes));
      expect(error.hint).toContain('Move old lines');
      expect(error.hint).toContain(commandText(PASSED_COMMAND));
    });

    const REMEDIES: readonly (readonly [string, DecideSetup, (board: LocalBoard, repo: BoardRepo) => Promise<CliResult<unknown>>])[] = [
      [
        'the profile log is over the cap',
        { profileLog: `# Decision log\n\n${'x'.repeat(maxFileBytes - 20)}` },
        (board) => board.recordDecision(callOf(), proofSpy().writer),
      ],
      [
        'the record path has text already',
        {},
        (board, repo) => {
          repo.deps.seed(RECORD_FILE, 'older text\n');
          return board.recordDecision(callOf(), proofSpy().writer);
        },
      ],
      ['no variable names a state folder', { env: {} }, (board) => board.decisionRequest('D-1')],
    ];

    it.each(REMEDIES)('names the command that the connector was given, and no other, when %s', async (_name, setup, run) => {
      const repo = await decideRepo(setup);
      const error = errorOf(await run(localOf(repo.deps, commands.decide), repo));
      expect(error.hint).toContain(`"${commandText(commands.decide)}"`);
      expect(error.hint).not.toContain(commandText(commands.start));
    });

    it('names the cap and says not to remove rows, for the text of the decision log', async () => {
      const repo = await decideRepo({ decisionLog: logOf(BIG_LOG_ROW) });
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
      expect(error.message).toContain(String(maxFileBytes));
      expect(error.hint).toContain('Do not remove rows');
    });

    it('refuses a record path that has text already, and overwrites no file', async () => {
      const repo = await decideRepo();
      repo.deps.seed(RECORD_FILE, 'older text\n');
      const spy = proofSpy();
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(RECORD_NAME);
      expect(repo.textOf(RECORD_PATH)).toBe('older text\n');
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
    });

    it('refuses a time that is not an ISO time in UTC before it takes the lock', async () => {
      const repo = await decideRepo();
      const spy = proofSpy();
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf({ at: 'yesterday' }), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(spy.calls).toEqual([]);
      expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
    });

    it('names log.md and stops before the store write when it has a change that is not committed', async () => {
      const repo = await decideRepo({ profileLog: '# Decision log\n' });
      const dirty = {
        ...repo.deps,
        run: async (command: string, args: readonly string[], options?: Parameters<Deps['run']>[2]) =>
          args.includes('status') ? exited(0, ` M ${stateRel.profileLog}\0`) : repo.deps.run(command, args, options),
      };
      const spy = proofSpy();
      const error = errorOf(await localOf(dirty).recordDecision(callOf(), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(stateRel.profileLog);
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
    });
  });

  describe('a link or a missing folder stops the call before the store write', () => {
    it.each([
      ['the profile folder', PROFILE_DIR],
      ['the decisions folder', DECISIONS_DIR],
    ])('exits 4 for a link at %s, writes no record and keeps the files', async (_name, path) => {
      const repo = await decideRepo();
      repo.deps.seedDir(DECISIONS_DIR);
      const before = new Map(repo.deps.files);
      const spy = proofSpy();
      const error = errorOf(await localOf(linkAt(repo.deps, path)).recordDecision(callOf(), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
      expect(repo.deps.files).toEqual(before);
    });

    it('exits 4 for a link that appears at the decisions folder after the read, and writes no record', async () => {
      const repo = await decideRepo();
      let seen = 0;
      const racing: Deps = {
        ...repo.deps,
        fs: {
          ...repo.deps.fs,
          lstat: async (path) => {
            if (path !== DECISIONS_DIR) return repo.deps.fs.lstat(path);
            seen += 1;
            return seen > 1 ? ok('link') : repo.deps.fs.lstat(path);
          },
        },
      };
      const spy = proofSpy();
      const error = errorOf(await localOf(racing).recordDecision(callOf(), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
    });

    it('exits 1 and writes no record when the profile folder is not there', async () => {
      const repo = await decideRepo({ profile: false });
      const spy = proofSpy();
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), spy.writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain(dirs.profile);
      expect(spy.calls).toEqual([]);
      expect(repo.commits).toEqual([]);
      expect(await kindAt(repo, DECISIONS_DIR)).toBeNull();
    });
  });

  describe('a failure of the writer, or of the commit after it', () => {
    const SAVED = 'saved in the owner store';

    const failingWriter = (): ProofSpy => proofSpy(failure('the decision was not recorded: the file is full'));

    it('gives the error of the writer as it is, and no line about a saved answer, and changes no board file', async () => {
      const repo = await decideRepo();
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), failingWriter().writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toBe('the decision was not recorded: the file is full');
      expect(error.hint).toBeUndefined();
      expect(repo.commits).toEqual([]);
      expect(repo.textOf(fileNames.waiting)).toBe(waitingOf(ENTRY));
      expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
    });

    /** The deps in which the commit of the helper ends as `how` says. */
    const committing = (repo: BoardRepo, how: 'fails' | 'lands' | 'lost-head'): Deps => {
      let attempted = false;
      return {
        ...repo.deps,
        run: async (command, args, options) => {
          if (args.includes('commit')) {
            attempted = true;
            if (how === 'lands') {
              await repo.deps.run(command, args, options);
              return exited(1, '', 'time limit');
            }
            return exited(1, '', 'git refused');
          }
          if (how === 'lost-head' && attempted && args.includes('rev-parse')) return failure('cannot run git: ENOENT');
          return repo.deps.run(command, args, options);
        },
      };
    };

    it('says that the answer is saved and the same command finishes the copies, when the files are put back', async () => {
      const repo = await decideRepo();
      const error = errorOf(await localOf(committing(repo, 'fails')).recordDecision(callOf(), proofSpy().writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain(SAVED);
      expect(error.hint).toContain(`"${commandText(commands.decide)} D-1 a"`);
      expect(repo.textOf(fileNames.waiting)).toBe(waitingOf(ENTRY));
      expect(repo.deps.files.has(RECORD_FILE)).toBe(false);
    });

    it('adds the warning of the writer to the hint after the saved line, when the commit fails after the store write', async () => {
      const repo = await decideRepo();
      const writer = proofSpy(ok({ outcome: 'stored', warning: 'the lock file stays' })).writer;
      const error = errorOf(await localOf(committing(repo, 'fails')).recordDecision(callOf(), writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain(SAVED);
      expect(error.hint?.endsWith('the lock file stays')).toBe(true);
    });

    it('finishes with exit 0 when the same command runs again after the files were put back', async () => {
      const repo = await decideRepo();
      errorOf(await localOf(committing(repo, 'fails')).recordDecision(callOf(), proofSpy().writer));
      const again = proofSpy(ok({ outcome: 'existing', warning: null }));
      const recorded = valueOf(await localOf(repo.deps).recordDecision(callOf(), again.writer));
      expect(recorded.outcome).toBe('existing');
      expect(repo.commits).toHaveLength(1);
    });

    it('says that the answer is recorded and the commit is made, with no retry line, when the commit landed', async () => {
      const repo = await decideRepo();
      const error = errorOf(await localOf(committing(repo, 'lands')).recordDecision(callOf(), proofSpy().writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.hint).toContain('recorded');
      expect(error.hint).toContain('commit is made');
      expect(error.hint).not.toContain(SAVED);
      expect(error.hint).not.toContain('again');
      expect(repo.commits).toHaveLength(1);
    });

    it('says that the answer is saved, gives the git check line and adds no retry line when the head cannot be read', async () => {
      const repo = await decideRepo();
      const error = errorOf(await localOf(committing(repo, 'lost-head')).recordDecision(callOf(), proofSpy().writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('git log -1 --stat');
      expect(error.hint).toContain(SAVED);
      expect(error.hint).toContain('git log -1 --stat');
      expect(error.hint).not.toContain('again');
    });

    it('says that the answer is saved, gives the git check line and adds no retry line when a file cannot be put back', async () => {
      const repo = await decideRepo();
      // The first write of the waiting file is the new text, the second is the put back after the failed commit.
      const waitingFile = join(LAYOUT.stateDir, fileNames.waiting);
      const failing = withFailingWrites(committing(repo, 'fails'), (path, attempt) => path === waitingFile && attempt === 2);
      const error = errorOf(await localOf(failing).recordDecision(callOf(), proofSpy().writer));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(error.message).toContain('disk full');
      expect(error.hint).toContain(SAVED);
      expect(error.hint).toContain('git log -1 --stat');
      expect(error.hint).not.toContain('again');
    });

    it('adds no saved line to a failure that comes before the store write', async () => {
      const repo = await decideRepo({ waiting: waitingOf(CHANGED_ENTRY) });
      const error = errorOf(await localOf(repo.deps).recordDecision(callOf(), proofSpy().writer));
      expect(error.hint ?? '').not.toContain(SAVED);
      expect(filesOf(repo)).not.toContain(RECORD_FILE);
    });
  });
});

describe('the local connector: request add and request close read the owner decision file', () => {
  const UNREADABLE: readonly (readonly [string, string])[] = [
    ['text that is not JSON', 'not json'],
    ['a file with another schema number', jsonOf({ schema: 2, records: [] })],
  ];

  it('numbers a new request above the highest D-n of the store, the waiting file and the log', async () => {
    const repo = await decideRepo({ decisionLog: logOf(closedRow({ item: 'D-3: Old' })), store: storeOf(storedRecord({ id: 'D-7' })) });
    expect(valueOf(await localOf(repo.deps).askDecision(DECISION))).toBe('D-8');
    expect(repo.commits).toHaveLength(1);
  });

  it('numbers a new request above a stored D-n that the waiting file and the log no longer hold', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), store: storeOf(storedRecord({ id: 'D-4' })) });
    expect(valueOf(await localOf(repo.deps).askDecision(DECISION))).toBe('D-5');
  });

  it.each([
    ['another node', { node: 'other' }],
    ['another root', { root: '/h/other' }],
  ])('does not count a record of %s', async (_name, overrides) => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ ...overrides, id: 'D-7' })) });
    expect(valueOf(await localOf(repo.deps).askDecision(DECISION))).toBe('D-2');
  });

  it('counts no record when no variable names a state folder', async () => {
    const repo = await decideRepo({ env: {}, store: storeOf(storedRecord({ id: 'D-7' })) });
    expect(valueOf(await localOf(repo.deps).askDecision(DECISION))).toBe('D-2');
  });

  it('reads the decision file under the state lock and leaves its lock file alone', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ id: 'D-7' })) });
    const before = repo.deps.files.get(DECISIONS_PATH);
    valueOf(await localOf(repo.deps).askDecision(DECISION));
    expect(repo.deps.files.get(DECISIONS_PATH)).toBe(before);
    expect([...repo.deps.files.keys()].filter((path) => path.startsWith(DECISIONS_PATH) && path !== DECISIONS_PATH)).toEqual([]);
  });

  it.each(UNREADABLE)('exits 1, names the decision file and writes nothing for a request add with %s', async (_name, store) => {
    const repo = await decideRepo({ store });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).askDecision(DECISION));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(DECISIONS_PATH);
    expect(error.message).toContain('cannot be read');
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('exits 4 and writes nothing for a request add when the decision file would be inside the factory folder', async () => {
    const repo = await decideRepo({ env: { [env.stateHome]: `${HOME}/state`, [env.userHome]: '/home/me' } });
    const before = new Map(repo.deps.files);
    expect(exitOf(await localOf(repo.deps).askDecision(DECISION))).toBe(4);
    expect(repo.deps.files).toEqual(before);
  });

  it('refuses to close a request that has a record, says that the owner answered, names decide, and writes nothing', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord()) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('D-1');
    expect(error.message).toContain('answered');
    expect(error.hint).toContain(commandText(commands.decide));
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('refuses to close a request whose record has another request hash', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ hash: requestHashOf(requestTextOf(CHANGED_ENTRY)) })) });
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('answered');
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['another D-n', { id: 'D-2' }],
    ['another node', { node: 'other' }],
    ['another root', { root: '/h/other' }],
  ])('closes a request when the only record is a record of %s', async (_name, overrides) => {
    const repo = await decideRepo({ store: storeOf(storedRecord(overrides)) });
    expect(valueOf(await localOf(repo.deps).closeRequest('D-1'))).toEqual({ id: 'D-1', title: 'Pick a plan', decider: null });
    expect(repo.commits).toHaveLength(1);
  });

  it('closes a request when no variable names a state folder', async () => {
    const repo = await decideRepo({ env: {}, store: storeOf(storedRecord()) });
    expect(valueOf(await localOf(repo.deps).closeRequest('D-1')).id).toBe('D-1');
  });

  it.each(UNREADABLE)('exits 1, names the decision file and writes nothing for a request close with %s', async (_name, store) => {
    const repo = await decideRepo({ store });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(DECISIONS_PATH);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('keeps the message of an answered row for a number that the log holds, with a record in the store', async () => {
    const repo = await decideRepo({ waiting: waitingOf(), decisionLog: logOf(answerRow()), store: storeOf(storedRecord()) });
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(fileNames.waiting);
  });

  it.each(['owner', 'Coordinator', ''])('refuses the decider %j of a close with exit 2, names no internal detail, and writes nothing', async (decider) => {
    const repo = await decideRepo();
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1', { decider: decider as RequestDecider, decision: 'Yes' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('decider');
    expect(error.message).not.toContain(`"${decider}"`);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it.each(Object.values(requestDeciders))('closes a request with the decider %s and records it in the row', async (decider) => {
    const repo = await decideRepo();
    expect(valueOf(await localOf(repo.deps).closeRequest('D-1', { decider, decision: 'Yes' }))).toEqual({ id: 'D-1', title: 'Pick a plan', decider });
    expect(repo.commits).toHaveLength(1);
  });

  it('names the cap and says not to remove rows when the new text of the decision log is over the cap, and writes nothing', async () => {
    const repo = await decideRepo({ decisionLog: logOf(closedRow({ item: 'D-9: Big', pad: 'x'.repeat(maxFileBytes - 200) })) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(error.message).toContain(String(maxFileBytes));
    expect(error.hint).toContain('Do not remove rows');
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });
});

describe('the checked settlement of a close', () => {
  const DATE = '2030-01-02';
  const docs = (): { waiting: ReturnType<typeof parseWaiting>; log: ReturnType<typeof parseDecisionLog> } => ({
    waiting: parseWaiting(waitingOf(ENTRY)),
    log: parseDecisionLog(logOf()),
  });

  it('closes a request with the text and the decider that checkSettlement gave', () => {
    const { waiting, log } = docs();
    const checked = valueOf(checkSettlement({ decider: requestDeciders.delegate, decision: '  Use plan A  ' }));
    const edited = valueOf(closeRequestIn(valueOf(waiting), valueOf(log), 'D-1', DATE, checked));
    expect(edited.closed).toEqual({ id: 'D-1', title: 'Pick a plan', decider: requestDeciders.delegate });
    expect(edited.log).toEqual({ rows: [{ item: 'D-1: Pick a plan', decision: 'Use plan A', date: DATE, decider: requestDeciders.delegate }] });
  });

  it('does not compile a settlement that checkSettlement did not check', () => {
    const { waiting, log } = docs();
    const raw: RequestSettlement = { decider: requestDeciders.coordinator, decision: 'Yes' };
    // @ts-expect-error The settlement of closeRequestIn is the one that checkSettlement made.
    const edited = closeRequestIn(valueOf(waiting), valueOf(log), 'D-1', DATE, raw);
    expect(edited.ok).toBe(true);
  });
});

// The board records: the merge record, the worker mark, the worker field guard, the decision log and the relayed close.

const PR_HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'b'.repeat(40);

/** A result of the record check of a recipe. The brand has no value at run time, so a test cast makes one. */
const checkedRecord = (overrides: Partial<{ stage: string; ref: string; head: string; summary: string }> = {}): CheckedRecord =>
  ({ stage: 'merged', ref: '12', head: PR_HEAD, summary: `PR 12, merge commit ${MERGE_COMMIT}`, ...overrides }) as CheckedRecord;

const workItem = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  item('B-1', { status: 'doing', stage: 'review', lane: 'w1', ...extra });

const boardAfter = (repo: BoardRepo): ReturnType<typeof parseBoard> => parseBoard(repo.textOf(fileNames.board) ?? '', QUEUE);

const itemAfter = (repo: BoardRepo, id: string): Readonly<Record<string, unknown>> => {
  const found = valueOf(boardAfter(repo)).items.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no item ${id}`);
  return found.record;
};

describe('the local connector: record a passed check', () => {
  const ROWS = [
    { name: 'First', items: ['B-1', 'B-2'], release: true },
    { name: 'Alone', items: ['B-1'], note: 'only this one' },
    { name: 'Other', items: ['B-2'] },
    { name: 'Empty', items: [] },
  ];

  it('sets the merged stage, the closed state and the PR head, and keeps the merge commit out of the item', async () => {
    const repo = await repoWith(boardWith([workItem({ zeta: 1 }), item('B-2')]));
    const done = valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'));
    expect(done.changed).toBe(true);
    expect(done.item.status).toBe('done');
    expect(done.item.stage).toBe('merged');
    expect(itemAfter(repo, 'B-1')).toEqual({ ...workItem({ zeta: 1 }), status: 'done', stage: 'merged', merged_pr_head: PR_HEAD });
    expect(repo.textOf(fileNames.board)).not.toContain(MERGE_COMMIT);
  });

  it('takes the item out of each queue row that lists it, drops a row that becomes empty, and keeps the other rows', async () => {
    const repo = await repoWith(boardWith([workItem(), item('B-2')], { [QUEUE]: ROWS }));
    valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'));
    expect(valueOf(boardAfter(repo)).queue).toEqual([
      { name: 'First', items: ['B-2'], release: true },
      { name: 'Other', items: ['B-2'] },
      { name: 'Empty', items: [] },
    ]);
  });

  it('makes one commit of the board file, and its message names the stage and the summary of the check', async () => {
    const repo = await repoWith(boardWith([workItem()]));
    valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'));
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]?.staged).toEqual([fileNames.board]);
    expect(repo.commits[0]?.message).toContain('merged');
    expect(repo.commits[0]?.message).toContain('12');
    expect(repo.commits[0]?.message).toContain(MERGE_COMMIT);
  });

  it('sets the stage that the check names, and exits 2 with no write for a stage that the recipe does not list', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const connector = connectorOf(repo);
    expect(exitOf(await connector.recordChecked('B-1', checkedRecord({ stage: 'unlisted' }), 'w1'))).toBe(2);
    expectUntouched(repo, board);
    valueOf(await connector.recordChecked('B-1', checkedRecord({ stage: 'released' }), 'w1'));
    expect(itemAfter(repo, 'B-1')).toMatchObject({ stage: 'released', status: 'done' });
  });

  it('is a success with no commit when the same record is made again', async () => {
    const repo = await repoWith(boardWith([workItem()], { [QUEUE]: ROWS }));
    const connector = connectorOf(repo);
    valueOf(await connector.recordChecked('B-1', checkedRecord(), 'w1'));
    const written = repo.textOf(fileNames.board);
    const again = valueOf(await connector.recordChecked('B-1', checkedRecord({ summary: `PR 12, merge commit ${'c'.repeat(40)}` }), 'w1'));
    expect(again.changed).toBe(false);
    expect(repo.commits).toHaveLength(1);
    expect(repo.textOf(fileNames.board)).toBe(written);
  });

  it('records the item and takes it out of the queue when the item holds the stage, the state and the head and a queue row lists it', async () => {
    const recorded = workItem({ status: 'done', stage: 'merged', merged_pr_head: PR_HEAD });
    const repo = await repoWith(boardWith([recorded, item('B-2')], { [QUEUE]: ROWS }));
    const done = valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'));
    expect(done.changed).toBe(true);
    expect(repo.commits).toHaveLength(1);
    expect(valueOf(boardAfter(repo)).queue).toEqual([
      { name: 'First', items: ['B-2'], release: true },
      { name: 'Other', items: ['B-2'] },
      { name: 'Empty', items: [] },
    ]);
    expect(itemAfter(repo, 'B-1')).toEqual(recorded);
  });

  it('exits 1 and writes nothing when the item records another PR head', async () => {
    const board = boardWith([workItem({ merged_pr_head: 'd'.repeat(40), status: 'done', stage: 'merged' })]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'))).toBe(1);
    expectUntouched(repo, board);
  });

  it('exits 1 and writes nothing when another item records the PR head already, and names that item and the command in the remedy', async () => {
    const board = boardWith([workItem(), item('B-2', { status: 'done', stage: 'merged', merged_pr_head: PR_HEAD })], { [QUEUE]: ROWS });
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1'));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-2');
    expect(error.message).not.toContain(PR_HEAD);
    expect(error.hint).toContain(commandText(commandLines.itemRecord));
    expectUntouched(repo, board);
  });

  it('records the item when the other items record other PR heads', async () => {
    const repo = await repoWith(boardWith([workItem(), item('B-2', { status: 'done', stage: 'merged', merged_pr_head: 'd'.repeat(40) })]));
    expect(valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), 'w1')).changed).toBe(true);
  });

  it('keeps a rerun of the same item a success with no commit, whatever the other items record', async () => {
    const repo = await repoWith(boardWith([workItem(), item('B-2', { status: 'done', stage: 'merged', merged_pr_head: 'd'.repeat(40) })]));
    const connector = connectorOf(repo);
    valueOf(await connector.recordChecked('B-1', checkedRecord(), 'w1'));
    expect(valueOf(await connector.recordChecked('B-1', checkedRecord(), 'w1')).changed).toBe(false);
    expect(repo.commits).toHaveLength(1);
  });

  it.each([
    ['another worker', workItem({ lane: 'w2' }), 'w1'],
    ['no worker any more', item('B-1', { status: 'doing', stage: 'review' }), 'w1'],
    ['a new worker', workItem(), null],
    ['a worker that is not text', workItem({ lane: 7 }), null],
  ])('exits 1 and writes nothing when the worker field holds %s since the check', async (_name, stored, worker) => {
    const board = boardWith([stored], { [QUEUE]: ROWS });
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), worker));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-1');
    expectUntouched(repo, board);
  });

  it('records the merge of an item that has no worker when the check bound none', async () => {
    const repo = await repoWith(boardWith([item('B-1', { stage: 'review' })]));
    expect(valueOf(await connectorOf(repo).recordChecked('B-1', checkedRecord(), null)).changed).toBe(true);
  });

  it.each([
    ['an item that is not on the board', 'B-9'],
    ['an id that is not of the form B-n', 'x-1'],
  ])('exits 2 and writes nothing for %s', async (_name, id) => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).recordChecked(id, checkedRecord(), 'w1'))).toBe(2);
    expectUntouched(repo, board);
  });

  it('exits 2 and writes nothing when the recipe has no stage list', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const bare = connectorOf(repo, { recipe: { queueKey: QUEUE } });
    expect(exitOf(await bare.recordChecked('B-1', checkedRecord(), 'w1'))).toBe(2);
    expectUntouched(repo, board);
  });

  it('exits 2 and writes nothing when the setup names no closed state', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const { closed: _closed, ...open } = sampleBoard();
    expect(exitOf(await connectorOf(repo, { config: open }).recordChecked('B-1', checkedRecord(), 'w1'))).toBe(2);
    expectUntouched(repo, board);
  });

  it('stops with exit 4 for a hosted tracker kind, before it reads the board', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo, { tracker: 'github' }).recordChecked('B-1', checkedRecord(), 'w1'))).toBe(4);
    expectUntouched(repo, board);
  });
});

describe('the local connector: take a worker off an item', () => {
  it('deletes the worker key, keeps the state and the stage, and marks the former worker', async () => {
    const repo = await repoWith(boardWith([workItem({ zeta: 1 })]));
    const done = valueOf(await connectorOf(repo).unassignItem('B-1'));
    expect(done.worker).toBe('w1');
    expect(done.item.status).toBe('doing');
    expect(done.item.stage).toBe('review');
    const { lane: _lane, ...rest } = workItem({ zeta: 1 });
    expect(itemAfter(repo, 'B-1')).toEqual({ ...rest, unassigned_from: ['w1'] });
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]?.staged).toEqual([fileNames.board]);
  });

  it('adds the worker to the former workers that the item has, and keeps the order of the list', async () => {
    const repo = await repoWith(boardWith([workItem({ unassigned_from: ['w0'] })]));
    valueOf(await connectorOf(repo).unassignItem('B-1'));
    expect(itemAfter(repo, 'B-1')['unassigned_from']).toEqual(['w0', 'w1']);
  });

  it('names a former worker once', async () => {
    const repo = await repoWith(boardWith([workItem({ unassigned_from: ['w1', 'w0'] })]));
    valueOf(await connectorOf(repo).unassignItem('B-1'));
    expect(itemAfter(repo, 'B-1')['unassigned_from']).toEqual(['w1', 'w0']);
    expect(itemAfter(repo, 'B-1')).not.toHaveProperty('lane');
  });

  it('keeps the queue as it is', async () => {
    const rows = [{ name: 'First', items: ['B-1'] }];
    const repo = await repoWith(boardWith([workItem()], { [QUEUE]: rows }));
    valueOf(await connectorOf(repo).unassignItem('B-1'));
    expect(valueOf(boardAfter(repo)).queue).toEqual(rows);
  });

  it.each([
    ['an item with no worker', item('B-1'), 'the item B-1 has no worker to take off'],
    ['a worker field that is not text', workItem({ lane: 7 }), 'the worker field of B-1 does not hold text'],
    ['a worker field that is null', workItem({ lane: null }), 'the worker field of B-1 does not hold text'],
  ])('exits 2, says why, and writes nothing for %s', async (_name, stored, message) => {
    const board = boardWith([stored]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).unassignItem('B-1'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe(message);
    expectUntouched(repo, board);
  });

  it('exits 1 and writes nothing when the former workers are not a list of text', async () => {
    const board = boardWith([workItem({ unassigned_from: ['w0', 3] })]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).unassignItem('B-1'))).toBe(1);
    expectUntouched(repo, board);
  });

  it('exits 2 and writes nothing past the cap of former workers, and still unassigns a worker that is named already', async () => {
    const full = Array.from({ length: markLimits.maxFormerWorkers }, (_, at) => `w-${at}`);
    const board = boardWith([workItem({ unassigned_from: full })]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).unassignItem('B-1'));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain(`"${commandText(commandLines.itemUnassign)} B-1"`);
    expect(error.hint).toContain('unassigned_from');
    expectUntouched(repo, board);
    const named = await repoWith(boardWith([workItem({ lane: 'w-3', unassigned_from: full })]));
    valueOf(await connectorOf(named).unassignItem('B-1'));
    expect(itemAfter(named, 'B-1')['unassigned_from']).toEqual(full);
  });

  it('exits 2 and writes nothing when the setup names no worker field', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const { worker_field: _field, ...bare } = sampleBoard();
    expect(exitOf(await connectorOf(repo, { config: bare }).unassignItem('B-1'))).toBe(2);
    expectUntouched(repo, board);
  });

  it.each([
    ['an item that is not on the board', 'B-9'],
    ['an id that is not of the form B-n', 'nope'],
  ])('exits 2 and writes nothing for %s', async (_name, id) => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).unassignItem(id))).toBe(2);
    expectUntouched(repo, board);
  });

  it('stops with exit 4 for a hosted tracker kind', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo, { tracker: 'github' }).unassignItem('B-1'))).toBe(4);
    expectUntouched(repo, board);
  });
});

describe('the local connector: the worker field of an item that has a worker', () => {
  it('refuses an update that replaces the worker with exit 2, names the item and the command that frees the worker, and writes nothing', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: 'w2' } }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe(workerFieldGuard.message('B-1'));
    expect(error.hint).toBe(workerFieldGuard.remedy('B-1'));
    expect(error.hint).toContain(commandLines.itemUnassign);
    expectUntouched(repo, board);
  });

  it('refuses an update that clears the worker with exit 2 and the remedy that frees the worker, and writes nothing', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: '' } }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe(workerFieldGuard.message('B-1'));
    expect(error.hint).toBe(workerFieldGuard.remedy('B-1'));
    expectUntouched(repo, board);
  });

  it('keeps the refusal of an empty worker value for an item that has no worker, and writes nothing', async () => {
    const board = boardWith([item('B-1')]);
    const repo = await repoWith(board);
    const error = errorOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: '' } }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('the field lane takes a token');
    expectUntouched(repo, board);
  });

  it('refuses a patch that changes the worker together with the title, and changes nothing of the title', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).updateItem('B-1', { title: 'Changed', fields: { lane: 'w2' } }))).toBe(2);
    expectUntouched(repo, board);
  });

  it('treats a patch with the same worker as no change: no commit, the text as it is', async () => {
    const board = boardWith([workItem()]);
    const repo = await repoWith(board);
    expect(valueOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: 'w1' } })).id).toBe('B-1');
    expectUntouched(repo, board);
  });

  it('changes the other fields and the title of an item that has a worker', async () => {
    const repo = await repoWith(boardWith([workItem()]));
    valueOf(await connectorOf(repo).updateItem('B-1', { title: 'Changed', fields: PRIORITY }));
    expect(itemAfter(repo, 'B-1')).toMatchObject({ title: 'Changed', priority: 'P1', lane: 'w1' });
  });

  it('assigns a worker to an item that has none', async () => {
    const repo = await repoWith(boardWith([item('B-1')]));
    valueOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: 'w2' } }));
    expect(itemAfter(repo, 'B-1')['lane']).toBe('w2');
  });

  it('adds an item with a worker', async () => {
    const repo = await repoWith(EMPTY_BOARD);
    const added = valueOf(await connectorOf(repo).addItem({ title: 'New', fields: { ...PRIORITY, lane: 'w2' } }));
    expect(added.record['lane']).toBe('w2');
  });

  it('frees the worker with an unassign, and then accepts a new worker', async () => {
    const repo = await repoWith(boardWith([workItem()]));
    const connector = connectorOf(repo);
    valueOf(await connector.unassignItem('B-1'));
    valueOf(await connector.updateItem('B-1', { fields: { lane: 'w2' } }));
    expect(itemAfter(repo, 'B-1')).toMatchObject({ lane: 'w2', unassigned_from: ['w1'] });
  });

  it('stays refused when the list of former workers is at its cap, so no update frees the field', async () => {
    const full = Array.from({ length: markLimits.maxFormerWorkers }, (_, at) => `w-${at}`);
    const board = boardWith([workItem({ unassigned_from: full })]);
    const repo = await repoWith(board);
    const connector = connectorOf(repo);
    expect(exitOf(await connector.updateItem('B-1', { fields: { lane: 'w2' } }))).toBe(2);
    expect(exitOf(await connector.unassignItem('B-1'))).toBe(2);
    expectUntouched(repo, board);
  });

  it('refuses to change a stored value that is not text, whatever the patch holds', async () => {
    const board = boardWith([workItem({ lane: null })]);
    const repo = await repoWith(board);
    expect(exitOf(await connectorOf(repo).updateItem('B-1', { fields: { lane: 'w2' } }))).toBe(2);
    expectUntouched(repo, board);
  });

  it('checks the record that the lock read, so a worker that arrived after the first look still stops the patch', () => {
    const doc = valueOf(parseBoard(boardWith([workItem()]), QUEUE));
    const changes = valueOf(checkPatch({ recipe: softwareBoard, config: sampleBoard() }, { fields: { lane: 'w2' } }));
    expect(exitOf(changeItemIn(doc, 'B-1', changes, 'lane'))).toBe(2);
    expect(valueOf(changeItemIn(doc, 'B-1', changes, undefined)).top).not.toBeNull();
  });
});

describe('the local connector: log a decision', () => {
  const UNREADABLE: readonly (readonly [string, string])[] = [
    ['text that is not JSON', 'not json'],
    ['a file with another schema number', jsonOf({ schema: 2, records: [] })],
  ];
  const LOGGED = { title: 'Pick a plan', decider: requestDeciders.coordinator, decision: 'Use plan A' } as const;

  it('writes one row to the decision log with the next id, and no waiting entry', async () => {
    const repo = await decideRepo({ waiting: waitingOf(ENTRY), decisionLog: logOf(closedRow({ item: 'D-4: Old' })) });
    expect(valueOf(await localOf(repo.deps).logDecision(LOGGED))).toBe('D-5');
    expect(valueOf(parseDecisionLog(repo.textOf(fileNames.decisionLog) ?? '')).rows.map((row) => row.record)).toEqual([
      closedRow({ item: 'D-4: Old' }),
      { item: 'D-5: Pick a plan', decision: 'Use plan A', date: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) as unknown, decider: 'coordinator' },
    ]);
    expect(repo.textOf(fileNames.waiting)).toBe(waitingOf(ENTRY));
  });

  it('makes one commit that holds only the decision log', async () => {
    const repo = await decideRepo();
    valueOf(await localOf(repo.deps).logDecision(LOGGED));
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.decisionLog]]);
  });

  it('gives the id after the highest of the waiting file, the log and the owner store', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ id: 'D-7' })) });
    expect(valueOf(await localOf(repo.deps).logDecision(LOGGED))).toBe('D-8');
  });

  it('writes no owner record and no profile file, and has no owner key in the row', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ id: 'D-7' })) });
    const before = new Map(repo.deps.files);
    valueOf(await localOf(repo.deps).logDecision({ ...LOGGED, decider: requestDeciders.delegate }));
    const changed = [...repo.deps.files.keys()].filter((path) => repo.deps.files.get(path) !== before.get(path));
    expect(changed).toEqual([LOG_PATH]);
    expect(repo.textOf(fileNames.decisionLog)).not.toContain('"by"');
  });

  it.each([
    ['the owner as the decider', { ...LOGGED, decider: 'owner' as RequestDecider }],
    ['a decision with a line break', { ...LOGGED, decision: 'one\ntwo' }],
    ['an empty decision', { ...LOGGED, decision: '  ' }],
    ['a title with a line break', { ...LOGGED, title: 'one\ntwo' }],
    ['an empty title', { ...LOGGED, title: '' }],
  ])('refuses %s with exit 2 and writes nothing', async (_name, input) => {
    const repo = await decideRepo();
    const before = new Map(repo.deps.files);
    expect(exitOf(await localOf(repo.deps).logDecision(input))).toBe(2);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it.each(UNREADABLE)('exits 1, names the decision file and writes nothing for an owner store with %s', async (_name, store) => {
    const repo = await decideRepo({ store });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).logDecision(LOGGED));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(DECISIONS_PATH);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('exits 1 and writes nothing when the new text of the decision log is over the cap', async () => {
    const repo = await decideRepo({ decisionLog: logOf(closedRow({ item: 'D-9: Big', pad: 'x'.repeat(maxFileBytes - 200) })) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).logDecision(LOGGED));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('stops with exit 4 for a hosted tracker kind', async () => {
    const repo = await decideRepo();
    const hosted = createLocalBoard(repo.deps, LAYOUT, {
      queueKey: QUEUE,
      recipe: softwareBoard,
      config: sampleBoard(),
      command: PASSED_COMMAND,
      tracker: 'github',
      node: NODE,
    });
    expect(exitOf(await hosted.logDecision(LOGGED))).toBe(4);
    expect(repo.commits).toEqual([]);
  });
});

describe('the local connector: close a request with a relayed answer', () => {
  const RELAYED: RequestSettlement = { decider: requestDeciders.coordinator, decision: 'Use plan A', relayed: true };

  it('writes the coordinator as the decider, the fixed relayed marker, the text as typed and no owner key', async () => {
    const repo = await decideRepo();
    expect(valueOf(await localOf(repo.deps).closeRequest('D-1', RELAYED))).toEqual({ id: 'D-1', title: 'Pick a plan', decider: requestDeciders.coordinator });
    const rows = valueOf(parseDecisionLog(repo.textOf(fileNames.decisionLog) ?? '')).rows;
    expect(rows.map((row) => row.record)).toEqual([
      {
        item: 'D-1: Pick a plan',
        decision: 'Use plan A',
        date: expect.stringMatching(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) as unknown,
        decider: 'coordinator',
        relayed: relayedMarker,
      },
    ]);
    expect(rows[0]?.record).not.toHaveProperty('by');
    expect(repo.textOf(fileNames.waiting)).toBe(waitingOf());
  });

  it('writes no owner record and no profile record, and makes one commit of the two request files', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord({ id: 'D-7' })) });
    const before = new Map(repo.deps.files);
    valueOf(await localOf(repo.deps).closeRequest('D-1', RELAYED));
    const changed = [...repo.deps.files.keys()].filter((path) => repo.deps.files.get(path) !== before.get(path));
    expect(changed.sort()).toEqual([LOG_PATH, WAITING_PATH].sort());
    expect(repo.commits.map((commit) => [...commit.staged].sort())).toEqual([[fileNames.decisionLog, fileNames.waiting].sort()]);
  });

  it('refuses a relayed close of a request that has an owner record, as a plain close does', async () => {
    const repo = await decideRepo({ store: storeOf(storedRecord()) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await localOf(repo.deps).closeRequest('D-1', RELAYED));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('answered');
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('refuses a relayed settlement of any decider but the coordinator with exit 2, and writes nothing', async () => {
    const repo = await decideRepo();
    const before = new Map(repo.deps.files);
    const settlement = { decider: requestDeciders.delegate, decision: 'Yes', relayed: true } as unknown as RequestSettlement;
    expect(exitOf(await localOf(repo.deps).closeRequest('D-1', settlement))).toBe(2);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files).toEqual(before);
  });

  it('refuses a relayed decision with a line break with exit 2, and writes nothing', async () => {
    const repo = await decideRepo();
    const before = new Map(repo.deps.files);
    expect(exitOf(await localOf(repo.deps).closeRequest('D-1', { ...RELAYED, decision: 'one\ntwo' }))).toBe(2);
    expect(repo.deps.files).toEqual(before);
  });

  it('keeps the row of a close with no relay free of the relayed marker', async () => {
    const repo = await decideRepo();
    valueOf(await localOf(repo.deps).closeRequest('D-1', { decider: requestDeciders.coordinator, decision: 'Yes' }));
    expect(repo.textOf(fileNames.decisionLog)).not.toContain('relayed');
  });
});
