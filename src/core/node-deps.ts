import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
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
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { failure, type CliResult } from '../cli/errors.js';
import { ok } from './result.js';
import { MAX_ANSWER_CHARS, type Deps, type Fs, type PathKind } from './deps.js';

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

/** Write beside the target, then rename. A link is followed, so the link stays and its target changes. */
const writeAtomic = async (path: string, text: string, mode: number | undefined): Promise<void> => {
  const target = await realpath(path).catch((cause: unknown) => {
    if (errorCode(cause) === 'ENOENT') return path;
    throw cause;
  });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    const info = await stat(target).catch(() => null);
    await writeFile(temporary, text, 'utf8');
    if (mode !== undefined) await chmod(temporary, mode);
    else if (info?.isFile() === true) await chmod(temporary, info.mode & 0o777);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
};

const MAX_COPY_DEPTH = 64;

const unsupported = (code: string): Error => Object.assign(new Error(code), { code });

/**
 * Copy a file or a folder tree. The target may be inside the source: the paths in `skip`
 * are left out, and fs.cp would refuse this case. The tree must hold only files and folders.
 */
const copyEntry = async (from: string, to: string, skip: readonly string[], depth: number): Promise<void> => {
  if (skip.includes(from)) return;
  if (depth > MAX_COPY_DEPTH) throw unsupported('ETOODEEP');
  const info = await lstat(from);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) await copyEntry(join(from, name), join(to, name), skip, depth + 1);
  } else if (info.isFile()) {
    await copyFile(from, to, constants.COPYFILE_EXCL);
  } else {
    throw unsupported('ENOTSUP');
  }
};

const nodeFs: Fs = {
  readText: (path) => guard('read', path, () => readFile(path, 'utf8')),
  writeText: (path, text) => guard('write', path, () => writeFile(path, text, 'utf8')),
  writeTextAtomic: (path, text, mode) => guard('write', path, () => writeAtomic(path, text, mode)),
  stat: async (path) => {
    try {
      const info = await stat(path);
      const kind: PathKind = info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other';
      return ok(kind);
    } catch (cause) {
      return errorCode(cause) === 'ENOENT' ? ok(null) : failure(`cannot stat ${path}: ${errorCode(cause)}`);
    }
  },
  realpath: (path) => guard('resolve', path, () => realpath(path)),
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
  platform: { os: process.platform, nodeVersion: process.version },
  cwd: process.cwd(),
  pid: process.pid,
});
