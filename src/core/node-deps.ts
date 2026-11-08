import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, realpathSync, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { failure, type CliResult } from '../cli/errors.js';
import { renderWarnings } from '../cli/output.js';
import { hookNames } from '../names.js';
import { isSameOrInside } from './paths.js';
import { ok } from './result.js';
import {
  MAX_ANSWER_CHARS,
  type Deps,
  type FileDigest,
  type Fs,
  type LinkKind,
  type PathInfo,
  type PathKind,
  type RunOptions,
  type RunOutput,
} from './deps.js';

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_OUTPUT_BYTES = 1_048_576;
/** The value of `process.platform` on native Windows, which has no process groups of this kind. */
const NATIVE_WINDOWS = 'win32';
/** The signal that stops a process group at the time limit. A process can not catch it. */
const GROUP_STOP_SIGNAL = 'SIGKILL';
/** After the stop of a group, the run waits this long for the first process to end. Then the run ends without it. */
const GROUP_STOP_GRACE_MS = 200;
/** The code that Node gives to the error of an abort. A run that is aborted before it starts fails with this code. */
const ABORT_CODE = 'ABORT_ERR';

const errorCode = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code: unknown }).code);
  }
  return 'error';
};

const guard = async <T>(action: string, path: string, work: () => Promise<T>): Promise<CliResult<T>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return failure(`cannot ${action} ${path}: ${errorCode(cause)}`);
  }
};

/** The mode of a new file that has no mode from the caller and replaces no file. The umask takes bits from it. */
const DEFAULT_FILE_MODE = 0o666;
const TEMPORARY_SUFFIX_BYTES = 8;

/** The text of the file, or null when the file holds more than `maxBytes`. At most `maxBytes` plus one byte is read. */
const readBounded = async (path: string, maxBytes: number): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path, { start: 0, end: maxBytes })) {
    const bytes = chunk as Buffer;
    chunks.push(bytes);
    size += bytes.length;
  }
  return size > maxBytes ? null : Buffer.concat(chunks).toString('utf8');
};

/**
 * Hash every byte of the file as a stream, or give null when the file holds more than `maxBytes`. At most `maxBytes` plus
 * one byte is read. The bytes stay in memory only while the file is within `textLimit`.
 */
const digestBytes = async (path: string, textLimit: number, maxBytes: number): Promise<FileDigest | null> => {
  const hash = createHash('sha256');
  const kept: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path, { start: 0, end: maxBytes })) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
    if (size <= textLimit) kept.push(bytes);
    else kept.length = 0;
  }
  if (size > maxBytes) return null;
  return { size, sha256: hash.digest('hex'), text: size <= textLimit ? Buffer.concat(kept).toString('utf8') : null };
};

/**
 * The text of the input, or null when it holds more than `maxBytes`. At most `maxBytes` plus one byte is kept, and the
 * rest of an input that is too large stays unread: the stream is closed. When the input is not whole after `timeoutMs`
 * milliseconds, the stream is closed and the read fails with the code ETIMEDOUT. The timer ends with the read.
 */
const readStreamBounded = async (input: Readable, maxBytes: number, timeoutMs: number): Promise<string | null> => {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => input.destroy(Object.assign(new Error('the input is not whole in time'), { code: 'ETIMEDOUT' })), timeoutMs);
  try {
    for await (const chunk of input) {
      const kept = (chunk as Buffer).subarray(0, maxBytes + 1 - size);
      chunks.push(kept);
      size += kept.length;
      if (size > maxBytes) return null;
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** True when a person types at the standard input of this process. */
const stdinIsTerminal = (): boolean => process.stdin.isTTY === true;

/** The standard input as text. A terminal gives empty text at once: it has no end, so a read would wait for a person. */
const readStdin = async (maxBytes: number): Promise<CliResult<string>> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return failure(`cannot read stdin: ${maxBytes} is not a number of bytes`);
  }
  if (stdinIsTerminal()) return ok('');
  const text = await guard('read', 'stdin', () => readStreamBounded(process.stdin, maxBytes, hookNames.stdinTimeoutMs));
  if (!text.ok) return text;
  return text.value === null ? failure(`cannot read stdin: larger than ${maxBytes} bytes`) : ok(text.value);
};

