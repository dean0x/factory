import { join } from 'node:path';
import { z } from 'zod';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { slug } from '../config/primitives.js';
import type { Deps } from '../core/deps.js';
import { readPrivateText } from '../core/private-file.js';
import { processStartOf } from '../core/process-start.js';
import { ok } from '../core/result.js';
import { LINK_REMEDY, withFolderLock, writeInFolder, type FolderTarget } from '../core/safe-write.js';
import {
  commandText, commands, files, flags, maxFileBytes, privateFile, processStart, refreshRunPath, refreshWait, schemaIds, workerRecord,
} from '../names.js';
import { layoutOf } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import { resumeLine } from './launch.js';

const CLAIM_MS = refreshWait.claimChecks * refreshWait.claimIntervalMs;
const RUN_ID_BYTES = 8;
const FAULT_TEXT_LIMIT = 1024;
const hexOf = (bytes: number) => z.string().length(bytes * 2).regex(/^[0-9a-f]+$/);
const time = z.int().nonnegative();
const role = z.enum(['worker', 'coordinator']);
const faultFields = { warning: z.string().min(1).max(FAULT_TEXT_LIMIT), remedy: z.string().min(1).max(FAULT_TEXT_LIMIT) };
const faultSchema = z.strictObject(faultFields).readonly();
const outcomeFields = { role, id: slug };
const skippedWorkerSchema = z.strictObject({ role: z.literal('worker'), id: slug, status: z.literal('skipped'), ...faultFields });
const outcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...outcomeFields, status: z.literal('resumed') }),
  z.strictObject({ ...outcomeFields, status: z.enum(['fault', 'trust-wait']), ...faultFields }),
  skippedWorkerSchema,
]).readonly();

const recordSchema = z.strictObject({
  schema: z.literal(schemaIds.refreshRun),
  runId: hexOf(RUN_ID_BYTES),
  token: hexOf(refreshWait.tokenBytes),
  startedAtMs: time,
  caller: z.enum(['terminal', 'pane']),
  coordinatorPane: z.boolean(),
  state: z.enum(['scheduled', 'waiting', 'acting-coordinator', 'done', 'failed', 'cancelled']),
  runner: z.strictObject({ pid: z.int().positive(), startMs: time }).readonly().nullable(),
  deadlines: z.strictObject({ claimMs: time, workerMs: time.nullable(), coordinatorMs: time.nullable() }).readonly(),
  acting: slug.nullable(),
  actingRole: role.nullable(),
  workerIds: z.array(slug).max(workerRecord.maxEntries).readonly(),
  outcomes: z.array(outcomeSchema).max(workerRecord.maxEntries + 1).readonly(),
  fault: faultSchema.nullable(),
}).refine((record) => {
  const { acting, actingRole, caller, coordinatorPane, deadlines, runner, startedAtMs, state } = record;
  if (coordinatorPane && caller !== 'pane') return false;
  if ((acting === null) !== (actingRole === null)) return false;
  if (deadlines.claimMs !== startedAtMs + CLAIM_MS) return false;
  if ((runner === null) !== (deadlines.workerMs === null)) return false;
  if (deadlines.coordinatorMs !== null && deadlines.workerMs === null) return false;
  const planned = new Set(record.workerIds);
  if (planned.size !== record.workerIds.length) return false;
  for (const outcome of record.outcomes) {
    if (outcome.status !== 'skipped') continue;
    if (planned.has(outcome.id)) return false;
    planned.add(outcome.id);
  }
  if (planned.size > workerRecord.maxEntries) return false;
  if (state === 'scheduled') return runner === null && acting === null;
  if (state === 'waiting') return runner !== null && actingRole !== 'coordinator';
  if (state === 'acting-coordinator') return runner !== null && deadlines.coordinatorMs !== null && actingRole !== 'worker';
  return true;
}).readonly();

export type RefreshRunRecord = z.infer<typeof recordSchema>;
export type RefreshOutcome = z.infer<typeof outcomeSchema>;
export type RefreshFault = z.infer<typeof faultSchema>;

export interface RefreshCaller {
  readonly caller: RefreshRunRecord['caller'];
  readonly coordinatorPane: boolean;
}

export interface RefreshWorkerPlan {
  readonly workerIds: readonly string[];
  readonly skipped: readonly Extract<RefreshOutcome, { status: 'skipped' }>[];
}

