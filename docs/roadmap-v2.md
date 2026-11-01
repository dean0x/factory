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

The build order is FAC-M2, M4, M5, M6, M7, then M3, M8, M9 (D-56). This workspace moves to factory first, with the `local` tracker. The GitHub tracker comes right after the move. The sections below are in build order.

| Order | Id | Name | Depends on | Design changes (F-n) |
|---|---|---|---|---|
| 1 | FAC-M2 | Names, home, roles and schema 2 | FAC-M1 | F-1, F-3, F-4, F-5, F-10, F-13 |
| 2 | FAC-M4 | Cell control | FAC-M2 | F-7, F-8, F-9 |
| 3 | FAC-M5 | Local tracker, gate and ship commands | FAC-M4 | F-2, F-6 |
| 4 | FAC-M6 | devflow variant | FAC-M5 | F-10 |
| 5 | FAC-M7 | This workspace adopted (local tracker) | FAC-M4, FAC-M6 | F-3, F-8 |
| 6 | FAC-M3 | GitHub tracker, and the move to it | FAC-M7 | F-2 |
| 7 | FAC-M8 | Layers and team | FAC-M7 | F-4 |
| 8 | FAC-M9 | Jira and Linear adapters | FAC-M3 | F-2 |

No milestone before FAC-M3 needs a network tracker: FAC-M5 and FAC-M7 use the `local` tracker. FAC-M8 can run in parallel with FAC-M3. FAC-M9 can run at any time after FAC-M3.

### FAC-M2: Names, home, roles and schema 2

**Goal.** The code uses the v2 names, the v2 home rule and the schema-2 config, before more code depends on the old ones.

**Scope.**
1. **Renames (F-1).** In `src/names.ts` and the CLI: lane → cell, pack → recipe and variant, brief → work order (`.factory/orders/`), lane protocol → worker role template (`.factory/roles/worker.md`, block `worker`).
2. **Home folder and `factory up` (F-3).** The `init` rules of design §4.3. `factory up` starts the tmux session (node id), the view and bench windows, and the coordinator session in the home. It uses the launch rules of design §4.6: auto mode, `env -u ANTHROPIC_BASE_URL`, the proxy check, `FACTORY_HOME`, and one `--add-dir` per project. This changes a FAC-M1 rule: `init` now refuses a home inside another node home (FAC-M1 gave a warning).
3. **Role templates (F-4).** `node.layer` replaces `node.role`. Three templates in the `software` recipe: worker (layer 0), coordinator (layer 1), manager (layer 2 and up). `factory node add-child` with the same-layer rule.
4. **Recipe split in the config schema (F-10).** Schema 2 of design §4.4: the `recipe` block, `cells`, `approval`, `tracker`. The schema 1 → 2 migration of design §4.5. The recipe parses its own block.
5. **Platforms (F-5).** Every command refuses on native Windows with the WSL hint.
6. **One machine only (F-13).** `parent` and `children[].address` accept only `file://` addresses. The transport interface has the `file://` transport with `ping`. The design and this roadmap lose the `ssh://` parts.

**Exit criteria.**
- [ ] `npm test` passes. The names test fails on a stray literal, and it finds no user-visible `lane`, `pack` or `brief` in the `--help` output or in the files that `init` writes.
- [ ] Integration test: `init --yes` inside a git work tree makes `../<repo>-factory` and lists the repo as the first project.
- [ ] Integration tests: `init` exits 4 for a home inside a git work tree, inside another node home, and above one of its projects.
- [ ] Integration test on a separate tmux server (`TMUX_TMPDIR` in a temp folder, the same effect as `tmux -L`) with a fake `claude` on PATH: `factory up` makes the session with the windows `view` and `bench`. The fake records `--permission-mode auto`, no inherited `ANTHROPIC_BASE_URL`, and one `--add-dir` per project. A second `factory up` starts no second coordinator.
- [ ] Unit tests: each role template passes the deny list and has its required sections. `factory node add-child` exits 4 for a child from another layer.
- [ ] Migration test: a node that the FAC-M1 0.1.0 tarball wrote upgrades to schema 2, with `tracker.kind: local`. After the upgrade, `factory doctor` exits 0.
- [ ] Unit test with a fake platform `win32`: every command exits 4 and prints the WSL hint.
- [ ] Unit tests: the config refuses an `ssh://`, `https://` or relative address in `parent` and in `children`, and names the key.
- [ ] `npm run exit-check` passes with the v2 flow: `init`, `up --dry-run`, `doctor`, deny list.

