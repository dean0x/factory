import { stringify } from 'yaml';
import { renderBlock } from '../../src/blocks/managed.js';
import { jsonText } from '../../src/state/files.js';
import { blockTemplates } from '../../src/templates/index.js';
import type { FakeDeps } from './fake-deps.js';
import { sampleObject } from './sample-config.js';

/** The config of a FAC-M1 node (schema 1), as a person writes it. */
export const schema1Doc = (): Record<string, any> => {
  const sample = sampleObject();
  return {
    schema: 1,
    node: { id: sample.node.id, role: 'coordinator' },
    owner: sample.owner,
    session: sample.session,
    proxies: sample.proxies,
    lanes: {},
    limits: sample.limits,
    projects: sample.recipe.projects.map((project: Record<string, unknown>) => ({ ...project, pack: 'plain' })),
    children: [],
  };
};

const block = (name: string, version: number, body: string): string => {
  const rendered = renderBlock({ name, version, body });
  if (!rendered.ok) throw new Error(rendered.error.message);
  return rendered.value;
};

const bodyOf = (name: string): string => blockTemplates.find((template) => template.name === name)?.body ?? '';

export const OLD_PROTOCOL = 'protocol.md';
export const OLD_BRIEFS = 'briefs';

/** The paths of the files of a FAC-M1 node, inside the state folder. */
export const schema1Paths = (home: string): { config: string; claude: string; state: string; protocol: string; briefsKeep: string; board: string } => ({
  config: `${home}/factory.yaml`,
  claude: `${home}/CLAUDE.md`,
  state: `${home}/.factory`,
  protocol: `${home}/.factory/${OLD_PROTOCOL}`,
  briefsKeep: `${home}/.factory/${OLD_BRIEFS}/.gitkeep`,
  board: `${home}/.factory/board.json`,
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
  deps.seedDir(`${paths.state}/.git`);
};
