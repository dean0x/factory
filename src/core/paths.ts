import { isAbsolute, relative, sep } from 'node:path';

/** True when `child` is `parent` or a path inside it. Both paths are absolute and clean. */
export const isSameOrInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
