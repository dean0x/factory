import { guardKinds, guardValues } from '../names.js';
import type { GuardDefinition, GuardRow, RowFacts, RowSite } from './types.js';

/** The sites in one file: one site for each symbol. */
export const at = (path: string, ...symbols: readonly string[]): readonly RowSite[] =>
  symbols.map((symbol) => ({ path, symbol }));

/** A row for a check in code that follows the value of its guard. */
export const codeRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.code, alwaysOn: false });

/** A row for a rule in the role text that follows the value of its guard. */
export const textRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.text, alwaysOn: false });

/** A row for a check in code that always runs: no value of its guard changes it. */
export const alwaysOnRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.code, alwaysOn: true });

/** A row for a rule text that always stays, because the check that it describes always runs: no value of its guard removes it. */
export const fixedTextRow = (input: RowFacts): GuardRow => ({ ...input, kind: guardKinds.text, alwaysOn: true });

/**
 * A guard definition. The facts that its rows give (the harm mark, the kinds and the row ids) are not stated here: `guardsFor`
 * reads them from the rows. New nodes request off. A missing key means on.
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
  fixed: false,
  newNode: guardValues.off,
  whenMissing: guardValues.on,
  related,
});

/** Mark a definition whose rows are all always on: it has no key, and no setting changes it. */
export const fixedGuard = (definition: GuardDefinition): GuardDefinition => ({ ...definition, fixed: true, newNode: guardValues.on });
