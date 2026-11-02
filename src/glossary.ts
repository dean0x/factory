import { terms } from './names.js';
import { fillTemplate } from './templates/fill.js';

/**
 * One plain sentence, or two, for each term of `terms`. The text equals the line of the term in docs/glossary.md.
 * The words that names.ts owns are placeholders, so a rename changes names.ts and no text here.
 * A term with no entry is a type error.
 */
const SENTENCES: Readonly<Record<(typeof terms)[number], string>> = {
  node:
    'A {{node}} is one Claude Code session that has a layer and an {{owner}}. ' +
    'A {{cell}}, a {{coordinator}} and a {{manager}} are all {{node}}s.',
  owner:
    'The {{owner}} is the person whose decisions a {{node}} carries. ' +
    'Only the {{owner}} can approve work or answer a decision.',
  project:
    'A project is one unit of work that a {{node}} manages. In the software {{recipe}}, a project is one git repo.',
  layer:
    'A layer is the level of a {{node}}, counted from the bottom. Layer 0 is the {{cell}}s. Each layer has its own role.',
  cell:
    'A {{cell}} is a {{worker}} session in one checkout. ' +
    'It does all the steps of the work for one track of one project.',
  recipe:
    'A {{recipe}} tells the {{program}} which tool runs each step of the work, and what proves that the step ran.',
  variant:
    'A {{variant}} is one named way to run a {{recipe}}. The plain {{variant}} uses Claude Code alone. ' +
    'A project can pick its own {{variant}}.',
  andon: 'An andon is an item that waits for the {{owner}}. It can be a question to answer or an action to do.',
  'work order':
    'A work order is a written task for a {{cell}} or a child {{node}}. It is a file in the inbox.',
  changeover:
    'A changeover is a clear or a compact of a session between two phases of work. A saved handoff keeps the state.',
  staging:
    'Staging is the merge order. It lists the finished work that waits to be merged, first item first.',
  inspect:
    'Inspect is the merge check. It reads the pull request and says READY or NOT READY, with the reasons.',
  ship:
    'Ship is the release check. It tests that a release is ready and that it works after it is out. It never publishes.',
};

export interface Word {
  readonly term: string;
  readonly text: string;
}

/** The plain description of each term, in the order of `terms`. */
export const glossary: readonly Word[] = terms.map((term) => ({ term, text: fillTemplate([SENTENCES[term]]) }));
