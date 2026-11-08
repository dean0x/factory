import type { CliResult } from '../../src/cli/errors.js';
import type { Deps, RunOutput } from '../../src/core/deps.js';
import { setStateConfig } from '../../src/core/git.js';
import { ok } from '../../src/core/result.js';
import { stateGuard } from '../../src/names.js';
import { installGuard, type GuardOffKind } from '../../src/state/guard.js';
import { createFakeDeps, type FakeDeps, type RunCall } from './fake-deps.js';
import { gitHandler, type GitFixture } from './git-fake.js';

/** A state repo of a fake node, its delete guard, and the ways that the guard can be off. */

export const HOME = '/h/node';
export const STATE = `${HOME}/.factory`;
export const GIT_DIR = `${STATE}/.git`;
export const GUARD = `${GIT_DIR}/${stateGuard.folder}`;
export const HOOK = `${GUARD}/${stateGuard.hookFile}`;
export const HOOK_TEXT = `#!/bin/sh\n${stateGuard.comment}\nexec /opt/fake/bin/node /opt/fake/lib/program/cli.js state guard\n`;

export interface Made {
  readonly deps: FakeDeps;
  readonly gitCommands: () => string[];
}

export interface MakeOptions {
  readonly links?: Record<string, string>;
  readonly programArgv?: readonly string[];
  readonly fixture?: GitFixture;
  /** An answer for a git call that replaces the fake. Undefined: the fake answers. */
  readonly answer?: (call: RunCall) => CliResult<RunOutput> | undefined;
}

export const make = (options: MakeOptions = {}): Made => {
  const { handler, log } = gitHandler(options.fixture);
  const deps = createFakeDeps({
    cwd: HOME,
    run: (call) => options.answer?.(call) ?? handler(call),
    ...(options.links === undefined ? {} : { links: options.links }),
    ...(options.programArgv === undefined ? {} : { programArgv: options.programArgv }),
  });
  deps.seedDir(GIT_DIR);
  return { deps, gitCommands: () => log.commands() };
};

/** A deps in which the path is a link, as `lstat` sees it. Everything else is as it was. */
export const linkAt = (deps: Deps, path: string): Deps => ({
  ...deps,
  fs: { ...deps.fs, lstat: async (target) => (target === path ? ok('link') : deps.fs.lstat(target)) },
});

export const installed = async (): Promise<Made> => {
  const made = make();
  const result = await installGuard(made.deps, STATE, STATE);
  if (!result.ok) throw new Error(result.error.message);
  return made;
};

/** Change the installed guard, and give back the deps that the next call reads with. */
type Change = (made: Made) => Promise<Deps>;

/** A change of the files or of the settings: the deps stay the same. */
const touch =
  (change: (made: Made) => unknown): Change =>
  async (made) => {
    await change(made);
    return made.deps;
  };

/** The ways that the guard is off, each one made from an installed guard. */
export const OFF_CASES: readonly (readonly [string, GuardOffKind, Change])[] = [
  ['another value of core.hooksPath', 'hooks-path', touch((made) => setStateConfig(made.deps, STATE, 'core.hooksPath', '/other/hooks'))],
  ['a setting of core.hooksPath that is a relative path', 'hooks-path', touch((made) => setStateConfig(made.deps, STATE, 'core.hooksPath', stateGuard.folder))],
  ['hook bytes that differ from the package text', 'hook-bytes', touch((made) => made.deps.files.set(HOOK, '#!/bin/sh\nexit 0\n'))],
  ['hook bytes with text added at the end', 'hook-bytes', touch((made) => made.deps.files.set(HOOK, `${HOOK_TEXT}echo more\n`))],
  ['an empty hook', 'hook-bytes', touch((made) => made.deps.files.set(HOOK, ''))],
  ['another file in the guard folder', 'extra-entry', touch((made) => made.deps.seed(`${GUARD}/post-commit`, 'x'))],
  ['a folder in the guard folder', 'extra-entry', touch((made) => made.deps.seedDir(`${GUARD}/sub`))],
  ['a missing hook', 'hook-missing', touch((made) => made.deps.files.delete(HOOK))],
  ['a missing guard folder', 'folder-missing', touch((made) => made.deps.fs.remove(GUARD))],
  ['a hook that is a link', 'hook-not-plain', async (made) => linkAt(made.deps, HOOK)],
  ['a guard folder that is a link', 'folder-not-plain', async (made) => linkAt(made.deps, GUARD)],
  ['a hook with mode 644', 'hook-mode', touch((made) => made.deps.modes.set(HOOK, 0o644))],
  ['a hook with mode 775', 'hook-mode', touch((made) => made.deps.modes.set(HOOK, 0o775))],
  ['a program that moved', 'hook-bytes', async (made) => ({ ...made.deps, programArgv: ['/opt/new/bin/node', '/opt/new/lib/cli.js'] })],
  ['a program path that is not known', 'program-unknown', async (made) => ({ ...made.deps, programArgv: [] })],
  ['a .git entry that is a link', 'git-folder', async (made) => linkAt(made.deps, GIT_DIR)],
];
