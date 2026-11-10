import type { FakeDeps } from './fake-deps.js';

/** A deps that counts the reads of the text of one file, and is the given deps in every other way. */
export interface CountedReads {
  readonly deps: FakeDeps;
  /** The reads of the text of the file so far. */
  readonly count: () => number;
}

export const countReadsOf = (deps: FakeDeps, file: string): CountedReads => {
  let count = 0;
  const counted: FakeDeps = {
    ...deps,
    fs: {
      ...deps.fs,
      readTextLimited: (path, maxBytes, decode) => {
        if (path === file) count += 1;
        return deps.fs.readTextLimited(path, maxBytes, decode);
      },
    },
  };
  return { deps: counted, count: () => count };
};
