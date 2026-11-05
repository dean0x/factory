import { resolve } from 'node:path';
import { failure, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { loadConfig, readNodeIdentity, settleLocalMode } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import { declinedHookText, ensureHookSettings, type HookSettingsOutcome } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { warnInstructionFiles } from '../core/instruction-files.js';
import { effectiveModes } from '../core/owner-record.js';
import { err, ok } from '../core/result.js';
import { shellWord } from '../core/shell-word.js';
import { toolNames } from '../core/tools.js';
import { launchArgv } from '../launch/argv.js';
import { attachArgs, attachHint, killSessionArgs, startSteps, switchArgs, type TmuxArgs } from '../launch/tmux.js';
import { coordinatorEnded, requireOwnSession, sessionExists, tmuxStep } from '../launch/tmux-run.js';
import {
  capitalize,
  commands,
  commandText,
  env,
  flags,
  flagText,
  hookSessions,
  places,
  program,
  roles,
  schemaIds,
  setupFileOf,
  tmuxNames,
  values,
} from '../names.js';
import { layoutOf } from '../state/layout.js';
import { claimActiveMachine } from '../state/active-machine.js';
import type { RecipeRegistry } from '../recipes/index.js';
import type { SetupTexts } from '../templates/types.js';
import { renderSetupText } from '../upgrade/render.js';
import { chooseProxy, newProxyAnswers, sessionProxyWish, type ProxyAnswers, type ProxyChoice } from '../workers/launch.js';
import { coordinatorResumeOf, recoverWorkers, type RecoveryReport } from '../workers/recovery.js';
import { requireSafetyBlock, toolProblems } from './launch-checks.js';
import { failsOnlyOnSetup, requireRootClean, rootNotices, scanRoot, withSetupAccepted } from './root-content.js';
import { acceptReason, settleSetup } from './setup-check.js';

export interface StartOptions {
  readonly home: string | undefined;
  readonly dryRun: boolean;
  /** True when the person gave the yes flag. It is the consent to the change of the hook settings. */
  readonly yes: boolean;
}

/** How the command shows the session to the person: attach, switch the client of tmux, or print how to attach. */
type Reach = 'attach' | 'switch' | 'print';

interface StartPlan {
  readonly proxy: ProxyChoice;
  readonly steps: readonly TmuxArgs[];
  /** The same steps, with the label of the proxy where the URL is. They are safe to print. */
  readonly shown: readonly TmuxArgs[];
  /** A project folder that is missing: the session does not get it. Also the reason that the coordinator does not resume. */
  readonly warnings: readonly string[];
  /** The id of the earlier session of the coordinator that the start resumes, or null for a new conversation. */
  readonly resumeId: string | null;
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

/** A tmux call as a person could type it, for the dry run. */
const commandLine = (args: TmuxArgs): string => [toolNames.tmux, ...args].map(shellWord).join(' ');

/**
 * Render the setup blocks again after the owner accepted a change: the texts are the bytes that the acceptance hashed. A
 * setup block that a person edited stays, and a notice names the command that puts the text back.
 */
const renderAcceptedSetup = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  texts: SetupTexts,
): Promise<CliResult<void>> => {
  const rendered = await renderSetupText(deps, home, config, await effectiveModes(deps, home, config), texts, commands.start);
  if (!rendered.ok) return rendered;
  if (rendered.value.wrote) deps.warn('Rendered the setup text again from the files that you accepted.');
  for (const name of rendered.value.kept) {
    deps.warn(
      `The block ${name} differs from ${setupFileOf(name)}, and ${program} kept it. ` +
        `Run "${commandText(commands.upgrade)}" to put the accepted text back. It keeps the old text in a backup file.`,
    );
  }
  return ok(undefined);
};

/**
 * The tmux calls that start the session, once with the real proxy URL and once with the label of the proxy. The coordinator
 * resumes its newest session when the pointer passes the owner check, and else it starts a new conversation (`coordinatorResumeOf`).
 * `answers` holds the proxy answers of the run: the recovery of the workers uses them, so each proxy is asked once.
 */
const planStart = async (
  deps: Deps,
  home: string,
  config: FactoryConfig,
  answers: ProxyAnswers,
): Promise<CliResult<StartPlan>> => {
  const { coordinatorDir, stateDir } = layoutOf(home);
  const proxy = await chooseProxy(deps, config, sessionProxyWish(config), answers);
  if (!proxy.ok) return proxy;
  const { core, recipe } = config;
  const projects = await presentProjects(deps, home, recipe.projects);
  if (!projects.ok) return projects;
  const resume = await coordinatorResumeOf(deps, home, core.node.id);
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
      agent: core.session.agent,
      projects: projects.value.folders,
      ...(resume.resumeId === null ? {} : { resumeId: resume.resumeId }),
    });
    return launch.ok ? ok(startSteps({ id: core.node.id, home, coordinatorDir, launch: launch.value })) : failure(launch.error);
  };
  const steps = stepsFor(proxy.value.baseUrl);
  if (!steps.ok) return steps;
  const shown = stepsFor(proxy.value.label === null ? null : `<${proxy.value.label}>`);
  if (!shown.ok) return shown;
  return ok({
    proxy: proxy.value,
    steps: steps.value,
    shown: shown.value,
    warnings: [...projects.value.warnings, ...(resume.warning === null ? [] : [resume.warning])],
    resumeId: resume.resumeId,
  });
};

