import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardIds } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import type { FakeDeps } from '../helpers/fake-deps.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const LAYOUT = layoutOf(GUARDED_HOME);

/** The two checks of doctor that the guard covers. In an own folder, the check of the root repo names a setup link too. */
const FILE_CHECKS: readonly string[] = [checkIds.blocks, checkIds.setupText];

/** A readable coordinator file, so the setup text check reads the setup file of the coordinator too. */
const withRenderedFile = (deps: FakeDeps): FakeDeps => {
  deps.seed(LAYOUT.claudeMd, 'A line of the owner.\n');
  return deps;
};

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

describe('the guard of file and link safety', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.fileLinkSafety))('doctor fails a link at the backup folder in the block and setup text checks only while the guard is on: %s', async (_state, setup, on) => {
      const deps = withRenderedFile(guardedNode({ links: { [LAYOUT.backupsDir]: '/elsewhere/backups' } }, { ...setup, origin }));
      deps.seedDir(LAYOUT.stateDir);
      const linked = (await doctorChecksOf(deps)).filter((check) => check.text.includes('is a link'));
      expect(linked.map((check) => [check.id, check.level])).toEqual(on ? [[checkIds.blocks, 'fail'], [checkIds.setupText, 'fail']] : []);
    });

    it.each(guardStatesOf(guardIds.fileLinkSafety))('doctor fails a link at a setup file in the block check with every value, and the setup text check does not check that file: %s', async (_state, setup, on) => {
      const deps = withRenderedFile(guardedNode({ links: { [LAYOUT.setupCoordinatorFile]: '/elsewhere/coordinator.md' } }, { ...setup, origin }));
      deps.seedDir(LAYOUT.setupDir);
      const linked = (await doctorChecksOf(deps)).filter((check) => FILE_CHECKS.includes(check.id) && check.text.includes('setup/coordinator.md is a link'));
      expect(linked.map((check) => [check.id, check.level])).toEqual([[checkIds.blocks, 'fail'], [checkIds.setupText, on ? 'fail' : 'warn']]);
    });
  });
});
