import { basename, dirname, isAbsolute } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { checkFolderSettings, checkTrackedSettings, requireNoFailures, warningLines } from '../commands/root-content.js';
import { isSlug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { instructionFileWarnings, scanInstructionFiles } from '../core/instruction-files.js';
import { ok } from '../core/result.js';
import { LINK_REMEDY, requireNoLinks } from '../core/root-paths.js';
import { toolNames } from '../core/tools.js';
import { workerLaunchArgv } from '../launch/argv.js';
import { isPaneId, setPaneOptionArgs, splitWorkerPaneArgs, tileWorkersArgs } from '../launch/tmux.js';
import { tmuxStep } from '../launch/tmux-run.js';
import { commandLines, commands, commandText, dirs, env, keys, places, roles, tmuxNames, values } from '../names.js';
import { checkProxyHealth, type ProxyHealth } from '../safety/proxy.js';
import { layoutOf } from '../state/layout.js';
import { confirmLaunch, paneFailure, type PaneFailureRequest } from './confirm.js';
import { closePane, type BoundPane } from './panes.js';
import { workCopyOf } from './registry.js';
import { closeWorkerPane } from './slot.js';

/**
 * The one path that starts a worker (design 4.6): `worker new`, `worker resume`, and later `restart`, `reboot` and the restore
 * after a machine restart all call `launchWorker`, so they apply the same checks, the same proxy rules and the same argument
 * list. The checks come first and the pane comes last: a check that fails starts nothing.
 */

/** The proxy that a session uses. */
export interface ProxyChoice {
  /** The base URL for the launch, or null for no proxy. */
  readonly baseUrl: string | null;
  /** The id, host and port. Safe to print. Null when the session uses no proxy. */
  readonly label: string | null;
  readonly warning?: string;
}

/** Which proxy a setting asks for, and how the messages name that setting and the command to run again. */
export interface ProxyWish {
  /** The id of the proxy, or `none`. */
  readonly id: string;
  /** The config key that holds the id, as a person reads it. */
  readonly setting: string;
  /** The command that a person runs again after the fix, without the program name: for example `start`. */
  readonly retry: string;
}

/**
 * The health answers of one run, by proxy id. A launch that gets the answers of its run asks each proxy once: the next launch of
 * the run, for the same proxy, reads the answer that is here. The launches of one run go one after the other.
 */
export type ProxyAnswers = Map<string, ProxyHealth>;

export const newProxyAnswers = (): ProxyAnswers => new Map();

/** The proxy of the session: `session.proxy` of the config. */
export const sessionProxyWish = (config: FactoryConfig, retry: string = commands.start): ProxyWish => ({
  id: config.core.session.proxy,
  setting: `${keys.root.session}.${keys.session.proxy}`,
  retry,
});

/** The proxy of one worker: its own entry in `workers` of the config when it has one, else the proxy of the session. */
export const workerProxyWish = (config: FactoryConfig, workerId: string, retry: string): ProxyWish => {
  const own = Object.hasOwn(config.core.workers, workerId) ? config.core.workers[workerId] : undefined;
  return own === undefined
    ? sessionProxyWish(config, retry)
    : { id: own.proxy, setting: `${keys.root.workers}.${workerId}.${keys.worker.proxy}`, retry };
};

/**
 * The proxy of a session, by the rules of design 4.6: only a proxy that the config names, and only when it answers. With
 * `answers`, a proxy that the run asked before is not asked again.
 */
export const chooseProxy = async (
  deps: Deps,
  config: FactoryConfig,
  wish: ProxyWish = sessionProxyWish(config),
  answers?: ProxyAnswers,
): Promise<CliResult<ProxyChoice>> => {
  if (wish.id === values.noProxy) return ok({ baseUrl: null, label: null });
  const proxy = config.core.proxies.find((candidate) => candidate.id === wish.id);
  if (proxy === undefined) {
    return failure(`${wish.setting} names a proxy that is not defined in ${keys.root.proxies}`);
  }
  const health = answers?.get(proxy.id) ?? (await checkProxyHealth(deps, proxy));
  answers?.set(proxy.id, health);
  if (health.up) return ok({ baseUrl: proxy.base_url, label: health.label });
  if (proxy.on_fail === values.onFail[1]) {
    return ok({
      baseUrl: null,
      label: null,
      warning: `${health.label} does not answer. ${keys.proxy.onFail} is ${proxy.on_fail}: the session starts without a proxy.`,
    });
  }
  return failure(
    `${health.label} does not answer`,
    `Start the proxy, or set ${wish.setting} to ${values.noProxy} for the session. Then run "${commandText(wish.retry)}" again.`,
  );
};

export interface WorkerLaunchRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  /** The id of the worker: a slug. It is the value of the worker mark of the pane. */
  readonly workerId: string;
  /** The work copy of the worker: an absolute folder. The program of the pane starts there. */
  readonly workCopy: string;
  /** The id of the earlier session to resume: a UUID. Absent for a new worker. */
  readonly resumeId?: string;
  /** The command that a person runs again after a fix of the proxy, without the program name: for example `worker new`. */
  readonly retry: string;
  /** The answers of the run, for the proxy check. Absent: this launch asks its proxy by itself. */
  readonly proxyAnswers?: ProxyAnswers;
}

