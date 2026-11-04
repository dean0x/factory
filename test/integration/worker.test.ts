import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes, tmuxSocketOf, type RunResult, type Sandbox } from './harness.js';

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('worker.test.ts is skipped: tmux 3.0 or newer is not installed.');

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
const EXCLUDE_ENTRY = '/.claude/settings.local.json';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact'];

let box: Sandbox;
let tmuxEnv: Record<string, string>;
let socket: string;
let outDir: string;

/** The fake claude writes what the test needs to know, then sleeps. It writes the file `launches` last. */
const fakeClaude = (dir: string): string =>
  [
    '#!/bin/sh',
    `dir='${dir}'`,
    'printf \'%s\\n\' "$@" > "$dir/argv"',
    'printf \'%s\' "$FACTORY_HOME" > "$dir/home"',
    'printf \'%s\' "$FACTORY_SESSION" > "$dir/session"',
    'printf \'%s\' "$FACTORY_INBOX" > "$dir/inbox"',
    'pwd -P > "$dir/cwd"',
    'echo launched >> "$dir/launches"',
    'exec sleep 300',
    '',
  ].join('\n');

const tmux = (args: readonly string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile('tmux', [...args], { env: tmuxEnv, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the fake claude has launched this many times. The wait has an upper bound. */
const waitForLaunches = async (count: number): Promise<void> => {
  for (let step = 0; step < POLL_STEPS; step += 1) {
    const text = await readFile(join(outDir, 'launches'), 'utf8').catch(() => '');
    if (text.trim().split('\n').filter((line) => line !== '').length >= count) return;
    await sleep(POLL_STEP_MS);
  }
  throw new Error(`the fake claude did not launch ${count} times`);
};

const outOf = async (name: string): Promise<string> => (await readFile(join(outDir, name), 'utf8')).trim();

/** The panes of the workers window, as `<pane id> <worker mark>` lines. A pane with no mark has an empty mark. */
const workerPanes = async (): Promise<string[]> =>
  (await tmux(['list-panes', '-t', '=demo:workers', '-F', '#{pane_id} #{@worker}'])).stdout.split('\n').filter((line) => line !== '');

/** Every path below a folder, as relative paths. */
const treeOf = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true })).sort();

const stopServer = async (): Promise<void> => {
  await tmux(['-S', socket, 'kill-server']);
  for (let step = 0; step < STOP_STEPS; step += 1) {
    if ((await tmux(['-S', socket, 'list-sessions'])).code !== 0) return;
    await sleep(POLL_STEP_MS);
  }
};

beforeEach(async () => {
  box = await makeSandbox();
  outDir = join(box.root, 'out');
  const bin = join(box.root, 'bin');
  await mkdir(outDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), fakeClaude(outDir));
  await chmod(join(bin, 'claude'), 0o755);
  // A separate tmux server: the harness sets TMUX_TMPDIR to a folder of the sandbox and gives no TMUX.
  socket = tmuxSocketOf(box.root);
  tmuxEnv = { ...box.env, SHELL: '/bin/sh', PATH: `${bin}:${box.env['PATH'] ?? ''}` };
});

afterEach(async () => {
  try {
    if (hasTmux && tmuxEnv['TMUX_TMPDIR']?.startsWith(box.root) === true) await stopServer();
  } finally {
    await box.remove();
  }
});

afterAll(removeOpenSandboxes);

/** The settings of Claude Code that the program writes into a session folder. The command texts are the contract. */
const ownSettings = (): Record<string, unknown> => ({
  hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command: `factory hook ${event}` }] }]])),
  statusLine: { type: 'command', command: 'factory hook statusline' },
});

/**
 * Make the node with the clone of one project that has a commit, then start the session of the node. `worker new` needs
 * the session, and a work tree needs a commit to branch from.
 */
