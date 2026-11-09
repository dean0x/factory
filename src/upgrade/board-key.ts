import { boardJsonText } from '../board/json.js';
import { failure, type CliResult } from '../cli/errors.js';
import { ok } from '../core/result.js';
import { isRecord } from '../migrate/inspect.js';
import { boardKeys, commands, commandText, files } from '../names.js';
import { parseJsonText } from '../state/load.js';

/**
 * The rename of the queue key in the text of the board file. An old board holds the queue under the default key of the core, and the
 * recipe of the factory may give another key. The rename changes the one quoted key and keeps every other byte: the key order, the
 * layout, the numbers and the text of the items.
 */

const BOARD = files.board;
const OLD_KEY = boardKeys.defaultQueue;
const AGAIN = `then run "${commandText(commands.upgrade)}" again.`;

const JSON_SPACE = /[ \t\n\r]/;

/** A key of the top level, with the place of its quoted token in the text: from `start` up to, and not with, `end`. */
interface KeyToken {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The keys of the top-level object of a JSON text, in order. The text is valid JSON, so a string is a key of the top level exactly
 * when it is at depth 1 and a colon follows it. The scan visits each character once.
 */
const topLevelKeys = (text: string): readonly KeyToken[] => {
  const found: KeyToken[] = [];
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char !== '"') {
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') depth -= 1;
      at += 1;
      continue;
    }
    const start = at;
    at += 1;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at += 1;
    let next = at;
    while (next < text.length && JSON_SPACE.test(text[next] ?? '')) next += 1;
    if (depth !== 1 || text[next] !== ':') continue;
    const key = parseJsonText(text.slice(start, at));
    if (key.ok && typeof key.value === 'string') found.push({ key: key.value, start, end: at });
  }
  return found;
};

const unreadable = (reason: string): CliResult<never> => failure(`cannot read ${BOARD}: ${reason}`, `Repair ${BOARD}, ${AGAIN}`);

/**
 * The text of the board with the old queue key renamed to `queueKey`, or null when nothing is to rename: the board has no old key, or
 * the key of the recipe is the old key. A text that is not a board object, a board with both keys and a board that holds the old key
 * twice are failures (exit 1) that name the file. Nothing is written here.
 */
export const renameQueueKey = (text: string, queueKey: string): CliResult<string | null> => {
  const parsed = parseJsonText(text);
  if (!parsed.ok) return unreadable(parsed.error);
  if (!isRecord(parsed.value)) return unreadable('the top level is not an object');
  if (queueKey === OLD_KEY || !Object.hasOwn(parsed.value, OLD_KEY)) return ok(null);
  if (Object.hasOwn(parsed.value, queueKey)) {
    return failure(`${BOARD} has both the key "${OLD_KEY}" and the key "${queueKey}"`, `Remove the key that is wrong, ${AGAIN}`);
  }
  const [token, ...more] = topLevelKeys(text).filter((entry) => entry.key === OLD_KEY);
  if (more.length > 0) return failure(`${BOARD} holds the key "${OLD_KEY}" twice`, `Remove one of the two, ${AGAIN}`);
  if (token === undefined) return unreadable(`the key "${OLD_KEY}" is not in the text`);
  const key = boardJsonText(queueKey);
  if (!key.ok) return key;
  return ok(`${text.slice(0, token.start)}${key.value.trimEnd()}${text.slice(token.end)}`);
};
