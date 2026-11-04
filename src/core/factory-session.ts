import { env } from '../names.js';
import type { Deps } from './deps.js';

/**
 * True when this process runs inside a session that factory started: the environment holds the session marker, and it
 * is not empty. The launch sets the marker, and so does the tmux session environment, so each pane carries it.
 */
export const inFactorySession = (deps: Pick<Deps, 'env'>): boolean => {
  const value = deps.env[env.session];
  return value !== undefined && value !== '';
};
