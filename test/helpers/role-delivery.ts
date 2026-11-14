import { ownSettingsEntries } from '../../src/core/claude-settings.js';
import { acceptSetupText } from './setup-acceptance.js';
import type { FakeDeps } from './fake-deps.js';

/** The path of the owner setup text of a worker, as the setup acceptance names it. */
export const SETUP_WORKER = 'setup/roles/worker.md';

/** The node id of `sampleConfig`. */
const NODE_ID = 'demo';

/** The variables that name the state folder of the user. A check of the role text reads its store of acceptances there. */
export const STATE_ENV = { XDG_STATE_HOME: '/state' } as const;

/** The text of the settings file that the program writes into a work copy: every own hook entry, and no other key. */
export const OWN_SETTINGS_TEXT = `${JSON.stringify(ownSettingsEntries, null, 2)}\n`;

/** The settings file of a work copy. */
export const settingsFileOf = (workCopy: string): string => `${workCopy}/.claude/settings.local.json`;

/** The work copy holds the own hook entries, so a launch finds the hook that gives the role text. */
export const seedOwnHooks = (deps: FakeDeps, workCopy: string): void => deps.seed(settingsFileOf(workCopy), OWN_SETTINGS_TEXT);

/**
 * The owner wrote this setup text for the worker and accepted it, as it is now, for the node of `sampleConfig`. A node with no setup file and no
 * acceptance is valid too: the role text is then the package rules alone.
 */
export const seedAcceptedSetup = (deps: FakeDeps, home: string, text: string): void => {
  deps.seed(`${home}/${SETUP_WORKER}`, text);
  acceptSetupText(deps, home, NODE_ID, [SETUP_WORKER], { [SETUP_WORKER]: text });
};

/** The setup text is on disk, and the owner never accepted it: the role text is refused as not accepted (exit 4). */
export const seedUnacceptedSetup = (deps: FakeDeps, home: string, text: string): void => deps.seed(`${home}/${SETUP_WORKER}`, text);
