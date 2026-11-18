import { commandLines, commands, guardIds, places, roles } from '../names.js';
import { at, codeRow, textRow } from './build.js';
import type { GuardRow } from './types.js';

const { coordinator, owner, worker } = roles;
const folder = places.folder;

const rootScanRows: readonly GuardRow[] = [
  codeRow({
    id: 'root-scan-clean',
    guard: guardIds.rootScan,
    name: `A scan of the ${folder} that finds a fault stops ${commands.start}, so no session starts on a ${folder} with secrets, links or unsafe settings`,
    applies: `${commands.start} and ${commands.upgrade}`,
    harm: true,
    sites: [
      ...at('src/commands/root-content.ts', 'scanRoot', 'requireNoFailures', 'requireRootClean'),
      ...at('src/commands/start.ts', 'runStart'),
    ],
  }),
  codeRow({
    id: 'local-files-ignored',
    guard: guardIds.rootScan,
    name: 'Git must ignore the local config and the state folder, so approval records and state are never committed or pushed',
    applies: `Scan of the ${folder}, received init, ${commands.start} and doctor`,
    harm: true,
    sites: [...at('src/commands/root-content.ts', 'scanIgnoreRules'), ...at('src/commands/init-received.ts', 'checkIgnoreRules')],
  }),
  codeRow({
    id: 'ignore-lists',
    guard: guardIds.rootScan,
    name: `The shared list of the ${folder} names only the files that may be shared, and the state repo ignores runtime files, locks, backup copies, ${worker} folders, inboxes, event files and reviews`,
    applies: `${commands.init} and ${commands.upgrade}`,
    harm: true,
    sites: [
      ...at('src/state/files.ts', 'withShareList', 'locateShareList', 'withAddedLines'),
      ...at('src/state/gitignore.ts', 'rootGitignoreOf', 'stateGitignoreOf'),
    ],
  }),
  codeRow({
    id: 'ignored-check-fails-closed',
    guard: guardIds.rootScan,
    name: 'A doubt in the check for an ignored path counts as not ignored, so a private file never counts as ignored',
    applies: `${commands.init}, ${commands.upgrade} and the delivery of a task file`,
    harm: true,
    sites: [...at('src/core/git.ts', 'ignoredPathsOf'), ...at('src/state/files.ts', 'ignoresLine')],
  }),
  codeRow({
    id: 'local-files-not-tracked',
    guard: guardIds.rootScan,
    name: `A scan stops when git tracks the local config, the state folder, the folder of the ${coordinator} or a clone folder, so personal values and clones do not go out with a push`,
    applies: `${commands.init}, ${commands.start}, ${commands.upgrade} and doctor`,
    harm: true,
    sites: [
      ...at('src/commands/root-content.ts', 'scanRepo'),
      ...at('src/core/root-paths.ts', 'trackedProblems', 'describeTrackedProblems'),
      ...at('src/commands/init-received.ts', 'requireNoTrackedProblems'),
      ...at('src/commands/setup-check.ts', 'trackedSetOfRoot'),
    ],
  }),
  codeRow({
    id: 'received-tracked-links',
    guard: guardIds.rootScan,
    name: `A received ${folder} that tracks a link fails the scan, so no read or write leaves the ${folder} through a link`,
    applies: `Scan of a received ${folder}`,
    harm: true,
    sites: [...at('src/commands/root-content.ts', 'scanRepo'), ...at('src/core/root-paths.ts', 'requireNoTrackedLinks')],
  }),
  codeRow({
    id: 'other-ignore-rules-warning',
    guard: guardIds.rootScan,
    name: `The ${owner} sees a warning when the folder of the ${coordinator}, a work copy or a project folder is not ignored`,
    applies: `Scan of the ${folder}`,
    harm: false,
    sites: at('src/commands/root-content.ts', 'scanIgnoreRules'),
  }),
  codeRow({
    id: 'tracked-clones-warning',
    guard: guardIds.rootScan,
    name: `The ${owner} sees a warning when git tracks a clone, a work copy or a shared instruction or settings file`,
    applies: `Scan of the ${folder}`,
    harm: false,
    sites: at('src/commands/root-content.ts', 'scanRepo'),
  }),
  codeRow({
    id: 'tracked-text-paths-warning',
    guard: guardIds.rootScan,
    name: `The ${owner} sees a warning when a tracked text holds a file address, a user path or a file that cannot be read`,
    applies: `Scan of the ${folder}`,
    harm: false,
    sites: at('src/commands/root-content.ts', 'scanTrackedTexts'),
  }),
];

