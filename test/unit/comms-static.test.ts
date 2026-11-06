import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summonTimerArgs } from '../../src/launch/tmux.js';
import { allSourceFiles, literalsOf } from '../helpers/source-scan.js';

const SRC = join(__dirname, '..', '..', 'src');
const TYPING = 'comms/typing.ts';

/**
 * The commands of tmux 3.6b with their aliases, as `tmux list-commands -F '#{command_list_name} #{command_list_alias}'` prints
 * them. A newer tmux can add a command, which only makes more words ambiguous, so the words below stay a complete list.
 */
const TMUX_COMMANDS = `
attach-session attach
bind-key bind
break-pane breakp
capture-pane capturep
choose-buffer
choose-client
choose-tree
clear-history clearhist
clear-prompt-history clearphist
clock-mode
command-prompt
confirm-before confirm
copy-mode
customize-mode
delete-buffer deleteb
detach-client detach
display-menu menu
display-message display
display-popup popup
display-panes displayp
find-window findw
has-session has
if-shell if
join-pane joinp
kill-pane killp
kill-server
kill-session
kill-window killw
last-pane lastp
last-window last
link-window linkw
list-buffers lsb
list-clients lsc
list-commands lscm
list-keys lsk
list-panes lsp
list-sessions ls
list-windows lsw
load-buffer loadb
lock-client lockc
lock-server lock
lock-session locks
move-pane movep
move-window movew
new-session new
new-window neww
next-layout nextl
next-window next
paste-buffer pasteb
pipe-pane pipep
previous-layout prevl
previous-window prev
refresh-client refresh
rename-session rename
rename-window renamew
resize-pane resizep
resize-window resizew
respawn-pane respawnp
respawn-window respawnw
rotate-window rotatew
run-shell run
save-buffer saveb
select-layout selectl
select-pane selectp
select-window selectw
send-keys send
send-prefix
server-access
set-buffer setb
set-environment setenv
set-hook
set-option set
set-window-option setw
show-buffer showb
show-environment showenv
show-hooks
show-messages showmsgs
show-options show
show-prompt-history showphist
show-window-options showw
source-file source
split-window splitw
start-server start
suspend-client suspendc
swap-pane swapp
swap-window swapw
switch-client switchc
unbind-key unbind
unlink-window unlinkw
wait-for wait
`;

interface TmuxCommand {
  readonly name: string;
  readonly alias: string | null;
}

const TABLE: readonly TmuxCommand[] = TMUX_COMMANDS.trim()
  .split('\n')
  .map((line) => {
    const [name = '', alias] = line.trim().split(/\s+/);
    return { name, alias: alias ?? null };
  });

/**
 * The commands that put input into a pane, or into the buffer that a paste takes: the keys of a pane, the prefix key, the
 * three commands of the paste buffer, and the pipe of a pane (its `-I` flag writes the output of a command into the pane as
 * input). `run-shell` and `if-shell` are not input commands. A shell text that they run can hold one, and the scan reads such a text.
 */
const INPUT_VERBS = ['send-keys', 'send-prefix', 'paste-buffer', 'set-buffer', 'load-buffer', 'pipe-pane'] as const;

/**
 * The command that tmux runs for a word, or null. This is the rule of the command table of tmux: an alias that equals the word
 * wins; else the exact name; else the one name that starts with the word. A word that starts more than one name is ambiguous.
 */
const resolve = (word: string): string | null => {
  const byAlias = TABLE.find((command) => command.alias === word);
  if (byAlias !== undefined) return byAlias.name;
  if (TABLE.some((command) => command.name === word)) return word;
  const byPrefix = TABLE.filter((command) => command.name.startsWith(word));
  return byPrefix.length === 1 ? (byPrefix[0]?.name ?? null) : null;
};

/** Every word that tmux runs as this command: the name, its alias, and each start of the name that no other command shares. */
const formsOf = (verb: string): string[] => {
  const starts = Array.from({ length: verb.length }, (_, index) => verb.slice(0, index + 1));
  const alias = TABLE.find((command) => command.name === verb)?.alias ?? null;
  return [...new Set([...starts, ...(alias === null ? [] : [alias])])].filter((word) => resolve(word) === verb);
};

const FORMS: ReadonlySet<string> = new Set(INPUT_VERBS.flatMap(formsOf));

/**
 * The input commands that a text holds. The text is a string literal or a shell text. It is cut at semicolons and quotes into
 * commands, and each command into words. A word counts when it is a form of an input command and one of these is true: it has a
 * hyphen (no plain word of text has one of these forms); it follows the word `tmux`; or it is the first word of its command and
 * has no argument, or its next word starts with a hyphen or a percent sign (the start of a flag or of a pane id). So an
 * argument word such as `'send-keys'` and the command inside `run-shell` text are found, and a sentence that starts with the
 * word send or load is not.
 * Limit: a word that is built from pieces at run time (`'send' + '-keys'`) is not found. The review of a change reads that.
 */
