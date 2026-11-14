import {
  acceptEditsMode,
  claudeSettingKeys,
  commandLines,
  commandSettingKeys,
  commandText,
  crossSessionHeldValues,
  env,
  flags,
  flagText,
  ownHookCommand,
  permissionSkipList,
  planMode,
  settingsCommandType,
  trafficEnvNames,
  type CrossSessionHeldValue,
  type PermissionSkip,
} from '../names.js';
import { parseJsonText } from '../state/load.js';

/**
 * The facts about one Claude Code settings file that the checks of the root use (design 4.4, AC-21). The analysis is a
 * pure function of the text. It never fails: a text that is not a settings object gives a result with `valid` false, and
 * the checks that read the raw text still run, so a broken file does not hide a setting that skips permission prompts.
 */

/** The most rules of one kind that a result keeps, and the most characters of one rule. */
export const MAX_LISTED_RULES = 20;
export const MAX_RULE_CHARS = 80;

export interface SettingsFacts {
  /** True when the text is a JSON object. Claude Code skips a file that is not valid. */
  readonly valid: boolean;
  /** The labels of the items of the permission-skip list that the file holds, in the order of the list. */
  readonly skips: readonly string[];
  /** True when the `env` values of the file set or clear a variable with the prefix of the program, such as the session marker. */
  readonly changesFactoryEnv: boolean;
  /** The `env` variables of the file that set the proxy or the credential of the session, in the order of the list. */
  readonly movesTraffic: readonly string[];
  /** The settings of the file that run a command, except the hook and the status line that the program writes. */
  readonly runsCommands: readonly string[];
  /** The allow rules that cover a whole tool, or every command of `lock run`. At most `MAX_LISTED_RULES`, each cut at `MAX_RULE_CHARS`. */
  readonly wholeToolRules: readonly string[];
  /** The other allow rules, with the same bounds. */
  readonly narrowRules: readonly string[];
  /** True when the default mode is `acceptEdits`. */
  readonly acceptEdits: boolean;
  /** True when the default mode is `plan`. */
  readonly planMode: boolean;
  /** The value of `crossSessionInbound` when it holds or refuses the input of other sessions. Null for any other value, and when it is not set. */
  readonly crossSessionInbound: CrossSessionHeldValue | null;
  /** The names of the settings that approve the MCP servers of a project: all of them, or a list. */
  readonly approvesMcp: readonly string[];
  /** True when the file sets `disableAllHooks` to true, so that a session that reads it runs no hook. */
  readonly disablesHooks: boolean;
}

/**
 * A rule covers a whole tool when it is the tool name alone (`Bash`), the name with empty parentheses or a star in them
 * (`Bash()` and `Bash(*)`), or the star alone. A rule `mcp__<server>__*` covers every tool of a server. The permissions page
 * (https://code.claude.com/docs/en/permissions, "Match all uses of a tool") says that a rule with only the tool name matches
 * all uses of the tool and that `Bash()` is the same as `Bash`.
 */
const WHOLE_TOOL_RULE = /^(?:\*|[A-Za-z_][\w.-]*(?:\(\s*\*?\s*\))?|mcp__[\w-]+__\*)$/;

export const isWholeToolRule = (rule: string): boolean => WHOLE_TOOL_RULE.test(rule);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a path of keys, or undefined. Only own keys count. */
const valueAt = (root: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, key) => (isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined), root);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The item as it stands in the text of a file: the last key of its path, a colon and its value. */
const textPatternOf = (item: Extract<PermissionSkip, { kind: 'setting' }>): RegExp => {
  const key = item.path.at(-1) ?? '';
  return new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*${escapeRegExp(JSON.stringify(item.value))}`);
};

/**
 * The items of the permission-skip list that a file holds. A setting counts when the parsed file holds its value at its
 * path, and when the raw text writes the key and the value. Both ways run, so a parser that reads a file in another way
 * than this one does (a comment, a repeated key, an escape in a name) does not hide a setting.
 */
const skipsOf = (text: string, parsed: unknown): readonly string[] =>
  permissionSkipList.filter((item) =>
    item.kind === 'text'
      ? text.includes(item.text)
      : valueAt(parsed, item.path) === item.value || textPatternOf(item).test(text),
  ).map((item) => item.label);

/** The key as the text of a file writes it: in quotes and followed by a colon. The letter case does not count. */
const keyPatternOf = (key: string, flags = 'i'): RegExp => new RegExp(`"${escapeRegExp(key)}"\\s*:`, flags);

/** A key that starts with `prefix`, as the text of a file writes it: in quotes and followed by a colon. The letter case does not count. */
const keyPrefixPatternOf = (prefix: string): RegExp => new RegExp(`"${escapeRegExp(prefix)}(?:[^"\\\\]|\\\\.)*"\\s*:`, 'i');

