# factory words

This file gives one plain sentence for each word that factory uses. The first part has the words of every factory. The second part has the words of the software recipe only.

The words below are the new words of the design (decision D-59). `factory help words` prints the words of the program with the same text as this file.

The list `terms` in `src/names.ts` names the words of the program. Each line below has the form `- **word**: sentence`. After the bold word, the mark `(was: old word)` shows the old word that the new word replaces, for example `- **worker** (was: cell): sentence`. An old word appears nowhere else in an entry. An entry that says "Not built yet" names something that this version does not have. A test checks that each entry has at most 25 words, that each word of the program has one entry here, and that the program holds the same text as that entry.

## Words of every factory

- **node**: A node is a folder with a config file, a layer and an owner. A coordinator or a manager session runs in it.
- **owner**: The owner is the person whose decisions a node carries. Only the owner can approve work or answer a decision.
- **project**: A project is one unit of work that a node manages.
- **layer**: A layer is the level of a node, counted from the bottom. Layer 0 is the workers. Each layer has its own role.
- **worker** (was: cell): A worker is a session in one work copy. It does all the steps for one track of one project.
- **coordinator**: A coordinator is a node on layer 1. It runs the factory for its owner and gives assignments to workers.
- **recipe**: A recipe is the kind of work that a factory does, such as software or marketing. It sets the approval points.
- **setup** (was: variant): A setup is one named way to run a recipe. It adds text and scripts to the fixed rules. The config key stays `recipe.variant`.
- **request** (was: andon): A request is an item that waits for the owner. It can be a question to answer or an action to do. Not built yet.
- **assignment** (was: work order): An assignment is a written task for a worker or a child node. A worker gets it as a file in its assignment folder.
- **session reset** (was: changeover): A session reset wipes or shortens the memory of a session between two phases. A saved handoff keeps the state.
- **queue** (was: staging): A queue is the order of the finished work that waits for an approval point, first item first. Not built yet.
- **check** (was: inspect): A check looks at one piece of finished work. It says READY or NOT READY, with the reasons. Not built yet.
- **work item**: A work item is one unit of work on the board.
- **approval point**: An approval point is a step of the work that needs an approval. The owner sets the mode of each point.
- **delegated**: Delegated is a mode of an approval point: the coordinator approves for the owner. The other mode is owner.
- **board**: A board is the system that holds the work items, the requests and the decisions. The config key is `tracker`.
- **board connector** (was: adapter): A board connector links factory to a board tool, such as GitHub, Jira or Linear. A local connector keeps the items in files.
- **factory folder**: A factory folder is the folder of a node on layer 1 or above. It holds the config, the setup and the work copies.
- **work copy** (was: checkouts): A work copy is a separate copy of a project folder in which one worker works. It is under `work-copies/` in the factory folder.
- **factory list** (was: home index): The factory list is a file for your user. It lists each registered factory and the path of its folder.
- **registered factory** (was: registered root): A registered factory is a factory folder that has an entry in the factory list.
- **factory marker** (was: state marker): The factory marker is the file `.factory/node.json`. It shows that `init` made this factory folder.
- **registration check** (was: root rule): The registration check stops a command when the factory folder has no matching entry in the factory list.
- **share list** (was: allow list): The share list says which files of the factory folder you share with other people. `upgrade` keeps the lines that you add.
- **received factory**: A received factory is a factory folder that you cloned from the shared config of another machine or person.
- **moved factory**: A moved factory is a factory folder that is now at another path on this machine.
- **setup acceptance** (was: trust step): Setup acceptance is your yes to the setup text and, on a received factory, to its other tracked files, for one hash.
- **trust boundary**: A trust boundary is the point where factory stops trusting files from another machine or person. Only the design text uses this word.
- **hash**: A hash is a short code that changes when the text of a file changes. Output shows it next to the file name.
- **fixed rules** (was: core block): The fixed rules are the safety text that every session gets. `start` and `doctor` check their hash and stop if it changed.
- **approval record** (was: owner record): An approval record is the proof that the owner approved a step. A delegated approval point needs one.
- **owner input** (was: owner channel): Owner input is typed input that starts with the owner prefix. Factory types it only for a decision that the owner recorded.
- **security stop**: A security stop is a check that stops a command (exit 4) to keep private data, credentials or rules safe. It prints the fix command.
- **backup file** (was: block backup): A backup file keeps the old text of a block that factory writes again. Its name shows the block and the time.
- **terminal window** (was: TTY): A terminal window is a window where you type commands. Some steps need one, because they ask you a question.
- **last seen** (was: heartbeat): Last seen is a file for each session. It shows the last activity, the session id and the context percent.
- **worker window** (was: bench window): The worker window is the screen window that holds the worker sessions. Its name is `workers`.
- **event file** (was: outbox): The event file is the digest of a node, in `.factory/outbox/`. A script writes it, and a reader follows it.
- **inbox**: The inbox is the assignment folder of a worker. It holds the assignment files and the resume notes of that worker.
- **digest**: A digest is a short summary of a node: its workers, their work items and the requests that wait for the owner.
- **proxy**: A proxy is a server that passes the model calls on. Factory uses one only when the config names it and it answers.

## Words of the software recipe

- **software project**: In the software recipe, a project is one git repo, and a work copy is a git work tree of it.
- **pull request**: A pull request is a proposed change to a project that waits for a review. The merge check reads it.
- **merge**: To merge is to add the change of a pull request to the main line of the project. The approval point `merge` guards it.
- **merge order**: In the software recipe, the merge order is the queue of the pull requests that are READY, first item first.
- **merge check**: The merge check reads a pull request and says READY or NOT READY, with reasons. It is `factory check <pr>`. Not built yet.
- **release**: A release is a version of a project that you publish. The approval point `release` guards it.
- **release check** (was: ship): The release check tests that a release is ready and works after it is out. It never publishes. Not built yet.
- **release scope**: A release scope lists the items and the version that the owner approved for a release. A delegated release check needs one.

## Plain words

Text that a user reads uses the plain word of this table (decision D-11). Code identifiers, config keys, flags and command names stay. A row marked `scanned` has a word that a scan finds with no false hits, and a test checks it. A row marked `by hand` has a word with a common plain meaning, so a person checks it. A row marked `-` has no word to scan. A note that starts with "glossary entry" gives the meaning of the entry of that word in the lists above.

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
