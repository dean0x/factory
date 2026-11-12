import { join, resolve } from 'node:path';
import type { CliError } from '../cli/errors.js';
import { removedByDisplay } from '../cli/output.js';
import { accessFaultOf } from '../core/access.js';
import type { Deps } from '../core/deps.js';
import { err, ok, type Result } from '../core/result.js';
import { createInFolder } from '../core/safe-write.js';
import { address as addressNames, commands, files, messageFile, messageHeaderLines, nodeInbox, privateFile } from '../names.js';
import { ignoresLine, INBOX_GITIGNORE_LINE } from '../state/files.js';
import { readGitignore } from '../state/gitignore.js';
import { layoutOf, type Layout } from '../state/layout.js';
import { checkFileAddress } from './address.js';
import type { PingResult } from './transport.js';

/** What the sender gives to `deliver`. The sender sets `targetLayer` to its own layer minus 1. */
export interface DeliverInput {
  readonly senderId: string;
  readonly senderAddress: string;
  readonly targetId: string;
  readonly targetLayer: number;
  readonly body: string;
}

/**
 * What a delivery did. A result holds kinds and paths that this process made, and never text that came from the child.
 * `mismatch` holds the path of the file that stays when the removal failed, else null.
 */
export type DeliverResult =
  | { readonly kind: 'written'; readonly path: string }
  | { readonly kind: 'notAnswering' }
  | { readonly kind: 'mismatch'; readonly stranded: string | null }
  | { readonly kind: 'unsafe' }
  | { readonly kind: 'full' }
  | { readonly kind: 'notIgnored' }
  | { readonly kind: 'io' };

type Refusal = Exclude<DeliverResult, { readonly kind: 'written' }>;
type Step<T> = Result<T, Refusal>;
type Ping = (address: string) => Promise<PingResult>;

const NOT_ANSWERING: Refusal = { kind: 'notAnswering' };
const UNSAFE: Refusal = { kind: 'unsafe' };
const FULL: Refusal = { kind: 'full' };
const NOT_IGNORED: Refusal = { kind: 'notIgnored' };
const IO: Refusal = { kind: 'io' };

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** A header field is one line: no C0 or DEL control character (the line break and the tab too), and none that the screen hides. */
const holdsHiddenCharacter = (field: string): boolean => CONTROL_CHARACTER.test(field) || removedByDisplay(field);

/** A stop for safety is `unsafe`, and any other fault is `io`. The text of the fault is dropped. */
const faultOf = (error: CliError): Refusal => (error.kind === 'safety' ? UNSAFE : IO);

/**
 * Look at one path of the child with lstat. The value is false when nothing is there. A link, another owner and a write bit of
 * a group or of others give `unsafe`. A path of another kind than `kind` gives `wrongKind`.
 */
const inspectEntry = async (deps: Deps, path: string, kind: 'dir' | 'file', wrongKind: Refusal): Promise<Step<boolean>> => {
  const seen = await deps.fs.lstat(path);
  if (!seen.ok) return err(faultOf(seen.error));
  if (seen.value === null) return ok(false);
  if (seen.value === 'link') return err(UNSAFE);
  if (seen.value !== kind) return err(wrongKind);
  const info = await deps.fs.statInfo(path);
  if (!info.ok) return err(faultOf(info.error));
  if (info.value === null) return ok(false);
  return accessFaultOf(deps, info.value) === null ? ok(true) : err(UNSAFE);
};

/**
 * The real path of the home, found once. The home and factory.yaml are checked first, so no config is read before that. A path
 * that is not clean (a slash at the end, a `.` part, a double slash) is `unsafe`: the system follows a link in the last part of
 * such a path, so lstat would not see the link.
 */
const locateHome = async (deps: Deps, path: string): Promise<Step<string>> => {
  if (resolve(path) !== path) return err(UNSAFE);
  const home = await inspectEntry(deps, path, 'dir', NOT_ANSWERING);
  if (!home.ok) return home;
  if (!home.value) return err(NOT_ANSWERING);
  const real = await deps.fs.realpath(path);
  if (!real.ok) return err(faultOf(real.error));
  const config = await inspectEntry(deps, layoutOf(real.value).configFile, 'file', NOT_ANSWERING);
  if (!config.ok) return config;
  return config.value ? ok(real.value) : err(NOT_ANSWERING);
};

/** The state folder must be there already: this module never makes it. */
const requireState = async (deps: Deps, layout: Layout): Promise<Step<void>> => {
  const state = await inspectEntry(deps, layout.stateDir, 'dir', IO);
  if (!state.ok) return state;
  return state.value ? ok(undefined) : err(NOT_IGNORED);
};

/** The bytes of one name in the inbox. Only a regular file adds bytes. */
const bytesOf = async (deps: Deps, path: string): Promise<Step<number>> => {
  const seen = await deps.fs.lstat(path);
  if (!seen.ok) return err(faultOf(seen.error));
  if (seen.value !== 'file') return ok(0);
  const info = await deps.fs.statInfo(path);
  return info.ok ? ok(info.value?.size ?? 0) : err(faultOf(info.error));
};

/**
 * Check the inbox: its owner and mode first, then the count. The read stops at the cap of files, so the cost is bounded by the
 * cap. With the new file, the inbox must hold at most `maxFiles` files and `maxBytes` bytes. No inbox yet holds nothing.
 */
