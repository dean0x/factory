import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchArgv } from '../../src/launch/argv.js';
import { files, stateGuard } from '../../src/names.js';
import { startCommandText } from '../helpers/tmux-fake.js';
import { makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';
import { scaled } from './load.js';

/**
 * The board commands with the built program and real git, in a scratch folder with its own HOME and git identity. The `board` block
 * of the setup declares three item states, and the node is made by `init`, so the state repo, its delete guard and its board files
 * are the ones that a user gets.
 */

let box: Sandbox;

/** The time that a case may take: `init`, a run of the program for each write, and the wait for the state lock of the writes. */
const CASE_MS = scaled(120_000);

const BOARD_BLOCK = ['board:', '  states: [open, doing, done]', '  in_progress: doing', '  closed: done', ''].join('\n');

const BOARD_FILES = [files.board, files.waiting, files.decisionLog];

/** A file of the factory folder that an item can link. */
const DOC = 'docs/plan.md';

const factory = (args: readonly string[]): Promise<RunResult> => box.run([...args, '--home', box.node]);

/** A run that must exit 0. */
const mustRun = async (args: readonly string[]): Promise<RunResult> => {
  const result = await factory(args);
  expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result;
};

const stateDir = (): string => join(box.node, '.factory');

const stateGit = (args: readonly string[]): Promise<RunResult> => box.git(stateDir(), args);

const commitCount = async (): Promise<number> => Number((await stateGit(['rev-list', '--count', 'HEAD'])).stdout.trim());

const textOf = (file: string): Promise<string> => readFile(join(stateDir(), file), 'utf8');

const boardFilesNow = (): Promise<string[]> => Promise.all(BOARD_FILES.map(textOf));

/** The names of the files that each of the last `count` commits holds, one name for each file. */
const filesOfLastCommits = async (count: number): Promise<string[]> =>
  (await stateGit(['log', '-n', String(count), '--name-only', '--format='])).stdout.split('\n').filter((line) => line !== '');

beforeEach(async () => {
  box = await makeSandbox();
  const project = await box.makeProject('web');
  expect((await box.git(project, ['commit', '--allow-empty', '-q', '-m', 'first'])).code).toBe(0);
  const made = await box.run(['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', project]);
  expect(made.code, made.stderr).toBe(0);
  const config = join(box.node, files.config);
  const text = await readFile(config, 'utf8');
  await writeFile(config, `${text}${text.endsWith('\n') ? '' : '\n'}${BOARD_BLOCK}`);
}, CASE_MS);

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

/** A tmux boundary fake lets the doc command reach the state guard from its required caller. */
const requestCaller = async (): Promise<Readonly<Record<string, string>>> => {
  const command = launchArgv({
    effort: 'high', model: 'default', proxyBaseUrl: null, path: box.env['PATH'] ?? '/bin', agent: 'claude',
    home: box.node, coordinatorDir: join(box.node, 'coordinator'), stateDir: stateDir(), sessionId: 'demo', projects: [],
  });
  expect(command.ok).toBe(true);
  if (!command.ok) throw new Error(command.error);
  const bin = join(box.root, 'caller-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'tmux'), [
    '#!/bin/sh',
    'case "$1" in',
    '  has-session) exit 0 ;;',
    '  show-options) printf "%s\\n" "$FACTORY_HOME" ;;',
    '  display-message) printf "%s\\n" "%0|123|0|1|$TEST_COORDINATOR_COMMAND" ;;',
    '  *) exit 1 ;;',
    'esac', '',
  ].join('\n'));
  await chmod(join(bin, 'tmux'), 0o755);
  return {
    PATH: `${bin}:${box.env['PATH'] ?? '/bin'}`, FACTORY_HOME: box.node, FACTORY_SESSION: 'demo', TMUX_PANE: '%0',
    TEST_COORDINATOR_COMMAND: startCommandText(command.value),
  };
};

