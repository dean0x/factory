import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { isatty } from 'node:tty';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeDeps, programArgvOf } from '../../src/core/node-deps.js';
import { hookNames } from '../../src/names.js';
import { isOwnChildPid, killKeptGroups, pidOfReadyText, readyPid, textWhenThere } from '../helpers/own-group.js';

// The real `isatty` stays the default. A test sets one answer, so that the check of a live terminal can be seen.
vi.mock('node:tty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:tty')>();
  return { ...actual, isatty: vi.fn(actual.isatty) };
});

const deps = createNodeDeps();
let dir = '';
let counter = 0;

const fresh = (name: string): string => join(dir, `${(counter += 1)}-${name}`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-node-deps-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('node deps: run', () => {
  it('passes arguments without a shell', async () => {
    const result = await deps.run('echo', ['a; echo b', '$HOME']);
    expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: 'a; echo b $HOME\n', stderr: '' } });
  });

  it('returns a non-zero exit code as a value', async () => {
    const result = await deps.run('node', ['-e', 'process.exit(3)']);
    expect(result.ok && result.value.exitCode).toBe(3);
  });

  it('returns an error when the program does not exist', async () => {
    const result = await deps.run('factory-no-such-program', []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cannot run factory-no-such-program');
  });

  it('returns an error when the time limit passes', async () => {
    const result = await deps.run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
    expect(result.ok).toBe(false);
  });

  it('runs in the folder that the caller names', async () => {
    const result = await deps.run('pwd', [], { cwd: dir });
    expect(result.ok && result.value.stdout.trim().endsWith(dir.split('/').pop() ?? '?')).toBe(true);
  });

  describe('the input of the program', () => {
    const echo = ['-e', 'process.stdin.pipe(process.stdout)'];

    it('gives the input text to the program on its standard input, with all bytes', async () => {
      const result = await deps.run('node', echo, { input: 'héllo\nsecond line' });
      expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: 'héllo\nsecond line', stderr: '' } });
    });

    it('gives an empty input as an input that has ended', async () => {
      const result = await deps.run('node', echo, { input: '' });
      expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: '', stderr: '' } });
    });

    it('is no error when the program ends before it reads a large input', async () => {
      const result = await deps.run('node', ['-e', 'process.exit(5)'], { input: 'x'.repeat(2_000_000) });
      expect(result.ok && result.value.exitCode).toBe(5);
    });

    it('still ends the program when the time limit passes', async () => {
      const started = Date.now();
      const result = await deps.run('node', ['-e', 'process.stdin.resume(); setTimeout(() => {}, 20000)'], {
        input: 'text',
        timeoutMs: 200,
      });
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  describe('a run in its own process group', () => {
    /**
     * The times of the tests with a late write. A process that the stop missed writes its file `LATE_SECONDS` after the start.
     * A run that works ends within a few hundred milliseconds, so `STOPPED_BY_MS` is far from both ends, and a loaded machine
     * does not fail a good run. A run with no stop ends at the late write, after `STOPPED_BY_MS`. `LATE_WAIT_MS` is the wait
     * after the end of the run, and it covers the late write with a margin.
     */
    const LATE_SECONDS = 2;
    const STOPPED_BY_MS = 1_500;
    const LATE_WAIT_MS = 3_000;

    const exists = (path: string): Promise<boolean> =>
      stat(path).then(
        () => true,
        () => false,
      );

    it('gives the exit code, the output and the input like a plain run', async () => {
      const result = await deps.run('/bin/sh', ['-c', 'cat; echo note >&2; exit 4'], { input: 'héllo', processGroup: true });
      expect(result).toEqual({ ok: true, value: { exitCode: 4, stdout: 'héllo', stderr: 'note\n' } });
    });

    it('returns an error when the program does not exist', async () => {
      const result = await deps.run('factory-no-such-program', [], { processGroup: true });
      expect(result).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot run factory-no-such-program: ENOENT' } });
    });

    it('stops every process of a pipe when the time limit passes, not only the shell', async () => {
      const late = fresh('late-pipe');
      const started = Date.now();
      const result = await deps.run('/bin/sh', ['-c', `(sleep ${LATE_SECONDS}; echo late > '${late}') | cat`], {
        timeoutMs: 200,
        processGroup: true,
      });
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(STOPPED_BY_MS);
      await wait(LATE_WAIT_MS);
      expect(await exists(late)).toBe(false);
    });

    it('ends at the time limit when a process that the shell left holds the output pipe, and stops that process', async () => {
      const late = fresh('late-background');
      const started = Date.now();
      const result = await deps.run('/bin/sh', ['-c', `echo first; (sleep ${LATE_SECONDS}; echo late > '${late}') &`], {
        timeoutMs: 300,
        processGroup: true,
      });
      expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: 'first\n', stderr: '' } });
      expect(Date.now() - started).toBeLessThan(STOPPED_BY_MS);
      await wait(LATE_WAIT_MS);
      expect(await exists(late)).toBe(false);
    });

    it('returns an error and stops the group when the output passes the byte cap', async () => {
      const late = fresh('late-cap');
      const result = await deps.run('/bin/sh', ['-c', `head -c 1100000 /dev/zero; sleep ${LATE_SECONDS}; echo late > '${late}'`], {
        processGroup: true,
      });
      expect(result).toEqual({
        ok: false,
        error: { kind: 'failure', message: 'cannot run /bin/sh: its output is larger than 1048576 bytes' },
      });
      await wait(LATE_WAIT_MS);
      expect(await exists(late)).toBe(false);
    });

    describe('with an abort signal', () => {
      it('stops every process of the group and ends the run when the signal aborts', async () => {
        const late = fresh('late-abort');
        const controller = new AbortController();
        const started = Date.now();
        const pending = deps.run('/bin/sh', ['-c', `(sleep ${LATE_SECONDS}; echo late > '${late}') | cat`], {
          processGroup: true,
          signal: controller.signal,
        });
        await wait(150);
        controller.abort();
        expect(await pending).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot run /bin/sh: SIGKILL' } });
        expect(Date.now() - started).toBeLessThan(STOPPED_BY_MS);
        await wait(LATE_WAIT_MS);
        expect(await exists(late)).toBe(false);
      });

      it('starts no program when the signal has aborted already', async () => {
        const marker = fresh('never-started');
        const controller = new AbortController();
        controller.abort();
        const result = await deps.run('/bin/sh', ['-c', `echo started > '${marker}'`], {
          processGroup: true,
          signal: controller.signal,
        });
        expect(result).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot run /bin/sh: ABORT_ERR' } });
        await wait(300);
        expect(await exists(marker)).toBe(false);
      });

      it('keeps no listener on the signal after the run ends', async () => {
        const controller = new AbortController();
        const result = await deps.run('/bin/sh', ['-c', 'echo done'], { processGroup: true, signal: controller.signal });
        expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: 'done\n', stderr: '' } });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      });
    });

    describe('when the stop does not end the first process of the group', () => {
      const realKill = process.kill.bind(process);
      let leaders: number[] = [];

      beforeEach(() => {
        leaders = [];
        // The stop signal to a group has no effect, as for a process in an uninterruptible wait. Only the signal 0, which sends
        // nothing, goes on to the real call.
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
          if (pid < 0) leaders.push(-pid);
          return signal === 0 && pid > 0 ? realKill(pid, signal) : true;
        }) as typeof process.kill);
      });

      // The leaders are the groups that the code under test tried to stop. Each one is the child of a test run, started as a group leader.
      afterEach(() => {
        vi.restoreAllMocks();
        killKeptGroups(leaders);
      });

      it('ends shortly after the time limit with the failure of the stop', async () => {
        const started = Date.now();
        const result = await deps.run('/bin/sh', ['-c', 'sleep 4'], { timeoutMs: 200, processGroup: true });
        expect(result).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot run /bin/sh: SIGKILL' } });
        expect(Date.now() - started).toBeLessThan(2_000);
      });

      it('ends shortly after the byte cap with the failure of the cap', async () => {
        const started = Date.now();
        const result = await deps.run('/bin/sh', ['-c', 'head -c 1100000 /dev/zero; sleep 4'], { processGroup: true });
        expect(result).toEqual({
          ok: false,
          error: { kind: 'failure', message: 'cannot run /bin/sh: its output is larger than 1048576 bytes' },
        });
        expect(Date.now() - started).toBeLessThan(2_000);
      });
    });
  });

  describe('the environment of the program', () => {
    const show = ['-e', 'process.stdout.write([process.env.LC_ALL, process.env.GIT_TERMINAL_PROMPT].join(","))'];
    const saved = { LC_ALL: process.env['LC_ALL'], GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] };

    beforeEach(() => {
      process.env['LC_ALL'] = 'en_US.UTF-8';
      process.env['GIT_TERMINAL_PROMPT'] = '1';
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('sets the C locale and no git prompt by default', async () => {
      const result = await deps.run('node', show);
      expect(result.ok && result.value.stdout).toBe('C,0');
    });

    it('keeps the environment of this process when the caller asks for it', async () => {
      const result = await deps.run('node', show, { inheritEnv: true });
      expect(result.ok && result.value.stdout).toBe('en_US.UTF-8,1');
    });
  });
});

