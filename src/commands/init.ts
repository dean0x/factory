import { basename, dirname, join, relative, resolve } from 'node:path';
import { appendBlocks, parseBlocks, renderBlock } from '../blocks/managed.js';
import { failure, usageError, type CliError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import { isGithubLogin, slugify } from '../config/primitives.js';
import { renderConfig } from '../config/render.js';
import { CONFIG_SCHEMA_VERSION, COORDINATOR_LAYER, configSchema, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import {
  commitAll,
  configValue,
  defaultBranchOf,
  githubRepoOf,
  gitInit,
  hasIdentity,
  isWorkTreeRoot,
} from '../core/git.js';
import { findNearestConfig } from '../core/home.js';
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
import { blockTemplatesFor, fileTemplates } from '../templates/index.js';
import type { BlockTemplate } from '../templates/types.js';
import { FACTORY_VERSION } from '../version.js';

export interface InitOptions {
  readonly home: string | undefined;
  readonly name: string | undefined;
  readonly ownerName: string | undefined;
  readonly ownerGithub: string | undefined;
  readonly projects: readonly string[];
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
  readonly configText: string;
  /** The text of CLAUDE.md before init, or null when the file does not exist. */
  readonly claudeOriginal: string | null;
  readonly claudeText: string;
  readonly stateFiles: readonly StateFile[];
  readonly warnings: readonly string[];
}

export interface InitResult {
  readonly committed: boolean;
  readonly warnings: readonly string[];
}

const GH_TIMEOUT_MS = 10_000;
const MAX_PROJECTS = 100;
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

const detectGithubLogin = async (deps: Deps): Promise<string | undefined> => {
  const result = await deps.run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS });
  if (!result.ok || result.value.exitCode !== 0) return undefined;
  const login = result.value.stdout.trim();
  return isGithubLogin(login) ? login : undefined;
};

const describeProject = async (deps: Deps, home: string, argument: string): Promise<CliResult<unknown>> => {
  const absolute = resolve(deps.cwd, argument);
  if (!(await isWorkTreeRoot(deps, absolute))) {
    return usageError(`${argument} is not the top folder of a git work tree`);
  }
  const id = slugify(basename(absolute));
  if (id === null) return usageError(`cannot make a project id from the folder name of ${argument}`);
  const repo = await githubRepoOf(deps, absolute);
  const branch = (await defaultBranchOf(deps, absolute)) ?? DEFAULT_BRANCH;
  return ok({
    [keys.project.id]: id,
    ...(repo === null ? {} : { [keys.project.repo]: repo }),
    [keys.project.path]: relative(home, absolute) || '.',
    [keys.project.defaultBranch]: branch,
    [keys.project.mergeMethod]: values.mergeMethods[0],
    [keys.project.gate]: { [keys.gate.checks]: [] },
  });
};

const describeProjects = async (
  deps: Deps,
  home: string,
  arguments_: readonly string[],
): Promise<CliResult<readonly unknown[]>> => {
  if (arguments_.length > MAX_PROJECTS) return usageError(`at most ${MAX_PROJECTS} projects are allowed`);
  const projects: unknown[] = [];
  for (const argument of arguments_) {
    const project = await describeProject(deps, home, argument);
    if (!project.ok) return project;
    projects.push(project.value);
  }
  return ok(projects);
};

const MAX_PARENT_LEVELS = 64;

/** The topmost folder on the way up from `dir` that does not exist, or null when `dir` exists. */
const topMissingFolder = async (deps: Deps, dir: string): Promise<CliResult<string | null>> => {
  let missing: string | null = null;
  let current = dir;
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    const kind = await deps.fs.stat(current);
    if (!kind.ok) return kind;
    if (kind.value !== null) return ok(missing);
    missing = current;
    const parent = dirname(current);
    if (parent === current) return ok(missing);
    current = parent;
  }
  return ok(missing);
};

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

