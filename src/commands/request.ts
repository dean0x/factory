import type {
  BoardRequest,
  DecisionAskInput,
  DecisionLogInput,
  DecisionOption,
  RequestClosed,
  RequestDecider,
  RequestField,
  RequestLink,
  RequestSettlement,
} from '../board/contract.js';
import { checkItemId, checkRequestId } from '../board/edit.js';
import { requestView } from '../board/list-view.js';
import { usageError, type CliResult } from '../cli/errors.js';
import { displayLine, type CommandOutput, type JsonDoc, type OutLine } from '../cli/output.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  approvalOptions,
  commandLines,
  commands,
  commandText,
  files,
  flags,
  flagText,
  prefixPlaceholders,
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
import { openBoard, recordApprovalMode, type OpenBoard } from './board-open.js';
import { shown, usageFor } from './board-words.js';

export interface RequestOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its argument. */
  readonly words: readonly string[];
  readonly title: string | undefined;
  readonly question: string | undefined;
  readonly kind: string | undefined;
  /** The `LABEL=TEXT` words of the field flag, in order. */
  readonly fields: readonly string[];
  /** The `KEY=TEXT` reasons of the why flag. Each key names an option. */
  readonly whys: readonly string[];
  readonly docs: readonly string[];
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
  /** With add: all three flags bind the request to the record point of the recipe. */
  readonly item?: string | undefined;
  readonly ref?: string | undefined;
  readonly head?: string | undefined;
}

type LinkFlags = Omit<RequestLink, 'point'>;

type Subcommand = (typeof requestCommands)[keyof typeof requestCommands];

type Action =
  | { readonly kind: typeof requestCommands.add; readonly input: DecisionAskInput; readonly link: LinkFlags | undefined }
  | { readonly kind: typeof requestCommands.list }
  | { readonly kind: typeof requestCommands.close; readonly id: string; readonly settlement: RequestSettlement | undefined }
  | { readonly kind: typeof requestCommands.log; readonly input: DecisionLogInput }
  | { readonly kind: typeof requestCommands.doc; readonly id: string; readonly path: string };

const SUBCOMMANDS = Object.values(requestCommands).join(', ');

/**
 * The flags that each subcommand takes, besides the flags that every command takes. A flag of another subcommand is a usage error.
 * Only doc adds context to an open request; it does not replace the request text.
 */
const TAKES: Readonly<Record<Subcommand, readonly string[]>> = {
  [requestCommands.add]: [
    flags.title, flags.question, flags.option, flags.recommend, flags.later, flags.kind, flags.field, flags.why, flags.doc,
    flags.item, flags.ref, flags.head,
  ],
  [requestCommands.list]: [],
  [requestCommands.close]: [flags.madeBy, flags.decision, flags.relayed],
  [requestCommands.log]: [flags.title, flags.madeBy, flags.decision],
  [requestCommands.doc]: [],
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
    [flags.kind, options.kind !== undefined],
    [flags.field, options.fields.length > 0],
    [flags.why, options.whys.length > 0],
    [flags.doc, options.docs.length > 0],
    [flags.item, options.item !== undefined],
    [flags.ref, options.ref !== undefined],
    [flags.head, options.head !== undefined],
  ];
  const stray = given.find(([flag, present]) => present && !TAKES[subcommand].includes(flag));
  return stray === undefined ? ok(undefined) : needsUsage(`the flag ${flagText(stray[0])} is not for ${commandText(`${commands.request} ${subcommand}`)}`);
};

/** Split at the first equals sign, so the field text keeps any later equals signs. */
const parseLabelled = (words: readonly string[]): CliResult<readonly RequestField[]> => {
  const fields: RequestField[] = [];
  for (const word of words) {
    const at = word.indexOf(requestWords.optionSeparator);
    if (at <= 0) return needsUsage(`${flagText(flags.field)} takes LABEL${requestWords.optionSeparator}TEXT, not ${shown(word)}`);
    fields.push({ label: word.slice(0, at), text: word.slice(at + requestWords.optionSeparator.length) });
  }
  return ok(fields);
};

