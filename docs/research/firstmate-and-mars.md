# firstmate and mars: what factory takes

Status: research · Track: factory-design · Date: 2026-11-02 · Sources: firstmate at `49dc31b`, mars at `ae5f8c4` (read only; line numbers refer to these commits)

**Summary**
1. firstmate is a cloned folder of instructions and bash scripts. It turns one agent session into a supervisor of worker sessions in tmux windows and git worktrees.
2. factory takes 8 firstmate ideas. The most important one is the doorbell inbox: the message goes into a numbered file, and the pane gets only one short constant line.
3. The doorbell inbox gives a record of each message, proof of receipt, and recovery after a crash, a compact or a clear. A typed line and `SendMessage` give none of these three.
4. Communication stays one module inside factory, with one interface (`send`, `deliver`, `report`, `ping`). A separate package waits until a second tool needs it.
5. mars gives a pattern for batch git commands with a count at the end. factory uses it for a small `factory checkout list|status|sync|clean` set for the coordinator. Workers keep their own branch git.

---

## 1. firstmate: what it is and how it works

### 1.1 The parts

firstmate is not an app and not a CLI. The README calls it an "agent distro": a cloned repo with an `AGENTS.md`, skills and helper scripts (`README.md` L36–40). You start an agent tool, for example Claude Code, inside the clone. The session then acts as the "first mate". The person is the "captain" (`README.md` L40).

The main parts are:
- **The first mate.** One supervisor session. The captain talks only to it (`VISION.md` L14). It reads projects but does not change them (`VISION.md` L24).
- **Crewmates.** One worker session per task, each in its own tmux window and its own git worktree (`README.md` L45–46). A ship task ends in a PR or a local merge. A scout task ends in a report at `data/<id>/report.md` (`README.md` L47, L171).
- **Scripts.** About 243 bash scripts in `bin/`. The rule is "scripts own the mechanics, agents own the judgment" (`VISION.md` L32–37).
- **The watcher.** `bin/fm-watch.sh` is a bash loop. It polls every 15 seconds (`FM_POLL`, L330) and wakes the first mate only for events that need action (`docs/architecture.md` L13). It costs no tokens while it waits.
- **Two channels.** Up: each worker appends one-line records such as `done: ...` or `needs-decision: ...` to `state/<id>.status` (`bin/fm-brief.sh` L455, L460). The brief says: "Nobody reads this chat" (L551). Down: messages go into `state/<id>.inbox/NNN.msg` files (section 3).
- **The home.** Private state lives in a home folder that `FM_HOME` selects. The code stays in the clone (`docs/configuration.md` L19–30).
- **Optional secondmates.** A secondmate is a full firstmate in its own home, as a child of the main one (`docs/architecture.md` L371–380).

### 1.2 Example flow: a task, a steer, a report

1. The captain types: "fix the flaky login test" (`README.md` L133).
2. The first mate writes a brief with `bin/fm-brief.sh` into `data/<id>/brief.md` (`bin/fm-brief.sh` L2–3).
3. `bin/fm-spawn.sh` makes a worktree and starts a worker in a new tmux window. The launch exports `FM_TASK_INBOX`, the path of the worker's inbox (`bin/fm-spawn.sh` L2–3, L417).
4. The worker works. It appends `working: ...` lines to its status file.
5. The captain adds: "also add a test for the timeout case". The first mate runs `bin/fm-send.sh <id> <text>`. The script writes `state/<id>.inbox/002.msg` and types one constant doorbell line into the worker's pane (`bin/fm-send.sh` L1–3, L20–27).
6. The worker reads the doorbell, lists its inbox, acts on `002.msg`, and moves the file to `handled/` (`bin/fm-brief.sh` L476–478).
7. The worker opens the PR and appends `done: PR ready ...` to its status file.
8. The watcher sees the new status line and wakes the first mate. The first mate tells the captain: "PR ready for review" (`README.md` L139).
9. The captain says "merge it". The first mate merges through the configured merge authority (`VISION.md` L26).

---

