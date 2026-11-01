import type { z } from 'zod';
import { failure, type CliError, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok, type Err, type Result } from '../core/result.js';
import { describeIssues } from '../core/zod.js';
import { commands, commandText, program } from '../names.js';

/** What a versioned file holds, after the version check and the schema check. */
export type DocState<T> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unparsable'; readonly message: string }
  | { readonly kind: 'valid'; readonly raw: unknown; readonly version: number; readonly value: T }
  | {
      readonly kind: 'older' | 'newer';
      readonly raw: unknown;
      readonly version: number;
      readonly message: string;
    }
  | { readonly kind: 'invalid'; readonly raw: unknown; readonly message: string };

export interface VersionSpec<T> {
  readonly file: string;
  /** The key that holds the schema version, for example `schema`. */
  readonly key: string;
  /** The schema version that this factory reads and writes. */
  readonly supported: number;
  readonly schema: z.ZodType<T>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const inspectParsed = <T>(raw: unknown, spec: VersionSpec<T>): DocState<T> => {
  if (!isRecord(raw)) {
    return { kind: 'invalid', raw, message: `${spec.file} must hold a mapping of keys` };
  }
  const version = raw[spec.key];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'invalid', raw, message: `${spec.key}: must be a whole number, 1 or more` };
  }
  if (version > spec.supported) {
    return {
      kind: 'newer',
      raw,
      version,
      message: `${spec.file} has ${spec.key} ${version}, but this ${program} reads up to ${spec.supported}. Upgrade ${program}.`,
    };
  }
  if (version < spec.supported) {
    return {
      kind: 'older',
      raw,
      version,
      message: `${spec.file} has ${spec.key} ${version}, but this ${program} needs ${spec.supported}. Run "${commandText(commands.upgrade)}".`,
    };
  }
  const parsed = spec.schema.safeParse(raw);
  return parsed.success
    ? { kind: 'valid', raw, version, value: parsed.data }
    : { kind: 'invalid', raw, message: describeIssues(parsed.error) };
};

/** Turns the text of a file into a value. The error must not repeat the text: it names a position or a code. */
export type TextParser = (text: string) => Result<unknown, string>;

/** Read a file, parse its text, and check its version and its schema. */
export const inspectFile = async <T>(
  deps: Deps,
  path: string,
  parse: TextParser,
  spec: VersionSpec<T>,
): Promise<DocState<T>> => {
  const kind = await deps.fs.stat(path);
  if (!kind.ok) return { kind: 'unparsable', message: kind.error.message };
  if (kind.value !== 'file') return { kind: 'missing' };

  const text = await deps.fs.readText(path);
  if (!text.ok) return { kind: 'unparsable', message: text.error.message };
  const raw = parse(text.value);
  if (!raw.ok) return { kind: 'unparsable', message: raw.error };

  return inspectParsed(raw.value, spec);
};

/** A file that cannot be used as it is. The error says why. */
export const refuse = (state: Exclude<DocState<unknown>, { kind: 'valid' }>, file: string): Err<CliError> => {
  switch (state.kind) {
    case 'missing':
      return failure(`${file} not found`);
    case 'unparsable':
      return failure(`${file} does not parse: ${state.message}`);
    case 'invalid':
      return failure(`${file} is invalid: ${state.message}`);
    case 'older':
    case 'newer':
      return failure(state.message);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
};

export const requireValid = <T>(state: DocState<T>, file: string): CliResult<T> =>
  state.kind === 'valid' ? ok(state.value) : refuse(state, file);
