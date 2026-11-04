import { isSlug } from '../config/primitives.js';
import { isSameOrInside } from '../core/paths.js';
import { err, ok, type Result } from '../core/result.js';
import { env, lastSeen, parentSessionEnv, places, roles, values } from '../names.js';
import { workerPathsOf } from '../state/layout.js';

/** What the start of a coordinator and the start of a worker share. */
interface SessionInput {
  /** The node home, the root of the config repo: an absolute path. It is `FACTORY_HOME`, and no `--add-dir` names it. */
  readonly home: string;
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
  /** The agent program: `session.agent` of the config. A start argument list holds no other name of a program. */
  readonly agent: string;
  /** The id of an earlier session that this start resumes: a UUID. It is absent for a new session. */
  readonly resumeId?: string;
}

export interface LaunchInput extends SessionInput {
  /** The working folder of the session: the coordinator folder, an absolute path inside the home. */
  readonly coordinatorDir: string;
  /** The state folder: an absolute path inside the home. The session gets it with `--add-dir`. */
  readonly stateDir: string;
  /** The id of the session: the node id for the coordinator. */
  readonly sessionId: string;
  /** The project folders to add to the session: absolute paths. */
  readonly projects: readonly string[];
}

export interface WorkerLaunchInput extends SessionInput {
  /**
   * The id of the worker: a slug. It is `FACTORY_SESSION`, and it names the folder of the worker in the state folder. The
   * caller starts the session in the work copy of the worker, because the working folder is not part of the argument list.
   */
  readonly workerId: string;
}

const DEFAULT_MODEL = 'default';

/** A model name has no space, no control character and no leading dash, so it can never read as a flag. */
const MODEL_NAME = /^(?!-)[^\s\u0000-\u001f\u007f]+$/;

/**
 * A program name is one plain word. It does not start with a dash, so `env` does not read it as an option. It has no equal
 * sign, so `env` does not read it as a variable. It has no slash, so it is a name that the PATH resolves.
 */
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isAbsolute = (path: string): boolean => path.startsWith('/');

const refuse = (what: string): Result<never, string> => err(`the launch refuses ${what}`);

/** The refusal of the first input value that both starts check, or nothing. */
const checkSession = (input: SessionInput): Result<void, string> => {
  if (!isAbsolute(input.home)) return refuse(`a ${places.folder} that is not an absolute path`);
  if (input.path === '') return refuse('an empty PATH');
  if (!values.efforts.some((effort) => effort === input.effort)) {
    return refuse(`an effort that is not one of: ${values.efforts.join(', ')}`);
  }
  if (input.model !== DEFAULT_MODEL && !MODEL_NAME.test(input.model)) {
    return refuse('a model name with a space, a control character or a leading dash');
  }
  if (!PROGRAM_NAME.test(input.agent)) return refuse('an agent program name that is not one plain word');
  if (input.resumeId !== undefined && !lastSeen.sessionIdPattern.test(input.resumeId)) {
    return refuse('a resume id that is not a UUID with lower case letters');
  }
  return ok(undefined);
};

/**
 * The argument list of one start, with no shell. `env` clears the proxy variable that a shell left behind and each variable
 * of a parent Claude Code session, then sets the proxy variable only when the config names a proxy. Every session starts in
 * auto mode, and no input adds a flag that skips the permission checks: each flag comes from this function, and each input
 * is one value of one flag. The values are checked before they come here, because a value that starts with a dash could
 * read as a flag. The program is the agent of the input, and the start of a coordinator and the start of a worker are the
 * only callers, so no other name of a program is in an argument list.
 */
const startArgv = (input: SessionInput, variables: readonly string[], folders: readonly string[]): readonly string[] => [
  'env',
  '-u',
  env.proxyBaseUrl,
  ...parentSessionEnv.flatMap((name) => ['-u', name]),
  ...(input.proxyBaseUrl === null ? [] : [`${env.proxyBaseUrl}=${input.proxyBaseUrl}`]),
  ...(input.path === null ? [] : [`${env.path}=${input.path}`]),
  `${env.home}=${input.home}`,
  ...variables,
  input.agent,
  '--permission-mode',
  values.permissionMode,
  '--effort',
  input.effort,
  ...(input.model === DEFAULT_MODEL ? [] : ['--model', input.model]),
  ...(input.resumeId === undefined ? [] : ['--resume', input.resumeId]),
  ...folders.flatMap((folder) => ['--add-dir', folder]),
];

/** The argument list that starts the coordinator session. It has the state folder and each project folder. */
export const launchArgv = (input: LaunchInput): Result<readonly string[], string> => {
  const session = checkSession(input);
  if (!session.ok) return session;
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
  return ok(startArgv(input, [`${env.session}=${input.sessionId}`], [input.stateDir, ...input.projects]));
};

/**
 * The argument list that starts a worker session. The only folder that it adds is the inbox of the worker: the worker
 * reads its assignments there, and it gets no project folder, no state folder and no home. `FACTORY_INBOX` names the
 * same folder.
 */
export const workerLaunchArgv = (input: WorkerLaunchInput): Result<readonly string[], string> => {
  const session = checkSession(input);
  if (!session.ok) return session;
  if (!isSlug(input.workerId)) return refuse(`a ${roles.worker} id that is not a slug`);
  const { inboxDir } = workerPathsOf(input.home, input.workerId);
  return ok(startArgv(input, [`${env.session}=${input.workerId}`, `${env.inbox}=${inboxDir}`], [inboxDir]));
};
