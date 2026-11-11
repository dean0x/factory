import { join, relative, resolve } from 'node:path';
import { boardWorkItems } from '../board/work-items.js';
import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import { durationMinutes, isSlug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import {
  declinedHookText,
  ensureHookSettings,
  requireHookConsent,
  type HookConsentRequest,
} from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { addWorkTree, branchExists, isWorkTreeRoot } from '../core/git.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { writeInFolder } from '../core/safe-write.js';
import { shellWord } from '../core/shell-word.js';
import {
  commandLines,
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  hookSessions,
  lastSeen,
  places,
  program,
  roles,
  schemaIds,
  summonLimits,
  tmuxNames,
  workerCommands,
  workerRecord,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { dismissLine } from '../workers/dismiss.js';
import { readAssignment } from '../workers/assignment.js';
import { ensureCloneExclude } from '../workers/exclude.js';
import { launchWorker, requireCleanTrackedSettings, resumeLine, resumeWorker } from '../workers/launch.js';
import { gatherMachine, machineWarnings } from '../workers/machine.js';
import { readOwnLastSeen } from '../workers/last-seen.js';
import type { BoundPane } from '../workers/panes.js';
import { branchOf, readWorkerRecord, requireRecord, workCopyOf, writeWorkerRecord } from '../workers/registry.js';
import { parseReset, resetOutput, resetWorker } from '../workers/reset.js';
import { readWorkerPanes, summonWorker } from '../workers/slot.js';
import { stopWorker, type StopOutcome } from '../workers/stop.js';
import { watchOutput, watchWorkers } from '../workers/watch.js';
import { prepareLaunch } from './launch-checks.js';
import { runWorkerList } from './worker-list.js';

export interface WorkerOptions {
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
  readonly home: string | undefined;
  /** The id of the project of a new worker. */
  readonly project: string | undefined;
  /** True when the person gave the yes flag. It is the consent to the change of the hook settings. */
  readonly yes: boolean;
  /** The text of the time flag of a summon, `<n>m` or `<n>h`. Undefined: the default time. */
  readonly duration: string | undefined;
  /** True when the person gave the clear flag. Only a reset reads it. Absent: false. */
  readonly clear?: boolean;
  /** True when the person gave the compact flag. Only a reset reads it. Absent: false. */
  readonly compact?: boolean;
  /** The path of the assignment file of a new worker. Only `new` reads it. Absent: the worker has no assignment. */
  readonly assignment?: string | undefined;
  /** The ids of `--ready`: workers that the watch waits for after a block. Only `watch` reads them. Absent: none. */
  readonly ready?: readonly string[];
}

const SUBCOMMANDS = Object.values(workerCommands).join(', ');

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.worker)} ${flagText(flags.help)}".`);

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** The same error with this remedy line. */
const withHint = (error: CliError, hint: string): CliError => ({ ...error, hint });

/** The command that a person types for the new worker of a project, with its two words that the person chooses. */
const newLine = (id: string, project: string): string =>
  `${commandText(commandLines.workerNew)} ${id} ${flagText(flags.project)} ${project}`;

/** The request for the consent to the hook settings of a work copy. */
const hookRequestOf = (workCopy: string, yes: boolean): HookConsentRequest => ({
  folder: workCopy,
  session: hookSessions.workCopy,
  yes,
  command: commandLines.workerNew,
});

/** Where a new worker lives, and what it is called. */
interface NewWorkerPlan {
  readonly id: string;
  readonly project: string;
  /** The clone of the project: the work copy is a work tree of its repo. */
  readonly clone: string;
  readonly workCopy: string;
  readonly branch: string;
}

/** The factory folder of the command: the folder of the option, or the one that the current folder is in. */
const locateNode = async (deps: Deps, options: WorkerOptions, registry: RecipeRegistry): Promise<CliResult<string>> => {
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.worker,
  );
  return located.ok ? ok(located.value.home) : located;
};

/** A folder of the work copies that exists must be a folder. A link is a stop of the link rule before this check. */
const requireFolder = async (deps: Deps, path: string, shown: string, again: string): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(path);
  if (!kind.ok) return kind;
  if (kind.value === null || kind.value === 'dir') return ok(undefined);
  return safetyRefusal(`${shown} is not a folder, so ${program} does not use it`, `Move it away, then run "${again}" again.`);
};

