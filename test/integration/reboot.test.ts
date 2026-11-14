import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectLaunchRule, hasTmux, isAlive, LIFECYCLE_CASE_MS, SESSIONS, useLab, waitUntilEnded, type Marker } from './lifecycle-lab.js';

if (!hasTmux) console.warn('reboot.test.ts is skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

const resumeIdOf = (argv: readonly string[]): string | undefined => {
  const at = argv.indexOf('--resume');
  return at < 0 ? undefined : argv[at + 1];
};

/** Each marker was resumed: its last launch obeys the rule of every launch, though the tmux server holds a proxy. */
const expectRuleOf = async (...markers: readonly Marker[]): Promise<void> => {
  for (const marker of markers) expectLaunchRule(await lab.argvOf(marker), await lab.proxyOf(marker));
};

describe.skipIf(!hasTmux)('factory reboot (built binary, separate tmux server)', () => {
  it('ends the session and starts it again with the coordinator and each worker resumed by its id, and leaves another session alone', async () => {
    await lab.node();
    const bystander = await lab.bystander();
    const before = await lab.workerPanes();
    expect(before).toHaveLength(2);

    const result = await lab.factory('reboot');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Stopped the workers: alpha, beta.');
    expect(result.stdout).toContain('Started the session demo again.');
    expect(result.stdout).toContain(
      'The coordinator resumes its earlier conversation. It must follow the current rules of the coordinator block.',
    );
    expect(result.stdout).toContain('Resumed the workers: alpha, beta.');

    for (const fact of before) expect(await waitUntilEnded(fact.pid)).toBe(true);
    expect(await lab.hasSession('demo')).toBe(true);
    expect(resumeIdOf(await lab.argvOf('demo'))).toBe(SESSIONS.demo);
    expect(resumeIdOf(await lab.argvOf('alpha'))).toBe(SESSIONS.alpha);
    expect(resumeIdOf(await lab.argvOf('beta'))).toBe(SESSIONS.beta);
    await expectRuleOf('demo', 'alpha', 'beta');
    expect(await lab.launchCount('demo')).toBe(2);
    expect(await lab.launchCount('alpha')).toBe(2);
    expect(await lab.launchCount('beta')).toBe(2);
    expect(await lab.livePaneOf('alpha')).toBeDefined();
    expect(await lab.livePaneOf('beta')).toBeDefined();
    expect(await lab.hasSession('bystander')).toBe(true);
    expect(isAlive(bystander)).toBe(true);
  }, LIFECYCLE_CASE_MS);

  it('stops and starts only the workers, and keeps the session and the coordinator pane, when it runs in a pane of the session', async () => {
    await lab.node();
    const coordinator = await lab.coordinatorPane();
    expect(coordinator).toMatch(/^%\d+$/);
    const before = await lab.workerPanes();

    const result = await lab.factory('reboot', [], { TMUX_PANE: coordinator });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Kept the session demo and the coordinator pane.');
    expect(result.stdout).toContain('Resumed the workers: alpha, beta.');

    for (const fact of before) expect(await waitUntilEnded(fact.pid)).toBe(true);
    expect(await lab.hasSession('demo')).toBe(true);
    expect(await lab.coordinatorPane()).toBe(coordinator);
    expect(await lab.launchCount('demo')).toBe(1);
    expect(await lab.launchCount('alpha')).toBe(2);
    expect(await lab.launchCount('beta')).toBe(2);
    expect(resumeIdOf(await lab.argvOf('alpha'))).toBe(SESSIONS.alpha);
    await expectRuleOf('alpha', 'beta');
  }, LIFECYCLE_CASE_MS);

  it('exits 3 and stops nothing when one worker has no session id that it may resume', async () => {
    await lab.node();
    const before = await lab.workerPanes();
    await unlink(lab.pointerOf('beta'));

    const result = await lab.factory('reboot');
    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toContain('beta');
    expect(await lab.hasSession('demo')).toBe(true);
    expect(await lab.workerPanes()).toEqual(before);
    for (const fact of before) expect(isAlive(fact.pid)).toBe(true);
    expect(await lab.launchCount('demo')).toBe(1);
  }, LIFECYCLE_CASE_MS);

  it('exits 4 and ends nothing for a session of the same name that belongs to another home', async () => {
    await lab.init();
    const made = await lab.tmux(['new-session', '-d', '-s', 'demo', '-P', '-F', '#{pane_pid}', 'sleep 300']);
    expect(made.code, made.stderr).toBe(0);
    const pid = Number(made.stdout.trim());
    const other = join(lab.box.root, 'other-home');
    expect((await lab.tmux(['set-option', '-t', '=demo:', '@factory_home', other])).code).toBe(0);

    const result = await lab.factory('reboot');
    expect(result.code, result.stderr).toBe(4);
    expect(result.stderr).toContain('factory shutdown');
    expect(await lab.hasSession('demo')).toBe(true);
    expect(isAlive(pid)).toBe(true);
  }, LIFECYCLE_CASE_MS);
});
