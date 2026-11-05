import { describe, expect, it } from 'vitest';
import { launchArgv, stripScript, workerLaunchArgv } from '../../src/launch/argv.js';
import { paneBinding } from '../../src/names.js';
import { startsWorker, wordsOfStartCommand } from '../../src/workers/binding.js';
import { startCommandText } from '../helpers/tmux-fake.js';

const HOME = '/w/node';

const session = { effort: 'high', model: 'default', proxyBaseUrl: null, path: '/bin', agent: 'claude' } as const;

/** The start command that tmux shows for the launch of a worker: the argument list of the launch, as tmux renders it. */
const startCommandOf = (workerId: string, home = HOME): string => {
  const argv = workerLaunchArgv({ ...session, home, nodeId: 'node', workerId });
  if (!argv.ok) throw new Error(argv.error);
  return startCommandText(argv.value);
};

describe('wordsOfStartCommand: the words of a start command as tmux shows it', () => {
  it('reads what tmux 3.6b showed for this argument list (captured from a pane that a split made)', () => {
    const shown =
      'perl -e "sleep 3000" -- "a b" "a#b" "a\'b" \'a"b\' "a;b" "a\\$b" "a{b}" "a%b" a\\\\b \\~x a|b é a\\nb a\\tb \'\' a,b "x=/m y/n" a*b a!b';
    expect(wordsOfStartCommand(shown)).toEqual([
      'perl',
      '-e',
      'sleep 3000',
      '--',
      'a b',
      'a#b',
      "a'b",
      'a"b',
      'a;b',
      'a$b',
      'a{b}',
      'a%b',
      'a\\b',
      '~x',
      'a|b',
      'é',
      'a\nb',
      'a\tb',
      '',
      'a,b',
      'x=/m y/n',
      'a*b',
      'a!b',
    ]);
  });

  it.each([
    ['words with a space', ['a b', ' lead', 'trail ', 'two  spaces']],
    ['words with a quote', ["it's", 'say "x"', 'both \' and "', '"', "'"]],
    ['words with a character that tmux quotes', ['#', '%', '{', '}', ';', '$', 'a#b', 'a$b', 'a{b}', 'a%b', 'a;b']],
    ['words with a backslash', ['\\', 'a\\b', 'a b\\c', '\\\\']],
    ['words that start with a tilde', ['~', '~x', '~ x', 'a~b']],
    ['an empty word', ['', 'a', '']],
    ['words with a control character', ['a\nb', 'a\tb', 'a\u0001b', 'a\u007fb', 'a b\nc', '\n']],
    ['words with characters that are not ASCII', ['é', '/p/ä ö', '日本 語']],
    ['words with the separator of the pane list', ['a|b', 'a|b|c d']],
    ['no word', []],
  ])('gives back the words of an argument list with %s', (_name, words) => {
    expect(wordsOfStartCommand(startCommandText(words))).toEqual(words);
  });

  it.each([
    ['a quote that is not closed', 'a "b c'],
    ['a single quote that is not closed', "a 'b c"],
    ['an escape that tmux does not write', 'a b\\q'],
    ['an escape with no character behind it', 'a b\\'],
    ['an octal escape with too few digits', 'a \\12'],
    ['an octal escape with a digit that is not octal', 'a \\189'],
    ['a quote in the middle of a word', 'a b"c d"'],
    ['text right after a closing quote', 'a "b c"d'],
  ])('gives no words for %s', (_name, text) => {
    expect(wordsOfStartCommand(text)).toBeNull();
  });

  it('gives no words for a text that is longer than the bound', () => {
    expect(wordsOfStartCommand('a'.repeat(paneBinding.maxStartCommandChars))).not.toBeNull();
    expect(wordsOfStartCommand('a'.repeat(paneBinding.maxStartCommandChars + 1))).toBeNull();
  });

  it('gives no words for a text that has more words than the bound', () => {
    const words = (count: number): string => Array.from({ length: count }, () => 'a').join(' ');
    expect(wordsOfStartCommand(words(paneBinding.maxWords))).toHaveLength(paneBinding.maxWords);
    expect(wordsOfStartCommand(words(paneBinding.maxWords + 1))).toBeNull();
  });
});

