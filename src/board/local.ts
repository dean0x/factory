import { join } from 'node:path';
import { failure, safetyRefusal, usageError, type CliError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { BoardConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { decisionIdsOf, decisionPlaceOf, readDecisionProof, type DecisionPlace, type DecisionWrite } from '../core/owner-record.js';
import { err, ok, type Err, type Result } from '../core/result.js';
import { LINK_REMEDY, requireNoLinks } from '../core/root-paths.js';
import {
  commands,
  commandText,
  dirs,
  env,
  files,
  hostedBoardLine,
  maxEchoChars,
  maxFileBytes,
  places,
  program,
  requestWords,
  roles,
  values,
  type CommandName,
} from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';
import { commitBoardChange, readBoardFiles, type BoardCommitError, type BoardTexts, type CommitOutcome } from '../state/board-commit.js';
import { requireGuardOn } from '../state/guard.js';
import { stateRel, type Layout } from '../state/layout.js';
import type {
  BoardItem,
  BoardTrack,
  ChangesRead,
  DecisionRecordCall,
  DecisionRequestRead,
  ItemMoved,
  LocalBoard,
  QueueRowSet,
} from './contract.js';
import { addNewRemedy, decideLogRow, recheckRequest, requestStateOf, requireLogRoom, requireOpen, strictRequestOf, type RequestState } from './decide.js';
import { buildDecisionRecord, decisionRecordPath } from './decision-record.js';
import {
  addItemIn,
  addTrackIn,
  askIn,
  changeItemIn,
  checkClose,
  checkDecision,
  checkDocPath,
  checkItemId,
  checkMove,
  checkNewItem,
  checkNewTrack,
  checkPatch,
  checkQueueRow,
  checkRequestId,
  closeItemIn,
  closeRequestIn,
  linkDocIn,
  moveItemIn,
  requireTrack,
  setRowIn,
  settleRequestIn,
  shown,
  type BoardSetup,
  type Edit,
} from './edit.js';
import { parseBoard, parseDecisionLog, parseWaiting, readBoard, readWaiting, type BoardDoc, type DecisionLogDoc, type WaitingDoc } from './files.js';
import { boardJsonText } from './json.js';
import { queueRowsOf } from './queue.js';
import { requestsOf } from './requests.js';

/**
 * The local board connector (design 4.10): the board is the files of the state folder. Every write is one `commitBoardChange` call:
 * the callback reads the files that the helper gives it, builds the new text and returns it, so the helper checks the guard, the size
 * and the item ids, writes the files and makes one state commit. A read takes no lock.
 *
 * The local board has the operations of the contract and four more: the list and the close of the requests, and the list and the
 * write of the queue. A hosted board maps them to the provider (FAC-M3), so they are not in the contract suite.
 *
 * A hosted tracker kind (`github`, `jira` or `linear`) keeps the truth of the board at the provider. factory still keeps the local
 * files, and they are the source for the views (design 4.10). This version has no provider, so every write of a hosted kind stops with a security stop (exit 4) before the input check and
 * before the lock: it makes no commit and changes no file. A read of a hosted kind reads the local files, as the kind `local` does.
 */

export interface LocalBoardOptions {
  /** The key of the queue in `board.json`: `queueKeyOf` of the recipe. */
  readonly queueKey: string;
  /** The stage data of the recipe. */
  readonly recipe: RecipeBoard;
  /** The `board` block of the config, or undefined when the setup has none. */
  readonly config: BoardConfig | undefined;
  /** The command that a stop tells the person to run again. */
  readonly command: CommandName;
  /** The tracker kind of the setup: `tracker.kind` of the config. Every kind but `local` refuses each write. */
  readonly tracker: string;
  /** The id of the node: `core.node.id` of the config. The owner decision file keeps the node id of each answer. */
  readonly node: string;
}

const commitMessages = {
  addItem: 'chore: add an item to the board',
  updateItem: (id: string): string => `chore: change item ${id}`,
  moveItem: (id: string): string => `chore: move item ${id}`,
  closeItem: (id: string): string => `chore: close item ${id}`,
  linkDoc: (id: string): string => `chore: link a file to item ${id}`,
  addTrack: (id: string): string => `chore: add track ${id}`,
  askDecision: 'chore: add a decision to the board',
  closeDecision: (id: string): string => `chore: close decision ${id}`,
  recordDecision: (id: string): string => `chore: record decision ${id}`,
  setQueueRow: 'chore: change the queue',
} as const;

/** The files of a write of a decision. The board is among them, so the check of its queue key runs under the lock. */
const decisionFiles = [files.waiting, files.decisionLog, files.board] as const;

/** The date of a row of the decision log is the first 10 characters of an ISO time: `2030-01-02`. */
const DATE_CHARS = 10;

/**
 * The request text of a read of the owner decision file when no text of the request is known. No text of a request hashes to a stored
 * hash, so a stored record gives `mismatch`, which still gives the stored option and time.
 */
const NO_REQUEST_TEXT = '';

/** The text of one touched file, else a failure that names the file. */
const textIn = (texts: BoardTexts, file: string): CliResult<string> => {
  const text = texts.get(file);
  return text === null || text === undefined ? failure(`cannot read ${file}: the file is not there`) : ok(text);
};

/** The text of the new file, in the old form. The text is read again, so the connector never writes a file that its own read refuses. */
const newText = <T>(file: string, top: unknown, reread: (text: string) => CliResult<T>): CliResult<{ text: string; read: T }> => {
  const json = boardJsonText(top);
  if (!json.ok) return failure(`${file}: ${json.error.message}`);
  const read = reread(json.value);
  return read.ok ? ok({ text: json.value, read: read.value }) : read;
};

/** A change of the files: the new texts of the files that change, and a value for the caller. */
interface Applied<T> {
  readonly texts: BoardTexts;
  readonly value: T;
}

/** The edit of the board and the board after it, which the connector reads the result from. */
interface BoardEdited<T> {
  readonly value: T;
  readonly doc: BoardDoc;
}

export const createLocalBoard = (deps: Deps, layout: Layout, options: LocalBoardOptions): LocalBoard => {
  const { queueKey } = options;
  const setup: BoardSetup = { recipe: options.recipe, config: options.config };

  /** The first step of every write: a hosted kind stops here, before the input check, the lock and any file call. */
  const requireLocalTracker = (): CliResult<void> =>
    options.tracker === values.trackerLocal
      ? ok(undefined)
      : safetyRefusal(
          hostedBoardLine(displayLine(options.tracker, maxEchoChars)),
          `Set the tracker kind to ${values.trackerLocal} in the config, then run "${commandText(options.command)}" again.`,
        );

  /**
   * One `commitBoardChange` call. The value of the change reaches the caller through the closure, because the helper gives back only
   * whether it committed. The error keeps the typed outcome of the helper, and a `beforeWrite` step runs after every check and before
   * the first file write.
   */
  const commit = async <T>(
    touched: readonly string[],
    message: string,
    apply: (texts: BoardTexts) => CliResult<Applied<T>> | Promise<CliResult<Applied<T>>>,
    beforeWrite?: (updates: BoardTexts) => Promise<CliResult<void>>,
  ): Promise<Result<T, BoardCommitError>> => {
    const outcome: { current: { readonly value: T } | undefined } = { current: undefined };
    const done = await commitBoardChange(deps, layout, {
      touched,
      command: options.command,
      message,
      change: async (texts) => {
        const applied = await apply(texts);
        if (!applied.ok) return applied;
        outcome.current = { value: applied.value.value };
        return ok(applied.value.texts);
      },
      ...(beforeWrite === undefined ? {} : { beforeWrite }),
    });
    if (!done.ok) return done;
    return outcome.current === undefined ? failure('the board change did not run') : ok(outcome.current.value);
  };

  /** The change of `board.json`: read it, edit it, and give the new text. An edit with no top object leaves the text as it is. */
  const boardChange =
    <T>(edit: (doc: BoardDoc) => CliResult<Edit<T>>) =>
    (texts: BoardTexts): CliResult<Applied<BoardEdited<T>>> => {
      const text = textIn(texts, files.board);
      if (!text.ok) return text;
      const doc = parseBoard(text.value, queueKey);
      if (!doc.ok) return doc;
      const edited = edit(doc.value);
      if (!edited.ok) return edited;
      if (edited.value.top === null) {
        return ok({ texts: new Map([[files.board, text.value]]), value: { value: edited.value.value, doc: doc.value } });
      }
      const written = newText(files.board, edited.value.top, (json) => parseBoard(json, queueKey));
      if (!written.ok) return written;
      return ok({ texts: new Map([[files.board, written.value.text]]), value: { value: edited.value.value, doc: written.value.read } });
    };

  /** A write of `board.json`: commit, and find the result in the board after the edit. */
  const boardWrite = async <T, R>(spec: {
    readonly message: string;
    readonly edit: (doc: BoardDoc) => CliResult<Edit<T>>;
    readonly resultOf: (doc: BoardDoc, value: T) => CliResult<R>;
  }): Promise<CliResult<R>> => {
    const done = await commit([files.board], spec.message, boardChange(spec.edit));
    return done.ok ? spec.resultOf(done.value.doc, done.value.value) : done;
  };

  /**
   * The waiting file and the decision log as the helper read them. The board is checked too, so a board with the old queue key or a
   * board that is not valid stops a write of a decision as it stops a write of an item.
   */
  const decisionDocsOf = (texts: BoardTexts): CliResult<{ readonly waiting: WaitingDoc; readonly log: DecisionLogDoc }> => {
    const board = textIn(texts, files.board);
    if (!board.ok) return board;
    const checkedBoard = parseBoard(board.value, queueKey);
    if (!checkedBoard.ok) return checkedBoard;
    const waitingText = textIn(texts, files.waiting);
    if (!waitingText.ok) return waitingText;
    const waiting = parseWaiting(waitingText.value);
    if (!waiting.ok) return waiting;
    const logText = textIn(texts, files.decisionLog);
    if (!logText.ok) return logText;
    const log = parseDecisionLog(logText.value);
    return log.ok ? ok({ waiting: waiting.value, log: log.value }) : log;
  };

  const noPlace = (): Err<CliError> =>
    failure(
      `there is no place for the ${roles.owner} store: no variable names a state folder`,
      `Set ${env.stateHome} or ${env.userHome}, then run "${commandText(options.command)}" again.`,
    );

  /**
   * The D-n of the owner decision file for this node id and this real root. One read of at most 1 MiB, with no lock of the decision
   * file, so it runs under the state lock. A file that cannot be read is exit 1 and names the file and the reason.
   */
  const storedIdsOf = async (place: DecisionPlace): Promise<CliResult<readonly string[]>> => {
    const ids = await decisionIdsOf(deps, place);
    return ids.ok ? ids : failure(ids.error);
  };

  /** A close of a request that has a record in the owner decision file. The close could remove the board copy path of the answer. */
  const answeredCannotClose = (id: string): Err<CliError> =>
    failure(
      `${requestWords.request} ${shown(id)} was answered by the ${roles.owner}, so ${program} does not close it`,
      `To finish the board copy of the answer, run "${commandText(commands.decide)} ${id} <option>" again with the same option.`,
    );

  /** The refusal of a state that decide does not accept. The state is not open, so `requireOpen` gives the error. */
  const refused = (state: RequestState, id: string): Err<CliError> => {
    const open = requireOpen(state, id);
    return open.ok ? failure(`${requestWords.request} ${shown(id)} is not open`) : open;
  };

  /** A number that the waiting file and the log do not hold. The owner decision file can hold it (exit 1). Else it is unknown (exit 2). */
  const unknownRequest = async (place: DecisionPlace, state: RequestState, id: string): Promise<Err<CliError>> => {
    if (place.path === null) return refused(state, id);
    const proof = await readDecisionProof(deps, place, id, NO_REQUEST_TEXT);
    if (proof.kind === 'error') return failure(proof.message);
    if (proof.kind === 'none') return refused(state, id);
    return failure(
      `${files.waiting} has no ${requestWords.request} ${shown(id)}, but the ${roles.owner} decision file holds an answer from ${shown(proof.at)}`,
      addNewRemedy,
    );
  };

  /**
   * A row of the log with a `by` key. The row is a display copy. Only the record in the owner decision file for the request text of
   * the row proves the answer, and a record never lets the number start again, so this is always exit 1.
   */
  const answeredRequest = async (place: DecisionPlace, id: string, requestText: string | null): Promise<Err<CliError>> => {
    const proof = await readDecisionProof(deps, place, id, requestText ?? NO_REQUEST_TEXT);
    if (proof.kind === 'error') return failure(proof.message);
    if (proof.kind === 'record') {
      return failure(
        `${requestWords.request} ${shown(id)} was answered by the ${roles.owner} on ${shown(proof.at.slice(0, DATE_CHARS))}`,
        addNewRemedy,
      );
    }
    return failure(
      `${files.decisionLog}: the row of ${requestWords.request} ${shown(id)} has no ${roles.owner} record, so it is not an ${roles.owner} answer`,
      addNewRemedy,
    );
  };

  /** An open request: the strict read, and the record that the owner decision file holds for its canonical text. */
  const openRequest = async (place: DecisionPlace, waiting: WaitingDoc, id: string): Promise<CliResult<DecisionRequestRead>> => {
    const request = strictRequestOf(waiting, id);
    if (!request.ok) return request;
    const proof = await readDecisionProof(deps, place, id, request.value.canonical);
    return proof.kind === 'error' ? failure(proof.message) : ok({ request: request.value, stored: proof, place });
  };

  /** The folder must be a folder and not a link, as `lstat` sees it. A link is a security stop (exit 4). */
  const requireFolder = async (path: string, what: string): Promise<CliResult<void>> => {
    const kind = await deps.fs.lstat(path);
    if (!kind.ok) return kind;
    if (kind.value === 'link') return safetyRefusal(`${what} is a link, so ${program} does not use it`, LINK_REMEDY);
    return kind.value === 'dir' ? ok(undefined) : failure(`${what} is not a folder`);
  };

  /**
   * Make the folder of the profile records. It runs under the state lock, after every check and before the owner record is written.
   * It looks at the state folder and at the profile folder, makes the one folder `decisions` (its parent is there), and looks at the
   * new folder again, because a path can change after a check.
   */
  const prepareDecisionsFolder = async (): Promise<CliResult<void>> => {
    const state = await requireFolder(layout.stateDir, dirs.state);
    if (!state.ok) return state;
    const profile = await requireFolder(join(layout.stateDir, dirs.profile), dirs.profile);
    if (!profile.ok) return profile;
    const folder = join(layout.stateDir, stateRel.profileDecisions);
    const made = await deps.fs.mkdir(folder);
    if (!made.ok) return made;
    return requireFolder(folder, stateRel.profileDecisions);
  };

  /** The new text of `log.md` must fit in the cap of a file. The remedy is to move old lines out. */
  const requireProfileLogRoom = (text: string): CliResult<void> =>
    Buffer.byteLength(text, 'utf8') > maxFileBytes
      ? failure(
          `${stateRel.profileLog} would be larger than the cap of ${maxFileBytes} bytes`,
          `Move old lines from ${stateRel.profileLog} to another file, commit it, then run "${commandText(options.command)}" again.`,
        )
      : ok(undefined);

  /**
   * The change of an owner answer, under the state lock. It asks nothing and makes no folder. The request is read again and its hash
   * must be the hash that the owner saw. The new texts are the waiting file without the request, the log with the row, the profile
   * record and `log.md`. The value is the path of the profile record.
   */
  const answerChange = (texts: BoardTexts, input: DecisionRecordCall, recordPath: string): CliResult<Applied<string>> => {
    const read = decisionDocsOf(texts);
    if (!read.ok) return read;
    const { id, hash } = input.request;
    const request = recheckRequest(read.value.waiting, read.value.log, id, hash);
    if (!request.ok) return request;
    if ((texts.get(recordPath) ?? null) !== null) {
      return failure(
        `${recordPath} has text already. ${program} does not write over a file`,
        `Rename that file, then run "${commandText(options.command)}" again.`,
      );
    }
    const row = decideLogRow(request.value, input.option, input.at.slice(0, DATE_CHARS));
    if (!row.ok) return row;
    const settled = settleRequestIn(read.value.waiting, read.value.log, id, row.value);
    const waiting = newText(files.waiting, settled.waiting, parseWaiting);
    if (!waiting.ok) return waiting;
    const log = newText(files.decisionLog, settled.log, parseDecisionLog);
    if (!log.ok) return log;
    const room = requireLogRoom(log.value.text);
    if (!room.ok) return room;
    const built = buildDecisionRecord({
      node: options.node,
      request: request.value,
      option: input.option,
      at: input.at,
      note: input.note,
      log: texts.get(stateRel.profileLog) ?? null,
    });
    if (!built.ok) return built;
    const profileRoom = requireProfileLogRoom(built.value.log);
    if (!profileRoom.ok) return profileRoom;
    return ok({
      texts: new Map([
        [files.waiting, waiting.value.text],
        [files.decisionLog, log.value.text],
        [built.value.path, built.value.text],
        [stateRel.profileLog, built.value.log],
      ]),
      value: built.value.path,
    });
  };

  /** The line for a failure that follows the write of the owner record, by the typed outcome of the commit helper. No line for an unknown state. */
  const savedLineOf = (outcome: CommitOutcome | undefined, id: string, option: string): string | null => {
    if (outcome === 'restored') {
      return `The answer is saved in the ${roles.owner} store. Run "${commandText(commands.decide)} ${id} ${option}" again to finish the board copy.`;
    }
    return outcome === 'committed' ? 'The answer is recorded and the commit is made.' : null;
  };

  /**
   * The error of a commit that failed after the owner record was saved: the same error, a remedy line by the outcome,
   * and then the warning of the store write, so a left lock file is named.
   */
  const afterStoreWrite = (error: BoardCommitError, id: string, option: string, warning: string | null): CliError => {
    const lines = [error.hint, savedLineOf(error.commitOutcome, id, option), warning].filter((line): line is string => line !== undefined && line !== null);
    return lines.length === 0 ? error : { ...error, hint: lines.join(' ') };
  };

  const itemIn = (doc: BoardDoc, id: string): CliResult<BoardItem> => {
    const item = doc.items.find((candidate) => candidate.id === id);
    return item === undefined ? failure(`${files.board}: the item ${id} is not on the board after the write`) : ok(item);
  };

  /** A write that gives back one item. */
  const itemWrite = (message: string, edit: (doc: BoardDoc) => CliResult<Edit<string>>): Promise<CliResult<BoardItem>> =>
    boardWrite({ message, edit, resultOf: itemIn });

  /** The file must be a plain file of the factory folder, with no link on the way. The link is a security stop (exit 4). */
  const requireDocFile = async (path: string): Promise<CliResult<void>> => {
    const full = join(layout.home, path);
    const linked = await requireNoLinks(deps, layout.home, [full]);
    if (!linked.ok) return linked;
    const kind = await deps.fs.lstat(full);
    if (!kind.ok) return kind;
    return kind.value === 'file' ? ok(undefined) : usageError(`${JSON.stringify(displayLine(path, maxEchoChars))} is not a file of the ${places.folder}`);
  };

  return {
    kind: options.tracker,

    async addItem(input) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const checked = checkNewItem(setup, input);
      if (!checked.ok) return checked;
      return itemWrite(commitMessages.addItem, (doc) => addItemIn(doc, checked.value));
    },

    async updateItem(id, patch) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const changes = checkPatch(setup, patch);
      if (!changes.ok) return changes;
      return itemWrite(commitMessages.updateItem(id), (doc) => changeItemIn(doc, id, changes.value));
    },

    async moveItem(id, move) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const checked = checkMove(setup, move);
      if (!checked.ok) return checked;
      return boardWrite<ItemMoved, ItemMoved>({
        message: commitMessages.moveItem(id),
        edit: (doc) => moveItemIn(doc, id, checked.value),
        resultOf: (_doc, moved) => ok(moved),
      });
    },

    async closeItem(id) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const closed = checkClose(setup);
      if (!closed.ok) return closed;
      return itemWrite(commitMessages.closeItem(id), (doc) => closeItemIn(doc, id, closed.value));
    },

    async listItems(query) {
      const doc = await readBoard(deps, layout, queueKey);
      if (!doc.ok) return doc;
      if (query.track !== undefined) {
        const track = requireTrack(doc.value, query.track);
        if (!track.ok) return track;
      }
      const closed = options.config?.closed;
      return ok(
        doc.value.items.filter(
          (item) => (query.all || item.status !== closed) && (query.track === undefined || item.track === query.track),
        ),
      );
    },

    async addTrack(input) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const checked = checkNewTrack(input);
      if (!checked.ok) return checked;
      return boardWrite({
        message: commitMessages.addTrack(checked.value.id),
        edit: (doc) => addTrackIn(doc, checked.value),
        resultOf: (doc, id): CliResult<BoardTrack> => {
          const track = doc.tracks.find((candidate) => candidate.id === id);
          return track === undefined ? failure(`${files.board}: the track ${id} is not on the board after the write`) : ok(track);
        },
      });
    },

    async listTracks() {
      const doc = await readBoard(deps, layout, queueKey);
      return doc.ok ? ok(doc.value.tracks) : doc;
    },

    async askDecision(input) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const checked = checkDecision(input);
      if (!checked.ok) return checked;
      const place = await decisionPlaceOf(deps, layout.home, options.node);
      if (!place.ok) return place;
      return commit(decisionFiles, commitMessages.askDecision, async (texts) => {
        const read = decisionDocsOf(texts);
        if (!read.ok) return read;
        const stored = await storedIdsOf(place.value);
        if (!stored.ok) return stored;
        const edited = askIn(read.value.waiting, read.value.log, checked.value, stored.value);
        if (!edited.ok) return edited;
        const written = newText(files.waiting, edited.value.top, parseWaiting);
        if (!written.ok) return written;
        return ok({ texts: new Map([[files.waiting, written.value.text]]), value: edited.value.value });
      });
    },

    async listRequests() {
      const waiting = await readWaiting(deps, layout);
      return waiting.ok ? ok(requestsOf(waiting.value)) : waiting;
    },

    async closeRequest(id) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const valid = checkRequestId(id);
      if (!valid.ok) return valid;
      const place = await decisionPlaceOf(deps, layout.home, options.node);
      if (!place.ok) return place;
      return commit(decisionFiles, commitMessages.closeDecision(id), async (texts) => {
        const read = decisionDocsOf(texts);
        if (!read.ok) return read;
        const stored = await storedIdsOf(place.value);
        if (!stored.ok) return stored;
        const edited = closeRequestIn(read.value.waiting, read.value.log, id, deps.now().toISOString().slice(0, DATE_CHARS));
        if (!edited.ok) return edited;
        if (stored.value.includes(id)) return answeredCannotClose(id);
        const waiting = newText(files.waiting, edited.value.waiting, parseWaiting);
        if (!waiting.ok) return waiting;
        const log = newText(files.decisionLog, edited.value.log, parseDecisionLog);
        if (!log.ok) return log;
        const room = requireLogRoom(log.value.text);
        if (!room.ok) return room;
        return ok({
          texts: new Map([
            [files.waiting, waiting.value.text],
            [files.decisionLog, log.value.text],
          ]),
          value: edited.value.closed,
        });
      });
    },

    async listQueue() {
      const doc = await readBoard(deps, layout, queueKey);
      return doc.ok ? ok(queueRowsOf(doc.value)) : doc;
    },

    async setQueueRow(input) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const checked = checkQueueRow(setup, input);
      if (!checked.ok) return checked;
      return boardWrite<QueueRowSet, QueueRowSet>({
        message: commitMessages.setQueueRow,
        edit: (doc) => setRowIn(doc, setup, checked.value),
        resultOf: (_doc, set) => ok(set),
      });
    },

    async linkDoc(input) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const valid = checkItemId(input.id);
      if (!valid.ok) return valid;
      const path = checkDocPath(input.path);
      if (!path.ok) return path;
      const file = await requireDocFile(path.value);
      if (!file.ok) return file;
      return itemWrite(commitMessages.linkDoc(input.id), (doc) => linkDocIn(doc, input.id, path.value));
    },

    async decisionRequest(id) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const guarded = await requireGuardOn(deps, layout.stateDir);
      if (!guarded.ok) return guarded;
      const read = await readBoardFiles(deps, layout, decisionFiles);
      if (!read.ok) return read;
      const docs = decisionDocsOf(read.value);
      if (!docs.ok) return docs;
      const state = requestStateOf(docs.value.waiting, docs.value.log, id);
      if (!state.ok) return state;
      const current = state.value;
      if (current.kind === 'closed') return refused(current, id);
      const place = await decisionPlaceOf(deps, layout.home, options.node);
      if (!place.ok) return place;
      if (place.value.path === null && current.kind !== 'unknown') return noPlace();
      switch (current.kind) {
        case 'unknown':
          return unknownRequest(place.value, current, id);
        case 'answered':
          return answeredRequest(place.value, id, current.request);
        case 'open':
          return openRequest(place.value, docs.value.waiting, id);
        default: {
          const unreachable: never = current;
          return unreachable;
        }
      }
    },

    async recordDecision(input, writeProof) {
      const local = requireLocalTracker();
      if (!local.ok) return local;
      const { request } = input;
      const path = decisionRecordPath({ id: request.id, title: request.title, at: input.at });
      if (!path.ok) return path;
      const written: { current: DecisionWrite | undefined } = { current: undefined };
      const done = await commit(
        [...decisionFiles, path.value, stateRel.profileLog],
        commitMessages.recordDecision(request.id),
        (texts) => answerChange(texts, input, path.value),
        async () => {
          const folder = await prepareDecisionsFolder();
          if (!folder.ok) return folder;
          // Lock order (M9): the state lock is held by the helper. The writer takes the store lock inside it and frees it first.
          const proof = await writeProof({ id: request.id, option: input.option, hash: request.hash, at: input.at });
          if (!proof.ok) return proof;
          written.current = proof.value;
          return ok(undefined);
        },
      );
      if (!done.ok) {
        return written.current === undefined ? done : err(afterStoreWrite(done.error, request.id, input.option, written.current.warning));
      }
      if (written.current === undefined) return failure(`the board change did not write the ${roles.owner} record`);
      return ok({ id: request.id, option: input.option, path: done.value, outcome: written.current.outcome, warning: written.current.warning });
    },

    async readChanges(): Promise<CliResult<ChangesRead>> {
      return ok({ events: [], cursor: null });
    },
  };
};
