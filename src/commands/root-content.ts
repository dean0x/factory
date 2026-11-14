import { basename, join, relative, sep } from 'node:path';
import { safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import { isOwnSettingsText } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import {
  blobTextOf,
  headEntriesAt,
  ignoredPathsOf,
  isFileMode,
  isWorkTreeRoot,
  LINK_MODE,
  trackedFilesOf,
  type TrackedList,
  type TreeEntry,
} from '../core/git.js';
import { originOfHome, type Origin } from '../core/home-index.js';
import { delegationReport, type DelegationReport } from '../core/owner-record.js';
import { comparable, isSameOrInside, isWrittenInside, userClaudeFolderOf } from '../core/paths.js';
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
  claudeSettingKeys,
  claudeSettings,
  commands,
  commandText,
  dirs,
  env,
  files,
  homeIndex,
  localSettingsFile,
  places,
  planMode,
  program,
  reservedRootNames,
  roles,
  settingsSeenNote,
  statuslineKeyPath,
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

/** The sentence that goes before the remedy for a status line that the program did not write. It tells the owner to check the command first, then names the way to keep it. */
const KEEP_STATUS_LINE = `Check the status line command first. If you trust it, set ${statuslineKeyPath} in ${files.localConfig} to it; ${program} runs it and shows its output. `;

const NOT_VALID = `${files.config} is not valid`;

/** The remedy for a security check that git could not finish: git must work in the factory folder again. */
const GIT_REMEDY = `Check that git works in the ${places.folder}, then ${doctorAgain}.`;

/** The stop for a list of tracked files over its cap on your own factory, and its remedy line. */
const OWN_CAP_MESSAGE = `the list of files that git tracks in the ${places.folder} is too long for ${program} to check in full (the most is ${trackedFiles.maxCount} files)`;
const OWN_CAP_REMEDY = `Remove the files that the ${places.folder} does not need from git with "git rm --cached", commit the change, then ${doctorAgain}.`;

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

/** The tracked paths, null when the folder is not the top of a work tree, or the error when git is there and fails. */
const listTracked = async (deps: Deps, home: string): Promise<CliResult<TrackedList | null>> => {
  if (!(await isWorkTreeRoot(deps, home))) return ok(null);
  return trackedFilesOf(deps, home);
};

/**
 * The ignore rules. The local file and the state folder are a stop, also when git can not answer for them: a check that
 * did not finish is no pass. The other folders give one warning, also when git can not answer for them.
 */
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
  if (!answer.ok) return [finding(id, 'fail', answer.error.message, GIT_REMEDY)];
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
  const listed = await listTracked(deps, home);
  const list = listed.ok ? listed.value : null;
  if (list === null) {
    const stop = notListedStop(home);
    const unlisted = received
      ? finding(id, 'fail', stop.text, stop.remedy)
      : listed.ok
        ? notChecked(id, `git cannot list the files that git tracks in ${home}`)
        : failureFrom(id, listed.error, GIT_REMEDY);
    return { findings: [unlisted], tracked: null, capped: false, setup: null };
  }
  const tracked = list.paths;
  const findings: RootFinding[] = [];
  // A list at its cap is not complete, so the checks of the tracked paths can not finish: a stop on every factory.
  const capStop = list.reachedCap;
  if (capStop) {
    findings.push(
      received ? finding(id, 'fail', TRACKED_CAP_MESSAGE, TRACKED_CAP_REMEDY) : finding(id, 'fail', OWN_CAP_MESSAGE, OWN_CAP_REMEDY),
    );
  }

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
    if (text.value.includes(NUL)) {
      unread.push(`${shown} (binary or UTF-16)`);
      continue;
    }
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
  /** True for the work copy of a worker, whose session must keep its hooks. A file there that turns off every hook is a failure. */
  readonly requiresHooks: boolean;
}

const isSettingsName = (name: string): boolean => name.startsWith(claudeSettings.prefix) && name.endsWith(claudeSettings.suffix);

/**
 * True when `path` is the user settings folder of Claude Code or is inside it. A check never reads in it: its settings are
 * the choice of the user. The two paths are compared as they are written, so that nothing asks about that folder.
 */
