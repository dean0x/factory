import { failure, notReady, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import { removedByDisplay, type CommandOutput, type OutLine } from '../cli/output.js';
import { childTarget } from '../comms/address.js';
import { probeChildren, type ChildRow } from '../comms/children.js';
import type { DeliverResult } from '../comms/deliver.js';
import { fileTransport } from '../comms/transport.js';
import { addChildText, removeChildText } from '../config/edit.js';
import { loadConfig, parseConfigTexts, readNodeIdentity, settleLocalMode } from '../config/load.js';
import { COORDINATOR_LAYER, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { isSameOrInside, realPathOf } from '../core/paths.js';
import { err, ok, type Result } from '../core/result.js';
import { shellWord } from '../core/shell-word.js';
import {
  address as addressNames,
  commandLines,
  commands,
  commandText,
  files,
  flags,
  flagText,
  maxFileBytes,
  nodeCommands,
  nodeSendReasons,
  places,
  program,
  roles,
  schemaIds,
  sendTools,
  sessionNames,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { textHasToken } from '../safety/secrets.js';
import { layoutOf } from '../state/layout.js';
import { readAssignment } from '../workers/assignment.js';
import { workerHasId } from '../workers/registry.js';

export interface NodeOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
  /** The path of the task file of `send`. Only `send` takes it. */
  readonly file?: string | undefined;
}

/** A node with its two config files. The command edits the local file and never the shared file. */
interface OpenNode {
  readonly home: string;
  readonly sharedText: string;
  readonly localFile: string;
  readonly localText: string;
  readonly config: FactoryConfig;
  /** Notes about the files, for example a local file that others could read. */
  readonly notes: readonly string[];
}

type Change = { readonly action: 'add' | 'remove'; readonly id: string };

const SUBCOMMANDS = Object.values(nodeCommands).join(', ');

/** The last sentence of a remedy line of the add-child subcommand. It names the command to run again. */
const ADD_AGAIN = `Then run "${commandText(commands.node)} ${nodeCommands.addChild}" again.`;

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.node)} ${flagText(flags.help)}".`);

const openNode = async (
  deps: Deps,
  homeFlag: string | undefined,
  registry: RecipeRegistry,
): Promise<CliResult<OpenNode>> => {
  const located = await locateHomeFolder(
    deps,
    homeFlag,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.node,
  );
  if (!located.ok) return located;
  const home = located.value.home;
  // The loader checks the owner and the mode of the local file, and a missing local file is a usage error.
  const config = await loadConfig(deps, home, registry);
  if (!config.ok) return config;
  const notes = await settleLocalMode(deps, home, true);
  if (!notes.ok) return notes;
  const layout = layoutOf(home);
  const sharedText = await deps.fs.readTextLimited(layout.configFile, maxFileBytes);
  if (!sharedText.ok) return sharedText;
  const localText = await deps.fs.readTextLimited(layout.localConfigFile, maxFileBytes);
  if (!localText.ok) return localText;
  return ok({
    home,
    sharedText: sharedText.value,
    localFile: layout.localConfigFile,
    localText: localText.value,
    config: config.value,
    notes: notes.value,
  });
};

const rowLines = (rows: readonly ChildRow[]): OutLine[] => {
  if (rows.length === 0) return [{ level: 'text', text: 'No children.' }];
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  const addressWidth = Math.max(...rows.map((row) => row.address.length));
  return rows.map((row): OutLine => {
    const layer = row.layer === null ? '-' : `layer ${row.layer}`;
    const state = row.status === 'ok' ? 'ok' : `unknown: ${row.reason ?? 'no reason'}`;
    return {
      level: row.status === 'ok' ? 'ok' : 'warn',
      text: `${row.id.padEnd(idWidth)}  ${row.address.padEnd(addressWidth)}  ${layer}  ${state}`,
    };
  });
};

const childrenOutput = async (
  deps: Deps,
  node: { readonly home: string; readonly config: FactoryConfig; readonly notes: readonly string[] },
  registry: RecipeRegistry,
  intro: readonly OutLine[],
  change?: Change,
): Promise<CommandOutput> => {
  const rows = await probeChildren(fileTransport(deps, registry), node.config.core.children);
  return {
    lines: [...intro, ...rowLines(rows)],
    json: {
      schema: schemaIds.nodeChildren,
      home: node.home,
      layer: node.config.core.node.layer,
      ...(change === undefined ? {} : { change }),
      children: rows,
    },
    warnings: node.notes,
    failed: false,
  };
};

