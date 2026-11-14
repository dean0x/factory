import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliError } from '../../src/cli/errors.js';
import { createNodeDeps } from '../../src/core/node-deps.js';
import {
  ignoreProbesOf,
  isClaudeSettingsPath,
  isInstructionPath,
  LINK_REMEDY,
  requireNoLinks,
  requireNoRootLinks,
  requireNoTrackedLinks,
  rootGuardPaths,
  trackedProblems,
  trackedSetOf,
  trackedUnder,
} from '../../src/core/root-paths.js';
import { layoutOf } from '../../src/state/layout.js';
import { createFakeDeps, type FakeDeps } from '../helpers/fake-deps.js';

const ROOT = '/w/acme';
const layout = layoutOf(ROOT);

const refusal = (result: Awaited<ReturnType<typeof requireNoLinks>>): CliError => {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

/** A factory folder with the setup texts, the coordinator folder and the state folder. */
const seeded = (links: Readonly<Record<string, string>> = {}): FakeDeps => {
  const deps = createFakeDeps({ links });
  deps.seed(layout.setupCoordinatorFile, 'Coordinator text.\n');
  deps.seed(layout.setupWorkerFile, 'Worker text.\n');
  deps.seed(layout.claudeMd, 'Instructions.\n');
  deps.seed(layout.workerMd, 'Worker.\n');
  deps.seedDir(layout.backupsDir);
  return deps;
};

describe('the paths that the link rule covers', () => {
  it('names the setup texts, the coordinator file, the worker file and the backups, and not the local file', () => {
    expect(rootGuardPaths(layout)).toEqual([
      `${ROOT}/setup/coordinator.md`,
      `${ROOT}/setup/roles/worker.md`,
      `${ROOT}/coordinator/CLAUDE.md`,
      `${ROOT}/.factory/roles/worker.md`,
      `${ROOT}/.factory/backups`,
    ]);
    expect(rootGuardPaths(layout)).not.toContain(layout.localConfigFile);
  });
});

describe('requireNoLinks', () => {
  it('passes a factory folder with plain files and plain folders', async () => {
    expect((await requireNoRootLinks(seeded(), layout)).ok).toBe(true);
  });

  it('passes a factory folder where none of the paths exist yet', async () => {
    expect((await requireNoRootLinks(createFakeDeps(), layout)).ok).toBe(true);
  });

  it('passes a path list that is empty', async () => {
    expect((await requireNoLinks(createFakeDeps(), ROOT, [])).ok).toBe(true);
  });

  it('refuses a link at the setup text with exit 4 and one remedy line, and names the part', async () => {
    const error = refusal(await requireNoRootLinks(seeded({ [layout.setupCoordinatorFile]: '/outside/notes.md' }), layout));
    expect(error.kind).toBe('safety');
    expect(error.message).toBe('setup/coordinator.md is a link, so factory does not use it');
    expect(error.kind === 'safety' && error.hint).toBe(LINK_REMEDY);
  });

  it.each([
    ['the setup folder', layout.setupDir, 'setup'],
    ['the roles folder of the setup', layout.setupRolesDir, 'setup/roles'],
    ['the worker text of the setup', layout.setupWorkerFile, 'setup/roles/worker.md'],
    ['the coordinator folder', layout.coordinatorDir, 'coordinator'],
    ['the coordinator file', layout.claudeMd, 'coordinator/CLAUDE.md'],
    ['the state folder', layout.stateDir, '.factory'],
    ['the worker file', layout.workerMd, '.factory/roles/worker.md'],
    ['the backups folder', layout.backupsDir, '.factory/backups'],
  ])('refuses a link at %s', async (_name, path, shown) => {
    const error = refusal(await requireNoRootLinks(seeded({ [path]: '/outside' }), layout));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain(`${shown} is a link`);
  });

  it('names the first link of the path, which is a folder above the file', async () => {
    const error = refusal(await requireNoRootLinks(seeded({ [layout.coordinatorDir]: '/outside' }), layout));
    expect(error.message).toBe('coordinator is a link, so factory does not use it');
  });

  it('refuses a link whose target does not exist', async () => {
    const deps = createFakeDeps({ links: { [layout.setupCoordinatorFile]: '/outside/gone.md' } });
    deps.seedDir(layout.setupDir);
    expect(refusal(await requireNoRootLinks(deps, layout)).kind).toBe('safety');
  });

  it('refuses a link whose target is inside the factory folder', async () => {
    const deps = seeded({ [layout.setupCoordinatorFile]: layout.setupWorkerFile });
    expect(refusal(await requireNoRootLinks(deps, layout)).message).toContain('setup/coordinator.md is a link');
  });

  it('refuses a path that is not inside the factory folder', async () => {
    const error = refusal(await requireNoLinks(createFakeDeps(), ROOT, ['/w/other/setup/coordinator.md']));
    expect(error.kind).toBe('safety');
    expect(error.message).toContain('is not inside the factory folder');
  });

  it('refuses a path that climbs out of the factory folder', async () => {
    const error = refusal(await requireNoLinks(createFakeDeps(), ROOT, [`${ROOT}/../other/file`]));
    expect(error.kind).toBe('safety');
  });

  it('refuses a path with more parts than the bound allows', async () => {
    const deep = `${ROOT}/${Array.from({ length: 40 }, (_unused, index) => `d${index}`).join('/')}`;
    expect(refusal(await requireNoLinks(createFakeDeps(), ROOT, [deep])).kind).toBe('safety');
  });

  it('takes the remedy line of the caller', async () => {
    const deps = createFakeDeps({ links: { [layout.localConfigFile]: '/outside/local.yaml' } });
    deps.seed(layout.localConfigFile, 'x');
    const error = refusal(await requireNoLinks(deps, ROOT, [layout.localConfigFile], 'Move it away.'));
    expect(error.kind === 'safety' && error.hint).toBe('Move it away.');
  });

  it('works when the factory folder is under a linked parent folder', async () => {
    const deps = createFakeDeps({ links: { '/link': '/real' } });
    const inside = layoutOf('/link/acme');
    deps.seed(inside.setupCoordinatorFile, 'Text.\n');
    deps.seed(inside.claudeMd, 'Instructions.\n');
    expect((await requireNoRootLinks(deps, inside)).ok).toBe(true);
  });

  it('works when the factory folder is a link itself', async () => {
    const deps = createFakeDeps({ links: { [ROOT]: '/real/acme' } });
    deps.seed(layout.setupCoordinatorFile, 'Text.\n');
    expect((await requireNoRootLinks(deps, layout)).ok).toBe(true);
  });

  it('stops under a linked parent folder when a part below the factory folder is a link', async () => {
    const inside = layoutOf('/link/acme');
    const deps = createFakeDeps({ links: { '/link': '/real', [inside.setupDir]: '/outside' } });
    deps.seedDir(inside.setupDir);
    expect(refusal(await requireNoRootLinks(deps, inside)).message).toContain('setup is a link');
  });
});

describe('the tracked set of a received root', () => {
  it('holds every tracked path apart from factory.yaml and the .gitignore of the root', () => {
    const tracked = [
      '.claude/settings.json',
      '.gitignore',
      '.mcp.json',
      'CLAUDE.md',
      'factory.yaml',
      'setup/coordinator.md',
      'setup/roles/worker.md',
      'setup/scripts/run.sh',
      'setup/.gitignore',
    ];
    expect(trackedSetOf(tracked)).toEqual([
      '.claude/settings.json',
      '.mcp.json',
      'CLAUDE.md',
      'setup/coordinator.md',
      'setup/roles/worker.md',
      'setup/scripts/run.sh',
      'setup/.gitignore',
    ]);
  });

  it('needs no name list: a path with an unknown name is in the set', () => {
    expect(trackedSetOf(['anything/at/all.bin', 'factory.yaml'])).toEqual(['anything/at/all.bin']);
  });

  it('is empty for a root that tracks only the two paths with their own checks', () => {
    expect(trackedSetOf(['.gitignore', 'factory.yaml'])).toEqual([]);
  });
});

describe('requireNoTrackedLinks', () => {
  const tracked = ['setup/coordinator.md', 'CLAUDE.md', '.claude/settings.json'];
  const seededRoot = (links: Readonly<Record<string, string>> = {}): FakeDeps => {
    const deps = createFakeDeps({ links });
    for (const path of tracked) deps.seed(`${ROOT}/${path}`, 'text\n');
    return deps;
  };

  it('passes plain files', async () => {
    expect((await requireNoTrackedLinks(seededRoot(), ROOT, tracked)).ok).toBe(true);
  });

  it('refuses a tracked link named CLAUDE.md with exit 4, one remedy line, and the name', async () => {
    const error = refusal(await requireNoTrackedLinks(seededRoot({ [`${ROOT}/CLAUDE.md`]: '/outside/notes.md' }), ROOT, tracked));
    expect(error.kind).toBe('safety');
    expect(error.message).toBe('CLAUDE.md is a link, so factory does not use it');
    expect(error.kind === 'safety' && error.hint).toBe(LINK_REMEDY);
  });

  it('refuses a tracked link in place of a folder', async () => {
    const error = refusal(await requireNoTrackedLinks(seededRoot({ [`${ROOT}/.claude`]: '/outside' }), ROOT, tracked));
    expect(error.message).toBe('.claude is a link, so factory does not use it');
  });

  it('refuses a link in the middle of a tracked path', async () => {
    const error = refusal(await requireNoTrackedLinks(seededRoot({ [`${ROOT}/setup`]: '/outside' }), ROOT, tracked));
    expect(error.message).toBe('setup is a link, so factory does not use it');
  });

  it('refuses a tracked path that climbs out of the root', async () => {
    expect(refusal(await requireNoTrackedLinks(seededRoot(), ROOT, ['../outside.md'])).kind).toBe('safety');
  });

  it('passes a tracked path that is not in the work tree any more', async () => {
    expect((await requireNoTrackedLinks(createFakeDeps(), ROOT, tracked)).ok).toBe(true);
  });
});

describe('the tracked paths that stop init', () => {
  const cloneFolders = ['web', 'api'];
  const kinds = (tracked: readonly string[], clones: readonly string[] = cloneFolders) =>
    trackedProblems(tracked, clones).map((problem) => [problem.path, problem.kind]);

  it('passes a root that tracks only its setup', () => {
    expect(kinds(['factory.yaml', '.gitignore', 'setup/coordinator.md', 'setup/roles/worker.md', 'CLAUDE.md'])).toEqual([]);
  });

  it('names a tracked local file', () => {
    expect(kinds(['factory.local.yaml'])).toEqual([['factory.local.yaml', 'local-file']]);
  });

  it.each([['.factory'], ['.factory/node.json'], ['.factory/roles/worker.md']])('names the state path %s', (path) => {
    expect(kinds([path])).toEqual([[path, 'state-folder']]);
  });

  it.each([['coordinator'], ['coordinator/CLAUDE.md'], ['coordinator/deep/er/file']])('names the coordinator path %s', (path) => {
    expect(kinds([path])).toEqual([[path, 'session-folder']]);
  });

  it.each([['web'], ['web/src/index.ts'], ['api/README.md']])('names the path %s under a clone folder', (path) => {
    expect(kinds([path])).toEqual([[path, 'clone']]);
  });

  it('names no clone path when the caller gives no clone folder', () => {
    expect(kinds(['web/src/index.ts'], [])).toEqual([]);
  });

  it('compares the names without letter case and in the normal form of Unicode, as a case-blind file system does', () => {
    expect(kinds(['Factory.Local.YAML', '.FACTORY/node.json', 'Coordinator/CLAUDE.md', 'WEB/x', 'ｗeb/y'])).toEqual([
      ['Factory.Local.YAML', 'local-file'],
      ['.FACTORY/node.json', 'state-folder'],
      ['Coordinator/CLAUDE.md', 'session-folder'],
      ['WEB/x', 'clone'],
      ['ｗeb/y', 'clone'],
    ]);
  });

  it('does not name a path whose name only starts like a stop path', () => {
    expect(kinds(['coordinators/x', '.factory-notes/x', 'factory.local.yaml.example', 'webapp/x', 'setup/web/x', 'x/coordinator/y'])).toEqual([]);
  });

  it('names every problem in the order of the list', () => {
    expect(kinds(['setup/a', 'coordinator/x', 'factory.local.yaml', '.factory/n'])).toEqual([
      ['coordinator/x', 'session-folder'],
      ['factory.local.yaml', 'local-file'],
      ['.factory/n', 'state-folder'],
    ]);
  });
});

describe('the tracked paths that a session can load', () => {
  it.each([
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    'GEMINI.md',
    '.claude/CLAUDE.md',
    '.claude/rules/style.md',
    '.claude/rules/deep/more.md',
    '.github/copilot-instructions.md',
    '.cursor/rules/a.mdc',
    '.claude/settings.json',
    'docs/CLAUDE.md',
    'tools/deep/.claude/settings.local.json',
    'Claude.md',
    'sub/agents.md',
  ])('takes %s as an instruction file or a settings file', (path) => {
    expect(isInstructionPath(path)).toBe(true);
  });

  it.each(['README.md', 'setup/coordinator.md', 'notes/CLAUDE.md.txt', 'claude-notes.md', '.claude-plugin/plugin.json', 'factory.yaml'])(
    'takes %s as neither',
    (path) => {
      expect(isInstructionPath(path)).toBe(false);
    },
  );

  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    'web/.claude/settings.json',
    'a/b/c/.claude/settings.team.json',
    '.CLAUDE/Settings.JSON',
  ])('takes %s as a Claude settings path at any depth', (path) => {
    expect(isClaudeSettingsPath(path)).toBe(true);
  });

  it.each(['.claude/CLAUDE.md', 'settings.json', '.claude/settings.txt', '.claude/notes/settings.json', 'claude/settings.json'])(
    'does not take %s as a Claude settings path',
    (path) => {
      expect(isClaudeSettingsPath(path)).toBe(false);
    },
  );
});

