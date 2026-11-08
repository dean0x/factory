import { join } from 'node:path';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { BoardConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { commandText, files, hostedBoardLine, maxEchoChars, places, values, type CommandName } from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';
import { commitBoardChange, type BoardTexts } from '../state/board-commit.js';
import type { Layout } from '../state/layout.js';
import type { BoardItem, BoardTrack, ChangesRead, ItemMoved, LocalBoard, QueueRowSet } from './contract.js';
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
 * A hosted tracker kind (`github`, `jira` or `linear`) keeps the truth of the board at the provider, and the local files are a cache of
 * it. This version has no provider, so every write of a hosted kind stops with a security stop (exit 4) before the input check and
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
  setQueueRow: 'chore: change the queue',
} as const;

/** The files of a write of a decision. The board is among them, so the check of its queue key runs under the lock. */
const decisionFiles = [files.waiting, files.decisionLog, files.board] as const;

/** The date of a row of the decision log is the first 10 characters of an ISO time: `2030-01-02`. */
const DATE_CHARS = 10;

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

  /** One `commitBoardChange` call. The value of the change reaches the caller through the closure, because the helper gives back only whether it committed. */
  const commit = async <T>(
    touched: readonly string[],
    message: string,
    apply: (texts: BoardTexts) => CliResult<Applied<T>>,
  ): Promise<CliResult<T>> => {
    const outcome: { current: { readonly value: T } | undefined } = { current: undefined };
    const done = await commitBoardChange(deps, layout, {
      touched,
      command: options.command,
      message,
      change: async (texts) => {
        const applied = apply(texts);
        if (!applied.ok) return applied;
        outcome.current = { value: applied.value.value };
        return ok(applied.value.texts);
      },
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
      return commit(decisionFiles, commitMessages.askDecision, (texts) => {
        const read = decisionDocsOf(texts);
        if (!read.ok) return read;
        const edited = askIn(read.value.waiting, read.value.log, checked.value);
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
      return commit(decisionFiles, commitMessages.closeDecision(id), (texts) => {
        const read = decisionDocsOf(texts);
        if (!read.ok) return read;
        const edited = closeRequestIn(read.value.waiting, read.value.log, id, deps.now().toISOString().slice(0, DATE_CHARS));
        if (!edited.ok) return edited;
        const waiting = newText(files.waiting, edited.value.waiting, parseWaiting);
        if (!waiting.ok) return waiting;
        const log = newText(files.decisionLog, edited.value.log, parseDecisionLog);
        if (!log.ok) return log;
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

    async readChanges(): Promise<CliResult<ChangesRead>> {
      return ok({ events: [], cursor: null });
    },
  };
};