### FAC-M4: Cell control

**Goal.** factory starts, talks to, changes over, stops and restores cells, with no read under `~/.claude`.

**Scope.** `cell new|list|send|relay|changeover|stop|resume|restart|summon|watch|recover|adopt` and `layout`. The bench and view windows (F-8). The heartbeat hook (F-9). The doorbell inbox (D-55).

**The doorbell inbox (D-55).** It is the default way to send any text to a cell:
- `cell send` writes one numbered record per message into `.factory/cells/<id>/inbox/`, then rings one constant short line in the cell. The line has no message text.
- The cell acknowledges a record when it moves the record to `handled/`. `cell watch` rings again for a record that waits too long, with a fixed bound on the rings.
- `cell relay` keeps owner authority in the typed line. The line names the record number and a short hash of the record. A record alone never carries authority.
- All of it lives in the comms module (`src/comms/`) with one interface (`send`, `deliver`, `report`, `ping`) and a versioned record format.

**Tasks.**
1. **Session-stop test (F-7).** In a throw-away session, try `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. For each way, record the five facts of design §4.11. Write the results table into `docs/session-stop.md`. Then `factory cell stop` uses the safe way that the table shows. Until then, the rule is: stop only an idle session, then `kill -TERM`. This task does not run before FAC-M4 starts.
2. The heartbeat hook and the heartbeat reader.
3. **Inbox access test.** Before the inbox build, check that a cell in auto mode can read and move files in its inbox under the node home with no permission prompt. The cell gets its inbox folder through `--add-dir`. Record the result in `docs/session-stop.md` or a short note next to it.
4. The doorbell inbox.
5. The cell commands and the layout.

**Exit criteria.**
- [ ] `docs/session-stop.md` has one row per way, with the five facts. `factory cell stop` uses the way that the table marks safe, and a test with a fake session checks it.
- [ ] Tests on a separate tmux server: `cell new` makes a pane on the bench; `cell summon` shows it in the view slot and returns the board after the time; `cell restart --all` resumes each cell with its session id from the heartbeat file.
- [ ] Every launch test asserts auto mode, and a proxy only from the config with the check before the launch.
- [ ] Integration test: the hook writes the heartbeat line on each event (fake hook input).
- [ ] Static test: no source file opens a path under `~/.claude`, and no template contains such a path.
- [ ] `cell relay` types the owner prefix only for a decision with `by: owner` in the log; a test covers the refusal. The test uses a fixture decision log, because `factory decide` comes in FAC-M5.
- [ ] Inbox tests: `cell send` writes a numbered record and types only the constant line (a capture shows no message text); two sends give two records in order; a record moved to `handled/` stops the rings; `cell watch` rings again for a waiting record and stops at its bound; the relay line names the record number and its hash.
- [ ] A test with a fake session: after a clear or a restart, the cell finds its waiting records in the inbox.
- [ ] Static test: no module outside `src/comms/` reads or writes inbox files.
- [ ] `cell new` refuses a checkout that another cell uses, and refuses when a resource limit fails (fake machine facts).

### FAC-M5: Local tracker, gate and ship commands

**Goal.** The board, the andon items and the decisions work with the `local` tracker. The merge gate, the merge and the release checks are one command each, with a short verdict.

**Scope.**
1. **Local tracker (F-2).** The adapter contract of design §4.10 and the `local` adapter (files in `.factory/`; also the test double of later adapters). The commands `item`, `andon`, `decide <D-n> <option>` (for `local`) and `staging`. The decision log and the decision profile tools.
2. **Gate and ship (F-6).** `inspect`, `pr merge` (with both `approval.land` rules), `pr watch`, `issues audit`, `ship check|verify`.
3. **`factory checkout list|status|sync|clean` (D-55).**

**`factory checkout` (D-55).** The coordinator's repeated git work across checkouts becomes four commands. Cells keep doing git on their own branch.
- `list`: one row per checkout: project, path, cell, branch, short HEAD.
- `status`: for each checkout, the dirty files, ahead and behind, unpushed commits, and whether the branch is on the remote. One verdict line with counts.
- `sync <pr|branch>`: a base update of a waiting PR. It merges `origin/<default>` into the branch in a short-lived worktree under `.factory/state/`, pushes with no force, and removes the worktree. On a conflict it stops and names the files.
- `clean [--apply]`: it takes over `factory clean`. It removes a checkout only when no cell holds it, no item or resume file names it, the tip is on the remote, the tree is clean and the PR is merged.
- Safety rules from firstmate: a default branch moves only by fast-forward. A dirty, diverged or off-default checkout is reported as `STUCK:` and left untouched. Batch commands continue after a failure and give a count at the end (from mars).
- The commands extend `src/core/git.ts`; there is no second git module.

**Exit criteria.**
- [ ] Connector contract tests run against `local`. FAC-M3 runs the same set against `github`.
- [ ] With `local`: `comments read` returns nothing, and `factory decide <D-n> <option>` records `by: owner`. `factory decide` refuses (exit 4) with no TTY, and when `FACTORY_SESSION` is set.
- [ ] `item`, `andon` and `staging` change only the `local` files, and every change is one commit in the state repo (test).
- [ ] No command needs `python3`, `jq` or `glow` (a test runs the commands with a PATH that does not contain them).
- [ ] `inspect` gives the same verdict as the manual gate on 3 merged PRs, from recorded fixtures.
- [ ] `pr merge` tests: with `approval.land: each` it refuses with no owner decision for that PR and head; with `approved-work` it refuses with no decision that approved and assigned the work; in both cases it refuses when the head changed after `inspect`.
- [ ] `ship check|verify` only reads; a test asserts that they run no publish command.
- [ ] `checkout clean` is a dry run by default, and refuses a worktree with unpushed work or a path that a cell or resume file names. `factory clean` does not exist as a second command.
- [ ] `checkout list` and `checkout status` give the right rows and counts on fixture repos with linked worktrees: clean, dirty, unpushed, branch not on the remote. They ask git, never a `.git` folder test.
- [ ] `checkout sync` tests on fixture repos: a clean merge pushes with no force and removes its worktree; a conflict stops, names the files and leaves no worktree; the cell's own checkout does not change.
- [ ] A dirty, diverged or off-default checkout shows `STUCK:`, and no command changes it (test).

### FAC-M6: devflow variant

**Goal.** A project can use the devflow variant of the `software` recipe.

**Scope.** `factory recipe variant devflow --project P`, the devflow variant file (design §2.2), the worker addendum and the proxy preset.

**Exit criteria.**
- [ ] `recipe variant devflow` runs `detect`, offers `install` only after a yes, and writes the variant into the project entry (test with a fake `devflow`).
- [ ] `inspect` finds devflow's review and resolution markers on a recorded real devflow PR.
- [ ] The core source and the default templates contain no devflow word (the deny list test).

### FAC-M7: This workspace adopted (local tracker)

**Goal.** This workspace runs on factory with the `local` tracker, and the old scripts are retired.

**Scope.** `factory adopt` (design §8): a node home next to the projects; the import of the board and the items that wait on the owner into the `local` tracker files; `approval.land: approved-work`; the devflow variant for the devflow projects; cells on the bench. The import into GitHub issues is not here: it is FAC-M3.

**Exit criteria.**
- [ ] `factory adopt --dry-run` prints the plan, and a test checks it against a fixture copy of the workspace.
- [ ] The adopt imports the fixture board and the fixture owner items into the `local` files with no loss: a test compares the item ids and titles before and after.
- [ ] After the adopt, `factory doctor` exits 0 in the new home, and the coordinator runs there.
- [ ] A check script shows that no cell checkout has the coordinator CLAUDE.md on its path to the root.
- [ ] The coordinator merges 5 PRs through `factory inspect` and `factory pr merge`.
- [ ] The old render and board scripts are not called by any process (a search of the tmux hooks and the cron list finds none).

### FAC-M3: GitHub tracker, and the move to it

**Goal.** The board, the andon items and the decisions of this workspace move from the `local` tracker to GitHub. A script reads the owner's answers.

**Scope.** The `github` adapter (issues plus a Projects board, through `gh`) behind the FAC-M5 contract. The commands `decide ask|read` and `watch`. `item import` from the `local` files into a team tracker, and the move of this workspace's items into GitHub issues with a private decision store.

**Exit criteria.**
- [ ] The FAC-M5 connector contract tests pass against `github`, with a fake `gh` and recorded responses. No test needs the network.
- [ ] With `local`, `factory watch` exits at once with a note.
- [ ] `decide read` records an answer `/choose B` or a label `choose:B` from the owner's account. It ignores the same answer from another account. Tests cover both cases.
- [ ] `doctor` fails on a public decision store and warns on an unset one (fake `gh` responses).
- [ ] `watch` stops after its read bound, and wakes only on a new answer or mention (unit tests with a fake clock).
- [ ] `item import` moves the `local` files (fixture `board.json` and `waiting.json`) into `github` items, and a second run creates no duplicates.
- [ ] This workspace: after `item import`, a check script finds each `local` item id in exactly one GitHub issue, and `factory doctor` exits 0 with `tracker.kind: github`.

### FAC-M8: Layers and team

**Goal.** A node on layer 2 manages layer-1 nodes, and a second person uses factory with no shared owner.

**Scope.** `factory report` rollup, `deliver` and `report` on the `file://` transport, requests from a node with a different owner, the manager role template in use. All nodes are on one machine (F-13).

