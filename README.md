# factory

Set up and run a node of Claude Code sessions with safe defaults.

A node is a folder with a config file, a `CLAUDE.md` for the coordinator, and a `.factory/` folder for the state. The command `factory start` starts the coordinator of the node in tmux. The coordinator manages the projects of the node. This version does not start workers yet.

## Install

Not published yet.

```sh
npm install --global @dean0x/factory
```

You need:

- Node.js 22 or newer. The package has no runtime dependencies.
- tmux 3.0 or newer, and `claude` on the PATH, for `factory start`.
- macOS or Linux. On native Windows, every command exits with code 1 and says to use WSL.

## Commands

| Command | What it does |
| --- | --- |
| `factory init` | Create a node. It writes `factory.yaml`, `CLAUDE.md` and `.factory/`, and makes the first commit in the state repository. |
| `factory start` | Start the tmux session of the node, with the windows `view` and `bench`, or attach to it. |
| `factory doctor` | Run 18 checks on the config, the state, the managed blocks, the secrets, the proxy settings, the tools and the projects. |
| `factory upgrade` | Migrate the config and the state to this version, and refresh the managed blocks. |
| `factory node children` | List the child nodes, with the layer and the state of each. |
| `factory node add-child PATH` | Add a child node that is one layer lower. |
| `factory node remove-child ID` | Remove a child from the config. The files of the child stay. |
| `factory help words` | Print one plain sentence for each word that factory uses. |
| `factory version` | Print the version. |
| `factory help` | Show the help. |

Run `factory <command> --help` to see the flags of one command. All commands take `--json`, `--quiet` and `--no-color`.

### Create a node

Run `init` in the git repo that you want to manage:

```sh
cd ~/work/web
factory init --yes --owner-name "Your Name"
factory doctor
```

The home rules decide where the node home is:

1. With `--home DIR`, the home is `DIR`.
2. Inside a git work tree, the proposal is a folder beside the repo: `../web-factory`. The repo is the first project.
3. In a folder that holds git repos, the proposal is a folder inside it: `./<folder>-factory`. Each repo is a project. A folder that is a linked worktree of a listed repo is skipped, and `init` names it.
4. Else the home is the current folder.

With no `--home`, `init` makes no proposal in a folder that is a node home. It stops with exit code 1 and says that `factory.yaml` already exists. In a folder inside a node home, it makes no proposal either, and it stops with exit code 1.

In cases 2 and 3, `init` asks you to confirm the proposal. With `--yes`, it uses the proposal and asks nothing. With no terminal and no `--yes`, it prints the proposal and exits with code 2.

`init` refuses (exit code 4) a home that is inside a git work tree, above a project, or that holds a git repo one level down. It stops with exit code 1 for a home inside another node home, and names the remedy.

More flags of `init`:

- `--project PATH|URL` adds a project. Repeat the flag for more. A URL (`https://`, `ssh://` or `user@host:path`) makes `init` clone the repo next to the home. `init` makes every check that needs no cloned project before it clones: the flag values and the owner name, the number of projects, the home (a node that exists, the home rules, a git repo one level down) and `CLAUDE.md`. If a later step fails, `init` removes the clones that it made, and the empty folders that it made above them. It never removes a folder that was there before. `init` writes the `url` of each project into `factory.yaml` from the origin of its repo. It writes the URL without credentials, and it warns when the origin held some. It refuses (exit code 2) and clones nothing for a `--project` URL that holds credentials: an `https://` URL with any user part, or a password or a token in any URL form. An `ssh://` URL and the `user@host:path` form accept a user name only. Use an `https://` URL with no user name, or an `ssh://` URL. Use `gh auth login` or an SSH key for the credentials. A repo with no origin, or with a `file` URL, gets no `url`. `init` and `doctor` warn that the factory cannot be shared with that repo. Its local folder stays in the key `sources` of `factory.local.yaml`, never in `factory.yaml`.
- `--layer N` sets the layer of the node, from 1 to 16. The default is 1. Layer 1 has the coordinator role, layer 2 the manager role. A layer above 2 has no role template yet: `CLAUDE.md` holds the safety block only, and `init` prints a warning.
- `--recipe ID` sets the recipe. The only recipe is `software`.
- `--name ID`, `--owner-name NAME` and `--owner-github LOGIN` set the id of the node and the owner.

### Find the home

A command finds the node home in this order:

1. The flag `--home DIR`.
2. The environment variable `FACTORY_HOME`.
3. The nearest `factory.yaml` above the current folder.
4. The home index.