const MAX_COPY_DEPTH = 64;

const unsupported = (code: string): Error => Object.assign(new Error(code), { code });

/** A file, or the root of the copy when it is a link to a file. A link inside a tree is not followed. */
const isCopyableFile = async (from: string, info: Stats, depth: number): Promise<boolean> =>
  info.isFile() || (depth === 0 && info.isSymbolicLink() && (await stat(from)).isFile());

/**
 * Copy a file or a folder tree. The target may be inside the source: the paths in `skip`
 * are left out, and fs.cp would refuse this case. The tree must hold only files and folders.
 * A link to a file as the root is copied as a regular file with the content of its target.
 */
const copyEntry = async (from: string, to: string, skip: readonly string[], depth: number): Promise<void> => {
  if (skip.includes(from)) return;
  if (depth > MAX_COPY_DEPTH) throw unsupported('ETOODEEP');
  const info = await lstat(from);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) await copyEntry(join(from, name), join(to, name), skip, depth + 1);
  } else if (await isCopyableFile(from, info, depth)) {
    await copyFile(from, to, constants.COPYFILE_EXCL);
  } else {
    throw unsupported('ENOTSUP');
  }
};

const PERMISSION_BITS = 0o777;

const pathKindOf = (info: { isFile(): boolean; isDirectory(): boolean }): PathKind => {
  if (info.isFile()) return 'file';
  return info.isDirectory() ? 'dir' : 'other';
};

const statInfo = async (path: string): Promise<CliResult<PathInfo | null>> => {
  try {
    const info = await stat(path);
    return ok({
      kind: pathKindOf(info),
      uid: info.uid,
      mode: info.mode & PERMISSION_BITS,
      mtimeMs: info.mtimeMs,
      size: info.size,
    });
  } catch (cause) {
    return errorCode(cause) === 'ENOENT' ? ok(null) : failure(`cannot stat ${path}: ${errorCode(cause)}`);
  }
};

/** A path that does not exist, or that has a file where a folder should be, has no kind. */
const MISSING_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

const linkKind = async (path: string): Promise<CliResult<LinkKind | null>> => {
  try {
    const info = await lstat(path);
    return ok(info.isSymbolicLink() ? 'link' : pathKindOf(info));
  } catch (cause) {
    return MISSING_CODES.includes(errorCode(cause)) ? ok(null) : failure(`cannot stat ${path}: ${errorCode(cause)}`);
  }
};

/** The path with its links resolved. */
const resolved = (path: string): Promise<CliResult<string>> => guard('resolve', path, () => realpath(path));

/** The path in the form that is compared: macOS has a file system that ignores the case of letters. */
const comparablePath = (path: string): string => (process.platform === 'darwin' ? path.toLowerCase() : path);

/**
 * The path that an atomic write changes: the real folder of the path with the last name. The write is refused when the
 * last part of the path is a link, also a link whose target does not exist, or when that path is not inside the real
 * path of `within`. The write uses the path that this check returns.
 */
const checkedTarget = async (path: string, within: string): Promise<CliResult<string>> => {
  const kind = await linkKind(path);
  if (!kind.ok) return kind;
  if (kind.value === 'link') return failure(`cannot write ${path}: it is a link`);
  const [folder, parent] = [await resolved(within), await resolved(dirname(path))];
  if (!folder.ok) return folder;
  if (!parent.ok) return parent;
  const target = join(parent.value, basename(path));
  if (!isSameOrInside(comparablePath(folder.value), comparablePath(target))) {
    return failure(`cannot write ${path}: it is outside ${within}`);
  }
  return ok(target);
};

/**
 * Write beside the target, then rename. The target is never a link, and it is inside the folder that the caller names.
 * The temporary file is new, has a name that others cannot guess, and has its final mode from the start.
 */
const writeAtomic = async (path: string, text: string, within: string, mode: number | undefined): Promise<CliResult<void>> => {
  const target = await checkedTarget(path, within);
  if (!target.ok) return target;
  return guard('write', path, async () => {
    const temporary = `${target.value}.tmp-${process.pid}-${randomBytes(TEMPORARY_SUFFIX_BYTES).toString('hex')}`;
    try {
      const info = await stat(target.value).catch(() => null);
      const finalMode = mode ?? (info?.isFile() === true ? info.mode & 0o777 : undefined);
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: finalMode ?? DEFAULT_FILE_MODE });
      if (finalMode !== undefined) await chmod(temporary, finalMode);
      await rename(temporary, target.value);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  });
};