const requireRoom = async (deps: Deps, layout: Layout, incomingBytes: number): Promise<Step<void>> => {
  const inbox = await inspectEntry(deps, layout.inboxDir, 'dir', IO);
  if (!inbox.ok) return inbox;
  let bytes = incomingBytes;
  if (inbox.value) {
    const names = await deps.fs.listLimited(layout.inboxDir, nodeInbox.maxFiles);
    if (!names.ok) return err(faultOf(names.error));
    if (names.value.length >= nodeInbox.maxFiles) return err(FULL);
    for (const name of names.value) {
      const used = await bytesOf(deps, join(layout.inboxDir, name));
      if (!used.ok) return used;
      bytes += used.value;
    }
  }
  return bytes > nodeInbox.maxBytes ? err(FULL) : ok(undefined);
};

/** The state repo of the child must ignore the inbox. Git does not read a .gitignore that is a link, so such a file counts as none. */
const requireIgnored = async (deps: Deps, layout: Layout): Promise<Step<void>> => {
  const kind = await deps.fs.lstat(layout.stateGitignoreFile);
  if (!kind.ok) return err(faultOf(kind.error));
  if (kind.value === 'link') return err(NOT_IGNORED);
  const text = await readGitignore(deps, layout.stateGitignoreFile, files.gitignore, commands.node);
  if (!text.ok) return err(faultOf(text.error));
  return text.value !== null && ignoresLine(text.value, INBOX_GITIGNORE_LINE) ? ok(undefined) : err(NOT_IGNORED);
};

/** The name of a new message file: the time, the id of the sender and random hex. */
const nameOf = (deps: Deps, senderId: string): Step<string> => {
  const random = deps.randomHex(messageFile.randomBytes);
  if (!random.ok) return err(faultOf(random.error));
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  return ok(`${[stamp, senderId, random.value].join(messageFile.separator)}${messageFile.suffix}`);
};

/**
 * Create the file. The state folder is checked again just before, and the inbox is made without its parent. So a state folder
 * that went away is never made again: the fault is `io`.
 */
const writeMessage = async (deps: Deps, layout: Layout, name: string, text: string): Promise<Step<string>> => {
  const state = await requireState(deps, layout);
  if (!state.ok) return state;
  const target = { parent: layout.stateDir, folder: layout.inboxDir, name, mode: privateFile.fileMode, folderMode: privateFile.folderMode };
  const created = await createInFolder(deps, target, text);
  return created.ok ? ok(created.value) : err(faultOf(created.error));
};

/** Remove the file that this call made. The call removes a file or a link only, so a folder in its place stays. True when nothing of the file is left. */
const removeMade = async (deps: Deps, path: string): Promise<boolean> => (await deps.fs.removeFile(path)).ok;

const answersAsTarget = (answer: PingResult, input: DeliverInput): boolean =>
  answer.kind === 'known' && answer.id === input.targetId && answer.layer === input.targetLayer;

/**
 * Deliver a message file to the `.factory/inbox/` folder of the node at a `file://` address. `ping` is the ping of the
 * transport. The steps, in this order:
 *  1. The text of the header, with no control character and no character that the screen hides (else `io`).
 *  2. The real path of the home, found once. The path of the address must be clean, with no slash at the end and no `.` part
 *     (else `unsafe`). The home and factory.yaml are not links, belong to this user and have no group or other write bit (else
 *     `unsafe`). The first ping and the second ping, and the write, use that real path.
 *  3. The first ping: no answer is `notAnswering`, and another id or layer than the target is `mismatch`. Nothing is written yet.
 *  4. The state folder and the inbox: the same checks. A state folder that is not there is `notIgnored`, and it is never made.
 *     The count of the inbox comes after its owner and mode, and reads at most `nodeInbox.maxFiles` names (`full`).
 *  5. The state repo of the child ignores the inbox (else `notIgnored`).
 *  6. A new file with a name made here, mode 600, never replacing a file. The inbox is made with mode 700 if it is not there.
 *  7. The second ping. Unless it answers with the same id and layer, the file is removed and the value is `mismatch`; if the
 *     removal fails, `mismatch` holds the path of the file.
 * Every fault gives a kind: a safety stop of a step is `unsafe`, any other fault is `io`. No result holds text of the child.
 */
export const deliverToHome = async (deps: Deps, ping: Ping, address: string, input: DeliverInput): Promise<DeliverResult> => {
  if ([input.senderId, input.senderAddress, input.targetId].some(holdsHiddenCharacter)) return IO;
  const checked = checkFileAddress(address);
  if (!checked.ok) return NOT_ANSWERING;
  const home = await locateHome(deps, checked.value);
  if (!home.ok) return home.error;
  const target = `${addressNames.scheme}${home.value}`;
  const first = await ping(target);
  if (first.kind !== 'known') return NOT_ANSWERING;
  if (!answersAsTarget(first, input)) return { kind: 'mismatch', stranded: null };

  const layout = layoutOf(home.value);
  const text = [...messageHeaderLines(input), '', input.body].join('\n');
  const state = await requireState(deps, layout);
  if (!state.ok) return state.error;
  const room = await requireRoom(deps, layout, Buffer.byteLength(text, 'utf8'));
  if (!room.ok) return room.error;
  const ignored = await requireIgnored(deps, layout);
  if (!ignored.ok) return ignored.error;
  const name = nameOf(deps, input.senderId);
  if (!name.ok) return name.error;
  const written = await writeMessage(deps, layout, name.value, text);
  if (!written.ok) return written.error;

  if (answersAsTarget(await ping(target), input)) return { kind: 'written', path: written.value };
  return { kind: 'mismatch', stranded: (await removeMade(deps, written.value)) ? null : written.value };
};
