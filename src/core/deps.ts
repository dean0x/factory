import type { CliResult } from '../cli/errors.js';

export type PathKind = 'file' | 'dir' | 'other';

/** The kind of a path itself: a link is a `link`, and `lstat` does not follow it. */
export type LinkKind = PathKind | 'link';

/** What a path is and who may use it. A link is followed. */
export interface PathInfo {
  readonly kind: PathKind;
  /** The id of the user that owns the path. */
  readonly uid: number;
  /** The permission bits only: 0o777 at most. */
  readonly mode: number;
  /** The time of the last change of the content, in milliseconds since the epoch. */
  readonly mtimeMs: number;
  /** The size of a file in bytes. A link is followed, so the size is the size of the target. */
  readonly size: number;
}

/** What a read of the whole file gives: its size, the SHA-256 of its bytes as hex, and its text when the file is small. */
export interface FileDigest {
  readonly size: number;
  readonly sha256: string;
  /** The text of the bytes that the hash covers, or null when the file has more than the limit of the call. */
  readonly text: string | null;
}

export interface Fs {
  readText(path: string): Promise<CliResult<string>>;
  /**
   * Read the file as a stream, and hash all of its bytes. A link is followed. The text comes from the same bytes as the
   * hash, so the text that a person sees is the text that the hash covers. A file with more than `textLimit` bytes gives
   * no text; the size and the hash still cover the whole file. The read stops at `maxBytes` plus one byte: the value is
   * null for a file with more than `maxBytes` bytes, and the rest stays unread.
   */
  digestFile(path: string, textLimit: number, maxBytes: number): Promise<CliResult<FileDigest | null>>;
  /** Read a file as text. It reads at most `maxBytes` plus one byte: a larger file is an error, and the rest stays unread. */
  readTextLimited(path: string, maxBytes: number): Promise<CliResult<string>>;
  writeText(path: string, text: string): Promise<CliResult<void>>;
  /**
   * Create a file that does not exist, with `mode`, and write the text. The value is true when this call created the
   * file, and false when the path exists already (a link counts, and it is not followed). Then nothing changes.
   */
  writeTextExclusive(path: string, text: string, mode: number): Promise<CliResult<boolean>>;
  /**
   * Write the text to a temporary file in the same folder, then rename it over the target.
   * A reader sees the old text or the new text, never a part. A failure leaves the target as it was.
   * The file gets `mode` when it is given. Else it keeps the mode of the file it replaces.
   * `within` is the folder that the caller means. The write is refused, and nothing changes, when the last part of the
   * path is a link (also a link whose target does not exist), or when the real path of the file is not inside the real
   * path of `within`. A link in `within` itself, or above it, is no reason to refuse.
   */
  writeTextAtomic(path: string, text: string, within: string, mode?: number): Promise<CliResult<void>>;
  /** The kind of the path, or null when it does not exist. */
  stat(path: string): Promise<CliResult<PathKind | null>>;
  /**
   * The kind of the path itself, or null when it does not exist. A link as the last part of the path is a `link`, also when
   * its target is missing. A link in a folder above the path is followed.
   */
  lstat(path: string): Promise<CliResult<LinkKind | null>>;
  /** The kind, the owner and the permission bits of the path, or null when it does not exist. */
  statInfo(path: string): Promise<CliResult<PathInfo | null>>;
  /** Set the permission bits of a file or a folder that exists. */
  chmod(path: string, mode: number): Promise<CliResult<void>>;
  /** The path with every link resolved. The path must exist. */
  realpath(path: string): Promise<CliResult<string>>;
  /** Create the folder and its parents. A folder that this call creates gets `mode` when it is given. */
  mkdir(path: string, mode?: number): Promise<CliResult<void>>;
  /** The sorted names inside a folder. */
  list(path: string): Promise<CliResult<readonly string[]>>;
  rename(from: string, to: string): Promise<CliResult<void>>;
  /** Remove a file or a folder tree. A missing path is not an error. */
  remove(path: string): Promise<CliResult<void>>;
  /** Remove a folder that holds nothing. A folder with content is an error. A missing path is not an error. */
  removeEmptyDir(path: string): Promise<CliResult<void>>;
  /**
   * Copy a file or a folder tree. Paths in `skip` are not copied. A link to a file as `from` is copied as a regular
   * file with the content of its target. Any other link is an error.
   */
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
  /**
   * The text for the standard input of the program. It is written as UTF-8, and then the input ends. A program that
   * ends before it reads all of the text is no error. The time limit applies as before. By default the program gets no text.
   */
  readonly input?: string;
  /**
   * True to start the program as the leader of a new process group with no terminal, and to stop every process of that
   * group when the time limit passes. A shell command with a pipe or a list starts more processes than the shell, and a
   * stop of the shell alone leaves them running. The run also stops its wait for the output at the limit. If the first
   * process does not end after the stop, the run ends a short time later with the failure of the stop. Not on Windows.
   */
  readonly processGroup?: boolean;
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

/** The answers that mean yes to a question of a command. Any other answer, and an empty one, means no. */
export const ACCEPT_ANSWER = /^y(?:es)?$/i;

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
  /**
   * Read the standard input of this process to its end, as UTF-8 text. It reads at most `maxBytes` plus one byte: an input
   * of more than `maxBytes` bytes is an error, and the rest stays unread. When a person types at the input, the value is
   * empty text at once, and nothing is read.
   */
  readStdin(maxBytes: number): Promise<CliResult<string>>;
  /** Ask one question and read one line of the answer, at most `MAX_ANSWER_CHARS` characters. The question goes to stderr. */
  prompt(question: string): Promise<CliResult<string>>;
  /**
   * Print one warning line to stderr at once. A command uses it for a warning that must show before the command acts,
   * for example before a session starts. A warning that can wait goes into the output of the command.
   */
  warn(message: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One GET request with a time limit. Any HTTP answer is a success. */
  fetch(url: string, timeoutMs: number): Promise<CliResult<FetchStatus>>;
  now(): Date;
  /** Wait for `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  readonly platform: Platform;
  readonly cwd: string;
  readonly pid: number;
  /** The id of the user that runs this process, or null on a platform that has no user ids. */
  readonly uid: number | null;
}
