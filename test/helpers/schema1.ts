import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { renderBlock } from '../../src/blocks/managed.js';
import { jsonText } from '../../src/state/files.js';
import { layer1Blocks } from './blocks.js';
import type { FakeDeps } from './fake-deps.js';
import { sampleObject } from './sample-config.js';

/**
 * The config of a FAC-M1 node (schema 1), as a person writes it. It lists no project: a FAC-M1 project sits outside
 * the new folder and has no clone URL, so the upgrade refuses a node that lists one.
 */
export const schema1Doc = (): Record<string, any> => {
  const sample = sampleObject();
  const { statusline: _statusline, ...session } = sample.session;
  return {
    schema: 1,
    node: { id: sample.node.id, role: 'coordinator' },
    owner: sample.owner,
    session,
    proxies: sample.proxies,
    lanes: {},
    limits: sample.limits,
    projects: [],
    children: [],
  };
};

/** The project of a FAC-M1 node: a path beside the node folder, a pack, and no clone URL. */
export const schema1Project = (): Record<string, any> => ({
  id: 'web',
  path: '../web',
  default_branch: 'main',
  merge_method: 'squash',
  pack: 'plain',
  gate: { checks: [] },
});

/** The config of a FAC-M1 node that lists one project. */
export const schema1DocWithProject = (): Record<string, any> => ({ ...schema1Doc(), projects: [schema1Project()] });

const block = (name: string, version: number, body: string): string => {
  const rendered = renderBlock({ name, version, body });
  if (!rendered.ok) throw new Error(rendered.error.message);
  return rendered.value;
};

const bodyOf = (name: string): string => layer1Blocks.find((template) => template.name === name)?.body ?? '';

export const OLD_PROTOCOL = 'protocol.md';
export const OLD_BRIEFS = 'briefs';

/** The text of `roadmaps/README.md` as `init` of version 0.1.0 wrote it. The committed fixture holds it. */
export const OLD_ROADMAPS_README = readFileSync(
  join(__dirname, '..', 'fixtures', 'node-0.1.0', '.factory', 'roadmaps', 'README.md'),
  'utf8',
);

/** The paths of the files of a FAC-M1 node, inside the state folder. */
export const schema1Paths = (
  home: string,
): { config: string; claude: string; state: string; protocol: string; briefsKeep: string; board: string; roadmaps: string } => ({
  config: `${home}/factory.yaml`,
  claude: `${home}/CLAUDE.md`,
  state: `${home}/.factory`,
  protocol: `${home}/.factory/${OLD_PROTOCOL}`,
  briefsKeep: `${home}/.factory/${OLD_BRIEFS}/.gitkeep`,
  board: `${home}/.factory/board.json`,
  roadmaps: `${home}/.factory/roadmaps/README.md`,
});

/**
 * Write the files of a FAC-M1 node into the fake file system: the schema 1 config, the state file of schema 1,
 * the protocol file with its block, the briefs folder, and the state repository folder.
 */
export const seedSchema1Node = (deps: FakeDeps, home: string, doc: Record<string, any> = schema1Doc()): void => {
  const paths = schema1Paths(home);
  deps.seed(paths.config, stringify(doc));
  deps.seed(
    paths.claude,
    `${block('coordinator', 1, bodyOf('coordinator'))}\n\n${block('safety', 1, bodyOf('safety'))}\n`,
  );
  deps.seed(
    `${paths.state}/node.json`,
    jsonText({ schema_version: 1, created_with: '0.1.0', blocks: { coordinator: 1, safety: 1, protocol: 1 } }),
  );
  deps.seed(paths.protocol, `${block('protocol', 1, bodyOf('worker'))}\n`);
  deps.seed(paths.briefsKeep, '');
  deps.seed(paths.board, '{}\n');
  deps.seed(paths.roadmaps, OLD_ROADMAPS_README);
  // The lines that FAC-M1 wrote: the state repo ignores the run-time folders and the backups.
  deps.seed(`${paths.state}/.gitignore`, 'state/\nlocks/\nbackups/\n');
  deps.seedDir(`${paths.state}/.git`);
};
