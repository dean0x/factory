# factory: design

Status: v3, decided (v1: D-45 A, D-46 B, D-47 yes on 2026-11-01; v2: D-49, D-51 A, D-52, D-53 on 2026-11-02; v3: D-59, D-60 and the Gate 1 and Gate 2 answers on 2026-11-02) · Author: factory-design · Date: 2026-11-02
Roadmap: `docs/roadmap-v2.md` (proposal). It replaces FAC-M2 to FAC-M7 of the v1 roadmap.

## Changes in v3

Dean gave the feedback F-14 to F-21 and the decisions D-59 and D-60 on 2026-11-02. The Gate 1 and Gate 2 answers closed the open points (§9, table v3). Nothing is released, so v3 changes the FAC-M2 design in place. v3 makes these changes:
1. **Plain words (F-14, D-59, D-11).** Text that a user reads uses everyday words. The table is in `docs/glossary.md`. A worker session is a **worker**. An item that waits for the owner is a **request**. A written task is an **assignment**. The merge order is the **queue**. The merge check is `factory check <pr>`. Code names, config keys and command names stay. See §4.1 and §7.
2. **One folder (F-18, D-60).** The factory is one folder and one git repo. It holds the config, the clones of the projects, the coordinator folder and the work copies. The folder has no instruction file at its top. One factory runs on several machines from the same repo, and one machine runs several factories (§4.3).
3. **A shared file and a local file (F-18).** `factory.yaml` travels in git. `factory.local.yaml` holds the personal values, the credentials and the values of one machine. It has mode 600 (§4.4).
4. **Approval points (F-15, D-57).** The core knows approval points and work items only. The recipe lists the approval points and owns the words merge, pull request and release. `init` asks the owner for the mode of each point: `owner` or `delegated` (§6).
5. **Core and setup (F-16).** The core is the metal. A setup is text and scripts that a person adds on top. The owner accepts the setup text by its hash (D-13) (§4.13).
6. **No desk, few stops (F-17).** The design has no review desk of its own. It lists the extension points instead (§4.14). Only a security boundary stops a command, and every stop prints the command that fixes it (§4.3). Change of 2026-11-08 (TB-5 to TB-7 in §9): the review page of today stays a supported owner view that the owner can choose. It reads the local files (§4.10).
7. **One board for many repos (F-19).** Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Not checked yet for Jira and Linear: FAC-M9 (§4.10).
8. **Lifecycle (F-20, F-21).** The commands `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` have a milestone and a test each. The design defines an idle worker (§4.2, §4.11).
9. **Leftovers.** The docs hold no local machine path (docs check 8). D-57 is answered: the release proof is an owner-approved release scope (§6.2).

## Changes from v1

Dean gave the feedback F-1 to F-10 on v1, and accepted the proposals as a set (D-53). v2 makes these changes:
1. **Names from a real factory (F-1).** A session that works on one track is a **worker**. The kind of factory is a **recipe**. node, owner and project stay. New factory words where they are clearer: `factory check` (the merge check), `factory release check`, **request** (an item that waits for the owner), **assignment** (a written task or a decision that goes down), **session reset** (a clear or compact between phases), **queue** (the merge order). v3 changed some of these names to plain words (D-59). §7 maps the old names. See §4.1 and §7.
2. **The team's board tool holds the board (F-2).** factory gets one board connector: GitHub (the default), Jira or Linear. A `local` connector keeps the items in files, for a node with no network or no board account, and it is the test double of the connector. factory has no review desk of its own, not even as an option (F-17). Change of 2026-11-08 (TB-5 to TB-7 in §9): the review page of today stays a supported owner view that the owner can choose. A decision is a labelled item on the board, and a script reads the answer. The decision store is private by default. See §4.10.
3. **The coordinator runs in its own folder (F-3, D-60).** The coordinator folder is inside the factory folder. The factory folder has no instruction file at its top, so a worker never loads the coordinator text. `factory start` starts the coordinator. See §4.3.
4. **Same mechanics, one role per layer (F-4).** Layers count from the bottom: workers are layer 0. factory sets the role of a node from its layer. All children of a node are on one layer. See §5.
5. **macOS and Linux only (F-5).** See §4.7.
6. **Each approval point is an owner choice (F-6, F-15).** This workspace uses D-52. Releases are an approval point too, and D-57 is answered. See §6.
7. **One command stops a session (F-7).** A test of the ways to stop a session comes first. Then `factory shutdown`, `restart` and `dismiss` use the safe way. See §4.11.
8. **Workers live in the worker window (F-8).** The view window has the coordinator and one slot. See §4.11.
9. **The last-seen hook replaces every read under `~/.claude` (F-9).** The instruction to avoid those reads goes away. See §4.6.
10. **One general core; the recipe sets the kind of factory (F-10).** factory provides the `software` recipe first, with two setups: plain Claude Code (the default) and devflow. The config schema gets a `recipe` block. See §4.4 and §4.9.

Other changes: D-49 put the code in the private repo `dean0x/factory`. D-51 A: no second review of FAC-M1; the review of the v2 code covers the setup and upgrade code.

After v2, F-13 (2026-11-02): **one machine only for now.** The `ssh://` transport, the remote readiness check and the remote child are out. The transport interface stays, with `file://` only, and the config refuses any other address. A remote transport can come later with no redesign. See §5.3.

## Changes after the intent check (2026-11-02)

An independent check compared this design with every note from Dean. `docs/intent-trace.md` lists each note with its design section and its milestone. The check found gaps. The Orchestrator decided the open points (§9, table IF). The design now changes as follows:
1. A command finds the factory folder, and a per-user list outside `~/.claude` registers it (§4.2, §4.3).
2. `init` in a folder that holds several repos proposes a factory folder next to them. A project URL clones into the factory folder (§4.3).
3. The user picks the board at `init` and changes it with `factory tracker set`. A project can override the board of the node (§4.4, §4.10).
4. The proofs of D-52 are listed (§6.1). Releases are an approval point like the merge (§6, §6.2).
5. Each layer has its own role template. Layer 3 gets its own template in FAC-M8 (§4.9, §5.2).
6. The main session is a Claude Code session. A node names its agent command in the config (§4.6).
7. The coordinator reads comments, label changes, assignee changes and open or close changes from the board. `factory start` starts `factory watch` (§4.10, §4.11).
8. The communication module has its own section. It is the only code that types into a pane (§4.12, §5.3).
9. A parity table maps each part of today's setup to a command, a milestone or "retired". The adopt moves the coordinator text out of the folder above the work copies (§8).
10. The state repo can push to a private remote, for a second machine of the same owner (§4.3).
11. Dean's shop-floor words have a table, and each new name has a plain description (§7.1, `docs/glossary.md`).
12. The release has its own milestone, with a protected-environment check (§4.7).

## Changes after the adoption map (2026-11-07)

A research report mapped each part of this workspace's way of work to factory: the factory adoption map. Dean accepted it (D-121 A). He also gave a direction: factory is clay. A person gets the software and changes it to fit the way they work, and still gets the updates of the package. The design now changes as follows:
1. **Owner fields on the board (G-1).** The setup names its own item fields, such as a priority and a type, and the connector contract carries them (§4.10). FAC-M5.
2. **Standing delegations as records (G-4).** A decision of the owner can have a scope and no end time. `worker relay` accepts it for each action inside its scope (§6). FAC-M5.
3. **Owner hooks (G-2).** The setup can run its own script after an event (§4.13, §4.14). FAC-M6.
4. **Neutral core templates (G-9).** The role texts of the package hold no rule of one owner's way of work. The coordinator keeps "Coordinate. Do not produce." as its default (§4.13). FAC-M6.
5. **The clay rule.** An upgrade changes only the factory layer and never overwrites the owner layer. On a conflict, factory shows it and the owner decides. The fixed rules stay outside this rule (§4.5, §4.13). FAC-M6.
6. **The decision profile stays a factory feature.** factory gives the store, the record tools and the use of the profile in decisions. The principles and the records are the owner's (§4.13).
7. **`adopt` moves a split owner text (§8).** The owner splits the old `CLAUDE.md` first, and `adopt` moves only the owner text. FAC-M7.

## Summary for Dean (one page)

**What factory is.** `factory` is a program that you run in a terminal window. It creates and runs the orchestration setup of this workspace on any machine, for any person. `factory init` makes a factory folder: the config, the coordinator text, the role texts and your decision notes. `factory start` starts the screen layout and the coordinator session. Other commands do the multi-step jobs that the Orchestrator does by hand today. The program never contains a name, an account or a path. It reads them from the person who runs `init`.

**One core, many kinds of factory.** The core knows nodes, layers, roles, sessions, the assignments that go down, the reports that go up, the decisions of the owner, the board, capacity, the saved state and approval points. A **recipe** gives the rest: the role text of each layer, the work cycle, the approval points, the kind of output and the board mapping. A recipe for a marketing factory can be the work cycle "write a post, check it, publish it", with one approval point before the post goes out. The first recipe is `software`. Other recipes, for example research or content, come later.

Software recipe: projects are git repos, the output is a pull request, and the approval points are the merge and the release. It has two setups: plain Claude Code (the default) and devflow.

**Plain words (D-59).** A session that works on one track is a **worker**. A worker does all the steps, from the plan to the finished work, for one track of one project. Items that wait for the owner are **requests**. A written task is an **assignment**. The order of the finished work that waits for an approval point is the **queue**. `docs/glossary.md` has the table of plain words.

**The team's board, not our own desk.** The work items, the requests and the decisions live in GitHub, Jira or Linear. Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Jira and Linear are a separate question. Not checked yet: FAC-M9. The owner can answer a decision with a comment such as `/choose B`. A script reads the comment, so the read costs no model use. The comment wakes the coordinator and shows the answer, and it records nothing. The owner enters the decision with `factory decide`. The place that holds the decisions is private by default.

**Where things run.** One factory is one folder, and the folder is a shared repo, the config repo. The coordinator runs in `coordinator/` inside it. Workers run in work copies of the projects, under `work-copies/`. So a worker never loads the coordinator text. The config travels as a shared repo: clone the config repo on another machine and run `factory init`. Personal values and credentials stay in a local file that the share list leaves out.

**Layers.** Every node has the same mechanics: the config, the report that goes up, the assignments that come down, and the program. Each layer has its own role. Layer 0 is the workers. Layer 1 is the coordinator. Layer 2 manages coordinators. Each layer above 2 gets its own role when it becomes real. A new top layer changes no node below it.

**Scripts save model use.** The largest costs today are the check of finished work (25–60k tokens of model use each time), the status round (40–80k), a restart of all workers (60–100k) and worker creation (20–30k). Each becomes one command with a short verdict as output, about 1–4k tokens. A rough total: 50–70% less coordinator cost on routine work.

**Safety is in the code, not only in the text.** factory starts a session only in auto mode, so Claude Code keeps its own permission checks. The program has no flag that skips permission checks. A proxy (a server that passes the model calls on) is an explicit config option, and factory checks that it answers before each start. factory types owner-authority input only for a decision that the owner recorded. A decision answer counts only when it is a `factory decide` record. A board comment or label only wakes the coordinator and shows the answer. Each approval point waits for the owner, unless the owner delegated it. A delegation needs an approval record that the owner writes in a terminal window outside a factory session (§6 says what this does not prove).

Software recipe: with `release: owner`, the owner approves each release. With `release: delegated`, the proof of §6.2 is necessary.

Engineering note: the program is written in TypeScript on Node 22+, the npm package is `@dean0x/factory`, and the licence is MIT. The private state folder is `.factory/` and the config is `factory.yaml`. Claude Code writes a "last seen" note for each session through a hook. The screen layout is a tmux session.

**Decided** (details in §9). v1: the language, the names and the licence (see the engineering note above), the state folder and the config file, and the "last seen" note. v2: the ten changes above. v3: the changes at the top, and the decisions of the table v3 in §9.

---

## 1. Inventory of the current setup

This section describes the workspace setup as it is today. It uses the names of the files of this workspace (the Orchestrator, On Dean and the `lane` files), because those are the names in the files.

Paths are relative to `~/work/<workspace>/.devflow/` unless they start with `~/` or `/`. The example path `~/work/<workspace>` stands for the folder of the workspace.
Classes: **G** generic, **D** devflow-specific, **P** person-specific (names, accounts, paths), **M** machine-specific.

### 1.1 Parts

| Part | Job | Class | What ties it (file:line) |
|---|---|---|---|
| `~/work/<workspace>/CLAUDE.md` | Orchestrator rules §1–§13 | G, D, P, M | "Dean", `dean0x` §13; founder prefix §12; `~/work/<workspace>/.devflow` (`--add-dir`); session names `orchestrator:lanes`, `orchestrator:bench`; "10 CPUs, 64 GB", `lockf`, `pbcopy`, `sysctl`, `memory_pressure`; `/devflow:*` in §5 and §7 |
| `docs/orchestration/protocol.md` | Worker protocol: escalation, test lock, disk, context, PRs, style | G, D, P, M | `~/work/<workspace>/.devflow/...` (L19–34); Node 24 and `/opt/homebrew/bin` (L34, devflow tests only); `vitest` (L25); devflow timeout rule (L54) |
| `docs/orchestration/status.md` | Status layout | G, P | "Waiting on Dean" (L42) |
| `docs/orchestration/respawn-map.md` | Worker, pane, folder and session-id table, plus the restart steps | G (steps), P, M (data) | pane ids, UUIDs, `--add-dir` path (L14), reads `~/.claude/sessions` (L16) |
| `docs/orchestration/orchestrator-resume.md` | The Orchestrator's resume block | instance data | devflow PR numbers |
| `roadmaps/README.md` and track roadmaps | Track arcs and their template | G (README); instance data | paths on line 2 of each track file |
| `board.json` → `board.md`, page | Board source of truth | G (schema), P (links) | `dean0x` issue links via boardlib |
| `lanes.json` | Hand-written worker facts | G | none |
| `on-dean.json`, `decision-log.json` → `on-dean.md` | Items that wait on the founder, and his decisions | G (schema), P (names) | file names, "# On Dean", artifact URL in the intro |
| `board-detail.md`, `board-log-<yyyy-mm>.md`, `done.md` | Item detail, log, append-only removals | G | none |
| `briefs/brief-<track>-<date>.md` | Assignments for workers | G (shape) | paths and repos inside |
| `review/dean-review.html` | Review page: board, items, decision forms, docs drawer | G (template), P | "Dean" (L8); `dean0x` URLs in the data block |
| `review/README-decision-pages.md` | How the page and its database work | G, P | live artifact URL (L3) |
| `scripts/boardlib.py`, `render-board.py` | Board schema check, sort, release groups, render | G, P | `github.com/dean0x/{repo}` (boardlib L241), default repo `devflow` (L240), env `DEAN_DIR` |
| `scripts/render-dean.py` | On Dean file, page data block, `files.json` | G, P | `PR_URL = .../dean0x/devflow/pull/{}` (L69), "# On Dean" (L237) |
| `scripts/board-set.sh` | Only writer of `board.json`; locked; fails closed | G, P, M | `BOARD_REPO:-dean0x/devflow` (L91); `/usr/bin/lockf` (L35) |
| `scripts/lane-set.sh`, `lane-lib.sh` | Only writer of `lanes.json`; tmux helpers | G, M | `lockf`; session name `orchestrator` (`lane-lib` L3) |
| `scripts/state-commit.sh`, `git-hooks/pre-commit` | Commit helper; ID delete guard; `done.md` append-only | G | needs `core.hooksPath=scripts/git-hooks` |
| `scripts/layout.sh`, `lane-summon.sh`, `md-view.sh` | View and worker windows, pinned summon, glow viewer | G, M | session `orchestrator`; `/bin/zsh`; `glow` |
| `scripts/lanes-refresh.sh`, `lanes-table.py`, `live_boxes.py` | Live worker table every 30 s; machine box | G, M | reads `~/.claude/projects/*.jsonl` (`lanes-table` L64); status-line regex `Context\s+\S+\s+(\d{1,3})%` (L82); `memory_pressure`, `pmset` (live_boxes L105–106); `pyenv` |
| `scripts/tmux-save-map.sh`, `tmux-restore-lanes.sh` | tmux-resurrect hooks: save the pane map, resume workers | G, M | reads `~/.claude/sessions/*.json` (save-map L14); restore forces `--permission-mode auto` and `env -u ANTHROPIC_BASE_URL` (restore L20, L58) |
| `scripts/tmux.conf` | Mouse, worker names on borders, resurrect, continuum | P, M | absolute paths in the user folder (L2, L3, L25, L26, L32) |
| `scripts/test-*` | Tests with fixtures and a separate tmux server | G | none |
| `priorities/apply-labels.sh` | One-time label script | P | `R=dean0x/devflow`; fixed issue list |
| `decision-profile/` | Founder decision wiki: index, format, log, principles, records | G (format), P (content) | "Dean" throughout; some principles scoped `devflow` |
| `state/`, `locks/` | Locks, caches, logs (names only read) | M, gitignored | none |
| Global rules in `~/.claude/rules/devflow/` | Engineering, quality, STE writing style | D | installed by devflow, not by the setup |

### 1.2 Dependencies on tools

Required: `tmux` (with TPM, resurrect, continuum), `git`, `gh`, `jq`, `python3` (stdlib only), Bash 3.2+, `glow`, Claude Code.
macOS only: `/usr/bin/lockf`, `memory_pressure`, `pmset`, `pbcopy`, `sysctl`.
Private Claude Code layout: `~/.claude/projects/<cwd>/*.jsonl` (worker activity), `~/.claude/sessions/<pid>.json` (session ids), and the text of Dean's status line (context percent).

### 1.3 Conflicts to fix before packaging

I checked each of these on the file. factory takes one answer for each.
1. **Merge authority.** D-46 B (2026-11-01) said that every merge waits for the owner's go. D-52 (2026-11-02) replaced it for this workspace: approved and assigned work merges when the gates pass. factory makes the rule an owner choice (F-6, §6).
2. **How to stop a session.** `respawn-map.md` said "press Ctrl+C twice". CLAUDE.md §12 says that Ctrl+C quits only the client, and uses `kill -TERM`. factory tests the ways first (F-7, §4.11).
3. **Where workers live.** The respawn map put workers in the view window. CLAUDE.md §12 puts them in the tmux window `bench`. factory uses the worker window `workers` (F-8, §4.11). The respawn map line is fixed.
4. **Context budget.** `protocol.md` used 250k/350k tokens. CLAUDE.md §12 uses 30–35% and 40% of the window. factory uses the percent rule, because it works for every window size.
5. **Reads under `~/.claude`.** CLAUDE.md §1 told workers to avoid them, but three scripts read there. factory replaces every read with the last-seen hook (F-9, §4.6).
6. **The coordinator instructions reach every worker.** Claude Code loads every CLAUDE.md from the session folder up to the top of the file system. The Orchestrator instructions are in `~/work/<workspace>/CLAUDE.md`, and every worker folder is under `~/work/<workspace>`. So each worker also loads them. factory keeps the coordinator text in the coordinator folder, and the top of the factory folder holds no instruction file (F-3, D-60, §4.3).

## 2. The devflow connection

### 2.1 Ties

devflow (npm `devflow-kit`, MIT) installs commands, agents, skills, hooks and rules into `~/.claude`, and uses `.devflow/` in each project and `~/.devflow/` in HOME. In factory, devflow is one setup of the `software` recipe (§4.9). The core knows nothing of devflow.

| Tie | Where | Default in factory |
|---|---|---|
| Cycle plan → implement → code-review → resolve | CLAUDE.md §5.2; protocol L47 | Stage ids `plan`, `build`, `review`, `fix`. The plain setup uses plain Claude Code: plan mode, edits, a review subagent, fixes. |
| "code-review is for software; else a multi-lens audit" | CLAUDE.md §5.2 | Keep the rule. Each stage declares `applies_to: code | prose | any`. |
| Review and resolution summaries posted on the PR | CLAUDE.md §5.3, §5.4 | An evidence contract: one PR comment per stage, found by a marker. The plain markers are `<!-- factory:review -->` and `<!-- factory:fix -->`. |
| One evidence comment per head | CLAUDE.md §5.2 | Optional. The plain setup needs CI plus the review comment. |
| `/devflow:release` | CLAUDE.md §7 | A `release` stage. The plain setup uses the repo's own release script, named in `factory.yaml`. |
| Triage words (FIX_NOW, ESCALATED, CHANGES REQUESTED) | board-detail.md | Neutral words `blocker`, `fix`, `defer`, `ask`, `ready`. A setup maps its words to them. |
| Agent types Code, Validate, Test | protocol L32 | Agent kinds: implementer, verifier, tester, reviewer. A setup maps them to its agent types. ("Role" now means the role of a layer, §5.) |
| State folder named `.devflow` | CLAUDE.md §11–§12; respawn-map | `.factory/`. Proof of the clash: devflow already wrote `~/work/<workspace>/.devflow/.devflow/{curation,docs,features,memory}`. |
| `--add-dir ~/work/<workspace>/.devflow` | CLAUDE.md §12; restore L20 | `--add-dir <node home>/.factory`, from the config. |
| Worker name examples `devflow-*` | CLAUDE.md §4 | Keep the `<project>-<track>` form for workers; use neutral examples. |
| Default repo `dean0x/devflow` | board-set L91; boardlib L13, L240; render-dean L69 | `recipe.projects[].repo` in `factory.yaml`. A bare issue number is refused when the node has more than one project. |
| Rules in `~/.claude/rules/devflow/` (STE, read economy, quality) | HOME CLAUDE.md | factory writes its own short rules into the role templates. It never writes to `~/.claude/rules/`. |
| Profile seeded from devflow `preference-profile.md` | decision-profile/README-format.md:64 | factory comes with an empty profile and its format. A setup may give a seed command. |
| devflow memory and curation hooks | protocol L19 | Resume files plus Claude Code auto-memory. No ledger by default. |
| devflow-repo rules inside the generic protocol | protocol L34 (Node 24), L54 (timeouts), L62 (standalone) | Move them to the worker addendum of the devflow setup or the devflow repo's CLAUDE.md. |
| Repo checks in the gate routine (Independent audit, ceiling diff) | orchestrator-resume.md:14 | A per-project `gate.checks` list in `factory.yaml`. |

The gate-level words `full`, `standard` and `lean` are not in the setup itself. They appear only in devflow product work, so there is no tie to replace.

### 2.2 devflow as a setup of the recipe

The devflow setup is data plus prompt text in the `software` recipe (§4.9). It has no code that factory runs, except its `install` and `detect` commands, and the user must confirm those.

```yaml
# recipes/software/variants/devflow.yaml
variant: devflow
version: 1
install: npx devflow-kit init --recommended   # shown to the user; runs only after a yes
detect: devflow --version
stages:
  plan:    { run: /devflow:plan,        applies_to: any }
  build:   { run: /devflow:implement,   applies_to: any }
  review:  { run: /devflow:code-review, applies_to: code }
  fix:     { run: /devflow:resolve,     applies_to: code }
  release: { run: /devflow:release }
evidence:                 # how `factory check` finds proof of each stage
  review:  "<!-- devflow:review-summary"
  fix:     "<!-- devflow:resolution-summary"
  release: "<!-- devflow:shipped"
verdicts: { FIX_NOW: fix, ESCALATED: ask, "CHANGES REQUESTED": blocker, READY: ready }
agents: { implementer: Code, verifier: Validate, tester: Test, reviewer: Review }
state_dirs: [".devflow/", "~/.devflow/"]   # factory refuses to use these and never deletes them
worker_addendum: addendum.md               # extra worker rules for repos that use devflow
profile_seed: /devflow:dynamic-profile
proxy_presets:                             # optional; copied into `proxies` on request (§4.6)
  subswitch: { base_url: "http://127.0.0.1:4141", health: /__subswitch/health }   # port 4141 is the default of `subswitch serve`
```

`factory recipe variant devflow --project P` checks `detect`, offers `install`, and writes the setup into the project entry in `factory.yaml`. The setup is per project, so one node can mix projects with and without devflow.

The triage words `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED` are devflow ties (§2.1). They appear only in this setup file. The deny list of the tests finds them in any other template or generated file.

The dependency goes one way: factory knows devflow's public surface (commands, markers, paths). devflow never knows factory. This keeps the founder rule "devflow stays standalone" (CLAUDE.md §8; `decision-profile/principles/devflow-standalone.md`).

## 3. Scripts that save tokens

Costs are rough, per use, for the new tokens that enter the coordinator context. They come from the step counts in CLAUDE.md and the inventory. "After" assumes one call with a short verdict as output.

| Job today | Steps today | Today | Command | After |
|---|---|---|---|---|
| Merge check and merge (§5) | CI on the head SHA, behind-by, open threads (GraphQL), review and fix evidence, impact inventory over the diff, public-text check, pinned merge, board, commit, close issue | 12–18 calls, 25–60k | `factory check <pr>` then `factory pr merge <pr>` | 2 calls, 3–6k (the impact inventory stays a judgment; `check` prints the diff stat and the touched surfaces only) |
| Status round (§2, §3) | ListAgents, panes, worktrees, PRs and milestones per repo, board, roadmaps, message each worker, capture idle panes | 20–30 calls, 40–80k | `factory status` | 1–2 calls, 3–5k (worker replies still cost their own tokens) |
| Restart of all workers (§12) | Per worker: capture, push check, CronList, stop, respawn, rename, new assignment | ~50 calls, 60–100k | `factory reboot` | 2 calls, 3–5k |
| Worker creation (§12) | Resource check, worktree, pane, launch, wait, rename, protocol line, assignment, board, workers table, respawn map, commit | 15–20 calls, 20–30k | `factory worker new <name> --project <p> --assignment <file>` | 1 call, 1–2k |
| Board and owner-item updates (§11) | Edit JSON, render, commit, republish, label sync | 5–8 calls, 8–15k | `factory item …`, `factory request …`, `factory track …` (board writes, labels built in; the board gets each write first) | 1–2 calls, 1–3k; no render step, because the board tool shows the board |
| Reading the owner's answers (§8) | Read the page database, record each decision, relay it | 3–6 calls, 5–10k | `factory decide read` (a script reads the answers on the board, from any account, and shows them; `--from FILE` reads the data file of the review page; it records nothing, and the owner enters each answer with `factory decide`) | 1 call, <1k |
| Worker clear or compact, then a new assignment (§12) | Capture, idle and pushed checks, resume file check, C-u, type, verify | 8–10 calls, 10–15k | `factory worker reset <worker>` with `--clear` or `--compact` | 1 call, 1k |
| Release pre-check and post-check (§7) | Version, changelog, package contents, registry; after: registry, clean install, smoke | 6–10 calls, 10–20k | `factory release check <project>` / `factory release verify <project> <version>` | 1 call each, 2–3k |
| Issue audit and labels (§8) | List issues, classify, apply labels | 5–10 calls, 30–100k | `factory issues audit` (finds unlabeled or conflicting issues; the model classifies only those) | 1 call plus the classification of new issues only |
| Decision record and profile update (§1) | Record file, log line, principle, decision-log row, commit | 4–6 calls, 8–15k | `factory decide <D-n> <option>` records it; `--principle <id>` links a principle | 1 call, 1–2k (the principle wording stays a model job) |
| Work copy cleanup (§4) | List, check tip on remote, search board and resume files, remove | 5–8 calls, 5–10k | `factory copies clean` (dry run by default) | 1 call, 1k |
| Typed founder-authority input (§12) | Map, capture, Escape/C-u, type, Enter, verify | 4–6 calls, 4–6k | `factory worker relay <worker> --decision <D-n>` (FAC-M5) | 1 call, <1k |
| CI watch (§10) | Monitor or loop on `gh pr checks`, then read | 2–4 calls, 3–8k | `factory pr watch <pr>` (exits when CI ends; for a background task) | 1 call, <1k |
| Stopped-worker watch and limit recovery (§11, §12) | Loop on `lanes-stopped.txt`; capture each worker; answer the dialog; nudge | 5–15k | `factory worker watch` (exits on a change, or after 20 minutes); `factory worker recover` (FAC-M5) | <1k plus |
| Moving an outside session into tmux (§12) | ListAgents, session file, stop, resume, rename, protocol line | ~6 calls, ~6k | `factory worker adopt <name>` | 1 call, <1k |
| Resource check (§8) | 4 commands | 1–4 calls, 1–2k | built into `worker new`; `factory machine` | 0–1 call |
| Orchestrator self-compact (§12) | Resume file, C-u, queue `/compact` | ~3 calls, 3–5k | `factory self reset` (checks the resume file, then queues `/compact`) | 1 call |

Rule for every command: the output is a short verdict for the model (`READY`, or `NOT READY: 2 open threads, CI pending`). `--json` gives the full facts. The default output never prints a diff, a log or a transcript.

The board tool removes most of the render scripts of today (`render-board.py`, `render-dean.py`, the page data block). Its UI shows the board and the requests. The `artifact` connector is the one exception: factory renders the review page by script, and the page text never goes into model tokens (§4.10, FAC-M11).

## 4. CLI shape

### 4.1 Concepts

- **Node**: one session with a layer and an owner. It has an optional parent and children. A node on layer 1 or above has a factory folder. A worker (layer 0) has none: its state lives in the factory folder of its parent. The coordinator is a node on layer 1. The word *node* stays because it fits a session on any layer.
- **Factory folder**: the folder of a node on layer 1 or above. It is a repo of its own, the config repo, so a person can share it. It holds the config, the setup text, the clones of the projects and the work copies (§4.3). In code and flags it is `home` or `root` (`--home`, `FACTORY_HOME`).
- **Layer**: the level of a node, counted from the bottom. Layer 0 is the workers. The layer sets the role (§5).
- **Role**: the instructions, the commands and the reports of one layer. A role text from the recipe gives them.
- **Owner**: the person whose decisions the node carries. Each team member is the owner of their own nodes.
- **Worker**: a session (layer 0) in one work copy. It does all the steps of the work cycle for one track of one project.
- **Work copy**: a separate copy of a project folder for one worker. It is under `work-copies/` in the factory folder, and the share list leaves that folder out. A command that runs in a work copy still finds its factory (§4.3).
- **Project**: a unit of work that the node manages, with its own settings and setup.
- **Recipe**: the kind of factory: role texts, work cycle, approval points, output kind and board mapping (§4.9).
- **Board**: the system that holds the work items, the requests and the decisions (§4.10). The config key is `tracker`.
- **Track**: a named stream of work with its own roadmap. A worker is not a track. A track groups work items, and the board shows one line for each track (§4.10).
- **Stage**: where a work item is on the board. It is not a step of the work cycle, and it is never an approval. The recipe gives the list of stages (§4.10).
- **Approval point**: a step of the work that needs an approval. The recipe lists the points. The owner sets the mode of each point: `owner` or `delegated` (§6).

Software recipe: a project is a git repo. A work copy is a git work tree of that repo. The output of a project is a pull request. The approval points are the merge and the release.

Factory words, used where they are clearer than the generic word:
- **request**: an item that waits for the owner (a decision or an action);
- **assignment**: a written task, or a decision record, that goes down to a worker or a child node;
- **session reset**: a wipe or a shortening of the memory of a worker session between two phases;
- **queue**: the order of the finished work that waits for an approval point;
- **check**: a check of one piece of finished work. It says `READY` or `NOT READY`, with the reasons.

Software recipe: `factory check <pr>` checks a pull request before a merge. The release check is the check before a release, and the check after it.

`docs/glossary.md` teaches these words, with one plain sentence for each of them, and `factory help words` prints them. The same file holds the plain-words table (D-11): for each jargon term, the plain word that user text uses. The glossary shows an old word only as a "was" note. The glossary test compares the program text with `docs/glossary.md`. A test fails when a name has no entry or the entry has more than 25 words. §7.1 shows which of Dean's shop-floor words factory uses.

A factory with one project is a node with one project. A factory with many projects is a node with many. There is one code path for both.

### 4.2 Commands

