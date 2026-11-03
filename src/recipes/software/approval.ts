/**
 * The approval points of the software recipe: the id, the label, the text for each mode and the proof of each point.
 * The recipe owns these names. The core folders `src/core` and `src/config` never import this file: they get the points
 * from the recipe entry in `src/recipes/index.ts`. The texts hold placeholders such as {{owner}}, and the template code fills them.
 */

const MERGE_PROOF = 'one proof of approval and one proof of assignment for that work';
const RELEASE_PROOF = 'a release scope that the {{owner}} approved, with the items and the version';

export const softwareApprovalPoints = [
  {
    id: 'merge',
    label: 'merge a pull request',
    ownerText: 'A merge waits for the go of the {{owner}}.',
    proof: MERGE_PROOF,
    delegatedText: `The {{owner}} delegated this point. A merge needs ${MERGE_PROOF}.`,
  },
  {
    id: 'release',
    label: 'release a version',
    ownerText: 'A release waits for the go of the {{owner}}.',
    proof: RELEASE_PROOF,
    delegatedText: `The {{owner}} delegated this point. A release needs ${RELEASE_PROOF}.`,
  },
] as const;
