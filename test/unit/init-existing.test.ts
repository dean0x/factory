import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appendBlocks, renderBlock } from '../../src/blocks/managed.js';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { InitOptions } from '../../src/commands/init.js';
import { sameIdWarnings } from '../../src/commands/init-received.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import type { Deps } from '../../src/core/deps.js';
import { locateHome } from '../../src/core/home.js';
import { effectiveModes } from '../../src/core/owner-record.js';
import { ok } from '../../src/core/result.js';
import { manifestHash, type ManifestEntry } from '../../src/core/setup-acceptance.js';
import { commands, env, stateGuard, stateKeys, stateLock, values } from '../../src/names.js';
import type { ApprovalModes } from '../../src/recipes/index.js';
import { guardHookText } from '../../src/state/guard.js';
import { inspectState } from '../../src/state/load.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';
import { blockInputOf, blockTemplatesFor } from '../../src/templates/index.js';
import {
  createFakeDeps,
  exited,
  FAKE_PROGRAM_ARGV,
  registerRoot,
  withFailingWrites,
  type FakeDeps,
  type FakeOptions,
} from '../helpers/fake-deps.js';
import { loadConfig, readNodeIdentity, runInit } from '../helpers/package-registry.js';
import { gitHandler, withoutStateWords, type GitFixture } from '../helpers/git-fake.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { acceptSetupText } from '../helpers/setup-acceptance.js';

const ROOT = '/w/node';
const STATE = `${ROOT}/.factory`;
const MARKER = `${STATE}/node.json`;
const LOCAL = `${ROOT}/factory.local.yaml`;
const COORDINATOR = `${ROOT}/coordinator`;
const HOOK_FILE = `${COORDINATOR}/.claude/settings.local.json`;
/** The question about the hook settings starts with the line that shows the change. */
const HOOK_QUESTION = 'This changes the settings of Claude Code';
const ENV = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
const INDEX = '/state/factory/homes.json';
const ACCEPTANCES = '/state/factory/setup-acceptances.json';
const RECORDS = '/state/factory/owner-records.json';
const COORDINATOR_TEXT = 'Read the board first.\n';
const WORKER_TEXT = 'Keep the diff small.\n';
const SETUP_FILES = { 'setup/coordinator.md': COORDINATOR_TEXT, 'setup/roles/worker.md': WORKER_TEXT } as const;
const TRACKED_SETUP = ['.gitignore', 'factory.yaml', ...Object.keys(SETUP_FILES)];
const terminal = { stdinIsTTY: true, stdoutIsTTY: true };
const inSession = { ...ENV, [env.session]: 'demo' };
const DELEGATED: ApprovalModes = { merge: 'delegated', release: 'owner' };
/** The status of the state repo after the marker is written again: its text differs from the committed text. */
const MARKER_CHANGED = { [STATE]: ' M node.json\0' };
const NODE_MARKER =`${JSON.stringify({ [stateKeys.schemaVersion]: STATE_SCHEMA_VERSION, [stateKeys.createdWith]: 'test', [stateKeys.blocks]: {} })}\n`;

const options = (extra: Partial<InitOptions> = {}): InitOptions => ({
  home: ROOT,
  name: undefined,
  ownerName: undefined,
  ownerGithub: undefined,
  projects: [],
  yes: false,
  recipe: undefined,
  layer: undefined,
  approval: [],
  ...extra,
});

type Prompt = NonNullable<FakeOptions['prompt']>;

interface Answers {
  readonly register?: string;
  readonly accept?: string;
  /** The answers for the approval points, in order. A point after the last answer gets the default. */
  readonly points?: readonly string[];
  /** The answer to the question about the hook settings. Default: no. */
  readonly hook?: string;
}

/** A person at the terminal. Every question that the list does not name gets its default (an empty answer). */
const person = (answers: Answers = {}, asked: string[] = []): Prompt => {
  const points = [...(answers.points ?? [])];
  return (question) => {
    asked.push(question);
    if (question.includes('Register this')) return ok(answers.register ?? 'y');
    if (question.includes('Accept these files?')) return ok(answers.accept ?? 'y');
    if (question.includes('Approval point')) return ok(points.shift() ?? '');
    if (question.includes(HOOK_QUESTION)) return ok(answers.hook ?? '');
    return ok('');
  };
};

type StateKind = 'valid' | 'older' | 'newer' | 'absent' | 'no-marker' | 'broken-marker' | 'file';

interface Existing {
  /** The node id of `factory.yaml`. Default: demo. */
  readonly id?: string;
  /** The local modes. Default: owner for each point. */
  readonly approval?: ApprovalModes;
  /** The entry of the factory list for the root: its id, or none. Default: the id of the config. */
  readonly entry?: string | null;
  readonly origin?: 'own' | 'received';
  readonly state?: StateKind;
  /** False: the state folder is not the top of a work tree of its own. */
  readonly stateRepo?: boolean;
  readonly tracked?: readonly string[];
  readonly texts?: Readonly<Record<string, string>>;
  readonly fixture?: GitFixture;
  /**
   * True: the owner has not accepted the setup text of the root. Default: the owner accepted the setup text before, in a
   * terminal window, so a run with the yes flag has nothing to accept. A test about the acceptance sets this.
   */
  readonly unaccepted?: true;
  /** The base URL of the one proxy that the local file defines and the session uses. Default: no proxy. */
  readonly proxyUrl?: string;
  /**
   * False: the coordinator folder is there, and its settings file for the hook is not. Default: an earlier run of init wrote
   * the file, so the entries are in place and a run asks nothing about them.
   */
  readonly hookInPlace?: false;
}

const configOf = (made: Existing): FactoryConfig => {
  const base = sampleConfig();
  const proxied =
    made.proxyUrl === undefined
      ? {}
      : {
          session: { ...base.core.session, proxy: 'gate' },
          proxies: [{ id: 'gate', base_url: made.proxyUrl, health: '/health', on_fail: values.onFail[0] }],
        };
  return {
    ...base,
    core: {
      ...base.core,
      node: { ...base.core.node, id: made.id ?? base.core.node.id },
      approval: made.approval ?? base.core.approval,
      ...proxied,
    },
  };
};

const stateFor = (deps: FakeDeps, state: StateKind): void => {
  deps.files.delete(MARKER);
  deps.dirs.delete(STATE);
  if (state === 'absent') return;
  if (state === 'file') return deps.seed(STATE, 'not a folder');
  deps.seedDir(STATE);
  deps.seed(`${STATE}/board.json`, '{"items":[]}\n');
  if (state === 'valid') deps.seed(MARKER, NODE_MARKER);
  if (state === 'older') deps.seed(MARKER, NODE_MARKER.replace(`${STATE_SCHEMA_VERSION}`, `${STATE_SCHEMA_VERSION - 1}`));
  if (state === 'newer') deps.seed(MARKER, NODE_MARKER.replace(`${STATE_SCHEMA_VERSION}`, `${STATE_SCHEMA_VERSION + 1}`));
  if (state === 'broken-marker') deps.seed(MARKER, '{not json');
};

/** A folder that holds both config files, in the state that `made` names. */
const existing = (made: Existing = {}, extra: FakeOptions = {}) => {
  const tracked = made.tracked ?? TRACKED_SETUP;
  const state = made.state ?? 'valid';
  const { handler, log } = gitHandler({
    repos: { [ROOT]: {}, ...(made.stateRepo === false ? {} : { [STATE]: {} }) },
    tracked: { [ROOT]: tracked },
    status: MARKER_CHANGED,
    ...made.fixture,
  });
  const deps = createFakeDeps({ cwd: ROOT, run: handler, env: ENV, ...extra });
  deps.seedDir(ROOT);
  seedConfig(deps, ROOT, configOf(made));
  deps.seed(`${ROOT}/.gitignore`, '/*\n!/factory.yaml\n');
  const texts: Record<string, string> = { ...SETUP_FILES, ...made.texts };
  for (const path of tracked) {
    if (path === 'factory.yaml' || path === '.gitignore' || path === 'factory.local.yaml') continue;
    deps.seed(`${ROOT}/${path}`, texts[path] ?? `${path}\n`);
  }
  if (made.unaccepted !== true) acceptSetupText(deps, ROOT, made.id ?? 'demo', tracked, texts);
  if (made.hookInPlace === false) deps.seedDir(COORDINATOR);
  else deps.seed(HOOK_FILE, JSON.stringify(ownSettingsEntries));
  const entry = made.entry === undefined ? (made.id ?? 'demo') : made.entry;
  if (entry !== null) {
    registerRoot(deps, ROOT, entry, [`${ROOT}/web`]);
    if (made.origin !== undefined) withOrigin(deps, made.origin);
  }
  stateFor(deps, state);
  return { deps, log };
};

