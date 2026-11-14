import { describe, expect, it } from 'vitest';
import { itemIdsOf, lostItemIds } from '../../src/state/item-ids.js';

const board = (items: readonly unknown[], extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ queue: [], items, ...extra }, null, 2)}\n`;

const idsOf = (text: string): readonly string[] | string => {
  const read = itemIdsOf(text);
  return read.ok ? read.value : read.error;
};

describe('the item ids of a board text', () => {
  it('reads the id of each item, in the order of the items', () => {
    expect(idsOf(board([{ id: 'B-2' }, { id: 'B-1', title: 'first' }]))).toEqual(['B-2', 'B-1']);
  });

  it('reads an empty list of items', () => {
    expect(idsOf(board([]))).toEqual([]);
  });

  it('counts an id only at the item key position', () => {
    const nested = board([{ id: 'B-1', note: '{"id":"B-9"}', meta: { id: 'B-8' }, list: [{ id: 'B-7' }] }], {
      queue: [{ id: 'B-6' }],
    });
    expect(idsOf(nested)).toEqual(['B-1']);
  });

  it('refuses text that is not JSON', () => {
    expect(typeof idsOf('items: [{id: a}]')).toBe('string');
    expect(typeof idsOf('')).toBe('string');
    expect(typeof idsOf('{"items": [{"id": "a"},]}')).toBe('string');
  });

  it.each([
    ['a list at the top', '[]'],
    ['null at the top', 'null'],
    ['a number at the top', '7'],
    ['no items key', '{"queue": []}'],
    ['items that are not a list', '{"items": {"id": "a"}}'],
    ['an item that is not an object', '{"items": ["a"]}'],
    ['an item that is null', '{"items": [null]}'],
    ['an item with no id', '{"items": [{"title": "x"}]}'],
    ['an id in a nested object only', '{"items": [{"meta": {"id": "a"}}]}'],
    ['an id that is a number', '{"items": [{"id": 5}]}'],
    ['an id that is empty text', '{"items": [{"id": ""}]}'],
  ])('refuses a board with %s', (_name, text) => {
    expect(typeof idsOf(text)).toBe('string');
  });
});

describe('the item ids that a change loses', () => {
  const lost = (before: string | null, after: string | null) => lostItemIds(before, after);

  it('loses nothing when the change adds an item or changes one', () => {
    const before = board([{ id: 'B-1', title: 'a' }]);
    const after = board([{ id: 'B-1', title: 'changed' }, { id: 'B-2' }]);
    expect(lost(before, after)).toEqual({ ok: true, value: [] });
  });

  it('keeps the id of a closed item', () => {
    const before = board([{ id: 'B-1', status: 'open' }]);
    const after = board([{ id: 'B-1', status: 'closed' }]);
    expect(lost(before, after)).toEqual({ ok: true, value: [] });
  });

  it('names each id that the new text lacks, once, in the order of the last commit', () => {
    const before = board([{ id: 'B-3' }, { id: 'B-1' }, { id: 'B-2' }, { id: 'B-1' }]);
    const after = board([{ id: 'B-2' }]);
    expect(lost(before, after)).toEqual({ ok: true, value: ['B-3', 'B-1'] });
  });

  it('counts an id that stays only in the text of another item as lost', () => {
    const before = board([{ id: 'B-1' }, { id: 'B-2' }]);
    const after = board([{ id: 'B-1', title: '{"id": "B-2"}' }]);
    expect(lost(before, after)).toEqual({ ok: true, value: ['B-2'] });
  });

  it('loses nothing when the last commit has no board', () => {
    expect(lost(null, board([{ id: 'B-1' }]))).toEqual({ ok: true, value: [] });
    expect(lost(null, null)).toEqual({ ok: true, value: [] });
  });

  it('fails for a new text that is removed while the last commit has a board', () => {
    const result = lost(board([{ id: 'B-1' }]), null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.side).toBe('after');
  });

  it('fails for a new text that is not a board, also when the last commit has none', () => {
    for (const before of [null, board([{ id: 'B-1' }])]) {
      const result = lost(before, 'not json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.side).toBe('after');
    }
  });

  it('fails for a board of the last commit that it cannot read', () => {
    const result = lost('{"items": 3}', board([{ id: 'B-1' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.side).toBe('before');
      expect(result.error.reason).not.toBe('');
    }
  });
});
