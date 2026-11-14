import { basename, dirname } from 'node:path';
import { notReady, safetyRefusal, type CliResult } from '../cli/errors.js';
import type { FactoryConfig } from '../config/schema.js';
import { hookSettingsPlaceOf, missingHookEvents } from '../core/claude-settings.js';
import type { Deps } from '../core/deps.js';
import { ok } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { commandLines, commands, commandText, flags, flagText, maxFileBytes, paneElapsed, roleText, type HookEvent } from '../names.js';
import { parseJsonText } from '../state/load.js';
import { readCheckedFile, type NamedPath } from './registry.js';
import { requireRoleText } from './role-text.js';

/**
 * The checks that `worker reset` and `self reset` share before they type a line into a session pane. Each check stands alone and
 * returns a `CliResult`: a session that is not ready is exit 3, and a link where a plain file must be is exit 4. A command that
 * names `again` gets it back in the remedy line, as the command to run again after the fix (without the program name).
 */

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** The milliseconds in an elapsed time as `ps` prints it, or null for text of any other form or a part out of range. */
const elapsedMsOf = (text: string): number | null => {
  const match = paneElapsed.etime.exec(text);
  if (match === null) return null;
  const [, daysText = '0', hoursText = '0', minutesText = '', secondsText = ''] = match;
  const [days, hours, minutes, seconds] = [daysText, hoursText, minutesText, secondsText].map(Number);
  if (days === undefined || hours === undefined || minutes === undefined || seconds === undefined) return null;
  if (hours >= HOURS_PER_DAY || minutes >= MINUTES_PER_HOUR || seconds >= SECONDS_PER_MINUTE) return null;
  return (((days * HOURS_PER_DAY + hours) * MINUTES_PER_HOUR + minutes) * SECONDS_PER_MINUTE + seconds) * MS_PER_SECOND;
};

/**
 * When the process of a pane started, in milliseconds since the epoch: the time of now minus the time that `ps` says the process
 * runs. The clock is read after `ps` returns, so a slow `ps` makes the start later, and a line check against the start gets
 * stricter. The pid stays the same through the start chain of a launch, so the pane pid is the process of the session. The call runs
 * with the default environment, so the locale is C. A pid that is not a positive integer, a `ps` that fails or runs past the limit,
 * empty output (the process is gone) and any text that is not the one form of the answer are exit 3. The text of the output is never
 * repeated.
 */
export const paneProcessStart = async (deps: Deps, pid: number, again: string): Promise<CliResult<number>> => {
  const unreadable = () =>
    notReady('cannot read when the process of the pane started', `Look at the pane in tmux. Then run "${commandText(again)}" again.`);
  if (!Number.isSafeInteger(pid) || pid <= 0) return unreadable();
  const ran = await deps.run(toolNames.ps, ['-o', 'etime=', '-p', String(pid)], { timeoutMs: paneElapsed.timeoutMs });
  const now = deps.now().getTime();
  if (!ran.ok || ran.value.exitCode !== 0) return unreadable();
  const elapsed = elapsedMsOf(ran.value.stdout);
  return elapsed === null ? unreadable() : ok(now - elapsed);
};

/**
 * The line check: the time of the last-seen line must be strictly later than the start of the process. A pid that tmux used again
 * gives a later start, so a line of the earlier process is refused. A time that is no time is refused too (exit 3).
 */
export const requireLineAfterStart = (eventAt: string, start: number, again: string): CliResult<void> => {
  const at = Date.parse(eventAt);
  if (Number.isFinite(at) && at > start) return ok(undefined);
  return notReady(
    'the last-seen line is not later than the start of the session',
    `Wait until the session reports, or look at the pane in tmux. Then run "${commandText(again)}" again.`,
  );
};

export interface ResumeFileRequest {
  /** The folders above the file, from the top down. Each one is checked: a link is exit 4. */
  readonly folders: readonly NamedPath[];
  readonly file: NamedPath;
  readonly again: string;
}

