import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeFor, failure, type CliResult } from '../../src/cli/errors.js';
import { ok } from '../../src/core/result.js';
import { maxFileBytes, refreshRunPath, refreshWait } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import {
  cancelRefreshRun,
  claimRefreshRun,
  failUnclaimedRefreshRun,
  readOwnRefreshRun,
  readRefreshRun,
  refreshRunIsLive,
  scheduleRefreshRun,
  updateRefreshRun,
} from '../../src/workers/refresh-record.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const HOME = '/w/node';
const PATH = join(HOME, refreshRunPath);
const LAYOUT = layoutOf(HOME);
const START = 'Sun Nov 22 12:00:00 2026';
const NEW_START = 'Sun Nov 22 12:00:01 2026';
const CLAIM_MS = refreshWait.claimChecks * refreshWait.claimIntervalMs;

const make = (links: Readonly<Record<string, string>> = {}) => {
  let starts = START;
  let live = true;
  const fake = createFakeDeps({ os: 'darwin', links, run: () => ok({ exitCode: 0, stdout: starts, stderr: '' }) });
  fake.seedDir(LAYOUT.stateDir);
  const deps = { ...fake, isRunning: () => ok(live) };
  return { deps, reusePid: () => { starts = NEW_START; }, endRunner: () => { live = false; } };
};

const value = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const schedule = (deps: FakeDeps) => scheduleRefreshRun(deps, HOME, { caller: 'pane', coordinatorPane: true });
const claim = async (deps: FakeDeps) => value(await claimRefreshRun(deps, HOME, value(await schedule(deps)).token));

