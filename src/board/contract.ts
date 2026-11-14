import type { CliResult } from '../cli/errors.js';
import type { requestDeciders, requestGroups } from '../names.js';
import type { CheckedRecord } from '../recipes/entry.js';
import type { DecideRequest } from './decide.js';

/**
 * The board connector contract (design 4.10). Every board connector gives these operations, and the contract suite
 * (`test/contract/board-contract.ts`) runs against each one. The `local` connector keeps the board in the files of the state folder.
 * A hosted tracker kind has no connector in this version: the local connector reads the local files for it and refuses every write.
 *
 * The contract holds no read of a decision answer and no decision writer. The proof read of an owner answer is an export of the
 * owner record module, outside the contract: it reads only the owner decision file. The contract operation `decision read`
 * waits for FAC-M11.
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

/**
 * A decision item for the owner: a one-line title and question, and 1 to 9 options. The connector gives it the next `D-n` and stores
 * the time of the add. The group is the urgency that the asker gives; a request with no group is in the group now.
 */
export interface DecisionAskInput {
  readonly title: string;
  readonly question: string;
  readonly options: readonly DecisionOption[];
  readonly group?: RequestGroup;
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

/**
 * One request that waits for the owner, as the waiting file shows it. The reader checks the id only, so a title that a hand edit
 * left out is null. The options are the keys of the options, in order.
 */
export interface BoardRequest {
  readonly id: string;
  readonly title: string | null;
  readonly options: readonly string[];
}

/** The request that a close took off the waiting file. */
export interface RequestClosed {
  readonly id: string;
  readonly title: string | null;
  /** Who decided the request, or null for a close with no answer. */
  readonly decider: RequestDecider | null;
}

/** Who decided a request that the owner did not answer: a value of `requestDeciders`. The owner answers with `decide`. */
export type RequestDecider = (typeof requestDeciders)[keyof typeof requestDeciders];

/** The group of a request, set by the asker: a value of `requestGroups`. */
export type RequestGroup = (typeof requestGroups)[keyof typeof requestGroups];

/**
 * The decision of a request that is not an approval point, and who made it. The text is one line. A relayed settlement passes on an
 * answer of the owner: only the coordinator relays, so its decider is fixed. It is never an owner answer.
 */
export type RequestSettlement =
  | { readonly decider: RequestDecider; readonly decision: string; readonly relayed?: undefined }
  | { readonly decider: typeof requestDeciders.coordinator; readonly decision: string; readonly relayed: true };

/** The input of `logDecision`: a one-line title, and the decision with its decider. The decider is never the owner. */
export interface DecisionLogInput {
  readonly title: string;
  readonly decider: RequestDecider;
  readonly decision: string;
}

/** What `recordChecked` did: the item after the write, and whether the board changed. A record that was made already changes nothing. */
export interface ItemRecorded {
  readonly item: BoardItem;
  readonly changed: boolean;
}

/** What `unassignItem` did: the item after the write, and the worker that it took off. */
export interface ItemUnassigned {
  readonly item: BoardItem;
  readonly worker: string;
}

/**
 * One row of the queue, as the board file shows it. The reader does not check the keys of a row, so a name or a note that is not
 * text reads as null, and an item list that is not a list of text reads as an empty list.
 */
export interface QueueRow {
  /** The place in the queue, counted from 1. */
  readonly position: number;
  readonly name: string | null;
  readonly items: readonly string[];
  readonly note: string | null;
  /** The stored object of the row, with every key in the order of the file. */
  readonly record: Readonly<Record<string, unknown>>;
}

/**
 * The input of a queue write. The row is found by its name, and a name that no row has makes a new row at the end. A part that is
 * left out stays as it is: the item ids replace the whole list of the row. A position moves the row to that place.
 */
export interface QueueRowInput {
  readonly name: string;
  readonly items?: readonly string[];
  readonly note?: string;
  readonly fields?: FieldValues;
  readonly position?: number;
}

/** What a queue write did to the row. `changed` is false when the board stays as it is. */
export interface QueueRowSet {
  readonly name: string;
  readonly position: number;
  readonly items: readonly string[];
  readonly created: boolean;
  readonly changed: boolean;
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

/**
 * What the owner decision file holds for an open request: no record, the record of this request text, or a record of another text of
 * the request (`mismatch`). A decision file that cannot be read is no value of this type: the read stops with an error.
 */
export type DecisionStored =
  | {
      readonly kind: 'record';
      readonly node: string;
      readonly root: string;
      readonly id: string;
      readonly option: string;
      readonly at: string;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'mismatch'; readonly option: string; readonly at: string };

/** The node id, the real root and the decision file of one factory folder. A null path: no variable names a state folder. */
export interface DecisionPlace {
  readonly node: string;
  readonly root: string;
  readonly path: string | null;
}

/** What the command of decide gives the writer of the owner record: the D-n, the chosen option, the request hash and the time. */
export interface DecisionInput {
  readonly id: string;
  readonly option: string;
  readonly hash: string;
  readonly at: string;
}

/** The result of the writer. `existing`: the owner decision file already holds this answer. A warning names a lock file that stays. */
export interface DecisionWrite {
  readonly outcome: 'stored' | 'existing';
  readonly warning: string | null;
}

/** An open request as `decisionRequest` reads it, before the prompt. */
export interface DecisionRequestRead {
  /** The request, read strictly, with its canonical text and its hash. */
  readonly request: DecideRequest;
  /** The record of the owner decision file for this request. Its option is the only source of a chosen option. */
  readonly stored: DecisionStored;
  /** The node id, the real root and the decision file. */
  readonly place: DecisionPlace;
}

/** The input of `recordDecision`: the request that the owner saw, the option, the note, and the time of the answer. */
export interface DecisionRecordCall {
  /** The request as `decisionRequest` gave it. Its hash is checked again under the lock. */
  readonly request: DecideRequest;
  /** The key of the chosen option. */
  readonly option: string;
  /** The reason of the owner, checked by the caller, or null for none. */
  readonly note: string | null;
  /** The time of the answer: an ISO time in UTC, read once after the owner said yes. */
  readonly at: string;
}

/** The writer of the owner record. The command of decide gives it. The connector never names the owner decision file. */
export type DecisionProofWriter = (input: DecisionInput) => Promise<CliResult<DecisionWrite>>;

/** What `recordDecision` did. */
export interface DecisionRecorded {
  readonly id: string;
  readonly option: string;
  /** The profile record file, relative to the state folder. */
  readonly path: string;
  /** `stored`: a new record. `existing`: the owner decision file held this answer already. */
  readonly outcome: DecisionWrite['outcome'];
  /** A line for the person when the owner record is saved and a lock file stays, else null. */
  readonly warning: string | null;
}

/**
 * The local board: the contract, and the operations of the owner's board for the local files only: the requests, the queue and the
 * answer of the owner. A hosted board maps a request and a queue to the provider (FAC-M3), so these operations are not in the contract
 * suite. Each write of them, and the read of a request for the owner, refuses a hosted tracker kind first, as a write of the contract
 * does.
 */
export interface LocalBoard extends BoardConnector {
  /** The requests of the waiting file, in file order. */
  listRequests(): Promise<CliResult<readonly BoardRequest[]>>;
  /**
   * Take a request off the waiting file and add a row for it to the decision log, in one commit. The row names no owner who answered,
   * so it is no owner answer, and the number of the request is never given again. With a settlement, the row holds the decision text
   * and the decider (the coordinator or a delegate). Without one, it says that the request closed with no answer. A request that has a
   * record in the owner decision file is refused, and so is a decision file that can not be read. A relayed settlement adds the fixed
   * relayed marker to the row: the row names the coordinator as its decider and is no owner answer.
   */
  closeRequest(id: string, settlement?: RequestSettlement): Promise<CliResult<RequestClosed>>;
  /**
   * Add one row to the decision log, with the next decision number, and no waiting entry. The row names its decider, who is never the
   * owner. The value is the new number. It writes no owner record and no profile record.
   */
  logDecision(input: DecisionLogInput): Promise<CliResult<string>>;
  /**
   * Record a check of the recipe that passed (`checked`), in one commit: the stage of the check, the closed state, the head of the
   * check, and the item taken out of each queue row that lists it. `worker` is the worker that the check bound to the item (null for
   * none). The item must still hold that worker under the lock, else the record stops with exit 1 and writes nothing. A record that
   * is made already, with the same head, changes nothing; a record of another head is exit 1.
   */
  recordChecked(id: string, checked: CheckedRecord, worker: string | null): Promise<CliResult<ItemRecorded>>;
  /**
   * Take the worker off an item: delete the worker key, keep the state and the stage, and add the former worker to the list of
   * former workers of the item. This is the only way to remove a worker from an item.
   */
  unassignItem(id: string): Promise<CliResult<ItemUnassigned>>;
  /** The rows of the queue, in file order. */
  listQueue(): Promise<CliResult<readonly QueueRow[]>>;
  /** Add a row to the queue, change a row, or move it. */
  setQueueRow(input: QueueRowInput): Promise<CliResult<QueueRowSet>>;
  /**
   * Read an open request for the owner, before the prompt and with no lock. A hosted tracker kind, a guard that is off, a number that
   * is unknown or closed or answered, a request that fails the strict read and an owner decision file that cannot be read each stop
   * with an error. A row of the log with an owner key is no answer unless the owner decision file holds the record of its request text.
   */
  decisionRequest(id: string): Promise<CliResult<DecisionRequestRead>>;
  /**
   * Record the owner answer: the owner record first, then the board copies in one commit. The state lock holds the checks, the
   * folder of the records, the call of `writeProof` and the commit. A failure after `writeProof` says in its remedy line whether the
   * answer is saved, so the same command finishes the copies. The caller gives the time once, after the owner said yes.
   */
  recordDecision(input: DecisionRecordCall, writeProof: DecisionProofWriter): Promise<CliResult<DecisionRecorded>>;
}
