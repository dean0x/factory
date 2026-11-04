import { isSameOrInside } from '../core/paths.js';
import { err, ok, type Result } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { env, places, roles, values } from '../names.js';

export interface LaunchInput {
  /** The node home, the root of the config repo: an absolute path. It is `FACTORY_HOME`, and no `--add-dir` names it. */
  readonly home: string;
  /** The working folder of the session: the coordinator folder, an absolute path inside the home. */
  readonly coordinatorDir: string;
  /** The state folder: an absolute path inside the home. The session gets it with `--add-dir`. */
  readonly stateDir: string;
  /** The id of the session: the node id for the coordinator. */
  readonly sessionId: string;
  readonly effort: string;
  /** The model, or `default` to let Claude Code choose. */
  readonly model: string;
  /** The base URL of the proxy, or null when the session uses no proxy. */
  readonly proxyBaseUrl: string | null;
  /**
   * The PATH of the process that starts the session, or null for none. The launch sets it, so that the programs of the
   * session do not depend on the PATH of a tmux server that started before.
   */
  readonly path: string | null;
  /** The project folders to add to the session: absolute paths. */
  readonly projects: readonly string[];
}

const DEFAULT_MODEL = 'default';

/** A model name has no space, no control character and no leading dash, so it can never read as a flag. */
const MODEL_NAME = /^(?!-)[^\s\u0000-\u001f\u007f]+$/;

const isAbsolute = (path: string): boolean => path.startsWith('/');

const refuse = (what: string): Result<never, string> => err(`the launch refuses ${what}`);

/**
 * The argument list that starts a Claude Code session, with no shell. `env` clears a proxy variable that a shell left
 * behind, then sets it only when the config names a proxy. Every session starts in auto mode, and no input adds a flag
 * that skips the permission checks: each flag comes from this function, and each input is one value of one flag.
 * The values are checked here, because a value that starts with a dash could read as a flag.
 */
export const launchArgv = (input: LaunchInput): Result<readonly string[], string> => {
  if (!isAbsolute(input.home)) return refuse(`a ${places.folder} that is not an absolute path`);
  if (!isAbsolute(input.coordinatorDir) || input.coordinatorDir === input.home || !isSameOrInside(input.home, input.coordinatorDir)) {
    return refuse(`a ${roles.coordinator} folder that is not a folder inside the ${places.folder}`);
  }
  if (!isAbsolute(input.stateDir) || input.stateDir === input.home || !isSameOrInside(input.home, input.stateDir)) {
    return refuse(`a state folder that is not a folder inside the ${places.folder}`);
  }
  if (!input.projects.every(isAbsolute)) return refuse('a project path that is not an absolute path');
  // The home holds the config. A session that gets it, or a folder above it, reads and writes the config.
  if (input.projects.some((project) => isSameOrInside(project, input.home))) {
    return refuse(`a project folder that is the ${places.folder} or holds it`);
  }
  if (input.path === '') return refuse('an empty PATH');
  if (!values.efforts.some((effort) => effort === input.effort)) {
    return refuse(`an effort that is not one of: ${values.efforts.join(', ')}`);
  }
  const hasModel = input.model !== DEFAULT_MODEL;
  if (hasModel && !MODEL_NAME.test(input.model)) return refuse('a model name with a space, a control character or a leading dash');

  return ok([
    'env',
    '-u',
    env.proxyBaseUrl,
    ...(input.proxyBaseUrl === null ? [] : [`${env.proxyBaseUrl}=${input.proxyBaseUrl}`]),
    ...(input.path === null ? [] : [`${env.path}=${input.path}`]),
    `${env.home}=${input.home}`,
    `${env.session}=${input.sessionId}`,
    toolNames.claude,
    '--permission-mode',
    values.permissionMode,
    '--effort',
    input.effort,
    ...(hasModel ? ['--model', input.model] : []),
    ...[input.stateDir, ...input.projects].flatMap((folder) => ['--add-dir', folder]),
  ]);
};
