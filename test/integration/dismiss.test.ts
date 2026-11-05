import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTmux, isAlive, LIFECYCLE_CASE_MS, SESSIONS, useLab, waitUntilEnded, type Marker } from './lifecycle-lab.js';

if (!hasTmux) console.warn('dismiss.test.ts is skipped: tmux 3.0 or newer is not installed.');

const lab = useLab();

const copyOf = (id: string): string => join(lab.box.node, 'work-copies', 'web', id);
const cloneOf = (): string => join(lab.box.node, 'web');
const recordDirOf = (id: string): string => join(lab.box.node, '.factory', 'workers', id);
const lineOf = (marker: Marker): string => join(lab.box.node, '.factory', 'state', 'heartbeat', SESSIONS[marker]);

/** Pushes the branch of a worker to the origin of its clone: the work is then on the remote branch. */
const push = async (id: string): Promise<void> => {
  const pushed = await lab.box.git(copyOf(id), ['push', '-q', 'origin', `worker/${id}`]);
  expect(pushed.code, pushed.stderr).toBe(0);
};

/** One hook event of a worker session, as Claude Code sends it. */
const event = (marker: Marker, name: string) =>
  lab.box.run(['hook', name], {
    cwd: lab.box.node,
    env: { FACTORY_HOME: lab.box.node, FACTORY_SESSION: marker },
    input: JSON.stringify({ session_id: SESSIONS[marker], hook_event_name: name }),
  });

/** Nothing of the worker changed: its work copy, its record, its last-seen line and its live pane are there. */
const expectIntact = async (id: Marker): Promise<void> => {
  expect(existsSync(copyOf(id))).toBe(true);
  expect(existsSync(recordDirOf(id))).toBe(true);
  expect(existsSync(lineOf(id))).toBe(true);
  const pane = await lab.livePaneOf(id);
  expect(pane).toBeDefined();
  expect(isAlive(pane?.pid ?? 0)).toBe(true);
};

/** Commits in the work copy of a worker, so that its branch holds work that no remote branch holds. */
const commitWork = async (id: string): Promise<void> => {
  const committed = await lab.box.git(copyOf(id), ['commit', '--allow-empty', '-q', '-m', 'work of the worker']);
  expect(committed.code, committed.stderr).toBe(0);
};

