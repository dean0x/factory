import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { setStateConfig } from '../../src/core/git.js';
import { stateGuard } from '../../src/names.js';
import {
  guardHookText,
  guardPlanOf,
  guardPlanWarnings,
  guardStateOf,
  guardWarning,
  installGuard,
  installGuardWithUndo,
  requireGuardOn,
} from '../../src/state/guard.js';
import { createFakeDeps, exited, FAKE_PROGRAM_ARGV } from '../helpers/fake-deps.js';
import { gitHandler, withoutStateWords } from '../helpers/git-fake.js';
import {
  GIT_DIR,
  GUARD,
  HAND_KINDS,
  HOME,
  HOOK,
  HOOKS,
  HOOK_TEXT,
  installed,
  linkAt,
  make,
  MERGE_HOOK,
  OFF_CASES,
  PATCH_HOOK,
  STATE,
  type Made,
} from '../helpers/guard-fixture.js';

const entriesOf = async (deps: Deps, path: string): Promise<readonly string[]> => {
  const listed = await deps.fs.list(path);
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.value;
};

const failureOf = <T>(result: CliResult<T>) => {
  if (result.ok) throw new Error('the call worked');
  return result.error;
};

describe('the text of the guard hook', () => {
  it('starts the node program and the script by their absolute paths, with the words state guard', () => {
    expect(guardHookText(FAKE_PROGRAM_ARGV)).toEqual({ ok: true, value: HOOK_TEXT });
  });

  it('quotes a path with a space, a command substitution and a quote, so that the shell reads each path as one word', () => {
    const text = guardHookText(["/opt/my node/bin/node", "/opt/$(touch x)/it's/cli.js"]);
    const [node, script] = ["'/opt/my node/bin/node'", "'/opt/$(touch x)/it'\\''s/cli.js'"];
    expect(text).toEqual({
      ok: true,
      value: [
        '#!/bin/sh',
        stateGuard.comment,
        `if [ ! -x ${node} ] || [ ! -f ${script} ]; then`,
        `  printf '%s\\n' '${stateGuard.programMissing}' >&2`,
        '  exit 1',
        'fi',
        `exec ${node} ${script} state guard`,
        '',
      ].join('\n'),
    });
  });

  it.each([
    ['an empty list', []],
    ['one word', ['/opt/fake/bin/node']],
    ['three words', ['/a/node', '/a/cli.js', '/a/more']],
    ['a script path that is not absolute', ['/opt/fake/bin/node', 'cli.js']],
    ['a node path that is not absolute', ['node', '/opt/fake/lib/cli.js']],
  ])('refuses %s with exit 4 and a remedy by hand, and builds no text', (_name, argv) => {
    const error = failureOf(guardHookText(argv));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Start factory through its installed command.');
    expect(error.hint).not.toContain('upgrade');
  });
});

