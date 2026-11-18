import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as decide from '../../src/board/decide.js';
import { parseDecisionLog, parseWaiting } from '../../src/board/files.js';
import type { RequestLinkRules } from '../../src/board/requests.js';
import { runCli } from '../../src/cli/run.js';
import type { DecisionRecord } from '../../src/core/owner-record.js';
import { err, ok, type Result } from '../../src/core/result.js';
import { approvalOptions, files, program, requestDeciders } from '../../src/names.js';
import { softwareRecipe } from '../../src/recipes/software/entry.js';
import type { ApprovalMode } from '../../src/recipes/entry.js';
import { APPROVAL_ID, APPROVAL_LINK, approvalAnswer, approvalRelay, approvalRequest } from '../helpers/approval-go.js';
import { boardNode } from '../helpers/board-node.js';
import { HOME } from '../helpers/guard-fixture.js';
import { captureSink } from '../helpers/sink.js';

type Row = Readonly<Record<string, unknown>>;
const { item, point, ref, head } = APPROVAL_LINK;
const check = softwareRecipe.recordCheck;
if (check === undefined) throw new Error('the software recipe has no record check');
const rules: RequestLinkRules = { points: [point, 'release'], parseRef: check.parseRef, parseHead: check.parseHead };
const request = approvalRequest();
const { row: answer, record } = approvalAnswer();
const { relayed, decider, ...close } = approvalRelay();
const relay = { ...close, relayed, decider };
const noStore = ok({ record: null });
const storeFault = err('Private store text');

const textsOf = (items: readonly Row[], rows: readonly Row[]) => ({
  waiting: JSON.stringify({ intro: '', groups: [], items }), decisionLog: JSON.stringify({ rows }),
});

type Store = Result<{ readonly record: Readonly<DecisionRecord> | null }, string>;
const verdictOf = (items: readonly Row[], rows: readonly Row[], stored: Store = noStore, target: {
  readonly mode?: ApprovalMode; readonly ref?: string; readonly head?: string | null;
} = {}) => {
  const texts = textsOf(items, rows);
  const waiting = parseWaiting(texts.waiting);
  const log = parseDecisionLog(texts.decisionLog);
  if (!waiting.ok || !log.ok) throw new Error('invalid test documents');
  const docs = { waiting: waiting.value, log: log.value };
  const linked = decide.linkedApprovalsOf(docs.waiting, docs.log, item, point, rules);
  return decide.approvalVerdict({ docs, linked, rules, stored, mode: 'owner', ref, head, ...target });
};

const refusal = (id: string) => ({ ok: false, error: { kind: 'failure', message: expect.stringContaining(id) } });

const proofCases = [
  { name: 'store approve', items: [], rows: [answer], stored: ok({ record }), proof: 'record', passes: true },
  { name: 'store stop', items: [], rows: [answer], stored: ok({ record: { ...record, option: approvalOptions.stop } }), proof: 'record', passes: false },
  { name: 'relayed approve', items: [], rows: [relay], stored: noStore, proof: 'relayed', passes: true },
  { name: 'relay with store stop', items: [], rows: [relay], stored: ok({ record: { ...record, option: approvalOptions.stop } }), proof: 'relayed', passes: false },
  { name: 'relay with unsettled store approve', items: [], rows: [relay], stored: ok({ record }), proof: 'relayed', passes: false },
  { name: 'relayed stop', items: [], rows: [{ ...relay, decision: approvalOptions.stop }], stored: noStore, proof: 'relayed', passes: false },
  { name: 'relay without a decider', items: [], rows: [{ ...relay, decider: undefined }], stored: noStore, proof: 'relayed', passes: false },
  { name: 'relay without the fixed marker', items: [], rows: [{ ...relay, relayed: false }], stored: noStore, proof: 'relayed', passes: false },
  { name: 'relay with an answer key', items: [], rows: [{ ...answer, ...relay }], stored: noStore, proof: 'relayed', passes: false },
  { name: 'plain close', items: [], rows: [{ ...close, decision: 'closed' }], stored: noStore, proof: 'closed', passes: false },
  { name: 'made-by close', items: [], rows: [{ ...close, decider }], stored: noStore, proof: 'closed', passes: false },
  { name: 'open request', items: [request], rows: [], stored: noStore, proof: 'open', passes: false },
  { name: 'unsettled answer', items: [request], rows: [], stored: ok({ record }), proof: 'record', passes: false },
  { name: 'absent store record', items: [], rows: [answer], stored: noStore, proof: 'none', passes: false },
  { name: 'hash mismatch', items: [], rows: [answer], stored: ok({ record: { ...record, hash: '0'.repeat(64) } }), proof: 'mismatch', passes: false },
  { name: 'foreign relay decider', items: [], rows: [{ ...relay, decider: requestDeciders.delegate }], stored: noStore, proof: 'error', passes: false },
  { name: 'store read fault', items: [], rows: [relay], stored: storeFault, proof: 'error', passes: false },
] as const;

