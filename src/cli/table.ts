import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runDismiss } from '../commands/dismiss.js';
import { runDoctor } from '../commands/doctor.js';
import { runHook } from '../hooks/hook.js';
import { runInit } from '../commands/init.js';
import { runLayout } from '../commands/layout.js';
import { runReboot, runRestart, runShutdown } from '../commands/lifecycle.js';
import { runMachine } from '../commands/machine.js';
import { runNode } from '../commands/node.js';
import { runSelf } from '../commands/self.js';
import { runStart } from '../commands/start.js';
import { runState } from '../commands/state.js';
import { runStatus } from '../commands/status.js';
import { runUpgrade } from '../commands/upgrade.js';
import { runVersion } from '../commands/version.js';
import { runWorker } from '../commands/worker.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  assignmentSource,
  commandLines,
  commands,
  commandText,
  env,
  files,
  flags,
  flagShorts,
  flagText,
  helpTopics,
  hookNames,
  nodeCommands,
  places,
  program,
  roles,
  schemaIds,
  summonLimits,
  typing,
  values,
  workerCommands,
} from '../names.js';
import { recipeIds, recipes, type RecipeRegistry } from '../recipes/index.js';
import { FACTORY_VERSION } from '../version.js';
import { usageError, type CliResult } from './errors.js';
import type { CommandOutput } from './output.js';

export interface FlagOption {
  readonly type: 'string' | 'boolean';
  readonly multiple?: boolean;
  readonly short?: string;
  readonly placeholder?: string;
  readonly description: string;
}

/** The flags that a person gave on the command line. */
export interface Given {
  string(name: string): string | undefined;
  strings(name: string): readonly string[];
  bool(name: string): boolean;
  /** The words that are not flags, in order. Only a command with `positionals` gets any. */
  positionals(): readonly string[];
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** One line, or several lines for a command with subcommands. */
  readonly usage: string;
  readonly options: Readonly<Record<string, FlagOption>>;
  /** True when the command takes words that are not flags, for example a subcommand and its argument. */
  readonly positionals?: boolean;
  run(given: Given, deps: Deps): Promise<CliResult<CommandOutput>>;
}

export const globalOptions: Readonly<Record<string, FlagOption>> = {
  [flags.json]: { type: 'boolean', description: 'Print one JSON document.' },
  [flags.quiet]: { type: 'boolean', description: 'Print only warnings and failures.' },
  [flags.noColor]: { type: 'boolean', description: 'Do not use color.' },
  [flags.help]: { type: 'boolean', short: flagShorts.help, description: 'Show help.' },
};

const foundHomeOption: FlagOption = {
  type: 'string',
  placeholder: 'DIR',
  description:
    `The ${places.folder}. Default: ${env.home}, else the folder of the nearest config file ` +
    `above the current folder, else the ${places.folder} that the ${places.list} gives for the current folder.`,
};

/**
 * The hook that Claude Code runs. `runCli` routes it before the flags are read. An event prints none of its output, so that
 * it exits 0 with an empty stdout on every path, and the word `statusline` prints the status line (see `runStatusline`). The
 * table holds it for the help.
 */
export const hookCommandFor = (registry: RecipeRegistry): Command => ({
  name: commands.hook,
  summary: `Record when a ${places.session} was last seen. Claude Code runs it, not a person.`,
  usage: `${commandText(commands.hook)} ${[...hookNames.events, hookNames.statusline].join('|')}`,
  options: {},
  positionals: true,
  run: async (given, deps) => {
    const done = await runHook(deps, given.positionals(), registry);
    return done.ok ? ok({ lines: [], json: { schema: schemaIds.hook }, warnings: [], failed: false }) : done;
  },
});

