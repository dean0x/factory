import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../../src/cli/errors.js';
import { runState } from '../../src/commands/state.js';
import { maxFileBytes, schemaIds } from '../../src/names.js';
import { createFakeDeps, exited, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { STATE_GIT, withoutStateWords } from '../helpers/git-fake.js';

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
  /** The exit code of a call that fails, by the first words of the git command. */
  readonly fails?: Readonly<Record<string, number>>;
}

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
  return (call: RunCall) => {
    const command = withoutStateWords(call.args).slice(2).join(' ');
    const failed = Object.entries(setup.fails ?? {}).find(([prefix]) => command.startsWith(prefix));
    if (failed !== undefined) return exited(failed[1], '', 'fatal: failed');
    if (command === 'ls-files --stage -z -- board.json') {
      return exited(0, indexId === null ? '' : `${setup.indexMode ?? '100644'} ${indexId} 0\tboard.json\0`);
    }
    if (command === 'rev-parse --verify HEAD') return setup.commit === false ? exited(128) : exited(0, 'c0ffee\n');
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

  it('stops with a remedy for a board at the last commit that cannot be read, and the board in the index differs', async () => {
    const error = await stopOf({ head: 'not json\n', index: board(['B-1']) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toContain('git commit --no-verify');
  });

  it('stops when the file at the last commit is a link', async () => {
    const error = await stopOf({ head: board(['B-1']), headMode: '120000', index: board(['B-1', 'B-2']) });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of the last commit: it is not a plain file');
  });

  it('stops when the file in the index is not a plain file', async () => {
    const error = await stopOf({ head: board(['B-1']), index: board(['B-1', 'B-2']), indexMode: '160000' });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('cannot read board.json of this commit: it is not a plain file');
  });

  it('stops without a read when the file at the last commit is larger than the limit', async () => {
    const { result, deps } = await guardWith({ head: board(['B-1']), headSize: maxFileBytes + 1, index: board(['B-1', 'B-2']) });
    expect(result.ok ? '' : result.error.message).toContain(`it is larger than ${maxFileBytes} bytes`);
    expect(commandsOf(deps).some((command) => command.startsWith('cat-file'))).toBe(false);
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
    expect(error.hint).toBe('Run "git status" in .factory, then commit again.');
  });

  it('stops with exit 1 when git cannot run', async () => {
    const deps = createFakeDeps({ cwd: STATE });
    const result = await runState(deps, { words: ['guard'] });
    expect(result.ok ? '' : result.error.message).toMatch(/^cannot read board\.json in the index of .*: cannot run git/);
    expect(result.ok ? 0 : exitCodeOf[result.error.kind]).toBe(1);
  });
});

describe('the state guard command: reads only', () => {
  it('runs only read commands, each with the hooks off, in the current folder', async () => {
    const { deps } = await guardWith({ head: board(['B-1']), index: board(['B-1', 'B-2']) });
    const git = deps.calls.filter((call) => call.command === 'git');
    expect(git.length).toBeGreaterThan(0);
    for (const call of git) expect(call.args.slice(0, 2)).toEqual(['-C', STATE]);
    expect(commandsOf(deps).every((command) => /^(ls-files|rev-parse|ls-tree|cat-file)\b/.test(command))).toBe(true);
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
