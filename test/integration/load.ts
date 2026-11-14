import { availableParallelism, loadavg } from 'node:os';

/**
 * The fixed waits and time limits of the integration tests fit a machine with little load. On a loaded machine, set this variable
 * to a number of at least 1. Each wait and each time limit of a test is then that many times longer. The default is 1.
 */
export const WAIT_FACTOR_VARIABLE = 'FACTORY_TEST_WAIT_FACTOR';

/** The factor from the environment. A value that is not a number of at least 1 stops the run with a clear message. */
const factorFrom = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return 1;
  const factor = Number(raw);
  if (!Number.isFinite(factor) || factor < 1) {
    throw new Error(`${WAIT_FACTOR_VARIABLE} must be a number of at least 1, not "${raw}"`);
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