describe('the board commands with the delete guard off', () => {
  it(
    'exits 4 for item, track, request context and doc writes and queue set, writes nothing, and the lists still work',
    async () => {
      await mustRun(['item', 'add', '--title', 'First']);
      await mustRun(['item', 'add', '--title', 'Second']);
      await mustRun(['track', 'add', 'core', '--name', 'Core']);
      await mustRun(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes']);
      await mustRun(['queue', 'set', 'Docs', '--item', 'B-1']);
      await mkdir(join(box.node, 'docs'));
      await writeFile(join(box.node, DOC), '# Plan\n');
      expect((await stateGit(['config', stateGuard.hooksPathKey, '/somewhere/else'])).code).toBe(0);
      const filesBefore = await boardFilesNow();
      const commitsBefore = await commitCount();
      const caller = await requestCaller();
      const run = vi.spyOn(box, 'run');

      const writes: readonly (readonly string[])[] = [
        ['item', 'add', '--title', 'Third'],
        ['item', 'update', 'B-1', '--title', 'Changed'],
        ['item', 'update', 'B-1', '--epic', 'Launch'],
        ['item', 'move', 'B-1', '--state', 'doing'],
        ['item', 'rank', 'B-2', '--first'],
        ['item', 'close', 'B-1'],
        ['item', 'doc', 'B-1', DOC],
        ['track', 'add', 'docs', '--name', 'Docs'],
        ['request', 'add', '--title', 'Other', '--question', 'Why?', '--option', 'a=Yes'],
        ['request', 'add', '--title', 'Context', '--question', 'Why?', '--option', 'a=Yes',
          '--kind', 'information', '--field', 'Scope=Web', '--why', 'a=Fits', '--doc', DOC],
        ['request', 'doc', 'D-1', DOC],
        ['queue', 'set', 'Docs', '--note', 'Changed'],
        ['queue', 'set', 'Docs', '--release-group', 'Launch'],
      ];
      for (const args of writes) {
        const result = args[0] === 'request' && args[1] === 'doc'
          ? await box.run([...args, '--home', box.node], { env: caller })
          : await factory(args);
        expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(4);
        expect(result.stderr).toContain('the delete guard of .factory is off');
      }
      expect(run.mock.calls.map(([, options]) => options?.env === undefined)).toEqual(
        writes.map(([command, action]) => command !== 'request' || action !== 'doc'),
      );
      run.mockRestore();
      expect(await boardFilesNow()).toEqual(filesBefore);
      expect(await commitCount()).toBe(commitsBefore);

      for (const args of [['item', 'list'], ['track', 'list'], ['request', 'list'], ['queue', 'show']]) {
        const result = await factory(args);
        expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0);
      }
    },
    CASE_MS,
  );
});

describe('item notes in the state repo', () => {
  it('refuses leading line breaks and commits a valid note in one line', async () => {
    await mustRun(['item', 'add', '--title', 'First']);
    const before = await commitCount();

    const refused = await factory(['item', 'note', 'B-1', '\n\nWork started']);
    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain('the note is not one line');
    expect(await commitCount()).toBe(before);

    const noted = await mustRun(['item', 'note', 'B-1', '  Work started  ']);
    expect(noted.stdout).toBe('Noted B-1: First\n');
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfLastCommits(1)).toEqual([files.board]);
    expect((await stateGit(['log', '-1', '--format=%B'])).stdout).toBe('chore: note item B-1: Work started\n\n');
    const board: unknown = JSON.parse(await textOf(files.board));
    expect(board).toMatchObject({ items: [{ id: 'B-1', status: 'open', notes: [{ text: 'Work started', at: expect.any(String) }] }] });
  }, CASE_MS);

  it('closes the item and stores the reason in the same board commit', async () => {
    await mustRun(['item', 'add', '--title', 'First']);
    const before = await commitCount();

    const closed = await mustRun(['item', 'close', 'B-1', '--reason', '  Work is complete  ']);

    expect(closed.stdout).toBe('Closed B-1: First\n');
    expect(await commitCount()).toBe(before + 1);
    expect(await filesOfLastCommits(1)).toEqual([files.board]);
    expect((await stateGit(['log', '-1', '--format=%B'])).stdout).toBe('chore: close item B-1: Work is complete\n\n');
    const board: unknown = JSON.parse(await textOf(files.board));
    expect(board).toMatchObject({ items: [{ id: 'B-1', status: 'done', notes: [{ text: 'Work is complete' }] }] });
  }, CASE_MS);
});

/** The text that the state lock wait of the product puts in stderr when another process still holds the lock at the end of the wait. */
const LOCK_HELD_TEXT = 'holds the lock';

/** The most times that a process runs again after it did not get the lock. */
const MAX_RERUNS = 2;

/** True for a run that failed only because another process held the state lock for the whole wait: exit 1 with the lock text in stderr. */
const didNotGetLock = (result: RunResult): boolean => result.code === 1 && result.stderr.includes(LOCK_HELD_TEXT);

/**
 * Run a process, and run it again only when it did not get the state lock, at most `maxReruns` more times. Five processes of a loaded
 * machine can need more than the wait of the product for the lock. The bounds of the product stay as they are. Such a run wrote
 * nothing, so a second run is safe. Any other result, a fault included, is the result of the process.
 */
const rerunOnLockWait = async (run: () => Promise<RunResult>, maxReruns: number = MAX_RERUNS): Promise<RunResult> => {
  let result = await run();
  for (let rerun = 0; rerun < maxReruns && didNotGetLock(result); rerun += 1) result = await run();
  return result;
};

