import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { commands, keys, machineNames, values } from '../names.js';

/**
 * The facts of the machine (design 4.2): the free memory, the free disk of the factory folder, the load and the count of
 * processors. Each fact has one format, a value, a limit and a verdict. A fact that does not come, or does not parse, is
 * `unknown`: it is never a guess and never an error. The system that runs the check (macOS or Linux) is the only part that
 * differs: it picks the program or the file that gives each fact. `worker new` and `factory machine` both read the report.
 */

const { facts: factNames, programs, procFiles, sysctlNames, systems } = machineNames;

export type FactName = (typeof machineNames.facts)[keyof typeof machineNames.facts];
export type FactVerdict = 'ok' | 'fail' | 'unknown';

/** The limits of the config. The check reads the memory, the disk and the load limits. */
export type MachineLimits = FactoryConfig['core'][typeof keys.root.limits];

export interface Fact {
  readonly name: FactName;
  /** The value of the fact, rounded as it is shown, or null when it did not come. */
  readonly value: number | null;
  /** The limit that the value is compared with, or null when the fact has no limit or the limit is not known. */
  readonly limit: number | null;
  readonly verdict: FactVerdict;
  /** Why the verdict is unknown. Null for ok and fail. */
  readonly note: string | null;
}

/** Every fact, in the order of `machineNames.facts`. */
export type MachineReport = readonly Fact[];

type Reading = Result<number, string>;

