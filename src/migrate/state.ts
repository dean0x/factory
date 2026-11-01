import { failure } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { stateKeys } from '../names.js';
import { schema1BlockRenames } from './files.js';
import { isRecord } from './inspect.js';
import type { Migration } from './runner.js';

const FROM = 1;
const TO = 2;

/** Schema 1 to 2: the version goes up, and the block names that changed in the state folder change in the map. */
const stateSchema1To2: Migration = {
  from: FROM,
  to: TO,
  apply: (raw) => {
    if (!isRecord(raw)) return failure('the state must be a mapping of keys');
    const blocks = raw[stateKeys.blocks];
    if (!isRecord(blocks)) return failure(`${stateKeys.blocks} must be a mapping`);
    const renamed = new Map(schema1BlockRenames.map((rename) => [rename.from, rename.to]));
    const taken = schema1BlockRenames.find((rename) => rename.from in blocks && rename.to in blocks);
    if (taken !== undefined) return failure(`${stateKeys.blocks} holds both ${taken.from} and ${taken.to}`);
    return ok({
      ...raw,
      [stateKeys.schemaVersion]: TO,
      [stateKeys.blocks]: Object.fromEntries(Object.entries(blocks).map(([name, version]) => [renamed.get(name) ?? name, version])),
    });
  },
};

/** The migrations of the state file. */
export const stateMigrations: readonly Migration[] = [stateSchema1To2];
