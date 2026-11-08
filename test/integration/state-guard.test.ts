import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { stateGuard } from '../../src/names.js';
import { guardHookText, guardStateOf, installGuard, installGuardWithUndo } from '../../src/state/guard.js';
import { DIST, makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

/**
 * The delete guard with real git, in a scratch folder with its own HOME and git identity. The hook is the one that `installGuard`
 * writes, and git runs it with the built program (`dist/factory.js`).
 */

let box: Sandbox;
let stateDir: string;
let deps: Deps;

/** The time that the start of a test may take: the sandbox, the state repo, the install and the first commit. */
const SETUP_TIMEOUT_MS = 30_000;

/** The names of the environment that make git read the scratch HOME and nothing else. The in-process calls of the install need them. */
const GIT_ENV_NAMES = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'] as const;

const board = (ids: readonly string[], extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ queue: [], items: ids.map((id) => ({ id, ...extra })) }, null, 2)}\n`;

const BOARD = 'board.json';
const OTHER = 'notes.txt';
/** The hook file for `git commit`, and the names of all hook files in the order of a listing. */
const PRE_COMMIT = stateGuard.hookFiles[0];
const SORTED_HOOKS = [...stateGuard.hookFiles].sort();

const git = (args: readonly string[]): Promise<RunResult> => box.git(stateDir, args);

const mustGit = async (args: readonly string[]): Promise<RunResult> => {
  const result = await git(args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
  return result;
};

const writeInState = (name: string, text: string): Promise<void> => writeFile(join(stateDir, name), text);

const headId = async (): Promise<string> => (await mustGit(['rev-parse', 'HEAD'])).stdout.trim();

const commit = (...args: readonly string[]): Promise<RunResult> => git(['commit', '-q', '-m', 'test', ...args]);

const countOfCommits = async (): Promise<number> => Number((await mustGit(['rev-list', '--count', 'HEAD'])).stdout.trim());

/** The names of the files that a commit holds. */
const filesOfHead = async (): Promise<string[]> =>
  (await mustGit(['show', '--name-only', '--format=', 'HEAD'])).stdout.split('\n').filter((line) => line !== '');

beforeEach(async () => {
  box = await makeSandbox();
  for (const name of GIT_ENV_NAMES) vi.stubEnv(name, box.env[name]);
  stateDir = join(box.root, 'node', '.factory');
  await mkdir(stateDir, { recursive: true });
  await mustGit(['init', '-q', '-b', 'main']);
  deps = { ...createNodeDeps(), cwd: stateDir, programArgv: [process.execPath, DIST] };
  const installed = await installGuard(deps, stateDir, stateDir);
  if (!installed.ok) throw new Error(installed.error.message);
  await writeInState(BOARD, board(['B-1', 'B-2']));
  await writeInState(OTHER, 'one\n');
  await mustGit(['add', '-A']);
  // The first commit has no last commit to compare with: the hook runs and passes.
  const first = await commit();
  expect(first.code, first.stderr).toBe(0);
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  vi.unstubAllEnvs();
  await box.remove();
});

afterAll(removeOpenSandboxes);

describe('the guard that the install writes (TP-1)', () => {
  it('holds the package text as each hook file with mode 755 in the guard folder of the git folder, and git tracks no guard file', async () => {
    const gitDir = join(await realpath(stateDir), '.git');
    const text = guardHookText(deps.programArgv);
    expect(text.ok).toBe(true);
    for (const name of stateGuard.hookFiles) {
      const hook = join(gitDir, stateGuard.folder, name);
      expect(await readFile(hook, 'utf8')).toBe(text.ok ? text.value : '');
      expect((await stat(hook)).mode & 0o777).toBe(0o755);
    }
    expect(await readdir(join(gitDir, stateGuard.folder))).toEqual(SORTED_HOOKS);
    expect((await mustGit(['config', stateGuard.hooksPathKey])).stdout.trim()).toBe(join(gitDir, stateGuard.folder));
    const tracked = (await mustGit(['ls-files'])).stdout.split('\n').filter((line) => line !== '');
    expect(tracked.sort()).toEqual([BOARD, OTHER]);
    expect((await mustGit(['status', '--porcelain'])).stdout).toBe('');
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
  });

  it('is installed again over a hook with other text, a stray file, and a link, and the target of the link stays as it was', async () => {
    const gitDir = join(await realpath(stateDir), '.git');
    const folder = join(gitDir, stateGuard.folder);
    const target = join(box.root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');
    await writeFile(join(target, 'hook-target'), 'target text');
    await symlink(target, join(folder, 'stray-link'));
    await writeFile(join(folder, 'post-commit'), 'x');
    await mustGit(['config', stateGuard.hooksPathKey, '/somewhere/else']);
    expect(await guardStateOf(deps, stateDir)).toMatchObject({ ok: true, value: { on: false, kind: 'hooks-path' } });
    const repaired = await installGuard(deps, stateDir, stateDir);
    expect(repaired.ok).toBe(true);
    expect(await readdir(folder)).toEqual(SORTED_HOOKS);
    expect(await readdir(target)).toEqual(['hook-target', 'keep.txt']);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
  });

  it('replaces a hook file that is a link with a plain file, and does not write through the link', async () => {
    const gitDir = join(await realpath(stateDir), '.git');
    const hook = join(gitDir, stateGuard.folder, PRE_COMMIT);
    const target = join(box.root, 'hook-target');
    await writeFile(target, 'target text');
    await chmod(target, 0o755);
    await rm(hook);
    await symlink(target, hook);
    expect(await guardStateOf(deps, stateDir)).toMatchObject({ ok: true, value: { on: false, kind: 'hook-not-plain' } });
    expect((await installGuard(deps, stateDir, stateDir)).ok).toBe(true);
    expect((await lstat(hook)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('target text');
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
  });
});

describe('the guard folder is a link (TP-53)', () => {
  it('stops the install with exit 4 and leaves the target folder as it was', async () => {
    const gitDir = join(await realpath(stateDir), '.git');
    const folder = join(gitDir, stateGuard.folder);
    const target = join(box.root, 'other-folder');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');
    await writeFile(join(target, PRE_COMMIT), 'other hook');
    await rm(folder, { recursive: true });
    await symlink(target, folder);
    const result = await installGuard(deps, stateDir, stateDir);
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety', hint: stateGuard.remedy } });
    expect(await readlink(folder)).toBe(target);
    expect((await readdir(target)).sort()).toEqual([PRE_COMMIT, 'keep.txt'].sort());
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(join(target, PRE_COMMIT), 'utf8')).toBe('other hook');
    expect(await guardStateOf(deps, stateDir)).toMatchObject({ ok: true, value: { on: false, kind: 'folder-not-plain' } });
  });
});

describe('the text of the hook, run by a shell (TP-1)', () => {
  it('starts the program with the words state guard, and keeps a path with a space and a command substitution as one word each', async () => {
    const programFolder = join(box.root, 'my node');
    const scriptFolder = join(box.root, '$(touch injected)');
    await mkdir(programFolder);
    await mkdir(scriptFolder);
    const out = join(box.root, 'args.txt');
    const stub = join(programFolder, 'node-stub');
    await writeFile(stub, `#!/bin/sh\nfor word in "$@"; do printf '%s\\n' "$word" >> '${out}'; done\n`);
    await chmod(stub, 0o755);
    const script = join(scriptFolder, 'cli.js');
    await writeFile(script, '');
    const text = guardHookText([stub, script]);
    if (!text.ok) throw new Error(text.error.message);
    const hook = join(box.root, 'hook.sh');
    await writeFile(hook, text.value);
    const ran = await new Promise<number>((resolve) => {
      execFile('sh', [hook], { cwd: box.root, env: { PATH: '/usr/bin:/bin' } }, (error) =>
        resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : -1),
      );
    });
    expect(ran).toBe(0);
    expect((await readFile(out, 'utf8')).split('\n').filter((line) => line !== '')).toEqual([script, 'state', 'guard']);
    await expect(stat(join(box.root, 'injected'))).rejects.toThrow();
    await expect(stat(join(scriptFolder, 'injected'))).rejects.toThrow();
  });
});

