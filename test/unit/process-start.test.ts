import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { processStartOf, startMsOfLstart } from '../../src/core/process-start.js';
import { createFakeDeps, exited, missingProgram, type RunHandler } from '../helpers/fake-deps.js';

/** The time of 2026-11-11 11:06:58 in the zone of the machine: `ps` prints the start in local time. */
const LOCAL_START_MS = new Date(2026, 10, 11, 11, 6, 58).getTime();

const withPs = (run: RunHandler) => createFakeDeps({ run });

describe('process start: the parse of the lstart text', () => {
  it('gives the local time of the text in milliseconds', () => {
    expect(startMsOfLstart('Wed Nov 11 11:06:58 2026\n')).toBe(LOCAL_START_MS);
  });

  it('accepts a day with a leading space and the spaces that ps puts after the text', () => {
    expect(startMsOfLstart('Wed Nov  4 09:05:03 2026    \n')).toBe(new Date(2026, 10, 4, 9, 5, 3).getTime());
  });

  it.each([
    ['empty text', ''],
    ['a text of another form', 'Nov 11 2026 11:06:58'],
    ['the elapsed time of the etime read', '01:02:03'],
    ['a month that does not exist', 'Wed Foo 11 11:06:58 2026'],
    ['a day that the month does not have', 'Mon Feb 30 11:06:58 2026'],
    ['an hour of 24 or more', 'Wed Nov 11 24:06:58 2026'],
    ['a time before the epoch', 'Wed Jan  1 00:00:00 1960'],
    ['two lines', 'Wed Nov 11 11:06:58 2026\nWed Nov 11 11:06:58 2026\n'],
  ])('refuses %s', (_name, text) => {
    expect(startMsOfLstart(text)).toBeNull();
  });
});

describe('process start: the read of one pid', () => {
  it('asks ps for the start of the pid with a time limit and the default environment (the C locale)', async () => {
    const deps = withPs(() => exited(0, 'Wed Nov 11 11:06:58 2026\n'));
    expect(await processStartOf(deps, 321)).toEqual({ ok: true, value: LOCAL_START_MS });
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]).toMatchObject({ command: 'ps', args: ['-o', 'lstart=', '-p', '321'], inheritEnv: false });
    expect(deps.calls[0]?.timeoutMs).toBeGreaterThan(0);
  });

  it('does not read the clock, so a slow ps does not move the start', async () => {
    let reads = 0;
    const deps = withPs(() => exited(0, 'Wed Nov 11 11:06:58 2026\n'));
    const counted: Deps = {
      ...deps,
      now: () => {
        reads += 1;
        return deps.now();
      },
    };
    await processStartOf(counted, 321);
    expect(reads).toBe(0);
  });

  it.each([
    ['a pid of 0', 0, () => exited(0, 'Wed Nov 11 11:06:58 2026\n')],
    ['a pid that is not a whole number', 1.5, () => exited(0, 'Wed Nov 11 11:06:58 2026\n')],
    ['a negative pid', -4, () => exited(0, 'Wed Nov 11 11:06:58 2026\n')],
    ['a ps that is not found', 321, () => missingProgram('ps')],
    ['a ps that fails', 321, () => exited(1, '', 'ps: error')],
    ['empty output (the process is gone)', 321, () => exited(0, '')],
    ['output that is not a start', 321, () => exited(0, 'SECRET-TEXT\n')],
  ])('gives an error for %s', async (_name, pid, run) => {
    const deps = withPs(run);
    const result = await processStartOf(deps, pid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('SECRET-TEXT');
  });

  it('gives an error when the run itself fails with a typed failure', async () => {
    const deps = withPs(() => failure('cannot run ps: EACCES'));
    expect(await processStartOf(deps, 321)).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
  });
});
