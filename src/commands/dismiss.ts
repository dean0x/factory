import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { err, ok } from '../core/result.js';
import { printable, tableLines, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import type { IgnoredList } from '../core/git.js';
import { locateHomeFolder } from '../core/home.js';
import { shellWord } from '../core/shell-word.js';
import type { PaneRow } from '../launch/tmux.js';
import {
  commands,
  commandText,
  dismissWords,
  flags,
  flagText,
  lastSeen,
  places,
  roles,
  schemaIds,
  statusWords,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import {
  dismissLine,
  fetchClone,
  freeWorker,
  ignoredIn,
  planDismiss,
  requireEndable,
  unpushedReasons,
  type DismissPlan,
  type DismissTarget,
  type FreedWorker,
} from '../workers/dismiss.js';
import { readOwnLastSeen } from '../workers/last-seen.js';
import { requireOtherPane } from '../workers/lifecycle.js';
import { readPanes } from '../workers/panes.js';
import { requireRecord } from '../workers/registry.js';
import { readStatus } from '../workers/status-read.js';
import type { WorkerStatus } from '../workers/status.js';
import { unknownWorkItems, type WorkItemPort } from '../workers/work-items.js';

export interface DismissOptions {
  readonly home: string | undefined;
  /** The words after the command: the id of the worker. With `idle` there is none. */
  readonly words: readonly string[];
  /** True for `--idle`: list the idle workers, and let the owner pick. */
  readonly idle: boolean;
  /** True when the person gave the yes flag. It is the consent to the change. */
  readonly yes: boolean;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });
const fail = (line: string): OutLine => ({ level: 'fail', text: line });

const IDLE_LINE = `${commands.dismiss} ${flagText(flags.idle)}`;

const usage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.dismiss)} ${flagText(flags.help)}".`);

/** The words of the command line: one id, or `--idle` with no id and no yes flag. */
const checkWords = (options: DismissOptions): CliResult<void> => {
  if (options.idle) {
    if (options.words.length > 0) return usage(`${flagText(flags.idle)} takes no ${roles.worker} id`);
    return options.yes ? usage(`${flagText(flags.idle)} takes no ${flagText(flags.yes)}: the pick is the consent`) : ok(undefined);
  }
  return options.words.length === 1 ? ok(undefined) : usage(`${commands.dismiss} takes one argument: the id of the ${roles.worker}`);
};

/** The yes flag gives no consent inside a factory session: the stop comes before any read. */
const requireOutsideSession = (deps: Deps, again: string): CliResult<void> =>
  inFactorySession(deps)
    ? safetyRefusal(
        `${flagText(flags.yes)} gives no consent inside a ${places.session}, so ${commands.dismiss} frees nothing`,
        `Run "${commandText(again)}" in a terminal window outside a ${places.session}.`,
      )
    : ok(undefined);

/** The worker that the checks passed: its plan and the reasons that its work is not pushed. */
interface Inspected {
  readonly plan: DismissPlan;
  readonly reasons: readonly string[];
}

/**
 * The checks of the path and of the pushed test for the workers of one run. Each clone is fetched once for the run: a later call for
 * a worker of the same clone uses the answer of the first fetch, so every worker of a clone is judged by one state of the remote.
 */
const inspectorOf = (deps: Deps, home: string, config: FactoryConfig): ((target: DismissTarget) => Promise<CliResult<Inspected>>) => {
  const fetched = new Map<string, CliResult<void>>();
  return async (target) => {
    const plan = await planDismiss(deps, home, config, target);
    if (!plan.ok) return plan;
    const known = fetched.get(plan.value.clone);
    const fetch = known ?? (await fetchClone(deps, plan.value));
    fetched.set(plan.value.clone, fetch);
    if (!fetch.ok) return fetch;
    const reasons = await unpushedReasons(deps, plan.value);
    return reasons.ok ? ok({ plan: plan.value, reasons: reasons.value }) : reasons;
  };
};

/** The session whose last-seen line belongs to the worker, or null when the worker has no line that it owns. */
const lineSessionOf = async (deps: Deps, home: string, id: string): Promise<CliResult<string | null>> => {
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return seen;
  return ok(seen.value.state === 'valid' ? seen.value.line[lastSeen.keys.sessionId] : null);
};

