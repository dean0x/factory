import type { FactoryConfig } from '../../src/config/schema.js';
import type { Deps } from '../../src/core/deps.js';
import { env, files, guardIds, guardRecords, guardValues, program } from '../../src/names.js';
import { createFakeDeps, registerRoot, type FakeDeps, type FakeOptions } from './fake-deps.js';
import { sampleConfig, seedConfig } from './sample-config.js';

/** A registered node whose local file sets one wired guard off, with the matching owner record in the guard store. */
export const GUARDED_HOME = '/h/guarded';
export const OTHER_HOME = '/h/other';
export const OFF_GUARD = guardIds.installRules;
export const GUARD_STORE = `/state/${program}/${files.guardRecords}`;
const LOCAL_FILE = `${GUARDED_HOME}/${files.localConfig}`;

/** How a test node holds its guards. Each field has the value of the default node when it is absent. */
export interface GuardedSetup {
  /** The guards that the local file sets off. Default: the one guard of `OFF_GUARD`. */
  readonly off?: readonly string[];
  /** False: the guard store holds no record, so every off value counts as on. Default: true. */
  readonly record?: boolean;
  /** The origin of the folder in the factory list. Default: none, so the folder counts as received. */
  readonly origin?: string;
  /** The config of the node before the guard values. Default: the sample config. */
  readonly config?: FactoryConfig;
}

/** The config with each guard of `off` set off in the local file. */
export const withGuardsOff = (config: FactoryConfig, off: readonly string[]): FactoryConfig => ({
  ...config,
  core: { ...config.core, guards: { ...config.core.guards, ...Object.fromEntries(off.map((id) => [id, guardValues.off])) } },
});

/** The text of a guard store with one owner record: each guard of `off` is off for the node id and the root. */
export const guardStoreText = (node: string, root: string, off: readonly string[], at: Date): string => {
  const values = Object.fromEntries(off.map((id) => [id, { value: guardValues.off, at: at.toISOString() }]));
  return JSON.stringify({ schema: guardRecords.schema, records: [{ node, root, prefix: null, values }] });
};

export const guardedNode = (options: FakeOptions = {}, setup: GuardedSetup = {}): FakeDeps => {
  const deps = createFakeDeps({ cwd: '/w', ...options, env: { [env.stateHome]: '/state', ...options.env } });
  const sample = setup.config ?? sampleConfig();
  const off = setup.off ?? [OFF_GUARD];
  seedConfig(deps, GUARDED_HOME, withGuardsOff(sample, off));
  registerRoot(deps, GUARDED_HOME, sample.core.node.id, [], setup.origin);
  if (setup.record !== false) deps.seed(GUARD_STORE, guardStoreText(sample.core.node.id, GUARDED_HOME, off, deps.now()));
  return deps;
};

/**
 * The three states of one guard on a test node: on, off with the matching owner record, and off with no record. Each state gives
 * its name, its setup and true when the guard counts as on. Only the second state turns the guard off.
 */
export const guardStatesOf = (id: string): readonly (readonly [string, GuardedSetup, boolean])[] => [
  ['on', { off: [] }, true],
  ['off with a matching record', { off: [id] }, false],
  ['off with no record', { off: [id], record: false }, true],
];

/** The two folder origins of a node, as the factory list names them. */
export const FOLDER_ORIGINS = [
  ['an own folder', 'own'],
  ['a received folder', 'received'],
] as const;

/** The faults of the pre-read of the guard values. Each one gives every guard on. */
export const PRE_READ_FAULTS: readonly (readonly [string, (deps: FakeDeps) => Deps])[] = [
  ['a local file that other accounts can change', (deps) => {
    deps.modes.set(LOCAL_FILE, 0o666);
    return deps;
  }],
  ['a local file that is not YAML', (deps) => {
    deps.seed(LOCAL_FILE, 'guards: [');
    return deps;
  }],
  ['a guard store that is not JSON', (deps) => {
    deps.seed(GUARD_STORE, 'invalid');
    return deps;
  }],
  ['a file call that throws', (deps) => ({ ...deps, fs: { ...deps.fs, stat: () => Promise.reject(new Error('EIO')) } })],
];
