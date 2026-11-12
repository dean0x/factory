import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { runDecide, type DecideOptions } from '../../src/commands/decide.js';
import { runRequest } from '../../src/commands/request.js';
import type { Deps } from '../../src/core/deps.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { ok } from '../../src/core/result.js';
import {
  boardTextLimits,
  dirs,
  env,
  files as fileNames,
  maxEchoChars,
  maxFileBytes,
  privateFile,
  program,
  schemaIds,
  stateLock,
} from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { layoutOf, stateRel } from '../../src/state/layout.js';
import { boardNode, boardText } from '../helpers/board-node.js';
import { WAITING_PATH, type BoardRepo } from '../helpers/board-repo.js';
import { exited } from '../helpers/fake-deps.js';
import { HOME, HOOK } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';

// The decide command (M5-1b, phase B5c): the parse, the owner check, the request block, the question and the record.

const LAYOUT = layoutOf(HOME);
const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);
const PROFILE_DIR = join(LAYOUT.stateDir, dirs.profile);
const STORE_PATH = join('/state', program, fileNames.ownerDecisions);
const STORE_LOCK = `${STORE_PATH}${privateFile.lockSuffix}`;
const AT = '2030-01-02T03:04:05.678Z';
const RECORD_NAME = '2030-01-02-d-1-pick-a-plan.md';
const RECORD_PATH = join(stateRel.profileDecisions, RECORD_NAME);

const ENTRY = {
  id: 'D-1',
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: [{ key: 'a', text: 'Plan A', rec: true }, { key: 'b', text: 'Plan B' }],
};
const CHANGED_ENTRY = { ...ENTRY, question: 'Which plan do we drop?' };

const textOf = (entry: Record<string, unknown>): string => {
  const text = canonicalRequestText(entry);
  if (!text.ok) throw new Error(text.error);
  return text.value;
};
const TEXT = textOf(ENTRY);
const HASH = requestHashOf(TEXT);

const jsonOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const waitingOf = (...entries: readonly Record<string, unknown>[]): string => jsonOf({ intro: '', groups: [], items: entries });
const logOf = (...rows: readonly Record<string, unknown>[]): string => jsonOf({ rows });
const storeOf = (...records: readonly Record<string, unknown>[]): string => jsonOf({ schema: 1, records });
const closedRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item: 'D-1: Pick a plan',
  decision: 'closed',
  date: '2030-01-02',
  ...overrides,
});
const answerRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  item: 'D-1: Pick a plan',
  decision: 'a',
  date: '2030-01-02',
  by: 'owner',
  request: TEXT,
  ...overrides,
});
const storedRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  node: 'demo',
  root: HOME,
  id: 'D-1',
  option: 'a',
  hash: HASH,
  at: AT,
  ...overrides,
});

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};
const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};
const exitOf = <T>(result: CliResult<T>): number => exitCodeOf[errorOf(result).kind];

interface Setup {
  readonly waiting?: string;
  readonly decisionLog?: string;
  readonly store?: string;
  readonly hosted?: boolean;
}