/** One STUCK line for each reason, then the remedy line. */
const stuckLines = (plan: DismissPlan, reasons: readonly string[]): readonly OutLine[] => [
  ...reasons.map((reason) => fail(`${dismissWords.stuck} ${reason}.`)),
  text(`Push the work of the ${roles.worker} ${plan.id}. Then run "${commandText(dismissLine(plan.id))}" again.`),
];

/** The ignored files that git does not hold: the removal of the work copy deletes them. */
const NO_IGNORED: IgnoredList = { paths: [], reachedCap: false };

/**
 * The count and the first paths of the ignored files that the removal of the work copy deletes: the dry run says that it `deletes`
 * them, and the free says that it `deleted` them. A list that reached the cap says "more than" the paths it holds. No line for none.
 */
const ignoredLines = (ignored: IgnoredList, verb: 'deletes' | 'deleted'): readonly OutLine[] => {
  const { paths, reachedCap } = ignored;
  if (paths.length === 0 && !reachedCap) return [];
  const count = reachedCap ? `more than ${paths.length}` : `${paths.length}`;
  const noun = !reachedCap && paths.length === 1 ? 'file' : 'files';
  const names = [paths.join(', '), ...(reachedCap ? ['and more'] : [])].filter((part) => part !== '').join(' ');
  return [text(`The removal ${verb} ${count} ignored ${noun}: ${names}.`)];
};

/** What the pane of the worker is now, for the words "end" and "close": a live pane ends, and a pane that ended is closed. */
const paneStep = (entry: WorkerStatus): 'end' | 'close' | null => {
  if (entry.pane === null) return null;
  return entry.running ? 'end' : 'close';
};

const keptBranchLine = (plan: DismissPlan): OutLine =>
  text(`The branch ${plan.branch} stays. To delete it too, run "git -C ${shellWord(plan.clone)} branch -D ${shellWord(plan.branch)}".`);

const dryRunLines = (entry: WorkerStatus, plan: DismissPlan, ignored: IgnoredList): readonly OutLine[] => {
  const step = paneStep(entry);
  return [
    ...(step === 'end' ? [text(`Would end the pane ${entry.pane} of the ${roles.worker} ${plan.id}.`)] : []),
    ...(step === 'close' ? [text(`Would close the ended pane ${entry.pane} of the ${roles.worker} ${plan.id}.`)] : []),
    text(`Would remove the work copy ${plan.workCopy}.`),
    text(`Would delete the record of the ${roles.worker} ${plan.id} and its last-seen line.`),
    keptBranchLine(plan),
    ...ignoredLines(ignored, 'deletes'),
    text(`Nothing changed. Run "${commandText(dismissLine(plan.id))} ${flagText(flags.yes)}" to do it.`),
  ];
};

const freedLines = (plan: DismissPlan, freed: FreedWorker, ignored: IgnoredList): readonly OutLine[] => {
  const { stopped } = freed;
  return [
    ...(stopped.kind === 'stopped' ? [text(`Ended the pane ${stopped.paneId} of the ${roles.worker} ${plan.id}.`)] : []),
    ...(stopped.kind === 'closed-dead' ? [text(`Closed the ended pane ${stopped.paneIds.join(', ')} of the ${roles.worker} ${plan.id}.`)] : []),
    text(`Removed the work copy ${plan.workCopy}.`),
    ...ignoredLines(ignored, 'deleted'),
    text(`Deleted the record of the ${roles.worker} ${plan.id}.`),
    keptBranchLine(plan),
  ];
};

/** What the run read before its first decision: the folder, the config, the session and the table of the workers. */
interface Facts {
  readonly home: string;
  readonly config: FactoryConfig;
  readonly session: string;
  /** The list of the panes that the run read once, or null when no session runs. */
  readonly panes: readonly PaneRow[] | null;
  readonly entries: readonly WorkerStatus[];
  readonly warnings: readonly string[];
}

const factsOf = async (
  deps: Deps,
  options: DismissOptions,
  workItems: WorkItemPort,
  home: string,
  config: FactoryConfig,
): Promise<CliResult<Facts>> => {
  const session = config.core.node.id;
  const again = options.idle ? IDLE_LINE : `${commands.dismiss} ${options.words.join(' ')}`;
  const panes = await readPanes(deps, session, home, commandText(again));
  if (!panes.ok) return panes;
  const read = await readStatus(deps, { home, config, workItems, panes: panes.value });
  if (!read.ok) return read;
  return ok({ home, config, session, panes: panes.value, entries: read.value.entries, warnings: read.value.warnings });
};

