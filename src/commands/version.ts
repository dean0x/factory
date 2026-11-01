import type { CommandOutput } from '../cli/output.js';

export const runVersion = (version: string): CommandOutput => ({
  lines: [{ level: 'text', text: version }],
  json: { schema: 'factory.version/v1', version },
  warnings: [],
  failed: false,
});