const startedNode = async (): Promise<string> => {
  const source = await box.makeProject('web');
  const committed = await box.git(source, ['commit', '--allow-empty', '-q', '-m', 'first']);
  expect(committed.code).toBe(0);
  const init = await box.run(
    ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', source],
    { env: tmuxEnv },
  );
  expect(init.code).toBe(0);
  const started = await box.run(['start', '--home', box.node], { env: tmuxEnv });
  expect(started.code).toBe(0);
  await waitForLaunches(1);
  return join(box.node, 'web');
};

const workerNew = (...extra: string[]): Promise<RunResult> =>
  box.run(['worker', 'new', '--home', box.node, ...extra], { env: tmuxEnv });

describe.skipIf(!hasTmux)('factory worker new (built binary, separate tmux server)', () => {
  it('makes the work copy, the record and a marked pane that runs the program in the work copy (TP-5)', async () => {
    const clone = await startedNode();
    const result = await workerNew('alpha', '--project', 'web', '--yes');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Made the worker alpha in work-copies/web/alpha on the branch worker/alpha.');
    expect(result.stderr).toContain('This changes the settings of Claude Code in ');

    // The work copy is a work tree of the clone, on the new branch.
    const copy = join(box.node, 'work-copies', 'web', 'alpha');
    expect((await box.git(copy, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('worker/alpha');
    const common = (await box.git(copy, ['rev-parse', '--git-common-dir'])).stdout.trim();
    expect(await realpath(resolve(copy, common))).toBe(await realpath(join(clone, '.git')));

    // The record of the worker.
    const record = JSON.parse(await readFile(join(box.node, '.factory', 'workers', 'alpha', 'worker.json'), 'utf8')) as Record<string, unknown>;
    expect(record).toMatchObject({ schema: 'factory.worker/v1', id: 'alpha', project: 'web', branch: 'worker/alpha' });
    expect(await realpath(String(record['work_copy']))).toBe(await realpath(copy));
    expect((await stat(join(box.node, '.factory', 'workers', 'alpha', 'inbox'))).isDirectory()).toBe(true);

    // The hook settings are in the work copy, and the clone hides the file from git: the work copy is clean.
    expect(JSON.parse(await readFile(join(copy, '.claude', 'settings.local.json'), 'utf8'))).toEqual(ownSettings());
    const exclude = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === EXCLUDE_ENTRY)).toHaveLength(1);
    expect((await box.git(copy, ['status', '--porcelain'])).stdout).toBe('');

    // One pane in the workers window carries the mark, and the program runs in the work copy as the worker.
    await waitForLaunches(2);
    expect((await workerPanes()).filter((line) => line.endsWith(' alpha'))).toHaveLength(1);
    expect(await outOf('session')).toBe('alpha');
    expect(await outOf('home')).toBe(box.node);
    expect(await outOf('cwd')).toBe(await realpath(copy));
    const inbox = join(box.node, '.factory', 'workers', 'alpha', 'inbox');
    expect(await outOf('inbox')).toBe(inbox);
    const argv = (await outOf('argv')).split('\n');
    expect(argv.slice(0, 4)).toEqual(['--permission-mode', 'auto', '--effort', 'high']);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual(['--add-dir', inbox]);
    expect(argv.join(' ')).not.toMatch(/dangerously|bypass/i);
  });

  it('makes a second worker of the same project with one exclude entry and its own record', async () => {
    const clone = await startedNode();
    expect((await workerNew('alpha', '--project', 'web', '--yes')).code).toBe(0);
    await waitForLaunches(2);
    expect((await workerNew('beta', '--project', 'web', '--yes')).code).toBe(0);
    await waitForLaunches(3);
    expect(await outOf('session')).toBe('beta');
    for (const id of ['alpha', 'beta']) {
      expect((await stat(join(box.node, '.factory', 'workers', id, 'worker.json'))).isFile()).toBe(true);
    }
    const exclude = await readFile(join(clone, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === EXCLUDE_ENTRY)).toHaveLength(1);
    expect((await workerPanes()).map((line) => line.split(' ')[1]).sort()).toEqual(['', 'alpha', 'beta']);
  });

  it('makes eight workers in one window, because each launch tiles the window workers', async () => {
    await startedNode();
    // A fixed window size: an untiled window holds only a few panes, and how many depends on its size. At 200x50, the sixth split fails.
    expect((await tmux(['resize-window', '-t', '=demo:workers', '-x', '200', '-y', '50'])).code).toBe(0);
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
    for (const [index, id] of ids.entries()) {
      const made = await workerNew(id, '--project', 'web', '--yes');
      expect(made.code, `worker ${id}: ${made.stderr}`).toBe(0);
      await waitForLaunches(index + 2);
    }
    const marks = (await workerPanes()).map((line) => line.split(' ')[1]);
    expect(marks.sort()).toEqual(['', ...ids]);
  }, 120_000);

  it('exits 2 for a taken id and starts no second pane (TP-7)', async () => {
    await startedNode();
    expect((await workerNew('alpha', '--project', 'web', '--yes')).code).toBe(0);
    await waitForLaunches(2);
    const before = await workerPanes();
    const again = await workerNew('alpha', '--project', 'web', '--yes');
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('has a record already');
    expect(await workerPanes()).toEqual(before);
  });

  it('exits 2 for a project that the config does not list and makes nothing (TP-6)', async () => {
    await startedNode();
    const before = await treeOf(box.node);
    const result = await workerNew('alpha', '--project', 'nope', '--yes');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not listed');
    expect(await treeOf(box.node)).toEqual(before);
    expect(await workerPanes()).toHaveLength(1);
  });

  it('exits 2 with no terminal window and no yes flag, and writes nothing (TP-12)', async () => {
    await startedNode();
    const before = await treeOf(box.node);
    const result = await workerNew('alpha', '--project', 'web');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('This changes the settings of Claude Code in ');
    expect(result.stderr).toContain('factory worker new');
    expect(await treeOf(box.node)).toEqual(before);
    expect(await workerPanes()).toHaveLength(1);
  });

  it('exits 3 and names factory start when no session of the node runs', async () => {
    const source = await box.makeProject('web');
    await box.git(source, ['commit', '--allow-empty', '-q', '-m', 'first']);
    const init = await box.run(
      ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', source],
      { env: tmuxEnv },
    );
    expect(init.code).toBe(0);
    const result = await workerNew('alpha', '--project', 'web', '--yes');
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('"factory start"');
  });
});

/** The marks of the panes of one window, as `<worker>|<slot>|<summon>` lines. A mark that is not set is empty. */
const marksOf = async (window: string): Promise<string[]> =>
  (await tmux(['list-panes', '-t', `=demo:${window}`, '-F', '#{@worker}|#{@slot}|#{@slot_summon}'])).stdout
    .split('\n')
    .filter((line) => line !== '');

/** The pane of the coordinator: the pane of the window view that does not carry the board mark. */
const coordinatorPane = async (): Promise<string> => {
  const lines = (await tmux(['list-panes', '-t', '=demo:view', '-F', '#{pane_id} #{@slot}'])).stdout.split('\n');
  return lines.find((line) => line !== '' && !line.endsWith(' board'))?.split(' ')[0] ?? '';
};

/** The id of the active pane of a window: the pane that gets the keys of the person. */
const activePaneOf = async (window: string): Promise<string> => {
  const lines = (await tmux(['list-panes', '-t', `=demo:${window}`, '-F', '#{pane_id} #{pane_active}'])).stdout.split('\n');
  return lines.find((line) => line.endsWith(' 1'))?.split(' ')[0] ?? '';
};

const summon = (...extra: string[]): Promise<RunResult> =>
  box.run(['worker', 'summon', '--home', box.node, ...extra], { env: tmuxEnv });

const layout = (): Promise<RunResult> => box.run(['layout', '--home', box.node], { env: tmuxEnv });

const startedWorker = async (): Promise<void> => {
  await startedNode();
  expect((await workerNew('alpha', '--project', 'web', '--yes')).code).toBe(0);
  await waitForLaunches(2);
};

describe.skipIf(!hasTmux)('factory worker summon and factory layout (built binary, separate tmux server)', () => {
  it('shows the worker in the slot, and layout puts the board back (TP-31)', async () => {
    await startedWorker();
    expect(await marksOf('view')).toContain('|board|');

    const summoned = await summon('alpha', '--for', '30m');
    expect(summoned.code).toBe(0);
    expect(summoned.stdout).toContain('The worker alpha shows in the slot of the window view');
    expect(await marksOf('view')).toContain('alpha||');
    expect((await marksOf('view')).some((line) => line.includes('|board|'))).toBe(false);
    // The board waits in the window workers, and its summon mark holds the pane of the worker and a token of 32 hex characters.
    expect((await marksOf('workers')).some((line) => /^\|board\|%\d+:[0-9a-f]{32}$/.test(line))).toBe(true);

    const restored = await layout();
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('The board is in the slot of the window view again');
    expect(await marksOf('view')).toContain('|board|');
    expect(await marksOf('workers')).toContain('alpha||');
    expect((await marksOf('workers')).some((line) => line.includes('|board|'))).toBe(false);
  });

  it('keeps the focus on the coordinator pane after a summon, and after layout puts the board back', async () => {
    await startedWorker();
    const coordinator = await coordinatorPane();
    expect(coordinator).toMatch(/^%\d+$/);
    // The person works in the coordinator pane.
    expect((await tmux(['select-pane', '-t', coordinator])).code).toBe(0);
    expect(await activePaneOf('view')).toBe(coordinator);

    expect((await summon('alpha', '--for', '30m')).code).toBe(0);
    expect(await marksOf('view')).toContain('alpha||');
    expect(await activePaneOf('view')).toBe(coordinator);

    expect((await layout()).code).toBe(0);
    expect(await marksOf('view')).toContain('|board|');
    expect(await activePaneOf('view')).toBe(coordinator);
  });

  it('names a tmux command that brings the board back when the summoned pane is gone, and that command works', async () => {
    await startedWorker();
    expect((await summon('alpha', '--for', '30m')).code).toBe(0);
    const inView = (await tmux(['list-panes', '-t', '=demo:view', '-F', '#{pane_id} #{@worker}'])).stdout.split('\n');
    const worker = inView.find((line) => line.endsWith(' alpha'))?.split(' ')[0] ?? '';
    expect(worker).toMatch(/^%\d+$/);
    expect((await tmux(['kill-pane', '-t', worker])).code).toBe(0);

    const result = await layout();
    expect(result.code).toBe(0);
    const hint = /"(tmux join-pane [^"]+)"/.exec(result.stderr)?.[1];
    expect(hint).toBeDefined();
    expect((await marksOf('view')).some((line) => line.includes('|board|'))).toBe(false);

    // The command is the text of the hint as it stands: tmux joins the board pane to the window view again.
    const [, ...args] = (hint ?? '').split(' ');
    expect((await tmux(args)).code).toBe(0);
    expect(await marksOf('view')).toContain('|board|');
  });

  it('exits 2 for a time outside the bounds and moves no pane (TP-32)', async () => {
    await startedWorker();
    const before = await marksOf('view');
    const result = await summon('alpha', '--for', '3h');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--for');
    expect(await marksOf('view')).toEqual(before);
  });

  it('makes the window workers again on a session that has only the window view (TP-33)', async () => {
    await startedNode();
    expect((await tmux(['kill-window', '-t', '=demo:workers'])).code).toBe(0);
    const result = await layout();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Made the window workers.');
    const windows = (await tmux(['list-windows', '-t', '=demo', '-F', '#{window_name}'])).stdout.split('\n').filter((line) => line !== '');
    expect(windows.sort()).toEqual(['view', 'workers']);
  });

  it('exits 3 and names factory start when no tmux server runs (TP-127)', async () => {
    await startedWorker();
    await stopServer();
    const result = await summon('alpha');
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('"factory start"');
  });
});
