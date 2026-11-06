# Intent trace

This table maps each note from Dean to the text that answers it. It has one row for each ask id of the intent check (the baseline of 2026-11-02 and its verbatim check) and one row for each ask of the design v3 feedback. The intent check at each milestone merge reads the rows of that milestone. A row that is not covered blocks the merge, or moves to a named later milestone with a reason.

How to read the table:
- **Ask id.** `F-n`, `D-n` and `O-1x` are the ids of the first table of the check. `V-F-nx` is a row of the verbatim check, which compares Dean's own words. `Gap n` is a numbered gap of the check (1 to 19). `A1` to `A12` are the new gaps of the verbatim check. `F-14a` to `F-21c`, `D-57`, `D-59` and `D-60` are the asks of the design v3 feedback. `F-22a` to `F-25f` are the asks of the usage notes of 2026-11-03. The letter gives the part of the note.
- **Design section.** A heading of `docs/design.md`. A numbered section has its mark and number. The parts "Core and setup" and "Extension points" are named, because docs check 9 accepts their headings with no number.
- **Milestone and exit criterion.** A milestone of `docs/roadmap-v2.md` and the check that proves the ask. The word "criterion" refers to the exit criteria of that milestone. "Design v3 PR" is the label of the milestone in the roadmap that has the two checkboxes for the docs PR and the code PR.
- **Status.** `covered` means that the design and the roadmap answer the ask. `not applicable` gives the reason.

`scripts/check-intent-docs.sh` (FAC-M2) checks that each design section here is a heading of the design, that each milestone id is named in the roadmap, and that the label "Design v3 PR" is a heading of the roadmap with its two checkboxes.

