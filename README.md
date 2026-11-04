# factory

Set up and run a node of Claude Code sessions with safe defaults.

A node is a folder with a config file, a layer and an owner. A node on layer 1 or above has a factory folder. The factory folder is a git repo of its own, the config repo. It holds the config files, your setup text, a clone of each project and the folder `coordinator/` with the role text of the coordinator. The state folder `.factory/` is a second git repo inside it. The config repo shares only `factory.yaml`, `.gitignore` and `setup/`. The command `factory start` starts the coordinator of the factory in tmux. The coordinator manages the projects of the factory. This version does not start workers yet.

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
| `factory init` | Make a factory, or register a received or moved one. It writes `factory.yaml`, `factory.local.yaml`, `.gitignore`, `setup/coordinator.md`, `setup/roles/worker.md`, `coordinator/CLAUDE.md` and `.factory/`, and it clones each project. It makes the first commit in the state repo and the first commit in the config repo. Its last step is the entry in the factory list. It asks before it writes the hook settings of the coordinator; `--yes` agrees. |
| `factory start` | Start the tmux session of the factory, with the windows `view` and `workers`, or attach to it. It asks before it writes the hook settings of the coordinator; `--yes` agrees. |
| `factory doctor` | Run 25 checks. See "Doctor". |
| `factory upgrade` | Migrate the config and the state to this version, and refresh the managed blocks. |
| `factory hook EVENT` | For Claude Code, not for people. It records when a session was last seen, for the events `SessionStart`, `UserPromptSubmit`, `Stop` and `PreCompact`. It does its work only when `FACTORY_HOME` is set. It exits with code 0 and prints nothing to stdout on every path. |
| `factory hook statusline` | For Claude Code, not for people. It is the status line of the coordinator. It records the context percent of the session in the last-seen record, then prints the output of the command in `session.statusline` of `factory.local.yaml` as it is (the command gets the same input, and has 2 seconds; at the limit, every process that it started stops). With no command, or with a command that fails or takes too long, it prints `context N%`. When the input gives no percent, it prints `context ?%`. It exits with code 0 on every path and prints at most one line on stderr. The field names of the input come from the devflow HUD, which reads the live payload; checked against the Claude Code status line docs. |
| `factory node children` | List the child nodes, with the layer and the state of each. |
| `factory node add-child PATH` | Add a child node that is one layer lower. |
| `factory node remove-child ID` | Remove a child from the config. The files of the child stay. |
| `factory help words` | Print one plain sentence for each word that factory uses. |
| `factory version` | Print the version. |
| `factory help` | Show the help. |

Run `factory <command> --help` to see the flags of one command. All commands take `--json`, `--quiet` and `--no-color`.

### Make a factory

Run `init` in the git repo that you want to manage:

```sh
cd ~/work/web
factory init --yes --owner-name "Your Name"
factory doctor
```

The place of the factory folder is decided in this order:

1. With `--home DIR`, the factory folder is `DIR`.
2. Inside a git work tree, the proposal is a folder beside the repo: `../web-factory`. `init` clones the repo into it as the first project. The old folder stays as it was, and `init` warns that it keeps the work that is not pushed. If the top of the work tree holds `factory.yaml`, that top is the factory folder, and "Run `init` again" below says what `init` does there.
3. In a folder that holds git repos one level down, the proposal is a folder inside it: `./<folder>-factory`. `init` clones each repo into it as a project. A folder that is a linked work tree of a listed repo is skipped, and `init` names it.
4. In a folder that holds `factory.yaml`, that folder is the factory folder. "Run `init` again" below says what `init` does there.
5. Else the factory folder is the current folder.

For a proposal, `init` asks you to confirm it in a terminal window. With `--yes`, it uses the proposal and asks nothing. With no terminal window and no `--yes`, it prints the proposal and exits with code 2.

`init` also makes sure that `coordinator/.claude/settings.local.json` holds the last-seen hook and the status line wrapper (`factory hook EVENT` and `factory hook statusline`). This holds for a new factory, a received factory and a registered one. `init` asks after its last write, and after the question about the setup text when there is one. In a terminal window it prints the exact change and the file, then asks (the default is no). `--yes` is the yes outside a factory session. With no terminal window and no `--yes`, `init` checks this before its first write, writes nothing and exits with code 2, so a script that runs `init` needs `--yes`. Inside a factory session, `--yes` gives no consent, so the exit code is also 2. If you answer no, `init` goes on without the hook and prints one line: factory has no last-seen record of the coordinator, so a restart or a reboot can not resume the session by its id. To add the hook later, run `init` again and answer yes. When the entries are in place, `init` asks nothing and writes nothing.