/**
 * The lower-case names of the `env` values of the parsed file, and whether the raw text must be read as well: it must when the
 * text does not parse, and when it writes the key `env` more than once, because a parser that keeps the last `env` value hides
 * the others.
 */
const envScanOf = (text: string, parsed: unknown): { readonly names: readonly string[]; readonly readsText: boolean } => {
  const values = valueAt(parsed, [claudeSettingKeys.env]);
  return {
    names: isRecord(values) ? Object.keys(values).map((name) => name.toLowerCase()) : [],
    readsText: !isRecord(parsed) || (text.match(keyPatternOf(claudeSettingKeys.env, 'gi')) ?? []).length > 1,
  };
};

/**
 * The names of `wanted` that the `env` values of the file hold, in the order of `wanted` and in any letter case. When the raw
 * text is read, a key with that name followed by a colon counts, because the file may still be read by another parser.
 */
const envNamesIn = (text: string, parsed: unknown, wanted: readonly string[]): readonly string[] => {
  const { names, readsText } = envScanOf(text, parsed);
  return wanted.filter((name) => names.includes(name.toLowerCase()) || (readsText && keyPatternOf(name).test(text)));
};

/** True when an `env` value of the file holds a name that starts with `prefix`. The text is read in the same cases as above. */
const envPrefixIn = (text: string, parsed: unknown, prefix: string): boolean => {
  const { names, readsText } = envScanOf(text, parsed);
  return names.some((name) => name.startsWith(prefix.toLowerCase())) || (readsText && keyPrefixPatternOf(prefix).test(text));
};

/** A hook or status line handler that the program writes: a command of the form `<program> hook <event>`. */
const isOwnHandler = (handler: unknown): boolean =>
  isRecord(handler) && handler.type === settingsCommandType && typeof handler.command === 'string' && ownHookCommand.test(handler.command);

/** The `hooks` value holds handlers of the program only: each event has a list of groups, and each group a list of handlers. */
const isOwnHooks = (hooks: unknown): boolean =>
  isRecord(hooks) &&
  Object.values(hooks).every(
    (groups) =>
      Array.isArray(groups) &&
      groups.every((group) => isRecord(group) && Array.isArray(group.hooks) && group.hooks.every(isOwnHandler)),
  );

/** The settings that have a form which the program writes itself. Any other setting of the list runs a command of the user. */
const OWN_FORMS: Readonly<Record<string, (value: unknown) => boolean>> = {
  [claudeSettingKeys.hooks]: isOwnHooks,
  [claudeSettingKeys.statusLine]: isOwnHandler,
};

/** The settings of the list that run a command and are not in the form of the program. A text that does not parse is read as text. */
const runsCommands = (text: string, parsed: unknown): readonly string[] =>
  commandSettingKeys.filter((key) =>
    isRecord(parsed) ? Object.hasOwn(parsed, key) && !(OWN_FORMS[key]?.(parsed[key]) ?? false) : keyPatternOf(key).test(text),
  );

/**
 * A `Bash` rule with a wildcard at its end (`Bash(<start>:*)`, `Bash(<start> *)` or `Bash(<start>*)`) matches every command line that
 * begins with `<start>`. The command after the double dash of `lock run` can be any command, a shell too. So a rule allows every
 * command when its start is the start of the `lock run` line, or that line with only the flag `--priority` and the double dash added.
 */
