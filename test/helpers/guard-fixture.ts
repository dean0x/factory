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
/** The hook files of the guard folder: the paths, and the first of them (`pre-commit`). */
export const HOOKS: readonly string[] = stateGuard.hookFiles.map((name) => `${GUARD}/${name}`);
export const HOOK = `${GUARD}/${stateGuard.hookFiles[0]}`;
/** The hook files after the first one: `pre-merge-commit` and `pre-applypatch`. */
export const MERGE_HOOK = `${GUARD}/${stateGuard.hookFiles[1]}`;
export const PATCH_HOOK = `${GUARD}/${stateGuard.hookFiles[2]}`;
/** The check of the two paths, the line to print when one is gone, and the start of the program: the text of every hook file. */
export const HOOK_TEXT = [
  '#!/bin/sh',
  stateGuard.comment,
  'if [ ! -x /opt/fake/bin/node ] || [ ! -f /opt/fake/lib/program/cli.js ]; then',
  `  printf '%s\\n' '${stateGuard.programMissing}' >&2`,
  '  exit 1',
  'fi',
  'exec /opt/fake/bin/node /opt/fake/lib/program/cli.js state guard',
  '',
].join('\n');

export interface Made {
  readonly deps: FakeDeps;
  readonly gitCommands: () => string[];
}

export interface MakeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
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
    ...(options.env === undefined ? {} : { env: options.env }),
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
  ['a missing pre-merge-commit hook', 'hook-missing', touch((made) => made.deps.files.delete(MERGE_HOOK))],
  ['a missing pre-applypatch hook', 'hook-missing', touch((made) => made.deps.files.delete(PATCH_HOOK))],
  ['a pre-merge-commit hook with other bytes', 'hook-bytes', touch((made) => made.deps.files.set(MERGE_HOOK, '#!/bin/sh\nexit 0\n'))],
  ['a pre-applypatch hook with mode 644', 'hook-mode', touch((made) => made.deps.modes.set(PATCH_HOOK, 0o644))],
  ['a pre-merge-commit hook that is a link', 'hook-not-plain', async (made) => linkAt(made.deps, MERGE_HOOK)],
  ['a missing guard folder', 'folder-missing', touch((made) => made.deps.fs.remove(GUARD))],
  ['a hook that is a link', 'hook-not-plain', async (made) => linkAt(made.deps, HOOK)],
  ['a guard folder that is a link', 'folder-not-plain', async (made) => linkAt(made.deps, GUARD)],
  ['a hook with mode 644', 'hook-mode', touch((made) => made.deps.modes.set(HOOK, 0o644))],
  ['a hook with mode 775', 'hook-mode', touch((made) => made.deps.modes.set(HOOK, 0o775))],
  ['a program that moved', 'hook-bytes', async (made) => ({ ...made.deps, programArgv: ['/opt/new/bin/node', '/opt/new/lib/cli.js'] })],
  ['a program path that is not known', 'program-unknown', async (made) => ({ ...made.deps, programArgv: [] })],
  ['a .git entry that is a link', 'git-folder', async (made) => linkAt(made.deps, GIT_DIR)],
  [
    'a guard folder with more entries than the install removes',
    'folder-too-big',
    touch((made) => {
      for (let at = 0; at <= stateGuard.maxEntries; at += 1) made.deps.seed(`${GUARD}/f${at}`, 'x');
    }),
  ],
  [
    'a guard folder that is not at its real path',
    'folder-not-real',
    async (made) => ({
      ...made.deps,
      fs: { ...made.deps.fs, realpath: async (path) => (path === GUARD ? ok('/elsewhere/factory-guard') : made.deps.fs.realpath(path)) },
    }),
  ],
];

/** The kinds that the install refuses. A person repairs them by hand, and their remedy does not name the command `factory upgrade`. */
export const HAND_KINDS: ReadonlySet<GuardOffKind> = new Set<GuardOffKind>([
  'program-unknown',
  'git-folder',
  'folder-not-plain',
  'folder-not-real',
  'folder-too-big',
]);