## 2. The 8 ideas that factory takes from firstmate

Build effort is rough: S is less than one day, M is one to three days. Token figures are rough estimates for the coordinator context.

| # | Idea | How firstmate does it | Why factory takes it | Build | Run-time tokens |
|---|---|---|---|---|---|
| 1 | Code root and private home are separate | Code in the clone; `state/`, `data/`, `config/`, `projects/` under `FM_HOME` (`docs/configuration.md` L19–30) | An upgrade of the package never touches state (design §4.3) | S, mostly done in FAC-M1 (`--home`, walk-up) | 0 |
| 2 | Durable inbox plus one-line doorbell | `bin/fm-send.sh`, `bin/fm-task-inbox-lib.sh` | Long text, proof of receipt, survives restarts (section 3) | M (writer, sequence lock, ack, re-ring in the watcher, tests) | Sender: from 4–6k to under 1k per message. Receiver: about 0.5k plus the body |
| 3 | Node identity markers and a one-line registry entry per child | `.fm-secondmate-home` marker and `.fm-secondmate-parent` record (`docs/configuration.md` L1198–1201); one line per child in `data/secondmates.md` (`.agents/skills/secondmate-provisioning/SKILL.md` L16–40) | A folder proves what it is; a parent lists children without a scan | S (`node.json` already has `parent` and `children`) | Saves one lookup per use |
| 4 | Explicit list of config items that a parent passes down | One declared list, `FM_INHERITABLE_CONFIG` (`bin/fm-config-inherit-lib.sh` L96). The parent's own launch setting is not on it (L65–68) | Identity, accounts and session settings never leak to a child (design §5.5) | S (one constant, one copy function, one test) | 0 |
| 5 | Script-written upward channel | Scripts publish each outcome that leaves evidence on disk; the model adds only judgment (`docs/secondmate-parent-channel.md` L16–33) | A report must not depend on the model's memory | M (writers at merge, release and decision events) | Parent reads one digest, 1–3k; fewer missed reports |
| 6 | Readiness check before the first use of a remote host | `bin/fm-remote-doctor.sh` gate; an unreachable host is "unknown", never "dead" (`docs/architecture.md` L394; `docs/remote-secondmates.md` L508) | Correct, but remote hosts are out for now | 0 now | 0 now |
| 7 | Fail-closed config parse | A bad value "refuses every spawn"; no fallback to a posture the person did not choose (`docs/configuration.md` L1380–1382) | A wrong default is worse than a stop | S, done in FAC-M1 (Zod) | 0 |
| 8 | Upgrades by fast-forward only; a dirty home is reported, not touched | `bin/fm-update.sh` L28–36: never force, never a merge commit, never a stash | Applies to the `.factory/` state repo and managed blocks | S | 0 |

**Notes.**
- Idea 5: in firstmate, four outcomes never reached the captain on one day, because the mate wrote them in its own chat (`docs/secondmate-parent-channel.md` L10–14). The fix: "the scripts report facts, the mate reports judgement" (L20). A receipt per event stops a double delivery (L36). factory gets this with the cursor of `factory report --since`.
- Idea 8: factory installs from npm, so the rule applies to the state repo. `factory upgrade` stops on a dirty `.factory/` and names the files.
- Placement (D-55): idea 2 is in FAC-M4 with `inbox next` and `inbox ack`. Ideas 3 and 4 are in FAC-M8. Idea 5 is in FAC-M5 (the report core) and FAC-M8 (the rollup). Idea 8 is in FAC-M3. Idea 6 is skipped (F-13). Design §4.8 and the roadmap hold the exit criteria.
- Line numbers in design §4.8 are slightly off at this commit. The bypass default is at `docs/configuration.md` L1370 (design says L1368). The fail-closed text is at L1380–1382 (design says L1376–1378).

---

## 3. The doorbell inbox

### 3.1 How it works in firstmate

The design idea is simple: "the payload moves to the filesystem, which is reliable; the backend endpoint carries only a short constant doorbell line" (`bin/fm-task-inbox-lib.sh` L14–17).

