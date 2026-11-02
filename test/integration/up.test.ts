import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('up.test.ts is skipped: tmux 3.0 or newer is not installed.');

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
const NO_NEW_LAUNCH_WAIT_MS = 600;
const LAUNCH_PROXY_URL = 'http://127.0.0.1:9';

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
    'if [ -n "${ANTHROPIC_BASE_URL+x}" ]; then echo yes > "$dir/proxy"; else echo no > "$dir/proxy"; fi',
    'printf \'%s\' "$FACTORY_HOME" > "$dir/home"',
    'printf \'%s\' "$FACTORY_SESSION" > "$dir/session"',
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

/** Wait for the file of the fake claude. The wait has an upper bound. */
const waitForLaunch = async (): Promise<string[]> => {
  for (let step = 0; step < POLL_STEPS; step += 1) {
    const text = await readFile(join(outDir, 'launches'), 'utf8').catch(() => '');
    if (text !== '') return text.trim().split('\n');
    await sleep(POLL_STEP_MS);
  }
  throw new Error('the fake claude did not start');
};

const up = (...extra: string[]): Promise<RunResult> =>
  box.run(['up', '--home', box.node, ...extra], { env: tmuxEnv });

beforeEach(async () => {
  box = await makeSandbox();
  outDir = join(box.root, 'out');
  const bin = join(box.root, 'bin');
  await mkdir(outDir, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), fakeClaude(outDir));
  await chmod(join(bin, 'claude'), 0o755);

  // A separate tmux server: its socket is below TMUX_TMPDIR, and the environment has no TMUX.
  const tmuxDir = join(box.root, 'tmux');
  await mkdir(tmuxDir, { recursive: true });
  socket = join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default');
  tmuxEnv = {
    ...box.env,
    // The slot pane runs this shell. A plain shell writes no history file into the folder that the test removes.
    SHELL: '/bin/sh',
    PATH: `${bin}:${box.env['PATH'] ?? ''}`,
    TMUX_TMPDIR: tmuxDir,
    ANTHROPIC_BASE_URL: LAUNCH_PROXY_URL,
  };
});

/** Stops the tmux server of this test, then waits until its socket no longer answers. The wait has an upper bound. */
const stopServer = async (): Promise<void> => {
  await tmux(['-S', socket, 'kill-server']);
  for (let step = 0; step < STOP_STEPS; step += 1) {
    if ((await tmux(['-S', socket, 'list-sessions'])).code !== 0) return;
    await sleep(POLL_STEP_MS);
  }
};

afterEach(async () => {
  try {
    // Stop the server of this test only: both the folder and the socket name this server.
    if (hasTmux && tmuxEnv['TMUX_TMPDIR']?.startsWith(box.root) === true) await stopServer();
  } finally {
    // The sandbox folder holds the home of the test and the TMUX_TMPDIR folder, so one removal clears both.
    // It runs also when the stop of the server fails.
    await box.remove();
  }
});

afterAll(removeOpenSandboxes);

const initNode = async (): Promise<string[]> => {
  const web = await box.makeProject('web');
  const api = await box.makeProject('api');
  const result = await box.run(
    ['init', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', web, '--project', api],
    { env: tmuxEnv },
  );
  expect(result.code).toBe(0);
  return [web, api];
};

describe.skipIf(!hasTmux)('factory up (built binary, separate tmux server)', () => {
  it('starts the session with the view and bench windows and one launch of claude in auto mode', async () => {
    const [web, api] = await initNode();
    const result = await up();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Session demo runs. Attach with: tmux attach -t demo');

    expect(await waitForLaunch()).toEqual(['launched']);
    expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    const windows = await tmux(['list-windows', '-t', '=demo', '-F', '#{window_name}']);
    expect(windows.stdout.trim().split('\n')).toEqual(['view', 'bench']);

    const argv = (await readFile(join(outDir, 'argv'), 'utf8')).trim().split('\n');
    expect(argv.slice(0, 4)).toEqual(['--permission-mode', 'auto', '--effort', 'high']);
    expect(argv.filter((arg) => arg === '--add-dir')).toHaveLength(2);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual(['--add-dir', web, '--add-dir', api]);
    expect(argv.join(' ')).not.toMatch(/dangerously|bypass/i);
    expect(await readFile(join(outDir, 'home'), 'utf8')).toBe(box.node);
    expect(await readFile(join(outDir, 'session'), 'utf8')).toBe('demo');
  });

  it('clears a proxy variable that the shell holds', async () => {
    await initNode();
    expect(tmuxEnv['ANTHROPIC_BASE_URL']).toBe(LAUNCH_PROXY_URL);
    expect((await up()).code).toBe(0);
    await waitForLaunch();
    expect((await readFile(join(outDir, 'proxy'), 'utf8')).trim()).toBe('no');
  });

  it('marks the session and the panes with the options of factory', async () => {
    await initNode();
    expect((await up()).code).toBe(0);
    await waitForLaunch();
    const home = await tmux(['show-options', '-v', '-t', '=demo:', '@factory_home']);
    expect(home.stdout.trim()).toBe(box.node);
    const panes = await tmux(['list-panes', '-t', '=demo:view', '-F', '#{@node}|#{@slot}']);
    expect(panes.stdout.trim().split('\n')).toEqual(['demo|', '|board']);
  });

  it('keeps the coordinator pane when its program ends', async () => {
    await initNode();
    expect((await up()).code).toBe(0);
    await waitForLaunch();
    const kept = await tmux(['show-options', '-w', '-v', '-t', '=demo:view', 'remain-on-exit']);
    expect(kept.stdout.trim()).toBe('on');
  });

  it('starts one launch after two runs, and the second run starts nothing', async () => {
    await initNode();
    expect((await up()).code).toBe(0);
    expect(await waitForLaunch()).toHaveLength(1);

    const again = await up();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Session demo runs. Attach with: tmux attach -t demo');
    await sleep(NO_NEW_LAUNCH_WAIT_MS);
    expect(await waitForLaunch()).toHaveLength(1);
    const sessions = await tmux(['list-sessions', '-F', '#{session_name}']);
    expect(sessions.stdout.trim().split('\n')).toEqual(['demo']);
  });

  it('refuses a session of another home with exit code 4', async () => {
    await initNode();
    expect((await tmux(['new-session', '-d', '-s', 'demo', 'sleep', '300'])).code).toBe(0);
    const result = await up();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('a tmux session demo belongs to another node home');
  });

  it('shows the calls for --dry-run, starts no session and no claude', async () => {
    await initNode();
    const result = await up('--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('tmux new-session -d -s demo -n view');
    expect((await tmux(['has-session', '-t', '=demo'])).code).not.toBe(0);
    await sleep(NO_NEW_LAUNCH_WAIT_MS);
    expect(await readFile(join(outDir, 'launches'), 'utf8').catch(() => 'none')).toBe('none');
  });
});
