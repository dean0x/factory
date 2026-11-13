import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * The pids that a test may signal. A test starts a child as the leader of its own process group, the child writes its pid in a ready
 * file, and the clean-up of the test sends KILL to that group. The pid 0 would name the group of the test runner, the pid 1 is init,
 * and a negative pid names another group. So only a pid from the ready file of a child of the test passes, and only after this check.
 */
const MAX_PID = 2_147_483_647;
const READY_TRIES = 250;
const READY_STEP_MS = 20;

/** True for a whole number from 2 up to the largest pid, other than the pid of the test runner itself. */
export const isOwnChildPid = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 1 && pid <= MAX_PID && pid !== process.pid;

/** The pid in the text of a ready file. Any other text (an empty file gives 0 with `Number`) throws, so the test fails. */
export const pidOfReadyText = (text: string): number => {
  const digits = text.trim();
  const pid = /^[0-9]{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
  if (!isOwnChildPid(pid)) throw new Error(`the ready file has no usable pid: ${JSON.stringify(text)}`);
  return pid;
};

/** Wait at most `tries` times 20 ms (5 s by default) for the file to hold text. The text is empty when it does not. */
export const textWhenThere = async (path: string, tries: number = READY_TRIES): Promise<string> => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (text !== '') return text;
    await wait(READY_STEP_MS);
  }
  return '';
};

/** Read the pid of a child from its ready file and keep it for the clean-up. A missing or bad file fails the test and keeps nothing. */
export const readyPid = async (kept: number[], path: string, tries?: number): Promise<number> => {
  const pid = pidOfReadyText(await textWhenThere(path, tries));
  kept.push(pid);
  return pid;
};

/** Send KILL to the group of each kept pid that passes the check, and empty the list. A group that has ended is no error. */
export const killKeptGroups = (kept: number[]): void => {
  for (const pid of kept.splice(0)) {
    if (!isOwnChildPid(pid)) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group has ended already.
    }
  }
};