export type RefreshRunChange =
  | { readonly kind: 'wait-coordinator' }
  | { readonly kind: 'acting'; readonly role: RefreshOutcome['role']; readonly id: string }
  | { readonly kind: 'clear-acting' }
  | { readonly kind: 'outcome'; readonly outcome: RefreshOutcome }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly fault: RefreshFault };

export const refreshResultCommand = commandText(`${commands.refresh} --${flags.result}`);
const CANCEL_COMMAND = commandText(`${commands.refresh} --${flags.cancel}`);
const RECORD_REMEDY = `Check ${files.refreshRun}. Replace or remove it only when no refresh runner is active.`;
const RESULT_REMEDY = `Run "${refreshResultCommand}" to see the last refresh run.`;

/** The same remedy applies to the result and status if an action has no outcome yet. */
export const refreshActingRemedy = ({ acting, actingRole }: RefreshRunRecord): string => {
  if (acting === null) return RESULT_REMEDY;
  const retry = actingRole === 'worker' ? resumeLine(acting) : commands.start;
  return `If the session stopped, run "${commandText(retry)}".`;
};

const RUN_LOCK = {
  suffix: privateFile.lockSuffix,
  mode: privateFile.fileMode,
  attempts: privateFile.lockAttempts,
  waitMs: privateFile.lockWaitMs,
  // A check of a runner can use the full process-start timeout under this lock.
  staleMs: privateFile.lockStaleMs + processStart.timeoutMs,
  takeoverSuffix: privateFile.takeoverSuffix,
} as const;

const recordTarget = (home: string): FolderTarget => {
  const { stateDir, runtimeDir } = layoutOf(home);
  return { parent: stateDir, folder: runtimeDir, name: files.refreshRun, mode: privateFile.fileMode, folderMode: privateFile.folderMode };
};

/** Check both folders before taking a lock or reading a file. Read-only calls never create a folder. */
const checkFolders = async (deps: Deps, { parent, folder }: FolderTarget): Promise<CliResult<void>> => {
  for (const path of [parent, folder]) {
    const info = await deps.fs.lstatInfo(path);
    if (!info.ok) return info;
    if (info.value === null) return ok(undefined);
    if (info.value.kind === 'link') return safetyRefusal(`the refresh record folder ${path} is a link`, LINK_REMEDY);
    if (info.value.kind !== 'dir') return failure(`the refresh record folder ${path} is not a folder`, RECORD_REMEDY);
    const { mode, uid } = info.value;
    if (deps.uid !== null && (uid !== deps.uid || (mode & privateFile.groupOtherWrite) !== 0)) {
      return safetyRefusal(`the refresh record folder ${path} is not writable by its owner alone`, RECORD_REMEDY);
    }
    if (deps.uid !== null && path === folder && mode !== privateFile.folderMode) {
      return safetyRefusal(`the refresh run-time folder ${path} does not have mode 700`, RECORD_REMEDY);
    }
  }
  return ok(undefined);
};

/** Read the node's private record. A file that exists but cannot be read is never treated as absent. */
export const readRefreshRun = async (deps: Deps, home: string): Promise<CliResult<RefreshRunRecord | null>> => {
  const folders = await checkFolders(deps, recordTarget(home));
  if (!folders.ok) return folders;
  const path = join(home, refreshRunPath);
  const info = await deps.fs.lstatInfo(path);
  if (!info.ok) return info;
  if (info.value === null) return ok(null);
  if (info.value.kind === 'link') return safetyRefusal(`the refresh run record ${path} is a link`, LINK_REMEDY);
  if (info.value.kind !== 'file') return failure(`the refresh run record ${path} is not a file`, RECORD_REMEDY);
  if (deps.uid !== null && info.value.mode !== privateFile.fileMode) {
    return safetyRefusal(`the refresh run record ${path} does not have mode 600`, RECORD_REMEDY);
  }
  const read = await readPrivateText(deps, path, maxFileBytes);
  if (!read.ok) return failure(`cannot read the refresh run record: ${read.error}`, RECORD_REMEDY);
  if (read.value === null) return failure('the refresh run record went away during the read', RECORD_REMEDY);
  const parsed = parseJsonText(read.value);
  if (!parsed.ok) return failure(`cannot read the refresh run record: ${parsed.error}`, RECORD_REMEDY);
  const record = recordSchema.safeParse(parsed.value);
  return record.success ? ok(record.data) : failure('the refresh run record has invalid fields', RECORD_REMEDY);
};

