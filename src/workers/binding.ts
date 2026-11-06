import { ADD_DIR_FLAG, coordinatorLaunchMarks, workerLaunchMarks, type LaunchMarks } from '../launch/argv.js';
import { paneBinding } from '../names.js';

/**
 * The check that a pane was started for a worker (design 4.11, "The pane of a worker"). The worker mark of a pane is text that a
 * program in any pane can set on any pane, so the mark alone never names the pane of a worker. tmux fixes the start command of
 * a pane when it makes the pane, and no program in the pane can change it (only `respawn-pane` does, and it ends the program of
 * the pane first). The launch of a worker puts words in that command that only this launch puts together: the variables of the
 * home, of the session and of the inbox, and the inbox as the one added folder. A pane is bound to a worker when its start
 * command holds all of them as whole words.
 */

/** The characters that tmux writes after a backslash, for the character itself. */
const LITERAL_AFTER_BACKSLASH: ReadonlySet<string> = new Set(['\\', '"', "'", '$', '~', ' ', '#', ';', '{', '}', '%']);

/** The letters that tmux writes after a backslash for a control character. */
const CONTROL_AFTER_BACKSLASH: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['a', '\u0007'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
]);

const OCTAL_ESCAPE = /^[0-7]{3}$/;
const OCTAL_DIGITS = 3;
const OCTAL_BASE = 8;

interface Escape {
  readonly char: string;
  /** The count of characters after the backslash that the escape uses. */
  readonly length: number;
}

/** The escape that starts at `at`, just after a backslash: one of the forms that tmux writes, or null for any other form. */
const escapeAt = (text: string, at: number): Escape | null => {
  const next = text.charAt(at);
  if (LITERAL_AFTER_BACKSLASH.has(next)) return { char: next, length: 1 };
  const control = CONTROL_AFTER_BACKSLASH.get(next);
  if (control !== undefined) return { char: control, length: 1 };
  const octal = text.slice(at, at + OCTAL_DIGITS);
  return OCTAL_ESCAPE.test(octal) ? { char: String.fromCharCode(Number.parseInt(octal, OCTAL_BASE)), length: OCTAL_DIGITS } : null;
};

/** Where a reader of the text is: between words, in a word with no quote, in a quoted word, or just after the closing quote. */
type Mode = 'between' | 'plain' | 'quoted' | 'closed';

const isQuote = (char: string): boolean => char === '"' || char === "'";

/**
 * The words of the start command of a pane, as `#{pane_start_command}` shows it: words that are parted by one space, a word with a
 * space or a mark of the shell in double quotes, a word with a double quote in single quotes, and a backslash before a character
 * that tmux escapes. The value is null for a text of any other form (a quote that is not closed, a quote in the middle of a word,
 * an escape that tmux does not write, a text or a count of words above the bounds): tmux writes none of these, so the caller
 * trusts none of them. The loop takes one character of the text for each pass, so it ends.
 */
export const wordsOfStartCommand = (text: string): readonly string[] | null => {
  if (text.length > paneBinding.maxStartCommandChars) return null;
  const words: string[] = [];
  let word = '';
  let mode: Mode = 'between';
  let quote = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (mode === 'quoted' && char === quote) {
      mode = 'closed';
      index += 1;
    } else if (char === ' ' && mode !== 'quoted') {
      if (mode !== 'between') {
        words.push(word);
        if (words.length > paneBinding.maxWords) return null;
      }
      word = '';
      mode = 'between';
      index += 1;
    } else if (mode === 'closed' || (mode === 'plain' && isQuote(char))) {
      return null;
    } else if (mode === 'between' && isQuote(char)) {
      mode = 'quoted';
      quote = char;
      index += 1;
    } else if (char === '\\') {
      const escape = escapeAt(text, index + 1);
      if (escape === null) return null;
      word += escape.char;
      mode = mode === 'between' ? 'plain' : mode;
      index += 1 + escape.length;
    } else {
      word += char;
      mode = mode === 'between' ? 'plain' : mode;
      index += 1;
    }
  }
  if (mode === 'quoted') return null;
  if (mode !== 'between') words.push(word);
  return words.length > paneBinding.maxWords ? null : words;
};

/** True when the start command holds every variable of the marks as a whole word, and the folder of the marks right after the add-dir flag. */
const holdsMarks = (startCommand: string, { variables, folder }: LaunchMarks): boolean => {
  const words = wordsOfStartCommand(startCommand);
  if (words === null) return false;
  const hasFolder = words.some((word, index) => word === ADD_DIR_FLAG && words[index + 1] === folder);
  return hasFolder && variables.every((variable) => words.includes(variable));
};

/** True when the start command of a pane shows that the launch of this worker, in this factory folder, made the pane. */
export const startsWorker = (startCommand: string, home: string, workerId: string): boolean =>
  holdsMarks(startCommand, workerLaunchMarks(home, workerId));

/**
 * True when the start command of a pane shows that the launch of the coordinator of this node, in this factory folder, made the
 * pane: the home and the node id as variables, and the state folder as an added folder. The name of the session and the project
 * folders are not marks, so a start command without them still binds.
 */
export const startsCoordinator = (startCommand: string, home: string, nodeId: string, stateDir: string): boolean =>
  holdsMarks(startCommand, coordinatorLaunchMarks(home, nodeId, stateDir));