/**
 * Every check that comes before the first write, in this order: the words of the command line (the id and the project),
 * the link rule (exit 4), the kind of the folders of the work copies (exit 4), the id that is taken (exit 2: a record, a
 * work copy or a branch), and the clone. Nothing is written.
 */
const planNew = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  id: string,
  projectId: string,
): Promise<CliResult<NewWorkerPlan>> => {
  if (!isSlug(id)) {
    return usageError(
      `the ${roles.worker} id ${JSON.stringify(id)} is not a slug`,
      `Use a-z, 0-9 and hyphen, at most 40 characters, with no hyphen at the start. Then run "${newLine('ID', projectId)}" again.`,
    );
  }
  if (id === config.core.node.id) {
    return usageError(
      `the id ${id} is the id of this ${roles.node}`,
      `Choose another id. Then run "${newLine('ID', projectId)}" again.`,
    );
  }
  const project = config.recipe.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    const listed = config.recipe.projects.map((candidate) => candidate.id);
    return usageError(
      `the project ${JSON.stringify(projectId)} is not listed in the config of this ${roles.node}`,
      `${listed.length === 0 ? `The config lists no project` : `The listed projects are: ${listed.join(', ')}`}. Run "${newLine(id, 'PROJECT')}" with a listed project.`,
    );
  }

  const layout = layoutOf(home);
  const clone = resolve(home, project.path);
  const projectCopies = join(layout.workCopiesDir, project.id);
  const workCopy = workCopyOf(home, project.id, id);
  const again = newLine(id, project.id);
  const linked = await requireNoLinks(deps, home, [clone, workerPathsOf(home, id).dir, workCopy]);
  if (!linked.ok) return linked;
  for (const [path, shown] of [
    [layout.workCopiesDir, dirs.workCopies],
    [projectCopies, join(dirs.workCopies, project.id)],
  ] as const) {
    const folder = await requireFolder(deps, path, shown, again);
    if (!folder.ok) return folder;
  }

  const another = `Choose another id. Then run "${newLine('ID', project.id)}" again.`;
  const record = await readWorkerRecord(deps, home, id);
  if (!record.ok) return record;
  if (record.value.state === 'valid') return usageError(`the ${roles.worker} id ${id} has a record already`, another);
  if (record.value.state === 'invalid') {
    return usageError(`the ${roles.worker} id ${id} has a record that is not valid: ${record.value.reason}`, another);
  }
  const taken = await deps.fs.lstat(workCopy);
  if (!taken.ok) return taken;
  const shownCopy = relative(home, workCopy);
  if (taken.value !== null) return usageError(`the work copy ${shownCopy} exists already`, another);

  if (!(await isWorkTreeRoot(deps, clone))) {
    return failure(
      `the clone of the project ${project.id} (${relative(home, clone)}) is not a git work tree`,
      `Clone the repo of the project into that folder. Then run "${again}" again.`,
    );
  }
  const branch = branchOf(id);
  const exists = await branchExists(deps, clone, branch);
  if (!exists.ok) return exists;
  if (exists.value) return usageError(`the branch ${branch} exists already in the project ${project.id}`, another);
  return ok({ id, project: project.id, clone, workCopy, branch });
};

/** The error with its remedy line and these sentences, in order. */
const withHintParts = (error: CliError, parts: readonly string[]): CliError =>
  withHint(error, [...(error.hint === undefined ? [] : [error.hint]), ...parts].join(' '));

/** The two git commands that remove a work copy and then its branch. Git keeps the branch in use while the work copy exists. */
const removeCopyAndBranch = (plan: NewWorkerPlan): string => {
  const git = `git -C ${shellWord(plan.clone)}`;
  return `"${git} worktree remove ${shellWord(plan.workCopy)}" and then "${git} branch -D ${shellWord(plan.branch)}"`;
};

/**
 * The ways to remove a worker: the command that frees it once its branch is pushed, and the steps by hand, which are the way for a
 * branch that is not pushed: the work copy and its branch, then the folder of its record.
 */
const removeByHand = (plan: NewWorkerPlan, home: string): string =>
  `After its branch is pushed, ${program} can remove it: run "${commandText(dismissLine(plan.id))}" to see the steps, ` +
  `then add ${flagText(flags.yes)} in a terminal window outside a ${places.session}. ` +
  `To remove the ${roles.worker} by hand, run ${removeCopyAndBranch(plan)}. ` +
  `Then delete the folder ${shellWord(workerPathsOf(home, plan.id).dir)}.`;

