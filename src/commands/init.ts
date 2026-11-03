import { basename, dirname, join, resolve } from 'node:path';
import { appendBlocks, parseBlocks, renderBlock } from '../blocks/managed.js';
import { failure, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import { isGithubLogin, slugify } from '../config/primitives.js';
import { renderConfig } from '../config/render.js';
import {
  CONFIG_SCHEMA_VERSION,
  COORDINATOR_LAYER,
  LOCAL_SCHEMA_VERSION,
  MAX_LAYER,
  parseConfig,
  type FactoryConfig,
} from '../config/schema.js';
import { checkLocalSource, type OriginClass } from '../core/clone-url.js';
import type { Deps } from '../core/deps.js';
import {
  commitAll,
  configValue,
  defaultBranchOf,
  GIT_ENTRY,
  gitInit,
  hasIdentity,
  initRootRepo,
  MAX_SCAN_ENTRIES,
  parseGithubRepo,
  requireWorkTreeTop,
} from '../core/git.js';
import { indexPathOf, recordNode } from '../core/home-index.js';
import { effectiveModes } from '../core/owner-record.js';
import { missingFolders } from '../core/paths.js';
import { err, ok } from '../core/result.js';
import { requireNoRootLinks } from '../core/root-paths.js';
import { recordSetupAcceptance, type AcceptanceInput } from '../core/setup-acceptance.js';
import { describeIssues } from '../core/zod.js';
import {
  commands,
  commandText,
  defaultOwnerPrefix,
  dirs,
  env,
  files,
  flags,
  flagText,
  keys,
  localFileModes,
  maxFileBytes,
  places,
  roles,
  schemaIds,
  stateKeys,
  values,
} from '../names.js';
import {
  initialBoardText,
  initialDecisionLogText,
  initialWaitingText,
  jsonText,
  sharedRootPaths,
  STATE_GITIGNORE,
  withShareList,
} from '../state/files.js';
import { layoutOf, stagingDirOf, stateRel, type Layout } from '../state/layout.js';
import { nodeStateSchema, STATE_SCHEMA_VERSION } from '../state/schema.js';
import { readSetupFile, renderableSetupText } from '../state/setup-text.js';
import { recipes, type ApprovalModes } from '../recipes/index.js';
import { roleNameForLayer } from '../recipes/software/recipe.js';
import { blockInputOf, blockTemplatesFor, fileTemplates } from '../templates/index.js';
import type { BlockTemplate, SetupTexts } from '../templates/types.js';
import { FACTORY_VERSION } from '../version.js';
import {
  approvalLines,
  approvalsFromFlags,
  askApprovals,
  NO_APPROVALS,
  recordApprovals,
  type ApprovalChoice,
} from './init-approval.js';
import {
  checkProjectCount,
  makeRootFolders,
  planProjects,
  runClones,
  undoClones,
  type PlannedProject,
} from './init-clone.js';
import {
  chooseHome,
  checkHomeIsNew,
  checkHomeOutsideRoots,
  leftoverTempFolders,
  tempFolderWarning,
} from './init-home.js';
import { runReceived } from './init-received.js';
import { oldFolderWarning, originCredentialsWarning, unsharedWarning } from './project-url.js';

export interface InitOptions {
  readonly home: string | undefined;
  readonly name: string | undefined;
  readonly ownerName: string | undefined;
  readonly ownerGithub: string | undefined;
  readonly projects: readonly string[];
  /** Use the proposed home without a question. */
  readonly yes: boolean;
  /** The id of the recipe, as typed. */
  readonly recipe: string | undefined;
  /** The layer of the node, as typed. */
  readonly layer: string | undefined;
  /** The values of the approval flag, as typed: `POINT=MODE`. */
  readonly approval: readonly string[];
}

export interface StateFile {
  readonly rel: string;
  readonly text: string;
}

/** A setup acceptance that `init` writes after the entry in the factory list, and whether the yes flag limits it. */
export interface PlannedAcceptance {
  readonly input: AcceptanceInput;
  /** True when no terminal window answered: the writer then takes a first acceptance of the setup text alone. */
  readonly fromInitYes: boolean;
}

export interface InitPlan {
  readonly home: string;
  /**
   * True for a received factory. The shared file, the root `.gitignore`, the setup texts and the root repo are there
   * already, so init writes none of them and never removes them. The entry in the factory list gets the origin `received`.
   */
  readonly received: boolean;
  /** The setup acceptance that init writes after the entry in the factory list, or null. */
  readonly acceptance: PlannedAcceptance | null;
  /** The file of the factory list. `init` writes the root into it as its last step. */
  readonly indexPath: string;
  /** The topmost folder that init creates (the home or one of its parents), or null when the home exists. */
  readonly createdRoot: string | null;
  readonly config: FactoryConfig;
  /** The text of the shared file. */
  readonly configText: string;
  /** The text of the local file. Init writes it with mode 600. */
  readonly localConfigText: string;
  /** The text of CLAUDE.md in the coordinator folder before init, or null when the file does not exist. */
  readonly claudeOriginal: string | null;
  readonly claudeText: string;
  /** The text of the root `.gitignore` before init, or null when the file does not exist. */
  readonly gitignoreOriginal: string | null;
  /** The text init writes: the share list first, and the lines of the person after it. */
  readonly gitignoreText: string;
  /** The text of `setup/coordinator.md` when init makes the file, or null when the file is there already. */
  readonly setupCoordinatorText: string | null;
  /** The text of `setup/roles/worker.md` when init makes the file, or null when the file is there already. */
  readonly setupWorkerText: string | null;
  readonly stateFiles: readonly StateFile[];
  /** The mode of each approval point, and the points that init records after its last write. */
  readonly approvals: ApprovalChoice;
  /** Things that a person should know before the files are written, for example a layer with no role template. */
  readonly warnings: readonly string[];
}

export interface InitResult {
  /** True when the state repo holds its first commit. */
  readonly committed: boolean;
  /** True when the root repo holds its first commit. */
  readonly rootCommitted: boolean;
  /** The mode that counts for each approval point: a `delegated` point whose record was not written counts as `owner`. */
  readonly approval: ApprovalModes;
  /** True when the setup acceptance was written. */
  readonly accepted: boolean;
  readonly warnings: readonly string[];
}

const GH_TIMEOUT_MS = 10_000;
const DEFAULT_BRANCH = 'main';
const DEFAULT_MODEL = 'default';
const FIRST_COMMIT_MESSAGE = 'chore: initialize the state';
const ROOT_COMMIT_MESSAGE = 'chore: initialize the config repo';

const DEFAULT_LIMITS = {
  [keys.limits.memoryFreeMinPct]: 20,
  [keys.limits.diskFreeMinGb]: 20,
  [keys.limits.loadMax]: values.loadCpuCount,
  [keys.limits.contextPreparePct]: 30,
  [keys.limits.contextMaxPct]: 40,
};

const parseLayer = (text: string | undefined): CliResult<number> => {
  if (text === undefined) return ok(COORDINATOR_LAYER);
  const layer = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  if (layer >= COORDINATOR_LAYER && layer <= MAX_LAYER) return ok(layer);
  return usageError(`${flagText(flags.layer)}: must be a whole number from ${COORDINATOR_LAYER} to ${MAX_LAYER}`);
};

const parseRecipe = (text: string | undefined): CliResult<(typeof values.recipes)[number]> => {
  if (text === undefined) return ok(values.recipes[0]);
  const recipe = values.recipes.find((id) => id === text);
  if (recipe !== undefined) return ok(recipe);
  return usageError(`${flagText(flags.recipe)}: the ${roles.recipe} must be one of: ${values.recipes.join(', ')}`);
};

export const detectGithubLogin = async (deps: Deps): Promise<string | undefined> => {
  const result = await deps.run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok || result.value.exitCode !== 0) return undefined;
  const login = result.value.stdout.trim();
  return isGithubLogin(login) ? login : undefined;
};