`init` stops with exit code 1 for a factory folder inside a folder that the factory list holds, and names the remedy. A factory folder can sit beside another one. The factory folder is a git repo of its own, so `init` has no rule about a git work tree around it.

A project is one folder in the factory folder, and its path in `factory.yaml` is that folder name. The name has no `/`, no `\` and no control character, and it does not start with a dot. The factory folder keeps some names for itself: `coordinator`, `work-copies`, `setup`, `factory.yaml`, `factory.local.yaml`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md`, in any letter case. `init` refuses (exit code 4) a repo with such a name before it clones, and it names the folder name that the repo would take. A config file with such a path fails to load.

More flags of `init`:

- `--project PATH|URL` adds a project. Repeat the flag for more. A URL (`https://`, `ssh://` or `user@host:path`) makes `init` clone the repo into the factory folder, in the folder with the name of the repo. A path of a git work tree makes `init` clone the repo from the origin of the work tree. A work tree with no origin is cloned from its folder. A work tree that is a folder of the factory folder already is the project, and `init` clones nothing.
- `init` makes every check that needs no cloned project before it clones. The checks are the flag values and the owner name, the number of projects, the folder names of the projects, the factory folder, and `coordinator/CLAUDE.md`, `.gitignore` and `setup/`. If a later step fails, `init` removes the clones that it made, and the empty folders that it made above them. It never removes a folder that was there before.
- The last step of `init` writes the factory folder into the factory list. If that fails, or if no variable names a folder for the list, `init` exits with code 1, removes only what the run made, and prints no success line. A second `init` in the same folder then works.
- `init` writes the `url` of each project into `factory.yaml` from the origin of its repo. It writes the URL without credentials, and it warns when the origin held some. It refuses (exit code 2) and clones nothing for a `--project` URL that holds credentials: an `https://` URL with any user part, or a password or a token in any URL form. An `ssh://` URL and the `user@host:path` form accept a user name only. Use an `https://` URL with no user name, or an `ssh://` URL. Use `gh auth login` or an SSH key for the credentials.
- A repo with no origin, or with a `file` URL, gets no `url`. `init` and `doctor` warn that the factory cannot be shared with that repo. Its local folder stays in the key `sources` of `factory.local.yaml`, never in `factory.yaml`.
- `--layer N` sets the layer of the node, from 1 to 16. The default is 1. Layer 1 has the coordinator role, layer 2 the manager role. A layer above 2 has no role template yet: `coordinator/CLAUDE.md` holds the safety block only, and `init` prints a warning.
- `--recipe ID` sets the recipe. The only recipe is `software`.
- `--approval POINT=MODE` sets the mode of one approval point of the recipe. See "Approval points".
- `--name ID`, `--owner-name NAME` and `--owner-github LOGIN` set the id of the node and the owner.

### Approval points

The recipe lists the approval points. The points of the `software` recipe are `merge` and `release`. The owner sets the mode of each point: `owner` or `delegated`. The default is `owner`: the work waits for the owner.

- `--approval POINT=MODE` sets one point. Repeat the flag for more points. In a terminal window, `init` asks for each point that no flag names. With `--yes`, or with no terminal window and no flag, `init` writes `owner` for each point. `--yes` with a flag that asks for `delegated` exits with code 2 and writes nothing.
- A `delegated` choice with no terminal window, or inside a factory session, exits with code 4 and writes nothing. Only `init` in a terminal window outside a factory session writes the approval record of a `delegated` point.
- `init` records each point that you set in a terminal window after its last write. If a record cannot be written, `init` still succeeds, prints a warning that names the point and the remedy (run `factory init` again in a terminal window outside a factory session), and the point counts as `owner`.
- A `delegated` mode in `factory.local.yaml` with no matching approval record counts as `owner`. `doctor` and `start` warn about it, and show the points with the mode `delegated`.
- A delegation counts only for work that the owner approved and assigned.
- The list of points travels with the recipe. The mode of each point stays in `factory.local.yaml`, because a delegation is owner authority.
- To change a mode later, run `factory init` again in the factory folder (see "Run `init` again"). The command `factory decide` comes in FAC-M5. It answers decisions, and it sets no approval mode.
- On a new factory, run `factory upgrade` after a recorded delegation to render the text of the coordinator again. A second `init` that changes a mode renders it by itself.

