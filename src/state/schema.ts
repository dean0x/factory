import { z } from 'zod';

export const STATE_SCHEMA_VERSION = 1;

export const BLOCK_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const nodeStateSchema = z.strictObject({
  schema_version: z.literal(STATE_SCHEMA_VERSION),
  created_with: z.string().min(1).max(40),
  blocks: z.record(z.string().regex(BLOCK_NAME_PATTERN, 'must be a block name'), z.number().int().min(1)),
});

export type NodeState = z.infer<typeof nodeStateSchema>;
