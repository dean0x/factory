import { join } from 'node:path';
import { dirs, files } from '../names.js';

/** Paths inside the state folder. */
export const stateRel = {
  nodeJson: files.nodeState,
  worker: join(dirs.roles, files.worker),
  board: files.board,
  waiting: files.waiting,
  decisionLog: files.decisionLog,
  profileReadme: join(dirs.profile, files.profileReadme),
  profileIndex: join(dirs.profile, files.profileIndex),
  profileDecisions: join(dirs.profile, dirs.decisions),
  profileLog: join(dirs.profile, files.profileLog),
  roadmapsReadme: join(dirs.roadmaps, files.roadmapsReadme),
  ordersKeep: join(dirs.orders, files.ordersKeep),
  gitignore: files.gitignore,
  backups: dirs.backups,
  workers: dirs.workers,
  runtime: dirs.runtime,
  heartbeat: join(dirs.runtime, dirs.heartbeat),
  locks: dirs.locks,
} as const;

export interface Layout {
  /** The root: the top folder of the config repo. */
  readonly home: string;
  readonly configFile: string;
  readonly localConfigFile: string;
  /** The `.gitignore` of the root. Its part between the marker lines is the share list. */
  readonly gitignoreFile: string;
  /** The folder of the coordinator session. Git ignores it. The root holds no instruction file. */
  readonly coordinatorDir: string;
  readonly claudeMd: string;
  /** The folder of the setup text. The root repo tracks it. */
  readonly setupDir: string;
  readonly setupCoordinatorFile: string;
  /** The folder of the role texts in the setup folder. */
  readonly setupRolesDir: string;
  /** The worker role text that a person shares. Each machine renders the worker file of the state folder from it. */
  readonly setupWorkerFile: string;
  /** The fixed folder of the work copies. Git ignores it. */
  readonly workCopiesDir: string;
  readonly stateDir: string;
  readonly nodeJson: string;
  /** The `.gitignore` of the state repo: it keeps the run-time folders, the backups and the workers out of the repo. */
  readonly stateGitignoreFile: string;
  readonly workerMd: string;
  readonly backupsDir: string;
  /** The folder of the workers: one folder for each worker. Git ignores it. */
  readonly workersDir: string;
  /** The run-time folders. Their files are not part of the state repository. */
  readonly runtimeDir: string;
  /** The last-seen files, one for each session. It is inside the run-time folder. */
  readonly heartbeatDir: string;
  /** The pointer to the newest session of the coordinator: the file that names its last-seen line. It is inside the run-time folder. */
  readonly coordinatorLastSessionFile: string;
  /** The id of this machine. It is inside the run-time folder, so the state repo never holds it. */
  readonly machineIdFile: string;
  /** The mark of the active machine. The state repo tracks it. */
  readonly activeMachineFile: string;
  readonly locksDir: string;
}

/** Every path inside a node home comes from here. */
export const layoutOf = (home: string): Layout => {
  const stateDir = join(home, dirs.state);
  const runtimeDir = join(stateDir, stateRel.runtime);
  const coordinatorDir = join(home, dirs.coordinator);
  const setupDir = join(home, dirs.setup);
  const setupRolesDir = join(setupDir, dirs.roles);
  return {
    home,
    configFile: join(home, files.config),
    localConfigFile: join(home, files.localConfig),
    gitignoreFile: join(home, files.gitignore),
    coordinatorDir,
    claudeMd: join(coordinatorDir, files.claudeMd),
    setupDir,
    setupCoordinatorFile: join(setupDir, files.setupCoordinator),
    setupRolesDir,
    setupWorkerFile: join(setupRolesDir, files.worker),
    workCopiesDir: join(home, dirs.workCopies),
    stateDir,
    nodeJson: join(stateDir, stateRel.nodeJson),
    stateGitignoreFile: join(stateDir, stateRel.gitignore),
    workerMd: join(stateDir, stateRel.worker),
    backupsDir: join(stateDir, stateRel.backups),
    workersDir: join(stateDir, stateRel.workers),
    runtimeDir,
    heartbeatDir: join(stateDir, stateRel.heartbeat),
    coordinatorLastSessionFile: join(runtimeDir, files.coordinatorLastSession),
    machineIdFile: join(runtimeDir, files.machineId),
    activeMachineFile: join(stateDir, files.activeMachine),
    locksDir: join(stateDir, stateRel.locks),
  };
};

/** The paths of one worker below the workers folder. */
export interface WorkerPaths {
  /** The folder of the worker. */
  readonly dir: string;
  readonly recordFile: string;
  /** The pointer to the newest session of the worker: the file that names its last-seen line. */
  readonly lastSessionFile: string;
  /** The folder of the messages for the worker. */
  readonly inboxDir: string;
}

/** The paths of a worker. The id names a folder, so the caller checks that it is a slug before it uses a path. */
export const workerPathsOf = (home: string, id: string): WorkerPaths => {
  const dir = join(layoutOf(home).workersDir, id);
  return {
    dir,
    recordFile: join(dir, files.workerRecord),
    lastSessionFile: join(dir, files.workerLastSession),
    inboxDir: join(dir, dirs.inbox),
  };
};

const STAGING_PREFIX = `${dirs.state}.tmp-`;

export const stagingDirOf = (home: string, pid: number): string => join(home, `${STAGING_PREFIX}${pid}`);

/** The folder name is the name of a staging folder, which an init that stopped can leave in the home. */
export const isStagingDirName = (name: string): boolean =>
  name.startsWith(STAGING_PREFIX) && /^\d+$/.test(name.slice(STAGING_PREFIX.length));