/** What `start` did after it made the session: the workers that it resumed, skipped and could not start, or null when it could not list them. */
type Recovery = RecoveryReport | null;

/**
 * What `start` does after it made the session, and only then: the mark of the active machine, then each recorded worker. The mark
 * comes first, so the warning about another active machine shows before any worker runs. A fault never stops the start: the
 * session runs, so every problem here is a warning, and the exit code stays 0.
 */
const recoverSession = async (deps: Deps, home: string, config: FactoryConfig, answers: ProxyAnswers): Promise<Recovery> => {
  await claimActiveMachine(deps, home);
  const recovered = await recoverWorkers(deps, { home, config, proxyAnswers: answers });
  if (recovered.ok) return recovered.value;
  deps.warn(`The ${roles.worker}s are not resumed: ${recovered.error.message}. ${recovered.error.hint ?? ''}`.trimEnd());
  return null;
};

/** The lines about the recovery: the coordinator that resumes, and the workers that run again. A start that resumes nothing says nothing. */
const recoveryLines = (plan: StartPlan, recovery: Recovery): readonly OutLine[] => [
  ...(plan.resumeId === null ? [] : [text(`The ${roles.coordinator} resumes its earlier conversation.`)]),
  ...(recovery === null || recovery.resumed.length === 0
    ? []
    : [text(`Resumed the ${roles.worker}s: ${recovery.resumed.join(', ')}.`)]),
];

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

