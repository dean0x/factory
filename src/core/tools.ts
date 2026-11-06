import { delimiter, join } from 'node:path';
import type { Deps } from './deps.js';

/** The programs that factory starts. `ps` reads how long the process of a pane runs. */
export const toolNames = { git: 'git', tmux: 'tmux', gh: 'gh', claude: 'claude', ps: 'ps' } as const;

const MAX_PATH_ENTRIES = 256;
const VERSION_TIMEOUT_MS = 5000;

/** The oldest tmux that runs a program from an argument list with no shell (`new-session -- command args`). */
export const MIN_TMUX = { major: 3, minor: 0 } as const;

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

/** The version of the tmux on PATH, or null when tmux does not run or prints no version. */
export const tmuxVersionOf = async (deps: Deps): Promise<Version | null> => {
  const result = await deps.run(toolNames.tmux, ['-V'], { timeoutMs: VERSION_TIMEOUT_MS });
  return result.ok && result.value.exitCode === 0 ? parseTmuxVersion(result.value.stdout) : null;
};
