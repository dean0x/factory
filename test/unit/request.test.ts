import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runRequest, type RequestOptions } from '../../src/commands/request.js';
import {
  boardTextLimits,
  commandLines,
  commands,
  commandText,
  decisionKeys,
  files as fileNames,
  program,
  relayedMarker,
  requestCommands,
  requestGroups,
  requestWords,
} from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { boardNode, boardText } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { inPane } from '../helpers/coordinator-pane.js';
import { withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

const BASE: RequestOptions = {
  home: HOME,
  words: [],
  title: undefined,
  question: undefined,
  options: [],
  recommend: undefined,
  decider: undefined,
  decision: undefined,
  relayed: false,
  later: false,
};

const ADD: Partial<RequestOptions> = {
  words: ['add'],
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: ['a=Plan A', 'b=Plan B'],
  recommend: 'a',
};

const LOG: Partial<RequestOptions> = {
  words: ['log'],
  title: 'Pick a plan',
  decider: 'coordinator',
  decision: 'Use plan A',
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

/** The rows of the JSON document of `request list`. */
const listedRows = async (repo: BoardRepo): Promise<readonly Record<string, unknown>[]> => {
  const requests = valueOf(await run(repo, { words: ['list'] })).json['requests'];
  return Array.isArray(requests) ? (requests as Record<string, unknown>[]) : [];
};

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

const STORE_PATH = join('/state', program, fileNames.ownerDecisions);

/** A record of the owner decision file for the fake node: the node id of the sample config and the root of the board fixture. */
const storedRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  node: 'demo',
  root: HOME,
  id: 'D-1',
  option: 'a',
  hash: 'a'.repeat(64),
  at: '2030-01-02T03:04:05.678Z',
  ...overrides,
});

const storeText = (records: readonly Record<string, unknown>[]): string => `${JSON.stringify({ schema: 1, records }, null, 2)}\n`;

/** A fake node with the text of the owner decision file in place. */
const nodeWithStore = async (store: string, setup: Parameters<typeof boardNode>[0] = {}): Promise<BoardRepo> => {
  const repo = await boardNode(setup);
  repo.deps.seed(STORE_PATH, store);
  return repo;
};

