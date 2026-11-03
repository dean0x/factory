import { z } from 'zod';
import { checkFileAddress } from '../comms/address.js';
import type { SchemaParser } from '../migrate/inspect.js';
import { keys, prefixPlaceholders, values } from '../names.js';
import { recipes, type RecipeConfig } from '../recipes/index.js';
import { parseProxyUrl } from '../safety/proxy.js';
import { githubLogin, slug, uniqueIds } from './primitives.js';

export const CONFIG_SCHEMA_VERSION = 2;

/** A worker is layer 0 and has no node home. */
export const WORKER_LAYER = 0;

/** The layer of the node that manages workers. */
export const COORDINATOR_LAYER = 1;

/** The layer of the node that manages coordinators. It is the highest layer that has a role template. */
export const MANAGER_LAYER = 2;

/** The highest layer of a node. */
export const MAX_LAYER = 16;

const MAX_WORKERS = 200;
const MAX_CHILDREN = 200;
const MAX_TRACKER_TEXT = 200;
const MAX_INTERVAL_DIGITS = 6;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MAX_INTERVAL_HOURS = 24;

export const nodeSchema = z.strictObject({
  [keys.node.id]: slug,
  [keys.node.layer]: z.number().int().min(COORDINATOR_LAYER).max(MAX_LAYER),
});

const ownerSchema = z.strictObject({
  [keys.owner.display]: z.string().min(1).max(80),
  [keys.owner.github]: githubLogin.optional(),
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

const approvalSchema = z
  .strictObject({
    [keys.approval.land]: z
      .enum(values.landModes, { error: `must be one of: ${values.landModes.join(', ')}` })
      .default(values.landModes[0]),
  })
  .default({ [keys.approval.land]: values.landModes[0] });

/** `<n>m` or `<n>h`, from 1m to 24h. */
const WATCH_INTERVAL_PATTERN = new RegExp(`^([1-9][0-9]{0,${MAX_INTERVAL_DIGITS - 1}})([mh])$`);

const isWatchInterval = (text: string): boolean => {
  const match = WATCH_INTERVAL_PATTERN.exec(text);
  if (match === null) return false;
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount <= MAX_INTERVAL_HOURS : amount <= MAX_INTERVAL_MINUTES;
};

const trackerText = z.string().min(1).max(MAX_TRACKER_TEXT);

/** The local tracker keeps its items in the state folder, so it takes no other key. */
const localTrackerSchema = z.strictObject({ [keys.tracker.kind]: z.literal(values.trackerLocal) });

const hostedTrackerSchema = z.strictObject({
  [keys.tracker.kind]: z.enum(values.trackerHosted),
  [keys.tracker.items]: trackerText,
  [keys.tracker.decisions]: trackerText,
  [keys.tracker.watchInterval]: z
    .string()
    .refine(isWatchInterval, { error: 'must be <n>m or <n>h, from 1m to 24h' })
    .default(values.defaultWatchInterval),
});

const trackerSchema = z.discriminatedUnion(keys.tracker.kind, [localTrackerSchema, hostedTrackerSchema], {
  error: `must be one of: ${[values.trackerLocal, ...values.trackerHosted].join(', ')}`,
});

/** The address of another node. Only a file address on this machine is valid (F-13). */
const addressSchema = z.string().superRefine((value, ctx) => {
  const checked = checkFileAddress(value);
  if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.error });
});

const linkSchema = z.strictObject({ [keys.link.id]: slug, [keys.link.address]: addressSchema });

/** The core reads only the id of the recipe block. The recipe parser reads the rest. */
const recipeBlockSchema = z.looseObject({
  [keys.recipe.id]: z.enum(values.recipes, { error: `must be one of: ${values.recipes.join(', ')}` }),
});

const coreSchema = z
  .strictObject({
    [keys.root.schema]: z.literal(CONFIG_SCHEMA_VERSION),
    [keys.root.node]: nodeSchema,
    [keys.root.owner]: ownerSchema,
    [keys.root.session]: sessionSchema,
    [keys.root.proxies]: z.array(proxySchema).max(20).default([]),
    [keys.root.workers]: z
      .record(slug, z.strictObject({ [keys.worker.proxy]: slug }))
      .refine((workers) => Object.keys(workers).length <= MAX_WORKERS, { error: 'has too many entries' })
      .default({}),
    [keys.root.limits]: limitsSchema,
    [keys.root.approval]: approvalSchema,
    [keys.root.tracker]: trackerSchema,
    [keys.root.recipe]: recipeBlockSchema,
    [keys.root.parent]: linkSchema.nullable().default(null),
    [keys.root.children]: z.array(linkSchema).max(MAX_CHILDREN).default([]),
  })
  .superRefine((config, ctx) => {
    uniqueIds(ctx, [keys.root.proxies], keys.proxy.id, config.proxies);
    uniqueIds(ctx, [keys.root.children], keys.link.id, config.children);

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
    for (const [worker, override] of Object.entries(config.workers)) {
      checkRef(override.proxy, [keys.root.workers, worker, keys.worker.proxy]);
    }
  });

type ParsedCore = z.infer<typeof coreSchema>;

/** Every key of the config file except the inside of the `recipe` block. */
export type CoreConfig = Omit<ParsedCore, typeof keys.root.recipe>;

/** The config as the commands use it: the core, and the parsed block of the recipe. */
export interface FactoryConfig {
  readonly core: CoreConfig;
  readonly recipe: RecipeConfig;
}

export type ProxyConfig = z.infer<typeof proxySchema>;
export type TrackerConfig = z.infer<typeof trackerSchema>;
export type LinkConfig = z.infer<typeof linkSchema>;

/**
 * The schema of the whole config file, in two steps that each fail closed. The core parses every key
 * except the inside of the `recipe` block. Then the parser of the recipe that the core named parses the block.
 * An issue of the recipe has the path of the block in front, so it names the key in the file.
 */
export const configSchema: SchemaParser<FactoryConfig> = {
  safeParse: (raw) => {
    const core = coreSchema.safeParse(raw);
    if (!core.success) return { success: false, error: core.error };
    const { [keys.root.recipe]: block, ...rest } = core.data;
    const recipe = recipes[block.id].schema.safeParse(block);
    if (!recipe.success) {
      const issues = recipe.error.issues.map((issue) => ({ ...issue, path: [keys.root.recipe, ...issue.path] }));
      return { success: false, error: new z.ZodError(issues) };
    }
    return { success: true, data: { core: rest, recipe: recipe.data } };
  },
};
