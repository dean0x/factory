import { basename, dirname, join, relative, resolve } from 'node:path';
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
import { checkLocalSource, classifyOrigin, type OriginClass } from '../core/clone-url.js';
import type { Deps } from '../core/deps.js';
import {
  commitAll,
  configValue,
  defaultBranchOf,
  githubRepoOf,
  gitInit,
  hasIdentity,
  isWorkTreeRoot,
  MAX_SCAN_ENTRIES,
  originUrlOf,
} from '../core/git.js';
import { indexPathOf, recordNode } from '../core/home-index.js';
import { missingFolders, realPathOf } from '../core/paths.js';
import { err, ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import {
  commands,
  commandText,
  defaultOwnerPrefix,
  dirs,
  files,
  flags,
  flagText,
  keys,
  localFileModes,
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
  STATE_GITIGNORE,
} from '../state/files.js';
import { layoutOf, stagingDirOf, stateRel } from '../state/layout.js';
import { nodeStateSchema, STATE_SCHEMA_VERSION } from '../state/schema.js';
import { ownerModes, recipes } from '../recipes/index.js';
import { roleNameForLayer } from '../recipes/software/recipe.js';
import { blockTemplatesFor, fileTemplates } from '../templates/index.js';
import type { BlockTemplate } from '../templates/types.js';
import { FACTORY_VERSION } from '../version.js';
import { checkProjectCount, makeCloneParents, planProjects, runClones, undoClones } from './init-clone.js';
import { chooseHome, checkHomeApart, checkHomeHoldsNoRepo, checkHomeIsNew, checkHomeLocation } from './init-home.js';
import { originCredentialsWarning, unsharedWarning } from './project-url.js';

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
}

interface StateFile {
  readonly rel: string;
  readonly text: string;
}

export interface InitPlan {
  readonly home: string;
  /** The topmost folder that init creates (the home or one of its parents), or null when the home exists. */
  readonly createdRoot: string | null;
  readonly config: FactoryConfig;
  /** The text of the shared file. */
  readonly configText: string;
  /** The text of the local file. Init writes it with mode 600. */
  readonly localConfigText: string;
  /** The text of CLAUDE.md before init, or null when the file does not exist. */
  readonly claudeOriginal: string | null;
  readonly claudeText: string;
  readonly stateFiles: readonly StateFile[];
  /** Things that a person should know before the files are written, for example a layer with no role template. */
  readonly warnings: readonly string[];
}

export interface InitResult {
  readonly committed: boolean;
  readonly warnings: readonly string[];
}

const GH_TIMEOUT_MS = 10_000;
const DEFAULT_BRANCH = 'main';
const DEFAULT_MODEL = 'default';
const FIRST_COMMIT_MESSAGE = 'chore: initialize the state';

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

const detectGithubLogin = async (deps: Deps): Promise<string | undefined> => {
  const result = await deps.run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok || result.value.exitCode !== 0) return undefined;
  const login = result.value.stdout.trim();
  return isGithubLogin(login) ? login : undefined;
};