describe('request add', () => {
  it('stores the decision with the first D-n, prints one line, and makes one commit that holds only the waiting file', async () => {
    const repo = await boardNode();
    const at = repo.deps.now().toISOString();
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
        [decisionKeys.openedAt]: at,
        [decisionKeys.group]: requestGroups.now,
      },
    ]);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting]]);
  });

  it('stores the time of each add, read from the clock under the lock, so a later add has a later open time', async () => {
    const repo = await boardNode();
    const first = repo.deps.now().toISOString();
    valueOf(await run(repo, ADD));
    repo.deps.advance(60_000);
    const second = repo.deps.now().toISOString();
    valueOf(await run(repo, { ...ADD, title: 'Other' }));
    expect(waitingOf(repo).items.map((item) => item[decisionKeys.openedAt])).toEqual([first, second]);
    expect(first).not.toBe(second);
  });

  it('puts a request in the group now when the later flag is absent, and in the group later when it is given', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, ADD));
    valueOf(await run(repo, { ...ADD, title: 'Other', later: true }));
    expect(waitingOf(repo).items.map((item) => item[decisionKeys.group])).toEqual([requestGroups.now, requestGroups.later]);
  });

  it('prints the same line and the same JSON document for a request in the group later', async () => {
    const repo = await boardNode();
    const output = valueOf(await run(repo, { ...ADD, later: true }));
    expect(plainText(output).trimEnd()).toBe('Added D-1: Pick a plan');
    expect(output.json).toEqual({ schema: 'factory.request/v1', action: 'add', id: 'D-1', title: 'Pick a plan' });
  });

  it('takes the number after the highest D-n of the waiting file and of the decision log', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3'), entry('D-9')]), decisionLog: logText([logRow('D-12'), logRow('D-2')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-13: Pick a plan']);
  });

  it('takes the number after the highest D-n of the waiting file when the decision log is empty', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-4')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-5: Pick a plan']);
  });

  it('takes the number after the highest D-n of the decision log when the waiting file is empty', async () => {
    const repo = await boardNode({ decisionLog: logText([logRow('D-7')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-8: Pick a plan']);
  });

  it('has no subcommand that changes a request, and a second add leaves the first request as it was', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, ADD));
    const first = waitingOf(repo).items[0];
    const error = errorOf(await run(repo, { words: ['update', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(Object.values(requestCommands).join(', '));
    repo.deps.advance(60_000);
    valueOf(await run(repo, { ...ADD, title: 'Other', options: ['x=Plan X'], recommend: undefined }));
    expect(waitingOf(repo).items).toHaveLength(2);
    expect(waitingOf(repo).items[0]).toEqual(first);
  });

  it('gives two adds that run at the same time two different numbers', async () => {
    const repo = await boardNode();
    const both = await Promise.all([run(repo, ADD), run(repo, { ...ADD, title: 'Other' })]);
    expect(both.every((result) => result.ok)).toBe(true);
    expect(waitingOf(repo).items.map((item) => item['id']).sort()).toEqual(['D-1', 'D-2']);
    expect(repo.commits).toHaveLength(2);
  });
});

describe('request add: the owner decision file', () => {
  it('takes the number after the highest D-n of the decision records of this node and this root', async () => {
    const store = storeText([
      storedRecord({ id: 'D-6' }),
      storedRecord({ id: 'D-20', node: 'other' }),
      storedRecord({ id: 'D-30', root: '/h/other' }),
    ]);
    const repo = await nodeWithStore(store, { waiting: waitingText([entry('D-2')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-7: Pick a plan']);
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-2', 'D-7']);
  });

  it('exits 1, names the decision file and writes nothing when the decision file cannot be read', async () => {
    const repo = await nodeWithStore('not json');
    const before = filesOf(repo);
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('request add: an id that exists', () => {
  it('never gives a number that the waiting file or the decision log holds, so a taken number cannot reach the write', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-5')]), decisionLog: logText([logRow('D-5')]) });
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-6: Pick a plan']);
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-5', 'D-6']);
  });

  it('exits 1 and names the waiting file for a D-n that the file holds twice, and writes nothing', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3'), entry('D-3')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, ADD));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
    expect(error.message).toContain('D-3');
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1 and names the decision log for a D-n that the log holds twice, and writes nothing', async () => {
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

describe('request add: the text of the question', () => {
  it('exits 1 and names the waiting file for a question with a line break, and writes nothing', async () => {
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

  it.each(BAD)('refuses %s with exit 2 and changes no file', async (_name, overrides) => {
    const repo = await boardNode();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await run(repo, { ...ADD, ...overrides })).kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('the words and the flags of request', () => {
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
    ['close with a decider and no decision', { words: ['close', 'D-1'], decider: 'coordinator' }, 'go together'],
    ['close with a decision and no decider', { words: ['close', 'D-1'], decision: 'Yes' }, 'go together'],
    ['add with the decider flag', { ...ADD, decider: 'coordinator' }, '--made-by is not for'],
    ['list with the decision flag', { words: ['list'], decision: 'Yes' }, '--decision is not for'],
    ['list with an argument', { words: ['list', 'D-1'] }, 'takes no argument'],
    ['list with the question flag', { words: ['list'], question: 'Why?' }, '--question is not for'],
    ['list with the recommend flag', { words: ['list'], recommend: 'a' }, '--recommend is not for'],
    ['close with the relayed flag and a decider', { words: ['close', 'D-1'], relayed: true, decider: 'coordinator', decision: 'Yes' }, '--relayed takes no --made-by'],
    ['close with the relayed flag and no decision', { words: ['close', 'D-1'], relayed: true }, '--relayed needs --decision'],
    ['add with the relayed flag', { ...ADD, relayed: true }, '--relayed is not for'],
    ['list with the relayed flag', { words: ['list'], relayed: true }, '--relayed is not for'],
    ['log with the relayed flag', { ...LOG, relayed: true }, '--relayed is not for'],
    ['list with the later flag', { words: ['list'], later: true }, '--later is not for'],
    ['close with the later flag', { words: ['close', 'D-1'], later: true }, '--later is not for'],
    ['close with the relayed flag and the later flag', { words: ['close', 'D-1'], relayed: true, decision: 'Yes', later: true }, '--later is not for'],
    ['log with the later flag', { ...LOG, later: true }, '--later is not for'],
    ['log with no title', { ...LOG, title: undefined }, '--title'],
    ['log with no decider and no decision', { ...LOG, decider: undefined, decision: undefined }, '--made-by'],
    ['log with a decider and no decision', { ...LOG, decision: undefined }, 'go together'],
    ['log with an argument', { ...LOG, words: ['log', 'D-1'] }, 'takes no argument'],
    ['log with the question flag', { ...LOG, question: 'Why?' }, '--question is not for'],
    ['close with the title flag and the relayed flag', { words: ['close', 'D-1'], relayed: true, decision: 'Yes', title: 'Other' }, '--title is not for'],
  ];

  it.each(BAD_WORDS)('%s exits 2 and touches no file', async (_name, overrides, message) => {
    const repo = await boardNode();
    const touched: string[] = [];
    const error = errorOf(await runRequest(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...overrides }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain(message);
    expect(error.hint).toContain(commandText(commands.request));
    expect(touched).toEqual([]);
  });
});

describe('request list', () => {
  it('lists the open requests with their numbers, titles and option keys, and makes no commit', async () => {
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

  it('says that no request is open for an empty waiting file', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, { words: ['list'] }))).toEqual(['0 open requests.']);
  });

  it('lists a request that a hand edit left with no title and no options', async () => {
    const repo = await boardNode({ waiting: waitingText([{ id: 'D-1' }]) });
    expect(linesOf(await run(repo, { words: ['list'] })).slice(1).map((line) => line.split(/ {2,}/))).toEqual([['ID', 'TITLE', 'OPTIONS'], ['D-1', '-', '-']]);
  });

  it('prints a title with a bidi mark and a line break as one clean line', async () => {
    const bidi = String.fromCodePoint(0x202e);
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { title: `Pick${bidi}\na plan` })]) });
    const text = plainText(valueOf(await run(repo, { words: ['list'] })));
    expect(text).not.toContain(bidi);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('Pick a plan');
  });

  it('prints at most 20 lines for a long waiting file, and a last line that says how many requests are not shown', async () => {
    const repo = await boardNode({ waiting: waitingText(Array.from({ length: 25 }, (_, at) => entry(`D-${at + 1}`))) });
    const lines = linesOf(await run(repo, { words: ['list'] }));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('25 open requests.');
    expect(lines[19]).toBe('8 more requests.');
  });

  it('prints the JSON document with the title as it is stored, one entry for each request, and null and now for a row from before the two keys', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1')]) });
    expect(valueOf(await run(repo, { words: ['list'] })).json).toEqual({
      schema: 'factory.request-list/v1',
      requests: [{ id: 'D-1', title: 'Request D-1', options: ['a'], openedAt: null, group: 'now' }],
    });
  });

  it('gives the open time and the group of each request that request add stored', async () => {
    const repo = await boardNode();
    const first = repo.deps.now().toISOString();
    valueOf(await run(repo, ADD));
    repo.deps.advance(60_000);
    const second = repo.deps.now().toISOString();
    valueOf(await run(repo, { ...ADD, title: 'Other', later: true }));
    expect(valueOf(await run(repo, { words: ['list'] })).json).toEqual({
      schema: 'factory.request-list/v1',
      requests: [
        { id: 'D-1', title: 'Pick a plan', options: ['a', 'b'], openedAt: first, group: requestGroups.now },
        { id: 'D-2', title: 'Other', options: ['a', 'b'], openedAt: second, group: requestGroups.later },
      ],
    });
  });

  it.each([
    ['a time that is not an exact time', '2030-01-02', null],
    ['a time with no millisecond part', '2030-01-02T03:04:05Z', null],
    ['a time that is no text', 1893553445678, null],
    ['an exact time', '2030-01-02T03:04:05.678Z', '2030-01-02T03:04:05.678Z'],
  ])('reads %s of a hand edited row as %j', async (_name, stored, expected) => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { [decisionKeys.openedAt]: stored })]) });
    const rows = await listedRows(repo);
    expect(rows[0]?.['openedAt']).toBe(expected);
  });

  it.each([
    ['a group that is no word of the list', 'soon'],
    ['a group that is no text', 3],
    ['a group in capital letters', 'LATER'],
    ['the group now', requestGroups.now],
  ])('reads %s of a hand edited row as now', async (_name, stored) => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { [decisionKeys.group]: stored })]) });
    const rows = await listedRows(repo);
    expect(rows[0]?.['group']).toBe(requestGroups.now);
  });

  it('reads the group later of a row', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { [decisionKeys.group]: requestGroups.later })]) });
    const rows = await listedRows(repo);
    expect(rows[0]?.['group']).toBe(requestGroups.later);
  });

  it('prints the text of a list with no open time and no group, so the table keeps its columns', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { [decisionKeys.openedAt]: '2030-01-02T03:04:05.678Z', [decisionKeys.group]: requestGroups.later })]) });
    expect(linesOf(await run(repo, { words: ['list'] })).slice(1).map((line) => line.split(/ {2,}/))).toEqual([['ID', 'TITLE', 'OPTIONS'], ['D-1', 'Request D-1', 'a']]);
  });
});