const safetyBlockRows: readonly GuardRow[] = [
  codeRow({
    id: 'owner-prefix-record',
    guard: guardIds.safetyBlock,
    name: `A launch requires a readable guard store and an ${owner} prefix that matches its record`,
    applies: `${commands.start}, ${commands.reboot}, ${commands.restart}, ${commandLines.workerNew} and ${commandLines.workerResume}`,
    harm: true,
    sites: at('src/commands/launch-checks.ts', 'requireConfirmedPrefix'),
  }),
  codeRow({
    id: 'role-block-render',
    guard: guardIds.safetyBlock,
    name: 'A launch checks edited role blocks for each on H guard and renders intact current blocks for the guard values',
    applies: `${commands.start}, ${commands.reboot}, ${commands.restart}, ${commandLines.workerNew} and ${commandLines.workerResume}`,
    harm: true,
    sites: at('src/commands/launch-checks.ts', 'requireRoleBlocks', 'missingRoleGuard'),
  }),
  codeRow({
    id: 'safety-block-intact',
    guard: guardIds.safetyBlock,
    name: `A start stops when the safety block is edited, missing or malformed, or when its file is a link, so the ${coordinator} never runs without its fixed rules`,
    applies: `${commands.start}, ${commands.restart}, ${commands.reboot}, ${commandLines.workerNew} and doctor`,
    harm: true,
    sites: [
      ...at('src/commands/launch-checks.ts', 'requireSafetyBlock'),
      ...at('src/blocks/status.ts', 'safetyStateOf', 'isSafetyStop'),
      ...at('src/commands/start.ts', 'runStart'),
    ],
  }),
  codeRow({
    id: 'upgrade-block-checks',
    guard: guardIds.safetyBlock,
    name: 'An upgrade refuses an edited or newer safety block, puts an edited setup block back with a backup, and adds a block that was never recorded but never the safety block',
    applies: commands.upgrade,
    harm: true,
    sites: [
      ...at('src/upgrade/plan.ts', 'planBlock', 'refusalOf'),
      ...at('src/commands/upgrade.ts', 'runUpgrade'),
      ...at('src/blocks/status.ts', 'isAddedAsNewBlock'),
    ],
  }),
  codeRow({
    id: 'safety-block-insert',
    guard: guardIds.safetyBlock,
    name: 'The instruction file must be a plain file that does not hold the block yet, so a block is never doubled or broken',
    applies: commands.init,
    harm: false,
    sites: at('src/commands/init.ts', 'blockTexts'),
  }),
];

const secretRows: readonly GuardRow[] = [
  codeRow({
    id: 'token-tracked-text',
    guard: guardIds.secrets,
    name: 'A token in a tracked text stops the command, and the value is never printed',
    applies: `Scan of the ${folder}, ${commands.init}, ${commands.upgrade}, setup text and commits`,
    harm: true,
    sites: [...at('src/commands/root-content.ts', 'scanTrackedTexts'), ...at('src/safety/secrets.ts', 'textHasToken', 'looksLikeToken')],
  }),
  codeRow({
    id: 'token-config-values',
    guard: guardIds.secrets,
    name: 'A config value that looks like a token is refused, so no token enters a tracked config that a push shares',
    applies: `Config load, doctor and ${commands.init}`,
    harm: true,
    sites: at('src/safety/secrets.ts', 'findTokenPaths', 'looksLikeTokenAt'),
  }),
  codeRow({
    id: 'token-keys-hidden',
    guard: guardIds.secrets,
    name: 'An error hides the value of a key that looks like a token, and no value of the environment enters an output',
    applies: 'Every error output',
    harm: true,
    sites: [
      ...at('src/safety/secrets.ts', 'hideTokenKey'),
      ...at('src/core/zod.ts', 'describeIssues', 'joinPath'),
      ...at('src/comms/report-schema.ts', 'parseReport'),
    ],
  }),
  codeRow({
    id: 'credential-strip',
    guard: guardIds.secrets,
    name: 'User info is removed from every URL in an origin record and in git output, so no credential is printed or written to a file',
    applies: 'Every git output and every origin record',
    harm: true,
    sites: [...at('src/core/clone-url.ts', 'withoutSecret', 'classifyOrigin'), ...at('src/core/git.ts', 'withoutUserinfo')],
  }),
  codeRow({
    id: 'printable-output',
    guard: guardIds.secrets,
    name: 'Control and hidden characters in outside text are removed before the program prints it, so the text cannot mislead the terminal',
    applies: 'Every print of outside text',
    harm: true,
    sites: at('src/cli/output.ts', 'printable', 'displayLine', 'visibleText'),
  }),
  textRow({
    id: 'no-secrets-text',
    guard: guardIds.secrets,
    name: 'The safety block says that no key, token or password goes into a config, an assignment or any output',
    applies: 'Safety block',
    harm: true,
    sites: at('src/templates/safety.ts', 'safetyLines'),
  }),
];

