import { sha256Hex } from '../blocks/managed.js';
import type { LocalBoard, RequestKind } from '../board/contract.js';
import type { RequestProof } from '../board/decide.js';
import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import { prefixStoreFault } from '../commands/launch-checks.js';
import { relayLineOf, typeRelayLine } from '../comms/typing.js';
import type { Deps } from '../core/deps.js';
import { guardReadOf } from '../core/guard-source.js';
import { ok } from '../core/result.js';
import { guardValuesFor, isGuardOn } from '../guards/effective.js';
import {
  boardIds, commandLines, commandText, decideProof, decideProofReasons, flags, flagText, guardIds, relayWords,
  requestKinds, roles, schemaIds,
} from '../names.js';
import { confirmRelay } from './confirm.js';
import { deniedMatchOf, readDeniedList } from './denied.js';
import { requireNodeCaller } from './panes.js';
import { requireRecord, type WorkerRecord } from './registry.js';
import {
  requireFreshSession, requireIdleSession, requireLivePane, requireOutOfView, requireSamePane, type WorkerTarget,
} from './reset.js';

/**
 * Relay checks, in order. All refusals come before the keys, except a failed key run or confirm.
 *  1. Check the command words and the exact decision id (exit 2).
 *  2. Require the coordinator pane or an owner terminal (exit 2, 3 or 4).
 *  3. Read the guard values. Only the tmux mode check uses them.
 *  4. Read the worker record (exit 2 or 4).
 *  5. Require an owner record with request context and no approval link (exit 1 or 4).
 *  6. Require an exact prefix confirmation (exit 4).
 *  7. Refuse a command request (exit 4).
 *  8. Check the denied list (exit 4).
 *  9. Build and check the line before any worker pane read (exit 1 or 4).
 * 10. Check the live bound pane, view, fresh session, idle prompt and same pane in that order (exit 1 to 4).
 * 11. Take the time, check the line again, check mode and choices, and type the keys (exit 1 or 3 for pane and key faults).
 * 12. Confirm a later turn from the same session (exit 1 or 3).
 */
export interface RelayRequest extends WorkerTarget {
  readonly id: string;
}

export interface RelayOutcome {
  readonly workerId: string;
  readonly decision: string;
  readonly option: string;
  readonly paneId: string;
  readonly modeCheckSkipped: boolean;
}

type ReadDecision = LocalBoard['decisionRead'];
type OwnerRecord = Extract<RequestProof, { kind: typeof decideProof.record }> & {
  readonly optionText: string;
  readonly requestKind: RequestKind;
};

const requireOwnerRecord = async (readDecision: ReadDecision, id: string): Promise<CliResult<OwnerRecord>> => {
  const read = await readDecision(id);
  if (!read.ok) return read;
  const { proof } = read.value;
  switch (proof.kind) {
    case decideProof.record: {
      const { optionText, requestKind, link } = proof;
      if (optionText === null || requestKind === null) return safetyRefusal(relayWords.missingContext, relayWords.checkRecord());
      if (link !== null) return safetyRefusal(relayWords.linked, relayWords.approvalFlow);
      return ok({ ...proof, optionText, requestKind });
    }
    case decideProof.none:
    case decideProof.open:
    case decideProof.relayed:
    case decideProof.closed:
      return failure(decideProofReasons[proof.kind], relayWords.recordFirst());
    case decideProof.mismatch:
    case decideProof.error:
      return safetyRefusal(decideProofReasons[proof.kind], relayWords.checkRecord());
    default: {
      const unreachable: never = proof;
      return unreachable;
    }
  }
};

const requireRelayPrefix = async (deps: Deps, { home, config }: WorkerTarget): Promise<CliResult<string>> => {
  const { state } = await guardReadOf(deps, home, config, 'always');
  const store = prefixStoreFault(state);
  if (!store.ok) return store;
  if (state.prefix === null) return safetyRefusal(relayWords.missingPrefix, relayWords.confirmPrefix());
  const { prefix } = config.core.owner;
  if (state.prefix.hash !== sha256Hex(prefix)) return safetyRefusal(relayWords.differentPrefix, relayWords.confirmPrefix());
  return ok(prefix);
};