/** `dismiss ID`: the checks, then the dry run, or the free with the yes flag. */
const dismissOne = async (deps: Deps, options: DismissOptions, registry: RecipeRegistry, workItems: WorkItemPort): Promise<CliResult<CommandOutput>> => {
  const [id = ''] = options.words;
  const again = dismissLine(id);
  if (options.yes) {
    const outside = requireOutsideSession(deps, again);
    if (!outside.ok) return outside;
  }
  const located = await locateHomeFolder(deps, options.home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), commands.dismiss);
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const record = await requireRecord(deps, home, id, commandText(commands.dismiss));
  if (!record.ok) return record;
  const facts = await factsOf(deps, options, workItems, home, config);
  if (!facts.ok) return facts;
  const entry = facts.value.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return failure(`cannot read the state of the ${roles.worker} ${id}`, `Run "${commandText(again)}" again.`);
  const endable = requireEndable(entry, again);
  if (!endable.ok) return endable;
  const inspected = await inspectorOf(deps, home, config)({ id, project: record.value.project });
  if (!inspected.ok) return inspected;
  const { plan, reasons } = inspected.value;
  const warnings = facts.value.warnings;
  const base = { schema: schemaIds.dismiss, home, idle: false, yes: options.yes };
  if (reasons.length > 0) {
    return ok({
      lines: stuckLines(plan, reasons),
      json: { ...base, freed: false, workers: [{ id, project: plan.project, pushed: false, stuck: reasons }] },
      warnings,
      failed: true,
      exitCode: 1,
    });
  }
  const ignored = await ignoredIn(deps, plan);
  if (!ignored.ok) return ignored;
  if (!options.yes) {
    return ok({
      lines: dryRunLines(entry, plan, ignored.value),
      json: { ...base, freed: false, workers: [{ id, project: plan.project, pushed: true, stuck: [], ignored: ignored.value.paths }] },
      warnings,
      failed: false,
    });
  }
  const lineSession = await lineSessionOf(deps, home, id);
  if (!lineSession.ok) return lineSession;
  const freed = await freeWorker(deps, { home, session: facts.value.session, plan, panes: facts.value.panes, lineSession: lineSession.value });
  if (!freed.ok) return freed;
  return ok({
    lines: freedLines(plan, freed.value, ignored.value),
    json: {
      ...base,
      freed: true,
      workers: [{ id, project: plan.project, pushed: true, stuck: [], ended: freed.value.stopped.kind !== 'no-pane', ignored: ignored.value.paths }],
    },
    warnings,
    failed: false,
  });
};

/** True when the checks passed and found no reason that the work is not pushed. A check that failed counts as not pushed. */
const isPushed = (inspected: CliResult<Inspected> | undefined): boolean =>
  inspected !== undefined && inspected.ok && inspected.value.reasons.length === 0;

const stateText = (entry: WorkerStatus): string => (entry.running ? entry.state : statusWords.stopped);

/** The picked worker as a refusal, or its checks: it must be listed, have a live pane at its prompt, and not be this pane. */
const requirePick = (deps: Deps, id: string, idle: readonly WorkerStatus[], panes: readonly PaneRow[]): CliResult<WorkerStatus> => {
  const entry = idle.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return failure(
      `the ${roles.worker} ${id} is not in the list of idle ${roles.worker}s`,
      `Run "${commandText(commands.status)}" to see the state of each ${roles.worker}, or run "${commandText(IDLE_LINE)}" again.`,
    );
  }
  if (!entry.running) {
    return failure(
      `the ${roles.worker} ${id} has no live pane, so the pick ends no pane`,
      `Run "${commandText(dismissLine(id))}" to free its work copy.`,
    );
  }
  const endable = requireEndable(entry, IDLE_LINE);
  if (!endable.ok) return endable;
  const pane = panes.find((row) => row.worker === id && !row.dead);
  if (pane !== undefined) {
    const other = requireOtherPane(deps, id, pane, IDLE_LINE);
    if (!other.ok) return other;
  }
  return ok(entry);
};

/** The ids of an answer: words parted by spaces or commas, each once, in order. The answer is at most `MAX_ANSWER_CHARS` long. */
const idsOf = (answer: string): readonly string[] => [...new Set(answer.split(/[\s,]+/).filter((word) => word !== ''))];

