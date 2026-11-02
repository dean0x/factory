import { err, ok, type Result } from '../core/result.js';
import { toolNames } from '../core/tools.js';
import { env, roles, values } from '../names.js';

export interface LaunchInput {
  /** The node home: an absolute path. */
  readonly home: string;
  /** The id of the session: the node id for the coordinator. */
  readonly sessionId: string;
  readonly effort: string;
  /** The model, or `default` to let Claude Code choose. */
  readonly model: string;
  /** The base URL of the proxy, or null when the session uses no proxy. */
  readonly proxyBaseUrl: string | null;
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
  if (!isAbsolute(input.home)) return refuse(`a ${roles.node} home that is not an absolute path`);
  if (!input.projects.every(isAbsolute)) return refuse('a project path that is not an absolute path');
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
    `${env.home}=${input.home}`,
    `${env.session}=${input.sessionId}`,
    toolNames.claude,
    '--permission-mode',
    values.permissionMode,
    '--effort',
    input.effort,
    ...(hasModel ? ['--model', input.model] : []),
    ...input.projects.flatMap((project) => ['--add-dir', project]),
  ]);
};
