import { address, capitalize, files, keys, program, roles, values } from '../names.js';
import type { RecipeConfig } from '../recipes/index.js';
import type { ProjectConfig } from '../recipes/software/config.js';
import {
  CONFIG_SCHEMA_VERSION,
  LOCAL_SCHEMA_VERSION,
  localOf,
  sharedOf,
  type FactoryConfig,
  type LinkConfig,
  type LocalConfig,
  type ProxyConfig,
  type SharedConfig,
  type TrackerConfig,
} from './schema.js';

/** The words that a YAML reader takes for a boolean or a null. */
const YAML_WORDS = /^(?:true|false|null|yes|no|on|off|y|n)$/;

/** A plain scalar when it is safe, else a double-quoted one (JSON strings are valid YAML). */
const scalar = (value: string): string =>
  /^[a-z][a-z0-9-]*$/.test(value) && !YAML_WORDS.test(value) ? value : JSON.stringify(value);

const quoted = (value: string): string => JSON.stringify(value);

const pad = (depth: number): string => '  '.repeat(depth);

const entry = (depth: number, key: string, value: string | number, comment?: string): string =>
  `${pad(depth)}${key}: ${value}${comment === undefined ? '' : `    # ${comment}`}`;

const itemEntry = (depth: number, key: string, value: string): string => `${pad(depth)}- ${key}: ${value}`;

const proxyLines = (proxy: ProxyConfig): string[] => [
  itemEntry(1, keys.proxy.id, scalar(proxy.id)),
  entry(2, keys.proxy.baseUrl, quoted(proxy.base_url)),
  entry(2, keys.proxy.health, quoted(proxy.health)),
  entry(2, keys.proxy.onFail, proxy.on_fail),
];

const gateLines = (depth: number, checks: readonly string[]): string[] =>
  checks.length === 0
    ? [`${pad(depth)}${keys.project.gate}: { ${keys.gate.checks}: [] }`]
    : [
        `${pad(depth)}${keys.project.gate}:`,
        `${pad(depth + 1)}${keys.gate.checks}:`,
        ...checks.map((check) => `${pad(depth + 2)}- ${quoted(check)}`),
      ];

/** The lines of one project. `depth` is the depth of the list item. */
const projectLines = (project: ProjectConfig, depth: number): string[] => [
  itemEntry(depth, keys.project.id, scalar(project.id)),
  ...(project.repo === undefined ? [] : [entry(depth + 1, keys.project.repo, quoted(project.repo))]),
  entry(depth + 1, keys.project.path, quoted(project.path)),
  entry(depth + 1, keys.project.defaultBranch, quoted(project.default_branch)),
  entry(depth + 1, keys.project.mergeMethod, project.merge_method),
  ...(project.variant === undefined ? [] : [entry(depth + 1, keys.project.variant, project.variant)]),
  ...gateLines(depth + 1, project.gate.checks),
  ...(project.heavy_test === undefined ? [] : [entry(depth + 1, keys.project.heavyTest, quoted(project.heavy_test))]),
];

const section = (depth: number, name: string, items: readonly string[][]): string[] =>
  items.length === 0 ? [`${pad(depth)}${name}: []`] : [`${pad(depth)}${name}:`, ...items.flat()];

const trackerLines = (tracker: TrackerConfig): string[] =>
  tracker.kind === values.trackerLocal
    ? [entry(1, keys.tracker.kind, tracker.kind, 'the items and the decisions stay in the state folder')]
    : [
        entry(1, keys.tracker.kind, tracker.kind),
        entry(1, keys.tracker.items, quoted(tracker.items), 'where the work items live'),
        entry(1, keys.tracker.decisions, quoted(tracker.decisions), `where the decisions of the ${roles.owner} live`),
        entry(1, keys.tracker.watchInterval, tracker.watch_interval),
      ];

/** The `recipe` block. A recipe renders its own keys. */
const recipeLines = (recipe: RecipeConfig): string[] => [
  `${keys.root.recipe}:`,
  entry(1, keys.recipe.id, recipe.id),
  entry(1, keys.recipe.variant, recipe.variant, `the default ${roles.variant} for every project`),
  `${pad(1)}# Each project path is relative to this folder.`,
  ...section(1, keys.recipe.projects, recipe.projects.map((project) => projectLines(project, 2))),
];

const childLines = (link: LinkConfig): string[] => [
  itemEntry(1, keys.link.id, scalar(link.id)),
  entry(2, keys.link.address, quoted(link.address)),
];

const parentLines = (link: LinkConfig | null): string[] =>
  link === null
    ? [`${keys.root.parent}: null`]
    : [
        `${keys.root.parent}:`,
        entry(1, keys.link.id, scalar(link.id)),
        entry(1, keys.link.address, quoted(link.address)),
      ];

const sourceLines = (sources: Readonly<Record<string, string>>): string[] => {
  const rows = Object.entries(sources);
  return rows.length === 0
    ? [`${keys.root.sources}: {}`]
    : [`${keys.root.sources}:`, ...rows.map(([path, source]) => `${pad(1)}${quoted(path)}: ${quoted(source)}`)];
};

