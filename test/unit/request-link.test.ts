import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { canonicalRequestText } from '../../src/core/request-hash.js';
import { ok } from '../../src/core/result.js';
import * as links from '../../src/board/requests.js';
import type { RequestLinkRules } from '../../src/board/requests.js';
import * as names from '../../src/names.js';
import { softwareRecordCheck } from '../../src/recipes/software/record.js';

const LINK = { point: 'publish', item: 'B-12', ref: '12', head: 'b'.repeat(40) } as const;
const RULES: RequestLinkRules = {
  points: ['publish'],
  parseRef: softwareRecordCheck.parseRef,
  parseHead: softwareRecordCheck.parseHead,
};
const PARTS = ['point', 'item', 'ref', 'head'] as const;
const LABELS = { point: 'link point', item: 'link item', ref: 'link reference', head: 'link head' } as const;
const ROW_KEYS = { point: 'point', item: 'board_item', ref: 'ref', head: 'head' } as const;

const fieldsOf = (change: Readonly<Record<string, unknown>> = {}): readonly { readonly label: string; readonly text: unknown }[] => {
  const parts = { ...LINK, ...change };
  return PARTS.map((part) => ({ label: LABELS[part], text: parts[part] }));
};

const rowOf = (change: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => {
  const parts = { ...LINK, ...change };
  return Object.fromEntries(PARTS.map((part) => [ROW_KEYS[part], parts[part]]));
};

const answeredText = (fields: unknown): string => {
  const text = canonicalRequestText({
    id: 'D-4', title: 'Check this work', question: 'Proceed?', options: [{ key: 'go', text: 'Proceed' }],
    ...(fields === undefined ? {} : { fields }),
  });
  if (!text.ok) throw new Error(text.error);
  return text.value;
};

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

describe('the strict request link reader', () => {
  it.each([undefined, null, [], [{ label: 'head', text: LINK.head }, { label: 'reference', text: '12' }],
    [{ label: LABELS.point, text: LINK.point }, { label: LABELS.head, text: LINK.head }]])(
    'reads fields with no board item label as unlinked: %j', (fields) => {
      expect(links.linkOfFields(fields, RULES)).toEqual(ok(null));
    },
  );

  it('reads the four fields as one link', () => {
    expect(links.linkOfFields(fieldsOf(), RULES)).toEqual(ok(LINK));
  });

  it('allows other context fields beside a link', () => {
    expect(links.linkOfFields([{ label: 'context', text: 'A note' }, ...fieldsOf()], RULES)).toEqual(ok(LINK));
  });

  it.each(['point', 'ref', 'head'] as const)('refuses a linked entry with no %s field', (part) => {
    const fields = fieldsOf().filter((field) => field.label !== LABELS[part]);
    expect(links.linkOfFields(fields, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each(PARTS)('refuses a duplicate %s label, even with the same value', (part) => {
    const fields = [...fieldsOf(), { label: LABELS[part], text: LINK[part] }];
    expect(links.linkOfFields(fields, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each<[string, unknown]>([
    ['point', 'unknown'], ['point', ' publish'], ['point', null],
    ['item', 'D-12'], ['item', 'B-1234567890'], ['item', 12],
    ['ref', '0'], ['ref', '012'], ['ref', null],
    ['head', 'b'.repeat(39)], ['head', 'B'.repeat(40)], ['head', false],
    ...PARTS.map((part): [string, unknown] => [part, '']),
  ])('refuses a bad %s value in both fields and rows: %j', (part, value) => {
    const change = { [String(part)]: value };
    expect(links.linkOfFields(fieldsOf(change), RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(links.linkOfRow(rowOf(change), RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each([{}, 'not a list', 1, [...fieldsOf(), null, null, null]])('refuses malformed or oversized fields: %j', (fields) => {
    expect(links.linkOfFields(fields, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('uses the point list and parsers of another recipe, and keeps their parsed values', () => {
    const rules: RequestLinkRules = {
      points: ['send'],
      parseRef: (text) => text === 'page-2' ? ok('2') : failure('not a page'),
      parseHead: (text) => text === 'proof-1' ? ok(text) : failure('not a proof'),
    };
    const changed = { point: 'send', ref: 'page-2', head: 'proof-1' };
    const expected = ok({ ...LINK, ...changed, ref: '2' });
    expect(links.linkOfFields(fieldsOf(changed), rules)).toEqual(expected);
    expect(links.linkOfRow(rowOf(changed), rules)).toEqual(expected);
    expect(links.linkOfFields(fieldsOf(changed), RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('does not repeat stored text in a fault', () => {
    const result = links.linkOfFields(fieldsOf({ point: 'untrusted\nowner proof' }), RULES);
    expect(result).toMatchObject({ ok: false, error: { kind: 'failure' } });
    expect(JSON.stringify(result)).not.toContain('untrusted');
  });
});

describe('the strict log link reader', () => {
  it('reads a row with no link keys as unlinked, and does not confuse the title with the board item', () => {
    expect(links.linkOfRow({ item: 'D-4: Check this work', decision: 'Proceed' }, RULES)).toEqual(ok(null));
  });

  it('reads the four log keys as one link', () => {
    expect(links.linkOfRow({ item: 'D-4: Check this work', ...rowOf() }, RULES)).toEqual(ok(LINK));
  });

  it.each(PARTS)('refuses a partial row with only the %s key', (part) => {
    expect(links.linkOfRow({ [ROW_KEYS[part]]: LINK[part] }, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each(PARTS)('refuses a row with no %s key', (part) => {
    const row = Object.fromEntries(Object.entries(rowOf()).filter(([key]) => key !== ROW_KEYS[part]));
    expect(links.linkOfRow(row, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each(PARTS)('refuses a present but undefined %s value', (part) => {
    expect(links.linkOfRow(rowOf({ [part]: undefined }), RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });
});

describe('the link of an answered request', () => {
  it('reads the request text that the store hash covers, not other log fields', () => {
    expect(links.linkOfAnswered(answeredText(fieldsOf()), RULES)).toEqual(ok(LINK));
  });

  it('reads an old request with no fields as unlinked', () => {
    expect(links.linkOfAnswered(answeredText(undefined), RULES)).toEqual(ok(null));
  });

  it('reads ordinary head and reference fields as unlinked', () => {
    const text = answeredText([{ label: 'head', text: LINK.head }, { label: 'reference', text: LINK.ref }]);
    expect(links.linkOfAnswered(text, RULES)).toEqual(ok(null));
  });

  it('refuses a partial link in the hashed request text', () => {
    expect(links.linkOfAnswered(answeredText([{ label: LABELS.item, text: LINK.item }]), RULES))
      .toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it.each([
    '', '{', 'null', '[]', '{}',
    JSON.stringify({ tag: names.requestHash.tag, version: names.requestHash.version, request: null }),
    JSON.stringify({ tag: 'another tag', version: names.requestHash.version, request: {} }),
    JSON.stringify({ tag: names.requestHash.tag, version: 2, request: {} }),
    JSON.stringify({ tag: names.requestHash.tag, version: names.requestHash.version, request: {}, extra: true }),
    answeredText({}),
  ])('refuses malformed request text or its wrapper: %j', (text) => {
    expect(links.linkOfAnswered(text, RULES)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });
});
