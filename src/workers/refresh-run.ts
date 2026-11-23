import { codedNotReady, failure, hasCode, stopCaseRefused, trustQuestionWait, type CliError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import { coordinatorLaunchWords } from '../commands/start.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { guardValuesFor } from '../guards/effective.js';
import { respawnPaneArgs, type CoordinatorPane, type PaneRow } from '../launch/tmux.js';
import { requireSession, tmuxStep } from '../launch/tmux-run.js';
import { commands, commandText, env, lastSeen, launchConfirm, refreshText, refreshWait, workerRecord } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { startsCoordinator } from './binding.js';
import { showsTrustQuestion } from './confirm.js';
import {
  promptStateOf, readOwnCoordinatorResume, readOwnCoordinatorSession, readOwnLastSeen, readWorkerLastSeen, type LastSeen,
} from './last-seen.js';
import { chooseProxy, newProxyAnswers, resumeLine, resumeWorker, sessionProxyWish, workerProxyWish } from './launch.js';
import { checkTargets, requireProxies } from './lifecycle.js';
import { readCoordinatorPane, readPanes, requireBoundPane, requireCoordinatorPane } from './panes.js';
import {
  claimRefreshRun, readOwnRefreshRun, readRefreshRun, refreshResultCommand, updateRefreshRun,
  type RefreshFault, type RefreshOutcome, type RefreshRunChange, type RefreshRunRecord,
} from './refresh-record.js';
import { requireRecord } from './registry.js';
import { paneProcessStart, requireOwnHooks } from './session-checks.js';
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
const START = `Check the coordinator pane. If its process ended, run "${commandText(commands.start)}".`;
const RESULT = `Run "${refreshResultCommand}" to see the last refresh run.`;
const MAX_SLEEPS = Math.ceil(refreshWait.idleCapMs / refreshWait.intervalMs);
// Leave room for the role and id in the record's bounded fault text.
const DETAIL_LIMIT = 900;

const nodeOf = ({ config }: RefreshTarget): string => config.core.node.id;
const resumeRemedy = (id: string): string => `Check the worker pane. If its process ended, run "${commandText(resumeLine(id))}".`;
const faultText = (text: string): string => displayLine(text, DETAIL_LIMIT).slice(0, DETAIL_LIMIT);
const saved = (deps: Deps, { home, token }: RefreshRequest, change: RefreshRunChange) =>
  updateRefreshRun(deps, home, token, change);

const sessionFault = (role: RefreshOutcome['role'], id: string, error: CliError, remedy: string): RefreshOutcome => ({
  role, id, status: hasCode(error, trustQuestionWait) ? 'trust-wait' : 'fault',
  warning: faultText(`${role} ${id}: ${error.message}`),
  remedy: faultText(error.hint ?? remedy),
});

const resumed = (role: RefreshOutcome['role'], id: string): RefreshOutcome => ({ role, id, status: 'resumed' });
const idleFault = (role: RefreshOutcome['role'], id: string): RefreshOutcome => ({
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
  if (pending.length > workerRecord.maxEntries) return failure('too many workers in the refresh run', RESULT);
  const workers: WorkerCheck[] = [];
  for (const id of pending) {
    const seen = await readWorkerLastSeen(deps, target.home, id);
    workers.push(seen.ok
      ? { id, ready: seen.value.state === 'valid' && promptStateOf(seen.value.line) === 'prompt' }
      : { id, ready: false, fault: seen.error });
  }
  return ok({ panes: panes.value, workers });
};

const requireOlderProcess = async (deps: Deps, pid: number, startedAtMs: number): Promise<CliResult<void>> => {
  const started = await paneProcessStart(deps, pid, AGAIN);
  if (!started.ok) return started;
  return started.value < startedAtMs ? ok(undefined) : failure('the pane process started after the refresh run began', RETRY);
};

/** A stop can rebind its pid. Refuse a different process from the one that passed the start check. */
const forWorkerProcess = (deps: Deps, expectedPid: number): Deps => ({
  ...deps,
  terminate: (pid) => pid === expectedPid ? deps.terminate(pid) : failure('the worker pane process changed before the stop', RETRY),
});

/** Run checks and act on one ready worker. Null means the idle gate refused; the worker stays pending. */
export const actWorker = async (
  deps: Deps, request: RefreshRequest, id: string, panes: readonly PaneRow[],
): Promise<CliResult<RefreshOutcome | null>> => {
  const { home, config, token } = request;
  const session = nodeOf(request);
  const own = await readOwnRefreshRun(deps, home, token);
  if (!own.ok) return own;
  const fault = (error: CliError) => ok(sessionFault('worker', id, error, resumeRemedy(id)));
  const quiet = quietDeps(deps);
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
  const proxy = await requireProxies(quiet, config, [workerProxyWish(config, id, AGAIN)], proxyAnswers, guards);
  if (!proxy.ok) return fault(proxy.error);
  const row = workerPanes.find(({ dead }) => !dead);
  if (row === undefined) return fault(failure('the worker has no live pane to refresh').error);
  const pane = await requireBoundPane(quiet, { home, paneId: row.paneId, workerId: id, again: AGAIN });
  if (!pane.ok) return fault(pane.error);
  if (pane.value.dead) return fault(failure('the worker pane ended before the stop').error);
  const older = await requireOlderProcess(quiet, pane.value.pid, own.value.startedAtMs);
  if (!older.ok) return fault(older.error);
  const marked = await saved(quiet, request, { kind: 'acting', role: 'worker', id });
  if (!marked.ok) return marked;
  const stopped = await stopWorker(forWorkerProcess(quiet, pane.value.pid), {
    home, session, workerId: id, panes: workerPanes, allowed: ['idle'], again: AGAIN,
  });
  if (!stopped.ok && hasCode(stopped.error, stopCaseRefused)) {
    const cleared = await saved(quiet, request, { kind: 'clear-acting' });
    return cleared.ok ? ok(null) : cleared;
  }
  if (!stopped.ok) return fault(stopped.error);
  return resumeStoppedWorker(quiet, request, id, record.value.workCopy, proxyAnswers, guards);
};

const requireStoppedResume = async (deps: Deps, target: RefreshTarget, id: string, sessionId: string): Promise<CliResult<void>> => {
  const seen = await readOwnLastSeen(deps, target.home, id);
  if (!seen.ok) return seen;
  if (seen.value.state !== 'valid' || seen.value.line[keys.sessionId] !== sessionId) {
    return failure('the worker no longer owns the session id for its restart');
  }
  const panes = await readRunningPanes(deps, target);
  if (!panes.ok) return panes;
  return panes.value.some((pane) => pane.worker === id && !pane.dead) ? failure('the worker already has a live pane') : ok(undefined);
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
  if (!seen.ok) return ok(sessionFault('worker', id, seen.error, remedy));
  if (seen.value.state !== 'valid') {
    return ok(sessionFault('worker', id, failure(`no owned session id after the stop: ${seen.value.reason}`).error, remedy));
  }
  const panes = await readRunningPanes(deps, request);
  if (!panes.ok) return panes;
  const bound = await readWorkerPanes(deps, { home, session, workerId: id, again: retry, panes: panes.value });
  if (!bound.ok) return ok(sessionFault('worker', id, bound.error, remedy));
  if (bound.value.live.length !== 0) {
    return ok(sessionFault('worker', id, failure('the worker already has a live pane').error, remedy));
  }
  const resumeId = seen.value.line[keys.sessionId];
  const launched = await resumeWorker(deps, {
    home, config, guards, retry, workerId: id, workCopy, proxyAnswers, deadPanes: bound.value.dead,
    resumeId, prompt: refreshText.continue, beforeStart: () => requireStoppedResume(deps, request, id, resumeId),
  });
  if (!launched.ok) {
    const error = hasCode(launched.error, trustQuestionWait) ? launched.error : failure(launched.error.message).error;
    return ok(sessionFault('worker', id, error, remedy));
  }
  return ok(launched.value.lineConfirmed === true ? resumed('worker', id)
    : sessionFault('worker', id, failure('the continue line was not confirmed').error, remedy));
};

const eventAfter = (line: LastSeen, time: number): boolean => Date.parse(line[keys.eventAt] ?? '') > time;
const coordinatorIdle = (line: LastSeen, run: RefreshRunRecord): boolean =>
  promptStateOf(line) === 'prompt' && (!run.coordinatorPane || (line[keys.event] === 'Stop' && eventAfter(line, run.startedAtMs)));

const ownCoordinatorPane = (pane: CoordinatorPane | null, target: RefreshTarget, paneId: string): pane is CoordinatorPane =>
  pane !== null && pane.paneId === paneId && pane.node &&
  startsCoordinator(pane.startCommand, target.home, nodeOf(target), layoutOf(target.home).stateDir);

const coordinatorQuestion = (pane: CoordinatorPane) => codedNotReady(trustQuestionWait,
  'the coordinator waits on a folder question', `Answer the folder question in pane ${pane.paneId}. Check that the coordinator continues its task.`);

const confirmCoordinator = async (
  deps: Deps, target: RefreshTarget, pane: CoordinatorPane, launchedAt: number,
): Promise<CliResult<void>> => {
  const node = nodeOf(target);
  for (let check = 0; check < launchConfirm.attempts; check += 1) {
    await deps.sleep(launchConfirm.intervalMs);
    const current = await readCoordinatorPane(deps, node);
    if (!current.ok) return current;
    if (!ownCoordinatorPane(current.value, target, pane.paneId) || current.value.dead || current.value.pid === pane.pid) {
      return failure('the coordinator pane did not start again');
    }
    const seen = await readOwnCoordinatorResume(deps, target.home, node);
    if (!seen.ok) return seen;
    if (seen.value.state !== 'valid' || !eventAfter(seen.value.line, launchedAt)) continue;
    const event = seen.value.line[keys.event];
    if (event === 'Notification' && await showsTrustQuestion(deps, pane.paneId, true)) return coordinatorQuestion(pane);
    if (event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'Stop' || event === 'Notification') return ok(undefined);
  }
  return await showsTrustQuestion(deps, pane.paneId, true) ? coordinatorQuestion(pane) : failure('the coordinator resume or its continue line was not confirmed');
};

/** Stop and respawn only the original coordinator pane. Null means it is not yet idle. */
export const actCoordinator = async (deps: Deps, request: RefreshRequest): Promise<CliResult<RefreshOutcome | null>> => {
  const { home, config, token } = request;
  const node = nodeOf(request);
  const own = await readOwnRefreshRun(deps, home, token);
  if (!own.ok) return own;
  const quiet = quietDeps(deps);
  const fault = (error: CliError) => ok(sessionFault('coordinator', node, error, START));
  const seen = await readOwnCoordinatorResume(quiet, home, node);
  if (!seen.ok) return fault(seen.error);
  if (seen.value.state !== 'valid') {
    const reason = seen.value.state === 'absent' ? 'the pointer is absent' : seen.value.reason;
    return fault(failure(`no owned coordinator session id: ${reason}`).error);
  }
  if (!coordinatorIdle(seen.value.line, own.value)) return ok(null);
  const pane = await requireCoordinatorPane(quiet, home, config, AGAIN);
  if (!pane.ok) return fault(pane.error);
  const older = await requireOlderProcess(quiet, pane.value.pid, own.value.startedAtMs);
  if (!older.ok) return fault(older.error);
  const { coordinatorDir } = layoutOf(home);
  const hooks = await requireOwnHooks(quiet, { home, folder: coordinatorDir, then: AGAIN });
  if (!hooks.ok) return fault(hooks.error);
  const guards = await guardValuesFor(quiet, home);
  const proxy = await chooseProxy(quiet, config, sessionProxyWish(config, AGAIN), undefined, guards);
  if (!proxy.ok) return fault(proxy.error);
  const words = await coordinatorLaunchWords(quiet, {
    home, config, proxyBaseUrl: proxy.value.baseUrl, resumeId: seen.value.sessionId, prompt: refreshText.continue,
  });
  if (!words.ok) return fault(words.error);
  // The hook state and pane can change while the launch checks run.
  const latest = await readOwnCoordinatorResume(quiet, home, node);
  if (!latest.ok) return fault(latest.error);
  if (latest.value.state !== 'valid' || latest.value.sessionId !== seen.value.sessionId) {
    return fault(failure('the coordinator session id changed before the stop').error);
  }
  if (!coordinatorIdle(latest.value.line, own.value)) return ok(null);
  const current = await readCoordinatorPane(quiet, node);
  if (!current.ok) return fault(current.error);
  if (!ownCoordinatorPane(current.value, request, pane.value.paneId) || current.value.dead || current.value.pid !== pane.value.pid) {
    return fault(failure('the coordinator pane changed before the stop').error);
  }
  const marked = await saved(quiet, request, { kind: 'acting', role: 'coordinator', id: node });
  if (!marked.ok) return marked;
  const stopped = await terminatePane(quiet, pane.value, commands.start);
  if (!stopped.ok) return fault(stopped.error);
  const dead = await readCoordinatorPane(quiet, node);
  if (!dead.ok) return fault(dead.error);
  if (!ownCoordinatorPane(dead.value, request, pane.value.paneId) || !dead.value.dead || dead.value.pid !== pane.value.pid) {
    return fault(failure('the dead pane read did not confirm the coordinator pane that received TERM').error);
  }
  const args = respawnPaneArgs(dead.value.paneId, coordinatorDir, words.value);
  if (!args.ok) return fault(failure(args.error).error);
  const launchedAt = quiet.now().getTime();
  const spawned = await tmuxStep(quiet, args.value);
  if (!spawned.ok) return fault(spawned.error);
  const confirmed = await confirmCoordinator(quiet, request, pane.value, launchedAt);
  return confirmed.ok ? ok(resumed('coordinator', node)) : fault(confirmed.error);
};

/** A refresh reports through its record only. The caller pane never supplies a target or veto. */
const quietDeps = (deps: Deps): Deps => ({ ...deps, env: { ...deps.env, [env.tmuxPane]: undefined }, warn: () => undefined });

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
        : ok(sessionFault('worker', id, fault, resumeRemedy(id)));
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
    const recorded = await saved(deps, request, { kind: 'outcome', outcome: idleFault('worker', id) });
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
  return saved(deps, request, { kind: 'outcome', outcome: idleFault('coordinator', node) });
};

const runClaimed = async (deps: Deps, request: RefreshRequest, run: RefreshRunRecord): Promise<CliResult<RefreshRunRecord>> => {
  const workerDeadline = run.deadlines.workerMs;
  if (workerDeadline === null) return failure('the worker refresh wait has no deadline', RESULT);
  const workers = await runWorkers(deps, request, workerDeadline, run.workerIds);
  if (!workers.ok) return workers;
  if (!workers.value.outcomes.some(({ status }) => status === 'trust-wait')) {
    const waiting = await saved(deps, request, { kind: 'wait-coordinator' });
    if (!waiting.ok) return waiting;
    const coordinatorDeadline = waiting.value.deadlines.coordinatorMs;
    if (coordinatorDeadline === null) return failure('the coordinator refresh wait has no deadline', RESULT);
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