describe('the tracked paths under one folder', () => {
  const tracked = ['factory.yaml', 'web/a.ts', 'Web/b.ts', 'work-copies/x', 'WORK-COPIES/y', 'webapp/c.ts', 'a/web/d.ts'];

  it('gives the paths whose first part is the folder, in any letter case, in the order of the list', () => {
    expect(trackedUnder(tracked, 'web')).toEqual(['web/a.ts', 'Web/b.ts']);
    expect(trackedUnder(tracked, 'work-copies')).toEqual(['work-copies/x', 'WORK-COPIES/y']);
  });

  it('gives nothing for a folder that nothing tracks, and never takes a path with the folder name in the middle', () => {
    expect(trackedUnder(tracked, 'api')).toEqual([]);
    expect(trackedUnder(['a/web/d.ts'], 'web')).toEqual([]);
  });

  it('does not take a file at the top for a folder of the same name', () => {
    expect(trackedUnder(['web'], 'web')).toEqual([]);
  });
});

describe('the paths that the ignore check probes', () => {
  it('names the local file, the node file of the state folder, a coordinator file, a work copies path and a file in each clone', () => {
    expect(ignoreProbesOf(['web', 'api'])).toEqual({
      local: 'factory.local.yaml',
      state: '.factory/node.json',
      coordinator: 'coordinator/CLAUDE.md',
      workCopies: 'work-copies/probe',
      clones: ['web/CLAUDE.md', 'api/CLAUDE.md'],
    });
  });

  it('names no clone for a root without projects', () => {
    expect(ignoreProbesOf([]).clones).toEqual([]);
  });
});