// Every child of these tests ends by itself within 8 s, and each test stops at 15 s: a run that goes wrong never holds the worker.
const ATTACHED_TEST_TIMEOUT_MS = 15_000;

describe('node deps: run with the terminal', { timeout: ATTACHED_TEST_TIMEOUT_MS }, () => {
  it('gives the exit code of the program as a value', async () => {
    expect(await deps.runAttached('node', ['-e', 'process.exit(0)'])).toEqual({ kind: 'code', code: 0 });
    expect(await deps.runAttached('node', ['-e', 'process.exit(3)'])).toEqual({ kind: 'code', code: 3 });
  });

  it('passes arguments without a shell', async () => {
    const result = await deps.runAttached('node', ['-e', 'process.exit(process.argv[1] === "a; exit 9" ? 0 : 1)', 'a; exit 9']);
    expect(result).toEqual({ kind: 'code', code: 0 });
  });

  it('gives the code of the error when the program does not exist', async () => {
    expect(await deps.runAttached('factory-no-such-program', [])).toEqual({ kind: 'spawn', code: 'ENOENT' });
  });

  it.each([
    ['plain', undefined],
    ['held', { held: true, maxMs: 5_000 }],
  ] as const)('gives a spawn value, not a throw, for an empty program name (%s run)', async (_name, options) => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal));
    const end = await deps.runAttached('', [], options);
    expect(end).toMatchObject({ kind: 'spawn' });
    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('gives the signal and its number when a signal ends the program', async () => {
    const result = await deps.runAttached('node', ['-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(result).toEqual({ kind: 'signal', signal: 'SIGTERM', number: 15 });
  });
});

describe('node deps: run with the terminal, held', { timeout: ATTACHED_TEST_TIMEOUT_MS }, () => {
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const listenerCounts = (): number[] => SIGNALS.map((signal) => process.listenerCount(signal));
  const children: number[] = [];
  const quick = ['-e', 'process.exit(0)'];

  const isGone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  /** The program of the child: it writes the file, and the child of the test ends it with its own bounded timer. */
  const script = (body: string): string[] => [
    '-e',
    `const fs = require("node:fs"); const file = process.argv[1]; setTimeout(() => process.exit(9), 8000); ${body}`,
  ];

  // `readyPid` keeps only the pid that a child of the test wrote, and `killKeptGroups` signals only a pid that passes the same check.
  afterEach(() => killKeptGroups(children));

  it('runs the program as the leader of a new process group, and a plain run keeps the group of the caller', async () => {
    const probe = 'fs.writeFileSync(file, (() => { try { process.kill(-process.pid, 0); return "leader"; } catch { return "member"; } })()); process.exit(0)';
    const held = fresh('held');
    const plain = fresh('plain');
    await deps.runAttached('node', [...script(probe), held], { held: true });
    await deps.runAttached('node', [...script(probe), plain]);
    expect([await readFile(held, 'utf8'), await readFile(plain, 'utf8')]).toEqual(['leader', 'member']);
  });

  it('gives the program no standard input', async () => {
    const result = await deps.runAttached('node', script('process.stdin.on("end", () => process.exit(0)); process.stdin.resume()'), { held: true });
    expect(result).toEqual({ kind: 'code', code: 0 });
  });

  it('adds the extra environment to the child only, and keeps the rest and the locale as they are', async () => {
    const saved = { LC_ALL: process.env['LC_ALL'], KEPT: process.env['FACTORY_TEST_KEPT'] };
    process.env['LC_ALL'] = 'en_US.UTF-8';
    process.env['FACTORY_TEST_KEPT'] = 'yes';
    try {
      const check = 'process.exit(process.env.FACTORY_TEST_TOKEN === "t-1" && process.env.FACTORY_TEST_KEPT === "yes" && process.env.LC_ALL === "en_US.UTF-8" ? 0 : 1)';
      const result = await deps.runAttached('node', ['-e', check], { extraEnv: { FACTORY_TEST_TOKEN: 't-1' } });
      expect(result).toEqual({ kind: 'code', code: 0 });
      expect(process.env['FACTORY_TEST_TOKEN']).toBeUndefined();
    } finally {
      if (saved.LC_ALL === undefined) delete process.env['LC_ALL'];
      else process.env['LC_ALL'] = saved.LC_ALL;
      if (saved.KEPT === undefined) delete process.env['FACTORY_TEST_KEPT'];
      else process.env['FACTORY_TEST_KEPT'] = saved.KEPT;
    }
  });

  it('forwards INT, TERM and HUP to the child, and holds one handler of each only while the child runs', async () => {
    const log = fresh('forward');
    const tracer = `const seen = []; for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => { seen.push(name); if (seen.length === 3) { fs.writeFileSync(file, seen.join(",")); process.exit(0); } }); fs.writeFileSync(file + ".ready", String(process.pid)); setTimeout(() => undefined, 8000)`;
    const before = listenerCounts();
    const known = SIGNALS.map((signal) => process.listeners(signal));
    const running = deps.runAttached('node', [...script(tracer), log], { held: true });
    expect(listenerCounts()).toEqual(before.map((count) => count + 1));
    await readyPid(children, `${log}.ready`);
    SIGNALS.forEach((signal, index) => {
      const ours = process.listeners(signal).filter((handler) => !(known[index] ?? []).includes(handler));
      expect(ours).toHaveLength(1);
      ours[0]?.(signal);
    });
    expect(await running).toEqual({ kind: 'code', code: 0 });
    // The order of three signals that arrive together is not fixed, so compare the sorted set: each signal once.
    expect((await readFile(log, 'utf8')).split(',').sort()).toEqual([...SIGNALS].sort());
    expect(listenerCounts()).toEqual(before);
  });

  it('sends a forwarded signal to every process of the group of the child', async () => {
    const log = fresh('group');
    // The child ignores TERM and ends when its own child, in the same group, ends by TERM.
    const tree = `process.on("SIGTERM", () => undefined); const grand = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => undefined, 8000)"], { stdio: "ignore" }); fs.writeFileSync(file + ".ready", String(process.pid)); grand.on("exit", (code, signal) => process.exit(signal === "SIGTERM" ? 0 : 1))`;
    const known = process.listeners('SIGTERM');
    const running = deps.runAttached('node', [...script(tree), log], { held: true });
    await readyPid(children, `${log}.ready`);
    process.listeners('SIGTERM').filter((handler) => !known.includes(handler))[0]?.('SIGTERM');
    expect(await running).toEqual({ kind: 'code', code: 0 });
  });

  it('holds no handler of INT, TERM or HUP after a code, a signal, a limit or a spawn end', async () => {
    const before = listenerCounts();
    const ends = [
      await deps.runAttached('node', quick, { held: true, maxMs: 5000 }),
      await deps.runAttached('node', ['-e', 'process.kill(process.pid, "SIGTERM")'], { held: true }),
      await deps.runAttached('node', ['-e', 'setTimeout(() => undefined, 8000)'], { held: true, maxMs: 100, killGraceMs: 100 }),
      await deps.runAttached('factory-no-such-program', [], { held: true }),
    ];
    expect(ends.map((end) => end.kind)).toEqual(['code', 'signal', 'limit', 'spawn']);
    expect(listenerCounts()).toEqual(before);
  });

  it('adds no handler for a run that is not held', async () => {
    const before = listenerCounts();
    const running = deps.runAttached('node', quick);
    expect(listenerCounts()).toEqual(before);
    await running;
  });

  it('sends TERM to the group at the time limit, then KILL after the grace, and gives the limit end', async () => {
    const log = fresh('limit');
    // The child ignores TERM, so only the KILL ends it.
    const stubborn = `process.on("SIGTERM", () => fs.writeFileSync(file + ".term", "1")); fs.writeFileSync(file + ".ready", String(process.pid)); setTimeout(() => undefined, 8000)`;
    // The limit is long enough for a slow start: the child adds its TERM handler before it writes the ready file.
    const running = deps.runAttached('node', [...script(stubborn), log], { held: true, maxMs: 1_500, killGraceMs: 300 });
    const pid = await readyPid(children, `${log}.ready`);
    expect(await running).toEqual({ kind: 'limit' });
    expect(await readFile(`${log}.term`, 'utf8')).toBe('1');
    for (let tries = 0; tries < 50 && !isGone(pid); tries += 1) await wait(20);
    expect(isGone(pid)).toBe(true);
  });

  it('gives the limit end also when the child ends at the TERM of the limit', async () => {
    const result = await deps.runAttached('node', ['-e', 'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => undefined, 8000)'], {
      held: true,
      maxMs: 300,
      killGraceMs: 100,
    });
    expect(result).toEqual({ kind: 'limit' });
  });

  describe('when the first process ends after the time limit', () => {
    const KILL_GRACE_MS = 2_000;
    // The child ends at the TERM of the limit. The process of its group ignores TERM and does not end by itself within the test.
    const leaderWithStraggler = `process.on("SIGTERM", () => process.exit(0)); const straggler = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setTimeout(() => undefined, 8000)"], { stdio: "ignore" }); fs.writeFileSync(file + ".straggler", String(straggler.pid)); fs.writeFileSync(file + ".ready", String(process.pid)); setInterval(() => undefined, 1000)`;
    // The child ignores TERM, so only the KILL after the grace ends it.
    const leaderIgnoringTerm = `process.on("SIGTERM", () => undefined); fs.writeFileSync(file + ".ready", String(process.pid)); setInterval(() => undefined, 1000)`;

    /**
     * Run the held program to its limit, then wait past the grace. The value has the end of the run, and each signal that was sent to
     * the group of the program, with the time since the start. The stub of `process.kill` passes a signal on only to that group.
     */
    const signalsToGroup = async (name: string, body: string) => {
      const log = fresh(name);
      const sent: Array<{ pid: number; signal: string | number | undefined; at: number }> = [];
      const realKill = process.kill.bind(process);
      const started = Date.now();
      const running = deps.runAttached('node', [...script(body), log], { held: true, maxMs: 1_500, killGraceMs: KILL_GRACE_MS });
      const leader = await readyPid(children, `${log}.ready`);
      const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        sent.push({ pid, signal, at: Date.now() - started });
        return signal === 0 || pid === -leader ? realKill(pid, signal) : true;
      }) as typeof process.kill);
      try {
        const end = await running;
        await wait(KILL_GRACE_MS + 500);
        return { end, toGroup: sent.filter((call) => call.pid === -leader && call.signal !== 0) };
      } finally {
        spy.mockRestore();
      }
    };

    it('stops the rest of the group with KILL at once and gives the limit end, with no wait for the grace', async () => {
      const log = fresh('straggler');
      const started = Date.now();
      const running = deps.runAttached('node', [...script(leaderWithStraggler), log], { held: true, maxMs: 1_500, killGraceMs: KILL_GRACE_MS });
      await readyPid(children, `${log}.ready`);
      const straggler = pidOfReadyText(await textWhenThere(`${log}.straggler`));
      expect(await running).toEqual({ kind: 'limit' });
      expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 1_000);
      for (let tries = 0; tries < 100 && !isGone(straggler); tries += 1) await wait(20);
      expect(isGone(straggler)).toBe(true);
    });

    it('sends the group one KILL, when the first process ends, and no signal after the run has ended', async () => {
      const { end, toGroup } = await signalsToGroup('one-kill', leaderWithStraggler);
      expect(end).toEqual({ kind: 'limit' });
      expect(toGroup.map((call) => call.signal)).toEqual(['SIGTERM', 'SIGKILL']);
      expect(toGroup[1]?.at).toBeLessThan(KILL_GRACE_MS);
    });

    it('sends the group no second KILL when the KILL after the grace has ended the first process', async () => {
      const { end, toGroup } = await signalsToGroup('timer-kill', leaderIgnoringTerm);
      expect(end).toEqual({ kind: 'limit' });
      expect(toGroup.map((call) => call.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });
});

describe('node deps: the terminal', () => {
  it('tells whether a person types and reads', () => {
    expect(typeof deps.stdinIsTTY).toBe('boolean');
    expect(typeof deps.stdoutIsTTY).toBe('boolean');
  });

  describe('prompt', () => {
    const realStdin = process.stdin;
    let input = new PassThrough();
    let written = '';

    beforeEach(() => {
      input = new PassThrough();
      written = '';
      Object.defineProperty(process, 'stdin', { value: input, configurable: true });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    });

    it('writes the question to stderr and returns the line without its line break', async () => {
      const answer = createNodeDeps().prompt('Go on? [y/N] ');
      input.write('yes\nsecond line\n');
      expect(await answer).toEqual({ ok: true, value: 'yes' });
      expect(written).toContain('Go on? [y/N] ');
    });

    it('cuts a long answer to 200 characters', async () => {
      const answer = createNodeDeps().prompt('?');
      input.write(`${'a'.repeat(500)}\n`);
      expect(await answer).toEqual({ ok: true, value: 'a'.repeat(200) });
    });

    it('returns an error when the input ends with no answer', async () => {
      const answer = createNodeDeps().prompt('?');
      input.end();
      const result = await answer;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('no answer was given');
    });
  });

  describe('readStdin', () => {
    const realStdin = process.stdin;
    let input = new PassThrough();

    const replaceStdin = (stream: Readable): void => {
      Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    };

    beforeEach(() => {
      input = new PassThrough();
      replaceStdin(input);
    });

    afterEach(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    });

    it('returns the whole text of the input when it ends', async () => {
      const text = createNodeDeps().readStdin(1024);
      input.write('{"a":');
      input.end('"b"}');
      expect(await text).toEqual({ ok: true, value: '{"a":"b"}' });
    });

    it('returns empty text for an input with no bytes', async () => {
      const text = createNodeDeps().readStdin(1024);
      input.end();
      expect(await text).toEqual({ ok: true, value: '' });
    });

    it('accepts an input of exactly the limit (TP-8)', async () => {
      const text = createNodeDeps().readStdin(5);
      input.end('12345');
      expect(await text).toEqual({ ok: true, value: '12345' });
    });

    it('returns an error for an input of one byte more than the limit (TP-8)', async () => {
      const text = createNodeDeps().readStdin(5);
      input.end('123456');
      const result = await text;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe('cannot read stdin: larger than 5 bytes');
    });

    it('counts bytes and not characters', async () => {
      const six = 'ééé';
      const within = createNodeDeps().readStdin(6);
      input.end(six);
      expect(await within).toEqual({ ok: true, value: six });

      input = new PassThrough();
      replaceStdin(input);
      const over = createNodeDeps().readStdin(5);
      input.end(six);
      expect((await over).ok).toBe(false);
    });

    it('stops at the limit when the input never ends', async () => {
      const endless = new Readable({
        highWaterMark: 1,
        read() {
          this.push('a');
        },
      });
      replaceStdin(endless);
      const result = await Promise.race([createNodeDeps().readStdin(100), wait(5000).then(() => 'still reading' as const)]);
      endless.destroy();
      expect(result).not.toBe('still reading');
      if (result !== 'still reading') expect(result.ok).toBe(false);
    });

    describe('the time limit', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('returns an error when the input stays open and sends nothing', async () => {
        const text = createNodeDeps().readStdin(1024);
        await vi.advanceTimersByTimeAsync(hookNames.stdinTimeoutMs);
        expect(await text).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot read stdin: ETIMEDOUT' } });
        expect(input.destroyed).toBe(true);
      });

      it('returns an error when some bytes came and the input stays open', async () => {
        const text = createNodeDeps().readStdin(1024);
        input.write('{"a":');
        await vi.advanceTimersByTimeAsync(hookNames.stdinTimeoutMs);
        expect(await text).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot read stdin: ETIMEDOUT' } });
      });

      it('returns the text when the input ends before the limit, and leaves no timer', async () => {
        const text = createNodeDeps().readStdin(1024);
        input.end('abc');
        await vi.advanceTimersByTimeAsync(hookNames.stdinTimeoutMs - 1);
        expect(await text).toEqual({ ok: true, value: 'abc' });
        expect(vi.getTimerCount()).toBe(0);
      });

      it('leaves no timer when the input is larger than the byte cap', async () => {
        const text = createNodeDeps().readStdin(2);
        input.end('abc');
        expect((await text).ok).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('returns an error when the input fails', async () => {
      const text = createNodeDeps().readStdin(1024);
      input.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }));
      expect(await text).toEqual({ ok: false, error: { kind: 'failure', message: 'cannot read stdin: EIO' } });
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('returns an error for the limit %s', async (limit) => {
      const result = await createNodeDeps().readStdin(limit);
      expect(result.ok).toBe(false);
    });

    it('returns empty text at once when a person types at the input (TP-124)', async () => {
      const terminal = Object.assign(new PassThrough(), { isTTY: true });
      replaceStdin(terminal);
      const result = await Promise.race([createNodeDeps().readStdin(1024), wait(2000).then(() => 'blocked' as const)]);
      expect(result).toEqual({ ok: true, value: '' });
      terminal.destroy();
    });

    it('leaves the text on a terminal unread', async () => {
      const terminal = Object.assign(new PassThrough(), { isTTY: true });
      replaceStdin(terminal);
      terminal.write('typed text');
      await createNodeDeps().readStdin(1024);
      expect(terminal.read()?.toString()).toBe('typed text');
      terminal.destroy();
    });
  });

  describe('warn', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('writes one warning line to stderr at once, with a control character in the text made visible', () => {
      let written = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written += String(chunk);
        return true;
      });
      createNodeDeps().warn('a file named\u001b[31m in /x');
      expect(written).toBe('warning: a file named?[31m in /x\n');
    });
  });
});

