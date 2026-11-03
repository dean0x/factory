import { join, resolve } from 'node:path';
import { inspectBlock, safetyStateOf } from '../blocks/status.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity, settleLocalMode } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { warnInstructionFiles } from '../core/instruction-files.js';
import { effectiveModes } from '../core/owner-record.js';
import { err, ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { isTmuxNewEnough, MIN_TMUX, onPath, tmuxVersionOf, toolNames } from '../core/tools.js';
import { launchArgv } from '../launch/argv.js';
import {
  attachArgs,
  attachHint,
  coordinatorEndedArgs,
  hasSessionArgs,
  killSessionArgs,
  showHomeArgs,
  startSteps,
  switchArgs,
  type TmuxArgs,
} from '../launch/tmux.js';
import {
  blockNames,
  capitalize,
  commands,
  commandText,
  dirs,
  env,
  files,
  flags,
  flagText,
  keys,
  overwriteCommand,
  program,
  roles,
  schemaIds,
  tmuxNames,
  values,
} from '../names.js';
import { checkProxyHealth } from '../safety/proxy.js';
import { layoutOf } from '../state/layout.js';
import { safetyTemplateFor } from '../templates/index.js';
import { planBlock } from '../upgrade/plan.js';
import { writeBlockPlans } from '../upgrade/render.js';
import { requireRootClean, rootNotices, scanRoot } from './root-content.js';

export interface StartOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
}

const TMUX_TIMEOUT_MS = 15_000;
const MAX_DETAIL_CHARS = 200;
const MIN_TMUX_TEXT = `${MIN_TMUX.major}.${MIN_TMUX.minor}`;

/** How the command shows the session to the person: attach, switch the client of tmux, or print how to attach. */
type Reach = 'attach' | 'switch' | 'print';

interface ProxyChoice {
  /** The base URL for the launch, or null for no proxy. */
  readonly baseUrl: string | null;
  /** The id, host and port. Safe to print. Null when the session uses no proxy. */
  readonly label: string | null;
  readonly warning?: string;
}

interface StartPlan {
  readonly proxy: ProxyChoice;
  readonly steps: readonly TmuxArgs[];
  /** The same steps, with the label of the proxy where the URL is. They are safe to print. */
  readonly shown: readonly TmuxArgs[];
  /** A project folder that is missing: the session does not get it. */
  readonly warnings: readonly string[];
}

const missingProjectWarning = (path: string): string =>
  `The project folder ${path} is missing, so the session does not get it. Clone the repo of the project into that folder.`;

/**
 * The project folders that exist, and a warning for each one that does not. A received factory lists projects whose
 * folders can be missing, and a folder that is not there must not go into the session as a folder that it can read.
 */
const presentProjects = async (
  deps: Deps,
  home: string,
  projects: readonly { readonly path: string }[],
): Promise<CliResult<{ readonly folders: readonly string[]; readonly warnings: readonly string[] }>> => {
  const folders: string[] = [];
  const warnings: string[] = [];
  for (const project of projects) {
    const folder = resolve(home, project.path);
    const kind = await deps.fs.stat(folder);
    if (!kind.ok) return kind;
    if (kind.value === 'dir') folders.push(folder);
    else warnings.push(missingProjectWarning(folder));
  }
  return ok({ folders, warnings });
};

const shellWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

/** A tmux call as a person could type it, for the dry run. */
const commandLine = (args: TmuxArgs): string => [toolNames.tmux, ...args].map(shellWord).join(' ');

const detailOf = (stderr: string): string => {
  const line = stderr
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
    ?.trim()
    .slice(0, MAX_DETAIL_CHARS);
  return line === undefined ? '' : `: ${line}`;
};

const tmuxCall = (deps: Deps, args: TmuxArgs) =>
  deps.run(toolNames.tmux, args, { inheritEnv: true, timeoutMs: TMUX_TIMEOUT_MS });

