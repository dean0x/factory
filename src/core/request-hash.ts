import { sha256Hex } from '../blocks/managed.js';
import { requestHash } from '../names.js';
import { err, ok, type Result } from './result.js';

/**
 * The hash of a decision request (AC-39). This module owns the canonical text and the hash, so the core, the workers and the
 * board use one rule. The canonical text of a request is the JSON of the wrapper `{ tag, version, request }`, where `request`
 * is the whole waiting entry. The keys are sorted at every level, the order of an array stays, and the text has no white space
 * between tokens. The text uses the stored strings: nothing is trimmed or cleaned.
 *
 * A consumer hashes the stored text with `requestHashOf` and no other step.
 */

/** The deepest nesting of a value. A waiting entry has three levels, so a deeper value is not a request. */
const MAX_DEPTH = 32;

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The canonical JSON of a value that JSON can hold. The error is the reason that it can not. */
const canonicalValue = (value: unknown, depth: number): Result<string, string> => {
  if (depth > MAX_DEPTH) return err(`the value is nested deeper than ${MAX_DEPTH} levels`);
  if (value === null) return ok('null');
  if (typeof value === 'string') return ok(JSON.stringify(value));
  if (typeof value === 'boolean') return ok(value ? 'true' : 'false');
  if (typeof value === 'number') return Number.isFinite(value) ? ok(JSON.stringify(value)) : err('a number is not finite');
  if (typeof value !== 'object') return err(`a value of the type ${typeof value} is not JSON`);

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const part = canonicalValue(value[index], depth + 1);
      if (!part.ok) return part;
      parts.push(part.value);
    }
    return ok(`[${parts.join(',')}]`);
  }

  if (!isPlainObject(value)) return err('an object that is not plain is not JSON');
  const record = value as Readonly<Record<string, unknown>>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const part = canonicalValue(record[key], depth + 1);
    if (!part.ok) return part;
    parts.push(`${JSON.stringify(key)}:${part.value}`);
  }
  return ok(`{${parts.join(',')}}`);
};

/**
 * The canonical request text of a waiting entry. The error is the reason when the entry holds a value that JSON can not hold.
 */
export const canonicalRequestText = (entry: Readonly<Record<string, unknown>>): Result<string, string> =>
  canonicalValue(
    {
      [requestHash.keys.tag]: requestHash.tag,
      [requestHash.keys.version]: requestHash.version,
      [requestHash.keys.request]: entry,
    },
    0,
  );

/** The request hash: SHA-256 of the UTF-8 bytes of the canonical request text, as lowercase hex. */
export const requestHashOf = (canonicalText: string): string => sha256Hex(canonicalText);