/** A worker that the owner picked, with what it needs for the free: all of it read before the first change. */
interface Pick {
  readonly entry: WorkerStatus;
  readonly inspected: Inspected;
  readonly lineSession: string | null;
  /** The ignored files that the free deletes. A worker with unpushed work is not freed, so its list is empty. */
  readonly ignored: IgnoredList;
}

const prepare = async (deps: Deps, home: string, entry: WorkerStatus, inspected: CliResult<Inspected>): Promise<CliResult<Pick>> => {
  if (!inspected.ok) return inspected;
  const lineSession = await lineSessionOf(deps, home, entry.id);
  if (!lineSession.ok) return lineSession;
  const ignored: CliResult<IgnoredList> = inspected.value.reasons.length === 0 ? await ignoredIn(deps, inspected.value.plan) : ok(NO_IGNORED);
  return ignored.ok ? ok({ entry, inspected: inspected.value, lineSession: lineSession.value, ignored: ignored.value }) : ignored;
};

/** What the free of the picked workers did: the lines, the ids freed and stuck, and the ignored files that each free deleted. */
interface PicksDone {
  readonly lines: readonly OutLine[];
  readonly freed: readonly string[];
  readonly stuck: readonly string[];
  readonly ignored: ReadonlyMap<string, readonly string[]>;
}

/** The picked workers: the ones with unpushed work get STUCK lines, and the others are freed. A fault names the workers that were freed. */
const freePicks = async (deps: Deps, facts: Facts, picks: readonly Pick[]): Promise<CliResult<PicksDone>> => {
  const lines: OutLine[] = [];
  const freed: string[] = [];
  const stuck: string[] = [];
  const ignoredBy = new Map<string, readonly string[]>();
  for (const { entry, inspected, lineSession, ignored } of picks) {
    const { plan, reasons } = inspected;
    if (reasons.length > 0) {
      lines.push(...stuckLines(plan, reasons));
      stuck.push(plan.id);
      continue;
    }
    const done = await freeWorker(deps, { home: facts.home, session: facts.session, plan, panes: facts.panes, lineSession });
    if (!done.ok) {
      const before = freed.length === 0 ? '' : `. Freed before this fault: ${freed.join(', ')}`;
      return err({ ...done.error, message: `${done.error.message}${before}` });
    }
    lines.push(...freedLines(plan, done.value, ignored));
    freed.push(entry.id);
    ignoredBy.set(entry.id, ignored.paths);
  }
  return ok({ lines, freed, stuck, ignored: ignoredBy });
};

/** A worker of the list step: the row of the table, and the entry of the JSON. */
interface ListedWorker {
  readonly id: string;
  readonly project: string;
  readonly state: string;
  readonly pushed: boolean;
}

/** What the list step of `dismiss --idle` gives the pick step: the table, the idle workers and the JSON of the list. */
interface Listed {
  readonly table: readonly OutLine[];
  readonly workers: readonly ListedWorker[];
  readonly json: JsonDoc;
}

/**
 * The pick step of `dismiss --idle`, in a terminal window outside a factory session: the owner types the ids. The owner may take
 * long, so after the answer the state of the workers is read again, and every picked id is checked again (it must be listed as
 * idle, and its work must be pushed) before the first change. Then each picked worker is freed as `dismiss ID --yes` frees it.
 */
const pickAndFree = async (deps: Deps, options: DismissOptions, workItems: WorkItemPort, facts: Facts, listed: Listed): Promise<CliResult<CommandOutput>> => {
  const { table, workers, json } = listed;
  const { warnings } = facts;
  const answer = await deps.prompt(printable(`Dismiss which ${roles.worker}s? Type their ids with spaces, or press Enter to end nothing: `));
  if (!answer.ok) return answer;
  const ids = idsOf(answer.value);
  if (ids.length === 0) return ok({ lines: [...table, text('Nothing picked. Nothing changed.')], json, warnings, failed: false });
  const now = await factsOf(deps, options, workItems, facts.home, facts.config);
  if (!now.ok) return now;
  const idleNow = now.value.entries.filter((entry) => entry.idle);
  const inspect = inspectorOf(deps, now.value.home, now.value.config);
  const picks: Pick[] = [];
  for (const id of ids) {
    const entry = requirePick(deps, id, idleNow, now.value.panes ?? []);
    if (!entry.ok) return entry;
    const pick = await prepare(deps, now.value.home, entry.value, await inspect({ id, project: entry.value.project }));
    if (!pick.ok) return pick;
    picks.push(pick.value);
  }
  const done = await freePicks(deps, now.value, picks);
  if (!done.ok) return done;
  const { lines, freed, stuck, ignored } = done.value;
  const withIgnored = workers.map((worker) => {
    const paths = ignored.get(worker.id);
    return paths === undefined ? worker : { ...worker, ignored: paths };
  });
  return ok({
    lines: [...table, ...lines],
    json: { ...json, freed: freed.length > 0, workers: withIgnored, picked: ids, stuck },
    warnings,
    failed: stuck.length > 0,
    ...(stuck.length > 0 ? { exitCode: 1 } : {}),
  });
};

