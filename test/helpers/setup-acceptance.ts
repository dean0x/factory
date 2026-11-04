import { collectSetup } from '../../src/commands/init-received.js';
import { trackedSetOf } from '../../src/core/root-paths.js';
import { entryOfText, manifestOf, type Manifest } from '../../src/core/setup-acceptance.js';
import { commands, setupAcceptance } from '../../src/names.js';
import type { FakeDeps } from './fake-deps.js';

/** The store of the setup acceptances for a deps whose state folder is `/state`. */
export const ACCEPTANCES = '/state/factory/setup-acceptances.json';

/** The time of the acceptance that the helpers write. */
const ACCEPTED_AT = '2030-01-01T00:00:00.000Z';

const seedAcceptance = (deps: FakeDeps, root: string, node: string, manifest: Manifest, at: string): void =>
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
          at,
        },
      ],
    }),
  );

/**
 * Write the acceptance of these files of a root, as the store of the user holds it: the owner accepted the files as they
 * are now, for this node id. The files must be in the fake file system. A file that is blank counts as not in the set.
 */
export const acceptFiles = async (
  deps: FakeDeps,
  root: string,
  node: string,
  paths: readonly string[],
  at: string = ACCEPTED_AT,
): Promise<void> => {
  const collected = await collectSetup(deps, root, paths, commands.init);
  if (!collected.ok) throw new Error(collected.error.message);
  seedAcceptance(deps, root, node, collected.value.collected.manifest, at);
};

/**
 * Write the acceptance of the setup text that a test holds in memory: the owner accepted the setup texts of `tracked` as
 * `texts` gives them, for this node id. A text that is blank counts as not in the set, and so does every other file.
 */
export const acceptSetupText = (
  deps: FakeDeps,
  root: string,
  node: string,
  tracked: readonly string[],
  texts: Readonly<Record<string, string>>,
  at: string = ACCEPTED_AT,
): void => {
  const entries = setupAcceptance.setupTextFiles
    .filter((path) => tracked.includes(path) && (texts[path] ?? `${path}\n`).trim() !== '')
    .map((path) => entryOfText(path, texts[path] ?? `${path}\n`));
  if (entries.length > 0) seedAcceptance(deps, root, node, manifestOf(entries), at);
};

/**
 * Write the acceptance of the tracked set of a root: the owner accepted the files as they are now, for this node id.
 * The files must be in the fake file system.
 */
export const acceptTracked = (deps: FakeDeps, root: string, node: string, tracked: readonly string[]): Promise<void> =>
  acceptFiles(deps, root, node, trackedSetOf(tracked));
