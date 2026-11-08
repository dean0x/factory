import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { BoardConfig, BoardField } from '../config/schema.js';
import { ok } from '../core/result.js';
import { boardLimits, maxEchoChars, values } from '../names.js';
import type { FieldValue, FieldValues } from './contract.js';

/**
 * The owner fields of the setup (the `board` block of the config). The core has no default field and no default value: a field
 * that the setup does not name is refused, and so is a value outside the list. A field is display data and never proof.
 */

/** A field as a person types it: the name, and the value as text. */
export interface FieldInput {
  readonly name: string;
  readonly value: string;
}

type Target = BoardField['target'];

const [valuesKind, flagKind, tokenKind] = values.boardKinds;

/** The target of the fields of an item. The other target is a queue row. */
export const [itemTarget] = values.boardTargets;

const FLAG_ON = 'true';
const FLAG_OFF = 'false';

/** The fields that the setup declares for one target, in the order of the setup. No board block declares none. */
export const declaredFields = (board: BoardConfig | undefined, target: Target): readonly BoardField[] =>
  (board?.fields ?? []).filter((field) => field.target === target);

/** Typed text for a message: cleaned, cut and quoted. */
const shown = (text: string): string => JSON.stringify(displayLine(text, maxEchoChars));

const valueOf = (field: BoardField, text: string): CliResult<FieldValue> => {
  switch (field.kind) {
    case valuesKind:
      return field.values.includes(text)
        ? ok(text)
        : usageError(`the field ${field.name} takes one of these values: ${field.values.join(', ')}`);
    case tokenKind:
      return boardLimits.tokenPattern.test(text)
        ? ok(text)
        : usageError(`the field ${field.name} takes a token: 1 to 32 letters, digits, dots, underscores or hyphens`);
    case flagKind:
      return text === FLAG_ON || text === FLAG_OFF
        ? ok(text === FLAG_ON)
        : usageError(`the field ${field.name} takes ${FLAG_ON} or ${FLAG_OFF}`);
    default: {
      const unreachable: never = field;
      return unreachable;
    }
  }
};

/**
 * The values of the fields that a person gave for one target. A name that the setup does not declare for the target, a name
 * that is given twice and a value that the field does not take are usage errors (exit 2) that name the field. With
 * `complete`, each required field of the target must be there too: this is the case for a new item, not for a change. A name
 * is found in the declared list and never as a key of an object, so a name such as `constructor` reaches nothing.
 */
export const resolveFields = (
  board: BoardConfig | undefined,
  target: Target,
  inputs: readonly FieldInput[],
  options: { readonly complete: boolean },
): CliResult<FieldValues> => {
  const declared = declaredFields(board, target);
  const given: Record<string, FieldValue> = {};
  for (const input of inputs) {
    const field = declared.find((candidate) => candidate.name === input.name);
    if (field === undefined) {
      const known = declared.length === 0 ? 'the setup declares none' : `the setup declares: ${declared.map((entry) => entry.name).join(', ')}`;
      return usageError(`the field ${shown(input.name)} is not declared for the ${target}; ${known}`);
    }
    if (Object.hasOwn(given, field.name)) return usageError(`the field ${field.name} is given twice`);
    const value = valueOf(field, input.value);
    if (!value.ok) return value;
    given[field.name] = value.value;
  }
  if (options.complete) {
    const missing = declared.find((field) => field.required && !Object.hasOwn(given, field.name));
    if (missing !== undefined) return usageError(`the field ${missing.name} is required`);
  }
  return ok(given);
};