describe('request close', () => {
  const OPEN = (): Promise<BoardRepo> => boardNode({ waiting: waitingText([entry('D-1'), entry('D-2', { extra: { kept: true } })]) });

  it('takes the request off the waiting file, adds a log row that names no one who answered, and makes one commit of the two files', async () => {
    const repo = await OPEN();
    expect(linesOf(await run(repo, { words: ['close', 'D-2'] }))).toEqual(['Closed D-2: Request D-2']);
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-1']);
    expect(logOf(repo).rows).toEqual([{ item: 'D-2: Request D-2', decision: requestWords.closedDecision, date: '2030-01-02' }]);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting, fileNames.decisionLog]]);
  });

  it('keeps the other requests and the other log rows as they are', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-1', { extra: { kept: true } }), entry('D-2')]), decisionLog: logText([logRow('D-7')]) });
    valueOf(await run(repo, { words: ['close', 'D-2'] }));
    expect(waitingOf(repo).items).toEqual([entry('D-1', { extra: { kept: true } })]);
    expect(logOf(repo).rows[0]).toEqual(logRow('D-7'));
    expect(logOf(repo).rows).toHaveLength(2);
  });

  it('keeps the open time and the group of the other open requests', async () => {
    const kept = entry('D-1', { [decisionKeys.openedAt]: '2030-01-02T03:04:05.678Z', [decisionKeys.group]: requestGroups.later });
    const repo = await boardNode({ waiting: waitingText([kept, entry('D-2')]) });
    valueOf(await run(repo, { words: ['close', 'D-2'] }));
    expect(waitingOf(repo).items).toEqual([kept]);
    expect(await listedRows(repo)).toEqual([
      { id: 'D-1', title: 'Request D-1', options: ['a'], openedAt: '2030-01-02T03:04:05.678Z', group: requestGroups.later },
    ]);
  });

  it('never gives the number of a closed request again', async () => {
    const repo = await boardNode();
    valueOf(await run(repo, ADD));
    valueOf(await run(repo, { words: ['close', 'D-1'] }));
    expect(linesOf(await run(repo, ADD))).toEqual(['Added D-2: Pick a plan']);
  });

  it('names no title in the log row for a request that has none', async () => {
    const repo = await boardNode({ waiting: waitingText([{ id: 'D-3' }]) });
    valueOf(await run(repo, { words: ['close', 'D-3'] }));
    expect(logOf(repo).rows[0]?.['item']).toBe('D-3');
  });

  it('prints the JSON document of a close', async () => {
    const repo = await OPEN();
    expect(valueOf(await run(repo, { words: ['close', 'D-1'] })).json).toEqual({
      schema: 'factory.request/v1',
      action: 'close',
      id: 'D-1',
      title: 'Request D-1',
      decider: null,
    });
  });

  it.each(['coordinator', 'delegate'])('closes a request with the decision of the %s: the row names the decider and has no owner key', async (decider) => {
    const repo = await OPEN();
    const lines = linesOf(await run(repo, { words: ['close', 'D-2'], decider, decision: 'Use plan A' }));
    expect(lines).toEqual([`Closed D-2: Request D-2 (decided by the ${decider}, no owner authority)`]);
    const row = logOf(repo).rows[0] ?? {};
    expect(row).toEqual({ item: 'D-2: Request D-2', decision: 'Use plan A', date: '2030-01-02', decider });
    expect(row).not.toHaveProperty('by');
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-1']);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting, fileNames.decisionLog]]);
  });

  it('prints the decider in the JSON document of a close with a decision', async () => {
    const repo = await OPEN();
    expect(valueOf(await run(repo, { words: ['close', 'D-1'], decider: 'coordinator', decision: 'Yes' })).json).toEqual({
      schema: 'factory.request/v1',
      action: 'close',
      id: 'D-1',
      title: 'Request D-1',
      decider: 'coordinator',
    });
  });

  it('refuses the owner as a decider with exit 2, names decide, and touches no file', async () => {
    const repo = await OPEN();
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    const error = errorOf(await runRequest(watched, { ...BASE, words: ['close', 'D-1'], decider: 'owner', decision: 'Yes' }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('coordinator or delegate');
    expect(error.hint).toContain(commandText(commands.decide));
    expect(touched).toEqual([]);
  });

  it('refuses a decision with a line break with exit 2, and changes no file', async () => {
    const repo = await OPEN();
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-1'], decider: 'coordinator', decision: 'Yes\nand no' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['an empty decision', ''],
    ['a decision of more than the most characters', 'x'.repeat(boardTextLimits.maxTextChars + 1)],
  ])('refuses %s with exit 2, and changes no file', async (_name, decision) => {
    const repo = await OPEN();
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-1'], decider: 'coordinator', decision }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('refuses a close with a decision for a request that the owner answered, as a close with no answer', async () => {
    const repo = await nodeWithStore(storeText([storedRecord({ id: 'D-2' })]), { waiting: waitingText([entry('D-1'), entry('D-2')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-2'], decider: 'delegate', decision: 'No' }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.decide));
    expect(filesOf(repo)).toEqual(before);
  });

  const REFUSED: readonly (readonly [string, string, number])[] = [
    ['an id that the waiting file does not hold', 'D-9', 2],
    ['an id of a bad form', 'D-x', 2],
    ['an item id', 'B-1', 2],
  ];

  it.each(REFUSED)('refuses %s (%s) with exit %i, and changes no file', async (_name, id, code) => {
    const repo = await OPEN();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await run(repo, { words: ['close', id] })).kind]).toBe(code);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('refuses a request that the decision log holds already, because the log would hold its number twice', async () => {
    const repo = await boardNode({ waiting: waitingText([entry('D-3')]), decisionLog: logText([logRow('D-3')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-3'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.decisionLog);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1, says that the owner answered, names decide and writes nothing for a request that has a decision record', async () => {
    const repo = await nodeWithStore(storeText([storedRecord({ id: 'D-2' })]), { waiting: waitingText([entry('D-1'), entry('D-2')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-2'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('answered');
    expect(error.hint).toContain(commandText(commands.decide));
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('closes a request that has no record when the store holds the record of another request', async () => {
    const repo = await nodeWithStore(storeText([storedRecord({ id: 'D-2' })]), { waiting: waitingText([entry('D-1'), entry('D-2')]) });
    expect(linesOf(await run(repo, { words: ['close', 'D-1'] }))).toEqual(['Closed D-1: Request D-1']);
  });

  it('exits 1, names the decision file and writes nothing when the decision file cannot be read', async () => {
    const repo = await nodeWithStore('not json', { waiting: waitingText([entry('D-1')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1 with the remedy to upgrade for a board that has the old queue key, and writes nothing', async () => {
    const repo = await boardNode({ board: `${JSON.stringify({ queue: [], items: [] }, null, 2)}\n`, waiting: waitingText([entry('D-1')]) });
    const before = filesOf(repo);
    const error = errorOf(await run(repo, { words: ['close', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.upgrade));
    expect(filesOf(repo)).toEqual(before);
  });
});

describe('request close --relayed', () => {
  const OPEN = (): Promise<BoardRepo> => boardNode({ waiting: waitingText([entry('D-1'), entry('D-2')]) });
  const RELAY: Partial<RequestOptions> = { words: ['close', 'D-2'], relayed: true, decision: 'Use plan A' };
  const relay = (deps: FakeDeps, overrides: Partial<RequestOptions> = {}): Promise<CliResult<CommandOutput>> =>
    runRequest(deps, { ...BASE, ...RELAY, ...overrides }, recipes);
  const pathsOf = (repo: BoardRepo): string[] => [...repo.deps.files.keys()].sort();

  it('closes the request from the pane of the coordinator: the row names the coordinator and the relay, and holds no owner key', async () => {
    const repo = await OPEN();
    const pathsBefore = pathsOf(repo);
    const output = valueOf(await relay(inPane(repo.deps, '%0')));
    expect(plainText(output).trimEnd()).toBe(`Closed D-2: Request D-2 (${relayedMarker})`);
    expect(output.json).toEqual({ schema: 'factory.request/v1', action: 'close', id: 'D-2', title: 'Request D-2', decider: 'coordinator', relayed: true });
    const row = logOf(repo).rows[0] ?? {};
    expect(row).toEqual({ item: 'D-2: Request D-2', decision: 'Use plan A', date: '2030-01-02', decider: 'coordinator', relayed: relayedMarker });
    expect(row).not.toHaveProperty('by');
    expect(waitingOf(repo).items.map((item) => item['id'])).toEqual(['D-1']);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.waiting, fileNames.decisionLog]]);
    expect(pathsOf(repo)).toEqual(pathsBefore);
  });

  it('refuses a caller in the pane of a worker with exit 2, does not repeat the decision in the refusal, and changes no file', async () => {
    const repo = await OPEN();
    const before = filesOf(repo);
    const error = errorOf(await relay(inPane(repo.deps, '%1'), { decision: 'PRIVATE-TEXT' }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain(`${commandText(commandLines.requestClose)} D-2 --relayed`);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('PRIVATE-TEXT');
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('refuses a caller outside tmux with exit 2, and changes no file', async () => {
    const repo = await OPEN();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await relay(repo.deps)).kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('refuses an id of a bad form with exit 2 before the caller rule runs a tmux call', async () => {
    const repo = await OPEN();
    const tmuxCalls: (readonly string[])[] = [];
    expect(exitCodeOf[errorOf(await relay(inPane(repo.deps, '%0', tmuxCalls), { words: ['close', 'D-x\ny'] })).kind]).toBe(2);
    expect(tmuxCalls).toEqual([]);
    expect(repo.commits).toEqual([]);
  });

  it('refuses a request that the owner answered, as a close from the coordinator does', async () => {
    const repo = await nodeWithStore(storeText([storedRecord({ id: 'D-2' })]), { waiting: waitingText([entry('D-1'), entry('D-2')]) });
    const before = filesOf(repo);
    const error = errorOf(await relay(inPane(repo.deps, '%0')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain(commandText(commands.decide));
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('refuses a request that is not in the waiting file with exit 2, and changes no file', async () => {
    const repo = await OPEN();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await relay(inPane(repo.deps, '%0'), { words: ['close', 'D-9'] })).kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
  });
});

describe('request log', () => {
  const run = (repo: BoardRepo, overrides: Partial<RequestOptions> = {}): Promise<CliResult<CommandOutput>> =>
    runRequest(repo.deps, { ...BASE, ...LOG, ...overrides }, recipes);

  it('writes one log row with the next number over the waiting file, the log and the owner store, in one commit of the log', async () => {
    const repo = await nodeWithStore(storeText([storedRecord({ id: 'D-12' })]), { waiting: waitingText([entry('D-3')]), decisionLog: logText([logRow('D-9')]) });
    const waitingBefore = repo.textOf(fileNames.waiting);
    expect(linesOf(await run(repo))).toEqual(['Logged D-13: Pick a plan (decided by the coordinator, no owner authority)']);
    expect(logOf(repo).rows).toEqual([logRow('D-9'), { item: 'D-13: Pick a plan', decision: 'Use plan A', date: '2030-01-02', decider: 'coordinator' }]);
    expect(repo.textOf(fileNames.waiting)).toBe(waitingBefore);
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.decisionLog]]);
  });

  it('names a delegate as the decider, and the row holds no owner key and no relay key', async () => {
    const repo = await boardNode();
    expect(linesOf(await run(repo, { decider: 'delegate' }))).toEqual(['Logged D-1: Pick a plan (decided by the delegate, no owner authority)']);
    const row = logOf(repo).rows[0] ?? {};
    expect(row).toEqual({ item: 'D-1: Pick a plan', decision: 'Use plan A', date: '2030-01-02', decider: 'delegate' });
    expect(row).not.toHaveProperty('by');
    expect(row).not.toHaveProperty('relayed');
  });

  it('adds no waiting entry, and the next request takes the number after the logged one', async () => {
    const repo = await boardNode();
    valueOf(await run(repo));
    expect(waitingOf(repo).items).toEqual([]);
    expect(linesOf(await runRequest(repo.deps, { ...BASE, ...ADD }, recipes))).toEqual(['Added D-2: Pick a plan']);
  });

  it('prints the JSON document of a logged decision', async () => {
    const repo = await boardNode();
    expect(valueOf(await run(repo)).json).toEqual({ schema: 'factory.request/v1', action: 'log', id: 'D-1', title: 'Pick a plan', decider: 'coordinator' });
  });

  it('refuses the owner as a decider with exit 2, names decide, and touches no file', async () => {
    const repo = await boardNode();
    const touched: string[] = [];
    const error = errorOf(await runRequest(withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`)), { ...BASE, ...LOG, decider: 'owner' }, recipes));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain(commandText(commands.decide));
    expect(touched).toEqual([]);
  });

  it.each([
    ['a decider that is not known', { decider: 'boss' }],
    ['an empty title', { title: ' ' }],
    ['a title with a line break', { title: 'Two\nlines' }],
    ['a title of more than the most characters', { title: 'x'.repeat(boardTextLimits.maxTitleChars + 1) }],
    ['an empty decision', { decision: '' }],
    ['a decision with a line break', { decision: 'Yes\nand no' }],
    ['a decision of more than the most characters', { decision: 'x'.repeat(boardTextLimits.maxTextChars + 1) }],
  ] as const)('refuses %s with exit 2, and changes no file', async (_name, overrides) => {
    const repo = await boardNode();
    const before = filesOf(repo);
    expect(exitCodeOf[errorOf(await run(repo, overrides)).kind]).toBe(2);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1, names the decision file and writes nothing when the decision file cannot be read', async () => {
    const repo = await nodeWithStore('not json');
    const before = filesOf(repo);
    const error = errorOf(await run(repo));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });
});

describe('request with a hosted tracker kind', () => {
  const hosted = async (): Promise<BoardRepo> => {
    const base = sampleConfigWithBoard();
    const config = { ...base, core: { ...base.core, tracker: { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
    return boardNode({ config, waiting: waitingText([entry('D-1')]), board: boardText() });
  };

  it('refuses a relayed close from the pane of the coordinator with exit 4 and writes nothing', async () => {
    const repo = await hosted();
    const before = filesOf(repo);
    const error = errorOf(await runRequest(inPane(repo.deps, '%0'), { ...BASE, words: ['close', 'D-1'], relayed: true, decision: 'Yes' }, recipes));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(filesOf(repo)).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['add', ADD],
    ['close', { words: ['close', 'D-1'] }],
    ['log', LOG],
  ] as const)('refuses request %s with exit 4 and writes nothing, and request list still works', async (_name, overrides) => {
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

describe('request: the JSON document of an add', () => {
  it('prints the schema, the action, the number and the title', async () => {
    const repo = await boardNode();
    expect(valueOf(await run(repo, ADD)).json).toEqual({ schema: 'factory.request/v1', action: 'add', id: 'D-1', title: 'Pick a plan' });
  });
});
