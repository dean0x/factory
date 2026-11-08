/**
 * Every user-visible name of factory is defined in this file and nowhere else:
 * command words, flag names, config keys, file and folder names, the marker of
 * managed blocks, the ids of JSON output schemas, and the role words of help and
 * template text. Other modules import these constants. A unit test fails when
 * one of these names is a string literal in another file of src/.
 *
 * A change of a config key, of a state key, of a file name or of a folder name
 * needs a migration (src/migrate), so that existing nodes keep working.
 * Text templates use placeholders such as {{worker}}. The placeholders are filled
 * from `templateValues` below.
 */

import { isSlug } from './config/primitives.js';
import { err, ok, type Result } from './core/result.js';

export const program = 'factory';

/** The role words of help and template text. */
export const roles = {
  node: 'node',
  coordinator: 'coordinator',
  manager: 'manager',
  worker: 'worker',
  owner: 'owner',
  recipe: 'recipe',
  variant: 'variant',
} as const;

/**
 * The plain words for the places that the root rule names (design 4.3): the folder of a node, the per-user list
 * of those folders, the marker inside a folder, and a session of the tool.
 */
export const places = {
  folder: `${program} folder`,
  list: `${program} list`,
  marker: `${program} marker`,
  session: `${program} session`,
} as const;

export const commands = {
  init: 'init',
  start: 'start',
  shutdown: 'shutdown',
  restart: 'restart',
  reboot: 'reboot',
  status: 'status',
  dismiss: 'dismiss',
  node: 'node',
  doctor: 'doctor',
  machine: 'machine',
  worker: 'worker',
  self: 'self',
  layout: 'layout',
  upgrade: 'upgrade',
  hook: 'hook',
  state: 'state',
  version: 'version',
  help: 'help',
} as const;

/** The name of a command, as `commands` holds it. */
export type CommandName = (typeof commands)[keyof typeof commands];

/** The topics of `help`. */
export const helpTopics = { words: 'words' } as const;

/**
 * The words that have a plain description in `src/glossary.ts` and in `docs/glossary.md`.
 * A test fails for a term with no entry, and for a term that has another text in the two places.
 */
export const terms = [
  'node',
  'owner',
  'project',
  'layer',
  'worker',
  'coordinator',
  'recipe',
  'setup',
  'request',
  'assignment',
  'session reset',
  'queue',
  'check',
] as const;

/** The layers of a node, from the bottom: the workers, the coordinator, the manager, and the highest layer. */
export const layers = { worker: 0, coordinator: 1, manager: 2, max: 16 } as const;

/** The subcommands of `node`. */
export const nodeCommands = { children: 'children', addChild: 'add-child', removeChild: 'remove-child' } as const;

/** The subcommands of `worker`. */
export const workerCommands = {
  new: 'new',
  list: 'list',
  stop: 'stop',
  resume: 'resume',
  summon: 'summon',
  reset: 'reset',
  watch: 'watch',
} as const;

/** The subcommands of `self`. */
export const selfCommands = { reset: 'reset' } as const;

/** The subcommands of `state`. */
export const stateCommands = { guard: 'guard' } as const;

/** The commands with a subcommand that a remedy line names, without the program name. */
export const commandLines = {
  workerNew: `${commands.worker} ${workerCommands.new}`,
  workerList: `${commands.worker} ${workerCommands.list}`,
  workerStop: `${commands.worker} ${workerCommands.stop}`,
  workerResume: `${commands.worker} ${workerCommands.resume}`,
  workerSummon: `${commands.worker} ${workerCommands.summon}`,
  workerReset: `${commands.worker} ${workerCommands.reset}`,
  workerWatch: `${commands.worker} ${workerCommands.watch}`,
  selfReset: `${commands.self} ${selfCommands.reset}`,
  stateGuard: `${commands.state} ${stateCommands.guard}`,
} as const;

/** What a remedy line names as the command to run again: a command, or a command with its subcommand. */
export type CommandText = CommandName | (typeof commandLines)[keyof typeof commandLines];

export const flags = {
  home: 'home',
  name: 'name',
  ownerName: 'owner-name',
  ownerGithub: 'owner-github',
  project: 'project',
  recipe: 'recipe',
  layer: 'layer',
  approval: 'approval',
  yes: 'yes',
  idle: 'idle',
  for: 'for',
  clear: 'clear',
  compact: 'compact',
  assignment: 'assignment',
  dryRun: 'dry-run',
  overwrite: 'overwrite',
  json: 'json',
  quiet: 'quiet',
  noColor: 'no-color',
  help: 'help',
  version: 'version',
} as const;

export const flagShorts = { help: 'h' } as const;

export const files = {
  config: 'factory.yaml',
  /** The config of one person on one machine: git ignores it, and it has mode 600. */
  localConfig: 'factory.local.yaml',
  claudeMd: 'CLAUDE.md',
  /** The text of the owner for the coordinator. It is in the `setup` folder, so it travels with the config repo. */
  setupCoordinator: 'coordinator.md',
  nodeState: 'node.json',
  worker: 'worker.md',
  /** The record of one worker in the state folder: `workers/<id>/worker.json`. */
  workerRecord: 'worker.json',
  /** The pointer of one worker to its newest session: `workers/<id>/last-session` holds a session id. */
  workerLastSession: 'last-session',
  /** The notes of a worker for its next turn, in its inbox folder: a reset needs them before it clears or compacts the session. */
  resume: 'resume.md',
  /** The assignment of a worker, in its inbox folder: `worker new --assignment FILE` copies the text of FILE to this file. */
  assignment: 'assignment.md',
  /** The pointer of the coordinator to its newest session, in the run-time folder: `state/coordinator-last-session` holds a session id. */
  coordinatorLastSession: 'coordinator-last-session',
  /** The id of this machine, in the run-time folder: made once, and never shared. */
  machineId: 'machine-id',
  /** The mark of the active machine, in the state folder: the state repo tracks it, so it travels with the state. */
  activeMachine: 'active-machine.json',
  board: 'board.json',
  waiting: 'waiting.json',
  decisionLog: 'decision-log.json',
  gitignore: '.gitignore',
  ordersKeep: '.gitkeep',
  profileReadme: 'README-format.md',
  profileIndex: 'index.md',
  profileLog: 'log.md',
  openQuestions: 'open-questions.md',
  roadmapsReadme: 'README.md',
  homeIndex: 'homes.json',
  /** The approval records of the user. The per-user state folder holds the file, beside the factory list. */
  ownerRecords: 'owner-records.json',
  /** The setup acceptances of the user. The per-user state folder holds the file, beside the factory list. */
  setupAcceptances: 'setup-acceptances.json',
} as const;

export const dirs = {
  state: '.factory',
  profile: 'decision-profile',
  principles: 'principles',
  decisions: 'decisions',
  roadmaps: 'roadmaps',
  roles: 'roles',
  orders: 'orders',
  /** The folder of the workers in the state folder: one folder for each worker, named by its id. */
  workers: 'workers',
  /** The folder of the messages for a worker, inside its folder. The session of the worker gets it with `--add-dir`. */
  inbox: 'inbox',
  /** The folder of the resume notes of the coordinator in the state folder: one file for each node, named by the node id. */
  resume: 'resume',
  backups: 'backups',
  runtime: 'state',
  /** The folder of the last-seen files, inside the run-time folder: one file for each session. */
  heartbeat: 'heartbeat',
  locks: 'locks',
  claude: '.claude',
  /** The folder of the coordinator session, below the root. It holds the rendered `CLAUDE.md`, and git ignores it. */
  coordinator: 'coordinator',
  /** The fixed folder of the work copies, below the root. Git ignores it. */
  workCopies: 'work-copies',
  /** The folder of the setup text that a person shares. The root repo tracks it. */
  setup: 'setup',
} as const;

