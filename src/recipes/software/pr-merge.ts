import type { RequestLink } from '../../board/contract.js';
import type { SettledProof } from '../../board/decide.js';
import { exitCodeOf, failure, safetyRefusal, usageError, type CliResult } from '../../cli/errors.js';
import { displayLine, type CommandOutput } from '../../cli/output.js';
import type { Given } from '../../cli/table.js';
import type { Deps } from '../../core/deps.js';
import { inFactorySession } from '../../core/factory-session.js';
import { ok } from '../../core/result.js';
import { isGuardOn } from '../../guards/effective.js';
import type { GuardValues } from '../../guards/types.js';
import { commandLines, commands, commandText, decideProof, eventFile, flags, flagText, guardIds, roles } from '../../names.js';
import type { EventFileInput } from '../../report/event-file.js';
import type { ApprovalMode, RecipeHost, WorkHost } from '../entry.js';
import { softwareApprovalPoints } from './approval.js';
import { checkOutcomeOf } from './check.js';
import { confirmMerged, runMerge, type MergeConfirmation, type MergeTarget } from './github-merge.js';
import { mergeCheck, parsePrNumber } from './github-pr.js';
import { softwareGuardIds } from './guard-parts.js';
import { readinessFor, type Readiness } from './merge-ready.js';
import {
  checkPrRulesOff, checkReasons, checkRemedies, checkWords, mergeEventSchemaId, mergeMethods, prCommands, prFlags, prMergeCommand,
  prMergeOff, prMergeSchemaId, prMergeWords, readinessKinds, softwareProjectKeys,
} from './words.js';

const COMMAND = commands.pr;
const USAGE_HINT = `Run "${commandText(commands.pr)} ${flagText(flags.help)}".`;

type ProofNeed = typeof decideProof.none | 'go' | 'owner-record';
interface ProofPolicy {
  readonly need: ProofNeed;
  readonly offLines: readonly string[];
}

type MergeReadiness = Extract<Readiness, { kind: typeof readinessKinds.ready | typeof readinessKinds.mergedAtPin }>;
type MergeReadinessRefusal = Exclude<Readiness, MergeReadiness>;

type EventOutcome =
  | { readonly kind: 'done' | 'warning' }
  | { readonly kind: 'no-proof'; readonly stop: boolean }
  | { readonly kind: 'stop'; readonly line: string; readonly remedy: string };
interface RecordedMerge {
  readonly proof: SettledProof | null;
  readonly event: EventOutcome;
}
export type MergeOutcome =
  | ({ readonly kind: 'merged' | 'already-recorded' } & RecordedMerge)
  | Exclude<MergeConfirmation, { kind: 'merged' }>
  | { readonly kind: 'merged-not-recorded' };

interface MergeArgs {
  readonly number: number;
  readonly head: string;
  readonly admin: boolean;
  readonly home: string | undefined;
  readonly project: string | undefined;
}

const parseMerge = (words: readonly string[], given: Given): CliResult<MergeArgs> => {
  const [text, extra] = words;
  if (text === undefined || extra !== undefined) return usageError(`${prMergeCommand} needs exactly one PR number`, USAGE_HINT);
  const number = parsePrNumber(text, 'PR number');
  if (!number.ok) return usageError(number.error.message, USAGE_HINT);
  const head = given.string(prFlags.head);
  if (head === undefined || !mergeCheck.shaPattern.test(head)) {
    return usageError(`${flagText(prFlags.head)} is required. Give a full commit id of 40 lowercase hex digits.`, USAGE_HINT);
  }
  return ok({ number: number.value, head, admin: given.bool(prFlags.admin), home: given.string(flags.home), project: given.string(flags.project) });
};

/** The caller rule prevents mistakes. It does not prove identity. */
const requireMergeCaller = async (work: WorkHost, deps: Deps): Promise<CliResult<readonly string[]>> => {
  const checkPane = isGuardOn(work.guards, guardIds.sessionChecks);
  const ownerOutputIsPiped = !inFactorySession(deps) && deps.stdinIsTTY && !deps.stdoutIsTTY;
  if (checkPane || ownerOutputIsPiped) {
    const caller = await work.caller();
    if (!caller.ok) return caller;
  }
  return ok(checkPane ? [] : [prMergeOff.caller]);
};

