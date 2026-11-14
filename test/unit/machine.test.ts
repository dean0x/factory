import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure, type CliResult } from '../../src/cli/errors.js';
import { runCli } from '../../src/cli/run.js';
import type { RunOutput } from '../../src/core/deps.js';
import { ok } from '../../src/core/result.js';
import { machineNames } from '../../src/names.js';
import {
  factText,
  gatherMachine,
  machineVerdict,
  machineWarnings,
  parseCount,
  parseDfFreeGb,
  parseMacLoad,
  parseMemoryPressure,
  parseMeminfo,
  parseProcLoad,
  type Fact,
  type FactName,
  type MachineLimits,
  type MachineReport,
} from '../../src/workers/machine.js';
import { readPower, type Power } from '../../src/workers/power.js';
import {
  createFakeDeps,
  exited,
  missingProgram,
  registerRoot,
  withFsWatch,
  type FakeDeps,
  type RunCall,
} from '../helpers/fake-deps.js';
import { runMachine } from '../helpers/package-registry.js';
import { sampleConfig, seedConfig } from '../helpers/sample-config.js';
import { expectShortOutput, plainText } from '../helpers/short-output.js';
import { captureSink } from '../helpers/sink.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'machine');
const fixture = (system: 'macos' | 'linux', name: string): string =>
  readFileSync(join(FIXTURES, system, name), 'utf8');

const HOME = '/w/demo';
const LIMITS: MachineLimits = sampleConfig().core.limits;
const FACT_NAMES: readonly FactName[] = ['memory', 'disk', 'load', 'cpus'];

/** What a program prints: a text for a clean exit, or the whole result of the call. */
type Answer = string | CliResult<RunOutput>;
type Source = 'memory' | 'disk' | 'load' | 'cpus';
type Answers = Partial<Record<Source | 'power', Answer>>;

const resultOf = (answer: Answer): CliResult<RunOutput> => (typeof answer === 'string' ? exited(0, answer) : answer);

const handlerFor = (answers: Answers) => (call: RunCall): CliResult<RunOutput> => {
  const answer = (source: Source | 'power'): CliResult<RunOutput> => {
    const given = answers[source];
    return given === undefined ? missingProgram(call.command) : resultOf(given);
  };
  if (call.command === 'memory_pressure') return answer('memory');
  if (call.command === 'df') return answer('disk');
  if (call.command === 'nproc') return answer('cpus');
  if (call.command === 'pmset') return answer('power');
  if (call.command === 'sysctl') return answer(call.args.includes('vm.loadavg') ? 'load' : 'cpus');
  return missingProgram(call.command);
};

const MAC_ANSWERS: Answers = {
  memory: fixture('macos', 'memory_pressure.txt'),
  disk: fixture('macos', 'df.txt'),
  load: fixture('macos', 'sysctl-loadavg.txt'),
  cpus: fixture('macos', 'sysctl-ncpu.txt'),
  power: fixture('macos', 'pmset-ac.txt'),
};

const LINUX_ANSWERS: Answers = { disk: fixture('linux', 'df.txt'), cpus: fixture('linux', 'nproc.txt') };

/** A factory folder with the sample config and a fake system. */
const withFactory = (deps: FakeDeps, limits: MachineLimits = LIMITS): FakeDeps => {
  const config = sampleConfig();
  seedConfig(deps, HOME, { ...config, core: { ...config.core, limits } });
  registerRoot(deps, HOME, 'demo');
  return deps;
};

const fakeOptions = { cwd: '/w', env: { XDG_STATE_HOME: '/state' } } as const;

/** macOS: the programs give the facts. */
const macMachine = (answers: Answers = {}, limits: MachineLimits = LIMITS): FakeDeps =>
  withFactory(createFakeDeps({ ...fakeOptions, os: 'darwin', run: (call) => handlerFor({ ...MAC_ANSWERS, ...answers })(call) }), limits);

/** Linux: `/proc` gives the memory and the load, `df` and `nproc` the rest. A null text leaves the file out. */
const linuxMachine = (
  answers: Answers = {},
  proc: { readonly memory?: string | null; readonly load?: string | null } = {},
  limits: MachineLimits = LIMITS,
): FakeDeps => {
  const deps = withFactory(
    createFakeDeps({ ...fakeOptions, os: 'linux', run: (call) => handlerFor({ ...LINUX_ANSWERS, ...answers })(call) }),
    limits,
  );
  const memory = proc.memory === undefined ? fixture('linux', 'meminfo.txt') : proc.memory;
  const load = proc.load === undefined ? fixture('linux', 'loadavg.txt') : proc.load;
  if (memory !== null) deps.seed('/proc/meminfo', memory);
  if (load !== null) deps.seed('/proc/loadavg', load);
  return deps;
};

type Supply = Partial<Record<'type' | 'scope' | 'online' | 'status' | 'capacity', string>>;

/** The folder of the Linux kernel with one folder for each power supply, and one file for each given value. */
const seedSupplies = (deps: FakeDeps, supplies: Readonly<Record<string, Supply>>): void => {
  const root = machineNames.powerSupplyDir;
  deps.seedDir(root);
  for (const [name, files] of Object.entries(supplies)) {
    deps.seedDir(`${root}/${name}`);
    for (const [file, text] of Object.entries(files)) deps.seed(`${root}/${name}/${file}`, text);
  }
};

const factOf = (report: MachineReport, name: FactName): Fact => {
  const found = report.find((fact) => fact.name === name);
  if (found === undefined) throw new Error(`the report has no fact ${name}`);
  return found;
};