/** A project entry as the config holds it, the local source of a project with no URL to share, and the warnings. */
interface DescribedProject {
  readonly project: unknown;
  /** The path of the project: the name of its folder in the root. It is the key of the source in the local file. */
  readonly path: string;
  readonly source: string | null;
  readonly warnings: readonly string[];
}

/** The projects of the command, and the sources of the projects that have no URL to share. */
interface ProjectSettings {
  readonly projects: readonly unknown[];
  readonly sources: Readonly<Record<string, string>>;
}

/** The settings of the projects, and the warnings about them. */
interface DescribedProjects extends ProjectSettings {
  readonly warnings: readonly string[];
}

/**
 * The url of a project comes from the origin of its repo, without any secret. A repo with no origin, or with an origin
 * that the config can not hold (a file URL, a path, a scheme that is not allowed), gets no url: its local source goes
 * into the local file, and a warning says that the factory can not be shared with it.
 */
const urlFieldsOf = (
  origin: OriginClass,
  id: string,
  folder: string,
): { readonly url: string | null; readonly source: string | null; readonly warnings: readonly string[] } => {
  if (origin.kind === 'shareable') {
    return { url: origin.url, source: null, warnings: origin.credentialsRemoved ? [originCredentialsWarning(id)] : [] };
  }
  const source = origin.kind === 'file' ? origin.url : folder;
  // A source that the rules of the local file refuse is not written. The project works in its folder all the same.
  return { url: null, source: checkLocalSource(source).ok ? source : null, warnings: [unsharedWarning(id, 'no-url')] };
};

/**
 * The project entry of a folder in the root. The clone is there already, so the default branch comes from the clone. The
 * url, the GitHub repo and the local source come from the origin of the repo that the clone started from.
 */
const describeProject = async (deps: Deps, planned: PlannedProject): Promise<CliResult<DescribedProject>> => {
  const id = slugify(planned.name);
  if (id === null) return usageError(`cannot make a project id from the folder name ${planned.name}`);
  const repo = planned.origin.kind === 'shareable' ? parseGithubRepo(planned.origin.url) : null;
  const branch = (await defaultBranchOf(deps, planned.target)) ?? DEFAULT_BRANCH;
  const fields = urlFieldsOf(planned.origin, id, planned.oldFolder ?? planned.target);
  return ok({
    project: {
      [keys.project.id]: id,
      ...(fields.url === null ? {} : { [keys.project.url]: fields.url }),
      ...(repo === null ? {} : { [keys.project.repo]: repo }),
      [keys.project.path]: planned.name,
      [keys.project.defaultBranch]: branch,
      [keys.project.mergeMethod]: values.mergeMethods[0],
      [keys.project.gate]: { [keys.gate.checks]: [] },
    },
    path: planned.name,
    source: fields.source,
    warnings: [
      ...fields.warnings,
      ...(planned.oldFolder === null ? [] : [oldFolderWarning(planned.oldFolder, planned.origin.kind !== 'other')]),
    ],
  });
};