/**
 * Check the edited local text together with the shared text as a whole config, then write the local file.
 * A config that would not be valid is not written. The file keeps its mode.
 */
const writeEdited = async (
  deps: Deps,
  node: OpenNode,
  edited: Result<string, string>,
  registry: RecipeRegistry,
): Promise<CliResult<FactoryConfig>> => {
  if (!edited.ok) return failure(edited.error);
  const checked = parseConfigTexts(node.sharedText, edited.value, registry);
  if (!checked.ok) return err({ ...checked.error, message: `${checked.error.message}. Nothing was changed.` });
  const written = await deps.fs.writeTextAtomic(node.localFile, edited.value, node.home);
  return written.ok ? ok(checked.value) : written;
};

/** The child home is not this home, not inside it, and not above it. The paths are compared after their links are resolved. */
const requireApart = async (deps: Deps, home: string, child: string): Promise<CliResult<void>> => {
  const [realHome, realChild] = [await realPathOf(deps, home), await realPathOf(deps, child)];
  if (!realHome.ok) return realHome;
  if (!realChild.ok) return realChild;
  if (isSameOrInside(realHome.value, realChild.value)) {
    return failure(
      `the child folder ${child} is this ${places.folder}, or inside it`,
      `Name a folder outside this ${places.folder}. ${ADD_AGAIN}`,
    );
  }
  if (isSameOrInside(realChild.value, realHome.value)) {
    return failure(
      `the child folder ${child} holds this ${places.folder}`,
      `Name a folder that does not hold this ${places.folder}. ${ADD_AGAIN}`,
    );
  }
  return ok(undefined);
};

const runChildren = async (
  deps: Deps,
  options: NodeOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home, registry);
  if (!node.ok) return node;
  return ok(await childrenOutput(deps, node.value, registry, []));
};

const runAddChild = async (
  deps: Deps,
  options: NodeOptions,
  registry: RecipeRegistry,
  argument: string,
): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home, registry);
  if (!node.ok) return node;
  const { home, config } = node.value;
  const layer = config.core.node.layer;
  if (layer === COORDINATOR_LAYER) {
    return usageError(
      `this ${roles.node} is on layer ${COORDINATOR_LAYER}: its children are ${roles.worker}s`,
      `A ${roles.worker} is not a ${places.folder}. ${program} adds ${roles.worker}s with a later version. Run "${commandText(commands.node)} ${nodeCommands.children}" to see the children.`,
    );
  }

  const target = childTarget(deps.cwd, argument);
  if (!target.ok) return usageError(target.error);
  const apart = await requireApart(deps, home, target.value.path);
  if (!apart.ok) return apart;

  const answer = await fileTransport(deps, registry).ping(target.value.address);
  if (answer.kind === 'unknown') {
    return failure(`cannot add the child: ${answer.reason}`, `Start the child. ${ADD_AGAIN}`);
  }
  if (answer.layer !== layer - 1) {
    return failure(
      `the child is on layer ${answer.layer}, but a ${roles.node} on layer ${layer} takes children on layer ${layer - 1}`,
      `Add a ${roles.node} on layer ${layer - 1}, or change the layer of the child. ${ADD_AGAIN}`,
    );
  }
  if (answer.id === config.core.node.id) {
    return failure(
      `the child has the id ${answer.id}, which is the id of this ${roles.node}`,
      `Change the id in the ${files.config} of the child. ${ADD_AGAIN}`,
    );
  }
  const taken = await workerHasId(deps, home, config, answer.id);
  if (!taken.ok) return taken;
  if (taken.value) {
    return failure(
      `the child has the id ${answer.id}, which is the id of a ${roles.worker} of this ${roles.node}`,
      `Change the id in the ${files.config} of the child. ${ADD_AGAIN}`,
    );
  }
  const known = config.core.children.find((child) => child.id === answer.id);
  if (known?.address === target.value.address) {
    const intro: OutLine[] = [
      { level: 'warn', text: `${answer.id} is a child of this ${roles.node} already. Nothing changed.` },
    ];
    return ok(await childrenOutput(deps, { home, config, notes: node.value.notes }, registry, intro));
  }
  if (known !== undefined) {
    return failure(
      `${answer.id} is a child of this ${roles.node} already, with another address`,
      `Run "${commandText(commands.node)} ${nodeCommands.removeChild} ${answer.id}", then add the child again.`,
    );
  }

  const edited = addChildText(node.value.localText, { id: answer.id, address: target.value.address });
  const written = await writeEdited(deps, node.value, edited, registry);
  if (!written.ok) return written;
  const intro: OutLine[] = [{ level: 'text', text: `Added the child ${answer.id} (layer ${answer.layer}).` }];
  return ok(
    await childrenOutput(deps, { home, config: written.value, notes: node.value.notes }, registry, intro, {
      action: 'add',
      id: answer.id,
    }),
  );
};

