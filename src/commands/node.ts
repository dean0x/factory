import { failure, safetyRefusal, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput, OutLine } from '../cli/output.js';
import { childTarget } from '../comms/address.js';
import { probeChildren, type ChildRow } from '../comms/children.js';
import { fileTransport } from '../comms/transport.js';
import { addChildText, removeChildText } from '../config/edit.js';
import { parseConfigText } from '../config/load.js';
import { COORDINATOR_LAYER, type FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { isSameOrInside } from '../core/paths.js';
import { err, ok, type Result } from '../core/result.js';
import { commands, commandText, flags, flagText, nodeCommands, program, roles, schemaIds } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { realPathOf } from './init-home.js';

export interface NodeOptions {
  readonly home: string | undefined;
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
}

interface OpenNode {
  readonly home: string;
  readonly configFile: string;
  readonly configText: string;
  readonly config: FactoryConfig;
}

type Change = { readonly action: 'add' | 'remove'; readonly id: string };

const SUBCOMMANDS = Object.values(nodeCommands).join(', ');

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.node)} ${flagText(flags.help)}".`);

const openNode = async (deps: Deps, homeFlag: string | undefined): Promise<CliResult<OpenNode>> => {
  const located = await locateHomeFolder(deps, homeFlag);
  if (!located.ok) return located;
  const home = located.value.home;
  const configFile = layoutOf(home).configFile;
  const configText = await deps.fs.readText(configFile);
  if (!configText.ok) return configText;
  const config = parseConfigText(configText.value);
  return config.ok ? ok({ home, configFile, configText: configText.value, config: config.value }) : config;
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
  node: { readonly home: string; readonly config: FactoryConfig },
  intro: readonly OutLine[],
  change?: Change,
): Promise<CommandOutput> => {
  const rows = await probeChildren(fileTransport(deps), node.config.core.children);
  return {
    lines: [...intro, ...rowLines(rows)],
    json: {
      schema: schemaIds.nodeChildren,
      home: node.home,
      layer: node.config.core.node.layer,
      ...(change === undefined ? {} : { change }),
      children: rows,
    },
    warnings: [],
    failed: false,
  };
};

/** Check the edited text as a whole config, then write it. A config that would not be valid is not written. */
const writeEdited = async (
  deps: Deps,
  node: OpenNode,
  edited: Result<string, string>,
): Promise<CliResult<FactoryConfig>> => {
  if (!edited.ok) return failure(edited.error);
  const checked = parseConfigText(edited.value);
  if (!checked.ok) return err({ ...checked.error, message: `${checked.error.message}. Nothing was changed.` });
  const written = await deps.fs.writeTextAtomic(node.configFile, edited.value);
  return written.ok ? ok(checked.value) : written;
};

/** The child home is not this home, not inside it, and not above it. The paths are compared after their links are resolved. */
const requireApart = async (deps: Deps, home: string, child: string): Promise<CliResult<void>> => {
  const [realHome, realChild] = [await realPathOf(deps, home), await realPathOf(deps, child)];
  if (!realHome.ok) return realHome;
  if (!realChild.ok) return realChild;
  if (isSameOrInside(realHome.value, realChild.value)) {
    return safetyRefusal(`the child home ${child} is this ${roles.node} home, or inside it`);
  }
  if (isSameOrInside(realChild.value, realHome.value)) {
    return safetyRefusal(`the child home ${child} holds this ${roles.node} home`);
  }
  return ok(undefined);
};

const runChildren = async (deps: Deps, options: NodeOptions): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home);
  if (!node.ok) return node;
  return ok(await childrenOutput(deps, node.value, []));
};

const runAddChild = async (deps: Deps, options: NodeOptions, argument: string): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home);
  if (!node.ok) return node;
  const { home, config } = node.value;
  const layer = config.core.node.layer;
  if (layer === COORDINATOR_LAYER) {
    return safetyRefusal(
      `this ${roles.node} is on layer ${COORDINATOR_LAYER}: its children are ${roles.cell}s`,
      `A ${roles.cell} is not a ${roles.node} home. ${program} adds ${roles.cell}s with a later version.`,
    );
  }

  const target = childTarget(deps.cwd, argument);
  if (!target.ok) return usageError(target.error);
  const apart = await requireApart(deps, home, target.value.path);
  if (!apart.ok) return apart;

  const answer = await fileTransport(deps).ping(target.value.address);
  if (answer.kind === 'unknown') return safetyRefusal(`cannot add the child: ${answer.reason}`);
  if (answer.layer !== layer - 1) {
    return safetyRefusal(
      `the child is on layer ${answer.layer}, but a ${roles.node} on layer ${layer} takes children on layer ${layer - 1}`,
    );
  }
  if (config.core.children.some((child) => child.id === answer.id)) {
    return safetyRefusal(`${answer.id} is a child of this ${roles.node} already`);
  }

  const edited = addChildText(node.value.configText, { id: answer.id, address: target.value.address });
  const written = await writeEdited(deps, node.value, edited);
  if (!written.ok) return written;
  const intro: OutLine[] = [{ level: 'text', text: `Added the child ${answer.id} (layer ${answer.layer}).` }];
  return ok(await childrenOutput(deps, { home, config: written.value }, intro, { action: 'add', id: answer.id }));
};

const runRemoveChild = async (deps: Deps, options: NodeOptions, id: string): Promise<CliResult<CommandOutput>> => {
  const node = await openNode(deps, options.home);
  if (!node.ok) return node;
  if (!node.value.config.core.children.some((child) => child.id === id)) {
    return usageError(
      `${id} is not a child of this ${roles.node}`,
      `Run "${commandText(commands.node)} ${nodeCommands.children}" to see the ids.`,
    );
  }

  const written = await writeEdited(deps, node.value, removeChildText(node.value.configText, id));
  if (!written.ok) return written;
  const intro: OutLine[] = [{ level: 'text', text: `Removed the child ${id}. Its files stay as they are.` }];
  return ok(await childrenOutput(deps, { home: node.value.home, config: written.value }, intro, { action: 'remove', id }));
};

export const runNode = async (deps: Deps, options: NodeOptions): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.node)} needs a subcommand: ${SUBCOMMANDS}`);
    case nodeCommands.children:
      return args.length === 0 ? runChildren(deps, options) : needsUsage(`${subcommand} takes no argument`);
    case nodeCommands.addChild:
      return args.length === 1 && args[0] !== undefined
        ? runAddChild(deps, options, args[0])
        : needsUsage(`${subcommand} takes one argument: a path or a file address`);
    case nodeCommands.removeChild:
      return args.length === 1 && args[0] !== undefined
        ? runRemoveChild(deps, options, args[0])
        : needsUsage(`${subcommand} takes one argument: the id of a child`);
    default:
      return needsUsage(`unknown subcommand "${subcommand}". The subcommands are: ${SUBCOMMANDS}`);
  }
};
