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

## Plain words

Text that a user reads uses the plain word of this table (decision D-11). Code identifiers, config keys, flags and command names stay. A row marked `scanned` has a word that a scan finds with no false hits, and a test checks it. A row marked `by hand` has a word with a common plain meaning, so a person checks it. A row marked `-` has no word to scan. A note that starts with "glossary entry" gives the meaning of an entry that the list above gets with the code change.

| Term | Plain word in user text | Scan | Note |
|---|---|---|---|
| changeover | session reset | scanned | a clear or a compact between two phases; the commands are `worker reset` and `self reset` |
| work order | assignment | scanned | a written assignment for a worker or a child node; "work item" stays the unit of work, and "task" is not used |
| variant | setup | by hand | the key `variant` stays until FAC-M6, when the setup folder replaces the variant; so both name one thing |
| heartbeat | last seen | scanned | the file name stays |
| bench window | worker window | scanned | the tmux window name becomes `workers` |
| outbox | event file | scanned |  |
| adapter | board connector | scanned |  |
| home index | factory list | scanned | the per-user list of registered factories |
| home, root (of a factory) | factory folder | by hand | `--home` and `FACTORY_HOME` stay |
| registered root | registered factory | scanned |  |
| state marker | factory marker | scanned | `.factory/node.json`; "state file" is not used, because the state folder holds many files, and "node file" is not used, because it does not say which file (D-11) |
| root rule | registration check | scanned |  |
| allow list | share list | scanned | the factory part of the root `.gitignore` |
| owner record | approval record | scanned |  |
| owner channel | owner input | scanned | typed input that starts with the owner prefix |
| core block | fixed rules | scanned | the safety block |
| trust step | setup acceptance | scanned | the verb is "accept", not "approve"; the acceptance of the setup hash (D-13) is its first part, and FAC-M6 extends it to every setup file; "approval" means only approval points and approval records (D-11) |
| tracker | board | by hand | the key `tracker` stays |
| checkouts | work copies | by hand | the folder name is `work-copies` (D-11 replaces D-6 `checkouts`); code identifiers can keep a short internal name, but user text, docs and the folder say `work-copies`; "checkout" is also a common git word, so the row is by hand |
| release scope | (software recipe word) | scanned | glossary entry in the recipe part of the glossary; the scan of `src` finds it outside `src/recipes`, and the docs scan leaves it, because the design text of the software recipe uses it |
| received factory | stays | - | glossary entry: a factory folder that you cloned from a config repo of another machine or person |
| moved factory | stays | - | glossary entry: a factory folder that is now at another path on this machine |
| setup acceptance | stays | - | glossary entry: your yes to the setup text, and on a received factory to the other files that its config repo tracks, for one hash; the command line says "accept" |
| factory marker | stays | - | glossary entry: the file `.factory/node.json`, which shows that `init` made this factory folder |
| hash | stays | - | glossary entry: a short code that changes when the text of a file changes; output shows it next to the file name |
| trust boundary | stays in the design text only | - | glossary entry: the point where factory stops trusting files that came from another machine or person; command output does not use it, and names the check, the file and the fix |
| session marker | (not in user text) | - | `FACTORY_SESSION` stays; user text says "inside a factory session" |
| permission-skip list | a setting that skips permission prompts | scanned | the list name stays in code (`src/names.ts`) |
| token-like value | a value that looks like a password or a token | scanned |  |
| link rule | (not in user text) | - | user text says "symbolic link" and "replace the link with a plain file" |
| remedy line | (not in user text) | - | user text is the remedy command itself |
| security stop | stays | - | glossary entry: a check that stops the command (exit 4) to keep private data, credentials or session rules safe, and prints one remedy command |
| block backup | backup file | by hand | the file name in the state folder names the block and the time |
| effective mode | (not in user text) | - | user text says "owner" or "delegated" for each approval point |
| manifest | (not in user text) | - | user text says "the accepted files" and lists each added, removed and changed file by name |
| registration record | (not in user text) | - | user text says "your entry in the factory list" |
| origin `own`, `received` | your own factory, received factory | by hand | the field values stay in the factory list file; output says "your own factory" or "received factory" |
| setup block, role block | (not in user text) | - | user text names the file: "your coordinator text from setup/coordinator.md" and "the role text" |
| TTY | terminal window | by hand | user text says "in a terminal window"; the remedy line says "run factory init in a terminal window" |
| accept prompt | (not in user text) | - | the prompt asks "Accept these files?" and lists them |
| delegated | stays | - | glossary entry: the coordinator approves for the owner |
| approval point | stays | - | glossary entry: a step of the work that needs an approval |
| proxy | stays | - | glossary entry: a server that passes the model calls on |
| recipe | stays | - | glossary entry: the kind of work that a factory does |
| setup, layer | stay | - | Dean's own words (F-4, F-16) |
| message | stays | - | only for the record from another owner (D-6) |
| doctor, `STUCK:` | stay | - | command name and output marker; the help line and the `STUCK:` line say in plain words what they mean |
| node, owner, project | stay | - | Dean's words (F-1) |

## Why the word node stays

A node can be a coordinator, a manager or a worker. One word fits every layer. So the commands and the config do not change when the factory gets a new top layer.