const describeProjects = async (deps: Deps, planned: readonly PlannedProject[]): Promise<CliResult<DescribedProjects>> => {
  const counted = checkProjectCount(planned.length);
  if (!counted.ok) return counted;
  const projects: unknown[] = [];
  const sources: (readonly [string, string])[] = [];
  const warnings: string[] = [];
  for (const project of planned) {
    const described = await describeProject(deps, project);
    if (!described.ok) return described;
    projects.push(described.value.project);
    if (described.value.source !== null) sources.push([described.value.path, described.value.source]);
    warnings.push(...described.value.warnings);
  }
  return ok({ projects, sources: Object.fromEntries(sources), warnings });
};

const MAX_PARENT_LEVELS = 64;

const withNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

/** The state files. The worker file exists only when the layer has a worker block. */
export const stateFilesOf = (templates: readonly BlockTemplate[], workerText: string | null): CliResult<readonly StateFile[]> => {
  const state = nodeStateSchema.safeParse({
    [stateKeys.schemaVersion]: STATE_SCHEMA_VERSION,
    [stateKeys.createdWith]: FACTORY_VERSION,
    [stateKeys.blocks]: Object.fromEntries(templates.map((template) => [template.name, template.version])),
  });
  if (!state.success) return failure(`the ${roles.node} state is invalid: ${describeIssues(state.error)}`);
  return ok([
    { rel: stateRel.nodeJson, text: jsonText(state.data) },
    ...(workerText === null ? [] : [{ rel: stateRel.worker, text: workerText }]),
    { rel: stateRel.board, text: initialBoardText() },
    { rel: stateRel.waiting, text: initialWaitingText() },
    { rel: stateRel.decisionLog, text: initialDecisionLogText() },
    { rel: stateRel.profileReadme, text: withNewline(fileTemplates.profileReadme) },
    { rel: stateRel.profileIndex, text: fileTemplates.profileIndex },
    { rel: stateRel.roadmapsReadme, text: fileTemplates.roadmapsReadme },
    { rel: stateRel.ordersKeep, text: '' },
    { rel: stateRel.gitignore, text: STATE_GITIGNORE },
  ]);
};

export interface BlockTexts {
  readonly original: string | null;
  readonly claudeText: string;
  readonly workerText: string | null;
}

/** Render the managed blocks. CLAUDE.md keeps its text, and the blocks go at the end. */
export const blockTexts = async (
  deps: Deps,
  claudePath: string,
  templates: readonly BlockTemplate[],
): Promise<CliResult<BlockTexts>> => {
  const kind = await deps.fs.stat(claudePath);
  if (!kind.ok) return kind;
  if (kind.value !== null && kind.value !== 'file') return failure(`${files.claudeMd} is not a file`);
  let original: string | null = null;
  if (kind.value === 'file') {
    const read = await deps.fs.readText(claudePath);
    if (!read.ok) return read;
    original = read.value;
    const existing = parseBlocks(original);
    if (!existing.ok) return failure(`${files.claudeMd}: ${existing.error.message}`);
    const taken = existing.value.find((block) => templates.some((template) => template.name === block.name));
    if (taken !== undefined) return failure(`${files.claudeMd} already holds the block ${taken.name}`);
  }

  const claudeBlocks: string[] = [];
  const workerBlocks: string[] = [];
  for (const template of templates) {
    const rendered = renderBlock(template);
    if (!rendered.ok) return rendered;
    (template.target === 'claudeFile' ? claudeBlocks : workerBlocks).push(rendered.value);
  }
  return ok({
    original,
    claudeText: appendBlocks(original ?? '', claudeBlocks),
    workerText: workerBlocks.length === 0 ? null : appendBlocks('', workerBlocks),
  });
};

/** The values that a clone does not change. */
interface CheckedValues {
  readonly layer: number;
  readonly recipe: (typeof values.recipes)[number];
  readonly ownerName: string;
  /** The id of the node. */
  readonly id: string;
  /** The mode of each approval point, as the flags and the answers of the owner make it. */
  readonly approvals: ApprovalChoice;
}

/** The checked values, and the texts that follow from them. */
interface CheckedOptions extends CheckedValues {
  readonly templates: readonly BlockTemplate[];
  readonly blocks: BlockTexts;
  readonly root: RootTexts;
}

/** The texts of the root files that init writes besides the config: the `.gitignore` and the setup texts. */
interface RootTexts {
  readonly gitignoreOriginal: string | null;
  readonly gitignoreText: string;
  /** The text init writes to `setup/coordinator.md`, or null when the file is there already. */
  readonly setupCoordinatorText: string | null;
  /** The text init writes to `setup/roles/worker.md`, or null when the file is there already. */
  readonly setupWorkerText: string | null;
  /** The setup texts as the blocks use them: the text of a file that is there, else the text that init writes. */
  readonly setup: SetupTexts;
}

/** The kind of a path that must be a file or a folder, or must not exist. */
const requireKind = async (
  deps: Deps,
  path: string,
  kind: 'file' | 'dir',
  name: string,
): Promise<CliResult<boolean>> => {
  const found = await deps.fs.stat(path);
  if (!found.ok) return found;
  if (found.value !== null && found.value !== kind) {
    return failure(`${name} is not a ${kind === 'dir' ? 'folder' : 'file'}`, 'Move it away, then run the command again.');
  }
  return ok(found.value !== null);
};

/**
 * One setup text. A file that is there keeps its text, and init writes nothing. A file that is absent gets the text of the
 * template, and the blocks use that text. A link, a text that is too large and a text that is not plain are refused.
 */
const setupTextOf = async (
  deps: Deps,
  layout: Layout,
  path: string,
  template: string,
): Promise<CliResult<{ readonly write: string | null; readonly use: string | null }>> => {
  const found = await readSetupFile(deps, layout, path);
  if (!found.ok) return found;
  return ok({ write: found.value === null ? template : null, use: renderableSetupText(found.value ?? template) });
};