/** An off approval rule never acts as delegation. Admin can add a proof rule, not remove one. */
export const proofNeedOf = (guards: GuardValues, mode: ApprovalMode, admin: boolean): ProofPolicy => {
  const ownerGo = isGuardOn(guards, guardIds.ownerGo);
  const approvalMerge = isGuardOn(guards, softwareGuardIds.approvalMerge);
  const adminMerge = isGuardOn(guards, softwareGuardIds.adminMerge);
  const offLines = [
    ...(ownerGo ? [] : [prMergeOff.ownerGo]),
    ...(approvalMerge ? [] : [prMergeOff.approvalMerge]),
    ...(admin && !adminMerge ? [prMergeOff.adminMerge] : []),
  ];
  if (admin && adminMerge) return { need: 'owner-record', offLines };
  if (!ownerGo || !approvalMerge) return { need: decideProof.none, offLines };
  return { need: mode === roles.owner ? 'go' : 'owner-record', offLines };
};

const mergeProofOf = async (work: WorkHost, link: RequestLink, mode: ApprovalMode, { need, offLines }: ProofPolicy): Promise<CliResult<SettledProof | null>> => {
  if (need === decideProof.none) return ok(null);
  const proof = await work.approval({ ...link, need });
  if (proof.ok) return proof;
  const delegated = mode !== roles.owner && isGuardOn(work.guards, guardIds.ownerGo) && isGuardOn(work.guards, softwareGuardIds.approvalMerge);
  const requirement = need === 'owner-record' ? prMergeWords.needRecord : prMergeWords.needGo;
  const message = [proof.error.message, requirement, ...(delegated ? [prMergeWords.delegatedProofs] : []), prMergeWords.notProof].join(' ');
  const remedy = [proof.error.hint ?? checkRemedies.again, ...offLines].join('\n');
  return proof.error.kind === 'safety' ? safetyRefusal(message, remedy) : failure(message, remedy);
};

const proofFieldsOf = (proof: SettledProof | null) => ({
  proof: proof?.kind ?? decideProof.none, request: proof?.id ?? null, decider: proof?.decider ?? null,
});

/** The confirmation does not read a merge commit. The event does not substitute the PR head for it. */
const eventOf = (target: MergeTarget, link: RequestLink, proof: SettledProof | null, at: string): EventFileInput => ({
  name: `${prCommands.merge}-${target.number}-${target.head}${eventFile.suffix}`,
  fields: {
    schema: mergeEventSchemaId, kind: prCommands.merge, item: link.item, pr: target.number, head: target.head,
    merge_commit: null, ...proofFieldsOf(proof), at,
  },
});

const writeMergeEvent = async (deps: Deps, work: WorkHost, target: MergeTarget, link: RequestLink, proof: CliResult<SettledProof | null>): Promise<EventOutcome> => {
  if (!proof.ok) return { kind: 'no-proof', stop: proof.error.kind === 'safety' };
  const event = await work.writeEvent(eventOf(target, link, proof.value, deps.now().toISOString()));
  if (event.ok && event.value !== 'skipped') return { kind: 'done' };
  if (!event.ok && event.error.kind === 'safety') {
    return { kind: 'stop', line: `${prMergeWords.eventStop} ${displayLine(event.error.message, 1024)}`, remedy: event.error.hint };
  }
  return { kind: 'warning' };
};

const recordMerge = async (
  deps: Deps, work: WorkHost, target: MergeTarget, link: RequestLink, project: string, proof: CliResult<SettledProof | null>,
): Promise<MergeOutcome> => {
  const recorded = await work.record({ item: link.item, ref: link.ref, head: link.head, project });
  if (!recorded.ok) return { kind: 'merged-not-recorded' };
  const event = await writeMergeEvent(deps, work, target, link, proof);
  return { kind: recorded.value.recorded.changed ? 'merged' : 'already-recorded', event, proof: proof.ok ? proof.value : null };
};

const mergeOutput = (args: MergeArgs, result: string, exitCode: number, lines: readonly string[], fields: Record<string, unknown> = {}, warnings: readonly string[] = []): CommandOutput => ({
  lines: lines.map((text) => ({ level: 'text', text })),
  json: { schema: prMergeSchemaId, result, pr: args.number, head: args.head, ...fields },
  warnings,
  failed: exitCode !== 0,
  exitCode,
});

const proofLineOf = (proof: SettledProof): string =>
  proof.kind === decideProof.record ? prMergeWords.ownerRecord : prMergeWords.relayed;

