/**
 * The plain-words table (decision D-11) and the scan of the docs for old words and jargon.
 *
 * Text that a user reads uses the plain word. Code identifiers, config keys, flags and command names stay.
 * `docs/glossary.md` holds the same table, and the plain-words test keeps both equal.
 */

/** How a row is checked. A scanned row has a word that a scan finds with no false hits. */
export type ScanMark = 'scanned' | 'by hand' | '-';

export interface PlainWordRow {
  readonly term: string;
  readonly plain: string;
  readonly scan: ScanMark;
  readonly note: string;
}

export const PLAIN_WORDS: readonly PlainWordRow[] = [
  {
    term: 'changeover',
    plain: 'session reset',
    scan: 'scanned',
    note: 'a clear or a compact between two phases; the commands are `worker reset` and `self reset`',
  },
  {
    term: 'work order',
    plain: 'assignment',
    scan: 'scanned',
    note: 'a written assignment for a worker or a child node; "work item" stays the unit of work, and "task" is not used',
  },
  {
    term: 'variant',
    plain: 'setup',
    scan: 'by hand',
    note: 'the key `variant` stays until FAC-M6, when the setup folder replaces the variant; so both name one thing',
  },
  { term: 'heartbeat', plain: 'last seen', scan: 'scanned', note: 'the file name stays' },
  { term: 'bench window', plain: 'worker window', scan: 'scanned', note: 'the tmux window name becomes `workers`' },
  { term: 'outbox', plain: 'event file', scan: 'scanned', note: '' },
  { term: 'adapter', plain: 'board connector', scan: 'scanned', note: '' },
  { term: 'home index', plain: 'factory list', scan: 'scanned', note: 'the per-user list of registered factories' },
  {
    term: 'home, root (of a factory)',
    plain: 'factory folder',
    scan: 'by hand',
    note: '`--home` and `FACTORY_HOME` stay',
  },
  { term: 'registered root', plain: 'registered factory', scan: 'scanned', note: '' },
  {
    term: 'state marker',
    plain: 'factory marker',
    scan: 'scanned',
    note: '`.factory/node.json`; "state file" is not used, because the state folder holds many files, and "node file" is not used, because it does not say which file (D-11)',
  },
  { term: 'root rule', plain: 'registration check', scan: 'scanned', note: '' },
  { term: 'allow list', plain: 'share list', scan: 'scanned', note: 'the factory part of the root `.gitignore`' },
  { term: 'owner record', plain: 'approval record', scan: 'scanned', note: '' },
  {
    term: 'owner channel',
    plain: 'owner input',
    scan: 'scanned',
    note: 'typed input that starts with the owner prefix',
  },
  { term: 'core block', plain: 'fixed rules', scan: 'scanned', note: 'the safety block' },
  {
    term: 'trust step',
    plain: 'setup acceptance',
    scan: 'scanned',
    note: 'the verb is "accept", not "approve"; the acceptance of the setup hash (D-13) is its first part, and FAC-M6 extends it to every setup file; "approval" means only approval points and approval records (D-11)',
  },
  { term: 'tracker', plain: 'board', scan: 'by hand', note: 'the key `tracker` stays' },
  {
    term: 'checkouts',
    plain: 'work copies',
    scan: 'by hand',
    note: 'the folder name is `work-copies` (D-11 replaces D-6 `checkouts`); code identifiers can keep a short internal name, but user text, docs and the folder say `work-copies`; "checkout" is also a common git word, so the row is by hand',
  },
  {
    term: 'release scope',
    plain: '(software recipe word)',
    scan: 'scanned',
    note: 'glossary entry in the recipe part of the glossary; the scan of `src` finds it outside `src/recipes`, and the docs scan leaves it, because the design text of the software recipe uses it',
  },
  {
    term: 'received factory',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a factory folder that you cloned from a config repo of another machine or person',
  },
  {
    term: 'moved factory',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a factory folder that is now at another path on this machine',
  },
  {
    term: 'setup acceptance',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: your yes to the setup text, and on a received factory to the other files that its config repo tracks, for one hash; the command line says "accept"',
  },
  {
    term: 'factory marker',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: the file `.factory/node.json`, which shows that `init` made this factory folder',
  },
  {
    term: 'hash',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a short code that changes when the text of a file changes; output shows it next to the file name',
  },
  {
    term: 'trust boundary',
    plain: 'stays in the design text only',
    scan: '-',
    note: 'glossary entry: the point where factory stops trusting files that came from another machine or person; command output does not use it, and names the check, the file and the fix',
  },
  {
    term: 'session marker',
    plain: '(not in user text)',
    scan: '-',
    note: '`FACTORY_SESSION` stays; user text says "inside a factory session"',
  },
  {
    term: 'permission-skip list',
    plain: 'a setting that skips permission prompts',
    scan: 'scanned',
    note: 'the list name stays in code (`src/names.ts`)',
  },
  {
    term: 'token-like value',
    plain: 'a value that looks like a password or a token',
    scan: 'scanned',
    note: '',
  },
  {
    term: 'link rule',
    plain: '(not in user text)',
    scan: '-',
    note: 'user text says "symbolic link" and "replace the link with a plain file"',
  },
  { term: 'remedy line', plain: '(not in user text)', scan: '-', note: 'user text is the remedy command itself' },
  {
    term: 'security stop',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a check that stops the command (exit 4) to keep private data, credentials or session rules safe, and prints one remedy command',
  },
  {
    term: 'block backup',
    plain: 'backup file',
    scan: 'by hand',
    note: 'the file name in the state folder names the block and the time',
  },
  {
    term: 'effective mode',
    plain: '(not in user text)',
    scan: '-',
    note: 'user text says "owner" or "delegated" for each approval point',
  },
  {
    term: 'manifest',
    plain: '(not in user text)',
    scan: '-',
    note: 'user text says "the accepted files" and lists each added, removed and changed file by name',
  },
  {
    term: 'registration record',
    plain: '(not in user text)',
    scan: '-',
    note: 'user text says "your entry in the factory list"',
  },
  {
    term: 'origin `own`, `received`',
    plain: 'your own factory, received factory',
    scan: 'by hand',
    note: 'the field values stay in the factory list file; output says "your own factory" or "received factory"',
  },
  {
    term: 'setup block, role block',
    plain: '(not in user text)',
    scan: '-',
    note: 'user text names the file: "your coordinator text from setup/coordinator.md" and "the role text"',
  },
  {
    term: 'TTY',
    plain: 'terminal window',
    scan: 'by hand',
    note: 'user text says "in a terminal window"; the remedy line says "run factory init in a terminal window"',
  },
  {
    term: 'accept prompt',
    plain: '(not in user text)',
    scan: '-',
    note: 'the prompt asks "Accept these files?" and lists them',
  },
  { term: 'delegated', plain: 'stays', scan: '-', note: 'glossary entry: the coordinator approves for the owner' },
  {
    term: 'approval point',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a step of the work that needs an approval',
  },
  {
    term: 'proxy',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: a server that passes the model calls on',
  },
  {
    term: 'recipe',
    plain: 'stays',
    scan: '-',
    note: 'glossary entry: the kind of work that a factory does',
  },
  { term: 'setup, layer', plain: 'stay', scan: '-', note: "Dean's own words (F-4, F-16)" },
  { term: 'message', plain: 'stays', scan: '-', note: 'only for the record from another owner (D-6)' },
  {
    term: 'doctor, `STUCK:`',
    plain: 'stay',
    scan: '-',
    note: 'command name and output marker; the help line and the `STUCK:` line say in plain words what they mean',
  },
  { term: 'node, owner, project', plain: 'stay', scan: '-', note: "Dean's words (F-1)" },
];