const setupTextRows: readonly GuardRow[] = [
  codeRow({
    id: 'setup-accept-at-start',
    guard: guardIds.setupText,
    name: `A start stops while a setup text is not accepted, and a changed setup text asks the ${owner} first`,
    applies: `${commands.start}, ${commands.upgrade} and doctor`,
    harm: true,
    sites: [
      ...at('src/commands/setup-check.ts', 'settleSetup', 'checkRootSetup'),
      ...at('src/core/setup-acceptance.ts', 'acceptanceState', 'askSetupAcceptance'),
      ...at('src/commands/start.ts', 'runStart'),
    ],
  }),
  codeRow({
    id: 'role-text-acceptance',
    guard: guardIds.setupText,
    name: 'A role text is used only when its size and hash equal the accepted entry; else the command stops or the hook gives the refusal text',
    applies: `Launch, reset, ${commandLines.workerNew}, the start of a ${worker} session and the render of the ${coordinator} text`,
    harm: true,
    sites: [
      ...at('src/workers/role-text.ts', 'readRoleText', 'sameAsAccepted', 'requireRoleText'),
      ...at('src/core/setup-acceptance.ts', 'acceptedEntryOf'),
      ...at('src/hooks/hook.ts', 'roleOutcomeOf'),
    ],
  }),
  codeRow({
    id: 'setup-text-content',
    guard: guardIds.setupText,
    name: 'A setup or role text is a plain text file with no link, no control or hidden character and no block mark, and it stays within its size limit; a role text over the limit is refused and never cut',
    applies: `Accept step, ${commands.init}, ${commands.upgrade}, launch and the start of a ${worker} session`,
    harm: true,
    sites: [
      ...at('src/state/setup-text.ts', 'readSetupFile', 'plainSetupText'),
      ...at('src/workers/role-text.ts', 'withinCap', 'composeRoleText', 'roleTextSizeWarning'),
      ...at('src/commands/init-received.ts', 'collectSetup'),
    ],
  }),
  codeRow({
    id: 'worker-refusal-text',
    guard: guardIds.setupText,
    name: `A ${worker} session gets a short refusal text when the hook input or the role text fails, so it does no work without its rules`,
    applies: `Start of a ${worker} session`,
    harm: true,
    sites: at('src/hooks/hook.ts', 'startOfWorker', 'startWithBadInput', 'refusedWith'),
  }),
  codeRow({
    id: 'acceptance-store-place',
    guard: guardIds.setupText,
    name: `The store of setup acceptance sits outside the ${folder}, so no ${worker} can edit the acceptance record`,
    applies: 'Every read and write of an acceptance',
    harm: true,
    sites: at('src/core/setup-acceptance.ts', 'storePathOf'),
  }),
  codeRow({
    id: 'acceptance-path-form',
    guard: guardIds.setupText,
    name: 'An acceptance names only plain relative paths, so a record never names a file outside the setup folder',
    applies: 'Every read and write of an acceptance',
    harm: true,
    sites: at('src/core/setup-acceptance.ts', 'relativePath'),
  }),
  codeRow({
    id: 'init-accepts-own-text-once',
    guard: guardIds.setupText,
    name: `${commands.init} accepts only the two setup files and only the text that it wrote itself, never a later change`,
    applies: commands.init,
    harm: true,
    sites: [...at('src/core/setup-acceptance.ts', 'recordSetupAcceptance'), ...at('src/commands/init.ts', 'ownTextAcceptance')],
  }),
  codeRow({
    id: 'received-setup-acceptance',
    guard: guardIds.setupText,
    name: `The ${owner} accepts each tracked setup file of a received ${folder} in a terminal window; the flag that answers every question never accepts`,
    applies: `${commands.init} of a received folder and ${commands.start}`,
    harm: true,
    sites: [
      ...at('src/commands/init-received.ts', 'decideAcceptance', 'collectSetup'),
      ...at('src/core/setup-acceptance.ts', 'acceptSetup'),
    ],
  }),
  codeRow({
    id: 'setup-set-file-rules',
    guard: guardIds.setupText,
    name: `The files of a setup hold no link, and a received ${folder} must be a work tree with a capped and link-free list of tracked files`,
    applies: 'Hash of the setup files',
    harm: true,
    sites: at('src/commands/setup-check.ts', 'checkSetupSet', 'ownSetOf', 'trackedSetOfRoot'),
  }),
  codeRow({
    id: 'accepted-setup-text-only',
    guard: guardIds.setupText,
    name: `The text of the ${coordinator} holds only setup text that the ${owner} accepted, and an absent or empty setup text gives no block`,
    applies: `${commands.upgrade}, ${commands.init} and every render`,
    harm: true,
    sites: [
      ...at('src/upgrade/render.ts', 'renderCoordinatorText', 'renderSetupText'),
      ...at('src/templates/index.ts', 'setupBlock', 'blockTemplatesFor'),
    ],
  }),
  codeRow({
    id: 'role-delivery-hooks',
    guard: guardIds.setupText,
    name: `The settings of a work copy hold the own hook of each event and are older than the process, so a ${worker} never runs without its role rules`,
    applies: `Launch, reset, ${commandLines.workerNew}, ${commandLines.workerResume}, ${commands.restart} and ${commands.reboot}`,
    harm: true,
    sites: [
      ...at('src/workers/session-checks.ts', 'requireRoleDelivery', 'requireOwnHooks', 'requireSettingsOlderThan'),
      ...at('src/workers/launch.ts', 'launchWorker'),
    ],
  }),
  textRow({
    id: 'worker-refusal-role-text',
    guard: guardIds.setupText,
    name: `The refusal text tells a ${worker} to do no work and tell the ${coordinator} when its role text does not arrive`,
    applies: `Start of a ${worker} session`,
    harm: true,
    sites: at('src/hooks/hook.ts', 'refusedWith'),
  }),
  codeRow({
    id: 'work-rules-block',
    guard: guardIds.setupText,
    name: `The work rules block is rendered only for a ${coordinator}, after the safety block and before the setup block`,
    applies: `${commands.init}, ${commands.upgrade} and ${commands.start}`,
    harm: false,
    sites: at('src/templates/index.ts', 'workRulesFor', 'blockTemplatesFor'),
  }),
];

