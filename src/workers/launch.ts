import { dirname, isAbsolute } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import { checkFolderSettings, requireNoFailures, warningLines } from '../commands/root-content.js';
import { isSlug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { instructionFileWarnings, scanInstructionFiles } from '../core/instruction-files.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { workerLaunchArgv } from '../launch/argv.js';
import {
  isPaneId,
  killPaneArgs,
  paneListArgs,
  parsePaneListSoft,
  setPaneOptionArgs,
  splitWorkerPaneArgs,
} from '../launch/tmux.js';
import { tmuxStep } from '../launch/tmux-run.js';
import { commands, commandText, dirs, env, keys, roles, tmuxNames, values } from '../names.js';
import { checkProxyHealth, type ProxyHealth } from '../safety/proxy.js';
import { layoutOf } from '../state/layout.js';

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

/** The command that starts a stopped worker again, and the command that ends it. */
const resumeCommand = (workerId: string): string => commandText(`${roles.worker} resume ${workerId}`);
const dismissCommand = (workerId: string): string => commandText(`dismiss ${workerId}`);

/** The two ways out of a failed launch, for the end of a remedy line: start the worker again, or end it. */
const tryAgainOrEnd = (workerId: string): string =>
  `"${resumeCommand(workerId)}" to try again, or "${dismissCommand(workerId)}" to end the ${roles.worker}`;

/**
 * The work copy must be an absolute path and a folder. tmux starts a pane in another folder when the folder of `-c` is
 * missing, and the program would then run outside the work copy. A link passes here: the settings check stops it.
 */
const requireWorkCopy = async (deps: Deps, workerId: string, workCopy: string): Promise<CliResult<void>> => {
  if (!isAbsolute(workCopy)) return failure(`the work copy of the ${roles.worker} ${workerId} is not an absolute path`);
  const kind = await deps.fs.lstat(workCopy);
  if (!kind.ok) return kind;
  if (kind.value === 'dir' || kind.value === 'link') return ok(undefined);
  return failure(
    `the work copy ${workCopy} of the ${roles.worker} ${workerId} is not a folder`,
    `Restore the folder, or end the ${roles.worker} with "${dismissCommand(workerId)}".`,
  );
};

/** The settings files of the work copy: a failure stops the launch (exit 4), and a warning is printed at once. */
const requireCleanSettings = async (deps: Deps, home: string, workCopy: string): Promise<CliResult<void>> => {
  const findings = await checkFolderSettings(deps, home, workCopy, WORK_COPY_PLACE);
  const clean = requireNoFailures(findings);
  if (!clean.ok) return clean;
  for (const line of warningLines(findings)) deps.warn(line);
  return ok(undefined);
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

/** Makes the pane in the workers window and returns its id. */
const startPane = async (
  deps: Deps,
  session: string,
  workCopy: string,
  command: readonly string[],
): Promise<CliResult<string>> => {
  const args = splitWorkerPaneArgs({ id: session, cwd: workCopy, command });
  if (!args.ok) return failure(args.error);
  const made = await tmuxStep(deps, args.value);
  if (!made.ok) return made;
  const paneId = made.value.trim();
  return isPaneId(paneId) ? ok(paneId) : failure(`${toolNames.tmux} ${args.value[0]} did not print a pane id`);
};

/**
 * Sets the worker mark on the pane. A pane that runs with no mark is a pane that no later command finds, so a failure closes
 * the pane that this launch made, by its id, and the failure names the result.
 */
const markPane = async (deps: Deps, pane: string, workerId: string): Promise<CliResult<void>> => {
  const args = setPaneOptionArgs(pane, tmuxNames.optionWorker, workerId);
  if (!args.ok) return failure(args.error);
  const set = await tmuxStep(deps, args.value);
  if (set.ok) return ok(undefined);
  const close = killPaneArgs(pane);
  const closed = close.ok && (await tmuxStep(deps, close.value)).ok;
  return closed
    ? failure(`${set.error.message}, so the pane ${pane} was closed`, `Run ${tryAgainOrEnd(workerId)}.`)
    : failure(
        `${set.error.message}, and the pane ${pane} stays open with no ${roles.worker} mark`,
        `Close the pane with "${toolNames.tmux} kill-pane -t ${pane}". Then run ${tryAgainOrEnd(workerId)}.`,
      );
};

/**
 * Reads the pane list once and requires the new pane to run. A pane that ended at once, or that is not in the list, is a failed
 * launch. A pane with a strange worker mark does not stop this check. Nothing is undone: the pane stays for a person to read.
 */
const requireRunningPane = async (deps: Deps, session: string, pane: string, workerId: string): Promise<CliResult<void>> => {
  const remedy = `Run ${tryAgainOrEnd(workerId)}.`;
  const listed = await tmuxStep(deps, paneListArgs(session));
  if (!listed.ok) return failure(`cannot check the pane ${pane}: ${listed.error.message}`, remedy);
  const rows = parsePaneListSoft(listed.value);
  if (!rows.ok) return failure(`cannot check the pane ${pane}: ${rows.error}`, remedy);
  const row = rows.value.find((candidate) => candidate.paneId === pane);
  if (row !== undefined && !row.dead) return ok(undefined);
  return failure(`the pane ${pane} of the ${roles.worker} ${workerId} ${row === undefined ? 'is gone' : 'ended'} at once`, remedy);
};

/**
 * Starts the program of a worker in a new pane of the workers window, in its work copy. In order:
 * 1. the settings files of the work copy (a failure is exit 4, and nothing starts);
 * 2. the instruction files above the work copy (a warning);
 * 3. the proxy of the worker, with its health check;
 * 4. the argument list, with auto mode and the resume id when there is one;
 * 5. the pane, and the worker mark on the pane id;
 * 6. for a launch with a resume id: one read of the pane list, because a resume of a session that does not exist ends at once.
 * The caller makes the work copy and the record, and it checks that the tmux session is its own.
 */
export const launchWorker = async (deps: Deps, request: WorkerLaunchRequest): Promise<CliResult<WorkerLaunch>> => {
  const { home, config, workerId, workCopy, resumeId } = request;
  if (!isSlug(workerId)) return failure(`the launch refuses a ${roles.worker} id that is not a slug`);
  const folder = await requireWorkCopy(deps, workerId, workCopy);
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
  const pane = await startPane(deps, session, workCopy, argv.value);
  if (!pane.ok) return pane;
  const marked = await markPane(deps, pane.value, workerId);
  if (!marked.ok) return marked;
  if (resumeId !== undefined) {
    const running = await requireRunningPane(deps, session, pane.value, workerId);
    if (!running.ok) return running;
  }
  return ok({
    paneId: pane.value,
    proxy: proxy.value.label,
    warnings: proxy.value.warning === undefined ? [] : [proxy.value.warning],
  });
};
