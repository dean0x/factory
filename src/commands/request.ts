import type {
  BoardRequest,
  DecisionAskInput,
  DecisionLogInput,
  DecisionOption,
  RequestClosed,
  RequestDecider,
  RequestSettlement,
} from '../board/contract.js';
import { checkRequestId } from '../board/edit.js';
import { requestView } from '../board/list-view.js';
import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  commandLines,
  commands,
  commandText,
  flags,
  flagText,
  relayedMarker,
  requestCommands,
  requestDeciders,
  requestGroups,
  requestRowKeys,
  requestWords,
  roles,
  schemaIds,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { requireCoordinatorCaller } from '../workers/panes.js';
import { openBoard, type OpenBoard } from './board-open.js';
import { shown, usageFor } from './board-words.js';

export interface RequestOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  readonly title: string | undefined;
  readonly question: string | undefined;
  /** The `KEY=TEXT` words of the option flag, in order. */
  readonly options: readonly string[];
  /** The key of the option that the asker recommends. */
  readonly recommend: string | undefined;
  /** With close and log: who decided, when it is not the owner. It goes with `decision`. A relayed close takes none. */
  readonly decider: string | undefined;
  /** With close and log: the decision, one line. It goes with `decider`. */
  readonly decision: string | undefined;
  /** With close: the coordinator passes on an answer of the owner. It needs `decision` and takes no `decider`. */
  readonly relayed: boolean;
  /** With add: the asker puts the request in the group `later`. Without it the request is in the group `now`. */
  readonly later: boolean;
}

type Subcommand = (typeof requestCommands)[keyof typeof requestCommands];

type Action =
  | { readonly kind: typeof requestCommands.add; readonly input: DecisionAskInput }
  | { readonly kind: typeof requestCommands.list }
  | { readonly kind: typeof requestCommands.close; readonly id: string; readonly settlement: RequestSettlement | undefined }
  | { readonly kind: typeof requestCommands.log; readonly input: DecisionLogInput };

const SUBCOMMANDS = Object.values(requestCommands).join(', ');

/**
 * The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error.
 * No subcommand changes a request that is open: a request is added once and closed once.
 */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [requestCommands.add]: [flags.title, flags.question, flags.option, flags.recommend, flags.later],
  [requestCommands.list]: [],
  [requestCommands.close]: [flags.madeBy, flags.decision, flags.relayed],
  [requestCommands.log]: [flags.title, flags.madeBy, flags.decision],
};

const needsUsage = usageFor(commands.request);

const subcommandOf = (word: string): Subcommand | undefined => Object.values(requestCommands).find((candidate) => candidate === word);

const refuseStrayFlags = (subcommand: Subcommand, options: RequestOptions): CliResult<void> => {
  const given: readonly (readonly [string, boolean])[] = [
    [flags.title, options.title !== undefined],
    [flags.question, options.question !== undefined],
    [flags.option, options.options.length > 0],
    [flags.recommend, options.recommend !== undefined],
    [flags.madeBy, options.decider !== undefined],
    [flags.decision, options.decision !== undefined],
    [flags.relayed, options.relayed],
    [flags.later, options.later],
  ];
  const stray = given.find(([flag, present]) => present && !TAKES[subcommand].includes(flag));
  return stray === undefined ? ok(undefined) : needsUsage(`the flag ${flagText(stray[0])} is not for ${commandText(`${commands.request} ${subcommand}`)}`);
};

/** The `KEY=TEXT` words of the option flag as the options of a decision. The option that the recommend flag names gets the mark. */
const parseOptions = (words: readonly string[], recommend: string | undefined): CliResult<readonly DecisionOption[]> => {
  const options: DecisionOption[] = [];
  for (const word of words) {
    const at = word.indexOf(requestWords.optionSeparator);
    if (at <= 0) return needsUsage(`${flagText(flags.option)} takes KEY${requestWords.optionSeparator}TEXT, not ${shown(word)}`);
    const key = word.slice(0, at);
    options.push({ key, text: word.slice(at + requestWords.optionSeparator.length), ...(key === recommend ? { rec: true } : {}) });
  }
  if (recommend !== undefined && !options.some((option) => option.key === recommend)) {
    return needsUsage(`${flagText(flags.recommend)} names ${shown(recommend)}, and no ${flagText(flags.option)} has that key`);
  }
  return ok(options);
};

const DECIDERS: readonly RequestDecider[] = Object.values(requestDeciders);

const isDecider = (word: string): word is RequestDecider => DECIDERS.some((decider) => decider === word);

