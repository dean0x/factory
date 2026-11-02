# factory

Set up and run a node of Claude Code sessions with safe defaults.

A node is a folder with a config file, a `CLAUDE.md` for the coordinator, and a `.factory/` folder for the state. The command `factory up` starts the coordinator of the node in tmux. The coordinator manages the projects of the node. This version does not start cells yet.

## Install

```sh
npm install --global @dean0x/factory
```

You need:

- Node.js 22 or newer. The package has no runtime dependencies.
- tmux 3.0 or newer, and `claude` on the PATH, for `factory up`.
- macOS or Linux. On native Windows, every command exits with code 4. Use WSL.

## Commands

| Command | What it does |
| --- | --- |
| `factory init` | Create a node. It writes `factory.yaml`, `CLAUDE.md` and `.factory/`, and makes the first commit in the state repository. |
| `factory up` | Start the tmux session of the node, with the windows `view` and `bench`, or attach to it. |
| `factory doctor` | Run 16 checks on the config, the state, the managed blocks, the secrets, the proxy settings, the tools and the projects. |
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

In cases 2 and 3, `init` asks you to confirm the proposal. With `--yes`, it uses the proposal and asks nothing. With no terminal and no `--yes`, it prints the proposal and exits with code 2.

`init` refuses (exit code 4) a home that is inside a git work tree, inside another node home, above a project, or that holds a git repo one level down.

More flags of `init`:

- `--project PATH|URL` adds a project. Repeat the flag for more. A URL (`https://`, `ssh://` or `user@host:path`) makes `init` clone the repo next to the home. If a later step fails, `init` removes the clones that it made. It never removes a folder that was there before.
- `--layer N` sets the layer of the node, from 1 to 16. The default is 1. Layer 1 has the coordinator role, layer 2 the manager role. A layer above 2 has no role template yet: `CLAUDE.md` holds the safety block only, and `init` prints a warning.
- `--recipe ID` sets the recipe. The only recipe is `software`.
- `--name ID`, `--owner-name NAME` and `--owner-github LOGIN` set the id of the node and the owner.

### Find the home

A command finds the node home in this order:

1. The flag `--home DIR`.
2. The environment variable `FACTORY_HOME`.
3. The nearest `factory.yaml` above the current folder.
4. The home index.

The home is beside the repo, so a walk up from the repo finds no `factory.yaml`. `init` writes the home index for this case: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json` when the variable is not set. The index holds paths only, and it is never under `~/.claude`. The deepest project folder that holds the current folder decides. If no entry fits, the command exits with code 2 and prints a hint. If two homes list the same project, it exits with code 2 and names both homes.

### Start a node

```sh
factory up --dry-run
factory up
```

`up` starts a tmux session with the id of the node. The coordinator runs in the window `view`, in the node home. It runs in auto permission mode, with one `--add-dir` for each project. The window `bench` is empty. The session never inherits `ANTHROPIC_BASE_URL`. A proxy comes only from the config, and only when it answers. A second `up` starts no second coordinator. It attaches to the session. `--dry-run` prints the tmux calls and starts no session. `up` refuses (exit code 4) a home inside a git work tree or inside another node home, as `init` does. So a `factory.yaml` that a cloned repo holds never starts a session.

### Child nodes

A node on layer 2 can have child nodes on layer 1. A child address is a `file://` address on this machine. Other addresses are refused.

```sh
factory node add-child ../api-factory
factory node children
factory node remove-child api-factory
```

On layer 1, `add-child` refuses: the children of a coordinator are cells.

### Upgrade a node

```sh
factory upgrade --dry-run
factory upgrade
```

`upgrade` migrates a node of version 0.1.0 to schema 2. It renames `lanes` to `cells`, `node.role` to `node.layer` and `pack` to `recipe` and `variant`. It moves `.factory/protocol.md` to `.factory/roles/worker.md` and `.factory/briefs/` to `.factory/orders/`. It adds `tracker.kind: local`.

`upgrade` backs up `factory.yaml`, `CLAUDE.md` and `.factory/` to `.factory/backups/<timestamp>/`. The backup leaves out `.factory/state/` and `.factory/locks/`: they hold run-time data, and `upgrade` never changes them. It restores the files when a step fails. It never replaces a managed block that you edited. To replace such a block with the template text, name it:

```sh
factory upgrade --overwrite coordinator
```

`upgrade` keeps the last 5 backups. After a successful upgrade it removes the older ones. A folder in `.factory/backups/` whose name is not a timestamp stays. If a step fails, `upgrade` removes no backup.

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

The node home is never inside a git work tree. The coordinator runs in the home. A cell runs in a project checkout, so it never reads the instructions of the coordinator.

## Words

`factory help words` explains each word. In short: a node has a layer and an owner. Layer 1 is the coordinator of the cells. A recipe says how a kind of work runs, and a variant is one way to run it. A work order is a written task for a cell or a child node.

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
- A proxy comes only from the config. `doctor` prints `Config: <path>` first. It checks that the proxy answers only when the config comes from `--home` or from the current folder. If the config comes from a parent folder, from `FACTORY_HOME` or from the home index, `doctor` sends no request. It warns: "Run with --home DIR to check the proxy". A stray `ANTHROPIC_BASE_URL` in the shell is a warning.
- Merges and releases wait for the owner.
- `doctor` fails when a value in `factory.yaml` looks like a token. It never prints the value.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings keep exit code 0. |
| 1 | The command failed, or a check failed. |
| 2 | The command line is wrong. |
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

The integration tests and the exit check use `dist/factory.js`, so run `npm run build` first. Some integration tests need tmux 3.0 or newer, and skip with a note when tmux is missing. The exit check packs the tarball and installs it in a throw-away HOME. Then it runs `init`, `up --dry-run` and `doctor` on a new repo, and searches the generated files and the help text for names that must not be there. It never writes the real HOME, the real state folder or the real tmux server.

`npm run check:docs` checks that the design documents agree with each other.

## License

MIT
