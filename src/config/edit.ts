import { isDeepStrictEqual } from 'node:util';
import { isMap, isNode, isScalar, isSeq, parseDocument, Scalar, type Document, type Pair, type YAMLMap } from 'yaml';
import { err, ok, type Result } from '../core/result.js';
import type { GuardValues } from '../guards/types.js';
import { files, guardKeys, keys } from '../names.js';
import type { ApprovalModes } from '../recipes/index.js';
import type { LinkConfig } from './schema.js';

/**
 * Edits of the local config text go through the Document API of `yaml`, so that the comments, the blank lines
 * and the order of the keys stay as the owner wrote them. The functions are pure: text in, text out.
 * The caller checks the whole config again before it writes the text.
 */

export const parseConfigDocument = (text: string): Result<Document, string> => {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  return doc.errors.length > 0 ? err(`${files.localConfig} does not parse`) : ok(doc);
};

const childrenNotList = `${keys.root.children} in ${files.localConfig} is not a list`;

/** No line folding: the library would break a long address over two lines. */
export const configDocumentText = (doc: Document): string => doc.toString({ lineWidth: 0 });

/** Add a child at the end of the list. The list is a block list, and the address is a quoted text. */
export const addChildText = (text: string, link: LinkConfig): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!isMap(doc.contents)) return err(`${files.localConfig} must hold a mapping of keys`);

  const entry = doc.createNode({ [keys.link.id]: link.id, [keys.link.address]: link.address });
  const address = entry.get(keys.link.address, true);
  if (address instanceof Scalar) address.type = Scalar.QUOTE_DOUBLE;

  const list = doc.get(keys.root.children, true);
  if (list === undefined) {
    doc.set(keys.root.children, doc.createNode([entry]));
  } else if (isSeq(list)) {
    // A list of no items is written as [] in flow style. A block list reads better with an entry in it.
    list.flow = false;
    list.add(entry);
  } else {
    return err(childrenNotList);
  }
  return ok(configDocumentText(doc));
};

/**
 * Set the mode of each approval point. A point that the map names keeps its place and its comments, a new point goes at
 * the end, and the map is a block map. The key is added when the file has none.
 */
export const setApprovalText = (text: string, modes: ApprovalModes): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!isMap(doc.contents)) return err(`${files.localConfig} must hold a mapping of keys`);

  const current = doc.get(keys.root.approval, true);
  if (current === undefined || current === null || (current instanceof Scalar && current.value === null)) {
    doc.set(keys.root.approval, doc.createNode(modes));
  } else if (isMap(current)) {
    current.flow = false;
    for (const [point, mode] of Object.entries(modes)) current.set(point, mode);
  } else {
    return err(`${keys.root.approval} in ${files.localConfig} is not a mapping`);
  }
  return ok(configDocumentText(doc));
};

/** Set only the named guards. Keep each existing key, comment and blank line. */
export const setGuardText = (text: string, values: GuardValues): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!isMap(doc.contents)) return err(`${files.localConfig} must hold a mapping of keys`);

  const current = doc.get(guardKeys.local, true);
  if (current === undefined) {
    doc.set(guardKeys.local, doc.createNode(values));
  } else if (isMap(current)) {
    current.flow = false;
    for (const [id, value] of Object.entries(values)) current.set(id, value);
  } else {
    return err(`${guardKeys.local} in ${files.localConfig} is not a mapping`);
  }
  return ok(configDocumentText(doc));
};

type Span = readonly [start: number, end: number];

const pairWith = (map: YAMLMap, id: string): Pair | undefined =>
  map.items.find((pair) => isScalar(pair.key) && pair.key.value === id);

/** The source span of a pair, from the start of its key to the end of its value. A pair with no source place gives undefined. */
const pairSpan = (pair: Pair): Span | undefined => {
  if (!isNode(pair.key) || !pair.key.range) return undefined;
  const valueEnd = isNode(pair.value) && pair.value.range ? pair.value.range[1] : pair.key.range[1];
  return [pair.key.range[0], valueEnd];
};

/**
 * The whole lines of a span, with the line break at the end. A span that does not start a line gives undefined, so that a line that
 * holds more than the span is never removed.
 */
