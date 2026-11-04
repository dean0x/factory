import { join, relative, resolve } from 'node:path';
import { failure, notReady, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity, settleLocalMode } from '../config/load.js';
import { isSlug } from '../config/primitives.js';
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
import { warnInstructionFiles } from '../core/instruction-files.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { shellWord } from '../core/shell-word.js';
import { requireOwnSession, sessionExists } from '../launch/tmux-run.js';
import {
  commandLines,
  commands,
  commandText,
  dirs,
  flags,
  flagText,
  hookSessions,
  program,
  roles,
  schemaIds,
  tmuxNames,
  workerCommands,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { ensureCloneExclude } from '../workers/exclude.js';
import { dismissCommand, launchWorker, resumeLine } from '../workers/launch.js';
import { gatherMachine, machineWarnings } from '../workers/machine.js';
import { readWorkerRecord, writeWorkerRecord } from '../workers/registry.js';
import { requireSafetyBlock, toolProblems } from './launch-checks.js';
import { requireRootClean, rootNotices, scanRoot } from './root-content.js';

export interface WorkerOptions {
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
  readonly home: string | undefined;
  /** The id of the project of a new worker. */
  readonly project: string | undefined;
  /** True when the person gave the yes flag. It is the consent to the change of the hook settings. */
  readonly yes: boolean;
}

const SUBCOMMANDS = Object.values(workerCommands).join(', ');

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.worker)} ${flagText(flags.help)}".`);

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** The same error with this remedy line. */
const withHint = (error: CliError, hint: string): CliError => ({ ...error, hint });

/** The branch of a new worker. It starts at the head of the clone. */
const branchOf = (id: string): string => `${roles.worker}/${id}`;

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

/**
 * The checks of the root and of the tools, as `start` makes them. A failing root check is a stop (exit 4) with one remedy
 * line, a warning is printed, and nothing changes. The owner accepts a change of the setup text with `start` or `upgrade`:
 * this command asks nothing about it. The safety block is checked and never rendered again here: the next `start` renders it.
 */
const requireLaunchReady = async (deps: Deps, home: string, config: FactoryConfig): Promise<CliResult<void>> => {
  const scan = await scanRoot(deps, home, config);
  for (const notice of rootNotices(scan)) deps.warn(notice);
  const clean = requireRootClean(scan);
  if (!clean.ok) return clean;
  const safety = await requireSafetyBlock(deps, home, config, true);
  if (!safety.ok) return safety;
  const problems = await toolProblems(deps, true);
  if (problems.length > 0) {
    return failure(
      problems.join('. '),
      `Run "${commandText(commands.doctor)} ${flagText(flags.home)} ${shellWord(home)}" to check the tools.`,
    );
  }
  return ok(undefined);
};