export interface WorkerLaunch {
  /** The id of the pane that runs the worker, for example `%7`. */
  readonly paneId: string;
  /** The id, host and port of the proxy, or null for a launch with no proxy. Safe to print. */
  readonly proxy: string | null;
  /** The warnings that can wait for the output of the command: a proxy that did not answer and the config allows to go direct. */
  readonly warnings: readonly string[];
}

/** The place that the warning for a settings file names. */
const WORK_COPY_PLACE = 'a work copy';

/** The command that starts a stopped worker again, without the program name: for the retry of a launch. */
export const resumeLine = (workerId: string): string => `${commandLines.workerResume} ${workerId}`;

/** The command that starts a stopped worker again. */
const resumeCommand = (workerId: string): string => commandText(resumeLine(workerId));

/** The way out of a failed launch, for the end of a remedy line: start the worker again. */
const tryAgain = (workerId: string): string => `"${resumeCommand(workerId)}" to try again`;

/**
 * The work copy must be the folder of this worker: exactly `work-copies/<project>/<id>` of the factory folder, as the path is
 * written, and a folder. A path in another place, a path of another worker and a path with a dot-dot part are a security stop
 * (exit 4), because the folder of the launch is the main permission scope of the session. No part of the path from the work copies
 * folder down may be a link (exit 4). tmux starts a pane in another folder when the folder of `-c` is missing, and the program would
 * then run outside the work copy, so a folder that is not there is a failure. A command that stops a worker before it launches
 * the worker again runs this check, and `requireCleanSettings`, before the stop.
 */
export const requireWorkCopy = async (deps: Deps, home: string, workerId: string, workCopy: string): Promise<CliResult<void>> => {
  if (!isAbsolute(workCopy)) return failure(`the work copy of the ${roles.worker} ${workerId} is not an absolute path`);
  const project = basename(dirname(workCopy));
  if (!isSlug(project) || workCopy !== workCopyOf(home, project, workerId)) {
    return safetyRefusal(
      `the work copy of the ${roles.worker} ${workerId} is not the folder ${dirs.workCopies}/<project>/${workerId} of this ${places.folder}, so the launch starts no session there`,
      `Check the record of the ${roles.worker}. Then run "${resumeCommand(workerId)}" again.`,
    );
  }
  const linked = await requireNoLinks(deps, home, [workCopy]);
  if (!linked.ok) return linked;
  const kind = await deps.fs.lstat(workCopy);
  if (!kind.ok) return kind;
  if (kind.value === 'dir') return ok(undefined);
  if (kind.value === 'link') {
    return safetyRefusal(`the work copy of the ${roles.worker} ${workerId} became a link`, LINK_REMEDY);
  }
  return failure(
    `the work copy ${workCopy} of the ${roles.worker} ${workerId} is not a folder`,
    `Restore the folder. Then run ${tryAgain(workerId)}.`,
  );
};

/**
 * The settings files of the work copy: a failure stops the launch (exit 4), and a warning is printed at once. `launchWorker`
 * runs it. A command that must check the work copy before it changes anything, for example before it stops a worker, can run
 * it alone.
 */
export const requireCleanSettings = async (deps: Deps, home: string, workCopy: string): Promise<CliResult<void>> => {
  const findings = await checkFolderSettings(deps, home, workCopy, WORK_COPY_PLACE);
  const clean = requireNoFailures(findings);
  if (!clean.ok) return clean;
  for (const line of warningLines(findings)) deps.warn(line);
  return ok(undefined);
};

/**
 * The settings files that a checkout puts into a new work copy, read from the last commit of the clone before the work copy exists:
 * the same stops as `requireCleanSettings` (exit 4), so that a refusal leaves no work copy, no branch and no record. Warnings are
 * not printed here: the launch prints them from the files of the work copy. The value is the text of the file that the program
 * writes to, when the commit tracks one.
 */
