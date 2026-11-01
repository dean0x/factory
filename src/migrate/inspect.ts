import type { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import { describeIssues } from '../core/zod.js';
import { commands, commandText, program } from '../names.js';
import { ok } from '../core/result.js';

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

export const requireValid = <T>(state: DocState<T>, file: string): CliResult<T> => {
  switch (state.kind) {
    case 'valid':
      return ok(state.value);
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
