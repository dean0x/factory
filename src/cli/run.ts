import type { Deps } from '../core/deps.js';
import { runStatusline } from '../hooks/statusline.js';
import { commands, commandText, flags, flagShorts, flagText, helpTopics, hookNames, program, schemaIds } from '../names.js';
import { exitCodeOf, failure } from './errors.js';
import { detectStyle, printable, renderError, renderJson, renderText, renderWarnings } from './output.js';
import { recipes, type RecipeRegistry } from '../recipes/index.js';
import {
  commandTableFor,
  globalOptions,
  hookCommandFor,
  parseFlags,
  renderCommandHelp,
  renderHelp,
  type Given,
} from './table.js';
import { wordsOutput } from './words.js';

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

/** True when the command line is the route of the hook of Claude Code: a hook event or the status line. */
export const isHookRoute = (argv: readonly string[]): boolean => argv[0] === commands.hook;

/** The words after `hook` are the whole input of the route: it reads no flag. */
const wordsOnly = (words: readonly string[]): Given => ({
  string: () => undefined,
  strings: () => [],
  bool: () => false,
  positionals: () => words,
  afterTerminator: () => [],
});

/**
 * The hook of Claude Code. It never fails the session that runs it, so every path exits 0: the route comes before the
 * check of the platform and before the flags. A refusal or a failure of any kind, a throw included, becomes one line on
 * stderr. An event prints nothing to stdout. The word `statusline` prints the status line, which is the only output.
 */
const runHookRoute = async (words: readonly string[], deps: Deps, sink: Sink, registry: RecipeRegistry): Promise<number> => {
  const note = (reason: string): string => `${program} ${commands.hook}: ${printable(reason).replace(/\s+/g, ' ')}\n`;
  try {
    if (words.length === 1 && words[0] === hookNames.statusline) {
      const shown = await runStatusline(deps, registry);
      await sink.stdout(shown.text);
      if (shown.note !== null) await sink.stderr(note(shown.note));
      return EXIT_OK;
    }
    const result = await hookCommandFor(registry).run(wordsOnly(words), deps);
    if (!result.ok) await sink.stderr(note(result.error.message));
  } catch (cause) {
    await sink.stderr(note(`internal error: ${cause instanceof Error ? cause.message : 'unknown'}`));
  }
  return EXIT_OK;
};

/** Run one command line. The registry sets the recipes that the commands accept. The package registry is the default. */
export const runCli = async (
  argv: readonly string[],
  deps: Deps,
  sink: Sink,
  registry: RecipeRegistry = recipes,
): Promise<number> => {
  const table = commandTableFor(registry);
  const findCommand = (name: string) => table.find((command) => command.name === name);
  const [first, ...rest] = argv;
  if (isHookRoute(argv)) return runHookRoute(rest, deps, sink, registry);
  if (deps.platform.os === NATIVE_WINDOWS) {
    // The remedy names the command that the person typed, when the table holds it. The name comes from the table, not from the line.
    const typed = (first === undefined ? undefined : findCommand(first)?.name) ?? commands.help;
    const unsupported = failure(`${program} runs on macOS and Linux`, `Use WSL, then run "${commandText(typed)}" there.`);
    await sink.stderr(renderError(unsupported.error));
    return exitCodeOf[unsupported.error.kind];
  }

  if (first === commands.help && rest[0] === helpTopics.words) {
    const parsed = parseFlags(rest.slice(1), globalOptions);
    if (!parsed.ok) {
      await sink.stderr(
        renderError({ ...parsed.error, hint: `Run "${commandText(commands.help)} ${helpTopics.words}".` }),
      );
      return exitCodeOf[parsed.error.kind];
    }
    const output = await wordsOutput(deps, registry);
    if (parsed.value.bool(flags.json)) {
      await sink.stdout(renderJson(output.json));
    } else {
      const style = detectStyle(deps.env, sink.isTTY, parsed.value.bool(flags.noColor));
      await sink.stdout(renderText(output, style, parsed.value.bool(flags.quiet)));
    }
    return EXIT_OK;
  }

  if (first === undefined || HELP_WORDS.includes(first)) {
    const topic = first === commands.help ? findCommand(rest[0] ?? '') : undefined;
    await sink.stdout(topic === undefined ? renderHelp() : renderCommandHelp(topic));
    return EXIT_OK;
  }

  const command = findCommand(first === flagText(flags.version) ? commands.version : first);
  if (command === undefined) {
    const unknown = renderError({ kind: 'usage', message: `unknown command "${first}"` });
    await sink.stderr(`${unknown}\n${renderHelp()}`);
    return EXIT_USAGE;
  }

  const parsed = parseFlags(rest, { ...globalOptions, ...command.options }, command.positionals === true, command.terminator);
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
  return result.value.failed ? (result.value.exitCode ?? EXIT_FAILURE) : EXIT_OK;
};
