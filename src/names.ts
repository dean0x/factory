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
  report: 'report',
  dismiss: 'dismiss',
  node: 'node',
  doctor: 'doctor',
  machine: 'machine',
  worker: 'worker',
  item: 'item',
  track: 'track',
  request: 'request',
  decide: 'decide',
  queue: 'queue',
  lock: 'lock',
  pr: 'pr',
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
  'track',
  'stage',
] as const;

/** The layers of a node, from the bottom: the workers, the coordinator, the manager, and the highest layer. */
export const layers = { worker: 0, coordinator: 1, manager: 2, max: 16 } as const;

/** The subcommands of `node`. */
export const nodeCommands = {
  children: 'children',
  addChild: 'add-child',
  removeChild: 'remove-child',
  send: 'send',
  tree: 'tree',
} as const;

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

/**
 * The subcommands of `item`. `record` runs the record check of the recipe and records its result, and `unassign` takes the worker
 * off an item.
 */
export const itemCommands = {
  add: 'add',
  update: 'update',
  move: 'move',
  close: 'close',
  list: 'list',
  record: 'record',
  unassign: 'unassign',
} as const;

/** The subcommands of `track`. The command has no remove subcommand. */
export const trackCommands = { add: 'add', list: 'list' } as const;

/**
 * The subcommands of `request`. `log` records a decision that no request asked for. The command has no subcommand that changes the
 * options of a request that is open.
 */
export const requestCommands = { add: 'add', list: 'list', close: 'close', log: 'log' } as const;

/** The subcommands of `queue`. */
export const queueCommands = { set: 'set', show: 'show' } as const;

/** The subcommands of `lock`. */
export const lockCommands = { run: 'run' } as const;

/** The subcommands of `self`. */
export const selfCommands = { reset: 'reset' } as const;

/** The subcommands of `state`. */
export const stateCommands = { guard: 'guard' } as const;

