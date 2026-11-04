import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InitOptions } from '../../src/commands/init.js';
import { renderConfig } from '../../src/config/render.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { manifestHash, type ManifestEntry } from '../../src/core/setup-acceptance.js';
import { ok } from '../../src/core/result.js';
import { env, trackedFiles } from '../../src/names.js';
import {
  createFakeDeps,
  exited,
  registerRoot,
  withFailingWrites,
  type FakeDeps,
  type FakeOptions,
} from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { runInit } from '../helpers/package-registry.js';
import { sampleConfig } from '../helpers/sample-config.js';

const ROOT = '/w/recv';
const ENV = { XDG_STATE_HOME: '/state', HOME: '/users/me' };
const INDEX = '/state/factory/homes.json';
const ACCEPTANCES = '/state/factory/setup-acceptances.json';
const RECORDS = '/state/factory/owner-records.json';
const COORDINATOR_TEXT = 'Read the board first.\n';
const WORKER_TEXT = 'Keep the diff small.\n';
const SETUP_FILES = {
  'setup/coordinator.md': COORDINATOR_TEXT,
  'setup/roles/worker.md': WORKER_TEXT,
} as const;
const TRACKED_SETUP = ['.gitignore', 'factory.yaml', ...Object.keys(SETUP_FILES)];
const terminal = { stdinIsTTY: true, stdoutIsTTY: true };

const options = (extra: Partial<InitOptions> = {}): InitOptions => ({
  home: ROOT,
  name: undefined,
  ownerName: 'Test Owner',
  ownerGithub: undefined,
  projects: [],
  yes: false,
  recipe: undefined,
  layer: undefined,
  approval: [],
  ...extra,
});

type Prompt = NonNullable<FakeOptions['prompt']>;

/** A person at the terminal: the accept prompt gets `accept`, and every other question gets its default. */
const person =
  (accept: string, asked: string[] = []): Prompt =>
  (question) => {
    asked.push(question);
    return ok(question.includes('Accept these files?') ? accept : '');
  };

interface Received {
  /** The text of `factory.yaml`. Default: the sample config. */
  readonly config?: FactoryConfig;
  /** The files that the root repo tracks. Default: the gitignore, `factory.yaml` and the two setup texts. */
  readonly tracked?: readonly string[];
  /** The text of each file by its path below the root. A tracked path with no text gets a short text. */
  readonly texts?: Readonly<Record<string, string>>;
  readonly fixture?: GitFixture;
}

const received = (made: Received = {}, extra: FakeOptions = {}) => {
  const tracked = made.tracked ?? TRACKED_SETUP;
  const { handler, log } = gitHandler({
    repos: { [ROOT]: {} },
    tracked: { [ROOT]: tracked },
    ...made.fixture,
  });
  const deps = createFakeDeps({ cwd: ROOT, run: handler, env: ENV, ...extra });
  deps.seedDir(ROOT);
  deps.seed(`${ROOT}/factory.yaml`, renderConfig(made.config ?? sampleConfig()).shared);
  deps.seed(`${ROOT}/.gitignore`, '/*\n!/factory.yaml\n');
  const texts: Record<string, string> = { ...SETUP_FILES, ...made.texts };
  for (const path of tracked) {
    // The local file is tracked but not in the work tree, so the folder holds no local file and counts as received.
    if (path === 'factory.yaml' || path === '.gitignore' || path === 'factory.local.yaml') continue;
    deps.seed(`${ROOT}/${path}`, texts[path] ?? `${path}\n`);
  }
  return { deps, log };
};

const snapshot = (deps: FakeDeps): string => JSON.stringify([[...deps.files.entries()].sort(), [...deps.dirs].sort()]);

const messageOf = (result: { ok: boolean; error?: { message: string; hint?: string } }): string =>
  `${result.error?.message ?? ''} ${result.error?.hint ?? ''}`;

const linesOf = (result: Awaited<ReturnType<typeof runInit>>): string =>
  result.ok ? result.value.lines.map((line) => line.text).join('\n') : '';

const indexOf = (deps: FakeDeps): { homes: { home: string; id: string; projects: string[]; origin?: string }[] } =>
  JSON.parse(deps.files.get(INDEX) ?? '{"homes":[]}') as never;

const acceptancesOf = (deps: FakeDeps): { root: string; node: string; file: string; hash: string; reason: string; manifest: ManifestEntry[] }[] =>
  (JSON.parse(deps.files.get(ACCEPTANCES) ?? '{"acceptances":[]}') as { acceptances: never[] }).acceptances;