describe('node deps: realpath', () => {
  it('resolves a link', async () => {
    const target = fresh('target');
    const link = fresh('link');
    await writeFile(target, 'x');
    await symlink(target, link);
    const result = await deps.fs.realpath(link);
    expect(result).toEqual({ ok: true, value: await realpath(target) });
  });

  it('returns an error with the code for a path that does not exist', async () => {
    const result = await deps.fs.realpath(fresh('missing'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });
});

describe('node deps: fs', () => {
  it('writes, reads, lists and stats', async () => {
    const folder = join(dir, 'a', 'b');
    expect((await deps.fs.mkdir(folder)).ok).toBe(true);
    expect((await deps.fs.writeText(join(folder, 'x.txt'), 'hello')).ok).toBe(true);
    expect(await deps.fs.readText(join(folder, 'x.txt'))).toEqual({ ok: true, value: 'hello' });
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['x.txt'] });
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: 'dir' });
    expect(await deps.fs.stat(join(folder, 'x.txt'))).toEqual({ ok: true, value: 'file' });
    expect(await deps.fs.stat(join(folder, 'none'))).toEqual({ ok: true, value: null });
  });

  it('returns an error with the code for a missing file', async () => {
    const result = await deps.fs.readText(join(dir, 'missing.txt'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });

  describe('a read with a size limit', () => {
    it('reads a file that is exactly as large as the limit', async () => {
      const file = fresh('limit-exact.txt');
      await writeFile(file, 'abcde', 'utf8');
      expect(await deps.fs.readTextLimited(file, 5)).toEqual({ ok: true, value: 'abcde' });
    });

    it('fails for a file that is one byte over the limit, and says that it is too large', async () => {
      const file = fresh('limit-over.txt');
      await writeFile(file, 'abcdef', 'utf8');
      const result = await deps.fs.readTextLimited(file, 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('larger than 5 bytes');
    });

    it('counts bytes and not characters', async () => {
      const file = fresh('limit-bytes.txt');
      await writeFile(file, 'ééé', 'utf8');
      expect((await deps.fs.readTextLimited(file, 5)).ok).toBe(false);
      expect(await deps.fs.readTextLimited(file, 6)).toEqual({ ok: true, value: 'ééé' });
    });

    it('returns an error with the code for a missing file', async () => {
      const result = await deps.fs.readTextLimited(fresh('limit-missing.txt'), 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOENT');
    });
  });

  describe('a folder read with a limit', () => {
    const folderOf = async (name: string, count: number): Promise<string> => {
      const folder = fresh(name);
      await mkdir(folder);
      for (let index = 0; index < count; index += 1) await writeFile(join(folder, `f${index}`), '', 'utf8');
      return folder;
    };

    it('gives all names of a folder that holds fewer than the limit', async () => {
      const result = await deps.fs.listLimited(await folderOf('limited-few', 3), 5);
      expect(result.ok && [...result.value].sort()).toEqual(['f0', 'f1', 'f2']);
    });

    it('gives as many names as the limit, and no more, for a folder that holds more', async () => {
      const result = await deps.fs.listLimited(await folderOf('limited-many', 8), 5);
      expect(result.ok && result.value.length).toBe(5);
    });

    it('gives no name for a limit of zero', async () => {
      expect(await deps.fs.listLimited(await folderOf('limited-zero', 2), 0)).toEqual({ ok: true, value: [] });
    });

    it.each([-1, 1.5, Number.NaN])('refuses the limit %s', async (limit) => {
      expect((await deps.fs.listLimited(await folderOf(`limited-bad-${limit}`, 1), limit)).ok).toBe(false);
    });

    it('returns an error with the code for a missing folder', async () => {
      const result = await deps.fs.listLimited(fresh('limited-missing'), 5);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOENT');
    });
  });

  describe('a read with a strict decode', () => {
    /** The byte 0xff never occurs in UTF-8. A lenient decode turns it into U+FFFD. */
    const BAD_BYTES = Buffer.from([0x61, 0xff, 0x62]);

    it('M5-1b TP-51 fails for a byte sequence that is not UTF-8, names the file, and gives no text', async () => {
      const file = fresh('strict-bad.json');
      await writeFile(file, BAD_BYTES);
      const result = await deps.fs.readTextLimited(file, 100, 'fatal');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(file);
        expect(result.error.message).toContain('UTF-8');
      }
    });

    it('M5-1b TP-51 reads valid text, with multi-byte characters and a byte order mark, as the lenient read does', async () => {
      const file = fresh('strict-good.json');
      const text = '﻿{"title":"é 日本 \u{1F600}"}\n';
      await writeFile(file, text, 'utf8');
      expect(await deps.fs.readTextLimited(file, 100, 'fatal')).toEqual({ ok: true, value: text });
      expect(await deps.fs.readTextLimited(file, 100, 'lenient')).toEqual({ ok: true, value: text });
    });

    it('M5-1b TP-51 still says that a file over the limit is too large', async () => {
      const file = fresh('strict-over.json');
      await writeFile(file, 'abcdef', 'utf8');
      const result = await deps.fs.readTextLimited(file, 5, 'fatal');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('larger than 5 bytes');
    });

    it('M5-1b TP-98 keeps the lenient decode when the read names no decode', async () => {
      const file = fresh('lenient-default.json');
      await writeFile(file, BAD_BYTES);
      expect(await deps.fs.readTextLimited(file, 100)).toEqual({ ok: true, value: 'a�b' });
    });

    it('M5-1b TP-98 keeps the lenient decode when the read names the lenient decode', async () => {
      const file = fresh('lenient-named.json');
      await writeFile(file, BAD_BYTES);
      expect(await deps.fs.readTextLimited(file, 100, 'lenient')).toEqual({ ok: true, value: 'a�b' });
    });
  });

  describe('a digest of the bytes of a file (TP-171)', () => {
    const sha256Of = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
    const BOUND = 1_000_000;

    it('gives the size and the SHA-256 of the bytes, and the text of a file within the text limit', async () => {
      const file = fresh('digest-small.txt');
      await writeFile(file, 'abc\n', 'utf8');
      expect(await deps.fs.digestFile(file, 100, BOUND)).toEqual({ ok: true, value: { size: 4, sha256: sha256Of('abc\n'), text: 'abc\n' } });
    });

    it('gives the text of a file that is exactly as large as the limit, and none for one byte more', async () => {
      const file = fresh('digest-edge.txt');
      await writeFile(file, 'abcde', 'utf8');
      expect(await deps.fs.digestFile(file, 5, BOUND)).toMatchObject({ ok: true, value: { size: 5, text: 'abcde' } });
      expect(await deps.fs.digestFile(file, 4, BOUND)).toEqual({ ok: true, value: { size: 5, sha256: sha256Of('abcde'), text: null } });
    });

    it('hashes all bytes of a file over the text limit, also over many chunks', async () => {
      const file = fresh('digest-big.bin');
      const bytes = Buffer.alloc(300_000, 7);
      await writeFile(file, bytes);
      expect(await deps.fs.digestFile(file, 10, BOUND)).toEqual({ ok: true, value: { size: 300_000, sha256: sha256Of(bytes), text: null } });
    });

    it('hashes the bytes and not the text: bytes that are not valid text still give their own hash', async () => {
      const file = fresh('digest-binary.bin');
      const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
      await writeFile(file, bytes);
      expect(await deps.fs.digestFile(file, 100, BOUND)).toMatchObject({ ok: true, value: { size: 4, sha256: sha256Of(bytes) } });
    });

    it('hashes a file with no byte', async () => {
      const file = fresh('digest-empty.txt');
      await writeFile(file, '');
      expect(await deps.fs.digestFile(file, 5, BOUND)).toEqual({ ok: true, value: { size: 0, sha256: sha256Of(''), text: '' } });
    });

    it('hashes a file that is exactly as large as the byte bound', async () => {
      const file = fresh('digest-bound-exact.txt');
      await writeFile(file, 'abcde', 'utf8');
      expect(await deps.fs.digestFile(file, 100, 5)).toEqual({ ok: true, value: { size: 5, sha256: sha256Of('abcde'), text: 'abcde' } });
    });

    it('gives no digest for a file that is one byte over the byte bound', async () => {
      const file = fresh('digest-bound-over.txt');
      await writeFile(file, 'abcdef', 'utf8');
      expect(await deps.fs.digestFile(file, 100, 5)).toEqual({ ok: true, value: null });
    });

    it('gives no digest for a file over the byte bound that has many chunks', async () => {
      const file = fresh('digest-bound-big.bin');
      await writeFile(file, Buffer.alloc(300_000, 7));
      expect(await deps.fs.digestFile(file, 10, 100)).toEqual({ ok: true, value: null });
    });

    it('returns an error with the code for a missing file', async () => {
      const result = await deps.fs.digestFile(fresh('digest-missing.txt'), 5, BOUND);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOENT');
    });
  });

  it('copies a tree into a folder inside the tree, and leaves out the skipped folder', async () => {
    const source = join(dir, 'self');
    await deps.fs.mkdir(join(source, 'old'));
    await deps.fs.writeText(join(source, 'a.txt'), 'a');
    await deps.fs.writeText(join(source, 'old', 'b.txt'), 'b');
    const target = join(source, 'old', 'copy');

    expect((await deps.fs.copyTree(source, target, [join(source, 'old')])).ok).toBe(true);
    expect(await deps.fs.list(target)).toEqual({ ok: true, value: ['a.txt'] });
    expect(await deps.fs.readText(join(target, 'a.txt'))).toEqual({ ok: true, value: 'a' });

    const again = await deps.fs.copyTree(source, target, [join(source, 'old')]);
    expect(again.ok).toBe(false);
  });

  it('copies one file', async () => {
    const file = join(dir, 'one.txt');
    await deps.fs.writeText(file, 'one');
    expect((await deps.fs.copyTree(file, join(dir, 'two.txt'), [])).ok).toBe(true);
    expect(await deps.fs.readText(join(dir, 'two.txt'))).toEqual({ ok: true, value: 'one' });
  });

  describe('a link as the path to copy', () => {
    it('copies the content of a link to a file as a regular file', async () => {
      const target = fresh('link-target.txt');
      await writeFile(target, 'shared text', 'utf8');
      const link = fresh('link.txt');
      await symlink(target, link);
      const copy = fresh('link-copy.txt');

      expect((await deps.fs.copyTree(link, copy, [])).ok).toBe(true);

      expect((await lstat(copy)).isFile()).toBe(true);
      expect(await readFile(copy, 'utf8')).toBe('shared text');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    });

    it('fails for a link whose target does not exist', async () => {
      const link = fresh('dangling.txt');
      await symlink(fresh('no-target.txt'), link);
      const copy = fresh('dangling-copy.txt');

      const result = await deps.fs.copyTree(link, copy, []);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOENT');
      expect(await deps.fs.stat(copy)).toEqual({ ok: true, value: null });
    });

    it('fails for a link to a folder', async () => {
      const folder = fresh('link-folder');
      await deps.fs.mkdir(folder);
      await deps.fs.writeText(join(folder, 'a.txt'), 'a');
      const link = fresh('link-to-folder');
      await symlink(folder, link);

      const result = await deps.fs.copyTree(link, fresh('link-folder-copy'), []);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOTSUP');
    });

    it('fails for a link inside the tree', async () => {
      const source = fresh('tree-with-link');
      await deps.fs.mkdir(source);
      const target = fresh('inner-target.txt');
      await writeFile(target, 'x', 'utf8');
      await symlink(target, join(source, 'inner.txt'));

      const result = await deps.fs.copyTree(source, fresh('tree-with-link-copy'), []);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('ENOTSUP');
    });
  });

  it('renames, copies with a skip list, and removes a tree', async () => {
    const source = join(dir, 'tree');
    await deps.fs.mkdir(join(source, 'keep'));
    await deps.fs.mkdir(join(source, 'skip'));
    await deps.fs.writeText(join(source, 'keep', 'f.txt'), '1');
    await deps.fs.writeText(join(source, 'skip', 'g.txt'), '2');

    const copy = join(dir, 'copy');
    expect((await deps.fs.copyTree(source, copy, [join(source, 'skip')])).ok).toBe(true);
    expect(await deps.fs.list(copy)).toEqual({ ok: true, value: ['keep'] });

    const moved = join(dir, 'moved');
    expect((await deps.fs.rename(copy, moved)).ok).toBe(true);
    expect(await deps.fs.stat(copy)).toEqual({ ok: true, value: null });

    expect((await deps.fs.remove(moved)).ok).toBe(true);
    expect((await deps.fs.remove(moved)).ok).toBe(true);
    expect(await deps.fs.stat(moved)).toEqual({ ok: true, value: null });
  });
});

describe('node deps: lstat', () => {
  it('tells the kind of a file, of a folder and of a path that does not exist', async () => {
    const file = fresh('lstat-file.txt');
    await writeFile(file, 'x', 'utf8');
    expect(await deps.fs.lstat(file)).toEqual({ ok: true, value: 'file' });
    expect(await deps.fs.lstat(dir)).toEqual({ ok: true, value: 'dir' });
    expect(await deps.fs.lstat(fresh('lstat-none'))).toEqual({ ok: true, value: null });
  });

  it('tells a link to a file, a link to a folder and a link with no target as link, and follows none of them', async () => {
    const target = fresh('lstat-target.txt');
    await writeFile(target, 'x', 'utf8');
    const toFile = fresh('lstat-to-file');
    const toFolder = fresh('lstat-to-folder');
    const dangling = fresh('lstat-dangling');
    await symlink(target, toFile);
    await symlink(dir, toFolder);
    await symlink(join(dir, 'lstat-no-target'), dangling);
    for (const link of [toFile, toFolder, dangling]) {
      expect(await deps.fs.lstat(link)).toEqual({ ok: true, value: 'link' });
    }
  });

  it('follows a link in a folder above the path', async () => {
    const real = fresh('lstat-real');
    await mkdir(real);
    await writeFile(join(real, 'inner.txt'), 'x', 'utf8');
    const via = fresh('lstat-via');
    await symlink(real, via);
    expect(await deps.fs.lstat(join(via, 'inner.txt'))).toEqual({ ok: true, value: 'file' });
  });

  it('gives null when a file stands where a folder should be', async () => {
    const file = fresh('lstat-not-a-folder.txt');
    await writeFile(file, 'x', 'utf8');
    expect(await deps.fs.lstat(join(file, 'below'))).toEqual({ ok: true, value: null });
  });
});

describe('node deps: owner and mode', () => {
  it('tells the kind, the owner and the permission bits of a file and of a folder', async () => {
    const file = fresh('info.txt');
    await writeFile(file, 'x', 'utf8');
    await chmod(file, 0o640);
    const uid = process.getuid?.() ?? null;
    expect(await deps.fs.statInfo(file)).toEqual({
      ok: true,
      value: { kind: 'file', uid, mode: 0o640, mtimeMs: (await stat(file)).mtimeMs, size: 1 },
    });
    await chmod(dir, 0o700);
    expect(await deps.fs.statInfo(dir)).toMatchObject({ ok: true, value: { kind: 'dir', uid, mode: 0o700 } });
  });

  it('tells the size of a file in bytes', async () => {
    const file = fresh('size.txt');
    await writeFile(file, 'abcé', 'utf8');
    expect(await deps.fs.statInfo(file)).toMatchObject({ ok: true, value: { size: 5 } });
  });

  it('tells the time of the last change of a file', async () => {
    const file = fresh('mtime.txt');
    const before = Date.now();
    await writeFile(file, 'x', 'utf8');
    const result = await deps.fs.statInfo(file);
    expect(result.ok && result.value !== null && Math.abs(result.value.mtimeMs - before) < 5_000).toBe(true);
    await utimes(file, new Date(1_000_000), new Date(1_000_000));
    expect(await deps.fs.statInfo(file)).toMatchObject({ ok: true, value: { mtimeMs: 1_000_000 } });
  });

  it('gives null for a path that does not exist', async () => {
    expect(await deps.fs.statInfo(fresh('none'))).toEqual({ ok: true, value: null });
  });

  it('knows the user id of the process', () => {
    expect(deps.uid).toBe(process.getuid?.() ?? null);
  });

  it('sets the permission bits of a file and of a folder', async () => {
    const folder = fresh('chmod');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'f.txt');
    await writeFile(file, 'x', 'utf8');
    expect((await deps.fs.chmod(file, 0o600)).ok).toBe(true);
    expect((await deps.fs.chmod(folder, 0o700)).ok).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it('returns an error with the code for a path that does not exist', async () => {
    const result = await deps.fs.chmod(fresh('chmod-missing'), 0o600);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });
});

describe('node deps: lstatInfo', () => {
  it('tells the facts of a file and of a folder, and null for a path that does not exist or lies below a file', async () => {
    const file = fresh('lstat-info-file.txt');
    await writeFile(file, 'abc', 'utf8');
    await chmod(file, 0o640);
    const uid = process.getuid?.() ?? null;
    expect(await deps.fs.lstatInfo(file)).toEqual({ ok: true, value: { kind: 'file', uid, mode: 0o640, mtimeMs: (await stat(file)).mtimeMs, size: 3 } });
    expect(await deps.fs.lstatInfo(dir)).toMatchObject({ ok: true, value: { kind: 'dir', uid } });
    expect(await deps.fs.lstatInfo(fresh('lstat-info-none'))).toEqual({ ok: true, value: null });
    expect(await deps.fs.lstatInfo(join(file, 'below'))).toEqual({ ok: true, value: null });
  });

  it('tells a link to a file, a link to a folder and a link with no target as a link, and follows none of them', async () => {
    const target = fresh('lstat-info-target.txt');
    await writeFile(target, 'x', 'utf8');
    const toFile = fresh('lstat-info-to-file');
    const toFolder = fresh('lstat-info-to-folder');
    const dangling = fresh('lstat-info-dangling');
    await symlink(target, toFile);
    await symlink(dir, toFolder);
    await symlink(join(dir, 'lstat-info-no-target'), dangling);
    for (const link of [toFile, toFolder, dangling]) {
      expect(await deps.fs.lstatInfo(link)).toEqual({ ok: true, value: { kind: 'link' } });
    }
  });
});

describe('node deps: a checked open', () => {
  const uid = process.getuid?.() ?? null;
  const request = (maxBytes: number | null, parts: { uid?: number | null; decode?: 'lenient' | 'fatal' } = {}) => ({
    uid: parts.uid === undefined ? uid : parts.uid,
    maxBytes,
    ...(parts.decode === undefined ? {} : { decode: parts.decode }),
  });
  const fileWith = async (name: string, content: string | Buffer, mode = 0o600): Promise<string> => {
    const file = fresh(name);
    await writeFile(file, content);
    await chmod(file, mode);
    return file;
  };

  it('gives the facts and the text of a regular file, and the count of the bytes that it read', async () => {
    const file = await fileWith('open-text.txt', 'abcé');
    const result = await deps.fs.openChecked(file, request(100));
    expect(result).toEqual({
      ok: true,
      value: { state: 'opened', text: 'abcé', bytes: 5, info: { kind: 'file', uid, mode: 0o600, mtimeMs: (await stat(file)).mtimeMs, size: 5 } },
    });
  });

  it('gives the facts of a file and reads no byte when the request has no cap', async () => {
    const file = await fileWith('open-facts.txt', 'abc');
    expect(await deps.fs.openChecked(file, request(null))).toMatchObject({ ok: true, value: { state: 'opened', text: null, bytes: 0, info: { size: 3 } } });
  });

  it('accepts a file that others can read but not write', async () => {
    const file = await fileWith('open-readable.txt', 'abc', 0o644);
    expect(await deps.fs.openChecked(file, request(100))).toMatchObject({ ok: true, value: { state: 'opened', text: 'abc' } });
  });

  it.each([
    ['a group', 0o664],
    ['other users', 0o646],
  ])('refuses a file that %s can write, and reads no byte of it', async (_who, mode) => {
    const file = await fileWith(`open-writable-${mode}.txt`, 'abc', mode);
    expect(await deps.fs.openChecked(file, request(100))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'writableByOthers', bytes: 0 } });
    expect(await deps.fs.openChecked(file, request(null))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'writableByOthers', bytes: 0 } });
  });

  it.runIf(uid !== null)('refuses a file of another account, and skips the owner check when the request has no user', async () => {
    const file = await fileWith('open-owner.txt', 'abc');
    const other = (uid ?? 0) + 1;
    expect(await deps.fs.openChecked(file, request(100, { uid: other }))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'otherOwner', bytes: 0 } });
    expect(await deps.fs.openChecked(file, request(100, { uid: null }))).toMatchObject({ ok: true, value: { state: 'opened', text: 'abc' } });
  });

  it('refuses a file larger than the cap with no byte read, and reads a file that is as large as the cap', async () => {
    const file = await fileWith('open-size.txt', '0123456789');
    expect(await deps.fs.openChecked(file, request(9))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'size', bytes: 0 } });
    expect(await deps.fs.openChecked(file, request(10))).toMatchObject({ ok: true, value: { state: 'opened', text: '0123456789', bytes: 10 } });
  });

  it.runIf(process.platform === 'linux')('charges the cap plus one byte for a file that holds more than its size said', async () => {
    // A file of /proc says a size of 0 and then gives its content, as a file that grew after the size check does.
    const result = await deps.fs.openChecked('/proc/self/status', request(10));
    expect(result).toMatchObject({ ok: true, value: { state: 'refused', fault: 'size', bytes: 11 } });
  });

  it('gives a link as a link, also when it has no target, and reads nothing of the target', async () => {
    const target = await fileWith('open-link-target.txt', 'secret');
    const toFile = fresh('open-link');
    const dangling = fresh('open-dangling');
    await symlink(target, toFile);
    await symlink(join(dir, 'open-no-target'), dangling);
    expect(await deps.fs.openChecked(toFile, request(100))).toEqual({ ok: true, value: { state: 'link' } });
    expect(await deps.fs.openChecked(dangling, request(100))).toEqual({ ok: true, value: { state: 'link' } });
    expect(await deps.fs.openChecked(toFile, request(null))).toEqual({ ok: true, value: { state: 'link' } });
  });

  it('gives absent for a path that does not exist, and for a path below a file', async () => {
    const file = await fileWith('open-below.txt', 'abc');
    expect(await deps.fs.openChecked(fresh('open-none'), request(100))).toEqual({ ok: true, value: { state: 'absent' } });
    expect(await deps.fs.openChecked(join(file, 'below'), request(100))).toEqual({ ok: true, value: { state: 'absent' } });
  });

  it('refuses a folder as the wrong kind', async () => {
    expect(await deps.fs.openChecked(dir, request(100))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'wrong-kind', bytes: 0 } });
  });

  it('refuses a named pipe as the wrong kind, and does not wait for a writer', async () => {
    const fifo = fresh('open-fifo');
    const made = await deps.run('mkfifo', [fifo]);
    expect(made.ok && made.value.exitCode).toBe(0);
    expect(await deps.fs.openChecked(fifo, request(100))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'wrong-kind', bytes: 0 } });
    expect(await deps.fs.openChecked(fifo, request(null))).toMatchObject({ ok: true, value: { state: 'refused', fault: 'wrong-kind', bytes: 0 } });
  });

  it('gives the bytes that it read, and no text, for bytes that are not UTF-8 with the fatal decode', async () => {
    const file = await fileWith('open-binary.bin', Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    expect(await deps.fs.openChecked(file, request(100, { decode: 'fatal' }))).toMatchObject({ ok: true, value: { state: 'unreadable', bytes: 4 } });
    expect(await deps.fs.openChecked(file, request(100))).toMatchObject({ ok: true, value: { state: 'opened', text: 'a��b', bytes: 4 } });
  });

  it('keeps a byte order mark in the text', async () => {
    const file = await fileWith('open-bom.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    expect(await deps.fs.openChecked(file, request(100, { decode: 'fatal' }))).toMatchObject({ ok: true, value: { state: 'opened', text: '﻿a', bytes: 4 } });
  });

  it('reads a file of more than one chunk whole', async () => {
    const text = 'x'.repeat(200_000);
    const file = await fileWith('open-large.txt', text);
    expect(await deps.fs.openChecked(file, request(200_000))).toMatchObject({ ok: true, value: { state: 'opened', text, bytes: 200_000 } });
  });

  it.each([-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('fails, and opens nothing, for the cap %s', async (cap) => {
    const file = await fileWith(`open-cap-${String(cap)}.txt`, 'abc');
    expect((await deps.fs.openChecked(file, request(cap))).ok).toBe(false);
  });

  it('closes the file on every path: many calls hit no limit of open files', async () => {
    const good = await fileWith('open-close-good.txt', 'abc');
    const wide = await fileWith('open-close-wide.txt', 'abc', 0o666);
    const binary = await fileWith('open-close-binary.bin', Buffer.from([0xff]));
    for (let at = 0; at < 600; at += 1) {
      expect((await deps.fs.openChecked(good, request(100))).ok).toBe(true);
      expect((await deps.fs.openChecked(wide, request(100))).ok).toBe(true);
      expect((await deps.fs.openChecked(binary, request(100, { decode: 'fatal' }))).ok).toBe(true);
      expect((await deps.fs.openChecked(dir, request(100))).ok).toBe(true);
    }
  });

  it('fails with the code for a path that it cannot open', async () => {
    const folder = fresh('open-denied');
    await mkdir(folder);
    const file = join(folder, 'f.txt');
    await writeFile(file, 'x', 'utf8');
    await chmod(folder, 0o000);
    try {
      const result = await deps.fs.openChecked(file, request(100));
      // A user that is root can open the file anyway.
      if (uid !== 0) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('EACCES');
      }
    } finally {
      await chmod(folder, 0o700);
    }
  });
});

describe('node deps: exclusive write', () => {
  it('creates a file with the text and the mode, and says that it did', async () => {
    const file = fresh('exclusive.lock');
    expect(await deps.fs.writeTextExclusive(file, '123\n', 0o600)).toEqual({ ok: true, value: true });
    expect(await readFile(file, 'utf8')).toBe('123\n');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('leaves a file that exists as it was, and says that it did not create it', async () => {
    const file = fresh('exclusive-held.lock');
    await writeFile(file, 'other process', 'utf8');
    expect(await deps.fs.writeTextExclusive(file, 'mine', 0o600)).toEqual({ ok: true, value: false });
    expect(await readFile(file, 'utf8')).toBe('other process');
  });

  it('does not follow a link: the target stays as it was', async () => {
    const victim = fresh('exclusive-victim.txt');
    const link = fresh('exclusive-link.lock');
    await writeFile(victim, 'victim text', 'utf8');
    await symlink(victim, link);
    expect(await deps.fs.writeTextExclusive(link, 'mine', 0o600)).toEqual({ ok: true, value: false });
    expect(await readFile(victim, 'utf8')).toBe('victim text');
  });

  it('returns an error with the code when the folder does not exist', async () => {
    const result = await deps.fs.writeTextExclusive(join(fresh('no-folder'), 'x.lock'), 'x', 0o600);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
  });

  describe('when the write fails after the file was created', () => {
    const full = (): Error => Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    const exists = (path: string): Promise<boolean> =>
      stat(path).then(
        () => true,
        () => false,
      );

    /** The class of the open files: a write to a full disk is a failure of the write method after the create succeeded. */
    const handleClass = async (): Promise<FileHandle> => {
      const probe = fresh('probe');
      await writeFile(probe, '', 'utf8');
      const handle = await open(probe);
      await handle.close();
      return Object.getPrototypeOf(handle) as FileHandle;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the error and removes the file that it created', async () => {
      const file = fresh('exclusive-full.lock');
      vi.spyOn(await handleClass(), 'writeFile').mockRejectedValueOnce(full());
      expect(await deps.fs.writeTextExclusive(file, 'text', 0o600)).toEqual({
        ok: false,
        error: { kind: 'failure', message: `cannot write ${file}: ENOSPC` },
      });
      expect(await exists(file)).toBe(false);
    });

    it('leaves a file that another process put at the path in the meantime', async () => {
      const file = fresh('exclusive-replaced.lock');
      vi.spyOn(await handleClass(), 'writeFile').mockImplementationOnce(async () => {
        await rm(file);
        await writeFile(file, 'other process', 'utf8');
        throw full();
      });
      const result = await deps.fs.writeTextExclusive(file, 'text', 0o600);
      expect(result.ok).toBe(false);
      expect(await readFile(file, 'utf8')).toBe('other process');
    });
  });
});

describe('node deps: sleep', () => {
  it('waits at least the time that the caller asks for', async () => {
    const start = Date.now();
    await deps.sleep(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });
});

describe('node deps: the reader of a long program', () => {
  const stdoutWrites = (outcome: (callback: (error?: Error | null) => void) => void): string[] => {
    const taken: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, second?: unknown) => {
      taken.push(String(chunk));
      outcome(second as (error?: Error | null) => void);
      return true;
    });
    return taken;
  };

  const nextTurn = (): Promise<void> => new Promise((resolve) => void setImmediate(resolve));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('M5-1b TP-102 gives the id of the parent process as the system gives it now', () => {
    expect(createNodeDeps().parentPid()).toBe(process.ppid);
  });

  it('M5-1b TP-102 asks the system at each call whether stdout is a terminal, so a change shows', () => {
    const made = createNodeDeps();
    vi.mocked(isatty).mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect([made.stdoutIsTerminal(), made.stdoutIsTerminal()]).toEqual([true, false]);
    expect(isatty).toHaveBeenLastCalledWith(1);
  });

  it('M5-1b TP-56 writes the text to stdout and waits until the write is done', async () => {
    const taken = stdoutWrites((callback) => callback(null));
    const result = await createNodeDeps().writeStdout('a frame\n');
    expect(result.ok).toBe(true);
    expect(taken).toEqual(['a frame\n']);
  });

  it.each(['EPIPE', 'EIO'])('M5-1b TP-56 fails with the code %s of a write that fails, and the error event of the stream that follows is handled', async (code) => {
    const before = process.stdout.listenerCount('error');
    const broken = Object.assign(new Error(`write ${code}`), { code });
    // As the stream does: the callback of the write gets the error first, and then the stream emits it.
    stdoutWrites((callback) => {
      callback(broken);
      process.stdout.emit('error', broken);
    });
    const result = await createNodeDeps().writeStdout('a frame\n');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toContain(code);
    await nextTurn();
    expect(process.stdout.listenerCount('error')).toBe(before);
  });

  it('M5-1b TP-56 leaves no listener on stdout after a write that fails with no error event', async () => {
    const before = process.stdout.listenerCount('error');
    stdoutWrites((callback) => callback(Object.assign(new Error('write EIO'), { code: 'EIO' })));
    expect((await createNodeDeps().writeStdout('x')).ok).toBe(false);
    await nextTurn();
    expect(process.stdout.listenerCount('error')).toBe(before);
  });
});

describe('node deps: the program path', () => {
  it('is the node program and the real path of the script, both absolute', async () => {
    const script = await realpath(process.argv[1] ?? '');
    expect(createNodeDeps().programArgv).toEqual([process.execPath, script]);
    expect(createNodeDeps().programArgv.every((word) => isAbsolute(word))).toBe(true);
  });

  it('resolves a link to the script, so the path names the file that runs', async () => {
    const script = fresh('script.js');
    const link = fresh('link.js');
    await writeFile(script, '');
    await symlink(script, link);
    expect(programArgvOf('/n/node', link)).toEqual(['/n/node', await realpath(script)]);
  });

  it('is empty when the process has no script path, so that no caller builds a command from a guess', () => {
    expect(programArgvOf('/n/node', undefined)).toEqual([]);
  });

  it('is empty when the script path does not exist', () => {
    expect(programArgvOf('/n/node', join(dir, 'no-such-script.js'))).toEqual([]);
  });
});

describe('node deps: random hex text', () => {
  it('gives two characters of lower case hex text for each byte', () => {
    const result = deps.randomHex(16);
    expect(result.ok && result.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives a new text for each call', () => {
    const texts = new Set(Array.from({ length: 20 }, () => deps.randomHex(16)).map((result) => result.ok && result.value));
    expect(texts.size).toBe(20);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65])('refuses the count %s of bytes', (bytes) => {
    expect(deps.randomHex(bytes).ok).toBe(false);
  });
});

describe('node deps: end a process', () => {
  const PID = 4321;
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends TERM to the pid, and no other signal', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(deps.terminate(PID)).toEqual({ ok: true, value: 'sent' });
    expect(kill.mock.calls).toEqual([[PID, 'SIGTERM']]);
  });

  it('says that the process is gone when there is none with that pid', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('ESRCH'));
    expect(deps.terminate(PID)).toEqual({ ok: true, value: 'gone' });
  });

  it('fails with the code when the program may not signal the process', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('EPERM'));
    const result = deps.terminate(PID);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain('EPERM');
  });

  it.each([0, 1, -1, -PID, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, process.pid])(
    'refuses the pid %j and sends nothing',
    (pid) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      expect(deps.terminate(pid).ok).toBe(false);
      expect(deps.isRunning(pid).ok).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('asks with the signal 0 whether a process runs', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(deps.isRunning(PID)).toEqual({ ok: true, value: true });
    expect(kill.mock.calls).toEqual([[PID, 0]]);
  });

  it('says that no process runs when there is none with that pid', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('ESRCH'));
    expect(deps.isRunning(PID)).toEqual({ ok: true, value: false });
  });

  it('says that a process runs when the program may not signal it', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('EPERM'));
    expect(deps.isRunning(PID)).toEqual({ ok: true, value: true });
  });

  it('fails for any other error of the check', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('EINVAL'));
    expect(deps.isRunning(PID).ok).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('node deps: a process that ended but is not collected yet', () => {
  const children: ChildProcess[] = [];

  /**
   * Starts a program that makes a short child and then becomes `sleep`, which never collects the exit status of that child. The child
   * ends at once and stays a zombie. The value is the pid of the child and the pid of its parent.
   */
  const withZombie = async (): Promise<{ readonly zombie: number; readonly parent: number }> => {
    const parent = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(parent);
    const first = await new Promise<string>((resolve) => parent.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString())));
    await wait(700);
    return { zombie: Number(first.trim()), parent: parent.pid ?? 0 };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  it('counts a zombie as ended, although the signal 0 still reaches it', async () => {
    const { zombie } = await withZombie();
    // The pid came from the shell of this test. The signal 0 sends nothing, and a bad pid fails here before the call.
    expect(isOwnChildPid(zombie)).toBe(true);
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(deps.isRunning(zombie)).toEqual({ ok: true, value: false });
  });

  it('counts a process that runs as running', async () => {
    const { parent } = await withZombie();
    expect(deps.isRunning(parent)).toEqual({ ok: true, value: true });
  });

  it('counts a process as running when the state can not be read', async () => {
    const { zombie, parent } = await withZombie();
    vi.stubEnv('PATH', '/nonexistent-folder-of-the-test');
    expect(deps.isRunning(parent)).toEqual({ ok: true, value: true });
    expect(deps.isRunning(zombie)).toEqual({ ok: true, value: true });
  });
});

