import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTmux, isAlive, LIFECYCLE_CASE_MS, SESSIONS, useLab, waitUntilEnded } from './lifecycle-lab.js';

if (!hasTmux) console.warn('restart.test.ts is skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

const resumeIdOf = (argv: readonly string[]): string | undefined => {
  const at = argv.indexOf('--resume');
  return at < 0 ? undefined : argv[at + 1];
};

describe.skipIf(!hasTmux)('factory restart (built binary, separate tmux server, AC-19, TP-17, TP-43, TP-44, TP-132)', () => {
  it('stops one worker and starts it again with its session id, and the other worker keeps its pane and its process (TP-43)', async () => {
    await lab.node();
    const alpha = await lab.livePaneOf('alpha');
    const beta = await lab.livePaneOf('beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    const result = await lab.factory('restart', ['alpha']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped the worker alpha.');
    expect(result.stdout).toContain('Resumed the worker alpha');

    expect(await waitUntilEnded(alpha?.pid ?? 0)).toBe(true);
    const after = await lab.livePaneOf('alpha');
    expect(after).toBeDefined();
    expect(after?.pane).not.toBe(alpha?.pane);
    expect(resumeIdOf(await lab.argvOf('alpha'))).toBe(SESSIONS.alpha);
    expect(await lab.launchCount('alpha')).toBe(2);

    expect(await lab.livePaneOf('beta')).toEqual(beta);
    expect(isAlive(beta?.pid ?? 0)).toBe(true);
    expect(await lab.launchCount('beta')).toBe(1);
    expect(await lab.hasSession('demo')).toBe(true);
  }, LIFECYCLE_CASE_MS);

  it('exits 3 and names factory start when no tmux session runs (TP-44)', async () => {
    await lab.node();
    expect((await lab.factory('shutdown')).code).toBe(0);

    const result = await lab.factory('restart', ['alpha']);
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toContain('factory start');
  }, LIFECYCLE_CASE_MS);

  it('exits 2 for an id that has no record, and stops nothing', async () => {
    await lab.node();
    const before = await lab.workerPanes();

    const result = await lab.factory('restart', ['nobody']);
    expect(result.code, result.stderr).toBe(2);
    expect(await lab.workerPanes()).toEqual(before);
  }, LIFECYCLE_CASE_MS);

  it('exits 3 and stops nothing when the worker is in an unknown state', async () => {
    await lab.node({ sessions: ['beta', 'demo'] });
    const before = await lab.workerPanes();

    const result = await lab.factory('restart', ['alpha']);
    expect(result.code, result.stderr).toBe(3);
    expect(await lab.workerPanes()).toEqual(before);
    for (const fact of before) expect(isAlive(fact.pid)).toBe(true);
  }, LIFECYCLE_CASE_MS);

  it('exits 4 and stops nothing when the settings file of the work copy is wrong (TP-17)', async () => {
    await lab.node();
    const before = await lab.workerPanes();
    const settings = join(lab.box.node, 'work-copies', 'web', 'alpha', '.claude', 'settings.local.json');
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } }));

    const result = await lab.factory('restart', ['alpha']);
    expect(result.code, result.stderr).toBe(4);
    expect(result.stderr).toContain('work-copies/web/alpha/.claude/settings.local.json');
    expect(await lab.workerPanes()).toEqual(before);
    for (const fact of before) expect(isAlive(fact.pid)).toBe(true);
    expect(await lab.launchCount('alpha')).toBe(1);
  }, LIFECYCLE_CASE_MS);

  it('exits 4 for a session of the same name that belongs to another home, and the remedy names factory shutdown (TP-132)', async () => {
    await lab.init();
    const made = await lab.tmux(['new-session', '-d', '-s', 'demo', '-P', '-F', '#{pane_pid}', 'sleep 300']);
    expect(made.code, made.stderr).toBe(0);
    const pid = Number(made.stdout.trim());
    const other = join(lab.box.root, 'other-home');
    expect((await lab.tmux(['set-option', '-t', '=demo:', '@factory_home', other])).code).toBe(0);

    const result = await lab.factory('restart', ['alpha']);
    expect(result.code, result.stderr).toBe(4);
    expect(result.stderr).toContain('factory shutdown');
    expect(await lab.hasSession('demo')).toBe(true);
    expect(isAlive(pid)).toBe(true);
  }, LIFECYCLE_CASE_MS);
});
