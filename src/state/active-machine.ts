import { z } from 'zod';
import { failure, type CliError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { commitPaths, requireStateRepoCommit, unstagePaths, type RepoPaths } from '../core/git.js';
import { ok } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { activeMachine, commands, commandText, files, places, schemaIds, type CommandName } from '../names.js';
import { readCheckedFile } from '../workers/registry.js';
import { layoutOf, type Layout } from './layout.js';
import { parseJsonText } from './load.js';

/**
 * The mark of the active machine (design 4.3). `start` writes it when it starts the session, and it names the machine that runs
 * the factory now: a UUID that this machine made once (`machineIdOf`) and the time. The state repo tracks the mark, so a machine
 * that pulls the state can see which machine ran last. A mark never stops a command: a mark of another machine, or a mark that
 * can not be written, is a warning.
 */

const keys = activeMachine.keys;

/** The count of tries to read or make the id file. The second try reads the file of a writer that was faster. */
const MAX_ID_ATTEMPTS = 2;

/** The bits of a UUID of version 4: the version digit, and the two high bits of the variant digit. */
const VERSION_DIGIT = '4';
const VARIANT_LOW_BITS = 0x3;
const VARIANT_HIGH_BITS = 0x8;
const HEX = 16;

const markSchema = z.strictObject({
  [keys.schema]: z.literal(schemaIds.activeMachine),
  [keys.machine]: z.string().regex(activeMachine.idPattern, 'must be a UUID with lower case letters'),
  [keys.at]: z.iso.datetime(),
});

export interface ActiveMark {
  /** The id of the machine that wrote the mark. */
  readonly machine: string;
  /** The time of the write, as an ISO text. */
  readonly at: string;
}

/** What the file of the mark holds: nothing, a valid mark, or a file that can not be used and the reason. */
export type MarkRead =
  | { readonly state: 'absent' }
  | { readonly state: 'valid'; readonly mark: ActiveMark; readonly text: string }
  /** `text` is null when the file is not a plain file (a link, a folder, too large): it is never replaced. */
  | { readonly state: 'invalid'; readonly reason: string; readonly text: string | null };

/** What `claimActiveMachine` did: `claimed` is true when the mark names this machine and the state repo holds the commit. */
export interface ClaimOutcome {
  readonly claimed: boolean;
  /** The mark of another machine that the claim found, or null. */
  readonly other: ActiveMark | null;
}

/** What `clearActiveMark` did: it removed the mark of this machine, there was none, or the mark names another machine. */
export type ClearOutcome = 'cleared' | 'absent' | 'other';

/** The shape of a version 4 UUID from `hex`, which holds 32 hex digits. */
const uuidOf = (hex: string): string => {
  const variant = ((Number.parseInt(hex.charAt(16), HEX) & VARIANT_LOW_BITS) | VARIANT_HIGH_BITS).toString(HEX);
  return [hex.slice(0, 8), hex.slice(8, 12), `${VERSION_DIGIT}${hex.slice(13, 16)}`, `${variant}${hex.slice(17, 20)}`, hex.slice(20, 32)].join('-');
};

/** The id in the id file, or null when there is no file. A file that holds no id is a failure: the id of a machine never changes by itself. */
const readId = async (deps: Deps, layout: Layout): Promise<CliResult<string | null>> => {
  const found = await readCheckedFile(
    deps,
    [{ path: layout.runtimeDir, what: 'the run-time folder' }],
    { path: layout.machineIdFile, what: 'the machine id file' },
    activeMachine.idMaxBytes,
  );
  if (!found.ok) return found;
  if (found.value.state === 'absent') return ok(null);
  if (found.value.state === 'invalid') return failure(`cannot use ${layout.machineIdFile}: ${found.value.reason}`);
  const { text } = found.value;
  const id = text.endsWith('\n') ? text.slice(0, -1) : text;
  return activeMachine.idPattern.test(id)
    ? ok(id)
    : failure(
        `cannot use ${layout.machineIdFile}: it does not hold a machine id`,
        `Remove the file. "${commandText(commands.start)}" makes a new id.`,
      );
};

/** Makes the id file with the exclusive create. The value is the new id, or null when another writer made the file first. */
const makeId = async (deps: Deps, layout: Layout): Promise<CliResult<string | null>> => {
  const random = deps.randomHex(activeMachine.idBytes);
  if (!random.ok) return random;
  const made = await deps.fs.mkdir(layout.runtimeDir, activeMachine.folderMode);
  if (!made.ok) return made;
  const id = uuidOf(random.value);
  const created = await deps.fs.writeTextExclusive(layout.machineIdFile, `${id}\n`, activeMachine.idFileMode);
  if (!created.ok) return created;
  return ok(created.value ? id : null);
};

/**
 * The id of this machine: a random UUID, made once. The id file is in the run-time folder, which the state repo never holds, so
 * the id stays with the machine. The file is made with the exclusive create: two runs that start together get one id, because
 * the run that loses the create reads the file of the winner. A file that holds no id, and a link, are failures.
 */
export const machineIdOf = async (deps: Deps, home: string): Promise<CliResult<string>> => {
  const layout = layoutOf(home);
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const found = await readId(deps, layout);
    if (!found.ok) return found;
    if (found.value !== null) return ok(found.value);
    const made = await makeId(deps, layout);
    if (!made.ok) return made;
    if (made.value !== null) return ok(made.value);
  }
  return failure(`cannot make ${layout.machineIdFile}: another process keeps making it`);
};

