import { capitalize, files, keys, program, roles, values } from '../names.js';
import type { FactoryConfig, ProjectConfig, ProxyConfig } from './schema.js';

const YAML_WORDS: readonly string[] = ['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n'];

/** A plain scalar when it is safe, else a double-quoted one (JSON strings are valid YAML). */
const scalar = (value: string): string =>
  /^[a-z][a-z0-9-]*$/.test(value) && !YAML_WORDS.includes(value) ? value : JSON.stringify(value);

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

const gateLines = (checks: readonly string[]): string[] =>
  checks.length === 0
    ? [`${pad(2)}${keys.project.gate}: { ${keys.gate.checks}: [] }`]
    : [
        `${pad(2)}${keys.project.gate}:`,
        `${pad(3)}${keys.gate.checks}:`,
        ...checks.map((check) => `${pad(4)}- ${quoted(check)}`),
      ];

const projectLines = (project: ProjectConfig): string[] => [
  itemEntry(1, keys.project.id, scalar(project.id)),
  ...(project.repo === undefined ? [] : [entry(2, keys.project.repo, quoted(project.repo))]),
  entry(2, keys.project.path, quoted(project.path)),
  entry(2, keys.project.defaultBranch, quoted(project.default_branch)),
  entry(2, keys.project.mergeMethod, project.merge_method),
  entry(2, keys.project.pack, project.pack),
  ...gateLines(project.gate.checks),
  ...(project.heavy_test === undefined ? [] : [entry(2, keys.project.heavyTest, quoted(project.heavy_test))]),
];

const section = (name: string, items: readonly string[][]): string[] =>
  items.length === 0 ? [`${name}: []`] : [`${name}:`, ...items.flat()];

/** The text of the config file, with comments, for a typed config. */
export const renderConfig = (config: FactoryConfig): string => {
  const lanes = Object.entries(config.lanes);
  const lines: string[] = [
    `# ${files.config}: the configuration of this ${roles.node}.`,
    '# People edit this file. Do not put keys, tokens or passwords here.',
    entry(0, keys.root.schema, config.schema),
    '',
    `${keys.root.node}:`,
    entry(1, keys.node.id, scalar(config.node.id), 'also the name of the tmux session'),
    entry(1, keys.node.role, config.node.role),
    '',
    `${keys.root.owner}:`,
    entry(1, keys.owner.display, quoted(config.owner.display)),
    ...(config.owner.github === undefined ? [] : [entry(1, keys.owner.github, quoted(config.owner.github))]),
    `${pad(1)}# Input that starts with this prefix carries the authority of the ${roles.owner}.`,
    entry(1, keys.owner.prefix, quoted(config.owner.prefix)),
    '',
    `${keys.root.session}:`,
    entry(1, keys.session.permissionMode, config.session.permission_mode, 'the only accepted value'),
    entry(1, keys.session.effort, config.session.effort),
    entry(1, keys.session.model, scalar(config.session.model)),
    entry(
      1,
      keys.session.proxy,
      scalar(config.session.proxy),
      `${values.noProxy}, or the id of an entry in ${keys.root.proxies}`,
    ),
    '',
    `# A session uses a proxy only when the config names it. ${capitalize(program)} checks the proxy before each launch.`,
    ...section(keys.root.proxies, config.proxies.map(proxyLines)),
    '',
    `# Overrides for single ${roles.lane}s: <${roles.lane} id>: { ${keys.lane.proxy}: ${values.noProxy} }`,
    ...(lanes.length === 0
      ? [`${keys.root.lanes}: {}`]
      : [
          `${keys.root.lanes}:`,
          ...lanes.map(
            ([lane, override]) => `${pad(1)}${scalar(lane)}: { ${keys.lane.proxy}: ${scalar(override.proxy)} }`,
          ),
        ]),
    '',
    `${keys.root.limits}:`,
    entry(1, keys.limits.memoryFreeMinPct, config.limits.memory_free_min_pct),
    entry(1, keys.limits.diskFreeMinGb, config.limits.disk_free_min_gb),
    entry(
      1,
      keys.limits.loadMax,
      typeof config.limits.load_max === 'number' ? config.limits.load_max : values.loadCpuCount,
    ),
    entry(1, keys.limits.contextPreparePct, config.limits.context_prepare_pct),
    entry(1, keys.limits.contextMaxPct, config.limits.context_max_pct),
    '',
    '# Each project path is relative to this folder.',
    ...section(keys.root.projects, config.projects.map(projectLines)),
    '',
    ...section(
      keys.root.children,
      config.children.map((child) => [
        itemEntry(1, keys.child.id, scalar(child.id)),
        entry(2, keys.child.address, quoted(child.address)),
      ]),
    ),
  ];
  return `${lines.join('\n')}\n`;
};