const linesOf = (text: string, [from, to]: Span): Span | undefined => {
  const start = text.lastIndexOf('\n', from - 1) + 1;
  if (text.slice(start, from).trim() !== '') return undefined;
  const lineEnd = text.indexOf('\n', Math.max(to - 1, from));
  return [start, lineEnd < 0 ? text.length : lineEnd + 1];
};

const withoutSpans = (text: string, spans: readonly Span[]): string =>
  [...spans].sort((a, b) => b[0] - a[0]).reduce((rest, [start, end]) => rest.slice(0, start) + rest.slice(end), text);

/**
 * The source edit of a removal: the lines of each removed pair of a block map, the new text of a flow map that keeps the source of
 * each other pair, or the lines of the whole key when the map is left empty. Every other byte of the text stays. A map or a pair
 * whose source place is not clear, and a flow map with a comment in it, give undefined.
 */
const sourceEdit = (text: string, doc: Document, key: string, map: YAMLMap, found: readonly string[]): string | undefined => {
  const kept = map.items.filter((pair) => !found.some((id) => isScalar(pair.key) && pair.key.value === id));
  if (kept.length === 0) {
    const parent = isMap(doc.contents) ? pairWith(doc.contents, key) : undefined;
    const span = parent === undefined ? undefined : pairSpan(parent);
    const lines = span === undefined ? undefined : linesOf(text, span);
    return lines === undefined ? undefined : withoutSpans(text, [lines]);
  }
  if (map.flow) {
    if (!map.range || text.slice(map.range[0], map.range[1]).includes('#')) return undefined;
    const pairs = kept.map(pairSpan).flatMap((span) => (span === undefined ? [] : [text.slice(span[0], span[1])]));
    if (pairs.length !== kept.length) return undefined;
    return `${text.slice(0, map.range[0])}{ ${pairs.join(', ')} }${text.slice(map.range[1])}`;
  }
  const removed = found.flatMap((id) => {
    const pair = pairWith(map, id);
    const span = pair === undefined ? undefined : pairSpan(pair);
    const lines = span === undefined ? undefined : linesOf(text, span);
    return lines === undefined ? [] : [lines];
  });
  return removed.length === found.length ? withoutSpans(text, removed) : undefined;
};

/** A copy of the document with the ids gone from the map under `key`, and with the key gone when its map is left empty. */
const withoutIdsDocument = (doc: Document, key: string, found: readonly string[]): Document => {
  const copy = doc.clone();
  const map = copy.get(key, true);
  if (isMap(map)) {
    for (const id of found) map.delete(id);
    if (map.items.length === 0) copy.delete(key);
  }
  return copy;
};

/** A source edit counts only when its text parses to the value of the original with only the removed ids gone. */
const removalHolds = (edited: string, expected: Document): boolean => {
  const parsed = parseConfigDocument(edited);
  return parsed.ok && isDeepStrictEqual(parsed.value.toJS(), expected.toJS());
};

/**
 * Remove the named ids from the guard map under `key`. A map that the removal leaves empty goes with its key. The edit is on the
 * source text, so each other line stays byte for byte, with its comments and their spaces. When the source place is not clear, or
 * when the source edit changes any other value, the library writes the document again: the keys, comments and blank lines stay,
 * and a comment at the end of a line gets one space.
 * A text that holds none of the ids comes back unchanged.
 */
export const removeGuardKeysText = (text: string, key: string, ids: readonly string[]): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return err(`${key} cannot be changed: the text does not parse`);
  const doc = parsed.value;
  const current = doc.get(key, true);
  if (!isMap(current)) return ok(text);
  const found = ids.filter((id) => current.has(id));
  if (found.length === 0) return ok(text);
  const expected = withoutIdsDocument(doc, key, found);
  const edited = sourceEdit(text, doc, key, current, found);
  return ok(edited !== undefined && removalHolds(edited, expected) ? edited : configDocumentText(expected));
};

/** Remove the child with this id. The entry goes with its own comments. */
export const removeChildText = (text: string, id: string): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const list = doc.get(keys.root.children, true);
  if (!isSeq(list)) return err(childrenNotList);
  const index = list.items.findIndex((item) => isMap(item) && item.get(keys.link.id) === id);
  if (index < 0) return err(`${keys.root.children} in ${files.localConfig} has no entry with this id`);
  list.delete(index);
  return ok(configDocumentText(doc));
};
