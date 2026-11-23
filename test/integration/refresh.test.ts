import { access, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refreshText, refreshWait } from '../../src/names.js';
import { wordsOfStartCommand } from '../../src/workers/binding.js';
import { DIST, tmuxSocketOf } from './harness.js';
import { expectLaunchRule, hasTmux, isAlive, LIFECYCLE_CASE_MS, SESSIONS, useLab, type Marker } from './lifecycle-lab.js';
import { scaled } from './load.js';

if (!hasTmux) console.warn('refresh.test.ts is skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

const paneOf = async (target: string) => {
  const found = await lab.tmux(['display-message', '-p', '-t', target, '#{pane_id}|#{pane_pid}|#{pane_dead}|#{@node}']);
  expect(found.code, found.stderr).toBe(0);
  const [id = '', pid, dead, node] = found.stdout.trim().split('|');
  expect(id).toMatch(/^%\d+$/);
  expect(Number(pid)).toBeGreaterThan(0);
  expect(dead).toBe('0');
  return { id, pid: Number(pid), node };
};

const coordinator = async () => paneOf(await lab.coordinatorPane());
const board = async () => paneOf('=demo:view.{right}');

const expectResumed = async (marker: Marker): Promise<void> => {
  const argv = await lab.argvOf(marker);
  const resume = argv.indexOf('--resume');
  expect(resume).toBeGreaterThanOrEqual(0);
  expect(argv[resume + 1]).toBe(SESSIONS[marker]);
  expect(argv.filter((word) => word === refreshText.continue)).toHaveLength(1);
  expectLaunchRule(argv, await lab.proxyOf(marker));
  await expect.poll(() => lab.launchCount(marker), { timeout: scaled(5_000) }).toBe(2);
};

const expectRunner = async (): Promise<void> => {
  const windows = await lab.tmux(['list-windows', '-t', '=demo', '-F', '#{window_name}']);
  expect(windows.stdout.split('\n').filter((name) => name === 'refresh')).toEqual(['refresh']);
  const started = await lab.tmux(['display-message', '-p', '-t', '=demo:refresh', '#{pane_start_command}']);
  expect(started.code, started.stderr).toBe(0);
  const words = wordsOfStartCommand(started.stdout.trim());
  // Do not include the runner token in an assertion message.
  expect(words?.slice(0, 4)).toEqual([process.execPath, DIST, 'refresh', '--runner']);
  expect(/^[a-f0-9]{32}$/.test(words?.[4] ?? '')).toBe(true);
  expect(words?.slice(5)).toEqual(['--home', lab.box.node]);
};

const resultText = async (): Promise<string> => (await lab.factory('refresh', ['--result'])).stdout;
const twoWorkersResumed = /worker alpha: resumed\nworker beta: resumed/;

describe.skipIf(!hasTmux)('factory refresh (built binary, separate tmux server)', () => {
  it('resumes the workers in id order, then the coordinator in place, and keeps the board and session', async () => {
    await lab.node();
    const before = await coordinator();
    const boardBefore = await board();
    const workersBefore = await lab.workerPanes();
    const server = await lab.tmux(['display-message', '-p', '-t', before.id, '#{socket_path}']);
    expect(server.stdout.trim()).toBe(await realpath(tmuxSocketOf(lab.box.root)));

    const result = await lab.factory('refresh');

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/worker alpha: resumed\nworker beta: resumed\ncoordinator demo: resumed/);
    for (const marker of ['alpha', 'beta', 'demo'] as const) await expectResumed(marker);
    expect(await lab.waitForFile('refresh-events')).toBe(
      'alpha UserPromptSubmit\nalpha Stop\nbeta UserPromptSubmit\nbeta Stop\ndemo UserPromptSubmit\ndemo Stop\n',
    );
    for (const old of workersBefore) {
      expect(isAlive(old.pid)).toBe(false);
      expect(await lab.livePaneOf(old.worker)).toBeDefined();
    }
    const after = await coordinator();
    expect(after).toMatchObject({ id: before.id, node: 'demo' });
    expect(after.pid).not.toBe(before.pid);
    expect(isAlive(before.pid)).toBe(false);
    expect(await board()).toEqual(boardBefore);
    expect(await lab.hasSession('demo')).toBe(true);
  }, LIFECYCLE_CASE_MS);

  it('schedules one runner from the coordinator pane and waits for a new Stop before it restarts that pane', async () => {
    await lab.node();
    const before = await coordinator();
    expect((await lab.event('demo', 'Stop')).code).toBe(0);

    const result = await lab.factory('refresh', [], { TMUX_PANE: before.id });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^SCHEDULED: [a-f0-9]+\. /);
    expect(result.stdout).toContain('factory refresh --result');
    await expectRunner();
    const second = await lab.factory('refresh');
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('a refresh run is already live');
    expect(second.stderr).toContain('factory refresh --cancel');
    await expect.poll(resultText, { timeout: scaled(30_000) }).toMatch(twoWorkersResumed);
    // Give the runner a full idle poll with the old Stop still in place.
    await new Promise((resolve) => setTimeout(resolve, refreshWait.intervalMs + 1_000));
    expect(await coordinator()).toEqual(before);

    expect((await lab.event('demo', 'Stop')).code).toBe(0);
    await expect.poll(resultText, { timeout: scaled(30_000) }).toMatch(/: done\n[\s\S]*coordinator demo: resumed/);
    await expectResumed('demo');
    expect((await coordinator()).id).toBe(before.id);
    expect(isAlive(before.pid)).toBe(false);
  }, LIFECYCLE_CASE_MS);

  it('reports the folder question, resumes the other worker, and leaves the coordinator alone', async () => {
    await lab.node();
    const before = await coordinator();
    await writeFile(join(lab.outDir, 'trust-question-alpha'), '');

    const result = await lab.factory('refresh');

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(3);
    const waiting = await lab.livePaneOf('alpha');
    expect(waiting).toBeDefined();
    expect(result.stdout).toContain(`the pane ${waiting?.pane} of the worker alpha waits on a folder trust question`);
    expect(result.stdout).toContain(`The owner answers each folder trust question in the pane ${waiting?.pane}.`);
    expect(result.stdout).toContain('factory worker watch --ready alpha');
    expect(result.stdout).toContain('worker beta: resumed');
    expect(await resultText()).toBe(result.stdout);
    expect(await lab.waitForFile('refresh-events')).toBe('beta UserPromptSubmit\nbeta Stop\n');
    expect(await coordinator()).toEqual(before);
    expect(await lab.launchCount('demo')).toBe(1);
  }, LIFECYCLE_CASE_MS);

  it('leaves the fake claude in another factory and in a pane that factory did not start', async () => {
    await lab.node();
    const bystander = await lab.bystander();
    const marked = await lab.tmux(['set-option', '-t', '=bystander:', '@factory_home', join(lab.box.root, 'other-node')]);
    expect(marked.code, marked.stderr).toBe(0);
    const made = await lab.tmux(['new-window', '-d', '-t', '=demo:', '-n', 'manual', join(lab.box.root, 'bin', 'claude')]);
    expect(made.code, made.stderr).toBe(0);
    const manual = await paneOf('=demo:manual');
    const restart = await lab.factory('restart', ['alpha']);
    expect(restart.code, restart.stderr).toBe(0);
    await expect.poll(() => lab.launchCount('alpha'), { timeout: scaled(5_000) }).toBe(2);
    await expect(access(join(lab.outDir, 'refresh-events'))).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await lab.factory('refresh');

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(await lab.hasSession('bystander')).toBe(true);
    expect((await paneOf('=bystander:')).pid).toBe(bystander);
    expect(isAlive(bystander)).toBe(true);
    expect(await paneOf('=demo:manual')).toEqual(manual);
    expect(isAlive(manual.pid)).toBe(true);
  }, LIFECYCLE_CASE_MS);
});
