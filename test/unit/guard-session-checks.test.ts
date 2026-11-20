import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { Deps } from '../../src/core/deps.js';
import { boardKeys, files, guardIds } from '../../src/names.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { inPane } from '../helpers/coordinator-pane.js';
import { registerRoot } from '../helpers/fake-deps.js';
import { HOME } from '../helpers/guard-fixture.js';
import { FOLDER_ORIGINS, GUARD_STORE, guardStatesOf, guardStoreText, withGuardsOff, type GuardedSetup } from '../helpers/guarded-node.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const WORKER = 'alpha';
const START = boardText([itemRecord('B-1', { status: 'doing', stage: 'review', lane: WORKER })], []);

/** A board node whose local file holds each guard of the setup off, with the owner record unless the setup has none. */
const nodeOf = async (setup: GuardedSetup, origin: string): Promise<BoardRepo> => {
  const off = setup.off ?? [];
  const config = withGuardsOff(sampleConfigWithBoard(), off);
  const repo = await boardNode({ board: START, config });
  registerRoot(repo.deps, HOME, config.core.node.id, [], origin);
  if (setup.record !== false) repo.deps.seed(GUARD_STORE, guardStoreText(config.core.node.id, HOME, off, repo.deps.now()));
  return repo;
};

/** One command line of the node, with its exit code and its error output. */
const runOn = async (deps: Deps, words: readonly string[]): Promise<{ readonly code: number; readonly err: string }> => {
  const sink = captureSink();
  const code = await runCli([...words, '--home', HOME], deps, sink);
  return { code, err: sink.errors.join('') };
};

describe('the guard of the session checks: the caller rule of a coordinator step', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_folder, origin) => {
    it.each(guardStatesOf(guardIds.sessionChecks))('item unassign takes the worker off an item for a caller in a pane that is not the coordinator pane only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      const result = await runOn(inPane(repo.deps, '%1'), ['item', 'unassign', 'B-1']);
      expect(result.code, result.err).toBe(on ? 2 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 1);
      expect(repo.textOf(files.board)?.includes(`"${boardKeys.unassignedFrom}"`)).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.sessionChecks))('item unassign runs for a caller outside tmux only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      const result = await runOn(repo.deps, ['item', 'unassign', 'B-1']);
      expect(result.code, result.err).toBe(on ? 2 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 1);
    });
  });
});
