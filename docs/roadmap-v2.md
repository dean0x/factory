# factory roadmap v2 (proposal)

Status: proposal for review · Design: `docs/design.md` v2 · Date: 2026-11-02
This roadmap replaces FAC-M2 to FAC-M7 of the v1 roadmap (D-53). FAC-M0 (design) and FAC-M1 (skeleton CLI, PR #1) are done.

## Goal

A team member installs factory on a new macOS or Linux machine. `factory init` and `factory up` give a working node with the `software` recipe and a GitHub tracker, with no edit to any file. This workspace runs on factory, and its old scripts are retired.

## Rules for this roadmap

- Every exit criterion is a command, a test or a script with a pass or fail result. A milestone is done when all its criteria pass in CI or in the named script.
- One PR per milestone, unless the milestone names a split and its reason.
- The renames and the schema change come first (FAC-M2), because every later milestone uses the new names and the new schema.
- Heavy test runs follow the machine lock rule. CI runs the full suite.

## Milestones

| Id | Name | Depends on | Design changes (F-n) |
|---|---|---|---|
| FAC-M2 | Names, home, roles and schema 2 | FAC-M1 | F-1, F-3, F-4, F-5, F-10 |
| FAC-M3 | Tracker connector (GitHub) and decisions | FAC-M2 | F-2 |
| FAC-M4 | Cell control | FAC-M2 | F-7, F-8, F-9 |
| FAC-M5 | Gate and ship commands | FAC-M3 | F-6 |
| FAC-M6 | devflow variant | FAC-M5 | F-10 |
| FAC-M7 | This workspace adopted | FAC-M4, FAC-M6 | F-2, F-3, F-8 |
| FAC-M8 | Layers and team | FAC-M7 | F-4 |
| FAC-M9 | Jira and Linear adapters | FAC-M3 | F-2 |

FAC-M3 and FAC-M4 can run in parallel after FAC-M2. FAC-M9 can run at any time after FAC-M3.

### FAC-M2: Names, home, roles and schema 2

**Goal.** The code uses the v2 names, the v2 home rule and the schema-2 config, before more code depends on the old ones.

**Scope.**
1. **Renames (F-1).** In `src/names.ts` and the CLI: lane → cell, pack → recipe and variant, brief → work order (`.factory/orders/`), lane protocol → worker role template (`.factory/roles/worker.md`, block `worker`).
2. **Home folder and `factory up` (F-3).** The `init` rules of design §4.3. `factory up` starts the tmux session (node id), the view and bench windows, and the coordinator session in the home. It uses the launch rules of design §4.6: auto mode, `env -u ANTHROPIC_BASE_URL`, the proxy check, `FACTORY_HOME`, and one `--add-dir` per project. This changes a FAC-M1 rule: `init` now refuses a home inside another node home (FAC-M1 gave a warning).
3. **Role templates (F-4).** `node.layer` replaces `node.role`. Three templates in the `software` recipe: worker (layer 0), coordinator (layer 1), manager (layer 2 and up). `factory node add-child` with the same-layer rule.
4. **Recipe split in the config schema (F-10).** Schema 2 of design §4.4: the `recipe` block, `cells`, `approval`, `tracker`. The schema 1 → 2 migration of design §4.5. The recipe parses its own block.
5. **Platforms (F-5).** Every command refuses on native Windows with the WSL hint.

**Exit criteria.**
- [ ] `npm test` passes. The names test fails on a stray literal, and it finds no user-visible `lane`, `pack` or `brief` in the `--help` output or in the files that `init` writes.
- [ ] Integration test: `init --yes` inside a git work tree makes `../<repo>-factory` and lists the repo as the first project.
- [ ] Integration tests: `init` exits 4 for a home inside a git work tree, inside another node home, and above one of its projects.
- [ ] Integration test on a separate tmux server (`tmux -L <test>`) with a fake `claude` on PATH: `factory up` makes the session with the windows `view` and `bench`. The fake records `--permission-mode auto`, no inherited `ANTHROPIC_BASE_URL`, and one `--add-dir` per project. A second `factory up` starts no second coordinator.
- [ ] Unit tests: each role template passes the deny list and has its required sections. `factory node add-child` exits 4 for a child from another layer.
- [ ] Migration test: a node that the FAC-M1 0.1.0 tarball wrote upgrades to schema 2. After the upgrade, `factory doctor` exits 0 and shows the warning "decision store not set".
- [ ] Unit test with a fake platform `win32`: every command exits 4 and prints the WSL hint.
- [ ] `npm run exit-check` passes with the v2 flow: `init`, `up --dry-run`, `doctor`, deny list.

### FAC-M3: Tracker connector (GitHub) and decisions

**Goal.** The board, the andon items and the decisions live in GitHub. A script reads the owner's answers.

**Scope.** The adapter contract of design §4.10 and the `github` adapter (issues plus a Projects board, through `gh`). The commands `item`, `andon`, `decide ask|read`, `staging`, `watch`. The decision log and the decision profile tools. `item import` for the old board and waiting files.

**Exit criteria.**
- [ ] Contract tests run each adapter operation against a fake `gh` with recorded responses. No test needs the network.
- [ ] `decide read` records an answer `/choose B` or a label `choose:B` from the owner's account. It ignores the same answer from another account. Tests cover both cases.
- [ ] `doctor` fails on a public decision store and warns on an unset one (fake `gh` responses).
- [ ] `watch` stops after its read bound, and wakes only on a new answer or mention (unit tests with a fake clock).
- [ ] `item import` moves a fixture `board.json` and `waiting.json` into tracker items, and a second run creates no duplicates.
- [ ] No command needs `python3`, `jq` or `glow` (a test runs the commands with a PATH that does not contain them).

### FAC-M4: Cell control

**Goal.** factory starts, talks to, changes over, stops and restores cells, with no read under `~/.claude`.

**Scope.** `cell new|list|send|relay|changeover|stop|resume|restart|summon|watch|recover|adopt` and `layout`. The bench and view windows (F-8). The heartbeat hook (F-9). The inbox with a one-line doorbell.

**Tasks.**
1. **Session-stop test (F-7).** In a throw-away session, try `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. For each way, record the five facts of design §4.11. Write the results table into `docs/session-stop.md`. Then `factory cell stop` uses the safe way that the table shows. Until then, the rule is: stop only an idle session, then `kill -TERM`. This task does not run before FAC-M4 starts.
2. The heartbeat hook and the heartbeat reader.
3. The cell commands and the layout.

**Exit criteria.**
- [ ] `docs/session-stop.md` has one row per way, with the five facts. `factory cell stop` uses the way that the table marks safe, and a test with a fake session checks it.
- [ ] Tests on a separate tmux server: `cell new` makes a pane on the bench; `cell summon` shows it in the view slot and returns the board after the time; `cell restart --all` resumes each cell with its session id from the heartbeat file.
- [ ] Every launch test asserts auto mode, and a proxy only from the config with the check before the launch.
- [ ] Integration test: the hook writes the heartbeat line on each event (fake hook input).
- [ ] Static test: no source file opens a path under `~/.claude`, and no template contains such a path.
- [ ] `cell relay` types the owner prefix only for a decision with `by: owner` in the log; a test covers the refusal.
- [ ] `cell new` refuses a checkout that another cell uses, and refuses when a resource limit fails (fake machine facts).

### FAC-M5: Gate and ship commands

**Goal.** The merge gate, the merge and the release checks are one command each, with a short verdict.

**Scope.** `inspect`, `pr merge` (with both `approval.land` rules, F-6), `pr watch`, `issues audit`, `ship check|verify`, `clean`.

**Exit criteria.**
- [ ] `inspect` gives the same verdict as the manual gate on 3 merged PRs, from recorded fixtures.
- [ ] `pr merge` tests: with `approval.land: each` it refuses with no owner decision for that PR and head; with `approved-work` it refuses with no decision that approved and assigned the work; in both cases it refuses when the head changed after `inspect`.
- [ ] `ship check|verify` only reads; a test asserts that they run no publish command.
- [ ] `clean` is a dry run by default, and refuses a worktree with unpushed work or a path that a cell or resume file names.

### FAC-M6: devflow variant

**Goal.** A project can use the devflow variant of the `software` recipe.

**Scope.** `factory recipe variant devflow --project P`, the devflow variant file (design §2.2), the worker addendum and the proxy preset.

**Exit criteria.**
- [ ] `recipe variant devflow` runs `detect`, offers `install` only after a yes, and writes the variant into the project entry (test with a fake `devflow`).
- [ ] `inspect` finds devflow's review and resolution markers on a recorded real devflow PR.
- [ ] The core source and the default templates contain no devflow word (the deny list test).

### FAC-M7: This workspace adopted

**Goal.** This workspace runs on factory, and the old scripts are retired.

**Scope.** `factory adopt` (design §8): a node home next to the projects, the import into GitHub issues with a private decision store, `approval.land: approved-work`, the devflow variant for the devflow projects, cells on the bench.

**Exit criteria.**
- [ ] `factory adopt --dry-run` prints the plan, and a test checks it against a fixture copy of the workspace.
- [ ] After the adopt, `factory doctor` exits 0 in the new home, and the coordinator runs there.
- [ ] A check script shows that no cell checkout has the coordinator CLAUDE.md on its path to the root.
- [ ] The coordinator merges 5 PRs through `factory inspect` and `factory pr merge`.
- [ ] The old render and board scripts are not called by any process (a search of the tmux hooks and the cron list finds none).

### FAC-M8: Layers and team

**Goal.** A node on layer 2 manages layer-1 nodes, and a second person uses factory with no shared owner.

**Scope.** `factory report` rollup, the `ssh://` transport, `deliver` and `ping`, requests from a node with a different owner, the manager role template in use.

**Exit criteria.**
- [ ] Integration test: a layer-2 node reads a rollup over 2 layers with `file://` children.
- [ ] Integration test: one child over `ssh://` (a local SSH test server). An unreachable child shows "unknown".
- [ ] A record from a parent with a different owner arrives as a request, and carries no authority (test).
- [ ] A team member installs on a new machine with `npm i -g` from a packed tarball and edits no file (a script in a clean container or VM).
- [ ] The repo goes public only after Dean's yes. This is a decision, not a test.

### FAC-M9: Jira and Linear adapters

**Goal.** A team that uses Jira or Linear gets the same tracker features.

**Exit criteria.**
- [ ] The FAC-M3 contract tests pass for `jira` and `linear` with recorded responses.
- [ ] `doctor` checks the decision store privacy for each adapter.

## Later (no milestone yet)

- Other recipes, for example research or content (F-10).
- The `desk` adapter, if an owner asks for it (F-2).

## Decisions needed

- None blocks FAC-M2.
- Before FAC-M3: which private repo holds the decision store of this workspace.
- Before FAC-M8: whether the repo goes public.

## Risks

- **The renames touch every module.** FAC-M2 does them in one PR, and the names test catches a stray literal.
- **The session-stop test can show that no way is safe.** Then `factory cell stop` keeps the rule "idle session, then `kill -TERM`", and the table records why.
- **GitHub Projects API changes.** The adapter keeps all calls in one module, with recorded-response tests.
