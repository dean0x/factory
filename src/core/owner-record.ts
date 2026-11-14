import { z } from 'zod';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { absolutePath, slug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import {
  boardIds,
  boardLimits,
  commands,
  commandText,
  env,
  files,
  ownerDecisions,
  ownerRecords,
  places,
  requestHash,
  values,
} from '../names.js';
import { ownerModes, type ApprovalMode, type ApprovalModes } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import type { Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { comparable, isSameOrInsideFolder } from './paths.js';
import { changePrivateFile, readPrivateText, STORE_INSIDE_FOLDER_REMEDY, userStatePathOf } from './private-file.js';
import { requestHashOf } from './request-hash.js';
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
 * A per-user file for a factory folder: in the state folder of the user, and never inside the factory folder (exit 4). The
 * root is a real path. With no variable that names a state folder, the path is null. `what` names the file in the refusal.
 */
const userFilePathOf = async (deps: Deps, root: string, fileName: string, what: string): Promise<CliResult<string | null>> => {
  const path = await userStatePathOf(deps, fileName);
  if (!path.ok || path.value === null) return path;
  const inside = await isSameOrInsideFolder(deps, root, path.value);
  if (!inside.ok) return inside;
  if (inside.value) {
    return safetyRefusal(`${what} would be ${path.value}, inside the ${places.folder} ${root}`, STORE_INSIDE_FOLDER_REMEDY);
  }
  return ok(path.value);
};

/** The store file of the approval records for a factory folder. A store with no place is a failure. */
const storePathOf = async (deps: Deps, root: string): Promise<CliResult<string>> => {
  const path = await userFilePathOf(deps, root, files.ownerRecords, 'the approval records');
  if (!path.ok) return path;
  return path.value === null ? failure('the approval records have no place: no variable names a state folder') : ok(path.value);
};

/**
 * The only way to write an approval record: a person types in a terminal window, and the process runs outside a factory
 * session. A session carries the marker in every pane. The guard stops a session and its tools. It cannot prove that the
 * owner acts (design 6). `init` runs the same check before it writes anything for a `delegated` choice, so the stop comes
 * before the first clone and not after the last write.
 */
export const requireOwnerChannel = (deps: Deps): CliResult<void> => {
  const remedy = `Run "${commandText(commands.init)}" in a terminal window outside a ${places.session}.`;
  if (inFactorySession(deps)) return safetyRefusal(`a ${places.session} cannot write an approval record`, remedy);
  if (!deps.stdinIsTTY) return safetyRefusal('an approval record needs a terminal window', remedy);
  return ok(undefined);
};

/**
 * The only way to write a decision record: a person types in a terminal window for input and for output, outside a factory
 * session and outside Claude Code. The checks run in this order: the factory session, a non-empty CLAUDECODE, the input
 * window, the output window. Like `requireOwnerChannel`, the guard stops a session and its tools. It cannot prove that the
 * owner acts.
 */
export const requireDecideChannel = (deps: Deps): CliResult<void> => {
  const remedy = `Run "${commandText(commands.decide)}" in your own terminal window, outside Claude Code and outside a ${places.session}.`;
  if (inFactorySession(deps)) return safetyRefusal(`a ${places.session} cannot record a decision`, remedy);
  const claudeCode = deps.env[env.claudeCode];
  if (claudeCode !== undefined && claudeCode !== '') return safetyRefusal('a Claude Code session cannot record a decision', remedy);
  if (!deps.stdinIsTTY) return safetyRefusal('a decision needs a terminal window for input', remedy);
  if (!deps.stdoutIsTTY) return safetyRefusal('a decision needs a terminal window for output', remedy);
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
  if (written.ok) return ok(undefined);
  return written.error.writeState === 'saved-lock-left'
    ? failure(`The approval record is saved: ${written.error.message}`)
    : failure(`The approval records were not updated: ${written.error.message}`);
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

/** The newest delegation record of a point: its mode and its time. */
interface NewestRecord {
  readonly time: number;
  readonly mode: ApprovalMode;
  readonly at: string;
}

/** The newest delegation record of each point for this node id and this real root. Equal times: the owner mode wins. */
const newestModes = (deps: Deps, records: readonly OwnerRecord[], node: string, root: string): ReadonlyMap<string, NewestRecord> => {
  const wanted = comparable(deps, root);
  const newest = new Map<string, NewestRecord>();
  for (const record of records) {
    if (record.kind !== ownerRecords.kinds.delegation) continue;
    if (record.node !== node || comparable(deps, record.root) !== wanted) continue;
    const time = Date.parse(record.at);
    const known = newest.get(record.point);
    if (known === undefined || time > known.time) {
      newest.set(record.point, { time, mode: record.mode, at: record.at });
    } else if (time === known.time && record.mode === OWNER_MODE) {
      newest.set(record.point, { time, mode: OWNER_MODE, at: record.at });
    }
  }
  return newest;
};

/** The delegation records of this node id and this folder. A store that cannot be used holds none: every point is `owner`. */
const delegationsOf = async (deps: Deps, root: string, node: string): Promise<ReadonlyMap<string, NewestRecord>> => {
  const real = await deps.fs.realpath(root);
  if (!real.ok) return new Map();
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return new Map();
  const records = await readOwnerRecords(deps, path.value);
  return records.ok ? newestModes(deps, records.value, node, real.value) : new Map();
};

/** An approval point that is delegated now, and the time of the record that delegates it. */
export interface ActiveDelegation {
  readonly point: string;
  readonly at: string;
}

/** The effective mode of each approval point, with the delegations that are active and the values that no record backs. */
export interface DelegationReport {
  readonly modes: ApprovalModes;
  /** The delegated points, in the order of the recipe. */
  readonly active: readonly ActiveDelegation[];
  /** The points whose local value is `delegated` and that no matching record backs. They count as `owner`. */
  readonly unmatched: readonly string[];
}

/**
 * The mode of each approval point of the recipe that the node follows (design 6), the delegations that are active with the
 * time of their record, and the local `delegated` values that no record backs. A point is `delegated` only when the local
 * value is `delegated` and the newest delegation record for the node id, the real path of the folder and the point is
 * `delegated`. Every other case gives `owner`: a local `delegated` with no matching record, a newer record with the mode
 * `owner`, a record for another folder, a record of another kind, and a store that cannot be used. The store is read only
 * when a local value asks for a delegation.
 */
export const delegationReport = async (deps: Deps, root: string, config: FactoryConfig): Promise<DelegationReport> => {
  const points = config.entry.approvalPoints;
  const asked = points.filter((point) => config.core.approval[point.id] === DELEGATED_MODE);
  if (asked.length === 0) return { modes: ownerModes(points), active: [], unmatched: [] };
  const records = await delegationsOf(deps, root, config.core.node.id);
  const backed = asked.filter((point) => records.get(point.id)?.mode === DELEGATED_MODE);
  return {
    modes: Object.fromEntries(points.map((point) => [point.id, backed.includes(point) ? DELEGATED_MODE : OWNER_MODE])),
    active: backed.map((point) => ({ point: point.id, at: records.get(point.id)?.at ?? '' })),
    unmatched: asked.filter((point) => !backed.includes(point)).map((point) => point.id),
  };
};

/** The mode of each approval point (see `delegationReport`). */
export const effectiveModes = async (deps: Deps, root: string, config: FactoryConfig): Promise<ApprovalModes> =>
  (await delegationReport(deps, root, config)).modes;

/*
 * The decision records. A per-user file of its own beside the approval records, with its own lock.
 * A record is the proof that the owner answered a decision request in a terminal window. This file is its only writer.
 */

const decisionKeys = ownerDecisions.keys;

const decisionSchema = z.strictObject({
  [decisionKeys.node]: slug,
  [decisionKeys.root]: absolutePath,
  [decisionKeys.id]: z.string().regex(boardIds.canonicalRequest),
  [decisionKeys.option]: z.string().regex(boardLimits.tokenPattern),
  [decisionKeys.hash]: z.string().regex(requestHash.pattern),
  [decisionKeys.at]: z.iso.datetime(),
});

const decisionStoreSchema = z.strictObject({
  [decisionKeys.schema]: z.literal(ownerDecisions.schema),
  [decisionKeys.records]: z.array(decisionSchema).max(ownerDecisions.maxRecords),
});

/** One answer of the owner: the node id, the real root, the D-n, the chosen option, the request hash and the time. */
export type DecisionRecord = z.infer<typeof decisionSchema>;

/** What the decide command gives the writer. The writer adds the node id and the real root from the place. */
export type DecisionInput = Omit<DecisionRecord, typeof decisionKeys.node | typeof decisionKeys.root>;

/** The node id, the real root and the decision file of one factory folder. A null path: no variable names a state folder. */
export interface DecisionPlace {
  readonly node: string;
  readonly root: string;
  readonly path: string | null;
}

/** The result of the writer. `existing`: the file already holds this answer. A warning names a lock file that stays. */
export interface DecisionWrite {
  readonly outcome: 'stored' | 'existing';
  readonly warning: string | null;
}

/**
 * The proof of a decision. Only `record` is a proof, and its option is the only source of the chosen option. `none`,
 * `mismatch` and `error` each mean no proof. `mismatch` gives the stored option and time for the message only.
 */
export type DecisionProof =
  | {
      readonly kind: 'record';
      readonly node: string;
      readonly root: string;
      readonly id: string;
      readonly option: string;
      readonly at: string;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'mismatch'; readonly option: string; readonly at: string }
  | { readonly kind: 'error'; readonly message: string };

/** The key of a decision record. One key holds at most one record. */
const decisionKeyOf = (deps: Deps, node: string, root: string, id: string): string =>
  JSON.stringify([node, comparable(deps, root), id]);

/** The records of a decision file text. A file that does not exist holds no record. Two records with one key make the file invalid. */
const decisionRecordsOf = (deps: Deps, content: string | null): Result<readonly DecisionRecord[], string> => {
  if (content === null) return ok([]);
  const json = parseJsonText(content);
  if (!json.ok) return json;
  const parsed = decisionStoreSchema.safeParse(json.value);
  if (!parsed.success) return err(describeIssues(parsed.error));
  const records = parsed.data[decisionKeys.records];
  const unique = new Set(records.map((record) => decisionKeyOf(deps, record.node, record.root, record.id)));
  return unique.size === records.length ? ok(records) : err('the file holds two answers to one decision');
};

/** The records of the decision file, or the reason that the file cannot be used. The error names the file. */
const readDecisionRecords = async (deps: Deps, path: string): Promise<Result<readonly DecisionRecord[], string>> => {
  const content = await readPrivateText(deps, path, ownerDecisions.maxBytes);
  const records = content.ok ? decisionRecordsOf(deps, content.value) : content;
  return records.ok ? records : err(`${path} cannot be read: ${records.error}`);
};

/** The records of the node id and the real root of the place. */
const recordsOfPlace = (deps: Deps, place: DecisionPlace, records: readonly DecisionRecord[]): readonly DecisionRecord[] => {
  const root = comparable(deps, place.root);
  return records.filter((record) => record.node === place.node && comparable(deps, record.root) === root);
};

/**
 * The place of the decision file for a factory folder. It runs before any lock. It resolves the real root, and refuses
 * (exit 4) a decision file inside the factory folder.
 */
export const decisionPlaceOf = async (deps: Deps, root: string, node: string): Promise<CliResult<DecisionPlace>> => {
  const real = await deps.fs.realpath(root);
  if (!real.ok) return real;
  const path = await userFilePathOf(deps, real.value, files.ownerDecisions, 'the decision records');
  return path.ok ? ok({ node, root: real.value, path: path.value }) : path;
};

/**
 * The proof that the owner answered request `id` with the request text `requestText`. The call hashes the text itself. It
 * reads only the decision file, and counts only the records of the node id and the real root of the place. A null path or
 * no record gives `none`. A record with another hash gives `mismatch`. A file that cannot be used gives `error`, never
 * `none`. Only `record` is a proof.
 */
export const readDecisionProof = async (
  deps: Deps,
  place: DecisionPlace,
  id: string,
  requestText: string,
): Promise<DecisionProof> => {
  if (place.path === null) return { kind: 'none' };
  const records = await readDecisionRecords(deps, place.path);
  if (!records.ok) return { kind: 'error', message: records.error };
  const found = recordsOfPlace(deps, place, records.value).find((record) => record.id === id);
  if (found === undefined) return { kind: 'none' };
  if (found.hash !== requestHashOf(requestText)) return { kind: 'mismatch', option: found.option, at: found.at };
  return { kind: 'record', node: found.node, root: found.root, id: found.id, option: found.option, at: found.at };
};

/** The D-n of the decision records of this node id and this real root. A null path or an absent file gives an empty list. */
export const decisionIdsOf = async (deps: Deps, place: DecisionPlace): Promise<Result<readonly string[], string>> => {
  if (place.path === null) return ok([]);
  const records = await readDecisionRecords(deps, place.path);
  return records.ok ? ok(recordsOfPlace(deps, place, records.value).map((record) => record.id)) : records;
};

const decisionsText = (records: readonly DecisionRecord[]): string =>
  `${JSON.stringify({ [decisionKeys.schema]: ownerDecisions.schema, [decisionKeys.records]: records }, null, 2)}\n`;

/** The new decision file text and the outcome. The same answer keeps the text. Another answer for the key is an error. */
const textWithDecision = (
  deps: Deps,
  path: string,
  current: string | null,
  record: DecisionRecord,
): Result<{ readonly text: string; readonly outcome: DecisionWrite['outcome'] }, string> => {
  const known = decisionRecordsOf(deps, current);
  if (!known.ok) return err(`${path} cannot be read: ${known.error}`);
  const key = decisionKeyOf(deps, record.node, record.root, record.id);
  const stored = known.value.find((other) => decisionKeyOf(deps, other.node, other.root, other.id) === key);
  if (stored !== undefined) {
    return stored.option === record.option && stored.hash === record.hash
      ? ok({ text: current ?? decisionsText(known.value), outcome: 'existing' })
      : err(`${record.id} already has the decision "${stored.option}" from ${stored.at} in ${path}`);
  }
  if (known.value.length >= ownerDecisions.maxRecords) {
    return err(`${path} holds the most decision records that it can: ${ownerDecisions.maxRecords}`);
  }
  const text = decisionsText([...known.value, record]);
  return Buffer.byteLength(text, 'utf8') > ownerDecisions.maxBytes
    ? err(`${path} would be larger than ${ownerDecisions.maxBytes} bytes`)
    : ok({ text, outcome: 'stored' });
};

/**
 * Write one decision record. The decide command is the only caller, and it gives the time of its run. The channel check
 * comes first, before the lock. The file never drops a record, and one key never gets a second answer. A change that is
 * saved with a lock file left is a success with a warning that names the lock file.
 */
export const putDecision = async (deps: Deps, place: DecisionPlace, input: DecisionInput): Promise<CliResult<DecisionWrite>> => {
  const channel = requireDecideChannel(deps);
  if (!channel.ok) return channel;
  const path = place.path;
  if (path === null) return failure('the decision records have no place: no variable names a state folder');
  const record = decisionSchema.safeParse({
    [decisionKeys.node]: place.node,
    [decisionKeys.root]: place.root,
    [decisionKeys.id]: input.id,
    [decisionKeys.option]: input.option,
    [decisionKeys.hash]: input.hash,
    [decisionKeys.at]: input.at,
  });
  if (!record.success) return failure(`the decision record is not valid: ${describeIssues(record.error)}`);
  let outcome = 'stored' as DecisionWrite['outcome'];
  // Lock order (M9): the caller holds the state lock (outer). This store lock (inner) covers the write only. No code takes
  // the two locks in the other order.
  const written = await changePrivateFile(
    deps,
    path,
    ownerDecisions.maxBytes,
    async (current) => {
      const next = textWithDecision(deps, path, current, record.data);
      if (!next.ok) return next;
      outcome = next.value.outcome;
      return ok(next.value.text);
    },
    { recheckLock: true },
  );
  if (written.ok) return ok({ outcome, warning: null });
  return written.error.writeState === 'saved-lock-left'
    ? ok({ outcome, warning: written.error.message })
    : failure(`The decision was not recorded: ${written.error.message}`);
};
