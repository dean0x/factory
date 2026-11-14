import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { ok } from '../../src/core/result.js';
import { launchConfirm, roleText, tmuxNames } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { chooseProxy, newProxyAnswers, sessionProxyWish } from '../../src/workers/launch.js';
import { writeCoordinatorSession, writeLastSeen } from '../../src/workers/last-seen.js';
import { coordinatorResumeOf, noPaneWarning, recoverWorkers, workersWithoutPane, type RecoveryReport } from '../../src/workers/recovery.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { createFakeDeps, type FakeDeps, type FetchHandler } from '../helpers/fake-deps.js';
import { seedAcceptedSetup, seedOwnHooks, seedUnacceptedSetup, STATE_ENV } from '../helpers/role-delivery.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tmuxHandler, type PaneFixture, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { endsPane, startsSessions, withProgram, type Program } from '../helpers/worker-program.js';

const HOME = '/h/node';
const NODE = 'demo';
const COPIES = '/h/node/work-copies/web';
const IDS = ['alpha', 'beta', 'gamma'] as const;
const SESSION: Readonly<Record<string, string>> = {
  alpha: '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6',
  beta: 'b4a2d3e5-2c3d-4e6f-9a01-23456789abcd',
  gamma: 'c5b3e4f6-3d4e-4f70-8b12-34567890bcde',
};
const COORDINATOR_SESSION = '0b6c1f9e-2d3a-4b5c-8d7e-9f0a1b2c3d4e';
const LOCAL_URL = 'http://127.0.0.1:8080/secret-path';
const OTHER_URL = 'http://127.0.0.1:9090';
const FOLDER_SETTINGS = (id: string): string => `${COPIES}/${id}/.claude/settings.local.json`;

const byResume: Readonly<Record<string, string>> = Object.fromEntries(IDS.map((id) => [SESSION[id], id]));

/** Every resume starts its session, except the resume of this session: its pane ends at once. */
const endsPaneFor =
  (session: string): Program =>
  async (wait) => {
    if (wait.resumeId === session) return endsPane(wait);
    return startsSessions(HOME, byResume)(wait);
  };

/** Every resume starts its session, except the resume of this session: its pane runs, and the session writes no line. */
const silentFor =
  (session: string): Program =>
  async (wait) => {
    if (wait.resumeId === session) return;
    return startsSessions(HOME, byResume)(wait);
  };

interface Setup {
  readonly tmux?: TmuxFixture;
  /** The workers that have a record. Default: alpha, beta and gamma. */
  readonly workers?: readonly string[];
  /** The text of the pointer of a worker. Null: no pointer. Default: the session of the worker. */
  readonly pointers?: Readonly<Record<string, string | null>>;
  /** The session marker of the line of a worker. Null: the line has none. Default: the id of the worker. */
  readonly markers?: Readonly<Record<string, string | null>>;
  /** The text of the settings file of the work copy of a worker. */
  readonly settings?: Readonly<Record<string, string>>;
  /** What the program of a new pane does. Default: each resume starts the session of its worker. */
  readonly program?: Program;
  readonly fetch?: FetchHandler;
  readonly links?: Record<string, string>;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** What happened, in order: `sleep` and `tmux <command>`. */
  readonly events: string[];
}

const answers: FetchHandler = () => ok({ status: 200 });
const silent: FetchHandler = () => failure('no answer');

/** The config with two proxies. The session uses no proxy unless the change says so. */
const configWith = (change: { session?: string; workers?: Record<string, { proxy: string }> } = {}): FactoryConfig => {
  const config = sampleConfig();
  return {
    ...config,
    core: {
      ...config.core,
      proxies: [
        { id: 'local', base_url: LOCAL_URL, health: '/health', on_fail: 'stop' },
        { id: 'other', base_url: OTHER_URL, health: '/up', on_fail: 'stop' },
      ],
      session: { ...config.core.session, proxy: change.session ?? 'none' },
      workers: change.workers ?? {},
    },
  };
};

const must = (result: { readonly ok: boolean; readonly error?: { readonly message: string } }): void => {
  if (!result.ok) throw new Error(result.error?.message ?? 'the seed failed');
};