/** The instruction file names of agents that sit directly in a folder, apart from `CLAUDE.md`. */
const agentFiles = { claudeLocal: 'CLAUDE.local.md', agents: 'AGENTS.md', gemini: 'GEMINI.md' } as const;

/**
 * The names that a project path can not take, because the root keeps them for itself (design 4.3): the folders and the
 * config files of the root, and the instruction files that an agent loads. A project path is compared with this list in
 * any letter case.
 */
export const reservedRootNames = [
  dirs.coordinator,
  dirs.workCopies,
  dirs.setup,
  files.config,
  files.localConfig,
  files.claudeMd,
  agentFiles.claudeLocal,
  agentFiles.agents,
  agentFiles.gemini,
] as const;

/** The label of the two marker lines around the part of the root `.gitignore` that the tool writes. */
export const shareListLabel = 'share list';

/** The settings files of Claude Code in a project: `<prefix>*<suffix>` inside the `.claude` folder. */
export const claudeSettings = { prefix: 'settings', suffix: '.json' } as const;

/** The settings file of Claude Code that is not shared: `settings.local.json` in the `.claude` folder of a session folder. */
export const localSettingsFile = `${claudeSettings.prefix}.local${claudeSettings.suffix}`;

/** The `type` of a settings entry that runs a command: a hook handler or the status line. */
export const settingsCommandType = 'command';

/**
 * The keys of a Claude Code settings file that the checks of the root read. The settings page
 * (https://code.claude.com/docs/en/settings) and its reference (https://code.claude.com/docs/en/settings-reference) name
 * `permissions` (with `allow` and `defaultMode`) and `env`. The MCP page (https://code.claude.com/docs/en/mcp) names the
 * two settings that approve the servers of a project: `enableAllProjectMcpServers` (all of them) and
 * `enabledMcpjsonServers` (a list).
 */
export const claudeSettingKeys = {
  permissions: 'permissions',
  allow: 'allow',
  defaultMode: 'defaultMode',
  env: 'env',
  hooks: 'hooks',
  statusLine: 'statusLine',
  approveAllMcp: 'enableAllProjectMcpServers',
  approveMcpList: 'enabledMcpjsonServers',
  /** The setting that tells a session what to do with the input of other sessions: accept it, hold it for approval, or refuse it. */
  crossSessionInbound: 'crossSessionInbound',
} as const;

/** The permission mode that accepts file edits with no prompt. A settings file with it gives a warning, not a stop. */
export const acceptEditsMode = 'acceptEdits';

/** The permission mode that plans first. A session in it holds the input of other sessions for approval. A settings file with it gives a warning. */
export const planMode = 'plan';

/** The values of `crossSessionInbound` that keep the input of other sessions from reaching a session at once. Any other value gives no warning. */
export const crossSessionHeldValues = ['hold', 'refuse'] as const;

export type CrossSessionHeldValue = (typeof crossSessionHeldValues)[number];

/** What a warning about a setting says about the reach of the check: user-level settings and a mode set in a pane stay unseen. */
export const settingsSeenNote = 'This check reads project and local settings only, not user-level settings or a mode set in a pane.';

/** One item of the permission-skip list: a setting at a path with a value, or a text that stands anywhere in the file. */
export type PermissionSkip =
  | {
      readonly kind: 'setting';
      readonly label: string;
      readonly path: readonly string[];
      readonly value: string | boolean;
    }
  | { readonly kind: 'text'; readonly label: string; readonly text: string };

/**
 * The permission-skip list (design 4.4, AC-21): the settings of Claude Code that skip permission prompts. A checked
 * settings file with one of them makes `doctor` fail and `start` exit 4, on every root and also after a setup acceptance.
 * Only a setting that skips permission prompts is on the list: an allow rule is not (D-15 B), and `skipAutoPermissionPrompt`
 * is not, because it hides a notice and skips no prompt.
 *
 * Sources: the permissions page (https://code.claude.com/docs/en/permissions) says that the mode `bypassPermissions` skips
 * the permission prompts and that the flag `--dangerously-skip-permissions` starts it. The settings reference
 * (https://code.claude.com/docs/en/settings-reference) names `permissions.defaultMode` (the default mode) and
 * `skipDangerousModePermissionPrompt` (it skips the dialog before that mode). The setting `dangerouslySkipPermissions` is
 * not in the public settings reference; an earlier check of factory read it, so it stays on the list.
 */
export const permissionSkipList: readonly PermissionSkip[] = [
  {
    kind: 'setting',
    label: 'permissions.defaultMode set to bypassPermissions',
    path: [claudeSettingKeys.permissions, claudeSettingKeys.defaultMode],
    value: 'bypassPermissions',
  },
  { kind: 'text', label: 'the text dangerously-skip-permissions', text: 'dangerously-skip-permissions' },
  {
    kind: 'setting',
    label: 'skipDangerousModePermissionPrompt set to true',
    path: ['skipDangerousModePermissionPrompt'],
    value: true,
  },
  { kind: 'setting', label: 'dangerouslySkipPermissions set to true', path: ['dangerouslySkipPermissions'], value: true },
];

/**
 * The paths of the instruction files of agents, from the folder that holds them (design 4.3, the instruction-file
 * rule). `doctor`, `start` and `init` look for them in the root and in every folder above it.
 *
 * Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the working folder and from every folder above it, and it
 * loads `.claude/CLAUDE.md` and the files in `.claude/rules/` from a project folder (the memory page,
 * https://code.claude.com/docs/en/memory). It reads the settings of a project from `.claude/settings.json` and
 * `.claude/settings.local.json` (the settings page, https://code.claude.com/docs/en/settings). The other names are the
 * files of other common agents, as the design lists them: a person may start another agent in the same folder.
 * A name with a slash is a path below the folder. A name without a slash must be in `reservedRootNames`.
 */
export const instructionFiles = [
  files.claudeMd,
  agentFiles.claudeLocal,
  agentFiles.agents,
  agentFiles.gemini,
  `${dirs.claude}/${files.claudeMd}`,
  `${dirs.claude}/rules`,
  `${dirs.claude}/${claudeSettings.prefix}${claudeSettings.suffix}`,
  `${dirs.claude}/${localSettingsFile}`,
  '.github/copilot-instructions.md',
  '.cursor/rules',
] as const;

export const env = {
  proxyBaseUrl: 'ANTHROPIC_BASE_URL',
  /** The folders where the shell looks for a program. */
  path: 'PATH',
  /** The start of the name of every variable that the program sets for a session. A settings file may not set one. */
  factoryPrefix: 'FACTORY_',
  home: 'FACTORY_HOME',
  session: 'FACTORY_SESSION',
  /** The inbox folder of a worker. Only the launch of a worker sets it. */
  inbox: 'FACTORY_INBOX',
  /** The id of the tmux pane that a process runs in. tmux sets it for each program that it starts in a pane. */
  tmuxPane: 'TMUX_PANE',
  /** The folder of the per-user state. The home index lives below it. */
  stateHome: 'XDG_STATE_HOME',
  userHome: 'HOME',
} as const;

