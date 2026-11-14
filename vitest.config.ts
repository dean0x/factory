import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
import { scaled } from './test/integration/load.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * The most integration files that run at the same time. Each file starts tmux servers and the built program, so many files at
 * the same time load the machine, and the fixed waits run out. The limit keeps the default of a small machine.
 */
const INTEGRATION_FILES = Math.max(1, Math.min(4, availableParallelism() - 1));

export default defineConfig({
  define: { __FACTORY_VERSION__: JSON.stringify(pkg.version) },
  test: {
    testTimeout: scaled(30_000),
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          maxWorkers: INTEGRATION_FILES,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
