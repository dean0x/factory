import { describe, expect, it } from 'vitest';
import { exitCodeOf, safetyRefusal, usageError, type CliError, type CliResult } from '../../src/cli/errors.js';
import { renderError } from '../../src/cli/output.js';
import { parseProjectUrl } from '../../src/commands/init-clone.js';
import { MAX_CLONE_URL_CHARS } from '../../src/core/clone-url.js';
import { env } from '../../src/names.js';
import { claudeFileText } from '../helpers/blocks.js';
import { createFakeDeps, registerRoot, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { runDoctor, runInit, runNode, runStart, runUpgrade } from '../helpers/package-registry.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const HOME = '/w/node';
const LOCAL = `${HOME}/factory.local.yaml`;
const CLAUDE = `${HOME}/coordinator/CLAUDE.md`;
const INDEX = '/state/factory/homes.json';
const MARKER = `${HOME}/.factory/node.json`;

/** A remedy line names a command when it quotes one, or when it sends the user to the command that just ran. */
const NAMES_A_COMMAND = /"(?:factory|git|chmod) [^"]+"|\bthe (?:same )?command\b/;

/** The stop (exit 4) or the error that a result holds. A result that succeeded is a failure of the test. */
const errorOf = (result: CliResult<unknown>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the command succeeded');
  return result.error;
};

/**
 * The checks of one refusal (AC-37): the exit code, one reason line and one remedy line. A stop names a command in its
 * remedy line. The text that the command prints holds exactly these two lines.
 */
const expectRemedy = (error: CliError, exitCode: number): void => {
  expect(exitCodeOf[error.kind], error.message).toBe(exitCode);
  const remedy = error.hint;
  expect(remedy, `no remedy line for: ${error.message}`).toBeDefined();
  expect(remedy).not.toBe('');
  expect(remedy).not.toContain('\n');
  expect(error.message).not.toContain('\n');
  if (exitCode === 4) expect(remedy, error.message).toMatch(NAMES_A_COMMAND);
  expect(renderError(error)).toBe(`error: ${error.message}\n${remedy}\n`);
};

/**
 * A node that `init` made, on a fake file system with a fake git and a fake tmux. The commands run on it with the
 * handlers of `runWith`, so a test can change what git tracks.
 */
const makeNode = async (): Promise<FakeDeps> => {
  const { handler } = gitHandler();
  const deps = createFakeDeps({ cwd: '/w', env: { PATH: '/bin', XDG_STATE_HOME: '/state', HOME: '/users/me' }, run: handler });
  const init = await runInit(
    { ...deps, run: async (command, args, options) => handler({ command, args, cwd: options?.cwd }) },
    {
      home: HOME,
      name: 'demo',
      ownerName: 'Test Owner',
      ownerGithub: undefined,
      projects: [],
      yes: false,
      recipe: undefined,
      layer: undefined,
      approval: [],
    },
  );
  expect(init.ok).toBe(true);
  // The fake git makes no folder, so the repos that `init` made are seeded here.
  deps.seedDir(`${HOME}/.git`);
  deps.seed('/bin/tmux', '');
  deps.seed('/bin/claude', '');
  return deps;
};

/** The deps of a node with git and tmux fakes. The git fake tracks the given paths in the factory folder. */
const runWith = (deps: FakeDeps, git: GitFixture = {}): FakeDeps => {
  const { handler: gitRun } = gitHandler({ repos: { [HOME]: {} }, ...git });
  const { handler: tmuxRun } = tmuxHandler();
  const run: RunHandler = (call) => (call.command === 'git' ? gitRun(call) : tmuxRun(call));
  return { ...deps, run: async (command, args, options) => run({ command, args, cwd: options?.cwd }) };
};

/** The commands that look up the factory folder and read its local file. Each one runs on the node as a dry run. */
const COMMANDS: readonly (readonly [string, (deps: FakeDeps) => Promise<CliResult<unknown>>])[] = [
  ['start', (deps) => runStart(deps, { home: HOME, dryRun: true })],
  ['doctor', (deps) => runDoctor(deps, { home: HOME })],
  ['node', (deps) => runNode(deps, { home: HOME, words: ['children'] })],
  ['upgrade', (deps) => runUpgrade(deps, { home: HOME, dryRun: true, overwrite: [], yes: true })],
];