/**
 * The strip of the variables that a Claude Code session sets for its children (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, the
 * session id, the messaging socket and token, and others). A launch removes every variable whose name starts with `prefix`,
 * except the names of `kept`, so the new session does not start as a child of the session that ran `factory`, and a name
 * that a later Claude Code adds does not pass either. Only `CLAUDE_CODE_CHILD_SESSION` is proven to matter: a session that
 * starts with it saves no transcript, so `--resume` fails later (docs/session-stop.md).
 *
 * `kept` holds the settings of the user. Each name is a setting that the user chose, none of them names a session, a parent,
 * a socket, a token, an entry point or a process, and the public environment variable reference of Claude Code
 * (https://code.claude.com/docs/en/env-vars and the pages of the providers) lists each one as a setting:
 * - `CLAUDE_CONFIG_DIR`: the folder of the settings and of the login. Without it the session reads another folder.
 * - `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`: the switches that
 *   choose the service of the session. Without them the session calls another service than the user chose.
 * A user who needs another name adds it here. A name that an app or a parent session sets for the session that it starts
 * (a login token, a socket, an id) stays out.
 *
 * The strip runs in the pane, because a new pane gets its environment from the tmux server and not from the process that
 * runs `factory`. `shell` starts the pane, `scriptName` is the name that the shell shows for the script, and the script is
 * `stripScript` in launch/argv.ts.
 */
export const claudeEnvStrip = {
  prefix: 'CLAUDE',
  kept: [
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
  ],
  shell: '/bin/sh',
  scriptName: 'factory-launch',
} as const;

/**
 * The settings of Claude Code that run a command with no permission prompt: the hooks, the status line and the helpers that
 * give a credential or a header (the settings reference, https://code.claude.com/docs/en/settings-reference). A checked
 * settings file with one of them gives a finding, except for the hook and the status line that the program writes itself.
 */
export const commandSettingKeys = [
  claudeSettingKeys.hooks,
  claudeSettingKeys.statusLine,
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'otelHeadersHelper',
] as const;

/** The command of a hook or of the status line that the program writes: `<program> hook <event>` or `<program> hook statusline`. */
export const ownHookCommand = new RegExp(`^${program} hook [A-Za-z][A-Za-z-]{0,31}$`);

/**
 * The `env` variables of a settings file that set the proxy or the credential of a session. The launch removes the proxy
 * variable and sets it from the config only (design 4.6), so a checked settings file must not set any of these.
 */
