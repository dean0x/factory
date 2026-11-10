import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { failure, safetyRefusal, type CliResult } from '../cli/errors.js';
import { INVISIBLE_FILLER, visibleText } from '../cli/output.js';
import { absolutePath, slug } from '../config/primitives.js';
import { commandText, commands, files, places, program, roles, setupAcceptance, trackedFiles } from '../names.js';
import { parseJsonText } from '../state/load.js';
import { ACCEPT_ANSWER, type Deps } from './deps.js';
import { inFactorySession } from './factory-session.js';
import { comparable, isSameOrInsideFolder } from './paths.js';
import { changePrivateFile, readPrivateText, STORE_INSIDE_FOLDER_REMEDY, userStatePathOf } from './private-file.js';
import { err, ok, type Result } from './result.js';
import { describeIssues } from './zod.js';

/**
 * The setup acceptance: the owner accepts the files that go into session instructions before a session starts, and again
 * when one of them changes. This file has its own store and its own writer. It is not an approval record: it imports
 * nothing of the approval record store, its record has no approval point and no mode, and it writes only this one kind.
 */

const keys = setupAcceptance.keys;

const MAX_PATH_CHARS = 4096;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BLOB_HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * A path below the factory folder, written with slashes: not absolute, with no `..` part and no control character. A path
 * with a line break would write lines of its own into a text that a person reads.
 */
const relativePath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine(
    (path) => !isAbsolute(path) && !CONTROL_CHARACTER.test(path) && !path.split('/').includes('..'),
    `must be a path below the ${places.folder}`,
  );

const entrySchema = z.strictObject({
  [keys.path]: relativePath,
  [keys.type]: z.enum(setupAcceptance.fileTypes),
  [keys.size]: z.number().int().min(0),
  [keys.sha256]: z.string().regex(SHA256_HEX),
  [keys.blob]: z.string().regex(BLOB_HEX).nullable(),
});

const reason = z
  .string()
  .min(1)
  .max(setupAcceptance.maxReasonChars)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not hold a control character');

const recordSchema = z.strictObject({
  [keys.root]: absolutePath,
  [keys.node]: slug,
  [keys.file]: relativePath,
  [keys.version]: z.number().int().min(1).max(setupAcceptance.formatVersion),
  [keys.manifest]: z.array(entrySchema).max(setupAcceptance.maxManifestFiles),
  [keys.hash]: z.string().regex(SHA256_HEX),
  [keys.reason]: reason,
  [keys.at]: z.iso.datetime(),
});

const storeSchema = z.strictObject({
  [keys.schema]: z.literal(setupAcceptance.schema),
  [keys.acceptances]: z.array(recordSchema).max(setupAcceptance.maxRecords),
});

/** One file of a manifest: its path, its type, its size, the SHA-256 of its bytes and its git blob id when git tracks it. */
export type ManifestEntry = z.infer<typeof entrySchema>;

/** One accepted set of files, as the store holds it. */
export type AcceptanceRecord = z.infer<typeof recordSchema>;

/** The files of a set, sorted by the bytes of their paths, with the format version and the combined hash. */
export interface Manifest {
  readonly version: number;
  readonly entries: readonly ManifestEntry[];
  readonly hash: string;
}

/** A manifest, and the text of each file that is small enough to show. The text comes from the bytes that the hash covers. */
export interface Collected {
  readonly manifest: Manifest;
  readonly texts: ReadonlyMap<string, string | null>;
}

/** The order of the bytes of the paths, the order of `git ls-files -z`. The order of a locale or of UTF-16 differs. */
const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

const sorted = (entries: readonly ManifestEntry[]): readonly ManifestEntry[] =>
  [...entries].sort((left, right) => compareBytes(left.path, right.path));

