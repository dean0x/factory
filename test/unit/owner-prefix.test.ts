import { describe, expect, it } from 'vitest';
import { fillOwnerPrefix, hasOwnerPrefix } from '../../src/safety/owner-prefix.js';

describe('the owner prefix fill', () => {
  it('fills every slot with the value the caller gives', () => {
    expect(fillOwnerPrefix('{owner} at {node} on {date} ({owner})', {
      owner: 'Ada', node: 'demo', date: '2030-01-02',
    })).toBe('Ada at demo on 2030-01-02 (Ada)');
  });

  it('keeps placeholder and dollar text in the values literal', () => {
    const owner = 'Ada $& {date} {node}';
    const template = '[{owner} at {node} on {date}]';
    const filled = fillOwnerPrefix(template, { owner, node: 'demo', date: '2030-01-02' });
    expect(filled).toBe('[Ada $& {date} {node} at demo on 2030-01-02]');
    expect(hasOwnerPrefix(filled, template, owner)).toBe(true);
  });
});
