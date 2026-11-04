import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { hookNames, schemaIds, statuslineTextOf } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, exited, registerRoot, withFsWatch, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const HOME = '/h/factory';
const NODE_ID = sampleConfig().core.node.id;
const SESSION = '00000000-0000-4000-8000-000000000001';
const FOLDER = layoutOf(HOME).heartbeatDir;
const FILE = `${FOLDER}/${SESSION}`;
const NOW = '2030-01-02T03:04:05.678Z';
/** The command of the owner. The fake runs no shell, so the text only has to be the one that the config holds. */
const OWNER_COMMAND = 'owner-status --short';
/** The output of the command of the owner: colors, spaces and a final new line, which must reach the screen as they are. */
const OWNER_OUTPUT = 'owner \u001b[32mgreen\u001b[0m  line\n';
const ONE_STDERR_LINE = /^factory hook: [^\n]+\n$/;

/** The environment that Claude Code gives the status line of a session that factory started. The names are written out: they are the contract. */
const IN_FACTORY = { XDG_STATE_HOME: '/state', FACTORY_HOME: HOME, FACTORY_SESSION: NODE_ID };

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
  readonly statusline: { readonly payload: Readonly<Record<string, unknown>> };
};
const PAYLOAD = FIXTURE.statusline.payload;
const WINDOW = PAYLOAD['context_window'] as Readonly<Record<string, unknown>>;

/** The status line input: the built payload, with some fields changed. A field set to undefined is left out of the text. */
const input = (fields: Readonly<Record<string, unknown>> = {}): string => JSON.stringify({ ...PAYLOAD, ...fields });

/** The status line input with another context window. */
const withWindow = (window: unknown): string => input({ context_window: window });

interface MakeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly statusline?: string | null;
  readonly run?: RunHandler;
  readonly os?: string;
  readonly links?: Readonly<Record<string, string>>;
  readonly stdinIsTTY?: boolean;
  /** Default: the folder is in the factory list, so the registration check passes. */
  readonly registered?: boolean;
}

const configWith = (statusline: string | null): FactoryConfig => {
  const base = sampleConfig();
  return { ...base, core: { ...base.core, session: { ...base.core.session, statusline } } };
};

/** A registered factory folder on a fake file system, with the environment of the status line of its coordinator. */
const make = (options: MakeOptions = {}): FakeDeps => {
  const deps = createFakeDeps({
    cwd: '/w',
    env: { ...IN_FACTORY, ...options.env },
    stdin: options.stdin ?? input(),
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.os === undefined ? {} : { os: options.os }),
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.stdinIsTTY === undefined ? {} : { stdinIsTTY: options.stdinIsTTY }),
  });
  seedConfig(deps, HOME, configWith(options.statusline ?? null));
  if (options.registered !== false) registerRoot(deps, HOME, NODE_ID);
  return deps;
};