/**
 * The root `.gitignore` with the share list, and the setup texts. A `.gitignore` of the person keeps its lines after the
 * share list. A setup text that is there stays as it is. This function writes nothing.
 */
const rootTextsOf = async (deps: Deps, layout: Layout): Promise<CliResult<RootTexts>> => {
  const ignoreExists = await requireKind(deps, layout.gitignoreFile, 'file', files.gitignore);
  if (!ignoreExists.ok) return ignoreExists;
  let original: string | null = null;
  if (ignoreExists.value) {
    const read = await deps.fs.readTextLimited(layout.gitignoreFile, maxFileBytes);
    if (!read.ok) return read;
    original = read.value;
  }
  const withList = withShareList(original);
  if (!withList.ok) {
    return failure(withList.error, `Remove the marker lines from ${files.gitignore}, then run the command again.`);
  }
  const setupExists = await requireKind(deps, layout.setupDir, 'dir', dirs.setup);
  if (!setupExists.ok) return setupExists;
  const rolesExist = setupExists.value
    ? await requireKind(deps, layout.setupRolesDir, 'dir', `${dirs.setup}/${dirs.roles}`)
    : ok(false);
  if (!rolesExist.ok) return rolesExist;
  const coordinator = await setupTextOf(deps, layout, layout.setupCoordinatorFile, fileTemplates.setupCoordinator);
  if (!coordinator.ok) return coordinator;
  const worker = await setupTextOf(deps, layout, layout.setupWorkerFile, fileTemplates.setupWorker);
  if (!worker.ok) return worker;
  return ok({
    gitignoreOriginal: original,
    gitignoreText: withList.value,
    setupCoordinatorText: coordinator.value.write,
    setupWorkerText: worker.value.write,
    setup: { coordinator: coordinator.value.use, worker: worker.value.use },
  });
};

/**
 * The settings of the local file: the owner, no proxy, no worker, the mode of each approval point, and no parent or child.
 * A new root and a received factory write the same file.
 */
export const localSettingsOf = (
  owner: { readonly ownerName: string; readonly approvals: ApprovalChoice },
  github: string | undefined,
  sources: Readonly<Record<string, string>>,
): unknown => ({
  [keys.root.schema]: LOCAL_SCHEMA_VERSION,
  [keys.root.owner]: {
    [keys.owner.display]: owner.ownerName,
    ...(github === undefined ? {} : { [keys.owner.github]: github }),
    [keys.owner.prefix]: defaultOwnerPrefix,
  },
  [keys.root.session]: { [keys.session.proxy]: values.noProxy, [keys.session.statusline]: null },
  [keys.root.proxies]: [],
  [keys.root.workers]: {},
  [keys.root.approval]: owner.approvals.modes,
  [keys.root.parent]: null,
  [keys.root.children]: [],
  [keys.root.sources]: sources,
});

/** The settings of the two config files. The projects are the described projects of the command. */
const settingsOf = (
  checked: CheckedValues,
  github: string | undefined,
  { projects, sources }: ProjectSettings,
): { readonly shared: unknown; readonly local: unknown } => ({
  shared: {
    [keys.root.schema]: CONFIG_SCHEMA_VERSION,
    [keys.root.node]: { [keys.node.id]: checked.id, [keys.node.layer]: checked.layer },
    [keys.root.session]: {
      [keys.session.permissionMode]: values.permissionMode,
      [keys.session.effort]: values.efforts[2],
      [keys.session.model]: DEFAULT_MODEL,
    },
    [keys.root.limits]: DEFAULT_LIMITS,
    [keys.root.tracker]: { [keys.tracker.kind]: values.trackerLocal },
    [keys.root.recipe]: {
      [keys.recipe.id]: checked.recipe,
      [keys.recipe.variant]: values.variants[0],
      [keys.recipe.projects]: projects,
    },
  },
  local: localSettingsOf(checked, github, sources),
});

const parseSettings = (input: { readonly shared: unknown; readonly local: unknown }): CliResult<FactoryConfig> => {
  const parsed = parseConfig(input.shared, input.local);
  return parsed.success
    ? ok(parsed.data)
    : usageError(`invalid settings: ${parsed.file}: ${describeIssues(parsed.error)}`, 'Check the flags.');
};

/**
 * Run every check that needs no project: the home holds no node, the layer, the recipe, the home is outside every
 * root that the factory list holds, the owner name, the node id, the settings with no project, and CLAUDE.md. A bad value
 * is found before any clone runs, because a clone costs time and disk. This function writes nothing.
 */