const inputWordsIn = (text: string): string[] =>
  text.split(/[;'"`]+/).flatMap((command) => {
    const words = command
      .split(/\s+/)
      .map((word) => word.replace(/^\(+|[.,:)]+$/g, ''))
      .filter((word) => word !== '');
    return words.filter((word, index) => {
      if (!FORMS.has(word)) return false;
      if (word.includes('-') || words[index - 1] === 'tmux') return true;
      return index === 0 && (words.length === 1 || /^[-%]/.test(words[1] ?? ''));
    });
  });

interface Hit {
  readonly file: string;
  readonly literal: string;
  readonly word: string;
}

/** The input commands that the string literals of a source text hold, with the file. */
const hitsIn = (source: string, file: string): Hit[] =>
  literalsOf(source).flatMap((literal) => inputWordsIn(literal).map((word) => ({ file, literal, word })));

/**
 * The literals that are no tmux word, although they equal a form of an input command. Each entry names the file, the literal and
 * the reason. A new entry needs a review of the literal.
 */
const NOT_TMUX_WORDS: readonly { readonly file: string; readonly literal: string; readonly reason: string }[] = [
  { file: 'names.ts', literal: 'load', reason: 'the key of the load of the machine in the facts of the machine check' },
  { file: 'core/node-deps.ts', literal: 'pipe', reason: 'the stdio mode of the output of a child process' },
];

/** The hits that the rule refuses: all of them, except in the typing module and the literals of the list above. */
const refusedHits = (source: string, file: string): Hit[] =>
  file === TYPING
    ? []
    : hitsIn(source, file).filter((hit) => !NOT_TMUX_WORDS.some((kept) => kept.file === hit.file && kept.literal === hit.literal));

describe('TP-16: the words that tmux reads as an input command', () => {
  it('knows the aliases and the unique starts of the six input commands', () => {
    expect(formsOf('send-keys').sort()).toEqual(['send', 'send-k', 'send-ke', 'send-key', 'send-keys']);
    expect(formsOf('send-prefix').sort()).toEqual(['send-p', 'send-pr', 'send-pre', 'send-pref', 'send-prefi', 'send-prefix']);
    expect(formsOf('paste-buffer').sort()).toEqual(
      ['pa', 'pas', 'past', 'paste', 'paste-', 'paste-b', 'paste-bu', 'paste-buf', 'paste-buff', 'paste-buffe', 'paste-buffer', 'pasteb'].sort(),
    );
    expect(formsOf('set-buffer').sort()).toEqual(['set-b', 'set-bu', 'set-buf', 'set-buff', 'set-buffe', 'set-buffer', 'setb']);
    expect(formsOf('load-buffer').sort()).toEqual(
      ['loa', 'load', 'load-', 'load-b', 'load-bu', 'load-buf', 'load-buff', 'load-buffe', 'load-buffer', 'loadb'].sort(),
    );
    expect(formsOf('pipe-pane').sort()).toEqual(
      ['pi', 'pip', 'pipe', 'pipe-', 'pipe-p', 'pipe-pa', 'pipe-pan', 'pipe-pane', 'pipep'].sort(),
    );
  });

  it('leaves out a start that more than one command shares, and a word that is the alias of another command', () => {
    for (const word of ['s', 'se', 'sen', 'send-', 'p', 'set', 'set-', 'l', 'lo', 'loadbuffer']) {
      expect(FORMS.has(word), word).toBe(false);
    }
    expect(resolve('send')).toBe('send-keys');
    expect(resolve('set')).toBe('set-option');
    expect(resolve('lock')).toBe('lock-server');
  });

  it('does not count run-shell and if-shell, and not the commands that the tmux module uses', () => {
    for (const word of ['run-shell', 'run', 'if-shell', 'if', 'capture-pane', 'display-message', 'kill-pane', 'set-option', 'swap-pane']) {
      expect(FORMS.has(word), word).toBe(false);
    }
  });
});