const invalid = (reason: string, text: string): CliResult<MarkRead> => ok({ state: 'invalid', reason, text });

/**
 * Read the mark. The state folder and the file are checked as `readCheckedFile` checks them: a link or a file of another kind is
 * invalid with no text. A text that does not pass the schema is invalid, and the text stays for a caller that puts it back.
 */
export const readActiveMark = async (deps: Deps, home: string): Promise<CliResult<MarkRead>> => {
  const layout = layoutOf(home);
  const found = await readCheckedFile(
    deps,
    [{ path: layout.stateDir, what: 'the state folder' }],
    { path: layout.activeMachineFile, what: 'the mark' },
    activeMachine.maxBytes,
  );
  if (!found.ok) return found;
  if (found.value.state === 'absent') return ok({ state: 'absent' });
  if (found.value.state === 'invalid') return ok({ state: 'invalid', reason: found.value.reason, text: null });
  const { text } = found.value;
  const json = parseJsonText(text);
  if (!json.ok) return invalid(json.error, text);
  const parsed = markSchema.safeParse(json.value);
  if (!parsed.success) return invalid(describeIssues(parsed.error), text);
  return ok({ state: 'valid', mark: { machine: parsed.data[keys.machine], at: parsed.data[keys.at] }, text });
};

/**
 * True when the mark is valid and names this machine. A mark or an id that can not be read counts as not naming it, and the claim
 * that follows reports the fault.
 */
export const markNamesThisMachine = async (deps: Deps, home: string): Promise<boolean> => {
  const machine = await machineIdOf(deps, home);
  const mark = await readActiveMark(deps, home);
  return machine.ok && mark.ok && mark.value.state === 'valid' && mark.value.mark.machine === machine.value;
};

const markTextOf = (machine: string, at: Date): string =>
  `${JSON.stringify({ [keys.schema]: schemaIds.activeMachine, [keys.machine]: machine, [keys.at]: at.toISOString() })}\n`;

/** The way out for a person when a mark names another machine. */
const STOP_OTHER_MACHINE = `Run "${commandText(commands.shutdown)}" in this ${places.folder} on that machine.`;

/** The warning for a mark that names another machine. */
const otherMachineWarning = (other: ActiveMark): string =>
  `The state shows another machine as the active one: ${other.machine}, since ${other.at}. ` +
  `Two machines that run one ${places.folder} can write the same branches. ${STOP_OTHER_MACHINE}`;

/** The warning for a mark that is not written: the reason, and the remedy of the error when it has one. */
const notMarked = (reason: string, hint?: string): string =>
  `The mark of the active machine is not written: ${reason}.${hint === undefined ? '' : ` ${hint}`}`;

const notMarkedBy = (error: CliError): string => notMarked(error.message, error.hint);

/**
 * Put the file of the mark back after a commit that failed: the text that it had, or no file when it had none. Then clear the
 * staged change of the file. The value is the reasons that a step failed, as text for the end of a message, or an empty text.
 */
