import { chmodSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/factory.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // The yaml package is CommonJS and calls require() for Node modules. An ES module has no require().
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as createRequireForBundle } from 'node:module';",
      'const require = createRequireForBundle(import.meta.url);',
    ].join('\n'),
  },
  define: { __FACTORY_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
});

chmodSync('dist/factory.js', 0o755);
