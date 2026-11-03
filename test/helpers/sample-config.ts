import { renderConfig } from '../../src/config/render.js';
import { parseConfig, splitConfigValue, type FactoryConfig } from '../../src/config/schema.js';
import { describeIssues } from '../../src/core/zod.js';
import { files, values } from '../../src/names.js';
import { ownerModes, recipes } from '../../src/recipes/index.js';
import type { FakeDeps } from './fake-deps.js';

export const sampleConfig = (): FactoryConfig => ({
  core: {
    node: { id: 'demo', layer: 1 },
    owner: {
      display: 'Test Owner',
      prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]",
    },
    session: { permission_mode: 'auto', effort: 'high', model: 'default', proxy: 'none', statusline: null },
    proxies: [],
    workers: {},
    limits: {
      memory_free_min_pct: 20,
      disk_free_min_gb: 20,
      load_max: 'cpu_count',
      context_prepare_pct: 30,
      context_max_pct: 40,
    },
    approval: ownerModes(recipes[values.recipes[0]].approvalPoints),
    tracker: { kind: 'local' },
    parent: null,
    children: [],
    sources: {},
  },
  recipe: {
    id: 'software',
    variant: 'plain',
    projects: [
      {
        id: 'web',
        url: 'https://github.com/acme/web.git',
        path: 'web',
        default_branch: 'main',
        merge_method: 'squash',
        gate: { checks: [] },
      },
    ],
  },
});

/**
 * The document as a person writes it when both config files are in one mapping: the keys of the shared file and of
 * the local file together. `splitConfigValue` tells the two files apart.
 */
export const sampleObject = (): Record<string, any> => {
  const { core, recipe } = sampleConfig();
  return JSON.parse(JSON.stringify({ schema: 2, ...core, recipe })) as Record<string, any>;
};

/** The shared file and the local file of a mixed document, as raw values. */
export const sampleFiles = (mixed: Record<string, any> = sampleObject()): { shared: Record<string, any>; local: Record<string, any> } =>
  splitConfigValue(mixed) as { shared: Record<string, any>; local: Record<string, any> };

/** Parse a mixed document: split it into the two files, parse both and merge them. */
export const parseMixed = (mixed: unknown): ReturnType<typeof parseConfig> => {
  const { shared, local } = splitConfigValue(mixed);
  return parseConfig(shared, local);
};

/** The merged config of a mixed document. It throws with the issues when the document is not valid. */
export const configOfMixed = (mixed: unknown): FactoryConfig => {
  const parsed = parseMixed(mixed);
  if (!parsed.success) throw new Error(`${parsed.file}: ${describeIssues(parsed.error)}`);
  return parsed.data;
};

/** Write both config files of a node into the fake file system. The local file gets no mode, so it counts as mode 600. */
export const seedConfig = (deps: FakeDeps, root: string, config: FactoryConfig = sampleConfig()): void => {
  const texts = renderConfig(config);
  deps.seed(`${root}/${files.config}`, texts.shared);
  deps.seed(`${root}/${files.localConfig}`, texts.local);
};
