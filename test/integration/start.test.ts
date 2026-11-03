import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, removeOpenSandboxes, tmuxSocketOf, type RunResult, type Sandbox } from './harness.js';

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('start.test.ts is skipped: tmux 3.0 or newer is not installed.');

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
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

/** Wait until a program of the test has written a file into the output folder. The wait has an upper bound. */
const waitForFile = async (name: string): Promise<string> => {
  for (let step = 0; step < POLL_STEPS; step += 1) {
    const text = await readFile(join(outDir, name), 'utf8').catch(() => '');
    if (text !== '') return text;
    await sleep(POLL_STEP_MS);
  }
  throw new Error(`the file ${name} did not appear`);
};

/** Wait for the file of the fake claude. */
const waitForLaunch = async (): Promise<string[]> => (await waitForFile('launches')).trim().split('\n');

/** A program that writes whether its environment holds the proxy variable. A new window of the session runs it. */
const probeProxy = (dir: string): string =>
  [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ -n "${ANTHROPIC_BASE_URL+x}" ]; then echo yes > "$dir/window-proxy"; else echo no > "$dir/window-proxy"; fi',
    '',
  ].join('\n');

/** A script that writes the value of the session marker of its own environment to a file. */
const probeMarker = (dir: string): string =>
  ['#!/bin/sh', `dir='${dir}'`, 'echo "${FACTORY_SESSION-unset}" > "$dir/window-marker"', ''].join('\n');

/** The panes of the session with their ids and process ids. A pane that starts or ends changes the text. */
const paneSnapshot = async (): Promise<string> =>
  (await tmux(['list-panes', '-s', '-t', '=demo', '-F', '#{window_name} #{pane_id} #{pane_pid} #{pane_dead}'])).stdout;

