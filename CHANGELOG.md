# Changelog

## 0.2.0 (not released)

Renames

- The word `lane` is now `worker`. The word `pack` is now `recipe`. One named way to run a recipe is a setup, and its config key is `recipe.variant`. The word `brief` is now `assignment`. The tmux pane option is `@worker`.
- The state folder `.factory/briefs/` is now `.factory/orders/`. The file `.factory/protocol.md` is now `.factory/roles/worker.md`, and its managed block is `worker`.
- The config key `lanes` is now `workers`. The key `node.role` is now `node.layer`. The key `pack` of a project is now `recipe.variant`.
- Text that a user reads uses the plain words of `docs/glossary.md`: factory folder, factory list, work copy, assignment, worker window and terminal window. `factory help words` prints the words of the program.

File formats

- `factory.yaml` has schema 2. The new file `factory.local.yaml` has schema 1. See "Config files" below.
- The projects are in `recipe.projects`, and `recipe.id` names the recipe. A project has a `path`, which is one folder name in the factory folder, and an optional `url`, which is the clone URL. New keys: `tracker`, `approval`, `sources`, `parent` and `children`.
- The first `.factory/board.json` of a new factory has the key `queue`. Version 0.1.0 wrote the key `merge`. `upgrade` does not change a board file that exists. No command reads the file yet.
- The factory list `homes.json` holds the node id, the folder, the project paths and the origin of each factory. The origin is `own` or `received`.

Config files

- The factory folder holds two config files. `factory.yaml` is shared: git tracks it, and it goes to every machine. `factory.local.yaml` is private: git ignores it, and it has mode 600.
- The shared file holds the node, the board, the session settings, the limits and the recipe with its projects. The private file holds the owner, the proxies, the settings of a worker, the mode of each approval point, the links to other nodes and the local source of a project.
- The shared file refuses a key of the private file. The error names the key and the private file. A proxy entry in `factory.yaml` fails the load.
- `init` writes the private file with mode 600. `start`, `init`, `node` and `upgrade` set a mode with group or other read bits back to 600 and print a notice. They stop with exit code 4 when the file has a group or other write bit, has another owner, or is a link. `doctor` and a dry run only warn about read bits.
- With `factory.yaml` and no `factory.local.yaml`, `start`, `doctor` and `node` exit with code 2 and name `init`.
- The only board is `local`. The other kinds parse, and `doctor` warns that their connector comes later.
- A node link (`parent` and `children`) accepts only a `file://` address on this machine. An `ssh://`, `https://` or relative address is refused.
- `factory` refuses a config file, a state file or a factory list file of more than 1,048,576 bytes. It does not read the rest of such a file. This holds for the config of a child that `doctor` and `node children` read.

The factory folder

