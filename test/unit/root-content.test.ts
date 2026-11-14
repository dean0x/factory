import { describe, expect, it } from 'vitest';
import {
  checkFolderSettings,
  checkTrackedSettings,
  failsOnlyOnSetup,
  hasRootFailure,
  requireNoFailures,
  requireRootClean,
  rootCheckResults,
  rootNotices,
  scanRoot,
  scanSettings,
  scanTrackedTexts,
  warningLines,
  withSetupAccepted,
  type RootFinding,
  type RootScan,
} from '../../src/commands/root-content.js';
import { exitCodeOf, failure } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import {
  checkIds,
  claudeSettingKeys,
  env,
  files,
  permissionSkipList,
  program,
  statuslineKeyPath,
  trackedFiles,
  trafficEnvNames,
  values,
} from '../../src/names.js';
import type { ApprovalMode } from '../../src/recipes/index.js';
import { createFakeDeps, exited, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { ACCEPTANCES, acceptFiles, acceptTracked as acceptSet } from '../helpers/setup-acceptance.js';

const HOME = '/w/node';
const STATE_HOME = '/state';
const OWNER_RECORDS = '/state/factory/owner-records.json';
const [OWNER, DELEGATED] = values.approvalModes;

interface Setup {
  readonly origin?: 'own' | 'received' | null;
  readonly tracked?: readonly string[];
  /** The paths that git ignores. Default: git ignores every path. */
  readonly ignored?: readonly string[];
  readonly config?: FactoryConfig | null;
  readonly git?: GitFixture;
  readonly os?: string;
  readonly env?: Record<string, string | undefined>;
  readonly links?: Record<string, string>;
  readonly noRepo?: boolean;
}

const make = (setup: Setup = {}): FakeDeps => {
  const git = gitHandler({
    ...(setup.noRepo === true ? {} : { repos: { [HOME]: {} } }),
    tracked: { [HOME]: setup.tracked ?? [] },
    ...(setup.ignored === undefined ? {} : { ignored: { [HOME]: setup.ignored } }),
    ...setup.git,
  });
  const deps = createFakeDeps({
    env: { PATH: '/bin', XDG_STATE_HOME: STATE_HOME, HOME: '/users/example', ...setup.env },
    run: git.handler,
    ...(setup.os === undefined ? {} : { os: setup.os }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  const config = setup.config === undefined ? sampleConfig() : setup.config;
  seedConfig(deps, HOME, config ?? sampleConfig());
  deps.seedDir(`${HOME}/web`);
  const origin = setup.origin === undefined ? 'own' : setup.origin;
  registerRoot(deps, HOME, 'demo', [], origin === null ? undefined : origin);
  for (const path of setup.tracked ?? []) if (!deps.files.has(`${HOME}/${path}`)) deps.seed(`${HOME}/${path}`, 'text\n');
  return deps;
};

const scan = (deps: FakeDeps, config: FactoryConfig | null = sampleConfig()): Promise<RootScan> => scanRoot(deps, HOME, config);

const of = (found: RootScan, id: string): readonly RootFinding[] => found.findings.filter((finding) => finding.id === id);

const levelsOf = (found: RootScan, id: string): readonly string[] => of(found, id).map((finding) => finding.level);

const textOf = (found: RootScan, id: string): string => of(found, id).map((finding) => `${finding.text} ${finding.remedy}`).join(' | ');

/** The stop that `start` gives for the findings (its exit code and its text), or null when there is none. */
const stopOf = (found: RootScan): { readonly code: number; readonly message: string } | null => {
  const result = requireRootClean(found);
  return result.ok ? null : { code: exitCodeOf[result.error.kind], message: `${result.error.message} ${result.error.hint ?? ''}` };
};

interface Call {
  readonly method: string;
  readonly path: string;
}

/** Deps whose file system notes the method and every path argument of each call. */
const recorded = (deps: FakeDeps): { readonly guarded: FakeDeps; readonly calls: readonly Call[] } => {
  const calls: Call[] = [];
  const fs = new Proxy(deps.fs, {
    get: (target, key, receiver) => {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        for (const arg of args) if (typeof arg === 'string') calls.push({ method: String(key), path: arg });
        return member.apply(target, args);
      };
    },
  });
  return { guarded: { ...deps, fs }, calls };
};

const withConfig = (change: (config: FactoryConfig) => FactoryConfig): FactoryConfig => change(sampleConfig());

const withApproval = (approval: Record<string, ApprovalMode>): FactoryConfig =>
  withConfig((config) => ({ ...config, core: { ...config.core, approval: { ...config.core.approval, ...approval } } }));

/** The acceptance of the tracked set, as the store holds it. */
const acceptTracked = (deps: FakeDeps, tracked: readonly string[]): Promise<void> => acceptSet(deps, HOME, 'demo', tracked);

describe('a clean root', () => {
  it.each(['own', 'received'] as const)('has no finding on a %s root that tracks nothing', async (origin) => {
    const found = await scan(make({ origin }));
    expect(found.findings).toEqual([]);
    expect(found.origin).toBe(origin);
  });

  it('has no finding for the files that init writes and that a share list tracks', async () => {
    const tracked = ['.gitignore', 'factory.yaml'];
    const found = await scan(make({ origin: 'received', tracked }));
    expect(found.findings).toEqual([]);
  });

  it('takes the origin from the factory list: an entry with no origin, and a list that says nothing, count as received', async () => {
    expect((await scan(make({ origin: null }))).origin).toBe('received');
    const silent = { ...make({ origin: 'own' }), env: { PATH: '/bin' } };
    expect((await scanRoot(silent, HOME, sampleConfig())).origin).toBe('received');
  });
});

describe('root repo: tracked paths that must stay on this machine', () => {
  it.each(['own', 'received'] as const)('fails on a %s root when git tracks the local file', async (origin) => {
    const found = await scan(make({ origin, tracked: ['factory.local.yaml', 'factory.yaml'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toContain('fail');
    const text = textOf(found, checkIds.rootRepo);
    expect(text).toContain('factory.local.yaml');
    expect(text).toContain('git rm --cached');
  });

  it.each(['own', 'received'] as const)('fails on a %s root when git tracks a path under the state folder', async (origin) => {
    const found = await scan(make({ origin, tracked: ['.factory/node.json'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toContain('fail');
    expect(textOf(found, checkIds.rootRepo)).toContain('.factory/node.json');
  });

  it.each(['own', 'received'] as const)('fails on a %s root when git tracks a path under the coordinator folder', async (origin) => {
    const found = await scan(make({ origin, tracked: ['coordinator/CLAUDE.md'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toContain('fail');
    expect(textOf(found, checkIds.rootRepo)).toContain('coordinator/CLAUDE.md');
    expect(hasRootFailure(found)).toBe(true);
  });

  it('names at most five paths and counts the rest', async () => {
    const tracked = Array.from({ length: 8 }, (_value, index) => `coordinator/f${index}.md`);
    const text = textOf(await scan(make({ tracked })), checkIds.rootRepo);
    expect(text).toContain('coordinator/f0.md');
    expect(text).not.toContain('coordinator/f7.md');
    expect(text).toContain('and 3 more');
  });

  it('does not stop for a tracked path that has the name of a folder in the middle', async () => {
    const found = await scan(make({ tracked: ['docs/coordinator/a.md', 'notes/.factory/b.md'] }));
    expect(levelsOf(found, checkIds.rootRepo)).not.toContain('fail');
  });
});

describe('root repo: the project folders and the work copies folder', () => {
  it('warns on an own root when git tracks a path under a project folder, and names the path', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['web/src/a.ts'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain('web/src/a.ts');
  });

  it('fails on a received root when git tracks a path under a project folder', async () => {
    const found = await scan(make({ origin: 'received', tracked: ['web/src/a.ts'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toContain('fail');
    expect(textOf(found, checkIds.rootRepo)).toContain('web/src/a.ts');
    expect(textOf(found, checkIds.rootRepo)).toContain('git rm --cached');
  });

  it('warns on an own root when git tracks a path under the work copies folder', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['work-copies/a/file.ts'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain('work-copies/a/file.ts');
  });

  it('finds the project folder in any letter case', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['WEB/a.ts'] }));
    expect(textOf(found, checkIds.rootRepo)).toContain('WEB/a.ts');
  });

  it('does not look for project folders when the config is not valid', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['web/src/a.ts'], config: null }), null);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual([]);
  });
});

describe('root repo: the ignore rules', () => {
  const ALL = ['factory.local.yaml', '.factory/node.json', 'coordinator/CLAUDE.md', 'work-copies/probe', 'web/CLAUDE.md'];
  const withoutRule = (...missing: readonly string[]): readonly string[] => ALL.filter((path) => !missing.includes(path));

  it.each(['own', 'received'] as const)('fails on a %s root when git does not ignore the local file', async (origin) => {
    const found = await scan(make({ origin, ignored: withoutRule('factory.local.yaml') }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('factory.local.yaml');
    expect(textOf(found, checkIds.rootRepo)).toContain('.gitignore');
  });

  it('fails when git does not ignore the state folder, and names both when git ignores neither', async () => {
    const one = await scan(make({ ignored: withoutRule('.factory/node.json') }));
    expect(levelsOf(one, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(one, checkIds.rootRepo)).toContain('.factory/');
    const both = await scan(make({ ignored: withoutRule('.factory/node.json', 'factory.local.yaml') }));
    expect(of(both, checkIds.rootRepo)).toHaveLength(1);
    expect(textOf(both, checkIds.rootRepo)).toContain('factory.local.yaml and .factory/');
  });

  it.each([
    ['the coordinator folder', 'coordinator/CLAUDE.md', 'coordinator/'],
    ['the work copies folder', 'work-copies/probe', 'work-copies/'],
    ['a project folder', 'web/CLAUDE.md', 'web/'],
  ])('warns, and does not fail, when git does not ignore %s', async (_name, probe, shown) => {
    const found = await scan(make({ ignored: withoutRule(probe) }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain(shown);
    expect(textOf(found, checkIds.rootRepo)).toContain('.gitignore');
  });

  it('warns when git does not ignore a temp folder of a stopped init', async () => {
    const deps = make({ ignored: ALL });
    deps.seedDir(`${HOME}/.factory.tmp-4242`);
    const ignoredWithoutTemp = await scan(deps);
    expect(levelsOf(ignoredWithoutTemp, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(ignoredWithoutTemp, checkIds.rootRepo)).toContain('.factory.tmp-4242');
    const covered = make({ ignored: [...ALL, '.factory.tmp-4242/node.json'] });
    covered.seedDir(`${HOME}/.factory.tmp-4242`);
    expect((await scan(covered)).findings).toEqual([]);
  });

  it('does not say that git fails to ignore a path that git tracks: the tracked path is the problem', async () => {
    const found = await scan(make({ tracked: ['factory.local.yaml'], ignored: withoutRule('factory.local.yaml') }));
    expect(of(found, checkIds.rootRepo)).toHaveLength(1);
    expect(textOf(found, checkIds.rootRepo)).toContain('must stay on this machine');
  });

  it.each(['own', 'received'] as const)(
    'fails on a %s root, and names the command that fixes it, when git cannot answer for the local file or the state folder',
    async (origin) => {
      const found = await scan(make({ origin, git: { checkIgnoreFailsFor: ['factory.local.yaml'] } }));
      expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
      const stop = requireRootClean(found);
      if (stop.ok) throw new Error('expected a stop');
      expect(stop.error.kind).toBe('safety');
      expect(stop.error.hint).toContain('run "factory doctor"');
    },
  );

  it('fails when git cannot answer for the state folder, too', async () => {
    const found = await scan(make({ git: { checkIgnoreFailsFor: ['.factory/node.json'] } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });

  it('warns that it did not check, and does not stop, when git cannot answer for the advised folders only', async () => {
    const found = await scan(make({ git: { checkIgnoreFailsFor: ['coordinator/CLAUDE.md'] } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain('not checked');
    expect(requireRootClean(found).ok).toBe(true);
  });
});

describe('root repo: an instruction file or a settings path in the repo', () => {
  it.each(['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules/a.md', 'docs/CLAUDE.md', '.claude/settings.json'])(
    'warns on an own root for the tracked path %s, names it and says that it goes to every receiver',
    async (path) => {
      const found = await scan(make({ origin: 'own', tracked: [path] }));
      expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
      expect(textOf(found, checkIds.rootRepo)).toContain(path);
      expect(textOf(found, checkIds.rootRepo)).toContain('every receiver');
      expect(hasRootFailure(found)).toBe(false);
    },
  );

  it('does not warn for a path in a project folder: that case has its own warning', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['web/CLAUDE.md'] }));
    expect(textOf(found, checkIds.rootRepo)).not.toContain('every receiver');
  });

  it('gives no such warning on a received root: the acceptance covers the path', async () => {
    const deps = make({ origin: 'received', tracked: ['CLAUDE.md'] });
    await acceptTracked(deps, ['CLAUDE.md']);
    expect((await scan(deps)).findings).toEqual([]);
  });

  it('does not stop a start: the finding is a warning', async () => {
    const found = await scan(make({ tracked: ['AGENTS.md'] }));
    expect(requireRootClean(found).ok).toBe(true);
  });
});

describe('root repo: the files of a received root', () => {
  it('fails for a tracked file that no acceptance covers, and names the file and the command', async () => {
    const found = await scan(make({ origin: 'received', tracked: ['setup/coordinator.md', 'scripts/run.sh'] }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    const text = textOf(found, checkIds.rootRepo);
    expect(text).toContain('scripts/run.sh');
    expect(text).toContain('setup/coordinator.md');
    expect(text).toContain('factory init');
    expect(text).toContain('terminal window');
  });

  it('is ok once the owner accepted the tracked files', async () => {
    const tracked = ['setup/coordinator.md', 'scripts/run.sh', 'factory.yaml', '.gitignore'];
    const deps = make({ origin: 'received', tracked });
    await acceptTracked(deps, tracked);
    expect((await scan(deps)).findings).toEqual([]);
  });

  it('fails for a file that changed after the acceptance, and names the changed file only', async () => {
    const tracked = ['setup/coordinator.md', 'scripts/run.sh'];
    const deps = make({ origin: 'received', tracked });
    await acceptTracked(deps, tracked);
    deps.seed(`${HOME}/scripts/run.sh`, 'changed text\n');
    const text = textOf(await scan(deps), checkIds.rootRepo);
    expect(text).toContain('scripts/run.sh');
    expect(text).not.toContain('setup/coordinator.md');
  });

  it('fails for a file that was added after the acceptance, and for one that was removed', async () => {
    const deps = make({ origin: 'received', tracked: ['setup/coordinator.md', 'scripts/run.sh'] });
    await acceptTracked(deps, ['setup/coordinator.md', 'scripts/run.sh']);
    deps.seed(`${HOME}/scripts/new.sh`, 'new\n');
    const added = make({ origin: 'received', tracked: ['setup/coordinator.md', 'scripts/run.sh', 'scripts/new.sh'] });
    added.files.set(ACCEPTANCES, deps.files.get(ACCEPTANCES) ?? '');
    expect(textOf(await scan(added), checkIds.rootRepo)).toContain('scripts/new.sh');
    const removed = make({ origin: 'received', tracked: ['setup/coordinator.md'] });
    removed.files.set(ACCEPTANCES, deps.files.get(ACCEPTANCES) ?? '');
    const found = await scan(removed);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('scripts/run.sh');
  });

  it('fails for an acceptance of another node id and for an acceptance of another folder', async () => {
    const tracked = ['scripts/run.sh'];
    const deps = make({ origin: 'received', tracked });
    await acceptTracked(deps, tracked);
    const record = JSON.parse(deps.files.get(ACCEPTANCES) ?? '{}');
    deps.seed(ACCEPTANCES, JSON.stringify({ schema: 1, acceptances: [{ ...record.acceptances[0], node: 'other' }] }));
    expect(levelsOf(await scan(deps), checkIds.rootRepo)).toEqual(['fail']);
    deps.seed(ACCEPTANCES, JSON.stringify({ schema: 1, acceptances: [{ ...record.acceptances[0], root: '/w/other' }] }));
    expect(levelsOf(await scan(deps), checkIds.rootRepo)).toEqual(['fail']);
  });

  it('does not let an empty setup file skip the acceptance of the other files', async () => {
    const deps = make({ origin: 'received', tracked: ['setup/coordinator.md', 'scripts/run.sh'] });
    deps.seed(`${HOME}/setup/coordinator.md`, '\n');
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('scripts/run.sh');
  });

  it('asks for nothing when the tracked set is empty or holds an empty setup file only', async () => {
    const deps = make({ origin: 'received', tracked: ['setup/coordinator.md'] });
    deps.seed(`${HOME}/setup/coordinator.md`, '');
    expect((await scan(deps)).findings).toEqual([]);
  });

  it('fails when the store of the acceptances cannot be used', async () => {
    const deps = make({ origin: 'received', tracked: ['scripts/run.sh'] });
    deps.seed(ACCEPTANCES, 'not json');
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('cannot be used');
  });

  it('asks for no acceptance of the listed files on an own root', async () => {
    const found = await scan(make({ origin: 'own', tracked: ['scripts/run.sh', 'factory.yaml'] }));
    expect(found.findings).toEqual([]);
    expect(found.setup).toEqual({ kind: 'empty' });
    expect(found.setupFinding).toBeNull();
  });

  it('fails when the config is not valid and the set is not empty: the acceptance can not be matched', async () => {
    const found = await scan(make({ origin: 'received', tracked: ['scripts/run.sh'], config: null }), null);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('factory.yaml is not valid');
  });

  it('fails for a tracked link in the set, also with an acceptance', async () => {
    const deps = make({
      origin: 'received',
      tracked: ['setup/coordinator.md', 'scripts/run.sh'],
      links: { [`${HOME}/scripts/run.sh`]: '/elsewhere/run.sh' },
    });
    deps.seed('/elsewhere/run.sh', 'text\n');
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('scripts/run.sh is a link');
  });

  it('fails when the list of tracked files is at its cap, and names the cap', async () => {
    const tracked = Array.from({ length: trackedFiles.maxCount + 1 }, (_value, index) => `docs/f${index}.md`);
    const found = await scan(make({ origin: 'received', tracked }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain(String(trackedFiles.maxCount));
  });

  it('fails when a file is over its byte cap, and hashes no part of it', async () => {
    const deps = make({ origin: 'received', tracked: ['docs/big.md'] });
    deps.seed(`${HOME}/docs/big.md`, 'a'.repeat(trackedFiles.maxFileBytes + 1));
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootRepo)).toContain('fail');
    expect(textOf(found, checkIds.rootRepo)).toContain('docs/big.md');
  });

  it('shows a control character in a path as an escape', async () => {
    const deps = make({ origin: 'received', tracked: ['scripts/a\u001bb.sh'] });
    const text = textOf(await scan(deps), checkIds.rootRepo);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('\\x1b');
  });
});

describe('root repo: the setup text of an own root', () => {
  const SETUP_PATH = 'setup/coordinator.md';
  const SETUP_FILE = `${HOME}/${SETUP_PATH}`;
  const INIT_COMMAND = 'Run "factory init" in a terminal window and accept the files.';
  const ACCEPT_COMMAND = 'Run "factory start" or "factory upgrade" in a terminal window outside a factory session.';

  it('fails for a setup text with no acceptance at all, names the file and the command that makes the first acceptance', async () => {
    const deps = make({ origin: 'own' });
    deps.seed(SETUP_FILE, 'Rules.\n');
    const found = await scan(deps);
    expect(of(found, checkIds.rootRepo)).toEqual([
      { id: checkIds.rootRepo, level: 'fail', text: `the owner has not accepted the setup text: ${SETUP_PATH}`, remedy: INIT_COMMAND },
    ]);
    expect(found.setup.kind).toBe('unaccepted');
    expect(found.setupFinding).toBe(of(found, checkIds.rootRepo)[0]);
  });

  it('reads the setup text whether git tracks it or not', async () => {
    const tracked = make({ origin: 'own', tracked: [SETUP_PATH] });
    tracked.seed(SETUP_FILE, 'Rules.\n');
    const loose = make({ origin: 'own' });
    loose.seed(SETUP_FILE, 'Rules.\n');
    for (const deps of [tracked, loose]) expect(levelsOf(await scan(deps), checkIds.rootRepo)).toEqual(['fail']);
  });

  it('has no finding once the owner accepted the text, and gives the accepted texts', async () => {
    const deps = make({ origin: 'own' });
    deps.seed(SETUP_FILE, 'Rules.\n');
    await acceptFiles(deps, HOME, 'demo', [SETUP_PATH]);
    const found = await scan(deps);
    expect(found.findings).toEqual([]);
    expect(found.setup.kind === 'accepted' && found.setup.setup.texts).toEqual({ coordinator: 'Rules.\n', worker: null });
  });

  it('fails for a change after an older acceptance, and names the accept command', async () => {
    const deps = make({ origin: 'own' });
    deps.seed(SETUP_FILE, 'Rules.\n');
    await acceptFiles(deps, HOME, 'demo', [SETUP_PATH]);
    deps.seed(SETUP_FILE, 'Other rules.\n');
    const found = await scan(deps);
    expect(of(found, checkIds.rootRepo)).toEqual([
      { id: checkIds.rootRepo, level: 'fail', text: `the setup text changed since the owner accepted it: ${SETUP_PATH}`, remedy: ACCEPT_COMMAND },
    ]);
    expect(found.setup.kind).toBe('changed');
  });

  it('asks for nothing when the setup file holds only white space', async () => {
    const deps = make({ origin: 'own' });
    deps.seed(SETUP_FILE, ' \n');
    expect((await scan(deps)).findings).toEqual([]);
  });

  it('fails when the config is not valid and a setup file is there: the acceptance can not be matched', async () => {
    const deps = make({ origin: 'own', config: null });
    deps.seed(SETUP_FILE, 'Rules.\n');
    const found = await scan(deps, null);
    expect(textOf(found, checkIds.rootRepo)).toContain('factory.yaml is not valid');
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });

  it('stops a start with the accept command, and with the first-acceptance command when nothing was accepted', async () => {
    const deps = make({ origin: 'own' });
    deps.seed(SETUP_FILE, 'Rules.\n');
    const none = requireRootClean(await scan(deps));
    expect(none).toMatchObject({ ok: false, error: { kind: 'safety', hint: INIT_COMMAND } });
    await acceptFiles(deps, HOME, 'demo', [SETUP_PATH]);
    deps.seed(SETUP_FILE, 'Other rules.\n');
    expect(requireRootClean(await scan(deps))).toMatchObject({ ok: false, error: { kind: 'safety', hint: ACCEPT_COMMAND } });
  });

  it('stops for a link at the setup file (exit 4)', async () => {
    const links: Record<string, string> = {};
    const deps = make({ origin: 'own', links });
    deps.seed(SETUP_FILE, 'Rules.\n');
    links[SETUP_FILE] = '/elsewhere/coordinator.md';
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain(`${SETUP_PATH} is a link`);
  });

  describe('failsOnlyOnSetup and withSetupAccepted', () => {
    const changed = async (extra: Partial<Setup> = {}): Promise<FakeDeps> => {
      const deps = make({ origin: 'own', ...extra });
      deps.seed(SETUP_FILE, 'Rules.\n');
      await acceptFiles(deps, HOME, 'demo', [SETUP_PATH]);
      deps.seed(SETUP_FILE, 'Other rules.\n');
      return deps;
    };

    it('is true when the setup text is the only failure, and false for a root with no failure', async () => {
      expect(failsOnlyOnSetup(await scan(await changed()))).toBe(true);
      expect(failsOnlyOnSetup(await scan(make({ origin: 'own' })))).toBe(false);
    });

    it('is false when another check fails as well, so no question is asked', async () => {
      const deps = await changed({ tracked: ['factory.local.yaml'] });
      const found = await scan(deps);
      expect(found.setup.kind).toBe('changed');
      expect(failsOnlyOnSetup(found)).toBe(false);
    });

    it('is false for a warning only', async () => {
      const deps = make({ origin: 'own', tracked: ['AGENTS.md'] });
      expect(failsOnlyOnSetup(await scan(deps))).toBe(false);
    });

    it('takes only the stop for the setup text away', async () => {
      const found = await scan(await changed());
      const accepted = withSetupAccepted(found);
      expect(accepted.findings).toEqual([]);
      expect(accepted.setupFinding).toBeNull();
      expect(accepted.setup.kind).toBe('accepted');
      expect(requireRootClean(accepted).ok).toBe(true);
      const other = await scan(await changed({ tracked: ['factory.local.yaml'] }));
      expect(requireRootClean(withSetupAccepted(other)).ok).toBe(false);
    });
  });
});

describe('root repo: git can not list the files', () => {
  it('warns on an own root that it did not check, and does not fail', async () => {
    const found = await scan(make({ origin: 'own', noRepo: true }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain('not checked');
  });

  it('fails on a received root: a trust boundary with no list is no boundary', async () => {
    const found = await scan(make({ origin: 'received', noRepo: true }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(textOf(found, checkIds.rootRepo)).toContain('cannot list');
  });

  it('treats a folder that is inside the work tree of another repo as not listed', async () => {
    const found = await scan(make({ origin: 'received', git: { repos: { [HOME]: { topLevel: false } } } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });

  it('fails on a received root when the command of git fails', async () => {
    const found = await scan(make({ origin: 'received', git: { lsFilesExit: 1 } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });

  it('fails on an own root when the command of git fails, and names the command that fixes it', async () => {
    const found = await scan(make({ origin: 'own', git: { lsFilesExit: 1 } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    const stop = requireRootClean(found);
    if (stop.ok) throw new Error('expected a stop');
    expect(stop.error.hint).toContain('run "factory doctor"');
  });

  it.each([
    ['holds more files than the cap', {}, Array.from({ length: trackedFiles.maxCount + 1 }, (_value, index) => `docs/f${index}.md`)],
    ['gives more output than the program reads', { lsFilesOverflow: true }, []],
  ] as const)('fails on an own root when the list of tracked files %s, and names the command that fixes it', async (_name, git, tracked) => {
    const found = await scan(make({ origin: 'own', tracked, git }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual([]);
    const stop = requireRootClean(found);
    if (stop.ok) throw new Error('expected a stop');
    expect(stop.error.kind).toBe('safety');
    expect(stop.error.hint).toContain('git rm --cached');
    expect(stop.error.hint).toContain('run "factory doctor"');
  });

  it('fails on a received root when the output of git is larger than the program reads', async () => {
    const found = await scan(make({ origin: 'received', git: { lsFilesOverflow: true } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });
});

describe('root files: tokens', () => {
  it.each(['own', 'received'] as const)('fails on a %s root for a tracked text file with a token, and never shows the value', async (origin) => {
    const deps = make({ origin, tracked: ['docs/notes.md'] });
    deps.seed(`${HOME}/docs/notes.md`, `The key is ${FAKE_GITHUB_TOKEN} for now.\n`);
    if (origin === 'received') await acceptTracked(deps, ['docs/notes.md']);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual(['fail']);
    const text = textOf(found, checkIds.rootFiles);
    expect(text).toContain('docs/notes.md');
    expect(text).not.toContain(FAKE_GITHUB_TOKEN);
    expect(text).not.toContain('ghp_');
    expect(text).toContain('factory.local.yaml');
    expect(requireRootClean(found).ok).toBe(false);
  });

  it('is ok for a tracked text file with plain prose and paths', async () => {
    const deps = make({ tracked: ['docs/notes.md'] });
    deps.seed(`${HOME}/docs/notes.md`, 'Plain words.\nSee /var/folders/zz/c0d1e2f3g4h5j6k7m8n9p0q10000gn/T/Work/payments-team-factory-2.\n');
    expect(of(await scan(deps), checkIds.rootFiles)).toEqual([]);
  });

  it('scans the tracked config file, too', async () => {
    const deps = make({ tracked: ['factory.yaml'] });
    deps.seed(`${HOME}/factory.yaml`, `owner_token: ${FAKE_GITHUB_TOKEN}\n`);
    expect(levelsOf(await scan(deps), checkIds.rootFiles)).toEqual(['fail']);
  });

  it('names every file with a token, in the order of the list', async () => {
    const deps = make({ tracked: ['a.md', 'b.md', 'c.md'] });
    deps.seed(`${HOME}/a.md`, FAKE_GITHUB_TOKEN);
    deps.seed(`${HOME}/c.md`, FAKE_GITHUB_TOKEN);
    const text = textOf(await scan(deps), checkIds.rootFiles);
    expect(text.indexOf('a.md')).toBeLessThan(text.indexOf('c.md'));
    expect(text).not.toContain('b.md');
  });

  it('does not scan a file that is not text, and names it as not scanned', async () => {
    const deps = make({ tracked: ['bin/data'] });
    deps.seed(`${HOME}/bin/data`, `\u0000${FAKE_GITHUB_TOKEN}`);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootFiles)).toContain('bin/data (binary or UTF-16)');
    expect(textOf(found, checkIds.rootFiles)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  it('names a file in UTF-16 as not scanned', async () => {
    const deps = make({ tracked: ['docs/.env.txt'] });
    deps.seed(`${HOME}/docs/.env.txt`, Array.from(`token: ${FAKE_GITHUB_TOKEN}`).join('\u0000'));
    expect(textOf(await scan(deps), checkIds.rootFiles)).toContain('docs/.env.txt (binary or UTF-16)');
  });

  it('skips a tracked path that is not on disk', async () => {
    const deps = make({ tracked: ['gone.md'] });
    deps.files.delete(`${HOME}/gone.md`);
    expect(of(await scan(deps), checkIds.rootFiles)).toEqual([]);
  });

  it('does not read a tracked link, and names it as not scanned', async () => {
    const deps = make({ tracked: ['notes.md'], links: { [`${HOME}/notes.md`]: '/elsewhere/notes.md' } });
    deps.seed('/elsewhere/notes.md', FAKE_GITHUB_TOKEN);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootFiles)).toContain('notes.md (a link)');
  });
});

describe('root files: the caps of the token scan', () => {
  const CAPS = { maxCount: 2, maxFileBytes: 40 };

  it('stops at its cap of tracked files and names the files that it did not scan', async () => {
    const deps = make({ tracked: ['a.md', 'b.md', 'c.md', 'd.md'] });
    deps.seed(`${HOME}/c.md`, FAKE_GITHUB_TOKEN);
    const findings = await scanTrackedTexts(deps, HOME, ['a.md', 'b.md', 'c.md', 'd.md'], CAPS);
    expect(findings.map((finding) => finding.level)).toEqual(['warn']);
    expect(findings[0]?.text).toContain('c.md');
    expect(findings[0]?.text).toContain('d.md');
    expect(findings[0]?.text).not.toContain('a.md');
  });

  it('stops at its cap of bytes for each file and names the file that it did not read', async () => {
    const deps = make({ tracked: ['a.md', 'big.md'] });
    deps.seed(`${HOME}/big.md`, `${'x '.repeat(30)}${FAKE_GITHUB_TOKEN}`);
    const findings = await scanTrackedTexts(deps, HOME, ['a.md', 'big.md'], CAPS);
    expect(findings.map((finding) => finding.level)).toEqual(['warn']);
    expect(findings[0]?.text).toContain('big.md (more than 40 bytes)');
  });

  it('still reports a token in a file that it read', async () => {
    const deps = make({ tracked: ['a.md', 'b.md', 'c.md'] });
    deps.seed(`${HOME}/a.md`, FAKE_GITHUB_TOKEN);
    const findings = await scanTrackedTexts(deps, HOME, ['a.md', 'b.md', 'c.md'], { maxCount: 2, maxFileBytes: 100 });
    expect(findings.map((finding) => finding.level).sort()).toEqual(['fail', 'warn']);
  });

  it('names at most five files that it did not scan, and counts the rest', async () => {
    const paths = Array.from({ length: 12 }, (_value, index) => `f${index}.md`);
    const deps = make({ tracked: paths });
    const findings = await scanTrackedTexts(deps, HOME, paths, { maxCount: 2, maxFileBytes: 100 });
    expect(findings[0]?.text).toContain('f2.md');
    expect(findings[0]?.text).not.toContain('f9.md');
    expect(findings[0]?.text).toContain('and 5 more');
  });

  it('reads no file of a list at its cap: the stop of the list is the only finding', async () => {
    const tracked = Array.from({ length: trackedFiles.maxCount + 3 }, (_value, index) => `docs/f${index}.md`);
    const deps = make({ origin: 'own', tracked });
    deps.seed(`${HOME}/docs/f0.md`, FAKE_GITHUB_TOKEN);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual([]);
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['fail']);
  });

  it('reads no file when the list is empty', async () => {
    const deps = make();
    expect(await scanTrackedTexts(deps, HOME, [], CAPS)).toEqual([]);
  });
});

describe('root files: file URLs and user folder paths', () => {
  it.each([
    ['a file URL', 'url: file:///srv/repos/web.git\n'],
    ['a folder of a user on macOS', 'path: /Users/example/Sandbox/web\n'],
    ['a folder of a user on Linux', 'path: /home/example/work/web\n'],
    ['a folder of a user on Windows', 'path: C:\\Users\\example\\work\\web\n'],
  ])('warns for %s in a tracked file, and names the file', async (_name, text) => {
    const deps = make({ tracked: ['docs/setup.md'] });
    deps.seed(`${HOME}/docs/setup.md`, text);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.rootFiles)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootFiles)).toContain('docs/setup.md');
    expect(requireRootClean(found).ok).toBe(true);
  });

  it.each([
    ['a relative path', 'path: ../web\n'],
    ['a URL that a host serves', 'url: https://github.com/acme/web.git\n'],
    ['a path in a folder that is no user folder', 'path: /srv/home/web\n'],
    ['the word home in prose', 'Go home and use /homebrew later.\n'],
  ])('is quiet for %s', async (_name, text) => {
    const deps = make({ tracked: ['docs/setup.md'] });
    deps.seed(`${HOME}/docs/setup.md`, text);
    expect(of(await scan(deps), checkIds.rootFiles)).toEqual([]);
  });

  it('names a file once when it holds both', async () => {
    const deps = make({ tracked: ['docs/setup.md'] });
    deps.seed(`${HOME}/docs/setup.md`, 'a: file:///x\nb: /Users/example/x\n');
    expect(of(await scan(deps), checkIds.rootFiles)).toHaveLength(1);
  });
});

describe('project paths', () => {
  const REAL = '/elsewhere/web';

  it('is ok for a project folder inside the root, and for a folder that does not exist', async () => {
    expect((await scan(make())).findings).toEqual([]);
    const missing = make();
    missing.dirs.delete(`${HOME}/web`);
    expect((await scan(missing)).findings).toEqual([]);
  });

  it('fails for a project folder that is a link to a folder outside the root', async () => {
    const deps = make({ links: { [`${HOME}/web`]: REAL } });
    deps.seedDir(REAL);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['fail']);
    expect(textOf(found, checkIds.projectPaths)).toContain('web');
    expect(textOf(found, checkIds.projectPaths)).toContain('outside');
  });

  it('fails for a project folder that is a link to the root itself', async () => {
    const found = await scan(make({ links: { [`${HOME}/web`]: HOME } }));
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['fail']);
    expect(textOf(found, checkIds.projectPaths)).toContain('the factory folder itself');
  });

  it.each(['coordinator', 'work-copies', 'setup', '.factory'])('fails for a project folder that is a link into %s', async (reserved) => {
    const deps = make({ links: { [`${HOME}/web`]: `${HOME}/${reserved}/inner` } });
    deps.seedDir(`${HOME}/${reserved}/inner`);
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['fail']);
    expect(textOf(found, checkIds.projectPaths)).toContain(reserved);
  });

  it('fails for a link into a reserved folder in other letter case', async () => {
    const deps = make({ links: { [`${HOME}/web`]: `${HOME}/Coordinator/inner` } });
    deps.seedDir(`${HOME}/Coordinator/inner`);
    expect(levelsOf(await scan(deps), checkIds.projectPaths)).toEqual(['fail']);
  });

  it('is ok for a project folder that is a link to another folder inside the root', async () => {
    const deps = make({ links: { [`${HOME}/web`]: `${HOME}/repos/web` } });
    deps.seedDir(`${HOME}/repos/web`);
    expect(of(await scan(deps), checkIds.projectPaths)).toEqual([]);
  });

  it('compares the letters of the root in the way of the platform', async () => {
    const deps = make({ os: 'darwin', links: { [`${HOME}/web`]: '/W/Node/repos/web' } });
    deps.seedDir('/W/Node/repos/web');
    expect(of(await scan(deps), checkIds.projectPaths)).toEqual([]);
    const linux = make({ os: 'linux', links: { [`${HOME}/web`]: '/W/Node/repos/web' } });
    linux.seedDir('/W/Node/repos/web');
    expect(levelsOf(await scan(linux), checkIds.projectPaths)).toEqual(['fail']);
  });

  it('fails for a project path that is not one folder name, with the reason', async () => {
    const config = withConfig((base) => ({
      ...base,
      recipe: { ...base.recipe, projects: [{ ...(base.recipe.projects[0] ?? ({} as never)), path: '../escape' }] },
    }));
    const found = await scan(make({ config }), config);
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['fail']);
    expect(textOf(found, checkIds.projectPaths)).toContain('one folder name');
  });

  it('names the project and its path', async () => {
    const deps = make({ links: { [`${HOME}/web`]: HOME } });
    expect(textOf(await scan(deps), checkIds.projectPaths)).toContain('project web');
  });

  it('warns that it did not check when the real path of the root can not be read', async () => {
    const deps = make();
    const denied = { ...deps, fs: { ...deps.fs, realpath: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'cannot resolve: EACCES' } }) } };
    const found = await scanRoot(denied, HOME, sampleConfig());
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['warn']);
    expect(textOf(found, checkIds.projectPaths)).toContain('EACCES');
  });

  it('is not checked when the config is not valid', async () => {
    const found = await scan(make({ config: null }), null);
    expect(levelsOf(found, checkIds.projectPaths)).toEqual(['warn']);
    expect(textOf(found, checkIds.projectPaths)).toContain('not checked');
  });
});

describe('settings files', () => {
  const SETTINGS = '/.claude/settings.local.json';
  const PLACES = [
    ['the coordinator folder', 'coordinator', 'coordinator/.claude/settings.local.json'],
    ['a project folder', 'web', 'web/.claude/settings.local.json'],
    ['the factory folder itself', '', '.claude/settings.local.json'],
  ] as const;

  const put = (deps: FakeDeps, folder: string, text: string): string => {
    const path = `${HOME}${folder === '' ? '' : `/${folder}`}${SETTINGS}`;
    deps.seed(path, text);
    return path;
  };

  const skipJson = (index: number): string => {
    const item = permissionSkipList[index];
    if (item === undefined) throw new Error('no such item');
    if (item.kind === 'text') return JSON.stringify({ hooks: { note: `claude ${item.text}` } });
    return JSON.stringify([...item.path].reverse().reduce<unknown>((inner, key) => ({ [key]: inner }), item.value));
  };

  describe.each(PLACES)('in %s', (_name, folder, shown) => {
    it.each(permissionSkipList.map((item, index) => [item.label, index] as const))('fails for %s', async (label, index) => {
      const deps = make();
      put(deps, folder, skipJson(index));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(textOf(found, checkIds.permissionMode)).toContain(shown);
      expect(textOf(found, checkIds.permissionMode)).toContain(label);
      expect(requireRootClean(found).ok).toBe(false);
    });

    it.each([env.session, env.home, 'FACTORY_ANYTHING'])(
      'fails for a file that sets or clears %s, names the prefix and gives one remedy line',
      async (name) => {
        const deps = make();
        put(deps, folder, JSON.stringify({ env: { [name]: '' } }));
        const found = await scan(deps);
        const stop = of(found, checkIds.permissionMode).find((finding) => finding.level === 'fail');
        expect(stop?.text).toContain(shown);
        expect(stop?.text).toContain(env.factoryPrefix);
        expect(stop?.remedy).not.toContain('\n');
        expect(requireRootClean(found).ok).toBe(false);
      },
    );

    it('is ok for a file with safe settings', async () => {
      const deps = make();
      put(deps, folder, JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' }, env: { OTHER: '1' } }));
      expect(levelsOf(await scan(deps), checkIds.permissionMode)).not.toContain('fail');
    });

    it('does not fail for a file that turns off every hook: only a work copy must keep its hooks', async () => {
      const deps = make();
      put(deps, folder, JSON.stringify({ [claudeSettingKeys.disableAllHooks]: true }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
      expect(requireRootClean(found).ok).toBe(true);
    });

    it.each([env.stateHome, env.userHome])(
      'does not fail for a file that sets %s in its env values: only a work copy must keep its hooks',
      async (name) => {
        const deps = make();
        put(deps, folder, JSON.stringify({ env: { [name]: '/elsewhere' } }));
        const found = await scan(deps);
        expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
        expect(requireRootClean(found).ok).toBe(true);
      },
    );
  });

  it.each([
    ['the coordinator folder', 'coordinator'],
    ['a project folder', 'web'],
  ])('warns that a settings file is in %s, and names it', async (_name, folder) => {
    const deps = make();
    const path = put(deps, folder, '{}');
    const found = await scan(deps);
    expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
    expect(textOf(found, checkIds.permissionMode)).toContain(path.replace(`${HOME}/`, ''));
    expect(requireRootClean(found).ok).toBe(true);
  });

  it('does not warn for a settings file in the factory folder itself: init and start write the hook there', async () => {
    const deps = make();
    put(deps, '', '{}');
    expect(of(await scan(deps), checkIds.permissionMode)).toEqual([]);
  });

  describe('the settings file that the program writes', () => {
    const OWN = ownSettingsEntries;
    const ownText = JSON.stringify(OWN, null, 2);
    const withHooks = (hooks: unknown): string => JSON.stringify({ ...OWN, hooks });
    const eventNames = Object.keys(OWN.hooks);
    const firstEvent = eventNames[0] ?? '';
    const otherEvent = eventNames[1] ?? '';

    it.each(PLACES.filter(([, folder]) => folder !== ''))('gives no warning in %s for a file with only the own entries', async (_name, folder) => {
      const deps = make();
      put(deps, folder, ownText);
      const found = await scan(deps);
      expect(of(found, checkIds.permissionMode)).toEqual([]);
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('gives no warning when the file writes the same entries in another key order and layout', async () => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify({ statusLine: OWN.statusLine, hooks: OWN.hooks }));
      expect(of(await scan(deps), checkIds.permissionMode)).toEqual([]);
    });

    it.each([
      ['a setting of the model', { model: 'sonnet' }],
      ['a permission rule', { permissions: { allow: [] } }],
      ['an env value', { env: { OTHER: '1' } }],
      ['an unknown key with an empty object', { note: {} }],
    ])('warns for one extra key: %s', async (_name, extra) => {
      const deps = make();
      const path = put(deps, 'coordinator', JSON.stringify({ ...OWN, ...extra }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain(path.replace(`${HOME}/`, ''));
      expect(textOf(found, checkIds.permissionMode)).toContain('is a settings file in the coordinator folder');
    });

    it.each([
      ['an event that the program does not use', { ...OWN.hooks, PostToolUse: OWN.hooks[firstEvent] ?? [] }],
      ['a second group of an event', { ...OWN.hooks, [firstEvent]: [...(OWN.hooks[firstEvent] ?? []), ...(OWN.hooks[firstEvent] ?? [])] }],
      ['an own event that is missing', Object.fromEntries(Object.entries(OWN.hooks).filter(([event]) => event !== firstEvent))],
    ])('warns for the hooks with %s', async (_name, hooks) => {
      const deps = make();
      put(deps, 'coordinator', withHooks(hooks));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain('is a settings file in the coordinator folder');
    });

    it.each([
      ['a status line with another own command', { ...OWN, statusLine: { type: 'command', command: `${program} hook ${firstEvent}` } }],
      ['a status line with another program', { ...OWN, statusLine: { type: 'command', command: 'echo hi' } }],
      ['a status line of another type', { ...OWN, statusLine: { type: 'prompt', command: OWN.statusLine.command } }],
      ['a status line with an extra key', { ...OWN, statusLine: { ...OWN.statusLine, padding: 2 } }],
      [
        'a hook with the command of another event',
        { ...OWN, hooks: { ...OWN.hooks, [firstEvent]: [{ hooks: [{ type: 'command', command: `${program} hook ${otherEvent}` }] }] } },
      ],
      [
        'a hook with another program',
        { ...OWN, hooks: { ...OWN.hooks, [firstEvent]: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      ],
    ])('warns for an own key with %s', async (_name, value) => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify(value));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('warn');
      expect(textOf(found, checkIds.permissionMode)).toContain('is a settings file in the coordinator folder');
    });

    it('warns for a file that is not valid JSON, also when the own entries are in it', async () => {
      const deps = make();
      put(deps, 'coordinator', `${ownText},`);
      const found = await scan(deps);
      expect(textOf(found, checkIds.permissionMode)).toContain('is a settings file in the coordinator folder');
      expect(textOf(found, checkIds.permissionMode)).toContain('not valid JSON');
    });

    it('warns for a file that repeats a key, because a parser may keep the first value', async () => {
      const deps = make();
      const repeated = ownText.replace('{', '{"statusLine": {"type": "command", "command": "echo hi"},');
      put(deps, 'coordinator', repeated);
      const found = await scan(deps);
      expect(textOf(found, checkIds.permissionMode)).toContain('is a settings file in the coordinator folder');
    });

    it('keeps every failure for a file with the own entries and a skip setting', async () => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify({ ...OWN, permissions: { defaultMode: 'bypassPermissions' } }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(requireRootClean(found).ok).toBe(false);
    });
  });

  describe('the check of one session folder', () => {
    const FOLDER = `${HOME}/work-copies/web-a`;
    const FILE = `${FOLDER}/.claude/settings.local.json`;
    const check = (deps: FakeDeps) => checkFolderSettings(deps, HOME, FOLDER, 'a work copy');

    it('gives the failure for a skip setting, names the file below the root, and keeps the remedy', async () => {
      const deps = make();
      deps.seed(FILE, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
      const found = await check(deps);
      const stop = found.find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain('work-copies/web-a/.claude/settings.local.json');
      expect(stop?.text).toContain('skips the permission checks');
      expect(stop?.remedy).toContain('run "factory doctor"');
    });

    it('gives the warning for a settings file in the folder, and nothing for the entries of the program', async () => {
      const deps = make();
      deps.seed(FILE, JSON.stringify({ model: 'sonnet' }));
      const warned = await check(deps);
      expect(warned.map((entry) => entry.level)).toEqual(['warn']);
      expect(warned[0]?.text).toContain('is a settings file in a work copy');
      deps.seed(FILE, JSON.stringify(ownSettingsEntries, null, 2));
      expect(await check(deps)).toEqual([]);
    });

    it('gives nothing for a folder with no settings folder, and a failure for a linked settings folder', async () => {
      const deps = make();
      deps.seedDir(FOLDER);
      expect(await check(deps)).toEqual([]);
      const linked = make({ links: { [`${FOLDER}/.claude`]: '/elsewhere/claude' } });
      linked.seedDir(FOLDER);
      linked.seedDir('/elsewhere/claude');
      const found = await check(linked);
      expect(found.map((entry) => entry.level)).toEqual(['fail']);
      expect(found[0]?.text).toContain('is a link');
    });

    it('gives a failure for a settings file that can not be read', async () => {
      const deps = make();
      deps.seed(FILE, '{}');
      const readTextLimited: FakeDeps['fs']['readTextLimited'] = async (path, max) =>
        path === FILE ? failure(`cannot read ${path}: EACCES`) : deps.fs.readTextLimited(path, max);
      const found = await checkFolderSettings({ ...deps, fs: { ...deps.fs, readTextLimited } }, HOME, FOLDER, 'a work copy');
      expect(found.map((entry) => entry.level)).toEqual(['fail']);
      expect(found[0]?.text).toContain('did not read');
    });

    it('gives a failure for a file that turns off every hook, names the file and the effect, and gives one remedy line', async () => {
      const deps = make();
      deps.seed(FILE, JSON.stringify({ [claudeSettingKeys.disableAllHooks]: true }));
      const found = await check(deps);
      const stop = found.find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain('work-copies/web-a/.claude/settings.local.json');
      expect(stop?.text).toContain(claudeSettingKeys.disableAllHooks);
      expect(stop?.text).toContain('gets no role text');
      expect(stop?.remedy).toContain('Remove the setting');
      expect(stop?.remedy).not.toContain('\n');
      expect(requireNoFailures(found).ok).toBe(false);
    });

    it('gives a failure for a project settings file that turns off every hook', async () => {
      const deps = make();
      deps.seed(`${FOLDER}/.claude/settings.json`, '// kept by the project\n{"disableAllHooks": true}');
      const found = await check(deps);
      expect(found.some((entry) => entry.level === 'fail' && entry.text.includes('work-copies/web-a/.claude/settings.json'))).toBe(true);
    });

    it.each([env.stateHome, env.userHome])(
      'gives a failure for a file that sets %s in its env values, names the file, the variable and the effect, and gives one remedy line',
      async (name) => {
        const deps = make();
        deps.seed(FILE, JSON.stringify({ env: { [name]: '/elsewhere' } }));
        const found = await check(deps);
        const stop = found.find((entry) => entry.level === 'fail');
        expect(stop?.text).toContain('work-copies/web-a/.claude/settings.local.json');
        expect(stop?.text).toContain(name);
        expect(stop?.text).toContain('gets no role text');
        expect(stop?.remedy).toContain('Remove the setting');
        expect(stop?.remedy).not.toContain('\n');
        expect(requireNoFailures(found).ok).toBe(false);
      },
    );

    it('gives a failure for a project settings file that sets the state folder in a file that is not valid JSON', async () => {
      const deps = make();
      deps.seed(`${FOLDER}/.claude/settings.json`, `// kept by the project\n{"env": {"${env.stateHome}": "/elsewhere"},`);
      const found = await check(deps);
      expect(found.some((entry) => entry.level === 'fail' && entry.text.includes('gets no role text'))).toBe(true);
    });

    it('gives no failure for a file whose env values set other variables', async () => {
      const deps = make();
      deps.seed(FILE, JSON.stringify({ env: { OTHER: '1', [`${env.userHome}_BASE`]: '/x' } }));
      expect(requireNoFailures(await check(deps)).ok).toBe(true);
    });

    it('gives no failure for a file that sets the hooks setting to false', async () => {
      const deps = make();
      deps.seed(FILE, JSON.stringify({ [claudeSettingKeys.disableAllHooks]: false }));
      expect(requireNoFailures(await check(deps)).ok).toBe(true);
    });
  });

  describe('the check of the settings that the last commit of a clone tracks', () => {
    const FOLDER = { path: `${HOME}/work-copies/web-a`, presence: 'a work copy' };
    const hex = (index: number): string => index.toString(16).padStart(40, '0');

    /** Deps whose git holds the given files below `.claude` in its last commit. */
    const commit = (settings: Readonly<Record<string, string>>): FakeDeps => {
      const entries = Object.entries(settings);
      return createFakeDeps({
        run: (call) => {
          if (call.args[2] === 'cat-file') {
            const found = entries.find((_entry, index) => hex(index + 1) === call.args[4]);
            return found === undefined ? exited(128, '', 'fatal: Not a valid object name\n') : exited(0, found[1]);
          }
          if (call.args[2] !== 'ls-tree') return exited(1);
          if (call.args.at(-1) === '.claude') return exited(0, `040000 tree ${hex(0)}       -\t.claude\0`);
          return exited(
            0,
            entries.map(([name, text], index) => `100644 blob ${hex(index + 1)} ${String(text.length).padStart(7)}\t.claude/${name}\0`).join(''),
          );
        },
      });
    };

    const tracked = async (settings: Readonly<Record<string, string>>) => {
      const result = await checkTrackedSettings(commit(settings), HOME, '/w/node/clones/web', FOLDER);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    it('gives a failure for a tracked file that turns off every hook, and names the file and the effect', async () => {
      const found = await tracked({ 'settings.local.json': JSON.stringify({ [claudeSettingKeys.disableAllHooks]: true }) });
      const stop = found.findings.find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain('work-copies/web-a/.claude/settings.local.json');
      expect(stop?.text).toContain(claudeSettingKeys.disableAllHooks);
      expect(stop?.text).toContain('gets no role text');
      expect(requireNoFailures(found.findings).ok).toBe(false);
    });

    it('checks every tracked settings file, not only the local one', async () => {
      const found = await tracked({ 'settings.json': '{"disableAllHooks": true}' });
      expect(found.findings.some((entry) => entry.level === 'fail' && entry.text.includes('.claude/settings.json'))).toBe(true);
    });

    it('gives a failure for a tracked file that sets the state folder or the home folder in its env values', async () => {
      const found = await tracked({ 'settings.local.json': JSON.stringify({ env: { [env.stateHome]: '/elsewhere' } }) });
      const stop = found.findings.find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain('work-copies/web-a/.claude/settings.local.json');
      expect(stop?.text).toContain(env.stateHome);
      expect(stop?.text).toContain('gets no role text');
      expect(requireNoFailures(found.findings).ok).toBe(false);
    });

    it('gives no failure for tracked files that keep the hooks on', async () => {
      const found = await tracked({ 'settings.json': JSON.stringify({ [claudeSettingKeys.disableAllHooks]: false }) });
      expect(requireNoFailures(found.findings).ok).toBe(true);
    });
  });

  describe('the stop and the lines of a list of findings', () => {
    const entry = (level: 'warn' | 'fail', text: string, remedy = ''): RootFinding => ({ id: 'permission-mode', level, text, remedy });

    it('gives no stop for an empty list or a list of warnings', () => {
      expect(requireNoFailures([]).ok).toBe(true);
      expect(requireNoFailures([entry('warn', 'a warning', 'Do x.')]).ok).toBe(true);
    });

    it('stops with exit 4 on a failure, names at most three failures, and joins the distinct remedies once', () => {
      const stop = requireNoFailures([
        entry('fail', 'one', 'Fix it.'),
        entry('warn', 'not named'),
        entry('fail', 'two', 'Fix it.'),
        entry('fail', 'three', 'Fix that.'),
        entry('fail', 'four'),
      ]);
      expect(stop).toMatchObject({
        ok: false,
        error: { kind: 'safety', message: 'one; two; three and 1 more', hint: 'Fix it. Fix that.' },
      });
    });

    it('gives the same stop as the stop of the root checks', async () => {
      const findings = [entry('fail', 'one', 'Fix it.')];
      const found = { ...(await scan(make())), findings };
      expect(requireRootClean(found)).toEqual(requireNoFailures(findings));
    });

    it('gives one line for each warning, with its remedy, and none for a failure', () => {
      expect(warningLines([entry('warn', 'one', 'Do x.'), entry('fail', 'two', 'Do y.'), entry('warn', 'three')])).toEqual([
        'one. Do x.',
        'three.',
      ]);
    });
  });

  it('checks the files settings.json and settings.local.json and ignores other files of the folder', async () => {
    const deps = make();
    deps.seed(`${HOME}/coordinator/.claude/settings.json`, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    deps.seed(`${HOME}/coordinator/.claude/notes.txt`, 'dangerously-skip-permissions');
    const text = textOf(await scan(deps), checkIds.permissionMode);
    expect(text).toContain('coordinator/.claude/settings.json');
    expect(text).not.toContain('notes.txt');
  });

  describe('a rule that covers a whole tool, and the other warnings', () => {
    it.each([['Bash'], ['Bash(*)'], ['*']])('warns for the allow rule %s, names the file and the rule, and does not stop', async (rule) => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify({ permissions: { allow: [rule] } }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
      const text = textOf(found, checkIds.permissionMode);
      expect(text).toContain('coordinator/.claude/settings.local.json');
      expect(text).toContain(`${rule}`);
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('warns for an allow rule of the lock run command like a rule for a whole tool, and does not stop', async () => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify({ permissions: { allow: ['Bash(factory lock run:*)'] } }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
      const text = textOf(found, checkIds.permissionMode);
      expect(text).toContain('allows every use of');
      expect(text).toContain('Bash(factory lock run:*)');
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('warns for a narrower allow rule, and names the rule', async () => {
      const deps = make();
      put(deps, 'web', JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
      const text = textOf(await scan(deps), checkIds.permissionMode);
      expect(text).toContain('Bash(npm test)');
    });

    it('warns for the mode acceptEdits', async () => {
      const deps = make();
      put(deps, 'coordinator', JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
      const found = await scan(deps);
      expect(textOf(found, checkIds.permissionMode)).toContain('acceptEdits');
      expect(requireRootClean(found).ok).toBe(true);
    });

    describe('the settings that hold or refuse the input of other sessions', () => {
      const SEEN = 'project and local settings only';

      it.each([['hold'], ['refuse']])('warns for crossSessionInbound %s, names the file and the value, and does not stop', async (value) => {
        const deps = make();
        put(deps, 'web', JSON.stringify({ [claudeSettingKeys.crossSessionInbound]: value }));
        const found = await scan(deps);
        expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
        const text = textOf(found, checkIds.permissionMode);
        expect(text).toContain('web/.claude/settings.local.json');
        expect(text).toContain(`${claudeSettingKeys.crossSessionInbound} to ${value}`);
        expect(text).toContain(SEEN);
        expect(requireRootClean(found).ok).toBe(true);
      });

      it.each([
        ['accept', { [claudeSettingKeys.crossSessionInbound]: 'accept' }],
        ['a value that is no mode', { [claudeSettingKeys.crossSessionInbound]: 'other' }],
        ['a value that is no text', { [claudeSettingKeys.crossSessionInbound]: true }],
        ['no setting', {}],
      ])('gives no warning for %s', async (_name, settings) => {
        const deps = make();
        put(deps, 'web', JSON.stringify(settings));
        const text = textOf(await scan(deps), checkIds.permissionMode);
        expect(text).not.toContain(claudeSettingKeys.crossSessionInbound);
        expect(text).not.toContain(SEEN);
      });

      it('warns for the default mode plan, names the file, and does not stop', async () => {
        const deps = make();
        put(deps, 'coordinator', JSON.stringify({ permissions: { defaultMode: 'plan' } }));
        const found = await scan(deps);
        expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
        const text = textOf(found, checkIds.permissionMode);
        expect(text).toContain('coordinator/.claude/settings.local.json');
        expect(text).toContain('default mode plan');
        expect(text).toContain(SEEN);
        expect(requireRootClean(found).ok).toBe(true);
      });

      it('gives no warning for the default mode default', async () => {
        const deps = make();
        put(deps, 'coordinator', JSON.stringify({ permissions: { defaultMode: 'default' } }));
        const text = textOf(await scan(deps), checkIds.permissionMode);
        expect(text).not.toContain('default mode');
        expect(text).not.toContain(SEEN);
      });
    });

    it.each([
      [claudeSettingKeys.approveAllMcp, true],
      [claudeSettingKeys.approveMcpList, ['db']],
    ])('warns for the setting %s, names the file and the setting, and does not stop', async (setting, value) => {
      const deps = make();
      put(deps, 'web', JSON.stringify({ [setting]: value }));
      const found = await scan(deps);
      const text = textOf(found, checkIds.permissionMode);
      expect(text).toContain('web/.claude/settings.local.json');
      expect(text).toContain(setting);
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('warns for a rule in the factory folder itself, too', async () => {
      const deps = make();
      put(deps, '', JSON.stringify({ permissions: { allow: ['Bash'] } }));
      expect(textOf(await scan(deps), checkIds.permissionMode)).toContain('.claude/settings.local.json');
    });

    it('cuts the rules that it shows', async () => {
      const deps = make();
      put(deps, 'web', JSON.stringify({ permissions: { allow: Array.from({ length: 50 }, (_value, index) => `Bash(cmd${index})`) } }));
      const text = textOf(await scan(deps), checkIds.permissionMode);
      expect(text).toContain('Bash(cmd0)');
      expect(text).not.toContain('Bash(cmd49)');
    });
  });

  describe('the proxy and the credential of the session, and the settings that run a command', () => {
    const hooksOf = (command: string): unknown => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });

    describe.each(PLACES)('in %s', (_name, folder, shown) => {
      it.each(trafficEnvNames.map((name) => [name] as const))('fails for %s in the env values, with one remedy line', async (name) => {
        const deps = make();
        put(deps, folder, JSON.stringify({ env: { [name]: 'x' } }));
        const found = await scan(deps);
        const stop = of(found, checkIds.permissionMode).find((entry) => entry.level === 'fail');
        expect(stop?.text).toContain(shown);
        expect(stop?.text).toContain(name);
        expect(stop?.remedy).toContain('run "factory doctor"');
        expect(requireRootClean(found).ok).toBe(false);
      });

      it('does not count the hook and the status line that the program writes', async () => {
        const deps = make();
        put(deps, folder, JSON.stringify({ hooks: hooksOf(`${program} hook stop`), statusLine: { type: 'command', command: `${program} hook statusline` } }));
        const text = textOf(await scan(deps), checkIds.permissionMode);
        expect(text).not.toContain('run a command');
        expect(requireRootClean(await scan(deps)).ok).toBe(true);
      });
    });

    it.each([
      ['the coordinator folder', 'coordinator', 'coordinator/.claude/settings.local.json'],
      ['a project folder', 'web', 'web/.claude/settings.local.json'],
    ] as const)('fails in %s for a setting that runs a command, and names the setting and the file', async (_name, folder, shown) => {
      const deps = make();
      put(deps, folder, JSON.stringify({ hooks: hooksOf('echo hi'), apiKeyHelper: './key.sh' }));
      const found = await scan(deps);
      const stop = of(found, checkIds.permissionMode).find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain(shown);
      expect(stop?.text).toContain('hooks');
      expect(stop?.text).toContain('apiKeyHelper');
      expect(stop?.remedy).toContain(`Remove the setting from ${shown}`);
      expect(stop?.remedy).not.toContain(statuslineKeyPath);
      expect(requireRootClean(found).ok).toBe(false);
    });

    it.each([
      ['the coordinator folder', 'coordinator', 'coordinator/.claude/settings.local.json'],
      ['a project folder', 'web', 'web/.claude/settings.local.json'],
    ] as const)('fails in %s for a status line that the program did not write, and tells the owner to check the command before the key that keeps it', async (_name, folder, shown) => {
      const deps = make();
      put(deps, folder, JSON.stringify({ statusLine: { type: 'command', command: 'echo kept' } }));
      const found = await scan(deps);
      const stop = of(found, checkIds.permissionMode).find((entry) => entry.level === 'fail');
      expect(stop?.text).toContain(shown);
      expect(stop?.remedy).toContain(`Remove the setting from ${shown}`);
      expect(stop?.remedy).toContain(`Check the status line command first. If you trust it, set ${statuslineKeyPath}`);
      expect(stop?.remedy).toContain(files.localConfig);
      expect(stop?.remedy.split('\n')).toHaveLength(1);
      expect(requireRootClean(found).ok).toBe(false);
    });

    it('warns, and does not stop, in the factory folder itself for a setting that runs a command', async () => {
      const deps = make();
      put(deps, '', JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain('.claude/settings.local.json');
      expect(textOf(found, checkIds.permissionMode)).toContain('statusLine');
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('warns, and does not stop, for a tracked settings path of the root that runs a command', async () => {
      const deps = make({ tracked: ['tools/.claude/settings.json'] });
      deps.seed(`${HOME}/tools/.claude/settings.json`, JSON.stringify({ hooks: hooksOf('echo hi') }));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(requireRootClean(found).ok).toBe(true);
    });

    it('says in the ok text of the check what it looked for', async () => {
      const text = rootCheckResults(await scan(make())).find((entry) => entry.id === checkIds.permissionMode)?.text ?? '';
      expect(text).toContain('runs a command');
      expect(text).toContain('proxy or the credential');
    });
  });

  describe('the tracked settings paths of the root, at any depth', () => {
    const bypass = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });

    it.each(['.claude/settings.json', 'tools/deep/.claude/settings.local.json', 'a/b/.claude/settings.team.json'])(
      'fails on an own root for the tracked path %s with a setting that skips permission prompts',
      async (path) => {
        const deps = make({ origin: 'own', tracked: [path] });
        deps.seed(`${HOME}/${path}`, bypass);
        const found = await scan(deps);
        expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
        expect(textOf(found, checkIds.permissionMode)).toContain(path);
        expect(requireRootClean(found).ok).toBe(false);
      },
    );

    it('fails on a received root, also after the owner accepted the files', async () => {
      const path = 'tools/.claude/settings.json';
      const deps = make({ origin: 'received', tracked: [path] });
      deps.seed(`${HOME}/${path}`, bypass);
      await acceptTracked(deps, [path]);
      const found = await scan(deps);
      expect(of(found, checkIds.rootRepo)).toEqual([]);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(requireRootClean(found).ok).toBe(false);
    });

    it('fails on a tracked path for the session marker', async () => {
      const deps = make({ tracked: ['x/.claude/settings.json'] });
      deps.seed(`${HOME}/x/.claude/settings.json`, JSON.stringify({ env: { [env.session]: '' } }));
      expect(levelsOf(await scan(deps), checkIds.permissionMode)).toContain('fail');
    });

    it('reads a tracked settings file once when a folder check lists it, too', async () => {
      const deps = make({ tracked: ['web/.claude/settings.local.json'] });
      deps.seed(`${HOME}/web/.claude/settings.local.json`, bypass);
      const found = await scan(deps);
      expect(of(found, checkIds.permissionMode).filter((finding) => finding.level === 'fail')).toHaveLength(1);
    });
  });

  describe('a file that can not be used', () => {
    it('fails, names the file and the command that fixes it, when a settings file can not be read', async () => {
      const deps = make();
      put(deps, '', '{}');
      deps.seed(`${HOME}/.claude/settings.json`, '{}');
      const readTextLimited: FakeDeps['fs']['readTextLimited'] = async (path, max) =>
        path.endsWith('settings.local.json')
          ? { ok: false, error: { kind: 'failure', message: `cannot read ${path}: EACCES` } }
          : deps.fs.readTextLimited(path, max);
      const found = await scanRoot({ ...deps, fs: { ...deps.fs, readTextLimited } }, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['fail']);
      expect(textOf(found, checkIds.permissionMode)).toContain('.claude/settings.local.json');
      expect(textOf(found, checkIds.permissionMode)).not.toContain('.claude/settings.json');
      const stop = requireRootClean(found);
      if (stop.ok) throw new Error('expected a stop');
      expect(stop.error.hint).toContain('run "factory doctor"');
    });

    it('fails when a tracked settings path can not be read, and when it is a link', async () => {
      const path = 'tools/.claude/settings.json';
      const deps = make({ tracked: [path, 'x/.claude/settings.json'], links: { [`${HOME}/x/.claude/settings.json`]: '/elsewhere/s.json' } });
      deps.seed('/elsewhere/s.json', '{}');
      const lstat: FakeDeps['fs']['lstat'] = async (target) =>
        target === `${HOME}/${path}` ? failure('cannot stat: EACCES') : deps.fs.lstat(target);
      const found = await scanRoot({ ...deps, fs: { ...deps.fs, lstat } }, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['fail']);
      expect(textOf(found, checkIds.permissionMode)).toContain(path);
      expect(textOf(found, checkIds.permissionMode)).toContain('x/.claude/settings.json (a link)');
    });

    it('fails when a folder holds more settings files than the check reads, and names the command that fixes it', async () => {
      const deps = make();
      for (let index = 0; index < 65; index += 1) deps.seed(`${HOME}/coordinator/.claude/settings.${String(index).padStart(2, '0')}.json`, '{}');
      const found = await scan(deps);
      const stops = of(found, checkIds.permissionMode).filter((entry) => entry.level === 'fail');
      expect(stops).toHaveLength(1);
      expect(stops[0]?.text).toContain('coordinator/.claude');
      expect(stops[0]?.text).toContain('more than 64 settings files');
      expect(stops[0]?.remedy).toContain('run "factory doctor"');
      expect(requireRootClean(found).ok).toBe(false);
    });

    it('does not fail for a folder that holds as many settings files as the check reads', async () => {
      const deps = make();
      for (let index = 0; index < 64; index += 1) deps.seed(`${HOME}/coordinator/.claude/settings.${String(index).padStart(2, '0')}.json`, '{}');
      expect(levelsOf(await scan(deps), checkIds.permissionMode)).not.toContain('fail');
    });

    it('fails for a file that skips the checks, even when another file can not be read', async () => {
      const deps = make();
      deps.seed(`${HOME}/.claude/settings.json`, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
      put(deps, '', '{}');
      const readTextLimited: FakeDeps['fs']['readTextLimited'] = async (path, max) =>
        path.endsWith('settings.local.json')
          ? { ok: false, error: { kind: 'failure', message: `cannot read ${path}: EACCES` } }
          : deps.fs.readTextLimited(path, max);
      const found = await scanRoot({ ...deps, fs: { ...deps.fs, readTextLimited } }, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
    });

    it('reads a file up to the cap of bytes only, and fails for a larger one', async () => {
      const deps = make();
      put(deps, 'web', ' '.repeat(trackedFiles.maxFileBytes + 1));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(textOf(found, checkIds.permissionMode)).toContain('web/.claude/settings.local.json');
      expect(requireRootClean(found).ok).toBe(false);
    });

    it('warns that a file is not valid JSON, and still fails for a skip setting in it', async () => {
      const deps = make();
      put(deps, 'web', '{"skipDangerousModePermissionPrompt": true,');
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      const quiet = make();
      put(quiet, 'web', '{ not json');
      expect(textOf(await scan(quiet), checkIds.permissionMode)).toContain('not valid JSON');
      expect(levelsOf(await scan(quiet), checkIds.permissionMode)).not.toContain('fail');
    });

    it('stops with exit 4 and names the command when it can not tell whether a settings folder exists', async () => {
      const deps = make();
      const denied = { ...deps, fs: { ...deps.fs, lstat: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'cannot stat: EACCES' } }) } };
      const found = await scanRoot(denied, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(textOf(found, checkIds.permissionMode)).toContain('EACCES');
      expect(textOf(found, checkIds.permissionMode)).toContain('factory doctor');
      expect(stopOf(found)?.code).toBe(4);
    });

    it('stops with exit 4 and names the command when a settings folder can not be listed', async () => {
      const deps = make();
      deps.seedDir(`${HOME}/web/.claude`);
      const denied = { ...deps, fs: { ...deps.fs, list: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'cannot list: EACCES' } }) } };
      const found = await scanRoot(denied, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toContain('fail');
      expect(textOf(found, checkIds.permissionMode)).toContain('EACCES');
      expect(textOf(found, checkIds.permissionMode)).toContain('factory doctor');
      expect(stopOf(found)?.code).toBe(4);
    });

    it('stops with exit 4 and reads nothing when a settings file is a link', async () => {
      const deps = make({ links: { [`${HOME}/web/.claude/settings.json`]: `${HOME}/elsewhere.json` } });
      deps.seed(`${HOME}/web/.claude/settings.json`, '{}');
      const { guarded, calls } = recorded(deps);
      const found = await scanRoot(guarded, HOME, sampleConfig());
      expect(textOf(found, checkIds.permissionMode)).toContain('web/.claude/settings.json (a link)');
      expect(textOf(found, checkIds.permissionMode)).toContain('factory doctor');
      expect(stopOf(found)?.code).toBe(4);
      expect(calls.filter((call) => call.path === `${HOME}/web/.claude/settings.json` && call.method !== 'lstat')).toEqual([]);
    });
  });

  describe('the user settings folder of Claude Code is never read', () => {
    const USER = '/users/example';
    const BYPASS = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });

    /** The calls with a path that is the user settings folder or inside it, by the way the path is written. */
    const underUser = (calls: readonly Call[], user: string): readonly Call[] =>
      calls.filter((call) => call.path.toLowerCase() === user.toLowerCase() || call.path.toLowerCase().startsWith(`${user.toLowerCase()}/`));

    /** The settings scan alone, with a file system that notes every call. */
    const settingsScan = async (deps: FakeDeps, projects: readonly string[] = ['web'], tracked: readonly string[] = [], root = HOME) => {
      const { guarded, calls } = recorded(deps);
      const findings = await scanSettings(guarded, root, projects, tracked);
      return { findings, calls };
    };

    it('makes no call and gives no finding when a project folder is the user home folder', async () => {
      const userHome = `${HOME}/web`;
      const deps = make({ env: { HOME: userHome } });
      deps.seed(`${userHome}/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps);
      expect(findings).toEqual([]);
      expect(underUser(calls, `${userHome}/.claude`)).toEqual([]);
    });

    it('makes no call and gives no finding when the root is the user home folder', async () => {
      const deps = make({ env: { HOME: HOME } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps);
      expect(findings).toEqual([]);
      expect(underUser(calls, `${HOME}/.claude`)).toEqual([]);
    });

    it('stops with exit 4 and follows no link when a settings folder is a link to a folder in the test home', async () => {
      const deps = make({ env: { HOME: USER }, links: { [`${HOME}/web/.claude`]: `${USER}/.claude` } });
      deps.seedDir(`${HOME}/web/.claude`);
      deps.seed(`${USER}/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps);
      expect(findings.map((entry) => `${entry.level} ${entry.text} ${entry.remedy}`).join(' | ')).toContain('web/.claude is a link');
      expect(findings.map((entry) => entry.remedy).join(' ')).toContain('factory doctor');
      expect(underUser(calls, `${USER}/.claude`)).toEqual([]);
      expect(calls.filter((call) => call.method === 'realpath')).toEqual([]);
      expect(calls.filter((call) => call.path.startsWith(`${HOME}/web/.claude`) && call.method !== 'lstat')).toEqual([]);
      expect(stopOf(await scan(deps))?.code).toBe(4);
    });

    it('stops with exit 4 and does not look inside a project folder that is a link', async () => {
      const deps = make({ env: { HOME: USER }, links: { [`${HOME}/web`]: USER } });
      deps.seed(`${USER}/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps);
      expect(findings.map((entry) => entry.text).join(' | ')).toContain('web is a link');
      expect(findings.map((entry) => entry.remedy).join(' ')).toContain('factory doctor');
      expect(calls.filter((call) => call.path.startsWith(`${HOME}/web/`))).toEqual([]);
      expect(underUser(calls, `${USER}/.claude`)).toEqual([]);
      expect(stopOf(await scan(deps))?.code).toBe(4);
    });

    it('skips a settings folder in other letter case on macOS without a call, and compares exactly on other platforms', async () => {
      const folder = '/users/example';
      const mac = make({ env: { HOME: '/Users/Example' }, os: 'darwin' });
      mac.seed(`${folder}/.claude/settings.json`, BYPASS);
      const macScan = await settingsScan(mac, ['web'], [], folder);
      expect(macScan.findings).toEqual([]);
      expect(underUser(macScan.calls, '/Users/Example/.claude')).toEqual([]);
      const linux = make({ env: { HOME: '/Users/Example' }, os: 'linux' });
      linux.seed(`${folder}/.claude/settings.json`, BYPASS);
      expect((await settingsScan(linux, ['web'], [], folder)).findings.map((entry) => entry.level)).toContain('fail');
    });

    it('skips every settings folder of a root that is below the user settings folder without a call', async () => {
      const root = `${USER}/.claude/node`;
      const deps = make({ env: { HOME: USER } });
      deps.seed(`${root}/.claude/settings.json`, BYPASS);
      deps.seed(`${root}/coordinator/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps, ['web'], [], root);
      expect(findings).toEqual([]);
      expect(underUser(calls, `${USER}/.claude`)).toEqual([]);
    });

    it('runs no realpath on the settings folders or the settings files of the root', async () => {
      const deps = make({ env: { HOME: USER } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      deps.seed(`${HOME}/web/.claude/settings.local.json`, '{}');
      const { findings, calls } = await settingsScan(deps, ['web'], ['web/.claude/settings.local.json']);
      expect(findings.map((entry) => entry.level)).toContain('fail');
      expect(calls.filter((call) => call.method === 'realpath')).toEqual([]);
    });

    it('skips a tracked settings path that is inside the user settings folder without a call', async () => {
      const deps = make({ env: { HOME: HOME } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      const { findings, calls } = await settingsScan(deps, ['web'], ['.claude/settings.json']);
      expect(findings).toEqual([]);
      expect(underUser(calls, `${HOME}/.claude`)).toEqual([]);
    });

    it.each(['own', 'received'] as const)(
      'makes no call and gives no finding for a file that git tracks in the user settings folder, on a %s root that is the user home folder',
      async (origin) => {
        const tracked = ['README.md', '.claude/settings.json', '.claude/notes.txt', '.claude/rules/a.md'];
        const deps = make({ origin, env: { HOME: HOME }, tracked });
        deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
        deps.seed(`${HOME}/.claude/notes.txt`, `The key is ${FAKE_GITHUB_TOKEN}.\n`);
        if (origin === 'received') await acceptTracked(deps, ['README.md']);
        const { guarded, calls } = recorded(deps);
        const found = await scanRoot(guarded, HOME, sampleConfig());
        expect(found.findings).toEqual([]);
        expect(underUser(calls, `${HOME}/.claude`)).toEqual([]);
        expect(calls.some((call) => call.path === `${HOME}/README.md`)).toBe(true);
      },
    );

    it('still scans a file that git tracks next to the user settings folder, and in a folder with a similar name', async () => {
      const tracked = ['.claude-notes/a.txt', 'docs/.claude/b.txt'];
      const deps = make({ env: { HOME: HOME }, tracked });
      deps.seed(`${HOME}/.claude-notes/a.txt`, `The key is ${FAKE_GITHUB_TOKEN}.\n`);
      deps.seed(`${HOME}/docs/.claude/b.txt`, `The key is ${FAKE_GITHUB_TOKEN}.\n`);
      expect(textOf(await scan(deps), checkIds.rootFiles)).toContain('.claude-notes/a.txt');
      expect(textOf(await scan(deps), checkIds.rootFiles)).toContain('docs/.claude/b.txt');
    });
  });

  it('checks the coordinator folder, the root and the tracked paths when the config is not valid, and no project folder', async () => {
    const deps = make({ config: null });
    deps.seed(`${HOME}/web/.claude/settings.json`, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    deps.seed(`${HOME}/coordinator/.claude/settings.json`, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const text = textOf(await scan(deps, null), checkIds.permissionMode);
    expect(text).toContain('coordinator/.claude/settings.json');
    expect(text).not.toContain('web/.claude/settings.json');
  });
});

describe('delegations', () => {
  const record = (point: string, mode: string, at: string) => ({ kind: 'delegation', node: 'demo', root: HOME, point, mode, at });
  const store = (deps: FakeDeps, records: readonly object[]): void =>
    deps.seed(OWNER_RECORDS, JSON.stringify({ schema: 1, records }));

  it('lists the mode of each point, all owner, with no delegation', async () => {
    const found = await scan(make());
    expect(found.delegations).toEqual({ modes: { merge: OWNER, release: OWNER }, active: [], unmatched: [] });
    const result = rootCheckResults(found).find((entry) => entry.id === checkIds.delegations);
    expect(result?.level).toBe('ok');
    expect(result?.text).toContain('merge: owner');
    expect(result?.text).toContain('release: owner');
  });

  it('lists each active delegation with its time', async () => {
    const deps = make();
    store(deps, [record('merge', DELEGATED, '2030-01-02T03:04:05.678Z')]);
    const found = await scan(deps, withApproval({ merge: DELEGATED }));
    const result = rootCheckResults(found).find((entry) => entry.id === checkIds.delegations);
    expect(result?.level).toBe('ok');
    expect(result?.text).toContain('merge: delegated since 2030-01-02T03:04:05.678Z');
    expect(result?.text).toContain('release: owner');
  });

  it('warns for each delegated value with no owner record, and counts the point as owner', async () => {
    const deps = make();
    const found = await scan(deps, withApproval({ merge: DELEGATED, release: DELEGATED }));
    expect(levelsOf(found, checkIds.delegations)).toEqual(['warn', 'warn']);
    const text = textOf(found, checkIds.delegations);
    expect(text).toContain('merge');
    expect(text).toContain('release');
    expect(text).toContain('factory init');
    expect(text).toContain('terminal window');
    const result = rootCheckResults(found).find((entry) => entry.id === checkIds.delegations);
    expect(result?.level).toBe('warn');
    expect(result?.text).toContain('merge: owner');
    expect(requireRootClean(found).ok).toBe(true);
  });

  it('is not checked when the config is not valid', async () => {
    const found = await scan(make({ config: null }), null);
    expect(found.delegations).toBeNull();
    expect(rootCheckResults(found).find((entry) => entry.id === checkIds.delegations)).toMatchObject({ level: 'warn' });
  });
});

describe('the results for doctor', () => {
  it('has one result for each check, in a fixed order, all ok for a clean root', async () => {
    const results = rootCheckResults(await scan(make()));
    expect(results.map((result) => result.id)).toEqual([
      checkIds.rootRepo,
      checkIds.rootFiles,
      checkIds.projectPaths,
      checkIds.permissionMode,
      checkIds.delegations,
    ]);
    expect(results.map((result) => result.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('gives the worst level of the findings of one check, and joins their texts with their remedies', async () => {
    const deps = make({ tracked: ['factory.local.yaml', 'web/a.ts'] });
    const result = rootCheckResults(await scan(deps)).find((entry) => entry.id === checkIds.rootRepo);
    expect(result?.level).toBe('fail');
    expect(result?.text).toContain('factory.local.yaml');
    expect(result?.text).toContain('web/a.ts');
  });

  it('says in the ok text what was checked', async () => {
    const results = rootCheckResults(await scan(make()));
    expect(results.find((entry) => entry.id === checkIds.permissionMode)?.text).toContain('no settings file skips the permission checks');
  });
});

describe('the stop and the notices for start', () => {
  it('is clean for a root with no failure, and a warning does not stop', async () => {
    const found = await scan(make({ tracked: ['AGENTS.md'] }));
    expect(requireRootClean(found).ok).toBe(true);
    expect(hasRootFailure(found)).toBe(false);
  });

  it('stops with exit 4, names the problem, and gives one remedy line', async () => {
    const found = await scan(make({ tracked: ['factory.local.yaml'] }));
    const stop = requireRootClean(found);
    if (stop.ok) throw new Error('expected a stop');
    expect(stop.error.kind).toBe('safety');
    expect(stop.error.message).toContain('factory.local.yaml');
    expect(stop.error.hint).toContain('git rm --cached');
    expect(stop.error.hint).not.toContain('\n');
    expect(stop.error.message).not.toContain('\n');
  });

  it('joins the remedies of several failures, each once', async () => {
    const deps = make({ tracked: ['factory.local.yaml', 'coordinator/CLAUDE.md'] });
    deps.seed(`${HOME}/web/.claude/settings.json`, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const stop = requireRootClean(await scan(deps));
    if (stop.ok) throw new Error('expected a stop');
    expect(stop.error.message).toContain('factory.local.yaml');
    expect(stop.error.message).toContain('skips the permission checks');
    expect(stop.error.hint?.match(/git rm --cached/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('names at most three failures and counts the rest', async () => {
    const deps = make({ tracked: ['factory.local.yaml', 'docs/n.md'] });
    for (const folder of ['web', 'coordinator', '']) {
      deps.seed(`${HOME}${folder === '' ? '' : `/${folder}`}/.claude/settings.json`, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    }
    deps.seed(`${HOME}/docs/n.md`, FAKE_GITHUB_TOKEN);
    const found = await scan(deps);
    expect(found.findings.filter((finding) => finding.level === 'fail')).toHaveLength(5);
    const stop = requireRootClean(found);
    if (stop.ok) throw new Error('expected a stop');
    expect(stop.error.message).toContain('and 2 more');
  });

  it('gives a notice for each warning, with its remedy, and a line for the active delegations', async () => {
    const deps = make({ tracked: ['AGENTS.md'] });
    deps.seed(OWNER_RECORDS, JSON.stringify({ schema: 1, records: [{ kind: 'delegation', node: 'demo', root: HOME, point: 'merge', mode: DELEGATED, at: '2030-01-02T03:04:05.678Z' }] }));
    const notices = rootNotices(await scan(deps, withApproval({ merge: DELEGATED })));
    expect(notices.some((line) => line.includes('AGENTS.md') && line.includes('every receiver'))).toBe(true);
    expect(notices.some((line) => line.includes('merge') && line.includes('2030-01-02T03:04:05.678Z') && line.includes('delegated'))).toBe(true);
  });

  it('gives no notice for a clean root with no delegation', async () => {
    expect(rootNotices(await scan(make()))).toEqual([]);
  });

  it('gives no notice for a failure: the failure is the error, and the notices hold warnings only', async () => {
    const found = await scan(make({ tracked: ['coordinator/note.md'] }));
    expect(hasRootFailure(found)).toBe(true);
    expect(rootNotices(found)).toEqual([]);
  });
});
