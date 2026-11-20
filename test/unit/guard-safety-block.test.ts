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

/** The block check of doctor for the node, through the command line. */
const blockCheckOf = async (deps: Parameters<typeof runCli>[1]): Promise<CheckLine | undefined> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks.find((check) => check.id === checkIds.blocks);
};

describe('the guard of the safety block', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.safetyBlock))('doctor fails a missing safety block only while the guard counts as on, and else warns: %s', async (_state, setup, on) => {
      const check = await blockCheckOf(guardedNode({}, { ...setup, origin }));
      expect(check?.level).toBe(on ? 'fail' : 'warn');
      expect(check?.text).toContain('safety (missing');
    });
  });
});
