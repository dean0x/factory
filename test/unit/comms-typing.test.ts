import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { typeLine, type TypedLine } from '../../src/comms/typing.js';
import { typing } from '../../src/names.js';
import { createFakeDeps, exited, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const PANE = '%7';

/** The clause that a caller passes to end the remedy of an exit 3. */
const AGAIN = 'Then run "factory demo" again.';

/** A line that is not one of the fixed lines. The type blocks it at compile time, so a test needs the cast to try it. */
const notFixed = (line: string): TypedLine => line as TypedLine;

/** Makes a handler that answers some calls itself and passes the others to the fake. */
type Wrap = (handler: RunHandler) => RunHandler;

/** A fake tmux with one pane that shows `screen`. A `wrap` can change what a call gets before the fake sees it. */
const setup = (screen: string | undefined = undefined, wrap: Wrap = (handler) => handler, inMode = false) => {
  const { handler, log } = tmuxHandler({
    sessions: { demo: '/w/node' },
    panes: [{ id: PANE, session: 'demo', ...(screen === undefined ? {} : { screen }) }],
    ...(inMode ? { panesInMode: [PANE] } : {}),
  });
  const deps = createFakeDeps({ run: wrap(handler) });
  const sent = (): RunCall[] => deps.calls.filter((call) => call.args[0] === 'send-keys');
  return { deps, log, sent };
};

const errorOf = (result: CliResult<void>): CliError => {
  if (result.ok) throw new Error('expected a refusal, but the line was typed');
  return result.error;
};

const KEY_CLEAR = { pane: PANE, literal: false, text: 'C-u' };
const KEY_ENTER = { pane: PANE, literal: false, text: 'Enter' };
const text = (value: string) => ({ pane: PANE, literal: true, text: value });

describe('the typing builder makes one tmux run', () => {
  it('types the line with 3 send-keys calls in one run, joined by the separator, with -l and -- before the text', async () => {
    const { deps, log, sent } = setup();
    expect((await typeLine(deps, PANE, typing.lines.clear, AGAIN)).ok).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.args).toEqual([
      'send-keys', '-t', PANE, 'C-u', ';',
      'send-keys', '-t', PANE, '-l', '--', '/clear', ';',
      'send-keys', '-t', PANE, 'Enter',
    ]);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/clear'), KEY_ENTER]);
  });

  it('types the compact line the same way', async () => {
    const { deps, log } = setup();
    expect((await typeLine(deps, PANE, typing.lines.compact, AGAIN)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/compact'), KEY_ENTER]);
  });

  it('reads the mode of the pane once, then the screen once with one capture-pane, and the capture is the last call before the keys', async () => {
    const { deps, log } = setup();
    await typeLine(deps, PANE, typing.lines.clear, AGAIN);
    expect(log.commands()).toEqual([
      `display-message -p -t ${PANE} #{pane_in_mode}`,
      `capture-pane -p -t ${PANE}`,
      `send-keys -t ${PANE} C-u ; send-keys -t ${PANE} -l -- /clear ; send-keys -t ${PANE} Enter`,
    ]);
  });

  it('exits 1 and types nothing for a pane that does not exist', async () => {
    const { deps, log, sent } = setup();
    const error = errorOf(await typeLine(deps, '%99', typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('%99');
    expect(sent()).toEqual([]);
    expect(log.typed()).toEqual([]);
  });

  it.each(['demo', '0', '=demo:view.0', '%', '%7;', '%7 ', ' %7', '%7\n', '%a'])(
    'refuses the target %j, which is not a pane id, with exit 1 and no tmux call',
    async (target) => {
      const { deps } = setup();
      const error = errorOf(await typeLine(deps, target, typing.lines.clear, AGAIN));
      expect(exitCodeOf[error.kind]).toBe(1);
      expect(deps.calls).toEqual([]);
    },
  );

  it.each([
    ['a new line', '/clear\n'],
    ['a new line in the middle', '/clear\n/compact'],
    ['a carriage return', '/clear\r'],
    ['the escape sign', '/clear\u001b'],
    ['a tab', '/clear\t'],
    ['the delete sign', '/clear\u007f'],
    ['a sign outside ASCII', '/clear é'],
    ['301 signs', 'a'.repeat(typing.maxChars + 1)],
    ['a final semicolon', '/clear;'],
    ['a final semicolon after a space', '/clear ;'],
    ['no text', ''],
  ])('refuses a line with %s, with exit 1 and no tmux call', async (_what, line) => {
    const { deps } = setup();
    const error = errorOf(await typeLine(deps, PANE, notFixed(line), AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('refused');
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['300 signs', 'a'.repeat(typing.maxChars)],
    ['a semicolon inside the text', 'a;b'],
    ['a leading hyphen', '-x'],
    ['spaces', '/compact  keep the plan'],
    ['text that starts like a fixed line', '/clear now'],
    ['a fixed line in other case', '/CLEAR'],
  ])('refuses a printable line with %s that is not one of the fixed lines, with exit 1 and no tmux call', async (_what, line) => {
    const { deps } = setup();
    const error = errorOf(await typeLine(deps, PANE, notFixed(line), AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('the line to type is refused: it is not one of the fixed lines');
    expect(deps.calls).toEqual([]);
  });

  it.each(Object.values(typing.lines))('types the fixed line %s as one word of the second call', async (line) => {
    const { deps, log, sent } = setup();
    expect((await typeLine(deps, PANE, line, AGAIN)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text(line), KEY_ENTER]);
    expect(sent()[0]?.args).toContain(line);
  });
});

describe('the capture refuses a dialog list', () => {
  const DIALOG = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and do not ask again\n  3. No\n';

  it.each([
    ['a pointer line and numbered lines', DIALOG],
    ['the pointer sign >', 'Do you want to proceed?\n> 1. Yes\n  2. No\n'],
    ['spaces before the pointer', '   ❯ 1. Yes\n   2. No\n'],
    ['the numbered line before the pointer line', '  1. Yes\n❯ 2. No\n'],
    ['a pointer line, no space after the pointer, and a numbered line with no space before it', '❯1. Yes\n2. No\n'],
    ['empty rows below the dialog', `${DIALOG}${'\n'.repeat(40)}`],
    ['a carriage return at the end of each line', DIALOG.replaceAll('\n', '\r\n')],
    ['a dialog inside a side border', '╭──────────────╮\n│ ❯ 1. Yes     │\n│   2. No      │\n╰──────────────╯\n'],
    ['a side border without a space before the pointer', '│❯ 1. Yes\n│  2. No\n'],
    ['the pointer sign > inside a side border', '┃ > 1. Yes\n┃   2. No\n'],
    ['a border sign, then spaces, before each line', '  │  ❯ 1. Yes\n  │    2. No\n'],
  ])('exits 3 and types nothing for a screen with %s', async (_what, screen) => {
    const { deps, log } = setup(screen);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(PANE);
    expect(error.hint).toContain(PANE);
    expect(log.typed()).toEqual([]);
    expect(deps.calls.map((call) => call.args[0])).toEqual(['display-message', 'capture-pane']);
  });

  it('ends the remedy of a dialog with the clause of the caller, so it names the command to run again', async () => {
    const { deps } = setup(DIALOG);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(error.hint).toBe(`Look at pane ${PANE} and answer the dialog there. ${AGAIN}`);
  });

  it.each([
    ['an answer that ends with a numbered list and an empty prompt', 'The steps:\n1. first\n2. second\n3. third\n\n❯ \n'],
    ['a numbered list and the prompt sign >', '1. first\n2. second\n> \n'],
    ['one pointer line and no other numbered line', 'Pick:\n❯ 1. Yes\n'],
    ['a pointer with no digits and a numbered line', '❯ Yes\n  2. No\n'],
    ['a pointer sign inside a line and numbered lines', 'a > 1. b\n2. c\n'],
    ['a digit with no dot after the pointer', '❯ 1 Yes\n2 No\n'],
    ['a numbered line after other text', 'x 1. a\n❯ 2. b\n'],
    ['an empty screen', ''],
    ['an idle prompt inside a box and no numbered choice', '╭────────────╮\n│ >          │\n╰────────────╯\n'],
    ['a boxed numbered list and a boxed prompt with no digits', '│ 1. first   │\n│ 2. second  │\n│ > ask      │\n'],
    ['a border sign inside a line before the pointer', '│ x ❯ 1. Yes\n│   2. No\n'],
  ])('types normally for a screen with %s', async (_what, screen) => {
    const { deps, log } = setup(screen);
    expect((await typeLine(deps, PANE, typing.lines.compact, AGAIN)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/compact'), KEY_ENTER]);
  });

  it('reads only the bottom 20 lines of the screen', async () => {
    const above = `❯ 1. Yes\n  2. No\n${'x\n'.repeat(typing.captureLines)}`;
    const inside = `❯ 1. Yes\n  2. No\n${'x\n'.repeat(typing.captureLines - 2)}`;
    expect((await typeLine(setup(above).deps, PANE, typing.lines.clear, AGAIN)).ok).toBe(true);
    expect(exitCodeOf[errorOf(await typeLine(setup(inside).deps, PANE, typing.lines.clear, AGAIN)).kind]).toBe(3);
  });
});

describe('the pane mode check', () => {
  it('exits 3 for a pane in a mode of tmux, types nothing, and reads no screen', async () => {
    const { deps, log, sent } = setup(undefined, undefined, true);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toBe(`the pane ${PANE} is in a mode of tmux, so the keys would not reach the session`);
    expect(sent()).toEqual([]);
    expect(log.typed()).toEqual([]);
    expect(deps.calls.map((call) => call.args[0])).toEqual(['display-message']);
  });

  it('ends the remedy of a mode with the way to leave it and the clause of the caller', async () => {
    const { deps } = setup(undefined, undefined, true);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.compact, AGAIN));
    expect(error.hint).toBe(`Press q in pane ${PANE} to leave the mode. ${AGAIN}`);
  });

  it.each(['2\n', 'copy-mode\n'])('exits 3 for the answer %j, because only the text 0 means that the pane is in no mode', async (answer) => {
    const { deps, sent } = setup(undefined, (handler) => (call) => (call.args.includes('#{pane_in_mode}') ? exited(0, answer) : handler(call)));
    expect(exitCodeOf[errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN)).kind]).toBe(3);
    expect(sent()).toEqual([]);
  });

  it('exits 1 and types nothing when the read of the mode fails', async () => {
    const { deps, sent } = setup(undefined, (handler) => (call) =>
      call.args.includes('#{pane_in_mode}') ? exited(1, '', 'server gone\n') : handler(call),
    );
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(sent()).toEqual([]);
    expect(deps.calls.map((call) => call.args[0])).toEqual(['display-message']);
  });

  it('exits 1 and types nothing when the read of the mode cannot start', async () => {
    const { deps, sent } = setup(undefined, (handler) => (call) =>
      call.args.includes('#{pane_in_mode}') ? failure('cannot run tmux: timed out') : handler(call),
    );
    expect(exitCodeOf[errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN)).kind]).toBe(1);
    expect(sent()).toEqual([]);
  });

  it('exits 1, not 3, when tmux prints nothing for the mode, because the pane is gone', async () => {
    const { deps, sent } = setup(undefined, (handler) => (call) => (call.args.includes('#{pane_in_mode}') ? exited(0, '\n') : handler(call)));
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(PANE);
    expect(sent()).toEqual([]);
  });

  it('reads the mode before the screen, so a pane in a mode with a dialog on it is exit 3 for the mode', async () => {
    const { deps } = setup('Do you want to proceed?\n❯ 1. Yes\n  2. No\n', undefined, true);
    expect(errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN)).message).toContain('mode of tmux');
  });
});

describe('a failed run clears the input line once', () => {
  const failsTheRun: Wrap = (handler) => (call) =>
    call.args[0] === 'send-keys' && call.args.includes(';') ? exited(1, '', 'no space\n') : handler(call);

  it('exits 1 and sends exactly one C-u when the run fails', async () => {
    const { deps, log, sent } = setup(undefined, failsTheRun);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('send-keys');
    expect(sent()).toHaveLength(2);
    expect(sent()[1]?.args).toEqual(['send-keys', '-t', PANE, 'C-u']);
    expect(log.typed()).toEqual([KEY_CLEAR]);
    expect(error.message).not.toContain('may still hold text');
  });

  it('exits 1 and sends exactly one C-u when the run cannot start', async () => {
    const { deps, log, sent } = setup(undefined, (handler) => (call) =>
      call.args[0] === 'send-keys' && call.args.includes(';') ? failure('cannot run tmux: timed out') : handler(call),
    );
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(sent()).toHaveLength(2);
    expect(log.typed()).toEqual([KEY_CLEAR]);
  });

  it('exits 1, sends the C-u once and does not retry when the clean-up fails too, and names the pane input', async () => {
    const { deps, log, sent } = setup(undefined, (handler) => (call) => (call.args[0] === 'send-keys' ? exited(1, '', 'gone\n') : handler(call)));
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`input line of pane ${PANE} may still hold text`);
    expect(sent()).toHaveLength(2);
    expect(log.typed()).toEqual([]);
  });

  it('sends no C-u when the capture fails, because nothing was typed', async () => {
    const { deps, sent } = setup(undefined, (handler) => (call) => (call.args[0] === 'capture-pane' ? exited(1, '', 'gone\n') : handler(call)));
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear, AGAIN));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(sent()).toEqual([]);
  });
});
