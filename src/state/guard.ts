import { basename, dirname, isAbsolute, join } from 'node:path';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { absoluteGitDirOf, GIT_ENTRY, setStateConfig, stateConfigValue, unsetStateConfig } from '../core/git.js';
import { comparable } from '../core/paths.js';
import { err, ok } from '../core/result.js';
import { shellWord } from '../core/shell-word.js';
import { commands, dirs, program, stateCommands, stateGuard } from '../names.js';

/** The node program and the script: the two words that start this program again. */
const PROGRAM_WORDS = 2;

/** The guard folder as a message shows it: relative to the factory folder, for example `.factory/.git/factory-guard`. */
export const guardFolderLabel = join(dirs.state, GIT_ENTRY, stateGuard.folder);

/**
 * The text of the delete guard hook: a shell script that starts this program with the words `state guard`. The node program and the
 * script are written by their absolute paths, so the hook never reads PATH. Each word is quoted for the shell, so a path with a
 * space or a `$(` stays one word. A program path that is not known (an empty list) or not absolute gives no text: a hook that names
 * no program can not check anything.
 */
export const guardHookText = (programArgv: readonly string[]): CliResult<string> => {
  if (programArgv.length !== PROGRAM_WORDS || !programArgv.every((word) => isAbsolute(word))) {
    return safetyRefusal(
      `${program} does not know the absolute path of its own program, so it writes no hook that starts it`,
      `Start ${program} through its installed command. ${stateGuard.remedy}`,
    );
  }
  const words = [...programArgv, commands.state, stateCommands.guard].map(shellWord).join(' ');
  return ok(`${stateGuard.interpreter}\n${stateGuard.comment}\nexec ${words}\n`);
};

/** Why the guard is off. */
export type GuardOffKind =
  | 'program-unknown'
  | 'git-folder'
  | 'hooks-path'
  | 'folder-missing'
  | 'folder-not-plain'
  | 'extra-entry'
  | 'hook-missing'
  | 'hook-not-plain'
  | 'hook-mode'
  | 'hook-bytes';

export type GuardState =
  | { readonly on: true }
  /** `why` is one sentence for a message. */
  | { readonly on: false; readonly kind: GuardOffKind; readonly why: string };

const off = (kind: GuardOffKind, why: string): CliResult<GuardState> => ok({ on: false, kind, why });

const hookName = stateGuard.hookFile;

/**
 * The git folder of the state repo as git prints it, when it is the folder `.git` inside `stateDir`: a real folder, not a link, and
 * the same folder as the real path of that entry. Null for a git file, a link, or any other git folder (for example one that
 * `GIT_DIR` names). The guard is written only into the git folder that the state folder owns.
 */
const ownGitFolderOf = async (deps: Deps, stateDir: string): Promise<CliResult<string | null>> => {
  const entry = join(stateDir, GIT_ENTRY);
  const kind = await deps.fs.lstat(entry);
  if (!kind.ok) return kind;
  if (kind.value !== 'dir') return ok(null);
  const [asked, real] = [await absoluteGitDirOf(deps, stateDir), await deps.fs.realpath(entry)];
  if (!asked.ok) return asked;
  if (!real.ok) return real;
  return ok(comparable(deps, asked.value) === comparable(deps, real.value) ? asked.value : null);
};

const gitFolderRefusal = (stateDir: string): CliResult<never> =>
  safetyRefusal(`the git folder of ${stateDir} is not the folder ${GIT_ENTRY} inside it, so ${program} writes no guard there`, stateGuard.remedy);

const folderRefusal = (folder: string, what: string): CliResult<never> =>
  safetyRefusal(`the guard folder ${folder} ${what}, so ${program} changes nothing in it`, stateGuard.remedy);

/**
 * The path that `core.hooksPath` gets: the guard folder of the final state folder. In the staging folder of `init` the state folder
 * has another name until the rename, so the path is built from the real folder above the final state folder.
 */
const hooksPathOf = async (deps: Deps, stateDir: string, finalStateDir: string, gitDir: string): Promise<CliResult<string>> => {
  if (stateDir === finalStateDir) return ok(join(gitDir, stateGuard.folder));
  const parent = await deps.fs.realpath(dirname(finalStateDir));
  return parent.ok ? ok(join(parent.value, basename(finalStateDir), GIT_ENTRY, stateGuard.folder)) : parent;
};

/**
 * Make the guard folder hold the hook file and nothing else. The folder is checked first: a link, or anything that is not a folder, is
 * a stop (exit 4) before any entry is removed. A folder with many entries is a stop too. An entry is removed by its name inside the real
 * folder, and a link is removed itself, never followed. A hook file that is not a plain file is removed too.
 */
