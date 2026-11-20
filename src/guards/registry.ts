import { guardIds, guardKeys, guardKinds, keys, places, roles } from '../names.js';
import type { RecipeEntry } from '../recipes/entry.js';
import { fixedGuard, guardOf, wiredGuard } from './build.js';
import { coreGuardRows } from './core-rows.js';
import type { Guard, GuardDefinition, GuardRow, RowSite } from './types.js';

const { owner, worker } = roles;
const folder = places.folder;

/** The key of a guard in the local config. */
const keyOf = (id: string): string => `${guardKeys.local}.${id}`;

const approvalKey = `${keys.root.approval}.<point>`;
const statuslineKey = `${keys.root.session}.${keys.session.statusline}`;
const contextKeys = [
  `${keys.root.limits}.${keys.limits.contextPreparePct}`,
  `${keys.root.limits}.${keys.limits.contextMaxPct}`,
];
const machineKeys = [
  `${keys.root.limits}.${keys.limits.memoryFreeMinPct}`,
  `${keys.root.limits}.${keys.limits.diskFreeMinGb}`,
  `${keys.root.limits}.${keys.limits.loadMax}`,
];

/** The guards of the core, in the order of the list. A recipe adds its own guards to them. */
const coreGuards: readonly GuardDefinition[] = [
  wiredGuard(
    guardOf(
      guardIds.approvalDelegation,
      'Approval delegation',
      `A step that needs an approval waits for the ${owner}, unless the ${owner} delegated it with an approval record.`,
      [approvalKey],
    ),
  ),
  guardOf(
    guardIds.boardEdits,
    'Board edits',
    'Board data changes only through the commands, in local files that hold no link.',
  ),
  wiredGuard(
    guardOf(
      guardIds.settingsCheck,
      'Claude Code settings check',
      'The settings files that a session reads cannot change its environment, its hooks or its commands.',
      [statuslineKey],
    ),
  ),
  wiredGuard(
    guardOf(
      guardIds.settingsWrite,
      'Claude Code settings write',
      `A write of the hook settings needs the consent of the ${owner}.`,
    ),
  ),
  fixedGuard(
    guardOf(
      guardIds.cloneRules,
      'Clone and project rules',
      'A clone takes a plain URL and goes only into a missing folder of its own project.',
    ),
  ),
  wiredGuard(guardOf(guardIds.contextLimits, 'Context limits', 'A session saves its work before its context is full.', contextKeys)),
  wiredGuard(
    guardOf(
      guardIds.deleteGuard,
      'Delete guard',
      'No commit in the state folder removes a work item or makes the board unreadable.',
    ),
  ),
  guardOf(
    guardIds.dismiss,
    'Dismiss',
    `A dismiss removes the work copy of a ${worker} only when its work is pushed, its copy is clean and its item is closed.`,
  ),
  wiredGuard(
    guardOf(
      guardIds.fileLinkSafety,
      'File and link safety',
      'Reads and writes follow no link, stay in their own folder and keep private files private.',
    ),
  ),
  wiredGuard(
    guardOf(
      guardIds.folderTrust,
      'Folder trust',
      `A ${folder} counts only when the ${places.list} lists it, and a received ${folder} is checked before it is used.`,
    ),
  ),
  wiredGuard(
    guardOf(
      guardIds.gitSafety,
      'Git safety',
      'Git runs in the state folder without its hooks, and a commit takes only the paths that it names.',
    ),
  ),
  fixedGuard(
    guardOf(
      guardIds.hookRuntime,
      'Hook runtime',
      'A hook acts only for a session that it can identify, and the status line stays within its limits.',
      [statuslineKey],
    ),
  ),
  guardOf(
    guardIds.launchCommands,
    'Launch and tmux commands',
    'A session starts with a fixed command line, a clean environment and quoted values.',
  ),
  guardOf(
    guardIds.machineLimits,
    'Machine limits',
    'Sessions warn before they use up memory, disk or processor time, and heavy runs take turns.',
    machineKeys,
  ),
  guardOf(
    guardIds.taskFiles,
    'Task files and messages between sessions',
    `A ${worker} acts only on task files in its own folder, and text from another session carries no authority of the ${owner}.`,
  ),
  guardOf(
    guardIds.sessionChecks,
    'Session and caller checks',
    'A command that only a person may run refuses a session that calls it.',
  ),
  guardOf(
    guardIds.ownerGo,
    `Go of the ${owner}`,
    `A go of the ${owner} comes only from ${owner} input, never from text of a tool, a file or another session.`,
    [`${keys.root.owner}.${keys.owner.prefix}`],
  ),
  guardOf(
    guardIds.paneSafety,
    'Pane and stop safety',
    'Typed lines and stop signals reach only the session that they are meant for, and only when it is safe.',
  ),
  guardOf(
    guardIds.permissionMode,
    'Permission mode',
    'Every session runs in auto permission mode.',
    [`${keys.root.session}.${keys.session.permissionMode}`],
  ),
  guardOf(
    guardIds.proxy,
    'Proxy',
    'A session uses a proxy only when the config names one and the proxy answers.',
    [`${keys.root.session}.${keys.session.proxy}`, `${keys.root.proxies}[].${keys.proxy.onFail}`],
  ),
  wiredGuard(
    guardOf(
      guardIds.resumeRoutines,
      'Resume notes and routines',
      'A resume file and a standing routine stay inside the folders and the commands that they name.',
    ),
  ),
  wiredGuard(
    guardOf(
      guardIds.rootScan,
      'Scan of the folder',
      `The scan of the ${folder} finds ignored and tracked files that could leak data or change the rules.`,
    ),
  ),
  guardOf(
    guardIds.safetyBlock,
    'Safety block',
    'A session starts only when the fixed rules are in place and have not changed.',
  ),
  wiredGuard(
    guardOf(
      guardIds.secrets,
      'Secrets and output text',
      'No token, key or password goes into a file, a report or any other output.',
    ),
  ),
  guardOf(
    guardIds.setupText,
    'Setup and role text',
    `Role text comes only from the program, and setup text is used only after the ${owner} accepted it.`,
  ),
  guardOf(
    guardIds.spend,
    `Spend and new ${worker}s`,
    `A stopped ${worker} stays stopped, and the spend rules limit new ${worker}s.`,
  ),
  guardOf(
    guardIds.workConduct,
    'Work conduct',
    'Sessions follow the rules of conduct for commands, refusals and reports.',
  ),
  wiredGuard(
    guardOf(
      guardIds.installRules,
      'Install rules',
      `A session installs nothing outside its own folder without a go of the ${owner}.`,
    ),
  ),
];