/** The claim deadline applies only before a runner claims the record. A live runner keeps its record even at an idle cap. */
export const refreshRunIsLive = async (deps: Deps, record: RefreshRunRecord): Promise<CliResult<boolean>> => {
  if (record.state === 'scheduled') return ok(deps.now().getTime() < record.deadlines.claimMs);
  if (record.runner === null || record.state === 'failed' || record.state === 'done') return ok(false);
  // A cancelled worker can finish the act already in progress, but can never start a new act.
  if (record.state === 'cancelled' && record.acting === null) return ok(false);
  const { pid, startMs } = record.runner;
  const running = deps.isRunning(pid);
  if (!running.ok) return failure('cannot check if the refresh runner is live', RESULT_REMEDY);
  if (!running.value) return ok(false);
  const observed = await processStartOf(deps, pid);
  return observed.ok ? ok(observed.value === startMs) : failure('cannot check the start of the refresh runner', RESULT_REMEDY);
};

type Change = (current: RefreshRunRecord | null) => Promise<CliResult<RefreshRunRecord>>;

/** Each mutation holds only the record lock. It releases that lock before the runner polls or acts. */
const changeRecord = async (deps: Deps, home: string, change: Change): Promise<CliResult<RefreshRunRecord>> => {
  const target = recordTarget(home);
  const folders = await checkFolders(deps, target);
  if (!folders.ok) return folders;
  return withFolderLock(deps, target, RUN_LOCK, async () => {
    const read = await readRefreshRun(deps, home);
    if (!read.ok) return read;
    const next = await change(read.value);
    if (!next.ok || next.value === read.value) return next;
    const record = recordSchema.safeParse(next.value);
    if (!record.success) return failure('cannot save the refresh run record: it has invalid fields', RESULT_REMEDY);
    const text = `${JSON.stringify(record.data)}\n`;
    if (Buffer.byteLength(text) > maxFileBytes) return failure('cannot save the refresh run record: it is too large', RESULT_REMEDY);
    const written = await writeInFolder(deps, { ...target, existingFolder: true }, text);
    return written.ok ? ok(record.data) : written;
  });
};

export const scheduleRefreshRun = async (
  deps: Deps, home: string, caller: RefreshCaller, workers: RefreshWorkerPlan = { workerIds: [], skipped: [] },
): Promise<CliResult<RefreshRunRecord>> =>
  changeRecord(deps, home, async (current) => {
    if (current !== null) {
      const live = await refreshRunIsLive(deps, current);
      if (!live.ok) return live;
      if (live.value) {
        return failure('a refresh run is already live', `Run "${refreshResultCommand}" to see it, or "${CANCEL_COMMAND}" to cancel it.`);
      }
    }
    const runId = deps.randomHex(RUN_ID_BYTES);
    if (!runId.ok) return runId;
    const token = deps.randomHex(refreshWait.tokenBytes);
    if (!token.ok) return token;
    const startedAtMs = deps.now().getTime();
    return ok({
      schema: schemaIds.refreshRun, runId: runId.value, token: token.value, startedAtMs, ...caller, state: 'scheduled', runner: null,
      deadlines: { claimMs: startedAtMs + CLAIM_MS, workerMs: null, coordinatorMs: null },
      acting: null, actingRole: null, workerIds: workers.workerIds, outcomes: workers.skipped, fault: null,
    });
  });

const refuseToken = (): CliResult<never> => safetyRefusal('the refresh runner does not own a live token', RESULT_REMEDY);

export const claimRefreshRun = async (deps: Deps, home: string, token: string): Promise<CliResult<RefreshRunRecord>> =>
  changeRecord(deps, home, async (current) => {
    if (current?.state !== 'scheduled' || current.token !== token) return refuseToken();
    const start = await processStartOf(deps, deps.pid);
    const now = deps.now().getTime();
    if (now >= current.deadlines.claimMs) return refuseToken();
    if (!start.ok) return failure('cannot read the start of the refresh runner', RESULT_REMEDY);
    return ok({
      ...current, state: 'waiting', runner: { pid: deps.pid, startMs: start.value },
      deadlines: { ...current.deadlines, workerMs: now + refreshWait.idleCapMs },
    });
  });

