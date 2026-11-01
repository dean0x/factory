import type { BlockSpec } from '../blocks/managed.js';
import { blockNames } from '../names.js';
import { COORDINATOR_LINES } from './coordinator.js';
import { PROFILE_INDEX_LINES, PROFILE_README_LINES } from './decision-profile.js';
import { fillTemplate } from './fill.js';
import { PROTOCOL_LINES } from './protocol.js';
import { ROADMAPS_README_LINES } from './roadmaps.js';
import { SAFETY_LINES } from './safety.js';

/** The file that holds a managed block. */
export type BlockTarget = 'claudeFile' | 'protocolFile';

export interface BlockTemplate extends BlockSpec {
  readonly target: BlockTarget;
}

export const blockTemplates: readonly BlockTemplate[] = [
  { name: blockNames.coordinator, version: 1, target: 'claudeFile', body: fillTemplate(COORDINATOR_LINES) },
  { name: blockNames.safety, version: 1, target: 'claudeFile', body: fillTemplate(SAFETY_LINES) },
  { name: blockNames.protocol, version: 1, target: 'protocolFile', body: fillTemplate(PROTOCOL_LINES) },
];

export const fileTemplates = {
  profileReadme: fillTemplate(PROFILE_README_LINES),
  profileIndex: fillTemplate(PROFILE_INDEX_LINES),
  roadmapsReadme: fillTemplate(ROADMAPS_README_LINES),
} as const;
