/**
 * Every user-visible name of factory is defined in this file and nowhere else:
 * command words, flag names, config keys, file and folder names, the marker of
 * managed blocks, the ids of JSON output schemas, and the role words of help and
 * template text. Other modules import these constants. A unit test fails when
 * one of these names is a string literal in another file of src/.
 *
 * A change of a config key, of a state key, of a file name or of a folder name
 * needs a migration (src/migrate), so that existing nodes keep working.
 * Text templates use placeholders such as {{cell}}. The placeholders are filled
 * from `templateValues` below.
 */

export const program = 'factory';

/** The role words of help and template text. */
export const roles = {
  node: 'node',
  cell: 'cell',
  coordinator: 'coordinator',
  manager: 'manager',
  worker: 'worker',
  owner: 'owner',
  recipe: 'recipe',
  variant: 'variant',
} as const;

export const commands = {
  init: 'init',
  up: 'up',
  node: 'node',
  doctor: 'doctor',
  upgrade: 'upgrade',
  version: 'version',
  help: 'help',
} as const;

/** The topics of `help`. */
export const helpTopics = { words: 'words' } as const;

/**
 * The factory words that have a plain description in `src/glossary.ts` and in `docs/glossary.md`:
 * the concepts of the design and the shop-floor words that factory uses. A test fails for a term with no entry.
 */
export const terms = [
  'node',
  'owner',
  'project',
  'layer',
  'cell',
  'recipe',
  'variant',
  'andon',
  'work order',
  'changeover',
  'staging',
  'inspect',
  'ship',
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
  claudeMd: 'CLAUDE.md',
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
} as const;

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
  /** The pane option that holds the cell id, on a bench pane. */
  optionCell: '@cell',
  slotBoard: 'board',
} as const;

/** The keys of the config file. */
export const keys = {
  root: {
    schema: 'schema',
    node: 'node',
    owner: 'owner',
    session: 'session',
    proxies: 'proxies',
    cells: 'cells',
    limits: 'limits',
    approval: 'approval',
    tracker: 'tracker',
    recipe: 'recipe',
    parent: 'parent',
    children: 'children',
  },
  node: { id: 'id', layer: 'layer' },
  owner: { display: 'display', github: 'github', prefix: 'prefix' },
  session: { permissionMode: 'permission_mode', effort: 'effort', model: 'model', proxy: 'proxy' },
  proxy: { id: 'id', baseUrl: 'base_url', health: 'health', onFail: 'on_fail' },
  cell: { proxy: 'proxy' },
  limits: {
    memoryFreeMinPct: 'memory_free_min_pct',
    diskFreeMinGb: 'disk_free_min_gb',
    loadMax: 'load_max',
    contextPreparePct: 'context_prepare_pct',
    contextMaxPct: 'context_max_pct',
  },
  project: {
    id: 'id',
    repo: 'repo',
    path: 'path',
    defaultBranch: 'default_branch',
    mergeMethod: 'merge_method',
    variant: 'variant',
    gate: 'gate',
    heavyTest: 'heavy_test',
  },
  gate: { checks: 'checks' },
  approval: { land: 'land' },
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
  landModes: ['each', 'approved-work'],
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
  state: 'state',
  home: 'home',
  index: 'index',
  blocks: 'blocks',
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
} as const;

export const blockNames = {
  coordinator: 'coordinator',
  manager: 'manager',
  safety: 'safety',
  worker: 'worker',
} as const;

/**
 * The names of a FAC-M1 node (schema 1) that schema 2 does not use. Only the migrations from schema 1 read them.
 */
export const schema1 = {
  keys: { role: 'role', lanes: 'lanes', projects: 'projects', pack: 'pack' },
  protocolFile: 'protocol.md',
  briefsDir: 'briefs',
  protocolBlock: 'protocol',
  /** The sha256, as hex, of `roadmaps/README.md` as `init` of version 0.1.0 wrote it. */
  roadmapsReadmeSha256: '2f9168abccda69f6ed71c8c1339ee899ad39e20c606838c750bae4d5346fad2c',
} as const;

/** Markers of managed blocks: `<!-- factory:begin <name> v<n> sha256=<hex> -->` and `<!-- factory:end <name> -->`. */
export const marker = { prefix: `${program}:`, begin: 'begin', end: 'end', hash: 'sha256' } as const;

/** The ids of the JSON documents that commands print. */
export const schemaIds = {
  init: `${program}.init/v1`,
  up: `${program}.up/v1`,
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

/** The path of a key inside the config, for example `limits.disk_free_min_gb`. */
const keyPath = (...parts: readonly string[]): string => parts.join('.');

/** A path inside the state folder, written from the node home. */
const inState = (...parts: readonly string[]): string => [dirs.state, ...parts].join('/');

/** The values for the placeholders of the templates, for example {{cell}} and {{Cell}}. */
export const templateValues: Readonly<Record<string, string>> = {
  program,
  node: roles.node,
  cell: roles.cell,
  coordinator: roles.coordinator,
  manager: roles.manager,
  worker: roles.worker,
  owner: roles.owner,
  recipe: roles.recipe,
  variant: roles.variant,
  childrenKey: keys.root.children,
  configFile: files.config,
  stateDir: dirs.state,
  nodeFile: inState(files.nodeState),
  workerFile: inState(dirs.roles, files.worker),
  boardFile: inState(files.board),
  waitingFile: inState(files.waiting),
  decisionLogFile: inState(files.decisionLog),
  profileDir: `${inState(dirs.profile)}/`,
  roadmapsDir: `${inState(dirs.roadmaps)}/`,
  ordersDir: `${inState(dirs.orders)}/`,
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