const runRemoveChild = async (
  deps: Deps,
  options: NodeOptions,
  registry: RecipeRegistry,
  id: string,
): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home, registry);
  if (!node.ok) return node;
  if (!node.value.config.core.children.some((child) => child.id === id)) {
    return usageError(
      `${id} is not a child of this ${roles.node}`,
      `Run "${commandText(commands.node)} ${nodeCommands.children}" to see the ids.`,
    );
  }

  const written = await writeEdited(deps, node.value, removeChildText(node.value.localText, id), registry);
  if (!written.ok) return written;
  const intro: OutLine[] = [{ level: 'text', text: `Removed the child ${id}. Its files stay as they are.` }];
  return ok(
    await childrenOutput(
      deps,
      { home: node.value.home, config: written.value, notes: node.value.notes },
      registry,
      intro,
      { action: 'remove', id },
    ),
  );
};

/** The command to run again for a child, without the program name. The word in capitals is the person's. */
const sendAgain = (id: string): string => `${commandLines.nodeSend} ${id} ${flagText(flags.file)} FILE`;

/** The reason of a refusal, with the id of the child. Each reason is fixed text: no text of the child reaches the line. */
const stopped = (id: string, reason: string): string => `cannot send to ${id}: ${reason}`;

/**
 * The refusal for a delivery that did not write. The exit codes: a child that does not answer, a full inbox and a state repo that
 * does not ignore the inbox are exit 3; a mismatch and an unsafe path are exit 4; a fault of the file system is exit 1. Each
 * refusal shows a fixed reason and a remedy that names a command, and never a reason of the ping or any text of the child.
 */
