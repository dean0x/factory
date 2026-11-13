import type { DecisionLogInput } from '../board/contract.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { err, ok, type Result } from '../core/result.js';
import { displayLine, printable, tableLines, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { headOf, type IgnoredList } from '../core/git.js';
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
  requestDeciders,
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
  inboxFilesIn,
  planDismiss,
  requireEndable,
  unpushedReasons,
  type DismissPlan,
  type DismissTarget,
  type FreedWorker,
  type InboxList,
} from '../workers/dismiss.js';
import { readOwnLastSeen } from '../workers/last-seen.js';
import { requireOtherPane } from '../workers/lifecycle.js';
import { readPanes, requireCoordinatorCaller } from '../workers/panes.js';
import { requireRecord } from '../workers/registry.js';
import { readStatus } from '../workers/status-read.js';
import type { WorkerStatus } from '../workers/status.js';
import type { KnownWorkItem, WorkItemPort } from '../workers/work-items.js';
import type { DecisionLogPort } from './board-open.js';

export interface DismissOptions {
  readonly home: string | undefined;
  /** The words after the command: the id of the worker. With `idle` there is none. */
  readonly words: readonly string[];
  /** True for `--idle`: list the idle workers, and let the owner pick. */
  readonly idle: boolean;
  /** True when the person gave the yes flag. It is the consent to the change. */
  readonly yes: boolean;
  /** True for `--closed`: the coordinator frees a finished worker in its session. It takes no `--yes` and no `--idle`. */
  readonly closed: boolean;
}

const text = (line: string): OutLine => ({ level: 'text', text: line });
const fail = (line: string): OutLine => ({ level: 'fail', text: line });

const IDLE_LINE = `${commands.dismiss} ${flagText(flags.idle)}`;

const usage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.dismiss)} ${flagText(flags.help)}".`);