The home is beside the repo, so a walk up from the repo finds no `factory.yaml`. `init` writes the home index for this case: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json` when the variable is not set. The index holds paths only, and it is never under `~/.claude`. The check resolves links, and on macOS it ignores the case of letters. The index file has mode 0600 and its folder has mode 0700. A command refuses an index file or folder that another user owns or that a group or other user can write. The deepest project folder that holds the current folder decides. If no entry fits, the command exits with code 2 and prints a hint. If two homes list the same project, it exits with code 2 and names both homes.

A `factory.yaml` counts only at a root that `init` registered. This holds for all four ways above. Three things must be true:

- The home index (the factory list) has an entry for the folder.
- The `id` of that entry is the `node.id` of the `factory.yaml`.
- The factory marker `.factory/node.json` is there and valid. A marker that an older version wrote is valid; `doctor` then names `upgrade`.

For any other `factory.yaml`, `start`, `doctor`, `node` and `upgrade` exit with code 4. They name the file, the reason and one remedy. For a missing entry, another id or a missing marker, the remedy is to run `factory init` in the factory folder. For a clone of a registered factory that holds its own `factory.yaml`, the remedy is to run the command from the factory folder, or to name it with `--home`. If `.factory` is not a folder, the command stops with exit code 4 too; move the file away, then run `factory init`. If you received the folder or moved it, `factory init` registers it.

### Start a node

```sh
factory start --dry-run
factory start
```

`start` starts a tmux session with the id of the node. The coordinator runs in the window `view`, in the node home. It runs in auto permission mode, with one `--add-dir` for each project, and with the `PATH` of the shell that ran `start`, not the `PATH` of a tmux server that started before. The window `bench` is empty. The coordinator never inherits `ANTHROPIC_BASE_URL` from the shell. Its proxy comes only from the config, and only when it answers. The shells of the slot and the bench get no `ANTHROPIC_BASE_URL` either: `start` removes it from the environment of the session, and from no other session. A second `start` starts no second coordinator. It attaches to the session. If the program of the coordinator has ended, `start` says so and names the commands that remove the session and start it again. `--dry-run` prints the tmux calls and starts no session. `start` counts a `factory.yaml` only at a registered root (see "Find the home"). So a `factory.yaml` that a cloned repo holds never starts a session.

### Child nodes

A node on layer 2 can have child nodes on layer 1. A child address is a `file://` address on this machine. Other addresses are refused.

```sh
factory node add-child ../api-factory
factory node children
factory node remove-child api-factory
```

On layer 1, `add-child` exits with code 2: the children of a coordinator are workers. A child on the wrong layer, a folder that is no node, a child home that is this home or holds it, and a child with the id of this node exit with code 1 and name a remedy. A child that is a child already gives a warning and changes nothing.

### Upgrade a node

```sh
factory upgrade --dry-run
factory upgrade
```

`upgrade` migrates a node of version 0.1.0 to schema 2. It renames `lanes` to `workers`, `node.role` to `node.layer` and `pack` to `recipe` and `variant`. It moves `.factory/protocol.md` to `.factory/roles/worker.md` and `.factory/briefs/` to `.factory/orders/`. It replaces `.factory/roadmaps/README.md` with the new text when the file is still the text that version 0.1.0 wrote. If you edited that file, `upgrade` keeps it and prints a warning. It adds `tracker.kind: local`. It keeps the comments, the blank lines and the order of the keys in `factory.yaml`. A comment on a key that `upgrade` removes goes with that key. If `children` in `factory.yaml` has entries, `upgrade` stops and changes nothing, because the children of a node on layer 1 are workers. Remove the entries and run `upgrade` again. To manage other nodes, set `node.layer` to 2 after the upgrade, and add the nodes with `factory node add-child`. If `projects` in `factory.yaml` has entries, `upgrade` also stops (exit code 1) and changes no file, because a project of version 0.1.0 sits outside the new folder and has no clone URL. Make the node again with `factory init`, and give each repo with `--project`.

`upgrade` follows the root rule (see "Find the home") with one exception. A node of version 0.1.0 is not in the home index. `upgrade` counts such a folder when you name it with `--home` and its `factory.yaml` has schema 1. On a terminal, it shows the folder and the node id and asks whether to upgrade and register it; the default is no. With no terminal, add `--yes`. With `FACTORY_SESSION` set, `upgrade` exits with code 4 and writes nothing, also with `--yes`. A dry run asks nothing and writes nothing.