const entryOf = (path: string, text: string): ManifestEntry => ({
  path,
  type: 'file',
  size: Buffer.byteLength(text, 'utf8'),
  sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  blob: null,
});

/** The hash that the setup text of the default root has. */
const SETUP_HASH = manifestHash(Object.entries(SETUP_FILES).map(([path, text]) => entryOf(path, text)));

const coordinatorText = (deps: FakeDeps): string => deps.files.get(`${ROOT}/coordinator/CLAUDE.md`) ?? '';

describe('init: a received factory (TP-29, TP-30)', () => {
  it('registers the root without the check for a new home, and writes only the files of this machine', async () => {
    const { deps, log } = received({}, terminal);
    const before = new Map(deps.files);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    for (const path of ['factory.yaml', '.gitignore', 'setup/coordinator.md', 'setup/roles/worker.md']) {
      expect(deps.files.get(`${ROOT}/${path}`)).toBe(before.get(`${ROOT}/${path}`));
    }
    expect(deps.files.has(`${ROOT}/factory.local.yaml`)).toBe(true);
    expect(deps.modes.get(`${ROOT}/factory.local.yaml`)).toBe(0o600);
    expect(deps.files.has(`${ROOT}/.factory/node.json`)).toBe(true);
    expect(coordinatorText(deps)).toContain('factory:');
    // The root repo is there already: init makes no repo and no commit in it.
    expect(log.calls.filter((call) => call.args[1] === ROOT && ['init', 'add', 'commit'].includes(call.args[2] ?? ''))).toEqual([]);
  });

  it('records the root with the origin received, also when an old entry of the folder says own', async () => {
    const { deps } = received({}, terminal);
    registerRoot(deps, ROOT, 'demo');
    const entries = JSON.parse(deps.files.get(INDEX) ?? '{}') as { homes: Record<string, unknown>[] };
    deps.seed(INDEX, JSON.stringify({ ...entries, homes: entries.homes.map((entry) => ({ ...entry, origin: 'own' })) }));
    deps.files.delete(`${ROOT}/.factory/node.json`);
    deps.dirs.delete(`${ROOT}/.factory`);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(indexOf(deps).homes).toEqual([{ home: ROOT, id: 'demo', projects: [`${ROOT}/web`], origin: 'received' }]);
  });

  it('asks only the owner fields and each approval point on a terminal window, and lists the repos before the first answer', async () => {
    const asked: string[] = [];
    const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'] }, { ...terminal, prompt: person('n', asked) });
    const result = await runInit(deps, options({ ownerName: undefined }));
    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain('Your name');
    expect(asked[0]).toContain('https://github.com/acme/web.git');
    expect(asked[1]).toContain('Your GitHub login');
    expect(asked[2]).toContain('Approval point merge');
    expect(asked[3]).toContain('Approval point release');
  });

  it('takes the answers for the owner fields into the local file', async () => {
    const answers = ['Dana Doe', 'dana-doe', '', ''];
    const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'] }, { ...terminal, prompt: () => ok(answers.shift() ?? '') });
    expect((await runInit(deps, options({ ownerName: undefined }))).ok).toBe(true);
    const local = deps.files.get(`${ROOT}/factory.local.yaml`) ?? '';
    expect(local).toContain('Dana Doe');
    expect(local).toContain('dana-doe');
  });

  it('asks for a name again after an answer that is not valid, and stops with exit 2 after three of them', async () => {
    const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'] }, { ...terminal, prompt: () => ok('x'.repeat(200)) });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ ownerName: undefined }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.prompts).toHaveLength(3);
    expect(snapshot(deps)).toBe(before);
  });

  it('writes nothing and exits 2 with no terminal window and no yes flag', async () => {
    const { deps } = received();
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('takes the owner defaults from the git identity with the yes flag, and asks nothing about them', async () => {
    const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'], fixture: { userName: 'Git Person', gh: 'git-person' } });
    expect((await runInit(deps, options({ yes: true, ownerName: undefined }))).ok).toBe(true);
    const local = deps.files.get(`${ROOT}/factory.local.yaml`) ?? '';
    expect(local).toContain('Git Person');
    expect(local).toContain('git-person');
    expect(deps.prompts).toEqual([]);
  });

  it('refuses a flag that names a value of a new root, with exit 2 and no file', async () => {
    const { deps } = received();
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true, layer: '2', projects: ['https://host/acme/api.git'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(messageOf(result)).toContain('--layer');
    expect(messageOf(result)).toContain('--project');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: a received factory in a factory session (TP-83)', () => {
  it.each([[true], [false]])('asks nothing, exits 4 and writes nothing, with the yes flag %s', async (yes) => {
    const { deps } = received({}, { ...terminal, env: { ...ENV, [env.session]: 'demo' }, prompt: () => ok('y') });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: what a received factory shows before the first clone (TP-140)', () => {
  it('lists each repo with its URL, the node id and the shared model, effort and limits, also with the yes flag', async () => {
    const { deps } = received({}, terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    const text = linesOf(result);
    expect(text).toContain('web: https://github.com/acme/web.git');
    expect(text).toContain('id: demo');
    expect(text).toContain('model default');
    expect(text).toContain('effort high');
    expect(text).toContain('context_max_pct 40');
  });

  it('warns when another root of the factory list has the same node id', async () => {
    const { deps } = received({}, terminal);
    registerRoot(deps, '/w/elsewhere', 'demo');
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.warnings.join('\n')).toContain('/w/elsewhere');
  });

  it('gives no warning for the root itself', async () => {
    const { deps } = received({}, terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.warnings).toEqual([]);
  });
});

describe('init: the files that a received root tracks (TP-86, TP-122, TP-124)', () => {
  it.each([
    ['the local file', 'factory.local.yaml'],
    ['a path in the state folder', '.factory/node.json'],
    ['a path in the coordinator folder', 'coordinator/CLAUDE.md'],
    ['a path in a project folder', 'web/CLAUDE.md'],
  ])('stops with exit 4, names the file and the remedy, and writes nothing, for %s', async (_name, path) => {
    const { deps } = received({ tracked: [...TRACKED_SETUP, path] }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(path);
    expect(messageOf(result)).toContain('git rm --cached');
    expect(snapshot(deps)).toBe(before);
  });

  it('compares the first part of a tracked path in the normal form of the folder key', async () => {
    const { deps } = received({ tracked: [...TRACKED_SETUP, 'Coordinator/CLAUDE.md'] }, terminal);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it.each([
    ['a folder', (deps: FakeDeps) => deps.seedDir(`${ROOT}/.factory`)],
    ['a file', (deps: FakeDeps) => deps.seed(`${ROOT}/.factory`, 'x')],
  ])('stops with exit 4 when the state path exists as %s, and changes nothing', async (_name, prepare) => {
    const { deps } = received({}, terminal);
    prepare(deps);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('.factory');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 when the state path is a link', async () => {
    const { deps } = received({}, { ...terminal, links: { [`${ROOT}/.factory`]: '/elsewhere' } });
    const before = snapshot(deps);
    expect(await runInit(deps, options({ yes: true }))).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('makes no git change in a state folder that is not the top of its own work tree, and undoes its work', async () => {
    const { handler, log } = gitHandler({ repos: { [ROOT]: {} }, tracked: { [ROOT]: TRACKED_SETUP } });
    // The command that makes the repo of the state folder works, but the folder is not a work tree of its own.
    const run: typeof handler = (call) => (call.args[2] === 'init' && call.args[1] !== ROOT ? exited(0) : handler(call));
    const deps = createFakeDeps({ cwd: ROOT, run, env: ENV, ...terminal });
    deps.seedDir(ROOT);
    deps.seed(`${ROOT}/factory.yaml`, renderConfig(sampleConfig()).shared);
    for (const [path, text] of Object.entries(SETUP_FILES)) deps.seed(`${ROOT}/${path}`, text);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('top folder of a git work tree');
    expect(log.commands().some((line) => line.startsWith('add ') || line.includes('commit'))).toBe(false);
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 when the folder is not the top of a git work tree', async () => {
    const { deps } = received({ fixture: { repos: {} } }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('top folder of a git work tree');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops when git cannot list the files, and never reads the failure as an empty list', async () => {
    const { deps } = received({ fixture: { lsFilesExit: 128 } }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('cannot list the tracked files');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: the ignore rules of a received root (TP-87)', () => {
  const ignoring = (ignored: readonly string[]) => ({ fixture: { ignored: { [ROOT]: ignored } } });
  const ALL = ['factory.local.yaml', '.factory/node.json', 'coordinator/CLAUDE.md', 'web/CLAUDE.md'];

  it.each([
    ['the local file', ALL.filter((path) => path !== 'factory.local.yaml'), 'factory.local.yaml'],
    ['the state folder', ALL.filter((path) => path !== '.factory/node.json'), '.factory/'],
  ])('stops with exit 4 and names the line to add when git does not ignore %s', async (_name, ignored, line) => {
    const { deps } = received(ignoring(ignored), terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(`"${line}"`);
    expect(messageOf(result)).toContain('.gitignore');
    expect(snapshot(deps)).toBe(before);
  });

  it('names both lines when git ignores neither', async () => {
    const { deps } = received(ignoring(['coordinator/CLAUDE.md']), terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(messageOf(result)).toContain('"factory.local.yaml"');
    expect(messageOf(result)).toContain('".factory/"');
  });

  it('only warns when git does not ignore the coordinator folder or a project folder', async () => {
    const { deps } = received(ignoring(['factory.local.yaml', '.factory/node.json']), terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    const warnings = result.ok ? result.value.warnings.join('\n') : '';
    expect(warnings).toContain('"coordinator/"');
    expect(warnings).toContain('"web/"');
  });

  it('stops when the ignore check fails, and never reads the failure as "ignored"', async () => {
    const { deps } = received({ fixture: { checkIgnoreExit: 128 } }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('cannot check the ignore rules');
    expect(snapshot(deps)).toBe(before);
  });
});

describe('init: links and caps in the tracked set of a received root (TP-164, TP-167)', () => {
  it.each([
    ['a tracked link named CLAUDE.md', 'CLAUDE.md', { [`${ROOT}/CLAUDE.md`]: '/elsewhere/file' }],
    ['a tracked link in place of a folder', 'docs/a.md', { [`${ROOT}/docs`]: '/elsewhere' }],
  ])('stops with exit 4 and writes nothing for %s', async (_name, path, links) => {
    const { deps } = received({ tracked: [...TRACKED_SETUP, path] }, { ...terminal, links });
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('is a link');
    expect(snapshot(deps)).toBe(before);
  });

  it('stops with exit 4 and one remedy line when the tracked list is over its cap by one', async () => {
    const many = Array.from({ length: trackedFiles.maxCount + 1 }, (_value, index) => `data/file-${index}.txt`);
    const { deps } = received({ tracked: [...TRACKED_SETUP, ...many.slice(0, trackedFiles.maxCount - TRACKED_SETUP.length + 1)] }, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain(String(trackedFiles.maxCount));
    expect(snapshot(deps)).toBe(before);
  });

  it('hashes every file when the tracked list is exactly at its cap', async () => {
    const extra = Array.from({ length: trackedFiles.maxCount - TRACKED_SETUP.length }, (_value, index) => `data/file-${index}.txt`);
    const set = trackedFiles.maxCount - 2;
    const { deps } = received({ tracked: [...TRACKED_SETUP, ...extra] }, { ...terminal, prompt: person('y') });
    const result = await runInit(deps, options());
    expect(result.ok).toBe(true);
    expect(acceptancesOf(deps)[0]?.manifest).toHaveLength(set);
  });

  it('stops with exit 4 and names the file when a tracked file is over the byte cap by one', async () => {
    const big = 'x'.repeat(trackedFiles.maxFileBytes + 1);
    const { deps } = received({ tracked: [...TRACKED_SETUP, 'data/big.bin'], texts: { 'data/big.bin': big } }, { ...terminal, prompt: person('y') });
    const before = snapshot(deps);
    const result = await runInit(deps, options());
    expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
    expect(messageOf(result)).toContain('data/big.bin');
    expect(deps.prompts).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('hashes a file that is exactly at the byte cap', async () => {
    const exact = 'x'.repeat(trackedFiles.maxFileBytes);
    const { deps } = received({ tracked: [...TRACKED_SETUP, 'data/big.bin'], texts: { 'data/big.bin': exact } }, { ...terminal, prompt: person('y') });
    expect((await runInit(deps, options())).ok).toBe(true);
    expect(acceptancesOf(deps)[0]?.manifest.map((entry) => entry.path)).toContain('data/big.bin');
  });
});

describe('init: the setup acceptance of a received root', () => {
  describe('the files of the set, listed before any write (TP-126, TP-156, TP-163, TP-182, TP-183)', () => {
    it('shows the setup text and its hash and asks, and with yes it renders the setup block and records the hash', async () => {
      const asked: string[] = [];
      const { deps } = received({}, { ...terminal, prompt: person('y', asked) });
      const result = await runInit(deps, options());
      expect(result.ok).toBe(true);
      const question = asked.find((text) => text.includes('Accept these files?')) ?? '';
      expect(question).toContain(COORDINATOR_TEXT.trim());
      expect(question).toContain(SETUP_HASH);
      expect(acceptancesOf(deps)).toEqual([expect.objectContaining({ root: ROOT, node: 'demo', hash: SETUP_HASH })]);
      expect(coordinatorText(deps)).toContain(COORDINATOR_TEXT.trim());
    });

    it('renders no setup block and names the accept command after a no, and writes no acceptance', async () => {
      const { deps } = received({}, { ...terminal, prompt: person('n') });
      const result = await runInit(deps, options());
      expect(result.ok).toBe(true);
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
      expect(coordinatorText(deps)).not.toContain(COORDINATOR_TEXT.trim());
      expect(linesOf(result)).toContain('factory init');
      expect(linesOf(result)).toContain('terminal window');
      expect(deps.files.has(`${ROOT}/.factory/node.json`)).toBe(true);
    });

    it('lists a tracked script in the setup folder before any write, and the manifest covers it', async () => {
      const asked: string[] = [];
      const tracked = [...TRACKED_SETUP, 'setup/check.sh'];
      const { deps } = received({ tracked, texts: { 'setup/check.sh': 'echo hi\n' } }, { ...terminal, prompt: person('y', asked) });
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      const question = asked.find((text) => text.includes('Accept these files?')) ?? '';
      expect(question).toContain('setup/check.sh');
      expect(question).toContain('echo hi');
      expect(acceptancesOf(deps)[0]?.manifest.map((entry) => entry.path)).toEqual([
        'setup/check.sh',
        'setup/coordinator.md',
        'setup/roles/worker.md',
      ]);
    });

    it('lists every tracked path apart from factory.yaml and the gitignore', async () => {
      const asked: string[] = [];
      const tracked = [...TRACKED_SETUP, 'CLAUDE.md', '.claude/settings.json', '.mcp.json'];
      const { deps } = received({ tracked }, { ...terminal, prompt: person('y', asked) });
      expect((await runInit(deps, options())).ok).toBe(true);
      const question = asked.find((text) => text.includes('Accept these files?')) ?? '';
      for (const path of ['CLAUDE.md', '.claude/settings.json', '.mcp.json']) expect(question).toContain(path);
      expect(question).not.toContain('---- factory.yaml');
      expect(question).not.toContain('---- .gitignore');
      expect(acceptancesOf(deps)[0]?.manifest).toHaveLength(5);
    });

    it('asks with yes on a terminal window, because yes never answers the prompt for listed files', async () => {
      const asked: string[] = [];
      const { deps } = received({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'] }, { ...terminal, prompt: person('y', asked) });
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(asked.filter((text) => text.includes('Accept these files?'))).toHaveLength(1);
    });

    it('writes no acceptance after a no on listed files, names the command, and renders no setup block', async () => {
      const { deps } = received({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'] }, { ...terminal, prompt: person('n') });
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
      expect(linesOf(result)).toContain('factory init');
      expect(coordinatorText(deps)).not.toContain(COORDINATOR_TEXT.trim());
    });

    it('asks for the listed files when the setup text is empty (TP-182)', async () => {
      const asked: string[] = [];
      const { deps } = received(
        { tracked: [...TRACKED_SETUP, 'CLAUDE.md'], texts: { 'setup/coordinator.md': '', 'setup/roles/worker.md': '\n' } },
        { ...terminal, prompt: person('n', asked) },
      );
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      const question = asked.find((text) => text.includes('Accept these files?')) ?? '';
      expect(question).toContain('CLAUDE.md');
      expect(question).not.toContain('---- setup/coordinator.md');
    });

    it('needs no acceptance when the set is empty', async () => {
      const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'] }, terminal);
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      expect(deps.prompts).toEqual([]);
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
    });

    it('needs no acceptance when the setup text is the only file and it is empty', async () => {
      const { deps } = received({ texts: { 'setup/coordinator.md': ' \n', 'setup/roles/worker.md': '' } }, terminal);
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
    });

    it('needs no question and renders the setup block when an acceptance matches already', async () => {
      const first = received({}, { ...terminal, prompt: person('y') });
      expect((await runInit(first.deps, options())).ok).toBe(true);
      const asked: string[] = [];
      const { deps } = received({}, { ...terminal, prompt: person('n', asked) });
      deps.seed(ACCEPTANCES, first.deps.files.get(ACCEPTANCES) ?? '');
      expect((await runInit(deps, options())).ok).toBe(true);
      expect(asked.some((question) => question.includes('Accept these files?'))).toBe(false);
      expect(coordinatorText(deps)).toContain(COORDINATOR_TEXT.trim());
    });
  });

  describe('with the yes flag and no terminal window (TP-127, TP-143, TP-157, TP-170)', () => {
    it('records the first acceptance of the setup text alone, and prints the files, the hash, the root, the node id and the reason', async () => {
      const { deps } = received();
      const result = await runInit(deps, options({ yes: true }));
      expect(result.ok).toBe(true);
      const record = acceptancesOf(deps)[0];
      expect(record).toMatchObject({ root: ROOT, node: 'demo', file: 'setup/coordinator.md', hash: SETUP_HASH });
      expect(record?.reason).toContain('yes');
      const text = linesOf(result);
      expect(text).toContain('setup/coordinator.md');
      expect(text).toContain(SETUP_HASH);
      expect(text).toContain(ROOT);
      expect(text).toContain('demo');
      expect(text).toContain(record?.reason ?? 'missing');
      expect(coordinatorText(deps)).toContain(COORDINATOR_TEXT.trim());
    });

    it('leaves the approval store unchanged', async () => {
      const { deps } = received();
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(deps.files.has(RECORDS)).toBe(false);
    });

    it('exits 4 before any write, also with yes, for a tracked instruction file, and names the command', async () => {
      const { deps } = received({ tracked: [...TRACKED_SETUP, 'CLAUDE.md'] });
      const before = snapshot(deps);
      const result = await runInit(deps, options({ yes: true }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('factory init');
      expect(messageOf(result)).toContain('terminal window');
      expect(snapshot(deps)).toBe(before);
    });

    it('exits 4 before any write after a change of the node id on a root with an older acceptance (TP-170)', async () => {
      const first = received();
      expect((await runInit(first.deps, options({ yes: true }))).ok).toBe(true);
      const older = first.deps.files.get(ACCEPTANCES) ?? '';
      // The same real root now holds the factory of another node id: the older acceptance is for the first id.
      const other = { ...sampleConfig(), core: { ...sampleConfig().core, node: { id: 'other', layer: 1 } } };
      const { deps } = received({ config: other });
      deps.seed(ACCEPTANCES, older);
      const before = snapshot(deps);
      const result = await runInit(deps, options({ yes: true }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'safety' } });
      expect(messageOf(result)).toContain('factory init');
      expect(messageOf(result)).toContain('terminal window');
      expect(deps.files.get(ACCEPTANCES)).toBe(older);
      expect(deps.files.has(INDEX)).toBe(false);
      expect(snapshot(deps)).toBe(before);
    });

    it('shows the older hash and the change on a terminal window, and records the change after a yes', async () => {
      const first = received();
      expect((await runInit(first.deps, options({ yes: true }))).ok).toBe(true);
      const other = { ...sampleConfig(), core: { ...sampleConfig().core, node: { id: 'other', layer: 1 } } };
      const asked: string[] = [];
      const { deps } = received({ config: other }, { ...terminal, prompt: person('y', asked) });
      deps.seed(ACCEPTANCES, first.deps.files.get(ACCEPTANCES) ?? '');
      expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
      expect(asked.find((text) => text.includes('Accept these files?'))).toContain(`accepted before: ${SETUP_HASH}`);
      expect(acceptancesOf(deps).map((record) => record.node).sort()).toEqual(['demo', 'other']);
    });
  });

  describe('the acceptance comes after the entry in the factory list', () => {
    it('writes no acceptance, and undoes the work, when the entry in the factory list fails', async () => {
      const { deps } = received({}, terminal);
      const before = snapshot(deps);
      const result = await runInit(withFailingWrites(deps, (path) => path === INDEX), options({ yes: true }));
      expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
      expect(deps.files.has(ACCEPTANCES)).toBe(false);
      expect(snapshot(deps)).toBe(before);
    });

    it('keeps the run when the acceptance cannot be written, and warns', async () => {
      const { deps } = received();
      const result = await runInit(withFailingWrites(deps, (path) => path === ACCEPTANCES), options({ yes: true }));
      expect(result.ok).toBe(true);
      expect(deps.files.has(`${ROOT}/factory.local.yaml`)).toBe(true);
    });
  });
});

describe('init: the projects of a received factory (TP-120)', () => {
  const withProjects = (...urls: (string | undefined)[]): FactoryConfig => {
    const config = sampleConfig();
    const base = config.recipe.projects[0]!;
    const projects = urls.map((url, index) => {
      const { url: _removed, ...rest } = base;
      return { ...rest, id: `p${index}`, path: `p${index}`, ...(url === undefined ? {} : { url }) };
    });
    return { ...config, recipe: { ...config.recipe, projects } };
  };

  it('clones a project with an https URL into the folder of its path', async () => {
    const { deps, log } = received({ config: withProjects('https://github.com/acme/api.git') }, terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([['clone', '--', 'https://github.com/acme/api.git', `${ROOT}/p0`]]);
  });

  it('clones a project with an ssh URL', async () => {
    const { deps, log } = received({ config: withProjects('git@github.com:acme/api.git') }, terminal);
    expect((await runInit(deps, options({ yes: true }))).ok).toBe(true);
    expect(log.clones()).toHaveLength(1);
  });

  it.each([
    ['no URL', undefined],
    ['a file URL', 'file:///src/api'],
    ['a bare path', '/src/api'],
  ])('skips the clone of a project with %s, warns and names the folder to fill', async (_name, url) => {
    const { deps, log } = received({ config: withProjects(url) }, terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok).toBe(true);
    expect(log.clones()).toEqual([]);
    expect(result.ok && result.value.warnings).toEqual([expect.stringContaining(`${ROOT}/p0`)]);
  });

  it('gives no warning for a project without a clone when its folder is there', async () => {
    const { deps } = received({ config: withProjects(undefined) }, terminal);
    deps.seedDir(`${ROOT}/p0`);
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.warnings).toEqual([]);
  });

  it('stops with exit 1 before any write when a folder exists and is not a clone of the repo', async () => {
    const { deps, log } = received({ config: withProjects('https://github.com/acme/api.git') }, terminal);
    deps.seedDir(`${ROOT}/p0`);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(log.clones()).toEqual([]);
    expect(snapshot(deps)).toBe(before);
  });

  it('removes the clones of this run when a later step fails', async () => {
    const { deps } = received({ config: withProjects('https://github.com/acme/api.git') }, terminal);
    const result = await runInit(withFailingWrites(deps, (path) => path === INDEX), options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(result.ok === false && result.error.message).toContain('Removed the clone');
  });

  it('lists the project folder that start then does not add, in the output of init', async () => {
    const { deps } = received({ config: withProjects(undefined) }, terminal);
    const result = await runInit(deps, options({ yes: true }));
    expect(linesOf(result)).toContain('p0: no URL');
  });
});

describe('init: the approval points of a received factory', () => {
  it('records a delegation that the owner sets, after the entry in the factory list', async () => {
    const { deps } = received({ tracked: ['.gitignore', 'factory.yaml'] }, { ...terminal, prompt: person('n') });
    const result = await runInit(deps, options({ approval: ['merge=delegated'] }));
    expect(result.ok).toBe(true);
    expect(deps.files.get(RECORDS)).toContain('delegated');
  });

  it('refuses delegated with the yes flag with exit 2, and writes nothing', async () => {
    const { deps } = received({}, terminal);
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true, approval: ['merge=delegated'] }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(snapshot(deps)).toBe(before);
  });

  it('writes owner for each point with the yes flag', async () => {
    const { deps } = received();
    const result = await runInit(deps, options({ yes: true }));
    expect(result.ok && result.value.json['approval']).toEqual({ merge: 'owner', release: 'owner' });
  });
});

describe('init: a folder that holds both config files and a local file that is not valid', () => {
  it('stops with exit 1, names the local file and writes nothing', async () => {
    const { deps } = received({}, terminal);
    deps.seed(`${ROOT}/factory.local.yaml`, 'schema: 1\n');
    const before = snapshot(deps);
    const result = await runInit(deps, options({ yes: true }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(messageOf(result)).toContain('factory.local.yaml');
    expect(snapshot(deps)).toBe(before);
  });
});
