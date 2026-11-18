import { withFsWatch, type FakeDeps } from './fake-deps.js';

/** A deps that counts content reads of one file, through checked open or text read. */
export interface CountedReads {
  readonly deps: FakeDeps;
  readonly count: () => number;
}

export const countReadsOf = (deps: FakeDeps, path: string): CountedReads => {
  let count = 0;
  return {
    deps: withFsWatch(deps, (method, file) => {
      if (file === path && (method === 'openCheckedCore' || method === 'openChecked' || method.startsWith('readText'))) count += 1;
    }),
    count: () => count,
  };
};
