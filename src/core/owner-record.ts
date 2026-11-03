import { z } from 'zod';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { absolutePath, slug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import { files, ownerRecords, places, values } from '../names.js';
import { ownerModes, recipes, type ApprovalMode, type ApprovalModes } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import type { Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { comparable, isSameOrInsideFolder } from './paths.js';
import { changePrivateFile, readPrivateText, userStatePathOf } from './private-file.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

/**
 * The approval records. This file is the only writer of the store. A record is real only when a person wrote it in a
 * terminal window outside a factory session (design 6). The store is a per-user file in the state folder, outside every
 * factory folder, so a record file inside a factory folder never counts.
 */

const keys = ownerRecords.keys;
const [OWNER_MODE, DELEGATED_MODE] = values.approvalModes;

const text = z
  .string()
  .min(1)
  .max(ownerRecords.maxTextChars)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not hold a control character');

const delegationSchema = z.strictObject({
  [keys.kind]: z.literal(ownerRecords.kinds.delegation),
  [keys.node]: slug,
  [keys.root]: absolutePath,
  [keys.point]: slug,
  [keys.mode]: z.enum(values.approvalModes),
  [keys.at]: z.iso.datetime(),
});

const scopeSchema = z.strictObject({
  [keys.kind]: z.literal(ownerRecords.kinds.scope),
  [keys.node]: slug,
  [keys.root]: absolutePath,
  [keys.project]: slug,
  [keys.version]: text,
  [keys.items]: z.array(text).max(ownerRecords.maxItems),
  [keys.at]: z.iso.datetime(),
});

const storeSchema = z.strictObject({
  [keys.schema]: z.literal(ownerRecords.schema),
  [keys.records]: z
    .array(z.discriminatedUnion(keys.kind, [delegationSchema, scopeSchema]))
    .max(ownerRecords.maxRecords),
});

/** The mode of one approval point of one factory folder, as the owner set it. */
export type DelegationRecord = z.infer<typeof delegationSchema>;

/** The items and the project version that the owner approved. It is a record of its own kind, with its own key. */
export type ScopeRecord = z.infer<typeof scopeSchema>;

export type OwnerRecord = DelegationRecord | ScopeRecord;

/** The records of a store text. A file that does not exist holds no record. The error is the reason. */
const recordsOf = (content: string | null): Result<readonly OwnerRecord[], string> => {
  if (content === null) return ok([]);
  const json = parseJsonText(content);
  if (!json.ok) return json;
  const parsed = storeSchema.safeParse(json.value);
  return parsed.success ? ok(parsed.data[keys.records]) : err(describeIssues(parsed.error));
};

/**
 * The records of the store file. A file that does not exist holds no record. A file or a folder that another user owns
 * or can write is refused, and so is a file over the size cap. The error is the reason.
 */
export const readOwnerRecords = async (deps: Deps, path: string): Promise<Result<readonly OwnerRecord[], string>> => {
  const content = await readPrivateText(deps, path, ownerRecords.maxBytes);
  return content.ok ? recordsOf(content.value) : content;
};

/**
 * The store file for a factory folder: in the state folder of the user, and never inside the factory folder. The root is a
 * real path.
 */
const storePathOf = async (deps: Deps, root: string): Promise<CliResult<string>> => {
  const path = await userStatePathOf(deps, files.ownerRecords);
  if (!path.ok) return path;
  if (path.value === null) return failure('the approval records have no place: no variable names a state folder');
  const inside = await isSameOrInsideFolder(deps, root, path.value);
  if (!inside.ok) return inside;
  if (inside.value) {
    return safetyRefusal(
      `the approval records would be ${path.value}, inside the ${places.folder} ${root}`,
      `Set the state folder to a folder outside the ${places.folder}.`,
    );
  }
  return ok(path.value);
};

/**
 * The only way to write an approval record: a person types in a terminal window, and the process runs outside a factory
 * session. A session carries the marker in every pane. The guard stops a session and its tools. It cannot prove that the
 * owner acts (design 6).
 */
const requireOwnerChannel = (deps: Deps): CliResult<void> => {
  const remedy = `Run the command in a terminal window outside a ${places.session}.`;
  if (inFactorySession(deps)) return safetyRefusal(`a ${places.session} cannot write an approval record`, remedy);
  if (!deps.stdinIsTTY) return safetyRefusal('an approval record needs a terminal window', remedy);
  return ok(undefined);
};

/** The key of a record: two records with one key stand for one thing, and the store keeps the newest. */
const keyOf = (deps: Deps, record: OwnerRecord): string => {
  const root = comparable(deps, record.root);
  return JSON.stringify(
    record.kind === ownerRecords.kinds.delegation
      ? [record.kind, record.node, root, record.point]
      : [record.kind, record.node, root, record.project, record.version],
  );
};

const storeText = (records: readonly OwnerRecord[]): string =>
  `${JSON.stringify({ [keys.schema]: ownerRecords.schema, [keys.records]: records }, null, 2)}\n`;

/** The store text with the record in place of each record that has its key. */
const textWithRecord = (deps: Deps, path: string, current: string | null, record: OwnerRecord): Result<string, string> => {
  const known = recordsOf(current);
  if (!known.ok) return err(`${path} cannot be read: ${known.error}`);
  const next = [...known.value.filter((other) => keyOf(deps, other) !== keyOf(deps, record)), record];
  if (next.length > ownerRecords.maxRecords) {
    return err(`the approval records hold the most records that they can: ${ownerRecords.maxRecords}`);
  }
  const content = storeText(next);
  return Buffer.byteLength(content, 'utf8') > ownerRecords.maxBytes
    ? err(`the approval records would be larger than ${ownerRecords.maxBytes} bytes`)
    : ok(content);
};

/** Write a record that `build` makes for the real path of the root. The caller has no say in the time or the root. */
const putRecord = async (
  deps: Deps,
  root: string,
  build: (realRoot: string, at: string) => OwnerRecord,
): Promise<CliResult<void>> => {
  const channel = requireOwnerChannel(deps);
  if (!channel.ok) return channel;
  const real = await deps.fs.realpath(root);
  if (!real.ok) return real;
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return path;
  const record = build(real.value, deps.now().toISOString());
  const written = await changePrivateFile(deps, path.value, ownerRecords.maxBytes, async (current) =>
    textWithRecord(deps, path.value, current, record),
  );
  return written.ok ? ok(undefined) : failure(`The approval records were not updated: ${written.error}`);
};

/**
 * Set the mode of one approval point of a factory folder. A record with the mode `owner` ends a delegation. The store keeps
 * the newest record for the node id, the real path of the folder and the point.
 */
export const recordDelegation = (
  deps: Deps,
  input: { readonly root: string; readonly node: string; readonly point: string; readonly mode: ApprovalMode },
): Promise<CliResult<void>> =>
  putRecord(deps, input.root, (realRoot, at) => ({
    [keys.kind]: ownerRecords.kinds.delegation,
    [keys.node]: input.node,
    [keys.root]: realRoot,
    [keys.point]: input.point,
    [keys.mode]: input.mode,
    [keys.at]: at,
  }));

/**
 * Approve the items and the version of one project. The key is the node id, the real path of the folder, the project and
 * the version. So a scope never replaces a delegation record, and it never changes the effective mode of a point.
 */
export const recordScope = (
  deps: Deps,
  input: {
    readonly root: string;
    readonly node: string;
    readonly project: string;
    readonly version: string;
    readonly items: readonly string[];
  },
): Promise<CliResult<void>> =>
  putRecord(deps, input.root, (realRoot, at) => ({
    [keys.kind]: ownerRecords.kinds.scope,
    [keys.node]: input.node,
    [keys.root]: realRoot,
    [keys.project]: input.project,
    [keys.version]: input.version,
    [keys.items]: [...input.items],
    [keys.at]: at,
  }));

/** The newest delegation record of each point for this node id and this real root. Equal times: the owner mode wins. */
const newestModes = (deps: Deps, records: readonly OwnerRecord[], node: string, root: string): ReadonlyMap<string, ApprovalMode> => {
  const wanted = comparable(deps, root);
  const newest = new Map<string, { readonly time: number; readonly mode: ApprovalMode }>();
  for (const record of records) {
    if (record.kind !== ownerRecords.kinds.delegation) continue;
    if (record.node !== node || comparable(deps, record.root) !== wanted) continue;
    const time = Date.parse(record.at);
    const known = newest.get(record.point);
    if (known === undefined || time > known.time) {
      newest.set(record.point, { time, mode: record.mode });
    } else if (time === known.time && record.mode === OWNER_MODE) {
      newest.set(record.point, { time, mode: OWNER_MODE });
    }
  }
  return new Map([...newest].map(([point, { mode }]) => [point, mode]));
};

/** The delegation records of this node id and this folder. A store that cannot be used holds none: every point is `owner`. */
const delegationsOf = async (deps: Deps, root: string, node: string): Promise<ReadonlyMap<string, ApprovalMode>> => {
  const real = await deps.fs.realpath(root);
  if (!real.ok) return new Map();
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return new Map();
  const records = await readOwnerRecords(deps, path.value);
  return records.ok ? newestModes(deps, records.value, node, real.value) : new Map();
};

/**
 * The mode of each approval point of the recipe that the node follows (design 6). A point is `delegated` only when the
 * local value is `delegated` and the newest delegation record for the node id, the real path of the folder and the point is
 * `delegated`. Every other case gives `owner`: a local `delegated` with no matching record, a newer record with the mode
 * `owner`, a record for another folder, a record of another kind, and a store that cannot be used. The store is read only
 * when a local value asks for a delegation.
 */
export const effectiveModes = async (deps: Deps, root: string, config: FactoryConfig): Promise<ApprovalModes> => {
  const points = recipes[config.recipe.id].approvalPoints;
  const asked = points.filter((point) => config.core.approval[point.id] === DELEGATED_MODE);
  if (asked.length === 0) return ownerModes(points);
  const records = await delegationsOf(deps, root, config.core.node.id);
  return Object.fromEntries(
    points.map((point) => [point.id, asked.includes(point) && records.get(point.id) === DELEGATED_MODE ? DELEGATED_MODE : OWNER_MODE]),
  );
};