/** The lines of a dry run about the hook settings: the change that a real run makes, or none when the entries are in place. */
const hookLines = (hook: HookSettingsOutcome, yes: boolean): readonly OutLine[] =>
  hook.kind === 'would-write'
    ? [
        ...hook.change.split('\n').map(text),
        text(yes ? 'A real run writes this change.' : 'A real run asks before it writes this change.'),
      ]
    : [];

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
  /** What the check of the hook settings found. */
  readonly hook: HookSettingsOutcome;
  /** True when the person gave the yes flag. */
  readonly yes: boolean;
  /** Notes about the files of the config, for example a local file that others can read. */
  readonly notes: readonly string[];
}): CommandOutput => {
  const { home, id, exists, how, problems, plan, hook, yes, notes } = input;
  const last = reachArgs(how, id);
  const shown = [...(plan?.shown ?? []), ...(last === null ? [] : [last])].map(commandLine);
  const proxy = plan?.proxy.label ?? null;
  return {
    lines: [
      text('Dry run: no session starts and no file changes.'),
      text(`${capitalize(places.folder)}: ${home}`),
      ...problems.map((problem): OutLine => ({ level: 'warn', text: `${problem}. A real run stops here.` })),
      ...hookLines(hook, yes),
      text(
        exists
          ? `The session ${id} runs already. A real run checks that it belongs to this ${places.folder}.`
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

export const runStart = async (
  deps: Deps,
  options: StartOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  // The registration check of the lookup keeps a config file of a cloned repo out: its proxy would get the requests of
  // the session. A config that does not pass it is a stop here, before any proxy check or launch.
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.start,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  // The warning about instruction files comes before any change or launch, and it never stops the command.
  await warnInstructionFiles(deps, home);
  const loaded = await loadConfig(deps, home, registry);
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
  // A change of the setup text is the one stop that a question can end: when it is the only failure, the owner on a terminal
  // window accepts it here. Every other case stops with the line that names the accept command.
  const settled = scan.setup.kind === 'changed' && failsOnlyOnSetup(scan)
    ? await settleSetup(deps, { home, node: id, check: scan.setup, dryRun, reason: acceptReason(commands.start) })
    : null;
  if (settled !== null && !settled.ok) return settled;
  const clean = requireRootClean(settled === null ? scan : withSetupAccepted(scan));
  if (!clean.ok) return clean;
  // The safety block comes after the root checks and before any tool check, proxy request or launch, also in a dry run.
  const safety = await requireSafetyBlock(deps, home, loaded.value, dryRun);
  if (!safety.ok) return safety;
  // The setup blocks come after the link rule of the coordinator file, from the bytes that the acceptance hashed.
  if (settled !== null) {
    const rendered = await renderAcceptedSetup(deps, home, loaded.value, settled.value.texts);
    if (!rendered.ok) return rendered;
  }

  const problems = await toolProblems(deps, !dryRun);
  if (!dryRun && problems.length > 0) {
    return failure(
      problems.join('. '),
      `Run "${commandText(commands.doctor)} ${flagText(flags.home)} ${home}" to check the tools.`,
    );
  }

  // The hook settings of the coordinator come after the root checks and the tool check, and before the session lookup and any
  // launch. A no on a terminal window goes on without the hook. Any error of the writer is a stop with its own exit code.
  const hook = await ensureHookSettings(deps, {
    folder: layoutOf(home).coordinatorDir,
    session: hookSessions.coordinator,
    yes: options.yes,
    dryRun,
    command: commands.start,
  });
  if (!hook.ok) return hook;
  if (hook.value.kind === 'declined') deps.warn(declinedHookText(hook.value.file, commands.start));

  const exists = await sessionExists(deps, id);
  if (exists && !dryRun) {
    const own = await requireOwnSession(deps, id, home);
    if (!own.ok) return own;
  }
  // A session that runs already starts nothing, so it needs no proxy check and no launch. The run asks each proxy once.
  const answers = newProxyAnswers();
  const plan = exists ? null : await planStart(deps, home, loaded.value, answers);
  if (plan !== null && !plan.ok) return plan;
  const planned = plan === null ? null : plan.value;
  const how = reachOf(deps);

  if (dryRun) {
    return ok(
      dryRunOutput({ home, id, exists, how, problems, plan: planned, hook: hook.value, yes: options.yes, notes: [...notes.value, ...safety.value] }),
    );
  }

  if (planned !== null) {
    const started = await startSession(deps, id, planned.steps);
    if (!started.ok) return started;
  }
  // The recovery runs only for a session that this run made, and before the person is in the session.
  const recovery = planned === null ? null : await recoverSession(deps, home, loaded.value, answers);
  // A session that runs already can hold a coordinator pane that stays after its program ended.
  const ended = planned === null && (await coordinatorEnded(deps, id));
  const attached = await reach(deps, how, id);
  if (!attached.ok) return attached;

  return ok({
    lines: [
      ...(planned === null
        ? []
        : [
            text(`Started the session ${id} in ${home}. The ${roles.coordinator} runs in the window ${tmuxNames.windowView}.`),
            ...recoveryLines(planned, recovery),
          ]),
      ...(ended ? coordinatorEndedLines(id, home) : []),
      text(arrivalText(how, attached.value, id)),
    ],
    json: {
      schema: schemaIds.start,
      session: id,
      started: planned !== null,
      attached: attached.value,
      proxy: planned?.proxy.label ?? null,
      ...(planned === null ? {} : { coordinatorResumed: planned.resumeId !== null, workers: recovery }),
      ...(ended ? { coordinatorEnded: true } : {}),
    },
    warnings: [...notes.value, ...(planned?.warnings ?? []), ...(planned?.proxy.warning === undefined ? [] : [planned.proxy.warning])],
    failed: false,
  });
};