**Exit criteria.**
- [ ] Integration test: a layer-2 node reads a rollup over 2 layers with `file://` children.
- [ ] Integration test: a child home that factory cannot read shows "unknown" in the rollup, never "dead".
- [ ] A record from a parent with a different owner arrives as a request, and carries no authority (test).
- [ ] A team member installs on a new machine with `npm i -g` from a packed tarball and edits no file (a script in a clean container or VM).
- [ ] The repo goes public only after Dean's yes. This is a decision, not a test.

### FAC-M9: Jira and Linear adapters

**Goal.** A team that uses Jira or Linear gets the same tracker features.

**Exit criteria.**
- [ ] The connector contract tests (FAC-M5) pass for `jira` and `linear` with recorded responses, as they do for `local` and `github`.
- [ ] `doctor` checks the decision store privacy for each adapter.

## Later (no milestone yet)

- Other recipes, for example research or content (F-10).
- The `desk` adapter, if an owner asks for it (F-2).

## Decisions needed

- None blocks FAC-M2.
- Before FAC-M3 (after the workspace move in FAC-M7): which private repo holds the decision store of this workspace.
- Before FAC-M8: whether the repo goes public.

## Risks

- **The renames touch every module.** FAC-M2 does them in one PR, and the names test catches a stray literal.
- **The session-stop test can show that no way is safe.** Then `factory cell stop` keeps the rule "idle session, then `kill -TERM`", and the table records why.
- **GitHub Projects API changes.** The adapter keeps all calls in one module, with recorded-response tests.