describe('refresh run record', () => {
  it('writes a private record in the runtime folder and leaves no lock', async () => {
    const { deps } = make();
    const record = value(await schedule(deps));
    expect(await readRefreshRun(deps, HOME)).toEqual(ok(record));
    expect(deps.modes.get(PATH)).toBe(0o600);
    expect(deps.modes.get(LAYOUT.runtimeDir)).toBe(0o700);
    expect([...deps.files.keys()]).toEqual([PATH]);
    expect(record.runId).not.toBe(record.token);
    expect(record.deadlines.claimMs - record.startedAtMs).toBe(CLAIM_MS);
  });

  it('refuses a record that also names a skipped worker as a target', async () => {
    const { deps } = make();
    const skipped = { role: 'worker', id: 'alpha', status: 'skipped', warning: 'No owned session id.', remedy: 'Check its pane.' } as const;
    const record = value(await scheduleRefreshRun(deps, HOME, { caller: 'terminal', coordinatorPane: false }, {
      workerIds: ['beta'], skipped: [skipped],
    }));
    deps.seed(PATH, JSON.stringify({ ...record, workerIds: ['beta', 'alpha'] }));
    expect(await readRefreshRun(deps, HOME)).toMatchObject({
      ok: false, error: { message: expect.stringContaining('invalid fields'), hint: expect.stringContaining('Check refresh-run.json') },
    });
  });

  it('refuses a second schedule while the claim is pending or the runner is live', async () => {
    const { deps } = make();
    const [first, second] = await Promise.all([schedule(deps), schedule(deps)]);
    const record = value(first.ok ? first : second);
    const held = first.ok ? second : first;
    expect(held.ok).toBe(false);
    if (held.ok) return;
    expect(exitCodeFor(held.error)).toBe(1);
    expect(held.error.message).toContain('a refresh run is already live');
    expect(held.error.hint).toContain('"factory refresh --result"');
    expect(held.error.hint).toContain('"factory refresh --cancel"');

    value(await claimRefreshRun(deps, HOME, record.token));
    expect(await schedule(deps)).toEqual(held);
  });

  it('lets one runner claim the valid token once and refuses a different token', async () => {
    const { deps } = make();
    const record = value(await schedule(deps));
    const wrong = record.token.replace(/.$/, (last) => last === '0' ? '1' : '0');
    expect(await claimRefreshRun(deps, HOME, wrong)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    const [claimed, replay] = await Promise.all([
      claimRefreshRun(deps, HOME, record.token), claimRefreshRun(deps, HOME, record.token),
    ]);
    const runner = value(claimed.ok ? claimed : replay);
    expect(runner).toMatchObject({ state: 'waiting', runner: { pid: deps.pid, startMs: expect.any(Number) } });
    expect(await readOwnRefreshRun(deps, HOME, record.token)).toEqual(ok(runner));
    expect(claimed.ok ? replay : claimed).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('frees the record at the claim deadline and refuses a late claim', async () => {
    const { deps } = make();
    const record = value(await schedule(deps));
    deps.advance(CLAIM_MS - 1);
    expect(await refreshRunIsLive(deps, record)).toEqual(ok(true));
    deps.advance(1);
    expect(await claimRefreshRun(deps, HOME, record.token)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    const next = value(await schedule(deps));
    expect(next.token).not.toBe(record.token);
  });

  it('leaves a claimed run unchanged when the scheduler reports a missed claim', async () => {
    const { deps } = make();
    const runner = await claim(deps);
    const before = deps.files.get(PATH);
    const fault = { warning: 'the claim wait ended', remedy: 'Run "factory refresh --result".' };
    expect(await failUnclaimedRefreshRun(deps, HOME, runner.token, fault)).toEqual(ok(runner));
    expect(deps.files.get(PATH)).toBe(before);
  });

  it('does not fail a new schedule with the previous run token', async () => {
    const { deps } = make();
    const previous = value(await schedule(deps));
    deps.advance(CLAIM_MS);
    const next = value(await schedule(deps));
    const fault = { warning: 'the claim wait ended', remedy: 'Run "factory refresh --result".' };
    expect(await failUnclaimedRefreshRun(deps, HOME, previous.token, fault)).toMatchObject({
      ok: false, error: { message: expect.stringContaining('run changed'), hint: expect.stringContaining('factory refresh --result') },
    });
    expect(await readRefreshRun(deps, HOME)).toEqual(ok(next));
  });

  it.each(['ended', 'reused'] as const)('frees a partial record when the runner PID has %s', async (kind) => {
    const { deps, endRunner, reusePid } = make();
    const runner = await claim(deps);
    const outcome = { role: 'worker', id: 'alpha', status: 'resumed' } as const;
    value(await updateRefreshRun(deps, HOME, runner.token, { kind: 'outcome', outcome }));
    if (kind === 'ended') endRunner();
    else reusePid();
    const next = value(await schedule(deps));
    expect(next).toMatchObject({ state: 'scheduled', acting: null, outcomes: [], runner: null });
    expect(next.token).not.toBe(runner.token);
    expect(await readOwnRefreshRun(deps, HOME, runner.token)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('refuses a new schedule when a live process start cannot be verified', async () => {
    const { deps } = make();
    const runner = await claim(deps);
    const unverifiable = { ...deps, run: async () => failure('no process start') };
    expect(await schedule(unverifiable)).toMatchObject({ ok: false, error: { message: expect.stringContaining('cannot check') } });
    expect(await readRefreshRun(deps, HOME)).toEqual(ok(runner));
  });

  it('refuses a record link and never changes its target', async () => {
    const { deps } = make();
    const record = value(await schedule(deps));
    const target = '/w/other/record';
    const linked = make({ [PATH]: target }).deps;
    const text = JSON.stringify(record);
    linked.seed(target, text);
    linked.seedDir(LAYOUT.runtimeDir);
    expect(await schedule(linked)).toMatchObject({ ok: false, error: { kind: 'safety', message: expect.stringContaining('is a link'), hint: expect.any(String) } });
    expect(linked.files.get(target)).toBe(text);
  });

  it.each([
    ['invalid JSON', (text: string) => text.slice(0, -2), 'not valid JSON'],
    ['invalid fields', (text: string) => text.replace('scheduled', 'unknown'), 'invalid fields'],
    ['oversize content', (text: string) => text.padEnd(maxFileBytes + 1), 'larger than'],
  ])('refuses %s and preserves the file', async (_name, change, reason) => {
    const { deps } = make();
    const record = value(await schedule(deps));
    const broken = change(JSON.stringify(record));
    deps.seed(PATH, broken);
    expect(await schedule(deps)).toMatchObject({ ok: false, error: { message: expect.stringContaining(reason), hint: expect.any(String) } });
    expect(deps.files.get(PATH)).toBe(broken);
  });

  it('keeps the acting worker ID after the runner ends without an outcome', async () => {
    const { deps, endRunner } = make();
    const runner = await claim(deps);
    value(await updateRefreshRun(deps, HOME, runner.token, { kind: 'acting', role: 'worker', id: 'alpha' }));
    endRunner();
    const interrupted = value(await readRefreshRun(deps, HOME));
    expect(interrupted).toMatchObject({ acting: 'alpha', actingRole: 'worker', outcomes: [] });
  });

  it('allows cancellation before the coordinator act and retains an unsettled worker action', async () => {
    const { deps } = make();
    const { token } = await claim(deps);
    value(await updateRefreshRun(deps, HOME, token, { kind: 'acting', role: 'worker', id: 'alpha' }));
    expect(value(await cancelRefreshRun(deps, HOME))).toMatchObject({ state: 'cancelled', acting: 'alpha' });
    expect(await readOwnRefreshRun(deps, HOME, token)).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(await schedule(deps)).toMatchObject({ ok: false, error: { message: expect.stringContaining('already live') } });
    const outcome = { role: 'worker', id: 'alpha', status: 'resumed' } as const;
    expect(value(await updateRefreshRun(deps, HOME, token, { kind: 'outcome', outcome }))).toMatchObject({ state: 'cancelled', acting: null, outcomes: [outcome] });
    expect((await schedule(deps)).ok).toBe(true);
  });

  it('reopens the original wait when the coordinator is not idle at the final check', async () => {
    const { deps } = make();
    const { token } = await claim(deps);
    const phase = value(await updateRefreshRun(deps, HOME, token, { kind: 'wait-coordinator' }));
    value(await updateRefreshRun(deps, HOME, token, { kind: 'acting', role: 'coordinator', id: 'node' }));
    expect(value(await updateRefreshRun(deps, HOME, token, { kind: 'clear-acting' }))).toEqual(phase);
    expect(value(await cancelRefreshRun(deps, HOME)).state).toBe('cancelled');
  });

  it('sets the coordinator cap once and refuses cancellation after the coordinator act starts', async () => {
    const { deps } = make();
    const { token } = await claim(deps);
    const deadline = deps.now().getTime() + refreshWait.idleCapMs;
    const phase = value(await updateRefreshRun(deps, HOME, token, { kind: 'wait-coordinator' }));
    expect(phase.deadlines.coordinatorMs).toBe(deadline);
    deps.advance(1000);
    expect(await updateRefreshRun(deps, HOME, token, { kind: 'wait-coordinator' })).toEqual(ok(phase));
    value(await updateRefreshRun(deps, HOME, token, { kind: 'acting', role: 'coordinator', id: 'node' }));
    expect(await cancelRefreshRun(deps, HOME)).toMatchObject({ ok: false, error: { message: expect.stringContaining('coordinator act') } });
    const outcome = { role: 'coordinator', id: 'node', status: 'resumed' } as const;
    value(await updateRefreshRun(deps, HOME, token, { kind: 'outcome', outcome }));
    expect(value(await updateRefreshRun(deps, HOME, token, { kind: 'done' }))).toMatchObject({ state: 'done', acting: null, outcomes: [outcome] });
  });
});