## Notes of the first table

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| F-1a | Replace "lane" and "pack" with factory words | §4.1, §7 | FAC-M2: the names test finds no `lane`, `pack` or `brief` in `--help`, templates and files that `init` writes, and no `@lane` under `src/`. Design v3 PR: the same test finds none of the eight words of the setup of today (design §7) | covered |
| F-1b | Keep node, owner, project | §4.1 | FAC-M2: names test; glossary test (entries for node, owner, project) | covered |
| F-1c | Factory words for commands and items | §4.1, §4.2, §7 | FAC-M4 (session reset) and FAC-M5 (request, queue, check, release check): each command has its own criterion. FAC-M2: names test and glossary test. Design v3 PR: the plain-words table (D-59) | covered |
| F-2a | Use the team tracker (GitHub, Jira, Linear); the user picks it | §4.10, §4.4 | FAC-M3: tracker choice test (`init --tracker github` with a fake `gh`; `doctor` exits 0; a public store exits 4). FAC-M9: Jira and Linear | covered |
| F-2b | Do not build an own review desk | §4.10, §4.2 | None. The command map has no desk row, and docs check 3 fails on one (F-17a) | not applicable: the ask is to not build it |
| F-2c | A decision is a labelled item; a script reads the answer; private store; bounded watch | §4.10, §6 | FAC-M3: `decide read` tests (owner account only), `doctor` fails on a public store, `watch` bound test | covered |
| F-2d | Plans and designs: link the repo file or attach it | §4.10 | FAC-M3: the contract tests name the `doc` operation (attach a file, link a repo file) | covered |
| F-3a | Say where the main session runs | §4.3 | FAC-M2: `init` tests (exit 4 rules) and the `start` test on a separate tmux server | covered |
| F-3b | The user does not need to know the folder; `factory start` finds it | §4.3 | Design v3 PR (moved from FAC-M2: D-60 makes the factory one folder): the factory folder holds `factory.yaml`, so `start --dry-run` and `doctor` exit 0 from the factory folder, from the coordinator folder and from a project clone | covered |
| F-3c | A worker does not load the coordinator instructions | §4.3, §8 | FAC-M2 (a new node), FAC-M7: `scripts/check-worker-paths.sh` passes on the adopted fixture and fails on the fixture before the adopt | covered |
| F-3d | One project or many: the same layout | §4.1, §4.3 | FAC-M2: `start` test with one `--add-dir` for each project | covered |
| F-4a | Same layer, same behavior; the role comes from the layer | §5.2 | FAC-M2: role template tests; `node add-child` exits 1 for another layer | covered |
| F-4b | The pyramid can grow; a new top layer changes nothing below | §5.2, §5.7 | FAC-M8: growth test (hashes of the nodes below stay the same) and the layer-3 rollup test | covered |
| F-5 | macOS and Linux only | §4.7 | FAC-M2: fake `win32` refusal test. FAC-M4: `machine` fixtures for both systems. FAC-M5: `lock run` with `flock` and `lockf`. CI runs on Ubuntu and macOS | covered |
| F-6a | Approved and assigned work merges when the gates pass, with no ask for each PR | §6, §6.1 | FAC-M5: `pr merge` tests, one for each proof, for both kinds of assignment, and the refusals; template test: the coordinator role text and the fixed rules follow the approval setting | covered |
| F-6b | Does "a-z" include releases? | §6.2, §9 | FAC-M5: the `approval.release` config test and the no-publish test. D-57 is answered: releases wait for the owner | covered |
| F-6c | The owner chooses the merge rule | §4.4, §6 | FAC-M5: `pr merge` tests for `owner` and `delegated` | covered |
| F-7 | Test the ways to stop a session, then use the best one | §4.11 | FAC-M4: the rule for "safe" and 12 rows in `docs/session-stop.md` (`scripts/check-session-stop.sh`); `worker stop` uses the safe way; a busy worker with no safe way exits 3 | covered |
| F-8 | Workers in their own window; the view has the coordinator and one slot | §4.11 | FAC-M4: tmux tests (`worker new`, `worker summon`, return of the board). FAC-M7: the adopt | covered |
| F-9a | No read under `~/.claude`; a hook replaces them | §4.6, §6 | FAC-M4: static test (no source file or template names such a path); hook test | covered |
| F-9b | The hook gives session id, last activity and context percent | §4.6 | FAC-M4: fixtures from the installed Claude Code; the hook parses them; the status line wrapper passes the output of the owner's command through | covered |
| F-9c | Remove the "avoid reads" instruction | §4.6 | FAC-M4: static test on the templates | covered |
| F-10a | One general core; the recipe decides the kind of factory | §4.9, §4.4 | FAC-M2: schema split. FAC-M6: dependency test and the test recipe `document` | covered |
| F-10b | `software` first, in a plain and a devflow form | §4.9, §2.2 | FAC-M2 (plain), FAC-M6 (devflow) | covered |
| F-11 | Git commands for multi-repo work, from mars | §3, §4.2 | FAC-M5: `copies` tests on fixture repos, with the case `STUCK:` | covered |
| F-12a | Analysis of firstmate: what it is, how it works, what factory takes | §4.8 | None. `docs/research/firstmate-and-mars.md` is the answer | not applicable: the answer is a document |
| F-12b | Explain the doorbell inbox; make it the only way to send text | §4.12 | FAC-M4: session-name tests; static test that only `src/comms/` types into a pane; typed line of at most 300 characters, constants only. Native messages replace the inbox (D-101) | covered |
| F-12c | Communication as its own module | §4.12, §5.3 | FAC-M4: static test (only `src/comms/` holds a tmux input verb); FAC-M5 `report`, FAC-M8 `deliver` | covered |
| F-13 | Same machine only; no remote host | §5.3, §4.4 | FAC-M2: the config refuses `ssh://`, `https://` and relative addresses (tests) | covered |
| D-45a | TypeScript on Node 22+, `factory`, `@dean0x/factory`, MIT, `.factory/`, `factory.yaml` | §4.7, §9 | FAC-M1 is done (PR #1) | covered |
| D-45b | Private repo until a team member installs it; an npm publish waits for Dean's go | §4.7 | FAC-M10: `scripts/check-release-workflow.sh`, `scripts/release-gate.sh` tests, `scripts/check-environment.sh`, `scripts/check-private.sh`. Note (2026-11-06): early access is not this trigger. Dean approved it (B-175 A): one developer installs from the private repo at a private tag, with no publish (D-49) | covered |
| D-45c | Subswitch as a proxy option for each node and each worker, with a health check and no stray variable | §4.6, §2.2 | FAC-M6: stub server tests (live, dead, per-worker override). FAC-M7: `scripts/subswitch-run.sh` | covered |
| D-45d | Fix the six conflicts of design §1.3 | §1.3 | Conflicts 1, 2, 3, 5, 6: rows F-6, F-7, F-8, F-9, F-3c. Conflict 4 (context in percent): FAC-M4 `worker list` marks `PREPARE` and `MAX` | covered |
| D-47 | The last-seen hook comes with the worker control milestone | §4.6 | FAC-M4: hook test and static test | covered |
| D-52a | Approved and assigned work lands with no ask for each PR; `--admin` only at the pinned head | §6 | FAC-M5: head-changed refusal test | covered |
| D-52b | What counts as approval and assignment | §6.1 | FAC-M5: one test for each proof (decision, ask, plan approved through an ask), with direct, decision and board assignment; a commit author is refused | covered |
| D-52c | Unapproved work, or a PR with a question for the owner, still waits | §6.1 | FAC-M5: refusal tests; `check` exits 3 with `NOT READY` while the PR has an open ask or an open request | covered |
| D-52d | Releases are not in D-52; they wait for his go | §6.2 | FAC-M5: the `release check` no-publish test and the `approval.release` config test | covered |
| D-52e | factory offers the rule as an owner choice | §4.4 | FAC-M5: `pr merge` tests for `owner` and `delegated` | covered |
| D-53a | Accept F-1 to F-10 as a set | §9 | The rows F-1 to F-10 above | covered by those rows |
| D-53b | Design v2 and a new roadmap replace FAC-M2 to FAC-M7 | §9 | None. `docs/design.md` and `docs/roadmap-v2.md` are the result | not applicable: the answer is the two documents |
| D-53c | The D-51 A review covers the FAC-M1 setup and upgrade code | §9 | FAC-M2: `scripts/check-review-scope.sh docs/reviews/fac-m2-review-summary.md` exits 0 | covered |
| D-53d | FAC-M1 goes to `dean0x/factory` as it is | §9 | FAC-M1 is done (PR #1) | covered |
| D-55a | The doorbell inbox goes into FAC-M4 | §4.12 | Replaced by D-101 (native cross-session messages). FAC-M4: session-name, `worker new --assignment`, `worker reset` and `worker watch` tests | covered |
| D-55b | The git commands across work copies (`factory copies`) go into FAC-M5 | §4.2 | FAC-M5: `copies` tests | covered |
| D-55c | The rest of the 8 firstmate ideas, and `inbox next` and `inbox ack` | §4.8, §4.12 | Idea 3 and idea 4: FAC-M8 (`node tree` test, inherit list test). Idea 5: FAC-M5 (report tests) and FAC-M8 (rollup). Idea 8: FAC-M3 (`state pull` and `upgrade` on a dirty state repo). `inbox next` and `inbox ack`: retired by D-101 (no records) | covered |
| D-56 | Build order M2, M4, M5, M6, M7, then M3, M8, M9 | §9 | None. The table "Milestones" of the roadmap holds the order. FAC-M10 comes after FAC-M8 and before FAC-M9 | not applicable: a build order, not a feature |

## Notes of the verbatim check (Dean's own words)

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| O-1a | Do the packaging in a new folder | §4.7 | FAC-M1 is done: `dean0x/factory` is its own repo | covered |
| O-1b | A CLI `factory` that creates the setup we have here | §8, §8.1 | FAC-M7: `scripts/check-parity.sh FAC-M7` exits 0; `adopt --dry-run` test. FAC-M4: test `start resumes the recorded workers after kill-server` | covered |
| O-1c | Think first about how it works | §1 | None. The design and the research came first | not applicable: a request about the order of work |
| O-1d | Other developers, other projects, other machines of Dean | §4.3, §4.7 | FAC-M4: the received-factory test: a fixture config repo is cloned into a temporary HOME, one `init` with a fake terminal accepts the setup text and clones the projects, then `start --dry-run` and `doctor` exit 0 (TP-29 extended). FAC-M10: clean machine script (install, `init`, `start --dry-run`, `doctor`); until FAC-M10, a developer with read access installs the program from a private early-access tag (D-49). FAC-M3: `init --state-from` test | covered |
| O-1e | One project or many projects | §4.1, §4.3 | FAC-M2: `start` test with one `--add-dir` for each project | covered |
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
| V-F-2b | Use the tracker UI and CLI; listen on comments and more from the board | §4.10 | FAC-M3: wake test (comment, label change, assignee change and issue close each cause one record and one constant wake line; another account causes none; `watch` calls no model) | covered |
| V-F-2c | The user picks the tracker, as in devflow | §4.10, §4.4 | FAC-M3: tracker choice test and override test. FAC-M9: `site` and `key` tests and the mixed test | covered |
| V-F-3a | The main session of "Codex" | §4.6 | FAC-M4: `session.agent: claude` loads and another value fails; static test on agent starts | covered |
| V-F-3b | Which folder: the root of the repo, or the root of the folder where he starts | §4.3 | FAC-M2: workspace folder test (two repos and a worktree). Design v3 PR (moved from FAC-M2: D-60): the lookup from the factory folder, the coordinator folder and a project clone | covered |
| V-F-3c | Make sure it is figured out; say if not understood | §4.3 | None. The one-page summary of the design answers it | not applicable: a request to confirm |
| V-F-4a | Nodes on the same layer work the same | §5.2 | FAC-M2: role template tests. FAC-M6: same-layer hash test | covered |
| V-F-4b | Nodes on different layers work differently | §5.2 | FAC-M2: `roleForLayer` tests. FAC-M8: the `director` template | covered |
| V-F-4c | All child nodes of one layer work the same | §5.2 | FAC-M2: `add-child` exits 1 for another layer; all workers use the worker role | covered |
| V-F-4d | The layer that runs devflow knows its projects and variants | §5.2, §4.4 | FAC-M6: coordinator knowledge test and same-layer hash test | covered |
| V-F-4e | A new top layer works unlike the two below; the pyramid grows | §5.2, §5.7 | FAC-M8: growth test and layer-3 rollup | covered |

## Gaps of the check

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| Gap 1 | Find the factory folder from a project folder | §4.3 | Design v3 PR (moved from FAC-M2: D-60): the lookup from the factory folder, the coordinator folder and a project clone | covered |
| Gap 2 | The owner has a view and a way to answer in the `local` period | §4.10, §8 | FAC-M7: `scripts/check-owner-view.sh` and the owner answer pty test. FAC-M3 retires the old scripts | covered |
| Gap 3 | The proof of approval follows D-52 | §6.1 | FAC-M5: one test for each proof, all from the owner's account or from a terminal window outside a factory session; `check` exits 3 on an open ask | covered |
| IF-10 | A tracker event proves the owner only when the agents use another identity | §4.10, §6.1 | FAC-M5: tracker identity tests (shared account refuses tracker proofs and accepts `factory decide`; separate accounts accept owner events and refuse agent events); `doctor` warning test; README setup check | covered |
| Gap 4 | The release question is open | §6.2, §4.4 | FAC-M5: `approval.release` config test. D-57 is answered: releases wait for the owner | covered |
| Gap 5 | The user picks the tracker at setup | §4.10 | FAC-M3: tracker choice test with a fake `gh` | covered |
| Gap 6 | The adopt moves the coordinator text out of the folder above the work copies | §8 | FAC-M7: `scripts/check-worker-paths.sh` | covered |
| Gap 7 | The context percent has a proven source | §4.6 | FAC-M4: fixtures from the installed Claude Code; wrapper test | covered |
| Gap 8 | The core works without the `software` recipe | §4.9 | FAC-M6: dependency test and the test recipe `document` | covered |
| Gap 9 | The inbox is the only way; the comms module has a section | §4.12, §5.3 | FAC-M4: static test (only `src/comms/` types into a pane) | covered |
| Gap 10 | "Safe" has a rule, and the busy case is tested | §4.11 | FAC-M4: `scripts/check-session-stop.sh` (rule and 12 rows) | covered |
| Gap 11 | Nothing publishes without a protected environment and a decision | §4.7 | FAC-M10: the four release scripts and the install tests | covered |
| Gap 12 | Subswitch has real preset values and a criterion | §4.6, §2.2 | FAC-M6: stub server tests. FAC-M7: `scripts/subswitch-run.sh` | covered |
| Gap 13 | The growth of the pyramid is tested | §5.2 | FAC-M8: growth test and layer-3 rollup | covered |
| Gap 14 | Each command has a milestone; the Linux parts are tested | §4.2, §4.7 | FAC-M2: the docs check compares the §4.2 commands with the command map. FAC-M4: `machine` fixtures. FAC-M5: `lock run` tests and the report core | covered |
| Gap 15 | The D-51 A review has an owner | §9 | FAC-M2: `scripts/check-review-scope.sh` | covered |
| Gap 16 | The percent rule for context is checked | §4.6 | FAC-M4: `worker list` marks `PREPARE` and `MAX` at 29, 30, 40 and 41 percent | covered |
| Gap 17 | The accepted firstmate ideas have a place | §4.8 | FAC-M3 (idea 8), FAC-M5 and FAC-M8 (idea 5), FAC-M8 (ideas 3 and 4) | covered |
| Gap 18 | Small items: the `@lane` name, the word `lane` in the research doc, the `doc` operation | §5.1, §4.10 | FAC-M2: no `@lane` under `src/`; the docs check finds no whole word `lane` in `docs/research/`. FAC-M3: `doc` operation tests | covered |
| Gap 19 | A proxy host receives the API traffic of the node; the owner is warned about a host that is not loopback | §4.6 | FAC-M5: unit test: `doctor` warns when the proxy host is not loopback, and gives no warning for a loopback host | covered |

## New gaps of the verbatim check

| Ask id | Short ask | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| A1 | `init` in a folder that holds several repos | §4.3 | FAC-M2: workspace folder test and clone path test | covered |
| A2 | The word "Codex" | §4.6 | FAC-M4: `session.agent` tests. The decision is IF-4 in §9 | covered |
| A3 | Layers 3 and up share the layer-2 role | §5.2, §4.9 | FAC-M2: `roleForLayer(3)` returns no template and `doctor` warns. FAC-M8: the `director` template | covered |
| A4 | The layer-1 role does not know the project variants | §5.2 | FAC-M6: coordinator knowledge test and same-layer hash test | covered |
| A5 | The coordinator does not listen to the board | §4.10, §4.11 | FAC-M3: wake test; `start --dry-run` lists the window `ops` | covered |
| A6 | The tracker choice is weaker than in devflow | §4.4, §4.10 | FAC-M3: tracker choice and override tests. FAC-M9: `site`, `key` and mixed tests | covered |
| A7 | No parity table, and no restore after a reboot | §8.1, §4.11 | FAC-M4: test `start resumes the recorded workers after kill-server`. FAC-M7: `scripts/check-parity.sh FAC-M7`. FAC-M3: the same script for all rows | covered |
| A8 | Nothing checks that the scripts save tokens | §3, §4.2 | FAC-M2: short-output helper. FAC-M5: `scripts/budget-check.sh` | covered |
| A9 | A new name has no plain description | §4.1, §7 | FAC-M2: glossary test and `factory help words` | covered |
| A10 | Dean's word list has no table | §7.1 | FAC-M2: `scripts/check-intent-docs.sh` counts 11 rows | covered |
| A11 | A second machine of the same owner has no profile | §4.3 | FAC-M3: `init --state-from` integration test | covered |
| A12 | The three triage words are not in the deny list; a desk command is not marked | §2.2, §4.2 | FAC-M2: deny list test with the three words. Design v3 PR: the design has no desk command, and docs check 3 fails on a desk row (F-17a) | covered |

## Notes of the design v3 feedback

Dean gave these notes on 2026-11-02 as F-14 to F-21, D-57, D-59 and D-60. He gave four more notes on 2026-11-03 as F-22 to F-25. They ask for a usage view, a token estimate and a token meter package. One row holds one part of a note. In the rows F-14a to F-25f, the second column quotes a short part of Dean's own note, as he typed it (speech to text). The rows D-57, D-59 and D-60 state a decision. The milestone "Design v3 PR" has two PRs: the docs PR brings the design text, and the code PR brings the code.

| Ask id | Dean's words (short quote) | Design section | Milestone and exit criterion | Status |
|---|---|---|---|---|
| F-14a | "I do want this to bring those concepts to the everyday world." | §4.1, §7 | Design v3 PR: the glossary teaches the new words, and an old word shows there only in the mark `(was: old word)`. The plain-words table is in `docs/glossary.md` and `test/helpers/plain-words.ts`. The docs scan finds none of the eight old words and no scanned jargon word in the design, the roadmap, the token budget, this trace and the glossary, outside code, the mapping tables, that mark and the quoted notes of four trace rows. The code PR renames the program words in `src/names.ts` and `src/glossary.ts`, and then the glossary test compares them with `docs/glossary.md` again | covered |
| F-14b | "I don't like lane, though." and "the thing that you called Andon. I don't know that word." | §7, §7.1 | Design v3 PR: design 7 has a table that maps each word of the v2 design to its new word, and design 7.1 maps Dean's 11 words; in the code PR, the names test finds none of the eight old words in a user value of `src/names.ts`, and the pane option is `@worker` | covered |
| F-14c | "They're a bit strange, I think, to someone who does not come from software factories." | §4.1, §7 | Design v3 PR: the plain-words table has a row for each jargon term and marks it "scanned" or "by hand". The scan covers the docs of the docs PR. The core parts of the design (the summary, 4.1, the core commands and the rules for every factory) hold no software word outside the lines that start with `Software recipe:` or `Engineering note:`. In the code PR, the scan covers the README, the unreleased part of the CHANGELOG and the text that `src` prints | covered |
| F-15a | "They should be configurable when you set up a factory in a folder." | §6, §6.1, §6.2 | Design v3 PR: `init` asks for the mode of each approval point, `owner` or `delegated`, with `owner` as the default. FAC-M5: `pr merge` and `release check` tests for both modes | covered |
| F-15b | "I think the coordinator home folder should encapsulate everything below it: the clones, the repos." | §4.3 | Design v3 PR: the factory folder holds the clones, the coordinator folder and the work copies (D-60); F-18a has the checks | covered |
| F-15c | "It's very software-development-oriented. If it would be like a marketing factory, then what do we still have: releases and PRs?" | §4.2, §4.9, §6 | Design v3 PR: docs check 10 (the core parts hold no word of the software recipe: the summary, 4.1, the core commands of 4.2 and the rules for every factory in 6 of the design, and the words of every factory in the glossary. Only the summary, 4.1 and the glossary part accept such a word, in a line that starts with `Software recipe:` or `Engineering note:`). The rules of the software recipe, 6.1 and 6.2 are apart, and design 4.9 gives a recipe with no software (publish a post). The glossary has a part for the software recipe. In the code PR, the software recipe owns its words, and a test recipe runs `init`, `doctor`, `upgrade` and `start --dry-run` | covered |
| F-16a | "He would have his own way to do priorities and, I don't know, his own software development lifecycle, configuration skills, whatnot." | "Core and setup" | Design v3 PR: the table of the part "Core and setup" lists them as setup, and docs check 9 finds the heading. FAC-M6: the shareable setup | covered |
| F-16b | "I need to be able, for example, for my setup, to share the way I do priorities, the way I work with devflow." | "Core and setup", §4.3 | Design v3 PR: `setup/coordinator.md` travels in git, and the owner accepts its hash. FAC-M6: a second factory folder takes a setup from a fixture repo at an accepted commit | covered |
| F-16c | "The user can adapt it and still, when needed, get new features" | "Core and setup", §4.5 | Design v3 PR: `upgrade` keeps the lines that a person adds to the root `.gitignore`. FAC-M6: upgrades never overwrite a setup file (upgrade test) | covered |
| F-16d | "We should provide the infrastructure, or the metal, for someone to run the factory orchestration, but with his own workflows" | "Core and setup" | Design v3 PR: the table of the part "Core and setup" lists the fixed rules as core and the other files as setup; a manual read of the table in the review of the docs PR | covered |
| F-17a | "Review desk articfact should not be included not even optionally. There shouldn't be a rule for it." | §4.2, "Extension points" | Design v3 PR: design 4.2 and the command map have no desk row, and docs check 3 fails on one; in the code PR, a static test finds no word desk in `src/` | covered |
| F-17b | "One user might want to create himself a review desk in an artifact. In case that user wants to do that, we need to be able to support it." | "Extension points" | FAC-M5: the event file and `report --json` hold the fields that the part "Extension points" lists, and a sample reader outside `src/` reads them. FAC-M6: a desk reader as a setup file | covered |
| F-17c | "we need to minimize basically how much we get in the way" | §4.3 | Design v3 PR: design 4.3 "Stops and warnings" has a table "Stop, When, Remedy command" for every stop and warning, and every stop prints one remedy line with the same command; the sections that define a stop name that command; in the code PR, the stops test runs each stop | covered |
| F-17d | "you just have the config. When you install locally, clone it, and run it, it clones locally the repos that are relevant to this workspace configuration." | §4.3 | Design v3 PR: design 4.3 "Share a factory" and the box "Receiving a factory": the config repo holds the config and no clones, and `init` clones each listed repo. FAC-M4: the received-factory test (TP-29 extended) | covered |
| F-18a | "I want the factory to be an encapsulated unit." | §4.3 | Design v3 PR: the factory folder is one git repo with the clones, the coordinator folder and the work copies, and `start --dry-run` and `doctor` exit 0 from the factory folder, the coordinator folder and a project clone | covered |
| F-18b | "It could sit in a folder next to all the cloned repos. This way, they won't load each other's cloud.md files." | §4.3, §8 | Design v3 PR: the coordinator folder is not above any work copy, and the top of the factory folder holds no instruction file. FAC-M7: `scripts/check-worker-paths.sh` | covered |
| F-18c | "I don't want to push multiple clones of the same repo sometimes to a repo, so we need to use some kind of Mars-like way" | §4.3, §4.8 | Design v3 PR: `factory.yaml` lists each repo once, and the work copies in `work-copies/` do not travel. FAC-M4: `worker new` and `dismiss` tests | covered |
| F-18d | "I might want to run a few different factories on the same machine" | §4.3 | Design v3 PR: the registration check ties a config to its entry in the factory list, and `init` refuses a new factory folder inside a listed folder | covered |
| F-18e | "the same instances of a factory on different machines" | §4.3 | Design v3 PR: the same config repo makes the same factory on a second machine. FAC-M3: the criterion `init --state-from` moves the work state to a second machine. FAC-M4: `start` warns when another machine is active | covered |
| F-18f | "I can share that factory unit with another developer. You can start work over there as if nothing happened." | §4.3 | Design v3 PR: design 4.3 "Share a factory" and the box "Receiving a factory" list the files that travel, the one command, each prompt of `init` and the setup acceptance. With no terminal window, `init` stops on a received factory that tracks other files, also with `--yes`. FAC-M4: integration test (TP-29 extended): a fixture config repo is cloned into a temporary HOME; `init` with a fake terminal accepts the setup text, clones the projects and registers the factory; then `start --dry-run` and `doctor` exit 0. The work state of a shared factory: FAC-M3 | covered |
| F-19a | "I want to manage multiple projects, multiple repos, and GitHub through one dashboard. Is that possible?" | §4.10 | Design v3 PR: design 4.10 answers "Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos." FAC-M3: the first criterion is a recorded run of real `gh project` commands on a private throw-away project with two repos | covered |
| F-19b | "And also in other task management tools like Jira and Linear" | §4.10, §4.4 | FAC-M3: GitHub. FAC-M9: Jira and Linear list the work of two projects or two teams in one board view, and the roadmap gives the reason for the order. Design 4.10 marks Jira and Linear "Not checked yet: FAC-M9" | covered |
| F-20a | "I think our factory needs the whole lifecycle commands" | §4.2, §4.11 | FAC-M4: one named test for each verb, and `start` resumes the recorded workers after a machine restart | covered |
| F-20b | "like shutdown, reboot, restart, start" | §4.2, §4.11 | FAC-M4: test `reboot stops and starts every worker of this factory`. A separate test covers each of `shutdown`, `restart` and `start` | covered |
| F-21a | "I don't know, maybe dismiss, discharge, something of this nature." | §4.2, §4.11 | FAC-M4: `status` shows the idle state, and `dismiss --idle` lists the idle workers and the owner picks (tests); the setting `limits.idle_after` | covered |
| F-21b | "And maybe also a cleanup or something like that." | §4.11 | FAC-M4: test `dismiss frees a work copy only when its work is pushed` | covered |
| F-21c | "Their names are already outdated." | §4.11 | FAC-M4: `status` shows the work item of each worker, so a name that differs from its work is visible. FAC-M7: each old worker of this workspace gets a name from its current work item | covered |
| F-22a | "I want us to implement it now on our live board" | §4.2 | FAC-M5 holds only the part in factory (F-22b to F-22g). The live board of the owner's workspace is not factory work. The workspace builds that part now, so no factory milestone holds it | not applicable: workspace work, not factory work |
| F-22b | "but also bake it into the plan of the factory" | §4.2 | FAC-M5: scope item 10 and its exit criteria in the roadmap. The usage view is `factory status --usage`. Test `status --usage shows tokens, limits and work counts for two subscriptions`: line 1 is the verdict, and the output is short | covered |
| F-22c | "the different subscription quotas I have and the weekly limits if I have" | §4.6 | FAC-M5: the usage view shows the quota or weekly limit percent of each subscription, when the data of the subscription has it. FAC-M4 task 2 records which quota or cost fields the real status line data has | covered |
| F-22d | "Right now I have Codex and Claude" | §4.6 | FAC-M5: the usage view covers Claude Code, from the hook and status line data. A subscription other than Claude Code, such as Codex, needs a decision on the worker agent setting first (roadmap, "Decisions needed") | covered |
| F-22e | "our token consumption per subscription, per endpoint, whatever, per model: what is our token consumption today, this month, this week?" | §4.6 | FAC-M5: the usage view shows the token use of each subscription and each model, for today, this week and this month. When a session uses a relay server, it also splits the use by the relay server address, which the local file holds. It reads only data that factory records or that the token meter package gives, never a file under `~/.claude` | covered |
| F-22f | "how many features, how many lines of code, counts of something like that" | §4.2 | FAC-M5: the usage view shows the work counts (items closed and lines changed) for the same three periods | covered |
| F-22g | "start quantifying tasks in tokens" | §4.2 | FAC-M5: the usage view shows the measured tokens of each work item. Row F-23a builds the estimate on these values | covered |
| F-23a | "Let's say you had to estimate the amount of tokens it would take." | §3 | FAC-M5: test `item estimate gives a token range from closed items`. With enough similar closed items, `factory item estimate <id>` prints a token range and its basis. With fewer, it prints `NO BASIS` and exits 3 | covered |
| F-23b | "How much work do we have there in general?" | §3 | FAC-M5 holds only the estimate command (F-23a). The question about the work that is left is a one-time question. A one-time estimate outside the factory code answers it | not applicable: a one-time question, not a feature |
| F-24a | "I want us to come up with a system to measure token consumption first and collect the data that we need to estimate tasks." | §4.6 | FAC-M5: scope item 10. The usage view uses the token meter package (`dean0x/tokenmeter`) for the measured token use. The estimate of row F-23a reads the measured tokens of closed items | covered |
| F-24b | "I think I want to bake this into the factory" | §4.2 | FAC-M5: scope item 10 holds the factory part (rows F-22b to F-23a). The usage view uses the package and builds no count of its own | covered |
| F-24c | "but for now, build those scripts and that system here." | §4.2 | None. The workspace builds the token meter now, and the factory takes it in FAC-M5 (row F-24b). Row F-22a gives the same split for the live board | not applicable: workspace work, not factory work |
| F-24d | "be able to see a forecast of the consumption and the capacity of the factory on the live board" | §4.6 | The workspace shows the forecast on its live board now (row F-24c). FAC-M5: scope item 10 and the criterion "Forecast and share (F-24)". The package computes the forecast and the capacity, and the usage view shows the forecast that the package gives | moved to FAC-M5: criterion "Forecast and share (F-24)" |
| F-24e | "for each task, assign the number of tokens it would take" | §4.2 | FAC-M5: test `item estimate gives a token range from closed items` (row F-23a) | covered |
| F-24f | "I know it's 50%, 100%, or 20% of weekly capacity, then I know what tasks to prioritize" | §4.2 | FAC-M5: scope item 10 and the criterion "Forecast and share (F-24)". The share of the weekly capacity is a value of the package, and the usage view shows it | moved to FAC-M5: criterion "Forecast and share (F-24)" |
| F-24g | "maybe it would be a good idea to wrap this module in its own package so that it's reusable." | §4.6 | None. The package `dean0x/tokenmeter` is a separate project with no devflow dependency. FAC-M5: scope item 10 uses it as a package | not applicable: the package is its own project, outside the factory code |
| F-24h | "We would then expose it and integrate with this CLI here." | §4.2 | FAC-M5: scope item 10. `factory status --usage` uses the package, so the factory CLI integrates with it | covered |
| F-25a | "If the token meter is dependent on Devflow somehow, that's not useful. We don't want to have that dependency." | §4.6 | FAC-M5: scope item 10 says that the package has no devflow dependency. The usage view uses the package and the data that factory records | covered |
| F-25b | "if you're reading anything from my Devflow status line, that's not good." | §4.6 | Design 4.6: the wrapper `factory hook statusline` reads the JSON that Claude Code passes on stdin. It reads nothing of the output of the status line command, and it passes that output through unchanged | covered |
| F-25c | "Devflow status line should use the token meter." | §4.6 | None. The devflow status line belongs to devflow. Factory passes the output of the status line command through unchanged (design 4.6) | not applicable: devflow work, not factory work |
| F-25d | "I want token evaluation within our factory" | §4.6 | FAC-M5: scope item 10 and the criterion "Usage view (F-22)". The usage view uses the package | covered |
| F-25e | "I want to see it here in the tmux panel on the right" | §4.11 | None. The live board of the workspace is not factory work (row F-22a). The workspace shows the token meter there now (row F-24c) | not applicable: workspace work, not factory work |
| F-25f | "and also within the factory CLI that we're running. It could consume the token meter, possibly" | §4.2 | FAC-M5: scope item 10. `factory status --usage` uses the package (row F-24h) | covered |
| D-57 | The release is an approval point of its own, and releases wait for the owner | §6.2 | Design v3 PR: design 6.2: every release waits for the owner by default. FAC-M5: the release proof test, the `approval.release` config test and the no-publish test | covered |
| D-59 | The glossary words: worker, request, coordinator, queue, check and release check | §4.1, §7, §7.1 | Design v3 PR: the design, the roadmap and the glossary use the new words; the docs scan checks them. The code PR renames the program words in `src/names.ts` and `src/glossary.ts`; the names test, the glossary test and the docs scan then pass | covered |
| D-60 | A factory is one folder. The config is at the root, as a shareable git repo with no CLAUDE.md. The coordinator runs in its own folder next to the clones. A mars-like list names the repos. Several factories run on one machine, and one factory runs on several machines | §4.3, §4.4 | Design v3 PR: design 4.3 and 4.4 (the config is split into a shared file and a local file), the lookup of the factory folder (moved from FAC-M2) and the config tests for both files. FAC-M3: the work state on a second machine | covered |
