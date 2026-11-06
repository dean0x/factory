import { join } from 'node:path';
import { notReady, usageError, type CliResult } from '../cli/errors.js';
import type { CommandOutput } from '../cli/output.js';
import { typeLine } from '../comms/typing.js';
import { loadConfig, readNodeIdentity } from '../config/load.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Deps } from '../core/deps.js';
import { locateHomeFolder } from '../core/home.js';
import { ok } from '../core/result.js';
import type { CoordinatorPane } from '../launch/tmux.js';
import {
  commandLines,
  commands,
  commandText,
  coordinatorResumeFile,
  dirs,
  flags,
  flagText,
  roles,
  schemaIds,
  selfCommands,
  selfResetWords,
  typing,
} from '../names.js';
import type { RecipeRegistry } from '../recipes/index.js';
import { layoutOf } from '../state/layout.js';
import { promptStateOf, readOwnCoordinatorSession } from '../workers/last-seen.js';
import { requireCoordinatorCaller } from '../workers/panes.js';
import { requireOwnHooks, requireResumeFile } from '../workers/session-checks.js';

/**
 * `self reset` (design 4.12): the coordinator queues the line `/compact` in its own pane, after it has written its resume notes. The
 * session runs the line after its current turn, so the command has no idle gate: a session that works or waits at its prompt passes.
 * The command types one fixed line into a pane, so it checks everything first, in a fixed order, and a refusal types nothing:
 *  1. the words of the command line: none (exit 2), in `parseSelfReset`;
 *  2. the caller rule (`requireCoordinatorCaller`): the env of the caller (exit 2), the tmux session (exit 3, exit 4), the
 *     coordinator pane and the caller pane (exit 3, exit 4, exit 2);
 *  3. the hook settings of the coordinator hold every hook event (exit 3, exit 4 for a link);
 *  4. the last-seen line of the coordinator is its own and holds an event, and no dialog waits (exit 3);
 *  5. the resume notes of the node: the folder and the file are plain, and the file has text (exit 3, exit 4);
 *  6. the pane is read again by the caller rule, and it has the same process (exit 3, exit 4, exit 2);
 *  7. `typeLine`: the mode of the pane is read (exit 1 for a failed read, exit 3 for a pane in a mode of tmux), then the capture of the
 *     screen, which is the last read before the keys (exit 3 for a numbered list of choices).
 * A mode or a dialog that opens after its read and before the keys is not seen. The command does not wait for the compact: the output says
 * that the line is queued.
 */

/** The command of a reset with its program name, for the words of a usage error. */
const BASE_LINE = commandText(commandLines.selfReset);

/** The first check: the command takes no argument. Anything else is exit 2, and nothing else runs. */
export const parseSelfReset = (words: readonly string[]): CliResult<void> =>
  words.length === 0 ? ok(undefined) : usageError(`${BASE_LINE} takes no argument`, `Run "${BASE_LINE}".`);

export interface SelfResetRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
}

/** What a reset that typed its line gives back. */
export interface SelfResetOutcome {
  /** The pane of the coordinator that got the line. */
  readonly paneId: string;
}

/** The clause that ends a remedy line: `Then run "<command>" again.` */
const THEN_AGAIN = `Then run "${BASE_LINE}" again.`;

/** The hook settings of the coordinator hold every hook event. The remedy is `upgrade`, then `reboot`, so the session reads them. */
const requireCoordinatorHooks = (deps: Deps, home: string): Promise<CliResult<void>> =>
  requireOwnHooks(deps, { folder: layoutOf(home).coordinatorDir, then: commands.reboot });

/**
 * The last-seen line of the coordinator: it is valid, it belongs to this node, and it holds an event. The state `busy` and the state
 * `prompt` pass. The state `waits` is a dialog that the keys could answer, so it is exit 3. A line that is absent, not valid, not owned
 * or without an event says nothing about a dialog, so it is exit 3 too.
 */
const requireLineWithoutDialog = async (deps: Deps, home: string, nodeId: string, paneId: string): Promise<CliResult<void>> => {
  const read = await readOwnCoordinatorSession(deps, home, nodeId);
  if (!read.ok) return read;
  const wait = `Wait until the session reports, or look at the pane ${paneId} in tmux. ${THEN_AGAIN}`;
  const found = read.value;
  switch (found.state) {
    case 'absent':
      return notReady(`the ${roles.coordinator} has no last-seen line`, wait);
    case 'invalid':
    case 'not-owned':
      return notReady(`cannot use the last-seen line of the ${roles.coordinator}: ${found.reason}`, wait);
    case 'valid': {
      const state = promptStateOf(found.line);
      switch (state) {
        case null:
          return notReady(`the last-seen line of the ${roles.coordinator} holds no event`, wait);
        case 'waits':
          return notReady(
            `a dialog waits in the pane ${paneId} of the ${roles.coordinator}`,
            `Answer the dialog in the pane ${paneId}. ${THEN_AGAIN}`,
          );
        case 'busy':
        case 'prompt':
          return ok(undefined);
        default: {
          const unreachable: never = state;
          return unreachable;
        }
      }
    }
    default: {
      const unreachable: never = found;
      return unreachable;
    }
  }
};

