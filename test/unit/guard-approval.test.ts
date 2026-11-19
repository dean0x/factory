import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardIds, values } from '../../src/names.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const [OWNER_MODE, DELEGATED_MODE] = values.approvalModes;
const POINT = sampleConfig().entry.approvalPoints[0]?.id ?? '';

/** The sample config with the first approval point delegated in the local file, and no approval record. */
const delegatedConfig = () => {
  const sample = sampleConfig();
  return { ...sample, core: { ...sample.core, approval: { ...sample.core.approval, [POINT]: DELEGATED_MODE } } };
};

const run = async (argv: readonly string[], deps: Parameters<typeof runCli>[1]) => {
  const sink = captureSink();
  const code = await runCli([...argv], deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

describe('the guard of approval delegation', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.approvalDelegation))('doctor counts a delegated value with no approval record only while the guard is off, with the guard %s', async (_state, setup, on) => {
      const deps = guardedNode({}, { ...setup, origin, config: delegatedConfig() });
      const result = await run([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps);
      const check = (JSON.parse(result.out) as { readonly checks: readonly CheckLine[] }).checks.find((line) => line.id === checkIds.delegations);
      expect(check?.level).toBe(on ? 'warn' : 'ok');
      expect(check?.text).toContain(`${POINT}: ${on ? OWNER_MODE : DELEGATED_MODE}`);
    });
  });
});