### Find the factory folder

A command finds the factory folder in this order:

1. The flag `--home DIR`.
2. The environment variable `FACTORY_HOME`.
3. The nearest `factory.yaml` above the current folder (at most 64 levels).
4. The factory list.

The clones are inside the factory folder, so a walk up from a clone or from `coordinator/` finds `factory.yaml`. `init` writes the factory list: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json` when the variable is not set. The list holds paths only, and it is never under `~/.claude`. The check resolves links, and on macOS it ignores the case of letters. The list file has mode 0600 and its folder has mode 0700. A command refuses a list file or folder that another user owns or that a group or other user can write. For a command with no `--home`, no `FACTORY_HOME` and no `factory.yaml` above, the deepest project folder that holds the current folder decides. If no entry fits, the command exits with code 2 and prints a hint. If two factories list the same project, it exits with code 2 and names both folders.

A `factory.yaml` counts only at a factory folder that `init` registered. This holds for all four ways above. Three things must be true:

- The factory list has an entry for the folder.
- The `id` of that entry is the `node.id` of the `factory.yaml`.
- The factory marker `.factory/node.json` is there and valid. A marker that an older version wrote is valid; `doctor` then names `upgrade`.

For any other `factory.yaml`, `start`, `doctor`, `node` and `upgrade` exit with code 4. They name the file, the reason and one remedy. For a missing entry, another id or a missing marker, the remedy is to run `factory init` in the factory folder. For a clone of a registered factory that holds its own `factory.yaml`, the remedy is to go to the factory folder, or to name it with `--home`. If `.factory` is not a folder, the command stops with exit code 4 too; move the file away, then run `factory init`. If you received the folder or moved it, `factory init` registers it.

### Run `init` again

In a folder that holds `factory.yaml` and `factory.local.yaml`, `init` makes no new factory. It never changes `factory.yaml`, `setup/` or the `.gitignore` of the factory folder. It makes the checks of a received folder before it asks anything. The two files hold every value, so `--name`, `--layer`, `--recipe`, `--project`, `--owner-name` and `--owner-github` exit with code 2. If `factory.yaml` is not valid, `init` exits with code 1 and names `factory doctor`.

- **A registered folder** (the entry has the same node id): in a terminal window outside a factory session, `init` asks for each approval point. The default answer is the current mode, and `--approval` sets one point. The answer goes into `factory.local.yaml`, and `init` writes the record of each point after the entry in the factory list. This is how you change a mode later. When a mode changes, `init` renders the text of `coordinator/CLAUDE.md` again in the same run, so that it names the mode that counts. A block that you edited stays as it is, with a warning that names `factory upgrade`.
- **A moved folder** (no entry) or **a folder whose entry has another node id**: `init` shows the folder, the node id and the reason, and asks you to register the folder. `--yes` registers it with no question. With no terminal window and no `--yes`, `init` exits with code 2. The origin of the entry is `received`. A move ends each delegation, so each point counts as `owner`. `init` names the points that you must set again with a second `init`. These folders take no `--approval`.
- **A state folder with a missing or broken marker**: `init` writes `.factory/node.json` again and commits it. A missing `.factory` is made as for a received folder. A `.factory` that is not a folder exits with code 4, and so does a marker from a newer version.
- In a factory session, `init` exits with code 4 and writes nothing in all of these cases.

If a write fails, `init` exits with code 1 and puts back what it wrote.

### Share a factory

A factory can go from one machine or person to another through git. The config repo holds every file that a person needs to make the same factory.

What travels in git:

- `factory.yaml`: the node, the board, the session settings, the limits, and the recipe with its projects.
- `setup/coordinator.md` and `setup/roles/worker.md`: your own text for the coordinator and for every worker.
- `.gitignore`: the share list. It allows these paths and ignores every other path.

What does not travel:

- `factory.local.yaml`: personal values, credentials and values of one machine.
- `coordinator/CLAUDE.md` and `.factory/roles/worker.md`: each machine renders them from the package and from the setup files.
- The clones of the projects and the work copies. Each machine clones them.
- The work state in `.factory/`: the items, the decisions and the workers. It stays on its machine until FAC-M3.

To publish the config repo, add a remote to the factory folder and push. `init` made the first commit on the branch `main`. Only the files of the share list go out.

```sh
cd ~/work/web-factory
git remote add origin <url>
git push -u origin main
```

The one command for a received factory is `factory init`. You need the `factory` program on the machine first. Another developer can not install it before the package is published.

```sh
git clone <url> <folder>
cd <folder>
factory init
```

`init` clones each project and registers the folder. In a terminal window it asks, in this order: your personal values (the owner name and login), the mode of each approval point, the acceptance of the setup text and of every other file that the config repo tracks, and a yes or a no for the hook settings of the coordinator. Then `factory start` works. `--yes` does not accept the files of a received factory. With no terminal window, or with `--yes`, `init` stops on a received factory that tracks setup text or other files. A script can not receive such a factory.

A received factory is a trust boundary: the files of another person are not trusted until you accept them. See "The setup text" and "Safety defaults".

A project with no origin, or with a local source, works on this machine. The factory can not be shared with that repo. On a received factory, `init` never clones a project that has no shareable `url`. It skips that clone, warns, and names the folder to fill. The command goes on, and `start --dry-run` exits 0.

### Config files

The factory folder holds two config files:

- `factory.yaml` is shared. Git tracks it, and it goes to every machine. It holds the node, the board (`tracker`), the session settings, the limits, and the recipe with its projects.
- `factory.local.yaml` is private. Git ignores it, and it has mode 600. It holds the owner, the proxies, the settings of a worker, the mode of each approval point (`approval`), the links to other nodes (`parent` and `children`) and the local source of a project (`sources`).

Each file has its own `schema` key. A key stays private only if it is personal, a credential, or true for one machine only. The shared file refuses a private key, and the error names the key and the private file. A proxy entry in `factory.yaml` fails the load, and `start` makes no tmux call.

`init` writes the private file with mode 600. `start`, `init`, `node` and `upgrade` set a mode with group or other read bits back to 600 and print a notice. They stop with exit code 4 when the file has a group or other write bit, has another owner, or is a link. `doctor` and a dry run only warn about read bits. With `factory.yaml` and no `factory.local.yaml`, `start`, `doctor` and `node` exit with code 2 and name `init`.

### The setup text

The setup text is `setup/coordinator.md` and `setup/roles/worker.md`. Write your own text there and not in the managed files, because only the setup folder travels.

`init` and `upgrade` render your setup texts. The text of `setup/coordinator.md` goes into the block `setup` of `coordinator/CLAUDE.md`, after the other blocks. The text of `setup/roles/worker.md` goes into the block `setup-worker` of `.factory/roles/worker.md`. A file that is absent or empty renders no block. A file that is larger than 65536 bytes, that holds a control character, or that holds a marker line of a managed block stops the command with exit code 1 and changes nothing. `factory doctor` warns about text outside the managed blocks that the setup files do not hold.

The setup text goes into the instructions of a session, so it needs your acceptance:

- When `init` makes a new factory and writes the setup files itself, it accepts the hash of its own text in the same run, after the entry in the factory list, with or without a terminal window. It prints the files, the hash, the folder, the node id and the reason. If the write of the acceptance fails, `init` still succeeds, prints a warning, and names `factory init` in a terminal window. A setup file that was there before the run is not accepted this way; `init` warns and names the same command.
- `start` and `upgrade` need your acceptance of the setup text. With no acceptance at all, they exit with code 4 and name `factory init` in a terminal window. After a change, they show the change and ask (the default is no) in a terminal window outside a factory session, and a yes renders the setup block again from the accepted text.
- In a dry run, in a factory session, or with no terminal window, they ask nothing, write nothing, and exit with code 4 with the line that names the command, also with `--yes`. `doctor` fails with the same line and never accepts.
- On a received factory, the acceptance covers every other file that the config repo tracks, too.

### Start a factory

```sh
factory start --dry-run
factory start
factory start --yes
```

`start` starts a tmux session with the id of the node. It works from the factory folder, from `coordinator/` and from a project clone. The coordinator runs in the window `view`, in the folder `coordinator/` of the factory folder. If that folder is missing, its safety block is missing, so `start` exits with code 4 and names `factory upgrade --overwrite safety`. The session option `@factory_home` and the variable `FACTORY_HOME` name the factory folder. The coordinator runs in auto permission mode, with one `--add-dir` for the state folder `.factory/` and one for each project. There is no `--add-dir` for the top of the factory folder. It runs with the `PATH` of the shell that ran `start`, not the `PATH` of a tmux server that started before. The window `workers` is empty.

The coordinator never inherits `ANTHROPIC_BASE_URL` from the shell. Its proxy comes only from the config, and only when it answers. The shells of the slot and of the worker window get no `ANTHROPIC_BASE_URL` either: `start` removes it from the environment of the session, and from no other session. `start` also sets `FACTORY_SESSION` to the node id in the environment of the session, so the shells of the slot and of the worker window carry it like the coordinator does.

`start` also makes sure that `coordinator/.claude/settings.local.json` holds the last-seen hook and the status line wrapper (`factory hook EVENT` and `factory hook statusline`). It prints the exact change and the file first, then it asks (the default is no) in a terminal window. It keeps every other key of the file, and it names a status line that it replaces. `--yes` is the yes outside a factory session. With no terminal window and no `--yes`, `start` writes nothing, starts nothing and exits with code 2. Inside a factory session, `--yes` gives no consent, so the exit code is also 2. If you answer no, `start` goes on without the hook and prints one line: factory has no last-seen record of the coordinator, so a restart or a reboot can not resume the session by its id. To add the hook later, run `start` again and answer yes. When the entries are in place, `start` asks nothing and writes nothing, and the file gives no warning. `--dry-run` shows the change and writes nothing. A link at `.claude/` or at the file, or a real path outside `coordinator/`, stops `start` with exit code 4. A file that is not a JSON object stops it with exit code 1 and stays as it is.

A second `start` starts no second coordinator. It attaches to the session. If the program of the coordinator has ended, `start` says so and names the commands that remove the session and start it again. `--dry-run` prints the tmux calls and starts no session. `start` counts a `factory.yaml` only at a registered factory (see "Find the factory folder"). So a `factory.yaml` that a cloned repo holds never starts a session.

### Child nodes

A node on layer 2 can have child nodes on layer 1. A child address is a `file://` address on this machine. Other addresses are refused.

