import { join } from 'node:path';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable, type CommandOutput, type OutLine } from '../cli/output.js';
import { inspectSharedConfig } from '../config/load.js';
import { isGithubLogin } from '../config/primitives.js';
import { renderConfig } from '../config/render.js';
import { localConfigSchema, mergeConfig, type FactoryConfig, type SharedConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { configValue, ignoredPathsOf, isWorkTreeRoot, trackedFilesOf } from '../core/git.js';
import { rootRefusalOf } from '../core/home.js';
import { entryOfHome, readHomeIndex } from '../core/home-index.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import {
  describeTrackedProblems,
  ignoreProbesOf,
  REMOVE_REMEDY,
  requireNoLinks,
  requireNoRootLinks,
  requireNoTrackedLinks,
  TRACKED_CAP_MESSAGE,
  TRACKED_CAP_REMEDY,
  trackedProblems,
  trackedSetOf,
  type TrackedProblem,
} from '../core/root-paths.js';
import {
  acceptanceState,
  askSetupAcceptance,
  collectManifest,
  manifestOf,
  type Collected,
  type ManifestEntry,
} from '../core/setup-acceptance.js';
import { describeIssues } from '../core/zod.js';
import { refuse } from '../migrate/inspect.js';
import type { RecipeRegistry } from '../recipes/index.js';
import {
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  maxSetupTextBytes,
  ownerQuestion,
  places,
  program,
  roles,
  schemaIds,
  setupAcceptance,
} from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
import { plainSetupText, renderableSetupText } from '../state/setup-text.js';
import { blockInputOf, blockTemplatesFor } from '../templates/index.js';
import type { SetupTexts } from '../templates/types.js';
import {
  applyInit,
  blockTexts,
  detectGithubLogin,
  localSettingsOf,
  stateFilesOf,
  type InitOptions,
  type InitPlan,
  type PlannedAcceptance,
} from './init.js';
import {
  approvalLines,
  approvalsFromFlags,
  askApprovals,
  initInTerminalWindow,
  NO_APPROVALS,
  type ApprovalChoice,
} from './init-approval.js';
import { checkHomeOutsideRoots, leftoverTempFolders, tempFolderWarning } from './init-home.js';
import { planReceivedProjects, runClones, undoClones } from './init-clone.js';

/**
 * `init` in a folder that holds `factory.yaml` and no local file: a factory that arrived, for example with `git clone`.
 * The folder is a trust boundary. `init` checks what git tracks and what git ignores before it writes anything, and it
 * never changes `factory.yaml`, `setup/` or the root `.gitignore`.
 *
 * Part of this module is the dispatch point for the paths that start from a root that holds both config files: the checks
 * of `checkReceivedRoot`, the setup of `collectSetup` and the decision of `decideAcceptance` are the same for them.
 */

export const ACCEPT_REASON = `the ${roles.owner} accepted these files in a terminal window with ${commands.init}`;
export const YES_REASON = 'init with the yes flag: first acceptance of the setup text';
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** What `checkReceivedRoot` finds in a received root, before anything is written. */
export interface ReceivedRoot {
  readonly layout: Layout;
  readonly shared: SharedConfig;
  /** Every path that the root repo tracks, in the order of git. */
  readonly tracked: readonly string[];
  /** The tracked set: every tracked path apart from `factory.yaml` and the root `.gitignore`. */
  readonly set: readonly string[];
  readonly warnings: readonly string[];
}

/** The paths that the root repo must not track, as a stop (exit 4) that names them. */
const requireNoTrackedProblems = (problems: readonly TrackedProblem[]): CliResult<void> =>
  problems.length === 0
    ? ok(undefined)
    : safetyRefusal(`the git repo of the ${places.folder} tracks files that must stay on this machine: ${describeTrackedProblems(problems)}`, REMOVE_REMEDY);

