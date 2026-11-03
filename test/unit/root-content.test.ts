import { describe, expect, it } from 'vitest';
import {
  failsOnlyOnSetup,
  hasRootFailure,
  requireRootClean,
  rootCheckResults,
  rootNotices,
  scanRoot,
  scanTrackedTexts,
  withSetupAccepted,
  type RootFinding,
  type RootScan,
} from '../../src/commands/root-content.js';
import { failure } from '../../src/cli/errors.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import {
  checkIds,
  claudeSettingKeys,
  env,
  permissionSkipList,
  trackedFiles,
  values,
} from '../../src/names.js';
import type { ApprovalMode } from '../../src/recipes/index.js';
import { createFakeDeps, registerRoot, type FakeDeps } from '../helpers/fake-deps.js';
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

describe('root repo: tracked paths that must stay on this machine (TP-20, TP-123)', () => {
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

describe('root repo: the project folders and the work copies folder (TP-20, TP-166)', () => {
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

describe('root repo: the ignore rules (TP-61)', () => {
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

  it('warns that it did not check when git cannot answer', async () => {
    const found = await scan(make({ git: { checkIgnoreExit: 128 } }));
    expect(levelsOf(found, checkIds.rootRepo)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootRepo)).toContain('not checked');
  });
});

describe('root repo: an instruction file or a settings path in the repo (TP-155)', () => {
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

describe('root repo: the files of a received root (TP-45, TP-166)', () => {
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

describe('root repo: the setup text of an own root (TP-128, TP-173)', () => {
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

describe('root repo: git can not list the files (TP-61)', () => {
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
});

describe('root files: tokens (TP-45, TP-134)', () => {
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
    deps.seed(`${HOME}/docs/notes.md`, 'Plain words.\nSee /var/folders/fn/xhrkn4ys4d37t9fd8kfmd4rw0000gn/T/Work/payments-team-factory-2.\n');
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

  it('does not scan a file that is not text', async () => {
    const deps = make({ tracked: ['bin/data'] });
    deps.seed(`${HOME}/bin/data`, `\u0000${FAKE_GITHUB_TOKEN}`);
    expect(of(await scan(deps), checkIds.rootFiles)).toEqual([]);
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

describe('root files: the caps of the token scan (TP-93)', () => {
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

  it('says on an own root that the scan read the first files of a list at its cap', async () => {
    const tracked = Array.from({ length: trackedFiles.maxCount + 3 }, (_value, index) => `docs/f${index}.md`);
    const found = await scan(make({ origin: 'own', tracked }));
    expect(levelsOf(found, checkIds.rootFiles)).toEqual(['warn']);
    expect(textOf(found, checkIds.rootFiles)).toContain(`more than ${trackedFiles.maxCount} files`);
    expect(hasRootFailure(found)).toBe(false);
  });

  it('reads no file when the list is empty', async () => {
    const deps = make();
    expect(await scanTrackedTexts(deps, HOME, [], CAPS)).toEqual([]);
  });
});

describe('root files: file URLs and user folder paths (TP-136)', () => {
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

describe('project paths (TP-63)', () => {
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

describe('settings files (TP-44, TP-133, TP-154, TP-168, TP-179, TP-180)', () => {
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

    it('fails for a file that sets or clears the session marker, with one remedy line', async () => {
      const deps = make();
      put(deps, folder, JSON.stringify({ env: { [env.session]: '' } }));
      const found = await scan(deps);
      const stop = of(found, checkIds.permissionMode).find((finding) => finding.level === 'fail');
      expect(stop?.text).toContain(shown);
      expect(stop?.text).toContain(env.session);
      expect(stop?.remedy).not.toContain('\n');
      expect(requireRootClean(found).ok).toBe(false);
    });

    it('is ok for a file with safe settings', async () => {
      const deps = make();
      put(deps, folder, JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' }, env: { OTHER: '1' } }));
      expect(levelsOf(await scan(deps), checkIds.permissionMode)).not.toContain('fail');
    });
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

  describe('the tracked settings paths of the root, at any depth (TP-168)', () => {
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
    it('warns, and names the file, when a settings file can not be read', async () => {
      const deps = make();
      put(deps, '', '{}');
      deps.seed(`${HOME}/.claude/settings.json`, '{}');
      const readTextLimited: FakeDeps['fs']['readTextLimited'] = async (path, max) =>
        path.endsWith('settings.local.json')
          ? { ok: false, error: { kind: 'failure', message: `cannot read ${path}: EACCES` } }
          : deps.fs.readTextLimited(path, max);
      const found = await scanRoot({ ...deps, fs: { ...deps.fs, readTextLimited } }, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain('.claude/settings.local.json');
      expect(textOf(found, checkIds.permissionMode)).not.toContain('.claude/settings.json');
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

    it('reads a file up to the cap of bytes only, and warns for a larger one', async () => {
      const deps = make();
      put(deps, 'web', ' '.repeat(trackedFiles.maxFileBytes + 1));
      const found = await scan(deps);
      expect(levelsOf(found, checkIds.permissionMode)).toContain('warn');
      expect(textOf(found, checkIds.permissionMode)).toContain('web/.claude/settings.local.json');
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

    it('warns when it can not tell whether a settings folder exists', async () => {
      const deps = make();
      const denied = { ...deps, fs: { ...deps.fs, stat: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'cannot stat: EACCES' } }) } };
      const found = await scanRoot(denied, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toContain('warn');
      expect(textOf(found, checkIds.permissionMode)).toContain('EACCES');
    });

    it('warns when a settings folder can not be listed', async () => {
      const deps = make();
      deps.seedDir(`${HOME}/web/.claude`);
      const denied = { ...deps, fs: { ...deps.fs, list: async () => ({ ok: false as const, error: { kind: 'failure' as const, message: 'cannot list: EACCES' } }) } };
      const found = await scanRoot(denied, HOME, sampleConfig());
      expect(textOf(found, checkIds.permissionMode)).toContain('EACCES');
    });
  });

  describe('the user settings folder of Claude Code is never read', () => {
    const USER = '/users/example';
    const BYPASS = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });

    /** Deps that note every list and read inside a path. */
    const watched = (deps: FakeDeps) => {
      const touched: string[] = [];
      const note = (path: string): void => void touched.push(path);
      const guarded = {
        ...deps,
        fs: {
          ...deps.fs,
          list: async (path: string) => (note(path), deps.fs.list(path)),
          readText: async (path: string) => (note(path), deps.fs.readText(path)),
          readTextLimited: async (path: string, max: number) => (note(path), deps.fs.readTextLimited(path, max)),
        },
      };
      return { guarded, touched };
    };

    it('reads nothing when the root is the user home folder', async () => {
      const deps = make({ env: { HOME: HOME } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const found = await scanRoot(guarded, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain('not checked');
      expect(touched.filter((path) => path.includes('.claude'))).toEqual([]);
    });

    it('reads nothing when a settings folder is a link to the user settings folder', async () => {
      const deps = make({ env: { HOME: USER }, links: { [`${HOME}/web/.claude`]: `${USER}/.claude` } });
      deps.seedDir(`${HOME}/web/.claude`);
      deps.seed(`${USER}/.claude/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const found = await scanRoot(guarded, HOME, sampleConfig());
      expect(textOf(found, checkIds.permissionMode)).toContain('not checked');
      expect(touched.filter((path) => path.includes('.claude'))).toEqual([]);
    });

    it('skips a settings folder in other letter case on macOS, and compares exactly on other platforms', async () => {
      const folder = '/users/example';
      const mac = make({ env: { HOME: '/Users/Example' }, os: 'darwin' });
      mac.seed(`${folder}/.claude/settings.json`, BYPASS);
      const macFound = await scanRoot(mac, folder, sampleConfig());
      expect(levelsOf(macFound, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(macFound, checkIds.permissionMode)).toContain('not checked');
      const linux = make({ env: { HOME: '/Users/Example' }, os: 'linux' });
      linux.seed(`${folder}/.claude/settings.json`, BYPASS);
      expect(levelsOf(await scanRoot(linux, folder, sampleConfig()), checkIds.permissionMode)).toContain('fail');
    });

    it('skips every settings folder of a root that is below the user settings folder', async () => {
      const root = `${USER}/.claude/node`;
      const deps = make({ env: { HOME: USER } });
      deps.seed(`${root}/.claude/settings.json`, BYPASS);
      deps.seed(`${root}/coordinator/.claude/settings.json`, BYPASS);
      const { guarded, touched } = watched(deps);
      const found = await scanRoot(guarded, root, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).not.toContain('fail');
      expect(textOf(found, checkIds.permissionMode)).toContain('not checked');
      expect(touched.filter((path) => path.includes('.claude'))).toEqual([]);
    });

    it('warns once, and reads nothing, when it can not resolve the links of the paths', async () => {
      const deps = make({ env: { HOME: USER } });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      const denied = {
        ...deps,
        fs: { ...deps.fs, realpath: async () => failure('cannot resolve /: EACCES') },
      } as FakeDeps;
      const { guarded, touched } = watched(denied);
      const found = await scanRoot(guarded, HOME, sampleConfig());
      expect(levelsOf(found, checkIds.permissionMode)).toEqual(['warn']);
      expect(textOf(found, checkIds.permissionMode)).toContain('EACCES');
      expect(touched.filter((path) => path.includes('.claude'))).toEqual([]);
    });

    it('skips a tracked settings path that is inside the user settings folder', async () => {
      const deps = make({ env: { HOME: HOME }, tracked: ['.claude/settings.json'] });
      deps.seed(`${HOME}/.claude/settings.json`, BYPASS);
      expect(levelsOf(await scan(deps), checkIds.permissionMode)).not.toContain('fail');
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

describe('delegations (TP-78)', () => {
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
