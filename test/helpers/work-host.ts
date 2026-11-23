import { failure } from '../../src/cli/errors.js';
import { ok } from '../../src/core/result.js';
import { allOn } from '../../src/guards/effective.js';
import type { WorkHost } from '../../src/recipes/entry.js';

type Step = Exclude<keyof WorkHost, 'guards'>;
export type WorkHostCall = { [K in Step]: readonly [K, ...Parameters<WorkHost[K]>] }[Step];

export interface FakeWorkHost {
  readonly work: WorkHost;
  readonly calls: readonly WorkHostCall[];
}

/** Each override supplies one step result. The log lists every call, also when the step refuses. */
export const fakeWorkHost = (overrides: Partial<WorkHost> = {}): FakeWorkHost => {
  const calls: WorkHostCall[] = [];
  return {
    calls,
    work: {
      guards: overrides.guards ?? allOn,
      caller: async () => {
        calls.push(['caller']);
        return overrides.caller?.() ?? ok(undefined);
      },
      find: async (query) => {
        calls.push(['find', query]);
        return overrides.find?.(query) ?? ok({ kind: 'lookup', cause: 'no item matches the reference or head branch' });
      },
      facts: async (target) => {
        calls.push(['facts', target]);
        return overrides.facts?.(target) ?? failure('the test gives no work facts');
      },
      approval: async (target) => {
        calls.push(['approval', target]);
        return overrides.approval?.(target) ?? failure('the test gives no approval proof');
      },
      record: async (target) => {
        calls.push(['record', target]);
        return overrides.record?.(target) ?? failure('the test gives no record result');
      },
    },
  };
};