describe('the board commands that run at the same time', () => {
  const PARALLEL = [1, 2, 3, 4, 5] as const;

  it(
    'runs a process again only after exit 1 with "holds the lock" in stderr, and at most two more times',
    async () => {
      const lockHeld: RunResult = { code: 1, stdout: '', stderr: `cannot write board.json: another process ${LOCK_HELD_TEXT} /state/locks/state.lock\n` };
      const cases: readonly { name: string; resultOf: (call: number) => RunResult; calls: number; code: number }[] = [
        { name: 'a lock wait that never ends', resultOf: () => lockHeld, calls: 3, code: 1 },
        { name: 'a lock wait that ends with a good run', resultOf: (call) => (call < 3 ? lockHeld : { code: 0, stdout: '', stderr: '' }), calls: 3, code: 0 },
        { name: 'a good run', resultOf: () => ({ code: 0, stdout: '', stderr: '' }), calls: 1, code: 0 },
        { name: 'exit 1 with another message', resultOf: () => ({ code: 1, stdout: '', stderr: 'cannot write board.json: no space\n' }), calls: 1, code: 1 },
        { name: 'another exit code with the lock text', resultOf: () => ({ ...lockHeld, code: 4 }), calls: 1, code: 4 },
        { name: 'a run that did not start', resultOf: () => ({ ...lockHeld, code: -1 }), calls: 1, code: -1 },
      ];
      for (const { name, resultOf, calls, code } of cases) {
        let started = 0;
        const result = await rerunOnLockWait(async () => {
          started += 1;
          return resultOf(started);
        });
        expect({ name, started, code: result.code }, name).toEqual({ name, started: calls, code });
      }
    },
    CASE_MS,
  );

  it(
    'makes five state commits, each of the board file only, for five item move calls that run at the same time',
    async () => {
      for (const number of PARALLEL) await mustRun(['item', 'add', '--title', `Item ${number}`]);
      const before = await commitCount();
      const results = await Promise.all(
        PARALLEL.map((number) => rerunOnLockWait(() => factory(['item', 'move', `B-${number}`, '--state', 'doing']))),
      );
      for (const [at, result] of results.entries()) expect(result.code, `move B-${at + 1}: ${result.stderr}`).toBe(0);
      expect(await commitCount()).toBe(before + PARALLEL.length);
      expect(await filesOfLastCommits(PARALLEL.length)).toEqual(PARALLEL.map(() => files.board));
      const board = JSON.parse(await textOf(files.board)) as { items: { status: string }[] };
      expect(board.items.map((item) => item.status)).toEqual(PARALLEL.map(() => 'doing'));
    },
    CASE_MS,
  );

  it(
    'keeps all five ids for five item rank calls that run at the same time, and makes one commit of the board file only for each change',
    async () => {
      const ids = PARALLEL.map((number) => `B-${number}`);
      for (const number of PARALLEL) await mustRun(['item', 'add', '--title', `Item ${number}`]);
      const before = await commitCount();
      const results = await Promise.all(ids.map((id) => rerunOnLockWait(() => factory(['item', 'rank', id, '--first']))));
      for (const [at, result] of results.entries()) {
        expect(result.code, `rank ${ids[at]}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(new RegExp(`^${ids[at]} rank: first( \\(no change\\))?\\n$`));
      }
      const changedIds = ids.filter((_, at) => !(results[at]?.stdout ?? '').endsWith('(no change)\n'));
      // Only the rank of B-1 can find its item in place, and only when it runs first: each later rank moves an item that is not first.
      expect(changedIds.length).toBeGreaterThanOrEqual(PARALLEL.length - 1);
      expect(await commitCount()).toBe(before + changedIds.length);
      expect(await filesOfLastCommits(changedIds.length)).toEqual(changedIds.map(() => files.board));
      const subjects = (await stateGit(['log', '-n', String(changedIds.length), '--format=%s'])).stdout.trim().split('\n');
      expect([...subjects].sort()).toEqual(changedIds.map((id) => `chore: rank item ${id}`).sort());
      const board = JSON.parse(await textOf(files.board)) as { items: { id: string }[] };
      expect(board.items.map((item) => item.id).sort()).toEqual(ids);
    },
    CASE_MS,
  );

  it(
    'gives five request add calls that run at the same time five different numbers, and makes five commits of the waiting file only',
    async () => {
      const before = await commitCount();
      const results = await Promise.all(
        PARALLEL.map((number) =>
          rerunOnLockWait(() => factory(['request', 'add', '--title', `Request ${number}`, '--question', 'Which?', '--option', 'a=Yes'])),
        ),
      );
      for (const [at, result] of results.entries()) expect(result.code, `add ${at + 1}: ${result.stderr}`).toBe(0);
      const numbers = results.map((result) => /Added (D-\d+):/.exec(result.stdout)?.[1]).sort();
      expect(numbers).toEqual(['D-1', 'D-2', 'D-3', 'D-4', 'D-5']);
      expect(await commitCount()).toBe(before + PARALLEL.length);
      expect(await filesOfLastCommits(PARALLEL.length)).toEqual(PARALLEL.map(() => files.waiting));
    },
    CASE_MS,
  );
});
