import { alwaysOnRow, at, codeRow, fixedTextRow, guardOf, textRow } from '../../guards/build.js';
import type { GuardDefinition, GuardRow } from '../../guards/types.js';
import { capitalize, commandLines, guardIds, keys, requestWords, roles } from '../../names.js';
import { softwareApprovalPoints } from './approval.js';
import { CONFIG_FILE, COORDINATOR_FILE, SAFETY_FILE, WORKER_FILE, WORK_RULES_FILE, softwareGuardIds } from './guard-parts.js';
import { softwareRuleRows } from './rule-rows.js';

export { softwareGuardIds } from './guard-parts.js';

/**
 * The guards of the software recipe and the rows of the registry that cite a file of it. A guard for each approval point, and the
 * rules for a push and a pull request. The recipe also holds the rows of a guard of the core that cite a role text or a config
 * parser of the recipe, because the core registry imports nothing from it.
 */

const { coordinator, manager, owner, worker } = roles;
const [mergePoint, releasePoint] = softwareApprovalPoints;
const PR_MERGE_FILE = 'src/recipes/software/pr-merge.ts';

export const softwareGuards: readonly GuardDefinition[] = [
  guardOf(
    softwareGuardIds.adminMerge,
    `${capitalize(owner)} proof for an admin merge`,
    `A merge that skips the branch rules of GitHub needs the admin flag and an ${owner} decision for that PR and head.`,
  ),
  guardOf(
    softwareGuardIds.approvalMerge,
    'Approval of a merge',
    `A merge waits for the go of the ${owner}.`,
    [`${keys.root.approval}.${mergePoint.id}`],
  ),
  guardOf(
    softwareGuardIds.approvalRelease,
    'Approval of a release',
    `A release waits for the go of the ${owner}.`,
    [`${keys.root.approval}.${releasePoint.id}`],
  ),
  guardOf(
    softwareGuardIds.mergeQuality,
    'Quality checks before a merge',
    'A merge uses the checked head SHA, green CI there and a posted review of a releasable change.',
  ),
  guardOf(
    softwareGuardIds.prRules,
    'Push and pull request rules',
    'A push, a pull request and a merge report follow the rules of the project.',
    [`${keys.root.recipe}.${keys.recipe.projects}[].${keys.project.defaultBranch}`],
  ),
];

const APPROVAL_FILES = [
  ...at('src/recipes/software/approval.ts', 'softwareApprovalPoints'),
  ...at('src/recipes/entry.ts', 'approvalLines'),
];

