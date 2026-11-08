import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliResult } from '../../src/cli/errors.js';
import type { Deps, RunOutput } from '../../src/core/deps.js';
import { setStateConfig } from '../../src/core/git.js';
import { ok } from '../../src/core/result.js';
import { stateGuard } from '../../src/names.js';
import {
  guardHookText,
  guardStateOf,
  installGuard,
  requireGuardOn,
  type GuardOffKind,
} from '../../src/state/guard.js';
import { createFakeDeps, exited, FAKE_PROGRAM_ARGV, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { gitHandler, withoutStateWords, type GitFixture } from '../helpers/git-fake.js';

const HOME = '/h/node';
const STATE = `${HOME}/.factory`;
const GIT_DIR = `${STATE}/.git`;
const GUARD = `${GIT_DIR}/${stateGuard.folder}`;
const HOOK = `${GUARD}/${stateGuard.hookFile}`;
const HOOK_TEXT = `#!/bin/sh\n${stateGuard.comment}\nexec /opt/fake/bin/node /opt/fake/lib/program/cli.js state guard\n`;

interface Made {
  readonly deps: FakeDeps;
  readonly gitCommands: () => string[];
}

interface MakeOptions {
  readonly links?: Record<string, string>;
  readonly programArgv?: readonly string[];
  readonly fixture?: GitFixture;
  /** An answer for a git call that replaces the fake. Undefined: the fake answers. */
  readonly answer?: (call: RunCall) => CliResult<RunOutput> | undefined;
}

const make = (options: MakeOptions = {}): Made => {
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
const linkAt = (deps: Deps, path: string): Deps => ({
  ...deps,
  fs: { ...deps.fs, lstat: async (target) => (target === path ? ok('link') : deps.fs.lstat(target)) },
});

const entriesOf = async (deps: Deps, path: string): Promise<readonly string[]> => {
  const listed = await deps.fs.list(path);
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value;
};

const installed = async (): Promise<Made> => {
  const made = make();
  const result = await installGuard(made.deps, STATE, STATE);
  if (!result.ok) throw new Error(result.error.message);
  return made;
};

const failureOf = <T>(result: CliResult<T>) => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

describe('the text of the guard hook (TP-1)', () => {
  it('starts the node program and the script by their absolute paths, with the words state guard', () => {
    expect(guardHookText(FAKE_PROGRAM_ARGV)).toEqual({ ok: true, value: HOOK_TEXT });
  });

  it('quotes a path with a space, a command substitution and a quote, so that the shell reads each path as one word', () => {
    const text = guardHookText(["/opt/my node/bin/node", "/opt/$(touch x)/it's/cli.js"]);
    expect(text).toEqual({
      ok: true,
      value: `#!/bin/sh\n${stateGuard.comment}\nexec '/opt/my node/bin/node' '/opt/$(touch x)/it'\\''s/cli.js' state guard\n`,
    });
  });

  it.each([
    ['an empty list', []],
    ['one word', ['/opt/fake/bin/node']],
    ['three words', ['/a/node', '/a/cli.js', '/a/more']],
    ['a script path that is not absolute', ['/opt/fake/bin/node', 'cli.js']],
    ['a node path that is not absolute', ['node', '/opt/fake/lib/cli.js']],
  ])('refuses %s with exit 4 and a remedy, and builds no text', (_name, argv) => {
    const error = failureOf(guardHookText(argv));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('upgrade');
  });
});

describe('the install of the guard (TP-1)', () => {
  it('writes the package text as pre-commit in the guard folder of the git folder, with mode 755, and nothing else', async () => {
    const { deps } = await installed();
    expect(deps.files.get(HOOK)).toBe(HOOK_TEXT);
    expect(deps.modes.get(HOOK)).toBe(0o755);
    expect(await entriesOf(deps, GUARD)).toEqual([stateGuard.hookFile]);
    expect(deps.atomicWrites).toEqual([HOOK]);
  });

  it('keeps the guard folder out of the folder hooks, and inside the git folder, which git does not track', async () => {
    const { deps } = await installed();
    expect(GUARD).not.toContain('/hooks');
    expect([...deps.files.keys()].every((path) => path.startsWith(`${GIT_DIR}/`))).toBe(true);
  });

  it('sets core.hooksPath to the absolute path of the guard folder', async () => {
    const { gitCommands } = await installed();
    expect(gitCommands()).toContain(`config -- core.hooksPath ${GUARD}`);
  });

  it('names the final state folder in the setting when the install runs in the staging folder (TP-3)', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const made = make();
    made.deps.seedDir(`${staging}/.git`);
    const result = await installGuard(made.deps, staging, STATE);
    expect(result.ok).toBe(true);
    expect(made.deps.files.get(`${staging}/.git/${stateGuard.folder}/${stateGuard.hookFile}`)).toBe(HOOK_TEXT);
    expect(made.gitCommands()).toContain(`config -- core.hooksPath ${GUARD}`);
    expect(made.gitCommands().join('\n')).not.toContain('tmp-4242/.git/factory-guard');
  });

  it('removes every other entry of the guard folder, also a folder with files, and writes the package text over an old hook', async () => {
    const made = make();
    made.deps.seed(HOOK, 'old text\n');
    made.deps.seed(`${GUARD}/extra.sh`, 'x');
    made.deps.seed(`${GUARD}/sub/deep.txt`, 'y');
    const result = await installGuard(made.deps, STATE, STATE);
    expect(result.ok).toBe(true);
    expect(await entriesOf(made.deps, GUARD)).toEqual([stateGuard.hookFile]);
    expect(made.deps.files.get(HOOK)).toBe(HOOK_TEXT);
    expect([...made.deps.files.keys()].some((path) => path.includes('deep.txt'))).toBe(false);
  });

  it('is the same when it runs twice', async () => {
    const made = await installed();
    expect((await installGuard(made.deps, STATE, STATE)).ok).toBe(true);
    expect(made.deps.files.get(HOOK)).toBe(HOOK_TEXT);
    expect(await guardStateOf(made.deps, STATE)).toEqual({ ok: true, value: { on: true } });
  });

  it('stops with a failure when git cannot set the setting', async () => {
    const made = make({
      answer: (call) => (withoutStateWords(call.args).slice(2).join(' ').startsWith('config --') ? exited(255) : undefined),
    });
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('core.hooksPath');
  });
});

describe('the install of the guard stops before any change (TP-53)', () => {
  const unchanged = (made: Made, calls: number): void => {
    expect(made.deps.atomicWrites).toEqual([]);
    expect(made.gitCommands().filter((command) => command.startsWith('config --'))).toEqual([]);
    expect(made.deps.calls.length).toBeLessThanOrEqual(calls);
  };

  it('refuses a guard folder that is a link to another folder, and leaves the other folder as it was', async () => {
    const made = make({ links: { [GUARD]: '/elsewhere/folder' } });
    made.deps.seed('/elsewhere/folder/keep.txt', 'keep');
    made.deps.seed('/elsewhere/folder/pre-commit', 'other hook');
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toBe(stateGuard.remedy);
    expect(made.deps.files.get('/elsewhere/folder/keep.txt')).toBe('keep');
    expect(made.deps.files.get('/elsewhere/folder/pre-commit')).toBe('other hook');
    expect(await entriesOf(made.deps, '/elsewhere/folder')).toEqual(['keep.txt', 'pre-commit']);
    unchanged(made, 2);
  });

  it('refuses a guard folder that is a file', async () => {
    const made = make();
    made.deps.seed(GUARD, 'not a folder');
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.files.get(GUARD)).toBe('not a folder');
    unchanged(made, 2);
  });

  it('refuses a .git entry that is a link', async () => {
    const made = make();
    const error = failureOf(await installGuard(linkAt(made.deps, GIT_DIR), STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toBe(stateGuard.remedy);
    unchanged(made, 2);
  });

  it('refuses a git folder that is not the folder .git inside the state folder', async () => {
    const made = make({ fixture: { gitDirs: { [STATE]: '/elsewhere/.git' } } });
    made.deps.seedDir('/elsewhere/.git');
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(made.deps.dirs.has('/elsewhere/.git/factory-guard')).toBe(false);
    unchanged(made, 2);
  });

  it('refuses a guard folder with more entries than the install removes, and removes none', async () => {
    const made = make();
    for (let at = 0; at <= stateGuard.maxEntries; at += 1) made.deps.seed(`${GUARD}/f${at}`, 'x');
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect((await entriesOf(made.deps, GUARD)).length).toBe(stateGuard.maxEntries + 1);
    unchanged(made, 2);
  });

  it('refuses when the program path is not known, and runs no git command', async () => {
    const made = make({ programArgv: [] });
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('upgrade');
    expect(made.deps.calls).toEqual([]);
    expect(made.deps.atomicWrites).toEqual([]);
  });
});

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
const OFF_CASES: readonly (readonly [string, GuardOffKind, Change])[] = [
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

describe('the state of the guard (TP-11)', () => {
  it('is on after an install', async () => {
    const { deps } = await installed();
    expect(await guardStateOf(deps, STATE)).toEqual({ ok: true, value: { on: true } });
  });

  it('is off, with the setting unset, in a state repo that has no guard', async () => {
    const { deps } = make();
    const state = await guardStateOf(deps, STATE);
    expect(state).toMatchObject({ ok: true, value: { on: false, kind: 'hooks-path' } });
  });

  it('is off when the git folder is not the folder .git inside the state folder', async () => {
    const { deps } = make({ fixture: { gitDirs: { [STATE]: '/elsewhere/.git' } } });
    expect(await guardStateOf(deps, STATE)).toMatchObject({ ok: true, value: { on: false, kind: 'git-folder' } });
  });

  it.each(OFF_CASES)('is off for %s', async (_name, kind, mutate) => {
    const made = await installed();
    const changed = await mutate(made);
    const state = await guardStateOf(changed, STATE);
    expect(state).toMatchObject({ ok: true, value: { on: false, kind } });
    if (state.ok && !state.value.on) expect(state.value.why).not.toBe('');
  });

  it('is a failure, never "on", when git cannot read the setting', async () => {
    const made = await installed();
    const broken = { ...made.deps, run: async () => exited(128, '', 'fatal: broken') };
    const state = await guardStateOf(broken, STATE);
    expect(state.ok).toBe(false);
  });
});

describe('the refusal of an off guard (TP-11)', () => {
  it('passes when the guard is on', async () => {
    const { deps } = await installed();
    expect(await requireGuardOn(deps, STATE)).toEqual({ ok: true, value: undefined });
  });

  it.each(OFF_CASES)('refuses with exit 4 and the remedy factory upgrade for %s, and writes nothing', async (_name, _kind, mutate) => {
    const made = await installed();
    const changed = await mutate(made);
    const before = { files: new Map(made.deps.files), writes: made.deps.atomicWrites.length, config: made.gitCommands().filter((c) => c.startsWith('config --')).length };
    const error = failureOf(await requireGuardOn(changed, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('the delete guard');
    expect(error.hint).toBe('Run "factory upgrade".');
    expect(made.deps.files).toEqual(before.files);
    expect(made.deps.atomicWrites.length).toBe(before.writes);
    expect(made.gitCommands().filter((c) => c.startsWith('config --')).length).toBe(before.config);
  });
});
