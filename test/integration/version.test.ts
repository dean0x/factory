import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DIST } from './harness.js';

const run = promisify(execFile);
const ROOT = join(__dirname, '..', '..');

/** The commit of the source tree, or null when it is not a git work tree. */
const headOf = async (): Promise<string | null> => {
  try {
    return (await run('git', ['-C', ROOT, 'rev-parse', '--verify', 'HEAD'])).stdout.trim();
  } catch {
    return null;
  }
};

describe('factory version (built binary)', () => {
  it('prints the commit of the build, the commit of the source tree', async () => {
    const head = await headOf();
    const json = JSON.parse((await run(process.execPath, [DIST, 'version', '--json'])).stdout) as Record<string, unknown>;
    // A dist/factory.js from an older commit fails here: run "npm run build" again.
    expect(json.commit).toBe(head);
    expect(json.modified).toEqual(head === null ? null : expect.any(Boolean));

    const text = (await run(process.execPath, [DIST, 'version'])).stdout.split('\n');
    expect(text[0]).toBe(json.version);
    expect(text[1]).toMatch(head === null ? /^commit unknown$/ : new RegExp(`^commit ${head}( \\(with changes that were not committed\\))?$`));
  });
});
