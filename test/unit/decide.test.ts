import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CommandOutput } from '../../src/cli/output.js';
import { addNewRemedy } from '../../src/board/decide.js';
import { freeRequestOf } from '../../src/board/free-request.js';
import * as boardOpen from '../../src/commands/board-open.js';
import { runDecide, type DecideOptions } from '../../src/commands/decide.js';
import { runRequest } from '../../src/commands/request.js';
import type { Deps } from '../../src/core/deps.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { ok } from '../../src/core/result.js';
import { runCli } from '../../src/cli/run.js';
import {
  boardTextLimits,
  dirs,
  env,
  files as fileNames,
  guardIds,
  maxEchoChars,
  maxFileBytes,
  privateFile,
  program,
  relayedMarker,
  schemaIds,
  stateLock,
} from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { installGuard } from '../../src/state/guard.js';
import { layoutOf, stateRel } from '../../src/state/layout.js';
import { boardNode, boardText } from '../helpers/board-node.js';
import { WAITING_PATH, type BoardRepo } from '../helpers/board-repo.js';
import { exited, registerRoot } from '../helpers/fake-deps.js';
import { HOME, HOOK } from '../helpers/guard-fixture.js';
import { FOLDER_ORIGINS, GUARD_STORE, guardStatesOf, guardStoreText, withGuardsOff, type GuardedSetup } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard, seedConfig } from '../helpers/sample-config.js';
import { plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';

// The decide command: the parse, the owner check, the request block, the question and the record.

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

describe('decide: the words and the flags are checked first, with exit 2', () => {
  it('refuses read in the answer function before the owner check', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { words: ['read', 'D-1'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe('The answer form does not take read. Run factory decide read <D-n>.');
  });

  it('says the same for decide read with no more words', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { words: ['read'] }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toBe('The answer form does not take read. Run factory decide read <D-n>.');
  });

  it.each([[[]], [['D-1']], [['D-1', 'a', 'b']]] as const)('exits 2 for %j: decide takes two words', async (words) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words }))).toBe(2);
  });

  it('exits 2 for the json flag and names the text output', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(repo.deps, { json: true }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('--json');
    expect(error.hint).toContain('factory decide');
  });

  it.each([['D-05'], ['D-0'], ['B-1'], ['d-1'], ['D-1000000000']])('exits 2 for the id %s, which is not canonical', async (id) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words: [id, 'a'] }))).toBe(2);
  });

  it.each([['-a'], ['a/b'], ['a b'], ['x'.repeat(41)]])('exits 2 for the option key %s, which is not in the token form', async (key) => {
    const repo = await nodeOf();
    expect(exitOf(await decide(repo.deps, { words: ['D-1', key] }))).toBe(2);
  });

  it('shows a typed option that has an escape sequence and a long text clean and cut', async () => {
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
  ])('exits 2 for a note with %s, before the owner check, the question and any file', async (_name, note) => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok('y'), { stdinIsTTY: false });
    expect(exitOf(await decide(terminal.deps, { note }))).toBe(2);
    expectNothingDone(repo, before, terminal);
  });
});

