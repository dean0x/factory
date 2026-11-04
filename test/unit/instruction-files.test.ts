import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import {
  instructionFileWarnings,
  MAX_WALK_LEVELS,
  scanInstructionFiles,
  warnInstructionFiles,
  type InstructionFileScan,
} from '../../src/core/instruction-files.js';
import { commands, commandText, dirs, env, instructionFiles } from '../../src/names.js';
import { createFakeDeps, withFsWatch, type FakeDeps } from '../helpers/fake-deps.js';

const USER_HOME = '/home/me';
const USER_CLAUDE = '/home/me/.claude';
const ROOT = '/home/me/work/factory';

interface Setup {
  /** The value of HOME. Default: /home/me. */
  readonly home?: string | undefined;
  readonly os?: string;
  readonly links?: Record<string, string>;
}

const make = (setup: Setup = {}): FakeDeps => {
  const deps = createFakeDeps({
    env: { [env.userHome]: 'home' in setup ? setup.home : USER_HOME },
    ...(setup.os === undefined ? {} : { os: setup.os }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  deps.seedDir(ROOT);
  return deps;
};

const put = (deps: FakeDeps, folder: string, name: string): string => {
  const path = join(folder, name);
  deps.seed(path, '');
  return path;
};

/** The folder `levels` levels above `folder`. */
const above = (folder: string, levels: number): string =>
  Array.from({ length: levels }).reduce<string>((current) => dirname(current), folder);

/** A path of `count` folder names below the top folder. */
const deepPath = (count: number): string => `/${Array.from({ length: count }, (_, index) => `d${index}`).join('/')}`;

const CLEAN: InstructionFileScan = { found: [], unreadable: [], truncated: false };

/** The files of the list that a folder `.claude` holds. The user home never gets a look at these. */
const claudeNames = instructionFiles.filter((name) => name.startsWith(`${dirs.claude}/`));

describe('instruction files: the list', () => {
  it('holds the files of Claude Code and of the other common agents (CS-1)', () => {
    expect(instructionFiles).toEqual(
      expect.arrayContaining([
        'CLAUDE.md',
        'CLAUDE.local.md',
        'AGENTS.md',
        'GEMINI.md',
        '.claude/CLAUDE.md',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.github/copilot-instructions.md',
        '.cursor/rules',
      ]),
    );
    expect(new Set(instructionFiles).size).toBe(instructionFiles.length);
  });
});

describe('instruction files: the walk (TP-32)', () => {
  it.each(instructionFiles)('finds %s at the root', async (name) => {
    const deps = make();
    const path = put(deps, ROOT, name);
    expect(await scanInstructionFiles(deps, ROOT)).toEqual({ ...CLEAN, found: [path] });
  });

  it.each(instructionFiles.flatMap((name) => [1, 2].map((levels) => [name, levels] as const)))(
    'finds %s %i level(s) above the root',
    async (name, levels) => {
      // The user home is another folder, so that the names in `.claude` count at every level.
      const deps = make({ home: '/elsewhere/u' });
      const path = put(deps, above(ROOT, levels), name);
      expect(await scanInstructionFiles(deps, ROOT)).toEqual({ ...CLEAN, found: [path] });
    },
  );

  it('finds a file at every level up to the top folder, the root first', async () => {
    const deps = make({ home: '/elsewhere/u' });
    const found = [0, 1, 2, 3, 4].map((levels) => put(deps, above(ROOT, levels), 'AGENTS.md'));
    expect(await scanInstructionFiles(deps, ROOT)).toEqual({ ...CLEAN, found });
    expect(found.at(-1)).toBe('/AGENTS.md');
  });

  it('finds nothing in a tree with no listed file, and does not look below the root', async () => {
    const deps = make();
    put(deps, join(ROOT, 'web'), 'CLAUDE.md');
    put(deps, join(ROOT, 'coordinator'), 'CLAUDE.md');
    expect(await scanInstructionFiles(deps, ROOT)).toEqual(CLEAN);
  });

  it('finds the files above a root that does not exist yet', async () => {
    const deps = make();
    const missing = '/home/me/new/factory';
    const path = put(deps, USER_HOME, 'CLAUDE.md');
    expect(await scanInstructionFiles(deps, missing)).toEqual({ ...CLEAN, found: [path] });
  });

  it('counts a link as a file, also when the link points at nothing', async () => {
    const path = join(above(ROOT, 1), 'AGENTS.md');
    const deps = make({ links: { [path]: '/nowhere' } });
    expect(await scanInstructionFiles(deps, ROOT)).toEqual({ ...CLEAN, found: [path] });
  });

  it('only tests that a path exists: it reads no file', async () => {
    const deps = make();
    put(deps, ROOT, 'CLAUDE.md');
    put(deps, above(ROOT, 1), 'AGENTS.md');
    const methods = new Set<string>();
    await scanInstructionFiles(withFsWatch(deps, (method) => methods.add(method)), ROOT);
    expect([...methods].filter((method) => /read|digest|list|write|remove|rename|chmod|mkdir/i.test(method))).toEqual([]);
  });

  describe('with a folder where the walk stops', () => {
    it('looks at the root and at each folder up to the stop folder, and at no folder above it', async () => {
      const deps = make({ home: '/elsewhere/u' });
      const stop = above(ROOT, 2);
      const inside = [0, 1, 2].map((levels) => put(deps, above(ROOT, levels), 'AGENTS.md'));
      put(deps, above(ROOT, 3), 'CLAUDE.md');
      expect(await scanInstructionFiles(deps, ROOT, stop)).toEqual({ ...CLEAN, found: inside });
    });

    it('stops at the root when the root is the stop folder', async () => {
      const deps = make({ home: '/elsewhere/u' });
      const path = put(deps, ROOT, 'GEMINI.md');
      put(deps, above(ROOT, 1), 'AGENTS.md');
      expect(await scanInstructionFiles(deps, ROOT, ROOT)).toEqual({ ...CLEAN, found: [path] });
    });

    it('does not say that it stopped early: a stop folder is the end of the walk', async () => {
      const deps = make();
      expect((await scanInstructionFiles(deps, ROOT, above(ROOT, 1))).truncated).toBe(false);
    });

    it('walks on to the top folder when the stop folder is not above the root', async () => {
      const deps = make({ home: '/elsewhere/u' });
      const path = put(deps, above(ROOT, 1), 'AGENTS.md');
      expect(await scanInstructionFiles(deps, ROOT, '/not/above/the/root')).toEqual({ ...CLEAN, found: [path] });
    });
  });
});

describe('instruction files: the user Claude folder (TP-34)', () => {
  const seedUserFiles = (deps: FakeDeps): string => {
    for (const name of ['CLAUDE.md', ...claudeNames]) put(deps, USER_CLAUDE, name);
    for (const name of claudeNames) put(deps, USER_HOME, name);
    return put(deps, USER_HOME, 'CLAUDE.md');
  };

  /** The paths in or below the user Claude folder that a call touched. */
  const touchedUserClaude = (seen: readonly string[]): string[] =>
    seen.filter((path) => path === USER_CLAUDE || path.startsWith(`${USER_CLAUDE}/`));

  it('never looks inside it, and never at its name in the home folder', async () => {
    const deps = make();
    const visible = seedUserFiles(deps);
    const seen: string[] = [];
    const result = await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), ROOT);
    expect(result).toEqual({ ...CLEAN, found: [visible] });
    expect(touchedUserClaude(seen)).toEqual([]);
    expect(seen).toContain(join(USER_HOME, 'CLAUDE.md'));
  });

  it('looks at the names in `.claude` in a folder that is not the home folder', async () => {
    const deps = make();
    seedUserFiles(deps);
    const inside = put(deps, above(ROOT, 1), claudeNames[0] ?? '');
    const result = await scanInstructionFiles(deps, ROOT);
    expect(result.found).toContain(inside);
  });

  it('knows the home folder when the variable names a link to it', async () => {
    const deps = make({ home: '/alias', links: { '/alias': USER_HOME } });
    deps.seedDir('/alias');
    seedUserFiles(deps);
    const seen: string[] = [];
    const result = await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), ROOT);
    expect(result.found).toEqual([join(USER_HOME, 'CLAUDE.md')]);
    expect(touchedUserClaude(seen)).toEqual([]);
  });

  it('compares the home folder in any letter case on macOS', async () => {
    const deps = make({ home: '/HOME/ME', os: 'darwin' });
    seedUserFiles(deps);
    const seen: string[] = [];
    const result = await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), ROOT);
    expect(result.found).toEqual([join(USER_HOME, 'CLAUDE.md')]);
    expect(touchedUserClaude(seen)).toEqual([]);
  });

  it('skips a root that stands inside it: no call touches the folder or anything below it', async () => {
    const deps = make();
    const inside = join(USER_CLAUDE, 'factory');
    deps.seedDir(inside);
    const visible = seedUserFiles(deps);
    const seen: string[] = [];
    const result = await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), inside);
    expect(result).toEqual({ ...CLEAN, found: [visible] });
    expect(touchedUserClaude(seen)).toEqual([]);
  });

  it.each([undefined, '', 'relative/home'])(
    'with the home folder unknown (%s), it skips the names in `.claude` above the root and keeps them at the root',
    async (home) => {
      const deps = make({ home });
      const atRoot = put(deps, ROOT, '.claude/settings.json');
      put(deps, above(ROOT, 1), '.claude/settings.json');
      put(deps, USER_CLAUDE, 'CLAUDE.md');
      const plain = put(deps, above(ROOT, 1), 'CLAUDE.md');
      const seen: string[] = [];
      const result = await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), ROOT);
      expect(result.found).toEqual([atRoot, plain]);
      expect(seen.filter((path) => path.includes(`/${dirs.claude}/`) && !path.startsWith(ROOT))).toEqual([]);
    },
  );

  it('skips a folder with a `.claude` part in its path when the home folder is unknown', async () => {
    const deps = make({ home: undefined });
    const inside = join(USER_CLAUDE, 'factory');
    deps.seedDir(inside);
    put(deps, USER_CLAUDE, 'CLAUDE.md');
    const seen: string[] = [];
    await scanInstructionFiles(withFsWatch(deps, (_method, path) => seen.push(path)), inside);
    expect(touchedUserClaude(seen)).toEqual([]);
  });
});

