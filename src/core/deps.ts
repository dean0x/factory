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
  /** The path with every link resolved. The path must exist. */
  realpath(path: string): Promise<CliResult<string>>;
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
  /**
   * Run the program with the environment of this process as it is. By default the locale is C and git asks no question,
   * so that the output is the same everywhere. A program that starts other programs, such as the tmux server,
   * would pass that environment on to them.
   */
  readonly inheritEnv?: boolean;
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

/** The longest answer that `prompt` returns. A longer line is cut. */
export const MAX_ANSWER_CHARS = 200;

export interface Deps {
  readonly fs: Fs;
  /** Run a program. It never uses a shell. A non-zero exit code is not an error. */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CliResult<RunOutput>>;
  /**
   * Run a program with the terminal of this process: it reads the keys and draws on the screen.
   * It never uses a shell. The result is the exit code of the program.
   */
  runAttached(command: string, args: readonly string[]): Promise<CliResult<number>>;
  /** True when a person types at this process. */
  readonly stdinIsTTY: boolean;
  /** True when a person reads the output of this process on a terminal. */
  readonly stdoutIsTTY: boolean;
  /** Ask one question and read one line of the answer, at most `MAX_ANSWER_CHARS` characters. The question goes to stderr. */
  prompt(question: string): Promise<CliResult<string>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One GET request with a time limit. Any HTTP answer is a success. */
  fetch(url: string, timeoutMs: number): Promise<CliResult<FetchStatus>>;
  now(): Date;
  readonly platform: Platform;
  readonly cwd: string;
  readonly pid: number;
}
