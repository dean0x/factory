import { describe, expect, it } from 'vitest';
import {
  acceptEditsMode,
  claudeSettingKeys,
  commandSettingKeys,
  env,
  permissionSkipList,
  program,
  trafficEnvNames,
  type PermissionSkip,
} from '../../src/names.js';
import { analyzeSettings, isWholeToolRule, MAX_LISTED_RULES, MAX_RULE_CHARS } from '../../src/safety/settings.js';

/** A settings text that holds one item of the permission-skip list and nothing else. */
const textFor = (item: PermissionSkip): string => {
  if (item.kind === 'text') return JSON.stringify({ hooks: { note: `claude ${item.text} --version` } });
  const nested = [...item.path].reverse().reduce<unknown>((inner, key) => ({ [key]: inner }), item.value);
  return JSON.stringify(nested);
};

describe('the permission-skip list', () => {
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

  it('holds no allow rule: a rule that covers a whole tool is a warning and not a stop', () => {
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

describe('the variables with the prefix of the program in the environment values', () => {
  it('has the prefix that the names of the session variables start with', () => {
    expect(env.session.startsWith(env.factoryPrefix)).toBe(true);
    expect(env.home.startsWith(env.factoryPrefix)).toBe(true);
  });

  it.each([
    ['sets the session marker', { env: { [env.session]: 'other' } }],
    ['clears the session marker', { env: { [env.session]: '' } }],
    ['sets the session marker in other letter case', { env: { factory_session: 'x' } }],
    ['sets the home variable', { env: { [env.home]: '/elsewhere' } }],
    ['sets a variable that the program does not use', { env: { FACTORY_ANYTHING: '1' } }],
    ['sets the prefix alone', { env: { [env.factoryPrefix]: '1' } }],
  ])('finds a file that %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).changesFactoryEnv).toBe(true);
  });

  it.each([
    ['another variable', { env: { OTHER: '1' } }],
    ['a name that has the prefix in its middle', { env: { MY_FACTORY_HOME: '1' } }],
    ['a name that has the program name and no underscore', { env: { FACTORYHOME: '1' } }],
    ['the name in a value', { env: { OTHER: env.session } }],
    ['the name in another place', { hooks: { env: { [env.session]: 'x' } } }],
    ['no env', {}],
  ])('finds nothing for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).changesFactoryEnv).toBe(false);
  });

  it.each([
    ['the session marker', env.session],
    ['the home variable', env.home],
    ['a variable that the program does not use', 'FACTORY_ANYTHING'],
  ])('finds %s also in a file that is not valid JSON', (_name, name) => {
    const facts = analyzeSettings(`{"env": {"${name}": ""},`);
    expect(facts.valid).toBe(false);
    expect(facts.changesFactoryEnv).toBe(true);
  });

  it('finds nothing in a file that is not valid JSON when the prefix stands only inside a value', () => {
    const facts = analyzeSettings(`{"env": {"OTHER": "${env.home}"},`);
    expect(facts.valid).toBe(false);
    expect(facts.changesFactoryEnv).toBe(false);
  });

  it('is not a skip setting: it has its own result', () => {
    const facts = analyzeSettings(JSON.stringify({ env: { [env.session]: '' } }));
    expect(facts.skips).toEqual([]);
  });

  it.each([env.session, env.home, 'FACTORY_ANYTHING'])('finds %s when the file writes the env key twice and only one of them holds it', (name) => {
    const first = `{"env": {"${name}": ""}, "env": {"OTHER": "1"}}`;
    const last = `{"env": {"OTHER": "1"}, "env": {"${name}": ""}}`;
    expect(analyzeSettings(first).changesFactoryEnv).toBe(true);
    expect(analyzeSettings(last).changesFactoryEnv).toBe(true);
  });

  it('finds nothing when the file writes the env key twice and the name stands only as a value', () => {
    const text = `{"env": {"A": "1"}, "env": {"OTHER": "${env.session}"}}`;
    expect(analyzeSettings(text).changesFactoryEnv).toBe(false);
  });
});

describe('the env variables that set the proxy or the credential of the session', () => {
  it.each(trafficEnvNames.map((name) => [name] as const))('finds %s in the env values', (name) => {
    expect(analyzeSettings(JSON.stringify({ env: { [name]: 'x' } })).movesTraffic).toEqual([name]);
  });

  it('finds a name in other letter case, and every name of one file in the order of the list', () => {
    const facts = analyzeSettings(JSON.stringify({ env: { anthropic_api_key: 'x', [env.proxyBaseUrl]: 'http://h' } }));
    expect(facts.movesTraffic).toEqual([env.proxyBaseUrl, 'ANTHROPIC_API_KEY']);
  });

  it.each([
    ['another variable', { env: { OTHER: '1' } }],
    ['the name in a value', { env: { OTHER: env.proxyBaseUrl } }],
    ['the name outside env', { hooks: { env: { [env.proxyBaseUrl]: 'x' } } }],
    ['no env', {}],
  ])('finds nothing for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).movesTraffic).toEqual([]);
  });

  it('finds a name in a file that is not valid JSON, and in a file that writes the env key twice', () => {
    expect(analyzeSettings(`{"env": {"${env.proxyBaseUrl}": "http://h"},`).movesTraffic).toEqual([env.proxyBaseUrl]);
    const repeated = `{"env": {"${env.proxyBaseUrl}": "http://h"}, "env": {"OTHER": "1"}}`;
    expect(analyzeSettings(repeated).movesTraffic).toEqual([env.proxyBaseUrl]);
  });
});

describe('the env variables that set the state folder or the home folder of the user', () => {
  const stateNames = [env.stateHome, env.userHome];

  it.each(stateNames.map((name) => [name] as const))('finds %s in the env values', (name) => {
    expect(analyzeSettings(JSON.stringify({ env: { [name]: '/x' } })).movesState).toEqual([name]);
  });

  it('finds a name in other letter case, and every name of one file in the order of the list', () => {
    const facts = analyzeSettings(JSON.stringify({ env: { home: '/x', [env.stateHome]: '/y' } }));
    expect(facts.movesState).toEqual([env.stateHome, env.userHome]);
  });

  it.each([
    ['another variable', { env: { OTHER: '1' } }],
    ['a name that only starts like the home variable', { env: { HOME_BASE: '/x' } }],
    ['the name in a value', { env: { OTHER: env.userHome } }],
    ['the name outside env', { hooks: { env: { [env.stateHome]: '/x' } } }],
    ['no env', {}],
  ])('finds nothing for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).movesState).toEqual([]);
  });

  it('finds a name in a file that is not valid JSON, and in a file that writes the env key twice', () => {
    expect(analyzeSettings(`{"env": {"${env.stateHome}": "/x"},`).movesState).toEqual([env.stateHome]);
    const repeated = `{"env": {"${env.userHome}": "/x"}, "env": {"OTHER": "1"}}`;
    expect(analyzeSettings(repeated).movesState).toEqual([env.userHome]);
  });
});