```sh
factory node add-child ../api-factory
factory node children
factory node remove-child api-factory
```

On layer 1, `add-child` exits with code 2: the children of a coordinator are workers. A child on the wrong layer, a folder that is no node, a child folder that is this factory folder or holds it, and a child with the id of this node exit with code 1 and name a remedy. A child that is a child already gives a warning and changes nothing.

### Doctor

`factory doctor` runs 25 checks. It exits with code 1 when a check fails, and with code 4 for the stops that this README names. It checks the config files, the state, the managed blocks, the secrets, the proxy settings, the tools and the projects. Version 0.1.0 ran 11 checks. These 14 checks are new:

- `local-file`: the mode, the owner and the type of `factory.local.yaml`.
- `root`: the factory folder is the top folder of its own git work tree and holds an intact share list. This is a warning.
- `temp-folder`: a temp folder that a stopped `init` left. This is a warning.
- `index`: the factory list lists the factory folder, and each listed folder exists. This is a warning.
- `setup-text`: text outside the managed blocks that the setup files do not hold. This is a warning.
- `roles`: the layer has a role template.
- `tracker`: the kind of the board. A kind other than `local` warns, because its connector comes later.
- `children`: the child nodes.
- `root-repo`: what the config repo tracks, and what git ignores.
- `root-files`: the tracked text files hold no value that looks like a token (a failure), no `file` URL and no path of a user folder (warnings).
- `project-paths`: each project folder is inside the factory folder and is not a reserved name.
- `delegations`: the mode of each approval point, and the points with the mode `delegated`.
- `instruction-files`: the instruction files of agents in the factory folder and above it.
- `project-urls`: a project with no URL that you can share is a warning.

