import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, files, flags, flagText, guardDoctorWords, guardIds } from '../../src/names.js';
import { exited } from '../helpers/fake-deps.js';
import { gitHandler, NO_REPO_AT_MOUNT_POINT } from '../helpers/git-fake.js';
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
    describe.each([
      ['git names the parent folders', undefined],
      ['git stops at a mount point', NO_REPO_AT_MOUNT_POINT],
    ])('when %s', (_answer, noRepoText) => {
      it.each(guardStatesOf(guardIds.folderTrust))('doctor checks a folder that is not the top of a git work tree only while the guard is on: %s', async (_state, setup, on) => {
        const deps = guardedNode({ run: gitHandler(noRepoText === undefined ? {} : { noRepoText }).handler }, { ...setup, origin });
        const checks = await doctorChecksOf(deps);
        const check = checks.find((line) => line.id === checkIds.rootRepo);
        expect(check?.level).toBe(on ? (origin === 'received' ? 'fail' : 'warn') : 'ok');
        expect(check?.text.includes(NOT_CHECKED)).toBe(!on);
        if (!on) expect(checks.find((line) => line.id === checkIds.rootFiles)?.text).toBe(NOT_CHECKED);
      });
    });

    it('keeps a failed git read distinct from a folder without a work tree when folder trust is off', async () => {
      const { handler } = gitHandler({ repos: { [GUARDED_HOME]: {} } });
      const deps = guardedNode({ run: (call) => call.args.includes('--is-inside-work-tree') ? exited(128, '', 'read failed') : handler(call) },
        { off: [guardIds.folderTrust], origin });
      const check = (await doctorChecksOf(deps)).find((line) => line.id === checkIds.rootRepo);
      expect(check?.level).toBe('fail');
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
