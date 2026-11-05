import type { CliError, CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commandText, lastSeen, roles } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { readOwnCoordinatorSession, readOwnLastSeen } from './last-seen.js';
import { resumeLine, resumeWorker, type ProxyAnswers } from './launch.js';
import { listWorkerRecords, type InvalidWorker, type WorkerRecord } from './registry.js';

/**
 * The recovery after the tmux server was killed (design 4.11, "After a machine restart"): `start` makes the session again, and
 * then the coordinator and each recorded worker run again with the session id that they had. A session id enters a command line
 * only when the pointer and the last-seen line pass the owner check, so a program in a pane can not name the session to resume.
 * A coordinator or a worker with no usable id never gets a guess: the coordinator starts a new conversation, and a worker is
 * skipped with a warning that names the command to start it by hand.
 */

const keys = lastSeen.keys;

/** What the coordinator resumes: the id of its newest session, or null for a new conversation, and the warning when it is not resumed for a reason. */
export interface CoordinatorResume {
  readonly resumeId: string | null;
  /** One warning, or null. No pointer is no warning: the coordinator never ran a session that recorded one. */
  readonly warning: string | null;
}

const coordinatorWarning = (home: string, reason: string): string =>
  `The earlier conversation of the ${roles.coordinator} is NOT resumed: ${reason} (${layoutOf(home).coordinatorLastSessionFile}). ` +
  'A new conversation starts.';

/**
 * The session that the coordinator resumes. The pointer in the run-time folder is a hint, so the id counts only when the line
 * that it names records the id of the node (`readOwnCoordinatorSession`). No pointer gives a new conversation with no warning.
 * A pointer that is not valid, a line that is not the line of the node, and a pointer that can not be read each give a new
 * conversation and one warning. This call never fails: a coordinator that can not resume still starts.
 */
export const coordinatorResumeOf = async (deps: Deps, home: string, nodeId: string): Promise<CoordinatorResume> => {
  const read = await readOwnCoordinatorSession(deps, home, nodeId);
  if (!read.ok) {
    return { resumeId: null, warning: coordinatorWarning(home, `the pointer can not be read: ${read.error.message}`) };
  }
  switch (read.value.state) {
    case 'valid':
      return { resumeId: read.value.sessionId, warning: null };
    case 'absent':
      return { resumeId: null, warning: null };
    case 'invalid':
    case 'not-owned':
      return { resumeId: null, warning: coordinatorWarning(home, read.value.reason) };
    default: {
      const unreachable: never = read.value;
      return unreachable;
    }
  }
};

export interface RecoveryRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  /** The proxy answers of the run. The caller makes them once, so each proxy is asked once for the whole run. */
  readonly proxyAnswers: ProxyAnswers;
}

/** The ids of the workers by what happened. A folder with no valid record is named by its folder name. */
export interface RecoveryReport {
  /** The workers whose pane runs and whose session wrote its line. */
  readonly resumed: readonly string[];
  /** The workers with no usable id, and the folders with no valid record. Nothing started for them. */
  readonly skipped: readonly string[];
  /** The workers whose launch failed or was not confirmed. A pane that the launch made stays. */
  readonly failed: readonly string[];
}

type Outcome = keyof RecoveryReport;

const skipWarning = (home: string, id: string, reason: string): string =>
  `The ${roles.worker} ${id} is NOT resumed: ${reason}. ` +
  `Its pointer file is ${workerPathsOf(home, id).lastSessionFile}. Run "${commandText(resumeLine(id))}" to start it again.`;

const failedWarning = (id: string, error: CliError): string =>
  `The ${roles.worker} ${id} did not start again: ${error.message}. ` +
  (error.hint ?? `Run "${commandText(resumeLine(id))}" to try again.`);

const invalidWarning = (folder: InvalidWorker): string =>
  `The folder ${folder.name} in the folder of the ${roles.worker}s has no valid record: ${folder.reason}. It is NOT resumed.`;

/** One worker: read its id strictly, then resume it. Every problem is a warning, so the run goes on. */
const recoverWorker = async (deps: Deps, request: RecoveryRequest, record: WorkerRecord): Promise<Outcome> => {
  const { home, config, proxyAnswers } = request;
  const { id } = record;
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) {
    deps.warn(skipWarning(home, id, `the last-seen line can not be read: ${seen.error.message}`));
    return 'skipped';
  }
  if (seen.value.state === 'unknown') {
    deps.warn(skipWarning(home, id, seen.value.reason));
    return 'skipped';
  }
  const launched = await resumeWorker(deps, {
    home,
    config,
    workerId: id,
    workCopy: record.workCopy,
    retry: resumeLine(id),
    resumeId: seen.value.line[keys.sessionId],
    proxyAnswers,
  });
  if (!launched.ok) {
    deps.warn(failedWarning(id, launched.error));
    return 'failed';
  }
  for (const warning of launched.value.warnings) deps.warn(warning);
  return 'resumed';
};

/**
 * Resume each recorded worker with the id of its newest session, one worker at a time. The caller has started the session just
 * now, so no pane of a worker runs, and it has made the checks of the root, the tools and the session. For each worker, in
 * order of the ids:
 * - the id comes from the pointer and the line of the worker (`readOwnLastSeen`): a pointer that is absent or not valid, a line
 *   of another session, a line with no session marker (an old hook) and a pointer that another worker shares are not owned.
 *   The worker is skipped with one warning that names the worker, its pointer file and the command that starts it. A new
 *   conversation is never started for a worker here;
 * - the launch checks the settings files of the work copy before the pane (`resumeWorker`), asks the proxy of the worker at most
 *   once for the run (`proxyAnswers`) and waits for the session to write its line. A launch that fails, or that is not confirmed,
 *   is one warning that names the worker. It is not tried again, and the run goes on. A pane that the launch made stays.
 * A folder with no valid record is skipped with a warning. The warnings are printed at once. The failure is a list of the workers
 * that can not be read (a workers folder that is a link is a security stop), and nothing has started then.
 */
export const recoverWorkers = async (deps: Deps, request: RecoveryRequest): Promise<CliResult<RecoveryReport>> => {
  const listed = await listWorkerRecords(deps, request.home);
  if (!listed.ok) return listed;
  const report: Record<Outcome, string[]> = { resumed: [], skipped: [], failed: [] };
  for (const record of listed.value.workers) {
    report[await recoverWorker(deps, request, record)].push(record.id);
  }
  for (const folder of listed.value.invalid) {
    deps.warn(invalidWarning(folder));
    report.skipped.push(folder.name);
  }
  return ok(report);
};