export const failUnclaimedRefreshRun = async (
  deps: Deps, home: string, token: string, fault: RefreshFault,
): Promise<CliResult<RefreshRunRecord>> => changeRecord(deps, home, async (current) => {
  if (current?.token !== token) return failure('the scheduled refresh run changed', RESULT_REMEDY);
  if (current.state !== 'scheduled') return ok(current);
  return ok({ ...current, state: 'failed', fault });
});

const runnerOwns = async (deps: Deps, record: RefreshRunRecord, token: string): Promise<boolean> => {
  if (record.token !== token || record.runner?.pid !== deps.pid) return false;
  const start = await processStartOf(deps, deps.pid);
  return start.ok && start.value === record.runner.startMs;
};

const isActive = ({ state }: RefreshRunRecord): boolean => state === 'waiting' || state === 'acting-coordinator';

/** Check the claimed token and process identity. Call before each act as well as in the locked write of its marker. */
export const readOwnRefreshRun = async (deps: Deps, home: string, token: string): Promise<CliResult<RefreshRunRecord>> => {
  const read = await readRefreshRun(deps, home);
  if (!read.ok) return read;
  const record = read.value;
  return record !== null && isActive(record) && await runnerOwns(deps, record, token) ? ok(record) : refuseToken();
};

const invalidChange = (): CliResult<never> => failure('the refresh record cannot make that change in its current state', RESULT_REMEDY);
const clearAction = (current: RefreshRunRecord): RefreshRunRecord => ({ ...current, acting: null, actingRole: null });

const addOutcome = (current: RefreshRunRecord, outcome: RefreshOutcome): CliResult<RefreshRunRecord> => {
  const same = (entry: RefreshOutcome) => entry.role === outcome.role && entry.id === outcome.id;
  if (current.acting !== null && (current.acting !== outcome.id || current.actingRole !== outcome.role)) return invalidChange();
  if (current.outcomes.some(same)) return invalidChange();
  return ok({ ...clearAction(current), outcomes: [...current.outcomes, outcome] });
};

const applyChange = (current: RefreshRunRecord, change: RefreshRunChange, now: number): CliResult<RefreshRunRecord> => {
  switch (change.kind) {
    case 'wait-coordinator':
      if (current.state !== 'waiting' || current.acting !== null) return invalidChange();
      if (current.deadlines.coordinatorMs !== null) return ok(current);
      return ok({ ...current, deadlines: { ...current.deadlines, coordinatorMs: now + refreshWait.idleCapMs } });
    case 'acting': {
      if (current.state !== 'waiting' || current.acting !== null) return invalidChange();
      const phase = current.deadlines.coordinatorMs === null ? 'worker' : 'coordinator';
      if (change.role !== phase || current.outcomes.some(({ id, role }) => id === change.id && role === change.role)) return invalidChange();
      return ok({ ...current, acting: change.id, actingRole: change.role, state: phase === 'worker' ? 'waiting' : 'acting-coordinator' });
    }
    case 'clear-acting':
      return current.acting === null ? ok(current) : ok(clearAction(current));
    case 'outcome':
      return addOutcome(current, change.outcome);
    case 'done':
      return current.acting === null ? ok({ ...current, state: 'done' }) : invalidChange();
    case 'failed':
      return ok({ ...current, state: 'failed', fault: change.fault });
  }
};

export const updateRefreshRun = async (
  deps: Deps, home: string, token: string, change: RefreshRunChange,
): Promise<CliResult<RefreshRunRecord>> => changeRecord(deps, home, async (current) => {
  if (current === null) return refuseToken();
  const settlesCancelledAct = current.state === 'cancelled' && current.acting !== null
    && (change.kind === 'clear-acting' || change.kind === 'outcome');
  if ((!isActive(current) && !settlesCancelledAct) || !await runnerOwns(deps, current, token)) return refuseToken();
  return applyChange(current, change, deps.now().getTime());
});

export const cancelRefreshRun = async (deps: Deps, home: string): Promise<CliResult<RefreshRunRecord>> =>
  changeRecord(deps, home, async (current) => {
    if (current?.state === 'scheduled' || current?.state === 'waiting') return ok({ ...current, state: 'cancelled' });
    if (current?.state === 'acting-coordinator') return failure('cannot cancel refresh after the coordinator act has started', RESULT_REMEDY);
    return failure('there is no unfinished refresh run to cancel', RESULT_REMEDY);
  });
