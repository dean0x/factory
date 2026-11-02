# Changelog

## 0.2.0 (not released)

Renames

- The word `lane` is now `cell`. The word `pack` is now `recipe`, and the plain way to run a recipe is a `variant`. The word `brief` is now `work order`. The tmux pane option is `@cell`.
- The state folder `.factory/briefs/` is now `.factory/orders/`. The file `.factory/protocol.md` is now `.factory/roles/worker.md`, and its managed block is `worker`.
- The config key `lanes` is now `cells`. The key `node.role` is now `node.layer`. The key `pack` of a project is now `recipe.variant`.

Config schema 2 and the migration

- `factory.yaml` has schema 2. The projects are now in `recipe.projects`, and `recipe.id` names the recipe. New keys: `tracker`, `approval`, `parent` and `children`. The only tracker is `local`. The other tracker kinds parse, and `doctor` warns that their connector comes later.
- `factory upgrade` migrates a node of version 0.1.0 to schema 2 in one step. It keeps the comments, the blank lines and the order of the keys in `factory.yaml`. It moves the files, renames the managed block, backs up first, and restores the files when a step fails. It refuses an edited `protocol` block unless you name it with `--overwrite`. After the upgrade of a home that follows the home rules, `factory doctor` passes.
- When `factory upgrade` has something to upgrade, it checks the home rules of `init`. If the home is inside a git work tree or inside another node home, holds a git repo one level down, or is a project folder or holds one, `upgrade` prints a warning with the remedy and still upgrades.
- `factory upgrade` commits only the files that it writes or moves in `.factory/`. It stops before any change when `.factory/` has a staged change, or a change in a file that the upgrade changes. When a step fails, it clears from the index only the paths that it staged. If git reports an error after the commit was written, `upgrade` keeps the new files and says how to check the commit. After a successful upgrade, it records the home in the home index, as `init` does. A problem with the index is a warning.
- The commits of `init` and `upgrade` in the state repo run no git hook.
- A clone that takes longer than 300 seconds stops with a message that names the limit and suggests an ssh agent or `gh auth login`.
- `factory upgrade` works for a home where `factory.yaml` or `CLAUDE.md` is a link to a file. The backup holds a regular file with the content of the target. If the backup fails, `upgrade` removes the backup folder that it made.
- `factory upgrade --dry-run` makes the new text of each file and checks it, so it reports the errors that the real run reports. The JSON output names the old name of a renamed block in `blocks[].renamedFrom`.
- A node link (`parent` and `children`) accepts only a `file://` address on this machine. An `ssh://`, `https://` or relative address is refused. A node on layer 1 with entries in `children` stops the migration and changes nothing, because the children of layer 1 are cells. The message gives the remedy.

Home, `init` and `up`

