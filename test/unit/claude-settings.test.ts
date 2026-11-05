import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import {
  declinedHookText,
  ensureHookSettings,
  isOwnSettingsText,
  ownSettingsEntries,
  requireHookConsent,
  type HookSettingsOutcome,
  type HookSettingsRequest,
} from '../../src/core/claude-settings.js';
import type { Deps } from '../../src/core/deps.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import { ok } from '../../src/core/result.js';
import { commands, hookNames, hookSessions, maxFileBytes, ownHookCommand } from '../../src/names.js';
import { createFakeDeps, withFsWatch, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';

const FOLDER = '/h/factory/coordinator';
const CLAUDE = `${FOLDER}/.claude`;
const FILE = `${CLAUDE}/settings.local.json`;
const USER_HOME = '/u';

/** The entries as they stand in a settings file. The names and the command texts are written out: they are the contract. */
const EXPECTED_ENTRIES = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'factory hook SessionStart' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'factory hook UserPromptSubmit' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'factory hook Stop' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'factory hook PreCompact' }] }],
  },
  statusLine: { type: 'command', command: 'factory hook statusline' },
};

const WRITE_CALLS = ['writeText', 'writeTextExclusive', 'writeTextAtomic', 'rename', 'remove', 'mkdir', 'chmod', 'copyTree', 'removeEmptyDir'];

interface Setup {
  /** A person types at the process and reads its output. */
  readonly tty?: boolean;
  /** The answer to the question. */
  readonly answer?: string;
  /** The process runs inside a session that factory started. */
  readonly inSession?: boolean;
  /** The user home of the environment. Null: not set. */
  readonly home?: string | null;
  /** The events of the test, in order: the question and each write. */
  readonly log?: string[];
}

const makeDeps = ({ tty = false, answer = 'y', inSession = false, home = USER_HOME, log = [] }: Setup = {}): FakeDeps => {
  const deps = createFakeDeps({
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    prompt: () => {
      log.push('prompt');
      return ok(answer);
    },
    env: { ...(home === null ? {} : { HOME: home }), ...(inSession ? { FACTORY_SESSION: 'node-1' } : {}) },
  });
  deps.seedDir(FOLDER);
  return deps;
};

/** The same deps, with each call that changes the file system logged as `write:<call>` and each warning as `warn`. */
const logged = <T extends Deps>(deps: T, log: string[]): T => ({
  ...withFsWatch(deps, (method) => {
    if (WRITE_CALLS.includes(method)) log.push(`write:${method}`);
  }),
  warn: (message) => {
    log.push('warn');
    deps.warn(message);
  },
});

const request = (overrides: Partial<HookSettingsRequest> = {}): HookSettingsRequest => ({
  folder: FOLDER,
  session: 'coordinator',
  yes: false,
  dryRun: false,
  command: commands.start,
  ...overrides,
});

/** The request of a check before the first write of a command: it has no dry run. */
const consentRequest = (overrides: Partial<HookSettingsRequest> = {}): Omit<HookSettingsRequest, 'dryRun'> => {
  const { dryRun: _dryRun, ...rest } = request(overrides);
  return rest;
};

const errorOf = <T>(result: CliResult<T>): { kind: string; message: string; hint?: string } => {
  if (result.ok) throw new Error('the call should have failed');
  return result.error;
};

const outcomeOf = (result: CliResult<HookSettingsOutcome>): HookSettingsOutcome => {
  if (!result.ok) throw new Error(`the call failed: ${result.error.message}`);
  return result.value;
};

const snapshot = (deps: FakeDeps): string =>
  JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

const stored = (deps: FakeDeps): Record<string, unknown> => JSON.parse(deps.files.get(FILE) ?? 'null') as Record<string, unknown>;

const groupsOf = (settings: Record<string, unknown>, event: string): unknown[] =>
  ((settings['hooks'] as Record<string, unknown[]>)[event] ?? []);

describe('the own entries', () => {
  it('are the four hooks and the status line, with the command text written out', () => {
    expect(ownSettingsEntries).toEqual(EXPECTED_ENTRIES);
  });

  it('use a command that the checks of the root know as the own command', () => {
    const commandsOfEntries = [
      ...hookNames.events.map((event) => ownSettingsEntries.hooks[event]?.[0]?.hooks[0]?.command),
      ownSettingsEntries.statusLine.command,
    ];
    expect(commandsOfEntries).toHaveLength(hookNames.events.length + 1);
    for (const command of commandsOfEntries) expect(ownHookCommand.test(command ?? '')).toBe(true);
  });
});