const verdictsOf = (report: MachineReport): Record<string, string> =>
  Object.fromEntries(report.map((fact) => [fact.name, fact.verdict]));

describe('the parsers of the machine facts', () => {
  it('reads the free percent of the memory_pressure output of macOS', () => {
    expect(parseMemoryPressure(fixture('macos', 'memory_pressure.txt'))).toBe(62);
    expect(parseMemoryPressure('System-wide memory free percentage: 0%\r\n')).toBe(0);
    expect(parseMemoryPressure('System-wide memory free percentage: 100%')).toBe(100);
  });

  it.each([
    [''],
    ['The system has 17179869184 bytes.'],
    ['System-wide memory free percentage: lots%'],
    ['System-wide memory free percentage: 101%'],
    ['System-wide memory free percentage: -3%'],
    ['System-wide memory free percentage: 62'],
    ['memory free percentage: 62%'],
  ])('gives no memory percent for %j', (text) => {
    expect(parseMemoryPressure(text)).toBeNull();
  });

  it('computes the free percent of /proc/meminfo from MemAvailable and MemTotal, in one decimal', () => {
    expect(parseMeminfo(fixture('linux', 'meminfo.txt'))).toBe(50);
    expect(parseMeminfo('MemTotal: 3 kB\nMemAvailable: 1 kB\n')).toBe(33.3);
  });

  it.each([
    ['no MemAvailable line (an old kernel)', 'MemTotal: 1000 kB\nMemFree: 500 kB\n'],
    ['no MemTotal line', 'MemAvailable: 500 kB\n'],
    ['a MemTotal of 0', 'MemTotal: 0 kB\nMemAvailable: 0 kB\n'],
    ['more available than total', 'MemTotal: 1000 kB\nMemAvailable: 1001 kB\n'],
    ['a value that is not a number', 'MemTotal: lots kB\nMemAvailable: 5 kB\n'],
    ['a unit other than kB', 'MemTotal: 1000 MB\nMemAvailable: 500 MB\n'],
    ['an empty file', ''],
  ])('gives no memory percent for %s', (_name, text) => {
    expect(parseMeminfo(text)).toBeNull();
  });

  it('reads the free GB of the df line, on both systems, in one decimal', () => {
    expect(parseDfFreeGb(fixture('macos', 'df.txt'))).toBe(300);
    expect(parseDfFreeGb(fixture('linux', 'df.txt'))).toBe(100);
    expect(parseDfFreeGb('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 50 1572864 50% /\n')).toBe(1.5);
  });

  it('reads a df line whose file system name and mount point hold spaces', () => {
    const text =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\nmap auto home 1000 500 2097152 50% /System/Volumes/Data/my home\n';
    expect(parseDfFreeGb(text)).toBe(2);
  });

  it.each([
    ['an empty text', ''],
    ['the header only', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'],
    ['a line with no capacity', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 50 25\n'],
    ['an available value that is not a number', 'Filesystem 1 2 3 4 5\n/dev/x 100 50 many 50% /\n'],
    ['a negative available value', 'Filesystem 1 2 3 4 5\n/dev/x 100 50 -5 50% /\n'],
    ['an available value above the safe integers', `Filesystem 1 2 3 4 5\n/dev/x 100 50 ${'9'.repeat(30)} 50% /\n`],
  ])('gives no free GB for %s', (_name, text) => {
    expect(parseDfFreeGb(text)).toBeNull();
  });

  it('reads the first load average of macOS and of Linux, in two decimals', () => {
    expect(parseMacLoad(fixture('macos', 'sysctl-loadavg.txt'))).toBe(2.2);
    expect(parseMacLoad('{ 0.006 1 2 }')).toBe(0.01);
    expect(parseProcLoad(fixture('linux', 'loadavg.txt'))).toBe(0.52);
    expect(parseProcLoad('12 3.5 4\n')).toBe(12);
  });

  it.each([[''], ['{ }'], ['{ a b c }'], ['{ 2,20 2,35 2,86 }'], ['{ 1.0 2.0 }'], ['{ -1 2 3 }'], ['1.0 2.0 3.0']])(
    'gives no macOS load for %j',
    (text) => {
      expect(parseMacLoad(text)).toBeNull();
    },
  );

  it.each([[''], ['load'], ['1.0 2.0'], ['a b c 1/2 3'], ['-1 2 3 1/2 3'], ['{ 1.0 2.0 3.0 }']])(
    'gives no Linux load for %j',
    (text) => {
      expect(parseProcLoad(text)).toBeNull();
    },
  );

  it('reads a count of processors from 1 to the cap', () => {
    expect(parseCount('10\n')).toBe(10);
    expect(parseCount('1')).toBe(1);
    expect(parseCount(String(machineNames.maxCpus))).toBe(machineNames.maxCpus);
  });

  it.each([[''], ['0'], ['-1'], ['2.5'], ['many'], ['10 20'], [String(machineNames.maxCpus + 1)]])(
    'gives no count for %j',
    (text) => {
      expect(parseCount(text)).toBeNull();
    },
  );
});

describe('gatherMachine on the fixtures of both systems', () => {
  it('reads the macOS fixtures into four facts, with the limit that the config gives', async () => {
    const report = await gatherMachine(macMachine(), HOME, LIMITS);
    expect(report).toEqual([
      { name: 'memory', value: 62, limit: 20, verdict: 'ok', note: null },
      { name: 'disk', value: 300, limit: 20, verdict: 'ok', note: null },
      { name: 'load', value: 2.2, limit: 8, verdict: 'ok', note: null },
      { name: 'cpus', value: 8, limit: null, verdict: 'ok', note: null },
    ]);
  });

  it('reads the Linux fixtures into four facts, with the limit that the config gives', async () => {
    const report = await gatherMachine(linuxMachine(), HOME, LIMITS);
    expect(report).toEqual([
      { name: 'memory', value: 50, limit: 20, verdict: 'ok', note: null },
      { name: 'disk', value: 100, limit: 20, verdict: 'ok', note: null },
      { name: 'load', value: 0.52, limit: 8, verdict: 'ok', note: null },
      { name: 'cpus', value: 8, limit: null, verdict: 'ok', note: null },
    ]);
  });

  it('gives the same verdict format on both systems: the same facts, the same keys, one verdict word set', async () => {
    const mac = await gatherMachine(macMachine(), HOME, LIMITS);
    const linux = await gatherMachine(linuxMachine(), HOME, LIMITS);
    expect(mac.map((fact) => fact.name)).toEqual(FACT_NAMES);
    expect(linux.map((fact) => fact.name)).toEqual(FACT_NAMES);
    for (const fact of [...mac, ...linux]) {
      expect(Object.keys(fact).sort()).toEqual(['limit', 'name', 'note', 'value', 'verdict']);
      expect(['ok', 'fail', 'unknown']).toContain(fact.verdict);
    }
    expect(mac.map(factText).map((text) => text.replace(/[0-9.]+/g, 'N'))).toEqual(
      linux.map(factText).map((text) => text.replace(/[0-9.]+/g, 'N')),
    );
  });

  it('gives every program call a time limit', async () => {
    const mac = macMachine();
    await gatherMachine(mac, HOME, LIMITS);
    expect(mac.calls).toHaveLength(4);
    expect(mac.calls.map((call) => call.timeoutMs)).toEqual(Array(4).fill(machineNames.callTimeoutMs));

    const linux = linuxMachine();
    await gatherMachine(linux, HOME, LIMITS);
    expect(linux.calls).toHaveLength(2);
    expect(linux.calls.map((call) => call.timeoutMs)).toEqual(Array(2).fill(machineNames.callTimeoutMs));
  });

  it('asks df for the file system of the factory folder', async () => {
    const deps = macMachine();
    await gatherMachine(deps, HOME, LIMITS);
    const df = deps.calls.find((call) => call.command === 'df');
    expect(df?.args).toEqual(['-Pk', '--', HOME]);
  });

  it('reads the memory and the load from /proc on Linux, and runs no program of macOS there', async () => {
    const deps = linuxMachine();
    await gatherMachine(deps, HOME, LIMITS);
    expect(deps.calls.map((call) => call.command).sort()).toEqual(['df', 'nproc']);
  });

  it('runs no program of Linux on macOS', async () => {
    const deps = macMachine();
    await gatherMachine(deps, HOME, LIMITS);
    expect(deps.calls.map((call) => call.command)).not.toContain('nproc');
    expect(deps.calls.map((call) => call.command).sort()).toEqual(['df', 'memory_pressure', 'sysctl', 'sysctl']);
  });

  it('gives four unknown facts, and runs nothing, on a system that is neither macOS nor Linux', async () => {
    const deps = withFactory(createFakeDeps({ ...fakeOptions, os: 'freebsd', run: handlerFor(MAC_ANSWERS) }));
    const report = await gatherMachine(deps, HOME, LIMITS);
    expect(report.map((fact) => fact.name)).toEqual(FACT_NAMES);
    expect(report.every((fact) => fact.verdict === 'unknown' && fact.value === null && fact.note !== null)).toBe(true);
    expect(deps.calls).toEqual([]);
  });
});

describe('a fact that does not parse or does not come is unknown', () => {
  const NOT_PARSED: readonly (readonly [Source, string])[] = [
    ['memory', 'The system has 4 pages.\n'],
    ['memory', 'System-wide memory free percentage: 101%\n'],
    ['memory', ''],
    ['disk', 'df: no such file\n'],
    ['disk', 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'],
    ['disk', 'Filesystem 1 2 3 4 5\n/dev/x many many many 50% /\n'],
    ['load', 'up 3 days\n'],
    ['load', '{ 2,20 2,35 2,86 }\n'],
    ['load', ''],
    ['cpus', 'many\n'],
    ['cpus', '0\n'],
    ['cpus', ''],
  ];

  it.each(NOT_PARSED)('gives unknown for the %s output %j on macOS', async (source, text) => {
    const report = await gatherMachine(macMachine({ [source]: text }), HOME, LIMITS);
    const target = source === 'cpus' ? 'cpus' : source;
    expect(factOf(report, target)).toMatchObject({ value: null, verdict: 'unknown' });
    expect(factOf(report, target).note).not.toBeNull();
    for (const name of FACT_NAMES.filter((other) => other !== target && !(source === 'cpus' && other === 'load'))) {
      expect(factOf(report, name).verdict, name).toBe('ok');
    }
  });

  const MODES: readonly (readonly [string, (program: string) => Answer])[] = [
    ['does not run', (program) => missingProgram(program)],
    ['takes longer than its time limit', (program) => failure(`cannot run ${program}: SIGTERM`)],
    ['exits with a code other than 0', () => exited(1, '', 'failed')],
    ['exits with code 0 and prints nothing', () => ''],
  ];

  const PROGRAM_OF: Readonly<Record<Source, string>> = {
    memory: 'memory_pressure',
    disk: 'df',
    load: 'sysctl',
    cpus: 'sysctl',
  };

  describe.each(MODES)('a program that %s', (_mode, answerFor) => {
    it.each(['memory', 'disk', 'load', 'cpus'] as const)('gives unknown for %s on macOS, and throws no error', async (source) => {
      const report = await gatherMachine(macMachine({ [source]: answerFor(PROGRAM_OF[source]) }), HOME, LIMITS);
      expect(factOf(report, source)).toMatchObject({ value: null, verdict: 'unknown' });
      expect(factOf(report, source).note).toContain(PROGRAM_OF[source]);
    });

    it.each(['disk', 'cpus'] as const)('gives unknown for %s on Linux, and throws no error', async (source) => {
      const report = await gatherMachine(linuxMachine({ [source]: answerFor(PROGRAM_OF[source]) }), HOME, LIMITS);
      expect(factOf(report, source)).toMatchObject({ value: null, verdict: 'unknown' });
    });
  });

  it.each([
    ['is missing', null],
    ['has no MemAvailable line', 'MemTotal: 1000 kB\nMemFree: 500 kB\n'],
    ['has a MemTotal of 0', 'MemTotal: 0 kB\nMemAvailable: 0 kB\n'],
    ['is larger than the cap', `MemTotal: 1000 kB\nMemAvailable: 500 kB\n${'#'.repeat(machineNames.maxFileBytes)}\n`],
  ])('gives unknown for the memory when /proc/meminfo %s', async (_name, text) => {
    const report = await gatherMachine(linuxMachine({}, { memory: text }), HOME, LIMITS);
    expect(factOf(report, 'memory')).toMatchObject({ value: null, verdict: 'unknown' });
    expect(factOf(report, 'memory').note).toContain(machineNames.procFiles.memory);
    expect(verdictsOf(report)).toMatchObject({ disk: 'ok', load: 'ok', cpus: 'ok' });
  });

  it.each([
    ['is missing', null],
    ['holds text that is not a load', 'busy\n'],
    ['is empty', ''],
  ])('gives unknown for the load when /proc/loadavg %s', async (_name, text) => {
    const report = await gatherMachine(linuxMachine({}, { load: text }), HOME, LIMITS);
    expect(factOf(report, 'load')).toMatchObject({ value: null, verdict: 'unknown' });
    expect(factOf(report, 'load').note).toContain(machineNames.procFiles.load);
    expect(verdictsOf(report)).toMatchObject({ memory: 'ok', disk: 'ok', cpus: 'ok' });
  });

  it('gives unknown for the load when the limit is cpu_count and the count of processors is unknown', async () => {
    const report = await gatherMachine(macMachine({ cpus: 'many\n' }), HOME, LIMITS);
    expect(factOf(report, 'load')).toMatchObject({ value: 2.2, limit: null, verdict: 'unknown' });
    expect(factOf(report, 'load').note).toContain('CPU');
    expect(factOf(report, 'cpus').verdict).toBe('unknown');
  });

  it('judges the load against a number limit even when the count of processors is unknown', async () => {
    const limits: MachineLimits = { ...LIMITS, load_max: 4 };
    const report = await gatherMachine(macMachine({ cpus: failure('cannot run sysctl: SIGTERM') }, limits), HOME, limits);
    expect(factOf(report, 'load')).toMatchObject({ value: 2.2, limit: 4, verdict: 'ok' });
    expect(factOf(report, 'cpus').verdict).toBe('unknown');
  });
});

describe('the limits of the facts, at their edges', () => {
  const memory = async (limit: number, text = fixture('macos', 'memory_pressure.txt')): Promise<Fact> =>
    factOf(await gatherMachine(macMachine({ memory: text }), HOME, { ...LIMITS, memory_free_min_pct: limit }), 'memory');

  it('passes a memory that equals its minimum, and fails a memory that is below it', async () => {
    expect(await memory(62)).toMatchObject({ value: 62, limit: 62, verdict: 'ok' });
    expect(await memory(63)).toMatchObject({ value: 62, limit: 63, verdict: 'fail', note: null });
    expect(await memory(0)).toMatchObject({ verdict: 'ok' });
    expect(await memory(90)).toMatchObject({ verdict: 'fail' });
  });

  it('fails a memory of 0 percent against a minimum above 0, and passes it against a minimum of 0', async () => {
    const empty = 'System-wide memory free percentage: 0%\n';
    expect(await memory(1, empty)).toMatchObject({ value: 0, verdict: 'fail' });
    expect(await memory(0, empty)).toMatchObject({ value: 0, verdict: 'ok' });
  });

  const disk = async (limit: number, text = fixture('macos', 'df.txt')): Promise<Fact> =>
    factOf(await gatherMachine(macMachine({ disk: text }), HOME, { ...LIMITS, disk_free_min_gb: limit }), 'disk');

  it('passes a disk that equals its minimum, and fails a disk that is below it', async () => {
    expect(await disk(300)).toMatchObject({ value: 300, limit: 300, verdict: 'ok' });
    expect(await disk(300.1)).toMatchObject({ value: 300, limit: 300.1, verdict: 'fail' });
    expect(await disk(0)).toMatchObject({ verdict: 'ok' });
  });

  const dfWith = (availableKib: number): string =>
    `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 999999999 1 ${availableKib} 50% /\n`;

  it('compares the value that it shows: a disk of 19.96 GB shows 20 and passes a minimum of 20', async () => {
    expect(await disk(20, dfWith(20 * 1_048_576 - 1))).toMatchObject({ value: 20, verdict: 'ok' });
    expect(await disk(20, dfWith(20 * 1_048_576 - 62_915))).toMatchObject({ value: 19.9, verdict: 'fail' });
  });

  it('compares the value that it shows: a memory of 19.96 percent shows 20 and passes a minimum of 20', async () => {
    const rounded = factOf(
      await gatherMachine(linuxMachine({}, { memory: 'MemTotal: 10000 kB\nMemAvailable: 1996 kB\n' }), HOME, LIMITS),
      'memory',
    );
    expect(rounded).toMatchObject({ value: 20, verdict: 'ok' });
    const below = factOf(
      await gatherMachine(linuxMachine({}, { memory: 'MemTotal: 10000 kB\nMemAvailable: 1994 kB\n' }), HOME, LIMITS),
      'memory',
    );
    expect(below).toMatchObject({ value: 19.9, verdict: 'fail' });
  });

  const load = async (limit: MachineLimits['load_max'], text: string, cpus = '8\n'): Promise<Fact> =>
    factOf(await gatherMachine(linuxMachine({ cpus }, { load: text }, { ...LIMITS, load_max: limit }), HOME, { ...LIMITS, load_max: limit }), 'load');

  it('passes a load that equals the number limit, and fails a load that is above it', async () => {
    expect(await load(2.2, '2.20 1.00 1.00 1/10 5\n')).toMatchObject({ value: 2.2, limit: 2.2, verdict: 'ok' });
    expect(await load(2.1, '2.20 1.00 1.00 1/10 5\n')).toMatchObject({ value: 2.2, limit: 2.1, verdict: 'fail' });
  });

  it('takes the count of processors as the limit for cpu_count: a load equal to the count passes, above it fails', async () => {
    expect(await load('cpu_count', '8.00 1.00 1.00 1/10 5\n')).toMatchObject({ value: 8, limit: 8, verdict: 'ok' });
    expect(await load('cpu_count', '8.01 1.00 1.00 1/10 5\n')).toMatchObject({ value: 8.01, limit: 8, verdict: 'fail' });
    expect(await load('cpu_count', '12.50 1.00 1.00 1/10 5\n', '2\n')).toMatchObject({ value: 12.5, limit: 2, verdict: 'fail' });
  });
});

describe('machineVerdict', () => {
  const fact = (name: FactName, verdict: Fact['verdict']): Fact => ({ name, value: null, limit: null, verdict, note: null });

  it('is ok when every fact is ok', () => {
    expect(machineVerdict([fact('memory', 'ok'), fact('disk', 'ok')])).toBe('ok');
  });

  it('is unknown when a fact is unknown and none fails', () => {
    expect(machineVerdict([fact('memory', 'ok'), fact('disk', 'unknown')])).toBe('unknown');
  });

  it('is fail when a fact fails, also when another fact is unknown', () => {
    expect(machineVerdict([fact('memory', 'fail'), fact('disk', 'unknown'), fact('load', 'ok')])).toBe('fail');
  });
});

describe('machineWarnings (the warnings of worker new)', () => {
  it('gives no warning when every fact is ok', async () => {
    expect(machineWarnings(await gatherMachine(macMachine(), HOME, LIMITS))).toEqual([]);
    expect(machineWarnings(await gatherMachine(linuxMachine(), HOME, LIMITS))).toEqual([]);
  });

  it('gives one line for a failed limit, with the value and the limit', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const report = await gatherMachine(macMachine({}, limits), HOME, limits);
    expect(machineWarnings(report)).toEqual(['machine memory: 62% free, at least 80% needed']);
  });

  it('gives one line for an unknown fact, with the reason', async () => {
    const report = await gatherMachine(macMachine({ disk: missingProgram('df') }), HOME, LIMITS);
    expect(machineWarnings(report)).toEqual(['machine disk: unknown (no answer from df), at least 20 GB needed']);
  });

  it('gives a line for each fact that fails or is unknown, in the order of the facts', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const report = await gatherMachine(macMachine({ cpus: 'many\n' }, limits), HOME, limits);
    expect(machineWarnings(report).map((line) => line.split(':')[0])).toEqual([
      'machine memory',
      'machine load',
      'machine cpus',
    ]);
  });
});

describe('factText', () => {
  it('writes the value and the limit of each fact with its unit', async () => {
    const report = await gatherMachine(macMachine(), HOME, LIMITS);
    expect(report.map(factText)).toEqual([
      '62% free, at least 20% needed',
      '300 GB free, at least 20 GB needed',
      '2.2 in the last minute, at most 8 allowed',
      '8',
    ]);
  });
});

describe('factory machine', () => {
  const run = async (deps: FakeDeps, home: string | undefined = HOME) => {
    const result = await runMachine(deps, { home });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };

  it('prints the verdict on the first line, then one line for each fact', async () => {
    const output = await run(macMachine());
    expect(plainText(output)).toBe(
      [
        '[ok] Machine: ok (4 ok, 0 fail, 0 unknown)',
        '[ok] memory  62% free, at least 20% needed',
        '[ok] disk    300 GB free, at least 20 GB needed',
        '[ok] load    2.2 in the last minute, at most 8 allowed',
        '[ok] cpus    8',
        '',
      ].join('\n'),
    );
  });

  it('prints the same format for the Linux fixtures', async () => {
    const output = await run(linuxMachine());
    expect(plainText(output).split('\n')[0]).toBe('[ok] Machine: ok (4 ok, 0 fail, 0 unknown)');
    expect(output.lines.map((line) => line.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('marks a failed limit and an unknown fact on their own lines, and names the worst verdict first', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const output = await run(macMachine({ disk: missingProgram('df') }, limits));
    expect(plainText(output)).toBe(
      [
        '[FAIL] Machine: fail (2 ok, 1 fail, 1 unknown)',
        '[FAIL] memory  62% free, at least 80% needed',
        '[warn] disk    unknown (no answer from df), at least 20 GB needed',
        '[ok] load    2.2 in the last minute, at most 8 allowed',
        '[ok] cpus    8',
        '',
      ].join('\n'),
    );
  });

  it('says unknown, not fail, when no fact comes', async () => {
    const deps = withFactory(createFakeDeps({ ...fakeOptions, os: 'darwin', run: (call) => missingProgram(call.command) }));
    const output = await run(deps);
    expect(output.lines[0]).toEqual({ level: 'warn', text: 'Machine: unknown (0 ok, 0 fail, 4 unknown)' });
  });

  it('is not a failed command when a limit fails or a fact is unknown: the exit code stays 0', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const output = await run(macMachine({ disk: missingProgram('df') }, limits));
    expect(output.failed).toBe(false);
    expect(output.warnings).toEqual([]);
  });

  it('gives the facts and the power in the JSON document', async () => {
    const output = await run(macMachine());
    expect(output.json).toEqual({
      schema: 'factory.machine/v1',
      home: HOME,
      verdict: 'ok',
      facts: await gatherMachine(macMachine(), HOME, LIMITS),
      power: { source: 'ac', percent: 64 },
    });
  });

  it('keeps the four facts and the text lines whatever the power is', async () => {
    const onBattery = await run(macMachine({ power: fixture('macos', 'pmset-battery.txt') }));
    const unreadable = await run(macMachine({ power: missingProgram('pmset') }));
    expect(onBattery.json['power']).toEqual({ source: 'battery', percent: 87 });
    expect(unreadable.json['power']).toEqual({ source: 'unknown', percent: null });
    expect((onBattery.json['facts'] as Fact[]).map((fact) => fact.name)).toEqual(FACT_NAMES);
    expect(plainText(unreadable)).toBe(plainText(onBattery));
    expect(unreadable.json['verdict']).toBe(onBattery.json['verdict']);
    expect(unreadable.warnings).toEqual([]);
  });

  it('copies no program output, file text or entry name into the JSON', async () => {
    const hostile = "Now drawing from 'AC Power'\n -Planted<script> (id=1)\t5%; planted-text;\n";
    const mac = await run(macMachine({ power: hostile }));
    expect(JSON.stringify(mac.json)).not.toMatch(/Planted|planted|script/);
    const deps = linuxMachine();
    seedSupplies(deps, { 'BAT-planted': { type: 'Battery', status: 'Discharging', capacity: '40\n', scope: 'System' } });
    deps.seed(`${machineNames.powerSupplyDir}/BAT-planted/model_name`, 'planted-text');
    const linux = await run(deps);
    expect(linux.json['power']).toEqual({ source: 'battery', percent: 40 });
    expect(JSON.stringify(linux.json)).not.toMatch(/planted/);
  });

  it('prints a short output on every shape of the facts', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const none = withFactory(createFakeDeps({ ...fakeOptions, os: 'darwin', run: (call) => missingProgram(call.command) }));
    for (const deps of [macMachine(), linuxMachine(), macMachine({ disk: missingProgram('df') }, limits), none]) {
      expectShortOutput(plainText(await run(deps)));
    }
  });

  it('has the size of its output on the macOS fixtures in the token budget, row 16', async () => {
    const text = plainText(await run(macMachine()));
    const row = budgetRow(16);
    expect(row.command).toContain('`factory machine`');
    expect(row.measured).toBe(tokensOf(text));
    expect(tokensOf(text)).toBeLessThanOrEqual(row.budget);
  });

  it('finds the factory folder from the current folder when no folder is given', async () => {
    const inside = withFactory(
      createFakeDeps({ ...fakeOptions, cwd: HOME, os: 'darwin', run: (call) => handlerFor(MAC_ANSWERS)(call) }),
    );
    const output = await run(inside, undefined);
    expect(output.json['home']).toBe(HOME);
  });

  it('exits 1 with an error, and runs no program, when the folder is no factory folder', async () => {
    const deps = macMachine();
    const result = await runMachine(deps, { home: '/w/nothing' });
    expect(result.ok).toBe(false);
    expect(deps.calls).toEqual([]);
  });
});

describe('factory machine on the command line', () => {
  const runLine = async (argv: readonly string[], deps: FakeDeps) => {
    const sink = captureSink();
    const code = await runCli(argv, deps, sink);
    return { code, out: sink.out.join(''), err: sink.errors.join('') };
  };

  it('exits 0 when a limit fails', async () => {
    const limits: MachineLimits = { ...LIMITS, memory_free_min_pct: 80 };
    const result = await runLine(['machine', '--home', HOME], macMachine({}, limits));
    expect(result.code).toBe(0);
    expect(result.out.split('\n')[0]).toContain('Machine: fail');
    expect(result.err).toBe('');
  });

  it('prints one JSON document with --json', async () => {
    const result = await runLine(['machine', '--home', HOME, '--json'], linuxMachine());
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out) as { schema: string; verdict: string; facts: Fact[]; power: Power };
    expect(Object.keys(doc)).toEqual(['schema', 'home', 'verdict', 'facts', 'power']);
    expect(doc.schema).toBe('factory.machine/v1');
    expect(doc.verdict).toBe('ok');
    expect(doc.facts.map((fact) => fact.name)).toEqual(FACT_NAMES);
    expect(doc.power).toEqual({ source: 'unknown', percent: null });
  });

  it('exits 2 for an unknown flag, and runs no program', async () => {
    const deps = macMachine();
    const result = await runLine(['machine', '--nope'], deps);
    expect(result.code).toBe(2);
    expect(deps.calls).toEqual([]);
  });

  it('exits with a code other than 0 when the folder is no factory folder', async () => {
    const deps = macMachine();
    const result = await runLine(['machine', '--home', '/w/nothing'], deps);
    expect(result.code).not.toBe(0);
    expect(deps.calls).toEqual([]);
  });

  it('is in the help, with the home flag only', async () => {
    const result = await runLine(['machine', '--help'], macMachine());
    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: factory machine [--home DIR]');
  });
});

describe('readPower on macOS', () => {
  const UNKNOWN: Power = { source: 'unknown', percent: null };

  /** The calls to the programs, and the power that the reading gives when `pmset` answers `answer`. */
  const readWith = async (answer: Answer | undefined): Promise<{ readonly power: Power; readonly calls: readonly RunCall[] }> => {
    const calls: RunCall[] = [];
    const deps = createFakeDeps({
      os: 'darwin',
      run: (call) => {
        calls.push(call);
        return call.command === 'pmset' && answer !== undefined ? resultOf(answer) : missingProgram(call.command);
      },
    });
    return { power: await readPower(deps), calls };
  };

  it('reads AC power and the battery percent from the fixture', async () => {
    expect((await readWith(fixture('macos', 'pmset-ac.txt'))).power).toEqual({ source: 'ac', percent: 64 });
  });

  it('reads battery power and the battery percent from the fixture', async () => {
    expect((await readWith(fixture('macos', 'pmset-battery.txt'))).power).toEqual({ source: 'battery', percent: 87 });
  });

  it('gives AC power with no percent for a machine with no battery line', async () => {
    expect((await readWith("Now drawing from 'AC Power'\n")).power).toEqual({ source: 'ac', percent: null });
  });

  it('runs pmset with its two arguments and the time limit of the machine check', async () => {
    const { calls } = await readWith(fixture('macos', 'pmset-ac.txt'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'pmset', args: ['-g', 'batt'], timeoutMs: machineNames.callTimeoutMs });
  });

  const NOT_READ: readonly (readonly [string, Answer | undefined])[] = [
    ['garbled text', 'a very odd answer\n'],
    ['an empty answer', ''],
    ['a power source that is neither AC nor battery', "Now drawing from 'UPS Power'\n -UPS-0 (id=1)\t90%; charged;\n"],
    ['a first line with more text', "Now drawing from 'AC Power' and more\n"],
    ['a source line that is not the first line', "\nNow drawing from 'AC Power'\n"],
    ['an answer over the limit', `Now drawing from 'AC Power'\n${' '.repeat(machineNames.maxPowerOutputChars)}`],
    ['a non zero exit', exited(1, fixture('macos', 'pmset-battery.txt'))],
    ['a program that is missing', missingProgram('pmset')],
    ['a call that ends at the time limit', failure('cannot run pmset: it did not end in 5000 ms')],
  ];

  it.each(NOT_READ)('gives unknown with no percent for %s', async (_name, answer) => {
    expect((await readWith(answer)).power).toEqual(UNKNOWN);
  });

  it('reads an answer of exactly the limit', async () => {
    const first = "Now drawing from 'AC Power'\n";
    const answer = first + ' '.repeat(machineNames.maxPowerOutputChars - first.length);
    expect((await readWith(answer)).power).toEqual({ source: 'ac', percent: null });
  });

  const batteryAt = (percent: string): string => ` -InternalBattery-0 (id=1)\t${percent}; discharging; 1:00 remaining present: true`;
  const battery = (...lines: readonly string[]): string => ["Now drawing from 'Battery Power'", ...lines, ''].join('\n');

  it.each([
    ['0%', 0],
    ['100%', 100],
    ['101%', null],
    ['-1%', null],
    ['5.5%', null],
    ['%', null],
  ] as const)('reads the percent %s as %s', async (percent, expected) => {
    expect((await readWith(battery(batteryAt(percent)))).power).toEqual({ source: 'battery', percent: expected });
  });

  it('takes the percent of the first battery line, within the first eight lines after the source line', async () => {
    const filler = ' -Other-0';
    expect((await readWith(battery(batteryAt('40%'), batteryAt('90%')))).power.percent).toBe(40);
    expect((await readWith(battery(...Array<string>(7).fill(filler), batteryAt('33%')))).power.percent).toBe(33);
    expect((await readWith(battery(...Array<string>(8).fill(filler), batteryAt('33%')))).power.percent).toBeNull();
  });
});

describe('readPower on Linux', () => {
  const AC: Supply = { type: 'Mains', online: '1\n' };

  const powerOf = async (supplies: Readonly<Record<string, Supply>>): Promise<Power> => {
    const deps = createFakeDeps({ os: 'linux' });
    seedSupplies(deps, supplies);
    return readPower(deps);
  };

  it('gives AC power for a Mains supply that is online, with the capacity of the battery', async () => {
    expect(await powerOf({ AC0: AC, BAT0: { type: 'Battery\n', status: 'Charging\n', capacity: '80\n' } })).toEqual({
      source: 'ac',
      percent: 80,
    });
  });

  it('gives battery power for a System battery that is discharging, with its capacity', async () => {
    const supplies = { AC0: { type: 'Mains', online: '0' }, BAT0: { type: 'Battery', scope: 'System', status: 'Discharging', capacity: '55' } };
    expect(await powerOf(supplies)).toEqual({ source: 'battery', percent: 55 });
  });

  it('prefers a battery that is discharging to a supply that says online', async () => {
    const supplies = { AC0: AC, BAT0: { type: 'Battery', status: 'Discharging', capacity: '40' } };
    expect(await powerOf(supplies)).toEqual({ source: 'battery', percent: 40 });
  });

  it('gives AC power for a USB supply that is online', async () => {
    expect(await powerOf({ usb0: { type: 'USB', online: '1' } })).toEqual({ source: 'ac', percent: null });
  });

  it('gives an unknown source when no supply is online and no battery is discharging', async () => {
    const supplies = { AC0: { type: 'Mains', online: '0' }, BAT0: { type: 'Battery', status: 'Full', capacity: '100' } };
    expect(await powerOf(supplies)).toEqual({ source: 'unknown', percent: 100 });
  });

  it.each(['Device', 'Other'])('skips a battery with the scope %s', async (scope) => {
    const supplies = {
      AC0: AC,
      BAT0: { type: 'Battery', scope: 'System', status: 'Full', capacity: '100' },
      mouse0: { type: 'Battery', scope, status: 'Discharging', capacity: '10' },
    };
    expect(await powerOf(supplies)).toEqual({ source: 'ac', percent: 100 });
  });

  it.each(['101', '-1', '5.5', 'abc', '', '1e2', '0x10'])('gives no percent for the capacity %j, and keeps the source', async (capacity) => {
    const supplies = { BAT0: { type: 'Battery', status: 'Discharging', capacity } };
    expect(await powerOf(supplies)).toEqual({ source: 'battery', percent: null });
  });

  it.each([
    ['0', 0],
    ['100', 100],
  ])('reads the capacity %s', async (capacity, expected) => {
    expect((await powerOf({ BAT0: { type: 'Battery', status: 'Discharging', capacity } })).percent).toBe(expected);
  });

  it('reads a file as missing when it is larger than the limit of a file', async () => {
    const capacity = `5${' '.repeat(machineNames.maxPowerFileBytes)}`;
    expect(await powerOf({ BAT0: { type: 'Battery', status: 'Discharging', capacity } })).toEqual({ source: 'battery', percent: null });
  });

  it('gives unknown when the folder of the supplies is missing', async () => {
    expect(await readPower(createFakeDeps({ os: 'linux' }))).toEqual({ source: 'unknown', percent: null });
  });

  it('skips an entry whose name is not plain, and reads no file of it', async () => {
    const touched: string[] = [];
    const base = createFakeDeps({ os: 'linux' });
    const names = ['bad name', 'semi;colon', 'x'.repeat(65), 'AC0'];
    seedSupplies(base, Object.fromEntries(names.map((name) => [name, AC])));
    const power = await readPower(withFsWatch(base, (_method, path) => touched.push(path)));
    expect(power).toEqual({ source: 'ac', percent: null });
    expect(touched.filter((path) => path.includes('/bad name/') || path.includes('semi;') || path.includes('xxxxxxxx'))).toEqual([]);
    const withoutPlain = createFakeDeps({ os: 'linux' });
    seedSupplies(withoutPlain, Object.fromEntries(names.slice(0, 3).map((name) => [name, AC])));
    expect(await readPower(withoutPlain)).toEqual({ source: 'unknown', percent: null });
  });

  it('skips the entries . and .. and reads no file of them', async () => {
    const touched: string[] = [];
    const base = createFakeDeps({ os: 'linux' });
    const root = machineNames.powerSupplyDir;
    base.seed(`${root}/../type`, 'Mains');
    base.seed(`${root}/../online`, '1');
    base.seed(`${root}/./type`, 'Mains');
    base.seed(`${root}/./online`, '1');
    const listing = { ...base, fs: { ...base.fs, listLimited: async () => ok(['.', '..']) } };
    expect(await readPower(withFsWatch(listing, (_method, path) => touched.push(path)))).toEqual({ source: 'unknown', percent: null });
    expect(touched.filter((path) => path.startsWith(`${root}/.`))).toEqual([]);
  });

  it('reads no entry past the cap of supplies', async () => {
    const touched: string[] = [];
    const base = createFakeDeps({ os: 'linux' });
    const cap = machineNames.maxPowerSupplies;
    const batteries = Object.fromEntries(
      Array.from({ length: cap }, (_unused, index) => [`BAT${String(index).padStart(2, '0')}`, { type: 'Battery', status: 'Full', capacity: '50' }]),
    );
    seedSupplies(base, { ...batteries, 'ZZ-mains': AC });
    const power = await readPower(withFsWatch(base, (_method, path) => touched.push(path)));
    expect(power).toEqual({ source: 'unknown', percent: 50 });
    expect(touched.filter((path) => path.includes('ZZ-mains'))).toEqual([]);
    expect(touched.filter((path) => path.includes(`BAT${cap - 1}/`))).not.toEqual([]);
  });
});

describe('readPower on another system', () => {
  it.each(['win32', 'freebsd'])('gives unknown with no percent on %s, and runs and reads nothing', async (os) => {
    const seen: string[] = [];
    const base = createFakeDeps({
      os,
      run: (call) => {
        seen.push(call.command);
        return exited(0, fixture('macos', 'pmset-ac.txt'));
      },
    });
    seedSupplies(base, { AC0: { type: 'Mains', online: '1' } });
    const power = await readPower(withFsWatch(base, (method, path) => seen.push(`${method} ${path}`)));
    expect(power).toEqual({ source: 'unknown', percent: null });
    expect(seen).toEqual([]);
  });
});