describe('decide: the owner check, the hosted kind and the guard come before the read and the question', () => {
  const CASES: readonly (readonly [string, Partial<Deps>])[] = [
    ['FACTORY_SESSION is set', { env: { PATH: '/bin', XDG_STATE_HOME: '/state', [env.session]: 'demo' } }],
    ['CLAUDECODE is set', { env: { PATH: '/bin', XDG_STATE_HOME: '/state', [env.claudeCode]: '1' } }],
    ['stdin is not a terminal', { stdinIsTTY: false }],
    ['stdout is not a terminal', { stdoutIsTTY: false }],
  ];

  it.each(CASES)('exits 4 when %s, names decide, and writes and asks nothing', async (_name, changes) => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok('y'), changes);
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('factory decide');
    expectNothingDone(repo, before, terminal);
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
  });

  it('exits 4 with the guard off, shows no request block, asks nothing and writes nothing', async () => {
    const repo = await nodeOf();
    repo.deps.files.set(HOOK, '#!/bin/sh\nexit 0\n');
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    expect(exitOf(await decide(terminal.deps))).toBe(4);
    expectNothingDone(repo, before, terminal);
  });

  it('exits 4 for a hosted tracker kind, with the message, no question, no commit and no store file', async () => {
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

describe('decide: the state of the number comes before the question', () => {
  const refused = async (setup: Setup, overrides: Partial<DecideOptions> = {}): Promise<{ error: CliError; repo: BoardRepo }> => {
    const repo = await nodeOf(setup);
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps, overrides));
    expectNothingDone(repo, before, terminal);
    return { error, repo };
  };

  it('exits 2 for a number that no file holds', async () => {
    const { error } = await refused({}, { words: ['D-9', 'a'] });
    expect(exitCodeOf[error.kind]).toBe(2);
  });

  it('exits 2 for an option that the request does not have, and lists the keys', async () => {
    const { error } = await refused({}, { words: ['D-1', 'z'] });
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(error.message).toContain('a, b');
  });

  it('exits 1 for a closed number', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow()) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-02');
  });

  it('exits 1 for a number that the coordinator closed with a decision, and names the decider', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ decider: 'coordinator' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('decided by the "coordinator"');
  });

  it('exits 1 for a number that the coordinator closed to relay an answer of the owner, names the relay, and keeps the remedy to add a new request', async () => {
    const { error } = await refused({
      waiting: waitingOf(),
      decisionLog: logOf(closedRow({ decider: 'coordinator', relayed: relayedMarker })),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(relayedMarker);
    expect(error.message).not.toContain('decided by');
    expect(error.hint).toContain(addNewRemedy);
  });

  it('does not print a decider of a closed row that is no value of the deciders', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ decider: 'EVIL-PEER' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).not.toContain('EVIL-PEER');
    expect(error.message).not.toContain('decided by');
  });

  it('shows the date of a closed row clean and cut', async () => {
    const date = `2030\u001b[31m${'9'.repeat(100)}`;
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(closedRow({ date })) });
    expect(error.message).not.toContain('\u001b');
    expect(error.message).not.toContain('9'.repeat(maxEchoChars + 1));
  });

  it('exits 1 for a row with by and a matching record, and names the date of the answer', async () => {
    const { error } = await refused({
      waiting: waitingOf(),
      decisionLog: logOf(answerRow({ date: '2030-02-03' })),
      store: storeOf(storedRecord({ at: '2030-01-05T10:00:00.000Z' })),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-05');
  });

  it('exits 1 for a row with by and no record: the row is not an owner answer, and a new request is the remedy', async () => {
    const { error } = await refused({ waiting: waitingOf(), decisionLog: logOf(answerRow()) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('not an owner answer');
    expect(error.hint).toContain('factory request add');
  });

  it('exits 1 for a row with by and a record of another request text', async () => {
    const { error } = await refused({
      waiting: waitingOf(),
      decisionLog: logOf(answerRow({ request: textOf(CHANGED_ENTRY) })),
      store: storeOf(storedRecord()),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('not an owner answer');
  });

  it('exits 1 for a number that only the decision file holds, and names the stored time', async () => {
    const { error } = await refused({ waiting: waitingOf(), store: storeOf(storedRecord({ at: '2030-01-05T10:00:00.000Z' })) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('2030-01-05T10:00:00.000Z');
  });

  it('exits 1 and names the decision file when it cannot be read', async () => {
    const { error } = await refused({ store: '{"schema":1,' });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
  });

  it('exits 1 before the question and writes nothing when the decision file is not valid', async () => {
    const { error } = await refused({ store: storeOf({ ...storedRecord(), extra: 'x' }) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(STORE_PATH);
  });

  it('exits 1, names waiting.json and writes nothing for an entry that fails the strict read', async () => {
    const { error } = await refused({ waiting: waitingOf({ ...ENTRY, extra: 'x' }) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(fileNames.waiting);
  });
});

describe('decide: the record of the store for an open request', () => {
  it('exits 1 for a record with another request hash, names the stored option and time, and gives the two remedies', async () => {
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

  it('exits 1 for a record with another option, names the stored option and time, and changes nothing', async () => {
    const repo = await nodeOf({ store: storeOf(storedRecord({ option: 'b', at: '2030-01-01T00:00:00.000Z' })) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps, { words: ['D-1', 'a'] }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('"b"');
    expect(error.message).toContain('2030-01-01T00:00:00.000Z');
    expectNothingDone(repo, before, terminal);
  });

  it('finishes the copies of an orphan record with exit 0, with the stored time and no new store text', async () => {
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

  it('exits 1 and commits no board copy when another run stored the same answer with another time during the question', async () => {
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

  it('finishes the board copy with the stored time when the same command runs again after that stop', async () => {
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

const freeInput = freeRequestOf({ id: 'alpha', project: 'demo', closed: ['B-1'], head: 'a'.repeat(40), checkedAt: AT });
const freeEntry = { id: 'D-1', ...freeInput };
const FREE_ANSWER = { words: ['D-1', 'done'] };

const seedBoardAt = async (repo: BoardRepo, home: string, entry: Record<string, unknown>): Promise<void> => {
  const config = sampleConfigWithBoard();
  const state = layoutOf(home).stateDir;
  seedConfig(repo.deps, home, config);
  registerRoot(repo.deps, home, config.core.node.id);
  repo.deps.seedDir(join(state, '.git'));
  repo.deps.seedDir(join(state, dirs.profile));
  valueOf(await installGuard(repo.deps, state, state));
  repo.deps.seed(join(state, fileNames.waiting), waitingOf(entry));
  repo.deps.seed(join(state, fileNames.decisionLog), logOf());
  repo.deps.seed(join(state, fileNames.board), boardText());
};

describe('decide: worker free requests', () => {
  it('shows the dry run and the free command before the prompt and records the owner answer', async () => {
    const repo = await nodeOf({ waiting: waitingOf(freeEntry) });
    const terminal = atTerminal(repo, () => {
      expect(shownOf(repo).slice(-2)).toEqual([
        `factory dismiss alpha --home ${HOME}`,
        `factory dismiss alpha --home ${HOME} --yes`,
      ]);
      return ok('y');
    });

    valueOf(await decide(terminal.deps, FREE_ANSWER));

    expect(terminal.asked).toEqual(['Record the answer done for D-1? [y/N] ']);
    expect(waitingIds(repo)).toEqual([]);
    expect(JSON.parse(repo.textOf(fileNames.decisionLog) ?? '')).toMatchObject({ rows: [{ by: 'owner', decision: 'done' }] });
  });

  it('shows the kept option without free commands or instructions before the prompt', async () => {
    const repo = await nodeOf({ waiting: waitingOf(freeEntry) });
    const terminal = atTerminal(repo, () => {
      const lines = shownOf(repo);
      expect(lines).toContain('>   kept (chosen): The worker stays.');
      expect(lines.filter((line) => /^factory dismiss|Run the dry run first\.|run the second command/.test(line))).toEqual([]);
      return ok('y');
    });

    valueOf(await decide(terminal.deps, { words: ['D-1', 'kept'] }));

    expect(terminal.asked).toEqual(['Record the answer kept for D-1? [y/N] ']);
    expect(JSON.parse(repo.textOf(fileNames.decisionLog) ?? '')).toMatchObject({
      rows: [{ by: 'owner', decision: 'kept', request: textOf(freeEntry) }],
    });
  });

  it('quotes the resolved board home in the free commands and both answers after a no to done', async () => {
    const repo = await nodeOf();
    const folder = "owner's home";
    const home = join(HOME, folder);
    const stored = 'factory dismiss beta --home /other --yes';
    const fields = (freeInput.fields ?? []).map((field) => field.label === 'Project' ? { ...field, text: stored } : field);
    await seedBoardAt(repo, home, { ...freeEntry, fields });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => ok('n'));

    const error = errorOf(await decide(terminal.deps, { ...FREE_ANSWER, home: folder }));

    expect(terminal.asked).toHaveLength(1);
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
    expect(error.hint).toContain(`If the worker is free, record that result with "factory decide D-1 done --home '${HOME}/owner'\\''s home'".`);
    expect(error.hint).toContain(`If the worker stays, record that result with "factory decide D-1 kept --home '${HOME}/owner'\\''s home'".`);
    expect(shownOf(repo).filter((line) => line.startsWith('factory dismiss'))).toEqual([
      `factory dismiss alpha --home '${HOME}/owner'\\''s home'`,
      `factory dismiss alpha --home '${HOME}/owner'\\''s home' --yes`,
    ]);
  });

  it('gives only the same answer after a no to kept', async () => {
    const repo = await nodeOf({ waiting: waitingOf(freeEntry) });
    const terminal = atTerminal(repo, () => ok('n'));

    const error = errorOf(await decide(terminal.deps, { words: ['D-1', 'kept'] }));

    expect(error.hint).toBe('Run "factory decide D-1 kept" again to record the answer.');
  });
});

describe.each(['done', 'kept'])('decide: checks on worker free requests for %s', (option) => {
  it.each([
    ['a worker id that is not a slug', { fields: [{ label: 'Worker to free', text: 'alpha beta' }] }],
    ['no worker field', { fields: [] }],
    ['two forms of the worker field', { fields: [{ label: 'Worker to free', text: 'alpha' }, { label: 'WORKER  TO FREE', text: 'beta' }] }],
    ['a doc', { docs: ['notes/context.md'] }],
    ['a different title', { title: 'Pick a plan' }],
    ['a different kind', { kind: 'decision' }],
    ['a changed question', { question: 'Stored question' }],
    ['no done option', { options: [{ key: 'kept', text: 'The worker stays.' }] }],
    ['an extra option', { options: [...freeInput.options, { key: 'later', text: 'Decide later.' }] }],
  ])('refuses a free request with %s before it shows the request or asks for an answer', async (_name, overrides) => {
    const repo = await nodeOf({ waiting: waitingOf({ ...freeEntry, ...overrides }) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);

    const result = await decide(terminal.deps, { words: ['D-1', option] });

    expect(result.ok).toBe(false);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).hint).toContain('factory request close D-1');
    expect(errorOf(result).hint).not.toContain('factory request add');
    expectNothingDone(repo, before, terminal);
  });

  it.each([
    ['a control character', '\x1b'],
    ['a hidden character', String.fromCodePoint(0x200b)],
  ])('refuses a factory folder path with %s before it shows the request or asks for an answer', async (_name, character) => {
    const repo = await nodeOf();
    const home = `${HOME}-${character}`;
    await seedBoardAt(repo, home, freeEntry);
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);

    const result = await decide(terminal.deps, { words: ['D-1', option], home });

    expect(result.ok).toBe(false);
    expect(exitOf(result)).toBe(1);
    expect(errorOf(result).message).toContain('the factory folder path');
    expectNothingDone(repo, before, terminal);
  });
});

it('opens a worker free request through the board port and reads it from the same board', async () => {
  const repo = await nodeOf();
  expect(boardOpen.boardRequests).toBeDefined();
  const id = valueOf(await boardOpen.boardRequests.ask(repo.deps, HOME, sampleConfigWithBoard(), freeInput));
  const waiting = valueOf(await boardOpen.boardRequests.waiting(repo.deps, HOME));

  expect(waiting.items.find((item) => item.id === id)?.record).toMatchObject(freeInput);
  expect(repo.commits).toHaveLength(1);
  expect(storedRecords(repo)).toEqual([]);
});

describe('decide: a yes answer records the answer', () => {
  it('asks once, writes the store record outside the factory folder with no note, and shows what was recorded', async () => {
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

  it('makes one commit with the two board files, the profile record and log.md, and a row with by and the request text', async () => {
    const repo = await nodeOf({ waiting: waitingOf(ENTRY, { ...ENTRY, id: 'D-2' }) });
    valueOf(await decide(atTerminal(repo).deps));
    expect(repo.commits).toHaveLength(1);
    expect([...(repo.commits[0]?.staged ?? [])].sort()).toEqual([fileNames.waiting, fileNames.decisionLog, RECORD_PATH, stateRel.profileLog].sort());
    expect(waitingIds(repo)).toEqual(['D-2']);
    const row = (JSON.parse(repo.textOf(fileNames.decisionLog) ?? '') as { rows: Record<string, unknown>[] }).rows[0];
    expect(row).toEqual(answerRow());
    expect(requestHashOf(String(row?.['request']))).toBe(HASH);
  });

  it('records the answer for a request that request add wrote in the group later, and shows its open time and group in the request block', async () => {
    const repo = await nodeOf({ waiting: waitingOf() });
    const add = { home: HOME, words: ['add'], title: 'Pick a plan', question: 'Which plan do we build?', options: ['a=Plan A', 'b=Plan B'], recommend: 'a', decider: undefined, decision: undefined, relayed: false, later: true, kind: undefined, fields: [], whys: [], docs: [] };
    valueOf(await runRequest(repo.deps, add, recipes));
    const opened = repo.deps.now().toISOString();
    valueOf(await decide(atTerminal(repo).deps));
    expect(shownOf(repo)).toContain(`> Opened:   ${opened}`);
    expect(shownOf(repo)).toContain('> Group:    later');
    expect(storedRecords(repo)).toHaveLength(1);
    expect(waitingIds(repo)).toEqual([]);
  });

  it('shows all request context before the prompt and stores its canonical text with the owner answer', async () => {
    const entry = {
      ...ENTRY, kind: 'information', fields: [{ label: 'Scope', text: 'Queue' }], docs: ['docs/queue.md'],
      options: [{ key: 'a', text: 'Plan A', rec: true, why: 'Less work.' }, { key: 'b', text: 'Plan B' }],
    };
    const repo = await nodeOf({ waiting: waitingOf(entry) });
    const seen: string[][] = [];
    valueOf(await decide(atTerminal(repo, () => { seen.push(shownOf(repo)); return ok('y'); }).deps));
    expect(seen[0]).toContain('> Kind:     information');
    expect(seen[0]).toContain('> Field:    "Scope": Queue');
    expect(seen[0]).toContain('> Doc:      docs/queue.md');
    expect(seen[0]).toContain('>     Why (a): Less work.');
    const row = (JSON.parse(repo.textOf(fileNames.decisionLog) ?? '') as { rows: Record<string, unknown>[] }).rows[0];
    expect(row?.['request']).toBe(textOf(entry));
    expect(storedRecords(repo)).toEqual([storedRecord({ hash: requestHashOf(textOf(entry)) })]);
  });

  it('copies kind, fields and each asker why to the profile without doc paths or a false owner reason', async () => {
    const entry = {
      ...ENTRY, kind: 'command', fields: [{ label: 'Scope', text: 'Queue' }], docs: ['docs/queue.md'],
      options: [{ key: 'a', text: 'Plan A', why: 'Less work.' }],
    };
    const repo = await nodeOf({ waiting: waitingOf(entry) });
    valueOf(await decide(atTerminal(repo).deps));
    const text = repo.textOf(RECORD_PATH) ?? '';
    expect(text).toContain('Kind: "command"');
    expect(text).toContain('Field: "Scope": "Queue"');
    expect(text).toContain('- a: "Plan A" (chosen)\n  Why (asker): "Less work."');
    expect(text).toContain('## Reason\n\nThe owner gave no reason.');
    expect(text).not.toContain('docs/queue.md');
  });

  it('refuses repeated request docs before the prompt and leaves the store and board unchanged', async () => {
    const repo = await nodeOf({ waiting: waitingOf({ ...ENTRY, docs: ['docs/a.md', 'docs/a.md'] }) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const error = errorOf(await decide(terminal.deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('docs');
    expect(error.hint).toContain('Restore the entry');
    expectNothingDone(repo, before, terminal);
  });

  it('refuses a doc path change during the prompt before the store or board copy', async () => {
    const entry = { ...ENTRY, docs: ['docs/a.md'] };
    const repo = await nodeOf({ waiting: waitingOf(entry) });
    const terminal = atTerminal(repo, () => {
      repo.deps.seed(WAITING_PATH, waitingOf({ ...entry, docs: ['docs/b.md'] }));
      return ok('y');
    });
    const error = errorOf(await decide(terminal.deps));
    expect(terminal.asked).toHaveLength(1);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('changed after the prompt');
    expect(storedRecords(repo)).toEqual([]);
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(RECORD_PATH)).toBeUndefined();
  });

  it('puts the note in the profile record only, and shows it in the request block', async () => {
    const repo = await nodeOf();
    valueOf(await decide(atTerminal(repo).deps, { note: 'cheaper to run' }));
    expect(repo.textOf(RECORD_PATH)).toContain('cheaper to run');
    expect(repo.deps.files.get(STORE_PATH)).not.toContain('cheaper');
    expect(shownOf(repo)).toContain('> Note:     cheaper to run');
  });

  it('writes the request block to stdout before the question: the title, the question, every option, the marks', async () => {
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

  it('shows a question of 500 characters in full and wrapped', async () => {
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

  it('gives the record, the row and the file name the date of the answer when the clock passes midnight during the question', async () => {
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

  it.each([['y'], ['Y'], ['yes'], ['YES'], [' y ']])('takes the answer %j as yes', async (answer) => {
    const repo = await nodeOf();
    valueOf(await decide(atTerminal(repo, () => ok(answer)).deps));
    expect(storedRecords(repo)).toHaveLength(1);
  });
});

describe('decide: a no answer, the lock during the question, and a request that changes', () => {
  it.each([['n'], ['N'], [''], ['maybe'], ['yy']])('exits 2 for the answer %j, with the request block shown and nothing written', async (answer) => {
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

  it('returns the error of a question that cannot be answered, and writes nothing', async () => {
    const repo = await nodeOf();
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo, () => failure('the input has ended'));
    expect(exitOf(await decide(terminal.deps))).toBe(1);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it('holds no lock during the question, so a parallel write of the board works', async () => {
    const repo = await nodeOf();
    const during: { lock: boolean; added: CliResult<CommandOutput> | undefined } = { lock: true, added: undefined };
    const terminal = atTerminal(repo, async () => {
      during.lock = repo.deps.files.has(LOCK_FILE);
      during.added = await runRequest(
        repo.deps,
        { home: HOME, words: ['add'], title: 'Second', question: 'Which?', options: ['a=Yes'], recommend: undefined, decider: undefined, decision: undefined, relayed: false, later: false, kind: undefined, fields: [], whys: [], docs: [] },
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

  it('exits 1 for a request that changed during the question, and writes nothing to the store or the board', async () => {
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

  it('exits 1 for a request that was closed during the question, and writes nothing to the store', async () => {
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

describe('decide: a failure after the store write says what is saved', () => {
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

  it('says that the answer is saved in the owner store, and the same command finishes the board copy with exit 0', async () => {
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

  it('says that the answer is recorded and the commit is made, with no retry line, and the next decide says answered on the date', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(committing(atTerminal(repo), repo, 'lands')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('commit is made');
    expect(error.hint).not.toContain('again');
    const next = errorOf(await decide(atTerminal(repo).deps));
    expect(exitCodeOf[next.kind]).toBe(1);
    expect(next.message).toContain('answered by the owner on "2030-01-02"');
  });

  it('says that the answer is saved, prints the git check line and no retry line when the state of the commit is not known', async () => {
    const repo = await nodeOf();
    const error = errorOf(await decide(committing(atTerminal(repo), repo, 'lost-head')));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('git log -1 --stat');
    expect(error.hint).toContain('saved in the owner store');
    expect(error.hint).toContain('git log -1 --stat');
    expect(error.hint).not.toContain('again');
    expect(storedRecords(repo)).toEqual([storedRecord()]);
  });

  it('counts a saved store change with a left lock file as saved: the board copy is written, and a warning names the lock file', async () => {
    const repo = await nodeOf();
    const terminal = atTerminal(repo);
    const stuck: Deps = {
      ...terminal.deps,
      fs: { ...terminal.deps.fs, removeFile: async (path) => (path === STORE_LOCK ? failure('cannot remove: EBUSY') : repo.deps.fs.removeFile(path)) },
    };
    const output = valueOf(await decide(stuck));
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain(STORE_LOCK);
    expect(storedRecords(repo)).toEqual([storedRecord()]);
    expect(repo.commits).toHaveLength(1);
    expect(waitingIds(repo)).toEqual([]);
  });

  it('names the cap and says to run decide again when the new text of log.md is over the cap, and writes no store record', async () => {
    const repo = await nodeOf();
    repo.deps.seed(join(LAYOUT.stateDir, stateRel.profileLog), `# Decision log\n\n${'x'.repeat(maxFileBytes - 20)}`);
    const error = errorOf(await decide(atTerminal(repo).deps));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(String(maxFileBytes));
    expect(error.hint).toContain('then run "factory decide" again');
    expect(repo.deps.files.has(STORE_PATH)).toBe(false);
    expect(repo.commits).toEqual([]);
  });

  it('exits 1 and names the decision file when it is full, and changes no board file', async () => {
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

describe.each(FOLDER_ORIGINS)('decide with the guard owner-go in %s', (_folder, origin) => {
  /** The board node on a node whose local file holds each guard of the setup off, with the owner record unless it has none. */
  const guardedNodeOf = async (guards: GuardedSetup, setup: Setup = {}): Promise<BoardRepo> => {
    const off = guards.off ?? [];
    const config = withGuardsOff(sampleConfigWithBoard(), off);
    const repo = await boardNode({
      config,
      board: boardText(),
      waiting: setup.waiting ?? waitingOf(ENTRY),
      ...(setup.decisionLog === undefined ? {} : { decisionLog: setup.decisionLog }),
    });
    repo.deps.seedDir(PROFILE_DIR);
    if (setup.store !== undefined) repo.deps.seed(STORE_PATH, setup.store);
    registerRoot(repo.deps, HOME, config.core.node.id, [], origin);
    if (guards.record !== false) repo.deps.seed(GUARD_STORE, guardStoreText(config.core.node.id, HOME, off, repo.deps.now()));
    return repo;
  };

  /** One run of `decide D-1 a` as the owner types it in a terminal window. */
  const decideLine = async (deps: Deps): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
    const sink = captureSink();
    const code = await runCli(['decide', 'D-1', 'a', '--home', HOME], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  const OFF: GuardedSetup = { off: [guardIds.ownerGo] };

  it.each(guardStatesOf(guardIds.ownerGo))('leaves a changed request open and records no answer: %s', async (_state, setup) => {
    const repo = await guardedNodeOf(setup);
    const terminal = atTerminal(repo, () => {
      repo.deps.seed(WAITING_PATH, waitingOf(CHANGED_ENTRY));
      return ok('y');
    });
    const result = await decideLine(terminal.deps);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain('changed after the prompt');
    expect(storedRecords(repo)).toHaveLength(0);
    expect(repo.commits).toHaveLength(0);
    expect(repo.deps.files.get(WAITING_PATH)).toBe(waitingOf(CHANGED_ENTRY));
  });

  it('still refuses an answer with exit 1 while the owner store holds an answer for another text of the request, and asks nothing', async () => {
    const repo = await guardedNodeOf(OFF, { store: storeOf(storedRecord({ hash: requestHashOf(textOf(CHANGED_ENTRY)) })) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const result = await decideLine(terminal.deps);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain('for another text of the request');
    expectNothingDone(repo, before, terminal);
  });

  it('still refuses a second answer with exit 1 for a request that the owner answered, and asks nothing', async () => {
    const repo = await guardedNodeOf(OFF, { waiting: waitingOf(), decisionLog: logOf(answerRow()), store: storeOf(storedRecord()) });
    const before = new Map(repo.deps.files);
    const terminal = atTerminal(repo);
    const result = await decideLine(terminal.deps);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain('was answered by the owner');
    expectNothingDone(repo, before, terminal);
  });
});

describe('decide: static checks of the source', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'commands', 'decide.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('never reads the stage key', () => {
    expect(code).not.toMatch(/\bstage\b/i);
    expect(code).not.toMatch(/\bboardKeys\b/);
  });

  it('names no flag but the json flag, which it refuses, so no flag skips the question', () => {
    const named = [...code.matchAll(/\bflags\.(\w+)/g)].map((match) => match[1]);
    expect(named.every((name) => name === 'json')).toBe(true);
  });

  it('asks the question with the prompt of the deps and the accept rule, in one place', () => {
    expect([...code.matchAll(/\bdeps\.prompt\(/g)]).toHaveLength(1);
    expect(code).toMatch(/\bACCEPT_ANSWER\b/);
  });

  it('calls the writer of the owner record only inside the closure that it gives to the connector', () => {
    expect([...code.matchAll(/\bputDecision\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/\brecordDecision\(/g)]).toHaveLength(1);
  });
});