/**
 * The combined hash: SHA-256 over a header with the format version and one line for each file, in the order of the bytes
 * of the paths. A line holds the path, a NUL byte, the type, a NUL byte, the size, a NUL byte and the SHA-256 of the
 * bytes. A NUL byte can not be part of a path, so two sets of files never give one text. The git blob id is not in the
 * hash: the same bytes give the same hash whether git tracks the file or not.
 */
export const manifestHash = (entries: readonly ManifestEntry[]): string => {
  const lines = sorted(entries).map((entry) => `${entry.path}\0${entry.type}\0${entry.size}\0${entry.sha256}\n`);
  const header = `${program} setup manifest v${setupAcceptance.formatVersion}\n`;
  return createHash('sha256').update(`${header}${lines.join('')}`, 'utf8').digest('hex');
};

/** The manifest of these entries. */
export const manifestOf = (entries: readonly ManifestEntry[]): Manifest => ({
  version: setupAcceptance.formatVersion,
  entries: sorted(entries),
  hash: manifestHash(entries),
});

/**
 * The entry of a file whose text the caller holds: the size and the SHA-256 of its UTF-8 bytes, the same values that a read
 * of the file gives. A caller that wrote the file itself hashes the bytes that it wrote, so no later read can differ.
 */
export const entryOfText = (path: string, text: string): ManifestEntry => {
  const bytes = Buffer.from(text, 'utf8');
  return { path, type: 'file', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), blob: null };
};

const tooManyFiles = (): CliResult<never> =>
  safetyRefusal(
    `the setup holds more than ${setupAcceptance.maxManifestFiles} files`,
    `Remove the files that the ${places.folder} does not need, then run "${commandText(commands.init)}" again.`,
  );

/** True when the text holds a character of `INVISIBLE_FILLER`. */
export const holdsInvisibleFiller = (value: string): boolean => INVISIBLE_FILLER.test(value);

/** A path as one line of text: every control character shows as an escape, the line break and the tab among them. */
export const visiblePath = (path: string): string => visibleText(path).replaceAll('\n', '\\n').replaceAll('\t', '\\t');

const fileTooLarge = (path: string): CliResult<never> =>
  safetyRefusal(
    `the file ${visiblePath(path)} has more than ${trackedFiles.maxFileBytes} bytes, so ${program} does not hash it`,
    `Make the file smaller, or remove it from git with "git rm --cached", then run "${commandText(commands.init)}" again.`,
  );

/** What a caller of `collectManifest` can choose. */
export interface CollectOptions {
  /** A file up to this many bytes gives its text, read from the bytes that the hash covers. Default: the display bound. */
  readonly textLimit?: number;
}

/**
 * Read each file of the set to its end, and make the manifest from the bytes. The root is the factory folder, and each
 * path is a path below it. A file that is not there, a folder, a list over the bound and a file over the byte cap are
 * errors: the manifest never covers part of a set or part of a file. The size of a file is checked before its bytes are
 * read, and the read itself stops at the byte cap, so a file that grows during the read is an error. A link counts as a
 * link, and its bytes are the bytes that a session reads through it. `blobs` holds the git blob id of each file that git
 * tracks.
 */
export const collectManifest = async (
  deps: Deps,
  root: string,
  paths: readonly string[],
  blobs: ReadonlyMap<string, string> = new Map(),
  options: CollectOptions = {},
): Promise<CliResult<Collected>> => {
  const unique = [...new Set(paths)];
  if (unique.length > setupAcceptance.maxManifestFiles) return tooManyFiles();
  const entries: ManifestEntry[] = [];
  const texts = new Map<string, string | null>();
  for (const path of unique) {
    if (!relativePath.safeParse(path).success) {
      return failure(`the setup path ${visiblePath(path)} is not a path below the ${places.folder}`);
    }
    const absolute = join(root, path);
    const kind = await deps.fs.lstat(absolute);
    if (!kind.ok) return kind;
    if (kind.value !== 'file' && kind.value !== 'link') {
      return failure(`the setup path ${visiblePath(path)} is ${kind.value === null ? 'not there' : 'not a file'}`);
    }
    const info = await deps.fs.statInfo(absolute);
    if (!info.ok) return info;
    if (info.value === null || info.value.kind !== 'file') {
      return failure(`the setup path ${visiblePath(path)} is ${info.value === null ? 'not there' : 'not a file'}`);
    }
    if (info.value.size > trackedFiles.maxFileBytes) return fileTooLarge(path);
    const digest = await deps.fs.digestFile(absolute, options.textLimit ?? setupAcceptance.maxDisplayBytes, trackedFiles.maxFileBytes);
    if (!digest.ok) return digest;
    if (digest.value === null || digest.value.size > trackedFiles.maxFileBytes) return fileTooLarge(path);
    entries.push({ path, type: kind.value, size: digest.value.size, sha256: digest.value.sha256, blob: blobs.get(path) ?? null });
    texts.set(path, digest.value.text);
  }
  return ok({ manifest: manifestOf(entries), texts });
};