/** On a received root, a state folder in any form is a stop. The folder holds the history of a node, so init never replaces it. */
const requireNoStateFolder = async (deps: Deps, layout: Layout): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(layout.stateDir);
  if (!kind.ok) return kind;
  return kind.value === null
    ? ok(undefined)
    : safetyRefusal(
        `${dirs.state} exists in the received ${places.folder} ${layout.home}, so ${program} does not make the state folder`,
        `Move ${dirs.state} away, then run "${commandText(commands.init)}" again.`,
      );
};

/** On a root that holds both config files, the state path is a folder or it is not there. Any other form is a stop. */
const requireStateFolderOrNone = async (deps: Deps, layout: Layout): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(layout.stateDir);
  if (!kind.ok) return kind;
  return kind.value === null || kind.value === 'dir' ? ok(undefined) : rootRefusalOf(layout.home, { kind: 'state-not-folder' });
};

/**
 * Git must ignore the local file and the state folder, or private data could go out with the next commit (exit 4, and the
 * message names the line of `.gitignore`). A coordinator folder or a project folder that git does not ignore is a warning.
 */
const checkIgnoreRules = async (
  deps: Deps,
  layout: Layout,
  projectPaths: readonly string[],
): Promise<CliResult<readonly string[]>> => {
  const { clones: projectProbes, ...probes } = ignoreProbesOf(projectPaths);
  const ignored = await ignoredPathsOf(deps, layout.home, [probes.local, probes.state, probes.coordinator, ...projectProbes]);
  if (!ignored.ok) return ignored;
  const lines = [
    ...(ignored.value.has(probes.local) ? [] : [files.localConfig]),
    ...(ignored.value.has(probes.state) ? [] : [`${dirs.state}/`]),
  ];
  if (lines.length > 0) {
    return safetyRefusal(
      `git does not ignore ${lines.join(' and ')}, so private data could go out with the next commit`,
      `Add the ${lines.length === 1 ? 'line' : 'lines'} ${lines.map((line) => `"${line}"`).join(' and ')} to ${files.gitignore}, then run "${commandText(commands.init)}" again.`,
    );
  }
  return ok([
    ...(ignored.value.has(probes.coordinator)
      ? []
      : [`Git does not ignore ${dirs.coordinator}/. Add the line "${dirs.coordinator}/" to ${files.gitignore}.`]),
    ...projectPaths.flatMap((path, index) =>
      ignored.value.has(projectProbes[index] ?? '')
        ? []
        : [`Git does not ignore the project folder ${path}/. Add the line "${path}/" to ${files.gitignore}.`],
    ),
  ]);
};

/**
 * Every check of a received root that needs no answer and writes nothing: the links, the top of the work tree, the files
 * that git tracks (the cap, the local file, the state folder, the coordinator folder and the project folders, and links),
 * the shared file, a state folder in any form and the ignore rules. A root that holds both config files has a state
 * folder of its own: with `keepState`, a folder is no stop, and a state path of any other form is.
 */
export const checkReceivedRoot = async (
  deps: Deps,
  home: string,
  registry: RecipeRegistry,
  checks: { readonly keepState?: boolean } = {},
): Promise<CliResult<ReceivedRoot>> => {
  const layout = layoutOf(home);
  const plain = await requireNoRootLinks(deps, layout);
  if (!plain.ok) return plain;
  const config = await requireNoLinks(deps, home, [layout.configFile]);
  if (!config.ok) return config;

  if (!(await isWorkTreeRoot(deps, home))) {
    return safetyRefusal(
      `${home} is not the top folder of a git work tree, so ${program} cannot list the files that git tracks`,
      `Get the ${places.folder} with "git clone", then run "${commandText(commands.init)}" in the cloned folder.`,
    );
  }
  const list = await trackedFilesOf(deps, home);
  if (!list.ok) return list;
  if (list.value.reachedCap) return safetyRefusal(TRACKED_CAP_MESSAGE, TRACKED_CAP_REMEDY);
  const tracked = list.value.paths;
  const set = trackedSetOf(tracked);
  const linked = await requireNoTrackedLinks(deps, home, set);
  if (!linked.ok) return linked;

  const shared = await inspectSharedConfig(deps, home, registry);
  if (shared.kind !== 'valid') return refuse(shared, files.config);
  const projectPaths = shared.value.recipe.projects.map((project) => project.path);
  const problems = requireNoTrackedProblems(trackedProblems(tracked, projectPaths));
  if (!problems.ok) return problems;
  const noState = checks.keepState === true ? await requireStateFolderOrNone(deps, layout) : await requireNoStateFolder(deps, layout);
  if (!noState.ok) return noState;
  const warnings = await checkIgnoreRules(deps, layout, projectPaths);
  if (!warnings.ok) return warnings;
  return ok({ layout, shared: shared.value, tracked, set, warnings: warnings.value });
};

