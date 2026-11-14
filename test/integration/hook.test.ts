import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookNames, type HookEvent } from '../../src/names.js';
import { DIST, makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

let box: Sandbox;
let home: string;

const NODE_ID = 'demo';
const SESSION = '00000000-0000-4000-8000-000000000001';

/** The captured payload of each event. The path is written out here: it is the contract with the program that reads the line. */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
  readonly hooks: Readonly<Record<HookEvent, Readonly<Record<string, unknown>>>>;
  readonly statusline: { readonly payload: Readonly<Record<string, unknown>> };
};

/** The time that the start of a test may take: the sandbox and the run of `init` with the built binary. It is the time limit of a test. */
const SETUP_TIMEOUT_MS = 30_000;

beforeEach(async () => {
  box = await makeSandbox();
  home = join(box.root, 'web-factory');
  const made = await box.run(['init', '--yes', '--home', home, '--name', NODE_ID, '--owner-name', 'Test Owner']);
  expect(made.code).toBe(0);
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const lastSeenFile = (): string => join(home, '.factory', 'state', 'heartbeat', SESSION);

/** Run the hook of Claude Code in the sandbox, as a hook of the coordinator session: the environment and the input are the ones of a hook. */
const hook = (event: string, input: string, env: Readonly<Record<string, string>> = {}): Promise<RunResult> =>
  box.run(['hook', event], { cwd: home, env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID, ...env }, input });

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const WAIT_STEP_MS = 25;
/** The wait for the start of the owner command in a signal test. A loaded runner can stall the built binary and its shell for more than 15 s. */
const SIGNAL_START_WAIT_MS = 60_000;
/** The wait for the end of the command group after the signal. The binary is up then, so the stop needs little time. */
const SIGNAL_WAIT_MS = 15_000;
/** The time limit of a signal test: the two waits of the test, plus 15 s for the end of the run. */
const SIGNAL_TEST_TIMEOUT_MS = SIGNAL_START_WAIT_MS + SIGNAL_WAIT_MS + 15_000;
/** The wait after the end of a run for the write of a process that the stop did not reach: twice the 1 s that it needs. */
const LATE_WRITE_WAIT_MS = 2_000;

/** The first value that `probe` gives, tried every few milliseconds for at most `maxMs`. A test fails when none comes. */
const waitFor = async <T>(probe: () => Promise<T | undefined>, maxMs: number): Promise<T> => {
  const steps = Math.ceil(maxMs / WAIT_STEP_MS);
  for (let step = 0; step < steps; step += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`no value after ${maxMs} ms`);
};

/** True while any process is left in the process group. A group with no process gives ESRCH. */
const groupExists = (group: number): boolean => {
  if (group <= 0) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

describe('factory hook (built binary)', () => {
  it('writes the last-seen line for one event from the input of a hook', async () => {
    const before = Date.now();
    const result = await hook('SessionStart', JSON.stringify(FIXTURE.hooks.SessionStart));
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });

    const line = JSON.parse(await readFile(lastSeenFile(), 'utf8')) as Record<string, unknown>;
    expect(line).toMatchObject({
      schema: 'factory.last-seen/v1',
      session_id: SESSION,
      event: 'SessionStart',
      context_pct: null,
      pct_at: null,
    });
    const at = Date.parse(String(line['event_at']));
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await stat(lastSeenFile())).mode & 0o777).toBe(0o600);
  });

  it('records the pointer to the newest session of the coordinator in the run-time folder, which the state repo ignores', async () => {
    expect(await hook('SessionStart', JSON.stringify(FIXTURE.hooks.SessionStart))).toEqual({ code: 0, stdout: '', stderr: '' });
    const pointer = join(home, '.factory', 'state', 'coordinator-last-session');
    expect(await readFile(pointer, 'utf8')).toBe(`${SESSION}\n`);
    expect((await stat(pointer)).mode & 0o777).toBe(0o600);
    const ignored = (await readFile(join(home, '.factory', '.gitignore'), 'utf8')).split('\n');
    expect(ignored).toContain('state/');
  });

  it('keeps one file for the session, with the event of the last call', async () => {
    for (const event of hookNames.events) {
      expect(await hook(event, JSON.stringify(FIXTURE.hooks[event]))).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(await readdir(join(home, '.factory', 'state', 'heartbeat'))).toEqual([SESSION]);
    expect(JSON.parse(await readFile(lastSeenFile(), 'utf8'))).toMatchObject({ event: hookNames.events.at(-1) });
  });

  it('never stores the path of the transcript', async () => {
    await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop));
    const text = await readFile(lastSeenFile(), 'utf8');
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('placeholder');
  });

  it('exits 0 with an empty stdout and stderr, and writes nothing, outside a factory session', async () => {
    const result = await box.run(['hook', 'Stop'], { cwd: home, input: JSON.stringify(FIXTURE.hooks.Stop) });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it.each([
    ['a payload that is not JSON', 'Stop', 'not json'],
    ['an empty payload', 'Stop', ''],
    ['an event off the list', 'SubagentStop', JSON.stringify(FIXTURE.hooks.Stop)],
    ['an event that differs from the input', 'SessionStart', JSON.stringify(FIXTURE.hooks.Stop)],
    ['a session id that is not a UUID', 'Stop', JSON.stringify({ ...FIXTURE.hooks.Stop, session_id: '../../escape' })],
  ])('exits 0 with an empty stdout and one line on stderr for %s, and writes nothing', async (_name, event, input) => {
    const result = await hook(event, input);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('writes nothing for a session that is not the node', async () => {
    const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop), { FACTORY_SESSION: 'another' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FACTORY_SESSION');
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  describe('with the id of a worker as the session', () => {
    const WORKER_ID = 'fix-login';

    /** The record of a worker as the file on disk holds it. The key names are written out: they are the file format. */
    const writeRecord = async (id: string): Promise<void> => {
      const folder = join(home, '.factory', 'workers', id);
      await mkdir(join(folder, 'inbox'), { recursive: true });
      const record = {
        schema: 'factory.worker/v1',
        id,
        project: 'web',
        work_copy: join(home, 'work-copies', 'web', id),
        branch: `worker/${id}`,
        created_at: new Date().toISOString(),
      };
      await writeFile(join(folder, 'worker.json'), `${JSON.stringify(record, null, 2)}\n`);
    };

    it('writes the last-seen line of a worker that has a record', async () => {
      await writeRecord(WORKER_ID);
      const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop), { FACTORY_SESSION: WORKER_ID });
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(JSON.parse(await readFile(lastSeenFile(), 'utf8'))).toMatchObject({
        schema: 'factory.last-seen/v1',
        session_id: SESSION,
        event: 'Stop',
      });
    });

    it('writes nothing for an id that has no record, and says why on one line of stderr', async () => {
      const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop), { FACTORY_SESSION: WORKER_ID });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
      expect(result.stderr).toContain('FACTORY_SESSION');
      expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
    });

    it('writes nothing for the id of another worker than the one that has a record', async () => {
      await writeRecord(WORKER_ID);
      const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop), { FACTORY_SESSION: 'other-worker' });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
    });
  });

  it('exits 0 with an empty stdout for a broken config, and writes nothing', async () => {
    await writeFile(join(home, 'factory.yaml'), 'core: [not closed');
    const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('exits 0 with an empty stdout and one line on stderr, and writes nothing, when the input stays open and sends nothing', async () => {
    const started = Date.now();
    const result = await box.run(['hook', 'Stop'], { cwd: home, env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID } });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('exits 0 with an empty stdout for a flag and for no event', async () => {
    for (const args of [['hook'], ['hook', '--help'], ['hook', '--json', 'Stop'], ['hook', '--bogus']]) {
      const result = await box.run(args, { cwd: home, env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID }, input: '{}' });
      expect(result.code, args.join(' ')).toBe(0);
      expect(result.stdout, args.join(' ')).toBe('');
    }
  });
});