describe('TP-16: the scan of the source texts', () => {
  const sample = join(SRC, 'commands', 'sample.ts');
  /** The words that the scan finds. A text in quotes inside another literal is a literal twice, so each word counts once. */
  const wordsOf = (source: string): string[] => [...new Set(hitsIn(source, sample).map((hit) => hit.word))];

  it.each([
    ["call('send-keys', '-t', pane)", ['send-keys']],
    ["const verb = 'send';", ['send']],
    ["const verb = 'pasteb';", ['pasteb']],
    ["const verb = 'setb';", ['setb']],
    ["const verb = 'loadb';", ['loadb']],
    ["const verb = 'loa';", ['loa']],
    ["const verb = 'send-p';", ['send-p']],
    ["const verb = 'paste-buffer';", ['paste-buffer']],
    ["const verb = 'load-buffer';", ['load-buffer']],
    ["const verb = 'pipe-pane';", ['pipe-pane']],
    ["const verb = 'pipep';", ['pipep']],
    ['const text = `${toolNames.tmux} send-keys -t ${pane} x`;', ['send-keys']],
    ['const text = `${toolNames.tmux} send -t ${pane} x`;', ['send']],
    ['const text = `${toolNames.tmux} paste -t ${pane}`;', ['paste']],
    ["const text = 'sleep 1; tmux set-b x';", ['set-b']],
    ["const text = 'sleep 1; tmux if-shell -F -t %5 1 \"send-keys -t %5 x\"';", ['send-keys']],
    ["const text = \"sleep 1; tmux if-shell -F -t %5 1 'send -t %5 x'\";", ['send']],
    ["const text = 'tmux send -t %5 x';", ['send']],
  ])('finds the input command in %s', (source, words) => {
    expect(wordsOf(source)).toEqual(words);
  });

  it.each([
    ["call('run-shell', '-b', text)"],
    ["call('if-shell', '-F', condition)"],
    ["const a = 'display-message';"],
    ["const a = 'capture-pane';"],
    ["const a = 'send the next task with the other tool';"],
    ["const a = 'load the config file';"],
    ["const a = 'Send it.';"],
    ["const a = 'cannot load -- the file is missing';"],
    ["const a = 'a paste of text';"],
    ["const a = 'load-balancer';"],
    ["const a = 'sender';"],
    ["// call('send-keys', '-t', pane)\nconst a = 1;"],
    ["import { x } from '../comms/send-keys.js';"],
  ])('finds no input command in %s', (source) => {
    expect(wordsOf(source)).toEqual([]);
  });

  it('refuses a planted input command in any module except the typing module', () => {
    const planted = "const args = ['send-keys', '-t', pane, 'Enter'];";
    expect(refusedHits(planted, join(SRC, 'commands', 'sample.ts'))).toHaveLength(1);
    expect(refusedHits(planted, join(SRC, 'launch', 'tmux.ts'))).toHaveLength(1);
    expect(refusedHits(planted, join(SRC, 'comms', 'transport.ts'))).toHaveLength(1);
    expect(refusedHits(planted, TYPING)).toEqual([]);
  });
});

describe('TP-16: the input commands in the source', () => {
  const sources = allSourceFiles(SRC).map((path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') }));

  it('scans the whole source, including the tmux module with the shell text of the summon timer', () => {
    expect(sources.length).toBeGreaterThan(60);
    const tmux = sources.find(({ file }) => file === 'launch/tmux.ts');
    expect(literalsOf(tmux?.source ?? '')).toEqual(expect.arrayContaining(['run-shell']));
    expect(literalsOf(tmux?.source ?? '').some((literal) => literal.includes('if-shell'))).toBe(true);
  });

  it('holds an input command in the typing module only', () => {
    expect(sources.flatMap(({ file, source }) => refusedHits(source, file))).toEqual([]);
    const inTyping = sources.flatMap(({ file, source }) => (file === TYPING ? hitsIn(source, file) : []));
    expect(inTyping.map((hit) => hit.word)).toEqual(['send-keys']);
  });

  it('keeps no entry in the list of literals that are no tmux words once the literal is gone', () => {
    for (const kept of NOT_TMUX_WORDS) {
      const source = sources.find(({ file }) => file === kept.file)?.source ?? '';
      expect(hitsIn(source, kept.file).some((hit) => hit.literal === kept.literal), kept.literal).toBe(true);
    }
  });

  it('keeps the shell text of the summon timer legal: it holds no input command', () => {
    const timer = summonTimerArgs({ seconds: 900, board: '%5', pane: '%3', token: 'ab'.repeat(16) });
    if (!timer.ok) throw new Error(timer.error);
    expect(timer.value.slice(0, 2)).toEqual(['run-shell', '-b']);
    const text = timer.value[2] ?? '';
    expect(text).toContain('if-shell');
    expect(inputWordsIn(text)).toEqual([]);
  });

  it('finds an input command in a shell text of the same form as the summon timer', () => {
    const text = (restore: string): string => `sleep 900; tmux if-shell -F -t %5 '1' '${restore}'; true`;
    expect(inputWordsIn(text('swap-pane -d -s %3 -t %5'))).toEqual([]);
    expect(inputWordsIn(text('send-keys -t %5 -l -- x'))).toEqual(['send-keys']);
    expect(inputWordsIn(text('swap-pane -d -s %3 -t %5 ; paste-buffer -t %5'))).toEqual(['paste-buffer']);
    expect(inputWordsIn(text('send -t %5 x'))).toEqual(['send']);
  });
});
