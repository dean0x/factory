import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TrackerCopy, TrackerWrite } from '../../src/board/local.js';
import { failure, type CliResult } from '../../src/cli/errors.js';
import type { RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { files } from '../../src/names.js';
import { installGuard } from '../../src/state/guard.js';
import { layoutOf } from '../../src/state/layout.js';
import { exited, type FakeDeps, type RunCall } from './fake-deps.js';
import { withoutStateWords } from './git-fake.js';
import { HOME, make, STATE } from './guard-fixture.js';

/**
 * A fake state repo for the tests of the board writes. The delete guard is on, the files of the board are in the work tree, and the
 * fake git knows the board at the last commit. A commit of the helper moves the last commit to the board that is in the work tree,
 * and the repo records its message and the paths that it staged.
 */

export const LAYOUT = layoutOf(HOME);
export const BOARD_PATH = join(STATE, files.board);
export const WAITING_PATH = join(STATE, files.waiting);
export const LOG_PATH = join(STATE, files.decisionLog);

export const EMPTY_WAITING = `${JSON.stringify({ intro: '', groups: [], items: [] }, null, 2)}\n`;
export const EMPTY_LOG = `${JSON.stringify({ rows: [] }, null, 2)}\n`;

export interface RepoCommit {
  readonly message: string;
  /** The paths that the commit staged, relative to the state folder. */
  readonly staged: readonly string[];
}

export interface BoardRepoOptions {
  /** The text of the board in the work tree. */
  readonly board: string;
  /** The text of the board at the last commit. Default: the text in the work tree. */
  readonly head?: string;
  readonly waiting?: string;
  readonly decisionLog?: string;
}

export interface BoardRepo {
  readonly deps: FakeDeps;
  /** The commits that the helper made since the setup, in order. */
  readonly commits: RepoCommit[];
  /** The text of a file of the state folder now. */
  textOf(file: string): string | undefined;
  /** The git commands of the state repo since the setup, without the words of a state step. */
  gitCommands(): string[];
}

/** A tracker double: it records each copy that it gets, and ends it with the given result. */
export interface TrackerSpy {
  readonly tracker: TrackerCopy;
  readonly calls: TrackerWrite[];
}

export const trackerSpy = (kind: string, outcome: CliResult<void> = ok(undefined), during?: () => void): TrackerSpy => {
  const calls: TrackerWrite[] = [];
  return {
    calls,
    tracker: {
      kind,
      copy: async (write) => {
        calls.push(write);
        during?.();
        return outcome;
      },
    },
  };
};

const idOfText = (text: string): string => createHash('sha256').update(text).digest('hex');

export const boardRepo = async (options: BoardRepoOptions): Promise<BoardRepo> => {
  const commits: RepoCommit[] = [];
  const blobs = new Map<string, string>();
  let head = options.head ?? options.board;
  let headId = 'c0ffee';
  let staged: readonly string[] = [];
  let deps: FakeDeps | undefined;
  const answer = (call: RunCall): CliResult<RunOutput> | undefined => {
    const rest = withoutStateWords(call.args).slice(2);
    const command = rest.join(' ');
    if (command === 'rev-parse -q --verify HEAD') return exited(0, `${headId}\n`);
    if (command === `ls-tree -z -l HEAD -- ${files.board}`) {
      const blob = idOfText(head);
      blobs.set(blob, head);
      const size = String(Buffer.byteLength(head, 'utf8')).padStart(7, ' ');
      return exited(0, `100644 blob ${blob} ${size}\t${files.board}\0`);
    }
    if (command.startsWith('cat-file blob ')) {
      const text = blobs.get(command.slice('cat-file blob '.length));
      return text === undefined ? exited(128, '', 'fatal: not a blob') : exited(0, text);
    }
    if (rest[0] === 'add') staged = rest.slice(rest.indexOf('--') + 1);
    if (rest[2] === 'commit') {
      const message = rest[rest.indexOf('-m') + 1];
      if (message === undefined || deps === undefined) return failure('the fake git got a commit with no message');
      commits.push({ message, staged });
      head = deps.files.get(BOARD_PATH) ?? head;
      headId = `c0ffee${commits.length}`;
      return exited(0);
    }
    return undefined;
  };
  const made = make({ answer });
  const fake = made.deps;
  deps = fake;
  const guarded = await installGuard(fake, STATE, STATE);
  if (!guarded.ok) throw new Error(guarded.error.message);
  fake.seed(BOARD_PATH, options.board);
  fake.seed(WAITING_PATH, options.waiting ?? EMPTY_WAITING);
  fake.seed(LOG_PATH, options.decisionLog ?? EMPTY_LOG);
  const setupCommands = made.gitCommands().length;
  return {
    deps: fake,
    commits,
    textOf: (file) => fake.files.get(join(STATE, file)),
    gitCommands: () => made.gitCommands().slice(setupCommands),
  };
};