export const softwareGuardRows: readonly GuardRow[] = [
  // Approval delegation.
  textRow({
    id: 'delegation-wait-text',
    guard: guardIds.approvalDelegation,
    name: `The role text says that an approval point waits for the ${owner}, unless the ${owner} delegated it`,
    applies: `Role text of the ${coordinator} and the safety block`,
    harm: true,
    sites: [...at(COORDINATOR_FILE, 'coordinatorLines'), ...at(SAFETY_FILE, 'safetyLines')],
  }),
  textRow({
    id: 'delegation-session-text',
    guard: guardIds.approvalDelegation,
    name: 'The role text says that a delegation counts only for approved and assigned work and that a session never sets one',
    applies: `Role text of the ${coordinator} and the safety block`,
    harm: true,
    sites: [...at(COORDINATOR_FILE, 'coordinatorLines'), ...at(SAFETY_FILE, 'safetyLines')],
  }),

  // Approval of a merge and of a release.
  textRow({
    id: 'merge-point-text',
    guard: softwareGuardIds.approvalMerge,
    name: `A merge waits for the go of the ${owner}, or for one proof of approval and one proof of assignment when the point is delegated`,
    applies: 'Each merge of a pull request',
    harm: true,
    sites: [...APPROVAL_FILES, ...at(COORDINATOR_FILE, 'coordinatorLines'), ...at(SAFETY_FILE, 'safetyLines')],
  }),
  textRow({
    id: 'merge-head-text',
    guard: softwareGuardIds.mergeQuality,
    name: 'A merge happens only at the full head SHA that was checked, with green CI there, a posted review and a releasable change',
    applies: 'Each merge',
    harm: true,
    sites: at(COORDINATOR_FILE, 'coordinatorLines'),
  }),
  textRow({
    id: 'release-point-text',
    guard: softwareGuardIds.approvalRelease,
    name: `A release waits for the go of the ${owner}, or for a release scope that the ${owner} approved when the point is delegated`,
    applies: 'Each release',
    harm: true,
    sites: [...APPROVAL_FILES, ...at(COORDINATOR_FILE, 'coordinatorLines'), ...at(SAFETY_FILE, 'safetyLines')],
  }),

  // Pull request merge checks.
  codeRow({
    id: 'merge-caller',
    guard: guardIds.sessionChecks,
    name: `Only the ${coordinator} pane or an ${owner} terminal can call the merge command`,
    applies: 'Pull request merge',
    harm: true,
    sites: at(PR_MERGE_FILE, 'requireMergeCaller'),
  }),
  codeRow({
    id: 'merge-owner-proof',
    guard: guardIds.ownerGo,
    name: 'When the merge approval rule applies, the command needs a go for this PR and head',
    applies: 'Pull request merge',
    harm: true,
    sites: at(PR_MERGE_FILE, 'proofNeedOf'),
  }),
  codeRow({
    id: 'merge-approval-point',
    guard: softwareGuardIds.approvalMerge,
    name: 'The merge approval point uses the proof rule of its mode',
    applies: 'Pull request merge',
    harm: true,
    sites: at(PR_MERGE_FILE, 'proofNeedOf'),
  }),
  codeRow({
    id: 'admin-merge-proof',
    guard: softwareGuardIds.adminMerge,
    name: `An admin merge needs an ${owner} store go for this PR and head`,
    applies: 'Admin merge of a pull request',
    harm: true,
    sites: at(PR_MERGE_FILE, 'proofNeedOf'),
  }),

  // Board edits.
  textRow({
    id: 'board-commands-text',
    guard: guardIds.boardEdits,
    name: `Board files change only through the commands, and only the ${coordinator} changes the board`,
    applies: `Role text of the ${coordinator}, the ${worker} and the work rules`,
    harm: true,
    sites: [
      ...at(COORDINATOR_FILE, 'coordinatorLines'),
      ...at(WORKER_FILE, 'WORKER_LINES'),
      ...at(WORK_RULES_FILE, 'WORK_RULES_LINES'),
    ],
  }),
  textRow({
    id: 'board-flow-stages-text',
    guard: guardIds.boardEdits,
    name: 'The commands refuse the stages that only a flow sets',
    applies: `Role text of the ${coordinator}`,
    harm: false,
    sites: at(COORDINATOR_FILE, 'coordinatorLines'),
  }),
  textRow({
    id: 'board-worker-field-text',
    guard: guardIds.boardEdits,
    name: `The ${worker} field of an item changes only through the unassign command`,
    applies: `Role text of the ${coordinator}`,
    harm: false,
    sites: at(COORDINATOR_FILE, 'coordinatorLines'),
  }),
  fixedTextRow({
    id: 'board-reserved-names-text',
    guard: guardIds.boardEdits,
    name: 'No field takes a name that the program reserves',
    applies: `Role text of the ${coordinator}`,
    harm: false,
    sites: at(COORDINATOR_FILE, 'coordinatorLines'),
  }),

  // Clone and project rules that the config parser of the recipe applies.
  alwaysOnRow({
    id: 'clone-url',
    guard: guardIds.cloneRules,
    name: 'A clone URL has a safe form: a short text with no control character, no credential, no helper program and a listed scheme',
    applies: 'Project add, init with a clone and config parse',
    harm: true,
    sites: [
      ...at('src/core/clone-url.ts', 'reasons', 'parseCloneUrl'),
      ...at('src/commands/init-clone.ts', 'parseProjectUrl'),
      ...at(CONFIG_FILE, 'cloneUrlSchema'),
    ],
  }),
  alwaysOnRow({
    id: 'clone-project-path',
    guard: guardIds.cloneRules,
    name: 'A project folder is one plain name, not reserved and not the folder itself, and it stays inside the folder',
    applies: 'Config parse, project add, init with a clone and scan of the folder',
    harm: true,
    sites: [
      ...at('src/core/project-path.ts', 'projectPathIssue'),
      ...at('src/commands/init-clone.ts', 'checkPlainName'),
      ...at('src/commands/root-content.ts', 'scanProjects'),
      ...at(CONFIG_FILE, 'projectPathSchema'),
    ],
  }),
  alwaysOnRow({
    id: 'clone-unique-targets',
    guard: guardIds.cloneRules,
    name: 'Two projects cannot share a repo or a folder',
    applies: 'Config parse',
    harm: true,
    sites: at(CONFIG_FILE, 'normalUrlOf', 'uniqueProjectTargets'),
  }),

  // Context limits.
  textRow({
    id: 'context-limits-text',
    guard: guardIds.contextLimits,
    name: `A ${worker} finishes its step and saves a checkpoint at the prepare percent, and none goes past the max percent`,
    applies: `Role text of the ${coordinator} and the ${worker}`,
    harm: false,
    sites: [...at(COORDINATOR_FILE, 'workerSectionLines'), ...at(WORKER_FILE, 'WORKER_LINES')],
  }),
  textRow({
    id: 'context-no-self-compact',
    guard: guardIds.contextLimits,
    name: `A ${worker} does not compact or clear itself; the ${coordinator} does it when the ${worker} is idle`,
    applies: `Role text of the ${worker}`,
    harm: false,
    sites: at(WORKER_FILE, 'WORKER_LINES'),
  }),

  // Delete guard.
  textRow({
    id: 'no-lost-item-ids-text',
    guard: guardIds.deleteGuard,
    name: 'An item is marked closed and never removed from the board file',
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'coordinatorLines'),
  }),

  // Dismiss.
  fixedTextRow({
    id: 'dismiss-dry-run-text',
    guard: guardIds.dismiss,
    name: 'The dry run of a dismiss comes before the free',
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  textRow({
    id: 'dismiss-pushed-text',
    guard: guardIds.dismiss,
    name: `A ${worker} is freed only when its branch is pushed and its work copy is clean`,
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  textRow({
    id: 'dismiss-closed-proof-text',
    guard: guardIds.dismiss,
    name: `A ${worker} is freed in a session only when its item is closed`,
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  textRow({
    id: 'dismiss-session-text',
    guard: guardIds.dismiss,
    name: `The ${owner} hears about each dismiss that a session runs, and every other dismiss is a step of the ${owner}`,
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  fixedTextRow({
    id: 'dismiss-ask-owner-text',
    guard: guardIds.dismiss,
    name: `After a denied free, the ${coordinator} or ${manager} asks the ${owner} to free the ${worker} and never runs the command of the ${requestWords.request}`,
    applies: `Role text of the ${coordinator} and the ${manager}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  fixedTextRow({
    id: 'dismiss-copy-reviews-text',
    guard: guardIds.dismiss,
    name: `The review files of a ${worker} are copied from its inbox to the reviews folder before a dismiss`,
    applies: `Role text of the ${coordinator}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),
  fixedTextRow({
    id: 'dismiss-review-results-text',
    guard: guardIds.dismiss,
    name: `A ${worker} puts each review result in a named inbox file, because a dismiss deletes the inbox`,
    applies: `Role text of the ${worker}`,
    harm: false,
    sites: at(WORKER_FILE, 'WORKER_LINES'),
  }),
  textRow({
    id: 'dismiss-unpushed-text',
    guard: guardIds.dismiss,
    name: `A ${worker} removes its work copy after the merge only when no work is unpushed`,
    applies: `Role text of the ${worker}`,
    harm: true,
    sites: at(WORKER_FILE, 'WORKER_LINES'),
  }),

  // File and link safety.
  textRow({
    id: 'user-folder-text',
    guard: guardIds.fileLinkSafety,
    name: 'A session opens no file in the user folder of Claude Code',
    applies: `Role text of the ${worker} and the work rules`,
    harm: true,
    sites: [...at(WORKER_FILE, 'WORKER_LINES'), ...at(WORK_RULES_FILE, 'WORK_RULES_LINES')],
  }),

  // Folder trust.
  fixedTextRow({
    id: 'trust-question-text',
    guard: guardIds.folderTrust,
    name: `The ${owner} hears which pane waits when a new ${worker} shows a trust question`,
    applies: `After ${commandLines.workerNew}`,
    harm: true,
    sites: at(COORDINATOR_FILE, 'workerSectionLines'),
  }),

  // Machine limits to install rules.
  ...softwareRuleRows,
];