const requireNotCommandKind = (kind: OwnerRecord['requestKind']): CliResult<void> =>
  kind === requestKinds.command ? safetyRefusal(relayWords.commandKind, relayWords.ownerCommand) : ok(undefined);

const requireNoDenial = async (deps: Deps, home: string, record: OwnerRecord): Promise<CliResult<void>> => {
  const list = await readDeniedList(deps, home);
  if (!list.ok) return list;
  const entry = deniedMatchOf(list.value, [record.title ?? '', record.question ?? '', record.optionText]);
  return entry === null ? ok(undefined) : safetyRefusal(relayWords.denied(entry), relayWords.checkDenied);
};

const checkRelayPane = async (deps: Deps, target: WorkerTarget, record: WorkerRecord, again: string) => {
  const live = await requireLivePane(deps, target, again);
  if (!live.ok) return live;
  const placed = requireOutOfView(live.value, target, again, true);
  if (!placed.ok) return placed;
  const start = await requireFreshSession(deps, target, record, live.value, again);
  if (!start.ok) return start;
  const session = await requireIdleSession(deps, target, live.value.paneId, start.value, again, true);
  if (!session.ok) return session;
  const pane = await requireSamePane(deps, target, live.value, again, true);
  return pane.ok ? ok({ paneId: pane.value.paneId, sessionBefore: session.value }) : pane;
};

export const relayWorker = async (deps: Deps, request: RelayRequest, readDecision: ReadDecision): Promise<CliResult<RelayOutcome>> => {
  const { home, config, workerId, id } = request;
  if (!boardIds.canonicalRequest.test(id)) return usageError('the relay needs a canonical decision id', 'Use an id of the form D-1.');
  const tail = `${flagText(flags.decision)} ${id}`;
  const again = `${commandLines.workerRelay} ${workerId} ${tail}`;
  const caller = await requireNodeCaller(deps, home, config, again);
  if (!caller.ok) return caller;
  const guards = await guardValuesFor(deps, home);
  const worker = await requireRecord(deps, home, workerId, commandText(commandLines.workerRelay), tail);
  if (!worker.ok) return worker;
  const record = await requireOwnerRecord(readDecision, id);
  if (!record.ok) return record;
  const prefix = await requireRelayPrefix(deps, request);
  if (!prefix.ok) return prefix;
  const kind = requireNotCommandKind(record.value.requestKind);
  if (!kind.ok) return kind;
  const denied = await requireNoDenial(deps, home, record.value);
  if (!denied.ok) return denied;
  const { at, option } = record.value;
  const parts = { template: prefix.value, display: config.core.owner.display, node: config.core.node.id, at, id, option };
  const line = relayLineOf(parts);
  if (!line.ok) return line;
  const checked = await checkRelayPane(deps, request, worker.value, again);
  if (!checked.ok) return checked;
  const { paneId, sessionBefore } = checked.value;
  const typedAt = deps.now();
  const typed = await typeRelayLine(deps, paneId, parts, `Then run "${commandText(again)}" again.`, guards);
  if (!typed.ok) return typed;
  const confirmed = await confirmRelay(deps, { home, paneId, workerId, id, typedAt, sessionBefore, again });
  if (!confirmed.ok) return confirmed;
  return ok({ workerId, decision: id, option, paneId, modeCheckSkipped: !isGuardOn(guards, guardIds.paneSafety) });
};

export const relayOutput = ({ workerId, decision, option, paneId, modeCheckSkipped }: RelayOutcome): CommandOutput => ({
  lines: [
    { level: 'ok', text: `Relayed decision ${decision}: ${option} to ${roles.worker} ${workerId} in pane ${paneId}.` },
    { level: 'text', text: `Run "${commandText(commandLines.workerWatch)} ${workerId}" to see the next report.` },
    ...(modeCheckSkipped ? [{ level: 'text' as const, text: `${guardIds.paneSafety} is off. The tmux mode check did not apply.` }] : []),
  ],
  json: { schema: schemaIds.workerRelay, id: workerId, decision, option, pane: paneId, confirmed: true },
  warnings: [],
  failed: false,
});
