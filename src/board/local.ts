import { join } from 'node:path';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine } from '../cli/output.js';
import type { BoardConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { requireNoLinks } from '../core/root-paths.js';
import { files, maxEchoChars, places, values, type CommandName } from '../names.js';
import type { RecipeBoard } from '../recipes/entry.js';
import { commitBoardChange, type BoardTexts } from '../state/board-commit.js';
import type { Layout } from '../state/layout.js';
import type { BoardConnector, BoardItem, BoardTrack, ChangesRead, ItemMoved } from './contract.js';
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
  closeItemIn,
  linkDocIn,
  moveItemIn,
  requireTrack,
  type BoardSetup,
  type Edit,
} from './edit.js';
import { parseBoard, parseDecisionLog, parseWaiting, readBoard, type BoardDoc } from './files.js';
import { boardJsonText } from './json.js';

/**
 * The local board connector (design 4.10): the board is the files of the state folder. Every write is one `commitBoardChange` call:
 * the callback reads the files that the helper gives it, builds the new text and returns it, so the helper checks the guard, the size
 * and the item ids, writes the files and makes one state commit. A read takes no lock.
 *
 * A hosted tracker kind (`github`, `jira` or `linear`) gets a copy of each write that made a commit. The local files are written
 * first, the copy runs after the lock is free, and a copy that fails keeps the local commit. One warning line says that the local
 * file governs. A write that fails or changes nothing makes no copy.
 */

/** What a write did, in the words of the copy. */
export type TrackerAction = 'item added' | 'item updated' | 'item moved' | 'item closed' | 'track added' | 'doc linked' | 'decision asked';

/** One write that the local files hold already, for the copy to a hosted tracker. `id` is the item, the track or the decision. */
export interface TrackerWrite {
  readonly what: TrackerAction;
  readonly id: string;
}

/** The copy of a write to a hosted tracker. A hosted connector (FAC-M3) implements it; the tests use doubles. */
export interface TrackerCopy {
  /** The tracker kind of the setup. The kind `local` is never copied. */
  readonly kind: string;
  copy(write: TrackerWrite): Promise<CliResult<void>>;
}

/** The copy of this version for a hosted kind: no hosted connector exists yet, so the copy fails and the warning says so. */
export const unbuiltTracker = (kind: string): TrackerCopy => ({
  kind,
  copy: async () => failure(`there is no ${kind} board connector in this version`),
});

export interface LocalBoardOptions {
  /** The key of the queue in `board.json`: `queueKeyOf` of the recipe. */
  readonly queueKey: string;
  /** The stage data of the recipe. */
  readonly recipe: RecipeBoard;
  /** The `board` block of the config, or undefined when the setup has none. */
  readonly config: BoardConfig | undefined;
  /** The command that a stop tells the person to run again. */
  readonly command: CommandName;
  /** The hosted tracker that gets a copy of each write. Absent or of the kind `local`: no copy. */
  readonly tracker?: TrackerCopy;
}

const commitMessages = {
  addItem: 'chore: add an item to the board',
  updateItem: (id: string): string => `chore: change item ${id}`,
  moveItem: (id: string): string => `chore: move item ${id}`,
  closeItem: (id: string): string => `chore: close item ${id}`,
  linkDoc: (id: string): string => `chore: link a file to item ${id}`,
  addTrack: (id: string): string => `chore: add track ${id}`,
  askDecision: 'chore: add a decision to the board',
} as const;

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

interface Written<T> {
  readonly value: T;
  /** False when the write left every file as it was: there is no commit. */
  readonly committed: boolean;
}

/** The edit of the board and the board after it, which the connector reads the result from. */
interface BoardEdited<T> {
  readonly value: T;
  readonly doc: BoardDoc;
}

const copyWarning = (kind: string, id: string, copied: CliResult<void>): string => {
  const governs = 'The local file governs.';
  const saved = `${id} is saved in the local files`;
  const where = `the ${displayLine(kind, maxEchoChars)} board`;
  return copied.ok
    ? `${saved} and copied to ${where}. ${governs}`
    : `${saved}, but the copy to ${where} failed: ${displayLine(copied.error.message)}. ${governs}`;
};

