import { describe, expect, it } from 'vitest';
import { acceptEditsMode, claudeSettingKeys, env, permissionSkipList, type PermissionSkip } from '../../src/names.js';
import { analyzeSettings, isWholeToolRule, MAX_LISTED_RULES, MAX_RULE_CHARS } from '../../src/safety/settings.js';

/** A settings text that holds one item of the permission-skip list and nothing else. */
const textFor = (item: PermissionSkip): string => {
  if (item.kind === 'text') return JSON.stringify({ hooks: { note: `claude ${item.text} --version` } });
  const nested = [...item.path].reverse().reduce<unknown>((inner, key) => ({ [key]: inner }), item.value);
  return JSON.stringify(nested);
};

describe('the permission-skip list (TP-133)', () => {
  it('has the four items of the design', () => {
    expect(permissionSkipList.map((item) => item.label)).toEqual([
      'permissions.defaultMode set to bypassPermissions',
      'the text dangerously-skip-permissions',
      'skipDangerousModePermissionPrompt set to true',
      'dangerouslySkipPermissions set to true',
    ]);
  });

  it.each(permissionSkipList.map((item) => [item.label, item] as const))('finds %s', (label, item) => {
    const facts = analyzeSettings(textFor(item));
    expect(facts.skips).toEqual([label]);
  });

  it.each(permissionSkipList.map((item) => [item.label, item] as const))(
    'finds %s also when the file is not valid JSON',
    (label, item) => {
      const facts = analyzeSettings(`// a comment\n${textFor(item)},,`);
      expect(facts.valid).toBe(false);
      expect(facts.skips).toEqual([label]);
    },
  );

  it('finds a setting that the text writes with an escape in its name', () => {
    const facts = analyzeSettings('{"skipDangerous\\u004dodePermissionPrompt": true}');
    expect(facts.skips).toEqual(['skipDangerousModePermissionPrompt set to true']);
  });

  it('holds no allow rule: a rule that covers a whole tool is a warning and not a stop (D-15 B)', () => {
    const facts = analyzeSettings(JSON.stringify({ permissions: { allow: ['Bash', 'Bash(*)', '*'] } }));
    expect(facts.skips).toEqual([]);
    expect(permissionSkipList.some((item) => item.kind === 'setting' && item.path.includes(claudeSettingKeys.allow))).toBe(false);
  });

  it.each([
    ['the default mode auto', { permissions: { defaultMode: 'auto' } }],
    ['the default mode acceptEdits', { permissions: { defaultMode: acceptEditsMode } }],
    ['a skip setting that is false', { skipDangerousModePermissionPrompt: false }],
    ['a skip setting that is the text true', { dangerouslySkipPermissions: 'true' }],
    ['the setting that hides the auto notice', { skipAutoPermissionPrompt: true }],
    ['the setting that forbids the bypass mode', { permissions: { disableBypassPermissionsMode: 'disable' } }],
    ['the word bypassPermissions in an allow rule', { permissions: { allow: ['Bash(echo bypassPermissions)'] } }],
    ['the default mode key in another place', { other: { defaultMode: 'auto' } }],
  ])('finds no skip in %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).skips).toEqual([]);
  });

  it('finds every item of one file, in the order of the list', () => {
    const facts = analyzeSettings(
      JSON.stringify({
        dangerouslySkipPermissions: true,
        skipDangerousModePermissionPrompt: true,
        permissions: { defaultMode: 'bypassPermissions' },
        hooks: { a: 'claude --dangerously-skip-permissions' },
      }),
    );
    expect(facts.skips).toEqual(permissionSkipList.map((item) => item.label));
  });
});

describe('the session marker in the environment values (TP-179)', () => {
  it.each([
    ['sets it', { env: { [env.session]: 'other' } }],
    ['clears it', { env: { [env.session]: '' } }],
    ['sets it in other letter case', { env: { factory_session: 'x' } }],
  ])('finds a file that %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).changesSessionMarker).toBe(true);
  });

  it.each([
    ['another variable', { env: { OTHER: '1' } }],
    ['the name in a value', { env: { OTHER: env.session } }],
    ['the name in another place', { hooks: { env: { [env.session]: 'x' } } }],
    ['no env', {}],
  ])('finds nothing for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).changesSessionMarker).toBe(false);
  });

  it('finds it also in a file that is not valid JSON', () => {
    const facts = analyzeSettings(`{"env": {"${env.session}": ""},`);
    expect(facts.valid).toBe(false);
    expect(facts.changesSessionMarker).toBe(true);
  });

  it('is not a skip setting: it has its own result', () => {
    const facts = analyzeSettings(JSON.stringify({ env: { [env.session]: '' } }));
    expect(facts.skips).toEqual([]);
  });
});