/**
 * The error of a step after the work copy, the branch and the record exist. Nothing is undone, and the remedy names the steps that
 * remove the worker by hand. `skipsSetup` is true for a step that ends before the launch: `worker resume` starts the worker then,
 * but it does not make the exclude entry or the hook settings that the failed run did not reach.
 */
const keptCopy = (error: CliError, plan: NewWorkerPlan, home: string, skipsSetup: boolean): CliError =>
  withHintParts(error, [
    `Nothing is undone: the work copy, the branch and the record of the ${roles.worker} stay.`,
    ...(skipsSetup
      ? [
          `To start the ${roles.worker}, run "${commandText(resumeLine(plan.id))}". ` +
            'That command does not make the exclude entry or the hook settings again.',
        ]
      : []),
    removeByHand(plan, home),
  ]);

/** The file of the assignment in the inbox folder of a worker. */
const assignmentFileOf = (home: string, id: string): string => join(workerPathsOf(home, id).inboxDir, files.assignment);

/** Copy the text of the assignment into the inbox folder of the worker, which the write of the record made. */
const copyAssignment = (deps: Deps, home: string, id: string, text: string): Promise<CliResult<void>> => {
  const paths = workerPathsOf(home, id);
  return writeInFolder(
    deps,
    { parent: paths.dir, folder: paths.inboxDir, name: files.assignment, mode: workerRecord.fileMode, folderMode: workerRecord.folderMode },
    text,
  );
};

/** The command to run again for a new worker with an assignment file, without the program name. The words in capitals are the person's. */
const assignmentAgain = (id: string, project: string): string =>
  `${commandLines.workerNew} ${id} ${flagText(flags.project)} ${project} ${flagText(flags.assignment)} FILE`;

/** The error of a failed record write: the work copy and the branch exist and have no record, so the remedy is the git commands. */
const keptBareCopy = (error: CliError, plan: NewWorkerPlan): CliError =>
  withHintParts(error, [
    `The work copy ${plan.workCopy} and the branch ${plan.branch} stay, and the ${roles.worker} has no record.`,
    `To remove them, run ${removeCopyAndBranch(plan)}.`,
    `Then run "${newLine(plan.id, plan.project)}" again.`,
  ]);

/**
 * The error of a failed record write. The record exists when only its inbox folder failed: the worker is then kept as a whole.
 * With no record, the work copy and the branch are all that stay.
 */
const recordWriteError = async (deps: Deps, home: string, error: CliError, plan: NewWorkerPlan): Promise<CliError> => {
  const written = await readWorkerRecord(deps, home, plan.id);
  return written.ok && written.value.state === 'absent' ? keptBareCopy(error, plan) : keptCopy(error, plan, home, false);
};

/** The error of a failed `git worktree add`: git can keep the branch, and after a failed hook it keeps the work copy too. */
const gitKeptHint = (error: CliError, plan: NewWorkerPlan): CliError =>
  withHintParts(error, [
    'Fix the cause that git reports.',
    `Git can keep the branch ${plan.branch} and the folder ${plan.workCopy} after a failure.`,
    `To remove what it kept, run ${removeCopyAndBranch(plan)}. Run the first command only if the folder is there.`,
    `Then run "${newLine(plan.id, plan.project)}" again.`,
  ]);

/**
 * The steps that write, in order, after every check and the consent of the hook settings:
 * 1. the work copy, a new work tree of the clone on a new branch;
 * 2. the record of the worker, before the launch, so the hook of the session can write its last-seen line;
 * 3. the copy of the assignment text into the inbox folder of the worker, when the person gave a file (`assignment` is the text that the
 *    source check read);
 * 4. the exclude entry of the clone for the settings file of the work copy;
 * 5. the settings file of the work copy, with the question for the consent when a terminal window can ask;
 * 6. the warning about the machine, which never stops the command;
 * 7. the launch, which checks the settings files of the work copy before it starts the pane.
 * A failure after step 1 keeps what exists and names the steps that remove the worker by hand.
 */
