import type { CliResult } from '../cli/errors.js';

/**
 * The board connector contract (design 4.10). Every board connector gives these operations, and the contract suite
 * (`test/contract/board-contract.ts`) runs against each one. The `local` connector keeps the board in the files of the state folder.
 * It is also the test double of the hosted connectors.
 *
 * The contract holds no read of a decision answer in this change, and no decision writer: a decision item is asked, and the owner
 * answers it outside the connector.
 *
 * A stage and an owner field are display data and never proof. A connector keeps every stored key that it does not own.
 */

/** The value of an owner field as the contract carries it: text for a `values` or `token` field, a boolean for a `flag` field. */
export type FieldValue = string | boolean;

/** The owner fields of one item or one queue row, by field name. */
export type FieldValues = Readonly<Record<string, FieldValue>>;

/** One item of the board, as read from the file. */
export interface BoardItem {
  /** The item id, of the form `B-n`. */
  readonly id: string;
  readonly title: string;
  /** The state of the item. The setup declares the states, and the state that it names as closed closes the item. */
  readonly status: string;
  /** The id of the track of the item, or null for an item with no track. */
  readonly track: string | null;
  /** The stage as stored, or null for an item with no stage. A stored stage can be outside the stage list of the recipe. */
  readonly stage: string | null;
  /** The stored object of the item, with every key in the order of the file. */
  readonly record: Readonly<Record<string, unknown>>;
}

/** One track of the board: a line of work that groups items. */
export interface BoardTrack {
  /** Lowercase, up to 32 characters. */
  readonly id: string;
  readonly name: string;
  /** True when the track is part of the roadmap. */
  readonly roadmap: boolean;
}

export interface ItemAddInput {
  readonly title: string;
  readonly text?: string;
  readonly track?: string;
  readonly fields?: FieldValues;
}

/** The parts of an item that `update` can change. A part that is left out stays as it is. */
export interface ItemPatch {
  readonly title?: string;
  readonly text?: string;
  readonly track?: string;
  readonly fields?: FieldValues;
}

/** A move sets the state of an item, or its stage. Exactly one of the two. */
export type ItemMove = { readonly state: string } | { readonly stage: string };

/** What a move did: the id, the old and the new value of the part that it set, and whether the board changed. */
export interface ItemMoved {
  readonly id: string;
  readonly from: string | null;
  readonly to: string;
  /** False when the item had the value already: the board stays as it is. */
  readonly changed: boolean;
}

export interface ItemQuery {
  /** Only the items of this track. */
  readonly track?: string;
  /** True: the list holds the closed items too. */
  readonly all: boolean;
}

export interface TrackAddInput {
  readonly id: string;
  readonly name: string;
  readonly roadmap: boolean;
}

/** One option of a decision item. `rec` marks the option that the asker recommends. */
export interface DecisionOption {
  readonly key: string;
  readonly text: string;
  readonly rec?: boolean;
}

/** A decision item for the owner: a one-line title and question, and 1 to 9 options. The connector gives it the next `D-n`. */
export interface DecisionAskInput {
  readonly title: string;
  readonly question: string;
  readonly options: readonly DecisionOption[];
}

/** A link from an item to a file of the factory folder: a relative path inside the folder, never a copy. */
export interface DocLinkInput {
  readonly id: string;
  readonly path: string;
}

/** An event on the board since a cursor, with its author. A connector with no events gives none. */
export interface BoardEvent {
  readonly at: string;
  readonly author: string;
  readonly text: string;
}

export interface ChangesRead {
  readonly events: readonly BoardEvent[];
  /** The cursor for the next read. */
  readonly cursor: string | null;
}

export interface BoardConnector {
  /** The tracker kind of the connector. */
  readonly kind: string;
  addItem(input: ItemAddInput): Promise<CliResult<BoardItem>>;
  updateItem(id: string, patch: ItemPatch): Promise<CliResult<BoardItem>>;
  moveItem(id: string, move: ItemMove): Promise<CliResult<ItemMoved>>;
  /** Set the closed state. The item keeps its id and its stage. */
  closeItem(id: string): Promise<CliResult<BoardItem>>;
  listItems(query: ItemQuery): Promise<CliResult<readonly BoardItem[]>>;
  addTrack(input: TrackAddInput): Promise<CliResult<BoardTrack>>;
  listTracks(): Promise<CliResult<readonly BoardTrack[]>>;
  /** Add a decision item. The value is its id. */
  askDecision(input: DecisionAskInput): Promise<CliResult<string>>;
  linkDoc(input: DocLinkInput): Promise<CliResult<BoardItem>>;
  /** The local connector has no changes: it gives an empty list. */
  readChanges(cursor: string | null): Promise<CliResult<ChangesRead>>;
}
