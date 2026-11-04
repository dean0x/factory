import {
  acceptEditsMode,
  claudeSettingKeys,
  commandSettingKeys,
  env,
  ownHookCommand,
  permissionSkipList,
  settingsCommandType,
  trafficEnvNames,
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
  /** True when the `env` values of the file set or clear the session marker variable. */
  readonly changesSessionMarker: boolean;
  /** The `env` variables of the file that set the proxy or the credential of the session, in the order of the list. */
  readonly movesTraffic: readonly string[];
  /** The settings of the file that run a command, except the hook and the status line that the program writes. */
  readonly runsCommands: readonly string[];
  /** The allow rules that cover a whole tool. At most `MAX_LISTED_RULES`, each cut at `MAX_RULE_CHARS`. */
  readonly wholeToolRules: readonly string[];
  /** The other allow rules, with the same bounds. */
  readonly narrowRules: readonly string[];
  /** True when the default mode is `acceptEdits`. */
  readonly acceptEdits: boolean;
  /** The names of the settings that approve the MCP servers of a project: all of them, or a list. */
  readonly approvesMcp: readonly string[];
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

/**
 * The names of `wanted` that the `env` values of the file hold, in the order of `wanted` and in any letter case. A text that
 * does not parse is read as text: a key with that name followed by a colon counts, because the file may still be read by
 * another parser. The text is read also when it writes the key `env` more than once, because a parser that keeps the last
 * `env` value hides the others.
 */
const envNamesIn = (text: string, parsed: unknown, wanted: readonly string[]): readonly string[] => {
  const values = valueAt(parsed, [claudeSettingKeys.env]);
  const names = isRecord(values) ? Object.keys(values).map((name) => name.toLowerCase()) : [];
  const readsText = !isRecord(parsed) || (text.match(keyPatternOf(claudeSettingKeys.env, 'gi')) ?? []).length > 1;
  return wanted.filter((name) => names.includes(name.toLowerCase()) || (readsText && keyPatternOf(name).test(text)));
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

export const analyzeSettings = (text: string): SettingsFacts => {
  const json = parseJsonText(text);
  const parsed = json.ok ? json.value : undefined;
  const rules = allowRules(parsed);
  return {
    valid: isRecord(parsed),
    skips: skipsOf(text, parsed),
    changesSessionMarker: envNamesIn(text, parsed, [env.session]).length > 0,
    movesTraffic: envNamesIn(text, parsed, trafficEnvNames),
    runsCommands: runsCommands(text, parsed),
    wholeToolRules: rules.filter(isWholeToolRule).slice(0, MAX_LISTED_RULES).map(shown),
    narrowRules: rules.filter((rule) => !isWholeToolRule(rule)).slice(0, MAX_LISTED_RULES).map(shown),
    acceptEdits: valueAt(parsed, [claudeSettingKeys.permissions, claudeSettingKeys.defaultMode]) === acceptEditsMode,
    approvesMcp: approvesMcp(parsed),
  };
};
