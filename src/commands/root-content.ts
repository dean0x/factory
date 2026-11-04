import { basename, join, relative, resolve, sep } from 'node:path';
import { safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ignoredPathsOf, isWorkTreeRoot, trackedFilesOf, type TrackedList } from '../core/git.js';
import { originOfHome, type Origin } from '../core/home-index.js';
import { delegationReport, type DelegationReport } from '../core/owner-record.js';
import { comparable, isSameOrInside, isSameOrInsideFolder } from '../core/paths.js';
import { describeProjectPathIssue, projectFolderKey, projectPathIssue } from '../core/project-path.js';
import { ok } from '../core/result.js';
import {
  describeTrackedProblems,
  ignoreProbesOf,
  isClaudeSettingsPath,
  isInstructionPath,
  namedItems,
  REMOVE_REMEDY,
  requireNoTrackedLinks,
  shownPath,
  TRACKED_CAP_MESSAGE,
  TRACKED_CAP_REMEDY,
  trackedProblems,
  trackedSetOf,
  trackedUnder,
} from '../core/root-paths.js';
import {
  acceptEditsMode,
  address,
  checkIds,
  claudeSettings,
  commands,
  commandText,
  dirs,
  env,
  files,
  homeIndex,
  places,
  program,
  reservedRootNames,
  roles,
  trackedFiles,
  values,
} from '../names.js';
import { textHasToken } from '../safety/secrets.js';
import { analyzeSettings } from '../safety/settings.js';
import { leftoverTempFolders } from './init-home.js';
import { checkRootSetup, checkSetupSet, notListedStop, type SetupCheck } from './setup-check.js';

/**
 * The checks of the root repo and of the settings of every session folder (design 4.4, F-17c): only a security boundary
 * fails, and every other check warns. `doctor` shows the findings as check results, and `start` stops (exit 4) on a
 * failure and prints the warnings. A finding has the id of its check, its level, the text, and a remedy line.
 */

export type FindingLevel = 'warn' | 'fail';

export interface RootFinding {
  readonly id: string;
  readonly level: FindingLevel;
  readonly text: string;
  /** The line that names the fix. A warning that has no fix to name has an empty remedy. */
  readonly remedy: string;
}

export interface RootScan {
  readonly origin: Origin;
  readonly findings: readonly RootFinding[];
  /** What the store of the setup acceptances says about the subject of the acceptance. */
  readonly setup: SetupCheck;
  /** The finding of `findings` that the setup check gave, or null when the check gave none. */
  readonly setupFinding: RootFinding | null;
  /** The mode of each approval point and the active delegations, or null when the config is not valid. */
  readonly delegations: DelegationReport | null;
}

export interface RootCheckResult {
  readonly id: string;
  readonly level: 'ok' | FindingLevel;
  readonly text: string;
}

/** The bounds of the token scan: the most files that it reads, and the most bytes that it reads from one file. */
export interface TextCaps {
  readonly maxCount: number;
  readonly maxFileBytes: number;
}

const DELEGATED = values.approvalModes[1];

/** The most failures that the stop of `start` names. The message counts the rest. */
const MAX_NAMED_FAILURES = 3;

/** The most settings files that the check reads in one session folder, and the most temp folders that it asks git about. */
const MAX_SETTINGS_FILES = 64;
const MAX_TEMP_FOLDERS = 16;

const NUL = '\u0000';
const USER_FOLDER_PATH = /(?:^|[^A-Za-z0-9_.-])(?:\/Users\/[^\s/\\]+|\/home\/[^\s/\\]+|[A-Za-z]:\\Users\\[^\s\\]+)/;

const doctorAgain = `run "${commandText(commands.doctor)}"`;
const NOT_VALID = `${files.config} is not valid`;

const finding = (id: string, level: FindingLevel, text: string, remedy = ''): RootFinding => ({ id, level, text, remedy });