`doctor` warns about each temp folder that a stopped `init` left. It removes nothing.

### Upgrade a factory

```sh
factory upgrade --dry-run
factory upgrade
```

`upgrade` migrates a node of version 0.1.0 (schema 1) to this version. It writes `factory.yaml` (schema 2) and `factory.local.yaml` (schema 1) from the values of the old file. A comment of the old file does not stay. It renames `lanes` to `workers` and `node.role` to `node.layer`, and it moves the empty list `projects` under `recipe.projects`. It moves `.factory/protocol.md` to `.factory/roles/worker.md` and `.factory/briefs/` to `.factory/orders/`. It replaces `.factory/roadmaps/README.md` with the new text when the file is still the text that version 0.1.0 wrote. If you edited that file, `upgrade` keeps it and prints a warning. It adds `tracker.kind: local`. If `children` in `factory.yaml` has entries, `upgrade` stops and changes nothing, because the children of a node on layer 1 are workers. Remove the entries and run `upgrade` again. To manage other nodes, set `node.layer` to 2 after the upgrade, and add the nodes with `factory node add-child`. If `projects` in `factory.yaml` has entries, `upgrade` also stops (exit code 1) and changes no file, because a project of version 0.1.0 sits outside the new folder and has no clone URL. Make the factory again with `factory init`, and give each repo with `--project`.