export const trafficEnvNames = [
  env.proxyBaseUrl,
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;

/** The most bytes that factory reads from one config, state or index file. A larger file is refused. */
export const maxFileBytes = 1_048_576;

/**
 * The rules for the source file of an assignment (`worker new --assignment`). The file is read only from the factory folder or from the
 * git work tree of the working folder. No path part below that top starts with `dotMark`, except the orders folder below the factory
 * folder (`ordersParts`, shown as `ordersShown`). The local config of the factory folder is never read. The bytes limit is `maxFileBytes`.
 */
export const assignmentSource = {
  dotMark: '.',
  ordersParts: [dirs.state, dirs.orders],
  ordersShown: `${dirs.state}/${dirs.orders}/`,
  maxBytes: maxFileBytes,
} as const;

/**
 * The per-user files (design 4.3): the factory list, the approval records and the setup acceptances. Each one is in the
 * state folder of the user, outside every factory folder. The folder has mode 0700 and a file has mode 0600. A reader
 * refuses a folder or a file that another user owns or that a group or other users can write.
 */
export const privateFile = {
  /** The default place of the state folder, below the user home, when no variable names a state folder. */
  defaultStateHome: ['.local', 'state'],
  folderMode: 0o700,
  fileMode: 0o600,
  /** The permission bits that let a group or another user write. */
  groupOtherWrite: 0o022,
  /** The lock file beside a file: the name of the file and this suffix. */
  lockSuffix: '.lock',
  /** The claim file beside the lock file. Only the process that holds it removes a stale lock. */
  takeoverSuffix: '.takeover',
  /** A writer tries to take the lock this many times, and waits this long between two tries. */
  lockAttempts: 20,
  lockWaitMs: 50,
  /** A lock that is older than this was left by a process that ended. The next writer takes it. */
  lockStaleMs: 5_000,
} as const;

/**
 * The per-user index of node homes (design 4.3): the number of its schema, its keys and its bounds. A command finds a
 * home from a project folder through it.
 */
export const homeIndex = {
  schema: 1,
  keys: { schema: 'schema', homes: 'homes', home: 'home', id: 'id', projects: 'projects', origin: 'origin' },
  /** The origin of a root (design 4.3): the root is the owner's own, or it came from another machine or person. */
  origins: { own: 'own', received: 'received' },
  maxHomes: 200,
  maxProjects: 200,
  maxBytes: maxFileBytes,
} as const;

/**
 * The bounds of the files that a received root tracks. `init` lists at most this many tracked files, and it reads at most
 * this many bytes of one of them. A list over the first bound and a file over the second bound are a stop: the setup
 * acceptance never covers part of a list or part of a file.
 */
export const trackedFiles = { maxCount: 2_000, maxFileBytes } as const;

/** The lowest version of git that factory runs with: the read of the git config of the state folder (`--show-scope`) needs it. */
export const minGitVersion = '2.26';

/** The keys of `board.json` that the reader of item ids uses: the list of items, and the id of one item. */
export const boardKeys = { items: 'items', id: 'id' } as const;

/** The first commit of the root repo, which `init` and `upgrade` make: the branch, the message and the notice of a missing identity. */
export const rootRepo = {
  branch: 'main',
  commitMessage: 'chore: initialize the config repo',
  noIdentity: 'No git identity: the first commit of the config repo was not made. Set user.name and user.email, then commit there.',
} as const;

/**
 * The store of the approval records (design 6): the number of its schema, its keys, the two kinds of record and its
 * bounds. A `delegation` record holds the mode of one approval point. A `scope` record is a record of its own kind with
 * its own key, so it never replaces a delegation record.
 */
export const ownerRecords = {
  schema: 1,
  keys: {
    schema: 'schema',
    records: 'records',
    kind: 'kind',
    node: 'node',
    root: 'root',
    point: 'point',
    mode: 'mode',
    project: 'project',
    version: 'version',
    items: 'items',
    at: 'at',
  },
  kinds: { delegation: 'delegation', scope: 'scope' },
  /** The store holds at most this many records, and a reader refuses a file over this many bytes. */
  maxRecords: 200,
  maxBytes: maxFileBytes,
  /** The most items in one scope record, and the most characters in one item, one project id or one version. */
  maxItems: 100,
  maxTextChars: 200,
} as const;

/**
 * The store of the setup acceptances (design 4.3): the number of its schema, the format version of a manifest, its keys
 * and its bounds. A record holds the manifest of the accepted files and the combined hash. The display bounds are for the
 * accept prompt: a file over `maxDisplayBytes` is never shown in part, and the files past `maxDisplayTotalBytes` in all
 * are not shown either.
 */
export const setupAcceptance = {
  schema: 1,
  formatVersion: 1,
  keys: {
    schema: 'schema',
    acceptances: 'acceptances',
    root: 'root',
    node: 'node',
    file: 'file',
    version: 'version',
    manifest: 'manifest',
    hash: 'hash',
    reason: 'reason',
    at: 'at',
    path: 'path',
    type: 'type',
    size: 'size',
    sha256: 'sha256',
    blob: 'blob',
  },
  fileTypes: ['file', 'link'],
  maxRecords: 200,
  maxBytes: 4 * maxFileBytes,
  /** The most files in one manifest: the most files that a received root can track. */
  maxManifestFiles: trackedFiles.maxCount,
  /**
   * The files of the setup text, as paths below the factory folder. `init` accepts these files alone, and no other file,
   * without an answer of the owner, and only the text that it wrote itself.
   */
  setupTextFiles: [`${dirs.setup}/${files.setupCoordinator}`, `${dirs.setup}/${dirs.roles}/${files.worker}`],
  maxReasonChars: 200,
  maxDisplayBytes: 16_384,
  maxDisplayTotalBytes: 262_144,
} as const;

/**
 * The names that factory gives to the tmux session of a node: two windows, and options that tell
 * a session of this node home from any other tmux session.
 */
export const tmuxNames = {
  windowView: 'view',
  windowWorkers: 'workers',
  /** The session option that holds the node home. */
  optionHome: '@factory_home',
  /** The pane option that holds the node id, on the pane of the coordinator. */
  optionNode: '@node',
  /** The pane option that marks the slot of the view window. */
  optionSlot: '@slot',
  /** The pane option that holds the worker id, on a worker pane. */
  optionWorker: '@worker',
  /**
   * The pane option of the board pane while a worker pane is in the slot: the pane id of that worker pane, a colon and the token
   * of the summon. The option is unset while the board is in the slot.
   */
  optionSummon: '@slot_summon',
  slotBoard: 'board',
} as const;

/**
 * The check that a pane was started for a worker (design 4.11, "The pane of a worker"): a reader cuts the start command of a pane
 * at `maxStartCommandChars` characters and `maxWords` words. A longer text is not the start command of a launch of factory.
 */
export const paneBinding = { maxStartCommandChars: 32_768, maxWords: 1_024 } as const;

/**
 * The summon of a worker pane into the slot of the view window (design 4.11): the default time of the summon, its bounds in
 * minutes, and the count of random bytes of its token.
 */
export const summonLimits = { defaultFor: '15m', minMinutes: 1, maxMinutes: 120, tokenBytes: 16 } as const;

/** The signs that mark the chosen entry of a dialog list in a screen of the agent program. */
const dialogPointers = ['❯', '>'] as const;

/**
 * The typed input of one line into a pane (design 4.12). `lines` are the only lines that a command types. `keys` are the only
 * key names: one clears the input line before the text, one ends the line. A text longer than `maxChars` is refused. The check
 * of the screen reads the bottom `captureLines` lines of a capture. It sees a dialog list when one line starts with a pointer
 * from `pointers`, then digits and a dot, and a second line starts with digits and a dot. Both patterns allow spaces and the
 * box-drawing signs (U+2500 to U+257F) before the first sign, so a dialog inside a side border is seen too.
 */
export const typing = {
  lines: { clear: '/clear', compact: '/compact' },
  keys: { clearLine: 'C-u', enter: 'Enter' },
  maxChars: 300,
  captureLines: 20,
  pointers: dialogPointers,
  optionList: {
    pointerLine: new RegExp(`^[ ─-╿]*(?:${dialogPointers.join('|')}) *[0-9]+\\.`, 'u'),
    numberedLine: /^[ ─-╿]*[0-9]+\./u,
  },
} as const;

/**
 * The permission bits of the local config file (design 4.4). The file has mode 600. A group or other read bit gets
 * fixed with a notice. A group or other write bit, or another owner, stops the command.
 */
export const localFileModes = { private: 0o600, groupOtherRead: 0o044, groupOtherWrite: 0o022 } as const;

/** The keys of the config files: the shared file and the local file. */
export const keys = {
  root: {
    schema: 'schema',
    node: 'node',
    owner: 'owner',
    session: 'session',
    proxies: 'proxies',
    workers: 'workers',
    limits: 'limits',
    approval: 'approval',
    tracker: 'tracker',
    recipe: 'recipe',
    parent: 'parent',
    children: 'children',
    sources: 'sources',
    state: 'state',
  },
  node: { id: 'id', layer: 'layer' },
  owner: { display: 'display', github: 'github', prefix: 'prefix' },
  session: {
    permissionMode: 'permission_mode',
    agent: 'agent',
    effort: 'effort',
    model: 'model',
    proxy: 'proxy',
    statusline: 'statusline',
  },
  state: { remote: 'remote' },
  proxy: { id: 'id', baseUrl: 'base_url', health: 'health', onFail: 'on_fail' },
  worker: { proxy: 'proxy' },
  limits: {
    memoryFreeMinPct: 'memory_free_min_pct',
    diskFreeMinGb: 'disk_free_min_gb',
    loadMax: 'load_max',
    contextPreparePct: 'context_prepare_pct',
    contextMaxPct: 'context_max_pct',
    idleAfter: 'idle_after',
  },
  project: {
    id: 'id',
    url: 'url',
    repo: 'repo',
    path: 'path',
    defaultBranch: 'default_branch',
    variant: 'variant',
    gate: 'gate',
    heavyTest: 'heavy_test',
  },
  gate: { checks: 'checks' },
  tracker: { kind: 'kind', items: 'items', decisions: 'decisions', watchInterval: 'watch_interval' },
  recipe: { id: 'id', variant: 'variant', projects: 'projects' },
  /** A link to another node: the parent or one child. */
  link: { id: 'id', address: 'address' },
} as const;

/** The keys of the state file. */
export const stateKeys = {
  schemaVersion: 'schema_version',
  createdWith: 'created_with',
  blocks: 'blocks',
} as const;

/**
 * The types of the `Notification` event that mean a dialog waits for an answer. The hook records the event for these types and
 * for no other: the type `idle_prompt` says that the session waits for a prompt, which is the state `prompt`.
 */
const notificationTypes = ['permission_prompt', 'elicitation_dialog'] as const;

/**
 * The hook of Claude Code that records the last-seen line of a session (design 4.6): the word after the program name,
 * the fixed list of events and the bounds. The settings of a session folder call `<program> hook <event>` for each event,
 * and `<program> hook statusline` for the status line. Claude Code names the events on its hooks page
 * (https://code.claude.com/docs/en/hooks).
 */
export const hookNames = {
  command: commands.hook,
  /** The word of the status line call. It is also the config key of the command of the owner. */
  statusline: keys.session.statusline,
  events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'Notification', 'PreToolUse'],
  /** The only keys that the hook reads from the input of Claude Code. Every other key of the input is dropped unread. */
  inputKeys: { sessionId: 'session_id', eventName: 'hook_event_name', notificationType: 'notification_type' },
  notificationTypes,
  /** The events whose own group in the settings has a matcher, with that matcher. The `Notification` matcher lists `notificationTypes`, parted by `|`. */
  matchers: { Notification: notificationTypes.join('|') },
  /** The most bytes of hook input that the program reads. A larger input is refused and nothing is written. */
  maxStdinBytes: maxFileBytes,
  /** The hook reads its input for at most this many milliseconds. An input that is not whole by then is an error. */
  stdinTimeoutMs: 2_000,
  /** The status line wrapper waits this many milliseconds for the command of the owner. */
  statuslineTimeoutMs: 2_000,
  /** The program that runs the command of the owner, as `<shell> -c <command>`. */
  shell: '/bin/sh',
  /** The signals that stop the status line wrapper. The wrapper stops the command group of the owner, then exits 0. */
  stopSignals: ['SIGTERM', 'SIGHUP', 'SIGINT'],
  /** The only keys that the status line wrapper reads from the input of Claude Code, besides the session id. Every other key is dropped unread. */
  statuslineKeys: {
    contextWindow: 'context_window',
    usedPercentage: 'used_percentage',
    windowSize: 'context_window_size',
    currentUsage: 'current_usage',
    inputTokens: 'input_tokens',
    cacheCreationTokens: 'cache_creation_input_tokens',
    cacheReadTokens: 'cache_read_input_tokens',
  },
  /** The mark in place of the number in the fallback line, when the input gives no context percent. */
  unknownPercent: '?',
  /**
   * The lock file beside a last-seen line: the session id and `suffix`, in the heartbeat folder. The hook and the status
   * line wrapper hold it while they read, merge and write the line. A writer tries `attempts` times and waits `waitMs`
   * between two tries, so it waits 300 ms at most, then it writes nothing. A lock that is older than `staleMs` was left
   * by a process that ended, and the next writer takes it over.
   */
  heartbeatLock: {
    suffix: '.lock',
    takeoverSuffix: privateFile.takeoverSuffix,
    mode: privateFile.fileMode,
    attempts: 7,
    waitMs: 50,
    staleMs: 2_000,
  },
} as const;

