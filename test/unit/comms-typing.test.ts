import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import { typeLine } from '../../src/comms/typing.js';
import { typing } from '../../src/names.js';
import { createFakeDeps, exited, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { tmuxHandler } from '../helpers/tmux-fake.js';

const PANE = '%7';

/** Makes a handler that answers some calls itself and passes the others to the fake. */
type Wrap = (handler: RunHandler) => RunHandler;

/** A fake tmux with one pane that shows `screen`. A `wrap` can change what a call gets before the fake sees it. */
const setup = (screen: string | undefined = undefined, wrap: Wrap = (handler) => handler) => {
  const { handler, log } = tmuxHandler({
    sessions: { demo: '/w/node' },
    panes: [{ id: PANE, session: 'demo', ...(screen === undefined ? {} : { screen }) }],
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

describe('TP-13: the typing builder makes one tmux run', () => {
  it('TP-13: types the line with 3 send-keys calls in one run, joined by the separator, with -l and -- before the text', async () => {
    const { deps, log, sent } = setup();
    expect((await typeLine(deps, PANE, typing.lines.clear)).ok).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.args).toEqual([
      'send-keys', '-t', PANE, 'C-u', ';',
      'send-keys', '-t', PANE, '-l', '--', '/clear', ';',
      'send-keys', '-t', PANE, 'Enter',
    ]);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/clear'), KEY_ENTER]);
  });

  it('TP-13: types the compact line the same way', async () => {
    const { deps, log } = setup();
    expect((await typeLine(deps, PANE, typing.lines.compact)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/compact'), KEY_ENTER]);
  });

  it('TP-13: reads the screen once, with one capture-pane, and the capture is the last call before the keys', async () => {
    const { deps, log } = setup();
    await typeLine(deps, PANE, typing.lines.clear);
    expect(log.commands()).toEqual([
      `capture-pane -p -t ${PANE}`,
      `send-keys -t ${PANE} C-u ; send-keys -t ${PANE} -l -- /clear ; send-keys -t ${PANE} Enter`,
    ]);
  });

  it('TP-13: exits 1 and types nothing for a pane that does not exist', async () => {
    const { deps, log, sent } = setup();
    const error = errorOf(await typeLine(deps, '%99', typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('%99');
    expect(sent()).toEqual([]);
    expect(log.typed()).toEqual([]);
  });

  it.each(['demo', '0', '=demo:view.0', '%', '%7;', '%7 ', ' %7', '%7\n', '%a'])(
    'TP-13: refuses the target %j, which is not a pane id, with exit 1 and no tmux call',
    async (target) => {
      const { deps } = setup();
      const error = errorOf(await typeLine(deps, target, typing.lines.clear));
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
  ])('TP-13: refuses a line with %s, with exit 1 and no tmux call', async (_what, line) => {
    const { deps } = setup();
    const error = errorOf(await typeLine(deps, PANE, line));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('refused');
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['300 signs', 'a'.repeat(typing.maxChars)],
    ['a semicolon inside the text', 'a;b'],
    ['a leading hyphen', '-x'],
    ['spaces', '/compact  keep the plan'],
  ])('TP-13: types a line with %s as one word of the second call', async (_what, line) => {
    const { deps, log, sent } = setup();
    expect((await typeLine(deps, PANE, line)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text(line), KEY_ENTER]);
    expect(sent()[0]?.args).toContain(line);
  });
});

describe('TP-14: the capture refuses a dialog list', () => {
  const DIALOG = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and do not ask again\n  3. No\n';

  it.each([
    ['a pointer line and numbered lines', DIALOG],
    ['the pointer sign >', 'Do you want to proceed?\n> 1. Yes\n  2. No\n'],
    ['spaces before the pointer', '   ❯ 1. Yes\n   2. No\n'],
    ['the numbered line before the pointer line', '  1. Yes\n❯ 2. No\n'],
    ['a pointer line, no space after the pointer, and a numbered line with no space before it', '❯1. Yes\n2. No\n'],
    ['empty rows below the dialog', `${DIALOG}${'\n'.repeat(40)}`],
    ['a carriage return at the end of each line', DIALOG.replaceAll('\n', '\r\n')],
  ])('TP-14: exits 3 and types nothing for a screen with %s', async (_what, screen) => {
    const { deps, log } = setup(screen);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(3);
    expect(error.message).toContain(PANE);
    expect(error.hint).toContain(PANE);
    expect(log.typed()).toEqual([]);
    expect(deps.calls.map((call) => call.args[0])).toEqual(['capture-pane']);
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
  ])('TP-14: types normally for a screen with %s', async (_what, screen) => {
    const { deps, log } = setup(screen);
    expect((await typeLine(deps, PANE, typing.lines.compact)).ok).toBe(true);
    expect(log.typed()).toEqual([KEY_CLEAR, text('/compact'), KEY_ENTER]);
  });

  it('TP-14: reads only the bottom 20 lines of the screen', async () => {
    const above = `❯ 1. Yes\n  2. No\n${'x\n'.repeat(typing.captureLines)}`;
    const inside = `❯ 1. Yes\n  2. No\n${'x\n'.repeat(typing.captureLines - 2)}`;
    expect((await typeLine(setup(above).deps, PANE, typing.lines.clear)).ok).toBe(true);
    expect(exitCodeOf[errorOf(await typeLine(setup(inside).deps, PANE, typing.lines.clear)).kind]).toBe(3);
  });
});

describe('TP-15: a failed run clears the input line once', () => {
  const failsTheRun: Wrap = (handler) => (call) =>
    call.args[0] === 'send-keys' && call.args.includes(';') ? exited(1, '', 'no space\n') : handler(call);

  it('TP-15: exits 1 and sends exactly one C-u when the run fails', async () => {
    const { deps, log, sent } = setup(undefined, failsTheRun);
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('send-keys');
    expect(sent()).toHaveLength(2);
    expect(sent()[1]?.args).toEqual(['send-keys', '-t', PANE, 'C-u']);
    expect(log.typed()).toEqual([KEY_CLEAR]);
    expect(error.message).not.toContain('may still hold text');
  });

  it('TP-15: exits 1 and sends exactly one C-u when the run cannot start', async () => {
    const { deps, log, sent } = setup(undefined, (handler) => (call) =>
      call.args[0] === 'send-keys' && call.args.includes(';') ? failure('cannot run tmux: timed out') : handler(call),
    );
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(sent()).toHaveLength(2);
    expect(log.typed()).toEqual([KEY_CLEAR]);
  });

  it('TP-15: exits 1, sends the C-u once and does not retry when the clean-up fails too, and names the pane input', async () => {
    const { deps, log, sent } = setup(undefined, (handler) => (call) => (call.args[0] === 'send-keys' ? exited(1, '', 'gone\n') : handler(call)));
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain(`input line of pane ${PANE} may still hold text`);
    expect(sent()).toHaveLength(2);
    expect(log.typed()).toEqual([]);
  });

  it('TP-15: sends no C-u when the capture fails, because nothing was typed', async () => {
    const { deps, sent } = setup(undefined, (handler) => (call) => (call.args[0] === 'capture-pane' ? exited(1, '', 'gone\n') : handler(call)));
    const error = errorOf(await typeLine(deps, PANE, typing.lines.clear));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(sent()).toEqual([]);
  });
});
