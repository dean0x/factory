import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { printable } from '../cli/output.js';
import { allOn, guardOn, guardValuesFor, isGuardOn } from '../guards/effective.js';
import type { GuardValues } from '../guards/types.js';
import { isRecord } from '../migrate/inspect.js';
import {
  capitalize,
  claudeSettingKeys,
  commands,
  commandText,
  dirs,
  files,
  flags,
  flagText,
  guardDenyWords,
  guardIds,
  hookCommandOf,
  hookNames,
  hookSessions,
  idleCompactionKeyPath,
  localFileModes,
  localSettingsFile,
  maxFileBytes,
  places,
  program,
  roles,
  settingsCommandType,
  statuslineKeyPath,
  values,
  type CommandText,
  type HookEvent,
  type HookSession,
} from '../names.js';
import { parseJsonText } from '../state/load.js';
import { ACCEPT_ANSWER, type Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { comparable, isSameOrInside, isWrittenInside, realPathOf, userClaudeFolderOf } from './paths.js';
import { userStatePlaceOf } from './private-file.js';
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

/** A group of hook handlers, as Claude Code reads it under an event. The matcher is set only for an event of `hookNames.matchers`. */
export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly CommandEntry[];
}

/** The entries that the program writes. */
export interface OwnSettings {
  readonly hooks: Readonly<Record<string, readonly HookGroup[]>>;
  readonly statusLine: CommandEntry;
  /** The value of `session.idle_compaction`: Claude Code compacts an idle session when it is true. */
  readonly idleCompaction: boolean;
}

const commandEntryOf = (command: string): CommandEntry => ({ type: settingsCommandType, command });

const matchers: Readonly<Record<string, string>> = hookNames.matchers;

/** The matcher that the own group of the event must have, or undefined for an event whose own group has none. */
const matcherOf = (event: string): string | undefined => (Object.hasOwn(matchers, event) ? matchers[event] : undefined);

const ownGroupOf = (event: string): HookGroup => {
  const matcher = matcherOf(event);
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [commandEntryOf(hookCommandOf(event))] };
};

/**
 * The entries that every settings file of the program holds, whatever the idle compaction value is: one group with one own
 * command for each event of the fixed list, and the status line wrapper.
 * A new settings file also holds the own Edit rules for its computed paths.
 */
const ownBase: Omit<OwnSettings, 'idleCompaction'> = {
  [claudeSettingKeys.hooks]: Object.fromEntries(hookNames.events.map((event) => [event, [ownGroupOf(event)]])),
  [claudeSettingKeys.statusLine]: commandEntryOf(hookCommandOf(hookNames.statusline)),
};

/** The exact entries of the program for an idle compaction value. A new settings file holds these entries and nothing else. */
export const ownSettingsEntriesFor = (idleCompaction: boolean): OwnSettings => ({
  ...ownBase,
  [claudeSettingKeys.idleCompaction]: idleCompaction,
});

/** The own entries with the default idle compaction value. */
export const ownSettingsEntries: OwnSettings = ownSettingsEntriesFor(values.defaultIdleCompaction);

/**
 * The only shapes of a settings file that holds nothing but the own entries: the entries with the value true, with the value
 * false, and the entries of an earlier version, which have no idle compaction key. Any other shape is a foreign file.
 */
const ownShapes: readonly Omit<OwnSettings, 'idleCompaction'>[] = [ownSettingsEntriesFor(false), ownSettingsEntriesFor(true), ownBase];

/** The text with the white space outside the strings removed. A valid JSON text stays valid. */
const compactJson = (text: string): string => text.replace(/("(?:[^"\\]|\\.)*")|\s+/g, '$1');

/**
 * True when the text of a settings file holds exactly the entries of the program alone or with exactly the supplied own rules: the parsed file equals one
 * of the three own shapes (the idle compaction value true, false, or no such key), and the text writes nothing that the parsed
 * file hides. A repeated key and an escape in a name give a text longer or different from the parsed file, so another parser
 * could read another file than this one. The order of the keys and the layout of the text do not count. A text that is not
 * valid JSON is never exact. The check takes no config value, so a missing config can not make a foreign file pass.
 */
export const isOwnSettingsText = (text: string, rules: readonly string[] = []): boolean => {
  const json = parseJsonText(text);
  if (!json.ok || compactJson(text) !== JSON.stringify(json.value)) return false;
  return ownShapes.some((shape) => isDeepStrictEqual(json.value, shape) ||
    (rules.length > 0 && isDeepStrictEqual(json.value, { ...shape, permissions: { deny: rules } })));
};