const runLine = async (argv: readonly string[], deps: Deps) => {
  const sink = captureSink();
  const code = await runCli(argv, deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

const statusline = (deps: Deps) => runLine(['hook', hookNames.statusline], deps);

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

const lineOf = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(FILE) ?? 'null');

const heartbeatFiles = (deps: FakeDeps): string[] => [...deps.files.keys()].filter((path) => path.startsWith(`${FOLDER}/`));

describe('factory hook statusline: the command of the owner (TP-13)', () => {
  it('prints exactly the output of the command of the owner, and writes the last-seen line (TP-13)', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    expect(await statusline(deps)).toEqual({ code: 0, out: OWNER_OUTPUT, err: '' });
    expect(lineOf(deps)).toEqual({
      schema: schemaIds.lastSeen,
      session_id: SESSION,
      event: null,
      event_at: null,
      context_pct: 8,
      pct_at: NOW,
    });
    expect(heartbeatFiles(deps)).toEqual([FILE]);
  });

  it('prints the output without a new line when the command prints none, and an empty output as it is', async () => {
    expect((await statusline(make({ statusline: OWNER_COMMAND, run: () => exited(0, 'no new line') }))).out).toBe('no new line');
    expect((await statusline(make({ statusline: OWNER_COMMAND, run: () => exited(0, '') }))).out).toBe('');
  });

  it('runs the command with /bin/sh -c, the same input text, the time limit of the wrapper, the environment of the process and its own process group', async () => {
    const stdin = ` ${input()}\n\n`;
    const deps = make({ statusline: OWNER_COMMAND, stdin, run: () => exited(0, OWNER_OUTPUT) });
    await statusline(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).toMatchObject({
      command: '/bin/sh',
      args: ['-c', OWNER_COMMAND],
      input: stdin,
      timeoutMs: hookNames.statuslineTimeoutMs,
      inheritEnv: true,
      processGroup: true,
    });
  });

  it('reads the input with the byte cap of the hook (TP-8)', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    const caps: number[] = [];
    const spy: Deps = {
      ...deps,
      readStdin: (maxBytes) => {
        caps.push(maxBytes);
        return deps.readStdin(maxBytes);
      },
    };
    await statusline(spy);
    expect(caps).toEqual([hookNames.maxStdinBytes]);
  });

  it('keeps the stored event and its time when it writes the percent', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    const stored = { schema: schemaIds.lastSeen, session_id: SESSION, event: 'Stop', event_at: '2030-01-02T03:00:00.000Z', context_pct: 3, pct_at: '2030-01-02T03:00:00.000Z' };
    deps.seed(FILE, `${JSON.stringify(stored)}\n`);
    await statusline(deps);
    expect(lineOf(deps)).toEqual({ ...stored, context_pct: 8, pct_at: NOW });
  });

  it('still prints the output of the command when the input gives no percent, and writes nothing', async () => {
    const deps = make({ statusline: OWNER_COMMAND, stdin: withWindow(null), run: () => exited(0, OWNER_OUTPUT) });
    expect(await statusline(deps)).toEqual({ code: 0, out: OWNER_OUTPUT, err: '' });
    expect(heartbeatFiles(deps)).toEqual([]);
  });

  it('gives the command an input that is not JSON as it is, prints its output and says why it recorded nothing', async () => {
    const deps = make({ statusline: OWNER_COMMAND, stdin: 'this is not json', run: () => exited(0, OWNER_OUTPUT) });
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(OWNER_OUTPUT);
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('not valid JSON');
    expect(deps.calls[0]?.input).toBe('this is not json');
    expect(heartbeatFiles(deps)).toEqual([]);
  });
});

describe('factory hook statusline: the fallback line (TP-14)', () => {
  const failing: ReadonlyArray<readonly [string, MakeOptions]> = [
    ['no command of the owner in the config', { statusline: null }],
    ['a command of the owner that exits with a code other than 0', { statusline: OWNER_COMMAND, run: () => exited(3, 'half an output', 'bad') }],
    ['a command of the owner that does not end in time', { statusline: OWNER_COMMAND, run: () => failure('cannot run /bin/sh: SIGTERM') }],
    ['a shell that cannot start', { statusline: OWNER_COMMAND, run: () => failure('cannot run /bin/sh: ENOENT') }],
  ];

  it.each(failing)('prints context N%% and exits 0 for %s (TP-14)', async (_name, options) => {
    const deps = make(options);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
  });

  it('prints nothing else on stdout, and runs no command when the config names none', async () => {
    const deps = make({ statusline: null });
    expect(await statusline(deps)).toEqual({ code: 0, out: 'context 8%', err: '' });
    expect(deps.calls).toEqual([]);
  });

  it.each(failing.slice(1))('still writes the last-seen line for %s', async (_name, options) => {
    const deps = make(options);
    await statusline(deps);
    expect(lineOf(deps)).toMatchObject({ context_pct: 8, pct_at: NOW });
  });

  it('says why the command of the owner failed in one line on stderr, and drops its output', async () => {
    const exit = await statusline(make({ statusline: OWNER_COMMAND, run: () => exited(3, 'half an output', 'bad') }));
    expect(exit.err).toMatch(ONE_STDERR_LINE);
    expect(exit.err).toContain('code 3');
    expect(exit.err).not.toContain('half an output');
    const late = await statusline(make({ statusline: OWNER_COMMAND, run: () => failure('cannot run /bin/sh: SIGTERM') }));
    expect(late.err).toMatch(ONE_STDERR_LINE);
    expect(late.err).toContain('SIGTERM');
  });

  it('does not repeat the command of the owner on stderr', async () => {
    const result = await statusline(make({ statusline: OWNER_COMMAND, run: () => exited(1) }));
    expect(result.err).not.toContain(OWNER_COMMAND);
  });
});

