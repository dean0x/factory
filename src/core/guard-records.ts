import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { sha256Hex } from '../blocks/managed.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { displayLineCore, removedByDisplay } from '../cli/output.js';
import { loadConfig } from '../config/load.js';
import { absolutePath, slug } from '../config/primitives.js';
import { CONFIG_SCHEMA_VERSION } from '../config/schema.js';
import { guardRulesOf, isSettable, type GuardProxies, type GuardRecord, type GuardRules } from '../guards/effective.js';
import { guardsFor } from '../guards/registry.js';
import type { GuardDefinition, GuardNeed, GuardValue, GuardValues } from '../guards/types.js';
import {
  commandLines, commands, commandText, env, files, guardRecords, guardRecordWords, guardSetWords, guardValues, privateFile, type CommandText,
} from '../names.js';
import type { RecipeEntry } from '../recipes/index.js';
import { parseJsonText } from '../state/load.js';
import { accessFaultCore } from './access.js';
import type { Deps, LinkInfo } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { freeLock, holdsLock, takeAgeLock } from './file-lock.js';
import { entryProblemOf } from './home.js';
import { isSameOrInsideFolder, isWrittenInside, realPathOf, userClaudeFolderOf } from './paths.js';
import { userFileLock, userFileLockPath, userStatePlaceOf, type StateFilePlace } from './private-file.js';
import { err, ok, type Result } from './result.js';

/** Guard records always require their own input and output terminals, outside either session type. */
export const requireGuardChannel = (deps: Deps, command: CommandText): CliResult<void> => {
  const remedy = `${guardRecordWords.channelRemedy} Then run "${commandText(command)}".`;
  if (inFactorySession(deps)) return safetyRefusal(guardRecordWords.sessionRefused, remedy);
  const claudeCode = deps.env[env.claudeCode];
  if (claudeCode !== undefined && claudeCode !== '') return safetyRefusal(guardRecordWords.claudeRefused, remedy);
  if (!deps.stdinIsTTY) return safetyRefusal(guardRecordWords.inputRequired, remedy);
  if (!deps.stdoutIsTTY) return safetyRefusal(guardRecordWords.outputRequired, remedy);
  return ok(undefined);
};

/** A pure place check. Readers and writers must refuse an inside place before any store access. */
export const guardStorePathOf = (deps: Deps, root: string): StateFilePlace => {
  const place = userStatePlaceOf(deps, files.guardRecords);
  return { path: place.path, inside: place.inside || (place.path !== null && isWrittenInside(deps, root, place.path)) };
};

const keys = guardRecords.keys;
const guardValueSchema = z.enum([guardValues.on, guardValues.off]);
const valueSchema = z.strictObject({
  [keys.value]: guardValueSchema,
  [keys.at]: z.iso.datetime(),
});
const prefixSchema = z.strictObject({
  [keys.hash]: z.string().regex(/^[0-9a-f]{64}$/),
  [keys.at]: z.iso.datetime(),
});
const recordSchema = z.strictObject({
  [keys.node]: slug,
  [keys.root]: absolutePath,
  [keys.values]: z.record(slug, valueSchema),
  [keys.prefix]: prefixSchema.nullable(),
});
const storeSchema = z.strictObject({
  [keys.schema]: z.literal(guardRecords.schema),
  [keys.records]: z.array(recordSchema).max(guardRecords.maxRecords),
});

/** The key uses the exact real root. Letter case never makes two records share a key. */
const recordKey = (node: string, root: string): string => JSON.stringify([node, resolve(root)]);

const recordsOf = (text: string | null): Result<readonly GuardRecord[], string> => {
  if (text === null) return ok([]);
  const json = parseJsonText(text);
  if (!json.ok) return json;
  const parsed = storeSchema.safeParse(json.value);
  if (!parsed.success) return err(guardRecordWords.invalidStore);
  const records = parsed.data.records;
  const unique = new Set(records.map((record) => recordKey(record.node, record.root)));
  return unique.size === records.length ? ok(records) : err(guardRecordWords.duplicate);
};

/** A link is never an acceptable folder or file. The mode check also applies without user ids. */
const usableInfo = (deps: Deps, info: LinkInfo, kind: 'file' | 'dir'): boolean =>
  info.kind !== 'link' && info.kind === kind && accessFaultCore(deps.uid, info) === null;

const checkedFolder = async (deps: Deps, path: string): Promise<Result<boolean, string>> => {
  const folder = await deps.fs.lstatInfo(dirname(path));
  if (!folder.ok) return err(folder.error.message);
  if (folder.value === null) return ok(false);
  return usableInfo(deps, folder.value, 'dir') ? ok(true) : err(guardRecordWords.badFolder);
};