/** The set of files that the owner accepts, with the text of each setup file, from one read of the bytes. */
export interface CollectedSetup {
  /** The files of the set apart from a setup text that is empty. Empty when the set is empty. */
  readonly collected: Collected;
  /** The paths of the set that are not setup text: the listed files. */
  readonly listed: readonly string[];
  /** The text of each setup file as the blocks use it, from the bytes that the hash covers. */
  readonly texts: SetupTexts;
}

const isSetupText = (path: string): boolean => setupAcceptance.setupTextFiles.some((file) => file === path);

/**
 * Read the files of the set once, and hash and render the same bytes. A setup text that is absent or empty is not part of
 * the set, and it never skips the acceptance of the listed files. The text of a setup file must be plain text.
 */
export const collectSetup = async (deps: Deps, home: string, set: readonly string[]): Promise<CliResult<CollectedSetup>> => {
  const read = await collectManifest(deps, home, set, new Map(), { textLimit: maxSetupTextBytes });
  if (!read.ok) return read;
  // A text over the bound for a setup text is not blank: it stays in the set, and `textOf` refuses it.
  const blank = (path: string): boolean => {
    const raw = read.value.texts.get(path);
    return raw !== undefined && raw !== null && renderableSetupText(raw) === null;
  };
  const entries: readonly ManifestEntry[] = read.value.manifest.entries.filter((entry) => !(isSetupText(entry.path) && blank(entry.path)));
  const textOf = (path: string): CliResult<string | null> => {
    if (!entries.some((entry) => entry.path === path)) return ok(null);
    const raw = read.value.texts.get(path);
    if (raw === undefined || raw === null) {
      return failure(`${path} is larger than ${maxSetupTextBytes} bytes`, `Shorten ${path}, then run the command again.`);
    }
    const plain = plainSetupText(path, raw);
    return plain.ok ? ok(renderableSetupText(plain.value)) : plain;
  };
  const [coordinatorPath, workerPath] = setupAcceptance.setupTextFiles;
  const coordinator = textOf(coordinatorPath);
  if (!coordinator.ok) return coordinator;
  const worker = textOf(workerPath);
  if (!worker.ok) return worker;
  return ok({
    collected: { manifest: manifestOf(entries), texts: read.value.texts },
    listed: entries.filter((entry) => !isSetupText(entry.path)).map((entry) => entry.path),
    texts: { coordinator: coordinator.value, worker: worker.value },
  });
};

/** What the setup acceptance of a run is. */
export type AcceptanceDecision =
  /** The set is empty: there is nothing to accept. */
  | { readonly kind: 'none' }
  /** An acceptance for this root, this node id and this hash exists already. */
  | { readonly kind: 'already' }
  /** `init` writes an acceptance after the entry in the factory list. */
  | { readonly kind: 'record'; readonly fromInitYes: boolean }
  /** The owner said no. */
  | { readonly kind: 'declined' };

