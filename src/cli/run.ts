import type { Deps } from '../core/deps.js';
import { exitCodeOf, type CliError } from './errors.js';
import { detectStyle, renderJson, renderText, renderWarnings } from './output.js';
import {
  commandTable,
  globalOptions,
  parseFlags,
  renderCommandHelp,
  renderHelp,
} from './table.js';

export interface Sink {
  stdout(text: string): Promise<void>;
  stderr(text: string): Promise<void>;
  readonly isTTY: boolean;
}

const HELP_WORDS: readonly string[] = ['help', '--help', '-h'];
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const renderError = (error: CliError): string =>
  `error: ${error.message}\n${error.hint === undefined ? '' : `${error.hint}\n`}`;

const findCommand = (name: string) => commandTable.find((command) => command.name === name);

export const runCli = async (argv: readonly string[], deps: Deps, sink: Sink): Promise<number> => {
  const [first, ...rest] = argv;

  if (first === undefined || HELP_WORDS.includes(first)) {
    const topic = first === 'help' ? findCommand(rest[0] ?? '') : undefined;
    await sink.stdout(topic === undefined ? renderHelp() : renderCommandHelp(topic));
    return EXIT_OK;
  }

  const command = findCommand(first === '--version' ? 'version' : first);
  if (command === undefined) {
    await sink.stderr(`error: unknown command "${first}"\n\n${renderHelp()}`);
    return EXIT_USAGE;
  }

  const parsed = parseFlags(rest, { ...globalOptions, ...command.options });
  if (!parsed.ok) {
    await sink.stderr(renderError({ ...parsed.error, hint: `Run "factory ${command.name} --help".` }));
    return exitCodeOf[parsed.error.kind];
  }
  const flags = parsed.value;

  if (flags.bool('help')) {
    await sink.stdout(renderCommandHelp(command));
    return EXIT_OK;
  }

  const json = flags.bool('json');
  const result = await command.run(flags, deps);

  if (!result.ok) {
    if (json) {
      await sink.stdout(renderJson({ schema: 'factory.error/v1', error: result.error }));
    }
    await sink.stderr(renderError(result.error));
    return exitCodeOf[result.error.kind];
  }

  if (json) {
    await sink.stdout(renderJson(result.value.json));
  } else {
    const style = detectStyle(deps.env, sink.isTTY, flags.bool('no-color'));
    await sink.stdout(renderText(result.value, style, flags.bool('quiet')));
    await sink.stderr(renderWarnings(result.value.warnings));
  }
  return result.value.failed ? EXIT_FAILURE : EXIT_OK;
};
