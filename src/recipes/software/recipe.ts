import { COORDINATOR_LAYER, MANAGER_LAYER, WORKER_LAYER } from '../../config/schema.js';
import { blockNames } from '../../names.js';
import { fillTemplate } from '../../templates/fill.js';
import type { BlockTemplate } from '../../templates/types.js';
import { approvalLines, type ApprovalModes } from '../index.js';
import { softwareApprovalPoints } from './approval.js';
import { coordinatorLines } from './roles/coordinator.js';
import { MANAGER_LINES } from './roles/manager.js';
import { WORKER_LINES } from './roles/worker.js';

type RoleName = typeof blockNames.worker | typeof blockNames.coordinator | typeof blockNames.manager;

const worker: BlockTemplate = {
  name: blockNames.worker,
  version: 1,
  target: 'workerFile',
  body: fillTemplate(WORKER_LINES),
};

const manager: BlockTemplate = {
  name: blockNames.manager,
  version: 1,
  target: 'claudeFile',
  body: fillTemplate(MANAGER_LINES),
};

/** The approval point lines of the recipe, one for each point. The text of a point follows its mode in `modes`. */
export const approvalRules = (modes: ApprovalModes): readonly string[] =>
  approvalLines(softwareApprovalPoints, modes);

/** The coordinator block has a section for the approval points, so its text follows the modes. */
const coordinatorFor = (modes: ApprovalModes): BlockTemplate => ({
  name: blockNames.coordinator,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(coordinatorLines(approvalRules(modes))),
});

/**
 * The name of the role block of a layer: the worker for layer 0, the coordinator for layer 1, and the manager
 * for layer 2. A layer above 2 has no role, because each layer has its own role and the manager text does not fit another layer.
 */
export const roleNameForLayer = (layer: number): RoleName | null => {
  if (layer <= WORKER_LAYER) return blockNames.worker;
  if (layer === COORDINATOR_LAYER) return blockNames.coordinator;
  return layer === MANAGER_LAYER ? blockNames.manager : null;
};

/**
 * The role template of a layer, with the approval point text for `modes`. This is the only lookup of a role template.
 * The caller passes a layer that the config checked.
 */
export const roleForLayer = (layer: number, modes: ApprovalModes): BlockTemplate | null => {
  const name = roleNameForLayer(layer);
  switch (name) {
    case null:
      return null;
    case blockNames.worker:
      return worker;
    case blockNames.coordinator:
      return coordinatorFor(modes);
    case blockNames.manager:
      return manager;
    default: {
      const unreachable: never = name;
      return unreachable;
    }
  }
};

/** The role blocks that a node home can hold in its CLAUDE.md. */
export const homeRoleBlockNames: readonly string[] = [blockNames.coordinator, blockNames.manager];
