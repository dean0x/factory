import { blockNames, layers } from '../../names.js';
import { coordinatorValuesFor, fillTemplate, workerValuesFor } from '../../templates/fill.js';
import type { BlockInput, BlockTemplate } from '../../templates/types.js';
import { approvalLines, type RecipeRoles } from '../entry.js';
import { softwareApprovalPoints } from './approval.js';
import { coordinatorLines } from './roles/coordinator.js';
import { MANAGER_LINES } from './roles/manager.js';
import { WORKER_LINES } from './roles/worker.js';

type RoleName = typeof blockNames.worker | typeof blockNames.coordinator | typeof blockNames.manager;

/** The worker block lives in the worker file in the state folder, so its paths are written from the factory folder. It names the session of the coordinator by the id of the node. */
const workerFor = (input: BlockInput): BlockTemplate => ({
  name: blockNames.worker,
  version: 2,
  target: 'workerFile',
  body: fillTemplate(WORKER_LINES, workerValuesFor(input)),
});

/** The manager block lives in the coordinator folder, so its paths are written from that folder. */
const managerFor = (input: BlockInput): BlockTemplate => ({
  name: blockNames.manager,
  version: 1,
  target: 'claudeFile',
  body: fillTemplate(MANAGER_LINES, coordinatorValuesFor(input)),
});

/**
 * The coordinator block has a section for the approval points, so its text follows the modes. It also states the context
 * limits of the shared file, and its paths are written from the coordinator folder.
 */
const coordinatorFor = (input: BlockInput): BlockTemplate => ({
  name: blockNames.coordinator,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(coordinatorLines(approvalLines(softwareApprovalPoints, input.modes)), coordinatorValuesFor(input)),
});

/**
 * The name of the role block of a layer: the worker for layer 0, the coordinator for layer 1, and the manager
 * for layer 2. A layer above 2 has no role, because each layer has its own role and the manager text does not fit another layer.
 */
const roleNameForLayer = (layer: number): RoleName | null => {
  if (layer <= layers.worker) return blockNames.worker;
  if (layer === layers.coordinator) return blockNames.coordinator;
  return layer === layers.manager ? blockNames.manager : null;
};

/** The role template of the layer of `input`, with the approval point text for its modes. */
const roleForLayer = (input: BlockInput): BlockTemplate | null => {
  const name = roleNameForLayer(input.layer);
  switch (name) {
    case null:
      return null;
    case blockNames.worker:
      return workerFor(input);
    case blockNames.coordinator:
      return coordinatorFor(input);
    case blockNames.manager:
      return managerFor(input);
    default: {
      const unreachable: never = name;
      return unreachable;
    }
  }
};

/** The roles of the software recipe. */
export const softwareRoles: RecipeRoles = {
  nameForLayer: roleNameForLayer,
  templateFor: roleForLayer,
  homeBlockNames: [blockNames.coordinator, blockNames.manager],
};