describe('an allow rule that covers a whole tool (TP-154)', () => {
  it.each([
    'Bash',
    'Bash()',
    'Bash(*)',
    'Bash( * )',
    '*',
    'WebFetch',
    'Read',
    'mcp__github',
    'mcp__github__*',
    'mcp__github__create_issue',
  ])('takes %s as a whole-tool rule', (rule) => {
    expect(isWholeToolRule(rule)).toBe(true);
  });

  it.each(['Bash(npm test)', 'Bash(npm run:*)', 'Read(./.env)', 'WebFetch(domain:example.com)', '', 'Bash(*) extra', 'Bash (*)'])(
    'takes %s as a narrower rule or no rule',
    (rule) => {
      expect(isWholeToolRule(rule)).toBe(false);
    },
  );

  it('lists the whole-tool rules and the narrower rules apart, and skips an item that is no text', () => {
    const facts = analyzeSettings(
      JSON.stringify({ permissions: { allow: ['Bash', 'Bash(npm test)', 7, null, '*', 'Read(./src/**)'] } }),
    );
    expect(facts.wholeToolRules).toEqual(['Bash', '*']);
    expect(facts.narrowRules).toEqual(['Bash(npm test)', 'Read(./src/**)']);
  });

  it('holds no rule when the allow list is not a list', () => {
    const facts = analyzeSettings(JSON.stringify({ permissions: { allow: 'Bash' } }));
    expect(facts.wholeToolRules).toEqual([]);
    expect(facts.narrowRules).toEqual([]);
  });

  it('keeps at most a fixed number of rules of each kind, each cut at a fixed length', () => {
    const many = Array.from({ length: MAX_LISTED_RULES + 30 }, (_value, index) => `Bash(command ${index})`);
    const long = `Bash(${'x'.repeat(MAX_RULE_CHARS * 2)})`;
    const facts = analyzeSettings(JSON.stringify({ permissions: { allow: [...many, long] } }));
    expect(facts.narrowRules).toHaveLength(MAX_LISTED_RULES);
    const cut = analyzeSettings(JSON.stringify({ permissions: { allow: [long] } })).narrowRules[0] ?? '';
    expect(cut.length).toBeLessThanOrEqual(MAX_RULE_CHARS);
  });
});

describe('the permission mode acceptEdits', () => {
  it('is found as the default mode', () => {
    expect(analyzeSettings(JSON.stringify({ permissions: { defaultMode: acceptEditsMode } })).acceptEdits).toBe(true);
  });

  it('is not found for another mode', () => {
    expect(analyzeSettings(JSON.stringify({ permissions: { defaultMode: 'plan' } })).acceptEdits).toBe(false);
  });
});

describe('the approval of project MCP servers (TP-180)', () => {
  it('finds the setting that approves all of them', () => {
    expect(analyzeSettings(JSON.stringify({ [claudeSettingKeys.approveAllMcp]: true })).approvesMcp).toEqual([
      claudeSettingKeys.approveAllMcp,
    ]);
  });

  it('finds the setting that approves a list of them', () => {
    expect(analyzeSettings(JSON.stringify({ [claudeSettingKeys.approveMcpList]: ['db'] })).approvesMcp).toEqual([
      claudeSettingKeys.approveMcpList,
    ]);
  });

  it('finds both in one file', () => {
    const facts = analyzeSettings(
      JSON.stringify({ [claudeSettingKeys.approveAllMcp]: true, [claudeSettingKeys.approveMcpList]: ['a', 'b'] }),
    );
    expect(facts.approvesMcp).toEqual([claudeSettingKeys.approveAllMcp, claudeSettingKeys.approveMcpList]);
  });

  it.each([
    ['all servers set to false', { [claudeSettingKeys.approveAllMcp]: false }],
    ['an empty list', { [claudeSettingKeys.approveMcpList]: [] }],
    ['a list that is no list', { [claudeSettingKeys.approveMcpList]: 'db' }],
    ['no setting', {}],
  ])('finds nothing for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).approvesMcp).toEqual([]);
  });
});

describe('a text that is not a settings object', () => {
  it.each([
    ['not JSON', 'this is not json'],
    ['a list', '[1, 2]'],
    ['a string', '"text"'],
    ['null', 'null'],
    ['an empty text', ''],
  ])('does not throw for %s, and reports it as not valid', (_name, text) => {
    const facts = analyzeSettings(text);
    expect(facts.valid).toBe(false);
    expect(facts.skips).toEqual([]);
    expect(facts.wholeToolRules).toEqual([]);
  });

  it('reports an empty object as valid with no finding', () => {
    expect(analyzeSettings('{}')).toEqual({
      valid: true,
      skips: [],
      changesSessionMarker: false,
      wholeToolRules: [],
      narrowRules: [],
      acceptEdits: false,
      approvesMcp: [],
    });
  });
});
