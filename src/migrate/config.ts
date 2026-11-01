import { failure, type CliResult } from '../cli/errors.js';
import { checkFileAddress } from '../comms/address.js';
import { isSlug } from '../config/primitives.js';
import { ok } from '../core/result.js';
import { keys, roles, schema1, values } from '../names.js';
import { isRecord } from './inspect.js';
import type { Migration } from './runner.js';

const FROM = 1;
const TO = 2;

/** The layer of a node that was a coordinator in schema 1. */
const COORDINATOR_LAYER = 1;

/** The keys that schema 2 adds. A document of schema 1 does not hold them. */
const ADDED_KEYS: readonly string[] = [
  keys.root.cells,
  keys.root.tracker,
  keys.root.approval,
  keys.root.recipe,
  keys.root.parent,
];

const without = (record: Record<string, unknown>, dropped: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !dropped.includes(key)));

const migrateNode = (node: unknown): CliResult<Record<string, unknown>> => {
  if (!isRecord(node)) return failure(`${keys.root.node} must be a mapping`);
  if (node[schema1.keys.role] !== roles.coordinator) {
    return failure(`${keys.root.node}.${schema1.keys.role} must be ${roles.coordinator}`);
  }
  return ok({ ...without(node, [schema1.keys.role]), [keys.node.layer]: COORDINATOR_LAYER });
};

/** A project keeps a variant of its own only when its pack differs from the variant of the recipe. */
const migrateProject = (project: unknown): unknown => {
  if (!isRecord(project)) return project;
  const pack = project[schema1.keys.pack];
  const rest = without(project, [schema1.keys.pack]);
  return pack === undefined || pack === values.variants[0] ? rest : { ...rest, [keys.project.variant]: pack };
};

/** The projects of the recipe, or undefined when the document has none. */
const migrateProjects = (projects: unknown): CliResult<readonly unknown[] | undefined> => {
  if (projects === undefined) return ok(undefined);
  if (!Array.isArray(projects)) return failure(`${schema1.keys.projects} must be a list`);
  return ok(projects.map(migrateProject));
};

/** F-13: the address of a child must be a file address. The error names the child and never repeats the address. */
const checkChildren = (children: unknown): CliResult<void> => {
  if (children === undefined) return ok(undefined);
  if (!Array.isArray(children)) return failure(`${keys.root.children} must be a list`);
  for (const [index, child] of children.entries()) {
    if (!isRecord(child)) continue;
    const address = child[keys.link.address];
    if (typeof address !== 'string') continue;
    const checked = checkFileAddress(address);
    if (!checked.ok) {
      const id = child[keys.link.id];
      const who = typeof id === 'string' && isSlug(id) ? ` "${id}"` : '';
      return failure(`${keys.root.children}[${index}]${who}: ${keys.link.address}: ${checked.error}`);
    }
  }
  return ok(undefined);
};

const configSchema1To2: Migration = {
  from: FROM,
  to: TO,
  apply: (raw) => {
    if (!isRecord(raw)) return failure('the config must be a mapping of keys');
    const present = ADDED_KEYS.filter((key) => key in raw);
    if (present.length > 0) return failure(`schema ${FROM} does not hold ${present.join(', ')}`);

    const node = migrateNode(raw[keys.root.node]);
    if (!node.ok) return node;
    const children = checkChildren(raw[keys.root.children]);
    if (!children.ok) return children;

    const projects = migrateProjects(raw[schema1.keys.projects]);
    if (!projects.ok) return projects;
    const lanes = raw[schema1.keys.lanes];

    return ok({
      ...without(raw, [schema1.keys.lanes, schema1.keys.projects]),
      [keys.root.schema]: TO,
      [keys.root.node]: node.value,
      ...(lanes === undefined ? {} : { [keys.root.cells]: lanes }),
      [keys.root.tracker]: { [keys.tracker.kind]: values.trackerLocal },
      [keys.root.approval]: { [keys.approval.land]: values.landModes[0] },
      [keys.root.recipe]: {
        [keys.recipe.id]: values.recipes[0],
        [keys.recipe.variant]: values.variants[0],
        ...(projects.value === undefined ? {} : { [keys.recipe.projects]: projects.value }),
      },
      [keys.root.parent]: null,
    });
  },
};

/** The migrations of the config file. */
export const configMigrations: readonly Migration[] = [configSchema1To2];