/**
 * The eight words that D-59 replaced. `test/helpers/old-words.ts` has the list for the scan of `src`: it holds only three
 * of these words until Step 8 of the code change adds the other five.
 */
export const OLD_WORD_LIST = ['lane', 'pack', 'brief', 'cell', 'andon', 'staging', 'inspect', 'ship'] as const;

/** An old word, also as a plural, a past form or an -ing form (shipped, shipping, packed, briefing). */
const oldWordPattern = (word: string): string => `${word}(?:s|es|ed|ing|ped|ping)?`;

export const OLD_WORDS_DESIGN_SCAN = new RegExp(
  `(?<![A-Za-z0-9_])(?:${OLD_WORD_LIST.map(oldWordPattern).join('|')})(?![A-Za-z0-9_])`,
  'gi',
);

/** A scanned jargon row with the pattern that finds its word in the docs. */
export interface JargonPattern {
  readonly term: string;
  readonly pattern: RegExp;
}

const jargon = (term: string, source: string): JargonPattern => ({
  term,
  pattern: new RegExp(`(?<![A-Za-z0-9_])${source}(?![A-Za-z0-9_])`, 'gi'),
});

/**
 * The scanned jargon rows of the table that the docs scan finds. The row `release scope` is not here: the design text of
 * the software recipe uses it, and the scan of the source folders finds it outside `src/recipes`.
 */
export const JARGON_PATTERNS: readonly JargonPattern[] = [
  jargon('changeover', 'changeovers?'),
  jargon('work order', 'work orders?'),
  jargon('heartbeat', 'heartbeats?'),
  jargon('bench window', 'bench windows?'),
  jargon('outbox', 'outbox(?:es)?'),
  jargon('adapter', 'adapters?'),
  jargon('home index', 'home index(?:es)?'),
  jargon('registered root', 'registered roots?'),
  jargon('state marker', 'state markers?'),
  jargon('root rule', 'root rules?'),
  jargon('allow list', 'allow[ -]lists?'),
  jargon('owner record', 'owner records?'),
  jargon('owner channel', 'owner channels?'),
  jargon('core block', 'core blocks?'),
  jargon('trust step', 'trust steps?'),
  jargon('permission-skip list', 'permission[ -]skip lists?'),
  jargon('token-like value', 'token-like values?'),
];

