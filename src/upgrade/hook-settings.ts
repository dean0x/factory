import { failure, safetyRefusal, type CliError, type CliResult } from '../cli/errors.js';
import type { OutLine } from '../cli/output.js';
import { ensureHookSettings, holdsOwnHook } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { commands, commandText, flags, flagText, hookSessions, type HookSession } from '../names.js';
import { layoutOf } from '../state/layout.js';
import { listWorkerRecords, workCopyOf } from '../workers/registry.js';

/**
 * The step of `upgrade` that brings the hook settings up to date (design 4.6): the settings file of the coordinator folder and of
 * each recorded work copy gets the events that the file lacks. A folder whose settings file holds no own hook command is left as
 * it is, because its owner said no to the hook. The step plans first, with no write, so that a stop of a check comes before the
 * first write of `upgrade`. It applies after the state is written, with the consent rule of `ensureHookSettings`: a terminal yes,
 * or the yes flag outside a factory session.
 */

/** A session folder whose settings file holds an own hook command. */
interface HookTarget {
  readonly folder: string;
  readonly session: HookSession;
}

/** A settings file that lacks entries: the folder, the file and the change as a person reads it. */
export interface HookChange extends HookTarget {
  readonly file: string;
  readonly change: string;
}

/** What the step did: the settings files that it wrote, and the lines to show. */
export interface HookApplied {
  readonly changed: readonly string[];
  readonly lines: readonly OutLine[];
}

const text = (line: string): OutLine => ({ level: 'text', text: line });

const warning = (line: string): OutLine => ({ level: 'warn', text: line });

const runAgain = `Run "${commandText(commands.upgrade)}" again`;

/** The folders to check: the coordinator, then the work copy of each valid record, in the order of the ids. */
const targetsOf = async (deps: Deps, home: string): Promise<CliResult<readonly HookTarget[]>> => {
  const listed = await listWorkerRecords(deps, home);
  if (!listed.ok) return listed;
  const copies = listed.value.workers.map(
    (record): HookTarget => ({ folder: workCopyOf(home, record.project, record.id), session: hookSessions.workCopy }),
  );
  return ok([{ folder: layoutOf(home).coordinatorDir, session: hookSessions.coordinator }, ...copies]);
};

/**
 * The settings files that lack entries. The call asks nothing and writes nothing. A check of a target that stops (a link, a file
 * that is no object) stops the plan with that error. The value is empty when all files are current.
 */
export const planHookSettings = async (deps: Deps, home: string, yes: boolean): Promise<CliResult<readonly HookChange[]>> => {
  const targets = await targetsOf(deps, home);
  if (!targets.ok) return targets;
  const changes: HookChange[] = [];
  for (const target of targets.value) {
    const request = { ...target, yes, command: commands.upgrade };
    const holds = await holdsOwnHook(deps, request);
    if (!holds.ok) return holds;
    if (!holds.value) continue;
    const outcome = await ensureHookSettings(deps, { ...request, dryRun: true });
    if (!outcome.ok) return outcome;
    if (outcome.value.kind === 'would-write') changes.push({ ...target, file: outcome.value.file, change: outcome.value.change });
  }
  return ok(changes);
};

/** The lines of a dry run: the change of each file, and what a real run does. Nothing for a plan with no change. */
export const hookPlanLines = (changes: readonly HookChange[], yes: boolean): readonly OutLine[] =>
  changes.length === 0
    ? []
    : [
        ...changes.flatMap((change) => change.change.split('\n').map(text)),
        text(yes ? 'A real run writes these changes.' : 'A real run asks before it writes these changes.'),
      ];

/** The stop of a write: the error of the write, and the files that this step changed before it. A stop for safety stays one. */
const stoppedBy = (error: CliError, changed: readonly string[]): CliResult<never> => {
  const done = `Hook settings changed before the stop: ${changed.length === 0 ? 'none' : changed.join(', ')}.`;
  const message = `${error.message}. ${done}`;
  const remedy = error.hint ?? `${runAgain}: it changes the hook settings that are left.`;
  return error.kind === 'safety' ? safetyRefusal(message, remedy) : failure(message, remedy);
};

/**
 * Write the planned changes, one file after the other. A no on a terminal leaves that file and warns. A missing consent (no
 * terminal and no yes, or the yes flag inside a factory session) leaves this file and every file after it, and warns once with the
 * remedy. Any other error stops the step (exit 1, or exit 4 for a safety stop) and names the files changed so far.
 */
export const applyHookSettings = async (deps: Deps, changes: readonly HookChange[], yes: boolean): Promise<CliResult<HookApplied>> => {
  const changed: string[] = [];
  const lines: OutLine[] = [];
  for (const [index, change] of changes.entries()) {
    const outcome = await ensureHookSettings(deps, { folder: change.folder, session: change.session, yes, dryRun: false, command: commands.upgrade });
    if (!outcome.ok) {
      if (outcome.error.kind !== 'usage') return stoppedBy(outcome.error, changed);
      const left = changes.slice(index).map((entry) => entry.file);
      const remedy = outcome.error.hint ?? `${runAgain} in a terminal window, or add ${flagText(flags.yes)}.`;
      lines.push(warning(`Hook settings not changed, because there is no consent: ${left.join(', ')}. ${remedy}`));
      break;
    }
    if (outcome.value.kind === 'written') {
      changed.push(outcome.value.file);
      lines.push({ level: 'ok', text: `Changed the hook settings in ${outcome.value.file}.` });
    }
    if (outcome.value.kind === 'declined') {
      lines.push(warning(`Hook settings not changed, because you answered no: ${outcome.value.file}. ${runAgain} and answer yes.`));
    }
  }
  return ok({ changed, lines });
};
