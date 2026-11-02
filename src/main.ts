import { renderInternalError } from './cli/output.js';
import { runCli } from './cli/run.js';
import { createNodeDeps } from './core/node-deps.js';

const writer =
  (stream: NodeJS.WriteStream) =>
  (text: string): Promise<void> =>
    new Promise((resolve) => {
      stream.write(text, () => resolve());
    });

const stderr = writer(process.stderr);

const exitCode = await runCli(process.argv.slice(2), createNodeDeps(), {
  stdout: writer(process.stdout),
  stderr,
  isTTY: process.stdout.isTTY,
}).catch(async (cause: unknown) => {
  await stderr(renderInternalError(cause));
  return 1;
});

process.exit(exitCode);