/** The commands with a subcommand that a remedy line names, without the program name. */
export const commandLines = {
  nodeSend: `${commands.node} ${nodeCommands.send}`,
  workerNew: `${commands.worker} ${workerCommands.new}`,
  workerList: `${commands.worker} ${workerCommands.list}`,
  workerStop: `${commands.worker} ${workerCommands.stop}`,
  workerResume: `${commands.worker} ${workerCommands.resume}`,
  workerSummon: `${commands.worker} ${workerCommands.summon}`,
  workerReset: `${commands.worker} ${workerCommands.reset}`,
  workerWatch: `${commands.worker} ${workerCommands.watch}`,
  itemAdd: `${commands.item} ${itemCommands.add}`,
  itemUpdate: `${commands.item} ${itemCommands.update}`,
  itemMove: `${commands.item} ${itemCommands.move}`,
  itemClose: `${commands.item} ${itemCommands.close}`,
  itemList: `${commands.item} ${itemCommands.list}`,
  itemRecord: `${commands.item} ${itemCommands.record}`,
  itemUnassign: `${commands.item} ${itemCommands.unassign}`,
  trackAdd: `${commands.track} ${trackCommands.add}`,
  trackList: `${commands.track} ${trackCommands.list}`,
  requestAdd: `${commands.request} ${requestCommands.add}`,
  requestList: `${commands.request} ${requestCommands.list}`,
  requestClose: `${commands.request} ${requestCommands.close}`,
  requestLog: `${commands.request} ${requestCommands.log}`,
  queueSet: `${commands.queue} ${queueCommands.set}`,
  queueShow: `${commands.queue} ${queueCommands.show}`,
  lockRun: `${commands.lock} ${lockCommands.run}`,
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
  closed: 'closed',
  for: 'for',
  clear: 'clear',
  compact: 'compact',
  assignment: 'assignment',
  ready: 'ready',
  since: 'since',
  madeBy: 'made-by',
  decision: 'decision',
  ref: 'ref',
  relayed: 'relayed',
  file: 'file',
  field: 'field',
  title: 'title',
  text: 'text',
  track: 'track',
  state: 'state',
  stage: 'stage',
  all: 'all',
  follow: 'follow',
  roadmap: 'roadmap',
  question: 'question',
  option: 'option',
  recommend: 'recommend',
  item: 'item',
  note: 'note',
  position: 'position',
  priority: 'priority',
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
  /** The lessons of the coordinator, in the state folder: the state repo tracks the file, and only the coordinator writes it. */
  lessons: 'lessons.md',
  /** The pointer of the coordinator to its newest session, in the run-time folder: `state/coordinator-last-session` holds a session id. */
  coordinatorLastSession: 'coordinator-last-session',
  /** The run marker of `worker watch`, in the run-time folder: it holds the token of the newest watch run of the node. */
  watchRun: 'worker-watch-run',
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
  /** The owner decisions of the user: one record for each decision that the owner answered. It has its own lock and its own bounds. */
  ownerDecisions: 'owner-decisions.json',
  /** The setup acceptances of the user. The per-user state folder holds the file, beside the factory list. */
  setupAcceptances: 'setup-acceptances.json',
  /** The lock of the heavy runs of the user (`lock run`). The per-user state folder holds the file. */
  heavyLock: 'heavy-test.lock',
  /** The mark of a heavy run that goes first (`lock run --priority`), beside the lock. The per-user state folder holds the file. */
  heavyPriority: 'heavy-test.priority',
  /** The report of this node, in the event file folder: the file that a parent node reads. */
  report: 'report.json',
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
  /** The folder of the review results in the state folder, one place for the whole node. Git ignores it, and `start` makes it private. */
  reviews: 'reviews',
  /** The event file folder in the state folder: it holds the report of this node for the parent node. Git ignores it. */
  outbox: 'outbox',
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
  /** The setting that turns off every hook of a session, so that the role text never reaches it. */
  disableAllHooks: 'disableAllHooks',
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
 * The permission-skip list (design 4.4): the settings of Claude Code that skip permission prompts. A checked
 * settings file with one of them makes `doctor` fail and `start` exit 4, on every root and also after a setup acceptance.
 * Only a setting that skips permission prompts is on the list: an allow rule is not, because it gives a warning only, and
 * `skipAutoPermissionPrompt` is not, because it hides a notice and skips no prompt.
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
  /** The variable that Claude Code sets for each process that it starts. A non-empty value means that a Claude Code session runs this process. */
  claudeCode: 'CLAUDECODE',
  /** The inbox folder of a worker. Only the launch of a worker sets it. */
  inbox: 'FACTORY_INBOX',
  /** The id of the tmux pane that a process runs in. tmux sets it for each program that it starts in a pane. */
  tmuxPane: 'TMUX_PANE',
  /** The folder of the per-user state. The home index lives below it. */
  stateHome: 'XDG_STATE_HOME',
  userHome: 'HOME',
  /** The token of the heavy lock. `lock run` sets it for its child only. A run whose value equals the lock file runs inside that lock. */
  heavyLockToken: 'FACTORY_HEAVY_LOCK_TOKEN',
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

/**
 * The `env` variables of a settings file that set the state folder or the home folder of the user. The hook of a worker finds
 * the factory list in the state folder of the user, so a work copy must not set either of these: the hook would not find the
 * worker, and the worker would get no role text.
 */
export const stateEnvNames = [env.stateHome, env.userHome] as const;

/** The most bytes that factory reads from one config, state or index file. A larger file is refused. */
export const maxFileBytes = 1_048_576;

/** The share of `maxFileBytes`, in percent, at which `doctor` warns about the board, the waiting file or the decision log. */
export const boardWarnPercent = 80;

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

/**
 * The keys of `board.json`. The top keys are the queue (its key comes from the recipe), the list of items and the list of
 * tracks. `defaultQueue` is the key of the queue when the recipe gives none. The other keys belong to an item (`id`, `title`,
 * `status`, `track`, `stage`) or to a track (`id`, `name`, `roadmap`). `mergedPrHead` is the head sha that the record check of the
 * recipe gave when `item record` recorded the item, and `unassignedFrom` is the list of the workers that `item unassign` took off
 * the item. Both are reserved field names, so no owner field can take their place.
 */
export const boardKeys = {
  items: 'items',
  id: 'id',
  title: 'title',
  status: 'status',
  tracks: 'tracks',
  track: 'track',
  stage: 'stage',
  name: 'name',
  roadmap: 'roadmap',
  text: 'text',
  docs: 'docs',
  note: 'note',
  defaultQueue: 'queue',
  mergedPrHead: 'merged_pr_head',
  unassignedFrom: 'unassigned_from',
} as const;

/** The keys of the waiting file: the top keys, and the id of a waiting item. */
export const waitingKeys = { intro: 'intro', groups: 'groups', items: 'items', id: 'id' } as const;

/**
 * The keys of the decision log: the list of rows, and the keys of a row. The `item` text of a row starts with the id of a decision.
 * A row that a close of a request writes holds `item`, `decision` and `date`, and `decider` when the coordinator or a delegate made
 * the decision. It never holds `by`, so it is never an owner answer. A row that `decide` writes holds `by` too, and `request`, the
 * canonical text that the hash of the owner record covers. A row is a display copy: only the owner record proves an answer.
 */
export const decisionLogKeys = {
  rows: 'rows',
  item: 'item',
  decision: 'decision',
  date: 'date',
  by: 'by',
  request: 'request',
  /** Who decided a request that `request close --made-by` closed: a value of `requestDeciders`. Never the owner, never `by`. */
  decider: 'decider',
  /**
   * The mark of a row that `request close --relayed` writes: the coordinator passed on an answer of the owner. The value is
   * `relayedMarker`. A row with this key holds no `by` key, so it is never an owner answer.
   */
  relayed: 'relayed',
} as const;

/** The fixed value of the `relayed` key of a row of the decision log. Only the owner record proves an answer of the owner. */
export const relayedMarker = 'owner answer, relayed by the coordinator, no owner proof';

/**
 * The deciders of a request that is not an approval point and that the owner did not answer: the coordinator itself, or a delegate,
 * for example another session that decides for the owner with no owner authority. The owner answers with `decide`, so `owner` is
 * not a value. A row with a decider is a display copy: it is never an owner answer.
 */
export const requestDeciders = { coordinator: roles.coordinator, delegate: 'delegate' } as const;

/**
 * The forms of the ids. An item id is `B-` and a number. A waiting item and a decision have an id of `D-` and a number. A row of the
 * decision log names its decision at the start of its `item` text: the id, then the end of the text or a character that cannot
 * continue the id. The numbers have at most 9 digits. `canonicalRequest` is the form that a request must have to be answered:
 * the number has no leading zero, so one decision has one id.
 */
export const boardIds = {
  item: /^B-[0-9]{1,9}$/,
  request: /^D-[0-9]{1,9}$/,
  canonicalRequest: /^D-[1-9][0-9]{0,8}$/,
  requestAtStart: /^D-[0-9]{1,9}(?![0-9A-Za-z_-])/,
} as const;

/**
 * The limits of a track. An id starts with a lowercase letter and holds lowercase letters, digits and hyphens, up to `maxIdChars`.
 * A name is one line of at most `maxNameChars` characters. A factory has at most `maxTracks` tracks.
 */
export const trackLimits = { idPattern: /^[a-z][a-z0-9-]*$/, maxIdChars: 32, maxNameChars: 60, maxTracks: 30 } as const;

/**
 * The most track lines that `item list` prints. The output holds at most 20 lines (`MAX_OUTPUT_LINES` in
 * `test/helpers/short-output.ts`). Of them, one is the summary line, one is the heading line of the table (`tableLines` in
 * `src/cli/output.ts`) and one is the more-tracks line. 20 - 3 is 17. The list of the items of one track, the list of the requests
 * and the queue hold at most this many rows, by the same count.
 */
export const maxTrackLines = 17;

/**
 * The wait of the follow loop of `item list --follow` between two ticks, in milliseconds (the poll rule of Gate 1). The bound: at each
 * tick the loop checks its reader and reads the status of the board file once, and it reads the text of the file only after a change
 * of the time or the size of the file. So the loop makes at most one status read and one text read in each 2 seconds. The loop has no
 * time limit, as a view must run until its terminal goes. It ends on a signal (SIGHUP or SIGTERM), on a failed write, when its parent
 * process changes, and when stdout is not a terminal.
 */
export const followPollMs = 2_000;

/**
 * The words and the limits of the output of `item` and `track`. A text from the board file is cut to the width of its cell
 * (`maxCellChars`) before it goes into a table. A field is given as `NAME` and `fieldSeparator` and the value.
 */
export const itemWords = {
  item: 'item',
  items: 'items',
  track: 'track',
  tracks: 'tracks',
  columns: { id: 'ID', stage: 'STAGE', status: 'STATUS', title: 'TITLE' },
  trackColumns: { track: 'TRACK', items: 'ITEMS', stages: 'STAGES' },
  trackListColumns: { id: 'ID', name: 'NAME', roadmap: 'ROADMAP' },
  /** What a table shows for the items on no listed track, for an item with no stage, and for an empty part. */
  noTrack: '(no track)',
  noStage: 'no stage',
  empty: '-',
  roadmapYes: 'yes',
  roadmapNo: 'no',
  fieldSeparator: '=',
  maxCellChars: 60,
  maxFieldChars: 30,
  maxStatusChars: 20,
} as const;

/**
 * The words of the output of `request`. A request is a decision item that waits for the owner. An option is given as its key,
 * `optionSeparator` and its text. A request that a person closes with no answer gets a row in the decision log with the text
 * `closedDecision`, so its number is never given again.
 */
export const requestWords = {
  request: commands.request,
  requests: `${commands.request}s`,
  columns: { id: 'ID', title: 'TITLE', options: 'OPTIONS' },
  optionSeparator: '=',
  optionKeySeparator: ',',
  closedDecision: 'closed with no answer',
  maxCellChars: 60,
  maxOptionsChars: 30,
} as const;

/**
 * The words of `decide`. `read` is the word of a subcommand that this version does not have: the contract operation `decision read`
 * waits for FAC-M11, so `decide read` is a usage error.
 */
export const decideWords = { read: 'read' } as const;

/** The words of the output of `queue`. The columns of the owner fields of a row come between the items and the note. */
export const queueWords = {
  queue: commands.queue,
  row: 'row',
  rows: 'rows',
  columns: { position: 'NO', name: 'NAME', items: 'ITEMS', note: 'NOTE' },
  itemSeparator: ' ',
  maxCellChars: 60,
} as const;

/**
 * The most characters of one line of text output. The first line of the output of a job command holds at most 120
 * characters (`MAX_FIRST_LINE_CHARS` in `test/helpers/short-output.ts`). `displayLine` in `src/cli/output.ts` cuts to it.
 */
export const maxDisplayWidth = 120;

/** The most characters of typed text that a message repeats: a field name, a stage or a key. A longer text is cut. */
export const maxEchoChars = 40;

/** The highest number of an id of the form `B-n` or `D-n`: the forms in `boardIds` take at most 9 digits. */
export const maxBoardNumber = 999_999_999;

/**
 * The keys of a decision for the owner in the waiting file, and of one of its options. A decision holds an id (`waitingKeys.id`),
 * a title, a question and a list of options. An option holds a key that the owner types, a text, and a mark for the option that the
 * asker recommends.
 */
export const decisionKeys = { title: 'title', question: 'question', options: 'options' } as const;
export const optionKeys = { key: 'key', text: 'text', rec: 'rec' } as const;

/**
 * The limits of the text of a board write. A title, a text, a question and the text of an option are one line each, with at most
 * this many characters. A decision has at most `maxOptions` options. The note of an owner answer is one line of at most
 * `maxNoteChars` characters. A link from an item to a file is a relative path of at most `maxDocPathChars` characters.
 */
export const boardTextLimits = {
  maxTitleChars: 100,
  maxTextChars: 500,
  maxQuestionChars: 500,
  maxOptionChars: 200,
  maxNoteChars: 500,
  maxOptions: 9,
  maxDocPathChars: 200,
} as const;

/**
 * The limits of the queue. A row of the queue holds at most `maxRowItems` item ids, and the queue holds at most `maxRows` rows. A
 * write that would pass a limit is a usage error. A board that a person edited by hand and that passes a limit still reads.
 */
export const queueLimits = { maxRows: 30, maxRowItems: 30, positionPattern: /^[1-9][0-9]{0,2}$/ } as const;

/**
 * The stop of a board write with a hosted tracker kind. The provider holds the truth of a hosted board, and the local board is a
 * cache of it, so a write goes to the provider first. This version has no provider, so the write stops before the lock, with one line.
 */
export const hostedBoardLine = (kind: string): string =>
  `The ${kind} board is not in this version. Hosted boards come in FAC-M3 (provider plugin).`;

/**
 * The names that an owner field can not take: the keys that an item, a queue row, a track or a decision record already
 * holds, and the track and stage keys. A field never replaces a key that the core owns, and never replaces a key that is
 * part of the proof of a decision.
 */
export const reservedFieldNames: readonly string[] = [
  boardKeys.id,
  'title',
  'text',
  'status',
  'issues',
  'docs',
  'result',
  'by',
  'who',
  'decided_by',
  'answer',
  boardKeys.name,
  boardKeys.note,
  boardKeys.items,
  boardKeys.tracks,
  boardKeys.track,
  boardKeys.stage,
  boardKeys.mergedPrHead,
  boardKeys.unassignedFrom,
];

/** The most workers that the list of former workers of one item (`boardKeys.unassignedFrom`) holds. */
export const markLimits = { maxFormerWorkers: 30 } as const;

/**
 * The refusal of a change of the worker field of an item that already names a worker: the message names the item, and the remedy
 * names the one command that takes a worker off an item.
 */
export const workerFieldGuard = {
  message: (id: string): string => `the worker field of ${id} holds a worker`,
  remedy: (id: string): string => `Run "${commandText(commandLines.itemUnassign)} ${id}" first.`,
} as const;

/** The time limit of one run of `gh`, in milliseconds. */
export const ghTimeoutMs = 10_000;

/**
 * The limits of the `board` block of `factory.yaml`. A name, a state and a value is a token: 1 to `maxTokenChars` letters, digits,
 * dots, underscores or hyphens, and the first character is a letter or a digit. The cap is the length of the longest worker id (a
 * slug of at most 40 characters, `slug` in `src/config/primitives.ts`), so a worker field can hold any worker id. The counts are
 * the most states in the block, the most owner fields, and the most values of one field.
 */
const maxTokenChars = 40;

export const boardLimits = {
  maxTokenChars,
  tokenPattern: new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${maxTokenChars - 1}}$`),
  maxStates: 20,
  maxFields: 20,
  maxValues: 30,
} as const;

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
 * The owner decisions of the user: the number of the schema, the keys of the file and of a record, and the bounds. One record
 * stands for one decision of one node and one real root. The file has its own lock and its own bounds, apart from the approval
 * records.
 */
export const ownerDecisions = {
  schema: 1,
  keys: {
    schema: 'schema',
    records: 'records',
    node: 'node',
    root: 'root',
    id: 'id',
    option: 'option',
    hash: 'hash',
    at: 'at',
  },
  /** The file holds at most this many records, and a reader refuses a file over this many bytes. */
  maxRecords: 1000,
  maxBytes: maxFileBytes,
} as const;

/**
 * The hash of a decision request. The canonical text is the JSON of the wrapper `{ tag, version, request }`, with the
 * whole waiting entry in `request`. The hash is SHA-256 of that text as lowercase hex, and `pattern` is its form.
 */
export const requestHash = {
  tag: 'factory.decision-request',
  version: 1,
  keys: { tag: 'tag', version: 'version', request: 'request' },
  pattern: /^[0-9a-f]{64}$/,
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
    board: 'board',
  },
  /** The `board` block: the item states, the two states that carry a meaning, the owner field of a worker, and the owner fields. */
  board: { states: 'states', inProgress: 'in_progress', closed: 'closed', workerField: 'worker_field', fields: 'fields' },
  /** One owner field of the `board` block. */
  boardField: { name: 'name', target: 'target', kind: 'kind', values: 'values', required: 'required' },
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
  /**
   * The keys of the one JSON object that the hook prints for the start of a worker session: `hookSpecificOutput` holds
   * `hookEventName` and `additionalContext`. The hooks page of Claude Code (https://code.claude.com/docs/en/hooks) names them.
   */
  output: { hookSpecificOutput: 'hookSpecificOutput', hookEventName: 'hookEventName', additionalContext: 'additionalContext' },
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
 * The checks of `worker watch`: at most `attempts` checks after the baseline, each after a wait of `intervalMs`. The watch lasts at
 * most `capMs`, which is 24 hours, so `attempts` is `capMs` divided by `intervalMs`. A test holds the two numbers together. A session
 * that works is stalled when the newer of its event time and its percent time is more than `stalledAfterMs` old. A worker that is new
 * has no last-seen line yet, so a missing line is not a change in the first `lineGraceChecks` checks (the baseline counts as the
 * first). From the check with this index on, or once a valid line was seen, a missing line is a change. A worker finished when its last
 * event is `finishEvent` and is newer than the baseline of the worker.
 */
export const watchPoll = {
  capMs: 86_400_000,
  attempts: 2_880,
  intervalMs: 30_000,
  stalledAfterMs: 900_000,
  lineGraceChecks: 2,
  finishEvent: 'Stop',
} as const;

/**
 * The run marker of `worker watch`: a new run writes a fresh token of `tokenBytes` random bytes, as lower case hex text and one new
 * line, to the file `files.watchRun` in the run-time folder. Each check reads the file again, at most `maxBytes`. A text with another
 * valid token means that a newer run took the marker. A file that is missing, too large or not a token is a lost marker.
 */
export const watchRun = {
  tokenBytes: 16,
  maxBytes: 128,
  tokenPattern: /^[0-9a-f]{32}\n$/,
} as const;

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
 * The limits of the lessons file of the coordinator. The file holds at most `maxEntries` entries and at most `maxBytes` bytes (about
 * 800 bytes for each of 40 short entries). An entry is a line that starts with `entryMark`, and a Why line and a How line follow it.
 * The role text gives these limits and this form, and `doctor` checks the file against them.
 */
export const lessonLimits = { maxEntries: 40, maxBytes: 32_768, entryMark: 'Rule:' } as const;

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

/**
 * The start time of a process for the token lock. The lock asks `ps` for `lstart`, which is a point in time, so a slow `ps` call
 * does not move it. `timeoutMs` bounds the call. `lstart` is the one form of the answer that the read accepts: spaces at the ends
 * and one new line at the end, a day name, a month name, the day of the month in two places (a space before a one-digit day), the
 * time with 2 digits for each part, and the year with 4 digits. The groups are the month, the day, the hour, the minute, the second
 * and the year. The time is in local time, and `months` gives the number of a month by its place.
 */
export const processStart = {
  timeoutMs: 5_000,
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  lstart:
    /^ *(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 0-3][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4}) *\n?$/,
} as const;

/** The warning of a take-over of a lock file that is no lock and is older than the stale age of its policy. */
export const lockStaleWarning = (lockPath: string): string =>
  `the lock file ${lockPath} holds no valid lock and is old: its lock is taken over`;

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
 * too long, or its session ended a turn (`finished`). Each line of a report ends with the time of the last check: `lastCheck` and a UTC
 * time of the form that `--since` accepts. A newer watch run replaces this one (`replaced`), the parent process of the watch changed
 * (`parentGone`), or the run marker is lost (`markerLost`, a failure with no time).
 */
export const watchWords = {
  changed: 'CHANGED:',
  noChange: 'NO CHANGE:',
  noWorker: 'NO WORKER:',
  noPane: 'no worker has a pane to watch',
  lastCheck: 'last check',
  replaced: 'REPLACED:',
  replacedBy: 'a newer watch runs',
  parentGone: 'ENDED:',
  parentGoneWhy: 'the parent process of the watch changed',
  markerLost: 'watch marker lost',
  kinds: {
    ended: 'pane ended',
    gone: 'pane gone',
    other: 'pane is not its launch',
    lineNotValid: 'line not valid',
    lineNotOwned: 'line not owned',
    waits: workerListWords.states.waits,
    stalled: 'stalled?',
    readyAfterBlock: 'ready',
    finished: 'finished',
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
 * The most workers of a node. The worker list reads at most this many entries of the workers folder (`workerRecord.maxEntries`), and a
 * report holds at most this many worker rows (`reportLimits.maxWorkers`), so every worker that the list reads can be in the report.
 * The widest row of a worker that the builder makes takes less than 1,000 bytes in the indented file text, so this many rows take
 * less than 256,000 bytes, and the report byte cap of 262,144 bytes holds them.
 */
const maxWorkers = 256;

/**
 * The limits of the report of a node (design 5.4). `schemaVersion` is the number that a report holds in its version key: a reader
 * that finds a higher number reads no more of the file. A report file has at most `maxBytes` bytes. One build of the report reads at
 * most `maxBuildBytes` bytes from the report files of its children in all. The lists of the report have at most `maxWorkers`,
 * `maxChildren`, `maxRequests` and `maxItems` entries, and a list of counts (the states, or the values of one owner field) at most
 * `maxCountRows` rows. `maxCountRows` is the same number as `maxWorkers`, so the lanes of all workers fit in the values of the worker
 * field. A list of counts is never a cause of failure: when it has more different names, it keeps the rows with the highest counts and
 * gives the number of the other names beside it. A text is at most `maxTextChars` characters, a version text at most `maxVersionChars`,
 * and a count or an age (in whole seconds) at most `maxNumber`.
 */
export const reportLimits = {
  schemaVersion: 1,
  maxBytes: 256 * 1_024,
  maxBuildBytes: 4 * 1_048_576,
  maxWorkers,
  maxChildren: 200,
  maxRequests: 500,
  maxItems: 500,
  maxCountRows: maxWorkers,
  maxTextChars: 200,
  maxVersionChars: 64,
  maxNumber: maxBoardNumber,
} as const;

/**
 * The keys of the report document (design 5.4), by the part of the document that holds them. `report --json` prints the document
 * and `report` and `status` write the same document to the report file, so a parent node reads these keys from a child. The
 * report allows these keys and no other: the schema is strict, so a key that is not here can not enter the file. A key never
 * changes inside one schema version.
 */
export const reportKeys = {
  doc: {
    schema: 'schema',
    schemaVersion: 'schemaVersion',
    id: 'id',
    layer: 'layer',
    factoryVersion: 'factoryVersion',
    cursor: 'cursor',
    workers: 'workers',
    board: 'board',
    inProgress: 'inProgress',
    requests: requestWords.requests,
    events: 'events',
    children: 'children',
  },
  worker: {
    id: 'id',
    project: 'project',
    state: 'state',
    contextPct: 'contextPct',
    activityAt: 'activityAt',
    workItem: 'workItem',
    idle: 'idle',
  },
  /**
   * The work item of a worker row. `state` is `known` and `item` holds the id of the open item, or null when the worker has no open
   * work; or `state` is `unknown` and the row has no `item` key. So null never means two things.
   */
  workItem: { state: 'state', item: 'item' },
  /**
   * The board counts: all the items by state, and the open items by each owner field. `statesOmitted` is the number of the states that
   * a full list of `states` left out.
   */
  board: { states: 'states', statesOmitted: 'statesOmitted', fields: 'fields' },
  /** One count: a state, or a value of an owner field, with the number of items. */
  tally: { name: 'name', count: 'count' },
  /** The counts of one owner field: the field name, the counts of its values, and the number of the values that a full list left out. */
  field: { field: 'field', values: 'values', valuesOmitted: 'valuesOmitted' },
  item: { id: 'id', title: 'title', state: 'state', track: 'track', stage: 'stage' },
  /** A request that waits for the owner. The origin is `<node id>#<request id>`, with `/` between the ids of deeper nodes. */
  request: { id: 'id', title: 'title', origin: 'origin' },
  /** The row of one direct child. The age is the age of its report file in whole seconds. */
  child: { id: 'id', address: 'address', state: 'state', reason: 'reason', counts: 'counts', age: 'age' },
  /** The counts that a child row takes from the report of that child. */
  counts: { workers: 'workers', inProgress: 'inProgress', requests: requestWords.requests, children: 'children' },
} as const;

