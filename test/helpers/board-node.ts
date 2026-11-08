import type { FactoryConfig } from '../../src/config/schema.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { boardRepo, type BoardRepo, type BoardRepoOptions } from './board-repo.js';
import { registerRoot } from './fake-deps.js';
import { HOME } from './guard-fixture.js';
import { sampleConfigWithBoard, seedConfig } from './sample-config.js';

/**
 * A fake node for the tests of the board commands: the state repo of `boardRepo` (guard on, board files in the work tree), a config
 * with the sample `board` block, and the node in the factory list, so a command finds it with `--home`.
 */

/** The text of a board file in the old form: 2-space indent and a line break at the end. The queue key is the software one. */
export const boardText = (items: readonly Record<string, unknown>[] = [], tracks?: readonly Record<string, unknown>[]): string =>
  `${JSON.stringify({ [softwareQueueKey]: [], items, ...(tracks === undefined ? {} : { tracks }) }, null, 2)}\n`;

/** One item of the board file. */
export const itemRecord = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, title: `Item ${id}`, status: 'open', ...extra });

export interface BoardNodeOptions extends Partial<BoardRepoOptions> {
  /** The config of the node. Default: the sample config with the sample `board` block. */
  readonly config?: FactoryConfig;
}

export const boardNode = async (options: BoardNodeOptions = {}): Promise<BoardRepo> => {
  const { config = sampleConfigWithBoard(), ...repoOptions } = options;
  const repo = await boardRepo({ board: boardText([], []), env: { PATH: '/bin', XDG_STATE_HOME: '/state' }, ...repoOptions });
  seedConfig(repo.deps, HOME, config);
  registerRoot(repo.deps, HOME, config.core.node.id);
  return repo;
};