describe('node deps: atomic write', () => {
  it('replaces the text of an existing file and leaves no temporary file', async () => {
    const folder = fresh('replace');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'CLAUDE.md');
    await writeFile(file, 'old text', 'utf8');
    expect((await deps.fs.writeTextAtomic(file, 'new text', folder)).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('new text');
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['CLAUDE.md'] });
  });

  it('creates a file that does not exist', async () => {
    const folder = fresh('create');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'factory.yaml');
    expect((await deps.fs.writeTextAtomic(file, 'schema: 1\n', folder)).ok).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('schema: 1\n');
  });

  it('keeps the permissions of the file', async () => {
    const folder = fresh('mode');
    await deps.fs.mkdir(folder);
    const file = join(folder, 'CLAUDE.md');
    await writeFile(file, 'old text', 'utf8');
    await chmod(file, 0o600);
    expect((await deps.fs.writeTextAtomic(file, 'new text', folder)).ok).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('gives a new file the mode that the caller asks for, and replaces the mode of an old file', async () => {
    const folder = fresh('given-mode');
    await deps.fs.mkdir(folder);
    const created = join(folder, 'new.json');
    expect((await deps.fs.writeTextAtomic(created, '{}', folder, 0o600)).ok).toBe(true);
    expect((await stat(created)).mode & 0o777).toBe(0o600);

    const old = join(folder, 'old.json');
    await writeFile(old, '{}', 'utf8');
    await chmod(old, 0o644);
    expect((await deps.fs.writeTextAtomic(old, '{"a":1}', folder, 0o600)).ok).toBe(true);
    expect((await stat(old)).mode & 0o777).toBe(0o600);
  });

  it('creates a folder with the mode that the caller asks for', async () => {
    const folder = fresh('private-folder');
    expect((await deps.fs.mkdir(folder, 0o700)).ok).toBe(true);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it('refuses a link at the target, also a link to a file in the folder, and changes nothing', async () => {
    const folder = fresh('link');
    await deps.fs.mkdir(folder);
    const target = join(folder, 'real.md');
    const link = join(folder, 'CLAUDE.md');
    await writeFile(target, 'old text', 'utf8');
    await symlink(target, link);
    const result = await deps.fs.writeTextAtomic(link, 'new text', folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('is a link');
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('old text');
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['CLAUDE.md', 'real.md'] });
  });

  it('refuses a link at the target when the target of the link does not exist, and makes no file there', async () => {
    const folder = fresh('dangling');
    const outside = fresh('dangling-outside');
    await deps.fs.mkdir(folder);
    await deps.fs.mkdir(outside);
    const missing = join(outside, 'made-by-the-write.md');
    const link = join(folder, 'CLAUDE.md');
    await symlink(missing, link);
    const result = await deps.fs.writeTextAtomic(link, 'new text', folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('is a link');
    expect(await deps.fs.list(outside)).toEqual({ ok: true, value: [] });
    expect(await readlink(link)).toBe(missing);
  });

  it('refuses a path that resolves outside the folder because a part of the path is a link', async () => {
    const folder = fresh('through-link');
    const outside = fresh('through-link-outside');
    await deps.fs.mkdir(folder);
    await deps.fs.mkdir(outside);
    await symlink(outside, join(folder, 'inner'));
    const result = await deps.fs.writeTextAtomic(join(folder, 'inner', 'x.md'), 'new text', folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('is outside');
    expect(await deps.fs.list(outside)).toEqual({ ok: true, value: [] });
  });

  it('refuses a path that leaves the folder by a parent part, and a folder next to it with a longer name', async () => {
    const folder = fresh('leaves');
    const sibling = `${folder}-more`;
    await deps.fs.mkdir(join(folder, 'inner'));
    await deps.fs.mkdir(sibling);
    const up = await deps.fs.writeTextAtomic(`${folder}/inner/../../${basename(sibling)}/x.md`, 'new text', folder);
    expect(up.ok).toBe(false);
    const next = await deps.fs.writeTextAtomic(join(sibling, 'x.md'), 'new text', folder);
    expect(next.ok).toBe(false);
    expect(await deps.fs.list(sibling)).toEqual({ ok: true, value: [] });
  });

  it('writes in a folder below the folder that the caller names, also when the caller names a link to the folder', async () => {
    const real = fresh('real-folder');
    const named = fresh('named-link');
    await deps.fs.mkdir(join(real, 'inner'));
    await symlink(real, named);
    const file = join(named, 'inner', 'x.md');
    expect((await deps.fs.writeTextAtomic(file, 'new text', named)).ok).toBe(true);
    expect(await readFile(join(real, 'inner', 'x.md'), 'utf8')).toBe('new text');
  });

  it('fails and leaves no temporary file when the folder does not exist', async () => {
    const folder = fresh('missing');
    const result = await deps.fs.writeTextAtomic(join(folder, 'CLAUDE.md'), 'text', folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: null });
  });

  it('does not follow a link at the old temporary name, and leaves the link as it was', async () => {
    const folder = fresh('planted');
    await deps.fs.mkdir(folder);
    const victim = join(folder, 'victim.txt');
    const target = join(folder, 'homes.json');
    await writeFile(victim, 'victim text', 'utf8');
    await symlink(victim, `${target}.tmp-${process.pid}`);
    expect((await deps.fs.writeTextAtomic(target, 'new text', folder, 0o600)).ok).toBe(true);
    expect(await readFile(victim, 'utf8')).toBe('victim text');
    expect(await readFile(target, 'utf8')).toBe('new text');
    expect(await readlink(`${target}.tmp-${process.pid}`)).toBe(victim);
  });

  it('does not touch a file at the old temporary name, and leaves only the target and that file', async () => {
    const folder = fresh('planted-file');
    await deps.fs.mkdir(folder);
    const target = join(folder, 'homes.json');
    const planted = `${target}.tmp-${process.pid}`;
    await writeFile(planted, 'planted text', 'utf8');
    expect((await deps.fs.writeTextAtomic(target, 'new text', folder, 0o600)).ok).toBe(true);
    expect(await readFile(planted, 'utf8')).toBe('planted text');
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['homes.json', `homes.json.tmp-${process.pid}`] });
  });

  it('keeps the old text and leaves no temporary file when the target is a folder', async () => {
    const folder = fresh('blocked');
    const target = join(folder, 'CLAUDE.md');
    await deps.fs.mkdir(target);
    const result = await deps.fs.writeTextAtomic(target, 'text', folder);
    expect(result.ok).toBe(false);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['CLAUDE.md'] });
  });
});