/** The commands. The registry sets the recipes that `init` accepts, and every command that reads a config gets it. */
export const commandTableFor = (registry: RecipeRegistry): readonly Command[] => [
  {
    name: commands.init,
    summary: `Create a ${roles.node} in a folder.`,
    usage:
      `${commandText(commands.init)} [${flagText(flags.home)} DIR] [${flagText(flags.yes)}] ` +
      `[${flagText(flags.name)} ID] [${flagText(flags.ownerName)} NAME] [${flagText(flags.ownerGithub)} LOGIN] ` +
      `[${flagText(flags.project)} PATH|URL]... [${flagText(flags.layer)} N] [${flagText(flags.recipe)} ID] ` +
      `[${flagText(flags.approval)} POINT=${values.approvalModes.join('|')}]...`,
    options: {
      [flags.home]: {
        type: 'string',
        placeholder: 'DIR',
        description:
          `The ${places.folder}. Default: in a git work tree, a folder beside it; in a folder that holds git repos, ` +
          'a folder inside it; in both cases after you confirm. Else the current folder.',
      },
      [flags.yes]: {
        type: 'boolean',
        description:
          `Use the proposed ${places.folder}. Ask no question. Every approval point is ${values.approvalModes[0]}. ` +
          `Agree to the change of the Claude Code settings of the ${roles.coordinator} (the hook and the status line). ` +
          `With no terminal window and no ${flagText(flags.yes)}, the command stops before it writes a file. ` +
          `Inside a ${places.session}, the flag gives no consent for these settings.`,
      },
      [flags.name]: {
        type: 'string',
        placeholder: 'ID',
        description: `The id of the ${roles.node}. Default: the folder name.`,
      },
      [flags.ownerName]: {
        type: 'string',
        placeholder: 'NAME',
        description: `The display name of the ${roles.owner}. Default: git config user.name.`,
      },
      [flags.ownerGithub]: {
        type: 'string',
        placeholder: 'LOGIN',
        description: `The GitHub login of the ${roles.owner}. Default: the login of gh.`,
      },
      [flags.project]: {
        type: 'string',
        multiple: true,
        placeholder: 'PATH|URL',
        description:
          `A git work tree to clone into the ${places.folder}, or the URL of a repo to clone into it ` +
          '(https://, ssh:// or user@host:path). Repeat the flag for more projects.',
      },
      [flags.layer]: {
        type: 'string',
        placeholder: 'N',
        description: `The layer of the ${roles.node}, from 1 to 16. Layer 1 manages ${roles.worker}s. Default: 1.`,
      },
      [flags.recipe]: {
        type: 'string',
        placeholder: 'ID',
        description:
          `The ${roles.recipe} for the kind of work. One of: ${recipeIds(registry).join(', ')}. ` +
          `Default: ${registry[0].id}.`,
      },
      [flags.approval]: {
        type: 'string',
        multiple: true,
        placeholder: 'POINT=MODE',
        description:
          `The mode of one approval point of the ${roles.recipe}: ${values.approvalModes.join(' or ')}. ` +
          `Default: ${values.approvalModes[0]}. In a terminal window, ${commands.init} asks for each point that no flag names. ` +
          `Repeat the flag for more points. ${values.approvalModes[1]} needs a terminal window outside a ${places.session}, and no ${flagText(flags.yes)}.`,
      },
    },
    run: (given, deps) =>
      runInit(
        deps,
        {
          home: given.string(flags.home),
          name: given.string(flags.name),
          ownerName: given.string(flags.ownerName),
          ownerGithub: given.string(flags.ownerGithub),
          projects: given.strings(flags.project),
          yes: given.bool(flags.yes),
          recipe: given.string(flags.recipe),
          layer: given.string(flags.layer),
          approval: given.strings(flags.approval),
        },
        registry,
      ),
  },
  {
    name: commands.start,
    summary: `Start the session of the ${roles.node} in tmux, or attach to it.`,
    usage: `${commandText(commands.start)} [${flagText(flags.home)} DIR] [${flagText(flags.dryRun)}] [${flagText(flags.yes)}]`,
    options: {
      [flags.home]: foundHomeOption,
      [flags.dryRun]: {
        type: 'boolean',
        description: 'Show the tmux calls and the launch. Start no session and change no file.',
      },
      [flags.yes]: {
        type: 'boolean',
        description:
          `Agree to the change of the Claude Code settings of the ${roles.coordinator} (the hook and the status line), with no question. ` +
          `Not allowed inside a ${places.session}.`,
      },
    },
    run: (given, deps) =>
      runStart(deps, { home: given.string(flags.home), dryRun: given.bool(flags.dryRun), yes: given.bool(flags.yes) }, registry),
  },
  {
    name: commands.shutdown,
    summary: `Stop the ${roles.worker}s and end the tmux session of the ${roles.node}. Nothing else stops.`,
    usage: `${commandText(commands.shutdown)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runShutdown(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.restart,
    summary: `Stop one ${roles.worker} and start it again with its session id. The other ${roles.worker}s keep their panes.`,
    usage: `${commandText(commands.restart)} ID [${flagText(flags.home)} DIR]`,
    positionals: true,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runRestart(deps, { home: given.string(flags.home), words: given.positionals() }, registry),
  },
  {
    name: commands.reboot,
    summary:
      `Stop every ${roles.worker} and start each one again with its session id. ` +
      `Outside the ${places.session}, the tmux session of the ${roles.node} ends and starts again too.`,
    usage: `${commandText(commands.reboot)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runReboot(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.status,
    summary: `Show each ${roles.worker} with its state, its work item and its idle state.`,
    usage: `${commandText(commands.status)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runStatus(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.dismiss,
    summary:
      `End a ${roles.worker} and free its work copy, when its work is pushed. It changes nothing until ${flagText(flags.yes)}. ` +
      `With ${flagText(flags.idle)}, list the idle ${roles.worker}s and pick which to dismiss.`,
    usage: [
      `${commandText(commands.dismiss)} ID [${flagText(flags.home)} DIR] [${flagText(flags.yes)}]`,
      `${commandText(commands.dismiss)} ${flagText(flags.idle)} [${flagText(flags.home)} DIR]`,
    ].join(`\n${' '.repeat('Usage: '.length)}`),
    positionals: true,
    options: {
      [flags.home]: foundHomeOption,
      [flags.idle]: {
        type: 'boolean',
        description: `List the idle ${roles.worker}s, and let you pick in a terminal window. The pick step stops inside a ${places.session}.`,
      },
      [flags.yes]: {
        type: 'boolean',
        description: `Free the ${roles.worker}: end its pane, remove its work copy, and delete its record. Not allowed inside a ${places.session}.`,
      },
    },
    run: (given, deps) =>
      runDismiss(
        deps,
        { home: given.string(flags.home), words: given.positionals(), idle: given.bool(flags.idle), yes: given.bool(flags.yes) },
        registry,
      ),
  },
  {
    name: commands.node,
    summary: `Show or change the children of the ${roles.node}.`,
    usage: [
      `${commandText(commands.node)} ${nodeCommands.children} [${flagText(flags.home)} DIR]`,
      `${commandText(commands.node)} ${nodeCommands.addChild} PATH [${flagText(flags.home)} DIR]`,
      `${commandText(commands.node)} ${nodeCommands.removeChild} ID [${flagText(flags.home)} DIR]`,
    ].join(`\n${' '.repeat('Usage: '.length)}`),
    positionals: true,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runNode(deps, { home: given.string(flags.home), words: given.positionals() }, registry),
  },
  {
    name: commands.worker,
    summary: `Make, run, reset and watch the ${roles.worker}s of the ${roles.node}.`,
    usage: [
      `${commandText(commandLines.workerNew)} ID ${flagText(flags.project)} PROJECT [${flagText(flags.assignment)} FILE] [${flagText(flags.home)} DIR] [${flagText(flags.yes)}]`,
      `${commandText(commandLines.workerList)} [${flagText(flags.home)} DIR]`,
      `${commandText(commandLines.workerStop)} ID [${flagText(flags.home)} DIR]`,
      `${commandText(commandLines.workerResume)} ID [${flagText(flags.home)} DIR]`,
      `${commandText(commandLines.workerSummon)} ID [${flagText(flags.for)} TIME] [${flagText(flags.home)} DIR]`,
      `${commandText(commandLines.workerReset)} ID ${flagText(flags.clear)}|${flagText(flags.compact)} [${flagText(flags.home)} DIR]`,
      `${commandText(commandLines.workerWatch)} [ID]... [${flagText(flags.home)} DIR]`,
    ].join(`\n${' '.repeat('Usage: '.length)}`),
    positionals: true,
    options: {
      [flags.home]: foundHomeOption,
      [flags.project]: {
        type: 'string',
        placeholder: 'PROJECT',
        description: `The id of the project that the ${roles.worker} works on. The ${roles.node} lists it in its config.`,
      },
      [flags.assignment]: {
        type: 'string',
        placeholder: 'FILE',
        description:
          `With ${workerCommands.new}: copy the text of FILE into the inbox folder of the new ${roles.worker}, as its assignment. ` +
          `FILE is in ${assignmentSource.ordersShown} of the ${places.folder}, or in the git work tree of the working folder. ` +
          `It is a plain text file of at most 1 MiB, and no part of its path starts with a dot.`,
      },
      [flags.for]: {
        type: 'string',
        placeholder: 'TIME',
        description:
          `How long the slot shows the ${roles.worker} before it shows the board again: <n>m or <n>h, from ${summonLimits.minMinutes}m to ` +
          `${summonLimits.maxMinutes / 60}h. Default: ${summonLimits.defaultFor}.`,
      },
      [flags.yes]: {
        type: 'boolean',
        description:
          `Agree to the change of the Claude Code settings of the work copy (the hook and the status line), with no question. ` +
          `Not allowed inside a ${places.session}, unless the work copy has no settings file.`,
      },
      [flags.clear]: {
        type: 'boolean',
        description:
          `With ${workerCommands.reset}: clear the session of the ${roles.worker} (types ${typing.lines.clear} in its pane). ` +
          `The ${roles.worker} starts a new session.`,
      },
      [flags.compact]: {
        type: 'boolean',
        description:
          `With ${workerCommands.reset}: compact the session of the ${roles.worker} (types ${typing.lines.compact} in its pane). ` +
          `The session continues with a short summary.`,
      },
    },
    run: (given, deps) =>
      runWorker(
        deps,
        {
          home: given.string(flags.home),
          words: given.positionals(),
          project: given.string(flags.project),
          yes: given.bool(flags.yes),
          duration: given.string(flags.for),
          clear: given.bool(flags.clear),
          compact: given.bool(flags.compact),
          assignment: given.string(flags.assignment),
        },
        registry,
      ),
  },
  {
    name: commands.self,
    summary:
      `Queue ${typing.lines.compact} in the pane of the ${roles.coordinator}. Only the ${roles.coordinator} runs it, ` +
      `from inside its own pane, after it wrote its resume notes.`,
    usage: `${commandText(commandLines.selfReset)} [${flagText(flags.home)} DIR]`,
    positionals: true,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runSelf(deps, { home: given.string(flags.home), words: given.positionals() }, registry),
  },
  {
    name: commands.layout,
    summary: `Make the windows of the tmux session of the ${roles.node} again, and show the board in the slot.`,
    usage: `${commandText(commands.layout)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runLayout(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.doctor,
    summary: `Check the ${roles.node}, its config and its state.`,
    usage: `${commandText(commands.doctor)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runDoctor(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.machine,
    summary: 'Check the memory, the disk and the processors against the limits.',
    usage: `${commandText(commands.machine)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runMachine(deps, { home: given.string(flags.home) }, registry),
  },
  {
    name: commands.upgrade,
    summary: `Migrate the config and the state, and refresh the managed blocks.`,
    usage:
      `${commandText(commands.upgrade)} [${flagText(flags.home)} DIR] [${flagText(flags.dryRun)}] ` +
      `[${flagText(flags.overwrite)} NAME]... [${flagText(flags.yes)}]`,
    options: {
      [flags.home]: foundHomeOption,
      [flags.dryRun]: { type: 'boolean', description: 'Show what would change. Change no file.' },
      [flags.overwrite]: {
        type: 'string',
        multiple: true,
        placeholder: 'NAME',
        description: 'Replace the managed block NAME, also when it was edited or is missing. Repeat the flag for more blocks.',
      },
      [flags.yes]: {
        type: 'boolean',
        description:
          `Agree with no question to two changes: the registration of a ${places.folder} that the ${places.list} does not list ` +
          `(needs ${flagText(flags.home)} DIR and a ${files.config} with schema 1), and the new hook events in the Claude Code settings ` +
          `of the work copies and of the ${roles.coordinator}. Not allowed inside a ${places.session}.`,
      },
    },
    run: (given, deps) =>
      runUpgrade(
        deps,
        {
          home: given.string(flags.home),
          dryRun: given.bool(flags.dryRun),
          overwrite: given.strings(flags.overwrite),
          yes: given.bool(flags.yes),
        },
        registry,
      ),
  },
  hookCommandFor(registry),
  {
    name: commands.state,
    summary: 'Check a commit in the state folder. Git runs it, not a person.',
    usage: commandText(commandLines.stateGuard),
    positionals: true,
    options: {},
    run: (given, deps) => runState(deps, { words: given.positionals() }),
  },
  {
    name: commands.version,
    summary: 'Print the version.',
    usage: commandText(commands.version),
    options: {},
    run: async () => ok(runVersion(FACTORY_VERSION)),
  },
];

/** The commands of the package: the table for the package registry. */
export const commandTable: readonly Command[] = commandTableFor(recipes);

type ParsedValue = string | boolean | readonly (string | boolean)[] | undefined;

const toDescriptor = (option: FlagOption): NonNullable<ParseArgsConfig['options']>[string] => ({
  type: option.type,
  ...(option.multiple === true ? { multiple: true } : {}),
  ...(option.short === undefined ? {} : { short: option.short }),
});

const toGiven = (values: Readonly<Record<string, ParsedValue>>, words: readonly string[]): Given => ({
  positionals: () => words,
  string: (name) => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  },
  strings: (name) => {
    const value = values[name];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  },
  bool: (name) => values[name] === true,
});

export const parseFlags = (
  args: readonly string[],
  options: Readonly<Record<string, FlagOption>>,
  allowPositionals = false,
): CliResult<Given> => {
  const descriptors = Object.fromEntries(
    Object.entries(options).map(([name, option]) => [name, toDescriptor(option)]),
  );
  try {
    const parsed = parseArgs({ args: [...args], options: descriptors, strict: true, allowPositionals });
    return ok(toGiven(parsed.values, parsed.positionals));
  } catch (cause) {
    return usageError(cause instanceof Error ? cause.message : 'cannot read the flags');
  }
};

const flagLine = (name: string, option: FlagOption): string => {
  const placeholder = option.placeholder === undefined ? '' : ` ${option.placeholder}`;
  const short = option.short === undefined ? '' : `-${option.short}, `;
  return `  ${`${short}${flagText(name)}${placeholder}`.padEnd(26)}${option.description}`;
};

const flagBlock = (title: string, options: Readonly<Record<string, FlagOption>>): string[] => [
  title,
  ...Object.entries(options).map(([name, option]) => flagLine(name, option)),
];

export const renderHelp = (): string =>
  [
    `${program} ${FACTORY_VERSION}`,
    '',
    `Usage: ${program} <command> [flags]`,
    '',
    'Commands:',
    ...commandTable.map((command) => `  ${command.name.padEnd(10)}${command.summary}`),
    `  ${commands.help.padEnd(10)}Show this help.`,
    '',
    ...flagBlock('Flags for all commands:', globalOptions),
    '',
    `Run "${program} <command> ${flagText(flags.help)}" to see the flags of one command.`,
    `Run "${commandText(commands.help)} ${helpTopics.words}" to see what the words of ${program} mean.`,
    '',
  ].join('\n');

export const renderCommandHelp = (command: Command): string =>
  [
    `Usage: ${command.usage}`,
    '',
    command.summary,
    '',
    ...(Object.keys(command.options).length > 0 ? [...flagBlock('Flags:', command.options), ''] : []),
    ...flagBlock('Flags for all commands:', globalOptions),
    '',
  ].join('\n');