/**
 * Remove the file at `path` after a failed write, but only when the path still holds the file that the write created
 * (`created`). A file that another process put there in the meantime stays. With no knowledge of the created file, the
 * file at the path is removed: the path was new when the write began.
 */
const removeCreated = async (path: string, created: Stats | undefined): Promise<void> => {
  const now = await lstat(path).catch(() => null);
  if (now === null) return;
  if (created !== undefined && (now.dev !== created.dev || now.ino !== created.ino)) return;
  await rm(path, { force: true }).catch(() => undefined);
};

/**
 * Create the file with the flag `wx` and write the text. The value is false when the path exists already. A write that
 * fails after the create (a full disk, an I/O error) closes the file and removes it, so the failure leaves no part of a file.
 */
const createExclusive = async (path: string, text: string, mode: number): Promise<boolean> => {
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx', mode);
  } catch (cause) {
    if (errorCode(cause) === 'EEXIST') return false;
    throw cause;
  }
  let created: Stats | undefined;
  try {
    created = await handle.stat();
    await handle.writeFile(text, 'utf8');
    await handle.close();
    return true;
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await removeCreated(path, created);
    throw cause;
  }
};

const nodeFs: Fs = {
  readText: (path) => guard('read', path, () => readFile(path, 'utf8')),
  readTextLimited: async (path, maxBytes) => {
    const text = await guard('read', path, () => readBounded(path, maxBytes));
    if (!text.ok) return text;
    return text.value === null ? failure(`cannot read ${path}: larger than ${maxBytes} bytes`) : ok(text.value);
  },
  digestFile: (path, textLimit, maxBytes) => guard('read', path, () => digestBytes(path, textLimit, maxBytes)),
  writeText: (path, text) => guard('write', path, () => writeFile(path, text, 'utf8')),
  writeTextExclusive: (path, text, mode) => guard('write', path, () => createExclusive(path, text, mode)),
  writeTextAtomic: (path, text, within, mode) => writeAtomic(path, text, within, mode),
  stat: async (path) => {
    const info = await statInfo(path);
    return info.ok ? ok(info.value?.kind ?? null) : info;
  },
  statInfo,
  lstat: linkKind,
  chmod: (path, mode) => guard('change the mode of', path, () => chmod(path, mode)),
  realpath: resolved,
  mkdir: (path, mode) =>
    guard('create', path, async () => void (await mkdir(path, mode === undefined ? { recursive: true } : { recursive: true, mode }))),
  list: (path) => guard('list', path, async () => (await readdir(path)).sort()),
  rename: (from, to) => guard('rename', from, () => rename(from, to)),
  remove: (path) => guard('remove', path, () => rm(path, { recursive: true, force: true })),
  removeEmptyDir: async (path) => {
    try {
      await rmdir(path);
      return ok(undefined);
    } catch (cause) {
      return errorCode(cause) === 'ENOENT' ? ok(undefined) : failure(`cannot remove ${path}: ${errorCode(cause)}`);
    }
  },
  copyTree: (from, to, skip) => guard('copy', from, () => copyEntry(from, to, skip, 0)),
};

/** The environment of a program: the one of this process as it is, or with the C locale and no prompt of git. */
const runEnvOf = (options: RunOptions | undefined): NodeJS.ProcessEnv =>
  options?.inheritEnv === true ? process.env : { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };

/** Write the text to the standard input of the program, then end that input. With no text, the input stays as it is. */
const feedInput = (stdin: Writable | null, input: string | undefined): void => {
  if (input === undefined) return;
  // A program that ends before it reads the text closes the pipe: that is no error of this run.
  stdin?.once('error', () => undefined);
  stdin?.end(input, 'utf8');
};