const nodeOf = async (setup: Setup = {}): Promise<BoardRepo> => {
  const base = sampleConfigWithBoard();
  const hosted = { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' };
  const config = setup.hosted === true ? { ...base, core: { ...base.core, tracker: hosted } } : base;
  const repo = await boardNode({
    config,
    board: boardText(),
    waiting: setup.waiting ?? waitingOf(ENTRY),
    ...(setup.decisionLog === undefined ? {} : { decisionLog: setup.decisionLog }),
  });
  repo.deps.seedDir(PROFILE_DIR);
  if (setup.store !== undefined) repo.deps.seed(STORE_PATH, setup.store);
  return repo;
};

type Answer = (question: string) => CliResult<string> | Promise<CliResult<string>>;

interface Terminal {
  readonly deps: Deps;
  /** The questions that the command asked, in order. */
  readonly asked: string[];
}

/** The deps of a person at a terminal window: the same files and git, the clock on `AT`, and the answers that `answer` gives. */
const atTerminal = (repo: BoardRepo, answer: Answer = () => ok('y'), changes: Partial<Deps> = {}): Terminal => {
  const asked: string[] = [];
  const deps: Deps = {
    ...repo.deps,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    now: () => new Date(AT),
    prompt: async (question) => {
      asked.push(question);
      return answer(question);
    },
    ...changes,
  };
  return { deps, asked };
};

const DECIDE: DecideOptions = { home: HOME, words: ['D-1', 'a'], note: undefined, json: false };

const decide = (deps: Deps, overrides: Partial<DecideOptions> = {}): Promise<CliResult<CommandOutput>> =>
  runDecide(deps, { ...DECIDE, ...overrides }, recipes);

const shownOf = (repo: BoardRepo): string[] => repo.deps.written.join('').split('\n').slice(0, -1);

const waitingIds = (repo: BoardRepo): string[] =>
  (JSON.parse(repo.textOf(fileNames.waiting) ?? '') as { items: { id: string }[] }).items.map((entry) => entry.id);

const storedRecords = (repo: BoardRepo): Record<string, unknown>[] => {
  const text = repo.deps.files.get(STORE_PATH);
  return text === undefined ? [] : (JSON.parse(text) as { records: Record<string, unknown>[] }).records;
};

/** Nothing happened: the files are as they were, no commit, no question, no request block. */
const expectNothingDone = (repo: BoardRepo, before: ReadonlyMap<string, string>, terminal: Terminal): void => {
  expect(repo.deps.files).toEqual(before);
  expect(repo.commits).toEqual([]);
  expect(terminal.asked).toEqual([]);
  expect(repo.deps.written).toEqual([]);
};

describe('decide: the words and the flags are checked first, with exit 2 (TP-184, TP-187)', () => {
  it('M5-1b TP-187 says that decide read is not in this version, with exit 2, before the owner check', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { words: ['read', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('not in this version');
    expect(error.message).toContain('decide read');
  });

  it('M5-1b TP-187 says the same for decide read with no more words', async () => {
    const repo = await nodeOf();
    expect(errorOf(await decide(repo.deps, { words: ['read'] })).message).toContain('not in this version');
  });

  it.each([[[]], [['D-1']], [['D-1', 'a', 'b']]] as const)('M5-1b TP-187 exits 2 for %j: decide takes two words', async (words) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words }))).toBe(2);
  });

  it('M5-1b TP-187 exits 2 for the json flag and names the text output', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { json: true }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('--json');
    expect(error.hint).toContain('factory decide');
  });

  it.each([['D-05'], ['D-0'], ['B-1'], ['d-1'], ['D-1000000000']])('M5-1b TP-187 exits 2 for the id %s, which is not canonical', async (id) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words: [id, 'a'] }))).toBe(2);
  });

  it.each([['-a'], ['a/b'], ['a b'], ['x'.repeat(41)]])('M5-1b TP-187 exits 2 for the option key %s, which is not in the token form', async (key) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words: ['D-1', key] }))).toBe(2);
  });

  it('M5-1b TP-148 shows a typed option that has an escape sequence and a long text clean and cut', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { words: ['D-1', `${'x'.repeat(100)}\u001b[31m`] }));
    expect(error.message).not.toContain('\u001b');
    expect(error.message).toContain('x'.repeat(maxEchoChars));
    expect(error.message).not.toContain('x'.repeat(maxEchoChars + 1));
  });

  it.each([
    ['a text with no character', ''],
    ['a text of spaces', '   '],
    ['a text over the cap', 'x'.repeat(boardTextLimits.maxNoteChars + 1)],
    ['a line break', 'two\nlines'],
    ['a control character', 'bell\u0007'],
    ['a bidi character', 'bidi ‮ text'],
    ['a hidden character', 'zero​width'],
  ])('M5-1b TP-184 exits 2 for a note with %s, before the owner check, the question and any file', async (_name, note) => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok('y'), { stdinIsTTY: false });
    expect(exitOf(await decide(terminal.deps, { note }))).toBe(2);
    expectNothingDone(repo, before, terminal);
  });
});

