# factory roadmap v2 (proposal)

Status: proposal for review · Design: `docs/design.md` v3 · Date: 2026-11-02
This roadmap replaces FAC-M2 to FAC-M7 of the v1 roadmap (D-53). FAC-M0 (design) and FAC-M1 (skeleton CLI, PR #1) are done.
`docs/intent-trace.md` maps each note from Dean to a design section and to a criterion of this roadmap.

## Goal

A team member installs factory on a new macOS or Linux machine. `factory init` and `factory start` give a working node with the `software` recipe and a GitHub board, with no edit to any file. This workspace runs on factory, and its old scripts are retired. The review page of today stays a supported owner view that the owner can choose. It reads the local files. From FAC-M11 it is the `artifact` connector, and no milestone retires it (design §9, TB-5 to TB-7).

## Rules for this roadmap

- Every exit criterion is a command, a test or a script with a pass or fail result. A milestone is done when all its criteria pass in CI or in the named script.
- No criterion is "a decision". A decision that a milestone needs goes under "Decisions needed". The milestone then tests the choice that is built, not the decision.
- One PR per milestone, unless the milestone names a split and its reason.
- The renames and the schema change come first (FAC-M2), because every later milestone uses the new names and the new schema.
- Heavy test runs follow the machine lock rule. CI runs the full suite on an Ubuntu runner and a macOS runner.
- Output rule (saves tokens): the default output of a job command has at most 20 lines, and the verdict is on the first line. A job command is a command that replaces a manual job of design §3. A shared test helper checks this (FAC-M2), and each milestone uses it for its commands. `docs/token-budget.md` gives the size budget of each job.
- Intent rule: each note from Dean has a row in `docs/intent-trace.md`. Before a milestone merges, a check compares the result with every row of that milestone. A row that is not covered blocks the merge, or moves to a named later milestone with a reason.

## Milestones

The build order is FAC-M2, M4, M5, M6, M7, M11, M5b, then M3, M8, M10, M9. D-56 sets this order. D-133 A adds FAC-M5b after FAC-M7, and D-139 B adds FAC-M11 after FAC-M7 and before FAC-M5b and FAC-M3. FAC-M11 holds the one board contract, the board plugins, the `artifact` connector, the local change feed and the epics. FAC-M5b holds the parts of FAC-M5 that the move of this workspace does not need: the release check, `copies sync` and `copies clean`, the extension points for a desk, the acceptance of shared check commands, the token budget script and the usage view. It also holds the board archive (TB-7) and the live board (TB-8 to TB-10). The `artifact` connector of FAC-M11 renders and publishes the review page (TB-5). The release milestone FAC-M10 comes after FAC-M8 and before FAC-M9, because the Goal needs a release path and does not need Jira or Linear. This workspace moves to factory first, with the `local` board. The board contract and the board plugins come right after the move, and the GitHub board plugin follows them. The sections below are in build order.

| Order | Id | Name | Depends on | Design changes (F-n) |
|---|---|---|---|---|
| 1 | FAC-M2 | Names, home, roles and schema 2 | FAC-M1 | F-1, F-3, F-4, F-5, F-10, F-13 |
| 2 | FAC-M4 | Worker control | FAC-M2 | F-7, F-8, F-9, F-12, F-20, F-21 |
| 3 | FAC-M5 | Local board and check commands | FAC-M4 | F-2, F-6 |
| 4 | FAC-M6 | devflow setup | FAC-M5 | F-10, F-16 |
| 5 | FAC-M7 | This workspace adopted (local board) | FAC-M4, FAC-M6 | F-3, F-8 |
| 6 | FAC-M11 | Provider plugins | FAC-M5, FAC-M7 | D-139, D-140, D-141, D-142 |
| 7 | FAC-M5b | Release check, copies sync and clean, usage view, live board | FAC-M5, FAC-M7, FAC-M11 | F-6, F-22, F-23, F-24, TB-8 to TB-10 |
| 8 | FAC-M3 | GitHub board plugin, and the move to it | FAC-M7, FAC-M11 | F-2, F-18, F-19 |
| 9 | FAC-M8 | Layers and team | FAC-M7 | F-4 |
| 10 | FAC-M10 | Release and install | FAC-M3, FAC-M8 | D-45 |
| 11 | FAC-M9 | Jira and Linear plugins | FAC-M3 | F-2, F-19 |

FAC-M11 needs the network for its `artifact` connector, which publishes the review page. FAC-M5, FAC-M7 and FAC-M5b use the `local` board. FAC-M8 can run in parallel with FAC-M3. FAC-M9 can run at any time after FAC-M3.

### Command map

Each command of design §4.2 has one milestone. A command with two milestones names the part of each. A script checks that every command word of the §4.2 blocks has a row here (FAC-M2), and that no row names a desk.

| Command | Milestone |
|---|---|
| `init`, `start`, `doctor`, `upgrade`, `help` (with `help words`) | FAC-M2 |
| `init --tracker --items --decisions --state-from`; `upgrade` rule for a dirty state repo | FAC-M3 |
| `node children`, `node add-child`, `node remove-child` | FAC-M2 |
| `node tree` | FAC-M8 |
| `machine`, `layout`, `self`, `hook` | FAC-M4 |
| `shutdown`, `restart`, `reboot`, `status` (the worker states, the work item, the unused state), `dismiss` (with `--idle`; FAC-M5b names it `--unused`) | FAC-M4 |
| `worker` (new, list, reset, stop, resume, summon, watch) | FAC-M4 |
| `worker relay`, `worker recover` | FAC-M5 |
| `worker adopt` | FAC-M7 |
| `item`, `request`, `queue`, `decide <D-n> <option>` | FAC-M5 |
| `track` (add, list, update) | FAC-M5 |
| `epic` (add, update, list, remove), the option `--epic` of `item add`, `item update` and `item list` | FAC-M11 (the contract); the epic view of the board pane (`item list --follow`) is FAC-M5b |
| `item estimate` | FAC-M5b |
| `item list --follow` (the board pane of the live board, with the estimate mark) | FAC-M5b |
| `worker mark`, `worker list --follow` (the columns of the live board) | FAC-M5b |
| `check`, `pr`, `issues`, `copies` (list, status), `lock` | FAC-M5 |
| `state` (guard) | FAC-M5 |
| `release` (check, verify, scope), `copies` (sync, clean) | FAC-M5b |
| `status` (the digest for the owner), `report` (the digest of one node) | FAC-M5 |
| `status --usage` | FAC-M5b |
| `report` (the rollup over children) | FAC-M8 |
| `recipe` (show, variant), `project` (add, remove, list) | FAC-M6 |
| `adopt` | FAC-M7 |
| `plugin` (test) | FAC-M11 |
| `tracker set artifact`, `tracker set plugin:<package>` | FAC-M11 |
| `decide read` and `watch` for the `local` and `artifact` boards; `start` window `ops` for every kind of board; `doctor` (the check of each board CLI) | FAC-M11 |
| `tracker`, `state` (remote, push, pull), `decide read` and `watch` for the `github` board, `item import` | FAC-M3 |

### FAC-M2: Names, home, roles and schema 2

**Goal.** The code uses the v2 names, the v2 home rule and the schema-2 config, before more code depends on the old ones. A command finds the home from a project folder.

**Scope.**
1. **Renames (F-1, D-59).** In `src/names.ts` and the CLI, the plain words of design §7 replace the words of the setup of today. The protocol text becomes the worker role template (`.factory/roles/worker.md`, block `worker`), and the assignments are in `.factory/orders/`. The tmux pane option becomes `@worker`, and the config key is `workers`.
2. **Factory folder and `factory start` (F-3).** The `init` rules of design §4.3. `factory start` starts the tmux session (node id), the view and workers windows, and the coordinator session in the factory folder. It uses the launch rules of design §4.6: auto mode, `env -u ANTHROPIC_BASE_URL`, the proxy check, `FACTORY_HOME`, and one `--add-dir` per project. `init` refuses a factory folder inside another factory folder.
3. **Role templates (F-4).** `node.layer` replaces `node.role`. Three templates in the `software` recipe: worker (layer 0), coordinator (layer 1), manager (layer 2). A layer above 2 has no template yet. `factory node add-child` with the same-layer rule.
4. **Recipe split in the config schema (F-10).** Schema 2 of design §4.4: the `recipe` block, `workers`, `approval`, `tracker`. The schema 1 → 2 migration of design §4.5. The recipe parses its own block.
5. **Platforms (F-5).** Every command refuses on native Windows with the WSL hint.
6. **One machine only (F-13).** `parent` and `children[].address` accept only `file://` addresses. The transport interface has the `file://` transport with `ping`. The design and this roadmap lose the `ssh://` parts.
7. **Factory list (F-3).** `init` records the factory folder in the per-user factory list of design §4.3. A command with no `--home`, no `FACTORY_HOME` and no `factory.yaml` above the current folder looks for the current folder in the list.
8. **Several repos in one folder (F-3).** The `init` rule of design §4.3 for a workspace folder, and the clone path of `--project URL`.
9. **Plain descriptions (F-1).** `docs/glossary.md` and `factory help words`.
10. **Deny list (O-1, F-2).** The three triage words join the deny list. factory has no review desk of its own in `src/`. The review page stays an owner view outside the core (design §9, TB-5).
11. **Review of the setup code (D-51).** The review of the FAC-M2 PR names the `init`, `upgrade` and `doctor` code.
12. **Output helper and budget file (O-1).** The short-output test helper, and `docs/token-budget.md` with one row for each job of design §3.
13. **Docs check.** `scripts/check-intent-docs.sh`.

**Exit criteria.**
- [x] `npm test` passes. The names test fails on a stray literal, and it finds no word of the setup of today (design §7) in the `--help` output or in the files that `init` writes. The names test also fails when any file under `src/` holds the old pane option, and `names.ts` holds the pane option `@worker`.
- [x] Integration test: `init --yes` inside a git work tree makes `../<repo>-factory` and lists the repo as the first project.
- [x] Integration tests: `init` makes a factory folder inside a git work tree, and that folder is a git repo of its own. `init` exits 1 for a factory folder inside another factory folder, names a remedy and creates nothing.
- [x] Integration test on a separate tmux server (`TMUX_TMPDIR` in a temp folder, the same effect as `tmux -L`) with a fake `claude` on PATH: `factory start` makes the session with the windows `view` and `workers`. The fake records `--permission-mode auto`, no inherited `ANTHROPIC_BASE_URL`, and one `--add-dir` for the state folder `.factory` and one for each project, and none for the top of the factory folder. A second `factory start` starts no second coordinator.
- [x] Unit tests: each role template passes the deny list and has its required sections. `factory node add-child` exits 1 for a child from another layer. `roleForLayer(0)`, `roleForLayer(1)` and `roleForLayer(2)` return worker, coordinator and manager. `roleForLayer(3)` returns no template. `init --layer 3` writes the `safety` block and no role block, and prints a warning. `doctor` warns on a layer-3 node and names the layer.
- [x] Migration test: a node that the FAC-M1 0.1.0 tarball wrote upgrades to schema 2, with `tracker.kind: local`. After the upgrade, `factory doctor` exits 0.
- [x] Unit test with a fake platform `win32`: every command exits 1 and prints the WSL remedy line.
- [x] Unit tests: the config refuses an `ssh://`, `https://` or relative address in `parent` and in `children`, and names the key.
- [x] Factory list, integration test with a temp HOME and a temp `XDG_STATE_HOME`: after `init --yes` in the repo `web`, `factory start --dry-run` from `web/` and from `web/src` finds `web-factory` and exits 0. From a folder that is in no entry, it exits 2 and prints the hint. Two factory folders that list the same project give exit 2 and name both folders. The list file is under `XDG_STATE_HOME`, a static test finds no path under `~/.claude`, and a factory folder that no longer exists is ignored.
- [x] Workspace folder, integration test: a temp folder holds the git repos `web/` and `api/`, and `web-search/` as a linked worktree of `web`. `init --yes` there makes `./<folder>-factory`, lists `web` and `api`, names `web-search` as skipped, and exits 0. `init --home .` there makes the workspace folder the factory folder: the repos in it stay plain folders, the config lists no project, and the command exits 0. With no terminal window and no `--yes`, `init` prints the proposal and exits 2.
- [x] Clone path, unit test with a fake `git`: `init --project https://host/acme/api.git` runs `git clone -- <url> <folder of the home>/api`. A target that exists and has another origin gives exit 1 and names the path. A URL whose repo name has `..` or starts with `-` gives exit 2.
- [x] Glossary test: every term in the list `terms` of `src/names.ts` has an entry in `docs/glossary.md` and in `factory help words`. An entry has at most 25 words. The two texts are equal. The output has no deny-list word.
- [x] The deny-list test has the patterns `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED`. No template and no file that `init` writes contains one.
- [x] Helper test: the short-output helper has three checks: at most 20 lines, a non-empty first line, and a first line of at most 120 characters. It accepts 20 lines. It fails on 21 lines, on an empty first line and on a first line of 121 characters. It does not read the words of the first line. The default output of `factory start` (with no `--dry-run`) and of `node children` passes it.
- [x] `scripts/check-review-scope.sh docs/reviews/fac-m2-review-summary.md` exits 0. It exits 1 when the summary has no section "Setup and upgrade code (D-51 A)", or when that section does not list the six paths: `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/doctor.ts`, `src/upgrade/apply.ts`, `src/upgrade/plan.ts` and `src/upgrade/spec.ts`.
- [x] `scripts/check-intent-docs.sh` exits 0. It exits 1 when one of these checks fails:
  - a design section named in `docs/intent-trace.md` is not a heading of `docs/design.md`;
  - a milestone id of the trace is not named in this roadmap, or a milestone from FAC-M2 up has no heading here;
  - a command word of the §4.2 blocks has no row in the command map, or design §4.2 or the command map has a desk row;
  - the shop-floor table of design §7.1 does not have 11 rows;
  - the parity table of design §8.1 holds a Status that is not `planned`, `done` or `retired`;
  - `docs/token-budget.md` does not have 17 job rows;
  - a file under `docs/research/` holds the whole word `lane` or `lanes`;
  - a file of the docs folder, the README or the CHANGELOG holds a local machine path (check 8);
  - design.md has no heading for core and setup, or none for extension points (check 9);
  - a core part of the design or of the glossary holds a word of the software recipe (check 10): the summary, §4.1, the core commands of §4.2, the table "Rules for every factory" in §6, and the part "Words of every factory" of the glossary.
- [x] `npm run exit-check` passes with the v2 flow: `init`, `start --dry-run`, `doctor`, deny list, and the docs check.

### FAC-M4: Worker control

**Goal.** factory starts, talks to, resets, stops and restores workers, with no read under `~/.claude`. The lifecycle verbs `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` work, and each has a named test.

**Scope.** `worker new|list|reset|stop|resume|summon|watch`, `shutdown`, `restart`, `reboot`, `status`, `dismiss`, `layout`, `machine` and `self reset`. The workers and view windows (F-8). The last-seen hook and the status line wrapper (F-9). Messages between sessions (D-101). The recovery after a machine restart in `start`. The idle setting `limits.idle_after`. The agent setting `session.agent`.

**Messages between sessions (D-101).** The cross-session messages of Claude Code carry the work:
- factory starts each session with a name: the coordinator `<node id>`, a worker `<node id>_<worker id>`. The coordinator sends a task with `SendMessage`. A long task is a file in the assignment folder of the worker, and the message names it.
- factory types only constant lines into a pane (`/clear`, `/compact` for `worker reset` and `self reset`), through `src/comms/` (design §4.12).
- `worker watch` reports what the idle notices of Claude Code do not show: a pane that ended, a worker that waits in a dialog, and a worker that looks stalled.
- A message from another session carries no authority. `worker relay` (FAC-M5) keeps owner authority in typed input.

**Tasks.**
1. **Session-stop test (F-7).** First write the rule for the word "safe" at the top of `docs/session-stop.md` (design §4.11). Then, in a throw-away session, try `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. Try each way twice: on an idle session, and on a busy session (a tool runs and a background agent runs). Write one row for each way and each case into the table. Then `factory worker stop` uses the way that the table marks safe for the case of the worker. Until then, the rule is: stop only an idle session, then `kill -TERM`. This task does not run before FAC-M4 starts.
2. **Fixtures from the real program (F-9).** Capture one payload for each hook event (SessionStart, Stop, PreCompact) and one status line payload from the installed Claude Code. Commit them in `test/fixtures/claude/` with the Claude Code version. If the status line payload has no context percent, name the other source in design §4.6 before the hook is built.
3. The last-seen hook, the status line wrapper and the last-seen reader.
4. Retired: no inbox. The worker reads its assignment folder through `--add-dir`.
5. Messages between sessions.
6. The worker commands, the layout and the recovery after a machine restart.
7. The lifecycle verbs `start` (with the recovery), `shutdown`, `restart`, `reboot`, `status` and `dismiss`, and the setting `limits.idle_after` (shared, default 2h, bound 1m to 24h, read with the interval parser of the config schema).

**Exit criteria.**
- [x] `docs/session-stop.md` has the rule for "safe" before the table, and one row for each way and each case (idle and busy), with the four facts and the verdict. `scripts/check-session-stop.sh` exits 0 only when the rule and all 12 rows are there (a `/quit` row may say "not available"). `factory worker stop` uses the way that the table marks safe for the case: `kill -TERM` for an idle and for a busy session. A test with a fake session checks it. A worker whose session state is not known gives exit 3 and names what runs (test).
- [x] Start, with recovery after a machine restart. Test `resumes the coordinator and each worker with its own session id, and exits 0 with no warning` (`test/integration/start.test.ts`, own tmux server, fake `claude` records `--resume <id>`): start a node with two workers, run `tmux kill-server` for that server, then run `factory start`. The coordinator starts, and each worker resumes with the session id from its last-seen file. A last-seen value that is not a UUID is refused, and a session id for a worker that the state does not know is refused.
- [x] Shutdown. Tests `stops each worker, also one whose session works, clears the mark, ends the session by its name, and leaves a session of another user and its program running` and `exits 4 and keeps a session of the same name that has no home option` (`test/integration/shutdown.test.ts`): a session with the same name and no home option survives, and `shutdown` exits 4.
- [x] Restart. Test `stops one worker and starts it again with its session id, and the other worker keeps its pane and its process` (`test/integration/restart.test.ts`): the other workers keep their panes.
- [x] Status. Tests `lists the state, the work item and the idle state of each worker, in the order of the ids`, `shows a worker as idle when its activity is older than idle_after and the work item is known and has no open work` and `does not show a worker as idle while the board gives it open work` (`test/unit/status.test.ts`), through the builder that FAC-M5 extends. A worker with no activity for longer than `limits.idle_after` and no open work in progress shows "idle"; a worker with open work does not. The work item column shows the current work, so an old worker name is visible.
- [x] Dismiss. Test `dismiss frees a work copy only when its work is pushed` (`test/integration/dismiss.test.ts`): it refuses an unpushed branch, an untracked file and a stale remote ref, keeps the primary clone, refuses a path outside the factory folder, and prints `STUCK:`. Test `dismiss --idle lists the idle workers and refuses a busy worker` (`test/integration/dismiss.test.ts`): the first run lists the idle workers and changes nothing; the owner picks workers on a fake terminal window; only the panes and processes that factory started for those workers end; a session with the same name and another home option keeps running; a busy worker is refused with a remedy line (exit 1); the pick step with `FACTORY_SESSION` set exits 4.
- [x] A received factory starts after one `init` (F-18f, TP-29 extended). Integration test: a fixture config repo is cloned into a temporary folder (the test has its own HOME); `init` with a fake terminal accepts the setup text, clones the projects and registers the factory; then `start --dry-run` and `doctor` exit 0. The fake terminal answers each prompt of design §4.3: the personal values, the mode of each approval point, the setup acceptance and the write of the hook. With no terminal window, `init` stops on a received factory that tracks other files, also with `--yes` (test).
- [x] Work copy outside the factory folder (OD-7). Integration test: a work copy that sits outside the factory folder finds its factory through the common git folder of the clone of its project, and `status` from there exits 0. A folder that is a work copy of no listed project exits 2 and prints the hint.
- [x] Settings in work copies. Before a worker starts in a work copy, the check for a setting that skips permission prompts runs on the settings files of that work copy. A skip setting makes the worker start exit 4 with one remedy line (test).
- [x] Every launch test asserts auto mode, and a proxy only from the config with the check before the launch.
- [x] Fixture tests: each hook payload fixture has a session id and an event name, and the status line fixture has a context percent. The hook parses the fixtures and writes the last-seen line with those values.
- [x] Status line wrapper test: with `session.statusline` set to a fake command that prints a marker, `factory hook statusline` prints exactly the output of that command and writes the last-seen line. With the key unset, it prints `context N%`.
- [x] Settings consent test (fake terminal window and none): `worker new` and `start` print the exact hook and status line change and its target file before any write. With no terminal window and no `--yes`, they write nothing and exit 2. With `--yes`, they write only `.claude/settings.local.json` in the factory folder or the work copy. A test HOME shows that no file under `$HOME/.claude` changes. With `session.statusline` set by the owner, the status line command still prints its output through the wrapper (end-to-end test).
- [x] Static test: no source file opens a path under `~/.claude`, and no template contains such a path.
- [x] Hook state. The managed hook settings hold `Notification` (only for a permission prompt or an input dialog) and `PreToolUse`. The hook writes `Notification` only for the notification types `permission_prompt` and `elicitation_dialog`. `Notification` gives the state `waits`, and `PreToolUse` gives `busy`. `worker list` and `status` show `waits`, and `dismiss` refuses a worker that waits. `factory upgrade` adds the two events to the hook settings of each work copy that holds the hook of factory and to the coordinator settings, with the consent rule of design §4.6 (tests).
- [x] Session names. The worker argument list holds `--name <node id>_<worker id>` once, and the coordinator argument list holds `--name <node id>` once. One function in `src/names.ts` makes both names. The name is not a word of the pane binding, so a pane that an older version started without it still binds (unit tests).
- [x] `worker new --assignment F` copies F to `assignment.md` in the assignment folder of the worker before the launch. Before any write, it refuses: a file outside the factory folder and outside the git work tree of the caller, a link in the path, a path part below its root that starts with a dot (except `.factory/orders/`), `factory.local.yaml`, or a file that changes during the check (exit 4); a path that is not a regular file, a file over 1 MiB, or a file that is not UTF-8 or holds NUL (exit 2) (tests).
- [x] `worker reset <w> --clear|--compact` runs only from the coordinator pane. It refuses each case of design §4.6 "Session reset" with its exit code: a worker that is busy or waits, a state line older than the pane process, hook settings without the new events, a missing `$FACTORY_INBOX/resume.md`, unpushed work, a summoned pane, and a screen that shows a numbered option list. It types `C-u`, the literal command and `Enter` in one tmux run through `src/comms/`. It confirms the reset by `SessionStart` (clear) or `PreCompact` (compact) within 10 checks of 1 s, else exit 3 (fake tmux tests).
- [x] `self reset` runs only from the coordinator pane, which it binds by its start command. It exits 3 and names the file when `.factory/resume/<node id>.md` is missing. It exits 3 when its own state line shows `waits`, or when the coordinator settings lack one of the hook events. With the file, it types `/compact` through `src/comms/` and exits 0 with one line that says the compact runs after the current turn (fake tmux tests).
- [x] `worker watch` checks every 30 s and stops after 40 checks with `NO CHANGE`. A worker with no pane at the start is not a change. It exits at the first change: a pane that ended, is gone or fails the binding, a state line that is no longer valid or no longer owned, the state `waits`, or a busy worker with no event for 15 minutes (`stalled?`). It never types, signals or writes (fake clock test: 40 sleeps of 30 000 ms).
- [x] `doctor` warns on a Claude Code version below 2.1.224 and on a version that it cannot read. It warns on a `crossSessionInbound` value of `hold` or `refuse` and on the default mode `plan`, in the settings files that it reads (project and local only). An unset value is not a warning (tests).
- [x] Static test: only `src/comms/` holds a tmux input verb, in an argument list or a shell text. The typed text is a constant of `src/names.ts`. A typed line over 300 characters, or with a character outside printable ASCII, is refused (unit tests).
- [x] The assignment file and the resume file stay in the assignment folder after `worker reset --clear` and after `restart` (test).
- [x] `worker list` marks a worker at or above `context_prepare_pct` as `PREPARE` and above `context_max_pct` as `MAX`, with fake last-seen values at 29, 30, 40 and 41 percent (no mark, `PREPARE`, `PREPARE`, `MAX`).
- [x] `session.agent: claude` loads. Any other value fails and names the key. A static test finds no start of an agent program except through `session.agent`.
- [x] `machine` tests: fixture files for macOS (`memory_pressure` and `sysctl` output) and for Linux (`/proc/meminfo`, `/proc/loadavg`) give the same verdict format, with a fake platform for each. `worker new` refuses a work copy that another worker uses, and warns (exit 0, the worker still starts) when a resource limit fails or a machine fact is unknown (fake machine facts).
- [x] The job commands of this milestone pass the short-output helper, and `docs/token-budget.md` has a measured size for each of them.
- [ ] GitHub CI on `main` passes on the Ubuntu runner and on the macOS runner, at the merge commit of the FAC-M4 close-out (831c695, #16) or at a later commit. `gh run list --branch main --workflow ci.yml --json conclusion,headSha` shows the run. FAC-M4 moves to Done only after this green run. A local run of the CI steps does not count for this criterion.

### FAC-M5: Local board and check commands

**Goal.** The board, the requests and the decisions work with the `local` board. The merge check and the merge are one command each, with a short verdict. The report of one node exists, so `status` works before FAC-M7.

**Scope.**
1. **Local board (F-2).** The `local` connector (files in `.factory/`; also the test double of later connectors), on the operations that FAC-M11 makes the one connector contract (design §4.10). The commands `item`, `request`, `decide <D-n> <option>` (for `local`; FAC-M3 adds `github`) and `queue`. The decision log and the decision profile tools. The board commit helper and the delete-guard hooks. Every write of a board file goes through the board commit helper.
2. **Check (F-6).** `check`, `pr merge` (with both modes of the approval point `merge` and the proofs of design §6.1), `pr watch`, `issues audit`. The dismiss idle window (M5-2): `dismiss --idle` reads the board again just before each stop, and not once before all stops. M5-1b reads the board once to list the idle workers and once more after the pick, so a worker can get an item after the second read and before its stop. M5-1b states this as a limit.
3. **`factory copies list|status` (D-55).**
4. **Report core.** `factory report` and `factory status` for one node, with no children: worker states, board counts, the items in progress, the requests and the events that scripts write at merge and decision. The release event belongs to FAC-M5b. The rollup over children stays in FAC-M8. `lock run`. The view slot shows `factory item list`.
5. **Proxy host warning.** `doctor` warns when the proxy host is not loopback, because the proxy host receives the API traffic of the node.
6. **Delegation control outside factory (D-10 A).** The session settings that factory renders hold deny rules for the record commands and for the store path of the approval records.
7. **Typed owner input and limit recovery (moved from FAC-M4).** `worker relay` and `worker recover`.
8. **Owner fields on the board (adoption map G-1).** The setup names the owner's own item fields and the allowed values of each, for example a priority, a type, a release flag on a queue row, and the worker. The core has no default field or value; this workspace's values (`P0`, `P1`, `P2` and its type names) come from the sample setup. The connector contract (design §4.10) carries these fields. `item` and `queue` set and show them, and `local` keeps them in its files. FAC-M3 maps each field to a GitHub label or a Projects field.
9. **Standing delegations as records (adoption map G-4).** A standing delegation is a decision record of the owner with a scope and no end time. The scope is one or more action names from a fixed list in `src/names.ts`, for example "reset a worker". `worker relay` names the action, and accepts the delegation for each action inside its scope. A later owner decision ends it (design §6).
10. **Tracks and stages (Dean's direction of 2026-11-08, TB-1 to TB-7).** A track is a named stream of work with its own roadmap, and a worker is not a track. Each item has a stage. The recipe gives the list of stages, and the merge flow (M5-2) and the release flow (FAC-M5b) set the stages that only a flow sets. M5-1b builds the keys `tracks`, `track` and `stage`, `track add|list`, `item move --stage`, `item list --track` and the stage column, and the format promise to the review page (design §4.10). M5-1c builds the follow layout with one block for each track, the counts of closed items, the checked stamp (the time of the last check, drawn every 60 seconds with no new read), the titles of the items of a track that holds more than one item, and the rename and remove of a track.
11. **The review page (TB-5, TB-6).** The review page stays a supported owner view that the owner can choose. It reads the local files, and in M5-1b it only reads. factory always keeps the local board. From FAC-M11 the `artifact` connector renders and publishes the page. A page answer is a board event: it shows and wakes, and records nothing (D-142 A).

**`factory copies` (D-55).** The coordinator's repeated git work across work copies becomes four commands. FAC-M5 builds `list` and `status`. FAC-M5b builds `sync` and `clean`. Workers do their own git work on their own branch.
- `list`: one row per work copy: project, path, worker, branch, short HEAD.
- `status`: for each work copy, the dirty files, ahead and behind, unpushed commits, and whether the branch is on the remote. One verdict line with counts.
- Safety rules from firstmate: a default branch moves only by fast-forward. A dirty, diverged or off-default work copy is reported as `STUCK:` and left untouched. Batch commands continue after a failure and give a count at the end (from mars).
- The commands extend `src/core/git.ts`; there is no second git module.

**Exit criteria.**
- [ ] Board tests run against `local`. FAC-M11 makes them the contract suite, and FAC-M3 runs the suite against `github`.
- [ ] `worker relay` types the owner prefix only for a decision that `factory decide` recorded, or for an action inside the scope of an active standing delegation (test).
- [ ] `worker recover`: the nudge is a native message (`SendMessage`). The answer to the usage-limit dialog comes after the real-run checks of FAC-M4 PR 3: the pointer sign of each dialog, and how a message from another session shows in the receiver.
- [ ] With `local`: `changes read` returns nothing until FAC-M11 adds the local change feed, and `factory decide <D-n> <option>` writes the owner store record, the proof, and a copy of it as a log row with `by: owner`. `factory decide` refuses (exit 4) with no terminal window, and when `FACTORY_SESSION` is set.
- [ ] Decision records for the profile (F-26a). Test: each `factory decide <D-n> <option>` writes one decision record in the format of the decision profile template (the question, the options, the chosen option, `decided_by: owner` and the time) in `.factory/decision-profile/`, and adds its line to the profile log. The coordinator text tells the coordinator to look up these records and the principles before it decides for the owner. A refused `decide` writes no record.
- [ ] `item`, `request` and `queue` change only the `local` files, and every change is one commit in the state repo (test).
- [ ] `init` sets `core.hooksPath`. The board commit helper refuses when the guard is off. The guard hooks refuse a commit that removes an item id from `board.json` (tests).
- [ ] No command needs `python3`, `jq` or `glow` (a test runs the commands with a PATH that does not contain them).
- [ ] `check` gives the same verdict as the manual merge check on 3 merged PRs, from recorded fixtures.
- [ ] `check` exits 3 with `NOT READY` while the PR has an open ask or an open request, and gives `READY` after the item closes (tests).
- [ ] `pr merge` tests with `merge: owner`: it refuses with no owner decision or answered ask for that PR and head; it refuses when the head changed after `check`.
- [ ] `pr merge` tests with `merge: delegated`. There is one test for each proof of design §6.1:
  - (a) a decision with `by: owner`;
  - (b) an ask answered `approve` with `factory decide` (a fake terminal window with no `FACTORY_SESSION`);
  - (c) an approved plan: an ask or decision item that names the plan path and commit SHA, answered `approve` with `factory decide` in the same way.

  Each test runs two times: with a direct assignment, and with an assignment by a second decision. Each run merges.
- [ ] Delegation control outside factory. Test: the session settings that factory renders hold deny rules for the record commands and for the store path, and a test reads the rendered settings. Design §6 keeps the limit text. The deny rules make the gap smaller. They do not close it.
- [ ] `pr merge` refuses, with a message that names the proof that is absent, in these cases:
  - approval with no assignment;
  - a record for another PR or head;
  - a plan file with `Status: approved` in a commit by the owner's account, with no answered ask or decision item;
  - a board comment, label, assignee change or review, from any account, with no `factory decide` record;
  - chat text with no record.
- [ ] Board event tests (design §4.10, §6.1), with a fake connector that gives events with an author. The `github` connector comes in FAC-M3 and runs the same tests.
  - With any account setup, a board event is never a proof: an owner comment `approve`, an assignee change, a `worker:<id>` label and a review are each refused, and the message says that a board event is no proof. A decision from `factory decide` on a fake terminal window with no `FACTORY_SESSION` is accepted, and `pr merge` merges.
- [ ] `copies list` and `copies status` give the right rows and counts on fixture repos with linked worktrees: clean, dirty, unpushed, branch not on the remote. They ask git, never a `.git` folder test.
- [ ] A dirty, diverged or off-default work copy shows `STUCK:`, and no command changes it (test).
- [ ] Report tests: `report --json` has the keys of design §5.4 for a node with fixture workers and no children. `--since` returns only newer events. `pr merge` and `decide` each add one event to `.factory/outbox/`. A static test shows that `status` calls the same builder as `report`.
- [ ] `lock run` tests: with a fake platform `darwin` it uses `lockf`, and with `linux` it uses `flock`. A second run waits and stops at its bound with exit 3. The exit code of the inner command passes through.
- [ ] A tmux test: the view slot pane shows the item titles of a fixture `local` board.
- [ ] Template test: the coordinator role text and the fixed rules follow the approval setting. With `merge: owner`, the text says that every merge waits for the owner. With `merge: delegated`, it names the proofs of design §6.1 and does not say that every merge waits.
- [ ] Unit test: `doctor` warns, with the fix, when the host of a configured proxy is not loopback (`127.0.0.1`, `::1` or `localhost`). It gives no such warning for a loopback host.
- [ ] Tests on a separate tmux server (moved from FAC-M4: no observed failure):
  - `worker new` makes a pane in the window `workers` with the pane option `@worker`;
  - `worker summon` shows the pane in the view slot, and the slot shows the board again after the time;
  - `restart` resumes one worker with its session id from the last-seen file, and the other workers keep their panes.
- [ ] Reboot. Test `reboot stops and starts every worker of this factory` (`test/integration/reboot.test.ts`): after `reboot`, each recorded worker runs again with its session id, through the same resume path as `start`. A session of another factory, a session with the same name and another home option, and a `claude` process outside the factory panes keep running (moved from FAC-M4: no observed failure).
- [ ] Integration test: the hook writes the last-seen line on each event (fake hook input) (moved from FAC-M4: no observed failure).
- [ ] Owner fields (G-1). Contract test against `local`, with a fixture setup that names a priority field and a type field (fixture values from the sample setup, for example `P0`, `P1`, `P2`; a new factory with no setup has no field): `item add` and `item update` store a field value, and `item list` and `queue` show it. A value outside the list, or a field that the setup does not name, fails (exit 2), names the field, and changes no file. A queue row keeps its release flag. FAC-M3 runs the same test against `github`.
- [ ] Tracks and stages (TB-7, M5-1b). Tests: `track add` and `track list` work, and `item add --track` takes a listed id only (another id is exit 2, and the message lists the ids). `item move --stage` keeps the status. `item move` refuses a stage that only a flow sets (exit 2) and names the flow. `item list` shows one line for each track with the counts by stage, a track with one item shows that item, and the output has at most 17 track lines and at most 20 lines. The core source holds no stage word and no flow word.
- [ ] Track views (M5-1c, TB-1 to TB-3). Tests: the follow layout shows one block for each track. `item list` shows the number of closed items of each track and the checked stamp. A track that holds more than one item shows the titles of its items. `track rename` and `track remove` work, and a track guard stands beside the lost-id check.
- [ ] Standing delegations (G-4). Tests: `worker relay` types the owner prefix for an action inside the scope of a standing delegation, and refuses an action outside the scope. A scope with an action name that is not in the fixed list fails (exit 2); a setup file cannot add an action to the list (the list is fixed in the core, for safety). A recorded owner denial always wins: `worker relay` refuses an action that the node recorded as denied, also when a standing delegation covers it (test). After a later owner decision ends the delegation, it refuses the same action. Only `factory decide` in a terminal window outside a factory session writes or ends a standing delegation (exit 4 with `FACTORY_SESSION` set). `doctor` and `start` list each active standing delegation with its scope and time.

### FAC-M6: devflow setup

**Goal.** A project can use the devflow setup of the `software` recipe. The coordinator knows which project uses which setup. The core works with no `software` recipe. A person can share a setup, and the owner accepts every setup file.

**Scope.** `factory recipe show` and `factory recipe variant devflow --project P` (the key `variant` names the setup), the devflow setup file (design §2.2), the worker addendum, the proxy preset with its real values, the `projects` block of the coordinator template (design §5.2), the assignment of `worker new --project P` with the stage commands of the setup of P only, `factory project add|remove|list` (moved from FAC-M4), and a test recipe in the test folder. The shareable setup (design §4.13): the setup files in the tracked `setup/` folder, a priorities rule that a second factory folder shows, and a desk reader as a setup file (design §4.14).

**Owner layer (adoption map G-2, G-9, and Dean's "clay" note).**
- **Owner hooks (G-2).** The setup has a hook list, `setup/hooks`. Each entry names an event (an item change, a decision, a merge or a release) and a setup script. factory runs the script after it writes the event to the event file, with a run-time bound. The owner accepts each hook as a setup file.
- **Neutral core templates (G-9).** The role texts of the package hold no rule of one owner's way of work. The lines of Dean's way of work (design §4.13 lists them) move to a sample setup in `examples/` that a person can copy. The board part of the sample setup, `examples/factory.board.yaml`, is in the package from M5-1b (PR A). The other lines are not there yet. The coordinator role text keeps "Coordinate. Do not produce." as its default (Dean's note), and keeps the use of the decision profile, because the profile is a factory feature.
- **The clay rule.** An upgrade changes only the factory layer: the code, the fixed rules, the blocks that the package renders and the template files that it wrote. It never overwrites the owner layer: the setup files, the owner text outside the blocks, the owner hooks and fields, the principles and records of the decision profile, and the roadmaps. When the owner changed a role block, the setup block or a template file that the upgrade also changes, `upgrade` shows the conflict, and the owner decides. The fixed rules stay outside this rule: an edited `safety` block still stops (design §4.5).

**Exit criteria.**
- [ ] `recipe variant devflow` runs `detect`, offers `install` only after a yes, and writes the setup into the project entry (test with a fake `devflow`).
- [ ] `project add|remove|list` change only `recipe.projects[]`, keep the comments of `factory.yaml`, and refuse a project path that the folder rules refuse (tests).
- [ ] `check` finds devflow's review and resolution markers on a recorded real devflow PR.
- [ ] The core source and the default templates contain no devflow word and none of the three triage words (the deny list test).
- [ ] Coordinator knowledge, integration test: a node with the project `a` (plain) and the project `b` (devflow). The `projects` block of the coordinator `CLAUDE.md` lists both setups and their stage commands. The assignment of a worker of `b` has the devflow stage commands. The assignment of a worker of `a` passes the deny list. `recipe show` prints the same table as the block.
- [ ] Same-layer test: two layer-1 nodes with different project sets have the same managed text, except the `projects` block (a hash compare of the text with that block cut out).
- [ ] Core independence: a dependency test finds no import of `src/recipes/` in `src/core/`, `src/config/` or `src/comms/`. A test recipe `document` (in `test/`, with no git and the output `document`) is registered through `Deps` and passes `init`, `start --dry-run`, `doctor` and `report`.
- [ ] Proxy preset, tests with a stub HTTP server: the preset has the health path `/__subswitch/health` and the port 4141. When the stub answers that path, a worker launches (fake `claude`) with `ANTHROPIC_BASE_URL` set to the stub. When the stub is dead, the launch stops with the fix message and starts nothing. `workers.<id>.proxy: none` wins over `session.proxy: subswitch` of the node.
- [ ] Shareable setup. Test: a setup folder with a priorities rule and a desk reader as a setup file travels in the config repo. A second factory folder made from that repo shows the priorities rule in its coordinator text and runs the reader.
- [ ] Upgrades never overwrite a setup file. Test: `upgrade` leaves every file under `setup/` as it was, also when the package text of the same name changed.
- [ ] Setup acceptance of every setup file. Test: a setup commit that adds or changes a hook, a script, a settings file or a role text makes `start` with no terminal window exit 4, and makes `start` in a terminal window ask, until the owner accepts the new commit in a terminal window. This extends the acceptance of the setup hash from `setup/coordinator.md` (design §4.3) to every setup file. The accept command with `FACTORY_SESSION` set exits 4.
- [ ] Owner hooks (G-2). Test: a fixture hook list with one hook on the decision event. After `factory decide`, the hook script runs once and reads the event on stdin. A hook that the owner did not accept does not run, and `start` and `doctor` name it. A hook that fails prints one warning line that names it, and the exit code of the command does not change. A hook that runs longer than its bound is stopped at the bound and prints the same warning (fake clock or a short bound in the test).
- [ ] Neutral core templates (G-9). Template test: the rendered coordinator and worker role texts and the decision profile format file of a new factory hold none of the lines that design §4.13 lists as Dean's way of work (a fixed list in the test), and the coordinator text holds "Coordinate. Do not produce." A factory with the sample setup of `examples/` shows those lines in its coordinator text and in its worker text. The board part of the sample setup (`examples/factory.board.yaml`) loads through the real config schema from M5-1b, and a test checks it.
- [ ] Clay rule. Upgrade test: the owner edits a block that the package renders, and the new package changes the same block. `upgrade` keeps the owner text, shows the two texts as a diff, and names the two choices: keep the owner text, or take the new text (`--overwrite <name>`, old text to a backup file). With no terminal window, it keeps the owner text and lists each conflict. The same holds for an edited template file, for example the decision profile format file. A second case covers every kind of the owner layer: a fixture factory has a setup file, owner text outside the blocks, an owner hook, an owner field, a principle and a record of the decision profile, and a roadmap. After `upgrade` to a new package, each of these files is byte-equal to its state before. An edited `safety` block still stops `upgrade` and `start` (exit 4), as before (a test for each command).

### FAC-M7: This workspace adopted (local board)

**Goal.** This workspace runs on factory with the `local` board. The old review page and its scripts stay as the owner view until FAC-M11. No milestone retires the page (TB-5).

**Scope.** `factory adopt` (design §8):
- a factory folder next to the projects;
- the move of the coordinator text out of the folder above the work copies. The owner first splits the old `CLAUDE.md` into three files: the owner text (the draft of `setup/coordinator.md`), a runbook, and a list of the parts that factory retires (adoption map, section 5, step 1). `adopt --owner-text <file>` moves only the owner text, not the whole `CLAUDE.md`;
- the import of the board and the items that wait for the owner into the `local` board files;
- the approval point `merge` set to `delegated` by the owner, and the devflow setup for the devflow projects;
- workers in the window `workers`, and `session.statusline` set to the status line command of the owner;
- one worker run through the real Subswitch;
- `factory worker adopt <name>`, which moves an outside session into a tmux pane (moved from FAC-M4).

The import into GitHub issues is not here: it is FAC-M3.

**Owner view.** The review page and its scripts of today stay in use until FAC-M11. They read the `local` files, which have the same format. The owner answers in the page as a board event: the answer shows and wakes, and records nothing (D-142 A). The owner enters the decision with `factory decide <D-n> <option>` in a terminal window outside any factory session. FAC-M7 does not retire the scripts. From FAC-M11, the `artifact` render gives the page, and FAC-M3 retires the old render and board scripts. No milestone retires the page (TB-5). The page of this workspace reads a factory board only after FAC-M7.

**Exit criteria.**
- [ ] `factory adopt --dry-run` prints the plan, and a test checks it against a fixture copy of the workspace. The plan shows the move of the coordinator text.
- [ ] Split owner text. Test on the fixture workspace with a fixture owner text: after the adopt, `setup/coordinator.md` holds the owner text, and the rendered coordinator text holds no line of the fixture `CLAUDE.md` that the owner text leaves out. With no `--owner-text`, `adopt --dry-run` stops (exit 2) and names the split step.
- [ ] The adopt imports the fixture board and the fixture owner items into the `local` files with no loss: a test compares the item ids and titles before and after. The same test checks that the owner's other files arrive unchanged in the owner layer (design §8 step 3): the decision profile (principles and records) in `.factory/decision-profile/`, the roadmaps in `.factory/roadmaps/`, the runbook and the retire list in `setup/` (a byte compare of each file), and the board conventions as the owner fields of the setup (a compare of the field names and values).
- [ ] After the adopt, `factory doctor` exits 0 in the new factory folder, and the coordinator runs there.
- [ ] Old worker names. When this workspace moves to factory, each old worker gets a name from its current work item, and `status` shows no worker whose name and work item differ (test).
- [ ] `scripts/check-worker-paths.sh` walks from each work copy to the root. It exits 1 and names the path when a `CLAUDE.md` on the way has a `factory:begin coordinator` block or the sentinel line of the old Orchestrator file. It exits 0 on the adopted fixture workspace, and it exits 1 on the fixture before the adopt.
- [ ] Owner view: `scripts/check-owner-view.sh` runs the old render scripts against the `local` files of the adopted fixture and exits 0. The output has every fixture item id. After `factory item move`, a second run shows the new state.
- [ ] Owner answer: a pty test runs `factory decide D-1 B` in a shell outside any factory session. Then `factory request list`, run with `FACTORY_SESSION` set as the coordinator does, shows D-1 answered with `by: owner`. `factory decide` with `FACTORY_SESSION` set exits 4.
- [ ] `scripts/check-parity.sh FAC-M7` exits 0: every due row of the parity table (design §8.1) is `done` or `retired`.
- [ ] The worker status line shows the output of the command named in `session.statusline` (fixture command, test).
- [ ] `scripts/subswitch-run.sh` starts one worker of this workspace through the real Subswitch. It exits 0 only when the health check passed and the last-seen line arrived. The output is saved in `docs/reviews/fac-m7-subswitch-run.md`.
- [ ] After the adopt, `tmux kill-server` and `factory start` restore every worker with its saved session id (a recorded run on this workspace).
- [ ] The coordinator merges 5 PRs through `factory check` and `factory pr merge`.

### FAC-M11: Provider plugins

**Goal.** Every board connector speaks one versioned contract, and a user adds a board connector as an npm package, called a board plugin (D-139 B, D-140). The `local`, `artifact` and `github` connectors use the same interface as a plugin. The board holds the truth: a write goes to the board first, and the local board is the cache and the `local` connector (D-141 B). This milestone also adds the `artifact` connector, which renders and publishes the review page, the local change feed, so `watch` works with every kind of board, and the epic record (TM-14). Design §4.10 has the board rules, and design §4.15 has the plugin rules. Community documents and examples for plugin authors wait for FAC-M10 (D-49).

**Scope.**
1. **Loader (D-140).** A board plugin is an npm package that exports the contract. The user installs it with npm and names it in `factory.local.yaml`, never in the shared file. Factory loads it in its own process. There is no accept command, no hash and no child process. Factory checks three things before the load:
   - the name is a valid npm package name;
   - the real path of the package is inside the folder that `npm root -g` prints. Factory finds this folder once, at `tracker set`, and keeps it for the node;
   - the `package.json` of the package names the contract id. Factory reads this file before the load, so no plugin code runs before the check.

   The remedy text of each stop says that the install is a trust decision.
2. **Contract.** The contract id is `factory.board/v1`. The operation `describe` returns the version and the operations that the connector supports. Another major version is an error (exit 1) with a remedy. A minor version only adds. Factory checks each result against the schema of the contract. A connector calls a vendor CLI with an argument list, never with a shell, and sends item text on stdin or in a file. The time cap, the output byte cap and the result cap are named numbers in `src/names.ts`. A call past a cap has the result "unknown". The names `local`, `artifact` and `github` are reserved, and a plugin with one of them is an error (exit 1). Control characters in the output of any connector show as visible escapes.
3. **Contract suite and `plugin test`.** One contract suite, which factory exports, runs against any connector. It has four layers: the schema of each operation, the behavior of each operation, an item title with shell characters, and recorded responses of the vendor CLI. `factory plugin test <name>` runs it against a plugin. The suite for `artifact` runs its script part with fixture data.
4. **Board-first writes (D-141 B).** A write goes to the board first. The cache changes after the board write succeeds. There is no queue, and an unreachable board fails the write. A write with no answer before the time cap has the result "unknown", not "failed". The remedy tells the user to refresh the cache from the board before a retry. Each item carries its factory id, so the refresh finds the item and a retry makes no second item. Reads come from the cache, so offline work only reads. The one write that needs no board is in design §4.10.
5. **An operation that a board lacks.** An operation that `describe` does not list stays cache-only, with a mark. `factory tracker status` shows one line for it.
6. **Refresh and drift.** A refresh follows the one rule of design §4.10. A drift line names an item id. The drift check has a cap, and past the cap the output says "more than <cap>". The first copy of items to a board uses a map from local ids to board ids, runs in batches, resumes after a stop and makes no duplicate.
7. **Local change feed.** The `local` board has a change feed. An event of the feed is a board event: it only wakes the coordinator. Its author is `session` or `terminal`, never `owner`. The feed has a size bound, and a cursor that is not valid gives "unknown". `watch` skips the writes of factory itself. For each new event, `watch` writes one record and types one constant wake line. FAC-M11 sets the format of the record. `watch` and the window `ops` work for every kind of board, `local` and `artifact` included.
8. **The `artifact` connector.** Its items live in the local files. This is the one named exception to board-first writes: the page is a view that factory renders, and a page answer records no decision (D-142 A). A failed publish never fails a write. Factory renders the review page from the local files and publishes it (TB-5). The owner can choose this connector, and no milestone retires the page. The old page scripts give way to this render.
   - The page builds its links by a fixed rule, and it has no write path. The render writes no board file. The secret check of `doctor` runs before a publish.
   - A page answer is a board event (D-142 A). It shows and wakes, and records nothing. Only `factory decide <D-n> <option>`, run by the owner, records a decision.
   - The publish uses private visibility and takes a file path, so the page text never goes into model tokens. Factory prints one `PUBLISH:` line, only when the page changed, at most once for each set interval.
   - The page counts as the decision store. At `tracker set artifact`, factory asks the owner in a terminal window to confirm that the page is private, and it records the answer for the node, outside the shared file. With no answer on record, factory prints no `PUBLISH:` line and exits 4, and the remedy is `factory tracker set artifact` in a terminal window. `doctor` warns "page privacy not checked", names the manual step, and never passes the check.
   - The page data holds no password, no token and no machine path. The render escapes HTML, and the data block escapes `</script>`.
   - `decide read --from FILE` reads the answers of the page from a data file that the agent writes. It shows each author as "page (not known)", and it records nothing. The file follows the real-path rule of the `item doc` attach (point 10), a size limit and a schema check. An error never repeats text of the file.
9. **Doctor checks for board CLIs.** From FAC-M11, `doctor` checks each chosen board CLI for three things: present, configured and authorized. Each plugin declares its scopes. The output has only the check names and the scope names, never raw CLI output.
10. **The attach rule of `item doc`.** `item doc` attaches a file only from inside a project or the factory folder, after factory finds the real path. It refuses a link, `factory.local.yaml`, a state file and a file over the size cap (exit 4).
11. **Two record checks.** The decision log and the approval records get a check that finds a change that factory did not make. The text of an item gets a check before a write to a public items store: it refuses a value that looks like a password or a token.
12. **Config schema change.** In the shared file `factory.yaml`, `tracker.kind` is `local`, `artifact` or `github`. A `tracker` block in `factory.local.yaml` can set `kind` to `plugin:<package>` and hold `tracker.options`. It overrides the shared kind on this node, and `tracker set plugin:<package>` writes it. `items` and `decisions` stay in the shared file. A shared file that names a plugin kind stops with exit 1 and names `factory.local.yaml`. The plugin checks its options with its own schema. An unknown key fails and names the key.
13. **Epics (TM-14).** An epic groups work items under one goal of the owner (design §4.10, "Epics"). An epic has an `id` (`E-<n>`), a `title`, a `project` and a `priority` (`P0`, `P1` or `P2`). It has no description. The contract gets the operations `epic add`, `epic update`, `epic list` and `epic remove`. The commands are `epic add|update|list|remove`, the option `--epic` of `item add` and `item update`, and `item list --epic`. Each work item belongs to exactly one epic, so `item add` needs an epic. `epic remove` fails while an item names the epic. `local` keeps the epics in `board.json`. FAC-M11 decides the key that names the state for the Next column. FAC-M5b builds the epic view of the board pane.

In M5-1b a hosted kind has no connector. Every write stops (exit 4), and a read reads the local files (`src/board/local.ts`). FAC-M11 and FAC-M3 add board-first writes.

**Exit criteria.**
- [ ] Loader test with a fixture global folder. A package inside the folder of `npm root -g` loads. A package outside it, and a link to a package outside it, do not load. A name that is not a valid npm package name loads nothing. A plugin name in the shared file `factory.yaml` loads nothing, the command exits 1, and the output names `factory.local.yaml`.
- [ ] Load order test. A fixture plugin writes a marker file when its code loads. With a wrong contract id in its `package.json`, the marker file does not exist after the call, and the call exits 1 with the remedy that the install is a trust decision.
- [ ] Contract test. `describe` of a fixture plugin gives the version and the operations. A fixture with another major version exits 1 and names the remedy. A fixture with a higher minor version that adds one operation loads. A fixture with the name `local`, `artifact` or `github` exits 1 and names the three reserved names.
- [ ] Schema and cap test (unit tests with a fake clock). A fixture plugin returns a wrong field type for each operation: factory rejects the result (exit 1), names the operation and changes no cache file. A fixture that gives no answer, one that prints more than the output byte cap and one that returns more than the result cap each give the result "unknown", and the output names the cap.
- [ ] Argument list test. The contract suite makes an item with a title that holds shell characters, against a fake vendor CLI that records its call. The title arrives as one argument or on stdin, and no shell runs.
- [ ] `factory plugin test <package>` runs the contract suite against a fixture plugin. It exits 0 for a good plugin, and it exits 1 and names the first failed operation for a bad one. The same suite passes in CI against `local`, and against `artifact` with fixture data for its script part. FAC-M3 adds `github`.
- [ ] Board-first test with a fixture plugin. With the board up, `item add` writes the board and then the cache. With the board down, `item add` fails, changes no cache file and leaves no queue. With no answer before the time cap, the result is "unknown" and the cache is unchanged.
- [ ] Retry test. A fixture board stores a write and loses the answer. After a refresh, a retry of the same write makes no second item: the board holds one item with that factory id.
- [ ] Offline test. With the board down, `item list` and `status` read the cache and exit 0, and `factory decide <D-n> <option>` records the decision (the rule of design §4.10).
- [ ] Refresh test (the rule of design §4.10). A fixture board differs from the cache in one item, one track, one note, one decision record and one approval record. After the refresh, the item, the track and the note equal the board. The decision log and the approval records have the same bytes as before, and the output has one drift line for each of the two records.
- [ ] Drift cap test. A fixture with more drifted items than the cap prints the cap number of lines and then "more than <cap>". A fixture plugin whose `describe` leaves out `note` gives a cache-only note with a mark, and `tracker status` shows one line for it.
- [ ] Local change feed test. A write of a session gives one event with the author `session`, and the same write in a terminal window gives `terminal`. No event has the author `owner`. The feed stops at its size bound. A cursor that is not valid gives "unknown". Each new event gives one record and one constant wake line. `start --dry-run` lists the window `ops` with `factory watch` for `local`, `artifact`, `github` and a plugin board.
- [ ] `artifact` publish test with a fake publish command. A change of the page gives one `PUBLISH:` line. No change gives none. A second change inside the interval gives none. The output holds no page text. A failed publish exits 0 for the write that caused it.
- [ ] Page privacy test. With no answer on record, a publish prints no `PUBLISH:` line and exits 4 with the remedy `factory tracker set artifact`. After the owner confirms in a pty test, the line prints. `doctor` warns "page privacy not checked" and exits 0.
- [ ] Page data test. The data block holds no password, no token and no machine path. A title with HTML characters and a title with `</script>` show escaped in the render and in the data block. `decide read --from FILE` with a fixture data file shows the author "page (not known)", and the decision log has the same bytes after it. A file outside a project and the factory folder, a link, a file over the size limit and a file that fails the schema are each refused, and the error holds no text of the file.
- [ ] Review page render test (TB-5). The `artifact` render of a fixture board escapes all text, in text and in attributes. The links come from the fixed rule only. The render writes no board file. A publish runs the secret check of `doctor` first, and stops when that check fails.
- [ ] Page answer test (D-142 A). A fixture data file holds a page answer `approve` for an ask. `decide read --from FILE` shows it with the author "page (not known)". The decision log and the approval records have the same bytes after it. `pr merge` refuses the answer as a proof, and the message says that a board event is no proof. `factory decide` in a pty test records the decision.
- [ ] Epic operations test (TM-14), in the contract suite. `epic add` gives the ids `E-1` and `E-2`, and `epic list` shows both with title, project and priority. `epic update` changes one field. `item list --epic E-1` lists only the items of that epic.
- [ ] Epic rules test (TM-14), in the contract suite. `item add` with no epic fails and changes no file. An item with an epic id that does not exist exits 2 and lists the epic ids, for `item add` and for `item update`. `epic remove` of an epic that an item names exits 1 and changes no file. `epic remove` of an epic with no item works.
- [ ] Epic card test (TM-14). The `artifact` render of a fixture board with epics shows one card for each epic: the title, the project, the priority, a progress bar of its items by stage, and "done/total". A card has no description.
- [ ] Hosted stop message. The stop of a write for a hosted kind with no connector names the milestone that adds the connector: FAC-M11 for a board plugin, FAC-M3 for `github`. Today the message says "Hosted boards come in FAC-M3" (`hostedBoardLine` in `src/names.ts`, design §4.3). Change the message and its test (`test/unit/board-tracker.test.ts`, TP-67) in the same commit.
- [ ] Doctor test with fake board CLIs. For each of present, configured and authorized, a fixture CLI that fails the check gives one line with the check name and the scope name. A fixture CLI that prints a marker word gives output with no marker word.
- [ ] Attach test. `item doc` attaches a file inside a project. It exits 4 for a file outside a project and the factory folder, for a link, for `factory.local.yaml`, for a state file and for a file over the size cap.
- [ ] Record check test. After an edit by hand of `decision-log.json` and of one approval record, the check finds each edit and names the file. After a `factory decide`, the check passes. For a fake public items store, a write whose title holds a value that looks like a password or a token is refused, and the output names the item and never the value.
- [ ] Config test. In `factory.yaml`, `tracker.kind` loads with `local`, `artifact` and `github`. In `factory.local.yaml`, `tracker.kind` loads with `plugin:<package>` and overrides the shared kind. `plugin:<package>` in `factory.yaml` exits 1 and names `factory.local.yaml`. Any other value fails and names the key. `tracker.options` loads when the plugin schema accepts it, and an unknown key under it fails and names the key.

### FAC-M5b: Release check, copies sync and clean, usage view, live board

**Goal.** The release check, `copies sync` and `copies clean`, the extension points for a desk, the acceptance of shared check commands, the token budget script, the usage view and the live board work with the `local` board. The first parts come from FAC-M5. The move of this workspace (FAC-M7) does not need them, so they follow it (D-133 A). The live board comes from the direction TB-8 to TB-10.

**Scope.**
1. **Release check (F-6).** `release check|verify|scope`. The approval point `release` with its proof (design §6.2).
2. **`factory copies sync|clean` (D-55).** FAC-M5 builds `list` and `status`. The safety rules and the single git module of FAC-M5 apply to these two commands.
3. **Token budget.** `scripts/budget-check.sh`.
4. **Extension points (design §4.14).** The event file and `report --json` hold the fields of design §4.14, and a sample reader outside `src/` (in `examples/`) reads them.
5. **Acceptance of shared check commands.** A check command from the shared file runs only after the owner accepts it (design §4.4).
6. **Usage view and token estimate (F-22, F-23).** `factory status --usage` shows the token use, the limits and the work counts of the factory. `factory item estimate <id>` gives a token range for a work item from the closed items. The usage view uses the separate token meter package (`dean0x/tokenmeter`, which has no devflow dependency). It does not build its own count from factory data. Both commands read only data that factory records or that the package gives: the last-seen files, the hook and status line data (design §4.6), the board and the output of the package. They never read a file under `~/.claude`. If the status line data has token, cost or limit fields, the hook records them in the last-seen line. Design §4.2 lists the flag and the subcommand.
7. **The board archive.** An archive file for the board. In M5-1b a board file at the cap of 1 MiB stops reads and writes, and the archive removes that limit. The lost-id check accepts an id that the archive holds.
8. **Live board (TB-8 to TB-10).** The live board shows what each worker does now (design §4.11). It reads the last-seen lines, the work items and the board cache, and it calls no model.
   - The workers table. `worker list --follow` has the columns `WORKER`, `WORK ITEM`, `STATE`, `IN STAGE` and `CONTEXT`, in this order. `STATE` is `<Stage> · <word>`. The words are Working, Idle, Stopped, Stalled, Parked and On hold. The word stands alone only when the worker has no stage. Stopped is one word, and the stop reason goes to the stopped-workers file, never to `STATE`. `status` uses the same words.
   - The hook. The hook of design §4.6 gets the events `PostToolUse`, `StopFailure`, `SubagentStart` and `SubagentStop`, and the `Notification` type `idle_prompt`. Before the build, FAC-M5b checks the field lists of `Stop`, `StopFailure` and the status line. It also captures one payload of each new event.
   - Stage and time in stage. The work item holds the time of its last stage change. FAC-M5b names the key of this time in `src/names.ts`, and it adds the key to `reservedFieldNames` in the same file. So no owner field can take the name.
   - `worker mark <worker> parked|on-hold|none` sets or clears a hold word. A mark is not an approval.
   - The views. The tracks view is `track list`. The board pane is `item list --follow`, and each open item shows the estimate mark: the range of `item estimate`, or `NO BASIS`. The board pane also has the epic view (design §4.11, "The epic view"), which reads the epics of FAC-M11. `status --usage` is the usage view (item 6).
   - The `--follow` bound. Each `--follow` view repeats at an interval, stops after a number of redraws and prints at most a number of lines. The interval, the redraw count and the line cap are named numbers in `src/names.ts`.
   - The rename. `--idle` becomes `--unused`, `IDLE` becomes `UNUSED`, and `limits.idle_after` becomes `limits.unused_after`, with its load message. The words of `status` change at the same time.
   - Known limits (design §4.11, "Two gaps"). Factory can not tell a long background shell command from a stall. Working between a prompt and the first tool call is inferred.

**`factory copies sync|clean` (D-55).**
- `sync <pr|branch>`: a base update of a waiting PR. It merges `origin/<default>` into the branch in a short-lived worktree under `.factory/state/`, pushes with no force, and removes the worktree. On a conflict it stops and names the files.
- `clean [--apply]`: it takes over `factory clean`. It removes a work copy only when no worker holds it, no item or resume file names it, the tip is on the remote, the tree is clean and the PR is merged.

**Exit criteria.**
- [ ] Release proof. Test: with `release: delegated`, `release check` refuses (exit 4) when no owner-approved release scope names the version. `release scope <project> <version>` writes the scope in a terminal window outside a factory session, and refuses (exit 4) with no terminal window and with `FACTORY_SESSION` set. After the scope, `release check` passes. A new scope does not change a delegation: after `release scope`, the effective mode of `release` stays `delegated`, and `doctor` lists the delegation with its old time.
- [ ] Config test: the approval point `release` loads with `owner` or `delegated`, and an absent key means `owner`. Any other value fails and names the key. `release check|verify` only read; a test asserts that they run no publish command.
- [ ] `release verify` adds one event to `.factory/outbox/`, as `pr merge` and `decide` do in FAC-M5 (test).
- [ ] Desk extension points. Test: the event file and `report --json` of a fixture node hold the fields that design §4.14 lists. A sample reader outside `src/` (in `examples/`) reads the event file and `report --json` of the fixture node and prints one line per work item. The test runs it.
- [ ] Board archive. Test: an archive file for the board holds items that left `board.json`. The lost-id check of the board commit helper and of the delete guard accepts an id that the archive holds, and still stops for an id that neither file holds.
- [ ] Shared check commands. Test: a check command from the shared file does not run before the owner accepts it, and runs after the acceptance.
- [ ] `copies clean` is a dry run by default, and refuses a work copy with unpushed work or a path that a worker or resume file names. `factory clean` does not exist as a second command.
- [ ] `copies sync` tests on fixture repos: a clean merge pushes with no force and removes its worktree; a conflict stops, names the files and leaves no worktree; the worker's own work copy does not change.
- [ ] `scripts/budget-check.sh` exits 0 for the jobs built so far. It exits 1 when a fixture output is more than twice the figure in `docs/token-budget.md` (test with an inflated output).
- [ ] Usage view (F-22). Test `status --usage shows tokens, limits and work counts for two subscriptions` (`test/unit/status-usage.test.ts`), on a fixture of last-seen lines and closed items for two subscriptions. The fixture also holds the output of the token meter package, and the test uses that output as a source. For each subscription and each model, the output shows the token use for today, this week and this month. When a session uses a relay server, the output also splits the token use by the relay server address, which the local file holds; the fixture has one session with a relay server. It shows the quota or weekly limit percent when the data of the subscription has one, and `-` when it has none. The fixture has one subscription of each kind. The output also shows the work counts (items closed and lines changed) for the three periods, and the tokens of each work item. Line 1 is the verdict, and the output follows the output rule (at most 20 lines, checked with the short-output helper). The static test of FAC-M4 (no source file opens a path under `~/.claude`) covers this code.
- [ ] Forecast and share (F-24). The usage view shows the forecast and the share of the weekly capacity that the token meter package gives, and the usage view test checks both on its fixture.
- [ ] Token estimate (F-23). Test `item estimate gives a token range from closed items` (`test/unit/item-estimate.test.ts`), on a fixture of closed items with measured tokens. With at least N similar closed items, `factory item estimate <id>` prints a token range and its basis (the closed items that it used) and exits 0. With fewer, it prints `NO BASIS` on line 1 and exits 3. N is a named number in `src/names.ts`, with the proposed value 3. The output follows the output rule. `docs/token-budget.md` keeps its 17 rows, because design §3 lists no job for these two commands (docs check 6).
- [ ] Workers table (TB-8). Test on fixture last-seen lines and work items. `worker list --follow` has the columns `WORKER`, `WORK ITEM`, `STATE`, `IN STAGE` and `CONTEXT`, in this order, with one line for each worker. A worker with an item in the stage `building` and the event `UserPromptSubmit` shows `Building · Working`. A worker with no stage shows the word alone. A title that does not fit ends with `…`, and the row stays one line. A worker with no work item shows `—`.
- [ ] State words (TB-8). Fixture hook events give each word. The events `UserPromptSubmit`, `PreCompact`, `PreToolUse`, `PostToolUse` and a dialog `Notification` give Working. The events `Stop`, `SessionStart` and `idle_prompt` give Idle. The event `StopFailure` gives Stopped. A worker that would show Working shows Stalled when no event came for the bound of `stalled?` in `worker watch` (a fake clock). A `SubagentStart` or a `SubagentStop` counts as an event.
- [ ] Stopped (TB-8). A worker with `StopFailure` shows the one word Stopped, and `STATE` never shows the cause. The stopped-workers file has one line for each Stopped or Stalled worker: the worker id, the word, the cause, the time and the remedy. The remedy for `rate_limit` or `billing_error` is `worker recover`. The remedy for another cause, and for Stalled, is `worker summon`. The file is empty when no worker is Stopped or Stalled. A worker with no live pane, no work copy folder or no last-seen line never shows Stopped. It shows its hold word, else `—`. `status` shows the same words.
- [ ] Hook events (TB-8). Fixture input of `PostToolUse`, `StopFailure`, `SubagentStart`, `SubagentStop` and `Notification` with the type `idle_prompt` each writes one last-seen line with the event name and the time. The fixtures are captured payloads. The hook never reads `transcript_path`.
- [ ] Hook event map (TB-8). The plan of FAC-M5b states how `StopFailure`, `SubagentStart` and `SubagentStop` count in the checks of `worker stop`, `worker reset`, `worker watch` and `dismiss` (design §4.6). Test: a fixture line of each event gives the state that the plan states, in each of the four checks.
- [ ] Stage and time in stage (TB-9). With a fake clock, `IN STAGE` shows the time since the last stage change as `N min`, `H h`, `H h M min`, `D d`, `D d H h` or `99+ d`. It gives the same text under a machine time zone that is not UTC. A missing or not valid time shows `—` for that row only. A worker with no open item shows the word alone in `STATE` and `—` in `IN STAGE`. A board that factory can not read shows `—` for the work item, the stage and `IN STAGE` of every row. The key of the stage time is in `reservedFieldNames`, and a `board` block that names it as an owner field fails the load and names the key.
- [ ] Worker mark (TB-8). `worker mark W parked` makes the row show Parked, `on-hold` shows On hold, and `none` clears the mark. A hold word replaces the hook state while it is set. A mark is not an approval: with a mark and no decision record, `pr merge` and `release check` refuse.
- [ ] Tracks view and board pane (TB-8, TB-10). `track list` prints one line for each track: the name, the milestone, the workers as `worker (stage)` (as `worker (stage, Parked)` for a held worker), and the open items for each stage. It needs no hook event. `item list --follow` shows the estimate mark on each open item: the token range of `item estimate`, or `NO BASIS`.
- [ ] Epic view (TM-14). On a fixture board with epics, the board pane groups the epics under In progress, Next, Later and Done by the rule of design §4.10. Each epic is one line with the title, the project, the priority, a text progress bar of its items by stage, and `done/total`. Epics sort by priority, then title.
- [ ] `--follow` bound (TB-8). With a fake clock and a fake terminal window, each `--follow` view repeats at the interval, stops after the redraw count, and prints at most the line cap. Past the cap, the last line says "more than <cap>". The interval, the redraw count and the line cap are named numbers in `src/names.ts`.
- [ ] Rename to unused (F-21a). `dismiss --unused` lists the unused workers. `status` has the column `UNUSED` with the values `yes` and `no`. The setting `limits.unused_after` loads, with the default 2h and the bound 1m to 24h. A value outside the bound fails the load, and the message names `limits.unused_after`. A static test finds no `--idle`, no column `IDLE` and no `limits.idle_after` in `src/`.

### FAC-M3: GitHub board plugin, and the move to it

**Goal.** The board, the requests and the decisions of this workspace move from the `local` board to GitHub. A script reads the answers on the board and shows them; the owner enters each decision with `factory decide`. The user picks the board tool at setup. The old render and board scripts are retired. The review page is not retired (TB-5), and factory keeps the local board (TB-6). A second machine of the owner gets the profile.

**Scope.**
1. The `github` connector (issues plus a Projects board, through `gh`). It is an internal board plugin on the contract of FAC-M11, with board-first writes (design §4.10). The contract has the `doc` operation (attach a file, link a repo file) and `changes read` (comments, label changes, assignee changes, open or close changes, each with its author; card moves are out for now). The connector does not look at which account wrote an event. A separate account for the agents is optional, and it is the owner's own GitHub choice (D-128 A). One GitHub project holds the issues of all the repos of a factory (design §4.10).

   The connector maps the contract to GitHub in this way:
   - a track is a field of the Projects board;
   - a note is a comment on the issue;
   - an unlink edits the link comment that factory wrote, and no other comment.

   The check of item text from FAC-M11 runs before each write to a public items store.
2. The commands `decide read` and `watch`, and `decide <D-n> <option>` for the `github` board (design §4.10). With `github`, `request add --option KEY=TEXT` asks a decision on the board. With `github`, `decide <D-n> <option>` also adds a comment to the item that names the CLI. The comment is a record, not a proof (D-128 A). `start` starts `watch` in the window `ops` for the `github` board. FAC-M11 does the same for the other kinds of board.
3. The choice of the board: `init --tracker --items --decisions`, the question in a terminal window, `tracker set`, `tracker status`, and the per-project override (design §4.10).
4. `item import` from the `local` files into a team board, and the move of this workspace's items into GitHub issues with a private decision store. The retirement of the old render and board scripts. The review page stays (TB-5).
5. The state remote: `state remote|push|pull`, `init --state-from`, and the rule that `state pull` and `upgrade` move by fast-forward only (firstmate idea 8).

**Exit criteria.**
- [ ] One board for two repos. A recorded run of real `gh project` commands on a private throw-away project that holds the issues of two repos: create the project, `item-add` from each repo, one `item-list` with `--limit` that lists the items of both repos, `--query` with a filter by repo, and a field edit. The record holds commands and field names only, no ids and no URLs. Then a connector test with recorded responses prints a "more than <cap>" line when the list exceeds the cap.
- [ ] The contract suite of FAC-M11 passes against `github`, with a fake `gh` and recorded responses. No test needs the network. The tests name the `doc` operation: one attaches a file, one links a repo file.
- [ ] Board-first test with a fake `gh`. `item add` makes the issue and then the cache entry. With a `gh` that fails, `item add` fails and changes no cache file. With no answer before the time cap, the result is "unknown" and the cache is unchanged.
- [ ] GitHub map test with a fake `gh`. A track is written as a field of the Projects board, and a note as a comment on the issue. An unlink edits the link comment that factory wrote, and it changes no other comment.
- [ ] Item text check test with a fake `gh` that says the items repo is public. `item add` with a title that holds a value that looks like a password or a token is refused, and no write call goes to `gh`. The output names the item and never the value.
- [ ] `factory watch` with `github` reads the board through a fake `gh`. With `local`, it reads the local change feed of FAC-M11 and makes no call to `gh`.
- [ ] `decide read` shows an answer `/choose B` or a label `choose:B`, with its author and link, from any account. A board comment or label only wakes the coordinator and shows the answer. The owner enters the decision with `factory decide`. A comment or a label records nothing. Tests cover a comment, a label, and two accounts.
- [ ] `decide <D-n> <option>` with `github`. Test with a fake `gh`: the record has `by: owner`, and the item gets one comment that names the CLI.
- [ ] `doctor` fails on a public decision store and warns on an unset one (fake `gh` responses).
- [ ] `watch` stops after its read bound, and wakes only on a new answer or mention (unit tests with a fake clock).
- [ ] Wake test on a separate tmux server with a fake `gh`. A comment `/choose B`, a label change, an assignee change and an issue close each cause one record and one constant wake line in the coordinator pane, whatever account wrote the event. A board comment or label only wakes the coordinator and shows the answer; it records no decision. A fake `claude` on PATH records no call during `watch`.
- [ ] watch does not wake the coordinator for an event that factory itself wrote (it marks its own comments), and a test shows that a coordinator comment causes no wake loop.
- [ ] `start --dry-run` with `github` lists the window `ops` with `factory watch`, as it does for every other kind of board (FAC-M11).
- [ ] Board choice, tests with a fake `gh`: `init --tracker github --items acme/web --decisions acme/decisions --yes` makes a node, and `factory doctor` exits 0. When the fake says that the decision repo is public, `init` exits 4 and writes no file, and `doctor` fails on such a config. `tracker status` prints `github`.
- [ ] Override test: a node with the default `github` and a project with `kind: local`. `item add --project P` goes to the `local` files, and an item with no project goes to the fake `gh`. `tracker status` prints both.
- [ ] `item import` moves the `local` files (fixture `board.json` and `waiting.json`) into `github` items. It follows the first-copy rule of FAC-M11: a map from local ids to GitHub ids, batches, and a resume after a stop. A fake `gh` that fails in the middle of a batch leaves some items copied, the next run copies only the rest, and a second full run creates no duplicates.
- [ ] State remote, integration test: machine A makes a state repo and pushes it to a bare repo path. Machine B (a temp HOME) runs `init --state-from <path>`. The profile index equals the one of machine A, and `doctor` exits 0. `state pull` with a diverged remote exits 1 and changes nothing. With a dirty `.factory/`, `state pull` and `upgrade` stop, name the files and change nothing.
- [ ] The old render and board scripts are not called by any process (a search of the tmux hooks and the cron list finds none). `scripts/check-parity.sh FAC-M3` exits 0 for all rows.
- [ ] State pull and the second machine. Test: a state pull brings a `.factory` to a second factory folder, and the test `start warns when another machine is active` (`test/integration/start.test.ts`) reads it. Concurrent use is in the FAC-M8 criteria.
- [ ] This workspace: after `item import`, a check script finds each `local` item id in exactly one GitHub issue, and `factory doctor` exits 0 with `tracker.kind: github`.

### FAC-M8: Layers and team

**Goal.** A node on layer 2 manages layer-1 nodes, and a node on layer 3 manages layer-2 nodes. A second person uses factory with no shared owner. A new top layer changes nothing below it.

**Scope.** `factory report` rollup, `deliver` and `report` on the `file://` transport, messages from a node with a different owner, the manager role template in use, the `director` template for layer 3, `node tree`, and the list of config items that a parent passes down. All nodes are on one machine (F-13). Decide again if each owner needs a separate place for decisions (D-9 A). Concurrent use of one factory from several machines (design §4.3) is in this milestone.

**Exit criteria.**
- [ ] Integration test: a layer-2 node reads a rollup over 2 layers with `file://` children.
- [ ] Integration test: a layer-3 node reads a rollup over 3 layers with `file://` children.
- [ ] Growth test: a layer-2 node runs `add-child` for a new layer-1 node. Before and after, the hash of `factory.yaml` and of the state files (without `.git`, `state/` and `locks/`) of every node below is the same.
- [ ] Unit tests: `roleForLayer(3)` returns the `director` template, and it is not the manager template. `init --layer 3` writes the director block. A node on layer 4 gets a `doctor` warning that names the layer.
- [ ] Integration test: a child factory folder that factory cannot read shows "unknown" in the rollup, never "dead".
- [ ] A record from a parent with a different owner arrives as a message, and carries no authority (test).
- [ ] Concurrent use. Test: two machines that use one factory do not write the same state file at the same time, or the second `start` stops with the name of the active machine. This follows the one-active-machine warning of FAC-M4.
- [ ] `node tree` prints one line for each entry of `children[]` and reads only the folders that the entries name. A test with an extra node folder shows that it is not listed. A child entry whose folder has another node id shows `mismatch`, and `deliver` to it exits 4.
- [ ] A parent that has owner, accounts and session settings in its config passes to a child only the keys of the inherit list (limits, writing style, safety rules). A test compares the child config.

### FAC-M10: Release and install

**Goal.** A team member can install factory from a release on a new machine. Nothing publishes until the owner writes a decision id.

**Scope.** The release workflow (tests, version check, GitHub Release, npm publish in a protected environment, tap update), `install.sh` with a SHA256 check, the Homebrew formula in `dean0x/homebrew-tap`, `scripts/release-gate.sh`, and `docs/release-approval.md` (design §4.7). The version lives in `package.json` only. The first real publish is out of scope: it runs after the owner writes a decision id in `docs/release-approval.md`, and the gate script blocks it until then. Remove `"private": true` from `package.json` in the release PR, after the owner writes the decision id.

**Exit criteria.**
- [ ] `scripts/check-release-workflow.sh` (no network) exits 0 only when: the job `publish` has `environment: npm-publish`; no other job runs `npm publish`; the first step of `publish` runs `scripts/release-gate.sh`; and no file but `package.json` holds the version.
- [ ] `scripts/release-gate.sh` tests: it exits 1 when `docs/release-approval.md` has no line `Decision: D-<n>`; it exits 1 when the tag version differs from the version in `package.json`; it exits 0 with both.
- [ ] `scripts/check-environment.sh` (a read-only `gh api` call, run with the token of the owner) exits 0 only when the environment `npm-publish` has the owner as a required reviewer. The output is saved in `docs/reviews/`.
- [ ] `scripts/check-private.sh` exits 1 when the repo is public and `docs/release-approval.md` has no decision id. It exits 0 when the repo is private.
- [ ] `install.sh` tests with a local file base: a good tarball with its SHA256 installs and runs `factory --version`, and a second run is safe. A tampered tarball exits 1 and installs nothing.
- [ ] `scripts/check-formula.sh` exits 0 when the `url` and `sha256` of the Homebrew formula match the release asset (fixture release), and exits 1 on a mismatch.
- [ ] Clean machine: a script in a clean Linux container, and the same script on a macOS runner, runs `npm i -g` from the tarball of `npm pack` with a throw-away HOME and a fake `gh`. Then `factory init --yes --tracker github` in a temp repo, `factory start --dry-run` and `factory doctor` all exit 0. The script edits no file by hand.
- [ ] CI runs the workflow up to `npm publish --dry-run`, and the dry run exits 0.

### FAC-M9: Jira and Linear plugins

**Goal.** A team that uses Jira or Linear gets the same board features. Jira and Linear are board plugins on the contract of FAC-M11. FAC-M9 follows FAC-M3, so the contract is proven with GitHub first.

**Exit criteria.**
- [ ] The `jira` plugin and the `linear` plugin pass `factory plugin test` with recorded responses, as `local`, `artifact` and `github` pass the same contract suite.
- [ ] One board for many repos. A plugin test with recorded responses for each tool lists, in one board view, the work items of two projects (Jira) or two teams (Linear) that map to two repos of the factory, with a filter by repo.
- [ ] `doctor` checks the decision store privacy for each connector. It also checks the CLI of each of the two plugins: present, configured and authorized (FAC-M11).
- [ ] `site` and `key` are plugin options under `tracker.options`. `tracker set plugin:jira` with no `site` exits 2 and names `site`. `tracker set plugin:linear` with no `key` exits 2 and names `key`.
- [ ] Mixed test with fakes: a node with a `github` project and a `plugin:jira` project. `item add --project P` goes to the connector of P, and `tracker status` prints both.

## Design v3 PR (after FAC-M2)

The design v3 PR comes after the FAC-M2 merge and before FAC-M4. It brings D-59, D-60 and Dean's notes F-14 to F-21 into the design, this roadmap, the trace and the code. It is two PRs (D-12 B): the docs PR first, then the code PR. Nothing is released, so both PRs are releasable at merge. Each PR has one checkbox. The first commit of the code PR ticks the first box, because the docs PR is merged by then. The last commit of the code PR ticks the second box. `scripts/check-intent-docs.sh` finds these two boxes under this heading, because rows of `docs/intent-trace.md` name the label "Design v3 PR".

- [x] Docs PR (branch `design-v3`): the design text, this roadmap, the token budget, the intent trace and the glossary in plain words, the plain-words table and its scan, and the docs checks 8, 9 and 10. No file under `src/` changes.
- [x] Code PR (branch `design-v3-code`): the code and test changes of the points below.

There is one checkbox for each of the eight points of Dean's request, in the same order:

- [x] Point 1, plain words (F-14, D-59). `docs/glossary.md` and `test/helpers/plain-words.ts` hold the plain-words table, and the glossary teaches the new words (worker, request, assignment, session reset, queue, check, release check and the others). An old word shows there only in the mark `(was: old word)`. The docs scan finds none of the eight old words (the words of the setup of today, design §7) and no scanned jargon word in the design, this roadmap, the token budget and the glossary, outside code, the mapping tables, the `(was: old word)` mark and a named list of allowed lines. In the code PR, `src/names.ts` and `src/glossary.ts` rename the program words to the new words, and then the glossary test compares the program text with `docs/glossary.md` again. Also in the code PR, `src/names.ts` holds no user value for an old word, it has one worker role key, no two role values and no two term values are equal, and the pane option is `@worker`. The names test and the glossary test pass.
- [x] Point 2, a shared factory travels (F-18, D-60). The factory folder is one git repo with `factory.yaml`, the setup (`setup/coordinator.md` and the worker role text `setup/roles/worker.md`, both built in the code PR) and a share list. The personal and one-machine keys are in the ignored file `factory.local.yaml`. `init` on a received factory registers it after the owner accepts the files. A config counts only when the registration check passes. The test that a received factory starts after one `init` is a FAC-M4 criterion (TP-29 extended). Before early access (D-49, 2026-11-06), another developer could not install the factory program, so the received-factory test uses the program from the repo. A move of the work state to a second machine is in FAC-M3 (`init --state-from`). The reason for FAC-M4: one of the prompts is the write of the hook, and FAC-M4 builds the hook. The code PR has the first test (TP-29), without that prompt.
- [x] Point 3, recipe words stay in the recipe, and approval points (F-15). Docs check 10 reads the core parts of the design and of the glossary: the summary, §4.1, the core commands of §4.2, the table "Rules for every factory" in §6, and the part "Words of every factory" of the glossary. They hold no word of the software recipe: merge, pull request, release, CI log, PR, CI, git and tmux. The summary, §4.1 and the glossary part may use such a word in a line that starts with `Software recipe:` or `Engineering note:`. §4.2 and §6 have no such line. In the code PR, the software recipe lists the approval points `merge` and `release`, owns its words, and `init` asks for each point with `owner` as the default. Only the approval record writer writes an approval record, and only in a terminal window outside a factory session.
- [x] Point 4, core and setup (F-16). Design has the headings "Core and setup" and "Extension points" (docs check 9). The table lists priorities, lifecycle, review rules, role texts and scripts as setup, and the fixed rules as core. The owner accepts the hash of `setup/coordinator.md` and of `setup/roles/worker.md`, and FAC-M6 extends the acceptance to every setup file. The code PR builds both files in the same step.
- [x] Point 5, few stops (F-17). Only a security boundary stops a command (exit 4), and every stop prints one line with the remedy command. Every other check is a warning. Design §4.3 lists the stops and the warnings in a table, each with its remedy command. factory has no desk command and no desk row in the command map (docs check 3).
- [x] Point 6, one board for many repos (F-19). Design §4.10 answers in plain words: "Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos." It gives the list bound, the filter and the owner rule. For Jira and Linear it says "Not checked yet: FAC-M9". FAC-M3 proves the GitHub answer with a real run on two repos, and FAC-M9 checks Jira and Linear.
- [x] Point 7, lifecycle, idle workers and dismiss (F-20, F-21). `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` each have a line in design §4.2 and a named test in FAC-M4. `start` resumes the recorded workers after a machine restart. Design §4.11 defines idle: no activity for `limits.idle_after` (default 2h) and no open work in progress. `status` shows the idle state and the work item of each worker. `dismiss --idle` lists the idle workers first, and the owner picks. FAC-M7 names the change of the old worker names of this workspace.
- [x] Point 8, the leftovers of FAC-M2.
  - Factory folder lookup (moved from FAC-M2: F-3b, V-F-3b, Gap 1). D-60 makes the factory one folder. The factory folder holds `factory.yaml`, so the walk up finds it from the factory folder and from every folder below. Integration test: `start --dry-run` and `doctor` exit 0 from the factory folder, from the coordinator folder and from a project clone.
  - Schema 2 changes in place, before any release. The schema 1 migration writes the new keys. No migration from schema 2 to schema 3 is needed. Migration test: a FAC-M1 node upgrades, and `doctor` then exits 0.
  - A project entry can hold a clone URL, so one repo list can set up the factory on a second machine (as in mars, D-60). Config test: the entry accepts a URL with no user name and no password.
  - No local machine path in the docs (docs check 8).

## Later (no milestone yet)

- Other recipes, for example research or content (F-10). A user-made setup comes with FAC-M6, and a user-made recipe needs no new milestone: the test recipe of the code PR shows that `init`, the block render, `doctor`, `upgrade` and `start --dry-run` run with a second recipe.
- No review desk of its own, not even as an option (F-2, F-17). TB-5 changes this in part: the review page stays a supported owner view that the owner can choose, and from FAC-M11 it is the `artifact` connector. A person who wants another desk builds a reader on an extension point (design §4.14).
- A board tool other than `local`, `artifact`, `github`, Jira and Linear has no milestone. A user installs a board plugin for it (design §4.15).
- One shared source of truth for the workspace board and the factory board (TM-14). Today the two boards are separate. This line states the goal only. It has no build plan and no milestone (design §10).

## Decisions needed

- None blocks the FAC-M2 code.
- Answered (D-59, F-14): the glossary words. Dean chose worker, request and coordinator, and queue, check and release check. The rename comes in the design v3 PR, not in FAC-M2.
- Answered (D-57): the release is an approval point of its own, with the values `owner` and `delegated`. The proof for `delegated` is an owner-approved release scope. FAC-M5b builds the check (design §6.2).
- Before FAC-M3 (after the workspace move in FAC-M7): which private repo holds the decision store of this workspace, and which private git remote holds the state repo (`state.remote`) for a second machine.
- Before FAC-M3: how the `github` connector holds an epic (design §4.10, "Epics").
- Answered (FAC-M4): the bound of `worker watch`: 40 checks of 30 s (`watchPoll` in `src/names.ts`), then `NO CHANGE`.
- Before the milestone that builds each of the other watch commands (FAC-M11 for `factory watch` with `local` and `artifact`, FAC-M3 for `factory watch` with `github`, FAC-M5 for `pr watch`): the bound of each command. The design gives no value for the number of reads per run of `factory watch` for each connector, and none for the maximum wait of `pr watch`. It also gives no result when the bound or the wait ends. Each value is a named number in `src/names.ts`.
- Before FAC-M5b builds the usage view (F-22): the source of the usage of a subscription other than Claude Code, for example Codex. `session.agent` accepts only `claude` in FAC-M4. The owner decides the worker agent setting for another agent, and where its token and limit data come from. Until then, the usage view lists the Claude Code subscriptions only.
- Before FAC-M5b builds the usage view (F-22): FAC-M4 task 2 records which quota or cost fields the real status line data has. If the data has no such field, the owner names the other source. A read under `~/.claude` is not a source (F-9).
- Before FAC-M10: the old local paths in the git history. The owner decides; the history is not rewritten (D-7 A).
- Before FAC-M10: the first publish and the public visibility of the repo. The owner writes a decision id in `docs/release-approval.md`.
- Open: the choice between tracks and epics. An item has a track and an epic, and both stay for now (design §10).

## Risks

- **The renames touch every module.** FAC-M2 does them in one PR, and the names test catches a stray literal.
- **FAC-M2 grows.** The intent fixes add scope to the PR. The steps are separate commits (plan §13a), so the review reads them one by one.
- **The session-stop test can show that no way is safe.** Then `factory worker stop` keeps the rule "idle session, then `kill -TERM`", and the table records why.
- **The status line payload can lack the context percent.** FAC-M4 captures real payloads first. If the field is not there, design §4.6 names another source before the hook is built.
- **GitHub Projects API changes.** The `github` plugin keeps all calls in one module, with recorded-response tests. The contract suite of FAC-M11 runs against it.
- **The old page and scripts read the `local` files.** A format change in FAC-M5 breaks the owner view of FAC-M7. `scripts/check-owner-view.sh` runs in FAC-M7, and in FAC-M3 until it retires the old scripts. From FAC-M11 the page is the `artifact` connector, and no milestone retires it. The page of this workspace reads a factory board only after FAC-M7, and in M5-1b it only reads.
