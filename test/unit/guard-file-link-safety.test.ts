import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardIds } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const LAYOUT = layoutOf(GUARDED_HOME);

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

describe('the guard of file and link safety', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.fileLinkSafety))('doctor fails a link at the backup folder in the block and setup text checks only while the guard is on: %s', async (_state, setup, on) => {
      const deps = guardedNode({ links: { [LAYOUT.backupsDir]: '/elsewhere/backups' } }, { ...setup, origin });
      deps.seedDir(LAYOUT.stateDir);
      const linked = (await doctorChecksOf(deps)).filter((check) => check.text.includes('is a link'));
      expect(linked.map((check) => [check.id, check.level])).toEqual(on ? [[checkIds.blocks, 'fail'], [checkIds.setupText, 'fail']] : []);
    });
  });
});