/**
 * `dismiss --idle`: lists the idle workers with their state and whether their work is pushed, and changes nothing. Inside a factory
 * session the pick step stops (exit 4). With no terminal window the list is all. In a terminal window the owner types the ids to
 * dismiss: every id is checked before the first change, and then each picked worker is freed as `dismiss ID --yes` frees it.
 */
const dismissIdle = async (deps: Deps, options: DismissOptions, registry: RecipeRegistry, workItems: WorkItemPort): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(deps, options.home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), commands.dismiss);
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const facts = await factsOf(deps, options, workItems, home, loaded.value);
  if (!facts.ok) return facts;
  const idle = facts.value.entries.filter((entry) => entry.idle);
  const warnings = facts.value.warnings;
  const base = { schema: schemaIds.dismiss, home, idle: true, yes: false };
  const inspect = inspectorOf(deps, home, loaded.value);
  const checked = new Map<string, CliResult<Inspected>>();
  for (const entry of idle) checked.set(entry.id, await inspect({ id: entry.id, project: entry.project }));
  const pushedWord = (id: string): string => (isPushed(checked.get(id)) ? dismissWords.pushed.yes : dismissWords.pushed.no);
  const table =
    idle.length === 0
      ? [text(`No idle ${roles.worker}s.`)]
      : tableLines(Object.values(dismissWords.columns), idle.map((entry) => [entry.id, entry.project, stateText(entry), pushedWord(entry.id)]));
  const listed: readonly ListedWorker[] = idle.map((entry) => ({
    id: entry.id,
    project: entry.project,
    state: stateText(entry),
    pushed: isPushed(checked.get(entry.id)),
  }));
  const json = { ...base, freed: false, workers: listed, picked: [] };
  if (inFactorySession(deps)) {
    return ok({
      lines: [
        ...table,
        fail(`The pick step stops inside a ${places.session}.`),
        text(`Run "${commandText(IDLE_LINE)}" in a terminal window outside a ${places.session}.`),
      ],
      json,
      warnings,
      failed: true,
      exitCode: 4,
    });
  }
  if (idle.length === 0) return ok({ lines: table, json, warnings, failed: false });
  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return ok({
      lines: [...table, text(`To pick, run "${commandText(IDLE_LINE)}" in a terminal window.`)],
      json,
      warnings,
      failed: false,
    });
  }
  return pickAndFree(deps, options, workItems, facts.value, { table, workers: listed, json });
};

/**
 * `dismiss ID`: ends a worker and frees its work copy. It is a dry run, and `--yes` is the consent to free (outside a factory session).
 * `dismiss --idle` lists the idle workers and lets the owner pick. In both, nothing changes until every check passed: the path of
 * the work copy (exit 4), the state of the session (exit 1 for a busy worker or one that is not known), and the pushed test. Work
 * that is not pushed prints `STUCK:` lines, frees nothing and exits 1. Freeing ends the pane, removes the work copy with the plain
 * git command (no force) and deletes the record with its last-seen line. The removal also deletes the ignored files of the work
 * copy, so the dry run and each free name them (read before the removal). The branch stays.
 */
export const runDismiss = async (
  deps: Deps,
  options: DismissOptions,
  registry: RecipeRegistry,
  workItems: WorkItemPort = unknownWorkItems,
): Promise<CliResult<CommandOutput>> => {
  const checked = checkWords(options);
  if (!checked.ok) return checked;
  return options.idle ? dismissIdle(deps, options, registry, workItems) : dismissOne(deps, options, registry, workItems);
};