describe('the settings that run a command', () => {
  const hookOf = (command: string): unknown => ({ SessionStart: [{ hooks: [{ type: 'command', command }] }] });

  it.each(commandSettingKeys.map((key) => [key] as const))('finds %s', (key) => {
    const value = key === claudeSettingKeys.hooks ? hookOf('echo hi') : { type: 'command', command: 'echo hi' };
    expect(analyzeSettings(JSON.stringify({ [key]: value })).runsCommands).toEqual([key]);
  });

  it('finds a setting that holds a plain command text', () => {
    expect(analyzeSettings(JSON.stringify({ apiKeyHelper: './get-key.sh' })).runsCommands).toEqual(['apiKeyHelper']);
  });

  it.each([
    ['the status line of the program', { statusLine: { type: 'command', command: `${program} hook statusline` } }],
    ['the hooks of the program', { hooks: { ...(hookOf(`${program} hook sessionstart`) as object), Stop: [{ hooks: [{ type: 'command', command: `${program} hook stop` }] }] } }],
    ['an empty hooks object', { hooks: {} }],
  ])('does not count %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).runsCommands).toEqual([]);
  });

  it.each([
    ['a hook with another command', { hooks: hookOf('echo hi') }],
    ['one other command among the hooks of the program', { hooks: { Stop: [{ hooks: [{ type: 'command', command: `${program} hook stop` }, { type: 'command', command: 'echo hi' }] }] } }],
    ['a command that only starts like the hook of the program', { hooks: hookOf(`${program} hook stop; echo hi`) }],
    ['a hook of another type', { hooks: { Stop: [{ hooks: [{ type: 'prompt', command: `${program} hook stop` }] }] } }],
    ['hooks that are not a list of groups', { hooks: { Stop: 'echo hi' } }],
    ['a status line with another command', { statusLine: { type: 'command', command: 'echo hi' } }],
    ['a status line that is only a text', { statusLine: `${program} hook statusline` }],
  ])('counts %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).runsCommands).toEqual([Object.keys(value)[0]]);
  });

  it('finds the settings of a file that is not valid JSON', () => {
    expect(analyzeSettings('{"hooks": {"Stop": []},').runsCommands).toEqual([claudeSettingKeys.hooks]);
  });

  it('finds nothing in a file with no such setting', () => {
    expect(analyzeSettings(JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, other: { hooks: 1 } })).runsCommands).toEqual([]);
  });
});

