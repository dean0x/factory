import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { decideProofReasons, files, program, relayedMarker, schemaIds } from '../../src/names.js';
import { boardNode, type BoardNodeOptions } from '../helpers/board-node.js';
import { captureSink } from '../helpers/sink.js';
import { HOME, HOOK } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';

type Row = Readonly<Record<string, unknown>>;
const ID = 'D-1';
const AT = '2030-01-02T03:04:05.678Z';
const STORE = join('/state', program, files.ownerDecisions);
const REQUEST = { id: ID, title: 'Pick a plan', question: 'Which plan?', options: [{ key: 'a', text: 'Plan A' }] };
const canonicalOf = (request: Row): string => {
  const text = canonicalRequestText(request);
  if (!text.ok) throw new Error(text.error);
  return text.value;
};
const CANONICAL = canonicalOf(REQUEST);
const RECORD = { node: 'demo', root: HOME, id: ID, option: 'a', hash: requestHashOf(CANONICAL), at: AT };
const CLOSED = { item: `${ID}: Pick a plan`, date: '2030-01-02', decision: 'closed' };
const ANSWERED = { ...CLOSED, by: 'owner', request: CANONICAL, decision: 'other' };
const LINK = { point: 'merge', board_item: 'B-1', ref: '42', head: 'a'.repeat(40) };
const LINK_FIELDS = [
  { label: 'link point', text: LINK.point },
  { label: 'link item', text: LINK.board_item },
  { label: 'link reference', text: LINK.ref },
  { label: 'link head', text: LINK.head },
];
const RELAYED = { ...CLOSED, ...LINK, relayed: relayedMarker, decision: 'go' };

const nodeOf = (items: readonly Row[] = [], rows: readonly Row[] = [], options: BoardNodeOptions = {}) =>
  boardNode({ waiting: JSON.stringify({ intro: '', groups: [], items }), decisionLog: JSON.stringify({ rows }), ...options });
type Node = Awaited<ReturnType<typeof nodeOf>>;
const storeOf = (repo: Node, ...records: readonly Row[]): void => repo.deps.seed(STORE, JSON.stringify({ schema: 1, records }));