/** Sites of the guard record path, separate from the rows of the registry. */
export const recordPathSites: readonly RowSite[] = [
  { path: 'src/guards/effective.ts', symbol: 'allOn' },
  { path: 'src/guards/effective.ts', symbol: 'guardRulesOf' },
  { path: 'src/core/guard-records.ts', symbol: 'requireGuardChannel' },
  { path: 'src/core/guard-records.ts', symbol: 'guardStorePathOf' },
  { path: 'src/core/private-file.ts', symbol: 'userStatePlaceOf' },
  { path: 'src/core/private-file.ts', symbol: 'absoluteEnv' },
  ...['ownDenyRulesOf', 'missingDenyRules'].map((symbol) => ({ path: 'src/core/claude-settings.ts', symbol })),
  ...['readGuardStore', 'changeGuardStore', 'recordGuards', 'recordPrefix', 'recordExactRoot', 'readGuardState'].map((symbol) => ({ path: 'src/core/guard-records.ts', symbol })),
  ...['checkedTargetCore', 'checkedPidCore', 'openCheckedCore', 'CHECKED_OPEN_FLAGS'].map((symbol) => ({ path: 'src/core/node-deps.ts', symbol })),
  ...['checkedFaultCore', 'accessFaultCore'].map((symbol) => ({ path: 'src/core/access.ts', symbol })),
  { path: 'src/core/file-lock.ts', symbol: 'takeAgeLock' },
  ...['visibleTextCore', 'displayLineCore'].map((symbol) => ({ path: 'src/cli/output.ts', symbol })),
  ...[
    'runGuardSet', 'runGuardConfirm', 'parseGuardSet', 'readGuardConfigText', 'loadGuardConfig',
    'requireCurrentGuardConfig', 'writeGuardLocal', 'guardWriteOutput', 'askGuardOff',
    'readGuardConfigTexts', 'refuseHiddenGuardPrefix',
  ].map((symbol) => ({ path: 'src/commands/guard-set.ts', symbol })),
];

/** The guard ids that older nodes may still hold in a config and that no guard has now. */
export const retiredGuardIds: readonly string[] = [];

/** The rows of the registry for a recipe: the rows of the core, then the rows of the recipe. */
export const guardRowsFor = (recipe: Pick<RecipeEntry, 'guardRows'>): readonly GuardRow[] => [
  ...coreGuardRows,
  ...recipe.guardRows,
];

/**
 * The guards for a recipe: the guards of the core, then the guards of the recipe. Each one has the harm mark, the kinds and the
 * row ids that its rows give, so the list states each fact once. The harm mark comes from the rows that the value changes: a
 * guard with no such row has it, because its harm is not known, but a fixed guard has none, because it is never off. A fixed
 * guard has no key and is never wired.
 */
export const guardsFor = (recipe: Pick<RecipeEntry, 'guards' | 'guardRows'>): readonly Guard[] => {
  const rows = guardRowsFor(recipe);
  return [...coreGuards, ...recipe.guards].map((definition) => {
    const own = rows.filter((row) => row.guard === definition.id);
    const settable = own.filter((row) => !row.alwaysOn);
    return {
      ...definition,
      wired: definition.wired && !definition.fixed,
      harm: !definition.fixed && (settable.length === 0 || settable.some((row) => row.harm)),
      kinds: Object.values(guardKinds).filter((kind) => own.some((row) => row.kind === kind)),
      key: definition.fixed ? null : keyOf(definition.id),
      rows: own.map((row) => row.id),
    };
  });
};