describe('node deps: remove an empty folder', () => {
  it('removes an empty folder', async () => {
    const folder = fresh('empty');
    await deps.fs.mkdir(folder);
    expect((await deps.fs.removeEmptyDir(folder)).ok).toBe(true);
    expect(await deps.fs.stat(folder)).toEqual({ ok: true, value: null });
  });

  it('keeps a folder that holds a file, and fails', async () => {
    const folder = fresh('full');
    await deps.fs.mkdir(folder);
    await writeFile(join(folder, 'other.txt'), 'x', 'utf8');
    const result = await deps.fs.removeEmptyDir(folder);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/ENOTEMPTY|EEXIST/);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['other.txt'] });
  });

  it('keeps a folder that holds a folder, and fails', async () => {
    const folder = fresh('nested');
    await deps.fs.mkdir(join(folder, 'inner'));
    expect((await deps.fs.removeEmptyDir(folder)).ok).toBe(false);
    expect(await deps.fs.stat(join(folder, 'inner'))).toEqual({ ok: true, value: 'dir' });
  });

  it('does not fail for a path that does not exist', async () => {
    expect((await deps.fs.removeEmptyDir(fresh('none'))).ok).toBe(true);
  });
});

describe('node deps: remove a file', () => {
  it('removes a file', async () => {
    const file = fresh('file.txt');
    await writeFile(file, 'x', 'utf8');
    expect((await deps.fs.removeFile(file)).ok).toBe(true);
    expect(await deps.fs.stat(file)).toEqual({ ok: true, value: null });
  });

  it('removes a link and keeps the file that it points to', async () => {
    const victim = fresh('victim.txt');
    const link = fresh('link.txt');
    await writeFile(victim, 'victim text', 'utf8');
    await symlink(victim, link);
    expect((await deps.fs.removeFile(link)).ok).toBe(true);
    expect(await deps.fs.lstat(link)).toEqual({ ok: true, value: null });
    expect(await readFile(victim, 'utf8')).toBe('victim text');
  });

  it('does not fail for a path that does not exist', async () => {
    expect((await deps.fs.removeFile(fresh('none'))).ok).toBe(true);
  });

  it('keeps a folder and what it holds, and fails', async () => {
    const folder = fresh('folder');
    await deps.fs.mkdir(folder);
    await writeFile(join(folder, 'other.txt'), 'x', 'utf8');
    const result = await deps.fs.removeFile(folder);
    expect(result.ok).toBe(false);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['other.txt'] });
  });
});