- The factory folder is a git repo of its own, the config repo. It tracks `factory.yaml`, `.gitignore` and `setup/`. `init` makes the first commit.
- The `.gitignore` holds the share list between two marker lines. It ignores every other path. `upgrade` writes the part again and keeps the lines that you add.
- The coordinator runs in `coordinator/`, and `coordinator/CLAUDE.md` holds its role. The top of the factory folder holds no instruction file, so a worker never reads the text of the coordinator.
- `init` clones each project into a folder of the factory folder. The path of a project is one folder name. The names `coordinator`, `work-copies`, `setup`, `factory.yaml`, `factory.local.yaml`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md` are reserved, in any letter case. `work-copies/` is the folder for the work copies of workers. `init` does not make it.
- Two text files hold your own text: `setup/coordinator.md` and `setup/roles/worker.md`. `init` and `upgrade` render them into `coordinator/CLAUDE.md` and `.factory/roles/worker.md`. The repo tracks the two setup files and does not track the two rendered files.
- If a stopped `init` left a temp folder `.factory.tmp-<pid>` in the factory folder, the next `init` and `doctor` name the folder and say that you can remove it by hand. They remove nothing.

`init`

- `factory init` proposes a folder. In a git work tree, it proposes a new factory folder beside the repo: `../<repo>-factory`. In a folder that holds git repos, it proposes a folder inside it: `./<folder>-factory`. It asks in a terminal window. `--yes` uses the proposal. With no terminal window and no `--yes`, it prints the proposal and exits with code 2.
- `init` clones the repo, or each repo, into the factory folder as a project. The old folder stays as it was, and `init` warns that it keeps the work that is not pushed. A folder that is a linked work tree of a listed repo is skipped, and `init` names it.
- `init` stops with exit code 1 for a factory folder inside a folder that the factory list holds. A factory folder can sit beside another one.
- New flags of `init`: `--yes`, `--layer N`, `--recipe ID`, `--project PATH|URL`, `--name ID`, `--owner-name NAME`, `--owner-github LOGIN` and `--approval POINT=MODE`.
- `--approval POINT=MODE` sets the mode of one approval point of the recipe. The mode is `owner` or `delegated`, and the default is `owner`. In a terminal window, `init` asks for each point that no flag names. `--yes` writes `owner` and refuses a flag that asks for `delegated` (exit code 2). A `delegated` choice with no terminal window, or inside a factory session, exits with code 4 and writes nothing.
- `--project` takes a path of a git work tree or a clone URL. A URL makes `init` clone the repo into the factory folder, in a folder with the name of the repo. A URL with a leading `-` is refused.
- `init` makes every check that needs no cloned project before it clones. If a later step fails, `init` removes the clones that it made and the empty folders that it made above them. It never removes a folder that was there before.
- `init` writes the factory folder into the factory list as its last step. If that fails, `init` exits with code 1, removes only what the run made, and prints no success line. A second `init` then works.
- A clone that takes longer than 300 seconds stops with a message that names the limit and suggests an ssh agent or `gh auth login`.
- `init` writes the `url` of each project from the origin of its repo, without credentials, and warns when the origin held some. A repo with no origin, or with a `file` URL, gets no `url`. Its local folder goes to `sources` in `factory.local.yaml`, and `init` and `doctor` warn that the factory cannot be shared with that repo.
- The commits of `init` and `upgrade` in the state repo and in the config repo run no git hook.
- A second `init` in a registered factory folder asks for each approval point again. This is how you change a mode later. It renders `coordinator/CLAUDE.md` again when a mode changes.
- If `init` cannot write the record of an approval point, it still succeeds. It prints a warning that names the point and the remedy, and the point counts as `owner`.

The factory list and the registration

- `init` writes the factory folder into the factory list: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json`. The list is never under `~/.claude`. The check resolves links, and on macOS it ignores the case of letters.
- The list file has mode 600, and its folder has mode 700. `factory` refuses a list file or list folder that another user owns or that a group or other user can write. The error names the path.
- Two `init` runs at the same time both keep their entry. A lock file `homes.json.lock` beside the list lets one run write at a time. A run tries 20 times, 50 ms apart, then stops with an error. A lock older than 5 seconds is taken over.
- When the list holds 200 factories, `init` first drops the entries whose folder has no config file. It keeps an entry whose folder it cannot check.
- A `factory.yaml` counts only at a factory folder that `init` registered: the list has an entry for the folder, the id of the entry is the `node.id` of the config, and the factory marker `.factory/node.json` is valid. If not, `start`, `doctor`, `node` and `upgrade` exit with code 4. They name the file, the reason and one remedy. The check holds for the walk up from the current folder, for `--home` and for `FACTORY_HOME`.
- A command finds the factory folder from the factory folder, from `coordinator/` or from a project clone. The order is `--home`, then `FACTORY_HOME`, then the nearest `factory.yaml` above the current folder, then the factory list.
- A command that finds no factory folder exits with code 2 and prints a hint. Version 0.1.0 exited with code 1.
- The `index` check of `doctor` warns when the factory list does not list the current factory folder.
- A received factory is a factory folder that you cloned from the config repo of another person or machine. `init` in it clones the projects, registers the folder and asks for your personal values, the mode of each approval point and the acceptance of the setup text. Then `start` works. A moved factory is a factory folder that is at another path now. `init` registers it again. A move ends each delegation, so each point counts as `owner`.
- The setup text needs your acceptance. `init` accepts the text that it wrote itself on a new factory. On a received factory, the acceptance covers every other file that the config repo tracks, too. After a change, `start` and `upgrade` show the change and ask in a terminal window outside a factory session. Otherwise they exit with code 4 and name the command.
- To share a factory, add a remote to the factory folder and push: `git remote add origin <url>`, then `git push -u origin main`. The work state in `.factory/` stays on its machine until FAC-M3.

