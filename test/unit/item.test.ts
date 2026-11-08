import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runItem, type ItemOptions } from '../../src/commands/item.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { commands, commandText, files as fileNames, stateLock } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import type { RecipeRegistry } from '../../src/recipes/entry.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { withFsWatch } from '../helpers/fake-deps.js';
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
    ['an unknown subcommand', { words: ['remove', 'B-1'] }, 'add, update, move, close, list'],
    ['add with no title', { words: ['add'] }, '--title'],
    ['add with an id', { words: ['add', 'B-9'], title: 'New' }, 'takes no argument'],
    ['update with no id', { words: ['update'], title: 'x' }, 'the id of an item'],
    ['update with nothing to change', { words: ['update', 'B-1'] }, 'at least one of'],
    ['close with a flag of another subcommand', { words: ['close', 'B-1'], title: 'x' }, '--title is not for'],
    ['list with a flag of another subcommand', { words: ['list'], stage: 'ticket' }, '--stage is not for'],
    ['a field with no value separator', { words: ['add'], title: 'New', fields: ['priority'] }, 'NAME=VALUE'],
    ['a field given twice', { words: ['add'], title: 'New', fields: ['priority=P1', 'priority=P2'] }, 'given twice'],
    ['list with the JSON flag', { words: ['list'], json: true }, 'has no --json output'],
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
