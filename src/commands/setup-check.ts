import { join } from 'node:path';
import { safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { inFactorySession } from '../core/factory-session.js';
import { isWorkTreeRoot, trackedFilesOf } from '../core/git.js';
import { err, ok } from '../core/result.js';
import {
  namedItems,
  requireNoLinks,
  requireNoTrackedLinks,
  shownPath,
  TRACKED_CAP_MESSAGE,
  TRACKED_CAP_REMEDY,
  trackedSetOf,
} from '../core/root-paths.js';
import { acceptanceState, acceptSetup, manifestChange } from '../core/setup-acceptance.js';
import { commands, commandText, files, places, program, roles, setupAcceptance } from '../names.js';
import type { SetupTexts } from '../templates/types.js';
import { collectSetup, type CollectedSetup } from './init-received.js';

/**
 * The setup acceptance rule of `start`, `upgrade` and `doctor` (design 4.3). This module is the one owner of the
 * check: the subject of the acceptance, its state in the store, the words of each stop, and the accept step that a change
 * allows. The setup text goes into the instructions of the sessions, so it needs the `owner`'s acceptance of its hash.
 * `init` makes the first acceptance. These commands accept a change only on a terminal window, and never a first acceptance.
 */

/** The text of a stop and the line that names the fix. */
export interface SetupStop {
  readonly text: string;
  readonly remedy: string;
}

/**
 * What the store says about the subject of the acceptance:
 * - `empty`: the subject holds no file, so nothing needs an acceptance;
 * - `accepted`: the node id and the hash match an acceptance of this real folder;
 * - `unaccepted`: no acceptance exists for this real folder under any node id;
 * - `changed`: an older acceptance exists, and it does not match;
 * - `unusable`: the subject or the store cannot be read, and the error says why.
 */
export type SetupCheck =
  | { readonly kind: 'empty' }
  | { readonly kind: 'accepted'; readonly setup: CollectedSetup }
  | { readonly kind: 'unaccepted'; readonly setup: CollectedSetup; readonly stop: SetupStop }
  | { readonly kind: 'changed'; readonly setup: CollectedSetup; readonly stop: SetupStop }
  | { readonly kind: 'unusable'; readonly error: CliError; readonly stop: SetupStop };

const FIRST_REMEDY = `Run "${commandText(commands.init)}" in a terminal window and accept the files.`;
const CHANGE_REMEDY = `Run "${commandText(commands.start)}" or "${commandText(commands.upgrade)}" in a terminal window outside a ${places.session}.`;
const STORE_REMEDY = `Fix the problem that the error names, then run "${commandText(commands.init)}" in a terminal window.`;
const DOCTOR_REMEDY = `Run "${commandText(commands.doctor)}".`;

/** The reason that the record of an accept step holds. */
export const acceptReason = (command: string): string =>
  `the ${roles.owner} accepted these files in a terminal window with ${command}`;

const unusable = (error: CliError, remedy: string): SetupCheck => ({
  kind: 'unusable',
  error,
  stop: { text: error.message, remedy: error.hint ?? remedy },
});

const unusableStop = (text: string, remedy: string): SetupCheck => {
  const refused = safetyRefusal(text, remedy);
  return unusable(refused.error, remedy);
};

/** The stop for a root that is not the top folder of a git work tree, or whose files git cannot list. */
export const notListedStop = (home: string): SetupStop => ({
  text: `${home} is not the top folder of a git work tree, or git cannot list its files, so ${program} cannot list the files that git tracks`,
  remedy: `Get the ${places.folder} with "git clone", then run "${commandText(commands.init)}" in the cloned folder.`,
});

/**
 * Compare a set of files with the newest acceptance for this real folder. The set is read once, and the manifest and the
 * texts come from the same bytes. `received` names the kind of root in the words of the stops: a received root accepts
 * every file that git tracks, and an own root accepts its setup text.
 */
export const checkSetupSet = async (
  deps: Deps,
  request: {
    readonly home: string;
    readonly set: readonly string[];
    readonly node: string | null;
    readonly received: boolean;
  },
): Promise<SetupCheck> => {
  const { home, set, node, received } = request;
  if (set.length === 0) return { kind: 'empty' };
  const what = received ? 'the files that git tracks' : 'the setup text';
  if (node === null) {
    return unusableStop(
      `${what} cannot be checked against the setup acceptance, because ${files.config} is not valid`,
      `Fix ${files.config}, then run "${commandText(commands.doctor)}".`,
    );
  }
  const read = await collectSetup(deps, home, set, commands.doctor);
  if (!read.ok) return unusable(read.error, FIRST_REMEDY);
  const { entries, hash } = read.value.collected.manifest;
  if (entries.length === 0) return { kind: 'empty' };
  const state = await acceptanceState(deps, { root: home, node, hash });
  if (!state.ok) return unusable(state.error, STORE_REMEDY);
  const accepted = state.value;
  switch (accepted.state) {
    case 'accepted':
      return { kind: 'accepted', setup: read.value };
    case 'none':
      return {
        kind: 'unaccepted',
        setup: read.value,
        stop: {
          text: `the ${roles.owner} has not accepted ${what}: ${namedItems(entries.map((entry) => shownPath(entry.path)))}`,
          remedy: FIRST_REMEDY,
        },
      };
    case 'changed': {
      const change = manifestChange(accepted.record.manifest, entries);
      const paths = [...change.changed, ...change.added, ...change.removed].map(shownPath);
      return {
        kind: 'changed',
        setup: read.value,
        stop: {
          text:
            paths.length === 0
              ? `the ${roles.owner} accepted ${what} for another ${roles.node} id`
              : `${what} changed since the ${roles.owner} accepted ${received ? 'them' : 'it'}: ${namedItems(paths)}`,
          remedy: CHANGE_REMEDY,
        },
      };
    }
    default: {
      const unreachable: never = accepted;
      return unreachable;
    }
  }
};

/** The subject of an own root: the setup text files that are there. A link in their path is a stop (exit 4). */
const ownSetOf = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  const present: string[] = [];
  for (const path of setupAcceptance.setupTextFiles) {
    const kind = await deps.fs.lstat(join(home, path));
    if (!kind.ok) return kind;
    if (kind.value !== null) present.push(path);
  }
  const plain = await requireNoLinks(
    deps,
    home,
    present.map((path) => join(home, path)),
  );
  return plain.ok ? ok(present) : plain;
};