describe('an allow rule that covers a whole tool', () => {
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

describe('an allow rule for the lock run command', () => {
  const listed = (rule: string): ReturnType<typeof analyzeSettings> => analyzeSettings(JSON.stringify({ permissions: { allow: [rule] } }));

  it.each([
    'Bash(factory lock run:*)',
    'Bash(factory lock run *)',
    'Bash(factory lock run*)',
    'Bash(factory lock run --priority:*)',
    'Bash(factory lock run --:*)',
    'Bash(factory lock run -- :*)',
    'Bash(factory lock:*)',
    'Bash(factory:*)',
    'Bash(factory *)',
  ])('lists %s with the whole-tool rules, because the command after the double dash can be any command', (rule) => {
    const facts = listed(rule);
    expect(facts.wholeToolRules).toEqual([rule]);
    expect(facts.narrowRules).toEqual([]);
  });

  it.each([
    'Bash(factory lock run)',
    'Bash(factory lock run -- npm test)',
    'Bash(factory lock run -- npm:*)',
    'Bash(factory lock run --priority -- npm test)',
    'Bash(factory doctor:*)',
    'Bash(npm run:*)',
    'Read(factory lock run:*)',
  ])('keeps %s with the narrower rules', (rule) => {
    const facts = listed(rule);
    expect(facts.wholeToolRules).toEqual([]);
    expect(facts.narrowRules).toEqual([rule]);
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

describe('the settings that hold or refuse the input of other sessions', () => {
  it.each([['hold'], ['refuse']])('finds crossSessionInbound %s', (value) => {
    expect(analyzeSettings(JSON.stringify({ [claudeSettingKeys.crossSessionInbound]: value })).crossSessionInbound).toBe(value);
  });

  it.each([
    ['accept', { [claudeSettingKeys.crossSessionInbound]: 'accept' }],
    ['another text', { [claudeSettingKeys.crossSessionInbound]: 'Hold' }],
    ['a value that is no text', { [claudeSettingKeys.crossSessionInbound]: ['hold'] }],
    ['no setting', {}],
  ])('finds no crossSessionInbound for %s', (_name, value) => {
    expect(analyzeSettings(JSON.stringify(value)).crossSessionInbound).toBeNull();
  });

  it('finds the default mode plan, and no other mode', () => {
    expect(analyzeSettings(JSON.stringify({ permissions: { defaultMode: 'plan' } })).planMode).toBe(true);
    expect(analyzeSettings(JSON.stringify({ permissions: { defaultMode: acceptEditsMode } })).planMode).toBe(false);
    expect(analyzeSettings('{}').planMode).toBe(false);
  });
});

describe('the approval of project MCP servers', () => {
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

describe('the setting that turns off every hook', () => {
  const hooksOff = (text: string): boolean => analyzeSettings(text).disablesHooks;

  it('is found when the file sets it to true', () => {
    expect(hooksOff(JSON.stringify({ [claudeSettingKeys.disableAllHooks]: true }))).toBe(true);
  });

  it('is found also when the file is not valid JSON', () => {
    const facts = analyzeSettings(`// a comment\n{"${claudeSettingKeys.disableAllHooks}": true,,`);
    expect(facts.valid).toBe(false);
    expect(facts.disablesHooks).toBe(true);
  });

  it('is found when the text writes the key with an escape in its name', () => {
    expect(hooksOff('{"disableAll\\u0048ooks": true}')).toBe(true);
  });

  it('is found when the file writes the key twice and the last value is false', () => {
    expect(hooksOff('{"disableAllHooks": true, "disableAllHooks": false}')).toBe(true);
  });

  it.each([
    ['the value false', { [claudeSettingKeys.disableAllHooks]: false }],
    ['the value as text', { [claudeSettingKeys.disableAllHooks]: 'true' }],
    ['no setting', {}],
    ['a hooks entry', { hooks: { SessionStart: [] } }],
    ['the name inside a value', { note: 'disableAllHooks', other: { text: '"disableAllHooks": true' } }],
  ])('is not found for %s', (_name, value) => {
    expect(hooksOff(JSON.stringify(value))).toBe(false);
  });

  it('is not a permission skip: it has its own fact', () => {
    const facts = analyzeSettings(JSON.stringify({ [claudeSettingKeys.disableAllHooks]: true }));
    expect(facts.skips).toEqual([]);
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
      changesFactoryEnv: false,
      movesTraffic: [],
      movesState: [],
      runsCommands: [],
      wholeToolRules: [],
      narrowRules: [],
      acceptEdits: false,
      planMode: false,
      crossSessionInbound: null,
      approvesMcp: [],
      disablesHooks: false,
    });
  });
});
