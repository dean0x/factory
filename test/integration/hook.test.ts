import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

beforeEach(async () => {
  box = await makeSandbox();
  home = join(box.root, 'web-factory');
  const made = await box.run(['init', '--yes', '--home', home, '--name', NODE_ID, '--owner-name', 'Test Owner']);
  expect(made.code).toBe(0);
});

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
const WAIT_STEPS = 120;

/** The first value that `probe` gives, tried every few milliseconds for at most three seconds. A test fails when none comes. */
const waitFor = async <T>(probe: () => Promise<T | undefined>): Promise<T> => {
  for (let step = 0; step < WAIT_STEPS; step += 1) {
    const found = await probe();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`no value after ${WAIT_STEPS * WAIT_STEP_MS} ms`);
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
  it('writes the last-seen line for one event from the input of a hook (TP-6)', async () => {
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

  it('keeps one file for the session, with the event of the last call', async () => {
    for (const event of hookNames.events) {
      expect(await hook(event, JSON.stringify(FIXTURE.hooks[event]))).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(await readdir(join(home, '.factory', 'state', 'heartbeat'))).toEqual([SESSION]);
    expect(JSON.parse(await readFile(lastSeenFile(), 'utf8'))).toMatchObject({ event: 'PreCompact' });
  });

  it('never stores the path of the transcript', async () => {
    await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop));
    const text = await readFile(lastSeenFile(), 'utf8');
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('placeholder');
  });

  it('exits 0 with an empty stdout and stderr, and writes nothing, outside a factory session (TP-12)', async () => {
    const result = await box.run(['hook', 'Stop'], { cwd: home, input: JSON.stringify(FIXTURE.hooks.Stop) });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it.each([
    ['a payload that is not JSON', 'Stop', 'not json'],
    ['an empty payload', 'Stop', ''],
    ['an event off the list', 'Notification', JSON.stringify(FIXTURE.hooks.Stop)],
    ['an event that differs from the input', 'SessionStart', JSON.stringify(FIXTURE.hooks.Stop)],
    ['a session id that is not a UUID', 'Stop', JSON.stringify({ ...FIXTURE.hooks.Stop, session_id: '../../escape' })],
  ])('exits 0 with an empty stdout and one line on stderr for %s, and writes nothing (TP-12)', async (_name, event, input) => {
    const result = await hook(event, input);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('writes nothing for a session that is not the node (TP-9)', async () => {
    const result = await hook('Stop', JSON.stringify(FIXTURE.hooks.Stop), { FACTORY_SESSION: 'another' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FACTORY_SESSION');
    expect(await exists(join(home, '.factory', 'state', 'heartbeat'))).toBe(false);
  });

  it('exits 0 with an empty stdout for a broken config, and writes nothing (TP-12)', async () => {
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

  it('exits 0 with an empty stdout for a flag and for no event (TP-12)', async () => {
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

describe('factory hook statusline (built binary)', () => {
  it('prints the output of the command of the owner as it is, gives it the input, and writes the percent (TP-13)', async () => {
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

  it('prints context N% and exits 0 when the config names no command (TP-14)', async () => {
    expect(await statusline(STATUS_INPUT)).toEqual({ code: 0, stdout: 'context 8%', stderr: '' });
  });

  it('prints context N%, drops the output of the command and exits 0 when the command fails (TP-14)', async () => {
    await setOwnerCommand('echo half an output; exit 3');
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(result.stderr).toMatch(/^factory hook: [^\n]*code 3\n$/);
  });

  it('prints context N% and exits 0 when the command does not end in time (TP-14)', async () => {
    await setOwnerCommand('exec sleep 30');
    const started = Date.now();
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(result.stderr).toMatch(/^factory hook: [^\n]+\n$/);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops every process of a command with a pipe at the time limit, so none of them runs on (TP-14)', async () => {
    const late = join(box.root, 'late');
    await setOwnerCommand(`(sleep 3; echo late > '${late}') | cat`);
    const started = Date.now();
    const result = await statusline(STATUS_INPUT);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('context 8%');
    expect(Date.now() - started).toBeLessThan(15_000);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 4_500 - Date.now())));
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
      });
      child.kill(name);
      expect(await exited).toBe(0);
      await waitFor(async () => (groupExists(group) ? undefined : true));
    } finally {
      if (groupExists(group)) process.kill(-group, 'SIGKILL');
      child.kill('SIGKILL');
    }
    expect(groupExists(group)).toBe(false);
  });

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
