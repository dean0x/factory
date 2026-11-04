import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { Deps } from '../../src/core/deps.js';
import { hookNames, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { runHook } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const HOME = '/h/factory';
const NODE_ID = sampleConfig().core.node.id;
const SESSION = '00000000-0000-4000-8000-000000000001';
const FOLDER = layoutOf(HOME).heartbeatDir;
const FILE = `${FOLDER}/${SESSION}`;
const NOW = '2030-01-02T03:04:05.678Z';

/** The environment that Claude Code gives a hook of a session that factory started. The names are written out: they are the contract. */
const IN_FACTORY = { XDG_STATE_HOME: '/state', FACTORY_HOME: HOME, FACTORY_SESSION: NODE_ID };

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'claude', 'payloads.json'), 'utf8')) as {
  readonly hooks: Readonly<Record<HookEvent, Readonly<Record<string, unknown>>>>;
};

interface MakeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly os?: string;
  readonly links?: Readonly<Record<string, string>>;
  /** Default: the folder is in the factory list, so the registration check passes. */
  readonly registered?: boolean;
}

/** A registered factory folder on a fake file system, with the environment of a hook of its coordinator. */
const make = (options: MakeOptions = {}): FakeDeps => {
  const deps = createFakeDeps({
    cwd: '/w',
    env: { ...IN_FACTORY, ...options.env },
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.os === undefined ? {} : { os: options.os }),
    ...(options.links === undefined ? {} : { links: options.links }),
  });
  seedConfig(deps, HOME);
  if (options.registered !== false) registerRoot(deps, HOME, NODE_ID);
  return deps;
};

/** The input of a hook: the captured payload of the event, with some fields changed. */
const payload = (event: HookEvent, fields: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({ ...FIXTURE.hooks[event], ...fields });

const snapshot = (deps: FakeDeps): string => JSON.stringify([...deps.files.entries()].sort()) + [...deps.dirs].sort().join(',');

const lineOf = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(FILE) ?? 'null');

const errorOf = (result: CliResult<void>): string => {
  if (result.ok) throw new Error('the hook should have refused');
  return result.error.message;
};