/** The docs that the scan reads in the docs change. */
export const SCANNED_DOCS = ['design.md', 'roadmap-v2.md', 'token-budget.md', 'intent-trace.md', 'glossary.md'] as const;

/**
 * A row of the trace that keeps an old word on purpose, in its quote cell (the second column). The docs review reads this
 * list.
 */
export interface AllowedLine {
  readonly file: string;
  /** The line starts with this text. */
  readonly startsWith: string;
  readonly reason: string;
}

const OWNER_NOTE =
  'the row quotes a note of the owner, and the note holds the old word; the intent check compares the row with his own words; the scan reads the other cells of the row';

/** The rows of the docs that keep an old word in the quote cell, each with its reason. */
export const ALLOWED_LINES: readonly AllowedLine[] = [
  { file: 'intent-trace.md', startsWith: '| F-1a |', reason: OWNER_NOTE },
  { file: 'intent-trace.md', startsWith: '| F-14b |', reason: OWNER_NOTE },
  { file: 'intent-trace.md', startsWith: '| V-F-1b |', reason: OWNER_NOTE },
  { file: 'intent-trace.md', startsWith: '| V-F-1c |', reason: OWNER_NOTE },
];

/** The doc whose entries show the old word of a new word in the form `(was: old word)`. */
export const WAS_MARK_FILE = 'glossary.md';

/**
 * The mark `(was: old word)` right after the bold term of a glossary entry, for example `- **worker** (was: cell): ...`.
 * The old word is letters, spaces and hyphens, at most 30 characters. The first group is the part of the line that stays.
 */
const WAS_MARK = /^(- \*\*[^*]+\*\*) \(was: [A-Za-z][A-Za-z -]{0,29}\)/;

export interface DocHit {
  readonly file: string;
  readonly line: number;
  readonly word: string;
  readonly kind: 'old word' | 'jargon' | 'open fence';
}

/** The header of the plain-words table in `docs/glossary.md`. */
export const TABLE_HEADER = '| Term | Plain word in user text | Scan | Note |';

/** Removes the code spans of one line: text between backticks, also between double backticks. */
const withoutCodeSpans = (line: string): string => line.replace(/(`+)[^`]*?\1/g, ' ');

/** Removes the quote cell of a table row: the second column, after the id cell. The line keeps its other cells. */
const withoutQuoteCell = (line: string): string =>
  line
    .split('|')
    .map((cell, index) => (index === 2 ? ' ' : cell))
    .join('|');

/** Removes the `(was: old word)` mark of a glossary entry. A mark in another doc, or after the first words, stays. */
const withoutWasMark = (file: string, line: string): string =>
  file === WAS_MARK_FILE ? line.replace(WAS_MARK, '$1') : line;

/**
 * A fence starts at column 0, the same rule as the awk checks of `scripts/check-intent-docs.sh`. An indented fence line
 * is text.
 */
const FENCE_LINE = /^```/;

/**
 * The hits of one doc: an old word or a scanned jargon word outside fenced code, outside code spans, outside the mapping
 * tables of design 7 and 7.1 and outside the plain-words table. A fence that does not close is a hit at the line of its
 * opening fence, because the scan would otherwise skip every line after it. The allow list skips only the quote cell of a
 * trace row. A glossary entry may show the old word that its word replaces, only in the mark `(was: old word)` after its
 * bold term; the scan skips that mark and reads the rest of the entry.
 */
export const scanDoc = (file: string, text: string): DocHit[] => {
  const hits: DocHit[] = [];
  const lines = text.split('\n');
  let fenced = false;
  let openFenceLine = 0;
  let inGeneric = false;
  let inPlainWords = false;
  lines.forEach((raw, index) => {
    if (FENCE_LINE.test(raw)) {
      fenced = !fenced;
      if (fenced) openFenceLine = index + 1;
      return;
    }
    if (fenced) return;
    if (/^## 7\. /.test(raw)) inGeneric = true;
    else if (/^## /.test(raw)) inGeneric = false;
    if (raw === TABLE_HEADER) inPlainWords = true;
    else if (inPlainWords && !raw.startsWith('|')) inPlainWords = false;
    if (inPlainWords) return;
    if (file === 'design.md' && inGeneric && raw.startsWith('|')) return;
    const allowed = ALLOWED_LINES.find((entry) => entry.file === file && raw.startsWith(entry.startsWith));
    const readable = allowed === undefined ? raw : withoutQuoteCell(raw);
    const line = withoutCodeSpans(withoutWasMark(file, readable));
    for (const word of line.match(OLD_WORDS_DESIGN_SCAN) ?? []) {
      hits.push({ file, line: index + 1, word, kind: 'old word' });
    }
    for (const { pattern } of JARGON_PATTERNS) {
      for (const word of line.match(pattern) ?? []) hits.push({ file, line: index + 1, word, kind: 'jargon' });
    }
  });
  if (fenced) hits.push({ file, line: openFenceLine, word: '```', kind: 'open fence' });
  return hits;
};
