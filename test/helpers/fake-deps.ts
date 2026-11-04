import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps, FetchStatus, Fs, PathKind, RunOptions, RunOutput } from '../../src/core/deps.js';
import { isSameOrInside } from '../../src/core/paths.js';
import { ok } from '../../src/core/result.js';
import { dirs, env, files as fileNames, homeIndex, privateFile, program, stateKeys } from '../../src/names.js';
import { STATE_SCHEMA_VERSION } from '../../src/state/schema.js';

export interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  /** True when the caller asked for the environment of the process as it is. */
  readonly inheritEnv?: boolean;
  /** The time limit that the caller asked for. */
  readonly timeoutMs?: number;
}

export type RunHandler = (call: RunCall) => CliResult<RunOutput>;
export type FetchHandler = (url: string) => CliResult<FetchStatus>;

export type PromptHandler = (question: string) => CliResult<string>;
export type AttachedHandler = (call: RunCall) => CliResult<number>;

export interface FakeOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nodeVersion?: string;
  /** The value of `process.platform`. Default: linux. */
  readonly os?: string;
  readonly run?: RunHandler;
  readonly fetch?: FetchHandler;
  readonly now?: Date;
  readonly pid?: number;
  /** The id of the user of the process. Default: 1000. Null: a platform with no user ids. */
  readonly uid?: number | null;
  /** A person types at the process. Default: false. */
  readonly stdinIsTTY?: boolean;
  /** A person reads the output on a terminal. Default: false. */
  readonly stdoutIsTTY?: boolean;
  /** The answer to a question. Default: no answer. */
  readonly prompt?: PromptHandler;
  /** The result of a program that uses the terminal. Default: exit code 0. */
  readonly runAttached?: AttachedHandler;
  /** Links: a path under a key resolves to the same path under the value. `lstat` gives `link` for a key itself. */
  readonly links?: Readonly<Record<string, string>>;
}

export interface FakeDeps extends Deps {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly calls: RunCall[];
  /** The programs that ran with the terminal, in order. */
  readonly attached: RunCall[];
  /** The questions that were asked, in order. */
  readonly prompts: string[];
  /** The warnings that were printed at once, before the command returned, in order. */
  readonly warned: string[];
  readonly fetched: string[];
  /** The paths of the atomic writes, in order. */
  readonly atomicWrites: string[];
  /**
   * The mode that a write or a folder was created with, or that a chmod set, by path. A path with no mode is not in
   * the map, and `statInfo` then gives 0o600 for a file and 0o700 for a folder.
   */
  readonly modes: Map<string, number>;
  /** The owner of a path, by path. A path that is not in the map belongs to the user of the process. */
  readonly owners: Map<string, number>;
  /** The time of the last write of a file, in milliseconds, by path. A file that is not in the map changed just now. */
  readonly mtimes: Map<string, number>;
  /** The waits of `sleep`, in order. */
  readonly sleeps: number[];
  /** Move the clock on by `ms` milliseconds. `sleep` does the same. */
  advance(ms: number): void;
  seed(path: string, text: string): void;
  seedDir(path: string): void;
}

export const exited = (exitCode: number, stdout = '', stderr = ''): CliResult<RunOutput> =>
  ok({ exitCode, stdout, stderr });

export const missingProgram = (command: string): CliResult<RunOutput> =>
  failure(`cannot run ${command}: ENOENT`);

const DEFAULT_NOW = new Date('2030-01-02T03:04:05.678Z');
const DEFAULT_UID = 1000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const enoent = (action: string, path: string): CliResult<never> =>
  failure(`cannot ${action} ${path}: ENOENT`);

