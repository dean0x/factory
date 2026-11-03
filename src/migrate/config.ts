import { Document, isMap, isScalar, isSeq, Scalar, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import { failure, type CliResult } from '../cli/errors.js';
import { checkFileAddress } from '../comms/address.js';
import { isSlug } from '../config/primitives.js';
import { ok } from '../core/result.js';
import { commands, commandText, flags, flagText, keys, nodeCommands, roles, schema1, values } from '../names.js';
import type { Migration } from './runner.js';

const FROM = 1;
const TO = 2;

/** The layer of a node that was a coordinator in schema 1. */
const COORDINATOR_LAYER = 1;

/** The keys that schema 2 adds. A document of schema 1 does not hold them. */
const ADDED_KEYS: readonly string[] = [
  keys.root.workers,
  keys.root.tracker,
  keys.root.approval,
  keys.root.recipe,
  keys.root.parent,
];

/**
 * The migration edits a `yaml` Document in place, so that the comments, the blank lines and the order of the keys
 * stay as the owner wrote them. A key that gets a new name keeps its place. A new key goes to the end.
 */

const pairOf = (map: YAMLMap, key: string): Pair | undefined =>
  map.items.find((item) => isScalar(item.key) && item.key.value === key);

/** Give the pair another key. The pair keeps its place and the comments of its key. */
const rename = (pair: Pair, key: string): void => {
  if (isScalar(pair.key)) pair.key.value = key;
};

/** The new scalar, with the comments and the blank line of the old one. */
const withNotesOf = (old: Scalar, next: Scalar): Scalar => {
  if (old.comment !== undefined) next.comment = old.comment;
  if (old.commentBefore !== undefined) next.commentBefore = old.commentBefore;
  if (old.spaceBefore !== undefined) next.spaceBefore = old.spaceBefore;
  return next;
};

/** Add a key at the end of the mapping, after a blank line. */
const addSection = (doc: Document, root: YAMLMap, key: string, value: unknown): void => {
  const pair = doc.createPair(key, value);
  if (isScalar(pair.key)) pair.key.spaceBefore = true;
  root.items.push(pair);
};

const migrateNode = (root: YAMLMap): CliResult<void> => {
  const node = root.get(keys.root.node, true);
  if (!isMap(node)) return failure(`${keys.root.node} must be a mapping`);
  const role = pairOf(node, schema1.keys.role);
  const roleValue = role?.value;
  if (role === undefined || !isScalar(roleValue) || roleValue.value !== roles.coordinator) {
    return failure(`${keys.root.node}.${schema1.keys.role} must be ${roles.coordinator}`);
  }
  if (node.has(keys.node.layer)) return failure(`schema ${FROM} does not hold ${keys.root.node}.${keys.node.layer}`);

  rename(role, keys.node.layer);
  role.value = withNotesOf(roleValue, new Scalar(COORDINATOR_LAYER));
  return ok(undefined);
};

/**
 * Decision D-3 B: a project of the older layout sits outside the new folder and has no clone URL. So a node that lists
 * one is not upgraded. The message never repeats a path or an id of a project.
 */
const refuseProjects = (): CliResult<never> =>
  failure(
    `${schema1.keys.projects}: this ${roles.node} lists a project. A project of the older layout sits outside the new ` +
      'folder and has no clone URL, so the upgrade stops and changes no file. ' +
      `To go on, make the ${roles.node} again with "${commandText(commands.init)}", ` +
      `and give each repo with ${flagText(flags.project)}.`,
  );

/** The list of projects, or undefined when the document has none. A node that lists a project is refused. */
const checkProjects = (root: YAMLMap): CliResult<YAMLSeq | undefined> => {
  const projects = root.get(schema1.keys.projects, true);
  if (projects === undefined) return ok(undefined);
  if (!isSeq(projects)) return failure(`${schema1.keys.projects} must be a list`);
  return projects.items.length === 0 ? ok(projects) : refuseProjects();
};

/**
 * The children of a node on layer 1 are workers, and a worker is not a node link. So the list must be empty.
 * F-13: the address of a child must be a file address. The error names the child and never repeats the address.
 */
const checkChildren = (root: YAMLMap): CliResult<void> => {
  const children = root.get(keys.root.children, true);
  if (children === undefined) return ok(undefined);
  if (!isSeq(children)) return failure(`${keys.root.children} must be a list`);
  for (const [index, child] of children.items.entries()) {
    if (!isMap(child)) continue;
    const address = child.get(keys.link.address);
    if (typeof address !== 'string') continue;
    const checked = checkFileAddress(address);
    if (!checked.ok) {
      const id = child.get(keys.link.id);
      const who = typeof id === 'string' && isSlug(id) ? ` "${id}"` : '';
      return failure(`${keys.root.children}[${index}]${who}: ${keys.link.address}: ${checked.error}`);
    }
  }
  if (children.items.length === 0) return ok(undefined);
  return failure(
    `${keys.root.children}: a ${roles.node} on layer ${COORDINATOR_LAYER} has ${roles.worker}s as its children, ` +
      `so this list must be empty. Remove the entries and run the command again. ` +
      `To manage other ${roles.node}s, set ${keys.root.node}.${keys.node.layer} to 2 after the upgrade, ` +
      `and add them with "${commandText(commands.node)} ${nodeCommands.addChild}".`,
  );
};

const migrateDocument = (doc: Document): CliResult<void> => {
  const root = doc.contents;
  if (!isMap(root)) return failure('the config must be a mapping of keys');
  const present = ADDED_KEYS.filter((key) => root.has(key));
  if (present.length > 0) return failure(`schema ${FROM} does not hold ${present.join(', ')}`);

  const node = migrateNode(root);
  if (!node.ok) return node;
  const children = checkChildren(root);
  if (!children.ok) return children;
  const projects = checkProjects(root);
  if (!projects.ok) return projects;

  root.set(keys.root.schema, TO);
  const lanes = pairOf(root, schema1.keys.lanes);
  if (lanes !== undefined) rename(lanes, keys.root.workers);
  addSection(doc, root, keys.root.tracker, { [keys.tracker.kind]: values.trackerLocal });

  // The empty list of projects stays where it is: its key becomes `recipe`, and the list moves under it.
  const projectsPair = pairOf(root, schema1.keys.projects);
  const recipe = doc.createNode({
    [keys.recipe.id]: values.recipes[0],
    [keys.recipe.variant]: values.variants[0],
    [keys.recipe.projects]: projectsPair === undefined ? [] : projectsPair.value,
  });
  if (projectsPair === undefined) {
    addSection(doc, root, keys.root.recipe, recipe);
  } else {
    rename(projectsPair, keys.root.recipe);
    projectsPair.value = recipe;
  }
  addSection(doc, root, keys.root.parent, null);
  return ok(undefined);
};

/**
 * A pure step on one value. The value holds the keys of both files: the upgrade splits it into the shared file and the
 * local file, so this step does not edit the text of the owner.
 */
const configSchema1To2: Migration = {
  from: FROM,
  to: TO,
  apply: (raw) => {
    const doc = new Document(raw);
    const migrated = migrateDocument(doc);
    return migrated.ok ? ok(doc.toJS()) : migrated;
  },
};

/** The migrations of the config file. */
export const configMigrations: readonly Migration[] = [configSchema1To2];
