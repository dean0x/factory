import { join } from 'node:path';
import { z } from 'zod';
import { absolutePath, branchName, isSlug, slug } from '../config/primitives.js';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { LINK_REMEDY } from '../core/safe-write.js';
import { describeIssues } from '../core/zod.js';
import { files, roles, schemaIds, workerRecord } from '../names.js';
import { layoutOf, workerPathsOf } from '../state/layout.js';
import { parseJsonText } from '../state/load.js';

/**
 * The registry of the workers (design 4.6). Each worker has one file in a folder of its own, named by its id. The file says
 * what the worker is: its project, its work copy, its branch and the time of its creation. It holds no process id, because
 * a process id says nothing about a worker after a restart. This module is the only writer and the only reader of the file.
 */

const keys = workerRecord.keys;

const recordSchema = z.strictObject({
  [keys.schema]: z.literal(schemaIds.workerRecord),
  [keys.id]: slug,
  [keys.project]: slug,
  [keys.workCopy]: absolutePath,
  [keys.branch]: branchName,
  [keys.createdAt]: z.iso.datetime(),
});

/** The record of one worker. */
export interface WorkerRecord {
  readonly id: string;
  readonly project: string;
  /** The work copy of the worker: an absolute path. */
  readonly workCopy: string;
  readonly branch: string;
  /** The time that the record was made, as an ISO text. */
  readonly createdAt: string;
}

/** What a caller gives to make a record. The write sets the schema id and the time. */
export type NewWorker = Omit<WorkerRecord, 'createdAt'>;

/**
 * What a read finds: a valid record, a file that is not valid and the reason, or no record. A file that is well formed but names
 * a work copy or a branch that is not the one of its worker is invalid with `mismatch` set: a command that starts or ends a session
 * stops with a security refusal for it, and every other reader treats it as any invalid file.
 */
export type WorkerRead =
  | { readonly state: 'valid'; readonly record: WorkerRecord }
  | { readonly state: 'invalid'; readonly reason: string; readonly mismatch?: true }
  | { readonly state: 'absent' };

/** The branch of a worker. It starts at the head of the clone of the project. */
export const branchOf = (id: string): string => `${roles.worker}/${id}`;

/**
 * The work copy of a worker: `work-copies/<project>/<id>` of the factory folder. The path is fully derived from the project and the
 * id, so a reader compares the written path with this one and trusts no other.
 */
export const workCopyOf = (home: string, project: string, id: string): string => join(layoutOf(home).workCopiesDir, project, id);

/** A folder of the workers folder that holds no valid record: its name as text for a person, and the reason. */
export interface InvalidWorker {
  readonly name: string;
  readonly reason: string;
}

export interface WorkerList {
  /** The valid records, in the order of the ids. */
  readonly workers: readonly WorkerRecord[];
  readonly invalid: readonly InvalidWorker[];
}

const fileOf = (record: WorkerRecord): z.infer<typeof recordSchema> => ({
  [keys.schema]: schemaIds.workerRecord,
  [keys.id]: record.id,
  [keys.project]: record.project,
  [keys.workCopy]: record.workCopy,
  [keys.branch]: record.branch,
  [keys.createdAt]: record.createdAt,
});

const recordOf = (file: z.infer<typeof recordSchema>): WorkerRecord => ({
  id: file[keys.id],
  project: file[keys.project],
  workCopy: file[keys.workCopy],
  branch: file[keys.branch],
  createdAt: file[keys.createdAt],
});

const invalid = (reason: string): CliResult<WorkerRead> => ok({ state: 'invalid', reason });

const mismatch = (reason: string): CliResult<WorkerRead> => ok({ state: 'invalid', reason, mismatch: true });

/**
 * The record of a file text for the worker of this folder name, or the reason that the text is not a valid record. A record is
 * valid only when its work copy is exactly the path that the home, the project and the id give, and its branch is the branch of
 * the id: the file is the one place where a launch reads the folder to start a session in, so no other folder passes. The reason
 * names the expected value and never the written one.
 */
