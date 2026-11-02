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
  roadmapsReadme: join(dirs.roadmaps, files.roadmapsReadme),
  ordersKeep: join(dirs.orders, files.ordersKeep),
  gitignore: files.gitignore,
  backups: dirs.backups,
  runtime: dirs.runtime,
  locks: dirs.locks,
} as const;

export interface Layout {
  readonly home: string;
  readonly configFile: string;
  readonly claudeMd: string;
  readonly stateDir: string;
  readonly nodeJson: string;
  readonly workerMd: string;
  readonly backupsDir: string;
  /** The run-time folders. Their files are not part of the state repository. */
  readonly runtimeDir: string;
  readonly locksDir: string;
}

/** Every path inside a node home comes from here. */
export const layoutOf = (home: string): Layout => {
  const stateDir = join(home, dirs.state);
  return {
    home,
    configFile: join(home, files.config),
    claudeMd: join(home, files.claudeMd),
    stateDir,
    nodeJson: join(stateDir, stateRel.nodeJson),
    workerMd: join(stateDir, stateRel.worker),
    backupsDir: join(stateDir, stateRel.backups),
    runtimeDir: join(stateDir, stateRel.runtime),
    locksDir: join(stateDir, stateRel.locks),
  };
};

const STAGING_PREFIX = `${dirs.state}.tmp-`;

export const stagingDirOf = (home: string, pid: number): string => join(home, `${STAGING_PREFIX}${pid}`);

/** The folder name is the name of a staging folder, which an init that stopped can leave in the home. */
export const isStagingDirName = (name: string): boolean =>
  name.startsWith(STAGING_PREFIX) && /^\d+$/.test(name.slice(STAGING_PREFIX.length));
