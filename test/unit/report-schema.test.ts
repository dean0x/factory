import { describe, expect, it } from 'vitest';
import { renderJson } from '../../src/cli/output.js';
import { parseReport, reportSchema, type NodeReport } from '../../src/comms/report-schema.js';
import { reportLimits, schemaIds, workerRecord } from '../../src/names.js';

/**
 * The report document is a contract between two nodes: a parent reads the file of a child. The tests write the keys as text, so
 * a rename of a key in the source breaks them.
 */

const worker = {
  id: 'alpha',
  project: 'acme-web',
  state: 'busy',
  contextPct: 41,
  activityAt: '2026-11-13T10:00:00.000Z',
  workItem: 'B-3',
  idle: false,
};

const child = {
  id: 'web',
  address: 'file:///h/acme/web',
  state: 'ok',
  reason: null,
  counts: { workers: 2, inProgress: 1, requests: 0, children: 0 },
  age: 12,
};

const document = (): Record<string, unknown> => ({
  schema: schemaIds.report,
  schemaVersion: 1,
  id: 'acme',
  layer: 2,
  factoryVersion: '1.2.3',
  cursor: null,
  workers: [worker],
  board: {
    states: [{ name: 'open', count: 4 }],
    statesOmitted: 0,
    fields: [{ field: 'priority', values: [{ name: 'high', count: 1 }], valuesOmitted: 0 }],
  },
  inProgress: [{ id: 'B-3', title: 'Build the page', state: 'open', track: 'web', stage: 'build' }],
  requests: [{ id: 'D-4', title: 'Pick a theme', origin: 'acme#D-4' }],
  events: [],
  children: [child],
});

const parsed = (change: (doc: Record<string, unknown>) => void): ReturnType<typeof parseReport> => {
  const doc = document();
  change(doc);
  return parseReport(doc);
};

const failureOf = (result: ReturnType<typeof parseReport>): string => {
  if (result.ok) throw new Error('the report should not parse');
  return result.error;
};