export const requireCleanTrackedSettings = async (
  deps: Deps,
  home: string,
  clone: string,
  workCopy: string,
): Promise<CliResult<{ readonly localText: string | null }>> => {
  const tracked = await checkTrackedSettings(deps, home, clone, { path: workCopy, presence: WORK_COPY_PLACE });
  if (!tracked.ok) return tracked;
  const clean = requireNoFailures(tracked.value.findings);
  return clean.ok ? ok({ localText: tracked.value.localText }) : clean;
};

/**
 * The instruction files that the session of a worker loads besides those of its project: the files in `work-copies/` and in
 * the folder of the project. The files in the work copy itself belong to the project. The files in the factory folder and
 * above it are the warning of the start of the factory. It is a warning only: it never stops a launch.
 */
const instructionWarnings = async (
  deps: Deps,
  home: string,
  workerId: string,
  workCopy: string,
): Promise<readonly string[]> => {
  const scan = await scanInstructionFiles(deps, dirname(workCopy), layoutOf(home).workCopiesDir);
  return [
    ...(scan.found.length === 0
      ? []
      : [
          `Agent instruction files are in ${dirs.workCopies}/ or in the folder of a project below it: ${scan.found.join(', ')}. ` +
            `The session of the ${roles.worker} ${workerId} loads them. Move each file out of those folders, or keep it on purpose.`,
        ]),
    ...instructionFileWarnings({ ...scan, found: [] }),
  ];
};

/**
 * The remedy for a split that failed. The usual cause is a window with no room: every split halves one pane, and a window that is
 * tiled less often than it is split runs out of room. `layout` makes the window if it is missing and tiles it, and then the
 * worker starts again with `worker resume`.
 */
const splitRemedy = (workerId: string): string =>
  `Run "${commandText(commands.layout)}" to make the window ${tmuxNames.windowWorkers} and tile its panes. ` +
  `Then run "${resumeCommand(workerId)}".`;

/** Makes the pane in the workers window and returns its id. */
const startPane = async (
  deps: Deps,
  session: string,
  workerId: string,
  workCopy: string,
  command: readonly string[],
): Promise<CliResult<string>> => {
  const args = splitWorkerPaneArgs({ id: session, cwd: workCopy, command });
  if (!args.ok) return failure(args.error);
  const made = await tmuxStep(deps, args.value);
  if (!made.ok) {
    // A call that ran and exited with a code is the failure that `layout` can fix. Any other error keeps its own kind and remedy.
    const ranAndFailed = made.error.kind === 'failure' && made.error.hint === undefined;
    return ranAndFailed ? failure(made.error.message, splitRemedy(workerId)) : made;
  }
  const paneId = made.value.trim();
  return isPaneId(paneId) ? ok(paneId) : failure(`${toolNames.tmux} ${args.value[0]} did not print a pane id`);
};

/**
 * Tiles the panes of the workers window, so that the next split finds room: each split halves one pane, and a window that is never
 * tiled holds only a few panes. A tile that fails is a warning, not a failure: the worker runs, and `layout` tiles the window later.
 */
const tilePanes = async (deps: Deps, session: string): Promise<readonly string[]> => {
  const tiled = await tmuxStep(deps, tileWorkersArgs(session));
  return tiled.ok
    ? []
    : [
        `The panes of the window ${tmuxNames.windowWorkers} are not tiled: ${tiled.error.message}. ` +
          `Run "${commandText(commands.layout)}" to tile them.`,
      ];
};

/**
 * Sets the worker mark on the pane. A pane that runs with no mark is a pane that no later command finds, so a failure closes
 * the pane that this launch made, by its id, and the failure names the result. A program can end at once, and tmux then removes
 * the pane before the mark: the close finds no pane, and the failure is the same as for a pane that ended after the start
 * (`paneFailure`), because that is what happened. The text "stays open" is only for a pane that tmux still has.
 */
const markPane = async (deps: Deps, request: PaneFailureRequest): Promise<CliResult<void>> => {
  const { paneId, workerId } = request;
  const args = setPaneOptionArgs(paneId, tmuxNames.optionWorker, workerId);
  if (!args.ok) return failure(args.error);
  const set = await tmuxStep(deps, args.value);
  if (set.ok) return ok(undefined);
  const closed = await closePane(deps, paneId);
  if (closed.ok && closed.value === 'gone') return paneFailure(request, 'gone');
  return closed.ok
    ? failure(`${set.error.message}, so the pane ${paneId} was closed`, `Run ${tryAgain(workerId)}.`)
    : failure(
        `${set.error.message}, and the pane ${paneId} stays open with no ${roles.worker} mark`,
        `Close the pane with "${toolNames.tmux} kill-pane -t ${paneId}". Then run ${tryAgain(workerId)}.`,
      );
};

