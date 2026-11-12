import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { Command } from '../../src/cli/table.js';
import { ok } from '../../src/core/result.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { captureSink } from '../helpers/sink.js';

const ran = vi.hoisted(() => [] as { words: readonly string[]; after: readonly string[] }[]);

/** A test-only row with the double dash rule. The real table holds no such row yet. */
vi.mock('../../src/cli/table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/table.js')>();
  const row: Command = {
    name: 'wrap',
    summary: 'A row for the test.',
    usage: 'factory wrap run -- COMMAND',
    options: {},
    positionals: true,
    terminator: 'required',
    run: async (given) => {
      ran.push({ words: given.positionals(), after: given.afterTerminator() });
      return ok({ lines: [], json: { schema: 'test/v1' }, warnings: [], failed: false });
    },
  };
  return {
    ...actual,
    commandTableFor: (registry: Parameters<typeof actual.commandTableFor>[0]) => [...actual.commandTableFor(registry), row],
  };
});

const run = async (argv: string[]) => {
  ran.length = 0;
  const sink = captureSink();
  const code = await runCli(argv, createFakeDeps(), sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('a row with the double dash rule in the command line', () => {
  it('runs the row with the child words kept apart, also a word that looks like a flag (TP-3)', async () => {
    const result = await run(['wrap', 'run', '--', 'npm', 'test', '--json', '--help']);
    expect(result.code).toBe(0);
    expect(ran).toEqual([{ words: ['run'], after: ['npm', 'test', '--json', '--help'] }]);
  });

  it.each([
    [['wrap', 'run', 'x', '--help']],
    [['wrap', 'run', 'x', '--', 'npm']],
    [['wrap', 'run', '--help', '--', 'npm']],
    [['wrap', 'run', '--help', '--']],
  ])('exits 2, prints no help and runs nothing: %j (TP-1, TP-2)', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('error:');
    expect(ran).toEqual([]);
  });

  it.each([[['wrap', '--help']], [['wrap', 'run', '--help']]])('prints help and exits 0: %j (TP-2)', async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory wrap');
    expect(ran).toEqual([]);
  });
});