/** The faults of the registration check. They stop every command above. */
const REGISTRATION_FAULTS: readonly (readonly [string, (deps: FakeDeps) => void])[] = [
  ['a factory list with no entry for the folder', (deps) => void deps.files.delete(INDEX)],
  ['an entry of the factory list with another node id', (deps) => registerRoot(deps, HOME, 'other')],
  ['no factory marker', (deps) => void deps.files.delete(MARKER)],
];

/** The faults of the local file. They stop every command above except `doctor`, which only warns. */
const LOCAL_FILE_FAULTS: readonly (readonly [string, (deps: FakeDeps) => void])[] = [
  ['a local file that the group can write', (deps) => void deps.modes.set(LOCAL, 0o660)],
  ['a local file that another account owns', (deps) => void deps.owners.set(LOCAL, 0)],
];

describe('the refusal helper', () => {
  it('makes a stop of exit 4 with a reason and a remedy line', () => {
    const refusal = safetyRefusal('a reason', 'Run "factory doctor".');
    expect(refusal.error).toEqual({ kind: 'safety', message: 'a reason', hint: 'Run "factory doctor".' });
    expect(exitCodeOf.safety).toBe(4);
  });

  it('does not compile without a remedy line', () => {
    // @ts-expect-error A stop needs a remedy line.
    const refusal = safetyRefusal('a reason');
    expect(refusal.error.kind).toBe('safety');
  });

  it('keeps the remedy line of an error of exit 1 or exit 2 optional', () => {
    expect(usageError('a reason').error).toEqual({ kind: 'usage', message: 'a reason' });
    expect(usageError('a reason', 'Run it again.').error).toMatchObject({ hint: 'Run it again.' });
  });

  it('prints the reason and the remedy line, one line each, and finds a command in a remedy line', () => {
    expect(renderError({ kind: 'safety', message: 'a reason', hint: 'Run "factory doctor".' })).toBe(
      'error: a reason\nRun "factory doctor".\n',
    );
    expect(NAMES_A_COMMAND.test('Run "factory init" in the factory folder /w.')).toBe(true);
    expect(NAMES_A_COMMAND.test('Remove it from git with "git rm --cached x", then run again.')).toBe(true);
    expect(NAMES_A_COMMAND.test('Rename the repo. Then run the same command again.')).toBe(true);
    expect(NAMES_A_COMMAND.test('Fix the problem.')).toBe(false);
  });
});

describe.each(COMMANDS)('stops of %s (exit 4)', (name, run) => {
  const faults = name === 'doctor' ? REGISTRATION_FAULTS : [...REGISTRATION_FAULTS, ...LOCAL_FILE_FAULTS];

  it.each(faults)('prints one remedy line that names a command for %s', async (_fault, change) => {
    const deps = await makeNode();
    change(deps);
    expectRemedy(errorOf(await run(runWith(deps))), 4);
  });
});

describe('doctor and a local file with a wrong mode', () => {
  it('warns and names the chmod command, and does not stop', async () => {
    const deps = await makeNode();
    deps.modes.set(LOCAL, 0o640);
    const result = await runDoctor(runWith(deps), { home: HOME });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).toContain('chmod 600 factory.local.yaml');
  });
});

describe('stops of start (exit 4)', () => {
  const start = (deps: FakeDeps, git: GitFixture = {}) => runStart(runWith(deps, git), { home: HOME, dryRun: true });
  const rendered = claudeFileText(sampleConfig());

  it('prints one remedy line that names a command for an edited safety block', async () => {
    const deps = await makeNode();
    deps.seed(CLAUDE, (deps.files.get(CLAUDE) ?? '').replace('Do not write keys', 'Write keys'));
    expect(deps.files.get(CLAUDE)).not.toBe(rendered);
    expectRemedy(errorOf(await start(deps)), 4);
  });

  it('prints one remedy line that names a command for a safety block that is not in the file', async () => {
    const deps = await makeNode();
    deps.seed(CLAUDE, 'Notes of mine.\n');
    expectRemedy(errorOf(await start(deps)), 4);
  });

  it('prints one remedy line that names a command for markers that do not parse', async () => {
    const deps = await makeNode();
    deps.seed(CLAUDE, '<!-- factory:begin safety v2 sha256=zz -->\n');
    expectRemedy(errorOf(await start(deps)), 4);
  });

  it('prints one remedy line that names a command for a local file that git tracks', async () => {
    const deps = await makeNode();
    expectRemedy(errorOf(await start(deps, { tracked: { [HOME]: ['factory.local.yaml'] } })), 4);
  });

  it('prints one remedy line that names a command for a state folder file that git tracks', async () => {
    const deps = await makeNode();
    expectRemedy(errorOf(await start(deps, { tracked: { [HOME]: ['.factory/node.json'] } })), 4);
  });

  it('prints one remedy line that names a command for a tracked path under the coordinator folder', async () => {
    const deps = await makeNode();
    expectRemedy(errorOf(await start(deps, { tracked: { [HOME]: ['coordinator/CLAUDE.md'] } })), 4);
  });
});

