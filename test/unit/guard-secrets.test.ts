import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, flags, flagText, guardDoctorWords, guardIds } from '../../src/names.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { gitHandler } from '../helpers/git-fake.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const TOKEN_TEXT = 'looks like a password or a token';

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), GUARDED_HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

/** The sample config with a token in the heavy test command of its first project. */
const configWithToken = () => {
  const sample = sampleConfig();
  const [project] = sample.recipe.projects;
  if (project === undefined) throw new Error('the sample config has no project');
  return { ...sample, recipe: { ...sample.recipe, projects: [{ ...project, heavy_test: `curl -H ${FAKE_GITHUB_TOKEN}` }] } };
};

describe('the guard of secrets and output text', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    it.each(guardStatesOf(guardIds.secrets))('doctor fails a tracked text file that holds a token only while the guard is on: %s', async (_state, setup, on) => {
      const { handler } = gitHandler({ repos: { [GUARDED_HOME]: {} }, tracked: { [GUARDED_HOME]: ['notes.md'] } });
      const deps = guardedNode({ run: handler }, { ...setup, origin });
      deps.seed(`${GUARDED_HOME}/notes.md`, `The key is ${FAKE_GITHUB_TOKEN} for now.\n`);
      const found = (await doctorChecksOf(deps)).filter((check) => check.id === checkIds.rootFiles && check.text.includes(TOKEN_TEXT));
      expect(found.map((check) => check.level)).toEqual(on ? ['fail'] : []);
    });

    it.each(guardStatesOf(guardIds.secrets))('doctor fails a config value that looks like a token only while the guard is on: %s', async (_state, setup, on) => {
      const deps = guardedNode({}, { ...setup, origin, config: configWithToken() });
      const check = (await doctorChecksOf(deps)).find((line) => line.id === checkIds.secrets);
      expect(check?.level).toBe(on ? 'fail' : 'ok');
      expect(check?.text).toContain(on ? 'recipe.projects.0.heavy_test' : guardDoctorWords.notChecked(guardIds.secrets));
      expect(check?.text).not.toContain(FAKE_GITHUB_TOKEN);
    });
  });
});