describe('instruction files: a folder that can not be read (TP-34)', () => {
  const lstatFails = (deps: FakeDeps, folder: string): Deps => ({
    ...deps,
    fs: {
      ...deps.fs,
      lstat: async (path) =>
        dirname(path) === folder ? failure(`cannot stat ${path}: EACCES`) : deps.fs.lstat(path),
    },
  });

  it('gives one entry for the folder, with the reason, and goes on with the folders above it', async () => {
    const deps = make({ home: '/elsewhere/u' });
    const unreadable = above(ROOT, 1);
    const atRoot = put(deps, ROOT, 'CLAUDE.md');
    const higher = put(deps, above(ROOT, 2), 'AGENTS.md');
    put(deps, unreadable, 'CLAUDE.md');
    const result = await scanInstructionFiles(lstatFails(deps, unreadable), ROOT);
    expect(result.found).toEqual([atRoot, higher]);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]?.folder).toBe(unreadable);
    expect(result.unreadable[0]?.reason).toContain('EACCES');
    expect(result.truncated).toBe(false);
  });

  it('gives an entry for a folder whose real path can not be resolved', async () => {
    const deps = make();
    const unreadable = above(ROOT, 1);
    const failing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        realpath: async (path) => (path === unreadable ? failure(`cannot resolve ${path}: EACCES`) : deps.fs.realpath(path)),
      },
    };
    const atRoot = put(deps, ROOT, 'CLAUDE.md');
    put(deps, unreadable, 'CLAUDE.md');
    const result = await scanInstructionFiles(failing, ROOT);
    expect(result.found).toEqual([atRoot]);
    expect(result.unreadable.map((entry) => entry.folder)).toEqual([unreadable]);
  });

  it('never throws, also when every call fails', async () => {
    const deps = make();
    const failing: Deps = {
      ...deps,
      fs: {
        ...deps.fs,
        lstat: async (path) => failure(`cannot stat ${path}: EIO`),
        stat: async (path) => failure(`cannot stat ${path}: EIO`),
        realpath: async (path) => failure(`cannot resolve ${path}: EIO`),
      },
    };
    const result = await scanInstructionFiles(failing, ROOT);
    expect(result.found).toEqual([]);
    expect(result.unreadable.map((entry) => entry.folder)).toEqual([ROOT, ...[1, 2, 3, 4].map((levels) => above(ROOT, levels))]);
  });
});