/**
 * The words of the report: the first word of the verdict line of `report`, the text between a node id and a request id in the
 * origin of a request, the states of a child row (the report file holds the same words), the states of a worker row (the words
 * of `status`), the words of the verdict line, and the titles of the columns of the child table. A cell that has no value shows
 * `empty`, and an age in seconds has the unit `ageUnit`.
 */
export const reportWords = {
  verdict: { ok: 'OK:', check: 'CHECK:' },
  /** The words of the counts in the verdict line, and the notes after a count: a worker record that is not valid, a child that is not ok. */
  summary: {
    layer: 'layer',
    workers: 'workers',
    inProgress: 'in progress',
    requests: requestWords.requests,
    children: 'children',
    notValid: 'not valid',
    notOk: 'not ok',
  },
  empty: '-',
  ageUnit: 's',
  originSeparator: '#',
  childStates: { ok: 'ok', unknown: 'unknown', mismatch: 'mismatch' },
  /** The states of the work item of a worker row: the board gives the item (or no open work), or it does not give it. */
  workItemStates: { known: 'known', unknown: 'unknown' },
  workerStates: [
    statusWords.stopped,
    workerListWords.states.prompt,
    workerListWords.states.busy,
    workerListWords.states.waits,
    workerListWords.states.unknown,
  ],
  columns: {
    id: 'ID',
    state: 'STATE',
    workers: 'WORKERS',
    items: 'ITEMS',
    requests: requestWords.requests.toUpperCase(),
    children: 'CHILDREN',
    age: 'AGE',
    reason: 'REASON',
  },
} as const;