/** The status line input of the fixture (built from the field names of the status line docs; the values are made up). */
const STATUS_INPUT = JSON.stringify(FIXTURE.statusline.payload);

/** Run the status line wrapper in the sandbox, as the status line of the coordinator session. */
const statusline = (input: string, env: Readonly<Record<string, string>> = {}): Promise<RunResult> =>
  box.run(['hook', 'statusline'], { cwd: home, env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID, ...env }, input });

/** Set the status line command of the owner in the private config. The file keeps its mode. */
const setOwnerCommand = async (command: string): Promise<void> => {
  const path = join(home, 'factory.local.yaml');
  const text = await readFile(path, 'utf8');
  expect(text).toContain('statusline: null');
  // A function gives the text as it is: a string would read `$$` and `$&` in the command as patterns.
  await writeFile(path, text.replace('statusline: null', () => `statusline: ${JSON.stringify(command)}`));
};

type Pipe = 'stdout' | 'stderr';

/**
 * Run the program with the read end of the named pipes closed before the program gets its input, so that its first write
 * to such a pipe fails with EPIPE. The result is the exit code and the text of the pipes that stay open.
 */
const runWithClosedPipes = async (
  args: readonly string[],
  input: string,
  closed: readonly Pipe[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> => {
  const child = spawn('node', [DIST, ...args], {
    cwd: home,
    env: { ...box.env, FACTORY_HOME: home, FACTORY_SESSION: NODE_ID, ...env },
  });
  const seen = { stdout: '', stderr: '' };
  const gone = closed.map(
    (name) =>
      new Promise<void>((resolve) => {
        child[name].once('close', () => resolve());
        child[name].destroy();
      }),
  );
  for (const name of ['stdout', 'stderr'] as const) {
    if (closed.includes(name)) continue;
    child[name].setEncoding('utf8');
    child[name].on('data', (chunk: string) => {
      seen[name] += chunk;
    });
  }
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await Promise.all(gone);
    child.stdin.end(input);
    return { code: await exited, ...seen };
  } finally {
    child.kill('SIGKILL');
  }
};

describe('factory hook (built binary): a pipe that Claude Code closed early', () => {
  it('exits 0 and prints no stack trace when the status line text can not be written', async () => {
    const result = await runWithClosedPipes(['hook', hookNames.statusline], STATUS_INPUT, ['stdout']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(await readFile(lastSeenFile(), 'utf8'))).toMatchObject({ context_pct: 8 });
  });

  it('exits 0 and prints no stack trace when the line on stderr can not be written', async () => {
    const result = await runWithClosedPipes(['hook', 'Stop'], 'not json', ['stderr']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 when neither the text nor the note of the status line can be written', async () => {
    const result = await runWithClosedPipes(['hook', hookNames.statusline], STATUS_INPUT, ['stdout', 'stderr'], {
      FACTORY_SESSION: 'another',
    });
    expect(result.code).toBe(0);
  });

  it('still prints the status line text on an open pipe when only stderr is closed', async () => {
    const result = await runWithClosedPipes(['hook', hookNames.statusline], STATUS_INPUT, ['stderr'], { FACTORY_SESSION: 'another' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
  });
});

describe('factory hook statusline (built binary)', () => {
  it('prints the output of the command of the owner as it is, gives it the input, and writes the percent', async () => {
    // The command prints the one part of its input that proves it got the input of the wrapper.
    await setOwnerCommand(`grep -o '"session_id":"[^"]*"'`);
    const result = await statusline(STATUS_INPUT);
    expect(result).toEqual({ code: 0, stdout: `"session_id":"${SESSION}"\n`, stderr: '' });

    const line = JSON.parse(await readFile(lastSeenFile(), 'utf8')) as Record<string, unknown>;
    expect(line).toMatchObject({ session_id: SESSION, event: null, event_at: null, context_pct: 8 });
    expect(Number.isNaN(Date.parse(String(line['pct_at'])))).toBe(false);
    expect((await stat(lastSeenFile())).mode & 0o777).toBe(0o600);
    const text = await readFile(lastSeenFile(), 'utf8');
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('placeholder');
  });

  it('keeps the event that the hook wrote before', async () => {
    await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop));
    await statusline(STATUS_INPUT);
    expect(JSON.parse(await readFile(lastSeenFile(), 'utf8'))).toMatchObject({ event: 'Stop', context_pct: 8 });
  });

  it('prints context ?% and exits 0 when the input stays open and sends nothing', async () => {
    await setOwnerCommand('echo owner');
    const started = Date.now();
    const result = await box.run(['hook', hookNames.statusline], {
      cwd: home,
      env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context ?%');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await exists(lastSeenFile())).toBe(false);
  });

  it('prints context N% and exits 0 when the config names no command', async () => {
    expect(await statusline(STATUS_INPUT)).toEqual({ code: 0, stdout: 'context 8%', stderr: '' });
  });

  it('prints context N%, drops the output of the command and exits 0 when the command fails', async () => {
    await setOwnerCommand('echo half an output; exit 3');
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(result.stderr).toMatch(/^factory hook: [^\n]*code 3\n$/);
  });

  it('prints context N% and exits 0 when the command does not end in time', async () => {
    await setOwnerCommand('exec sleep 30');
    const started = Date.now();
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops every process of a command with a pipe at the time limit, so none of them runs on', async () => {
    const late = join(box.root, 'late');
    await setOwnerCommand(`(sleep 3; echo late > '${late}') | cat`);
    const started = Date.now();
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(Date.now() - started).toBeLessThan(15_000);
    // The wait starts at the end of the run, not before the start of the binary: the late write comes 3 s after the command
    // starts, and the run ends 2 s after that, so a group that was not stopped writes within 1 s of this point.
    await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_WAIT_MS));
    expect(await exists(late)).toBe(false);
  });

  it.each(hookNames.stopSignals)('stops the command group of the owner and exits 0 when it gets %s', async (name) => {
    const marker = join(box.root, 'owner-group');
    // `$$` is the id of the shell, which leads the group of the command. A later command of the list joins the group.
    await setOwnerCommand(`echo $$ > '${marker}'; sleep 30`);
    const child = spawn('node', [DIST, 'hook', hookNames.statusline], {
      cwd: home,
      env: { ...box.env, FACTORY_HOME: home, FACTORY_SESSION: NODE_ID },
    });
    child.stdin.end(STATUS_INPUT);
    // The pipes are read, so that the program can end.
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    let group = 0;
    try {
      group = await waitFor(async () => {
        const text = await readFile(marker, 'utf8').catch(() => '');
        return Number(text.trim()) || undefined;
      }, SIGNAL_START_WAIT_MS);
      child.kill(name);
      expect(await exited).toBe(0);
      await waitFor(async () => (groupExists(group) ? undefined : true), SIGNAL_WAIT_MS);
    } finally {
      if (groupExists(group)) process.kill(-group, 'SIGKILL');
      child.kill('SIGKILL');
    }
    expect(groupExists(group)).toBe(false);
  }, SIGNAL_TEST_TIMEOUT_MS);

  it('prints the line and writes nothing outside a factory session', async () => {
    await setOwnerCommand('echo owner');
    const result = await box.run(['hook', 'statusline'], { cwd: home, input: STATUS_INPUT });
    expect(result).toEqual({ code: 0, stdout: 'context 8%', stderr: '' });
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('prints the line, runs no command and writes nothing for a session that is not the node', async () => {
    await setOwnerCommand('echo owner');
    const result = await statusline(STATUS_INPUT, { FACTORY_SESSION: 'another' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(result.stderr).toContain('FACTORY_SESSION');
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });
});