describe('instruction files: the bound of the walk (TP-34)', () => {
  it('looks at 64 folders: the root and 63 folders above it, and says it stopped', async () => {
    const root = deepPath(70);
    const deps = createFakeDeps({ env: { [env.userHome]: '/elsewhere/u' } });
    deps.seedDir(root);
    const last = put(deps, above(root, MAX_WALK_LEVELS - 1), 'AGENTS.md');
    put(deps, above(root, MAX_WALK_LEVELS), 'AGENTS.md');
    expect(MAX_WALK_LEVELS).toBe(64);
    expect(await scanInstructionFiles(deps, root)).toEqual({ ...CLEAN, found: [last], truncated: true });
  });

  it('reaches the top folder with a path of 64 folders, and does not say it stopped', async () => {
    const root = deepPath(MAX_WALK_LEVELS - 1);
    const deps = createFakeDeps({ env: { [env.userHome]: '/elsewhere/u' } });
    deps.seedDir(root);
    const top = put(deps, '/', 'AGENTS.md');
    expect(await scanInstructionFiles(deps, root)).toEqual({ ...CLEAN, found: [top] });
  });

  it('stops before the top folder with a path of 65 folders', async () => {
    const root = deepPath(MAX_WALK_LEVELS);
    const deps = createFakeDeps({ env: { [env.userHome]: '/elsewhere/u' } });
    deps.seedDir(root);
    put(deps, '/', 'AGENTS.md');
    expect(await scanInstructionFiles(deps, root)).toEqual({ ...CLEAN, truncated: true });
  });
});