/** Option and why flags split at the first equals sign. A reason names one option, and recommend marks one option. */
const parseOptions = (words: readonly string[], recommend: string | undefined, whys: readonly string[]): CliResult<readonly DecisionOption[]> => {
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
  const reasons = new Map<string, string>();
  for (const word of whys) {
    const at = word.indexOf(requestWords.optionSeparator);
    if (at <= 0) return needsUsage(`${flagText(flags.why)} takes KEY${requestWords.optionSeparator}TEXT, not ${shown(word)}`);
    const key = word.slice(0, at);
    if (!options.some((option) => option.key === key)) {
      return needsUsage(`${flagText(flags.why)} names ${shown(key)}, and no ${flagText(flags.option)} has that key`);
    }
    if (reasons.has(key)) return needsUsage(`${flagText(flags.why)} names ${shown(key)} twice`);
    reasons.set(key, word.slice(at + requestWords.optionSeparator.length));
  }
  return ok(options.map((option) => {
    const why = reasons.get(option.key);
    return why === undefined ? option : { ...option, why };
  }));
};

const parseLinkFlags = (options: RequestOptions, choices: readonly DecisionOption[]): CliResult<LinkFlags | undefined> => {
  const { item, ref, head } = options;
  if (item === undefined && ref === undefined && head === undefined) return ok(undefined);
  if (item === undefined || ref === undefined || head === undefined) {
    return needsUsage(`${flagText(flags.item)}, ${flagText(flags.ref)} and ${flagText(flags.head)} go together`);
  }
  const valid = checkItemId(item);
  if (!valid.ok) return valid;
  const { go, stop } = approvalOptions;
  if (choices.length !== 2 || !choices.some(({ key }) => key === go) || !choices.some(({ key }) => key === stop)) {
    return needsUsage(`a linked ${requestWords.request} needs exactly the option keys ${go} and ${stop}`);
  }
  return ok({ item: valid.value, ref, head });
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
      const parsed = parseOptions(options.options, options.recommend, options.whys);
      if (!parsed.ok) return parsed;
      const link = parseLinkFlags(options, parsed.value);
      if (!link.ok) return link;
      const fields = parseLabelled(options.fields);
      if (!fields.ok) return fields;
      const group = options.later ? requestGroups.later : requestGroups.now;
      return ok({ kind: subcommand, link: link.value, input: {
        title: options.title, question: options.question, options: parsed.value, group,
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        fields: fields.value, docs: options.docs,
      } });
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
    case requestCommands.doc: {
      const [id, path, ...rest] = args;
      if (id === undefined || path === undefined || rest.length > 0) return needsUsage(`${subcommand} takes two arguments: ID PATH`);
      return ok({ kind: subcommand, id, path });
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

export const requestRowsOf = (requests: readonly BoardRequest[]) => requests.map(({ id, title, options, openedAt, group, kind, question }) => ({
  id,
  title,
  options,
  [requestRowKeys.openedAt]: openedAt,
  [requestRowKeys.group]: group,
  [requestRowKeys.kind]: kind,
  [requestRowKeys.question]: question,
}));

const listAnswer = (requests: readonly BoardRequest[]): CommandOutput => ({
  lines: requestView(requests),
  json: {
    schema: schemaIds.requestList,
    requests: requestRowsOf(requests),
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

/** Only the node and date slots vary. The literal parts must occur in order, with the exact letter case. */
const hasOwnerPrefix = (decision: string, prefix: string, display: string): boolean => {
  const parts = prefix.split(prefixPlaceholders.node).flatMap((part) => part.split(prefixPlaceholders.date));
  let offset = 0;
  for (const part of parts) {
    const text = part.replaceAll(prefixPlaceholders.owner, () => display);
    const found = decision.indexOf(text, offset);
    if (found === -1) return false;
    offset = found + text.length;
  }
  return true;
};

const relayScopeOf = async (deps: Deps, board: OpenBoard): Promise<readonly string[]> => {
  const point = board.config.entry.recordCheck?.point;
  if (point === undefined) return [];
  return (await recordApprovalMode(deps, board, point)) === roles.owner ? [point] : [];
};

/** Use the recipe rules and the current open items before the connector takes the write lock. */
const resolveLink = async (board: OpenBoard, link: LinkFlags): Promise<CliResult<RequestLink>> => {
  const check = board.config.entry.recordCheck;
  if (check === undefined) return needsUsage(`the ${roles.recipe} has no record check for a linked ${requestWords.request}`);
  const ref = check.parseRef(link.ref);
  if (!ref.ok) return ref;
  const head = check.parseHead(link.head);
  if (!head.ok) return head;
  const items = await board.connector.listItems({ all: false });
  if (!items.ok) return items;
  if (!items.value.some((item) => item.id === link.item)) return needsUsage(`${files.board} has no open item ${shown(link.item)}`);
  return ok({ point: check.point, item: link.item, ref: ref.value, head: head.value });
};

const execute = async (deps: Deps, board: OpenBoard, action: Action): Promise<CliResult<CommandOutput>> => {
  const { connector } = board;
  switch (action.kind) {
    case requestCommands.add: {
      const link = action.link === undefined ? ok(undefined) : await resolveLink(board, action.link);
      if (!link.ok) return link;
      const input = link.value === undefined ? action.input : { ...action.input, link: link.value };
      const id = await connector.askDecision(input);
      return id.ok ? ok(addAnswer(id.value, input)) : id;
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
        const { prefix, display } = board.config.core.owner;
        if (hasOwnerPrefix(action.settlement.decision, prefix, display)) {
          return needsUsage(`the relayed decision must not include the ${roles.owner} prefix`);
        }
      }
      const relayScope = relayed ? await relayScopeOf(deps, board) : [];
      const closed = await connector.closeRequest(action.id, action.settlement, relayScope);
      return closed.ok ? ok(closeAnswer(closed.value, relayed)) : closed;
    }
    case requestCommands.log: {
      const id = await connector.logDecision(action.input);
      return id.ok ? ok(logAnswer(id.value, action.input)) : id;
    }
    case requestCommands.doc: {
      const valid = checkRequestId(action.id);
      if (!valid.ok) return valid;
      const caller = await requireCoordinatorCaller(deps, board.home, board.config, `${commandLines.requestDoc} ${action.id} PATH`);
      if (!caller.ok) return caller;
      const linked = await connector.linkRequestDoc({ id: action.id, path: action.path });
      if (!linked.ok) return linked;
      return ok(answer(`${linked.value ? 'Linked' : 'Already linked'} ${displayLine(action.path)} to ${displayLine(action.id)}.`, {
        schema: schemaIds.request, action: requestCommands.doc, id: action.id, path: action.path, changed: linked.value,
      }));
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
};

/**
 * `request`: add a request for the owner, list the open requests, close one with no answer or with a decision, or log a decision that
 * no request asked for. The doc action adds a file path to an open request. The words and flags are checked first (exit 2).
 * Then the node is found and the connector runs the action. A relayed close passes on an answer of the owner.
 * Both a relayed close and a doc link run only in the pane of the coordinator, after the id check and before the connector.
 * Each write is one state commit through the connector; a repeated doc link makes none. The connector refuses hosted tracker writes.
 * The number of a new request or of a logged decision is one more than the highest number in the waiting file,
 * in the decision log and in the owner store, found under the lock. Only doc adds context to an open request.
 */
export const runRequest = async (deps: Deps, options: RequestOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const action = parseAction(options);
  if (!action.ok) return action;
  const board = await openBoard(deps, options.home, registry, commands.request);
  if (!board.ok) return board;
  return execute(deps, board.value, action.value);
};
