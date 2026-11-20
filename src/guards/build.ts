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
  wired: false,
  fixed: false,
  newNode: guardValues.on,
  whenMissing: guardValues.on,
  related,
});

/** Mark a definition whose sites can all follow its value. */
export const wiredGuard = (definition: GuardDefinition): GuardDefinition => ({ ...definition, wired: true });

/** Mark a definition whose rows are all always on: it has no key, and no setting changes it. A fixed guard is never wired. */
export const fixedGuard = (definition: GuardDefinition): GuardDefinition => ({ ...definition, fixed: true, wired: false });