export const createFakeDeps = (options: FakeOptions = {}): FakeDeps => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  const calls: RunCall[] = [];
  const attached: RunCall[] = [];
  const prompts: string[] = [];
  const warned: string[] = [];
  const fetched: string[] = [];
  const atomicWrites: string[] = [];
  const modes = new Map<string, number>();
  const owners = new Map<string, number>();
  const mtimes = new Map<string, number>();
  const sleeps: number[] = [];
  const uid = options.uid === undefined ? DEFAULT_UID : options.uid;
  let clock = (options.now ?? DEFAULT_NOW).getTime();
  const touch = (path: string): void => void mtimes.set(path, clock);

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
  const realOf = (path: string): string => {
    const link = Object.entries(options.links ?? {}).find(([from]) => under(from, path));
    return link === undefined ? path : link[1] + path.slice(link[0].length);
  };
  const treeKeys = (root: string): { files: string[]; dirs: string[] } => ({
    files: [...files.keys()].filter((key) => under(root, key)),
    dirs: [...dirs].filter((key) => under(root, key)),
  });

  const fake: FakeDeps = {
    files,
    dirs,
    calls,
    attached,
    prompts,
    warned,
    fetched,
    atomicWrites,
    modes,
    owners,
    mtimes,
    sleeps,
    advance: (ms) => {
      clock += ms;
    },
    seed: (path, text) => {
      addDir(posix.dirname(path));
      files.set(path, text);
      touch(path);
    },
    seedDir: (path) => addDir(path),
    fs: {
      readText: async (path) => {
        const text = files.get(path);
        return text === undefined ? enoent('read', path) : ok(text);
      },
      readTextLimited: async (path, maxBytes) => {
        const text = files.get(path);
        if (text === undefined) return enoent('read', path);
        return Buffer.byteLength(text, 'utf8') > maxBytes ? failure(`cannot read ${path}: larger than ${maxBytes} bytes`) : ok(text);
      },
      digestFile: async (path, textLimit, maxBytes) => {
        const text = files.get(path);
        if (text === undefined) return enoent('read', path);
        const size = Buffer.byteLength(text, 'utf8');
        if (size > maxBytes) return ok(null);
        return ok({ size, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), text: size <= textLimit ? text : null });
      },
      writeText: async (path, text) => {
        if (!dirs.has(posix.dirname(path))) return enoent('write', path);
        files.set(path, text);
        touch(path);
        return ok(undefined);
      },
      writeTextExclusive: async (path, text, mode) => {
        if (!dirs.has(posix.dirname(path))) return enoent('write', path);
        // A file, a folder and a link at the path all count as existing, and a link is not followed.
        if (kindOf(path) !== null || Object.hasOwn(options.links ?? {}, path)) return ok(false);
        files.set(path, text);
        modes.set(path, mode);
        touch(path);
        return ok(true);
      },
      writeTextAtomic: async (path, text, within, mode) => {
        // The same refusals as the real write: a link at the target, and a real path outside the folder.
        if (Object.hasOwn(options.links ?? {}, path)) return failure(`cannot write ${path}: it is a link`);
        if (!dirs.has(posix.dirname(path))) return enoent('write', path);
        if (!dirs.has(within)) return enoent('resolve', within);
        if (!isSameOrInside(realOf(within), posix.join(realOf(posix.dirname(path)), posix.basename(path)))) {
          return failure(`cannot write ${path}: it is outside ${within}`);
        }
        atomicWrites.push(path);
        files.set(path, text);
        touch(path);
        if (mode !== undefined) modes.set(path, mode);
        return ok(undefined);
      },
      stat: async (path) => ok(kindOf(path)),
      lstat: async (path) => ok(Object.hasOwn(options.links ?? {}, path) ? 'link' : kindOf(path)),
      statInfo: async (path) => {
        const kind = kindOf(path);
        if (kind === null) return ok(null);
        return ok({
          kind,
          uid: owners.get(path) ?? uid ?? DEFAULT_UID,
          mode: modes.get(path) ?? (kind === 'dir' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE),
          mtimeMs: mtimes.get(path) ?? clock,
          size: Buffer.byteLength(files.get(path) ?? '', 'utf8'),
        });
      },
      chmod: async (path, mode) => {
        if (kindOf(path) === null) return enoent('change the mode of', path);
        modes.set(path, mode);
        return ok(undefined);
      },
      realpath: async (path) => {
        if (kindOf(path) === null) return enoent('resolve', path);
        return ok(realOf(path));
      },
      mkdir: async (path, mode) => {
        if (mode !== undefined && !dirs.has(path)) modes.set(path, mode);
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
      removeEmptyDir: async (path) => {
        if (kindOf(path) === null) return ok(undefined);
        if (files.has(path)) return failure(`cannot remove ${path}: ENOTDIR`);
        const tree = treeKeys(path);
        if (tree.files.length > 0 || tree.dirs.length > 1) return failure(`cannot remove ${path}: ENOTEMPTY`);
        dirs.delete(path);
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
      const call: RunCall = {
        command,
        args,
        cwd: runOptions?.cwd,
        inheritEnv: runOptions?.inheritEnv === true,
        ...(runOptions?.timeoutMs === undefined ? {} : { timeoutMs: runOptions.timeoutMs }),
      };
      calls.push(call);
      return (options.run ?? (() => missingProgram(command)))(call);
    },
    runAttached: async (command: string, args: readonly string[]) => {
      const call: RunCall = { command, args, cwd: undefined };
      attached.push(call);
      return (options.runAttached ?? (() => ok(0)))(call);
    },
    stdinIsTTY: options.stdinIsTTY ?? false,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    prompt: async (question: string) => {
      prompts.push(question);
      return (options.prompt ?? (() => failure('no answer was given')))(question);
    },
    warn: (message: string) => {
      warned.push(message);
    },
    env: options.env ?? {},
    fetch: async (url) => {
      fetched.push(url);
      return (options.fetch ?? (() => failure('no answer')))(url);
    },
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      // Other work that waits runs before this wait ends, as it does with a real wait.
      await yieldTurn();
    },
    platform: { os: options.os ?? 'linux', nodeVersion: options.nodeVersion ?? 'v22.1.0' },
    cwd: options.cwd ?? '/work',
    pid: options.pid ?? 4242,
    uid,
  };
  fake.seedDir(fake.cwd);
  return fake;
};

