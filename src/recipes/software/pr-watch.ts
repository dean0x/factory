import { z } from 'zod';
import { usageError, type CliResult } from '../../cli/errors.js';
import { foundHomeOption } from '../../cli/home-option.js';
import type { CommandOutput, LineLevel, OutLine } from '../../cli/output.js';
import type { Command, Given } from '../../cli/table.js';
import type { Deps } from '../../core/deps.js';
import { ok } from '../../core/result.js';
import { onPath, toolNames } from '../../core/tools.js';
import { commands, commandText, flags, flagText } from '../../names.js';
import type { RecipeHost } from '../entry.js';
import { githubRepoOf, mergeCheck, parsePrNumber, runPrView, type PrReader } from './github-pr.js';
import {
  prCommands,
  prFlags,
  prWatchCommand,
  prWatchLabels,
  prWatchPoll,
  prWatchSchemaId,
  prWatchWords,
  type PrWatchResult,
} from './words.js';

/*
 * `pr watch` reads the checks of one PR at one head, one `gh pr view` call at a time, and says in one fixed word what happened.
 * It is a read only watch: it never merges, never approves and never prints text of gh. A pass is a fact about the checks at the
 * head. It is no proof that the PR may merge.
 */

/**
 * The answer of `gh pr view --json` for the four fields of the watch. The objects strip every key that the watch does not read, so
 * no name, link or login of a check is kept. An unknown value of an enum fails the parse. A check run has an empty conclusion while
 * it runs; gh can also give null, and both mean no conclusion yet. A PR with no checks can give null for the list.
 */
const checkRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']),
  conclusion: z
    .enum(['', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
    .nullable(),
});

const statusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  state: z.enum(['EXPECTED', 'PENDING', 'SUCCESS', 'FAILURE', 'ERROR']),
});

const checkSchema = z.discriminatedUnion('__typename', [checkRunSchema, statusContextSchema]);

