import type { CliResult } from '../cli/errors.js';

export type PathKind = 'file' | 'dir' | 'other';

export interface Fs {
  readText(path: string): Promise<CliResult<string>>;
  writeText(path: string, text: string): Promise<CliResult<void>>;
  /**
   * Write the text to a temporary file in the same folder, then rename it over the target.
   * A reader sees the old text or the new text, never a part. A failure leaves the target as it was.
   */
  writeTextAtomic(path: string, text: string): Promise<CliResult<void>>;
  /** The kind of the path, or null when it does not exist. */
  stat(path: string): Promise<CliResult<PathKind | null>>;
  /** Create the folder and its parents. */
  mkdir(path: string): Promise<CliResult<void>>;
  /** The sorted names inside a folder. */
  list(path: string): Promise<CliResult<readonly string[]>>;
  rename(from: string, to: string): Promise<CliResult<void>>;
  /** Remove a file or a folder tree. A missing path is not an error. */
  remove(path: string): Promise<CliResult<void>>;
  /** Remove a folder that holds nothing. A folder with content is an error. A missing path is not an error. */
  removeEmptyDir(path: string): Promise<CliResult<void>>;
  /** Copy a file or a folder tree. Paths in `skip` are not copied. */
  copyTree(from: string, to: string, skip: readonly string[]): Promise<CliResult<void>>;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface RunOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Platform {
  readonly os: string;
  readonly nodeVersion: string;
}

export interface FetchStatus {
  readonly status: number;
}

export interface Deps {
  readonly fs: Fs;
  /** Run a program. It never uses a shell. A non-zero exit code is not an error. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CliResult<RunOutput>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One GET request with a time limit. Any HTTP answer is a success. */
  fetch(url: string, timeoutMs: number): Promise<CliResult<FetchStatus>>;
  now(): Date;
  readonly platform: Platform;
  readonly cwd: string;
  readonly pid: number;
}
