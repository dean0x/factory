/**
 * Every user-visible name of factory is defined in this file and nowhere else:
 * command words, flag names, config keys, file and folder names, the marker of
 * managed blocks, the ids of JSON output schemas, and the role words of help and
 * template text. Other modules import these constants. A unit test fails when
 * one of these names is a string literal in another file of src/.
 *
 * A change of a config key, of a state key, of a file name or of a folder name
 * needs a migration (src/migrate), so that existing nodes keep working.
 * Text templates use placeholders such as {{lane}}. The placeholders are filled
 * from `templateValues` below.
 */

export const program = 'factory';

/** The role words of help and template text. */
export const roles = {
  node: 'node',
  lane: 'lane',
  coordinator: 'coordinator',
  owner: 'owner',
  pack: 'pack',
} as const;

export const commands = {
  init: 'init',
  doctor: 'doctor',
  upgrade: 'upgrade',
  version: 'version',
  help: 'help',
} as const;

export const flags = {
  home: 'home',
  name: 'name',
  ownerName: 'owner-name',
  ownerGithub: 'owner-github',
  project: 'project',
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
  protocol: 'protocol.md',
  board: 'board.json',
  waiting: 'waiting.json',
  decisionLog: 'decision-log.json',
  gitignore: '.gitignore',
  briefsKeep: '.gitkeep',
  profileReadme: 'README-format.md',
  profileIndex: 'index.md',
  profileLog: 'log.md',
  openQuestions: 'open-questions.md',
  roadmapsReadme: 'README.md',
} as const;

export const dirs = {
  state: '.factory',
  profile: 'decision-profile',
  principles: 'principles',
  decisions: 'decisions',
  roadmaps: 'roadmaps',
  briefs: 'briefs',
  backups: 'backups',
  runtime: 'state',
  locks: 'locks',
  claude: '.claude',
} as const;

/** The settings files of Claude Code in a project: `<prefix>*<suffix>` inside the `.claude` folder. */
export const claudeSettings = { prefix: 'settings', suffix: '.json' } as const;

export const env = { proxyBaseUrl: 'ANTHROPIC_BASE_URL' } as const;

/** The keys of the config file. */
export const keys = {
  root: {
    schema: 'schema',
    node: 'node',
    owner: 'owner',
    session: 'session',
    proxies: 'proxies',
    lanes: 'lanes',
    limits: 'limits',
    projects: 'projects',
    children: 'children',
  },
  node: { id: 'id', role: 'role' },
  owner: { display: 'display', github: 'github', prefix: 'prefix' },
  session: { permissionMode: 'permission_mode', effort: 'effort', model: 'model', proxy: 'proxy' },
  proxy: { id: 'id', baseUrl: 'base_url', health: 'health', onFail: 'on_fail' },
  lane: { proxy: 'proxy' },
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
    pack: 'pack',
    gate: 'gate',
    heavyTest: 'heavy_test',
  },
  gate: { checks: 'checks' },
  child: { id: 'id', address: 'address' },
} as const;

/** The keys of the state file. */
export const stateKeys = {
  schemaVersion: 'schema_version',
  createdWith: 'created_with',
  blocks: 'blocks',
} as const;

/** The words that a config value can take. */
export const values = {
  role: roles.coordinator,
  permissionMode: 'auto',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  noProxy: 'none',
  onFail: ['stop', 'direct'],
  loadCpuCount: 'cpu_count',
  mergeMethods: ['squash', 'merge', 'rebase'],
  pack: 'plain',
} as const;

/** The ids of the checks that the doctor command runs. */
export const checkIds = {
  config: 'config',
  configVersion: 'config-version',
  state: 'state',
  blocks: 'blocks',
  secrets: 'secrets',
  permissionMode: 'permission-mode',
  proxyEnv: 'proxy-env',
  proxy: 'proxy',
  tools: 'tools',
  stateRepo: 'state-repo',
  projects: 'projects',
} as const;

export const blockNames = { coordinator: 'coordinator', safety: 'safety', protocol: 'protocol' } as const;

/** Markers of managed blocks: `<!-- factory:begin <name> v<n> sha256=<hex> -->` and `<!-- factory:end <name> -->`. */
export const marker = { prefix: `${program}:`, begin: 'begin', end: 'end', hash: 'sha256' } as const;

/** The ids of the JSON documents that commands print. */
export const schemaIds = {
  init: `${program}.init/v1`,
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

/** The values for the placeholders of the templates, for example {{lane}} and {{Lane}}. */
export const templateValues: Readonly<Record<string, string>> = {
  program,
  node: roles.node,
  lane: roles.lane,
  coordinator: roles.coordinator,
  owner: roles.owner,
  pack: roles.pack,
  configFile: files.config,
  stateDir: dirs.state,
  nodeFile: inState(files.nodeState),
  protocolFile: inState(files.protocol),
  boardFile: inState(files.board),
  waitingFile: inState(files.waiting),
  decisionLogFile: inState(files.decisionLog),
  profileDir: `${inState(dirs.profile)}/`,
  roadmapsDir: `${inState(dirs.roadmaps)}/`,
  briefsDir: `${inState(dirs.briefs)}/`,
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