const prepareGuardFolder = async (deps: Deps, folder: string): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(folder);
  if (!kind.ok) return kind;
  if (kind.value === 'link') return folderRefusal(folder, 'is a link');
  if (kind.value !== null && kind.value !== 'dir') return folderRefusal(folder, 'is not a folder');
  const listed = kind.value === 'dir' ? await deps.fs.list(folder) : ok<readonly string[]>([]);
  if (!listed.ok) return listed;
  if (listed.value.length > stateGuard.maxEntries) {
    return folderRefusal(folder, `holds more than ${stateGuard.maxEntries} entries`);
  }
  if (kind.value === null) {
    const made = await deps.fs.mkdir(folder, stateGuard.folderMode);
    if (!made.ok) return made;
    // A link can take the place of the new folder before the next check.
    const again = await deps.fs.lstat(folder);
    if (!again.ok) return again;
    if (again.value !== 'dir') return folderRefusal(folder, 'is not a folder');
  }
  const real = await deps.fs.realpath(folder);
  if (!real.ok) return real;
  if (comparable(deps, real.value) !== comparable(deps, folder)) return folderRefusal(folder, 'is not at its real path');
  for (const name of listed.value) {
    const entry = join(folder, name);
    if (name === hookName) {
      const hook = await deps.fs.lstat(entry);
      if (!hook.ok) return hook;
      if (hook.value === 'file') continue;
    }
    const removed = await deps.fs.remove(entry);
    if (!removed.ok) return removed;
  }
  return ok(undefined);
};

/**
 * Write the guard into the state repo `stateDir`: the hook file from the package text in the guard folder of the git folder (mode
 * 755), then the setting `core.hooksPath` with the absolute path of that folder inside `finalStateDir`. `finalStateDir` is the state
 * folder as it is after a rename of the staging folder; it equals `stateDir` for a state folder that stays in place.
 * Every refusal is exit 4 and comes before the first change: a program path that is not known, a git folder that is not the folder
 * `.git` of the state folder, a guard folder that is a link or not a folder. A failed write or setting is exit 1; the next install
 * repairs the part that is left.
 */
export const installGuard = async (deps: Deps, stateDir: string, finalStateDir: string): Promise<CliResult<void>> => {
  const text = guardHookText(deps.programArgv);
  if (!text.ok) return text;
  const gitDir = await ownGitFolderOf(deps, stateDir);
  if (!gitDir.ok) return gitDir;
  if (gitDir.value === null) return gitFolderRefusal(stateDir);
  const folder = join(gitDir.value, stateGuard.folder);
  const hooksPath = await hooksPathOf(deps, stateDir, finalStateDir, gitDir.value);
  if (!hooksPath.ok) return hooksPath;
  const prepared = await prepareGuardFolder(deps, folder);
  if (!prepared.ok) return prepared;
  const written = await deps.fs.writeTextAtomic(join(folder, hookName), text.value, gitDir.value, stateGuard.hookMode);
  if (!written.ok) return written;
  return setStateConfig(deps, stateDir, stateGuard.hooksPathKey, hooksPath.value);
};

/**
 * Remove the guard folder. The folder is checked first: a link is removed itself and never followed, and a folder is removed only at
 * its real path. A path that is not there is as wanted already.
 */
const removeGuardFolder = async (deps: Deps, folder: string): Promise<CliResult<void>> => {
  const kind = await deps.fs.lstat(folder);
  if (!kind.ok) return kind;
  if (kind.value === null) return ok(undefined);
  if (kind.value === 'dir') {
    const real = await deps.fs.realpath(folder);
    if (!real.ok) return real;
    if (comparable(deps, real.value) !== comparable(deps, folder)) return folderRefusal(folder, 'is not at its real path');
  }
  return deps.fs.remove(folder);
};

/** The two parts of an install that a failed run puts back. */
export interface GuardChange {
  /**
   * Put the guard back as it was before the install: the old setting (or none), and the old guard folder (or none). Every step runs;
   * the first failure is the result.
   */
  readonly undo: () => Promise<CliResult<void>>;
  /** The install stays: remove the copy of the old guard folder. */
  readonly keep: () => Promise<CliResult<void>>;
}

interface GuardBefore {
  readonly folder: string;
  /** The copy of the old guard folder, or null when the folder was not a folder before. */
  readonly copy: string | null;
  /** True when the install may have created or replaced the guard folder. */
  readonly changesFolder: boolean;
  /** The value of the setting in the config file of the state folder, or null when it had none. */
  readonly hooksPath: string | null;
}

