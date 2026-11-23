import { headConflictIn, shown } from '../board/edit.js';
import { readDecisionLog, readWaiting } from '../board/files.js';
import { branchesOf, checkInputOf, findWorkItem, openRequestsOf, recordWork, workerOf } from '../board/record-flow.js';
import type { RequestLinkRules } from '../board/requests.js';
import { localBoardOf, requestLinkRulesOf, type OpenBoard } from '../commands/board-open.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { Deps } from '../core/deps.js';
import { guardReadOf } from '../core/guard-source.js';
import { locateHomeFolder } from '../core/home.js';
import { effectiveModes } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import type { GuardValues } from '../guards/types.js';
import { commands, commandText, decideProof, files, flags, flagText, requestWords, roles, type CommandName } from '../names.js';
import type { RecipeHost, RecipeProject, RecipeRegistry, WorkHost } from '../recipes/index.js';
import { writeEventFile } from '../report/event-file.js';
import { layoutOf } from '../state/layout.js';
import { requireNodeCaller } from '../workers/panes.js';
import { failure, safetyRefusal, usageError, type CliResult } from './errors.js';

const listedIds = (projects: readonly RecipeProject[]): string => projects.map((project) => project.id).join(', ');

/** The project that the id names. Without an id, the only project of the node. Each remedy names the command to run again. */
const projectOf = (projects: readonly RecipeProject[], projectId: string | undefined, command: CommandName): CliResult<RecipeProject> => {
  const again = commandText(command);
  if (projectId !== undefined) {
    const named = projects.find((candidate) => candidate.id === projectId);
    return named === undefined
      ? usageError(
          `the project ${JSON.stringify(projectId)} is not listed in the config of this ${roles.node}`,
          projects.length === 0
            ? `The config lists no project. Add a project to ${files.config}, then run "${again}" again.`
            : `The listed projects are: ${listedIds(projects)}. Run "${again}" again with a listed project.`,
        )
      : ok(named);
  }
  const [only, ...others] = projects;
  if (only === undefined) {
    return usageError(`the config of this ${roles.node} lists no project`, `Add a project to ${files.config}, then run "${again}" again.`);
  }
  return others.length === 0
    ? ok(only)
    : usageError(
        `this ${roles.node} lists more than one project, so the command needs ${flagText(flags.project)}`,
        `The listed projects are: ${listedIds(projects)}. Run "${again}" again with ${flagText(flags.project)} PROJECT.`,
      );
};

const findOf = (deps: Deps, { home, config, connector }: OpenBoard, rules: RequestLinkRules, command: CommandName): WorkHost['find'] =>
  async (query) => {
    const items = await connector.listItems({ all: true });
    if (!items.ok) return items;
    const layout = layoutOf(home);
    const waiting = await readWaiting(deps, layout);
    if (!waiting.ok) return waiting;
    const log = await readDecisionLog(deps, layout);
    if (!log.ok) return log;
    return findWorkItem(items.value, waiting.value, log.value, rules, {
      ...query, closed: config.core.board?.closed, workerField: config.core.board?.worker_field, remedy: { command, rest: '' },
    });
  };

const factsOf = (deps: Deps, board: OpenBoard, rules: RequestLinkRules, command: CommandName): WorkHost['facts'] =>
  async (target) => {
    const { home, config, connector } = board;
    const items = await connector.listItems({ all: true });
    if (!items.ok) return items;
    const item = items.value.find((candidate) => candidate.id === target.item);
    if (item === undefined) return failure(`${files.board} has no item ${shown(target.item)}`, `Check the item in ${files.board}.`);
    if (!rules.points.includes(target.point)) return usageError(`the approval point is not listed in the ${roles.recipe}`);
    const waiting = await readWaiting(deps, layoutOf(home));
    if (!waiting.ok) return waiting;
    const open = openRequestsOf(waiting.value, rules, target);
    if (!open.ok) return open;
    const worker = workerOf(item, config.core.board?.worker_field);
    if (!worker.ok) return worker;
    const branches = branchesOf(item, worker.value, { command, rest: '' });
    if (!branches.ok) return branches;
    const input = await checkInputOf(deps, board, { id: item.id, ref: target.ref, project: target.project }, target.ref, worker.value, branches.value);
    if (!input.ok) return input;
    const modes = await effectiveModes(deps, home, config);
    const { project, cloneDir } = input.value;
    return ok({
      openRequests: open.value, headConflict: headConflictIn(items.value, item.id, target.head),
      mode: modes[target.point] ?? roles.owner, project, cloneDir, branches: branches.value,
    });
  };

/** The caller check and the approval proof are mistake guards, not proof of identity. */
const workHostOf = (deps: Deps, board: OpenBoard, rules: RequestLinkRules, guards: GuardValues, command: CommandName): WorkHost => ({
  guards,
  caller: () => requireNodeCaller(deps, board.home, board.config, command),
  find: findOf(deps, board, rules, command),
  facts: factsOf(deps, board, rules, command),
  approval: async ({ item, point, ref, head, need }) => {
    const proof = await board.connector.proveApproval(item, point, ref, head);
    if (!proof.ok) return proof.error.reason === 'hash-mismatch' ? safetyRefusal(proof.error.message, proof.error.hint) : proof;
    if (need === 'owner-record' && proof.value.kind === decideProof.relayed) {
      return failure(
        `this reference and head need an ${roles.owner} store decision`,
        `Add a new linked ${requestWords.request} for this reference and head. Ask the ${roles.owner} to answer it with "${commandText(commands.decide)}".`,
      );
    }
    return proof;
  },
  record: ({ item, ref, project }) => recordWork(deps, board, { id: item, ref, project }),
  writeEvent: (event) => writeEventFile(deps, board.home, event),
});

/** Give the recipe the node, config and board operations it needs without imports from the command layer. */
export const recipeHostFor = (registry: RecipeRegistry): RecipeHost => {
  const locateNode: RecipeHost['locateNode'] = async (deps, home, command) => {
    const located = await locateHomeFolder(deps, home, (readDeps, folder) => readNodeIdentity(readDeps, folder, registry), command);
    return located.ok ? ok(located.value.home) : located;
  };
  return {
    registry,
    locateNode,
    loadProject: async (deps, home, projectId, command) => {
      const config = await loadConfig(deps, home, registry);
      return config.ok ? projectOf(config.value.recipe.projects, projectId, command) : config;
    },
    openWork: async (deps, homeFlag, command) => {
      const located = await locateNode(deps, homeFlag, command);
      if (!located.ok) return located;
      const home = located.value;
      const loaded = await loadConfig(deps, home, registry);
      if (!loaded.ok) return loaded;
      const config = loaded.value;
      const rules = requestLinkRulesOf(config);
      if (rules === undefined) return usageError(`the ${roles.recipe} ${config.entry.id} has no work check`);
      const read = await guardReadOf(deps, home, config, 'when-off');
      const board = { home, config, connector: localBoardOf(read.deps, home, config, command) };
      return ok(workHostOf(read.deps, board, rules, read.state.values, command));
    },
  };
};
