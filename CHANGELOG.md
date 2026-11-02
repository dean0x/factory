# Changelog

## 0.2.0 (not released)

Renames

- The word `lane` is now `cell`. The word `pack` is now `recipe`, and the plain way to run a recipe is a `variant`. The word `brief` is now `work order`. The tmux pane option is `@cell`.
- The state folder `.factory/briefs/` is now `.factory/orders/`. The file `.factory/protocol.md` is now `.factory/roles/worker.md`, and its managed block is `worker`.
- The config key `lanes` is now `cells`. The key `node.role` is now `node.layer`. The key `pack` of a project is now `recipe.variant`.

Config schema 2 and the migration

- `factory.yaml` has schema 2. The projects are now in `recipe.projects`, and `recipe.id` names the recipe. New keys: `tracker`, `approval`, `parent` and `children`. The only tracker is `local`. The other tracker kinds parse, and `doctor` warns that their connector comes later.
- `factory upgrade` migrates a node of version 0.1.0 to schema 2 in one step. It moves the files, renames the managed block, backs up first, and restores the files when a step fails. It refuses an edited `protocol` block unless you name it with `--overwrite`. After the upgrade, `factory doctor` passes.
- A node link (`parent` and `children`) accepts only a `file://` address on this machine. An `ssh://`, `https://` or relative address is refused. A child with such an address stops the migration and changes nothing.

Home, `init` and `up`

- `factory init` has new home rules. In a git work tree, it proposes a folder beside the repo: `../<repo>-factory`. In a folder that holds git repos, it proposes a folder inside it. It asks on a terminal. `--yes` uses the proposal. With no terminal and no `--yes`, it prints the proposal and exits with code 2.
- `factory init` now refuses (exit code 4) a home inside a git work tree, inside another node home, above a project, or that holds a git repo one level down. Version 0.1.0 gave a warning for a home inside another node home.
- New flags of `init`: `--yes`, `--layer N`, `--recipe ID`. `--project` takes a path or a URL. A URL makes `init` clone the repo next to the home. If a later step fails, `init` removes the clones that it made, and the error names them. A URL name with `..` or a leading `-` is refused. `init` shows and writes a project URL without its user and password part, and it warns when an `https://` URL holds credentials.
- `init` records the home in a home index: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json`. A command with no `--home`, no `FACTORY_HOME` and no `factory.yaml` above the current folder finds the home from a project folder. A home from the index is not trusted for network checks.
- New command `factory up`. It starts a tmux session with the id of the node, with the windows `view` and `bench`. The coordinator runs in the home in auto permission mode, with one `--add-dir` for each project and no inherited `ANTHROPIC_BASE_URL`. A second `up` starts no second coordinator. `--dry-run` prints the tmux calls and starts nothing. Like `init`, `up` refuses (exit code 4) a home inside a git work tree or inside another node home, and it does not use the config of that home.

Roles, layers and nodes

- The role of a node comes from its layer. Layer 1 has the coordinator template. Layer 2 has the manager template. A layer above 2 has no role template yet: `CLAUDE.md` holds the safety block only, `init` prints a warning, and `doctor` warns.
- New commands `factory node children`, `factory node add-child PATH` and `factory node remove-child ID`. A child must be one layer lower. `add-child` refuses on layer 1, because the children of a coordinator are cells. The commands keep the comments and the key order of `factory.yaml`.

Platforms and help

- Every command exits with code 4 on native Windows, and prints the hint to use WSL. macOS and Linux are the supported systems. `factory up` needs tmux 3.0 or newer and `claude` on the PATH.
- New command `factory help words`. It prints one plain sentence for each word that factory uses. `--json` prints the same list.
- `factory doctor` runs 16 checks. New checks: `home`, `index`, `roles`, `tracker` and `children`. The checks `blocks` and `tools` know the new rules.

## 0.1.0 (not released)

- `factory init` creates a node: `factory.yaml`, `CLAUDE.md` and a `.factory/` state folder with its own git repository. It writes `CLAUDE.md` and `factory.yaml` in one step each. If a step fails, it removes only what it made, and the error names each step that it could not undo.
- `factory doctor` runs eleven checks and exits 1 when one fails.
- `factory upgrade` migrates the config and the state, and refreshes the managed blocks. It backs up first, keeps the last 5 backups, and restores the files when a step fails. The error names each file that it could not restore.
- `factory version` and `factory help`.
- Schemas with a version for `factory.yaml` and `.factory/node.json`, and a migration runner.
- Managed blocks in `CLAUDE.md` and `.factory/protocol.md`. A block that a person edited is never replaced without `--overwrite`.
- A secret scan of the config, and a proxy URL check with a health check.
