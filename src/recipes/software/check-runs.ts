import { z } from 'zod';

/**
 * The objects strip the keys that the classifier does not read, such as the name, link or login of a check.
 * An unknown value of an enum fails the parse. An empty or null conclusion means no conclusion yet.
 */
const checkRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  status: z.enum(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED']),
  conclusion: z
    .enum(['', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
    .nullable(),
});

const statusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  state: z.enum(['EXPECTED', 'PENDING', 'SUCCESS', 'FAILURE', 'ERROR']),
});

export const checkSchema = z.discriminatedUnion('__typename', [checkRunSchema, statusContextSchema]);

type Check = z.infer<typeof checkSchema>;

const PASSED_VALUES: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_VALUES: ReadonlySet<string> = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR']);

type CheckClass = 'passed' | 'failed' | 'pending';

export interface Counts {
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
}

/** A passed value is SUCCESS, NEUTRAL or SKIPPED, as GitHub counts them for a required check. A failed value is listed. Any other value is pending. */
const classOfValue = (value: string | null): CheckClass => {
  if (value !== null && PASSED_VALUES.has(value)) return 'passed';
  if (value !== null && FAILED_VALUES.has(value)) return 'failed';
  return 'pending';
};

/** A check run counts by its conclusion once it is completed. Before that it is pending. */
const classOf = (check: Check): CheckClass => {
  if (check.__typename === 'StatusContext') return classOfValue(check.state);
  return check.status === 'COMPLETED' ? classOfValue(check.conclusion) : 'pending';
};

export const countsOf = (checks: readonly Check[]): Counts =>
  checks.reduce<Counts>(
    (counts, check) => {
      const kind = classOf(check);
      return { ...counts, [kind]: counts[kind] + 1 };
    },
    { passed: 0, failed: 0, pending: 0 },
  );

export const totalOf = (counts: Counts): number => counts.passed + counts.failed + counts.pending;