/**
 * Starts the program of a worker in a new pane of the workers window, in its work copy. In order:
 * 1. the work copy, which must be exactly the folder of this worker below the work copies folder with no link in its path, and its
 *    settings files (a failure is exit 4, and nothing starts);
 * 2. the instruction files above the work copy (a warning);
 * 3. the proxy of the worker, with its health check;
 * 4. the argument list, with auto mode and the resume id when there is one;
 * 5. the pane, and the worker mark on the pane id;
 * 6. the tile of the workers window, so that the next launch finds room (a failed tile is a warning);
 * 7. the wait for the pane to prove itself (`confirmLaunch`): the pane must still run the launch after the first wait, and a launch
 *    with a resume id must also see the SessionStart line of the new session. A pane that ends is exit 1. A resume that the line
 *    does not confirm is exit 3 with "resume not confirmed". Nothing is undone: the pane stays for a person to read.
 * The caller makes the work copy and the record, and it checks that the tmux session is its own.
 */
export const launchWorker = async (deps: Deps, request: WorkerLaunchRequest): Promise<CliResult<WorkerLaunch>> => {
  const { home, config, workerId, workCopy, resumeId } = request;
  if (!isSlug(workerId)) return failure(`the launch refuses a ${roles.worker} id that is not a slug`);
  const folder = await requireWorkCopy(deps, home, workerId, workCopy);
  if (!folder.ok) return folder;
  const settings = await requireCleanSettings(deps, home, workCopy);
  if (!settings.ok) return settings;
  for (const line of await instructionWarnings(deps, home, workerId, workCopy)) deps.warn(line);

  const proxy = await chooseProxy(deps, config, workerProxyWish(config, workerId, request.retry), request.proxyAnswers);
  if (!proxy.ok) return proxy;
  const path = deps.env[env.path];
  const argv = workerLaunchArgv({
    home,
    workerId,
    effort: config.core.session.effort,
    model: config.core.session.model,
    proxyBaseUrl: proxy.value.baseUrl,
    path: path === undefined || path === '' ? null : path,
    agent: config.core.session.agent,
    ...(resumeId === undefined ? {} : { resumeId }),
  });
  if (!argv.ok) return failure(argv.error);

  const session = config.core.node.id;
  const launchedAt = deps.now();
  const pane = await startPane(deps, session, workerId, workCopy, argv.value);
  if (!pane.ok) return pane;
  const marked = await markPane(deps, { home, paneId: pane.value, workerId, resuming: resumeId !== undefined });
  if (!marked.ok) return marked;
  const tileWarnings = await tilePanes(deps, session);
  const confirmed = await confirmLaunch(deps, {
    home,
    paneId: pane.value,
    workerId,
    launchedAt,
    resuming: resumeId !== undefined,
  });
  if (!confirmed.ok) return confirmed;
  return ok({
    paneId: pane.value,
    proxy: proxy.value.label,
    warnings: [...(proxy.value.warning === undefined ? [] : [proxy.value.warning]), ...tileWarnings],
  });
};

export interface WorkerResumeRequest extends WorkerLaunchRequest {
  /** The panes of the worker whose programs ended. They are closed, by id, before the launch. */
  readonly deadPanes?: readonly BoundPane[];
}

/**
 * Starts a stopped worker again: closes the old panes of the worker whose programs ended, then launches (`launchWorker`, which
 * waits for the pane to prove itself). `resumeId` is the id of an earlier session that the caller has checked: the caller
 * decides what a bad id means. `worker resume` starts a new conversation without `resumeId` and warns, and a recovery or a
 * restart passes only an id that passed the strict check, and starts nothing for a worker that has none. The caller has
 * checked the root, the tools and the tmux session (`prepareLaunch`), and that no pane of the worker runs.
 */
export const resumeWorker = async (deps: Deps, request: WorkerResumeRequest): Promise<CliResult<WorkerLaunch>> => {
  const { deadPanes = [], ...launch } = request;
  for (const pane of deadPanes) {
    const closed = await closeWorkerPane(deps, launch.config.core.node.id, pane.paneId);
    if (!closed.ok) return closed;
  }
  return launchWorker(deps, launch);
};
