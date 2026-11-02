import { Document, isMap, isScalar, isSeq, Scalar, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import { failure, type CliResult } from '../cli/errors.js';
import { checkFileAddress } from '../comms/address.js';
import { configDocumentText, parseConfigDocument } from '../config/edit.js';
import { isSlug } from '../config/primitives.js';
import { ok } from '../core/result.js';
import { keys, roles, schema1, values } from '../names.js';
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

/** A project keeps a variant of its own only when its pack differs from the variant of the recipe. */
const migrateProject = (project: unknown): void => {
  if (!isMap(project)) return;
  const pack = pairOf(project, schema1.keys.pack);
  if (pack === undefined) return;
  if (isScalar(pack.value) && pack.value.value === values.variants[0]) {
    project.delete(schema1.keys.pack);
  } else {
    rename(pack, keys.project.variant);
  }
};

/** The projects of the recipe, or undefined when the document has none. */
const migrateProjects = (root: YAMLMap): CliResult<YAMLSeq | undefined> => {
  const projects = root.get(schema1.keys.projects, true);
  if (projects === undefined) return ok(undefined);
  if (!isSeq(projects)) return failure(`${schema1.keys.projects} must be a list`);
  projects.items.forEach(migrateProject);
  return ok(projects);
};

/** F-13: the address of a child must be a file address. The error names the child and never repeats the address. */
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
  return ok(undefined);
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
  const projects = migrateProjects(root);
  if (!projects.ok) return projects;

  root.set(keys.root.schema, TO);
  const lanes = pairOf(root, schema1.keys.lanes);
  if (lanes !== undefined) rename(lanes, keys.root.cells);
  addSection(doc, root, keys.root.tracker, { [keys.tracker.kind]: values.trackerLocal });
  addSection(doc, root, keys.root.approval, { [keys.approval.land]: values.landModes[0] });

  // The projects stay where they are: their key becomes `recipe`, and they move under it.
  const projectsPair = pairOf(root, schema1.keys.projects);
  const recipe = doc.createNode({
    [keys.recipe.id]: values.recipes[0],
    [keys.recipe.variant]: values.variants[0],
    ...(projectsPair === undefined ? {} : { [keys.recipe.projects]: projectsPair.value }),
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

const configSchema1To2: Migration = {
  from: FROM,
  to: TO,
  apply: (raw) => {
    const doc = new Document(raw);
    const migrated = migrateDocument(doc);
    return migrated.ok ? ok(doc.toJS()) : migrated;
  },
  applyText: (text) => {
    const parsed = parseConfigDocument(text);
    if (!parsed.ok) return failure(parsed.error);
    const migrated = migrateDocument(parsed.value);
    return migrated.ok ? ok(configDocumentText(parsed.value)) : migrated;
  },
};

/** The migrations of the config file. */
export const configMigrations: readonly Migration[] = [configSchema1To2];