const withOrigin = (deps: FakeDeps, origin: string): void => {
  const found = JSON.parse(deps.files.get(INDEX) ?? '{}') as { homes: Record<string, unknown>[] };
  deps.seed(INDEX, JSON.stringify({ ...found, homes: found.homes.map((entry) => ({ ...entry, origin })) }));
};

const rootFiles = (deps: FakeDeps): string =>
  JSON.stringify([...deps.files].filter(([path]) => path.startsWith(`${ROOT}/`)).sort());

const outsideState = (deps: FakeDeps): string =>
  JSON.stringify([...deps.files].filter(([path]) => path.startsWith(`${ROOT}/`) && !path.startsWith(`${STATE}/`)).sort());

const snapshot = (deps: FakeDeps): string => JSON.stringify([[...deps.files.entries()].sort(), [...deps.dirs].sort()]);

const messageOf = (result: { ok: boolean; error?: { message: string; hint?: string } }): string =>
  `${result.error?.message ?? ''} ${result.error?.hint ?? ''}`;

const linesOf = (result: Awaited<ReturnType<typeof runInit>>): string =>
  result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';

const warningsOf = (result: Awaited<ReturnType<typeof runInit>>): string[] => (result.ok ? [...result.value.warnings] : []);

interface IndexEntry {
  home: string;
  id: string;
  projects: string[];
  origin?: string;
}

const indexOf = (deps: FakeDeps): IndexEntry[] =>
  (JSON.parse(deps.files.get(INDEX) ?? '{"homes":[]}') as { homes: IndexEntry[] }).homes;

const entryOf = (deps: FakeDeps): IndexEntry | undefined => indexOf(deps).find((entry) => entry.home === ROOT);

const acceptancesOf = (deps: FakeDeps): { root: string; node: string; hash: string; reason: string }[] =>
  (JSON.parse(deps.files.get(ACCEPTANCES) ?? '{"acceptances":[]}') as { acceptances: never[] }).acceptances;

const recordsOf = (deps: FakeDeps): { kind: string; node: string; root: string; point: string; mode: string }[] =>
  (JSON.parse(deps.files.get(RECORDS) ?? '{"records":[]}') as { records: never[] }).records;

const fileEntry = (path: string, text: string): ManifestEntry => ({
  path,
  type: 'file',
  size: Buffer.byteLength(text, 'utf8'),
  sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  blob: null,
});

const SETUP_HASH = manifestHash(Object.entries(SETUP_FILES).map(([path, text]) => fileEntry(path, text)));

const failingWrite = (deps: Deps, suffix: string): Deps => withFailingWrites(deps, (path) => path.endsWith(suffix));

const stateGit = (log: { calls: { command: string; args: readonly string[] }[] }): string[] =>
  log.calls
    .filter((call) => call.command === 'git' && call.args[0] === '-C' && call.args[1] === STATE)
    .map((call) => withoutStateWords(call.args).slice(2).join(' '));

