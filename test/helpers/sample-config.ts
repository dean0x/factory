import type { FactoryConfig } from '../../src/config/schema.js';

export const sampleConfig = (): FactoryConfig => ({
  core: {
    schema: 2,
    node: { id: 'demo', layer: 1 },
    owner: {
      display: 'Test Owner',
      prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]",
    },
    session: { permission_mode: 'auto', effort: 'high', model: 'default', proxy: 'none' },
    proxies: [],
    cells: {},
    limits: {
      memory_free_min_pct: 20,
      disk_free_min_gb: 20,
      load_max: 'cpu_count',
      context_prepare_pct: 30,
      context_max_pct: 40,
    },
    approval: { land: 'each' },
    tracker: { kind: 'local' },
    parent: null,
    children: [],
  },
  recipe: {
    id: 'software',
    variant: 'plain',
    projects: [
      {
        id: 'web',
        path: '../web',
        default_branch: 'main',
        merge_method: 'squash',
        gate: { checks: [] },
      },
    ],
  },
});

/** The document as a person writes it in the config file: the core keys and the recipe block in one mapping. */
export const sampleObject = (): Record<string, any> => {
  const { core, recipe } = sampleConfig();
  return JSON.parse(JSON.stringify({ ...core, recipe })) as Record<string, any>;
};
