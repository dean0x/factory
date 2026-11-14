import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files } from '../../src/names.js';
import { makeSandbox, removeOpenSandboxes, tmuxSocketOf, type RunResult, type Sandbox } from './harness.js';

/**
 * The view slot with the built program, real git and a separate tmux server. `factory start` makes the session, and its right pane in
 * the window `view` runs `item list --follow` for the board of the home. The coordinator runs a fake `claude` that only waits.
 */

const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).stdout ?? '';
const [major = 0] = (/(\d+)\./.exec(tmuxVersion)?.slice(1) ?? []).map(Number);
const hasTmux = major >= 3;
if (!hasTmux) console.warn('view-slot.test.ts is skipped: tmux 3.0 or newer is not installed.');

/** The time that a case may take: `init`, the writes, `start`, and the waits for the screen of the pane. */
const CASE_MS = 120_000;
const STEP_MS = 100;
const STOP_STEPS = 30;
/** The follow loop polls every 2 s, so a change shows within about 2 s. The wait for it ends after 20 s. */
const SCREEN_STEP_MS = 200;
const SCREEN_STEPS = 100;
const EXIT_STEPS = 100;

/** The right pane of the window `view`: the slot. */
const SLOT_PANE = '=demo:view.{right}';

/** A fake `claude` that answers the version check and then waits, so that the coordinator pane stays. */
const FAKE_CLAUDE = ['#!/bin/sh', 'case "$1" in --version) echo "2.1.224 (Claude Code)"; exit 0;; esac', 'exec sleep 300', ''].join('\n');

let box: Sandbox;
let tmuxEnv: Record<string, string>;
let socket: string;

const tmux = (args: readonly string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile('tmux', [...args], { env: tmuxEnv, encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A command of the program for the home of the test. It must exit 0. */
const mustRun = async (args: readonly string[]): Promise<RunResult> => {
  const result = await box.run([...args, '--home', box.node], { env: tmuxEnv });
  expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(0);
  return result;
};

/** The text on the screen of the slot pane. `-J` joins the lines that the narrow pane wrapped. */
const slotScreen = async (): Promise<string> => (await tmux(['capture-pane', '-p', '-J', '-t', SLOT_PANE])).stdout;

/** Wait until the screen of the slot pane holds every text. The wait has an upper bound. */
const waitForScreen = async (needles: readonly string[]): Promise<string> => {
  let screen = '';
  for (let step = 0; step < SCREEN_STEPS; step += 1) {
    screen = await slotScreen();
    if (needles.every((needle) => screen.includes(needle))) return screen;
    await sleep(SCREEN_STEP_MS);
  }
  throw new Error(`the slot pane did not show ${needles.join(' and ')}. It showed:\n${screen}`);
};

/** True while the process exists. Signal 0 only checks. */
const exists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The `board` block that `item add` needs: a new setup declares no item state. */
const BOARD_BLOCK = ['board:', '  states: [open, doing, done]', '  in_progress: doing', '  closed: done', ''].join('\n');

/** A node with two tracks that hold one item each, and a third track with no item. */
const makeBoard = async (): Promise<void> => {
  const web = await box.makeProject('web');
  const made = await box.run(
    ['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner', '--project', web],
    { env: tmuxEnv },
  );
  expect(made.code, made.stderr).toBe(0);
  const config = join(box.node, files.config);
  const text = await readFile(config, 'utf8');
  await writeFile(config, `${text}${text.endsWith('\n') ? '' : '\n'}${BOARD_BLOCK}`);
  await mustRun(['track', 'add', 'alpha', '--name', 'Alpha']);
  await mustRun(['track', 'add', 'beta', '--name', 'Beta']);
  await mustRun(['track', 'add', 'gamma', '--name', 'Gamma']);
  await mustRun(['item', 'add', '--title', 'Alpha task', '--track', 'alpha']);
  await mustRun(['item', 'add', '--title', 'Beta task', '--track', 'beta']);
};

beforeEach(async () => {
  box = await makeSandbox();
  const bin = join(box.root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), FAKE_CLAUDE);
  await chmod(join(bin, 'claude'), 0o755);
  // A separate tmux server: the harness sets TMUX_TMPDIR to a folder of the sandbox and gives no TMUX.
  socket = tmuxSocketOf(box.root);
  tmuxEnv = {
    ...box.env,
    // The slot pane is a program, not a shell. This only keeps the coordinator pane free of the shell of the user.
    SHELL: '/bin/sh',
    PATH: `${bin}:${box.env['PATH'] ?? ''}`,
  };
}, CASE_MS);

/** Stops the tmux server of this test, then waits until its socket no longer answers. The wait has an upper bound. */
const stopServer = async (): Promise<void> => {
  await tmux(['-S', socket, 'kill-server']);
  for (let step = 0; step < STOP_STEPS; step += 1) {
    if ((await tmux(['-S', socket, 'list-sessions'])).code !== 0) return;
    await sleep(STEP_MS);
  }
};

afterEach(async () => {
  try {
    // Stop the server of this test only: both the folder and the socket name this server.
    if (hasTmux && tmuxEnv['TMUX_TMPDIR']?.startsWith(box.root) === true) await stopServer();
  } finally {
    await box.remove();
  }
});

afterAll(removeOpenSandboxes);

describe.skipIf(!hasTmux)('the view slot (built binary, separate tmux server)', () => {
  it(
    'shows the item titles of one-item tracks in the slot pane, and a new title after an item add',
    async () => {
      await makeBoard();
      const started = await box.run(['start', '--home', box.node], { env: tmuxEnv });
      expect(started.code, started.stderr).toBe(0);

      const first = await waitForScreen(['Alpha task', 'Beta task']);
      expect(first).not.toContain('Gamma task');
      const start = await tmux(['display-message', '-p', '-t', SLOT_PANE, '#{pane_start_command}']);
      expect(start.stdout).toContain('--follow');
      expect((await tmux(['display-message', '-p', '-t', SLOT_PANE, '#{pane_dead}'])).stdout.trim()).toBe('0');

      await mustRun(['item', 'add', '--title', 'Gamma task', '--track', 'gamma']);
      const second = await waitForScreen(['Alpha task', 'Beta task', 'Gamma task']);
      expect(second).toContain('Gamma');
    },
    CASE_MS,
  );

  it(
    'ends the follow process when the slot pane closes',
    async () => {
      await makeBoard();
      const started = await box.run(['start', '--home', box.node], { env: tmuxEnv });
      expect(started.code, started.stderr).toBe(0);
      await waitForScreen(['Alpha task', 'Beta task']);

      const pid = Number((await tmux(['display-message', '-p', '-t', SLOT_PANE, '#{pane_pid}'])).stdout.trim());
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      expect(exists(pid)).toBe(true);
      expect((await tmux(['kill-pane', '-t', SLOT_PANE])).code).toBe(0);

      let alive = true;
      for (let step = 0; step < EXIT_STEPS && alive; step += 1) {
        alive = exists(pid);
        if (alive) await sleep(STEP_MS);
      }
      expect(alive).toBe(false);
    },
    CASE_MS,
  );
});