describe('factory hook statusline: the context percent', () => {
  const usage = WINDOW['current_usage'] as Readonly<Record<string, unknown>>;

  it('takes used_percentage when it is a number', async () => {
    const deps = make({ stdin: withWindow({ ...WINDOW, used_percentage: 12, current_usage: usage }) });
    expect((await statusline(deps)).out).toBe('context 12%');
    expect(lineOf(deps)).toMatchObject({ context_pct: 12 });
  });

  it('counts 0 as a percent', async () => {
    const deps = make({ stdin: withWindow({ ...WINDOW, used_percentage: 0 }) });
    expect((await statusline(deps)).out).toBe('context 0%');
    expect(lineOf(deps)).toMatchObject({ context_pct: 0, pct_at: NOW });
  });

  it.each([
    [42.4, 42],
    [42.5, 43],
    [7.75, 8],
    [99.6, 100],
    [100, 100],
  ])('rounds %s to the whole percent %s', async (given, shown) => {
    const deps = make({ stdin: withWindow({ ...WINDOW, used_percentage: given }) });
    expect((await statusline(deps)).out).toBe(`context ${shown}%`);
    expect(lineOf(deps)).toMatchObject({ context_pct: shown });
  });

  it.each([
    ['null', null],
    ['absent', undefined],
    ['text', 'high'],
    ['a list', [8]],
  ])('falls back to the sum of the usage when used_percentage is %s', async (_name, value) => {
    // 8500 + 5000 + 2000 tokens of a 200000 window are 7.75 percent.
    const deps = make({ stdin: withWindow({ ...WINDOW, used_percentage: value }) });
    expect((await statusline(deps)).out).toBe('context 8%');
    expect(lineOf(deps)).toMatchObject({ context_pct: 8, pct_at: NOW });
  });

  it('adds the three kinds of input tokens, and divides by the size of the window', async () => {
    const window = {
      context_window_size: 1000,
      used_percentage: null,
      current_usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 999 },
    };
    expect((await statusline(make({ stdin: withWindow(window) }))).out).toBe('context 60%');
  });

  it.each<readonly [string, unknown]>([
    ['no context_window', undefined],
    ['a context_window that is null', null],
    ['a context_window that is a list', []],
    ['a context_window that is text', 'full'],
    ['an empty context_window', {}],
    ['a null used_percentage and a null current_usage', { context_window_size: 200000, used_percentage: null, current_usage: null }],
    ['a null used_percentage and no current_usage', { context_window_size: 200000, used_percentage: null }],
    ['a used_percentage that is text and no usage', { context_window_size: 200000, used_percentage: '12' }],
    ['a null used_percentage and a size of 0', { ...WINDOW, used_percentage: null, context_window_size: 0 }],
    ['a null used_percentage and a negative size', { ...WINDOW, used_percentage: null, context_window_size: -5 }],
    ['a null used_percentage and a size that is text', { ...WINDOW, used_percentage: null, context_window_size: '200000' }],
    ['a null used_percentage and no size', { current_usage: usage, used_percentage: null }],
    ['a usage with a missing field', { ...WINDOW, used_percentage: null, current_usage: { input_tokens: 1, cache_creation_input_tokens: 2 } }],
    ['a usage with a null field', { ...WINDOW, used_percentage: null, current_usage: { ...usage, cache_read_input_tokens: null } }],
    ['a usage with a field that is text', { ...WINDOW, used_percentage: null, current_usage: { ...usage, input_tokens: 'many' } }],
    ['a usage that is a number', { ...WINDOW, used_percentage: null, current_usage: 15500 }],
  ])('gives no percent, no write and no error for %s', async (_name, window) => {
    const deps = make({ stdin: withWindow(window) });
    const before = snapshot(deps);
    expect(await statusline(deps)).toEqual({ code: 0, out: statuslineTextOf(null), err: '' });
    expect(snapshot(deps)).toBe(before);
  });

  it('prints context ?% for an input with no percent, when the owner names no command', async () => {
    expect(statuslineTextOf(null)).toBe('context ?%');
    expect((await statusline(make({ stdin: withWindow(null) }))).out).toBe('context ?%');
  });

  it('clears no stored percent when the input gives none', async () => {
    const deps = make({ stdin: withWindow(null) });
    const stored = { schema: schemaIds.lastSeen, session_id: SESSION, event: 'Stop', event_at: '2030-01-02T03:00:00.000Z', context_pct: 42, pct_at: '2030-01-02T03:00:00.000Z' };
    deps.seed(FILE, `${JSON.stringify(stored)}\n`);
    await statusline(deps);
    expect(lineOf(deps)).toEqual(stored);
  });

  it.each([[101], [100.6], [-1], [1e9]])('writes nothing for the percent %s, which is outside 0-100, and prints one line on stderr (TP-8)', async (given) => {
    const deps = make({ stdin: withWindow({ ...WINDOW, used_percentage: given }) });
    const before = snapshot(deps);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(statuslineTextOf(null));
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('0-100');
    expect(snapshot(deps)).toBe(before);
  });

  it('writes nothing for a sum that is above 100 percent', async () => {
    const window = { context_window_size: 100, used_percentage: null, current_usage: { input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
    const deps = make({ stdin: withWindow(window) });
    const result = await statusline(deps);
    expect(result.out).toBe(statuslineTextOf(null));
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(heartbeatFiles(deps)).toEqual([]);
  });
});

describe('factory hook statusline: the guards of the write', () => {
  it('writes nothing for a FACTORY_SESSION that is not the id of the node, and still prints a line (one stderr line)', async () => {
    const deps = make({ statusline: OWNER_COMMAND, env: { FACTORY_SESSION: 'someone-else' }, run: () => exited(0, OWNER_OUTPUT) });
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('FACTORY_SESSION');
    expect(heartbeatFiles(deps)).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['FACTORY_SESSION is not set', { FACTORY_SESSION: undefined }],
    ['FACTORY_SESSION is empty', { FACTORY_SESSION: '' }],
    ['FACTORY_HOME is not a folder', { FACTORY_HOME: '/h/missing' }],
  ])('writes nothing when %s, and still prints a line', async (_name, env) => {
    const deps = make({ env });
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(heartbeatFiles(deps)).toEqual([]);
  });

  it('writes nothing for a factory folder that the factory list does not hold, and runs no command', async () => {
    const deps = make({ statusline: OWNER_COMMAND, registered: false, run: () => exited(0, OWNER_OUTPUT) });
    const result = await statusline(deps);
    expect(result.out).toBe('context 8%');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(heartbeatFiles(deps)).toEqual([]);
    expect(deps.calls).toEqual([]);
  });

  it('writes nothing for a config that does not parse', async () => {
    const deps = make({ statusline: OWNER_COMMAND });
    deps.seed(`${HOME}/factory.yaml`, 'core: [not closed');
    const result = await statusline(deps);
    expect(result.out).toBe('context 8%');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(heartbeatFiles(deps)).toEqual([]);
  });

  it.each([
    ['not a UUID', 'not-a-uuid'],
    ['a path that climbs out of the folder', '../../../escape'],
    ['not text', 7],
    ['absent', undefined],
  ])('writes nothing for a session id that is %s, and still prints the line of the owner', async (_name, sessionId) => {
    const deps = make({ statusline: OWNER_COMMAND, stdin: input({ session_id: sessionId }), run: () => exited(0, OWNER_OUTPUT) });
    const before = snapshot(deps);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(OWNER_OUTPUT);
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(snapshot(deps)).toBe(before);
  });

  it('does not repeat the rejected session id in the reason', async () => {
    const result = await statusline(make({ stdin: input({ session_id: 'leaky-value-123' }) }));
    expect(result.err).not.toContain('leaky-value-123');
  });

  it('writes nothing for a heartbeat folder that is a link, prints the line of the owner and exits 0', async () => {
    const deps = make({ statusline: OWNER_COMMAND, links: { [FOLDER]: '/elsewhere' }, run: () => exited(0, OWNER_OUTPUT) });
    deps.seedDir('/elsewhere');
    deps.seedDir(FOLDER);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(OWNER_OUTPUT);
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('is a link');
    expect([...deps.files.keys()].filter((path) => path.startsWith('/elsewhere'))).toEqual([]);
  });

  it('keeps the output and the exit code when the write fails, and says so in one line', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    const failingWrite: Deps = {
      ...deps,
      fs: { ...deps.fs, writeTextExclusive: async (path) => failure(`cannot write ${path}: disk full`) },
    };
    const result = await statusline(failingWrite);
    expect(result.code).toBe(0);
    expect(result.out).toBe(OWNER_OUTPUT);
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('disk full');
  });

  it('keeps the fallback line and the exit code when the write fails', async () => {
    const deps = make();
    const failingWrite: Deps = {
      ...deps,
      fs: { ...deps.fs, writeTextExclusive: async (path) => failure(`cannot write ${path}: disk full`) },
    };
    const result = await statusline(failingWrite);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
  });

  it('prints the fallback line and the reason when the local config can not be read, and still writes the percent', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    deps.seed(`${HOME}/factory.local.yaml`, 'session: [not closed');
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(deps.calls).toEqual([]);
    expect(lineOf(deps)).toMatchObject({ context_pct: 8 });
  });
});

