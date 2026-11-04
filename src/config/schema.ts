import { z } from 'zod';
import { checkFileAddress } from '../comms/address.js';
import { isRecord, type SchemaParser } from '../migrate/inspect.js';
import {
  commands,
  commandText,
  files,
  keys,
  layers,
  prefixPlaceholders,
  roles,
  schema2,
  values,
} from '../names.js';
import { checkLocalSource, describeCloneIssue } from '../core/clone-url.js';
import {
  findRecipe,
  ownerModes,
  recipeIds,
  type ApprovalModes,
  type RecipeConfig,
  type RecipeEntry,
  type RecipeRegistry,
} from '../recipes/index.js';
import { parseProxyUrl } from '../safety/proxy.js';
import { folderKey, githubLogin, slug, uniqueIds } from './primitives.js';

/** The version of the shared file, `factory.yaml`. */
export const CONFIG_SCHEMA_VERSION = 2;

/** The first version of the shared file with a local file next to it. Schema 1 held the keys of both files in one file. */
export const SPLIT_SCHEMA_VERSION = 2;

/** The version of the local file, `factory.local.yaml`. Each file has its own version. */
export const LOCAL_SCHEMA_VERSION = 1;

/** A worker is layer 0 and has no node home. */
export const WORKER_LAYER = layers.worker;

/** The layer of the node that manages workers. */
export const COORDINATOR_LAYER = layers.coordinator;

/** The layer of the node that manages coordinators. It is the highest layer that has a role template. */
export const MANAGER_LAYER = layers.manager;

/** The highest layer of a node. */
export const MAX_LAYER = layers.max;

const MAX_WORKERS = 200;
const MAX_CHILDREN = 200;
const MAX_TRACKER_TEXT = 200;
const MAX_STATUSLINE_CHARS = 1000;
const MAX_SOURCES = 200;
const MAX_SOURCE_KEY_CHARS = 200;
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

/** The way of working of the sessions. It is shared: every machine runs the same way. */
const sharedSessionSchema = z.strictObject({
  [keys.session.permissionMode]: z.literal(values.permissionMode, {
    error: `must be ${values.permissionMode}: every session runs in ${values.permissionMode} mode`,
  }),
  [keys.session.effort]: z.enum(values.efforts, { error: `must be one of: ${values.efforts.join(', ')}` }),
  [keys.session.model]: z.string().min(1).max(80),
});

/** What is true for one machine only: the proxy of the sessions, and the status line command of the owner. */
const localSessionSchema = z
  .strictObject({
    [keys.session.proxy]: slug.default(values.noProxy),
    [keys.session.statusline]: z
      .string()
      .min(1)
      .max(MAX_STATUSLINE_CHARS)
      .regex(/^[^\r\n]+$/, 'must be one line')
      .nullable()
      .default(null),
  })
  .default({ [keys.session.proxy]: values.noProxy, [keys.session.statusline]: null });

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

/**
 * The mode of each approval point, by point id. The ids are checked against the points of the recipe when the two
 * files are combined, because the shape of this file does not know the recipe.
 */
const approvalSchema = z
  .record(slug, z.enum(values.approvalModes, { error: `must be one of: ${values.approvalModes.join(', ')}` }))
  .default({});

/**
 * The local source of a project with no shareable URL, by project path: a file URL or an absolute path. The value
 * follows the clone URL rules, so a value can never act as an option of git. The path never goes into the shared file.
 * The keys are checked against the project list when the two files are combined.
 */
const sourcesSchema = z
  .record(
    z.string().min(1).max(MAX_SOURCE_KEY_CHARS),
    z.string().superRefine((value, ctx) => {
      const checked = checkLocalSource(value);
      if (!checked.ok) ctx.addIssue({ code: 'custom', message: describeCloneIssue(checked.error) });
    }),
  )
  .refine((sources) => Object.keys(sources).length <= MAX_SOURCES, { error: 'has too many entries' })
  .default({});

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

/** The core reads only the id of the recipe block, and checks it against the ids of the registry. The recipe parser reads the rest. */
const recipeBlockSchemaFor = (ids: readonly string[]) => {
  const error = `must be one of: ${ids.join(', ')}`;
  return z.looseObject({
    [keys.recipe.id]: z.string({ error }).refine((id) => ids.includes(id), { error }),
  });
};

