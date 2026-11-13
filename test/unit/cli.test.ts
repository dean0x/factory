import { describe, expect, it } from 'vitest';
import {
  createStyle,
  detectStyle,
  renderError,
  renderInternalError,
  renderJson,
  renderText,
  renderWarnings,
} from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { commandTable, globalOptions, parseFlags } from '../../src/cli/table.js';
import {
  commands,
  flags,
  itemCommands,
  queueCommands,
  relayedMarker,
  requestCommands,
  selfCommands,
  trackCommands,
  workerCommands,
} from '../../src/names.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps, registerRoot, type FakeDeps, type FakeOptions } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { procStatPath, procStatText } from '../helpers/ps-fake.js';
import { HOME as BOARD_HOME } from '../helpers/guard-fixture.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { HOME, NODE } from '../helpers/slot-fixture.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const run = async (argv: string[]) => {
  const sink = captureSink();
  const code = await runCli(argv, createFakeDeps(), sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('runCli', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory <command>');
    expect(result.out).toContain('version');
  });

  it.each([['help'], ['--help'], ['-h']])('prints help for %s', async (word) => {
    const result = await run([word]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Commands:');
  });

  it('prints the help of one command for "help <command>"', async () => {
    const result = await run(['help', 'version']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory version');
  });

  it('prints the version for "version" and "--version"', async () => {
    for (const argv of [['version'], ['--version']]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.out.trim()).toBe(FACTORY_VERSION);
    }
  });

  it('prints a JSON document with a schema field for --json', async () => {
    const result = await run(['version', '--json']);
    expect(JSON.parse(result.out)).toEqual({ schema: 'factory.version/v1', version: FACTORY_VERSION });
  });

  it('exits 2 and prints help to stderr for an unknown command', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('unknown command "frobnicate"');
    expect(result.err).toContain('Commands:');
  });

  it('exits 2 for an unknown flag and points to the command help', async () => {
    const result = await run(['version', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--bogus');
    expect(result.err).toContain('factory version --help');
  });

  it('exits 2 for a stray positional argument', async () => {
    const result = await run(['version', 'extra']);
    expect(result.code).toBe(2);
  });

  it('prints the help of a command for --help', async () => {
    const result = await run(['version', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory version');
    expect(result.out).toContain('--json');
  });
});

describe('the refusal on Windows', () => {
  const runOn = async (os: string, argv: readonly string[]) => {
    const sink = captureSink();
    const code = await runCli(argv, createFakeDeps({ os }), sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  const argvOfEachCommand: readonly (readonly string[])[] = [
    [],
    ['--help'],
    ['--version'],
    ['help'],
    ['bogus'],
    // The hook of Claude Code exits 0 on every platform, so the tests of the hook cover it (test/unit/hook.test.ts).
    ...commandTable
      .filter((command) => command.name !== 'hook')
      .flatMap((command) => [[command.name], [command.name, '--help'], [command.name, '--json']]),
  ];

  it.each(argvOfEachCommand.map((argv) => [argv.join(' ') || '(no arguments)', argv] as const))(
    'exits 1 with the remedy line for "%s" on win32, and prints nothing else',
    async (_name, argv) => {
      const result = await runOn('win32', argv);
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      const typed = commandTable.some((command) => command.name === argv[0]) ? argv[0] : 'help';
      expect(result.err).toBe(`error: factory runs on macOS and Linux\nUse WSL, then run "factory ${typed}" there.\n`);
    },
  );

  it.each([['linux'], ['darwin']])('does not refuse on %s', async (os) => {
    const result = await runOn(os, ['--version']);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe(FACTORY_VERSION);
  });
});

describe('parseFlags', () => {
  const options = {
    home: { type: 'string', description: 'x' },
    project: { type: 'string', multiple: true, description: 'x' },
    dry: { type: 'boolean', description: 'x' },
  } as const;

  it('reads strings, repeated strings and booleans', () => {
    const parsed = parseFlags(['--home', '/a', '--project', 'p1', '--project', 'p2', '--dry'], options);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.string('home')).toBe('/a');
    expect(parsed.value.strings('project')).toEqual(['p1', 'p2']);
    expect(parsed.value.bool('dry')).toBe(true);
    expect(parsed.value.string('missing')).toBeUndefined();
    expect(parsed.value.strings('missing')).toEqual([]);
    expect(parsed.value.bool('missing')).toBe(false);
  });

  it('returns a usage error for an unknown flag', () => {
    const parsed = parseFlags(['--nope'], options);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('usage');
  });

  it('returns a usage error for a word that is not a flag, unless the command takes words', () => {
    const refused = parseFlags(['add-child', 'x'], options);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('usage');

    const allowed = parseFlags(['add-child', '--home', '/a', 'x'], options, true);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.positionals()).toEqual(['add-child', 'x']);
    expect(allowed.value.string('home')).toBe('/a');
  });

  it('still refuses a flag that the command does not know, when it takes words', () => {
    expect(parseFlags(['children', '--nope'], options, true).ok).toBe(false);
  });
});

describe('the double dash rule of parseFlags', () => {
  const options = { ...globalOptions, wait: { type: 'boolean', description: 'x' } } as const;
  const withRule = (args: readonly string[]) => parseFlags(args, options, true, 'required');

  it('keeps every word after the double dash as a child word, also a word that looks like a flag (TP-3)', () => {
    const parsed = withRule(['run', '--wait', '--', 'npm', 'test', '--json', '--help', '--wait', '-h', '--', 'x']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.positionals()).toEqual(['run']);
    expect(parsed.value.afterTerminator()).toEqual(['npm', 'test', '--json', '--help', '--wait', '-h', '--', 'x']);
    expect(parsed.value.bool('wait')).toBe(true);
    expect(parsed.value.bool(flags.json)).toBe(false);
    expect(parsed.value.bool(flags.help)).toBe(false);
  });

  it('gives no child word when the double dash is absent or last', () => {
    for (const args of [['run'], ['run', '--']]) {
      const parsed = withRule(args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.afterTerminator()).toEqual([]);
    }
  });

  it.each([
    [['run', 'x', '--', 'npm']],
    [['run', 'x']],
    [['run', 'x', '--help']],
    [['x', 'y', '-h']],
  ])('returns a usage error for a second word before the double dash: %j (TP-1, TP-2)', (args) => {
    const parsed = withRule(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('usage');
  });

  it.each([[['--help']], [['run', '--help']], [['run', '-h']]])(
    'reads the help flag when no double dash and no other word follows: %j (TP-2)',
    (args) => {
      const parsed = withRule(args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.bool(flags.help)).toBe(true);
    },
  );

  it.each([
    [['run', '--help', '--', 'npm', 'test']],
    [['run', '--help', '--']],
    [['--help', '--']],
    [['run', '-h', '--', 'npm']],
  ])('returns a usage error for the help flag with a double dash: %j (TP-2)', (args) => {
    const parsed = withRule(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe('usage');
  });

  it('leaves a command without the rule as it was', () => {
    const parsed = parseFlags(['a', '--', 'b'], options, true);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.positionals()).toEqual(['a', 'b']);
    expect(parsed.value.afterTerminator()).toEqual([]);
  });
});

describe('the lock command in the command line', () => {
  const lockLine = async (argv: string[]) => {
    const deps = createFakeDeps({ env: { HOME: '/h' } });
    deps.seed(procStatPath(4242), procStatText(4242, 'node', 5));
    const sink = captureSink();
    const code = await runCli(argv, deps, sink);
    return { deps, code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  it('lists the command in the help of the program', async () => {
    expect((await run(['help'])).out).toMatch(/\n {2}lock {6}Run one heavy command/);
  });

  it.each([[['lock', '--help']], [['lock', 'run', '--help']], [['help', 'lock']]])(
    'prints the help and exits 0 for %j, and runs nothing (TP-2)',
    async (argv) => {
      const result = await lockLine(argv);
      expect(result.code).toBe(0);
      expect(result.out).toContain('Usage: factory lock run [--priority] -- COMMAND [ARG]...');
      expect(result.out).toContain('--priority');
      expect(result.deps.attached).toEqual([]);
    },
  );

  it.each([
    [['lock', 'run', 'npm', 'test', '--help']],
    [['lock', 'run', '--help', '--', 'npm']],
    [['lock', 'run', '--help', '--']],
  ])('exits 2 with the usage line, prints no help and runs nothing for %j (TP-1, TP-2)', async (argv) => {
    const result = await lockLine(argv);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err.split('\n')[0]).toMatch(/^error: factory lock run: USAGE\. /);
    expect(result.deps.attached).toEqual([]);
  });

  it('gives every word after the double dash to the child, also a word that looks like a flag (TP-3)', async () => {
    const words = ['test', '--json', '--help', '-h', '--priority', '--', 'x'];
    const result = await lockLine(['lock', 'run', '--', 'npm', ...words]);
    expect(result.code).toBe(0);
    expect(result.deps.attached).toHaveLength(1);
    expect(result.deps.attached[0]).toMatchObject({ command: 'npm', args: words });
    expect(result.deps.files.has('/h/.local/state/factory/heavy-test.priority')).toBe(false);
  });
});

describe('the node command in the command line', () => {
  it('shows one usage line for each subcommand', async () => {
    const result = await run(['node', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory node children [--home DIR]');
    expect(result.out).toContain('       factory node tree [--home DIR]');
    expect(result.out).toContain('       factory node add-child PATH [--home DIR]');
    expect(result.out).toContain('       factory node remove-child ID [--home DIR]');
    expect(result.out).toContain('       factory node send ID --file FILE [--home DIR]');
  });

  it('describes the --file flag of send in the help', async () => {
    const result = await run(['node', '--help']);
    expect(result.out).toMatch(/--file FILE\s+With send: /);
  });

  it('exits 2 for send with no --file, and for --file with another subcommand', async () => {
    const missing = await run(['node', 'send', 'web']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('send takes one argument');
    const stray = await run(['node', 'children', '--file', 'task.md']);
    expect(stray.code).toBe(2);
    expect(stray.err).toContain('--file belongs to send only');
  });

  it('lists the command and the start command in the help', async () => {
    const result = await run(['help']);
    expect(result.out).toMatch(/\n {2}start {5}Start the session/);
    expect(result.out).toMatch(/\n {2}node {6}Show or change the children[^\n]*the tree below them/);
  });

  it('exits 2 for the command up, which has no alias for start', async () => {
    const result = await run(['up', '--dry-run']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('unknown command "up"');
    expect(result.err).not.toMatch(/^ {2}up /m);
  });

  it('shows the usage of start with the home and dry-run flags', async () => {
    const result = await run(['start', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory start [--home DIR] [--dry-run]');
  });

  it('exits 2 for a node command without a subcommand', async () => {
    const result = await run(['node']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('needs a subcommand');
  });
});

describe('the folder of a factory in the help text (TP-138)', () => {
  const NAMES_WITH_FOLDER = commandTable.map((command) => [command.name]);

  it.each(NAMES_WITH_FOLDER)('says factory folder, and not node folder, in the help of %s', async (name) => {
    const result = await run([name, '--help']);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/node folder/i);
    expect(result.out).not.toMatch(/\bhome\b(?! DIR)/i);
  });

  it('names the folder of the --home flag with the plain word', async () => {
    for (const name of ['init', 'start', 'doctor', 'upgrade', 'node']) {
      const result = await run([name, '--help']);
      expect(result.out, name).toMatch(/--home DIR +The factory folder\./);
    }
  });

  it('names the proposed folder of --yes with the plain word', async () => {
    const result = await run(['init', '--help']);
    expect(result.out).toContain('Use the proposed factory folder.');
  });
});

describe('the approval flag of init in the command line (TP-37, TP-38, TP-81)', () => {
  const init = commandTable.find((command) => command.name === 'init');
  const STATE_ENV = { XDG_STATE_HOME: '/state', HOME: '/users/me' };

  /** The command runs in a fake folder with a place for the factory list and a fake git. */
  const runInit = async (argv: readonly string[], extra: FakeOptions = {}) => {
    const { handler } = gitHandler();
    const deps = createFakeDeps({ cwd: '/w', run: handler, env: STATE_ENV, ...extra });
    const sink = captureSink();
    const code = await runCli(['init', '--home', '/w/node', '--owner-name', 'Test Owner', ...argv], deps, sink);
    return { code, deps, out: sink.out.join(''), err: sink.errors.join('') };
  };

  it('is a flag of init that can repeat, and no other command takes it', () => {
    expect(init?.options['approval']).toMatchObject({ type: 'string', multiple: true, placeholder: 'POINT=MODE' });
    for (const command of commandTable.filter((other) => other !== init)) {
      expect(Object.keys(command.options)).not.toContain('approval');
    }
  });

  it('reads the repeated flag as a list of POINT=MODE texts', () => {
    const parsed = parseFlags(['--approval', 'merge=delegated', '--approval', 'release=owner'], init?.options ?? {});
    expect(parsed.ok && parsed.value.strings('approval')).toEqual(['merge=delegated', 'release=owner']);
  });

  it('shows the flag in the usage line and in the help of init', async () => {
    const result = await run(['init', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('[--approval POINT=owner|delegated]...');
    expect(result.out).toContain('--approval POINT=MODE');
    expect(result.out).toContain('owner or delegated');
  });

  it('exits 0 and writes the mode owner for each point when no approval flag is given', async () => {
    const result = await runInit(['--yes']);
    expect(result.code).toBe(0);
    expect(result.deps.files.get('/w/node/factory.local.yaml')).toMatch(/approval:\n {2}merge: owner\n {2}release: owner\n/);
  });

  it('exits 2 for --yes with a flag that asks for delegated, and writes no file', async () => {
    const result = await runInit(['--yes', '--approval', 'merge=delegated']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('factory init --approval <point>=delegated');
    expect(result.deps.files.size).toBe(0);
  });

  it('exits 4 for a delegated choice with no terminal window, and writes no file', async () => {
    const result = await runInit(['--approval', 'merge=delegated']);
    expect(result.code).toBe(4);
    expect(result.err).toContain('terminal window outside a factory session');
    expect(result.deps.files.size).toBe(0);
  });

  it('exits 2 for a point that the recipe does not list, and names the points', async () => {
    const result = await runInit(['--approval', 'deploy=owner']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('merge, release');
    expect(result.deps.files.size).toBe(0);
  });
});

describe('output style', () => {
  const output = {
    lines: [
      { level: 'heading', text: 'Title' },
      { level: 'ok', text: 'fine' },
      { level: 'warn', text: 'careful' },
      { level: 'fail', text: 'broken' },
    ],
    json: { schema: 'x/v1' },
    warnings: [],
    failed: false,
  } as const;

  it('uses ASCII symbols and no color when stdout is not a terminal', () => {
    const style = detectStyle({ LANG: 'en_US.UTF-8' }, false, false);
    expect(renderText(output, style, false)).toBe('Title\n[ok] fine\n[warn] careful\n[FAIL] broken\n');
  });

  it('uses Unicode symbols and color on a UTF-8 terminal', () => {
    const style = detectStyle({ LANG: 'en_US.UTF-8', TERM: 'xterm' }, true, false);
    const text = renderText(output, style, false);
    expect(text).toContain('✓ fine');
    expect(text).toContain('\u001b[32m');
  });

  it('turns color off for --no-color, NO_COLOR and a dumb terminal', () => {
    for (const style of [
      detectStyle({ LANG: 'C.UTF-8' }, true, true),
      detectStyle({ LANG: 'C.UTF-8', NO_COLOR: '1' }, true, false),
      detectStyle({ LANG: 'C.UTF-8', TERM: 'dumb' }, true, false),
    ]) {
      expect(renderText(output, style, false)).not.toContain('\u001b[');
    }
  });

  it('falls back to ASCII symbols on a terminal without UTF-8', () => {
    const style = detectStyle({ LANG: 'C', TERM: 'xterm' }, true, true);
    expect(renderText(output, style, false)).toContain('[ok] fine');
  });

  it('prints only warnings and failures with --quiet', () => {
    const style = createStyle({ color: false, unicode: false });
    expect(renderText(output, style, true)).toBe('[warn] careful\n[FAIL] broken\n');
  });
});

describe('control characters in text output', () => {
  const plain = createStyle({ color: false, unicode: false });
  const withLine = (text: string) => ({
    lines: [{ level: 'ok', text }],
    json: { schema: 'x/v1' },
    warnings: [],
    failed: false,
  }) as const;

  it('replaces the escape character of a terminal sequence in a line', () => {
    const text = renderText(withLine('path \u001b[2J\u001b]0;title\u0007 end'), plain, false);
    expect(text).toBe('[ok] path ?[2J?]0;title? end\n');
  });

  it('replaces C0, DEL and C1 control characters but keeps tab and the line end', () => {
    const text = renderText(withLine('a\u0000b\rc\u007fd\u009be\tf'), plain, false);
    expect(text).toBe('[ok] a?b?c?d?e\tf\n');
  });

  it('keeps the color codes that the style adds', () => {
    const color = createStyle({ color: true, unicode: false });
    expect(renderText(withLine('fine'), color, false)).toBe('\u001b[32m[ok] fine\u001b[0m\n');
  });

  it('replaces control characters in a warning', () => {
    expect(renderWarnings(['bad \u001b[31m value\u0085'])).toBe('warning: bad ?[31m value?\n');
  });

  it('M5-1b TP-105 removes hidden characters from the string values of the JSON document', () => {
    const doc = { schema: 'x/v1', path: 'a\u001bb', note: 'c‮d' };
    expect(JSON.parse(renderJson(doc))).toEqual({ schema: 'x/v1', path: 'ab', note: 'cd' });
    expect(renderJson(doc)).not.toContain('\u001b');
    expect(renderJson(doc)).not.toContain('‮');
  });
});

describe('control characters in error text', () => {
  it('replaces them in the message and in the hint', () => {
    const text = renderError({ kind: 'failure', message: 'bad \u001b[2J folder', hint: 'try \u0007 again\u009b' });
    expect(text).toBe('error: bad ?[2J folder\ntry ? again?\n');
  });

  it('prints an error with no hint as one line', () => {
    expect(renderError({ kind: 'usage', message: 'bad' })).toBe('error: bad\n');
  });

  it('replaces them in the message of an internal error', () => {
    const text = renderInternalError(new Error('failed \u001b[2J in \u0007 file\u009b'));
    expect(text).toBe('error: internal error: failed ?[2J in ? file?\n');
  });

  it('prints an internal error that is not an Error as unknown', () => {
    expect(renderInternalError('\u001b[2J')).toBe('error: internal error: unknown\n');
    expect(renderInternalError(undefined)).toBe('error: internal error: unknown\n');
  });

  it('replaces them in the error of a command', async () => {
    const result = await run(['node', 'x\u001b[2Jy']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown subcommand "x?[2Jy"');
    expect(result.err).not.toContain('\u001b');
  });

  it('replaces them in the name of an unknown command', async () => {
    const result = await run(['\u001b[2Jx']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown command "?[2Jx"');
    expect(result.err).not.toContain('\u001b');
  });
});

describe('the reset, watch and self commands in the command line', () => {
  /** A node in the factory list, with a tmux session of the node unless `session` is false, and no worker. */
  const made = (session = true) => {
    const { handler, log } = tmuxHandler({ sessions: session ? { [NODE]: HOME } : {}, panes: [] });
    const deps = createFakeDeps({ cwd: '/w', os: 'darwin', env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, run: handler });
    seedConfig(deps, HOME, sampleConfig());
    registerRoot(deps, HOME, NODE);
    return { deps, log };
  };

  const runOn = async (deps: FakeDeps, argv: readonly string[]) => {
    const sink = captureSink();
    const code = await runCli([...argv], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  it('has one entry in the command table for each command name, except help', () => {
    const names = commandTable.map((command) => command.name).sort();
    expect(names).toEqual(Object.values(commands).filter((name) => name !== commands.help).sort());
  });

  it('TP-14: shows report with its flag --since in the help, and exits 2 with a remedy that names the command for a use of the flag', async () => {
    const { deps } = made();
    const list = await runOn(deps, ['--help']);
    expect(list.out).toMatch(/^ {2}report {4}\S/m);
    const help = await runOn(deps, ['report', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('factory report [--home DIR] [--since CURSOR]');
    expect(help.out).toMatch(/--since CURSOR\s+\S/);
    const since = await runOn(deps, ['report', '--since', 'cursor-1', '--home', HOME]);
    expect(since.code).toBe(2);
    expect(since.err).toContain('"factory report"');
    expect(since.out).toBe('');
  });

  it('shows one usage line for each subcommand of worker and of self', () => {
    const usageOf = (name: string): string => commandTable.find((command) => command.name === name)?.usage ?? '';
    for (const subcommand of Object.values(workerCommands)) {
      expect(usageOf(commands.worker), subcommand).toContain(`factory ${commands.worker} ${subcommand} `);
    }
    for (const subcommand of Object.values(selfCommands)) {
      expect(usageOf(commands.self), subcommand).toContain(`factory ${commands.self} ${subcommand} `);
    }
  });

  it('TP-22: shows the usage of worker reset and worker watch, and the two flags of reset, in the help of worker', async () => {
    const result = await run(['worker', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('factory worker reset ID --clear|--compact [--home DIR]');
    expect(result.out).toContain('factory worker watch [ID]... [--ready ID]... [--since TIME] [--home DIR]');
    expect(result.out).toMatch(/--since TIME\s+With watch: also report a finish of a worker that came after TIME/);
    expect(result.out).toMatch(/--clear\s+With reset: clear the session of the worker/);
    expect(result.out).toMatch(/--compact\s+With reset: compact the session of the worker/);
  });

  it('TP-32: shows the assignment flag in the usage of worker new and in the flag list of worker', async () => {
    const result = await run(['worker', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('factory worker new ID --project PROJECT [--assignment FILE] [--home DIR] [--yes]');
    expect(result.out).toMatch(/--assignment FILE\s+With new: copy the text of FILE/);
    expect(result.out).toContain('.factory/orders/');
  });

  it('TP-27: lists self in the help, and shows the usage of self reset', async () => {
    const listed = await run(['help']);
    expect(listed.out).toMatch(/\n {2}self {6}\S/);
    const result = await run(['self', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory self reset [--home DIR]');
  });

  it('says in the help of upgrade that the yes flag agrees to the new hook events of the work copies and of the coordinator', async () => {
    const result = await run(['upgrade', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/--yes\s+Agree with no question to two changes: the registration of a factory folder/);
    expect(result.out).toContain('the new hook events in the Claude Code settings of the work copies and of the coordinator');
  });

  it.each([
    ['worker reset with no flag', ['worker', 'reset', 'alpha'], 'needs one of --clear and --compact'],
    ['worker reset with both flags', ['worker', 'reset', 'alpha', '--clear', '--compact'], 'and not both'],
    ['worker reset with no id', ['worker', 'reset', '--clear'], 'takes one argument'],
    ['worker reset with two ids', ['worker', 'reset', 'alpha', 'beta', '--clear'], 'takes one argument'],
    ['self with no subcommand', ['self'], 'needs a subcommand: reset'],
    ['self with an unknown subcommand', ['self', 'nope'], 'unknown subcommand "nope"'],
    ['self reset with a word', ['self', 'reset', 'now'], 'takes no argument'],
  ])('TP-22, TP-27: exits 2 for %s, and runs no program', async (_name, argv, message) => {
    const { deps } = made();
    const result = await runOn(deps, [...argv, '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['worker stop with --clear', ['worker', 'stop', 'alpha', '--clear'], '--clear belongs to reset only'],
    ['worker stop with --compact', ['worker', 'stop', 'alpha', '--compact'], '--compact belongs to reset only'],
    ['worker new with --clear', ['worker', 'new', 'alpha', '--project', 'web', '--clear'], '--clear belongs to reset only'],
    ['worker resume with --compact', ['worker', 'resume', 'alpha', '--compact'], '--compact belongs to reset only'],
    ['worker summon with --clear', ['worker', 'summon', 'alpha', '--clear'], '--clear belongs to reset only'],
    ['worker watch with --compact', ['worker', 'watch', '--compact'], '--compact belongs to reset only'],
    ['worker list with --clear', ['worker', 'list', '--clear'], '--clear belongs to reset only'],
    ['worker stop with both flags', ['worker', 'stop', 'alpha', '--clear', '--compact'], '--clear and --compact belong to reset only'],
  ])('exits 2 for %s, names reset, and runs no program', async (_name, argv, message) => {
    const { deps } = made();
    const result = await runOn(deps, [...argv, '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['worker stop', ['worker', 'stop', 'alpha']],
    ['worker resume', ['worker', 'resume', 'alpha']],
    ['worker summon', ['worker', 'summon', 'alpha']],
    ['worker reset', ['worker', 'reset', 'alpha', '--clear']],
    ['worker watch', ['worker', 'watch']],
    ['worker list', ['worker', 'list']],
  ])('exits 2 for %s with --assignment, names new, and runs no program', async (_name, argv) => {
    const { deps } = made();
    const result = await runOn(deps, [...argv, '--assignment', 'task.md', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--assignment belongs to new only');
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['worker new', ['worker', 'new', 'alpha', '--project', 'web']],
    ['worker stop', ['worker', 'stop', 'alpha']],
    ['worker resume', ['worker', 'resume', 'alpha']],
    ['worker summon', ['worker', 'summon', 'alpha']],
    ['worker reset', ['worker', 'reset', 'alpha', '--clear']],
    ['worker list', ['worker', 'list']],
  ])('exits 2 for %s with --ready, names watch, and runs no program', async (_name, argv) => {
    const { deps } = made();
    const result = await runOn(deps, [...argv, '--ready', 'alpha', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--ready belongs to watch only');
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['worker new', ['worker', 'new', 'alpha', '--project', 'web']],
    ['worker stop', ['worker', 'stop', 'alpha']],
    ['worker list', ['worker', 'list']],
  ])('TP-26: exits 2 for %s with --since, names watch, and runs no program', async (_name, argv) => {
    const { deps } = made();
    const result = await runOn(deps, [...argv, '--since', '2030-01-02T03:04:05.678Z', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--since belongs to watch only');
    expect(deps.calls).toEqual([]);
  });

  it('TP-26: names both flags when --ready and --since go to a command that is not watch', async () => {
    const result = await runOn(made().deps, ['worker', 'list', '--ready', 'alpha', '--since', '2030-01-02T03:04:05.678Z', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--ready and --since belong to watch only');
  });

  it.each([['text that is no time', 'yesterday'], ['a time with an offset', '2030-01-02T03:04:05+02:00'], ['a date with no time', '2030-01-02'], ['empty text', '']])(
    'TP-26: exits 2 for worker watch --since with %s, before any tmux call and with no run marker',
    async (_name, since) => {
      const { deps, log } = made();
      const result = await runOn(deps, ['worker', 'watch', '--since', since, '--home', HOME]);
      expect(result.code).toBe(2);
      expect(result.err).toContain('--since needs an ISO time in UTC that ends with Z');
      expect(log.calls).toEqual([]);
      expect([...deps.files.keys()].filter((path) => path.endsWith('worker-watch-run'))).toEqual([]);
    },
  );

  it('TP-26: takes a time in UTC for worker watch --since, and the watch runs', async () => {
    const result = await runOn(made().deps, ['worker', 'watch', '--since', '2030-01-02T03:04:05.678Z', '--home', HOME]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('NO WORKER');
  });

  it('keeps the message for an unknown subcommand that gets --assignment', async () => {
    const result = await runOn(made().deps, ['worker', 'nope', '--assignment', 'task.md', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown subcommand "nope"');
  });

  it.each([
    ['worker reset with --clear', ['worker', 'reset', 'alpha', '--clear']],
    ['worker reset with --compact', ['worker', 'reset', 'alpha', '--compact']],
    ['self reset', ['self', 'reset']],
  ])('TP-22, TP-27: reads the config, then exits 2 for %s outside the pane of the coordinator, with no tmux call', async (_name, argv) => {
    const { deps, log } = made();
    const result = await runOn(deps, [...argv, '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('TMUX_PANE holds no pane id');
    expect(deps.calls).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it('TP-31: exits 3 for worker watch when no session of the node runs, and names factory start', async () => {
    const result = await runOn(made(false).deps, ['worker', 'watch', '--home', HOME]);
    expect(result.code).toBe(3);
    expect(result.err).toContain('"factory start"');
  });

  it('TP-31: exits 2 for worker watch with an id that has no record', async () => {
    const result = await runOn(made().deps, ['worker', 'watch', 'ghost', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('ghost');
  });

  it('TP-31: exits 2 for worker watch --ready with an id that has no record, and names the id', async () => {
    const result = await runOn(made().deps, ['worker', 'watch', '--ready', 'ghost', '--home', HOME]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('ghost');
  });

  it('TP-31: exits 0 for worker watch when no worker has a pane, in one line, and in JSON with the schema of the watch', async () => {
    const text = await runOn(made().deps, ['worker', 'watch', '--home', HOME]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('NO WORKER');
    const json = await runOn(made().deps, ['worker', 'watch', '--home', HOME, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 'factory.worker-watch/v1' });
  });
});

describe('the state command in the command line', () => {
  const STATE_DIR = '/h/node/.factory';

  const runInState = async (argv: readonly string[]) => {
    const { handler, log } = gitHandler();
    const deps = createFakeDeps({ cwd: STATE_DIR, run: handler });
    const sink = captureSink();
    const code = await runCli([...argv], deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join(''), log };
  };

  it('has one table entry that shows the usage of state guard, and says that git runs it, not a person', async () => {
    const entry = commandTable.find((command) => command.name === commands.state);
    expect(entry?.usage).toBe('factory state guard');
    const listed = await run(['help']);
    expect(listed.out).toMatch(/\n {2}state {5}Check a commit in the state folder\. Git runs it, not a person\./);
    const result = await run(['state', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory state guard');
  });

  it('exits 0 and prints nothing for state guard when the commit changes no board', async () => {
    const result = await runInState(['state', 'guard']);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toBe('');
    expect(result.log.calls.length).toBeGreaterThan(0);
  });

  it('prints the schema of the check for state guard with --json', async () => {
    const result = await runInState(['state', 'guard', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ schema: 'factory.state-guard/v1', passed: true });
  });

  it.each([
    ['no subcommand', ['state'], 'needs a subcommand: guard'],
    ['an unknown subcommand', ['state', 'nope'], 'unknown subcommand "nope"'],
    ['a word after guard', ['state', 'guard', 'now'], 'takes no argument'],
  ])('exits 2 for %s, and runs no program', async (_name, argv, message) => {
    const result = await runInState(argv);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(result.log.calls).toEqual([]);
  });
});

describe('the item and track commands in the command line', () => {
  const usageOf = (name: string): string => commandTable.find((command) => command.name === name)?.usage ?? '';

  it('shows one usage line for each subcommand of item and of track', () => {
    for (const subcommand of Object.values(itemCommands)) {
      expect(usageOf(commands.item), subcommand).toContain(`factory ${commands.item} ${subcommand} `);
    }
    for (const subcommand of Object.values(trackCommands)) {
      expect(usageOf(commands.track), subcommand).toContain(`factory ${commands.track} ${subcommand} `);
    }
  });

  it('M5-1b TP-22 lists item and track in the help, and shows the flags of item in its help', async () => {
    const listed = await run(['help']);
    expect(listed.out).toMatch(/\n {2}item {2,}\S/);
    expect(listed.out).toMatch(/\n {2}track {2,}\S/);
    const result = await run(['item', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('factory item move ID --state STATE|--stage STAGE [--home DIR]');
    expect(result.out).toContain('factory item list [--all] [--track ID] [--follow] [--home DIR]');
    expect(result.out).toMatch(/--follow\s+With list: draw the list again at each change of the board, until the terminal goes/);
    expect(result.out).toMatch(/--field NAME=VALUE\s+With add and update: set a field of the owner on the item/);
  });

  it('M5-1b TP-22 names no decide command in the help of item or of track', async () => {
    for (const argv of [['item', '--help'], ['track', '--help']]) {
      expect((await run(argv)).out.toLowerCase(), argv.join(' ')).not.toContain('decide');
    }
  });

  it('M5-1b TP-47 exits 2 for item list with the JSON flag, because item list has no JSON output', async () => {
    const result = await run(['item', 'list', '--json']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('has no --json output');
  });

  it('M5-1b TP-22 runs item add, item move, item list and track add from the command line, with the flags in any place', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, out: sink.out.join(''), err: sink.errors.join('') };
    };
    expect((await runBoard(['track', 'add', 'core', '--name', 'Core', '--roadmap'])).out).toContain('Added the track core: Core (roadmap)');
    const added = await runBoard(['item', 'add', '--title', 'New', '--track', 'core', '--field', 'priority=P1', '--field', 'type=bug']);
    expect(added.out).toBe('Added B-1: New\n');
    expect((await runBoard(['item', 'move', 'B-1', '--stage', 'building'])).out).toBe('B-1 stage: ticket -> building\n');
    const listed = await runBoard(['item', 'list', '--track', 'core']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('B-1  building  open    P1        bug   -     New');
    expect(repo.commits).toHaveLength(3);
  });

  it('M5-1b TP-56 runs item list --follow from the command line: a stdout that is not a terminal gets one frame, and the loop ends', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { track: 'core', stage: 'ticket' })], [{ id: 'core', name: 'Core', roadmap: true }]) });
    const sink = captureSink();
    const code = await runCli(['item', 'list', '--follow', '--home', BOARD_HOME], repo.deps, sink);
    expect(code).toBe(0);
    expect(repo.deps.written).toHaveLength(1);
    expect(repo.deps.written[0]).toContain('core');
    expect(repo.deps.sleeps).toEqual([]);
    expect(sink.out.join('')).toBe('');
  });

  it('M5-1b TP-56 exits 2 for the flag --follow with a subcommand that does not list', async () => {
    const result = await run(['item', 'close', 'B-1', '--follow']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--follow is not for');
  });

  it('shows the record and the release of a worker in the help of item, with their flags, and the words of the recipe', async () => {
    const result = await run(['item', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('factory item record ID --ref REF [--project PROJECT] [--home DIR]');
    expect(result.out).toContain('factory item unassign ID [--home DIR]');
    expect(result.out).toContain('record a merged PR, and take the worker off an item');
    expect(result.out).toMatch(/--ref REF\s+With record: the reference that the check of the recipe reads\./);
    expect(result.out).toMatch(/In the software recipe: the number of the PR\./);
    expect(result.out).toMatch(/--project PROJECT\s+With record: the id of the project of the work\./);
  });

  it('says in the help of item that the worker field changes only through unassign', async () => {
    const result = await run(['item', '--help']);
    expect(result.out).toMatch(/The worker field of an item that names a worker changes only through\s+unassign\./);
  });

  it('passes the reference flag and the project flag of item record to the command', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { stage: 'review' })], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, err: sink.errors.join('') };
    };
    const badNumber = await runBoard(['item', 'record', 'B-1', '--ref', '012']);
    expect(badNumber.code).toBe(2);
    expect(badNumber.err).toContain('--ref: must be a whole number');
    const unknownProject = await runBoard(['item', 'record', 'B-1', '--ref', '12', '--project', 'nope']);
    expect(unknownProject.code).toBe(2);
    expect(unknownProject.err).toContain('the project "nope" is not in the config');
    expect(repo.commits).toEqual([]);
  });

  it('shows one usage line for each subcommand of request and of queue', () => {
    for (const subcommand of Object.values(requestCommands)) {
      expect(usageOf(commands.request), subcommand).toContain(`factory ${commands.request} ${subcommand} `);
    }
    for (const subcommand of Object.values(queueCommands)) {
      expect(usageOf(commands.queue), subcommand).toContain(`factory ${commands.queue} ${subcommand} `);
    }
  });

  it('M5-1b TP-22 lists request and queue in the help, and shows their usage and flags in their own help', async () => {
    const listed = await run(['help']);
    expect(listed.out).toMatch(/\n {2}request {2,}\S/);
    expect(listed.out).toMatch(/\n {2}queue {2,}\S/);
    const asked = await run(['request', '--help']);
    expect(asked.code).toBe(0);
    expect(asked.out).toContain('factory request add --title TEXT --question TEXT --option KEY=TEXT... [--recommend KEY] [--home DIR]');
    expect(asked.out).toContain('factory request close ID [--made-by WHO --decision TEXT] [--home DIR]');
    expect(asked.out).toMatch(/--option KEY=TEXT\s+With add: one answer that the owner can give/);
    const queue = await run(['queue', '--help']);
    expect(queue.code).toBe(0);
    expect(queue.out).toContain('factory queue set NAME [--item ID]... [--note TEXT] [--field NAME=VALUE]... [--position N] [--home DIR]');
    expect(queue.out).toMatch(/--position N\s+With set: the place of the row in the queue/);
  });

  it('M5-1b TP-22 names no decide command in the help of request or of queue', async () => {
    for (const argv of [['request', '--help'], ['queue', '--help']]) {
      expect((await run(argv)).out.toLowerCase(), argv.join(' ')).not.toContain('decide');
    }
  });

  it('M5-1b TP-188 lists decide in the help and shows its usage and its two flags in its own help', async () => {
    expect((await run(['help'])).out).toMatch(/\n {2}decide {2,}\S/);
    const asked = await run(['decide', '--help']);
    expect(asked.code).toBe(0);
    expect(asked.out).toContain('factory decide ID OPTION [--note TEXT] [--home DIR]');
    expect(asked.out).toMatch(/--note TEXT\s+The reason for the answer/);
  });

  it('M5-1b TP-188 gives the decide command no flag that skips the question: only home and note, and the flags of every command', () => {
    const decide = commandTable.find((command) => command.name === commands.decide);
    expect(Object.keys(decide?.options ?? {}).sort()).toEqual([flags.home, flags.note].sort());
  });

  it('M5-1b TP-187 routes decide read and the json flag to exit 2, and a run with no terminal window to exit 4', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, out: sink.out.join(''), err: sink.errors.join('') };
    };
    const read = await runBoard(['decide', 'read', 'D-1']);
    expect(read.code).toBe(2);
    expect(read.err).toContain('not in this version');
    expect((await runBoard(['decide', 'D-1', 'a', '--json'])).code).toBe(2);
    const noTerminal = await runBoard(['decide', 'D-1', 'a']);
    expect(noTerminal.code).toBe(4);
    expect(noTerminal.err).toContain('terminal window');
    expect(repo.commits).toEqual([]);
  });

  it('M5-1b TP-22 runs request add, request list, request close, queue set and queue show from the command line, with the flags in any place', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1')], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, out: sink.out.join(''), err: sink.errors.join('') };
    };
    const added = await runBoard(['request', 'add', '--option', 'a=Plan A', '--title', 'Pick', '--option', 'b=Plan B', '--question', 'Which?', '--recommend', 'a']);
    expect(added.out).toBe('Added D-1: Pick\n');
    expect((await runBoard(['request', 'list'])).out).toMatch(/D-1\s+Pick\s+a,b/);
    expect((await runBoard(['queue', 'set', 'Docs', '--item', 'B-1', '--field', 'release=true', '--position', '1'])).out).toBe('Added row 1 to the queue: Docs\n');
    expect((await runBoard(['queue', 'show'])).out).toMatch(/1\s+Docs\s+B-1\s+true/);
    expect((await runBoard(['request', 'close', 'D-1'])).out).toBe('Closed D-1: Pick\n');
    expect(repo.commits).toHaveLength(3);
  });

  it('M5-1b TP-22 closes a request with --made-by and --decision from the command line, and the output line names the decider', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, out: sink.out.join(''), err: sink.errors.join('') };
    };
    await runBoard(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Plan A']);
    const closed = await runBoard(['request', 'close', 'D-1', '--made-by', 'coordinator', '--decision', 'Use plan A']);
    expect(closed.code).toBe(0);
    expect(closed.out).toBe('Closed D-1: Pick (decided by the coordinator, no owner authority)\n');
  });

  it('shows the relayed close and the log of a decision in the help of request, with their flags, and no word of the decide command', async () => {
    const asked = await run(['request', '--help']);
    expect(asked.code).toBe(0);
    expect(asked.out).toContain('factory request close ID --relayed --decision TEXT [--home DIR]');
    expect(asked.out).toContain('factory request log --title TEXT --made-by WHO --decision TEXT [--home DIR]');
    expect(asked.out).toMatch(/--relayed\s+With close: /);
    expect(asked.out.replace(/\s+/g, ' ')).toContain(relayedMarker);
    expect(asked.out.toLowerCase()).not.toContain('decide');
  });

  it('passes the relayed flag and the title of a log to the command from the command line', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const runBoard = async (argv: readonly string[]) => {
      const sink = captureSink();
      const code = await runCli([...argv, '--home', BOARD_HOME], repo.deps, sink);
      return { code, out: sink.out.join(''), err: sink.errors.join('') };
    };
    await runBoard(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Plan A']);
    const relayed = await runBoard(['request', 'close', 'D-1', '--relayed', '--decision', 'Use plan A']);
    expect(relayed.code).toBe(2);
    expect(relayed.err).toContain('TMUX_PANE');
    expect(relayed.err).not.toContain('Use plan A');
    const logged = await runBoard(['request', 'log', '--title', 'Naming', '--made-by', 'delegate', '--decision', 'Use short names']);
    expect(logged.code).toBe(0);
    expect(logged.out).toBe('Logged D-2: Naming (decided by the delegate, no owner authority)\n');
    expect(repo.commits).toHaveLength(2);
  });

  it('M5-1b TP-22 prints the document of request add and of queue set for the JSON flag', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1')], []) });
    const sink = captureSink();
    const code = await runCli(['request', 'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes', '--json', '--home', BOARD_HOME], repo.deps, sink);
    expect(code).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toEqual({ schema: 'factory.request/v1', action: 'add', id: 'D-1', title: 'Pick' });
    const queueSink = captureSink();
    await runCli(['queue', 'set', 'Docs', '--item', 'B-1', '--json', '--home', BOARD_HOME], repo.deps, queueSink);
    expect(JSON.parse(queueSink.out.join(''))).toEqual({
      schema: 'factory.queue/v1',
      action: 'set',
      row: { name: 'Docs', position: 1, items: ['B-1'], created: true, changed: true },
    });
  });

  it('M5-1b TP-22 prints the document of item add for the JSON flag', async () => {
    const repo = await boardNode({ board: boardText([], []) });
    const sink = captureSink();
    const code = await runCli(['item', 'add', '--title', 'New', '--field', 'priority=P1', '--json', '--home', BOARD_HOME], repo.deps, sink);
    expect(code).toBe(0);
    expect(JSON.parse(sink.out.join(''))).toEqual({
      schema: 'factory.item/v1',
      action: 'add',
      item: { id: 'B-1', title: 'New', status: 'open', stage: 'ticket', track: null },
    });
  });
});
