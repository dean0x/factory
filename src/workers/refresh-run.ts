import { codedNotReady, failure, hasCode, notReady, paneNotFound, stopCaseRefused, trustQuestionWait, type CliError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { coordinatorLaunchWords } from '../commands/start.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { processStartSecondOf } from '../core/process-start.js';
import { ok } from '../core/result.js';
import { guardValuesFor } from '../guards/effective.js';
import { respawnPaneArgs, type CoordinatorPane, type LiveCoordinatorPane, type PaneRow } from '../launch/tmux.js';
import { requireSession, tmuxStep } from '../launch/tmux-run.js';
import { commands, commandText, env, lastSeen, launchConfirm, refreshText, refreshWait, roles, stopCaseOfState, workerRecord } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { startsCoordinator, wordsOfStartCommand } from './binding.js';
import { showsTrustQuestion } from './confirm.js';
import {
  promptStateOf, readOwnCoordinatorResume, readOwnCoordinatorSession, readOwnLastSeen, readWorkerLastSeen, type LastSeen,
} from './last-seen.js';
import { chooseProxy, newProxyAnswers, resumeLine, resumeWorker, sessionProxyWish, workerProxyWish } from './launch.js';
import { checkTargets } from './lifecycle.js';
import { readCoordinatorPane, readPanes, requireBoundPane, requireCoordinatorPane } from './panes.js';
import {
  claimRefreshRun, readOwnRefreshRun, readRefreshRun, refreshCoordinatorRemedy, refreshNoticeLimit, refreshResultCommand, updateRefreshRun,
  type RefreshFault, type RefreshOutcome, type RefreshRole, type RefreshRunChange, type RefreshRunRecord,
} from './refresh-record.js';
import { requireRecord } from './registry.js';
import { requireLineAfterStart, requireOwnHooks } from './session-checks.js';
import { readWorkerPanes } from './slot.js';
import { stopWorker, terminatePane } from './stop.js';

export interface RefreshTarget {
  readonly home: string;
  readonly config: FactoryConfig;
}

export interface RefreshRequest extends RefreshTarget {
  readonly token: string;
}

interface WorkerCheck {
  readonly id: string;
  readonly ready: boolean;
  readonly fault?: CliError;
}

interface RefreshPoll {
  readonly panes: readonly PaneRow[];
  readonly workers: readonly WorkerCheck[];
}

const keys = lastSeen.keys;
const AGAIN = commands.refresh;
const REFRESH = commandText(AGAIN);
const RETRY = `Run "${REFRESH}" again.`;
const START = `Check the ${roles.coordinator} pane. If its process ended, run "${commandText(commands.start)}".`;
const RESULT = `Run "${refreshResultCommand}" to see the last refresh run.`;
const MAX_SLEEPS = Math.ceil(refreshWait.idleCapMs / refreshWait.intervalMs);
const MS_PER_SECOND = 1000;
// Leave room for the role and id in the record's bounded fault text.
const DETAIL_LIMIT = 900;

const nodeOf = ({ config }: RefreshTarget): string => config.core.node.id;
const resumeRemedy = (id: string): string => `Check the ${roles.worker} pane. If its process ended, run "${commandText(resumeLine(id))}".`;
const faultText = (text: string): string => displayLine(text, DETAIL_LIMIT).slice(0, DETAIL_LIMIT);
const saved = (deps: Deps, { home, token }: RefreshRequest, change: RefreshRunChange) =>
  updateRefreshRun(deps, home, token, change);

const sessionFault = (role: RefreshRole, id: string, error: CliError, remedy: string): RefreshOutcome => ({
  role, id, status: hasCode(error, trustQuestionWait) ? 'trust-wait' : 'fault',
  warning: faultText(`${role} ${id}: ${error.message}`),
  remedy: faultText(error.hint ?? remedy),
});

const resumed = (role: RefreshRole, id: string): RefreshOutcome => ({ role, id, status: 'resumed' });

const withNotices = (outcome: RefreshOutcome, notices: readonly string[]): RefreshOutcome =>
  notices.length === 0 ? outcome : { ...outcome, notices: [...new Set(notices)].slice(0, refreshNoticeLimit) };

const restartPath = (startCommand: string, home: string): CliResult<string> => {
  const words = wordsOfStartCommand(startCommand);
  // The launch puts the PATH assignment immediately before the home assignment.
  const assignment = words?.[words.indexOf(`${env.home}=${home}`) - 1];
  const prefix = `${env.path}=`;
  const path = assignment?.startsWith(prefix) === true ? assignment.slice(prefix.length) : '';
  return path === '' || path.includes('\0')
    ? failure(`the pane start command has no ${env.path} value for refresh`,
        `Leave the pane open until you can restart it from a terminal. Run "${refreshResultCommand}" for the result.`)
    : ok(path);
};

const idleFault = (role: RefreshRole, id: string): RefreshOutcome => ({
  role, id, status: 'fault', warning: `${role} ${id} was not idle before the refresh wait ended`,
  remedy: `Wait until it returns to its prompt. ${RETRY}`,
});

const readRunningPanes = async (deps: Deps, target: RefreshTarget): Promise<CliResult<readonly PaneRow[]>> => {
  const session = nodeOf(target);
  const panes = await readPanes(deps, session, target.home, REFRESH);
  if (!panes.ok) return panes;
  return panes.value === null ? failure(`the tmux session ${session} does not run`, START) : ok(panes.value);
};

/** Read one own pane list and one hook line per pending worker. */
export const pollOnce = async (
  deps: Deps, target: RefreshTarget, pending: readonly string[],
): Promise<CliResult<RefreshPoll>> => {
  const panes = await readRunningPanes(deps, target);
  if (!panes.ok) return panes;
  if (pending.length > workerRecord.maxEntries) return failure(`too many ${roles.worker}s in the refresh run`, RESULT);
  const workers: WorkerCheck[] = [];
  for (const id of pending) {
    const seen = await readWorkerLastSeen(deps, target.home, id);
    workers.push(seen.ok
      ? { id, ready: seen.value.state === 'valid' && promptStateOf(seen.value.line) === 'prompt' }
      : { id, ready: false, fault: seen.error });
  }
  return ok({ panes: panes.value, workers });
};

const requireOlderProcess = async (deps: Deps, pid: number, startedAtMs: number): Promise<CliResult<number>> => {
  const started = await processStartSecondOf(deps, pid);
  if (!started.ok) {
    return notReady('cannot read when the process of the pane started', `Look at the pane in tmux. ${RETRY}`);
  }
  // The process must predate the run. Its whole start second must be before the run's start second.
  if (started.value >= Math.floor(startedAtMs / MS_PER_SECOND) * MS_PER_SECOND) {
    return failure('cannot confirm the pane process started before the refresh run began', RETRY);
  }
  return ok(started.value);
};

/** Run checks and act on one ready worker. Null means the idle gate refused; the worker stays pending. */
export const actWorker = async (
  deps: Deps, request: RefreshRequest, id: string, panes: readonly PaneRow[],
): Promise<CliResult<RefreshOutcome | null>> => {
  const { home, config, token } = request;
  const session = nodeOf(request);
  const own = await readOwnRefreshRun(deps, home, token);
  if (!own.ok) return own;
  const { quiet, notices } = collectNotices(deps);
  const fault = (error: CliError) => {
    const remedy = resumeRemedy(id);
    const cause = hasCode(error, paneNotFound) ? { ...error, hint: remedy } : error;
    return ok(withNotices(sessionFault(roles.worker, id, cause, remedy), [...notices]));
  };
  const ownedSession = await requireSession(quiet, session, home, REFRESH);
  if (!ownedSession.ok) return fault(ownedSession.error);
  const record = await requireRecord(quiet, home, id, commandText(resumeLine(id)));
  if (!record.ok) return fault(record.error);
  const workerPanes = panes.filter(({ worker }) => worker === id);
  const guards = await guardValuesFor(quiet, home);
  const checked = await checkTargets(quiet, { home, config, session, guards, again: AGAIN, panes: workerPanes, launches: [record.value] });
  if (!checked.ok) return fault(checked.error);
  // Refresh needs every state event, even if another launch can omit some hooks.
  const hooks = await requireOwnHooks(quiet, { home, folder: record.value.workCopy, then: AGAIN });
  if (!hooks.ok) return fault(hooks.error);
  const proxyAnswers = newProxyAnswers();
  const proxy = await chooseProxy(quiet, config, workerProxyWish(config, id, AGAIN), proxyAnswers, guards);
  if (!proxy.ok) return fault(proxy.error);
  const row = workerPanes.find(({ dead }) => !dead);
  if (row === undefined) return fault(failure(`the ${roles.worker} has no live pane to refresh`).error);
  const pane = await requireBoundPane(quiet, { home, paneId: row.paneId, workerId: id, again: AGAIN });
  if (!pane.ok) return fault(pane.error);
  if (pane.value.dead) return fault(failure(`the ${roles.worker} pane ended before the stop`).error);
  const path = restartPath(pane.value.startCommand, home);
  if (!path.ok) return fault(path.error);
  const older = await requireOlderProcess(quiet, pane.value.pid, own.value.startedAtMs);
  if (!older.ok) return fault(older.error);
  const marked = await saved(quiet, request, { kind: 'acting', role: roles.worker, id });
  if (!marked.ok) return marked;
  const stopped = await stopWorker(quiet, {
    home, session, workerId: id, process: { pid: pane.value.pid, startMs: older.value }, allowed: [stopCaseOfState.prompt], again: AGAIN,
  });
  if (!stopped.ok && hasCode(stopped.error, stopCaseRefused)) {
    const cleared = await saved(quiet, request, { kind: 'clear-acting' });
    return cleared.ok ? ok(null) : cleared;
  }
  if (!stopped.ok) return fault(stopped.error);
  const launchDeps = { ...quiet, env: { ...quiet.env, [env.path]: path.value } };
  const launched = await resumeStoppedWorker(launchDeps, request, id, record.value.workCopy, proxyAnswers, guards);
  if (!launched.ok) return launched;
  const launchNotices = launched.value.notices ?? (proxy.value.warning === undefined ? [] : [proxy.value.warning]);
  return ok(withNotices(launched.value, [...launchNotices, ...notices]));
};

const requireStoppedResume = async (deps: Deps, target: RefreshTarget, id: string, sessionId: string): Promise<CliResult<void>> => {
  const seen = await readOwnLastSeen(deps, target.home, id);
  if (!seen.ok) return seen;
  if (seen.value.state !== 'valid' || seen.value.line[keys.sessionId] !== sessionId) {
    return failure(`the ${roles.worker} no longer owns the session id for its restart`);
  }
  const panes = await readRunningPanes(deps, target);
  if (!panes.ok) return panes;
  return panes.value.some((pane) => pane.worker === id && !pane.dead) ? failure(`the ${roles.worker} already has a live pane`) : ok(undefined);
};

const resumeStoppedWorker = async (
  deps: Deps, request: RefreshRequest, id: string, workCopy: string,
  proxyAnswers: ReturnType<typeof newProxyAnswers>, guards: Awaited<ReturnType<typeof guardValuesFor>>,
): Promise<CliResult<RefreshOutcome>> => {
  const { home, config } = request;
  const session = nodeOf(request);
  const retry = resumeLine(id);
  const remedy = resumeRemedy(id);
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return ok(sessionFault(roles.worker, id, seen.error, remedy));
  if (seen.value.state !== 'valid') {
    return ok(sessionFault(roles.worker, id, failure(`no owned session id after the stop: ${seen.value.reason}`).error, remedy));
  }
  const panes = await readRunningPanes(deps, request);
  if (!panes.ok) return panes;
  const bound = await readWorkerPanes(deps, { home, session, workerId: id, again: retry, panes: panes.value });
  if (!bound.ok) return ok(sessionFault(roles.worker, id, bound.error, remedy));
  if (bound.value.live.length !== 0) {
    return ok(sessionFault(roles.worker, id, failure(`the ${roles.worker} already has a live pane`).error, remedy));
  }
  const resumeId = seen.value.line[keys.sessionId];
  const launched = await resumeWorker(deps, {
    home, config, guards, retry, workerId: id, workCopy, proxyAnswers, deadPanes: bound.value.dead,
    resumeId, prompt: refreshText.continue, beforeStart: () => requireStoppedResume(deps, request, id, resumeId),
  });
  if (!launched.ok) {
    const error = hasCode(launched.error, trustQuestionWait) ? launched.error : failure(launched.error.message).error;
    return ok(sessionFault(roles.worker, id, error, remedy));
  }
  const outcome = launched.value.lineConfirmed === true ? resumed(roles.worker, id)
    : sessionFault(roles.worker, id, failure('the continue line was not confirmed').error, remedy);
  return ok(withNotices(outcome, launched.value.warnings));
};

const eventAfter = (line: LastSeen, time: number): boolean => Date.parse(line[keys.eventAt] ?? '') > time;
const coordinatorIdle = (line: LastSeen, run: RefreshRunRecord): boolean =>
  promptStateOf(line) === 'prompt' && (!run.coordinatorPane || (line[keys.event] === 'Stop' && eventAfter(line, run.startedAtMs)));

const ownCoordinatorPane = (pane: CoordinatorPane | null, target: RefreshTarget, paneId: string): pane is CoordinatorPane =>
  pane !== null && pane.paneId === paneId && pane.node &&
  startsCoordinator(pane.startCommand, target.home, nodeOf(target), layoutOf(target.home).stateDir);

const coordinatorQuestion = (pane: CoordinatorPane) => codedNotReady(trustQuestionWait,
  `the ${roles.coordinator} waits on a folder question`, `Answer the folder question in pane ${pane.paneId}. Check that the ${roles.coordinator} continues its task.`);

const confirmCoordinator = async (
  deps: Deps, target: RefreshTarget, pane: CoordinatorPane, launchedAt: number,
): Promise<CliResult<void>> => {
  const node = nodeOf(target);
  for (let check = 0; check < launchConfirm.attempts; check += 1) {
    await deps.sleep(launchConfirm.intervalMs);
    const current = await readCoordinatorPane(deps, node);
    if (!current.ok) return current;
    if (!ownCoordinatorPane(current.value, target, pane.paneId) || current.value.dead || current.value.pid === pane.pid) {
      return failure(`the ${roles.coordinator} pane did not start again`);
    }
    const seen = await readOwnCoordinatorResume(deps, target.home, node);
    if (!seen.ok) return seen;
    if (seen.value.state !== 'valid' || !eventAfter(seen.value.line, launchedAt)) continue;
    const event = seen.value.line[keys.event];
    if (event === 'Notification' && await showsTrustQuestion(deps, pane.paneId, true)) return coordinatorQuestion(pane);
    if (event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'Stop' || event === 'Notification') return ok(undefined);
  }
  return await showsTrustQuestion(deps, pane.paneId, true) ? coordinatorQuestion(pane) : failure(`the ${roles.coordinator} resume or its continue line was not confirmed`);
};

const respawnCoordinator = async (
  deps: Deps, target: RefreshTarget, pane: LiveCoordinatorPane, sessionId: string, words: readonly string[],
): Promise<CliResult<void>> => {
  const node = nodeOf(target);
  const seen = await readOwnCoordinatorResume(deps, target.home, node);
  if (!seen.ok) return seen;
  if (seen.value.state !== 'valid' || seen.value.sessionId !== sessionId) {
    return failure(`the ${roles.coordinator} no longer owns the session id for its restart`);
  }
  const dead = await readCoordinatorPane(deps, node);
  if (!dead.ok) return dead;
  // TERM has finished. If tmux omits the pid, the same dead pane must still show the original launch.
  if (
    !ownCoordinatorPane(dead.value, target, pane.paneId) || !dead.value.dead ||
    (dead.value.pid === null ? dead.value.startCommand !== pane.startCommand : dead.value.pid !== pane.pid)
  ) {
    return failure(`the dead pane read did not confirm the ${roles.coordinator} pane that received TERM`);
  }
  const args = respawnPaneArgs(pane.paneId, layoutOf(target.home).coordinatorDir, words);
  if (!args.ok) return failure(args.error);
  const launchedAt = deps.now().getTime();
  const spawned = await tmuxStep(deps, args.value);
  return spawned.ok ? confirmCoordinator(deps, target, pane, launchedAt) : spawned;
};

/** Stop and respawn only the original coordinator pane. Null means it is not yet idle. */
export const actCoordinator = async (deps: Deps, request: RefreshRequest): Promise<CliResult<RefreshOutcome | null>> => {
  const { home, config, token } = request;
  const node = nodeOf(request);
  const own = await readOwnRefreshRun(deps, home, token);
  if (!own.ok) return own;
  const { quiet, notices } = collectNotices(deps);
  const fault = (error: CliError) => ok(withNotices(sessionFault(roles.coordinator, node, error, START), [...notices]));
  const seen = await readOwnCoordinatorResume(quiet, home, node);
  if (!seen.ok) return fault(seen.error);
  if (seen.value.state !== 'valid') {
    const reason = seen.value.state === 'absent' ? 'the pointer is absent' : seen.value.reason;
    return fault(failure(`no owned ${roles.coordinator} session id: ${reason}`).error);
  }
  if (!coordinatorIdle(seen.value.line, own.value)) return ok(null);
  const pane = await requireCoordinatorPane(quiet, home, config, AGAIN);
  if (!pane.ok) return fault(pane.error);
  const path = restartPath(pane.value.startCommand, home);
  if (!path.ok) return fault(path.error);
  const older = await requireOlderProcess(quiet, pane.value.pid, own.value.startedAtMs);
  if (!older.ok) return fault(older.error);
  const { coordinatorDir } = layoutOf(home);
  const hooks = await requireOwnHooks(quiet, { home, folder: coordinatorDir, then: AGAIN });
  if (!hooks.ok) return fault(hooks.error);
  const guards = await guardValuesFor(quiet, home);
  const proxy = await chooseProxy(quiet, config, sessionProxyWish(config, AGAIN), undefined, guards);
  if (!proxy.ok) return fault(proxy.error);
  const launchDeps = { ...quiet, env: { ...quiet.env, [env.path]: path.value } };
  const words = await coordinatorLaunchWords(launchDeps, {
    home, config, proxyBaseUrl: proxy.value.baseUrl, resumeId: seen.value.sessionId, prompt: refreshText.continue,
  });
  if (!words.ok) return fault(words.error);
  const marked = await saved(quiet, request, { kind: 'acting', role: roles.coordinator, id: node });
  if (!marked.ok) return marked;
  // The marker write can wait for the record lock. Check the pane and idle state after it.
  const current = await readCoordinatorPane(quiet, node);
  if (!current.ok) return fault(current.error);
  if (!ownCoordinatorPane(current.value, request, pane.value.paneId) || current.value.dead ||
    current.value.pid !== pane.value.pid || current.value.startCommand !== pane.value.startCommand) {
    return fault(failure(`the ${roles.coordinator} pane changed before the stop`).error);
  }
  const latest = await readOwnCoordinatorResume(quiet, home, node);
  if (!latest.ok) return fault(latest.error);
  if (latest.value.state !== 'valid' || latest.value.sessionId !== seen.value.sessionId) {
    return fault(failure(`the ${roles.coordinator} session id changed before the stop`).error);
  }
  const fresh = requireLineAfterStart(latest.value.line[keys.eventAt] ?? '', older.value, AGAIN, 'inclusive');
  if (!fresh.ok) return fault(fresh.error);
  if (!coordinatorIdle(latest.value.line, marked.value)) {
    const cleared = await saved(quiet, request, { kind: 'clear-acting' });
    return cleared.ok ? ok(null) : cleared;
  }
  const recoveryFault = (error: CliError) => sessionFault(roles.coordinator, node,
    hasCode(error, trustQuestionWait) ? error : { ...error, hint: refreshCoordinatorRemedy }, refreshCoordinatorRemedy);
  const stopped = await terminatePane(quiet, current.value, commands.start);
  if (!stopped.ok) return ok(withNotices(recoveryFault(stopped.error), [...notices]));
  const launched = await respawnCoordinator(quiet, request, current.value, seen.value.sessionId, words.value);
  const outcome = launched.ok ? resumed(roles.coordinator, node) : recoveryFault(launched.error);
  const launchNotices = proxy.value.warning === undefined ? [] : [proxy.value.warning];
  return ok(withNotices(outcome, [...launchNotices, ...notices]));
};

/** A refresh reports through its record only. The caller pane never supplies a target or veto. */
const quietDeps = (deps: Deps, warn: Deps['warn'] = () => undefined): Deps =>
  ({ ...deps, env: { ...deps.env, [env.tmuxPane]: undefined }, warn });

const collectNotices = (deps: Deps) => {
  const notices = new Set<string>();
  const quiet = quietDeps(deps, (note) => {
    if (notices.size < refreshNoticeLimit) notices.add(faultText(note));
  });
  return { quiet, notices };
};

const waitForPoll = async (deps: Deps, deadline: number, poll: number): Promise<boolean> => {
  const left = deadline - deps.now().getTime();
  if (left <= 0 || poll >= MAX_SLEEPS) return false;
  await deps.sleep(Math.min(left, refreshWait.intervalMs));
  return true;
};

const runWorkers = async (
  deps: Deps, request: RefreshRequest, deadline: number, workerIds: readonly string[],
): Promise<CliResult<RefreshRunRecord>> => {
  let pending = workerIds;
  for (let poll = 0; poll <= MAX_SLEEPS; poll += 1) {
    const own = await readOwnRefreshRun(deps, request.home, request.token);
    if (!own.ok) return own;
    const checked = await pollOnce(deps, request, pending);
    if (!checked.ok) return checked;
    const next: string[] = [];
    for (const { id, ready, fault } of checked.value.workers) {
      if (fault === undefined && (!ready || deps.now().getTime() > deadline)) {
        next.push(id);
        continue;
      }
      const acted = fault === undefined ? await actWorker(deps, request, id, checked.value.panes)
        : ok(sessionFault(roles.worker, id, fault, resumeRemedy(id)));
      if (!acted.ok) return acted;
      if (acted.value === null) {
        next.push(id);
        continue;
      }
      const recorded = await saved(deps, request, { kind: 'outcome', outcome: acted.value });
      if (!recorded.ok) return recorded;
    }
    pending = next;
    if (pending.length === 0 || !await waitForPoll(deps, deadline, poll)) break;
  }
  for (const id of pending) {
    const recorded = await saved(deps, request, { kind: 'outcome', outcome: idleFault(roles.worker, id) });
    if (!recorded.ok) return recorded;
  }
  return readOwnRefreshRun(deps, request.home, request.token);
};

const runCoordinator = async (deps: Deps, request: RefreshRequest, deadline: number): Promise<CliResult<RefreshRunRecord>> => {
  const node = nodeOf(request);
  for (let poll = 0; poll <= MAX_SLEEPS; poll += 1) {
    const own = await readOwnRefreshRun(deps, request.home, request.token);
    if (!own.ok) return own;
    const panes = await readRunningPanes(deps, request);
    if (!panes.ok) return panes;
    const seen = await readOwnCoordinatorSession(deps, request.home, node);
    if (!seen.ok) return seen;
    const ready = seen.value.state !== 'valid' || coordinatorIdle(seen.value.line, own.value);
    if (ready && deps.now().getTime() <= deadline) {
      const acted = await actCoordinator(deps, request);
      if (!acted.ok) return acted;
      if (acted.value !== null) return saved(deps, request, { kind: 'outcome', outcome: acted.value });
    }
    if (!await waitForPoll(deps, deadline, poll)) break;
  }
  return saved(deps, request, { kind: 'outcome', outcome: idleFault(roles.coordinator, node) });
};

const runClaimed = async (deps: Deps, request: RefreshRequest, run: RefreshRunRecord): Promise<CliResult<RefreshRunRecord>> => {
  const workerDeadline = run.deadlines.workerMs;
  if (workerDeadline === null) return failure(`the ${roles.worker} refresh wait has no deadline`, RESULT);
  const workers = await runWorkers(deps, request, workerDeadline, run.workerIds);
  if (!workers.ok) return workers;
  if (!workers.value.outcomes.some(({ status }) => status === 'trust-wait')) {
    const waiting = await saved(deps, request, { kind: 'wait-coordinator' });
    if (!waiting.ok) return waiting;
    const coordinatorDeadline = waiting.value.deadlines.coordinatorMs;
    if (coordinatorDeadline === null) return failure(`the ${roles.coordinator} refresh wait has no deadline`, RESULT);
    const coordinator = await runCoordinator(deps, request, coordinatorDeadline);
    if (!coordinator.ok) return coordinator;
  }
  return saved(deps, request, { kind: 'done' });
};

/** Claim once, run both phases and save the terminal record. A detached caller exits zero without printing it. */
export const runRefresh = async (deps: Deps, request: RefreshRequest): Promise<CliResult<RefreshRunRecord>> => {
  const quiet = quietDeps(deps);
  const claimed = await claimRefreshRun(quiet, request.home, request.token);
  if (!claimed.ok) return claimed;
  const result = await runClaimed(quiet, request, claimed.value);
  if (result.ok) return result;
  const fault: RefreshFault = { warning: faultText(result.error.message), remedy: faultText(result.error.hint ?? RESULT) };
  const failed = await saved(quiet, request, { kind: 'failed', fault });
  if (failed.ok) return failed;
  const current = await readRefreshRun(quiet, request.home);
  if (current.ok && current.value?.token === request.token && current.value.state === 'cancelled') return ok(current.value);
  return failed;
};

/** The foreground command uses the record, not the detached runner exit, for its verdict. */
export const refreshExitCode = (run: RefreshRunRecord): 0 | 1 | 3 => {
  if (run.state !== 'done' || run.fault !== null || run.outcomes.some(({ status }) => status === 'fault' || status === 'skipped')) return 1;
  return run.outcomes.some(({ status }) => status === 'trust-wait') ? 3 : 0;
};
