import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { exitCodeOf, failure, usageError, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ok } from '../../src/core/result.js';
import { toolNames } from '../../src/core/tools.js';
import { boardKeys, commands, commandText, files as fileNames, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import type { CheckedRecord, RecipeRegistry, RecordCheck, RecordCheckInput } from '../../src/recipes/entry.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { mergeCheck } from '../../src/recipes/software/github-pr.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { branchOf, workCopyOf, writeWorkerRecord } from '../../src/workers/registry.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { inPane } from '../helpers/coordinator-pane.js';
import { BOARD_PATH, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { exited, missingProgram, withFsWatch, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { publishBoard, publishRecipe, publishRegistry } from '../helpers/publish-recipe.js';
import { sampleConfig, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

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

const TRACKS = [
  { id: 'core', name: 'Core', roadmap: true },
  { id: 'docs', name: 'Docs', roadmap: false },
];

const START = boardText([itemRecord('B-1', { stage: 'ticket' })], TRACKS);

const LOCKS = LAYOUT.locksDir;

const run = (repo: BoardRepo, overrides: Partial<ItemOptions>, registry: RecipeRegistry = recipes): Promise<CliResult<CommandOutput>> =>
  runItem(repo.deps, { ...BASE, ...overrides }, registry);

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const exitOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

/** The text that a person reads for the output of a command. */
const outputOf = (result: CliResult<CommandOutput>): string => plainText(valueOf(result));

const textOf = async (repo: BoardRepo, overrides: Partial<ItemOptions>): Promise<string> => outputOf(await run(repo, overrides));

/** The board file, the commits and the lock are as they were: the command stopped before it changed anything. */
const expectUntouched = (repo: BoardRepo, board: string): void => {
  expect(repo.commits).toEqual([]);
  expect(repo.textOf(fileNames.board)).toBe(board);
  expect(repo.deps.files.has(join(LOCKS, `${stateLock.name}${stateLock.lock.suffix}`))).toBe(false);
};

describe('item: each write is one state commit of the local files (TP-22)', () => {
  const WRITES: readonly (readonly [string, Partial<ItemOptions>])[] = [
    ['add', { words: ['add'], title: 'New', fields: ['priority=P1'] }],
    ['update', { words: ['update', 'B-1'], title: 'Changed' }],
    ['move to a state', { words: ['move', 'B-1'], state: 'doing' }],
    ['move to a stage', { words: ['move', 'B-1'], stage: 'building' }],
    ['close', { words: ['close', 'B-1'] }],
  ];

  it.each(WRITES)('M5-1b TP-22 item %s makes one commit that holds only the board file', async (_name, overrides) => {
    const repo = await boardNode({ board: START });
    expect((await run(repo, overrides)).ok).toBe(true);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
  });
});

describe('item: the fields of the setup (TP-25, TP-26)', () => {
  it('M5-1b TP-25 stores a priority and a type on add, and changes them on update', async () => {
    const repo = await boardNode({ board: START });
    expect(await textOf(repo, { words: ['add'], title: 'New', track: 'core', fields: ['priority=P1', 'type=bug'] })).toContain('B-2');
    const added = repo.textOf(fileNames.board) ?? '';
    expect(added).toContain('"priority": "P1"');
    expect(added).toContain('"type": "bug"');
    valueOf(await run(repo, { words: ['update', 'B-2'], fields: ['priority=P2'] }));
    expect(repo.textOf(fileNames.board)).toContain('"priority": "P2"');
    expect(repo.textOf(fileNames.board)).toContain('"type": "bug"');
  });

  it('M5-1b TP-26 refuses a value outside the list with exit 2, names the field, and changes no file', async () => {
    const repo = await boardNode({ board: START });
    const error = errorOf(await run(repo, { words: ['add'], title: 'New', fields: ['priority=P9'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('priority');
    expectUntouched(repo, START);
  });

  it('M5-1b TP-26 refuses a field that the setup does not declare with exit 2, names the field, and changes no file', async () => {
    const repo = await boardNode({ board: START });
    const error = errorOf(await run(repo, { words: ['update', 'B-1'], fields: ['colour=red'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('colour');
    expectUntouched(repo, START);
  });

  it('M5-1b TP-26 gives a new setup with no board block no field, and no state: add exits 2 and points to the examples', async () => {
    const repo = await boardNode({ board: START, config: sampleConfig() });
    const added = errorOf(await run(repo, { words: ['add'], title: 'New' }));
    expect(exitCodeOf[added.kind]).toBe(2);
    expect(added.message).toContain('examples/');
    const field = errorOf(await run(repo, { words: ['update', 'B-1'], fields: ['priority=P1'] }));
    expect(exitCodeOf[field.kind]).toBe(2);
    expect(field.message).toContain('priority');
    expect(field.message).toContain('declares none');
    expectUntouched(repo, START);
  });
});

describe('item move with a stage (TP-73 to TP-76, TP-78, TP-103)', () => {
  it('M5-1b TP-73 sets the stage, keeps the status, and prints one line with the id and the old and new stage', async () => {
    const repo = await boardNode({ board: START });
    const text = await textOf(repo, { words: ['move', 'B-1'], stage: 'building' });
    expect(text.trimEnd().split('\n')).toEqual(['B-1 stage: ticket -> building']);
    const stored = repo.textOf(fileNames.board) ?? '';
    expect(stored).toContain('"stage": "building"');
    expect(stored).toContain('"status": "open"');
  });

  it('M5-1b TP-73 works in a new setup with no board block', async () => {
    const repo = await boardNode({ board: START, config: sampleConfig() });
    const text = await textOf(repo, { words: ['move', 'B-1'], stage: 'review' });
    expect(text).toContain('B-1 stage: ticket -> review');
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-74 refuses an unknown stage with exit 2, lists the stages, and changes no file', async () => {
    const repo = await boardNode({ board: START });
    const error = errorOf(await run(repo, { words: ['move', 'B-1'], stage: 'nope' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain((softwareBoard.stages ?? []).join(', '));
    expectUntouched(repo, START);
  });

  it('M5-1b TP-74 refuses a stage when the recipe has no stage list, with exit 2', async () => {
    const repo = await boardNode({ board: START });
    const bare: RecipeRegistry = [{ ...recipes[0], board: { queueKey: softwareQueueKey } }];
    expect(exitOf(await run(repo, { words: ['move', 'B-1'], stage: 'building' }, bare))).toBe(2);
    expectUntouched(repo, START);
  });

  it('M5-1b TP-74 refuses the state flag and the stage flag together, with exit 2, before it reads a file', async () => {
    const repo = await boardNode({ board: START });
    const touched: string[] = [];
    const result = await runItem(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, words: ['move', 'B-1'], state: 'doing', stage: 'building' }, recipes);
    expect(exitOf(result)).toBe(2);
    expect(touched).toEqual([]);
    expectUntouched(repo, START);
  });

  it('M5-1b TP-74 needs one of the state flag and the stage flag', async () => {
    const repo = await boardNode({ board: START });
    expect(exitOf(await run(repo, { words: ['move', 'B-1'] }))).toBe(2);
    expectUntouched(repo, START);
  });

  it('M5-1b TP-75 makes no commit for a move to the current stage, exits 0, and says that nothing changed', async () => {
    const repo = await boardNode({ board: START });
    const text = await textOf(repo, { words: ['move', 'B-1'], stage: 'ticket' });
    expect(text).toContain('B-1 stage: ticket (no change)');
    expectUntouched(repo, START);
  });

  it('M5-1b TP-75 gives a new item the first stage of the recipe', async () => {
    const repo = await boardNode({ board: START });
    valueOf(await run(repo, { words: ['add'], title: 'New', fields: ['priority=P1'] }));
    const stored = repo.textOf(fileNames.board) ?? '';
    const added = stored.slice(stored.indexOf('"B-2"'));
    expect(added).toContain(`"stage": "${softwareBoard.stages?.[0]}"`);
  });

  it('M5-1b TP-76 refuses a stage that only a flow sets with exit 2, names the flow, and takes no lock', async () => {
    const repo = await boardNode({ board: START });
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    for (const [stage, flow] of Object.entries(softwareBoard.flowOnly ?? {})) {
      const error = errorOf(await runItem(watched, { ...BASE, words: ['move', 'B-1'], stage }, recipes));
      expect(exitCodeOf[error.kind]).toBe(2);
      expect(error.message).toContain(flow);
    }
    expect(touched.filter((path) => path.includes(LOCKS))).toEqual([]);
    expectUntouched(repo, START);
  });

  it('M5-1b TP-103 names the flow that the recipe data gives, for a recipe that is not the software recipe', async () => {
    const stage = Object.keys(publishBoard.flowOnly ?? {})[0] ?? '';
    const base = sampleConfig();
    const config: FactoryConfig = {
      ...base,
      core: { ...base.core, approval: { publish: 'owner', send: 'owner' } },
      recipe: { id: publishRecipe.id, variant: 'plain', projects: [] },
      entry: publishRecipe,
    };
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { stage: 'draft' })], []).replace('"merge"', `"${publishBoard.queueKey}"`), config });
    const error = errorOf(await run(repo, { words: ['move', 'B-1'], stage }, publishRegistry));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(publishBoard.flowOnly?.[stage] ?? 'missing');
    expect(error.message).not.toContain(softwareBoard.flowOnly?.merged ?? 'missing');
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-78 keeps the status on a stage move, and keeps the stage on a close', async () => {
    const repo = await boardNode({ board: START });
    valueOf(await run(repo, { words: ['move', 'B-1'], stage: 'review' }));
    valueOf(await run(repo, { words: ['close', 'B-1'] }));
    const stored = repo.textOf(fileNames.board) ?? '';
    expect(stored).toContain('"status": "done"');
    expect(stored).toContain('"stage": "review"');
    expect(repo.commits).toHaveLength(2);
  });

  it('M5-1b TP-78 moves the state and keeps the stage', async () => {
    const repo = await boardNode({ board: START });
    expect(await textOf(repo, { words: ['move', 'B-1'], state: 'doing' })).toContain('B-1 state: open -> doing');
    expect(repo.textOf(fileNames.board)).toContain('"stage": "ticket"');
  });
});

describe('item add and update with a track (TP-79, TP-81, TP-89)', () => {
  it('M5-1b TP-79 stores a listed track id on add and on update', async () => {
    const repo = await boardNode({ board: START });
    valueOf(await run(repo, { words: ['add'], title: 'New', track: 'core', fields: ['priority=P1'] }));
    valueOf(await run(repo, { words: ['update', 'B-1'], track: 'docs' }));
    const stored = repo.textOf(fileNames.board) ?? '';
    expect(stored).toContain('"track": "core"');
    expect(stored).toContain('"track": "docs"');
  });

  it.each([
    ['add', { words: ['add'], title: 'New', track: 'nope', fields: ['priority=P1'] }],
    ['update', { words: ['update', 'B-1'], track: 'nope' }],
  ] as const)('M5-1b TP-81 item %s with an unknown track exits 2, lists the track ids, and writes nothing', async (_name, overrides) => {
    const repo = await boardNode({ board: START });
    const error = errorOf(await run(repo, overrides));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('core, docs');
    expectUntouched(repo, START);
  });

  it('M5-1b TP-89 gives a new item the id after the highest one, so no id that exists is used again, closed items included', async () => {
    const board = boardText([itemRecord('B-1', { status: 'done' }), itemRecord('B-5')], TRACKS);
    const repo = await boardNode({ board });
    expect(await textOf(repo, { words: ['add'], title: 'New', fields: ['priority=P1'] })).toContain('Added B-6');
  });
});

describe('item: the words and the flags are checked before the node is read (exit 2)', () => {
  const BAD: readonly (readonly [string, Partial<ItemOptions>, string])[] = [
    ['no subcommand', { words: [] }, 'needs a subcommand'],
    ['an unknown subcommand', { words: ['remove', 'B-1'] }, 'add, update, move, close, list, record, unassign'],
    ['add with no title', { words: ['add'] }, '--title'],
    ['add with an id', { words: ['add', 'B-9'], title: 'New' }, 'takes no argument'],
    ['update with no id', { words: ['update'], title: 'x' }, 'the id of an item'],
    ['update with nothing to change', { words: ['update', 'B-1'] }, 'at least one of'],
    ['close with a flag of another subcommand', { words: ['close', 'B-1'], title: 'x' }, '--title is not for'],
    ['list with a flag of another subcommand', { words: ['list'], stage: 'ticket' }, '--stage is not for'],
    ['a field with no value separator', { words: ['add'], title: 'New', fields: ['priority'] }, 'NAME=VALUE'],
    ['a field given twice', { words: ['add'], title: 'New', fields: ['priority=P1', 'priority=P2'] }, 'given twice'],
    ['list with the JSON flag', { words: ['list'], json: true }, 'has no --json output'],
    ['list that follows, with the JSON flag', { words: ['list'], follow: true, json: true }, 'has no --json output'],
    ['add with the flag to follow', { words: ['add'], title: 'New', follow: true }, '--follow is not for'],
    ['move with the flag to follow', { words: ['move', 'B-1'], stage: 'building', follow: true }, '--follow is not for'],
    ['close with the flag to follow', { words: ['close', 'B-1'], follow: true }, '--follow is not for'],
    ['record with no id', { words: ['record'], ref: '12' }, 'the id of an item'],
    ['record with no reference', { words: ['record', 'B-1'] }, 'needs --ref'],
    ['record with a flag of another subcommand', { words: ['record', 'B-1'], ref: '12', title: 'x' }, '--title is not for'],
    ['close with the reference flag', { words: ['close', 'B-1'], ref: '12' }, '--ref is not for'],
    ['update with the project flag', { words: ['update', 'B-1'], title: 'x', project: 'web' }, '--project is not for'],
    ['unassign with no id', { words: ['unassign'] }, 'the id of an item'],
    ['unassign with a flag of another subcommand', { words: ['unassign', 'B-1'], ref: '12' }, '--ref is not for'],
  ];

  it.each(BAD)('M5-1b TP-22 %s exits 2 and touches no file', async (_name, overrides, message) => {
    const repo = await boardNode({ board: START });
    const touched: string[] = [];
    const result = await runItem(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...overrides }, recipes);
    const error = errorOf(result);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(error.hint).toContain(commandText(commands.item));
    expect(touched).toEqual([]);
    expectUntouched(repo, START);
  });
});

describe('item: text from the board file prints as one clean line (TP-91)', () => {
  it('M5-1b TP-91 prints a stored title with a line break and a bidi mark as one clean line', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const board = boardText([itemRecord('B-1', { title: `Two\nlines${bidi} here`, stage: 'ticket' })], []);
    const repo = await boardNode({ board });
    const text = await textOf(repo, { words: ['close', 'B-1'] });
    expect(text.trimEnd().split('\n')).toEqual(['Closed B-1: Two lines here']);
    expect(text).not.toContain(bidi);
  });
});

describe('item with a hosted tracker kind (TP-67)', () => {
  const hosted = (): FactoryConfig => {
    const config = sampleConfigWithBoard();
    return { ...config, core: { ...config.core, tracker: { kind: 'github', items: 'acme/items', decisions: 'acme/decisions', watch_interval: '5m' } } };
  };

  it('M5-1b TP-67 refuses a write with exit 4 and one line, names the command to run again, and writes nothing', async () => {
    const repo = await boardNode({ board: START, config: hosted() });
    const error = errorOf(await run(repo, { words: ['close', 'B-1'] }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('FAC-M3 (provider plugin)');
    expect(error.message).not.toContain('\n');
    expect(error.hint).toContain(commandText(commands.item));
    expectUntouched(repo, START);
  });

  it('M5-1b TP-69 lists the local board with a hosted kind, and exits 0', async () => {
    const repo = await boardNode({ board: START, config: hosted() });
    expect(await textOf(repo, { words: ['list'] })).toContain('1 item in 2 tracks');
  });
});

// The merge record, the worker field guard and the release of a worker.

const MERGE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const WORKER = 'alpha';

/** What `gh pr view --json` gives for PR 12 of the sample project, merged into main from the branch of the worker. */
const goodPr = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 12,
  state: 'MERGED',
  mergedAt: '2026-11-12T10:00:00Z',
  mergeCommit: { oid: MERGE_SHA },
  headRefName: branchOf(WORKER),
  headRefOid: HEAD_SHA,
  baseRefName: 'main',
  isCrossRepository: false,
  url: 'https://github.com/acme/web/pull/12',
  ...change,
});

const MERGE_BOARD = boardText(
  [itemRecord('B-1', { status: 'doing', stage: 'review', lane: WORKER }), itemRecord('B-2', { stage: 'ticket' }), itemRecord('B-3', { stage: 'ticket' })],
  TRACKS,
  [
    { name: 'Alone', items: ['B-1'] },
    { name: 'Pair', items: ['B-1', 'B-2'] },
  ],
);

interface Gh {
  /** The deps of the command: the fake gh answers the calls of `gh`. */
  readonly deps: FakeDeps;
  /** The argument list of each call of `gh`, in order. */
  readonly calls: (readonly string[])[];
}

/** A copy of the deps whose calls of `gh` go to the handler. The handler is the only place where a test names the answer of gh. */
const withGh = (deps: FakeDeps, handler: RunHandler): Gh => {
  const calls: (readonly string[])[] = [];
  const run: FakeDeps['run'] = async (command, args, options) => {
    if (command !== toolNames.gh) return deps.run(command, args, options);
    calls.push(args);
    return handler({ command, args, cwd: options?.cwd });
  };
  return { deps: { ...deps, run }, calls };
};

const answering = (pr: Record<string, unknown>): RunHandler => () => exited(0, JSON.stringify(pr));

const itemsOf = (repo: BoardRepo): Record<string, unknown>[] =>
  (JSON.parse(repo.textOf(fileNames.board) ?? '{}') as { items: Record<string, unknown>[] }).items;

const itemIn = (repo: BoardRepo, id: string): Record<string, unknown> => itemsOf(repo).find((item) => item.id === id) ?? {};

const queueItemsOf = (repo: BoardRepo): (readonly string[])[] =>
  (JSON.parse(repo.textOf(fileNames.board) ?? '{}') as Record<string, { items: string[] }[]>)[softwareQueueKey]?.map((row) => row.items) ?? [];

const recordWorker = async (repo: BoardRepo, project = 'web'): Promise<void> => {
  const written = await writeWorkerRecord(repo.deps, HOME, { id: WORKER, project, workCopy: workCopyOf(HOME, project, WORKER), branch: branchOf(WORKER) });
  if (!written.ok) throw new Error(written.error.message);
};

const withProject = (change: Record<string, unknown>): FactoryConfig => {
  const config = sampleConfigWithBoard();
  return { ...config, recipe: { ...config.recipe, projects: config.recipe.projects.map((project) => ({ ...project, ...change })) } };
};

interface MergeWorld {
  readonly repo: BoardRepo;
  readonly gh: Gh;
}

interface MergeSetup {
  readonly board?: string;
  readonly config?: FactoryConfig;
  /** The answer of gh. Default: the good PR. */
  readonly answer?: RunHandler;
  /** False: the worker has no record. */
  readonly record?: boolean;
}

const mergeWorld = async (setup: MergeSetup = {}): Promise<MergeWorld> => {
  const repo = await boardNode({ board: setup.board ?? MERGE_BOARD, ...(setup.config === undefined ? {} : { config: setup.config }) });
  if (setup.record !== false) await recordWorker(repo);
  return { repo, gh: withGh(repo.deps, setup.answer ?? answering(goodPr())) };
};

const runMerge = (world: MergeWorld, overrides: Partial<ItemOptions> = {}, registry: RecipeRegistry = recipes): Promise<CliResult<CommandOutput>> =>
  runItem(world.gh.deps, { ...BASE, words: ['record', 'B-1'], ref: '12', ...overrides }, registry);

describe('item record with the software recipe: the record of a merge (AC-1)', () => {
  it('records the stage, the closed state and the PR head in one commit of the board file, and takes the item out of the queue', async () => {
    const world = await mergeWorld();
    const text = outputOf(await runMerge(world));
    expect(text.trimEnd().split('\n')).toEqual([`Recorded B-1: PR 12, merge commit ${MERGE_SHA}`]);
    expect(itemIn(world.repo, 'B-1')).toMatchObject({ stage: 'merged', status: 'done', [boardKeys.mergedPrHead]: HEAD_SHA, lane: WORKER });
    expect(queueItemsOf(world.repo)).toEqual([['B-2']]);
    expect(world.repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
  });

  it('keeps the merge commit out of the board and records the head sha of the PR', async () => {
    const world = await mergeWorld();
    valueOf(await runMerge(world));
    expect(world.repo.textOf(fileNames.board)).not.toContain(MERGE_SHA);
  });

  it('only reads the PR: every call of gh is a view of the PR in the repo of the project, and the number comes after the end of the flags', async () => {
    const world = await mergeWorld();
    valueOf(await runMerge(world));
    expect(world.gh.calls).toHaveLength(1);
    const [args] = world.gh.calls;
    expect(args?.slice(0, 2)).toEqual(['pr', 'view']);
    expect(args).toContain(`${mergeCheck.host}/acme/web`);
    expect(args?.slice(-2)).toEqual([mergeCheck.words.endOfFlags, '12']);
  });

  it('says that a merge is recorded already, and makes no second commit, on a rerun', async () => {
    const world = await mergeWorld();
    valueOf(await runMerge(world));
    const again = outputOf(await runMerge(world));
    expect(again.trimEnd().split('\n')).toEqual([`B-1: PR 12, merge commit ${MERGE_SHA} already recorded`]);
    expect(world.repo.commits).toHaveLength(1);
  });

  it('records the merge of an item that names no worker, when the project is given, and does not test the head branch', async () => {
    const board = boardText([itemRecord('B-1', { status: 'doing', stage: 'review' })], TRACKS);
    const world = await mergeWorld({ board, record: false, answer: answering(goodPr({ headRefName: 'any-branch' })) });
    valueOf(await runMerge(world, { project: 'web' }));
    expect(itemIn(world.repo, 'B-1')).toMatchObject({ stage: 'merged', status: 'done' });
  });

  it('records the merge of an item whose worker has no record any more, when the project is given', async () => {
    const world = await mergeWorld({ record: false });
    valueOf(await runMerge(world, { project: 'web' }));
    expect(itemIn(world.repo, 'B-1')).toMatchObject({ stage: 'merged', [boardKeys.mergedPrHead]: HEAD_SHA });
  });

  it('takes the project from the record of the worker, and accepts the same project as a flag', async () => {
    const world = await mergeWorld();
    valueOf(await runMerge(world, { project: 'web' }));
    expect(world.repo.commits).toHaveLength(1);
  });

  it('prints the document for the JSON flag', async () => {
    const world = await mergeWorld();
    const output = valueOf(await runMerge(world, { json: true }));
    expect(output.json).toMatchObject({
      action: 'record',
      id: 'B-1',
      stage: 'merged',
      ref: '12',
      head: HEAD_SHA,
      summary: `PR 12, merge commit ${MERGE_SHA}`,
      changed: true,
    });
  });
});

describe('item record with the software recipe: the check fails closed (AC-2)', () => {
  const FAULTS: readonly (readonly [string, Partial<MergeSetup>, string])[] = [
    ['gh is not installed', { answer: () => missingProgram(toolNames.gh) }, 'gh could not read PR 12'],
    ['gh exits with an error', { answer: () => exited(1, '', 'not signed in') }, 'gh could not read PR 12'],
    ['the answer of gh is not a PR record', { answer: () => exited(0, 'not json') }, 'not a PR record'],
    ['the PR is not merged', { answer: answering(goodPr({ state: 'OPEN', mergedAt: null, mergeCommit: null })) }, 'the PR is not merged'],
    ['gh gives another PR', { answer: answering(goodPr({ number: 13 })) }, 'gh gave another PR'],
    ['the PR merged into another base branch', { answer: answering(goodPr({ baseRefName: 'release' })) }, 'another base branch'],
    ['the PR comes from another repo', { answer: answering(goodPr({ isCrossRepository: true })) }, 'comes from another repo'],
    ['the PR comes from the branch of another worker', { answer: answering(goodPr({ headRefName: branchOf('beta') })) }, 'another head branch'],
  ];

  it.each(FAULTS)('exits 1 and writes nothing when %s', async (_name, setup, reason) => {
    const world = await mergeWorld(setup);
    const error = errorOf(await runMerge(world));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(reason);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it('exits 1 for a project URL that is not on GitHub, and does not run gh', async () => {
    const world = await mergeWorld({ config: withProject({ url: 'https://gitlab.com/acme/web.git' }) });
    const error = errorOf(await runMerge(world));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it('exits 1 for a project with no URL, and does not run gh', async () => {
    const world = await mergeWorld({ config: withProject({ url: undefined }) });
    expect(exitOf(await runMerge(world))).toBe(1);
    expect(world.gh.calls).toEqual([]);
  });

  it('exits 1 for a worker field that does not hold text, and does not run gh', async () => {
    const board = boardText([itemRecord('B-1', { status: 'doing', stage: 'review', lane: 7 })], TRACKS);
    const world = await mergeWorld({ board });
    const error = errorOf(await runMerge(world));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('does not hold text');
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, board);
  });

  it('exits 1 for a record of the worker that is not valid, and does not run gh', async () => {
    const world = await mergeWorld({ record: false });
    world.repo.deps.seed(`${LAYOUT.workersDir}/${WORKER}/${fileNames.workerRecord}`, '{"schema":"nothing"}');
    const error = errorOf(await runMerge(world, { project: 'web' }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('is not valid');
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it.each(['0', '012', '-1', '1.5', '1e3', ' 12', '12abc', '1234567890', 'abc'])(
    'exits 2 for the PR number %j before any call of gh, any read of the board file and any read of a worker record',
    async (ref) => {
      const world = await mergeWorld();
      const touched: string[] = [];
      const watched = withFsWatch(world.gh.deps, (method, path) => touched.push(`${method} ${path}`));
      const error = errorOf(await runItem(watched, { ...BASE, words: ['record', 'B-1'], ref }, recipes));
      expect(exitCodeOf[error.kind]).toBe(2);
      expect(error.message).toContain('--ref: must be a whole number');
      expect(world.gh.calls).toEqual([]);
      expect(touched.filter((path) => path.includes(BOARD_PATH) || path.includes(LAYOUT.workersDir))).toEqual([]);
      expectUntouched(world.repo, MERGE_BOARD);
    },
  );

  it('keeps the refusal of item move --stage merged', async () => {
    const world = await mergeWorld();
    const error = errorOf(await runItem(world.gh.deps, { ...BASE, words: ['move', 'B-1'], stage: 'merged' }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expectUntouched(world.repo, MERGE_BOARD);
  });
});

describe('item record with the software recipe: the local checks come before any call of gh', () => {
  const REFUSED: readonly (readonly [string, Partial<MergeSetup>, Partial<ItemOptions>, number])[] = [
    ['an item that is not on the board', {}, { words: ['record', 'B-9'] }, 2],
    ['an id that is not an item id', {}, { words: ['record', 'not-an-id'] }, 2],
    ['a setup with no board block', { config: sampleConfig() }, {}, 2],
    ['a project that the config does not list', { record: false }, { project: 'nope' }, 2],
    ['a project that is not the project of the worker', {}, { project: 'other' }, 2],
  ];

  it.each(REFUSED)('stops for %s and runs no gh', async (_name, setup, overrides, code) => {
    const world = await mergeWorld(setup);
    const error = errorOf(await runMerge(world, overrides));
    expect(exitCodeOf[error.kind]).toBe(code);
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it('stops for a recipe that does not list the stage of its check and runs no gh', async () => {
    const world = await mergeWorld();
    const bare: RecipeRegistry = [{ ...recipes[0], board: { ...recipes[0].board, stages: ['ticket', 'review'] } }];
    expect(exitOf(await runMerge(world, {}, bare))).toBe(2);
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it('stops for a hosted tracker kind with exit 4 and runs no gh', async () => {
    const config = sampleConfigWithBoard();
    const hosted: FactoryConfig = { ...config, core: { ...config.core, tracker: { kind: 'github', items: 'acme/items', decisions: 'acme/decisions', watch_interval: '5m' } } };
    const world = await mergeWorld({ config: hosted });
    expect(exitOf(await runMerge(world))).toBe(4);
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });

  it('needs the project flag for an item that names no worker with a record, and runs no gh', async () => {
    const world = await mergeWorld({ record: false });
    const error = errorOf(await runMerge(world));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('--project');
    expect(world.gh.calls).toEqual([]);
  });
});

describe('item update: the worker field of an item that has a worker (AC-4)', () => {
  const BOARD = boardText([itemRecord('B-1', { status: 'doing', stage: 'review', lane: WORKER }), itemRecord('B-2')], TRACKS);

  it('refuses a new worker value with exit 2, names the item and the remedy, and changes nothing', async () => {
    const repo = await boardNode({ board: BOARD });
    const error = errorOf(await run(repo, { words: ['update', 'B-1'], fields: ['lane=beta'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('B-1');
    expect(error.hint).toContain(`${commandText(commands.item)} unassign B-1`);
    expectUntouched(repo, BOARD);
  });

  it('refuses a clear of the worker field with exit 2 and the remedy, and changes nothing', async () => {
    const repo = await boardNode({ board: BOARD });
    const error = errorOf(await run(repo, { words: ['update', 'B-1'], fields: ['lane='] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain(`${commandText(commands.item)} unassign B-1`);
    expectUntouched(repo, BOARD);
  });

  it('still refuses a clear of the worker field of an item with no worker value, and changes nothing', async () => {
    const repo = await boardNode({ board: BOARD });
    const error = errorOf(await run(repo, { words: ['update', 'B-2'], fields: ['lane='] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('the field lane takes a token');
    expectUntouched(repo, BOARD);
  });

  it('makes no change, and no commit, for a patch with the same worker value', async () => {
    const repo = await boardNode({ board: BOARD });
    expect((await run(repo, { words: ['update', 'B-1'], fields: [`lane=${WORKER}`] })).ok).toBe(true);
    expectUntouched(repo, BOARD);
  });

  it('still gives a worker to an item with no worker value', async () => {
    const repo = await boardNode({ board: BOARD });
    valueOf(await run(repo, { words: ['update', 'B-2'], fields: ['lane=beta'] }));
    expect(itemIn(repo, 'B-2')).toMatchObject({ lane: 'beta' });
    expect(repo.commits).toHaveLength(1);
  });

  it('still lets item add set a worker value', async () => {
    const repo = await boardNode({ board: BOARD });
    valueOf(await run(repo, { words: ['add'], title: 'New', fields: ['priority=P1', 'lane=beta'] }));
    expect(itemIn(repo, 'B-3')).toMatchObject({ lane: 'beta' });
  });
});

describe('item unassign: take the worker off an item (AC-3)', () => {
  const BOARD = boardText([itemRecord('B-1', { status: 'doing', stage: 'review', lane: WORKER }), itemRecord('B-2')], TRACKS);

  const unassign = (deps: FakeDeps, id = 'B-1'): Promise<CliResult<CommandOutput>> => runItem(deps, { ...BASE, words: ['unassign', id] }, recipes);

  it('deletes the worker key, keeps the stage and the state, marks the former worker, and makes one commit of the board file', async () => {
    const repo = await boardNode({ board: BOARD });
    const text = outputOf(await unassign(inPane(repo.deps, '%0')));
    expect(text).toContain('B-1');
    expect(text).toContain(WORKER);
    const item = itemIn(repo, 'B-1');
    expect(item).not.toHaveProperty('lane');
    expect(item).toMatchObject({ status: 'doing', stage: 'review', [boardKeys.unassignedFrom]: [WORKER] });
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
  });

  it('exits 2 for an item with no worker, and changes nothing', async () => {
    const repo = await boardNode({ board: BOARD });
    expect(exitOf(await unassign(inPane(repo.deps, '%0'), 'B-2'))).toBe(2);
    expectUntouched(repo, BOARD);
  });

  it('exits 2 for a caller outside tmux, and reads no board file', async () => {
    const repo = await boardNode({ board: BOARD });
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    expect(exitOf(await unassign(watched))).toBe(2);
    expect(touched.filter((path) => path.includes(BOARD_PATH))).toEqual([]);
    expectUntouched(repo, BOARD);
  });

  it('exits 2 for a caller in a pane that is not the pane of the coordinator, and changes nothing', async () => {
    const repo = await boardNode({ board: BOARD });
    const error = errorOf(await unassign(inPane(repo.deps, '%1')));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain(`${commandText(commands.item)} unassign B-1`);
    expectUntouched(repo, BOARD);
  });

  it('exits 2 for an id that is not an item id, before the caller rule runs a tmux call', async () => {
    const repo = await boardNode({ board: BOARD });
    const tmuxCalls: (readonly string[])[] = [];
    expect(exitOf(await unassign(inPane(repo.deps, '%0', tmuxCalls), 'x\ny'))).toBe(2);
    expect(tmuxCalls).toEqual([]);
    expectUntouched(repo, BOARD);
  });
});

describe('item record with the software recipe: the base branch of a project that names none', () => {
  /** A registry whose recipe lets a project leave out its default branch, which the software recipe does not. */
  const loose: RecipeRegistry = [
    {
      ...recipes[0],
      schema: z.object({
        id: z.string(),
        variant: z.string(),
        projects: z.array(z.looseObject({ id: z.string(), path: z.string(), url: z.string().optional() })),
      }),
    },
  ];

  it('exits 1 and runs no gh when neither the config nor the clone gives a default branch', async () => {
    const withoutBranch = Object.fromEntries(Object.entries(sampleConfigWithBoard().recipe.projects[0] ?? {}).filter(([key]) => key !== 'default_branch'));
    const config = sampleConfigWithBoard();
    const world = await mergeWorld({ config: { ...config, recipe: { ...config.recipe, projects: [{ ...withoutBranch, id: 'web', path: 'web' }] } } });
    const error = errorOf(await runMerge(world, {}, loose));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('names no default branch');
    expect(world.gh.calls).toEqual([]);
    expectUntouched(world.repo, MERGE_BOARD);
  });
});

describe('item record: the record check belongs to the recipe of the node', () => {
  const PROOF_BOARD = boardText([itemRecord('B-1', { status: 'doing', stage: 'proof' })], []).replace('"merge"', `"${publishBoard.queueKey}"`);

  const publishConfig = (): FactoryConfig => {
    const base = sampleConfigWithBoard();
    return {
      ...base,
      core: { ...base.core, approval: { publish: 'owner', send: 'owner' } },
      recipe: { id: publishRecipe.id, variant: 'plain', projects: [{ id: 'web', path: 'web' }] },
      entry: publishRecipe,
    };
  };

  const checkCalls: RecordCheckInput[] = [];
  const parseCalls: string[] = [];

  /** The record check of the publishing recipe: it reads no GitHub, and it keeps the head `proof-1`. */
  const proofCheck = (verdict: 'pass' | 'fail' = 'pass'): RecordCheck => ({
    stage: 'approved',
    summary: 'record a signed proof',
    refHelp: 'the number of the proof',
    parseRef: (text) => {
      parseCalls.push(text);
      return /^[0-9]+$/.test(text) ? ok(text) : usageError('the reference must be a number');
    },
    check: async (_deps, input) => {
      checkCalls.push(input);
      return verdict === 'pass'
        ? ok({ stage: 'approved', ref: input.ref, head: 'proof-1', summary: `proof ${input.ref} signed` } as CheckedRecord)
        : failure('the proof is not signed');
    },
  });

  const registryWith = (check: RecordCheck): RecipeRegistry => [{ ...publishRecipe, recordCheck: check }];

  const recording = (overrides: Partial<ItemOptions> = {}): Partial<ItemOptions> => ({ words: ['record', 'B-1'], ref: '7', project: 'web', ...overrides });

  it('is a usage error with no write for a recipe that has no record check', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    const error = errorOf(await runItem(watched, { ...BASE, ...recording() }, publishRegistry));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(publishRecipe.id);
    expect(error.message).toContain('has no check');
    expect(touched.filter((path) => path.includes(BOARD_PATH))).toEqual([]);
    expectUntouched(repo, PROOF_BOARD);
  });

  it('writes the stage and the head that the check of the recipe gives, with the output line of the check, and calls no gh', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    const gh = withGh(repo.deps, () => failure('no gh in this recipe'));
    checkCalls.length = 0;
    const text = plainText(valueOf(await runItem(gh.deps, { ...BASE, ...recording() }, registryWith(proofCheck()))));
    expect(text.trimEnd().split('\n')).toEqual(['Recorded B-1: proof 7 signed']);
    expect(itemIn(repo, 'B-1')).toMatchObject({ stage: 'approved', status: 'done', [boardKeys.mergedPrHead]: 'proof-1' });
    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]?.message).toContain('approved');
    expect(repo.commits[0]?.message).toContain('proof 7 signed');
    expect(checkCalls).toHaveLength(1);
    expect(checkCalls[0]).toMatchObject({ ref: '7', project: { id: 'web' }, cloneDir: join(HOME, 'web'), branch: undefined });
    expect(gh.calls).toEqual([]);
  });

  it('reruns with no second commit and says that the record is made already', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    const registry = registryWith(proofCheck());
    valueOf(await runItem(repo.deps, { ...BASE, ...recording() }, registry));
    const again = plainText(valueOf(await runItem(repo.deps, { ...BASE, ...recording() }, registry)));
    expect(again.trimEnd().split('\n')).toEqual(['B-1: proof 7 signed already recorded']);
    expect(repo.commits).toHaveLength(1);
  });

  it('exits 1 with no write when the check fails', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    const error = errorOf(await runItem(repo.deps, { ...BASE, ...recording() }, registryWith(proofCheck('fail'))));
    expect(exitCodeOf[error.kind]).toBe(1);
    expectUntouched(repo, PROOF_BOARD);
  });

  it('exits 2 for a reference that the recipe refuses, before the item is read and before the check runs', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    checkCalls.length = 0;
    parseCalls.length = 0;
    const error = errorOf(await runItem(watched, { ...BASE, ...recording({ ref: 'not-a-number' }) }, registryWith(proofCheck())));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(parseCalls).toEqual(['not-a-number']);
    expect(checkCalls).toEqual([]);
    expect(touched.filter((path) => path.includes(BOARD_PATH))).toEqual([]);
    expectUntouched(repo, PROOF_BOARD);
  });

  it('exits 2 with no write when the recipe does not list the stage of its check', async () => {
    const repo = await boardNode({ board: PROOF_BOARD, config: publishConfig() });
    checkCalls.length = 0;
    const error = errorOf(await runItem(repo.deps, { ...BASE, ...recording() }, registryWith({ ...proofCheck(), stage: 'unlisted' })));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(checkCalls).toEqual([]);
    expectUntouched(repo, PROOF_BOARD);
  });
});