const inUserFolder = (deps: Deps, userFolder: string | null, path: string): boolean =>
  userFolder !== null && isWrittenInside(deps, userFolder, path);

interface FolderSettings {
  readonly sources: readonly SettingsSource[];
  readonly findings: readonly RootFinding[];
}

const NO_SETTINGS: FolderSettings = { sources: [], findings: [] };

/** The stop for a folder that the scan did not follow, because a link may lead out of the factory folder. */
const linkStop = (id: string, shown: string): FolderSettings => ({
  sources: [],
  findings: [
    finding(
      id,
      'fail',
      `${shown} is a link, so ${program} does not use it`,
      `Make ${shown} a plain folder, or remove it, then ${doctorAgain}.`,
    ),
  ],
});

/** The stop for a folder that the scan could not read to the end. */
const unfinishedStop = (id: string, shown: string, reason: string): FolderSettings => ({
  sources: [],
  findings: [
    finding(
      id,
      'fail',
      `the scan of ${shown} did not finish: ${reason}`,
      `Make ${shown} a folder that ${program} can read, or remove it, then ${doctorAgain}.`,
    ),
  ],
});

/** The stop for a settings folder that holds more settings files than the check reads. */
const tooManySettings = (id: string, shown: string): RootFinding =>
  finding(
    id,
    'fail',
    `${shown} holds more than ${MAX_SETTINGS_FILES} settings files, and ${program} does not read all of them`,
    `Move the settings files that the session does not need out of ${shown}, then ${doctorAgain}.`,
  );

/**
 * The settings files that a folder holds: the files of its settings folder. A folder with none gives nothing. A link
 * stops the scan, and so does a folder that can not be read to the end. A settings folder that is the user settings
 * folder, or is inside it, is skipped before any call of the file system.
 */
const settingsOfFolder = async (
  deps: Deps,
  home: string,
  userFolder: string | null,
  folder: { readonly path: string; readonly presence: string | null; readonly requiresHooks: boolean },
): Promise<FolderSettings> => {
  const id = checkIds.permissionMode;
  const settingsFolder = join(folder.path, dirs.claude);
  if (inUserFolder(deps, userFolder, settingsFolder)) return NO_SETTINGS;
  const shown = shownPath(homeRelative(home, settingsFolder));
  if (folder.path !== home) {
    const container = await deps.fs.lstat(folder.path);
    const shownContainer = shownPath(homeRelative(home, folder.path));
    if (!container.ok) return unfinishedStop(id, shownContainer, container.error.message);
    if (container.value === 'link') return linkStop(id, shownContainer);
    if (container.value === null) return NO_SETTINGS;
  }
  const kind = await deps.fs.lstat(settingsFolder);
  if (!kind.ok) return unfinishedStop(id, shown, kind.error.message);
  if (kind.value === 'link') return linkStop(id, shown);
  if (kind.value !== 'dir') return NO_SETTINGS;
  const names = await deps.fs.list(settingsFolder);
  if (!names.ok) return unfinishedStop(id, shown, names.error.message);
  const settings = names.value.filter(isSettingsName).sort();
  return {
    sources: settings.slice(0, MAX_SETTINGS_FILES).map((name) => ({
      absolute: join(settingsFolder, name),
      display: homeRelative(home, join(settingsFolder, name)),
      presence: folder.presence,
      requiresHooks: folder.requiresHooks,
    })),
    findings: settings.length > MAX_SETTINGS_FILES ? [tooManySettings(id, shown)] : [],
  };
};

/**
 * One settings file: its failures and warnings. A setting that skips the permission prompts, a variable with the prefix of
 * the program in the env values and a setting of the proxy or the credential of the session are failures. A setting that
 * runs a command is a failure where a settings file is not expected (`presence` is set), and a warning in the factory folder
 * itself. A setting that turns off every hook is a failure where the session must keep its hooks (`requiresHooks` is set). The
 * warning that a settings file is there is not given for a file that holds exactly the entries that the program writes
 * (`isOwnSettingsText`); every other finding stays for such a file.
 */