/**
 * The limits of a walk over the report files of the child nodes. The walk goes at most `maxDepth` layers down, reads at most
 * `maxNodes` report files, and reads at most `maxWalkBytes` bytes of them in all: that is 64 report files of the full size
 * `reportLimits.maxBytes`. The output has at most `maxLines` lines. One report file has at most `reportLimits.maxBytes` bytes, and
 * one build of a report reads at most `reportLimits.maxBuildBytes` bytes of its children.
 */
export const treeLimits = {
  maxDepth: layers.max,
  maxNodes: 1_000,
  maxLines: 2_000,
  maxWalkBytes: 16 * 1_048_576,
} as const;

/**
 * The reasons of a child row that is not `ok`. Each one is fixed text: no reason holds text of a child, a path, an id or the message of
 * a check, so child text can not reach the output through a reason. Each one fits in the `reason` of a child row of a report, which has
 * at most `reportLimits.maxTextChars` characters.
 */
export const childReasons = {
  noReport: 'the child has no report file',
  reportLink: 'a path of the report file is a link',
  reportWrongKind: 'a path of the report file is not of the kind that it must be',
  reportOtherOwner: 'the report file belongs to another account',
  reportWritable: 'a group or other users can write a path of the report file',
  reportTooLarge: 'the report file is larger than the byte cap',
  reportNotJson: 'the report file is not valid JSON',
  reportNewer: 'the report file has a newer schema version than this program reads',
  reportInvalid: 'the report file does not pass the schema of the report',
  reportUnreadable: 'the report file could not be read, or it is not valid UTF-8 text',
  addressInvalid: 'the address of the child is not valid',
  otherId: 'the child shows another id than the config lists',
  configUnsafe: 'the config of the child is a link, belongs to another account, or can be written by a group or by other users',
  configInvalid: `the config of the child is not valid: run "${program} ${commands.doctor}" in that ${places.folder}`,
  cycle: 'the walk saw this folder before',
  duplicateId: 'another folder has the same id',
  depthCap: 'the walk is at the depth cap',
  nodeCap: 'the walk is at the cap of nodes',
  byteCap: 'the walk is at the cap of bytes that it may read',
  buildByteCap: 'the build of the report is at the cap of bytes that it may read',
} as const;