/** The files that the current manifest adds, removes or changes against an accepted manifest. */
export interface ManifestChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** Compare a manifest with the accepted one. With no accepted manifest, every file is added. */
export const manifestChange = (accepted: readonly ManifestEntry[] | null, current: readonly ManifestEntry[]): ManifestChange => {
  const before = new Map((accepted ?? []).map((entry) => [entry.path, entry]));
  const after = new Map(current.map((entry) => [entry.path, entry]));
  return {
    added: current.filter((entry) => !before.has(entry.path)).map((entry) => entry.path),
    removed: (accepted ?? []).filter((entry) => !after.has(entry.path)).map((entry) => entry.path),
    changed: current
      .filter((entry) => {
        const old = before.get(entry.path);
        return old !== undefined && (old.sha256 !== entry.sha256 || old.size !== entry.size || old.type !== entry.type);
      })
      .map((entry) => entry.path),
  };
};

/** The text as one word of a shell command: in single quotes, and a single quote inside is closed, escaped and opened. */
const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const shownIn = (change: ManifestChange, path: string): string =>
  change.added.includes(path) ? 'added' : change.changed.includes(path) ? 'changed' : 'unchanged';

const listOf = (title: string, paths: readonly string[]): readonly string[] =>
  paths.length === 0 ? [] : [`${title}:`, ...paths.map((path) => `  ${visiblePath(path)}`)];

/** The part of the prompt for one added or changed file: its text in full, or the reason why it is not shown. */
const fileSection = (input: {
  readonly root: string;
  readonly entry: ManifestEntry;
  readonly label: string;
  readonly text: string | null;
  readonly room: boolean;
}): readonly string[] => {
  const { root, entry, label, text, room } = input;
  const kind = entry.type === 'link' ? ', a link; the text is the text of its target' : '';
  const title = `---- ${visiblePath(entry.path)} (${label}${kind}) ----`;
  const end = `---- end of ${visiblePath(entry.path)} ----`;
  if (text !== null && room) return [title, visibleText(text), end];
  const why =
    text === null
      ? `This file has ${entry.size} bytes. The limit is ${setupAcceptance.maxDisplayBytes} bytes.`
      : `The files above use up the limit of ${setupAcceptance.maxDisplayTotalBytes} bytes.`;
  return [
    title,
    `${why} ${program} does not show the full text of this file, and it never shows part of a file.`,
    `Read it with: ${visiblePath(`cat -v -- ${quoted(join(root, entry.path))}`)}`,
    end,
  ];
};

/**
 * The text of the accept prompt. It lists each added, removed and changed file by name, and shows the full text of each
 * added and changed file. A file over the bound for one file is not shown in part: the prompt says so, names the path
 * and the command that reads it. The files past the total bound are treated in the same way. The default answer is no.
 * Every control character shows as an escape.
 */
