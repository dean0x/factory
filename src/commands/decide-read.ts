import type { DecisionRead } from '../board/contract.js';
import type { CliResult } from '../cli/errors.js';
import { displayLine, visibleText, type CommandOutput, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { boardIds, commands, commandText, decideProof, decideProofReasons, decideReadLabels as labels, decideWords, flags, flagText, requestWords, schemaIds } from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { openBoard } from './board-open.js';
import { shown, usageFor } from './board-words.js';

interface DecideReadOptions {
  readonly home: string | undefined;
  readonly words: readonly string[];
  readonly note: string | undefined;
}

const readCommand = commandText(`${commands.decide} ${decideWords.read}`);
const needsUsage = usageFor(commands.decide);
const escaped = (text: string | null): string | null => text === null ? null : visibleText(text);

const outputOf = (id: string, read: DecisionRead): CommandOutput => {
  const { proof, node, root } = read;
  const reason = decideProofReasons[proof.kind];
  const failed = proof.kind !== decideProof.record;
  const { optionText, requestKind } = failed ? { optionText: null, requestKind: null } : proof;
  const lines: OutLine[] = [{ level: failed ? 'fail' : 'ok', text: `${displayLine(proof.kind)}: ${displayLine(reason)}` }];
  const fields = [
    [labels.id, id], [labels.node, node], [labels.folder, root], [labels.option, proof.option],
    [labels.optionText, optionText], [labels.requestKind, requestKind], [labels.at, proof.at],
    [labels.point, proof.link?.point], [labels.item, proof.link?.item], [labels.ref, proof.link?.ref], [labels.head, proof.link?.head],
    [labels.decider, proof.decider], [labels.title, proof.title], [labels.question, proof.question],
    [proof.kind === decideProof.relayed ? labels.relayedText : labels.decision, proof.decision],
  ] as const;
  for (const [label, value] of fields) {
    if (value !== null && value !== undefined) lines.push({ level: 'text', text: `${label}: ${displayLine(value)}` });
  }
  return {
    lines,
    json: {
      schema: schemaIds.decideRead,
      proof: proof.kind,
      id,
      node,
      root,
      option: proof.option,
      option_text: escaped(optionText),
      request_kind: requestKind,
      at: proof.at,
      point: proof.link?.point ?? null,
      board_item: proof.link?.item ?? null,
      ref: proof.link?.ref ?? null,
      head: proof.link?.head ?? null,
      decider: proof.decider,
      reason,
      title: escaped(proof.title),
      question: escaped(proof.question),
      decision: escaped(proof.decision),
    },
    warnings: [],
    failed,
  };
};

export const runDecideRead = async (deps: Deps, options: DecideReadOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  if (options.note !== undefined) return needsUsage(`${readCommand} does not take ${flagText(flags.note)}`);
  const [id] = options.words;
  if (id === undefined) return needsUsage(`${readCommand} with no id is not in this version`);
  if (options.words.length !== 1) return needsUsage(`${readCommand} takes one argument: the id of a ${requestWords.request}`);
  if (!boardIds.canonicalRequest.test(id)) return needsUsage(`${shown(id)} is not the id of a ${requestWords.request}. An id has the form D-1`);
  const board = await openBoard(deps, options.home, registry, commands.decide);
  if (!board.ok) return board;
  const result = await board.value.connector.decisionRead(id);
  return result.ok ? ok(outputOf(id, result.value)) : result;
};
