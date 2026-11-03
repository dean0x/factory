import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runDoctor } from '../commands/doctor.js';
import { runInit } from '../commands/init.js';
import { runNode } from '../commands/node.js';
import { runStart } from '../commands/start.js';
import { runUpgrade } from '../commands/upgrade.js';
import { runVersion } from '../commands/version.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import {
  commands,
  commandText,
  env,
  files,
  flags,
  flagShorts,
  flagText,
  helpTopics,
  nodeCommands,
  places,
  program,
  roles,
  values,
} from '../names.js';
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
    `The ${roles.node} folder. Default: ${env.home}, else the folder of the nearest config file ` +
    'above the current folder, else the home that lists the current folder in the home index.',
};

export const commandTable: readonly Command[] = [
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
          `The ${roles.node} folder. Default: in a git work tree, a folder beside it; in a folder that holds git repos, ` +
          'a folder inside it; in both cases after you confirm. Else the current folder.',
      },
      [flags.yes]: {
        type: 'boolean',
        description: `Use the proposed ${roles.node} folder. Ask no question. Every approval point is ${values.approvalModes[0]}.`,
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
          'A git work tree to clone into the home folder, or the URL of a repo to clone into it ' +
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
        description: `The ${roles.recipe} for the kind of work. One of: ${values.recipes.join(', ')}. Default: ${values.recipes[0]}.`,
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
      runInit(deps, {
        home: given.string(flags.home),
        name: given.string(flags.name),
        ownerName: given.string(flags.ownerName),
        ownerGithub: given.string(flags.ownerGithub),
        projects: given.strings(flags.project),
        yes: given.bool(flags.yes),
        recipe: given.string(flags.recipe),
        layer: given.string(flags.layer),
        approval: given.strings(flags.approval),
      }),
  },
  {
    name: commands.start,
    summary: `Start the session of the ${roles.node} in tmux, or attach to it.`,
    usage: `${commandText(commands.start)} [${flagText(flags.home)} DIR] [${flagText(flags.dryRun)}]`,
    options: {
      [flags.home]: foundHomeOption,
      [flags.dryRun]: {
        type: 'boolean',
        description: 'Show the tmux calls and the launch. Start no session and change no file.',
      },
    },
    run: (given, deps) => runStart(deps, { home: given.string(flags.home), dryRun: given.bool(flags.dryRun) }),
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
    run: (given, deps) => runNode(deps, { home: given.string(flags.home), words: given.positionals() }),
  },
  {
    name: commands.doctor,
    summary: `Check the ${roles.node}, its config and its state.`,
    usage: `${commandText(commands.doctor)} [${flagText(flags.home)} DIR]`,
    options: { [flags.home]: foundHomeOption },
    run: (given, deps) => runDoctor(deps, { home: given.string(flags.home) }),
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
          `Register a ${places.folder} that the ${places.list} does not list, with no question. ` +
          `Needs ${flagText(flags.home)} DIR and a ${files.config} with schema 1. Not allowed inside a ${places.session}.`,
      },
    },
    run: (given, deps) =>
      runUpgrade(deps, {
        home: given.string(flags.home),
        dryRun: given.bool(flags.dryRun),
        overwrite: given.strings(flags.overwrite),
        yes: given.bool(flags.yes),
      }),
  },
  {
    name: commands.version,
    summary: 'Print the version.',
    usage: commandText(commands.version),
    options: {},
    run: async () => ok(runVersion(FACTORY_VERSION)),
  },
];

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