`upgrade` follows the registration check (see "Find the factory folder") with one exception. A node of version 0.1.0 is not in the factory list. `upgrade` counts such a folder when you name it with `--home` and its `factory.yaml` has schema 1. In a terminal window, it shows the folder and the node id and asks whether to upgrade and register it; the default is no. With no terminal window, add `--yes`. With `FACTORY_SESSION` set, `upgrade` exits with code 4 and writes nothing, also with `--yes`. A dry run asks nothing and writes nothing.

`upgrade` moves the `CLAUDE.md` of the factory folder to `coordinator/CLAUDE.md` when that file holds managed blocks. It makes the folder `coordinator/`, and it keeps your own lines in the file. A `CLAUDE.md` with no managed block stays where it is. If `coordinator/CLAUDE.md` exists already, `upgrade` stops with exit code 1 and changes nothing. Move or remove one of the two files, then run `upgrade` again. `upgrade` makes no check of the place of the factory folder. `factory doctor` warns when the factory folder is not the top folder of its own git work tree, or when `.gitignore` has no intact share list.

`upgrade` writes the share list into the `.gitignore` of the factory folder. It writes the part between the two marker lines again, and it keeps every line that you added outside the part. A `.gitignore` with no marker lines gets the part at its top, and its old lines stay below it. A marker line with no pair stops `upgrade` with exit code 1 and changes nothing, also in a dry run. When the factory folder holds no `.git`, `upgrade` also makes it a git repo, the config repo, with one commit of the shared files: `.gitignore`, `factory.yaml`, and `setup/` when it exists. If git has no identity, `upgrade` makes the repo and no commit, and it prints a warning. A factory folder that holds a `.git` keeps its repo, and `upgrade` makes no commit there. If a step fails, `upgrade` removes the repo that it made. `upgrade` writes no file in `setup/`: a node of version 0.1.0 has no setup text, so it needs no acceptance. To add setup text, write `setup/coordinator.md` or `setup/roles/worker.md` yourself, then run `factory init` in a terminal window to accept it.

`upgrade --dry-run` makes the new text of each file and checks it, so it reports the errors that the real run reports.

`upgrade` renders a block again when its text differs from the text that the package and your settings give. The owner prefix of `factory.local.yaml` is in the `safety` block. The context limits of `factory.yaml` are in the `coordinator` block. A block that you edited stays as it is, with a warning that names `factory upgrade --overwrite <block>`. `doctor` names the same command. The block `setup` is the exception: its text comes from the setup file, so `doctor` warns and names the setup file, and `upgrade` puts back the text of that file and keeps the edited text in a backup file (see below). A block that an earlier `upgrade` kept under its old name, for example `protocol`, stays under that name until you name it. `upgrade` and `doctor` find it under that name and name the flag.