/** The shared file: what makes the same factory on every machine. It holds no personal key and no key of one machine. */
const sharedCoreSchemaFor = (ids: readonly string[]) =>
  z.strictObject({
    [keys.root.schema]: z.literal(CONFIG_SCHEMA_VERSION),
    [keys.root.node]: nodeSchema,
    [keys.root.session]: sharedSessionSchema,
    [keys.root.limits]: limitsSchema,
    [keys.root.tracker]: trackerSchema,
    [keys.root.recipe]: recipeBlockSchemaFor(ids),
  });

/** The local file: what is personal, a credential, or true for one machine only (design 4.4). */
const localFileSchema = z
  .strictObject({
    [keys.root.schema]: z.literal(LOCAL_SCHEMA_VERSION),
    [keys.root.owner]: ownerSchema,
    [keys.root.session]: localSessionSchema,
    [keys.root.proxies]: z.array(proxySchema).max(20).default([]),
    [keys.root.workers]: z
      .record(slug, z.strictObject({ [keys.worker.proxy]: slug }))
      .refine((workers) => Object.keys(workers).length <= MAX_WORKERS, { error: 'has too many entries' })
      .default({}),
    [keys.root.approval]: approvalSchema,
    [keys.root.parent]: linkSchema.nullable().default(null),
    [keys.root.children]: z.array(linkSchema).max(MAX_CHILDREN).default([]),
    [keys.root.sources]: sourcesSchema,
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

type ParsedShared = z.infer<ReturnType<typeof sharedCoreSchemaFor>>;
type ParsedLocal = z.infer<typeof localFileSchema>;

/** Every key of the shared file except its `schema` key and the inside of the `recipe` block. */
export type SharedCore = Omit<ParsedShared, typeof keys.root.schema | typeof keys.root.recipe>;

/** Every key of the local file except its `schema` key. A point that `approval` does not name is not in the map yet. */
export type LocalCore = Omit<ParsedLocal, typeof keys.root.schema>;

/** The shared file, parsed: the core, the parsed block of the recipe, and the entry of that recipe in the registry. */
export interface SharedConfig {
  readonly core: SharedCore;
  readonly recipe: RecipeConfig;
  readonly entry: RecipeEntry;
}

/** The local file, parsed. */
export type LocalConfig = LocalCore;

/** The two files together, as the commands use them. Each approval point has its mode here. */
export type CoreConfig = Omit<SharedCore, typeof keys.root.session> &
  Omit<LocalCore, typeof keys.root.session | typeof keys.root.approval> & {
    readonly session: SharedCore[typeof keys.root.session] & LocalCore[typeof keys.root.session];
    readonly approval: ApprovalModes;
  };

/** The config as the commands use it: both files combined, with the recipe block parsed and the entry of the recipe. */
export interface FactoryConfig {
  readonly core: CoreConfig;
  readonly recipe: RecipeConfig;
  readonly entry: RecipeEntry;
}

export type ProxyConfig = z.infer<typeof proxySchema>;
export type TrackerConfig = z.infer<typeof trackerSchema>;
export type LinkConfig = z.infer<typeof linkSchema>;

const customIssue = (path: readonly (string | number)[], message: string): z.core.$ZodIssue => ({
  code: 'custom',
  path: [...path],
  message,
  input: undefined,
});

const errorOf = (issues: readonly z.core.$ZodIssue[]): z.ZodError => new z.ZodError([...issues]);

/** The keys of the shared file that belong in the local file. The reason for each is in design 4.4. */
const LOCAL_ROOT_KEYS: readonly string[] = [
  keys.root.owner,
  keys.root.proxies,
  keys.root.workers,
  keys.root.approval,
  keys.root.parent,
  keys.root.children,
  keys.root.sources,
  keys.root.state,
];

const LOCAL_SESSION_KEYS: readonly string[] = [keys.session.proxy, keys.session.statusline];

/** The paths of the keys in a raw shared file that belong in the local file. */
const localKeyPaths = (raw: unknown): readonly (readonly string[])[] => {
  if (!isRecord(raw)) return [];
  const root = Object.keys(raw)
    .filter((key) => LOCAL_ROOT_KEYS.includes(key) && key !== keys.root.state)
    .map((key) => [key]);
  const session = raw[keys.root.session];
  const inSession = isRecord(session)
    ? Object.keys(session)
        .filter((key) => LOCAL_SESSION_KEYS.includes(key))
        .map((key) => [keys.root.session, key])
    : [];
  const state = raw[keys.root.state];
  const inState = isRecord(state) && keys.state.remote in state ? [[keys.root.state, keys.state.remote]] : [];
  const stateOther = keys.root.state in raw && inState.length === 0 ? [[keys.root.state]] : [];
  return [...root, ...inSession, ...inState, ...stateOther];
};

/** The paths of the keys of a FAC-M2 config. That layout has one file, and a key of it has another name now. */
const olderLayoutPaths = (raw: unknown): readonly (readonly string[])[] => {
  if (!isRecord(raw)) return [];
  const approval = raw[keys.root.approval];
  return [
    ...(schema2.workersKey in raw ? [[schema2.workersKey]] : []),
    ...(isRecord(approval) && schema2.approvalKey in approval ? [[keys.root.approval, schema2.approvalKey]] : []),
  ];
};

/**
 * The parser of the shared file, in three steps that each fail closed. A key of the older layout gets the remake
 * message. A key that belongs in the local file is refused with its name and the name of the local file. Then the
 * core parses every key except the inside of the `recipe` block, and the parser of the recipe that the core named
 * in the registry parses the block. An issue of the recipe has the path of the block in front, so it names the key in the file.
 */
export const sharedConfigSchemaFor = (registry: RecipeRegistry): SchemaParser<SharedConfig> => {
  const coreSchema = sharedCoreSchemaFor(recipeIds(registry));
  return {
    safeParse: (raw) => {
      const older = olderLayoutPaths(raw);
      if (older.length > 0) {
        return {
          success: false,
          error: errorOf(
            older.map((path) =>
              customIssue(
                path,
                `is from an older layout of ${files.config}. Make the ${roles.node} again with "${commandText(commands.init)}"`,
              ),
            ),
          ),
        };
      }
      const local = localKeyPaths(raw);
      if (local.length > 0) {
        return {
          success: false,
          error: errorOf(
            local.map((path) => customIssue(path, `is a local key: put it in ${files.localConfig}, not in ${files.config}`)),
          ),
        };
      }
      const core = coreSchema.safeParse(raw);
      if (!core.success) return { success: false, error: core.error };
      const { [keys.root.schema]: _schema, [keys.root.recipe]: block, ...rest } = core.data;
      const entry = findRecipe(registry, block.id);
      if (entry === undefined) {
        return { success: false, error: errorOf([customIssue([keys.root.recipe, keys.recipe.id], `names no ${roles.recipe} of the registry`)]) };
      }
      const recipe = entry.schema.safeParse(block);
      if (!recipe.success) {
        const issues = recipe.error.issues.map((issue) => ({ ...issue, path: [keys.root.recipe, ...issue.path] }));
        return { success: false, error: errorOf(issues) };
      }
      return { success: true, data: { core: rest, recipe: recipe.data, entry } };
    },
  };
};

/** The parser of the local file. */
export const localConfigSchema: SchemaParser<LocalConfig> = {
  safeParse: (raw) => {
    const parsed = localFileSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: parsed.error };
    const { [keys.root.schema]: _schema, ...rest } = parsed.data;
    return { success: true, data: rest };
  },
};

/**
 * The problems of the `sources` map against the project list: each key names a listed project path, and the map holds
 * at most as many entries as the list. The messages name the key and never repeat a value.
 */
const sourceIssues = (shared: SharedConfig, local: LocalConfig): readonly z.core.$ZodIssue[] => {
  const projects = shared.recipe.projects;
  const listed = new Set(projects.map((project) => folderKey(project.path)));
  const keysOfMap = Object.keys(local.sources);
  const unlisted = keysOfMap
    .filter((key) => !listed.has(folderKey(key)))
    .map((key) => customIssue([keys.root.sources, key], `names no project path of the list in ${files.config}`));
  const tooMany =
    keysOfMap.length > projects.length
      ? [customIssue([keys.root.sources], 'has more entries than the project list')]
      : [];
  return [...unlisted, ...tooMany];
};

/**
 * Put the two parsed files together. A point of `approval` must be a point of the recipe, and a point that the file
 * does not name waits for the owner. Each key of `sources` must name a listed project path. The error belongs to the
 * local file.
 */
export const mergeConfig = (
  shared: SharedConfig,
  local: LocalConfig,
): { readonly success: true; readonly data: FactoryConfig } | { readonly success: false; readonly error: z.ZodError } => {
  const points = shared.entry.approvalPoints;
  const known = points.map((point) => point.id);
  const unknown = Object.keys(local.approval)
    .filter((id) => !known.includes(id))
    .map((id) =>
      customIssue(
        [keys.root.approval, id],
        `is not an approval point of the ${roles.recipe} ${shared.recipe.id}. The points are: ${known.join(', ')}`,
      ),
    );
  const issues = [...unknown, ...sourceIssues(shared, local)];
  if (issues.length > 0) return { success: false, error: errorOf(issues) };
  const { session: sharedSession, ...sharedRest } = shared.core;
  const { session: localSession, approval, ...localRest } = local;
  return {
    success: true,
    data: {
      core: {
        ...sharedRest,
        ...localRest,
        session: { ...sharedSession, ...localSession },
        approval: { ...ownerModes(points), ...approval },
      },
      recipe: shared.recipe,
      entry: shared.entry,
    },
  };
};

/** The result of the parse of the two files: the combined config, or the issues and the file that holds them. */
export type ConfigParse =
  | { readonly success: true; readonly data: FactoryConfig }
  | { readonly success: false; readonly file: string; readonly error: z.ZodError };

/** Parse the two raw files and combine them. The first problem stops the parse and names its file. */
export const parseConfig = (sharedRaw: unknown, localRaw: unknown, registry: RecipeRegistry): ConfigParse => {
  const shared = sharedConfigSchemaFor(registry).safeParse(sharedRaw);
  if (!shared.success) return { success: false, file: files.config, error: shared.error };
  const local = localConfigSchema.safeParse(localRaw);
  if (!local.success) return { success: false, file: files.localConfig, error: local.error };
  const combined = mergeConfig(shared.data, local.data);
  return combined.success ? combined : { success: false, file: files.localConfig, error: combined.error };
};

/** The parts of a combined config that belong in the shared file. */
export const sharedOf = (config: FactoryConfig): SharedConfig => {
  const { node, limits, tracker, session } = config.core;
  return {
    core: {
      node,
      limits,
      tracker,
      session: {
        [keys.session.permissionMode]: session.permission_mode,
        [keys.session.effort]: session.effort,
        [keys.session.model]: session.model,
      },
    },
    recipe: config.recipe,
    entry: config.entry,
  };
};

/** The parts of a combined config that belong in the local file. */
export const localOf = (config: FactoryConfig): LocalConfig => {
  const { owner, session, proxies, workers, approval, parent, children, sources } = config.core;
  return {
    owner,
    session: { [keys.session.proxy]: session.proxy, [keys.session.statusline]: session.statusline },
    proxies,
    workers,
    approval,
    parent,
    children,
    sources,
  };
};

/**
 * Split one mapping that holds the keys of both files into the raw shared file and the raw local file. A key that
 * the local file owns goes there, and the other keys stay. A value that is not a mapping goes to both parsers, which refuse it.
 */
export const splitConfigValue = (mixed: unknown): { readonly shared: unknown; readonly local: unknown } => {
  if (!isRecord(mixed)) return { shared: mixed, local: mixed };
  const shared: Record<string, unknown> = {};
  const local: Record<string, unknown> = { [keys.root.schema]: LOCAL_SCHEMA_VERSION };
  for (const [key, value] of Object.entries(mixed)) {
    if (LOCAL_ROOT_KEYS.includes(key)) {
      local[key] = value;
    } else if (key === keys.root.session && isRecord(value)) {
      const entries = Object.entries(value);
      shared[key] = Object.fromEntries(entries.filter(([name]) => !LOCAL_SESSION_KEYS.includes(name)));
      const inLocal = entries.filter(([name]) => LOCAL_SESSION_KEYS.includes(name));
      if (inLocal.length > 0) local[key] = Object.fromEntries(inLocal);
    } else {
      shared[key] = value;
    }
  }
  return { shared, local };
};

/** The inverse of `splitConfigValue`, for a reader that needs the keys of both files in one mapping. */
export const mixConfigValue = (shared: unknown, local: unknown): unknown => {
  if (!isRecord(shared) || !isRecord(local)) return shared;
  const sharedSession = shared[keys.root.session];
  const localSession = local[keys.root.session];
  const { [keys.root.schema]: _localSchema, ...localRest } = local;
  return {
    ...shared,
    ...localRest,
    [keys.root.session]: { ...(isRecord(sharedSession) ? sharedSession : {}), ...(isRecord(localSession) ? localSession : {}) },
  };
};