export const createLocalBoard = (deps: Deps, layout: Layout, options: LocalBoardOptions): BoardConnector => {
  const { queueKey } = options;
  const setup: BoardSetup = { recipe: options.recipe, config: options.config };
  const hosted = options.tracker !== undefined && options.tracker.kind !== values.trackerLocal ? options.tracker : undefined;

  /** Copy a write that made a commit to the hosted tracker, outside the lock, and print the one warning line. */
  const copyTo = async (what: TrackerAction, id: string): Promise<void> => {
    if (hosted === undefined) return;
    deps.warn(copyWarning(hosted.kind, id, await hosted.copy({ what, id })));
  };

  /** One `commitBoardChange` call. The value of the change reaches the caller through the closure, because the helper gives back only whether it committed. */
  const commit = async <T>(
    touched: readonly string[],
    message: string,
    apply: (texts: BoardTexts) => CliResult<Applied<T>>,
  ): Promise<CliResult<Written<T>>> => {
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
    return outcome.current === undefined
      ? failure('the board change did not run')
      : ok({ value: outcome.current.value, committed: done.value.committed });
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

  /** A write of `board.json`: commit, find the result in the board after the edit, and copy to a hosted tracker when a commit was made. */
  const boardWrite = async <T, R>(spec: {
    readonly message: string;
    readonly what: TrackerAction;
    readonly edit: (doc: BoardDoc) => CliResult<Edit<T>>;
    readonly idOf: (value: T) => string;
    readonly resultOf: (doc: BoardDoc, value: T) => CliResult<R>;
  }): Promise<CliResult<R>> => {
    const done = await commit([files.board], spec.message, boardChange(spec.edit));
    if (!done.ok) return done;
    const { value, committed } = done.value;
    const result = spec.resultOf(value.doc, value.value);
    if (!result.ok) return result;
    if (committed) await copyTo(spec.what, spec.idOf(value.value));
    return result;
  };

  const itemIn = (doc: BoardDoc, id: string): CliResult<BoardItem> => {
    const item = doc.items.find((candidate) => candidate.id === id);
    return item === undefined ? failure(`${files.board}: the item ${id} is not on the board after the write`) : ok(item);
  };

  /** A write that gives back one item. */
  const itemWrite = (message: string, what: TrackerAction, edit: (doc: BoardDoc) => CliResult<Edit<string>>): Promise<CliResult<BoardItem>> =>
    boardWrite({ message, what, edit, idOf: (id) => id, resultOf: itemIn });

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
    kind: options.tracker?.kind ?? values.trackerLocal,

    async addItem(input) {
      const checked = checkNewItem(setup, input);
      if (!checked.ok) return checked;
      return itemWrite(commitMessages.addItem, 'item added', (doc) => addItemIn(doc, checked.value));
    },

    async updateItem(id, patch) {
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const changes = checkPatch(setup, patch);
      if (!changes.ok) return changes;
      return itemWrite(commitMessages.updateItem(id), 'item updated', (doc) => changeItemIn(doc, id, changes.value));
    },

    async moveItem(id, move) {
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const checked = checkMove(setup, move);
      if (!checked.ok) return checked;
      return boardWrite<ItemMoved, ItemMoved>({
        message: commitMessages.moveItem(id),
        what: 'item moved',
        edit: (doc) => moveItemIn(doc, id, checked.value),
        idOf: (moved) => moved.id,
        resultOf: (_doc, moved) => ok(moved),
      });
    },

    async closeItem(id) {
      const valid = checkItemId(id);
      if (!valid.ok) return valid;
      const closed = checkClose(setup);
      if (!closed.ok) return closed;
      return itemWrite(commitMessages.closeItem(id), 'item closed', (doc) => closeItemIn(doc, id, closed.value));
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
      const checked = checkNewTrack(input);
      if (!checked.ok) return checked;
      return boardWrite({
        message: commitMessages.addTrack(checked.value.id),
        what: 'track added',
        edit: (doc) => addTrackIn(doc, checked.value),
        idOf: (id) => id,
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
      const checked = checkDecision(input);
      if (!checked.ok) return checked;
      // The board is read too, so a board with the old queue key or a board that is not valid stops a decision as it stops an item.
      const done = await commit([files.waiting, files.decisionLog, files.board], commitMessages.askDecision, (texts) => {
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
        if (!log.ok) return log;
        const edited = askIn(waiting.value, log.value, checked.value);
        if (!edited.ok) return edited;
        const written = newText(files.waiting, edited.value.top, parseWaiting);
        if (!written.ok) return written;
        return ok({ texts: new Map([[files.waiting, written.value.text]]), value: edited.value.value });
      });
      if (!done.ok) return done;
      if (done.value.committed) await copyTo('decision asked', done.value.value);
      return ok(done.value.value);
    },

    async linkDoc(input) {
      const valid = checkItemId(input.id);
      if (!valid.ok) return valid;
      const path = checkDocPath(input.path);
      if (!path.ok) return path;
      const file = await requireDocFile(path.value);
      if (!file.ok) return file;
      return itemWrite(commitMessages.linkDoc(input.id), 'doc linked', (doc) => linkDocIn(doc, input.id, path.value));
    },

    async readChanges(): Promise<CliResult<ChangesRead>> {
      return ok({ events: [], cursor: null });
    },
  };
};