/** Compare exact own rule targets across written and real paths. Other keys and rule targets stay outside the own file. */
export const isOwnSettingsTextAt = async (deps: Deps, text: string, rules: readonly string[]): Promise<boolean> => {
  if (isOwnSettingsText(text, rules)) return true;
  const json = parseJsonText(text);
  if (!json.ok || !isRecord(json.value)) return false;
  const permissions = json.value[claudeSettingKeys.permissions];
  const deny: unknown = isRecord(permissions) ? permissions['deny'] : undefined;
  if (!Array.isArray(deny) || !deny.every((rule): rule is string => typeof rule === 'string')) return false;
  if (deny.length > rules.length * 2 || new Set(deny).size !== deny.length || !isOwnSettingsText(text, deny)) return false;
  const userFolder = userClaudeFolderOf(deps);
  const targetOfRule = async (rule: string): Promise<string | null> => {
    if (!rule.startsWith(`${guardDenyWords.edit}(//`) || !rule.endsWith(')')) return null;
    const path = rule.slice(`${guardDenyWords.edit}(/`.length, -1);
    if (path !== resolve(path) || /[\x00-\x1f\x7f*?\[\]{}()\\]/u.test(path)) return null;
    if (userFolder !== null && isWrittenInside(deps, userFolder, path)) return rules.includes(rule) ? path : null;
    const real = await realPathOf(deps, path);
    return real.ok ? real.value : null;
  };
  const expected = new Set<string>();
  for (const rule of rules) {
    const target = await targetOfRule(rule);
    if (target === null) return false;
    expected.add(target);
  }
  const found = new Set<string>();
  for (const rule of deny) {
    const target = await targetOfRule(rule);
    if (target === null || !expected.has(target)) return false;
    found.add(target);
  }
  return found.size === expected.size;
};

export interface HookSettingsRequest {
  /** The session folder. The settings file is below it. */
  readonly folder: string;
  /** The node home of the session folder. Its guard values decide the checks of the write. */
  readonly home: string;
  /** The kind of the session folder: the coordinator, or the work copy of a worker. */
  readonly session: HookSession;
  /** True when the person gave the yes flag. */
  readonly yes: boolean;
  /** True for a dry run: the call checks the target and returns the change. It asks nothing and writes nothing. */
  readonly dryRun: boolean;
  /** The command that asks. The remedy of a stop names it. */
  readonly command: CommandText;
  /** The own Edit rules. With add false, absent rules need a write only when another entry changes. */
  readonly deny?: { readonly rules: readonly string[]; readonly add: boolean };
  /** The value of `session.idle_compaction`. The file gets this value in the key `idleCompaction`. */
  readonly idleCompaction: boolean;
}

/** The part of a request that the consent depends on: a call that never writes has no dry run. */
export type HookConsentRequest = Omit<HookSettingsRequest, 'dryRun'>;

/**
 * What the call did: it found the entries in place, wrote them, or the person answered no. A dry run that finds a change to
 * make gives the text of the change and writes nothing. A caller can request a no-consent outcome for an idle-only change
 * with no terminal. `onlyIdleCompaction` is true when the change holds the idle value alone: the hooks and status line are in place.
 */
export type HookSettingsOutcome =
  | { readonly kind: 'in-place'; readonly file: string }
  | { readonly kind: 'written'; readonly file: string }
  | { readonly kind: 'declined'; readonly file: string; readonly onlyIdleCompaction: boolean }
  | { readonly kind: 'no-consent'; readonly file: string; readonly onlyIdleCompaction: true }
  | { readonly kind: 'would-write'; readonly file: string; readonly change: string; readonly onlyIdleCompaction: boolean };

/** The outcome of a no to the question. */
export type DeclinedOutcome = Extract<HookSettingsOutcome, { readonly kind: 'declined' }>;

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

/** The folder `.claude` and the hook settings file in it, for a session folder: the file that this module reads and writes. */
export const hookSettingsPlaceOf = (folder: string): { readonly claudeFolder: string; readonly file: string } => {
  const { claudeFolder, file } = targetOf(folder);
  return { claudeFolder, file };
};

/** The rules for the own files, and paths whose characters prevent an exact rule. */
export interface OwnDenyRules {
  readonly rules: readonly string[];
  readonly skipped: readonly string[];
}