/** A project entry as the config holds it, the local source of a project with no URL to share, and the warnings. */
interface DescribedProject {
  readonly project: unknown;
  /** The path of the project. It is the key of the source in the local file. */
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

/** The project path is relative to the home. Both paths have their links resolved, as git gives the work tree. */
const describeProject = async (
  deps: Deps,
  realHome: string,
  argument: string,
): Promise<CliResult<DescribedProject>> => {
  const absolute = resolve(deps.cwd, argument);
  if (!(await isWorkTreeRoot(deps, absolute))) {
    return usageError(`${argument} is not the top folder of a git work tree`);
  }
  const id = slugify(basename(absolute));
  if (id === null) return usageError(`cannot make a project id from the folder name of ${argument}`);
  const real = await realPathOf(deps, absolute);
  if (!real.ok) return real;
  const repo = await githubRepoOf(deps, absolute);
  const branch = (await defaultBranchOf(deps, absolute)) ?? DEFAULT_BRANCH;
  const fields = urlFieldsOf(classifyOrigin(await originUrlOf(deps, absolute)), id, real.value);
  const path = relative(realHome, real.value) || '.';
  return ok({
    project: {
      [keys.project.id]: id,
      ...(fields.url === null ? {} : { [keys.project.url]: fields.url }),
      ...(repo === null ? {} : { [keys.project.repo]: repo }),
      [keys.project.path]: path,
      [keys.project.defaultBranch]: branch,
      [keys.project.mergeMethod]: values.mergeMethods[0],
      [keys.project.gate]: { [keys.gate.checks]: [] },
    },
    path,
    source: fields.source,
    warnings: fields.warnings,
  });
};

const describeProjects = async (
  deps: Deps,
  home: string,
  arguments_: readonly string[],
): Promise<CliResult<DescribedProjects>> => {
  const counted = checkProjectCount(arguments_.length);
  if (!counted.ok) return counted;
  const realHome = await realPathOf(deps, home);
  if (!realHome.ok) return realHome;
  const projects: unknown[] = [];
  const sources: (readonly [string, string])[] = [];
  const warnings: string[] = [];
  for (const argument of arguments_) {
    const described = await describeProject(deps, realHome.value, argument);
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
const stateFilesOf = (templates: readonly BlockTemplate[], workerText: string | null): CliResult<readonly StateFile[]> => {
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

interface BlockTexts {
  readonly original: string | null;
  readonly claudeText: string;
  readonly workerText: string | null;
}

/** Render the managed blocks. CLAUDE.md keeps its text, and the blocks go at the end. */
const blockTexts = async (
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
}

/** The checked values, and the texts that follow from them. */
interface CheckedOptions extends CheckedValues {
  readonly templates: readonly BlockTemplate[];
  readonly blocks: BlockTexts;
}

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
  local: {
    [keys.root.schema]: LOCAL_SCHEMA_VERSION,
    [keys.root.owner]: {
      [keys.owner.display]: checked.ownerName,
      ...(github === undefined ? {} : { [keys.owner.github]: github }),
      [keys.owner.prefix]: defaultOwnerPrefix,
    },
    [keys.root.session]: { [keys.session.proxy]: values.noProxy, [keys.session.statusline]: null },
    [keys.root.proxies]: [],
    [keys.root.workers]: {},
    [keys.root.approval]: {},
    [keys.root.parent]: null,
    [keys.root.children]: [],
    [keys.root.sources]: sources,
  },
});

const parseSettings = (input: { readonly shared: unknown; readonly local: unknown }): CliResult<FactoryConfig> => {
  const parsed = parseConfig(input.shared, input.local);
  return parsed.success
    ? ok(parsed.data)
    : usageError(`invalid settings: ${parsed.file}: ${describeIssues(parsed.error)}`, 'Check the flags.');
};

/**
 * Run every check that needs no project: the home holds no node, the layer, the recipe, the home location, the owner
 * name, the node id, the settings with no project, and CLAUDE.md. A bad value is found before any clone runs,
 * because a clone costs time and disk. This function writes nothing.
 */
const checkOptions = async (deps: Deps, options: InitOptions, home: string): Promise<CliResult<CheckedOptions>> => {
  const fresh = await checkHomeIsNew(deps, home);
  if (!fresh.ok) return fresh;
  const layer = parseLayer(options.layer);
  if (!layer.ok) return layer;
  const recipe = parseRecipe(options.recipe);
  if (!recipe.ok) return recipe;
  const location = await checkHomeLocation(deps, home);
  if (!location.ok) return location;
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
  const base = { layer: layer.value, recipe: recipe.value, ownerName, id };
  const settings = parseSettings(settingsOf(base, options.ownerGithub, { projects: [], sources: {} }));
  if (!settings.ok) return settings;
  const templates = blockTemplatesFor(layer.value, ownerModes(recipes[recipe.value].approvalPoints));
  const blocks = await blockTexts(deps, layoutOf(home).claudeMd, templates);
  if (!blocks.ok) return blocks;
  return ok({ ...base, templates, blocks: blocks.value });
};

/**
 * The home is apart from the projects, and it holds no git repo one level down. Both checks need only the paths
 * of the projects, so a clone target counts before the clone is made.
 */
const checkHomeBesideProjects = async (
  deps: Deps,
  home: string,
  projects: readonly string[],
): Promise<CliResult<void>> => {
  const apart = await checkHomeApart(
    deps,
    home,
    projects.map((argument) => resolve(deps.cwd, argument)),
  );
  if (!apart.ok) return apart;
  return checkHomeHoldsNoRepo(deps, home);
};

/** Read the system and decide what init writes. This function writes nothing. */
export const planInit = async (deps: Deps, options: InitOptions): Promise<CliResult<InitPlan>> => {
  const home = resolve(deps.cwd, options.home ?? '.');
  const checked = await checkOptions(deps, options, home);
  if (!checked.ok) return checked;
  const beside = await checkHomeBesideProjects(deps, home, options.projects);
  if (!beside.ok) return beside;
  return planChecked(deps, options, checked.value);
};

/**
 * The plan, after the checks have passed. The clones are there now, so this function describes the projects.
 * The folders above the home exist when a clone needed them.
 */
const planChecked = async (deps: Deps, options: InitOptions, checked: CheckedOptions): Promise<CliResult<InitPlan>> => {
  const { layer, templates, blocks } = checked;
  const home = resolve(deps.cwd, options.home ?? '.');

  const missing = await missingFolders(deps, home);
  if (!missing.ok) return missing;
  const github = options.ownerGithub ?? (await detectGithubLogin(deps));

  const projects = await describeProjects(deps, home, options.projects);
  if (!projects.ok) return projects;

  const config = parseSettings(settingsOf(checked, github, projects.value));
  if (!config.ok) return config;
  const stateFiles = stateFilesOf(templates, blocks.workerText);
  if (!stateFiles.ok) return stateFiles;

  const texts = renderConfig(config.value);
  return ok({
    home,
    createdRoot: missing.value.at(-1) ?? null,
    config: config.value,
    configText: texts.shared,
    localConfigText: texts.local,
    claudeOriginal: blocks.original,
    claudeText: blocks.claudeText,
    stateFiles: stateFiles.value,
    warnings: [
      ...(roleNameForLayer(layer) === null
        ? [`Layer ${layer} has no role template: ${files.claudeMd} holds the safety block only.`]
        : []),
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

/** Write the node: first into a staging folder, then the state folder, then CLAUDE.md, and the config file last. */
export const applyInit = async (deps: Deps, plan: InitPlan): Promise<CliResult<InitResult>> => {
  const layout = layoutOf(plan.home);
  const staging = stagingDirOf(plan.home, deps.pid);
  const touched = { state: false, claude: false, local: false, config: false };

  /** Undo only what this run made. A step that fails is named in the message. */
  const rollback = async (cause: CliError): Promise<CliResult<InitResult>> => {
    const problems: string[] = [];
    const undo = async (step: Promise<CliResult<void>>): Promise<void> => {
      const result = await step;
      if (!result.ok) problems.push(result.error.message);
    };
    await undo(deps.fs.remove(staging));
    if (touched.state) await undo(deps.fs.remove(layout.stateDir));
    if (touched.claude) {
      await undo(
        plan.claudeOriginal === null
          ? deps.fs.remove(layout.claudeMd)
          : deps.fs.writeTextAtomic(layout.claudeMd, plan.claudeOriginal),
      );
    }
    if (touched.config) await undo(deps.fs.remove(layout.configFile));
    if (touched.local) await undo(deps.fs.remove(layout.localConfigFile));
    for (const folder of createdFolders(plan.home, plan.createdRoot)) await undo(deps.fs.removeEmptyDir(folder));
    return err({
      ...cause,
      message:
        problems.length === 0
          ? `${cause.message} (nothing was changed)`
          : `${cause.message}. These steps of the undo failed, so some changes stay: ${problems.join('; ')}.`,
    });
  };

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
  const identity = await hasIdentity(deps, staging);
  if (identity) {
    const committed = await commitAll(deps, staging, FIRST_COMMIT_MESSAGE);
    if (!committed.ok) return rollback(committed.error);
  }

  const moved = await deps.fs.rename(staging, layout.stateDir);
  if (!moved.ok) return rollback(moved.error);
  touched.state = true;

  const claude = await deps.fs.writeTextAtomic(layout.claudeMd, plan.claudeText);
  if (!claude.ok) return rollback(claude.error);
  touched.claude = true;

  // The local file comes before the shared file, which marks the home as a node. The local file has mode 600 from the start.
  const local = await deps.fs.writeTextAtomic(layout.localConfigFile, plan.localConfigText, localFileModes.private);
  if (!local.ok) return rollback(local.error);
  touched.local = true;

  const config = await deps.fs.writeTextAtomic(layout.configFile, plan.configText);
  if (!config.ok) return rollback(config.error);
  touched.config = true;

  return ok({
    committed: identity,
    warnings: identity
      ? []
      : [
          `No git identity: the first commit of ${dirs.state} was not made. ` +
            'Set user.name and user.email, then commit there.',
        ],
  });
};

/** The projects of the command: the git work trees that the command found come first, when the home is proposed. */
const projectsOf = (deps: Deps, paths: readonly string[], found: readonly string[]): readonly string[] => [
  ...found,
  ...paths.filter((argument) => !found.includes(resolve(deps.cwd, argument))),
];

export const runInit = async (deps: Deps, options: InitOptions): Promise<CliResult<CommandOutput>> => {
  // The place of the index is checked before init writes anything.
  const indexPath = await indexPathOf(deps);
  if (!indexPath.ok) return indexPath;
  const chosen = await chooseHome(deps, options);
  if (!chosen.ok) return chosen;
  const { home, found, skipped, truncated } = chosen.value;

  // A bad value must give its error before any clone runs, because a clone costs time and disk.
  const checked = await checkOptions(deps, options, home);
  if (!checked.ok) return checked;

  // The clones come before the plan, because the plan reads each project. When a later step fails, the clones
  // that this run made are removed again. A folder that was there before the run is never removed.
  const projects = await planProjects(deps, home, options.projects);
  if (!projects.ok) return projects;
  const allProjects = projectsOf(deps, projects.value.paths, found);
  const counted = checkProjectCount(allProjects.length);
  if (!counted.ok) return counted;
  const beside = await checkHomeBesideProjects(deps, home, allProjects);
  if (!beside.ok) return beside;
  // Git makes the folders above a clone by itself. This run makes them first, so that the undo can remove them.
  const parents = projects.value.clones.some((clone) => !clone.present) ? await makeCloneParents(deps, home) : ok([]);
  if (!parents.ok) return parents;
  const cloned = await runClones(deps, projects.value.clones, parents.value);
  if (!cloned.ok) return cloned;
  const made = cloned.value;

  const plan = await planChecked(deps, { ...options, home, projects: allProjects }, checked.value);
  if (!plan.ok) return undoClones(deps, made, parents.value, plan.error);
  const applied = await applyInit(deps, plan.value);
  if (!applied.ok) return undoClones(deps, made, parents.value, applied.error);
  const notes = truncated ? [`Only the first ${MAX_SCAN_ENTRIES} entries of ${deps.cwd} were read.`] : [];
  const warnings = [
    ...plan.value.warnings,
    ...applied.value.warnings,
    ...notes,
    ...(await recordNode(deps, indexPath.value, {
      home: plan.value.home,
      id: plan.value.config.core.node.id,
      projects: plan.value.config.recipe.projects.map((project) => project.path),
    })),
  ];

  const written = [files.config, files.localConfig, files.claudeMd, `${dirs.state}/`];
  return ok({
    lines: [
      { level: 'text', text: `Created the ${roles.node} "${plan.value.config.core.node.id}" in ${plan.value.home}.` },
      ...written.map((name) => ({ level: 'text' as const, text: `  ${name}` })),
      ...made.map((target) => ({ level: 'text' as const, text: `Cloned into ${target}.` })),
      ...skipped.map((folder) => ({ level: 'text' as const, text: `Skipped ${folder.path}: ${folder.reason}.` })),
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
      warnings,
    },
    warnings,
    failed: false,
  });
};