/** Render the managed blocks. CLAUDE.md keeps its text, and the blocks go at the end. */
const blockTexts = async (
  deps: Deps,
  claudePath: string,
  templates: readonly BlockTemplate[],
): Promise<CliResult<{ original: string | null; claudeText: string; workerText: string | null }>> => {
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

/** Read the system and decide what init writes. This function writes nothing. */
export const planInit = async (deps: Deps, options: InitOptions): Promise<CliResult<InitPlan>> => {
  const layer = COORDINATOR_LAYER;
  const home = resolve(deps.cwd, options.home ?? '.');
  const layout = layoutOf(home);

  const configKind = await deps.fs.stat(layout.configFile);
  if (!configKind.ok) return configKind;
  if (configKind.value !== null) {
    return failure(
      `${files.config} already exists in ${home}`,
      `This folder is already a ${roles.node}. Run "${commandText(commands.doctor)}".`,
    );
  }
  const stateKind = await deps.fs.stat(layout.stateDir);
  if (!stateKind.ok) return stateKind;
  if (stateKind.value !== null) {
    return failure(`${dirs.state} already exists in ${home}`, 'Remove it, or use another folder.');
  }
  const homeKind = await deps.fs.stat(home);
  if (!homeKind.ok) return homeKind;
  if (homeKind.value !== null && homeKind.value !== 'dir') return failure(`${home} is not a folder`);
  const createdRoot = homeKind.value === null ? await topMissingFolder(deps, home) : ok(null);
  if (!createdRoot.ok) return createdRoot;

  const parentConfig = await findNearestConfig(deps, dirname(home));
  if (!parentConfig.ok) return parentConfig;
  const warnings =
    parentConfig.value === null
      ? []
      : [
          `A parent folder has a ${files.config}: ${parentConfig.value}. ` +
            `This ${roles.node} is a separate ${roles.node}, and no parent link is written.`,
        ];

  const id = options.name ?? slugify(basename(home));
  if (id === null) {
    return usageError(`cannot make a ${roles.node} id from the folder name`, `Pass ${flagText(flags.name)} ID.`);
  }
  const ownerName = (options.ownerName ?? (await configValue(deps, deps.cwd, 'user.name')) ?? '').trim();
  if (ownerName === '') {
    return usageError(
      `no ${roles.owner} name`,
      `Pass ${flagText(flags.ownerName)} NAME, or set git config user.name.`,
    );
  }
  const github = options.ownerGithub ?? (await detectGithubLogin(deps));

  const projects = await describeProjects(deps, home, options.projects);
  if (!projects.ok) return projects;

  const parsed = configSchema.safeParse({
    [keys.root.schema]: CONFIG_SCHEMA_VERSION,
    [keys.root.node]: { [keys.node.id]: id, [keys.node.layer]: layer },
    [keys.root.owner]: {
      [keys.owner.display]: ownerName,
      ...(github === undefined ? {} : { [keys.owner.github]: github }),
      [keys.owner.prefix]: defaultOwnerPrefix,
    },
    [keys.root.session]: {
      [keys.session.permissionMode]: values.permissionMode,
      [keys.session.effort]: values.efforts[2],
      [keys.session.model]: DEFAULT_MODEL,
      [keys.session.proxy]: values.noProxy,
    },
    [keys.root.proxies]: [],
    [keys.root.cells]: {},
    [keys.root.limits]: DEFAULT_LIMITS,
    [keys.root.approval]: { [keys.approval.land]: values.landModes[0] },
    [keys.root.tracker]: { [keys.tracker.kind]: values.trackerLocal },
    [keys.root.recipe]: {
      [keys.recipe.id]: values.recipes[0],
      [keys.recipe.variant]: values.variants[0],
      [keys.recipe.projects]: projects.value,
    },
    [keys.root.parent]: null,
    [keys.root.children]: [],
  });
  if (!parsed.success) {
    return usageError(`invalid settings: ${describeIssues(parsed.error)}`, 'Check the flags.');
  }

  const templates = blockTemplatesFor(layer);
  const blocks = await blockTexts(deps, layout.claudeMd, templates);
  if (!blocks.ok) return blocks;
  const stateFiles = stateFilesOf(templates, blocks.value.workerText);
  if (!stateFiles.ok) return stateFiles;

  return ok({
    home,
    createdRoot: createdRoot.value,
    config: parsed.data,
    configText: renderConfig(parsed.data),
    claudeOriginal: blocks.value.original,
    claudeText: blocks.value.claudeText,
    stateFiles: stateFiles.value,
    warnings,
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
  const touched = { state: false, claude: false, config: false };

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

  const config = await deps.fs.writeTextAtomic(layout.configFile, plan.configText);
  if (!config.ok) return rollback(config.error);
  touched.config = true;

  return ok({
    committed: identity,
    warnings: identity
      ? plan.warnings
      : [
          ...plan.warnings,
          `No git identity: the first commit of ${dirs.state} was not made. ` +
            'Set user.name and user.email, then commit there.',
        ],
  });
};

export const runInit = async (deps: Deps, options: InitOptions): Promise<CliResult<CommandOutput>> => {
  const plan = await planInit(deps, options);
  if (!plan.ok) return plan;
  const applied = await applyInit(deps, plan.value);
  if (!applied.ok) return applied;

  const written = [files.config, files.claudeMd, `${dirs.state}/`];
  return ok({
    lines: [
      { level: 'text', text: `Created the ${roles.node} "${plan.value.config.core.node.id}" in ${plan.value.home}.` },
      ...written.map((name) => ({ level: 'text' as const, text: `  ${name}` })),
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
      committed: applied.value.committed,
      warnings: applied.value.warnings,
    },
    warnings: applied.value.warnings,
    failed: false,
  });
};