const runLine = async (argv: readonly string[], deps: Deps) => {
  const sink = captureSink();
  const code = await runCli(argv, deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('factory hook: the last-seen line of each captured payload (TP-5)', () => {
  it.each(hookNames.events)('writes one last-seen line for %s', async (event) => {
    const deps = make({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    expect(await runHook(deps, [event])).toEqual({ ok: true, value: undefined });
    expect(lineOf(deps)).toEqual({
      schema: schemaIds.lastSeen,
      session_id: SESSION,
      event,
      event_at: NOW,
      context_pct: null,
      pct_at: null,
    });
    expect([...deps.files.keys()].filter((path) => path.startsWith(`${FOLDER}/`))).toEqual([FILE]);
  });

  it('keeps the stored percent and its time', async () => {
    const deps = make({ stdin: payload('Stop') });
    const stored = { schema: schemaIds.lastSeen, session_id: SESSION, event: null, event_at: null, context_pct: 42, pct_at: '2030-01-02T03:00:00.000Z' };
    deps.seed(FILE, `${JSON.stringify(stored)}\n`);
    expect((await runHook(deps, ['Stop'])).ok).toBe(true);
    expect(lineOf(deps)).toEqual({ ...stored, event: 'Stop', event_at: NOW });
  });

  it('reads the input with the byte cap of the hook', async () => {
    const deps = make({ stdin: payload('Stop') });
    const caps: number[] = [];
    const spy: Deps = {
      ...deps,
      readStdin: (maxBytes) => {
        caps.push(maxBytes);
        return deps.readStdin(maxBytes);
      },
    };
    await runHook(spy, ['Stop']);
    expect(caps).toEqual([hookNames.maxStdinBytes]);
  });

  it('writes the line of a SessionStart after a compact, with its extra fields', async () => {
    const deps = make({ stdin: payload('SessionStart', { source: 'compact', prompt_id: 'x', model: 'm' }) });
    expect((await runHook(deps, ['SessionStart'])).ok).toBe(true);
    expect(lineOf(deps)).toMatchObject({ session_id: SESSION, event: 'SessionStart' });
  });
});

describe('factory hook: refusals of the input (TP-8)', () => {
  it.each([
    ['a session id that is not a UUID', payload('Stop', { session_id: 'not-a-uuid' })],
    ['a session id with upper case letters', payload('Stop', { session_id: SESSION.replace('4000', '4ABC').toUpperCase() })],
    ['a session id that climbs out of the folder', payload('Stop', { session_id: '../../../escape' })],
    ['a session id that is not text', payload('Stop', { session_id: 7 })],
    ['a missing session id', JSON.stringify({ hook_event_name: 'Stop' })],
    ['a missing event name', JSON.stringify({ session_id: SESSION })],
    ['an event name that differs from the argument', payload('Stop', { hook_event_name: 'SessionStart' })],
    ['an event name off the list', payload('Stop', { hook_event_name: 'Notification' })],
    ['an input that is not JSON', 'this is not json'],
    ['an input that is a list', '[]'],
    ['an input that is null', 'null'],
    ['an empty input', ''],
  ])('writes nothing for %s', async (_name, stdin) => {
    const deps = make({ stdin });
    const before = snapshot(deps);
    expect(errorOf(await runHook(deps, ['Stop'])).length).toBeGreaterThan(0);
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['an event that is not on the list', ['Notification']],
    ['an event with other letter case', ['stop']],
    ['the status line word, which is not an event', [hookNames.statusline]],
    ['no event', []],
    ['an extra word after the event', ['Stop', 'extra']],
  ])('writes nothing for %s', async (_name, args) => {
    const deps = make({ stdin: payload('Stop') });
    const before = snapshot(deps);
    expect(errorOf(await runHook(deps, args)).length).toBeGreaterThan(0);
    expect(snapshot(deps)).toBe(before);
  });

  it('writes nothing for an input over the byte cap', async () => {
    const deps = make({ stdin: payload('UserPromptSubmit', { prompt: 'x'.repeat(hookNames.maxStdinBytes) }) });
    const before = snapshot(deps);
    expect(errorOf(await runHook(deps, ['UserPromptSubmit']))).toContain('larger than');
    expect(snapshot(deps)).toBe(before);
  });

  it('does not repeat the rejected input in the reason', async () => {
    const deps = make({ stdin: payload('Stop', { session_id: 'leaky-value-123' }) });
    expect(errorOf(await runHook(deps, ['Stop']))).not.toContain('leaky-value-123');
  });
});

describe('factory hook: the factory folder and the session (TP-9)', () => {
  const refuses = async (deps: FakeDeps): Promise<string> => {
    const before = snapshot(deps);
    const message = errorOf(await runHook(deps, ['Stop']));
    expect(snapshot(deps)).toBe(before);
    return message;
  };

  it('writes nothing for a FACTORY_SESSION that is not the id of the node', async () => {
    expect(await refuses(make({ stdin: payload('Stop'), env: { FACTORY_SESSION: 'someone-else' } }))).toContain('FACTORY_SESSION');
  });

  it('writes nothing when FACTORY_SESSION is not set', async () => {
    await refuses(make({ stdin: payload('Stop'), env: { FACTORY_SESSION: undefined } }));
  });

  it('writes nothing when FACTORY_SESSION is empty', async () => {
    await refuses(make({ stdin: payload('Stop'), env: { FACTORY_SESSION: '' } }));
  });

  it('writes nothing for a factory folder that the factory list does not hold', async () => {
    await refuses(make({ stdin: payload('Stop'), registered: false }));
  });

  it('writes nothing for a factory folder whose marker is missing', async () => {
    const deps = make({ stdin: payload('Stop') });
    deps.files.delete(`${HOME}/.factory/node.json`);
    await refuses(deps);
  });

  it('writes nothing for a factory folder with an id that the factory list does not give', async () => {
    const deps = make({ stdin: payload('Stop'), registered: false });
    registerRoot(deps, HOME, 'another-id');
    await refuses(deps);
  });

  it('writes nothing when FACTORY_HOME is not a folder', async () => {
    await refuses(make({ stdin: payload('Stop'), env: { FACTORY_HOME: '/h/missing' } }));
  });

  it('writes nothing for a folder that holds no config', async () => {
    const deps = make({ stdin: payload('Stop'), env: { FACTORY_HOME: '/h/empty' } });
    deps.seedDir('/h/empty');
    await refuses(deps);
  });

  it('writes nothing for a config that does not parse', async () => {
    const deps = make({ stdin: payload('Stop') });
    deps.seed(`${HOME}/factory.yaml`, 'core: [not closed');
    await refuses(deps);
  });

  it('writes nothing for a heartbeat folder that is a link, and the target stays as it is', async () => {
    const deps = make({ stdin: payload('Stop'), links: { [FOLDER]: '/elsewhere' } });
    deps.seedDir('/elsewhere');
    deps.seedDir(FOLDER);
    await refuses(deps);
    expect([...deps.files.keys()].filter((path) => path.startsWith('/elsewhere'))).toEqual([]);
  });

  it('goes on to write the line for the id of the node', async () => {
    const deps = make({ stdin: payload('Stop') });
    expect((await runHook(deps, ['Stop'])).ok).toBe(true);
    expect(lineOf(deps)).toMatchObject({ event: 'Stop' });
  });
});

describe('factory hook: outside a factory session', () => {
  it.each([[undefined], ['']])('does nothing and touches nothing for FACTORY_HOME %j', async (value) => {
    const deps = make({ stdin: payload('Stop'), env: { FACTORY_HOME: value } });
    const before = snapshot(deps);
    const touched: string[] = [];
    let reads = 0;
    const spy: Deps = {
      ...withFsWatch(deps, (method, path) => touched.push(`${method} ${path}`)),
      readStdin: (maxBytes) => {
        reads += 1;
        return deps.readStdin(maxBytes);
      },
    };
    expect(await runHook(spy, ['Stop'])).toEqual({ ok: true, value: undefined });
    expect(touched).toEqual([]);
    expect(reads).toBe(0);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('factory hook: the transcript is never opened (TP-10)', () => {
  const transcript = String(FIXTURE.hooks.Stop['transcript_path']);

  it.each(hookNames.events)('records no call on the transcript path of %s, and the line holds no path', async (event) => {
    const deps = make({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    deps.seed(transcript, 'the words of a private conversation');
    const seen: string[] = [];
    const watched = withFsWatch(deps, (method, path) => seen.push(`${method} ${path}`));
    expect((await runHook(watched, [event])).ok).toBe(true);
    expect(seen.filter((call) => call.includes('transcripts'))).toEqual([]);
    expect(deps.files.get(transcript)).toBe('the words of a private conversation');
    const text = deps.files.get(FILE) ?? '';
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('placeholder');
  });

  it('holds no other field of the input in the line, such as the working folder or the prompt', async () => {
    const deps = make({ stdin: payload('UserPromptSubmit') });
    await runHook(deps, ['UserPromptSubmit']);
    expect(Object.keys(lineOf(deps) as Record<string, unknown>).sort()).toEqual(
      ['context_pct', 'event', 'event_at', 'pct_at', 'schema', 'session_id'],
    );
  });
});

describe('factory hook through runCli: exit 0 and an empty stdout on every path (TP-12)', () => {
  const stopInput = payload('Stop');
  const brokenConfig = (): FakeDeps => {
    const deps = make({ stdin: stopInput });
    deps.seed(`${HOME}/factory.yaml`, 'core: [not closed');
    return deps;
  };

  it.each([
    ['a bad payload', ['hook', 'Stop'], () => make({ stdin: 'oops' })],
    ['an unknown event', ['hook', 'Notification'], () => make({ stdin: stopInput })],
    ['a broken config', ['hook', 'Stop'], brokenConfig],
    ['no FACTORY_HOME', ['hook', 'Stop'], () => make({ stdin: stopInput, env: { FACTORY_HOME: undefined } })],
    ['no event', ['hook'], () => make({ stdin: stopInput })],
    ['an unknown flag', ['hook', '--bogus', 'Stop'], () => make({ stdin: stopInput })],
    ['the help flag', ['hook', '--help'], () => make({ stdin: stopInput })],
    ['the json flag', ['hook', 'Stop', '--json'], () => make({ stdin: stopInput })],
    ['a session that is not the node', ['hook', 'Stop'], () => make({ stdin: stopInput, env: { FACTORY_SESSION: 'other' } })],
    ['a heartbeat folder that is a link', ['hook', 'Stop'], () => make({ stdin: stopInput, links: { [FOLDER]: '/elsewhere' } })],
    ['a factory folder that is not registered', ['hook', 'Stop'], () => make({ stdin: stopInput, registered: false })],
  ])('exits 0 and prints nothing to stdout for %s', async (_name, argv, build) => {
    const result = await runLine(argv, build());
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
  });

  it('exits 0 on Windows too, before the check of the platform', async () => {
    const result = await runLine(['hook', 'Stop'], make({ stdin: stopInput, os: 'win32', env: { FACTORY_HOME: undefined } }));
    expect(result).toEqual({ code: 0, out: '', err: '' });
  });

  it('prints nothing at all when it writes the line', async () => {
    const deps = make({ stdin: stopInput });
    expect(await runLine(['hook', 'Stop'], deps)).toEqual({ code: 0, out: '', err: '' });
    expect(lineOf(deps)).toMatchObject({ event: 'Stop', session_id: SESSION });
  });

  it('prints nothing at all outside a factory session', async () => {
    const deps = make({ stdin: stopInput, env: { FACTORY_HOME: undefined } });
    expect(await runLine(['hook', 'Stop'], deps)).toEqual({ code: 0, out: '', err: '' });
  });

  it('prints one line on stderr when it writes nothing, and names the reason', async () => {
    const result = await runLine(['hook', 'Stop'], make({ stdin: 'oops' }));
    expect(result.err).toMatch(/^factory hook: [^\n]+\n$/);
    expect(result.err).toContain('not valid JSON');
  });

  it('prints one line on stderr for a security stop of the write, and writes nothing', async () => {
    const deps = make({ stdin: stopInput, links: { [FOLDER]: '/elsewhere' } });
    deps.seedDir(FOLDER);
    const before = snapshot(deps);
    const result = await runLine(['hook', 'Stop'], deps);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^factory hook: [^\n]+\n$/);
    expect(result.err).toContain('is a link');
    expect(snapshot(deps)).toBe(before);
  });

  it('catches a throw inside the hook: one stderr line, empty stdout, exit 0', async () => {
    const deps = make({ stdin: stopInput });
    const failing: Deps = {
      ...deps,
      readStdin: async () => {
        throw new Error('boom');
      },
    };
    const result = await runLine(['hook', 'Stop'], failing);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^factory hook: internal error: boom\n$/);
  });

  it('shows no control character of a failure on stderr', async () => {
    const deps = make({ stdin: stopInput });
    const failing: Deps = {
      ...deps,
      readStdin: async () => {
        throw new Error('bad\u001b[31m text');
      },
    };
    expect((await runLine(['hook', 'Stop'], failing)).err).not.toContain('\u001b');
  });
});

describe('factory hook in the help', () => {
  it('is in the list of commands, and says that Claude Code runs it', async () => {
    const result = await runLine(['help'], make());
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^ {2}hook {6}.*Claude Code/m);
  });

  it('shows its usage with the events of the list', async () => {
    const result = await runLine(['help', 'hook'], make());
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Usage: factory hook ${hookNames.events.join('|')}`);
  });
});
