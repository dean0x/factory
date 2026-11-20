import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/blocks/managed.js';
import { failure } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { Deps } from '../../src/core/deps.js';
import { readGuardState, readGuardStore, recordGuards, recordPrefix } from '../../src/core/guard-records.js';
import { ok } from '../../src/core/result.js';
import { guardsFor } from '../../src/guards/registry.js';
import { env, files, guardIds, guardRecords, guardRecordWords } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareGuardIds } from '../../src/recipes/software/guard-parts.js';
import { createFakeDeps, registerRoot, withFsWatch, type FakeOptions } from '../helpers/fake-deps.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';
import { parseConfigTexts } from '../../src/config/load.js';

const HOME = '/work/node';
const STORE = `/state/factory/${files.guardRecords}`;
const LOCAL = `${HOME}/${files.localConfig}`;
const SHARED = `${HOME}/${files.config}`;
const A = softwareGuardIds.approvalMerge;
const B = guardIds.installRules;
const wired = guardsFor(recipes[0]).filter((guard) => guard.wired);
const fixture = (options: FakeOptions = {}, config = sampleConfig()) => {
  const deps = createFakeDeps({ cwd: HOME, stdinIsTTY: true, stdoutIsTTY: true, prompt: () => ok('yes'), ...options, env: { [env.stateHome]: '/state', ...options.env } });
  seedConfig(deps, HOME, config);
  registerRoot(deps, HOME, 'demo');
  return deps;
};
const run = async (deps: Deps, words: readonly string[]) => {
  const sink = captureSink();
  const code = await runCli(['guard', ...words], deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};
const state = async (deps: ReturnType<typeof fixture>) => {
  const parsed = parseConfigTexts(deps.files.get(SHARED) ?? '', deps.files.get(LOCAL) ?? '', recipes);
  expect(parsed.ok).toBe(true);
  return parsed.ok ? readGuardState(deps, HOME, parsed.value, 'always') : null;
};

describe('guard set arguments', () => {
  it.each([
    [['set', 'unknown-guard', 'off'], 'Unknown guard "unknown-guard"'],
    [['set', guardIds.cloneRules, 'off'], `Unknown guard "${guardIds.cloneRules}"`],
    [['set', guardIds.hookRuntime, 'on'], `Unknown guard "${guardIds.hookRuntime}"`],
    [['set', softwareGuardIds.mergeQuality, 'off'], 'not settable in this version'],
    [['set', guardIds.sessionChecks, 'off'], 'not settable in this version'],
    [['set', A, 'off', '--all'], '--all'],
    [['set', A, 'bad'], 'on or off'],
    [['set', A, 'off', '--json'], '--json'],
    [['confirm', '--json'], '--json'],
    [['set', A, 'on', '--family', A], '--family'],
    [['confirm', '--family', A], '--family'],
    [['confirm', '--all'], '--all'],
  ])('refuses %j before any file read', async (words, message) => {
    const seen: string[] = [];
    const deps = withFsWatch(createFakeDeps(), (method) => { seen.push(method); });
    const result = await run(deps, words);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    const listed: readonly string[] = ['unknown-guard', guardIds.cloneRules, guardIds.hookRuntime, softwareGuardIds.mergeQuality];
    if (listed.includes(words[1] ?? '')) expect(result.err).toContain('factory guard list');
    expect(seen).toEqual([]);
  });
});

describe('the guard command channel', () => {
  const cases = [
    [{ env: { [env.session]: 'node', [env.claudeCode]: '1' } }, guardRecordWords.sessionRefused],
    [{ env: { [env.claudeCode]: '1' } }, guardRecordWords.claudeRefused],
    [{ stdinIsTTY: false }, guardRecordWords.inputRequired],
    [{ stdoutIsTTY: false }, guardRecordWords.outputRequired],
  ] as const;
  for (const command of [['set', A, 'off'], ['confirm']]) {
    it.each(cases)(`${command[0]} refuses a restricted channel %j before any read`, async (options, message) => {
      const deps = fixture(options);
      const config = sampleConfig();
      const restricted = [guardIds.sessionChecks, guardIds.approvalDelegation, guardIds.ownerGo, guardIds.fileLinkSafety];
      seedConfig(deps, HOME, { ...config, core: { ...config.core, guards: Object.fromEntries(restricted.map((id) => [id, 'off'])) } });
      deps.seed(STORE, JSON.stringify({ schema: guardRecords.schema, records: [{ node: 'demo', root: HOME, prefix: null, values: Object.fromEntries(restricted.map((id) => [id, { value: 'off', at: deps.now().toISOString() }])) }] }));
      const before = new Map(deps.files);
      const seen: string[] = [];
      const result = await run(withFsWatch(deps, (method) => { seen.push(method); }), command);
      expect(result.code).toBe(4);
      expect(result.err).toContain(message);
      expect(seen).toEqual([]);
      expect(deps.files).toEqual(before);
    });
  }
});

describe('guard set writes', () => {
  it('records only the named guard and keeps the prefix and other unmatched values', async () => {
    const deps = fixture();
    const config = sampleConfig();
    seedConfig(deps, HOME, { ...config, core: { ...config.core, guards: { [B]: 'off' } } });
    expect((await recordPrefix(deps, { root: HOME, node: 'demo', prefix: config.core.owner.prefix })).ok).toBe(true);
    const result = await run(deps, ['set', A, 'off']);
    expect(result.code).toBe(0);
    expect((await state(deps))?.values).toMatchObject({ [A]: 'off', [B]: 'on' });
    expect((await state(deps))?.prefix?.hash).toBe(sha256Hex(config.core.owner.prefix));
    expect(deps.atomicWrites.slice(-2)).toEqual([LOCAL, STORE]);
    expect(deps.written.join('')).toContain(`${A} H`);
    expect(deps.written.join('')).toContain('A code check follows the new value at the next command.');
    expect(deps.written.join('')).toContain('The role text changes at the next "factory start" or "factory upgrade".');
    expect(deps.prompts).toHaveLength(1);
  });

  it.each(['on', 'off'] as const)('sets only wired guards to %s with all, skips the fixed guards and reports the excluded count', async (value) => {
    const deps = fixture();
    const result = await run(deps, ['set', '--all', value]);
    expect(result.code).toBe(0);
    const stored = await readGuardStore(deps, STORE);
    expect(stored.ok).toBe(true);
    expect(stored.ok ? Object.keys(stored.value[0]?.values ?? {}).sort() : []).toEqual(wired.map((guard) => guard.id).sort());
    const display = deps.written.join('');
    if (value === 'off') for (const guard of wired) expect(display).toContain(`${guard.id}${guard.harm ? ' H' : ''}`);
    for (const id of [guardIds.cloneRules, guardIds.hookRuntime]) expect(`${display}${result.out}${deps.files.get(LOCAL) ?? ''}`).not.toContain(id);
    const settable = guardsFor(recipes[0]).filter((guard) => !guard.fixed);
    expect(`${display}${result.out}`).toContain(`${settable.length - wired.length} guards are not settable`);
    expect(deps.prompts).toHaveLength(value === 'off' ? 1 : 0);
  });

  it.each(['', 'no'])('writes nothing when the answer is %j', async (answer) => {
    const deps = fixture({ prompt: () => ok(answer) });
    const before = new Map(deps.files);
    expect((await run(deps, ['set', A, 'off'])).code).toBe(2);
    expect(deps.files).toEqual(before);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('records on before the local write and rejects a later local off', async () => {
    const deps = fixture();
    expect((await run(deps, ['set', A, 'off'])).code).toBe(0);
    expect((await run(deps, ['set', A, 'on'])).code).toBe(0);
    expect(deps.atomicWrites.slice(-2)).toEqual([STORE, LOCAL]);
    deps.files.set(LOCAL, (deps.files.get(LOCAL) ?? '').replace(new RegExp(`${A}: "?on"?`), `${A}: off`));
    expect((await state(deps))?.values[A]).toBe('on');
    expect((await state(deps))?.unmatched).toContain(A);
    expect(deps.prompts).toHaveLength(1);
  });

  it.each(['on', 'off'] as const)('keeps the guard on when the %s record write fails', async (value) => {
    const deps = fixture();
    const config = sampleConfig();
    if (value === 'on') {
      seedConfig(deps, HOME, { ...config, core: { ...config.core, guards: { [A]: 'off' } } });
      expect((await recordGuards(deps, { root: HOME, node: 'demo', change: [{ guard: { id: A, wired: true }, value: 'off' }] })).ok).toBe(true);
    }
    const broken = { ...deps, fs: { ...deps.fs, writeTextAtomicCore: async (...args: Parameters<NonNullable<Deps['fs']['writeTextAtomicCore']>>) => args[0] === STORE ? failure('record write failed') : deps.fs.writeTextAtomic(...args) } };
    const result = await run(broken, ['set', A, value]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('factory doctor');
    expect(deps.files.get(LOCAL)).toMatch(new RegExp(`${A}: "?on"?`));
    expect((await state(deps))?.values[A]).toBe('on');
  });

  it('names doctor and attempts local on when both writes fail', async () => {
    const deps = fixture();
    const attempted: string[] = [];
    const broken = { ...deps, fs: { ...deps.fs, writeTextAtomicCore: async (path: string) => { attempted.push(path); return failure('write failed'); } } };
    const result = await run(broken, ['set', A, 'on']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('factory doctor');
    expect(attempted).toEqual([STORE, LOCAL]);
  });

  it('keeps the guard on after a failed off write with an older off record', async () => {
    const deps = fixture();
    expect((await recordGuards(deps, { root: HOME, node: 'demo', change: [{ guard: { id: A, wired: true }, value: 'off' }] })).ok).toBe(true);
    const broken = { ...deps, fs: { ...deps.fs, writeTextAtomicCore: async (...args: Parameters<NonNullable<Deps['fs']['writeTextAtomicCore']>>) => args[0] === STORE ? failure('record write failed') : deps.fs.writeTextAtomic(...args) } };
    expect((await run(broken, ['set', A, 'off'])).code).toBe(1);
    expect((await state(deps))?.values[A]).toBe('on');
  });

  it('keeps comments and writes mode 600', async () => {
    const deps = fixture();
    deps.files.set(LOCAL, `# keep this comment\n${deps.files.get(LOCAL) ?? ''}`);
    deps.modes.set(LOCAL, 0o644);
    expect((await run(deps, ['set', A, 'off'])).code).toBe(0);
    expect(deps.files.get(LOCAL)).toContain('# keep this comment');
    expect(deps.modes.get(LOCAL)).toBe(0o600);
  });

  it.each([LOCAL, SHARED])('stops without a write when %s changes at the question', async (path) => {
    const deps = fixture({ prompt: () => { deps.files.set(path, `${deps.files.get(path) ?? ''}\n# another edit\n`); return ok('y'); } });
    const result = await run(deps, ['set', A, 'off']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('changed');
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.files.get(path)).toContain('# another edit');
  });

  it('checks the whole config before any write', async () => {
    const deps = fixture();
    deps.files.set(SHARED, `${deps.files.get(SHARED) ?? ''}\nunknown_key: true\n`);
    expect((await run(deps, ['set', A, 'off'])).code).not.toBe(0);
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.prompts).toEqual([]);
  });

  it('does not record off when the local write fails', async () => {
    const deps = fixture();
    const broken = { ...deps, fs: { ...deps.fs, writeTextAtomicCore: async (...args: Parameters<NonNullable<Deps['fs']['writeTextAtomicCore']>>) => args[0] === LOCAL ? failure('local write failed') : deps.fs.writeTextAtomic(...args) } };
    expect((await run(broken, ['set', A, 'off'])).code).toBe(1);
    expect(deps.files.has(STORE)).toBe(false);
  });

  it.each(['link', 'other owner', 'group write'] as const)('refuses a local file with %s before a write', async (fault) => {
    const deps = fixture(fault === 'link' ? { links: { [LOCAL]: '/other/config' } } : {});
    if (fault === 'other owner') deps.owners.set(LOCAL, 2000);
    if (fault === 'group write') deps.modes.set(LOCAL, 0o660);
    expect((await run(deps, ['set', A, 'off'])).code).toBe(4);
    expect(deps.atomicWrites).toEqual([]);
    expect(deps.prompts).toEqual([]);
  });
});

describe('guard confirm', () => {
  it('shows the whole prefix on stdout and records its exact text after yes', async () => {
    const config = sampleConfig();
    const prefix = `[${'owner text '.repeat(20)}{owner} {node}\t{date}]`;
    const deps = fixture({}, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix } } });
    const result = await run(deps, ['confirm']);
    expect(result.code).toBe(0);
    expect(deps.written.join('')).toContain(prefix);
    expect(deps.prompts).toHaveLength(1);
    expect(deps.prompts[0]).toContain('[y/N]');
    expect((await state(deps))?.prefix?.hash).toBe(sha256Hex(prefix));
    expect(deps.files.get(LOCAL)).not.toContain('guards:');
  });

  it('says when the saved prefix differs and keeps guard values', async () => {
    const deps = fixture();
    expect((await recordGuards(deps, { root: HOME, node: 'demo', change: [{ guard: { id: A, wired: true }, value: 'off' }] })).ok).toBe(true);
    expect((await recordPrefix(deps, { root: HOME, node: 'demo', prefix: 'old prefix' })).ok).toBe(true);
    expect((await run(deps, ['confirm'])).code).toBe(0);
    expect(deps.written.join('')).toContain('differs');
    const stored = await readGuardStore(deps, STORE);
    expect(stored.ok && stored.value[0]?.values[A]?.value).toBe('off');
    expect((await state(deps))?.prefix?.hash).toBe(sha256Hex(sampleConfig().core.owner.prefix));
  });

  it.each(['', 'no'])('keeps the record unchanged for answer %j', async (answer) => {
    const deps = fixture({ prompt: () => ok(answer) });
    const before = new Map(deps.files);
    expect((await run(deps, ['confirm'])).code).toBe(2);
    expect(deps.files).toEqual(before);
  });

  it.each(['\u001b', '‮', '​', '\ud800'])('shows a hidden prefix character as an escape and refuses it %j', async (hidden) => {
    const config = sampleConfig();
    const prefix = `[${hidden}{owner} {node} {date}]`;
    const deps = fixture({}, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix } } });
    const result = await run(deps, ['confirm']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('owner.prefix');
    expect(deps.written.join('')).toContain(hidden === '\u001b' ? '\\x1b' : `\\u{${hidden.codePointAt(0)?.toString(16)}}`);
    expect(deps.written.join('')).not.toContain(hidden);
    expect(deps.prompts).toEqual([]);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('shows a carriage return as an escape and refuses the prefix with exit two', async () => {
    const config = sampleConfig();
    const prefix = `[${String.fromCharCode(13)}{owner} {node} {date}]`;
    const deps = fixture({}, { ...config, core: { ...config.core, owner: { ...config.core.owner, prefix } } });
    const result = await run(deps, ['confirm']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('owner.prefix');
    expect(deps.written.join('')).toContain('\\x0d');
    expect(deps.prompts).toEqual([]);
    expect(deps.atomicWrites).toEqual([]);
  });

  it('writes no prefix record when the config changes at the question', async () => {
    const deps = fixture({ prompt: () => { deps.files.set(LOCAL, `${deps.files.get(LOCAL) ?? ''}\n# new prefix edit\n`); return ok('yes'); } });
    const result = await run(deps, ['confirm']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('changed');
    expect(deps.files.has(STORE)).toBe(false);
  });

  it('keeps an unreadable store unchanged', async () => {
    const deps = fixture();
    deps.seed(STORE, 'not json');
    const result = await run(deps, ['confirm']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('factory doctor');
    expect(deps.files.get(STORE)).toBe('not json');
    expect(deps.atomicWrites).toEqual([]);
  });
});

describe('saved guard record warnings', () => {
  for (const words of [['set', A, 'off'], ['confirm']]) {
    it.each([false, true])(`${words[0]} exits zero and prints only a saved write warning when cleanup fails: %s`, async (cleanupFails) => {
      const deps = fixture();
      const used = cleanupFails ? { ...deps, fs: { ...deps.fs, removeFile: async () => failure('cannot remove lock') } } : deps;
      const result = await run(used, words);
      expect(result.code).toBe(0);
      expect(deps.files.has(STORE)).toBe(true);
      expect(result.err).toBe(cleanupFails ? `warning: ${guardRecordWords.lockLeft}\n` : '');
    });
  }
});
