import type { DecisionRecorded, DecisionStored } from '../board/contract.js';
import { checkNote, chosenOptionOf, requestBlockLines, type DecideRequest } from '../board/decide.js';
import { failure, usageError, type CliResult } from '../cli/errors.js';
import { displayLine, printable, type CommandOutput, type OutLine } from '../cli/output.js';
import { ACCEPT_ANSWER, type Deps } from '../core/deps.js';
import { putDecision, requireDecideChannel } from '../core/owner-record.js';
import { ok } from '../core/result.js';
import {
  boardIds,
  boardLimits,
  commandLines,
  commands,
  commandText,
  decideWords,
  files,
  flags,
  flagText,
  requestWords,
  roles,
  schemaIds,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { openBoard } from './board-open.js';
import { shown, usageFor } from './board-words.js';

export interface DecideOptions {
  readonly home: string | undefined;
  /** The words after the command: the id of a request, then the key of the option. */
  readonly words: readonly string[];
  /** The reason of the owner, or undefined for none. */
  readonly note: string | undefined;
  /** True for `--json`. Decide refuses it: the answer of the owner has no JSON form. */
  readonly json: boolean;
}

interface Parsed {
  readonly id: string;
  readonly option: string;
  readonly note: string | null;
}

const needsUsage = usageFor(commands.decide);

/** The words and the flags. A fault is a usage error (exit 2) that comes before the owner check and before any read. */
const parse = (options: DecideOptions): CliResult<Parsed> => {
  if (options.json) {
    return usageError(
      `${commandText(commands.decide)} has no ${flagText(flags.json)} output`,
      `Run "${commandText(commands.decide)} ID OPTION" for the text output.`,
    );
  }
  const [id = '', option = ''] = options.words;
  if (id === decideWords.read) return needsUsage(`${commandText(`${commands.decide} ${decideWords.read}`)} is not in this version`);
  if (options.words.length !== 2) {
    return needsUsage(`${commands.decide} takes two arguments: the id of a ${requestWords.request} and the key of an option`);
  }
  if (!boardIds.canonicalRequest.test(id)) return needsUsage(`${shown(id)} is not the id of a ${requestWords.request}. An id has the form D-1`);
  if (!boardLimits.tokenPattern.test(option)) {
    return needsUsage(`${shown(option)} is not the key of an option. A key is one word of at most ${boardLimits.maxTokenChars} characters`);
  }
  const note = options.note === undefined ? ok(null) : checkNote(options.note);
  return note.ok ? ok({ id, option, note: note.value }) : note;
};

const addRequestLine = `add a new ${requestWords.request} with "${commandText(commandLines.requestAdd)}"`;

/**
 * What the owner decision file holds for the open request. `null`: no record. A time: the record of this answer is there, and no
 * board copy yet (an orphan record), so the run finishes the copies with that time. Another option or another request hash is a
 * refusal (exit 1) that names the stored option and time.
 */
const orphanTimeOf = (stored: DecisionStored, id: string, option: string): CliResult<string | null> => {
  switch (stored.kind) {
    case 'none':
      return ok(null);
    case 'record':
      return stored.option === option
        ? ok(stored.at)
        : failure(
            `${requestWords.request} ${id} has the ${roles.owner} answer ${shown(stored.option)} from ${shown(stored.at)}, not ${shown(option)}`,
            `To change an answer, ${addRequestLine}.`,
          );
    case 'mismatch':
      return failure(
        `${requestWords.request} ${id} has the ${roles.owner} answer ${shown(stored.option)} from ${shown(stored.at)} for another text of the ${requestWords.request}`,
        `Restore ${files.waiting} from the last commit. If ${files.waiting} is not changed, ${addRequestLine}.`,
      );
    default: {
      const unreachable: never = stored;
      return unreachable;
    }
  }
};

const textLine = (text: string): OutLine => ({ level: 'text', text });

const answerOf = (request: DecideRequest, recorded: DecisionRecorded): CommandOutput => {
  const title = displayLine(request.title.trim(), requestWords.maxCellChars);
  const done = recorded.outcome === 'stored' ? 'Recorded' : 'Finished the board copy of';
  return {
    lines: [textLine(`${done} the answer ${recorded.option} for ${recorded.id}: ${title}`), textLine(`Profile record: ${displayLine(recorded.path)}`)],
    json: { schema: schemaIds.decide, id: recorded.id, option: recorded.option, outcome: recorded.outcome, record: recorded.path },
    warnings: recorded.warning === null ? [] : [recorded.warning],
    failed: false,
  };
};

/**
 * `decide ID OPTION`: the owner answers an open request, in their own terminal window. The order is fixed. The words and the flags
 * (exit 2). The owner check (exit 4): no factory session, no Claude Code, a terminal for input and for output. Then the board reads
 * the request (hosted kind, guard, state of the number, strict read, owner decision file) before anything is shown. The request
 * block goes to stdout and the question to stderr, and only a yes answer goes on. The clock is read once, after the yes. The
 * connector then writes the owner record first and the board copies after it. No flag skips the question.
 */
export const runDecide = async (deps: Deps, options: DecideOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const parsed = parse(options);
  if (!parsed.ok) return parsed;
  const { id, option, note } = parsed.value;
  const channel = requireDecideChannel(deps);
  if (!channel.ok) return channel;
  const board = await openBoard(deps, options.home, registry, commands.decide);
  if (!board.ok) return board;
  const { connector } = board.value;
  const read = await connector.decisionRequest(id);
  if (!read.ok) return read;
  const { request, stored, place } = read.value;
  const chosen = chosenOptionOf(request, option);
  if (!chosen.ok) return chosen;
  const orphanAt = orphanTimeOf(stored, id, option);
  if (!orphanAt.ok) return orphanAt;
  const block = await deps.writeStdout(`${requestBlockLines(request, chosen.value.key, note).map(printable).join('\n')}\n`);
  if (!block.ok) return block;
  const answer = await deps.prompt(printable(`Record the answer ${option} for ${id}? [y/N] `));
  if (!answer.ok) return answer;
  if (!ACCEPT_ANSWER.test(answer.value.trim())) {
    return usageError(
      'nothing is recorded: the answer was not yes',
      `Run "${commandText(`${commands.decide} ${id} ${option}`)}" again to record the answer.`,
    );
  }
  const at = orphanAt.value ?? deps.now().toISOString();
  const recorded = await connector.recordDecision({ request, option, note, at }, (input) => putDecision(deps, place, input));
  return recorded.ok ? ok(answerOf(request, recorded.value)) : recorded;
};
