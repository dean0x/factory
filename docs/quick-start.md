# Quick start for early access

This guide takes you from the hand-over of a build to your first worker. It covers the early-access builds of factory 0.2.0.

Each step names its place:

- **A terminal window outside the factory session.** Use a normal terminal window. Do not use a pane of the tmux session that `factory start` makes.
- **The factory folder.** Make it the current folder, then run the command.
- **Ask the coordinator.** Type the request in the pane of the coordinator.

In the examples, `~/work/web` is your own project repo. `~/work/web-factory` is your own factory folder. `v0.2.0-ea.N` is the tag of your hand-over, and N is a number.

## 1. What early access is

Factory is in early access. It is not on the npm registry. Do not install it from the registry.

The code is in the private GitHub repo `dean0x/factory`. The owner marks each build with a private annotated tag. A tag has the form `v0.2.0-ea.N`.

The owner pushes a tag only after the owner decides to hand it over. A tag has no GitHub Release, and nobody publishes the package. The owner never moves, deletes or reuses a tag. A fix gets the next number.

Each build prints `0.2.0` for `factory version`. The version does not tell the builds apart. The tag and its commit tell them apart.

The owner gives you a hand-over for each build. It holds the tag name and the full commit SHA that the tag points to. Keep both. You need them to install, to update and to report a problem.

## 2. What you need

Run each check in a terminal window. Each check must show the result in the last column.

| You need | Check | The check shows |
| --- | --- | --- |
| macOS, Linux, or Windows with WSL | `uname -s` | `Darwin` or `Linux` |
| Node.js 22 or newer | `node --version` | `v22` or a higher number |
| git | `git --version` | a version number |
| tmux 3.0 or newer | `tmux -V` | `tmux 3.0` or a higher number |
| Claude Code 2.1.224 or newer | `claude --version` | `2.1.224` or a higher number |
| An npm prefix that your user owns | `npm prefix --global` | a folder that your user owns |
| The GitHub CLI, logged in | `gh auth status` | that you are logged in to github.com |
| SSH access to GitHub | `ssh -T git@github.com` | a message with your GitHub user name |
| Read access to the factory repo | `git ls-remote git@github.com:dean0x/factory.git HEAD` | one line |
| Read access to each project repo | `git ls-remote <url> HEAD` | one line |

Native Windows does not work. Every command exits with code 1 and says to use WSL.

Factory sessions talk to each other with the cross-session messages of Claude Code (`SendMessage`). These messages need Claude Code 2.1.224 or newer.

**Your own login and subscription.** Use your own Claude Code account on your own subscription. Use one login on this machine. The plan must allow auto mode, because factory starts all its sessions in auto mode. This guide gives no command for this check. Start `claude` in a terminal window. Read the account and the plan that it shows. If you can not tell, ask the owner before you go on.

## 3. Credentials

Never use `sudo` for a command in this guide. Use a Node install that your user owns, for example one that a Node version manager made. Then `npm install --global` writes only in folders of your user.

Choose one path to GitHub.

**Path A: an SSH key.** Run this once, in a terminal window:

```sh
ssh -T git@github.com
```

The first time, ssh shows the host key fingerprint of github.com and asks if you trust it. Compare the fingerprint with the list "GitHub's SSH key fingerprints" on docs.github.com. Answer `yes` only if the fingerprint is on that list. If it is not on the list, answer `no` and tell the owner.

**Path B: no SSH key.** Use HTTPS with the GitHub CLI, in a terminal window:

```sh
gh auth login
gh auth setup-git
```

`gh auth login` asks you to log in. Keep the default place where gh stores the token. `gh auth setup-git` makes git use gh for the credentials of github.com. Then use the `git+https` URL in part 4.

Never put a token in a URL. Never write a token in a command or in a file.

## 4. Install

Use the tag and the full commit SHA of your hand-over.

**Step 1. Check the tag.** Place: a terminal window, in any folder.

```sh
git ls-remote git@github.com:dean0x/factory.git 'refs/tags/v0.2.0-ea.N^{}'
```

The command must print one line. The `^{}` makes git show the commit that the tag points to. The SHA at the start of the line must equal the full commit SHA of the hand-over. Compare all 40 characters.

If the command prints no line, or prints a different SHA, stop. Do not install. Tell the owner.

On Path B, use `https://github.com/dean0x/factory.git` in place of `git@github.com:dean0x/factory.git`.

**Step 2. Remove an earlier link.** Do this step only if you used `npm link` for factory before. Place: a terminal window, in any folder.

```sh
npm rm -g @dean0x/factory
```

This step is a clean-up. It removes the link and keeps the clone that the link pointed to.

**Step 3. Build and install.** Place: a terminal window. First make a new empty folder and go into it:

```sh
cd "$(mktemp -d)"
```