/** Keep the post-write verdict first, even when the outbox stops the command. */
const outputOf = (args: MergeArgs, item: string, outcome: MergeOutcome, offLines: readonly string[]): CommandOutput => {
  const verdict = prMergeWords[outcome.kind];
  switch (outcome.kind) {
    case 'merged':
    case 'already-recorded': {
      const { event, proof } = outcome;
      const eventLines = event.kind === 'stop' ? [event.line, event.remedy] : [];
      const stopped = event.kind === 'stop' || (event.kind === 'no-proof' && event.stop);
      const proofLine = proof === null ? prMergeWords.noProof : proofLineOf(proof);
      const details = [
        ...eventLines,
        ...(event.kind === 'no-proof' ? [prMergeWords.noEventProof] : [proofLine]),
        ...offLines,
      ];
      return mergeOutput(args, outcome.kind, stopped ? exitCodeOf.safety : 0, [verdict, ...details],
        { item, ...proofFieldsOf(proof), event: event.kind, offLines, ...(event.kind === 'stop' ? { stop: event.line, remedy: event.remedy } : {}) },
        event.kind === 'warning' ? [prMergeWords.eventWarning] : []);
    }
    case 'merged-not-recorded':
      return mergeOutput(args, outcome.kind, exitCodeOf.failure, [
        verdict, `Run "${commandText(commandLines.itemRecord)} ${item} ${flagText(flags.ref)} ${args.number}".`, ...offLines,
      ], { item, offLines });
    case 'head-moved':
      return mergeOutput(args, outcome.kind, exitCodeOf['not-ready'], [verdict, checkReasons.headMoved, checkRemedies.head, ...offLines],
        { currentHead: outcome.head, offLines });
    case 'not-merged':
      return mergeOutput(args, outcome.kind, exitCodeOf.failure, [
        verdict, `If GitHub merges the PR, run "${commandText(commandLines.itemRecord)} ${item} ${flagText(flags.ref)} ${args.number}".`, ...offLines,
      ], { item, offLines });
    case 'unknown':
      return mergeOutput(args, outcome.kind, exitCodeOf.failure, [verdict, 'Check the PR state before any new merge call.', ...offLines], { offLines });
    default: return outcome satisfies never;
  }
};

const readinessOutputOf = (args: MergeArgs, read: MergeReadinessRefusal, offLines: readonly string[]): CommandOutput => {
  const { result, exitCode, reasons, remedy, head } = checkOutcomeOf(read);
  const kind = read.kind === readinessKinds.lookup ? read.kind : result;
  return mergeOutput(args, kind, read.kind === readinessKinds.lookup ? exitCodeOf.failure : exitCode,
    [checkWords[result], ...reasons, ...(remedy === null ? [] : [remedy]), ...offLines], { reasons, remedy, currentHead: head ?? null, offLines });
};

const finishMerge = async (deps: Deps, work: WorkHost, args: MergeArgs, read: MergeReadiness, callerLines: readonly string[]): Promise<CliResult<CommandOutput>> => {
  const { item, facts, repo, pr } = read;
  const target = { repo, number: pr.number, head: pr.headRefOid };
  const link = { item: item.id, ref: String(target.number), head: target.head, point: softwareApprovalPoints[0].id };
  const policy = proofNeedOf(work.guards, facts.mode, args.admin);
  const offLines = [...callerLines, ...policy.offLines];
  const proof = await mergeProofOf(work, link, facts.mode, { ...policy, offLines });
  if (read.kind === readinessKinds.ready) {
    if (!proof.ok) return proof;
    const method = mergeMethods.find((value) => value === facts.project[softwareProjectKeys.mergeMethod]);
    if (method === undefined) return failure('The project merge method is invalid.', checkRemedies.node);
    // A call that fails can still have merged the PR. Only a read at the pin decides.
    const wrote = await runMerge(deps, { ...target, method, admin: args.admin });
    if (!wrote.ok && wrote.error.kind === 'usage') return wrote;
    const confirmed = await confirmMerged(deps, target);
    if (confirmed.kind !== 'merged') return ok(outputOf(args, item.id, confirmed, offLines));
  }
  const outcome = await recordMerge(deps, work, target, link, facts.project.id, proof);
  return ok(outputOf(args, item.id, outcome, offLines));
};

export const runPrMerge = async (host: RecipeHost, deps: Deps, words: readonly string[], given: Given): Promise<CliResult<CommandOutput>> => {
  const parsed = parseMerge(words, given);
  if (!parsed.ok) return parsed;
  const args = parsed.value;
  const opened = await host.openWork(deps, args.home, COMMAND, 'record');
  if (!opened.ok) return opened;
  const work = opened.value;
  const caller = await requireMergeCaller(work, deps);
  if (!caller.ok) return caller;
  const home = await host.locateNode(deps, args.home, COMMAND);
  if (!home.ok) return home;
  const project = await host.loadProject(deps, home.value, args.project, COMMAND);
  if (!project.ok) return project;
  const read = await readinessFor(deps, work, { pr: args.number, head: args.head, project: project.value });
  const offLines = [...caller.value, ...(isGuardOn(work.guards, softwareGuardIds.prRules) ? [] : [checkPrRulesOff])];
  if (read.kind !== readinessKinds.ready && read.kind !== readinessKinds.mergedAtPin) return ok(readinessOutputOf(args, read, offLines));
  return finishMerge(deps, work, args, read, offLines);
};