/** Written paths and distinct real paths both get exact rules. The place core reads no owner store. */
export const ownDenyRulesOf = async (deps: Deps, home: string, folder: string): Promise<CliResult<OwnDenyRules>> => {
  const paths = [
    resolve(home, files.config),
    resolve(home, files.localConfig),
    ...[files.ownerRecords, files.ownerDecisions, files.guardRecords, files.setupAcceptances].flatMap((name) => {
      const { path } = userStatePlaceOf(deps, name);
      return path === null ? [] : [path];
    }),
    hookSettingsPlaceOf(folder).file,
  ];
  const rules = new Set<string>();
  const skipped = new Set<string>();
  const addPath = (path: string): boolean => {
    if (/[\x00-\x1f\x7f*?\[\]{}()\\]/u.test(path)) {
      skipped.add(path);
      return false;
    }
    rules.add(`${guardDenyWords.edit}(/${path})`);
    return true;
  };
  const userFolder = userClaudeFolderOf(deps);
  for (const path of paths) {
    if (!addPath(path)) continue;
    if (userFolder !== null && isWrittenInside(deps, userFolder, path)) continue;
    const real = await realPathOf(deps, path);
    if (!real.ok) return real;
    if (real.value !== path) addPath(real.value);
  }
  return ok({ rules: [...rules], skipped: [...skipped] });
};