describe('approval check: static checks of the source', () => {
  it.each(['board/decide.ts', 'board/local.ts', 'commands/item.ts'])('%s imports no decision command module', (path) => {
    const file = join(__dirname, '..', '..', 'src', path);
    const source = readFileSync(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imported = [...code.matchAll(/\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)]
      .map((match) => resolve(dirname(file), match[1] ?? ''));
    expect(imported.filter((name) => /[/\\](?:decide-read|commands[/\\]decide)(?:\.[cm]?[jt]s)?$/.test(name))).toEqual([]);
  });
});

describe('approval verdict', () => {
  it.each(proofCases)('uses the proof from decide read for $name, not its exit code', async ({ items, rows, stored, proof, passes }) => {
    const repo = await boardNode(textsOf(items, rows));
    const store = !stored.ok ? '{' : JSON.stringify({ schema: 1, records: stored.value.record === null ? [] : [stored.value.record] });
    repo.deps.seed(join('/state', program, files.ownerDecisions), store);
    const sink = captureSink();
    const code = await runCli(['decide', 'read', APPROVAL_ID, '--json', '--home', HOME], repo.deps, sink);
    const report: unknown = JSON.parse(sink.out.join(''));

    expect(report).toMatchObject({ proof });
    expect(code).toBe(proof === 'record' ? 0 : 1);
    expect(verdictOf(items, rows, stored)).toMatchObject(passes ? { ok: true } : refusal(APPROVAL_ID));
  });

  it('names the last settled request even when its number is lower', () => {
    const go = approvalRelay('D-9');
    const stop = approvalRelay('D-2', approvalOptions.stop);
    expect(verdictOf([], [go, stop])).toMatchObject(refusal('D-2'));
    expect(verdictOf([], [stop, go])).toMatchObject({ ok: true });
  });

  it('refuses a linked row with no request id after a linked approve', () => {
    const noId = { ...relay, item: 'Approval without an id' };
    expect(verdictOf([], [relay, noId])).toMatchObject({
      ok: false, error: { kind: 'failure', message: 'a linked approval row has no request id' },
    });
  });

  it('refuses an open linked request even after a linked approve', () => {
    expect(verdictOf([approvalRequest('D-2')], [relay])).toMatchObject(refusal('D-2'));
  });

  it('tells the caller to run decide again if the request still waits', () => {
    expect(verdictOf([request], [], ok({ record }))).toMatchObject({
      ...refusal(APPROVAL_ID), error: { kind: 'failure', hint: expect.stringMatching(/decide.*again/u) },
    });
  });

  it('requires a linked request even if an unlinked owner answer has display link keys', () => {
    const unlinked = approvalAnswer({ ...request, fields: [] });
    const { board_item, point, ref, head } = relay;
    expect(verdictOf([], [{ ...unlinked.row, board_item, point, ref, head }], ok({ record: unlinked.record }))).toMatchObject({
      ok: false, error: { kind: 'failure', hint: expect.stringMatching(/request add.*current head of the reference.*decide.*request close --relayed/u) },
    });
  });

  it.each([{ ref: '43' }, { head: 'b'.repeat(40) }])('requires a new request for a different reference or head (%j)', (target) => {
    expect(verdictOf([], [relay], noStore, target)).toMatchObject({
      ok: false, error: { kind: 'failure', message: expect.stringContaining(APPROVAL_ID), hint: expect.stringMatching(/new request.*new head/u) },
    });
  });

  it('checks evidence but not the reference or head before the external check', () => {
    expect(verdictOf([], [relay], noStore, { ref: '43', head: null })).toMatchObject({ ok: true });
    expect(verdictOf([], [{ ...relay, decision: approvalOptions.stop }], noStore, { head: null })).toMatchObject(refusal(APPROVAL_ID));
  });

  it('refuses a link fault on an older row for the item', () => {
    const broken = { ...approvalRelay('D-2'), head: 'Private head' };
    expect(verdictOf([], [broken, relay])).toMatchObject(refusal('D-2'));
  });

  it('refuses a link fault in the request text of an answer for the item', () => {
    const broken = approvalAnswer(approvalRequest('D-2', { ...APPROVAL_LINK, head: 'Private head' }));
    expect(verdictOf([], [broken.row, relay])).toMatchObject(refusal('D-2'));
  });

  it('refuses an answer that names this item but has no request text', () => {
    const broken = { ...approvalRelay('D-2'), by: 'owner', relayed: undefined };
    expect(verdictOf([], [broken, relay])).toMatchObject(refusal('D-2'));
  });

  it('does not substitute a display head for the head in the answered request', () => {
    const otherHead = approvalAnswer(approvalRequest(APPROVAL_ID, { ...APPROVAL_LINK, head: 'b'.repeat(40) }));
    const mixed = { ...otherHead.row, ...relay };
    expect(verdictOf([], [mixed], ok({ record: otherHead.record }))).toMatchObject(refusal(APPROVAL_ID));
  });

  it('ignores a fault on a waiting entry or a settled row that names another item', () => {
    const other = { ...APPROVAL_LINK, item: 'B-2', head: 'Private head' };
    const waiting = approvalRequest('D-2', other);
    const closed = approvalRelay('D-3', approvalOptions.stop, other);
    const answered = approvalAnswer(approvalRequest('D-4', other));
    expect(verdictOf([waiting], [relay, closed, answered.row])).toMatchObject({ ok: true });
  });

  it('ignores valid links for another approval point', () => {
    const other = { ...APPROVAL_LINK, point: 'release' };
    expect(verdictOf([approvalRequest('D-2', other)], [relay, approvalRelay('D-3', approvalOptions.stop, other)])).toMatchObject({ ok: true });
  });

  it.each(proofCases)('in delegated mode refuses only open links: $name', ({ items, rows, stored }) => {
    expect(verdictOf(items, rows, stored, { mode: 'delegated' })).toMatchObject(items.length === 0 ? { ok: true } : refusal(APPROVAL_ID));
  });

  it('passes delegated mode without linked requests and ignores settled link faults', () => {
    expect(verdictOf([], [], noStore, { mode: 'delegated' })).toMatchObject({ ok: true });
    expect(verdictOf([], [{ ...relay, head: 'Private head' }], noStore, { mode: 'delegated' })).toMatchObject({ ok: true });
  });

  it('refuses without an echo of the title, question, field, decision or store text', () => {
    const verdicts = [
      verdictOf([request], []),
      verdictOf([], [{ ...relay, decision: 'Private decision' }]),
      verdictOf([], [answer], storeFault),
      verdictOf([approvalRequest(APPROVAL_ID, { ...APPROVAL_LINK, head: 'Private head' })], []),
    ];
    for (const verdict of verdicts) {
      expect(verdict).toMatchObject(refusal(APPROVAL_ID));
      expect(JSON.stringify(verdict)).not.toContain('Private');
    }
  });
});