const makeWorker = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  plan: NewWorkerPlan,
  yes: boolean,
  assignment: string | null,
): Promise<CliResult<{ readonly paneId: string; readonly proxy: string | null; readonly warnings: readonly string[] }>> => {
  const { id, project, clone, workCopy, branch } = plan;
  const made = await addWorkTree(deps, clone, branch, workCopy);
  if (!made.ok) return { ...made, error: gitKeptHint(made.error, plan) };
  const record = await writeWorkerRecord(deps, home, { id, project, workCopy, branch });
  if (!record.ok) return { ...record, error: await recordWriteError(deps, home, record.error, plan) };
  if (assignment !== null) {
    const copied = await copyAssignment(deps, home, id, assignment);
    if (!copied.ok) {
      const byHand = `Copy the assignment file by hand to ${shellWord(assignmentFileOf(home, id))}.`;
      return { ...copied, error: keptCopy(withHintParts(copied.error, [byHand]), plan, home, true) };
    }
  }
  const exclude = await ensureCloneExclude(deps, clone);
  if (!exclude.ok) return { ...exclude, error: keptCopy(exclude.error, plan, home, true) };
  const hook = await ensureHookSettings(deps, { ...hookRequestOf(workCopy, yes), dryRun: false });
  if (!hook.ok) return { ...hook, error: keptCopy(hook.error, plan, home, true) };
  if (hook.value.kind === 'declined') {
    deps.warn(declinedHookText(hook.value.file, commandLines.workerNew, hookSessions.workCopy));
  }
  for (const line of machineWarnings(await gatherMachine(deps, home, config.core.limits))) deps.warn(line);
  const launched = await launchWorker(deps, { home, config, workerId: id, workCopy, retry: resumeLine(id) });
  if (!launched.ok) return { ...launched, error: keptCopy(launched.error, plan, home, false) };
  return ok(launched.value);
};

const runNew = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [id] = args;
  if (args.length !== 1 || id === undefined) {
    return needsUsage(`${workerCommands.new} takes one argument: the id of the ${roles.worker}`);
  }
  if (options.project === undefined) {
    return usageError(
      `${workerCommands.new} needs ${flagText(flags.project)}: the project of the ${roles.worker}`,
      `Run "${newLine(id, 'PROJECT')}".`,
    );
  }

  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const prepared = await prepareLaunch(deps, home, registry, commandText(commandLines.workerNew));
  if (!prepared.ok) return prepared;
  const { config, notes } = prepared.value;

  const plan = await planNew(deps, home, config, id, options.project);
  if (!plan.ok) return plan;
  // The source check reads the file once, before the first write, and the copy uses that text.
  const assignment =
    options.assignment === undefined
      ? ok(null)
      : await readAssignment(deps, { home, path: options.assignment, again: assignmentAgain(id, options.project) });
  if (!assignment.ok) return assignment;
  // Every refusal about the settings comes before the first write. The new branch starts at the last commit of the clone, so the
  // files that git puts into the work copy are known now: the settings checks and the consent run on them.
  // The question itself comes after the work copy exists, when a terminal can ask.
  const tracked = await requireCleanTrackedSettings(deps, home, plan.value.clone, plan.value.workCopy);
  if (!tracked.ok) return tracked;
  const consent = await requireHookConsent(deps, hookRequestOf(plan.value.workCopy, options.yes), tracked.value.localText);
  if (!consent.ok) return consent;

  const made = await makeWorker(deps, home, config, plan.value, options.yes, assignment.value);
  if (!made.ok) return made;
  const { workCopy, branch, project } = plan.value;
  const copy = assignment.value === null ? null : assignmentFileOf(home, id);
  return ok({
    lines: [
      text(`Made the ${roles.worker} ${id} in ${relative(home, workCopy)} on the branch ${branch}.`),
      text(`It runs in the pane ${made.value.paneId} of the window ${tmuxNames.windowWorkers}.`),
      text(
        `If Claude Code asks to trust the folder, the ${roles.owner} answers once in the pane ${made.value.paneId}. ` +
          `Then run "${commandText(commandLines.workerWatch)} ${flagText(flags.ready)} ${id}".`,
      ),
      ...(copy === null ? [] : [text(`Copied the assignment to ${relative(home, copy)}.`)]),
    ],
    json: {
      schema: schemaIds.workerNew,
      id,
      project,
      workCopy,
      branch,
      pane: made.value.paneId,
      proxy: made.value.proxy,
      assignment: copy,
    },
    warnings: [...notes, ...made.value.warnings],
    failed: false,
  });
};

