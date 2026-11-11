import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
  /** The text that the caller gave to the standard input of the program. */
  readonly input?: string;
  /** True when the caller asked to run the program in its own process group. */
  readonly processGroup?: boolean;
  /** The signal that stops the program when it aborts. */
  readonly signal?: AbortSignal;
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
  /** The node program and the real path of the script. Default: `FAKE_PROGRAM_ARGV`. */
  readonly programArgv?: readonly string[];
  /** The id of the user of the process. Default: 1000. Null: a platform with no user ids. */
  readonly uid?: number | null;
  /** A person types at the process. Default: false. */
  readonly stdinIsTTY?: boolean;
  /** A person reads the output on a terminal. Default: false. It is the start value of `stdoutIsTerminal`, and `setStdoutTerminal` changes that one. */
  readonly stdoutIsTTY?: boolean;
  /** The id of the parent process at the start. Default: 500. `setParentPid` changes it. */
  readonly parentPid?: number;
  /** The text on the standard input, as `readStdin` reads it. A terminal gives no text. Default: empty. */
  readonly stdin?: string;
  /** The answer to a question. Default: no answer. */
  readonly prompt?: PromptHandler;
  /** The result of a program that uses the terminal. Default: exit code 0. */
  readonly runAttached?: AttachedHandler;
  /** Links: a path under a key resolves to the same path under the value. `lstat` gives `link` for a key itself. */
  readonly links?: Readonly<Record<string, string>>;
  /**
   * After a TERM, a process still runs for this many checks of `isRunning`, and then it ends. Default: 0, so the first check
   * finds it ended. Infinity: it never ends.
   */
  readonly termEndsAfterChecks?: number;
  /** The text of a failure of `terminate`, for example for a process of another user. Default: the call works. */
  readonly terminateFails?: string;
}

/** The count of bytes that the fake `randomHex` accepts at most, as the real call does. */
const MAX_RANDOM_BYTES = 64;

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
  /**
   * The paths whose bytes are not UTF-8. The text in `files` is what a lenient read gives (it holds U+FFFD for the bad bytes), and a
   * read with the `fatal` decode fails for the path.
   */
  readonly invalidUtf8: Set<string>;
  /** The waits of `sleep`, in order. */
  readonly sleeps: number[];
  /** The texts that `writeStdout` took, in order. */
  readonly written: string[];
  /** Change the parent process id that `parentPid` gives from now on. */
  setParentPid(pid: number): void;
  /** Change the value that `stdoutIsTerminal` gives from now on. */
  setStdoutTerminal(value: boolean): void;
  /** The pids that `terminate` got, in order. The fake sends no signal to a real process. The call has no other signal. */
  readonly terminated: number[];
  /** The pids that `isRunning` got, in order. */
  readonly checked: number[];
  /** The texts that `randomHex` gave, in order. The first is 1, the next is 2, and so on, as hex text of the asked length. */
  readonly randomTexts: string[];
  /** The signals of the process. A test sends a signal with `emit`, and counts the handlers with `listenerCount`. */
  readonly signals: EventEmitter;
  /** Move the clock on by `ms` milliseconds. `sleep` does the same. */
  advance(ms: number): void;
  seed(path: string, text: string): void;
  seedDir(path: string): void;
}

export const exited = (exitCode: number, stdout = '', stderr = ''): CliResult<RunOutput> =>
  ok({ exitCode, stdout, stderr });

export const missingProgram = (command: string): CliResult<RunOutput> =>
  failure(`cannot run ${command}: ENOENT`);

/** The program path of a fake process: the node program and the script, both absolute. */
export const FAKE_PROGRAM_ARGV: readonly string[] = ['/opt/fake/bin/node', '/opt/fake/lib/program/cli.js'];

