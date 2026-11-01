import { describe, expect, it } from 'vitest';
import { createStyle, detectStyle, renderJson, renderText, renderWarnings } from '../../src/cli/output.js';
import { runCli } from '../../src/cli/run.js';
import { parseFlags } from '../../src/cli/table.js';
import { FACTORY_VERSION } from '../../src/version.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
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