const judgeSettings = (source: SettingsSource, text: string): readonly RootFinding[] => {
  const id = checkIds.permissionMode;
  const facts = analyzeSettings(text);
  const shown = shownPath(source.display);
  const commandNames = facts.runsCommands.join(', ');
  const reasons = [
    ...(facts.skips.length === 0 ? [] : [`skips the permission checks (${facts.skips.join('; ')})`]),
    ...(facts.changesFactoryEnv ? [`sets or clears a variable with the prefix ${env.factoryPrefix} in its env values`] : []),
    ...(facts.movesTraffic.length === 0
      ? []
      : [`sets the proxy or the credential of the session in its env values (${facts.movesTraffic.join(', ')})`]),
    ...(source.presence !== null && facts.runsCommands.length > 0 ? [`runs a command through ${commandNames}`] : []),
    ...(source.requiresHooks && facts.disablesHooks
      ? [`turns off every hook (${claudeSettingKeys.disableAllHooks}), so the ${roles.worker} gets no role text`]
      : []),
  ];
  const keepStatusLine =
    source.presence !== null && facts.runsCommands.includes(claudeSettingKeys.statusLine) ? KEEP_STATUS_LINE : '';
  const wholeTool = facts.wholeToolRules.map(shownPath);
  const narrow = facts.narrowRules.map(shownPath);
  return [
    ...(reasons.length === 0
      ? []
      : [finding(id, 'fail', `${shown} ${reasons.join(' and ')}`, `${keepStatusLine}Remove the setting from ${shown}, then ${doctorAgain}.`)]),
    ...(facts.valid ? [] : [finding(id, 'warn', `${shown} is not valid JSON, so Claude Code does not read it`, `Fix or remove ${shown}.`)]),
    ...(source.presence === null || isOwnSettingsText(text)
      ? []
      : [finding(id, 'warn', `${shown} is a settings file in ${source.presence}, and the sessions of Claude Code read it`, 'Remove the file, or keep it on purpose.')]),
    ...(source.presence !== null || facts.runsCommands.length === 0
      ? []
      : [
          finding(
            id,
            'warn',
            `${shown} runs a command through ${commandNames} with no prompt`,
            `Check the ${plural(facts.runsCommands.length, 'setting', 'settings')} in ${shown}, or keep ${plural(facts.runsCommands.length, 'it', 'them')} on purpose.`,
          ),
        ]),
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
    ...(facts.crossSessionInbound === null
      ? []
      : [
          finding(
            id,
            'warn',
            `${shown} sets ${claudeSettingKeys.crossSessionInbound} to ${facts.crossSessionInbound}, so a session that reads it does not take the input of other sessions at once`,
            `Remove the setting from ${shown}, or keep it on purpose. ${settingsSeenNote}`,
          ),
        ]),
    ...(facts.planMode
      ? [
          finding(
            id,
            'warn',
            `${shown} sets the default mode ${planMode}, so a session that reads it holds the input of other sessions for approval`,
            `Remove the setting from ${shown}, or keep it on purpose. ${settingsSeenNote}`,
          ),
        ]
      : []),
  ];
};

interface JudgedSources {
  readonly findings: readonly RootFinding[];
  /** The files that were not read, each with the reason: a link, or a file that can not be read. */
  readonly unread: readonly string[];
}

/** Reads each source once and judges it. A link is never followed: it is not read. */
const judgeSources = async (deps: Deps, sources: Iterable<SettingsSource>): Promise<JudgedSources> => {
  const findings: RootFinding[] = [];
  const unread: string[] = [];
  for (const source of sources) {
    const kind = await deps.fs.lstat(source.absolute);
    if (!kind.ok || kind.value === 'link') {
      unread.push(`${shownPath(source.display)} (${kind.ok ? 'a link' : 'cannot be read'})`);
      continue;
    }
    const text = await deps.fs.readTextLimited(source.absolute, trackedFiles.maxFileBytes);
    if (text.ok) findings.push(...judgeSettings(source, text.value));
    else unread.push(`${shownPath(source.display)} (cannot be read)`);
  }
  return { findings, unread };
};

/** The failure for the files that the scan did not read, or no finding when it read every file. */
const unreadFindings = (unread: readonly string[]): readonly RootFinding[] =>
  unread.length === 0
    ? []
    : [
        finding(
          checkIds.permissionMode,
          'fail',
          `the scan of the settings files did not read ${namedItems(unread)}`,
          `Make each file a plain file that ${program} can read, or remove it, then ${doctorAgain}.`,
        ),
      ];

