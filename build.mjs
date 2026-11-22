import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('.', import.meta.url));

/** The output of one git command in the package folder, or null when git fails or is not installed. */
const gitOutput = (args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/**
 * The commit of the build: the full id of HEAD, and whether tracked files had changes that were not committed. Both are null
 * when the package folder is not a git work tree, for example in a package from the registry: then the program prints "unknown".
 */
const buildCommit = () => {
  const head = gitOutput(['rev-parse', '--verify', 'HEAD'])?.trim() ?? '';
  if (!/^[0-9a-f]{40}$/.test(head)) return { commit: null, modified: null };
  const status = gitOutput(['status', '--porcelain', '--untracked-files=no']);
  return { commit: head, modified: status === null ? null : status.trim() !== '' };
};

const { commit, modified } = buildCommit();

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
  define: {
    __FACTORY_VERSION__: JSON.stringify(pkg.version),
    __FACTORY_COMMIT__: JSON.stringify(commit),
    __FACTORY_MODIFIED__: JSON.stringify(modified),
  },
  legalComments: 'none',
  logLevel: 'warning',
});

chmodSync('dist/factory.js', 0o755);
