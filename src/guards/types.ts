import type { GuardReadState } from '../core/guard-records.js';
import type { guardKinds, guardListWords, guardValues } from '../names.js';

/** The kind of a row: a check in code, or a rule in the role text. */
export type GuardKind = (typeof guardKinds)[keyof typeof guardKinds];

/** The value of a guard: the check or the text is on, or it is off. */
export type GuardValue = (typeof guardValues)[keyof typeof guardValues];

/** Guard values by id, shared by config and text consumers. */
export type GuardValues = Readonly<Record<string, GuardValue>>;

/** How much of the guard store a read needs: the store only when a local value is off, or always (a report or the prefix check). */
export type GuardNeed = 'when-off' | 'always';

/**
 * The effective guard values of one node home. For every other home, and for a null home, every guard is on. `state` is the one
 * read that gave the values. It is null when no read was made: then `guardReadOf` makes the read, with its proof.
 */
export interface GuardContext {
  readonly home: string | null;
  readonly values: GuardValues;
  readonly state: GuardReadState | null;
}

/**
 * The guard values of one command line. The read runs at most once, at the first ask, so a command that asks for no value reads
 * no file for it. The read never fails: a fault of any kind gives every guard on.
 */
export interface GuardSource {
  read(): Promise<GuardContext>;
}

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

/**
 * A row with its kind: `code` for a check in code, `text` for a rule in the role text. `alwaysOn` is true for a row that no guard
 * value changes: a check that always runs (it checks the form of data, writes safely, runs in the config parse or the home
 * location, or runs only for a folder that is not a node yet), or a text that always stays because its check always runs. Its
 * sites read no value of its guard.
 */
export interface GuardRow extends RowFacts {
  readonly kind: GuardKind;
  readonly alwaysOn: boolean;
}

/**
 * A guard as the registry data states it. The harm mark, the kinds, the key and the row ids come from the rows and from the id,
 * so the list never states a fact twice.
 * - `wired` is true only when all sites of the guard can follow its value. A fixed guard is never wired.
 * - `fixed` is true for a guard with no key: every row of it is always on, so no setting changes it.
 * - `newNode` is the value that `init` writes for a new node.
 * - `whenMissing` is the value of a node whose file has no key for the guard.
 * - `related` lists the existing config keys that belong to the guard.
 */
export interface GuardDefinition {
  readonly id: string;
  readonly name: string;
  readonly keepsSafe: string;
  readonly wired: boolean;
  readonly fixed: boolean;
  readonly newNode: GuardValue;
  readonly whenMissing: GuardValue;
  readonly related: readonly string[];
}

/**
 * A guard with the facts that its rows give: the harm mark, the kinds, the key and the ids of its rows. The harm mark comes only
 * from the rows that the value changes. A fixed guard has no key and no harm mark, because it is never off.
 */
export interface Guard extends GuardDefinition {
  readonly harm: boolean;
  readonly kinds: readonly GuardKind[];
  readonly key: string | null;
  readonly rows: readonly string[];
}

/** One guard with its effective value, source and record time. */
export interface GuardState extends Guard {
  readonly value: GuardValue;
  readonly source: keyof typeof guardListWords.sources;
  readonly since: string | null;
  readonly settable: boolean;
}
