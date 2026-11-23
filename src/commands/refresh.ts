import { exitCodeFor, failure, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import { ensureHookSettings, ownDenyRulesOf } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { ADD_DIR_FLAG } from '../launch/argv.js';
import { runnerWindowArgs, runnerWindowExitArgs, type PaneRow } from '../launch/tmux.js';
import { tmuxStep } from '../launch/tmux-run.js';
import {
  commandLines, commands, commandText, env, flags, flagText, hookSessions, program, refreshText, refreshWait, workerRecord,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { hasOwnerPrefix } from '../safety/owner-prefix.js';
import { layoutOf } from '../state/layout.js';
import { promptStateOf, readOwnCoordinatorResume, readOwnLastSeen, readWorkerLastSeen, type LastSeen } from '../workers/last-seen.js';
import { runsInside, workersWithPanes } from '../workers/lifecycle.js';
import { readPanes, requireCoordinatorPane } from '../workers/panes.js';
import {
  cancelRefreshRun, failUnclaimedRefreshRun, readRefreshRun, refreshActingRemedy, refreshResultCommand, refreshRunIsLive, scheduleRefreshRun,
  type RefreshCaller, type RefreshFault, type RefreshRunRecord, type RefreshWorkerPlan,
} from '../workers/refresh-record.js';
import { refreshExitCode, runRefresh, type RefreshTarget } from '../workers/refresh-run.js';
import { readWorkerRecord } from '../workers/registry.js';
import { requireOwnHooks } from '../workers/session-checks.js';
import { readWorkerPanes } from '../workers/slot.js';
import { requireOneLivePane } from '../workers/stop.js';
import { prepareRoot } from './launch-checks.js';
import { coordinatorLaunchWords, renderStartFiles } from './start.js';

const REFRESH = commandText(commands.refresh);
const CANCEL = commandText(`${commands.refresh} ${flagText(flags.cancel)}`);
const SHOW_RESULT = `Run "${refreshResultCommand}" to see the last refresh run.`;
const RETRY = `Run "${REFRESH}" again.`;
const SKIP_REMEDY = `Check its pane. ${RETRY}`;
const UPGRADE = `Run "${commandText(commands.upgrade)}" to check the coordinator hook settings. Then run "${REFRESH}" again.`;
const END_WARNING = 'The background tasks, crons and watches of each restarted session end.';
const CLAIM_FAULT = 'the refresh runner did not claim its token in time';
const SCHEMA = `${program}.${commands.refresh}/v1`;

export interface RefreshOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
  readonly result: boolean;
  readonly cancel: boolean;
  readonly runner: string | undefined;
}

interface PlanRow {
  readonly id: string;
  readonly role: 'worker' | 'coordinator';
  readonly pane: string;
  readonly state: 'idle' | 'busy' | 'waits' | 'unknown';
  readonly resume: 'owned' | 'not owned' | 'missing';
  readonly skip?: RefreshFault;
}

interface RefreshPlan extends RefreshCaller {
  readonly rows: readonly PlanRow[];
  readonly folderQuestions: number;
}

const workerPlanOf = (rows: readonly PlanRow[]): RefreshWorkerPlan => {
  const workerIds: string[] = [];
  const skipped: RefreshWorkerPlan['skipped'][number][] = [];
  for (const { id, role, skip } of rows) {
    if (role !== 'worker') continue;
    if (skip === undefined) workerIds.push(id);
    else skipped.push({ role, id, status: 'skipped', ...skip });
  }
  return { workerIds, skipped };
};

const skipNotice = ({ warning, remedy }: RefreshFault): string => `${warning} ${remedy}`;
const text = (line: string): OutLine => ({ level: 'text', text: line });
const output = (lines: readonly OutLine[], fields: Readonly<Record<string, unknown>>, exitCode = 0, warnings: readonly string[] = []): CommandOutput =>
  ({ lines, json: { ...fields, schema: SCHEMA }, warnings, failed: exitCode !== 0, exitCode });

const checkContinue = ({ core: { owner } }: FactoryConfig): CliResult<void> =>
  hasOwnerPrefix(refreshText.continue, owner.prefix, owner.display)
    ? safetyRefusal('the refresh continue text contains the owner prefix',
      `Set a distinct owner prefix. Run "${commandText(commandLines.guardConfirm)}", then "${REFRESH}".`)
    : ok(undefined);

const stateOf = (line: LastSeen): PlanRow['state'] => {
  const state = promptStateOf(line);
  return state === 'prompt' ? 'idle' : state ?? 'unknown';
};

const checkWorker = async (
  deps: Deps, { home, config }: RefreshTarget, panes: readonly PaneRow[], id: string,
): Promise<CliResult<PlanRow | null>> => {
  const bound = await readWorkerPanes(deps, { home, session: config.core.node.id, workerId: id, again: commands.refresh, panes });
  if (!bound.ok) {
    return exitCodeFor(bound.error) === 4 ? bound : usageError(bound.error.message, bound.error.hint ?? RETRY);
  }
  const live = requireOneLivePane(id, bound.value.live, commands.refresh);
  if (!live.ok || live.value === null) return live.ok ? ok(null) : live;
  const row = { id, role: 'worker', pane: live.value.paneId } as const;
  const record = await readWorkerRecord(deps, home, id);
  if (!record.ok) return record;
  if (record.value.state === 'absent') {
    return ok({ ...row, state: 'unknown', resume: 'missing', skip: { warning: `The worker ${id} has no record.`, remedy: SKIP_REMEDY } });
  }
  if (record.value.state === 'invalid') {
    const message = `the record of the worker ${id} is not valid: ${record.value.reason}`;
    const remedy = `Check the worker record. ${RETRY}`;
    return record.value.mismatch === true ? safetyRefusal(message, remedy) : usageError(message, remedy);
  }
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return seen;
  if (seen.value.state === 'valid') return ok({ ...row, state: stateOf(seen.value.line), resume: 'owned' });
  const reported = await readWorkerLastSeen(deps, home, id);
  if (!reported.ok) return reported;
  return ok({
    ...row, state: reported.value.state === 'valid' ? stateOf(reported.value.line) : 'unknown',
    resume: seen.value.why === 'not-owned' ? 'not owned' : 'missing',
    skip: { warning: `The worker ${id} has no owned session id: ${seen.value.reason}.`, remedy: SKIP_REMEDY },
  });
};

/** Inspect the settings change without a question or a write. The renderer can otherwise skip an idle-only write. */
const checkHookWrite = async (deps: Deps, { home, config }: RefreshTarget): Promise<CliResult<void>> => {
  if (deps.stdinIsTTY && deps.stdoutIsTTY) return ok(undefined);
  const folder = layoutOf(home).coordinatorDir;
  const deny = await ownDenyRulesOf(deps, home, folder);
  if (!deny.ok) return deny;
  const planned = await ensureHookSettings(deps, {
    folder, home, session: hookSessions.coordinator, command: commands.refresh, yes: false, dryRun: true,
    idleCompaction: config.core.session.idle_compaction, deny: { rules: deny.value.rules, add: false },
  });
  if (!planned.ok) return planned;
  return planned.value.kind === 'would-write'
    ? usageError('the coordinator hook settings need a write, but no terminal can ask', `Run "${REFRESH}" in a terminal window and answer the question.`)
    : ok(undefined);
};

/** Read the same facts in the same order for both forms. No change or question belongs here. */
const checkSession = async (deps: Deps, target: RefreshTarget): Promise<CliResult<RefreshPlan | null>> => {
  const { home, config } = target;
  const node = config.core.node.id;
  const listed = await readPanes(deps, node, home, REFRESH);
  if (!listed.ok) return listed;
  if (listed.value === null) return ok(null);
  const panes = listed.value;
  const ids = workersWithPanes(panes.filter(({ dead }) => !dead));
  if (ids.length > workerRecord.maxEntries) return usageError('too many live workers in this tmux session', RETRY);
  const rows: PlanRow[] = [];
  for (const id of ids) {
    const checked = await checkWorker(deps, target, panes, id);
    if (!checked.ok) return checked;
    if (checked.value !== null) rows.push(checked.value);
  }
  const seen = await readOwnCoordinatorResume(deps, home, node);
  if (!seen.ok) return seen;
  if (seen.value.state !== 'valid') {
    const reason = seen.value.state === 'absent' ? 'the pointer is absent' : seen.value.reason;
    return notReady(`no owned coordinator session id: ${reason}`, `Check the coordinator pane. Wait for its next hook event. ${RETRY}`);
  }
  const pane = await requireCoordinatorPane(deps, home, config, commands.refresh);
  if (!pane.ok) return safetyRefusal(pane.error.message, pane.error.hint ?? RETRY);
  const hooks = await requireOwnHooks(deps, { home, folder: layoutOf(home).coordinatorDir, then: commands.refresh });
  if (!hooks.ok) return safetyRefusal(hooks.error.message, hooks.error.hint ?? UPGRADE);
  const prompt = checkContinue(config);
  if (!prompt.ok) return prompt;
  const record = await readRefreshRun(deps, home);
  if (!record.ok) return record;
  if (record.value !== null) {
    const live = await refreshRunIsLive(deps, record.value);
    if (!live.ok) return live;
    if (live.value) return failure('a refresh run is already live', `Run "${refreshResultCommand}" to see it, or "${CANCEL}" to cancel it.`);
  }
  const consent = await checkHookWrite(deps, target);
  if (!consent.ok) return consent;
  const caller = runsInside(deps, panes) ? 'pane' : 'terminal';
  const coordinatorPane = caller === 'pane' && deps.env[env.tmuxPane] === pane.value.paneId;
  if (caller === 'pane' && deps.programArgv.length !== 2) {
    return failure('factory cannot find its program for the refresh runner window', `Run "${REFRESH}" from outside the tmux session.`);
  }
  const launch = await coordinatorLaunchWords(deps, {
    home, config, proxyBaseUrl: null, resumeId: seen.value.sessionId, prompt: refreshText.continue,
  });
  if (!launch.ok) return launch;
  // Each launch can ask about its cwd. The coordinator can also ask about each of its project folders.
  const folderQuestions = 1 + launch.value.filter((word) => word === ADD_DIR_FLAG).length +
    2 * rows.filter(({ skip }) => skip === undefined).length;
  rows.push({ role: 'coordinator', id: node, pane: pane.value.paneId, state: stateOf(seen.value.line), resume: 'owned' });
  return ok({ caller, coordinatorPane, rows, folderQuestions });
};

/** Collect launch notices as data. This check does not write, ask a question or act on a pane. */
const checkPlan = async (deps: Deps, home: string, registry: RecipeRegistry) => {
  const warnings: string[] = [];
  const prepared = await prepareRoot({ ...deps, warn: (note) => warnings.push(note) }, home, registry);
  if (!prepared.ok) return prepared;
  const { config, notes } = prepared.value;
  const target = { home, config };
  const plan = await checkSession(prepared.value.deps, target);
  if (!plan.ok) return plan;
  const skips = plan.value?.rows.flatMap(({ skip }) => skip === undefined ? [] : [skipNotice(skip)]) ?? [];
  return ok({ prepared: prepared.value, target, plan: plan.value, notices: [...warnings, ...notes, ...skips] });
};

const dryOutput = (plan: RefreshPlan, warnings: readonly string[]): CommandOutput => {
  const { caller, coordinatorPane, rows, folderQuestions } = plan;
  const publicRows = rows.map(({ skip, ...row }) => skip === undefined ? row : { ...row, skip: skipNotice(skip) });
  let order = 0;
  return output([
    text('Dry run: no file changes and no session restarts.'),
    text(`Caller: ${caller}${coordinatorPane ? ' (coordinator)' : ''}`),
    text(`Idle wait: ${refreshWait.idleCapMs / 60_000} min per phase; check every ${refreshWait.intervalMs / 1000} s.`),
    text(`Runner claim wait: ${refreshWait.claimChecks * refreshWait.claimIntervalMs / 1000} s.`),
    text(`Folder questions: up to ${folderQuestions}.`),
    ...rows.map(({ role, id, pane, state, resume, skip }) => {
      const position = skip === undefined ? `${++order}. ` : '';
      return text(`${position}${role} ${id}: pane ${pane}; ${state}; resume id ${resume}${skip === undefined ? '' : '; skip'}`);
    }),
    { level: 'warn', text: END_WARNING },
  ], { dryRun: true, ...plan, rows: publicRows, idleCapMs: refreshWait.idleCapMs, pollMs: refreshWait.intervalMs, warnings: [END_WARNING, ...warnings] }, 0, warnings);
};

/** Project public fields. The record itself must never go to the output renderer. */
const resultOutput = (record: RefreshRunRecord, missedClaim: boolean, warnings: readonly string[] = []): CommandOutput => {
  const { runId, caller, acting, actingRole, token } = record;
  const state = missedClaim ? 'failed' : record.state;
  const clean = (line: string) => displayLine(line.replaceAll(token, '[private]'), 1024);
  const cleanFault = (fault: { readonly warning: string; readonly remedy: string }) => ({ warning: clean(fault.warning), remedy: clean(fault.remedy) });
  const fault = missedClaim ? { warning: CLAIM_FAULT, remedy: RETRY } : record.fault === null ? null : cleanFault(record.fault);
  const outcomes = record.outcomes.map((entry) => entry.status === 'resumed' ? entry : { ...entry, ...cleanFault(entry) });
  const lines: OutLine[] = [text(`Refresh ${runId}: ${state}`)];
  for (const outcome of outcomes) {
    lines.push(outcome.status === 'resumed' ? text(`${outcome.role} ${outcome.id}: resumed`)
      : text(`${outcome.role} ${outcome.id}: ${outcome.warning} ${outcome.remedy}`));
  }
  if (fault !== null) lines.push(text(`${fault.warning}. ${fault.remedy}`));
  if (acting !== null) lines.push(text(`acting: ${actingRole} ${acting}. ${refreshActingRemedy(record)}`));
  return output(lines, { runId, caller, state, acting, actingRole, outcomes, fault, warnings }, refreshExitCode(record), warnings);
};

/** Use the same absolute program words as the board pane. Do not repeat tmux diagnostics that can contain the token. */
const startRunner = async (deps: Deps, { home, config }: RefreshTarget, run: RefreshRunRecord): Promise<CliResult<CommandOutput>> => {
  const args = runnerWindowArgs({
    id: config.core.node.id, cwd: home, path: deps.env[env.path] ?? '',
    command: [...deps.programArgv, commands.refresh, flagText(flags.runner), run.token, flagText(flags.home), home],
  });
  if (!args.ok) return failure('cannot build the refresh runner window command', SHOW_RESULT);
  const window = await tmuxStep(deps, args.value);
  if (!window.ok) return failure('cannot start the refresh runner window', SHOW_RESULT);
  const exit = runnerWindowExitArgs(window.value.trim());
  if (!exit.ok || !(await tmuxStep(deps, exit.value)).ok) return failure('cannot set the exit option of the refresh runner window', SHOW_RESULT);
  const acknowledged = () => ok(output(
    [text(`SCHEDULED: ${run.runId}. ${SHOW_RESULT}`)], { runId: run.runId, state: 'scheduled', warnings: [END_WARNING] },
  ));
  for (let check = 0; check <= refreshWait.claimChecks; check += 1) {
    const read = await readRefreshRun(deps, home);
    if (!read.ok) return read;
    if (read.value?.runId !== run.runId || read.value.token !== run.token || read.value.state === 'cancelled') {
      return failure(CLAIM_FAULT, SHOW_RESULT);
    }
    if (read.value.runner !== null) return acknowledged();
    const left = run.deadlines.claimMs - deps.now().getTime();
    if (check === refreshWait.claimChecks || left <= 0) break;
    await deps.sleep(Math.min(left, refreshWait.claimIntervalMs));
  }
  const failed = await failUnclaimedRefreshRun(deps, home, run.token, { warning: CLAIM_FAULT, remedy: RETRY });
  if (!failed.ok) return failed;
  if (failed.value.runner !== null && failed.value.state !== 'cancelled') return acknowledged();
  return failure(CLAIM_FAULT, SHOW_RESULT);
};

const runDetached = async (deps: Deps, home: string, token: string, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const read = await readRefreshRun(deps, home);
  if (!read.ok) return read;
  if (read.value?.state !== 'scheduled' || read.value.token !== token || deps.now().getTime() >= read.value.deadlines.claimMs) {
    return safetyRefusal('the refresh runner does not own a live token', SHOW_RESULT);
  }
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const prompt = checkContinue(loaded.value);
  if (!prompt.ok) return prompt;
  const ran = await runRefresh(deps, { home, config: loaded.value, token });
  return ran.ok ? ok(output([], {})) : ran;
};

export const runRefreshCommand = async (base: Deps, options: RefreshOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const modes = [options.dryRun, options.result, options.cancel, options.runner !== undefined];
  if (modes.filter(Boolean).length > 1) return usageError('refresh takes only one form at a time', `Run "${REFRESH} --help".`);
  const located = await locateHomeFolder(base, options.home, (deps, home) => readNodeIdentity(deps, home, registry), commands.refresh);
  if (!located.ok) return located;
  const { home } = located.value;
  if (options.runner !== undefined) return runDetached(base, home, options.runner, registry);
  if (options.cancel) {
    const cancelled = await cancelRefreshRun(base, home);
    return cancelled.ok ? ok(output([text(`Refresh ${cancelled.value.runId}: cancelled`)], { runId: cancelled.value.runId, state: 'cancelled' })) : cancelled;
  }
  if (options.result) {
    const read = await readRefreshRun(base, home);
    if (!read.ok) return read;
    if (read.value === null) return ok(output([text('There is no refresh run record.')], { state: 'absent' }));
    const missedClaim = read.value.state === 'scheduled' && base.now().getTime() >= read.value.deadlines.claimMs;
    return ok(resultOutput(read.value, missedClaim));
  }
  const checked = await checkPlan(base, home, registry);
  if (!checked.ok) return checked;
  const { plan, target, prepared: { config, deps, guards, launchNotes }, notices } = checked.value;
  if (plan === null) return ok(output([text(`The tmux session ${config.core.node.id} does not exist; nothing runs.`)], { state: 'absent' }));
  if (options.dryRun) return ok(dryOutput(plan, [...notices, ...launchNotes]));
  const actingDeps = { ...deps, warn: base.warn };
  const rendered = await renderStartFiles(actingDeps, home, config, commands.refresh, guards);
  if (!rendered.ok) return rendered;
  for (const note of [END_WARNING, ...notices]) base.warn(note);
  const scheduled = await scheduleRefreshRun(
    actingDeps, home, { caller: plan.caller, coordinatorPane: plan.coordinatorPane }, workerPlanOf(plan.rows),
  );
  if (!scheduled.ok) return scheduled;
  if (plan.caller === 'pane') return startRunner(actingDeps, target, scheduled.value);
  const ran = await runRefresh(actingDeps, { ...target, token: scheduled.value.token });
  return ran.ok ? ok(resultOutput(ran.value, false)) : ran;
};
