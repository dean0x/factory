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
  node: 'node',
  doctor: 'doctor',
  upgrade: 'upgrade',
  version: 'version',
  help: 'help',
} as const;

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
  'release check',
] as const;

/** The subcommands of `node`. */
export const nodeCommands = { children: 'children', addChild: 'add-child', removeChild: 'remove-child' } as const;

export const flags = {
  home: 'home',
  name: 'name',
  ownerName: 'owner-name',
  ownerGithub: 'owner-github',
  project: 'project',
  recipe: 'recipe',
  layer: 'layer',
  yes: 'yes',
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
} as const;

export const dirs = {
  state: '.factory',
  profile: 'decision-profile',
  principles: 'principles',
  decisions: 'decisions',
  roadmaps: 'roadmaps',
  roles: 'roles',
  orders: 'orders',
  backups: 'backups',
  runtime: 'state',
  locks: 'locks',
  claude: '.claude',
  /** The folder of the coordinator session, below the root. It holds the rendered `CLAUDE.md`, and git ignores it. */
  coordinator: 'coordinator',
  /** The fixed folder of the work copies, below the root. Git ignores it. */
  workCopies: 'work-copies',
  /** The folder of the setup text that a person shares. The root repo tracks it. */
  setup: 'setup',
} as const;

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
  'CLAUDE.local.md',
  'AGENTS.md',
] as const;

/** The label of the two marker lines around the part of the root `.gitignore` that the tool writes. */
export const shareListLabel = 'share list';

/** The settings files of Claude Code in a project: `<prefix>*<suffix>` inside the `.claude` folder. */
export const claudeSettings = { prefix: 'settings', suffix: '.json' } as const;

export const env = {
  proxyBaseUrl: 'ANTHROPIC_BASE_URL',
  /** The folders where the shell looks for a program. */
  path: 'PATH',
  home: 'FACTORY_HOME',
  session: 'FACTORY_SESSION',
  /** The folder of the per-user state. The home index lives below it. */
  stateHome: 'XDG_STATE_HOME',
  userHome: 'HOME',
} as const;

/** The most bytes that factory reads from one config, state or index file. A larger file is refused. */
export const maxFileBytes = 1_048_576;

/**
 * The per-user index of node homes (design 4.3): the number of its schema, its keys, its default place
 * below the user home, and its bounds. A command finds a home from a project folder through it.
 */
export const homeIndex = {
  schema: 1,
  keys: { schema: 'schema', homes: 'homes', home: 'home', id: 'id', projects: 'projects' },
  defaultStateHome: ['.local', 'state'],
  maxHomes: 200,
  maxProjects: 200,
  maxBytes: maxFileBytes,
  /** The lock file beside the index: the name of the index and this suffix. */
  lockSuffix: '.lock',
  /** A writer tries to take the lock this many times, and waits this long between two tries. */
  lockAttempts: 20,
  lockWaitMs: 50,
  /** A lock that is older than this was left by a process that ended. The next writer takes it. */
  lockStaleMs: 5_000,
} as const;

/**
 * The names that factory gives to the tmux session of a node: two windows, and options that tell
 * a session of this node home from any other tmux session.
 */
export const tmuxNames = {
  windowView: 'view',
  windowBench: 'bench',
  /** The session option that holds the node home. */
  optionHome: '@factory_home',
  /** The pane option that holds the node id, on the pane of the coordinator. */
  optionNode: '@node',
  /** The pane option that marks the slot of the view window. */
  optionSlot: '@slot',
  /** The pane option that holds the worker id, on a bench pane. */
  optionWorker: '@worker',
  slotBoard: 'board',
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
  },
  project: {
    id: 'id',
    url: 'url',
    repo: 'repo',
    path: 'path',
    defaultBranch: 'default_branch',
    mergeMethod: 'merge_method',
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

/** The words that a config value can take. */
export const values = {
  permissionMode: 'auto',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  noProxy: 'none',
  onFail: ['stop', 'direct'],
  loadCpuCount: 'cpu_count',
  mergeMethods: ['squash', 'merge', 'rebase'],
  variants: ['plain'],
  recipes: ['software'],
  /** The mode of an approval point of any recipe. The first one is the default: the point waits for the owner. */
  approvalModes: [roles.owner, 'delegated'],
  trackerLocal: 'local',
  trackerHosted: ['github', 'jira', 'linear'],
  defaultWatchInterval: '5m',
} as const;

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
  proxyEnv: 'proxy-env',
  proxy: 'proxy',
  tools: 'tools',
  stateRepo: 'state-repo',
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
  nodeChildren: `${program}.node-children/v1`,
  words: `${program}.words/v1`,
  doctor: `${program}.doctor/v1`,
  upgrade: `${program}.upgrade/v1`,
  version: `${program}.version/v1`,
  error: `${program}.error/v1`,
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

/** The command that replaces or adds one managed block, for example `factory upgrade --overwrite coordinator`. */
export const overwriteCommand = (block: string): string =>
  `${commandText(commands.upgrade)} ${flagText(flags.overwrite)} ${block}`;

/** The path of a key inside the config, for example `limits.disk_free_min_gb`. */
const keyPath = (...parts: readonly string[]): string => parts.join('.');

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
  onFailDirect: `${keys.proxy.onFail}: ${values.onFail[1]}`,
  proxyEnv: env.proxyBaseUrl,
  claudeDir: dirs.claude,
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