/** The words of the command line: one id, or `--idle` with no id and no yes flag. `--closed` takes one id and no other mode flag. */
const checkWords = (options: DismissOptions): CliResult<void> => {
  if (options.closed && (options.idle || options.yes)) {
    return usage(`${flagText(flags.closed)} takes no ${flagText(options.idle ? flags.idle : flags.yes)}: it is a mode of its own`);
  }
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
const inspectorOf = (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  acceptedHeads: readonly string[] = [],
): ((target: DismissTarget) => Promise<CliResult<Inspected>>) => {
  const fetched = new Map<string, CliResult<void>>();
  return async (target) => {
    const plan = await planDismiss(deps, home, config, target);
    if (!plan.ok) return plan;
    const known = fetched.get(plan.value.clone);
    const fetch = known ?? (await fetchClone(deps, plan.value));
    fetched.set(plan.value.clone, fetch);
    if (!fetch.ok) return fetch;
    const reasons = await unpushedReasons(deps, plan.value, acceptedHeads);
    return reasons.ok ? ok({ plan: plan.value, reasons: reasons.value }) : reasons;
  };
};

/** The session whose last-seen line belongs to the worker, or null when the worker has no line that it owns. */
const lineSessionOf = async (deps: Deps, home: string, id: string): Promise<CliResult<string | null>> => {
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return seen;
  return ok(seen.value.state === 'valid' ? seen.value.line[lastSeen.keys.sessionId] : null);
};

/** One STUCK line for each reason, then the remedy line. `again` is the command that a person runs after the push. */
const stuckLines = (plan: DismissPlan, reasons: readonly string[], again: string = dismissLine(plan.id)): readonly OutLine[] => [
  ...reasons.map((reason) => fail(`${dismissWords.stuck} ${reason}.`)),
  text(`Push the work of the ${roles.worker} ${plan.id}. Then run "${commandText(again)}" again.`),
];

/** The ignored files that git does not hold: the removal of the work copy deletes them. */
const NO_IGNORED: IgnoredList = { paths: [], reachedCap: false };

/** The count of a list: "more than" the names that it holds when it reached the cap. */
const countOf = ({ paths, reachedCap }: IgnoredList): string => (reachedCap ? `more than ${paths.length}` : `${paths.length}`);

/**
 * The count and the first names of the files of one kind that the removal of the work copy deletes: the dry run says that it
 * `deletes` them, and the free says that it `deleted` them. A list that reached the cap says "more than" the names it holds. No line
 * for none.
 */
const deletedLines = (list: IgnoredList, kind: string, verb: 'deletes' | 'deleted'): readonly OutLine[] => {
  const { paths, reachedCap } = list;
  if (paths.length === 0 && !reachedCap) return [];
  const noun = !reachedCap && paths.length === 1 ? 'file' : 'files';
  const names = [paths.map((path) => displayLine(path)).join(', '), ...(reachedCap ? ['and more'] : [])].filter((part) => part !== '').join(' ');
  return [text(`The removal ${verb} ${countOf(list)} ${kind} ${noun}: ${names}.`)];
};

/** The ignored files that the removal of the work copy deletes. */
const ignoredLines = (ignored: IgnoredList, verb: 'deletes' | 'deleted'): readonly OutLine[] =>
  deletedLines(ignored, dismissWords.fileKinds.ignored, verb);

/** The files of the inbox of the worker that the removal of its record deletes. */
const inboxLines = (inbox: InboxList, verb: 'deletes' | 'deleted'): readonly OutLine[] => deletedLines(inbox, dismissWords.fileKinds.inbox, verb);

/** What the pane of the worker is now, for the words "end" and "close": a live pane ends, and a pane that ended is closed. */
const paneStep = (entry: WorkerStatus): 'end' | 'close' | null => {
  if (entry.pane === null) return null;
  return entry.running ? 'end' : 'close';
};

const keptBranchLine = (plan: DismissPlan): OutLine =>
  text(`The branch ${plan.branch} stays. To delete it too, run "git -C ${shellWord(plan.clone)} branch -D ${shellWord(plan.branch)}".`);

const dryRunLines = (entry: WorkerStatus, plan: DismissPlan, ignored: IgnoredList, inbox: InboxList): readonly OutLine[] => {
  const step = paneStep(entry);
  return [
    ...(step === 'end' ? [text(`Would end the pane ${entry.pane} of the ${roles.worker} ${plan.id}.`)] : []),
    ...(step === 'close' ? [text(`Would close the ended pane ${entry.pane} of the ${roles.worker} ${plan.id}.`)] : []),
    text(`Would remove the work copy ${plan.workCopy}.`),
    text(`Would delete the record of the ${roles.worker} ${plan.id} and its last-seen line.`),
    keptBranchLine(plan),
    ...ignoredLines(ignored, 'deletes'),
    ...inboxLines(inbox, 'deletes'),
    text(`Nothing changed. Run "${commandText(dismissLine(plan.id))} ${flagText(flags.yes)}" to do it.`),
  ];
};

const freedLines = (plan: DismissPlan, freed: FreedWorker, ignored: IgnoredList, inbox: InboxList = NO_IGNORED): readonly OutLine[] => {
  const { stopped } = freed;
  return [
    ...(stopped.kind === 'stopped' ? [text(`Ended the pane ${stopped.paneId} of the ${roles.worker} ${plan.id}.`)] : []),
    ...(stopped.kind === 'closed-dead' ? [text(`Closed the ended pane ${stopped.paneIds.join(', ')} of the ${roles.worker} ${plan.id}.`)] : []),
    text(`Removed the work copy ${plan.workCopy}.`),
    ...ignoredLines(ignored, 'deleted'),
    ...inboxLines(inbox, 'deleted'),
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

/** The command that a person runs again for these options, without the program name. */
const againOf = (options: DismissOptions): string => {
  if (options.idle) return IDLE_LINE;
  const line = `${commands.dismiss} ${options.words.join(' ')}`;
  return options.closed ? `${line} ${flagText(flags.closed)}` : line;
};

const factsOf = async (
  deps: Deps,
  options: DismissOptions,
  workItems: WorkItemPort,
  home: string,
  config: FactoryConfig,
): Promise<CliResult<Facts>> => {
  const session = config.core.node.id;
  const panes = await readPanes(deps, session, home, commandText(againOf(options)));
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
    const inbox = await inboxFilesIn(deps, home, id);
    if (!inbox.ok) return inbox;
    return ok({
      lines: dryRunLines(entry, plan, ignored.value, inbox.value),
      json: {
        ...base,
        freed: false,
        workers: [{ id, project: plan.project, pushed: true, stuck: [], ignored: ignored.value.paths, inbox: inbox.value.paths }],
      },
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

/** The command of the closed path for a worker: `dismiss ID --closed`. */
const closedLine = (id: string): string => `${dismissLine(id)} ${flagText(flags.closed)}`;

/** The ids of items, at most `maxItemsNamed` of them, with the count of the rest. */
const namedItems = (ids: readonly string[]): string => {
  const { maxItemsNamed } = dismissWords;
  return ids.length > maxItemsNamed ? `${ids.slice(0, maxItemsNamed).join(', ')} and ${ids.length - maxItemsNamed} more` : ids.join(', ');
};

/**
 * What the board proves for the free of a worker with `--closed`, read now: a work item that the board knows, with no open item, no
 * item that is not closed and carries the unassign mark of the worker, and at least one closed item that names the worker. The value is
 * the work item, or the reason that it fails. The absence of an open item is no proof: only a closed item that names the worker is.
 */
const closedWorkOf = async (deps: Deps, workItems: WorkItemPort, home: string, id: string): Promise<Result<KnownWorkItem, string>> => {
  const read = await workItems.itemsOf(deps, home, [id]);
  if (!read.ok) return err(`cannot read the board: ${read.error.message}`);
  const work = read.value.get(id);
  if (work === undefined || work.state !== 'known') return err(`the board does not say what work the ${roles.worker} ${id} has`);
  if (work.item !== null) return err(`the ${roles.worker} ${id} has open work: ${work.item}`);
  if (work.parked.length > 0) return err(`the open items ${namedItems(work.parked)} carry the unassign mark of the ${roles.worker} ${id}`);
  if (work.closed.length === 0) return err(`no closed item names the ${roles.worker} ${id}`);
  return ok(work);
};

/** The refusal of the closed path: nothing is freed, and the owner frees the worker with the yes flag in a terminal window. */
const refuseClosed = (reason: string, id: string): CliResult<never> =>
  safetyRefusal(
    `${commands.dismiss} ${flagText(flags.closed)} frees nothing: ${reason}`,
    `The ${roles.owner} runs "${commandText(`${dismissLine(id)} ${flagText(flags.yes)}`)}" in a terminal window outside a ${places.session}.`,
  );

/** The decision row of a free: the worker, the closed items, the pushed head and the counts of the files that the removal deletes. */
const freeDecisionOf = (plan: DismissPlan, closed: readonly string[], head: string, ignored: IgnoredList, inbox: InboxList): DecisionLogInput => ({
  title: `Free the ${roles.worker} ${plan.id}`,
  decider: requestDeciders.coordinator,
  decision:
    `Free the ${roles.worker} ${plan.id}. Closed items: ${namedItems(closed)}. Pushed head: ${head}. ` +
    `Ignored files: ${countOf(ignored)}. Inbox files: ${countOf(inbox)}.`,
});

/**
 * The check of the closed path right before the removal: the evidence of the board and the pushed test, read again, and the head of the
 * work copy, which must be the head that the decision row names. The recheck does not fetch, so a head that moved can pass the pushed
 * test on a copy of the remote branch that a push from the work copy moved too: only the head of the row is a head that the first
 * check saw. A change since the first check stops the free with a failure (exit 1) that says the worker was not freed.
 */
const recheckClosed = async (deps: Deps, workItems: WorkItemPort, home: string, plan: DismissPlan, head: string): Promise<CliResult<void>> => {
  const stopped = (reason: string): CliResult<never> =>
    failure(`${reason}, so the ${roles.worker} ${plan.id} was not freed`, `Check the cause. Then run "${commandText(closedLine(plan.id))}" again.`);
  const work = await closedWorkOf(deps, workItems, home, plan.id);
  if (!work.ok) return stopped(work.error);
  const now = await headOf(deps, plan.workCopy, plan.gitDir);
  if (!now.ok) return stopped(now.error.message);
  if (now.value !== head) return stopped(`the head of the work copy moved from ${head} to ${now.value ?? 'no commit'} after the first check`);
  const reasons = await unpushedReasons(deps, plan, work.value.mergedPrHeads);
  if (!reasons.ok) return stopped(reasons.error.message);
  return reasons.value.length === 0 ? ok(undefined) : stopped(reasons.value.join('; '));
};

/**
 * `dismiss ID --closed`: the coordinator frees a finished worker in its own session, when every guard passes. The guards are the
 * caller rule (a mistake guard, no proof), a work item that the board knows with a closed item that names the worker and no item that
 * is not closed that names it or carries its unassign mark, and the pushed and clean test (a head equal to the recorded head of a
 * closed item of the worker counts as pushed). Every other case is an owner step: the command refuses with exit 4 and names the owner
 * command. One decision row names the free and the pushed head before it. Right before the removal the board and the work copy are
 * checked again, and the head must still be the head of the row. A fault of the second check keeps the work copy and the record and
 * says that the row stays. It never uses the yes flag.
 */
const dismissClosed = async (
  deps: Deps,
  options: DismissOptions,
  registry: RecipeRegistry,
  decisions: DecisionLogPort,
  workItems: WorkItemPort,
): Promise<CliResult<CommandOutput>> => {
  const [id = ''] = options.words;
  const again = closedLine(id);
  const located = await locateHomeFolder(deps, options.home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), commands.dismiss);
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const caller = await requireCoordinatorCaller(deps, home, config, again);
  if (!caller.ok) return caller;
  const record = await requireRecord(deps, home, id, commandText(commands.dismiss));
  if (!record.ok) return record;
  const facts = await factsOf(deps, options, workItems, home, config);
  if (!facts.ok) return facts;
  const entry = facts.value.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return failure(`cannot read the state of the ${roles.worker} ${id}`, `Run "${commandText(again)}" again.`);
  const endable = requireEndable(entry, again);
  if (!endable.ok) return endable;
  const work = await closedWorkOf(deps, workItems, home, id);
  if (!work.ok) return refuseClosed(work.error, id);
  const inspected = await inspectorOf(deps, home, config, work.value.mergedPrHeads)({ id, project: record.value.project });
  if (!inspected.ok) return inspected;
  const { plan, reasons } = inspected.value;
  const warnings = facts.value.warnings;
  const base = { schema: schemaIds.dismiss, home, idle: false, yes: false, closed: true };
  if (reasons.length > 0) {
    return ok({
      lines: stuckLines(plan, reasons, again),
      json: { ...base, freed: false, workers: [{ id, project: plan.project, pushed: false, stuck: reasons }] },
      warnings,
      failed: true,
      exitCode: 1,
    });
  }
  const head = await headOf(deps, plan.workCopy, plan.gitDir);
  if (!head.ok) return head;
  const pushedHead = head.value;
  if (pushedHead === null) return failure(`the work copy of the ${roles.worker} ${id} has no commit`, `Run "${commandText(again)}" again.`);
  const ignored = await ignoredIn(deps, plan);
  if (!ignored.ok) return ignored;
  const inbox = await inboxFilesIn(deps, home, id);
  if (!inbox.ok) return inbox;
  const lineSession = await lineSessionOf(deps, home, id);
  if (!lineSession.ok) return lineSession;
  const logged = await decisions.log(deps, home, config, freeDecisionOf(plan, work.value.closed, pushedHead, ignored.value, inbox.value));
  if (!logged.ok) return logged;
  const row = logged.value;
  const freed = await freeWorker(deps, {
    home,
    session: facts.value.session,
    plan,
    panes: facts.value.panes,
    lineSession: lineSession.value,
    beforeRemoval: () => recheckClosed(deps, workItems, home, plan, pushedHead),
  });
  if (!freed.ok) return err({ ...freed.error, message: `${freed.error.message}. The decision ${row} stays in the log` });
  return ok({
    lines: [text(`Logged the decision ${row} to free the ${roles.worker} ${id}.`), ...freedLines(plan, freed.value, ignored.value, inbox.value)],
    json: {
      ...base,
      freed: true,
      decision: row,
      workers: [
        { id, project: plan.project, pushed: true, stuck: [], ended: freed.value.stopped.kind !== 'no-pane', ignored: ignored.value.paths, inbox: inbox.value.paths },
      ],
    },
    warnings,
    failed: false,
  });
};

/** True when the checks passed and found no reason that the work is not pushed. A check that failed counts as not pushed. */
const isPushed = (inspected: CliResult<Inspected> | undefined): boolean =>
  inspected !== undefined && inspected.ok && inspected.value.reasons.length === 0;

/**
 * The ignored files that the free of each listed worker deletes, for the table. A worker whose work is not pushed is not freed, and
 * a read that fails is no reason to stop a list: neither has an entry. The read of the pick fails the run, as before.
 */
const ignoredOf = async (
  deps: Deps,
  listed: readonly WorkerStatus[],
  checked: ReadonlyMap<string, CliResult<Inspected>>,
): Promise<ReadonlyMap<string, IgnoredList>> => {
  const lists = new Map<string, IgnoredList>();
  for (const entry of listed) {
    const inspected = checked.get(entry.id);
    if (inspected === undefined || !inspected.ok || inspected.value.reasons.length > 0) continue;
    const ignored = await ignoredIn(deps, inspected.value.plan);
    if (ignored.ok) lists.set(entry.id, ignored.value);
  }
  return lists;
};

const stateText = (entry: WorkerStatus): string => (entry.running ? entry.state : statusWords.stopped);

/**
 * The workers that `dismiss --idle` lists and lets the owner pick: idle (a live pane at its prompt with an old event) and with a
 * work item that the board knows and that has no open item. The idle state alone never lists a worker, and a work item that is
 * unknown never does.
 */
const listableOf = (entries: readonly WorkerStatus[]): readonly WorkerStatus[] =>
  entries.filter((entry) => entry.idle && entry.noOpenWork);

/** The picked worker as a refusal, or its checks: it must be listed, ready to end, and not be this pane. */
const requirePick = (deps: Deps, id: string, listed: readonly WorkerStatus[], panes: readonly PaneRow[]): CliResult<WorkerStatus> => {
  const entry = listed.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    return failure(
      `the ${roles.worker} ${id} is not in the list of idle ${roles.worker}s`,
      `Run "${commandText(commands.status)}" to see the state of each ${roles.worker}, or run "${commandText(IDLE_LINE)}" again.`,
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
  /** The count of the ignored files that the free deletes, or null when they are not read. At the cap it is the cap, and `ignoredMore` is true. */
  readonly ignoredCount: number | null;
  readonly ignoredMore: boolean;
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
 * idle with no open work, and its work must be pushed) before the first change. Then each picked worker is freed as `dismiss ID --yes`
 * frees it. The table goes to stdout before the question, so the owner sees the state, the pushed test and the ignored files that
 * each free deletes when the owner picks; the output of the run does not repeat it.
 */
const pickAndFree = async (deps: Deps, options: DismissOptions, workItems: WorkItemPort, facts: Facts, listed: Listed): Promise<CliResult<CommandOutput>> => {
  const { table, workers, json } = listed;
  const { warnings } = facts;
  const shown = await deps.writeStdout(`${table.map((line) => printable(line.text)).join('\n')}\n`);
  if (!shown.ok) return shown;
  const answer = await deps.prompt(printable(`Dismiss which ${roles.worker}s? Type their ids with spaces, or press Enter to end nothing: `));
  if (!answer.ok) return answer;
  const ids = idsOf(answer.value);
  if (ids.length === 0) return ok({ lines: [text('Nothing picked. Nothing changed.')], json, warnings, failed: false });
  const now = await factsOf(deps, options, workItems, facts.home, facts.config);
  if (!now.ok) return now;
  const idleNow = listableOf(now.value.entries);
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
    lines,
    json: { ...json, freed: freed.length > 0, workers: withIgnored, picked: ids, stuck },
    warnings,
    failed: stuck.length > 0,
    ...(stuck.length > 0 ? { exitCode: 1 } : {}),
  });
};

/**
 * `dismiss --idle`: lists the idle workers that have no open work, with their state, whether their work is pushed and the count of the
 * ignored files that their free deletes, and changes nothing. Inside a factory session the pick step stops (exit 4). With no terminal
 * window the list is all. In a terminal window the owner types the ids to dismiss: every id is checked before the first change, and
 * then each picked worker is freed as `dismiss ID --yes` frees it.
 */
const dismissIdle = async (deps: Deps, options: DismissOptions, registry: RecipeRegistry, workItems: WorkItemPort): Promise<CliResult<CommandOutput>> => {
  const located = await locateHomeFolder(deps, options.home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), commands.dismiss);
  if (!located.ok) return located;
  const home = located.value.home;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const facts = await factsOf(deps, options, workItems, home, loaded.value);
  if (!facts.ok) return facts;
  const idle = listableOf(facts.value.entries);
  const warnings = facts.value.warnings;
  const base = { schema: schemaIds.dismiss, home, idle: true, yes: false };
  const inspect = inspectorOf(deps, home, loaded.value);
  const checked = new Map<string, CliResult<Inspected>>();
  for (const entry of idle) checked.set(entry.id, await inspect({ id: entry.id, project: entry.project }));
  const ignored = await ignoredOf(deps, idle, checked);
  const pushedWord = (id: string): string => (isPushed(checked.get(id)) ? dismissWords.pushed.yes : dismissWords.pushed.no);
  const ignoredCell = (id: string): string => {
    const list = ignored.get(id);
    return list === undefined ? dismissWords.noCount : countOf(list);
  };
  const table =
    idle.length === 0
      ? [text(`No idle ${roles.worker}s.`)]
      : tableLines(
          Object.values(dismissWords.columns),
          idle.map((entry) =>
            [entry.id, entry.project, stateText(entry), pushedWord(entry.id), ignoredCell(entry.id)].map((cell) => displayLine(cell)),
          ),
        );
  const listed: readonly ListedWorker[] = idle.map((entry) => ({
    id: entry.id,
    project: entry.project,
    state: stateText(entry),
    pushed: isPushed(checked.get(entry.id)),
    ignoredCount: ignored.get(entry.id)?.paths.length ?? null,
    ignoredMore: ignored.get(entry.id)?.reachedCap ?? false,
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
 * copy, so the dry run and each free name them (read before the removal), and the dry run names the inbox files that the removal of the
 * record deletes. The branch stays. `dismiss ID --closed` is the one free that the coordinator may run in its own session
 * (`dismissClosed`); every other free stays an owner step.
 */
export const runDismiss = async (
  deps: Deps,
  options: DismissOptions,
  registry: RecipeRegistry,
  decisions: DecisionLogPort,
  workItems: WorkItemPort,
): Promise<CliResult<CommandOutput>> => {
  const checked = checkWords(options);
  if (!checked.ok) return checked;
  if (options.closed) return dismissClosed(deps, options, registry, decisions, workItems);
  return options.idle ? dismissIdle(deps, options, registry, workItems) : dismissOne(deps, options, registry, workItems);
};
