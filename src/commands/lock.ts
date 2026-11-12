import { basename, dirname, join, resolve, sep } from 'node:path';
import { failure, failureWithExit, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput } from '../cli/output.js';
import type { AttachedEnd, Deps } from '../core/deps.js';
import {
  freeLock,
  holderStateOf,
  holdsLock,
  takeLock,
  type LivenessInput,
  type LockLiveness,
  type LockPolicy,
} from '../core/file-lock.js';
import { preparePrivateFolder, readPrivateFile, userStatePathOf, type PrivateRead } from '../core/private-file.js';
import { processStartOf } from '../core/process-start.js';
import { ok } from '../core/result.js';
import {
  capitalize,
  commandLines,
  commands,
  commandText,
  env,
  files,
  flags,
  flagText,
  heavyLock,
  lockCommands,
  lockLine,
  lockNote,
  lockWords,
  program,
  roles,
  schemaIds,
} from '../names.js';

/**
 * `lock run`: run one child command while this user holds the heavy lock. The lock file and the priority file are per-user files
 * (see `userStatePathOf`). A run waits for its turn with a fixed bound, then runs the child in its own process group and frees the lock
 * by its token on every path. The exit code of the child passes through, so each outcome that the program decides writes one line that
 * starts with `error: factory lock run:` and holds a fixed word (`lockWords`): that line is the sure way to tell it from the child.
 */

