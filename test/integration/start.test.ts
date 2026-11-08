import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookNames } from '../../src/names.js';
import { DIST, makeSandbox, removeOpenSandboxes, tmuxSocketOf, withoutHookNotice, type RunResult, type Sandbox } from './harness.js';
import { expectLaunchRule } from './lifecycle-lab.js';

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('start.test.ts is skipped: tmux 3.0 or newer is not installed.');

const POLL_STEP_MS = 100;
const POLL_STEPS = 100;
const STOP_STEPS = 30;
const LAUNCH_PROXY_URL = 'http://127.0.0.1:9';
/** A fake value for the one setting of the user that the launch keeps among the variables that start with CLAUDE. */
const FAKE_CONFIG_DIR = '/fake/claude-config';

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
    'printf \'%s\' "${CLAUDE_FAKE_PARENT-unset}" > "$dir/parent-var"',
    'printf \'%s\' "${CLAUDECODE-unset}" > "$dir/claudecode-var"',
    'printf \'%s\' "${CLAUDE_CONFIG_DIR-unset}" > "$dir/config-dir"',
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
    // The tmux server gives its environment to a new pane, so these fake names are the ones that the launch must strip or keep.
    CLAUDE_FAKE_PARENT: '1',
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: FAKE_CONFIG_DIR,
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

/** The matcher text of the group of the Notification event: the two types of notice that mean a dialog waits. It never lists idle_prompt. */
const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog';

const ownGroup = (event: string): Record<string, unknown> => ({
  ...(event === 'Notification' ? { matcher: NOTIFICATION_MATCHER } : {}),
  hooks: [{ type: 'command', command: `factory hook ${event}` }],
});

/** The settings of Claude Code that the program writes into the coordinator folder. The command texts are the contract. */
const ownSettings = (): Record<string, unknown> => ({
  hooks: Object.fromEntries(hookNames.events.map((event) => [event, [ownGroup(event)]])),
  statusLine: { type: 'command', command: 'factory hook statusline' },
});

const settingsFileOf = (): string => join(box.node, 'coordinator', '.claude', 'settings.local.json');

/** The status line input of the fixture (built from the field names of the status line docs; the values are made up). */
const STATUS_PAYLOAD = (
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
    readonly statusline: { readonly payload: Readonly<Record<string, unknown>> };
  }
).statusline.payload;

/**
 * Make the node with the clones of two work trees. The result is the folders of the clones in the root. `init --yes`
 * writes the settings of Claude Code with the own entries into the coordinator folder, so that `start` asks nothing. With
 * `hookSettings: false` the test removes that settings folder again.
 */
const initNode = async ({ hookSettings = true }: { hookSettings?: boolean } = {}): Promise<string[]> => {
  const web = await box.makeProject('web');
  const api = await box.makeProject('api');
  const result = await box.run(
    ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', web, '--project', api],
    { env: tmuxEnv },
  );
  expect(result.code).toBe(0);
  if (!hookSettings) await rm(join(box.node, 'coordinator', '.claude'), { recursive: true, force: true });
  return [join(box.node, 'web'), join(box.node, 'api')];
};

/** Every path below a folder, as relative paths. */
const treeOf = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true })).sort();