/** The notes of the coordinator for its next turn: the file of the node in the resume folder. The folder and the file are plain, and the file has text. */
const requireResumeNotes = async (deps: Deps, home: string, nodeId: string): Promise<CliResult<void>> => {
  const folder = join(layoutOf(home).stateDir, dirs.resume);
  const notes = await requireResumeFile(deps, {
    folders: [{ path: folder, what: `the resume folder of the ${roles.coordinator}` }],
    file: { path: join(folder, coordinatorResumeFile(nodeId)), what: `the resume notes of the ${roles.coordinator}` },
    again: commandLines.selfReset,
  });
  return notes.ok ? ok(undefined) : notes;
};

/** The pane read again right before the keys, by the caller rule: it must still be the coordinator pane, and the same process. */
const requireSamePane = async (
  deps: Deps,
  request: SelfResetRequest,
  pane: CoordinatorPane,
): Promise<CliResult<CoordinatorPane>> => {
  const now = await requireCoordinatorCaller(deps, request.home, request.config, commandLines.selfReset);
  if (!now.ok) return now;
  if (now.value.pid === pane.pid) return now;
  return notReady(
    `the process of the pane ${now.value.paneId} changed while the checks ran`,
    `Look at the pane ${now.value.paneId} in tmux. ${THEN_AGAIN}`,
  );
};

/**
 * Queues `/compact` in the pane of the coordinator. Every check comes before the keys, and a refusal types nothing (see the order at
 * the top of the file). The line goes in with `typeLine`, whose capture of the screen is the last read before the keys.
 */
export const selfReset = async (deps: Deps, request: SelfResetRequest): Promise<CliResult<SelfResetOutcome>> => {
  const { home, config } = request;
  const nodeId = config.core.node.id;
  const caller = await requireCoordinatorCaller(deps, home, config, commandLines.selfReset);
  if (!caller.ok) return caller;
  const hooks = await requireCoordinatorHooks(deps, home);
  if (!hooks.ok) return hooks;
  const line = await requireLineWithoutDialog(deps, home, nodeId, caller.value.paneId);
  if (!line.ok) return line;
  const notes = await requireResumeNotes(deps, home, nodeId);
  if (!notes.ok) return notes;
  const pane = await requireSamePane(deps, request, caller.value);
  if (!pane.ok) return pane;
  const typed = await typeLine(deps, pane.value.paneId, typing.lines.compact, THEN_AGAIN);
  if (!typed.ok) return typed;
  return ok({ paneId: pane.value.paneId });
};

/** The output of a reset that typed its line: the line is queued, and the compact runs after the current turn. */
export const selfResetOutput = (outcome: SelfResetOutcome): CommandOutput => ({
  lines: [{ level: 'ok', text: `${selfResetWords.queued} ${selfResetWords.after}` }],
  json: { schema: schemaIds.selfReset, pane: outcome.paneId, queued: true },
  warnings: [],
  failed: false,
});

export interface SelfOptions {
  /** The words after the command: the subcommand, then its arguments. */
  readonly words: readonly string[];
  readonly home: string | undefined;
}

const SUBCOMMANDS = Object.values(selfCommands).join(', ');

const needsUsage = (what: string): CliResult<never> =>
  usageError(what, `Run "${commandText(commands.self)} ${flagText(flags.help)}".`);

/** `self reset`: the words of the command line, then the factory folder and its config, then the reset. */
const runSelfReset = async (
  deps: Deps,
  options: SelfOptions,
  args: readonly string[],
  registry: RecipeRegistry,
): Promise<CliResult<CommandOutput>> => {
  const parsed = parseSelfReset(args);
  if (!parsed.ok) return parsed;
  const located = await locateHomeFolder(
    deps,
    options.home,
    (readDeps, folder) => readNodeIdentity(readDeps, folder, registry),
    commands.self,
  );
  if (!located.ok) return located;
  const { home } = located.value;
  const loaded = await loadConfig(deps, home, registry);
  if (!loaded.ok) return loaded;
  const reset = await selfReset(deps, { home, config: loaded.value });
  return reset.ok ? ok(selfResetOutput(reset.value)) : reset;
};

/** `self <subcommand>`: the commands that the coordinator runs on its own session. */
export const runSelf = async (deps: Deps, options: SelfOptions, registry: RecipeRegistry): Promise<CliResult<CommandOutput>> => {
  const [subcommand, ...args] = options.words;
  switch (subcommand) {
    case undefined:
      return needsUsage(`${commandText(commands.self)} needs a subcommand: ${SUBCOMMANDS}`);
    case selfCommands.reset:
      return runSelfReset(deps, options, args, registry);
    default:
      return needsUsage(`unknown subcommand ${JSON.stringify(subcommand)}. The subcommands are: ${SUBCOMMANDS}`);
  }
};