const runPlain = (command: string, args: readonly string[], options: RunOptions | undefined): Promise<CliResult<RunOutput>> =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options?.cwd ?? process.cwd(),
        timeout: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        maxBuffer: MAX_RUN_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
        env: runEnvOf(options),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(ok({ exitCode: 0, stdout, stderr }));
        } else if (typeof error.code === 'number') {
          resolve(ok({ exitCode: error.code, stdout, stderr }));
        } else {
          resolve(failure(`cannot run ${command}: ${String(error.code ?? error.signal ?? 'error')}`));
        }
      },
    );
    feedInput(child.stdin, options?.input);
  });

/** Stop every process of the group that `pid` leads. */
const stopGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, GROUP_STOP_SIGNAL);
  } catch {
    // The group has no process left (ESRCH): the run ends the same way.
  }
};

/**
 * Run the program as the leader of a new process group (`RunOptions.processGroup`). At the time limit, or when the output
 * passes the byte cap, every process of the group is stopped and the output pipes are closed. So the run ends at the limit
 * also when a process outside the group holds a pipe. The run ends when the first process has ended and the pipes are
 * closed. If the stop does not end the first process, the run ends `GROUP_STOP_GRACE_MS` after the stop, with the failure
 * of the stop. The abort of `RunOptions.signal` stops the group in the same way. The value has the same form as the value
 * of `runPlain`.
 */
const runInGroup = (command: string, args: readonly string[], options: RunOptions): Promise<CliResult<RunOutput>> =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve(failure(`cannot run ${command}: ${ABORT_CODE}`));
      return;
    }
    const child = spawn(command, [...args], { cwd: options.cwd ?? process.cwd(), env: runEnvOf(options), detached: true });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0, tooLarge: false };
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8');
    const timers: { limit?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};
    let settled = false;

    const settle = (result: CliResult<RunOutput>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.limit);
      clearTimeout(timers.grace);
      options.signal?.removeEventListener('abort', stop);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('close', onClose);
      resolve(result);
    };
    const stoppedResult = (): CliResult<RunOutput> =>
      output.tooLarge
        ? failure(`cannot run ${command}: its output is larger than ${MAX_RUN_OUTPUT_BYTES} bytes`)
        : failure(`cannot run ${command}: ${GROUP_STOP_SIGNAL}`);
    const stop = (): void => {
      stopGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      // The first process may stay alive after the stop. Then the run does not wait for its end.
      timers.grace ??= setTimeout(() => {
        child.stdin.destroy();
        child.unref();
        settle(stoppedResult());
      }, GROUP_STOP_GRACE_MS);
    };
    const keep =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        output.bytes += chunk.length;
        if (output.bytes <= MAX_RUN_OUTPUT_BYTES) chunks.push(chunk);
        else {
          output.tooLarge = true;
          stop();
        }
      };
    const onStdout = keep(output.stdout);
    const onStderr = keep(output.stderr);
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (output.tooLarge) settle(stoppedResult());
      else if (code === null) settle(failure(`cannot run ${command}: ${String(signal ?? 'error')}`));
      else settle(ok({ exitCode: code, stdout: text(output.stdout), stderr: text(output.stderr) }));
    };

    timers.limit = setTimeout(stop, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    // This listener stays after the run ends: an error event with no listener would end the process.
    child.on('error', (error) => settle(failure(`cannot run ${command}: ${errorCode(error)}`)));
    child.on('close', onClose);
    feedInput(child.stdin, options.input);
  });

/** The largest pid of a 32-bit pid_t. A pid of 0 or 1, or a negative pid, names a process group or every process. */
const MAX_PID = 2_147_483_647;
const FIRST_SIGNALLED_PID = 2;

/** The pid must be a whole number that names one process other than init, and not the process of this program. */
const checkedPid = (pid: number): CliResult<number> =>
  Number.isSafeInteger(pid) && pid >= FIRST_SIGNALLED_PID && pid <= MAX_PID && pid !== process.pid
    ? ok(pid)
    : failure(`cannot signal the process ${String(pid)}: it is not the pid of one other process`);

/** The signal of a call: TERM ends the process, and 0 only asks whether the process exists. */
type ProcessSignal = 'SIGTERM' | 0;

