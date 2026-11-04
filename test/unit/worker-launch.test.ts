import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliResult } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { stripScript } from '../../src/launch/argv.js';
import { launchConfirm } from '../../src/names.js';
import { launchWorker, newProxyAnswers, type WorkerLaunch, type WorkerLaunchRequest } from '../../src/workers/launch.js';
import { createFakeDeps, exited, type FakeDeps, type FetchHandler, type RunCall } from '../helpers/fake-deps.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tmuxHandler, type TmuxFixture, type TmuxLog } from '../helpers/tmux-fake.js';
import { atWait, endsPane, startsSession, withProgram, type Program } from '../helpers/worker-program.js';

const HOME = '/h/node';
const COPY = '/h/node/work-copies/web/alpha';
const COPY_BETA = '/h/node/work-copies/web/beta';
const SETTINGS_FILE = `${COPY}/.claude/settings.local.json`;
const INBOX = '/h/node/.factory/workers/alpha/inbox';
const LOCAL_URL = 'http://127.0.0.1:8080/secret-path';
const OTHER_URL = 'http://127.0.0.1:9090';
const UUID = '0b9f3c1e-5d2a-4e7b-9c10-a1b2c3d4e5f6';
const FIRST_NEW_PANE = '%3';
const POINTER = '/h/node/.factory/workers/alpha/last-session';

interface Setup {
  readonly tmux?: TmuxFixture;
  readonly fetch?: FetchHandler;
  readonly env?: Record<string, string | undefined>;
  readonly links?: Record<string, string>;
  /** An answer for a tmux call, or undefined to let the fake answer. */
  readonly answer?: (call: RunCall) => CliResult<RunOutput> | undefined;
  readonly work?: readonly string[];
  /** What the program of a new pane does while the launch waits. Default: a launch with a resume id starts its session. */
  readonly program?: Program;
}

interface Made {
  readonly deps: FakeDeps;
  readonly tmux: TmuxLog;
  /** What happened, in order: `fetch`, `warn` and `tmux <command>`. */
  readonly events: string[];
}

const answers: FetchHandler = () => ok({ status: 200 });
const silent: FetchHandler = () => failure('no answer');

/** The config with two proxies. The session uses no proxy unless the change says so. */
const configWith = (
  change: { session?: string; workers?: Record<string, { proxy: string }>; onFail?: 'stop' | 'direct' } = {},
): FactoryConfig => {
  const config = sampleConfig();
  return {
    ...config,
    core: {
      ...config.core,
      proxies: [
        { id: 'local', base_url: LOCAL_URL, health: '/health', on_fail: change.onFail ?? 'stop' },
        { id: 'other', base_url: OTHER_URL, health: '/up', on_fail: 'stop' },
      ],
      session: { ...config.core.session, proxy: change.session ?? 'none' },
      workers: change.workers ?? {},
    },
  };
};