const refuseDelivery = (result: Exclude<DeliverResult, { readonly kind: 'written' }>, id: string): CliResult<never> => {
  const again = `Then run "${commandText(sendAgain(id))}" again.`;
  const children = `${commandText(commands.node)} ${nodeCommands.children}`;
  switch (result.kind) {
    case 'notAnswering':
      return notReady(stopped(id, nodeSendReasons.notAnswering), `Start the child. Run "${children}" to see its state. ${again}`);
    case 'full':
      return notReady(stopped(id, nodeSendReasons.full), `Ask the child to deal with the files in its inbox folder. ${again}`);
    case 'notIgnored':
      return notReady(stopped(id, nodeSendReasons.notIgnored), `Run "${commandText(commands.upgrade)}" in the ${places.folder} of the child. ${again}`);
    case 'unsafe':
      return safetyRefusal(
        stopped(id, nodeSendReasons.unsafe),
        `Replace each link with a real folder or file. Run "chmod go-w PATH" for each path that a group or other users can write. ${again}`,
      );
    case 'mismatch':
      return result.stranded === null
        ? safetyRefusal(
            stopped(id, nodeSendReasons.mismatch),
            `Run "${children}". Fix the id or the layer in the child, or run "${commandText(commands.node)} ${nodeCommands.removeChild} ${id}" and add the child again.`,
          )
        : safetyRefusal(
            `${stopped(id, nodeSendReasons.mismatch)}; ${nodeSendReasons.removeFailed}: ${result.stranded}`,
            `Delete the file with "rm ${shellWord(result.stranded)}". Then run "${children}".`,
          );
    case 'io':
      return failure(stopped(id, nodeSendReasons.io), `Check the rights and the free space of the ${places.folder} of the child. ${again}`);
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
};

/**
 * The text of the task file as the child gets it: CRLF becomes LF. A text that the screen would show in another form (a control
 * character other than the line break and the tab, a bidi or hidden character) is exit 2, and a text that looks like a token is
 * exit 4. No refusal repeats a part of the text.
 */
const checkedTask = (text: string, id: string): CliResult<string> => {
  const body = text.replace(/\r\n/g, '\n');
  const again = `Then run "${commandText(sendAgain(id))}" again.`;
  if (removedByDisplay(body)) {
    return usageError(nodeSendReasons.controlChars, `Remove the character from the task file. ${again}`);
  }
  if (textHasToken(body)) return safetyRefusal(nodeSendReasons.token, `Remove the token from the task file. ${again}`);
  return ok(body);
};

const sentOutput = (node: OpenNode, id: string, session: string, file: string): CommandOutput => {
  const listCheck = `Check with ${sendTools.listAgents} that exactly one session has the name ${session}.`;
  const sendStep = `Then send one ${sendTools.sendMessage} to ${session} that names the file.`;
  return {
    lines: [
      { level: 'ok', text: `Wrote the task for ${id} as a new file in its inbox.` },
      { level: 'text', text: `File: ${file}` },
      { level: 'text', text: `Session: ${session}` },
      { level: 'text', text: listCheck },
      { level: 'text', text: sendStep },
    ],
    json: { schema: schemaIds.nodeSend, home: node.home, id, session, file, steps: [listCheck, sendStep] },
    warnings: node.notes,
    failed: false,
  };
};

/**
 * `node send ID --file FILE`: write the task of the file as a new message file in the inbox of a child. The id must be one of the
 * children of the config. The text goes through the checks of `checkedTask`. The delivery does the rest (see `deliverToHome`), and
 * the sender asks the child with the layer below its own. The command writes a message and sends nothing: it prints the name of the
 * session of the child, and the sender checks that name and sends the message with the tools of its own session.
 */
const runSend = async (
  deps: Deps,
  options: NodeOptions,
  registry: RecipeRegistry,
  args: readonly string[],
): Promise<CliResult<CommandOutput>> => {
  const [id] = args;
  if (args.length !== 1 || id === undefined || options.file === undefined) {
    return needsUsage(`${nodeCommands.send} takes one argument, the id of a child, and ${flagText(flags.file)} FILE`);
  }
  const node = await openNode(deps, options.home, registry);
  if (!node.ok) return node;
  const { home, config } = node.value;
  const child = config.core.children.find((entry) => entry.id === id);
  if (child === undefined) {
    return usageError(nodeSendReasons.notChild, `Run "${commandText(commands.node)} ${nodeCommands.children}" to see the ids.`);
  }
  const session = sessionNames.coordinator(id);
  if (!session.ok) return failure(session.error);

  const text = await readAssignment(deps, { home, path: options.file, again: sendAgain(id) });
  if (!text.ok) return text;
  const body = checkedTask(text.value, id);
  if (!body.ok) return body;

  const delivered = await fileTransport(deps, registry).deliver(child.address, {
    senderId: config.core.node.id,
    senderAddress: `${addressNames.scheme}${home}`,
    targetId: id,
    targetLayer: config.core.node.layer - 1,
    body: body.value,
  });
  return delivered.kind === 'written' ? ok(sentOutput(node.value, id, session.value, delivered.path)) : refuseDelivery(delivered, id);
};

export const runNode = async (
  deps: Deps,
  options: NodeOptions,
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  if (subcommand !== nodeCommands.send && options.file !== undefined) {
    return needsUsage(`${flagText(flags.file)} belongs to ${nodeCommands.send} only`);
  }
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.node)} needs a subcommand: ${SUBCOMMANDS}`);
    case nodeCommands.children:
      return args.length === 0 ? runChildren(deps, options, registry) : needsUsage(`${subcommand} takes no argument`);
    case nodeCommands.addChild:
      return args.length === 1 && args[0] !== undefined
        ? runAddChild(deps, options, registry, args[0])
        : needsUsage(`${subcommand} takes one argument: a path or a file address`);
    case nodeCommands.removeChild:
      return args.length === 1 && args[0] !== undefined
        ? runRemoveChild(deps, options, registry, args[0])
        : needsUsage(`${subcommand} takes one argument: the id of a child`);
    case nodeCommands.send:
      return runSend(deps, options, registry, args);
    default:
      return needsUsage(`unknown subcommand "${subcommand}". The subcommands are: ${SUBCOMMANDS}`);
  }
};
