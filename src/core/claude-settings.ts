import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable } from '../cli/output.js';
import { isRecord } from '../migrate/inspect.js';
import {
  capitalize,
  claudeSettingKeys,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  hookCommandOf,
  hookNames,
  hookSessions,
  localFileModes,
  localSettingsFile,
  maxFileBytes,
  places,
  program,
  roles,
  settingsCommandType,
  statuslineKeyPath,
  type CommandName,
  type HookSession,
} from '../names.js';
import { parseJsonText } from '../state/load.js';
import { ACCEPT_ANSWER, type Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { comparable, isSameOrInside, isSameOrInsideFolder, realPathOf, userClaudeFolderOf } from './paths.js';
import { ok } from './result.js';
import { writeInFolder } from './safe-write.js';

/**
 * The write of the last-seen hook and the status line wrapper into the one settings file of a session folder (design 4.6).
 * The target is `<session folder>/.claude/settings.local.json` and nothing else. The writer never touches the user
 * settings folder of Claude Code, and it asks for consent before it changes any byte.
 */

/** One command entry of a settings file: a hook handler or the status line. */
export interface CommandEntry {
  readonly type: typeof settingsCommandType;
  readonly command: string;
}

/** A group of hook handlers, as Claude Code reads it under an event. */
export interface HookGroup {
  readonly hooks: readonly CommandEntry[];
}

/** The entries that the program writes. */
export interface OwnSettings {
  readonly hooks: Readonly<Record<string, readonly HookGroup[]>>;
  readonly statusLine: CommandEntry;
}

const commandEntryOf = (command: string): CommandEntry => ({ type: settingsCommandType, command });

const ownGroupOf = (event: string): HookGroup => ({ hooks: [commandEntryOf(hookCommandOf(event))] });

/**
 * The exact entries of the program: one group with one own command for each event of the fixed list, and the status line
 * wrapper. A new settings file holds these entries and nothing else. A check that asks whether a file holds only the own
 * entries compares the parsed file with this constant.
 */
export const ownSettingsEntries: OwnSettings = {
  [claudeSettingKeys.hooks]: Object.fromEntries(hookNames.events.map((event) => [event, [ownGroupOf(event)]])),
  [claudeSettingKeys.statusLine]: commandEntryOf(hookCommandOf(hookNames.statusline)),
};

/** The text with the white space outside the strings removed. A valid JSON text stays valid. */
const compactJson = (text: string): string => text.replace(/("(?:[^"\\]|\\.)*")|\s+/g, '$1');

/**
 * True when the text of a settings file holds exactly the entries of the program (`ownSettingsEntries`) and nothing else: the
 * parsed file equals the constant, and the text writes nothing that the parsed file hides. A repeated key and an escape in a
 * name give a text longer or different from the parsed file, so another parser could read another file than this one. The
 * order of the keys and the layout of the text do not count. A text that is not valid JSON is never exact.
 */
export const isOwnSettingsText = (text: string): boolean => {
  const json = parseJsonText(text);
  return json.ok && isDeepStrictEqual(json.value, ownSettingsEntries) && compactJson(text) === JSON.stringify(json.value);
};

export interface HookSettingsRequest {
  /** The session folder. The settings file is below it. */
  readonly folder: string;
  /** The kind of the session folder: the coordinator, or the work copy of a worker. */
  readonly session: HookSession;
  /** True when the person gave the yes flag. */
  readonly yes: boolean;
  /** True for a dry run: the call checks the target and returns the change. It asks nothing and writes nothing. */
  readonly dryRun: boolean;
  /** The command that asks. The remedy of a stop names it. */
  readonly command: CommandName;
}

/** The part of a request that the consent depends on: a call that never writes has no dry run. */
export type HookConsentRequest = Omit<HookSettingsRequest, 'dryRun'>;

/**
 * What the call did: it found the entries in place, wrote them, or the person answered no. A dry run that finds a change to
 * make gives the text of the change and writes nothing.
 */
export type HookSettingsOutcome =
  | { readonly kind: 'in-place'; readonly file: string }
  | { readonly kind: 'written'; readonly file: string }
  | { readonly kind: 'declined'; readonly file: string }
  | { readonly kind: 'would-write'; readonly file: string; readonly change: string };

/** The most characters of an existing status line that the shown change repeats. */
const MAX_SHOWN_CHARS = 120;

interface Target {
  readonly folder: string;
  readonly claudeFolder: string;
  readonly file: string;
}

const targetOf = (folder: string): Target => {
  const root = resolve(folder);
  const claudeFolder = join(root, dirs.claude);
  return { folder: root, claudeFolder, file: join(claudeFolder, localSettingsFile) };
};

const clipped = (text: string): string => (text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text);

const again = (command: CommandName): string => `Then run "${commandText(command)}" again.`;

/** A settings object. */
type Settings = Readonly<Record<string, unknown>>;

const NO_SETTINGS: Settings = {};

/** The link, the kind and the existence of the three parts of the path, from the session folder down. */
const checkParts = async (deps: Deps, target: Target, command: CommandName): Promise<CliResult<{ readonly exists: boolean }>> => {
  const parts = [
    { path: target.folder, what: 'the session folder', kind: 'dir', name: 'folder' },
    { path: target.claudeFolder, what: `the ${dirs.claude} folder`, kind: 'dir', name: 'folder' },
    { path: target.file, what: 'the settings file', kind: 'file', name: 'file' },
  ] as const;
  let exists = false;
  for (const part of parts) {
    const found = await deps.fs.lstat(part.path);
    if (!found.ok) return found;
    if (found.value === 'link') {
      return safetyRefusal(
        `cannot write ${target.file}: ${part.what} ${part.path} is a link`,
        `Replace the link with a real ${part.name}. ${again(command)}`,
      );
    }
    if (found.value !== null && found.value !== part.kind) {
      return failure(`cannot write ${target.file}: ${part.path} is not a ${part.name}`);
    }
    if (found.value === null && part.path === target.folder) return failure(`cannot write ${target.file}: ${part.path} is not a folder`);
    if (part.path === target.file) exists = found.value !== null;
  }
  return ok({ exists });
};

/** The real path of the file must be inside the real path of the session folder. */
const requireInsideSession = async (deps: Deps, target: Target, command: CommandName): Promise<CliResult<void>> => {
  const [folder, file] = [await realPathOf(deps, target.folder), await realPathOf(deps, target.file)];
  if (!folder.ok) return folder;
  if (!file.ok) return file;
  if (isSameOrInside(comparable(deps, folder.value), comparable(deps, file.value))) return ok(undefined);
  return safetyRefusal(
    `cannot write ${target.file}: its real path is outside ${target.folder}`,
    `Use a real folder in the session folder. ${again(command)}`,
  );
};

/** The file must not be in the user settings folder of Claude Code, as written or with the links resolved. */
const requireOutsideUserFolder = async (deps: Deps, target: Target, command: CommandName): Promise<CliResult<void>> => {
  const userFolder = userClaudeFolderOf(deps);
  if (userFolder === null) return ok(undefined);
  const inside = await isSameOrInsideFolder(deps, userFolder, target.file);
  if (!inside.ok) return inside;
  if (!inside.value) return ok(undefined);
  return safetyRefusal(
    `cannot write ${target.file}: it is inside the settings folder of Claude Code ${userFolder}`,
    `Claude Code owns that folder. Use a session folder outside it. ${again(command)}`,
  );
};

/** The settings object of the file. A file that is not a JSON object is a failure, and it stays as it is. */
const readSettings = async (deps: Deps, file: string, command: CommandName): Promise<CliResult<Settings>> => {
  const text = await deps.fs.readTextLimited(file, maxFileBytes);
  if (!text.ok) return text;
  const parsed = parseJsonText(text.value);
  if (parsed.ok && isRecord(parsed.value)) return ok(parsed.value);
  return failure(`${file} is not a JSON object`, `Fix the file, or move it away. ${again(command)}`);
};

const hasCommand = (group: unknown, command: string): boolean =>
  isRecord(group) &&
  Array.isArray(group['hooks']) &&
  group['hooks'].some((handler) => isRecord(handler) && handler['type'] === settingsCommandType && handler['command'] === command);

interface Change {
  /** The settings after the change. */
  readonly settings: Settings;
  /** One line for each entry that the write adds or replaces. Empty when the entries are in place. */
  readonly lines: readonly string[];
}

interface HooksChange {
  readonly hooks: Settings;
  readonly lines: readonly string[];
}

/** The hooks object with the own group added for each event that has no own command. A shape that is not known is a failure. */
const addHooks = (current: unknown, file: string, command: CommandName): CliResult<HooksChange> => {
  const hint = `Fix the file, or move it away. ${again(command)}`;
  const base = current === undefined ? NO_SETTINGS : current;
  if (!isRecord(base)) return failure(`${file} holds ${claudeSettingKeys.hooks} that is not an object`, hint);
  const hooks: Record<string, unknown> = { ...base };
  const lines: string[] = [];
  for (const event of hookNames.events) {
    const groups: unknown = Object.hasOwn(hooks, event) ? hooks[event] : [];
    if (!Array.isArray(groups)) return failure(`${file} holds ${claudeSettingKeys.hooks}.${event} that is not a list`, hint);
    if (groups.some((group) => hasCommand(group, hookCommandOf(event)))) continue;
    hooks[event] = [...groups, ownGroupOf(event)];
    lines.push(`${claudeSettingKeys.hooks}.${event}: add the command "${hookCommandOf(event)}"`);
  }
  return ok({ hooks, lines });
};

const shownStatusLine = (value: unknown): string =>
  clipped(isRecord(value) && value['type'] === settingsCommandType && typeof value['command'] === 'string' ? value['command'] : JSON.stringify(value));

/** The line about the status line, or none when the own entry is in place. */
const statusLineLines = (current: unknown): readonly string[] => {
  const own = ownSettingsEntries.statusLine;
  if (isRecord(current) && current['type'] === own.type && current['command'] === own.command) return [];
  const add = `${claudeSettingKeys.statusLine}: set the command "${own.command}"`;
  if (current === undefined) return [add];
  return [
    `${add}, and replace the status line ${shownStatusLine(current)}`,
    `To keep that status line, set ${statuslineKeyPath} in ${files.localConfig} to its command. ${program} runs it and shows its output.`,
  ];
};

/** The settings with the own entries added, and the lines that show the change. Every other key stays as it is. */
const addOwnEntries = (existing: Settings, file: string, command: CommandName): CliResult<Change> => {
  const hooks = addHooks(existing[claudeSettingKeys.hooks], file, command);
  if (!hooks.ok) return hooks;
  const statusLine = statusLineLines(existing[claudeSettingKeys.statusLine]);
  return ok({
    settings: {
      ...existing,
      ...(hooks.value.lines.length === 0 ? {} : { [claudeSettingKeys.hooks]: hooks.value.hooks }),
      ...(statusLine.length === 0 ? {} : { [claudeSettingKeys.statusLine]: ownSettingsEntries.statusLine }),
    },
    lines: [...hooks.value.lines, ...statusLine],
  });
};

const shownChange = (file: string, lines: readonly string[]): string =>
  [`This changes the settings of Claude Code in ${file}:`, ...lines.map((line) => `  ${line}`)].join('\n');

/** The notice for a no to the hook settings: the effect, and the way to add them later with the command that asked. */
export const declinedHookText = (file: string, command: CommandName): string =>
  `The hook settings in ${file} stay as they are, so Claude Code does not call the hook. ` +
  `${capitalize(program)} has no last-seen record of the ${roles.coordinator}, ` +
  'and a restart or a reboot can not resume the session by its id. ' +
  `To add the settings later, run "${commandText(command)}" again and answer yes.`;

/** The yes flag is a consent outside a factory session. Inside one it counts only for a work copy with no settings file. */
const yesCounts = (deps: Deps, request: HookConsentRequest, fileExists: boolean): boolean =>
  request.yes && (!inFactorySession(deps) || (request.session === hookSessions.workCopy && !fileExists));

/** The yes flag inside a factory session, where it gives no consent: the command stops with a usage error, with or without a terminal. */
const yesRefused = (deps: Deps, request: HookConsentRequest, fileExists: boolean): boolean =>
  request.yes && !yesCounts(deps, request, fileExists);

const noConsentRemedy = (deps: Deps, request: HookConsentRequest): string => {
  const run = `Run "${commandText(request.command)}"`;
  return request.yes && inFactorySession(deps)
    ? `${flagText(flags.yes)} gives no consent inside a ${places.session}. ${run} outside the ${places.session}, ` +
        `or in a terminal window without ${flagText(flags.yes)} and answer the question.`
    : `${run} in a terminal window, or add ${flagText(flags.yes)}.`;
};

/** True when the person agrees. The change is shown first: on the terminal in the question, or as a notice with the yes flag. */
const askConsent = async (deps: Deps, request: HookConsentRequest, shown: string, fileExists: boolean): Promise<CliResult<boolean>> => {
  if (yesCounts(deps, request, fileExists)) {
    deps.warn(shown);
    return ok(true);
  }
  if (yesRefused(deps, request, fileExists) || !(deps.stdinIsTTY && deps.stdoutIsTTY)) {
    return usageError(shown, noConsentRemedy(deps, request));
  }
  const answer = await deps.prompt(printable(`${shown}\nWrite this change? [y/N] `));
  return answer.ok ? ok(ACCEPT_ANSWER.test(answer.value.trim())) : answer;
};

/** What a call finds: the target, whether the file is there, and the change that the own entries make. Nothing is written. */
interface Plan {
  readonly target: Target;
  readonly exists: boolean;
  readonly change: Change;
}

/** The checks of the target, then the change. A link, a real path outside the session folder or a file that is no object stops it. */
const planChange = async (deps: Deps, request: HookConsentRequest): Promise<CliResult<Plan>> => {
  const target = targetOf(request.folder);
  const parts = await checkParts(deps, target, request.command);
  if (!parts.ok) return parts;
  const inside = await requireInsideSession(deps, target, request.command);
  if (!inside.ok) return inside;
  const outside = await requireOutsideUserFolder(deps, target, request.command);
  if (!outside.ok) return outside;
  const existing = parts.value.exists ? await readSettings(deps, target.file, request.command) : ok(NO_SETTINGS);
  if (!existing.ok) return existing;
  const change = addOwnEntries(existing.value, target.file, request.command);
  return change.ok ? ok({ target, exists: parts.value.exists, change: change.value }) : change;
};

/** The plan for a session folder that does not exist yet: the file is new, and the change is every own entry. */
const newFilePlan = (request: HookConsentRequest): CliResult<Plan> => {
  const target = targetOf(request.folder);
  const change = addOwnEntries(NO_SETTINGS, target.file, request.command);
  return change.ok ? ok({ target, exists: false, change: change.value }) : change;
};

/**
 * Make sure the settings file of the session folder holds the own hooks and the own status line. The checks of the target
 * come first: a link, a real path outside the session folder or inside the user settings folder is a stop (exit 4), and a
 * file that is not a JSON object is a failure (exit 1) that leaves its bytes. Entries in place need no question and no
 * write. Else the change is shown with its target, the person consents, and the write keeps every other key. With no
 * terminal and no consent, the call writes nothing and gives a usage error (exit 2). A dry run makes the same checks, then
 * returns the change with no question and no write.
 */
export const ensureHookSettings = async (deps: Deps, request: HookSettingsRequest): Promise<CliResult<HookSettingsOutcome>> => {
  const planned = await planChange(deps, request);
  if (!planned.ok) return planned;
  const { target, exists, change } = planned.value;
  if (change.lines.length === 0) return ok({ kind: 'in-place', file: target.file });
  const shown = shownChange(target.file, change.lines);
  if (request.dryRun) return ok({ kind: 'would-write', file: target.file, change: shown });
  const consent = await askConsent(deps, request, shown, exists);
  if (!consent.ok) return consent;
  if (!consent.value) return ok({ kind: 'declined', file: target.file });
  const info = exists ? await deps.fs.statInfo(target.file) : ok(null);
  if (!info.ok) return info;
  const written = await writeInFolder(
    deps,
    { parent: target.folder, folder: target.claudeFolder, name: localSettingsFile, mode: info.value?.mode ?? localFileModes.private },
    `${JSON.stringify(change.settings, null, 2)}\n`,
  );
  return written.ok ? ok({ kind: 'written', file: target.file }) : written;
};

/**
 * The check for a command that writes other files before the settings file, and asks its question after them. It makes the
 * checks of the target and stops before the first write of the command when the question could not be answered later: the
 * change is to be made and either the yes flag is given inside a factory session, where it gives no consent (exit 2, also on
 * a terminal), or there is no terminal and no consent (exit 2). The session folder may not exist yet: the file is new then.
 * A terminal, the yes flag outside a factory session, or entries in place let the command go on.
 * The call asks nothing and writes nothing.
 */
export const requireHookConsent = async (deps: Deps, request: HookConsentRequest): Promise<CliResult<void>> => {
  const folder = await deps.fs.lstat(request.folder);
  if (!folder.ok) return folder;
  const planned = folder.value === null ? newFilePlan(request) : await planChange(deps, request);
  if (!planned.ok) return planned;
  const { change, exists } = planned.value;
  const terminal = deps.stdinIsTTY && deps.stdoutIsTTY;
  if (change.lines.length === 0) return ok(undefined);
  if (!yesRefused(deps, request, exists) && (terminal || yesCounts(deps, request, exists))) return ok(undefined);
  return usageError(shownChange(planned.value.target.file, change.lines), noConsentRemedy(deps, request));
};
