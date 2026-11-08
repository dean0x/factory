import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../../src/cli/errors.js';
import { runState } from '../../src/commands/state.js';
import { commandLines, commandText, maxFileBytes, schemaIds, stateGuard } from '../../src/names.js';
import { createFakeDeps, exited, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { STATE_GIT, STATE_GIT_WORDS, withoutStateWords } from '../helpers/git-fake.js';

const STATE = '/h/node/.factory';

const idOfText = (text: string): string => createHash('sha256').update(text).digest('hex');

const board = (ids: readonly string[], extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ queue: [], items: ids.map((id) => ({ id, ...extra })) }, null, 2)}\n`;

interface Setup {
  /** False: the repo has no commit yet. Default: true. */
  readonly commit?: boolean;
  /** The text of board.json at the last commit. Null: the last commit has no board.json. Default: null. */
  readonly head?: string | null;
  /** The text of board.json in the index. Null: the index has no board.json. Default: null. */
  readonly index?: string | null;
  readonly headMode?: string;
  readonly headKind?: string;
  /** The size that the tree listing shows for the file at the last commit. Default: the byte size of the text. */
  readonly headSize?: number;
  readonly indexMode?: string;
  /**
   * The text of board.json at the older commits that changed it, newest first. The commit that made the board at the last commit
   * comes before them. Null: that commit holds no board.json.
   */
  readonly history?: readonly (string | null)[];
  /** The exit code of a call that fails, by the first words of the git command. */
  readonly fails?: Readonly<Record<string, number>>;
}

/** The id of the commit with this place in the history of board.json: 0 is the commit that made the board at the last commit. */
const commitIdOf = (place: number): string => place.toString(16).padStart(40, '0');

const LOG_COMMAND = /^log --first-parent --no-show-signature --format=%H -n (\d+) HEAD -- board\.json$/;
const OLDER_TREE = /^ls-tree -z -l ([0-9a-f]{40}) -- board\.json$/;

const gitFor = (setup: Setup) => {
  const blobs = new Map<string, string>();
  const keep = (text: string): string => {
    const id = idOfText(text);
    blobs.set(id, text);
    return id;
  };
  const headText = setup.head ?? null;
  const indexText = setup.index ?? null;
  const headId = headText === null ? null : keep(headText);
  const indexId = indexText === null ? null : keep(indexText);
  const older = setup.history ?? [];
  const olderIds = older.map((text) => (text === null ? null : keep(text)));
  return (call: RunCall) => {
    const command = withoutStateWords(call.args).slice(2).join(' ');
    const failed = Object.entries(setup.fails ?? {}).find(([prefix]) => command.startsWith(prefix));
    if (failed !== undefined) return exited(failed[1], '', 'fatal: failed');
    if (command === 'ls-files --stage -z -- board.json') {
      return exited(0, indexId === null ? '' : `${setup.indexMode ?? '100644'} ${indexId} 0\tboard.json\0`);
    }
    if (command === 'rev-parse -q --verify HEAD') return setup.commit === false ? exited(1) : exited(0, 'c0ffee\n');
    const asked = LOG_COMMAND.exec(command);
    if (asked !== null) {
      const places = [0, ...older.map((_, index) => index + 1)];
      return exited(0, places.slice(0, Number(asked[1])).map((place) => `${commitIdOf(place)}\n`).join(''));
    }
    const olderTree = OLDER_TREE.exec(command);
    if (olderTree !== null) {
      const id = olderIds[Number.parseInt(olderTree[1] ?? '', 16) - 1];
      const text = older[Number.parseInt(olderTree[1] ?? '', 16) - 1];
      if (id === null || id === undefined || text === null || text === undefined) return exited(0, '');
      return exited(0, `100644 blob ${id} ${String(Buffer.byteLength(text, 'utf8')).padStart(7, ' ')}\tboard.json\0`);
    }
    if (command === 'ls-tree -z -l HEAD -- board.json') {
      if (headId === null || headText === null) return exited(0, '');
      const size = String(setup.headSize ?? Buffer.byteLength(headText, 'utf8')).padStart(7, ' ');
      return exited(0, `${setup.headMode ?? '100644'} ${setup.headKind ?? 'blob'} ${headId} ${size}\tboard.json\0`);
    }
    if (command.startsWith('cat-file blob ')) {
      const text = blobs.get(command.slice('cat-file blob '.length));
      return text === undefined ? exited(128, '', 'fatal: not a blob') : exited(0, text);
    }
    return exited(0);
  };
};

const guardWith = async (setup: Setup, words: readonly string[] = ['guard']) => {
  const deps = createFakeDeps({ cwd: STATE, run: gitFor(setup) });
  const result = await runState(deps, { words });
  return { deps, result };
};

const commandsOf = (deps: FakeDeps): string[] =>
  deps.calls.filter((call) => call.command === 'git').map((call) => withoutStateWords(call.args).slice(2).join(' '));

describe('the state guard command: changes that pass', () => {
  it('prints nothing and exits 0 when an item is added', async () => {
    const { result } = await guardWith({ head: board(['B-1']), index: board(['B-1', 'B-2']) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lines).toEqual([]);
      expect(result.value.warnings).toEqual([]);
      expect(result.value.failed).toBe(false);
      expect(result.value.json).toEqual({ schema: schemaIds.stateGuard, passed: true });
    }
  });

  it('passes when an item changes and keeps its id', async () => {
    const { result } = await guardWith({ head: board(['B-1']), index: board(['B-1'], { status: 'closed' }) });
    expect(result.ok).toBe(true);
  });

  it('passes with a board at the last commit that cannot be read, when the board in the index is the same file', async () => {
    const same = 'not json at all\n';
    const { result, deps } = await guardWith({ head: same, index: same });
    expect(result.ok).toBe(true);
    expect(commandsOf(deps).some((command) => command.startsWith('cat-file'))).toBe(false);
  });

  it('passes when the repo has no board and the index has none', async () => {
    const { result } = await guardWith({ head: null, index: null });
    expect(result.ok).toBe(true);
  });

  it('passes when the repo has no commit yet and the index holds a board', async () => {
    const { result } = await guardWith({ commit: false, head: null, index: board(['B-1']) });
    expect(result.ok).toBe(true);
  });

  it('passes when the last commit has no board and the index adds one', async () => {
    const { result } = await guardWith({ head: null, index: board(['B-1']) });
    expect(result.ok).toBe(true);
  });
});

describe('the state guard command: changes that stop', () => {
  const stopOf = async (setup: Setup) => {
    const { result } = await guardWith(setup);
    if (result.ok) throw new Error('the command passed');
    return result.error;
  };

  it('stops with exit 1 and names the id that the commit removes', async () => {
    const error = await stopOf({ head: board(['B-1', 'B-2']), index: board(['B-1']) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-2');
    expect(error.message).not.toContain('B-1');
    expect(error.message).not.toContain('\n');
  });

  it('shows an id with a control character as an escape', async () => {
    const error = await stopOf({ head: board(['B-1', 'B-\u001b[31m9']), index: board(['B-1']) });
    expect(error.message).not.toContain('\u001b');
    expect(error.message).toContain('B-\\x1b[31m9');
  });

  it('names at most five ids and counts the rest', async () => {
    const ids = ['B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6', 'B-7'];
    const error = await stopOf({ head: board(ids), index: board([]) });
    expect(error.message).toContain('B-1, B-2, B-3, B-4, B-5 and 2 more');
    expect(error.message).not.toContain('B-6');
  });

  it('stops when an id stays only in the text of another item', async () => {
    const head = board(['B-1', 'B-2']);
    const index = `${JSON.stringify({ queue: [], items: [{ id: 'B-1', title: '{"id": "B-2"}' }] })}\n`;
    const error = await stopOf({ head, index });
    expect(error.message).toContain('B-2');
  });

  it('stops when the commit removes board.json', async () => {
    const error = await stopOf({ head: board(['B-1']), index: null });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of this commit: the file is removed');
    expect(error.hint).toContain('put it back');
  });

  it('stops with a remedy when the new board is not JSON', async () => {
    const error = await stopOf({ head: board(['B-1']), index: '{"items": [' });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of this commit: the text is not valid JSON');
    expect(error.hint).toContain('commit again');
  });

  it('stops when the file at the last commit is a link and the board of an older commit has an id that the commit removes', async () => {
    const error = await stopOf({
      head: board(['B-1']),
      headMode: '120000',
      history: [board(['B-1', 'B-2'])],
      index: board(['B-1'], { note: 'changed' }),
    });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-2');
  });

  it('stops when the file in the index is not a plain file', async () => {
    const error = await stopOf({ head: board(['B-1']), index: board(['B-1', 'B-2']), indexMode: '160000' });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of this commit: it is not a plain file');
  });

  it('does not read the file at the last commit when it is larger than the limit, and compares with the board of an older commit', async () => {
    const head = board(['B-1']);
    const index = board(['B-1'], { note: 'changed' });
    const { result, deps } = await guardWith({ head, headSize: maxFileBytes + 1, history: [board(['B-1', 'B-2'])], index });
    expect(result.ok ? '' : result.error.message).toContain('B-2');
    expect(commandsOf(deps)).not.toContain(`cat-file blob ${idOfText(head)}`);
  });

  it('stops when the new board is larger than the limit', async () => {
    const big = board(['B-1'], { note: 'x'.repeat(maxFileBytes) });
    const error = await stopOf({ head: board(['B-1']), index: big });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`cannot read board.json of this commit: it is larger than ${maxFileBytes} bytes`);
  });

  it.each([
    ['the read of the index', 'ls-files'],
    ['the read of the last commit', 'ls-tree'],
    ['the read of a file', 'cat-file'],
  ])('stops with exit 1 and a remedy when %s fails', async (_name, prefix) => {
    const error = await stopOf({ head: board(['B-1']), index: board(['B-1', 'B-2']), fails: { [prefix]: 128 } });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toMatch(/^cannot read/);
    expect(error.hint).toBe(
      `Run "git status" in .factory, then commit again. Git runs "${commandText(commandLines.stateGuard)}" before each commit.`,
    );
  });

  it('stops with exit 1 and a remedy when git cannot tell the last commit, and does not take it for a repo with no commit', async () => {
    const error = await stopOf({ head: board(['B-1', 'B-2']), index: board(['B-1']), fails: { 'rev-parse': 128 } });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`cannot read the last commit of ${STATE}: git exited with 128`);
    expect(error.hint).toBe(
      `Run "git status" in .factory, then commit again. Git runs "${commandText(commandLines.stateGuard)}" before each commit.`,
    );
  });

  it('stops with exit 1 when git cannot run', async () => {
    const deps = createFakeDeps({ cwd: STATE });
    const result = await runState(deps, { words: ['guard'] });
    expect(result.ok ? '' : result.error.message).toMatch(/^cannot read board\.json in the index of .*: cannot run git/);
    expect(result.ok ? 0 : exitCodeOf[result.error.kind]).toBe(1);
  });
});

describe('the state guard command: a board at the last commit that cannot be read', () => {
  const BAD = 'not json at all\n';
  const GOOD = board(['B-1', 'B-2']);

  const stopOf = async (setup: Setup) => {
    const { result } = await guardWith(setup);
    if (result.ok) throw new Error('the command passed');
    return result.error;
  };

  it('passes a repair that keeps every item id of the last board that can be read', async () => {
    const { result } = await guardWith({ head: BAD, history: [GOOD], index: board(['B-1', 'B-2', 'B-3']) });
    expect(result.ok).toBe(true);
  });

  it('stops, and names the id, for a repair that drops an item id of the last board that can be read', async () => {
    const error = await stopOf({ head: BAD, history: [GOOD], index: board(['B-1']) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('B-2');
    expect(error.message).not.toContain('B-1');
  });

  it('walks back over every board that can not be read to the last one that can', async () => {
    const error = await stopOf({ head: BAD, history: [BAD, '{"items": 3}\n', GOOD, board(['B-9'])], index: board(['B-1']) });
    expect(error.message).toContain('B-2');
    expect(error.message).not.toContain('B-9');
  });

  it.each([
    ['one older commit of the file, and its board can not be read', [BAD]],
    ['no older commit of the file', []],
    ['an older commit that holds no board.json', [null, GOOD]],
  ])('passes a board that can be read when there is nothing to compare with: %s', async (_name, history) => {
    const { result } = await guardWith({ head: BAD, history, index: board(['B-7']) });
    expect(result.ok).toBe(true);
  });

  it('stops when the repair itself can not be read, with the remedy for the new board', async () => {
    const error = await stopOf({ head: BAD, history: [GOOD], index: '{"items": [' });
    expect(error.message).toBe('cannot read board.json of this commit: the text is not valid JSON');
    expect(error.hint).toContain('commit again');
  });

  it('stops when the repair removes board.json', async () => {
    const error = await stopOf({ head: BAD, history: [GOOD], index: null });
    expect(error.message).toBe('cannot read board.json of this commit: the file is removed');
  });

  it('compares with the board in the bound step, the last one that it reads', async () => {
    const history = [...Array.from({ length: stateGuard.historyBound - 1 }, () => BAD), GOOD];
    const error = await stopOf({ head: BAD, history, index: board(['B-1']) });
    expect(error.message).toContain('B-2');
  });

  it('stops at the bound with a remedy that names a normal action, and reads at most the bound', async () => {
    const history = Array.from({ length: stateGuard.historyBound + 20 }, () => BAD);
    const { result, deps } = await guardWith({ head: BAD, history, index: board(['B-1']) });
    const error = result.ok ? null : result.error;
    expect(error === null ? 0 : exitCodeOf[error.kind]).toBe(1);
    expect(error?.message).toContain(`${stateGuard.historyBound}`);
    expect(error?.hint).toContain('git -C .factory restore --source=<commit> --staged --worktree -- board.json');
    expect(error?.hint).not.toContain('--no-verify');
    expect(commandsOf(deps).filter((command) => command.startsWith('ls-tree')).length).toBeLessThanOrEqual(stateGuard.historyBound + 1);
  });

  it('reads the history of the file only when the board at the last commit can not be read', async () => {
    const { deps } = await guardWith({ head: GOOD, history: [GOOD], index: board(['B-1', 'B-2', 'B-3']) });
    expect(commandsOf(deps).some((command) => command.startsWith('log'))).toBe(false);
  });

  it('stops with exit 1 and a remedy when the read of the history fails', async () => {
    const error = await stopOf({ head: BAD, history: [GOOD], index: board(['B-1', 'B-2']), fails: { log: 128 } });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('git status');
  });

  it('reads the history through the state git words, so that the hooks stay off', async () => {
    const { deps } = await guardWith({ head: BAD, history: [GOOD], index: board(['B-1', 'B-2']) });
    const reads = deps.calls.filter((call) => call.args.some((word) => word === 'log' || word === 'ls-tree' || word === 'cat-file'));
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) expect(call.args.slice(0, 6)).toEqual(['-C', STATE, ...STATE_GIT.split(' ')]);
  });
});

describe('the state guard command: reads only', () => {
  it('runs only read commands, each with the hooks off, in the current folder', async () => {
    const { deps } = await guardWith({ head: board(['B-1']), index: board(['B-1', 'B-2']) });
    const git = deps.calls.filter((call) => call.command === 'git');
    expect(git.length).toBeGreaterThan(0);
    for (const call of git) expect(call.args.slice(0, 2 + STATE_GIT_WORDS.length)).toEqual(['-C', STATE, ...STATE_GIT_WORDS]);
    expect(commandsOf(deps).every((command) => /^(ls-files|rev-parse|ls-tree|cat-file|log)\b/.test(command))).toBe(true);
    expect(deps.files.size).toBe(0);
  });

  it('reads the index through the state git words, so that the hooks stay off', async () => {
    const { deps } = await guardWith({ head: board(['B-1']), index: board(['B-1', 'B-2']) });
    const indexRead = deps.calls.find((call) => call.args.includes('ls-files'));
    expect(indexRead?.args.join(' ')).toContain(STATE_GIT);
  });
});

describe('the words of the state command', () => {
  it.each([
    ['no subcommand', []],
    ['an unknown subcommand', ['frobnicate']],
    ['a word after guard', ['guard', 'extra']],
  ])('stops with a usage error (exit 2) for %s, and runs no git command', async (_name, words) => {
    const { result, deps } = await guardWith({}, words);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(exitCodeOf[result.error.kind]).toBe(2);
      expect(result.error.hint).toBeDefined();
    }
    expect(deps.calls).toEqual([]);
  });
});