/** The file of the factory list for the environment of `deps`: below the state home, else below `.local/state` of HOME. */
const factoryListOf = (deps: FakeDeps): string => {
  const stateHome = deps.env[env.stateHome];
  if (stateHome !== undefined && posix.isAbsolute(stateHome)) return posix.join(stateHome, program, fileNames.homeIndex);
  const userHome = deps.env[env.userHome];
  if (userHome !== undefined && posix.isAbsolute(userHome)) {
    return posix.join(userHome, ...privateFile.defaultStateHome, program, fileNames.homeIndex);
  }
  throw new Error(`the deps name no state folder: set ${env.stateHome} or ${env.userHome} in the environment`);
};

/**
 * Register a root the way `init` does: an entry in the factory list (a root that is listed already gets its entry
 * replaced) and the factory marker, unless the marker is there. The environment of the deps must name a state folder.
 */
export const registerRoot = (
  deps: FakeDeps,
  root: string,
  id: string,
  projects: readonly string[] = [],
  origin?: string,
): void => {
  const path = factoryListOf(deps);
  const found = deps.files.get(path);
  const known = found === undefined ? [] : (JSON.parse(found) as { homes: { home: string }[] }).homes;
  const entry = {
    [homeIndex.keys.home]: root,
    [homeIndex.keys.id]: id,
    [homeIndex.keys.projects]: projects,
    ...(origin === undefined ? {} : { [homeIndex.keys.origin]: origin }),
  };
  const homes = [...known.filter((candidate) => candidate.home !== root), entry];
  deps.seed(path, `${JSON.stringify({ [homeIndex.keys.schema]: homeIndex.schema, [homeIndex.keys.homes]: homes }, null, 2)}\n`);
  const marker = posix.join(root, dirs.state, fileNames.nodeState);
  if (!deps.files.has(marker)) {
    deps.seed(marker, `${JSON.stringify({ [stateKeys.schemaVersion]: STATE_SCHEMA_VERSION, [stateKeys.createdWith]: 'test', [stateKeys.blocks]: {} })}\n`);
  }
};

/**
 * A copy of the deps whose file calls report to `seen` first: the name of the call and its first path. The calls run
 * as before. A test uses it to see which paths a command touches, and when.
 */
export const withFsWatch = <T extends Deps>(deps: T, seen: (method: string, path: string) => void): T => {
  const watched = Object.fromEntries(
    Object.entries(deps.fs).map(([method, call]) => [
      method,
      (path: string, ...rest: readonly unknown[]): unknown => {
        seen(method, path);
        return (call as (...args: readonly unknown[]) => unknown)(path, ...rest);
      },
    ]),
  ) as unknown as Fs;
  return { ...deps, fs: watched };
};

/**
 * A copy of the deps whose writes fail. `fails` gets the path and the number of the write to that path, from 1.
 * The plain write and the atomic write fail in the same way.
 */
export const withFailingWrites = <T extends Deps>(
  deps: T,
  fails: (path: string, attempt: number) => boolean,
  message = 'disk full',
): T => {
  const attempts = new Map<string, number>();
  const guarded =
    (write: Fs['writeTextAtomic']): Fs['writeTextAtomic'] =>
    async (path, text, within, mode) => {
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      return fails(path, attempt) ? failure(`cannot write ${path}: ${message}`) : write(path, text, within, mode);
    };
  return {
    ...deps,
    fs: { ...deps.fs, writeText: guarded(deps.fs.writeText), writeTextAtomic: guarded(deps.fs.writeTextAtomic) },
  };
};
