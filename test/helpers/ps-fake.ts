import { exited, type RunHandler } from './fake-deps.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The text that `ps -o lstart=` prints for a start in whole seconds: local time, the day padded with a space. */
export const lstartText = (ms: number): string => {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, '0');
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
  return `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${clock} ${date.getFullYear()}\n`;
};

/** A fake `ps` that knows the start of each pid in `starts`. A pid that is not there makes `ps` fail, as for a process that is gone. */
export const psStarts =
  (starts: Readonly<Record<number, number>>): RunHandler =>
  (call) => {
    const start = starts[Number(call.args[3])];
    return start === undefined ? exited(1) : exited(0, lstartText(start));
  };
