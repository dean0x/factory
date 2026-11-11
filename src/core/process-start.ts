import { processStart } from '../names.js';
import type { Deps } from './deps.js';
import { err, ok, type Result } from './result.js';
import { toolNames } from './tools.js';

/**
 * The start time of one process, for the token lock. The start of a process is a point in time that `ps` prints with 1 s
 * resolution, so a slow `ps` call does not move it, and this module never reads the clock. The pane check in the workers reads the
 * elapsed time instead (`paneProcessStart`) and keeps its own code.
 */

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
 * When the process with this pid started, in milliseconds since the epoch. The call runs `ps` with the default environment, so the
 * locale is C. A pid that is not a positive whole number, a `ps` that fails or runs past the limit, empty output (the process is gone)
 * and any text that is not the one form of the answer are an error. The text of the output is never repeated.
 */
export const processStartOf = async (deps: Deps, pid: number): Promise<Result<number, string>> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return err(`cannot read the start of the process ${String(pid)}: it is not a pid`);
  const ran = await deps.run(toolNames.ps, ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: processStart.timeoutMs });
  if (!ran.ok) return err(ran.error.message);
  if (ran.value.exitCode !== 0) return err(`cannot read the start of the process ${pid}: ps ended with code ${ran.value.exitCode}`);
  const start = startMsOfLstart(ran.value.stdout);
  return start === null ? err(`cannot read the start of the process ${pid}: ps gave text of another form`) : ok(start);
};
