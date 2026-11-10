import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { Deps, RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { commands, files as fileNames, maxFileBytes, stateLock } from '../../src/names.js';
import {
  commitBoardChange,
  readBoardFiles,
  type BoardChange,
  type BoardCommitError,
  type BoardTexts,
} from '../../src/state/board-commit.js';
import { installGuard } from '../../src/state/guard.js';
import { layoutOf } from '../../src/state/layout.js';
import { exited, withFailingWrites, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { withoutStateWords, type GitFixture } from '../helpers/git-fake.js';
import { HAND_KINDS, HOME, installed, make, OFF_CASES, STATE } from '../helpers/guard-fixture.js';

const LAYOUT = layoutOf(HOME);
const BOARD = `${STATE}/board.json`;
const WAITING = `${STATE}/waiting.json`;
const LOCK_FILE = `${LAYOUT.locksDir}/${stateLock.name}${stateLock.lock.suffix}`;
const MESSAGE = 'chore: change the board';
const WAITS = Array.from({ length: stateLock.lock.attempts - 1 }, () => stateLock.lock.waitMs);

const board = (ids: readonly string[], extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ queue: [], items: ids.map((id) => ({ id, ...extra })) }, null, 2)}\n`;

const idOfText = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The state repo of a test: the last commit, its board, and how the commit call ends. */
interface Repo {
  /** The id of the last commit. Null: the repo has no commit. */
  head: string | null;
  /** The text of board.json at the last commit. Null: the last commit holds no board. */
  board: string | null;
  /** The exit code of the commit call. A commit with a code other than 0 stages nothing more. */
  commitExit: number;
  /** True: a commit call that exits with a code still makes the commit, as git does when the time limit stops it. */
  landsAnyway: boolean;
  /** True: git can not run for the read of the last commit after the commit call. */
  headFailsAfterCommit: boolean;
  headMode: string;
}

const NEW_HEAD = 'beef01';

interface Setup {
  readonly deps: FakeDeps;
  readonly repo: Repo;
  /** The git commands of the state repo since the setup, without the words of a state step. */
  readonly seen: string[];
}

/** A state repo with the delete guard on, and a fake git that knows the board at the last commit. */
const setup = async (changes: Partial<Repo> = {}, fixture: GitFixture = {}): Promise<Setup> => {
  const repo: Repo = {
    head: 'c0ffee',
    board: board(['B-1', 'B-2']),
    commitExit: 0,
    landsAnyway: false,
    headFailsAfterCommit: false,
    headMode: '100644',
    ...changes,
  };
  const seen: string[] = [];
  const blobs = new Map<string, string>();
  const keep = (text: string): string => {
    const id = idOfText(text);
    blobs.set(id, text);
    return id;
  };
  let committed = false;
  let attempted = false;
  const answer = (call: RunCall): CliResult<RunOutput> | undefined => {
    const command = withoutStateWords(call.args).slice(2).join(' ');
    seen.push(command);
    if (command === 'rev-parse -q --verify HEAD') {
      if (attempted && repo.headFailsAfterCommit) return failure('cannot run git: ENOENT');
      const head = committed ? NEW_HEAD : repo.head;
      return head === null ? exited(1) : exited(0, `${head}\n`);
    }
    if (command === 'ls-tree -z -l HEAD -- board.json') {
      if (repo.board === null) return exited(0, '');
      const size = String(Buffer.byteLength(repo.board, 'utf8')).padStart(7, ' ');
      return exited(0, `${repo.headMode} blob ${keep(repo.board)} ${size}\tboard.json\0`);
    }
    if (command.startsWith('cat-file blob ')) {
      const text = blobs.get(command.slice('cat-file blob '.length));
      return text === undefined ? exited(128, '', 'fatal: not a blob') : exited(0, text);
    }
    if (command.includes(' commit ')) {
      attempted = true;
      if (repo.commitExit === 0 || repo.landsAnyway) committed = true;
      return repo.commitExit === 0 ? exited(0) : exited(repo.commitExit, '', 'fatal: failed');
    }
    return undefined;
  };
  const made = make({ answer, fixture });
  const guarded = await installGuard(made.deps, STATE, STATE);
  expect(guarded.ok).toBe(true);
  if (repo.board !== null) made.deps.seed(BOARD, repo.board);
  seen.length = 0;
  return { deps: made.deps, repo, seen };
};

/** The git commands that change the index or make a commit. */
const writesOf = (seen: readonly string[]): string[] => seen.filter((command) => /^(add|rm|reset)\b/.test(command) || command.includes(' commit '));

/** A change that returns the given texts and records the texts that it got. */
const changing = (
  result: CliResult<BoardTexts>,
): { readonly change: BoardChange['change']; readonly got: BoardTexts[] } => {
  const got: BoardTexts[] = [];
  return {
    got,
    change: async (texts) => {
      got.push(texts);
      return result;
    },
  };
};

const texts = (entries: Readonly<Record<string, string | null>>): BoardTexts => new Map(Object.entries(entries));

const request = (overrides: Partial<BoardChange> & Pick<BoardChange, 'change'>): BoardChange => ({
  touched: ['board.json'],
  command: commands.start,
  message: MESSAGE,
  ...overrides,
});

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

const stateFiles = (deps: FakeDeps): Map<string, string> =>
  new Map([...deps.files].filter(([path]) => path.startsWith(`${STATE}/`) && !path.startsWith(`${STATE}/.git/`)));

describe('the board commit helper: a change that passes (TP-12)', () => {
  it('writes the new text and makes exactly one commit of the files that changed', async () => {
    const { deps, seen } = await setup();
    deps.seed(WAITING, '{"rows":[]}\n');
    const next = board(['B-1', 'B-2', 'B-3']);
    const { change } = changing(ok(texts({ 'board.json': next })));
    const result = await commitBoardChange(deps, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change }));
    expect(result).toEqual({ ok: true, value: { committed: true } });
    expect(deps.files.get(BOARD)).toBe(next);
    expect(deps.files.get(WAITING)).toBe('{"rows":[]}\n');
    const writes = writesOf(seen);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe('add -A -- board.json');
    expect(writes[1]).toBe(`-c commit.gpgsign=false commit -q -m ${MESSAGE}`);
  });

  it('gives the change the text of each touched file as it is now, and null for a file that is not there', async () => {
    const { deps } = await setup();
    const { change, got } = changing(ok(texts({})));
    await commitBoardChange(deps, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change }));
    expect(got).toEqual([texts({ 'board.json': board(['B-1', 'B-2']), 'waiting.json': null })]);
  });

  it('passes a change that closes an item, because the item keeps its id', async () => {
    const { deps } = await setup();
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2'], { status: 'closed' }) })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
  });

  it('adds the first board to a repo that has no commit', async () => {
    const { deps, seen } = await setup({ head: null, board: null });
    const next = board(['B-1']);
    const { change } = changing(ok(texts({ 'board.json': next })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
    expect(deps.files.get(BOARD)).toBe(next);
    expect(writesOf(seen)).toHaveLength(2);
  });

  it('adds a board to a last commit that has none', async () => {
    const { deps } = await setup({ board: null });
    const { change } = changing(ok(texts({ 'board.json': board(['B-1']) })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
  });

  it('makes no commit and no write when the change leaves every file as it was', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2']) })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: false } });
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
  });

  it('removes a file that the change gives as null, with the removal in the commit', async () => {
    const { deps, seen } = await setup();
    deps.seed(WAITING, '{"rows":[]}\n');
    const { change } = changing(ok(texts({ 'waiting.json': null })));
    const result = await commitBoardChange(deps, LAYOUT, request({ touched: ['waiting.json'], change }));
    expect(result).toEqual({ ok: true, value: { committed: true } });
    expect(deps.files.has(WAITING)).toBe(false);
    expect(writesOf(seen)[0]).toBe('rm -r -q --cached --ignore-unmatch -- waiting.json');
    expect(writesOf(seen).some((command) => command.startsWith('add'))).toBe(false);
  });

  it('lets the lock go after the commit', async () => {
    const { deps } = await setup();
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']) })));
    await commitBoardChange(deps, LAYOUT, request({ change }));
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });
});

describe('the board commit helper: a change that loses an item id (TP-12)', () => {
  it('refuses with exit 4 and a remedy that names the command, names the id, and writes nothing', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toBe('this change removes the item id B-2 from board.json');
    expect(error.hint).toBe('Mark the item closed, never remove it, then run "factory start" again.');
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('names every lost id', async () => {
    const { deps } = await setup();
    const { change } = changing(ok(texts({ 'board.json': board([]) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toBe('this change removes the item ids B-1, B-2 from board.json');
  });

  it('shows an id with a control character as an escape', async () => {
    const odd = 'B-\u001b[31m9';
    const { deps } = await setup({ board: board(['B-1', odd]) });
    const { change } = changing(ok(texts({ 'board.json': board(['B-1']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).not.toContain('\u001b');
    expect(error.message).toContain('B-');
  });

  it('refuses a change that removes board.json, and writes nothing', async () => {
    const { deps, seen } = await setup();
    const { change } = changing(ok(texts({ 'board.json': null })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toContain('the file is removed');
    expect(deps.files.get(BOARD)).toBe(board(['B-1', 'B-2']));
    expect(writesOf(seen)).toEqual([]);
  });

  it('refuses a new board text that is not a board, with exit 1 and a remedy that names the command, and writes nothing', async () => {
    const { deps, seen } = await setup();
    const { change } = changing(ok(texts({ 'board.json': '{"items": [' })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot commit board.json: the text is not valid JSON');
    expect(error.hint).toBe('Fix the change, then run "factory start" again.');
    expect(deps.files.get(BOARD)).toBe(board(['B-1', 'B-2']));
    expect(writesOf(seen)).toEqual([]);
  });

  it('refuses a board at the last commit that cannot be read, with exit 1 and a remedy, and writes nothing', async () => {
    const { deps, seen } = await setup({ board: 'not json\n' });
    const { change } = changing(ok(texts({ 'board.json': board(['B-1']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of the last commit: the text is not valid JSON');
    expect(error.hint).toContain('git -C .factory restore --source=<commit> --staged --worktree -- board.json');
    expect(error.hint).not.toContain('--no-verify');
    expect(error.hint).toContain('"factory start"');
    expect(deps.files.get(BOARD)).toBe('not json\n');
    expect(writesOf(seen)).toEqual([]);
  });

  it('refuses a board at the last commit that is not a plain file, and writes nothing', async () => {
    const { deps, seen } = await setup({ headMode: '120000' });
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toBe('cannot read board.json of the last commit: it is not a plain file');
    expect(writesOf(seen)).toEqual([]);
  });

  it('does not check the ids of a change that leaves board.json alone', async () => {
    const { deps } = await setup({ board: 'not json\n' });
    deps.seed(WAITING, '{"rows":[]}\n');
    const { change } = changing(ok(texts({ 'waiting.json': '{"rows":[1]}\n' })));
    const result = await commitBoardChange(deps, LAYOUT, request({ touched: ['waiting.json'], change }));
    expect(result).toEqual({ ok: true, value: { committed: true } });
  });
});

describe('the board commit helper: a change that stops before any write', () => {
  it('passes the failure of the change on, and writes nothing', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(failure('the request changed'));
    expect(errorOf(await commitBoardChange(deps, LAYOUT, request({ change }))).message).toBe('the request changed');
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('refuses a change that names a file outside the touched list, and writes nothing', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(ok(texts({ 'other.json': '{}\n' })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toContain('"other.json"');
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
  });

  it.each([
    ['no file', []],
    ['an empty path', ['']],
    ['a path above the state folder', ['../x']],
    ['a path inside the git folder', ['.git/config']],
    ['a path inside the git folder in capital letters, for a disk that ignores case', ['.GIT/config']],
    ['a path inside the git folder in mixed case', ['.Git/x']],
    ['a path with a git folder as a later part', ['a/.GIT/config']],
    ['an absolute path', ['/etc/passwd']],
    ['a path with an empty part', ['a//b']],
    ['a path with a dot part', ['./board.json']],
    ['a path that goes up and down', ['a/../board.json']],
  ])('refuses %s, runs no change and no git command', async (_name, touched) => {
    const { deps, seen } = await setup();
    const { change, got } = changing(ok(texts({})));
    const result = await commitBoardChange(deps, LAYOUT, request({ touched, change }));
    expect(result.ok).toBe(false);
    expect(got).toEqual([]);
    expect(seen).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('stops when the owner has a change in a touched file, before the change runs', async () => {
    const { deps, seen } = await setup({}, { status: { [STATE]: ' M board.json\0' } });
    const { change, got } = changing(ok(texts({})));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toContain('board.json');
    expect(got).toEqual([]);
    expect(writesOf(seen)).toEqual([]);
  });

  it('stops with exit 4 and a remedy when a touched file is a link, before the change runs', async () => {
    const { deps } = await setup();
    const linked = { ...deps, fs: { ...deps.fs, lstat: async (path: string) => (path === BOARD ? ok('link' as const) : deps.fs.lstat(path)) } };
    const { change, got } = changing(ok(texts({})));
    const error = errorOf(await commitBoardChange(linked, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('board.json is a link');
    expect(error.hint).toContain('Replace the link');
    expect(got).toEqual([]);
  });
});

describe('the board commit helper: a guard that is off (TP-11)', () => {
  it.each(OFF_CASES)('refuses with exit 4 and the remedy for %s, and writes nothing', async (_name, kind, mutate) => {
    const made = await installed();
    made.deps.seed(BOARD, board(['B-1']));
    const before = stateFiles(made.deps);
    const changed = await mutate(made);
    const { change, got } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2']) })));
    const error = errorOf(await commitBoardChange(changed, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('the delete guard');
    // The install repairs most cases. The cases that it refuses name a step by hand, and not the command that stops at them.
    if (HAND_KINDS.has(kind)) expect(error.hint).not.toContain('factory upgrade');
    else expect(error.hint).toBe('Run "factory upgrade".');
    expect(got).toEqual([]);
    expect(stateFiles(made.deps)).toEqual(before);
    expect(made.gitCommands().filter((command) => /^(add|rm|reset)\b/.test(command) || command.includes(' commit '))).toEqual([]);
    expect(made.deps.files.has(LOCK_FILE)).toBe(false);
  });
});

describe('the board commit helper: a write or a commit that fails (TP-13)', () => {
  it('puts the files back, clears the staged files and removes a file that was new, when the commit fails', async () => {
    const { deps, seen } = await setup({ commitExit: 1 });
    const oldBoard = board(['B-1', 'B-2']);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']), 'waiting.json': '{"rows":[]}\n' })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change })));
    expect(error.message).toContain('cannot commit the state files');
    expect(deps.files.get(BOARD)).toBe(oldBoard);
    expect(deps.files.has(WAITING)).toBe(false);
    expect(writesOf(seen)).toContain('reset -q -- board.json waiting.json');
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('puts the file back as it was when the commit fails for a file that the change removed', async () => {
    const { deps } = await setup({ commitExit: 1 });
    deps.seed(WAITING, '{"rows":[1]}\n');
    const { change } = changing(ok(texts({ 'waiting.json': null })));
    await commitBoardChange(deps, LAYOUT, request({ touched: ['waiting.json'], change }));
    expect(deps.files.get(WAITING)).toBe('{"rows":[1]}\n');
  });

  it('keeps a commit that landed although git reported an error, says so, and does not put the files back', async () => {
    const { deps, seen } = await setup({ commitExit: 1, landsAnyway: true });
    const next = board(['B-1', 'B-2', 'B-3']);
    const { change } = changing(ok(texts({ 'board.json': next })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toContain('The commit was made in .factory, so the files stay changed.');
    expect(error.message).toContain('git log -1 --stat');
    expect(deps.files.get(BOARD)).toBe(next);
    expect(writesOf(seen).some((command) => command.startsWith('reset'))).toBe(false);
  });

  it('keeps the files, and says why, when it cannot read the last commit after a failed commit', async () => {
    const { deps, seen } = await setup({ commitExit: 1, headFailsAfterCommit: true });
    const next = board(['B-1', 'B-2', 'B-3']);
    const { change } = changing(ok(texts({ 'board.json': next })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(error.message).toContain('so the files are not put back');
    expect(deps.files.get(BOARD)).toBe(next);
    expect(writesOf(seen).some((command) => command.startsWith('reset'))).toBe(false);
  });

  it('puts back the files that it wrote when a later write fails, and makes no commit', async () => {
    const { deps, seen } = await setup();
    const oldBoard = board(['B-1', 'B-2']);
    const failing = withFailingWrites(deps, (path) => path === WAITING);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']), 'waiting.json': '{"rows":[]}\n' })));
    const error = errorOf(await commitBoardChange(failing, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change })));
    expect(error.message).toContain('disk full');
    expect(deps.files.get(BOARD)).toBe(oldBoard);
    expect(deps.files.has(WAITING)).toBe(false);
    expect(writesOf(seen)).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });
});

/** The error of a call that must fail, with the typed field of the helper. */
const failureOf = async (deps: Deps, change: BoardChange): Promise<BoardCommitError> => {
  const result = await commitBoardChange(deps, LAYOUT, change);
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

describe('the board commit helper: the beforeWrite step (TP-176)', () => {
  const NEXT = board(['B-1', 'B-2', 'B-3']);
  const adding = (): ReturnType<typeof changing> => changing(ok(texts({ 'board.json': NEXT })));

  /** A step that records what it sees and ends with the given result. */
  const stepping = (deps: FakeDeps, seen: readonly string[], result: CliResult<void> = ok(undefined)) => {
    const calls: { updates: BoardTexts; boardText: string | undefined; gitWrites: string[]; locked: boolean }[] = [];
    const beforeWrite: NonNullable<BoardChange['beforeWrite']> = async (updates) => {
      calls.push({ updates, boardText: deps.files.get(BOARD), gitWrites: writesOf(seen), locked: deps.files.has(LOCK_FILE) });
      return result;
    };
    return { calls, beforeWrite };
  };

  it('M5-1b TP-176 runs once, under the lock, with the files that change, before the first file write', async () => {
    const { deps, seen } = await setup();
    const { change } = adding();
    const { calls, beforeWrite } = stepping(deps, seen);
    const result = await commitBoardChange(deps, LAYOUT, request({ change, beforeWrite }));
    expect(result).toEqual({ ok: true, value: { committed: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.updates).toEqual(texts({ 'board.json': NEXT }));
    expect(calls[0]?.boardText).toBe(board(['B-1', 'B-2']));
    expect(calls[0]?.gitWrites).toEqual([]);
    expect(calls[0]?.locked).toBe(true);
    expect(deps.files.get(BOARD)).toBe(NEXT);
  });

  it('M5-1b TP-176 gives the step only the files that really change', async () => {
    const { deps, seen } = await setup();
    deps.seed(WAITING, '{"rows":[]}\n');
    const { calls, beforeWrite } = stepping(deps, seen);
    const same = changing(ok(texts({ 'board.json': NEXT, 'waiting.json': '{"rows":[]}\n' })));
    await commitBoardChange(deps, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change: same.change, beforeWrite }));
    expect([...(calls[0]?.updates.keys() ?? [])]).toEqual(['board.json']);
  });

  it('M5-1b TP-176 does not run when the change leaves every file as it was', async () => {
    const { deps, seen } = await setup();
    const { calls, beforeWrite } = stepping(deps, seen);
    const { change } = changing(ok(texts({})));
    expect(await commitBoardChange(deps, LAYOUT, request({ change, beforeWrite }))).toEqual({ ok: true, value: { committed: false } });
    expect(calls).toEqual([]);
  });

  it('M5-1b TP-176 does not run when the change fails', async () => {
    const { deps, seen } = await setup();
    const { calls, beforeWrite } = stepping(deps, seen);
    const { change } = changing(failure('the request changed'));
    expect((await failureOf(deps, request({ change, beforeWrite }))).message).toBe('the request changed');
    expect(calls).toEqual([]);
  });

  it('M5-1b TP-176 does not run when a new text is over the cap', async () => {
    const { deps, seen } = await setup();
    const { calls, beforeWrite } = stepping(deps, seen);
    const { change } = changing(ok(texts({ 'waiting.json': OVER })));
    const error = await failureOf(deps, request({ touched: ['waiting.json'], change, beforeWrite }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(calls).toEqual([]);
  });

  it('M5-1b TP-176 does not run when the change loses an item id', async () => {
    const { deps, seen } = await setup();
    const { calls, beforeWrite } = stepping(deps, seen);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1']) })));
    const error = await failureOf(deps, request({ change, beforeWrite }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(calls).toEqual([]);
  });

  it('M5-1b TP-176 stops on a failed step with its error, writes nothing, and lets the lock go', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { calls, beforeWrite } = stepping(deps, seen, failure('the owner store is full', 'Free the store.'));
    const { change } = adding();
    const error = await failureOf(deps, request({ change, beforeWrite }));
    expect(error.message).toBe('the owner store is full');
    expect(error.hint).toBe('Free the store.');
    expect(calls).toHaveLength(1);
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
    expect(error.commitOutcome).toBeUndefined();
  });

  it('M5-1b TP-176 leaves a change with no step as it was', async () => {
    const { deps } = await setup();
    const { change } = adding();
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
  });
});

describe('the board commit helper: the typed outcome after the first file write (TP-177, TP-190, TP-191)', () => {
  const NEXT = board(['B-1', 'B-2', 'B-3']);
  const adding = (): ReturnType<typeof changing> => changing(ok(texts({ 'board.json': NEXT })));

  it('M5-1b TP-177 says restored when the commit fails and every file is put back', async () => {
    const { deps } = await setup({ commitExit: 1 });
    const { change } = adding();
    const error = await failureOf(deps, request({ change }));
    expect(error.commitOutcome).toBe('restored');
    expect(deps.files.get(BOARD)).toBe(board(['B-1', 'B-2']));
  });

  it('M5-1b TP-177 says restored when a later write fails and every written file is put back', async () => {
    const { deps } = await setup();
    const failing = withFailingWrites(deps, (path) => path === WAITING);
    const { change } = changing(ok(texts({ 'board.json': NEXT, 'waiting.json': '{"rows":[]}\n' })));
    const error = await failureOf(failing, request({ touched: ['board.json', 'waiting.json'], change }));
    expect(error.message).toContain('disk full');
    expect(error.commitOutcome).toBe('restored');
  });

  it('M5-1b TP-177 says restored when the first write itself fails', async () => {
    const { deps } = await setup();
    const failing = withFailingWrites(deps, (path) => path === BOARD);
    const { change } = adding();
    expect((await failureOf(failing, request({ change }))).commitOutcome).toBe('restored');
  });

  it('M5-1b TP-177 says unknown when a file cannot be put back, and the message keeps the reason', async () => {
    const { deps } = await setup({ commitExit: 1 });
    // The first write of the board is the new text, the second is the put back.
    const failing = withFailingWrites(deps, (path, attempt) => path === BOARD && attempt === 2);
    const { change } = adding();
    const error = await failureOf(failing, request({ change }));
    expect(error.commitOutcome).toBe('unknown');
    expect(error.message).toContain('disk full');
  });

  it('M5-1b TP-190 says committed when the commit landed in spite of a git error', async () => {
    const { deps } = await setup({ commitExit: 1, landsAnyway: true });
    const { change } = adding();
    const error = await failureOf(deps, request({ change }));
    expect(error.commitOutcome).toBe('committed');
    expect(deps.files.get(BOARD)).toBe(NEXT);
  });

  it('M5-1b TP-191 says unknown when the head cannot be read after a git error, and puts nothing back', async () => {
    const { deps } = await setup({ commitExit: 1, headFailsAfterCommit: true });
    const { change } = adding();
    const error = await failureOf(deps, request({ change }));
    expect(error.commitOutcome).toBe('unknown');
    expect(deps.files.get(BOARD)).toBe(NEXT);
  });

  it('M5-1b TP-177 gives no outcome to a failure that comes before the first file write', async () => {
    const { deps } = await setup();
    const sized = changing(ok(texts({ 'waiting.json': OVER })));
    expect((await failureOf(deps, request({ touched: ['waiting.json'], change: sized.change }))).commitOutcome).toBeUndefined();
    const lost = changing(ok(texts({ 'board.json': board(['B-1']) })));
    expect((await failureOf(deps, request({ change: lost.change }))).commitOutcome).toBeUndefined();
    const failed = changing(failure('the request changed'));
    expect((await failureOf(deps, request({ change: failed.change }))).commitOutcome).toBeUndefined();
  });

  it('M5-1b TP-177 does not change the message of the failures that exist', async () => {
    const { deps } = await setup({ commitExit: 1 });
    const { change } = adding();
    expect((await failureOf(deps, request({ change }))).message).toBe('cannot commit the state files: git exited with 1');
  });
});

describe('the board commit helper: the state lock (TP-18)', () => {
  it('waits for the lock of another writer, then stops with exit 1 and the lock path, and writes nothing', async () => {
    const { deps, seen } = await setup();
    deps.seed(LOCK_FILE, '1\n');
    const before = stateFiles(deps);
    const slept = deps.sleeps.length;
    const { change, got } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(LOCK_FILE);
    expect(deps.sleeps.slice(slept)).toEqual(WAITS);
    expect(got).toEqual([]);
    expect(stateFiles(deps)).toEqual(before);
    expect(seen).toEqual([]);
  });

  it('takes the lock once: it holds it while the change runs and while the commit runs, and takes it for nothing else', async () => {
    const { deps } = await setup();
    const held: string[] = [];
    const watching: FakeDeps = {
      ...deps,
      run: async (command, args, options) => {
        if (args.includes('commit')) held.push(`commit:${deps.files.has(LOCK_FILE)}`);
        return deps.run(command, args, options);
      },
    };
    const slept = deps.sleeps.length;
    const result = await commitBoardChange(
      watching,
      LAYOUT,
      request({
        change: async () => {
          held.push(`change:${deps.files.has(LOCK_FILE)}`);
          return ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']) }));
        },
      }),
    );
    expect(result).toEqual({ ok: true, value: { committed: true } });
    expect(held).toEqual(['change:true', 'commit:true']);
    expect(deps.sleeps.length).toBe(slept);
  });
});

/** A board text with a pad key, so that a test can set the size of the text. An item has a status when `status` is given. */
const boardWithPad = (ids: readonly string[], pad: string, status?: string): string =>
  `${JSON.stringify({ queue: [], items: ids.map((id) => (status === undefined ? { id } : { id, status })), pad }, null, 2)}\n`;

/** A board text of exactly `bytes` bytes. The pad is plain ASCII. */
const boardOfSize = (bytes: number, ids: readonly string[] = ['B-1', 'B-2']): string =>
  boardWithPad(ids, 'x'.repeat(bytes - Buffer.byteLength(boardWithPad(ids, ''), 'utf8')));

const OVER = 'x'.repeat(maxFileBytes + 1);

describe('the board commit helper: the size of the new text (TP-85)', () => {
  it.each([
    ['the board', fileNames.board],
    ['the waiting file', fileNames.waiting],
    ['the decision log', fileNames.decisionLog],
  ])('M5-1b TP-85 refuses %s over the cap with exit 1, names the file and the cap, and changes no file and no commit', async (_name, file) => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(ok(texts({ [file]: OVER })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ touched: [file], change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(file);
    expect(error.message).toContain(String(maxFileBytes));
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
    expect(deps.files.has(LOCK_FILE)).toBe(false);
  });

  it('M5-1b TP-85 writes no file at all when one of two changed files is over the cap', async () => {
    const { deps, seen } = await setup();
    const before = stateFiles(deps);
    const { change } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']), 'waiting.json': OVER })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ touched: ['board.json', 'waiting.json'], change })));
    expect(error.message).toContain('waiting.json');
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
  });

  it('M5-1b TP-85 stops on the size before the lost-id check, so a board over the cap that drops an id exits 1', async () => {
    const { deps } = await setup();
    const { change } = changing(ok(texts({ 'board.json': boardOfSize(maxFileBytes + 1, ['B-1']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(String(maxFileBytes));
  });

  it('M5-1b TP-85 counts bytes and not characters', async () => {
    const { deps } = await setup();
    const wide = 'é'.repeat(maxFileBytes / 2 + 1);
    expect(wide.length).toBeLessThan(maxFileBytes);
    const { change } = changing(ok(texts({ 'waiting.json': wide })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ touched: ['waiting.json'], change })));
    expect(error.message).toContain(String(maxFileBytes));
  });
});

describe('the board commit helper: the size check reads the new text (TP-86)', () => {
  it('M5-1b TP-86 accepts a board of exactly the cap', async () => {
    const { deps } = await setup();
    const next = boardOfSize(maxFileBytes);
    const { change } = changing(ok(texts({ 'board.json': next })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
    expect(deps.files.get(BOARD)).toBe(next);
  });

  it('M5-1b TP-86 closes an item on a board just under the cap, because the new text is still within the cap', async () => {
    const before = boardOfSize(maxFileBytes - 100);
    const { deps } = await setup({ board: before });
    const pad = 'x'.repeat(maxFileBytes - 100 - Buffer.byteLength(boardWithPad(['B-1', 'B-2'], ''), 'utf8'));
    const closed = boardWithPad(['B-1', 'B-2'], pad, 'closed');
    expect(Buffer.byteLength(closed, 'utf8')).toBeGreaterThan(Buffer.byteLength(before, 'utf8'));
    expect(Buffer.byteLength(closed, 'utf8')).toBeLessThanOrEqual(maxFileBytes);
    const { change } = changing(ok(texts({ 'board.json': closed })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: true } });
    expect(deps.files.get(BOARD)).toBe(closed);
  });

  it('M5-1b TP-86 leaves a board of exactly the cap alone when the change keeps it, with no commit', async () => {
    const full = boardOfSize(maxFileBytes);
    const { deps, seen } = await setup({ board: full });
    const { change } = changing(ok(texts({ 'board.json': full })));
    expect(await commitBoardChange(deps, LAYOUT, request({ change }))).toEqual({ ok: true, value: { committed: false } });
    expect(writesOf(seen)).toEqual([]);
  });
});

describe('the board commit helper: a file that is not UTF-8 (TP-51)', () => {
  it('M5-1b TP-51 stops with exit 1 and names the file, before the change runs, and writes nothing', async () => {
    const { deps, seen } = await setup();
    deps.invalidUtf8.add(BOARD);
    const before = stateFiles(deps);
    const { change, got } = changing(ok(texts({ 'board.json': board(['B-1', 'B-2', 'B-3']) })));
    const error = errorOf(await commitBoardChange(deps, LAYOUT, request({ change })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(BOARD);
    expect(got).toEqual([]);
    expect(stateFiles(deps)).toEqual(before);
    expect(writesOf(seen)).toEqual([]);
  });
});

describe('the board commit helper: the read with no lock (TP-93)', () => {
  it('M5-1b TP-93 gives the text of each file, and null for a file that is not there', async () => {
    const { deps } = await setup();
    const read = await readBoardFiles(deps, LAYOUT, ['board.json', 'waiting.json']);
    expect(read).toEqual({ ok: true, value: texts({ 'board.json': board(['B-1', 'B-2']), 'waiting.json': null }) });
  });

  it('M5-1b TP-93 reads while another process holds the state lock, does not wait, and leaves the lock file as it is', async () => {
    const { deps } = await setup();
    deps.seed(LOCK_FILE, '1\n');
    const slept = deps.sleeps.length;
    const read = await readBoardFiles(deps, LAYOUT, ['board.json']);
    expect(read).toEqual({ ok: true, value: texts({ 'board.json': board(['B-1', 'B-2']) }) });
    expect(deps.sleeps.length).toBe(slept);
    expect(deps.files.get(LOCK_FILE)).toBe('1\n');
  });

  it('M5-1b TP-51 fails with exit 1 and names the file when the text is not UTF-8', async () => {
    const { deps } = await setup();
    deps.invalidUtf8.add(BOARD);
    const error = errorOf(await readBoardFiles(deps, LAYOUT, ['board.json']));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(BOARD);
  });

  it('M5-1b TP-51 fails with exit 4 and a remedy, and names the file, when the file is a link', async () => {
    const { deps } = await setup();
    const linked = { ...deps, fs: { ...deps.fs, lstat: async (path: string) => (path === BOARD ? ok('link' as const) : deps.fs.lstat(path)) } };
    const error = errorOf(await readBoardFiles(linked, LAYOUT, ['board.json']));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('board.json is a link');
    expect(error.hint).toContain('Replace the link');
  });

  it('M5-1b TP-93 reads no file for a path that is not a plain path below the state folder', async () => {
    const { deps, seen } = await setup();
    const result = await readBoardFiles(deps, LAYOUT, ['../x']);
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