/** The factory has the session `demo`, the records and the pointers of the setup, and no pane of a worker. */
const make = async (setup: Setup = {}): Promise<Made> => {
  const { handler, log } = tmuxHandler({ sessions: { demo: HOME }, ...setup.tmux });
  const events: string[] = [];
  const base = createFakeDeps({
    env: { PATH: '/bin', ...STATE_ENV },
    run: (call) => {
      events.push(`tmux ${call.args[0]}`);
      return handler(call);
    },
    fetch: setup.fetch ?? answers,
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  const deps: FakeDeps = {
    ...base,
    sleep: async (ms) => {
      events.push('sleep');
      await base.sleep(ms);
    },
  };
  const lines = new Set<string>();
  for (const id of setup.workers ?? IDS) {
    must(await writeWorkerRecord(deps, HOME, { id, project: 'web', workCopy: `${COPIES}/${id}`, branch: `worker/${id}` }));
    deps.seedDir(`${COPIES}/${id}`);
    seedOwnHooks(deps, `${COPIES}/${id}`);
    const pointer = setup.pointers !== undefined && id in setup.pointers ? setup.pointers[id] : SESSION[id];
    if (pointer === null || pointer === undefined) continue;
    deps.seed(workerPathsOf(HOME, id).lastSessionFile, `${pointer}\n`);
    const marker = setup.markers !== undefined && id in setup.markers ? setup.markers[id] : id;
    // Two pointers can name one session: the first worker writes its line, and the line stays.
    if (pointer in byResume && !lines.has(pointer)) {
      lines.add(pointer);
      must(await writeLastSeen(deps, HOME, pointer, { kind: 'event', event: 'Stop' }, marker === null ? undefined : marker));
    }
  }
  for (const [id, text] of Object.entries(setup.settings ?? {})) deps.seed(FOLDER_SETTINGS(id), text);
  const program = setup.program ?? startsSessions(HOME, byResume);
  events.splice(0);
  deps.warned.splice(0);
  return { deps: withProgram(deps, log, program), tmux: log, events };
};

const recovered = async (
  made: Made,
  config: FactoryConfig = configWith(),
  proxyAnswers = newProxyAnswers(),
): Promise<RecoveryReport> => {
  const result = await recoverWorkers(made.deps, { home: HOME, config, proxyAnswers });
  if (!result.ok) throw new Error(`${result.error.message} ${result.error.hint ?? ''}`);
  return result.value;
};

/** The panes that carry a worker mark, in the order of their making. */
const workerPanes = (made: Made) => made.tmux.panes().filter((pane) => pane.options[tmuxNames.optionWorker] !== undefined);

const workersOf = (made: Made): string[] => workerPanes(made).map((pane) => pane.options[tmuxNames.optionWorker] ?? '');

/** The session id that the program of a pane resumes, by worker. */
const resumesOf = (made: Made): Record<string, string | undefined> =>
  Object.fromEntries(
    workerPanes(made).map((pane) => {
      const at = pane.command.indexOf('--resume');
      return [pane.options[tmuxNames.optionWorker] ?? '', at < 0 ? undefined : pane.command[at + 1]];
    }),
  );

const splits = (made: Made): number => made.tmux.commands().filter((command) => command.startsWith('split-window')).length;

describe('the session that the coordinator resumes after a kill of the server (TP-37)', () => {
  const POINTER = layoutOf(HOME).coordinatorLastSessionFile;

  const bare = (): FakeDeps => createFakeDeps({ env: { PATH: '/bin' } });

  /** The pointer and the last-seen line of the coordinator session, with the marker of the writer. */
  const seeded = async (marker: string | null = NODE): Promise<FakeDeps> => {
    const deps = bare();
    must(await writeCoordinatorSession(deps, HOME, COORDINATOR_SESSION));
    must(await writeLastSeen(deps, HOME, COORDINATOR_SESSION, { kind: 'event', event: 'Stop' }, marker === null ? undefined : marker));
    return deps;
  };

  it('gives the id of the pointer when the line of that session belongs to the node', async () => {
    const deps = await seeded();
    expect(await coordinatorResumeOf(deps, HOME, NODE)).toEqual({ resumeId: COORDINATOR_SESSION, warning: null });
  });

  it('starts a new conversation, with no warning, when there is no pointer', async () => {
    expect(await coordinatorResumeOf(bare(), HOME, NODE)).toEqual({ resumeId: null, warning: null });
  });

  it.each([
    ['a pointer that holds no session id', async (deps: FakeDeps) => deps.seed(POINTER, 'junk\n'), 'does not hold a session id'],
    [
      'a pointer to a session that has no line',
      async (deps: FakeDeps) => deps.seed(POINTER, `${COORDINATOR_SESSION}\n`),
      'has no last-seen line',
    ],
  ])('starts a new conversation, with one warning that names the pointer file, for %s', async (_name, seed, reason) => {
    const deps = bare();
    await seed(deps);
    const choice = await coordinatorResumeOf(deps, HOME, NODE);
    expect(choice.resumeId).toBeNull();
    expect(choice.warning).toContain(POINTER);
    expect(choice.warning).toContain(reason);
    expect(choice.warning).toContain('NOT resumed');
  });

  it.each([
    ['a line of a worker', 'alpha'],
    ['a line with no session marker', null],
  ])('starts a new conversation, with one warning, for %s', async (_name, marker) => {
    const deps = await seeded(marker);
    const choice = await coordinatorResumeOf(deps, HOME, NODE);
    expect(choice.resumeId).toBeNull();
    expect(choice.warning).toContain(POINTER);
    expect(choice.warning).toContain('NOT resumed');
  });

  it('starts a new conversation, with one warning, when the pointer can not be read', async () => {
    const deps = await seeded();
    const failing: FakeDeps = {
      ...deps,
      fs: { ...deps.fs, lstat: async (path) => (path === POINTER ? failure(`cannot read ${path}: EACCES`) : deps.fs.lstat(path)) },
    };
    const choice = await coordinatorResumeOf(failing, HOME, NODE);
    expect(choice.resumeId).toBeNull();
    expect(choice.warning).toContain('EACCES');
    expect(choice.warning).toContain(POINTER);
  });
});

describe('the recovery of the workers: each worker with a usable id (TP-34)', () => {
  it('resumes each recorded worker with its own session id, and reports them in the order of the ids', async () => {
    const made = await make();
    expect(await recovered(made)).toEqual({ resumed: ['alpha', 'beta', 'gamma'], skipped: [], failed: [] });
    expect(workersOf(made)).toEqual(['alpha', 'beta', 'gamma']);
    expect(resumesOf(made)).toEqual(SESSION);
    expect(made.deps.warned).toEqual([]);
  });

  it('resumes one worker at a time: the confirm of one worker ends before the next pane', async () => {
    const made = await make();
    await recovered(made);
    const first = made.events.indexOf('tmux split-window');
    const second = made.events.indexOf('tmux split-window', first + 1);
    expect(made.events.slice(first, second)).toContain('sleep');
    expect(made.deps.sleeps.length).toBeGreaterThanOrEqual(IDS.length);
  });

  it('starts each pane in the work copy of its worker, in the window of the workers', async () => {
    const made = await make();
    await recovered(made);
    expect(workerPanes(made).map((pane) => [pane.window, pane.cwd])).toEqual(
      IDS.map((id) => [tmuxNames.windowWorkers, `${COPIES}/${id}`]),
    );
  });

  it('does nothing, and makes no tmux call, when no worker has a record', async () => {
    const made = await make({ workers: [] });
    expect(await recovered(made)).toEqual({ resumed: [], skipped: [], failed: [] });
    expect(made.events).toEqual([]);
  });

  it('prints each warning that a launch returns, and counts the worker as resumed', async () => {
    const made = await make({ tmux: { failing: 'select-layout' } });
    expect(await recovered(made)).toEqual({ resumed: ['alpha', 'beta', 'gamma'], skipped: [], failed: [] });
    expect(made.deps.warned).toHaveLength(IDS.length);
    expect(made.deps.warned[0]).toContain('not tiled');
  });
});

describe('the recovery of the workers: a worker with no usable id is skipped (TP-35, TP-134)', () => {
  const POINTER = workerPathsOf(HOME, 'beta').lastSessionFile;

  it.each([
    ['no pointer', { pointers: { beta: null } }, 'no last-seen line'],
    ['a pointer that is not a session id', { pointers: { beta: 'not-a-uuid' } }, 'does not hold a session id'],
    ['a line of the coordinator', { markers: { beta: NODE } }, `belongs to the session of ${NODE}`],
    ['a line of another worker', { markers: { beta: 'alpha' } }, 'belongs to the session of alpha'],
    ['an old-hook line with no session marker', { markers: { beta: null } }, 'records no session marker'],
  ] satisfies readonly (readonly [string, Setup, string])[])(
    'skips the worker with one warning, and starts no conversation for it, for %s',
    async (_name, setup, reason) => {
      const made = await make(setup);
      expect(await recovered(made)).toEqual({ resumed: ['alpha', 'gamma'], skipped: ['beta'], failed: [] });
      expect(workersOf(made)).toEqual(['alpha', 'gamma']);
      expect(splits(made)).toBe(2);
      expect(made.deps.warned).toHaveLength(1);
      const [warning = ''] = made.deps.warned;
      expect(warning).toContain('beta');
      expect(warning).toContain(POINTER);
      expect(warning).toContain('factory worker resume beta');
      expect(warning).toContain(reason);
    },
  );

  it('skips both workers whose pointers name one session', async () => {
    const made = await make({ pointers: { beta: SESSION['alpha'] ?? '' } });
    expect(await recovered(made)).toEqual({ resumed: ['gamma'], skipped: ['alpha', 'beta'], failed: [] });
    expect(made.deps.warned).toHaveLength(2);
  });

  it('skips a worker whose pointer can not be read, and names the fault', async () => {
    const made = await make({ workers: ['alpha'] });
    const pointer = workerPathsOf(HOME, 'alpha').lastSessionFile;
    const failing: Made = {
      ...made,
      deps: {
        ...made.deps,
        fs: { ...made.deps.fs, lstat: async (path) => (path === pointer ? failure(`cannot read ${path}: EACCES`) : made.deps.fs.lstat(path)) },
      },
    };
    expect(await recovered(failing)).toEqual({ resumed: [], skipped: ['alpha'], failed: [] });
    expect(failing.deps.warned).toHaveLength(1);
    expect(failing.deps.warned[0]).toContain('EACCES');
    expect(splits(made)).toBe(0);
  });

  it('skips a folder with no valid record, names the folder, and goes on', async () => {
    const made = await make({ workers: ['alpha'] });
    made.deps.seed(`${layoutOf(HOME).workersDir}/zeta/worker.json`, 'not json');
    expect(await recovered(made)).toEqual({ resumed: ['alpha'], skipped: ['zeta'], failed: [] });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('zeta');
  });
});

describe('the recovery of the workers: a launch that fails does not stop the run (TP-36)', () => {
  it('reports the failed worker by name, resumes the next ones, and does not try again', async () => {
    const made = await make({ program: endsPaneFor(SESSION['alpha'] ?? '') });
    expect(await recovered(made)).toEqual({ resumed: ['beta', 'gamma'], skipped: [], failed: ['alpha'] });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('alpha');
    expect(made.deps.warned[0]).toContain('factory worker resume alpha');
    expect(splits(made)).toBe(3);
    expect(workersOf(made)).toEqual(['beta', 'gamma']);
  });

  it('never removes the session of tmux for a failed worker', async () => {
    const made = await make({ program: endsPaneFor(SESSION['alpha'] ?? '') });
    await recovered(made);
    expect(made.tmux.commands().filter((command) => command.startsWith('kill-session'))).toEqual([]);
    expect(made.tmux.sessions().has(NODE)).toBe(true);
  });

  it('keeps the pane of a resume that the line of the new session does not confirm, warns, and goes on', async () => {
    const made = await make({ program: silentFor(SESSION['alpha'] ?? '') });
    expect(await recovered(made)).toEqual({ resumed: ['beta', 'gamma'], skipped: [], failed: ['alpha'] });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('resume not confirmed');
    expect(made.deps.warned[0]).toContain('alpha');
    expect(workersOf(made)).toEqual(['alpha', 'beta', 'gamma']);
    expect(made.tmux.commands().filter((command) => command.startsWith('kill-pane'))).toEqual([]);
    expect(splits(made)).toBe(3);
    expect(made.deps.sleeps.filter((ms) => ms === launchConfirm.intervalMs).length).toBeGreaterThanOrEqual(launchConfirm.attempts);
  });
});

describe('the recovery of the workers: the settings of the work copy (TP-17, AC-7)', () => {
  it('starts no pane for a work copy with a wrong settings file, warns with the file and the remedy, and goes on', async () => {
    const bad = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } });
    const made = await make({ settings: { beta: bad } });
    expect(await recovered(made)).toEqual({ resumed: ['alpha', 'gamma'], skipped: [], failed: ['beta'] });
    expect(made.deps.warned).toHaveLength(1);
    const [warning = ''] = made.deps.warned;
    expect(warning).toContain('beta');
    expect(warning).toContain('work-copies/web/beta/.claude/settings.local.json');
    expect(warning).toContain('Remove the setting');
    expect(splits(made)).toBe(2);
    expect(workersOf(made)).toEqual(['alpha', 'gamma']);
  });

  it('accepts the settings file that the program writes itself', async () => {
    const own = `${JSON.stringify(ownSettingsEntries, null, 2)}\n`;
    const made = await make({ settings: { alpha: own, beta: own, gamma: own } });
    expect((await recovered(made)).resumed).toEqual(['alpha', 'beta', 'gamma']);
    expect(made.deps.warned).toEqual([]);
  });
});