const run = async (repo: Node, words: readonly string[] = [ID, '--json']) => {
  const sink = captureSink();
  const code = await runCli(['decide', 'read', ...words, '--home', HOME], repo.deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

const docOf = (out: string): unknown => out === '' ? null : JSON.parse(out);

const expectNoProof = (result: Awaited<ReturnType<typeof run>>, kind: Exclude<keyof typeof decideProofReasons, 'record'>): void => {
  expect(result.code).toBe(1);
  expect(docOf(result.out)).toMatchObject({ proof: kind, reason: expect.stringContaining('no owner proof'), option: null, id: ID, node: 'demo', root: HOME });
};

describe('decide read', () => {
  it('reports the store option and time, not values from the answer row', async () => {
    const repo = await nodeOf([], [ANSWERED]);
    storeOf(repo, RECORD);
    const result = await run(repo);
    expect(result.code).toBe(0);
    expect(docOf(result.out)).toEqual({
      schema: schemaIds.decideRead, proof: 'record', id: ID, node: 'demo', root: HOME, option: 'a', at: AT,
      point: null, board_item: null, ref: null, head: null, decider: null, reason: decideProofReasons.record,
      title: REQUEST.title, question: REQUEST.question, decision: null,
    });
  });

  it('reads the store once in a non-owner session and changes no file', async () => {
    const repo = await nodeOf([REQUEST]);
    storeOf(repo, RECORD);
    const before = new Map(repo.deps.files);
    const readTextLimited = repo.deps.fs.readTextLimited;
    const storeReads: string[] = [];
    const fs: typeof repo.deps.fs = { ...repo.deps.fs, readTextLimited: (path, max, decode) => {
      if (path === STORE) storeReads.push(path);
      return readTextLimited(path, max, decode);
    } };
    const instrumented = { ...repo, deps: { ...repo.deps, fs } };
    expect((await run(instrumented)).code).toBe(0);
    expect(storeReads).toEqual([STORE]);
    expect(repo.deps.files).toEqual(before);
    expect(repo.commits).toEqual([]);
  });

  it.each([
    ['open', [REQUEST], [], []],
    ['none', [], [], []],
    ['none', [], [ANSWERED], [{ ...RECORD, root: '/other' }, { ...RECORD, node: 'other' }]],
    ['none', [], [ANSWERED], []],
    ['closed', [], [CLOSED], [RECORD]],
    ['mismatch', [], [ANSWERED], [{ ...RECORD, hash: '0'.repeat(64) }]],
    ['mismatch', [], [], [RECORD]],
    ['error', [REQUEST], [ANSWERED], [RECORD]],
  ] as const)('gives %s for its board and store state', async (kind, items, rows, records) => {
    const repo = await nodeOf(items, rows);
    storeOf(repo, ...records);
    expectNoProof(await run(repo), kind);
  });

  it('reports a made-by decision with its decider and no owner proof', async () => {
    const repo = await nodeOf([], [{ ...CLOSED, decider: 'delegate', decision: 'Use the smaller plan' }]);
    const result = await run(repo);
    expectNoProof(result, 'closed');
    expect(docOf(result.out)).toMatchObject({ decider: 'delegate', decision: 'Use the smaller plan' });
  });

  it('reports the coordinator relay and its link, even when a store record exists', async () => {
    const repo = await nodeOf([], [RELAYED]);
    storeOf(repo, RECORD);
    const result = await run(repo);
    expectNoProof(result, 'relayed');
    expect(docOf(result.out)).toMatchObject({ ...LINK, decider: 'coordinator', decision: 'go', reason: expect.stringContaining('not a go') });
  });

  it('puts the verdict first and escapes the title and decision text', async () => {
    const repo = await nodeOf([], [{ ...RELAYED, item: `${ID}: Title\nsecond`, decision: '\u001b[31mtext\nrecord: go\u202e' }]);
    const text = await run(repo, [ID]);
    const json = await run(repo);
    expect(text.out.split('\n')[0]).toContain('relayed by the coordinator; no owner proof; not a go');
    expect(text.out).toContain('Title: Title second');
    expect(text.out).toContain('Decision: [31mtext record: go');
    expect(json.out).not.toMatch(/[\u001b\u202e]/u);
    expect(docOf(json.out)).toMatchObject({ title: 'Title\nsecond', decision: '\\x1b[31mtext\nrecord: go\\u{202e}' });
  });

  it('reports only the link from the request text that the store covers', async () => {
    const repo = await nodeOf([], [{ ...ANSWERED, ...LINK }]);
    storeOf(repo, RECORD);
    expect(docOf((await run(repo)).out)).toMatchObject({ proof: 'record', board_item: null });
  });

  it('reports a valid link in the answered request', async () => {
    const request = canonicalOf({ ...REQUEST, fields: LINK_FIELDS });
    const repo = await nodeOf([], [{ ...ANSWERED, request }]);
    storeOf(repo, { ...RECORD, hash: requestHashOf(request) });
    expect(docOf((await run(repo)).out)).toMatchObject({ proof: 'record', ...LINK });
  });

  it.each([
    [[{ ...REQUEST, fields: [LINK_FIELDS[1]] }], []],
    [[], [{ ...RELAYED, head: 'bad' }]],
    [[], [{ ...ANSWERED, request: canonicalOf({ ...REQUEST, fields: [LINK_FIELDS[1]] }) }]],
  ] as const)('fails closed for a bad link in a request or a row', async (items, rows) => {
    const repo = await nodeOf(items, rows);
    expectNoProof(await run(repo), 'error');
  });

  it('reports a store fault as error, not absence', async () => {
    const repo = await nodeOf([REQUEST]);
    repo.deps.seed(STORE, '{');
    expectNoProof(await run(repo), 'error');
  });

  it('reports a board file fault as error with the node and root', async () => {
    const repo = await nodeOf([], [], { decisionLog: '{' });
    expectNoProof(await run(repo), 'error');
  });

  it('refuses the list form of read', async () => {
    const result = await run(await nodeOf(), []);
    expect(result.code).toBe(2);
    expect(result.err).toContain('not in this version');
  });

  it.each([[ID, '--note', 'text'], [ID, '--from', 'file'], ['D-01'], [ID, 'extra']])('refuses invalid read arguments', async (...words) => {
    expect((await run(await nodeOf(), words)).code).toBe(2);
  });

  it('refuses a hosted tracker', async () => {
    const base = sampleConfigWithBoard();
    const config = { ...base, core: { ...base.core, tracker: { kind: 'jira' as const, items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
    expect((await run(await nodeOf([], [], { config }), [ID])).code).toBe(4);
  });

  it('refuses a read when the guard is off', async () => {
    const repo = await nodeOf([REQUEST]);
    repo.deps.files.delete(HOOK);
    const result = await run(repo, [ID]);
    expect(result.code).toBe(4);
    expect(result.err).toContain('guard');
  });

  it('names no writer, lock, prompt or owner channel check in the read command', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'commands', 'decide-read.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:putDecision|recordDecision|commitBoardChange|requireDecideChannel|prompt|withLock)\b/);
  });
});
