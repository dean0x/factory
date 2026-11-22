import type { CommandOutput } from '../cli/output.js';
import { schemaIds } from '../names.js';
import type { BuildInfo } from '../version.js';

/** The second line: the commit of the build, a note when the build had changes that were not committed, or `unknown`. */
const commitLine = (build: BuildInfo): string => {
  if (build.commit === null) return 'commit unknown';
  return build.modified === true ? `commit ${build.commit} (with changes that were not committed)` : `commit ${build.commit}`;
};

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