const DEFAULT_NOW = new Date('2030-01-02T03:04:05.678Z');
const DEFAULT_UID = 1000;
const DEFAULT_PARENT_PID = 500;
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
  const invalidUtf8 = new Set<string>();
  const sleeps: number[] = [];
  const written: string[] = [];
  let parentPid = options.parentPid ?? DEFAULT_PARENT_PID;
  let stdoutTerminal = options.stdoutIsTTY ?? false;
  const terminated: number[] = [];
  const checked: number[] = [];
  const randomTexts: string[] = [];
  /** A pid that got a TERM, with the number of checks that still find it running. A pid that ended is removed. */
  const checksLeft = new Map<number, number>();
  const ended = new Set<number>();
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
    invalidUtf8,
    sleeps,
    written,
    setParentPid: (pid) => {
      parentPid = pid;
    },
    setStdoutTerminal: (value) => {
      stdoutTerminal = value;
    },
    terminated,
    checked,
    randomTexts,
    randomHex: (bytes) => {
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_RANDOM_BYTES) return failure(`cannot make random text for ${bytes} bytes`);
      const text = (randomTexts.length + 1).toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
      randomTexts.push(text);
      return ok(text);
    },
    signals: new EventEmitter(),
    terminate: (pid) => {
      terminated.push(pid);
      if (options.terminateFails !== undefined) return failure(`cannot signal the process ${pid}: ${options.terminateFails}`);
      if (ended.has(pid)) return ok('gone');
      checksLeft.set(pid, options.termEndsAfterChecks ?? 0);
      return ok('sent');
    },
    isRunning: (pid) => {
      checked.push(pid);
      const left = checksLeft.get(pid);
      if (left === undefined) return ok(!ended.has(pid));
      if (left > 0) {
        checksLeft.set(pid, left - 1);
        return ok(true);
      }
      checksLeft.delete(pid);
      ended.add(pid);
      return ok(false);
    },
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
      readTextLimited: async (path, maxBytes, decode = 'lenient') => {
        const text = files.get(path);
        if (text === undefined) return enoent('read', path);
        if (Buffer.byteLength(text, 'utf8') > maxBytes) return failure(`cannot read ${path}: larger than ${maxBytes} bytes`);
        // The fake keeps decoded text, so the paths in `invalidUtf8` stand for bytes that only a lenient decode can read.
        return decode === 'fatal' && invalidUtf8.has(path) ? failure(`cannot read ${path}: the bytes are not valid UTF-8`) : ok(text);
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
      listLimited: async (path, limit) => {
        if (!Number.isInteger(limit) || limit < 0) return failure(`cannot list ${path}: the limit ${limit} is not a whole number, 0 or more`);
        const names = await fake.fs.list(path);
        return names.ok ? ok(names.value.slice(0, limit)) : names;
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
        // The modes follow the paths, as the modes of real files do.
        for (const [key, mode] of [...modes.entries()].filter(([key]) => under(from, key))) {
          modes.delete(key);
          modes.set(to + key.slice(from.length), mode);
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
        ...(runOptions?.input === undefined ? {} : { input: runOptions.input }),
        ...(runOptions?.processGroup === undefined ? {} : { processGroup: runOptions.processGroup }),
        ...(runOptions?.signal === undefined ? {} : { signal: runOptions.signal }),
      };
      calls.push(call);
      const result = (options.run ?? (() => missingProgram(command)))(call);
      // As real git does: `git init` makes the folder `.git` in the folder.
      if (command === 'git' && args[0] === '-C' && args[2] === 'init' && result.ok && result.value.exitCode === 0) {
        addDir(posix.join(args[1] ?? '', '.git'));
      }
      return result;
    },
    runAttached: async (command: string, args: readonly string[]) => {
      const call: RunCall = { command, args, cwd: undefined };
      attached.push(call);
      return (options.runAttached ?? (() => ok(0)))(call);
    },
    stdinIsTTY: options.stdinIsTTY ?? false,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    stdoutIsTerminal: () => stdoutTerminal,
    parentPid: () => parentPid,
    writeStdout: async (text) => {
      written.push(text);
      return ok(undefined);
    },
    readStdin: async (maxBytes) => {
      // The same results as the real read: a terminal gives empty text, and an input over the limit is an error.
      if (options.stdinIsTTY === true) return ok('');
      const text = options.stdin ?? '';
      return Buffer.byteLength(text, 'utf8') > maxBytes ? failure(`cannot read stdin: larger than ${maxBytes} bytes`) : ok(text);
    },
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
    programArgv: options.programArgv ?? FAKE_PROGRAM_ARGV,
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
 * A copy of the deps whose removal of a file fails for the paths that `fails` names. The lock file of a private file that
 * stays after a saved change is the case: the change is written, and only the removal of the lock file fails.
 */
export const withFailingRemoves = <T extends Deps>(deps: T, fails: (path: string) => boolean, message = 'EBUSY'): T => ({
  ...deps,
  fs: { ...deps.fs, remove: async (path) => (fails(path) ? failure(`cannot remove ${path}: ${message}`) : deps.fs.remove(path)) },
});

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