`start`

- New command `factory start`. It starts a tmux session with the id of the node, with the windows `view` and `workers`. The coordinator runs in `coordinator/` in auto permission mode, with one `--add-dir` for `.factory/` and one for each project. There is no `--add-dir` for the top of the factory folder.
- The coordinator does not inherit `ANTHROPIC_BASE_URL`. The shells of the slot and of the worker window get none either. The coordinator gets the `PATH` of the shell that ran `start`. `start` sets `FACTORY_SESSION` to the node id in the environment of the session.
- The pane of the coordinator stays when its program ends at once. If a start step fails after the session is gone, `start` says so and tells you to run `claude` in the shell to read its error.
- A second `start` starts no second coordinator. If the program of the coordinator has ended, `start` warns, names the commands that remove the session and start it again, and adds `coordinatorEnded` to the JSON output.
- `--dry-run` prints the tmux calls and starts nothing. `start` works with a semicolon at the end of the factory folder, of a project folder or of the PATH.
- `start` checks the `safety` block of `coordinator/CLAUDE.md` first. It renders the block again when the block is intact and the current text differs. It exits with code 4 when the block is edited or missing, or when `coordinator/` or `coordinator/CLAUDE.md` is a link, also in a dry run.
- `start` exits with code 4 and starts no session when a check of the factory folder fails. The checks are in "Security" below.

The last-seen hook and the settings write

- New command `factory hook EVENT`, for Claude Code and not for people. For `SessionStart`, `UserPromptSubmit`, `Stop` and `PreCompact`, it writes one last-seen line (session id, event, time and context percent) to `.factory/state/heartbeat/<session>`. It exits with code 0 and prints nothing to stdout on every path. It reads its input for at most 2 seconds, writes nothing for an input that is not valid or not whole by then, and never opens the transcript path.
- New command `factory hook statusline`, the status line wrapper that `start` and `init` write to the settings. It records the context percent (`context_window.used_percentage`, else the input tokens of `context_window.current_usage` divided by `context_window.context_window_size`) in the last-seen line, then prints the output of the command in `session.statusline` of `factory.local.yaml` as it is. The command gets the same input and 2 seconds. At the limit, every process that the command started stops. A SIGTERM, SIGHUP or SIGINT of the wrapper stops them too, and the wrapper exits with code 0. A SIGKILL of the wrapper can not be caught and leaves them running. With no command, or with a command that fails or takes too long, it prints `context N%`, and `context ?%` when the input gives no percent or is not whole after 2 seconds. It always exits with code 0, prints at most one line on stderr, writes only for a session that passes the checks of the hook, and never opens the transcript path.
- The hook and the status line wrapper write the last-seen line under a lock file in the same folder, `<session>.lock`. A writer reads the line again inside the lock, so a write never puts back older data. It waits 300 ms at most for the lock, and then it writes nothing: that update is skipped, and the next event or refresh sets it again. A lock file older than 2 seconds is taken over. A lock file that is a link stops the write, and the hook still exits with code 0 and prints one line on stderr.
- `factory hook EVENT` and `factory hook statusline` ignore a broken pipe on stdout and on stderr (the error EPIPE), so a pipe that Claude Code closes early does not give exit code 1 and a stack trace. Any other error on these streams is not ignored.
- `start` makes sure that `coordinator/.claude/settings.local.json` holds the hook for each event and the status line wrapper. It prints the exact change and the file first, and it asks in a terminal window (the default is no). New flag `start --yes` agrees with no question. It keeps the other keys of the file, and it names a status line that it replaces.
- With no terminal window and no `--yes`, `start` writes nothing and exits with code 2. Inside a factory session, `--yes` gives no consent, so the exit code is also 2, also in a terminal window. Run the command outside the factory session, or answer the question without `--yes`. An answer of no goes on without the hook, and `start` prints one line that names the effect: no last-seen record, so a restart or a reboot can not resume the session by its id. Run `start` again and answer yes to add it.
- A second `start` finds the entries in place, asks nothing, writes nothing, and the file gives no warning. `start --dry-run` shows the change and writes nothing.
- A `.claude` folder or a settings file that is a link, or whose real path is outside `coordinator/`, stops `start` with exit code 4 and nothing is written. A file that is not a JSON object stops it with exit code 1 and stays as it is. The write never touches the settings folder of Claude Code in your user folder.
- Claude Code saves its permission rules in the same settings file, also while a question waits. After your answer, `start` and `init` read the file again. If the file is the same, or the new text gives the same change that you saw, they write the change on the new text and keep what Claude Code saved. If the new text gives another change, they write nothing and exit with code 1. Run the command again then.
- `init` makes the same check for the hook settings as `start`, on a new factory, a received factory and a registered one: `coordinator/.claude/settings.local.json` holds the hook for each event and the status line wrapper. It prints the exact change and the file first, and it asks in a terminal window after its last write and after the question about the setup text (the default is no). `--yes` agrees with no question. A second `init` finds the entries in place and asks nothing.
- Breaking for scripts: with no terminal window and no `--yes`, `init` writes nothing and exits with code 2, before its first write, when the hook settings need a write. A script that ran `init` with no terminal window needs `--yes` now. Inside a factory session, `--yes` gives no consent, so the exit code is also 2, also in a terminal window. Run the command outside the factory session, or answer the question without `--yes`.
- An answer of no goes on without the hook, and `init` prints one line that names the effect and the way to add the hook later: run `init` again and answer yes. A received factory keeps its stop: with no terminal window, `init` stops on a received factory that tracks setup text or other files, also with `--yes`.
- The `safety` block no longer names the folder of the Claude Code files of the user. No file of the program opens that folder, and a test holds its name out of every template.