describe('hook settings: the change and the consent', () => {
  it('shows the exact change and the target before the write, and writes after a yes (TP-15)', async () => {
    const log: string[] = [];
    const deps = makeDeps({ tty: true, log });
    const outcome = outcomeOf(await ensureHookSettings(logged(deps, log), request()));
    expect(outcome).toEqual({ kind: 'written', file: FILE });
    expect(deps.prompts).toHaveLength(1);
    const question = deps.prompts[0] ?? '';
    expect(question).toContain(FILE);
    for (const event of hookNames.events) expect(question).toContain(`factory hook ${event}`);
    expect(question).toContain('factory hook statusline');
    expect(question).toContain('[y/N]');
    expect(log[0]).toBe('prompt');
    expect(log.slice(1).every((line) => line.startsWith('write:'))).toBe(true);
    expect(log.length).toBeGreaterThan(1);
    expect(stored(deps)).toEqual(EXPECTED_ENTRIES);
    expect(deps.files.get(FILE)?.endsWith('\n')).toBe(true);
  });

  it.each(['y', 'Y', 'yes', ' YES '])('takes the answer %j as a yes', async (answer) => {
    const deps = makeDeps({ tty: true, answer });
    expect(outcomeOf(await ensureHookSettings(deps, request())).kind).toBe('written');
  });

  it.each(['', 'n', 'no', 'maybe', 'yess'])('takes the answer %j as a no, and writes nothing', async (answer) => {
    const log: string[] = [];
    const deps = makeDeps({ tty: true, answer, log });
    const before = snapshot(deps);
    expect(outcomeOf(await ensureHookSettings(logged(deps, log), request()))).toEqual({ kind: 'declined', file: FILE });
    expect(log).toEqual(['prompt']);
    expect(snapshot(deps)).toBe(before);
  });

  it('passes the failure of the question on and writes nothing', async () => {
    const deps = makeDeps({ tty: true });
    const broken: Deps = { ...deps, prompt: async () => failure('no answer was given') };
    expect(errorOf(await ensureHookSettings(broken, request())).message).toBe('no answer was given');
    expect(deps.files.size).toBe(0);
  });

  it('keeps every other key and every other hook of the file', async () => {
    const deps = makeDeps({ tty: true });
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    deps.seed(
      FILE,
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Read'] },
        hooks: { Stop: [mine], Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
      }),
    );
    expect(outcomeOf(await ensureHookSettings(deps, request())).kind).toBe('written');
    const result = stored(deps);
    expect(Object.keys(result).slice(0, 3)).toEqual(['model', 'permissions', 'hooks']);
    expect(result['model']).toBe('opus');
    expect(result['permissions']).toEqual({ allow: ['Read'] });
    expect(groupsOf(result, 'Notification')).toEqual([{ hooks: [{ type: 'command', command: 'notify' }] }]);
    expect(groupsOf(result, 'Stop')).toEqual([mine, EXPECTED_ENTRIES.hooks.Stop[0]]);
    expect(groupsOf(result, 'SessionStart')).toEqual(EXPECTED_ENTRIES.hooks.SessionStart);
    expect(result['statusLine']).toEqual(EXPECTED_ENTRIES.statusLine);
  });

  it('names a status line that it replaces, and the key that keeps the own command (shown change)', async () => {
    const deps = makeDeps({ tty: true });
    deps.seed(FILE, JSON.stringify({ statusLine: { type: 'command', command: 'my-line --short' } }));
    expect(outcomeOf(await ensureHookSettings(deps, request())).kind).toBe('written');
    const question = deps.prompts[0] ?? '';
    expect(question).toContain('my-line --short');
    expect(question).toContain('session.statusline');
    expect(stored(deps)['statusLine']).toEqual(EXPECTED_ENTRIES.statusLine);
  });

  it('names no replaced status line and no key when the file has no status line', async () => {
    const deps = makeDeps({ tty: true });
    await ensureHookSettings(deps, request());
    expect(deps.prompts[0]).not.toContain('session.statusline');
    expect(deps.prompts[0]).not.toContain('replace');
  });

  it('shows a status line that is not a command as JSON text, cut to a short length', async () => {
    const deps = makeDeps({ tty: true });
    deps.seed(FILE, JSON.stringify({ statusLine: { type: 'static', text: 'x'.repeat(500) } }));
    await ensureHookSettings(deps, request());
    const question = deps.prompts[0] ?? '';
    expect(question).toContain('"type":"static"');
    expect(question).not.toContain('x'.repeat(200));
  });

  it('lists only the entries that are missing, and keeps the groups that hold an own command (TP-18)', async () => {
    const deps = makeDeps({ tty: true });
    const stop = { matcher: 'x', hooks: [{ type: 'command', command: 'echo a' }, { type: 'command', command: 'factory hook Stop' }] };
    deps.seed(
      FILE,
      JSON.stringify({
        hooks: { Stop: [stop], PreCompact: EXPECTED_ENTRIES.hooks.PreCompact },
        statusLine: EXPECTED_ENTRIES.statusLine,
      }),
    );
    expect(outcomeOf(await ensureHookSettings(deps, request())).kind).toBe('written');
    const question = deps.prompts[0] ?? '';
    expect(question).toContain('factory hook SessionStart');
    expect(question).toContain('factory hook UserPromptSubmit');
    expect(question).not.toContain('factory hook Stop');
    expect(question).not.toContain('factory hook PreCompact');
    expect(question).not.toContain('factory hook statusline');
    expect(groupsOf(stored(deps), 'Stop')).toEqual([stop]);
    expect(groupsOf(stored(deps), 'PreCompact')).toEqual(EXPECTED_ENTRIES.hooks.PreCompact);
  });
});