describe('the recovery of the workers: the role text of each worker', () => {
  const hooksOff = JSON.stringify({ ...ownSettingsEntries, disableAllHooks: true });
  const settingsOf = (id: string): string => `${COPIES}/${id}/.claude/settings.local.json`;
  const stoppedNothing = (made: Made): void => {
    expect(made.deps.terminated).toEqual([]);
    expect(made.tmux.commands().filter((command) => command.startsWith('kill-'))).toEqual([]);
  };

  it('starts no pane for a work copy whose settings turn off every hook, warns with the effect, and goes on', async () => {
    const made = await make({ settings: { beta: hooksOff } });
    expect(await recovered(made)).toEqual({ resumed: ['alpha', 'gamma'], skipped: [], failed: ['beta'] });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('beta');
    expect(made.deps.warned[0]).toContain('turns off every hook');
    expect(workersOf(made)).toEqual(['alpha', 'gamma']);
    stoppedNothing(made);
  });

  it('starts no pane for a work copy with no own hook entry, and the warning names each command on its own line', async () => {
    const made = await make();
    made.deps.files.delete(settingsOf('gamma'));
    expect(await recovered(made)).toEqual({ resumed: ['alpha', 'beta'], skipped: [], failed: ['gamma'] });
    const [warning = ''] = made.deps.warned;
    expect(warning).toContain('gamma');
    expect(warning.split('\n')).toEqual(expect.arrayContaining(['factory upgrade', 'factory worker resume gamma', 'factory dismiss gamma']));
    expect(workersOf(made)).toEqual(['alpha', 'beta']);
    stoppedNothing(made);
  });

  it('starts no worker when the setup text is not accepted: one warning for each worker, and the report names all of them', async () => {
    const made = await make();
    seedUnacceptedSetup(made.deps, HOME, 'Write tests first.\n');
    expect(await recovered(made)).toEqual({ resumed: [], skipped: [], failed: ['alpha', 'beta', 'gamma'] });
    expect(made.deps.warned).toHaveLength(3);
    for (const [index, id] of IDS.entries()) expect(made.deps.warned[index]).toContain(`${id} did not start again`);
    expect(made.deps.warned[0]).toContain(roleText.reasons.notAccepted);
    expect(splits(made)).toBe(0);
    stoppedNothing(made);
  });

  it('starts no worker for a text above the cap, and names its size and the cap', async () => {
    const made = await make();
    seedAcceptedSetup(made.deps, HOME, `${'x'.repeat(roleText.maxChars - 500)}\n`);
    expect((await recovered(made)).failed).toEqual(['alpha', 'beta', 'gamma']);
    expect(made.deps.warned[0]).toMatch(/the role text has \d+ characters, and the cap is 9000 characters/);
    expect(splits(made)).toBe(0);
  });

  it('starts every worker for the setup text that the owner accepted', async () => {
    const made = await make();
    seedAcceptedSetup(made.deps, HOME, 'Write tests first.\n');
    expect((await recovered(made)).resumed).toEqual(['alpha', 'beta', 'gamma']);
    expect(made.deps.warned).toEqual([]);
  });
});

