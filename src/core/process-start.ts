import { processStart } from '../names.js';
import type { Deps } from './deps.js';
import { err, ok, type Result } from './result.js';
import { toolNames } from './tools.js';

/**
 * The start of one process, for the token lock. The value is only compared with another value of this same function on this machine,
 * never with the clock and never with a value from another machine. What it means depends on the platform:
 * - On Linux it is the time since boot of the machine. The kernel counts it in clock ticks, so a step of the wall clock (a time
 *   service, a resume of a virtual machine) does not move the start of a process that runs.
 * - On macOS and any other platform it is a point in time in milliseconds since the epoch, from `ps -o lstart=`. `ps` prints it with
 *   1 s resolution, so a slow `ps` call does not move it.
 * This module never reads the clock. The pane check in the workers reads the elapsed time instead (`paneProcessStart`) and keeps its
 * own code.
 */

/**
 * The clock ticks in one second of the start field of a Linux stat file. The kernel gives this field in ticks of USER_HZ, which is
 * 100 on every Linux platform (proc(5) and sysconf(_SC_CLK_TCK)), so the tolerance of the lock keeps its meaning in milliseconds.
 */
const USER_HZ = 100;

/** The milliseconds in one clock tick: 10, a whole number, so a start in ticks gives a whole number of milliseconds. */
const MS_PER_TICK = 1000 / USER_HZ;

/** The most bytes of a stat file that the call reads. A real stat file has far fewer, so a larger file is no stat file. */
const MAX_STAT_BYTES = 4096;

/** The field of a Linux stat file with the start, counted from 1. The fields 1 and 2 are the pid and the command name in parentheses. */
const STAT_START_FIELD = 22;

/** The number of the first field after the command name: the state of the process. */
const FIRST_FIELD_AFTER_NAME = 3;

/** One field of the start in a stat file: digits only. */
const TICKS_TEXT = /^[0-9]+$/;

/** The milliseconds since the epoch for the text that `ps -o lstart=` prints, or null for text of any other form or a time that does not exist. */
export const startMsOfLstart = (text: string): number | null => {
  const match = processStart.lstart.exec(text);
  if (match === null) return null;
  const [, monthName = '', dayText = '', hourText = '', minuteText = '', secondText = '', yearText = ''] = match;
  const month = processStart.months.findIndex((name) => name === monthName);
  const [day, hour, minute, second, year] = [dayText, hourText, minuteText, secondText, yearText].map(Number);
  if (month < 0 || day === undefined || hour === undefined || minute === undefined || second === undefined || year === undefined) return null;
  const date = new Date(year, month, day, hour, minute, second);
  // A part out of range rolls over into the next part (the 30th of February becomes March), so each part must come back as it went in.
  const sameParts =
    date.getFullYear() === year &&
    date.getMonth() === month &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second;
  const ms = date.getTime();
  return sameParts && ms >= 0 ? ms : null;
};

/**
 * The milliseconds since boot for the text of a Linux stat file, or null for text of any other form. The command name in field 2 can
 * hold spaces and parentheses, so the fields are counted from the text after the last closing parenthesis.
 */
export const startMsOfStat = (text: string): number | null => {
  const nameEnd = text.lastIndexOf(')');
  if (nameEnd < 0) return null;
  const ticksText = text
    .slice(nameEnd + 1)
    .trim()
    .split(/\s+/)[STAT_START_FIELD - FIRST_FIELD_AFTER_NAME];
  if (ticksText === undefined || !TICKS_TEXT.test(ticksText)) return null;
  const ms = Number(ticksText) * MS_PER_TICK;
  return Number.isSafeInteger(ms) ? ms : null;
};

const unreadable = (pid: number, reason: string): string => `cannot read the start of the process ${pid}: ${reason}`;

const startFromPs = async (deps: Deps, pid: number): Promise<Result<number, string>> => {
  const ran = await deps.run(toolNames.ps, ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: processStart.timeoutMs });
  if (!ran.ok) return err(ran.error.message);
  if (ran.value.exitCode !== 0) return err(unreadable(pid, `ps ended with code ${ran.value.exitCode}`));
  const start = startMsOfLstart(ran.value.stdout);
  return start === null ? err(unreadable(pid, 'ps gave text of another form')) : ok(start);
};

const startFromStat = async (deps: Deps, pid: number): Promise<Result<number, string>> => {
  const read = await deps.fs.readTextLimited(`/proc/${pid}/stat`, MAX_STAT_BYTES);
  if (!read.ok) return err(read.error.message);
  const start = startMsOfStat(read.value);
  return start === null ? err(unreadable(pid, 'the stat file has text of another form')) : ok(start);
};

/**
 * When the process with this pid started, in milliseconds (see the header of this file for what the value means on each platform).
 * On Linux the call reads the stat file of the process. On any other platform it runs `ps` with the default environment, so the locale
 * is C. A pid that is not a positive whole number, a read that fails or a `ps` that runs past the limit, a process that is gone, and any
 * text that is not the one form of the answer are an error. The text of the file or of the output is never repeated.
 */
export const processStartOf = async (deps: Deps, pid: number): Promise<Result<number, string>> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return err(unreadable(pid, 'it is not a pid'));
  return deps.platform.os === 'linux' ? startFromStat(deps, pid) : startFromPs(deps, pid);
};