/**
 * The settlement of a close: both flags or neither. The decider is the coordinator or a delegate. The owner is no decider here: an
 * answer of the owner goes through `decide`, so the remedy names it.
 */
const parseSettlement = (options: RequestOptions): CliResult<RequestSettlement | undefined> => {
  const { decider, decision } = options;
  if (decider === undefined && decision === undefined) return ok(undefined);
  if (decider === undefined || decision === undefined) {
    return needsUsage(`${flagText(flags.madeBy)} and ${flagText(flags.decision)} go together`);
  }
  if (!isDecider(decider)) {
    return usageError(
      `${flagText(flags.madeBy)} takes ${DECIDERS.join(' or ')}, not ${shown(decider)}`,
      `For an answer of the ${roles.owner}, the ${roles.owner} runs "${commandText(commands.decide)}" in a terminal window.`,
    );
  }
  return ok({ decider, decision });
};

/**
 * The settlement of a relayed close: the coordinator passes on an answer of the owner, so the decider is the coordinator. The caller
 * rule checks that the coordinator runs the command. A flag never names the relayer, so `--made-by` is a usage error.
 */
const parseRelay = (options: RequestOptions): CliResult<RequestSettlement> => {
  if (options.decider !== undefined) {
    return needsUsage(`${flagText(flags.relayed)} takes no ${flagText(flags.madeBy)}: only the ${requestDeciders.coordinator} relays an answer`);
  }
  if (options.decision === undefined) return needsUsage(`${flagText(flags.relayed)} needs ${flagText(flags.decision)} TEXT`);
  return ok({ decider: requestDeciders.coordinator, decision: options.decision, relayed: true });
};

/** Check the words and the flags. A usage error (exit 2) from here comes before the node is found and before any lock. */
const parseAction = (options: RequestOptions): CliResult<Action> => {
  const [word, ...args] = options.words;
  if (word === undefined) return needsUsage(`${commandText(commands.request)} needs a subcommand: ${SUBCOMMANDS}`);
  const subcommand = subcommandOf(word);
  if (subcommand === undefined) return needsUsage(`unknown subcommand ${shown(word)}. The subcommands are: ${SUBCOMMANDS}`);
  const stray = refuseStrayFlags(subcommand, options);
  if (!stray.ok) return stray;
  switch (subcommand) {
    case requestCommands.add: {
      if (args.length > 0) return needsUsage(`${subcommand} takes no argument: the board gives the number`);
      if (options.title === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.title)} TEXT`);
      if (options.question === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.question)} TEXT`);
      if (options.options.length === 0) {
        return needsUsage(`${subcommand} needs at least one ${flagText(flags.option)} KEY${requestWords.optionSeparator}TEXT`);
      }
      const parsed = parseOptions(options.options, options.recommend);
      if (!parsed.ok) return parsed;
      const group = options.later ? requestGroups.later : requestGroups.now;
      return ok({ kind: subcommand, input: { title: options.title, question: options.question, options: parsed.value, group } });
    }
    case requestCommands.list: {
      return args.length > 0 ? needsUsage(`${subcommand} takes no argument`) : ok({ kind: subcommand });
    }
    case requestCommands.close: {
      const [id, ...rest] = args;
      if (id === undefined || rest.length > 0) return needsUsage(`${subcommand} takes one argument: the id of a ${requestWords.request}`);
      const settlement: CliResult<RequestSettlement | undefined> = options.relayed ? parseRelay(options) : parseSettlement(options);
      return settlement.ok ? ok({ kind: subcommand, id, settlement: settlement.value }) : settlement;
    }
    case requestCommands.log: {
      if (args.length > 0) return needsUsage(`${subcommand} takes no argument: the board gives the number`);
      if (options.title === undefined) return needsUsage(`${subcommand} needs ${flagText(flags.title)} TEXT`);
      const settlement = parseSettlement(options);
      if (!settlement.ok) return settlement;
      if (settlement.value === undefined) {
        return needsUsage(`${subcommand} needs ${flagText(flags.madeBy)} WHO and ${flagText(flags.decision)} TEXT`);
      }
      const { decider, decision } = settlement.value;
      return ok({ kind: subcommand, input: { title: options.title, decider, decision } });
    }
    default: {
      const unreachable: never = subcommand;
      return unreachable;
    }
  }
};

const textLine = (line: string): OutLine => ({ level: 'text', text: line });

const answer = (line: string, json: JsonDoc): CommandOutput => ({ lines: [textLine(line)], json, warnings: [], failed: false });