const readOfText = (text: string, id: string, home: string): CliResult<WorkerRead> => {
  const json = parseJsonText(text);
  if (!json.ok) return invalid(json.error);
  const parsed = recordSchema.safeParse(json.value);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  if (parsed.data[keys.id] !== id) return invalid('the id differs from the folder name');
  const record = recordOf(parsed.data);
  const expectedCopy = workCopyOf(home, record.project, record.id);
  if (record.workCopy !== expectedCopy) return mismatch(`the work copy of the record is not ${expectedCopy}`);
  if (record.branch !== branchOf(record.id)) return mismatch(`the branch of the record is not ${branchOf(record.id)}`);
  return ok({ state: 'valid', record });
};

/** What a read of one file in the folder of a worker finds: the text, a file that can not be read and the reason, or no file. */
export type WorkerFileRead =
  | { readonly state: 'text'; readonly text: string }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'absent' };

/** A path that `readCheckedFile` checks, and what it is, for the reason: for example `the pointer`. */
export interface NamedPath {
  readonly path: string;
  readonly what: string;
}

/**
 * Read a file below a chain of folders. The folders are checked from the top down, then the file: a part that is a link or of
 * the wrong kind is invalid, and a part that is missing is absent. The read never follows a link and caps the bytes. The reason
 * never holds a part of the file. The failure is a fault of the file system only.
 */
export const readCheckedFile = async (
  deps: Deps,
  folders: readonly NamedPath[],
  file: NamedPath,
  maxBytes: number,
): Promise<CliResult<WorkerFileRead>> => {
  const parts = [
    ...folders.map((folder) => ({ ...folder, kind: 'dir' as const })),
    { ...file, kind: 'file' as const },
  ];
  for (const { path, kind, what } of parts) {
    const found = await deps.fs.lstat(path);
    if (!found.ok) return found;
    if (found.value === null) return ok({ state: 'absent' });
    if (found.value === 'link') return ok({ state: 'invalid', reason: `${what} is a link` });
    if (found.value !== kind) return ok({ state: 'invalid', reason: `${what} is not a ${kind === 'dir' ? 'folder' : 'file'}` });
  }
  const info = await deps.fs.statInfo(file.path);
  if (!info.ok) return info;
  if (info.value === null) return ok({ state: 'absent' });
  if (info.value.size > maxBytes) return ok({ state: 'invalid', reason: `larger than ${maxBytes} bytes` });
  const text = await deps.fs.readTextLimited(file.path, maxBytes);
  return text.ok ? ok({ state: 'text', text: text.value }) : text;
};

/**
 * Read one file in the folder of a worker, for the record and for the pointer to the session. The read checks the workers
 * folder, the folder of the worker and the file (`readCheckedFile`). An id that is not a slug is invalid, and no path is touched.
 */
export const readWorkerFile = async (
  deps: Deps,
  home: string,
  id: string,
  file: { readonly of: 'recordFile' | 'lastSessionFile'; readonly what: string; readonly maxBytes: number },
): Promise<CliResult<WorkerFileRead>> => {
  if (!isSlug(id)) return ok({ state: 'invalid', reason: `the ${roles.worker} id is not a slug` });
  const paths = workerPathsOf(home, id);
  return readCheckedFile(
    deps,
    [
      { path: layoutOf(home).workersDir, what: `the ${roles.worker}s folder` },
      { path: paths.dir, what: `the folder of the ${roles.worker}` },
    ],
    { path: paths[file.of], what: file.what },
    file.maxBytes,
  );
};

/** Read the record of a worker. The checks of the read are those of `readWorkerFile`, then those of `readOfText`. */
export const readWorkerRecord = async (deps: Deps, home: string, id: string): Promise<CliResult<WorkerRead>> => {
  const found = await readWorkerFile(deps, home, id, { of: 'recordFile', what: 'the record', maxBytes: workerRecord.maxBytes });
  if (!found.ok) return found;
  return found.value.state === 'text' ? readOfText(found.value.text, id, home) : ok(found.value);
};

/** Whether the folder exists. A link is a security stop (exit 4) and is never followed. A path of another kind is a failure. */
const folderExists = async (deps: Deps, path: string): Promise<CliResult<boolean>> => {
  const found = await deps.fs.lstat(path);
  if (!found.ok) return found;
  if (found.value === 'link') return safetyRefusal(`cannot write in ${path}: it is a link`, LINK_REMEDY);
  if (found.value !== null && found.value !== 'dir') return failure(`cannot write in ${path}: it is not a folder`);
  return ok(found.value === 'dir');
};