export interface ResumeFile {
  /** How long ago the file changed, in milliseconds. 0 for a time in the future. */
  readonly ageMs: number;
}

/**
 * The resume notes file must be a plain file with text. It is read through `readCheckedFile`, so no link is followed and no more
 * than `maxFileBytes` are read. A file that is missing, empty (also only white space), above the limit or of the wrong kind is
 * exit 3, and the refusal names the file. A link, in the file or in a folder above it, is exit 4. The text is not repeated.
 */
export const requireResumeFile = async (deps: Deps, request: ResumeFileRequest): Promise<CliResult<ResumeFile>> => {
  const { folders, file, again } = request;
  const write = `Write the notes for the next turn of the session to ${file.path}. Then run "${commandText(again)}" again.`;
  const read = await readCheckedFile(deps, folders, file, maxFileBytes);
  if (!read.ok) return read;
  const found = read.value;
  if (found.state === 'absent') return notReady(`${file.what} is missing: ${file.path}`, write);
  if (found.state === 'invalid') {
    return found.cause === 'link'
      ? safetyRefusal(
          `cannot use ${file.path}: ${found.reason}`,
          `Replace the link with a plain file that holds the notes. Then run "${commandText(again)}" again.`,
        )
      : notReady(`cannot use ${file.path}: ${found.reason}`, write);
  }
  if (found.text.trim() === '') return notReady(`${file.what} is empty: ${file.path}`, write);
  const info = await deps.fs.statInfo(file.path);
  if (!info.ok) return info;
  if (info.value === null) return notReady(`${file.what} is missing: ${file.path}`, write);
  return ok({ ageMs: Math.max(0, deps.now().getTime() - info.value.mtimeMs) });
};

export interface SettingsRequest {
  /** The session folder: the work copy of a worker, or the coordinator folder. */
  readonly folder: string;
  /** The command that starts the session again, without the program name: for example `restart alpha` or `reboot`. */
  readonly then: string;
  /** The remedy line for a missing hook event. Absent: run `upgrade`, then the command in `then`. */
  readonly remedy?: string;
}

export interface SettingsAgeRequest extends SettingsRequest {
  /** When the process of the session started, in milliseconds since the epoch (`paneProcessStart`). */
  readonly start: number;
}

/** The checked parts of the hook settings file of a session folder: the `.claude` folder, then the file. */
const settingsPartsOf = (folder: string): { readonly folders: readonly NamedPath[]; readonly file: NamedPath } => {
  const place = hookSettingsPlaceOf(folder);
  return {
    folders: [{ path: place.claudeFolder, what: 'the settings folder' }],
    file: { path: place.file, what: 'the hook settings file' },
  };
};

/**
 * What the hook settings file of a session folder holds, for a check: the hook events that lack the own command, or the link that
 * stops the read. A file that is missing, not JSON, not an object, above the limit or of the wrong kind counts every event as missing.
 */
export type HookSettingsRead =
  | { readonly state: 'plain'; readonly file: string; readonly missing: readonly HookEvent[] }
  | { readonly state: 'link'; readonly file: string; readonly reason: string };

/**
 * Read the hook settings file of the session folder and name the events that lack the own command, with the own matcher where an
 * event needs one (`missingHookEvents`). A link in the path is never followed. The read changes nothing.
 */
export const readHookSettings = async (deps: Deps, folder: string): Promise<CliResult<HookSettingsRead>> => {
  const { folders, file } = settingsPartsOf(folder);
  const read = await readCheckedFile(deps, folders, file, maxFileBytes);
  if (!read.ok) return read;
  const found = read.value;
  if (found.state === 'invalid' && found.cause === 'link') return ok({ state: 'link', file: file.path, reason: found.reason });
  const json = found.state === 'text' ? parseJsonText(found.text) : null;
  return ok({ state: 'plain', file: file.path, missing: missingHookEvents(json !== null && json.ok ? json.value : undefined) });
};