export const acceptPromptText = (input: {
  readonly root: string;
  readonly node: string;
  readonly current: Collected;
  readonly accepted: readonly ManifestEntry[] | null;
}): string => {
  const { root, node, current, accepted } = input;
  const change = manifestChange(accepted, current.manifest.entries);
  const lines: string[] = [
    `The setup of the ${places.folder} ${visiblePath(root)} (${roles.node} id ${visiblePath(node)}) goes into the instructions of the sessions.`,
    `The ${roles.owner} must accept these files before a session starts.`,
    `Hash of all files: ${current.manifest.hash}`,
    ...(accepted === null ? [] : [`Hash of the files that you accepted before: ${manifestHash(accepted)}`]),
    ...listOf('Added files', change.added),
    ...listOf('Changed files', change.changed),
    ...listOf('Removed files', change.removed),
  ];
  let shown = 0;
  for (const entry of current.manifest.entries) {
    const label = shownIn(change, entry.path);
    if (label === 'unchanged') continue;
    // A caller can keep the text of a larger file for its own use. The prompt shows a file only up to the display bound.
    const text = entry.size > setupAcceptance.maxDisplayBytes ? null : (current.texts.get(entry.path) ?? null);
    const room = text !== null && shown + entry.size <= setupAcceptance.maxDisplayTotalBytes;
    if (room) shown += entry.size;
    lines.push('', ...fileSection({ root, entry, label, text, room }));
  }
  lines.push('', 'Accept these files? [y/N] ');
  return lines.join('\n');
};

const terminalRemedy = (): string =>
  `Run "${commandText(commands.init)}" in a terminal window outside a ${places.session}.`;

/** The accept steps need a terminal window for input and for output, so that the owner sees what he accepts. */
const requireTerminalWindow = (deps: Deps): CliResult<void> =>
  deps.stdinIsTTY && deps.stdoutIsTTY
    ? ok(undefined)
    : safetyRefusal('a setup acceptance needs a terminal window', terminalRemedy());

const requireOutsideSession = (deps: Deps): CliResult<void> =>
  inFactorySession(deps)
    ? safetyRefusal(`a ${places.session} cannot write a setup acceptance`, terminalRemedy())
    : ok(undefined);

/** The records of a store text. A file that does not exist holds no record. The error is the reason. */
const recordsOf = (content: string | null): Result<readonly AcceptanceRecord[], string> => {
  if (content === null) return ok([]);
  const json = parseJsonText(content);
  if (!json.ok) return json;
  const parsed = storeSchema.safeParse(json.value);
  return parsed.success ? ok(parsed.data.acceptances) : err(describeIssues(parsed.error));
};

/**
 * The records of the store file. A file that does not exist holds no record. A file or a folder that another user owns
 * or can write is refused, and so is a file over the size cap. The error is the reason.
 */
export const readAcceptances = async (deps: Deps, path: string): Promise<Result<readonly AcceptanceRecord[], string>> => {
  const content = await readPrivateText(deps, path, setupAcceptance.maxBytes);
  return content.ok ? recordsOf(content.value) : content;
};

/** The store file for a factory folder: in the state folder of the user, and never inside the factory folder. */
const storePathOf = async (deps: Deps, root: string): Promise<CliResult<string>> => {
  const path = await userStatePathOf(deps, files.setupAcceptances);
  if (!path.ok) return path;
  if (path.value === null) return failure('the setup acceptances have no place: no variable names a state folder');
  const inside = await isSameOrInsideFolder(deps, root, path.value);
  if (!inside.ok) return inside;
  if (inside.value) {
    return safetyRefusal(`the setup acceptances would be ${path.value}, inside the ${places.folder} ${root}`, STORE_INSIDE_FOLDER_REMEDY);
  }
  return ok(path.value);
};

const forRoot = (deps: Deps, records: readonly AcceptanceRecord[], root: string): readonly AcceptanceRecord[] =>
  records.filter((record) => comparable(deps, record.root) === comparable(deps, root));