/**
 * The words of the tree of the child nodes: the state of a row that tells of the walk and not of a node (a duplicate id, or requests
 * that were dropped), the mark of a row below a direct child (the id of the node that gave the address follows it), the line that
 * says the line cap cut the list, the words of the verdict line, the verdict values of the document, and the reason of the row of
 * dropped requests (a count follows it). The states `ok`, `unknown` and `mismatch` are those of `reportWords.childStates`.
 */
export const treeWords = {
  warning: 'warning',
  reportedBy: 'reported by',
  moreThan: 'more than',
  summary: { nodes: 'nodes', warnings: 'warnings' },
  verdicts: { ok: 'ok', check: 'check' },
  requestsDropped: `${requestWords.requests} were dropped: the origin does not name the node that reports them`,
} as const;

/**
 * The keys of the document `factory.node-tree/v1`. Every string that comes from the file of a child is under the one field
 * `node.report`, with the path of that file in `report.source`. All other fields hold text of this program only. The field `omitted`
 * is the count of the rows that the line cap left out of `nodes`.
 */
export const treeKeys = {
  doc: { schema: 'schema', home: 'home', id: 'id', layer: 'layer', verdict: 'verdict', omitted: 'omitted', nodes: 'nodes' },
  node: { depth: 'depth', state: 'state', reason: 'reason', report: 'report' },
  report: {
    source: 'source',
    id: 'id',
    address: 'address',
    layer: 'layer',
    counts: 'counts',
    age: 'age',
    reportedBy: 'reportedBy',
  },
} as const;

/**
 * The rules and the words of `dismiss` (design 4.11). The work of a worker is pushed when, after a fetch of `remote`, the head of its
 * branch is on the branch of the same name of that remote. A line that says that it is not starts with `stuck`. The dry run and the free
 * name at most `maxIgnoredShown` of the ignored files that the removal of a work copy deletes, and a reason names at most `maxFilesNamed` changed
 * files. The dry run also names at most `maxInboxShown` of the inbox files that the removal deletes. The table of `--idle` has the
 * columns `columns`. A refusal and the decision row of `--closed` name at most `maxItemsNamed` item ids.
 */
