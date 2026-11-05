import { describe, expect, it } from 'vitest';
import { hasTmux, isAlive, LIFECYCLE_CASE_MS, useLab, waitUntilEnded } from './lifecycle-lab.js';

if (!hasTmux) console.warn('shutdown.test.ts is skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

const MARK_FILE = 'active-machine.json';
const CLEAR_COMMIT = 'chore: clear the mark of the active machine';

describe.skipIf(!hasTmux)('factory shutdown (built binary, separate tmux server, AC-18, TP-39, TP-40, TP-41, TP-42, TP-135)', () => {
  it('stops each worker, clears the mark, ends the session by its name, and leaves a session of another user and its program running (TP-39, TP-135)', async () => {
    await lab.node();
    const bystander = await lab.bystander();
    const pids = (await lab.workerPanes()).map((fact) => fact.pid);
    expect(pids).toHaveLength(2);
    expect((await lab.box.git(lab.stateOf(), ['ls-files', '--', MARK_FILE])).stdout.trim()).toBe(MARK_FILE);

    const result = await lab.factory('shutdown');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped the workers: alpha, beta.');
    expect(result.stdout).toContain('Cleared the mark of the active machine.');
    expect(result.stdout).toContain('Ended the tmux session demo.');

    expect(await lab.hasSession('demo')).toBe(false);
    for (const pid of pids) expect(await waitUntilEnded(pid)).toBe(true);
    expect(await lab.hasSession('bystander')).toBe(true);
    expect(isAlive(bystander)).toBe(true);
    expect((await lab.box.git(lab.stateOf(), ['ls-files', '--', MARK_FILE])).stdout.trim()).toBe('');
    expect((await lab.box.git(lab.stateOf(), ['log', '-1', '--format=%s'])).stdout.trim()).toBe(CLEAR_COMMIT);
  }, LIFECYCLE_CASE_MS);

  it('says that nothing runs and exits 0 when no session runs, also on a second run (TP-41)', async () => {
    await lab.node();
    expect((await lab.factory('shutdown')).code).toBe(0);
    const again = await lab.factory('shutdown');
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('Nothing runs: the tmux session demo does not run.');
  }, LIFECYCLE_CASE_MS);

  it('exits 3 and stops nothing when one worker is in an unknown state (TP-42)', async () => {
    await lab.node({ sessions: ['beta', 'demo'] });
    const before = await lab.workerPanes();
    expect(before).toHaveLength(2);

    const result = await lab.factory('shutdown');
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toContain('alpha');
    expect(await lab.hasSession('demo')).toBe(true);
    expect(await lab.workerPanes()).toEqual(before);
    for (const fact of before) expect(isAlive(fact.pid)).toBe(true);
    expect((await lab.box.git(lab.stateOf(), ['ls-files', '--', MARK_FILE])).stdout.trim()).toBe(MARK_FILE);
  }, LIFECYCLE_CASE_MS);

  it('exits 4 and keeps a session of the same name that has no home option (TP-40)', async () => {
    await lab.init();
    const made = await lab.tmux(['new-session', '-d', '-s', 'demo', '-P', '-F', '#{pane_pid}', 'sleep 300']);
    expect(made.code, made.stderr).toBe(0);
    const pid = Number(made.stdout.trim());

    const result = await lab.factory('shutdown');
    expect(result.code, result.stderr).toBe(4);
    expect(await lab.hasSession('demo')).toBe(true);
    expect(isAlive(pid)).toBe(true);
  }, LIFECYCLE_CASE_MS);
});