const checkOptions = async (
  deps: Deps,
  options: InitOptions,
  home: string,
  indexPath: string,
): Promise<CliResult<CheckedOptions>> => {
  // The link rule comes first: a link in the setup folder or the coordinator folder stops the command before any write.
  const plain = await requireNoRootLinks(deps, layoutOf(home));
  if (!plain.ok) return plain;
  const fresh = await checkHomeIsNew(deps, home);
  if (!fresh.ok) return fresh;
  const layer = parseLayer(options.layer);
  if (!layer.ok) return layer;
  const recipe = parseRecipe(options.recipe);
  if (!recipe.ok) return recipe;
  // Every check of the approval flag comes before the first clone and before any write.
  const approvals = approvalsFromFlags(deps, options.yes, recipes[recipe.value].approvalPoints, options.approval);
  if (!approvals.ok) return approvals;
  const outside = await checkHomeOutsideRoots(deps, indexPath, home);
  if (!outside.ok) return outside;
  const ownerName = (options.ownerName ?? (await configValue(deps, deps.cwd, 'user.name')) ?? '').trim();
  if (ownerName === '') {
    return usageError(
      `no ${roles.owner} name`,
      `Pass ${flagText(flags.ownerName)} NAME, or set git config user.name.`,
    );
  }
  const id = options.name ?? slugify(basename(home));
  if (id === null) {
    return usageError(`cannot make a ${roles.node} id from the folder name`, `Pass ${flagText(flags.name)} ID.`);
  }
  const base = { layer: layer.value, recipe: recipe.value, ownerName, id, approvals: approvals.value };
  // The text of the blocks follows the modes of a root that has no record yet, so it names the owner for each point.
  // After a recorded delegation, `upgrade` renders the text again.
  const settings = parseSettings(settingsOf({ ...base, approvals: NO_APPROVALS }, options.ownerGithub, { projects: [], sources: {} }));
  if (!settings.ok) return settings;
  const root = await rootTextsOf(deps, layoutOf(home));
  if (!root.ok) return root;
  const modes = await effectiveModes(deps, home, settings.value);
  const templates = blockTemplatesFor(blockInputOf(settings.value, root.value.setup, modes));
  const blocks = await blockTexts(deps, layoutOf(home).claudeMd, templates);
  if (!blocks.ok) return blocks;
  return ok({ ...base, templates, blocks: blocks.value, root: root.value });
};

/**
 * The place of the factory list. `init` writes the root into the list as its last step, so a command without that place
 * stops before it writes anything (exit 1).
 */
const requireIndexPath = async (deps: Deps): Promise<CliResult<string>> => {
  const indexPath = await indexPathOf(deps);
  if (!indexPath.ok) return indexPath;
  if (indexPath.value !== null) return ok(indexPath.value);
  return failure(
    `the ${places.list} has no place: ${env.stateHome} and ${env.userHome} name no folder`,
    `Set ${env.stateHome} or ${env.userHome} to an absolute folder, then run "${commandText(commands.init)}" again.`,
  );
};

/** Read the system and decide what init writes. This function writes nothing. */
export const planInit = async (deps: Deps, options: InitOptions): Promise<CliResult<InitPlan>> => {
  const indexPath = await requireIndexPath(deps);
  if (!indexPath.ok) return indexPath;
  const home = resolve(deps.cwd, options.home ?? '.');
  const checked = await checkOptions(deps, options, home, indexPath.value);
  if (!checked.ok) return checked;
  const planned = await planProjects(deps, home, options.projects);
  if (!planned.ok) return planned;
  return planChecked(deps, options, checked.value, indexPath.value, planned.value);
};

/**
 * The plan, after the checks have passed. The clones are there now, so this function describes the projects.
 * The root and the folders above it exist when a clone needed them.
 */
const planChecked = async (
  deps: Deps,
  options: InitOptions,
  checked: CheckedOptions,
  indexPath: string,
  planned: readonly PlannedProject[],
): Promise<CliResult<InitPlan>> => {
  const { layer, templates, blocks, root } = checked;
  const home = resolve(deps.cwd, options.home ?? '.');

  const missing = await missingFolders(deps, home);
  if (!missing.ok) return missing;
  // A temp folder of a stopped init is a warning. This run removes nothing.
  const leftover = await leftoverTempFolders(deps, home);
  if (!leftover.ok) return leftover;
  const github = options.ownerGithub ?? (await detectGithubLogin(deps));

  const projects = await describeProjects(deps, planned);
  if (!projects.ok) return projects;

  const config = parseSettings(settingsOf(checked, github, projects.value));
  if (!config.ok) return config;
  const stateFiles = stateFilesOf(templates, blocks.workerText);
  if (!stateFiles.ok) return stateFiles;

  const texts = renderConfig(config.value);
  return ok({
    home,
    received: false,
    acceptance: null,
    indexPath,
    createdRoot: missing.value.at(-1) ?? null,
    config: config.value,
    configText: texts.shared,
    localConfigText: texts.local,
    claudeOriginal: blocks.original,
    claudeText: blocks.claudeText,
    gitignoreOriginal: root.gitignoreOriginal,
    gitignoreText: root.gitignoreText,
    setupCoordinatorText: root.setupCoordinatorText,
    setupWorkerText: root.setupWorkerText,
    stateFiles: stateFiles.value,
    approvals: checked.approvals,
    warnings: [
      ...(roleNameForLayer(layer) === null
        ? [`Layer ${layer} has no role template: ${files.claudeMd} holds the safety block only.`]
        : []),
      ...leftover.value.map(tempFolderWarning),
      ...projects.value.warnings,
    ],
  });
};

/** The folders that init creates, from the home up to the topmost one, so the deepest folder comes first. */
const createdFolders = (home: string, createdRoot: string | null): readonly string[] => {
  const folders: string[] = [];
  if (createdRoot === null) return folders;
  let current = home;
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    folders.push(current);
    const parent = dirname(current);
    if (current === createdRoot || parent === current) break;
    current = parent;
  }
  return folders;
};

/** The mode of a file that the config repo shares. */
const SHARED_FILE_MODE = 0o644;

/**
 * Write the node: first into a staging folder, then the state folder, the coordinator folder with its CLAUDE.md, the
 * setup text and the root `.gitignore`, the local file, the shared config file, the root repo, and last the entry in the
 * factory list. A step that fails undoes the steps before it, and the command exits 1. The approval records and the setup
 * acceptance come after the entry in the factory list, and a record that fails is a warning, not a failure of the run.
 * For a received factory the plan says `received`: the shared file, the root `.gitignore`, the setup texts and the root
 * repo are there already, so those steps are left out, and the undo never touches them.
 * Before each write, init checks whether the target is there. The record `touched` marks a path only when this run makes
 * it, so the undo never removes a path that was there before. A text that init changed in place (`CLAUDE.md` and
 * `.gitignore`) is written back as it was.
 */