describe('the report document (AC-9)', () => {
  it('holds the keys of the digest and nothing else', () => {
    const result = parseReport(document());
    expect(result.ok).toBe(true);
    expect(Object.keys(reportSchema.shape).sort()).toEqual(
      [
        'schema',
        'schemaVersion',
        'id',
        'layer',
        'factoryVersion',
        'cursor',
        'workers',
        'board',
        'inProgress',
        'requests',
        'events',
        'children',
      ].sort(),
    );
  });

  it('returns the document with its values', () => {
    const result = parseReport(document());
    if (!result.ok) throw new Error(result.error);
    const report: NodeReport = result.value;
    expect(report.id).toBe('acme');
    expect(report.cursor).toBeNull();
    expect(report.events).toEqual([]);
    expect(report.requests[0]?.origin).toBe('acme#D-4');
  });

  it('accepts a node with no worker, no item, no request and no child', () => {
    const result = parsed((doc) => {
      doc['workers'] = [];
      doc['inProgress'] = [];
      doc['requests'] = [];
      doc['children'] = [];
      doc['board'] = { states: [], statesOmitted: 0, fields: [] };
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the report schema version at 1, and refuses another number', () => {
    expect(reportLimits.schemaVersion).toBe(1);
    expect(failureOf(parsed((doc) => (doc['schemaVersion'] = 2)))).toContain('schemaVersion');
  });

  it('refuses a cursor and an event, which this version never sets', () => {
    expect(parsed((doc) => (doc['cursor'] = 'abc')).ok).toBe(false);
    expect(parsed((doc) => (doc['events'] = [{ kind: 'merged' }])).ok).toBe(false);
  });

  it('refuses a layer outside the layers of a node', () => {
    expect(parsed((doc) => (doc['layer'] = 0)).ok).toBe(false);
    expect(parsed((doc) => (doc['layer'] = 17)).ok).toBe(false);
    expect(parsed((doc) => (doc['layer'] = 1.5)).ok).toBe(false);
  });
});

describe('the report allow-list (AC-10)', () => {
  const sentinels = ['ownerPrefix', 'proxy', 'sessionId', 'pane', 'approval'];

  it.each(sentinels)('refuses the key %s at the top level', (key) => {
    expect(parsed((doc) => (doc[key] = 'SENTINEL-VALUE')).ok).toBe(false);
  });

  it.each(sentinels)('refuses the key %s in a worker row', (key) => {
    expect(parsed((doc) => (doc['workers'] = [{ ...worker, [key]: 'SENTINEL-VALUE' }])).ok).toBe(false);
  });

  it('refuses an extra key in an item, a request, a count row and a child row', () => {
    expect(parsed((doc) => (doc['inProgress'] = [{ id: 'B-3', title: 't', state: 's', track: null, stage: null, pane: '%1' }])).ok).toBe(false);
    expect(parsed((doc) => (doc['requests'] = [{ id: 'D-4', title: null, origin: 'a#D-4', approval: 'yes' }])).ok).toBe(false);
    expect(parsed((doc) => (doc['board'] = { states: [{ name: 'open', count: 1, session: 's' }], statesOmitted: 0, fields: [] })).ok).toBe(false);
    expect(parsed((doc) => (doc['children'] = [{ ...child, session: 's' }])).ok).toBe(false);
  });

  it('never repeats a rejected value or a key that looks like a token in the error', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const message = failureOf(parsed((doc) => ((doc['workers'] as unknown[]).push({ ...worker, id: secret }))));
    expect(message).not.toContain(secret);
    const keyed = failureOf(parsed((doc) => (doc[secret] = 'x')));
    expect(keyed).not.toContain(secret);
  });
});

describe('the report caps (AC-12 limits)', () => {
  it('accepts a list at its cap and refuses one more', () => {
    const many = (count: number, make: (at: number) => unknown): unknown[] => Array.from({ length: count }, (_, at) => make(at));
    const workerAt = (at: number): unknown => ({ ...worker, id: `w${at}` });
    const childAt = (at: number): unknown => ({ ...child, id: `c${at}` });
    const itemAt = (at: number): unknown => ({ id: `B-${at}`, title: 't', state: 's', track: null, stage: null });
    const requestAt = (at: number): unknown => ({ id: `D-${at}`, title: null, origin: `acme#D-${at}` });
    const cases: ReadonlyArray<readonly [string, number, (at: number) => unknown]> = [
      ['workers', reportLimits.maxWorkers, workerAt],
      ['children', reportLimits.maxChildren, childAt],
      ['inProgress', reportLimits.maxItems, itemAt],
      ['requests', reportLimits.maxRequests, requestAt],
    ];
    for (const [key, cap, make] of cases) {
      expect(parsed((doc) => (doc[key] = many(cap, make))).ok, `${key} at the cap`).toBe(true);
      expect(parsed((doc) => (doc[key] = many(cap + 1, make))).ok, `${key} over the cap`).toBe(false);
    }
  });

  it('refuses a text over the text cap', () => {
    const long = 'x'.repeat(reportLimits.maxTextChars + 1);
    expect(parsed((doc) => (doc['requests'] = [{ id: 'D-4', title: long, origin: 'acme#D-4' }])).ok).toBe(false);
    expect(parsed((doc) => (doc['requests'] = [{ id: 'D-4', title: 'x'.repeat(reportLimits.maxTextChars), origin: 'a#D-4' }])).ok).toBe(true);
  });

  it('accepts a list of counts at its cap and refuses one more row, for the states and for the values of a field', () => {
    const rows = (length: number): unknown[] => Array.from({ length }, (_, at) => ({ name: `s${at}`, count: 1 }));
    const states = (length: number) => (doc: Record<string, unknown>): void => {
      doc['board'] = { states: rows(length), statesOmitted: 0, fields: [] };
    };
    const values = (length: number) => (doc: Record<string, unknown>): void => {
      doc['board'] = { states: [], statesOmitted: 0, fields: [{ field: 'lane', values: rows(length), valuesOmitted: 0 }] };
    };
    expect(parsed(states(reportLimits.maxCountRows)).ok).toBe(true);
    expect(parsed(states(reportLimits.maxCountRows + 1)).ok).toBe(false);
    expect(parsed(values(reportLimits.maxCountRows)).ok).toBe(true);
    expect(parsed(values(reportLimits.maxCountRows + 1)).ok).toBe(false);
  });

  it('refuses a count that is negative, fractional or past the number cap', () => {
    const board = (count: number): unknown => ({ states: [{ name: 'open', count }], statesOmitted: 0, fields: [] });
    expect(parsed((doc) => (doc['board'] = board(-1))).ok).toBe(false);
    expect(parsed((doc) => (doc['board'] = board(1.5))).ok).toBe(false);
    expect(parsed((doc) => (doc['board'] = board(reportLimits.maxNumber + 1))).ok).toBe(false);
    expect(parsed((doc) => (doc['board'] = board(reportLimits.maxNumber))).ok).toBe(true);
  });

  it('refuses a number of left-out rows that is missing, negative, fractional or past the number cap', () => {
    const board = (statesOmitted: unknown, valuesOmitted: unknown): unknown => ({
      states: [],
      statesOmitted,
      fields: [{ field: 'lane', values: [], valuesOmitted }],
    });
    expect(parsed((doc) => (doc['board'] = board(3, 4))).ok).toBe(true);
    for (const bad of [-1, 1.5, reportLimits.maxNumber + 1, '3', null]) {
      expect(parsed((doc) => (doc['board'] = board(bad, 0))).ok, `statesOmitted ${String(bad)}`).toBe(false);
      expect(parsed((doc) => (doc['board'] = board(0, bad))).ok, `valuesOmitted ${String(bad)}`).toBe(false);
    }
    expect(parsed((doc) => (doc['board'] = { states: [], fields: [] })).ok).toBe(false);
    expect(parsed((doc) => (doc['board'] = { states: [], statesOmitted: 0, fields: [{ field: 'lane', values: [] }] })).ok).toBe(false);
  });

  it('allows as many worker rows as the worker list can read, so a worker that the list reads never stops the report', () => {
    expect(reportLimits.maxWorkers).toBe(workerRecord.maxEntries);
  });

  it('keeps a report of the most workers, each row at its largest size, under the byte cap of the report file', () => {
    // A worker id and a project are slugs of at most 40 characters. The text of a work item is cut at the text cap, and
    // a character of 3 bytes in UTF-8 is the widest one that the file keeps.
    const widest = (at: number): unknown => ({
      ...worker,
      id: `${'w'.repeat(36)}${String(at).padStart(4, '0')}`,
      project: 'p'.repeat(40),
      state: 'at prompt',
      contextPct: null,
      activityAt: '2026-11-13T10:00:00.000Z',
      workItem: '世'.repeat(reportLimits.maxTextChars),
    });
    const result = parseReport({ ...document(), workers: Array.from({ length: reportLimits.maxWorkers }, (_, at) => widest(at)) });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.workers).toHaveLength(reportLimits.maxWorkers);
    expect(Buffer.byteLength(renderJson(result.value), 'utf8')).toBeLessThan(reportLimits.maxBytes);
  });
});