export const dismissWords = {
  remote: 'origin',
  stuck: 'STUCK:',
  maxIgnoredShown: 20,
  maxFilesNamed: 5,
  /** The most inbox files that the dry run names. The read takes one name more, to know that the inbox holds more. */
  maxInboxShown: 20,
  /** The most item ids that a line of the closed path names. The decision text of a board write is at most 500 characters. */
  maxItemsNamed: 10,
  columns: { id: 'ID', project: 'PROJECT', state: 'STATE', pushed: 'PUSHED', ignored: 'IGNORED' },
  /** What the removal deletes, as the line about a list of files names it. */
  fileKinds: { ignored: 'ignored', inbox: dirs.inbox },
  /** The cell of the ignored count for a worker whose files are not read: its work is not pushed, so it is not freed. */
  noCount: '-',
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
 * list of the program. The coordinator is named with the id of the node. A worker is named with the id of the node, an underscore
 * and the id of the worker. A slug can hold a hyphen but no underscore, so two nodes with different ids never give the same name: a
 * worker name never equals the name of a coordinator, or the name of a worker of another node. The name holds no separator of a
 * tmux target (a colon or a dot). Each id must be a slug, so a name is one plain word for the flag: no space, no control character
 * and no leading hyphen. A call returns a `Result` and never throws. An error does not repeat the id that it refuses.
 */
export const sessionNames = {
  /** The flag of the agent program that sets the name of a session. */
  flag: '--name',
  coordinator: (node: string): Result<string, string> => (isSlug(node) ? ok(node) : refuseSessionId('a node id')),
  worker: (node: string, worker: string): Result<string, string> => {
    if (!isSlug(node)) return refuseSessionId('a node id');
    if (!isSlug(worker)) return refuseSessionId('a worker id');
    return ok(`${node}_${worker}`);
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
  maxEntries: maxWorkers,
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
 * The lock file holds the token of its writer, so a writer that ran past `staleMs` does not remove the lock file of the writer that
 * took its lock over. `staleMs` is larger than the longest locked run: about 13 git calls on the upgrade path with a limit of
 * 15 seconds each (195 seconds at most), and a backup.
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

/** The wait of a heavy run for its turn: it tries `HEAVY_ATTEMPTS` times and waits `HEAVY_WAIT_MS` between two tries. */
const HEAVY_WAIT_MS = 5_000;
const HEAVY_ATTEMPTS = 1_080;

/**
 * The bounds of the heavy lock (`lock run`). A run waits 5 seconds between two tries and tries 1,080 times, so it waits 90 minutes at
 * most. A priority file that is older than the whole wait never blocks a waiter, because no run waits longer than that
 * (`priorityMaxAgeMs` is derived, so the two cannot differ). A run may hold the lock for 3 hours (`maxHoldMs`); then its child group
 * gets TERM, and KILL after `killGraceMs`. The lock is stale by the state of its holder (the pid and the start time, which may differ
 * by `startToleranceMs`); a file that holds no valid token is stale after `claimStaleMs`, and so is a claim file. A file of the lock,
 * the claim and the priority mark has mode `mode`, and the priority file holds at most `maxPriorityBytes` bytes. `stopSignals` are the
 * signals that end the wait, with the number of each for the exit code (128 plus the number).
 */
export const heavyLock = {
  waitMs: HEAVY_WAIT_MS,
  attempts: HEAVY_ATTEMPTS,
  maxHoldMs: 10_800_000,
  priorityMaxAgeMs: HEAVY_WAIT_MS * HEAVY_ATTEMPTS,
  startToleranceMs: 3_000,
  claimStaleMs: 60_000,
  killGraceMs: 10_000,
  mode: privateFile.fileMode,
  takeoverSuffix: privateFile.takeoverSuffix,
  maxPriorityBytes: 256,
  stopSignals: { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 },
  /** The exit code of a run that a signal ends is this number plus the number of the signal, as a shell reports it. */
  signalExitBase: 128,
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
  /** Where an owner field lives: on an item, or on a queue row. */
  boardTargets: ['item', 'row'],
  /** What an owner field holds: one value of a list, a flag, or one free token. */
  boardKinds: ['values', 'flag', 'token'],
  defaultWatchInterval: '5m',
  /** A worker at its prompt with no event for this time is idle. */
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

/**
 * The fixed header of a message file that `node send` writes into the inbox of a child. The file is a message and carries no
 * authority of the owner. The header has four lines, in this order: the id of the sender, the address of the sender, the id
 * of the target, and the note. `messageHeaderLines` builds them, so the order has one owner. The note is plain text, because
 * the text rules of the source treat the word "message" as a name of this one use. The texts of the safety block reach the
 * note through the template value `inboxNotice`, so that no other text of the source holds the word.
 */
export const messageHeader = {
  senderId: `Sender ${roles.node} id: `,
  senderAddress: `Sender ${roles.node} address: `,
  targetId: `Target ${roles.node} id: `,
  notice: 'Message, no owner authority.',
} as const;

/** The four lines of the header of a message file, in the fixed order. */
export const messageHeaderLines = (parts: {
  readonly senderId: string;
  readonly senderAddress: string;
  readonly targetId: string;
}): readonly string[] => [
  `${messageHeader.senderId}${parts.senderId}`,
  `${messageHeader.senderAddress}${parts.senderAddress}`,
  `${messageHeader.targetId}${parts.targetId}`,
  messageHeader.notice,
];

/**
 * The bounds of the inbox of a child (`.factory/inbox/`): the most files, and the most bytes in all. `node send` stops
 * with a full inbox when a write would go past one of them.
 */
export const nodeInbox = { maxFiles: 100, maxBytes: 8 * 1_048_576 } as const;

/**
 * The parts of the name of a message file. `node send` makes the name from the time, the id of the sender and `randomBytes`
 * random bytes as hex, with `separator` between the parts and `suffix` at the end.
 */
export const messageFile = { separator: '-', suffix: '.md', randomBytes: 4 } as const;

/**
 * The reasons that `node send` shows. Each one is fixed text: no reason holds text of the child, a message of a check or an
 * id. A reason that comes from the check of the child stays in this list, so child text can not reach the output.
 */
export const nodeSendReasons = {
  notChild: `the id is not a child of this ${roles.node}`,
  controlChars: 'the task text has a control character or a hidden character',
  token: 'the task text looks like a token',
  notAnswering: 'the child does not answer',
  mismatch: 'the child shows another id or another layer than the config lists',
  unsafe: 'a folder or a file of the child is a link, has another owner, or can be written by a group or by other users',
  full: 'the inbox of the child is full',
  notIgnored: 'the state repo of the child does not ignore the inbox folder',
  io: 'the file could not be written',
  removeFailed: 'the file could not be removed',
} as const;

/**
 * The tools of the agent program that the output of `node send` names. The command writes the file only. The sender checks the
 * session of the child with `listAgents`, and sends a message that names the file with `sendMessage`.
 */
export const sendTools = { listAgents: 'ListAgents', sendMessage: 'SendMessage' } as const;

/** The ids of the checks that the doctor command runs. */
export const checkIds = {
  config: 'config',
  configVersion: 'config-version',
  localFile: 'local-file',
  state: 'state',
  root: 'root',
  tempFolder: 'temp-folder',
  index: 'index',
  /** The node id against the other entries of the factory list: two nodes with one id give their sessions the same names. */
  nodeId: 'node-id',
  blocks: 'blocks',
  setupText: 'setup-text',
  roles: 'roles',
  tracker: 'tracker',
  children: 'children',
  secrets: 'secrets',
  permissionMode: 'permission-mode',
  /** What the root repo tracks and what git ignores. */
  rootRepo: 'root-repo',
  /** The path from the setup text of the workers to their sessions: the hook, the role text, and the work copies. */
  roleDelivery: 'role-delivery',
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
  /** The size of the board, the waiting file and the decision log against the read cap: a warning from `boardWarnPercent` on. */
  boardSize: 'board-size',
  /** The lessons file of the coordinator against its limits: a plain file, at most `lessonLimits.maxBytes` bytes and `lessonLimits.maxEntries` entries. */
  lessons: 'lessons',
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
  /** The working rules of the coordinator, as a block of its own in the coordinator `CLAUDE.md`. */
  workRules: 'work-rules',
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

/** The unit of the size that a refusal of a role text that is too large names. */
export type RoleSizeUnit = 'bytes' | 'characters';

const ROLE_TEXT_MAX_CHARS = 9_000;

/** The remedy for a work copy whose hook settings hold some own hooks: `upgrade` adds the rest, and `resume` starts the worker again. */
const upgradeThen = (resume: string): string => `Run "${commandText(commands.upgrade)}", then "${resume}".`;

/**
 * The role text that a session of a worker gets at its start (`hook SessionStart`): the cap, the fixed lines and the
 * fixed reasons. The text is the package worker rules and the text that the owner accepted in the setup folder, and it is
 * never cut: a text above `maxChars`, the source line included, is refused. The hook prints `refusal` when a check fails
 * and one text of `reasons` on its error output, and never text of a file, a path or the text of an error. The messages
 * of the launch, reset and doctor checks use the same reasons, with a remedy line that names the fix.
 */
export const roleText = {
  maxChars: ROLE_TEXT_MAX_CHARS,
  /** The text between two parts of the role text. */
  joiner: '\n\n',
  /** The first line of the role text. */
  sourceLine: `Source: the ${roles.worker} rules of the ${program} package, and the setup text in ${setupFileOf(blockNames.setupWorker)} that the ${roles.owner} accepted.`,
  /** The text that a session gets when a check fails. */
  refusal: `The ${program} role text did not arrive. Do no work. Tell the ${roles.coordinator}.`,
  /** One reason for each fault, as the hook prints it on its error output. */
  reasons: {
    link: 'role text refused: a link is in the path of the setup file',
    ownerOrMode: 'role text refused: the setup file or its folder has the wrong owner or mode',
    tooLarge: 'role text refused: the text is larger than the cap',
    notUtf8: 'role text refused: the setup file is not UTF-8 text',
    notPlainText: 'role text refused: the setup file is not plain text',
    blockMarker: 'role text refused: the setup file holds a block marker',
    notAccepted: 'role text refused: the setup file is not accepted',
    readFailed: 'role text refused: the setup file cannot be read',
    configNotUsable: 'role text refused: the config is not usable',
    /** The input of the hook is not usable, so the hook cannot read the session id. Only the hook gives this reason. */
    inputNotUsable: 'role text refused: the input of the hook is not usable',
  },
  /** The size of a text that is too large and the cap, for the message of a launch, a reset or a check. */
  tooLargeText: (size: number, unit: RoleSizeUnit): string =>
    `the role text has ${size} ${unit}, and the cap is ${ROLE_TEXT_MAX_CHARS} characters`,
  /** The remedy lines. `retry` is the command that the refusal stopped, as a person types it. */
  remedies: {
    path: (retry: string): string =>
      `Fix the link, the owner or the mode of ${setupFileOf(blockNames.setupWorker)} and of its folders, then run "${retry}" again.`,
    accept: (retry: string): string =>
      `Accept ${setupFileOf(blockNames.setupWorker)} in a terminal window outside a ${places.session}: run "${commandText(commands.init)}" for a first acceptance, or "${commandText(commands.upgrade)}" after a change. Then run "${retry}" again.`,
    shorten: (free: number, retry: string): string =>
      `Shorten ${setupFileOf(blockNames.setupWorker)} to ${free} characters or fewer, then run "${retry}" again.`,
    correct: (retry: string): string => `Correct the text of ${setupFileOf(blockNames.setupWorker)}, then run "${retry}" again.`,
    config: (retry: string): string => `Run "${commandText(commands.doctor)}" and fix what it reports, then run "${retry}" again.`,
  },
  /**
   * The words of the doctor check of the role delivery (`checkIds.roleDelivery`). The line counts the work copies that hold the
   * own hook of every event that a launch needs, gives the size of the role text, and names in words where the acceptance of the
   * setup text is kept. Each finding gives one remedy.
   */
  doctor: {
    /** The line of a node that has no worker file: it has no role text to deliver. */
    noWorkerFile: `this layer has no ${roles.worker} file, so no role text is delivered`,
    hooks: (withHooks: number, copies: number): string => `every hook event in ${withHooks} of ${copies} work copies`,
    size: (chars: number): string => `role text ${chars} of ${ROLE_TEXT_MAX_CHARS} characters`,
    acceptance: `The acceptance of the setup text is recorded in ${files.setupAcceptances}, in the ${program} folder of the state folder of the user.`,
    /** A work copy whose hook settings lack the own hook of these events: the launch of the worker refuses the same work copy. */
    gap: (id: string, events: readonly HookEvent[]): string =>
      `${id}: the hook settings of the work copy lack the hook of these events: ${events.join(', ')}. The worker does not start until they are in place.`,
    /** A work copy whose hook settings file is a link: the check reads nothing through it. */
    linkGap: (id: string): string => `${id}: the hook settings file of the work copy is a link, and the check does not read it.`,
    /** A work copy whose hook settings the check cannot read. `reason` is the read fault. */
    unreadGap: (id: string, reason: string): string => `${id}: the hook settings of the work copy are not checked (${reason}).`,
    remedies: {
      /** Some own hooks are there. `upgrade` adds the missing ones. `resume` is the command that starts the worker again. */
      upgrade: upgradeThen,
      /** No own hook is there: `upgrade` leaves such a work copy as it is, so only a new worker asks for the hook settings. */
      recreate: (dismiss: string, create: string): string =>
        `Run "${dismiss}", then "${create}", and answer yes to the question about the hook settings.`,
      link: (id: string, resume: string): string => `Replace the hook settings file of ${id} with a plain file. ${upgradeThen(resume)}`,
      unread: (id: string): string => `Make the hook settings of ${id} readable, then run "${commandText(commands.doctor)}" again.`,
    },
  },
  /**
   * The remedy for a work copy whose hook settings lack an own event, so that its session would get no role text. Each command
   * stands on its own line. The first two add the own entries and start the worker again. The next two are for a work copy that
   * never had the hook: only a new worker asks the question about the hook settings. The last line is a sentence, so a text that
   * a caller adds after it cannot read as part of a command.
   */
  hookRemedy: (steps: { readonly again: string; readonly dismiss: string; readonly create: string }): string =>
    [
      'Run these commands, one after the other:',
      commandText(commands.upgrade),
      steps.again,
      'If the work copy has no factory hook, the worker gets no role text. Run these commands instead:',
      steps.dismiss,
      steps.create,
      'Answer yes to the question about the hook settings.',
    ].join('\n'),
} as const;

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
  report: `${program}.report/v1`,
  dismiss: `${program}.dismiss/v1`,
  nodeChildren: `${program}.node-children/v1`,
  nodeSend: `${program}.node-send/v1`,
  nodeTree: `${program}.node-tree/v1`,
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
  item: `${program}.item/v1`,
  itemList: `${program}.item-list/v1`,
  track: `${program}.track/v1`,
  trackList: `${program}.track-list/v1`,
  request: `${program}.${commands.request}/v1`,
  requestList: `${program}.${commands.request}-list/v1`,
  decide: `${program}.${commands.decide}/v1`,
  queue: `${program}.${commands.queue}/v1`,
  queueShow: `${program}.${commands.queue}-show/v1`,
  stateGuard: `${program}.state-guard/v1`,
  lock: `${program}.${commands.lock}/v1`,
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
 * The fixed word of each outcome of `lock run` that the program itself decides. The line of an outcome starts with `lockLine`, which
 * names the command and the word. A child can exit with the same code as the program, so this line is the sure way to tell the two apart.
 */
export const lockWords = {
  waiting: 'WAITING',
  waitEnded: 'WAIT ENDED',
  holdEnded: 'HOLD ENDED',
  priorityHeld: 'PRIORITY HELD',
  refused: 'REFUSED',
  notFound: 'NOT FOUND',
  notStarted: 'NOT STARTED',
  stopped: 'STOPPED',
  usage: 'USAGE',
} as const;

/** The text of a note of `lock run` that has no fixed word, for example a warning: the command and the detail. */
export const lockNote = (detail: string): string => `${commandText(commandLines.lockRun)}: ${detail}`;

/** The text of one line of `lock run`: the command, the fixed word and the detail, for example `factory lock run: WAIT ENDED. The lock stayed busy.` */
export const lockLine = (word: string, detail: string): string => lockNote(`${word}. ${detail}`);

/**
 * The delete guard of the state repo: hooks that git runs before it makes a commit. `init` and `upgrade` write them from the text
 * below into a folder of the git folder of the state repo (never the folder `hooks`), and set the key `core.hooksPath` to that
 * folder. The git folder is not part of the tracked files, so the repo never holds a hook. The folder holds the hook files and
 * nothing else. Every hook file has the same text, which starts `state guard`: `pre-commit` is for `git commit`,
 * `pre-merge-commit` is for the commit of `git merge`, and `pre-applypatch` is for `git am`.
 */
export const stateGuard = {
  folder: 'factory-guard',
  hookFiles: ['pre-commit', 'pre-merge-commit', 'pre-applypatch'],
  hookMode: 0o755,
  folderMode: 0o755,
  hooksPathKey: 'core.hooksPath',
  /** The most entries that an install removes from the guard folder; a folder with more is left alone. */
  maxEntries: 64,
  /** The folder of the git folder that git reads hook files from when `core.hooksPath` is not set. */
  defaultHooksFolder: 'hooks',
  /** The end of the name of an example file in the default hooks folder: git does not run it. */
  sampleSuffix: '.sample',
  /** The most hooks that a warning names; it counts the rest. */
  maxShownStops: 5,
  /** The most older commits of board.json that the guard reads back to find the last board that can be read. */
  historyBound: 100,
  /**
   * The most older commits of board.json that the guard reads when the walk back ends at `historyBound` with no board that can be
   * read: it looks in the commits after the first `historyBound` for the board that a person put back. It counts from the last commit.
   */
  restoreBound: 500,
  /** The word between the folder name and the pid in the name of the copy that an install keeps of an old guard folder. */
  copyWord: '.old-',
  interpreter: '#!/bin/sh',
  comment: `# Written by ${program} from the text of the package. Git does not track this file. Run "${commandText(commands.upgrade)}" to write it again.`,
  /** The line that a hook prints, with a stop, when the node program or the script that it names is gone. */
  programMissing: `${program}: the program of the delete guard is not there. Run "${commandText(commands.upgrade)}" to write the guard again.`,
  /** The remedy of every case of an off guard. */
  remedy: `Run "${commandText(commands.upgrade)}".`,
} as const;

/** A subcommand of `worker` as a person types it, for example `factory worker watch`. */
const workerCommandText = (subcommand: string): string => commandText(`${commands.worker} ${subcommand}`);

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
  lessonsFile: inState(files.lessons),
  profileDir: `${inState(dirs.profile)}/`,
  roadmapsDir: `${inState(dirs.roadmaps)}/`,
  ordersDir: `${inState(dirs.orders)}/`,
  workersDir: `${inState(dirs.workers)}/`,
  resumeDir: `${inState(dirs.resume)}/`,
  nodeInboxDir: `${inState(dirs.inbox)}/`,
  reviewsDir: `${inState(dirs.reviews)}/`,
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
  inboxEnv: env.inbox,
  resumeFile: files.resume,
  maxLessons: String(lessonLimits.maxEntries),
  maxLessonBytes: String(lessonLimits.maxBytes),
  workerNewCommand: `${workerCommandText(workerCommands.new)} <id> ${flagText(flags.project)} P ${flagText(flags.assignment)} FILE`,
  workerWatchCommand: workerCommandText(workerCommands.watch),
  dismissCommand: commandText(commands.dismiss),
  lastCheckWord: watchWords.lastCheck,
  replacedWord: watchWords.replaced,
  markerLostWord: watchWords.markerLost,
  paneGoneWord: watchWords.kinds.gone,
  workerResetCommand: workerCommandText(workerCommands.reset),
  nodeSendCommand: `${commandText(commandLines.nodeSend)} <id> ${flagText(flags.file)} FILE`,
  inboxNotice: messageHeader.notice,
  selfResetCommand: commandText(`${commands.self} ${selfCommands.reset}`),
  itemCommand: commandText(commands.item),
  trackCommand: commandText(commands.track),
  requestCommand: commandText(commands.request),
  decideCommand: commandText(commands.decide),
  requestCloseCommand: `${commandText(commandLines.requestClose)} <id> ${flagText(flags.madeBy)} ${Object.values(requestDeciders).join('|')} ${flagText(flags.decision)} TEXT`,
  queueCommand: commandText(commands.queue),
  lockRunCommand: commandText(commandLines.lockRun),
  lockPriorityFlag: flagText(flags.priority),
  itemMoveCommand: `${commandText(commandLines.itemMove)} <id> ${flagText(flags.stage)} <stage>`,
  itemRecordCommand: `${commandText(commandLines.itemRecord)} <id> ${flagText(flags.ref)} N`,
  itemUpdateCommand: commandText(commandLines.itemUpdate),
  itemUnassignCommand: `${commandText(commandLines.itemUnassign)} <id>`,
  requestRelayCommand: `${commandText(commandLines.requestClose)} <id> ${flagText(flags.relayed)} ${flagText(flags.decision)} TEXT`,
  requestLogCommand: `${commandText(commandLines.requestLog)} ${flagText(flags.madeBy)} ${Object.values(requestDeciders).join('|')} ${flagText(flags.title)} TEXT ${flagText(flags.decision)} TEXT`,
  upgradeCommand: commandText(commands.upgrade),
  mergedPrHeadKey: boardKeys.mergedPrHead,
  unassignedFromKey: boardKeys.unassignedFrom,
  madeByFlag: flagText(flags.madeBy),
  relayedFlag: flagText(flags.relayed),
  clearFlag: flagText(flags.clear),
  compactFlag: flagText(flags.compact),
  yesFlag: flagText(flags.yes),
  jsonFlag: flagText(flags.json),
  helpFlag: flagText(flags.help),
  requestsWord: requestWords.requests,
  readyFlag: flagText(flags.ready),
  sinceFlag: flagText(flags.since),
  closedFlag: flagText(flags.closed),
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