const putBack = async (deps: Deps, layout: Layout, previous: string | null, paths: RepoPaths): Promise<string> => {
  const restored =
    previous === null
      ? await deps.fs.remove(layout.activeMachineFile)
      : await deps.fs.writeTextAtomic(layout.activeMachineFile, previous, layout.stateDir);
  const unstaged = await unstagePaths(deps, layout.stateDir, paths);
  const notes = [restored, unstaged].flatMap((step) => (step.ok ? [] : [step.error.message]));
  return notes.length === 0 ? '' : `. ${notes.join('; ')}`;
};

/** The state repo of the mark: the file is the only path that a commit of the mark takes. */
const MARK_PATHS: RepoPaths = { present: [files.activeMachine], gone: [] };

/**
 * Mark this machine as the active one: write the mark with the id of this machine and the time, and commit that file only. A
 * mark of another machine is a warning, printed before the write, and the mark is replaced all the same. Nothing here stops the
 * caller: a fault is a warning, and the value tells what happened. The state repo must be ready for the commit (a git repo with
 * an identity, no staged change, no change of the owner in the file of the mark), else the call writes nothing. A commit that
 * fails puts the file back as it was.
 */
export const claimActiveMachine = async (deps: Deps, home: string): Promise<ClaimOutcome> => {
  const layout = layoutOf(home);
  const id = await machineIdOf(deps, home);
  if (!id.ok) {
    deps.warn(notMarkedBy(id.error));
    return { claimed: false, other: null };
  }
  const read = await readActiveMark(deps, home);
  if (!read.ok) {
    deps.warn(notMarkedBy(read.error));
    return { claimed: false, other: null };
  }
  const other = read.value.state === 'valid' && read.value.mark.machine !== id.value ? read.value.mark : null;
  if (other !== null) deps.warn(otherMachineWarning(other));
  if (read.value.state === 'invalid') {
    if (read.value.text === null) {
      deps.warn(notMarked(`${layout.activeMachineFile} can not be replaced: ${read.value.reason}`));
      return { claimed: false, other };
    }
    deps.warn(`The mark ${layout.activeMachineFile} is not valid (${read.value.reason}), so this run replaces it.`);
  }

  const ready = await requireStateRepoCommit(deps, layout.stateDir, [files.activeMachine], 'this command', commands.start);
  if (!ready.ok) {
    deps.warn(notMarkedBy(ready.error));
    return { claimed: false, other };
  }
  const previous = read.value.state === 'absent' ? null : read.value.text;
  const written = await deps.fs.writeTextAtomic(layout.activeMachineFile, markTextOf(id.value, deps.now()), layout.stateDir);
  if (!written.ok) {
    deps.warn(notMarkedBy(written.error));
    return { claimed: false, other };
  }
  const committed = await commitPaths(deps, layout.stateDir, MARK_PATHS, activeMachine.commitMessages.set);
  if (committed.ok) return { claimed: true, other };
  deps.warn(notMarked(`${committed.error.message}${await putBack(deps, layout, previous, MARK_PATHS)}`));
  return { claimed: false, other };
};

/**
 * Clear the mark of this machine: remove the file and commit the removal of that file only. A mark of another machine stays, and
 * so does a missing mark. `command` is the command that a person runs again after a fix of the state repo. A failure leaves the
 * mark as it was.
 */
export const clearActiveMark = async (deps: Deps, home: string, command: CommandName): Promise<CliResult<ClearOutcome>> => {
  const layout = layoutOf(home);
  const read = await readActiveMark(deps, home);
  if (!read.ok) return read;
  if (read.value.state === 'absent') return ok('absent');
  if (read.value.state === 'invalid' && read.value.text === null) {
    return failure(`cannot clear ${layout.activeMachineFile}: ${read.value.reason}`);
  }
  if (read.value.state === 'valid') {
    const id = await machineIdOf(deps, home);
    if (!id.ok) return id;
    if (read.value.mark.machine !== id.value) return ok('other');
  }
  const ready = await requireStateRepoCommit(deps, layout.stateDir, [files.activeMachine], 'this command', command);
  if (!ready.ok) return ready;
  const removed = await deps.fs.remove(layout.activeMachineFile);
  if (!removed.ok) return removed;
  const committed = await commitPaths(deps, layout.stateDir, MARK_PATHS, activeMachine.commitMessages.clear);
  if (committed.ok) return ok('cleared');
  const notes = await putBack(deps, layout, read.value.text, MARK_PATHS);
  return failure(`${committed.error.message}${notes}`);
};
