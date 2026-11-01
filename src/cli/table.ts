import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runVersion } from '../commands/version.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, commandText, flags, flagShorts, flagText, program } from '../names.js';
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
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly options: Readonly<Record<string, FlagOption>>;
  run(given: Given, deps: Deps): Promise<CliResult<CommandOutput>>;
}

export const globalOptions: Readonly<Record<string, FlagOption>> = {
  [flags.json]: { type: 'boolean', description: 'Print one JSON document.' },
  [flags.quiet]: { type: 'boolean', description: 'Print only warnings and failures.' },
  [flags.noColor]: { type: 'boolean', description: 'Do not use color.' },
  [flags.help]: { type: 'boolean', short: flagShorts.help, description: 'Show help.' },
};

export const commandTable: readonly Command[] = [
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

const toGiven = (values: Readonly<Record<string, ParsedValue>>): Given => ({
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
): CliResult<Given> => {
  const descriptors = Object.fromEntries(
    Object.entries(options).map(([name, option]) => [name, toDescriptor(option)]),
  );
  try {
    const parsed = parseArgs({ args: [...args], options: descriptors, strict: true, allowPositionals: false });
    return ok(toGiven(parsed.values));
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