/** One event of the fixed list. */
export type HookEvent = (typeof hookNames.events)[number];

/** What a hook event says about a session: it waits at the prompt, it works, or a dialog in its window waits for an answer. */
export type HookState = 'prompt' | 'busy' | 'waits';

/**
 * What the last hook event says about a session: it waits at the prompt (a session that started, or a turn that ended), it
 * works (a turn that began, a compact that is about to run, or a tool that is about to run), or a dialog waits for an answer (a
 * notice of one of the types of `hookNames.notificationTypes`). Every event has an entry.
 */
export const eventState = {
  SessionStart: 'prompt',
  Stop: 'prompt',
  UserPromptSubmit: 'busy',
  PreCompact: 'busy',
  Notification: 'waits',
  PreToolUse: 'busy',
} as const satisfies Readonly<Record<HookEvent, HookState>>;

/**
 * The ways that the stop code uses to end a session. Each is a way of the table of docs/session-stop.md that has the verdict
 * `safe`. `check-session-stop` and a test read the table, so a change of the table or of these names that makes them differ
 * fails a test.
 */
export const stopWay = { term: 'kill -TERM' } as const;

export type StopWay = (typeof stopWay)[keyof typeof stopWay];

/** The two cases of the table of ways to stop a session: the session waits at the prompt, or it works. */
export type StopCase = 'idle' | 'busy';

/** The case of the table for each state of a session that a last-seen line gives. A session that waits at a dialog is the busy case. */
export const stopCaseOfState = { prompt: 'idle', busy: 'busy', waits: 'busy' } as const satisfies Readonly<Record<HookState, StopCase>>;
/** The safe way for each case. A case with no safe way has null and uses `stopFallback`. */
export const stopWays: Readonly<Record<StopCase, StopWay | null>> = { idle: stopWay.term, busy: stopWay.term };

/** The way for a case that has no safe way: the prompt fallback of the table. */
export const stopFallback: StopWay = stopWay.term;

/** The cases in which `dismiss` ends a session: only a session that waits at its prompt. `shutdown` and `restart` end both cases. */
export const dismissStopCases: readonly StopCase[] = ['idle'];

/**
 * The wait for the end of a process after TERM: the stop checks `attempts` times, and waits `intervalMs` before each check. So
 * the wait is at most `attempts` times `intervalMs`. A session of the program ended 4 to 6 seconds after TERM in every run of
 * docs/session-stop.md. The stop never sends KILL: a process that does not end in the wait is a failure that names the pid.
 */
export const stopPoll = { attempts: 30, intervalMs: 1_000 } as const;

/**
 * The checks of `worker watch`: at most `attempts` checks, each after a wait of `intervalMs`. So a watch lasts at most `attempts` times
 * `intervalMs`, which is 20 minutes. A session that works is stalled when the newer of its event time and its percent time is more than
 * `stalledAfterMs` old. A worker that is new has no last-seen line yet, so a missing line is not a change in the first `lineGraceChecks`
 * checks (the baseline counts as the first). From the check with this index on, or once a valid line was seen, a missing line is a change.
 */
export const watchPoll = { attempts: 40, intervalMs: 30_000, stalledAfterMs: 900_000, lineGraceChecks: 2 } as const;

/**
 * The wait after the pane of a worker starts (design 4.11): the launch checks at most `attempts` times, and waits `intervalMs`
 * before each check. So the wait is at most `attempts` times `intervalMs`. A launch with a session to resume checks the pane and
 * the last-seen line of the worker at each check, and it is confirmed when the pane runs and the line holds the hook event `event`,
 * written after the start, with the session marker of the worker. Any other launch checks the pane once, after one wait.
 */
export const launchConfirm = { attempts: 10, intervalMs: 1_000, event: 'SessionStart' } as const;

/** What a session reset of a worker needs to name for one kind: the flag, the typed line, the events that confirm it, and the verb of the verdict. */
interface ResetKindWords {
  readonly flag: string;
  readonly line: string;
  /** The hook events of which the first one after the typing confirms the reset. */
  readonly events: readonly HookEvent[];
  /** True when the reset starts a new session: the pointer of the worker must name another session than before. */
  readonly newSession: boolean;
  readonly done: string;
}

/**
 * The two kinds of session reset (design 4.12). A clear types `/clear` and is confirmed by the `SessionStart` line of a new
 * session. A compact types `/compact` and is confirmed by a `PreCompact` or a `SessionStart` line of the same session.
 */
export const resetKinds = {
  clear: { flag: flags.clear, line: typing.lines.clear, events: ['SessionStart'], newSession: true, done: 'cleared' },
  compact: { flag: flags.compact, line: typing.lines.compact, events: ['PreCompact', 'SessionStart'], newSession: false, done: 'compacted' },
} as const satisfies Readonly<Record<string, ResetKindWords>>;

/** A kind of session reset: a key of `resetKinds`. */
export type ResetKind = keyof typeof resetKinds;

/**
 * The wait after a reset line was typed into a worker pane: the check runs at most `attempts` times, and waits `intervalMs` before
 * each check. So the wait is at most `attempts` times `intervalMs`. At each check the pane must still run the launch of the worker.
 */
export const resetConfirm = { attempts: 10, intervalMs: 1_000 } as const;

/**
 * The words of the output of `self reset`. The command types `/compact` into the pane of the coordinator itself, and the session runs
 * the line after its current turn, so the output says that the line is queued and never that the compact is done.
 */
export const selfResetWords = { queued: 'QUEUED:', after: 'the compact runs after the current turn' } as const;

/** The name of the file with the resume notes of the coordinator of a node, in the folder `dirs.resume` of the state folder. */
export const coordinatorResumeFile = (nodeId: string): string => `${nodeId}.md`;

/**
 * The start time of the process of a pane. The macOS `ps` has no `etimes`, and tmux has no format for the start time of a pane, so
 * the check asks `ps` for the elapsed time of the pane process. `timeoutMs` bounds the call. `etime` is the one form of the answer
 * that the check accepts: spaces at the ends and one new line at the end, then optional days and a dash (days need hours), optional
 * hours, and minutes and seconds with 2 digits each. The groups are the days, the hours, the minutes and the seconds.
 */
export const paneElapsed = {
  timeoutMs: 5_000,
  etime: /^ *(?:(?:([0-9]{1,5})-)?([0-9]{2}):)?([0-9]{2}):([0-9]{2}) *\n?$/,
} as const;

/** The words of `worker list`: the titles of the columns, the pane column, the state of a worker and the mark of its context. */
export const workerListWords = {
  columns: { id: 'ID', project: 'PROJECT', pane: 'PANE', state: 'STATE', context: 'CONTEXT', mark: 'MARK' },
  /** The pane column for a worker with no pane, and for a worker whose pane has ended. */
  pane: { none: 'none', dead: 'dead' },
  /** The state column: the session waits at the prompt, it works, a dialog waits for an answer, or the last-seen line does not say. */
  states: { prompt: 'at prompt', busy: 'busy', waits: 'waits', unknown: 'unknown' },
  /** The mark of the context column: the percent is at the prepare limit or above, or above the max limit. */
  marks: { prepare: 'PREPARE', max: 'MAX' },
} as const;