describe('the recovery of the workers: the proxy is asked once for each run (TP-62, AC-25)', () => {
  it('sends one health check for three workers on one proxy', async () => {
    const made = await make();
    await recovered(made, configWith({ session: 'local' }));
    expect(made.deps.fetched).toHaveLength(1);
    expect(made.deps.warned).toEqual([]);
  });

  it('sends one health check for each distinct proxy', async () => {
    const made = await make();
    await recovered(
      made,
      configWith({ workers: { alpha: { proxy: 'local' }, beta: { proxy: 'other' }, gamma: { proxy: 'local' } } }),
    );
    expect(made.deps.fetched).toHaveLength(2);
  });

  it('asks no proxy that the answers of the run hold already', async () => {
    const made = await make();
    const config = configWith({ session: 'local' });
    const proxyAnswers = newProxyAnswers();
    const first = await chooseProxy(made.deps, config, sessionProxyWish(config), proxyAnswers);
    expect(first.ok).toBe(true);
    await recovered(made, config, proxyAnswers);
    expect(made.deps.fetched).toHaveLength(1);
  });

  it('warns for each worker, and asks the proxy once, when the proxy does not answer', async () => {
    const made = await make({ fetch: silent });
    expect(await recovered(made, configWith({ session: 'local' }))).toEqual({
      resumed: [],
      skipped: [],
      failed: ['alpha', 'beta', 'gamma'],
    });
    expect(made.deps.fetched).toHaveLength(1);
    expect(made.deps.warned).toHaveLength(3);
    expect(made.deps.warned.join(' ')).not.toContain(LOCAL_URL);
    expect(splits(made)).toBe(0);
  });
});

