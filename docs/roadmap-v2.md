# factory roadmap v2 (proposal)

Status: proposal for review · Design: `docs/design.md` v3 · Date: 2026-11-02
This roadmap replaces FAC-M2 to FAC-M7 of the v1 roadmap (D-53). FAC-M0 (design) and FAC-M1 (skeleton CLI, PR #1) are done.
`docs/intent-trace.md` maps each note from Dean to a design section and to a criterion of this roadmap.

## Goal

A team member installs factory on a new macOS or Linux machine. `factory init` and `factory start` give a working node with the `software` recipe and a GitHub board, with no edit to any file. This workspace runs on factory, and its old scripts are retired. The old scripts stay as the owner view until FAC-M3 retires them.

## Rules for this roadmap

- Every exit criterion is a command, a test or a script with a pass or fail result. A milestone is done when all its criteria pass in CI or in the named script.
- No criterion is "a decision". A decision that a milestone needs goes under "Decisions needed". The milestone then tests the choice that is built, not the decision.
- One PR per milestone, unless the milestone names a split and its reason.
- The renames and the schema change come first (FAC-M2), because every later milestone uses the new names and the new schema.
- Heavy test runs follow the machine lock rule. CI runs the full suite on an Ubuntu runner and a macOS runner.
- Output rule (saves tokens): the default output of a job command has at most 20 lines, and the verdict is on the first line. A job command is a command that replaces a manual job of design §3. A shared test helper checks this (FAC-M2), and each milestone uses it for its commands. `docs/token-budget.md` gives the size budget of each job.
- Intent rule: each note from Dean has a row in `docs/intent-trace.md`. Before a milestone merges, a check compares the result with every row of that milestone. A row that is not covered blocks the merge, or moves to a named later milestone with a reason.

## Milestones

The build order is FAC-M2, M4, M5, M6, M7, then M3, M8, M10, M9. D-56 sets M2, M4, M5, M6, M7, M3, M8, M9. The release milestone FAC-M10 comes after FAC-M8 and before FAC-M9, because the Goal needs a release path and does not need Jira or Linear. This workspace moves to factory first, with the `local` board. The GitHub board comes right after the move. The sections below are in build order.

| Order | Id | Name | Depends on | Design changes (F-n) |
|---|---|---|---|---|
| 1 | FAC-M2 | Names, home, roles and schema 2 | FAC-M1 | F-1, F-3, F-4, F-5, F-10, F-13 |
| 2 | FAC-M4 | Worker control | FAC-M2 | F-7, F-8, F-9, F-12, F-20, F-21 |
| 3 | FAC-M5 | Local board, check and release commands | FAC-M4 | F-2, F-6, F-22, F-23 |
| 4 | FAC-M6 | devflow setup | FAC-M5 | F-10, F-16 |
| 5 | FAC-M7 | This workspace adopted (local board) | FAC-M4, FAC-M6 | F-3, F-8 |
| 6 | FAC-M3 | GitHub board, and the move to it | FAC-M7 | F-2, F-18, F-19 |
| 7 | FAC-M8 | Layers and team | FAC-M7 | F-4 |
| 8 | FAC-M10 | Release and install | FAC-M3, FAC-M8 | D-45 |
| 9 | FAC-M9 | Jira and Linear connectors | FAC-M3 | F-2, F-19 |

No milestone before FAC-M3 needs a network board: FAC-M5 and FAC-M7 use the `local` board. FAC-M8 can run in parallel with FAC-M3. FAC-M9 can run at any time after FAC-M3.

### Command map

Each command of design §4.2 has one milestone. A command with two milestones names the part of each. A script checks that every command word of the §4.2 blocks has a row here (FAC-M2), and that no row names a desk.

| Command | Milestone |
|---|---|
| `init`, `start`, `doctor`, `upgrade`, `help` (with `help words`) | FAC-M2 |
| `init --tracker --items --decisions --state-from`; `start` window `ops`; `upgrade` rule for a dirty state repo | FAC-M3 |
| `node children`, `node add-child`, `node remove-child` | FAC-M2 |
| `node tree` | FAC-M8 |
| `machine`, `project`, `layout`, `inbox`, `self`, `hook` | FAC-M4 |
| `shutdown`, `restart`, `reboot`, `status` (the worker states, the work item, the idle state), `dismiss` (with `--idle`) | FAC-M4 |
| `worker` (new, list, send, relay, reset, stop, resume, summon, watch, recover, adopt) | FAC-M4 |
| `item`, `request`, `queue`, `decide <D-n> <option>` | FAC-M5 |
| `check`, `pr`, `issues`, `release`, `copies`, `lock` | FAC-M5 |
| `status` (the digest for the owner), `report` (the digest of one node) | FAC-M5 |
| `report` (the rollup over children) | FAC-M8 |
| `recipe` (show, variant) | FAC-M6 |
| `adopt` | FAC-M7 |
| `tracker`, `state`, `watch`, `decide ask`, `decide read`, `item import` | FAC-M3 |

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
10. **Deny list (O-1, F-2).** The three triage words join the deny list. factory has no review desk of its own.
11. **Review of the setup code (D-51).** The review of the FAC-M2 PR names the `init`, `upgrade` and `doctor` code.
12. **Output helper and budget file (O-1).** The short-output test helper, and `docs/token-budget.md` with one row for each job of design §3.
13. **Docs check.** `scripts/check-intent-docs.sh`.

**Exit criteria.**
- [ ] `npm test` passes. The names test fails on a stray literal, and it finds no word of the setup of today (design §7) in the `--help` output or in the files that `init` writes. The names test also fails when any file under `src/` holds the old pane option, and `names.ts` holds the pane option `@worker`.
- [ ] Integration test: `init --yes` inside a git work tree makes `../<repo>-factory` and lists the repo as the first project.
- [ ] Integration tests: `init` exits 4 for a factory folder inside a git work tree, inside another factory folder, and above one of its projects.
- [ ] Integration test on a separate tmux server (`TMUX_TMPDIR` in a temp folder, the same effect as `tmux -L`) with a fake `claude` on PATH: `factory start` makes the session with the windows `view` and `workers`. The fake records `--permission-mode auto`, no inherited `ANTHROPIC_BASE_URL`, and one `--add-dir` per project. A second `factory start` starts no second coordinator.
- [ ] Unit tests: each role template passes the deny list and has its required sections. `factory node add-child` exits 4 for a child from another layer. `roleForLayer(0)`, `roleForLayer(1)` and `roleForLayer(2)` return worker, coordinator and manager. `roleForLayer(3)` returns no template. `init --layer 3` writes the `safety` block and no role block, and prints a warning. `doctor` warns on a layer-3 node and names the layer.
- [ ] Migration test: a node that the FAC-M1 0.1.0 tarball wrote upgrades to schema 2, with `tracker.kind: local`. After the upgrade, `factory doctor` exits 0.
- [ ] Unit test with a fake platform `win32`: every command exits 4 and prints the WSL hint.
- [ ] Unit tests: the config refuses an `ssh://`, `https://` or relative address in `parent` and in `children`, and names the key.
- [ ] Factory list, integration test with a temp HOME and a temp `XDG_STATE_HOME`: after `init --yes` in the repo `web`, `factory start --dry-run` from `web/` and from `web/src` finds `web-factory` and exits 0. From a folder that is in no entry, it exits 2 and prints the hint. Two factory folders that list the same project give exit 2 and name both folders. The list file is under `XDG_STATE_HOME`, a static test finds no path under `~/.claude`, and a factory folder that no longer exists is ignored.
- [ ] Workspace folder, integration test: a temp folder holds the git repos `web/` and `api/`, and `web-search/` as a linked worktree of `web`. `init --yes` there makes `./<folder>-factory`, lists `web` and `api`, names `web-search` as skipped, and exits 0. `init --home .` there exits 4 and names the rule. With no terminal window and no `--yes`, `init` prints the proposal and exits 2.
- [ ] Clone path, unit test with a fake `git`: `init --project https://host/acme/api.git` runs `git clone -- <url> <folder of the home>/api`. A target that exists and has another origin gives exit 4. A URL whose repo name has `..` or starts with `-` gives exit 2.
- [ ] Glossary test: every term in the list `terms` of `src/names.ts` has an entry in `docs/glossary.md` and in `factory help words`. An entry has at most 25 words. The two texts are equal. The output has no deny-list word.
- [ ] The deny-list test has the patterns `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED`. No template and no file that `init` writes contains one.
- [ ] Helper test: the short-output helper has three checks: at most 20 lines, a non-empty first line, and a first line of at most 120 characters. It accepts 20 lines. It fails on 21 lines, on an empty first line and on a first line of 121 characters. It does not read the words of the first line. The default output of `factory start` (with no `--dry-run`) and of `node children` passes it.
- [ ] `scripts/check-review-scope.sh docs/reviews/fac-m2-review-summary.md` exits 0. It fails when the summary does not list `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/doctor.ts` and the files under `src/upgrade/`.
- [ ] `scripts/check-intent-docs.sh` exits 0. It exits 1 when one of these checks fails:
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
- [ ] `npm run exit-check` passes with the v2 flow: `init`, `start --dry-run`, `doctor`, deny list, and the docs check.

### FAC-M4: Worker control

**Goal.** factory starts, talks to, resets, stops and restores workers, with no read under `~/.claude`. The lifecycle verbs `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` work, and each has a named test.

**Scope.** `worker new|list|send|relay|reset|stop|resume|summon|watch|recover|adopt`, `shutdown`, `restart`, `reboot`, `status`, `dismiss`, `layout`, `machine`, `project add|remove|list`, `self reset` and `inbox next|ack`. The workers and view windows (F-8). The last-seen hook and the status line wrapper (F-9). The doorbell inbox (D-55). The recovery after a machine restart in `start`. The idle setting `limits.idle_after`. The agent setting `session.agent`.

**The doorbell inbox (D-55).** It is the only way to send message text to a worker:
- `worker send` writes one numbered record per message into `.factory/workers/<id>/inbox/`, then rings one constant short line in the worker. The line has no message text.
- The worker acknowledges a record when it moves the record to `handled/`. `worker watch` rings again for a record that waits too long, with a fixed bound on the rings.
- `worker relay` keeps owner authority in the typed line. The line names the record number and a short hash of the record. A record alone never carries authority.
- `worker reset --assignment` and `worker recover` send their text with `worker send`.
- All of it lives in the comms module (`src/comms/`, design §4.12) with one interface (`send`, `deliver`, `report`, `ping`) and a versioned record format. Only this module types into a pane.

**Tasks.**
1. **Session-stop test (F-7).** First write the rule for the word "safe" at the top of `docs/session-stop.md` (design §4.11). Then, in a throw-away session, try `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. Try each way twice: on an idle session, and on a busy session (a tool runs and a background agent runs). Write one row for each way and each case into the table. Then `factory worker stop` uses the way that the table marks safe for the case of the worker. Until then, the rule is: stop only an idle session, then `kill -TERM`. This task does not run before FAC-M4 starts.
2. **Fixtures from the real program (F-9).** Capture one payload for each hook event (SessionStart, Stop, PreCompact) and one status line payload from the installed Claude Code. Commit them in `test/fixtures/claude/` with the Claude Code version. If the status line payload has no context percent, name the other source in design §4.6 before the hook is built.
3. The last-seen hook, the status line wrapper and the last-seen reader.
4. **Inbox access test.** Before the inbox build, check that a worker in auto mode can read and move files in its inbox under the factory folder with no permission prompt. The worker gets its inbox folder through `--add-dir`. Record the result in `docs/session-stop.md` or a short note next to it.
5. The doorbell inbox.
6. The worker commands, the layout and the recovery after a machine restart.
7. The lifecycle verbs `start` (with the recovery), `shutdown`, `restart`, `reboot`, `status` and `dismiss`, and the setting `limits.idle_after` (shared, default 2h, bound 1m to 24h, read with the interval parser of the config schema).

**Exit criteria.**
- [ ] `docs/session-stop.md` has the rule for "safe" before the table, and one row for each way and each case (idle and busy), with the four facts and the verdict. `scripts/check-session-stop.sh` exits 0 only when the rule and all 12 rows are there (a `/quit` row may say "not available"). `factory worker stop` uses the way that the table marks safe for the case, and a test with a fake session checks it. A busy worker with no safe way gives exit 3 and names what runs (test).
- [ ] Tests on a separate tmux server:
  - `worker new` makes a pane in the window `workers` with the pane option `@worker`;
  - `worker summon` shows the pane in the view slot, and the slot shows the board again after the time;
  - `restart` resumes one worker with its session id from the last-seen file, and the other workers keep their panes.
- [ ] Start, with recovery after a machine restart. Test `start resumes the recorded workers after kill-server` (`test/integration/start.test.ts`, own tmux server, fake `claude` records `--resume <id>`): start a node with two workers, run `tmux kill-server` for that server, then run `factory start`. The coordinator starts, and each worker resumes with the session id from its last-seen file. A last-seen value that is not a UUID is refused, and a session id for a worker that the state does not know is refused.
- [ ] Shutdown. Test `shutdown stops only the sessions of this factory` (`test/integration/shutdown.test.ts`): a session with the same name and no home option survives, and `shutdown` exits 4.
- [ ] Restart. Test `restart resumes one worker with its session id` (`test/integration/restart.test.ts`): the other workers keep their panes.
- [ ] Reboot. Test `reboot stops and starts every worker of this factory` (`test/integration/reboot.test.ts`): after `reboot`, each recorded worker runs again with its session id, through the same resume path as `start`. A session of another factory, a session with the same name and another home option, and a `claude` process outside the factory panes keep running.
- [ ] Status. Test `status lists each worker with its state, work item and idle state` (`test/unit/status.test.ts`), through the builder that FAC-M5 extends. A worker with no activity for longer than `limits.idle_after` and no open work in progress shows "idle"; a worker with open work does not. The work item column shows the current work, so an old worker name is visible.
- [ ] Dismiss. Test `dismiss frees a work copy only when its work is pushed` (`test/integration/dismiss.test.ts`): it refuses an unpushed branch, an untracked file and a stale remote ref, keeps the primary clone, refuses a path outside the factory folder, and prints `STUCK:`. Test `dismiss --idle lists the idle workers and refuses a busy worker` (`test/integration/dismiss.test.ts`): the first run lists the idle workers and changes nothing; the owner picks workers on a fake terminal window; only the panes and processes that factory started for those workers end; a session with the same name and another home option keeps running; a busy worker is refused with a remedy line (exit 1); the pick step with `FACTORY_SESSION` set exits 4.
- [ ] One active machine. Test `start warns when another machine is active` (`test/integration/start.test.ts`): the test reads a `.factory` that came through the FAC-M3 state pull, so this criterion depends on FAC-M3 (`state remote`, `push`, `pull`). Concurrent use is in the FAC-M8 criteria.
- [ ] A received factory starts after one `init` (F-18f, TP-29 extended). Integration test: a fixture config repo is cloned into a temporary HOME; `init` with a fake terminal accepts the setup text, clones the projects and registers the factory; then `start --dry-run` and `doctor` exit 0. The fake terminal answers each prompt of design §4.3: the personal values, the mode of each approval point, the setup acceptance and the write of the hook. With no terminal window, `init` stops on a received factory that tracks other files, also with `--yes` (test).
- [ ] Work copy outside the factory folder (OD-7). Integration test: a work copy that sits outside the factory folder finds its factory through the common git folder of the clone of its project, and `status` from there exits 0. A folder that is a work copy of no listed project exits 2 and prints the hint.
- [ ] Settings in work copies. Before a worker starts in a work copy, the check for a setting that skips permission prompts runs on the settings files of that work copy. A skip setting makes the worker start exit 4 with one remedy line (test).
- [ ] Every launch test asserts auto mode, and a proxy only from the config with the check before the launch.
- [ ] Fixture tests: each hook payload fixture has a session id and an event name, and the status line fixture has a context percent. The hook parses the fixtures and writes the last-seen line with those values.
- [ ] Status line wrapper test: with `session.statusline` set to a fake command that prints a marker, `factory hook statusline` prints exactly the output of that command and writes the last-seen line. With the key unset, it prints `context N%`.
- [ ] Settings consent test (fake terminal window and none): `worker new` and `start` print the exact hook and status line change and its target file before any write. With no terminal window and no `--yes`, they write nothing and exit 2. With `--yes`, they write only `.claude/settings.json` or `.claude/settings.local.json` in the factory folder or the work copy. A test HOME shows that no file under `$HOME/.claude` changes. An existing status line command still prints its output through the wrapper.
- [ ] Integration test: the hook writes the last-seen line on each event (fake hook input).
- [ ] Static test: no source file opens a path under `~/.claude`, and no template contains such a path.
- [ ] `worker relay` types the owner prefix only for a decision with `by: owner` in the log; a test covers the refusal. The test uses a fixture decision log, because `factory decide` comes in FAC-M5.
- [ ] Inbox tests: `worker send` writes a numbered record and types only the constant line (a capture shows no message text); two sends give two records in order; a record moved to `handled/` stops the rings; `worker watch` rings again for a waiting record and stops at its bound; the relay line names the record number and its hash.
- [ ] `inbox next` prints the oldest unhandled record, and `inbox ack <n>` moves record `n` to `handled/`. Both exit 2 when `FACTORY_INBOX` is not set (tests).
- [ ] A test with a fake session: after a clear or a restart, the worker finds its waiting records in the inbox.
- [ ] Static test: no module outside `src/comms/` reads or writes inbox files, and only `src/comms/` calls tmux `send-keys`. A unit test shows that a typed line of more than 300 characters is refused. A test with a fake comms module shows that `worker reset --assignment` and `worker recover` use `worker send`.
- [ ] `worker list` marks a worker above `context_prepare_pct` as `PREPARE` and above `context_max_pct` as `MAX`, with fake last-seen values at 29, 30, 40 and 41 percent.
- [ ] `session.agent: claude` loads. Any other value fails and names the key. A static test finds no start of an agent program except through `session.agent`.
- [ ] `machine` tests: fixture files for macOS (`memory_pressure` and `sysctl` output) and for Linux (`/proc/meminfo`, `/proc/loadavg`) give the same verdict format, with a fake platform for each. `worker new` refuses a work copy that another worker uses, and refuses when a resource limit fails (fake machine facts).
- [ ] `project add|remove|list` change only `recipe.projects[]`, keep the comments of `factory.yaml`, and refuse a project path that the folder rules refuse (tests).
- [ ] `self reset` exits 3 and names the file when the resume file `.factory/resume/<node id>.md` is missing. With the file, it asks `src/comms/` to type `/compact` with a hint that names the file (fake comms).
- [ ] The job commands of this milestone pass the short-output helper, and `docs/token-budget.md` has a measured size for each of them.

### FAC-M5: Local board, check and release commands

**Goal.** The board, the requests and the decisions work with the `local` board. The merge check, the merge and the release checks are one command each, with a short verdict. The report of one node exists, so `status` works before FAC-M7.

**Scope.**
1. **Local board (F-2).** The connector contract of design §4.10 and the `local` connector (files in `.factory/`; also the test double of later connectors). The commands `item`, `request`, `decide <D-n> <option>` (for `local`) and `queue`. The decision log and the decision profile tools. The state commit helper and the delete-guard hook.
2. **Check and release (F-6).** `check`, `pr merge` (with both modes of the approval point `merge` and the proofs of design §6.1), `pr watch`, `issues audit`, `release check|verify|scope`. The approval point `release` with its proof (design §6.2).
3. **`factory copies list|status|sync|clean` (D-55).**
4. **Report core.** `factory report` and `factory status` for one node, with no children: worker states, board counts, the items in progress, the requests and the events that scripts write at merge, release and decision. The rollup over children stays in FAC-M8. `lock run`. The view slot shows `factory item list`.
5. **Token budget.** `scripts/budget-check.sh`.
6. **Proxy host warning.** `doctor` warns when the proxy host is not loopback, because the proxy host receives the API traffic of the node.
7. **Extension points (design §4.14).** The event file and `report --json` hold the fields of design §4.14, and a sample reader outside `src/` (in `examples/`) reads them.
8. **Delegation control outside factory (D-10 A).** The session settings that factory renders hold deny rules for the record commands and for the store path of the approval records.
9. **Acceptance of shared check commands.** A check command from the shared file runs only after the owner accepts it (design §4.4).
10. **Usage view and token estimate (F-22, F-23).** `factory status --usage` shows the token use, the limits and the work counts of the factory. `factory item estimate <id>` gives a token range for a work item from the closed items. Both read only data that factory records: the last-seen files, the hook and status line data (design §4.6) and the board. They never read a file under `~/.claude`. If the status line data has token, cost or limit fields, the hook records them in the last-seen line. The FAC-M5 plan adds the flag and the subcommand to design §4.2.

**`factory copies` (D-55).** The coordinator's repeated git work across work copies becomes four commands. Workers do their own git work on their own branch.
- `list`: one row per work copy: project, path, worker, branch, short HEAD.
- `status`: for each work copy, the dirty files, ahead and behind, unpushed commits, and whether the branch is on the remote. One verdict line with counts.
- `sync <pr|branch>`: a base update of a waiting PR. It merges `origin/<default>` into the branch in a short-lived worktree under `.factory/state/`, pushes with no force, and removes the worktree. On a conflict it stops and names the files.
- `clean [--apply]`: it takes over `factory clean`. It removes a work copy only when no worker holds it, no item or resume file names it, the tip is on the remote, the tree is clean and the PR is merged.
- Safety rules from firstmate: a default branch moves only by fast-forward. A dirty, diverged or off-default work copy is reported as `STUCK:` and left untouched. Batch commands continue after a failure and give a count at the end (from mars).
- The commands extend `src/core/git.ts`; there is no second git module.

**Exit criteria.**
- [ ] Connector contract tests run against `local`. FAC-M3 runs the same set against `github`.
- [ ] With `local`: `changes read` returns nothing, and `factory decide <D-n> <option>` records `by: owner`. `factory decide` refuses (exit 4) with no terminal window, and when `FACTORY_SESSION` is set.
- [ ] `item`, `request` and `queue` change only the `local` files, and every change is one commit in the state repo (test).
- [ ] `init` sets `core.hooksPath`. The commit helper refuses when the hook is off. The hook refuses a commit that removes an item id from `board.json` (tests).
- [ ] No command needs `python3`, `jq` or `glow` (a test runs the commands with a PATH that does not contain them).
- [ ] `check` gives the same verdict as the manual merge check on 3 merged PRs, from recorded fixtures.
- [ ] `check` exits 3 with `NOT READY` while the PR has an open ask or an open request, and gives `READY` after the item closes (tests).
- [ ] `pr merge` tests with `merge: owner`: it refuses with no owner decision or answered ask for that PR and head; it refuses when the head changed after `check`.
- [ ] `pr merge` tests with `merge: delegated`. There is one test for each proof of design §6.1:
  - (a) a decision with `by: owner`;
  - (b) an ask answered `approve` from the owner's account;
  - (c) an approved plan: an ask or decision item that names the plan path and commit SHA, answered `approve` by the owner's account (`local`: `factory decide` from a fake terminal window with no `FACTORY_SESSION`).

  Each test runs three times: with a direct assignment, with an assignment by a second decision, and with an assignee or `worker:<id>` label set by the owner's account. Each run merges.
- [ ] Release proof. Test: with `release: delegated`, `release check` refuses (exit 4) when no owner-approved release scope names the version. `release scope <project> <version>` writes the scope in a terminal window outside a factory session, and refuses (exit 4) with no terminal window and with `FACTORY_SESSION` set. After the scope, `release check` passes. A new scope does not change a delegation: after `release scope`, the effective mode of `release` stays `delegated`, and `doctor` lists the delegation with its old time.
- [ ] Desk extension points. Test: the event file and `report --json` of a fixture node hold the fields that design §4.14 lists. A sample reader outside `src/` (in `examples/`) reads the event file and `report --json` of the fixture node and prints one line per work item. The test runs it.
- [ ] Delegation control outside factory. Test: the session settings that factory renders hold deny rules for the record commands and for the store path, and a test reads the rendered settings. Design §6 keeps the limit text. The deny rules make the gap smaller. They do not close it.
- [ ] Shared check commands. Test: a check command from the shared file does not run before the owner accepts it, and runs after the acceptance.
- [ ] `pr merge` refuses, with a message that names the proof that is absent, in these cases:
  - approval with no assignment;
  - a decision by another account;
  - a record for another PR or head;
  - a plan file with `Status: approved` in a commit by the owner's account, with no answered ask or decision item;
  - an assignee or label set by another account;
  - chat text with no record.
- [ ] Board identity tests (design §4.10, §6.1), with a fake connector that gives events with an author. The `github` connector comes in FAC-M3 and runs the same tests.
  - Shared account (`tracker.agent_account` unset, or equal to the owner account): an owner comment `approve`, an owner assignee and an owner `worker:<id>` label are each refused as a proof, and the message names the shared account. A decision from `factory decide` on a fake terminal window with no `FACTORY_SESSION` is accepted, and `pr merge` merges.
  - Separate accounts: the same owner events are accepted, and `pr merge` merges. The same events with the agent account as author are refused.
- [ ] `doctor` warns, with the fix, when the board kind is not `local` and `tracker.agent_account` is unset or equal to the owner account. The config accepts the key, and a value that looks like a password or a token in it fails (tests).
- [ ] The README setup section tells the owner how to give the agents their own board identity (a machine user or an app). A docs check finds the section.
- [ ] Config test: the approval point `release` loads with `owner` or `delegated`, and an absent key means `owner`. Any other value fails and names the key. `release check|verify` only read; a test asserts that they run no publish command.
- [ ] `copies clean` is a dry run by default, and refuses a work copy with unpushed work or a path that a worker or resume file names. `factory clean` does not exist as a second command.
- [ ] `copies list` and `copies status` give the right rows and counts on fixture repos with linked worktrees: clean, dirty, unpushed, branch not on the remote. They ask git, never a `.git` folder test.
- [ ] `copies sync` tests on fixture repos: a clean merge pushes with no force and removes its worktree; a conflict stops, names the files and leaves no worktree; the worker's own work copy does not change.
- [ ] A dirty, diverged or off-default work copy shows `STUCK:`, and no command changes it (test).
- [ ] Report tests: `report --json` has the keys of design §5.4 for a node with fixture workers and no children. `--since` returns only newer events. `pr merge`, `release verify` and `decide` each add one event to `.factory/outbox/`. A static test shows that `status` calls the same builder as `report`.
- [ ] `lock run` tests: with a fake platform `darwin` it uses `lockf`, and with `linux` it uses `flock`. A second run waits and stops at its bound with exit 3. The exit code of the inner command passes through.
- [ ] A tmux test: the view slot pane shows the item titles of a fixture `local` board.
- [ ] `scripts/budget-check.sh` exits 0 for the jobs built so far. It exits 1 when a fixture output is more than twice the figure in `docs/token-budget.md` (test with an inflated output).
- [ ] Template test: the coordinator role text and the fixed rules follow the approval setting. With `merge: owner`, the text says that every merge waits for the owner. With `merge: delegated`, it names the proofs of design §6.1 and does not say that every merge waits.
- [ ] Unit test: `doctor` warns, with the fix, when the host of a configured proxy is not loopback (`127.0.0.1`, `::1` or `localhost`). It gives no such warning for a loopback host.
- [ ] Usage view (F-22). Test `status --usage shows tokens, limits and work counts for two subscriptions` (`test/unit/status-usage.test.ts`), on a fixture of last-seen lines and closed items for two subscriptions. For each subscription and each model, the output shows the token use for today, this week and this month. When a session uses a relay server, the output also splits the token use by the relay server address, which the local file holds; the fixture has one session with a relay server. It shows the quota or weekly limit percent when the data of the subscription has one, and `-` when it has none. The fixture has one subscription of each kind. The output also shows the work counts (items closed and lines changed) for the three periods, and the tokens of each work item. Line 1 is the verdict, and the output follows the output rule (at most 20 lines, checked with the short-output helper). The static test of FAC-M4 (no source file opens a path under `~/.claude`) covers this code.
- [ ] Token estimate (F-23). Test `item estimate gives a token range from closed items` (`test/unit/item-estimate.test.ts`), on a fixture of closed items with measured tokens. With at least N similar closed items, `factory item estimate <id>` prints a token range and its basis (the closed items that it used) and exits 0. With fewer, it prints `NO BASIS` on line 1 and exits 3. N is a named number in `src/names.ts`, with the proposed value 3. The output follows the output rule. `docs/token-budget.md` keeps its 17 rows, because design §3 lists no job for these two commands (docs check 6).

### FAC-M6: devflow setup

**Goal.** A project can use the devflow setup of the `software` recipe. The coordinator knows which project uses which setup. The core works with no `software` recipe. A person can share a setup, and the owner accepts every setup file.

**Scope.** `factory recipe show` and `factory recipe variant devflow --project P` (the key `variant` names the setup), the devflow setup file (design §2.2), the worker addendum, the proxy preset with its real values, the `projects` block of the coordinator template (design §5.2), the assignment of `worker new --project P` with the stage commands of the setup of P only, and a test recipe in the test folder. The shareable setup (design §4.13): the setup files in the tracked `setup/` folder, a priorities rule that a second factory folder shows, and a desk reader as a setup file (design §4.14).

**Exit criteria.**
- [ ] `recipe variant devflow` runs `detect`, offers `install` only after a yes, and writes the setup into the project entry (test with a fake `devflow`).
- [ ] `check` finds devflow's review and resolution markers on a recorded real devflow PR.
- [ ] The core source and the default templates contain no devflow word and none of the three triage words (the deny list test).
- [ ] Coordinator knowledge, integration test: a node with the project `a` (plain) and the project `b` (devflow). The `projects` block of the coordinator `CLAUDE.md` lists both setups and their stage commands. The assignment of a worker of `b` has the devflow stage commands. The assignment of a worker of `a` passes the deny list. `recipe show` prints the same table as the block.
- [ ] Same-layer test: two layer-1 nodes with different project sets have the same managed text, except the `projects` block (a hash compare of the text with that block cut out).
- [ ] Core independence: a dependency test finds no import of `src/recipes/` in `src/core/`, `src/config/` or `src/comms/`. A test recipe `document` (in `test/`, with no git and the output `document`) is registered through `Deps` and passes `init`, `start --dry-run`, `doctor` and `report`.
- [ ] Proxy preset, tests with a stub HTTP server: the preset has the health path `/__subswitch/health` and the port 4141. When the stub answers that path, a worker launches (fake `claude`) with `ANTHROPIC_BASE_URL` set to the stub. When the stub is dead, the launch stops with the fix message and starts nothing. `workers.<id>.proxy: none` wins over `session.proxy: subswitch` of the node.
- [ ] Shareable setup. Test: a setup folder with a priorities rule and a desk reader as a setup file travels in the config repo. A second factory folder made from that repo shows the priorities rule in its coordinator text and runs the reader.
- [ ] Upgrades never overwrite a setup file. Test: `upgrade` leaves every file under `setup/` as it was, also when the package text of the same name changed.
- [ ] Setup acceptance of every setup file. Test: a setup commit that adds or changes a hook, a script, a settings file or a role text makes `start` with no terminal window exit 4, and makes `start` in a terminal window ask, until the owner accepts the new commit in a terminal window. This extends the acceptance of the setup hash from `setup/coordinator.md` (design §4.3) to every setup file. The accept command with `FACTORY_SESSION` set exits 4.

### FAC-M7: This workspace adopted (local board)

**Goal.** This workspace runs on factory with the `local` board. The old review page and its scripts stay as the owner view until FAC-M3 retires them.

**Scope.** `factory adopt` (design §8):
- a factory folder next to the projects;
- the move of the coordinator text out of the folder above the work copies;
- the import of the board and the items that wait for the owner into the `local` board files;
- the approval point `merge` set to `delegated` by the owner, and the devflow setup for the devflow projects;
- workers in the window `workers`, and `session.statusline` set to the status line command of the owner;
- one worker run through the real Subswitch.

The import into GitHub issues is not here: it is FAC-M3.

**Owner view in the `local` period.** The review page and its scripts of today stay in use. They read the `local` files, which have the same format. The owner answers a decision in the page or with `factory decide <D-n> <option>` in a terminal window outside any factory session. FAC-M7 does not retire the scripts. FAC-M3 does.

**Exit criteria.**
- [ ] `factory adopt --dry-run` prints the plan, and a test checks it against a fixture copy of the workspace. The plan shows the move of the coordinator text.
- [ ] The adopt imports the fixture board and the fixture owner items into the `local` files with no loss: a test compares the item ids and titles before and after.
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

### FAC-M3: GitHub board, and the move to it

**Goal.** The board, the requests and the decisions of this workspace move from the `local` board to GitHub. A script reads the owner's answers. The user picks the board tool at setup. The old page and scripts are retired. A second machine of the owner gets the profile.

**Scope.**
1. The `github` connector (issues plus a Projects board, through `gh`) behind the FAC-M5 contract. The contract has the `doc` operation (attach a file, link a repo file) and `changes read` (comments, label changes, assignee changes, open or close changes, each with its author; card moves are out for now). One GitHub project holds the issues of all the repos of a factory (design §4.10).
2. The commands `decide ask|read` and `watch`. `start` starts `watch` in the window `ops` when the board is not `local`.
3. The choice of the board: `init --tracker --items --decisions`, the question in a terminal window, `tracker set`, `tracker status`, and the per-project override (design §4.10).
4. `item import` from the `local` files into a team board, and the move of this workspace's items into GitHub issues with a private decision store. The retirement of the old page and scripts.
5. The state remote: `state remote|push|pull`, `init --state-from`, and the rule that `state pull` and `upgrade` move by fast-forward only (firstmate idea 8).

**Exit criteria.**
- [ ] One board for two repos. A recorded run of real `gh project` commands on a private throw-away project that holds the issues of two repos: create the project, `item-add` from each repo, one `item-list` with `--limit` that lists the items of both repos, `--query` with a filter by repo, and a field edit. The record holds commands and field names only, no ids and no URLs. Then a connector test with recorded responses prints a "more than <cap>" line when the list exceeds the cap.
- [ ] The FAC-M5 connector contract tests pass against `github`, with a fake `gh` and recorded responses. No test needs the network. The tests name the `doc` operation: one attaches a file, one links a repo file.
- [ ] With `local`, `factory watch` exits at once with a note.
- [ ] `decide read` records an answer `/choose B` or a label `choose:B` from the owner's account. It ignores the same answer from another account. Tests cover both cases.
- [ ] `doctor` fails on a public decision store and warns on an unset one (fake `gh` responses).
- [ ] `watch` stops after its read bound, and wakes only on a new answer or mention (unit tests with a fake clock).
- [ ] Wake test on a separate tmux server with a fake `gh`. An owner comment `/choose B`, a label change, an assignee change and an issue close each cause one record in `.factory/inbox/` and one constant doorbell line in the coordinator pane. The same events from another account cause none. A fake `claude` on PATH records no call during `watch`.
- [ ] `start --dry-run` with `github` lists the window `ops` with `factory watch`. With `local`, it lists no `ops` window.
- [ ] Board choice, tests with a fake `gh`: `init --tracker github --items acme/web --decisions acme/decisions --yes` makes a node, and `factory doctor` exits 0. When the fake says that the decision repo is public, `init` exits 4 and writes no file, and `doctor` fails on such a config. `tracker status` prints `github`.
- [ ] Override test: a node with the default `github` and a project with `kind: local`. `item add --project P` goes to the `local` files, and an item with no project goes to the fake `gh`. `tracker status` prints both.
- [ ] `item import` moves the `local` files (fixture `board.json` and `waiting.json`) into `github` items, and a second run creates no duplicates.
- [ ] State remote, integration test: machine A makes a state repo and pushes it to a bare repo path. Machine B (a temp HOME) runs `init --state-from <path>`. The profile index equals the one of machine A, and `doctor` exits 0. `state pull` with a diverged remote exits 1 and changes nothing. With a dirty `.factory/`, `state pull` and `upgrade` stop, name the files and change nothing.
- [ ] The old render and board scripts are not called by any process (a search of the tmux hooks and the cron list finds none). `scripts/check-parity.sh FAC-M3` exits 0 for all rows.
- [ ] State pull and the second machine. Test: a state pull brings a `.factory` to a second factory folder, and the FAC-M4 test `start warns when another machine is active` reads it.
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

**Scope.** The release workflow (tests, version check, GitHub Release, npm publish in a protected environment, tap update), `install.sh` with a SHA256 check, the Homebrew formula in `dean0x/homebrew-tap`, `scripts/release-gate.sh`, and `docs/release-approval.md` (design §4.7). The version lives in `package.json` only. The first real publish is out of scope: it runs after the owner writes a decision id in `docs/release-approval.md`, and the gate script blocks it until then.

**Exit criteria.**
- [ ] `scripts/check-release-workflow.sh` (no network) exits 0 only when: the job `publish` has `environment: npm-publish`; no other job runs `npm publish`; the first step of `publish` runs `scripts/release-gate.sh`; and no file but `package.json` holds the version.
- [ ] `scripts/release-gate.sh` tests: it exits 1 when `docs/release-approval.md` has no line `Decision: D-<n>`; it exits 1 when the tag version differs from the version in `package.json`; it exits 0 with both.
- [ ] `scripts/check-environment.sh` (a read-only `gh api` call, run with the token of the owner) exits 0 only when the environment `npm-publish` has the owner as a required reviewer. The output is saved in `docs/reviews/`.
- [ ] `scripts/check-private.sh` exits 1 when the repo is public and `docs/release-approval.md` has no decision id. It exits 0 when the repo is private.
- [ ] `install.sh` tests with a local file base: a good tarball with its SHA256 installs and runs `factory --version`, and a second run is safe. A tampered tarball exits 1 and installs nothing.
- [ ] `scripts/check-formula.sh` exits 0 when the `url` and `sha256` of the Homebrew formula match the release asset (fixture release), and exits 1 on a mismatch.
- [ ] Clean machine: a script in a clean Linux container, and the same script on a macOS runner, runs `npm i -g` from the tarball of `npm pack` with a throw-away HOME and a fake `gh`. Then `factory init --yes --tracker github` in a temp repo, `factory start --dry-run` and `factory doctor` all exit 0. The script edits no file by hand.
- [ ] CI runs the workflow up to `npm publish --dry-run`, and the dry run exits 0.

### FAC-M9: Jira and Linear connectors

**Goal.** A team that uses Jira or Linear gets the same board features. FAC-M9 follows FAC-M3, so the board contract is proven with GitHub first.

**Exit criteria.**
- [ ] The connector contract tests (FAC-M5) pass for `jira` and `linear` with recorded responses, as they do for `local` and `github`.
- [ ] One board for many repos. A connector test with recorded responses for each tool lists, in one board view, the work items of two projects (Jira) or two teams (Linear) that map to two repos of the factory, with a filter by repo.
- [ ] `doctor` checks the decision store privacy for each connector.
- [ ] `tracker set jira` with no `site` exits 2 and names `site`. `tracker set linear` with no `key` exits 2 and names `key`.
- [ ] Mixed test with fakes: a node with a `github` project and a `jira` project. `item add --project P` goes to the connector of P, and `tracker status` prints both.

## Design v3 PR (after FAC-M2)

The design v3 PR comes after the FAC-M2 merge and before FAC-M4. It brings D-59, D-60 and Dean's notes F-14 to F-21 into the design, this roadmap, the trace and the code. It is two PRs (D-12 B): the docs PR first, then the code PR. Nothing is released, so both PRs are releasable at merge. Each PR has one checkbox. The first commit of the code PR ticks the first box, because the docs PR is merged by then. The last commit of the code PR ticks the second box. `scripts/check-intent-docs.sh` finds these two boxes under this heading, because rows of `docs/intent-trace.md` name the label "Design v3 PR".

- [x] Docs PR (branch `design-v3`): the design text, this roadmap, the token budget, the intent trace and the glossary in plain words, the plain-words table and its scan, and the docs checks 8, 9 and 10. No file under `src/` changes.
- [ ] Code PR (branch `design-v3-code`): the code and test changes of the points below.

There is one checkbox for each of the eight points of Dean's request, in the same order:

- [ ] Point 1, plain words (F-14, D-59). `docs/glossary.md` and `test/helpers/plain-words.ts` hold the plain-words table, and the glossary teaches the new words (worker, request, assignment, session reset, queue, check, release check and the others). An old word shows there only in the mark `(was: old word)`. The docs scan finds none of the eight old words (the words of the setup of today, design §7) and no scanned jargon word in the design, this roadmap, the token budget and the glossary, outside code, the mapping tables, the `(was: old word)` mark and a named list of allowed lines. In the code PR, `src/names.ts` and `src/glossary.ts` rename the program words to the new words, and then the glossary test compares the program text with `docs/glossary.md` again. Until then, the glossary test accepts the state of the docs PR. Also in the code PR, `src/names.ts` holds no user value for an old word, it has one worker role key, no two role values and no two term values are equal, and the pane option is `@worker`. The names test and the glossary test pass.
- [ ] Point 2, a shared factory travels (F-18, D-60). The factory folder is one git repo with `factory.yaml`, the setup (`setup/coordinator.md` and the worker role text `setup/roles/worker.md`, both built in the code PR) and a share list. The personal and one-machine keys are in the ignored file `factory.local.yaml`. `init` on a received factory registers it after the owner accepts the files. A config counts only when the registration check passes. The test that a received factory starts after one `init` is a FAC-M4 criterion (TP-29 extended). Another developer can not install the factory program before FAC-M10, so the received-factory test uses the program from the repo. A move of the work state to a second machine is in FAC-M3 (`init --state-from`). The reason for FAC-M4: one of the prompts is the write of the hook, and FAC-M4 builds the hook. The code PR has the first test (TP-29), without that prompt.
- [ ] Point 3, recipe words stay in the recipe, and approval points (F-15). Docs check 10 reads the core parts of the design and of the glossary: the summary, §4.1, the core commands of §4.2, the table "Rules for every factory" in §6, and the part "Words of every factory" of the glossary. They hold no word of the software recipe: merge, pull request, release, CI log, PR, CI, git and tmux. The summary, §4.1 and the glossary part may use such a word in a line that starts with `Software recipe:` or `Engineering note:`. §4.2 and §6 have no such line. In the code PR, the software recipe lists the approval points `merge` and `release`, owns its words, and `init` asks for each point with `owner` as the default. Only the approval record writer writes an approval record, and only in a terminal window outside a factory session.
- [ ] Point 4, core and setup (F-16). Design has the headings "Core and setup" and "Extension points" (docs check 9). The table lists priorities, lifecycle, review rules, role texts and scripts as setup, and the fixed rules as core. The owner accepts the hash of `setup/coordinator.md` and of `setup/roles/worker.md`, and FAC-M6 extends the acceptance to every setup file. The code PR builds both files in the same step.
- [ ] Point 5, few stops (F-17). Only a security boundary stops a command (exit 4), and every stop prints one line with the remedy command. Every other check is a warning. Design §4.3 lists the stops and the warnings in a table, each with its remedy command. factory has no desk command and no desk row in the command map (docs check 3).
- [ ] Point 6, one board for many repos (F-19). Design §4.10 answers in plain words: "Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos." It gives the list bound, the filter and the owner rule. For Jira and Linear it says "Not checked yet: FAC-M9". FAC-M3 proves the GitHub answer with a real run on two repos, and FAC-M9 checks Jira and Linear.
- [ ] Point 7, lifecycle, idle workers and dismiss (F-20, F-21). `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` each have a line in design §4.2 and a named test in FAC-M4. `start` resumes the recorded workers after a machine restart. Design §4.11 defines idle: no activity for `limits.idle_after` (default 2h) and no open work in progress. `status` shows the idle state and the work item of each worker. `dismiss --idle` lists the idle workers first, and the owner picks. FAC-M7 names the change of the old worker names of this workspace.
- [ ] Point 8, the leftovers of FAC-M2.
  - Factory folder lookup (moved from FAC-M2: F-3b, V-F-3b, Gap 1). D-60 makes the factory one folder. The factory folder holds `factory.yaml`, so the walk up finds it from the factory folder and from every folder below. Integration test: `start --dry-run` and `doctor` exit 0 from the factory folder, from the coordinator folder and from a project clone.
  - Schema 2 changes in place, before any release. The schema 1 migration writes the new keys. No migration from schema 2 to schema 3 is needed. Migration test: a FAC-M1 node upgrades, and `doctor` then exits 0.
  - A project entry can hold a clone URL, so one repo list can set up the factory on a second machine (as in mars, D-60). Config test: the entry accepts a URL with no user name and no password.
  - No local machine path in the docs (docs check 8).

## Later (no milestone yet)

- Other recipes, for example research or content (F-10). A user-made setup comes with FAC-M6, and a user-made recipe needs no new milestone: the test recipe of the code PR shows that `init`, the block render, `doctor`, `upgrade` and `start --dry-run` run with a second recipe.
- No review desk of its own, not even as an option (F-2, F-17). A person who wants one builds a reader on an extension point (design §4.14).

## Decisions needed

- None blocks the FAC-M2 code.
- Answered (D-59, F-14): the glossary words. Dean chose worker, request and coordinator, and queue, check and release check. The rename comes in the design v3 PR, not in FAC-M2.
- Answered (D-57): the release is an approval point of its own, with the values `owner` and `delegated`. The proof for `delegated` is an owner-approved release scope. FAC-M5 builds the check (design §6.2).
- Before FAC-M3 (after the workspace move in FAC-M7): which private repo holds the decision store of this workspace, and which private git remote holds the state repo (`state.remote`) for a second machine.
- Before the milestone that builds each watch command (FAC-M3 for `factory watch`, FAC-M4 for `worker watch`, FAC-M5 for `pr watch`): the bound of each command. The design gives no value for the number of reads per run of `factory watch`, and none for the maximum wait of `worker watch` and `pr watch`. It also gives no result when the bound or the wait ends. Each value is a named number in `src/names.ts`.
- Before FAC-M5 builds the usage view (F-22): the source of the usage of a subscription other than Claude Code, for example Codex. `session.agent` accepts only `claude` in FAC-M4. The owner decides the worker agent setting for another agent, and where its token and limit data come from. Until then, the usage view lists the Claude Code subscriptions only.
- Before FAC-M5 builds the usage view (F-22): FAC-M4 task 2 records which quota or cost fields the real status line data has. If the data has no such field, the owner names the other source. A read under `~/.claude` is not a source (F-9).
- Before FAC-M10: the old local paths in the git history. The owner decides; the history is not rewritten (D-7 A).
- Before FAC-M10: the first publish and the public visibility of the repo. The owner writes a decision id in `docs/release-approval.md`.

## Risks

- **The renames touch every module.** FAC-M2 does them in one PR, and the names test catches a stray literal.
- **FAC-M2 grows.** The intent fixes add scope to the PR. The steps are separate commits (plan §13a), so the review reads them one by one.
- **The session-stop test can show that no way is safe.** Then `factory worker stop` keeps the rule "idle session, then `kill -TERM`", and the table records why.
- **The status line payload can lack the context percent.** FAC-M4 captures real payloads first. If the field is not there, design §4.6 names another source before the hook is built.
- **GitHub Projects API changes.** The connector keeps all calls in one module, with recorded-response tests.
- **The old page and scripts read the `local` files.** A format change in FAC-M5 breaks the owner view of FAC-M7. `scripts/check-owner-view.sh` runs in FAC-M7 and in FAC-M3 until the retirement.
