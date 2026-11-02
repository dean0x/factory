import { isMap, isSeq, parseDocument, Scalar, type Document } from 'yaml';
import { err, ok, type Result } from '../core/result.js';
import { files, keys } from '../names.js';
import type { LinkConfig } from './schema.js';

/**
 * Edits of the config text go through the Document API of `yaml`, so that the comments, the blank lines
 * and the order of the keys stay as the owner wrote them. The functions are pure: text in, text out.
 * The caller checks the whole config again before it writes the text.
 */

export const parseConfigDocument = (text: string): Result<Document, string> => {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  return doc.errors.length > 0 ? err(`${files.config} does not parse`) : ok(doc);
};

const childrenNotList = `${keys.root.children} in ${files.config} is not a list`;

/** No line folding: the library would break a long address over two lines. */
export const configDocumentText = (doc: Document): string => doc.toString({ lineWidth: 0 });

/** Add a child at the end of the list. The list is a block list, and the address is a quoted text. */
export const addChildText = (text: string, link: LinkConfig): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!isMap(doc.contents)) return err(`${files.config} must hold a mapping of keys`);

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

/** Remove the child with this id. The entry goes with its own comments. */
export const removeChildText = (text: string, id: string): Result<string, string> => {
  const parsed = parseConfigDocument(text);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const list = doc.get(keys.root.children, true);
  if (!isSeq(list)) return err(childrenNotList);
  const index = list.items.findIndex((item) => isMap(item) && item.get(keys.link.id) === id);
  if (index < 0) return err(`${keys.root.children} in ${files.config} has no entry with this id`);
  list.delete(index);
  return ok(configDocumentText(doc));
};