`upgrade`

- `factory upgrade` migrates a node of version 0.1.0 in one step. It writes `factory.yaml` and `factory.local.yaml` from the values of the old file. A comment of the old file does not stay. It moves the files, renames the managed block, backs up first, and restores the files when a step fails.
- `upgrade` moves `CLAUDE.md` to `coordinator/CLAUDE.md` when the file holds managed blocks. It writes the share list into `.gitignore`. When the folder holds no `.git`, it makes the config repo with one commit of the shared files. It writes no file in `setup/`. After the upgrade of a node of version 0.1.0, `factory doctor` passes.
- An edited block stays as it is, with a warning that names `factory upgrade --overwrite <block>`. An edited `safety` block stops `upgrade` with exit code 4. When `upgrade` replaces a block, it keeps the old text in a backup file in `.factory/backups/`.
- `upgrade` replaces `.factory/roadmaps/README.md` with the new text when the file is still the text that version 0.1.0 wrote. If you edited the file, `upgrade` keeps it and prints a warning. The JSON output lists the file in `replaces`, with the action `replace` or `keep`.
- `upgrade` commits only the files that it writes or moves in `.factory/`. It stops before any change when `.factory/` has a staged change, or a change in a file that the upgrade changes. When a step fails, it clears from the index only the paths that it staged. If git reports an error after the commit was written, `upgrade` keeps the new files and says how to check the commit.
- After a successful upgrade, `upgrade` records the factory folder in the factory list, as `init` does. A problem with the list is a warning.
- The backup holds a regular file with the content of the target when `factory.yaml` or `CLAUDE.md` is a link to a file. If the backup fails, `upgrade` removes the backup folder that it made.
- `factory upgrade --dry-run` makes the new text of each file and checks it, so it reports the errors that the real run reports. The JSON output names the old name of a renamed block in `blocks[].renamedFrom`.
- A node on layer 1 with entries in `children` stops the migration and changes nothing, because the children of layer 1 are workers. A node of version 0.1.0 that lists a project stops it too (exit code 1): make the factory again with `init`. The message gives the remedy.

`doctor`

- `factory doctor` runs 25 checks. Version 0.1.0 ran 11. The new checks are `local-file`, `root`, `temp-folder`, `index`, `setup-text`, `roles`, `tracker`, `children`, `root-repo`, `root-files`, `project-paths`, `delegations`, `instruction-files` and `project-urls`.
- `delegations` shows the mode of each approval point. A `delegated` mode with no matching approval record warns, and the point counts as `owner`.
- `instruction-files` warns when the factory folder, or a folder above it, holds a file that an agent loads as an instruction.
- `project-urls` warns for a project that has no URL that you can share.
- The checks `blocks` and `tools` know the new rules. The `permission-mode` check reads the settings files of the session folders and does not read the settings folder of Claude Code in your user folder.