describe('startsWorker: the start command shows that the launch of this worker made the pane', () => {
  it('is true for the start command of the launch of the worker', () => {
    expect(startsWorker(startCommandOf('alpha'), HOME, 'alpha')).toBe(true);
  });

  it('is true when the factory folder has a space in its path, which tmux puts in quotes', () => {
    const home = '/w/my node';
    expect(startCommandOf('alpha', home)).toContain('"FACTORY_HOME=/w/my node"');
    expect(startsWorker(startCommandOf('alpha', home), home, 'alpha')).toBe(true);
  });

  it('is false for the start command of the launch of another worker', () => {
    expect(startsWorker(startCommandOf('beta'), HOME, 'alpha')).toBe(false);
  });

  it('is false for the start command of the launch of a worker in another factory folder', () => {
    expect(startsWorker(startCommandOf('alpha', '/other/node'), HOME, 'alpha')).toBe(false);
  });

  it('is false for the start command of the coordinator, also when its session id is the id of the worker', () => {
    const coordinator = launchArgv({
      ...session,
      home: HOME,
      coordinatorDir: `${HOME}/coordinator`,
      stateDir: `${HOME}/.factory`,
      sessionId: 'alpha',
      projects: [],
    });
    if (!coordinator.ok) throw new Error(coordinator.error);
    expect(startCommandText(coordinator.value)).toContain('FACTORY_SESSION=alpha');
    expect(startsWorker(startCommandText(coordinator.value), HOME, 'alpha')).toBe(false);
  });

  it.each([
    ['no command: a pane that runs the shell', ''],
    ['a program that is not the launch', 'sleep 3000'],
    ['the session word only', 'env FACTORY_SESSION=alpha claude'],
    ['a text that is not a start command', '"env FACTORY_SESSION=alpha'],
  ])('is false for %s', (_name, startCommand) => {
    expect(startsWorker(startCommand, HOME, 'alpha')).toBe(false);
  });

  it('is false when one of the words of the launch is gone', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    const without = (drop: (word: string, index: number) => boolean): string => startCommandText(words.filter((word, index) => !drop(word, index)));
    expect(startsWorker(without((word) => word.startsWith('FACTORY_HOME=')), HOME, 'alpha')).toBe(false);
    expect(startsWorker(without((word) => word.startsWith('FACTORY_SESSION=')), HOME, 'alpha')).toBe(false);
    expect(startsWorker(without((word) => word.startsWith('FACTORY_INBOX=')), HOME, 'alpha')).toBe(false);
    expect(startsWorker(without((word) => word === '--add-dir'), HOME, 'alpha')).toBe(false);
  });

  it('is false when the folder after the flag is not the inbox of the worker', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    const swapped = words.map((word, index) => (words[index - 1] === '--add-dir' ? '/w/node' : word));
    expect(startsWorker(startCommandText(swapped), HOME, 'alpha')).toBe(false);
  });

  it('does not take the words of the launch from inside one quoted word', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    expect(startsWorker(startCommandText(['env', words.join(' ')]), HOME, 'alpha')).toBe(false);
  });
});

describe('the strip step in the start command of a launch', () => {
  const STRIP_WORDS = 4;

  it('shows the strip text as one word, with the quotes, the dollar signs and the braces of the text kept', () => {
    expect(wordsOfStartCommand(startCommandText([stripScript]))).toEqual([stripScript]);
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    expect(words.slice(0, STRIP_WORDS)).toEqual(['/bin/sh', '-c', stripScript, 'factory-launch']);
    expect(words[STRIP_WORDS]).toBe('env');
  });

  it('keeps the words of the launch after the strip words as separate words, so the marks stay whole words', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha', '/w/my node')) ?? [];
    expect(words).toContain('FACTORY_HOME=/w/my node');
    expect(words).toContain('FACTORY_SESSION=alpha');
  });

  it('binds on the marks only, as before: the same marks without the strip words bind, and the strip words without the marks do not', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    expect(startsWorker(startCommandText(words.slice(STRIP_WORDS)), HOME, 'alpha')).toBe(true);
    expect(startsWorker(startCommandText(words.slice(0, STRIP_WORDS + 1)), HOME, 'alpha')).toBe(false);
  });

  it('does not take a mark from inside the strip text', () => {
    const words = wordsOfStartCommand(startCommandOf('alpha')) ?? [];
    const hidden = ['/bin/sh', '-c', words.slice(STRIP_WORDS + 1).join(' '), 'factory-launch', 'env'];
    expect(startsWorker(startCommandText(hidden), HOME, 'alpha')).toBe(false);
  });
});