describe('node deps: create one folder', () => {
  it('creates the folder with the mode', async () => {
    const folder = fresh('one');
    expect((await deps.fs.mkdirOne(folder, 0o700)).ok).toBe(true);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it('makes no parent: a parent that is not there gives an error with the code, and nothing is made', async () => {
    const parent = fresh('no-parent');
    const result = await deps.fs.mkdirOne(join(parent, 'inner'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ENOENT');
    expect(await deps.fs.stat(parent)).toEqual({ ok: true, value: null });
  });

  it('is no error for a folder that exists already, and keeps what it holds', async () => {
    const folder = fresh('there');
    await deps.fs.mkdir(folder);
    await writeFile(join(folder, 'other.txt'), 'x', 'utf8');
    expect((await deps.fs.mkdirOne(folder)).ok).toBe(true);
    expect(await deps.fs.list(folder)).toEqual({ ok: true, value: ['other.txt'] });
  });

  it('fails for a file at the path', async () => {
    const file = fresh('file.txt');
    await writeFile(file, 'x', 'utf8');
    const result = await deps.fs.mkdirOne(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('EEXIST');
  });

  it('fails for a link to a folder, and does not follow it', async () => {
    const target = fresh('target');
    const link = fresh('link');
    await deps.fs.mkdir(target);
    await symlink(target, link);
    const result = await deps.fs.mkdirOne(link);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('EEXIST');
    expect(await lstat(link).then((info) => info.isSymbolicLink())).toBe(true);
  });
});

describe('node deps: fetch', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/slow') return;
      response.statusCode = request.url === '/broken' ? 500 : 200;
      response.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns the status of an answer', async () => {
    expect(await deps.fetch(`${base}/ok`, 2000)).toEqual({ ok: true, value: { status: 200 } });
    expect(await deps.fetch(`${base}/broken`, 2000)).toEqual({ ok: true, value: { status: 500 } });
  });

  it('returns an error when nothing answers in time', async () => {
    expect((await deps.fetch(`${base}/slow`, 150)).ok).toBe(false);
  });

  it('returns an error when the port is closed', async () => {
    expect((await deps.fetch('http://127.0.0.1:1/health', 1000)).ok).toBe(false);
  });
});
