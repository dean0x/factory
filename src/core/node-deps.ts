import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { failure, type CliResult } from '../cli/errors.js';
import { isSameOrInside } from './paths.js';
import { ok } from './result.js';
import { MAX_ANSWER_CHARS, type Deps, type FileDigest, type Fs, type LinkKind, type PathInfo, type PathKind } from './deps.js';

const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_RUN_OUTPUT_BYTES = 1_048_576;

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

/** Hash every byte of the file as a stream. The bytes stay in memory only while the file is within `textLimit`. */
const digestBytes = async (path: string, textLimit: number): Promise<FileDigest> => {
  const hash = createHash('sha256');
  const kept: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
    if (size <= textLimit) kept.push(bytes);
    else kept.length = 0;
  }
  return { size, sha256: hash.digest('hex'), text: size <= textLimit ? Buffer.concat(kept).toString('utf8') : null };
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

const nodeFs: Fs = {
  readText: (path) => guard('read', path, () => readFile(path, 'utf8')),
  readTextLimited: async (path, maxBytes) => {
    const text = await guard('read', path, () => readBounded(path, maxBytes));
    if (!text.ok) return text;
    return text.value === null ? failure(`cannot read ${path}: larger than ${maxBytes} bytes`) : ok(text.value);
  },
  digestFile: (path, textLimit) => guard('read', path, () => digestBytes(path, textLimit)),
  writeText: (path, text) => guard('write', path, () => writeFile(path, text, 'utf8')),
  writeTextExclusive: (path, text, mode) =>
    guard('write', path, async () => {
      try {
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode });
        return true;
      } catch (cause) {
        if (errorCode(cause) === 'EEXIST') return false;
        throw cause;
      }
    }),
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

export const createNodeDeps = (): Deps => ({
  fs: nodeFs,
  run: (command, args, options) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        {
          cwd: options?.cwd ?? process.cwd(),
          timeout: options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          maxBuffer: MAX_RUN_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
          env: options?.inheritEnv === true ? process.env : { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
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
    }),
  runAttached: (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: 'inherit', windowsHide: true });
      child.once('error', (error) => resolve(failure(`cannot run ${command}: ${errorCode(error)}`)));
      child.once('close', (code, signal) =>
        resolve(code === null ? failure(`${command} was stopped by ${String(signal)}`) : ok(code)),
      );
    }),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
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
  env: process.env,
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
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
});