/**
 * The words of the output of `worker watch`. The output holds these words and the ids of workers, and no other text of the pane or of
 * a file. `kinds` names what changed for a worker: the pane ended, the pane is gone, the pane is not the launch of the worker any more,
 * the last-seen line is not valid or does not belong to the worker, a dialog waits for an answer, or the session works and was silent
 * too long.
 */
export const watchWords = {
  changed: 'CHANGED:',
  noChange: 'NO CHANGE:',
  noWorker: 'NO WORKER:',
  noPane: 'no worker has a pane to watch',
  kinds: {
    ended: 'pane ended',
    gone: 'pane gone',
    other: 'pane is not its launch',
    lineNotValid: 'line not valid',
    lineNotOwned: 'line not owned',
    waits: workerListWords.states.waits,
    stalled: 'stalled?',
  },
} as const;

/** What changed for a worker: a key of `watchWords.kinds`. */
export type WatchKind = keyof typeof watchWords.kinds;

/**
 * The words of `status`: the titles of the columns, the state of a worker that has no live pane, the work item column for a work item
 * that the board does not give and for a worker with no open work, and the idle column. The other states are `workerListWords.states`.
 */
export const statusWords = {
  columns: { id: 'ID', project: 'PROJECT', state: 'STATE', workItem: 'WORK ITEM', idle: 'IDLE' },
  stopped: 'stopped',
  workItem: { unknown: 'unknown', none: 'none' },
  idle: { yes: 'yes', no: 'no' },
} as const;

/**
 * The rules and the words of `dismiss` (design 4.11). The work of a worker is pushed when, after a fetch of `remote`, the head of its
 * branch is on the branch of the same name of that remote. A line that says that it is not starts with `stuck`. The dry run and the free
 * name at most `maxIgnoredShown` of the ignored files that the removal of a work copy deletes, and a reason names at most `maxFilesNamed` changed
 * files. The table of `--idle` has the columns `columns`.
 */
export const dismissWords = {
  remote: 'origin',
  stuck: 'STUCK:',
  maxIgnoredShown: 20,
  maxFilesNamed: 5,
  columns: { id: 'ID', project: 'PROJECT', state: 'STATE', pushed: 'PUSHED' },
  pushed: { yes: 'yes', no: 'no' },
} as const;

/**
 * How git links a work copy to its clone (the files that `git worktree add` makes). The file `.git` in the work copy has a line that
 * starts with `linkPrefix` and names a folder `<git folder of the clone>/<adminFolder>/<name>`. The file `backPointer` in that folder
 * names the `.git` file of the work copy. Both files are at most `maxBytes` long.
 */
export const workCopyGit = { linkPrefix: 'gitdir:', adminFolder: 'worktrees', backPointer: 'gitdir', maxBytes: 4096 } as const;

/** The session folders that get the hook settings: the folder of the coordinator, and the work copy of a worker. */
export const hookSessions = { coordinator: roles.coordinator, workCopy: 'work-copy' } as const;

/** The kind of a session folder that gets the hook settings. */
export type HookSession = (typeof hookSessions)[keyof typeof hookSessions];

/** The command of a settings entry for an event, for example `factory hook Stop`. */
export const hookCommandOf = (event: string): string => commandText(`${hookNames.command} ${event}`);

/**
 * The line that the status line wrapper prints when the config names no command of the owner, or the command fails:
 * `context N%`. When the input gives no context percent, the number is a mark: `context ?%`.
 */
export const statuslineTextOf = (percent: number | null): string => `context ${percent ?? hookNames.unknownPercent}%`;

const refuseSessionId = (what: string): Result<never, string> => err(`the session name refuses ${what} that is not a slug`);

/**
 * The names of the sessions. The launch gives a name to the agent program with `flag`, so the session has a name in the session
 * list of the program. The coordinator is named with the id of the node. A worker is named with the id of the node, a hyphen and
 * the id of the worker. Each id must be a slug, so a name is one plain word for the flag: no space, no control character and no
 * leading hyphen. A call returns a `Result` and never throws. An error does not repeat the id that it refuses.
 */
export const sessionNames = {
  /** The flag of the agent program that sets the name of a session. */
  flag: '--name',
  coordinator: (node: string): Result<string, string> => (isSlug(node) ? ok(node) : refuseSessionId('a node id')),
  worker: (node: string, worker: string): Result<string, string> => {
    if (!isSlug(node)) return refuseSessionId('a node id');
    if (!isSlug(worker)) return refuseSessionId('a worker id');
    return ok(`${node}-${worker}`);
  },
} as const;

/**
 * The last-seen line (design 4.6): one JSON text for each session, in the heartbeat folder of the run-time folder. It
 * holds the session id, the last hook event with its time, and the context percent with its time. The name of the file
 * is the session id, so the id must match the pattern before it is used in a path.
 */
export const lastSeen = {
  keys: {
    schema: 'schema',
    sessionId: 'session_id',
    event: 'event',
    eventAt: 'event_at',
    contextPct: 'context_pct',
    pctAt: 'pct_at',
    /** The id that the session marker held when the line was made: the id of the node, or the id of a worker. */
    sessionMarker: 'session_marker',
  },
  /** The id of a session: a UUID with lower case letters. */
  sessionIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /** A reader refuses a file of more bytes than this. */
  maxBytes: 4_096,
  /** A reader refuses a worker pointer of more bytes than this. A session id and a new line are 37 bytes. */
  pointerMaxBytes: 64,
  minPercent: 0,
  maxPercent: 100,
} as const;

/**
 * The record of a worker (design 4.6): one JSON text in `workers/<id>/worker.json` of the state folder. It holds what a
 * worker is, and no process id: a process id says nothing about a worker after a restart. The id of the worker names
 * the folder, so the id must be a slug before it is used in a path.
 */
export const workerRecord = {
  keys: {
    schema: 'schema',
    id: 'id',
    project: 'project',
    workCopy: 'work_copy',
    branch: 'branch',
    createdAt: 'created_at',
  },
  /** A reader refuses a file of more bytes than this. */
  maxBytes: 4_096,
  /** A list reads at most this many entries of the workers folder. More is a failure, and the list is not cut short. */
  maxEntries: 256,
  /** The permission bits of a worker folder and of its record. The record is private to the user. */
  folderMode: privateFile.folderMode,
  fileMode: privateFile.fileMode,
} as const;

/**
 * The mark of the active machine (design 4.3): `active-machine.json` in the state folder holds the id of the machine that
 * started the factory last, and the time. The state repo tracks it, so another machine that pulls the state can see it.
 * The id of a machine is a random UUID that `machine-id` in the run-time folder holds. That file is never shared.
 */
export const activeMachine = {
  keys: {
    schema: 'schema',
    machine: 'machine',
    at: 'at',
  },
  /** The id of a machine: a UUID with lower case letters. */
  idPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /** The random bytes of an id. */
  idBytes: 16,
  /** A reader refuses a file of more bytes than this. A UUID and a new line are 37 bytes. */
  idMaxBytes: 64,
  /** A reader refuses a mark of more bytes than this. */
  maxBytes: 1_024,
  /** The permission bits of the id file and of its folder when the call makes them. */
  idFileMode: privateFile.fileMode,
  folderMode: privateFile.folderMode,
  /** The commit message of a write of the mark, and of its removal. */
  commitMessages: { set: 'chore: mark this machine as the active one', clear: 'chore: clear the mark of the active machine' },
} as const;

