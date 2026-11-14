import { holdsBlockMarker } from '../blocks/managed.js';
import { failure, safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import { removedByDisplay } from '../cli/output.js';
import type { FactoryConfig } from '../config/schema.js';
import { accessFaultOf } from '../core/access.js';
import type { CheckedFault, Deps } from '../core/deps.js';
import { ok, type Err } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { acceptedEntryOf, entryOfText, type ManifestEntry } from '../core/setup-acceptance.js';
import { blockNames, commands, roleText, setupFileOf, type RoleSizeUnit } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { plainSetupText, renderableSetupText } from '../state/setup-text.js';
import { workerFileTemplatesFor } from '../templates/index.js';
import type { BlockTemplate } from '../templates/types.js';

/**
 * The role text of a worker session: the package worker rules and the setup text that the owner accepted, behind one
 * fixed source line. This module is the one reader of that text. The hook, the launch, the reset and the doctor check
 * all call it, so they refuse the same texts. It reads the setup file of the owner and never the rendered worker file,
 * which is a copy for people.
 */

/** The faults of a role text, one for each reason in `roleText.reasons` except the input of the hook, which no read of the text finds. */
export type RoleFaultKind = Exclude<keyof typeof roleText.reasons, 'inputNotUsable'>;

/**
 * Why a role text is refused. A text above the cap names its size and its unit, and the characters that the setup text
 * may hold. The size is in characters when the whole text is over the cap, and in bytes when the file alone is over it.
 */
export type RoleFault =
  | { readonly kind: 'tooLarge'; readonly size: number; readonly unit: RoleSizeUnit; readonly free: number }
  | { readonly kind: Exclude<RoleFaultKind, 'tooLarge'> };

/** What a read of the role text finds: the text, or the one fault that refuses it. */
export type RoleRead =
  | { readonly kind: 'ok'; readonly text: string; readonly chars: number }
  | { readonly kind: 'refused'; readonly fault: RoleFault };

const refused = (fault: RoleFault): CliResult<RoleRead> => ok({ kind: 'refused', fault });

/**
 * The role text of these templates: the source line, the worker body and, when it is present, the setup worker body, with
 * `roleText.joiner` between them. The order is fixed, whatever the order of the templates.
 */
export const composeRoleText = (templates: readonly BlockTemplate[]): string => {
  const bodyOf = (name: string): string | undefined => templates.find((template) => template.name === name)?.body;
  const bodies = [bodyOf(blockNames.worker), bodyOf(blockNames.setupWorker)].filter((body): body is string => body !== undefined);
  return [roleText.sourceLine, ...bodies].join(roleText.joiner);
};

/** The characters of setup text that the cap leaves after the package part and the joiner. */
const freeRoomOf = (packageText: string): number =>
  Math.max(0, roleText.maxChars - packageText.length - roleText.joiner.length);

/**
 * The warning for a role text above the cap, or null when the text fits or the templates hold no worker block. A command
 * that renders the worker file gives this warning and still writes its files. The text names its size, the cap and the
 * characters that the setup text may hold. `retry` is the command that a person runs again after the fix.
 */
export const roleTextSizeWarning = (templates: readonly BlockTemplate[], retry: string): string | null => {
  if (!templates.some((template) => template.name === blockNames.worker)) return null;
  const size = composeRoleText(templates).length;
  if (size <= roleText.maxChars) return null;
  const free = freeRoomOf(composeRoleText(templates.filter((template) => template.name !== blockNames.setupWorker)));
  return `${roleText.tooLargeText(size, 'characters')}. ${roleText.remedies.shorten(free, retry)}`;
};

/** The faults of a file that the checked open refuses before it reads a byte, other than the size. */
const OPEN_FAULTS: Readonly<Record<Exclude<CheckedFault, 'size'>, RoleFault>> = {
  'wrong-kind': { kind: 'readFailed' },
  otherOwner: { kind: 'ownerOrMode' },
  writableByOthers: { kind: 'ownerOrMode' },
};

/**
 * The first fault of the folders above the setup file: a link, a path that is not a folder, or a folder that another user
 * owns or that a group or other users can write. A folder that does not exist ends the look, because the file is absent then.
 */
const folderFault = async (deps: Deps, folders: readonly string[]): Promise<RoleFault | null> => {
  for (const folder of folders) {
    const seen = await deps.fs.lstatInfo(folder);
    if (!seen.ok) return { kind: 'readFailed' };
    const info = seen.value;
    if (info === null) return null;
    if (info.kind === 'link') return { kind: 'link' };
    if (info.kind !== 'dir') return { kind: 'readFailed' };
    if (accessFaultOf(deps, info) !== null) return { kind: 'ownerOrMode' };
  }
  return null;
};

/** The text when it is within the cap, and the refusal when it is not. The text is never cut. */
const withinCap = (text: string, free: number): CliResult<RoleRead> =>
  text.length > roleText.maxChars
    ? refused({ kind: 'tooLarge', size: text.length, unit: 'characters', free })
    : ok({ kind: 'ok', text, chars: text.length });

/** True when the bytes that were read are the bytes that the owner accepted. */
const sameAsAccepted = (accepted: ManifestEntry | null, read: ManifestEntry): boolean =>
  accepted !== null && accepted.type === read.type && accepted.size === read.size && accepted.sha256 === read.sha256;

/**
 * The role text from the text of the setup file, after the compare with the acceptance. The text must be plain text with
 * no block marker. `plainSetupText` refuses a control character, an invisible filler and a marker with one error, and gives
 * the text with LF line ends. The text of that error is dropped. The fault names the marker when the raw text holds one.
 */
const roleOfSetupText = (raw: string, config: FactoryConfig, free: number): CliResult<RoleRead> => {
  const plain = plainSetupText(setupFileOf(blockNames.setupWorker), raw, commands.doctor);
  if (!plain.ok) return refused({ kind: holdsBlockMarker(raw) ? 'blockMarker' : 'notPlainText' });
  if (removedByDisplay(plain.value)) return refused({ kind: 'notPlainText' });
  return withinCap(composeRoleText(workerFileTemplatesFor(config, renderableSetupText(plain.value))), free);
};

/**
 * Read the role text of a node. The text is the package worker rules, rendered for the config, and the owner setup text
 * `setup/roles/worker.md` when that file is there. The checks run in this order, and the first fault is the answer:
 * - no link in the path of the file, and no other owner and no group or other write bit on the file or on the folders above it;
 * - the open of the file with a cap on its bytes, a fatal decode and no link followed;
 * - the acceptance: the size and the SHA-256 of the bytes that were read must equal the accepted entry for this node. A
 *   file that is absent is valid only when the node has no accepted entry for it;
 * - plain text: no control character except the newline and the tab, no hidden character, no block marker;
 * - the cap on the whole text, the source line included. A text above the cap is refused and never cut.
 *
 * A store of acceptances that cannot be used is an error and never a text. A fault of any check is a `refused` value with
 * no text of the file, no path and no message of an error. The call reads only the variables of the session that find the
 * store of the acceptances, and it never reads the rendered worker file.
 */
export const readRoleText = async (
  deps: Deps,
  input: { readonly home: string; readonly config: FactoryConfig },
): Promise<CliResult<RoleRead>> => {
  const { home, config } = input;
  const packageTemplates = workerFileTemplatesFor(config, null);
  if (!packageTemplates.some((template) => template.name === blockNames.worker)) return refused({ kind: 'configNotUsable' });
  const packageText = composeRoleText(packageTemplates);
  const free = freeRoomOf(packageText);

  const layout = layoutOf(home);
  const linked = await requireNoLinks(deps, home, [layout.setupWorkerFile]);
  if (!linked.ok) return refused({ kind: linked.error.kind === 'safety' ? 'link' : 'readFailed' });
  const folder = await folderFault(deps, [layout.setupDir, layout.setupRolesDir]);
  if (folder !== null) return refused(folder);

  const opened = await deps.fs.openChecked(layout.setupWorkerFile, { uid: deps.uid, maxBytes: roleText.maxChars, decode: 'fatal' });
  if (!opened.ok) return refused({ kind: 'readFailed' });
  const found = opened.value;
  const path = setupFileOf(blockNames.setupWorker);
  const acceptedOf = (): Promise<CliResult<ManifestEntry | null>> =>
    acceptedEntryOf(deps, { root: home, node: config.core.node.id, path });

  switch (found.state) {
    case 'link':
      return refused({ kind: 'link' });
    case 'absent': {
      const accepted = await acceptedOf();
      if (!accepted.ok) return accepted;
      return accepted.value === null ? withinCap(packageText, free) : refused({ kind: 'notAccepted' });
    }
    case 'refused':
      return refused(
        found.fault === 'size'
          ? { kind: 'tooLarge', size: Math.max(found.info.size, found.bytes), unit: 'bytes', free }
          : OPEN_FAULTS[found.fault],
      );
    case 'unreadable':
      // The open does not tell bytes that are not UTF-8 from a read that failed. The first is the likely cause.
      return refused({ kind: 'notUtf8' });
    case 'opened': {
      if (found.text === null) return refused({ kind: 'readFailed' });
      const accepted = await acceptedOf();
      if (!accepted.ok) return accepted;
      if (!sameAsAccepted(accepted.value, entryOfText(path, found.text))) return refused({ kind: 'notAccepted' });
      return roleOfSetupText(found.text, config, free);
    }
    default: {
      const unreachable: never = found;
      return unreachable;
    }
  }
};

/** The one fixed reason of a fault. It holds no size, no path and no text of a file. */
export const roleFaultReason = (fault: RoleFault): string => roleText.reasons[fault.kind];

/** The faults that are a security stop (exit 4): a link, a wrong owner or mode, and a file that the owner did not accept. */
const SECURITY_FAULTS: ReadonlySet<RoleFaultKind> = new Set<RoleFaultKind>(['link', 'ownerOrMode', 'notAccepted']);

/** What a refusal tells the person that runs the command again. `retry` is the command that stopped, as a person types it. */
export interface RoleRemedyContext {
  readonly retry: string;
}

const remedyOf = (fault: RoleFault, retry: string): string => {
  switch (fault.kind) {
    case 'link':
    case 'ownerOrMode':
      return roleText.remedies.path(retry);
    case 'notAccepted':
      return roleText.remedies.accept(retry);
    case 'tooLarge':
      return roleText.remedies.shorten(fault.free, retry);
    case 'configNotUsable':
      return roleText.remedies.config(retry);
    case 'notUtf8':
    case 'notPlainText':
    case 'blockMarker':
    case 'readFailed':
      return roleText.remedies.correct(retry);
    default: {
      const unreachable: never = fault;
      return unreachable;
    }
  }
};

/**
 * The refusal of a launch, a reset or a check for a fault of the role text. A link, a wrong owner or mode, and a file that
 * the owner did not accept are a security stop (exit 4). Every other fault is an error (exit 1). The message names the
 * fault, and a text that is too large names its size and the cap. The remedy line names one fix and the command to run again.
 */
export const roleFaultRefusal = (fault: RoleFault, context: RoleRemedyContext): Err<CliError> => {
  const message = fault.kind === 'tooLarge' ? roleText.tooLargeText(fault.size, fault.unit) : roleFaultReason(fault);
  const remedy = remedyOf(fault, context.retry);
  return SECURITY_FAULTS.has(fault.kind) ? safetyRefusal(message, remedy) : failure(message, remedy);
};

/**
 * The pre-check of a launch and of a new worker: a role text that every check accepts is `ok`, and a fault is the refusal of
 * `roleFaultRefusal` for `retry`, the command that a person runs again after the fix. A store of acceptances that cannot be used
 * keeps its own error. The call reads the text and drops it, so it changes nothing.
 */
export const requireRoleText = async (
  deps: Deps,
  input: { readonly home: string; readonly config: FactoryConfig; readonly retry: string },
): Promise<CliResult<void>> => {
  const { home, config, retry } = input;
  const read = await readRoleText(deps, { home, config });
  if (!read.ok) return read;
  return read.value.kind === 'ok' ? ok(undefined) : roleFaultRefusal(read.value.fault, { retry });
};