- `factory init` has new home rules. In a git work tree, it proposes a folder beside the repo: `../<repo>-factory`. In a folder that holds git repos, it proposes a folder inside it. It asks on a terminal. `--yes` uses the proposal. With no terminal and no `--yes`, it prints the proposal and exits with code 2.
- `factory init` now refuses (exit code 4) a home inside a git work tree, inside another node home, above a project, or that holds a git repo one level down. Version 0.1.0 gave a warning for a home inside another node home.
- `factory init` with no `--home` in a node home makes no proposal. It stops with exit code 1 and says that `factory.yaml` already exists. In a folder inside a node home, it makes no proposal either, and it refuses with exit code 4.
- If a stopped `init` left a staging folder `.factory.tmp-<pid>` in the home, the next `init` and `doctor` name the folder and say that you can remove it by hand. They remove nothing.
- New flags of `init`: `--yes`, `--layer N`, `--recipe ID`. `--project` takes a path or a URL. A URL makes `init` clone the repo next to the home. `init` makes every check that needs no cloned project before it clones: the flag values and the owner name, the number of projects, the home (a node that exists, the home rules, a git repo one level down) and `CLAUDE.md`. If a later step fails, `init` removes the clones that it made and the empty folders that it made above them, and the error names them. A URL name with `..` or a leading `-` is refused. A value of the form `user:text@host:path` is refused, and the error does not repeat it. `init` shows and writes a project URL without its user and password part, and it warns when an `https://` URL holds credentials.
- `init` records the home in a home index: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json`. A command with no `--home`, no `FACTORY_HOME` and no `factory.yaml` above the current folder finds the home from a project folder. A home from the index is not trusted for network checks. The index is never under `~/.claude`: the check resolves links, and on macOS it ignores the case of letters.
- The home index file has mode 0600, and its folder has mode 0700. `factory` refuses an index file or index folder that another user owns or that a group or other user can write. The error names the path.
- Two `init` runs at the same time both keep their entry in the home index. A lock file `homes.json.lock` beside the index lets one run write at a time. A run tries 20 times, 50 ms apart, then stops with an error. A lock older than 5 seconds is taken over.
- When the home index lists 200 homes, `init` first drops the entries whose home has no config file. It keeps an entry whose home it cannot check.
- The `index` check of `doctor` warns when the home index does not list the current home.
- `factory doctor` sends no proxy request for a home inside a git work tree or inside another node home. The `proxy` check says that it did not run, and the `home` check fails.
- The `secrets` check of `doctor` accepts a long `file://` address in `parent` and `children`. An address that holds a known token prefix or a hex run of 40 characters or more fails the check.
- `factory` refuses a config file, a state file or a home index file of more than 1,048,576 bytes. It does not read the rest of such a file. This holds for the config of a child that `doctor` and `node children` read.
- New command `factory up`. It starts a tmux session with the id of the node, with the windows `view` and `bench`. The coordinator runs in the home in auto permission mode, with one `--add-dir` for each project and no inherited `ANTHROPIC_BASE_URL`. The shells of the slot and the bench get no `ANTHROPIC_BASE_URL` either. The coordinator gets the `PATH` of the shell that ran `up`. Its pane stays when its program ends at once. If a start step fails after the session is gone, `up` says so and tells you to run `claude` in the shell to read its error. A second `up` starts no second coordinator. If the program of the coordinator has ended, `up` warns, names the commands that remove the session and start it again, and adds `coordinatorEnded` to the JSON output. `--dry-run` prints the tmux calls and starts nothing. Like `init`, `up` refuses (exit code 4) a home inside a git work tree or inside another node home, and it does not use the config of that home.
- `factory up` starts a session also when the home, a project folder or the PATH ends with a semicolon.

Roles, layers and nodes

- The role of a node comes from its layer. Layer 1 has the coordinator template. Layer 2 has the manager template. A layer above 2 has no role template yet: `CLAUDE.md` holds the safety block only, `init` prints a warning, and `doctor` warns.
- New commands `factory node children`, `factory node add-child PATH` and `factory node remove-child ID`. A child must be one layer lower, and its id must differ from the id of this node. `add-child` refuses on layer 1, because the children of a coordinator are cells. The commands keep the comments and the key order of `factory.yaml`.

Platforms and help

- Every command exits with code 4 on native Windows, and prints the hint to use WSL. macOS and Linux are the supported systems. `factory up` needs tmux 3.0 or newer and `claude` on the PATH.
- New command `factory help words`. It prints one plain sentence for each word that factory uses. `--json` prints the same list.
- Error messages, hints, the text of an internal error and the question of `init` show a control character as `?`, as the other text output does.
- `factory doctor` runs 16 checks. New checks: `home`, `index`, `roles`, `tracker` and `children`. The checks `blocks` and `tools` know the new rules.
- The `permission-mode` check does not read the user settings folder of Claude Code. It skips that folder also when the settings folder of the home is a link to it, is inside it, or has other letter case on macOS.

## 0.1.0 (not released)

- `factory init` creates a node: `factory.yaml`, `CLAUDE.md` and a `.factory/` state folder with its own git repository. It writes `CLAUDE.md` and `factory.yaml` in one step each. If a step fails, it removes only what it made, and the error names each step that it could not undo.
- `factory doctor` runs eleven checks and exits 1 when one fails.
- `factory upgrade` migrates the config and the state, and refreshes the managed blocks. It backs up first, keeps the last 5 backups, and restores the files when a step fails. The error names each file that it could not restore.
- `factory version` and `factory help`.
- Schemas with a version for `factory.yaml` and `.factory/node.json`, and a migration runner.
- Managed blocks in `CLAUDE.md` and `.factory/protocol.md`. A block that a person edited is never replaced without `--overwrite`.
- A secret scan of the config, and a proxy URL check with a health check.