/** Make the folder when it does not exist, with a check for a link before and after the make. */
const ensureFolder = async (deps: Deps, path: string): Promise<CliResult<void>> => {
  const exists = await folderExists(deps, path);
  if (!exists.ok) return exists;
  if (exists.value) return ok(undefined);
  const made = await deps.fs.mkdir(path, workerRecord.folderMode);
  if (!made.ok) return made;
  // A link can take the place of the new folder before the next write.
  const again = await folderExists(deps, path);
  if (!again.ok) return again;
  return again.value ? ok(undefined) : failure(`cannot write in ${path}: the folder is gone`);
};

/**
 * Write the record of a new worker, with the time of the clock, into a file of its own. The file is made with the exclusive
 * call, so a second write for the same id fails (exit 1) and the first record stays as it was, also when two commands race.
 * The fields are checked against the schema before any path is touched, and a failure never repeats a value. The folder of
 * the worker and its inbox folder are made too. A folder that is a link is a security stop (exit 4). A failure after the
 * record exists leaves the record. The value is the record.
 */
export const writeWorkerRecord = async (deps: Deps, home: string, worker: NewWorker): Promise<CliResult<WorkerRecord>> => {
  const record: WorkerRecord = { ...worker, createdAt: deps.now().toISOString() };
  const checked = recordSchema.safeParse(fileOf(record));
  if (!checked.success) return failure(`cannot record the ${roles.worker}: ${describeIssues(checked.error)}`);
  const paths = workerPathsOf(home, record.id);
  for (const folder of [layoutOf(home).workersDir, paths.dir]) {
    const ready = await ensureFolder(deps, folder);
    if (!ready.ok) return ready;
  }
  const created = await deps.fs.writeTextExclusive(paths.recordFile, `${JSON.stringify(checked.data)}\n`, workerRecord.fileMode);
  if (!created.ok) return created;
  if (!created.value) return failure(`cannot record the ${roles.worker} ${record.id}: it has a record already`);
  const inbox = await ensureFolder(deps, paths.inboxDir);
  return inbox.ok ? ok(record) : inbox;
};

/** A name from the file system as text for a person: a slug as it is, any other name as an escaped and cut text. */
const shownName = (name: string): string => (isSlug(name) ? name : JSON.stringify(name.slice(0, 40)));

/**
 * Read the record of every worker. A folder with no valid record is named in `invalid` with the reason, and the valid
 * records are listed all the same. A fault of the file system on one record puts that record in `invalid`. A workers folder
 * that is a link is a security stop (exit 4), and one that is not a folder, or holds more entries than the bound, is a
 * failure. No record is read through a link.
 */
export const listWorkerRecords = async (deps: Deps, home: string): Promise<CliResult<WorkerList>> => {
  const folder = layoutOf(home).workersDir;
  const found = await deps.fs.lstat(folder);
  if (!found.ok) return found;
  if (found.value === null) return ok({ workers: [], invalid: [] });
  if (found.value === 'link') return safetyRefusal(`cannot read ${folder}: it is a link`, LINK_REMEDY);
  if (found.value !== 'dir') return failure(`cannot read ${folder}: it is not a folder`);
  const names = await deps.fs.list(folder);
  if (!names.ok) return names;
  if (names.value.length > workerRecord.maxEntries) {
    return failure(`cannot list the ${roles.worker}s: ${folder} holds more than ${workerRecord.maxEntries} entries`);
  }
  const workers: WorkerRecord[] = [];
  const broken: InvalidWorker[] = [];
  for (const name of names.value) {
    const read = await readWorkerRecord(deps, home, name);
    if (!read.ok) broken.push({ name: shownName(name), reason: read.error.message });
    else if (read.value.state === 'valid') workers.push(read.value.record);
    else if (read.value.state === 'invalid') broken.push({ name: shownName(name), reason: read.value.reason });
    else broken.push({ name: shownName(name), reason: `the folder has no ${files.workerRecord}` });
  }
  return ok({ workers, invalid: broken });
};