**The record.** `fm-send.sh` writes one file per message into the receiver's inbox folder, `state/<id>.inbox/NNN.msg` (L25–26). The file has a short header and then the exact text. Newlines are allowed (L37–44):

```
schema=fm-task-inbox.v1
at=2026-11-02T10:00:00Z
--
<exact message text>
```

The writer makes a temp file and renames it into place, so a crash never leaves half a record (L229–241). A lock file, `.seq.lock`, gives each message the next number (L27–28, L174–186).

**The doorbell.** The pane gets one constant line (L367):

```
: Firstmate instruction waiting: list "$FM_TASK_INBOX"/*.msg in your '<id>.inbox' steering inbox, read and act on each in numeric order, then mv each into its handled/.
```

Four details make this line safe:
- It is short and its length never changes. A long line wraps, and then the script cannot confirm it in the input box (L349–353).
- It names the inbox through the `FM_TASK_INBOX` variable. So a worker that lost its brief from context can still find the inbox (L345–348).
- It starts with `: `, the shell no-op. If the agent exited and the pane holds a bare shell, the line runs nothing (L354–355).
- Before it types, the script checks the input box. If the box holds someone else's half-typed text, it skips the ring and tries later (L379–384). It never adds text to a human draft.

**Read and acknowledge.** The worker lists `*.msg` files in numeric order, reads each one in full, acts on it, and then moves it to `handled/`. "The move IS the acknowledgement" (`bin/fm-brief.sh` L476–478). While a worker waits for an answer, it does not poll the inbox; a new message rings (`bin/fm-brief.sh` L481).

**Exit code.** For the sender, exit 0 means "the record is written". The question is no longer "did the doorbell land?" but "did the worker act?". The `handled/` move answers that later (`bin/fm-send.sh` L27–33, L49–52).

**Ordering and duplicates.**
- Numbers are never reused, because the next number comes from both the inbox and `handled/`. Two writers at the same time can change the order, but never lose a message (L45–48).
- A second doorbell is harmless: the worker finds the inbox empty (L17–19).
- A local repeated send is a new instruction. A remote send can fail with an unknown result, so the remote path writes "at most once": an exact repeat lands on the same record (L243–253).

**After a crash, a compact or a clear.**
- The records are files, so they survive any end of the session.
- The watcher sees an unhandled record older than 90 seconds and rings again, at most 3 times (`FM_TASK_INBOX_GRACE_SECS`, `FM_TASK_INBOX_RING_MAX`; L50–57, L105–108).
- After 3 rings with no acknowledgement, it raises a "stale" wake to the first mate. A dead or missing pane skips the rings and goes to recovery at once (L20–23).
- A compact or a clear does not restart the process, so `FM_TASK_INBOX` stays set and the next doorbell still works.
- One gap remains. If the worker acts and then crashes before the move, it acts again after the restart. Delivery is "at least once". The worker must treat a repeated record as already done when its result is visible.

### 3.2 Comparison with the current ways

Token figures are rough, for one message of about 300 words.