/** Read the bounded store through its checked handle. Null means the file is absent. */
const readGuardStoreText = async (deps: Deps, path: string): Promise<Result<string | null, string>> => {
  const folder = await checkedFolder(deps, path);
  if (!folder.ok) return err(guardRecordWords.readFault(path, folder.error));
  const file = await deps.fs.lstatInfo(path);
  if (!file.ok) return err(guardRecordWords.readFault(path, file.error.message));
  if (file.value === null) return ok(null);
  if (!folder.value || !usableInfo(deps, file.value, 'file')) return err(guardRecordWords.readFault(path, guardRecordWords.badFile));
  if (file.value.kind !== 'link' && file.value.size > guardRecords.maxBytes) return err(guardRecordWords.byteCap);
  if (deps.fs.openCheckedCore === undefined) return err(guardRecordWords.adapterRequired);
  const opened = await deps.fs.openCheckedCore(path, { uid: deps.uid, maxBytes: guardRecords.maxBytes, decode: 'fatal' });
  if (!opened.ok) return err(guardRecordWords.readFault(path, opened.error.message));
  const value = opened.value;
  if (value.state !== 'opened' || value.text === null) {
    const reason = value.state === 'refused' && value.fault === 'size' ? guardRecordWords.byteCap : guardRecordWords.badOpen;
    return err(guardRecordWords.readFault(path, reason));
  }
  return ok(value.text);
};

export const readGuardStore = async (deps: Deps, path: string): Promise<Result<readonly GuardRecord[], string>> => {
  const text = await readGuardStoreText(deps, path);
  if (!text.ok) return text;
  const records = recordsOf(text.value);
  return records.ok ? records : err(guardRecordWords.readFault(path, records.error));
};

type GuardStoreResult = Result<readonly GuardRecord[], string>;
export type GuardStoreChange = (records: readonly GuardRecord[]) => GuardStoreResult | Promise<GuardStoreResult>;

const changedText = (records: readonly GuardRecord[]): Result<string, string> => {
  if (records.length > guardRecords.maxRecords) return err(guardRecordWords.recordCap);
  const text = JSON.stringify({ [keys.schema]: guardRecords.schema, [keys.records]: records });
  if (Buffer.byteLength(text, 'utf8') > guardRecords.maxBytes) return err(guardRecordWords.byteCap);
  const parsed = recordsOf(text);
  return parsed.ok ? ok(text) : parsed;
};

const writeLockedStore = async (
  deps: Deps, path: string, lockPath: string, token: string, change: GuardStoreChange,
): Promise<Result<void, string>> => {
  const current = await readGuardStore(deps, path);
  if (!current.ok) return current;
  const next = await change(current.value);
  if (!next.ok) return next;
  const text = changedText(next.value);
  if (!text.ok) return text;
  const folder = await checkedFolder(deps, path);
  if (!folder.ok) return folder;
  if (!folder.value) return err(guardRecordWords.badFolder);
  const held = await holdsLock(deps, lockPath, token);
  if (!held.ok || !held.value) return err(guardRecordWords.lockLost);
  if (deps.fs.writeTextAtomicCore === undefined) return err(guardRecordWords.adapterRequired);
  const written = await deps.fs.writeTextAtomicCore(path, text.value, dirname(path), privateFile.fileMode);
  return written.ok ? ok(undefined) : err(written.error.message);
};

export interface GuardRecordWrite {
  readonly warning: string | null;
}

/** Read, change and replace under one store lock. No invalid store can be replaced. */
export const changeGuardStore = async (deps: Deps, path: string, change: GuardStoreChange): Promise<Result<GuardRecordWrite, string>> => {
  if (deps.fs.openCheckedCore === undefined || deps.fs.writeTextAtomicCore === undefined) return err(guardRecordWords.adapterRequired);
  const folder = await checkedFolder(deps, path);
  if (!folder.ok) return folder;
  if (!folder.value) {
    const made = await deps.fs.mkdirOne(dirname(path), privateFile.folderMode);
    if (!made.ok) return err(made.error.message);
    const checked = await checkedFolder(deps, path);
    if (!checked.ok) return checked;
    if (!checked.value) return err(guardRecordWords.badFolder);
  }
  const lockPath = userFileLockPath(path);
  const locked = await takeAgeLock(deps, lockPath, userFileLock);
  if (!locked.ok) return locked;
  if (locked.value.kind !== 'taken') return err(locked.value.kind === 'link' ? guardRecordWords.lockLink : guardRecordWords.lockBusy);
  const written = await writeLockedStore(deps, path, lockPath, locked.value.token, change);
  const freed = await freeLock(deps, lockPath, locked.value.token);
  if (!written.ok) return written;
  return ok({ warning: freed.ok ? null : guardRecordWords.lockLeft });
};

