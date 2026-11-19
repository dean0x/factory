import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardIds, guardStartWords } from '../../src/names.js';
import {
  FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf, OTHER_NODE_ID, unloadableConfig, withFirstConfigReadFault, withStoreReadFault,
} from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const SETTINGS_FILE = `${GUARDED_HOME}/.claude/settings.json`;
const PROGRAM_VARIABLE = JSON.stringify({ env: { FACTORY_ANYTHING: '1' } });
const SKIP_SETTING = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

/** The permission check of doctor for the node, through the command line. */
const settingsCheckOf = async (deps: Parameters<typeof runCli>[1]): Promise<CheckLine | undefined> =>
  (await doctorChecksOf(deps)).find((check) => check.id === checkIds.permissionMode);

describe('the guard of the Claude Code settings check', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.settingsCheck))('doctor checks a settings file that sets a program variable with the guard %s', async (_state, setup, on) => {
      const deps = guardedNode({}, { ...setup, origin });
      deps.seed(SETTINGS_FILE, PROGRAM_VARIABLE);
      expect((await settingsCheckOf(deps))?.level).toBe(on ? 'fail' : 'ok');
    });

    it('doctor still stops a settings file that skips the permissions with the guard off and a matching record', async () => {
      const deps = guardedNode({}, { off: [guardIds.settingsCheck], origin });
      deps.seed(SETTINGS_FILE, SKIP_SETTING);
      const check = await settingsCheckOf(deps);
      expect(check?.level).toBe('fail');
      expect(check?.text).toContain('skips the permission checks');
    });

    it('doctor checks the settings with every guard on when the config has valid guard keys but does not load', async () => {
      const deps = guardedNode({}, { off: [guardIds.settingsCheck], origin, config: unloadableConfig() });
      deps.seed(SETTINGS_FILE, PROGRAM_VARIABLE);
      expect((await settingsCheckOf(deps))?.level).toBe('fail');
    });

    it.each([
      ['the first read of the guard store fails and a later one passes', 1, true],
      ['the first read of the guard store passes and a later one fails', 2, false],
    ])('doctor reports the guard values that its settings check acts on when %s', async (_name, faulted, on) => {
      const deps = guardedNode({}, { off: [guardIds.settingsCheck], origin });
      deps.seed(SETTINGS_FILE, PROGRAM_VARIABLE);
      const checks = await doctorChecksOf(withStoreReadFault(deps, faulted));
      expect(checks.find((check) => check.id === checkIds.guards)?.text).toContain(guardStartWords.off(on ? 0 : 1));
      expect(checks.find((check) => check.id === checkIds.permissionMode)?.level).toBe(on ? 'fail' : 'ok');
    });

    it('doctor checks the settings with every guard on when only the proof finds that the factory list names another node id', async () => {
      const deps = guardedNode({}, { off: [guardIds.settingsCheck], origin, listed: OTHER_NODE_ID });
      deps.seed(SETTINGS_FILE, PROGRAM_VARIABLE);
      const checks = await doctorChecksOf(withFirstConfigReadFault(deps));
      expect(checks.find((check) => check.id === checkIds.permissionMode)?.level).toBe('fail');
      expect(checks.find((check) => check.id === checkIds.guards)?.text).toContain(guardStartWords.off(0));
    });
  });
});
