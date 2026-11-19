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

export const guardedNode = (options: FakeOptions = {}): FakeDeps => {
  const deps = createFakeDeps({ cwd: '/w', ...options, env: { [env.stateHome]: '/state', ...options.env } });
  const sample = sampleConfig();
  seedConfig(deps, GUARDED_HOME, { ...sample, core: { ...sample.core, guards: { [OFF_GUARD]: guardValues.off } } });
  registerRoot(deps, GUARDED_HOME, sample.core.node.id);
  const values = { [OFF_GUARD]: { value: guardValues.off, at: deps.now().toISOString() } };
  deps.seed(GUARD_STORE, JSON.stringify({ schema: guardRecords.schema, records: [{ node: sample.core.node.id, root: GUARDED_HOME, prefix: null, values }] }));
  return deps;
};

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