describe.skipIf(!hasTmux)('factory dismiss frees a work copy only when its work is pushed (built binary, separate tmux server, AC-23, TP-53 to TP-57)', () => {
  it('prints the dry run of a pushed worker, names the ignored settings file that the removal deletes, and changes nothing (TP-56)', async () => {
    await lab.node();
    await push('alpha');
    const before = await lab.workerPanes();

    const result = await lab.factory('dismiss', ['alpha']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Would end the pane');
    expect(result.stdout).toContain('work-copies/web/alpha');
    expect(result.stdout).toContain('dismiss alpha --yes');
    expect(result.stdout).toMatch(/The removal deletes the ignored files: .*\.claude/);
    expect(await lab.workerPanes()).toEqual(before);
    await expectIntact('alpha');
    await expectIntact('beta');
  }, LIFECYCLE_CASE_MS);

  it('ends the pane, removes the work copy that holds the excluded settings file, deletes the record and the line, keeps the branch and the primary clone, and leaves the other worker alone (TP-53, TP-55, TP-57)', async () => {
    await lab.node();
    await push('alpha');
    const pane = await lab.livePaneOf('alpha');
    expect(pane).toBeDefined();
    expect(existsSync(join(copyOf('alpha'), '.claude', 'settings.local.json'))).toBe(true);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Removed the work copy');
    expect(result.stdout).toContain('branch -D worker/alpha');

    expect(await waitUntilEnded(pane?.pid ?? 0)).toBe(true);
    expect(await lab.livePaneOf('alpha')).toBeUndefined();
    expect(existsSync(copyOf('alpha'))).toBe(false);
    expect(existsSync(recordDirOf('alpha'))).toBe(false);
    expect(existsSync(lineOf('alpha'))).toBe(false);
    expect(existsSync(join(cloneOf(), '.git'))).toBe(true);
    const branch = await lab.box.git(cloneOf(), ['branch', '--list', 'worker/alpha']);
    expect(branch.stdout).toContain('worker/alpha');
    await expectIntact('beta');
    const status = await lab.factory('status');
    expect(status.stdout).not.toMatch(/\balpha\b/);
    expect(status.stdout).toMatch(/\bbeta\b/);
  }, LIFECYCLE_CASE_MS);

  it('frees a worker that has no commit of its own and was never pushed, because its head is on the default branch of the remote (TP-53)', async () => {
    await lab.node();
    const pane = await lab.livePaneOf('beta');
    expect(pane).toBeDefined();

    const result = await lab.factory('dismiss', ['beta', '--yes']);
    expect(result.code, result.stderr).toBe(0);
    expect(await waitUntilEnded(pane?.pid ?? 0)).toBe(true);
    expect(existsSync(copyOf('beta'))).toBe(false);
    expect(existsSync(recordDirOf('beta'))).toBe(false);
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('prints STUCK and frees nothing for a branch that is not on the remote and holds a commit of its own (TP-54)', async () => {
    await lab.node();
    await commitWork('beta');

    const result = await lab.factory('dismiss', ['beta', '--yes']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/^STUCK: .*is not on the remote origin/m);
    await expectIntact('beta');
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('prints STUCK and frees nothing for a head that is ahead of the remote branch (TP-54)', async () => {
    await lab.node();
    await push('alpha');
    await commitWork('alpha');

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/^STUCK: .*has commits that origin\/worker\/alpha does not hold/m);
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('prints STUCK and keeps the file when the work copy has an untracked file (TP-54)', async () => {
    await lab.node();
    await push('alpha');
    await writeFile(join(copyOf('alpha'), 'notes.txt'), 'not committed\n');

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/^STUCK: .*notes\.txt/m);
    expect(await readFile(join(copyOf('alpha'), 'notes.txt'), 'utf8')).toBe('not committed\n');
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('prints STUCK when the stash of the repo holds an entry (TP-54)', async () => {
    await lab.node();
    await push('alpha');
    await writeFile(join(copyOf('alpha'), 'saved.txt'), 'in the stash\n');
    const stashed = await lab.box.git(copyOf('alpha'), ['stash', 'push', '-q', '-u', '-m', 'saved']);
    expect(stashed.code, stashed.stderr).toBe(0);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/^STUCK: .*stash/m);
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('prunes a stale remote reference with its fetch, so a branch that the remote dropped is not pushed (TP-54)', async () => {
    await lab.node();
    await commitWork('alpha');
    await push('alpha');
    const stale = await lab.box.git(cloneOf(), ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/worker/alpha']);
    expect(stale.code, stale.stderr).toBe(0);
    const dropped = await lab.box.git(join(lab.box.root, 'web'), ['branch', '-D', 'worker/alpha']);
    expect(dropped.code, dropped.stderr).toBe(0);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/^STUCK: .*is not on the remote origin/m);
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('stops with exit 4 for a record whose work copy is outside work-copies/, and touches neither that folder nor the clone (TP-55)', async () => {
    await lab.node();
    await push('alpha');
    const outside = join(lab.box.root, 'elsewhere');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'mine\n');
    const file = join(recordDirOf('alpha'), 'worker.json');
    const text = await readFile(file, 'utf8');
    const changed = text.replace(/"\/[^"]*\/work-copies\/web\/alpha"/, JSON.stringify(outside));
    expect(changed).not.toBe(text);
    await writeFile(file, changed);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(4);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(cloneOf(), '.git'))).toBe(true);
    expect(existsSync(copyOf('alpha'))).toBe(true);
    expect(await lab.livePaneOf('alpha')).toBeDefined();
  }, LIFECYCLE_CASE_MS);
});

describe.skipIf(!hasTmux)('factory dismiss refuses a busy worker, and the pick step stops in a session (built binary, separate tmux server, AC-24, TP-58 to TP-60)', () => {
  it('refuses a worker whose session works with exit 1 and a remedy, and ends nothing', async () => {
    await lab.node();
    await push('alpha');
    expect((await event('alpha', 'UserPromptSubmit')).code).toBe(0);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stderr).toContain('busy');
    expect(result.stderr).toContain('dismiss alpha');
    await expectIntact('alpha');
  }, LIFECYCLE_CASE_MS);

  it('lists no idle worker while the work item port knows no work item, and changes nothing (TP-58)', async () => {
    await lab.node();
    const before = await lab.workerPanes();

    const result = await lab.factory('dismiss', ['--idle']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('No idle workers.');
    expect(await lab.workerPanes()).toEqual(before);
    await expectIntact('alpha');
    await expectIntact('beta');
  }, LIFECYCLE_CASE_MS);

  it('exits 4 for --yes and for the pick step with FACTORY_SESSION set, and ends nothing (TP-60)', async () => {
    await lab.node();
    await push('alpha');

    const confirm = await lab.factory('dismiss', ['alpha', '--yes'], { FACTORY_SESSION: 'demo' });
    expect(confirm.code, confirm.stderr).toBe(4);
    expect(confirm.stderr).toContain('outside');

    const pick = await lab.factory('dismiss', ['--idle'], { FACTORY_SESSION: 'demo' });
    expect(pick.code, pick.stderr).toBe(4);
    expect(pick.stdout).toContain('outside');

    await expectIntact('alpha');
    await expectIntact('beta');
  }, LIFECYCLE_CASE_MS);

  it('exits 4 and ends nothing when a session of the same name has another home option, so it keeps running (TP-59)', async () => {
    await lab.node();
    await push('alpha');
    const other = join(lab.box.root, 'other-home');
    expect((await lab.tmux(['set-option', '-t', '=demo', '@factory_home', other])).code).toBe(0);

    const result = await lab.factory('dismiss', ['alpha', '--yes']);
    expect(result.code, result.stderr).toBe(4);
    await expectIntact('alpha');
    await expectIntact('beta');
    expect(await lab.hasSession('demo')).toBe(true);
  }, LIFECYCLE_CASE_MS);
});