/**
 * The hook settings file of the session folder must hold the own command of every hook event of the fixed list (`readHookSettings`).
 * A file that lacks an event is exit 3, and the remedy is `upgrade`, then the command in `then`. A link is exit 4.
 */
export const requireOwnHooks = async (deps: Deps, request: SettingsRequest): Promise<CliResult<void>> => {
  const settings = await readHookSettings(deps, request.folder);
  if (!settings.ok) return settings;
  const found = settings.value;
  if (found.state === 'link') {
    return safetyRefusal(
      `cannot use ${found.file}: ${found.reason}`,
      `Replace the link with a plain file. Run "${commandText(commands.upgrade)}", then "${commandText(request.then)}".`,
    );
  }
  if (found.missing.length === 0) return ok(undefined);
  return notReady(
    `the hook settings ${found.file} lack the events: ${found.missing.join(', ')}`,
    request.remedy ?? `Run "${commandText(commands.upgrade)}", then "${commandText(request.then)}".`,
  );
};

export interface RoleDeliveryRequest {
  /** The node home, the root of the config repo: an absolute path. */
  readonly home: string;
  readonly config: FactoryConfig;
  readonly workerId: string;
  /** The work copy of the worker: `work-copies/<project>/<id>` of the node home, which the caller has checked. */
  readonly workCopy: string;
  /** The command that starts the worker again after a fix, without the program name: for example `worker resume alpha` or `reboot`. */
  readonly again: string;
}

/**
 * The commands that give a worker a new work copy with the hook settings: dismiss the worker, then make it again for its project. Only
 * `worker new` asks the question about the hook settings. Each command is without the program name, as `commandText` takes it.
 */
export const startOverCommands = (workerId: string, project: string): { readonly dismiss: string; readonly create: string } => ({
  dismiss: `${commandText(commands.dismiss)} ${workerId}`,
  create: `${commandText(commandLines.workerNew)} ${workerId} ${flagText(flags.project)} ${project}`,
});

/**
 * A worker that starts must get its role text at its session start. Two things must hold before any pane starts and before any
 * worker stops, and the first fault is the answer: the hook settings of the work copy hold the own command of every hook event
 * (`requireOwnHooks`: exit 3 for a missing entry, exit 4 for a link), and the role text passes every check (`requireRoleText`).
 * The remedy of a missing entry names each command on its own line, for the fix and for a work copy that never had the hook.
 * Nothing is written, and no session is asked: the launch does not wait for the first session start, so this check is the point
 * where a launch fails closed.
 */
export const requireRoleDelivery = async (deps: Deps, request: RoleDeliveryRequest): Promise<CliResult<void>> => {
  const { home, config, workerId, workCopy, again } = request;
  const remedy = roleText.hookRemedy({ again: commandText(again), ...startOverCommands(workerId, basename(dirname(workCopy))) });
  const hooks = await requireOwnHooks(deps, { folder: workCopy, then: again, remedy });
  if (!hooks.ok) return hooks;
  return requireRoleText(deps, { home, config, retry: commandText(again) });
};

/**
 * The hook settings file must be older than the process of the session: a session reads its settings once, at its start, so a file
 * that changed since then is not what the session runs with. The check accepts a window of about one second where it passes a
 * file that changed just after the start, because `ps` gives whole seconds. It protects the upgrade of the settings, and it is no
 * security boundary: the line check and the capture of the pane stay as gates. A file that is missing is exit 3.
 */
export const requireSettingsOlderThan = async (deps: Deps, request: SettingsAgeRequest): Promise<CliResult<void>> => {
  const { file } = settingsPartsOf(request.folder);
  const info = await deps.fs.statInfo(file.path);
  if (!info.ok) return info;
  const restart = `Run "${commandText(request.then)}" so that the session reads the settings.`;
  if (info.value === null) return notReady(`cannot read ${file.path}: it is missing`, restart);
  if (info.value.mtimeMs < request.start) return ok(undefined);
  return notReady(
    `the hook settings ${file.path} changed after the session started`,
    `${restart} A permission rule that Claude Code saved in that file also changes it.`,
  );
};