interface GuardPlace {
  readonly root: string;
  readonly path: string | null;
}

/** Check both written and real places before any store access. The record key is the real root. */
const guardPlaceOf = async (deps: Deps, root: string, newRoot = false): Promise<CliResult<GuardPlace>> => {
  const place = guardStorePathOf(deps, root);
  if (place.inside) return safetyRefusal(guardRecordWords.inside, guardRecordWords.placeRemedy);
  const real = await (newRoot ? realPathOf(deps, root) : deps.fs.realpath(root));
  if (!real.ok) return real;
  if (place.path !== null) {
    const claude = userClaudeFolderOf(deps);
    for (const folder of claude === null ? [real.value] : [real.value, claude]) {
      const inside = await isSameOrInsideFolder(deps, folder, place.path);
      if (!inside.ok) return inside;
      if (inside.value) return safetyRefusal(guardRecordWords.inside, guardRecordWords.placeRemedy);
    }
  }
  return ok({ root: real.value, path: place.path });
};

/** A new node must have no earlier record for its id and root. */
export const requireFreshGuardRecord = async (deps: Deps, input: RecordPlaceInput): Promise<CliResult<void>> => {
  const place = await guardPlaceOf(deps, input.root, true);
  if (!place.ok) return place;
  if (place.value.path === null) return failure(guardRecordWords.noPlace);
  const text = await readGuardStoreText(deps, place.value.path);
  if (!text.ok) return failure(text.error);
  const records = recordsOf(text.value);
  // Malformed text supplies no records. The final write reports its fault and keeps the files.
  if (!records.ok) return ok(undefined);
  const key = recordKey(input.node, place.value.root);
  return records.value.some(({ root, node }) => recordKey(node, root) === key)
    ? failure(guardRecordWords.priorRecord, guardRecordWords.priorRecordRemedy) : ok(undefined);
};

export interface GuardChange {
  readonly guard: Pick<GuardDefinition, typeof keys.id | 'fixed'>;
  readonly value: GuardValue;
}

interface RecordPlaceInput {
  readonly root: string;
  readonly node: string;
}

const changeRecord = (
  records: readonly GuardRecord[], input: RecordPlaceInput, mode: 'new' | 'set', change: (record: GuardRecord) => GuardRecord,
): GuardStoreResult => {
  const key = recordKey(input.node, input.root);
  const current = records.find((record) => recordKey(record.node, record.root) === key);
  if (mode === 'new' && current !== undefined) return err(guardRecordWords.priorRecord);
  const next = change(current ?? { ...input, values: {}, prefix: null });
  return ok(current === undefined ? [...records, next] : records.map((record) => record === current ? next : record));
};

/** Init supplies the prefix to create one new record. A guard set changes only the named values. */
export const recordGuards = async (
  deps: Deps, input: RecordPlaceInput & { readonly change: readonly GuardChange[]; readonly prefix?: string },
): Promise<CliResult<GuardRecordWrite>> => {
  const channel = requireGuardChannel(deps, commandLines.guardSet);
  if (!channel.ok) return channel;
  for (const item of input.change) {
    if (item.guard.fixed) return usageError(guardSetWords.unknownId(displayLineCore(item.guard.id)));
    if (!slug.safeParse(item.guard.id).success || !guardValueSchema.safeParse(item.value).success) {
      return usageError(guardRecordWords.invalidChange);
    }
  }
  if (!slug.safeParse(input.node).success) return usageError(guardRecordWords.invalidChange);
  if (input.prefix !== undefined && removedByDisplay(input.prefix)) return usageError(guardRecordWords.badPrefix);
  const place = await guardPlaceOf(deps, input.root);
  if (!place.ok) return place;
  if (place.value.path === null) return failure(guardRecordWords.noPlace);
  const at = deps.now().toISOString();
  const prefix = input.prefix === undefined ? null : { hash: sha256Hex(input.prefix), at };
  const written = await changeGuardStore(deps, place.value.path, (records) => changeRecord(
    records, { node: input.node, root: place.value.root }, prefix === null ? 'set' : 'new', (current) => ({
      ...current,
      values: { ...current.values, ...Object.fromEntries(input.change.map((item) => [item.guard.id, { value: item.value, at }])) },
      prefix: prefix ?? current.prefix,
    }),
  ));
  return written.ok ? written : failure(guardRecordWords.writeFault(written.error));
};