export const applyInit = async (deps: Deps, plan: InitPlan): Promise<CliResult<InitResult>> => {
  const layout = layoutOf(plan.home);
  const staging = stagingDirOf(plan.home, deps.pid);
  const touched = {
    state: false,
    coordinatorDir: false,
    claude: false,
    setupDir: false,
    setupFile: false,
    setupRolesDir: false,
    setupWorkerFile: false,
    gitignore: false,
    local: false,
    config: false,
    rootGit: false,
    /** The folders above the factory list that the write of the list can make, the deepest first. */
    listFolders: [] as readonly string[],
  };

  /** Make a folder. The result is true when this run made it, and false when the folder was there. */
  const makeFolder = async (folder: string): Promise<CliResult<boolean>> => {
    const kind = await deps.fs.stat(folder);
    if (!kind.ok) return kind;
    const made = await deps.fs.mkdir(folder);
    return made.ok ? ok(kind.value === null) : made;
  };

  /** A path that init must make is not there. A path that another program made during the run is never replaced. */
  const requireAbsent = async (path: string, name: string): Promise<CliResult<void>> => {
    const kind = await deps.fs.stat(path);
    if (!kind.ok) return kind;
    return kind.value === null ? ok(undefined) : failure(`${name} was made by another program during the run`);
  };

  /**
   * A text that init changes in place is still the text that the plan read: absent when the plan found no file, else
   * equal to it. A file that another program made or changed during the run is never replaced.
   */
  const requireUnchanged = async (path: string, planned: string | null, name: string): Promise<CliResult<void>> => {
    const kind = await deps.fs.stat(path);
    if (!kind.ok) return kind;
    let unchanged = kind.value === null && planned === null;
    if (kind.value === 'file' && planned !== null) {
      const read = await deps.fs.readTextLimited(path, maxFileBytes);
      if (!read.ok) return read;
      unchanged = read.value === planned;
    }
    return unchanged ? ok(undefined) : failure(`${name} was made or changed by another program during the run`);
  };

  /** Undo only what this run made. A step that fails is named in the message. */
  const rollback = async (cause: CliError): Promise<CliResult<InitResult>> => {
    const problems: string[] = [];
    const undo = async (step: Promise<CliResult<void>>): Promise<void> => {
      const result = await step;
      if (!result.ok) problems.push(result.error.message);
    };
    for (const folder of touched.listFolders) await undo(deps.fs.removeEmptyDir(folder));
    await undo(deps.fs.remove(staging));
    if (touched.rootGit) await undo(deps.fs.remove(join(plan.home, GIT_ENTRY)));
    if (touched.config) await undo(deps.fs.remove(layout.configFile));
    if (touched.local) await undo(deps.fs.remove(layout.localConfigFile));
    if (touched.gitignore) {
      await undo(
        plan.gitignoreOriginal === null
          ? deps.fs.remove(layout.gitignoreFile)
          : deps.fs.writeTextAtomic(layout.gitignoreFile, plan.gitignoreOriginal),
      );
    }
    if (touched.setupWorkerFile) await undo(deps.fs.remove(layout.setupWorkerFile));
    if (touched.setupRolesDir) await undo(deps.fs.removeEmptyDir(layout.setupRolesDir));
    if (touched.setupFile) await undo(deps.fs.remove(layout.setupCoordinatorFile));
    if (touched.setupDir) await undo(deps.fs.removeEmptyDir(layout.setupDir));
    if (touched.claude) {
      await undo(
        plan.claudeOriginal === null
          ? deps.fs.remove(layout.claudeMd)
          : deps.fs.writeTextAtomic(layout.claudeMd, plan.claudeOriginal),
      );
    }
    if (touched.coordinatorDir) await undo(deps.fs.removeEmptyDir(layout.coordinatorDir));
    if (touched.state) await undo(deps.fs.remove(layout.stateDir));
    for (const folder of createdFolders(plan.home, plan.createdRoot)) await undo(deps.fs.removeEmptyDir(folder));
    return err({
      ...cause,
      message:
        problems.length === 0
          ? `${cause.message} (nothing was changed)`
          : `${cause.message}. These steps of the undo failed, so some changes stay: ${problems.join('; ')}.`,
    });
  };

  // The link rule is checked once more before the first write, because the clones before this step take time.
  const plain = await requireNoRootLinks(deps, layout);
  if (!plain.ok) return plain;

  const cleared = await deps.fs.remove(staging);
  if (!cleared.ok) return rollback(cleared.error);
  for (const file of plan.stateFiles) {
    const target = join(staging, file.rel);
    const folder = await deps.fs.mkdir(dirname(target));
    if (!folder.ok) return rollback(folder.error);
    const written = await deps.fs.writeText(target, file.text);
    if (!written.ok) return rollback(written.error);
  }

  const initialized = await gitInit(deps, staging);
  if (!initialized.ok) return rollback(initialized.error);
  // The staging folder can sit in a folder of a repo (the root repo of a received factory). A commit must go to the repo of
  // the state folder, so every git write in it waits until the folder is the top of its own work tree.
  const stateTop = await requireWorkTreeTop(deps, staging, dirs.state);
  if (!stateTop.ok) return rollback(stateTop.error);
  const identity = await hasIdentity(deps, staging);
  if (identity) {
    const committed = await commitAll(deps, staging, FIRST_COMMIT_MESSAGE);
    if (!committed.ok) return rollback(committed.error);
  }

  const stateAbsent = await requireAbsent(layout.stateDir, dirs.state);
  if (!stateAbsent.ok) return rollback(stateAbsent.error);
  const moved = await deps.fs.rename(staging, layout.stateDir);
  if (!moved.ok) return rollback(moved.error);
  touched.state = true;

  const coordinatorDir = await makeFolder(layout.coordinatorDir);
  if (!coordinatorDir.ok) return rollback(coordinatorDir.error);
  touched.coordinatorDir = coordinatorDir.value;
  const claudeUnchanged = await requireUnchanged(layout.claudeMd, plan.claudeOriginal, `${dirs.coordinator}/${files.claudeMd}`);
  if (!claudeUnchanged.ok) return rollback(claudeUnchanged.error);
  const claude = await deps.fs.writeTextAtomic(layout.claudeMd, plan.claudeText);
  if (!claude.ok) return rollback(claude.error);
  touched.claude = true;

  // The setup texts are the texts that a person shares. A file that is there already keeps its text.
  if (plan.setupCoordinatorText !== null || plan.setupWorkerText !== null) {
    const setupDir = await makeFolder(layout.setupDir);
    if (!setupDir.ok) return rollback(setupDir.error);
    touched.setupDir = setupDir.value;
  }
  if (plan.setupCoordinatorText !== null) {
    const setup = await deps.fs.writeTextExclusive(layout.setupCoordinatorFile, plan.setupCoordinatorText, SHARED_FILE_MODE);
    if (!setup.ok) return rollback(setup.error);
    if (!setup.value) {
      return rollback(failure(`${join(dirs.setup, files.setupCoordinator)} was made by another program during the run`).error);
    }
    touched.setupFile = true;
  }
  if (plan.setupWorkerText !== null) {
    const rolesDir = await makeFolder(layout.setupRolesDir);
    if (!rolesDir.ok) return rollback(rolesDir.error);
    touched.setupRolesDir = rolesDir.value;
    const setup = await deps.fs.writeTextExclusive(layout.setupWorkerFile, plan.setupWorkerText, SHARED_FILE_MODE);
    if (!setup.ok) return rollback(setup.error);
    if (!setup.value) {
      return rollback(failure(`${join(dirs.setup, dirs.roles, files.worker)} was made by another program during the run`).error);
    }
    touched.setupWorkerFile = true;
  }

  if (!plan.received) {
    const gitignoreUnchanged = await requireUnchanged(layout.gitignoreFile, plan.gitignoreOriginal, files.gitignore);
    if (!gitignoreUnchanged.ok) return rollback(gitignoreUnchanged.error);
    const gitignore = await deps.fs.writeTextAtomic(layout.gitignoreFile, plan.gitignoreText);
    if (!gitignore.ok) return rollback(gitignore.error);
    touched.gitignore = true;
  }

  // The local file comes before the shared file, which marks the home as a node. The local file has mode 600 from the start.
  // A local file or a shared file that is there already is never replaced, and the undo never removes it.
  const localAbsent = await requireAbsent(layout.localConfigFile, files.localConfig);
  if (!localAbsent.ok) return rollback(localAbsent.error);
  const local = await deps.fs.writeTextAtomic(layout.localConfigFile, plan.localConfigText, localFileModes.private);
  if (!local.ok) return rollback(local.error);
  touched.local = true;

  // A received factory has its shared file and its root repo already: init never writes or removes them.
  let rootCommitted = false;
  if (!plan.received) {
    const configAbsent = await requireAbsent(layout.configFile, files.config);
    if (!configAbsent.ok) return rollback(configAbsent.error);
    const config = await deps.fs.writeTextAtomic(layout.configFile, plan.configText);
    if (!config.ok) return rollback(config.error);
    touched.config = true;

    // A git folder that was there before the run is never removed. `initRootRepo` refuses to use it.
    const gitFolder = await deps.fs.stat(join(plan.home, GIT_ENTRY));
    if (!gitFolder.ok) return rollback(gitFolder.error);
    touched.rootGit = gitFolder.value === null;
    const rootRepo = await initRootRepo(deps, plan.home, {
      paths: sharedRootPaths,
      message: ROOT_COMMIT_MESSAGE,
      branch: DEFAULT_BRANCH,
    });
    if (!rootRepo.ok) return rollback(rootRepo.error);
    rootCommitted = rootRepo.value.committed;
  }

  // The entry in the factory list is the last step. When it fails, the root is not registered, so init undoes its work,
  // and also the folders of the list that the write made.
  const listFolders = await missingFolders(deps, dirname(plan.indexPath));
  if (!listFolders.ok) return rollback(listFolders.error);
  touched.listFolders = listFolders.value;
  // A root that this run makes is the own root of the user. A received factory is always received, also when an old entry
  // of the folder says own.
  const recorded = await recordNode(deps, plan.indexPath, {
    home: plan.home,
    id: plan.config.core.node.id,
    projects: plan.config.recipe.projects.map((project) => project.path),
    origin: plan.received ? 'received' : 'own',
    newRoot: !plan.received,
  });
  if (!recorded.ok) {
    return rollback(
      failure(recorded.error, `Fix the cause, then run "${commandText(commands.init)}" again. A second run works in the same folder.`)
        .error,
    );
  }

  // The records come after the entry in the factory list, so a run that fails leaves no record. A record that cannot be
  // written is a warning: the run keeps its work, and the point counts as `owner`.
  const approvals = await recordApprovals(
    deps,
    plan.home,
    plan.config.core.node.id,
    recipes[plan.config.recipe.id].approvalPoints,
    plan.approvals,
  );
  // The setup acceptance comes last for the same reason. A write that fails is a warning: the run keeps its work, and
  // `start` stops until the owner accepts the files.
  const accepted = await recordAcceptance(deps, plan);

  return ok({
    committed: identity,
    rootCommitted,
    approval: approvals.modes,
    accepted: accepted.accepted,
    warnings: [
      ...(identity
        ? []
        : [
            `No git identity: the first commit of ${dirs.state} was not made. ` +
              'Set user.name and user.email, then commit there.',
          ]),
      ...(rootCommitted || plan.received
        ? []
        : ['No git identity: the first commit of the config repo was not made. Set user.name and user.email, then commit there.']),
      ...approvals.warnings,
      ...accepted.warnings,
    ],
  });
};