const spendRows: readonly GuardRow[] = [
  codeRow({
    id: 'stopped-worker-stays',
    guard: guardIds.spend,
    name: `${commands.start} never resumes a ${worker} that has no pane, so a stopped ${worker} does not spend again`,
    applies: commands.start,
    harm: true,
    sites: at('src/workers/recovery.ts', 'recoverWorkers', 'workersWithoutPane', 'noPaneWarning'),
  }),
  codeRow({
    id: 'new-worker-plan',
    guard: guardIds.spend,
    name: `A new ${worker} takes a slug that is not the id of the ${roles.node} or a child, a listed project, no link, and an id, a work copy and a branch that are not taken`,
    applies: commandLines.workerNew,
    harm: true,
    sites: at('src/commands/worker.ts', 'planNew', 'requireFolder'),
  }),
  codeRow({
    id: 'new-worker-keeps-copy',
    guard: guardIds.spend,
    name: `A failed make of a ${worker} keeps the work copy, so no work is lost by an undo`,
    applies: commandLines.workerNew,
    harm: false,
    sites: at('src/commands/worker.ts', 'makeWorker', 'keptCopy'),
  }),
];

const workConductRows: readonly GuardRow[] = [
  codeRow({
    id: 'lessons-file-caps',
    guard: guardIds.workConduct,
    name: 'Doctor fails when the lessons file is a link or holds more entries or more bytes than its limits, so standing instructions do not grow without a bound',
    applies: 'Doctor',
    harm: false,
    sites: at('src/commands/doctor.ts', 'checkLessons', 'lessonEntries'),
  }),
  textRow({
    id: 'profile-strength-text',
    guard: guardIds.workConduct,
    name: `The decision profile says when the ${coordinator} decides from a principle and when it asks the ${owner}, by the strength of the principle`,
    applies: 'Rules of the decision profile',
    harm: false,
    sites: at('src/templates/decision-profile.ts', 'PROFILE_README_LINES', 'PROFILE_INDEX_LINES'),
  }),
  textRow({
    id: 'profile-no-overwrite-text',
    guard: guardIds.workConduct,
    name: 'A decision that contradicts a principle goes to the open questions, and the principle is not overwritten',
    applies: 'Rules of the decision profile',
    harm: false,
    sites: at('src/templates/decision-profile.ts', 'PROFILE_README_LINES'),
  }),
  textRow({
    id: 'profile-conflict-text',
    guard: guardIds.workConduct,
    name: `Two principles that conflict, or an open question, go to the ${owner}`,
    applies: 'Rules of the decision profile',
    harm: false,
    sites: at('src/templates/decision-profile.ts', 'PROFILE_README_LINES'),
  }),
  textRow({
    id: 'roadmap-rules-text',
    guard: guardIds.workConduct,
    name: 'A roadmap has one file for each track, real dates only, exit criteria that a primary source can check, and at most about 150 lines',
    applies: 'Each track',
    harm: false,
    sites: at('src/templates/roadmaps.ts', 'ROADMAPS_README_LINES'),
  }),
];

/** The rows of the core for the scan of the folder, the safety block, secrets, setup and role text, spend and work conduct. */
export const contentGuardRows: readonly GuardRow[] = [
  ...rootScanRows,
  ...safetyBlockRows,
  ...secretRows,
  ...setupTextRows,
  ...spendRows,
  ...workConductRows,
];