`start` checks the `safety` block of `coordinator/CLAUDE.md` before it launches anything. The block must equal the text that the package renders for your config, the effective mode of each approval point and your owner prefix. If the block is intact but another text is current (a new package version, a new prefix, a changed mode), `start` renders it again, prints a notice and goes on; with `--dry-run` it writes nothing and says so. If a person edited the block (its text does not match the hash in its marker), or the block is missing or its markers do not parse, `start` exits with code 4 and `doctor` fails. Both name `factory upgrade --overwrite safety`. `start` also exits with code 4 when `coordinator/` or `coordinator/CLAUDE.md` is a link.

`init`, `upgrade` and `doctor` stop with exit code 4 when `factory.local.yaml` is a link. `init` and `upgrade` also stop with exit code 4, and write nothing, when `setup/`, `setup/roles/`, a setup file, `coordinator/`, `coordinator/CLAUDE.md`, `.factory/`, `.factory/roles/worker.md` or `.factory/backups/` is a link. Replace the link with a plain file. A factory folder under a linked parent folder works: only a link below the factory folder stops the command. A folder that the factory list does not list is no factory folder: a copy inside another factory folder, inside a git work tree, or above a project is such a folder. `upgrade` stops there with exit code 4 and writes nothing, also in a dry run.

`upgrade` backs up `factory.yaml`, `CLAUDE.md` (the old place), `coordinator/CLAUDE.md` and `.factory/` to `.factory/backups/<timestamp>/`. The backup leaves out `.factory/state/` and `.factory/locks/`: they hold run-time data, and `upgrade` never changes them. It restores the files when a step fails. It never replaces a managed block that you edited, unless you name it. An edited safety block stops `upgrade` with exit code 4. Any other edited block stays as it is, with a warning that names the flag. To replace such a block with the template text, name it:

```sh
factory upgrade --overwrite coordinator
```

`upgrade` keeps the last 5 backups. After a successful upgrade it removes the older ones. A folder in `.factory/backups/` whose name is not a timestamp stays. If a step fails, `upgrade` removes no older backup.

When `upgrade` replaces a block that was edited (a block that you name with `--overwrite`, or the block `setup`), it first writes the old text of the block to a new file `.factory/backups/<timestamp>-block-<name>.md`, mode 600, and names the file. The write never replaces a file and never follows a link: a file or a link at that path stops the command with exit code 4. `upgrade` keeps the last 10 of these files and removes the older ones after a successful run. `--overwrite safety` is for the owner: with `FACTORY_SESSION` set it exits with code 4 and writes nothing, also with `--yes` and in a dry run.

If `factory.yaml` or `CLAUDE.md` is a link to a file, the backup holds a regular file with the content of the target. If the backup itself fails, `upgrade` removes the backup folder that it made and changes nothing else.

`upgrade` makes one commit in `.factory/` with the files that it writes or moves, and no other file. It runs no git hook for that commit. Before it changes anything, it stops when `.factory/` has a staged change, or a change in a file that the upgrade changes. Commit that change, or put the file back, and run `upgrade` again. If git reports an error after it wrote the commit, `upgrade` keeps the new files and tells you how to check the commit. After a successful upgrade, `upgrade` writes the factory folder into the factory list, as `init` does. A problem with the list is a warning.

## The factory folder

```
<workspace>/
  web/                      the old folder of the repo. It stays as it was.
  web-factory/              the factory folder. It is a git repo of its own, the config repo.
    factory.yaml            the shared config. You edit it. The repo tracks it.
    factory.local.yaml      your private settings. The repo does not track it.
    .gitignore              the share list: it ignores everything but three paths
    setup/coordinator.md    your text for the coordinator. The repo tracks it.
    setup/roles/worker.md   your text for every worker. The repo tracks it.
    coordinator/CLAUDE.md   the role of the node (managed blocks) and your text. The repo does not track it.
    web/                    the clone of the project web. The repo does not track it.
    work-copies/            the folder for work copies. The repo does not track it. `init` does not make it.
    .factory/               the state. It is its own git repo.
      node.json             the factory marker: the schema version and the versions of the blocks
      roles/worker.md       the worker role (layer 1 only)
      orders/               assignments
      board.json  waiting.json  decision-log.json
      decision-profile/  roadmaps/
```

The factory folder is the top folder of its own git work tree. A project clone is a git work tree inside it, and the share list ignores it. The factory folder holds no instruction file: the coordinator runs in `coordinator/`. A worker runs in a work copy of a project, so it never reads the instructions of the coordinator.

## Words

