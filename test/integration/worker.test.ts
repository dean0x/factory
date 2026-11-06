import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookNames } from '../../src/names.js';
import { DIST, makeSandbox, removeOpenSandboxes, tmuxSocketOf, type RunResult, type Sandbox } from './harness.js';

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('worker.test.ts is skipped: tmux 3.0 or newer is not installed.');

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
const EXCLUDE_ENTRY = '/.claude/settings.local.json';
/** The matcher text of the group of the Notification event: the two types of notice that mean a dialog waits. It never lists idle_prompt. */
const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog';
/** A fake value for the one setting of the user that the launch keeps among the variables that start with CLAUDE. */
const FAKE_CONFIG_DIR = '/fake/claude-config';

let box: Sandbox;
let tmuxEnv: Record<string, string>;
let socket: string;
let outDir: string;

/**
 * The fake claude writes what the test needs to know, then sleeps. It writes the file `launches` last.
 * A launch with `--resume <id>` acts like the program: when the file `no-transcript` is in the folder, the session can not be
 * loaded, and the program ends at once with an error. Else the hook of the new session writes its SessionStart line.
 */
const fakeClaude = (dir: string): string =>
  [
    '#!/bin/sh',
    `dir='${dir}'`,
    'printf \'%s\\n\' "$@" > "$dir/argv"',
    'printf \'%s\' "$FACTORY_HOME" > "$dir/home"',
    'printf \'%s\' "$FACTORY_SESSION" > "$dir/session"',
    'printf \'%s\' "$FACTORY_INBOX" > "$dir/inbox"',
    'printf \'%s\' "${CLAUDE_FAKE_PARENT-unset}" > "$dir/parent-var"',
    'printf \'%s\' "${CLAUDECODE-unset}" > "$dir/claudecode-var"',
    'printf \'%s\' "${CLAUDE_CONFIG_DIR-unset}" > "$dir/config-dir"',
    'pwd -P > "$dir/cwd"',
    'resume=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--resume" ]; then resume="$arg"; fi',
    '  prev="$arg"',
    'done',
    'if [ -n "$resume" ] && [ -e "$dir/no-transcript" ]; then',
    '  echo "No conversation found with session ID: $resume" >&2',
    '  exit 1',
    'fi',
    'if [ -n "$resume" ]; then',
    `  printf '{"session_id":"%s","hook_event_name":"SessionStart"}' "$resume" | '${process.execPath}' '${DIST}' hook SessionStart`,
    'fi',
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
  // The tmux server gives its environment to a new pane, so these fake names are the ones that the launch must strip or keep.
  tmuxEnv = {
    ...box.env,
    SHELL: '/bin/sh',
    PATH: `${bin}:${box.env['PATH'] ?? ''}`,
    CLAUDE_FAKE_PARENT: '1',
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: FAKE_CONFIG_DIR,
  };
});

afterEach(async () => {
  try {
    if (hasTmux && tmuxEnv['TMUX_TMPDIR']?.startsWith(box.root) === true) await stopServer();
  } finally {
    await box.remove();
  }
});

afterAll(removeOpenSandboxes);

const ownGroup = (event: string): Record<string, unknown> => ({
  ...(event === 'Notification' ? { matcher: NOTIFICATION_MATCHER } : {}),
  hooks: [{ type: 'command', command: `factory hook ${event}` }],
});

