import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitCodeOf, safetyRefusal, usageError, type CliError, type CliResult } from '../../src/cli/errors.js';
import { renderError } from '../../src/cli/output.js';
import { parseProjectUrl } from '../../src/commands/init-clone.js';
import { MAX_CLONE_URL_CHARS } from '../../src/core/clone-url.js';
import { commands, env, program } from '../../src/names.js';
import { claudeFileText } from '../helpers/blocks.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeDeps, type RunHandler } from '../helpers/fake-deps.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { runDoctor, runInit, runNode, runStart, runUpgrade } from '../helpers/package-registry.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { allSourceFiles, callsOf, codeOfExpression, constantsOf, literalsOf, type Constant } from '../helpers/source-scan.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const SRC = join(__dirname, '..', '..', 'src');
const HOME = '/w/node';
const LOCAL = `${HOME}/factory.local.yaml`;
const CLAUDE = `${HOME}/coordinator/CLAUDE.md`;
const INDEX = '/state/factory/homes.json';
const MARKER = `${HOME}/.factory/node.json`;

/** A remedy line names a command by name: it quotes a `factory <command>` form, for example "factory init". */
const NAMES_A_COMMAND = new RegExp(`"${program} (?:${Object.values(commands).join('|')})(?: [^"]*)?"`);

/** A pointer to the command that just ran names no command, so a remedy line does not use one. */
const POINTS_AT_A_COMMAND = /\bthe (?:same )?command\b/i;

/** The stop (exit 4) or the error that a result holds. A result that succeeded is a failure of the test. */
const errorOf = (result: CliResult<unknown>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the command succeeded');
  return result.error;
};

/**
 * The checks of one refusal (AC-37): the exit code, one reason line and one remedy line. Every remedy line names a command
 * by name, and none says "the same command". The text that the command prints holds exactly these two lines.
 */
const expectRemedy = (error: CliError, exitCode: number): void => {
  expect(exitCodeOf[error.kind], error.message).toBe(exitCode);
  const remedy = error.hint;
  expect(remedy, `no remedy line for: ${error.message}`).toBeDefined();
  expect(remedy).not.toBe('');
  expect(remedy).not.toContain('\n');
  expect(error.message).not.toContain('\n');
  expect(remedy, error.message).toMatch(NAMES_A_COMMAND);
  expect(remedy, error.message).not.toMatch(POINTS_AT_A_COMMAND);
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
    expect(NAMES_A_COMMAND.test('Run "factory upgrade --overwrite safety" in a terminal window.')).toBe(true);
    expect(NAMES_A_COMMAND.test('Remove it from git with "git rm --cached x", then run again.')).toBe(false);
    expect(NAMES_A_COMMAND.test('Rename the repo. Then run the same command again.')).toBe(false);
    expect(NAMES_A_COMMAND.test('Fix the problem.')).toBe(false);
  });

  it('finds a pointer to the command that just ran, which a remedy line does not use', () => {
    expect(POINTS_AT_A_COMMAND.test('Rename the repo. Then run the same command again.')).toBe(true);
    expect(POINTS_AT_A_COMMAND.test('Move it away, then run the command again.')).toBe(true);
    expect(POINTS_AT_A_COMMAND.test('Rename the repo. Then run "factory init" again.')).toBe(false);
  });
});

describe('the remedy lines in the source', () => {
  /**
   * The phrases that point at the command that just ran, in a text that a person reads. "The command name" in a role text
   * is no remedy, so only a phrase that tells the person to run a command is a hit.
   */
  const VAGUE_REMEDY = /\bthe same command\b|\bthe command again\b|\b(?:run|rerun|repeat) the command\b/i;

  /** The string literals of src that point at the command that just ran, with the file. */
  const pointersIn = (source: string, path: string): string[] =>
    literalsOf(source)
      .filter((literal) => VAGUE_REMEDY.test(literal))
      .map((literal) => `${relative(SRC, path)}: "${literal}"`);

  it('say "the same command" or "the command again" in no string literal, so each remedy names its command', () => {
    const files = allSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(60);
    expect(files.flatMap((path) => pointersIn(readFileSync(path, 'utf8'), path))).toEqual([]);
  });

  it('finds a pointer in a literal, and leaves a quoted command, a command name and a comment alone', () => {
    const path = join(SRC, 'commands', 'sample.ts');
    expect(pointersIn("const a = 'Move it away, then run the command again.';", path)).toHaveLength(1);
    expect(pointersIn("const a = 'Then run the same command again.';", path)).toHaveLength(1);
    expect(pointersIn("const a = 'Run the command in a terminal window.';", path)).toHaveLength(1);
    expect(pointersIn('const a = `Then run "${x}" again.`;', path)).toEqual([]);
    expect(pointersIn("const a = 'List only the pid and the command name.';", path)).toEqual([]);
    expect(pointersIn("// then run the command again\nconst a = 'plain';", path)).toEqual([]);
  });
});

