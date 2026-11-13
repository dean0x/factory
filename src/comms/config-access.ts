import type { Deps } from '../core/deps.js';

/**
 * What a look at the shared config of a child finds. `safe`: a regular file of this account that no group and no other user can
 * write. `unsafe`: a link, a file of another account, or a file that a group or other users can write. `missing`: no entry, or an
 * entry that is not a regular file. `unreadable`: the file system failed, so nothing is known.
 */
export type ConfigAccess = 'safe' | 'unsafe' | 'missing' | 'unreadable';

/**
 * Look at the config file of a child, before any read of its text. The file is opened once, and the checks run on the open handle
 * (see `Fs.openChecked`). The call reads no byte of the file, and it never throws. No answer holds text of the fault.
 */
export const configAccessOf = async (deps: Deps, path: string): Promise<ConfigAccess> => {
  const opened = await deps.fs.openChecked(path, { uid: deps.uid, maxBytes: null });
  if (!opened.ok) return 'unreadable';
  const { value } = opened;
  switch (value.state) {
    case 'link':
      return 'unsafe';
    case 'absent':
      return 'missing';
    case 'refused':
      return value.fault === 'wrong-kind' ? 'missing' : 'unsafe';
    case 'unreadable':
      return 'unreadable';
    case 'opened':
      return 'safe';
    default: {
      const unreachable: never = value;
      return unreachable;
    }
  }
};
