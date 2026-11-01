import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { failure } from '../../src/cli/errors.js';
import { inspectParsed, requireValid } from '../../src/migrate/inspect.js';
import { planMigrations, runMigrations, type Migration } from '../../src/migrate/runner.js';
import { ok } from '../../src/core/result.js';

const bump = (from: number, extra: string): Migration => ({
  from,
  to: from + 1,
  apply: (raw) => ok({ ...(raw as object), v: from + 1, [extra]: true }),
});

const chain: readonly Migration[] = [bump(1, 'a'), bump(2, 'b')];

describe('planMigrations', () => {
  it('returns no steps when the version is current', () => {
    expect(planMigrations(3, 3, chain)).toEqual({ ok: true, value: [] });
  });

  it('returns the steps in order for a chain 1 to 2 to 3', () => {
    const planned = planMigrations(1, 3, chain);
    expect(planned.ok && planned.value.map((step) => [step.from, step.to])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('starts in the middle of the chain', () => {
    const planned = planMigrations(2, 3, chain);
    expect(planned.ok && planned.value.map((step) => step.from)).toEqual([2]);
  });

  it('does not depend on the order of the list', () => {
    const planned = planMigrations(1, 3, [chain[1]!, chain[0]!]);
    expect(planned.ok && planned.value.map((step) => step.from)).toEqual([1, 2]);
  });

  it('rejects a gap in the chain and names the missing version', () => {
    const planned = planMigrations(1, 4, [bump(1, 'a'), bump(3, 'c')]);
    expect(planned).toMatchObject({ ok: false, error: { kind: 'failure' } });
    if (!planned.ok) expect(planned.error.message).toContain('no migration from version 2');
  });

  it('rejects a version newer than the target and says to upgrade factory', () => {
    const planned = planMigrations(4, 3, chain);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.message).toContain('Upgrade factory.');
  });

  it('rejects two migrations from the same version', () => {
    const planned = planMigrations(1, 2, [bump(1, 'a'), bump(1, 'b')]);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.message).toContain('two migrations');
  });

  it('rejects a migration that does not go up by one', () => {
    const planned = planMigrations(1, 3, [{ from: 1, to: 3, apply: (raw) => ok(raw) }]);
    expect(planned.ok).toBe(false);
  });
});

describe('runMigrations', () => {
  it('applies the steps in order without changing the input', () => {
    const input = Object.freeze({ v: 1 });
    const steps = planMigrations(1, 3, chain);
    expect(steps.ok).toBe(true);
    if (!steps.ok) return;
    expect(runMigrations(input, steps.value)).toEqual({ ok: true, value: { v: 3, a: true, b: true } });
    expect(input).toEqual({ v: 1 });
  });

  it('returns the input when there are no steps', () => {
    expect(runMigrations({ v: 1 }, [])).toEqual({ ok: true, value: { v: 1 } });
  });

  it('stops at the first error and does not run later steps', () => {
    const seen: number[] = [];
    const steps: readonly Migration[] = [
      { from: 1, to: 2, apply: (raw) => (seen.push(1), ok(raw)) },
      { from: 2, to: 3, apply: () => (seen.push(2), failure('boom')) },
      { from: 3, to: 4, apply: (raw) => (seen.push(3), ok(raw)) },
    ];
    const result = runMigrations({}, steps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('migration from version 2 to 3 failed: boom');
    expect(seen).toEqual([1, 2]);
  });
});

describe('inspectParsed with a newer supported version', () => {
  const spec = {
    file: 'x.json',
    key: 'v',
    supported: 2,
    schema: z.strictObject({ v: z.literal(2), name: z.string() }),
  };

  it('is valid at the supported version', () => {
    expect(inspectParsed({ v: 2, name: 'a' }, spec)).toMatchObject({ kind: 'valid', version: 2 });
  });

  it('is older below the supported version and says to run factory upgrade', () => {
    const state = inspectParsed({ v: 1 }, spec);
    expect(state).toMatchObject({ kind: 'older', version: 1 });
    const required = requireValid(state, 'x.json');
    expect(required.ok).toBe(false);
    if (!required.ok) expect(required.error.message).toContain('Run "factory upgrade".');
  });

  it('is newer above the supported version and says to upgrade factory', () => {
    const state = inspectParsed({ v: 3 }, spec);
    expect(state).toMatchObject({ kind: 'newer', version: 3 });
    const required = requireValid(state, 'x.json');
    if (!required.ok) expect(required.error.message).toContain('Upgrade factory.');
  });

  it('is invalid when the schema rejects the document', () => {
    expect(inspectParsed({ v: 2 }, spec)).toMatchObject({ kind: 'invalid' });
  });

  it('gives each state its own error text from requireValid', () => {
    const message = (state: Parameters<typeof requireValid>[0]) => {
      const result = requireValid(state, 'x.json');
      return result.ok ? '' : result.error.message;
    };
    expect(message({ kind: 'missing' })).toBe('x.json not found');
    expect(message({ kind: 'unparsable', message: 'bad' })).toBe('x.json does not parse: bad');
    expect(message({ kind: 'invalid', raw: null, message: 'bad' })).toBe('x.json is invalid: bad');
  });
});