/** The text of the shared file, with comments. Git tracks the file, and it travels to every machine. */
export const renderSharedConfig = (shared: SharedConfig): string => {
  const { core, recipe } = shared;
  const lines: string[] = [
    `# ${files.config}: the shared configuration of this ${roles.node}. Git tracks it, and it goes to every machine.`,
    `# Do not put keys, tokens or passwords here. What is personal or true for one machine only is in ${files.localConfig}.`,
    entry(0, keys.root.schema, CONFIG_SCHEMA_VERSION),
    '',
    `${keys.root.node}:`,
    entry(1, keys.node.id, scalar(core.node.id), 'also the name of the tmux session'),
    entry(1, keys.node.layer, core.node.layer, `the layer sets the role: layer 1 is the ${roles.coordinator} of the ${roles.worker}s`),
    '',
    `${keys.root.session}:`,
    entry(1, keys.session.permissionMode, core.session.permission_mode, 'the only accepted value'),
    entry(1, keys.session.effort, core.session.effort),
    entry(1, keys.session.model, scalar(core.session.model)),
    '',
    `${keys.root.limits}:`,
    entry(1, keys.limits.memoryFreeMinPct, core.limits.memory_free_min_pct),
    entry(1, keys.limits.diskFreeMinGb, core.limits.disk_free_min_gb),
    entry(
      1,
      keys.limits.loadMax,
      typeof core.limits.load_max === 'number' ? core.limits.load_max : values.loadCpuCount,
    ),
    entry(1, keys.limits.contextPreparePct, core.limits.context_prepare_pct),
    entry(1, keys.limits.contextMaxPct, core.limits.context_max_pct),
    '',
    `${keys.root.tracker}:`,
    ...trackerLines(core.tracker),
    '',
    ...recipeLines(recipe),
  ];
  return `${lines.join('\n')}\n`;
};

/** The text of the local file, with comments. Git ignores the file, and it has mode 600. */
export const renderLocalConfig = (local: LocalConfig): string => {
  const workers = Object.entries(local.workers);
  const approval = Object.entries(local.approval);
  const lines: string[] = [
    `# ${files.localConfig}: the configuration of one person on this machine. Git ignores it.`,
    '# People edit this file. Do not put keys, tokens or passwords here.',
    entry(0, keys.root.schema, LOCAL_SCHEMA_VERSION),
    '',
    `${keys.root.owner}:`,
    entry(1, keys.owner.display, quoted(local.owner.display)),
    ...(local.owner.github === undefined ? [] : [entry(1, keys.owner.github, quoted(local.owner.github))]),
    `${pad(1)}# Input that starts with this prefix carries the authority of the ${roles.owner}.`,
    entry(1, keys.owner.prefix, quoted(local.owner.prefix)),
    '',
    `${keys.root.session}:`,
    entry(
      1,
      keys.session.proxy,
      scalar(local.session.proxy),
      `${values.noProxy}, or the id of an entry in ${keys.root.proxies}`,
    ),
    entry(
      1,
      keys.session.statusline,
      local.session.statusline === null ? 'null' : quoted(local.session.statusline),
      `the command of your own status line, or null`,
    ),
    '',
    `# A session uses a proxy only when the config names it. ${capitalize(program)} checks the proxy before each launch.`,
    ...section(0, keys.root.proxies, local.proxies.map(proxyLines)),
    '',
    `# Overrides for single ${roles.worker}s: <${roles.worker} id>: { ${keys.worker.proxy}: ${values.noProxy} }`,
    ...(workers.length === 0
      ? [`${keys.root.workers}: {}`]
      : [
          `${keys.root.workers}:`,
          ...workers.map(
            ([worker, override]) => `${pad(1)}${scalar(worker)}: { ${keys.worker.proxy}: ${scalar(override.proxy)} }`,
          ),
        ]),
    '',
    `# The mode of each approval point of the ${roles.recipe}: ${values.approvalModes.join(' or ')}.`,
    `# A point that is not named waits for the ${roles.owner}.`,
    ...(approval.length === 0
      ? [`${keys.root.approval}: {}`]
      : [`${keys.root.approval}:`, ...approval.map(([point, mode]) => entry(1, scalar(point), mode))]),
    '',
    `# The local folder of a project that has no URL to share, by project path.`,
    ...sourceLines(local.sources),
    '',
    `# The ${roles.node} above this one, or null. The address is a ${address.scheme} address on this machine.`,
    ...parentLines(local.parent),
    '',
    ...section(0, keys.root.children, local.children.map(childLines)),
  ];
  return `${lines.join('\n')}\n`;
};

/** The texts of the two config files for a typed config. */
export const renderConfig = (config: FactoryConfig): { readonly shared: string; readonly local: string } => ({
  shared: renderSharedConfig(sharedOf(config)),
  local: renderLocalConfig(localOf(config)),
});