describe('hook settings: entries in place (TP-18)', () => {
  const inPlace = JSON.stringify({ model: 'opus', ...EXPECTED_ENTRIES });

  it.each([
    { name: 'on a terminal', setup: { tty: true } },
    { name: 'with no terminal', setup: {} },
    { name: 'with the yes flag inside a factory session', setup: { inSession: true }, yes: true },
  ])('asks nothing and writes nothing $name', async ({ setup, yes }) => {
    const log: string[] = [];
    const deps = makeDeps({ ...setup, log });
    deps.seed(FILE, inPlace);
    const before = snapshot(deps);
    expect(outcomeOf(await ensureHookSettings(logged(deps, log), request({ yes: yes === true })))).toEqual({
      kind: 'in-place',
      file: FILE,
    });
    expect(log).toEqual([]);
    expect(deps.prompts).toEqual([]);
    expect(deps.warned).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('keeps the bytes of a file that is in place, also when it has a different layout', async () => {
    const deps = makeDeps();
    const compact = JSON.stringify(EXPECTED_ENTRIES);
    deps.seed(FILE, compact);
    await ensureHookSettings(deps, request());
    expect(deps.files.get(FILE)).toBe(compact);
  });
});

describe('hook settings: consent without a terminal or with the yes flag (TP-19)', () => {
  it('with no terminal and no yes flag: exit 2, the change and the target in the message, nothing written', async () => {
    const log: string[] = [];
    const deps = makeDeps({ log });
    const error = errorOf(await ensureHookSettings(logged(deps, log), request()));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain(FILE);
    expect(error.message).toContain('factory hook Stop');
    expect(error.message).toContain('factory hook statusline');
    expect(error.hint).toContain('factory start');
    expect(error.hint).toContain('--yes');
    expect(log).toEqual([]);
    expect(deps.files.size).toBe(0);
  });

  it('names the command of the caller in the remedy', async () => {
    const error = errorOf(await ensureHookSettings(makeDeps(), request({ command: commands.init })));
    expect(error.hint).toContain('factory init');
  });

  it('with only the input on a terminal: it is no terminal, so exit 2', async () => {
    const deps = createFakeDeps({ stdinIsTTY: true, stdoutIsTTY: false, env: { HOME: USER_HOME } });
    deps.seedDir(FOLDER);
    expect(errorOf(await ensureHookSettings(deps, request())).kind).toBe('usage');
    expect(deps.prompts).toEqual([]);
  });

  it('with the yes flag outside a factory session: prints the change, then writes, and asks nothing', async () => {
    const log: string[] = [];
    const deps = makeDeps({ log });
    expect(outcomeOf(await ensureHookSettings(logged(deps, log), request({ yes: true }))).kind).toBe('written');
    expect(deps.prompts).toEqual([]);
    expect(log[0]).toBe('warn');
    expect(log.slice(1).every((line) => line.startsWith('write:'))).toBe(true);
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain(FILE);
    expect(deps.warned[0]).toContain('factory hook SessionStart');
    expect(stored(deps)).toEqual(EXPECTED_ENTRIES);
  });

  it('with the yes flag inside a factory session, for the coordinator: exit 2 and nothing written', async () => {
    const log: string[] = [];
    const deps = makeDeps({ inSession: true, log });
    const before = snapshot(deps);
    const error = errorOf(await ensureHookSettings(logged(deps, log), request({ yes: true })));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain(FILE);
    expect(log).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('with the yes flag inside a factory session, for the coordinator, on a terminal: exit 2, no question, nothing written', async () => {
    const deps = makeDeps({ inSession: true, tty: true, answer: 'y' });
    const error = errorOf(await ensureHookSettings(deps, request({ yes: true })));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain(FILE);
    expect(error.hint).toContain('outside the factory session');
    expect(error.hint).toContain('without --yes');
    expect(deps.prompts).toEqual([]);
    expect(deps.files.size).toBe(0);
  });

  it('with the yes flag inside a factory session, for a work copy with no file: writes with no question', async () => {
    const deps = makeDeps({ inSession: true });
    expect(outcomeOf(await ensureHookSettings(deps, request({ yes: true, session: 'work-copy' }))).kind).toBe('written');
    expect(deps.prompts).toEqual([]);
    expect(stored(deps)).toEqual(EXPECTED_ENTRIES);
  });

  it('with the yes flag inside a factory session, for a work copy that has a file: exit 2, also on a terminal', async () => {
    const deps = makeDeps({ inSession: true, tty: true, answer: 'y' });
    deps.seed(FILE, '{"model":"opus"}');
    const error = errorOf(await ensureHookSettings(deps, request({ yes: true, session: 'work-copy' })));
    expect(error.kind).toBe('usage');
    expect(deps.prompts).toEqual([]);
    expect(deps.files.get(FILE)).toBe('{"model":"opus"}');
  });

  it('with no yes flag inside a factory session, for a work copy with no file and no terminal: exit 2', async () => {
    const deps = makeDeps({ inSession: true });
    expect(errorOf(await ensureHookSettings(deps, request({ session: 'work-copy' }))).kind).toBe('usage');
    expect(deps.files.size).toBe(0);
  });

  it('with an empty session marker: it is outside a factory session, so the yes flag is a consent', async () => {
    const deps = createFakeDeps({ env: { HOME: USER_HOME, FACTORY_SESSION: '' } });
    deps.seedDir(FOLDER);
    expect(outcomeOf(await ensureHookSettings(deps, request({ yes: true }))).kind).toBe('written');
  });
});

describe('hook settings: the remedy of a stop without consent', () => {
  const OUTSIDE = 'Run "factory start" in a terminal window, or add --yes.';
  const INSIDE = 'Run "factory start" outside the factory session, or in a terminal window and answer the question.';
  const INSIDE_WITH_YES =
    '--yes gives no consent inside a factory session. Run "factory start" outside the factory session, or in a terminal window without --yes and answer the question.';

  /** A seeded session folder, with the file when `file` is set. */
  const place = (inSession: boolean, file: boolean): FakeDeps => {
    const deps = makeDeps({ inSession });
    if (file) deps.seed(FILE, '{"model":"opus"}');
    return deps;
  };

  const cases = [
    { name: 'outside a factory session, with no yes flag: --yes is a consent, so the remedy offers it', inSession: false, file: false, over: {}, hint: OUTSIDE },
    { name: 'inside a factory session, for the coordinator, with no yes flag: the remedy does not offer --yes', inSession: true, file: false, over: {}, hint: INSIDE },
    { name: 'inside a factory session, for the coordinator, with the yes flag: the remedy says that --yes gives no consent', inSession: true, file: false, over: { yes: true }, hint: INSIDE_WITH_YES },
    { name: 'inside a factory session, for a work copy with no file, with no yes flag: --yes is a consent, so the remedy offers it', inSession: true, file: false, over: { session: 'work-copy' as const }, hint: OUTSIDE },
    { name: 'inside a factory session, for a work copy that has a file, with no yes flag: the remedy does not offer --yes', inSession: true, file: true, over: { session: 'work-copy' as const }, hint: INSIDE },
    { name: 'inside a factory session, for a work copy that has a file, with the yes flag: the remedy says that --yes gives no consent', inSession: true, file: true, over: { session: 'work-copy' as const, yes: true }, hint: INSIDE_WITH_YES },
  ];

  it.each(cases)('ensureHookSettings $name', async ({ inSession, file, over, hint }) => {
    const error = errorOf(await ensureHookSettings(place(inSession, file), request(over)));
    expect(error.kind).toBe('usage');
    expect(error.hint).toBe(hint);
  });

  it.each(cases)('requireHookConsent $name', async ({ inSession, file, over, hint }) => {
    const error = errorOf(await requireHookConsent(place(inSession, file), consentRequest(over)));
    expect(error.kind).toBe('usage');
    expect(error.hint).toBe(hint);
  });

  it('names the command that asked', async () => {
    const error = errorOf(await requireHookConsent(place(true, false), consentRequest({ command: commands.init })));
    expect(error.hint).toBe(INSIDE.replace('factory start', 'factory init'));
  });
});

describe('hook settings: the dry run', () => {
  it('shows the change and the target, and asks and writes nothing, also with no terminal and no consent', async () => {
    const log: string[] = [];
    const deps = makeDeps({ log });
    const before = snapshot(deps);
    const outcome = outcomeOf(await ensureHookSettings(logged(deps, log), request({ dryRun: true })));
    if (outcome.kind !== 'would-write') throw new Error(`the kind is ${outcome.kind}`);
    expect(outcome.file).toBe(FILE);
    expect(outcome.change).toContain(FILE);
    for (const event of hookNames.events) expect(outcome.change).toContain(`factory hook ${event}`);
    expect(outcome.change).toContain('factory hook statusline');
    expect(log).toEqual([]);
    expect(deps.prompts).toEqual([]);
    expect(deps.warned).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('shows the same change as the question of a real run', async () => {
    const dry = outcomeOf(await ensureHookSettings(makeDeps(), request({ dryRun: true })));
    const deps = makeDeps({ tty: true, answer: 'n' });
    await ensureHookSettings(deps, request());
    expect(dry.kind === 'would-write' && deps.prompts[0]?.startsWith(dry.change)).toBe(true);
  });

  it('finds the entries in place and shows nothing', async () => {
    const deps = makeDeps();
    deps.seed(FILE, JSON.stringify(EXPECTED_ENTRIES));
    expect(outcomeOf(await ensureHookSettings(deps, request({ dryRun: true })))).toEqual({ kind: 'in-place', file: FILE });
  });

  it('stops on a link as a real run does, and on a file that is not a JSON object', async () => {
    const linked = createFakeDeps({ links: { [CLAUDE]: '/outside' }, env: { HOME: USER_HOME } });
    linked.seedDir(FOLDER);
    expect(errorOf(await ensureHookSettings(linked, request({ dryRun: true }))).kind).toBe('safety');
    const broken = makeDeps();
    broken.seed(FILE, '[]');
    expect(errorOf(await ensureHookSettings(broken, request({ dryRun: true }))).kind).toBe('failure');
  });
});

describe('hook settings: the check before the first write of a command (TP-16)', () => {
  const asked = (overrides: Partial<HookSettingsRequest> = {}): Omit<HookSettingsRequest, 'dryRun'> => {
    const { dryRun: _dryRun, ...rest } = request({ command: commands.init, ...overrides });
    return rest;
  };

  /** A session folder that does not exist yet: the command makes it after the check. */
  const newFolder = (overrides: FakeOptions = {}): FakeDeps =>
    createFakeDeps({ env: { HOME: USER_HOME }, ...overrides });

  it('with no terminal and no yes flag: exit 2 with the change, the target and the command, and nothing written', async () => {
    const deps = newFolder();
    const before = snapshot(deps);
    const error = errorOf(await requireHookConsent(deps, asked()));
    expect(error.kind).toBe('usage');
    expect(error.message).toContain(FILE);
    for (const event of hookNames.events) expect(error.message).toContain(`factory hook ${event}`);
    expect(error.message).toContain('factory hook statusline');
    expect(error.hint).toContain('factory init');
    expect(error.hint).toContain('--yes');
    expect(snapshot(deps)).toBe(before);
    expect(deps.prompts).toEqual([]);
  });

  it('shows the same change as the question of a real run', async () => {
    const real = makeDeps({ tty: true, answer: 'n' });
    await ensureHookSettings(real, request());
    const error = errorOf(await requireHookConsent(makeDeps(), asked()));
    expect(real.prompts[0]?.startsWith(error.message)).toBe(true);
  });

  it('with only the input on a terminal: it is no terminal, so exit 2', async () => {
    const deps = newFolder({ stdinIsTTY: true, stdoutIsTTY: false });
    expect(errorOf(await requireHookConsent(deps, asked())).kind).toBe('usage');
  });

  it('with the yes flag outside a factory session: goes on, and asks and writes nothing', async () => {
    const log: string[] = [];
    const deps = makeDeps({ log });
    expect(await requireHookConsent(logged(deps, log), asked({ yes: true }))).toEqual(ok(undefined));
    expect(log).toEqual([]);
    expect(deps.prompts).toEqual([]);
    expect(deps.files.size).toBe(0);
  });

  it('with the yes flag inside a factory session, for the coordinator, and no terminal: exit 2', async () => {
    const deps = newFolder({ env: { HOME: USER_HOME, FACTORY_SESSION: 'node-1' } });
    const error = errorOf(await requireHookConsent(deps, asked({ yes: true })));
    expect(error.kind).toBe('usage');
    expect(error.hint).toContain('--yes');
  });

  it('with the yes flag inside a factory session, for the coordinator, on a terminal: exit 2', async () => {
    const deps = newFolder({ env: { HOME: USER_HOME, FACTORY_SESSION: 'node-1' }, stdinIsTTY: true, stdoutIsTTY: true });
    const error = errorOf(await requireHookConsent(deps, asked({ yes: true })));
    expect(error.kind).toBe('usage');
    expect(error.hint).toContain('outside the factory session');
  });

  it('with the yes flag inside a factory session, and the entries in place: goes on', async () => {
    const deps = makeDeps({ inSession: true });
    deps.seed(FILE, JSON.stringify(EXPECTED_ENTRIES));
    expect(await requireHookConsent(deps, asked({ yes: true }))).toEqual(ok(undefined));
  });

  it('on a terminal: goes on without a question, because the question comes after the writes', async () => {
    const deps = newFolder({ stdinIsTTY: true, stdoutIsTTY: true, prompt: () => ok('n') });
    expect(await requireHookConsent(deps, asked())).toEqual(ok(undefined));
    expect(deps.prompts).toEqual([]);
  });

  it('with the entries in place: goes on with no terminal and no yes flag', async () => {
    const deps = makeDeps();
    deps.seed(FILE, JSON.stringify(EXPECTED_ENTRIES));
    expect(await requireHookConsent(deps, asked())).toEqual(ok(undefined));
  });

  it('with a file that lacks some entries: names only the missing entries in the stop', async () => {
    const deps = makeDeps();
    const { hooks, statusLine } = EXPECTED_ENTRIES;
    deps.seed(FILE, JSON.stringify({ hooks: { SessionStart: hooks.SessionStart }, statusLine }));
    const error = errorOf(await requireHookConsent(deps, asked()));
    expect(error.message).toContain('factory hook Stop');
    expect(error.message).not.toContain('factory hook SessionStart');
  });

  it('stops before the first write on a link, also on a terminal (exit 4)', async () => {
    const linked = createFakeDeps({ links: { [CLAUDE]: '/outside' }, env: { HOME: USER_HOME }, stdinIsTTY: true, stdoutIsTTY: true });
    linked.seedDir(FOLDER);
    expect(errorOf(await requireHookConsent(linked, asked())).kind).toBe('safety');
  });

  it('stops before the first write on a file that is not a JSON object, also with the yes flag (exit 1)', async () => {
    const deps = makeDeps();
    deps.seed(FILE, '[]');
    expect(errorOf(await requireHookConsent(deps, asked({ yes: true }))).kind).toBe('failure');
    expect(deps.files.get(FILE)).toBe('[]');
  });

  describe('for a folder that does not exist yet and gets a settings file from a checkout', () => {
    const inSession = (): FakeDeps => newFolder({ env: { HOME: USER_HOME, FACTORY_SESSION: 'node-1' } });
    const workCopy = (): Omit<HookSettingsRequest, 'dryRun'> => asked({ yes: true, session: hookSessions.workCopy });

    it('counts the yes flag inside a factory session when the checkout gives no file', async () => {
      expect(await requireHookConsent(inSession(), workCopy())).toEqual(ok(undefined));
      expect(await requireHookConsent(inSession(), workCopy(), null)).toEqual(ok(undefined));
    });

    it('refuses the yes flag inside a factory session when the checkout gives a file that needs the change (exit 2)', async () => {
      const error = errorOf(await requireHookConsent(inSession(), workCopy(), '{"permissions":{}}\n'));
      expect(error.kind).toBe('usage');
      expect(error.hint).toContain('gives no consent inside a factory session');
    });

    it('goes on when the file of the checkout holds the entries already', async () => {
      expect(await requireHookConsent(inSession(), workCopy(), JSON.stringify(EXPECTED_ENTRIES))).toEqual(ok(undefined));
    });

    it('stops with exit 1 when the file of the checkout is not a JSON object', async () => {
      expect(errorOf(await requireHookConsent(inSession(), workCopy(), '[]')).kind).toBe('failure');
    });
  });
});

describe('the notice for a no to the hook settings', () => {
  it('names the file, the effect, and the command that asked', () => {
    for (const command of [commands.start, commands.init]) {
      const text = declinedHookText(FILE, command);
      expect(text).toContain(FILE);
      expect(text).toContain('does not call the hook');
      expect(text).toContain(`run "factory ${command}" again and answer yes`);
    }
  });
});

describe('hook settings: the file that the writer makes is the own file', () => {
  it('passes the exact check for the own file, with the indented layout of the writer', async () => {
    const deps = makeDeps();
    await ensureHookSettings(deps, request({ yes: true }));
    const text = deps.files.get(FILE) ?? '';
    expect(text).toContain('\n  ');
    expect(isOwnSettingsText(text)).toBe(true);
  });

  it('does not pass it when another key stays in the file', async () => {
    const deps = makeDeps();
    deps.seed(FILE, '{"model":"opus"}');
    await ensureHookSettings(deps, request({ yes: true }));
    expect(isOwnSettingsText(deps.files.get(FILE) ?? '')).toBe(false);
  });
});

describe('hook settings: the target (TP-21)', () => {
  it.each([
    { name: 'the .claude folder is a link', links: { [CLAUDE]: '/outside' }, seed: (d: FakeDeps) => d.seed('/outside/settings.local.json', 'victim') },
    { name: 'the file is a link', links: { [FILE]: '/outside/file' }, seed: (d: FakeDeps) => { d.seedDir(CLAUDE); d.seed('/outside/file', 'victim'); } },
    { name: 'the session folder is a link', links: { [FOLDER]: '/outside' }, seed: (d: FakeDeps) => d.seedDir('/outside/.claude') },
  ])('refuses with exit 4 and writes nothing when $name', async ({ links, seed }) => {
    const log: string[] = [];
    const base = createFakeDeps({ links, stdinIsTTY: true, stdoutIsTTY: true, prompt: () => ok('y'), env: { HOME: USER_HOME } });
    base.seedDir(FOLDER);
    seed(base);
    const before = snapshot(base);
    const error = errorOf(await ensureHookSettings(logged(base, log), request({ yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('link');
    expect(log).toEqual([]);
    expect(base.prompts).toEqual([]);
    expect(snapshot(base)).toBe(before);
  });

  it('refuses with exit 4 when the real path of the file is outside the session folder', async () => {
    const deps = makeDeps({ tty: true });
    deps.seedDir(CLAUDE);
    const outside: Deps = {
      ...deps,
      fs: { ...deps.fs, realpath: async (path) => (path === CLAUDE ? ok('/outside/.claude') : deps.fs.realpath(path)) },
    };
    const before = snapshot(deps);
    const error = errorOf(await ensureHookSettings(outside, request({ yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('outside');
    expect(snapshot(deps)).toBe(before);
    expect(deps.prompts).toEqual([]);
  });

  it('fails with exit 1 when the session folder does not exist', async () => {
    const deps = createFakeDeps({ env: { HOME: USER_HOME } });
    const error = errorOf(await ensureHookSettings(deps, request({ yes: true })));
    expect(error.kind).toBe('failure');
    expect(deps.dirs.has(CLAUDE)).toBe(false);
  });

  it('fails with exit 1 when the .claude entry is a file, or the settings entry is a folder', async () => {
    const asFile = makeDeps();
    asFile.seed(CLAUDE, 'text');
    expect(errorOf(await ensureHookSettings(asFile, request({ yes: true }))).kind).toBe('failure');
    const asFolder = makeDeps();
    asFolder.seedDir(FILE);
    expect(errorOf(await ensureHookSettings(asFolder, request({ yes: true }))).kind).toBe('failure');
  });

  it.each([
    { name: 'the session folder is in the user Claude folder', folder: `${USER_HOME}/.claude/proj` },
    { name: 'the session folder is the user home, so the .claude folder is the user Claude folder', folder: USER_HOME },
    { name: 'the session folder is the user Claude folder', folder: `${USER_HOME}/.claude` },
  ])('refuses with exit 4 when $name', async ({ folder }) => {
    const deps = makeDeps({ tty: true });
    deps.seedDir(folder);
    const before = snapshot(deps);
    const error = errorOf(await ensureHookSettings(deps, request({ folder, yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('settings folder of Claude Code');
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('does not check the user Claude folder when the user home is not set', async () => {
    const deps = makeDeps({ home: null });
    expect(outcomeOf(await ensureHookSettings(deps, request({ yes: true }))).kind).toBe('written');
  });
});

describe('hook settings: no file system call on the user Claude folder (TP-20)', () => {
  interface Call {
    readonly method: string;
    readonly path: string;
  }

  const inUserFolder = (path: string): boolean => path === `${USER_HOME}/.claude` || path.startsWith(`${USER_HOME}/.claude/`);

  const folders = [
    { name: 'inside the user Claude folder', folder: `${USER_HOME}/.claude/proj` },
    { name: 'the user home, so the .claude folder is the user Claude folder', folder: USER_HOME },
    { name: 'the user Claude folder', folder: `${USER_HOME}/.claude` },
  ];

  it.each(folders)('refuses a session folder written as $name before any call on the file system', async ({ folder }) => {
    const deps = makeDeps({ tty: true });
    deps.seedDir(folder);
    const calls: Call[] = [];
    const watched = withFsWatch(deps, (method, path) => calls.push({ method, path }));
    const error = errorOf(await ensureHookSettings(watched, request({ folder, yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('settings folder of Claude Code');
    expect(calls).toEqual([]);
  });

  it.each(folders)('stops the check before the first write of a command at a session folder written as $name, before any call', async ({ folder }) => {
    const deps = makeDeps({ tty: true });
    deps.seedDir(folder);
    const calls: Call[] = [];
    const watched = withFsWatch(deps, (method, path) => calls.push({ method, path }));
    const error = errorOf(await requireHookConsent(watched, consentRequest({ folder, command: commands.init })));
    expect(error.kind).toBe('safety');
    expect(calls).toEqual([]);
  });

  it('stops the check of a session folder that does not exist yet, when it is written inside the user Claude folder', async () => {
    const deps = createFakeDeps({ env: { HOME: USER_HOME } });
    const calls: Call[] = [];
    const watched = withFsWatch(deps, (method, path) => calls.push({ method, path }));
    const error = errorOf(await requireHookConsent(watched, consentRequest({ folder: `${USER_HOME}/.claude/new`, command: commands.init })));
    expect(error.kind).toBe('safety');
    expect(calls).toEqual([]);
  });

  it('refuses a session folder that reaches the user Claude folder through a link, with no call on the user Claude folder and no write', async () => {
    const deps = createFakeDeps({
      links: { '/via': `${USER_HOME}/.claude` },
      env: { HOME: USER_HOME },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: () => ok('y'),
    });
    deps.seedDir('/via/proj');
    const calls: Call[] = [];
    const watched = withFsWatch(deps, (method, path) => calls.push({ method, path }));
    const error = errorOf(await ensureHookSettings(watched, request({ folder: '/via/proj', yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('settings folder of Claude Code');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ path }) => inUserFolder(path))).toEqual([]);
    expect(calls.filter(({ method }) => WRITE_CALLS.includes(method))).toEqual([]);
    expect(deps.prompts).toEqual([]);
  });

  it('makes no call on the user Claude folder when the session folder is outside it', async () => {
    const deps = makeDeps({ tty: true });
    const calls: Call[] = [];
    const watched = withFsWatch(deps, (method, path) => calls.push({ method, path }));
    expect(outcomeOf(await ensureHookSettings(watched, request({ yes: true }))).kind).toBe('written');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(({ path }) => inUserFolder(path))).toEqual([]);
  });
});

describe('hook settings: the file that is there (TP-22)', () => {
  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"text"'],
    ['a number', '42'],
    ['text that is not JSON', '{bad'],
    ['an empty file', ''],
  ])('stops with exit 1 for %s, keeps its bytes, and asks nothing', async (_name, text) => {
    const log: string[] = [];
    const deps = makeDeps({ tty: true, log });
    deps.seed(FILE, text);
    const before = snapshot(deps);
    const error = errorOf(await ensureHookSettings(logged(deps, log), request({ yes: true })));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(FILE);
    expect(error.hint).toContain('factory start');
    expect(deps.files.get(FILE)).toBe(text);
    expect(snapshot(deps)).toBe(before);
    expect(log).toEqual([]);
  });

  it('stops with exit 1 for a file over the byte cap, and keeps its bytes', async () => {
    const deps = makeDeps();
    const big = JSON.stringify({ note: 'x'.repeat(maxFileBytes) });
    deps.seed(FILE, big);
    expect(errorOf(await ensureHookSettings(deps, request({ yes: true }))).kind).toBe('failure');
    expect(deps.files.get(FILE)).toBe(big);
  });

  it.each([
    ['hooks is a list', { hooks: [] }],
    ['hooks is a string', { hooks: 'x' }],
    ['the groups of an event are not a list', { hooks: { Stop: 'x' } }],
  ])('stops with exit 1 when %s, and keeps its bytes', async (_name, content) => {
    const deps = makeDeps();
    const text = JSON.stringify(content);
    deps.seed(FILE, text);
    const error = errorOf(await ensureHookSettings(deps, request({ yes: true })));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('hooks');
    expect(deps.files.get(FILE)).toBe(text);
  });

  it('stops with exit 1 when the read of the file fails', async () => {
    const deps = makeDeps();
    deps.seed(FILE, '{}');
    const broken: Deps = { ...deps, fs: { ...deps.fs, readTextLimited: async () => failure('cannot read: EIO') } };
    expect(errorOf(await ensureHookSettings(broken, request({ yes: true }))).message).toContain('EIO');
  });

  it('leaves the old text when the write fails', async () => {
    const deps = makeDeps();
    deps.seed(FILE, '{"model":"opus"}');
    const broken: Deps = { ...deps, fs: { ...deps.fs, rename: async () => failure('disk full') } };
    expect(errorOf(await ensureHookSettings(broken, request({ yes: true }))).message).toContain('disk full');
    expect(deps.files.get(FILE)).toBe('{"model":"opus"}');
    expect([...deps.files.keys()]).toEqual([FILE]);
  });
});

describe('hook settings: the file changes while the question waits', () => {
  /** A person on a terminal window who answers yes after `during` has changed the file system. */
  const answeringAfter = (deps: FakeDeps, during: () => void): Deps => ({
    ...deps,
    prompt: async (question) => {
      during();
      return deps.prompt(question);
    },
  });

  const readsOfFile = (deps: Deps, reads: string[]): Deps => withFsWatch(deps, (method, path) => {
    if (method === 'readTextLimited' && path === FILE) reads.push(path);
  });

  const ONE_RULE = { permissions: { allow: ['Read'] } };
  const OWN_STOP = { hooks: { Stop: EXPECTED_ENTRIES.hooks.Stop } };

  it('reads the file again after the answer, and writes the change that the person saw when the text is the same', async () => {
    const reads: string[] = [];
    const deps = makeDeps({ tty: true });
    deps.seed(FILE, '{"model":"opus"}');
    expect(outcomeOf(await ensureHookSettings(readsOfFile(deps, reads), request())).kind).toBe('written');
    expect(reads).toHaveLength(2);
    expect(stored(deps)).toEqual({ model: 'opus', ...EXPECTED_ENTRIES });
  });

  it('writes the change on the new text when the file changed in a way that leaves the shown lines the same, and keeps the new keys', async () => {
    const reads: string[] = [];
    const deps = makeDeps({ tty: true });
    deps.seed(FILE, '{"model":"opus"}');
    const asking = answeringAfter(deps, () => deps.seed(FILE, JSON.stringify({ model: 'opus', ...ONE_RULE })));
    expect(outcomeOf(await ensureHookSettings(readsOfFile(asking, reads), request())).kind).toBe('written');
    expect(stored(deps)).toEqual({ model: 'opus', ...ONE_RULE, ...EXPECTED_ENTRIES });
    expect(reads).toHaveLength(2);
  });

  it('writes the change on the new text when the file did not exist at the question and another program made it', async () => {
    const deps = makeDeps({ tty: true });
    const asking = answeringAfter(deps, () => deps.seed(FILE, JSON.stringify(ONE_RULE)));
    expect(outcomeOf(await ensureHookSettings(asking, request())).kind).toBe('written');
    expect(stored(deps)).toEqual({ ...ONE_RULE, ...EXPECTED_ENTRIES });
  });

  it.each([
    { name: 'the file now holds one of the own entries', content: { model: 'opus', ...OWN_STOP } },
    { name: 'the file now holds a status line that the person did not see', content: { model: 'opus', statusLine: { type: 'command', command: 'my-line' } } },
    { name: 'the file now holds all the own entries', content: { model: 'opus', ...EXPECTED_ENTRIES } },
  ])('writes nothing and stops with exit 1 when $name', async ({ content }) => {
    const log: string[] = [];
    const reads: string[] = [];
    const deps = makeDeps({ tty: true, log });
    deps.seed(FILE, '{"model":"opus"}');
    const changed = JSON.stringify(content);
    const asking = answeringAfter(deps, () => deps.seed(FILE, changed));
    const error = errorOf(await ensureHookSettings(logged(readsOfFile(asking, reads), log), request()));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain(FILE);
    expect(error.message).toContain('changed while the question waited');
    expect(error.hint).toContain('factory start');
    expect(deps.files.get(FILE)).toBe(changed);
    expect(log.filter((line) => line.startsWith('write:'))).toEqual([]);
    expect(reads).toHaveLength(2);
  });

  it('writes nothing and passes the failure on when the file now is not a JSON object', async () => {
    const log: string[] = [];
    const deps = makeDeps({ tty: true, log });
    deps.seed(FILE, '{"model":"opus"}');
    const asking = answeringAfter(deps, () => deps.seed(FILE, '[]'));
    const error = errorOf(await ensureHookSettings(logged(asking, log), request()));
    expect(error.kind).toBe('failure');
    expect(error.message).toContain('not a JSON object');
    expect(deps.files.get(FILE)).toBe('[]');
    expect(log.filter((line) => line.startsWith('write:'))).toEqual([]);
  });

  it('writes nothing and stops with exit 4 when a link takes the place of the file during the question', async () => {
    const links: Record<string, string> = {};
    const deps = createFakeDeps({
      links,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: () => {
        links[FILE] = '/outside/file';
        return ok('y');
      },
      env: { HOME: USER_HOME },
    });
    deps.seedDir(FOLDER);
    deps.seed(FILE, '{"model":"opus"}');
    const error = errorOf(await ensureHookSettings(deps, request()));
    expect(error.kind).toBe('safety');
    expect(deps.files.get(FILE)).toBe('{"model":"opus"}');
    expect(deps.atomicWrites).toEqual([]);
  });
});

describe('hook settings: with the real file system', () => {
  let base = '';
  let counter = 0;

  interface Place {
    readonly session: string;
    readonly home: string;
    readonly userClaude: string;
    readonly deps: Deps;
  }

  /** A session folder and a test user home with a Claude folder, in a new folder. The environment names the test home only. */
  const fresh = async (): Promise<Place> => {
    const dir = join(base, `case-${(counter += 1)}`);
    const session = join(dir, 'session');
    const home = join(dir, 'home');
    const userClaude = join(home, '.claude');
    await mkdir(session, { recursive: true });
    await mkdir(userClaude, { recursive: true });
    await writeFile(join(userClaude, 'settings.json'), '{"user":true}', 'utf8');
    return { session, home, userClaude, deps: { ...createNodeDeps(), env: { HOME: home }, warn: () => undefined } };
  };

  const userFolderState = async (userClaude: string): Promise<string[]> =>
    Promise.all((await readdir(userClaude)).map(async (name) => `${name}=${await readFile(join(userClaude, name), 'utf8')}`));

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'factory-claude-settings-')));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('writes a new file with the own entries and the private mode, and leaves no temporary file', async () => {
    const { session, deps } = await fresh();
    expect(outcomeOf(await ensureHookSettings(deps, request({ folder: session, yes: true }))).kind).toBe('written');
    const folder = join(session, '.claude');
    expect(await readdir(folder)).toEqual(['settings.local.json']);
    expect(JSON.parse(await readFile(join(folder, 'settings.local.json'), 'utf8'))).toEqual(EXPECTED_ENTRIES);
    expect((await lstat(join(folder, 'settings.local.json'))).mode & 0o777).toBe(0o600);
  });

  it('keeps the mode of a file that exists, and its other keys', async () => {
    const { session, deps } = await fresh();
    const folder = join(session, '.claude');
    await mkdir(folder);
    const file = join(folder, 'settings.local.json');
    await writeFile(file, '{"model":"opus"}', 'utf8');
    await chmod(file, 0o640);
    expect(outcomeOf(await ensureHookSettings(deps, request({ folder: session, yes: true }))).kind).toBe('written');
    expect((await lstat(file)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'opus', ...EXPECTED_ENTRIES });
  });

  it('writes once, and a second call finds the entries in place (TP-18)', async () => {
    const { session, deps } = await fresh();
    await ensureHookSettings(deps, request({ folder: session, yes: true }));
    const file = join(session, '.claude', 'settings.local.json');
    const first = await readFile(file, 'utf8');
    const mtime = (await lstat(file)).mtimeMs;
    expect(outcomeOf(await ensureHookSettings(deps, request({ folder: session, yes: true }))).kind).toBe('in-place');
    expect(await readFile(file, 'utf8')).toBe(first);
    expect((await lstat(file)).mtimeMs).toBe(mtime);
  });

  it('refuses a .claude folder that is a link to the Claude folder of the test home, and leaves that folder as it was (TP-20)', async () => {
    const { session, userClaude, deps } = await fresh();
    await symlink(userClaude, join(session, '.claude'));
    const before = await userFolderState(userClaude);
    const error = errorOf(await ensureHookSettings(deps, request({ folder: session, yes: true })));
    expect(error.kind).toBe('safety');
    expect(await userFolderState(userClaude)).toEqual(before);
    expect((await lstat(join(session, '.claude'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a session folder that is inside the Claude folder of the test home', async () => {
    const { userClaude, deps } = await fresh();
    const session = join(userClaude, 'proj');
    await mkdir(session);
    const error = errorOf(await ensureHookSettings(deps, request({ folder: session, yes: true })));
    expect(error.kind).toBe('safety');
    expect(await readdir(session)).toEqual([]);
  });

  it('refuses a session folder that reaches the Claude folder of the test home through a link above it', async () => {
    const { home, userClaude, deps } = await fresh();
    const real = join(userClaude, 'proj');
    await mkdir(real);
    const via = join(home, '..', 'via');
    await symlink(home, via);
    const error = errorOf(await ensureHookSettings(deps, request({ folder: join(via, '.claude', 'proj'), yes: true })));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('settings folder of Claude Code');
    expect(await readdir(real)).toEqual([]);
  });

  it('refuses a file that is a link, and keeps the target of the link (TP-21)', async () => {
    const { session, home, deps } = await fresh();
    const folder = join(session, '.claude');
    await mkdir(folder);
    const victim = join(home, 'victim.json');
    await writeFile(victim, '{"victim":true}', 'utf8');
    await symlink(victim, join(folder, 'settings.local.json'));
    const error = errorOf(await ensureHookSettings(deps, request({ folder: session, yes: true })));
    expect(error.kind).toBe('safety');
    expect(await readFile(victim, 'utf8')).toBe('{"victim":true}');
    expect((await lstat(join(folder, 'settings.local.json'))).isSymbolicLink()).toBe(true);
  });

  it('keeps the bytes of a file that is not a JSON object (TP-22)', async () => {
    const { session, deps } = await fresh();
    const folder = join(session, '.claude');
    await mkdir(folder);
    const file = join(folder, 'settings.local.json');
    await writeFile(file, '[1, 2]\n', 'utf8');
    expect(errorOf(await ensureHookSettings(deps, request({ folder: session, yes: true }))).kind).toBe('failure');
    expect(await readFile(file, 'utf8')).toBe('[1, 2]\n');
    expect(await readdir(folder)).toEqual(['settings.local.json']);
  });
});
