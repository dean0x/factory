import { CELL_LAYER, COORDINATOR_LAYER } from '../../config/schema.js';
import { blockNames } from '../../names.js';
import { fillTemplate } from '../../templates/fill.js';
import type { BlockTemplate } from '../../templates/types.js';
import { COORDINATOR_LINES } from './roles/coordinator.js';
import { MANAGER_LINES } from './roles/manager.js';
import { WORKER_LINES } from './roles/worker.js';

const worker: BlockTemplate = {
  name: blockNames.worker,
  version: 1,
  target: 'workerFile',
  body: fillTemplate(WORKER_LINES),
};

const coordinator: BlockTemplate = {
  name: blockNames.coordinator,
  version: 2,
  target: 'claudeFile',
  body: fillTemplate(COORDINATOR_LINES),
};

const manager: BlockTemplate = {
  name: blockNames.manager,
  version: 1,
  target: 'claudeFile',
  body: fillTemplate(MANAGER_LINES),
};

/**
 * The role template of a layer: the worker for a cell (layer 0), the coordinator for layer 1,
 * and the manager for every layer above. This is the only lookup of a role. The caller passes a layer that the config checked.
 */
export const roleForLayer = (layer: number): BlockTemplate => {
  if (layer <= CELL_LAYER) return worker;
  return layer === COORDINATOR_LAYER ? coordinator : manager;
};

/** The role blocks that a node home can hold in its CLAUDE.md. */
export const homeRoleBlockNames: readonly string[] = [coordinator.name, manager.name];
