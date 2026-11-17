import { availableParallelism, loadavg } from 'node:os';

/**
 * The fixed waits and time limits of the integration tests fit a machine with little load. On a loaded machine, set this variable
 * to a number from 1 to `MAX_WAIT_FACTOR`. The waits for a launch, a file, a screen or the end of a process, the limits of a
 * child process, and the time limits of the tests and hooks are then that many times longer. The default is 1.
 */
export const WAIT_FACTOR_VARIABLE = 'FACTORY_TEST_WAIT_FACTOR';

/** The largest factor. A much larger factor would make a time limit pass the largest delay of a Node timer. */
const MAX_WAIT_FACTOR = 100;

/** The factor from the environment. A value that is not a number from 1 to `MAX_WAIT_FACTOR` stops the run with a clear message. */
const factorFrom = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor < 1 || factor > MAX_WAIT_FACTOR) {
    throw new Error(`${WAIT_FACTOR_VARIABLE} must be a number from 1 to ${MAX_WAIT_FACTOR}, not "${raw}"`);
  }
  return factor;
};

export const WAIT_FACTOR = factorFrom(process.env[WAIT_FACTOR_VARIABLE]);

/** A fixed wait, a step count of a wait, or a time limit of a test, made longer by the wait factor. */
export const scaled = (amount: number): number => Math.ceil(amount * WAIT_FACTOR);

/** The load of the machine, for the message of a wait that ran out. It also says how to make the waits longer. */
export const loadNote = (): string => {
  const [oneMinute = 0] = loadavg();
  return (
    `(load average ${oneMinute.toFixed(2)} on ${availableParallelism()} CPUs, wait factor ${WAIT_FACTOR}; ` +
    `on a loaded machine, set ${WAIT_FACTOR_VARIABLE} to a larger number)`
  );
};