/** The tmux session of the node must run, and it must be the session of this factory folder. */
const requireSession = async (deps: Deps, id: string, home: string): Promise<CliResult<void>> => {
  if (!(await sessionExists(deps, id))) {
    return notReady(
      `the tmux session ${id} of this ${roles.node} does not run`,
      `Run "${commandText(commands.start)}" to start it. Then run "${commandText(commandLines.workerNew)}" again.`,
    );
  }
  return requireOwnSession(deps, id, home);
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
  const workCopy = join(projectCopies, id);
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

/** The error of a step after the work copy and the record exist. Nothing is undone, and the remedy names the command that ends the worker. */
const keptCopy = (error: CliError, id: string): CliError =>
  withHint(
    error,
    `${error.hint === undefined ? '' : `${error.hint} `}Nothing is undone: the work copy and the record of the ${roles.worker} stay. ` +
      `To end the ${roles.worker}, run "${dismissCommand(id)}".`,
  );

/** The error of the record write: the work copy exists and has no record, so the remedy is the plain git command. */
const keptBareCopy = (error: CliError, plan: NewWorkerPlan): CliError =>
  withHint(
    error,
    `${error.hint === undefined ? '' : `${error.hint} `}The work copy ${plan.workCopy} stays and has no record. ` +
      `To remove it, run "git -C ${shellWord(plan.clone)} worktree remove ${shellWord(plan.workCopy)}".`,
  );

/**
 * The steps that write, in order, after every check and the consent of the hook settings:
 * 1. the work copy, a new work tree of the clone on a new branch;
 * 2. the record of the worker, before the launch, so the hook of the session can write its last-seen line;
 * 3. the exclude entry of the clone for the settings file of the work copy;
 * 4. the settings file of the work copy, with the question for the consent when a terminal window can ask;
 * 5. the warning about the machine, which never stops the command;
 * 6. the launch, which checks the settings files of the work copy before it starts the pane.
 * A failure after step 1 keeps the work copy and the record and names the command that ends the worker.
 */
const makeWorker = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  plan: NewWorkerPlan,
  yes: boolean,
): Promise<CliResult<{ readonly paneId: string; readonly proxy: string | null; readonly warnings: readonly string[] }>> => {
  const { id, project, clone, workCopy, branch } = plan;
  const made = await addWorkTree(deps, clone, branch, workCopy);
  if (!made.ok) {
    return { ...made, error: withHint(made.error, `Fix the cause that git reports. Then run "${newLine(id, project)}" again.`) };
  }
  const record = await writeWorkerRecord(deps, home, { id, project, workCopy, branch });
  if (!record.ok) return { ...record, error: keptBareCopy(record.error, plan) };
  const exclude = await ensureCloneExclude(deps, clone);
  if (!exclude.ok) return { ...exclude, error: keptCopy(exclude.error, id) };
  const hook = await ensureHookSettings(deps, { ...hookRequestOf(workCopy, yes), dryRun: false });
  if (!hook.ok) return { ...hook, error: keptCopy(hook.error, id) };
  if (hook.value.kind === 'declined') {
    deps.warn(declinedHookText(hook.value.file, commandLines.workerNew, hookSessions.workCopy));
  }
  for (const line of machineWarnings(await gatherMachine(deps, home, config.core.limits))) deps.warn(line);
  const launched = await launchWorker(deps, { home, config, workerId: id, workCopy, retry: resumeLine(id) });
  if (!launched.ok) return { ...launched, error: keptCopy(launched.error, id) };
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

  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.worker,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  // The warning about instruction files comes before any change or launch, and it never stops the command.
  await warnInstructionFiles(deps, home);
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const config = loaded.value;
  const notes = await settleLocalMode(deps, home, true);
  if (!notes.ok) return notes;

  const ready = await requireLaunchReady(deps, home, config);
  if (!ready.ok) return ready;
  const session = await requireSession(deps, config.core.node.id, home);
  if (!session.ok) return session;

  const plan = await planNew(deps, home, config, id, options.project);
  if (!plan.ok) return plan;
  // The consent comes before the first write. The question itself comes after the work copy exists, when a terminal can ask.
  const consent = await requireHookConsent(deps, hookRequestOf(plan.value.workCopy, options.yes));
  if (!consent.ok) return consent;

  const made = await makeWorker(deps, home, config, plan.value, options.yes);
  if (!made.ok) return made;
  const { workCopy, branch, project } = plan.value;
  return ok({
    lines: [
      text(`Made the ${roles.worker} ${id} in ${relative(home, workCopy)} on the branch ${branch}.`),
      text(`It runs in the pane ${made.value.paneId} of the window ${tmuxNames.windowWorkers}.`),
    ],
    json: {
      schema: schemaIds.workerNew,
      id,
      project,
      workCopy,
      branch,
      pane: made.value.paneId,
      proxy: made.value.proxy,
    },
    warnings: [...notes.value, ...made.value.warnings],
    failed: false,
  });
};

/** `worker <subcommand>`: the commands of the workers of a node. */
export const runWorker = async (
  deps: Deps,
  options: WorkerOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.worker)} needs a subcommand: ${SUBCOMMANDS}`);
    case workerCommands.new:
      return runNew(deps, options, args, registry);
    default:
      return needsUsage(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommands are: ${SUBCOMMANDS}`);
  }
};
