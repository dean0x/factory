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
import { commandTable, parseFlags } from '../../src/cli/table.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { createFakeDeps, type FakeOptions } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { captureSink } from '../helpers/sink.js';

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
    ...commandTable.flatMap((command) => [[command.name], [command.name, '--help'], [command.name, '--json']]),
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

describe('the node command in the command line', () => {
  it('shows one usage line for each subcommand', async () => {
    const result = await run(['node', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory node children [--home DIR]');
    expect(result.out).toContain('       factory node add-child PATH [--home DIR]');
    expect(result.out).toContain('       factory node remove-child ID [--home DIR]');
  });

  it('lists the command and the start command in the help', async () => {
    const result = await run(['help']);
    expect(result.out).toMatch(/\n {2}start {5}Start the session/);
    expect(result.out).toMatch(/\n {2}node {6}Show or change the children/);
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

  it('exits 0 and writes the mode owner for each point when no flag is given', async () => {
    const result = await runInit([]);
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

  it('leaves the JSON document as it is', () => {
    const doc = { schema: 'x/v1', path: 'a\u001bb' };
    expect(JSON.parse(renderJson(doc))).toEqual(doc);
    expect(renderJson(doc)).not.toContain('\u001b');
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