describe.skipIf(!hasTmux)('factory start (built binary, separate tmux server)', () => {
  it('prints the warning about an instruction file above the root on stderr, and still exits 0 (TP-33)', async () => {
    await initNode();
    const above = join(box.root, 'GEMINI.md');
    await writeFile(above, 'x\n');
    const result = await startFactory('--dry-run');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('warning: Agent instruction files are in the factory folder or above it: ');
    expect(result.stderr).toContain(above);
  });

  it('starts the session with the view and workers windows and one launch of claude in auto mode', async () => {
    const [web, api] = await initNode();
    const result = await startFactory();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Session demo runs. Attach with: tmux attach -t demo');

    expect(await waitForLaunch()).toEqual(['launched']);
    // The launch is the start command of the first pane only. The slot pane and the workers window run the shell.
    const starts = await tmux(['list-panes', '-s', '-t', '=demo', '-F', '#{pane_start_command}']);
    expect(starts.stdout.trim().split('\n').filter((command) => command.includes('claude'))).toHaveLength(1);
    expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    const windows = await tmux(['list-windows', '-t', '=demo', '-F', '#{window_name}']);
    expect(windows.stdout.trim().split('\n')).toEqual(['view', 'workers']);

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
    // The server environment holds fake parent variables. The launch strips each CLAUDE name except the setting of the user.
    expect(await readFile(join(outDir, 'parent-var'), 'utf8')).toBe('unset');
    expect(await readFile(join(outDir, 'claudecode-var'), 'utf8')).toBe('unset');
    expect(await readFile(join(outDir, 'config-dir'), 'utf8')).toBe(FAKE_CONFIG_DIR);
  });

  it('warns for a project folder that is missing and adds no --add-dir for it (TP-120)', async () => {
    await initNode();
    const web = join(box.node, 'web');
    const api = join(box.node, 'api');
    await rm(api, { recursive: true, force: true });
    const result = await startFactory();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(api);
    expect(result.stderr).toContain('missing');
    await waitForLaunch();
    const argv = (await readFile(join(outDir, 'argv'), 'utf8')).trim().split('\n');
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual(['--add-dir', join(box.node, '.factory'), '--add-dir', web]);
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

  it('exits 4 and starts no session when the coordinator folder is missing, because the safety block is missing (TP-43)', async () => {
    await initNode();
    await rm(join(box.node, 'coordinator'), { recursive: true });
    const result = await startFactory();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('the block safety is missing in coordinator/CLAUDE.md');
    expect(result.stderr).toContain('factory upgrade --overwrite safety');
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);
  });

  it('exits 4 for an edited safety block, and goes on after upgrade --overwrite safety kept the old text in a backup file (TP-43, TP-107)', async () => {
    await initNode();
    const path = join(box.node, 'coordinator', 'CLAUDE.md');
    const text = await readFile(path, 'utf8');
    const at = text.indexOf('<!-- factory:begin safety');
    expect(at).toBeGreaterThan(-1);
    const edited = `${text.slice(0, at)}${text.slice(at).replace('Never skip permissions', 'Skip permissions')}`;
    expect(edited).not.toBe(text);
    await writeFile(path, edited);

    const stopped = await startFactory();
    expect(stopped.code).toBe(4);
    expect(stopped.stderr).toContain('factory upgrade --overwrite safety');
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);

    const upgraded = await box.run(['upgrade', '--home', box.node, '--overwrite', 'safety']);
    expect(upgraded.code).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(text);
    const saved = (await readdir(join(box.node, '.factory', 'backups'))).filter((name) => name.endsWith('-block-safety.md'));
    expect(saved).toHaveLength(1);
    expect(upgraded.stdout).toContain(`Kept the old text of block safety in .factory/backups/${saved[0]}.`);
    expect(await readFile(join(box.node, '.factory', 'backups', saved[0] ?? '?'), 'utf8')).toContain('Skip permissions');

    const started = await startFactory();
    expect(started.code).toBe(0);
    expect(await waitForLaunch()).toEqual(['launched']);
  });

  it('renders an intact safety block again with a notice on stderr when the prefix changed, and goes on (TP-125)', async () => {
    await initNode();
    const local = join(box.node, 'factory.local.yaml');
    const before = await readFile(local, 'utf8');
    expect(before).toContain('typed by');
    await writeFile(local, before.replace('typed by', 'sent by'));
    const result = await startFactory();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Rendered the block safety in coordinator/CLAUDE.md again');
    expect(await readFile(join(box.node, 'coordinator', 'CLAUDE.md'), 'utf8')).toContain('sent by');
    expect(await waitForLaunch()).toEqual(['launched']);
  });

  it('exits 4 for a link at coordinator/CLAUDE.md, and starts no session (TP-131)', async () => {
    await initNode();
    const path = join(box.node, 'coordinator', 'CLAUDE.md');
    const text = await readFile(path, 'utf8');
    const elsewhere = join(box.root, 'elsewhere.md');
    await writeFile(elsewhere, text);
    await rm(path);
    await symlink(elsewhere, path);
    const result = await startFactory();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('coordinator/CLAUDE.md is a link');
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
    expect(await readFile(elsewhere, 'utf8')).toBe(text);
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
      ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', odd],
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
    // The coordinator and the slot in the view window, and the workers window.
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

  it('refuses a session of another home with exit code 4, and the remedy names factory shutdown (TP-132)', async () => {
    await initNode();
    expect((await tmux(['new-session', '-d', '-s', 'demo', 'sleep', '300'])).code).toBe(0);
    const result = await startFactory();
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('a tmux session demo belongs to another factory folder');
    expect(result.stderr).toContain('factory shutdown');
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

  it('works for a node home under a linked parent folder, and stops only for a link below the home (TP-149)', async () => {
    const real = join(box.root, 'real-parent');
    const linked = join(box.root, 'linked-parent');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);
    const home = join(linked, 'factory');
    const init = await box.run(['init', '--yes', '--home', home, '--name', 'demo', '--owner-name', 'Test Owner'], { env: tmuxEnv });
    expect({ code: init.code, stderr: withoutHookNotice(init.stderr) }).toEqual({ code: 0, stderr: '' });

    const byFlag = await box.run(['start', '--dry-run', '--home', home], { env: tmuxEnv });
    expect({ code: byFlag.code, stderr: byFlag.stderr }).toEqual({ code: 0, stderr: '' });
    expect(byFlag.stdout).toContain('Dry run');
    const fromInside = await box.run(['start', '--dry-run'], { cwd: join(home, 'coordinator'), env: tmuxEnv });
    expect({ code: fromInside.code, stderr: fromInside.stderr }).toEqual({ code: 0, stderr: '' });

    const claude = join(real, 'factory', 'coordinator', 'CLAUDE.md');
    const outside = join(box.root, 'outside-claude.md');
    await writeFile(outside, await readFile(claude, 'utf8'));
    await rm(claude);
    await symlink(outside, claude);
    const stopped = await box.run(['start', '--dry-run', '--home', home], { env: tmuxEnv });
    expect(stopped.code).toBe(4);
    expect(stopped.stderr).toContain('coordinator/CLAUDE.md is a link');
    expect(existsSync(socket)).toBe(false);
  });
});

describe.skipIf(!hasTmux)('factory start: the hook settings of the coordinator (built binary, AC-6, TP-16, TP-17, TP-18, TP-19)', () => {
  const noSession = async (): Promise<void> => {
    expect((await tmux(['-S', socket, 'has-session', '-t', '=demo'])).code).not.toBe(0);
    expect(existsSync(socket)).toBe(false);
  };

  it('exits 2 with no terminal and no --yes, names the change and the target, and writes and starts nothing (TP-16)', async () => {
    await initNode({ hookSettings: false });
    const before = await treeOf(box.node);
    const result = await startFactory();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(settingsFileOf());
    expect(result.stderr).toContain('factory hook Stop');
    expect(result.stderr).toContain('factory hook statusline');
    expect(result.stderr).toContain('--yes');
    expect(await treeOf(box.node)).toEqual(before);
    await noSession();
  });

  it('writes only the settings file of the coordinator with --yes, and leaves the Claude folder of the test home as it was (TP-17)', async () => {
    await initNode({ hookSettings: false });
    const userClaude = join(box.env['HOME'] ?? '', '.claude');
    await mkdir(userClaude, { recursive: true });
    await writeFile(join(userClaude, 'settings.json'), '{"model":"sonnet"}\n');
    const userBefore = await treeOf(userClaude);
    const before = await treeOf(box.node);

    const result = await startFactory('--yes');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(settingsFileOf());
    expect(result.stderr).toContain('factory hook SessionStart');
    expect(await waitForLaunch()).toEqual(['launched']);

    expect(JSON.parse(await readFile(settingsFileOf(), 'utf8'))).toEqual(ownSettings());
    expect((await stat(settingsFileOf())).mode & 0o777).toBe(0o600);
    const added = (await treeOf(box.node)).filter((path) => !before.includes(path));
    // The start of a new session also writes the machine id and commits the mark of the active machine in the state folder.
    const outsideState = added.filter((path) => path !== '.factory' && !path.startsWith('.factory/'));
    expect(outsideState).toEqual(['coordinator/.claude', 'coordinator/.claude/settings.local.json']);
    expect(added).toContain('.factory/active-machine.json');
    expect(added).toContain('.factory/state/machine-id');
    expect(await treeOf(userClaude)).toEqual(userBefore);
    expect(await readFile(join(userClaude, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}\n');
  });

  it('keeps the other keys of the settings file with --yes (TP-17)', async () => {
    await initNode({ hookSettings: false });
    await mkdir(join(box.node, 'coordinator', '.claude'), { recursive: true });
    await writeFile(settingsFileOf(), '{"model":"opus"}\n');
    const result = await startFactory('--yes');
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(settingsFileOf(), 'utf8'))).toEqual({ model: 'opus', ...ownSettings() });
    await waitForLaunch();
  });

  it('asks nothing, writes nothing and shows no presence warning on the second start (TP-18, AC-11)', async () => {
    await initNode({ hookSettings: false });
    expect((await startFactory('--yes')).code).toBe(0);
    await waitForLaunch();
    const written = await readFile(settingsFileOf(), 'utf8');
    const before = await treeOf(box.node);

    const again = await startFactory();
    expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: '' });
    expect(await readFile(settingsFileOf(), 'utf8')).toBe(written);
    expect(await treeOf(box.node)).toEqual(before);
  });

  it('exits 2 with --yes inside a factory session, and writes and starts nothing (TP-19)', async () => {
    await initNode({ hookSettings: false });
    const before = await treeOf(box.node);
    const result = await box.run(['start', '--home', box.node, '--yes'], { env: { ...tmuxEnv, FACTORY_SESSION: 'demo' } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(settingsFileOf());
    expect(await treeOf(box.node)).toEqual(before);
    await noSession();
  });

  it('shows the change with --dry-run, exits 0, and writes and starts nothing', async () => {
    await initNode({ hookSettings: false });
    const before = await treeOf(box.node);
    const result = await startFactory('--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(settingsFileOf());
    expect(result.stdout).toContain('factory hook Stop');
    expect(result.stdout).toContain('A real run asks before it writes this change.');
    expect(await treeOf(box.node)).toEqual(before);
    expect(existsSync(socket)).toBe(false);
  });

  /** Set the status line command of the owner in the private config of the node. The file keeps its mode. */
  const setOwnerStatusline = async (command: string): Promise<void> => {
    const path = join(box.node, 'factory.local.yaml');
    const text = await readFile(path, 'utf8');
    expect(text).toContain('statusline: null');
    // A function gives the text as it is: a string would read `$$` and `$&` in the command as patterns.
    await writeFile(path, text.replace('statusline: null', () => `statusline: ${JSON.stringify(command)}`));
  };

  it('writes only the own entries with --yes when the owner names a status line command, and the wrapper then prints its output (AC-2)', async () => {
    await initNode({ hookSettings: false });
    await setOwnerStatusline('echo owner-line');

    const result = await startFactory('--yes');
    expect(result.code).toBe(0);
    expect(await waitForLaunch()).toEqual(['launched']);

    expect(JSON.parse(await readFile(settingsFileOf(), 'utf8'))).toEqual(ownSettings());
    expect((await stat(settingsFileOf())).mode & 0o777).toBe(0o600);
    expect(await readFile(join(box.node, 'factory.local.yaml'), 'utf8')).toContain('statusline: "echo owner-line"');

    const printed = await box.run(['hook', hookNames.statusline], {
      cwd: box.node,
      env: { FACTORY_HOME: box.node, FACTORY_SESSION: 'demo' },
      input: JSON.stringify(STATUS_PAYLOAD),
    });
    expect(printed).toEqual({ code: 0, stdout: 'owner-line\n', stderr: '' });
  });

  it('stops with exit 4 for a status line that the program did not write, names the key that keeps it, and changes nothing (AC-1)', async () => {
    await initNode({ hookSettings: false });
    await mkdir(join(box.node, 'coordinator', '.claude'), { recursive: true });
    const foreign = '{"statusLine":{"type":"command","command":"echo kept"}}\n';
    await writeFile(settingsFileOf(), foreign, { mode: 0o600 });
    const before = await treeOf(box.node);

    const result = await startFactory('--yes');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('session.statusline');
    expect(result.stderr).toContain('Remove the setting from coordinator/.claude/settings.local.json');
    expect(await readFile(settingsFileOf(), 'utf8')).toBe(foreign);
    expect((await stat(settingsFileOf())).mode & 0o777).toBe(0o600);
    expect(await treeOf(box.node)).toEqual(before);
    await noSession();
  });
});

/** The time limit of a case that makes workers and starts the session again: the setup takes seconds, and a resume waits up to 10 seconds. */
const RECOVERY_CASE_MS = 180_000;
const SESSIONS = {
  alpha: '5d8e2c1a-7f3b-4a96-8c4d-0e1f2a3b4c5d',
  beta: '7a1b9c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
} as const;
const COORDINATOR_SESSION = '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const OTHER_MACHINE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARK_COMMIT = 'chore: mark this machine as the active one';

/**
 * A fake claude that tells what the recovery needs to know for each session. The names of its files end with the session marker:
 * `proxy-<marker>` says `yes` when the environment of the last launch holds the proxy variable and `no` when it does not,
 * `argv-<marker>` holds the arguments of the last launch, and `launches-<marker>` has one line for each launch that ran on. A launch
 * with `--resume <id>` acts like the program: the file `no-transcript-<marker>` makes it end at once with an error, the file
 * `silent-<marker>` makes it run with no SessionStart hook, and else the hook of the new session writes its last-seen line.
 * The file `proxy-<marker>` comes first, so a wait for any other file of the launch also covers it.
 */
const recoveringClaude = (dir: string): string =>
  [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ -n "${ANTHROPIC_BASE_URL+x}" ]; then echo yes > "$dir/proxy-$FACTORY_SESSION"; else echo no > "$dir/proxy-$FACTORY_SESSION"; fi',
    'printf \'%s\\n\' "$@" > "$dir/argv-$FACTORY_SESSION"',
    'resume=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--resume" ]; then resume="$arg"; fi',
    '  prev="$arg"',
    'done',
    'if [ -n "$resume" ] && [ -e "$dir/no-transcript-$FACTORY_SESSION" ]; then',
    '  echo "No conversation found with session ID: $resume" >&2',
    '  exit 1',
    'fi',
    'if [ -n "$resume" ] && [ ! -e "$dir/silent-$FACTORY_SESSION" ]; then',
    `  printf '{"session_id":"%s","hook_event_name":"SessionStart"}' "$resume" | '${process.execPath}' '${DIST}' hook SessionStart`,
    'fi',
    'echo launched >> "$dir/launches-$FACTORY_SESSION"',
    'exec sleep 300',
    '',
  ].join('\n');

const stateOf = (): string => join(box.node, '.factory');

/** The SessionStart hook of a session: it writes the pointer and the last-seen line, as the hook of the program does. */
const sessionStarted = (marker: string, session: string): Promise<RunResult> =>
  box.run(['hook', 'SessionStart'], {
    cwd: box.node,
    env: { FACTORY_HOME: box.node, FACTORY_SESSION: marker },
    input: JSON.stringify({ session_id: session, hook_event_name: 'SessionStart' }),
  });

/** The arguments of the last launch of the program with this session marker. */
const argvOf = async (marker: string): Promise<string[]> => (await readFile(join(outDir, `argv-${marker}`), 'utf8')).trim().split('\n');

/**
 * Wait until the program has run this many times with this session marker. The program writes `launches-<marker>` after its
 * `proxy-<marker>` and `argv-<marker>` files, so the files of the last launch are in place when the count is reached. The wait
 * has an upper bound.
 */
const waitForLaunches = async (marker: string, count: number): Promise<void> => {
  for (let step = 0; step < POLL_STEPS; step += 1) {
    const text = await readFile(join(outDir, `launches-${marker}`), 'utf8').catch(() => '');
    if (text.split('\n').filter((line) => line !== '').length >= count) return;
    await sleep(POLL_STEP_MS);
  }
  throw new Error(`the program did not run ${count} times with the marker ${marker}`);
};

/** The last launch with this session marker obeys the rule of every launch, though the tmux server holds a proxy (`LAUNCH_PROXY_URL`). */
const expectRule = async (marker: string): Promise<void> =>
  expectLaunchRule(await argvOf(marker), (await waitForFile(`proxy-${marker}`)).trim());

/** The session id after `--resume`, or undefined when the launch has no `--resume`. */
const resumeIdOf = (argv: readonly string[]): string | undefined => {
  const at = argv.indexOf('--resume');
  return at < 0 ? undefined : argv[at + 1];
};

/** The panes of the workers window, as `<pane id> <worker mark>` lines. A pane with no mark has an empty mark. */
const workerPanes = async (): Promise<string[]> =>
  (await tmux(['list-panes', '-t', '=demo:workers', '-F', '#{pane_id} #{@worker}'])).stdout.split('\n').filter((line) => line !== '');

const hasWorkerPane = async (id: string): Promise<boolean> => (await workerPanes()).some((line) => line.endsWith(` ${id}`));

const pointerOf = (id: string): string => join(stateOf(), 'workers', id, 'last-session');

const markText = (machine: string): string =>
  `${JSON.stringify({ schema: 'factory.active-machine/v1', machine, at: '2029-12-31T10:00:00.000Z' })}\n`;

/**
 * Make the node, start its session, and make the workers alpha and beta. The fake claude is the one that acts on `--resume`.
 * The programs of the first launches write no line, so the test calls `sessionStarted` for each session that has one.
 */
const recoveringNode = async (): Promise<void> => {
  const source = await box.makeProject('web');
  expect((await box.git(source, ['commit', '--allow-empty', '-q', '-m', 'first'])).code).toBe(0);
  const init = await box.run(
    ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', source],
    { env: tmuxEnv },
  );
  expect(init.code, init.stderr).toBe(0);
  const claude = join(box.root, 'bin', 'claude');
  await writeFile(claude, recoveringClaude(outDir));
  await chmod(claude, 0o755);
  const started = await startFactory();
  expect(started.code, started.stderr).toBe(0);
  await waitForFile('launches-demo');
  for (const id of ['alpha', 'beta']) {
    const made = await box.run(['worker', 'new', '--home', box.node, id, '--project', 'web', '--yes'], { env: tmuxEnv });
    expect(made.code, made.stderr).toBe(0);
    await waitForFile(`launches-${id}`);
  }
};

/** The node of `recoveringNode`, with a session for each worker, and then the tmux server is gone: only `start` can bring the session back. */
const killedServer = async ({ coordinator = true }: { coordinator?: boolean } = {}): Promise<void> => {
  await recoveringNode();
  expect((await sessionStarted('alpha', SESSIONS.alpha)).code).toBe(0);
  expect((await sessionStarted('beta', SESSIONS.beta)).code).toBe(0);
  if (coordinator) expect((await sessionStarted('demo', COORDINATOR_SESSION)).code).toBe(0);
  await stopServer();
};

describe.skipIf(!hasTmux)(
  'factory start: the recovery after a kill of the tmux server (built binary, AC-16, AC-17, TP-17, TP-34, TP-35, TP-36, TP-37, TP-134)',
  () => {
    it('resumes the coordinator and each worker with its own session id, and exits 0 with no warning (TP-34, TP-37)', async () => {
      await killedServer();
      const again = await startFactory();
      expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: '' });
      expect(again.stdout).toContain('The coordinator resumes its earlier conversation.');
      expect(again.stdout).toContain('Resumed the workers: alpha, beta.');
      expect(resumeIdOf(await argvOf('demo'))).toBe(COORDINATOR_SESSION);
      expect(resumeIdOf(await argvOf('alpha'))).toBe(SESSIONS.alpha);
      expect(resumeIdOf(await argvOf('beta'))).toBe(SESSIONS.beta);
      for (const marker of ['demo', 'alpha', 'beta']) await expectRule(marker);
      expect(await hasWorkerPane('alpha')).toBe(true);
      expect(await hasWorkerPane('beta')).toBe(true);
      expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    }, RECOVERY_CASE_MS);

    it('starts a new conversation for the coordinator, with no warning, when it has no pointer (TP-37)', async () => {
      await killedServer({ coordinator: false });
      const again = await startFactory();
      expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: '' });
      expect(again.stdout).not.toContain('The coordinator resumes');
      // The first launch of the setup also wrote files with no `--resume` and no proxy: only the second launch can pass the checks.
      await waitForLaunches('demo', 2);
      expect(resumeIdOf(await argvOf('demo'))).toBeUndefined();
      expect(resumeIdOf(await argvOf('alpha'))).toBe(SESSIONS.alpha);
      for (const marker of ['demo', 'alpha']) await expectRule(marker);
    }, RECOVERY_CASE_MS);

    it('starts a new conversation for the coordinator, with one warning that names the pointer file, for a pointer that holds no session id (TP-37)', async () => {
      await killedServer({ coordinator: false });
      const pointer = join(stateOf(), 'state', 'coordinator-last-session');
      await writeFile(pointer, 'junk\n', { mode: 0o600 });
      const again = await startFactory();
      expect(again.code, again.stderr).toBe(0);
      const warnings = again.stderr.split('\n').filter((line) => line.includes(pointer));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('NOT resumed');
      // The first launch of the setup also wrote files with no `--resume` and no proxy: only the second launch can pass the checks.
      await waitForLaunches('demo', 2);
      expect(resumeIdOf(await argvOf('demo'))).toBeUndefined();
      await expectRule('demo');
      expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    }, RECOVERY_CASE_MS);

    it.each([
      [
        'a worker that has no pointer (TP-35)',
        async (): Promise<void> => {
          await unlink(pointerOf('beta'));
        },
      ],
      [
        'a worker whose pointer names a session of the coordinator',
        async (): Promise<void> => {
          await writeFile(pointerOf('beta'), `${COORDINATOR_SESSION}\n`, { mode: 0o600 });
        },
      ],
      [
        'a worker whose last-seen line has no session marker, as an old hook wrote it (TP-134)',
        async (): Promise<void> => {
          const file = join(stateOf(), 'state', 'heartbeat', SESSIONS.beta);
          const line = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
          expect(line).toHaveProperty('session_marker', 'beta');
          const oldLine = Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'session_marker'));
          await writeFile(file, `${JSON.stringify(oldLine)}\n`);
        },
      ],
    ])('skips %s with one warning, resumes the other worker, keeps the session and exits 0', async (_name, damage) => {
      await killedServer();
      await damage();
      const again = await startFactory();
      expect(again.code, again.stderr).toBe(0);
      const warnings = again.stderr.split('\n').filter((line) => line.includes('beta'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(pointerOf('beta'));
      expect(warnings[0]).toContain('factory worker resume beta');
      expect(again.stdout).toContain('Resumed the workers: alpha.');
      expect(resumeIdOf(await argvOf('alpha'))).toBe(SESSIONS.alpha);
      await expectRule('alpha');
      expect(await hasWorkerPane('alpha')).toBe(true);
      expect(await hasWorkerPane('beta')).toBe(false);
      expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    }, RECOVERY_CASE_MS);

    it.each([
      ['a session that can not be loaded', 'no-transcript-beta'],
      ['a session that writes no line', 'silent-beta'],
    ])('warns with the worker, does not try again, goes on, keeps the session and exits 0, for %s (TP-36)', async (_name, flag) => {
      await killedServer();
      await writeFile(join(outDir, flag), '');
      const again = await startFactory();
      expect(again.code, again.stderr).toBe(0);
      expect(again.stderr.split('\n').filter((line) => line.includes('beta'))).toHaveLength(1);
      expect(again.stdout).toContain('Resumed the workers: alpha.');
      expect(resumeIdOf(await argvOf('alpha'))).toBe(SESSIONS.alpha);
      await expectRule('alpha');
      expect(await hasWorkerPane('alpha')).toBe(true);
      expect((await tmux(['has-session', '-t', '=demo'])).code).toBe(0);
    }, RECOVERY_CASE_MS);

    it('starts no pane for a work copy with a wrong settings file, warns with the file, resumes the other worker and exits 0 (TP-17)', async () => {
      await killedServer();
      const settings = join(box.node, 'work-copies', 'web', 'beta', '.claude', 'settings.local.json');
      await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } }));
      const again = await startFactory();
      expect(again.code, again.stderr).toBe(0);
      expect(again.stderr).toContain('work-copies/web/beta/.claude/settings.local.json');
      expect(again.stdout).toContain('Resumed the workers: alpha.');
      expect(resumeIdOf(await argvOf('alpha'))).toBe(SESSIONS.alpha);
      await expectRule('alpha');
      expect(await hasWorkerPane('alpha')).toBe(true);
      expect(await hasWorkerPane('beta')).toBe(false);
    }, RECOVERY_CASE_MS);
  },
);