/**
 * Decide the setup acceptance. The yes flag accepts only a first acceptance of the setup text alone, and never the listed
 * files: those get the question on a terminal window, and a run with no terminal window stops (exit 4) before any write.
 * Any other case is a change, and only the owner in a terminal window accepts it.
 */
export const decideAcceptance = async (
  asking: Deps,
  request: { readonly home: string; readonly node: string; readonly yes: boolean; readonly setup: CollectedSetup },
): Promise<CliResult<AcceptanceDecision>> => {
  const { home, node, yes, setup } = request;
  if (setup.collected.manifest.entries.length === 0) return ok({ kind: 'none' });
  const state = await acceptanceState(asking, { root: home, node, hash: setup.collected.manifest.hash });
  if (!state.ok) return state;
  if (state.value.state === 'accepted') return ok({ kind: 'already' });
  if (yes && state.value.state === 'none' && setup.listed.length === 0) return ok({ kind: 'record', fromInitYes: true });
  if (!(asking.stdinIsTTY && asking.stdoutIsTTY)) {
    return safetyRefusal(
      `the setup of the ${places.folder} needs an acceptance, and no terminal window can ask for it`,
      `${initInTerminalWindow()} Or remove the listed files from the config repo.`,
    );
  }
  const answer = await askSetupAcceptance(asking, { root: home, node, current: setup.collected });
  if (!answer.ok) return answer;
  return ok(answer.value ? { kind: 'record', fromInitYes: false } : { kind: 'declined' });
};

/** The setup texts that the blocks may use: the texts of accepted files, and none after a no or with no acceptance. */
export const renderedTexts = (decision: AcceptanceDecision, setup: CollectedSetup): SetupTexts =>
  decision.kind === 'record' || decision.kind === 'already' ? setup.texts : { coordinator: null, worker: null };

/** The acceptance that `init` writes after the entry in the factory list, or null when the decision writes none. */
export const plannedAcceptance = (
  decision: AcceptanceDecision,
  request: { readonly home: string; readonly node: string; readonly setup: CollectedSetup },
): PlannedAcceptance | null =>
  decision.kind === 'record'
    ? {
        fromInitYes: decision.fromInitYes,
        input: {
          root: request.home,
          node: request.node,
          file: setupAcceptance.setupTextFiles[0],
          entries: request.setup.collected.manifest.entries,
          reason: decision.fromInitYes ? YES_REASON : ACCEPT_REASON,
        },
      }
    : null;

/** The `Deps` whose first question starts with `prefix`: the text that the owner reads before the first answer. */
export const withFirstQuestion = (deps: Deps, prefix: string): Deps => {
  let pending = true;
  return {
    ...deps,
    prompt: (question: string) => {
      const text = pending ? `${printable(prefix)}\n\n${question}` : question;
      pending = false;
      return deps.prompt(text);
    },
  };
};

const askLine = async <T>(
  deps: Deps,
  question: string,
  parse: (text: string) => T | null,
  what: string,
): Promise<CliResult<T | null>> => {
  for (let attempt = 0; attempt < ownerQuestion.maxAttempts; attempt += 1) {
    const answer = await deps.prompt(question);
    if (!answer.ok) return answer;
    if (answer.value.trim() === '') return ok(null);
    const parsed = parse(answer.value.trim());
    if (parsed !== null) return ok(parsed);
  }
  return usageError(`no valid answer for ${what}`, `Pass the flag for ${what}, or run the command again.`);
};

const parseName = (text: string): string | null =>
  text.length <= ownerQuestion.maxNameChars && !CONTROL_CHARACTER.test(text) ? text : null;

interface OwnerFields {
  readonly name: string;
  readonly github: string | undefined;
}

/**
 * The personal values: the flags win, then the answers of the owner in a terminal window, then the defaults from the git
 * identity and the GitHub login. The yes flag takes the defaults without a question.
 */
