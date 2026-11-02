import { z } from 'zod';
import { stateKeys } from '../names.js';

export const STATE_SCHEMA_VERSION = 2;

export const BLOCK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const nodeStateSchema = z.strictObject({
  [stateKeys.schemaVersion]: z.literal(STATE_SCHEMA_VERSION),
  [stateKeys.createdWith]: z.string().min(1).max(40),
  [stateKeys.blocks]: z.record(z.string().regex(BLOCK_NAME_PATTERN, 'must be a block name'), z.number().int().min(1)),
});

export type NodeState = z.infer<typeof nodeStateSchema>;