When `upgrade` has something to upgrade, it checks the home rules of `init`. If the home is inside a git work tree or inside another node home, holds a git repo one level down, or is a project folder or holds one, `upgrade` prints a warning with the remedy and still upgrades. `factory doctor` fails for such a home until you move it. Move the home to a folder beside the projects, and fix the project paths in `factory.yaml`.

`upgrade --dry-run` makes the new text of each file and checks it, so it reports the errors that the real run reports.

`upgrade` backs up `factory.yaml`, `CLAUDE.md` and `.factory/` to `.factory/backups/<timestamp>/`. The backup leaves out `.factory/state/` and `.factory/locks/`: they hold run-time data, and `upgrade` never changes them. It restores the files when a step fails. It never replaces a managed block that you edited, unless you name it. An edited safety block stops `upgrade` with exit code 4. Any other edited block stays as it is, with a warning that names the flag. To replace such a block with the template text, name it:

```sh
factory upgrade --overwrite coordinator
```

`upgrade` keeps the last 5 backups. After a successful upgrade it removes the older ones. A folder in `.factory/backups/` whose name is not a timestamp stays. If a step fails, `upgrade` removes no older backup.

If `factory.yaml` or `CLAUDE.md` is a link to a file, the backup holds a regular file with the content of the target. If the backup itself fails, `upgrade` removes the backup folder that it made and changes nothing else.

`upgrade` makes one commit in `.factory/` with the files that it writes or moves, and no other file. It runs no git hook for that commit. Before it changes anything, it stops when `.factory/` has a staged change, or a change in a file that the upgrade changes. Commit that change, or put the file back, and run `upgrade` again. If git reports an error after it wrote the commit, `upgrade` keeps the new files and tells you how to check the commit. After a successful upgrade, `upgrade` records the home in the home index, as `init` does. A problem with the index is a warning.

## The node home

```
<workspace>/
  web/                      a project (a git repo)
  web-factory/              the node home
    factory.yaml            the config. You edit it.
    CLAUDE.md               the role of the node (managed blocks) and your text
    .factory/               the state. It is its own git repo.
      node.json             the schema version and the versions of the blocks
      roles/worker.md       the worker role (layer 1 only)
      orders/               work orders
      board.json  waiting.json  decision-log.json
      decision-profile/  roadmaps/
```

The node home is never inside a git work tree. The coordinator runs in the home. A worker runs in a project checkout, so it never reads the instructions of the coordinator.

## Words

`factory help words` explains each word. In short: a node has a layer and an owner. Layer 1 is the coordinator of the workers. A recipe is the kind of work that a factory does, and a setup is one named way to run it. An assignment is a written task for a worker or a child node.

## Managed blocks

`init` writes text blocks between markers in `CLAUDE.md` and `.factory/roles/worker.md`:

```
<!-- factory:begin NAME vN sha256=HASH -->
...
<!-- factory:end NAME -->
```

The hash lets `factory` find out that a person edited a block. Text outside the markers is yours. `factory` keeps it.

## Safety defaults

- The permission mode is `auto`. `doctor` fails when a settings file in the node folder skips the permission prompts.
- A proxy comes only from the config. `doctor` prints `Config: <path>` first. It checks that the proxy answers when the config passes the root rule (see "Find the home"), also when it comes from a parent folder, from `FACTORY_HOME` or from the home index. A `factory.yaml` that does not pass the rule, for example one in a clone of a repo, stops `doctor` with exit code 4 before any request. A stray `ANTHROPIC_BASE_URL` in the shell is a warning.
- The proxy host receives the API traffic of the coordinator. Use only a proxy that you control.
- By default, merges and releases wait for the owner.
- `doctor` fails when a value in `factory.yaml` looks like a token. It never prints the value.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings keep exit code 0. |
| 1 | The command failed, or a check failed. |
| 2 | The command line is wrong, or the command finds no node home. |
| 3 | Not ready. No command uses this code yet. |
| 4 | A safety rule refused the action. |

## Development

```sh
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run test:integration
npm run exit-check
```

The integration tests and the exit check use `dist/factory.js`, so run `npm run build` first. Some integration tests need tmux 3.0 or newer, and skip with a note when tmux is missing. The exit check packs the tarball and installs it in a throw-away HOME. Then it runs `init`, `start --dry-run` and `doctor` on a new repo, and searches the generated files and the help text for names that must not be there. It never writes the real HOME, the real state folder or the real tmux server.

`npm run check:docs` checks that the design documents agree with each other.

## License

MIT