/** The settings of Claude Code that the program writes into a session folder. The command texts are the contract. */
const ownSettings = (): Record<string, unknown> => ({
  hooks: Object.fromEntries(hookNames.events.map((event) => [event, [ownGroup(event)]])),
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

    // The server environment holds fake parent variables. The launch strips each CLAUDE name except the setting of the user.
    expect(await outOf('parent-var')).toBe('unset');
    expect(await outOf('claudecode-var')).toBe('unset');
    expect(await outOf('config-dir')).toBe(FAKE_CONFIG_DIR);
  });

  it('names the session of a new worker with the id of the node and the id of the worker (TP-12)', async () => {
    await startedNode();
    expect((await workerNew('alpha', '--project', 'web', '--yes')).code).toBe(0);
    await waitForLaunches(2);
    const argv = (await outOf('argv')).split('\n');
    expect(argv.filter((arg) => arg === '--name')).toHaveLength(1);
    expect(argv[argv.indexOf('--name') + 1]).toBe('demo-alpha');
    expect(argv.indexOf('--name')).toBeLessThan(argv.indexOf('--add-dir'));
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

// Each case launches several processes: 5 to 10 s alone, 14 to 24 s under load, so the 30 s global limit is too tight.
describe.skipIf(!hasTmux)('factory worker summon and factory layout (built binary, separate tmux server)', { timeout: 60_000 }, () => {
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

/** A session id of the program: a UUID with lower case letters. */
const SESSION = '5d8e2c1a-7f3b-4a96-8c4d-0e1f2a3b4c5d';

const stop = (...extra: string[]): Promise<RunResult> => box.run(['worker', 'stop', '--home', box.node, ...extra], { env: tmuxEnv });

const resume = (...extra: string[]): Promise<RunResult> => box.run(['worker', 'resume', '--home', box.node, ...extra], { env: tmuxEnv });

/** The SessionStart hook of the first session of alpha: it writes the pointer and the last-seen line, as the hook of the program does. */
const sessionStarted = (): Promise<RunResult> =>
  box.run(['hook', 'SessionStart'], {
    cwd: box.node,
    env: { FACTORY_HOME: box.node, FACTORY_SESSION: 'alpha' },
    input: JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart' }),
  });

/** The pane id and the process id of the live pane that carries the mark of a worker. */
const livePaneOf = async (id: string): Promise<{ readonly pane: string; readonly pid: number }> => {
  const lines = (await tmux(['list-panes', '-t', '=demo:workers', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{@worker}'])).stdout.split('\n');
  const [pane = '', pid = ''] = lines.find((line) => line.endsWith(` 0 ${id}`))?.split(' ') ?? [];
  return { pane, pid: Number(pid) };
};

/** The live panes that carry the mark of a worker. */
const livePanes = async (id: string): Promise<string[]> =>
  (await tmux(['list-panes', '-t', '=demo:workers', '-F', '#{pane_dead} #{@worker}'])).stdout.split('\n').filter((line) => line === `0 ${id}`);

/**
 * True while the process runs. The rule is the rule of the product (`isRunning`): `kill -0` must pass, and `ps` must not show
 * the state Z. On the Ubuntu runner the process of a closed pane can stay as a zombie that no one collects, and `kill -0` still
 * passes for a zombie. A `ps` that fails or prints an unclear state counts as alive, so the check never passes a live process.
 */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
  return !(ps.status === 0 && /^Z/.test(ps.stdout.trim()));
};

/**
 * The time limit of a case that stops a worker. The case makes a worker (about five seconds), and `worker stop` waits for the end of the
 * process for up to 30 seconds (`stopPoll`). `worker resume` waits for the new session for up to 10 seconds (`launchConfirm`). So the
 * limit of the suite (30 seconds) can not cover the bounded waits of one case.
 */
const STOP_CASE_MS = 120_000;

/** The programs that a worker pane can hold, with their parent and state: the facts that tell a live process from a zombie. */
const processFacts = (): string =>
  (spawnSync('ps', ['-eo', 'pid,ppid,stat,comm'], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter((line, index) => index === 0 || /\b(sleep|tmux|sh|dash|env|claude)\s*$/.test(line))
    .join('\n');

/** Stops the worker alpha, and requires exit 0. The message holds the text of stderr and, for a failure, the processes and the panes. */
const stoppedAlpha = async (): Promise<RunResult> => {
  const stopped = await stop('alpha');
  if (stopped.code !== 0) {
    const panes = (await tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{pane_dead} #{@worker}'])).stdout;
    expect(stopped.code, `${stopped.stderr}\npanes:\n${panes}\nprocesses:\n${processFacts()}`).toBe(0);
  }
  return stopped;
};

describe.skipIf(!hasTmux)('factory worker stop and factory worker resume (built binary, separate tmux server)', () => {
  it('ends the program of the pane of the worker, closes the pane, and leaves no process of that pane (TP-26)', async () => {
    await startedWorker();
    expect((await sessionStarted()).code).toBe(0);
    const { pane, pid } = await livePaneOf('alpha');
    expect(pane).toMatch(/^%\d+$/);
    expect(pid).toBeGreaterThan(1);
    expect(isAlive(pid)).toBe(true);

    const stopped = await stoppedAlpha();
    expect(stopped.stdout).toContain('Stopped the worker alpha.');
    expect(stopped.stdout).toContain(`The process ${pid} of the pane ${pane} ended after kill -TERM. The session was idle.`);
    expect((await workerPanes()).filter((line) => line.endsWith(' alpha'))).toEqual([]);
    for (let step = 0; step < STOP_STEPS && isAlive(pid); step += 1) await sleep(POLL_STEP_MS);
    expect(isAlive(pid)).toBe(false);
  }, STOP_CASE_MS);

  it('resumes a stopped worker with the session of its pointer, and says Resumed after the hook of the new session wrote its line', async () => {
    await startedWorker();
    expect((await sessionStarted()).code).toBe(0);
    await stoppedAlpha();

    const resumed = await resume('alpha');
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('Resumed the worker alpha');
    const argv = (await outOf('argv')).split('\n');
    expect(argv[argv.indexOf('--resume') + 1]).toBe(SESSION);
    const line = JSON.parse(await readFile(join(box.node, '.factory', 'state', 'heartbeat', SESSION), 'utf8')) as Record<string, unknown>;
    expect(line).toMatchObject({ event: 'SessionStart', session_marker: 'alpha' });
    expect(await livePanes('alpha')).toHaveLength(1);
  }, STOP_CASE_MS);

  it('exits 1 for a session that can not be loaded, names the pointer file, and the delete of that file starts a new conversation', async () => {
    await startedWorker();
    expect((await sessionStarted()).code).toBe(0);
    await stoppedAlpha();
    await writeFile(join(outDir, 'no-transcript'), '');

    const failed = await resume('alpha');
    expect(failed.code, failed.stderr).toBe(1);
    expect(failed.stdout).not.toContain('Resumed');
    expect(failed.stderr).toContain('resume failed');
    const pointer = join(box.node, '.factory', 'workers', 'alpha', 'last-session');
    expect(failed.stderr).toContain(pointer);
    expect(await livePanes('alpha')).toEqual([]);

    await unlink(pointer);
    const again = await resume('alpha');
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('Started the worker alpha again');
    expect(await livePanes('alpha')).toHaveLength(1);
  }, STOP_CASE_MS);
});
