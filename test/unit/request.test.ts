import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runRequest, type RequestOptions } from '../../src/commands/request.js';
import { commands, commandText, files as fileNames, requestCommands, requestWords } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { withFsWatch } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

const BASE: RequestOptions = { home: HOME, words: [], title: undefined, question: undefined, options: [], recommend: undefined };

const ADD: Partial<RequestOptions> = {
  words: ['add'],
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: ['a=Plan A', 'b=Plan B'],
  recommend: 'a',
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const run = (repo: BoardRepo, overrides: Partial<RequestOptions>): Promise<CliResult<CommandOutput>> =>
  runRequest(repo.deps, { ...BASE, ...overrides }, recipes);

const linesOf = (output: CliResult<CommandOutput>): string[] => plainText(valueOf(output)).trimEnd().split('\n');

const entry = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Request ${id}`,
  question: 'A question?',
  options: [{ key: 'a', text: 'Yes' }],
  ...extra,
});

const waitingText = (items: readonly Record<string, unknown>[]): string => `${JSON.stringify({ intro: '', groups: [], items }, null, 2)}\n`;

const logText = (rows: readonly Record<string, unknown>[]): string => `${JSON.stringify({ rows }, null, 2)}\n`;

const logRow = (id: string): Record<string, unknown> => ({ item: `${id}: An old decision`, decision: 'B', who: 'Someone', date: '2030-01-01' });

const waitingOf = (repo: BoardRepo): { items: Record<string, unknown>[] } => JSON.parse(repo.textOf(fileNames.waiting) ?? '') as { items: Record<string, unknown>[] };

const logOf = (repo: BoardRepo): { rows: Record<string, unknown>[] } => JSON.parse(repo.textOf(fileNames.decisionLog) ?? '') as { rows: Record<string, unknown>[] };

const FILES = [fileNames.board, fileNames.waiting, fileNames.decisionLog];

/** The text of the three board files now, for a test that checks that a refused command changed none of them. */
const filesOf = (repo: BoardRepo): (string | undefined)[] => FILES.map((file) => repo.textOf(file));

describe('request add (TP-22, TP-99)', () => {
  it('M5-1b TP-22 stores the decision with the first D-n, prints one line, and makes one commit that holds only the waiting file', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-1: Pick a plan']);
    expect(waitingOf(repo).items).toEqual([
      {
        id: 'D-1',
        title: 'Pick a plan',
        question: 'Which plan do we build?',
        options: [
          { key: 'a', text: 'Plan A', rec: true },
          { key: 'b', text: 'Plan B' },
        ],
      },
    ]);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting]]);
  });

  it('M5-1b TP-99 takes the number after the highest D-n of the waiting file and of the decision log', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3'), entry('D-9')]), decisionLog: logText([logRow('D-12'), logRow('D-2')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-13: Pick a plan']);
  });

  it('M5-1b TP-99 takes the number after the highest D-n of the waiting file when the decision log is empty', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-4')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-5: Pick a plan']);
  });

  it('M5-1b TP-99 takes the number after the highest D-n of the decision log when the waiting file is empty', async () => {
    const repo = await boardNode({ decisionLog: logText([logRow('D-7')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-8: Pick a plan']);
  });

  it('M5-1b TP-99 has no subcommand that changes a request, and a second add leaves the first request as it was', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, ADD));
    const first = waitingOf(repo).items[0];
    const error = errorOf(await run(repo, { words: ['update', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(Object.values(requestCommands).join(', '));
    valueOf(await run(repo, { ...ADD, title: 'Other', options: ['x=Plan X'], recommend: undefined }));
    expect(waitingOf(repo).items).toHaveLength(2);
    expect(waitingOf(repo).items[0]).toEqual(first);
  });

  it('M5-1b TP-99 gives two adds that run at the same time two different numbers', async () => {
    const repo = await boardNode();
    const both = await Promise.all([run(repo, ADD), run(repo, { ...ADD, title: 'Other' })]);
    expect(both.every((result) => result.ok)).toBe(true);
    expect(waitingOf(repo).items.map((item) => item['id']).sort()).toEqual(['D-1', 'D-2']);
    expect(repo.commits).toHaveLength(2);
  });
});

describe('request add: an id that exists (TP-89)', () => {
  it('M5-1b TP-89 never gives a number that the waiting file or the decision log holds, so a taken number cannot reach the write', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-5')]), decisionLog: logText([logRow('D-5')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-6: Pick a plan']);
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-5', 'D-6']);
  });

  it('M5-1b TP-89 exits 1 and names the waiting file for a D-n that the file holds twice, and writes nothing', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3'), entry('D-3')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.message).toContain('D-3');
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-89 exits 1 and names the decision log for a D-n that the log holds twice, and writes nothing', async () => {
    const repo = await boardNode({ decisionLog: logText([logRow('D-4'), logRow('D-4')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(error.message).toContain('D-4');
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('request add: the text of the question (TP-92)', () => {
  it('M5-1b TP-92 exits 1 and names the waiting file for a question with a line break, and writes nothing', async () => {
    const repo = await boardNode();
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { ...ADD, question: 'One line\nand another' }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  const BAD: readonly (readonly [string, Partial<RequestOptions>])[] = [
    ['a title with a line break', { title: 'Two\nlines' }],
    ['an empty title', { title: ' ' }],
    ['an option key that is not a token', { options: ['bad key=Plan'], recommend: undefined }],
    ['an option key that is used twice', { options: ['a=Plan A', 'a=Plan B'] }],
    ['an option text of more than the most characters', { options: [`a=${'x'.repeat(201)}`], recommend: undefined }],
    ['ten options', { options: Array.from({ length: 10 }, (_, at) => `k${at}=Plan ${at}`), recommend: undefined }],
  ];

  it.each(BAD)('M5-1b TP-92 refuses %s with exit 2 and changes no file', async (_name, overrides) => {
    const repo = await boardNode();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await run(repo, { ...ADD, ...overrides })).kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('the words and the flags of request (TP-99)', () => {
  const BAD_WORDS: readonly (readonly [string, Partial<RequestOptions>, string])[] = [
    ['no subcommand', { words: [] }, 'needs a subcommand'],
    ['an unknown subcommand', { words: ['remove', 'D-1'] }, 'unknown subcommand'],
    ['add with an argument', { ...ADD, words: ['add', 'D-1'] }, 'takes no argument'],
    ['add with no title', { ...ADD, title: undefined }, '--title'],
    ['add with no question', { ...ADD, question: undefined }, '--question'],
    ['add with no option', { ...ADD, options: [], recommend: undefined }, '--option'],
    ['add with an option that has no text', { ...ADD, options: ['a'], recommend: undefined }, 'KEY=TEXT'],
    ['add with an option that has no key', { ...ADD, options: ['=Plan'], recommend: undefined }, 'KEY=TEXT'],
    ['add that recommends a key that no option has', { ...ADD, recommend: 'z' }, '--recommend'],
    ['close with no id', { words: ['close'] }, 'one argument'],
    ['close with two ids', { words: ['close', 'D-1', 'D-2'] }, 'one argument'],
    ['close with the title flag', { words: ['close', 'D-1'], title: 'Other' }, '--title is not for'],
    ['close with the option flag', { words: ['close', 'D-1'], options: ['a=Plan'] }, '--option is not for'],
    ['list with an argument', { words: ['list', 'D-1'] }, 'takes no argument'],
    ['list with the question flag', { words: ['list'], question: 'Why?' }, '--question is not for'],
    ['list with the recommend flag', { words: ['list'], recommend: 'a' }, '--recommend is not for'],
  ];

  it.each(BAD_WORDS)('M5-1b TP-99 %s exits 2 and touches no file', async (_name, overrides, message) => {
    const repo = await boardNode();
    const touched: string[] = [];
    const error = errorOf(await runRequest(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...overrides }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(error.hint).toContain(commandText(commands.request));
    expect(touched).toEqual([]);
  });
});

describe('request list (TP-22, TP-91)', () => {
  it('M5-1b TP-22 lists the open requests with their numbers, titles and option keys, and makes no commit', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1'), entry('D-2', { options: [{ key: 'a', text: 'Yes' }, { key: 'b', text: 'No' }] })]) });
    const lines = linesOf(await run(repo, { words: ['list'] }));
    expect(lines[0]).toBe('2 open requests.');
    expect(lines.slice(1).map((line) => line.split(/ {2,}/))).toEqual([
      ['ID', 'TITLE', 'OPTIONS'],
      ['D-1', 'Request D-1', 'a'],
      ['D-2', 'Request D-2', 'a,b'],
    ]);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-22 says that no request is open for an empty waiting file', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, { words: ['list'] }))).toEqual(['0 open requests.']);
  });

  it('M5-1b TP-22 lists a request that a hand edit left with no title and no options', async () => {
    const repo = await boardNode({ waiting: waitingText([{ id: 'D-1' }]) });
    expect(linesOf(await run(repo, { words: ['list'] })).slice(1).map((line) => line.split(/ {2,}/))).toEqual([['ID', 'TITLE', 'OPTIONS'], ['D-1', '-', '-']]);
  });

  it('M5-1b TP-91 prints a title with a bidi mark and a line break as one clean line', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { title: `Pick${bidi}\na plan` })]) });
    const text = plainText(valueOf(await run(repo, { words: ['list'] })));
    expect(text).not.toContain(bidi);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('Pick a plan');
  });

  it('M5-1b TP-91 prints at most 20 lines for a long waiting file, and a last line that says how many requests are not shown', async () => {
    const repo = await boardNode({ waiting: waitingText(Array.from({ length: 25 }, (_, at) => entry(`D-${at + 1}`))) });
    const lines = linesOf(await run(repo, { words: ['list'] }));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('25 open requests.');
    expect(lines[19]).toBe('8 more requests.');
  });

  it('M5-1b TP-91 prints the JSON document with the title as it is stored, one entry for each request', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1')]) });
    expect(valueOf(await run(repo, { words: ['list'] })).json).toEqual({
      schema: 'factory.request-list/v1',
      requests: [{ id: 'D-1', title: 'Request D-1', options: ['a'] }],
    });
  });
});

describe('request close (TP-22, TP-99)', () => {
  const OPEN = (): Promise<BoardRepo> => boardNode({ waiting: waitingText([entry('D-1'), entry('D-2', { extra: { kept: true } })]) });

  it('M5-1b TP-22 takes the request off the waiting file, adds a log row that names no one who answered, and makes one commit of the two files', async () => {
    const repo = await OPEN();
    expect(linesOf(await run(repo, { words: ['close', 'D-2'] }))).toEqual(['Closed D-2: Request D-2']);
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-1']);
    expect(logOf(repo).rows).toEqual([{ item: 'D-2: Request D-2', decision: requestWords.closedDecision, date: '2030-01-02' }]);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting, fileNames.decisionLog]]);
  });

  it('M5-1b TP-22 keeps the other requests and the other log rows as they are', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { extra: { kept: true } }), entry('D-2')]), decisionLog: logText([logRow('D-7')]) });
    valueOf(await run(repo, { words: ['close', 'D-2'] }));
    expect(waitingOf(repo).items).toEqual([entry('D-1', { extra: { kept: true } })]);
    expect(logOf(repo).rows[0]).toEqual(logRow('D-7'));
    expect(logOf(repo).rows).toHaveLength(2);
  });

  it('M5-1b TP-99 never gives the number of a closed request again', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, ADD));
    valueOf(await run(repo, { words: ['close', 'D-1'] }));
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-2: Pick a plan']);
  });

  it('M5-1b TP-22 names no title in the log row for a request that has none', async () => {
    const repo = await boardNode({ waiting: waitingText([{ id: 'D-3' }]) });
    valueOf(await run(repo, { words: ['close', 'D-3'] }));
    expect(logOf(repo).rows[0]?.['item']).toBe('D-3');
  });

  it('M5-1b TP-22 prints the JSON document of a close', async () => {
    const repo = await OPEN();
    expect(valueOf(await run(repo, { words: ['close', 'D-1'] })).json).toEqual({
      schema: 'factory.request/v1',
      action: 'close',
      id: 'D-1',
      title: 'Request D-1',
    });
  });

  const REFUSED: readonly (readonly [string, string, number])[] = [
    ['an id that the waiting file does not hold', 'D-9', 2],
    ['an id of a bad form', 'D-x', 2],
    ['an item id', 'B-1', 2],
  ];

  it.each(REFUSED)('M5-1b TP-22 refuses %s (%s) with exit %i, and changes no file', async (_name, id, code) => {
    const repo = await OPEN();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await run(repo, { words: ['close', id] })).kind]).toBe(code);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-22 refuses a request that the decision log holds already, because the log would hold its number twice', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3')]), decisionLog: logText([logRow('D-3')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-3'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-57 exits 1 with the remedy to upgrade for a board that has the old queue key, and writes nothing', async () => {
    const repo = await boardNode({ board: `${JSON.stringify({ queue: [], items: [] }, null, 2)}\n`, waiting: waitingText([entry('D-1')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.upgrade));
    expect(filesOf(repo)).toEqual(before);
  });
});

describe('request with a hosted tracker kind (TP-67)', () => {
  const hosted = async (): Promise<BoardRepo> => {
    const base = sampleConfigWithBoard();
    const config = { ...base, core: { ...base.core, tracker: { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
    return boardNode({ config, waiting: waitingText([entry('D-1')]), board: boardText() });
  };

  it.each([
    ['add', ADD],
    ['close', { words: ['close', 'D-1'] }],
  ] as const)('M5-1b TP-67 refuses request %s with exit 4 and writes nothing, and request list still works', async (_name, overrides) => {
    const repo = await hosted();
    const before = filesOf(repo);
    const error = errorOf(await run(repo, overrides));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('FAC-M3 (provider plugin)');
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
    expect(linesOf(await run(repo, { words: ['list'] }))[0]).toBe('1 open request.');
  });
});

describe('request: the JSON document of an add (TP-22)', () => {
  it('M5-1b TP-22 prints the schema, the action, the number and the title', async () => {
    const repo = await boardNode();
    expect(valueOf(await run(repo, ADD)).json).toEqual({ schema: 'factory.request/v1', action: 'add', id: 'D-1', title: 'Pick a plan' });
  });
});