/**
 * The failures and warnings for the settings files of one session folder, for the work copy of a worker (design 4.4): the
 * same judgment as the scan of the root, with the same stops for a link and for a file that can not be read. `home` is the
 * factory folder that the shown paths are relative to, and `presence` names the place for the warning that a settings file is
 * there. The settings file that the program writes itself gives no warning. A file that turns off every hook is a failure here
 * and not in the scan of the root. The check only reads.
 */
export const checkFolderSettings = async (
  deps: Deps,
  home: string,
  folder: string,
  presence: string,
): Promise<readonly RootFinding[]> => {
  const found = await settingsOfFolder(deps, home, userClaudeFolderOf(deps), { path: folder, presence, requiresHooks: true });
  const judged = await judgeSources(deps, found.sources);
  return withoutRepeats([...found.findings, ...judged.findings, ...unreadFindings(judged.unread)]);
};

/** What the settings files of a commit give: the findings, and the text of the settings file that the program writes to. */
export interface TrackedSettings {
  readonly findings: readonly RootFinding[];
  /** The text of the file `localSettingsFile` in the commit, or null when the commit has no file of that name that can be read. */
  readonly localText: string | null;
}

/** The text of a file of git that the check reads, or null for a link, a large file or any entry that is not a plain file. */
const trackedText = async (deps: Deps, clone: string, entry: TreeEntry): Promise<string | null> => {
  const readable = entry.kind === 'blob' && isFileMode(entry.mode) && entry.size !== null && entry.size <= trackedFiles.maxFileBytes;
  if (!readable) return null;
  const text = await blobTextOf(deps, clone, entry.id);
  return text.ok ? text.value : null;
};

/**
 * The failures and warnings for the settings files that the last commit of `clone` tracks in its settings folder. A new work
 * tree of the clone starts from that commit, so the result is what `checkFolderSettings` gives for `folder` after the checkout:
 * the same judgment (a file that turns off every hook is a failure too), with the same stops for a link and for a file that can
 * not be read. A command that makes the work copy calls this first, so a stop comes before the work copy exists. Git is read, and
 * no call of the file system names `folder`, which may not exist yet. A clone that git can not read is a failure.
 */
export const checkTrackedSettings = async (
  deps: Deps,
  home: string,
  clone: string,
  folder: { readonly path: string; readonly presence: string },
): Promise<CliResult<TrackedSettings>> => {
  const id = checkIds.permissionMode;
  const settingsFolder = join(folder.path, dirs.claude);
  const shown = shownPath(homeRelative(home, settingsFolder));
  const own = await headEntriesAt(deps, clone, dirs.claude);
  if (!own.ok) return own;
  const entry = own.value.find((candidate) => candidate.path === dirs.claude);
  if (entry === undefined) return ok({ findings: [], localText: null });
  if (entry.mode === LINK_MODE) return ok({ findings: linkStop(id, shown).findings, localText: null });
  if (entry.kind !== 'tree') {
    const notFolder = finding(
      id,
      'fail',
      `${shown} is not a folder, so ${program} can not write its settings file there`,
      `Make ${shown} a folder in the repo of the project, or remove it from the repo.`,
    );
    return ok({ findings: [notFolder], localText: null });
  }
  const children = await headEntriesAt(deps, clone, `${dirs.claude}/`);
  if (!children.ok) return children;
  const settings = children.value.filter((child) => isSettingsName(basename(child.path))).sort((a, b) => a.path.localeCompare(b.path));
  const findings: RootFinding[] = settings.length > MAX_SETTINGS_FILES ? [tooManySettings(id, shown)] : [];
  const unread: string[] = [];
  let localText: string | null = null;
  for (const child of settings.slice(0, MAX_SETTINGS_FILES)) {
    const name = basename(child.path);
    const absolute = join(settingsFolder, name);
    const display = homeRelative(home, absolute);
    const text = child.mode === LINK_MODE ? null : await trackedText(deps, clone, child);
    if (text === null) {
      unread.push(`${shownPath(display)} (${child.mode === LINK_MODE ? 'a link' : 'cannot be read'})`);
      continue;
    }
    findings.push(...judgeSettings({ absolute, display, presence: folder.presence, requiresHooks: true }, text));
    if (name === localSettingsFile) localText = text;
  }
  return ok({ findings: withoutRepeats([...findings, ...unreadFindings(unread)]), localText });
};

