import { posix } from 'node:path';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps, FetchStatus, PathKind, RunOptions, RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';

export interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

export type RunHandler = (call: RunCall) => CliResult<RunOutput>;
export type FetchHandler = (url: string) => CliResult<FetchStatus>;

export interface FakeOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
  readonly run?: RunHandler;
  readonly fetch?: FetchHandler;
  readonly now?: Date;
  readonly pid?: number;
}

export interface FakeDeps extends Deps {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly calls: RunCall[];
  readonly fetched: string[];
  seed(path: string, text: string): void;
  seedDir(path: string): void;
}

export const exited = (exitCode: number, stdout = '', stderr = ''): CliResult<RunOutput> =>
  ok({ exitCode, stdout, stderr });

export const missingProgram = (command: string): CliResult<RunOutput> =>
  failure(`cannot run ${command}: ENOENT`);

const enoent = (action: string, path: string): CliResult<never> =>
  failure(`cannot ${action} ${path}: ENOENT`);

export const createFakeDeps = (options: FakeOptions = {}): FakeDeps => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const calls: RunCall[] = [];
  const fetched: string[] = [];

  const ancestors = (path: string): string[] => {
    const found: string[] = [];
    for (let current = posix.dirname(path); current !== '/' && current !== '.'; current = posix.dirname(current)) {
      found.push(current);
    }
    return found;
  };
  const addDir = (path: string): void => {
    dirs.add(path);
    for (const parent of ancestors(path)) dirs.add(parent);
  };
  const under = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);
  const kindOf = (path: string): PathKind | null => (files.has(path) ? 'file' : dirs.has(path) ? 'dir' : null);
  const treeKeys = (root: string): { files: string[]; dirs: string[] } => ({
    files: [...files.keys()].filter((key) => under(root, key)),
    dirs: [...dirs].filter((key) => under(root, key)),
  });

  const fake: FakeDeps = {
    files,
    dirs,
    calls,
    fetched,
    seed: (path, text) => {
      addDir(posix.dirname(path));
      files.set(path, text);
    },
    seedDir: (path) => addDir(path),
    fs: {
      readText: async (path) => {
        const text = files.get(path);
        return text === undefined ? enoent('read', path) : ok(text);
      },
      writeText: async (path, text) => {
        if (!dirs.has(posix.dirname(path))) return enoent('write', path);
        files.set(path, text);
        return ok(undefined);
      },
      stat: async (path) => ok(kindOf(path)),
      mkdir: async (path) => {
        addDir(path);
        return ok(undefined);
      },
      list: async (path) => {
        if (!dirs.has(path)) return enoent('list', path);
        const names = new Set<string>();
        for (const key of [...files.keys(), ...dirs]) {
          if (key !== path && posix.dirname(key) === path) names.add(posix.basename(key));
        }
        return ok([...names].sort());
      },
      rename: async (from, to) => {
        if (kindOf(from) === null) return enoent('rename', from);
        if (dirs.has(to) && treeKeys(to).files.length > 0) return failure(`cannot rename ${from}: ENOTEMPTY`);
        const tree = treeKeys(from);
        for (const key of tree.files) {
          const text = files.get(key) ?? '';
          files.delete(key);
          files.set(to + key.slice(from.length), text);
        }
        for (const key of tree.dirs) {
          dirs.delete(key);
          addDir(to + key.slice(from.length));
        }
        return ok(undefined);
      },
      remove: async (path) => {
        const tree = treeKeys(path);
        for (const key of tree.files) files.delete(key);
        for (const key of tree.dirs) dirs.delete(key);
        return ok(undefined);
      },
      copyTree: async (from, to, skip) => {
        if (kindOf(from) === null) return enoent('copy', from);
        const skipped = (key: string): boolean => skip.some((root) => under(root, key));
        const tree = treeKeys(from);
        addDir(to);
        for (const key of tree.dirs) if (!skipped(key)) addDir(to + key.slice(from.length));
        for (const key of tree.files) {
          if (!skipped(key)) files.set(to + key.slice(from.length), files.get(key) ?? '');
        }
        return ok(undefined);
      },
    },
    run: async (command: string, args: readonly string[], runOptions?: RunOptions) => {
      const call: RunCall = { command, args, cwd: runOptions?.cwd };
      calls.push(call);
      return (options.run ?? (() => missingProgram(command)))(call);
    },
    env: options.env ?? {},
    fetch: async (url) => {
      fetched.push(url);
      return (options.fetch ?? (() => failure('no answer')))(url);
    },
    now: () => options.now ?? new Date('2030-01-02T03:04:05.678Z'),
    platform: { os: 'linux', nodeVersion: options.nodeVersion ?? 'v22.1.0' },
    cwd: options.cwd ?? '/work',
    pid: options.pid ?? 4242,
  };
  fake.seedDir(fake.cwd);
  return fake;
};