const snapshotSchema = z.object({
  headRefOid: z.string().regex(mergeCheck.shaPattern),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  statusCheckRollup: z.array(checkSchema).max(prWatchPoll.maxChecks).nullable(),
  reviewDecision: z.enum(['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
});

type Check = z.infer<typeof checkSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

/** The `--json` field list of `gh pr view`: the keys of the schema, in its order. */
const SNAPSHOT_FIELDS = Object.keys(snapshotSchema.shape).join(',');

const PASSED_VALUES: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_VALUES: ReadonlySet<string> = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR']);

type CheckClass = 'passed' | 'failed' | 'pending';

interface Counts {
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
}

/** A passed value is SUCCESS, NEUTRAL or SKIPPED, as GitHub counts them for a required check. A failed value is listed. Any other value is pending. */
const classOfValue = (value: string | null): CheckClass => {
  if (value !== null && PASSED_VALUES.has(value)) return 'passed';
  if (value !== null && FAILED_VALUES.has(value)) return 'failed';
  return 'pending';
};

/** A check run counts by its conclusion once it is completed. Before that it is pending. */
const classOf = (check: Check): CheckClass => {
  if (check.__typename === 'StatusContext') return classOfValue(check.state);
  return check.status === 'COMPLETED' ? classOfValue(check.conclusion) : 'pending';
};

const countsOf = (checks: readonly Check[]): Counts =>
  checks.reduce<Counts>(
    (counts, check) => {
      const kind = classOf(check);
      return { ...counts, [kind]: counts[kind] + 1 };
    },
    { passed: 0, failed: 0, pending: 0 },
  );

const totalOf = (counts: Counts): number => counts.passed + counts.failed + counts.pending;

/** One read: the answer of gh as a snapshot, or null for a read failure. A read failure is never a pass. */
const readSnapshot = async (deps: Deps, repo: string, number: number): Promise<Snapshot | null> => {
  const read = await runPrView(deps, {
    repo,
    number: String(number),
    fields: SNAPSHOT_FIELDS,
    maxOutputChars: prWatchPoll.maxSnapshotChars,
  });
  if (read.kind !== 'parsed') return null;
  const parsed = snapshotSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
};

/**
 * The first event of a read, in this order: the head moved, the PR is merged, the PR is closed, the review decision changed since the
 * baseline, no checks in the first reads, a failed check, and every check passed (at least one). Null means: wait for the next read.
 */
const eventOf = (snapshot: Snapshot, head: string, review: string, counts: Counts, noChecks: boolean): PrWatchResult | null => {
  if (snapshot.headRefOid !== head) return 'head-moved';
  if (snapshot.state === 'MERGED') return 'merged';
  if (snapshot.state === 'CLOSED') return 'closed';
  if (snapshot.reviewDecision !== review) return 'review-changed';
  if (noChecks) return 'no-checks';
  if (counts.failed > 0) return 'failed';
  return counts.pending === 0 && counts.passed > 0 ? 'passed' : null;
};

const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
/** A handler replaces the default end of the process. HUP gets one that does nothing, so a lost terminal does not end the watch. */
const IGNORED_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP'];

interface StopWatch {
  /** True after INT or TERM, or when the parent process has changed. */
  ended(): boolean;
  /** A wait of `ms` milliseconds. A stop ends it at once. */
  wait(ms: number): Promise<void>;
  /** Remove every signal handler. */
  release(): void;
}

const startStopWatch = (deps: Deps): StopWatch => {
  const parent = deps.parentPid();
  let signalled = false;
  let wake: () => void = () => undefined;
  const onStop = (): void => {
    signalled = true;
    wake();
  };
  const onIgnored = (): void => undefined;
  for (const signal of STOP_SIGNALS) deps.signals.on(signal, onStop);
  for (const signal of IGNORED_SIGNALS) deps.signals.on(signal, onIgnored);
  return {
    ended: () => signalled || deps.parentPid() !== parent,
    // Each wait makes its own promise, so no promise gains a reaction at each wait.
    wait: (ms) =>
      new Promise<void>((resolve) => {
        if (signalled) {
          resolve();
          return;
        }
        wake = resolve;
        void deps.sleep(ms).then(resolve, resolve);
      }),
    release: () => {
      for (const signal of STOP_SIGNALS) deps.signals.off(signal, onStop);
      for (const signal of IGNORED_SIGNALS) deps.signals.off(signal, onIgnored);
    },
  };
};

interface WatchRequest {
  readonly repo: string;
  readonly number: number;
  /** The head to watch, from the head flag. Null: the head of the first good read. */
  readonly head: string | null;
}

/** How a watch ended. `head` is the pinned head, or null when no read gave one. `counts` are those of the last good read. */
interface Outcome {
  readonly result: PrWatchResult;
  readonly head: string | null;
  readonly counts: Counts | null;
  readonly reads: number;
}

/**
 * The loop: at most `prWatchPoll.reads` reads, `intervalMs` apart. The first good read pins the head and the review decision. A read
 * failure counts toward `failuresInRow`, and a good read resets that count. A stop ends the loop at the next check, which comes
 * before each read and ends a wait at once.
 *
 * With a head flag, GitHub can show the old head for some seconds after a push. Until the pinned head has shown once, a read of
 * another head is ignored for `headLagReads` reads: its checks, state and review decision count toward no verdict and set no
 * baseline. The next such read ends the watch with HEAD MOVED. Once the pinned head has shown, another head ends the watch at once.
 */
const loop = async (deps: Deps, request: WatchRequest, stop: StopWatch): Promise<Outcome> => {
  let head = request.head;
  let review: string | null = null;
  let counts: Counts | null = null;
  let failures = 0;
  let emptyReads = 0;
  let pinnedHeadShown = false;
  let lagReads = 0;
  const ended = (result: PrWatchResult, reads: number): Outcome => ({ result, head, counts, reads });

  for (let reads = 1; reads <= prWatchPoll.reads; reads += 1) {
    if (reads > 1) await stop.wait(prWatchPoll.intervalMs);
    if (stop.ended()) return ended('stopped', reads - 1);
    const snapshot = await readSnapshot(deps, request.repo, request.number);
    if (snapshot === null) {
      failures += 1;
      if (failures >= prWatchPoll.failuresInRow) return ended('unreadable', reads);
      continue;
    }
    failures = 0;
    head ??= snapshot.headRefOid;
    if (snapshot.headRefOid === head) {
      pinnedHeadShown = true;
    } else if (!pinnedHeadShown && lagReads < prWatchPoll.headLagReads) {
      lagReads += 1;
      continue;
    }
    review ??= snapshot.reviewDecision;
    counts = countsOf(snapshot.statusCheckRollup ?? []);
    if (reads <= prWatchPoll.zeroChecksReads && totalOf(counts) === 0) emptyReads += 1;
    const noChecks = reads === prWatchPoll.zeroChecksReads && emptyReads === prWatchPoll.zeroChecksReads;
    const event = eventOf(snapshot, head, review, counts, noChecks);
    if (event !== null) return ended(event, reads);
  }
  return ended('no-change', prWatchPoll.reads);
};

const watchPr = async (deps: Deps, request: WatchRequest): Promise<Outcome> => {
  const stop = startStopWatch(deps);
  try {
    return await loop(deps, request, stop);
  } finally {
    stop.release();
  }
};

const EXIT_PASSED = 0;
const EXIT_UNREADABLE = 1;
const EXIT_VERDICT = 3;

/** The exit code of each result: 0 for a pass, 1 for a watch that could not read, 3 for every other verdict. */
const EXIT_CODES: Readonly<Record<PrWatchResult, number>> = {
  passed: EXIT_PASSED,
  failed: EXIT_VERDICT,
  'head-moved': EXIT_VERDICT,
  closed: EXIT_VERDICT,
  merged: EXIT_VERDICT,
  'review-changed': EXIT_VERDICT,
  'no-checks': EXIT_VERDICT,
  'no-change': EXIT_VERDICT,
  unreadable: EXIT_UNREADABLE,
  stopped: EXIT_VERDICT,
};

const LEVELS: Readonly<Record<PrWatchResult, LineLevel>> = {
  passed: 'ok',
  failed: 'warn',
  'head-moved': 'warn',
  closed: 'warn',
  merged: 'warn',
  'review-changed': 'warn',
  'no-checks': 'warn',
  'no-change': 'warn',
  unreadable: 'fail',
  stopped: 'warn',
};

/** The command that the remedy lines name. */
const WATCH_LINE = `${prWatchCommand} PR`;

const UNREADABLE_REMEDY = `Check that ${toolNames.gh} is installed and signed in to ${mergeCheck.host}, then run "${WATCH_LINE}" again.`;

/**
 * The output of a watch. Line 1 is the fixed word, the PR number and the pinned head. The next lines are the counts of the checks and
 * the reads. The remedy comes with UNREADABLE only. Every value is a fixed word, a count, the PR number or a 40 digit hex head: no text
 * of gh is printed.
 */
const outputOf = (outcome: Outcome, number: number): CommandOutput => {
  const labels = prWatchLabels;
  const first = [prWatchWords[outcome.result], String(number), ...(outcome.head === null ? [] : [outcome.head])].join(' ');
  const lines: readonly OutLine[] = [
    { level: LEVELS[outcome.result], text: first },
    ...(outcome.counts === null
      ? []
      : [
          {
            level: 'text' as const,
            text: `${labels.checks}: ${labels.passed} ${outcome.counts.passed}, ${labels.failed} ${outcome.counts.failed}, ${labels.pending} ${outcome.counts.pending}`,
          },
        ]),
    { level: 'text', text: `${labels.reads}: ${outcome.reads} ${labels.of} ${prWatchPoll.reads}` },
    ...(outcome.result === 'unreadable' ? [{ level: 'text' as const, text: UNREADABLE_REMEDY }] : []),
  ];
  const code = EXIT_CODES[outcome.result];
  return {
    lines,
    json: {
      schema: prWatchSchemaId,
      result: outcome.result,
      pr: number,
      head: outcome.head,
      counts: outcome.counts,
      reads: outcome.reads,
    },
    warnings: [],
    failed: code !== EXIT_PASSED,
    ...(code === EXIT_PASSED ? {} : { exitCode: code }),
  };
};

const SUBCOMMANDS = Object.values(prCommands).join(', ');

/** The words of a refusal for a project that is not on GitHub. */
const READER: PrReader = { name: prWatchCommand, command: commands.pr, usage: `${prCommands.watch} PR` };

/** The label of the PR number in the message of a bad number. */
const NUMBER_LABEL = 'PR number';

interface WatchArgs {
  readonly number: number;
  readonly head: string | null;
  readonly projectId: string | undefined;
  readonly home: string | undefined;
}

/** The words of the command line, all checked before any other step: the subcommand, one PR number, and the head. A fault is a usage error (exit 2). */
const parseWatchArgs = (given: Given): CliResult<WatchArgs> => {
  const [subcommand, ...words] = given.positionals();
  if (subcommand === undefined) {
    return usageError(`${commandText(commands.pr)} needs a subcommand: ${SUBCOMMANDS}`, `Run "${WATCH_LINE}" with the number of a PR.`);
  }
  if (subcommand !== prCommands.watch) {
    return usageError(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommand is: ${SUBCOMMANDS}`, `Run "${WATCH_LINE}" with the number of a PR.`);
  }
  const [text, ...extra] = words;
  if (text === undefined || extra.length > 0) {
    return usageError(`${commandText(commands.pr)} ${prCommands.watch} needs exactly one PR number`, `Run "${WATCH_LINE}" again.`);
  }
  const number = parsePrNumber(text, NUMBER_LABEL);
  if (!number.ok) return number;
  const head = given.string(prFlags.head) ?? null;
  if (head !== null && !mergeCheck.shaPattern.test(head)) {
    return usageError(`${flagText(prFlags.head)}: must be a full commit id of 40 lowercase hex digits`, `Run "${WATCH_LINE}" again.`);
  }
  return ok({ number: number.value, head, projectId: given.string(flags.project), home: given.string(flags.home) });
};

/**
 * `pr watch PR`: the order of the steps is fixed. The words of the command line (exit 2). The node through the host object (exit 4 for
 * a config that the factory list does not count, exit 1 for a path that is not a folder). The project through the host object (exit 2
 * for a project that is not named, not listed or missing, exit 1 for a config that cannot be read). The repo of the project: a project
 * with no GitHub URL is a usage error (exit 2). Then gh on PATH (UNREADABLE, exit 1), then the watch. No gh call comes before the last step.
 */
const runWatch = async (host: RecipeHost, deps: Deps, given: Given): Promise<CliResult<CommandOutput>> => {
  const args = parseWatchArgs(given);
  if (!args.ok) return args;
  const { number, head } = args.value;
  const home = await host.locateNode(deps, args.value.home, commands.pr);
  if (!home.ok) return home;
  const project = await host.loadProject(deps, home.value, args.value.projectId, commands.pr);
  if (!project.ok) return project;
  const repo = githubRepoOf(project.value.url ?? '', READER);
  if (!repo.ok) return usageError(repo.error.message, repo.error.hint);
  if (!(await onPath(deps, toolNames.gh))) return ok(outputOf({ result: 'unreadable', head, counts: null, reads: 0 }, number));
  return ok(outputOf(await watchPr(deps, { repo: repo.value, number, head }), number));
};

/** The `pr` row of the command table. The host object carries the node lookup and the config loader, so this file imports neither. */
export const prCommandFor = (host: RecipeHost): Command => ({
  name: commands.pr,
  summary:
    `Watch the checks of one pull request at one head: up to ${prWatchPoll.reads} reads, ${prWatchPoll.intervalMs / 1000} seconds apart. ` +
    `Exit ${EXIT_PASSED} means every check passed. It is no approval.`,
  usage: `${WATCH_LINE} [${flagText(prFlags.head)} SHA] [${flagText(flags.project)} ID] [${flagText(flags.home)} DIR]`,
  positionals: true,
  options: {
    [flags.home]: foundHomeOption,
    [prFlags.head]: {
      type: 'string',
      placeholder: 'SHA',
      description: 'With watch: the full commit id of the head to watch, 40 lowercase hex digits. Default: the head of the first read.',
    },
    [flags.project]: {
      type: 'string',
      placeholder: 'ID',
      description: 'With watch: the id of the project that the PR belongs to. It is needed when the config lists more than one project.',
    },
  },
  run: (given, deps) => runWatch(host, deps, given),
});