/** A tmux call that must work. The result is its output. */
const tmuxStep = async (deps: Deps, args: TmuxArgs): Promise<CliResult<string>> => {
  const result = await tmuxCall(deps, args);
  if (!result.ok) return result;
  const { exitCode, stdout, stderr } = result.value;
  if (exitCode === 0) return ok(stdout);
  return failure(`${toolNames.tmux} ${args[0]} failed (exit code ${exitCode})${detailOf(stderr)}`);
};

/** True when a session with this exact name runs. A tmux that does not run counts as no session. */
const sessionExists = async (deps: Deps, id: string): Promise<boolean> => {
  const result = await tmuxCall(deps, hasSessionArgs(id));
  return result.ok && result.value.exitCode === 0;
};

/** True when the program of the coordinator pane has ended. A pane that cannot be read counts as one that runs. */
const coordinatorEnded = async (deps: Deps, id: string): Promise<boolean> => {
  const result = await tmuxCall(deps, coordinatorEndedArgs(id));
  return result.ok && result.value.exitCode === 0 && result.value.stdout.trim() === '1';
};

/** The tools that `start` needs. A real run also reads the version of tmux. A dry run starts no tmux command for it. */
const toolProblems = async (deps: Deps, readVersion: boolean): Promise<readonly string[]> => {
  const problems: string[] = [];
  if (!(await onPath(deps, toolNames.tmux))) {
    problems.push(`${toolNames.tmux} is not on PATH. Install ${toolNames.tmux} ${MIN_TMUX_TEXT} or newer`);
  } else if (readVersion) {
    const version = await tmuxVersionOf(deps);
    if (version === null) {
      problems.push(`cannot read the version of ${toolNames.tmux}`);
    } else if (!isTmuxNewEnough(version)) {
      problems.push(
        `${toolNames.tmux} ${version.major}.${version.minor} is too old. ${capitalize(program)} needs ${toolNames.tmux} ${MIN_TMUX_TEXT} or newer`,
      );
    }
  }
  if (!(await onPath(deps, toolNames.claude))) problems.push(`${toolNames.claude} is not on PATH`);
  return problems;
};

/** The session is of this home when its option holds this home, also through a link. */
const isSameHome = async (deps: Deps, stored: string, home: string): Promise<boolean> => {
  if (stored === '') return false;
  if (stored === home) return true;
  const [a, b] = await Promise.all([deps.fs.realpath(stored), deps.fs.realpath(home)]);
  return a.ok && b.ok && a.value === b.value;
};

const requireOwnSession = async (deps: Deps, id: string, home: string): Promise<CliResult<void>> => {
  const shown = await tmuxStep(deps, showHomeArgs(id));
  if (!shown.ok) return shown;
  if (await isSameHome(deps, shown.value.trim(), home)) return ok(undefined);
  return safetyRefusal(
    `a tmux session ${id} belongs to another ${roles.node} home`,
    `Two ${roles.node}s on one machine need two ids. Change ${keys.root.node}.${keys.node.id} in the config of one of them, or stop the other session.`,
  );
};

/** The proxy of the session, by the rules of design 4.6: only a proxy that the config names, and only when it answers. */
const chooseProxy = async (deps: Deps, config: FactoryConfig): Promise<CliResult<ProxyChoice>> => {
  const { core } = config;
  const wanted = core.session.proxy;
  if (wanted === values.noProxy) return ok({ baseUrl: null, label: null });
  const proxy = core.proxies.find((candidate) => candidate.id === wanted);
  if (proxy === undefined) {
    return failure(`${keys.root.session}.${keys.session.proxy} names a proxy that is not defined in ${keys.root.proxies}`);
  }
  const health = await checkProxyHealth(deps, proxy);
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
    `Start the proxy, or set ${keys.root.session}.${keys.session.proxy} to ${values.noProxy} for the session.`,
  );
};