const startFactory = (...extra: string[]): Promise<RunResult> =>
  box.run(['start', '--home', box.node, ...extra], { env: tmuxEnv });

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
  tmuxEnv = {
    ...box.env,
    // The slot pane runs this shell. A plain shell writes no history file into the folder that the test removes.
    SHELL: '/bin/sh',
    PATH: `${bin}:${box.env['PATH'] ?? ''}`,
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

/** Make the node with the clones of two work trees. The result is the folders of the clones in the root. */
const initNode = async (): Promise<string[]> => {
  const web = await box.makeProject('web');
  const api = await box.makeProject('api');
  const result = await box.run(
    ['init', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', web, '--project', api],
    { env: tmuxEnv },
  );
  expect(result.code).toBe(0);
  return [join(box.node, 'web'), join(box.node, 'api')];
};

describe.skipIf(!hasTmux)('factory start (built binary, separate tmux server)', () => {
  it('starts the session with the view and bench windows and one launch of claude in auto mode', async () => {
    const [web, api] = await initNode();
    const result = await startFactory();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Session demo runs. Attach with: tmux attach -t demo');

    expect(await waitForLaunch()).toEqual(['launched']);
    // The launch is the start command of the first pane only. The slot pane and the bench window run the shell.
    const starts = await tmux(['list-panes', '-s', '-t', '=demo', '-F', '#{pane_start_command}']);
    expect(starts.stdout.trim().split('\n').filter((command) => command.includes('claude'))).toHaveLength(1);
    expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    const windows = await tmux(['list-windows', '-t', '=demo', '-F', '#{window_name}']);
    expect(windows.stdout.trim().split('\n')).toEqual(['view', 'bench']);

    const argv = (await readFile(join(outDir, 'argv'), 'utf8')).trim().split('\n');
    expect(argv.slice(0, 4)).toEqual(['--permission-mode', 'auto', '--effort', 'high']);
    expect(argv.filter((arg) => arg === '--add-dir')).toHaveLength(3);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual([
      '--add-dir',
      join(box.node, '.factory'),
      '--add-dir',
      web,
      '--add-dir',
      api,
    ]);
    expect(argv).not.toContain(box.node);
    expect(argv.join(' ')).not.toMatch(/dangerously|bypass/i);
    expect(await readFile(join(outDir, 'home'), 'utf8')).toBe(box.node);
    expect(await readFile(join(outDir, 'session'), 'utf8')).toBe('demo');
  });

  it('starts the coordinator in the coordinator folder, and keeps the top of the factory folder as the home (TP-46)', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    expect((await readFile(join(outDir, 'cwd'), 'utf8')).trim()).toBe(await realpath(join(box.node, 'coordinator')));
    expect(await readFile(join(outDir, 'home'), 'utf8')).toBe(box.node);
    const paths = await tmux(['list-panes', '-s', '-t', '=demo', '-F', '#{pane_current_path}']);
    const folder = await realpath(join(box.node, 'coordinator'));
    expect(paths.stdout.trim().split('\n')).toEqual([folder, folder, folder]);
  });

  it('exits 1 and starts no session when the coordinator folder is missing, because tmux would use another folder', async () => {
    await initNode();
    await rm(join(box.node, 'coordinator'), { recursive: true });
    const result = await startFactory();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the coordinator folder coordinator is missing');
    expect(result.stderr).toContain('factory upgrade --overwrite coordinator --overwrite safety');
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);
  });

  it('exits 2, names init and starts no session when factory.yaml has no factory.local.yaml next to it', async () => {
    await initNode();
    await rm(join(box.node, 'factory.local.yaml'));
    const result = await startFactory();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('factory.local.yaml not found');
    expect(result.stderr).toContain('factory init');
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
  });

  it('exits 4 for a local file that others can write, changes no mode and starts no session', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o664);
    const result = await startFactory();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('chmod 600 factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o664);
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
  });

  it('sets a local file that others can read back to mode 600, prints a notice and starts the session', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o644);
    const result = await startFactory();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await waitForLaunch();
  });

  it('passes a project folder that ends in a semicolon to claude as one value', async () => {
    const odd = await box.makeProject('odd;');
    const init = await box.run(
      ['init', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', odd],
      { env: tmuxEnv },
    );
    expect(init.code).toBe(0);
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    const argv = (await readFile(join(outDir, 'argv'), 'utf8')).trim().split('\n');
    expect(odd).not.toContain(box.node);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual([
      '--add-dir',
      join(box.node, '.factory'),
      '--add-dir',
      join(box.node, 'odd;'),
    ]);
  });

  it('clears a proxy variable that the shell holds', async () => {
    await initNode();
    expect(tmuxEnv['ANTHROPIC_BASE_URL']).toBe(LAUNCH_PROXY_URL);
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    expect((await readFile(join(outDir, 'proxy'), 'utf8')).trim()).toBe('no');
  });

  it('removes the proxy variable from the environment of the session, so a later window gets none', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();

    const environment = await tmux(['show-environment', '-t', '=demo', 'ANTHROPIC_BASE_URL']);
    expect(environment.stdout.trim()).toBe('-ANTHROPIC_BASE_URL');

    const probe = join(box.root, 'bin', 'probe-proxy');
    await writeFile(probe, probeProxy(outDir));
    await chmod(probe, 0o755);
    expect((await tmux(['new-window', '-d', '-t', '=demo:', '-n', 'probe', probe])).code).toBe(0);
    expect((await waitForFile('window-proxy')).trim()).toBe('no');
  });

  it('puts the session marker in the environment of the session, so a later window carries it (TP-80)', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();

    const environment = await tmux(['show-environment', '-t', '=demo', 'FACTORY_SESSION']);
    expect(environment.stdout.trim()).toBe('FACTORY_SESSION=demo');

    const probe = join(box.root, 'bin', 'probe-marker');
    await writeFile(probe, probeMarker(outDir));
    await chmod(probe, 0o755);
    expect((await tmux(['new-window', '-d', '-t', '=demo:', '-n', 'probe', probe])).code).toBe(0);
    expect((await waitForFile('window-marker')).trim()).toBe('demo');
  });

  it('marks the session and the panes with the options of factory', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    const home = await tmux(['show-options', '-v', '-t', '=demo:', '@factory_home']);
    expect(home.stdout.trim()).toBe(box.node);
    const panes = await tmux(['list-panes', '-t', '=demo:view', '-F', '#{@node}|#{@slot}']);
    expect(panes.stdout.trim().split('\n')).toEqual(['demo|', '|board']);
  });

  it('keeps the coordinator pane when its program ends', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    const kept = await tmux(['show-options', '-w', '-v', '-t', '=demo:view', 'remain-on-exit']);
    expect(kept.stdout.trim()).toBe('on');
  });

  it('starts one launch after two runs, and the second run starts nothing', async () => {
    await initNode();
    const first = await startFactory('--json');
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ started: true });
    expect(await waitForLaunch()).toHaveLength(1);
    const before = await paneSnapshot();
    // The coordinator and the slot in the view window, and the bench window.
    expect(before.trim().split('\n')).toHaveLength(3);

    const again = await startFactory('--json');
    expect(again.code).toBe(0);
    const report: unknown = JSON.parse(again.stdout);
    expect(report).toMatchObject({ session: 'demo', started: false });
    expect(report).not.toHaveProperty('coordinatorEnded');
    expect(await paneSnapshot()).toEqual(before);
    const sessions = await tmux(['list-sessions', '-F', '#{session_name}']);
    expect(sessions.stdout.trim().split('\n')).toEqual(['demo']);
  });

  it('refuses a session of another home with exit code 4', async () => {
    await initNode();
    expect((await tmux(['new-session', '-d', '-s', 'demo', 'sleep', '300'])).code).toBe(0);
    const result = await startFactory();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('a tmux session demo belongs to another node home');
  });

  it('exits 4 in a project clone that holds its own config with a proxy entry, and starts nothing (TP-16)', async () => {
    const [web] = await initNode();
    const clone = web ?? '';
    await writeFile(join(clone, 'factory.yaml'), await box.read(join(box.node, 'factory.yaml')));
    const local = await box.read(join(box.node, 'factory.local.yaml'));
    expect(local).toContain('proxies: []');
    await writeFile(
      join(clone, 'factory.local.yaml'),
      local.replace('proxies: []', 'proxies:\n  - id: local\n    base_url: "http://127.0.0.1:9"\n    health: /health\n    on_fail: stop'),
    );

    for (const extra of [[], ['--dry-run']]) {
      const result = await box.run(['start', ...extra], { cwd: clone, env: tmuxEnv });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain(`${join(clone, 'factory.yaml')} does not count`);
      expect(result.stderr).toContain('name it with --home');
      expect(result.stdout).not.toContain('127.0.0.1');
    }
    expect((await tmux(['list-sessions'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);
  });

  it('runs --dry-run with exit 0 from the root, the coordinator folder and a project clone (TP-14)', async () => {
    const [web] = await initNode();
    for (const cwd of [box.node, join(box.node, 'coordinator'), web ?? '']) {
      const result = await box.run(['start', '--dry-run'], { cwd, env: tmuxEnv });
      expect({ cwd, code: result.code, stderr: result.stderr }).toEqual({ cwd, code: 0, stderr: '' });
      expect(result.stdout).toContain('Dry run');
    }
    expect(existsSync(socket)).toBe(false);
  });

  it('shows the calls for --dry-run, starts no session and no claude', async () => {
    await initNode();
    const result = await startFactory('--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(result.stdout).toContain('tmux new-session -d -s demo -n view');
    expect((await tmux(['has-session', '-t', '=demo'])).code).not.toBe(0);
    // A claude runs only in a pane of a session, and a session needs a server. A server makes its socket when it starts.
    expect((await tmux(['list-sessions'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);
  });
});