const stopOutput = (id: string, outcome: StopOutcome): CommandOutput => {
  switch (outcome.kind) {
    case 'no-pane':
      return {
        lines: [text(`The ${roles.worker} ${id} has no pane. Nothing runs, and nothing changed.`)],
        json: { schema: schemaIds.workerStop, id, outcome: outcome.kind },
        warnings: [],
        failed: false,
      };
    case 'closed-dead':
      return {
        lines: [
          text(
            `The program of the ${roles.worker} ${id} had ended already. Closed the ${outcome.paneIds.length === 1 ? 'pane' : 'panes'} ` +
              `${outcome.paneIds.join(', ')}. No signal was sent.`,
          ),
        ],
        json: { schema: schemaIds.workerStop, id, outcome: outcome.kind, panes: outcome.paneIds },
        warnings: [],
        failed: false,
      };
    case 'stopped':
      return {
        lines: [
          text(`Stopped the ${roles.worker} ${id}.`),
          text(`The process ${outcome.pid} of the pane ${outcome.paneId} ended after ${outcome.way}. The session was ${outcome.state}.`),
          text(outcome.pane === 'closed' ? 'The pane is closed.' : 'tmux closed the pane when the process ended.'),
        ],
        json: {
          schema: schemaIds.workerStop,
          id,
          outcome: outcome.kind,
          pane: outcome.paneId,
          pid: outcome.pid,
          way: outcome.way,
          state: outcome.state,
        },
        warnings: [],
        failed: false,
      };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
};

/**
 * `worker stop ID`: ends the program of the pane of the worker and closes the pane (`stopWorker`). The id must have a record.
 * A worker with no pane is not a fault: nothing runs, and nothing changes.
 */
const runStop = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [id] = args;
  if (args.length !== 1 || id === undefined) {
    return needsUsage(`${workerCommands.stop} takes one argument: the id of the ${roles.worker}`);
  }
  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const record = await requireRecord(deps, home, id, commandText(commandLines.workerStop));
  if (!record.ok) return record;
  const stopped = await stopWorker(deps, { home, session: loaded.value.core.node.id, workerId: id });
  return stopped.ok ? ok(stopOutput(id, stopped.value)) : stopped;
};

/** The id of the session to resume, or the warning that says why the earlier conversation is not resumed. */
type ResumeChoice =
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'new'; readonly warning: string };

/**
 * The session that a resume continues. A program in a worker pane can write the pointer to its own last session, so the pointer
 * counts only when the line belongs to this worker (`readOwnLastSeen`): the session of the coordinator and the session of another
 * worker never pass. Any other state starts a new conversation, with a warning that says that the earlier one is NOT resumed.
 */
const chooseSession = async (deps: Deps, home: string, id: string): Promise<CliResult<ResumeChoice>> => {
  const seen = await readOwnLastSeen(deps, home, id);
  if (!seen.ok) return seen;
  if (seen.value.state === 'valid') return ok({ kind: 'resume', sessionId: seen.value.line[lastSeen.keys.sessionId] });
  const cause =
    seen.value.why === 'no-line'
      ? 'no valid last-seen line'
      : `the last-seen line does not belong to this ${roles.worker}`;
  return ok({
    kind: 'new',
    warning:
      `The earlier conversation of the ${roles.worker} ${id} is NOT resumed. Reason: ${cause} (${seen.value.reason}). ` +
      `A new conversation starts.`,
  });
};

/** A pane of the worker whose program runs is a stop of the resume (exit 2): the worker runs already. */
const requireNoLivePane = (panes: readonly BoundPane[], id: string): CliResult<void> => {
  const live = panes.map((pane) => pane.paneId);
  if (live.length === 0) return ok(undefined);
  return usageError(
    `the ${roles.worker} ${id} runs already in the ${live.length === 1 ? 'pane' : 'panes'} ${live.join(', ')}`,
    `To end it, run "${commandText(commandLines.workerStop)} ${id}". Then run "${commandText(resumeLine(id))}" again.`,
  );
};

/**
 * `worker resume ID`: starts the program of a stopped worker again, in a new pane, with the earlier conversation when it is
 * the one of this worker. In order:
 * 1. the checks of `worker new` (the root, the tools and the tmux session): a failing root check is exit 4 and changes nothing;
 * 2. the record must exist (exit 2). Each pane that carries the mark of the worker is read and bound to the worker
 *    (`readWorkerPanes`): a pane that the launch of the worker did not make is a stop (exit 4), and it is not taken for the
 *    pane of the worker that runs. A pane of the worker that runs is a stop (exit 2);
 * 3. the session to resume. No valid line, or a line that does not belong to the worker, gives no `--resume` and one warning;
 * 4. `resumeWorker` closes the old panes of the worker whose programs ended, by their ids (a pane that a summon left in the slot
 *    goes back first, and the board comes back into the slot), then launches by the same path as `worker new` (it checks the
 *    settings files of the work copy).
 */
