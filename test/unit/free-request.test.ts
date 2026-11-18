import { describe, expect, it } from 'vitest';
import { strictRequestOf, type DecideRequest } from '../../src/board/decide.js';
import { checkDecision } from '../../src/board/edit.js';
import { parseWaiting } from '../../src/board/files.js';
import { freeCommandLines, freeRequestOf, freeTitleOf, freeWorkerOf, homeIssue, isReservedFreeForm } from '../../src/board/free-request.js';
import type { CliResult } from '../../src/cli/errors.js';
import { printable } from '../../src/cli/output.js';
import { boardTextLimits, dismissWords, flags, templateValues } from '../../src/names.js';

const HOME = "/example/owner's home";
const FREE_FIELD = { label: 'Worker to free', text: 'alpha' };
const FREE_FACTS = { id: 'alpha', project: 'demo', closed: ['B-1'], head: 'a'.repeat(40), checkedAt: '2030-01-02T03:04:05.678Z' };
const FREE_INPUT = freeRequestOf(FREE_FACTS);
const FREE_FIELDS = FREE_INPUT.fields ?? [];

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const read = (overrides: Record<string, unknown> = {}): DecideRequest => {
  const row = { id: 'D-1', title: 'Pick a plan', question: 'Use plan A?', options: [{ key: 'a', text: 'Yes' }], ...overrides };
  const waiting = valueOf(parseWaiting(JSON.stringify({ intro: '', groups: [], items: [row] })));
  return valueOf(strictRequestOf(waiting, row.id));
};

describe('free request', () => {
  it('writes a command request with only fixed text and check facts', () => {
    const checkedAt = '2030-01-02T03:04:05.678Z';
    const head = 'a'.repeat(40);
    const input = freeRequestOf({ id: 'alpha', project: 'demo', closed: ['B-1', 'B-2'], head, checkedAt });

    expect(freeTitleOf('alpha')).toBe('Free the worker alpha');
    expect(input).toMatchObject({
      title: freeTitleOf('alpha'), kind: 'command', group: 'now',
      fields: [
        FREE_FIELD,
        { label: 'Project', text: 'demo' },
        { label: 'Closed items', text: 'B-1, B-2' },
        { label: 'Pushed head', text: head },
        { label: 'Checks passed', text: 'coordinator-caller, dismiss-endable, dismiss-work-item-unknown, dismiss-closed-proof, dismiss-paths, dismiss-pushed' },
        { label: 'Checked at', text: checkedAt },
      ],
    });
    expect(input.options).toEqual([{ key: 'done', text: 'The worker is free.' }, { key: 'kept', text: 'The worker stays.' }]);
    expect(input.docs ?? []).toEqual([]);
    expect(checkDecision(input).ok).toBe(true);
  });

  it('keeps each closed item id even past the display limit', () => {
    const closed = Array.from({ length: dismissWords.maxItemsNamed + 1 }, (_, i) => `B-${i + 1}`);
    const input = freeRequestOf({ id: 'alpha', project: 'demo', closed, head: 'a'.repeat(40), checkedAt: '2030-01-02T03:04:05.678Z' });
    expect(input.fields).toContainEqual({ label: 'Closed items', text: closed.join(', ') });
  });

  it('states what the owner run checks and what it does not check', () => {
    const { question } = freeRequestOf({ id: 'alpha', project: 'demo', closed: ['B-1'], head: 'a'.repeat(40), checkedAt: '2030-01-02T03:04:05.678Z' });
    expect(question.length).toBeLessThanOrEqual(boardTextLimits.maxQuestionChars);
    expect(question).toContain('Check the board. Run the dry run first.');
    expect(question).toContain('The --yes run checks again that the branch is pushed, the copy is clean, no item is open and the worker is not busy.');
    expect(question).toContain('It does not check the closed item or the unassign mark again.');
    expect(question).not.toContain('factory dismiss');
  });

  it('names the flag and the request add command in the template values', () => {
    expect(flags).toHaveProperty('askOwner', 'ask-owner');
    expect(templateValues).toMatchObject({ askOwnerFlag: '--ask-owner', requestAddCommand: 'factory request add' });
  });

  it('rebuilds both command lines from the worker field and the board home', () => {
    const request = read({ ...FREE_INPUT });
    const id = valueOf(freeWorkerOf(request));
    expect(id).toBe('alpha');
    expect(freeCommandLines(id ?? '', HOME)).toEqual([
      "factory dismiss alpha --home '/example/owner'\\''s home'",
      "factory dismiss alpha --home '/example/owner'\\''s home' --yes",
    ]);
  });

  it('does not reserve a similar title or field with a different word', () => {
    const request = read({ title: 'Free the workers', fields: [{ label: 'Worker to free later', text: 'alpha' }] });
    expect(isReservedFreeForm(request.title, request.fields ?? [])).toBe(false);
    expect(freeWorkerOf(request)).toEqual({ ok: true, value: null });
  });

  it.each(['Alpha', 'alpha '])('refuses worker id %j even when the title matches', (id) => {
    const result = freeWorkerOf(read({ ...freeRequestOf({ ...FREE_FACTS, id }) }));
    expect(!result.ok && result.error.message).toContain('with a worker id');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['no worker field', { fields: FREE_FIELDS.slice(1) }, 'needs one "Worker to free" field'],
    ['a doc', { docs: ['notes/context.md'] }, 'cannot have a doc'],
    ['two forms of the worker label', { fields: [...FREE_FIELDS.slice(0, -1), { label: 'worker  to free', text: 'alpha' }] }, 'needs one "Worker to free" field'],
    ['a changed question', { question: 'Stored question' }, 'has the wrong question'],
    ['changed done text', { options: FREE_INPUT.options.map((option) => option.key === 'done' ? { ...option, text: 'Stored option' } : option) }, 'needs the fixed options'],
    ['changed kept text', { options: FREE_INPUT.options.map((option) => option.key === 'kept' ? { ...option, text: 'Stored option' } : option) }, 'needs the fixed options'],
    ['a reason for an option', { options: FREE_INPUT.options.map((option) => ({ ...option, why: 'Stored reason' })) }, 'needs the fixed options'],
    ['a recommended option', { options: FREE_INPUT.options.map((option) => option.key === 'done' ? { ...option, rec: true } : option) }, 'needs the fixed options'],
    ['another field in place of a fixed field', { fields: [...FREE_FIELDS.slice(0, -1), { label: 'Command', text: 'Stored command' }] }, 'needs the six fields'],
    ['a missing field', { fields: FREE_FIELDS.slice(0, -1) }, 'needs the six fields'],
  ])('refuses a free request with %s', (_name, overrides, phrase) => {
    const request = read({ ...FREE_INPUT, ...overrides });
    expect(isReservedFreeForm(request.title, request.fields ?? [])).toBe(true);
    const result = freeWorkerOf(request);
    expect(!result.ok && result.error.message).toContain(phrase);
  });

  it.each([
    { name: 'a tab', character: '\t' },
    { name: 'a line break', character: '\n' },
    { name: 'a control character', character: '\x1b' },
    { name: 'a mark of text direction', character: String.fromCodePoint(0x202e) },
    { name: 'a hidden character', character: String.fromCodePoint(0x200b) },
  ])('refuses a home with $name', ({ character }) => {
    expect(homeIssue(`${HOME}${character}`)).not.toBeNull();
  });

  it('prints the command lines without changes when the home passes the text check', () => {
    expect(homeIssue(HOME)).toBeNull();
    const lines = freeCommandLines('alpha', HOME);
    expect(lines.map(printable)).toEqual(lines);
  });
});
