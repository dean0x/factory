import { delimiter, join } from 'node:path';
import { flags, flagText } from '../names.js';
import type { Deps } from './deps.js';

/** The programs that factory starts. `ps` reads how long the process of a pane runs. */
export const toolNames = { git: 'git', tmux: 'tmux', gh: 'gh', claude: 'claude', ps: 'ps' } as const;

const MAX_PATH_ENTRIES = 256;
const VERSION_TIMEOUT_MS = 5000;

/** The oldest tmux that runs a program from an argument list with no shell (`new-session -- command args`). */
export const MIN_TMUX = { major: 3, minor: 0 } as const;

/** The oldest agent that takes text from another session in its inbox. */
export const MIN_AGENT_VERSION = { major: 2, minor: 1, patch: 224 } as const;

/** The most characters of the output of `<agent> --version` that are read. A longer output is not a version. */
const MAX_VERSION_OUTPUT_CHARS = 200;

/** A version, with an optional note in parentheses after it: `2.1.224` or `2.1.224 (Claude Code)`. The whole text must match. */
const AGENT_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:[ \t]+\([^()\r\n]{1,64}\))?$/;

/** True when an executable file with this name is in a folder of PATH. */
export const onPath = async (deps: Deps, name: string): Promise<boolean> => {
  const folders = (deps.env['PATH'] ?? '').split(delimiter).filter((folder) => folder !== '');
  for (const folder of folders.slice(0, MAX_PATH_ENTRIES)) {
    const kind = await deps.fs.stat(join(folder, name));
    if (kind.ok && kind.value === 'file') return true;
  }
  return false;
};

export interface Version {
  readonly major: number;
  readonly minor: number;
}

/** The version in the text of `tmux -V`, for example `tmux 3.4`, `tmux 3.5a` or `tmux next-3.6`. Null when there is none. */
export const parseTmuxVersion = (text: string): Version | null => {
  const match = /^tmux\s+(?:next-)?(\d+)\.(\d+)/.exec(text.trim());
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]) };
};

export const isTmuxNewEnough = (version: Version): boolean =>
  version.major > MIN_TMUX.major || (version.major === MIN_TMUX.major && version.minor >= MIN_TMUX.minor);

export interface AgentVersion extends Version {
  readonly patch: number;
}

/**
 * The version in the output of `<agent> --version`, for example `2.1.224` or `2.1.224 (Claude Code)`. Null when the output
 * is longer than `MAX_VERSION_OUTPUT_CHARS` or holds anything else than the version and its note.
 */
export const parseAgentVersion = (text: string): AgentVersion | null => {
  if (text.length > MAX_VERSION_OUTPUT_CHARS) return null;
  const match = AGENT_VERSION.exec(text.trim());
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

export const isAgentNewEnough = (version: AgentVersion): boolean => {
  if (version.major !== MIN_AGENT_VERSION.major) return version.major > MIN_AGENT_VERSION.major;
  if (version.minor !== MIN_AGENT_VERSION.minor) return version.minor > MIN_AGENT_VERSION.minor;
  return version.patch >= MIN_AGENT_VERSION.patch;
};

/** The version of the agent program, or null when it does not run, ends with a failure or prints no version. */
export const agentVersionOf = async (deps: Deps, agent: string): Promise<AgentVersion | null> => {
  const result = await deps.run(agent, [flagText(flags.version)], { timeoutMs: VERSION_TIMEOUT_MS });
  return result.ok && result.value.exitCode === 0 ? parseAgentVersion(result.value.stdout) : null;
};

/** The version of the tmux on PATH, or null when tmux does not run or prints no version. */
export const tmuxVersionOf = async (deps: Deps): Promise<Version | null> => {
  const result = await deps.run(toolNames.tmux, ['-V'], { timeoutMs: VERSION_TIMEOUT_MS });
  return result.ok && result.value.exitCode === 0 ? parseTmuxVersion(result.value.stdout) : null;
};