/** Write the setup acceptance of the plan through its writer. A write that fails gives a warning and no acceptance. */
const recordAcceptance = async (
  deps: Deps,
  plan: InitPlan,
): Promise<{ readonly accepted: boolean; readonly warnings: readonly string[] }> => {
  if (plan.acceptance === null) return { accepted: false, warnings: [] };
  const written = await recordSetupAcceptance(
    deps,
    plan.acceptance.input,
    plan.acceptance.fromInitYes ? { fromInitYes: true } : {},
  );
  return written.ok
    ? { accepted: true, warnings: [] }
    : {
        accepted: false,
        warnings: [
          `The setup acceptance was not written (${written.error.message}). ` +
            `Run "${commandText(commands.init)}" in a terminal window to accept the files.`,
        ],
      };
};

/** The projects of the command: the git work trees that the command found come first, when the home is proposed. */
const projectsOf = (deps: Deps, flagValues: readonly string[], found: readonly string[]): readonly string[] => [
  ...found,
  ...flagValues.filter((argument) => !found.includes(resolve(deps.cwd, argument))),
];

export const runInit = async (deps: Deps, options: InitOptions): Promise<CliResult<CommandOutput>> => {
  // The place of the factory list is checked before init writes anything.
  const indexPath = await requireIndexPath(deps);
  if (!indexPath.ok) return indexPath;
  const chosen = await chooseHome(deps, options);
  if (!chosen.ok) return chosen;
  const { home, found, skipped, truncated } = chosen.value;
  // A factory that arrived goes its own way: the home holds `factory.yaml` and no local file.
  if (chosen.value.received) return runReceived(deps, options, indexPath.value, home);

  // A bad value must give its error before any clone runs, because a clone costs time and disk.
  const checked = await checkOptions(deps, options, home, indexPath.value);
  if (!checked.ok) return checked;
  // The questions come after the checks, so a refused run asks nothing, and before the first clone.
  const asked = await askApprovals(
    deps,
    options.yes,
    recipes[checked.value.recipe].approvalPoints,
    checked.value.approvals,
  );
  if (!asked.ok) return asked;
  const answered: CheckedOptions = { ...checked.value, approvals: asked.value };

  // The clones come before the plan, because the plan reads each project. Every check of the paths of the projects
  // comes before the first clone. When a later step fails, the clones that this run made are removed again.
  // A folder that was there before the run is never removed.
  const projects = await planProjects(deps, home, projectsOf(deps, options.projects, found));
  if (!projects.ok) return projects;
  // Git makes the folders above a clone by itself. This run makes the root and its parents first, so that the undo can
  // remove them.
  const parents = projects.value.some((project) => !project.present) ? await makeRootFolders(deps, home) : ok([]);
  if (!parents.ok) return parents;
  const cloned = await runClones(deps, projects.value, parents.value);
  if (!cloned.ok) return cloned;
  const made = cloned.value;

  const plan = await planChecked(deps, { ...options, home }, answered, indexPath.value, projects.value);
  if (!plan.ok) return undoClones(deps, made, parents.value, plan.error);
  const applied = await applyInit(deps, plan.value);
  if (!applied.ok) return undoClones(deps, made, parents.value, applied.error);
  const notes = truncated ? [`Only the first ${MAX_SCAN_ENTRIES} entries of ${deps.cwd} were read.`] : [];
  const warnings = [...plan.value.warnings, ...applied.value.warnings, ...notes];

  const written = [
    files.config,
    files.localConfig,
    files.gitignore,
    ...(plan.value.setupCoordinatorText === null ? [] : [join(dirs.setup, files.setupCoordinator)]),
    ...(plan.value.setupWorkerText === null ? [] : [join(dirs.setup, dirs.roles, files.worker)]),
    join(dirs.coordinator, files.claudeMd),
    `${dirs.state}/`,
  ];
  return ok({
    lines: [
      { level: 'text', text: `Created the ${roles.node} "${plan.value.config.core.node.id}" in ${plan.value.home}.` },
      ...written.map((name) => ({ level: 'text' as const, text: `  ${name}` })),
      ...made.map((target) => ({ level: 'text' as const, text: `Cloned into ${target}.` })),
      ...skipped.map((folder) => ({ level: 'text' as const, text: `Skipped ${folder.path}: ${folder.reason}.` })),
      ...approvalLines(plan.value.home, applied.value.approval),
      {
        level: 'text',
        text: `Next: run "${commandText(commands.doctor)} ${flagText(flags.home)} ${plan.value.home}".`,
      },
    ],
    json: {
      schema: schemaIds.init,
      home: plan.value.home,
      nodeId: plan.value.config.core.node.id,
      files: written,
      cloned: made,
      skipped,
      committed: applied.value.committed,
      rootCommitted: applied.value.rootCommitted,
      approval: applied.value.approval,
      warnings,
    },
    warnings,
    failed: false,
  });
};