const runResume = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [id] = args;
  if (args.length !== 1 || id === undefined) {
    return needsUsage(`${workerCommands.resume} takes one argument: the id of the ${roles.worker}`);
  }
  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const prepared = await prepareLaunch(deps, home, registry, commandText(resumeLine(id)));
  if (!prepared.ok) return prepared;
  const { config, notes } = prepared.value;

  const record = await requireRecord(deps, home, id, commandText(commandLines.workerResume));
  if (!record.ok) return record;
  const panes = await readWorkerPanes(deps, {
    home,
    session: config.core.node.id,
    workerId: id,
    again: resumeLine(id),
  });
  if (!panes.ok) return panes;
  const running = requireNoLivePane(panes.value.live, id);
  if (!running.ok) return running;
  const chosen = await chooseSession(deps, home, id);
  if (!chosen.ok) return chosen;

  const launched = await resumeWorker(deps, {
    home,
    config,
    workerId: id,
    workCopy: record.value.workCopy,
    retry: resumeLine(id),
    deadPanes: panes.value.dead,
    ...(chosen.value.kind === 'resume' ? { resumeId: chosen.value.sessionId } : {}),
  });
  if (!launched.ok) return launched;
  const sessionId = chosen.value.kind === 'resume' ? chosen.value.sessionId : null;
  const where = `in the pane ${launched.value.paneId} of the window ${tmuxNames.windowWorkers}`;
  return ok({
    lines:
      sessionId === null
        ? [text(`Started the ${roles.worker} ${id} again ${where}.`), text('It starts a new conversation.')]
        : [text(`Resumed the ${roles.worker} ${id} ${where}.`), text('It continues the earlier conversation.')],
    json: {
      schema: schemaIds.workerResume,
      id,
      pane: launched.value.paneId,
      resumed: sessionId !== null,
      sessionId,
      proxy: launched.value.proxy,
    },
    warnings: [...notes, ...(chosen.value.kind === 'new' ? [chosen.value.warning] : []), ...launched.value.warnings],
    failed: false,
  });
};

/** The minutes of the time flag of a summon. No flag gives the default time. A text that is not `<n>m` or `<n>h` within the bounds is exit 2. */
const summonMinutes = (duration: string | undefined): CliResult<number> => {
  const given = duration ?? summonLimits.defaultFor;
  const minutes = durationMinutes(given, summonLimits.minMinutes, summonLimits.maxMinutes);
  if (minutes !== null) return ok(minutes);
  return usageError(
    `the value ${JSON.stringify(given)} of ${flagText(flags.for)} is not a time: it must be <n>m or <n>h, from ${summonLimits.minMinutes}m to ${summonLimits.maxMinutes / 60}h`,
    `Run "${commandText(commandLines.workerSummon)} ID ${flagText(flags.for)} ${summonLimits.defaultFor}" with a time from ${summonLimits.minMinutes}m to ${summonLimits.maxMinutes / 60}h.`,
  );
};

/**
 * `worker summon ID [--for TIME]`: shows the pane of the worker in the slot of the view window until the time ends (`summonWorker`).
 * The time and the id are checked before any other work. The id must have a record, else the command exits with code 2.
 */
const runSummon = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [id] = args;
  if (args.length !== 1 || id === undefined) {
    return needsUsage(`${workerCommands.summon} takes one argument: the id of the ${roles.worker}`);
  }
  const minutes = summonMinutes(options.duration);
  if (!minutes.ok) return minutes;
  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const record = await requireRecord(deps, home, id, commandText(commandLines.workerSummon));
  if (!record.ok) return record;
  const summoned = await summonWorker(deps, {
    home,
    session: loaded.value.core.node.id,
    workerId: id,
    minutes: minutes.value,
  });
  if (!summoned.ok) return summoned;
  const { pane, board, until, swapped } = summoned.value;
  const time = `${minutes.value}m`;
  return ok({
    lines: [
      text(`The ${roles.worker} ${id} shows in the slot of the window ${tmuxNames.windowView} (pane ${pane}).`),
      text(`The board comes back after ${time}. Run "${commandText(commands.layout)}" to show it now.`),
    ],
    json: {
      schema: schemaIds.workerSummon,
      id,
      pane,
      board,
      minutes: minutes.value,
      until: until.toISOString(),
      swapped,
    },
    warnings: [],
    failed: false,
  });
};