describe('a manual commit that removes an item id (TP-7)', () => {
  it('fails and names the id, and the last commit stays', async () => {
    const before = await headId();
    await writeInState(BOARD, board(['B-1']));
    await mustGit(['add', BOARD]);
    const result = await commit();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('B-2');
    expect(result.stderr).toContain('Mark an item closed, never remove it.');
    expect(await headId()).toBe(before);
  });

  it('passes for a commit that adds an item and changes another', async () => {
    await writeInState(BOARD, `${JSON.stringify({ queue: [], items: [{ id: 'B-1', title: 'changed' }, { id: 'B-2' }, { id: 'B-3' }] })}\n`);
    await mustGit(['add', BOARD]);
    const result = await commit();
    expect(result.code, result.stderr).toBe(0);
    expect(await countOfCommits()).toBe(2);
  });

  it('passes for a commit that closes an item and keeps its id', async () => {
    await writeInState(BOARD, board(['B-1', 'B-2'], { status: 'closed' }));
    await mustGit(['add', BOARD]);
    const result = await commit();
    expect(result.code, result.stderr).toBe(0);
  });
});

describe('a commit that the guard reads as a loss or cannot read (TP-8)', () => {
  it('counts an id that stays only in the text of another item as removed', async () => {
    const before = await headId();
    await writeInState(BOARD, `${JSON.stringify({ queue: [], items: [{ id: 'B-1', title: '{"id": "B-2"}' }] })}\n`);
    await mustGit(['add', BOARD]);
    const result = await commit();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('B-2');
    expect(await headId()).toBe(before);
  });

  it('fails for a commit that removes board.json', async () => {
    await mustGit(['rm', '-q', BOARD]);
    const result = await commit();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the file is removed');
  });

  it('fails for a board that is not JSON', async () => {
    await writeInState(BOARD, 'items: [B-1, B-2]\n');
    await mustGit(['add', BOARD]);
    const result = await commit();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the text is not valid JSON');
  });

  describe('with a board at the last commit that is not JSON', () => {
    beforeEach(async () => {
      await writeInState(BOARD, 'not json\n');
      await mustGit(['add', BOARD]);
      // `--no-verify` is the one way past the hook: the guard would stop this board.
      const planted = await commit('--no-verify');
      expect(planted.code, planted.stderr).toBe(0);
    });

    it('passes for a commit that leaves board.json unchanged', async () => {
      await writeInState(OTHER, 'two\n');
      await mustGit(['add', OTHER]);
      const result = await commit();
      expect(result.code, result.stderr).toBe(0);
      expect(await filesOfHead()).toEqual([OTHER]);
    });

    it('passes a repair that keeps every item id of the last board that can be read, as a normal commit', async () => {
      await writeInState(BOARD, board(['B-1', 'B-2', 'B-3']));
      await mustGit(['add', BOARD]);
      const result = await commit();
      expect(result.code, result.stderr).toBe(0);
      expect(await filesOfHead()).toEqual([BOARD]);
    });

    it('fails a repair that drops an item id of the last board that can be read, and names the id', async () => {
      const before = await headId();
      await writeInState(BOARD, board(['B-1']));
      await mustGit(['add', BOARD]);
      const result = await commit();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('B-2');
      expect(result.stderr).not.toContain('B-1');
      expect(await headId()).toBe(before);
    });

    it('fails a repair that is not JSON, with the remedy to commit again', async () => {
      await writeInState(BOARD, 'still not json\n');
      await mustGit(['add', BOARD]);
      const result = await commit();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('the text is not valid JSON');
      expect(result.stderr).toContain('commit again');
    });

    it('accepts the repair that its own remedy gives: the board of an older commit, restored and committed', async () => {
      const oldest = (await mustGit(['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim();
      await mustGit(['restore', `--source=${oldest}`, '--staged', '--worktree', '--', BOARD]);
      const result = await commit();
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(stateDir, BOARD), 'utf8')).toBe(board(['B-1', 'B-2']));
    });
  });

  describe('with no board that can be read within the bound of the history', () => {
    it('fails closed with a remedy that names a normal action', async () => {
      for (let step = 0; step <= stateGuard.historyBound; step += 1) {
        await writeInState(BOARD, `not json ${step}\n`);
        await mustGit(['add', BOARD]);
        // `--no-verify` is the one way past the hook: the guard would stop these boards.
        const planted = await commit('--no-verify');
        expect(planted.code, planted.stderr).toBe(0);
      }
      await writeInState(BOARD, board(['B-1', 'B-2']));
      await mustGit(['add', BOARD]);
      const result = await commit();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('git -C .factory restore --source=<commit> --staged --worktree -- board.json');
      expect(result.stderr).not.toContain('--no-verify');
    }, SETUP_TIMEOUT_MS);
  });
});

describe('a merge commit and a mailed patch that remove an item id (TP-7)', () => {
  /** A branch that forks from the last commit and holds the board `ids`. The hook would stop the removal, so `--no-verify` plants it. */
  const plantBranch = async (name: string, ids: readonly string[]): Promise<void> => {
    await mustGit(['checkout', '-q', '-b', name]);
    await writeInState(BOARD, board(ids));
    await mustGit(['add', BOARD]);
    const planted = await commit('--no-verify');
    expect(planted.code, planted.stderr).toBe(0);
    await mustGit(['checkout', '-q', 'main']);
  };

  /** Move main on, so that a merge of the other branch is a merge commit and not a fast-forward. */
  const moveMainOn = async (): Promise<void> => {
    await writeInState(OTHER, 'two\n');
    await mustGit(['add', OTHER]);
    const moved = await commit();
    expect(moved.code, moved.stderr).toBe(0);
  };

  /** The patch of the last commit of a branch, in a file. */
  const patchOf = async (branch: string): Promise<string> => {
    const file = join(box.root, `${branch}.patch`);
    await writeFile(file, (await mustGit(['format-patch', '-1', '--stdout', branch])).stdout);
    return file;
  };

  it('stops a merge commit that removes an item id, names the id, and the last commit stays', async () => {
    await plantBranch('side', ['B-1']);
    await moveMainOn();
    const before = await headId();
    const merged = await git(['merge', '--no-ff', '-m', 'merge side', 'side']);
    expect(merged.code).not.toBe(0);
    expect(merged.stderr).toContain('B-2');
    expect(merged.stderr).toContain('Mark an item closed, never remove it.');
    expect(await headId()).toBe(before);
  });

  it('passes a merge commit that adds an item', async () => {
    await plantBranch('side', ['B-1', 'B-2', 'B-3']);
    await moveMainOn();
    const merged = await git(['merge', '--no-ff', '-m', 'merge side', 'side']);
    expect(merged.code, merged.stderr).toBe(0);
    expect((await mustGit(['rev-parse', '--verify', 'HEAD^2'])).code).toBe(0);
    expect(await readFile(join(stateDir, BOARD), 'utf8')).toBe(board(['B-1', 'B-2', 'B-3']));
  });

  it('stops a mailed patch that removes an item id, names the id, and the last commit stays', async () => {
    await plantBranch('drop', ['B-1']);
    const patch = await patchOf('drop');
    const before = await headId();
    const applied = await git(['am', patch]);
    expect(applied.code).not.toBe(0);
    expect(applied.stderr).toContain('B-2');
    expect(await headId()).toBe(before);
  });

  it('passes a mailed patch that adds an item', async () => {
    await plantBranch('more', ['B-1', 'B-2', 'B-3']);
    const patch = await patchOf('more');
    const before = await headId();
    const applied = await git(['am', patch]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(await headId()).not.toBe(before);
    expect(await readFile(join(stateDir, BOARD), 'utf8')).toBe(board(['B-1', 'B-2', 'B-3']));
  });
});

describe('the index that git gives the hook (TP-9)', () => {
  it('reads the files of a commit of all files (-a), also when the removal is not staged', async () => {
    const before = await headId();
    await writeInState(BOARD, board(['B-1']));
    const result = await commit('-a');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('B-2');
    expect(await headId()).toBe(before);
  });

  it('passes for a commit of all files (-a) that adds an item', async () => {
    await writeInState(BOARD, board(['B-1', 'B-2', 'B-3']));
    const result = await commit('-a');
    expect(result.code, result.stderr).toBe(0);
    expect(await filesOfHead()).toEqual([BOARD]);
  });

  it('reads the files of a commit with a path list, also when the removal is not staged', async () => {
    const before = await headId();
    await writeInState(BOARD, board(['B-1']));
    const result = await commit('--', BOARD);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('B-2');
    expect(await headId()).toBe(before);
  });

  it('passes for a commit with a path list that names another file, while the removal waits in the work tree', async () => {
    await writeInState(BOARD, board(['B-1']));
    await writeInState(OTHER, 'two\n');
    const result = await commit('--', OTHER);
    expect(result.code, result.stderr).toBe(0);
    expect(await filesOfHead()).toEqual([OTHER]);
    expect(await readFile(join(stateDir, BOARD), 'utf8')).toBe(board(['B-1']));
  });

  it('passes for a commit with a path list that names another file, while the removal is staged: the commit does not hold it', async () => {
    await writeInState(BOARD, board(['B-1']));
    await mustGit(['add', BOARD]);
    await writeInState(OTHER, 'two\n');
    const result = await commit('--', OTHER);
    expect(result.code, result.stderr).toBe(0);
    expect(await filesOfHead()).toEqual([OTHER]);
    expect((await mustGit(['diff', '--cached', '--name-only'])).stdout.trim()).toBe(BOARD);
  });
});

describe('the undo of an install of the guard', () => {
  const gitDirOf = async (): Promise<string> => join(await realpath(stateDir), '.git');

  /** The names in the git folder that start with the guard folder name: the folder itself and a copy of it. */
  const guardNames = async (): Promise<string[]> =>
    (await readdir(await gitDirOf())).filter((name) => name.startsWith(stateGuard.folder)).sort();

  it('puts the config file, the old hook, a stray file and a link back as they were, and the target of the link stays', async () => {
    const folder = join(await gitDirOf(), stateGuard.folder);
    const target = join(box.root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');
    await symlink(target, join(folder, 'stray-link'));
    await writeFile(join(folder, 'post-commit'), 'x');
    await writeFile(join(folder, PRE_COMMIT), '#!/bin/sh\nexit 0\n');
    await chmod(join(folder, PRE_COMMIT), 0o755);
    await mustGit(['config', stateGuard.hooksPathKey, '/somewhere/else']);
    const config = await readFile(join(await gitDirOf(), 'config'), 'utf8');
    const entries = await readdir(folder);

    const changed = await installGuardWithUndo(deps, stateDir);
    expect(changed.ok).toBe(true);
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
    expect(await guardNames()).toHaveLength(2);
    if (!changed.ok) return;
    const undone = await changed.value.undo();
    expect(undone.ok).toBe(true);

    expect(await readFile(join(await gitDirOf(), 'config'), 'utf8')).toBe(config);
    expect(await readdir(folder)).toEqual(entries);
    expect(await readFile(join(folder, PRE_COMMIT), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect((await stat(join(folder, PRE_COMMIT))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(folder, 'post-commit'), 'utf8')).toBe('x');
    expect(await readlink(join(folder, 'stray-link'))).toBe(target);
    expect(await readdir(target)).toEqual(['keep.txt']);
    expect(await guardNames()).toEqual([stateGuard.folder]);
  });

  it('removes the guard folder and the setting that it made, and leaves the config file as it was', async () => {
    await rm(join(await gitDirOf(), stateGuard.folder), { recursive: true });
    await mustGit(['config', '--unset', stateGuard.hooksPathKey]);
    const config = await readFile(join(await gitDirOf(), 'config'), 'utf8');

    const changed = await installGuardWithUndo(deps, stateDir);
    expect(changed.ok).toBe(true);
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
    if (!changed.ok) return;
    expect((await changed.value.undo()).ok).toBe(true);

    expect(await readFile(join(await gitDirOf(), 'config'), 'utf8')).toBe(config);
    expect(await guardNames()).toEqual([]);
  });

  it('keeps no copy of the old guard folder after keep, and the guard stays on', async () => {
    await writeFile(join(await gitDirOf(), stateGuard.folder, 'post-commit'), 'x');
    const changed = await installGuardWithUndo(deps, stateDir);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect((await changed.value.keep()).ok).toBe(true);
    expect(await guardNames()).toEqual([stateGuard.folder]);
    expect(await guardStateOf(deps, stateDir)).toEqual({ ok: true, value: { on: true } });
  });

  it('stops with exit 4 and changes nothing for a guard folder that is a link, and undo leaves the link and its target', async () => {
    const folder = join(await gitDirOf(), stateGuard.folder);
    const target = join(box.root, 'elsewhere');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');
    await rm(folder, { recursive: true });
    await symlink(target, folder);
    const config = await readFile(join(await gitDirOf(), 'config'), 'utf8');

    const changed = await installGuardWithUndo(deps, stateDir);
    expect(changed).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(await readlink(folder)).toBe(target);
    expect(await readdir(target)).toEqual(['keep.txt']);
    expect(await readFile(join(await gitDirOf(), 'config'), 'utf8')).toBe(config);
  });
});
