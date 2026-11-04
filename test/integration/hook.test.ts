import { readFileSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookNames, type HookEvent } from '../../src/names.js';
import { makeSandbox, removeOpenSandboxes, type RunResult, type Sandbox } from './harness.js';

let box: Sandbox;
let home: string;

const NODE_ID = 'demo';
const SESSION = '00000000-0000-4000-8000-000000000001';

/** The captured payload of each event. The path is written out here: it is the contract with the program that reads the line. */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
  readonly hooks: Readonly<Record<HookEvent, Readonly<Record<string, unknown>>>>;
};

beforeEach(async () => {
  box = await makeSandbox();
  home = join(box.root, 'web-factory');
  const made = await box.run(['init', '--home', home, '--name', NODE_ID, '--owner-name', 'Test Owner']);
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
    ['the status line word, which is not on the list yet', 'statusline', JSON.stringify(FIXTURE.hooks.Stop)],
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

  it('exits 0 with an empty stdout for a flag and for no event (TP-12)', async () => {
    for (const args of [['hook'], ['hook', '--help'], ['hook', '--json', 'Stop'], ['hook', '--bogus']]) {
      const result = await box.run(args, { cwd: home, env: { FACTORY_HOME: home, FACTORY_SESSION: NODE_ID }, input: '{}' });
      expect(result.code, args.join(' ')).toBe(0);
      expect(result.stdout, args.join(' ')).toBe('');
    }
  });
});
