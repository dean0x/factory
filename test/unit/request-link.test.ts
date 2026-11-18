import { describe, expect, it } from 'vitest';
import * as names from '../../src/names.js';

// These labels and keys are a stored format, not display text.
describe('the stored approval link format', () => {
  it('keeps the four labels and log keys fixed, apart from the decision title key', () => {
    expect(names.approvalLinkLabels).toEqual({ point: 'link point', item: 'link item', ref: 'link reference', head: 'link head' });
    expect(names.decisionLogKeys).toMatchObject({
      item: 'item',
      point: 'point',
      boardItem: 'board_item',
      ref: 'ref',
      head: 'head',
    });
  });

  it('gives a closed set of proof kinds and one fixed reason for each kind', () => {
    expect(names.schemaIds.decideRead).toBe('factory.decide-read/v1');
    expect(names.decideProofKinds).toEqual(['record', 'relayed', 'closed', 'open', 'none', 'mismatch', 'error']);
    expect(names.decideProofReasons).toEqual({
      record: 'owner store record matches the request text',
      relayed: 'answer relayed by the coordinator; no owner proof',
      closed: 'request closed; no owner proof',
      open: 'request is open; no owner proof',
      none: 'no owner store record; no owner proof',
      mismatch: 'owner store record does not match the request text; no owner proof',
      error: 'request proof could not be read; no owner proof',
    });
  });
});