const newestOf = (records: readonly AcceptanceRecord[]): AcceptanceRecord | null =>
  records.reduce<AcceptanceRecord | null>(
    (newest, record) => (newest === null || Date.parse(record.at) >= Date.parse(newest.at) ? record : newest),
    null,
  );

/**
 * What the store says about a set of files: `none` when no acceptance exists for this real folder under any node id (a
 * first acceptance), `accepted` when the node id and the hash match a record, and `changed` otherwise. A `changed`
 * result names the newest acceptance for the folder. A store that cannot be used is an error, and the caller stops.
 */
export type AcceptanceState =
  | { readonly state: 'none' }
  | { readonly state: 'accepted'; readonly record: AcceptanceRecord }
  | { readonly state: 'changed'; readonly record: AcceptanceRecord };

export const acceptanceState = async (
  deps: Deps,
  input: { readonly root: string; readonly node: string; readonly hash: string },
): Promise<CliResult<AcceptanceState>> => {
  const real = await deps.fs.realpath(input.root);
  if (!real.ok) return real;
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return path;
  const records = await readAcceptances(deps, path.value);
  if (!records.ok) return failure(`The setup acceptances cannot be used: ${records.error}`);
  const here = forRoot(deps, records.value, real.value);
  const newest = newestOf(here);
  if (newest === null) return ok({ state: 'none' });
  const match = here.find((record) => record.node === input.node && record.hash === input.hash);
  return ok(match === undefined ? { state: 'changed', record: newest } : { state: 'accepted', record: match });
};

/** The set that the owner accepts: the root, the node id, the path of the setup file, the files and the reason. */
export interface AcceptanceInput {
  readonly root: string;
  readonly node: string;
  readonly file: string;
  readonly entries: readonly ManifestEntry[];
  readonly reason: string;
}

/**
 * Only the code of `init` passes this. It lets the writer work with no terminal window, for a first acceptance of the setup
 * text alone: the coordinator text and the worker text, and no other file. `init` passes it only on a new root, for the
 * text that it wrote itself. A static test finds no other module that names it.
 */
export interface AcceptanceOptions {
  readonly fromInitYes?: true;
}

const NOT_FIRST = 'an acceptance for this folder exists already';

/** The store text with the record in place of the record of the same folder and node id. */
const textWithRecord = (
  deps: Deps,
  path: string,
  current: string | null,
  record: AcceptanceRecord,
  options: AcceptanceOptions,
): Result<string, string> => {
  const known = recordsOf(current);
  if (!known.ok) return err(`${path} cannot be read: ${known.error}`);
  // The check runs under the lock, so a second writer can not make the first acceptance in between.
  if (options.fromInitYes === true && forRoot(deps, known.value, record.root).length > 0) {
    return err(NOT_FIRST);
  }
  const same = (other: AcceptanceRecord): boolean =>
    comparable(deps, other.root) === comparable(deps, record.root) && other.node === record.node;
  const next = [...known.value.filter((other) => !same(other)), record];
  if (next.length > setupAcceptance.maxRecords) {
    return err(`the setup acceptances hold the most records that they can: ${setupAcceptance.maxRecords}`);
  }
  const content = `${JSON.stringify({ [keys.schema]: setupAcceptance.schema, [keys.acceptances]: next }, null, 2)}\n`;
  return Buffer.byteLength(content, 'utf8') > setupAcceptance.maxBytes
    ? err(`the setup acceptances would be larger than ${setupAcceptance.maxBytes} bytes`)
    : ok(content);
};

/**
 * Write a setup acceptance. This is the only writer of the store. It refuses inside a factory session. A person in a
 * terminal window (input and output) can write any set. With no terminal window the call writes only for `init` on a new
 * root, and only for a first acceptance (no acceptance exists for this folder under any node id) of a set that holds no
 * file apart from the setup text. That call has these limits also in a terminal window, because no answer backs it.
 */
