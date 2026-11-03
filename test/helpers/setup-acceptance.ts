import { collectSetup } from '../../src/commands/init-received.js';
import { trackedSetOf } from '../../src/core/root-paths.js';
import type { FakeDeps } from './fake-deps.js';

/** The store of the setup acceptances for a deps whose state folder is `/state`. */
export const ACCEPTANCES = '/state/factory/setup-acceptances.json';

/**
 * Write the acceptance of the tracked set of a root, as the store of the user holds it: the owner accepted the files as
 * they are now, for this node id. The files must be in the fake file system.
 */
export const acceptTracked = async (
  deps: FakeDeps,
  root: string,
  node: string,
  tracked: readonly string[],
): Promise<void> => {
  const collected = await collectSetup(deps, root, trackedSetOf(tracked));
  if (!collected.ok) throw new Error(collected.error.message);
  const { manifest } = collected.value.collected;
  deps.seed(
    ACCEPTANCES,
    JSON.stringify({
      schema: 1,
      acceptances: [
        {
          root,
          node,
          file: 'setup/coordinator.md',
          version: 1,
          manifest: manifest.entries,
          hash: manifest.hash,
          reason: 'test',
          at: '2030-01-01T00:00:00.000Z',
        },
      ],
    }),
  );
};
