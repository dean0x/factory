import {
  acceptEditsMode,
  claudeSettingKeys,
  env,
  permissionSkipList,
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

/**
 * The `env` values of the file name the session marker variable, in any letter case. A text that does not parse is read
 * as text: a key with that name followed by a colon counts, because the file may still be read by another parser.
 */
const changesSessionMarker = (text: string, parsed: unknown): boolean => {
  if (!isRecord(parsed)) return new RegExp(`"${escapeRegExp(env.session)}"\\s*:`, 'i').test(text);
  const values = valueAt(parsed, [claudeSettingKeys.env]);
  return isRecord(values) && Object.keys(values).some((name) => name.toLowerCase() === env.session.toLowerCase());
};

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
    changesSessionMarker: changesSessionMarker(text, parsed),
    wholeToolRules: rules.filter(isWholeToolRule).slice(0, MAX_LISTED_RULES).map(shown),
    narrowRules: rules.filter((rule) => !isWholeToolRule(rule)).slice(0, MAX_LISTED_RULES).map(shown),
    acceptEdits: valueAt(parsed, [claudeSettingKeys.permissions, claudeSettingKeys.defaultMode]) === acceptEditsMode,
    approvesMcp: approvesMcp(parsed),
  };
};
