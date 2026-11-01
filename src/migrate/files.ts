import { blockNames, dirs, schema1 } from '../names.js';
import { stateRel } from '../state/layout.js';

/** A file or a folder that moves. Both paths are relative to the state folder. */
export interface FileMove {
  readonly from: string;
  readonly to: string;
}

/** A managed block that gets a new name. */
export interface BlockRename {
  readonly from: string;
  readonly to: string;
}

/** What changes in the files of the state folder when the state goes from version `from` to `to`. */
export interface FileStep {
  readonly from: number;
  readonly to: number;
  readonly moves: readonly FileMove[];
  readonly renames: readonly BlockRename[];
}

/** The renames of the managed blocks from state schema 1. The state migration uses the same list. */
export const schema1BlockRenames: readonly BlockRename[] = [{ from: schema1.protocolBlock, to: blockNames.worker }];

export const fileSteps: readonly FileStep[] = [
  {
    from: 1,
    to: 2,
    moves: [
      { from: schema1.protocolFile, to: stateRel.worker },
      { from: schema1.briefsDir, to: dirs.orders },
    ],
    renames: schema1BlockRenames,
  },
];

/** The steps that take the state from version `from` to version `to`, in order. */
export const stepsBetween = (steps: readonly FileStep[], from: number, to: number): readonly FileStep[] =>
  steps.filter((step) => step.from >= from && step.to <= to).sort((left, right) => left.from - right.from);