describe('the install of the guard', () => {
  it('writes the package text as pre-commit, pre-merge-commit and pre-applypatch in the guard folder of the git folder, with mode 755, and nothing else', async () => {
    const { deps } = await installed();
    for (const hook of HOOKS) {
      expect(deps.files.get(hook)).toBe(HOOK_TEXT);
      expect(deps.modes.get(hook)).toBe(0o755);
    }
    expect(await entriesOf(deps, GUARD)).toEqual([...stateGuard.hookFiles].sort());
    expect(deps.atomicWrites).toEqual(HOOKS);
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

  it('names the final state folder in the setting when the install runs in the staging folder', async () => {
    const staging = `${HOME}/.factory.tmp-4242`;
    const made = make();
    made.deps.seedDir(`${staging}/.git`);
    const result = await installGuard(made.deps, staging, STATE);
    expect(result.ok).toBe(true);
    for (const name of stateGuard.hookFiles) {
      expect(made.deps.files.get(`${staging}/.git/${stateGuard.folder}/${name}`)).toBe(HOOK_TEXT);
    }
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
    expect(await entriesOf(made.deps, GUARD)).toEqual([...stateGuard.hookFiles].sort());
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

describe('the install of the guard stops before any change', () => {
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
    expect(error.hint).toBe('Move .factory/.git/factory-guard away. It must be a folder, not a link or a file.');
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
    expect(error.hint).toBe('Make .factory/.git the git folder of .factory. It must be a folder, not a file or a link.');
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
    expect(error.hint).toContain('Remove the entries of .factory/.git/factory-guard that are not hook files.');
    expect((await entriesOf(made.deps, GUARD)).length).toBe(stateGuard.maxEntries + 1);
    unchanged(made, 2);
  });

  it('refuses when the program path is not known, and runs no git command', async () => {
    const made = make({ programArgv: [] });
    const error = failureOf(await installGuard(made.deps, STATE, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.hint).toContain('Start factory through its installed command.');
    expect(made.deps.calls).toEqual([]);
    expect(made.deps.atomicWrites).toEqual([]);
  });

  it('refuses when the program path is not known before it moves an old guard folder, in the install with an undo', async () => {
    const made = make({ programArgv: [] });
    made.deps.seed(HOOK, 'old text\n');
    const moves: string[] = [];
    const deps: Deps = {
      ...made.deps,
      fs: {
        ...made.deps.fs,
        rename: async (from, to) => {
          moves.push(from);
          return made.deps.fs.rename(from, to);
        },
      },
    };
    const error = failureOf(await installGuardWithUndo(deps, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(moves).toEqual([]);
    expect(made.deps.files.get(HOOK)).toBe('old text\n');
    expect(made.deps.calls).toEqual([]);
  });
});

describe('the state of the guard', () => {
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

  it('is off for a guard that holds pre-commit only, and the install writes the other two files', async () => {
    const made = await installed();
    made.deps.files.delete(MERGE_HOOK);
    made.deps.files.delete(PATCH_HOOK);
    expect(await guardStateOf(made.deps, STATE)).toMatchObject({ ok: true, value: { on: false, kind: 'hook-missing' } });
    expect((await installGuard(made.deps, STATE, STATE)).ok).toBe(true);
    expect(made.deps.files.get(MERGE_HOOK)).toBe(HOOK_TEXT);
    expect(made.deps.files.get(PATCH_HOOK)).toBe(HOOK_TEXT);
    expect(await guardStateOf(made.deps, STATE)).toEqual({ ok: true, value: { on: true } });
  });

  it('is a failure, never "off" and never "on", when a hook file of the right size cannot be read', async () => {
    const made = await installed();
    const broken: Deps = { ...made.deps, fs: { ...made.deps.fs, readTextLimited: async (path) => failure(`cannot read ${path}: EIO`) } };
    const state = await guardStateOf(broken, STATE);
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.message).toContain('EIO');
  });

  it('is off for a hook file of another size, and reads no text of it', async () => {
    const made = await installed();
    made.deps.files.set(HOOK, `${HOOK_TEXT}more\n`);
    const reads: string[] = [];
    const counting: Deps = {
      ...made.deps,
      fs: {
        ...made.deps.fs,
        readTextLimited: async (path, maxBytes) => {
          reads.push(path);
          return made.deps.fs.readTextLimited(path, maxBytes);
        },
      },
    };
    expect(await guardStateOf(counting, STATE)).toMatchObject({ ok: true, value: { on: false, kind: 'hook-bytes' } });
    expect(reads).toEqual([]);
  });

  it('is a failure, never "on", when git cannot read the setting', async () => {
    const made = await installed();
    const broken = { ...made.deps, run: async () => exited(128, '', 'fatal: broken') };
    const state = await guardStateOf(broken, STATE);
    expect(state.ok).toBe(false);
  });
});

describe('the plan to write the guard', () => {
  it('is current when the guard is on', async () => {
    const { deps } = await installed();
    expect(await guardPlanOf(deps, STATE)).toEqual({ ok: true, value: { action: 'current' } });
  });

  it('is install for a state repo that has no guard', async () => {
    const { deps } = make();
    expect(await guardPlanOf(deps, STATE)).toEqual({ ok: true, value: { action: 'install', stops: [] } });
  });

  it.each(OFF_CASES.filter(([, kind]) => !HAND_KINDS.has(kind) && kind !== 'extra-entry'))('is install for %s', async (_name, _kind, mutate) => {
    const made = await installed();
    expect(await guardPlanOf(await mutate(made), STATE)).toMatchObject({ ok: true, value: { action: 'install' } });
  });

  it.each(OFF_CASES.filter(([, kind]) => kind === 'extra-entry'))('is install, and names the entry that stops, for %s', async (_name, _kind, mutate) => {
    const made = await installed();
    const plan = await guardPlanOf(await mutate(made), STATE);
    expect(plan).toMatchObject({ ok: true, value: { action: 'install', stops: [expect.stringContaining('.factory/.git/factory-guard/')] } });
  });

  it.each(OFF_CASES.filter(([, kind]) => HAND_KINDS.has(kind)))(
    'is unsupported, with the cause and a step that does not name the install, for %s',
    async (_name, _kind, mutate) => {
      const made = await installed();
      const plan = await guardPlanOf(await mutate(made), STATE);
      expect(plan).toMatchObject({ ok: true, value: { action: 'unsupported' } });
      if (!plan.ok || plan.value.action !== 'unsupported') return;
      expect(plan.value.why).not.toBe('');
      expect(plan.value.remedy).not.toContain('factory upgrade');
    },
  );

  it('is unsupported for a guard folder that is a link, also when the setting is not the guard folder', async () => {
    const made = make();
    expect(await guardPlanOf(linkAt(made.deps, GUARD), STATE)).toMatchObject({ ok: true, value: { action: 'unsupported' } });
  });

  it('is current for a state folder with no .git entry: there is no repo to guard, and no git command runs', async () => {
    const deps = createFakeDeps({ cwd: HOME, run: gitHandler().handler });
    deps.seedDir(STATE);
    expect(await guardPlanOf(deps, STATE)).toEqual({ ok: true, value: { action: 'current' } });
    expect(deps.calls).toEqual([]);
  });

  it('is a failure, never "current", when the entry can not be read', async () => {
    const { deps } = make();
    const broken: Deps = { ...deps, fs: { ...deps.fs, lstat: async (path) => failure(`cannot read ${path}: EIO`) } };
    expect((await guardPlanOf(broken, STATE)).ok).toBe(false);
  });
});

describe('the hooks that stop running when the guard is written', () => {
  const stopsOf = async (deps: Deps): Promise<readonly string[]> => {
    const plan = await guardPlanOf(deps, STATE);
    if (!plan.ok || plan.value.action !== 'install') throw new Error('the plan is not an install');
    return plan.value.stops;
  };

  it('names no hook for a state repo that has only the example files of git', async () => {
    const { deps } = make();
    deps.seed(`${GIT_DIR}/hooks/pre-commit.sample`, 'x');
    deps.seed(`${GIT_DIR}/hooks/pre-push.sample`, 'x');
    expect(await stopsOf(deps)).toEqual([]);
  });

  it('names a hook file of the default hooks folder, and not an example file', async () => {
    const { deps } = make();
    deps.seed(`${GIT_DIR}/hooks/pre-push`, '#!/bin/sh\n');
    deps.seed(`${GIT_DIR}/hooks/pre-commit.sample`, 'x');
    expect(await stopsOf(deps)).toEqual(['.factory/.git/hooks/pre-push']);
  });

  it('names the folder that a core.hooksPath of another level sets, and not the default hooks folder that it already replaces', async () => {
    const { deps } = make({ fixture: { otherLevelHooksPath: { [STATE]: '/global/hooks' } } });
    deps.seed(`${GIT_DIR}/hooks/pre-push`, '#!/bin/sh\n');
    expect(await stopsOf(deps)).toEqual(['the hooks in /global/hooks, which core.hooksPath names']);
  });

  it('names the folder that a core.hooksPath of the state repo sets to another folder', async () => {
    const made = await installed();
    expect((await setStateConfig(made.deps, STATE, 'core.hooksPath', '/other/hooks')).ok).toBe(true);
    expect(await stopsOf(made.deps)).toEqual(['the hooks in /other/hooks, which core.hooksPath names']);
  });

  it('names the entries of the guard folder that the install removes, and not the hook files of the package', async () => {
    const made = await installed();
    made.deps.files.set(HOOK, '#!/bin/sh\nexit 0\n');
    made.deps.seed(`${GUARD}/pre-push`, 'x');
    made.deps.seedDir(`${GUARD}/sub`);
    expect(await stopsOf(made.deps)).toEqual(['.factory/.git/factory-guard/pre-push', '.factory/.git/factory-guard/sub']);
  });

  it('reads only: it runs no hook, writes no setting and leaves every file as it was', async () => {
    const made = make({ fixture: { otherLevelHooksPath: { [STATE]: '/global/hooks' } } });
    made.deps.seed(`${GIT_DIR}/hooks/pre-push`, '#!/bin/sh\n');
    const before = new Map(made.deps.files);
    await guardPlanOf(made.deps, STATE);
    expect(new Map(made.deps.files)).toEqual(before);
    // Git is asked only for the value of the setting (and for the git folder): it writes nothing and starts no hook.
    const reads = ['config core.hooksPath', 'rev-parse --absolute-git-dir'];
    expect(made.gitCommands().filter((line) => !reads.includes(line))).toEqual([]);
    expect(made.deps.calls.filter((call) => call.command !== 'git')).toEqual([]);
  });

  it('names at most the bound of hook files of the default hooks folder', async () => {
    const { deps } = make();
    for (let at = 0; at < stateGuard.maxEntries + 10; at += 1) deps.seed(`${GIT_DIR}/hooks/hook-${String(at).padStart(3, '0')}`, 'x');
    expect(await stopsOf(deps)).toHaveLength(stateGuard.maxEntries);
  });

  it('is a failure, not an install with no hook named, when the default hooks folder can not be listed', async () => {
    const { deps } = make();
    deps.seed(`${GIT_DIR}/hooks/pre-push`, 'x');
    const broken: Deps = {
      ...deps,
      fs: { ...deps.fs, list: async (path) => (path === `${GIT_DIR}/hooks` ? failure(`cannot list ${path}: EIO`) : deps.fs.list(path)) },
    };
    expect(await guardPlanOf(broken, STATE)).toMatchObject({ ok: false });
  });

  it('is a failure, not an install with no hook named, when the second read of the setting fails', async () => {
    // The check of the guard reads the setting first. The read for the hooks that stop is the second one.
    let reads = 0;
    const { deps } = make({
      answer: (call) => {
        if (!call.args.includes('core.hooksPath')) return undefined;
        reads += 1;
        return reads === 2 ? exited(128, '', 'fatal: bad config') : undefined;
      },
    });
    expect(await guardPlanOf(deps, STATE)).toMatchObject({ ok: false });
    expect(reads).toBe(2);
  });
});

describe('the warnings of a plan to write the guard', () => {
  it('is none for a guard that is on and none for an install that stops no hook', () => {
    expect(guardPlanWarnings({ action: 'current' })).toEqual([]);
    expect(guardPlanWarnings({ action: 'install', stops: [] })).toEqual([]);
  });

  it('is one line that names each hook that stops, and the folder that git runs instead', () => {
    expect(guardPlanWarnings({ action: 'install', stops: ['.factory/.git/hooks/pre-push', '.factory/.git/hooks/commit-msg'] })).toEqual([
      'These hooks of .factory stop running when factory writes the delete guard: .factory/.git/hooks/pre-push, .factory/.git/hooks/commit-msg. ' +
        'Git runs only the hooks of .factory/.git/factory-guard, and factory runs no other hook.',
    ]);
  });

  it('counts the hooks past the five that it names', () => {
    const stops = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const [line] = guardPlanWarnings({ action: 'install', stops });
    expect(line).toContain('a, b, c, d, e and 2 more.');
  });

  it('is the cause and the step by hand for a guard that only a person can repair', () => {
    expect(guardPlanWarnings({ action: 'unsupported', why: 'the cause', remedy: 'Do the step.' })).toEqual([
      'The delete guard of .factory is off, and factory can not write it: the cause. Do the step.',
    ]);
  });
});

describe('the warning for a guard that is off', () => {
  it('names the remedy factory upgrade for a guard that the install repairs', async () => {
    const made = await installed();
    made.deps.files.delete(HOOK);
    expect(await guardWarning(made.deps, STATE)).toBe(
      `The delete guard of .factory is off: the hook file pre-commit is missing. ${stateGuard.remedy}`,
    );
  });

  it.each(OFF_CASES.filter(([, kind]) => HAND_KINDS.has(kind)))(
    'names the cause and a step by hand, and not the command that stops at it, for %s',
    async (_name, _kind, mutate) => {
      const made = await installed();
      const line = await guardWarning(await mutate(made), STATE);
      expect(line).toContain('The delete guard of .factory is off: ');
      expect(line).not.toContain('factory upgrade');
    },
  );
});

describe('the refusal of an off guard', () => {
  it('passes when the guard is on', async () => {
    const { deps } = await installed();
    expect(await requireGuardOn(deps, STATE)).toEqual({ ok: true, value: undefined });
  });

  it.each(OFF_CASES)('refuses with exit 4 and the remedy for %s, and writes nothing', async (_name, kind, mutate) => {
    const made = await installed();
    const changed = await mutate(made);
    const before = { files: new Map(made.deps.files), writes: made.deps.atomicWrites.length, config: made.gitCommands().filter((c) => c.startsWith('config --')).length };
    const error = failureOf(await requireGuardOn(changed, STATE));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain('the delete guard');
    if (HAND_KINDS.has(kind)) expect(error.hint).not.toContain('factory upgrade');
    else expect(error.hint).toBe('Run "factory upgrade".');
    expect(made.deps.files).toEqual(before.files);
    expect(made.deps.atomicWrites.length).toBe(before.writes);
    expect(made.gitCommands().filter((c) => c.startsWith('config --')).length).toBe(before.config);
  });
});
