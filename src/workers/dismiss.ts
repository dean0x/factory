import { isAbsolute, relative, resolve, sep } from 'node:path';
import { failure, safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import {
  fetchBranches,
  headOf,
  ignoredFilesOf,
  isAncestor,
  isWorkTreeRoot,
  remoteBranchHeadOf,
  removeWorkTree,
  stashCountOf,
  statusOf,
  type IgnoredList,
} from '../core/git.js';
import { err, ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import type { PaneRow } from '../launch/tmux.js';
import { commands, commandText, dirs, dismissWords, roles, workerListWords } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { removeLastSeen } from './last-seen.js';
import { branchOf, removeWorkerRecord, workCopyOf } from './registry.js';
import type { WorkerStatus } from './status.js';
import { stopWorker, type StopOutcome } from './stop.js';

/**
 * The checks and the steps of `dismiss` (design 4.11, "Dismiss"). A worker is freed in one order: the checks of the path, the state
 * of the session and the pushed test read and change nothing; then the pane ends, the work copy is removed with the plain git
 * command (never with force), and the last-seen line and the record are deleted together. The branch stays.
 */

/** What names a worker for the checks: the id and the project of its record. */
export interface DismissTarget {
  readonly id: string;
  readonly project: string;
}

/** A worker that passed the checks of the path: its work copy is a folder below `work-copies/`, and its clone is another folder. */
export interface DismissPlan extends DismissTarget {
  /** The primary clone of the project. It is never changed. */
  readonly clone: string;
  readonly workCopy: string;
  readonly branch: string;
}

/** The command that a person runs again, without the program name: `dismiss ID`, or the words that the caller gives. */
export const dismissLine = (id: string): string => `${commands.dismiss} ${id}`;

const runAgain = (again: string): string => `Run "${commandText(again)}" again.`;

/** True when `path` is `root` or lies below it. Both are real paths. */
const isInside = (root: string, path: string): boolean => {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
};

/**
 * The work copy must be a folder below the real folder `work-copies/`, at the depth `<project>/<id>`. The real paths are compared
 * with `path.relative`, so a link anywhere in the path that leads outside is a security stop (exit 4), whatever the link rule said
 * before.
 */
const requireBelowWorkCopies = async (deps: Deps, home: string, target: DismissTarget, workCopy: string): Promise<CliResult<string>> => {
  const copies = await deps.fs.realpath(layoutOf(home).workCopiesDir);
  if (!copies.ok) return copies;
  const real = await deps.fs.realpath(workCopy);
  if (!real.ok) return real;
  const rest = relative(copies.value, real.value);
  const parts = rest.split(sep);
  if (isAbsolute(rest) || parts.length !== 2 || parts[0] === '..' || parts[0] === '' || parts[1] !== target.id) {
    return safetyRefusal(
      `the work copy ${workCopy} of the ${roles.worker} ${target.id} is not a folder of ${dirs.workCopies}/<project>/${target.id}, so ${commands.dismiss} does not free it`,
      `Check the folder and the links in its path. ${runAgain(dismissLine(target.id))}`,
    );
  }
  return ok(real.value);
};

/**
 * The checks of the path, before anything is read from git or changed. The work copy must be the folder that the record rule gives,
 * with no link in its path (exit 4), a folder, and below the real folder of the work copies (exit 4). The project must be in the
 * config, and its clone must be a git work tree that is not inside the work copy (exit 4): the clone is never freed.
 */
export const planDismiss = async (deps: Deps, home: string, config: FactoryConfig, target: DismissTarget): Promise<CliResult<DismissPlan>> => {
  const { id, project: projectId } = target;
  const again = runAgain(dismissLine(id));
  const workCopy = workCopyOf(home, projectId, id);
  const linked = await requireNoLinks(deps, home, [workCopy]);
  if (!linked.ok) return linked;
  const kind = await deps.fs.lstat(workCopy);
  if (!kind.ok) return kind;
  if (kind.value !== 'dir') {
    return failure(`the work copy ${workCopy} of the ${roles.worker} ${id} is not a folder`, `Restore the folder. ${again}`);
  }
  const real = await requireBelowWorkCopies(deps, home, target, workCopy);
  if (!real.ok) return real;
  const project = config.recipe.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return failure(`the project ${projectId} of the ${roles.worker} ${id} is not in the config of this ${roles.node}`, `Add the project to the config. ${again}`);
  }
  const clone = resolve(home, project.path);
  const realClone = await deps.fs.realpath(clone);
  if (!realClone.ok || !(await isWorkTreeRoot(deps, clone))) {
    return failure(`the clone of the project ${projectId} (${clone}) is not a git work tree`, `Clone the repo of the project into that folder. ${again}`);
  }
  if (isInside(real.value, realClone.value)) {
    return safetyRefusal(
      `the clone ${clone} of the project ${projectId} lies inside the work copy of the ${roles.worker} ${id}, so ${commands.dismiss} does not free it`,
      `Check the path of the project in the config. ${again}`,
    );
  }
  return ok({ id, project: projectId, clone, workCopy, branch: branchOf(id) });
};

/** The reason that a worker may not end now, or ok. The caller gives the command that a person runs again. */
export const requireEndable = (entry: WorkerStatus, again: string): CliResult<void> => {
  const { id, workItem, running, state, pane } = entry;
  if (workItem.state === 'known' && workItem.item !== null) {
    return failure(
      `the ${roles.worker} ${id} has open work: ${workItem.item}`,
      `Finish the work item, or give it to another ${roles.worker}. ${runAgain(again)}`,
    );
  }
  if (!running) return ok(undefined);
  if (state === workerListWords.states.busy) {
    return failure(`the ${roles.worker} ${id} is busy: its session works now`, `Wait until it waits at its prompt. ${runAgain(again)}`);
  }
  if (state === workerListWords.states.unknown) {
    return failure(
      `cannot tell if the ${roles.worker} ${id} waits at its prompt or works`,
      `Look at the pane ${pane ?? ''}. When it waits at its prompt, run "${commandText(again)}" again after its next hook event.`,
    );
  }
  return ok(undefined);
};

/** One fetch of the worker branches of a clone: after it, the copies of the remote branches are the state of the remote now. */
export const fetchClone = (deps: Deps, clone: string): Promise<CliResult<void>> =>
  fetchBranches(deps, clone, dismissWords.remote, roles.worker);

const namedFiles = (paths: readonly string[]): string => {
  const shown = paths.slice(0, dismissWords.maxFilesNamed).join(', ');
  return paths.length > dismissWords.maxFilesNamed ? `${shown} and ${paths.length - dismissWords.maxFilesNamed} more` : shown;
};

/**
 * The reasons that the work of a worker is not pushed, or an empty list when it is. The caller fetched the clone first
 * (`fetchClone`). The work is pushed when the head of the branch is on the remote branch (the head is that commit or below it), and
 * the work copy has no changed file, no untracked file and no stash entry. A git command that fails is a failure, never a reason.
 */
export const unpushedReasons = async (deps: Deps, plan: DismissPlan): Promise<CliResult<readonly string[]>> => {
  const { clone, workCopy, branch } = plan;
  const remote = dismissWords.remote;
  const reasons: string[] = [];
  const head = await headOf(deps, workCopy);
  if (!head.ok) return head;
  const copy = await remoteBranchHeadOf(deps, clone, remote, branch);
  if (!copy.ok) return copy;
  if (head.value === null) reasons.push('the work copy has no commit');
  if (copy.value === null) {
    reasons.push(`the branch ${branch} is not on the remote ${remote}`);
  } else if (head.value !== null) {
    const below = await isAncestor(deps, workCopy, head.value, copy.value);
    if (!below.ok) return below;
    if (!below.value) reasons.push(`the branch ${branch} has commits that ${remote}/${branch} does not hold`);
  }
  const status = await statusOf(deps, workCopy);
  if (!status.ok) return status;
  if (status.value.length > 0) {
    const count = status.value.length;
    reasons.push(`the work copy has ${count} changed or untracked ${count === 1 ? 'file' : 'files'}: ${namedFiles(status.value.map((entry) => entry.path))}`);
  }
  const stash = await stashCountOf(deps, workCopy);
  if (!stash.ok) return stash;
  if (stash.value > 0) {
    reasons.push(`the stash of the repo holds ${stash.value} ${stash.value === 1 ? 'entry' : 'entries'}, and every work copy of the project shares it`);
  }
  return ok(reasons);
};

/** The files that git ignores in the work copy: the files that the removal deletes and that no commit holds. */
export const ignoredIn = (deps: Deps, plan: DismissPlan): Promise<CliResult<IgnoredList>> =>
  ignoredFilesOf(deps, plan.workCopy, dismissWords.maxIgnoredShown);

export interface FreeRequest {
  readonly home: string;
  /** The tmux session of the node: the id of the node. */
  readonly session: string;
  readonly plan: DismissPlan;
  /** The list of the panes of the session that the command read once, or null when no session runs. */
  readonly panes: readonly PaneRow[] | null;
  /** The session whose last-seen line this worker owns, or null when no line is known to be its own. */
  readonly lineSession: string | null;
}

export interface FreedWorker {
  readonly stopped: StopOutcome;
}

/** The same error with what was done before it, and a remedy line when it has none. */
const afterSteps = (error: CliError, id: string, done: readonly string[]): CliError => ({
  ...error,
  message: `${error.message}. ${done.length === 0 ? 'Nothing was freed' : `Done before this fault: ${done.join(', ')}`}`,
  hint: error.hint ?? runAgain(dismissLine(id)),
});

const stoppedStep = (stopped: StopOutcome): readonly string[] => {
  switch (stopped.kind) {
    case 'no-pane':
      return [];
    case 'closed-dead':
      return [`closed the ended pane ${stopped.paneIds.join(', ')}`];
    case 'stopped':
      return [`ended the pane ${stopped.paneId}`];
    default: {
      const unreachable: never = stopped;
      return unreachable;
    }
  }
};

/**
 * Frees a worker after every check passed. In order: the pane ends (`stopWorker`, which sends TERM and never KILL); the work copy
 * is removed with the plain git command, which refuses a changed or untracked file and has no force; the last-seen line and the
 * record folder are deleted together. The branch stays. A fault names what was done before it, and `dismiss` run again finishes
 * the steps that are left, except the removal of a work copy that is gone already.
 */
export const freeWorker = async (deps: Deps, request: FreeRequest): Promise<CliResult<FreedWorker>> => {
  const { home, session, plan, panes, lineSession } = request;
  const done: string[] = [];
  const stopped: CliResult<StopOutcome> =
    panes === null ? ok({ kind: 'no-pane' }) : await stopWorker(deps, { home, session, workerId: plan.id, panes });
  if (!stopped.ok) return err(afterSteps(stopped.error, plan.id, done));
  done.push(...stoppedStep(stopped.value));
  const removed = await removeWorkTree(deps, plan.clone, plan.workCopy);
  if (!removed.ok) return err(afterSteps(removed.error, plan.id, done));
  done.push(`removed the work copy ${plan.workCopy}`);
  if (lineSession !== null) {
    const line = await removeLastSeen(deps, home, lineSession);
    if (!line.ok) return err(afterSteps(line.error, plan.id, done));
  }
  const record = await removeWorkerRecord(deps, home, plan.id);
  if (!record.ok) return err(afterSteps(record.error, plan.id, done));
  return ok({ stopped: stopped.value });
};
