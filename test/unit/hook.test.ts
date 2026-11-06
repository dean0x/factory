import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { Deps } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { hookNames, schemaIds, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import {
  promptStateOf,
  readOwnCoordinatorSession,
  readWorkerLastSeen,
  writeLastSeen,
  type LastSeen,
} from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
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
      session_marker: NODE_ID,
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

describe('factory hook: the dialog states of the Notification and PreToolUse events (TP-4)', () => {
  const stateOfLine = (deps: FakeDeps): unknown => {
    const line = lineOf(deps) as LastSeen | null;
    return line === null ? null : promptStateOf(line);
  };

  it.each(hookNames.notificationTypes)('TP-4: writes the state waits for the Notification type %s', async (type) => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: type }) });
    expect(await runHook(deps, ['Notification'])).toEqual({ ok: true, value: undefined });
    expect(lineOf(deps)).toMatchObject({ event: 'Notification', session_id: SESSION });
    expect(stateOfLine(deps)).toBe('waits');
  });

  it('TP-4: writes the state busy for PreToolUse', async () => {
    const deps = make({ stdin: payload('PreToolUse') });
    expect(await runHook(deps, ['PreToolUse'])).toEqual({ ok: true, value: undefined });
    expect(stateOfLine(deps)).toBe('busy');
  });

  it.each([
    ['the type idle_prompt', { [hookNames.inputKeys.notificationType]: 'idle_prompt' }],
    ['a type that is not on the list', { [hookNames.inputKeys.notificationType]: 'auth_success' }],
    ['an empty type', { [hookNames.inputKeys.notificationType]: '' }],
    ['a type with other letter case', { [hookNames.inputKeys.notificationType]: 'Permission_Prompt' }],
    ['a type that holds a listed type as a part', { [hookNames.inputKeys.notificationType]: 'permission_prompt_x' }],
  ])('TP-4: writes no line for a Notification with %s, and reports no fault', async (_name, fields) => {
    const deps = make({ stdin: payload('Notification', fields) });
    const before = snapshot(deps);
    expect(await runHook(deps, ['Notification'])).toEqual({ ok: true, value: undefined });
    expect(snapshot(deps)).toBe(before);
  });

  it('TP-4: writes no line for a Notification with no type', async () => {
    const { [hookNames.inputKeys.notificationType]: _type, ...withoutType } = FIXTURE.hooks.Notification;
    const deps = make({ stdin: JSON.stringify(withoutType) });
    const before = snapshot(deps);
    expect(await runHook(deps, ['Notification'])).toEqual({ ok: true, value: undefined });
    expect(snapshot(deps)).toBe(before);
  });

  it('TP-4: keeps the line of an earlier event when an idle_prompt notice arrives', async () => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: 'idle_prompt' }) });
    const stored = { schema: schemaIds.lastSeen, session_id: SESSION, event: 'Stop', event_at: NOW, context_pct: null, pct_at: null, session_marker: NODE_ID };
    deps.seed(FILE, `${JSON.stringify(stored)}\n`);
    expect((await runHook(deps, ['Notification'])).ok).toBe(true);
    expect(lineOf(deps)).toEqual(stored);
  });

  it('TP-4: refuses a type that is not text, and writes nothing', async () => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: 7 }) });
    const before = snapshot(deps);
    expect(errorOf(await runHook(deps, ['Notification'])).length).toBeGreaterThan(0);
    expect(snapshot(deps)).toBe(before);
  });

  it.each(hookNames.events)('TP-4: exits 0 with an empty stdout and empty stderr for %s with a listed input', async (event) => {
    const deps = make({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    expect(await runLine(['hook', event], deps)).toEqual({ code: 0, out: '', err: '' });
  });

  it.each([
    ['idle_prompt', 'idle_prompt'],
    ['a missing type', undefined],
  ])('TP-4: exits 0 with an empty stdout and empty stderr for a Notification with %s', async (_name, type) => {
    const fields = type === undefined ? {} : { [hookNames.inputKeys.notificationType]: type };
    const { [hookNames.inputKeys.notificationType]: _type, ...withoutType } = FIXTURE.hooks.Notification;
    const deps = make({ stdin: JSON.stringify({ ...withoutType, ...fields }) });
    const before = snapshot(deps);
    expect(await runLine(['hook', 'Notification'], deps)).toEqual({ code: 0, out: '', err: '' });
    expect(snapshot(deps)).toBe(before);
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
    ['an event name off the list', payload('Stop', { hook_event_name: 'SubagentStop' })],
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
    ['an event that is not on the list', ['SubagentStop']],
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

describe('factory hook: the id of a worker in the registry as the session (TP-125)', () => {
  const WORKER_ID = 'fix-login';
  const paths = workerPathsOf(HOME, WORKER_ID);
  const OTHER = '/elsewhere/worker-record';

  /** A node with the record of a worker in its registry, and the environment of a hook of that worker. */
  const makeWorker = async (options: MakeOptions = {}): Promise<FakeDeps> => {
    const deps = make({ stdin: payload('Stop'), ...options, env: { FACTORY_SESSION: WORKER_ID, ...options.env } });
    const written = await writeWorkerRecord(deps, HOME, {
      id: WORKER_ID,
      project: 'web',
      workCopy: '/h/factory/work-copies/web/fix-login',
      branch: 'worker/fix-login',
    });
    expect(written.ok).toBe(true);
    return deps;
  };

  const refuses = async (deps: FakeDeps): Promise<string> => {
    const before = snapshot(deps);
    const message = errorOf(await runHook(deps, ['Stop']));
    expect(snapshot(deps)).toBe(before);
    return message;
  };

  it('writes the last-seen line of the session for the id of a worker that has a record', async () => {
    const deps = await makeWorker();
    expect(await runHook(deps, ['Stop'])).toEqual({ ok: true, value: undefined });
    expect(lineOf(deps)).toEqual({
      schema: schemaIds.lastSeen,
      session_id: SESSION,
      event: 'Stop',
      event_at: NOW,
      context_pct: null,
      pct_at: null,
      session_marker: WORKER_ID,
    });
    expect([...deps.files.keys()].filter((path) => path.startsWith(`${FOLDER}/`))).toEqual([FILE]);
  });

  it.each(hookNames.events)('writes the line for %s from a worker', async (event) => {
    const deps = await makeWorker({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    expect((await runHook(deps, [event])).ok).toBe(true);
    expect(lineOf(deps)).toMatchObject({ session_id: SESSION, event });
  });

  it('writes nothing for an id that has no record, and names the variable', async () => {
    const deps = make({ stdin: payload('Stop'), env: { FACTORY_SESSION: WORKER_ID } });
    expect(await refuses(deps)).toContain('FACTORY_SESSION');
  });

  it('writes nothing for an id that differs from the ids of the records', async () => {
    const deps = await makeWorker({ env: { FACTORY_SESSION: 'someone-else' } });
    expect(await refuses(deps)).toContain('FACTORY_SESSION');
  });

  it.each([
    ['an id that is not a slug', 'Fix_Login'],
    ['an id that climbs out of the folder', '../../escape'],
    ['an id with a path separator', 'a/b'],
    ['an empty id', ''],
  ])('writes nothing for %s, and touches no path of the registry', async (_name, id) => {
    const deps = await makeWorker({ env: { FACTORY_SESSION: id } });
    const before = snapshot(deps);
    const touched: string[] = [];
    const watched = withFsWatch(deps, (method, path) => touched.push(`${method} ${path}`));
    expect(errorOf(await runHook(watched, ['Stop'])).length).toBeGreaterThan(0);
    expect(touched.filter((call) => call.includes(layoutOf(HOME).workersDir))).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['a record that is not JSON', 'not json'],
    ['a record with a field too many', JSON.stringify({ extra: 1 })],
    ['an empty record', ''],
  ])('writes nothing for %s', async (_name, content) => {
    const deps = await makeWorker();
    deps.files.set(paths.recordFile, content);
    await refuses(deps);
  });

  it.each([
    ['the home folder of the user', { work_copy: '/Users/someone' }],
    ['the factory folder', { work_copy: HOME }],
    ['a work copy of another project', { work_copy: '/h/factory/work-copies/api/fix-login' }],
    ['a work copy with a dot-dot part', { work_copy: '/h/factory/work-copies/web/../web/fix-login' }],
    ['the branch of another worker', { branch: 'worker/other' }],
  ])('writes nothing for a record whose work copy or branch is not its own: %s', async (_name, fields) => {
    const deps = await makeWorker();
    const record = JSON.parse(deps.files.get(paths.recordFile) ?? 'null') as Record<string, unknown>;
    deps.files.set(paths.recordFile, JSON.stringify({ ...record, ...fields }));
    expect(await refuses(deps)).toContain('FACTORY_SESSION');
  });

  it('writes nothing when the record names another id than its folder', async () => {
    const deps = await makeWorker();
    const record = JSON.parse(deps.files.get(paths.recordFile) ?? 'null') as Record<string, unknown>;
    deps.files.set(paths.recordFile, JSON.stringify({ ...record, id: 'other-worker' }));
    await refuses(deps);
  });

  it('writes nothing for a record that is a link, and the target stays as it is', async () => {
    const links: Record<string, string> = {};
    const deps = await makeWorker({ links });
    deps.seed(OTHER, deps.files.get(paths.recordFile) ?? '');
    links[paths.recordFile] = OTHER;
    const target = deps.files.get(OTHER);
    await refuses(deps);
    expect(deps.files.get(OTHER)).toBe(target);
  });

  it('writes nothing for a worker folder that is a link', async () => {
    const links: Record<string, string> = {};
    const deps = await makeWorker({ links });
    links[paths.dir] = '/elsewhere/worker-dir';
    await refuses(deps);
  });

  it('writes nothing for a workers folder that is a link', async () => {
    const links: Record<string, string> = {};
    const deps = await makeWorker({ links });
    links[layoutOf(HOME).workersDir] = '/elsewhere/workers';
    await refuses(deps);
  });

  it('writes nothing for a worker of a factory folder that the factory list does not hold', async () => {
    await refuses(await makeWorker({ registered: false }));
  });

  it('writes nothing for a worker record in a folder that holds no config', async () => {
    const deps = await makeWorker({ env: { FACTORY_HOME: '/h/empty' } });
    deps.seedDir('/h/empty');
    await refuses(deps);
  });

  it('does not read the registry for the id of the node', async () => {
    const deps = await makeWorker({ env: { FACTORY_SESSION: NODE_ID } });
    const touched: string[] = [];
    const watched = withFsWatch(deps, (method, path) => touched.push(`${method} ${path}`));
    expect((await runHook(watched, ['Stop'])).ok).toBe(true);
    expect(touched.filter((call) => call.includes(layoutOf(HOME).workersDir))).toEqual([]);
    expect(lineOf(deps)).toMatchObject({ event: 'Stop' });
  });

  it('exits 0 with an empty stdout and writes the line, through runCli', async () => {
    const deps = await makeWorker();
    expect(await runLine(['hook', 'Stop'], deps)).toEqual({ code: 0, out: '', err: '' });
    expect(lineOf(deps)).toMatchObject({ event: 'Stop', session_id: SESSION });
  });

  describe('the session pointer of the worker', () => {
    const NEXT_SESSION = '00000000-0000-4000-8000-000000000002';

    it('records the session of the event in the folder of the worker, so a reader finds the line from the worker id', async () => {
      const deps = await makeWorker();
      expect((await runHook(deps, ['Stop'])).ok).toBe(true);
      expect(deps.files.get(paths.lastSessionFile)).toBe(`${SESSION}\n`);
      const read = await readWorkerLastSeen(deps, HOME, WORKER_ID);
      expect(read).toMatchObject({ ok: true, value: { state: 'valid', line: { session_id: SESSION, event: 'Stop' } } });
    });

    it.each(hookNames.events)('records the pointer for %s', async (event) => {
      const deps = await makeWorker({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
      expect((await runHook(deps, [event])).ok).toBe(true);
      expect(deps.files.get(paths.lastSessionFile)).toBe(`${SESSION}\n`);
    });

    it('moves the pointer to the new session when the worker gets a new session id', async () => {
      const deps = await makeWorker();
      await runHook(deps, ['Stop']);
      const restarted: FakeDeps = { ...deps, readStdin: async () => ok(payload('SessionStart', { session_id: NEXT_SESSION })) };
      expect((await runHook(restarted, ['SessionStart'])).ok).toBe(true);
      expect(deps.files.get(paths.lastSessionFile)).toBe(`${NEXT_SESSION}\n`);
      expect(await readWorkerLastSeen(deps, HOME, WORKER_ID)).toMatchObject({
        ok: true,
        value: { state: 'valid', line: { session_id: NEXT_SESSION, event: 'SessionStart' } },
      });
    });

    it('writes no worker pointer for the session of the node', async () => {
      const deps = await makeWorker({ env: { FACTORY_SESSION: NODE_ID } });
      expect((await runHook(deps, ['Stop'])).ok).toBe(true);
      expect(deps.files.has(paths.lastSessionFile)).toBe(false);
      expect([...deps.files.keys()].filter((path) => path.startsWith(layoutOf(HOME).workersDir))).toEqual([paths.recordFile]);
    });

    it('writes no pointer when the line is not written', async () => {
      const deps = await makeWorker();
      deps.seedDir(FILE);
      expect(errorOf(await runHook(deps, ['Stop']))).toContain('not a file');
      expect(deps.files.has(paths.lastSessionFile)).toBe(false);
    });

    it.each([
      ['the node', NODE_ID],
      ['another worker', 'fix-search'],
    ])('does not rewrite the line of a session of %s, and writes no pointer for it', async (_name, other) => {
      const deps = await makeWorker();
      await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event: 'SessionStart' }, other);
      const before = deps.files.get(FILE);
      expect(errorOf(await runHook(deps, ['Stop']))).toContain(other);
      expect(deps.files.get(FILE)).toBe(before);
      expect(deps.files.has(paths.lastSessionFile)).toBe(false);
    });

    it('keeps the line and names the pointer when the pointer is a link', async () => {
      const links: Record<string, string> = {};
      const deps = await makeWorker({ links });
      links[paths.lastSessionFile] = OTHER;
      deps.seed(OTHER, 'victim');
      expect(errorOf(await runHook(deps, ['Stop']))).toContain('last-session');
      expect(lineOf(deps)).toMatchObject({ event: 'Stop' });
      expect(deps.files.get(OTHER)).toBe('victim');
    });

    it('exits 0 and records the pointer through runCli', async () => {
      const deps = await makeWorker();
      expect(await runLine(['hook', 'Stop'], deps)).toEqual({ code: 0, out: '', err: '' });
      expect(deps.files.get(paths.lastSessionFile)).toBe(`${SESSION}\n`);
    });
  });

  describe('the session pointer of the coordinator (TP-133)', () => {
    const NEXT_SESSION = '00000000-0000-4000-8000-000000000002';
    const POINTER = layoutOf(HOME).coordinatorLastSessionFile;
    const asNode = (options: MakeOptions = {}): Promise<FakeDeps> =>
      makeWorker({ ...options, env: { FACTORY_SESSION: NODE_ID, ...options.env } });
    const ownRead = async (deps: Deps) => {
      const read = await readOwnCoordinatorSession(deps, HOME, NODE_ID);
      if (!read.ok) throw new Error(read.error.message);
      return read.value;
    };

    it('records the session of the event with the marker of the node, so a reader finds the owned id', async () => {
      const deps = await asNode();
      expect((await runHook(deps, ['Stop'])).ok).toBe(true);
      expect(deps.files.get(POINTER)).toBe(`${SESSION}\n`);
      expect(lineOf(deps)).toMatchObject({ session_id: SESSION, session_marker: NODE_ID });
      expect(await ownRead(deps)).toMatchObject({ state: 'valid', sessionId: SESSION });
    });

    it.each(hookNames.events)('records the pointer for %s', async (event) => {
      const deps = await asNode({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
      expect((await runHook(deps, [event])).ok).toBe(true);
      expect(deps.files.get(POINTER)).toBe(`${SESSION}\n`);
    });

    it('moves the pointer to the new session when the coordinator gets a new session id', async () => {
      const deps = await asNode();
      await runHook(deps, ['Stop']);
      const restarted: FakeDeps = { ...deps, readStdin: async () => ok(payload('SessionStart', { session_id: NEXT_SESSION })) };
      expect((await runHook(restarted, ['SessionStart'])).ok).toBe(true);
      expect(deps.files.get(POINTER)).toBe(`${NEXT_SESSION}\n`);
      expect(await ownRead(deps)).toMatchObject({ state: 'valid', sessionId: NEXT_SESSION });
    });

    it('writes no coordinator pointer for the session of a worker', async () => {
      const deps = await makeWorker();
      expect((await runHook(deps, ['Stop'])).ok).toBe(true);
      expect(deps.files.has(paths.lastSessionFile)).toBe(true);
      expect(deps.files.has(POINTER)).toBe(false);
    });

    it('writes no pointer when the line is not written', async () => {
      const deps = await asNode();
      deps.seedDir(FILE);
      expect(errorOf(await runHook(deps, ['Stop']))).toContain('not a file');
      expect(deps.files.has(POINTER)).toBe(false);
    });

    it.each([
      ['a worker', WORKER_ID],
      ['another node', 'other-node'],
    ])('does not rewrite the line of a session of %s, and writes no pointer for it', async (_name, other) => {
      const deps = await asNode();
      await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event: 'SessionStart' }, other);
      const before = deps.files.get(FILE);
      expect(errorOf(await runHook(deps, ['Stop']))).toContain(other);
      expect(deps.files.get(FILE)).toBe(before);
      expect(deps.files.has(POINTER)).toBe(false);
    });

    it.each([
      ['a worker', WORKER_ID],
      ['another node', 'other-node'],
    ])('does not own a pointer that names a line of %s', async (_name, marker) => {
      const deps = await asNode();
      await writeLastSeen(deps, HOME, SESSION, { kind: 'event', event: 'SessionStart' }, marker);
      deps.seed(POINTER, `${SESSION}\n`);
      expect(await ownRead(deps)).toMatchObject({ state: 'not-owned' });
    });

    it('keeps the line and names the pointer when the pointer is a link', async () => {
      const links: Record<string, string> = {};
      const deps = await asNode({ links });
      links[POINTER] = OTHER;
      deps.seed(OTHER, 'victim');
      expect(errorOf(await runHook(deps, ['Stop']))).toContain('coordinator-last-session');
      expect(lineOf(deps)).toMatchObject({ event: 'Stop' });
      expect(deps.files.get(OTHER)).toBe('victim');
    });

    it('exits 0 and records the pointer through runCli', async () => {
      const deps = await asNode();
      expect(await runLine(['hook', 'Stop'], deps)).toEqual({ code: 0, out: '', err: '' });
      expect(deps.files.get(POINTER)).toBe(`${SESSION}\n`);
    });
  });

  it('exits 0 with an empty stdout and one line on stderr for an id with no record, through runCli', async () => {
    const deps = make({ stdin: payload('Stop'), env: { FACTORY_SESSION: WORKER_ID } });
    const before = snapshot(deps);
    const result = await runLine(['hook', 'Stop'], deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^factory hook: [^\n]+\n$/);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 0 with an empty stdout for a record that is a link, through runCli', async () => {
    const links: Record<string, string> = {};
    const deps = await makeWorker({ links });
    links[paths.recordFile] = OTHER;
    const result = await runLine(['hook', 'Stop'], deps);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(deps.files.has(FILE)).toBe(false);
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
      ['context_pct', 'event', 'event_at', 'pct_at', 'schema', 'session_id', 'session_marker'],
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
    ['an unknown event', ['hook', 'SubagentStop'], () => make({ stdin: stopInput })],
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