describe('requireNoLinks on a real file system', () => {
  const real = createNodeDeps();
  let base = '';

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'factory-root-paths-'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const folderWithSetup = async (name: string): Promise<string> => {
    const folder = join(base, name);
    await mkdir(join(folder, 'setup', 'roles'), { recursive: true });
    await mkdir(join(folder, 'coordinator'), { recursive: true });
    await writeFile(join(folder, 'setup', 'coordinator.md'), 'Text.\n', 'utf8');
    await writeFile(join(folder, 'coordinator', 'CLAUDE.md'), 'Instructions.\n', 'utf8');
    return folder;
  };

  it('works for a factory folder that is reached through a linked parent folder', async () => {
    const folder = await folderWithSetup('real-parent');
    const via = join(base, 'via-parent');
    await symlink(base, via);
    const reached = join(via, 'real-parent');
    expect((await requireNoRootLinks(real, layoutOf(reached))).ok).toBe(true);
    expect((await requireNoRootLinks(real, layoutOf(folder))).ok).toBe(true);
  });

  it('stops for a link at the setup text that leads to a file outside the factory folder, and reads nothing', async () => {
    const folder = await folderWithSetup('linked-setup');
    const outside = join(base, 'outside-secret.txt');
    await writeFile(outside, 'secret\n', 'utf8');
    await rm(join(folder, 'setup', 'coordinator.md'));
    await symlink(outside, join(folder, 'setup', 'coordinator.md'));
    const error = refusal(await requireNoRootLinks(real, layoutOf(folder)));
    expect(error.kind).toBe('safety');
    expect(error.message).toBe('setup/coordinator.md is a link, so factory does not use it');
  });

  it('stops for a link in place of the coordinator folder', async () => {
    const folder = await folderWithSetup('linked-coordinator');
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await rm(join(folder, 'coordinator'), { recursive: true });
    await symlink(elsewhere, join(folder, 'coordinator'));
    expect(refusal(await requireNoRootLinks(real, layoutOf(folder))).message).toContain('coordinator is a link');
  });
});