**Core commands** (the same for every recipe; they speak of approval points and work items only)

```
factory init [--home DIR] [--name N] [--project PATH|URL]... [--recipe NAME] [--layer N]
             [--tracker ID] [--items X] [--decisions X] [--approval POINT=owner|delegated]... [--state-from SRC] [--yes]
                                            # makes a factory, or registers a received one; run it again in the factory folder to change an approval mode (§6)
factory start [--home DIR] [--dry-run] [--yes]  # start the factory, or open it when it runs: the screen session, its windows and the coordinator (§4.11); after a machine restart it resumes each recorded worker; works from a project folder (§4.3)
factory shutdown                            # stop every session of this factory, and nothing else (§4.11)
factory restart <worker>                    # restart one worker, and keep its conversation (§4.11)
factory reboot                              # shut down the whole factory and start it again; each recorded worker resumes (§4.11)
factory status [--home DIR] [--json]        # each worker with its state, its work item and its unused state; the digest for the owner (§4.11); the code names the unused column `IDLE` until FAC-M5b
factory status --usage [--home DIR] [--json]   # the usage view: the token use, the limits and the work counts of the factory, from the token meter package (§4.11, FAC-M5b)
factory dismiss <worker> [--yes] | --unused # end a worker and free its work copy when its work is pushed; a dry run until --yes; --unused lists the unused workers first, and the owner picks (§4.11); FAC-M5b names the flag `--unused`, and the code has `--idle` until then
factory doctor [--fix]                      # check the tools, their versions, the platform, the safety settings, the last-seen notes and the board; FAC-M11 adds the check of each board CLI: present, configured, authorized (§4.15)
factory upgrade [--dry-run]                 # update the saved state and the parts of the text files that factory writes (§4.5)
factory machine                             # the use of the processors, the memory and the disk against the limits
factory help words                          # the plain description of each factory word (docs/glossary.md)

factory project add|remove|list
factory recipe show                         # the project table of the coordinator, from the config
factory tracker set <id> [--project P] [--items X] [--decisions X]   # change the board of the node, or of one project (§4.10)
factory tracker status                      # the board of each project, and the check of its decision store
factory plugin test <package>               # run the contract suite of the board against a board plugin (§4.15, FAC-M11)
factory track add|list|update ...           # the tracks of the roadmap, kept on the board (§4.11, FAC-M5)
factory state remote <url|path> | push | pull   # set the private backup place of the saved state, and copy the state to it or from it (§4.3, FAC-M3)
factory state guard                         # the delete-guard hooks of the state folder call it before a commit; not for people (§6, FAC-M5)

factory worker new <id> --project P [--yes] [--copy PATH] [--assignment FILE]
factory worker list [--json] [--follow]     # the live workers table: pane, state, context percent and PREPARE or MAX mark (§4.6); --follow keeps the table live, with the columns of the live board (§4.11, FAC-M5b)
factory worker mark <worker> parked|on-hold|none   # set the hold word of a worker, Parked or On hold, or clear it (§4.11, FAC-M5b)
factory worker relay <worker> --decision D-n   # type owner input from a decision that the owner recorded (FAC-M5)
factory worker reset <worker> (--clear | --compact)   # the session reset: type /clear or /compact in the pane of the worker, and check that it happened (§4.6, §4.12)
factory worker stop <worker>                # end the program of the pane with TERM, and close the pane (§4.6, §4.11)
factory worker resume <worker>              # start a stopped worker again, with its own earlier conversation (§4.6)
factory worker summon <worker> [--for 15m]  # show the pane of the worker in the slot of the window view; the board comes back after the time (§4.6, §4.11)
factory worker watch [<worker>...] | recover | adopt <name>   # watch: exits at the first change of a worker, or after 20 minutes (§4.6); recover: FAC-M5; adopt: FAC-M7
factory layout                              # make the window workers if it is missing, tile it, and put the board back in the slot (§4.6, §4.11)

factory item add|update|move|close|list|note|doc|import ...   # work items: the board; list shows one line for each track, --track shows one track, --follow draws the list again at each change; note adds a note to an item, doc attaches a file to an item (§4.10); import: FAC-M3
factory request add|list|update|close ...   # items that wait for the owner; add --options FILE asks a decision, as a decision item in the decision store; close ends one with no answer (§4.10)
factory decide read [<D-n>] [--from FILE]   # read the answers on the board with no model use, and show them; --from reads the data file of the page (FAC-M11); it records nothing (§4.10)
factory decide <D-n> <option> [--note T] [--principle ID]   # the owner enters the decision in a terminal window, with every board kind; the decision log and the profile get it (§4.10)
factory queue set|show                      # the order of the finished work that waits for an approval point; set finds a row by its exact name (§4.10)
factory watch                               # read the new board changes, the local change feed included, a limited number of times; wake the coordinator (§4.10)
factory item estimate <id>                  # the token range of one work item, from closed items with measured tokens; NO BASIS when there are too few (§4.11, FAC-M5b)

factory node tree | children | add-child | remove-child
factory report [--json] [--since CURSOR]    # digest for the parent (§5)
factory self reset                          # the session reset of the coordinator itself
factory adopt <path> [--dry-run]            # bring the setup of today into a node (§8)
factory hook <event> | statusline           # Claude Code calls it; not for people (§4.6)
```

Engineering note: `start` attaches to the tmux session when it runs, and `restart` resumes the worker with its session id. `doctor` checks the hooks that write the last-seen notes. `upgrade` migrates the state and the managed blocks. `machine` reads CPU, memory, disk and load. `state remote` sets the private git remote of the state folder. `state guard` is run by git, from the delete-guard hooks of the state folder, and never by a person (§6). `worker reset` and `self reset` type one constant line into a pane through `src/comms/` (§4.12). `decide read` reads the answers on the board by script, and records nothing. `decide <D-n>` records the decision of the owner, with every board kind. `watch` makes bounded reads, and it reads the local change feed too. `request add --options FILE` asks a decision. `plugin test` runs the contract suite of the board against a board plugin (§4.15). `track` keeps the tracks on the board, and `worker mark` sets the hold word of a worker (§4.11). `--json` prints JSON, `--dry-run` changes nothing, and `--state-from` takes the work state from another machine (§4.3).

**Software recipe commands** (the commands that the `software` recipe adds)

```
factory init --variant plain|devflow        # the setup of a project (the key `variant` stays until FAC-M6, §2.2); all other `init` forms are in the core table
factory recipe variant <plain|devflow> [--project P]   # change the setup of one project (§2.2)
factory check <pr> [--project P]            # the merge check: READY or NOT READY at the current head
factory pr merge <pr>                       # pinned merge, then the bookkeeping
factory pr watch <pr>
factory issues audit [--project P]
factory release check|verify <project> [<version>]   # the release check before a release, and the check after it
factory release scope <project> <version>   # the owner writes the release scope; a terminal window outside a factory session only (§6.2)
factory copies list | status | sync <pr|branch> | clean [--apply]   # git across work copies (D-55)
factory lock run -- <command>               # the shared heavy-test lock
```

Another recipe adds its own check and output commands. The core commands stay the same for every recipe, and a docs check fails when a core part of the design or of the glossary holds a word of the software recipe. §7.1 maps Dean's shop-floor words to the command words `worker`, `request` and `queue`.

The lifecycle verbs of the core table:
- `start` starts the factory. After a machine restart it resumes the recorded workers.
- `shutdown` stops every session of this factory, and nothing else.
- `restart <worker>` restarts one worker with its session id.
- `reboot` shuts down the whole factory and starts it again. Each recorded worker resumes.
- `status` lists each worker with its state, its work item and its unused state.
- `dismiss <worker>` and `dismiss --unused` end a worker and free its work copy. `--unused` lists the unused workers first, and the owner picks.

§4.11 defines "unused", "pushed" and "free", the stop scope, the recovery after a machine restart and the worker states of the live board. The names `--unused`, `UNUSED`, `limits.unused_after` and the words of the live board are the target of FAC-M5b. Until then the code has `--idle`, `IDLE`, `limits.idle_after` and the old state words.

Global flags: `--home PATH`, `--json`, `--quiet`, `--no-color`. In `--json` output, only control, bidi and invisible characters are removed from string values. A line break stays as an escape, and no string is cut to a width. A command finds the factory folder in this order: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml`; else the factory list, which matches the current folder to a project path, or to the git folder of a project (§4.3).
Output rule: the default output of a job command (a command that replaces a manual job of §3) has at most 20 lines, and the verdict is on the first line. `docs/token-budget.md` gives the size budget of each job.
Exit codes: `0` success, `1` failure, `2` usage error, `3` "not ready" (a check verdict), `4` safety refusal. A check verdict is not an error, so scripts can tell them apart.

### 4.3 Factory folder layout

> **Receiving a factory.** You get the config repo of a factory from another person, or from another machine of yours.
> You need the `factory` program first. Until FAC-M10, a developer with read access installs it from a private early-access tag (D-49). See `docs/quick-start.md`.
> 1. Clone the config repo into a new folder: `git clone <url> <folder>`.
> 2. In a terminal window, run `factory init` in that folder. `init` clones each project and registers the factory on this machine.
> 3. Answer the prompts of `init`, in this order:
>    - your personal values: the account (the owner fields);
>    - the mode of each approval point, with `owner` as the default;
>    - the setup acceptance: a yes or a no for the setup text (`setup/coordinator.md` and `setup/roles/worker.md`) and for every other file that the config repo tracks. `init` shows each file with its text;
>    - a yes or a no for the write of the hook in `coordinator/.claude/settings.local.json`, when `init` writes it (§4.6).
> 4. Run `factory start`.
>
> With no terminal window, or with `--yes`, `init` stops on a received factory that tracks setup text or other files. So a script can not receive such a factory. `init --yes` accepts only setup text that `init` wrote itself (see "The setup text needs the owner").

The factory folder is a git repo of its own, the config repo. It holds the config of the factory and every file that a person needs to make the same factory on another machine (F-18, D-60). The clones of the projects, the coordinator folder and the work copies are inside it. It has no instruction file at its top.

```
~/work/acme/                        # the factory folder: a git repo, the config repo
  factory.yaml                      # shared config; tracked (§4.4)
  factory.local.yaml                # personal and one-machine config; ignored; mode 600
  .gitignore                        # the share list; tracked
  setup/
    coordinator.md                  # tracked: the coordinator text of the owner
    roles/worker.md                 # tracked: the worker role text of the owner
  coordinator/
    CLAUDE.md                       # generated on each machine; ignored; the coordinator runs here
  web/  api/                        # clones of the project repos; ignored
  work-copies/
    web/web-search/                 # a work copy for one worker; ignored
  .factory/                         # private state repo; ignored. Its git folder holds the delete-guard hooks, which git does not track (§6)
    node.json                       # the factory marker: schema_version, created_with, block versions
    roles/worker.md                 # the worker role text that every worker reads; rendered on each machine from the package and from setup/roles/worker.md
    decision-log.json               # the decisions that the owner recorded with `factory decide`, with the answer
    active-machine.json             # the machine that runs the session now: its id and the time; tracked, and written and committed by `factory start` (§4.11)
    board.json  waiting.json        # the items, the tracks, the queue and the open requests; the local files of the board (§4.10)
    decision-profile/               # format, index, principles, decisions
    roadmaps/  orders/  resume/
    workers/<id>/worker.json        # the record of each worker: project, work copy, branch, created time; no process id; ignored
    workers/<id>/last-session       # the id of the newest session of the worker, written by its hook (§4.6); ignored
    workers/<id>/inbox/             # the assignment folder of each worker: assignment files and resume notes; ignored (§4.12)
    inbox/  outbox/                 # messages from the parent, reports to the parent (§5)
    state/coordinator-last-session  # the id of the newest session of the coordinator, written by its hook (§4.6); ignored with state/
    state/machine-id                # the random id of this machine, made once; ignored with state/, so a copy of the folder does not carry it
    state/  locks/                  # ignored: last-seen files, board cache, pane map, locks; locks/state.lock covers every commit of the state repo (§6)
    .gitignore                      # ignores state/, locks/, backups/ and workers/
```

Why this layout: Claude Code loads every instruction file from the session folder up to the top of the file system. A worker runs in a work copy. The coordinator text is in `coordinator/`, and that folder is not above any work copy. The top of the factory folder holds no instruction file. So a worker loads the project instructions and the worker role text, and never the coordinator text. The coordinator reads the projects through `--add-dir`.

A person can run more than one factory on one machine, each in its own folder. A person can run one factory on more than one machine, from the same config repo. One machine is the active one at a time. In v3 nothing stops a second machine. FAC-M4 adds a warning, and FAC-M8 allows use from several machines at once.

The `.gitignore` is the share list. It ignores everything, and it allows `.gitignore`, `factory.yaml` and `setup/`. factory writes its part of the file between two marker lines. A person can add lines outside that part, and `upgrade` keeps them. The coordinator folder is not tracked (D-1): each machine renders `coordinator/CLAUDE.md` from the package and from `setup/coordinator.md`. In the same way, each machine renders `.factory/roles/worker.md` from the package and from `setup/roles/worker.md`. So the rendered text can hold the owner prefix and the modes of each machine. The two files in `setup/` are the text that a person changes and shares. The code PR builds both files, in the same step (roadmap, Point 2).

The coordinator writes in the coordinator folder, in the state folder and in the clones. It does not edit the config. The launch adds `--add-dir` for the state folder and for each project, and not for the top of the factory folder. A project path is one folder name. It never names the top of the factory folder, and it never names a reserved folder. The reserved names are `coordinator`, `work-copies`, `setup`, `factory.yaml`, `factory.local.yaml`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md`, in any letter case. A name with a leading dot is also not allowed.

`factory init`:
- Inside a project work tree, with no `--home`: it proposes a new factory folder next to the project folder (`../<repo>-factory`). It clones the repo into `<factory folder>/<repo>` from its origin, and it warns that the old folder keeps the work that is not pushed. With no origin, it clones from the local folder, keeps the local source in `sources` of the local file, and warns that the factory cannot be shared with this repo. It asks in a terminal window. With `--yes` it uses the proposal. With no terminal window and no `--yes`, it prints the proposal and exits 2.
- In a folder that is not a git work tree and holds git repos one level down (a workspace folder), with no `--home`: it proposes `./<folder>-factory`, next to those repos. It lists each repo as a project, and it clones each one into the new folder. When two folders are work trees of one repo, it lists the repo once and names the extra folder as skipped. It asks in a terminal window. With `--yes` it uses the proposal. With no terminal window and no `--yes`, it prints the proposal and exits 2.
- In an empty folder, or with `--home DIR`: that folder becomes the factory folder.
- It makes the folder a git repo and commits only the allowed files. It writes `factory.yaml` and `factory.local.yaml` (mode 600), writes `setup/coordinator.md` and `setup/roles/worker.md`, each with a short comment when the file is absent, renders `coordinator/CLAUDE.md` and `.factory/roles/worker.md`, and registers the factory in the factory list. A child node folder sits in its own folder, never inside the folder of its parent.
- It refuses a new factory folder inside a folder that the factory list holds (error, exit 1).
- `--project URL` clones the repo into the factory folder: `<factory folder>/<repo name>`. The repo name is the last part of the URL, without `.git`. It must be one folder name that is not reserved. The clone runs `git clone` with an argument list and `--` before the URL, never through a shell, and with no submodule recursion. It refuses a target that exists and is not a clone of the same URL (error, exit 1). `init` makes every check that needs no cloned project, and counts all projects, before the first clone. If a later step fails, it removes only what this run made.
- A clone URL has these rules: it is `https`, `ssh` (also the scp form) or `file`. An `https` URL has no user name. A password, a token or a secret part in any URL form is refused, a leading hyphen is refused, and the message never repeats the value. Two entries with one clone URL in normal form (the same host and path, with or without `.git`, in the scp or https form), or with one path, are refused. `init` refuses a project flag with credentials (exit 2) before it clones. A URL that `init` reads from an origin loses its user name, and `init` prints a warning. The rules protect secrets, so they stay stops.
- A project with no shareable URL (no origin, a `file` URL, or a local path that the user types) works on this machine. `factory.yaml` never holds a local path or a `file` URL that `init` writes. `init` and `doctor` warn that the factory cannot be shared with that repo, and name the fix: add an origin and set `url`.
- `--tracker`, `--items` and `--decisions` choose the board at setup (§4.10). In a terminal window, `init` asks which board to use when `--tracker` is absent.
- `--approval <point>=<owner|delegated>` sets the mode of one approval point. In a terminal window, `init` asks for each point of the recipe, with `owner` as the default. A second `init` in the factory folder asks again; this is how the owner changes a mode later (§6). With `--yes`, or with no terminal window and no flag, it writes `owner`. `--yes` with a flag that asks for `delegated` exits 2 and writes nothing. A `delegated` choice with no terminal window, or inside a factory session, exits 4 and writes nothing (§6).
- The hook settings of the coordinator (§4.6): on a new, a received and a registered factory, `init` makes sure that `coordinator/.claude/settings.local.json` holds the hook for each event and the status line wrapper. Its checks and its stops come before the first write, like every other check of `init`. The question comes after the last write, because the coordinator folder exists then, and after the setup acceptance. In a terminal window `init` prints the exact change and the file, then asks (the default is no). `--yes` agrees outside a factory session. With no terminal window and no `--yes`, and inside a factory session with `--yes` (also in a terminal window), `init` writes nothing, prints the change and exits 2. An answer of no does not fail `init`: it goes on without the hook, and prints one line that names the effect (no last-seen record, so a restart or a reboot can not resume the session by its id) and the way to add the hook later (run `init` again and answer yes). When the entries are in place, `init` asks nothing and writes nothing. A received factory keeps its stop: with no terminal window, `init` stops on a received factory that tracks setup text or other files, also with `--yes`.
- `--state-from SRC` clones a state repo (a git URL or a path) into `.factory/` instead of an empty one, and runs `doctor`. This is how a second machine gets the work state (FAC-M3).
- If a step fails, or if `init` cannot write the factory list, it exits 1 and removes only what this run made. A second `init` in the same folder then works. A file or folder that was there before the run stays as it was.
- `factory start` then starts the session. The user never has to know the folder.

**How a command finds the factory folder (F-3).** The order is: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml` (at most 64 levels). The projects are inside the factory folder, so the walk finds it from a clone, from the coordinator folder and from a work copy. Work copies of workers live in one fixed folder under the factory folder, `work-copies/`, and the share list leaves it out. A work copy that sits outside the factory folder has no `factory.yaml` above it. For that case FAC-M4 adds a fallback (OD-7), after the factory list finds no project folder that holds the current folder: the lookup asks git for the common git folder of the current folder (one `git rev-parse --git-common-dir` call). When that folder is the `.git` folder of a project that an entry of the factory list names, the folder of that entry is the factory folder. This holds for a separate git work tree of a listed project, outside the factory folder. Two entries that name the project are exit 2, and a git folder of no listed project gives the usual exit 2 and hint. Then the registration check runs (D-5). A `factory.yaml` counts only when three things are true:
1. The factory list has an entry for its folder.
2. The `id` of that entry is the `node.id` of the config.
3. The factory marker `.factory/node.json` is present and valid.

A config in a clone that someone else wrote has no entry, so it runs no command and gets no proxy check. If the check fails, `start`, `doctor`, `node` and `upgrade` exit 4. They name the file and the reason, and they print one remedy: `factory init` in the factory folder (no entry, another node id, or a missing or broken factory marker), or "go to the factory folder, or name it with --home" (a clone that holds its own `factory.yaml`). `init` on the factory folder registers a received or a moved factory (see "Share a factory"). The check applies to the walk, to `--home` and to `FACTORY_HOME`.

The factory list is a per-user file: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json` when the variable is not set. It is outside `~/.claude`. Its folder has mode 700 and its file has mode 600, and a reader refuses a file of another user or a file that others can write. Each entry holds the folder path, the node id, the absolute path of each project and the origin (`own` or `received`). A folder that no longer exists is ignored, and `doctor` warns. A work copy does not enter the factory list. Several factories on one machine each have their own entry, and each resolves its own folder.

