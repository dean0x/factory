import type { CommandOutput } from '../cli/output.js';
import { schemaIds } from '../names.js';
import type { BuildInfo } from '../version.js';

/** The note after a known commit: the build had changes that were not committed, or the build could not tell. */
const changeNote = (modified: boolean | null): string => {
  if (modified === false) return '';
  return modified === true ? ' (with changes that were not committed)' : ' (changes not known)';
};

/** The second line: the commit of the build and its note, or `unknown`. */
const commitLine = (build: BuildInfo): string =>
  build.commit === null ? 'commit unknown' : `commit ${build.commit}${changeNote(build.modified)}`;

/** Line 1 is the package version only, so a script that reads the first line gets the version. */
export const runVersion = (build: BuildInfo): CommandOutput => ({
  lines: [
    { level: 'text', text: build.version },
    { level: 'text', text: commitLine(build) },
  ],
  json: { schema: schemaIds.version, version: build.version, commit: build.commit, modified: build.modified },
  warnings: [],
  failed: false,
});
