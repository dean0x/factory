import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellWord } from '../../src/core/shell-word.js';
import { launchArgv, stripScript, workerLaunchArgv } from '../../src/launch/argv.js';
import { claudeEnvStrip } from '../../src/names.js';

/**
 * These tests run the strip text of the launch with a real shell and a real `awk`, in an environment that the test builds out of
 * fake names and fake values. `execFile` gets an empty environment, and `env -i` starts the shell with only the variables that a
 * test names, so no test reads, lists or prints a variable of the real environment.
 */

const ENV_PROGRAM = '/usr/bin/env';
const SAFE_PATH = '/usr/bin:/bin';

/** The variables that a Claude Code session sets for its children. The names are written out here, so a test pins them. */
const PARENT_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
];

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type Variables = Readonly<Record<string, string>>;

/** Runs the strip text under `env -i` with these variables, then the command after it. */
const stripped = (variables: Variables, command: readonly string[], path: string = SAFE_PATH): Promise<Outcome> =>
  new Promise((resolve) => {
    const assignments = Object.entries({ PATH: path, ...variables }).map(([name, value]) => `${name}=${value}`);
    const args = ['-i', ...assignments, '/bin/sh', '-c', stripScript, claudeEnvStrip.scriptName, ...command];
    execFile(ENV_PROGRAM, args, { env: {}, encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });

/** A shell text that prints the value of each named variable that it has, in the order of the names. A name that is not set prints nothing. */
const PRINT_EACH = 'for name in "$@"; do printenv "$name"; done';

/** Runs the strip text, then prints the values of the named variables that the command still has. */
const printed = (variables: Variables, names: readonly string[]): Promise<Outcome> =>
  stripped(variables, ['/bin/sh', '-c', PRINT_EACH, 'x', ...names]);

/** The names, among those given, that are still in the environment of the command. A fake value is the name itself. */
const survivors = async (names: readonly string[]): Promise<readonly string[]> => {
  const result = await printed(Object.fromEntries(names.map((name) => [name, name])), names);
  expect(result.stderr).toBe('');
  return result.stdout.split('\n').filter((line) => line !== '');
};

describe('the strip text of the launch', () => {
  it('removes each variable that a Claude Code session sets for its children', async () => {
    expect(await survivors(PARENT_VARIABLES)).toEqual([]);
  });

  it('removes a name that no list knows: every name that starts with CLAUDE', async () => {
    const names = ['CLAUDE_FAKE_PARENT', 'CLAUDE_CODE_FAKE_NEW_NAME', 'CLAUDECODE_FAKE', 'CLAUDE'];
    expect(await survivors(names)).toEqual([]);
  });

  it('keeps every other variable, also a name that only holds CLAUDE or has it in lower case', async () => {
    const names = ['OTHER', 'MYCLAUDE_FAKE', 'NOT_CLAUDE', 'claude_fake', 'Claude_Fake', 'ANTHROPIC_FAKE'];
    expect(await survivors(names)).toEqual(names);
  });

  it('keeps each name of the kept list, and removes the names that only start like a kept name', async () => {
    const lookalikes = claudeEnvStrip.kept.map((name) => `${name}_FAKE`);
    expect(await survivors([...claudeEnvStrip.kept, ...lookalikes])).toEqual([...claudeEnvStrip.kept]);
  });

  it('keeps the kept list to the settings of the user: no name of a session, a parent, a socket, a token or a process', () => {
    expect([...claudeEnvStrip.kept]).toEqual([
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
    ]);
    expect(claudeEnvStrip.kept.filter((name) => PARENT_VARIABLES.includes(name))).toEqual([]);
    expect(claudeEnvStrip.kept.filter((name) => /SESSION|PARENT|SOCKET|TOKEN|ENTRYPOINT|EXECPATH|PID/.test(name))).toEqual([]);
  });

  it('prints nothing of its own, on stdout or on stderr, also when it removes values that look like secrets', async () => {
    const variables = Object.fromEntries([...PARENT_VARIABLES, 'CLAUDE_FAKE_PARENT'].map((name) => [name, 'fake-secret-value']));
    const result = await stripped({ ...variables, CLAUDE_CONFIG_DIR: '/fake/config' }, ['/usr/bin/true']);
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('runs the command after it with the exit code of that command', async () => {
    expect((await stripped({}, ['/bin/sh', '-c', 'exit 7'])).code).toBe(7);
  });

  it('leaves the output of the environment with the kept names and the other names only', async () => {
    const result = await stripped(
      { CLAUDE_FAKE_PARENT: '1', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/fake/config', OTHER: 'keep' },
      [ENV_PROGRAM],
    );
    const names = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(0, line.indexOf('=')))
      .filter((name) => name.startsWith('CLAUDE') || name === 'OTHER');
    expect(names.sort()).toEqual(['CLAUDE_CONFIG_DIR', 'OTHER']);
    expect(result.stderr).toBe('');
  });

  it('reads no value: a value with a new line and a CLAUDE_ text adds no name to remove and removes no kept name', async () => {
    const forged = 'x\nCLAUDE_EVIL=1\nCLAUDE_CONFIG_DIR=forged\nCLAUDE_CODE_USE_VERTEX=1';
    const result = await printed(
      { OTHER: forged, CLAUDE_CONFIG_DIR: '/fake/config', CLAUDE_FAKE_MULTI: `a\n${forged}` },
      ['OTHER', 'CLAUDE_CONFIG_DIR', 'CLAUDE_FAKE_MULTI', 'CLAUDE_EVIL', 'CLAUDE_CODE_USE_VERTEX'],
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${forged}\n/fake/config\n`);
  });

  it('keeps a kept value whole, also when it holds a new line and a name that the strip removes', async () => {
    const value = '/fake/config\nCLAUDE_SECRET=1';
    const result = await printed({ CLAUDE_CONFIG_DIR: value, CLAUDE_SECRET: '1' }, ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECRET']);
    expect(result.stdout).toBe(`${value}\n`);
    expect(result.stderr).toBe('');
  });

  it('runs no part of a name: a name that is not letters, digits and underscores is left alone and runs nothing', async () => {
    const odd = ['CLAUDE_X;echo INJECTED', 'CLAUDE-DASH', 'CLAUDE_X$(echo INJECTED)'];
    const result = await printed(
      { ...Object.fromEntries(odd.map((name) => [name, '1'])), CLAUDE_FAKE_PARENT: '1', OTHER: 'keep' },
      ['OTHER', 'CLAUDE_FAKE_PARENT'],
    );
    expect(result).toEqual({ code: expect.any(Number), stdout: 'keep\n', stderr: '' });
  });

  it('fails closed: when awk is not found, the command after it does not run, and nothing prints', async () => {
    const result = await stripped({ CLAUDE_FAKE_PARENT: '1' }, ['/bin/sh', '-c', 'printf ran'], '/nonexistent');
    expect(result).toEqual({ code: 1, stdout: '', stderr: '' });
  });

  it('hands each word after it to the command as one word, whatever the word holds', async () => {
    const word = 'it\'s a "q" $HOME `id` $(id) ; | & < > * ? [x] {a,b} \\ \ttab\nnew line';
    const result = await stripped({}, ['/bin/sh', '-c', 'printf %s "$1"', 'x', word]);
    expect(result).toEqual({ code: 0, stdout: word, stderr: '' });
  });

  it('is one line with no control character, so a start command shows it as one word', () => {
    expect(stripScript).toMatch(/^[ -~]+$/);
    expect(stripScript).not.toContain('\\');
  });

  it('shows in the dry run as one shell word that gives back the text', async () => {
    const result = await new Promise<Outcome>((resolve) => {
      execFile('/bin/sh', ['-c', `printf %s ${shellWord(stripScript)}`], { env: {}, encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : -1, stdout, stderr });
      });
    });
    expect(result).toEqual({ code: 0, stdout: stripScript, stderr: '' });
  });
});

describe('the start argument list and the strip text', () => {
  const COORDINATOR = {
    home: '/w/demo-factory',
    coordinatorDir: '/w/demo-factory/coordinator',
    stateDir: '/w/demo-factory/.factory',
    sessionId: 'demo',
    effort: 'high',
    model: 'default',
    proxyBaseUrl: null,
    path: SAFE_PATH,
    agent: 'claude',
    projects: ['/w/web'],
  } as const;
  const WORKER = { home: '/w/demo-factory', nodeId: 'demo', workerId: 'web-search', effort: 'high', model: 'default', proxyBaseUrl: null, path: SAFE_PATH, agent: 'claude' } as const;

  const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('starts the coordinator with the shell, the fixed strip text and a fixed name, then env', () => {
    expect(must(launchArgv(COORDINATOR)).slice(0, 5)).toEqual(['/bin/sh', '-c', stripScript, 'factory-launch', 'env']);
  });

  it('starts a worker with the shell, the fixed strip text and a fixed name, then env', () => {
    expect(must(workerLaunchArgv(WORKER)).slice(0, 5)).toEqual(['/bin/sh', '-c', stripScript, 'factory-launch', 'env']);
  });

  it('gives the same strip text to every launch, and holds no value of the input in it', () => {
    const odd = "/w/it's a $HOME dir";
    const launches = [
      must(launchArgv(COORDINATOR)),
      must(launchArgv({ ...COORDINATOR, home: odd, coordinatorDir: `${odd}/coordinator`, stateDir: `${odd}/.factory`, model: 'opus', proxyBaseUrl: 'http://127.0.0.1:1' })),
      must(workerLaunchArgv(WORKER)),
      must(workerLaunchArgv({ ...WORKER, home: odd, workerId: 'other', model: 'opus', proxyBaseUrl: 'http://127.0.0.1:1', path: '/opt/x' })),
    ];
    for (const argv of launches) {
      expect(argv[2]).toBe(stripScript);
      expect(argv.filter((word) => word.includes('awk'))).toEqual([stripScript]);
    }
    expect(stripScript).not.toMatch(/demo|web-search|opus|127\.0\.0\.1|\/w\//);
  });

  it('gives the words of a launch to the program intact, also when a folder name holds a quote, a space, a dollar, a backtick and a new line', async () => {
    const project = '/w/it\'s a "q" $HOME `id`\nnew line';
    const argv = must(launchArgv({ ...COORDINATOR, agent: 'echo', projects: [project] }));
    const result = await new Promise<Outcome>((resolve) => {
      execFile(
        ENV_PROGRAM,
        ['-i', 'CLAUDE_FAKE_PARENT=1', 'CLAUDECODE=1', `PATH=${SAFE_PATH}`, ...argv],
        { env: {}, encoding: 'utf8', timeout: 10_000 },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : -1, stdout, stderr }),
      );
    });
    expect(result).toEqual({
      code: 0,
      stdout: `--permission-mode auto --effort high --name demo --add-dir /w/demo-factory/.factory --add-dir ${project}\n`,
      stderr: '',
    });
  });
});