describe.skipIf(!hasTmux)('factory start: the mark of the active machine (built binary, AC-16, TP-38, TP-39)', () => {
  it('writes the machine id once and commits the mark with the first start, and the same machine does not warn after a kill of the server (TP-39)', async () => {
    await initNode();
    const started = await startFactory();
    expect({ code: started.code, stderr: started.stderr }).toEqual({ code: 0, stderr: '' });
    await waitForLaunch();

    const idFile = join(stateOf(), 'state', 'machine-id');
    const markFile = join(stateOf(), 'active-machine.json');
    const id = (await readFile(idFile, 'utf8')).trim();
    expect(id).toMatch(UUID);
    expect((await stat(idFile)).mode & 0o777).toBe(0o600);
    const mark = JSON.parse(await readFile(markFile, 'utf8')) as Record<string, unknown>;
    expect(mark).toMatchObject({ schema: 'factory.active-machine/v1', machine: id });
    expect(Number.isNaN(Date.parse(String(mark['at'])))).toBe(false);
    expect((await box.git(stateOf(), ['ls-files', '--', 'active-machine.json'])).stdout.trim()).toBe('active-machine.json');
    expect((await box.git(stateOf(), ['status', '--porcelain', '--', 'active-machine.json'])).stdout).toBe('');
    expect((await box.git(stateOf(), ['log', '-1', '--format=%s'])).stdout.trim()).toBe(MARK_COMMIT);

    await stopServer();
    const again = await startFactory();
    expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: '' });
    expect((await readFile(idFile, 'utf8')).trim()).toBe(id);
    expect(JSON.parse(await readFile(markFile, 'utf8'))).toMatchObject({ machine: id });
  }, RECOVERY_CASE_MS);

  it('warns once when the mark names another machine, resumes the workers, exits 0 and marks this machine (TP-38)', async () => {
    await killedServer();
    await writeFile(join(stateOf(), 'active-machine.json'), markText(OTHER_MACHINE));
    expect((await box.git(stateOf(), ['add', 'active-machine.json'])).code).toBe(0);
    expect((await box.git(stateOf(), ['commit', '-q', '-m', 'mark another machine'])).code).toBe(0);

    const again = await startFactory();
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr.split('\n').filter((line) => line.includes(OTHER_MACHINE))).toHaveLength(1);
    expect(again.stdout).toContain('Resumed the workers: alpha, beta.');
    const id = (await readFile(join(stateOf(), 'state', 'machine-id'), 'utf8')).trim();
    const mark = JSON.parse(await readFile(join(stateOf(), 'active-machine.json'), 'utf8')) as Record<string, unknown>;
    expect(mark['machine']).toBe(id);
    expect(mark['machine']).not.toBe(OTHER_MACHINE);
    expect((await box.git(stateOf(), ['status', '--porcelain', '--', 'active-machine.json'])).stdout).toBe('');
    expect((await box.git(stateOf(), ['log', '-1', '--format=%s'])).stdout.trim()).toBe(MARK_COMMIT);
  }, RECOVERY_CASE_MS);

  it('claims a mark of another machine and names the worker with no pane, but resumes no worker, when the session runs already', async () => {
    await recoveringNode();
    const alphaPanes = (await workerPanes()).filter((line) => line.endsWith(' alpha')).map((line) => line.split(' ')[0] ?? '');
    expect(alphaPanes).toHaveLength(1);
    expect((await tmux(['kill-pane', '-t', alphaPanes[0] ?? ''])).code).toBe(0);
    await writeFile(join(stateOf(), 'active-machine.json'), markText(OTHER_MACHINE));
    expect((await box.git(stateOf(), ['add', 'active-machine.json'])).code).toBe(0);
    expect((await box.git(stateOf(), ['commit', '-q', '-m', 'mark another machine'])).code).toBe(0);

    const again = await startFactory();
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr.split('\n').filter((line) => line.includes(OTHER_MACHINE))).toHaveLength(1);
    expect(again.stderr).toContain('"factory worker resume alpha"');
    expect(again.stderr).not.toContain('factory worker resume beta');
    expect(await hasWorkerPane('alpha')).toBe(false);
    expect(await hasWorkerPane('beta')).toBe(true);
    const id = (await readFile(join(stateOf(), 'state', 'machine-id'), 'utf8')).trim();
    expect(JSON.parse(await readFile(join(stateOf(), 'active-machine.json'), 'utf8'))).toMatchObject({ machine: id });
    expect((await box.git(stateOf(), ['log', '-1', '--format=%s'])).stdout.trim()).toBe(MARK_COMMIT);
  }, RECOVERY_CASE_MS);

  it('writes no machine id and no mark when the session runs already and the mark names this machine', async () => {
    await initNode();
    expect((await startFactory()).code).toBe(0);
    await waitForLaunch();
    const before = await treeOf(box.node);
    const log = (await box.git(stateOf(), ['log', '--format=%H'])).stdout;
    const again = await startFactory();
    expect({ code: again.code, stderr: again.stderr }).toEqual({ code: 0, stderr: '' });
    expect(await treeOf(box.node)).toEqual(before);
    expect((await box.git(stateOf(), ['log', '--format=%H'])).stdout).toBe(log);
  }, RECOVERY_CASE_MS);
});