const ownerFieldsOf = async (deps: Deps, options: InitOptions, ask: boolean): Promise<CliResult<OwnerFields>> => {
  const defaultName = (options.ownerName ?? (await configValue(deps, deps.cwd, 'user.name')) ?? '').trim();
  const defaultGithub = options.ownerGithub ?? (await detectGithubLogin(deps));
  let name = defaultName;
  if (options.ownerName === undefined && ask) {
    const shown = defaultName === '' ? '' : ` [${printable(defaultName)}]`;
    const answer = await askLine(deps, `Your name${shown}: `, parseName, `${roles.owner} name`);
    if (!answer.ok) return answer;
    name = answer.value ?? defaultName;
  }
  if (name === '') {
    return usageError(`no ${roles.owner} name`, `Pass ${flagText(flags.ownerName)} NAME, or set git config user.name.`);
  }
  let github = defaultGithub;
  if (options.ownerGithub === undefined && ask) {
    const shown = defaultGithub === undefined ? '' : ` [${printable(defaultGithub)}]`;
    const answer = await askLine(
      deps,
      `Your GitHub login${shown}: `,
      (text) => (isGithubLogin(text) ? text : null),
      `${roles.owner} GitHub login`,
    );
    if (!answer.ok) return answer;
    github = answer.value ?? defaultGithub;
  }
  return ok({ name, github });
};

/** The flags that name values of a new root, as typed. A factory that is there already has its values in its files. */
export const valueFlagsOf = (options: InitOptions): readonly string[] => [
  ...(options.projects.length > 0 ? [flagText(flags.project)] : []),
  ...(options.name === undefined ? [] : [flagText(flags.name)]),
  ...(options.layer === undefined ? [] : [flagText(flags.layer)]),
  ...(options.recipe === undefined ? [] : [flagText(flags.recipe)]),
];

/** A received factory takes its values from `factory.yaml`. */
const requireFlagsThatApply = (options: InitOptions): CliResult<void> => {
  const given = valueFlagsOf(options);
  return given.length === 0
    ? ok(undefined)
    : usageError(
        `${given.join(', ')}: a received ${places.folder} takes these values from ${files.config}`,
        `Run the command again without ${given.length === 1 ? 'this flag' : 'these flags'}.`,
      );
};

/** The final config: the shared file of the root and the local values of this machine. */
const configOf = (shared: SharedConfig, owner: OwnerFields, approvals: ApprovalChoice): CliResult<FactoryConfig> => {
  const local = localConfigSchema.safeParse(localSettingsOf({ ownerName: owner.name, approvals }, owner.github, {}));
  if (!local.success) return usageError(`invalid settings: ${describeIssues(local.error)}`, 'Check the flags.');
  const merged = mergeConfig(shared, local.data);
  return merged.success ? ok(merged.data) : usageError(`invalid settings: ${describeIssues(merged.error)}`, 'Check the flags.');
};

/** The lines that the owner reads before the first clone: the repos with their URLs, the node id and the shared values. */
const listingOf = (home: string, shared: SharedConfig): readonly string[] => {
  const { node, session, limits } = shared.core;
  const pairs = (values: object): string =>
    Object.entries(values)
      .map(([key, value]) => `${key} ${String(value)}`)
      .join(', ');
  return [
    `Received ${places.folder}: ${home}`,
    `${roles.node} id: ${node.id}`,
    `Shared session values: ${pairs(session)}`,
    `Shared limits: ${pairs(limits)}`,
    ...(shared.recipe.projects.length === 0
      ? ['Projects: none']
      : ['Projects:', ...shared.recipe.projects.map((project) => `  ${project.id}: ${project.url ?? 'no URL'} (folder ${project.path})`)]),
  ];
};

/** A warning for each other root in the factory list that has the same node id. The entry of the root itself is no other root. */
export const sameIdWarnings = async (deps: Deps, indexPath: string, home: string, id: string): Promise<readonly string[]> => {
  const entries = await readHomeIndex(deps, indexPath);
  if (!entries.ok) return [];
  const own = await entryOfHome(deps, entries.value, home);
  return entries.value
    .filter((entry) => entry.id === id && entry !== own)
    .map((entry) => `The ${roles.node} id ${id} is in the ${places.list} for another ${places.folder}: ${entry.home}.`);
};

