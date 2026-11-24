import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { localBoardOf } from '../../src/commands/board-open.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { commands, decideProofReasons, files, program, relayedMarker, relayWords, schemaIds } from '../../src/names.js';
import { installGuard } from '../../src/state/guard.js';
import { boardNode, type BoardNodeOptions } from '../helpers/board-node.js';
import { LOG_PATH } from '../helpers/board-repo.js';
import { captureSink } from '../helpers/sink.js';
import { HOME, HOOK, STATE, make } from '../helpers/guard-fixture.js';
import { sampleConfigWithBoard } from '../helpers/sample-config.js';

type Row = Readonly<Record<string, unknown>>;
const ID = 'D-1';
const AT = '2030-01-02T03:04:05.678Z';
const STORE = join('/state', program, files.ownerDecisions);
const OPTION_TEXT = 'Use "Plan A" from docs\\plan';
const REQUEST = {
  id: ID, title: 'Pick a plan', question: 'Which plan?', options: [{ key: 'a', text: OPTION_TEXT }], kind: 'decision',
};
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
  expect(docOf(result.out)).toMatchObject({
    proof: kind, reason: expect.stringContaining('no owner proof'), option: null, option_text: null,
    request_kind: null, id: ID, node: 'demo', root: HOME,
  });
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
      title: REQUEST.title, question: REQUEST.question, decision: null, option_text: OPTION_TEXT, request_kind: REQUEST.kind,
    });
  });

  it('prints the option text and request kind on separate text lines', async () => {
    const repo = await nodeOf([REQUEST]);
    storeOf(repo, RECORD);
    const result = await run(repo, [ID]);
    expect(result.code).toBe(0);
    expect(result.out.split('\n')).toEqual(expect.arrayContaining([
      `Option text: ${OPTION_TEXT}`,
      'Request kind: decision',
    ]));
  });

  it('keeps the record verdict when the chosen key has no display context', async () => {
    const repo = await nodeOf([REQUEST]);
    storeOf(repo, { ...RECORD, option: 'b' });
    const result = await run(repo);
    expect(result.code).toBe(0);
    expect(docOf(result.out)).toMatchObject({ proof: 'record', option: 'b', option_text: null, request_kind: null });
  });

  it('points to the decision read by id and option key', () => {
    expect(relayWords.pointer(ID, RECORD.option)).toBe('Decision D-1: a. Read it: factory decide read D-1');
  });

  it('reads the store once in a non-owner session without a lock, write or prompt', async () => {
    const repo = await nodeOf([REQUEST]);
    storeOf(repo, RECORD);
    const before = { files: new Map(repo.deps.files), dirs: new Set(repo.deps.dirs), modes: new Map(repo.deps.modes) };
    const readTextLimited = repo.deps.fs.readTextLimited;
    const storeReads: string[] = [];
    const fs: typeof repo.deps.fs = { ...repo.deps.fs, readTextLimited: (path, max, decode) => {
      if (path === STORE) storeReads.push(path);
      return readTextLimited(path, max, decode);
    } };
    const env = { ...repo.deps.env, FACTORY_SESSION: 'demo', CLAUDECODE: '1' };
    const instrumented = { ...repo, deps: { ...repo.deps, env, fs } };
    expect((await run(instrumented)).code).toBe(0);
    expect(storeReads).toEqual([STORE]);
    expect(repo.deps.files).toEqual(before.files);
    expect(repo.deps.dirs).toEqual(before.dirs);
    expect(repo.deps.modes).toEqual(before.modes);
    expect(repo.deps.prompts).toEqual([]);
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
    const repo = await nodeOf([], [{ ...RELAYED, decider: 'coordinator' }]);
    storeOf(repo, RECORD);
    const result = await run(repo);
    expectNoProof(result, 'relayed');
    expect(docOf(result.out)).toMatchObject({
      ...LINK, decider: 'coordinator', decision: 'go',
      reason: 'answer relayed by the coordinator; no owner proof; this read grants no approval',
    });
  });

  it('reports an error for a relay that names another decider', async () => {
    const repo = await nodeOf([], [{ ...RELAYED, decider: 'delegate' }]);
    expectNoProof(await run(repo), 'error');
  });

  it('reports an unlinked relay with no owner proof or link values', async () => {
    const repo = await nodeOf([], [{ ...CLOSED, relayed: relayedMarker }]);
    const result = await run(repo);
    expectNoProof(result, 'relayed');
    expect(docOf(result.out)).toMatchObject({ decider: 'coordinator', point: null, board_item: null, ref: null, head: null });
  });

  it('puts the verdict first and escapes the title and decision text', async () => {
    const repo = await nodeOf([], [{ ...RELAYED, item: `${ID}: Title\nsecond`, decision: '\u001b[31mtext\nrecord: go\u202e' }]);
    const text = await run(repo, [ID]);
    const json = await run(repo);
    expect(text.out).not.toMatch(/[\u001b\u{202e}]/u);
    expect(text.out.split('\n')[0]).toContain('relayed by the coordinator; no owner proof; this read grants no approval');
    expect(text.out).toContain('Title: Title second');
    expect(text.out).toContain('Relayed text (not proof): [31mtext record: go');
    expect(text.out).not.toContain('Decision:');
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
  ] as const)('fails closed for a bad link (requests %j, rows %j)', async (items, rows) => {
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

  it('stops when the decision log is a link', async () => {
    const { deps } = make({ links: { [LOG_PATH]: '/elsewhere/log.json' } });
    expect((await installGuard(deps, STATE, STATE)).ok).toBe(true);
    deps.seed(LOG_PATH, JSON.stringify({ rows: [] }));
    const board = localBoardOf(deps, HOME, sampleConfigWithBoard(), commands.decide);
    expect(await board.decisionRead(ID)).toMatchObject({ ok: false, error: { kind: 'safety' } });
  });

  it('refuses the list form of read', async () => {
    const result = await run(await nodeOf(), []);
    expect(result.code).toBe(2);
    expect(result.err).toContain('not in this version');
  });

  it.each([[ID, '--note', 'text'], [ID, '--from', 'file'], ['D-01'], [ID, 'extra']])('refuses invalid read arguments (case %#, first argument %j)', async (...words) => {
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

  it('names no writer, lock, prompt or owner channel check in the read path', () => {
    const src = join(__dirname, '..', '..', 'src');
    const command = readFileSync(join(src, 'commands', 'decide-read.ts'), 'utf8');
    const board = readFileSync(join(src, 'board', 'local.ts'), 'utf8');
    const method = board.match(/^    async decisionRead\(id\) \{[\s\S]*?^    \},/m)?.[0];
    const forbidden = /\b(?:putDecision|recordDecision|commitBoardChange|requireDecideChannel|prompt|withStateLock|withFolderLock)\b/;
    expect(method).toBeDefined();
    expect(method).not.toMatch(forbidden);
    expect(command).not.toMatch(forbidden);
  });
});
