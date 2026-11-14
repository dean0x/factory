import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../../src/cli/errors.js';
import { renameQueueKey } from '../../src/upgrade/board-key.js';

/** One unicode escape as text, built so that no source line holds the escape itself. */
const escapeOf = (hex: string): string => `${'\\'}u${hex}`;

const renamed = (text: string, key = 'merge'): string | null => {
  const result = renameQueueKey(text, key);
  if (!result.ok) throw new Error(`expected a result, got: ${result.error.message}`);
  return result.value;
};

const refused = (text: string, key = 'merge') => {
  const result = renameQueueKey(text, key);
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

describe('the rename of the queue key in the text of the board', () => {
  it('renames the key of the top level and no other key or value with the same word', () => {
    const before = '{"note": "queue", "queue": [], "x": {"queue": 1}, "y": ["queue"]}';
    expect(renamed(before)).toBe('{"note": "queue", "merge": [], "x": {"queue": 1}, "y": ["queue"]}');
  });

  it('finds a key that the file wrote with an escape', () => {
    expect(renamed(`{"qu${escapeOf('0065')}ue": []}`)).toBe('{"merge": []}');
  });

  it.each([
    ['an escaped quote', '{"a": "\\"", "queue": []}', '{"a": "\\"", "merge": []}'],
    ['an escaped backslash', '{"a": "x\\\\", "queue": []}', '{"a": "x\\\\", "merge": []}'],
  ])('finds the key after a string value with %s, and the data is the old data with the key renamed', (_name, before, after) => {
    const result = renamed(before);
    expect(result).toBe(after);
    const old = JSON.parse(before) as Record<string, unknown>;
    const withNewKey = Object.fromEntries(Object.entries(old).map(([key, value]) => [key === 'queue' ? 'merge' : key, value]));
    expect(JSON.parse(result ?? '')).toEqual(withNewKey);
  });

  it('writes a key with a letter that is not ASCII as an escape, as the writers of the board do', () => {
    expect(renamed('{"queue": []}', 'café')).toBe(`{"caf${escapeOf('00e9')}": []}`);
  });

  it('gives null when the board has no old key, and when the key of the recipe is the default', () => {
    expect(renamed('{"merge": [], "items": []}')).toBeNull();
    expect(renamed('{"queue": [], "items": []}', 'queue')).toBeNull();
  });

  it('stops with exit 1 when the board has both keys, names the file and names a command', () => {
    const error = refused('{"queue": [], "merge": [], "items": []}');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('board.json has both the key "queue" and the key "merge"');
    expect(error.hint).toContain('factory upgrade');
  });

  it('stops with exit 1 when the old key is in the text twice', () => {
    const error = refused('{"queue": [], "queue": [], "items": []}');
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe('board.json holds the key "queue" twice');
    expect(error.hint).toContain('factory upgrade');
  });

  it.each([
    ['text that is not JSON', 'not json{', 'cannot read board.json: the text is not valid JSON'],
    ['a list', '[1]', 'cannot read board.json: the top level is not an object'],
  ])('stops with exit 1 for %s, and names the file and a command', (_name, text, message) => {
    const error = refused(text);
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toBe(message);
    expect(error.hint).toContain('factory upgrade');
  });
});
