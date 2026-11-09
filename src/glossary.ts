import { terms } from './names.js';
import type { RecipeEntry } from './recipes/index.js';
import { fillTemplate } from './templates/fill.js';

/**
 * One plain sentence, or two, for each term of `terms`. The text equals the line of the term in docs/glossary.md.
 * The words that names.ts owns are placeholders, so a rename changes names.ts and no text here.
 * A term with no entry is a type error.
 */
const SENTENCES: Readonly<Record<(typeof terms)[number], string>> = {
  node:
    'A {{node}} is a folder with a config file, a layer and an {{owner}}. ' +
    'A {{coordinator}} or a {{manager}} session runs in it.',
  owner:
    'The {{owner}} is the person whose decisions a {{node}} carries. ' +
    'Only the {{owner}} can approve work or answer a decision.',
  project: 'A project is one unit of work that a {{node}} manages.',
  layer:
    'A layer is the level of a {{node}}, counted from the bottom. Layer 0 is the {{worker}}s. Each layer has its own role.',
  worker: 'A {{worker}} is a session in one work copy. It does all the steps for one track of one project.',
  coordinator:
    'A {{coordinator}} is a {{node}} on layer 1. ' +
    'It runs the {{program}} for its {{owner}} and gives assignments to {{worker}}s.',
  recipe:
    'A {{recipe}} is the kind of work that a {{program}} does, such as software or marketing. ' +
    'It sets the approval points.',
  setup:
    'A setup is one named way to run a {{recipe}}. It adds text and scripts to the fixed rules. ' +
    'The config key stays `{{variantKey}}`.',
  request: 'A request is an item that waits for the {{owner}}. It can be a question to answer or an action to do.',
  assignment:
    'An assignment is a written task for a {{worker}} or a child {{node}}. ' +
    'A {{worker}} gets it as a file in its assignment folder.',
  'session reset':
    'A session reset wipes or shortens the memory of a session between two phases. A saved handoff keeps the state.',
  queue: 'A queue is the order of the finished work that waits for an approval point, first item first.',
  check:
    'A check looks at one piece of finished work. It says READY or NOT READY, with the reasons. Not built yet.',
  track: 'A track is a named stream of work with its own roadmap. A {{worker}} is not a track.',
  stage: 'A stage is where a work item is on the board. It is not a step of the work cycle. It is never an approval.',
};

export interface Word {
  readonly term: string;
  readonly text: string;
}

/** The plain description of each term of every recipe, in the order of `terms`. */
export const glossary: readonly Word[] = terms.map((term) => ({ term, text: fillTemplate([SENTENCES[term]]) }));

/** The plain description of each word of one recipe, in the order of its entry. */
export const recipeGlossary = (recipe: RecipeEntry): readonly Word[] =>
  recipe.glossary.map((entry) => ({ term: entry.term, text: fillTemplate([entry.text]) }));
