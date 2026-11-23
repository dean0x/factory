/**
 * The ids of the guards of the software recipe, and the files whose texts or checks its rows cite. They live here, apart from the
 * rows, so that every file of the rows can use them.
 */

export const softwareGuardIds = {
  adminMerge: 'admin-merge',
  approvalMerge: 'approval-merge',
  approvalRelease: 'approval-release',
  mergeQuality: 'merge-quality',
  prRules: 'pr-rules',
} as const;

export const COORDINATOR_FILE = 'src/recipes/software/roles/coordinator.ts';
export const WORKER_FILE = 'src/recipes/software/roles/worker.ts';
export const MANAGER_FILE = 'src/recipes/software/roles/manager.ts';
export const SAFETY_FILE = 'src/templates/safety.ts';
export const WORK_RULES_FILE = 'src/templates/work-rules.ts';
export const WORDS_FILE = 'src/recipes/software/words.ts';
export const CONFIG_FILE = 'src/recipes/software/config.ts';
