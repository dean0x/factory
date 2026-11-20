import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, files, flags, flagText, guardDoctorWords, guardIds } from '../../src/names.js';
import { gitHandler } from '../helpers/git-fake.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const NOT_CHECKED = guardDoctorWords.notChecked(guardIds.folderTrust);

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

describe('the guard of folder trust', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.folderTrust))('doctor checks a folder that is not the top of a git work tree only while the guard is on: %s', async (_state, setup, on) => {
      const deps = guardedNode({ run: gitHandler({}).handler }, { ...setup, origin });
      const check = (await doctorChecksOf(deps)).find((line) => line.id === checkIds.rootRepo);
      expect(check?.level).toBe(on ? (origin === 'received' ? 'fail' : 'warn') : 'ok');
      expect(check?.text.includes(NOT_CHECKED)).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.folderTrust))('doctor warns about an agent instruction file in the folder only while the guard is on: %s', async (_state, setup, on) => {
      const deps = guardedNode({ run: gitHandler({ repos: { [GUARDED_HOME]: {} } }).handler }, { ...setup, origin });
      deps.seed(`${GUARDED_HOME}/${files.claudeMd}`, 'Rules.\n');
      const check = (await doctorChecksOf(deps)).find((line) => line.id === checkIds.instructionFiles);
      expect(check?.level).toBe(on ? 'warn' : 'ok');
      expect(check?.text).toContain(on ? `${GUARDED_HOME}/${files.claudeMd}` : NOT_CHECKED);
    });
  });
});
