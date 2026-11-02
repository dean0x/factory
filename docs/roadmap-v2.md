# factory roadmap v2 (proposal)

Status: proposal for review · Design: `docs/design.md` v2 · Date: 2026-11-02
This roadmap replaces FAC-M2 to FAC-M7 of the v1 roadmap (D-53). FAC-M0 (design) and FAC-M1 (skeleton CLI, PR #1) are done.
`docs/intent-trace.md` maps each note from Dean to a design section and to a criterion of this roadmap.

## Goal

A team member installs factory on a new macOS or Linux machine. `factory init` and `factory up` give a working node with the `software` recipe and a GitHub tracker, with no edit to any file. This workspace runs on factory, and its old scripts are retired. The old scripts stay as the owner view until FAC-M3 retires them.

## Rules for this roadmap

- Every exit criterion is a command, a test or a script with a pass or fail result. A milestone is done when all its criteria pass in CI or in the named script.
- No criterion is "a decision". A decision that a milestone needs goes under "Decisions needed". The milestone then tests the choice that is built, not the decision.
- One PR per milestone, unless the milestone names a split and its reason.
- The renames and the schema change come first (FAC-M2), because every later milestone uses the new names and the new schema.
- Heavy test runs follow the machine lock rule. CI runs the full suite on an Ubuntu runner and a macOS runner.
- Output rule (saves tokens): the default output of a job command has at most 20 lines, and the verdict is on the first line. A job command is a command that replaces a manual job of design §3. A shared test helper checks this (FAC-M2), and each milestone uses it for its commands. `docs/token-budget.md` gives the size budget of each job.
- Intent rule: each note from Dean has a row in `docs/intent-trace.md`. Before a milestone merges, a check compares the result with every row of that milestone. A row that is not covered blocks the merge, or moves to a named later milestone with a reason.

## Milestones

The build order is FAC-M2, M4, M5, M6, M7, then M3, M8, M10, M9. D-56 sets M2, M4, M5, M6, M7, M3, M8, M9. The release milestone FAC-M10 comes after FAC-M8 and before FAC-M9, because the Goal needs a release path and does not need Jira or Linear. This workspace moves to factory first, with the `local` tracker. The GitHub tracker comes right after the move. The sections below are in build order.

| Order | Id | Name | Depends on | Design changes (F-n) |
|---|---|---|---|---|
| 1 | FAC-M2 | Names, home, roles and schema 2 | FAC-M1 | F-1, F-3, F-4, F-5, F-10, F-13 |
| 2 | FAC-M4 | Cell control | FAC-M2 | F-7, F-8, F-9, F-12 |
| 3 | FAC-M5 | Local tracker, gate and ship commands | FAC-M4 | F-2, F-6 |
| 4 | FAC-M6 | devflow variant | FAC-M5 | F-10 |
| 5 | FAC-M7 | This workspace adopted (local tracker) | FAC-M4, FAC-M6 | F-3, F-8 |
| 6 | FAC-M3 | GitHub tracker, and the move to it | FAC-M7 | F-2 |
| 7 | FAC-M8 | Layers and team | FAC-M7 | F-4 |
| 8 | FAC-M10 | Release and install | FAC-M3, FAC-M8 | D-45 |
| 9 | FAC-M9 | Jira and Linear adapters | FAC-M3 | F-2 |

No milestone before FAC-M3 needs a network tracker: FAC-M5 and FAC-M7 use the `local` tracker. FAC-M8 can run in parallel with FAC-M3. FAC-M9 can run at any time after FAC-M3.

### Command map

Each command of design §4.2 has one milestone. A command with two milestones names the part of each. A script checks that every command word of the §4.2 block has a row here (FAC-M2).

| Command | Milestone |
|---|---|
| `init`, `up`, `doctor`, `upgrade`, `help` (with `help words`) | FAC-M2 |
| `init --tracker --items --decisions --state-from`; `up` window `ops`; `upgrade` rule for a dirty state repo | FAC-M3 |
| `node children`, `node add-child`, `node remove-child` | FAC-M2 |
| `node tree` | FAC-M8 |
| `machine`, `project`, `layout`, `inbox`, `self`, `hook` | FAC-M4 |
| `cell` (new, list, send, relay, changeover, stop, resume, restart, summon, watch, recover, adopt) | FAC-M4 |
| `item`, `andon`, `staging`, `decide <D-n> <option>` | FAC-M5 |
| `inspect`, `pr`, `issues`, `ship`, `checkout`, `lock` | FAC-M5 |
| `status`, `report` (the digest of one node) | FAC-M5 |
| `report` (the rollup over children) | FAC-M8 |
| `recipe` (show, variant) | FAC-M6 |
| `adopt` | FAC-M7 |
| `tracker`, `state`, `watch`, `decide ask`, `decide read`, `item import` | FAC-M3 |
| `desk` | not built, no milestone (F-2) |

### FAC-M2: Names, home, roles and schema 2

**Goal.** The code uses the v2 names, the v2 home rule and the schema-2 config, before more code depends on the old ones. A command finds the home from a project folder.

**Scope.**
1. **Renames (F-1).** In `src/names.ts` and the CLI: lane → cell, pack → recipe and variant, brief → work order (`.factory/orders/`), lane protocol → worker role template (`.factory/roles/worker.md`, block `worker`). The tmux pane option `@lane` becomes `@cell`.
2. **Home folder and `factory up` (F-3).** The `init` rules of design §4.3. `factory up` starts the tmux session (node id), the view and bench windows, and the coordinator session in the home. It uses the launch rules of design §4.6: auto mode, `env -u ANTHROPIC_BASE_URL`, the proxy check, `FACTORY_HOME`, and one `--add-dir` per project. This changes a FAC-M1 rule: `init` now refuses a home inside another node home (FAC-M1 gave a warning).
3. **Role templates (F-4).** `node.layer` replaces `node.role`. Three templates in the `software` recipe: worker (layer 0), coordinator (layer 1), manager (layer 2). A layer above 2 has no template yet. `factory node add-child` with the same-layer rule.
4. **Recipe split in the config schema (F-10).** Schema 2 of design §4.4: the `recipe` block, `cells`, `approval`, `tracker`. The schema 1 → 2 migration of design §4.5. The recipe parses its own block.
5. **Platforms (F-5).** Every command refuses on native Windows with the WSL hint.
6. **One machine only (F-13).** `parent` and `children[].address` accept only `file://` addresses. The transport interface has the `file://` transport with `ping`. The design and this roadmap lose the `ssh://` parts.
7. **Home index (F-3).** `init` records the home in the per-user index of design §4.3. A command with no `--home`, no `FACTORY_HOME` and no `factory.yaml` above the current folder looks for the current folder in the index.
8. **Several repos in one folder (F-3).** The `init` rule of design §4.3 for a workspace folder, and the clone path of `--project URL`.
9. **Plain descriptions (F-1).** `docs/glossary.md` and `factory help words`.
10. **Deny list and desk (O-1, F-2).** The three triage words join the deny list. `desk render` is marked as not built.
11. **Review of the setup code (D-51).** The review of the FAC-M2 PR names the `init`, `upgrade` and `doctor` code.
12. **Output helper and budget file (O-1).** The short-output test helper, and `docs/token-budget.md` with one row for each job of design §3.
13. **Docs check.** `scripts/check-intent-docs.sh`.

**Exit criteria.**
- [ ] `npm test` passes. The names test fails on a stray literal, and it finds no user-visible `lane`, `pack` or `brief` in the `--help` output or in the files that `init` writes. The names test also fails when any file under `src/` contains `@lane`, and `names.ts` holds the pane option `@cell`.
- [ ] Integration test: `init --yes` inside a git work tree makes `../<repo>-factory` and lists the repo as the first project.
- [ ] Integration tests: `init` exits 4 for a home inside a git work tree, inside another node home, and above one of its projects.
- [ ] Integration test on a separate tmux server (`TMUX_TMPDIR` in a temp folder, the same effect as `tmux -L`) with a fake `claude` on PATH: `factory up` makes the session with the windows `view` and `bench`. The fake records `--permission-mode auto`, no inherited `ANTHROPIC_BASE_URL`, and one `--add-dir` per project. A second `factory up` starts no second coordinator.
- [ ] Unit tests: each role template passes the deny list and has its required sections. `factory node add-child` exits 4 for a child from another layer. `roleForLayer(0)`, `roleForLayer(1)` and `roleForLayer(2)` return worker, coordinator and manager. `roleForLayer(3)` returns no template. `init --layer 3` writes the `safety` block and no role block, and prints a warning. `doctor` warns on a layer-3 node and names the layer.
- [ ] Migration test: a node that the FAC-M1 0.1.0 tarball wrote upgrades to schema 2, with `tracker.kind: local`. After the upgrade, `factory doctor` exits 0.
- [ ] Unit test with a fake platform `win32`: every command exits 4 and prints the WSL hint.
- [ ] Unit tests: the config refuses an `ssh://`, `https://` or relative address in `parent` and in `children`, and names the key.
- [ ] Home index, integration test with a temp HOME and a temp `XDG_STATE_HOME`: after `init --yes` in the repo `web`, `factory up --dry-run` from `web/` and from `web/src` finds `web-factory` and exits 0. From a folder that is in no entry, it exits 2 and prints the hint. Two homes that list the same project give exit 2 and name both homes. The index file is under `XDG_STATE_HOME`, a static test finds no path under `~/.claude`, and a home that no longer exists is ignored.
- [ ] Workspace folder, integration test: a temp folder holds the git repos `web/` and `api/`, and `web-search/` as a linked worktree of `web`. `init --yes` there makes `./<folder>-factory`, lists `web` and `api`, names `web-search` as skipped, and exits 0. `init --home .` there exits 4 and names the rule. With no TTY and no `--yes`, `init` prints the proposal and exits 2.
- [ ] Clone path, unit test with a fake `git`: `init --project https://host/acme/api.git` runs `git clone -- <url> <folder of the home>/api`. A target that exists and has another origin gives exit 4. A URL whose repo name has `..` or starts with `-` gives exit 2.
- [ ] Glossary test: every term in the list `terms` of `src/names.ts` has an entry in `docs/glossary.md` and in `factory help words`. An entry has at most 25 words. The two texts are equal. The output has no deny-list word.
- [ ] The deny-list test has the patterns `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED`. No template and no file that `init` writes contains one.
- [ ] Helper test: the short-output helper accepts 20 lines with the verdict on line 1, and fails on 21 lines and on a verdict that is not on line 1. The default output of `factory up` (with no `--dry-run`) and of `node children` passes it.
- [ ] `scripts/check-review-scope.sh docs/reviews/fac-m2-review-summary.md` exits 0. It fails when the summary does not list `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/doctor.ts` and the files under `src/upgrade/`.
- [ ] `scripts/check-intent-docs.sh` exits 0. It exits 1 when one of these checks fails:
  - a design section named in `docs/intent-trace.md` is not a heading of `docs/design.md`;
  - a milestone id of the trace is not named in this roadmap, or a milestone from FAC-M2 up has no heading here;
  - a command word of the §4.2 block has no row in the command map;
  - the shop-floor table of design §7.1 does not have 11 rows;
  - the parity table of design §8.1 holds a Status that is not `planned`, `done` or `retired`;
  - `docs/token-budget.md` does not have 17 job rows;
  - a file under `docs/research/` holds the whole word `lane`.
- [ ] `npm run exit-check` passes with the v2 flow: `init`, `up --dry-run`, `doctor`, deny list, and the docs check.

### FAC-M4: Cell control

**Goal.** factory starts, talks to, changes over, stops and restores cells, with no read under `~/.claude`.

**Scope.** `cell new|list|send|relay|changeover|stop|resume|restart|summon|watch|recover|adopt`, `layout`, `machine`, `project add|remove|list`, `self changeover` and `inbox next|ack`. The bench and view windows (F-8). The heartbeat hook and the status line wrapper (F-9). The doorbell inbox (D-55). The restore after a reboot. The agent setting `session.agent`.

**The doorbell inbox (D-55).** It is the only way to send message text to a cell:
- `cell send` writes one numbered record per message into `.factory/cells/<id>/inbox/`, then rings one constant short line in the cell. The line has no message text.
- The cell acknowledges a record when it moves the record to `handled/`. `cell watch` rings again for a record that waits too long, with a fixed bound on the rings.
- `cell relay` keeps owner authority in the typed line. The line names the record number and a short hash of the record. A record alone never carries authority.
- `cell changeover --order` and `cell recover` send their text with `cell send`.
- All of it lives in the comms module (`src/comms/`, design §4.12) with one interface (`send`, `deliver`, `report`, `ping`) and a versioned record format. Only this module types into a pane.

**Tasks.**
1. **Session-stop test (F-7).** First write the rule for the word "safe" at the top of `docs/session-stop.md` (design §4.11). Then, in a throw-away session, try `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. Try each way twice: on an idle session, and on a busy session (a tool runs and a background agent runs). Write one row for each way and each case into the table. Then `factory cell stop` uses the way that the table marks safe for the case of the cell. Until then, the rule is: stop only an idle session, then `kill -TERM`. This task does not run before FAC-M4 starts.
2. **Fixtures from the real program (F-9).** Capture one payload for each hook event (SessionStart, Stop, PreCompact) and one status line payload from the installed Claude Code. Commit them in `test/fixtures/claude/` with the Claude Code version. If the status line payload has no context percent, name the other source in design §4.6 before the hook ships.
3. The heartbeat hook, the status line wrapper and the heartbeat reader.
4. **Inbox access test.** Before the inbox build, check that a cell in auto mode can read and move files in its inbox under the node home with no permission prompt. The cell gets its inbox folder through `--add-dir`. Record the result in `docs/session-stop.md` or a short note next to it.
5. The doorbell inbox.
6. The cell commands, the layout and the restore after a reboot.

**Exit criteria.**
- [ ] `docs/session-stop.md` has the rule for "safe" before the table, and one row for each way and each case (idle and busy), with the four facts and the verdict. `scripts/check-session-stop.sh` exits 0 only when the rule and all 12 rows are there (a `/quit` row may say "not available"). `factory cell stop` uses the way that the table marks safe for the case, and a test with a fake session checks it. A busy cell with no safe way gives exit 3 and names what runs (test).
- [ ] Tests on a separate tmux server:
  - `cell new` makes a pane on the bench with the pane option `@cell`;
  - `cell summon` shows the pane in the view slot, and the slot shows the board again after the time;
  - `cell restart --all` resumes each cell with its session id from the heartbeat file.
- [ ] Reboot test on a separate tmux server: start a node with two cells (fake `claude`), run `tmux kill-server` for that server, then run `factory up`. The coordinator starts, and each cell resumes with the session id from its heartbeat file (the fake records `--resume <id>`).
- [ ] Every launch test asserts auto mode, and a proxy only from the config with the check before the launch.
- [ ] Fixture tests: each hook payload fixture has a session id and an event name, and the status line fixture has a context percent. The hook parses the fixtures and writes the heartbeat line with those values.
- [ ] Status line wrapper test: with `session.statusline` set to a fake command that prints a marker, `factory hook statusline` prints exactly the output of that command and writes the heartbeat line. With the key unset, it prints `context N%`.
- [ ] Settings consent test (fake TTY and no TTY): `cell new` and `up` print the exact hook and status line change and its target file before any write. With no TTY and no `--yes`, they write nothing and exit 2. With `--yes`, they write only `.claude/settings.json` or `.claude/settings.local.json` in the home or the checkout. A test HOME shows that no file under `$HOME/.claude` changes. An existing status line command still prints its output through the wrapper.
- [ ] Integration test: the hook writes the heartbeat line on each event (fake hook input).
- [ ] Static test: no source file opens a path under `~/.claude`, and no template contains such a path.
- [ ] `cell relay` types the owner prefix only for a decision with `by: owner` in the log; a test covers the refusal. The test uses a fixture decision log, because `factory decide` comes in FAC-M5.
- [ ] Inbox tests: `cell send` writes a numbered record and types only the constant line (a capture shows no message text); two sends give two records in order; a record moved to `handled/` stops the rings; `cell watch` rings again for a waiting record and stops at its bound; the relay line names the record number and its hash.
- [ ] `inbox next` prints the oldest unhandled record, and `inbox ack <n>` moves record `n` to `handled/`. Both exit 2 when `FACTORY_INBOX` is not set (tests).
- [ ] A test with a fake session: after a clear or a restart, the cell finds its waiting records in the inbox.
- [ ] Static test: no module outside `src/comms/` reads or writes inbox files, and only `src/comms/` calls tmux `send-keys`. A unit test shows that a typed line of more than 300 characters is refused. A test with a fake comms module shows that `cell changeover --order` and `cell recover` use `cell send`.
- [ ] `cell list` marks a cell above `context_prepare_pct` as `PREPARE` and above `context_max_pct` as `MAX`, with fake heartbeat values at 29, 30, 40 and 41 percent.
- [ ] `session.agent: claude` loads. Any other value fails and names the key. A static test finds no start of an agent program except through `session.agent`.
- [ ] `machine` tests: fixture files for macOS (`memory_pressure` and `sysctl` output) and for Linux (`/proc/meminfo`, `/proc/loadavg`) give the same verdict format, with a fake platform for each. `cell new` refuses a checkout that another cell uses, and refuses when a resource limit fails (fake machine facts).
- [ ] `project add|remove|list` change only `recipe.projects[]`, keep the comments of `factory.yaml`, and refuse a project path that the home rules refuse (tests).
- [ ] `self changeover` exits 3 and names the file when the resume file `.factory/resume/<node id>.md` is missing. With the file, it asks `src/comms/` to type `/compact` with a hint that names the file (fake comms).
- [ ] The job commands of this milestone pass the short-output helper, and `docs/token-budget.md` has a measured size for each of them.

### FAC-M5: Local tracker, gate and ship commands

**Goal.** The board, the andon items and the decisions work with the `local` tracker. The merge gate, the merge and the release checks are one command each, with a short verdict. The report of one node exists, so `status` works before FAC-M7.

**Scope.**
1. **Local tracker (F-2).** The adapter contract of design §4.10 and the `local` adapter (files in `.factory/`; also the test double of later adapters). The commands `item`, `andon`, `decide <D-n> <option>` (for `local`) and `staging`. The decision log and the decision profile tools. The state commit helper and the delete-guard hook.
2. **Gate and ship (F-6).** `inspect`, `pr merge` (with both `approval.land` rules and the proofs of design §6.1), `pr watch`, `issues audit`, `ship check|verify`. The key `approval.ship` with the only value `each`.
3. **`factory checkout list|status|sync|clean` (D-55).**
4. **Report core.** `factory report` and `factory status` for one node, with no children: cell states, tracker counts, the items in progress, the andon items and the events that scripts write at merge, release and decision. The rollup over children stays in FAC-M8. `lock run`. The view slot shows `factory item list`.
5. **Token budget.** `scripts/budget-check.sh`.
6. **Proxy host warning.** `doctor` warns when the proxy host is not loopback, because the proxy host receives the API traffic of the node.

**`factory checkout` (D-55).** The coordinator's repeated git work across checkouts becomes four commands. Cells do their own git work on their own branch.
- `list`: one row per checkout: project, path, cell, branch, short HEAD.
- `status`: for each checkout, the dirty files, ahead and behind, unpushed commits, and whether the branch is on the remote. One verdict line with counts.
- `sync <pr|branch>`: a base update of a waiting PR. It merges `origin/<default>` into the branch in a short-lived worktree under `.factory/state/`, pushes with no force, and removes the worktree. On a conflict it stops and names the files.
- `clean [--apply]`: it takes over `factory clean`. It removes a checkout only when no cell holds it, no item or resume file names it, the tip is on the remote, the tree is clean and the PR is merged.
- Safety rules from firstmate: a default branch moves only by fast-forward. A dirty, diverged or off-default checkout is reported as `STUCK:` and left untouched. Batch commands continue after a failure and give a count at the end (from mars).
- The commands extend `src/core/git.ts`; there is no second git module.

**Exit criteria.**
- [ ] Connector contract tests run against `local`. FAC-M3 runs the same set against `github`.
- [ ] With `local`: `changes read` returns nothing, and `factory decide <D-n> <option>` records `by: owner`. `factory decide` refuses (exit 4) with no TTY, and when `FACTORY_SESSION` is set.
- [ ] `item`, `andon` and `staging` change only the `local` files, and every change is one commit in the state repo (test).
- [ ] `init` sets `core.hooksPath`. The commit helper refuses when the hook is off. The hook refuses a commit that removes an item id from `board.json` (tests).
- [ ] No command needs `python3`, `jq` or `glow` (a test runs the commands with a PATH that does not contain them).
- [ ] `inspect` gives the same verdict as the manual gate on 3 merged PRs, from recorded fixtures.
- [ ] `inspect` exits 3 with `NOT READY` while the PR has an open ask or an open andon item, and gives `READY` after the item closes (tests).
- [ ] `pr merge` tests with `approval.land: each`: it refuses with no owner decision or answered ask for that PR and head; it refuses when the head changed after `inspect`.
- [ ] `pr merge` tests with `approval.land: approved-work`. There is one test for each proof of design §6.1:
  - (a) a decision with `by: owner`;
  - (b) an ask answered `approve` from the owner's account;
  - (c) an approved plan: an ask or decision item that names the plan path and commit SHA, answered `approve` by the owner's account (`local`: `factory decide` from a fake TTY with no `FACTORY_SESSION`).

  Each test runs three times: with a direct assignment, with an assignment by a second decision, and with an assignee or `cell:<id>` label set by the owner's account. Each run merges.
- [ ] `pr merge` refuses, with a message that names the proof that is absent, in these cases:
  - approval with no assignment;
  - a decision by another account;
  - a record for another PR or head;
  - a plan file with `Status: approved` in a commit by the owner's account, with no answered ask or decision item;
  - an assignee or label set by another account;
  - chat text with no record.
- [ ] Tracker identity tests (design §4.10, §6.1), with a fake adapter that gives events with an author. The `github` adapter comes in FAC-M3 and runs the same tests.
  - Shared account (`tracker.agent_account` unset, or equal to the owner account): an owner comment `approve`, an owner assignee and an owner `cell:<id>` label are each refused as a proof, and the message names the shared account. A decision from `factory decide` on a fake TTY with no `FACTORY_SESSION` is accepted, and `pr merge` merges.
  - Separate accounts: the same owner events are accepted, and `pr merge` merges. The same events with the agent account as author are refused.
- [ ] `doctor` warns, with the fix, when the tracker kind is not `local` and `tracker.agent_account` is unset or equal to the owner account. The config accepts the key, and a token-like value in it fails (tests).
- [ ] The README setup section tells the owner how to give the agents their own tracker identity (a machine user or an app). A docs check finds the section.
- [ ] Config test: `approval.ship: each` loads, and an absent key means `each`. Any other value fails and names the key. `ship check|verify` only read; a test asserts that they run no publish command.
- [ ] `checkout clean` is a dry run by default, and refuses a worktree with unpushed work or a path that a cell or resume file names. `factory clean` does not exist as a second command.
- [ ] `checkout list` and `checkout status` give the right rows and counts on fixture repos with linked worktrees: clean, dirty, unpushed, branch not on the remote. They ask git, never a `.git` folder test.
- [ ] `checkout sync` tests on fixture repos: a clean merge pushes with no force and removes its worktree; a conflict stops, names the files and leaves no worktree; the cell's own checkout does not change.
- [ ] A dirty, diverged or off-default checkout shows `STUCK:`, and no command changes it (test).
- [ ] Report tests: `report --json` has the keys of design §5.4 for a node with fixture cells and no children. `--since` returns only newer events. `pr merge`, `ship verify` and `decide` each add one event to `.factory/outbox/`. A static test shows that `status` calls the same builder as `report`.
- [ ] `lock run` tests: with a fake platform `darwin` it uses `lockf`, and with `linux` it uses `flock`. A second run waits and stops at its bound with exit 3. The exit code of the inner command passes through.
- [ ] A tmux test: the view slot pane shows the item titles of a fixture `local` board.
- [ ] `scripts/budget-check.sh` exits 0 for the jobs built so far. It exits 1 when a fixture output is more than twice the figure in `docs/token-budget.md` (test with an inflated output).
- [ ] Unit test: `doctor` warns, with the fix, when the host of a configured proxy is not loopback (`127.0.0.1`, `::1` or `localhost`). It gives no such warning for a loopback host.

### FAC-M6: devflow variant

**Goal.** A project can use the devflow variant of the `software` recipe. The coordinator knows which project uses which variant. The core works with no `software` recipe.

**Scope.** `factory recipe show` and `factory recipe variant devflow --project P`, the devflow variant file (design §2.2), the worker addendum, the proxy preset with its real values, the `projects` block of the coordinator template (design §5.2), the work order of `cell new --project P` with the stage commands of the variant of P only, and a test recipe in the test folder.

**Exit criteria.**
- [ ] `recipe variant devflow` runs `detect`, offers `install` only after a yes, and writes the variant into the project entry (test with a fake `devflow`).
- [ ] `inspect` finds devflow's review and resolution markers on a recorded real devflow PR.
- [ ] The core source and the default templates contain no devflow word and none of the three triage words (the deny list test).
- [ ] Coordinator knowledge, integration test: a node with the project `a` (plain) and the project `b` (devflow). The `projects` block of the coordinator `CLAUDE.md` lists both variants and their stage commands. The work order of a cell of `b` has the devflow stage commands. The work order of a cell of `a` passes the deny list. `recipe show` prints the same table as the block.
- [ ] Same-layer test: two layer-1 nodes with different project sets have the same managed text, except the `projects` block (a hash compare of the text with that block cut out).
- [ ] Core independence: a dependency test finds no import of `src/recipes/` in `src/core/`, `src/config/` or `src/comms/`. A test recipe `document` (in `test/`, with no git and the output `document`) is registered through `Deps` and passes `init`, `up --dry-run`, `doctor` and `report`.
- [ ] Proxy preset, tests with a stub HTTP server: the preset has the health path `/__subswitch/health` and the port 4141. When the stub answers that path, a cell launches (fake `claude`) with `ANTHROPIC_BASE_URL` set to the stub. When the stub is dead, the launch stops with the fix message and starts nothing. `cells.<id>.proxy: none` wins over `session.proxy: subswitch` of the node.

### FAC-M7: This workspace adopted (local tracker)

**Goal.** This workspace runs on factory with the `local` tracker. The old review page and its scripts stay as the owner view until FAC-M3 retires them.

**Scope.** `factory adopt` (design §8):
- a node home next to the projects;
- the move of the coordinator text out of the folder above the checkouts;
- the import of the board and the items that wait on the owner into the `local` tracker files;
- `approval.land: approved-work`, and the devflow variant for the devflow projects;
- cells on the bench, and `session.statusline` set to the status line command of the owner;
- one cell run through the real Subswitch.

The import into GitHub issues is not here: it is FAC-M3.

**Owner view in the `local` period.** The review page and its scripts of today stay in use. They read the `local` files, which have the same format. The owner answers a decision in the page or with `factory decide <D-n> <option>` in a terminal outside any factory session. FAC-M7 does not retire the scripts. FAC-M3 does.

**Exit criteria.**
- [ ] `factory adopt --dry-run` prints the plan, and a test checks it against a fixture copy of the workspace. The plan shows the move of the coordinator text.
- [ ] The adopt imports the fixture board and the fixture owner items into the `local` files with no loss: a test compares the item ids and titles before and after.
- [ ] After the adopt, `factory doctor` exits 0 in the new home, and the coordinator runs there.
- [ ] `scripts/check-cell-paths.sh` walks from each cell checkout to the root. It exits 1 and names the path when a `CLAUDE.md` on the way has a `factory:begin coordinator` block or the sentinel line of the old Orchestrator file. It exits 0 on the adopted fixture workspace, and it exits 1 on the fixture before the adopt.
- [ ] Owner view: `scripts/check-owner-view.sh` runs the old render scripts against the `local` files of the adopted fixture and exits 0. The output has every fixture item id. After `factory item move`, a second run shows the new state.
- [ ] Owner answer: a pty test runs `factory decide D-1 B` in a shell outside any factory session. Then `factory andon list`, run with `FACTORY_SESSION` set as the coordinator does, shows D-1 answered with `by: owner`. `factory decide` with `FACTORY_SESSION` set exits 4.
- [ ] `scripts/check-parity.sh FAC-M7` exits 0: every due row of the parity table (design §8.1) is `done` or `retired`.
- [ ] The cell status line shows the output of the command named in `session.statusline` (fixture command, test).
- [ ] `scripts/subswitch-run.sh` starts one cell of this workspace through the real Subswitch. It exits 0 only when the health check passed and the heartbeat line arrived. The output is saved in `docs/reviews/fac-m7-subswitch-run.md`.
- [ ] After the adopt, `tmux kill-server` and `factory up` restore every cell with its saved session id (a recorded run on this workspace).
- [ ] The coordinator merges 5 PRs through `factory inspect` and `factory pr merge`.

### FAC-M3: GitHub tracker, and the move to it

**Goal.** The board, the andon items and the decisions of this workspace move from the `local` tracker to GitHub. A script reads the owner's answers. The user picks the tracker at setup. The old page and scripts are retired. A second machine of the owner gets the profile.

**Scope.**
1. The `github` adapter (issues plus a Projects board, through `gh`) behind the FAC-M5 contract. The contract has the `doc` operation (attach a file, link a repo file) and `changes read` (comments, label changes, assignee changes, open or close changes, each with its author; card moves are out for now).
2. The commands `decide ask|read` and `watch`. `up` starts `watch` in the window `ops` when the tracker is not `local`.
3. The choice of the tracker: `init --tracker --items --decisions`, the question on a TTY, `tracker set`, `tracker status`, and the per-project override (design §4.10).
4. `item import` from the `local` files into a team tracker, and the move of this workspace's items into GitHub issues with a private decision store. The retirement of the old page and scripts.
5. The state remote: `state remote|push|pull`, `init --state-from`, and the rule that `state pull` and `upgrade` move by fast-forward only (firstmate idea 8).

**Exit criteria.**
- [ ] The FAC-M5 connector contract tests pass against `github`, with a fake `gh` and recorded responses. No test needs the network. The tests name the `doc` operation: one attaches a file, one links a repo file.
- [ ] With `local`, `factory watch` exits at once with a note.
- [ ] `decide read` records an answer `/choose B` or a label `choose:B` from the owner's account. It ignores the same answer from another account. Tests cover both cases.
- [ ] `doctor` fails on a public decision store and warns on an unset one (fake `gh` responses).
- [ ] `watch` stops after its read bound, and wakes only on a new answer or mention (unit tests with a fake clock).
- [ ] Wake test on a separate tmux server with a fake `gh`. An owner comment `/choose B`, a label change, an assignee change and an issue close each cause one record in `.factory/inbox/` and one constant doorbell line in the coordinator pane. The same events from another account cause none. A fake `claude` on PATH records no call during `watch`.
- [ ] `up --dry-run` with `github` lists the window `ops` with `factory watch`. With `local`, it lists no `ops` window.
- [ ] Tracker choice, tests with a fake `gh`: `init --tracker github --items acme/web --decisions acme/decisions --yes` makes a node, and `factory doctor` exits 0. When the fake says that the decision repo is public, `init` exits 4 and writes no file, and `doctor` fails on such a config. `tracker status` prints `github`.
- [ ] Override test: a node with the default `github` and a project with `kind: local`. `item add --project P` goes to the `local` files, and an item with no project goes to the fake `gh`. `tracker status` prints both.
- [ ] `item import` moves the `local` files (fixture `board.json` and `waiting.json`) into `github` items, and a second run creates no duplicates.
- [ ] State remote, integration test: machine A makes a state repo and pushes it to a bare repo path. Machine B (a temp HOME) runs `init --state-from <path>`. The profile index equals the one of machine A, and `doctor` exits 0. `state pull` with a diverged remote exits 1 and changes nothing. With a dirty `.factory/`, `state pull` and `upgrade` stop, name the files and change nothing.
- [ ] The old render and board scripts are not called by any process (a search of the tmux hooks and the cron list finds none). `scripts/check-parity.sh FAC-M3` exits 0 for all rows.
- [ ] This workspace: after `item import`, a check script finds each `local` item id in exactly one GitHub issue, and `factory doctor` exits 0 with `tracker.kind: github`.

### FAC-M8: Layers and team

**Goal.** A node on layer 2 manages layer-1 nodes, and a node on layer 3 manages layer-2 nodes. A second person uses factory with no shared owner. A new top layer changes nothing below it.

**Scope.** `factory report` rollup, `deliver` and `report` on the `file://` transport, requests from a node with a different owner, the manager role template in use, the `director` template for layer 3, `node tree`, and the list of config items that a parent passes down. All nodes are on one machine (F-13).

**Exit criteria.**
- [ ] Integration test: a layer-2 node reads a rollup over 2 layers with `file://` children.
- [ ] Integration test: a layer-3 node reads a rollup over 3 layers with `file://` children.
- [ ] Growth test: a layer-2 node runs `add-child` for a new layer-1 node. Before and after, the hash of `factory.yaml` and of the state files (without `.git`, `state/` and `locks/`) of every node below is the same.
- [ ] Unit tests: `roleForLayer(3)` returns the `director` template, and it is not the manager template. `init --layer 3` writes the director block. A node on layer 4 gets a `doctor` warning that names the layer.
- [ ] Integration test: a child home that factory cannot read shows "unknown" in the rollup, never "dead".
- [ ] A record from a parent with a different owner arrives as a request, and carries no authority (test).
- [ ] `node tree` prints one line for each entry of `children[]` and reads only the folders that the entries name. A test with an extra node folder shows that it is not listed. A child entry whose folder has another node id shows `mismatch`, and `deliver` to it exits 4.
- [ ] A parent that has owner, accounts and session settings in its config passes to a child only the keys of the inherit list (limits, writing style, safety rules). A test compares the child config.

### FAC-M10: Release and install

**Goal.** A team member can install factory from a release on a new machine. Nothing publishes until the owner records a decision.

**Scope.** The release workflow (tests, version check, GitHub Release, npm publish in a protected environment, tap update), `install.sh` with a SHA256 check, the Homebrew formula in `dean0x/homebrew-tap`, `scripts/release-gate.sh`, and `docs/release-approval.md` (design §4.7). The version lives in `package.json` only. The first real publish is out of scope: it runs after the owner records a decision id in `docs/release-approval.md`, and the gate script blocks it until then.

**Exit criteria.**
- [ ] `scripts/check-release-workflow.sh` (no network) exits 0 only when: the job `publish` has `environment: npm-publish`; no other job runs `npm publish`; the first step of `publish` runs `scripts/release-gate.sh`; and no file but `package.json` holds the version.
- [ ] `scripts/release-gate.sh` tests: it exits 1 when `docs/release-approval.md` has no line `Decision: D-<n>`; it exits 1 when the tag version differs from the version in `package.json`; it exits 0 with both.
- [ ] `scripts/check-environment.sh` (a read-only `gh api` call, run with the token of the owner) exits 0 only when the environment `npm-publish` has the owner as a required reviewer. The output is saved in `docs/reviews/`.
- [ ] `scripts/check-private.sh` exits 1 when the repo is public and `docs/release-approval.md` has no decision id. It exits 0 when the repo is private.
- [ ] `install.sh` tests with a local file base: a good tarball with its SHA256 installs and runs `factory --version`, and a second run is safe. A tampered tarball exits 1 and installs nothing.
- [ ] `scripts/check-formula.sh` exits 0 when the `url` and `sha256` of the Homebrew formula match the release asset (fixture release), and exits 1 on a mismatch.
- [ ] Clean machine: a script in a clean Linux container, and the same script on a macOS runner, runs `npm i -g` from the packed tarball with a throw-away HOME and a fake `gh`. Then `factory init --yes --tracker github` in a temp repo, `factory up --dry-run` and `factory doctor` all exit 0. The script edits no file by hand.
- [ ] CI runs the workflow up to `npm publish --dry-run`, and the dry run exits 0.

### FAC-M9: Jira and Linear adapters

**Goal.** A team that uses Jira or Linear gets the same tracker features.

**Exit criteria.**
- [ ] The connector contract tests (FAC-M5) pass for `jira` and `linear` with recorded responses, as they do for `local` and `github`.
- [ ] `doctor` checks the decision store privacy for each adapter.
- [ ] `tracker set jira` with no `site` exits 2 and names `site`. `tracker set linear` with no `key` exits 2 and names `key`.
- [ ] Mixed test with fakes: a node with a `github` project and a `jira` project. `item add --project P` goes to the adapter of P, and `tracker status` prints both.

## Later (no milestone yet)

- Other recipes, for example research or content (F-10).
- The `desk` adapter and `factory desk render`: not built and not planned (F-2). An owner who asks for them gets a new milestone.

## Decisions needed

- None blocks the FAC-M2 code.
- Before the FAC-M2 merge: Dean reads `docs/glossary.md` and the table of design §7.1, and says yes or no to each word. The answer goes into a decision record. A "no" changes the words in `src/names.ts` and the glossary.
- Before FAC-M5: D-57. Does the approval of work include the release ("a-z")? Dean has not answered. FAC-M5 builds `approval.ship: each`, the only value. An answer "yes" adds a value in a later version.
- Before FAC-M3 (after the workspace move in FAC-M7): which private repo holds the decision store of this workspace, and which private git remote holds the state repo (`state.remote`) for a second machine.
- Before FAC-M10: the first publish and the public visibility of the repo. The owner records a decision id in `docs/release-approval.md`.

## Risks

- **The renames touch every module.** FAC-M2 does them in one PR, and the names test catches a stray literal.
- **FAC-M2 grows.** The intent fixes add scope to the PR. The steps are separate commits (plan §13a), so the review reads them one by one.
- **The session-stop test can show that no way is safe.** Then `factory cell stop` keeps the rule "idle session, then `kill -TERM`", and the table records why.
- **The status line payload can lack the context percent.** FAC-M4 captures real payloads first. If the field is not there, design §4.6 names another source before the hook ships.
- **GitHub Projects API changes.** The adapter keeps all calls in one module, with recorded-response tests.
- **The old page and scripts read the `local` files.** A format change in FAC-M5 breaks the owner view of FAC-M7. `scripts/check-owner-view.sh` runs in FAC-M7 and in FAC-M3 until the retirement.
