import { accessFaultOf, type AccessFault } from '../core/access.js';
import type { Deps, PathInfo } from '../core/deps.js';
import { childReasons, dirs, files, reportKeys, reportLimits } from '../names.js';
import { layoutOf, type Layout } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';
import { readCheckedFile, type FileFault } from '../workers/registry.js';
import { checkFileAddress } from './address.js';
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

const FILE_FAULT_REASONS: Readonly<Record<FileFault, ChildReason>> = {
  link: childReasons.reportLink,
  'wrong-kind': childReasons.reportWrongKind,
  size: childReasons.reportTooLarge,
};

const ACCESS_FAULT_REASONS: Readonly<Record<AccessFault, ChildReason>> = {
  otherOwner: childReasons.reportOtherOwner,
  writableByOthers: childReasons.reportWritable,
};

/** The byte cap of one read: the smaller of the cap of a report and the cap of the call. A cap that is not a positive whole number reads nothing. */
const capOf = (maxBytes: number): number =>
  Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(reportLimits.maxBytes, maxBytes) : 0;

/** The age in whole seconds, at least 0 and at most the largest number that a report holds. */
const ageOf = (deps: Deps, info: PathInfo): number => {
  const seconds = Math.floor((deps.now().getTime() - info.mtimeMs) / 1000);
  return Math.min(reportLimits.maxNumber, Math.max(0, seconds));
};

/** The age of the file with the fault of its path, or the age and no fault. */
type Access = { readonly fault: null; readonly age: number } | { readonly fault: ChildReason; readonly age: number | null };

/**
 * The age of the report file, and the first fault of the owner or the mode in the factory folder, the outbox folder and the file, in
 * that order. The paths are not links: `readCheckedFile` checked that before this call.
 */
const accessOf = async (deps: Deps, layout: Layout): Promise<Access> => {
  const file = await deps.fs.statInfo(layout.reportFile);
  if (!file.ok) return { fault: childReasons.reportUnreadable, age: null };
  if (file.value === null) return { fault: childReasons.noReport, age: null };
  const age = ageOf(deps, file.value);
  for (const path of [layout.stateDir, layout.outboxDir]) {
    const folder = await deps.fs.statInfo(path);
    if (!folder.ok) return { fault: childReasons.reportUnreadable, age };
    if (folder.value === null) return { fault: childReasons.noReport, age: null };
    const fault = accessFaultOf(deps, folder.value);
    if (fault !== null) return { fault: ACCESS_FAULT_REASONS[fault], age };
  }
  const fault = accessFaultOf(deps, file.value);
  return fault === null ? { fault: null, age } : { fault: ACCESS_FAULT_REASONS[fault], age };
};

/** True when the document is a mapping with a whole number in its version key that is higher than the version that this program reads. */
const isNewer = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const version = (value as Readonly<Record<string, unknown>>)[reportKeys.doc.schemaVersion];
  return typeof version === 'number' && Number.isInteger(version) && version > reportLimits.schemaVersion;
};

/**
 * Read the report file of a child node (design 5.4). The file is data to check and never a thing to trust. The address must be a
 * clean `file://` address. The factory folder, the outbox folder and the file must not be links, must be of the right kind, must
 * belong to the user of this process, and must not be writable by a group or by other users. The file has at most the smaller of
 * `maxBytes` and `reportLimits.maxBytes` bytes, is UTF-8 text and valid JSON, and passes the report schema. A document with a
 * newer schema version is not read further.
 *
 * Every fault is an `unknown` value with one fixed reason, and the text of a faulty file is dropped before any parse. A reason never
 * holds a path, a key name, a message of a check or any other text of the child. The call never throws.
 */
export const readChildReport = async (deps: Deps, address: string, maxBytes: number): Promise<ChildReportRead> => {
  const checked = checkFileAddress(address);
  if (!checked.ok) return unknown(childReasons.addressInvalid, null, null, 0);
  const layout = layoutOf(checked.value);
  const source = layout.reportFile;

  const found = await readCheckedFile(
    deps,
    [
      { path: layout.stateDir, what: dirs.state },
      { path: layout.outboxDir, what: dirs.outbox },
    ],
    { path: source, what: files.report },
    capOf(maxBytes),
    'fatal',
  );
  if (!found.ok) return unknown(childReasons.reportUnreadable, source, (await accessOf(deps, layout)).age, 0);

  const read = found.value;
  if (read.state === 'absent') return unknown(childReasons.noReport, source, null, 0);
  if (read.state === 'invalid' && read.cause !== 'size') return unknown(FILE_FAULT_REASONS[read.cause], source, null, 0);

  const bytes = read.state === 'text' ? Buffer.byteLength(read.text, 'utf8') : 0;
  const access = await accessOf(deps, layout);
  if (access.fault !== null) return unknown(access.fault, source, access.age, bytes);
  if (read.state === 'invalid') return unknown(FILE_FAULT_REASONS[read.cause], source, access.age, bytes);

  const json = parseJsonText(read.text);
  if (!json.ok) return unknown(childReasons.reportNotJson, source, access.age, bytes);
  if (isNewer(json.value)) return unknown(childReasons.reportNewer, source, access.age, bytes);
  const report = parseReport(json.value);
  if (!report.ok) return unknown(childReasons.reportInvalid, source, access.age, bytes);
  return { state: 'read', report: report.value, age: access.age, bytes, source };
};