Then run this pair of commands in that folder:

```sh
npm pack "git+ssh://git@github.com/dean0x/factory.git#v0.2.0-ea.N"
npm install --global ./dean0x-factory-0.2.0.tgz
```

npm can not build the program in a one-step global install from git. So this guide builds a package file first, and then installs that file.

On Path B, use `"git+https://github.com/dean0x/factory.git#v0.2.0-ea.N"` in the first command.

The first command builds the program from source. It takes some seconds, and a minute or more on a slow network. If the build fails, the command stops with an error. Never install from a branch.

**Step 4. Check the result.** Place: a terminal window, in any folder.

First, look at the list under `Tarball Contents` that `npm pack` printed. It must hold `dist/factory.js`. Second, run this command:

```sh
factory version
```

It must print `0.2.0`. If a check fails, stop and tell the owner. An install can succeed and still leave no `factory` command, when the build did not run.

If your shell does not find `factory`, check that the folder `bin` inside the output of `npm prefix --global` is in your PATH.

### Scripts that the install runs

The `npm pack` command runs the build script of factory. It also runs the install scripts of the build tools. npm takes the build tools from the npm registry. These scripts run with the rights of your user. Do not count on `ignore-scripts=true` to stop the build of this command.

If you do not want to run these scripts before you read the code, use the clone path. Place: a terminal window, in a folder for your clones.

```sh
git clone git@github.com:dean0x/factory.git
cd factory
git checkout v0.2.0-ea.N
git rev-parse HEAD
```

The last command must print the full commit SHA of the hand-over. If it does not, stop and tell the owner. Read the code. Then run these commands in the clone:

```sh
npm ci
npm run build
npm link
```

The `npm ci` command also runs the build script and the install scripts of the build tools. The clone path gives you the time to read the code first.

### The installed commit

The installed program does not record its commit. See part 12. Keep the tag and the full commit SHA of the hand-over.

## 5. Make your factory

Place: a terminal window outside the factory session, in your project repo.

```sh
cd ~/work/web
factory init
```

In a terminal window, `factory init` shows the factory folder that it proposes and asks you to confirm. For a project repo, the proposal is a folder beside the repo, for example `~/work/web-factory`. The command clones the project repo into that folder.

The command also asks for the mode of each approval point. Keep the default, `owner`. Then the work waits for you. After its last write, the command shows a change to the Claude Code settings of the coordinator and asks. Read the change, then answer.

Place: the factory folder.

```sh
cd ~/work/web-factory
factory doctor
```

`factory doctor` checks the factory, its config and its state. It exits with code 1 when a check fails. Fix each failure before you go on.

