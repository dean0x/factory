import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardIds } from '../../src/names.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const SETTINGS_FILE = `${GUARDED_HOME}/.claude/settings.json`;
const PROGRAM_VARIABLE = JSON.stringify({ env: { FACTORY_ANYTHING: '1' } });
const SKIP_SETTING = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });

/** The permission check of doctor for the node, through the command line. */
const settingsCheckOf = async (deps: Parameters<typeof runCli>[1]): Promise<CheckLine | undefined> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  const checks = (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
  return checks.find((check) => check.id === checkIds.permissionMode);
};

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
  });
});