`factory help words` explains each word. In short: a node has a layer and an owner. Layer 1 is the coordinator of the workers. A recipe is the kind of work that a factory does, and a setup is one named way to run it. An assignment is a written task for a worker or a child node. A work copy is a separate copy of a project folder for one worker. The factory list is a file for your user that lists each registered factory and the path of its folder.

## Managed blocks

`init` writes text blocks between markers in `coordinator/CLAUDE.md` and `.factory/roles/worker.md`:

```
<!-- factory:begin NAME vN sha256=HASH -->
...
<!-- factory:end NAME -->
```

The hash lets `factory` find out that a person edited a block. Text outside the markers is yours. `factory` keeps it.

## Safety defaults

Only a check at a security boundary stops a command. A stop exits with code 4. It prints one line with the reason and one line with the command that fixes it. Every other check is a warning: the command goes on with exit code 0, and `doctor` shows the warning. A command that can not run at all exits with code 1 or 2.

- The permission mode is `auto`. `doctor` fails, and `start` stops with exit code 4, when a Claude settings file skips the permission prompts, sets or clears a variable whose name starts with `FACTORY_` in `env`, or sets the proxy or the credential of the session in `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_CUSTOM_HEADERS`). The checked files are the settings files in the `coordinator/` folder, in each project folder and at every path that the config repo tracks. A settings file in the `coordinator/` folder or in a project folder also stops `start` when it runs a command (a hook, a status line or a key helper). The hook and the status line that `factory` writes itself do not count, and a settings file that holds exactly those entries gives no warning that it is there. In the factory folder itself, a setting that runs a command is a warning. `doctor` fails, and `start` stops with exit code 4, when the check can not finish: git fails, a settings folder holds more than 64 settings files, or a settings file can not be read. `doctor` and `start` warn about a rule that allows a whole tool (for example `Bash` or `*`) and about a setting that approves project MCP servers. A health check goes to a proxy only when no check of the factory folder fails.
- The config repo must not track `factory.local.yaml`, the state folder or the `coordinator/` folder, and git must ignore the local file and the state folder. `doctor` fails, and `start` stops with exit code 4, when one of these rules is broken, or when a tracked text file holds a value that looks like a token. A received factory also needs the setup acceptance of all its tracked files: `start` stops with exit code 4 and names `factory init` in a terminal window.
- An agent loads instruction files from its working folder and from every folder above it. `doctor` warns, under the check `instruction-files`, when the factory folder or a folder above it (at most 64 levels) holds `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `.claude/CLAUDE.md`, `.claude/rules`, `.claude/settings.json`, `.claude/settings.local.json`, `.github/copilot-instructions.md` or `.cursor/rules`. `start` and `init` print the same warning before they act. The check only tests that a path exists. A folder that it cannot read gives a warning too. It never looks inside `~/.claude`, so it cannot see the instructions of the user level.
- A proxy comes only from the config. `doctor` prints `Config: <path>` first. It checks that the proxy answers when the config passes the registration check (see "Find the factory folder"), also when it comes from a parent folder, from `FACTORY_HOME` or from the factory list. A `factory.yaml` that does not pass the check, for example one in a clone of a repo, stops `doctor` with exit code 4 before any request. A stray `ANTHROPIC_BASE_URL` in the shell is a warning.
- The proxy host receives the API traffic of the coordinator. Use only a proxy that you control.
- By default, merges and releases wait for the owner (see "Approval points").
- `doctor` fails when a value in `factory.yaml` or a tracked text file of the factory folder looks like a token. It names the files and never prints the value.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings keep exit code 0. |
| 1 | The command failed, or a check failed. |
| 2 | The command line is wrong, or the command finds no factory folder. |
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

The integration tests and the exit check use `dist/factory.js`, so run `npm run build` first. Some integration tests need tmux 3.0 or newer, and skip with a note when tmux is missing. The exit check makes the tarball of the package and installs it in a throw-away `HOME`. Then it runs `init` in a repo whose https origin a local bare repo serves. It runs `start --dry-run` and `doctor` from the factory folder, from the coordinator folder and from the clone. Last, it searches the generated files and the help text for names that must not be there. It never writes the real `HOME`, the real state folder or the real tmux server.

`npm run check:docs` checks that the design documents agree with each other.

## License

MIT