/** The lines of an acceptance that no answer of the owner backs: the files, the hash, the folder, the node id and the reason. */
export const acceptanceLines = (plan: PlannedAcceptance, accepted: boolean): readonly OutLine[] =>
  accepted && plan.fromInitYes
    ? [
        {
          level: 'text',
          text:
            `${plan.ownText === true ? `Accepted the setup text that ${program} wrote` : `Accepted the setup text with ${flagText(flags.yes)}`}: ` +
            plan.input.entries.map((entry) => entry.path).join(', '),
        },
        { level: 'text', text: `  Hash: ${manifestOf(plan.input.entries).hash}` },
        { level: 'text', text: `  ${places.folder}: ${plan.input.root}` },
        { level: 'text', text: `  ${roles.node} id: ${plan.input.node}` },
        { level: 'text', text: `  Reason: ${plan.input.reason}` },
      ]
    : [];

export const declinedLines = (): readonly OutLine[] => [
  {
    level: 'text',
    text:
      `No setup acceptance was written, and the ${roles.coordinator} text holds no setup block. ` +
      `${initInTerminalWindow()} Until the ${roles.owner} accepts the files, "${commandText(commands.start)}" does not start.`,
  },
];

/**
 * `init` for a received factory. Every check comes before the first question, and every question comes before the first
 * clone and before the first write. A run that fails after a clone removes the clones that it made.
 */
export const runReceived = async (
  deps: Deps,
  options: InitOptions,
  indexPath: string,
  home: string,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  if (inFactorySession(deps)) {
    return safetyRefusal(`"${commandText(commands.init)}" does not register a received ${places.folder} in a ${places.session}`, initInTerminalWindow());
  }
  const tty = deps.stdinIsTTY && deps.stdoutIsTTY;
  if (!options.yes && !tty) {
    return usageError(
      `a received ${places.folder} needs a terminal window to ask for the personal values`,
      `Run "${commandText(commands.init)}" in a terminal window, or pass ${flagText(flags.yes)} to use the defaults.`,
    );
  }
  const applies = requireFlagsThatApply(options);
  if (!applies.ok) return applies;

  const root = await checkReceivedRoot(deps, home, registry);
  if (!root.ok) return root;
  const { shared } = root.value;
  const id = shared.core.node.id;
  const points = shared.entry.approvalPoints;
  const flagged = approvalsFromFlags(deps, options.yes, points, options.approval);
  if (!flagged.ok) return flagged;
  const outside = await checkHomeOutsideRoots(deps, indexPath, home);
  if (!outside.ok) return outside;
  const leftover = await leftoverTempFolders(deps, home);
  if (!leftover.ok) return leftover;
  const projects = await planReceivedProjects(deps, home, shared.recipe.projects, commands.init);
  if (!projects.ok) return projects;
  const setup = await collectSetup(deps, home, root.value.set);
  if (!setup.ok) return setup;

  const listing = listingOf(home, shared);
  const asking = withFirstQuestion(deps, listing.join('\n'));
  const owner = await ownerFieldsOf(asking, options, !options.yes && tty);
  if (!owner.ok) return owner;
  const answered = await askApprovals(asking, options.yes, points, flagged.value);
  if (!answered.ok) return answered;
  const decision = await decideAcceptance(asking, { home, node: id, yes: options.yes, setup: setup.value });
  if (!decision.ok) return decision;

  const planned = await planReceived(deps, {
    home,
    indexPath,
    root: root.value,
    owner: owner.value,
    approvals: answered.value,
    rendered: renderedTexts(decision.value, setup.value),
    acceptance: plannedAcceptance(decision.value, { home, node: id, setup: setup.value }),
    warnings: [
      ...root.value.warnings,
      ...(await sameIdWarnings(deps, indexPath, home, id)),
      ...leftover.value.map(tempFolderWarning),
      ...projects.value.warnings,
    ],
  });
  if (!planned.ok) return planned;

  const cloned = await runClones(deps, projects.value.planned, []);
  if (!cloned.ok) return cloned;
  const applied = await applyInit(deps, planned.value);
  if (!applied.ok) return undoClones(deps, cloned.value, [], applied.error);

  const warnings = [...planned.value.warnings, ...applied.value.warnings];
  const written = [files.localConfig, join(dirs.coordinator, files.claudeMd), `${dirs.state}/`];
  const kept = decision.value.kind === 'declined' ? declinedLines() : [];
  return ok({
    lines: [
      { level: 'text', text: `Registered the received ${roles.node} "${id}" in ${home}.` },
      ...listing.map((line): OutLine => ({ level: 'text', text: line })),
      ...written.map((name): OutLine => ({ level: 'text', text: `  ${name}` })),
      ...cloned.value.map((target): OutLine => ({ level: 'text', text: `Cloned into ${target}.` })),
      ...approvalLines(home, applied.value.approval),
      ...(planned.value.acceptance === null ? [] : acceptanceLines(planned.value.acceptance, applied.value.accepted)),
      ...kept,
      { level: 'text', text: `Next: run "${commandText(commands.doctor)} ${flagText(flags.home)} ${home}".` },
    ],
    json: {
      schema: schemaIds.init,
      home,
      nodeId: id,
      received: true,
      files: written,
      cloned: cloned.value,
      skipped: [],
      committed: applied.value.committed,
      rootCommitted: false,
      approval: applied.value.approval,
      accepted: applied.value.accepted,
      warnings,
    },
    warnings,
    failed: false,
  });
};