/**
 * The lock of the state repo: every step that changes the files of the state repo and commits them holds it from the ready check
 * to the commit, so two writers never take each other's change. The lock file is `<name><suffix>` in the locks folder of the state
 * folder. A writer tries `attempts` times and waits `waitMs` between two tries, so it waits 4.75 seconds at most, then it stops with
 * exit 1 and names the lock file. A lock that is older than `staleMs` was left by a process that ended, and the next writer takes it.
 * `staleMs` is larger than the longest locked run: about eight git calls with a limit of 15 seconds each, and a backup.
 */
export const stateLock = {
  name: 'state',
  /** The permission bits of the lock file, and of the locks folder when the call makes it. */
  fileMode: privateFile.fileMode,
  folderMode: privateFile.folderMode,
  lock: {
    suffix: privateFile.lockSuffix,
    takeoverSuffix: privateFile.takeoverSuffix,
    mode: privateFile.fileMode,
    attempts: 20,
    waitMs: 250,
    staleMs: 300_000,
  },
} as const;

/**
 * The exclude file of a project clone (design 4.6): `info/exclude` in the common git folder, which every work copy of the
 * clone shares. It holds one entry that hides the settings file of the work copies from git, so a work copy that has only
 * that file counts as clean. The entry anchors at the top of a work tree.
 */
export const cloneExclude = {
  folder: 'info',
  file: 'exclude',
  entry: `/${dirs.claude}/${localSettingsFile}`,
  /** The permission bits of a new file and of a new folder. An existing file keeps its own bits. */
  fileMode: 0o644,
  folderMode: 0o755,
  /** The call reads at most this many bytes. A larger file is a failure, and nothing is written. */
  maxBytes: 1_048_576,
  /** The lock beside the file: two commands that add an entry at the same time do not lose one write. */
  lock: {
    suffix: privateFile.lockSuffix,
    takeoverSuffix: privateFile.takeoverSuffix,
    mode: privateFile.fileMode,
    attempts: privateFile.lockAttempts,
    waitMs: privateFile.lockWaitMs,
    staleMs: privateFile.lockStaleMs,
  },
} as const;

/** The words that a config value can take. */
export const values = {
  permissionMode: 'auto',
  /** The only agent program that a session starts. */
  agent: 'claude',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  noProxy: 'none',
  onFail: ['stop', 'direct'],
  loadCpuCount: 'cpu_count',
  variants: ['plain'],
  recipes: ['software'],
  /** The mode of an approval point of any recipe. The first one is the default: the point waits for the owner. */
  approvalModes: [roles.owner, 'delegated'],
  trackerLocal: 'local',
  trackerHosted: ['github', 'jira', 'linear'],
  defaultWatchInterval: '5m',
  /** A worker with no activity for this time, and no open work, is idle. */
  defaultIdleAfter: '2h',
} as const;

/** The bounds of a duration setting `<n>m` or `<n>h`: the watch interval of a tracker and the idle limit of a worker. */
export const durationBounds = { minMinutes: 1, maxMinutes: 24 * 60 } as const;

/**
 * The facts of the machine check (design 4.2): the names of the facts, the two systems that it knows, the programs and the
 * system files that give each fact, and the bounds of a call. Any other system gives unknown facts.
 */
export const machineNames = {
  facts: { memory: 'memory', disk: 'disk', load: 'load', cpus: 'cpus' },
  systems: { macos: 'darwin', linux: 'linux' },
  programs: { memoryPressure: 'memory_pressure', sysctl: 'sysctl', df: 'df', nproc: 'nproc' },
  /** The names that `sysctl` reads on macOS: the load averages and the count of processors. */
  sysctlNames: { load: 'vm.loadavg', cpus: 'hw.ncpu' },
  /** The files of the Linux kernel that give the memory and the load. */
  procFiles: { memory: '/proc/meminfo', load: '/proc/loadavg' },
  /** The time limit of each program that the check runs, in milliseconds. A program that takes longer gives an unknown fact. */
  callTimeoutMs: 5_000,
  /** The most bytes of a system file that the check reads. A larger file gives an unknown fact. */
  maxFileBytes: 65_536,
  /** One GB is this many blocks of 1 KiB, as `df -h` counts it. */
  kibPerGb: 1_048_576,
  /** The most processors that the check accepts. A larger count is not a count. */
  maxCpus: 4_096,
} as const;

/** The question of `init` about one approval point: it asks this many times, then it stops with a usage error. */
export const approvalQuestion = { maxAttempts: 3 } as const;

/** The question of `init` about a personal value of a received factory: it asks this many times, then it stops with a usage error. */
export const ownerQuestion = { maxAttempts: 3, maxNameChars: 80 } as const;

/** The scheme of the only address that a node link accepts. */
export const address = { scheme: 'file://' } as const;

/** The ids of the checks that the doctor command runs. */
export const checkIds = {
  config: 'config',
  configVersion: 'config-version',
  localFile: 'local-file',
  state: 'state',
  root: 'root',
  tempFolder: 'temp-folder',
  index: 'index',
  blocks: 'blocks',
  setupText: 'setup-text',
  roles: 'roles',
  tracker: 'tracker',
  children: 'children',
  secrets: 'secrets',
  permissionMode: 'permission-mode',
  /** What the root repo tracks and what git ignores. */
  rootRepo: 'root-repo',
  /** The tracked text files of the root: tokens, `file` URLs and user folder paths. */
  rootFiles: 'root-files',
  /** The folder of each project: it resolves inside the root and not into a folder that the root keeps. */
  projectPaths: 'project-paths',
  /** The mode of each approval point and the active delegations. */
  delegations: 'delegations',
  instructionFiles: 'instruction-files',
  proxyEnv: 'proxy-env',
  proxy: 'proxy',
  tools: 'tools',
  /** The version of the agent program: the messages between sessions need 2.1.224 or newer. */
  agentVersion: 'agent-version',
  stateRepo: 'state-repo',
  /** The delete guard of the state repo: a warning when it is off, with the remedy. */
  stateGuard: 'state-guard',
  projects: 'projects',
  projectUrls: 'project-urls',
} as const;

export const blockNames = {
  coordinator: 'coordinator',
  manager: 'manager',
  safety: 'safety',
  worker: 'worker',
  /** The text of `setup/coordinator.md`, in the coordinator `CLAUDE.md`. */
  setup: 'setup',
  /** The text of `setup/roles/worker.md`, in the worker file. */
  setupWorker: 'setup-worker',
} as const;

/** The blocks whose text a person writes in the setup folder. A missing one is added by `upgrade`. */
export const setupBlockNames: readonly string[] = [blockNames.setup, blockNames.setupWorker];

/** The setup file that the text of a setup block comes from, written from the node home. */
export const setupFileOf = (block: string): string =>
  block === blockNames.setupWorker
    ? `${dirs.setup}/${dirs.roles}/${files.worker}`
    : `${dirs.setup}/${files.setupCoordinator}`;

/** The most bytes of a setup text that `init` and `upgrade` render into a session instruction file. A larger file is refused. */
export const maxSetupTextBytes = 65_536;

/**
 * The names of a FAC-M1 node (schema 1) that schema 2 does not use. Only the migrations from schema 1 read them.
 */
export const schema1 = {
  keys: { role: 'role', lanes: 'lanes', projects: 'projects' },
  protocolFile: 'protocol.md',
  briefsDir: 'briefs',
  protocolBlock: 'protocol',
  /** The sha256, as hex, of `roadmaps/README.md` as `init` of version 0.1.0 wrote it. */
  roadmapsReadmeSha256: '2f9168abccda69f6ed71c8c1339ee899ad39e20c606838c750bae4d5346fad2c',
} as const;

/**
 * The names of a FAC-M2 config that the current layout does not use. Only the refusal of that layout reads them: a
 * `factory.yaml` with one of them was made before the split into a shared file and a local file.
 */
