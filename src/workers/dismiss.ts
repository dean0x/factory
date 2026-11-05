import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { failure, safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import {
  commonDirOf,
  defaultBranchOf,
  fetchBranches,
  GIT_ENTRY,
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
import { shellWord } from '../core/shell-word.js';
import type { PaneRow } from '../launch/tmux.js';
import { commands, commandText, dirs, dismissStopCases, dismissWords, roles, workCopyGit, workerListWords } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
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
  /** The real path of the work copy, as the checks of the path proved it. Every read and the removal use this path. */
  readonly workCopy: string;
  /** The git folder that the clone keeps for the work copy. Every git read of the work copy takes the repo from this folder. */
  readonly gitDir: string;
  readonly branch: string;
  /** The default branch of the clone (`defaultBranchOf`), or null when the clone names none. */
  readonly defaultBranch: string | null;
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

/** The folder that the `gitdir:` line of the file `.git` names, as it is written, or null when the text has no such line. */
const linkedFolderOf = (text: string): string | null => {
  const [line = ''] = text.split('\n');
  if (!line.startsWith(workCopyGit.linkPrefix)) return null;
  const folder = line.slice(workCopyGit.linkPrefix.length).trim();
  return folder === '' ? null : folder;
};

/**
 * The git folder that the clone keeps for the work copy: a folder directly below `<git folder of the clone>/worktrees/`. The file
 * `.git` of the work copy must be a plain file, and its `gitdir:` line must name such a folder, and that folder must name the file
 * `.git` of this work copy back. Git takes the repo of a work copy from the folder that the file names, and a worker can write the
 * file, so every other link is a stop (exit 4), and no git command runs in the work copy. `workCopy` is the real path.
 */
const requireOwnGitDir = async (deps: Deps, target: DismissTarget, clone: string, workCopy: string): Promise<CliResult<string>> => {
  const refused = (): CliResult<never> =>
    safetyRefusal(
      `the file ${GIT_ENTRY} of the work copy ${workCopy} of the ${roles.worker} ${target.id} does not name the folder that the clone ${clone} keeps for it, so ${commands.dismiss} runs no git command there`,
      `Check the file ${GIT_ENTRY} in the work copy. ${runAgain(dismissLine(target.id))}`,
    );
  const entry = join(workCopy, GIT_ENTRY);
  const kind = await deps.fs.lstat(entry);
  if (!kind.ok) return kind;
  if (kind.value !== 'file') return refused();
  const text = await deps.fs.readTextLimited(entry, workCopyGit.maxBytes);
  const named = text.ok ? linkedFolderOf(text.value) : null;
  if (named === null) return refused();
  const common = await commonDirOf(deps, clone);
  if (common === null) {
    return failure(`cannot find the git folder of the clone ${clone} of the project ${target.project}`, `Check the clone. ${runAgain(dismissLine(target.id))}`);
  }
  const realCommon = await deps.fs.realpath(common);
  if (!realCommon.ok) return realCommon;
  const admin = await deps.fs.realpath(resolve(workCopy, named));
  if (!admin.ok || dirname(admin.value) !== join(realCommon.value, workCopyGit.adminFolder)) return refused();
  const back = await deps.fs.readTextLimited(join(admin.value, workCopyGit.backPointer), workCopyGit.maxBytes);
  if (!back.ok) return refused();
  const pointed = await deps.fs.realpath(resolve(admin.value, back.value.trim()));
  return pointed.ok && pointed.value === entry ? ok(admin.value) : refused();
};

/**
 * The checks of the path, before anything is read from git or changed. The work copy must be the folder that the record rule gives,
 * with no link in its path (exit 4), a folder, and below the real folder of the work copies (exit 4). The project must be in the
 * config, and its clone must be a git work tree that is not inside the work copy (exit 4): the clone is never freed. The file `.git`
 * of the work copy must name the git folder that the clone keeps for it (exit 4).
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
  const gitDir = await requireOwnGitDir(deps, target, clone, real.value);
  if (!gitDir.ok) return gitDir;
  return ok({
    id,
    project: projectId,
    clone,
    workCopy: real.value,
    gitDir: gitDir.value,
    branch: branchOf(id),
    defaultBranch: await defaultBranchOf(deps, clone),
  });
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

/**
 * One fetch of a clone, for the worker branches and for the default branch of the clone: after it, the copies of these remote
 * branches are the state of the remote now.
 */
export const fetchClone = (deps: Deps, plan: DismissPlan): Promise<CliResult<void>> =>
  fetchBranches(deps, plan.clone, dismissWords.remote, roles.worker, plan.defaultBranch === null ? [] : [plan.defaultBranch]);

const namedFiles = (paths: readonly string[]): string => {
  const shown = paths.slice(0, dismissWords.maxFilesNamed).join(', ');
  return paths.length > dismissWords.maxFilesNamed ? `${shown} and ${paths.length - dismissWords.maxFilesNamed} more` : shown;
};

/**
 * True when the commit `head` is the commit of the remote copy `copy` or lies below it. A missing copy holds no commit. The clone
 * answers, because every work copy of a repo shares its commits.
 */
const isBelowCopy = async (deps: Deps, clone: string, head: string, copy: string | null): Promise<CliResult<boolean>> =>
  copy === null ? ok(false) : isAncestor(deps, clone, head, copy);

/**
 * The reason that the commits of the branch are not on the remote, or null when they are. The head must be on the remote copy of
 * the branch of the worker, or on the remote copy of the default branch of the clone: a new worker with no commit of its own has a
 * head on the default branch, so it holds nothing that the remote lacks. The default branch is read only when the own branch fails.
 */
const missingCommits = async (deps: Deps, plan: DismissPlan, head: string): Promise<CliResult<string | null>> => {
  const { clone, branch, defaultBranch } = plan;
  const remote = dismissWords.remote;
  const own = await remoteBranchHeadOf(deps, clone, remote, branch);
  if (!own.ok) return own;
  const onOwn = await isBelowCopy(deps, clone, head, own.value);
  if (!onOwn.ok) return onOwn;
  if (onOwn.value) return ok(null);
  const main = defaultBranch === null ? ok(null) : await remoteBranchHeadOf(deps, clone, remote, defaultBranch);
  if (!main.ok) return main;
  const onMain = await isBelowCopy(deps, clone, head, main.value);
  if (!onMain.ok) return onMain;
  if (onMain.value) return ok(null);
  if (own.value === null) {
    const also = defaultBranch === null ? '' : `, and its head is not on ${remote}/${defaultBranch}`;
    return ok(`the branch ${branch} is not on the remote ${remote}${also}`);
  }
  const also = defaultBranch === null ? '' : `, and ${remote}/${defaultBranch} does not hold them either`;
  return ok(`the branch ${branch} has commits that ${remote}/${branch} does not hold${also}`);
};

/**
 * The reasons that the work of a worker is not pushed, or an empty list when it is. The caller fetched the clone first
 * (`fetchClone`). The work is pushed when the head of the branch is on the remote branch of the worker or on the default branch of
 * the clone (the head is that commit or below it), and the work copy has no changed file, no untracked file and no stash entry. A git
 * command that fails is a failure, never a reason.
 */
export const unpushedReasons = async (deps: Deps, plan: DismissPlan): Promise<CliResult<readonly string[]>> => {
  const { workCopy, gitDir } = plan;
  const reasons: string[] = [];
  const head = await headOf(deps, workCopy, gitDir);
  if (!head.ok) return head;
  if (head.value === null) {
    reasons.push('the work copy has no commit');
  } else {
    const missing = await missingCommits(deps, plan, head.value);
    if (!missing.ok) return missing;
    if (missing.value !== null) reasons.push(missing.value);
  }
  const status = await statusOf(deps, workCopy, gitDir);
  if (!status.ok) return status;
  if (status.value.length > 0) {
    const count = status.value.length;
    reasons.push(`the work copy has ${count} changed or untracked ${count === 1 ? 'file' : 'files'}: ${namedFiles(status.value.map((entry) => entry.path))}`);
  }
  const stash = await stashCountOf(deps, plan.clone);
  if (!stash.ok) return stash;
  if (stash.value > 0) {
    reasons.push(`the stash of the repo holds ${stash.value} ${stash.value === 1 ? 'entry' : 'entries'}, and every work copy of the project shares it`);
  }
  return ok(reasons);
};

/** The files that git ignores in the work copy: the files that the removal deletes and that no commit holds. */
export const ignoredIn = (deps: Deps, plan: DismissPlan): Promise<CliResult<IgnoredList>> =>
  ignoredFilesOf(deps, plan.workCopy, dismissWords.maxIgnoredShown, plan.gitDir);

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

/**
 * The same error with what was done before it. Before the removal of the work copy, `dismiss` run again does the steps that are
 * left, so that is the remedy when the error has none. After the removal, `dismiss` can not run for the worker again, because its
 * checks need the work copy: the remedy names the paths that are left, to delete by hand, after the remedy of the error.
 */
const afterSteps = (error: CliError, id: string, done: readonly string[], leftByHand: readonly string[] = []): CliError => {
  const message = `${error.message}. ${done.length === 0 ? 'Nothing was freed' : `Done before this fault: ${done.join(', ')}`}`;
  if (leftByHand.length === 0) return { ...error, message, hint: error.hint ?? runAgain(dismissLine(id)) };
  const byHand =
    `The work copy is gone, so "${commandText(dismissLine(id))}" does not run again for this ${roles.worker}. ` +
    `Delete ${leftByHand.map(shellWord).join(' and ')} by hand.`;
  return { ...error, message, hint: error.hint === undefined ? byHand : `${error.hint} ${byHand}` };
};

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
 * Frees a worker after every check passed. In order: the pane ends (`stopWorker`, which sends TERM and never KILL, and refuses a
 * session that works now, also when it turned busy after the checks read its state); the work copy
 * is removed with the plain git command, which refuses a changed or untracked file and has no force; the last-seen line and the
 * record folder are deleted together. The branch stays. A fault names what was done before it. Up to the removal of the work
 * copy, `dismiss` run again does the steps that are left. A fault after it names the paths to delete by hand (`afterSteps`).
 */
export const freeWorker = async (deps: Deps, request: FreeRequest): Promise<CliResult<FreedWorker>> => {
  const { home, session, plan, panes, lineSession } = request;
  const done: string[] = [];
  const stopped: CliResult<StopOutcome> =
    panes === null
      ? ok({ kind: 'no-pane' })
      : await stopWorker(deps, { home, session, workerId: plan.id, panes, allowed: dismissStopCases, again: dismissLine(plan.id) });
  if (!stopped.ok) return err(afterSteps(stopped.error, plan.id, done));
  done.push(...stoppedStep(stopped.value));
  const removed = await removeWorkTree(deps, plan.clone, plan.workCopy);
  if (!removed.ok) return err(afterSteps(removed.error, plan.id, done));
  done.push(`removed the work copy ${plan.workCopy}`);
  const recordDir = workerPathsOf(home, plan.id).dir;
  if (lineSession !== null) {
    const line = await removeLastSeen(deps, home, lineSession);
    if (!line.ok) return err(afterSteps(line.error, plan.id, done, [join(layoutOf(home).heartbeatDir, lineSession), recordDir]));
    done.push('deleted the last-seen line');
  }
  const record = await removeWorkerRecord(deps, home, plan.id);
  if (!record.ok) return err(afterSteps(record.error, plan.id, done, [recordDir]));
  return ok({ stopped: stopped.value });
};
