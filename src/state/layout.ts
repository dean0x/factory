import { join } from 'node:path';

export const CONFIG_FILE = 'factory.yaml';
export const STATE_DIR_NAME = '.factory';

/** Paths inside the state folder. */
export const stateRel = {
  nodeJson: 'node.json',
  protocol: 'protocol.md',
  board: 'board.json',
  waiting: 'waiting.json',
  decisionLog: 'decision-log.json',
  profileReadme: 'decision-profile/README-format.md',
  profileIndex: 'decision-profile/index.md',
  roadmapsReadme: 'roadmaps/README.md',
  briefsKeep: 'briefs/.gitkeep',
  gitignore: '.gitignore',
  backups: 'backups',
} as const;

export interface Layout {
  readonly home: string;
  readonly configFile: string;
  readonly claudeMd: string;
  readonly stateDir: string;
  readonly nodeJson: string;
  readonly protocolMd: string;
  readonly backupsDir: string;
}

/** Every path inside a node home comes from here. */
export const layoutOf = (home: string): Layout => {
  const stateDir = join(home, STATE_DIR_NAME);
  return {
    home,
    configFile: join(home, CONFIG_FILE),
    claudeMd: join(home, 'CLAUDE.md'),
    stateDir,
    nodeJson: join(stateDir, stateRel.nodeJson),
    protocolMd: join(stateDir, stateRel.protocol),
    backupsDir: join(stateDir, stateRel.backups),
  };
};

export const stagingDirOf = (home: string, pid: number): string => join(home, `${STATE_DIR_NAME}.tmp-${pid}`);
