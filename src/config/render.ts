import type { FactoryConfig, ProjectConfig, ProxyConfig } from './schema.js';

const YAML_WORDS: readonly string[] = ['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n'];

/** A plain scalar when it is safe, else a double-quoted one (JSON strings are valid YAML). */
const scalar = (value: string): string =>
  /^[a-z][a-z0-9-]*$/.test(value) && !YAML_WORDS.includes(value) ? value : JSON.stringify(value);

const quoted = (value: string): string => JSON.stringify(value);

const proxyLines = (proxy: ProxyConfig): string[] => [
  `  - id: ${scalar(proxy.id)}`,
  `    base_url: ${quoted(proxy.base_url)}`,
  `    health: ${quoted(proxy.health)}`,
  `    on_fail: ${proxy.on_fail}`,
];

const projectLines = (project: ProjectConfig): string[] => [
  `  - id: ${scalar(project.id)}`,
  ...(project.repo === undefined ? [] : [`    repo: ${quoted(project.repo)}`]),
  `    path: ${quoted(project.path)}`,
  `    default_branch: ${quoted(project.default_branch)}`,
  `    merge_method: ${project.merge_method}`,
  `    pack: ${project.pack}`,
  project.gate.checks.length === 0
    ? '    gate: { checks: [] }'
    : ['    gate:', '      checks:', ...project.gate.checks.map((check) => `        - ${quoted(check)}`)].join('\n'),
  ...(project.heavy_test === undefined ? [] : [`    heavy_test: ${quoted(project.heavy_test)}`]),
];

const section = (name: string, items: readonly string[][]): string[] =>
  items.length === 0 ? [`${name}: []`] : [`${name}:`, ...items.flat()];

/** The text of factory.yaml, with comments, for a typed config. */
export const renderConfig = (config: FactoryConfig): string => {
  const lanes = Object.entries(config.lanes);
  const lines: string[] = [
    '# factory.yaml: the configuration of this node.',
    '# People edit this file. Do not put keys, tokens or passwords here.',
    `schema: ${config.schema}`,
    '',
    'node:',
    `  id: ${scalar(config.node.id)}    # also the name of the tmux session`,
    `  role: ${config.node.role}`,
    '',
    'owner:',
    `  display: ${quoted(config.owner.display)}`,
    ...(config.owner.github === undefined ? [] : [`  github: ${quoted(config.owner.github)}`]),
    '  # Input that starts with this prefix carries the authority of the owner.',
    `  prefix: ${quoted(config.owner.prefix)}`,
    '',
    'session:',
    `  permission_mode: ${config.session.permission_mode}    # the only accepted value`,
    `  effort: ${config.session.effort}`,
    `  model: ${scalar(config.session.model)}`,
    `  proxy: ${scalar(config.session.proxy)}    # none, or the id of an entry in proxies`,
    '',
    '# A session uses a proxy only when the config names it. Factory checks the proxy before each launch.',
    ...section('proxies', config.proxies.map(proxyLines)),
    '',
    '# Overrides for single lanes: <lane id>: { proxy: none }',
    ...(lanes.length === 0
      ? ['lanes: {}']
      : ['lanes:', ...lanes.map(([lane, override]) => `  ${scalar(lane)}: { proxy: ${scalar(override.proxy)} }`)]),
    '',
    'limits:',
    `  memory_free_min_pct: ${config.limits.memory_free_min_pct}`,
    `  disk_free_min_gb: ${config.limits.disk_free_min_gb}`,
    `  load_max: ${typeof config.limits.load_max === 'number' ? config.limits.load_max : 'cpu_count'}`,
    `  context_prepare_pct: ${config.limits.context_prepare_pct}`,
    `  context_max_pct: ${config.limits.context_max_pct}`,
    '',
    '# Each project path is relative to this folder.',
    ...section('projects', config.projects.map(projectLines)),
    '',
    ...section(
      'children',
      config.children.map((child) => [`  - id: ${scalar(child.id)}`, `    address: ${quoted(child.address)}`]),
    ),
  ];
  return `${lines.join('\n')}\n`;
};