describe('init: a registered root, the checks and the acceptance (TP-181)', () => {
  it('asks on a terminal window, writes the acceptance, and changes no other file', async () => {
    const asked: string[] = [];
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person({}, asked) });
    const before = rootFiles(deps);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(asked.some((question) => question.includes('Accept these files?'))).toBe(true);
    expect(acceptancesOf(deps)).toEqual([expect.objectContaining({ root: ROOT, node: 'demo', hash: SETUP_HASH })]);
    expect(rootFiles(deps)).toBe(before);
    expect(entryOf(deps)).toMatchObject({ id: 'demo' });
    expect(result.ok && result.value.json['accepted']).toBe(true);
  });

  it('writes the acceptance only after the entry in the factory list', async () => {
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person() });
    expect((await runInit(deps, options())).ok).toBe(true);
    const writes = deps.atomicWrites.filter((path) => [INDEX, ACCEPTANCES].includes(path));
    expect(writes).toEqual([INDEX, ACCEPTANCES]);
  });

  it('exits 4 with the yes flag and no terminal window for a setup text with no acceptance, names the command, and writes nothing', async () => {
    const { deps } = existing({ unaccepted: true });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory init');
    expect(messageOf(result)).toContain('terminal window');
    expect(acceptancesOf(deps)).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 with the yes flag in a terminal window, asks nothing about the files, and writes nothing', async () => {
    const asked: string[] = [];
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person({}, asked) });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory init');
    expect(asked.some((question) => question.includes('Accept these files?'))).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('writes no acceptance when the owner answers no, changes no file, and names the command', async () => {
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person({ accept: 'n' }) });
    const before = rootFiles(deps);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(acceptancesOf(deps)).toEqual([]);
    expect(rootFiles(deps)).toBe(before);
    expect(linesOf(result)).toContain('factory init');
  });

  it('asks nothing about the files when an acceptance exists for the current files', async () => {
    const { deps } = existing({}, terminal);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    const asked: string[] = [];
    const again = existing({}, { ...terminal, prompt: person({}, asked) });
    again.deps.seed(ACCEPTANCES, deps.files.get(ACCEPTANCES) ?? '');
    const result = await runInit(again.deps, options());
    expect(result.ok).toBe(true);
    expect(asked.some((question) => question.includes('Accept these files?'))).toBe(false);
    expect(result.ok && result.value.json['accepted']).toBe(false);
  });

  it('exits 4 and writes nothing when the setup needs an acceptance and no terminal window can ask', async () => {
    const { deps } = existing({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'] });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory init');
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['the local file', 'factory.local.yaml'],
    ['a path in the state folder', '.factory/board.json'],
    ['a path in the coordinator folder', 'coordinator/CLAUDE.md'],
    ['a path in a project folder', 'web/CLAUDE.md'],
  ])('runs the checks of the tracked paths again: exit 4 for %s, and nothing is written', async (_name, path) => {
    const { deps } = existing({ tracked: [...TRACKED_SETUP, path] }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(path);
    expect(messageOf(result)).toContain('git rm --cached');
    expect(snapshot(deps)).toBe(before);
  });

  it('runs the check of the ignore rules again: exit 4 and the line to add, when git does not ignore the local file', async () => {
    const { deps } = existing({ fixture: { ignored: { [ROOT]: ['.factory/node.json', 'coordinator/CLAUDE.md', 'web/CLAUDE.md'] } } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('"factory.local.yaml"');
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses a link in the setup folder again', async () => {
    const { deps } = existing({}, { links: { [`${ROOT}/setup`]: '/elsewhere' } });
    deps.seedDir('/elsewhere');
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('treats a root whose state marker has an older version as registered, and leaves the marker as it is', async () => {
    const { deps } = existing({ state: 'older' });
    const marker = deps.files.get(MARKER);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.files.get(MARKER)).toBe(marker);
    expect(result.ok && result.value.json['existing']).toBe('registered');
  });

  it('finds the root from the current folder when no home flag is given', async () => {
    const { deps } = existing();
    const result = await runInit(deps, options({ home: undefined, yes: true }));
    expect(result.ok && result.value.json['home']).toBe(ROOT);
    expect(result.ok && result.value.json['existing']).toBe('registered');
  });

  it('keeps the origin of the entry', async () => {
    const { deps } = existing({ origin: 'own' });
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(entryOf(deps)).toMatchObject({ origin: 'own' });
    const received = existing({ origin: 'received' });
    expect((await runInit(received.deps, options({ yes: true }))).ok).toBe(true);
    expect(entryOf(received.deps)).toMatchObject({ origin: 'received' });
  });

  it('counts an entry with no origin as received, and writes that', async () => {
    const { deps } = existing();
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(entryOf(deps)).toMatchObject({ origin: 'received' });
  });

  it.each([
    ['--name', { name: 'other' }],
    ['--layer', { layer: '2' }],
    ['--recipe', { recipe: 'software' }],
    ['--project', { projects: ['https://host/acme/api.git'] }],
    ['--owner-name', { ownerName: 'Dana' }],
    ['--owner-github', { ownerGithub: 'dana' }],
  ])('refuses the flag %s with exit 2, because the files of the root hold its values', async (flag, extra) => {
    const { deps } = existing();
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true, ...extra }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain(flag);
    expect(snapshot(deps)).toBe(before);
  });

  it('fails with the message of a node that exists when factory.yaml is not valid, and writes nothing', async () => {
    const { deps } = existing();
    deps.seed(`${ROOT}/factory.yaml`, 'schema: 2\n');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.yaml already exists');
    expect(messageOf(result)).toContain('factory doctor');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: a root that holds both config files in a factory session (TP-83)', () => {
  it.each([
    ['a registered root', {}],
    ['a moved root', { entry: null }],
    ['a root with an entry of another node id', { entry: 'old' }],
    ['a root with no state folder', { state: 'absent' as const }],
  ])('asks nothing, exits 4 and writes nothing for %s, with or without the yes flag', async (_name, made) => {
    for (const yes of [true, false]) {
      const { deps } = existing(made, { ...terminal, env: inSession, prompt: () => ok('y') });
      const before = snapshot(deps);
      const result = await runInit(deps, options({ yes }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(deps.prompts).toEqual([]);
      expect(snapshot(deps)).toBe(before);
    }
  });
});

describe('init: the mode of the local file on a registered root (TP-108, TP-146, TP-147)', () => {
  const NOTICE = 'set the mode of factory.local.yaml to 600';

  it.each([
    ['644', 0o644],
    ['640', 0o640],
    ['604', 0o604],
  ])('sets a local file with the read mode %s back to 600, keeps its text, and puts one notice in the output', async (_name, mode) => {
    const { deps } = existing();
    deps.modes.set(LOCAL, mode);
    const localBefore = deps.files.get(LOCAL);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.failed).toBe(false);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(deps.files.get(LOCAL)).toBe(localBefore);
    const notices = warningsOf(result).filter((warning) => warning.includes(NOTICE));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`It was ${mode.toString(8)}`);
    expect(result.ok && result.value.json['warnings']).toEqual(expect.arrayContaining(notices));
  });

  it('gives no notice and changes no mode for a private local file', async () => {
    const { deps } = existing();
    deps.modes.set(LOCAL, 0o600);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(warningsOf(result).some((warning) => warning.includes(NOTICE))).toBe(false);
  });

  it('keeps the notice and ends with mode 600 when the run writes the local file for a new approval mode', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n', points: ['delegated', 'owner'] }) });
    deps.modes.set(LOCAL, 0o644);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.modes.get(LOCAL)).toBe(0o600);
    expect(deps.files.get(LOCAL)).toContain('merge: delegated');
    expect(warningsOf(result).filter((warning) => warning.includes(NOTICE))).toHaveLength(1);
  });

  it.each([
    ['a group write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o660)],
    ['an other write bit', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o602)],
    ['a write bit with the read bits', (deps: FakeDeps) => deps.modes.set(LOCAL, 0o666)],
    ['another owner', (deps: FakeDeps) => deps.owners.set(LOCAL, 0)],
  ])('stops with exit 4 and the chmod line for a local file with %s, and changes nothing', async (_name, change) => {
    const { deps } = existing({}, { ...terminal, prompt: person() });
    change(deps);
    const mode = deps.modes.get(LOCAL);
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('chmod 600 factory.local.yaml');
    expect(deps.modes.get(LOCAL)).toBe(mode);
    expect(deps.prompts).toEqual([]);
    expect(deps.atomicWrites).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 and the remedy line for a local file that is a link, before the mode fix, and changes nothing', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person(), links: { [LOCAL]: '/outside/factory.local.yaml' } });
    deps.modes.set(LOCAL, 0o644);
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory.local.yaml is a link, so factory does not use it');
    expect(messageOf(result)).toContain('Move factory.local.yaml away, then run "factory init" to write a new one.');
    expect(deps.modes.get(LOCAL)).toBe(0o644);
    expect(deps.atomicWrites).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the approval points of a registered root', () => {
  it('asks each point again after the checks, with the current mode as the default, and keeps the local file as it is', async () => {
    const asked: string[] = [];
    const { deps } = existing({ approval: DELEGATED }, { ...terminal, prompt: person({ accept: 'n' }, asked) });
    const localBefore = deps.files.get(LOCAL);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const points = asked.filter((question) => question.includes('Approval point'));
    expect(points).toHaveLength(2);
    expect(points[0]).toContain('Approval point merge');
    expect(points[0]).toContain('[delegated]');
    expect(points[1]).toContain('Approval point release');
    expect(points[1]).toContain('[owner]');
    expect(deps.files.get(LOCAL)).toBe(localBefore);
    expect(result.ok && result.value.json['approval']).toEqual(DELEGATED);
  });

  it('asks the points before the question about the files', async () => {
    const asked: string[] = [];
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person({}, asked) });
    expect((await runInit(deps, options())).ok).toBe(true);
    const order = asked.map((question) => (question.includes('Approval point') ? 'point' : question.includes('Accept') ? 'accept' : 'other'));
    expect(order).toEqual(['point', 'point', 'accept']);
  });

  it('replaces the old mode with the new answer: the local file and the record', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n', points: ['delegated', 'owner'] }) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const config = await loadConfig(deps, ROOT);
    expect(config.ok && config.value.core.approval).toEqual(DELEGATED);
    expect(recordsOf(deps)).toEqual([
      expect.objectContaining({ kind: 'delegation', node: 'demo', root: ROOT, point: 'merge', mode: 'delegated' }),
      expect.objectContaining({ kind: 'delegation', node: 'demo', root: ROOT, point: 'release', mode: 'owner' }),
    ]);
    expect(await effectiveModes(deps, ROOT, config.ok ? config.value : sampleConfig())).toEqual(DELEGATED);
    expect(result.ok && result.value.json['approval']).toEqual(DELEGATED);
    expect(linesOf(result)).toContain('Approval points: merge delegated, release owner.');
  });

  it('keeps the comments of the local file when it writes the new modes', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n', points: ['delegated'] }) });
    deps.seed(LOCAL, `# my own note\n${deps.files.get(LOCAL) ?? ''}`);
    expect((await runInit(deps, options())).ok).toBe(true);
    const local = deps.files.get(LOCAL) ?? '';
    expect(local.startsWith('# my own note\n')).toBe(true);
    expect(local).toContain('merge: delegated');
    expect(deps.modes.get(LOCAL)).toBe(0o600);
  });

  it('keeps a delegation when the answer is the default, and ends it with an owner answer: the local file and an owner record', async () => {
    const answers: string[] = ['delegated', 'owner'];
    const { deps } = existing({}, {
      ...terminal,
      prompt: (question) => ok(question.includes('Approval point') ? (answers.shift() ?? '') : question.includes('Accept') ? 'n' : ''),
    });
    expect((await runInit(deps, options())).ok).toBe(true);
    const config = (): Promise<ApprovalModes | null> => loadConfig(deps, ROOT).then((loaded) => (loaded.ok ? loaded.value.core.approval : null));

    // The defaults are the current modes, so a run that takes them keeps the delegation.
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(await config()).toEqual(DELEGATED);
    expect(recordsOf(deps).find((record) => record.point === 'merge')).toMatchObject({ mode: 'delegated' });

    answers.push('owner', 'owner');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(await config()).toEqual({ merge: 'owner', release: 'owner' });
    expect(recordsOf(deps).find((record) => record.point === 'merge')).toMatchObject({ mode: 'owner' });
    const loaded = await loadConfig(deps, ROOT);
    expect(loaded.ok && (await effectiveModes(deps, ROOT, loaded.value))).toEqual({ merge: 'owner', release: 'owner' });
  });

  it('takes the flag for a point and asks only for the others', async () => {
    const asked: string[] = [];
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n' }, asked) });
    const result = await runInit(deps, options({ approval: ['merge=delegated'] }));
    expect(result.ok).toBe(true);
    expect(asked.filter((question) => question.includes('Approval point'))).toHaveLength(1);
    const config = await loadConfig(deps, ROOT);
    expect(config.ok && config.value.core.approval).toEqual(DELEGATED);
    expect(recordsOf(deps).map((record) => `${record.point} ${record.mode}`).sort()).toEqual(['merge delegated', 'release owner']);
  });

  it('writes the record that a first run could not write, when the local file says delegated already', async () => {
    const { deps } = existing({ approval: DELEGATED }, { ...terminal, prompt: person({ accept: 'n' }) });
    const config = await loadConfig(deps, ROOT);
    expect(config.ok && (await effectiveModes(deps, ROOT, config.value))).toEqual({ merge: 'owner', release: 'owner' });
    expect((await runInit(deps, options())).ok).toBe(true);
    const after = await loadConfig(deps, ROOT);
    expect(after.ok && (await effectiveModes(deps, ROOT, after.value))).toEqual(DELEGATED);
  });

  it('exits 2 for the yes flag with a flag that asks delegated, and writes nothing', async () => {
    const { deps } = existing();
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true, approval: ['merge=delegated'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 for a flag that asks delegated with no terminal window, and writes nothing', async () => {
    const { deps } = existing();
    const before = snapshot(deps);
    const result = await runInit(deps, options({ approval: ['merge=delegated'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('keeps every mode, asks nothing and writes no record with the yes flag, also for a delegated mode', async () => {
    const { deps } = existing({ approval: DELEGATED }, { ...terminal, prompt: () => ok('y') });
    const localBefore = deps.files.get(LOCAL);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.prompts).toEqual([]);
    expect(deps.files.get(LOCAL)).toBe(localBefore);
    expect(recordsOf(deps)).toEqual([]);
    expect(result.ok && result.value.json['approval']).toEqual({ merge: 'owner', release: 'owner' });
  });

  it('keeps every mode and asks nothing with no terminal window', async () => {
    const { deps } = existing({ approval: DELEGATED }, { stdinIsTTY: false, stdoutIsTTY: false });
    const localBefore = deps.files.get(LOCAL);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(deps.files.get(LOCAL)).toBe(localBefore);
    expect(deps.prompts).toEqual([]);
  });

  it('warns for a record that can not be written, names the point and the remedy, and counts the point as owner', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n', points: ['delegated', 'owner'] }) });
    const result = await runInit(failingWrite(deps, '/owner-records.json'), options());
    expect(result.ok).toBe(true);
    const merge = warningsOf(result).filter((warning) => warning.includes('merge'));
    expect(merge).toHaveLength(1);
    expect(merge[0]).toContain('counts as owner');
    expect(merge[0]).toContain('Run "factory init" in a terminal window outside a factory session');
    expect(result.ok && result.value.json['approval']).toEqual({ merge: 'owner', release: 'owner' });
  });

  it('puts the old local file back and writes no record when the factory list can not be written', async () => {
    const { deps } = existing({ unaccepted: true }, { ...terminal, prompt: person({ accept: 'n', points: ['delegated', 'owner'] }) });
    const before = rootFiles(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(rootFiles(deps)).toBe(before);
    expect(deps.files.has(RECORDS)).toBe(false);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
  });

  it('writes the local file before the factory list and the records after it', async () => {
    const { deps } = existing({}, { ...terminal, prompt: person({ accept: 'n', points: ['delegated', 'owner'] }) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const writes = deps.atomicWrites.filter((path) => [LOCAL, INDEX, RECORDS].includes(path));
    expect(writes.indexOf(LOCAL)).toBeLessThan(writes.indexOf(INDEX));
    expect(writes.indexOf(INDEX)).toBeLessThan(writes.indexOf(RECORDS));
  });
});

describe('init: the text of the coordinator follows a changed mode of a registered root', () => {
  const COORDINATOR_FILE = `${ROOT}/coordinator/CLAUDE.md`;
  const OWNER: ApprovalModes = { merge: 'owner', release: 'owner' };

  /** The text of the coordinator file for these modes, as `init` and `upgrade` render it. */
  const textFor = (modes: ApprovalModes, setup: { coordinator: string | null; worker: string | null } = { coordinator: null, worker: null }): string => {
    const templates = blockTemplatesFor(blockInputOf(configOf({}), setup, modes));
    const blocks = templates
      .filter((template) => template.target === 'claudeFile')
      .map((template) => {
        const rendered = renderBlock(template);
        if (!rendered.ok) throw new Error(rendered.error.message);
        return rendered.value;
      });
    return appendBlocks('', blocks);
  };

  /** A person who gives the answers of the list for the approval points, one after the other, and says no to the files. */
  const answering = (points: string[]): Prompt => (question) =>
    ok(question.includes('Approval point') ? (points.shift() ?? '') : question.includes('Accept these files?') ? 'n' : '');

  const withText = (made: Existing, extra: FakeOptions, text: string = textFor(OWNER)) => {
    const fake = existing(made, extra);
    fake.deps.seed(COORDINATOR_FILE, text);
    return fake;
  };

  const writesOf = (deps: FakeDeps, from = 0): string[] =>
    deps.atomicWrites.slice(from).filter((path) => [LOCAL, INDEX, COORDINATOR_FILE, RECORDS].includes(path));

  it('names the new mode in the text after the run, and prints no line that asks for an upgrade', async () => {
    const { deps } = withText({}, { ...terminal, prompt: answering(['delegated', 'owner']) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(textFor(DELEGATED)).not.toBe(textFor(OWNER));
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(DELEGATED));
    expect(linesOf(result)).not.toContain('still names');
    expect(linesOf(result)).toContain('coordinator/CLAUDE.md');
    expect(result.ok && result.value.json['files']).toContain('coordinator/CLAUDE.md');
  });

  it('writes the text again when the owner ends a delegation, and the text names the owner', async () => {
    const points = ['delegated', 'owner'];
    const { deps } = withText({}, { ...terminal, prompt: answering(points) });
    expect((await runInit(deps, options())).ok).toBe(true);
    points.push('owner', 'owner');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(OWNER));
  });

  it('renders again before the records when a mode goes to owner, and after the records when a mode goes to delegated', async () => {
    const points = ['delegated', 'owner'];
    const { deps } = withText({}, { ...terminal, prompt: answering(points) });
    expect((await runInit(deps, options())).ok).toBe(true);
    // One record for each point that the owner set: two.
    expect(writesOf(deps)).toEqual([LOCAL, INDEX, RECORDS, RECORDS, COORDINATOR_FILE]);

    const from = deps.atomicWrites.length;
    points.push('owner', 'owner');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(writesOf(deps, from)).toEqual([LOCAL, INDEX, COORDINATOR_FILE, RECORDS, RECORDS]);
  });

  it('leaves the text byte-equal and writes no file when no mode changes, also for a text that differs from the modes', async () => {
    const stale = textFor(DELEGATED);
    const { deps } = withText({}, { ...terminal, prompt: answering(['owner', 'owner']) }, stale);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(stale);
    expect(deps.atomicWrites).not.toContain(COORDINATOR_FILE);
    expect(linesOf(result)).not.toContain('coordinator/CLAUDE.md');
  });

  it('leaves the text byte-equal with the yes flag and with no terminal window, which set no point', async () => {
    for (const extra of [{ ...terminal, prompt: answering([]) }, { stdinIsTTY: false, stdoutIsTTY: false }]) {
      const { deps } = withText({ approval: DELEGATED }, extra, textFor(DELEGATED));
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(DELEGATED));
      expect(deps.atomicWrites).not.toContain(COORDINATOR_FILE);
    }
  });

  it('names the delegation after the run that writes the record the first run could not write', async () => {
    const { deps } = withText({ approval: DELEGATED }, { ...terminal, prompt: answering(['delegated', 'owner']) });
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(OWNER));
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(DELEGATED));
  });

  it('keeps the owner in the text for a point whose record can not be written, and warns', async () => {
    const { deps } = withText({}, { ...terminal, prompt: answering(['delegated', 'owner']) });
    const result = await runInit(failingWrite(deps, '/owner-records.json'), options());
    expect(result.ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(OWNER));
    expect(warningsOf(result).some((warning) => warning.includes('counts as owner'))).toBe(true);
    expect(linesOf(result)).not.toContain('coordinator/CLAUDE.md');
  });

  it('names the owner in the text when the owner ends a delegation and the record can not be written', async () => {
    const points = ['delegated', 'owner'];
    const { deps } = withText({}, { ...terminal, prompt: answering(points) });
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(DELEGATED));
    points.push('owner', 'owner');
    expect((await runInit(failingWrite(deps, '/owner-records.json'), options())).ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(OWNER));
  });

  it('changes neither the text nor the local file when the factory list can not be written', async () => {
    const { deps } = withText({}, { ...terminal, prompt: answering(['delegated', 'owner']) });
    const before = rootFiles(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(rootFiles(deps)).toBe(before);
    expect(deps.atomicWrites).not.toContain(COORDINATOR_FILE);
  });

  it('keeps an edited block as it is, renders the others, and names the command that says why', async () => {
    const edited = textFor(OWNER).replace('A merge waits for the go of the owner.', 'A merge waits for nobody.');
    expect(edited).not.toBe(textFor(OWNER));
    const { deps } = withText({}, { ...terminal, prompt: answering(['delegated', 'owner']) }, edited);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toContain('A merge waits for nobody.');
    expect(warningsOf(result).join('\n')).toContain(`factory upgrade --home ${ROOT}`);
    expect(linesOf(result)).toContain('still names');
  });

  it('leaves the block of the setup text as it is: a render of the modes never carries a text that is not accepted', async () => {
    const setup = { coordinator: 'Setup text from an older pull.\n', worker: null };
    const { deps } = withText({}, { ...terminal, prompt: answering(['delegated', 'owner']) }, textFor(OWNER, setup));
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(deps.files.get(COORDINATOR_FILE)).toBe(textFor(DELEGATED, setup));
    expect(deps.files.get(COORDINATOR_FILE)).toContain('Setup text from an older pull.');
    expect(deps.files.get(COORDINATOR_FILE)).not.toContain(COORDINATOR_TEXT.trim());
  });

  it('writes no coordinator file that is not there, and gives no warning for it', async () => {
    const { deps } = existing({}, { ...terminal, prompt: answering(['delegated', 'owner']) });
    expect(deps.files.has(COORDINATOR_FILE)).toBe(false);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.files.has(COORDINATOR_FILE)).toBe(false);
    expect(warningsOf(result).join('\n')).not.toContain('coordinator');
  });
});

describe('init: a moved root, with no entry in the factory list (TP-82)', () => {
  const moved = (made: Existing = {}, extra: FakeOptions = {}) => {
    const made2 = existing({ ...made, entry: null }, extra);
    registerRoot(made2.deps, '/w/old', 'demo');
    return made2;
  };

  it('registers the root with the yes flag, changes no file of the root, keeps the old entry, and the root rule passes', async () => {
    const { deps } = moved();
    const before = rootFiles(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(rootFiles(deps)).toBe(before);
    expect(indexOf(deps).map((entry) => entry.home).sort()).toEqual(['/w/node', '/w/old']);
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'received' });
    expect(await locateHome(deps, ROOT, readNodeIdentity, commands.init)).toMatchObject({ ok: true });
    expect(result.ok && result.value.json['existing']).toBe('moved');
  });

  it('shows the root, the node id and the reason also with the yes flag', async () => {
    const { deps } = moved();
    const result = await runInit(deps, options({ yes: true }));
    const text = linesOf(result);
    expect(text).toContain(ROOT);
    expect(text).toContain('demo');
    expect(text).toContain('has no entry');
  });

  it('shows the proxy host of the local file also with the yes flag, and still registers the root', async () => {
    const { deps } = moved({ proxyUrl: 'http://203.0.113.9:8080/v1' });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(linesOf(result)).toContain('Proxy: gate (203.0.113.9:8080)');
    expect(linesOf(result)).not.toContain('/v1');
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'received' });
  });

  it('shows the proxy host of the local file in the question, and says none when the local file names no proxy', async () => {
    const asked: string[] = [];
    const proxied = moved({ proxyUrl: 'https://proxy.example.net/v1' }, { ...terminal, prompt: person({}, asked) });
    expect((await runInit(proxied.deps, options())).ok).toBe(true);
    expect(asked[0]).toContain('Proxy: gate (proxy.example.net:443)');

    const plain = moved();
    expect(linesOf(await runInit(plain.deps, options({ yes: true })))).toContain('Proxy: none');
  });

  it('shows them before the first question on a terminal window and registers after a yes', async () => {
    const asked: string[] = [];
    const { deps } = moved({}, { ...terminal, prompt: person({}, asked) });
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(asked[0]).toContain(ROOT);
    expect(asked[0]).toContain('demo');
    expect(asked[0]).toContain('has no entry');
    expect(asked[0]).toContain('Register this');
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'received' });
  });

  it.each([['n'], ['']])('writes nothing and exits 2 when the answer is %j (the default is no)', async (answer) => {
    const { deps } = moved({}, { ...terminal, prompt: person({ register: answer }) });
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('asks nothing about approval points: the local modes stay', async () => {
    const asked: string[] = [];
    const { deps } = moved({ approval: DELEGATED }, { ...terminal, prompt: person({ accept: 'n' }, asked) });
    const localBefore = deps.files.get(LOCAL);
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(asked.some((question) => question.includes('Approval point'))).toBe(false);
    expect(deps.files.get(LOCAL)).toBe(localBefore);
  });

  it('exits 2 and writes nothing with no terminal window and no yes flag', async () => {
    const { deps } = moved();
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('refuses the approval flag, because the points are set in a second run', async () => {
    const { deps } = moved({}, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true, approval: ['merge=owner'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--approval');
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 before any write for a tracked instruction file with no terminal window, also with the yes flag (TP-157)', async () => {
    const { deps } = moved({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'], unaccepted: true });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory init');
    expect(snapshot(deps)).toBe(before);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
  });

  it('asks for the listed files on a terminal window, and writes the acceptance on yes', async () => {
    const asked: string[] = [];
    const { deps } = moved({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'], unaccepted: true }, { ...terminal, prompt: person({}, asked) });
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(asked.some((question) => question.includes('CLAUDE.md'))).toBe(true);
    expect(acceptancesOf(deps)).toHaveLength(1);
  });

  it.each([
    ['the local file', 'factory.local.yaml'],
    ['a path in the state folder', '.factory/board.json'],
    ['a path in the coordinator folder', 'coordinator/CLAUDE.md'],
  ])('exits 4 and writes nothing when the root repo tracks %s', async (_name, path) => {
    const { deps } = moved({ tracked: [...TRACKED_SETUP, path] }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(path);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 1 for a folder inside a root that the factory list holds', async () => {
    const { deps } = moved();
    deps.seed('/w/factory.yaml', 'schema: 2\n');
    registerRoot(deps, '/w', 'outer');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('is inside the factory folder /w');
    expect(snapshot(deps)).toBe(before);
  });

  it('warns that another entry of the list has the same node id', async () => {
    const { deps } = moved();
    const result = await runInit(deps, options({ yes: true }));
    expect(warningsOf(result).join('\n')).toContain('/w/old');
  });

  it('says that each delegation must be set again, and names the points and the command', async () => {
    const { deps } = moved({ approval: DELEGATED });
    const result = await runInit(deps, options({ yes: true }));
    const text = [linesOf(result), ...warningsOf(result)].join('\n');
    expect(text).toContain('merge');
    expect(text).toContain('again');
    expect(text).toContain('run "factory init" in a terminal window outside a factory session');
    expect(text).not.toContain('factory decide');
    expect(text).not.toContain('release');
  });

  it('says nothing about delegations when no point is delegated', async () => {
    const { deps } = moved();
    const result = await runInit(deps, options({ yes: true }));
    expect([linesOf(result), ...warningsOf(result)].join('\n')).not.toContain('delegat');
  });

  it('counts a delegated point as owner after the move, because no record names the new path', async () => {
    const { deps } = moved({ approval: DELEGATED });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.json['approval']).toEqual({ merge: 'owner', release: 'owner' });
  });

  it('exits 1 and changes nothing when the factory list can not be written (TP-95)', async () => {
    const { deps } = moved({ unaccepted: true }, { ...terminal, prompt: person() });
    const before = snapshot(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
  });
});

describe('init: an entry with another node id (TP-84, TP-169, TP-170)', () => {
  it('shows the old and the new id and the reason, and replaces the entry with the origin received', async () => {
    const asked: string[] = [];
    const { deps } = existing({ entry: 'old', origin: 'own' }, { ...terminal, prompt: person({}, asked) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(asked[0]).toContain('"old"');
    expect(asked[0]).toContain('demo');
    expect(asked[0]).toContain('another id');
    expect(indexOf(deps).filter((entry) => entry.home === ROOT)).toEqual([
      expect.objectContaining({ id: 'demo', origin: 'received' }),
    ]);
    expect(result.ok && result.value.json['existing']).toBe('other-id');
  });

  it('shows both ids also with the yes flag', async () => {
    const { deps } = existing({ entry: 'old' });
    const text = linesOf(await runInit(deps, options({ yes: true })));
    expect(text).toContain('old');
    expect(text).toContain('demo');
  });

  it('never writes own for the root again in a later run', async () => {
    const { deps } = existing({ entry: 'old', origin: 'own' });
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'received' });
  });

  it('writes nothing and exits 2 when the owner answers no', async () => {
    const { deps } = existing({ entry: 'old' }, { ...terminal, prompt: person({ register: 'n' }) });
    const before = snapshot(deps);
    expect(await runInit(deps, options())).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 before any write with the yes flag and no terminal window, when an acceptance exists under the old id', async () => {
    const old = existing({ id: 'old' });
    expect((await runInit(old.deps, options({ yes: true }))).ok).toBe(true);
    const { deps } = existing({ entry: 'old' });
    deps.seed(ACCEPTANCES, old.deps.files.get(ACCEPTANCES) ?? '');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('factory init');
    expect(snapshot(deps)).toBe(before);
  });

  it('accepts the change on a terminal window, and writes the acceptance for the new id', async () => {
    const old = existing({ id: 'old' });
    expect((await runInit(old.deps, options({ yes: true }))).ok).toBe(true);
    const { deps } = existing({ entry: 'old' }, { ...terminal, prompt: person() });
    deps.seed(ACCEPTANCES, old.deps.files.get(ACCEPTANCES) ?? '');
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(acceptancesOf(deps).map((record) => record.node).sort()).toEqual(['demo', 'old']);
  });

  it('says that each delegation must be set again', async () => {
    const { deps } = existing({ entry: 'old', approval: DELEGATED });
    const result = await runInit(deps, options({ yes: true }));
    const text = [linesOf(result), ...warningsOf(result)].join('\n');
    expect(text).toContain('merge');
    expect(text).toContain('again');
    expect(text).toContain('factory init');
  });
});

describe('init: a root with no state folder (TP-85)', () => {
  it('makes the state folder as the received path does, registers the root, and the root rule passes', async () => {
    const { deps, log } = existing({ state: 'absent', origin: 'own' });
    const before = outsideState(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    for (const name of ['node.json', 'board.json', 'waiting.json', 'decision-log.json', '.gitignore', 'roles/worker.md']) {
      expect(deps.files.has(`${STATE}/${name}`), name).toBe(true);
    }
    expect((await inspectState(deps, ROOT)).kind).toBe('valid');
    expect(await locateHome(deps, ROOT, readNodeIdentity, commands.init)).toMatchObject({ ok: true });
    // The files of the root apart from the state folder stay as they were.
    expect(outsideState(deps)).toBe(before);
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'own' });
    expect(log.commands()).toContain('add -A');
    expect(result.ok && result.value.json['committed']).toBe(true);
    expect(linesOf(result)).toContain('.factory/');
  });

  it('leaves no staging folder', async () => {
    const { deps } = existing({ state: 'absent' });
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect([...deps.dirs].some((dir) => dir.includes('.tmp-'))).toBe(false);
  });

  it('checks the ignore rules as the received path does: exit 4 and the line to add when git does not ignore the state folder', async () => {
    const { deps } = existing({ state: 'absent', fixture: { ignored: { [ROOT]: ['factory.local.yaml', 'coordinator/CLAUDE.md', 'web/CLAUDE.md'] } } });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('".factory/"');
    expect(snapshot(deps)).toBe(before);
  });

  it('never renames onto a state folder that another program made during the run, also an empty one, and removes its own staging folder', async () => {
    const { handler } = gitHandler({ repos: { [ROOT]: {} }, tracked: { [ROOT]: TRACKED_SETUP } });
    const made = existing({ state: 'absent' }, {
      run: (call) => {
        if (call.command === 'git' && call.args[2] === 'init') made.deps.seedDir(STATE);
        return handler(call);
      },
    });
    const result = await runInit(made.deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('made by another program');
    expect([...made.deps.dirs].some((dir) => dir.includes('.tmp-'))).toBe(false);
    expect([...made.deps.files.keys()].some((path) => path.startsWith(`${STATE}/`))).toBe(false);
  });

  it('removes the state folder it made and changes nothing else when the factory list can not be written (TP-95)', async () => {
    const { deps } = existing({ state: 'absent' });
    const before = snapshot(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('warns and makes no commit when git has no identity', async () => {
    const { deps } = existing({ state: 'absent', fixture: { identity: false } });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.json['committed']).toBe(false);
    expect(warningsOf(result).join('\n')).toContain('No git identity');
  });
});

describe('init: a root whose state folder has a missing or broken marker (TP-96, TP-124)', () => {
  it.each([
    ['missing', 'no-marker' as const],
    ['broken', 'broken-marker' as const],
  ])('keeps the folder and its files, writes only the %s marker in place, and the root rule passes', async (_name, state) => {
    const { deps, log } = existing({ state, origin: 'own' });
    const board = deps.files.get(`${STATE}/board.json`);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.files.get(`${STATE}/board.json`)).toBe(board);
    expect((await inspectState(deps, ROOT)).kind).toBe('valid');
    expect(deps.atomicWrites.filter((path) => path.startsWith(`${STATE}/`))).toEqual([MARKER]);
    expect(stateGit(log)).not.toContain('init -q');
    expect(entryOf(deps)).toMatchObject({ id: 'demo', origin: 'own' });
    expect(await locateHome(deps, ROOT, readNodeIdentity, commands.init)).toMatchObject({ ok: true });
    expect(result.ok && result.value.json['existing']).toBe('marker');
    expect(linesOf(result)).toContain('.factory/node.json');
  });

  it('commits only the marker, after the entry in the factory list', async () => {
    const seen: string[] = [];
    const { handler } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP }, status: MARKER_CHANGED });
    const made = existing({ state: 'broken-marker' }, {
      run: (call) => {
        if (call.args[1] === STATE && call.args.includes('commit')) seen.push(made.deps.files.get(INDEX) ?? '');
        return handler(call);
      },
    });
    expect((await runInit(made.deps, options({ yes: true }))).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(ROOT);
    expect(seen[0]).toContain('"demo"');
  });

  it('stages only node.json for the commit', async () => {
    const { deps, log } = existing({ state: 'no-marker' });
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    const git = stateGit(log);
    expect(git).toContain('add -A -- node.json');
    expect(git.some((command) => command.includes('commit') && command.includes('-m'))).toBe(true);
    expect(git).not.toContain('add -A');
  });

  it.each([
    ['a broken marker', 'broken-marker' as const, '{not json'],
    ['no marker', 'no-marker' as const, undefined],
  ])('puts back %s and makes no commit when the factory list can not be written', async (_name, state, bytes) => {
    const { deps, log } = existing({ state });
    const before = snapshot(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(deps.files.get(MARKER)).toBe(bytes);
    expect(snapshot(deps)).toBe(before);
    expect(stateGit(log).some((command) => command.includes('commit'))).toBe(false);
  });

  it('registers, writes the marker, makes no commit and warns when git has no identity', async () => {
    const { deps, log } = existing({ state: 'no-marker', fixture: { identity: false } });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect((await inspectState(deps, ROOT)).kind).toBe('valid');
    expect(stateGit(log).some((command) => command.includes('commit'))).toBe(false);
    expect(warningsOf(result).join('\n')).toContain('No git identity');
    expect(result.ok && result.value.json['committed']).toBe(false);
  });

  it('makes no commit and gives no warning when the marker has the text that git holds', async () => {
    const { deps, log } = existing({ state: 'broken-marker', fixture: { status: {} } });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect((await inspectState(deps, ROOT)).kind).toBe('valid');
    expect(stateGit(log).some((command) => command.includes('commit') || command.startsWith('add'))).toBe(false);
    expect(warningsOf(result).join('\n')).not.toContain('commit');
    expect(result.ok && result.value.json['committed']).toBe(false);
  });

  it('is a warning, not a failure, when the commit of the marker fails', async () => {
    const { handler } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP }, status: MARKER_CHANGED });
    const { deps } = existing({ state: 'no-marker' }, {
      run: (call) => (call.args[1] === STATE && call.args.includes('commit') ? exited(1, '', 'fatal') : handler(call)),
    });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(entryOf(deps)).toMatchObject({ id: 'demo' });
    expect(warningsOf(result).join('\n')).toContain('not committed');
  });

  describe('and the state lock (TP-19)', () => {
    const LOCK_FILE = `${STATE}/locks/${stateLock.name}${stateLock.lock.suffix}`;

    it('waits for the lock of another writer, then warns with the lock path, and leaves the marker in place with no commit', async () => {
      const { deps, log } = existing({ state: 'no-marker' });
      deps.seed(LOCK_FILE, '1\n');
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      expect(warningsOf(result).join('\n')).toContain(LOCK_FILE);
      expect(warningsOf(result).join('\n')).toContain('not committed');
      expect(result.ok && result.value.json['committed']).toBe(false);
      expect((await inspectState(deps, ROOT)).kind).toBe('valid');
      expect(stateGit(log).some((command) => command.includes('commit') || command.startsWith('add'))).toBe(false);
      expect(deps.sleeps).toEqual(Array.from({ length: stateLock.lock.attempts - 1 }, () => stateLock.lock.waitMs));
      expect(deps.files.get(LOCK_FILE)).toBe('1\n');
    });

    it('holds the lock while it commits the marker, and lets the lock go after', async () => {
      const held: boolean[] = [];
      const { handler } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP }, status: MARKER_CHANGED });
      const made = existing({ state: 'no-marker' }, {
        run: (call) => {
          if (call.args[1] === STATE && call.args.includes('commit')) held.push(made.deps.files.has(LOCK_FILE));
          return handler(call);
        },
      });
      expect((await runInit(made.deps, options({ yes: true }))).ok).toBe(true);
      expect(held).toEqual([true]);
      expect(made.deps.files.has(LOCK_FILE)).toBe(false);
    });
  });

  it('refuses a state folder that is not the top of its own work tree: exit 4, and nothing is written (TP-124)', async () => {
    const { deps, log } = existing({ state: 'no-marker', stateRepo: false });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(STATE);
    expect(snapshot(deps)).toBe(before);
    expect(stateGit(log).some((command) => command.includes('commit') || command.startsWith('add'))).toBe(false);
  });

  it('exits 1 and writes nothing when the state repo holds a staged change that the commit would take', async () => {
    const { handler } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP } });
    const { deps } = existing({ state: 'no-marker' }, {
      run: (call) => (call.args[1] === STATE && call.args.includes('status') ? exited(0, 'A  other.json\0') : handler(call)),
    });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('other.json');
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 and writes nothing when the marker path is not a file', async () => {
    const { deps } = existing({ state: 'no-marker' });
    deps.seedDir(MARKER);
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 for a marker of a newer version, and writes nothing', async () => {
    const { deps } = existing({ state: 'newer' });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('newer');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the delete guard of a state repo that exists (TP-2, TP-53)', () => {
  const GUARD = `${STATE}/.git/${stateGuard.folder}`;
  const HOOK = `${GUARD}/${stateGuard.hookFile}`;
  const hookText = (): string => {
    const text = guardHookText(FAKE_PROGRAM_ARGV);
    if (!text.ok) throw new Error(text.error.message);
    return text.value;
  };
  /** A state folder that is a git repo of its own, as the fake file system shows it. */
  const repo = (deps: FakeDeps): void => deps.seedDir(`${STATE}/.git`);
  const setting = (log: { commands(): string[] }): string[] => log.commands().filter((line) => line.startsWith('config -- core.hooksPath'));

  it.each([
    ['a state folder that is complete', 'valid' as const],
    ['a state folder with no marker', 'no-marker' as const],
    ['a state folder with a broken marker', 'broken-marker' as const],
  ])('writes the guard into the git folder of %s, before the entry in the factory list', async (_name, state) => {
    const seen: boolean[] = [];
    const { handler, log } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP }, status: MARKER_CHANGED });
    const made = existing({ state, entry: null }, {
      run: (call) => {
        if (call.args.includes('core.hooksPath') && call.args.includes('--')) seen.push(made.deps.files.has(INDEX));
        return handler(call);
      },
    });
    repo(made.deps);
    const result = await runInit(made.deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(made.deps.files.get(HOOK)).toBe(hookText());
    expect(made.deps.modes.get(HOOK)).toBe(0o755);
    expect(setting(log)).toEqual([`config -- core.hooksPath ${GUARD}`]);
    expect(seen).toEqual([false]);
    expect(entryOf(made.deps)).toMatchObject({ id: 'demo' });
    expect(linesOf(result)).toContain('.factory/.git/factory-guard');
  });

  it('writes nothing for the guard when it is on already', async () => {
    const { deps, log } = existing({ state: 'valid', fixture: { hooksPath: { [STATE]: GUARD } } });
    repo(deps);
    deps.seed(HOOK, hookText());
    deps.modes.set(HOOK, 0o755);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(deps.atomicWrites).not.toContain(HOOK);
    expect(setting(log)).toEqual([]);
    expect(linesOf(result)).not.toContain('factory-guard');
  });

  it('repairs a guard whose hook text differs from the text of the package', async () => {
    const { deps } = existing({ state: 'valid', fixture: { hooksPath: { [STATE]: GUARD } } });
    repo(deps);
    deps.seed(HOOK, '#!/bin/sh\nexit 0\n');
    deps.modes.set(HOOK, 0o755);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(deps.files.get(HOOK)).toBe(hookText());
  });

  it('leaves a state folder with no git entry as it is: there is no repo to guard', async () => {
    const { deps, log } = existing({ state: 'valid' });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect([...deps.files.keys()].some((path) => path.includes(stateGuard.folder))).toBe(false);
    expect(setting(log)).toEqual([]);
  });

  it.each([
    ['a state folder that is complete', 'valid' as const],
    ['a state folder with no marker', 'no-marker' as const],
  ])('exits 4, writes nothing and lists no entry when the guard of %s can not be written', async (_name, state) => {
    const { deps } = existing({ state, entry: null }, { programArgv: [] });
    repo(deps);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.files.has(INDEX)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 and leaves the folder of the link as it was when the guard folder is a link', async () => {
    const { deps } = existing({ state: 'no-marker', entry: null }, { links: { [GUARD]: '/elsewhere/folder' } });
    repo(deps);
    deps.seed('/elsewhere/folder/keep.txt', 'keep');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect([...deps.files.keys()].filter((path) => path.startsWith('/elsewhere/'))).toEqual(['/elsewhere/folder/keep.txt']);
    expect(deps.files.has(INDEX)).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it.each([
    ['a state folder that is complete', 'valid' as const],
    ['a state folder with no marker', 'no-marker' as const],
  ])('puts the git folder of %s back as it was when the factory list can not be written after the guard', async (_name, state) => {
    const { deps, log } = existing({ state, entry: null });
    repo(deps);
    const before = snapshot(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
    expect(setting(log)).toEqual([`config -- core.hooksPath ${GUARD}`]);
    expect(log.commands()).toContain('config --unset core.hooksPath');
  });

  it('puts an old guard back as it was when a later step fails: the setting, the hook and the stray file', async () => {
    const { deps, log } = existing({ state: 'valid', entry: null, fixture: { hooksPath: { [STATE]: '/old/hooks' } } });
    repo(deps);
    deps.seed(HOOK, '#!/bin/sh\nexit 0\n');
    deps.modes.set(HOOK, 0o755);
    deps.seed(`${GUARD}/stray`, 'x');
    const before = snapshot(deps);
    const result = await runInit(failingWrite(deps, '/homes.json'), options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
    expect(deps.modes.get(HOOK)).toBe(0o755);
    expect(setting(log)).toEqual([`config -- core.hooksPath ${GUARD}`, 'config -- core.hooksPath /old/hooks']);
  });

  it('puts an old guard folder back when the setting can not be written', async () => {
    const { handler } = gitHandler({ repos: { [ROOT]: {}, [STATE]: {} }, tracked: { [ROOT]: TRACKED_SETUP }, status: MARKER_CHANGED });
    const run: NonNullable<FakeOptions['run']> = (call) =>
      call.args.includes('core.hooksPath') && call.args.includes('--') ? exited(1, '', 'fatal: cannot write') : handler(call);
    const { deps } = existing({ state: 'valid', entry: null }, { run });
    repo(deps);
    deps.seed(HOOK, '#!/bin/sh\nexit 0\n');
    deps.modes.set(HOOK, 0o755);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
    expect(deps.modes.get(HOOK)).toBe(0o755);
  });

  it('keeps no copy of the old guard folder when the run works', async () => {
    const { deps } = existing({ state: 'valid' });
    repo(deps);
    deps.seed(HOOK, '#!/bin/sh\nexit 0\n');
    deps.modes.set(HOOK, 0o755);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(deps.files.get(HOOK)).toBe(hookText());
    expect([...deps.files.keys(), ...deps.dirs].filter((path) => path.includes(stateGuard.folder)).sort()).toEqual([GUARD, HOOK].sort());
  });

  it('writes the guard once for a state folder that it makes: the staging folder holds it', async () => {
    const { deps, log } = existing({ state: 'absent' });
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(deps.files.get(HOOK)).toBe(hookText());
    expect(setting(log)).toEqual([`config -- core.hooksPath ${GUARD}`]);
  });
});

describe('init: a state path that is not a folder (TP-119)', () => {
  it.each([
    ['a registered root', {}],
    ['a moved root', { entry: null }],
    ['a root with an entry of another node id', { entry: 'old' }],
  ])('exits 4, names the path to move away and writes nothing for %s', async (_name, made) => {
    const { deps } = existing({ ...made, state: 'file' }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(STATE);
    expect(messageOf(result)).toContain('Move');
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('exits 4 for a link in the place of the state folder', async () => {
    const { deps } = existing({}, { links: { [STATE]: '/elsewhere' } });
    deps.seedDir('/elsewhere');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('.factory is a link');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the warning for another entry with the same node id', () => {
  const withLink = () => {
    const deps = createFakeDeps({ env: ENV, links: { '/w/via': '/w/real' } });
    deps.seedDir('/w/real');
    deps.seedDir('/w/via');
    deps.seedDir('/w/other');
    registerRoot(deps, '/w/real', 'demo');
    registerRoot(deps, '/w/other', 'demo');
    return deps;
  };

  it('does not count the entry of the root itself, also when the folder is spelled with a link', async () => {
    const warnings = await sameIdWarnings(withLink(), INDEX, '/w/via', 'demo');
    expect(warnings).toEqual([expect.stringContaining('/w/other')]);
  });

  it('names each other entry', async () => {
    const warnings = await sameIdWarnings(withLink(), INDEX, '/w/third', 'demo');
    expect(warnings).toHaveLength(2);
  });
});

describe('init: the hook settings of a registered root (TP-16)', () => {
  const settingsOf = (deps: FakeDeps): unknown => JSON.parse(deps.files.get(HOOK_FILE) ?? 'null');

  it('asks nothing and writes nothing when the entries are in place, also with no terminal window and no yes flag', async () => {
    const { deps } = existing();
    const before = rootFiles(deps);
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.prompts).toEqual([]);
    expect(deps.warned).toEqual([]);
    expect(rootFiles(deps)).toBe(before);
    expect(result.ok && result.value.json['files']).not.toContain('coordinator/.claude/settings.local.json');
  });

  it('writes the own entries with the yes flag, prints the change first, and lists the file', async () => {
    const { deps } = existing({ hookInPlace: false });
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(settingsOf(deps)).toEqual(ownSettingsEntries);
    expect(deps.warned.filter((text) => text.startsWith(HOOK_QUESTION))).toEqual([expect.stringContaining(HOOK_FILE)]);
    expect(result.ok && result.value.json['files']).toContain('coordinator/.claude/settings.local.json');
  });

  it('asks after the question about the files, and writes after a yes', async () => {
    const asked: string[] = [];
    const { deps } = existing({ hookInPlace: false, unaccepted: true }, { ...terminal, prompt: person({ hook: 'y' }, asked) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    const order = asked.map((question) => (question.includes('Accept these files?') ? 'files' : question.startsWith(HOOK_QUESTION) ? 'hook' : 'other'));
    expect(order.filter((kind) => kind !== 'other')).toEqual(['files', 'hook']);
    expect(settingsOf(deps)).toEqual(ownSettingsEntries);
  });

  it('goes on after a no, writes no file, and names the command in the notice', async () => {
    const { deps } = existing({ hookInPlace: false }, { ...terminal, prompt: person({ hook: 'n' }) });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(deps.files.has(HOOK_FILE)).toBe(false);
    expect(warningsOf(result).join(' ')).toContain('run "factory init" again and answer yes');
  });

  it('stops with exit 2 before any write with no terminal window and no yes flag, and shows the change and the target', async () => {
    const { deps } = existing({ hookInPlace: false, approval: DELEGATED });
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain(HOOK_FILE);
    expect(messageOf(result)).toContain('--yes');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 1 before any write for a settings file that is not a JSON object', async () => {
    const { deps } = existing({ hookInPlace: false });
    deps.seed(HOOK_FILE, '[]');
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(snapshot(deps)).toBe(before);
  });

  describe('a failure of the hook step after the last write: the root stays registered', () => {
    /** The command line of a person on a terminal window. The hook question is the last question. */
    const runOnTerminal = async (deps: FakeDeps) => {
      const sink = captureSink();
      const code = await runCli(['init', '--home', ROOT], deps, sink);
      return { code, shown: sink.errors.join('') };
    };

    const expectRootKept = (deps: FakeDeps): void => {
      expect(deps.files.has(MARKER)).toBe(true);
      expect(deps.files.has(`${ROOT}/factory.yaml`)).toBe(true);
      expect(indexOf(deps)).toEqual([expect.objectContaining({ home: ROOT, id: 'demo' })]);
    };

    it('exits 1 and names the cause when the question gets no answer, and writes no settings file', async () => {
      const { deps } = existing({ hookInPlace: false }, { ...terminal, prompt: person({ hook: 'y' }) });
      const before = rootFiles(deps);
      const asked: string[] = [];
      const silent: FakeDeps = {
        ...deps,
        prompt: async (question) => {
          if (!question.startsWith(HOOK_QUESTION)) return deps.prompt(question);
          asked.push(question);
          return failure('no answer was given');
        },
      };
      const { code, shown } = await runOnTerminal(silent);
      expect(code).toBe(1);
      expect(shown).toContain('error: no answer was given');
      expect(asked).toHaveLength(1);
      expectRootKept(deps);
      expect(deps.files.has(HOOK_FILE)).toBe(false);
      expect(rootFiles(deps)).toBe(before);
    });

    it('exits 1 and names the file and the cause when the write of the settings file fails, and writes no settings file', async () => {
      const { deps } = existing({ hookInPlace: false }, { ...terminal, prompt: person({ hook: 'y' }) });
      const before = rootFiles(deps);
      const full: FakeDeps = {
        ...deps,
        fs: {
          ...deps.fs,
          writeTextExclusive: async (path, text, mode) =>
            path.includes('settings.local.json') ? failure(`cannot write ${path}: disk full`) : deps.fs.writeTextExclusive(path, text, mode),
        },
      };
      const { code, shown } = await runOnTerminal(full);
      expect(code).toBe(1);
      expect(shown).toContain('error: cannot write');
      expect(shown).toContain('settings.local.json');
      expect(shown).toContain('disk full');
      expectRootKept(deps);
      expect(rootFiles(deps)).toBe(before);
    });

    it('exits 1 with the remedy line when the file changes while the question waits, and keeps the file as the other program left it', async () => {
      const { deps } = existing({ hookInPlace: false }, { ...terminal, prompt: person({ hook: 'y' }) });
      const saved = JSON.stringify({ model: 'opus', ...ownSettingsEntries });
      const changing: FakeDeps = {
        ...deps,
        prompt: async (question) => {
          if (question.startsWith(HOOK_QUESTION)) deps.seed(HOOK_FILE, saved);
          return deps.prompt(question);
        },
      };
      const { code, shown } = await runOnTerminal(changing);
      expect(code).toBe(1);
      expect(shown).toContain(`error: cannot write ${HOOK_FILE}: it changed while the question waited`);
      expect(shown).toContain('Then run "factory init" again.');
      expectRootKept(deps);
      expect(deps.files.get(HOOK_FILE)).toBe(saved);
    });
  });
});

describe('init: a folder that holds both config files, the dispatch', () => {
  it('does not take a folder with only the local file for an existing root', async () => {
    const { deps } = existing();
    deps.files.delete(`${ROOT}/factory.yaml`);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false });
    expect(messageOf(result)).toContain('already exists');
  });

  it('finds a root that holds both config files at the top of the work tree of the current folder', async () => {
    const { deps } = existing({}, { cwd: `${ROOT}/web` });
    deps.seedDir(`${ROOT}/web`);
    const result = await runInit(deps, options({ home: undefined, yes: true }));
    expect(result.ok && result.value.json['home']).toBe(ROOT);
  });
});
