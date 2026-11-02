# factory words

This file gives one plain sentence for each word that factory uses. `factory help words` prints the same sentences. A test checks that each entry has at most 25 words and that this file and the program hold the same text.

The list `terms` in `src/names.ts` names the words. Each line below has the form `- **word**: sentence`. An entry that says "Not built yet" names something that this version does not have.

- **node**: A node is a folder with a config file, a layer and an owner. A coordinator or a manager session runs in it.
- **owner**: The owner is the person whose decisions a node carries. Only the owner can approve work or answer a decision.
- **project**: A project is one unit of work that a node manages. In the software recipe, a project is one git repo.
- **layer**: A layer is the level of a node, counted from the bottom. Layer 0 is the cells. Each layer has its own role.
- **cell**: A cell is a worker session in one checkout. It does all the steps for one track of one project. Not built yet.
- **recipe**: A recipe says which tool runs each step of the work, and what proves it. Not built yet: this version has only the project settings.
- **variant**: A variant is one named way to run a recipe. The plain variant uses Claude Code alone. A project can pick its own variant.
- **andon**: An andon is an item that waits for the owner. It can be a question to answer or an action to do. Not built yet.
- **work order**: A work order is a written task for a cell or a child node. It is a file in .factory/orders/.
- **changeover**: A changeover is a clear or a compact of a session between two phases of work. A saved handoff keeps the state. Not built yet.
- **staging**: Staging is the merge order. It lists the finished work that waits to be merged, first item first. Not built yet.
- **inspect**: Inspect is the merge check. It reads the pull request and says READY or NOT READY, with the reasons. Not built yet.
- **ship**: Ship is the release check. It tests that a release is ready and works after it is out. It never publishes. Not built yet.

## Why the word node stays

A node can be a coordinator, a manager or a cell. One word fits every layer. So the commands and the config do not change when the factory gets a new top layer.