const clipped = (text: string): string => (text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}...` : text);

const again = (command: CommandText): string => `Then run "${commandText(command)}" again.`;

/** A settings object. */
type Settings = Readonly<Record<string, unknown>>;

const NO_SETTINGS: Settings = {};

/** Check the kind of each part from the session folder down. Refuse a link at any of these parts. */
const checkParts = async (deps: Deps, target: Target, command: CommandText): Promise<CliResult<{ readonly exists: boolean }>> => {
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

/** The real path of the file must be inside the real path of the session folder. The value is the real path of the file. */
const requireInsideSession = async (deps: Deps, target: Target, command: CommandText): Promise<CliResult<string>> => {
  const [folder, file] = [await realPathOf(deps, target.folder), await realPathOf(deps, target.file)];
  if (!folder.ok) return folder;
  if (!file.ok) return file;
  if (isSameOrInside(comparable(deps, folder.value), comparable(deps, file.value))) return ok(file.value);
  return safetyRefusal(
    `cannot write ${target.file}: its real path is outside ${target.folder}`,
    `Use a real folder in the session folder. ${again(command)}`,
  );
};

/**
 * The path must not be in the user settings folder of Claude Code. The path is compared with the folder as text, as the folder
 * is written, so no call of the file system is made on that folder: it is never resolved, read or listed. The caller gives the
 * written path of the file before it makes any call on the target, and the real path of the file after it.
 */
const requireOutsideUserFolder = (deps: Deps, target: Target, command: CommandText, path: string): CliResult<void> => {
  const userFolder = userClaudeFolderOf(deps);
  if (userFolder === null || !isWrittenInside(deps, userFolder, path)) return ok(undefined);
  return safetyRefusal(
    `cannot write ${target.file}: it is inside the settings folder of Claude Code ${userFolder}`,
    `Claude Code owns that folder. Use a session folder outside it. ${again(command)}`,
  );
};

/** The text of the settings file, and the settings object that it holds. */
interface FileContent {
  readonly text: string;
  readonly settings: Settings;
}

/** The settings object of the text of a settings file. A text that is not a JSON object is a failure. */
const parseSettings = (text: string, file: string, command: CommandText): CliResult<FileContent> => {
  const parsed = parseJsonText(text);
  if (parsed.ok && isRecord(parsed.value)) return ok({ text, settings: parsed.value });
  return failure(`${file} is not a JSON object`, `Fix the file, or move it away. ${again(command)}`);
};

/** The text and the settings object of the file. A file that is not a JSON object is a failure, and it stays as it is. */
const readSettings = async (deps: Deps, file: string, command: CommandText): Promise<CliResult<FileContent>> => {
  const text = await deps.fs.readTextLimited(file, maxFileBytes);
  return text.ok ? parseSettings(text.value, file, command) : text;
};

/**
 * Whether Claude Code calls the groups of an event only when the matcher of the group fits the notice. The other events call every
 * group, and they ignore the matcher.
 */
const filteredByMatcher: Readonly<Record<HookEvent, boolean>> = {
  SessionStart: true,
  UserPromptSubmit: false,
  Stop: false,
  PreCompact: true,
  Notification: true,
  PreToolUse: true,
};

/** The matchers that fit every notice of an event: no matcher, the empty text and `*`. */
const fitsEveryNotice = (matcher: unknown): boolean => matcher === undefined || matcher === '' || matcher === '*';

/**
 * True when the matcher of a group makes Claude Code call the own command for every notice that the own group covers. For an event
 * whose own group has a matcher, the group must have that matcher. For another event that Claude Code filters by matcher, the group
 * must have a matcher that fits every notice: the same command under a narrower matcher is not called for the other notices.
 */
const matcherCovers = (event: HookEvent, matcher: unknown): boolean => {
  const own = matcherOf(event);
  if (own !== undefined) return matcher === own;
  return !filteredByMatcher[event] || fitsEveryNotice(matcher);
};

/** True when the group holds the own command of the event, under any matcher. */
const holdsOwnCommand = (group: unknown, event: HookEvent): boolean =>
  isRecord(group) &&
  Array.isArray(group['hooks']) &&
  group['hooks'].some((handler) => isRecord(handler) && handler['type'] === settingsCommandType && handler['command'] === hookCommandOf(event));

/** True when the group holds the own command of the event and its matcher covers the notices of the own group. */
const hasOwnCommand = (group: unknown, event: HookEvent): boolean =>
  isRecord(group) && holdsOwnCommand(group, event) && matcherCovers(event, group['matcher']);

interface Change {
  /** The settings after the change. */
  readonly settings: Settings;
  /** One line for each entry that the write adds or replaces. Empty when the entries are in place. */
  readonly lines: readonly string[];
  /** True when the only line is the one of the idle compaction value: the hooks and the status line are in place. */
  readonly onlyIdleCompaction: boolean;
}

interface HooksChange {
  readonly hooks: Settings;
  readonly lines: readonly string[];
}

/** The groups of an event in a hooks object: none when the event is absent, and null when the value is not a list. */
const groupsOfEvent = (hooks: Settings, event: string): readonly unknown[] | null => {
  const groups: unknown = Object.hasOwn(hooks, event) ? hooks[event] : [];
  return Array.isArray(groups) ? groups : null;
};

/**
 * The events of the fixed list that no group of the hooks object covers with the own command, in the order of the list, or the
 * first event whose value is not a list. `addHooks` and `missingHookEvents` both use this rule.
 */
const missingEventsIn = (hooks: Settings): { readonly missing: readonly HookEvent[] } | { readonly notList: HookEvent } => {
  const missing: HookEvent[] = [];
  for (const event of hookNames.events) {
    const groups = groupsOfEvent(hooks, event);
    if (groups === null) return { notList: event };
    if (!groups.some((group) => hasOwnCommand(group, event))) missing.push(event);
  }
  return { missing };
};

/** The line of the shown change for an event that gets its own group. An event with a matcher names it. */
const addLineOf = (event: string): string => {
  const matcher = matcherOf(event);
  const added = `${claudeSettingKeys.hooks}.${event}: add the command "${hookCommandOf(event)}"`;
  return matcher === undefined ? added : `${added} for the matcher "${matcher}"`;
};

/** The hooks object with the own group added for each event that has no own command. A shape that is not known is a failure. */
const addHooks = (current: unknown, file: string, command: CommandText): CliResult<HooksChange> => {
  const hint = `Fix the file, or move it away. ${again(command)}`;
  const base = current === undefined ? NO_SETTINGS : current;
  if (!isRecord(base)) return failure(`${file} holds ${claudeSettingKeys.hooks} that is not an object`, hint);
  const found = missingEventsIn(base);
  if ('notList' in found) return failure(`${file} holds ${claudeSettingKeys.hooks}.${found.notList} that is not a list`, hint);
  const hooks: Record<string, unknown> = { ...base };
  for (const event of found.missing) hooks[event] = [...(groupsOfEvent(base, event) ?? []), ownGroupOf(event)];
  return ok({ hooks, lines: found.missing.map(addLineOf) });
};

/**
 * The events of the fixed list that the settings object does not cover with the own command, in the order of the list. For
 * `Notification` the own group must have the own matcher. For `SessionStart`, `PreCompact` and `PreToolUse` the matcher of the own
 * group must be absent, empty or `*`. A shape that is not known (no object, no hooks object, or an event whose
 * value is not a list) counts every event as missing, so a check that needs the events fails closed.
 */
export const missingHookEvents = (settings: unknown): readonly HookEvent[] => {
  const hooks = isRecord(settings) ? settings[claudeSettingKeys.hooks] : undefined;
  if (!isRecord(hooks)) return hookNames.events;
  const found = missingEventsIn(hooks);
  return 'notList' in found ? hookNames.events : found.missing;
};

/** The own Edit rules that the settings lack. An unknown permissions shape counts every rule as absent. */
export const missingDenyRules = (settings: unknown, rules: readonly string[]): readonly string[] => {
  const permissions = isRecord(settings) ? settings[claudeSettingKeys.permissions] : undefined;
  const deny = isRecord(permissions) ? permissions['deny'] : undefined;
  return Array.isArray(deny) && deny.every((rule) => typeof rule === 'string') ? rules.filter((rule) => !deny.includes(rule)) : rules;
};

/** Add only absent rules. Refuse unknown shapes so no permission value gets replaced. */
const addDenyRules = (existing: Settings, rules: readonly string[], file: string, command: CommandText): CliResult<Omit<Change, 'onlyIdleCompaction'>> => {
  const missing = missingDenyRules(existing, rules);
  if (missing.length === 0) return ok({ settings: existing, lines: [] });
  const current = existing[claudeSettingKeys.permissions];
  const permissions = current === undefined ? NO_SETTINGS : current;
  const hint = `Fix the file, or move it away. ${again(command)}`;
  if (!isRecord(permissions)) return failure(`${file} holds ${claudeSettingKeys.permissions} that is not an object`, hint);
  const deny: unknown = Object.hasOwn(permissions, 'deny') ? permissions['deny'] : [];
  if (!Array.isArray(deny) || !deny.every((rule) => typeof rule === 'string')) {
    return failure(`${file} holds ${claudeSettingKeys.permissions}.deny that is not a list of rules`, hint);
  }
  return ok({
    settings: { ...existing, [claudeSettingKeys.permissions]: { ...permissions, deny: [...deny, ...missing] } },
    lines: missing.map((rule) => `${claudeSettingKeys.permissions}.deny: add ${rule}`),
  });
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

/**
 * The line about the idle compaction value, or none when the file holds the wanted boolean. The write always sets a boolean and
 * never removes the key. A value that is not a boolean is never shown: the line says only that it is replaced.
 */
const idleCompactionLines = (current: unknown, wanted: boolean): readonly string[] => {
  if (current === wanted) return [];
  const set = `${claudeSettingKeys.idleCompaction}: set to ${wanted} (${idleCompactionKeyPath} in ${files.config})`;
  if (current === undefined) return [set];
  return [typeof current === 'boolean' ? `${set}, and replace the value ${current}` : `${set}, and replace a value that is not true or false`];
};

/** The settings with the own entries added, and the lines that show the change. Every other key stays as it is. */
const addOwnEntries = (existing: Settings, file: string, request: HookConsentRequest): CliResult<Change> => {
  const hooks = addHooks(existing[claudeSettingKeys.hooks], file, request.command);
  if (!hooks.ok) return hooks;
  const statusLine = statusLineLines(existing[claudeSettingKeys.statusLine]);
  const idle = idleCompactionLines(existing[claudeSettingKeys.idleCompaction], request.idleCompaction);
  const lines = [...hooks.value.lines, ...statusLine, ...idle];
  const settings = {
    ...existing,
    ...(hooks.value.lines.length === 0 ? {} : { [claudeSettingKeys.hooks]: hooks.value.hooks }),
    ...(statusLine.length === 0 ? {} : { [claudeSettingKeys.statusLine]: ownSettingsEntries.statusLine }),
    ...(idle.length === 0 ? {} : { [claudeSettingKeys.idleCompaction]: request.idleCompaction }),
  };
  const rules = request.deny?.add === true || hooks.value.lines.length > 0 || statusLine.length > 0 ? request.deny?.rules ?? [] : [];
  const deny = addDenyRules(settings, rules, file, request.command);
  return deny.ok ? ok({
    settings: deny.value.settings,
    lines: [...lines, ...deny.value.lines],
    onlyIdleCompaction: hooks.value.lines.length === 0 && statusLine.length === 0 && deny.value.lines.length === 0 && idle.length > 0,
  }) : deny;
};

const shownChange = (file: string, lines: readonly string[]): string =>
  [`This changes the settings of Claude Code in ${file}:`, ...lines.map((line) => `  ${line}`)].join('\n');

/**
 * The notice for a no to a change that holds only the idle compaction value. The hooks are in place, so the text says nothing
 * of the hook. A work copy gets its value later from `upgrade`: a second `worker new` makes another worker.
 */
const declinedIdleCompactionText = (file: string, command: CommandText, session: HookSession): string => {
  const later =
    session === hookSessions.workCopy ? `run "${commandText(commands.upgrade)}" and answer yes` : `run "${commandText(command)}" again and answer yes`;
  return (
    `The settings in ${file} stay as they are, and the hooks are in place. ` +
    `The sessions of this folder keep the ${claudeSettingKeys.idleCompaction} value that the file holds, or the default of Claude Code when the file holds none. ` +
    `To choose the value on purpose, set ${idleCompactionKeyPath} in ${files.config}. To write the value later, ${later}.`
  );
};

/**
 * The notice for a no to the settings: the effect, and the way to add them later with the command that asked. The session is the
 * kind of the session folder. A worker has its work copy already, so the way to add the hook settings is a new worker. A change
 * that holds only the idle compaction value has its own text.
 */
export const declinedHookText = (declined: DeclinedOutcome, command: CommandText, session: HookSession = hookSessions.coordinator): string => {
  const { file } = declined;
  if (declined.onlyIdleCompaction) return declinedIdleCompactionText(file, command, session);
  const worker = session === hookSessions.workCopy;
  const later = worker
    ? `The ${roles.worker} gets no role text, so its launch stops. To add the settings, dismiss the ${roles.worker} with "${commandText(commands.dismiss)} ID". ` +
      `Then run "${commandText(command)}" again for a new ${roles.worker} and answer yes.`
    : `To add the settings later, run "${commandText(command)}" again and answer yes.`;
  return (
    `The hook settings in ${file} stay as they are, so Claude Code does not call the hook. ` +
    `${capitalize(program)} has no last-seen record of the ${worker ? roles.worker : roles.coordinator}, ` +
    `and a restart or a reboot can not resume the session by its id. ${later}`
  );
};

/**
 * The guard values of the consent rule. `init` keeps the session rule of the yes flag with every value: the factory list has no
 * entry for a new folder before `init` ends, so the values of that folder are not known yet.
 */
const consentGuards = async (deps: Deps, request: HookConsentRequest): Promise<GuardValues> =>
  request.command === commands.init ? allOn : guardValuesFor(deps, request.home);

/**
 * The yes flag is a consent outside a factory session. Inside one it counts only for a work copy with no settings file, or while
 * the session-checks guard is off. The test reads only the session marker, which the session controls: a process in the session
 * can remove the variable before it runs the command. So the refusal stops an accidental consent only. It is not a security boundary.
 */
const yesCounts = (deps: Deps, request: HookConsentRequest, fileExists: boolean, guards: GuardValues): boolean =>
  request.yes &&
  (!inFactorySession(deps) || !isGuardOn(guards, guardIds.sessionChecks) || (request.session === hookSessions.workCopy && !fileExists));

/** The yes flag inside a factory session, where it gives no consent: the command stops with a usage error, with or without a terminal. */
const yesRefused = (deps: Deps, request: HookConsentRequest, fileExists: boolean, guards: GuardValues): boolean =>
  request.yes && !yesCounts(deps, request, fileExists, guards);

/**
 * The remedy of a stop without consent. It never offers a flag that the next run refuses: the yes flag is offered only when
 * it would count for this session, this kind of session folder, this state of the file and these guard values.
 */
export const noConsentRemedy = (deps: Deps, request: HookConsentRequest, fileExists: boolean, guards: GuardValues): string => {
  const run = `Run "${commandText(request.command)}"`;
  if (yesCounts(deps, { ...request, yes: true }, fileExists, guards)) return `${run} in a terminal window, or add ${flagText(flags.yes)}.`;
  const elsewhere = `${run} outside the ${places.session}, or in a terminal window`;
  return request.yes
    ? `${flagText(flags.yes)} gives no consent inside a ${places.session}. ${elsewhere} without ${flagText(flags.yes)} and answer the question.`
    : `${elsewhere} and answer the question.`;
};

/** The same consent rule serves the check before other writes and the settings writer. */
const consentRoute = (
  deps: Deps,
  request: HookConsentRequest,
  fileExists: boolean,
  guards: GuardValues,
): 'flag' | 'ask-terminal' | 'refused-yes' | 'no-terminal' => {
  if (yesRefused(deps, request, fileExists, guards)) return 'refused-yes';
  if (yesCounts(deps, request, fileExists, guards)) return 'flag';
  return deps.stdinIsTTY && deps.stdoutIsTTY ? 'ask-terminal' : 'no-terminal';
};

/** The change is shown before consent. No terminal is distinct from a refused flag or a no to the question. With the guard of the
 * settings write off, the change needs no consent: it is shown as with the yes flag. A yes flag in a session still stops, unless
 * the values of the consent rule hold the session-checks guard off. */
const askConsent = async (
  deps: Deps,
  request: HookConsentRequest,
  shown: string,
  fileExists: boolean,
  guards: GuardValues,
): Promise<CliResult<'accepted' | 'declined' | 'no-terminal'>> => {
  const route = consentRoute(deps, request, fileExists, guards);
  if (route !== 'refused-yes' && !(await guardOn(deps, guardIds.settingsWrite, request.home))) {
    deps.warn(shown);
    return ok('accepted');
  }
  switch (route) {
    case 'flag':
      deps.warn(shown);
      return ok('accepted');
    case 'refused-yes':
      return usageError(shown, noConsentRemedy(deps, request, fileExists, guards));
    case 'no-terminal':
      return ok('no-terminal');
    case 'ask-terminal': {
      const answer = await deps.prompt(printable(`${shown}\nWrite this change? [y/N] `));
      return answer.ok ? ok(ACCEPT_ANSWER.test(answer.value.trim()) ? 'accepted' : 'declined') : answer;
    }
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
};

/** What a call finds: the target, the text of the file, and the change that the own entries make. Nothing is written. */
interface Plan {
  readonly target: Target;
  /** The text that the plan read, or null when there is no file. */
  readonly text: string | null;
  readonly change: Change;
}

/** The target and the content of its settings file, or null when there is no file. */
interface TargetRead {
  readonly target: Target;
  readonly content: FileContent | null;
}

/**
 * The checks of the target, then the read of the file. A path in the user settings folder, a link, a real path outside the
 * session folder or a file that is no object stops it. The first check compares the written path of the file and makes no call
 * of the file system, so it comes before any call on the target. These checks apply with every guard value.
 */
const readTarget = async (deps: Deps, request: HookConsentRequest): Promise<CliResult<TargetRead>> => {
  const target = targetOf(request.folder);
  const written = requireOutsideUserFolder(deps, target, request.command, target.file);
  if (!written.ok) return written;
  const parts = await checkParts(deps, target, request.command);
  if (!parts.ok) return parts;
  const real = await requireInsideSession(deps, target, request.command);
  if (!real.ok) return real;
  const resolved = requireOutsideUserFolder(deps, target, request.command, real.value);
  if (!resolved.ok) return resolved;
  const content = parts.value.exists ? await readSettings(deps, real.value, request.command) : ok(null);
  return content.ok ? ok({ target, content: content.value }) : content;
};

/** The checks of the target, then the change that the own entries make. */
const planChange = async (deps: Deps, request: HookConsentRequest): Promise<CliResult<Plan>> => {
  const read = await readTarget(deps, request);
  if (!read.ok) return read;
  const { target, content } = read.value;
  const change = addOwnEntries(content === null ? NO_SETTINGS : content.settings, target.file, request);
  return change.ok ? ok({ target, text: content === null ? null : content.text, change: change.value }) : change;
};

/**
 * True when a list of an event of the fixed list holds the own command of that event, under any matcher. An event whose value is
 * not a list holds nothing and does not hide the other events.
 */
export const holdsAnyOwnCommand = (settings: Settings): boolean => {
  const hooks = settings[claudeSettingKeys.hooks];
  return isRecord(hooks) && hookNames.events.some((event) => (groupsOfEvent(hooks, event) ?? []).some((group) => holdsOwnCommand(group, event)));
};

/**
 * True when the settings file of the session folder holds the own command of at least one event of the fixed list, under any
 * matcher, in a list. A session folder that is not there, a settings file that is not there and a file with no own command give
 * false: no hook of the program is there to bring up to date. An event whose value is not a list does not hide the own command of
 * another event: the file gives true, and `ensureHookSettings` then names that event. The checks of the target are those of
 * `ensureHookSettings`, so a link is a stop (exit 4) and a file that is not a JSON object is a failure (exit 1). The call writes
 * nothing and asks nothing.
 */
export const holdsOwnHook = async (deps: Deps, request: HookConsentRequest): Promise<CliResult<boolean>> => {
  const folder = await deps.fs.lstat(request.folder);
  if (!folder.ok) return folder;
  if (folder.value === null) return ok(false);
  const read = await readTarget(deps, request);
  if (!read.ok) return read;
  const { content } = read.value;
  return ok(content !== null && holdsAnyOwnCommand(content.settings));
};

/**
 * The plan for a session folder that does not exist yet. The folder will hold the settings file that a checkout puts there, with
 * the text `fileText`, or no file when it is null: then the file is new, and the change is every own entry.
 */
const futureFilePlan = (request: HookConsentRequest, fileText: string | null): CliResult<Plan> => {
  const target = targetOf(request.folder);
  const content = fileText === null ? ok(null) : parseSettings(fileText, target.file, request.command);
  if (!content.ok) return content;
  const change = addOwnEntries(content.value === null ? NO_SETTINGS : content.value.settings, target.file, request);
  return change.ok ? ok({ target, text: fileText, change: change.value }) : change;
};

/**
 * The plan to write after the consent. The file may have changed while the person answered: Claude Code saves its permission
 * rules in this file. So the call plans again from the file as it is now, with one read and no loop. It writes the new plan
 * when the file has the same text, or when the new change has the same lines that the person saw: the write adds only content
 * that the person saw, and it keeps what the other program saved. Any other change stops the call before the write. With the guard of the settings write off, the call writes the new plan.
 */
const planAfterConsent = async (deps: Deps, request: HookConsentRequest, seen: Plan): Promise<CliResult<Plan>> => {
  const now = await planChange(deps, request);
  if (!now.ok) return now;
  if (now.value.text === seen.text || isDeepStrictEqual(now.value.change.lines, seen.change.lines)) return now;
  if (!(await guardOn(deps, guardIds.settingsWrite, request.home))) return now;
  return failure(`cannot write ${seen.target.file}: it changed while the question waited`, `Check the file. ${again(request.command)}`);
};

/**
 * Make sure the settings file of the session folder holds the own hooks, the own status line and the wanted idle compaction
 * value. The checks of the target come first: a link, a real path outside the session folder or inside the user settings
 * folder is a stop (exit 4), and a file that is not a JSON object is a failure (exit 1) that leaves its bytes. Entries in place
 * need no question and no write. Else the change is shown with its target, the person consents, and the write keeps every other key. With no
 * terminal and no consent, the call writes nothing and gives a usage error (exit 2). With `noTerminalIdleChange` set to `return-outcome`,
 * an idle-only change instead gives a no-consent outcome. A refused yes flag still stops with exit 2. After consent, the call
 * reads the file again and plans once more. It writes only the change that the person saw and keeps other file changes.
 * A different change stops with exit 1 and no write. A dry run returns the change with no question and no write.
 */
export const ensureHookSettings = async (
  deps: Deps,
  request: HookSettingsRequest,
  noTerminalIdleChange: 'refuse' | 'return-outcome' = 'refuse',
): Promise<CliResult<HookSettingsOutcome>> => {
  const planned = await planChange(deps, request);
  if (!planned.ok) return planned;
  const { target, text, change } = planned.value;
  if (change.lines.length === 0) return ok({ kind: 'in-place', file: target.file });
  const shown = shownChange(target.file, change.lines);
  const { onlyIdleCompaction } = change;
  if (request.dryRun) return ok({ kind: 'would-write', file: target.file, change: shown, onlyIdleCompaction });
  const guards = await consentGuards(deps, request);
  const consent = await askConsent(deps, request, shown, text !== null, guards);
  if (!consent.ok) return consent;
  if (consent.value === 'no-terminal') {
    if (onlyIdleCompaction && noTerminalIdleChange === 'return-outcome') return ok({ kind: 'no-consent', file: target.file, onlyIdleCompaction });
    return usageError(shown, noConsentRemedy(deps, request, text !== null, guards));
  }
  if (consent.value === 'declined') return ok({ kind: 'declined', file: target.file, onlyIdleCompaction });
  const current = await planAfterConsent(deps, request, planned.value);
  if (!current.ok) return current;
  const info = current.value.text === null ? ok(null) : await deps.fs.statInfo(target.file);
  if (!info.ok) return info;
  const written = await writeInFolder(
    deps,
    { parent: target.folder, folder: target.claudeFolder, name: localSettingsFile, mode: info.value?.mode ?? localFileModes.private },
    `${JSON.stringify(current.value.change.settings, null, 2)}\n`,
  );
  return written.ok ? ok({ kind: 'written', file: target.file }) : written;
};

/**
 * The check for a command that writes other files before the settings file, and asks its question after them. It makes the
 * checks of the target and stops before the first write of the command when the question could not be answered later: the
 * change is to be made and either the yes flag is given inside a factory session, where it gives no consent (exit 2, also on
 * a terminal), or there is no terminal and no consent (exit 2). The session folder may not exist yet.
 * A terminal, the yes flag outside a factory session, or entries in place let the command go on.
 * A session folder that does not exist yet gets its settings file from a checkout when the repo tracks one: `checkoutText` is the
 * text of that file, and null means that the checkout puts no settings file there. The call plans with that text, so the
 * consent rule and a file that is no JSON object stop the command before the folder exists.
 * The call asks nothing and writes nothing. A session folder written inside the user settings folder stops it before any call
 * of the file system.
 * With the guard of the settings write off, a missing consent does not stop the command. The path checks and the refusal of
 * the yes flag inside a factory session still apply.
 */
export const requireHookConsent = async (
  deps: Deps,
  request: HookConsentRequest,
  checkoutText: string | null = null,
): Promise<CliResult<void>> => {
  const target = targetOf(request.folder);
  const written = requireOutsideUserFolder(deps, target, request.command, target.file);
  if (!written.ok) return written;
  const folder = await deps.fs.lstat(request.folder);
  if (!folder.ok) return folder;
  const planned = folder.value === null ? futureFilePlan(request, checkoutText) : await planChange(deps, request);
  if (!planned.ok) return planned;
  const { change, text } = planned.value;
  if (change.lines.length === 0) return ok(undefined);
  const guards = await consentGuards(deps, request);
  const route = consentRoute(deps, request, text !== null, guards);
  if (route === 'flag' || route === 'ask-terminal') return ok(undefined);
  if (route === 'no-terminal' && !(await guardOn(deps, guardIds.settingsWrite, request.home))) return ok(undefined);
  return usageError(shownChange(target.file, change.lines), noConsentRemedy(deps, request, text !== null, guards));
};
