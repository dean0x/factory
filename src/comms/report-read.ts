import { accessFaultOf, type AccessFault } from '../core/access.js';
import type { CheckedFault, Deps, PathInfo } from '../core/deps.js';
import { childReasons, reportKeys, reportLimits } from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import { checkFileAddress } from './address.js';
import { configAccessOf } from './config-access.js';
import { parseReport, type NodeReport } from './report-schema.js';

/** One of the fixed reasons of a child row. No reason holds text of the child. */
export type ChildReason = (typeof childReasons)[keyof typeof childReasons];

/**
 * What a read of the report file of a child finds. `read` holds the report, which passed every check. `unknown` holds one fixed
 * reason and never text of the file. `age` is the age of the file in whole seconds, or null when no file was seen or a path is a
 * link. `bytes` is the count of bytes that the call read, for a budget of reads. `source` is the path of the report file, or null
 * for an address that is not valid.
 */
export type ChildReportRead =
  | { readonly state: 'read'; readonly report: NodeReport; readonly age: number; readonly bytes: number; readonly source: string }
  | {
      readonly state: 'unknown';
      readonly reason: ChildReason;
      readonly age: number | null;
      readonly bytes: number;
      readonly source: string | null;
    };

const unknown = (reason: ChildReason, source: string | null, age: number | null, bytes: number): ChildReportRead => ({
  state: 'unknown',
  reason,
  age,
  bytes,
  source,
});

const ACCESS_FAULT_REASONS: Readonly<Record<AccessFault, ChildReason>> = {
  otherOwner: childReasons.reportOtherOwner,
  writableByOthers: childReasons.reportWritable,
};

const FILE_FAULT_REASONS: Readonly<Record<CheckedFault, ChildReason>> = {
  ...ACCESS_FAULT_REASONS,
  'wrong-kind': childReasons.reportWrongKind,
  size: childReasons.reportTooLarge,
};

/** The byte cap of one read: the smaller of the cap of a report and the cap of the call. A cap that is not a positive whole number reads nothing. */
const capOf = (maxBytes: number): number =>
  Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(reportLimits.maxBytes, maxBytes) : 0;

/**
 * True when the read refused the file only for the cap of the call: the call gave fewer bytes than the cap of one report, and the file
 * is larger than that. Then the budget of the caller is the cause, not the file, and the caller gives the reason of its own cap.
 */
export const isOverCallCap = (read: ChildReportRead, maxBytes: number): boolean =>
  read.state === 'unknown' && read.reason === childReasons.reportTooLarge && capOf(maxBytes) < reportLimits.maxBytes;

/** The age in whole seconds, at least 0 and at most the largest number that a report holds. */
const ageOf = (deps: Deps, info: PathInfo): number => {
  const seconds = Math.floor((deps.now().getTime() - info.mtimeMs) / 1000);
  return Math.min(reportLimits.maxNumber, Math.max(0, seconds));
};

/**
 * What the look at the factory folder and the outbox folder finds. `stop` is the reason when a folder is missing, is a link or is not a
 * folder: the report file is not opened. `fault` is the reason of the first fault of the owner or the mode of a folder, or null.
 */
interface Folders {
  readonly stop: ChildReason | null;
  readonly fault: ChildReason | null;
}

/** Look at the factory folder and the outbox folder, in that order, with no link followed. */
const lookAtFolders = async (deps: Deps, layout: Layout): Promise<Folders> => {
  let fault: ChildReason | null = null;
  for (const path of [layout.stateDir, layout.outboxDir]) {
    const seen = await deps.fs.lstatInfo(path);
    if (!seen.ok) return { stop: childReasons.reportUnreadable, fault };
    const info = seen.value;
    if (info === null) return { stop: childReasons.noReport, fault };
    if (info.kind === 'link') return { stop: childReasons.reportLink, fault };
    if (info.kind !== 'dir') return { stop: childReasons.reportWrongKind, fault };
    const access = accessFaultOf(deps, info);
    if (fault === null && access !== null) fault = ACCESS_FAULT_REASONS[access];
  }
  return { stop: null, fault };
};

/** True when the document is a mapping with a whole number in its version key that is higher than the version that this program reads. */
const isNewer = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const version = (value as Readonly<Record<string, unknown>>)[reportKeys.doc.schemaVersion];
  return typeof version === 'number' && Number.isInteger(version) && version > reportLimits.schemaVersion;
};

/**
 * Read the report file of a child node (design 5.4). The file is data to check and never a thing to trust. The address must be a
 * clean `file://` address. The config file of the child must not be a link, must belong to the user of this process, and must not be
 * writable by a group or by other users: the look at it reads the metadata of the open file, and no text. The factory folder and the
 * outbox folder must not be links, must be folders, and must pass the same owner and mode checks. The report file is opened once with
 * no link followed, and its kind, owner, mode and size are checked on the open handle before one byte is read from it. It has at
 * most the smaller of `maxBytes` and `reportLimits.maxBytes` bytes, is UTF-8 text and valid JSON, and passes the report schema. A
 * document with a newer schema version is not read further.
 *
 * Every fault is an `unknown` value with one fixed reason, and the text of a faulty file is dropped before any parse. `bytes` counts
 * what the call read from the open file, also when the read or the decode failed. A reason never holds a path, a key name, a message
 * of a check or any other text of the child. The call never throws.
 */
export const readChildReport = async (deps: Deps, address: string, maxBytes: number): Promise<ChildReportRead> => {
  const checked = checkFileAddress(address);
  if (!checked.ok) return unknown(childReasons.addressInvalid, null, null, 0);
  const layout = layoutOf(checked.value);
  const source = layout.reportFile;

  const config = await configAccessOf(deps, layout.configFile);
  if (config === 'unsafe' || config === 'unreadable') return unknown(childReasons.configUnsafe, source, null, 0);

  const folders = await lookAtFolders(deps, layout);
  if (folders.stop !== null) return unknown(folders.stop, source, null, 0);

  // A fault of a folder gives no read of the file: the open then asks for the facts of the file alone, for its age.
  const opened = await deps.fs.openChecked(source, {
    uid: deps.uid,
    maxBytes: folders.fault === null ? capOf(maxBytes) : null,
    decode: 'fatal',
  });
  if (!opened.ok) return unknown(childReasons.reportUnreadable, source, null, 0);

  const read = opened.value;
  if (read.state === 'absent') return unknown(childReasons.noReport, source, null, 0);
  if (read.state === 'link') return unknown(childReasons.reportLink, source, null, 0);
  if (read.state === 'refused' && read.fault === 'wrong-kind') return unknown(childReasons.reportWrongKind, source, null, 0);

  const age = ageOf(deps, read.info);
  if (folders.fault !== null) return unknown(folders.fault, source, age, 0);
  if (read.state === 'refused') return unknown(FILE_FAULT_REASONS[read.fault], source, age, read.bytes);
  if (read.state === 'unreadable' || read.text === null) return unknown(childReasons.reportUnreadable, source, age, read.bytes);

  const { bytes } = read;
  const json = parseJsonText(read.text);
  if (!json.ok) return unknown(childReasons.reportNotJson, source, age, bytes);
  if (isNewer(json.value)) return unknown(childReasons.reportNewer, source, age, bytes);
  const report = parseReport(json.value);
  if (!report.ok) return unknown(childReasons.reportInvalid, source, age, bytes);
  return { state: 'read', report: report.value, age, bytes, source };
};
