import { setImmediate as yieldTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { AttachedEnd } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { env, files, heavyLock, lockWords } from '../../src/names.js';
import {
  createFakeDeps,
  exited,
  FAKE_PROGRAM_ARGV,
  withFailingRemoves,
  type FakeDeps,
  type FakeOptions,
} from '../helpers/fake-deps.js';
import { psStarts } from '../helpers/ps-fake.js';
import { captureSink } from '../helpers/sink.js';

const STATE = '/h/.local/state/factory';
const LOCK = `${STATE}/${files.heavyLock}`;
const PRIORITY = `${STATE}/${files.heavyPriority}`;
const OWN_PID = 4242;
const OWN_START = Date.UTC(2030, 0, 1, 12);
const HOLDER_PID = 777;
const OTHER_PID = 888;
const HOLDER_START = Date.UTC(2029, 11, 31);
const HEX = '0123456789abcdef';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const OK_END: AttachedEnd = { kind: 'code', code: 0 };

const holderText = (pid: number, startMs: number): string => `${pid}-${startMs}-${HEX}\n`;
const LIVE_HOLDER = holderText(HOLDER_PID, HOLDER_START);

/** Fake deps for macOS with a home folder, and a fake `ps` that knows the start of the own process and of the two other holders. */
const fake = (options: FakeOptions = {}): FakeDeps =>
  createFakeDeps({
    env: { HOME: '/h' },
    os: 'darwin',
    run: psStarts({ [OWN_PID]: OWN_START, 5000: OWN_START, [HOLDER_PID]: HOLDER_START, [OTHER_PID]: HOLDER_START }),
    ...options,
  });

const lock = async (deps: FakeDeps, argv: readonly string[] = ['run', '--', 'npm', 'test']) => {
  const sink = captureSink();
  const code = await runCli(['lock', ...argv], deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

type Outcome = Awaited<ReturnType<typeof lock>>;

/** The checks of an outcome that the program decides: the exit code, no stdout, and a first stderr line with the fixed word. */
const expectOutcome = (result: Outcome, code: number, word: string): void => {
  expect(result.code).toBe(code);
  expect(result.out).toBe('');
  expect(result.err.split('\n')[0]).toMatch(new RegExp(`^error: factory lock run: ${word}\\. `));
};

const withHeldLock = (options: FakeOptions = {}): FakeDeps => {
  const deps = fake(options);
  deps.seed(LOCK, LIVE_HOLDER);
  return deps;
};

/** A copy of the deps whose `calls`-th wait also does `action`. The copy shares the files and the clock. */
const onSleep = (deps: FakeDeps, calls: number, action: () => void): FakeDeps => {
  let count = 0;
  return {
    ...deps,
    sleep: async (ms) => {
      count += 1;
      if (count === calls) action();
      await deps.sleep(ms);
    },
  };
};

const handlerCount = (deps: FakeDeps): number => SIGNALS.reduce((sum, name) => sum + deps.signals.listenerCount(name), 0);

describe('lock run: the command line', () => {
  it.each([
    ['no subcommand', ['lock']],
    ['no double dash', ['lock', 'run']],
    ['an empty command', ['lock', 'run', '--']],
    ['an empty first word after the double dash', ['lock', 'run', '--', '']],
    ['the json flag', ['lock', 'run', '--json', '--', 'npm']],
    ['a subcommand that is not run', ['lock', 'x', '--', 'npm']],
    ['no subcommand before the double dash', ['lock', '--', 'npm']],
    ['a second word before the double dash', ['lock', 'run', 'x', '--', 'npm']],
    ['the help flag with a double dash', ['lock', 'run', '--help', '--', 'npm']],
    ['a flag that does not exist', ['lock', 'run', '--nope', '--', 'npm']],
  ])('exits 2 with the usage line and starts nothing for %s', async (_name, argv) => {
    const deps = fake();
    const sink = captureSink();
    const code = await runCli([...argv], deps, sink);
    expect(code).toBe(2);
    expect(sink.out).toEqual([]);
    expect(sink.errors.join('').split('\n')[0]).toMatch(/^error: factory lock run: USAGE\. /);
    expect(deps.attached).toEqual([]);
    expect(deps.files.size).toBe(0);
  });
});

describe('lock run: an empty word in the command', () => {
  it('passes an empty word after the first one to the child as an argument', async () => {
    const deps = fake();
    expect((await lock(deps, ['run', '--', 'printf', '%s', ''])).code).toBe(0);
    expect(deps.attached.map((call) => [call.command, ...call.args])).toEqual([['printf', '%s', '']]);
  });
});

describe('lock run: the files of the lock', () => {
  it.each([
    ['the home folder', { HOME: '/h' }, STATE],
    ['the state home', { HOME: '/h', XDG_STATE_HOME: '/x/state' }, '/x/state/factory'],
    ['an absolute state home only', { XDG_STATE_HOME: '/x/state' }, '/x/state/factory'],
    ['no variable for a state folder: the folder node variable is no path', { HOME: '/h', FACTORY_HOME: '/elsewhere', XDG_STATE_HOME: 'relative' }, STATE],
  ])('keeps the lock file in the state folder with mode 0700 and 0600, from %s', async (_name, variables, folder) => {
    const seen: { lock?: number | undefined; folder?: number | undefined; paths: string[] } = { paths: [] };
    const deps: FakeDeps = fake({
      env: variables,
      runAttached: () => {
        seen.paths = [...deps.files.keys()];
        seen.lock = deps.modes.get(`${folder}/${files.heavyLock}`);
        seen.folder = deps.modes.get(folder);
        return OK_END;
      },
    });
    expect((await lock(deps)).code).toBe(0);
    expect(seen).toEqual({ paths: [`${folder}/${files.heavyLock}`], lock: 0o600, folder: 0o700 });
  });

  it.each([
    ['the lock path', LOCK, ['run', '--', 'npm']],
    ['the priority path of a waiter', PRIORITY, ['run', '--', 'npm']],
    ['the priority path of a priority run', PRIORITY, ['run', '--priority', '--', 'npm']],
  ])('exits 4 and follows no link at %s', async (_name, linked, argv) => {
    const deps = fake({ links: { [linked]: '/outside/target' } });
    deps.seed('/outside/target', 'untouched\n');
    deps.seedDir(STATE);
    expectOutcome(await lock(deps, argv), 4, lockWords.refused);
    expect(deps.attached).toEqual([]);
    expect(deps.files.get('/outside/target')).toBe('untouched\n');
  });

  interface Damage {
    readonly path: string;
    readonly other?: true;
    readonly mode?: number;
    readonly text?: string;
  }

  it.each<[string, Damage]>([
    ['a folder of another user', { path: STATE, other: true }],
    ['a folder that a group can write', { path: STATE, mode: 0o770 }],
    ['a lock file of another user', { path: LOCK, other: true, text: LIVE_HOLDER }],
    ['a lock file that others can write', { path: LOCK, mode: 0o666, text: LIVE_HOLDER }],
    ['a priority file of another user', { path: PRIORITY, other: true, text: LIVE_HOLDER }],
    ['a priority file that a group can write', { path: PRIORITY, mode: 0o620, text: LIVE_HOLDER }],
  ])('exits 4 for %s and starts no child', async (_name, { path, other, mode, text }) => {
    for (const argv of [['run', '--', 'npm'], ['run', '--priority', '--', 'npm']]) {
      const deps = fake();
      deps.seedDir(STATE);
      if (text !== undefined) deps.seed(path, text);
      if (other === true) deps.owners.set(path, 0);
      if (mode !== undefined) deps.modes.set(path, mode);
      expectOutcome(await lock(deps, argv), 4, lockWords.refused);
      expect(deps.attached).toEqual([]);
      if (text !== undefined) expect(deps.files.get(path)).toBe(text);
    }
  });

  it('exits 1 with the NOT STARTED line and a remedy line when no folder is known', async () => {
    const deps = fake({ env: {} });
    const result = await lock(deps);
    expectOutcome(result, 1, lockWords.notStarted);
    expect(result.err.split('\n')).toHaveLength(3);
    expect(result.err).toContain('HOME');
    expect(deps.attached).toEqual([]);
  });

  it('chooses the exit code by the typed reason, not by the text', async () => {
    const base = fake();
    const sameWords = (message: string) => async () => failure(message);
    const cases: readonly [string, FakeDeps][] = [
      ['mkdir', { ...base, fs: { ...base.fs, mkdir: sameWords('cannot create: the folder belongs to another user') } }],
      ['chmod', { ...base, fs: { ...base.fs, chmod: sameWords('cannot change: can be written by a group or by other users') } }],
    ];
    base.seedDir(STATE);
    for (const [, deps] of cases) {
      expectOutcome(await lock(deps), 1, lockWords.notStarted);
      expect(deps.attached).toEqual([]);
    }
  });
});

describe('lock run: the wait', () => {
  it('tries 1,080 times 5 s apart, prints one wait line, then exits 3 with the WAIT ENDED line', async () => {
    const deps = withHeldLock();
    const result = await lock(deps);
    expectOutcome(result, 3, lockWords.waitEnded);
    expect(result.err.split('\n')).toHaveLength(3);
    expect(deps.randomTexts).toHaveLength(heavyLock.attempts);
    expect(deps.sleeps).toEqual(Array.from({ length: heavyLock.attempts - 1 }, () => heavyLock.waitMs));
    expect(deps.warned.filter((line) => line.includes(lockWords.waiting))).toHaveLength(1);
    expect(deps.warned[0]).toMatch(/^factory lock run: WAITING\. /);
    expect(deps.attached).toEqual([]);
    expect(deps.files.get(LOCK)).toBe(LIVE_HOLDER);
    // One read for the own start, and one for the start of the holder on each try.
    expect(deps.calls.filter((call) => call.command === 'ps')).toHaveLength(1 + heavyLock.attempts);
    expect(deps.terminated).toEqual([]);
    expect(handlerCount(deps)).toBe(0);
  });

  it('takes a stale lock in the first try: no WAITING line and no wait', async () => {
    const base = withHeldLock();
    const deps: FakeDeps = { ...base, isRunning: (pid) => (pid === HOLDER_PID ? ok(false) : base.isRunning(pid)) };
    expect((await lock(deps)).code).toBe(0);
    expect(base.attached).toHaveLength(1);
    expect(base.warned).toEqual([]);
    expect(base.sleeps).toEqual([]);
    expect(base.files.size).toBe(0);
  });

  it.each([
    ['a file system error', (deps: FakeDeps): FakeDeps => ({ ...deps, fs: { ...deps.fs, writeTextExclusive: async () => failure('cannot write: EIO') } })],
    ['no random text', (deps: FakeDeps): FakeDeps => ({ ...deps, randomHex: () => failure('no random text') })],
    ['a ps that fails for the own start', (deps: FakeDeps): FakeDeps => ({ ...deps, run: async () => exited(1) })],
  ])('exits 1 with the NOT STARTED line and starts no child for %s', async (_name, damage) => {
    const deps = damage(fake());
    expectOutcome(await lock(deps), 1, lockWords.notStarted);
    expect(deps.attached).toEqual([]);
    expect(handlerCount(deps)).toBe(0);
  });

  it('keeps a folder at the lock path that is older than the claim age, and all it holds, and exits 1 with the NOT STARTED line', async () => {
    const deps = fake();
    deps.seed(`${LOCK}/inside.txt`, 'keep\n');
    deps.mtimes.set(LOCK, deps.now().getTime() - heavyLock.claimStaleMs - 1);
    const result = await lock(deps);
    expectOutcome(result, 1, lockWords.notStarted);
    expect(result.err).toContain(LOCK);
    expect(deps.attached).toEqual([]);
    expect(deps.dirs.has(LOCK)).toBe(true);
    expect(deps.files.get(`${LOCK}/inside.txt`)).toBe('keep\n');
    expect(deps.files.has(`${LOCK}${heavyLock.takeoverSuffix}`)).toBe(false);
    expect(handlerCount(deps)).toBe(0);
  });
});

describe('lock run: the child', () => {
  it('runs the words after the double dash with no shell, in a held run that gets only the token as an extra variable', async () => {
    const seen: { text?: string | undefined; handlers?: number | undefined } = {};
    const deps: FakeDeps = fake({
      runAttached: () => {
        seen.text = deps.files.get(LOCK);
        seen.handlers = handlerCount(deps);
        return OK_END;
      },
    });
    expect((await lock(deps, ['run', '--', 'npm', 'test', '--json', '-h', '--priority'])).code).toBe(0);
    const token = (seen.text ?? '').trim();
    expect(token).toMatch(new RegExp(`^${OWN_PID}-${OWN_START}-[0-9a-f]{16}$`));
    expect(deps.attached).toEqual([
      {
        command: 'npm',
        args: ['test', '--json', '-h', '--priority'],
        options: {
          held: true,
          maxMs: heavyLock.maxHoldMs,
          killGraceMs: heavyLock.killGraceMs,
          extraEnv: { [env.heavyLockToken]: token },
        },
      },
    ]);
    expect(seen.handlers).toBe(0);
    expect(deps.files.size).toBe(0);
  });

  it.each([
    [0, { kind: 'code', code: 0 }],
    [3, { kind: 'code', code: 3 }],
    [4, { kind: 'code', code: 4 }],
    [7, { kind: 'code', code: 7 }],
    [143, { kind: 'signal', signal: 'SIGTERM', number: 15 }],
  ] as const)('passes the exit code %i of the child through and writes no line of its own', async (code, end) => {
    const deps = fake({ runAttached: () => end });
    const result = await lock(deps);
    expect(result).toEqual({ code, out: '', err: '' });
    expect(deps.files.size).toBe(0);
    expect(handlerCount(deps)).toBe(0);
  });

  it.each([
    ['a program that is not found', { kind: 'spawn', code: 'ENOENT' }, 1, lockWords.notFound],
    ['a program that cannot start', { kind: 'spawn', code: 'EACCES' }, 1, lockWords.notStarted],
    ['a child that runs past the max hold time', { kind: 'limit' }, 3, lockWords.holdEnded],
  ] as const)('exits with the line of the program for %s, and frees the lock', async (_name, end, code, word) => {
    const deps = fake({ runAttached: () => end });
    expectOutcome(await lock(deps), code, word);
    expect(deps.files.size).toBe(0);
    expect(deps.attached[0]?.options).toMatchObject({ held: true, maxMs: 10_800_000, killGraceMs: 10_000 });
  });

  it('leaves a lock that another run holds now, and keeps the exit code', async () => {
    const other = holderText(OTHER_PID, HOLDER_START);
    const deps: FakeDeps = fake({
      runAttached: () => {
        deps.files.set(LOCK, other);
        return { kind: 'code', code: 5 };
      },
    });
    expect((await lock(deps)).code).toBe(5);
    expect(deps.files.get(LOCK)).toBe(other);
  });

  it('adds one warning for a lock that cannot be removed, and keeps the exit code of the child', async () => {
    const deps = withFailingRemoves(fake({ runAttached: () => ({ kind: 'code', code: 7 }) }), (path) => path === LOCK, 'EBUSY');
    expect(await lock(deps)).toEqual({ code: 7, out: '', err: '' });
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain('Cannot remove');
  });

  it('adds one warning for a priority file that cannot be removed, and keeps the exit code of the child', async () => {
    const deps = withFailingRemoves(fake({ runAttached: () => ({ kind: 'code', code: 7 }) }), (path) => path === PRIORITY, 'EBUSY');
    expect(await lock(deps, ['run', '--priority', '--', 'npm'])).toEqual({ code: 7, out: '', err: '' });
    expect(deps.warned).toHaveLength(1);
  });
});

describe('lock run: a stop during the wait', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('ends the wait on %s, frees the own priority file, starts no child and exits %i', async (signal, code) => {
    const base = withHeldLock();
    const deps = onSleep(base, 2, () => {
      expect(base.files.get(PRIORITY)).toMatch(new RegExp(`^${OWN_PID}-${OWN_START}-`));
      base.signals.emit(signal);
    });
    const result = await lock(deps, ['run', '--priority', '--', 'npm']);
    expectOutcome(result, code, lockWords.stopped);
    expect(base.attached).toEqual([]);
    expect(base.files.has(PRIORITY)).toBe(false);
    expect(base.files.get(LOCK)).toBe(LIVE_HOLDER);
    expect(base.sleeps).toHaveLength(2);
    expect(handlerCount(base)).toBe(0);
  });

  it('exits 130 with the STOPPED line, not WAIT ENDED, when INT comes during the last try', async () => {
    const base = withHeldLock();
    let tries = 0;
    const deps: FakeDeps = {
      ...base,
      randomHex: (bytes) => {
        tries += 1;
        if (tries === heavyLock.attempts) base.signals.emit('SIGINT');
        return base.randomHex(bytes);
      },
    };
    expectOutcome(await lock(deps), 130, lockWords.stopped);
    expect(base.attached).toEqual([]);
    expect(base.files.get(LOCK)).toBe(LIVE_HOLDER);
    expect(handlerCount(base)).toBe(0);
  });
});

describe('lock run: a stop during the take', () => {
  it('exits 130 with the STOPPED line, frees the lock it took and starts no child, when INT comes during the create of the lock file', async () => {
    const base = fake();
    const deps: FakeDeps = {
      ...base,
      fs: {
        ...base.fs,
        writeTextExclusive: async (path, text, mode) => {
          if (path === LOCK) base.signals.emit('SIGINT');
          return base.fs.writeTextExclusive(path, text, mode);
        },
      },
    };
    expectOutcome(await lock(deps), 130, lockWords.stopped);
    expect(base.attached).toEqual([]);
    expect(base.files.has(LOCK)).toBe(false);
    expect(handlerCount(base)).toBe(0);
  });
});

describe('lock run: the program itself as the child', () => {
  const [NODE, SCRIPT] = FAKE_PROGRAM_ARGV as readonly [string, string];

  it.each([
    ['the program name', ['factory', 'node', 'x']],
    ['the program name in a path', ['/usr/local/bin/factory', 'x']],
    ['the real path of the script', [SCRIPT, 'x']],
    ['a link to the script', ['/w/bin/fac', 'x']],
    ['the node program and the script', [NODE, SCRIPT, 'x']],
    ['the node name and a relative path of the script', ['node', '../opt/fake/lib/program/cli.js', 'x']],
  ])('exits 4 and starts nothing for %s', async (_name, child) => {
    const deps = fake({ links: { '/w/bin/fac': SCRIPT } });
    deps.seed(SCRIPT, '');
    deps.seed('/w/bin/fac', '');
    expectOutcome(await lock(deps, ['run', '--', ...child]), 4, lockWords.refused);
    expect(deps.attached).toEqual([]);
    expect(deps.files.size).toBe(2);
  });

  it('runs another script with the node program, and a program with a path that is no script', async () => {
    for (const child of [[NODE, '/w/other.js'], ['/w/tools/run-tests', 'x']]) {
      const deps = fake();
      deps.seed('/w/other.js', '');
      deps.seed('/w/tools/run-tests', '');
      expect((await lock(deps, ['run', '--', ...child])).code).toBe(0);
      expect(deps.attached).toHaveLength(1);
    }
  });

  it('exits 1 and starts nothing when the path of the running script is not known', async () => {
    const deps = fake({ programArgv: [] });
    expectOutcome(await lock(deps), 1, lockWords.notStarted);
    expect(deps.attached).toEqual([]);
  });
});

describe('lock run: the priority file', () => {
  const LIVE_PRIORITY = holderText(OTHER_PID, HOLDER_START);

  it('takes no free lock for a waiter while a live priority file of another run exists', async () => {
    const deps = fake();
    deps.seed(PRIORITY, LIVE_PRIORITY);
    expectOutcome(await lock(deps), 3, lockWords.waitEnded);
    expect(deps.attached).toEqual([]);
    expect(deps.files.has(LOCK)).toBe(false);
    expect(deps.files.get(PRIORITY)).toBe(LIVE_PRIORITY);
  });

  it('lets the priority run take the lock first, and the waiter after it', async () => {
    const base = withHeldLock({
      runAttached: (call) => {
        order.push(call.args[0] ?? '');
        return OK_END;
      },
    });
    const order: string[] = [];
    const shared = onSleep(base, 3, () => void base.files.delete(LOCK));
    // The priority run wakes later than the waiter, so without the priority file the waiter would be the first to try after the holder has gone.
    const late: FakeDeps = {
      ...shared,
      pid: 5000,
      sleep: async (ms) => {
        await shared.sleep(ms);
        for (let turn = 0; turn < 5; turn += 1) await yieldTurn();
      },
    };
    const [waiter, priority] = await Promise.all([lock(shared, ['run', '--', 'echo', 'N']), lock(late, ['run', '--priority', '--', 'echo', 'P'])]);
    expect([priority.code, waiter.code]).toEqual([0, 0]);
    expect(order).toEqual(['P', 'N']);
    expect([...base.files.keys()]).toEqual([]);
  });

  it('exits 3 with the PRIORITY HELD line for a second live priority run, and starts no child', async () => {
    const deps = fake();
    deps.seed(PRIORITY, LIVE_PRIORITY);
    expectOutcome(await lock(deps, ['run', '--priority', '--', 'npm']), 3, lockWords.priorityHeld);
    expect(deps.attached).toEqual([]);
    expect(deps.files.has(LOCK)).toBe(false);
    expect(deps.files.get(PRIORITY)).toBe(LIVE_PRIORITY);
  });

  it.each([
    [
      'a writer that is gone',
      (deps: FakeDeps): FakeDeps => ({ ...deps, isRunning: (pid) => (pid === OTHER_PID ? ok(false) : deps.isRunning(pid)) }),
    ],
    [
      'a file older than the longest wait',
      (deps: FakeDeps): FakeDeps => {
        deps.mtimes.set(PRIORITY, deps.now().getTime() - heavyLock.priorityMaxAgeMs);
        return deps;
      },
    ],
  ])('counts a priority file with %s as no priority, with one warning, and signals no process', async (_name, damage) => {
    const base = withHeldLock();
    base.seed(PRIORITY, LIVE_PRIORITY);
    const deps = damage(onSleep(base, 3, () => void base.files.delete(LOCK)));
    expect((await lock(deps)).code).toBe(0);
    expect(base.warned.filter((line) => line.includes('priority file'))).toHaveLength(1);
    expect(base.terminated).toEqual([]);
    expect(base.files.get(PRIORITY)).toBe(LIVE_PRIORITY);
  });

  it('runs a priority run over a priority file of a run that ended, with one warning and no wait', async () => {
    const base = fake();
    base.seed(PRIORITY, LIVE_PRIORITY);
    const deps: FakeDeps = { ...base, isRunning: (pid) => (pid === OTHER_PID ? ok(false) : base.isRunning(pid)) };
    expect((await lock(deps, ['run', '--priority', '--', 'npm'])).code).toBe(0);
    expect(base.attached).toHaveLength(1);
    expect(base.warned).toEqual([expect.stringContaining('priority file')]);
    expect(base.sleeps).toEqual([]);
    expect(base.files.size).toBe(0);
  });

  const seeded =
    (text: string) =>
    (deps: FakeDeps): FakeDeps => {
      deps.seed(PRIORITY, text);
      return deps;
    };

  it.each([
    ['text that does not parse', seeded('not a token\n')],
    ['a file over the byte cap', seeded(`${LIVE_PRIORITY}${'x'.repeat(heavyLock.maxPriorityBytes)}`)],
    [
      'a file that cannot be read',
      (deps: FakeDeps): FakeDeps => {
        seeded(LIVE_PRIORITY)(deps);
        const read = deps.fs.readTextLimited;
        const blind = async (path: string, max: number, decode?: 'lenient' | 'fatal') =>
          path === PRIORITY ? failure('cannot read: EIO') : read(path, max, decode);
        return { ...deps, fs: { ...deps.fs, readTextLimited: blind } };
      },
    ],
  ])('counts %s as no priority, with one warning, and keeps waiting for the lock', async (_name, damage) => {
    const base = withHeldLock();
    const deps = damage(onSleep(base, 3, () => void base.files.delete(LOCK)));
    expect((await lock(deps)).code).toBe(0);
    expect(base.sleeps.length).toBeGreaterThanOrEqual(3);
    expect(base.warned.filter((line) => line.includes('priority file'))).toHaveLength(1);
  });

  it('writes the priority file for a priority run only, and frees it when the lock is taken', async () => {
    const seen: { priority?: boolean | undefined; waiter?: boolean | undefined } = {};
    const base = withHeldLock({
      runAttached: () => {
        seen.priority = base.files.has(PRIORITY);
        return OK_END;
      },
    });
    const deps = onSleep(base, 2, () => {
      expect(base.files.has(PRIORITY)).toBe(true);
      expect(base.modes.get(PRIORITY)).toBe(0o600);
      base.files.delete(LOCK);
    });
    expect((await lock(deps, ['run', '--priority', '--', 'npm'])).code).toBe(0);
    expect(seen.priority).toBe(false);
    expect(base.files.size).toBe(0);

    const plain = withHeldLock();
    const waiting = onSleep(plain, 2, () => {
      seen.waiter = plain.files.has(PRIORITY);
      plain.files.delete(LOCK);
    });
    expect((await lock(waiting)).code).toBe(0);
    expect(seen.waiter).toBe(false);
  });

  it('never removes a priority file that another run took over', async () => {
    const base = withHeldLock();
    const deps = onSleep(base, 2, () => {
      base.files.set(PRIORITY, LIVE_PRIORITY);
      base.files.delete(LOCK);
    });
    expect((await lock(deps, ['run', '--priority', '--', 'npm'])).code).toBe(0);
    expect(base.files.get(PRIORITY)).toBe(LIVE_PRIORITY);
    expect(base.warned).toEqual([expect.stringContaining(lockWords.waiting)]);
  });
});

describe('lock run: inside a lock', () => {
  const OUTER = holderText(OWN_PID, OWN_START).trim();

  it('runs the child at once when the token matches the lock file: no take, no priority file, no group, no time limit', async () => {
    const seen: { handlers?: number | undefined } = {};
    const deps: FakeDeps = fake({
      env: { HOME: '/h', [env.heavyLockToken]: OUTER },
      runAttached: () => {
        seen.handlers = handlerCount(deps);
        return { kind: 'code', code: 6 };
      },
    });
    deps.seed(LOCK, `${OUTER}\n`);
    const result = await lock(deps, ['run', '--priority', '--', 'npm', 'test']);
    expect(result).toEqual({ code: 6, out: '', err: '' });
    expect(deps.attached).toEqual([
      { command: 'npm', args: ['test'], options: { extraEnv: { [env.heavyLockToken]: OUTER } } },
    ]);
    expect(deps.files.get(LOCK)).toBe(`${OUTER}\n`);
    expect(deps.files.has(PRIORITY)).toBe(false);
    expect(deps.randomTexts).toEqual([]);
    expect(deps.sleeps).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(seen.handlers).toBe(0);
  });

  it.each([
    ['a token that the lock file does not hold', `${OWN_PID}-${OWN_START}-ffffffffffffffff`],
    ['an empty token', ''],
  ])('waits as usual with %s', async (_name, token) => {
    const deps = withHeldLock({ env: { HOME: '/h', [env.heavyLockToken]: token } });
    expectOutcome(await lock(deps), 3, lockWords.waitEnded);
    expect(deps.attached).toEqual([]);
  });

  it('waits as usual when the lock file is gone', async () => {
    const deps = fake({ env: { HOME: '/h', [env.heavyLockToken]: OUTER }, runAttached: () => OK_END });
    expect((await lock(deps)).code).toBe(0);
    expect(deps.attached[0]?.options).toMatchObject({ held: true });
  });
});
