import { z } from 'zod';
import { failure, type CliResult } from '../cli/errors.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { createInFolder } from '../core/safe-write.js';
import { eventFile, files, privateFile } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { tightenEventFolder } from './outbox.js';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type EventFields = Readonly<Record<string, z.infer<typeof scalar>>>;
export type EventWrite = 'written' | 'exists' | 'skipped';

export interface EventFileInput {
  readonly name: string;
  readonly fields: EventFields;
}

const invalidFields = () => failure('invalid event fields', 'Use only text, finite numbers, true, false or null as field values.');
const overLimit = () => failure(`the event file exceeds ${eventFile.maxBytes} bytes`, 'Use fewer bytes for the event fields.');

/** Encode only own data fields. Count the JSON syntax and the last line break in the byte cap. */
const eventTextOf = (fields: unknown): CliResult<string> => {
  if (typeof fields !== 'object' || fields === null) return invalidFields();
  try {
    const prototype: unknown = Object.getPrototypeOf(fields);
    if (prototype !== Object.prototype && prototype !== null) return invalidFields();
    const keys = Reflect.ownKeys(fields);
    if (keys.length > eventFile.maxBytes) return overLimit();
    let text = '{';
    for (const key of keys) {
      if (typeof key !== 'string') return invalidFields();
      const field = Object.getOwnPropertyDescriptor(fields, key);
      if (field?.enumerable !== true) return invalidFields();
      const value = scalar.safeParse(field.value);
      if (!value.success) return invalidFields();
      if (key.length > eventFile.maxBytes || (typeof value.data === 'string' && value.data.length > eventFile.maxBytes)) return overLimit();
      const separator = text === '{' ? '' : ',';
      text += `${separator}${JSON.stringify(key)}:${JSON.stringify(value.data)}`;
      if (Buffer.byteLength(text, 'utf8') + 2 > eventFile.maxBytes) return overLimit();
    }
    return ok(`${text}}\n`);
  } catch {
    return invalidFields();
  }
};

/** Create one private event file. Never replace a file or make a missing state folder. */
export const writeEventFile = async (deps: Deps, home: string, { name, fields }: EventFileInput): Promise<CliResult<EventWrite>> => {
  if (typeof name !== 'string' || !eventFile.namePattern.test(name) || name === files.report) {
    return failure('invalid event file name', eventFile.nameRemedy);
  }
  const text = eventTextOf(fields);
  if (!text.ok) return text;
  const { stateDir, outboxDir } = layoutOf(home);
  const state = await deps.fs.lstat(stateDir);
  if (!state.ok) return state;
  if (state.value === null) return ok('skipped');
  const tightened = await tightenEventFolder(deps, state.value, outboxDir);
  if (!tightened.ok) return tightened;
  const target = { parent: stateDir, folder: outboxDir, name, mode: privateFile.fileMode, folderMode: privateFile.folderMode };
  const created = await createInFolder(deps, target, text.value, 'accept-file');
  if (!created.ok) return created;
  return ok(created.value === null ? 'exists' : 'written');
};