const BASH_RULE_OPEN = 'Bash(';
const LOCK_RUN_LINE = commandText(commandLines.lockRun);
const LOCK_RUN_WITH_FLAGS = new RegExp(`^${escapeRegExp(LOCK_RUN_LINE)}(?: ${escapeRegExp(flagText(flags.priority))})?(?: --)?$`);

/** The start of a `Bash` rule with a wildcard at its end, or null for any other rule. The steps are linear in the length of the rule. */
const wildcardStartOf = (rule: string): string | null => {
  if (!rule.startsWith(BASH_RULE_OPEN) || !rule.endsWith(')')) return null;
  const inner = rule.slice(BASH_RULE_OPEN.length, -1).trimEnd();
  if (!inner.endsWith('*')) return null;
  const start = inner.slice(0, -1);
  return (start.endsWith(':') ? start.slice(0, -1) : start).trim();
};

const allowsAnyLockRunCommand = (rule: string): boolean => {
  const start = wildcardStartOf(rule);
  return start !== null && (LOCK_RUN_LINE.startsWith(start) || LOCK_RUN_WITH_FLAGS.test(start));
};

const allowsEveryUse = (rule: string): boolean => isWholeToolRule(rule) || allowsAnyLockRunCommand(rule);

const shown = (rule: string): string => rule.slice(0, MAX_RULE_CHARS);

const allowRules = (parsed: unknown): readonly string[] => {
  const rules = valueAt(parsed, [claudeSettingKeys.permissions, claudeSettingKeys.allow]);
  return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === 'string') : [];
};

const approvesMcp = (parsed: unknown): readonly string[] => {
  const list = valueAt(parsed, [claudeSettingKeys.approveMcpList]);
  return [
    ...(valueAt(parsed, [claudeSettingKeys.approveAllMcp]) === true ? [claudeSettingKeys.approveAllMcp] : []),
    ...(Array.isArray(list) && list.length > 0 ? [claudeSettingKeys.approveMcpList] : []),
  ];
};

const heldCrossSession = (parsed: unknown): CrossSessionHeldValue | null => {
  const value = valueAt(parsed, [claudeSettingKeys.crossSessionInbound]);
  return crossSessionHeldValues.find((held) => held === value) ?? null;
};

const HOOKS_OFF_PATTERN = new RegExp(`"${escapeRegExp(claudeSettingKeys.disableAllHooks)}"\\s*:\\s*true`);

/** Same two ways as `skipsOf`: the parsed value, and the raw text, so that a parser that reads a file in another way does not hide it. */
const disablesHooks = (text: string, parsed: unknown): boolean =>
  valueAt(parsed, [claudeSettingKeys.disableAllHooks]) === true || HOOKS_OFF_PATTERN.test(text);

export const analyzeSettings = (text: string): SettingsFacts => {
  const json = parseJsonText(text);
  const parsed = json.ok ? json.value : undefined;
  const rules = allowRules(parsed);
  return {
    valid: isRecord(parsed),
    skips: skipsOf(text, parsed),
    changesFactoryEnv: envPrefixIn(text, parsed, env.factoryPrefix),
    movesTraffic: envNamesIn(text, parsed, trafficEnvNames),
    runsCommands: runsCommands(text, parsed),
    wholeToolRules: rules.filter(allowsEveryUse).slice(0, MAX_LISTED_RULES).map(shown),
    narrowRules: rules.filter((rule) => !allowsEveryUse(rule)).slice(0, MAX_LISTED_RULES).map(shown),
    acceptEdits: valueAt(parsed, [claudeSettingKeys.permissions, claudeSettingKeys.defaultMode]) === acceptEditsMode,
    planMode: valueAt(parsed, [claudeSettingKeys.permissions, claudeSettingKeys.defaultMode]) === planMode,
    crossSessionInbound: heldCrossSession(parsed),
    approvesMcp: approvesMcp(parsed),
    disablesHooks: disablesHooks(text, parsed),
  };
};