| Property | `SendMessage` | Typed line (`tmux send-keys`) | File plus typed line (today's long brief) | Doorbell inbox |
|---|---|---|---|---|
| Delivery proof | Confirms delivery to the session; no proof of action | None without a pane capture | The capture shows the line; no proof that the file was read | The move to `handled/` proves processing; no move means a re-ring |
| Survives crash, compact, clear | Not checked; after a clear the text is gone from context | No: input to a dead pane is lost, or goes to a shell | The file survives; nothing marks it unread | Yes: unhandled records stay, and the watcher rings again |
| Record of what was sent | Only in session transcripts | None, only pane scrollback | The file, but not the typed line | Every message is a numbered file; `handled/` keeps the history |
| Long text | Yes | No: long text becomes a paste that Enter does not submit | Yes | Yes, any length, newlines allowed |
| Works for other agent tools | No, Claude Code only | Yes, any terminal tool | Yes | Yes: any tool that reads files and runs one command (firstmate supports 9 tools, `README.md` L62) |
| Owner authority | None, by rule | Yes, with the owner prefix | Yes, with the prefix in the typed line | None by itself. The authority stays in the typed relay line (see 3.3) |
| Tokens per message, sender | About 0.5k plus the body | 4–6k (map, capture, clear, type, Enter, verify; design §3) | 3–5k (write, capture, type, verify) | Under 1k (one `factory cell send` call) |
| Tokens per message, receiver | The body | The body | About 0.5k plus the body | About 0.5k plus the body (list, read, ack) |

### 3.3 What factory changes

- **Owner authority stays in the typed line.** Any process on the machine can write a file into an inbox. So a record alone never carries authority. `factory cell relay` types the owner prefix plus the record number and a short hash of the record. The worker checks the hash before it acts. This matches design §5.5: "factory types only the one-line owner prefix and a pointer to the inbox record".
- **The bell can use more than one channel.** For a Claude Code worker, `SendMessage` can carry the doorbell, so no pane typing is necessary. For other tools, or when `SendMessage` fails, factory types the line. The record is the same in both cases.
- **An acknowledgement command.** factory gives `factory inbox next` (print the oldest unhandled record) and `factory inbox ack <n>`. A plain `mv` also works. A command keeps the format private to factory and gives one exact path for every tool. Both commands are built in FAC-M4 (design §4.12).
- **One format at every level.** The cell inbox and the node inbox of design §4.3 (`.factory/inbox/`) use the same record format with a `schema` field. Decisions from a parent and steers from a coordinator then share one code path.

### 3.4 One module, or a separate CLI or package

Today factory is the only user. A separate package adds a second release pipeline and a second version. factory and the package can then disagree about the format. A public API also freezes before the design settles. The only gain is reuse by another tool, and no such tool exists yet.

**Recommendation: one module.** Put it in one folder (for example `src/comms/`) with one interface: `send`, `deliver`, `report`, `ping`. Nothing outside the folder reads or writes inbox files. Write the record format down as a versioned contract: the contract is the file format, not the code. Split the folder into a package only when a second tool must import it. This follows design §5.3: each transport has the same calls, and new transports come later behind them.

---

## 4. What factory skips from firstmate, and why

| firstmate choice | Source | Why factory skips it |
|---|---|---|
| Workers skip permissions when no config file exists | `docs/configuration.md` L1370: "An absent file defaults to bypass" | factory starts sessions only in auto mode and has no flag that skips permissions (design §6) |
| Config spread over many one-token files | For example `config/claude-permission-mode`, `config/crew-harness`, `config/backend` (`docs/configuration.md` L1357–1382; `bin/fm-config-inherit-lib.sh` L96) | One `factory.yaml` with one schema is easier to read, check and migrate |
| Install by `git clone`, with no versioned release and no migrations | `README.md` L82–88; `VISION.md` L73 | factory ships from npm with a version, and `factory upgrade` runs state migrations (design §4.5) |
| One person only, and a depth cap | `VISION.md` L7 ("exactly one individual"), L38 ("depth is capped") | factory must serve a team, at any depth (design §5) |
| Many backends (tmux, Herdr, Zellij, Orca, cmux and more) | `README.md` L45; 13 adapters in `bin/backends/` | Each backend adds test and upkeep work. factory supports tmux only |
| Remote hosts (whole homes over SSH) | `docs/remote-secondmates.md`; `docs/architecture.md` L374 | Same machine only (F-13). The config refuses any address but `file://` (design §5.3) |

---

## 5. mars: multi-repo git, and `factory checkout`

### 5.1 How mars works

mars manages many git repos as one workspace. It is pure bash (`README.md` L8–23).
- **Config and workspace.** A `mars.yaml` lists repos with a URL, an optional path and tags (`README.md` L76–93). Repos sit under a gitignored `repos/` (`lib/config.sh` L52–59). Every command walks up to find the config, and one guard stops a command outside a workspace (`lib/config.sh` L12–27, L128–134).
- **Clone.** `mars clone` skips repos that exist and shows `(n/total)` (`lib/commands/clone.sh` L57–94).
- **Status.** `mars status` prints one table row per repo: branch, clean or dirty, and ahead and behind counts against the upstream (`lib/commands/status.sh` L36–81; `lib/git.sh` L179–199).
- **Sync.** `mars sync` runs `git fetch` and `git pull` in each repo. It lists repos with conflicts at the end (`lib/commands/sync.sh` L45–92).
- **Branch and checkout.** `mars branch <name>` creates the branch in each repo, or checks it out if it exists (`lib/commands/branch.sh` L67–87). `mars checkout` refuses a dirty repo unless `--force` (`lib/commands/checkout.sh` L74–79).
- **Batch with a count.** Every batch command continues after a failure, counts success, skip and failure, and prints one summary line, for example "Synced 4 repo(s), 1 skipped". It exits 1 if one repo failed (`lib/commands/sync.sh` L94–101; `lib/commands/clone.sh` L96–110).

### 5.2 Workers keep their own branch git

Workers keep their git work on their own branch: commit, push, rebase, and conflict fixes. factory gives them no shared git API. The reasons:
- Each worker owns one checkout and one branch (workspace rule: one leg of work per checkout). Nobody else writes there, so no lock is necessary today.
- A shared git API needs a lock across sessions. It also adds a new failure mode: if the API or its lock is stuck, every worker stops.
- A worker already knows its branch state. A plain `git` call costs it few tokens.
- firstmate makes the same split. The first mate is read-only over projects; workers make every project change (`README.md` L53; `VISION.md` L24).

The coordinator is different. It does the same git bookkeeping over all checkouts many times a day. That bookkeeping is a good fit for fixed commands.

### 5.3 The `factory checkout` command set

Each command reads the projects from `factory.yaml` (the mars walk-up), works on every checkout of every project, continues after a failure, and ends with one count line (the mars batch idea). The default output is a short verdict; `--json` gives the full facts (design §3). Token figures are rough.

| Command | What it does | mars idea it uses | Manual steps it replaces | Before | After |
|---|---|---|---|---|---|
| `factory checkout list` | One row per checkout: project, path, cell (from the cell map), branch, short HEAD | Config walk-up, repo list from config, table output (`lib/config.sh` L12–27; `lib/commands/list.sh`) | `git worktree list` per repo, the pane map, and a look at the board's session map | 2–3 calls, 2–4k | 1 call, under 1k |
| `factory checkout status` | Per checkout: dirty files, ahead and behind the upstream, unpushed commits, branch on the remote or not. Verdict example: `4 checkouts: 1 dirty (web-auth), 2 unpushed (api-cache)` | Status table with dirty and ahead/behind (`lib/commands/status.sh` L54–80) | Start-of-session scan of worktrees and unpushed work | 3–6 calls, 5–10k | 1 call, 1–2k |
| `factory checkout sync <pr\|branch>` | Base update of a waiting PR: fetch once, merge `origin/<default>` into the branch in a short-lived worktree under `.factory/state/`, push, remove the worktree. On a conflict it stops, names the files, and leaves the fix to the owning cell | Fetch then pull with a conflict list at the end (`lib/commands/sync.sh` L58–92) | Switch a checkout back, merge the base, push, switch again | 3–5 calls, 4–8k | 1 call, about 1k |
| `factory checkout clean [--apply]` | For each checkout that no live cell holds and that no board item or resume file names: check that the tip is on the remote, the tree is clean, and the PR is merged; then `git worktree remove`. Dry run by default | Batch that continues after a failure, with a count (`lib/commands/clone.sh` L96–110) | Post-merge cleanup: list, tip check, search of board and resume files, remove | 5–8 calls, 5–10k | 1–2 calls, 1–2k |

**Rough daily effect.** Assume 2 session starts, 3 merges and 2 base updates per day. Today that is about 50k tokens. With the commands it is about 10k.

**Notes.**
- `factory checkout clean` is the same job as `factory clean` in design §3 and §4.2. Keep one command with one owner. Rename the design entry, or make `factory clean` an alias.
- `sync` uses a short-lived worktree, so it never touches the checkout of a cell. Then it needs no lock. A merge (not a rebase) keeps the pushed history, and the repo's merge rule decides the final shape. `gh pr update-branch` is a second option with no local git at all. It is not checked here.
- firstmate's clone refresh is a better model than mars for the safety rules of `sync` and `clean`. It moves only a clean default branch by fast-forward. It reports a dirty, diverged or off-default checkout as `STUCK:` and leaves it untouched (`docs/architecture.md` L529–537). firstmate also never tears down unlanded work (`VISION.md` L53).
- The existing `src/core/git.ts` module already holds git helpers. The new commands extend it; they do not add a second git module.

### 5.4 What factory does not take from mars

- **The `.git` folder test.** Every helper in `lib/git.sh` checks `[[ ! -d "$repo_dir/.git" ]]` (L44, L84, L113, L136, L160, L185). In a linked worktree, `.git` is a file. So `mars status` shows a worktree as "clean" and "synced" whatever its state. factory works mostly with worktrees, so it asks git itself.
- **Unsafe sync.** `git pull` has no `--ff-only` (`lib/git.sh` L144). The fetch result is not checked (`lib/commands/sync.sh` L59). A conflict is found by a text match on "conflict" (L75). factory uses exit codes and `git diff --name-only --diff-filter=U`.
- **Destructive force flags.** `clone --force` runs `rm -rf` (`lib/commands/clone.sh` L75–77). factory never deletes a checkout with dirty or unpushed work.
- **The gaps in design §4.8:** `eval` of user input (`lib/commands/exec.sh` L84), a `version` field that is written but never read (`lib/yaml.sh` L175), no `--json`, only exit codes 0 and 1, and commands registered in three places (`mars` L18–30, L41–50, L93–132).
- **"Parallel operations"** (`README.md` L10). The loops run one repo at a time; only the spinner runs in the background (`lib/ui.sh` L296).
- **Tags.** `factory.yaml` already lists projects, so tag filters add little.

---

## 6. Recommendations

1. Build the doorbell inbox as the only way to send message text to a worker: one numbered record per message, one constant short line in the pane, acknowledgement by a move to `handled/`, and re-rings from the cell watcher. No other path types message text into a pane (design §4.12).
2. Keep owner authority in the typed relay line. The line names the record number and a short hash. A record alone never carries authority.
3. Keep all communication in one factory module with one interface (`send`, `deliver`, `report`, `ping`) and a versioned record format. Make it a separate package only when a second tool must import it.
4. Write upward reports by script at each event (merge, release, decision), as firstmate does. The model adds judgment only.
5. Add `factory checkout list|status|sync|clean` for the coordinator, with mars batch counts and firstmate's fast-forward and `STUCK:` safety rules. Merge `factory clean` into `factory checkout clean`.
6. Leave branch git to the workers. Do not build a shared git API or a lock across sessions.
7. Fix the design §4.8 line references to the firstmate configuration document (L1370; L1380–1382). This PR makes that fix.
8. Before the inbox build, test one open question: can a cell in auto mode read and move files under the node home without a permission prompt? firstmate grants exactly the inbox folder with `--add-dir` for this reason (`docs/configuration.md` L1376–1378).

---

## Claims not checked on the source

- How `SendMessage` behaves when the receiver crashes, compacts or clears. The table uses today's workspace practice only.
- Whether a Claude Code session in auto mode can run `mv` or a `factory` command against the node home with no prompt. firstmate reports a one-time prompt for reads outside the working folders in auto mode since Claude Code 2.1.257 (`docs/configuration.md` L1377). That is firstmate's claim, not a test on this machine.
- How `gh pr update-branch` handles a conflict. The command exists in the installed `gh` 2.88.1; it merges the base by default, or rebases with `--rebase`.
- All token and build-effort figures. They are rough estimates from call counts, not measurements.
- The run-time behavior of both tools. Neither tool was run; every claim comes from code and documents at the named commits.
