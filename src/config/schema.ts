import { posix } from 'node:path';
import { z } from 'zod';
import { parseProxyUrl } from '../safety/proxy.js';

export const CONFIG_SCHEMA_VERSION = 1;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG_RULE = 'must be a slug: a-z, 0-9 and hyphen, at most 40 characters, no leading hyphen';
const MAX_SLUG_LENGTH = 40;

export const isSlug = (text: string): boolean => SLUG_PATTERN.test(text);

/** Make a slug from free text, or null when nothing is left. */
export const slugify = (text: string): string | null => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? null : slug;
};

const slug = z.string().regex(SLUG_PATTERN, SLUG_RULE);

const isProjectPath = (value: string): boolean => {
  if (value.includes('\0') || value.includes('\\') || value.startsWith('~') || posix.isAbsolute(value)) {
    return false;
  }
  return posix.normalize(value).split('/').filter((part) => part === '..').length <= 1;
};

const nodeSchema = z.strictObject({
  id: slug,
  role: z.literal('coordinator'),
});

const ownerSchema = z.strictObject({
  display: z.string().min(1).max(80),
  github: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, 'must be a GitHub login')
    .optional(),
  prefix: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]+$/, 'must be one line')
    .refine((value) => value.includes('{owner}'), { error: 'must contain {owner}' }),
});

const sessionSchema = z.strictObject({
  permission_mode: z.literal('auto', { error: 'must be auto: factory runs every session in auto mode' }),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max'], {
    error: 'must be one of: low, medium, high, xhigh, max',
  }),
  model: z.string().min(1).max(80),
  proxy: slug,
});

const proxySchema = z.strictObject({
  id: slug,
  base_url: z.string().superRefine((value, ctx) => {
    const parsed = parseProxyUrl(value);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error });
  }),
  health: z.string().regex(/^\/(?!\/)[^\s?#]*$/, 'must be a path that starts with /, with no query'),
  on_fail: z.enum(['stop', 'direct'], { error: 'must be stop or direct' }).default('stop'),
});

const limitsSchema = z
  .strictObject({
    memory_free_min_pct: z.number().min(0).max(90),
    disk_free_min_gb: z.number().min(0).max(10_000),
    load_max: z.union([z.literal('cpu_count'), z.number().positive().max(1024)], {
      error: 'must be cpu_count or a positive number',
    }),
    context_prepare_pct: z.number().int().min(1).max(100),
    context_max_pct: z.number().int().min(1).max(100),
  })
  .refine((limits) => limits.context_prepare_pct < limits.context_max_pct, {
    error: 'context_prepare_pct must be less than context_max_pct',
    path: ['context_prepare_pct'],
  });

const projectSchema = z.strictObject({
  id: slug,
  repo: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, 'must look like owner/name')
    .optional(),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(isProjectPath, {
      error: 'must be a relative path that does not leave the parent folder of the node home',
    }),
  default_branch: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, 'must be a branch name'),
  merge_method: z.enum(['squash', 'merge', 'rebase'], { error: 'must be squash, merge or rebase' }),
  pack: z.literal('plain', { error: 'must be plain' }),
  gate: z.strictObject({ checks: z.array(z.string().min(1).max(500)).max(50) }),
  heavy_test: z.string().min(1).max(500).optional(),
});

const childSchema = z.strictObject({
  id: slug,
  address: z.string().min(1).max(500),
});

const uniqueIds = (
  ctx: z.RefinementCtx,
  key: string,
  items: readonly { readonly id: string }[],
): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate id', path: [key, index, 'id'] });
    }
    seen.add(item.id);
  });
};

export const configSchema = z
  .strictObject({
    schema: z.literal(CONFIG_SCHEMA_VERSION),
    node: nodeSchema,
    owner: ownerSchema,
    session: sessionSchema,
    proxies: z.array(proxySchema).max(20).default([]),
    lanes: z
      .record(slug, z.strictObject({ proxy: slug }))
      .refine((lanes) => Object.keys(lanes).length <= 200, { error: 'has too many lanes' })
      .default({}),
    limits: limitsSchema,
    projects: z.array(projectSchema).max(100),
    children: z.array(childSchema).max(100).default([]),
  })
  .superRefine((config, ctx) => {
    uniqueIds(ctx, 'proxies', config.proxies);
    uniqueIds(ctx, 'projects', config.projects);
    uniqueIds(ctx, 'children', config.children);

    const proxyIds = new Set(config.proxies.map((proxy) => proxy.id));
    config.proxies.forEach((proxy, index) => {
      if (proxy.id === 'none') {
        ctx.addIssue({ code: 'custom', message: 'none is reserved', path: ['proxies', index, 'id'] });
      }
    });
    const checkRef = (value: string, path: (string | number)[]): void => {
      if (value !== 'none' && !proxyIds.has(value)) {
        ctx.addIssue({ code: 'custom', message: 'names a proxy that is not defined in proxies', path });
      }
    };
    checkRef(config.session.proxy, ['session', 'proxy']);
    for (const [lane, override] of Object.entries(config.lanes)) {
      checkRef(override.proxy, ['lanes', lane, 'proxy']);
    }
  });

export type FactoryConfig = z.infer<typeof configSchema>;
export type ProjectConfig = FactoryConfig['projects'][number];
export type ProxyConfig = FactoryConfig['proxies'][number];