export const recordSetupAcceptance = async (
  deps: Deps,
  input: AcceptanceInput,
  options: AcceptanceOptions = {},
): Promise<CliResult<void>> => {
  const outside = requireOutsideSession(deps);
  if (!outside.ok) return outside;
  if (options.fromInitYes === true) {
    if (input.entries.some((entry) => !setupAcceptance.setupTextFiles.some((path) => path === entry.path))) {
      return safetyRefusal('a setup acceptance without a terminal window covers the setup text only', terminalRemedy());
    }
  } else {
    const window = requireTerminalWindow(deps);
    if (!window.ok) return window;
  }
  if (input.entries.length > setupAcceptance.maxManifestFiles) return tooManyFiles();
  const real = await deps.fs.realpath(input.root);
  if (!real.ok) return real;
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return path;

  const manifest = manifestOf(input.entries);
  const record: AcceptanceRecord = {
    root: real.value,
    node: input.node,
    file: input.file,
    version: manifest.version,
    manifest: [...manifest.entries],
    hash: manifest.hash,
    reason: input.reason,
    at: deps.now().toISOString(),
  };
  const valid = recordSchema.safeParse(record);
  if (!valid.success) return failure(`The setup acceptance is not valid: ${describeIssues(valid.error)}`);
  const written = await changePrivateFile(deps, path.value, setupAcceptance.maxBytes, async (current) =>
    textWithRecord(deps, path.value, current, valid.data, options),
  );
  if (written.ok) return ok(undefined);
  return options.fromInitYes === true && written.error === NOT_FIRST
    ? safetyRefusal('a setup acceptance without a terminal window is for a first acceptance only', terminalRemedy())
    : failure(`The setup acceptance was not written: ${written.error}`);
};

/**
 * The question of the accept step, with no write: it shows the prompt and asks, with no as the default. It needs a
 * terminal window for input and for output, and it refuses inside a factory session. The prompt shows the change against
 * the newest acceptance for this real folder, and the hash of that acceptance. The value is true when the owner said yes.
 * A caller that must write the record at a later step (`init` writes it after the entry in the factory list) asks here and
 * writes with `recordSetupAcceptance`.
 */
export const askSetupAcceptance = async (
  deps: Deps,
  request: { readonly root: string; readonly node: string; readonly current: Collected },
): Promise<CliResult<boolean>> => {
  const outside = requireOutsideSession(deps);
  if (!outside.ok) return outside;
  const window = requireTerminalWindow(deps);
  if (!window.ok) return window;
  const real = await deps.fs.realpath(request.root);
  if (!real.ok) return real;
  const path = await storePathOf(deps, real.value);
  if (!path.ok) return path;
  const records = await readAcceptances(deps, path.value);
  if (!records.ok) return failure(`The setup acceptances cannot be used: ${records.error}`);

  const accepted = newestOf(forRoot(deps, records.value, real.value))?.manifest ?? null;
  const answer = await deps.prompt(
    acceptPromptText({ root: real.value, node: request.node, current: request.current, accepted }),
  );
  return answer.ok ? ok(ACCEPT_ANSWER.test(answer.value.trim())) : answer;
};

/**
 * The accept step for a set of files that a person looks at: it asks (see `askSetupAcceptance`), and on yes it writes the
 * acceptance. The value is true when the owner accepted. The caller decides when a step may ask at all: a first acceptance
 * belongs to `init`, and a dry run asks nothing.
 */
export const acceptSetup = async (
  deps: Deps,
  request: {
    readonly root: string;
    readonly node: string;
    readonly file: string;
    readonly current: Collected;
    readonly reason: string;
  },
): Promise<CliResult<boolean>> => {
  const answer = await askSetupAcceptance(deps, request);
  if (!answer.ok || !answer.value) return answer;
  const real = await deps.fs.realpath(request.root);
  if (!real.ok) return real;
  const written = await recordSetupAcceptance(deps, {
    root: real.value,
    node: request.node,
    file: request.file,
    entries: request.current.manifest.entries,
    reason: request.reason,
  });
  return written.ok ? ok(true) : written;
};