describe('decide: the owner check, the hosted kind and the guard come before the read and the question (TP-141, TP-143, TP-164)', () => {
  const CASES: readonly (readonly [string, Partial<Deps>])[] = [
    ['FACTORY_SESSION is set', { env: { PATH: '/bin', XDG_STATE_HOME: '/state', [env.session]: 'demo' } }],
    ['CLAUDECODE is set', { env: { PATH: '/bin', XDG_STATE_HOME: '/state', [env.claudeCode]: '1' } }],
    ['stdin is not a terminal', { stdinIsTTY: false }],
    ['stdout is not a terminal', { stdoutIsTTY: false }],
  ];

  it.each(CASES)('M5-1b TP-143 exits 4 when %s, names decide, and writes and asks nothing', async (_name, changes) => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok('y'), changes);
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('factory decide');
    expectNothingDone(repo, before, terminal);
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
  });

  it('M5-1b TP-141 exits 4 with the guard off, shows no request block, asks nothing and writes nothing', async () => {
    const repo = await nodeOf();
    repo.deps.files.set(HOOK, '#!/bin/sh\nexit 0\n');
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    expect(exitOf(await decide(terminal.deps))).toBe(4);
    expectNothingDone(repo, before, terminal);
  });

  it('M5-1b TP-164 exits 4 for a hosted tracker kind, with the message, no question, no commit and no store file', async () => {
    const repo = await nodeOf({ hosted: true });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('FAC-M3 (provider plugin)');
    expect(error.hint).toContain('then run "factory decide" again');
    expectNothingDone(repo, before, terminal);
  });
});