/**
 * The safety block, for every launch (design 4.8). `start` never launches with a safety body that differs from the text
 * that the package renders for the config, the effective approval modes and the owner prefix:
 * - equal: no action;
 * - intact but different (the package, a mode or the prefix changed): render the block again, print a notice and go on;
 *   a dry run writes nothing and returns a note;
 * - edited, missing or not readable: exit 4, because the safety rules are a security boundary.
 * A link at the coordinator file is a stop first: nothing is read or written through it. The coordinator folder exists
 * after this check, because a missing file is a missing block. The value is the notes of a dry run.
 */
const requireSafetyBlock = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  dryRun: boolean,
): Promise<CliResult<readonly string[]>> => {
  const { claudeMd } = layoutOf(home);
  const plain = await requireNoLinks(deps, home, [claudeMd]);
  if (!plain.ok) return plain;
  const name = blockNames.safety;
  const file = join(dirs.coordinator, files.claudeMd);
  const status = await inspectBlock(deps, home, safetyTemplateFor(config, await effectiveModes(deps, home, config)));
  const state = safetyStateOf(status);
  switch (state) {
    case 'equal':
      return ok([]);
    case 'different': {
      if (dryRun) return ok([`The block ${name} in ${file} is out of date. A real run renders it again.`]);
      const written = await writeBlockPlans(deps, home, [planBlock(status, false)]);
      if (!written.ok) return written;
      deps.warn(`Rendered the block ${name} in ${file} again, because the package or a setting changed its text.`);
      return ok([]);
    }
    case 'edited':
      return safetyRefusal(
        `the block ${name} in ${file} was edited`,
        `Run "${overwriteCommand(name)}" to replace the text. It keeps the old text in a backup file.`,
      );
    case 'missing':
      return safetyRefusal(`the block ${name} is missing in ${file}`, `Run "${overwriteCommand(name)}" to add it.`);
    case 'malformed':
      return safetyRefusal(
        `the block ${name} in ${file} can not be read${status.kind === 'malformed' ? `: ${status.message}` : ''}`,
        `Fix the marker lines in ${file}, then run "${commandText(commands.doctor)}".`,
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

/** The tmux calls that start the session, once with the real proxy URL and once with the label of the proxy. */
const planStart = async (deps: Deps, home: string, config: FactoryConfig): Promise<CliResult<StartPlan>> => {
  const { coordinatorDir, stateDir } = layoutOf(home);
  const proxy = await chooseProxy(deps, config);
  if (!proxy.ok) return proxy;
  const { core, recipe } = config;
  const projects = await presentProjects(deps, home, recipe.projects);
  if (!projects.ok) return projects;
  const path = deps.env[env.path];
  const stepsFor = (proxyBaseUrl: string | null): CliResult<readonly TmuxArgs[]> => {
    const launch = launchArgv({
      home,
      coordinatorDir,
      stateDir,
      sessionId: core.node.id,
      effort: core.session.effort,
      model: core.session.model,
      proxyBaseUrl,
      path: path === undefined || path === '' ? null : path,
      projects: projects.value.folders,
    });
    return launch.ok ? ok(startSteps({ id: core.node.id, home, coordinatorDir, launch: launch.value })) : failure(launch.error);
  };
  const steps = stepsFor(proxy.value.baseUrl);
  if (!steps.ok) return steps;
  const shown = stepsFor(proxy.value.label === null ? null : `<${proxy.value.label}>`);
  if (!shown.ok) return shown;
  return ok({ proxy: proxy.value, steps: steps.value, shown: shown.value, warnings: projects.value.warnings });
};

const reachOf = (deps: Deps): Reach => {
  if (!(deps.stdinIsTTY && deps.stdoutIsTTY)) return 'print';
  return (deps.env['TMUX'] ?? '') === '' ? 'attach' : 'switch';
};

/** The tmux call of a reach, or null when the command only prints. */
const reachArgs = (how: Reach, id: string): TmuxArgs | null => {
  switch (how) {
    case 'attach':
      return attachArgs(id);
    case 'switch':
      return switchArgs(id);
    case 'print':
      return null;
    default: {
      const unreachable: never = how;
      return unreachable;
    }
  }
};

/** Bring the person to the session. The result is true when the person is in the session now. */
const reach = async (deps: Deps, how: Reach, id: string): Promise<CliResult<boolean>> => {
  const args = reachArgs(how, id);
  if (args === null) return ok(false);
  if (how === 'switch') {
    const switched = await tmuxStep(deps, args);
    return switched.ok ? ok(true) : switched;
  }
  const attached = await deps.runAttached(toolNames.tmux, args);
  if (!attached.ok) return attached;
  return attached.value === 0 ? ok(true) : failure(`${toolNames.tmux} attach ended with exit code ${attached.value}`);
};

/** Remove the session after a failed step, and say what happened. A session that is gone needs no removal. */
const cleanUpSession = async (deps: Deps, id: string): Promise<string> => {
  if (!(await sessionExists(deps, id))) {
    return (
      `The session ${id} is gone. The ${roles.coordinator} probably ended at once, or the ${toolNames.tmux} server stopped. ` +
      `Run ${toolNames.claude} in this shell to read its error.`
    );
  }
  const removed = await tmuxStep(deps, killSessionArgs(id));
  return removed.ok
    ? `The session ${id} was removed.`
    : `The session ${id} stays: remove it with "${commandLine(killSessionArgs(id))}".`;
};

/** Run the start steps. After the first step the session exists, so a later failure removes it again. */
const startSession = async (deps: Deps, id: string, steps: readonly TmuxArgs[]): Promise<CliResult<void>> => {
  for (const [index, args] of steps.entries()) {
    const done = await tmuxStep(deps, args);
    if (done.ok) continue;
    if (index === 0) return done;
    const outcome = await cleanUpSession(deps, id);
    return err({ ...done.error, message: `${done.error.message}. ${outcome}` });
  }
  return ok(undefined);
};

const text = (line: string): OutLine => ({ level: 'text', text: line });

/** The warning for a session whose coordinator pane stays after its program ended, with the remedy. */
const coordinatorEndedLines = (id: string, home: string): readonly OutLine[] => [
  { level: 'warn', text: `The ${roles.coordinator} of the session ${id} has ended.` },
  text(
    `The window ${tmuxNames.windowView} shows why. Remove the session with "${commandLine(killSessionArgs(id))}". ` +
      `Then run "${commandText(commands.start)} ${flagText(flags.home)} ${shellWord(home)}" again.`,
  ),
];

/** The last line of the output: where the person is now, or how to get to the session. */
const arrivalText = (how: Reach, arrived: boolean, id: string): string => {
  if (!arrived) return `Session ${id} runs. Attach with: ${attachHint(id)}`;
  if (how === 'switch') return `Switched to the session ${id}.`;
  return `Left the session ${id}. It still runs.`;
};

const dryRunOutput = (input: {
  readonly home: string;
  readonly id: string;
  readonly exists: boolean;
  readonly how: Reach;
  readonly problems: readonly string[];
  readonly plan: StartPlan | null;
  /** Notes about the files of the config, for example a local file that others can read. */
  readonly notes: readonly string[];
}): CommandOutput => {
  const { home, id, exists, how, problems, plan, notes } = input;
  const last = reachArgs(how, id);
  const shown = [...(plan?.shown ?? []), ...(last === null ? [] : [last])].map(commandLine);
  const proxy = plan?.proxy.label ?? null;
  return {
    lines: [
      text('Dry run: no session starts and no file changes.'),
      text(`${capitalize(roles.node)} home: ${home}`),
      ...problems.map((problem): OutLine => ({ level: 'warn', text: `${problem}. A real run stops here.` })),
      text(
        exists
          ? `The session ${id} runs already. A real run checks that it belongs to this ${roles.node} home.`
          : `The session ${id} does not run. A real run starts it.`,
      ),
      ...(plan === null ? [] : [text(`Proxy: ${proxy ?? values.noProxy}`)]),
      ...(shown.length === 0
        ? [text(`Session ${id} runs. Attach with: ${attachHint(id)}`)]
        : [text('Calls:'), ...shown.map((line) => text(`  ${line}`))]),
    ],
    json: { schema: schemaIds.start, session: id, started: false, attached: false, proxy, dryRun: true, calls: shown },
    warnings: [...notes, ...(plan?.warnings ?? []), ...(plan?.proxy.warning === undefined ? [] : [plan.proxy.warning])],
    failed: false,
  };
};

export const runStart = async (deps: Deps, options: StartOptions): Promise<CliResult<CommandOutput>> => {
  // The registration check of the lookup keeps a config file of a cloned repo out: its proxy would get the requests of
  // the session. A config that does not pass it is a stop here, before any proxy check or launch.
  const located = await locateHomeFolder(deps, options.home, readNodeIdentity);
  if (!located.ok) return located;
  const home = located.value.home;
  // The warning about instruction files comes before any change or launch, and it never stops the command.
  await warnInstructionFiles(deps, home);
  const loaded = await loadConfig(deps, home);
  if (!loaded.ok) return loaded;
  const id = loaded.value.core.node.id;
  const { dryRun } = options;
  // A real run sets a wide mode of the local file back to 600 before it uses the file. A dry run only names the command.
  const notes = await settleLocalMode(deps, home, !dryRun);
  if (!notes.ok) return notes;

  // The root checks come before the tool check, the proxy health request and any launch, also in a dry run. A warning is
  // printed and the command goes on. A failure is a stop (exit 4) with one remedy line, and nothing starts.
  const scan = await scanRoot(deps, home, loaded.value);
  for (const notice of rootNotices(scan)) deps.warn(notice);
  const clean = requireRootClean(scan);
  if (!clean.ok) return clean;
  // The safety block comes after the root checks and before any tool check, proxy request or launch, also in a dry run.
  const safety = await requireSafetyBlock(deps, home, loaded.value, dryRun);
  if (!safety.ok) return safety;

  const problems = await toolProblems(deps, !dryRun);
  if (!dryRun && problems.length > 0) {
    return failure(
      problems.join('. '),
      `Run "${commandText(commands.doctor)} ${flagText(flags.home)} ${home}" to check the tools.`,
    );
  }

  const exists = await sessionExists(deps, id);
  if (exists && !dryRun) {
    const own = await requireOwnSession(deps, id, home);
    if (!own.ok) return own;
  }
  // A session that runs already starts nothing, so it needs no proxy check and no launch.
  const plan = exists ? null : await planStart(deps, home, loaded.value);
  if (plan !== null && !plan.ok) return plan;
  const planned = plan === null ? null : plan.value;
  const how = reachOf(deps);

  if (dryRun) return ok(dryRunOutput({ home, id, exists, how, problems, plan: planned, notes: [...notes.value, ...safety.value] }));

  if (planned !== null) {
    const started = await startSession(deps, id, planned.steps);
    if (!started.ok) return started;
  }
  // A session that runs already can hold a coordinator pane that stays after its program ended.
  const ended = planned === null && (await coordinatorEnded(deps, id));
  const attached = await reach(deps, how, id);
  if (!attached.ok) return attached;

  return ok({
    lines: [
      ...(planned === null
        ? []
        : [text(`Started the session ${id} in ${home}. The ${roles.coordinator} runs in the window ${tmuxNames.windowView}.`)]),
      ...(ended ? coordinatorEndedLines(id, home) : []),
      text(arrivalText(how, attached.value, id)),
    ],
    json: {
      schema: schemaIds.start,
      session: id,
      started: planned !== null,
      attached: attached.value,
      proxy: planned?.proxy.label ?? null,
      ...(ended ? { coordinatorEnded: true } : {}),
    },
    warnings: [...notes.value, ...(planned?.warnings ?? []), ...(planned?.proxy.warning === undefined ? [] : [planned.proxy.warning])],
    failed: false,
  });
};