const putGuardBack = async (deps: Deps, stateDir: string, before: GuardBefore): Promise<CliResult<void>> => {
  const problems: string[] = [];
  const note = (result: CliResult<unknown>): void => {
    if (!result.ok) problems.push(result.error.message);
  };
  if (before.changesFolder) {
    const removed = await removeGuardFolder(deps, before.folder);
    note(removed);
    if (removed.ok && before.copy !== null) note(await deps.fs.rename(before.copy, before.folder));
  }
  const now = await stateConfigValue(deps, stateDir, stateGuard.hooksPathKey, 'local');
  if (!now.ok) note(now);
  else if (now.value !== before.hooksPath) {
    note(
      before.hooksPath === null
        ? await unsetStateConfig(deps, stateDir, stateGuard.hooksPathKey)
        : await setStateConfig(deps, stateDir, stateGuard.hooksPathKey, before.hooksPath),
    );
  }
  return problems.length === 0 ? ok(undefined) : failure(problems.join('; '));
};

/**
 * Move the real guard folder to its copy name, after the same checks as the install makes: a folder with too many entries or at
 * another real path is a stop (exit 4) before any change. A copy of an earlier run that is still there is removed first.
 */
const setFolderAside = async (deps: Deps, folder: string, copy: string): Promise<CliResult<void>> => {
  const listed = await deps.fs.list(folder);
  if (!listed.ok) return listed;
  if (listed.value.length > stateGuard.maxEntries) return folderRefusal(folder, `holds more than ${stateGuard.maxEntries} entries`);
  const real = await deps.fs.realpath(folder);
  if (!real.ok) return real;
  if (comparable(deps, real.value) !== comparable(deps, folder)) return folderRefusal(folder, 'is not at its real path');
  const stale = await deps.fs.remove(copy);
  return stale.ok ? deps.fs.rename(folder, copy) : stale;
};

/**
 * `installGuard` for a state repo that stays in place, with an undo. An old guard folder is kept as a copy beside it until `keep`
 * runs, so `undo` puts the folder back as it was; an old setting in the config file of the state folder is read first and put back
 * too. An install that fails undoes itself. A refusal (exit 4) comes before any change. The undo follows the rules of the install:
 * a link is never followed, and a folder is removed only at its real path.
 */
export const installGuardWithUndo = async (deps: Deps, stateDir: string): Promise<CliResult<GuardChange>> => {
  const gitDir = await ownGitFolderOf(deps, stateDir);
  if (!gitDir.ok) return gitDir;
  if (gitDir.value === null) return gitFolderRefusal(stateDir);
  const folder = join(gitDir.value, stateGuard.folder);
  const copy = `${folder}${stateGuard.copyWord}${deps.pid}`;
  const hooksPath = await stateConfigValue(deps, stateDir, stateGuard.hooksPathKey, 'local');
  if (!hooksPath.ok) return hooksPath;
  const kind = await deps.fs.lstat(folder);
  if (!kind.ok) return kind;
  const copied = kind.value === 'dir';
  if (copied) {
    const aside = await setFolderAside(deps, folder, copy);
    if (!aside.ok) return aside;
  }
  const before: GuardBefore = {
    folder,
    copy: copied ? copy : null,
    changesFolder: kind.value === null || copied,
    hooksPath: hooksPath.value,
  };
  const undo = (): Promise<CliResult<void>> => putGuardBack(deps, stateDir, before);
  const installed = await installGuard(deps, stateDir, stateDir);
  if (!installed.ok) {
    const undone = await undo();
    return undone.ok
      ? installed
      : err({ ...installed.error, message: `${installed.error.message}. Putting the guard back failed too: ${undone.error.message}` });
  }
  return ok({ undo, keep: async () => (copied ? deps.fs.remove(copy) : ok(undefined)) });
};

/**
 * Whether the guard of the state repo `stateDir` is on. It is on when all of these hold: the program path is known; the git folder is the
 * folder `.git` of the state folder; `core.hooksPath` (as git reads it, with every config level) is the guard folder; the guard folder is
 * a real folder that holds the hook file and nothing else; the hook file is a plain file with mode 755; and its bytes are the package
 * text for this program path. Any other case is off, with the first reason found. A read that fails is an error, never "on". A moved
 * package or a moved state folder is off until the guard is installed again.
 */