const notChecked = (id: string, reason: string): RootFinding => finding(id, 'warn', `not checked: ${reason}`);

/** A failure from the error of a core function: its message, and its remedy line or the given one. */
const failureFrom = (id: string, error: CliError, remedy: string): RootFinding =>
  finding(id, 'fail', error.message, error.hint ?? remedy);

const sentence = (entry: RootFinding): string => (entry.remedy === '' ? `${entry.text}.` : `${entry.text}. ${entry.remedy}`);

const quoted = (line: string): string => `"${line}"`;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const homeRelative = (home: string, path: string): string => relative(home, path).split(sep).join('/');

/** The findings without a repeat: a failure to resolve links gives the same message for each folder. */
const withoutRepeats = (findings: readonly RootFinding[]): readonly RootFinding[] => {
  const seen = new Set<string>();
  return findings.filter((entry) => {
    const key = `${entry.level}\0${entry.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// ---- The root repo: what git tracks and what git ignores ----

interface RepoScan {
  readonly findings: readonly RootFinding[];
  /** The paths that git tracks, or null when git can not list them. */
  readonly tracked: readonly string[] | null;
  /** True when the list reached its cap. */
  readonly capped: boolean;
  /** The check of the files that the owner must accept, or null when a stop before it made the check useless. */
  readonly setup: SetupScan | null;
}

/** The setup check, and the finding that it gave. */
interface SetupScan {
  readonly check: SetupCheck;
  readonly finding: RootFinding | null;
}

const listTracked = async (deps: Deps, home: string): Promise<TrackedList | null> => {
  if (!(await isWorkTreeRoot(deps, home))) return null;
  const list = await trackedFilesOf(deps, home);
  return list.ok ? list.value : null;
};

/** The ignore rules. The local file and the state folder are a stop. The other folders give one warning. */
const scanIgnoreRules = async (
  deps: Deps,
  home: string,
  tracked: readonly string[],
  projectPaths: readonly string[],
): Promise<readonly RootFinding[]> => {
  const id = checkIds.rootRepo;
  const probes = ignoreProbesOf(projectPaths);
  const required = [
    { line: files.localConfig, probe: probes.local },
    { line: `${dirs.state}/`, probe: probes.state },
  ];
  const answer = await ignoredPathsOf(deps, home, [probes.local, probes.state]);
  if (!answer.ok) return [notChecked(id, answer.error.message)];
  // Git never ignores a path that it tracks. The tracked path is the problem, and it has its own finding.
  const missing = required.filter((entry) => !answer.value.has(entry.probe) && !tracked.includes(entry.probe));

  const temps = await leftoverTempFolders(deps, home);
  const advised = [
    { line: `${dirs.coordinator}/`, probe: probes.coordinator },
    { line: `${dirs.workCopies}/`, probe: probes.workCopies },
    ...projectPaths.map((path, index) => ({ line: `${path}/`, probe: probes.clones[index] ?? join(path, files.claudeMd) })),
    ...(temps.ok ? temps.value.slice(0, MAX_TEMP_FOLDERS) : []).map((folder) => ({
      line: `${basename(folder)}/`,
      probe: join(basename(folder), files.nodeState),
    })),
  ];
  const second = await ignoredPathsOf(deps, home, advised.map((entry) => entry.probe));
  if (!second.ok) return [notChecked(id, second.error.message)];
  const loose = advised.filter((entry) => !second.value.has(entry.probe));

  const lines = missing.map((entry) => entry.line);
  return [
    ...(lines.length === 0
      ? []
      : [
          finding(
            id,
            'fail',
            `git does not ignore ${lines.join(' and ')}, so private data could go out with the next commit`,
            `Add the ${plural(lines.length, 'line', 'lines')} ${lines.map(quoted).join(' and ')} to ${files.gitignore}, then ${doctorAgain} again.`,
          ),
        ]),
    ...(loose.length === 0
      ? []
      : [
          finding(
            id,
            'warn',
            `git does not ignore ${namedItems(loose.map((entry) => shownPath(entry.line)))}`,
            `Add the ${plural(loose.length, 'line', 'lines')} ${loose.map((entry) => quoted(entry.line)).join(' and ')} to ${files.gitignore}.`,
          ),
        ]),
  ];
};

/**
 * The finding of a setup check: a failure for every state that is not accepted. A first acceptance and a change are a
 * stop for the commands that start a session or render the setup text, and `doctor` fails with the same line.
 */
const setupScanOf = (check: SetupCheck): SetupScan => ({
  check,
  finding:
    check.kind === 'empty' || check.kind === 'accepted'
      ? null
      : finding(checkIds.rootRepo, 'fail', check.stop.text, check.stop.remedy),
});

const scanRepo = async (
  deps: Deps,
  home: string,
  origin: Origin,
  projectPaths: readonly string[],
  config: FactoryConfig | null,
): Promise<RepoScan> => {
  const id = checkIds.rootRepo;
  const received = origin === homeIndex.origins.received;
  const list = await listTracked(deps, home);
  if (list === null) {
    const stop = notListedStop(home);
    return {
      findings: [
        received
          ? finding(id, 'fail', stop.text, stop.remedy)
          : notChecked(id, `git cannot list the files that git tracks in ${home}`),
      ],
      tracked: null,
      capped: false,
      setup: null,
    };
  }
  const tracked = list.paths;
  const findings: RootFinding[] = [];
  const capStop = list.reachedCap && received;
  if (capStop) findings.push(finding(id, 'fail', TRACKED_CAP_MESSAGE, TRACKED_CAP_REMEDY));

  const set = trackedSetOf(tracked);
  let linkStop = false;
  if (received && !capStop) {
    const linked = await requireNoTrackedLinks(deps, home, set);
    if (!linked.ok) {
      linkStop = true;
      findings.push(failureFrom(id, linked.error, `Replace the link with a plain file, then ${doctorAgain}.`));
    }
  }

  const problems = trackedProblems(tracked, projectPaths);
  const stops = problems.filter((problem) => problem.kind !== 'clone' || received);
  const clones = problems.filter((problem) => problem.kind === 'clone' && !received);
  const workCopies = trackedUnder(tracked, dirs.workCopies);
  if (stops.length > 0) {
    findings.push(finding(id, 'fail', `the git repo of the ${places.folder} tracks files that must stay on this machine: ${describeTrackedProblems(stops)}`, REMOVE_REMEDY));
  }
  if (clones.length > 0) {
    findings.push(finding(id, 'warn', `the git repo of the ${places.folder} tracks ${describeTrackedProblems(clones)}`, 'Stop tracking them with "git rm --cached", or keep them on purpose.'));
  }
  if (workCopies.length > 0) {
    findings.push(
      finding(
        id,
        'warn',
        `the git repo of the ${places.folder} tracks ${namedItems(workCopies.map(shownPath))} in the work copies folder`,
        'Stop tracking them with "git rm --cached", or keep them on purpose.',
      ),
    );
  }
  if (!received) {
    const covered = new Set([...problems.map((problem) => problem.path), ...workCopies]);
    const shared = tracked.filter((path) => !covered.has(path) && (isInstructionPath(path) || isClaudeSettingsPath(path)));
    if (shared.length > 0) {
      findings.push(
        finding(
          id,
          'warn',
          `the git repo of the ${places.folder} tracks ${namedItems(shared.map(shownPath))}, an instruction file or a settings file that goes to every receiver of the ${places.folder}`,
          'Stop tracking the file with "git rm --cached", or keep it on purpose.',
        ),
      );
    }
  }

  findings.push(...(await scanIgnoreRules(deps, home, tracked, projectPaths)));
  let setup: SetupScan | null = null;
  if (received && !capStop && !linkStop && stops.length === 0) {
    setup = setupScanOf(await checkSetupSet(deps, { home, set, node: config?.core.node.id ?? null, received }));
    if (setup.finding !== null) findings.push(setup.finding);
  }
  return { findings, tracked, capped: list.reachedCap, setup };
};

// ---- The tracked text files: tokens, file URLs and user folder paths ----

const named = (paths: readonly string[], one: string, many: string): string =>
  `${namedItems(paths)} ${plural(paths.length, one, many)}`;

/**
 * The scan of the tracked text files (design 4.4). It reads at most `caps.maxCount` files and at most `caps.maxFileBytes`
 * bytes of one file, and it names every file that it did not read: a warning, never a gap in silence. A token is a failure,
 * and the finding names the files and never the value. A `file` URL and a user folder path are a warning.
 */
export const scanTrackedTexts = async (
  deps: Deps,
  home: string,
  tracked: readonly string[],
  caps: TextCaps = trackedFiles,
): Promise<readonly RootFinding[]> => {
  const id = checkIds.rootFiles;
  const unread: string[] = tracked.slice(caps.maxCount).map(shownPath);
  const withToken: string[] = [];
  const withAddress: string[] = [];
  for (const path of tracked.slice(0, caps.maxCount)) {
    const shown = shownPath(path);
    const absolute = join(home, path);
    const kind = await deps.fs.lstat(absolute);
    if (!kind.ok) {
      unread.push(`${shown} (cannot be read)`);
      continue;
    }
    if (kind.value === 'link') {
      unread.push(`${shown} (a link)`);
      continue;
    }
    if (kind.value !== 'file') continue;
    const info = await deps.fs.statInfo(absolute);
    if (info.ok && info.value !== null && info.value.size > caps.maxFileBytes) {
      unread.push(`${shown} (more than ${caps.maxFileBytes} bytes)`);
      continue;
    }
    const text = await deps.fs.readTextLimited(absolute, caps.maxFileBytes);
    if (!text.ok) {
      unread.push(`${shown} (cannot be read)`);
      continue;
    }
    if (text.value.includes(NUL)) continue;
    if (textHasToken(text.value)) withToken.push(shown);
    if (text.value.toLowerCase().includes(address.scheme) || USER_FOLDER_PATH.test(text.value)) withAddress.push(shown);
  }
  return [
    ...(withToken.length === 0
      ? []
      : [
          finding(
            id,
            'fail',
            `${named(withToken, 'holds', 'hold')} a value that looks like a password or a token`,
            `Remove the value from the file, put it in ${files.localConfig}, then ${doctorAgain}.`,
          ),
        ]),
    ...(withAddress.length === 0
      ? []
      : [
          finding(
            id,
            'warn',
            `${named(withAddress, 'holds', 'hold')} a file URL or a user folder path, which does not work on another machine`,
            'Use an address that a host serves, or a path inside the folder, or keep it on purpose.',
          ),
        ]),
    ...(unread.length === 0
      ? []
      : [
          finding(
            id,
            'warn',
            `the scan for tokens did not read ${namedItems(unread)}`,
            'Check them by hand, or remove them from git with "git rm --cached".',
          ),
        ]),
  ];
};

// ---- The project folders ----

const RESERVED_KEYS: ReadonlySet<string> = new Set([...reservedRootNames, dirs.state].map(projectFolderKey));

const projectRemedy = `Use a project folder inside the ${places.folder} that ${program} does not keep for itself, then ${doctorAgain} again.`;

/** A project folder resolves inside the root, and not to the root itself or into a folder that the root keeps. */
const scanProjects = async (deps: Deps, home: string, config: FactoryConfig | null): Promise<readonly RootFinding[]> => {
  const id = checkIds.projectPaths;
  if (config === null) return [notChecked(id, NOT_VALID)];
  const projects = config.recipe.projects;
  if (projects.length === 0) return [];
  const root = await deps.fs.realpath(home);
  if (!root.ok) return [notChecked(id, root.error.message)];
  const findings: RootFinding[] = [];
  for (const project of projects) {
    const label = `project ${project.id} (${shownPath(project.path)})`;
    const issue = projectPathIssue(project.path);
    if (issue !== null) {
      findings.push(finding(id, 'fail', `${label} ${describeProjectPathIssue(issue)}`, projectRemedy));
      continue;
    }
    const folder = join(home, project.path);
    const kind = await deps.fs.stat(folder);
    if (!kind.ok) {
      findings.push(notChecked(id, kind.error.message));
      continue;
    }
    if (kind.value === null) continue;
    const real = await deps.fs.realpath(folder);
    if (!real.ok) {
      findings.push(notChecked(id, real.error.message));
      continue;
    }
    const [base, target] = [comparable(deps, root.value), comparable(deps, real.value)];
    const first = relative(base, target).split(sep)[0] ?? '';
    if (target === base) {
      findings.push(finding(id, 'fail', `${label} resolves to the ${places.folder} itself`, projectRemedy));
    } else if (!isSameOrInside(base, target)) {
      findings.push(finding(id, 'fail', `${label} resolves outside the ${places.folder}: ${shownPath(real.value)}`, projectRemedy));
    } else if (RESERVED_KEYS.has(projectFolderKey(first))) {
      findings.push(finding(id, 'fail', `${label} resolves into ${shownPath(first)}, a folder that ${program} keeps for itself`, projectRemedy));
    }
  }
  return findings;
};

// ---- The settings of the session folders ----

interface SettingsSource {
  readonly absolute: string;
  readonly display: string;
  /** The place for the warning that a settings file is there, or null where a settings file is normal. */
  readonly presence: string | null;
}

const isSettingsName = (name: string): boolean => name.startsWith(claudeSettings.prefix) && name.endsWith(claudeSettings.suffix);

/** The user settings folder of Claude Code. A check never reads in it: its settings are the choice of the user. */
const userSettingsFolder = (deps: Deps): string | null => {
  const userHome = deps.env[env.userHome];
  return userHome === undefined || userHome === '' ? null : join(resolve(userHome), dirs.claude);
};

const inUserFolder = async (deps: Deps, userFolder: string | null, path: string): Promise<CliResult<boolean>> =>
  userFolder === null ? ok(false) : isSameOrInsideFolder(deps, userFolder, resolve(path));

/** The settings files that a folder holds: the files of its settings folder. A folder with none gives nothing. */
const settingsOfFolder = async (
  deps: Deps,
  home: string,
  userFolder: string | null,
  folder: { readonly path: string; readonly presence: string | null },
): Promise<{ readonly sources: readonly SettingsSource[]; readonly findings: readonly RootFinding[] }> => {
  const id = checkIds.permissionMode;
  const settingsFolder = join(folder.path, dirs.claude);
  const shown = homeRelative(home, settingsFolder);
  const guard = await inUserFolder(deps, userFolder, settingsFolder);
  if (!guard.ok) return { sources: [], findings: [notChecked(id, guard.error.message)] };
  if (guard.value) {
    return { sources: [], findings: [notChecked(id, `${shown} is, or is inside, the user settings folder of Claude Code`)] };
  }
  const kind = await deps.fs.stat(settingsFolder);
  if (!kind.ok) return { sources: [], findings: [notChecked(id, kind.error.message)] };
  if (kind.value !== 'dir') return { sources: [], findings: [] };
  const names = await deps.fs.list(settingsFolder);
  if (!names.ok) return { sources: [], findings: [notChecked(id, names.error.message)] };
  const settings = names.value.filter(isSettingsName).sort();
  return {
    sources: settings.slice(0, MAX_SETTINGS_FILES).map((name) => ({
      absolute: join(settingsFolder, name),
      display: homeRelative(home, join(settingsFolder, name)),
      presence: folder.presence,
    })),
    findings:
      settings.length > MAX_SETTINGS_FILES
        ? [notChecked(id, `${shown} holds more than ${MAX_SETTINGS_FILES} settings files, and ${program} read the first ${MAX_SETTINGS_FILES}`)]
        : [],
  };
};

/** One settings file: its failures (a setting that skips the permission prompts, a change of the session marker) and warnings. */
const judgeSettings = (source: SettingsSource, text: string): readonly RootFinding[] => {
  const id = checkIds.permissionMode;
  const facts = analyzeSettings(text);
  const shown = shownPath(source.display);
  const reasons = [
    ...(facts.skips.length === 0 ? [] : [`skips the permission checks (${facts.skips.join('; ')})`]),
    ...(facts.changesSessionMarker ? [`sets or clears ${env.session} in its env values`] : []),
  ];
  const wholeTool = facts.wholeToolRules.map(shownPath);
  const narrow = facts.narrowRules.map(shownPath);
  return [
    ...(reasons.length === 0
      ? []
      : [finding(id, 'fail', `${shown} ${reasons.join(' and ')}`, `Remove the setting from ${shown}, then ${doctorAgain}.`)]),
    ...(facts.valid ? [] : [finding(id, 'warn', `${shown} is not valid JSON, so Claude Code does not read it`, `Fix or remove ${shown}.`)]),
    ...(source.presence === null
      ? []
      : [finding(id, 'warn', `${shown} is a settings file in ${source.presence}, and the sessions of Claude Code read it`, 'Remove the file, or keep it on purpose.')]),
    ...(wholeTool.length === 0
      ? []
      : [finding(id, 'warn', `${shown} allows every use of ${plural(wholeTool.length, 'a tool', 'tools')}: ${namedItems(wholeTool)}`, `Narrow the rule in ${shown}, or keep it on purpose.`)]),
    ...(narrow.length === 0
      ? []
      : [finding(id, 'warn', `${shown} allows ${namedItems(narrow)} with no prompt`, `Check the ${plural(narrow.length, 'rule', 'rules')} in ${shown}, or keep ${plural(narrow.length, 'it', 'them')} on purpose.`)]),
    ...(facts.acceptEdits
      ? [finding(id, 'warn', `${shown} sets the default mode ${acceptEditsMode}, so file edits need no prompt`, `Remove the setting from ${shown}, or keep it on purpose.`)]
      : []),
    ...(facts.approvesMcp.length === 0
      ? []
      : [finding(id, 'warn', `${shown} approves the MCP servers of a project (${facts.approvesMcp.join(', ')})`, `Remove the setting from ${shown}, or keep it on purpose.`)]),
  ];
};

/**
 * The settings files that a session reads from the factory folder: the files in the settings folder of the factory folder
 * itself, of the coordinator folder and of each project folder, and each Claude settings path that the root repo tracks,
 * at any depth (AC-21). A file is read once. The user settings folder of Claude Code is never read.
 */
const scanSettings = async (
  deps: Deps,
  home: string,
  projectPaths: readonly string[],
  tracked: readonly string[],
): Promise<readonly RootFinding[]> => {
  const id = checkIds.permissionMode;
  const userFolder = userSettingsFolder(deps);
  const folders = [
    { path: home, presence: null },
    { path: join(home, dirs.coordinator), presence: `the ${roles.coordinator} folder` },
    ...projectPaths.map((path) => ({ path: join(home, path), presence: 'a project folder' })),
  ];
  const sources = new Map<string, SettingsSource>();
  const findings: RootFinding[] = [];
  for (const folder of folders) {
    const found = await settingsOfFolder(deps, home, userFolder, folder);
    findings.push(...found.findings);
    for (const source of found.sources) sources.set(source.absolute, source);
  }
  const unread: string[] = [];
  for (const path of tracked.filter(isClaudeSettingsPath)) {
    const absolute = join(home, path);
    if (sources.has(absolute)) continue;
    const guard = await inUserFolder(deps, userFolder, absolute);
    if (!guard.ok) {
      findings.push(notChecked(id, guard.error.message));
      continue;
    }
    if (guard.value) continue;
    const kind = await deps.fs.lstat(absolute);
    if (!kind.ok) {
      unread.push(`${shownPath(path)} (cannot be read)`);
      continue;
    }
    if (kind.value === 'link') unread.push(`${shownPath(path)} (a link)`);
    else if (kind.value === 'file') sources.set(absolute, { absolute, display: path, presence: null });
  }
  for (const source of sources.values()) {
    const text = await deps.fs.readTextLimited(source.absolute, trackedFiles.maxFileBytes);
    if (text.ok) findings.push(...judgeSettings(source, text.value));
    else unread.push(`${shownPath(source.display)} (cannot be read)`);
  }
  return withoutRepeats([...findings, ...(unread.length === 0 ? [] : [notChecked(id, `cannot read ${namedItems(unread)}`)])]);
};

// ---- The approval points ----

const delegationFindings = (report: DelegationReport): readonly RootFinding[] =>
  report.unmatched.map((point) =>
    finding(
      checkIds.delegations,
      'warn',
      `${point} is set to ${DELEGATED} in ${files.localConfig}, but the approval records hold no matching record, so its mode is ${roles.owner}`,
      `Run "${commandText(commands.init)}" in a terminal window outside a ${places.session}.`,
    ),
  );

/** The mode of each approval point, in the order of the recipe: an active delegation shows the time of its record. */
const modesLine = (report: DelegationReport): string =>
  Object.entries(report.modes)
    .map(([point, mode]) => {
      const active = report.active.find((entry) => entry.point === point);
      return active === undefined ? `${point}: ${mode}` : `${point}: ${DELEGATED} since ${active.at}`;
    })
    .join('; ');

// ---- The scan, and what doctor and start do with it ----

/**
 * Run every root check. The scan only reads. The origin of the root comes from the factory list, and a root with no entry
 * counts as received. A config that is not valid gives no project folders and no approval points, and the checks that
 * need them say so.
 */
export const scanRoot = async (deps: Deps, home: string, config: FactoryConfig | null): Promise<RootScan> => {
  const origin = await originOfHome(deps, home);
  const projectPaths =
    config === null ? [] : config.recipe.projects.map((project) => project.path).filter((path) => projectPathIssue(path) === null);
  const repo = await scanRepo(deps, home, origin, projectPaths, config);
  const received = origin === homeIndex.origins.received;
  const readTexts = repo.tracked !== null && !(repo.capped && received);
  const texts = readTexts ? await scanTrackedTexts(deps, home, repo.tracked ?? []) : [];
  const capNote =
    repo.capped && !received
      ? [
          finding(
            checkIds.rootFiles,
            'warn',
            `the git repo of the ${places.folder} tracks more than ${trackedFiles.maxCount} files, and the scan for tokens read the first ${trackedFiles.maxCount}`,
            'Remove the files that the folder does not need from git with "git rm --cached".',
          ),
        ]
      : [];
  const projects = await scanProjects(deps, home, config);
  const settings = await scanSettings(deps, home, projectPaths, repo.tracked ?? []);
  const delegations = config === null ? null : await delegationReport(deps, home, config);
  // A received root checked its files in the scan of the repo. An own root accepts its setup text, which is there whether
  // git tracks it or not.
  const setup =
    repo.setup ??
    (received
      ? setupScanOf({ kind: 'empty' })
      : setupScanOf(await checkRootSetup(deps, { home, node: config?.core.node.id ?? null, received })));
  return {
    origin,
    findings: [
      ...repo.findings,
      ...(received || setup.finding === null ? [] : [setup.finding]),
      ...texts,
      ...capNote,
      ...projects,
      ...settings,
      ...(delegations === null ? [] : delegationFindings(delegations)),
    ],
    setup: setup.check,
    setupFinding: setup.finding,
    delegations,
  };
};

/**
 * True when the setup acceptance is the only failure. A failure of another check stops first, with every reason named and
 * no question, because an accept step cannot make the run go on.
 */
export const failsOnlyOnSetup = (scan: RootScan): boolean =>
  scan.setupFinding !== null && scan.findings.every((entry) => entry.level !== 'fail' || entry === scan.setupFinding);

/** The scan after the owner accepted the change of the setup: the stop for the setup is gone. */
export const withSetupAccepted = (scan: RootScan): RootScan => ({
  ...scan,
  setup: scan.setup.kind === 'changed' ? { kind: 'accepted', setup: scan.setup.setup } : scan.setup,
  setupFinding: null,
  findings: scan.findings.filter((entry) => entry !== scan.setupFinding),
});

const OK_TEXT: Readonly<Record<string, string>> = {
  [checkIds.rootRepo]: `the git repo of the ${places.folder} tracks no path that must stay on this machine, and git ignores ${files.localConfig} and ${dirs.state}/`,
  [checkIds.rootFiles]: 'no tracked text file holds a token, a file URL or a user folder path',
  [checkIds.projectPaths]: `every project folder is inside the ${places.folder}`,
  [checkIds.permissionMode]: 'no settings file skips the permission checks',
};

const RESULT_ORDER = [checkIds.rootRepo, checkIds.rootFiles, checkIds.projectPaths, checkIds.permissionMode, checkIds.delegations];

const resultOf = (scan: RootScan, id: string): RootCheckResult => {
  const own = scan.findings.filter((entry) => entry.id === id);
  const level = own.some((entry) => entry.level === 'fail') ? 'fail' : own.length > 0 ? 'warn' : 'ok';
  if (id === checkIds.delegations) {
    if (scan.delegations === null) return { id, level: 'warn', text: `not checked: ${NOT_VALID}` };
    return { id, level, text: [modesLine(scan.delegations), ...own.map(sentence)].join('. ') };
  }
  return { id, level, text: own.length === 0 ? (OK_TEXT[id] ?? '') : own.map(sentence).join(' ') };
};

/** One result for each root check, in a fixed order, for `doctor`. */
export const rootCheckResults = (scan: RootScan): readonly RootCheckResult[] => RESULT_ORDER.map((id) => resultOf(scan, id));

export const hasRootFailure = (scan: RootScan): boolean => scan.findings.some((entry) => entry.level === 'fail');

/**
 * The stop of `start` (exit 4): the failures, at most three of them by name, and one line with the distinct remedies.
 * A warning never stops. Nothing starts after a stop.
 */
export const requireRootClean = (scan: RootScan): CliResult<void> => {
  const failures = scan.findings.filter((entry) => entry.level === 'fail');
  if (failures.length === 0) return ok(undefined);
  const shown = failures.slice(0, MAX_NAMED_FAILURES).map((entry) => entry.text);
  const rest = failures.length - shown.length;
  const remedies = [...new Set(failures.map((entry) => entry.remedy).filter((remedy) => remedy !== ''))];
  return safetyRefusal(`${shown.join('; ')}${rest > 0 ? ` and ${rest} more` : ''}`, remedies.join(' '));
};

/** The lines that `start` prints before it acts: each warning with its remedy, and the approval points that are delegated. */
export const rootNotices = (scan: RootScan): readonly string[] => [
  ...scan.findings.filter((entry) => entry.level === 'warn').map(sentence),
  ...(scan.delegations === null || scan.delegations.active.length === 0
    ? []
    : [`Approval points with the mode ${DELEGATED}: ${scan.delegations.active.map((entry) => `${entry.point} since ${entry.at}`).join(', ')}.`]),
];
