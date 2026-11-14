import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { Deps } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import type { HookOutcome } from '../../src/hooks/hook.js';
import { blockNames, files, hookNames, roleText, schemaIds, setupFileOf, type HookEvent } from '../../src/names.js';
import { layoutOf, workerPathsOf } from '../../src/state/layout.js';
import { workerFileTemplatesFor } from '../../src/templates/index.js';
import {
  promptStateOf,
  readOwnCoordinatorSession,
  readWorkerLastSeen,
  writeLastSeen,
  type LastSeen,
} from '../../src/workers/last-seen.js';
import { writeWorkerRecord } from '../../src/workers/registry.js';
import { composeRoleText } from '../../src/workers/role-text.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';
import { runHook } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { ACCEPTANCES, acceptSetupText } from '../helpers/setup-acceptance.js';

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
  /** Default: /w, a folder outside every factory folder. */
  readonly cwd?: string;
  /** Default: the folder is in the factory list, so the registration check passes. */
  readonly registered?: boolean;
}

/** A registered factory folder on a fake file system, with the environment of a hook of its coordinator. */
const make = (options: MakeOptions = {}): FakeDeps => {
  const deps = createFakeDeps({
    cwd: options.cwd ?? '/w',
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

/** The outcome of a hook that prints nothing and has nothing to report. */
const SILENT = { ok: true, value: { context: null, problems: [] } } as const;

const errorOf = (result: CliResult<HookOutcome>): string => {
  if (result.ok) throw new Error('the hook should have refused');
  return result.error.message;
};

const runLine = async (argv: readonly string[], deps: Deps) => {
  const sink = captureSink();
  const code = await runCli(argv, deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('factory hook: the last-seen line of each captured payload', () => {
  it.each(hookNames.events)('writes one last-seen line for %s', async (event) => {
    const deps = make({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    expect(await runHook(deps, [event])).toEqual(SILENT);
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

  it('writes the line in the factory folder of FACTORY_HOME when the current folder is inside another factory folder', async () => {
    const deps = make({ stdin: payload('Stop'), cwd: '/w/child/deep' });
    deps.seed('/w/child/factory.yaml', 'schema: 2\n');
    deps.seedDir('/w/child/deep');
    expect(await runHook(deps, ['Stop'])).toEqual(SILENT);
    expect(lineOf(deps)).toMatchObject({ event: 'Stop', session_marker: NODE_ID });
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

describe('factory hook: the dialog states of the Notification and PreToolUse events', () => {
  const stateOfLine = (deps: FakeDeps): unknown => {
    const line = lineOf(deps) as LastSeen | null;
    return line === null ? null : promptStateOf(line);
  };

  it.each(hookNames.notificationTypes)('writes the state waits for the Notification type %s', async (type) => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: type }) });
    expect(await runHook(deps, ['Notification'])).toEqual(SILENT);
    expect(lineOf(deps)).toMatchObject({ event: 'Notification', session_id: SESSION });
    expect(stateOfLine(deps)).toBe('waits');
  });

  it('writes the state busy for PreToolUse', async () => {
    const deps = make({ stdin: payload('PreToolUse') });
    expect(await runHook(deps, ['PreToolUse'])).toEqual(SILENT);
    expect(stateOfLine(deps)).toBe('busy');
  });

  it.each([
    ['the type idle_prompt', { [hookNames.inputKeys.notificationType]: 'idle_prompt' }],
    ['a type that is not on the list', { [hookNames.inputKeys.notificationType]: 'auth_success' }],
    ['an empty type', { [hookNames.inputKeys.notificationType]: '' }],
    ['a type with other letter case', { [hookNames.inputKeys.notificationType]: 'Permission_Prompt' }],
    ['a type that holds a listed type as a part', { [hookNames.inputKeys.notificationType]: 'permission_prompt_x' }],
  ])('writes no line for a Notification with %s, and reports no fault', async (_name, fields) => {
    const deps = make({ stdin: payload('Notification', fields) });
    const before = snapshot(deps);
    expect(await runHook(deps, ['Notification'])).toEqual(SILENT);
    expect(snapshot(deps)).toBe(before);
  });

  it('writes no line for a Notification with no type', async () => {
    const { [hookNames.inputKeys.notificationType]: _type, ...withoutType } = FIXTURE.hooks.Notification;
    const deps = make({ stdin: JSON.stringify(withoutType) });
    const before = snapshot(deps);
    expect(await runHook(deps, ['Notification'])).toEqual(SILENT);
    expect(snapshot(deps)).toBe(before);
  });

  it('keeps the line of an earlier event when an idle_prompt notice arrives', async () => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: 'idle_prompt' }) });
    const stored = { schema: schemaIds.lastSeen, session_id: SESSION, event: 'Stop', event_at: NOW, context_pct: null, pct_at: null, session_marker: NODE_ID };
    deps.seed(FILE, `${JSON.stringify(stored)}\n`);
    expect((await runHook(deps, ['Notification'])).ok).toBe(true);
    expect(lineOf(deps)).toEqual(stored);
  });

  it('refuses a type that is not text, and writes nothing', async () => {
    const deps = make({ stdin: payload('Notification', { [hookNames.inputKeys.notificationType]: 7 }) });
    const before = snapshot(deps);
    expect(errorOf(await runHook(deps, ['Notification'])).length).toBeGreaterThan(0);
    expect(snapshot(deps)).toBe(before);
  });

  it.each(hookNames.events)('exits 0 with an empty stdout and empty stderr for %s with a listed input', async (event) => {
    const deps = make({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
    expect(await runLine(['hook', event], deps)).toEqual({ code: 0, out: '', err: '' });
  });

  it.each([
    ['idle_prompt', 'idle_prompt'],
    ['a missing type', undefined],
  ])('exits 0 with an empty stdout and empty stderr for a Notification with %s', async (_name, type) => {
    const fields = type === undefined ? {} : { [hookNames.inputKeys.notificationType]: type };
    const { [hookNames.inputKeys.notificationType]: _type, ...withoutType } = FIXTURE.hooks.Notification;
    const deps = make({ stdin: JSON.stringify({ ...withoutType, ...fields }) });
    const before = snapshot(deps);
    expect(await runLine(['hook', 'Notification'], deps)).toEqual({ code: 0, out: '', err: '' });
    expect(snapshot(deps)).toBe(before);
  });
});

describe('factory hook: refusals of the input', () => {
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

describe('factory hook: the factory folder and the session', () => {
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

describe('factory hook: the id of a worker in the registry as the session', () => {
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
    expect(await runHook(deps, ['Stop'])).toEqual(SILENT);
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

  describe('the session pointer of the coordinator', () => {
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
    expect(await runHook(spy, ['Stop'])).toEqual(SILENT);
    expect(touched).toEqual([]);
    expect(reads).toBe(0);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('factory hook: the role text of a worker session', () => {
  const WORKER_ID = 'fix-login';
  const SETUP = 'Write tests first.\n';
  const REL = setupFileOf(blockNames.setupWorker);
  const SETUP_FILE = layoutOf(HOME).setupWorkerFile;
  const DECOY_FILE = layoutOf(HOME).workerMd;
  const paths = workerPathsOf(HOME, WORKER_ID);

  const textOf = (setup: string | null): string => composeRoleText(workerFileTemplatesFor(sampleConfig(), setup));
  const outputOf = (text: string): string =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
  const refusedOutput = outputOf(roleText.refusal);
  const reasonLine = (reason: string): string => `factory hook: ${reason}\n`;

  interface World extends MakeOptions {
    /** The text of the setup file, or null for no file. */
    readonly text?: string | null;
    /** The text that the owner accepted. The default is `text`. Null: no acceptance. */
    readonly accepted?: string | null;
  }

  /** A node with a worker that has a record, a setup file that the owner accepted, and the environment of a SessionStart of that worker. */
  const makeStart = async (world: World = {}): Promise<FakeDeps> => {
    const { text = SETUP, accepted = text, ...options } = world;
    const deps = make({ stdin: payload('SessionStart'), ...options, env: { FACTORY_SESSION: WORKER_ID, ...options.env } });
    const written = await writeWorkerRecord(deps, HOME, {
      id: WORKER_ID,
      project: 'web',
      workCopy: '/h/factory/work-copies/web/fix-login',
      branch: 'worker/fix-login',
    });
    expect(written.ok).toBe(true);
    if (text !== null) deps.seed(SETUP_FILE, text);
    if (accepted !== null) acceptSetupText(deps, HOME, NODE_ID, [REL], { [REL]: accepted });
    return deps;
  };

  /** Run the hook of an event through the router, and keep each write to stdout and to stderr apart. */
  const ranFor = async (deps: Deps, event: HookEvent = 'SessionStart') => {
    const sink = captureSink();
    const code = await runCli(['hook', event], deps, sink);
    return { code, out: sink.out, err: sink.errors };
  };

  const touchedBy = (deps: FakeDeps): { readonly watched: FakeDeps; readonly setupCalls: () => string[] } => {
    const calls: string[] = [];
    return {
      watched: withFsWatch(deps, (method, path) => calls.push(`${method} ${path}`)),
      setupCalls: () => calls.filter((call) => call.includes('setup')),
    };
  };

  it('prints one JSON object that starts with the source line and holds the package worker rules and the accepted setup text', async () => {
    const ran = await ranFor(await makeStart());
    expect(ran).toEqual({ code: 0, out: [outputOf(textOf(SETUP))], err: [] });
    const printed = JSON.parse(ran.out[0] ?? '') as { hookSpecificOutput: { additionalContext: string } };
    const text = printed.hookSpecificOutput.additionalContext;
    expect(text.split('\n')[0]).toBe(roleText.sourceLine);
    expect(text.endsWith(SETUP)).toBe(true);
  });

  it.each(['startup', 'resume', 'clear', 'compact'])('prints the same text at a session start with the source %s', async (source) => {
    const deps = await makeStart({ stdin: payload('SessionStart', { source }) });
    expect(await ranFor(deps)).toEqual({ code: 0, out: [outputOf(textOf(SETUP))], err: [] });
  });

  it('prints the package worker rules alone when the setup file is absent and never accepted', async () => {
    const ran = await ranFor(await makeStart({ text: null, accepted: null }));
    expect(ran).toEqual({ code: 0, out: [outputOf(textOf(null))], err: [] });
  });

  it('never reads the rendered worker file, and prints no text of it', async () => {
    const deps = await makeStart();
    deps.seed(DECOY_FILE, 'DECOY TEXT');
    const calls: string[] = [];
    const ran = await ranFor(withFsWatch(deps, (method, path) => calls.push(`${method} ${path}`)));
    expect(ran.out).toEqual([outputOf(textOf(SETUP))]);
    expect(ran.out.join('')).not.toContain('DECOY');
    expect(calls.filter((call) => call.includes(DECOY_FILE))).toEqual([]);
  });

  it('prints no text of a decoy file that the inbox variable, the project folder variable or a field of the input names', async () => {
    const DECOYS = '/decoy';
    const deps = await makeStart({
      cwd: `${DECOYS}/cwd`,
      env: { FACTORY_INBOX: `${DECOYS}/inbox`, CLAUDE_PROJECT_DIR: `${DECOYS}/project` },
      stdin: payload('SessionStart', { cwd: `${DECOYS}/cwd`, transcript_path: `${DECOYS}/transcript.jsonl`, source: `${DECOYS}/source.md` }),
    });
    const decoyFiles = [
      `${DECOYS}/inbox/assignment.md`,
      `${DECOYS}/project/${REL}`,
      `${DECOYS}/cwd/${REL}`,
      `${DECOYS}/transcript.jsonl`,
      `${DECOYS}/source.md`,
    ];
    for (const file of decoyFiles) deps.seed(file, 'DECOY TEXT');
    const calls: string[] = [];
    const ran = await ranFor(withFsWatch(deps, (method, path) => calls.push(`${method} ${path}`)));
    expect(ran).toEqual({ code: 0, out: [outputOf(textOf(SETUP))], err: [] });
    expect(calls.filter((call) => call.includes(DECOYS))).toEqual([]);
  });

  it('prints nothing to stdout for the SessionStart of the coordinator, and reads no setup file', async () => {
    const deps = make({ stdin: payload('SessionStart') });
    deps.seed(SETUP_FILE, SETUP);
    acceptSetupText(deps, HOME, NODE_ID, [REL], { [REL]: SETUP });
    const { watched, setupCalls } = touchedBy(deps);
    expect(await ranFor(watched)).toEqual({ code: 0, out: [], err: [] });
    expect(setupCalls()).toEqual([]);
  });

  it.each(hookNames.events.filter((event) => event !== 'SessionStart'))(
    'prints nothing to stdout for %s of a worker, and reads no setup file',
    async (event) => {
      const deps = await makeStart({ stdin: JSON.stringify(FIXTURE.hooks[event]) });
      const { watched, setupCalls } = touchedBy(deps);
      expect(await ranFor(watched, event)).toEqual({ code: 0, out: [], err: [] });
      expect(setupCalls()).toEqual([]);
    },
  );

  it.each([
    ['no home variable', { FACTORY_HOME: undefined }],
    ['an empty session marker', { FACTORY_SESSION: '' }],
    ['an id that is not a slug', { FACTORY_SESSION: '../fix-login' }],
    ['a slug with no record', { FACTORY_SESSION: 'other-worker' }],
  ])('prints nothing to stdout for %s, with a decoy file in place', async (_name, env) => {
    const deps = await makeStart({ env });
    deps.seed(DECOY_FILE, 'DECOY TEXT');
    const { watched, setupCalls } = touchedBy(deps);
    const ran = await ranFor(watched);
    expect(ran.code).toBe(0);
    expect(ran.out).toEqual([]);
    expect(setupCalls()).toEqual([]);
  });

  it('prints nothing to stdout for a record that is a link', async () => {
    const links: Record<string, string> = {};
    const deps = await makeStart({ links });
    links[paths.recordFile] = '/elsewhere/worker-record';
    const { watched, setupCalls } = touchedBy(deps);
    const ran = await ranFor(watched);
    expect(ran.code).toBe(0);
    expect(ran.out).toEqual([]);
    expect(setupCalls()).toEqual([]);
  });

  describe('an input that the hook cannot use', () => {
    const BAD_INPUTS = [
      ['a session id that is not a UUID', payload('SessionStart', { session_id: 'leaky-value-123' })],
      ['an event name that differs from the argument', payload('SessionStart', { hook_event_name: 'Stop' })],
      ['an input that is not JSON', 'this is not json'],
      ['an empty input', ''],
      ['an input over the byte cap', payload('SessionStart', { source: 'x'.repeat(hookNames.maxStdinBytes) })],
    ] as const;

    it.each(BAD_INPUTS)(
      'prints the refusal text and one fixed reason for the SessionStart of a worker with %s, and records no session',
      async (_name, stdin) => {
        const deps = await makeStart({ stdin });
        const before = snapshot(deps);
        const ran = await ranFor(deps);
        expect(ran).toEqual({ code: 0, out: [refusedOutput], err: [reasonLine(roleText.reasons.inputNotUsable)] });
        expect(ran.err.join('')).not.toContain('leaky-value-123');
        expect(snapshot(deps)).toBe(before);
      },
    );

    it.each(BAD_INPUTS)('prints nothing to stdout for the SessionStart of the coordinator with %s', async (_name, stdin) => {
      const deps = make({ stdin });
      const before = snapshot(deps);
      const ran = await ranFor(deps);
      expect(ran.code).toBe(0);
      expect(ran.out).toEqual([]);
      expect(ran.err).toHaveLength(1);
      expect(ran.err[0]).not.toContain(roleText.reasons.inputNotUsable);
      expect(snapshot(deps)).toBe(before);
    });

    it.each([
      ['a slug with no record', { FACTORY_SESSION: 'other-worker' }],
      ['an id that is not a slug', { FACTORY_SESSION: '../fix-login' }],
      ['an empty session marker', { FACTORY_SESSION: '' }],
    ])('prints nothing to stdout for %s: a fault of the identity cannot prove a worker', async (_name, env) => {
      const deps = await makeStart({ env, stdin: 'this is not json' });
      const ran = await ranFor(deps);
      expect(ran.code).toBe(0);
      expect(ran.out).toEqual([]);
      expect(ran.err).toHaveLength(1);
    });

    it('prints nothing to stdout for a worker whose record is a link', async () => {
      const links: Record<string, string> = {};
      const deps = await makeStart({ links, stdin: 'this is not json' });
      links[paths.recordFile] = '/elsewhere/worker-record';
      expect((await ranFor(deps)).out).toEqual([]);
    });

    it.each(hookNames.events.filter((event) => event !== 'SessionStart'))(
      'prints nothing to stdout for %s of a worker with an input that is not JSON',
      async (event) => {
        const ran = await ranFor(await makeStart({ stdin: 'this is not json' }), event);
        expect(ran.code).toBe(0);
        expect(ran.out).toEqual([]);
        expect(ran.err).toHaveLength(1);
      },
    );
  });

  describe('a check that fails', () => {
    const changed = async (change: (deps: FakeDeps) => void, world: World = {}): Promise<FakeDeps> => {
      const deps = await makeStart(world);
      change(deps);
      return deps;
    };

    it.each([
      ['a link in the path of the setup file', roleText.reasons.link, () => makeStart({ links: { [SETUP_FILE]: '/elsewhere/worker.md' } })],
      ['a setup file that a group may write', roleText.reasons.ownerOrMode, () => changed((deps) => deps.modes.set(SETUP_FILE, 0o666))],
      ['a setup file that another user owns', roleText.reasons.ownerOrMode, () => changed((deps) => deps.owners.set(SETUP_FILE, 2000))],
      ['text above the cap', roleText.reasons.tooLarge, () => makeStart({ text: 'x'.repeat(roleText.maxChars + 1) })],
      ['bytes that are not UTF-8', roleText.reasons.notUtf8, () => changed((deps) => deps.invalidUtf8.add(SETUP_FILE))],
      ['a control character', roleText.reasons.notPlainText, () => makeStart({ text: 'Before\u0001after.\n' })],
      ['a block marker', roleText.reasons.blockMarker, () => makeStart({ text: '<!-- factory:begin safety v1 sha256=abc -->\n' })],
      ['text that the owner did not accept', roleText.reasons.notAccepted, () => makeStart({ accepted: null })],
      ['text that changed after the owner accepted it', roleText.reasons.notAccepted, () => makeStart({ text: 'Changed.\n', accepted: SETUP })],
      ['a store of acceptances that cannot be used', roleText.reasons.readFailed, () => changed((deps) => deps.seed(ACCEPTANCES, 'not json'))],
      [
        'a config that is not usable',
        roleText.reasons.configNotUsable,
        () => changed((deps) => deps.seed(`${HOME}/${files.localConfig}`, 'core: [not closed')),
      ],
    ])('prints only the refusal text and one fixed reason for %s', async (_name, reason, build) => {
      const ran = await ranFor(await build());
      expect(ran).toEqual({ code: 0, out: [refusedOutput], err: [reasonLine(reason)] });
    });

    it('prints no text of the setup file and no path in the refusal', async () => {
      const ran = await ranFor(await makeStart({ text: `Secret words.\u0001\n` }));
      expect(`${ran.out.join('')}${ran.err.join('')}`).not.toMatch(/Secret|\/h\/factory/);
    });

    it('prints only the refusal text and one fixed reason when the read throws, and drops the text of the throw', async () => {
      const deps = await makeStart();
      const throwing: Deps = {
        ...deps,
        fs: {
          ...deps.fs,
          lstatInfo: async (path) => {
            if (path === layoutOf(HOME).setupDir) throw new Error('boom /private/path');
            return deps.fs.lstatInfo(path);
          },
        },
      };
      expect(await ranFor(throwing)).toEqual({ code: 0, out: [refusedOutput], err: [reasonLine(roleText.reasons.readFailed)] });
      expect(lineOf(deps)).toMatchObject({ event: 'SessionStart', session_marker: WORKER_ID });
    });

    it('prints only the refusal text and one fixed reason when the write of the last-seen line throws', async () => {
      const deps = await makeStart();
      const throwing: Deps = {
        ...deps,
        now: () => {
          throw new Error('boom /private/path');
        },
      };
      expect(await ranFor(throwing)).toEqual({ code: 0, out: [refusedOutput], err: [reasonLine(roleText.reasons.readFailed)] });
    });
  });

  describe('the read and the write of the last-seen line do not depend on each other', () => {
    it('writes the last-seen line and the pointer of the worker when a check refuses the text', async () => {
      const deps = await makeStart({ accepted: null });
      expect((await ranFor(deps)).out).toEqual([refusedOutput]);
      expect(lineOf(deps)).toMatchObject({ event: 'SessionStart', session_id: SESSION, session_marker: WORKER_ID });
      expect(deps.files.get(paths.lastSessionFile)).toBe(`${SESSION}\n`);
    });

    it('prints the role text and one line for the problem when the write of the last-seen line fails', async () => {
      const deps = await makeStart({ links: { [FOLDER]: '/elsewhere' } });
      deps.seedDir(FOLDER);
      const ran = await ranFor(deps);
      expect(ran.code).toBe(0);
      expect(ran.out).toEqual([outputOf(textOf(SETUP))]);
      expect(ran.err).toHaveLength(1);
      expect(ran.err[0]).toMatch(/^factory hook: [^\n]+\n$/);
      expect(ran.err[0]).toContain('is a link');
      expect(deps.files.has(FILE)).toBe(false);
    });

    it('prints the refusal text and one line for each of two problems when the check and the write both fail', async () => {
      const deps = await makeStart({ accepted: null, links: { [FOLDER]: '/elsewhere' } });
      deps.seedDir(FOLDER);
      const ran = await ranFor(deps);
      expect(ran.out).toEqual([refusedOutput]);
      expect(ran.err).toHaveLength(2);
      expect(ran.err).toContain(reasonLine(roleText.reasons.notAccepted));
    });

    it('stops at a failed write of the last-seen line for another event of a worker', async () => {
      const deps = await makeStart({ stdin: payload('Stop'), links: { [FOLDER]: '/elsewhere' } });
      deps.seedDir(FOLDER);
      expect(errorOf(await runHook(deps, ['Stop']))).toContain('is a link');
      expect((await ranFor(deps, 'Stop')).out).toEqual([]);
    });

    it('stops at a failed write of the last-seen line for the SessionStart of the coordinator', async () => {
      const deps = make({ stdin: payload('SessionStart'), links: { [FOLDER]: '/elsewhere' } });
      deps.seedDir(FOLDER);
      expect(errorOf(await runHook(deps, ['SessionStart']))).toContain('is a link');
      expect((await ranFor(deps)).out).toEqual([]);
    });
  });
});

describe('factory hook: the transcript is never opened', () => {
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

describe('factory hook through runCli: exit 0 and an empty stdout on every path', () => {
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
