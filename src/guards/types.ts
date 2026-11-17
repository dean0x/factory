import type { guardKinds, guardValues } from '../names.js';

/** The kind of a row: a check in code, or a rule in the role text. */
export type GuardKind = (typeof guardKinds)[keyof typeof guardKinds];

/** The value of a guard: the check or the text is on, or it is off. */
export type GuardValue = (typeof guardValues)[keyof typeof guardValues];

/** A place in the source that a row cites: a file below the repo folder and a declaration at the top level of it. */
export interface RowSite {
  readonly path: string;
  readonly symbol: string;
}

/**
 * One check or one rule text that belongs to one guard.
 * - `id` is a stable slug, local to the registry.
 * - `name` says what the row keeps safe.
 * - `applies` says where the row applies: a command, an event or a step.
 * - `harm` is true when the row can harm the machine, the data or the accounts if it is off.
 * - `sites` lists the places of the source where the check or the text lives.
 */
export interface RowFacts {
  readonly id: string;
  readonly guard: string;
  readonly name: string;
  readonly applies: string;
  readonly harm: boolean;
  readonly sites: readonly RowSite[];
}

/** A row with its kind: `code` for a check in code, `text` for a rule in the role text. */
export interface GuardRow extends RowFacts {
  readonly kind: GuardKind;
}

/**
 * A guard as the registry data states it. The harm mark, the kinds, the key and the row ids come from the rows and from the id,
 * so the list never states a fact twice.
 * - `newNode` is the value that `init` writes for a new node.
 * - `whenMissing` is the value of a node whose file has no key for the guard.
 * - `related` lists the existing config keys that belong to the guard.
 */
export interface GuardDefinition {
  readonly id: string;
  readonly name: string;
  readonly keepsSafe: string;
  readonly newNode: GuardValue;
  readonly whenMissing: GuardValue;
  readonly related: readonly string[];
}

/** A guard with the facts that its rows give: the harm mark, the kinds, the key and the ids of its rows. */
export interface Guard extends GuardDefinition {
  readonly harm: boolean;
  readonly kinds: readonly GuardKind[];
  readonly key: string;
  readonly rows: readonly string[];
}