interface ReceivedInput {
  readonly home: string;
  readonly indexPath: string;
  readonly root: ReceivedRoot;
  readonly owner: OwnerFields;
  readonly approvals: ApprovalChoice;
  readonly rendered: SetupTexts;
  readonly acceptance: PlannedAcceptance | null;
  readonly warnings: readonly string[];
}

/** The plan for a received root: the local file, the state files and the text of the coordinator folder. Nothing is written. */
const planReceived = async (deps: Deps, input: ReceivedInput): Promise<CliResult<InitPlan>> => {
  const { home, root, owner, approvals } = input;
  // The text of the blocks names the owner for each point until a recorded delegation is read by `upgrade`.
  const forBlocks = configOf(root.shared, owner, NO_APPROVALS);
  if (!forBlocks.ok) return forBlocks;
  const modes = await effectiveModes(deps, home, forBlocks.value);
  const templates = blockTemplatesFor(blockInputOf(forBlocks.value, input.rendered, modes));
  const blocks = await blockTexts(deps, root.layout.claudeMd, templates);
  if (!blocks.ok) return blocks;
  const stateFiles = stateFilesOf(templates, blocks.value.workerText);
  if (!stateFiles.ok) return stateFiles;
  const config = configOf(root.shared, owner, approvals);
  if (!config.ok) return config;
  const texts = renderConfig(config.value);
  const layer = config.value.core.node.layer;
  return ok({
    home,
    received: true,
    acceptance: input.acceptance,
    indexPath: input.indexPath,
    createdRoot: null,
    config: config.value,
    configText: texts.shared,
    localConfigText: texts.local,
    claudeOriginal: blocks.value.original,
    claudeText: blocks.value.claudeText,
    gitignoreOriginal: null,
    gitignoreText: '',
    setupCoordinatorText: null,
    setupWorkerText: null,
    stateFiles: stateFiles.value,
    approvals,
    warnings: [
      ...(config.value.entry.roles.nameForLayer(layer) === null ? [`Layer ${layer} has no role template: ${files.claudeMd} holds the safety block only.`] : []),
      ...input.warnings,
    ],
  });
};
