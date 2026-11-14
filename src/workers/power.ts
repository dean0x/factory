import type { Deps } from '../core/deps.js';
import { machineNames, powerSources } from '../names.js';

/**
 * The power of the machine: the source of the power (the mains or the battery) and the charge of the battery. Only
 * `factory machine --json` reads it. It is no fact of the machine check: it has no limit and no verdict, and it never changes
 * the result of `worker new`. Each reading is bounded, and an answer that does not parse gives `unknown` with no percent. The
 * result holds a source word and a number only: no program output, file text or entry name goes into it.
 */

const {
  callTimeoutMs,
  maxPowerFileBytes,
  maxPowerOutputChars,
  maxPowerSupplies,
  pmsetArgs,
  powerSupplyDir,
  programs,
  supplyFiles,
  supplyWords,
  systems,
} = machineNames;

export type PowerSource = (typeof powerSources)[keyof typeof powerSources];

export interface Power {
  readonly source: PowerSource;
  /** The charge of the battery, a whole number from 0 to 100, or null when the machine gives none. */
  readonly percent: number | null;
}

const UNKNOWN: Power = { source: powerSources.unknown, percent: null };

/** A whole percent from 0 to 100. It has no sign, no decimal part and no leading zero. */
const PERCENT = '(100|[1-9]?\\d)';

const MAC_SOURCE_LINE = /^Now drawing from '(AC Power|Battery Power)'$/;
const MAC_AC_POWER = 'AC Power';
const MAC_BATTERY_LINE = new RegExp(`^[ \\t]*-[A-Za-z0-9_.-]{1,64}[ \\t]+\\(id=\\d{1,12}\\)[ \\t]+${PERCENT}%;`);
/** The most lines after the source line that the reading looks at for the battery. */
const MAC_BATTERY_LINES = 8;

/**
 * The power of the `pmset -g batt` output of macOS. The first line names the source. The percent comes from the first of the
 * next lines that has the form of a battery line. A machine with no battery has no such line, and the percent is null.
 */
export const parsePmset = (text: string): Power => {
  if (text.length > maxPowerOutputChars) return UNKNOWN;
  const [first = '', ...rest] = text.split(/\r?\n/);
  const source = MAC_SOURCE_LINE.exec(first);
  if (source === null) return UNKNOWN;
  const battery = rest
    .slice(0, MAC_BATTERY_LINES)
    .map((line) => MAC_BATTERY_LINE.exec(line))
    .find((match) => match !== null);
  const digits = battery?.[1];
  return {
    source: source[1] === MAC_AC_POWER ? powerSources.ac : powerSources.battery,
    percent: digits === undefined ? null : Number(digits),
  };
};

const readMacPower = async (deps: Deps): Promise<Power> => {
  const ran = await deps.run(programs.pmset, pmsetArgs, { timeoutMs: callTimeoutMs });
  return !ran.ok || ran.value.exitCode !== 0 ? UNKNOWN : parsePmset(ran.value.stdout);
};

/** The names of the entries that the reading follows: plain names only, so that a name can not leave the folder of the supplies. */
const PLAIN_ENTRY = /^[A-Za-z0-9_.-]{1,64}$/;
const WHOLE_PERCENT = new RegExp(`^${PERCENT}$`);
const ONLINE = '1';

/** The words of the files of one power supply. A file that is missing, too large or not readable gives null. */
interface Supply {
  readonly type: string | null;
  readonly scope: string | null;
  readonly online: string | null;
  readonly status: string | null;
  readonly capacity: string | null;
}

const isPlainEntry = (name: string): boolean => name !== '.' && name !== '..' && PLAIN_ENTRY.test(name);

const readWord = async (deps: Deps, entry: string, file: string): Promise<string | null> => {
  const text = await deps.fs.readTextLimited(`${powerSupplyDir}/${entry}/${file}`, maxPowerFileBytes);
  return text.ok ? text.value.trim() : null;
};

const readSupply = async (deps: Deps, entry: string): Promise<Supply> => {
  const [type, scope, online, status, capacity] = await Promise.all([
    readWord(deps, entry, supplyFiles.type),
    readWord(deps, entry, supplyFiles.scope),
    readWord(deps, entry, supplyFiles.online),
    readWord(deps, entry, supplyFiles.status),
    readWord(deps, entry, supplyFiles.capacity),
  ]);
  return { type, scope, online, status, capacity };
};

/** At most `maxPowerSupplies` entries are listed, and only the plain names are read. The names are sorted, so the first battery is the same on each run. */
const readSupplies = async (deps: Deps): Promise<readonly Supply[]> => {
  const listed = await deps.fs.listLimited(powerSupplyDir, maxPowerSupplies);
  if (!listed.ok) return [];
  return Promise.all(
    listed.value
      .filter(isPlainEntry)
      .sort()
      .map((entry) => readSupply(deps, entry)),
  );
};

/** A supply of the machine has the scope System, or the kernel names no scope. A supply of a device (a mouse, a phone) or of a scope that is not known is left out. */
const isOfMachine = (supply: Supply): boolean => supply.scope === null || supply.scope === supplyWords.system;

const sourceOf = (supplies: readonly Supply[]): PowerSource => {
  if (supplies.some((supply) => supply.type === supplyWords.battery && supply.status === supplyWords.discharging)) {
    return powerSources.battery;
  }
  const online = supplies.some(
    (supply) => (supply.type === supplyWords.mains || supply.type === supplyWords.usb) && supply.online === ONLINE,
  );
  return online ? powerSources.ac : powerSources.unknown;
};

const percentOf = (capacity: string | null | undefined): number | null =>
  capacity === null || capacity === undefined || !WHOLE_PERCENT.test(capacity) ? null : Number(capacity);

const readLinuxPower = async (deps: Deps): Promise<Power> => {
  const supplies = (await readSupplies(deps)).filter(isOfMachine);
  const battery = supplies.find((supply) => supply.type === supplyWords.battery);
  return { source: sourceOf(supplies), percent: percentOf(battery?.capacity) };
};

/**
 * Read the power of this machine. The call never fails: a program that does not run, ends late, exits with an error or prints
 * text that does not parse gives `unknown`, and so does a system that is not macOS or Linux.
 */
export const readPower = async (deps: Deps): Promise<Power> => {
  if (deps.platform.os === systems.macos) return readMacPower(deps);
  return deps.platform.os === systems.linux ? readLinuxPower(deps) : UNKNOWN;
};
