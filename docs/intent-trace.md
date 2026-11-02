# Intent trace

This table maps each note from Dean to the text that answers it. It has one row for each ask id of the intent check (the baseline of 2026-11-02 and its verbatim check). The intent check at each milestone merge reads the rows of that milestone. A row that is not covered blocks the merge, or moves to a named later milestone with a reason.

How to read the table:
- **Ask id.** `F-n`, `D-n` and `O-1x` are the ids of the first table of the check. `V-F-nx` is a row of the verbatim check, which compares Dean's own words. `Gap n` is a numbered gap of the check (1 to 18). `A1` to `A12` are the new gaps of the verbatim check.
- **Design section.** A heading of `docs/design.md`.
- **Milestone and exit criterion.** A milestone of `docs/roadmap-v2.md` and the check that proves the ask. The word "criterion" refers to the exit criteria of that milestone.
- **Status.** `covered` means that the design and the roadmap answer the ask. `not applicable` gives the reason.

`scripts/check-intent-docs.sh` (FAC-M2) checks that each design section here is a heading of the design, and that each milestone id is named in the roadmap.

## Notes of the first table

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| F-1a | Replace "lane" and "pack" with factory words | §4.1, §7 | FAC-M2: the names test finds no `lane`, `pack` or `brief` in `--help`, templates and files that `init` writes, and no `@lane` under `src/` | covered |
| F-1b | Keep node, owner, project | §4.1 | FAC-M2: names test; glossary test (entries for node, owner, project) | covered |
| F-1c | Factory words for commands and items | §4.1, §4.2, §7 | FAC-M4 (changeover) and FAC-M5 (andon, staging, inspect, ship): each command has its own criterion. FAC-M2: names test and glossary test | covered |
| F-2a | Use the team tracker (GitHub, Jira, Linear); the user picks it | §4.10, §4.4 | FAC-M3: tracker choice test (`init --tracker github` with a fake `gh`; `doctor` exits 0; a public store exits 4). FAC-M9: Jira and Linear | covered |
| F-2b | Do not build an own review desk | §4.10, §4.2 | None. `desk` is marked "not built, no milestone" in the command map | not applicable: the ask is to not build it |
| F-2c | A decision is a labelled item; a script reads the answer; private store; bounded watch | §4.10, §6 | FAC-M3: `decide read` tests (owner account only), `doctor` fails on a public store, `watch` bound test | covered |
| F-2d | Plans and designs: link the repo file or attach it | §4.10 | FAC-M3: the contract tests name the `doc` operation (attach a file, link a repo file) | covered |
| F-3a | Say where the main session runs | §4.3 | FAC-M2: `init` tests (exit 4 rules) and the `up` test on a separate tmux server | covered |
| F-3b | The user does not need to know the folder; `factory up` starts it | §4.3 | FAC-M2: home index test: `up --dry-run` from `web/` and from `web/src` finds `web-factory`; an unknown folder exits 2 with a hint | covered |
| F-3c | A cell does not load the coordinator instructions | §4.3, §8 | FAC-M2 (a new node), FAC-M7: `scripts/check-cell-paths.sh` passes on the adopted fixture and fails on the fixture before the adopt | covered |
| F-3d | One project or many: the same layout | §4.1, §4.3 | FAC-M2: `up` test with one `--add-dir` for each project | covered |
| F-4a | Same layer, same behavior; the role comes from the layer | §5.2 | FAC-M2: role template tests; `node add-child` exits 4 for another layer | covered |
| F-4b | The pyramid can grow; a new top layer changes nothing below | §5.2, §5.7 | FAC-M8: growth test (hashes of the nodes below stay the same) and the layer-3 rollup test | covered |
| F-5 | macOS and Linux only | §4.7 | FAC-M2: fake `win32` refusal test. FAC-M4: `machine` fixtures for both systems. FAC-M5: `lock run` with `flock` and `lockf`. CI runs on Ubuntu and macOS | covered |
| F-6a | Approved and assigned work merges when the gates pass, with no ask for each PR | §6, §6.1 | FAC-M5: `pr merge` tests, one for each proof, for both kinds of assignment, and the refusals | covered |
| F-6b | Does "a-z" include releases? | §6.2, §9 | FAC-M5: `approval.ship: each` config test and the no-publish test. D-57 is in "Decisions needed" before FAC-M5 | covered; D-57 is open with Dean |
| F-6c | The owner chooses the merge rule | §4.4, §6 | FAC-M5: `pr merge` tests for `each` and `approved-work` | covered |
| F-7 | Test the ways to stop a session, then use the best one | §4.11 | FAC-M4: the rule for "safe" and 12 rows in `docs/session-stop.md` (`scripts/check-session-stop.sh`); `cell stop` uses the safe way; a busy cell with no safe way exits 3 | covered |
| F-8 | Cells on the bench; the view has the coordinator and one slot | §4.11 | FAC-M4: tmux tests (`cell new`, `cell summon`, return of the board). FAC-M7: the adopt | covered |
| F-9a | No read under `~/.claude`; a hook replaces them | §4.6, §6 | FAC-M4: static test (no source file or template names such a path); hook test | covered |
| F-9b | The hook gives session id, last activity and context percent | §4.6 | FAC-M4: fixtures from the installed Claude Code; the hook parses them; the status line wrapper passes the output of the owner's command through | covered |
| F-9c | Remove the "avoid reads" instruction | §4.6 | FAC-M4: static test on the templates | covered |
| F-10a | One general core; the recipe decides the kind of factory | §4.9, §4.4 | FAC-M2: schema split. FAC-M6: dependency test and the test recipe `document` | covered |
| F-10b | `software` first, in a plain and a devflow form | §4.9, §2.2 | FAC-M2 (plain), FAC-M6 (devflow) | covered |
| F-11 | Git commands for multi-repo work, from mars | §3, §4.2 | FAC-M5: `checkout` tests on fixture repos, with the case `STUCK:` | covered |
| F-12a | Analysis of firstmate: what it is, how it works, what factory takes | §4.8 | None. `docs/research/firstmate-and-mars.md` is the answer, and it uses the word cell | not applicable: the answer is a document |
| F-12b | Explain the doorbell inbox; make it the only way to send text | §4.12 | FAC-M4: inbox tests; static test that only `src/comms/` calls `send-keys`; typed line limit of 300 characters | covered |
| F-12c | Communication as its own module | §4.12, §5.3 | FAC-M4: static test (no module outside `src/comms/` touches inbox files) | covered |
| F-13 | Same machine only; no remote host | §5.3, §4.4 | FAC-M2: the config refuses `ssh://`, `https://` and relative addresses (tests) | covered |
| D-45a | TypeScript on Node 22+, `factory`, `@dean0x/factory`, MIT, `.factory/`, `factory.yaml` | §4.7, §9 | FAC-M1 is done (PR #1) | covered |
| D-45b | Private repo until a team member installs it; an npm publish waits for Dean's go | §4.7 | FAC-M10: `scripts/check-release-workflow.sh`, `scripts/release-gate.sh` tests, `scripts/check-environment.sh`, `scripts/check-private.sh` | covered |
| D-45c | Subswitch as a proxy option for each node and each cell, with a health check and no stray variable | §4.6, §2.2 | FAC-M6: stub server tests (live, dead, per-cell override). FAC-M7: `scripts/subswitch-run.sh` | covered |
| D-45d | Fix the six conflicts of design §1.3 | §1.3 | Conflicts 1, 2, 3, 5, 6: rows F-6, F-7, F-8, F-9, F-3c. Conflict 4 (context in percent): FAC-M4 `cell list` marks `PREPARE` and `MAX` | covered |
| D-47 | The heartbeat hook comes with the cell control milestone | §4.6 | FAC-M4: hook test and static test | covered |
| D-52a | Approved and assigned work lands with no ask for each PR; `--admin` only at the pinned head | §6 | FAC-M5: head-changed refusal test | covered |
| D-52b | What counts as approval and assignment | §6.1 | FAC-M5: one test for each proof (decision, ask, plan approved through an ask), with direct, decision and tracker assignment; a commit author is refused | covered |
| D-52c | Unapproved work, or a PR with a question for the owner, still waits | §6.1 | FAC-M5: refusal tests; `inspect` exits 3 while the PR has an open ask or andon item | covered |
| D-52d | Releases are not in D-52; they wait for his go | §6.2 | FAC-M5: `ship` no-publish test and the `approval.ship` config test | covered |
| D-52e | factory offers the rule as an owner choice | §4.4 | FAC-M5: `pr merge` tests for `each` and `approved-work` | covered |
| D-53a | Accept F-1 to F-10 as a set | §9 | The rows F-1 to F-10 above | covered by those rows |
| D-53b | Design v2 and a new roadmap replace FAC-M2 to FAC-M7 | §9 | None. `docs/design.md` and `docs/roadmap-v2.md` are the result | not applicable: the answer is the two documents |
| D-53c | The D-51 A review covers the FAC-M1 setup and upgrade code | §9 | FAC-M2: `scripts/check-review-scope.sh docs/reviews/fac-m2-review-summary.md` exits 0 | covered |
| D-53d | FAC-M1 goes to `dean0x/factory` as it is | §9 | FAC-M1 is done (PR #1) | covered |
| D-55a | The doorbell inbox goes into FAC-M4 | §4.12 | FAC-M4: inbox tests (numbered record, constant line, `handled/`, bounded re-rings, restart) | covered |
| D-55b | `factory checkout` goes into FAC-M5 | §4.2 | FAC-M5: `checkout` tests | covered |
| D-55c | The rest of the 8 firstmate ideas, and `inbox next` and `inbox ack` | §4.8, §4.12 | Idea 3 and idea 4: FAC-M8 (`node tree` test, inherit list test). Idea 5: FAC-M5 (report tests) and FAC-M8 (rollup). Idea 8: FAC-M3 (`state pull` and `upgrade` on a dirty state repo). `inbox next` and `inbox ack`: FAC-M4 | covered |
| D-56 | Build order M2, M4, M5, M6, M7, then M3, M8, M9 | §9 | None. The table "Milestones" of the roadmap holds the order. FAC-M10 comes after FAC-M8 and before FAC-M9 | not applicable: a build order, not a feature |

## Notes of the verbatim check (Dean's own words)

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| O-1a | Do the packaging in a new folder | §4.7 | FAC-M1 is done: `dean0x/factory` is its own repo | covered |
| O-1b | A CLI `factory` that creates the setup we have here | §8, §8.1 | FAC-M7: `scripts/check-parity.sh FAC-M7` exits 0; `adopt --dry-run` test. FAC-M4: reboot test | covered |
| O-1c | Think first about how it works | §1 | None. The design and the research came first | not applicable: a request about the order of work |
| O-1d | Other developers, other projects, other machines of Dean | §4.3, §4.7 | FAC-M10: clean machine script (install, `init`, `up --dry-run`, `doctor`). FAC-M3: `init --state-from` test | covered |
| O-1e | One project or many projects | §4.1, §4.3 | FAC-M2: `up` test with one `--add-dir` for each project | covered |
| O-1f | Take ideas from firstmate and mars | §4.8 | Rows D-55a to D-55c | covered by those rows |
| O-1g | Turn routine work into reusable scripts that save tokens | §3, §4.2 | FAC-M2: short-output helper. FAC-M5: `scripts/budget-check.sh` against `docs/token-budget.md` | covered |
| O-1h | Cut the tie to devflow by default | §2.1, §4.9 | FAC-M2: deny list test with the three triage words. FAC-M6: core has no devflow word | covered |
| O-1i | Keep devflow available; find the devflow parts; plug them in or replace them | §2.1, §2.2 | FAC-M6: variant tests and the coordinator `projects` block test | covered |
| O-1j | Start looking into that (look first) | §1 | None | not applicable: a request about the order of work |
| O-1k | A layer above that manages many orchestrators; how it changes the CLI | §5, §5.7 | FAC-M8: rollup over 2 layers | covered |
| O-1l | More layers above, without end | §5.2, §5.7 | FAC-M8: layer-3 rollup, growth test, `doctor` warning for a layer with no template | covered |
| V-F-1a | Names from a real factory | §4.1, §7, §7.1 | FAC-M2: names test | covered |
| V-F-1b | Replace "lane" and "pack" | §7 | FAC-M2: names test; no `@lane` under `src/` | covered |
| V-F-1c | "Pack" is not clear from the name or the description | §4.1, §7 | FAC-M2: glossary test (the entry for recipe) | covered |
| V-F-1d | Keep node, owner, project; Dean is unsure what they mean | §4.1 | FAC-M2: glossary test (node, owner, project). Dean's yes or no to the glossary is in "Decisions needed" | covered |
| V-F-1e | His 11 shop-floor words and the heading with no items | §7.1 | FAC-M2: `scripts/check-intent-docs.sh` counts 11 rows in the table | covered |
| V-F-2a | Maybe do not create an own review desk | §4.10 | None. See F-2b | not applicable: the ask is to not build it |
| V-F-2b | Use the tracker UI and CLI; listen on comments and more from the board | §4.10 | FAC-M3: wake test (comment, label change, assignee change and issue close each cause one record and one doorbell line; another account causes none; `watch` calls no model) | covered |
| V-F-2c | The user picks the tracker, as in devflow | §4.10, §4.4 | FAC-M3: tracker choice test and override test. FAC-M9: `site` and `key` tests and the mixed test | covered |
| V-F-3a | The main session of "Codex" | §4.6 | FAC-M4: `session.agent: claude` loads and another value fails; static test on agent starts | covered |
| V-F-3b | Which folder: the root of the repo, or the root of the folder where he starts | §4.3 | FAC-M2: workspace folder test (two repos and a worktree) and the home index test | covered |
| V-F-3c | Make sure it is figured out; say if not understood | §4.3 | None. The one-page summary of the design answers it | not applicable: a request to confirm |
| V-F-4a | Nodes on the same layer work the same | §5.2 | FAC-M2: role template tests. FAC-M6: same-layer hash test | covered |
| V-F-4b | Nodes on different layers work differently | §5.2 | FAC-M2: `roleForLayer` tests. FAC-M8: the `director` template | covered |
| V-F-4c | All child nodes of one layer work the same | §5.2 | FAC-M2: `add-child` exits 4 for another layer; all cells use the worker role | covered |
| V-F-4d | The layer that runs devflow knows its projects and variants | §5.2, §4.4 | FAC-M6: coordinator knowledge test and same-layer hash test | covered |
| V-F-4e | A new top layer works unlike the two below; the pyramid grows | §5.2, §5.7 | FAC-M8: growth test and layer-3 rollup | covered |

## Gaps of the check

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| Gap 1 | Find the home from a project folder | §4.3 | FAC-M2: home index test | covered |
| Gap 2 | The owner has a view and a way to answer in the `local` period | §4.10, §8 | FAC-M7: `scripts/check-owner-view.sh` and the owner answer pty test. FAC-M3 retires the old scripts | covered |
| Gap 3 | The proof of approval follows D-52 | §6.1 | FAC-M5: one test for each proof, all through the owner channel; `inspect` exits 3 on an open ask | covered |
| Gap 4 | The release question is open | §6.2, §4.4 | FAC-M5: `approval.ship` config test. D-57 is in "Decisions needed" | covered; D-57 is open with Dean |
| Gap 5 | The user picks the tracker at setup | §4.10 | FAC-M3: tracker choice test with a fake `gh` | covered |
| Gap 6 | The adopt moves the coordinator text out of the folder above the checkouts | §8 | FAC-M7: `scripts/check-cell-paths.sh` | covered |
| Gap 7 | The context percent has a proven source | §4.6 | FAC-M4: fixtures from the installed Claude Code; wrapper test | covered |
| Gap 8 | The core works without the `software` recipe | §4.9 | FAC-M6: dependency test and the test recipe `document` | covered |
| Gap 9 | The inbox is the only way; the comms module has a section | §4.12, §5.3 | FAC-M4: static tests (only `src/comms/` types or touches inbox files) | covered |
| Gap 10 | "Safe" has a rule, and the busy case is tested | §4.11 | FAC-M4: `scripts/check-session-stop.sh` (rule and 12 rows) | covered |
| Gap 11 | Nothing publishes without a protected environment and a decision | §4.7 | FAC-M10: the four release scripts and the install tests | covered |
| Gap 12 | Subswitch has real preset values and a criterion | §4.6, §2.2 | FAC-M6: stub server tests. FAC-M7: `scripts/subswitch-run.sh` | covered |
| Gap 13 | The growth of the pyramid is tested | §5.2 | FAC-M8: growth test and layer-3 rollup | covered |
| Gap 14 | Each command has a milestone; the Linux parts are tested | §4.2, §4.7 | FAC-M2: the docs check compares the §4.2 commands with the command map. FAC-M4: `machine` fixtures. FAC-M5: `lock run` tests and the report core | covered |
| Gap 15 | The D-51 A review has an owner | §9 | FAC-M2: `scripts/check-review-scope.sh` | covered |
| Gap 16 | The percent rule for context is checked | §4.6 | FAC-M4: `cell list` marks `PREPARE` and `MAX` at 29, 30, 40 and 41 percent | covered |
| Gap 17 | The accepted firstmate ideas have a place | §4.8 | FAC-M3 (idea 8), FAC-M4 (`inbox next` and `inbox ack`), FAC-M5 and FAC-M8 (idea 5), FAC-M8 (ideas 3 and 4) | covered |
| Gap 18 | Small items: `@lane` name, "lane" in the research doc, the `doc` operation | §5.1, §4.10 | FAC-M2: no `@lane` under `src/`; the docs check finds no whole word `lane` in `docs/research/`. FAC-M3: `doc` operation tests | covered |

## New gaps of the verbatim check

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| A1 | `init` in a folder that holds several repos | §4.3 | FAC-M2: workspace folder test and clone path test | covered |
| A2 | The word "Codex" | §4.6 | FAC-M4: `session.agent` tests. The decision is OD-4 in §9 | covered |
| A3 | Layers 3 and up share the layer-2 role | §5.2, §4.9 | FAC-M2: `roleForLayer(3)` returns no template and `doctor` warns. FAC-M8: the `director` template | covered |
| A4 | The layer-1 role does not know the project variants | §5.2 | FAC-M6: coordinator knowledge test and same-layer hash test | covered |
| A5 | The coordinator does not listen to the board | §4.10, §4.11 | FAC-M3: wake test; `up --dry-run` lists the window `ops` | covered |
| A6 | The tracker choice is weaker than in devflow | §4.4, §4.10 | FAC-M3: tracker choice and override tests. FAC-M9: `site`, `key` and mixed tests | covered |
| A7 | No parity table, and no restore after a reboot | §8.1, §4.11 | FAC-M4: reboot test. FAC-M7: `scripts/check-parity.sh FAC-M7`. FAC-M3: the same script for all rows | covered |
| A8 | Nothing checks that the scripts save tokens | §3, §4.2 | FAC-M2: short-output helper. FAC-M5: `scripts/budget-check.sh` | covered |
| A9 | A new name has no plain description | §4.1, §7 | FAC-M2: glossary test and `factory help words` | covered |
| A10 | Dean's word list has no table | §7.1 | FAC-M2: `scripts/check-intent-docs.sh` counts 11 rows | covered |
| A11 | A second machine of the same owner has no profile | §4.3 | FAC-M3: `init --state-from` integration test | covered |
| A12 | The three triage words are not in the deny list; `desk render` is not marked | §2.2, §4.2 | FAC-M2: deny list test with the three words. `desk` is marked "not built, no milestone" | covered |
