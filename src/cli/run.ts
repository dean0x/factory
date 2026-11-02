import type { Deps } from '../core/deps.js';
import { commands, commandText, flags, flagShorts, flagText, program, schemaIds } from '../names.js';
import { exitCodeOf, safetyRefusal, type CliError } from './errors.js';
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

const HELP_WORDS: readonly string[] = [commands.help, flagText(flags.help), `-${flagShorts.help}`];
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
/** The value of `process.platform` on native Windows, where the tmux and shell steps cannot work. */
const NATIVE_WINDOWS = 'win32';

const renderError = (error: CliError): string =>
  `error: ${error.message}\n${error.hint === undefined ? '' : `${error.hint}\n`}`;

const findCommand = (name: string) => commandTable.find((command) => command.name === name);

export const runCli = async (argv: readonly string[], deps: Deps, sink: Sink): Promise<number> => {
  if (deps.platform.os === NATIVE_WINDOWS) {
    const refusal = safetyRefusal(`${program} runs on macOS and Linux`, `Use WSL; ${program} runs there as on Linux.`);
    await sink.stderr(renderError(refusal.error));
    return exitCodeOf[refusal.error.kind];
  }

  const [first, ...rest] = argv;

  if (first === undefined || HELP_WORDS.includes(first)) {
    const topic = first === commands.help ? findCommand(rest[0] ?? '') : undefined;
    await sink.stdout(topic === undefined ? renderHelp() : renderCommandHelp(topic));
    return EXIT_OK;
  }

  const command = findCommand(first === flagText(flags.version) ? commands.version : first);
  if (command === undefined) {
    await sink.stderr(`error: unknown command "${first}"\n\n${renderHelp()}`);
    return EXIT_USAGE;
  }

  const parsed = parseFlags(rest, { ...globalOptions, ...command.options }, command.positionals === true);
  if (!parsed.ok) {
    await sink.stderr(
      renderError({ ...parsed.error, hint: `Run "${commandText(command.name)} ${flagText(flags.help)}".` }),
    );
    return exitCodeOf[parsed.error.kind];
  }
  const given = parsed.value;

  if (given.bool(flags.help)) {
    await sink.stdout(renderCommandHelp(command));
    return EXIT_OK;
  }

  const json = given.bool(flags.json);
  const result = await command.run(given, deps);

  if (!result.ok) {
    if (json) {
      await sink.stdout(renderJson({ schema: schemaIds.error, error: result.error }));
    }
    await sink.stderr(renderError(result.error));
    return exitCodeOf[result.error.kind];
  }

  if (json) {
    await sink.stdout(renderJson(result.value.json));
  } else {
    const style = detectStyle(deps.env, sink.isTTY, given.bool(flags.noColor));
    await sink.stdout(renderText(result.value, style, given.bool(flags.quiet)));
    await sink.stderr(renderWarnings(result.value.warnings));
  }
  return result.value.failed ? EXIT_FAILURE : EXIT_OK;
};
