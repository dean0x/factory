import { ignoreBrokenPipe } from './cli/broken-pipe.js';
import { renderInternalError } from './cli/output.js';
import { isHookRoute, runCli } from './cli/run.js';
import { createNodeDeps } from './core/node-deps.js';

const writer =
  (stream: NodeJS.WriteStream) =>
  (text: string): Promise<void> =>
    new Promise((resolve) => {
      stream.write(text, () => resolve());
    });

const stderr = writer(process.stderr);
const argv = process.argv.slice(2);

// The hook route exits 0 on every path, also when Claude Code closes a pipe before the route writes to it.
if (isHookRoute(argv)) ignoreBrokenPipe([process.stdout, process.stderr]);

const exitCode = await runCli(argv, createNodeDeps(), {
  stdout: writer(process.stdout),
  stderr,
  isTTY: process.stdout.isTTY,
}).catch(async (cause: unknown) => {
  await stderr(renderInternalError(cause));
  return 1;
});

process.exit(exitCode);
