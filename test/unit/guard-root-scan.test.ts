import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { checkIds, commands, dirs, files, flags, flagText, guardDoctorWords, guardIds } from '../../src/names.js';
import { gitHandler, type GitFixture } from '../helpers/git-fake.js';
import { FOLDER_ORIGINS, GUARDED_HOME, guardedNode, guardStatesOf } from '../helpers/guarded-node.js';
import { captureSink } from '../helpers/sink.js';

interface CheckLine {
  readonly id: string;
  readonly level: string;
  readonly text: string;
}

const HOME = GUARDED_HOME;
const NOT_CHECKED = guardDoctorWords.notChecked(guardIds.rootScan);

/** The checks of doctor for the node, through the command line. */
const doctorChecksOf = async (deps: Parameters<typeof runCli>[1]): Promise<readonly CheckLine[]> => {
  const sink = captureSink();
  await runCli([commands.doctor, flagText(flags.home), HOME, flagText(flags.json)], deps, sink);
  return (JSON.parse(sink.out.join('')) as { readonly checks: readonly CheckLine[] }).checks;
};

const checkOf = async (fixture: GitFixture, setup: Parameters<typeof guardedNode>[1], id: string, links = {}) => {
  const deps = guardedNode({ run: gitHandler({ repos: { [HOME]: {} }, ...fixture }).handler, links }, setup);
  deps.seed(`${HOME}/notes.md`, 'See file:///tmp/notes.md.\n');
  return (await doctorChecksOf(deps)).find((line) => line.id === id);
};

/** Each fault of the root repo that the guard covers: the git fixture of the folder and a piece of the text of its finding. */
const REPO_FAULTS: readonly (readonly [string, GitFixture, string])[] = [
  ['a tracked local config', { tracked: { [HOME]: [files.localConfig] } }, 'tracks files that must stay on this machine'],
  ['a local config and a state folder that git does not ignore', { ignored: { [HOME]: [] } }, `git does not ignore ${files.localConfig}`],
  ['a coordinator folder that git does not ignore', { ignored: { [HOME]: [files.localConfig, `${dirs.state}/${files.nodeState}`] } }, `git does not ignore ${dirs.coordinator}/`],
  ['a tracked file in the work copies folder', { tracked: { [HOME]: [`${dirs.workCopies}/a/notes.md`] } }, 'in the work copies folder'],
];

describe('the guard of the scan of the folder', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_title, origin) => {
    describe.each(REPO_FAULTS)('with %s', (_fault, fixture, piece) => {
      it.each(guardStatesOf(guardIds.rootScan))('doctor names the fault in the root check only while the guard is on: %s', async (_state, setup, on) => {
        expect((await checkOf(fixture, { ...setup, origin }, checkIds.rootRepo))?.text.includes(piece)).toBe(on);
      });
    });

    it.each(guardStatesOf(guardIds.rootScan))('doctor names the part of the root check that did not run only while the guard counts as off: %s', async (_state, setup, on) => {
      const check = await checkOf({ ignored: { [HOME]: [] } }, { ...setup, origin }, checkIds.rootRepo);
      expect(check?.level).toBe(on ? 'fail' : 'ok');
      expect(check?.text.includes(NOT_CHECKED)).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.rootScan))('doctor warns about a file URL in a tracked text only while the guard is on: %s', async (_state, setup, on) => {
      const check = await checkOf({ tracked: { [HOME]: ['notes.md'] } }, { ...setup, origin }, checkIds.rootFiles);
      expect(check?.level).toBe(on ? 'warn' : 'ok');
      expect(check?.text.includes(NOT_CHECKED)).toBe(!on);
    });
  });

  it.each(guardStatesOf(guardIds.rootScan))('doctor fails a received folder that tracks a link with every value of the guard: %s', async (_state, setup) => {
    const check = await checkOf({ tracked: { [HOME]: ['notes.md'] } }, { ...setup, origin: 'received' }, checkIds.rootRepo, {
      [`${HOME}/notes.md`]: '/elsewhere/notes.md',
    });
    expect(check?.level).toBe('fail');
    expect(check?.text).toContain('notes.md is a link');
  });
});
