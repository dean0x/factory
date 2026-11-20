import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardDoctorWords, guardIds } from '../../src/names.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const SETTINGS_FOLDER = `${GUARDED_HOME}/.claude`;
const SKIP_SETTING = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
const SKIP_TEXT = 'skips the permission checks';

/** The permission check of doctor for the node, through the command line. */
const permissionCheckOf = async (deps: Parameters<typeof runCli>[1]): Promise<CheckLine | undefined> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks.find((check) => check.id === checkIds.permissionMode);
};

describe('the guard of the permission mode', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.permissionMode))('doctor fails a settings file that skips the permissions only while the guard counts as on: %s', async (_state, setup, on) => {
      const deps = guardedNode({}, { ...setup, origin });
      deps.seed(`${SETTINGS_FOLDER}/settings.json`, SKIP_SETTING);
      const check = await permissionCheckOf(deps);
      expect(check?.level === 'fail').toBe(on);
      expect(check?.text.includes(SKIP_TEXT)).toBe(on);
    });

    it.each(guardStatesOf(guardIds.permissionMode))('doctor names the permission part of a clean settings check as not checked only while the guard is off: %s', async (_state, setup, on) => {
      const check = await permissionCheckOf(guardedNode({}, { ...setup, origin }));
      expect(check?.level).toBe('ok');
      expect(check?.text.includes(guardDoctorWords.notChecked(guardIds.permissionMode))).toBe(!on);
    });

    it('doctor names the settings check as not checked when the guards of the permission mode and of the settings check are both off', async () => {
      const check = await permissionCheckOf(guardedNode({}, { off: [guardIds.permissionMode, guardIds.settingsCheck], origin }));
      expect(check).toMatchObject({ level: 'ok', text: guardDoctorWords.notCheckedBy([guardIds.permissionMode, guardIds.settingsCheck]) });
    });

    it('doctor still fails a settings folder that it can not read when both guards are off with a matching record', async () => {
      const deps = guardedNode({ links: { [SETTINGS_FOLDER]: '/elsewhere/claude' } }, { off: [guardIds.permissionMode, guardIds.settingsCheck], origin });
      const check = await permissionCheckOf(deps);
      expect(check?.level).toBe('fail');
      expect(check?.text).toContain('is a link');
    });
  });
});