/** The factory has the session `demo`. The environment of the process names a proxy, which no launch may use. */
const make = (setup: Setup = {}): Made => {
  const { handler, log } = tmuxHandler({ sessions: { demo: HOME }, ...setup.tmux });
  const events: string[] = [];
  const base = createFakeDeps({
    env: { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://evil.example:1', ...setup.env },
    run: (call) => {
      events.push(`tmux ${call.args[0]}`);
      return setup.answer?.(call) ?? handler(call);
    },
    fetch: (url) => {
      events.push('fetch');
      return (setup.fetch ?? answers)(url);
    },
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  for (const folder of setup.work ?? [COPY]) base.seedDir(folder);
  const deps: FakeDeps = {
    ...base,
    warn: (message) => {
      events.push('warn');
      base.warn(message);
    },
  };
  return { deps: withProgram(deps, log, setup.program ?? startsSession(HOME, 'alpha')), tmux: log, events };
};

const request =(change: Partial<WorkerLaunchRequest> = {}): WorkerLaunchRequest => ({
  home: HOME,
  config: configWith(),
  workerId: 'alpha',
  workCopy: COPY,
  retry: 'worker new',
  ...change,
});

const failed = async (made: Made, change: Partial<WorkerLaunchRequest> = {}) => {
  const result = await launchWorker(made.deps, request(change));
  if (result.ok) throw new Error('the launch should have failed');
  return result.error;
};

/** The program and the words of the last pane that the launch made: everything after `--` in the call of `split-window`. */
const wordsOf = (tmux: TmuxLog): readonly string[] => {
  const split = [...tmux.calls].reverse().find((call) => call.args[0] === 'split-window');
  if (split === undefined) return [];
  return split.args.slice(split.args.indexOf('--') + 1);
};

/**
 * One launch that must work. Every launch test goes through this function (TP-61), so each one asserts three facts: the
 * program starts in auto mode with no flag that skips the checks; the proxy of the argument list is the proxy of the config
 * and never the proxy of the environment; and the health check of a proxy happens before the pane.
 */
const launched = async (
  made: Made,
  expected: { readonly proxy: string | null },
  change: Partial<WorkerLaunchRequest> = {},
): Promise<WorkerLaunch> => {
  const result = await launchWorker(made.deps, request(change));
  if (!result.ok) throw new Error(result.error.message);
  const words = wordsOf(made.tmux);
  const mode = words.indexOf('--permission-mode');
  expect(words[mode + 1]).toBe('auto');
  expect(words.filter((word) => /dangerously|bypass|skip/i.test(word))).toEqual([]);
  expect(words.filter((word) => word.startsWith('ANTHROPIC_BASE_URL='))).toEqual(
    expected.proxy === null ? [] : [`ANTHROPIC_BASE_URL=${expected.proxy}`],
  );
  if (expected.proxy !== null) {
    expect(made.events.indexOf('fetch')).toBeGreaterThanOrEqual(0);
    expect(made.events.indexOf('fetch')).toBeLessThan(made.events.indexOf('tmux split-window'));
  }
  return result.value;
};

const panesOf = (made: Made): number => made.tmux.panes().length;
const START_PANES = 3;

describe('the launch of a worker: the pane and the argument list', () => {
  it('makes one pane in the workers window, in the work copy, marks it, and gives the argument list of a worker', async () => {
    const made = make();
    const outcome = await launched(made, { proxy: null });
    expect(outcome).toEqual({ paneId: FIRST_NEW_PANE, proxy: null, warnings: [] });
    expect(wordsOf(made.tmux)).toEqual([
      '/bin/sh',
      '-c',
      stripScript,
      'factory-launch',
      'env',
      '-u',
      'ANTHROPIC_BASE_URL',
      'PATH=/bin',
      'FACTORY_HOME=/h/node',
      'FACTORY_SESSION=alpha',
      `FACTORY_INBOX=${INBOX}`,
      'claude',
      '--permission-mode',
      'auto',
      '--effort',
      'high',
      '--add-dir',
      INBOX,
    ]);
    expect(made.tmux.commands()).toEqual([
      `split-window -d -P -F #{pane_id} -t =demo:workers -c ${COPY} -- ${wordsOf(made.tmux).join(' ')}`,
      `set-option -p -t ${FIRST_NEW_PANE} @worker alpha`,
      'select-layout -t =demo:workers tiled',
      expect.stringMatching(`^display-message -p -t ${FIRST_NEW_PANE} #\\{pane_id\\}\\|`),
    ]);
    expect(made.tmux.panes().at(-1)).toMatchObject({
      id: FIRST_NEW_PANE,
      window: 'workers',
      cwd: COPY,
      options: { '@worker': 'alpha' },
    });
  });

  it('strips the variables of a parent session and removes the proxy variable before the program', async () => {
    const made = make();
    await launched(made, { proxy: null });
    const words = wordsOf(made.tmux);
    const unset = words.flatMap((word, index) => (words[index - 1] === '-u' ? [word] : []));
    expect(unset).toEqual(['ANTHROPIC_BASE_URL']);
    expect(words.slice(0, 4)).toEqual(['/bin/sh', '-c', stripScript, 'factory-launch']);
    expect(words.indexOf('claude')).toBeGreaterThan(words.lastIndexOf('-u'));
  });

  it('takes the effort and the model from the session settings of the config', async () => {
    const config = configWith();
    const made = make();
    await launched(made, { proxy: null }, {
      config: { ...config, core: { ...config.core, session: { ...config.core.session, effort: 'max', model: 'opus' } } },
    });
    const words = wordsOf(made.tmux);
    expect(words.slice(words.indexOf('claude'))).toEqual([
      'claude',
      '--permission-mode',
      'auto',
      '--effort',
      'max',
      '--model',
      'opus',
      '--add-dir',
      INBOX,
    ]);
  });

  it.each([['Alpha'], ['a b'], ['-a'], ['__proto__'], ['']])('refuses the worker id %j, which is not a slug, before any call', async (workerId) => {
    const made = make();
    const error = await failed(made, { workerId, config: configWith({ session: 'local' }) });
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('not a slug');
    expect(made.events).toEqual([]);
  });

  it('refuses a work copy that is not an absolute path before any call', async () => {
    const made = make();
    const error = await failed(made, { workCopy: 'work-copies/web/alpha' });
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('not an absolute path');
    expect(made.events).toEqual([]);
  });

  it.each([
    ['a folder that does not exist', [] as string[], undefined],
    ['a file', [] as string[], 'file'],
  ])('refuses a work copy that is %s, and starts nothing', async (_name, work, kind) => {
    const made = make({ work });
    if (kind === 'file') made.deps.seed(COPY, 'text');
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(COPY);
    expect(error.hint).toBe('Restore the folder. Then run "factory worker resume alpha" to try again.');
    expect(made.events).toEqual([]);
    expect(panesOf(made)).toBe(START_PANES);
  });

  it('stops with exit 4 for a work copy that is a link, and starts nothing', async () => {
    const made = make({ links: { [COPY]: '/elsewhere/copy' } });
    made.deps.seedDir('/elsewhere/copy');
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.events).toEqual([]);
  });

  describe('a work copy that is not the folder of this worker below the work copies folder', () => {
    it.each([
      ['the home folder of the user', '/Users/someone'],
      ['the factory folder', HOME],
      ['the coordinator folder', `${HOME}/coordinator`],
      ['the clone of a project', `${HOME}/web`],
      ['the work copies folder', `${HOME}/work-copies`],
      ['the folder of a project', `${HOME}/work-copies/web`],
      ['the folder of another worker', COPY_BETA],
      ['a folder below the work copy', `${COPY}/sub`],
      ['a path with a dot-dot part that leads to the work copy', `${HOME}/work-copies/web/../web/alpha`],
      ['a path with a dot-dot part that leads out of the factory folder', `${HOME}/work-copies/web/alpha/../../../../x/web/alpha`],
      ['a path with a trailing slash', `${COPY}/`],
      ['a folder outside the factory folder', '/elsewhere/web/alpha'],
    ])('stops with exit 4 for %s, and starts nothing', async (_name, workCopy) => {
      const made = make({ work: [workCopy, COPY] });
      const error = await failed(made, { workCopy });
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(error.message).toContain('work copy');
      expect(error.message).toContain('work-copies/');
      expect(made.events).toEqual([]);
      expect(panesOf(made)).toBe(START_PANES);
    });

    it.each([
      ['the work copies folder', `${HOME}/work-copies`],
      ['the folder of the project', `${HOME}/work-copies/web`],
    ])('stops with exit 4 when %s is a link, and starts nothing', async (_name, link) => {
      const made = make({ links: { [link]: '/elsewhere/folder' } });
      made.deps.seedDir('/elsewhere/folder');
      const error = await failed(made);
      expect(exitCodeOf[error.kind]).toBe(4);
      expect(made.events).toEqual([]);
      expect(panesOf(made)).toBe(START_PANES);
    });

    it('stops with exit 4 for a link at the work copy even when the target is a folder of the factory folder', async () => {
      const made = make({ links: { [COPY]: `${HOME}/web` } });
      made.deps.seedDir(`${HOME}/web`);
      expect(exitCodeOf[(await failed(made)).kind]).toBe(4);
      expect(made.events).toEqual([]);
    });

    it('starts the worker in the folder that the project and the id give', async () => {
      const made = make();
      await launched(made, { proxy: null });
      expect(made.tmux.panes().at(-1)).toMatchObject({ cwd: COPY });
    });
  });

  it('fails when the session of tmux does not exist, and leaves no pane', async () => {
    const made = make({ tmux: { sessions: {} } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('split-window');
    expect(made.events).toEqual(['tmux split-window']);
    expect(panesOf(made)).toBe(0);
  });

  it('fails when tmux prints something that is not a pane id, and sets no mark', async () => {
    const made = make({ answer: (call) => (call.args[0] === 'split-window' ? exited(0, 'zzz-odd-output\n') : undefined) });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).not.toContain('zzz-odd-output');
    expect(made.events).toEqual(['tmux split-window']);
  });
});

describe('the launch of a worker: the window workers stays tiled', () => {
  const IDS = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'];
  const copyOf = (id: string): string => `/h/node/work-copies/web/${id}`;

  it('tiles the window after the pane and its mark, so that eight launches in a row find room', async () => {
    // Three splits fit in a window that is never tiled. Each launch tiles the window again.
    const made = make({ tmux: { splitsBeforeTile: 3 }, work: IDS.map(copyOf) });
    for (const id of IDS) {
      const result = await launchWorker(made.deps, request({ workerId: id, workCopy: copyOf(id) }));
      expect(result.ok, `${id}: ${result.ok ? '' : result.error.message}`).toBe(true);
    }
    expect(made.tmux.panes().filter((pane) => pane.window === 'workers')).toHaveLength(1 + IDS.length);
    expect(made.tmux.layouts()).toEqual({ 'demo:workers': 'tiled' });
  });

  it('runs the tile call after the mark of each launch and before the next split', async () => {
    const made = make({ work: [COPY, COPY_BETA] });
    await launched(made, { proxy: null });
    await launched(made, { proxy: null }, { workerId: 'beta', workCopy: COPY_BETA });
    expect(made.events).toEqual([
      'tmux split-window',
      'tmux set-option',
      'tmux select-layout',
      'tmux display-message',
      'tmux split-window',
      'tmux set-option',
      'tmux select-layout',
      'tmux display-message',
    ]);
  });

  it('makes a failed tile a warning, not a failure: the pane stays with its mark, and the warning names layout', async () => {
    const made = make({ tmux: { failing: 'select-layout' } });
    const outcome = await launched(made, { proxy: null });
    expect(outcome.paneId).toBe(FIRST_NEW_PANE);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toContain('select-layout');
    expect(outcome.warnings[0]).toContain('"factory layout"');
    expect(made.tmux.panes().at(-1)).toMatchObject({ id: FIRST_NEW_PANE, options: { '@worker': 'alpha' } });
  });

  it('keeps the warning of the proxy beside the warning of the tile', async () => {
    const made = make({ tmux: { failing: 'select-layout' }, fetch: silent });
    const outcome = await launched(made, { proxy: null }, { config: configWith({ session: 'local', onFail: 'direct' }) });
    expect(outcome.warnings).toHaveLength(2);
  });

  it('names layout and then worker resume when the split fails, because the window has no room', async () => {
    const made = make({ tmux: { splitsBeforeTile: 0 } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('no space for new pane');
    const hint = error.hint ?? '';
    expect(hint).toContain('"factory layout"');
    expect(hint).toContain('"factory worker resume alpha"');
    expect(hint.indexOf('"factory layout"')).toBeLessThan(hint.indexOf('"factory worker resume alpha"'));
    expect(panesOf(made)).toBe(START_PANES);
  });
});

describe('the launch of a worker: the proxy (TP-61)', () => {
  it('uses no proxy when the config names none, whatever the environment says', async () => {
    const made = make();
    const outcome = await launched(made, { proxy: null });
    expect(outcome.proxy).toBeNull();
    expect(made.deps.fetched).toEqual([]);
    expect(made.events).toEqual(['tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
  });

  it('checks the proxy of the session once before the pane, and passes its URL', async () => {
    const made = make();
    const outcome = await launched(made, { proxy: LOCAL_URL }, { config: configWith({ session: 'local' }) });
    expect(outcome.proxy).toBe('local (127.0.0.1:8080)');
    expect(made.deps.fetched).toEqual([`${LOCAL_URL}/health`]);
    expect(made.events).toEqual(['fetch', 'tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
  });

  it('prefers the proxy of the worker over the proxy of the session', async () => {
    const made = make();
    await launched(made, { proxy: OTHER_URL }, { config: configWith({ session: 'local', workers: { alpha: { proxy: 'other' } } }) });
    expect(made.deps.fetched).toEqual([`${OTHER_URL}/up`]);
  });

  it('lets one worker use no proxy while the session uses one, with no request', async () => {
    const made = make();
    await launched(made, { proxy: null }, { config: configWith({ session: 'local', workers: { alpha: { proxy: 'none' } } }) });
    expect(made.deps.fetched).toEqual([]);
  });

  it('uses the proxy of the session for a worker that has no entry of its own', async () => {
    const made = make();
    await launched(made, { proxy: LOCAL_URL }, { config: configWith({ session: 'local', workers: { beta: { proxy: 'other' } } }) });
    expect(made.deps.fetched).toEqual([`${LOCAL_URL}/health`]);
  });

  it('stops before the pane when the proxy does not answer, names the setting and the command, and never the URL', async () => {
    const made = make({ fetch: silent });
    const error = await failed(made, { config: configWith({ session: 'local' }) });
    expect(error.kind).toBe('failure');
    expect(error.message).toBe('local (127.0.0.1:8080) does not answer');
    expect(error.hint).toBe(
      'Start the proxy, or set session.proxy to none for the session. Then run "factory worker new" again.',
    );
    expect(`${error.message} ${error.hint}`).not.toContain('secret-path');
    expect(made.events).toEqual(['fetch']);
    expect(panesOf(made)).toBe(START_PANES);
  });

  it('names the setting of the worker when the proxy of the worker does not answer', async () => {
    const made = make({ fetch: silent });
    const error = await failed(made, {
      config: configWith({ workers: { alpha: { proxy: 'other' } } }),
      retry: 'worker resume alpha',
    });
    expect(error.hint).toBe(
      'Start the proxy, or set workers.alpha.proxy to none for the session. Then run "factory worker resume alpha" again.',
    );
    expect(made.events).toEqual(['fetch']);
  });

  it('starts with no proxy and returns a warning when the proxy does not answer and the config says direct', async () => {
    const made = make({ fetch: silent });
    const outcome = await launched(made, { proxy: null }, { config: configWith({ session: 'local', onFail: 'direct' }) });
    expect(outcome.proxy).toBeNull();
    expect(outcome.warnings).toEqual([
      'local (127.0.0.1:8080) does not answer. on_fail is direct: the session starts without a proxy.',
    ]);
  });

  it('stops for a proxy that the config does not define, names the setting, and makes no request', async () => {
    const made = make();
    const error = await failed(made, { config: configWith({ workers: { alpha: { proxy: 'missing' } } }) });
    expect(error.message).toBe('workers.alpha.proxy names a proxy that is not defined in proxies');
    expect(made.events).toEqual([]);
  });

  describe('one request for each proxy in a run', () => {
    const second = (): Partial<WorkerLaunchRequest> => ({ workerId: 'beta', workCopy: COPY_BETA });

    it('checks a proxy that two workers share once, when the launches share the answers of the run', async () => {
      const made = make({ work: [COPY, COPY_BETA] });
      const answersOfRun = newProxyAnswers();
      const config = configWith({ session: 'local' });
      await launched(made, { proxy: LOCAL_URL }, { config, proxyAnswers: answersOfRun });
      await launched(made, { proxy: LOCAL_URL }, { config, proxyAnswers: answersOfRun, ...second() });
      expect(made.deps.fetched).toEqual([`${LOCAL_URL}/health`]);
      expect(made.tmux.panes().filter((pane) => pane.options['@worker'] !== undefined)).toHaveLength(2);
    });

    it('checks each distinct proxy once', async () => {
      const made = make({ work: [COPY, COPY_BETA] });
      const answersOfRun = newProxyAnswers();
      const config = configWith({ session: 'local', workers: { beta: { proxy: 'other' } } });
      await launched(made, { proxy: LOCAL_URL }, { config, proxyAnswers: answersOfRun });
      await launched(made, { proxy: OTHER_URL }, { config, proxyAnswers: answersOfRun, ...second() });
      await launched(made, { proxy: OTHER_URL }, { config, proxyAnswers: answersOfRun, ...second() });
      expect(made.deps.fetched).toEqual([`${LOCAL_URL}/health`, `${OTHER_URL}/up`]);
    });

    it('keeps the answer of a proxy that did not answer, so a later launch of the run does not ask again', async () => {
      const made = make({ work: [COPY, COPY_BETA], fetch: silent });
      const answersOfRun = newProxyAnswers();
      const config = configWith({ session: 'local' });
      const first = await failed(made, { config, proxyAnswers: answersOfRun });
      const next = await failed(made, { config, proxyAnswers: answersOfRun, ...second() });
      expect(next).toEqual(first);
      expect(made.deps.fetched).toHaveLength(1);
    });

    it('checks the proxy again for a launch that shares no answers', async () => {
      const made = make({ work: [COPY, COPY_BETA] });
      const config = configWith({ session: 'local' });
      await launched(made, { proxy: LOCAL_URL }, { config });
      await launched(made, { proxy: LOCAL_URL }, { config, ...second() });
      expect(made.deps.fetched).toHaveLength(2);
    });
  });
});

describe('the launch of a worker: the settings of the work copy (TP-15, TP-16)', () => {
  const put = (made: Made, text: string): void => made.deps.seed(SETTINGS_FILE, text);

  it.each([
    ['a skip setting', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }), 'skips the permission checks'],
    ['a prompt skip setting', JSON.stringify({ skipDangerousModePermissionPrompt: true }), 'skips the permission checks'],
    ['a FACTORY_ key in env', JSON.stringify({ env: { FACTORY_SESSION: 'other' } }), 'FACTORY_'],
    ['a proxy in env', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://other.example' } }), 'ANTHROPIC_BASE_URL'],
  ])('stops with exit 4 for a settings file with %s, and starts nothing', async (_name, text, reason) => {
    const made = make();
    put(made, text);
    const error = await failed(made, { config: configWith({ session: 'local' }) });
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('work-copies/web/alpha/.claude/settings.local.json');
    expect(error.message).toContain(reason);
    expect(error.hint).toContain('Remove the setting');
    expect(made.events).toEqual([]);
    expect(made.deps.fetched).toEqual([]);
    expect(panesOf(made)).toBe(START_PANES);
  });

  it('stops with exit 4 for a settings file that can not be read, and starts nothing', async () => {
    const made = make();
    put(made, '{}');
    const read = made.deps.fs.readTextLimited;
    const deps: FakeDeps = {
      ...made.deps,
      fs: { ...made.deps.fs, readTextLimited: async (path, max) => (path === SETTINGS_FILE ? failure(`cannot read ${path}: EACCES`) : read(path, max)) },
    };
    const error = await failed({ ...made, deps });
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('did not read');
    expect(made.events).toEqual([]);
  });

  it('stops with exit 4 for a settings file that is a link, and starts nothing', async () => {
    const made = make({ links: { [SETTINGS_FILE]: '/elsewhere/settings.json' } });
    put(made, '{}');
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('a link');
    expect(made.events).toEqual([]);
  });

  it('stops with exit 4 for a settings folder that is a link, and starts nothing', async () => {
    const made = make({ links: { [`${COPY}/.claude`]: '/elsewhere/claude' } });
    made.deps.seedDir('/elsewhere/claude');
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('is a link');
    expect(made.events).toEqual([]);
  });

  it('makes the settings check before the proxy request and before any tmux call', async () => {
    const made = make({ fetch: silent });
    put(made, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    const error = await failed(made, { config: configWith({ session: 'local' }) });
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.events).toEqual([]);
  });

  it('stops once, and starts nothing, when several settings are wrong', async () => {
    const made = make();
    put(made, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, env: { FACTORY_HOME: '/x', ANTHROPIC_BASE_URL: 'http://o.example' } }));
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.events).toEqual([]);
  });

  it('goes on after a warning, prints the warning at once, and keeps the launch', async () => {
    const made = make();
    put(made, JSON.stringify({ model: 'sonnet' }));
    await launched(made, { proxy: null });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('is a settings file in a work copy');
    expect(made.events).toEqual(['warn', 'tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
  });

  it('gives no warning for the settings file that the program writes itself', async () => {
    const made = make();
    put(made, `${JSON.stringify(ownSettingsEntries, null, 2)}\n`);
    await launched(made, { proxy: null });
    expect(made.deps.warned).toEqual([]);
  });
});

describe('the launch of a worker: the instruction files above the work copy (TP-18)', () => {
  it.each([
    ['CLAUDE.md in the work copies folder', '/h/node/work-copies/CLAUDE.md'],
    ['AGENTS.md in the folder of the project', '/h/node/work-copies/web/AGENTS.md'],
    ['.claude/CLAUDE.md in the work copies folder', '/h/node/work-copies/.claude/CLAUDE.md'],
    ['CLAUDE.local.md in the folder of the project', '/h/node/work-copies/web/CLAUDE.local.md'],
  ])('warns for %s, exits 0, and launches', async (_name, path) => {
    const made = make({ env: { HOME: '/h' } });
    made.deps.seed(path, '');
    const outcome = await launched(made, { proxy: null });
    expect(outcome.paneId).toBe(FIRST_NEW_PANE);
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain(path);
    expect(made.deps.warned[0]).toContain('Move each file out of those folders, or keep it on purpose');
    expect(made.events).toEqual(['warn', 'tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
  });

  it('names every file that it finds in one line', async () => {
    const made = make();
    made.deps.seed('/h/node/work-copies/CLAUDE.md', '');
    made.deps.seed('/h/node/work-copies/web/GEMINI.md', '');
    await launched(made, { proxy: null });
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('/h/node/work-copies/web/GEMINI.md, /h/node/work-copies/CLAUDE.md');
  });

  it('gives no warning for the instruction files of the project in the work copy itself', async () => {
    const made = make();
    made.deps.seed(`${COPY}/CLAUDE.md`, '');
    made.deps.seed(`${COPY}/AGENTS.md`, '');
    await launched(made, { proxy: null });
    expect(made.deps.warned).toEqual([]);
  });

  it('gives no warning for a file in the factory folder or above it: the start of the factory warns about those', async () => {
    const made = make();
    made.deps.seed('/h/node/CLAUDE.md', '');
    made.deps.seed('/h/AGENTS.md', '');
    await launched(made, { proxy: null });
    expect(made.deps.warned).toEqual([]);
  });

  it('gives a line for a folder that can not be read, and goes on', async () => {
    const made = make();
    const lstat = made.deps.fs.lstat;
    const deps: FakeDeps = {
      ...made.deps,
      fs: { ...made.deps.fs, lstat: async (path) => (path === '/h/node/work-copies/CLAUDE.md' ? failure(`cannot read ${path}: EACCES`) : lstat(path)) },
    };
    const outcome = await launched({ ...made, deps }, { proxy: null });
    expect(outcome.paneId).toBe(FIRST_NEW_PANE);
    expect(made.deps.warned).toHaveLength(1);
    expect(made.deps.warned[0]).toContain('did not look in /h/node/work-copies');
  });

  it('warns before the proxy request and before the pane', async () => {
    const made = make();
    made.deps.seed('/h/node/work-copies/CLAUDE.md', '');
    await launched(made, { proxy: LOCAL_URL }, { config: configWith({ session: 'local' }) });
    expect(made.events).toEqual([
      'warn',
      'fetch',
      'tmux split-window',
      'tmux set-option',
      'tmux select-layout',
      'tmux display-message',
    ]);
  });
});

describe('the launch of a worker: a launch with a resume id (TP-128)', () => {
  /** The panes that the launch read after the start, in order. */
  const readPanes = (made: Made): readonly string[] =>
    made.tmux.calls.filter((call) => call.args[0] === 'display-message').map((call) => call.args[3] ?? '');

  it('passes the id once after --resume, before the folder, and reads the new pane by its id after the mark', async () => {
    const made = make();
    const outcome = await launched(made, { proxy: null }, { resumeId: UUID });
    expect(outcome.paneId).toBe(FIRST_NEW_PANE);
    const words = wordsOf(made.tmux);
    expect(words.filter((word) => word === '--resume')).toHaveLength(1);
    expect(words[words.indexOf('--resume') + 1]).toBe(UUID);
    expect(words.indexOf('--resume')).toBeLessThan(words.indexOf('--add-dir'));
    expect(made.events).toEqual(['tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
    expect(readPanes(made)).toEqual([FIRST_NEW_PANE]);
  });

  it('checks the proxy before the pane for a resume, too', async () => {
    const made = make();
    await launched(made, { proxy: LOCAL_URL }, { resumeId: UUID, config: configWith({ session: 'local' }) });
    expect(made.events).toEqual(['fetch', 'tmux split-window', 'tmux set-option', 'tmux select-layout', 'tmux display-message']);
  });

  it('waits before each check, and confirms at the check where the SessionStart line of the new session shows', async () => {
    const made = make({ program: atWait(4, startsSession(HOME, 'alpha')) });
    await launched(made, { proxy: null }, { resumeId: UUID });
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs, launchConfirm.intervalMs, launchConfirm.intervalMs, launchConfirm.intervalMs]);
    expect(readPanes(made)).toEqual([FIRST_NEW_PANE, FIRST_NEW_PANE, FIRST_NEW_PANE, FIRST_NEW_PANE]);
  });

  it('is not confirmed (exit 3) when no line shows within the bound, and it keeps the pane', async () => {
    const made = make({ program: () => undefined });
    const error = await failed(made, { resumeId: UUID });
    expect(error.kind).toBe('not-ready');
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(`resume not confirmed: the pane ${FIRST_NEW_PANE} of the worker alpha runs`);
    expect(made.deps.sleeps).toHaveLength(launchConfirm.attempts);
    expect(readPanes(made)).toHaveLength(launchConfirm.attempts);
    expect(made.events).not.toContain('tmux kill-pane');
    expect(panesOf(made)).toBe(START_PANES + 1);
  });

  it('reads the line of the worker again at each check, so that a line that appears late still confirms', async () => {
    const made = make({ program: atWait(launchConfirm.attempts, startsSession(HOME, 'alpha')) });
    await launched(made, { proxy: null }, { resumeId: UUID });
    expect(made.deps.sleeps).toHaveLength(launchConfirm.attempts);
  });

  it.each([['not-a-uuid'], [UUID.toUpperCase()], [`${UUID} --dangerously-skip-permissions`], ['--resume']])(
    'refuses the resume id %s, and starts nothing',
    async (resumeId) => {
      const made = make();
      const error = await failed(made, { resumeId });
      expect(error.kind).toBe('failure');
      expect(error.message).not.toContain(resumeId);
      expect(made.events).toEqual([]);
      expect(panesOf(made)).toBe(START_PANES);
    },
  );

  it('reports a pane that is dead at once as a failed resume (exit 1), names the pane, and names the pointer file to delete', async () => {
    const made = make({ tmux: { newPanesEndAtOnce: true } });
    const error = await failed(made, { resumeId: UUID });
    expect(error.kind).toBe('failure');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`resume failed: the pane ${FIRST_NEW_PANE} of the worker alpha ended after the start`);
    expect(error.hint).toContain(`delete the file ${POINTER}. Then run "factory worker resume alpha".`);
    expect(error.hint).not.toContain('dismiss');
    expect(readPanes(made)).toEqual([FIRST_NEW_PANE]);
    expect(made.deps.sleeps).toHaveLength(1);
  });

  it('keeps the pane and its mark after a failed launch: nothing is undone', async () => {
    const made = make({ tmux: { newPanesEndAtOnce: true } });
    await failed(made, { resumeId: UUID });
    expect(made.tmux.panes().at(-1)).toMatchObject({ id: FIRST_NEW_PANE, dead: true, options: { '@worker': 'alpha' } });
    expect(made.events).not.toContain('tmux kill-pane');
  });

  it('reports a pane that tmux removed during the wait as gone, and stops the wait there', async () => {
    const made = make({ program: atWait(3, endsPane) });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`resume failed: the pane ${FIRST_NEW_PANE} of the worker alpha is gone after the start`);
    expect(made.deps.sleeps).toHaveLength(3);
  });

  it('counts a pane that tmux can not read as gone', async () => {
    const made = make({ tmux: { failing: 'display-message' } });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('is gone');
  });

  it('reports a pane whose start command is not the launch of the worker as failed, and keeps the pane', async () => {
    const made = make({
      answer: (call) => (call.args[0] === 'display-message' ? exited(0, `${FIRST_NEW_PANE}|4000|0|1|0|0|0|sleep 300\n`) : undefined),
    });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`resume failed: the pane ${FIRST_NEW_PANE} of the worker alpha no longer runs the launch of the worker`);
    expect(made.events).not.toContain('tmux kill-pane');
  });

  it('reports a call of tmux that does not run as a failure, and keeps the pane', async () => {
    const made = make({ answer: (call) => (call.args[0] === 'display-message' ? failure('tmux did not answer in time') : undefined) });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`cannot read the pane ${FIRST_NEW_PANE}: tmux did not answer in time`);
    expect(error.hint).toBe('Run "factory worker list" to see if the worker alpha has a live pane.');
    expect(panesOf(made)).toBe(START_PANES + 1);
  });

  it('reports an answer that is not the line of one pane as a failure', async () => {
    const made = make({ answer: (call) => (call.args[0] === 'display-message' ? exited(0, 'zzz-odd-output\n') : undefined) });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`cannot read the pane ${FIRST_NEW_PANE}`);
    expect(error.message).not.toContain('zzz-odd-output');
  });

  it('is not blocked by a pane whose worker mark is not a worker id', async () => {
    const made = make({ tmux: { panes: [{ session: 'demo', options: { '@worker': 'not a worker id' } }] } });
    const outcome = await launched(made, { proxy: null }, { resumeId: UUID });
    expect(outcome.paneId).toBe('%4');
  });

  it('judges the new pane by its pane id: an older dead pane of the same worker does not matter', async () => {
    const made = make({
      tmux: {
        panes: [
          { session: 'demo', options: { '@worker': 'beta' } },
          { session: 'demo', dead: true, options: { '@worker': 'alpha' } },
        ],
      },
    });
    const outcome = await launched(made, { proxy: null }, { resumeId: UUID });
    expect(outcome.paneId).toBe('%5');
  });
});

describe('the launch of a worker: a launch with no resume id checks the pane once', () => {
  const readPanes = (made: Made): number => made.tmux.calls.filter((call) => call.args[0] === 'display-message').length;

  it('waits one interval, reads the pane once, and needs no line of the worker', async () => {
    const made = make({ program: () => undefined });
    const outcome = await launched(made, { proxy: null });
    expect(outcome.paneId).toBe(FIRST_NEW_PANE);
    expect(made.deps.sleeps).toEqual([launchConfirm.intervalMs]);
    expect(readPanes(made)).toBe(1);
  });

  it('fails when the pane is dead at once, and offers the resume command only', async () => {
    const made = make({ tmux: { newPanesEndAtOnce: true } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`the pane ${FIRST_NEW_PANE} of the worker alpha ended after the start`);
    expect(error.hint).toBe('Run "factory worker resume alpha" to try again.');
    expect(made.tmux.panes().at(-1)).toMatchObject({ id: FIRST_NEW_PANE, dead: true, options: { '@worker': 'alpha' } });
  });

  it('fails when tmux removed the pane during the wait', async () => {
    const made = make({ program: atWait(1, endsPane) });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`the pane ${FIRST_NEW_PANE} of the worker alpha is gone after the start`);
    expect(error.hint).not.toContain(POINTER);
  });
});

describe('the launch of a worker: a failure after the pane exists', () => {
  it('closes the pane by its id when the mark can not be set, and fails', async () => {
    const made = make({ tmux: { failing: 'set-option' } });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('set-option');
    expect(error.message).toContain(FIRST_NEW_PANE);
    expect(error.hint).toBe('Run "factory worker resume alpha" to try again.');
    expect(made.events).toEqual(['tmux split-window', 'tmux set-option', 'tmux kill-pane']);
    expect(made.tmux.calls.at(-1)?.args).toEqual(['kill-pane', '-t', FIRST_NEW_PANE]);
    expect(panesOf(made)).toBe(START_PANES);
  });

  it('reports a program that ended before the mark as a failed resume, with the delete of the pointer file, not as a pane that stays open', async () => {
    const made = make({ tmux: { newPanesGoneAtOnce: true } });
    const error = await failed(made, { resumeId: UUID });
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`resume failed: the pane ${FIRST_NEW_PANE} of the worker alpha is gone after the start`);
    expect(error.message).not.toContain('stays open');
    expect(error.hint).toContain(`delete the file ${POINTER}. Then run "factory worker resume alpha".`);
    expect(panesOf(made)).toBe(START_PANES);
    expect(made.deps.sleeps).toEqual([]);
  });

  it('reports a program of a new worker that ended before the mark as an ended pane, with the resume command', async () => {
    const made = make({ tmux: { newPanesGoneAtOnce: true } });
    const error = await failed(made);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(`the pane ${FIRST_NEW_PANE} of the worker alpha is gone after the start`);
    expect(error.hint).toBe('Run "factory worker resume alpha" to try again.');
    expect(error.hint).not.toContain(POINTER);
  });

  it('names the pane that stays when it can not be closed', async () => {
    const made = make({
      tmux: { failing: 'set-option' },
      answer: (call) => (call.args[0] === 'kill-pane' ? exited(1, '', 'no way\n') : undefined),
    });
    const error = await failed(made);
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(`the pane ${FIRST_NEW_PANE} stays`);
    expect(error.hint).toBe(`Close the pane with "tmux kill-pane -t ${FIRST_NEW_PANE}". Then run "factory worker resume alpha" to try again.`);
  });
});