/** The subject of a received root: every path that git tracks, apart from the config and the ignore file. */
const trackedSetOfRoot = async (deps: Deps, home: string): Promise<CliResult<readonly string[]>> => {
  if (!(await isWorkTreeRoot(deps, home))) {
    const stop = notListedStop(home);
    return safetyRefusal(stop.text, stop.remedy);
  }
  const list = await trackedFilesOf(deps, home);
  if (!list.ok) return list;
  if (list.value.reachedCap) return safetyRefusal(TRACKED_CAP_MESSAGE, TRACKED_CAP_REMEDY);
  const set = trackedSetOf(list.value.paths);
  const plain = await requireNoTrackedLinks(deps, home, set);
  return plain.ok ? ok(set) : plain;
};

/**
 * The check of a root that the caller has not listed yet: it finds the subject by the origin of the root. `upgrade` uses
 * it. `start` and `doctor` list the tracked files for their other checks, so they call `checkSetupSet` with that list.
 */
export const checkRootSetup = async (
  deps: Deps,
  request: { readonly home: string; readonly node: string | null; readonly received: boolean },
): Promise<SetupCheck> => {
  const { home, node, received } = request;
  const set = received ? await trackedSetOfRoot(deps, home) : await ownSetOf(deps, home);
  return set.ok ? checkSetupSet(deps, { home, set: set.value, node, received }) : unusable(set.error, DOCTOR_REMEDY);
};

/**
 * True when this run may ask the `owner`: stdin and stdout are a terminal window, no factory session runs this process, and
 * it is not a dry run. The accept step of the writer checks the first two again.
 */
export const mayAsk = (deps: Deps, dryRun: boolean): boolean =>
  !dryRun && deps.stdinIsTTY && deps.stdoutIsTTY && !inFactorySession(deps);

/**
 * The setup texts that the blocks may use after the check, whether this run recorded an acceptance, and the warnings of the
 * write. A warning names a lock file that stays after a saved acceptance: the run goes on and prints it.
 */
export interface SettledSetup {
  readonly texts: SetupTexts;
  readonly accepted: boolean;
  readonly warnings: readonly string[];
}

const NO_TEXTS: SetupTexts = { coordinator: null, worker: null };

const NO_WARNINGS: readonly string[] = [];

const stopOf = (check: { readonly stop: SetupStop }): CliResult<never> => safetyRefusal(check.stop.text, check.stop.remedy);

/**
 * Settle the setup text before a command renders it:
 * - an empty subject needs nothing, and an accepted one gives its texts;
 * - a subject with no acceptance at all is a stop, because only `init` makes a first acceptance;
 * - a changed subject shows the change and asks (default no) when this run may ask, and writes the acceptance on yes. In
 *   every other case it is a stop that names the accept command, and it asks nothing and writes nothing.
 * The texts of the value are the bytes that the hash covers.
 */
export const settleSetup = async (
  deps: Deps,
  request: { readonly home: string; readonly node: string | null; readonly check: SetupCheck; readonly dryRun: boolean; readonly reason: string },
): Promise<CliResult<SettledSetup>> => {
  const { home, node, check, dryRun, reason } = request;
  switch (check.kind) {
    case 'empty':
      return ok({ texts: NO_TEXTS, accepted: false, warnings: NO_WARNINGS });
    case 'accepted':
      return ok({ texts: check.setup.texts, accepted: false, warnings: NO_WARNINGS });
    case 'unusable':
      return err(check.error);
    case 'unaccepted':
      return stopOf(check);
    case 'changed': {
      if (node === null || !mayAsk(deps, dryRun)) return stopOf(check);
      const answer = await acceptSetup(deps, {
        root: home,
        node,
        file: setupAcceptance.setupTextFiles[0],
        current: check.setup.collected,
        reason,
      });
      if (!answer.ok) return answer;
      if (!answer.value.accepted) return stopOf(check);
      return ok({
        texts: check.setup.texts,
        accepted: true,
        warnings: answer.value.warning === null ? NO_WARNINGS : [answer.value.warning],
      });
    }
    default: {
      const unreachable: never = check;
      return unreachable;
    }
  }
};