/** The records of the node whose root differs from the real root only in letter case. */
const foldedRecordsOf = (records: readonly GuardRecord[], node: string, root: string): readonly GuardRecord[] => {
  const key = recordKey(node, root);
  const folded = resolve(root).toLowerCase();
  return records.filter((record) =>
    record.node === node && recordKey(record.node, record.root) !== key && resolve(record.root).toLowerCase() === folded);
};

/** The one record that a letter case rewrite may change: none when the store has the exact record, or more than one in other letter case. */
const rewritableOf = (records: readonly GuardRecord[], node: string, root: string): GuardRecord | null => {
  if (records.some((record) => recordKey(record.node, record.root) === recordKey(node, root))) return null;
  const [only, ...more] = foldedRecordsOf(records, node, root);
  return only !== undefined && more.length === 0 && only.root.toLowerCase() === root.toLowerCase() ? only : null;
};

/**
 * True when the stored root is itself a folder, not a link, and its real path is the real root. A link at the stored root reaches
 * the root by another name, so it differs from the root in more than letter case. The entry check does not follow the last link.
 */
const namesRootItself = async (deps: Deps, stored: string, root: string): Promise<boolean> => {
  const entry = await deps.fs.lstatInfo(stored);
  if (!entry.ok || entry.value?.kind !== 'dir') return false;
  const real = await deps.fs.realpath(stored);
  return real.ok && real.value === root;
};

/**
 * Write the one record of the node whose root differs from the real root only in letter case again, with the exact real root. It
 * writes only in the owner channel, only when the stored root is a folder and not a link, and its real path is the real root, so
 * both name the same folder, and only through the checked store place, its lock and the one store writer. The values and the
 * prefix of the record stay. The value is null when no record may change: none, more than one, a stored root that is a link or
 * no folder, or a stored root whose real path is another folder or none.
 */
export const recordExactRoot = async (deps: Deps, input: RecordPlaceInput): Promise<CliResult<GuardRecordWrite | null>> => {
  const channel = requireGuardChannel(deps, commands.upgrade);
  if (!channel.ok) return channel;
  if (!slug.safeParse(input.node).success) return usageError(guardRecordWords.invalidChange);
  const place = await guardPlaceOf(deps, input.root);
  if (!place.ok) return place;
  if (place.value.path === null) return failure(guardRecordWords.noPlace);
  const { root, path } = place.value;
  const read = await readGuardStore(deps, path);
  if (!read.ok) return failure(read.error);
  const stored = rewritableOf(read.value, input.node, root);
  if (stored === null || !(await namesRootItself(deps, stored.root, root))) return ok(null);
  const written = await changeGuardStore(deps, path, async (records) => {
    const again = rewritableOf(records, input.node, root);
    if (again === null || again.root !== stored.root) return err(guardRecordWords.caseMismatch);
    const current = await guardPlaceOf(deps, input.root);
    if (!current.ok || current.value.root !== root || current.value.path !== path || !(await namesRootItself(deps, again.root, root))) {
      return err(guardRecordWords.caseMismatch);
    }
    return ok(records.map((record) => (record === again ? { ...record, root } : record)));
  });
  return written.ok ? written : failure(guardRecordWords.writeFault(written.error));
};

/** Hash the exact prefix text. Guard values and all other node records stay unchanged. */
export const recordPrefix = async (
  deps: Deps, input: RecordPlaceInput & { readonly prefix: string },
): Promise<CliResult<GuardRecordWrite>> => {
  const channel = requireGuardChannel(deps, commandLines.guardConfirm);
  if (!channel.ok) return channel;
  if (removedByDisplay(input.prefix)) return usageError(guardRecordWords.badPrefix);
  if (!slug.safeParse(input.node).success) return usageError(guardRecordWords.invalidChange);
  const place = await guardPlaceOf(deps, input.root);
  if (!place.ok) return place;
  if (place.value.path === null) return failure(guardRecordWords.noPlace);
  const prefix = { hash: sha256Hex(input.prefix), at: deps.now().toISOString() };
  const written = await changeGuardStore(deps, place.value.path, (records) => changeRecord(
    records, { node: input.node, root: place.value.root }, 'set', (current) => ({ ...current, prefix }),
  ));
  return written.ok ? written : failure(guardRecordWords.writeFault(written.error));
};

/**
 * The guard state of one node home. The store fields (`record`, `prefix`, `fault`, `remedy`, `recordCount`) come from the store
 * alone, so the prefix check reads them whatever the proof gives. `proof` is null, or the reason that no off value counts.
 */