**The instruction-file rule (F-17, D-60).** Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the session folder and from every folder above it (the memory page of the Claude Code documentation, https://code.claude.com/docs/en/memory). Other common agents load other file names. factory starts Claude Code only, and the check covers the file names of the other common agents too, because a person may start another agent in the same folder. The list is: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `.claude/CLAUDE.md`, `.claude/rules`, `.claude/settings.json`, `.claude/settings.local.json`, `.github/copilot-instructions.md` and `.cursor/rules`. The check only tests that a path exists (a link counts), and it reads no file. The list lives in one place in the code (`src/core/instruction-files.ts`), and `doctor`, `start` and `init` all read it. `doctor` warns when the factory folder, or any folder above it, holds a file of the list. The walk looks at 64 folders at most: the factory folder and 63 folders above it. When it stops at that bound before the top of the file system, it says so in a warning. An unreadable folder gives a warning, not a failure. `doctor` shows the warning as the check `instruction-files`. `start` and `init` print the same warning on stderr before they act. The limit: factory never reads under `~/.claude`, so it cannot see the instructions of the user level. In the user home folder, the walk skips the paths that start with `.claude/`. When `HOME` does not name an absolute folder, it skips them in every folder above the factory folder. A warning is enough here, because the file is the choice of the user in the user's own folders.

#### Share a factory

A factory can travel from one machine or person to another through git (F-18f, D-60).

- **What travels in git.** `factory.yaml` (the node, the board config, the recipe name and the projects, `session`, `limits`; the approval points come with the installed recipe) and the `setup/` folder (the coordinator text `setup/coordinator.md` and the worker role text `setup/roles/worker.md` now; more setup files in FAC-M6).
- **What does not travel.** `factory.local.yaml` (personal values, credentials and values of one machine), `coordinator/` (each machine renders it from the package and from `setup/coordinator.md`), `.factory/roles/worker.md` (each machine renders it from the package and from `setup/roles/worker.md`), the clones and the work copies (each machine clones them), and the work state in `.factory/` (items, decisions, workers) until FAC-M3 moves it with `init --state-from`.
- **The one command.** Clone the config repo, then run `factory init` in it. `init` clones each repo and registers the factory on this machine. In a terminal window it asks for these things, in this order: the personal values (the account, that is, the owner fields); the mode of each approval point, with `owner` as the default; the setup acceptance, that is, a yes or a no for the setup text (`setup/coordinator.md` and `setup/roles/worker.md`) and for every other file that the config repo tracks; and a yes or a no for the write of the hook in `coordinator/.claude/settings.local.json`, when `init` writes it (§4.6). Then `factory start` works. With no terminal window, or with `--yes`, `init` stops on a received factory that tracks setup text or other files, so a script can not receive such a factory. Until FAC-M10, a developer with read access installs the `factory` program from a private early-access tag (D-49), so the one command needs a machine that already has the program.
- **Publish the config repo.** Add a remote to the factory folder and push: `git remote add origin <url>`, then `git push -u origin main`. Only the files of the share list go out.
- **A project with no origin.** A project with no origin, or with a local source that the user types, works on this machine, but the factory cannot be shared with it. Its local source stays in `factory.local.yaml` (key `sources`), never in `factory.yaml`. `init` and `doctor` say so.
- **A received project with no shareable URL.** On a received factory, `init` never clones a project that has no `url`, a `file` URL or a bare local path in `url`. It skips that clone, warns, and names the folder to fill. This is a warning, so the command goes on, and `start --dry-run` still exits 0. `start` warns about the missing folder and adds no `--add-dir` for it. `doctor` warns for a bare local path in a received `url`.
- **A received factory is a trust boundary.** The files of another machine or person are not trusted until the owner accepts them. The lighter rule of the user's own clones does not apply to them. `init` on a received or moved factory checks the tracked paths and the ignore rules before it writes anything. A tracked local file, a tracked state path or a tracked `coordinator/` path stops the command on every factory, until the owner acts. `init` records in the factory list whether the factory is your own or received. A moved factory counts as received, because `init` cannot tell a moved factory of your own from a copy of another one (D-16). On a received factory, `init` lists every other file that the config repo tracks (apart from `factory.yaml` and `.gitignore`), and the owner accepts them together with the setup text. An absent or empty setup file does not skip them. On your own factory, a tracked instruction file or Claude settings file gives a warning only (R2). A setting that skips permission prompts, that changes the session marker, or that sets the proxy or the credential of the session, stops on every factory.
- **The setup text needs the owner.** The setup text is `setup/coordinator.md` and `setup/roles/worker.md`. It goes into session instructions. So the owner accepts the hash of each file at the first `init`, and again after each change (D-13). After a change, `factory start` or `factory upgrade` in a terminal window outside a factory session shows each added, removed and changed file with its text, and asks. With no terminal window, in a factory session or in a dry run, it stops and names the command (R1). With no acceptance at all, the command to run is `factory init` in a terminal window. Only `init` makes a first acceptance. When `init` makes a new factory and writes the setup text itself, it accepts the hash of its own text in the same run, after the entry in the factory list, with or without a terminal window, and prints the same lines as `init --yes`. A setup file that was there before the run is not text of `init`: the run accepts nothing, warns, and names `factory init` in a terminal window. `init --yes` prints the file, its hash, the folder, the node id and the reason, and accepts only setup text that `init` wrote itself. `--yes` never answers the prompt for the other tracked files of a received factory. With no terminal window, `init` stops there, also with `--yes`, and names the command. If the owner answers no in a terminal window, `init` goes on, and `start` stops until the owner accepts. The prompt shows the full text of each new or changed file, or a diff against the accepted version when git still has it. A file past the display bound is not shown in part: the prompt says so, names the path and the command to read it, and keeps no as the default. A control character shows as a visible escape.
- **The origin of a factory.** `init` writes the origin of a factory, `own` or `received`, into its entry in the factory list. A new factory that `init` makes is `own`. A registration again keeps `own` only for the same node id. Another node id gives `received`. The received path always writes `received`. The origin never goes back to `own`, unless `init` makes a new factory. A moved factory, and an entry with no origin, count as `received` (D-16). `upgrade` of a FAC-M1 folder writes `own` only when the folder held no `.git` before the run, else `received`. `upgrade` exits 4 for a setup file with no acceptance, also with `--yes`. Its remedy line names `factory init` in a terminal window.
- **Links and outside paths.** factory refuses a link, or a path that resolves outside the factory folder, in `setup/`, in `coordinator/` and in the backup of a block.
- **Your own coordinator text.** Write it in `setup/coordinator.md`, not in `coordinator/CLAUDE.md`. `init` and `upgrade` render the first file into the second. `doctor` warns about text in `coordinator/CLAUDE.md` that does not travel. A hand edit inside the `setup` block does not stay: `doctor` warns and names the setup file, and `upgrade` puts back the text of the setup file and keeps the edited text in a backup file.
- **Your own worker text.** Write it in `setup/roles/worker.md`, not in `.factory/roles/worker.md`. `init` and `upgrade` render the first file into the second.

#### Stops and warnings

Factory gets in the way as little as possible (F-17). Each check is in one of three classes (F-17c):
- **A security stop (exit 4).** Only a check at a security boundary stops a command. A stop prints one line with the reason and one line with the command that fixes it. A stop with no remedy is not allowed.
- **An error (exit 1, or exit 2 for a usage error).** The command cannot run at all, for example on a platform that factory does not support. The errors of the URL and path rules also print a remedy line. Other errors keep their text.
- **A warning (exit 0).** Every other check warns. `doctor` shows the warning, and the command goes on.

A received factory is a trust boundary, so its checks are stops. The lighter rule, a warning, applies to the user's own clones. The table lists every stop and every warning with the command that fixes it. The first column says the kind of each row. A command that stops names the same remedy command in the table and in its own section; a section that defines a stop points to this table.

| Stop | When | Remedy command |
|---|---|---|
| Error (exit 1): a tool is missing (`tmux`, `git`, `claude`, or the board tool such as `gh`) | Any new machine. `doctor` checks the versions, and git 2.26 or newer (§4.7). | Install the tool, then run `factory doctor`. |
| Error (exit 1): native Windows | Any command (§4.7) | Use WSL, then run `factory <command>` there. The command is the one that you typed, or `factory help` when the line names no command. |
| Warning (exit 0): Claude Code asks its own questions (the login, the trust of a new folder) | The first `start`. factory does not answer them. | Run `claude` once in the factory folder and answer the questions, then run `factory start`. |
| Error (exit 1): a clone of a project fails, for example with no access | `init` on a received factory. `init` removes only what this run made. | Get access to the repo or fix its `url` in `factory.yaml`, then run `factory init` again in the factory folder. |
| Usage error (exit 2): no terminal window and no `--yes` | A script runs `init`. `init` prints the proposal. | Run `factory init` in a terminal window, or add `--yes`. |
| Usage error (exit 2): a project flag with a clone URL that has a user name in an `https` URL, a password or a token, a scheme that is not allowed, or a leading hyphen | `init` | Use an `https` URL with no user name, or an `ssh` URL. Then run `factory init` again. |
| Usage error (exit 2): a project folder or work tree path whose name holds a control character. The command writes nothing. | `init` | Rename the folder, or name another folder. Then run `factory init` again. |
| Stop (exit 4): a project path outside the factory folder or reserved | `init`, `project add` | Use one folder name that is not reserved. Then run `factory init` again. After a stop of `project add`, run `factory project add` again. |
| Stop (exit 4): a factory folder that is the settings folder of Claude Code (`~/.claude`) or is inside it, whether it comes from `--home`, `FACTORY_HOME`, the current folder or the factory list | `init`, `start`, `doctor`, `node`, `upgrade` | Go to another folder, or name one with `--home DIR`. Then run `factory init` after a stop of `init`, or `factory doctor` after a stop of another command. |
| Stop (exit 4): the registration check fails | `start`, `doctor`, `node`, `upgrade` in a received or moved factory, or in a clone that holds its own `factory.yaml` | `factory init` in the factory folder. For a clone that holds its own `factory.yaml`: go to the factory folder, or name it with `--home`. |
| Stop (exit 4): a tracked local file, a tracked state path or a tracked path under `coordinator/` | `init` and `start`, on every factory. `doctor` reports it. | Stop tracking the path (`git rm --cached <path>`), commit, then run `factory init`. |
| Stop (exit 4): on a received factory, a tracked file that the owner has not accepted | `init`, `start` | Run `factory init` in a terminal window and accept the files. |
| Stop (exit 4): on a received factory, a tracked link, a tracked path under a clone folder, or a file over its size cap | `init` and `start`. `doctor` reports it. | Replace the link with a plain file, or stop tracking the path or the file (`git rm --cached <path>`), commit, then run `factory init`. |
| Stop (exit 4): a list of tracked files over its cap, or a list that git can not give in full, on every factory | `start`. `doctor` reports it. On a received factory, `init` stops too. | Stop tracking the files that the factory folder does not need (`git rm --cached <path>`), commit, then run `factory doctor`. On a received factory, run `factory init` after that. |
| Stop (exit 4): a setup file with no accepted hash, or a setup file that changed after a pull | `start`, `upgrade`. `doctor` reports it. In a terminal window outside a factory session, and not in a dry run, `start` and `upgrade` show a change and ask. | With no acceptance at all: run `factory init` in a terminal window. After a change: run `factory start` or `factory upgrade` in a terminal window outside a factory session. |
| Stop (exit 4): a link, or a path that resolves outside the factory folder, in `setup/`, `coordinator/` or the backup of a block | `init`, `start`, `upgrade` | Replace the link with a plain file inside the factory folder, then run `factory doctor`. |
| Stop (exit 4): a value that looks like a password or a token in a tracked file | `init`, `start`, `doctor` | Remove the value from the file, put it in `factory.local.yaml`, then run `factory doctor`. |
| Stop (exit 4): a setting that skips permission prompts in a checked settings file (also after an acceptance), or a checked settings file that sets or clears a variable whose name starts with `FACTORY_` in `env` | `start`, `restart`, `reboot`, `worker new` (§4.6). `doctor` reports it. | Remove the setting from the file that the message names, then run `factory doctor`. |
| Stop (exit 4): a checked settings file that sets the proxy or the credential of the session (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_CUSTOM_HEADERS` in `env`), or a checked settings file in `coordinator/` or in a project folder that runs a command (a hook, a status line or a key helper). The hook and the status line that factory writes itself do not count. | `start`, `restart`, `reboot`, `worker new` (§4.6). `doctor` reports it. | For a status line that you want to keep, check its command first. If you trust it, set `session.statusline` in `factory.local.yaml` to the command: the wrapper runs it and shows its output (§4.6). Remove the setting from the file that the message names, then run `factory doctor`. |
| Stop (exit 4): a security check that can not finish: git fails when it lists the tracked files or when it answers the ignore question for the local file or the state folder, a settings folder holds more settings files than the check reads, a settings folder can not be read to the end, a settings folder or a settings file is a link, or a settings file can not be read in full | `start`. `doctor` reports it. | Fix the problem that the message names, then run `factory doctor`. |
| Stop (exit 4): the safety block is edited or missing | `start`, `doctor` | `factory upgrade --overwrite safety` (it keeps the old text in a backup file). |
| Stop (exit 4): `upgrade --overwrite safety` inside a factory session | `upgrade` | Run `factory upgrade --overwrite safety` in a terminal window outside a factory session. |
| Stop (exit 4): a `delegated` choice with no terminal window, or inside a factory session (the approval record guard) | `init` (§6) | Run `factory init` in a terminal window outside a factory session. |
| Usage error (exit 2): `--yes` with a flag that asks for `delegated` | `init` | Run `factory init --approval <point>=delegated` in a terminal window, with no `--yes`. |
| Stop (exit 4): the local file has a write bit, another owner, or is a link | `start`, `init`, `node`, `upgrade`, `doctor` (§4.4) | For a write bit: `chmod 600 factory.local.yaml`. For another owner or a link: move the file away, then run `factory init` to write a new one. |
| Warning (exit 0): the local file has a mode that others can read | `doctor`, a dry run. Other commands set the mode back to 600 and print a notice. | `chmod 600 factory.local.yaml` |
| Error: a proxy does not answer | Before each start of a session; `doctor`; `status` (§4.6) | Start the proxy, or set `proxy: none` for the worker. |
| Stop (exit 4): the tmux session of that name belongs to another factory, or has no `@factory_home` option | `start`, `shutdown`, `restart`, `reboot` (§4.11) | Run `factory shutdown` in the factory folder that owns the session, or end that session by hand. Then run `factory <command>` again, with the command that stopped. |
| Error (exit 1): `dismiss` of a busy worker, of a worker whose state is not known, or of a worker whose work is not pushed (`STUCK:`) | `dismiss`, `dismiss --unused` (§4.11) | Wait until the worker waits at its prompt, finish the work item or give it to another worker, or push the branch of the worker and clean its work copy. Then run `factory dismiss <worker>` again. |
| Stop (exit 4): `decide <D-n> <option>`, `dismiss <worker> --yes` or the pick step of `dismiss --unused` inside a factory session | `decide`, `dismiss`, `dismiss --unused` (§4.10, §4.11) | Run `factory decide <D-n> <option>`, `factory dismiss <worker> --yes` or `factory dismiss --unused` in a terminal window outside a factory session. |
| Stop (exit 4): `dismiss` of a worker whose work copy is outside `work-copies/`, whose path holds a link, or whose `.git` file does not name the git folder that the clone keeps for it | `dismiss`, `dismiss --unused` (§4.11) | Check the record of the worker, the links in the path of its work copy and the `.git` file in it. Then run `factory dismiss <worker>` again. |
| Stop (exit 4): a release check with `release: delegated` and no owner-approved release scope for the version | `release check` (§6.2) | Run `factory release scope <project> <version>` in a terminal window outside a factory session. Then run `factory release check <project> <version>` again. |
| Stop (exit 4): the decision store is public | `init`, `tracker set` (§4.10). `doctor` fails on it. | `factory tracker set <id> --decisions <private repo>`, then `factory tracker status`. |
| Error (exit 1): the package of a board plugin is not installed. Factory loads no code. | `tracker set`, `doctor` and every command that uses the board (§4.15, FAC-M11) | `npm install -g <package>`, then run `factory doctor`. The install is a trust decision (§4.15). |
| Error (exit 1): the real path of a board plugin is outside the folder that `npm root -g` prints, or the package name is not a valid npm package name. Factory loads no code. | `tracker set`, `doctor` and every command that uses the board (§4.15, FAC-M11) | Check the name in `factory.local.yaml`. Install the package in the global npm folder with `npm install -g <package>`, and only if you trust it. The install is a trust decision: the plugin runs inside factory with your rights (§6). Then run `factory doctor`. |
| Error (exit 1): a board plugin speaks another major version of the contract `factory.board/v1`, or returns a result that fails the schema check. The command writes nothing. | Every command that uses the board. `plugin test` reports it. | Install a version of the plugin that speaks `factory.board/v1`, then run `factory plugin test <package>`. The install is a trust decision (§4.15). |
| Error (exit 1): a board plugin has a reserved name. The reserved names are `local`, `artifact` and `github`. Factory loads no code. | `tracker set`, `doctor` and every command that uses the board (§4.15, FAC-M11) | Install a plugin with another name, then run `factory tracker set plugin:<package>`. The install is a trust decision (§4.15). |
| Error (exit 1): `factory.yaml` names a board plugin as the kind of the board. The shared file takes only `local`, `artifact` or `github`. Factory loads nothing. | Every command that loads the config. `doctor` reports it. | Remove the plugin kind from `factory.yaml`, then run `factory tracker set plugin:<package>`. It writes `factory.local.yaml` (§4.4). |
| Error (exit 1): a write to the board fails, because the board does not answer or refuses the write. The cache stays as it was, and no queue holds the write (D-141 B). | `item`, `request` and `track` commands that write (§4.10) | Run `factory doctor`, fix the cause that it names, then run the command again. |
| Error (exit 1): a write to the board gets no answer before the time cap. The result is "unknown": the board may hold the write. The cache stays as it was. | `item`, `request` and `track` commands that write (§4.10) | Run `factory watch`, then run the command again. Each item carries its factory id, so a retry makes no second item. |
| Warning (exit 0): the CLI of a board is not configured, is not authorized, or lacks a scope that the plugin declares. The line names the check and the scope, and never prints output of the CLI. | `doctor` (FAC-M11, §4.15) | Configure or authorize the CLI with its own login command, or give the scope that the line names. Then run `factory doctor`. |
| Warning (exit 0): a read of the board passes the time cap, the output byte cap or the result cap. The result is "unknown", and the line names the cap. | `watch`, the refresh of the cache, `decide read`, `tracker status`, `doctor` (§4.10) | Run the command again. If the line repeats, run `factory tracker status` to see which board it is. |
| Warning (exit 0): an item, a track or a note in the cache differs from the board (drift). The output names each item id up to the cap, and then says "more than <cap>". | `watch`, the refresh of the cache, `tracker status`, `doctor` (§4.10) | `factory watch`. The board wins: the cache takes its state. |
| Warning (exit 0): a decision record or an approval record on the board differs from the owner store. The output has one drift line for each of the two stores. The refresh never changes them. | `watch`, the refresh of the cache, `tracker status`, `doctor` (§4.10) | For a decision, run `factory decide read`, then run `factory decide <D-n> <option>` in a terminal window outside a factory session. For an approval record, run `factory init` in the factory folder, in a terminal window outside a factory session. |
| Warning (exit 0): a board plugin does not list an operation in its `describe` result (for example `note`). The cache keeps the change with a mark. | The command that needs the operation. `tracker status` shows one line for it. | Use a plugin that supports the operation, or keep the mark on purpose. |
| Stop (exit 4): the `artifact` board has no confirmation on this node that the page is private. Factory prints no `PUBLISH:` line. | Every command that changes the page (§4.10, FAC-M11) | Run `factory tracker set artifact` in a terminal window outside a factory session, and answer the question. |
| Warning (exit 0): the page of the `artifact` board is private only by the answer of the owner. Factory cannot check it, so it prints "page privacy not checked" and never passes the check. | `doctor` (FAC-M11) | Check in the settings of the page tool that the page is private, or keep the warning on purpose. |
| Usage error (exit 2): `tracker set artifact` with no terminal window | `tracker set` | Run `factory tracker set artifact` in a terminal window outside a factory session. |
| Stop (exit 4): `tracker set artifact` inside a factory session | `tracker set` | Run `factory tracker set artifact` in a terminal window outside a factory session. |
| Stop (exit 4): `item doc` of a link, of a file outside the projects and the factory folder, of `factory.local.yaml`, of a state file, or of a file over the size cap. Factory finds the real path first. | `item doc` (§4.10, FAC-M11) | Copy the text into a plain file inside a project, under the size cap. Then run `factory item doc` again with that file. |
| Stop (exit 4): the text of an item holds a value that looks like a password or a token, and the items store is public. The output names the item and never the value. | The `item` and `request` commands that write text, before the write (§4.10, FAC-M11) | Remove the value from the text, then run the command again. |
| Stop (exit 4): the decision log or an approval record fails its check, because something other than factory changed it | A command that uses a record as proof: `worker relay`, `pr merge` and `release check` (§6). `doctor` fails on it. | Run `factory doctor`: it names the file. Restore the decision log from the history of `.factory/`, or write the approval record again with `factory init` in a terminal window outside a factory session. Then run `factory doctor`. |
| Error (exit 1): `decide read --from FILE` with a file over its size cap, a file that fails the schema, or a file with a real path outside the projects and the factory folder. The error never repeats text of the file. | `decide read` (§4.10, FAC-M11) | Write the data file again inside a project or the factory folder, under the size cap and in the schema of the page data. Then run `factory decide read --from FILE` again. |
| Usage error (exit 2): a hook or status line write, with no terminal window and no `--yes`, or with `--yes` inside a factory session | `init`, `start`, `worker new` (§4.6). The command writes nothing and prints the change. | Run `factory init`, `factory start` or `factory worker new` in a terminal window, or add `--yes`. Inside a factory session, run the command outside the session, or in a terminal window with no `--yes`. |
| Error (exit 1): the settings file changed while the question about the hook write waited, and the new text gives another change | `init`, `start`, `worker new` (§4.6). The command writes nothing. | Check the file. Then run `factory init`, `factory start` or `factory worker new` again. |
| Warning (exit 0): a rule that allows a whole tool (for example `Bash` or `*`) in a settings file | `doctor`; `start` prints it | Narrow the rule in the settings file that `doctor` names. |
| Warning (exit 0): a setting that runs a command (a hook, a status line or a key helper) in a settings file of the factory folder, or at a tracked path. The hook and the status line that factory writes itself do not count. | `doctor`; `start` prints it | Check the setting in the settings file that `doctor` names, or keep it on purpose. |
| Warning (exit 0): a setting that approves project MCP servers | `doctor`; `start` prints it | Remove the setting from the settings file that `doctor` names, or keep it on purpose. |
| Warning (exit 0): a tracked instruction file or Claude settings file on your own factory | `doctor`, `init`; `start` prints it | Stop tracking the file (`git rm --cached <path>`), or keep it on purpose. |
| Warning (exit 0): an instruction or settings file of the list in the factory folder or above it, a folder that the walk could not read, or a walk that stopped at 64 folders (see the instruction-file rule) | `doctor`; `start` and `init` print it | Move the file out of those folders, or keep it on purpose. Then run `factory doctor`. |
| Warning (exit 0): a project with no shareable URL (no origin, a `file` URL or a bare local path) | `init`, `doctor` | Add an origin to the repo and set `url` for the project in `factory.yaml`, then run `factory doctor`. |
| Warning (exit 0): text in `coordinator/CLAUDE.md` or in `.factory/roles/worker.md` that does not travel | `doctor` | Move the text to `setup/coordinator.md` or to `setup/roles/worker.md`, then run `factory upgrade`. |
| Warning (exit 0): a `delegated` mode with no matching approval record | `start`, `doctor` (§6) | Run `factory init` in a terminal window outside a factory session. |
| Warning (exit 0): the state shows another machine as active | `start` (FAC-M4) | Run `factory shutdown` in this factory folder on the other machine, then run `factory start` here. |
| Warning (exit 0): the delete guard of `.factory/` is off. The setting, the guard folder, the mode of a hook or the text of a hook does not match the package (§6). | `doctor` (the check `state-guard`), `start`, `start --dry-run` | Run `factory upgrade`. |
| Warning (exit 0): the delete guard of `.factory/` is off, and `factory upgrade` can not repair it. `.factory/.git` is a file, a link or another folder. Or the path of the program of factory is not known. Or the guard folder is a link, is not a folder, is not at its real path, or holds more than 64 entries. | `init` and `upgrade`, also in a dry run: they print the cause and a manual step, and go on. `doctor` and `start` name the same step. | Do the manual step that the message names. For example: make `.factory/.git` a folder, start factory through its installed command, move the link away, or remove the extra entries from the guard folder. Then run `factory upgrade`. |
| Warning (exit 0): the guard write makes hooks of `.factory/` stop running. They are the files in `.factory/.git/hooks` that are not `.sample` files, the hooks in the folder that another setting of `core.hooksPath` names, and the extra entries in the guard folder that the write removes. Factory runs none of them. | `init` and `upgrade`, also in a dry run, before the guard write | Check the listed hooks. Do the work of a hook that you need in another way, because git runs only the hooks of the guard folder. Or keep the stop on purpose. |
| Error (exit 1): a hook of the delete guard names a program that is gone: the Node program or the script of factory, after a Node update, a second install or a moved package. The hook prints one line that names `factory upgrade`. | `git commit`, `git merge` that makes a merge commit, and `git am` in `.factory/` | Run `factory upgrade`. It writes the hooks again. |
| Stop (exit 4): the delete guard is off | The board commit helper (§6), which every command that writes a board file uses | Run `factory upgrade`. For a case that `upgrade` can not repair, do the manual step that the message names, then run `factory upgrade`. Then run the command again. |
| Stop (exit 4): the local git config of `.factory/` sets a key that starts with `filter.` or `hook.` and names a program. A new state repo can copy such a key from the git template folder (`init.templateDir`). | `init` (before its first `git add`), `upgrade`, the render of the setup text and the board commit helper. The claim of the active machine by `start` only warns. | `git -C .factory config --unset <key>`, then run the command again. For a key from the template folder, remove it there, then run `factory init` again. |
| Error (exit 1): git is older than 2.26, the git version can not be read, or git can not list its config scopes | `start` stops before it makes or looks at a session. `reboot` outside the session stops before its first stop. A dry run of `start` shows a warning. `init`, `upgrade` and the board commit helper stop before they change the state repo. `doctor` fails the check `tools`. | Update git to 2.26 or newer, then run `factory doctor`. |
| Error (exit 1): another writer holds the state lock `.factory/locks/state.lock` for the whole wait (20 tries, 250 ms apart). The message names the lock file. Three steps only warn, write nothing and go on (exit 0): the claim of the active machine by `start`, the clear of the mark by `shutdown`, and the clear of the mark in the end step of `reboot`. A stop must not fail on a busy lock. | `upgrade`, the board commit helper and every other step that commits to the state repo | Wait until the other `factory` command ends, then run the command again. The next writer takes over a lock file that is older than 300 seconds. |
| Warning (exit 0): `board.json`, `waiting.json` or `decision-log.json` is at 80 percent of the size cap of 1048576 bytes, or above it. The message names each file. | `doctor` (the check `board-size`) | Close items you do not need and shorten long texts, then run `factory doctor`. An archive file for the board comes in FAC-M5b. |
| Error (exit 1): the new text of a board file would be larger than the size cap of 1048576 bytes, or a board file is larger than the cap when a command reads it. The message names the file and the cap. A write changes no file. | `item`, `track`, `request` and `queue` (writes); every command that reads the board | Shorten the text of the file, or restore a smaller version of it from an earlier commit of `.factory/`. Then run the command again. |
| Error (exit 1): `board.json`, `waiting.json` or `decision-log.json` is not valid UTF-8, is not valid JSON of the right shape, or holds a repeated item id or request number. The message names the file, and the id when there is one. A write changes no file. | Every command that reads the board files | Restore the file from the last good commit of `.factory/` (`git -C .factory restore --source=<commit> --staged --worktree -- <file>`), then run the command again. |
| Error (exit 1): `board.json` still has the old queue key `queue`. | Every command that reads the board | `factory upgrade` |
| Stop (exit 4): a board write with a tracker kind other than `local`. The provider holds the truth in that case, and hosted boards come in FAC-M3. The command makes no commit. | `item add\|update\|move\|close`, `track add`, `request add\|close`, `queue set` (§4.10). Reads show the local files. | Set the tracker kind to `local` in `factory.yaml`, then run the command again. |

A factory folder under a linked parent folder works. The link rule checks only the paths below the real folder.

**Caps.** Each cap in these checks is a named number in the code (`src/names.ts`). The token scan of the tracked files stops reading at its cap of files and at its cap of bytes for each file, and it names what it did not scan. A list of tracked files over its cap stops `start` with exit 4 and one remedy line, on every factory. On a received factory it also stops `init`, and so does a file over its byte cap. A settings folder with more settings files than the check reads, and a settings file that the check can not read in full, stop `start` with exit 4 too. The acceptance never covers a partial list or part of a file. The time cap, the output byte cap and the result cap of a board call are named numbers in `src/names.ts` too. A call past one of them has the result "unknown", never "no answer". The drift check has a cap as well. Past it, the output says "more than <cap>" (§4.15, FAC-M11).

Section 6 says what the approval record guard, the setup accept prompt and the origin of a factory list entry do not prove.

#### Work state on a second machine

`.factory/` is a git repo. The owner can name a private remote for it: `factory state remote <url|path>` (FAC-M3) records it. `factory state push` pushes. `factory state pull` merges by fast-forward only, and reports a dirty state repo without changing it. `doctor` fails when the remote is a public GitHub repo, and warns when it cannot check the remote. The remote holds the profile, the roadmaps, the decision log and the items of the `local` board. It holds no secret (§6). Until FAC-M3, the work state stays on its machine.

The CLI code, templates, recipes and scripts live in the installed package, never in the factory folder. An upgrade of the package does not touch state (an idea from firstmate's code-root and home split).

### 4.4 Config: a shared file and a local file

The factory folder holds two config files. `factory.yaml` is shared: git tracks it, and it travels to every machine. `factory.local.yaml` is local: git ignores it, it has mode 600, and it holds only what is personal, a credential, or true for one machine. Each file has its own `schema` key and its own version. Schema 2 splits the core keys from the recipe keys. The core parses everything except `recipe`. The recipe parses its own block with its own schema.

The shared file, `factory.yaml`:

```yaml
schema: 2
node:
  id: acme                   # unique among siblings; also the tmux session name
  layer: 1                   # set by factory; the role comes from the layer (§5)
session:
  permission_mode: auto      # the only value accepted (§6)
  agent: claude              # the agent program of every session; only `claude` is accepted (§4.6)
  effort: high
  model: default
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count        # adapts to each machine
  context_prepare_pct: 30
  context_max_pct: 40
  idle_after: 2h             # <n>m or <n>h, 1m to 24h; a worker with no activity for this time may be unused (§4.11); named unused_after from FAC-M5b
tracker:                     # the default board of the node; a project can override it (§4.10)
  kind: github               # local | artifact | github; a board plugin is named in factory.local.yaml, never here
  items: acme/web            # where work items live (a repo)
  decisions: acme/decisions  # the decision store; private by default (§4.10)
  watch_interval: 5m         # `factory watch` read interval
board:                       # optional: what an item and a queue row can hold (§4.10); every key in it is optional
  states: [open, doing, blocked, done]   # 1 to 20 states of an item
  in_progress: doing         # a declared state
  closed: done               # a declared state
  worker_field: worker       # a declared item field that holds the id of a worker
  fields:                    # the owner fields, at most 20
    - { name: priority, target: item, kind: values, values: [P0, P1, P2], required: true }
    - { name: worker, target: item, kind: token }
    - { name: release, target: row, kind: flag }   # a flag on a queue row
recipe:
  id: software               # the approval points come with the installed recipe (§6)
  variant: plain             # default setup for every project
  projects:
    - id: web
      url: https://github.com/acme/web.git   # the clone URL; optional (a project with no URL stays on one machine)
      repo: acme/web         # optional: the GitHub owner and name, for the board
      path: web              # one folder name inside the factory folder
      default_branch: main
      merge_method: squash
      # variant: devflow     # FAC-M6: optional per-project override
      # tracker: { kind: github, items: acme/api }   # FAC-M3: optional override; the kind is local, artifact or github (§4.10)
      gate: { checks: [] }   # extra repo checks for `factory check`
      heavy_test: "npm test" # runs under `factory lock run`
```

The local file, `factory.local.yaml`:

```yaml
schema: 1                    # the local file has its own version
owner:
  display: "{{from git config user.name}}"   # written by init, never by the template
  github: "{{from gh api user}}"
  prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]"
session:
  proxy: none                # none, or the id of an entry in `proxies` (§4.6)
  statusline: null           # the owner's own status line command; the hook calls it (§4.6)
proxies:                     # optional; no keys or tokens here (§6)
  - id: local
    base_url: http://127.0.0.1:8787   # becomes ANTHROPIC_BASE_URL for the session
    health: /health                   # path that must answer before a launch
    on_fail: stop                     # stop (default) | direct
workers:                     # optional per-worker overrides
  web-search: { proxy: none }
approval:                    # the mode of each approval point of the recipe (§6)
  merge: owner               # owner (default) | delegated
  release: owner
sources:                     # the local source of a project with no shareable URL
  web: /srv/code/web         # the key is a listed project path (one folder name); the value is an absolute path or a file URL
# tracker:                   # FAC-M11: a board plugin for this node; it overrides the kind of the shared file
#   kind: plugin:<package>   # the npm package that the user installed (§4.15)
#   options: {}              # the options of the plugin; the plugin checks them with its own schema
# state:                     # FAC-M3
#   remote: null             # the private place of the work state of one owner
parent: null                 # or { id, address }; the address is file:// only (§5.3)
children: []                 # nodes this node manages, each { id, address } (§5)
```

**The rule.** A key stays local only if it is personal, a credential, or true for one machine only. Everything else is shared. The shared schema refuses a local key, and the error names the key and the local file. A change that adds a proxy entry to `factory.yaml` fails the load, and `start` makes no tmux call. The reason for each key:

| Key | File | Reason |
|---|---|---|
| `schema` | each file | Each file has its own version key. It is not a value that a person shares. |
| `node`, `tracker` (`kind` with `local`, `artifact` or `github`, `items`, `decisions`, `watch_interval`) | shared | They describe the factory and its board. |
| `board` (states, `in_progress`, `closed`, `worker_field`, fields) | shared | It says what an item and a queue row can hold. It is the same for every board kind. |
| `recipe` with the projects | shared | The recipe name and the project list make the same factory on every machine. |
| `session`: `agent`, `permission_mode`, `effort`, `model` | shared | They are a way of working. |
| `limits` | shared | The context percents are a way of working. The memory, disk and load values are a policy, and `load_max: cpu_count` adapts to each machine. |
| `owner` (display name, GitHub login, prefix) | local | Personal. A receiver is the owner on the receiver's machine. |
| `session.proxy`, `session.statusline` | local | True for one machine only; each names a proxy or a command of this machine. |
| `proxies` | local | True for one machine only (a local host and port). It is also a security boundary: a shared entry could send the model traffic of the receiver to a host that the receiver did not choose (Gate 1). |
| `workers` | local | True for one machine only; each entry picks a proxy of this machine for one worker. |
| `approval` (the mode of each point) | local | Personal. A delegation is owner authority and needs an approval record on each machine. The list of approval points travels with the recipe. Only the mode per person stays local. |
| `parent`, `children` | local | True for one machine only; each holds an absolute `file://` address. |
| the board account and its credentials (FAC-M3) | local | A credential. |
| `tracker` with a board plugin as `kind`, and its `options` (FAC-M11) | local | True for one machine only. The user installs the plugin on this machine and names it here. A name in the shared file would ask each receiver to load a package that the receiver did not choose. |
| `sources` | local | True for one machine only. It holds a local path, which never goes into the shared file. Each key names a listed project path. Each value is an absolute path or a `file` URL, with no user name, no `..` segment and no leading hyphen. |
| `state.remote` (FAC-M3) | local | It names the private place of the work state of one owner. |

**The project entry.** `url` is optional: the clone URL (§4.3). `repo` is optional: the GitHub owner and name, for the board. `path` is one folder name, and it is not a reserved name (§4.3). The recipe parses these keys. The core parses the file around them.

**Mode 600.** `init` writes the local file with mode 600. `start`, `init`, `node` and `upgrade` set a mode that has only group or other read bits back to 600, and print a notice. They stop (exit 4) when the file has a group or other write bit, when another account owns it, or when it is a link (D-14). `doctor` and every dry run only warn, and name the `chmod` command. With `factory.yaml` and no `factory.local.yaml`, `start`, `doctor` and `node` exit 2 and name `init`.

- `tracker.kind: local` takes no other tracker key: the items and the decisions stay in `.factory/` (§4.10). The schema refuses `items`, `decisions` or `watch_interval` with `local`. The change feed of `local` has a fixed default interval, so it has no new key. `tracker.kind: artifact` takes no other tracker key either: its items stay in the local files, and its page is a view (§4.10). `github` needs `items` and `decisions`.
- **The kind of the board in each file (FAC-M11).** In the shared file, `tracker.kind` takes only `local`, `artifact` or `github`. A board plugin is an npm package that the user installed (§4.15). The user names it only in `factory.local.yaml`, in a `tracker` block with `kind` and `options`. On this node, that block overrides the kind of the shared file. `factory tracker set plugin:<package>` writes the local file. `items` and `decisions` stay in the shared file. A shared file that names a plugin kind stops the command with exit 1, and the message names `factory.local.yaml` (§4.3, "Stops and warnings"). The plugin checks its `options` with its own schema, and an unknown key under `options` fails and names the key. A plugin such as `jira` or `linear` has the options `site` and `key` (FAC-M9).
- **Page privacy and the records stay out of the shared file (FAC-M11).** The answer of the owner about the privacy of the `artifact` page is kept for each node, outside the shared file (§4.10). The decision log and the approval records are never a cache of the board. They stay in the owner store for every kind (§6).
- A project can name its own `tracker` with `kind` and `items`. The kind is `local`, `artifact` or `github`. A project that uses a board plugin names it in `factory.local.yaml` too, never in the shared file. The decision store stays the one of the node, so the owner answers in one place. A project with no `tracker` uses the one of the node. The `tracker.decisions` key names a place, not the records, so it stays shared (D-9). With the `local` board the records stay in the private `.factory/`.
- `session.agent` (FAC-M4) is the program that factory starts for a session. Only `claude` is accepted. All starts of the agent use this value (§4.6). Before FAC-M4, the schema has no such key, and factory starts `claude`.
- `approval` maps each approval point of the recipe to `owner` or `delegated`. A point that the file does not name is `owner`. The schema refuses a point that the recipe does not list. §6 says what each value means and what proves `delegated`.
- `board` (FAC-M5) is the block of the owner fields (§4.10). The block is strict: an unknown key stops the load and names the key. The local file refuses a `board` key. A state, a field name and a field value are tokens of at most 40 characters. A field name cannot be a key that the board files use (for example `id`, `title`, `status`, `track` or `stage`). `in_progress` and `closed` name declared states. `worker_field` names a declared field with the target `item`. Without a `board` block, the factory has no item states and no owner fields, and `item add`, `item close` and `item move --state` stop with exit 2 and point to the sample setup in `examples/`. The schema version stays 2, so an older program refuses a config that has a `board` block.
- The shared file holds no secret and no local path. `factory doctor` refuses a tracked file with a value that looks like a password or a token. The schema is checked at load with a fixed schema (Zod). An unknown key or a bad value stops the command and names the key. It never falls back to a looser default (from firstmate's fail-closed parse).
- A command that a shared project entry names (a check command of the recipe) runs only after the owner accepts it. No code runs such a command before FAC-M5b, which builds the acceptance.
- A FAC-M2 config (the key `cells` or `approval.land`) is refused with a message to make the factory again with `init`.

### 4.5 Upgrades without loss of state

- **State has a version.** `node.json` holds `schema_version`, and `factory.yaml` holds `schema`. Each migration is one pure function from version N to N+1, with a test.
- **The upgrade order:** a dry run that prints the plan, including the move of `CLAUDE.md` into `coordinator/`, the share list in the `.gitignore` of the factory folder and the config repo, and checks every new file against the new schema; a backup to `.factory/backups/<ts>/`; the migrations; the share list, and the config repo with its first commit of the shared files that exist when the folder holds no git repo; one commit in the state repo with the files that the upgrade wrote or moved. The upgrade also adds the line `workers/` to the `.gitignore` of the state repo when the line is missing, and keeps every other line of the file as it is. A missing file is made with the lines of a new state repo. The commit holds the file. A link at that path stops the upgrade (exit 4). The upgrade writes or repairs the delete guard of the state repo (§6) after the ready check of the state repo, the link check and the backups, and before the first file change. A refusal before the guard write changes nothing. A stop after the guard write leaves the guard in place and says so: "Wrote the delete guard in .factory/.git/factory-guard. It stays." The dry run names the guard step, and the object `factory.upgrade` has the field `stateGuard`. Its value is `current` (the guard is on), `install` (the upgrade writes it) or `unsupported` (only a person can repair it). For `unsupported`, `upgrade` warns with the cause and a manual step, and goes on (exit 0). Before an `install`, `upgrade` and its dry run print one warning that lists the hooks of the state repo that stop running (§6). A run that changes only the guard makes no backup and no commit. The upgrade adds the missing hook events (`Notification` and `PreToolUse`) to the hook settings of each recorded work copy whose settings file holds a factory hook entry, and to the coordinator settings. It needs the consent of §4.6 (a yes in a terminal window, or `--yes` outside a factory session). A dry run lists the change and writes nothing, and a settings file with no factory hook entry is skipped. A write failure is exit 1 and names the files that changed; the object `factory.upgrade` has the field `hookSettings` with the files that the step changed (or would change). After the step, run `factory reboot`, so that each session gets its name and the new events. The upgrade renames the queue key of `board.json` from `queue` to the queue key of the recipe (for the software recipe, `merge`). It changes that key only: the key order, the layout and the text of the items stay as they are. The renamed file is one more file of the one upgrade commit, and the upgrade makes no nested board commit. A factory with no `board.json`, and a board that has the key of the recipe already, need no rename. A board that cannot be read stops the upgrade (exit 1) and names the file, also in a dry run. If the new text would drop an item id that the last commit holds, the upgrade stops (exit 4) and changes nothing. The dry run prints the line `.factory/board.json: rename the queue key "queue" to "merge". Your other text stays.` The object `factory.upgrade` has the field `boardQueueKey`, with the value `rename` or `current`. The upgrade adds no `tracks` key: an absent key reads as an empty list. The upgrade writes no file under `setup/`. If one step fails, factory restores the backup, removes the config repo that it made, and stops.
- **Managed blocks.** `CLAUDE.md` and the role templates contain blocks between `<!-- factory:begin <name> v<n> sha256=<hash> -->` and `<!-- factory:end <name> -->`. An upgrade rewrites only these blocks. The owner's text outside them stays. If the hash shows a hand edit inside the `safety` block, factory stops and shows the diff. A role block that a person edited stays, with a warning. The owner moves an edit out of a block, or accepts the loss with `--overwrite <name>`. When `upgrade` replaces an edited block, the old text goes to a backup file in the state folder.
- **The clay rule (FAC-M6).** An upgrade changes only the factory layer: the code, the fixed rules, the blocks that the package renders, and the template files that the package wrote (for example the format file of the decision profile). It never overwrites the owner layer: the files under `setup/`, the owner text outside the blocks, the owner hooks and fields, the principles and records of the decision profile (`.factory/decision-profile/`), and the roadmaps (`.factory/roadmaps/`). When the owner edited a role block, the setup block or a template file, and the new package also changes it, `upgrade` keeps the owner text and shows the conflict as a diff of the two texts. The owner decides: keep the owner text, or take the new text with `--overwrite <name>` (the old text goes to a backup file). With no terminal window, `upgrade` keeps the owner text and lists each conflict. The fixed rules are not clay: an edited `safety` block still stops `start` and `upgrade` (exit 4), and only `--overwrite safety` repairs it (§4.13).
- **No downgrade of state.** An older CLI refuses a newer `schema_version`, with a message.
- **Parents and children can run different versions.** The report schema has its own version, and a parent reads every report version back to the oldest supported one.

**The schema 1 → 2 migration** (the first real migration; a FAC-M1 node has schema 1):

| Schema 1 | Schema 2 |
|---|---|
| `node.role: coordinator` | `node.layer: 1` |
| `lanes.<id>` | `workers.<id>` |
| `projects[]` | `recipe.projects[]`, with `recipe.id: software` |
| `projects[].pack: plain` | `recipe.variant: plain` (a per-project `variant` only when it differs) |
| (none) | `tracker.kind: local`. The owner moves to a team board later with `factory item import` |
| (none) | the approval map in the local file: `approval.merge: owner` and `approval.release: owner` (§6) |
| (none) | `parent: null` |
| `children[]` with entries | The migration stops and changes nothing, because the children of layer 1 are workers. A child whose address is not a valid `file://` address is named (F-13). The owner removes the entries, or sets `node.layer: 2` after the upgrade and adds the nodes with `factory node add-child` |
| `.factory/protocol.md` (block `protocol`) | `.factory/roles/worker.md` (block `worker`) |
| `.factory/briefs/` | `.factory/orders/` (the folder of the assignments) |
| `.factory/board.json`, `waiting.json` | kept in place: they are the files of the `local` board |

### 4.6 Claude Code integration

- **The main session is a Claude Code session (F-3).** Dean's note says "Codex"; the decision is that factory starts Claude Code. The config names one agent command for each node (`session.agent`), so another agent CLI can come later behind the board connector of §10. Only `claude` is built now.
- factory starts a worker with `/bin/sh -c <strip text> factory-launch env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<proxy base_url>] FACTORY_HOME=<home> FACTORY_SESSION=<id> FACTORY_INBOX=<home>/.factory/workers/<id>/inbox <session.agent> --permission-mode auto --effort <e> [--model <m>] [--resume <session id>] --name <node id>-<id> --add-dir <home>/.factory/workers/<id>/inbox`, in the work copy of the worker. `<session.agent>` is `claude`, and the config key `session.agent` is the only source of the program name: no other code names a program to start. The worker gets one `--add-dir`, its assignment folder (the folder `inbox/`), and no project folder. The session name `<node id>-<id>` comes from `sessionNames` in `src/names.ts` (§4.12). The name is not a word of the pane binding (the pane rule, below), so a pane that an older version started without a name still binds. `--resume` is present only for a resume, and its id must be a UUID with lower case letters: the launch refuses any other text.
- factory starts the coordinator the same way in the coordinator folder, with `FACTORY_HOME` and `FACTORY_SESSION` and no `FACTORY_INBOX`. It gets `--name <node id>` (after `--effort`, `--model` and `--resume`, before the first `--add-dir`), the state folder, `<home>/.factory`, and one `--add-dir` for each project path. A resume of the coordinator takes the same `--resume` rule.
- **Variables of a parent session.** Both starts remove every variable whose name starts with `CLAUDE` before the program starts, so the new session does not start as a child of the session that ran `factory`. This covers `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, the session id, the messaging socket and token, and any name that a later Claude Code adds. Five names stay, because they are settings of the user: `CLAUDE_CONFIG_DIR` (the folder of the settings and of the login) and the provider switches `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` and `CLAUDE_CODE_USE_MANTLE`. One list in `src/names.ts` holds them. The removal runs in the pane, in a shell that starts the pane and then runs `env`, because a new pane gets its environment from the tmux server and not from the process that runs `factory`. The shell text is fixed: it holds no value of the config or of the command line. It reads the names of the environment with `awk` and never a value, it prints nothing, and it runs `unset` only for a name of letters, digits and underscores. Every other word of the start reaches `env` as one word that no shell reads again. If the shell text fails, the session does not start. Only `CLAUDE_CODE_CHILD_SESSION` is proven to matter: a session that starts with it saves no transcript, so `--resume` fails later (`docs/session-stop.md`). The identity of the parent session and its messaging socket and token must not pass to a worker.
- **Proxy.** A session uses a proxy only when the config names one: the override of the worker in `workers.<id>.proxy`, else `session.proxy` of the node. The launch always clears a stray `ANTHROPIC_BASE_URL` from the shell, then sets it only from the config. So a proxy is always a choice that the config shows, never an accident of the shell.
- **Proxy check.** Before each launch, factory sends one bounded request to the proxy's `health` path. If the proxy does not answer, `on_fail` decides:
  - `stop` (the default): factory does not start the session. It prints the proxy id, the failed check and the fix, for example "start the proxy, or set `proxy: none` for this worker".
  - `direct`: factory starts the session with no proxy and records this in the worker state, so the views show it.
  This rule comes from a workspace lesson of 2026-10-16: a dead local proxy stopped all workers for hours. The check stops that failure before it starts.
- **Proxy presets (D-45).** The devflow setup has the preset for Subswitch. The health path is `/__subswitch/health`, and the default port is 4141 (`subswitch serve --port N` changes it). The preset gives `base_url: http://127.0.0.1:<port>` with that port. So the owner changes one number. FAC-M6 tests the preset against a stub server. FAC-M7 runs one worker of this workspace through the real Subswitch.
- `factory doctor` and `factory status` run the same check for each configured proxy. `doctor` sends it when the config passes the registration check (§4.3), also when it comes from a parent folder, from `FACTORY_HOME` or from the factory list. A config that fails the check stops `doctor` with exit 4 before any request, with the reason and the remedy command. The proxy host receives the API traffic of the coordinator, so from FAC-M5 `doctor` warns when a proxy host is not loopback (`127.0.0.1`, `::1` or `localhost`). `doctor` prints `Config: <path>` first, to show which config it uses. `factory worker list` and the workers view show a Proxy column for each worker: `direct`, the proxy id, or `<id> (down)`.
- **Restore and restart.** `worker resume`, `restart`, `reboot` and the restore after a machine restart (§4.11) use the same launch code, so they apply the same proxy rules and the same check.
- **Last-seen hook (decided, D-47).** `factory worker new` writes a hook into the `.claude/settings.local.json` of the work copy. `factory start` writes the same hook for the coordinator in the factory folder. Claude Code calls the hook on SessionStart, UserPromptSubmit (the start of each turn), Stop (the end of each turn), PreCompact, PreToolUse (before each tool call) and Notification (only for a permission prompt or an input dialog: the group has the matcher `permission_prompt|elicitation_dialog`), and the status line command calls it too. These six events are the events of the code. The target is the list of §4.11: FAC-M5b adds the events PostToolUse (after each tool call), StopFailure (a turn that ends on an API error), SubagentStart and SubagentStop, and adds `idle_prompt` to the matcher of `Notification`. The hook writes the event `Notification` only when the field `notification_type` of its input is on the matcher list; for any other type, or none, it writes nothing. The hook prints nothing and exits 0 for every event. The hook writes one line to the last-seen file, `<home>/.factory/state/heartbeat/<session>`: the session id, the event, the time, the context percent and the session marker (`session_marker`, the `FACTORY_SESSION` of the writer: the id of the node or the id of a worker). A writer whose marker differs from the marker of the stored line writes nothing, and a stored line with no marker never gets one. The context percent comes from the status line JSON that Claude Code passes, not from the screen text. The hook and the status line wrapper write at the same moments, so each write holds a lock file in the same folder, `<session>.lock`. Inside the lock the writer reads the line again, sets its own part and its own time, and writes the whole line. So a write never puts back older data. A writer waits at most 300 ms for the lock. If it does not get the lock, it writes nothing. That update is skipped, and the next event or refresh sets it again. A lock file older than 2 seconds is taken over. A lock file that is a link stops the write (exit 4). A last-seen line is a hint, not a proof. A process that has the session variables can write a line for any session id: the hook checks `FACTORY_HOME`, `FACTORY_SESSION` and that the id in its input is a UUID, and no more. `FACTORY_SESSION` passes when it is the id of the node (the coordinator), or the id of a worker that has a valid record in the registry (`.factory/workers/<id>/worker.json`, §4.6). A missing, invalid or linked record, and an id that is not a slug, give no write. The id of the node never reads the registry. So a reader must not use a line as proof of which session it belongs to or of which session wrote it. A resume uses the id of a line only under the id rule of §4.11. The file is named by the session id, and a worker gets a new session id after a clear. So the hook of a worker also writes a pointer after the line: `<home>/.factory/workers/<id>/last-session` holds the id of the newest session of that worker, and nothing else. It is replaced as a whole, with the same link rules as the line, and a failed write of the line writes no pointer. A reader finds the line of a worker from the worker id in two steps: it reads the pointer, then the line of that session. A missing or invalid pointer, a missing line, or a line that is not valid gives no state: the reader reports unknown. The pointer is a hint under the same limit as the line. The hook of the coordinator writes the same kind of pointer, `<home>/.factory/state/coordinator-last-session`, with the same code and the same link rules, after it writes the line. A reader takes the id from it only when the line records the id of the node as its session marker: a line of a worker, a line of another node and a line with no marker are not owned.
- **The status line is a user setting.** An entry in `settings.local.json` replaces the status line of the owner in that work copy. So factory writes only a wrapper, `factory hook statusline`. It records the percent from the JSON on its stdin, runs the command named in `session.statusline` with `/bin/sh -c`, the same stdin text and a time limit of 2 seconds, in its own process group with no controlling terminal (at the limit, every process that the command started stops, also the parts of a pipe or a list), and prints the output of that command unchanged, with no added new line. While it runs, a SIGTERM, SIGHUP or SIGINT stops that group too, and the wrapper then ends as usual with exit 0. Known limit: a SIGKILL of the wrapper can not be caught, so it leaves the command group of the owner running. With no `session.statusline`, or when the command exits with a code other than 0, does not end in time or does not start, it prints one short line, `context N%`. N is the percent, rounded to a whole number. When the input gives no percent, or is not whole after 2 seconds (a pipe that stays open and sends nothing), the line is `context ?%`. The wrapper always exits 0 and prints at most one line on stderr. A pipe that Claude Code closes early (an EPIPE error on stdout or stderr) does not change the exit code; the hook events handle it in the same way. It writes the percent, reads the config and runs the command only for a session that passes the guards of the hook: `FACTORY_HOME` set and registered, `FACTORY_SESSION` equal to the id of the node or to the id of a worker in the registry, and (for the write) a session id in the input that is a UUID. Outside a factory session it prints the line and touches no file. A failed write never changes the output or the exit code. factory never reads the settings of the owner to find the command (§6), so the owner names it in the config.
- **Consent for every settings write.** factory never edits user-level Claude Code settings. Before it writes the hook or the status line wrapper, the command (`init`, `start` or `worker new`) prints the exact change and the target file. The target is local scope only: `.claude/settings.local.json` in the factory folder or the work copy. The write needs a yes in a terminal window, or `--yes`. With no terminal window and no `--yes`, the command writes nothing, prints the change, and exits 2. The remedy is to run `factory init`, `factory start` or `factory worker new` in a terminal window, or to add `--yes` (§4.3, "Stops and warnings"). The remedy offers `--yes` only when `--yes` would count: outside a factory session, or for a work copy that has no settings file. Inside a factory session, `--yes` gives no consent, so the remedy is to run the command outside the session, or in a terminal window without `--yes`. This refusal reads only `FACTORY_SESSION`, which the session controls, so a process in the session can remove it. The refusal stops an accidental consent. It is not a security boundary. The write makes no file system call on the user settings folder of Claude Code. It compares the written path of the target with that folder before any call on the target, and then the real path of the target, as text. The person may answer after the file changed, because Claude Code saves its permission rules in the same file. So after the answer the command reads the file again, once. If the text is the same, or if the new text gives the same change lines that the person saw, it writes the change on the new text and keeps what the other program saved. Else it writes nothing, exits 1 and names the command to run again. A status line command keeps working when the owner names it in `session.statusline`, because the wrapper passes its output through.
- **Status line fields.** The hook payloads hold no percent. The status line JSON holds these fields:
  - The field names come from the devflow HUD, which reads the live payload; checked against the Claude Code status line docs. The wrapper reads these fields and `session_id`, and no other (it never reads `transcript_path`).
  - The context percent is `context_window.used_percentage`. If it is null, absent or not a number, and `context_window.current_usage` is an object, the percent is the sum of its `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`, divided by `context_window.context_window_size` and multiplied by 100. The sum counts only when all three counts are numbers and the size is above 0. If neither gives a number, there is no percent. The wrapper then writes nothing and stores no percent. It rounds the percent to a whole number. A percent outside 0-100 is no percent either: the wrapper writes nothing and prints one line on stderr.
  - Both sources can be null early in a session. `current_usage` is null again after a compact, until the next API call.
  - The quota fields are `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage`. They exist only for claude.ai subscribers, and only after the first API response. Each window can be absent. Absent means unknown.
  - The cost field is `cost.total_cost_usd`. It is an estimate at list price.
- **The record rule.** The record of a worker names its project, its work copy and its branch, and the last two are derived: the work copy is `<home>/work-copies/<project>/<id>` and the branch is `worker/<id>`. The work copy is the working folder of an auto-mode session, which is the main permission scope of that session, and a program with write access to the state folder (the coordinator has it) can change the file. So a reader compares the written path with the derived path, as text. A path with a dot-dot part, a path in another folder (the home of the user, the factory folder, the coordinator folder, a clone) and a path of another worker never pass. A record that differs is not valid. `worker list` names that worker in a warning and in `invalid` of the JSON, and lists the other workers. The hook writes nothing for it, like for any other invalid record. `worker stop`, `worker resume` and `worker summon` stop with exit 4 and name the record file and what differs. `launchWorker` checks the folder again before it starts a pane: it must be exactly that folder, and no part of its path from `work-copies/` down may be a link (exit 4). The compare is on text, so a command must name the factory folder as `worker new` did: a record that was written under another spelling of the folder, for example through a link, is refused.
- **The pane rule.** The pane option `@worker` is text that a program in any pane can set on any pane, and a program can remove its own mark. So the mark alone binds no pane to a worker, and a command that sends a signal or closes a pane (`worker stop`, `worker summon`, `worker resume` and the later commands that call `stopWorker`) or types into a pane (`worker reset` and `self reset`, which also bind the coordinator pane by its launch words `FACTORY_HOME=<home>`, `FACTORY_SESSION=<node id>` and `--add-dir <state folder>`) acts only on a pane that a fact outside the control of the pane program binds to that worker. That fact is the start command of the pane: tmux fixes it when it makes the pane (`split-window` in the launch), and no program in the pane can change it. It holds the words of the launch of this worker: the variables `FACTORY_HOME=<home>`, `FACTORY_SESSION=<id>` and `FACTORY_INBOX=<inbox>` as whole words, and `--add-dir <inbox>` (`workerLaunchMarks` in `src/launch/argv.ts` gives the words to the launch and to the check, so they cannot differ). The check reads the start command as words, with the quoting that tmux writes, and the words must be whole words: the same text inside one quoted word does not pass. One `display-message -p -t <pane>` call prints the pane id, the pid, the end flag, four flags that tmux computes itself and the start command, last (`paneBindArgs` and `parsePaneBind` in `src/launch/tmux.ts`). The four flags are: the pane carries the mark of this worker, the pane has the node mark (`@node`, the coordinator pane), the pane has the board mark (`@slot=board`), and the pane is in the window `view`. tmux compares the marks, so the command never reads the text of a mark that a program wrote. A pane passes (`requireBoundPane` in `src/workers/panes.ts`) only when it has the mark of the worker, has no node mark and no board mark, and has the start command of this worker. A pane that carries the mark and fails a check is exit 4, and the remedy names the tmux command that clears the mark and the command to run again. A pane of the window `view` passes only when the summon mark of the board pane names it, because only a summon puts a pane of a worker in that window; any other pane of a worker in the window `view` is exit 4, and so is a summon mark that factory did not write. The limit: `respawn-pane -k` is the one tmux command that changes the start command of a pane. It ends the process of the pane first, so it can not re-label a pane and keep the process that runs in it. A program that runs `respawn-pane` can still give a pane the launch words, and then the rule accepts that pane. The process of such a pane is the process that the program chose, so a stop of that pane ends only what the program started.
- **Settings in work copies.** Before a worker starts in a work copy, factory checks the Claude Code settings files of that work copy for a setting that skips permission prompts. If it finds one, the start exits 4 with one remedy line (§4.3, "Stops and warnings"). The check runs for every start of a worker, also for `restart` and `reboot`.
- **`worker new <id> --project P [--yes]`.** The command makes one worker. It runs the same checks as `start` first (the tools, the safety block, the instruction-file warning), and it needs the tmux session of the node. With no session it exits 3 and names `factory start`. Before it writes anything, it checks that the project is listed and that the id is a slug, is not the node id, has no record, has no work copy folder and has no branch `worker/<id>` in the clone (exit 2). It checks that `work-copies/` and `work-copies/<project>/` are not a link or a file (exit 4). A safety block that is out of date gives a warning, and the next `start` renders it: `worker new` and `worker resume` never render it. Then it reads the settings files that the last commit of the clone tracks in `.claude/`, because the new branch starts at that commit and git puts those files into the work copy. These checks come before the work copy exists, so a stop leaves no work copy, no branch and no record: a tracked `.claude` that is a link or a file, a tracked settings file that is a link, is larger than the check reads or fails the settings check (exit 4), and a tracked `.claude/settings.local.json` that is not a JSON object (exit 1). The consent rule (above) is applied to the text of that file, so `--yes` inside a factory session, which gives no consent for a work copy that gets a settings file from git, is exit 2 before the first write. Then it does these steps in order:
  1. `git worktree add -b worker/<id> work-copies/<project>/<id>` in the clone of the project. The new branch starts at the head of the clone.
  2. It writes the record of the worker, before the launch, so the hook of the session can write its last-seen line (§4.6, "Last-seen hook").
  3. It adds the entry `/.claude/settings.local.json` to `info/exclude` in the common git folder of the clone, once. The file is shared by all work copies of the clone, so a work copy that holds only the hook settings counts as clean (§4.11, "Pushed"). It keeps every other line. It writes the file under a lock file with an atomic rename, and it refuses a link at the folder or at the file.
  4. It writes the hook settings file of the work copy. With a terminal window and no `--yes`, the question comes here, after the work copy and the record exist.
  5. It prints the warning about the machine, the same check as `factory machine`. The warning never stops the command.
  6. It launches the worker (above), in a new pane of the `workers` window, and it marks the pane `@worker`. Then it tiles the window (`select-layout tiled`, the call of `layout`). Every launch of a worker does this, in `launchWorker` (`worker new`, `worker resume` and the later commands that start a worker): a split halves one pane, and a window that is never tiled has no room for the sixth to eighth pane (`no space for new pane`). A tile that fails is a warning that names `factory layout`, and the worker runs. A split that fails is exit 1, and its remedy names `factory layout` first and then `factory worker resume <id>`. After the tile, the launch checks the pane (`confirmLaunch` in `src/workers/confirm.ts`): it waits `launchConfirm.intervalMs` (1 s) and reads the pane by its id (`readPaneLife` in `src/workers/panes.ts`, one `display-message` call and `startsWorker`). A new worker needs this one check only. A pane that is gone (tmux removes the pane of a program that ends in the window `workers`), that ended, or that no longer holds the launch words of the worker is exit 1 and names the pane. The wait for a launch with a session to resume is longer (see `worker resume`, step 6).

  A failure after step 1 keeps what exists and undoes nothing. The message names the steps that remove the worker by hand, with the paths shell-quoted: `git -C <clone> worktree remove <work copy>`, then `git -C <clone> branch -D worker/<id>`, then the removal of the folder `.factory/workers/<id>`. For a failure of step 3 or 4, it also says that `factory worker resume <id>` starts the worker, but does not make the exclude entry or the hook settings. A failed `git worktree add` can leave the branch, and after a failed `post-checkout` hook also the work copy: the message names the two git commands, so that `worker new` with the same id can run again. A failed record write leaves the work copy and the branch with no record. If only the inbox folder fails, the record stays, and the message is the one for a kept worker. The message also names `factory dismiss <id>` (§4.11), which frees the worker once its branch is pushed; a branch with a commit that no remote branch holds stops `dismiss`, so the steps by hand are the way for it. The output is two short lines (three with `--assignment`), or the object `factory.worker-new/v1` with `--json`, which has the field `assignment` (the path of the copy, or `null`).
- **`worker new <id> --project P --assignment FILE`.** The flag copies one task file to `assignment.md` in the assignment folder of the new worker, before the launch. `readAssignment` in `src/workers/assignment.ts` checks the file and writes nothing, and every check comes before the first write of `worker new`:
  - The real path of the file is inside the factory folder, or inside the git work tree of the working folder of the caller. Else it is exit 4.
  - No folder on the path from that root down to the file is a link, and the file is not a link (exit 4).
  - No part of the path below the root starts with a dot, except the folder `.factory/orders/` below the factory folder, and the file is not `factory.local.yaml` at the top of the factory folder (exit 4). The remedy is to copy the task into `.factory/orders/` or into the work tree.
  - The file is a regular file (a FIFO or a device is exit 2), at most 1 MiB, valid UTF-8, and holds no NUL byte (exit 2).
  - The command reads the text once. After the read it runs `lstat` and `realpath` again, and a change is exit 4. It copies that same text and never reads the file again.
  - The copy goes in with `writeInFolder`, after the record exists. A failed copy is exit 1 (a link in the folder stays exit 4). The worker is kept and not launched. The remedy names the copy by hand to `<assignment folder>/assignment.md`, then `factory worker resume <id>`.
  - Every other `worker` command refuses `--assignment` with exit 2.
- **`worker list [--home DIR]`.** The command reads and changes nothing. It reads the registry, makes one `list-panes` call for the tmux session of the node, and reads the last-seen line of each worker through its pointer (above). The output is one line for each worker, with the columns `ID`, `PROJECT`, `PANE`, `STATE`, `CONTEXT` and `MARK`, or the object `factory.worker-list/v1` with `--json`. The table comes from the same builder as `status` (§4.11). `worker list` shows no work item and asks no board.
  - `PANE` is the id of the pane that carries the mark `@worker` of the worker, `dead` for a pane whose program has ended, and `none` for a worker with no pane. A pane with a mark that is not a worker id counts as a pane with no worker, so one strange mark never fails the list. If more than one pane has the mark of one worker, the list shows the first live pane and warns with every pane id. When no tmux session of this node runs, every pane is `none` and the exit code is 0. A session of the same name that belongs to another factory folder is a stop (exit 4), as for `worker new`.
  - `STATE` comes from the last hook event. The target is one word of the live board (§4.11): Working, Idle, Stopped, Stalled, Parked or On hold. `worker list` asks no board, so it shows the word alone. A hold word replaces the word of the event. A worker with no valid line that belongs to it, or a line with no event, shows its hold word, else `—`.
  - The code shows other words until FAC-M5b changes them: `SessionStart` and `Stop` give `at prompt`, `UserPromptSubmit`, `PreCompact` and `PreToolUse` give `busy`, and `Notification` gives `waits` (a dialog waits for an answer). A worker with no valid line is `unknown`. FAC-M5b makes `at prompt` the word Idle, and `busy` and `waits` the word Working. The checks below (`worker stop`, `worker reset`, `worker watch`, `dismiss` and `self reset`) keep the names `at prompt`, `busy` and `waits` for what the last event says. `worker stop` treats `waits` as the busy case, and `dismiss` refuses a worker that waits (exit 1).
  - `CONTEXT` is the percent of the line, or `?` for none. `MARK` is `PREPARE` from `limits.context_prepare_pct` up to `limits.context_max_pct`, and `MAX` above `limits.context_max_pct`. With the limits 30 and 40, a percent of 29 has no mark, 30 and 40 give `PREPARE`, and 41 gives `MAX`. An unknown percent has no mark.
  - A folder of the workers folder that holds no valid record is named in a warning (and in `invalid` of the JSON), and the other workers are listed. The Proxy column of the proxy checks (above) is not part of the list yet.
  - `worker list` reads the state of a worker from the pointer and the line under the ownership check of `worker stop` and `worker resume` (below, `readOwnLastSeen`), so it never shows a state where `stop` says that the state is unknown. A line with no marker, a line of another session, and a session that the pointer of another worker names are `unknown`, with no percent. A fault of the file system on any pointer gives `unknown` and a warning, because the check reads the pointers of the other workers.
- **`worker stop <id> [--home DIR]`.** The command ends the program of the pane of one worker and closes the pane. The id must have a valid record (exit 2). A record that fails the record rule (above) is exit 4. `stopWorker` in `src/workers/stop.ts` is the code that `shutdown`, `restart`, `reboot` and `dismiss` call for each worker. A caller that stops more than one worker gives it the list of the panes that it read once (`panes`). Then step 1 makes no session check and no list call of its own. In order:
  1. One `list-panes` call finds the panes with the mark `@worker` of the worker. Each of them is read by its id and must pass the pane rule (above, `readWorkerPanes` in `src/workers/slot.ts`). A pane that carries the mark and fails the rule, the coordinator pane and the board pane included, is exit 4, and the command sends nothing to it. This check comes before the count: a forged mark on another pane is never taken for a second pane of the worker. Then two live panes of the worker are exit 2. A worker with no pane gives exit 0, changes nothing and says so. A pane whose program ended is closed by its id, and no signal is sent.
  2. If the pane is the pane of the caller (`TMUX_PANE`), the command exits 2 and sends nothing. It never ends its own pane.
  3. The state of the session comes from the last-seen line, under the ownership check of `worker resume` (below). The case is idle for the events `SessionStart` and `Stop`, and busy for `UserPromptSubmit`, `PreCompact`, `PreToolUse` and `Notification` (a session that waits in a dialog is the busy case). A state that is not known (no line, no event, or a line that does not belong to the worker) is exit 3. The message names the pane and the process, and the remedy names the signal that the person can send by hand. Nothing is sent. A caller can limit the cases (`allowed`): a case outside the limit is exit 1 and nothing is sent. `dismiss` allows only the idle case. `worker stop`, `shutdown`, `restart` and `reboot` allow both.
  4. The command reads that one pane again by its id (`display-message -p -t <pane>`), right before the signal, and the pane must pass the pane rule again. The pane id and the pid come from this read. A read that fails the rule, or that does not give the one line of this pane, is exit 4 and sends nothing. A mark that a program set can never pass for the line of another pane, because tmux compares the mark and the command prints only a flag.
  5. The way of the case ends the process. The ways are named constants in `src/names.ts` (`stopWays`, with `stopFallback` for a case that has no safe way), and a test checks that they equal the safe way of the table in `docs/session-stop.md`. Both cases use `kill -TERM`. The command never sends `KILL`. It polls for the end of the process, at most `stopPoll.attempts` times at the interval `stopPoll.intervalMs`. A process that is still there is exit 1 that names the pid.
  6. The command closes the pane by its id. tmux never reuses a pane id, so the id names this pane and no other. A pane that tmux removed when the process ended counts as closed. When a summon put the pane in the slot of the window `view` (the summon mark of the board pane names it), the pane goes back to the window `workers` and the board comes back into the slot before the close (`closeWorkerPane` in `src/workers/slot.ts`). A pane closed in the slot would leave the window `view` with no slot, and no command could bring the board back. Slot marks that factory did not write change nothing here: the stop goes on, and `layout` names the fault.
- **`worker resume <id> [--home DIR]`.** The command starts a stopped worker again, in a new pane, in its work copy. In order:
  1. It runs the root checks of `worker new` (the tools, the safety block, the settings files). A stop is exit 4, and nothing changes. A tmux session of the node that does not run is exit 3 and names `factory start`.
  2. The id must have a valid record (exit 2), and the record must pass the record rule (above, exit 4). Each pane that carries the mark of the worker is read and must pass the pane rule (above), live or ended: a pane that fails it is exit 4, and it is never taken for the pane of the worker that runs. A live pane of the worker that passes the rule is exit 2: the worker runs already, and the remedy names `worker stop`.
  3. It chooses the session to resume. A program in a worker pane can write the pointer to its own last session, so the pointer counts only when all of these hold: the id in the line is a UUID, the line records the id of this worker as its session marker (`session_marker`), and no other worker has a pointer that names the same session. The hook of a worker writes its own id as the marker. The hook of the coordinator writes the id of the node, or no marker, so the session of the coordinator and the session of another worker never pass. A line with no marker, which an older hook wrote, is never resumed.
  4. If the choice passes, the launch has `--resume <id>`. Else the launch has no `--resume`, and the command prints one warning that says that the earlier conversation is NOT resumed, why (no valid last-seen line, or a line that does not belong to this worker), and that a new conversation starts.
  5. A pane of the worker whose program ended is closed by its id, after the board comes back into the slot when a summon left that pane there (as in step 6 of `worker stop`). Then the launch runs the same path as `worker new` (`launchWorker`), which checks the settings files of the work copy and the proxy.
  6. When the launch has `--resume`, the command says "Resumed" only after the new session proves itself (`confirmLaunch`). It waits `launchConfirm.intervalMs` (1 s) before each check and checks at most `launchConfirm.attempts` (10) times, so the wait is at most 10 s. A check passes when both hold:
     - the pane, read by its id, is alive and its start command still holds the launch words of the worker (`readPaneLife`, which reuses `startsWorker`);
     - the last-seen line of the worker, read through the pointer under the ownership check of step 3 (`readOwnLastSeen`), has the event `SessionStart`, a time after the moment before the pane was made, and the session marker of this worker. A line that is not valid, a line with another marker, an older time or another event counts as not confirmed.

     The outcomes are these. A check that passes prints "Resumed". A pane that is gone, ended or changed is exit 1 and prints "resume failed" with the pane id. Its remedy names the usual cause, a pointer to a session with no transcript, and the manual step that starts a new conversation: delete the file `.factory/workers/<id>/last-session` (the message gives the full path), then run `factory worker resume <id>`. No command deletes the pointer. A pane that runs but shows no line within the bound is exit 3, a check verdict like the unknown state of `worker stop`: the message starts with "resume not confirmed", names the pane, and the remedy names `factory worker summon <id>` to look at the pane, then `factory worker stop <id>`, the same delete and `factory worker resume <id>`. It never prints "Resumed" then. Nothing is closed or undone: the pane stays. A launch with no `--resume` (a worker with no valid pointer) checks the pane once, as `worker new` does. Neither check names a setting or a value of the environment.
  - The marker stops a program in a pane from naming the session of the coordinator or of another worker. It does not stop a program that has the session variables and write access to the folder of the last-seen files: that program can write a line for its own worker, and the line is a hint (above).
- **`worker summon <id> [--for TIME] [--home DIR]`.** The command shows the pane of one worker in the slot of the window `view`. `TIME` is `<n>m` or `<n>h`. The default is 15m, the least is 1m and the most is 2h, as named constants (`summonLimits` in `src/names.ts`), and the reader is the one that the config uses for its durations. A time outside the bounds is exit 2. `summonWorker` in `src/workers/slot.ts` does the work. In order:
  1. The id must have a valid record (exit 2), and the record must pass the record rule (above, exit 4). The tmux session of the node must run (exit 3, names `factory start`) and carry the `@factory_home` of this folder (exit 4).
  2. Each pane that carries the mark `@worker` of the worker is read and must pass the pane rule (above): a pane that fails it is exit 4, and no pane moves. Then the worker must have one live pane: none is exit 3 and names `worker resume`, two are exit 2.
  3. One `list-panes` call reads the slot marks of the session (`#{pane_id}|#{@slot}|#{@slot_summon}|#{window_name}`). The parser is strict: a line that does not parse, or a pane id that twice appears, refuses the list. More than one pane with `@slot=board`, or a summon mark that factory did not write, is exit 4.
  4. The pane that holds the slot is the board pane, or the pane that the summon mark names when an earlier summon is still active. The pane of the worker is swapped with the holder (`swap-pane -d -s <worker> -t <holder>`), so a second summon puts the first worker back in its own place. The flag `-d` keeps the focus: every swap of the slot (this one, the timer, `layout` and the release before `worker stop`) leaves the active pane of the window `view` as it was. Without `-d`, tmux gives the focus to the pane that came into the window, and the keys of the person would go to a worker, or to the board, at a time that the person did not choose. A worker that holds the slot already is not swapped: the command only gives a new token and a new timer.
  5. A new token (`deps.randomHex`, 16 random bytes, 32 lower-case hex characters) goes into the pane option `@slot_summon` of the board pane, as `<worker pane>:<token>`. The option travels with the board pane when it moves to the window `workers`. If tmux does not set the option, the swap is undone.
  6. One `run-shell -b` timer starts: `sleep N; tmux if-shell -F -t <board> '##{==:##{@slot_summon},<worker pane>:<token>}' 'swap-pane -d -s <worker pane> -t <board> ; set-option -p -u -t <board> @slot_summon'; true`. The text ends with `; true`: a tmux call that fails at the end of the wait (the worker pane or the board pane is gone) would make the shell exit with 1, and `run-shell` shows such an exit code as an error screen in the current pane, which can be a pane that the person uses. With `; true` the shell exits with 0 and the failed call changes nothing: the summon mark stays, and `layout` clears it. `run-shell` expands the formats of its text when it starts, so each `#` of the condition is written as `##`: the shell gets `#{==:...}`, and `if-shell` compares the mark of the board pane at the end of the wait. The builder checks that the wait is a whole number from 1 to 7200, that the ids are pane ids and that the token is hex, and then checks the whole text against a list of allowed characters. So the text holds only fixed words, digits, the token and pane ids. A newer summon replaces the token, so the timer of an older summon finds another token and does nothing. If the timer does not start, the worker stays in the slot, and the message names `factory layout`.
  - The output is two short lines, or the object `factory.worker-summon/v1` with `--json` (`id`, `pane`, `board`, `minutes`, `until`, `swapped`).
- **`layout [--home DIR]`.** The command makes the windows of the tmux session of the node again, as far as it can, and writes no file. The session must run (exit 3) and belong to this folder (exit 4). In order: a missing window `workers` is made, in the folder of the coordinator. Its panes are tiled (`select-layout tiled`). A summoned pane is swapped back with the board pane, and the summon mark is unset (`restoreSlot`: swap first, then unset, so a failed swap keeps the mark). A mark that names a pane that is gone, or a pane that is not in the window `view`, is only cleared, with a warning, and no pane moves. A board pane that is still outside the window `view` after that step (the cleared mark case, and the case of no mark at all, for example after a move by hand) gets a second warning that names the command that joins it back, with the real pane ids: `tmux join-pane -d -h -s <board pane> -t <first pane of the window view>`. `layout` never runs this command itself, because a person can have moved the board on purpose. A session with no pane in the window `view` gets no such hint, because the command has no pane to join to. The window `view` holds the coordinator, so `start` makes it and `layout` never does: a session with no window `view` gets a warning that names `factory start`. The output is three short lines at most, or the object `factory.layout/v1` with `--json`.
- **Session reset: `worker reset <id> (--clear | --compact) [--home DIR]`.** The command types `/clear` or `/compact` into the pane of one worker, and checks that it happened. It runs only from the coordinator pane. The caller rule runs first and makes no tmux call in its env part: `TMUX_PANE` must be a pane id and `FACTORY_SESSION` must be the node id (else exit 2); a missing session is exit 3 (`factory start`) and a session of another home is exit 4; the coordinator pane must exist and be alive (exit 3), must hold the coordinator launch words (`FACTORY_HOME=<home>`, `FACTORY_SESSION=<node id>`, `--add-dir <state folder>`; exit 4), and must be the pane of the caller (exit 2). The command refuses each case below with its exit code, before it sends any key:

  | # | Case | Exit | Remedy |
  |---|---|---|---|
  | 1 | neither or both of `--clear` and `--compact` | 2 | |
  | 2 | the caller env part of the caller rule | 2 | |
  | 3 | no session / a session of another home | 3 / 4 | `factory start` |
  | 4 | no or a dead coordinator pane / a start command that does not match / the caller pane is not the coordinator pane | 3 / 4 / 2 | `factory start` for 3 |
  | 5 | an unknown worker or an invalid record / a record that factory did not write | 2 / 4 | as `worker stop` |
  | 6 | two live panes of the worker | 2 | |
  | 7 | no live pane, or a pane that ended | 3 | `factory worker resume <id>` |
  | 8 | the pane is in the slot of the window `view` (a summon) | 3 | wait for the end of the summon, or `factory layout` |
  | 9 | the start time of the pane process is not readable (`ps` fails, runs too long, gives no output or text that does not parse) | 3 | |
  | 10 | the hook settings of the work copy lack an event | 3 | `factory upgrade`, then `factory restart <id>` |
  | 11 | the settings file is newer than the start of the pane process | 3 | `factory restart <id>` |
  | 12 | work that is not pushed, or a fetch that fails | 1 | with the reasons |
  | 13 | `$FACTORY_INBOX/resume.md` is missing / is a link / is empty or over 1 MiB | 3 / 4 / 3 | names the file |
  | 14 | the pane fails the bind right before the keys / the pid changed | 4 / 3 | |
  | 15 | the last-seen line is not owned, or has no event | 3 | |
  | 16 | the state is `busy` or `waits` | 1 | wait until the worker waits at its prompt |
  | 17 | the time of the line is not strictly later than the start of the pane process | 3 | |
  | 18 | the pane is in a mode of tmux, or the capture shows a numbered option list (§4.12) | 3 | press `q` in the pane / look at the pane, then run the command again |

  The last-seen line is read after the bind (row 14), and the capture is the last read before the keys. After the checks, the reset types `C-u`, the literal command and `Enter` in one tmux run through `src/comms/`. It then confirms with at most 10 checks, 1 s apart (`resetConfirm`, `src/workers/confirm.ts`). For `--clear`, the pointer must name a new session and its line must have `SessionStart` after the typing time. For `--compact`, the line must have `PreCompact` or `SessionStart` after the typing time. Each check reads the pane life, and a pane that ends in the confirm is exit 1. With no confirmation the exit is 3 and the remedy is to look at the pane, then run the command again. The output is a verdict line, the age of the resume file, and the next step: send the next task with `SendMessage` (if the worker has no name after a clear, run `factory restart <id>` first). `--json` gives `factory.worker-reset/v1`. `assignment.md` and `resume.md` stay in the assignment folder after `--clear` and after `restart`. The limits:
  - A last-seen line is a hint: a process with the session variables can write a false line. The reset adds the start-time check and the refusal rule of §4.12. It does not make the hint a proof.
  - The checks of `TMUX_PANE` and `FACTORY_SESSION` read values that the caller sets. So they are a guard against a mistake, not a security boundary.
  - `Notification` fires about 6 s after a dialog opens. `PreToolUse` fires before every tool call, so the state is `busy` before the dialog opens.
  - The pane process start comes from `ps` in whole seconds. The line check requires a line strictly later than that start. The settings check accepts a window of about 1 s, because it protects the upgrade change; the line check and the capture stay as gates.
  - Claude Code writes `.claude/settings.local.json` when it saves a permission rule. After such a save, the reset refuses until `factory restart <id>`.
- **Self reset: `self reset [--home DIR]`.** The command queues a `/compact` for the coordinator itself. It applies the caller rule above and has no idle gate: the states `busy` and `at prompt` pass. In order: the coordinator settings must hold all the hook events: the 6 above, and the 4 that FAC-M5b adds (else exit 3; run `factory upgrade`, then `factory reboot`). The own last-seen line (`readOwnCoordinatorSession`) must be valid, owned and have an event, and its state must not be `waits` (else exit 3: a dialog waits in the coordinator pane; answer it, then run the command again). The file `.factory/resume/<node id>.md` must exist (else exit 3, and the message names the file), must not be a link (exit 4), and must not be empty or too big (exit 3); the folder is checked too. The command binds the pane again (same pid) and types `/compact` with no hint through `src/comms/`, and the capture rule of §4.12 applies. It exits 0 with `QUEUED: the compact runs after the current turn`. `--json` gives `factory.self-reset/v1`. The command does not wait: the compact runs after the current turn.
- **`worker watch [<id>...] [--home DIR]`.** The command watches every recorded worker, or the workers that it names, and it never types, signals or writes. A worker with no pane at the start is not a change and is not checked; when no worker has a pane, the command exits at once with `NO WORKER: no worker has a pane to watch`. It reads a baseline, and exits at once when the baseline shows a change for a checked worker. Then it checks at most 40 times, each after a wait of 30 s (`watchPoll`), so it ends after 20 minutes. It exits at the first change: a pane that ended, is gone, or is not the launch of the worker (the start-command bind); a last-seen line that turned invalid or is not owned (a missing line is not a change in the first 2 checks, the baseline included, so a new worker has time to write its first line; from the third check on, or once a valid line was seen, a missing line is a change; a line that is not owned is a change at once); the state `waits`; or `stalled?` (the state is `busy`, and the newer of the event time and the percent time is older than 15 minutes). A change from `busy` to `at prompt` is not a change: the idle notices of Claude Code show it. The output holds fixed words and worker ids only: `CHANGED: <id> <what>` for each change, `NO CHANGE: <ids>`, or `NO WORKER:`. The exit code is 0 for all three. No session is exit 3 (`factory start`), a session of another home is exit 4, a read fault is exit 1, an unknown or invalid worker id is exit 2, and a record that factory did not write is exit 4. `--json` gives `factory.worker-watch/v1`.
- **Fixtures from the real program.** FAC-M4 captures one payload for each hook event from the installed Claude Code. It commits them as test fixtures. The hook tests parse these fixtures. The first four hook payloads come from Claude Code 2.1.318 in print mode (`test/fixtures/claude/payloads.json`). The payloads of `Notification` and `PreToolUse` are built from the field names of the Claude Code hooks docs, with made-up values, and the fixture marks them as not captured (`captured: false`, with a docs source); an interactive capture replaces them. Print mode draws no status line, so the status line payload is built from the field names of the devflow HUD, which reads the live payload; checked against the Claude Code status line docs. The fixture marks it as not captured. The tests of the wrapper (`test/unit/statusline.test.ts`) parse it. An interactive capture replaces it.
- **No reads under `~/.claude`.** The last-seen file gives every fact that the scripts read under `~/.claude` today: the last activity (working, idle, stopped), the session id (to resume a worker after a restart) and the context percent. So no factory code and no role template reads or copies a file under `~/.claude`. The instruction "avoid reads under ~/.claude" is not necessary, and the templates do not contain it. A static test fails on any code path that opens a file there.

### 4.7 Language, platforms, install and distribution

- **TypeScript on Node 22+**, built to one bundled file (from mars: dev mode from source, one bundled file for a release). Zod for config and state schemas, Result types and no throws in the logic (Dean's engineering rules). Commands come from one command table, not from three hand lists (a mars gap).
- **Platforms: macOS and Linux only (F-5).** factory needs tmux, git and a POSIX shell. On native Windows, `factory doctor` refuses with the remedy line `Use WSL, then run "factory doctor" there`. Every other command refuses with a line of the same form that names that command.
- **External tools:** `tmux`, `git`, `claude`, and the CLI of the board tool (`gh` for GitHub). factory replaces `jq`, `python3` and `glow` with its own code, so a new machine needs fewer tools. `doctor` checks the versions. The minimum `git` version is 2.26, because the check of the state repo reads `git config --list --show-scope`. The check `tools` of `doctor` fails for a `git` older than 2.26, and when it can not read the `git` version. With an older `git`, each state step that reads that list stops with exit 1, and the message names `git` 2.26. `start` reads the `git` version and that list right after its tool check, before it makes or looks at a session. `reboot` outside the session reads them before its first stop (§4.11). `upgrade`, `init` and the board commit helper stop before they change the state repo. A dry run of `start` shows the problem as a warning.
- **Portable parts:** the heavy-test lock uses `lockf` on macOS and `flock` on Linux. `factory machine` reads memory and load on both systems. The owner's clipboard command is a config value with a platform default. CI runs the full suite on an Ubuntu and a macOS runner. Tests of `lock run` and `machine` run both system paths with fixtures.
- **Install:** `npm i -g @dean0x/factory`, or `npx @dean0x/factory init`, plus a Homebrew formula in `dean0x/homebrew-tap`. An `install.sh` for curl, with a SHA256 check (mars has none). The repo is private now (D-49), so none of these is public yet. FAC-M10 builds them.
- **Release:** one `v*` tag runs the tests, checks that the version is the same in every place, makes the GitHub Release, publishes to npm and updates the tap (from mars `release.yml`). The version lives in one file only. An early-access tag (`v*-ea.*`, D-49) is no release. The release trigger skips it (for example `tags: ['v*', '!v*-ea.*']`).
- **The publish is gated (D-45).** The publish job runs in a protected environment (`npm-publish`) whose required reviewer is the owner. The job starts with a gate script. The script fails unless `docs/release-approval.md` holds a line `Decision: D-<n>` and the tag version equals the version in `package.json`. So a tag alone never publishes. The repo stays private until the owner writes a decision id in `docs/release-approval.md`. FAC-M10 tests the workflow with a script and checks the environment with a read-only `gh api` call.

### 4.8 What factory takes from mars and from firstmate

From **mars**:
1. Walk up from the current folder to find the config, and one "require workspace" guard (`lib/config.sh:12-27`, `:128-134`).
2. Dev mode from source, one bundled file for release (`mars:16-31`, `build.sh`).
3. One tag fans out to GitHub Release, npm and the Homebrew tap (`.github/workflows/release.yml`).
4. An installer that is safe to run again, with env overrides and a final `--version` check (`install.sh`).
5. Output that knows if a terminal window is present, with an ASCII fallback, and spinners that do nothing on a pipe (`lib/ui.sh`).
6. Batch commands that continue after a failure and give a count at the end (`lib/commands/clone.sh:96-110`).
7. Black-box tests that run the real entry point in a temp folder (`test/test_integration.sh`).

factory avoids the mars gaps: a `version` field that is never read, no `--json`, only exit codes 0 and 1, `eval` of user input, and commands registered in three places.

From **firstmate** (github.com/kunchenguid/firstmate, MIT, read as untrusted data):
1. The code root and the private home are separate. The home is selected with one variable (`docs/configuration.md` L19–30).
2. A durable inbox plus a one-line doorbell, instead of long text typed into a pane (`bin/fm-send.sh`, `bin/fm-task-inbox-lib.sh`).
3. Node identity markers and a one-line registry entry for each child (`.agents/skills/secondmate-provisioning/SKILL.md` L16–40).
4. An explicit list of config items that a parent passes down, and items that it never passes (`bin/fm-config-inherit-lib.sh`).
5. A script-written upward channel, so a report does not depend on the model's memory (`docs/secondmate-parent-channel.md`).
6. Skipped for now (F-13: one machine only): a readiness check before the first use of a remote host (`docs/remote-secondmates.md`). factory keeps one part of it: a child folder that factory cannot read is "unknown", never "dead".
7. A fail-closed config parse (`docs/configuration.md` L1380–1382).
8. Upgrades by fast-forward only. A dirty home is reported and not touched (`bin/fm-update.sh`).

**Where each idea lands (D-55).** Dean accepted the analysis, so each idea has a milestone:
- Idea 1: FAC-M1 and FAC-M2 (`--home`, the walk up, the factory list of §4.3).
- Idea 2: FAC-M4, as native cross-session messages of Claude Code, session names and assignment files, instead of the doorbell inbox (D-101; §4.12).
- Idea 3: FAC-M8. The marker is `.factory/node.json`. `ping` returns the id and layer from it. `node tree` prints one line for each child from `children[]` with no folder scan. A folder whose marker names another id shows `mismatch` and receives nothing.
- Idea 4: FAC-M8. One constant lists the config items that a parent passes down (§5.5). A test shows that owner, accounts and session settings never pass.
- Idea 5: FAC-M5 (the report core, with events that scripts write at merge and decision), FAC-M5b (the release event) and FAC-M8 (the rollup over children).
- Idea 6: skipped (F-13).
- Idea 7: done in FAC-M1.
- Idea 8: FAC-M3. `state pull` and `upgrade` move the state repo by fast-forward only. A dirty `.factory/` is reported with the file names and not touched.

factory avoids these firstmate choices:
- Its workers skip permissions by default when no config file exists (`docs/configuration.md` L1370).
- Its config is scattered over many one-token files.
- It installs by `git clone`, with no versioned release and no migrations.
- It supports one person only, and it caps the hierarchy at two levels (`VISION.md` L7, L38).
- It supports many backends, and each one adds test and maintenance work.

### 4.9 Recipes: one core, the kind of factory comes from the recipe

The core is general. It knows nodes, layers and roles, sessions, the inbox and reports, the owner's decisions, the board, capacity and the state store. It uses git only to keep its own state (the `.factory/` repo) and the config repo of the factory folder. It knows nothing of PRs, CI or the git repos of projects (§4.13). A test recipe with no git and a document as output runs `init`, `start --dry-run`, `doctor` and `report`, and no core, config or comms file imports a recipe (FAC-M6).

A recipe gives the parts that depend on the kind of work:
- the role template of each layer (§5.2);
- the work cycle: the steps, their order, and the proof that each step ran;
- the checks before an output is final;
- the kind of output (a PR, a document, a data set);
- the board mapping: which item kinds, labels and states the recipe uses;
- the board data: the key of the queue, the list of stages of an item, and the stages that only a flow sets (§4.10). The core holds no stage word and no flow word;
- the approval points (§6);
- its own config block and commands.

```yaml
# recipes/software/recipe.yaml
id: software
version: 1
output: pull-request
roles:                       # one role template per layer, counted from the bottom
  0: roles/worker.md
  1: roles/coordinator.md
  2: roles/manager.md
  3: roles/director.md       # FAC-M8; a layer with no template gets a `doctor` warning (§5.2)
stages:
  plan:    { applies_to: any }
  build:   { applies_to: any }
  review:  { applies_to: code }
  fix:     { applies_to: code }
  release: {}
gate: [ci-green, base-merged, threads-resolved, evidence, head-pinned]
tracker:
  kinds:  { work: issue, decision: "issue+label:decision", request: "issue+label:request" }
  states: { next: Todo, progress: In Progress, done: Done }
variants: [plain, devflow]   # variants/plain.yaml (default), variants/devflow.yaml (§2.2)
```

**An example with no software: publish a post.** A marketing factory uses the same core. Its recipe names the work cycle "draft, check, publish". The output is a post, not a pull request. Its one approval point is `publish`, and the default mode is `owner`. A worker drafts one post for one track. The check of the recipe says `READY` when the post has its review notes. The post waits in the queue until the owner approves it. Then the coordinator publishes it. The commands `start`, `status`, `request`, `decide` and `dismiss`, and the board, work as they do for the software recipe. The core needs no word of the software recipe for this.

- A recipe is data plus prompt text. It runs no code, except the `install` and `detect` commands of a setup, and only after the user confirms them.
- factory comes with one recipe first: `software`. Its parts are the projects as git repos, the work copies, PRs, the merge check, CI and releases. The plain setup uses plain Claude Code. The devflow setup maps the steps of the work cycle to the devflow commands (§2.2).
- Other recipes, for example research or content, come later. They need no change to the core.
- Cost (F-10): medium now, high later. The split is mostly in this design and in the config schema. The FAC-M1 code already keeps the software parts in a few modules.

### 4.10 Board connector

factory does not build its own review desk. The board, the requests and the decisions live in the team's board tool. The owner chooses the tool in `tracker.kind`. The config key `tracker` stays.

**Two words, one part.** This design says **board connector** for the part of factory that talks to one board tool. Dean says "provider" for the same part.

**Owner view (TB-5, TB-6).** The review desk page of today is a supported owner view, and the owner can choose it. It is not part of the core. It reads the local files. In M5-1b the page only reads. A page answer that records through the owner store is a FAC-M5b criterion. factory always keeps the local board, with any board kind and any owner view. The local files are the source for the views. A log row in the decision log is a display copy and never a proof. Every string in the files is untrusted text.
- **The format promise.** The format of the local files is a promise to the page: the file names `board.json`, `waiting.json` and `decision-log.json`, their top keys, and the item keys `id`, `track` and `stage`. A rename of a key needs an upgrade note (§4.5). The unit tests of the `local` connector read a fixture board of this format.
- **The limit.** The page of this workspace reads a factory board only after FAC-M7. Until then it cannot read the files that factory writes.

**One board for many repos (F-19a).** Can one board show the work of many repos? Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Factory uses one project for all the repos of a factory. FAC-M3 runs the real commands on two repos before the board connector is built. Jira and Linear are a separate question. Not checked yet: FAC-M9.
- **The bound.** One list call reads one board. It uses `--limit <cap+1>`. If the board holds more than the cap, the output has a line "more than <cap>" and does not print the rest.
- **The filter.** The server filters the list (`--query`), also by repo. The reader does not filter the full list.
- **The owner rule.** The owner of the project must reach every repo that the factory lists. The board shows only the items of the listed repos.
- **The token scopes.** A read needs `read:project`. A write needs `project`.
- **The items of the factory itself.** With `local` they are in `.factory`. With `github` they are issues of the config repo.

**The choice of the board (F-2).** The user picks the board tool at setup, as in devflow. `init` asks "Which board?" in a terminal window (`local`, `artifact`, `github`) and takes `--tracker <id>`, `--items` and `--decisions`. `artifact` comes in FAC-M11 and `github` in FAC-M3. A board plugin is not an answer of `init`. The user installs the plugin, then runs `factory tracker set plugin:<package>` (§4.15). Jira and Linear are board plugins (FAC-M9). Later, `factory tracker set <id> [--project P]` changes it, and `factory tracker status` prints the board of each project and the result of the privacy check. `init` and `tracker set` check the decision store before they write anything. They exit 4 when the store is public, and the remedy is `factory tracker set <id> --decisions <private repo>` (§4.3, "Stops and warnings"). A node has one default board, and a project can override it (as devflow does: one machine can work on a Jira repo and a GitHub repo side by side). `item add --project P` goes to the board of P. The decision store is always the one of the node.

**One connector contract.** Every board connector speaks the contract `factory.board/v1` (§4.15). The contract has 14 operations, and `describe` and `check`:
- item: add, update, move (change the state or the stage), close, list, note;
- track: add, list, update;
- decision: ask (an item with the options, made by `request add --options`), read (the answers);
- doc: link (attach a file, or link a repo file), unlink;
- changes: read comments, label changes, assignee changes and open or close changes since a cursor, each with its author;
- `describe`: the connector gives its contract version and the operations that it supports (§4.15);
- `check`: the connector tells `doctor` if its CLI is present, configured and authorized, and which scopes it needs. The output has check names and scope names only (FAC-M11).

The 14 operations are the column "Board operation" of §8.2. Each command of that table calls one of them, or none. A connector calls its vendor CLI with an argument list, never with a shell. It sends item text on stdin or in a file (§4.15, "Limits").

**The one rule (D-141 B).** The board holds the truth. The local board is the cache. This is the only place that states the rule, and other sections point here.
- **Reads.** A read may come from the cache. `watch` refreshes the cache. Offline work only reads, except `factory decide`.
- **Writes (board-first).** A write goes to the board first. The cache changes after the board answers. There is no queue. A board that does not answer fails the write (exit 1), and the cache stays as it was. A write with no answer before the time cap has the result "unknown", because the board may hold it. Each item carries its factory id, so a refresh finds the item and a retry makes no second item.
- **Refresh.** For items, tracks and notes, the board wins. The refresh copies the state of the board into the cache. A difference is a drift line that names the item id. The drift check has a cap, and past the cap the line says "more than <cap>".
- **Records.** The decision log and the approval records are never a cache. A refresh never changes them. A difference between the board and the owner store is one drift line for each of the two stores.
- **The one write with no board.** `factory decide` writes the decision log first, and it works offline. With a hosted board, the comment on the item comes second. A failed comment is a warning, and the record stays.
- **Cache-only data.** An operation that `describe` does not list stays cache-only, with a mark. `tracker status` shows one line for it. This data is outside the drift check.
- **Two named kinds.** With `local`, the local files are the truth, because there is no other board. With `artifact`, the items also live in the local files (see "Board connectors").

**Owner fields (G-1, FAC-M5).** The setup names the owner's own item fields and the allowed values of each, for example a priority, a type, a release flag on a queue row, and the worker. The core has no default field and no default value. The values of this workspace (the priorities `P0`, `P1`, `P2` and its type names) come from the sample setup in `examples/`. The board part of that sample setup, `examples/factory.board.yaml`, is in the package from the local board of M5-1b (PR A). It is a `factory.yaml` with a `board` block (§4.4), and a test loads it through the real config schema. The other parts of the sample setup come with FAC-M6. The item operations of the contract carry these fields. `item` and `queue` set and show them, and they refuse a value outside the list or a field that the setup does not name. `local` keeps the fields in its files. FAC-M3 maps each field to a GitHub label or a Projects field, and FAC-M9 maps them for Jira and Linear. A script can read the fields, so an owner rule such as a priority gate needs no model read of the item text.

**Tracks and stages (TB-7).** A track is a named stream of work with its own roadmap. A worker is not a track. A stage is where a work item is on the board. It is not a step of the work cycle (§4.9), although the word review is in both lists.
- **Tracks.** `board.json` has an optional top key `tracks`. Each entry has an `id`, a `name` and a `roadmap` flag. The flag is a boolean. An id is lowercase, starts with a letter and has at most 32 characters. A name is one line of at most 60 characters. A factory has at most 30 tracks. An absent key reads as an empty list. `init` writes an empty list, and the first `track add` makes the key when it is absent. A value that is not a list, or an entry with a bad id, name or flag, stops the read (exit 1) and names `board.json`. An item names its track in the key `track`. `item add --track` and `item update --track` take a listed id only. Another id is exit 2, and the message lists the ids. M5-1b has no command to rename or remove a track (M5-1c). A hand edit can remove a track, and no check refuses it, because the delete guard reads item ids only.
- **Stages.** The recipe gives the list of stages, as it gives the key of the queue. The software recipe lists ticket, plan-approved, building, review, fixes, merged and released. A recipe with no list leaves the stage unknown. A new item gets the first stage. `item move ID --stage STAGE` sets the stage, keeps the status, and prints the id with the old and the new stage. A move to the stage that the item has is exit 0 with no commit. An unknown stage is exit 2, and the message lists the stages. The command takes `--state` or `--stage`, and not both. A stored stage that is not in the list shows with a mark. The list comes from the recipe, so the command works in a factory with no `board` block.
- **Flow-only stages.** The software recipe marks merged and released as stages that only a flow sets. `item move` refuses them (exit 2) before it takes the state lock, and the message names the flow that the recipe gives for that stage. The merge flow (M5-2) and the release flow (FAC-M5b) set them later. No M5-1b command sets either mark. The core source holds no stage word and no flow word.
- **A stage is display data and never a proof.** The status of an item alone decides open, closed and idle. A stage move keeps the status, and a close keeps the stage. A stored merged or released value shows as data and counts for nothing. The work item port never reads the stage key. The coordinator moves the stage at milestone events, and its text says that a stage is never an approval.

**The local board (FAC-M5, M5-1b).** The commands `item`, `track`, `request` and `queue` write the files `board.json`, `waiting.json` and `decision-log.json` of the state folder.
- **Items.** `item add --title TEXT [--text TEXT] [--track ID] [--field NAME=VALUE]...` adds an item. It gets the next id `B-n` above the highest one, the first state of the `board` block, and the first stage. `item update ID`, `item move ID --state STATE | --stage STAGE` and `item close ID` change one item. A close keeps the item and its id.
- **The list.** `item list` prints a header and one line for each track, with the counts by stage. A track with one item shows that item and its stage on its line. Items with no track show under a no-track label. `item list --track ID` lists the items of one track, with a stage column. `--all` shows the closed items too. The output has at most 20 lines. It shows at most 17 track lines. When there are more tracks, one more-tracks line says how many tracks are not shown and names the track flag. `item list` has no JSON output.
- **The follow loop.** `item list --follow` draws the list again at each change of the board file. It polls every 2 seconds. A signal (SIGHUP or SIGTERM), a failed write, a change of the parent process, or a stdout that is not a terminal ends it, and each of these is checked at every tick. It is the one loop with no count bound. The view slot of the window `view` runs it (§4.11).
- **Requests and the queue.** `request add --title TEXT --question TEXT --option KEY=TEXT... [--recommend KEY]` puts a request in `waiting.json`. It gets the next number `D-n` above the highest number in the waiting file and the decision log. `request list` shows the open requests. `request close ID` takes a request out of the waiting file and writes a log row "closed with no answer" with no `by` and no `who`. A log row with no `by` is no decision, and the number is never given again. No request command changes the options of an open request. `queue set NAME [--item ID]... [--note TEXT] [--field NAME=VALUE]... [--position N]` finds a row by its exact name, and makes a new row at the end when no row has the name. `--item` replaces the whole list of items of the row. The queue has at most 30 rows, and a row has at most 30 items. The other stored keys of a row stay. `queue show` shows the rows.
- **Writes.** Each write command takes the state lock once, and makes one commit of the state repo through the board commit helper (§6). Before the commit, the helper checks the new text of each of the three files against the cap of 1 MiB. A text over the cap is exit 1, and nothing is written. A write with a board kind other than `local` is refused before the lock (exit 4), and it makes no commit. With a hosted kind, the board holds the truth and the local board is the cache (the one rule above). Board-first writes come in FAC-M11 and FAC-M3. Until then, the reads show the local files.
- **Reads.** `item list`, `track list`, `request list`, `queue show` and the work item port read the board with no lock. A read can show a mix of two commits until the next redraw corrects the view. A file that is corrupt, is not valid UTF-8, or holds a repeated id is exit 1 and the message names the file. A link in the path is exit 4. A read of any other file keeps the lenient decode.
- **Text.** A command that prints a stored title, track name, stage, question or field value removes control, bidi and invisible characters, turns a line break or a tab into one space, and cuts the line to 120 characters. A request question with a line break is exit 1 and names the file.

**Board connectors.**
- `github` (the default): issues plus a Projects board, through `gh`. factory already needs `gh` for the `software` recipe.
- `jira` and `linear`: the same contract, through their CLI or API. `jira` needs `site` and `key`; `linear` needs `key` (§4.4).
- `local`: files in `.factory/` (`board.json` and `waiting.json`, as in the setup of today), for a node with no network or no board account. It has no changes and no watch: `changes read` returns nothing, and `factory watch` exits at once with a note. `factory item list` and `factory request list` show the items; factory has no other view of its own. The owner answers a decision in the CLI with `factory decide <D-n> <option>`. `local` is also the test double of the connector: the contract tests run against `local` and against each real connector. In this workspace, the review page and the scripts of today stay as the owner view. They read the `local` files (the format is a promise, see "Owner view"). In M5-1b the page only reads. FAC-M3 does not retire the page (TB-5).
- No review desk of its own. Dean said that the factory has no review desk of its own, not even as an option (F-2, F-17). TB-5 changes this in part: the review page stays a supported owner view that the owner can choose. No board kind makes a desk. A factory command that renders or publishes the page is a FAC-M5b criterion, next to the extension points (§4.14). The extension points let a person add a reader.

**Decisions.**
- A decision is an item with the `decision` label. Its body has the question, the options and a recommendation.
- The owner can write the answer on the item as a comment `/choose <option>`, or as a label `choose:<option>`. A comment or a label only shows the answer and wakes the coordinator. It records nothing.
- `factory decide read` reads these answers with a script, not with model tokens. It shows each answer with its author and the link, and it records nothing.
- `factory decide <D-n> <option>` records the decision with `by: owner` in `decision-log.json`, with every board kind. With `github`, it also adds a comment to the item that says the answer came from the CLI. That comment is a record, not a proof. The command needs a terminal window, and it refuses (exit 4) inside a session that factory started (factory sets `FACTORY_SESSION` at each launch). The remedy is to run `factory decide <D-n> <option>` in a terminal window outside a factory session. This guard stops a session from answering by accident. The owner's permission settings are the second guard. A review page is a later way to record the same decision.
- An *ask* is a decision item for one PR or one work item. The owner answers `approve` or `refuse` with `factory decide`. §6.1 says which answers count as an approval.

**Board accounts (D-128 A).** factory does not look at which account anyone uses on the board. The owner, the coordinator and the workers can share one account, or use more than one. A separate account for the agents is optional, and it is the owner's own GitHub choice. factory has no setting for it and no check of it.
- A board event is never a proof, with any account setup. A comment, a label, an assignee change and a review do not count as an owner approval, and they do not count as an assignment.
- A `factory decide` record is a proof. It needs a terminal window outside a factory session.
- With `local`, there are no board events, so only `factory decide` counts in every case.
- A board event can wake the coordinator and show an answer. It records nothing.
- Designs and plans: the `doc` operation links the repo file (GitHub shows Markdown), or attaches it.

**Changes and wake-up (F-2).** There is no live push to a local session without a webhook server. So `factory watch` calls `changes read` with the board CLI at a fixed interval (`tracker.watch_interval`), with a bound on the number of reads per run. The coordinator reads these board events:
- a comment `/choose <option>`, and a mention of the coordinator;
- a label added or removed, for example `choose:<option>` or `ready` (a work item is ready);
- an issue or item opened or closed.

Every new event wakes the coordinator, whatever account wrote it. An event only wakes the coordinator and shows what was written. It is never a proof (see "Board accounts"). An assignee change is read, but it assigns nothing (§6.1). A card moved on a Projects board is not read for now; the owner uses a label for that signal. `watch` calls no model. For each new event, it writes one record (FAC-M3 sets its format) and types one constant wake line through `src/comms/` (§4.12). `factory start` starts `factory watch` in the window `ops` (§4.11).

**Privacy.** An issue in a public repo is public. Decision items can hold private facts. So the default decision store is a private repo, or private draft items in a private Project. `factory doctor` fails when the decision store is public, and warns when it is not set. The `local` store is private: it is the node's own state repo, with no remote.

### 4.11 Sessions in tmux: workers, view and the lifecycle

**Layout (F-8).** `factory start` makes one tmux session per node, named with the node id. It has these windows:
- **workers**: one pane for each worker. The workers keep running there.
- **view**: the coordinator, plus one slot. The slot shows the board pane (see "The live board" below), or a worker on request (`factory worker summon <worker> [--for 15m]`). When the time ends, the slot shows the board pane again.
- **ops**: `factory watch` (§4.10). From FAC-M11 the window exists for every kind of board, because `local` and `artifact` have a local change feed. Until then it exists only when the board is not `local`. `start --dry-run` lists it.

`factory start` attaches when the session runs already. It never starts a second coordinator for the same factory folder. Before it attaches, it claims the mark of the active machine when the mark does not name this machine (a mark that names this machine is not written again). Then it prints one warning that names each recorded worker with no live pane (a pane whose program ended is not live) and the command that starts it: `factory worker resume <id>`, or `factory reboot` for every worker. It never resumes a worker on its own, because a worker that was stopped on purpose stays stopped. With `--json`, the object has `workersWithoutPane`, the ids that the warning names, and the key is absent when there are none. A fault of these steps is a warning, and the exit code stays 0. One exception: right after its tool check, `start` reads the `git` version and the git config of the state repo, before it makes or looks at a session. A `git` older than 2.26, a `git` version that it can not read, or a config list that `git` refuses (exit code 129) stops `start` with exit 1, and no session starts (§4.7). Every other fault of the git config of the state repo is a warning (exit 0). The claim of the active machine also warns, and does not stop, when another writer holds the state lock for the whole wait: `start` writes no mark and goes on (exit 0). A dry run shows the `git` faults as warnings, and does none of the other steps. The pane options are `@factory_home`, `@node`, `@slot`, `@slot_summon` and `@worker` (the worker id, on a pane of the window `workers`). `@slot_summon` is on the board pane. It holds the summoned pane and a random token while a summon is active, and it is unset when the board is in the slot (`worker summon` and `layout`, §4.6).

**After a machine restart.** A machine restart kills the tmux server. `factory start` on a dead server starts the coordinator, and then resumes each recorded worker from the last-seen files. Each worker resumes with the session id that its last-seen file holds. So a machine restart needs no tmux-resurrect scripts. The id rule: a session id enters a command line only in UUID form, and only for a worker that the config or the state knows. A last-seen file with any other value is refused: factory names the file, starts nothing for it and goes on with the other workers. `restart` and `reboot` use the same path, so they apply the same rule. `start` makes the git checks of the state repo (§4.7) before it makes a session, and `reboot` outside the session makes them before its first stop. A fault of these checks is exit 1 and leaves no new session. When the state shows another machine as the active one, `start` warns before it resumes any worker (§4.3).

**The lifecycle verbs (F-20).** The code is `src/commands/lifecycle.ts`, with the shared steps in `src/workers/lifecycle.ts`. A verb finds the factory folder, and reads the list of the panes of the tmux session once (one `list-panes` call). It gives that list to `stopWorker` for each worker. Before the first stop, it checks every worker that it will stop or start again (`checkTargets`). Each worker needs panes that the check reads as the stop reads them (`readWorkerPanes`): every pane that carries the mark of the worker must be a pane that the launch made, and a pane of the worker in the window `view` needs a summon (both exit 4), and the worker has at most one live pane (exit 2). It also needs a session id that passed the ownership check of `worker resume` (exit 3), a known case of its session (exit 3), and a pane that is not the pane of the caller (exit 2). A worker that starts again also needs a work copy that is its folder and settings files that pass the check of §4.3 (exit 4). `restart` and `reboot` run the root checks of `start` once, before any stop. They also ask the proxy of each launch that comes after the stop, with the one set of answers of the run: a proxy that does not answer, and that may not go direct, is exit 1. A failed check changes nothing. The stop reads the panes again right before the signal. A stop after the checks can still fail: a process that does not end is exit 1, and a pane that changed since the check is exit 4. The message then names the workers that stopped before the fault.
- `start` starts or attaches the factory, as above.
- `shutdown` ends this factory, and nothing else. With no tmux session it says that nothing runs and exits 0, and it still clears the mark of the active machine of this machine. Else it stops each worker that has a pane, clears the mark of the active machine, stops the coordinator, and ends the tmux session by its exact name. A mark that names another machine stays. A fault of the mark is a warning that names the command of the caller (`shutdown` or `reboot`) as the command to run again, and the command goes on. The coordinator stops as a worker stops (`kill -TERM`, a wait of at most 30 seconds for the end of the process, and never KILL), so the end of the session does not hang up a program that was never told to stop. The pane is read again right before the signal. A coordinator pane that is gone, whose program has ended, or that does not carry the `@node` mark of the session gets no signal, and the session ends as before. A coordinator that does not end within the wait is exit 1: the message names the pane, the process and the workers that stopped, the session stays, and the remedy is to run `factory shutdown` again. When `shutdown` runs in a pane of its own session, the end of the session ends the command. So it prints its report as warning lines on stderr before it ends the session. In the coordinator pane itself the command sends no signal to its own pane: the report comes first, and the end of the session ends the pane. In another pane of the session (for example the board pane), the coordinator stops first, then the report is printed, then the session ends. The exit code stays as it is without this step.
- `restart <worker>` stops one worker and starts it again with its session id (`resumeWorker`). The other workers keep their panes. A worker with no pane starts with no stop. If no tmux session runs, it exits 3 and names `factory start`. If the new session writes no line, the message says that the worker stopped and did not start again, and the remedy names `factory worker resume <worker>`.
- `reboot` stops every worker and starts each recorded worker again with its session id. Outside the session, it first makes the steps of `start` that change a file, with the consent rules of `start` (it has no `--yes`): the safety block is rendered again when it is out of date (§4.8), and the hook settings of the coordinator are made sure (§4.6). A stop in these steps comes before the first stop of a worker. Then it is `shutdown` (the coordinator stops with `kill -TERM` before the session ends), then the start path with its recovery, and it prints the command that attaches. One run asks each proxy once (one set of answers for the run). Inside the session (the pane of the caller, `TMUX_PANE`, is a pane of the session), only the workers stop and start again, and the session and the coordinator pane stay. With no tmux session, nothing stops, and the start path recovers the coordinator and the workers. A worker that did not start again is named, and the exit code is 1. A fault after the first stop names the workers that stopped, and it gives one remedy. While the session runs (a stop that fails, a coordinator that does not end, a session that does not end, or the recovery inside the session), the remedy is `factory reboot` again: it starts the stopped workers again. After the session ended, the remedy is `factory start`: it starts the session and resumes the workers.
- `status [--home DIR]` lists each worker with its state, its work item and its unused state. The work item column shows the current work, so a worker with an old name shows it. The command reads and changes nothing. `status` and `worker list` use one builder (`buildStatus` in `src/workers/status.ts`), which makes no call: the command reads the registry, one `list-panes` call, the last-seen line of each worker and the work items, and gives them to the builder. The output is one line for each worker, with the columns `ID`, `PROJECT`, `STATE`, `WORK ITEM` and `UNUSED`, or the object `factory.status/v1` with `--json`. This is the target. Until FAC-M5b, the code has the column `IDLE` in place of `UNUSED`, and `STATE` shows `stopped` for a worker with no live pane, and `at prompt`, `busy`, `waits` or `unknown` for the others.
  - `STATE` has the words of the live board (below). A worker with no live pane (no pane, or a pane whose program has ended), no work copy folder or no last-seen line shows its hold word, Parked or On hold, when it has one, else `—`. It never shows Stopped for that case. With no tmux session of this factory, every worker shows its hold word or `—`, and the exit code is 0.
  - `WORK ITEM` comes from the work item port: the work item that the board gives for the worker, `none` for a worker with no open work, and `unknown` when the port does not give a work item. A port that fails gives one warning and `unknown` for every worker. The reader of the local board is the port. It reads the board file once, with no lock, and gives a worker the first open item in progress whose worker field holds the worker id, else the first other open item. With no `board` block, or with a block that names no worker field, `status` shows `unknown` for every worker and no worker is unused. The same holds for a board file that is missing or corrupt, with one warning that names the file. `status`, `dismiss --unused` and `worker list` take the port as a required parameter. `worker list` shows no work item, and it reports a fault of the port as a warning.
  - `UNUSED` is `yes` or `no`, by the rule below.
- `dismiss <worker> [--yes]` ends a worker and frees its work copy, when its work is pushed. It is a dry run until `--yes`. `dismiss --unused` lists the unused workers first, and the owner picks which to dismiss. FAC-M5b names the flag `--unused`. Until then the code has `--idle`.

**The stop scope rule (F-20).** A stop verb (`shutdown`, `restart`, `reboot`, `dismiss` and `worker stop`) ends only the sessions, panes and processes that factory started for that factory or that worker. factory knows them from the pane options of its own tmux session and from the ids that it recorded at the launch. A session with the same name and another `@factory_home` option, a session of another factory, and a `claude` process outside the panes of the factory keep running. If the tmux session of the name has no `@factory_home` option, or has the `@factory_home` option of another folder, `shutdown`, `restart` and `reboot` end nothing and exit 4 with one remedy line: run `factory shutdown` in the factory folder that owns the session, or end that session by hand (§4.3, "Stops and warnings").

**Unused (F-21a).** A worker is unused when two things are true: it shows no activity for a set time, and it has no open work in progress (no work item in progress is assigned to it). The time is the setting `limits.unused_after`. It is shared, and its default is 2h. The setting uses the interval parser of the config schema, with a bound of 1m to 24h. The activity of a worker is the newer of the two times of its last-seen line, and "no activity for a set time" means that this time is older than `limits.unused_after`. An unknown fact is never unused: a worker whose work item is unknown, a worker with no last-seen line that belongs to it, and a worker whose last time is after the time now are not unused. `status` shows the unused state. A value outside the bound fails the load, and the message names `limits.unused_after`. "Unused" is not the live state Idle: a worker is Idle when its turn ended and it waits at its prompt, and it is unused only by this rule. "Unused" is not a word of the live board. The column `STATE` never shows it, and the column `UNUSED` of `status` does. The code keeps the old names until the FAC-M5b code: the flag `--idle`, the column `IDLE`, the setting `limits.idle_after` (with its load message), the word `stopped` of `status`, and the states `at prompt`, `busy`, `waits` and `unknown` of `status`. The names in this design are the target.

**The live board (FAC-M5b).** The live board shows what each worker does now. It reads the last-seen lines, the work items and the board cache. It calls no model.
- **The workers table.** `worker list --follow` has the columns `WORKER`, `WORK ITEM`, `STATE`, `IN STAGE` and `CONTEXT`, in this order. A row is one line. The columns have the meaning, and the order, of the columns `Lane`, `Ticket`, `State`, `In phase for` and `Context` of the live board of this workspace, with a worker in each row.
- **The work item.** `WORK ITEM` is the title of the current work item of the worker. A title that does not fit is cut at a word end and ends with `…`, so that the row stays one line. A worker with no work item shows `—`.
- **The state text.** `STATE` is `<Stage> · <word>`, for example `Building · Working`. The stage is the stage of the work item of the worker (see "Stage" below). The word is one word of the closed list below, and it can be a hold word, as in `Building · Parked`. A worker with no stage shows the word alone.
- **The words.** The list is closed: Working, Idle, Stopped, Stalled, Parked and On hold. A worker shows one word:

| Word | Source |
|---|---|
| Working | The last event is `UserPromptSubmit`, `PreCompact`, `PreToolUse`, `PostToolUse` or `Notification` for a dialog (the types `permission_prompt` and `elicitation_dialog`), and no `Stop` or `StopFailure` came after it. |
| Idle | The event `Stop` or `SessionStart`, or the event `Notification` with the type `idle_prompt`. |
| Stopped | The event `StopFailure`. Claude Code sends it in place of `Stop` when a turn ends on an API error. The field `error` gives the cause. A usage limit is the cause `rate_limit` or `billing_error`. The cause is in the stopped-workers file, never in `STATE`. |
| Stalled | The events `SubagentStart` and `SubagentStop`, and a fixed time bound. The worker would show Working, and no event came for the bound. A start or a stop of a background agent counts as an event. The bound is the one of `stalled?` in `worker watch` (§4.6). |
| Parked, On hold | `factory worker mark <worker> parked`, `on-hold` or `none`. The owner or the coordinator sets it. No hook sets it. |

- **Stopped has one meaning.** Stopped means an API error. `STATE` shows the one word Stopped, and never the cause. A worker with no live pane, no work copy folder or no last-seen line shows its hold word, Parked or On hold, when it has one, else `—`. It never shows Stopped for that case. `status` and the live board use the same words.
- **The stopped-workers file.** The file lists each worker that is Stopped or Stalled. It has one line for each worker, with the worker id, the word, the cause, the time and the remedy. The cause of Stopped is the value of the field `error`. The cause of Stalled is `stalled`. The time is the time of the event for Stopped, and the time of the last event for Stalled. The cause and the time show nowhere else. The file is empty when no worker is Stopped or Stalled, and it changes only when the list changes. FAC-M5b names the file in `src/names.ts`. The remedy depends on the cause:
  - `rate_limit` or `billing_error`: wait until the limit ends, then run `factory worker recover <worker>` (FAC-M5).
  - Any other cause, and Stalled: run `factory worker summon <worker>` and read the pane.
- **A hold word** replaces the hook state while it is set. A mark is not an approval: it gives no consent and counts for no approval point (§6).
- **A permission prompt** is not a word of this list: a worker that waits in a dialog shows Working, and Stalled after the bound. `worker watch` still reports it (§4.6), and `worker stop` and `dismiss` still treat it as a case of its own.
- **Stage.** The stage in `STATE` is the stage of the open work item of the worker, from the work item port of `status`. The recipe gives the list of stages. A stage is where a work item is on the board. It is not a step of the work cycle (§4.9). The item holds the time of its last stage change, and `IN STAGE` is the time since that change, as `N min`, `H h`, `H h M min`, `D d`, `D d H h` or `99+ d`. Both times are UTC, so the time zone of the machine changes nothing. A value that is missing or not valid shows `—` for that row only. A worker with no open work item, or with an item that has no known stage, shows the word alone in `STATE` and `—` in `IN STAGE`. A board that can not be read gives `—` for the work item, the stage and `IN STAGE` of every row.

Software recipe: the stages are `ticket`, `plan-approved`, `building`, `review`, `fixes`, `merged` and `released`. The stages `merged` and `released` belong to a done item. The live board shows a stage name with a capital first letter, for example `Plan-approved`.

- **Context.** `CONTEXT` is the context percent of §4.6. Its source is `context_window.used_percentage` of the status line. It shows `?` when unknown.
- **Two gaps.** First, Claude Code documents no end event for a background shell command, so factory can not tell a long background shell command from a stall. Second, Working between a prompt and the first tool call is inferred: `UserPromptSubmit` came and no `Stop` followed. No event marks the model turn itself.
- **The hook.** The hook of §4.6 gets the events `PostToolUse`, `StopFailure`, `SubagentStart` and `SubagentStop`, and it adds `idle_prompt` to the `Notification` types that it writes. The last-seen line holds the event name, the time and the few fields that the table names. Factory never reads `transcript_path`. Before the build, FAC-M5b checks the field lists of `Stop`, `StopFailure` and the status line against the Claude Code pages, and it captures one payload of each new event (§4.6).
- **The tracks view.** The tracks view is `track list`. It prints one line for each track: the name, the current milestone, the workers of the track, the number of open work items for each stage, and the number of merged and of released work items since a set date. The milestone comes from the roadmap of the track, and it is a fixed text when the roadmap is missing or can not be read. A worker shows as `worker (stage)`, or as `worker (stage, Parked)` or `worker (stage, On hold)` for a held worker. A worker with no stage shows `—` in place of the stage, and a track with no worker shows `No worker`. The view shows no word of the live list and no time, so it needs no hook event.
- **The other views.** The board pane is `item list --follow`. The boxes are `request list` and `machine`. `--follow` repeats at a fixed interval and stops after a fixed number of redraws. A view prints at most a fixed number of lines, and past that number its last line says "more than <cap>". The interval, the redraw count and the line cap are named numbers in `src/names.ts`.
- **The estimate.** Each open item in the board pane shows an estimate mark: the token range of `item estimate`, or `NO BASIS`. `status --usage` is the usage view.

**Dismiss (F-21a, F-21b).** `dismiss` is a dry run by default: it prints what it would end and what it would free, and it changes nothing until the owner confirms. The confirm flag is `--yes`, as for the other commands. It needs no terminal window, and inside a factory session it gives no consent (exit 4); the dry run works there. The logic is in `src/workers/dismiss.ts`, and the command is in `src/commands/dismiss.ts`. The checks come in this order, and each one comes before any change:
1. **Path.** The work copy must be the folder `work-copies/<project>/<id>` that the record rule gives, with no link in its path. The real path of the work copy is compared with the real path of `work-copies/` with `path.relative`: a work copy that is not exactly two parts below it, a link, and a clone that lies inside the work copy are a stop (exit 4). Every later step uses this real path. The file `.git` of the work copy must be a plain file whose `gitdir:` line names a folder directly below `worktrees/` in the git folder of the clone, and that folder must name the `.git` file of this work copy back. Any other link is a stop (exit 4), and no git command runs in the work copy. The reads of the head, the changed files and the ignored files take the repo from that git folder and turn the file monitor off. The stash and the commit tests run in the clone, which shares them with every work copy. The primary clone of the project is never changed.
2. **State.** It refuses a busy worker with one remedy line and exit 1: a worker with open work in progress, a worker whose session works now, and a worker with a live pane whose state is not known. The remedy is to wait until the worker waits at its prompt, or to finish the work item or give it to another worker, and then run `factory dismiss <worker>` again. A worker with no live pane has no session to end, so its last event does not matter. The state is read again at the stop, right before the signal, and the stop refuses a session that works now (exit 1), so a worker that turned busy after the first read keeps its pane. A worker whose state is `waits` (a dialog waits for an answer) is refused in the same way (exit 1). Known limit (A-2): a turn that a message starts may not fire `UserPromptSubmit`, so the line can stay `at prompt` while the session works; the tool events make most such turns `busy`.
3. **Pushed.** The work of a worker is pushed when, after a fetch, the head of its branch is on the remote branch `origin/worker/<id>` or on the remote default branch of the clone (`origin/<default>`; the head is that commit or lies below it), and the work copy has no changed file, no untracked file and no stash entry. A new worker with no commit of its own has a head on the default branch, so it holds nothing that the remote lacks. The default branch is the one that `origin/HEAD` names, else the current branch of the clone. The fetch is `git fetch --prune --no-tags origin +refs/heads/worker/*:refs/remotes/origin/worker/* +refs/heads/<default>:refs/remotes/origin/<default>`, one call for each clone in a run, so a remote reference that the fetch did not update does not count, and a branch that the remote dropped is pruned. The stash is shared by every work copy of a repo, so any entry blocks. A git command that fails is an error (exit 1) and never a reason that the work is pushed.
- **Free.** In order: the pane ends if one is live (`stopWorker`, with the one list of the panes of the run); the work copy is removed from `work-copies/` with the plain `git worktree remove`, run in the clone, with no force (git refuses a changed or untracked file and deletes the files that it ignores); then the record folder of the worker (its record and its pointer) and the last-seen line that the pointer names are deleted together. The line is deleted only when it belongs to the worker (the owner check of `worker stop`). The dry run and each free (also each free of `--unused`) name the ignored files that the removal deletes: their count and at most 20 paths, read before the removal, and no line when there are none. The JSON carries the paths as `ignored`. The primary clone of the project stays. A fault names the steps that were done. When git refuses the removal, the remedy names `git worktree unlock` for a locked work copy, and for a work copy with submodules the forced removal by hand and the paths to delete. Up to the removal of the work copy, `dismiss` run again does the steps that are left. After the removal, the checks of `dismiss` can not run for the worker again, so the remedy names the last-seen file and the record folder to delete by hand.
- **The branch stays.** `dismiss` never deletes the branch `worker/<id>`: the remote may hold it, and a delete is a second, separate loss. The output prints the `git branch -D` line that deletes it, which a person needs before `worker new` can use the same id again.
- If the work is not pushed, `dismiss` frees nothing, ends no pane, prints one failed line (marked `[FAIL]`) that starts with `STUCK:` for each reason, and exits with code 1. The remedy is to push the branch of the worker and run `factory dismiss <worker>` again. A worker with a commit that no remote branch holds is stuck until it is pushed. A worker with no commit of its own is not stuck, also when its branch was never pushed.
- `dismiss --unused` is a dry run first: it lists the unused workers with the columns `ID`, `PROJECT`, `STATE` and `PUSHED`, and changes nothing. A worker with no live pane shows its hold word, or `—`, in `STATE` and is only listed. In a terminal window outside a factory session the owner then types the ids to dismiss. After the answer, the command reads the state of the workers again and checks each picked id again, with a new fetch for each clone of a pick, so a worker that turned busy or changed its files while the owner typed is not freed. Every id is checked before the first change: an id that is not listed, a worker with no live pane, a busy worker and a worker whose state is not known are refused with exit 1 and a remedy line. Only the panes of the picked workers end, and each picked worker is freed as `dismiss <worker> --yes` frees it, so a picked worker with unpushed work keeps its pane and prints `STUCK:`. With no terminal window it only lists. Inside a factory session (`FACTORY_SESSION` set) it lists and the pick step refuses (exit 4). The remedy is to run `factory dismiss --unused` in a terminal window outside a factory session. A tmux session of the same name that belongs to another factory folder stops the command (exit 4), and no pane ends. A worker is unused only when the board names no open work for it. With no `board` block, or with a board file that is missing or corrupt, no worker is unused, so the list is empty. The command reads the board once for the list and once more just before the stops. A worker can get an item after the second read and before the stop. This window is a known limit.

**Stop (F-7).** The safe way to stop a session is not known yet. The rule for the word "safe" comes first, in `docs/session-stop.md`, before any test. A way is **safe** when all four facts hold:
1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

Then a test runs in a throw-away session. It tries each way: `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. A busy session is the hard case (F-7), so it tries each way twice: once on an idle session, and once on a busy session (a tool runs and a background agent runs). The table has one row for each way and each case, with the four facts and the verdict "safe" or "not safe".

Then `factory worker stop` uses the way that is safe for the case of the worker. The test ran, and `kill -TERM` is safe for an idle and for a busy session (`docs/session-stop.md`), so `worker stop` sends `kill -TERM` in both cases. A case with no safe way would use `kill -TERM` as the prompt fallback. Fact 4 was tested with background shell tasks only: a cron or a background subagent can be lost without a record, and the stop code cannot see either. `worker stop` exits 3 ("not ready") only when the state of the session is not known, and it names what runs (§4.6).

### 4.12 Communication module

Sessions on one machine talk with the cross-session messages of Claude Code (`SendMessage` and `ListAgents`, version 2.1.224 or later). factory has no inbox and no doorbell (D-101). It adds only what Claude Code does not have:
- **Session names.** factory starts each session with `--name`. The coordinator gets the node id. A worker gets `<node id>-<worker id>`. One function in `src/names.ts` (`sessionNames`) makes the names. A name is an address, not a proof: any session can take any name. So the name is not a word of the pane binding (§4.6). Before its first send to a worker, and after each resume of that worker, the coordinator checks with `ListAgents` that exactly one session has the name.
- **Assignment files.** A long task is a file in the assignment folder of the worker, `.factory/workers/<id>/inbox/` (`FACTORY_INBOX`). The message names the file. The coordinator writes the file there, and `worker new --assignment` copies the first task. A worker acts on a task file only when its real path is in that folder and it is not a link. The file is the durable copy of the task. The folder keeps the name `inbox` until a later milestone renames it with a migration.
- **Typed input.** One module types into a pane: `src/comms/typing.ts`. It types only constant lines (`/clear`, `/compact`): any other line is refused with exit 1 before a tmux call. It uses key names from a fixed list, to a pane id, in printable ASCII, with at most 300 characters. Before it types, it reads the mode of the pane. A failed read is exit 1, and a pane in a mode of tmux (the copy mode) is exit 3, because the keys would not reach the session; the remedy is to press `q` in the pane. Then it reads the bottom lines of the pane once. When they show a numbered option list, it stops with exit 3. An option list is a line that starts with a pointer sign and a number, and a second numbered line. Spaces and box-drawing signs may come before the first sign, so a list inside a side border is seen. A numbered list in normal output has no pointer sign, so it does not stop the module. This is a refusal rule, not a model of the screen: a dialog with another form is not seen. Each exit 3 remedy ends with the command that the caller runs again. A mode or a dialog that opens after its read and before the keys is not seen. `worker reset` and `self reset` use the module.
- **Script wake (FAC-M3).** A script, for example `factory watch`, cannot send a message. It wakes a session with one constant line, typed through this module. FAC-M3 sets the line and the format of the records that the line points to.
- **Node calls.** `ping` stays as built (the `file://` transport, §5.3). `deliver` to a child node comes in FAC-M8, and `report` from a child node comes in FAC-M5.
- **Authority.** A message from another session is data. It carries no authority of the owner, also when its sender has the name of the coordinator, and a slash command in its text never runs. Owner authority enters a session only as typed input with the owner prefix (§5.5, `worker relay` in FAC-M5).

**Limits of native messages.**
1. There is no read receipt. A refused send shows `Not sent` to the sender. A message has at most about 1M characters, and Claude Code refuses fast bursts.
2. Delivery is direct in the modes default, acceptEdits, auto and dontAsk, and factory starts every session in auto mode. A receiver in bypassPermissions or plan mode holds messages for approval, and they expire after 5 minutes. The setting `crossSessionInbound` (accept, hold, refuse) changes this. `doctor` warns on `hold`, `refuse` and the default mode `plan` in the project and local settings files. It cannot see user-level settings or a mode that a person sets in a pane.
3. A receiver queues at most 50 messages and holds at most 100.
4. The docs do not say that a message survives the end, a clear or a compact of the receiver. So a message is not a durable store. The assignment file is the durable copy.
5. A message from another session carries no authority (above).

`doctor` also checks the version of the agent program (`<session.agent> --version`, 5 s limit). A version below 2.1.224, or a version that it cannot read, is a warning.

### 4.13 Core and setup

factory has two kinds of files. The **core** is the metal: the code, and the fixed rules that every factory needs. A **setup** is the text and the scripts that a person adds on top of the core (F-16). A setup is code. Its role texts and its coordinator text are session instructions, and a session obeys them. Dean's own examples are setup (F-16a). The fixed rules are core (F-16d).

| Part | Kind | Rule |
|---|---|---|
| The priorities rule | setup | A person writes it. A second factory can take it from a shared setup. |
| The lifecycle of work (plan, build, review, fix, release) | setup | The recipe gives a default. A person can change it. |
| The review rules | setup | The recipe gives a default. A person can change it. |
| The role texts | setup | The recipe renders the role block. A person adds text outside the fixed rules, in the tracked files `setup/coordinator.md` and `setup/roles/worker.md`. |
| The scripts | setup | A script is a file of the setup. The owner accepts it (FAC-M6). |
| The owner hooks (G-2) | setup | The hook list `setup/hooks` names an event and a setup script for each entry. factory runs the script after it writes the event to the event file, and gives the event on stdin. The owner accepts each hook as a setup file. A hook has a run-time bound, a named number in `src/names.ts`; factory stops a hook at the bound. A hook that fails or stops at the bound prints one warning line, and the command keeps its exit code (FAC-M6). |
| The owner fields of the board (G-1) | setup | The setup names the fields and their values. The connector contract carries them (§4.10, FAC-M5). |
| The board connectors `local`, `artifact` and `github` | core | They are internal board plugins. The package holds them, and they use the same contract as a board plugin of the owner (§4.15, FAC-M11). |
| The board plugins of the owner | not a setup file | A board plugin is an npm package that the owner installs. The owner names it in `factory.local.yaml`. It is not a file of the setup, so the setup acceptance does not cover it, and there is no hash accept (D-140). The install is the trust decision (§4.15). |
| The decision profile | core and setup | The store, the record tools and the use of the profile in decisions are core. The principles and the records are the owner's content. Each owner decision through `factory decide` writes a decision record that the profile uses later, so factory decides more on its own as the profile grows (FAC-M5). |
| The fixed rules (the `safety` block) | core | It is the metal. An edit cannot remove it: `doctor` and `start` check its hash. |
| The role block that the recipe renders | core | The package renders it again when the setting or the package changes. |
| The factory part of the `.gitignore` | core | It keeps the private files out of git. A person adds lines outside it. |

- A setup adds text only outside the fixed rules.
- **The fixed rules are checked.** The `safety` block is a managed block with a hash in its marker. An edited or missing `safety` block stops `start` (exit 4) and fails `doctor`. The remedy is `factory upgrade --overwrite safety`. It renders the block again and keeps the old text in a new backup file in the state folder (at most 10 are kept; the same holds when `--overwrite` replaces a role block or the setup block). It stops with exit 4 inside a factory session, also with `--yes`. A block that is intact but differs from the text that the package renders now (a new package version, or a changed prefix) is rendered again with a notice. A role block that a person edited stays, with a warning.
- **The check needs the rendered text of each machine.** So `coordinator/CLAUDE.md` is not tracked (D-1). Every file that a person needs to make the factory again is in the tracked folder: the coordinator text in `setup/coordinator.md`, the worker role text in `setup/roles/worker.md`, the recipe choice with its list of approval points, the board config, and the setup files of FAC-M6. The mode of each point is per person and stays in the local file.
- **In this design the owner accepts the hash of `setup/coordinator.md` and of `setup/roles/worker.md`** (D-13). The setup acceptance of every setup file, and the upgrade rule (an upgrade never overwrites a setup file), come with FAC-M6.
- **The owner layer (Dean's "clay" note).** The setup files (with the runbook and the retire list of an adopt), the owner text outside the blocks, the owner hooks and fields, the principles and records of the decision profile (`.factory/decision-profile/`), and the roadmaps (`.factory/roadmaps/`) are the owner layer. An upgrade never overwrites them. When the owner and the package both changed a role block, the setup block or a template file, factory shows the conflict and the owner decides (§4.5, "The clay rule"). The fixed rules stay outside this rule. When this workspace moves to factory, its own files go into the owner layer, and the move loses none of them (§8).
- **Neutral core templates (G-9, FAC-M6).** The role texts of the package hold no rule of one owner's way of work. Today the software recipe templates hold some of Dean's own rules: "if no worker is free, create one", "verify a report on the primary source", "tell the owner what you decided", a ticket for all work, as few pull requests as possible, one evidence comment, a review posted and a change releasable before the merge, and the ASD-STE100 writing style (also in the decision profile template). FAC-M6 moves these lines to a sample setup in `examples/`, which a person can copy into `setup/`. The board part of that sample setup, `examples/factory.board.yaml`, is in the package from M5-1b (PR A). The other lines of the sample setup are not there yet. The merge line of the core keeps only "CI is green". The coordinator text keeps "Coordinate. Do not produce." as its default role line (Dean's note), "Own the loose ends", and the use of the decision profile. The work cycle line (plan, implement, review and resolve) stays as the default of the recipe, because the lifecycle of work is setup with a recipe default (table above); only its "one evidence comment" part moves. The generic worker protocol stays: workers ask the coordinator, never the owner, and report each milestone.
- factory starts Claude Code only. The instruction-file check also covers the file names of other common agents, because a person may start another agent in the same folder (§4.3).

### 4.14 Extension points

factory has no review desk of its own, not even as an option (F-2, F-17). TB-5 changes this in part: the review page stays a supported owner view that the owner can choose (§4.10). A person who wants another desk builds a reader on one of these extension points. Each point has a milestone.

| Extension point | What it gives | Milestone |
|---|---|---|
| Board connector contract | The operations of §4.10: item, decision, doc and changes. A new board kind implements it. | FAC-M3 (GitHub), FAC-M9 (Jira, Linear) |
| Event file | The digest of the node in `.factory/outbox/`, written by script (§5.4). A reader follows it. | FAC-M5 (the file and the §5.4 keys); FAC-M5b (the §4.14 fields and the sample reader) |
| `report --json` | The digest on demand, in the same format (§5.4). | FAC-M5 (the command and the §5.4 keys); FAC-M5b (the §4.14 fields and the sample reader) |
| Recipe registration | A recipe is registered in the recipe registry. This is a code path. A new recipe needs no change to the core (§4.9). | FAC-M6 |
| Setup files | A script and one line in the setup list. The owner accepts each file (§4.13). | FAC-M6 |
| Owner hooks | A setup script that runs after an event, with the event on stdin (§4.13). | FAC-M6 |
| Review page | A factory command that renders or publishes the review page from the local files (§4.10). The page escapes every string, builds its links by a fixed rule, has no write path, and listens on a local address only when it serves. The secret check of `doctor` runs before a publish. | FAC-M5b |

The event file and `report --json` hold these fields (§5.4): the node id, the layer, the factory version, the report schema version, the cursor, the state of each worker, the board counts by state and by each owner field (for example a priority), the items in progress, the milestone events, each request with its origin path, and the reports of the child nodes.

A person with no code skill adds a desk reader as a setup file in FAC-M6. FAC-M5b adds a sample reader outside `src/`, in `examples/`. It reads the event file and `report --json` of a fixture node, and prints one line for each work item. A test runs it.

### 4.15 Plugins

A plugin adds a part to factory with no change to the package. A plugin is an npm package that exports a contract. The user installs it with npm. FAC-M11 builds the loader (D-140).

**Kinds.** The first kind is the board connector, with the contract id `factory.board/v1` (§4.10). FAC-M11 builds it, with the loader. No plugin loads before that. A new kind needs its own contract id and its own rules here.

**Find and load.**
- The user names the package in the `tracker` block of `factory.local.yaml`: `kind: plugin:<package>` and `options` (§4.4). The shared file never names a plugin. A shared file that names one stops the command with exit 1 (§4.3, "Stops and warnings").
- Factory loads a package only from the global npm folder that `npm root -g` prints. It finds this folder once, at `tracker set`, and keeps it for the node. It never loads code from the factory folder or from a project. This keeps the rule for a received factory (§4.3).
- Three checks come before the load. The name is a valid npm package name. The real path of the package is inside the global npm folder. The `package.json` of the package names the contract id. Factory reads that file first, so no plugin code runs before the checks.
- The names `local`, `artifact` and `github` are reserved. A plugin with one of them does not load.

**Contract.** Factory loads the plugin in its own process and calls `describe`. It gives the version and the operations that the plugin supports. Another major version is an error (exit 1). A minor version only adds. Factory checks each result against the schema of the contract. A result that fails the check is an error, and the command writes nothing.

**Limits.**
- The time cap, the output byte cap and the result cap of a call are named numbers in `src/names.ts`. A call past a cap has the result "unknown".
- A connector calls a vendor CLI with an argument list, never with a shell. It sends item text on stdin or in a file.
- Control characters in connector output show as visible escapes.
- Known limit: a time cap can not stop a plugin that blocks the process.

**`plugin test <package>`.** The contract suite that factory exports runs against the plugin. It has four layers: the schema of each operation, the behavior of each operation, an item title with shell characters, and recorded responses of the vendor CLI. The command exits 0 for a good plugin. For a bad plugin it exits 1 and names the first failed operation.

**Reach.** A plugin runs in the factory process, so it can reach everything that factory can reach: the files of the user, the logins of the board CLIs, the network, the state files and the decision log. The install is the trust decision of the user. Factory has no accept command, no hash and no child process for a plugin. The remedy text of each stop says this (§4.3, §6).

Community documents and examples for plugin authors wait for FAC-M10.

## 5. Layers: same mechanics, one role per layer

### 5.1 The node

Every node has the same mechanics: `factory.yaml` and `node.json`, the report digest that goes up, the inbox that comes down, and the CLI. A node has an `id`, a `layer`, an `owner`, a `parent` (or null) and `children`. This is the node as `factory report --json` shows it; the files keep each fact once (`factory.yaml` holds identity, owner, layer, parent and children).

```json
{ "id": "acme-web", "layer": 1,
  "owner": { "display": "Ana", "github": "ana-x" },
  "parent": { "address": "file:///home/example/work/acme-factory", "id": "acme" },
  "children": [
    { "kind": "worker", "id": "web-checkout", "pane": "@worker=web-checkout" },
    { "kind": "worker", "id": "web-search", "pane": "@worker=web-search" }
  ] }
```

### 5.2 Layers and roles (F-4)

- **Layers count from the bottom.** Workers are layer 0. Their managers are layer 1. The managers of layer-1 nodes are layer 2, and so on. A new top layer changes no node below it.
- **The role comes from the layer.** A node does not choose its role. factory sets it from `node.layer` and the recipe's role template for that layer.
- **Each layer has its own role template.** Every node on one layer uses the same template. A node on another layer uses another template, because a different layer works differently (F-4). The `software` recipe has these:
  - layer 0, **worker**: runs the work cycle (plain or devflow) on one track of one project. Text: `.factory/roles/worker.md`, which every worker reads. factory renders it from the package and from the tracked `setup/roles/worker.md` (§4.3).
  - layer 1, **coordinator**: manages workers across one or many projects (the Orchestrator today). Text: `coordinator/CLAUDE.md`, which factory renders from the package and from the tracked `setup/coordinator.md` (§4.3). The rendered file holds the managed blocks. One block, `projects`, lists the projects of the node: the id, the setup and the stage-to-command map of each. `init`, `recipe variant` and `upgrade` write it from `recipe.projects[]`. So the coordinator knows that it runs one plain project, one devflow project, or both. Two coordinators with different project sets have the same text except this block.
  - layer 2, **manager**: manages coordinators. It handles priorities, capacity and the requests across its children, and does no PR-level work. A first template, which the owner edits when that layer becomes real.
  - layer 3, **director**: manages managers. FAC-M8 adds a separate template for it.
  - A layer above 3 has no template yet. A node on a layer with no template gets the `safety` block and no role block. `doctor` warns and names the layer. The recipe or the owner adds the template, and no node below changes.
- **All children of a node are on one layer**, the layer just below it. `factory node add-child` refuses a child from another layer. `factory worker new` refuses on a node that is not on layer 1.
- A worker is a layer-0 node with no factory folder of its own. Its inbox and the pointer to its last-seen file live in the factory folder of its parent (`.factory/workers/<id>/`), and the last-seen file itself in `.factory/state/heartbeat/`.

### 5.3 Addresses

- A child is named by a relative path from its parent: `acme/acme-web/web-checkout`. A path is unique because each id is unique among its siblings.
- A transport says how to reach a node. factory has one transport: `file://<absolute path of the factory folder>`, on the same machine (F-13). It has the four calls of the comms module (§4.12): `send`, `deliver`, `report` and `ping`. The config refuses any other address, for example `ssh://` or `https://`. A remote transport can come later behind the same four calls, with no redesign.
- A parent reaches a worker only through the parent node of that worker. It never types into a grandchild's pane.

### 5.4 What goes up

`factory report --json --since <cursor>` returns one digest:
- node id, layer, factory version, report schema version, and the cursor for the next read;
- worker states and context use (from the last-seen files);
- board counts by state and by each owner field of §4.10 (for example a priority; with no owner field, by state only), and the items in progress;
- milestone events since the cursor (PR ready, merged with SHA, released with version, blocked);
- the requests, each with its **origin path** (for example `acme/acme-web#D-4`);
- the reports of the node's own children, already merged (a rollup).

So a node at any depth sees its whole subtree in one call. The digest is also written to the event file `.factory/outbox/` by script, so the facts do not depend on the model's memory. The event file and `report --json` hold the fields that §4.14 lists.

### 5.5 What goes down

- **Assignments:** an assignment or a decision record goes to the assignment folder of a worker (§4.12) or to the inbox of a child node. The decision record comes from `factory decide`. It goes to the origin node's `inbox/`, through each node on the path. `factory decide read` records nothing. Each relay adds its own id to the record's `chain`.
- **Priorities:** a parent sends a `priorities` record. The child applies it to its board items and reports the result.
- **Inherited config:** the parent passes only items on an explicit list (limits, the writing style, the safety rules), kept as one constant. Owner identity, accounts and session settings are never passed. FAC-M8 tests this.
- **Owner authority** comes only from the owner. A record carries authority only when its `by` is the owner of the target node and it arrived through the parent channel. If a parent node has a different owner (a team lead over a member's node), its records arrive as **messages** (D-6): the child's owner decides them. "Request" stays the word for an item that waits for the owner (D-59). This is how a team works without a shared founder.
- In a worker pane, factory types only the one-line owner prefix and a pointer to the record (`factory worker relay`, FAC-M5). The record holds the text.

### 5.6 Where state lives, and how a parent reads it

Each node keeps its state in its own factory folder (§4.3). A parent never reads or writes a child's files directly, except through `deliver` into the child's inbox. It reads the child only through `report`. Then the file format inside a node can change at an upgrade, and only the versioned report format is a contract.

### 5.7 What the CLI does now, so that a layer needs no redesign

- `factory.yaml` has `node.layer`, `parent` and `children` from day one, also in a node with no parent.
- Every request and every event carries an origin path, also at depth 1.
- `factory status` is a view of `factory report`. There is one code path, not two.
- The tmux session name is the node id, not a fixed `orchestrator`. Two nodes on one machine do not collide.
- The heavy-test lock is per machine and is shared by every node on it.
- Every parent and child address goes through the transport interface, also with `file://` only. So a remote transport later changes no caller.

What the CLI must not assume:
- a fixed top layer, or a fixed depth;
- one owner for the whole tree;
- that a parent is a Claude session (a person with only the CLI can be a parent);
- that a parent and its child run the same factory version.

## 6. Safety defaults

Each standing rule goes into a new setup in two ways. The text goes into the managed blocks of `CLAUDE.md` and the role templates. Where a script can enforce the rule, factory enforces it in code, so a model error cannot break it. The table states each rule, not the current state. The milestone that the row, or the section that the row names, gives is the milestone that builds the code control. The first table holds the rules of every factory. The second table holds the rules of the software recipe.

**Rules for every factory**

| Rule | Text (managed block) | Code enforcement |
|---|---|---|
| Every session keeps the permission checks of Claude Code | yes | factory starts each session in the one permission mode that keeps these checks, and accepts no other mode. |
| Never skip permissions | yes | factory has no option that skips permission prompts. `doctor` reports a factory folder or work copy whose settings skip permission prompts, and `start` stops (§4.3, "Stops and warnings"). |
| A relay server for the model calls only when the owner sets one, and only when it answers | yes | factory uses a relay server only from the local config (§4.6). It checks that the server answers before each start, and in `doctor` and `status`. If the server does not answer, the start stops and the message names the fix. A direct start is an explicit choice. `doctor` sends this check only for a factory folder that passes the registration check (§4.3). |
| No relay server keys or passwords in output | yes | The relay server setting holds no keys, and `doctor` refuses a value that looks like a password or a token there. Output shows only the name, the host and the port of the relay server. |
| A denial is final; another session does not do the denied step | yes | `worker relay` (FAC-M5) refuses a text that asks a worker to run a command that the node recorded as denied. A message from another session never carries the authority of the owner (§4.12). |
| Never invent the owner's consent | yes | `worker relay` types owner input only for a decision that the owner recorded, or for an action inside the scope of an active standing delegation that the owner recorded. Only `factory decide` records an owner decision: it needs a terminal window and refuses inside a factory session. A board comment, label or assignee change is never a proof, with any account setup. |
| A board result is never owner consent | no | factory checks each result of a board connector against the schema of the contract, and refuses a result that fails. A board result is data. Only `factory decide` writes a decision record, in a terminal window outside a factory session. A page answer and a board answer only show, and wake the agent (§4.10, §4.15, FAC-M11). |
| Decisions stay private | yes | `doctor` fails when the decision store is public, and warns when it is not set (§4.10). |
| No secrets in output | yes | No command prints the value of a secret setting. `doctor` refuses a value that looks like a password or a token in a shared file of the factory folder. A list of running programs shows only the number, the run time and the name of each program. |
| Workers never ask the owner directly | yes (role texts) | none (the model follows the text) |
| The coordinator instructions never reach a worker | yes | The factory folder has no instruction file at its top. The coordinator text is in `coordinator/CLAUDE.md`, and no project copy or work copy is inside or above that folder (§4.3, the instruction-file rule). |
| The saved state changes only through factory | yes | `init` and `upgrade` turn on a guard for the state folder, from the text of the package. The guard refuses a change that removes an item id from the board. Every change of the saved state goes through factory. The board commands refuse (exit 4) when the guard is off, and `doctor` and `start` warn. The remedy is `factory upgrade`, or the manual step that the message names when `upgrade` can not repair the guard. |
| Resource limits | yes | `worker new` checks the limits of the machine. |
| Look before typing into a session | yes | Before factory types into a session, it reads the screen of that session, refuses when a question box is open, clears the input line, and checks that the text arrived. Only one part of factory types into a session, and each typed text is short (§4.12). |
| Supported platforms only | no | Every command refuses on Windows outside WSL, the Linux part of Windows, and says how to use WSL (§4.7). |

Engineering note: the permission mode is auto mode. `session.permission_mode` accepts only `auto`, and every launch adds `--permission-mode auto`. "Never skip permissions" stops with exit 4.

Engineering note: the relay server is a proxy. Every launch clears `ANTHROPIC_BASE_URL`, then sets it only from `proxies` in the local config. The answer check is a health check; on failure the default is `stop`, and `direct` is the explicit choice. For a config in a parent folder, `doctor` sends no request and warns to run with `--home DIR`. For a factory folder that fails the registration check, `doctor` sends no request and the check fails. `doctor` warns when the variable is set in the shell. Output never shows user info, query strings or headers of the base URL.

Engineering note: the denied commands are a `denied` list in the state folder. Owner input is the owner prefix, typed only for a record in `decision-log.json` with `by: owner`. `decide read` records nothing. Only `factory decide` records `by: owner`, with every board kind, and the account of a board event does not matter (D-128 A). "No team board" is the `local` board.

Engineering note: no command prints env values. A shared file is a file that the config repo tracks. Process lists show only pid, elapsed time and command name.

Engineering note: the state guard is a set of three hooks of the state repo, and git runs them. The hooks are not tracked files. `init` and `upgrade` write them from the text of the package into the guard folder `factory-guard` in the git folder of the state repo: `.factory/.git/factory-guard/`. The folder holds the files `pre-commit`, `pre-merge-commit` and `pre-applypatch`. Each file has mode 755 and the same text. The setting `core.hooksPath` holds the absolute path of the guard folder. Each hook runs `factory state guard`. Git runs `pre-commit` for `git commit`, `pre-merge-commit` for a `git merge` that makes a merge commit, and `pre-applypatch` for `git am`. The hook runs the Node program and the script of factory by their absolute paths. First, it tests with the shell that both exist. If one is gone, it prints one line that names `factory upgrade`, and it exits 1, so the commit stops. A Node update, a second install or a moved package changes a path. Then the guard is off, and each checked commit in `.factory/` stops with that line until `factory upgrade` writes the hooks again. The hook refuses a commit that removes an item id from `board.json`, a commit that removes the file, and a commit that changes `board.json` to a text that it can not read. A commit that does not change `board.json` passes. A closed item keeps its id.
When the `board.json` of the last commit can not be read, the hook walks back through the commits that changed the file, on the line of first parents, to the last board that it can read. It reads at most 100 older commits of the file (`stateGuard.historyBound` in `src/names.ts`). A commit that repairs the board is a normal commit: the new board must be readable and must keep every item id of that last readable board. The hook names each lost id. If the history of the file holds no readable board, no id can be lost: a readable new board passes, and so does a commit that removes the file. If the bound ends the walk first, the hook stops the commit (exit 1). Then one board passes: a readable new board that is exactly the same file (the same object id) as `board.json` at one of the next 400 older commits of the file, the 101st to the 500th (`stateGuard.restoreBound`). The remedy is to restore the file from such a commit with `git -C .factory restore --source=<commit> --staged --worktree -- board.json`, and to commit it. Any other board stops. A read of git that fails also stops the commit. So does a last commit that git can not read (the quiet check of HEAD exits with a code other than 0 and 1).
The guard is on when the setting, the entries of the guard folder, the mode of the hooks and the bytes of the hooks all match the package. A new path of the Node program or of the script (a Node update, a second install, a moved package), or a moved folder, turns it off. `doctor` and `start` warn when the guard is off, and their exit codes stay the same. `start` and `upgrade` keep working. The remedy is `factory upgrade`.
The install can not repair some cases. The plan value `unsupported` marks them: `.factory/.git` is a file, a link or another folder; the path of the program of factory is not known; the guard folder is a link, is not a folder, is not at its real path, or holds more than 64 entries. For these cases, `init`, `upgrade` and the dry run of `upgrade` warn with the cause and a manual step, and go on (exit 0). The warnings of `doctor` and `start` name the manual step.
Before they write the guard, `init`, `upgrade` and the dry run print one warning that lists the hooks that stop running. They are the hook files in `.factory/.git/hooks` that are not `.sample` files (when `core.hooksPath` is not set), the hooks in the folder that another setting of `core.hooksPath` names (in the local config, or in a global or system config), and the extra entries in the guard folder that the install removes. Git runs only the hooks of the guard folder, and factory runs none of the others.
The board commit helper refuses (exit 4) when the guard is off, with the remedy of the case. It also checks the item ids itself before it commits. Every git step that factory runs in the state folder runs with hooks off and with the file monitor off (`core.fsmonitor=`, an empty value), and it runs no program that the local git config of that folder names. A key `filter.` or `hook.` in that config stops the state steps (exit 4), also in a new state repo that copied the key from the git template folder. The ready check of the state repo stops for every staged change, also a staged change of a submodule pointer.
One lock file, `.factory/locks/state.lock`, covers every step that changes the state repo and commits it. The file holds an owner token, `<pid>-<16 hex characters>`. A step that ends removes the file only when it holds its own token. A second writer waits (20 tries, 250 ms apart). At the bound, it stops with exit 1 and names the lock. A lock file that is older than 300 seconds counts as left by a process that ended. The next writer takes it over and writes its own token. Three steps only warn, write nothing and go on, with exit 0: the claim of the active machine by `start`, the clear of the mark by `shutdown`, and the clear of the mark in the end step of `reboot`.
The stops and warnings of the guard are in the table of §4.3, "Stops and warnings".
Accepted limit (D-10 A): the commit option that skips hooks, a `-c core.hooksPath` option, or a change of the config skips the guard. The board commands then refuse, and `doctor` warns. Git runs none of the three hooks for some commands, so the guard does not check them: `git revert`, `git cherry-pick`, `git rebase`, `git reset`, a `git merge` that fast-forwards, and a `git pull` that fast-forwards. A `git reset` and then a commit is not checked either, because the hook compares the new board with the board at the moved HEAD. Every write of a board file goes through the board commit helper. The other state writes do not use it: the mark of the active machine, the files that `upgrade` writes, the render and the marker of `init`. They keep working when the guard is off.

Engineering note: factory targets a session by its tmux pane id. It captures the pane first and refuses an open dialog. Only `src/comms/` types into a pane, and a typed line has at most 300 characters.

**Rules of the software recipe**

| Rule | Text (managed block) | Code enforcement |
|---|---|---|
| One session per work copy | yes | `worker new` refuses a work copy that another worker uses. |
| Merges follow the approval point `merge` (F-6, D-52) | yes | `merge: owner`: `pr merge` needs an owner decision or an answered ask for that PR and head SHA. `merge: delegated`: `pr merge` needs one proof of approval and one proof of assignment (§6.1). In both cases it passes `--match-head-commit <full SHA>` only after `check` passed at that SHA, and refuses when the head changed. `--admin` only by the node, at the pinned head. |
| Releases follow the approval point `release` | yes | `release: owner`: every release waits for the owner's go. `release: delegated`: `release check` needs an owner-approved release scope that names the version (§6.2). `release check` and `release verify` only check; they do not publish. |
| Never delete another worker's files; look before removing | yes | `copies clean` is a dry run by default and refuses a work copy with unpushed work or a path that a worker or resume file names. |
| One heavy test suite at a time | yes | `lock run` takes the machine lock. |

factory never reads or writes under `~/.claude/` (settings, rules, skills, transcripts or session files). It writes only to three places: the factory folder, the `.claude/settings.local.json` of each work copy (the last-seen hook, D-47), and the per-user files of §4.3 (the factory list, the approval records and the setup acceptances), which are outside `~/.claude`.

**Approval points.** A step of the work that needs an approval is an approval point. The recipe lists its points. The owner sets the mode of each point. The default for a new node is `owner`: every point waits for the owner.

| Point (software recipe) | Values | Default | The proof when the value is `delegated` |
|---|---|---|---|
| `merge` | `owner`, `delegated` | `owner` | One proof of approval and one proof of assignment for that work (§6.1) |
| `release` | `owner`, `delegated` | `owner` | An owner-approved release scope: the items and the version (§6.2) |

The rules:
- **The list is shared, the mode is personal.** The list of points comes with the recipe choice, so it is in the shared file. The mode of each point is in the local file (`approval`, §4.4), because a delegation is owner authority, and each machine has its own approval record.
- **The owner sets a delegation.** A delegation needs an approval record that the owner writes in a terminal window outside a factory session. §6 ("What the guards do not prove") says what this does not prove. The owner sets it with `init` (the prompt, or `--approval <point>=<owner|delegated>`). To change a mode later, the owner runs `factory init` again in the factory folder, in a terminal window outside a factory session. `init` then asks for each approval point again, and the new answer replaces the old mode. `factory decide` answers decisions only; it sets no approval mode. `init --yes` writes `owner` only. `init` writes the records after its last write, the entry in the factory list, so a failed run leaves no record. When a record cannot be written, `init` still succeeds, prints a warning that names the point, and the point counts as `owner`. The warning also names the remedy: run `factory init` again in a terminal window outside a factory session. A delegated approval counts only for work that the owner approved and assigned.
- **The approval record.** A delegation is real only with an approval record. The record names the node id, the real path of the factory folder, the point, the mode and the time. Only the approval record writer writes it. The writer needs a terminal window and no `FACTORY_SESSION`, with no exception. The store is a per-user file in the state folder beside the factory list, outside every factory folder, with folder mode 700 and file mode 600. A reader refuses a file of another user or a file that others can write. The store keeps only the newest delegation record for each node id, factory folder and point. A release scope (§6.2) is a record of its own kind, with its own key, so it never replaces a delegation record. The store refuses a file over its size cap, a named number in `src/names.ts`. A record file inside the factory folder or the state folder does not count.
- **Standing delegations (G-4, FAC-M5).** A standing delegation is a decision record of the owner with a scope and no end time. The scope is one or more action names from a fixed list in `src/names.ts`, for example "reset a worker". The list is fixed in the core on purpose, for safety: a setup edit can never widen what a standing delegation lets the coordinator do. The list holds only actions that every factory has. A need of one owner, for example this workspace's "approve a blocked board write of a worker", is an example of the sample setup, and it joins the core list only by a design change. A recorded owner denial always wins over a standing delegation: `worker relay` refuses an action that the node recorded as denied, also inside the scope. The owner writes a standing delegation with `factory decide`, in a terminal window outside a factory session, like every owner decision. `worker relay` names the action that it types for. It types the owner prefix for an action inside the scope, and refuses an action outside it. The FAC-M5 plan adds the action argument to `worker relay` in §4.2. A later owner decision ends it. `start` and `doctor` list each active standing delegation with its scope and time. A standing delegation is not an approval point: it never sets the mode of a point, and it never counts as a proof of §6.1 or §6.2.
- **The effective mode.** A matching record is a delegation record with the same node id, the same real path and the same point. A release scope is never a matching record.

  | Local value | Newest matching record | Effective mode |
  |---|---|---|
  | `owner` | any, or none | `owner` |
  | `delegated` | none | `owner`, and `doctor` warns |
  | `delegated` | `owner` | `owner` (an `owner` record ends a delegation) |
  | `delegated` | `delegated` | `delegated` |

- **A move ends a delegation.** A record names the real path of the factory folder. So a move of the folder ends each delegation, and the owner sets it again.
- **The text follows the setting.** With `owner`, the coordinator text and the fixed rules say that each point waits for the owner. With a recorded delegation, they name the proof that the recipe states for the point. `init` renders the text before it records a delegation, so the text of a new factory names the owner for each point. `factory upgrade` renders it again after that delegation. A second `init` that changes the mode of a point renders the text again in the same run, in two steps. The first step comes before any record is written, and it counts each changed point as `owner`. The second step comes after the records, and it follows the modes that count, so a point whose record failed stays `owner`. A run that changes no mode renders nothing, and a block that was edited stays as it is, with a warning. The fixed rules have no fixed merge or release line.
- **Delegations are visible.** `start` and `doctor` list each active delegation with its time.
- **The setup acceptance is not an approval record.** It has its own writer and its own store, and it writes only its own kind. So `init --yes` can never write an approval record (§4.3).

**What the guards do not prove (D-10 A).** The guard can not prove that the owner, and not another program of the same user, gives the answer. The same limit applies to the setup accept prompt and to the origin of an entry in the factory list. These controls stop mistakes, and they do not replace the permission checks of Claude Code. FAC-M5 adds a control outside factory that makes the gap smaller but does not close it. A state folder that the user links into `~/.claude` is not detected.

The same limit (D-10 A) covers a board plugin. It runs inside factory with the rights of the user. It reaches the files, the logins of the board CLIs, the network, the state files and the decision log. The install is the trust decision of the user (D-140). A time cap cannot stop a plugin that blocks the process. A plugin result is never a proof. The check of the decision log and the approval records finds an edit by hand or by another tool. It does not find a program that writes a new valid record (FAC-M11, §4.15).

### 6.1 Software recipe: what counts as approval and assignment (D-52)

With `merge: delegated`, `pr merge` needs two proofs: the owner approved the work, and the owner assigned it to a worker or a track. The proof of approval is one of three forms:
1. **A decision.** A record in `decision-log.json` with `by: owner` that approves the work. The record names the work: a PR, an item or a track.
2. **An ask.** An ask item (§4.10) for the PR or the work item, with the answer `approve` recorded by `factory decide <D-n> approve`. The owner types it in a terminal window outside any factory session.
3. **An approved plan.** An ask or a decision item that names the plan file (its path and its commit SHA), answered `approve` with `factory decide` in the same way. The plan text itself proves nothing.

The assignment is direct or by a decision:
- Direct: the proof of approval names the worker or the track.
- By a decision: a second record by the owner names the worker or the track for that work.

Only a `factory decide` record proves approval or assignment (D-128 A). A board event never does, with any account setup: a comment, a label, an assignee change and a review only wake the coordinator and show what was written (§4.10, "Board accounts").

These do not count:
- chat text;
- a comment, a label, an assignee change or a review on the board, from any account;
- a record that names another PR or head SHA;
- a commit author or a `Status:` line in a file. Agents can commit with the owner's own account, so a commit author proves nothing.

An approval in chat becomes a proof when the owner enters it with `factory decide`, in one of the three forms. With `merge: owner`, only a decision or an answered ask for that PR and head SHA counts; a plan does not.

An open question of the owner blocks the merge (D-52). `factory check` gives `NOT READY` while the PR has an open ask or an open request.

### 6.2 Software recipe: releases (D-57)

D-57 is answered: the release is an approval point of its own, with the values `owner` and `delegated` (OD-1). The default is `owner`: every release waits for the owner's go. With `release: delegated`, the proof is an **owner-approved release scope**: the items and the version that the owner approved for release. The owner writes the scope through the approval record writer (§6), with the same guards as a delegation. The scope is a record of its own kind. Its key is the node id, the real path of the factory folder, the project and the version. So a new scope never ends or changes a delegation, and the effective mode of §6 reads only delegation records. `factory release check` refuses (exit 4) when no owner-approved release scope names the version. The owner writes the scope with `factory release scope <project> <version>`, in a terminal window outside a factory session, and runs `factory release check` again. The approval of the work (§6.1) does not include the release. `release check` and `release verify` read only and publish nothing in every case. FAC-M5b builds the check and its test.

## 7. Generic names

The setup uses Dean's name and devflow's words in many places. factory uses these names; a node shows the owner's display name in the views.

| Today | In factory |
|---|---|
| founder, Dean | owner (the display name from `factory.yaml`) |
| lane | worker |
| workflow pack | recipe (and its setup) |
| On Dean, `on-dean.json`, `dean-review.html` | requests on the board (the `local` files and the old page until FAC-M3) |
| board, `board.json` | board items |
| merge order | queue |
| brief | assignment (`.factory/orders/`) |
| clear or compact between phases | session reset (commands `worker reset` and `self reset`) |
| merge gate | `factory check` |
| release check and verify | `factory release check|verify` |
| Orchestrator | coordinator (the layer-1 role); the session name is the node id |
| lane protocol | worker role template (the tracked `setup/roles/worker.md`, rendered to `.factory/roles/worker.md`) |
| `.devflow/` (workspace state) | `.factory/` |
| `DEAN_DIR` | `FACTORY_HOME` |
| `/devflow:plan` … `/devflow:release` | stages `plan`, `build`, `review`, `fix`, `release` |
| Code, Validate, Test agents | implementer, verifier, tester agent kinds |

The v2 design used other words. D-59 replaced them. This table maps each v2 word to the v3 word. The scan of the docs does not read this table.

| v2 word | v3 word |
|---|---|
| cell | worker |
| andon | request |
| work order | assignment |
| changeover | session reset |
| staging | queue |
| inspect | check |
| ship | release check (software recipe) |

Every user-visible name sits in `src/names.ts`, and a test fails on a stray literal. So a rename changes one file plus the tests. Every name of the table in §4.1 has a plain description in `docs/glossary.md` (at most 25 words), and `factory help words` prints them.

### 7.1 Dean's shop-floor words (F-1)

Dean found 11 words for the physical layout of a factory. The list ends with the heading "machinery and automation hardware", which has no items. The paste has no missing text. So no word comes from that heading. Each row says where factory uses the word or why it does not. Dean can change any row; the answer then goes into a decision record.

| # | His word | In factory |
|---|---|---|
| 1 | assembly line | Not used as a name (D-59). A worker does all the steps for one track, so there is no line of stations. The ordered steps are the **work cycle** (§4.9). |
| 2 | functional cells | Not used as a name (D-59). The new word is **worker** (§4.1): a session that does all the steps for one track of one project. |
| 3 | linear sequential layout | Not used. The steps of a track run in order inside one worker, so the layout of the folders (§4.3) is not a line. |
| 4 | receiving inbound docks | Used in meaning: the `inbox/` folder is where assignments arrive (§4.12). The name stays `inbox`, because it is the plain word. |
| 5 | staging areas | Not used as a name (D-59). The new word is **queue**: the order of the finished work that waits for an approval point (§4.1). |
| 6 | workstation cells | Not used as a name (D-59). The new word is **worker**, the same word as row 2. |
| 7 | buffer zones | Used in meaning: the `Todo` state of the board is where work waits for a worker (§4.9, `tracker.states`). The name is not used. |
| 8 | quality inspection | Not used as a name (D-59). The new word is **check**: `factory check`, the merge check (§4.2). |
| 9 | pack out | Not used as a name. The package check before a release is a part of `factory release check`. |
| 10 | shipping docks (his text: "chipping docks") | Not used as a name (D-59). The new words are `factory release check` and `factory release verify`: the release check before a release, and the check after it (§4.2). |
| 11 | metrology lab | Used in meaning: `factory doctor` checks the tools and `factory machine` measures the machine (§4.2). The name is not used. |

## 8. Migration of this workspace

`factory adopt ~/work/<workspace>` imports the current setup into a node. A dry run comes first. The adopt runs only when all workers are idle and pushed. It does these steps (FAC-M7):
1. It makes a factory folder next to the projects, for example `~/work/<workspace>-factory` (§4.3). The Orchestrator moves there from the workspace root.
2. It moves the owner text of the Orchestrator into the tracked file `setup/coordinator.md` of the new factory folder, and keeps a copy of the old `~/work/<workspace>/CLAUDE.md` in `.factory/backups/`. Before the adopt, the owner splits the old `CLAUDE.md` into three files: the owner text, a runbook, and a list of the parts that factory retires, each with the command that replaces it. `adopt --owner-text <file>` names the owner text. `adopt` moves only that file, not the whole `CLAUDE.md`, so the owner text and the blocks of factory never give two rules for one job. With no `--owner-text`, the dry run stops (exit 2) and names the split step. `init` renders it to `coordinator/CLAUDE.md`. It leaves no coordinator text in any `CLAUDE.md` on the path from a work copy to the root: the old file is removed, or it keeps only lines that every worker may read. The dry run shows this change, and the owner confirms it. Only then do the workers stop loading the Orchestrator instructions (F-3). Without this step, they still load them, because the file sits above every work copy.
3. It moves `decision-profile/` and the roadmaps into the owner layer, at `.factory/decision-profile/` and `.factory/roadmaps/`, keeps the git history (a `git mv` in the state repo), and writes `factory.yaml` from the facts in CLAUDE.md §13. It puts the runbook and the retire list of step 2 into `setup/`, and writes the board conventions as the owner fields of the setup (§4.10). An upgrade never overwrites any of these files (§4.5, "The clay rule"), and the adopt changes none of their content.
4. It imports the board and the On Dean items into the `local` board files. The review page and its scripts stay as the owner view, and the owner can still answer there. In M5-1b the page only reads the local files. A page answer that records through the owner store is a FAC-M5b criterion. FAC-M3 moves the items into GitHub issues with a private repo as the decision store (F-2). It does not retire the page (TB-5).
5. It asks the owner to set the approval point `merge` to `delegated` (D-52). The owner confirms in a terminal window, and the approval record writer records it (§6).
6. It adds the devflow setup to the devflow projects.
7. The workers of today become workers in the window `workers` (F-8). Each old worker gets a name from its current work item (F-21c), and `status` shows no worker whose name and work item differ.
8. It runs one worker through the real Subswitch and records the run (D-45).

### 8.1 Parity table

Each part of the setup of today (§1.1) has an owner in factory: a command, a milestone, or "retired, because X". The column Status is `planned` until the milestone ends. Then it is `done` or `retired`. A row is due at the last milestone that it names, in build order. `scripts/check-parity.sh <milestone>` reads this table and fails on any due row whose Status is not `done` or `retired`. At the end of FAC-M7 it must pass for FAC-M7. At the end of FAC-M3 it must pass for all rows.

| Part (§1.1) | In factory | Milestone | Status |
|---|---|---|---|
| `~/work/<workspace>/CLAUDE.md` | The `coordinator` and `safety` blocks of `coordinator/CLAUDE.md`, rendered from `setup/coordinator.md`; `adopt` moves the text (step 2) | FAC-M2, FAC-M7 | planned |
| `protocol.md` | The worker role template: the tracked `setup/roles/worker.md`, rendered to `.factory/roles/worker.md` | FAC-M2 | planned |
| `status.md` | The output of `factory status` | FAC-M5 | planned |
| `respawn-map.md` | The last-seen files, `factory reboot` and the restore of §4.11 | FAC-M4 | done |
| `orchestrator-resume.md` | `.factory/resume/` and `factory self reset` | FAC-M4 | done |
| `roadmaps/` | `.factory/roadmaps/`; `adopt` moves the files | FAC-M2, FAC-M7 | planned |
| `board.json`, `board.md`, page | The `local` board files and `factory item`; then the board items | FAC-M5, FAC-M3 | planned |
| `lanes.json` | The last-seen files and `factory worker list` | FAC-M4 | done |
| `on-dean.json`, `decision-log.json`, `on-dean.md` | `factory request`, `factory decide` and `.factory/decision-log.json` | FAC-M5 | planned |
| `board-detail.md`, `board-log-*.md`, `done.md` | The item body and its comments on the board; `item close` records the reason in the state repo | FAC-M5 | planned |
| `briefs/` | Assignments in `.factory/orders/`; `worker new --assignment` | FAC-M2, FAC-M4 | done |
| `review/dean-review.html`, `review/README-decision-pages.md` | Kept as a supported owner view that the owner can choose (TB-5). It reads the local files. A factory command that renders or publishes it comes in FAC-M5b | FAC-M7, FAC-M5b | planned |
| `boardlib.py`, `render-board.py`, `render-dean.py` | Kept for the `local` period. Retired: `factory item` and the board UI replace them | FAC-M3 | planned |
| `board-set.sh` | `factory item add|update|move|close` | FAC-M5 | planned |
| `lane-set.sh`, `lane-lib.sh` | `factory worker` commands and the last-seen files | FAC-M4 | done |
| `state-commit.sh`, `git-hooks/pre-commit` | The board commit helper and the delete-guard hooks that `init` and `upgrade` install | FAC-M5 | planned |
| `layout.sh`, `lane-summon.sh` | `factory layout` and `factory worker summon` | FAC-M4 | done |
| `md-view.sh` | Retired, because the slot runs `factory item list` and needs no `glow` | FAC-M5 | planned |
| `lanes-refresh.sh`, `lanes-table.py` | `factory worker list` and `factory worker watch`. The limit: the watch reports a pane that ended, a dialog that waits and a worker that looks stalled; the recovery after a usage limit (`worker recover`) comes in FAC-M5 | FAC-M4 | done |
| `live_boxes.py` | `factory machine` | FAC-M4 | done |
| `tmux-save-map.sh`, `tmux-restore-lanes.sh` | The last-seen files, and `factory start` on a dead server resumes the recorded workers (§4.11) | FAC-M4 | done |
| `tmux.conf` | Retired, because `factory start` and `factory layout` set the options of each session, and the restore needs no resurrect plugin | FAC-M4 | retired |
| `scripts/test-*` | The test suite of the factory repo | FAC-M1 | done |
| `priorities/apply-labels.sh` | Retired, because it was a one-time script. `factory issues audit` finds unlabeled issues | FAC-M5 | planned |
| `decision-profile/` | `.factory/decision-profile/`; `adopt` moves the content | FAC-M2, FAC-M7 | planned |
| `state/`, `locks/` | `.factory/state/`, `.factory/locks/`; `factory lock run` | FAC-M2, FAC-M5 | planned |
| Global rules in `~/.claude/rules/devflow/` | Retired as a part of the setup, because devflow installs them and factory never writes there (§2.1). The role templates hold factory's own short rules | FAC-M2 | planned |

### 8.2 Manual operations and their commands

The workspace of today has 42 manual operations on the board, the requests, the decisions and the workers. This table gives each one a command, or "drop" with the reason. The column Board operation names the operation of the board connector that the command calls (§4.10, §4.15). The operations are `item add`, `item update`, `item move`, `item close`, `item list`, `item note`, `track add`, `track list`, `track update`, `decision ask`, `decision read`, `doc link`, `doc unlink` and `changes read`. "Not a connector operation" means that the command works on the state of factory only and calls no board connector. A write goes to the board first (board-first, §4.10). A note that names a milestone gives the milestone of that row. The other rows follow the milestones of §4.2.

| # | Manual operation today | In factory | Board operation | Note |
|---|---|---|---|---|
| 1 | New board item: `board-set.sh new` with state, priority, type, title, text and track | `factory item add` | `item add` | |
| 2 | Change one field of an item: title, text, priority, type, issues or worker (`board-set.sh`) | `factory item update` | `item update` | |
| 3 | Change the state of an item, and its priority (`board-set.sh`) | `factory item move --state` | `item move` | |
| 4 | Change the stage of an item at a milestone of a worker (`board-set.sh`) | `factory item move --stage` | `item move` | |
| 5 | Set the track of an item (`board-set.sh`) | `factory item update --track` | `item update` | |
| 6 | Mark an item done: merged with a PR, then released with a version (`board-set.sh`) | The merge command and the release flow call `factory item close` with the result | `item close` | Only these flows set merged or released. |
| 7 | Remove an item with a reason, and write the line in `done.md` (`board-set.sh`) | `factory item close --reason` | `item close` | The reason goes to the state repo and to a note on the item. |
| 8 | Add and remove a track (`board-set.sh`) | `factory track add`, `factory track update` | `track add`, `track update` | FAC-M5 sets the form that removes a track. |
| 9 | Change the merge order and the release flag (`board-set.sh merge set`, `merge remove`) | `factory queue set`, `factory queue show` | Not a connector operation | The order of the finished work is not a field of an item. |
| 10 | Attach an assignment, report, design or plan to an item, in the field `docs` (`board-set.sh`) | `factory item doc <id> <file>` | `doc link` | A link stops the command (§4.3, "Stops and warnings"). |
| 11 | Render `board.md` and the Board view of the page (`render-board.py`) | Drop | None | The board tool or the `artifact` connector shows the board. With `local`, `factory item list` shows it. |
| 12 | Set the priority label of the linked GitHub issues (CLAUDE.md §11) | `factory item update --priority` | `item update` | The `github` connector sets the label. |
| 13 | Add an item that waits for the owner, by hand in `on-dean.json` (CLAUDE.md §11) | `factory request add` | `decision ask` | `request add --options FILE` asks a decision. |
| 14 | Change a waiting item: the section (now or later) or the state (CLAUDE.md §11) | `factory request update` | `item update` | The options of a decision do not change after the ask. |
| 15 | Remove a done waiting item, and write the line in `done.md` (CLAUDE.md §11) | `factory request close --reason` | `item close` | |
| 16 | Add or remove a doc of a waiting item (`dean-set.sh`) | `factory item doc`, `factory item doc --remove` | `doc link`, `doc unlink` | |
| 17 | Render `on-dean.md` and the data block of the page (`render-dean.py`) | Drop | None | The board tool or the `artifact` connector shows the waiting items. |
| 18 | Write a row of `decision-log.json` by hand (CLAUDE.md §11) | `factory decide <D-n> <option>`, in a terminal window outside a factory session | Not a connector operation | The command records the decision. `decide read` shows answers and records nothing (§4.10). |
| 19 | Write a decision record and link a principle (CLAUDE.md §11) | `factory decide <D-n> <option> --principle ID` | Not a connector operation | The wording of the principle stays model work. |
| 20 | Publish the review page (CLAUDE.md §8) | The `artifact` connector prints one `PUBLISH:` line, only when the page changed, at most once for each interval | Internal to the `artifact` connector | The line names a file path. The page text never goes into model tokens. |
| 21 | Read the answers of the review page (CLAUDE.md §8) | `factory decide read --from FILE` | `decision read` of the `artifact` connector | The command shows the answers and records nothing. A page answer is a board event, not a proof. To record it, the owner runs `factory decide`. |
| 22 | A comment on the page with `@claude` wakes the coordinator (CLAUDE.md §8) | `factory watch`, with no doorbell (D-101) | `changes read` | |
| 23 | Write a dated line in `board-log-<month>.md` and the detail in `board-detail.md` (CLAUDE.md §11) | `factory item note <id> <text>` | `item note` | The history of the state repo replaces the month log. |
| 24 | Commit each state change (`state-commit.sh`) | Drop | Not a connector operation | Each write of factory is one state commit, so no manual step stays. |
| 25 | Read `board.md` and `on-dean.md` at the start of a session, to see what is left (CLAUDE.md §11) | `factory item list`, `factory request list` | `item list` | The output is short. |
| 26 | Set the fields of a worker row: doing, state, next and item (`lane-set.sh`) | The last-seen files and `factory worker list` | Not a connector operation | FAC-M4. |
| 27 | Set the item that a worker works on (`lane-set.sh working_on`) | `factory item update --worker` | `item update` | The work item port of `status` reads it. |
| 28 | Remove a worker row (`lane-set.sh`) | `factory dismiss` | Not a connector operation | FAC-M4. |
| 29 | Update the track roadmap at a milestone (CLAUDE.md §11) | The roadmap stays a file. `factory track update --milestone` sets the current milestone | `track update` | The text of the roadmap stays model work. |
| 30 | Close a GitHub issue after a merge (CLAUDE.md §8) | `factory item close` | `item close` | The rule about who may close an issue does not change. |
| 31 | Copy text to the clipboard (`pbcopy`, CLAUDE.md §8) | Drop | None | It is a way to reach the owner, not a board operation (§4.12). |
| 32 | Type the go of the owner in the pane of a worker (CLAUDE.md §8) | `factory worker relay <worker> --decision D-n` | Not a connector operation | It types only from a decision that the owner recorded (§4.12). |
| 33 | Give the status when the owner asks (CLAUDE.md §8) | `factory status` | `item list` | |
| 34 | Watch `state/lanes-stopped.txt` (CLAUDE.md §11) | `factory worker watch` | Not a connector operation | FAC-M4. |
| 35 | Refresh the resume file (CLAUDE.md §11) | Drop | Not a connector operation | The worker writes its resume note in its own assignment folder, and `worker reset` reads it (§4.6). No command is needed. |
| 36 | Refresh the workers table every 30 seconds (`lanes-table.py`): `Lane`, `Ticket`, `State`, `In phase for` and `Context`. The state comes from the transcript. | `factory worker list --follow` in the slot of the window view | Not a connector operation | The table has the columns `WORKER`, `WORK ITEM`, `STATE`, `IN STAGE` and `CONTEXT`. `STATE` is the stage and one word of a closed list. The word comes from hook events, never from the transcript (§4.11, FAC-M5b). |
| 37 | Show the tracks block of `board.md` and of the page (`tracklib.py`, `render-board.py`) | `factory track list` | `track list` | The tracks view (§4.11, FAC-M5b). |
| 38 | Show the board pane: `md-view.sh` shows `board.md` with `glow` | The slot of the window view runs `factory item list --follow` | `item list` | The board pane (§4.11, FAC-M5b). |
| 39 | Show the boxes above the workers table: Waiting on you, Machine (`live_boxes.py`) | `factory request list`, `factory machine` | `item list` for `request list`; `machine` is not a connector operation | The boxes (§4.11, FAC-M5b). |
| 40 | Collect the token meter every 5 minutes (`usage-collect.sh`, `usage-pass.py`): sync, and the history of each item and worker | The token meter package collects. `factory status --usage` reads the result. No `usage collect` command exists. | Not a connector operation | FAC-M5b. The usage view reads the state history of the local board. |
| 41 | Show the token estimate on each open item, for example "est. 3-6% of the Claude week" (`boardlib.py`, `live_usage.py`) | `factory item estimate`; `item list` shows the mark | Not a connector operation | FAC-M5b. |
| 42 | Show the usage block of the live board (`live_usage.py`) | `factory status --usage` | Not a connector operation | FAC-M5b. |

## 9. Decisions

### v1 (2026-11-01)

Dean accepted every recommendation in this table on 2026-11-01 (D-45 A, with the name `factory`; D-47 yes for the last-seen hook). D-46 B set the merge rule; D-52 replaced it for this workspace.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Language | (a) TypeScript on Node; (b) Bash like mars; (c) Go single binary; (d) Python | **(a).** It fits your engineering rules (Zod, Result types), devflow is TypeScript, and npm is the existing channel. Bash has no schemas and a JSON state model is hard in Bash 3.2. Go removes the Node need, but it is a new stack in your repos. |
| 2 | Name and package | (a) `factory`, npm `@dean0x/factory`; (b) another name | **(a), with a check.** The npm name `factory` is taken; `@dean0x/factory` is free (checked 2026-11-01). A company named Factory sells an AI coding agent, so people can confuse the two. |
| 3 | License | MIT, Apache-2.0, private | **MIT**, like mars and devflow. |
| 4 | Public or private | (a) private now, public later; (b) public now | **(a).** The repo `dean0x/factory` is private (D-49). It goes public when a team member installs it from a release (FAC-M10), if Dean agrees. |
| 5 | State folder and config | (a) `.factory/` and `factory.yaml`; (b) other names | **(a).** Never `.devflow/`, because devflow writes there. |
| 6 | Where a single-project node lives | (a) always a separate node folder; (b) also inside the repo | **(a).** v2 makes it a rule: the home is never inside a repo (F-3). |
| 7 | Last-seen hook | (a) factory writes a hook in the `.claude/settings.local.json` of each work copy; (b) keep the reads of Claude Code's private files | **(a).** v2: it replaces every read under `~/.claude` (F-9). |
| 8 | Conflicts of §1.3 | my proposals in §1.3 | **Accept them.** v2 updates the answers (§1.3). |
| 9 | Remote transport | (a) SSH only at first; (b) a small server | **Replaced by F-13 (2026-11-02):** one machine only for now, with `file://` addresses only. |
| 10 | Python and glow | (a) port the Python scripts and the viewer into factory; (b) keep them as external tools | **(a).** Fewer tools on a new machine and one test suite. The board tool removes most of the render scripts (F-2). |
| 11 | Team defaults | (a) each member owns a factory folder; a lead's node sends messages (§5.5); (b) one shared owner | **(a).** No name or account is fixed, and nobody acts on another person's authority. |
| 12 | Where the Subswitch settings live | (a) factory core has only a generic `proxies` entry; a preset is in the devflow setup; (b) the preset is in factory core | **(a).** The default setup then names no devflow tool. |

### v2 (2026-11-02)

| Id | Decision |
|---|---|
| D-49 | The code goes to the private repo `dean0x/factory`. No public visibility, no npm publish, no tag. **Changed (2026-11-06):** private annotated early-access tags (`git tag -a`) `v0.2.0-ea.N` only, each pushed after the owner's go. The hand-over gives the full commit SHA that the tag points to. The install checks that the tag points to this SHA, and then builds from the SHA, not from the tag name. A pushed tag is never moved, deleted or used again (a fix gets the next N). No GitHub Release and no npm publish. The release workflow skips these tags (§4.7). |
| D-51 A | No second review of FAC-M1 now. The review of the v2 code covers the setup and upgrade code. The review of the FAC-M2 PR names `init`, `upgrade` and `doctor`, and its summary lists those files (roadmap, FAC-M2). The script `scripts/check-review-scope.sh SUMMARY` checks box 15 of FAC-M2. The summary must have a section with the exact title "Setup and upgrade code (D-51 A)". That section must list the six paths `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/doctor.ts`, `src/upgrade/apply.ts`, `src/upgrade/plan.ts` and `src/upgrade/spec.ts`. Exit code 0: the section lists every path. Exit code 1: the summary or the section is missing, or a path is not listed. The output names each path that is not listed. Exit code 2: no summary was given. |
| D-52 | This workspace: approved and assigned work merges when the checks pass. Releases are not part of it. factory offers the rule as an owner choice, the value `delegated` of the approval point `merge`. §6.1 lists the proofs. |
| D-53 | Dean accepted the proposals F-1 to F-10 as a set ("Changes from v1" above). |
| F-13 | One machine only for now. No `ssh://` transport, no remote readiness check and no remote child. The config refuses any address but `file://`. |
| D-56 | The build order is FAC-M2, M4, M5, M6, M7, M5b, then M3, M8, M10, M9 (roadmap-v2; FAC-M10 is the release milestone, added after the intent check; FAC-M5b follows FAC-M7: D-133 A). |

**D-57 is answered (v3).** F-6 asked whether "a-z" includes releases. The release is an approval point of its own, with the values `owner` and `delegated`. The proof for `delegated` is an owner-approved release scope (§6.2). FAC-M5b builds the release check.

### Intent fixes (2026-11-02, table IF)

An independent check of the design against Dean's notes found open points. The Orchestrator decided them. The decisions are final until Dean changes them.

| Id | Decision |
|---|---|
| IF-1 | The review page of today and its scripts stay as the owner view until FAC-M3. FAC-M7 keeps them. FAC-M3 retires them (§4.10, §8). **Changed (2026-11-08):** FAC-M3 does not retire the page (TB-5 to TB-7). |
| IF-2 | The proofs of approval follow D-52 as written: a decision, an ask or an approved plan. A plan counts only through an ask or decision item answered `approve` by the owner; a commit author is no proof. The assignment is direct or by a decision; an assignee or label is no proof (D-128 A). `check` gives NOT READY while a PR has an open ask or an open request (§6.1). |
| IF-3 | Releases have their own approval point, `release`, with the values `owner` and `delegated`. D-57 is answered (§6.2). |
| IF-4 | "Codex" in note F-3: factory starts Claude Code. The config names one agent command for each node, and only `claude` is built (§4.6). |
| IF-5 | Each layer has its own role template. FAC-M8 adds the template of layer 3. `doctor` warns when a layer has no template (§5.2). |
| IF-6 | The board connector reads comments, label changes, assignee changes and open or close changes. Card moves stay out for now. `start` starts `watch` (§4.10, §4.11). |
| IF-7 | The board scope is a node default plus an override for each project, as in devflow. `tracker set` and `tracker status` exist. Jira has `site` and `key` (§4.4, §4.10). |
| IF-8 | The word list of Dean ends with the heading "machinery and automation hardware". A table in §7.1 maps each of his 11 words. |
| IF-9 | The state repo can push to a private git remote that the owner names. `init --state-from` clones it on a second machine (§4.3). |
| IF-10 | A board event is never an owner proof, with any account setup. A `factory decide` record from a terminal window outside a factory session is a proof (D-128 A, §4.10, §6.1). |

### v3 (2026-11-02)

Dean gave F-14 to F-21, D-59 and D-60. The Gate 1 and Gate 2 answers and the later answers closed the open points. The decisions are final until Dean changes them.

| Id | Decision |
|---|---|
| D-59 | Plain words. The names of v2 become worker, request, assignment, session reset, queue, check and release check. "Request" means only an item that waits for the owner (§7). |
| D-60 | One folder. The factory folder is a git repo that holds the config, the clones, the coordinator folder and the work copies (§4.3). |
| D-1 A | The coordinator folder is not tracked. `init` renders `coordinator/CLAUDE.md` on each machine from the package and from `setup/coordinator.md`. Everything else that a person needs to make the factory again is in the tracked folder. |
| D-3 B | `upgrade` refuses a FAC-M1 node with a project, because the project sits outside the new folder and has no clone URL. It says to make the node again. A FAC-M1 node with no project upgrades. |
| D-4 A | The warning for a second active machine goes to FAC-M4, with a named test that reads a state folder from the FAC-M3 state pull. |
| D-5 A | A config counts only when the factory list has its folder, the entry has the node id of the config, and the factory marker is present. `init` registers a received or moved factory (§4.3). |
| D-6 | The record from another owner is a "message". The merge check is `factory check <pr>`. The folder of the work copies is `work-copies`. |
| D-7 A | The owner decides about the old local paths in the git history before FAC-M10. The history is not rewritten. |
| D-8 A | `init` registers a folder that holds both config files, after a yes in a terminal window or with `--yes`. It refuses a folder whose git repo tracks the local file or a path under `.factory/` or `coordinator/`. Registration is not an approval. |
| D-9 A | `tracker.decisions` stays shared (§4.4). FAC-M8 decides again if each owner needs a separate place for decisions. |
| D-10 A | The terminal-window guard stays. Design 6 says that it cannot prove that the owner acts. FAC-M5 adds a control that factory does not run itself. |
| D-11 A | The plain-words table is in `docs/glossary.md`. The table uses "factory marker", "setup acceptance" (the verb is "accept"), "work copies" and the folder `work-copies`. |
| D-13 A, R1 | The owner accepts the hash of `setup/coordinator.md`. `start` in a terminal window shows a change and asks. Otherwise it stops and names the command (§4.3). |
| D-14 A | A local file that others can write, that another account owns or that is a link stops the command. A mode with read bits only is set to 600 with a notice (§4.4). |
| D-15 B | A rule that allows a whole tool is a warning. Only a setting that skips permission prompts stops. |
| D-16 A | A moved factory, and a factory list entry with no origin, count as received. |
| D-128 A | factory does not care which GitHub account anyone uses. It never takes a GitHub comment, label, assignee or review as an owner approval or proof. Owner approvals come only through `factory decide` (the owner store), and later through a review page. A separate account for the agents is optional, the owner's own GitHub choice (§4.10, §6, §6.1). |
| D-133 A | Dean, 2026-11-08: a new milestone FAC-M5b comes after FAC-M7. It takes ten criteria out of FAC-M5: the release commands (`release check`, `release verify` and `release scope`) with their config test, the extension points for a desk, the acceptance of shared check commands, `copies sync` and `copies clean`, `scripts/budget-check.sh`, and the usage view, the forecast and the token estimate (F-22, F-23, F-24). The move of this workspace (FAC-M7) does not need them (roadmap-v2). |
| TB-5 to TB-7 | Dean, 2026-11-08, about the board of each track. His words: "I think that every track [...] needs its own mini board. The main review desk, the main board, should have the high level of each one of the tracks. If you zoom in, if I [...] click one of the tracks, I would see the board of that track." "I think it would be good to understand, on each ticket, what stage it is at." "I actually like the artifact. I think I want to keep it supported." "I think a user should be able to choose." "Anyway, regardless, we should maintain the local board." The mark [...] shows a cut. TB-5: the review page stays a supported owner view that the owner can choose. It reads the local files. In M5-1b it only reads, and a page answer that records through the owner store is a FAC-M5b criterion. TB-6: factory always keeps the local board, with any board kind and any owner view. TB-7: the board has tracks, and each item has a stage. The recipe gives the list of stages (§4.10). This row supersedes the part of F-17 (Changes in v3, point 6) and the part of F-2 (Changes from v1, point 2) that say factory has no review desk, not even as an option. factory still builds no desk of its own. IF-1 changes in the same way: FAC-M3 does not retire the page. |
| R2 | On your own factory, a tracked instruction file or Claude settings file is a warning. On a received factory, the owner accepts such files with the setup text, by one hash (§4.3). |

## 10. Risks

- **Claude Code changes its hook events, status line JSON or CLI flags.** All Claude Code calls sit in one module, with a test that `doctor` runs against the installed version. The last-seen hook uses only documented hook events.
- **A dead proxy stops every worker that uses it.** The health check runs before each launch, the default is `stop` with a clear fix, and the views show which workers use a proxy (§4.6).
- **tmux typing is fragile.** factory types only constant lines through one module, checks the hook state and the pane start time first, and refuses a screen that shows an option list.
- **Board limits and cost.** The APIs of the board tools have rate limits, and reads cost time. `factory watch` reads at a fixed interval with a bound per run, and caches in `.factory/state/`. A board that does not answer is "unknown", never "no answer". Each board call has a time cap, an output byte cap and a result cap (§4.3, "Caps").
- **A false decision answer.** Anyone with access can comment on a decision item. A board comment or label only wakes the coordinator and shows the answer. The owner enters the decision with `factory decide`. A comment or a label records nothing, so a false answer on the board changes no decision. `decide read` shows the author and the link.
- **A public decision store.** `doctor` fails on it (§4.10).
- **A board plugin has full reach.** A plugin runs inside factory with the rights of the user (D-140). Factory loads it only from the global npm folder, with a valid package name and the contract id in its `package.json`. Factory reads that file before any plugin code runs. The install is the trust decision, and each stop that concerns a plugin says so. Nothing stops a plugin that blocks the process or reads the files of the user (§6, "What the guards do not prove").
- **The board holds the truth, so offline work only reads (D-141 B).** A write goes to the board first. The cache changes after the board answers. A board that is down fails the write, and no queue holds it. A write with no answer is "unknown": run `factory watch`, then retry. Each item carries its factory id, so a retry makes no second item. `factory decide` works offline.
- **Page privacy is a manual check.** Factory cannot check that the page of the `artifact` board is private. It asks the owner once for each node. `doctor` warns each time and never passes the check (§4.10).
- **The record checks have limits.** The check of the decision log and of the approval records finds an edit by hand or by another tool. It does not find a program that writes a new valid record (§6, D-10 A). The check of item text finds a value that looks like a password or a token. It does not find private facts in plain language.
- **The renames and the schema 2 migration touch every part.** They come first in the roadmap, before more code uses the old names. The schema 1 → 2 migration has a test, and every name sits in `src/names.ts`.
- **Scope grows.** The roadmap builds the CLI in stages. Each stage is useful for this workspace before the next one starts. Other recipes and other boards wait until the `software` recipe on GitHub works.
- **Two copies of the setup during the move.** The adopt is one step with a dry run. The old page and scripts stay as the owner view and read the same `local` files, so there is one source of truth. FAC-M3 retires the old render and board scripts, and a search finds no process that calls them. It does not retire the review page (TB-5).
- **The status line of the owner is a user setting.** A work copy setting replaces it. The wrapper of §4.6 passes its output through, and a test checks this.
- **A release publishes by mistake.** The publish job needs a protected environment, a gate script and a recorded decision id (§4.7).
