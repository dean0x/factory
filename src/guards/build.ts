import { guardKinds, guardValues } from '../names.js';
import type { GuardDefinition, GuardRow, RowFacts, RowSite } from './types.js';

/** The sites in one file: one site for each symbol. */
export const at = (path: string, ...symbols: readonly string[]): readonly RowSite[] =>
  symbols.map((symbol) => ({ path, symbol }));

/** A row for a check in code. */
export const codeRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.code });

/** A row for a rule in the role text. */
export const textRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.text });

/**
 * A guard definition. The facts that its rows give (the harm mark, the kinds and the row ids) are not stated here: `guardsFor`
 * reads them from the rows. A new node and a node whose file has no key both start with every guard on in this version.
 */
export const guardOf = (
  id: string,
  name: string,
  keepsSafe: string,
  related: readonly string[] = [],
): GuardDefinition => ({
  id,
  name,
  keepsSafe,
  newNode: guardValues.on,
  whenMissing: guardValues.on,
  related,
});
