import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runTrack, type TrackOptions } from '../../src/commands/track.js';
import { commands, commandText, files as fileNames, trackCommands, trackLimits } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { withFsWatch } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

const BASE: TrackOptions = { home: HOME, words: [], name: undefined, roadmap: false };

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const run = (repo: BoardRepo, overrides: Partial<TrackOptions>): Promise<CliResult<CommandOutput>> =>
  runTrack(repo.deps, { ...BASE, ...overrides }, recipes);

const linesOf = (output: CliResult<CommandOutput>): string[] => plainText(valueOf(output)).trimEnd().split('\n');

const track = (id: string, name = id, roadmap = false): Record<string, unknown> => ({ id, name, roadmap });

const ADD = { words: ['add', 'core'], name: 'Core', roadmap: true };

describe('track add and track list (TP-79)', () => {
  it('M5-1b TP-79 stores the id, the name and the roadmap flag, and track list shows them', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, ADD))).toEqual(['Added the track core: Core (roadmap)']);
    valueOf(await run(repo, { words: ['add', 'docs'], name: 'Docs' }));
    expect(repo.textOf(fileNames.board)).toContain('"roadmap": true');
    const lines = linesOf(await run(repo, { words: ['list'] }));
    expect(lines.map((line) => line.split(/ {2,}/))).toEqual([
      ['ID', 'NAME', 'ROADMAP'],
      ['core', 'Core', 'yes'],
      ['docs', 'Docs', 'no'],
    ]);
  });

  it('M5-1b TP-79 says that there is no track yet for a board with no track', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, { words: ['list'] }))).toEqual(['No tracks yet.']);
  });

  it('M5-1b TP-22 makes one commit that holds only the board file for a track add, and none for a list', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, { words: ['list'] }));
    expect(repo.commits).toEqual([]);
    valueOf(await run(repo, ADD));
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
  });
});

describe('the tracks key of the board file (TP-70)', () => {
  it('M5-1b TP-70 reads an old board with no tracks key as an empty track list, and the first track add creates the key', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1')]) });
    expect(repo.textOf(fileNames.board)).not.toContain('"tracks"');
    expect(linesOf(await run(repo, { words: ['list'] }))).toEqual(['No tracks yet.']);
    valueOf(await run(repo, ADD));
    expect(repo.textOf(fileNames.board)).toContain('"tracks": [');
    expect(linesOf(await run(repo, { words: ['list'] }))[1]).toContain('core');
    expect(repo.commits).toHaveLength(1);
  });
});