/**
 * The settings files that a session reads from the factory folder: the files in the settings folder of the factory folder
 * itself, of the coordinator folder and of each project folder, and each Claude settings path that the root repo tracks,
 * at any depth (AC-21). A file is read once. A link is never followed: a link to a folder or to a file stops the scan. The
 * user settings folder of Claude Code is never read, and no call of the file system names it.
 */
export const scanSettings = async (
  deps: Deps,
  home: string,
  projectPaths: readonly string[],
  tracked: readonly string[],
): Promise<readonly RootFinding[]> => {
  const userFolder = userClaudeFolderOf(deps);
  const folders = [
    { path: home, presence: null, requiresHooks: false },
    { path: join(home, dirs.coordinator), presence: `the ${roles.coordinator} folder`, requiresHooks: false },
    ...projectPaths.map((path) => ({ path: join(home, path), presence: 'a project folder', requiresHooks: false })),
  ];
  const sources = new Map<string, SettingsSource>();
  const findings: RootFinding[] = [];
  for (const folder of folders) {
    const found = await settingsOfFolder(deps, home, userFolder, folder);
    findings.push(...found.findings);
    for (const source of found.sources) sources.set(source.absolute, source);
  }
  const unreadTracked: string[] = [];
  for (const path of tracked.filter(isClaudeSettingsPath)) {
    const absolute = join(home, path);
    if (sources.has(absolute) || inUserFolder(deps, userFolder, absolute)) continue;
    const kind = await deps.fs.lstat(absolute);
    if (!kind.ok) {
      unreadTracked.push(`${shownPath(path)} (cannot be read)`);
      continue;
    }
    if (kind.value === 'link') unreadTracked.push(`${shownPath(path)} (a link)`);
    else if (kind.value === 'file') sources.set(absolute, { absolute, display: path, presence: null, requiresHooks: false });
  }
  const judged = await judgeSources(deps, sources.values());
  return withoutRepeats([...findings, ...judged.findings, ...unreadFindings([...unreadTracked, ...judged.unread])]);
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
  const texts = repo.tracked !== null && !repo.capped ? await scanTrackedTexts(deps, home, repo.tracked) : [];
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
  [checkIds.permissionMode]: 'no settings file skips the permission checks, runs a command, or sets the proxy or the credential of the session',
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
 * The stop (exit 4) for a list of findings: the failures, at most three of them by name, and one line with the distinct
 * remedies. A warning never stops. Nothing starts after a stop.
 */
export const requireNoFailures = (findings: readonly RootFinding[]): CliResult<void> => {
  const failures = findings.filter((entry) => entry.level === 'fail');
  if (failures.length === 0) return ok(undefined);
  const shown = failures.slice(0, MAX_NAMED_FAILURES).map((entry) => entry.text);
  const rest = failures.length - shown.length;
  const remedies = [...new Set(failures.map((entry) => entry.remedy).filter((remedy) => remedy !== ''))];
  return safetyRefusal(`${shown.join('; ')}${rest > 0 ? ` and ${rest} more` : ''}`, remedies.join(' '));
};

/** The stop of `start` for the findings of the root checks. */
export const requireRootClean = (scan: RootScan): CliResult<void> => requireNoFailures(scan.findings);

/** One line for each warning of a list of findings, with its remedy. */
export const warningLines = (findings: readonly RootFinding[]): readonly string[] =>
  findings.filter((entry) => entry.level === 'warn').map(sentence);

/** The lines that `start` prints before it acts: each warning with its remedy, and the approval points that are delegated. */
export const rootNotices = (scan: RootScan): readonly string[] => [
  ...warningLines(scan.findings),
  ...(scan.delegations === null || scan.delegations.active.length === 0
    ? []
    : [`Approval points with the mode ${DELEGATED}: ${scan.delegations.active.map((entry) => `${entry.point} since ${entry.at}`).join(', ')}.`]),
];