describe('stops of upgrade (exit 4)', () => {
  it('prints one remedy line that names a command for a replaced safety block inside a factory session', async () => {
    const deps = await makeNode();
    const inSession = { ...runWith(deps), env: { ...deps.env, [env.session]: 'demo' } };
    const result = await runUpgrade(inSession, { home: HOME, dryRun: false, overwrite: ['safety'], yes: true });
    expectRemedy(errorOf(result), 4);
  });
});

describe('stops of init (exit 4)', () => {
  const options = (overrides: Partial<Parameters<typeof runInit>[1]>): Parameters<typeof runInit>[1] => ({
    home: '/w/fresh',
    name: undefined,
    ownerName: 'Test Owner',
    ownerGithub: undefined,
    projects: [],
    yes: true,
    recipe: undefined,
    layer: undefined,
    approval: [],
    ...overrides,
  });
  const initDeps = (environment: Record<string, string | undefined> = {}): FakeDeps => {
    const { handler } = gitHandler({ gh: 'some-login' });
    return createFakeDeps({
      cwd: '/w',
      env: { XDG_STATE_HOME: '/state', HOME: '/users/me', ...environment },
      run: handler,
    });
  };

  it.each(['coordinator', 'work-copies'])(
    'prints one remedy line that names a command for a project folder name that the root keeps (%s)',
    async (name) => {
      const result = await runInit(initDeps(), options({ projects: [`https://example.com/acme/${name}.git`] }));
      expectRemedy(errorOf(result), 4);
    },
  );

  it('prints one remedy line that names a command for a delegated approval inside a factory session', async () => {
    const deps = initDeps({ [env.session]: 'demo' });
    const result = await runInit(deps, options({ yes: false, approval: ['merge=delegated'] }));
    expectRemedy(errorOf(result), 4);
  });

  it('prints one remedy line that names a command for a delegated approval with no terminal window', async () => {
    const result = await runInit(initDeps(), options({ yes: false, approval: ['merge=delegated'] }));
    expectRemedy(errorOf(result), 4);
  });

  it('prints one remedy line for a repo name in a URL that is not a plain name (exit 2)', async () => {
    const result = await runInit(initDeps(), options({ projects: ['https://example.com/acme/.hidden.git'] }));
    expectRemedy(errorOf(result), 2);
  });

  it('prints one remedy line that names a command for a delegated approval with --yes (exit 2)', async () => {
    const result = await runInit(initDeps(), options({ yes: true, approval: ['merge=delegated'] }));
    expectRemedy(errorOf(result), 2);
  });
});

describe('the errors of the URL rules (exit 2)', () => {
  it.each([
    ['too long', `https://example.com/${'a'.repeat(MAX_CLONE_URL_CHARS)}`],
    ['a hyphen at the start', '-x'],
    ['a user name and a password', 'https://user:secret@example.com/acme/web.git'],
    ['a token in the user name', 'https://ghp_0123456789abcdef@example.com/acme/web.git'],
    ['a scheme that is not allowed', 'ftp://example.com/acme/web.git'],
    ['no path', 'https://example.com'],
  ])('prints one remedy line for a URL that is %s, and does not repeat the value', (_name, url) => {
    const error = errorOf(parseProjectUrl(url));
    expectRemedy(error, 2);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('secret');
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('ghp_');
  });
});