describe('factory hook statusline: outside a factory session', () => {
  it.each([[undefined], ['']])('prints the fallback line, touches no file and runs no command for FACTORY_HOME %j', async (value) => {
    const deps = make({ statusline: OWNER_COMMAND, env: { FACTORY_HOME: value }, run: () => exited(0, OWNER_OUTPUT) });
    const before = snapshot(deps);
    const touched: string[] = [];
    const result = await statusline(withFsWatch(deps, (method, path) => touched.push(`${method} ${path}`)));
    expect(result).toEqual({ code: 0, out: 'context 8%', err: '' });
    expect(touched).toEqual([]);
    expect(deps.calls).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('factory hook statusline: the input', () => {
  it('never opens the transcript path, and the line holds no field of the input but the percent', async () => {
    const transcript = String(PAYLOAD['transcript_path']);
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    deps.seed(transcript, 'the words of a private conversation');
    const seen: string[] = [];
    const result = await statusline(withFsWatch(deps, (method, path) => seen.push(`${method} ${path}`)));
    expect(result.code).toBe(0);
    expect(seen.filter((call) => call.includes('transcripts'))).toEqual([]);
    expect(deps.files.get(transcript)).toBe('the words of a private conversation');
    const text = deps.files.get(FILE) ?? '';
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('placeholder');
    expect(Object.keys(lineOf(deps) as Record<string, unknown>).sort()).toEqual(['context_pct', 'event', 'event_at', 'pct_at', 'schema', 'session_id']);
  });

  it.each([
    ['an input that is not JSON', 'oops'],
    ['an input that is a list', '[]'],
    ['an input that is null', 'null'],
    ['an empty input', ''],
  ])('prints the fallback line and one line on stderr for %s, and writes nothing', async (_name, stdin) => {
    const deps = make({ stdin });
    const before = snapshot(deps);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(statuslineTextOf(null));
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(snapshot(deps)).toBe(before);
  });

  it('gives no read of a terminal: an input from a terminal is empty text, and the wrapper ends at once', async () => {
    const deps = make({ stdinIsTTY: true, statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(OWNER_OUTPUT);
  });

  it('prints the fallback line, runs no command and writes nothing for an input over the byte cap (TP-8)', async () => {
    const deps = make({ statusline: OWNER_COMMAND, stdin: input({ filler: 'x'.repeat(hookNames.maxStdinBytes) }), run: () => exited(0, OWNER_OUTPUT) });
    const before = snapshot(deps);
    const result = await statusline(deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe(statuslineTextOf(null));
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(result.err).toContain('larger than');
    expect(deps.calls).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('factory hook statusline: the stop signals', () => {
  /** The number of handlers on each stop signal. */
  const handlersOf = (deps: FakeDeps): number[] => hookNames.stopSignals.map((name) => deps.signals.listenerCount(name));
  const NONE = hookNames.stopSignals.map(() => 0);
  const ONE_EACH = hookNames.stopSignals.map(() => 1);

  it('stops on the signals SIGTERM, SIGHUP and SIGINT', () => {
    expect([...hookNames.stopSignals]).toEqual(['SIGTERM', 'SIGHUP', 'SIGINT']);
  });

  it('has a handler for each stop signal while the command of the owner runs, and none before or after', async () => {
    let during: number[] = [];
    const deps = make({
      statusline: OWNER_COMMAND,
      run: () => {
        during = handlersOf(deps);
        return exited(0, OWNER_OUTPUT);
      },
    });
    expect(handlersOf(deps)).toEqual(NONE);
    expect(await statusline(deps)).toEqual({ code: 0, out: OWNER_OUTPUT, err: '' });
    expect(during).toEqual(ONE_EACH);
    expect(handlersOf(deps)).toEqual(NONE);
  });

  it('removes the handlers when the command does not end in time', async () => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => failure('cannot run /bin/sh: SIGKILL') });
    expect((await statusline(deps)).out).toBe('context 8%');
    expect(handlersOf(deps)).toEqual(NONE);
  });

  it('removes the handlers when the route throws', async () => {
    const deps = make();
    const throwing: Deps = {
      ...deps,
      readStdin: async () => {
        throw new Error('boom');
      },
    };
    expect((await statusline(throwing)).err).toMatch(/internal error: boom/);
    expect(handlersOf(deps)).toEqual(NONE);
  });

  it.each(hookNames.stopSignals)('aborts the signal of the command of the owner on %s, and still exits 0', async (name) => {
    let aborted: boolean | undefined;
    const deps = make({
      statusline: OWNER_COMMAND,
      run: (call) => {
        expect(call.signal?.aborted).toBe(false);
        deps.signals.emit(name);
        aborted = call.signal?.aborted;
        return failure('cannot run /bin/sh: SIGKILL');
      },
    });
    const result = await statusline(deps);
    expect(aborted).toBe(true);
    expect(result.code).toBe(0);
    expect(result.out).toBe('context 8%');
    expect(handlersOf(deps)).toEqual(NONE);
  });

  it('installs no handler for an event of the hook', async () => {
    const deps = make();
    let during: number[] = [];
    const spy: Deps = {
      ...deps,
      readStdin: (maxBytes) => {
        during = handlersOf(deps);
        return deps.readStdin(maxBytes);
      },
    };
    await runLine(['hook', hookNames.events[0]], spy);
    expect(during).toEqual(NONE);
  });
});

describe('factory hook statusline through runCli', () => {
  it('runs before the check of the platform, so it prints on Windows too', async () => {
    const result = await statusline(make({ os: 'win32' }));
    expect(result).toEqual({ code: 0, out: 'context 8%', err: '' });
  });

  it.each([
    ['an extra word', ['hook', 'statusline', 'extra']],
    ['a flag', ['hook', 'statusline', '--json']],
    ['a flag before the word', ['hook', '--json', 'statusline']],
    ['the word with other letter case', ['hook', 'StatusLine']],
  ])('prints nothing to stdout, one line on stderr and exits 0 for %s', async (_name, argv) => {
    const deps = make({ statusline: OWNER_COMMAND, run: () => exited(0, OWNER_OUTPUT) });
    const before = snapshot(deps);
    const result = await runLine(argv, deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toMatch(ONE_STDERR_LINE);
    expect(deps.calls).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('catches a throw: one line on stderr, an empty stdout and exit 0', async () => {
    const deps = make();
    const throwing: Deps = {
      ...deps,
      readStdin: async () => {
        throw new Error('boom');
      },
    };
    const result = await statusline(throwing);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^factory hook: internal error: boom\n$/);
  });

  it('does not take the status line word as an event of the hook', () => {
    expect(hookNames.events).not.toContain(hookNames.statusline);
  });

  it('names the status line in the usage of the hook', async () => {
    const result = await runLine(['help', 'hook'], make());
    expect(result.out).toContain(`Usage: factory hook ${hookNames.events.join('|')}|${hookNames.statusline}`);
  });
});