Roles, layers and nodes

- The role of a node comes from its layer. Layer 1 has the coordinator template. Layer 2 has the manager template. A layer above 2 has no role template yet: `coordinator/CLAUDE.md` holds the safety block only, `init` prints a warning, and `doctor` warns.
- New commands `factory node children`, `factory node add-child PATH` and `factory node remove-child ID`. A child must be one layer lower, and its id must differ from the id of this node. `add-child` refuses on layer 1, because the children of a coordinator are workers. The commands keep the comments and the key order of `factory.yaml`.

Platforms and help

- On native Windows, every command exits with code 1 and prints the hint to use WSL. macOS and Linux are the supported systems. `factory start` needs tmux 3.0 or newer and `claude` on the PATH.
- New command `factory help words`. It prints one plain sentence for each word that factory uses. `--json` prints the same list.
- Error messages, hints, the text of an internal error and the question of `init` show a control character as `?`, as the other text output does.

Security

- `start` and `doctor` find a Claude settings file that skips the permission prompts, that sets or clears an `env` variable whose name starts with `FACTORY_`, or that sets the proxy or the credential of the session in `env`, in `coordinator/`, in a project folder or at a tracked path. `doctor` fails and `start` exits with code 4. A settings file in `coordinator/` or in a project folder that runs a command (a hook, a status line or a key helper) stops them too. The hook and the status line that `factory` writes itself do not count.
- A check of a security boundary that can not finish stops `start` with exit code 4, and `doctor` fails: git fails, a settings folder holds more than 64 settings files, or a settings file can not be read.
- The token scan names a tracked file that holds a NUL byte (a binary file or a file in UTF-16) as not scanned. A base64 secret that holds a slash and no plus sign is no longer taken for a path.
- `start` and `doctor` warn about a rule that allows a whole tool and about a setting that approves project MCP servers.
- `init` and `start` exit with code 4 when the config repo tracks `factory.local.yaml`, a path in `.factory/` or a path in `coordinator/`, or when git does not ignore the local file or the state folder. `doctor` reports it.
- `doctor` fails, and `start` exits with code 4, when a tracked text file holds a value that looks like a password or a token. The message names the file and never prints the value.
- A clone URL with a password, a token or a user name in an `https://` URL is refused (exit code 2) before any clone. `init` never writes such a value.
- A project path that is outside the factory folder, or reserved, is refused (exit code 4) before any clone.
- A received factory needs your acceptance of the setup text and of every other tracked file before `start` runs. A tracked link stops the command with exit code 4. A list of tracked files over its cap stops `start` with exit code 4 on every factory, and `init` too on a received factory.
- Only `init` in a terminal window outside a factory session writes the record of a `delegated` approval point.
- `init`, `upgrade` and `start` exit with code 4 for a link, or for a path that resolves outside the factory folder, in `setup/`, in `coordinator/` or in the backup of a block.
- The factory list and the stores of the approval records and of the setup acceptances are files of mode 600 in a folder of mode 700. `factory` refuses a file that another user owns or that a group or other user can write.
- `upgrade --overwrite safety` is for the owner. It exits with code 4 inside a factory session.

## 0.1.0 (not released)

- `factory init` creates a node: `factory.yaml`, `CLAUDE.md` and a `.factory/` state folder with its own git repository. It writes `CLAUDE.md` and `factory.yaml` in one step each. If a step fails, it removes only what it made, and the error names each step that it could not undo.
- `factory doctor` runs eleven checks and exits 1 when one fails.
- `factory upgrade` migrates the config and the state, and refreshes the managed blocks. It backs up first, keeps the last 5 backups, and restores the files when a step fails. The error names each file that it could not restore.
- `factory version` and `factory help`.
- Schemas with a version for `factory.yaml` and `.factory/node.json`, and a migration runner.
- Managed blocks in `CLAUDE.md` and `.factory/protocol.md`. A block that a person edited is never replaced without `--overwrite`.
- A secret scan of the config, and a proxy URL check with a health check.