describe('instruction files: the warning (TP-32, TP-33)', () => {
  it('is empty for a clean scan', () => {
    expect(instructionFileWarnings(CLEAN)).toEqual([]);
  });

  it('names every file that was found, and the command to run after a move', () => {
    const lines = instructionFileWarnings({ ...CLEAN, found: ['/a/CLAUDE.md', '/a/b/AGENTS.md'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/a/CLAUDE.md');
    expect(lines[0]).toContain('/a/b/AGENTS.md');
    expect(lines[0]).toContain(`"${commandText(commands.doctor)}"`);
  });

  it('names a folder that was not read, with the reason', () => {
    const lines = instructionFileWarnings({ ...CLEAN, unreadable: [{ folder: '/a/b', reason: 'cannot stat /a/b/CLAUDE.md: EACCES' }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/a/b');
    expect(lines[0]).toContain('EACCES');
  });

  it('says that the walk stopped, with the bound', () => {
    const lines = instructionFileWarnings({ ...CLEAN, truncated: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(String(MAX_WALK_LEVELS));
  });

  it('gives one line for each kind of finding, the files first', () => {
    const lines = instructionFileWarnings({
      found: ['/a/CLAUDE.md'],
      unreadable: [{ folder: '/a/b', reason: 'EACCES' }],
      truncated: true,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('/a/CLAUDE.md');
  });
});

describe('instruction files: the warning before a command acts (TP-33)', () => {
  it('prints each line of the warning with the deps, and nothing for a clean tree', async () => {
    const clean = make();
    await warnInstructionFiles(clean, ROOT);
    expect(clean.warned).toEqual([]);

    const deps = make();
    put(deps, above(ROOT, 1), 'CLAUDE.md');
    await warnInstructionFiles(deps, ROOT);
    expect(deps.warned).toEqual(instructionFileWarnings(await scanInstructionFiles(deps, ROOT)));
    expect(deps.warned).toHaveLength(1);
  });

  it('does not throw and does not stop when a folder can not be read', async () => {
    const deps = make();
    const failing: FakeDeps = { ...deps, fs: { ...deps.fs, lstat: async (path) => failure(`cannot stat ${path}: EACCES`) } };
    await expect(warnInstructionFiles(failing, ROOT)).resolves.toBeUndefined();
    expect(deps.warned.length).toBeGreaterThan(0);
  });
});