describe('the recovery of the workers: a list that can not be read', () => {
  it('fails with a security stop when the workers folder is a link, and starts no pane', async () => {
    const made = await make({ links: { [layoutOf(HOME).workersDir]: '/elsewhere/workers' }, workers: [] });
    const result = await recoverWorkers(made.deps, { home: HOME, config: configWith(), proxyAnswers: newProxyAnswers() });
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(splits(made)).toBe(0);
  });
});

describe('the workers of a session that runs already: the workers with no live pane', () => {
  const paneOf = (worker: string, dead = false): PaneFixture => ({
    session: NODE,
    options: { [tmuxNames.optionWorker]: worker },
    ...(dead ? { dead: true } : {}),
  });

  it('names the recorded workers that have no pane, in order of the ids, and starts no pane', async () => {
    const made = await make({ tmux: { panes: [paneOf('beta')] } });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: true, value: ['alpha', 'gamma'] });
    expect(splits(made)).toBe(0);
  });

  it('counts a pane whose program ended as no live pane', async () => {
    const made = await make({ tmux: { panes: [paneOf('alpha', true), paneOf('beta'), paneOf('gamma')] } });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: true, value: ['alpha'] });
  });

  it('names no worker when each recorded worker has a live pane', async () => {
    const made = await make({ tmux: { panes: IDS.map((id) => paneOf(id)) } });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: true, value: [] });
  });

  it('reads no pane list when no worker is recorded', async () => {
    const made = await make({ workers: [] });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: true, value: [] });
    expect(made.events).toEqual([]);
  });

  it('fails when the list of panes can not be read', async () => {
    const made = await make({ tmux: { failing: 'list-panes' } });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: false });
  });

  it('fails with a security stop when the workers folder is a link', async () => {
    const made = await make({ links: { [layoutOf(HOME).workersDir]: '/elsewhere/workers' }, workers: [] });
    expect(await workersWithoutPane(made.deps, HOME, NODE)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('writes one warning with each worker, the command that starts it, and the command that starts every worker', () => {
    const warning = noPaneWarning(['alpha', 'gamma']);
    expect(warning).toContain('alpha (start it with "factory worker resume alpha")');
    expect(warning).toContain('gamma (start it with "factory worker resume gamma")');
    expect(warning).toContain('"factory reboot"');
    expect(warning).toContain('stopped on purpose must stay stopped');
  });
});