describe('the remedy line of every stop in the source', () => {
  /** A remedy line names a command when it reaches `commandText(` through its own text, a helper or a constant. */
  const BUILDS_A_COMMAND = /\bcommandText\(/;

  /** A remedy line that the call takes from a variable or a property, and builds elsewhere. */
  const IS_A_REFERENCE = /^[A-Za-z_][\w.]*(?:\.join\([^()]*\))?$/;

  const MAX_RESOLVE_DEPTH = 4;

  /** The text of the constants of a file, joined by name. */
  const textsOf = (source: string, only: (constant: Constant) => boolean): Map<string, string> => {
    const texts = new Map<string, string>();
    for (const constant of constantsOf(source).filter(only)) {
      texts.set(constant.name, `${texts.get(constant.name) ?? ''} ${constant.text}`);
    }
    return texts;
  };

  /** True when the code of the expression reaches `commandText(`: the words in its string literals are not code. */
  const namesCommand = (expression: string, known: ReadonlyMap<string, string>, depth = MAX_RESOLVE_DEPTH): boolean => {
    const code = codeOfExpression(expression);
    if (BUILDS_A_COMMAND.test(code)) return true;
    if (depth === 0) return false;
    const names = code.match(/(?<![\w.$])[A-Za-z_]\w*/g) ?? [];
    return names.some((name) => {
      const value = known.get(name);
      return value !== undefined && namesCommand(value, known, depth - 1);
    });
  };

  interface Sweep {
    /** The number of calls of `safetyRefusal`. */
    readonly calls: number;
    /** The calls whose remedy line names no command, or that do not have two arguments. */
    readonly missing: readonly string[];
    /** The calls whose remedy line comes from a variable or a property that holds no command in the same file. */
    readonly forwarded: readonly string[];
  }

  /** Check the remedy line of every call of `safetyRefusal` in the given sources (path to text). */
  const sweepOf = (sources: ReadonlyMap<string, string>): Sweep => {
    const exported = new Map<string, string>();
    for (const source of sources.values()) {
      for (const [name, text] of textsOf(source, (constant) => constant.exported)) {
        exported.set(name, `${exported.get(name) ?? ''} ${text}`);
      }
    }
    const missing: string[] = [];
    const forwarded: string[] = [];
    let calls = 0;
    for (const [path, source] of sources) {
      const known = new Map([...exported, ...textsOf(source, () => true)]);
      for (const args of callsOf(source, 'safetyRefusal')) {
        calls += 1;
        const remedy = args[1] ?? '';
        const place = `${path}: ${remedy}`;
        if (args.length !== 2) missing.push(`${path}: ${args.length} arguments`);
        else if (namesCommand(remedy, known)) continue;
        else if (IS_A_REFERENCE.test(remedy)) forwarded.push(place);
        else missing.push(place);
      }
    }
    return { calls, missing, forwarded };
  };

  const sweepOfOne = (source: string): Sweep => sweepOf(new Map([['sample.ts', source]]));

  /**
   * The remedy lines that a stop takes from a variable or a property, and that the file of the call does not build. A
   * new stop of this kind must be added here on purpose. The stops of the other kinds all reach `commandText(`.
   */
  const FORWARDED: readonly string[] = [
    'commands/root-content.ts: remedies.join(\' \')',
    'commands/setup-check.ts: check.stop.remedy',
    'commands/setup-check.ts: remedy',
    'core/home.ts: problem.remedy',
    'migrate/inspect.ts: state.hint',
  ];

  it('names a command in the remedy line of each of the stops of src (TP-106)', () => {
    const sources = new Map(allSourceFiles(SRC).map((path) => [relative(SRC, path), readFileSync(path, 'utf8')]));
    const sweep = sweepOf(sources);
    expect(sweep.calls).toBeGreaterThanOrEqual(45);
    expect(sweep.missing).toEqual([]);
  });

  it('takes a remedy line from a variable or a property only in the places that this list names', () => {
    const sources = new Map(allSourceFiles(SRC).map((path) => [relative(SRC, path), readFileSync(path, 'utf8')]));
    expect([...sweepOf(sources).forwarded].sort()).toEqual(FORWARDED);
  });

  it('finds a remedy line with no command, and a call with a message only', () => {
    expect(sweepOfOne("safetyRefusal('a reason', 'Set XDG_STATE_HOME to another absolute folder.');").missing).toHaveLength(1);
    expect(sweepOfOne('safetyRefusal(`a ${f(1, 2)} reason`, `Set ${env.stateHome} to a folder.`);').missing).toHaveLength(1);
    expect(sweepOfOne("safetyRefusal('a reason');").missing).toEqual(['sample.ts: 1 arguments']);
  });

  it('accepts a command, an overwrite command, and the helpers and constants that build one', () => {
    const accepted = [
      'safetyRefusal(`a reason`, `Then run "${commandText(commands.init)}" again.`);',
      'export const overwriteCommand = (block: string): string => `${commandText(commands.upgrade)} ${block}`;\nsafetyRefusal(`a reason`, `Run "${overwriteCommand(name)}" to add it.`);',
      'const terminalRemedy = (): string => `Run "${commandText(commands.init)}" in a terminal window.`;\nsafetyRefusal(`a`, terminalRemedy());',
      'export const REMOVE_REMEDY = `Run "${commandText(commands.doctor)}".`;\nsafetyRefusal(`a`, REMOVE_REMEDY);',
      'export const TRACKED_CAP_REMEDY = `then run "${commandText(commands.init)}" again.`;\nsafetyRefusal(`a`, TRACKED_CAP_REMEDY);',
      'const again = (command: CommandName): string => `then run "${commandText(command)}" again.`;\nsafetyRefusal(`a`, `Move it. ${again(command)}`);',
      'const remedy = `Run "${commandText(commands.init)}" first.`;\nsafetyRefusal(`a`, remedy);',
      'const check = (remedy: string = LINK_REMEDY) => safetyRefusal(`a`, remedy);\nconst LINK_REMEDY = `Run "${commandText(commands.doctor)}".`;',
    ];
    for (const source of accepted) expect(sweepOfOne(source), source).toMatchObject({ missing: [], forwarded: [] });
  });

  it('finds a remedy line that a constant holds with no command, and one that comes from another place', () => {
    const noCommand = sweepOfOne("const REMEDY = 'Fix it.';\nsafetyRefusal(`a`, REMEDY);");
    expect(noCommand.forwarded).toEqual(['sample.ts: REMEDY']);
    expect(sweepOfOne('safetyRefusal(`a`, problem.remedy);').forwarded).toEqual(['sample.ts: problem.remedy']);
  });

  it('does not count a call that only a comment holds', () => {
    expect(sweepOfOne("// safetyRefusal('a', 'b');\n/* safetyRefusal('a', 'b') */\nconst a = 1;").calls).toBe(0);
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

/** The settings folder of Claude Code in the test home of `makeNode` (the variable HOME is `/users/me`). */
const USER_CLAUDE = '/users/me/.claude';

const IN_USER_CLAUDE: readonly (readonly [string, (deps: FakeDeps, home: string) => Promise<CliResult<unknown>>])[] = [
  ['start', (deps, home) => runStart(deps, { home, dryRun: true })],
  ['doctor', (deps, home) => runDoctor(deps, { home })],
  ['node', (deps, home) => runNode(deps, { home, words: ['children'] })],
  ['upgrade', (deps, home) => runUpgrade(deps, { home, dryRun: true, overwrite: [], yes: true })],
];

describe.each(IN_USER_CLAUDE)('%s and a factory folder in the settings folder of Claude Code', (_name, run) => {
  it.each([USER_CLAUDE, `${USER_CLAUDE}/factory`])(
    'stops with exit 4 and one remedy line for %s, and makes no file call at or under that folder',
    async (home) => {
      const deps = await makeNode();
      registerRoot(deps, home, 'demo');
      deps.seed(`${home}/factory.yaml`, 'schema: 2\n');
      const seen: string[] = [];
      const error = errorOf(await run(withFsWatch(runWith(deps), (_method, path) => seen.push(path)), home));
      expectRemedy(error, 4);
      expect(error.message).toContain(USER_CLAUDE);
      expect(seen.filter((path) => path === USER_CLAUDE || path.startsWith(`${USER_CLAUDE}/`))).toEqual([]);
    },
  );
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

  it('prints one remedy line that names a command for a factory folder in the settings folder of Claude Code', async () => {
    const result = await runInit(initDeps(), options({ home: `${USER_CLAUDE}/factory` }));
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
    const error = errorOf(parseProjectUrl(url, commands.init));
    expectRemedy(error, 2);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('secret');
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain('ghp_');
  });

  it('names the command that ran in the remedy line', () => {
    const url = 'https://user:secret@example.com/acme/web.git';
    expect(errorOf(parseProjectUrl(url, commands.init)).hint).toContain(`Then run "${program} ${commands.init}" again.`);
    expect(errorOf(parseProjectUrl(url, commands.upgrade)).hint).toContain(`Then run "${program} ${commands.upgrade}" again.`);
  });
});
