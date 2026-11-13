import { err, ok } from '../core/result.js';
import { failure, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { attachHint, type PaneRow } from '../launch/tmux.js';
import { commands, commandText, flags, flagText, roles, schemaIds, tmuxNames, type CommandName } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import {
  newProxyAnswers,
  resumeLine,
  resumeWorker,
  sessionProxyWish,
  workerProxyWish,
  type ProxyAnswers,
  type WorkerLaunch,
} from '../workers/launch.js';
import {
  checkTargets,
  clearMark,
  endSession,
  rebootFault,
  requireProxies,
  runsInside,
  stopWorkers,
  type EndedSession,
  type MarkOutcome,
} from '../workers/lifecycle.js';
import { listPanes, readPanes } from '../workers/panes.js';
import { recoverWorkers, type RecoveryReport } from '../workers/recovery.js';
import { listWorkerRecords, requireRecord } from '../workers/registry.js';
import { stopWorker, type StopOutcome } from '../workers/stop.js';
import { prepareLaunch, prepareRoot } from './launch-checks.js';
import { coordinatorResumeLine, renderStartFiles, requireSessionGit, startAgain } from './start.js';

/**
 * The lifecycle verbs (design 4.11): `shutdown` ends this factory, `restart` stops one worker and starts it again with its session
 * id, and `reboot` does that for every worker. Each one reads the list of the panes of its session once, checks every worker before
 * the first stop (`checkTargets`) and stops only the panes that this factory made.
 */

export interface LifecycleOptions {
  readonly home: string | undefined;
}

export interface RestartOptions extends LifecycleOptions {
  /** The words after the command: the id of the worker. */
  readonly words: readonly string[];
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** The factory folder of the command: the folder of the option, or the one that the current folder is in. */
const locate = async (
  deps: Deps,
  home: string | undefined,
  command: CommandName,
  registry: RecipeRegistry,
): Promise<CliResult<string>> => {
  const located = await locateHomeFolder(
    deps,
    home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    command,
  );
  return located.ok ? ok(located.value.home) : located;
};

const listOf = (ids: readonly string[]): string => ids.join(', ');

const stoppedLines = (stopped: readonly string[]): readonly OutLine[] =>
  stopped.length === 0 ? [] : [text(`Stopped the ${roles.worker}s: ${listOf(stopped)}.`)];

/** The line about the mark of the active machine. A mark that was never there, and a mark that could not be cleared, add no line. */
const markLines = (mark: MarkOutcome): readonly OutLine[] => {
  switch (mark) {
    case 'cleared':
      return [text('Cleared the mark of the active machine.')];
    case 'other':
      return [text('The mark of the active machine names another machine, so it stays.')];
    case 'absent':
    case 'failed':
      return [];
    default: {
      const unreachable: never = mark;
      return unreachable;
    }
  }
};

/**
 * Prints the report of a shutdown at once, before the session ends. A command that runs in a pane of the session ends with the
 * session, so the lines that it returns are lost: the lines of the report go to the warning channel (stderr) instead.
 */
const announceEnd = (deps: Deps, session: string, done: EndedSession): void => {
  const lines = [
    ...stoppedLines(done.stopped),
    ...markLines(done.mark),
    text(`The tmux session ${session} ends next: this command runs in a pane of it.`),
  ];
  for (const line of lines) deps.warn(line.text);
};

/**
 * `shutdown`: ends this factory and nothing else. With no session it says that nothing runs and exits 0. A session of the same
 * name that belongs to another folder, or that has no home option, stays (exit 4). Every worker that has a live pane needs a known
 * case before the first stop (exit 3). Then each worker stops, the mark of the active machine is cleared, and the session ends by
 * its exact name. From a pane of the session, the report is printed before the session ends (`announceEnd`).
 */
export const runShutdown = async (
  deps: Deps,
  options: LifecycleOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locate(deps, options.home, commands.shutdown, registry);
  if (!located.ok) return located;
  const home = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const session = loaded.value.core.node.id;
  const panes = await readPanes(deps, session, home, commandText(commands.shutdown));
  if (!panes.ok) return panes;
  if (panes.value === null) {
    const mark = await clearMark(deps, home, commands.shutdown);
    return ok({
      lines: [text(`Nothing runs: the tmux session ${session} does not run.`), ...markLines(mark)],
      json: { schema: schemaIds.shutdown, session, running: false, workers: [], mark },
      warnings: [],
      failed: false,
    });
  }
  const checked = await checkTargets(deps, { home, session, again: commands.shutdown, panes: panes.value, launches: [] });
  if (!checked.ok) return checked;
  const ended = await endSession(deps, {
    home,
    session,
    panes: panes.value,
    command: commands.shutdown,
    ...(runsInside(deps, panes.value) ? { beforeEnd: (done: EndedSession) => announceEnd(deps, session, done) } : {}),
  });
  if (!ended.ok) return ended;
  return ok({
    lines: [
      ...stoppedLines(ended.value.stopped),
      ...markLines(ended.value.mark),
      text(`Ended the tmux session ${session}.`),
    ],
    json: { schema: schemaIds.shutdown, session, running: true, workers: ended.value.stopped, mark: ended.value.mark },
    warnings: [],
    failed: false,
  });
};

/** The error of a launch after the stop: it says that the worker stopped, and it keeps the remedy of the launch. */
const notStarted = (error: CliError, id: string, stopped: StopOutcome): CliError => {
  const hint = error.hint ?? `Run "${commandText(resumeLine(id))}" to try again.`;
  const message =
    stopped.kind === 'no-pane' ? error.message : `${error.message}. The ${roles.worker} ${id} stopped and did not start again`;
  return { ...error, message, hint };
};

const restartOutput = (input: {
  readonly id: string;
  readonly resumeId: string;
  readonly stopped: StopOutcome;
  readonly launch: WorkerLaunch;
  readonly notes: readonly string[];
}): CommandOutput => {
  const { id, resumeId, stopped, launch, notes } = input;
  const { paneId, proxy, warnings } = launch;
  return {
    lines: [
      ...(stopped.kind === 'no-pane' ? [] : [text(`Stopped the ${roles.worker} ${id}.`)]),
      text(`Resumed the ${roles.worker} ${id} in the pane ${paneId} of the window ${tmuxNames.windowWorkers}.`),
      text('It continues the earlier conversation.'),
    ],
    json: { schema: schemaIds.restart, id, stopped: stopped.kind !== 'no-pane', pane: paneId, sessionId: resumeId, proxy },
    warnings: [...notes, ...warnings],
    failed: false,
  };
};

/**
 * `restart ID`: stops one worker and starts it again with its session id. The other workers keep their panes. In order: the checks
 * of `start` for the root and the tools (exit 4) and the session (exit 3, which names `start`, or exit 4 for a session of another
 * folder); the record of the worker (exit 2); one list of the panes; then the checks of this worker before the stop: a session id
 * that passed the owner check, a known case, a work copy with clean settings files (exit 3 or exit 4), and the proxy of the worker
 * (exit 1). After these checks the worker stops (`stopWorker`) and starts again (`resumeWorker`), with the answer of the proxy check.
 */
export const runRestart = async (
  deps: Deps,
  options: RestartOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [id] = options.words;
  if (options.words.length !== 1 || id === undefined) {
    return usageError(
      `${commands.restart} takes one argument: the id of the ${roles.worker}`,
      `Run "${commandText(commands.restart)} ${flagText(flags.help)}".`,
    );
  }
  const located = await locate(deps, options.home, commands.restart, registry);
  if (!located.ok) return located;
  const home = located.value;
  const again = `${commands.restart} ${id}`;
  const prepared = await prepareLaunch(deps, home, registry, commandText(again));
  if (!prepared.ok) return prepared;
  const { config, notes } = prepared.value;
  const record = await requireRecord(deps, home, id, commandText(commands.restart));
  if (!record.ok) return record;
  const session = config.core.node.id;
  const listed = await listPanes(deps, session);
  if (!listed.ok) return listed;
  const panes = listed.value.filter((row) => row.worker === id);
  const checked = await checkTargets(deps, { home, session, again, panes, launches: [record.value] });
  if (!checked.ok) return checked;
  const resumeId = checked.value.get(id);
  if (resumeId === undefined) {
    return failure(`no session id was checked for the ${roles.worker} ${id}`, `Run "${commandText(again)}" again.`);
  }
  const proxyAnswers = newProxyAnswers();
  const proxy = await requireProxies(deps, config, [workerProxyWish(config, id, again)], proxyAnswers);
  if (!proxy.ok) return proxy;

  const stopped = await stopWorker(deps, { home, session, workerId: id, panes });
  if (!stopped.ok) return stopped;
  const launched = await resumeWorker(deps, {
    home,
    config,
    workerId: id,
    workCopy: record.value.workCopy,
    retry: resumeLine(id),
    resumeId,
    proxyAnswers,
  });
  if (!launched.ok) return err(notStarted(launched.error, id, stopped.value));
  return ok(restartOutput({ id, resumeId, stopped: stopped.value, launch: launched.value, notes }));
};

/** The lines about the workers that start again: the ones that run, the ones with no usable id and the ones that failed. */
const recoveryLines = (workers: RecoveryReport | null): readonly OutLine[] =>
  workers === null
    ? []
    : [
        ...(workers.resumed.length === 0 ? [] : [text(`Resumed the ${roles.worker}s: ${listOf(workers.resumed)}.`)]),
        ...(workers.skipped.length === 0 ? [] : [text(`Not resumed: ${listOf(workers.skipped)}.`)]),
        ...(workers.failed.length === 0 ? [] : [text(`Did not start again: ${listOf(workers.failed)}.`)]),
      ];

/** True when a worker that the run tried to start again did not run. A skipped folder with no record is no fault of the run. */
const someFailed = (workers: RecoveryReport | null): boolean => workers !== null && workers.failed.length > 0;

/** What the end of the session gives when no session runs: no worker stopped, and the mark stays as it is. */
const NOTHING_ENDED: EndedSession = { stopped: [], mark: 'absent' };

/** What a reboot knows after its checks: the folder, the session, the config, the notes of the local file and the proxy answers of the run. */
interface RebootRun {
  readonly home: string;
  readonly session: string;
  readonly config: FactoryConfig;
  readonly notes: readonly string[];
  /** One set of answers for the run, so each proxy is asked once (the start path and the recovery use it). */
  readonly answers: ProxyAnswers;
}

/** The reboot from a pane of the session: the workers stop and start again, and the session with its coordinator pane stays. */
const rebootInside = async (deps: Deps, run: RebootRun, panes: readonly PaneRow[]): Promise<CliResult<CommandOutput>> => {
  const { home, session, config, notes, answers } = run;
  const stopped = await stopWorkers(deps, { home, session, panes });
  if (stopped.fault !== null) return err(rebootFault(stopped.fault, stopped.stopped, false));
  const recovered = await recoverWorkers(deps, { home, config, proxyAnswers: answers });
  if (!recovered.ok) return err(rebootFault(recovered.error, stopped.stopped, false));
  return ok({
    lines: [
      ...stoppedLines(stopped.stopped),
      text(`Kept the session ${session} and the ${roles.coordinator} pane.`),
      ...recoveryLines(recovered.value),
    ],
    json: { schema: schemaIds.reboot, session, inSession: true, stopped: stopped.stopped, started: false, workers: recovered.value },
    warnings: notes,
    failed: someFailed(recovered.value),
  });
};

/**
 * The reboot from outside the session: the session ends as `shutdown` ends it (with no session, nothing ends), and the start path
 * makes it again with the recovery of the coordinator and the workers.
 */
const rebootOutside = async (
  deps: Deps,
  run: RebootRun,
  panes: readonly PaneRow[] | null,
): Promise<CliResult<CommandOutput>> => {
  const { home, session, config, notes, answers } = run;
  const ended = panes === null ? ok(NOTHING_ENDED) : await endSession(deps, { home, session, panes, command: commands.reboot });
  if (!ended.ok) return ended;
  const started = await startAgain(deps, home, config, answers);
  if (!started.ok) return err(rebootFault(started.error, ended.value.stopped, true));
  const { proxy, coordinatorResumed, workers, warnings } = started.value;
  return ok({
    lines: [
      ...stoppedLines(ended.value.stopped),
      text(`Started the session ${session} again.`),
      ...(coordinatorResumed ? [coordinatorResumeLine()] : []),
      ...recoveryLines(workers),
      text(`Attach with: ${attachHint(session)}`),
    ],
    json: {
      schema: schemaIds.reboot,
      session,
      inSession: false,
      stopped: ended.value.stopped,
      started: true,
      proxy,
      coordinatorResumed,
      workers,
    },
    warnings: [...notes, ...warnings],
    failed: someFailed(workers),
  });
};

/**
 * `reboot`: every recorded worker stops and starts again with its session id. In order: the checks of `start` for the root and the
 * tools (exit 4); the session of the node, which must be the session of this folder when it runs (exit 4); one list of the panes;
 * then the checks of every worker before the first stop (`checkTargets`), which need a session id that passed the owner check
 * for each recorded worker (exit 3), and the proxy of each launch after the stop (exit 1). Outside the session, the git checks of
 * `start` come next (exit 1): a git older than 2.26 stops the reboot before the first stop. With no session, nothing stops and the
 * start path recovers the workers as `start` does.
 * Outside the session, the steps of `start` that change a file come first (the safety block rendered again, and the hook
 * settings), before the first stop. Then the session ends as `shutdown` ends it, and it starts again with its recovery. Inside the session (the pane
 * of the caller is a pane of it), only the workers stop and start again, and the coordinator pane stays. A fault after the first
 * stop names the workers that stopped, and its remedy finishes the reboot (`rebootFault`).
 */
export const runReboot = async (
  deps: Deps,
  options: LifecycleOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locate(deps, options.home, commands.reboot, registry);
  if (!located.ok) return located;
  const home = located.value;
  const prepared = await prepareRoot(deps, home, registry);
  if (!prepared.ok) return prepared;
  const { config, notes } = prepared.value;
  const session = config.core.node.id;
  const panes = await readPanes(deps, session, home, commandText(commands.reboot));
  if (!panes.ok) return panes;
  const running = panes.value;
  const listed = running === null ? null : await listWorkerRecords(deps, home);
  if (listed !== null && !listed.ok) return listed;
  const checked = await checkTargets(deps, {
    home,
    session,
    again: commands.reboot,
    panes: running ?? [],
    launches: listed === null ? [] : listed.value.workers,
  });
  if (!checked.ok) return checked;
  const inside = running !== null && runsInside(deps, running);
  // Outside the session, a session is made again. A git that is too old would stop its claim of the active machine after that, so the
  // check comes before the first change and the first stop, and the session stays as it is.
  if (!inside) {
    const gitReady = await requireSessionGit(deps, home, commands.reboot);
    if (!gitReady.ok) return gitReady;
  }
  const run: RebootRun = { home, session, config, notes, answers: newProxyAnswers() };
  if (running !== null) {
    // The launches come after the stop, so their proxies are asked first: a proxy that does not answer stops nothing.
    const wishes = [
      ...(inside ? [] : [sessionProxyWish(config, commands.reboot)]),
      ...[...checked.value.keys()].map((id) => workerProxyWish(config, id, commands.reboot)),
    ];
    const proxies = await requireProxies(deps, config, wishes, run.answers);
    if (!proxies.ok) return proxies;
  }
  if (running !== null && inside) return rebootInside(deps, run, running);
  // Outside the session, the coordinator starts as `start` starts it, so the steps of `start` that change a file come first.
  const rendered = await renderStartFiles(deps, home, config, commands.reboot);
  if (!rendered.ok) return rendered;
  return rebootOutside(deps, run, running);
};