export interface GuardReadState extends GuardRules {
  readonly record: boolean;
  readonly prefix: GuardRecord[typeof keys.prefix];
  readonly fault: string | null;
  readonly remedy: string | null;
  readonly recordCount: number | null;
  readonly proof: string | null;
}

/** What the guard values need of a config. A full config fits, and so do the few keys that the pre-read of the guard values parses. */
export interface GuardConfig {
  readonly entry: RecipeEntry;
  readonly core: {
    readonly node: { readonly id: string };
    readonly guards: GuardValues;
    readonly shared_guards: GuardValues;
    readonly proxies: GuardProxies;
  };
}

/** True when the local file sets a non-fixed guard off: only then can a record of the guard store change a value. */
export const holdsLocalOff = (config: GuardConfig): boolean =>
  guardsFor(config.entry).some((guard) => isSettable(guard) && config.core.guards[guard.id] === guardValues.off);

/** True when the state holds what the store gave: its records or its fault. */
export const readsStore = (state: GuardReadState): boolean => state.recordCount !== null || state.fault !== null;

/** The state of a read that has no facts of the node: every guard is on, the store is not read, and `proof` gives the reason. */
export const unprovedState = (reason: string): GuardReadState => ({
  ...guardRulesOf([], { node: '', root: '' }), record: false, prefix: null, fault: null, remedy: null, recordCount: null, proof: reason,
});

/**
 * The proof of an off value: the full config of the files loads with every guard on and the recipe of the facts, it names the node
 * id of the facts, and the factory list names the home with that id. The value is the loaded config. A config that is not on disk,
 * for example a config after migrations that are not written yet, has no proof.
 */
const provenConfig = async (deps: Deps, home: string, config: GuardConfig): Promise<Result<GuardConfig, string>> => {
  const loaded = await loadConfig(deps, home, [config.entry]);
  if (!loaded.ok || loaded.value.core.node.id !== config.core.node.id) return err(guardRecordWords.unproved);
  const identity = { id: loaded.value.core.node.id, schema: CONFIG_SCHEMA_VERSION };
  const listed = await entryProblemOf(deps, home, async () => ok(identity));
  return listed.ok && listed.value === null ? ok(loaded.value) : err(guardRecordWords.unproved);
};

/**
 * Read at most one store. An off value counts only with its proof (`provenConfig`) and a matching record, and its rules use the
 * proved config. A failed proof or a failed read supplies only on values to every consumer. The reason stays in the state: `proof`
 * holds the reason of a failed proof, and `fault` holds the reason of a failed read.
 */
export const readGuardState = async (deps: Deps, home: string, config: GuardConfig, need: GuardNeed): Promise<GuardReadState> => {
  const off = holdsLocalOff(config);
  const proved = off ? await provenConfig(deps, home, config) : ok(config);
  const facts = proved.ok ? proved.value : config;
  const proof = proved.ok ? null : proved.error;
  const guards = guardsFor(facts.entry);
  const known = { node: facts.core.node.id, local: facts.core.guards, shared: facts.core.shared_guards, proxies: facts.core.proxies };
  const stateOf = (
    root: string, record: GuardRecord | null, fault: string | null,
    details: { readonly remedy?: string; readonly recordCount?: number } = {},
  ): GuardReadState => ({
    ...guardRulesOf(guards, { ...known, root, record, fault: fault ?? proof }), record: record !== null, prefix: record?.prefix ?? null, fault,
    remedy: details.remedy ?? null, recordCount: details.recordCount ?? null, proof,
  });
  if (need === 'when-off' && !off) return stateOf(home, null, null);
  const place = await guardPlaceOf(deps, home);
  if (!place.ok) return stateOf(home, null, place.error.message, place.error.hint === undefined ? {} : { remedy: place.error.hint });
  if (place.value.path === null) return stateOf(place.value.root, null, null, { recordCount: 0 });
  const read = await readGuardStore(deps, place.value.path);
  if (!read.ok) return stateOf(place.value.root, null, read.error, { remedy: guardRecordWords.unreadableRemedy });
  const { root } = place.value;
  const node = config.core.node.id;
  const key = recordKey(node, root);
  const found = read.value.find((record) => recordKey(record.node, record.root) === key);
  const details = { recordCount: read.value.length };
  // A match after a letter case fold can only stop the launch. It cannot supply a record.
  if (found === undefined && foldedRecordsOf(read.value, node, root).length > 0) {
    return stateOf(root, null, guardRecordWords.caseMismatch, { ...details, remedy: guardRecordWords.caseRemedy });
  }
  return stateOf(root, found === undefined ? null : { ...found, root }, null, details);
};