export interface LockRunOptions {
  /** The words before the double dash: the subcommand. */
  readonly words: readonly string[];
  /** The words after the double dash: the child command and its arguments. */
  readonly childArgv: readonly string[];
  readonly priority: boolean;
  readonly json: boolean;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/** The most characters of the name of the child program in a line. */
const MAX_SHOWN_CHARS = 80;

/** The longest wait of a run, in minutes. */
const WAIT_MINUTES = (heavyLock.waitMs * heavyLock.attempts) / MS_PER_MINUTE;

const LIVENESS: LockLiveness = { startToleranceMs: heavyLock.startToleranceMs };

/** One try to take a file: the loop of this module waits between two tries, so a take never waits by itself. */
const ONE_TRY: LockPolicy = {
  attempts: 1,
  waitMs: heavyLock.waitMs,
  staleMs: heavyLock.claimStaleMs,
  takeoverSuffix: heavyLock.takeoverSuffix,
  mode: heavyLock.mode,
  liveness: LIVENESS,
};

const LOCK_RUN = commandText(commandLines.lockRun);
const USAGE_REMEDY = `Run "${commandText(commands.lock)} ${flagText(flags.help)}".`;
const WAIT_REMEDY = `Wait, then run "${LOCK_RUN}" again. Or tell the ${roles.coordinator}.`;
const TELL_REMEDY = `Tell the ${roles.coordinator}. When the cause is gone, run "${LOCK_RUN}" again.`;
const AGAIN_REMEDY = `Run "${LOCK_RUN}" again. If it fails again, tell the ${roles.coordinator}.`;

/** The line of a run that did not start: the fixed word, the reason (it may start with a small letter) and the fact that nothing ran. */
const stopLine = (word: string, reason: string): string => lockLine(word, `${capitalize(reason)}. The command did not start.`);
const refused = (reason: string, remedy: string = TELL_REMEDY) => safetyRefusal(stopLine(lockWords.refused, reason), remedy);
const notStarted = (reason: string, remedy: string = AGAIN_REMEDY) => failure(stopLine(lockWords.notStarted, reason), remedy);

/** The result of a child that ended with this exit code. Only the output of the child goes to stdout. */
const childExit = (code: number): CliResult<CommandOutput> =>
  ok({ lines: [], json: { schema: schemaIds.lock }, warnings: [], failed: code !== 0, exitCode: code });

/** The result of the end of the child. A code passes through, and a signal gives 128 plus its number. */
const resultOfEnd = (end: AttachedEnd, command: string): CliResult<CommandOutput> => {
  switch (end.kind) {
    case 'code':
      return childExit(end.code);
    case 'signal':
      return childExit(heavyLock.signalExitBase + end.number);
    case 'limit':
      return notReady(
        lockLine(lockWords.holdEnded, `The command ran for ${heavyLock.maxHoldMs / MS_PER_HOUR} hours, the longest time that is allowed. ${program} stopped it.`),
        `Split the work into smaller commands, or tell the ${roles.coordinator}.`,
      );
    case 'spawn':
      return end.code === 'ENOENT'
        ? failure(
            lockLine(lockWords.notFound, `The program "${displayLine(command, MAX_SHOWN_CHARS)}" was not found.`),
            `Check the name of the program and the ${env.path} variable, then run "${LOCK_RUN}" again.`,
          )
        : notStarted(`The program could not start (${end.code})`);
  }
};

/** The line must be `run`, with no `--json`, and a command after the double dash. */
const checkedLine = (options: LockRunOptions): CliResult<readonly string[]> => {
  const usage = (detail: string) => usageError(lockLine(lockWords.usage, detail), USAGE_REMEDY);
  if (options.json) return usage(`The flag ${flagText(flags.json)} is not allowed.`);
  if (options.words.length !== 1 || options.words[0] !== lockCommands.run) return usage(`The subcommand must be "${lockCommands.run}".`);
  if (options.childArgv.length === 0) return usage('Give the command after a double dash.');
  return ok(options.childArgv);
};

/** The real path of a word, relative to the current folder, or null when no such file exists. */
const realPathOf = async (deps: Deps, word: string): Promise<string | null> => {
  const real = await deps.fs.realpath(resolve(deps.cwd, word));
  return real.ok ? real.value : null;
};

/**
 * True when the child is this program: its name is the program name, its real path is the script of the running program, or it is the
 * node program followed by that script. A wrapper (a shell, `env`, `npx`) is not detected.
 */
const isOwnProgram = async (deps: Deps, argv: readonly string[], script: string): Promise<boolean> => {
  const [command = '', first] = argv;
  if (basename(command).toLowerCase() === program) return true;
  if (command.includes(sep) && (await realPathOf(deps, command)) === script) return true;
  const node = deps.programArgv[0] ?? '';
  const isNode = node !== '' && (command === node || basename(command) === basename(node));
  return isNode && first !== undefined && (await realPathOf(deps, first)) === script;
};

/** Refuse the program itself as the child: a run of it inside the lock could wait for the lock that it holds. */
const refuseOwnProgram = async (deps: Deps, argv: readonly string[]): Promise<CliResult<void>> => {
  const script = deps.programArgv[1];
  if (script === undefined) {
    return notStarted('The path of the running program is not known, so the command cannot be checked');
  }
  return (await isOwnProgram(deps, argv, script))
    ? refused(`The command is the ${program} program`, `Run that program on its own, not inside "${LOCK_RUN}".`)
    : ok(undefined);
};

interface Place {
  readonly lockPath: string;
  readonly priorityPath: string;
}

/** The two files in the per-user state folder, with the folder made ready (mode 0700, owned by this user, no group or other write). */
const placeOf = async (deps: Deps): Promise<CliResult<Place>> => {
  const lock = await userStatePathOf(deps, files.heavyLock);
  if (!lock.ok) return refused(lock.error.message, lock.error.hint ?? TELL_REMEDY);
  if (lock.value === null) {
    return notStarted(
      'No state folder is known',
      `Set ${env.userHome} or ${env.stateHome} to an absolute folder, then run "${LOCK_RUN}" again.`,
    );
  }
  const folder = await preparePrivateFolder(deps, lock.value);
  if (!folder.ok) {
    return folder.error.reason === 'io'
      ? notStarted(folder.error.message)
      : refused(folder.error.message);
  }
  return ok({ lockPath: lock.value, priorityPath: join(dirname(lock.value), files.heavyPriority) });
};

/** The token of the lock that this run is inside, or null. A token in the environment counts only when the lock file holds it now. */
const insideLockToken = async (deps: Deps, lockPath: string): Promise<string | null> => {
  const token = deps.env[env.heavyLockToken];
  if (token === undefined || token === '') return null;
  const holds = await holdsLock(deps, lockPath, token);
  return holds.ok && holds.value ? token : null;
};

/** What a run needs from its caller while it waits and runs. */
interface Run {
  readonly command: string;
  readonly args: readonly string[];
  readonly place: Place;
  readonly priority: boolean;
  readonly liveness: LivenessInput;
}

/** The tokens that this run holds. The final step frees them, whatever the end is. */
interface Held {
  lockToken: string | null;
  priorityToken: string | null;
}

/** A file as one try sees it: it is absent, it cannot be read, or this is its content. */
type Seen = PrivateRead | 'absent' | 'unreadable';

/**
 * Look at a file of the lock before a take or a read: a link is refused (it is never followed), and so is a folder or a file that another
 * user owns or that a group or another user can write. Any other fault of the file system leaves the file `unreadable`.
 */
const inspectFile = async (deps: Deps, path: string): Promise<CliResult<Seen>> => {
  const kind = await deps.fs.lstat(path);
  if (!kind.ok) return ok('unreadable');
  if (kind.value === 'link') return refused(`The file ${path} is a link`);
  if (kind.value === null) return ok('absent');
  const read = await readPrivateFile(deps, path, heavyLock.maxPriorityBytes);
  if (read.ok) return ok(read.value ?? 'absent');
  return read.error.reason === 'io' ? ok('unreadable') : refused(read.error.message);
};

/** Take the priority file, with one try. A live priority run of another process holds it: this run ends with exit 3. */
const takePriority = async (deps: Deps, run: Run): Promise<CliResult<string>> => {
  const seen = await inspectFile(deps, run.place.priorityPath);
  if (!seen.ok) return seen;
  const taken = await takeLock(deps, run.place.priorityPath, ONE_TRY, run.liveness);
  if (!taken.ok) return notStarted(taken.error);
  switch (taken.value.kind) {
    case 'taken':
      return ok(taken.value.token);
    case 'held':
      return notReady(
        stopLine(lockWords.priorityHeld, `Another run with ${flagText(flags.priority)} goes first now`),
        WAIT_REMEDY,
      );
    case 'link':
      return refused(`The file ${run.place.priorityPath} is a link`);
  }
};

/**
 * Whether a live priority file of another run blocks this try. A priority file that does not parse, cannot be read, belongs to a process
 * that ended, or is older than the longest wait counts as no priority, with one warning for the run. No process is signalled.
 */
const priorityBlocks = async (deps: Deps, run: Run, warnOnce: (detail: string) => void): Promise<CliResult<boolean>> => {
  const path = run.place.priorityPath;
  const inspected = await inspectFile(deps, path);
  if (!inspected.ok) return inspected;
  const seen = inspected.value;
  if (seen === 'absent') return ok(false);
  if (seen === 'unreadable') {
    warnOnce(`The priority file ${path} cannot be read. It is ignored.`);
    return ok(false);
  }
  const state = await holderStateOf(deps, seen.text, LIVENESS, run.liveness);
  if (state !== 'live') {
    warnOnce(`The priority file ${path} ${state === 'ended' ? 'belongs to a run that ended' : 'is not valid'}. It is ignored.`);
    return ok(false);
  }
  if (deps.now().getTime() - seen.mtimeMs >= heavyLock.priorityMaxAgeMs) {
    warnOnce(`The priority file ${path} is older than the longest wait. It is ignored.`);
    return ok(false);
  }
  return ok(true);
};

/** One try to take the lock. The value is the token when the lock is taken, and null when it stays with another run or a priority run goes first. */
const tryLock = async (deps: Deps, run: Run, warnOnce: (detail: string) => void): Promise<CliResult<string | null>> => {
  const lockFile = await inspectFile(deps, run.place.lockPath);
  if (!lockFile.ok) return lockFile;
  // A priority run does not wait for a priority file: the only live one is its own.
  const blocked = run.priority ? ok(false) : await priorityBlocks(deps, run, warnOnce);
  if (!blocked.ok) return blocked;
  if (blocked.value) return ok(null);
  const taken = await takeLock(deps, run.place.lockPath, ONE_TRY, run.liveness);
  if (!taken.ok) return notStarted(taken.error);
  if (taken.value.kind === 'link') return refused(`The file ${run.place.lockPath} is a link`);
  return ok(taken.value.kind === 'taken' ? taken.value.token : null);
};

/** The signals that end the wait. Each one replaces the default end of the process, so the watch removes its handlers when it stops. */
const STOP_SIGNALS = Object.keys(heavyLock.stopSignals) as readonly (keyof typeof heavyLock.stopSignals)[];

interface StopWatch {
  /** The first signal that arrived, or null. */
  seen(): keyof typeof heavyLock.stopSignals | null;
  /** Wait for `ms`, or until a stop signal arrives. */
  pause(ms: number): Promise<void>;
  /** Remove the handlers. */
  stop(): void;
}

/** Watch for the signals that end the wait. The handlers stay until `stop`, so `runAttached` can install its own for the child. */
const watchStops = (deps: Deps): StopWatch => {
  let first: keyof typeof heavyLock.stopSignals | null = null;
  let wake: () => void = () => undefined;
  const handlers = STOP_SIGNALS.map((signal) => ({
    signal,
    handler: (): void => {
      first ??= signal;
      wake();
    },
  }));
  for (const { signal, handler } of handlers) deps.signals.on(signal, handler);
  const seen = (): keyof typeof heavyLock.stopSignals | null => first;
  return {
    seen,
    pause: (ms) =>
      seen() !== null
        ? Promise.resolve()
        : new Promise<void>((resolveWait, rejectWait) => {
            wake = resolveWait;
            deps.sleep(ms).then(resolveWait, rejectWait);
          }),
    stop: () => {
      for (const { signal, handler } of handlers) deps.signals.off(signal, handler);
    },
  };
};

/** How the wait ended: the lock is taken (with its token), a stop signal came, or all tries are used. */
type Turn =
  | { readonly kind: 'taken'; readonly token: string }
  | { readonly kind: 'stopped'; readonly signal: keyof typeof heavyLock.stopSignals }
  | { readonly kind: 'used-up' };

/** Free a file by token. A failure gives one warning and changes nothing else. */
const freeHeld = async (deps: Deps, path: string, token: string | null): Promise<void> => {
  if (token === null) return;
  const freed = await freeLock(deps, path, token);
  if (!freed.ok) deps.warn(lockNote(`Cannot remove the file ${path}: ${freed.error}`));
};

/**
 * Wait for the lock: at most `heavyLock.attempts` tries with `heavyLock.waitMs` between two tries. A run with the priority flag takes
 * the priority file first. The first try that finds the lock busy prints one wait line. A stop signal ends the wait at once. The token
 * of each file that this call takes goes into `held`.
 */
const waitForTurn = async (deps: Deps, run: Run, held: Held): Promise<CliResult<Turn>> => {
  const watch = watchStops(deps);
  let warned = false;
  const warnOnce = (detail: string): void => {
    if (!warned) deps.warn(lockNote(detail));
    warned = true;
  };
  try {
    if (run.priority) {
      const priority = await takePriority(deps, run);
      if (!priority.ok) return priority;
      held.priorityToken = priority.value;
    }
    for (let attempt = 1; attempt <= heavyLock.attempts; attempt += 1) {
      const stopped = watch.seen();
      if (stopped !== null) return ok({ kind: 'stopped', signal: stopped });
      const tried = await tryLock(deps, run, warnOnce);
      if (!tried.ok) return tried;
      if (tried.value !== null) {
        held.lockToken = tried.value;
        const late = watch.seen();
        return ok(late === null ? { kind: 'taken', token: tried.value } : { kind: 'stopped', signal: late });
      }
      if (attempt === 1) {
        deps.warn(lockLine(lockWords.waiting, `Another run holds the lock, or goes first. This run waits up to ${WAIT_MINUTES} minutes.`));
      }
      if (attempt < heavyLock.attempts) await watch.pause(heavyLock.waitMs);
    }
    return ok({ kind: 'used-up' });
  } finally {
    watch.stop();
  }
};

/** Run the child in its own process group while the lock is held, then map its end. */
const runHeld = async (deps: Deps, run: Run): Promise<CliResult<CommandOutput>> => {
  const held: Held = { lockToken: null, priorityToken: null };
  try {
    const turn = await waitForTurn(deps, run, held);
    if (!turn.ok) return turn;
    if (turn.value.kind === 'stopped') {
      return failureWithExit(
        heavyLock.signalExitBase + heavyLock.stopSignals[turn.value.signal],
        stopLine(lockWords.stopped, `The signal ${turn.value.signal} ended the wait`),
      );
    }
    if (turn.value.kind === 'used-up') {
      return notReady(stopLine(lockWords.waitEnded, `This run waited ${WAIT_MINUTES} minutes and did not get the lock`), WAIT_REMEDY);
    }
    // The run has the lock now, so its priority mark has done its work.
    await freeHeld(deps, run.place.priorityPath, held.priorityToken);
    held.priorityToken = null;
    const end = await deps.runAttached(run.command, run.args, {
      held: true,
      maxMs: heavyLock.maxHoldMs,
      killGraceMs: heavyLock.killGraceMs,
      extraEnv: { [env.heavyLockToken]: turn.value.token },
    });
    return resultOfEnd(end, run.command);
  } finally {
    await freeHeld(deps, run.place.lockPath, held.lockToken);
    await freeHeld(deps, run.place.priorityPath, held.priorityToken);
  }
};

/**
 * `lock run [--priority] -- COMMAND...`: run the command while this user holds the heavy lock (see the header of this file). The checks
 * come in this order: the line, the program itself as the child, the per-user files, a run inside the lock, the own start time, the wait.
 * A run inside the lock (its token variable equals the content of the lock file) runs the child at once, in the current process group,
 * with no second take, no priority file and no time limit.
 */
export const runLock = async (deps: Deps, options: LockRunOptions): Promise<CliResult<CommandOutput>> => {
  const line = checkedLine(options);
  if (!line.ok) return line;
  const [command = '', ...args] = line.value;
  const own = await refuseOwnProgram(deps, line.value);
  if (!own.ok) return own;
  const place = await placeOf(deps);
  if (!place.ok) return place;

  const inside = await insideLockToken(deps, place.value.lockPath);
  if (inside !== null) return resultOfEnd(await deps.runAttached(command, args, { extraEnv: { [env.heavyLockToken]: inside } }), command);

  const start = await processStartOf(deps, deps.pid);
  if (!start.ok) return notStarted(start.error);
  return runHeld(deps, {
    command,
    args,
    place: place.value,
    priority: options.priority,
    liveness: { ownStartMs: start.value, startCache: new Map() },
  });
};