/**
 * `worker reset ID --clear|--compact`: the words of the command line (exit 2), then the factory folder and its config, then
 * `resetWorker`, which does the caller rule and every other check before it types.
 */
const runReset = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const parsed = parseReset({ words: args, clear: options.clear === true, compact: options.compact === true });
  if (!parsed.ok) return parsed;
  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const { workerId, kind } = parsed.value;
  const reset = await resetWorker(deps, { home, config: loaded.value, workerId, kind });
  return reset.ok ? ok(resetOutput(reset.value)) : reset;
};

/**
 * `worker watch [ID]...`: reports the first change of the named workers, or of every recorded worker. The ids are checked by the
 * watch (`requireRecord`). The watch never types, signals or writes.
 */
const runWatch = async (
  deps: Deps,
  options: WorkerOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const located = await locateNode(deps, options, registry);
  if (!located.ok) return located;
  const home = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const watched = await watchWorkers(deps, { home, config: loaded.value, workerIds: args, readyIds: options.ready ?? [] });
  return watched.ok ? ok(watchOutput(watched.value)) : watched;
};

/** The flags `--clear` and `--compact` belong to `reset`. Another subcommand refuses them (exit 2), so no flag is taken and then ignored. */
const requireNoResetFlags = (options: WorkerOptions): CliResult<void> => {
  const given = [...(options.clear === true ? [flags.clear] : []), ...(options.compact === true ? [flags.compact] : [])];
  if (given.length === 0) return ok(undefined);
  return needsUsage(`${given.map(flagText).join(' and ')} ${given.length === 1 ? 'belongs' : 'belong'} to ${workerCommands.reset} only`);
};

/** The flag `--assignment` belongs to `new`. Another subcommand refuses it (exit 2), so no flag is taken and then ignored. */
const requireNoAssignment = (options: WorkerOptions): CliResult<void> =>
  options.assignment === undefined ? ok(undefined) : needsUsage(`${flagText(flags.assignment)} belongs to ${workerCommands.new} only`);

/** The flag `--ready` belongs to `watch`. Another subcommand refuses it (exit 2), so no flag is taken and then ignored. */
const requireNoReady = (options: WorkerOptions): CliResult<void> =>
  (options.ready ?? []).length === 0 ? ok(undefined) : needsUsage(`${flagText(flags.ready)} belongs to ${workerCommands.watch} only`);

/** The flags that belong to one subcommand only. Every other subcommand refuses them. */
const requireOwnFlags = (subcommand: string, options: WorkerOptions): CliResult<void> => {
  const stray = subcommand === workerCommands.reset ? ok(undefined) : requireNoResetFlags(options);
  if (!stray.ok) return stray;
  const ready = subcommand === workerCommands.watch ? ok(undefined) : requireNoReady(options);
  if (!ready.ok) return ready;
  return subcommand === workerCommands.new ? ok(undefined) : requireNoAssignment(options);
};

const isSubcommand = (word: string | undefined): word is string => Object.values<string>(workerCommands).includes(word ?? '');

/** `worker <subcommand>`: the commands of the workers of a node. */
export const runWorker = async (
  deps: Deps,
  options: WorkerOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  if (isSubcommand(subcommand)) {
    const stray = requireOwnFlags(subcommand, options);
    if (!stray.ok) return stray;
  }
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.worker)} needs a subcommand: ${SUBCOMMANDS}`);
    case workerCommands.new:
      return runNew(deps, options, args, registry);
    case workerCommands.stop:
      return runStop(deps, options, args, registry);
    case workerCommands.resume:
      return runResume(deps, options, args, registry);
    case workerCommands.summon:
      return runSummon(deps, options, args, registry);
    case workerCommands.reset:
      return runReset(deps, options, args, registry);
    case workerCommands.watch:
      return runWatch(deps, options, args, registry);
    case workerCommands.list:
      return args.length === 0
        ? runWorkerList(deps, { home: options.home }, registry, boardWorkItems(registry))
        : needsUsage(`${workerCommands.list} takes no argument`);
    default:
      return needsUsage(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommands are: ${SUBCOMMANDS}`);
  }
};