To give your factory to another person, see [Share a factory](../README.md#share-a-factory).

## 6. Start

Place: a terminal window outside the factory session, in the factory folder.

```sh
cd ~/work/web-factory
factory start
```

`factory start` starts the tmux session of the factory and attaches your terminal window to it. The coordinator is a Claude Code session. It runs in the window `view`. If `init` did not write the hook settings of the coordinator, `start` shows the change and asks.

To see the tmux calls first, run `factory start --dry-run`. It starts no session and changes no file.

A second `factory start` does not start a second coordinator. It attaches to the session.

## 7. Move in tmux

Factory sets no tmux key and no prefix. The default keys work. A personal tmux config can change them.

The session has two windows:

- The window `view` has the coordinator in the left pane and the board slot in the right pane.
- The window `workers` has one pane for each worker. It is empty until you make a worker.

Use the names of the windows, not their numbers.

The prefix is `Ctrl-b`. Press it, release it, then press the key:

| Key after the prefix | What it does |
| --- | --- |
| Arrow keys | Select the pane in that direction. |
| `o` | Select the next pane. |
| `n` | Go to the next window. |
| `p` | Go to the previous window. |
| `w` | Show the window tree. Choose a window by its name. |
| `z` | Zoom the pane to the whole window. Press it again to zoom out. |
| `[` | Enter copy mode. You can scroll back in the pane. |
| `q` | Leave copy mode. |
| `d` | Detach from tmux. The sessions do not stop. |

After `factory start`, your terminal window is inside tmux. Some commands must run outside the factory session. For these, press `Ctrl-b`, then `d`, or open a second terminal window. To come back, run `factory start` again.

## 8. Make the first worker

A worker is a Claude Code session in its own work copy of one project. The factory session must run, so run `factory start` first.

**Step 1. Write the assignment.** Place: the factory folder. Make a plain text file under `.factory/orders/`, for example `.factory/orders/assignment-1.md`. Write in it what the worker must do. The file can have at most 1 MiB.

**Step 2. Make the worker.** Place: a terminal window outside the factory session, in the factory folder.

```sh
cd ~/work/web-factory
factory worker new alpha --project web --assignment .factory/orders/assignment-1.md
```

`alpha` is the ID of the worker. Choose a short name. `web` is the ID of a project. The list of projects in `factory.yaml` holds the IDs.

The command makes a work copy on the new branch `worker/alpha`, and a pane in the window `workers`. It asks before it writes the Claude Code settings of the work copy. The flag `--yes` gives the yes with no question.

You can also ask the coordinator to make the worker. The coordinator has no terminal window to answer the question, so the command needs `--yes`. Inside the factory session, `--yes` counts only when the work copy has no settings file. If the command stops, run it yourself in a terminal window.

## 9. Status, stop and resume

Place: the factory folder, or ask the coordinator.

```sh
factory status
factory worker list
factory worker stop alpha
factory worker resume alpha
```

`factory status` shows each worker with its state, its work item and its idle state. `factory worker list` shows each worker with its pane, its state and its context percent. If a state is `waits`, a dialog waits for an answer in the pane of that worker.

`factory worker stop alpha` ends the program of the pane and closes the pane. `factory worker resume alpha` starts a stopped worker again in a new pane. It continues the earlier conversation only when the last-seen record belongs to that worker.

## 10. Dismiss a worker

Dismiss a worker when its work is pushed. Place: the factory folder.

```sh
factory dismiss alpha
factory dismiss alpha --yes
```

The first command is a dry run. It prints the steps and changes nothing. Read it. It works in the factory session, so the coordinator can run it.

The second command frees the worker. It ends the pane, removes the work copy and deletes the record. It stops with a line that starts with `STUCK:` when the work is not pushed. The branch `worker/alpha` stays.

The flag `--yes` works only in a terminal window outside the factory session.

## 11. Update

**Step 1. Push the work.** Place: the pane of each worker, or ask the coordinator. The reboot in Step 5 stops every worker. Ask each worker to push its work. A dry run of `factory dismiss ID` prints a line that starts with `STUCK:` when the work is not pushed.

**Step 2. Find the new tag.** The owner gives you the new tag and its full commit SHA. To list the tags, run this command in a terminal window:

```sh
git ls-remote --tags git@github.com:dean0x/factory.git
```

To compare two tags, use the compare view on GitHub. Or use a clone of the factory repo, and run these commands in it:

```sh
git fetch --tags
git log <old-tag>..<new-tag>
```

**Step 3. Install the new tag.** Do Step 1 to Step 4 of part 4 again, with the new tag. Start with the `git ls-remote` check. Use a new empty folder. If you used `npm link` before, run `npm rm -g @dean0x/factory` first.

On the clone path, run these commands in the clone instead. The command `git rev-parse HEAD` must print the full commit SHA of the hand-over. The link to the clone stays, so you need no new `npm link`.

```sh
git fetch --tags
git checkout v0.2.0-ea.N
git rev-parse HEAD
npm ci
npm run build
```

Claude Code runs `factory hook` from the settings of each session. After the install, the live sessions use the new program for the hook at once.

**Step 4. Upgrade the factory.** Place: a terminal window outside the factory session, in the factory folder.

```sh
factory upgrade --dry-run
factory upgrade
```

The first command shows what would change and changes no file. The second command migrates the config and the state, and refreshes the managed blocks.

**Step 5. Reboot.** Place: a terminal window outside the factory session, in the factory folder.

```sh
factory reboot
```

The command stops every worker and starts each one again with its session id. Outside the factory session, it also ends the tmux session and starts it again. It prints the command that attaches.

## 12. Known limits

- **No board yet.** The right pane of the window `view` is a plain shell.
- **Work items.** `factory status` shows `unknown` as the work item of each worker, and `no` as its idle state. So `factory dismiss --idle` lists nothing.
- **Authority of the owner.** A message between sessions carries no authority of the owner. To give a worker the authority of the owner, type in its pane. Start the text with the owner prefix. The prefix is in `factory.local.yaml`.
- **devflow.** Factory has no devflow setup yet. If you want devflow, install it as a normal Claude Code plugin.
- **The installed commit.** No `npm ls` form shows the commit of an install from a package file. The command `npm ls --global @dean0x/factory` shows the version only. Every build prints `0.2.0` for `factory version`. Keep the tag and the full commit SHA of the hand-over, and give both in a problem report. The command `git ls-remote` shows the commit that a tag has now. It does not show the commit that you installed.
- **The npm version.** The install commands of this guide were tested with npm 10.9.8.

## 13. Report a problem

Tell the owner:

- The tag and the full commit SHA of your hand-over.
- The command that you ran, and the text that it printed.
- The output of `factory version` and `factory doctor`. Place: a terminal window, in the factory folder.
- The output of `node --version`, `npm --version`, `claude --version` and `tmux -V`.

Remove each token and each key from the text before you send it.
