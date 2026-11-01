import type { CommandOutput } from '../cli/output.js';
import { schemaIds } from '../names.js';

export const runVersion = (version: string): CommandOutput => ({
  lines: [{ level: 'text', text: version }],
  json: { schema: schemaIds.version, version },
  warnings: [],
  failed: false,
});
