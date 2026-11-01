import type { BlockSpec } from '../blocks/managed.js';
import { COORDINATOR_BODY } from './coordinator.js';
import { PROFILE_INDEX, PROFILE_README_FORMAT } from './decision-profile.js';
import { PROTOCOL_BODY } from './protocol.js';
import { ROADMAPS_README } from './roadmaps.js';
import { SAFETY_BODY } from './safety.js';

/** The file that holds a managed block. */
export type BlockTarget = 'claude-md' | 'protocol';

export interface BlockTemplate extends BlockSpec {
  readonly target: BlockTarget;
}

export const blockTemplates: readonly BlockTemplate[] = [
  { name: 'coordinator', version: 1, target: 'claude-md', body: COORDINATOR_BODY },
  { name: 'safety', version: 1, target: 'claude-md', body: SAFETY_BODY },
  { name: 'protocol', version: 1, target: 'protocol', body: PROTOCOL_BODY },
];

export const fileTemplates = {
  profileReadme: PROFILE_README_FORMAT,
  profileIndex: PROFILE_INDEX,
  roadmapsReadme: ROADMAPS_README,
} as const;
