import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { sha256Hex } from '../blocks/managed.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { removedByDisplay } from '../cli/output.js';
import { absolutePath, slug } from '../config/primitives.js';
import type { FactoryConfig } from '../config/schema.js';
import { guardRulesOf, type GuardRecord, type GuardRules } from '../guards/effective.js';
import { guardsFor } from '../guards/registry.js';
import type { GuardDefinition, GuardValue } from '../guards/types.js';
import { commandLines, commandText, env, files, guardRecords, guardRecordWords, guardSetWords, guardValues, privateFile, type CommandText } from '../names.js';
import { parseJsonText } from '../state/load.js';
import { accessFaultCore } from './access.js';
import type { Deps, LinkInfo } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { freeLock, holdsLock, takeAgeLock } from './file-lock.js';
import { comparable, isSameOrInsideFolder, isWrittenInside, userClaudeFolderOf } from './paths.js';
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

const recordKey = (deps: Deps, node: string, root: string): string => JSON.stringify([node, comparable(deps, resolve(root))]);

const recordsOf = (deps: Deps, text: string): Result<readonly GuardRecord[], string> => {
  const json = parseJsonText(text);
  if (!json.ok) return json;
  const parsed = storeSchema.safeParse(json.value);
  if (!parsed.success) return err(guardRecordWords.invalidStore);
  const records = parsed.data.records;
  const unique = new Set(records.map((record) => recordKey(deps, record.node, record.root)));
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

/** Read one bounded store through its checked handle. A missing store has no records. */
export const readGuardStore = async (deps: Deps, path: string): Promise<Result<readonly GuardRecord[], string>> => {
  const folder = await checkedFolder(deps, path);
  if (!folder.ok) return err(guardRecordWords.readFault(path, folder.error));
  const file = await deps.fs.lstatInfo(path);
  if (!file.ok) return err(guardRecordWords.readFault(path, file.error.message));
  if (file.value === null) return ok([]);
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
  const records = recordsOf(deps, value.text);
  return records.ok ? records : err(guardRecordWords.readFault(path, records.error));
};

export type GuardStoreChange = (records: readonly GuardRecord[]) => Result<readonly GuardRecord[], string>;

const changedText = (deps: Deps, records: readonly GuardRecord[]): Result<string, string> => {
  if (records.length > guardRecords.maxRecords) return err(guardRecordWords.recordCap);
  const text = JSON.stringify({ [keys.schema]: guardRecords.schema, [keys.records]: records });
  if (Buffer.byteLength(text, 'utf8') > guardRecords.maxBytes) return err(guardRecordWords.byteCap);
  const parsed = recordsOf(deps, text);
  return parsed.ok ? ok(text) : parsed;
};

const writeLockedStore = async (
  deps: Deps, path: string, lockPath: string, token: string, change: GuardStoreChange,
): Promise<Result<void, string>> => {
  const current = await readGuardStore(deps, path);
  if (!current.ok) return current;
  const next = change(current.value);
  if (!next.ok) return next;
  const text = changedText(deps, next.value);
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
const guardPlaceOf = async (deps: Deps, root: string): Promise<CliResult<GuardPlace>> => {
  const place = guardStorePathOf(deps, root);
  if (place.inside) return safetyRefusal(guardRecordWords.inside, guardRecordWords.placeRemedy);
  const real = await deps.fs.realpath(root);
  if (!real.ok) return real;
  if (place.path !== null) {
    const claude = userClaudeFolderOf(deps);
    for (const folder of claude === null ? [real.value] : [real.value, claude]) {
      const inside = await isSameOrInsideFolder(deps, folder, place.path);
      if (!inside.ok) return inside;
      if (inside.value) return safetyRefusal(guardRecordWords.inside, guardRecordWords.placeRemedy);
    }
  }
  return ok({ root: comparable(deps, real.value), path: place.path });
};

export interface GuardChange {
  readonly guard: Pick<GuardDefinition, typeof keys.id | 'wired'>;
  readonly value: GuardValue;
}

interface RecordPlaceInput {
  readonly root: string;
  readonly node: string;
}

const replaceRecord = (
  deps: Deps, records: readonly GuardRecord[], input: RecordPlaceInput, change: (record: GuardRecord) => GuardRecord,
): readonly GuardRecord[] => {
  const key = recordKey(deps, input.node, input.root);
  const current = records.find((record) => recordKey(deps, record.node, record.root) === key);
  const next = change(current ?? { ...input, values: {}, prefix: null });
  return current === undefined ? [...records, next] : records.map((record) => recordKey(deps, record.node, record.root) === key ? next : record);
};

/** The caller supplies guards from its recipe registry. Only their named values change. */
export const recordGuards = async (
  deps: Deps, input: RecordPlaceInput & { readonly change: readonly GuardChange[] },
): Promise<CliResult<GuardRecordWrite>> => {
  const channel = requireGuardChannel(deps, commandLines.guardSet);
  if (!channel.ok) return channel;
  for (const item of input.change) {
    if (!item.guard.wired) return usageError(guardSetWords.notSettable(item.guard.id));
    if (!slug.safeParse(item.guard.id).success || !guardValueSchema.safeParse(item.value).success) {
      return usageError(guardRecordWords.invalidChange);
    }
  }
  if (!slug.safeParse(input.node).success) return usageError(guardRecordWords.invalidChange);
  const place = await guardPlaceOf(deps, input.root);
  if (!place.ok) return place;
  if (place.value.path === null) return failure(guardRecordWords.noPlace);
  const at = deps.now().toISOString();
  const written = await changeGuardStore(deps, place.value.path, (records) => ok(replaceRecord(
    deps, records, { node: input.node, root: place.value.root }, (current) => ({
      ...current,
      values: { ...current.values, ...Object.fromEntries(input.change.map((item) => [item.guard.id, { value: item.value, at }])) },
    }),
  )));
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
  const written = await changeGuardStore(deps, place.value.path, (records) => ok(replaceRecord(
    deps, records, { node: input.node, root: place.value.root }, (current) => ({ ...current, prefix }),
  )));
  return written.ok ? written : failure(guardRecordWords.writeFault(written.error));
};

export interface GuardReadState extends GuardRules {
  readonly record: boolean;
  readonly prefix: GuardRecord[typeof keys.prefix];
  readonly fault: string | null;
  readonly remedy: string | null;
  readonly recordCount: number | null;
}

/** Read at most one store. A failed read supplies only on values to every consumer. */
export const readGuardState = async (
  deps: Deps, home: string, config: FactoryConfig, need: 'when-off' | 'always',
): Promise<GuardReadState> => {
  const guards = guardsFor(config.entry);
  const facts = { node: config.core.node.id, local: config.core.guards, shared: config.core.shared_guards, proxies: config.core.proxies };
  const stateOf = (
    root: string, record: GuardRecord | null, fault: string | null,
    details: { readonly remedy?: string; readonly recordCount?: number } = {},
  ): GuardReadState => ({
    ...guardRulesOf(guards, { ...facts, root, record, fault }), record: record !== null, prefix: record?.prefix ?? null, fault,
    remedy: details.remedy ?? null, recordCount: details.recordCount ?? null,
  });
  if (need === 'when-off' && !guards.some((guard) => guard.wired && facts.local[guard.id] === guardValues.off)) {
    return stateOf(home, null, null);
  }
  const place = await guardPlaceOf(deps, home);
  if (!place.ok) return stateOf(home, null, place.error.message, place.error.hint === undefined ? {} : { remedy: place.error.hint });
  if (place.value.path === null) return stateOf(place.value.root, null, null, { recordCount: 0 });
  const read = await readGuardStore(deps, place.value.path);
  if (!read.ok) return stateOf(place.value.root, null, read.error, { remedy: guardRecordWords.unreadableRemedy });
  const key = recordKey(deps, facts.node, place.value.root);
  const found = read.value.find((record) => recordKey(deps, record.node, record.root) === key);
  const record = found === undefined ? null : { ...found, root: place.value.root };
  return stateOf(place.value.root, record, null, { recordCount: read.value.length });
};
