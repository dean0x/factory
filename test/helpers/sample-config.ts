import type { FactoryConfig } from '../../src/config/schema.js';

export const sampleConfig = (): FactoryConfig => ({
  schema: 1,
  node: { id: 'demo', role: 'coordinator' },
  owner: {
    display: 'Test Owner',
    prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]",
  },
  session: { permission_mode: 'auto', effort: 'high', model: 'default', proxy: 'none' },
  proxies: [],
  lanes: {},
  limits: {
    memory_free_min_pct: 20,
    disk_free_min_gb: 20,
    load_max: 'cpu_count',
    context_prepare_pct: 30,
    context_max_pct: 40,
  },
  projects: [
    {
      id: 'web',
      path: '../web',
      default_branch: 'main',
      merge_method: 'squash',
      pack: 'plain',
      gate: { checks: [] },
    },
  ],
  children: [],
});

export const sampleObject = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(sampleConfig())) as Record<string, unknown>;