describe('decide: the state of the number comes before the question (TP-145, TP-148, TP-152, TP-193)', () => {
  const refused = async (setup: Setup, overrides: Partial<DecideOptions> = {}): Promise<{ error: CliError; repo: BoardRepo }> => {
    const repo = await nodeOf(setup);
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps, overrides));
    expectNothingDone(repo, before, terminal);
    return { error, repo };
  };

  it('M5-1b TP-145 exits 2 for a number that no file holds', async () => {
    const { error } = await refused({}, { words: ['D-9', 'a'] });
    expect(exitCodeOf[error.kind]).toBe(2);
  });

  it('M5-1b TP-145 exits 2 for an option that the request does not have, and lists the keys', async () => {
    const { error } = await refused({}, { words: ['D-1', 'z'] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('a, b');
  });

  it('M5-1b TP-145 exits 1 for a closed number', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow()) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-02');
  });

  it('M5-1b TP-145 exits 1 for a number that the coordinator closed with a decision, and names the decider', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ decider: 'coordinator' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('decided by the "coordinator"');
  });

  it('M5-1b TP-145 does not print a decider of a closed row that is no value of the deciders', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ decider: 'EVIL-PEER' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).not.toContain('EVIL-PEER');
    expect(error.message).not.toContain('decided by');
  });

  it('M5-1b TP-148 shows the date of a closed row clean and cut', async () => {
    const date = `2030\u001b[31m${'9'.repeat(100)}`;
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ date })) });
    expect(error.message).not.toContain('\u001b');
    expect(error.message).not.toContain('9'.repeat(maxEchoChars + 1));
  });

  it('M5-1b TP-145 exits 1 for a row with by and a matching record, and names the date of the answer', async () => {
    const { error } = await refused({
      waiting: waitingOf(),
      decisionLog: logOf(answerRow({ date: '2030-02-03' })),
      store: storeOf(storedRecord({ at: '2030-01-05T10:00:00.000Z' })),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-05');
  });

  it('M5-1b TP-193 exits 1 for a row with by and no record: the row is not an owner answer, and a new request is the remedy', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(answerRow()) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('not an owner answer');
    expect(error.hint).toContain('factory request add');
  });

  it('M5-1b TP-193 exits 1 for a row with by and a record of another request text', async () => {
    const { error } = await refused({
      waiting: waitingOf(),
      decisionLog: logOf(answerRow({ request: textOf(CHANGED_ENTRY) })),
      store: storeOf(storedRecord()),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('not an owner answer');
  });

  it('M5-1b TP-145 exits 1 for a number that only the decision file holds, and names the stored time', async () => {
    const { error } = await refused({ waiting: waitingOf(), store: storeOf(storedRecord({ at: '2030-01-05T10:00:00.000Z' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-05T10:00:00.000Z');
  });

  it('M5-1b TP-193 exits 1 and names the decision file when it cannot be read', async () => {
    const { error } = await refused({ store: '{"schema":1,' });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
  });

  it('M5-1b TP-152 exits 1 before the question and writes nothing when the decision file is not valid', async () => {
    const { error } = await refused({ store: storeOf({ ...storedRecord(), extra: 'x' }) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
  });

  it('M5-1b TP-168 exits 1, names waiting.json and writes nothing for an entry that fails the strict read', async () => {
    const { error } = await refused({ waiting: waitingOf({ ...ENTRY, extra: 'x' }) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
  });
});

describe('decide: the record of the store for an open request (TP-153, TP-177, TP-178)', () => {
  it('M5-1b TP-178 exits 1 for a record with another request hash, names the stored option and time, and gives the two remedies', async () => {
    const repo = await nodeOf({ store: storeOf(storedRecord({ hash: 'f'.repeat(64), option: 'b', at: '2030-01-01T00:00:00.000Z' })) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('"b"');
    expect(error.message).toContain('2030-01-01T00:00:00.000Z');
    expect(error.hint).toContain('Restore waiting.json from the last commit');
    expect(error.hint).toContain('If waiting.json is not changed, add a new request with "factory request add".');
    expectNothingDone(repo, before, terminal);
  });

  it('M5-1b TP-153 exits 1 for a record with another option, names the stored option and time, and changes nothing', async () => {
    const repo = await nodeOf({ store: storeOf(storedRecord({ option: 'b', at: '2030-01-01T00:00:00.000Z' })) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps, { words: ['D-1', 'a'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('"b"');
    expect(error.message).toContain('2030-01-01T00:00:00.000Z');
    expectNothingDone(repo, before, terminal);
  });

  it('M5-1b TP-177 finishes the copies of an orphan record with exit 0, with the stored time and no new store text', async () => {
    const stored = storeOf(storedRecord({ at: '2029-12-30T10:00:00.000Z' }));
    const repo = await nodeOf({ store: stored });
    const terminal = atTerminal(repo);
    const output = valueOf(await decide(terminal.deps));
    expect(terminal.asked).toHaveLength(1);
    expect(repo.deps.files.get(STORE_PATH)).toBe(stored);
    expect(waitingIds(repo)).toEqual([]);
    expect(repo.textOf(join(stateRel.profileDecisions, '2029-12-30-d-1-pick-a-plan.md'))).toContain('time: 2029-12-30T10:00:00.000Z');
    expect(output.json).toMatchObject({ outcome: 'existing' });
    expect(plainText(output)).toContain('Finished the board copy');
  });

  it('M5-1b TP-177 exits 1 and commits no board copy when another run stored the same answer with another time during the question', async () => {
    const repo = await nodeOf();
    const otherAt = '2029-12-30T10:00:00.000Z';
    const terminal = atTerminal(repo, () => {
      repo.deps.seed(STORE_PATH, storeOf(storedRecord({ at: otherAt })));
      return ok('y');
    });
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(otherAt);
    expect(error.hint).toContain('"factory decide D-1 a"');
    expect(repo.commits).toEqual([]);
    expect(waitingIds(repo)).toEqual(['D-1']);
    expect(repo.deps.files.has(join(LAYOUT.stateDir, RECORD_PATH))).toBe(false);
    expect(storedRecords(repo)).toEqual([storedRecord({ at: otherAt })]);
    expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('M5-1b TP-177 finishes the board copy with the stored time when the same command runs again after that stop', async () => {
    const repo = await nodeOf();
    const otherAt = '2029-12-30T10:00:00.000Z';
    errorOf(
      await decide(
        atTerminal(repo, () => {
          repo.deps.seed(STORE_PATH, storeOf(storedRecord({ at: otherAt })));
          return ok('y');
        }).deps,
      ),
    );
    const again = valueOf(await decide(atTerminal(repo).deps));
    expect(again.json).toMatchObject({ outcome: 'existing' });
    expect(waitingIds(repo)).toEqual([]);
    expect(repo.textOf(join(stateRel.profileDecisions, '2029-12-30-d-1-pick-a-plan.md'))).toContain(`time: ${otherAt}`);
  });
});

describe('decide: a yes answer records the answer (TP-150, TP-154, TP-181)', () => {
  it('M5-1b TP-150 asks once, writes the store record outside the factory folder with no note, and shows what was recorded', async () => {
    const repo = await nodeOf();
    const terminal = atTerminal(repo);
    const output = valueOf(await decide(terminal.deps));
    expect(terminal.asked).toHaveLength(1);
    expect(terminal.asked[0]).toContain('D-1');
    expect(storedRecords(repo)).toEqual([storedRecord()]);
    expect(STORE_PATH.startsWith(HOME)).toBe(false);
    expect(repo.deps.files.get(STORE_PATH)).not.toContain('note');
    expect(plainText(output).split('\n')).toEqual([
      'Recorded the answer a for D-1: Pick a plan',
      `Profile record: ${RECORD_PATH}`,
      '',
    ]);
    expect(output.json).toEqual({ schema: schemaIds.decide, id: 'D-1', option: 'a', outcome: 'stored', record: RECORD_PATH });
    expect(output.warnings).toEqual([]);
  });

  it('M5-1b TP-154 makes one commit with the two board files, the profile record and log.md, and a row with by and the request text', async () => {
    const repo = await nodeOf({ waiting: waitingOf(ENTRY, { ...ENTRY, id: 'D-2' }) });
    valueOf(await decide(atTerminal(repo).deps));
    expect(repo.commits).toHaveLength(1);
    expect([...(repo.commits[0]?.staged ?? [])].sort()).toEqual([fileNames.waiting, fileNames.decisionLog, RECORD_PATH, stateRel.profileLog].sort());
    expect(waitingIds(repo)).toEqual(['D-2']);
    const row = (JSON.parse(repo.textOf(fileNames.decisionLog) ?? '') as { rows: Record<string, unknown>[] }).rows[0];
    expect(row).toEqual(answerRow());
    expect(requestHashOf(String(row?.['request']))).toBe(HASH);
  });

  it('M5-1b TP-150 puts the note in the profile record only, and shows it in the request block', async () => {
    const repo = await nodeOf();
    valueOf(await decide(atTerminal(repo).deps, { note: 'cheaper to run' }));
    expect(repo.textOf(RECORD_PATH)).toContain('cheaper to run');
    expect(repo.deps.files.get(STORE_PATH)).not.toContain('cheaper');
    expect(shownOf(repo)).toContain('> Note:     cheaper to run');
  });

  it('M5-1b TP-181 writes the request block to stdout before the question: the title, the question, every option, the marks', async () => {
    const repo = await nodeOf();
    const seen: string[][] = [];
    const terminal = atTerminal(repo, () => {
      seen.push(shownOf(repo));
      return ok('y');
    });
    valueOf(await decide(terminal.deps, { words: ['D-1', 'b'] }));
    expect(seen[0]).toEqual([
      '> Decision D-1',
      '> Title:    Pick a plan',
      '> Question: Which plan do we build?',
      '> Options:',
      '>   a (recommended): Plan A',
      '>   b (chosen): Plan B',
    ]);
  });

  it('M5-1b TP-181 shows a question of 500 characters in full and wrapped', async () => {
    const question = Array.from({ length: 100 }, (_, index) => `w${String(index).padStart(3, '0')}`).join(' ').slice(0, boardTextLimits.maxQuestionChars);
    const repo = await nodeOf({ waiting: waitingOf({ ...ENTRY, question }) });
    valueOf(await decide(atTerminal(repo).deps));
    const lines = shownOf(repo);
    const start = lines.findIndex((line) => line.startsWith('> Question: '));
    const end = lines.indexOf('> Options:');
    const shownQuestion = lines.slice(start, end).map((line) => line.slice('> Question: '.length)).join('');
    expect(shownQuestion).toBe(question);
    expect(end - start).toBeGreaterThan(1);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(120);
  });

  it('M5-1b TP-194 gives the record, the row and the file name the date of the answer when the clock passes midnight during the question', async () => {
    const repo = await nodeOf();
    let now = new Date('2030-01-02T23:59:59.000Z');
    const terminal = atTerminal(
      repo,
      () => {
        now = new Date('2030-01-03T00:00:05.000Z');
        return ok('y');
      },
      { now: () => now },
    );
    valueOf(await decide(terminal.deps));
    expect(storedRecords(repo)[0]?.['at']).toBe('2030-01-03T00:00:05.000Z');
    expect(repo.textOf(join(stateRel.profileDecisions, '2030-01-03-d-1-pick-a-plan.md'))).toContain('time: 2030-01-03T00:00:05.000Z');
    expect(repo.textOf(fileNames.decisionLog)).toContain('"date": "2030-01-03"');
  });

  it.each([['y'], ['Y'], ['yes'], ['YES'], [' y ']])('M5-1b TP-150 takes the answer %j as yes', async (answer) => {
    const repo = await nodeOf();
    valueOf(await decide(atTerminal(repo, () => ok(answer)).deps));
    expect(storedRecords(repo)).toHaveLength(1);
  });
});

describe('decide: a no answer, the lock during the question, and a request that changes (TP-146, TP-147)', () => {
  it.each([['n'], ['N'], [''], ['maybe'], ['yy']])('M5-1b TP-146 exits 2 for the answer %j, with the request block shown and nothing written', async (answer) => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok(answer));
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.hint).toContain('factory decide D-1 a');
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
    expect(shownOf(repo)[0]).toBe('> Decision D-1');
  });

  it('M5-1b TP-146 returns the error of a question that cannot be answered, and writes nothing', async () => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => failure('the input has ended'));
    expect(exitOf(await decide(terminal.deps))).toBe(1);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-146 holds no lock during the question, so a parallel write of the board works', async () => {
    const repo = await nodeOf();
    const during: { lock: boolean; added: CliResult<CommandOutput> | undefined } = { lock: true, added: undefined };
    const terminal = atTerminal(repo, async () => {
      during.lock = repo.deps.files.has(LOCK_FILE);
      during.added = await runRequest(
        repo.deps,
        { home: HOME, words: ['add'], title: 'Second', question: 'Which?', options: ['a=Yes'], recommend: undefined },
        recipes,
      );
      return ok('y');
    });
    valueOf(await decide(terminal.deps));
    expect(during.lock).toBe(false);
    expect(valueOf(during.added ?? failure('no result'))).toBeDefined();
    expect(waitingIds(repo)).toEqual(['D-2']);
    expect(storedRecords(repo)).toHaveLength(1);
  });

  it('M5-1b TP-147 exits 1 for a request that changed during the question, and writes nothing to the store or the board', async () => {
    const repo = await nodeOf();
    const terminal = atTerminal(repo, () => {
      repo.deps.seed(WAITING_PATH, waitingOf(CHANGED_ENTRY));
      return ok('y');
    });
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('changed after the prompt');
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(fileNames.waiting)).toBe(waitingOf(CHANGED_ENTRY));
  });

  it('M5-1b TP-147 exits 1 for a request that was closed during the question, and writes nothing to the store', async () => {
    const repo = await nodeOf();
    const terminal = atTerminal(repo, () => {
      repo.deps.seed(WAITING_PATH, waitingOf());
      repo.deps.seed(join(LAYOUT.stateDir, fileNames.decisionLog), logOf(closedRow()));
      return ok('y');
    });
    expect(exitOf(await decide(terminal.deps))).toBe(1);
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
    expect(repo.commits).toEqual([]);
  });
});

describe('decide: a failure after the store write says what is saved (TP-177, TP-180, TP-190, TP-191)', () => {
  /** The deps in which the commit of the helper ends as `how` says. */
  const committing = (terminal: Terminal, repo: BoardRepo, how: 'fails' | 'lands' | 'lost-head'): Deps => {
    let attempted = false;
    return {
      ...terminal.deps,
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

  it('M5-1b TP-177 says that the answer is saved in the owner store, and the same command finishes the board copy with exit 0', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(committing(atTerminal(repo), repo, 'fails')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('saved in the owner store');
    expect(error.hint).toContain('factory decide');
    expect(storedRecords(repo)).toEqual([storedRecord()]);
    expect(waitingIds(repo)).toEqual(['D-1']);
    const again = valueOf(await decide(atTerminal(repo).deps));
    expect(again.json).toMatchObject({ outcome: 'existing' });
    expect(waitingIds(repo)).toEqual([]);
    expect(repo.commits).toHaveLength(1);
  });

  it('M5-1b TP-190 says that the answer is recorded and the commit is made, with no retry line, and the next decide says answered on the date', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(committing(atTerminal(repo), repo, 'lands')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('commit is made');
    expect(error.hint).not.toContain('again');
    const next = errorOf(await decide(atTerminal(repo).deps));
    expect(exitCodeOf[next.kind]).toBe(1);
    expect(next.message).toContain('answered by the owner on "2030-01-02"');
  });

  it('M5-1b TP-191 says that the answer is saved, prints the git check line and no retry line when the state of the commit is not known', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(committing(atTerminal(repo), repo, 'lost-head')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('git log -1 --stat');
    expect(error.hint).toContain('saved in the owner store');
    expect(error.hint).toContain('git log -1 --stat');
    expect(error.hint).not.toContain('again');
    expect(storedRecords(repo)).toEqual([storedRecord()]);
  });

  it('M5-1b TP-180 counts a saved store change with a left lock file as saved: the board copy is written, and a warning names the lock file', async () => {
    const repo = await nodeOf();
    const terminal = atTerminal(repo);
    const stuck: Deps = {
      ...terminal.deps,
      fs: { ...terminal.deps.fs, remove: async (path) => (path === STORE_LOCK ? failure('cannot remove: EBUSY') : repo.deps.fs.remove(path)) },
    };
    const output = valueOf(await decide(stuck));
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain(STORE_LOCK);
    expect(storedRecords(repo)).toEqual([storedRecord()]);
    expect(repo.commits).toHaveLength(1);
    expect(waitingIds(repo)).toEqual([]);
  });

  it('M5-1b TP-166 names the cap and says to run decide again when the new text of log.md is over the cap, and writes no store record', async () => {
    const repo = await nodeOf();
    repo.deps.seed(join(LAYOUT.stateDir, stateRel.profileLog), `# Decision log\n\n${'x'.repeat(maxFileBytes - 20)}`);
    const error = errorOf(await decide(atTerminal(repo).deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(String(maxFileBytes));
    expect(error.hint).toContain('then run "factory decide" again');
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-174 exits 1 and names the decision file when it is full, and changes no board file', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => storedRecord({ id: `D-${index + 2}` }));
    const repo = await nodeOf({ store: storeOf(...full) });
    const before = new Map(repo.deps.files);
    const error = errorOf(await decide(atTerminal(repo).deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files.get(STORE_PATH)).toBe(before.get(STORE_PATH));
    expect(repo.textOf(fileNames.waiting)).toBe(waitingOf(ENTRY));
  });
});

describe('decide: static checks of the source (TP-165, TP-188)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'commands', 'decide.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('M5-1b TP-165 never reads the stage key', () => {
    expect(code).not.toMatch(/\bstage\b/i);
    expect(code).not.toMatch(/\bboardKeys\b/);
  });

  it('M5-1b TP-188 names no flag but the json flag, which it refuses, so no flag skips the question', () => {
    const named = [...code.matchAll(/\bflags\.(\w+)/g)].map((match) => match[1]);
    expect(named.every((name) => name === 'json')).toBe(true);
  });

  it('M5-1b TP-188 asks the question with the prompt of the deps and the accept rule, in one place', () => {
    expect([...code.matchAll(/\bdeps\.prompt\(/g)]).toHaveLength(1);
    expect(code).toMatch(/\bACCEPT_ANSWER\b/);
  });

  it('M5-1b TP-188 calls the writer of the owner record only inside the closure that it gives to the connector', () => {
    expect([...code.matchAll(/\bputDecision\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/\brecordDecision\(/g)]).toHaveLength(1);
  });
});
