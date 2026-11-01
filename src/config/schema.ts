import { posix } from 'node:path';
import { z } from 'zod';
import { keys, prefixPlaceholders, roles, values } from '../names.js';
import { parseProxyUrl } from '../safety/proxy.js';

export const CONFIG_SCHEMA_VERSION = 1;

/** The highest layer of a node. A cell is layer 0 and has no node home. */
export const MAX_LAYER = 16;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SLUG_RULE = 'must be a slug: a-z, 0-9 and hyphen, at most 40 characters, no leading hyphen';
const MAX_SLUG_LENGTH = 40;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export const isGithubLogin = (text: string): boolean => GITHUB_LOGIN_PATTERN.test(text);

export const isSlug = (text: string): boolean => SLUG_PATTERN.test(text);

export const isBranchName = (text: string): boolean => BRANCH_PATTERN.test(text);

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
  [keys.node.id]: slug,
  [keys.node.layer]: z.number().int().min(1).max(MAX_LAYER),
});

const ownerSchema = z.strictObject({
  [keys.owner.display]: z.string().min(1).max(80),
  [keys.owner.github]: z
    .string()
    .regex(GITHUB_LOGIN_PATTERN, 'must be a GitHub login')
    .optional(),
  [keys.owner.prefix]: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]+$/, 'must be one line')
    .refine((value) => value.includes(prefixPlaceholders.owner), {
      error: `must contain ${prefixPlaceholders.owner}`,
    }),
});

const sessionSchema = z.strictObject({
  [keys.session.permissionMode]: z.literal(values.permissionMode, {
    error: `must be ${values.permissionMode}: every session runs in ${values.permissionMode} mode`,
  }),
  [keys.session.effort]: z.enum(values.efforts, { error: `must be one of: ${values.efforts.join(', ')}` }),
  [keys.session.model]: z.string().min(1).max(80),
  [keys.session.proxy]: slug,
});

const proxySchema = z.strictObject({
  [keys.proxy.id]: slug,
  [keys.proxy.baseUrl]: z.string().superRefine((value, ctx) => {
    const parsed = parseProxyUrl(value);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error });
  }),
  [keys.proxy.health]: z.string().regex(/^\/(?!\/)[^\s?#]*$/, 'must be a path that starts with /, with no query'),
  [keys.proxy.onFail]: z
    .enum(values.onFail, { error: `must be one of: ${values.onFail.join(', ')}` })
    .default(values.onFail[0]),
});

const limitsSchema = z
  .strictObject({
    [keys.limits.memoryFreeMinPct]: z.number().min(0).max(90),
    [keys.limits.diskFreeMinGb]: z.number().min(0).max(10_000),
    [keys.limits.loadMax]: z.union([z.literal(values.loadCpuCount), z.number().positive().max(1024)], {
      error: `must be ${values.loadCpuCount} or a positive number`,
    }),
    [keys.limits.contextPreparePct]: z.number().int().min(1).max(100),
    [keys.limits.contextMaxPct]: z.number().int().min(1).max(100),
  })
  .refine((limits) => limits.context_prepare_pct < limits.context_max_pct, {
    error: `${keys.limits.contextPreparePct} must be less than ${keys.limits.contextMaxPct}`,
    path: [keys.limits.contextPreparePct],
  });

const projectSchema = z.strictObject({
  [keys.project.id]: slug,
  [keys.project.repo]: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, `must look like ${roles.owner}/name`)
    .optional(),
  [keys.project.path]: z
    .string()
    .min(1)
    .max(4096)
    .refine(isProjectPath, {
      error: `must be a relative path that does not leave the parent folder of the ${roles.node} home`,
    }),
  [keys.project.defaultBranch]: z.string().regex(BRANCH_PATTERN, 'must be a branch name'),
  [keys.project.mergeMethod]: z.enum(values.mergeMethods, {
    error: `must be one of: ${values.mergeMethods.join(', ')}`,
  }),
  [keys.project.variant]: z.enum(values.variants, { error: `must be one of: ${values.variants.join(', ')}` }),
  [keys.project.gate]: z.strictObject({ [keys.gate.checks]: z.array(z.string().min(1).max(500)).max(50) }),
  [keys.project.heavyTest]: z.string().min(1).max(500).optional(),
});

const childSchema = z.strictObject({
  [keys.child.id]: slug,
  [keys.child.address]: z.string().min(1).max(500),
});

const uniqueIds = (
  ctx: z.RefinementCtx,
  key: string,
  idKey: string,
  items: readonly { readonly id: string }[],
): void => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate id', path: [key, index, idKey] });
    }
    seen.add(item.id);
  });
};

export const configSchema = z
  .strictObject({
    [keys.root.schema]: z.literal(CONFIG_SCHEMA_VERSION),
    [keys.root.node]: nodeSchema,
    [keys.root.owner]: ownerSchema,
    [keys.root.session]: sessionSchema,
    [keys.root.proxies]: z.array(proxySchema).max(20).default([]),
    [keys.root.cells]: z
      .record(slug, z.strictObject({ [keys.cell.proxy]: slug }))
      .refine((cells) => Object.keys(cells).length <= 200, { error: 'has too many entries' })
      .default({}),
    [keys.root.limits]: limitsSchema,
    [keys.root.projects]: z.array(projectSchema).max(100),
    [keys.root.children]: z.array(childSchema).max(100).default([]),
  })
  .superRefine((config, ctx) => {
    uniqueIds(ctx, keys.root.proxies, keys.proxy.id, config.proxies);
    uniqueIds(ctx, keys.root.projects, keys.project.id, config.projects);
    uniqueIds(ctx, keys.root.children, keys.child.id, config.children);

    const proxyIds = new Set(config.proxies.map((proxy) => proxy.id));
    config.proxies.forEach((proxy, index) => {
      if (proxy.id === values.noProxy) {
        ctx.addIssue({
          code: 'custom',
          message: `${values.noProxy} is reserved`,
          path: [keys.root.proxies, index, keys.proxy.id],
        });
      }
    });
    const checkRef = (value: string, path: (string | number)[]): void => {
      if (value !== values.noProxy && !proxyIds.has(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `names a proxy that is not defined in ${keys.root.proxies}`,
          path,
        });
      }
    };
    checkRef(config.session.proxy, [keys.root.session, keys.session.proxy]);
    for (const [cell, override] of Object.entries(config.cells)) {
      checkRef(override.proxy, [keys.root.cells, cell, keys.cell.proxy]);
    }
  });

export type FactoryConfig = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type ProxyConfig = z.infer<typeof proxySchema>;