describe('the child row (AC-19, final in this version)', () => {
  const rowParses = (row: unknown): boolean => parsed((doc) => (doc['children'] = [row])).ok;

  it('holds id, address, state, reason, counts and age', () => {
    expect(Object.keys(child).sort()).toEqual(['address', 'age', 'counts', 'id', 'reason', 'state']);
    expect(rowParses(child)).toBe(true);
  });

  it.each(['ok', 'unknown', 'mismatch'])('accepts the state %s', (state) => {
    expect(rowParses({ ...child, state })).toBe(true);
  });

  it('refuses any other state, also the word dead', () => {
    expect(rowParses({ ...child, state: 'dead' })).toBe(false);
    expect(rowParses({ ...child, state: '' })).toBe(false);
  });

  it('accepts an unknown row with a reason, no counts and the age of the file', () => {
    expect(rowParses({ ...child, state: 'unknown', reason: 'the report is not valid', counts: null, age: 90 })).toBe(true);
  });

  it('accepts a row with no age, and refuses a negative or fractional age', () => {
    expect(rowParses({ ...child, age: null })).toBe(true);
    expect(rowParses({ ...child, age: -1 })).toBe(false);
    expect(rowParses({ ...child, age: 0.5 })).toBe(false);
  });

  it('refuses a row that leaves a key out, so that a later version can not change the row', () => {
    for (const key of Object.keys(child)) {
      const { [key]: _left, ...rest } = child as Record<string, unknown>;
      expect(rowParses(rest), key).toBe(false);
    }
  });

  it('refuses counts with a key that is not in the list, and a missing key', () => {
    expect(rowParses({ ...child, counts: { workers: 1, inProgress: 0, requests: 0, children: 0, pane: 1 } })).toBe(false);
    expect(rowParses({ ...child, counts: { workers: 1, inProgress: 0, requests: 0 } })).toBe(false);
  });

  it('refuses an id that is not a slug', () => {
    expect(rowParses({ ...child, id: '../up' })).toBe(false);
  });
});

describe('parseReport', () => {
  it.each([[null], [undefined], ['text'], [7], [[]]])('returns an error, and never throws, for %j', (input) => {
    const result = parseReport(input);
    expect(result.ok).toBe(false);
  });

  it('names the key path of a fault and not the rejected value', () => {
    const message = failureOf(parsed((doc) => (doc['layer'] = 'SECRET-LAYER')));
    expect(message).toContain('layer');
    expect(message).not.toContain('SECRET-LAYER');
  });

  it('does not change the input', () => {
    const doc = document();
    const before = JSON.stringify(doc);
    parseReport(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