export const guardStateOf = async (deps: Deps, stateDir: string): Promise<CliResult<GuardState>> => {
  const expected = guardHookText(deps.programArgv);
  if (!expected.ok) return off('program-unknown', `${program} does not know the absolute path of its own program`);
  const gitDir = await ownGitFolderOf(deps, stateDir);
  if (!gitDir.ok) return gitDir;
  if (gitDir.value === null) return off('git-folder', `the git folder of ${dirs.state} is not the folder ${GIT_ENTRY} inside it`);

  const folder = join(gitDir.value, stateGuard.folder);
  const configured = await stateConfigValue(deps, stateDir, stateGuard.hooksPathKey);
  if (!configured.ok) return configured;
  if (configured.value !== folder) {
    const found = configured.value === null ? 'is not set' : `is ${JSON.stringify(configured.value)}`;
    return off('hooks-path', `${stateGuard.hooksPathKey} ${found}, not the guard folder`);
  }

  const folderKind = await deps.fs.lstat(folder);
  if (!folderKind.ok) return folderKind;
  if (folderKind.value === null) return off('folder-missing', `the guard folder ${folder} is missing`);
  if (folderKind.value !== 'dir') return off('folder-not-plain', `the guard folder ${folder} is a link or not a folder`);
  const names = await deps.fs.list(folder);
  if (!names.ok) return names;
  if (!names.value.includes(hookName)) return off('hook-missing', `the hook file ${hookName} is missing`);
  if (names.value.length > 1) return off('extra-entry', `the guard folder holds a file other than ${hookName}`);

  const hook = join(folder, hookName);
  const hookKind = await deps.fs.lstat(hook);
  if (!hookKind.ok) return hookKind;
  if (hookKind.value !== 'file') return off('hook-not-plain', `the hook file ${hookName} is a link or not a file`);
  const info = await deps.fs.statInfo(hook);
  if (!info.ok) return info;
  if (info.value?.mode !== stateGuard.hookMode) return off('hook-mode', `the hook file ${hookName} does not have mode ${stateGuard.hookMode.toString(8)}`);
  const text = await deps.fs.readTextLimited(hook, Buffer.byteLength(expected.value, 'utf8'));
  if (!text.ok || text.value !== expected.value) return off('hook-bytes', `the hook file ${hookName} differs from the text of the package`);
  return ok({ on: true });
};

/**
 * Why the guard of the state folder `stateDir` is off, or null when there is nothing to report. A folder with no `.git` entry is no
 * repo, so there is nothing to guard and no git command runs; the check of the state repo names that case where a command needs the
 * repo. Any other `.git` entry (a link, a git file, a folder) gets the full check. A read that fails is an error, never null.
 */
const guardOffWhy = async (deps: Deps, stateDir: string): Promise<CliResult<string | null>> => {
  const entry = await deps.fs.lstat(join(stateDir, GIT_ENTRY));
  if (!entry.ok) return entry;
  if (entry.value === null) return ok(null);
  const state = await guardStateOf(deps, stateDir);
  if (!state.ok) return state;
  return ok(state.value.on ? null : state.value.why);
};

/**
 * Whether a tool that writes the guard has work to do in the state folder `stateDir`: the folder has a `.git` entry and the guard is
 * off. The write then repairs the guard or stops with exit 4. A read that fails is an error, never "no".
 */
export const guardNeedsInstall = async (deps: Deps, stateDir: string): Promise<CliResult<boolean>> => {
  const why = await guardOffWhy(deps, stateDir);
  return why.ok ? ok(why.value !== null) : why;
};

/**
 * The warning line for a command that only warns about the guard of the state folder `stateDir` (`doctor` and `start`), or null when
 * the guard is on or the folder has no repo. An off guard names its reason and the remedy. A read that fails gives a line too: the
 * guard is then not known to be on, and the command goes on.
 */
export const guardWarning = async (deps: Deps, stateDir: string): Promise<string | null> => {
  const why = await guardOffWhy(deps, stateDir);
  if (!why.ok) return `The delete guard of ${dirs.state} is not checked: ${why.error.message}`;
  return why.value === null ? null : `The delete guard of ${dirs.state} is off: ${why.value}. ${stateGuard.remedy}`;
};

/**
 * Stop (exit 4) when the guard is off, with the remedy that repairs it. A tool that commits to the state repo asks this before it
 * writes. It reads only.
 */
export const requireGuardOn = async (deps: Deps, stateDir: string): Promise<CliResult<void>> => {
  const state = await guardStateOf(deps, stateDir);
  if (!state.ok) return state;
  return state.value.on ? ok(undefined) : safetyRefusal(`the delete guard of ${dirs.state} is off: ${state.value.why}`, stateGuard.remedy);
};