describe('the rules of a track id and a track name (TP-80, TP-89)', () => {
  const BAD: readonly (readonly [string, Partial<TrackOptions>])[] = [
    ['an id with a capital letter', { words: ['add', 'Core'], name: 'Core' }],
    ['an id with a bad first character', { words: ['add', '1core'], name: 'Core' }],
    ['an id of more than the most characters', { words: ['add', `a${'b'.repeat(trackLimits.maxIdChars)}`], name: 'Core' }],
    ['a name of more than the most characters', { words: ['add', 'core'], name: 'x'.repeat(trackLimits.maxNameChars + 1) }],
    ['a name with a line break', { words: ['add', 'core'], name: 'Two\nlines' }],
    ['a name with a line separator', { words: ['add', 'core'], name: `Two${String.fromCodePoint(0x2028)}lines` }],
    ['a name with a paragraph separator', { words: ['add', 'core'], name: `Two${String.fromCodePoint(0x2029)}lines` }],
    ['a name with a right-to-left override', { words: ['add', 'core'], name: `Two${String.fromCodePoint(0x202e)}lines` }],
    ['a name with a direction isolate', { words: ['add', 'core'], name: `Two${String.fromCodePoint(0x2066)}lines` }],
    ['an empty name', { words: ['add', 'core'], name: ' ' }],
  ];

  it.each(BAD)('M5-1b TP-80 refuses %s with exit 2 and changes no file', async (_name, overrides) => {
    const repo = await boardNode();
    const before = repo.textOf(fileNames.board);
    expect(exitCodeOf[errorOf(await run(repo, overrides)).kind]).toBe(2);
    expect(repo.textOf(fileNames.board)).toBe(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-80 accepts a track id of exactly the most characters, and a name of exactly the most characters', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, { words: ['add', `a${'b'.repeat(trackLimits.maxIdChars - 1)}`], name: 'x'.repeat(trackLimits.maxNameChars) }));
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-80 accepts a name with an emoji sequence that holds zero-width joiners', async () => {
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map((code) => String.fromCodePoint(code)).join('');
    const repo = await boardNode();
    valueOf(await run(repo, { words: ['add', 'core'], name: `Team ${family}` }));
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-80 refuses the 31st track with exit 2 and changes no file', async () => {
    const tracks = Array.from({ length: trackLimits.maxTracks }, (_, at) => track(`track${at + 1}`));
    const board = boardText([], tracks);
    const repo = await boardNode({ board });
    const error = errorOf(await run(repo, { words: ['add', 'one-more'], name: 'One more' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(String(trackLimits.maxTracks));
    expect(repo.textOf(fileNames.board)).toBe(board);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-89 refuses an id that exists with exit 2, and writes nothing', async () => {
    const board = boardText([], [track('core', 'Core', true)]);
    const repo = await boardNode({ board });
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('core');
    expect(repo.textOf(fileNames.board)).toBe(board);
    expect(repo.commits).toEqual([]);
  });
});

describe('the words and the flags of track (TP-81)', () => {
  it('M5-1b TP-81 has no remove subcommand: it exits 2 and lists add and list', async () => {
    const repo = await boardNode({ board: boardText([], [track('core')]) });
    const error = errorOf(await run(repo, { words: ['remove', 'core'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(Object.values(trackCommands).join(', '));
    expect(repo.commits).toEqual([]);
  });

  const BAD: readonly (readonly [string, Partial<TrackOptions>, string])[] = [
    ['no subcommand', { words: [] }, 'needs a subcommand'],
    ['add with no id', { words: ['add'], name: 'Core' }, 'the id of the track'],
    ['add with two ids', { words: ['add', 'core', 'docs'], name: 'Core' }, 'the id of the track'],
    ['add with no name', { words: ['add', 'core'] }, '--name'],
    ['list with an argument', { words: ['list', 'core'] }, 'takes no argument'],
    ['list with the name flag', { words: ['list'], name: 'Core' }, '--name is not for'],
    ['list with the roadmap flag', { words: ['list'], roadmap: true }, '--roadmap is not for'],
  ];

  it.each(BAD)('M5-1b TP-81 %s exits 2 and touches no file', async (_name, overrides, message) => {
    const repo = await boardNode();
    const touched: string[] = [];
    const error = errorOf(await runTrack(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...overrides }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(error.hint).toContain(commandText(commands.track));
    expect(touched).toEqual([]);
  });
});

describe('track: a track name from the board file is one line (TP-91)', () => {
  it.each([
    ['a bidi mark', 0x202e],
    ['a line separator', 0x2028],
  ])('M5-1b TP-91 stops the read of a track name that holds %s, with exit 1, and names the file', async (_name, code) => {
    const mark = String.fromCodePoint(code);
    const repo = await boardNode({ board: boardText([], [track('core', `Co${mark}re`)]) });
    const error = errorOf(await run(repo, { words: ['list'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.board);
  });
});

describe('track with a hosted tracker kind (TP-67)', () => {
  it('M5-1b TP-67 refuses a track add with exit 4 and writes nothing, and track list still works', async () => {
    const base = sampleConfigWithBoard();
    const config = { ...base, core: { ...base.core, tracker: { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
    const repo = await boardNode({ config });
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('FAC-M3 (provider plugin)');
    expect(repo.commits).toEqual([]);
    expect(linesOf(await run(repo, { words: ['list'] }))).toEqual(['No tracks yet.']);
  });
});