export const schema2 = { workersKey: 'cells', approvalKey: 'land' } as const;

/** Markers of managed blocks: `<!-- factory:begin <name> v<n> sha256=<hex> -->` and `<!-- factory:end <name> -->`. */
export const marker = { prefix: `${program}:`, begin: 'begin', end: 'end', hash: 'sha256' } as const;

/** The ids of the JSON documents that commands print. */
export const schemaIds = {
  init: `${program}.init/v1`,
  start: `${program}.start/v1`,
  shutdown: `${program}.shutdown/v1`,
  restart: `${program}.restart/v1`,
  reboot: `${program}.reboot/v1`,
  status: `${program}.status/v1`,
  dismiss: `${program}.dismiss/v1`,
  nodeChildren: `${program}.node-children/v1`,
  words: `${program}.words/v1`,
  doctor: `${program}.doctor/v1`,
  machine: `${program}.machine/v1`,
  workerNew: `${program}.worker-new/v1`,
  workerList: `${program}.worker-list/v1`,
  workerStop: `${program}.worker-stop/v1`,
  workerResume: `${program}.worker-resume/v1`,
  workerSummon: `${program}.worker-summon/v1`,
  workerReset: `${program}.worker-reset/v1`,
  workerWatch: `${program}.worker-watch/v1`,
  selfReset: `${program}.self-reset/v1`,
  layout: `${program}.layout/v1`,
  upgrade: `${program}.upgrade/v1`,
  hook: `${program}.hook/v1`,
  stateGuard: `${program}.state-guard/v1`,
  version: `${program}.version/v1`,
  error: `${program}.error/v1`,
  lastSeen: `${program}.last-seen/v1`,
  workerRecord: `${program}.worker/v1`,
  activeMachine: `${program}.active-machine/v1`,
} as const;

/** Placeholders of the prefix that marks input with the authority of the owner. */
export const prefixPlaceholders = { owner: '{owner}', node: '{node}', date: '{date}' } as const;

export const defaultOwnerPrefix =
  `[From ${prefixPlaceholders.owner}, typed by ${prefixPlaceholders.node} ` +
  `at the ${roles.owner}'s explicit instruction, ${prefixPlaceholders.date}]`;

export const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** The text of a flag as a person types it. */
export const flagText = (name: string): string => `--${name}`;

/** A command as a person types it, for example `factory upgrade`. */
export const commandText = (command: string): string => `${program} ${command}`;

/**
 * The delete guard of the state repo: a hook that git runs before a commit. `init` and `upgrade` write it from the text below into a
 * folder of the git folder of the state repo (never the folder `hooks`), and set the key `core.hooksPath` to that folder. The git
 * folder is not part of the tracked files, so the repo never holds the hook. The folder holds the hook file and nothing else.
 */
export const stateGuard = {
  folder: 'factory-guard',
  hookFile: 'pre-commit',
  hookMode: 0o755,
  folderMode: 0o755,
  hooksPathKey: 'core.hooksPath',
  /** The most entries that an install removes from the guard folder; a folder with more is left alone. */
  maxEntries: 64,
  /** The most older commits of board.json that the guard reads back to find the last board that can be read. */
  historyBound: 100,
  /** The word between the folder name and the pid in the name of the copy that an install keeps of an old guard folder. */
  copyWord: '.old-',
  interpreter: '#!/bin/sh',
  comment: `# Written by ${program} from the text of the package. Git does not track this file. Run "${commandText(commands.upgrade)}" to write it again.`,
  /** The remedy of every case of an off guard. */
  remedy: `Run "${commandText(commands.upgrade)}".`,
} as const;

/** A subcommand of `worker` as a person types it, for example `factory worker watch`. */
const workerCommandText =(subcommand: string): string => commandText(`${commands.worker} ${subcommand}`);

/** The command that replaces or adds one managed block, for example `factory upgrade --overwrite coordinator`. */
export const overwriteCommand = (block: string): string =>
  `${commandText(commands.upgrade)} ${flagText(flags.overwrite)} ${block}`;

/** The path of a key inside the config, for example `limits.disk_free_min_gb`. */
const keyPath = (...parts: readonly string[]): string => parts.join('.');

/** The config key that names the status line command of the owner: `session.statusline`. */
export const statuslineKeyPath = keyPath(keys.root.session, keys.session.statusline);

/** A path inside the state folder, written from the node home. */
const inState = (...parts: readonly string[]): string => [dirs.state, ...parts].join('/');

/** The paths in the texts, written from the factory folder. */
const pathValues: Readonly<Record<string, string>> = {
  configFile: files.config,
  localConfigFile: files.localConfig,
  stateDir: dirs.state,
  nodeFile: inState(files.nodeState),
  workerFile: inState(dirs.roles, files.worker),
  boardFile: inState(files.board),
  waitingFile: inState(files.waiting),
  decisionLogFile: inState(files.decisionLog),
  profileDir: `${inState(dirs.profile)}/`,
  roadmapsDir: `${inState(dirs.roadmaps)}/`,
  ordersDir: `${inState(dirs.orders)}/`,
  workersDir: `${inState(dirs.workers)}/`,
  resumeDir: `${inState(dirs.resume)}/`,
};

/** The values for the placeholders of the templates, for example {{worker}} and {{Worker}}. */
export const templateValues: Readonly<Record<string, string>> = {
  program,
  node: roles.node,
  coordinator: roles.coordinator,
  manager: roles.manager,
  worker: roles.worker,
  owner: roles.owner,
  recipe: roles.recipe,
  variant: roles.variant,
  childrenKey: keys.root.children,
  ...pathValues,
  profileIndex: files.profileIndex,
  profileReadme: files.profileReadme,
  profileLog: files.profileLog,
  openQuestions: files.openQuestions,
  principlesDir: dirs.principles,
  decisionsDir: dirs.decisions,
  ownerPrefixKey: keyPath(keys.root.owner, keys.owner.prefix),
  diskLimitKey: keyPath(keys.root.limits, keys.limits.diskFreeMinGb),
  preparePctKey: keyPath(keys.root.limits, keys.limits.contextPreparePct),
  maxPctKey: keyPath(keys.root.limits, keys.limits.contextMaxPct),
  heavyTestKey: keys.project.heavyTest,
  inboxEnv: env.inbox,
  resumeFile: files.resume,
  workerNewCommand: `${workerCommandText(workerCommands.new)} <id> ${flagText(flags.project)} P ${flagText(flags.assignment)} FILE`,
  workerWatchCommand: workerCommandText(workerCommands.watch),
  workerResetCommand: workerCommandText(workerCommands.reset),
  selfResetCommand: commandText(`${commands.self} ${selfCommands.reset}`),
  clearFlag: flagText(flags.clear),
  compactFlag: flagText(flags.compact),
  variantKey: keyPath(keys.root.recipe, keys.recipe.variant),
  onFailDirect: `${keys.proxy.onFail}: ${values.onFail[1]}`,
  proxyEnv: env.proxyBaseUrl,
};

/**
 * The values for the texts in the coordinator `CLAUDE.md`: the role block, the safety block and the setup block. The
 * coordinator session runs in the coordinator folder, which is one level below the factory folder, so each path is
 * written from that folder: `../factory.yaml`, `../factory.local.yaml` and `../.factory/...`. The texts in the state
 * folder keep the values of `templateValues`.
 */
export const coordinatorTemplateValues: Readonly<Record<string, string>> = {
  ...templateValues,
  ...Object.fromEntries(Object.entries(pathValues).map(([name, path]) => [name, `../${path}`])),
};