/** Send the signal to the process. The value is false when no process has the pid. EPERM means that the process exists. */
const signalProcess = (pid: number, signal: ProcessSignal): CliResult<boolean> => {
  try {
    process.kill(pid, signal);
    return ok(true);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'ESRCH') return ok(false);
    if (code === 'EPERM' && signal === 0) return ok(true);
    return failure(`cannot signal the process ${pid}: ${code}`);
  }
};

const terminateProcess = (pid: number): CliResult<'sent' | 'gone'> => {
  const checked = checkedPid(pid);
  if (!checked.ok) return checked;
  const sent = signalProcess(checked.value, 'SIGTERM');
  return sent.ok ? ok(sent.value ? 'sent' : 'gone') : sent;
};

/** The time limit for the read of the state of one process. */
const PROCESS_STATE_TIMEOUT_MS = 2_000;
/** The first letter of the state that `ps` prints for a process that has ended and waits for its parent to collect its exit status. */
const ZOMBIE_STATE = 'Z';

/**
 * True only when `ps` says that the process is a zombie: it has ended, and only its entry in the process table is left until its
 * parent collects the exit status. The signal 0 still reaches a zombie. Any other result (no `ps`, a failed call, a timeout, an
 * answer that is empty or not a state) is false, so a process that may run is never counted as ended.
 */
const isZombie = (pid: number): boolean => {
  const read = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: PROCESS_STATE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return read.status === 0 && read.stdout.trim().startsWith(ZOMBIE_STATE);
};

const processRuns = (pid: number): CliResult<boolean> => {
  const checked = checkedPid(pid);
  if (!checked.ok) return checked;
  const signalled = signalProcess(checked.value, 0);
  return signalled.ok && signalled.value ? ok(!isZombie(checked.value)) : signalled;
};

const MAX_RANDOM_BYTES = 64;

const randomHexText = (bytes: number): CliResult<string> =>
  Number.isInteger(bytes) && bytes >= 1 && bytes <= MAX_RANDOM_BYTES
    ? ok(randomBytes(bytes).toString('hex'))
    : failure(`cannot make random text: ${bytes} bytes is not a whole number from 1 to ${MAX_RANDOM_BYTES}`);

/**
 * The node program and the real path of the script, which is the second word of the arguments of a process. An empty list when the
 * process has no script path or the path cannot be resolved: a made-up path would start another program.
 */
export const programArgvOf = (execPath: string, script: string | undefined): readonly string[] => {
  if (script === undefined) return [];
  try {
    return [execPath, realpathSync(script)];
  } catch {
    return [];
  }
};

export const createNodeDeps = (): Deps => ({
  fs: nodeFs,
  run: (command, args, options) =>
    options?.processGroup === true && process.platform !== NATIVE_WINDOWS
      ? runInGroup(command, args, options)
      : runPlain(command, args, options),
  runAttached: (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: 'inherit', windowsHide: true });
      child.once('error', (error) => resolve(failure(`cannot run ${command}: ${errorCode(error)}`)));
      child.once('close', (code, signal) =>
        resolve(code === null ? failure(`${command} was stopped by ${String(signal)}`) : ok(code)),
      );
    }),
  stdinIsTTY: stdinIsTerminal(),
  stdoutIsTTY: process.stdout.isTTY === true,
  readStdin,
  prompt: (question) =>
    new Promise((resolve) => {
      const lines = createInterface({ input: process.stdin, output: process.stderr });
      let answered = false;
      lines.once('close', () => {
        if (!answered) resolve(failure('no answer was given'));
      });
      lines.question(question, (answer) => {
        answered = true;
        lines.close();
        resolve(ok(answer.slice(0, MAX_ANSWER_CHARS)));
      });
    }),
  warn: (message) => {
    process.stderr.write(renderWarnings([message]));
  },
  env: process.env,
  signals: process,
  terminate: terminateProcess,
  isRunning: processRuns,
  randomHex: randomHexText,
  fetch: async (url, timeoutMs) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      await response.body?.cancel();
      return ok({ status: response.status });
    } catch {
      return failure('no answer');
    }
  },
  now: () => new Date(),
  sleep: (ms) => wait(ms),
  platform: { os: process.platform, nodeVersion: process.version },
  cwd: process.cwd(),
  pid: process.pid,
  programArgv: programArgvOf(process.execPath, process.argv[1]),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
});