const roundTo = (digits: number) => (value: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const round1 = roundTo(1);
const round2 = roundTo(2);

const DECIMAL = '\\d+(?:\\.\\d+)?';
const DECIMAL_TOKEN = new RegExp(`^${DECIMAL}$`);
const COUNT_TEXT = /^\d{1,4}$/;
const BLOCKS_TOKEN = /^\d+$/;
const CAPACITY_TOKEN = /^\d{1,3}%$/;
const MAC_FREE_PERCENT = /^System-wide memory free percentage:[ \t]*(\d{1,3})%[ \t]*$/m;
const MAC_LOAD = new RegExp(`^\\{[ \\t]*(${DECIMAL})[ \\t]+${DECIMAL}[ \\t]+${DECIMAL}[ \\t]*\\}$`);
const MEMINFO_TOTAL = /^MemTotal:[ \t]*(\d{1,15})[ \t]*kB[ \t]*$/m;
const MEMINFO_AVAILABLE = /^MemAvailable:[ \t]*(\d{1,15})[ \t]*kB[ \t]*$/m;

/** The first index that the capacity column of a df line can have: the file system, the blocks, the used and the available column come before it. */
const DF_FIRST_CAPACITY_INDEX = 4;

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** The free percent that `memory_pressure` prints on macOS, a whole number from 0 to 100. */
export const parseMemoryPressure = (text: string): number | null => {
  const match = MAC_FREE_PERCENT.exec(text);
  if (match === null) return null;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : null;
};

/** The free percent of `/proc/meminfo`: MemAvailable of MemTotal, in one decimal. A kernel with no MemAvailable gives null. */
export const parseMeminfo = (text: string): number | null => {
  const total = MEMINFO_TOTAL.exec(text);
  const available = MEMINFO_AVAILABLE.exec(text);
  if (total === null || available === null) return null;
  const totalKib = Number(total[1]);
  const availableKib = Number(available[1]);
  return totalKib > 0 && availableKib <= totalKib ? round1((availableKib / totalKib) * 100) : null;
};

/**
 * The free GB of the one data line of `df -Pk`, in one decimal. The columns are counted from the capacity column, because
 * the name of a file system or a mount point can hold spaces.
 */
export const parseDfFreeGb = (text: string): number | null => {
  const line = text
    .split('\n')
    .slice(1)
    .find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const tokens = line.trim().split(/\s+/);
  const capacity = tokens.findIndex((token, index) => index >= DF_FIRST_CAPACITY_INDEX && CAPACITY_TOKEN.test(token));
  if (capacity < 0) return null;
  const [blocks, used, available] = tokens.slice(capacity - 3, capacity);
  if (![blocks, used, available].every((token) => token !== undefined && BLOCKS_TOKEN.test(token))) return null;
  const availableKib = Number(available);
  return Number.isSafeInteger(availableKib) ? round1(availableKib / machineNames.kibPerGb) : null;
};

/** The one-minute load of `sysctl -n vm.loadavg` on macOS, for example `{ 2.20 2.35 2.86 }`, in two decimals. */
export const parseMacLoad = (text: string): number | null => {
  const match = MAC_LOAD.exec(text.trim());
  const load = match === null ? null : finite(Number(match[1]));
  return load === null ? null : round2(load);
};

/** The one-minute load of `/proc/loadavg`, for example `0.52 0.58 0.59 1/467 12345`, in two decimals. */
export const parseProcLoad = (text: string): number | null => {
  const tokens = text.trim().split(/\s+/);
  const load = tokens.length >= 3 && tokens.slice(0, 3).every((token) => DECIMAL_TOKEN.test(token)) ? finite(Number(tokens[0])) : null;
  return load === null ? null : round2(load);
};

/** The count of processors that `sysctl -n hw.ncpu` and `nproc` print: a whole number from 1 to the cap. */
export const parseCount = (text: string): number | null => {
  const trimmed = text.trim();
  if (!COUNT_TEXT.test(trimmed)) return null;
  const count = Number(trimmed);
  return count >= 1 && count <= machineNames.maxCpus ? count : null;
};

const programReading = async (
  deps: Deps,
  program: string,
  args: readonly string[],
  parse: (text: string) => number | null,
): Promise<Reading> => {
  const ran = await deps.run(program, args, { timeoutMs: machineNames.callTimeoutMs });
  if (!ran.ok || ran.value.exitCode !== 0) return err(`no answer from ${program}`);
  const value = parse(ran.value.stdout);
  return value === null ? err(`cannot read the output of ${program}`) : ok(value);
};

const fileReading = async (deps: Deps, path: string, parse: (text: string) => number | null): Promise<Reading> => {
  const text = await deps.fs.readTextLimited(path, machineNames.maxFileBytes);
  if (!text.ok) return err(`cannot read ${path}`);
  const value = parse(text.value);
  return value === null ? err(`cannot read the content of ${path}`) : ok(value);
};

/** Where each fact that depends on the system comes from. The disk is the same on both systems. */
interface Sources {
  memory(deps: Deps): Promise<Reading>;
  load(deps: Deps): Promise<Reading>;
  cpus(deps: Deps): Promise<Reading>;
}

const MACOS_SOURCES: Sources = {
  memory: (deps) => programReading(deps, programs.memoryPressure, [], parseMemoryPressure),
  load: (deps) => programReading(deps, programs.sysctl, ['-n', sysctlNames.load], parseMacLoad),
  cpus: (deps) => programReading(deps, programs.sysctl, ['-n', sysctlNames.cpus], parseCount),
};

const LINUX_SOURCES: Sources = {
  memory: (deps) => fileReading(deps, procFiles.memory, parseMeminfo),
  load: (deps) => fileReading(deps, procFiles.load, parseProcLoad),
  cpus: (deps) => programReading(deps, programs.nproc, [], parseCount),
};

const sourcesOf = (os: string): Sources | null => {
  if (os === systems.macos) return MACOS_SOURCES;
  return os === systems.linux ? LINUX_SOURCES : null;
};

const UNSUPPORTED_SYSTEM = 'the system is not macOS or Linux';
const UNKNOWN_CPUS = 'the CPU count is unknown';

/** The verdict of one fact: a value at least a minimum, or at most a maximum. A value or a limit that is missing is unknown. */
const judge = (name: FactName, reading: Reading, limit: Reading, atLeast: boolean): Fact => {
  const limitValue = limit.ok ? limit.value : null;
  if (!reading.ok) return { name, value: null, limit: limitValue, verdict: 'unknown', note: reading.error };
  if (!limit.ok) return { name, value: reading.value, limit: null, verdict: 'unknown', note: limit.error };
  const passes = atLeast ? reading.value >= limit.value : reading.value <= limit.value;
  return { name, value: reading.value, limit: limit.value, verdict: passes ? 'ok' : 'fail', note: null };
};

const countFact = (reading: Reading): Fact =>
  reading.ok
    ? { name: factNames.cpus, value: reading.value, limit: null, verdict: 'ok', note: null }
    : { name: factNames.cpus, value: null, limit: null, verdict: 'unknown', note: reading.error };

/** The load limit: a number from the config, or the count of processors for `cpu_count`. */
const loadLimitOf = (setting: MachineLimits[typeof keys.limits.loadMax], cpus: Reading): Reading => {
  if (setting !== values.loadCpuCount) return ok(setting);
  return cpus.ok ? cpus : err(UNKNOWN_CPUS);
};

/**
 * Read the four facts of this machine and judge them against the limits. Each program has a time limit. The call never
 * fails: a program that does not run, is too slow or prints text that does not parse gives an unknown fact. `home` is the
 * factory folder, and the disk fact is the free space of its file system.
 */
export const gatherMachine = async (deps: Deps, home: string, limits: MachineLimits): Promise<MachineReport> => {
  const sources = sourcesOf(deps.platform.os);
  const unsupported: Reading = err(UNSUPPORTED_SYSTEM);
  const [memory, disk, load, cpus]: readonly [Reading, Reading, Reading, Reading] =
    sources === null
      ? [unsupported, unsupported, unsupported, unsupported]
      : await Promise.all([
          sources.memory(deps),
          programReading(deps, programs.df, ['-Pk', '--', home], parseDfFreeGb),
          sources.load(deps),
          sources.cpus(deps),
        ]);
  return [
    judge(factNames.memory, memory, ok(limits[keys.limits.memoryFreeMinPct]), true),
    judge(factNames.disk, disk, ok(limits[keys.limits.diskFreeMinGb]), true),
    judge(factNames.load, load, loadLimitOf(limits[keys.limits.loadMax], cpus), false),
    countFact(cpus),
  ];
};

/** The worst verdict of the report: a failed limit, then an unknown fact, then ok. */
export const machineVerdict = (report: MachineReport): FactVerdict => {
  if (report.some((fact) => fact.verdict === 'fail')) return 'fail';
  return report.some((fact) => fact.verdict === 'unknown') ? 'unknown' : 'ok';
};

interface Shape {
  readonly value: (amount: number) => string;
  /** Null for a fact that has no limit. */
  readonly limit: ((amount: number) => string) | null;
}

const SHAPES: Readonly<Record<FactName, Shape>> = {
  [factNames.memory]: { value: (n) => `${n}% free`, limit: (n) => `at least ${n}% needed` },
  [factNames.disk]: { value: (n) => `${n} GB free`, limit: (n) => `at least ${n} GB needed` },
  [factNames.load]: { value: (n) => `${n} in the last minute`, limit: (n) => `at most ${n} allowed` },
  [factNames.cpus]: { value: (n) => `${n}`, limit: null },
};

/** The value and the limit of one fact as short text, or the reason that the fact is unknown. */
export const factText = (fact: Fact): string => {
  const shape = SHAPES[fact.name];
  const unknown = `unknown (${fact.note ?? 'no reason'})`;
  const value = fact.value === null ? unknown : shape.value(fact.value);
  if (shape.limit === null) return value;
  if (fact.limit !== null) return `${value}, ${shape.limit(fact.limit)}`;
  return fact.value === null ? value : `${value}, ${unknown}`;
};

/** One warning line for each fact that fails its limit or is unknown. A report with only ok facts gives none. */
export const machineWarnings = (report: MachineReport): readonly string[] =>
  report.filter((fact) => fact.verdict !== 'ok').map((fact) => `${commands.machine} ${fact.name}: ${factText(fact)}`);