/** The id of a request, then its title when it has one. */
const withTitle = (id: string, title: string | null): string => (title === null ? displayLine(id) : `${displayLine(id)}: ${displayLine(title, requestWords.maxCellChars)}`);

const addAnswer = (id: string, input: DecisionAskInput): CommandOutput =>
  answer(`Added ${withTitle(id, input.title.trim())}`, { schema: schemaIds.request, action: requestCommands.add, id, title: input.title.trim() });

/** The words that tell who decided: the decider, and that the decider has no authority of the owner. */
const decidedBy = (decider: RequestDecider): string => `decided by the ${decider}, no ${roles.owner} authority`;

/** The end of the line of a close: the relay words, or who decided, or nothing for a close with no answer. */
const closedNote = (closed: RequestClosed, relayed: boolean): string => {
  if (relayed) return ` (${relayedMarker})`;
  return closed.decider === null ? '' : ` (${decidedBy(closed.decider)})`;
};

const closeAnswer = (closed: RequestClosed, relayed: boolean): CommandOutput =>
  answer(`Closed ${withTitle(closed.id, closed.title)}${closedNote(closed, relayed)}`, {
    schema: schemaIds.request,
    action: requestCommands.close,
    id: closed.id,
    title: closed.title,
    decider: closed.decider,
    ...(relayed ? { relayed: true } : {}),
  });

const logAnswer = (id: string, input: DecisionLogInput): CommandOutput =>
  answer(`Logged ${withTitle(id, input.title.trim())} (${decidedBy(input.decider)})`, {
    schema: schemaIds.request,
    action: requestCommands.log,
    id,
    title: input.title.trim(),
    decider: input.decider,
  });

const listAnswer = (requests: readonly BoardRequest[]): CommandOutput => ({
  lines: requestView(requests),
  json: {
    schema: schemaIds.requestList,
    requests: requests.map(({ id, title, options, openedAt, group }) => ({
      id,
      title,
      options,
      [requestRowKeys.openedAt]: openedAt,
      [requestRowKeys.group]: group,
    })),
  },
  warnings: [],
  failed: false,
});

/**
 * The caller rule of a relayed close: only the pane of the coordinator passes on an answer of the owner. It guards against a mistake
 * and it is no proof. The id is checked first, so the line that the rule prints never repeats text that is not a request id. That line
 * holds the word `TEXT` in the place of the decision, and never the decision that was typed.
 */
const requireRelayer = async (deps: Deps, board: OpenBoard, id: string): Promise<CliResult<void>> => {
  const valid = checkRequestId(id);
  if (!valid.ok) return valid;
  const again = `${commandLines.requestClose} ${id} ${flagText(flags.relayed)} ${flagText(flags.decision)} TEXT`;
  const caller = await requireCoordinatorCaller(deps, board.home, board.config, again);
  return caller.ok ? ok(undefined) : caller;
};

const execute = async (deps: Deps, board: OpenBoard, action: Action): Promise<CliResult<CommandOutput>> => {
  const { connector } = board;
  switch (action.kind) {
    case requestCommands.add: {
      const id = await connector.askDecision(action.input);
      return id.ok ? ok(addAnswer(id.value, action.input)) : id;
    }
    case requestCommands.list: {
      const requests = await connector.listRequests();
      return requests.ok ? ok(listAnswer(requests.value)) : requests;
    }
    case requestCommands.close: {
      const relayed = action.settlement?.relayed === true;
      if (relayed) {
        const relayer = await requireRelayer(deps, board, action.id);
        if (!relayer.ok) return relayer;
      }
      const closed = await connector.closeRequest(action.id, action.settlement);
      return closed.ok ? ok(closeAnswer(closed.value, relayed)) : closed;
    }
    case requestCommands.log: {
      const id = await connector.logDecision(action.input);
      return id.ok ? ok(logAnswer(id.value, action.input)) : id;
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};

/**
 * `request`: add a request for the owner, list the open requests, close one with no answer or with a decision, or log a decision that
 * no request asked for. The words and the flags are checked first (exit 2), then the node is found and the connector runs the action.
 * A relayed close passes on an answer of the owner. It runs only in the pane of the coordinator, and the rule runs after the id
 * check and before the connector reads the decision files. An add, a close or a log is one state commit through the connector, and the connector refuses
 * it for a hosted tracker kind. The number of a new request or of a logged decision is one more than the highest number in the
 * waiting file, in the decision log and in the owner store, found under the lock. A request that is open can not be changed.
 */
export const runRequest = async (deps: Deps, options: RequestOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.request);
  if (!board.ok) return board;
  return execute(deps, board.value, action.value);
};
