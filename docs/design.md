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
6. **No desk, few stops (F-17).** The design has no review desk of its own. It lists the extension points instead (§4.14). Only a security boundary stops a command, and every stop prints the command that fixes it (§4.3).
7. **One board for many repos (F-19).** Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Not checked yet for Jira and Linear: FAC-M9 (§4.10).
8. **Lifecycle (F-20, F-21).** The commands `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` have a milestone and a test each. The design defines an idle worker (§4.2, §4.11).
9. **Leftovers.** The docs hold no local machine path (docs check 8). D-57 is answered: the release proof is an owner-approved release scope (§6.2).

## Changes from v1

Dean gave the feedback F-1 to F-10 on v1, and accepted the proposals as a set (D-53). v2 makes these changes:
1. **Names from a real factory (F-1).** A session that works on one track is a **worker**. The kind of factory is a **recipe**. node, owner and project stay. New factory words where they are clearer: `factory check` (the merge check), `factory release check`, **request** (an item that waits for the owner), **assignment** (a written task or a decision that goes down), **session reset** (a clear or compact between phases), **queue** (the merge order). v3 changed some of these names to plain words (D-59). §7 maps the old names. See §4.1 and §7.
2. **The team's board tool holds the board (F-2).** factory gets one board connector: GitHub (the default), Jira or Linear. A `local` connector keeps the items in files, for a node with no network or no board account, and it is the test double of the connector. factory has no review desk of its own, not even as an option (F-17). A decision is a labelled item on the board, and a script reads the answer. The decision store is private by default. See §4.10.
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

## Summary for Dean (one page)

**What factory is.** `factory` is a program that you run in a terminal window. It creates and runs the orchestration setup of this workspace on any machine, for any person. `factory init` makes a factory folder: the config, the coordinator text, the role texts and your decision notes. `factory start` starts the screen layout and the coordinator session. Other commands do the multi-step jobs that the Orchestrator does by hand today. The program never contains a name, an account or a path. It reads them from the person who runs `init`.

**One core, many kinds of factory.** The core knows nodes, layers, roles, sessions, the assignments that go down, the reports that go up, the decisions of the owner, the board, capacity, the saved state and approval points. A **recipe** gives the rest: the role text of each layer, the work cycle, the approval points, the kind of output and the board mapping. A recipe for a marketing factory can be the work cycle "write a post, check it, publish it", with one approval point before the post goes out. The first recipe is `software`. Other recipes, for example research or content, come later.

Software recipe: projects are git repos, the output is a pull request, and the approval points are the merge and the release. It has two setups: plain Claude Code (the default) and devflow.

**Plain words (D-59).** A session that works on one track is a **worker**. A worker does all the steps, from the plan to the finished work, for one track of one project. Items that wait for the owner are **requests**. A written task is an **assignment**. The order of the finished work that waits for an approval point is the **queue**. `docs/glossary.md` has the table of plain words.

**The team's board, not our own desk.** The work items, the requests and the decisions live in GitHub, Jira or Linear. Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Jira and Linear are a separate question. Not checked yet: FAC-M9. The owner answers a decision with a comment such as `/choose B`. A script reads the answer, so the answer costs no model use. The place that holds the decisions is private by default.

**Where things run.** One factory is one folder, and the folder is a shared repo, the config repo. The coordinator runs in `coordinator/` inside it. Workers run in work copies of the projects, under `work-copies/`. So a worker never loads the coordinator text. The config travels as a shared repo: clone the config repo on another machine and run `factory init`. Personal values and credentials stay in a local file that the share list leaves out.

**Layers.** Every node has the same mechanics: the config, the report that goes up, the assignments that come down, and the program. Each layer has its own role. Layer 0 is the workers. Layer 1 is the coordinator. Layer 2 manages coordinators. Each layer above 2 gets its own role when it becomes real. A new top layer changes no node below it.

**Scripts save model use.** The largest costs today are the check of finished work (25–60k tokens of model use each time), the status round (40–80k), a restart of all workers (60–100k) and worker creation (20–30k). Each becomes one command with a short verdict as output, about 1–4k tokens. A rough total: 50–70% less coordinator cost on routine work.

**Safety is in the code, not only in the text.** factory starts a session only in auto mode, so Claude Code keeps its own permission checks. The program has no flag that skips permission checks. A proxy (a server that passes the model calls on) is an explicit config option, and factory checks that it answers before each start. factory types owner-authority input only for a decision that the owner recorded. A decision answer counts only when it comes from the owner's board account. Each approval point waits for the owner, unless the owner delegated it. A delegation needs an approval record that the owner writes in a terminal window outside a factory session (§6 says what this does not prove).

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
| Board and owner-item updates (§11) | Edit JSON, render, commit, republish, label sync | 5–8 calls, 8–15k | `factory item …`, `factory request …` (board writes, labels built in) | 1–2 calls, 1–3k; no render step, because the board tool shows the board |
| Reading the owner's answers (§8) | Read the page database, record each decision, relay it | 3–6 calls, 5–10k | `factory decide read` (a script reads `/choose` comments and labels from the owner's account) | 1 call, <1k |
| Worker clear or compact, then a new assignment (§12) | Capture, idle and pushed checks, resume file check, C-u, type, verify, protocol line, new assignment | 8–10 calls, 10–15k | `factory worker reset <worker>` with `--clear` or `--compact` | 1 call, 1k |
| Release pre-check and post-check (§7) | Version, changelog, package contents, registry; after: registry, clean install, smoke | 6–10 calls, 10–20k | `factory release check <project>` / `factory release verify <project> <version>` | 1 call each, 2–3k |
| Issue audit and labels (§8) | List issues, classify, apply labels | 5–10 calls, 30–100k | `factory issues audit` (finds unlabeled or conflicting issues; the model classifies only those) | 1 call plus the classification of new issues only |
| Decision record and profile update (§1) | Record file, log line, principle, decision-log row, commit | 4–6 calls, 8–15k | `factory decide read` records it; `--principle <id>` links a principle | 1 call, 1–2k (the principle wording stays a model job) |
| Work copy cleanup (§4) | List, check tip on remote, search board and resume files, remove | 5–8 calls, 5–10k | `factory copies clean` (dry run by default) | 1 call, 1k |
| Typed founder-authority input (§12) | Map, capture, Escape/C-u, type, Enter, verify | 4–6 calls, 4–6k | `factory worker relay <worker> --decision <D-n>` | 1 call, <1k |
| CI watch (§10) | Monitor or loop on `gh pr checks`, then read | 2–4 calls, 3–8k | `factory pr watch <pr>` (exits when CI ends; for a background task) | 1 call, <1k |
| Stopped-worker watch and limit recovery (§11, §12) | Loop on `lanes-stopped.txt`; capture each worker; answer the dialog; nudge | 5–15k | `factory worker watch` (exits on a change); `factory worker recover` | <1k plus |
| Moving an outside session into tmux (§12) | ListAgents, session file, stop, resume, rename, protocol line | ~6 calls, ~6k | `factory worker adopt <name>` | 1 call, <1k |
| Resource check (§8) | 4 commands | 1–4 calls, 1–2k | built into `worker new`; `factory machine` | 0–1 call |
| Orchestrator self-compact (§12) | Resume file, C-u, queue `/compact` | ~3 calls, 3–5k | `factory self reset` (checks the resume file, then queues `/compact`) | 1 call |

Rule for every command: the output is a short verdict for the model (`READY`, or `NOT READY: 2 open threads, CI pending`). `--json` gives the full facts. The default output never prints a diff, a log or a transcript.

The board tool removes most of the render scripts of today (`render-board.py`, `render-dean.py`, the page data block). Its UI shows the board and the requests.

## 4. CLI shape

### 4.1 Concepts

- **Node**: one session with a layer and an owner. It has an optional parent and children. A node on layer 1 or above has a factory folder. A worker (layer 0) has none: its state lives in the factory folder of its parent. The coordinator is a node on layer 1. The word *node* stays because it fits a session on any layer.
- **Factory folder**: the folder of a node on layer 1 or above. It is a repo of its own, the config repo, so a person can share it. It holds the config, the setup text, the clones of the projects and the work copies (§4.3). In code and flags it is `home` or `root` (`--home`, `FACTORY_HOME`).
- **Layer**: the level of a node, counted from the bottom. Layer 0 is the workers. The layer sets the role (§5).
- **Role**: the instructions, the commands and the reports of one layer. A role text from the recipe gives them.
- **Owner**: the person whose decisions the node carries. Each team member is the owner of their own nodes.
- **Worker**: a session (layer 0) in one work copy. It does all the stages of the work cycle for one track of one project.
- **Work copy**: a separate copy of a project folder for one worker. It is under `work-copies/` in the factory folder, and the share list leaves that folder out. A command that runs in a work copy still finds its factory (§4.3).
- **Project**: a unit of work that the node manages, with its own settings and setup.
- **Recipe**: the kind of factory: role texts, work cycle, approval points, output kind and board mapping (§4.9).
- **Board**: the system that holds the work items, the requests and the decisions (§4.10). The config key is `tracker`.
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
factory status [--json]                     # each worker with its state, its work item and its idle state; the digest for the owner
factory dismiss <worker> | --idle           # end a worker and free its work copy; --idle lists the idle workers first, and the owner picks (§4.11)
factory doctor [--fix]                      # check the tools, their versions, the platform, the safety settings, the last-seen notes and the board
factory upgrade [--dry-run]                 # update the saved state and the parts of the text files that factory writes (§4.5)
factory machine                             # the use of the processors, the memory and the disk against the limits
factory help words                          # the plain description of each factory word (docs/glossary.md)

factory project add|remove|list
factory recipe show                         # the project table of the coordinator, from the config
factory tracker set <id> [--project P] [--items X] [--decisions X]   # change the board of the node, or of one project (§4.10)
factory tracker status                      # the board of each project, and the check of its decision store
factory state remote <url|path> | push | pull   # set the private backup place of the saved state, and copy the state to it or from it (§4.3)

factory worker new <name> --project P [--copy PATH] [--assignment FILE]
factory worker list [--json]                # the live workers table
factory worker send <worker> (--file F | --text T)   # put a message in the inbox of the worker, and ring its doorbell
factory worker relay <worker> --decision D-n   # type owner input from a decision that the owner recorded
factory worker reset <worker> (--clear | --compact) [--assignment FILE]   # the session reset
factory worker stop|resume <worker>
factory worker summon <worker> [--for 15m]
factory worker watch | recover | adopt <name>
factory inbox next | ack <n>                # read the next message of the inbox of this session, and mark it as read (§4.12)
factory layout                              # build the windows again

factory item add|update|move|close|list|import ...   # work items: the board
factory request add|list|close ...          # items that wait for the owner
factory decide ask <D-n> --options FILE     # a decision item in the decision store
factory decide read [<D-n>] [--principle ID]   # read the answers with no model use; record them in the decision log and the profile
factory decide <D-n> <option> [--note T]    # the owner answers in a terminal window, when there is no team board (§4.10)
factory queue set|show                      # the order of the finished work that waits for an approval point
factory watch                               # read the new board changes, a limited number of times; wake the coordinator (§4.10)

factory node tree | children | add-child | remove-child
factory report [--json] [--since CURSOR]    # digest for the parent (§5)
factory self reset                          # the session reset of the coordinator itself
factory adopt <path> [--dry-run]            # bring the setup of today into a node (§8)
factory hook <event> | statusline           # Claude Code calls it; not for people (§4.6)
```

Engineering note: `start` attaches to the tmux session when it runs, and `restart` resumes the worker with its session id. `doctor` checks the hooks that write the last-seen notes. `upgrade` migrates the state and the managed blocks. `machine` reads CPU, memory, disk and load. `state remote` sets the private git remote of the state folder. `worker send` writes an inbox record and types a one-line doorbell. `decide read` reads the answers by script. `decide <D-n>` is the answer path of the `local` board. `watch` makes bounded reads. `--json` prints JSON, `--dry-run` changes nothing, and `--state-from` takes the work state from another machine (§4.3).

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
- `status` lists each worker with its state, its work item and its idle state.
- `dismiss <worker>` and `dismiss --idle` end a worker and free its work copy. `--idle` lists the idle workers first, and the owner picks.

§4.11 defines "idle", "pushed" and "free", the stop scope and the recovery after a machine restart.

Global flags: `--home PATH`, `--json`, `--quiet`, `--no-color`. A command finds the factory folder in this order: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml`; else the factory list, which matches the current folder to a project path (§4.3).
Output rule: the default output of a job command (a command that replaces a manual job of §3) has at most 20 lines, and the verdict is on the first line. `docs/token-budget.md` gives the size budget of each job.
Exit codes: `0` success, `1` failure, `2` usage error, `3` "not ready" (a check verdict), `4` safety refusal. A check verdict is not an error, so scripts can tell them apart.

### 4.3 Factory folder layout

> **Receiving a factory.** You get the config repo of a factory from another person, or from another machine of yours.
> You need the `factory` program first. Another developer can not install it before FAC-M10, because the repo is private until then (D-49).
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
  .factory/                         # private state repo with the delete-guard hook; ignored
    node.json                       # the factory marker: schema_version, created_with, block versions
    roles/worker.md                 # the worker role text that every worker reads; rendered on each machine from the package and from setup/roles/worker.md
    decision-log.json               # decisions read from the board, with the answer and its author
    queue.json                      # the queue
    board.json  waiting.json        # the items, only with the `local` board (§4.10)
    decision-profile/               # format, index, principles, decisions
    roadmaps/  orders/  resume/
    workers/<id>/inbox/             # assignments and records for each worker
    inbox/  outbox/                 # messages from the parent, reports to the parent (§5)
    state/  locks/                  # ignored: last-seen files, board cache, pane map, locks
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
- The hook settings of the coordinator (§4.6): on a new, a received and a registered factory, `init` makes sure that `coordinator/.claude/settings.local.json` holds the hook for each event and the status line wrapper. Its checks and its stops come before the first write, like every other check of `init`. The question comes after the last write, because the coordinator folder exists then, and after the setup acceptance. In a terminal window `init` prints the exact change and the file, then asks (the default is no). `--yes` agrees outside a factory session. With no terminal window and no `--yes`, and inside a factory session with `--yes`, `init` writes nothing, prints the change and exits 2. An answer of no does not fail `init`: it goes on without the hook, and prints one line that names the effect (no last-seen record, so a restart or a reboot can not resume the session by its id) and the way to add the hook later (run `init` again and answer yes). When the entries are in place, `init` asks nothing and writes nothing. A received factory keeps its stop: with no terminal window, `init` stops on a received factory that tracks setup text or other files, also with `--yes`.
- `--state-from SRC` clones a state repo (a git URL or a path) into `.factory/` instead of an empty one, and runs `doctor`. This is how a second machine gets the work state (FAC-M3).
- If a step fails, or if `init` cannot write the factory list, it exits 1 and removes only what this run made. A second `init` in the same folder then works. A file or folder that was there before the run stays as it was.
- `factory start` then starts the session. The user never has to know the folder.

**How a command finds the factory folder (F-3).** The order is: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml` (at most 64 levels). The projects are inside the factory folder, so the walk finds it from a clone, from the coordinator folder and from a work copy. Work copies of workers live in one fixed folder under the factory folder, `work-copies/`, and the share list leaves it out. A work copy that sits outside the factory folder has no `factory.yaml` above it. For that case FAC-M4 adds a fallback (OD-7): the lookup asks git for the common git folder of the work copy. That folder is inside the clone of the project, and the clone is inside the factory folder, so the walk goes on from the clone. Then the registration check runs (D-5). A `factory.yaml` counts only when three things are true:
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
- **The one command.** Clone the config repo, then run `factory init` in it. `init` clones each repo and registers the factory on this machine. In a terminal window it asks for these things, in this order: the personal values (the account, that is, the owner fields); the mode of each approval point, with `owner` as the default; the setup acceptance, that is, a yes or a no for the setup text (`setup/coordinator.md` and `setup/roles/worker.md`) and for every other file that the config repo tracks; and a yes or a no for the write of the hook in `coordinator/.claude/settings.local.json`, when `init` writes it (§4.6). Then `factory start` works. With no terminal window, or with `--yes`, `init` stops on a received factory that tracks setup text or other files, so a script can not receive such a factory. Another developer can not install the `factory` program before FAC-M10, so the one command needs a machine that already has the program.
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
| Error (exit 1): a tool is missing (`tmux`, `git`, `claude`, or the board tool such as `gh`) | Any new machine. `doctor` checks the versions (§4.7). | Install the tool, then run `factory doctor`. |
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
| Stop (exit 4): a checked settings file that sets the proxy or the credential of the session (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `ANTHROPIC_CUSTOM_HEADERS` in `env`), or a checked settings file in `coordinator/` or in a project folder that runs a command (a hook, a status line or a key helper). The hook and the status line that factory writes itself do not count. | `start`, `restart`, `reboot`, `worker new` (§4.6). `doctor` reports it. | Remove the setting from the file that the message names, then run `factory doctor`. |
| Stop (exit 4): a security check that can not finish: git fails when it lists the tracked files or when it answers the ignore question for the local file or the state folder, a settings folder holds more settings files than the check reads, a settings folder can not be read to the end, a settings folder or a settings file is a link, or a settings file can not be read in full | `start`. `doctor` reports it. | Fix the problem that the message names, then run `factory doctor`. |
| Stop (exit 4): the safety block is edited or missing | `start`, `doctor` | `factory upgrade --overwrite safety` (it keeps the old text in a backup file). |
| Stop (exit 4): `upgrade --overwrite safety` inside a factory session | `upgrade` | Run `factory upgrade --overwrite safety` in a terminal window outside a factory session. |
| Stop (exit 4): a `delegated` choice with no terminal window, or inside a factory session (the approval record guard) | `init` (§6) | Run `factory init` in a terminal window outside a factory session. |
| Usage error (exit 2): `--yes` with a flag that asks for `delegated` | `init` | Run `factory init --approval <point>=delegated` in a terminal window, with no `--yes`. |
| Stop (exit 4): the local file has a write bit, another owner, or is a link | `start`, `init`, `node`, `upgrade`, `doctor` (§4.4) | For a write bit: `chmod 600 factory.local.yaml`. For another owner or a link: move the file away, then run `factory init` to write a new one. |
| Warning (exit 0): the local file has a mode that others can read | `doctor`, a dry run. Other commands set the mode back to 600 and print a notice. | `chmod 600 factory.local.yaml` |
| Error: a proxy does not answer | Before each start of a session; `doctor`; `status` (§4.6) | Start the proxy, or set `proxy: none` for the worker. |
| Stop (exit 4): the tmux session of that name belongs to another factory, or has no `@factory_home` option | `start`, `shutdown`, `restart`, `reboot` (§4.11) | Run `factory shutdown` in the factory folder that owns the session, or end that session by hand. Then run `factory <command>` again, with the command that stopped. |
| Error (exit 1): `dismiss` of a busy worker, or of a worker whose work is not pushed (`STUCK:`) | `dismiss`, `dismiss --idle` (§4.11) | Finish or move the work item (`factory item move`) or push the branch of the worker. Then run `factory dismiss <worker>` again. |
| Stop (exit 4): `decide <D-n> <option>` or the pick step of `dismiss --idle` inside a factory session | `decide`, `dismiss --idle` (§4.10, §4.11) | Run `factory decide <D-n> <option>` or `factory dismiss --idle` in a terminal window outside a factory session. |
| Stop (exit 4): a release check with `release: delegated` and no owner-approved release scope for the version | `release check` (§6.2) | Run `factory release scope <project> <version>` in a terminal window outside a factory session. Then run `factory release check <project> <version>` again. |
| Stop (exit 4): the decision store is public | `init`, `tracker set` (§4.10). `doctor` fails on it. | `factory tracker set <id> --decisions <private repo>`, then `factory tracker status`. |
| Usage error (exit 2): a hook or status line write, with no terminal window and no `--yes` | `init`, `start`, `worker new` (§4.6). The command writes nothing and prints the change. | Run `factory init`, `factory start` or `factory worker new` in a terminal window, or add `--yes`. |
| Warning (exit 0): a rule that allows a whole tool (for example `Bash` or `*`) in a settings file | `doctor`; `start` prints it | Narrow the rule in the settings file that `doctor` names. |
| Warning (exit 0): a setting that runs a command (a hook, a status line or a key helper) in a settings file of the factory folder, or at a tracked path. The hook and the status line that factory writes itself do not count. | `doctor`; `start` prints it | Check the setting in the settings file that `doctor` names, or keep it on purpose. |
| Warning (exit 0): a setting that approves project MCP servers | `doctor`; `start` prints it | Remove the setting from the settings file that `doctor` names, or keep it on purpose. |
| Warning (exit 0): a tracked instruction file or Claude settings file on your own factory | `doctor`, `init`; `start` prints it | Stop tracking the file (`git rm --cached <path>`), or keep it on purpose. |
| Warning (exit 0): an instruction or settings file of the list in the factory folder or above it, a folder that the walk could not read, or a walk that stopped at 64 folders (see the instruction-file rule) | `doctor`; `start` and `init` print it | Move the file out of those folders, or keep it on purpose. Then run `factory doctor`. |
| Warning (exit 0): a project with no shareable URL (no origin, a `file` URL or a bare local path) | `init`, `doctor` | Add an origin to the repo and set `url` for the project in `factory.yaml`, then run `factory doctor`. |
| Warning (exit 0): text in `coordinator/CLAUDE.md` or in `.factory/roles/worker.md` that does not travel | `doctor` | Move the text to `setup/coordinator.md` or to `setup/roles/worker.md`, then run `factory upgrade`. |
| Warning (exit 0): a `delegated` mode with no matching approval record | `start`, `doctor` (§6) | Run `factory init` in a terminal window outside a factory session. |
| Warning (exit 0): the state shows another machine as active | `start` (FAC-M4) | Run `factory shutdown` on the other machine, then run `factory start` here. |

A factory folder under a linked parent folder works. The link rule checks only the paths below the real folder.

**Caps.** Each cap in these checks is a named number in the code (`src/names.ts`). The token scan of the tracked files stops reading at its cap of files and at its cap of bytes for each file, and it names what it did not scan. A list of tracked files over its cap stops `start` with exit 4 and one remedy line, on every factory. On a received factory it also stops `init`, and so does a file over its byte cap. A settings folder with more settings files than the check reads, and a settings file that the check can not read in full, stop `start` with exit 4 too. The acceptance never covers a partial list or part of a file.

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
  # agent: claude            # FAC-M4: the agent command of this node; only `claude` is built (§4.6)
  permission_mode: auto      # the only value accepted (§6)
  effort: high
  model: default
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count        # adapts to each machine
  context_prepare_pct: 30
  context_max_pct: 40
  # idle_after: 2h           # FAC-M4: a worker with no activity for this time may be idle (§4.11)
tracker:                     # the default board of the node; a project can override it (§4.10)
  kind: github               # github | jira | linear | local
  items: acme/web            # where work items live (a repo, or a project or team scope)
  decisions: acme/decisions  # the decision store; private by default (§4.10)
  # site: "https://acme.atlassian.net"   # jira only: the base URL of the Jira site
  # key: ACME                            # jira: the project key; linear: the team key
  watch_interval: 5m         # `factory watch` read interval
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
      # tracker: { kind: jira, items: WEB, site: "https://acme.atlassian.net", key: WEB }   # FAC-M3: optional override (§4.10)
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
# state:                     # FAC-M3
#   remote: null             # the private place of the work state of one owner
parent: null                 # or { id, address }; the address is file:// only (§5.3)
children: []                 # nodes this node manages, each { id, address } (§5)
```

**The rule.** A key stays local only if it is personal, a credential, or true for one machine only. Everything else is shared. The shared schema refuses a local key, and the error names the key and the local file. A change that adds a proxy entry to `factory.yaml` fails the load, and `start` makes no tmux call. The reason for each key:

| Key | File | Reason |
|---|---|---|
| `schema` | each file | Each file has its own version key. It is not a value that a person shares. |
| `node`, `tracker` (kind, items, decisions, site, key, `watch_interval`) | shared | They describe the factory and its board. |
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
| `sources` | local | True for one machine only. It holds a local path, which never goes into the shared file. Each key names a listed project path. Each value is an absolute path or a `file` URL, with no user name, no `..` segment and no leading hyphen. |
| `state.remote` (FAC-M3) | local | It names the private place of the work state of one owner. |

**The project entry.** `url` is optional: the clone URL (§4.3). `repo` is optional: the GitHub owner and name, for the board. `path` is one folder name, and it is not a reserved name (§4.3). The recipe parses these keys. The core parses the file around them.

**Mode 600.** `init` writes the local file with mode 600. `start`, `init`, `node` and `upgrade` set a mode that has only group or other read bits back to 600, and print a notice. They stop (exit 4) when the file has a group or other write bit, when another account owns it, or when it is a link (D-14). `doctor` and every dry run only warn, and name the `chmod` command. With `factory.yaml` and no `factory.local.yaml`, `start`, `doctor` and `node` exit 2 and name `init`.

- `tracker.kind: local` takes no other tracker key: the items and the decisions stay in `.factory/` (§4.10). The schema refuses `items`, `decisions`, `site`, `key` or `watch_interval` with `local`. Every other kind needs `items` and `decisions`. `jira` also needs `site` and `key`. `linear` also needs `key`.
- A project can name its own `tracker` with `kind`, `items`, `site` and `key`. The decision store stays the one of the node, so the owner answers in one place. A project with no `tracker` uses the one of the node. The `tracker.decisions` key names a place, not the records, so it stays shared (D-9). With the `local` board the records stay in the private `.factory/`.
- `session.agent` (FAC-M4) is the program that factory starts for a session. Only `claude` is accepted. All starts of the agent use this value (§4.6). Before FAC-M4, the schema has no such key, and factory starts `claude`.
- `approval` maps each approval point of the recipe to `owner` or `delegated`. A point that the file does not name is `owner`. The schema refuses a point that the recipe does not list. §6 says what each value means and what proves `delegated`.
- The shared file holds no secret and no local path. `factory doctor` refuses a tracked file with a value that looks like a password or a token. The schema is checked at load with a fixed schema (Zod). An unknown key or a bad value stops the command and names the key. It never falls back to a looser default (from firstmate's fail-closed parse).
- A command that a shared project entry names (a check command of the recipe) runs only after the owner accepts it. No code runs such a command before FAC-M5, which builds the acceptance.
- A FAC-M2 config (the key `cells` or `approval.land`) is refused with a message to make the factory again with `init`.

### 4.5 Upgrades without loss of state

- **State has a version.** `node.json` holds `schema_version`, and `factory.yaml` holds `schema`. Each migration is one pure function from version N to N+1, with a test.
- **The upgrade order:** a dry run that prints the plan, including the move of `CLAUDE.md` into `coordinator/`, the share list in the `.gitignore` of the factory folder and the config repo, and checks every new file against the new schema; a backup to `.factory/backups/<ts>/`; the migrations; the share list, and the config repo with its first commit of the shared files that exist when the folder holds no git repo; one commit in the state repo with the files that the upgrade wrote or moved. The upgrade writes no file under `setup/`. If one step fails, factory restores the backup, removes the config repo that it made, and stops.
- **Managed blocks.** `CLAUDE.md` and the role templates contain blocks between `<!-- factory:begin <name> v<n> sha256=<hash> -->` and `<!-- factory:end <name> -->`. An upgrade rewrites only these blocks. The owner's text outside them stays. If the hash shows a hand edit inside the `safety` block, factory stops and shows the diff. A role block that a person edited stays, with a warning. The owner moves an edit out of a block, or accepts the loss with `--overwrite <name>`. When `upgrade` replaces an edited block, the old text goes to a backup file in the state folder.
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
- factory starts a worker with `env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<proxy base_url>] FACTORY_HOME=<home> FACTORY_SESSION=<id> <session.agent> --permission-mode auto --effort <e> --add-dir <home>/.factory`, in the work copy of the worker. `<session.agent>` is `claude`. It starts the coordinator the same way in the factory folder, with one `--add-dir` for each project path.
- **Proxy.** A session uses a proxy only when the config names one: the override of the worker in `workers.<id>.proxy`, else `session.proxy` of the node. The launch always clears a stray `ANTHROPIC_BASE_URL` from the shell, then sets it only from the config. So a proxy is always a choice that the config shows, never an accident of the shell.
- **Proxy check.** Before each launch, factory sends one bounded request to the proxy's `health` path. If the proxy does not answer, `on_fail` decides:
  - `stop` (the default): factory does not start the session. It prints the proxy id, the failed check and the fix, for example "start the proxy, or set `proxy: none` for this worker".
  - `direct`: factory starts the session with no proxy and records this in the worker state, so the views show it.
  This rule comes from a workspace lesson of 2026-10-16: a dead local proxy stopped all workers for hours. The check stops that failure before it starts.
- **Proxy presets (D-45).** The devflow setup has the preset for Subswitch. The health path is `/__subswitch/health`, and the default port is 4141 (`subswitch serve --port N` changes it). The preset gives `base_url: http://127.0.0.1:<port>` with that port. So the owner changes one number. FAC-M6 tests the preset against a stub server. FAC-M7 runs one worker of this workspace through the real Subswitch.
- `factory doctor` and `factory status` run the same check for each configured proxy. `doctor` sends it when the config passes the registration check (§4.3), also when it comes from a parent folder, from `FACTORY_HOME` or from the factory list. A config that fails the check stops `doctor` with exit 4 before any request, with the reason and the remedy command. The proxy host receives the API traffic of the coordinator, so from FAC-M5 `doctor` warns when a proxy host is not loopback (`127.0.0.1`, `::1` or `localhost`). `doctor` prints `Config: <path>` first, to show which config it uses. `factory worker list` and the workers view show a Proxy column for each worker: `direct`, the proxy id, or `<id> (down)`.
- **Restore and restart.** `worker resume`, `restart`, `reboot` and the restore after a machine restart (§4.11) use the same launch code, so they apply the same proxy rules and the same check.
- **Last-seen hook (decided, D-47).** `factory worker new` writes a hook into the `.claude/settings.local.json` of the work copy. `factory start` writes the same hook for the coordinator in the factory folder. Claude Code calls the hook on SessionStart, UserPromptSubmit (the start of each turn), Stop (the end of each turn) and PreCompact, and the status line command calls it too. The hook writes one line to the last-seen file, `<home>/.factory/state/heartbeat/<session>`: the session id, the event, the time and the context percent. The context percent comes from the status line JSON that Claude Code passes, not from the screen text.
- **The status line is a user setting.** An entry in `settings.local.json` replaces the status line of the owner in that work copy. So factory writes only a wrapper, `factory hook statusline`. It records the percent from the JSON on its stdin, runs the command named in `session.statusline` with the same stdin, and prints the output of that command unchanged. With no `session.statusline`, it prints one short line, `context N%`. factory never reads the settings of the owner to find the command (§6), so the owner names it in the config.
- **Consent for every settings write.** factory never edits user-level Claude Code settings. Before it writes the hook or the status line wrapper, the command (`init`, `start` or `worker new`) prints the exact change and the target file. The target is project or local scope only: `.claude/settings.json` or `.claude/settings.local.json` in the factory folder or the work copy. The write needs a yes in a terminal window, or `--yes`. With no terminal window and no `--yes`, the command writes nothing, prints the change, and exits 2. The remedy is to run `factory init`, `factory start` or `factory worker new` in a terminal window, or to add `--yes` (§4.3, "Stops and warnings"). A status line command that the owner set before keeps working, because the wrapper passes its output through.
- **Status line fields.** The hook payloads hold no percent. The status line JSON holds these fields:
  - The context percent is `context_window.used_percentage`. If it is null or absent, and `context_window.current_usage` is an object, the percent is the sum of its `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`, divided by `context_window.context_window_size`. If neither gives a number, there is no percent. The hook then stores no percent.
  - Both sources can be null early in a session. `current_usage` is null again after a compact, until the next API call.
  - The quota fields are `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage`. They exist only for claude.ai subscribers, and only after the first API response. Each window can be absent. Absent means unknown.
  - The cost field is `cost.total_cost_usd`. It is an estimate at list price.
- **Settings in work copies.** Before a worker starts in a work copy, factory checks the Claude Code settings files of that work copy for a setting that skips permission prompts. If it finds one, the start exits 4 with one remedy line (§4.3, "Stops and warnings"). The check runs for every start of a worker, also for `restart` and `reboot`.
- **Fixtures from the real program.** FAC-M4 captures one payload for each hook event from the installed Claude Code. It commits them as test fixtures. The hook tests parse these fixtures. The four hook payloads come from Claude Code 2.1.318 in print mode (`test/fixtures/claude/payloads.json`). Print mode draws no status line, so the status line payload is built from the field names of the status line docs. The fixture marks it as not captured. An interactive capture replaces it.
- **No reads under `~/.claude`.** The last-seen file gives every fact that the scripts read under `~/.claude` today: the last activity (working, idle, stopped), the session id (to resume a worker after a restart) and the context percent. So no factory code and no role template reads or copies a file under `~/.claude`. The instruction "avoid reads under ~/.claude" is not necessary, and the templates do not contain it. A static test fails on any code path that opens a file there.

### 4.7 Language, platforms, install and distribution

- **TypeScript on Node 22+**, built to one bundled file (from mars: dev mode from source, one bundled file for a release). Zod for config and state schemas, Result types and no throws in the logic (Dean's engineering rules). Commands come from one command table, not from three hand lists (a mars gap).
- **Platforms: macOS and Linux only (F-5).** factory needs tmux, git and a POSIX shell. On native Windows, `factory doctor` refuses with the remedy line `Use WSL, then run "factory doctor" there`. Every other command refuses with a line of the same form that names that command.
- **External tools:** `tmux`, `git`, `claude`, and the CLI of the board tool (`gh` for GitHub). factory replaces `jq`, `python3` and `glow` with its own code, so a new machine needs fewer tools. `doctor` checks the versions.
- **Portable parts:** the heavy-test lock uses `lockf` on macOS and `flock` on Linux. `factory machine` reads memory and load on both systems. The owner's clipboard command is a config value with a platform default. CI runs the full suite on an Ubuntu and a macOS runner. Tests of `lock run` and `machine` run both system paths with fixtures.
- **Install:** `npm i -g @dean0x/factory`, or `npx @dean0x/factory init`, plus a Homebrew formula in `dean0x/homebrew-tap`. An `install.sh` for curl, with a SHA256 check (mars has none). The repo is private now (D-49), so none of these is public yet. FAC-M10 builds them.
- **Release:** one `v*` tag runs the tests, checks that the version is the same in every place, makes the GitHub Release, publishes to npm and updates the tap (from mars `release.yml`). The version lives in one file only.
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
- Idea 2: FAC-M4 (the doorbell inbox, `inbox next`, `inbox ack`; §4.12).
- Idea 3: FAC-M8. The marker is `.factory/node.json`. `ping` returns the id and layer from it. `node tree` prints one line for each child from `children[]` with no folder scan. A folder whose marker names another id shows `mismatch` and receives nothing.
- Idea 4: FAC-M8. One constant lists the config items that a parent passes down (§5.5). A test shows that owner, accounts and session settings never pass.
- Idea 5: FAC-M5 (the report core, with events that scripts write at merge, release and decision) and FAC-M8 (the rollup over children).
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
- the work cycle: the stages, their order, and the proof that each stage ran;
- the checks before an output is final;
- the kind of output (a PR, a document, a data set);
- the board mapping: which item kinds, labels and states the recipe uses;
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
- factory comes with one recipe first: `software`. Its parts are the projects as git repos, the work copies, PRs, the merge check, CI and releases. The plain setup uses plain Claude Code. The devflow setup maps the stages to the devflow commands (§2.2).
- Other recipes, for example research or content, come later. They need no change to the core.
- Cost (F-10): medium now, high later. The split is mostly in this design and in the config schema. The FAC-M1 code already keeps the software parts in a few modules.

### 4.10 Board connector

factory does not build its own review desk. The board, the requests and the decisions live in the team's board tool. The owner chooses the tool in `tracker.kind`. Dean's word is "board"; the config key `tracker` stays.

**One board for many repos (F-19a).** Can one board show the work of many repos? Yes, GitHub Projects can hold issues from many repos. Not verified yet: FAC-M3 proves it with two repos. Factory uses one project for all the repos of a factory. FAC-M3 runs the real commands on two repos before the board connector is built. Jira and Linear are a separate question. Not checked yet: FAC-M9.
- **The bound.** One list call reads one board. It uses `--limit <cap+1>`. If the board holds more than the cap, the output has a line "more than <cap>" and does not print the rest.
- **The filter.** The server filters the list (`--query`), also by repo. The reader does not filter the full list.
- **The owner rule.** The owner of the project must reach every repo that the factory lists. The board shows only the items of the listed repos.
- **The token scopes.** A read needs `read:project`. A write needs `project`.
- **The items of the factory itself.** With `local` they are in `.factory`. With `github` they are issues of the config repo.

**The choice of the board (F-2).** The user picks the board tool at setup, as in devflow. `init` asks "Which board?" in a terminal window (`github`, `jira`, `linear`, `local`) and takes `--tracker <id>`, `--items` and `--decisions`. Later, `factory tracker set <id> [--project P]` changes it, and `factory tracker status` prints the board of each project and the result of the privacy check. `init` and `tracker set` check the decision store before they write anything. They exit 4 when the store is public, and the remedy is `factory tracker set <id> --decisions <private repo>` (§4.3, "Stops and warnings"). A node has one default board, and a project can override it (as devflow does: one machine can work on a Jira repo and a GitHub repo side by side). `item add --project P` goes to the board of P. The decision store is always the one of the node.

**One connector contract.** Every board connector gives the same small set of operations:
- item: add, update, move (change the state), close;
- decision: ask (an item with the options), read the answer;
- doc: attach a file, or link a repo file;
- changes: read comments, label changes, assignee changes and open or close changes since a cursor, each with its author.

**Board connectors.**
- `github` (the default): issues plus a Projects board, through `gh`. factory already needs `gh` for the `software` recipe.
- `jira` and `linear`: the same contract, through their CLI or API. `jira` needs `site` and `key`; `linear` needs `key` (§4.4).
- `local`: files in `.factory/` (`board.json` and `waiting.json`, as in the setup of today), for a node with no network or no board account. It has no changes and no watch: `changes read` returns nothing, and `factory watch` exits at once with a note. `factory item list` and `factory request list` show the items; there is no other UI. The owner answers a decision in the CLI with `factory decide <D-n> <option>`. `local` is also the test double of the connector: the contract tests run against `local` and against each real connector. In this workspace, the review page and the scripts of today stay as the owner view during the `local` period. They read the `local` files (the same format as today). FAC-M3 retires them.
- No review desk. Dean said that the factory has no review desk of its own, not even as an option (F-2, F-17). No board kind and no command makes one. The extension points (§4.14) let a person add a reader.

**Decisions.**
- A decision is an item with the `decision` label. Its body has the question, the options and a recommendation.
- The owner answers with a comment `/choose <option>`, or with a label `choose:<option>`.
- `factory decide read` reads the answer with a script, not with model tokens. An answer counts only when its author is the owner's account on the board (`owner.github` for GitHub). The script records the decision in `decision-log.json`, with the comment link and the author.
- With `local`, `factory decide <D-n> <option>` records the answer with `by: owner`. It needs a terminal window, and it refuses (exit 4) inside a session that factory started (factory sets `FACTORY_SESSION` at each launch). The remedy is to run `factory decide <D-n> <option>` in a terminal window outside a factory session. This guard stops a session from answering by accident. The owner's permission settings are the second guard.
- An *ask* is a decision item for one PR or one work item. The owner answers `approve` or `refuse` in the same way. §6.1 says which answers count as an approval.

**Board identity.** The author of a board event proves the owner only when the agents write with another identity. If the workers and the coordinator use the owner's own account, an agent can post a comment, a label or an assignee that looks like the owner's.
- `tracker.agent_account` names the identity that the agents use: a machine user, or a GitHub App with its own token.
- A board event counts as an owner proof only when two things are true: its author is the owner account, and `tracker.agent_account` is set to another account.
- When `tracker.agent_account` is unset, or equal to the owner account, the account is *shared*. Then `doctor` warns, and no board event counts as a proof: no comment answer, no label and no assignee. Only `factory decide <D-n> <option>` from a terminal window outside a factory session counts. With a shared account, `factory decide` works with every board kind. It records `by: owner` in the decision log and adds a comment to the item that says the answer came from the CLI. That comment is a record, not a proof.
- With `local`, there are no board events, so only `factory decide` counts in every case.
- The setup text (README and `factory doctor`) tells the owner how to make a machine user or an app for the agents.
- Designs and plans: the `doc` operation links the repo file (GitHub shows Markdown), or attaches it.

**Changes and wake-up (F-2).** There is no live push to a local session without a webhook server. So `factory watch` calls `changes read` with the board CLI at a fixed interval (`tracker.watch_interval`), with a bound on the number of reads per run. The coordinator reads these owner actions:
- a comment `/choose <option>`, and a mention of the coordinator;
- a label added or removed, for example `choose:<option>` or `ready` (a work item is ready);
- an issue or item opened or closed.

An event counts only when its author is the owner's account on the board. An event from another account wakes nobody, and the digest counts it as "other". With a shared account (see "Board identity"), an owner event still wakes the coordinator, but it never counts as a proof. An assignee change is read, because it is a proof of assignment (§6.1). A card moved on a Projects board is not read for now; the owner uses a label for that signal. `watch` calls no model. For each new owner event, it writes one record into `.factory/inbox/` and rings one constant doorbell line in the coordinator pane (§4.12). `factory start` starts `factory watch` in the window `ops` (§4.11).

**Privacy.** An issue in a public repo is public. Decision items can hold private facts. So the default decision store is a private repo, or private draft items in a private Project. `factory doctor` fails when the decision store is public, and warns when it is not set. The `local` store is private: it is the node's own state repo, with no remote.

### 4.11 Sessions in tmux: workers, view and the lifecycle

**Layout (F-8).** `factory start` makes one tmux session per node, named with the node id. It has these windows:
- **workers**: one pane for each worker. The workers keep running there.
- **view**: the coordinator, plus one slot. The slot shows the board, or a worker on request (`factory worker summon <worker> [--for 15m]`). When the time ends, the slot shows the board again.
- **ops**: `factory watch` (§4.10). The window exists only when the board is not `local`, because `local` has nothing to watch. `start --dry-run` lists it.

`factory start` attaches when the session runs already. It never starts a second coordinator for the same factory folder. The pane options are `@factory_home`, `@node`, `@slot` and `@worker` (the worker id, on a pane of the window `workers`).

**After a machine restart.** A machine restart kills the tmux server. `factory start` on a dead server starts the coordinator, and then resumes each recorded worker from the last-seen files. Each worker resumes with the session id that its last-seen file holds. So a machine restart needs no tmux-resurrect scripts. The id rule: a session id enters a command line only in UUID form, and only for a worker that the config or the state knows. A last-seen file with any other value is refused: factory names the file, starts nothing for it and goes on with the other workers. `restart` and `reboot` use the same path, so they apply the same rule. When the state shows another machine as the active one, `start` warns before it resumes any worker (§4.3).

**The lifecycle verbs (F-20).**
- `start` starts or attaches the factory, as above.
- `shutdown` stops every session of this factory, and nothing else.
- `restart <worker>` stops one worker and starts it again with its session id. The other workers keep their panes.
- `reboot` is `shutdown`, then `start`. Each recorded worker runs again with its session id.
- `status` lists each worker with its state, its work item and its idle state. The work item column shows the current work, so a worker with an old name shows it.
- `dismiss <worker>` ends a worker and frees its work copy. `dismiss --idle` lists the idle workers first, and the owner picks which to dismiss.

**The stop scope rule (F-20).** A stop verb (`shutdown`, `restart`, `reboot`, `dismiss` and `worker stop`) ends only the sessions, panes and processes that factory started for that factory or that worker. factory knows them from the pane options of its own tmux session and from the ids that it recorded at the launch. A session with the same name and another `@factory_home` option, a session of another factory, and a `claude` process outside the panes of the factory keep running. If the tmux session of the name has no `@factory_home` option, or has the `@factory_home` option of another folder, `shutdown` ends nothing and exits 4 with one remedy line: run `factory shutdown` in the factory folder that owns the session, or end that session by hand (§4.3, "Stops and warnings").

**Idle (F-21a).** A worker is idle when two things are true: it shows no activity for a set time, and it has no open work in progress (no work item in progress is assigned to it). The time is the setting `limits.idle_after`. It is shared, and its default is 2h. The setting uses the interval parser of the config schema, with a bound of 1m to 24h. `status` shows the idle state.

**Dismiss (F-21a, F-21b).** `dismiss` is a dry run by default: it prints what it would end and what it would free, and it changes nothing until the owner confirms. It refuses a busy worker (a worker with open work in progress) with one remedy line and exit 1. The remedy is to finish or move the work item (`factory item move`) and then run `factory dismiss <worker>` again.
- **Pushed.** The work of a worker is pushed when, after a fetch, the head of its branch is on the remote branch, and the work copy has no changed file, no untracked file and no stash. A remote reference that the fetch did not update does not count.
- **Free.** A work copy is free when it is removed from `work-copies/` with the plain git command, with no force. The primary clone of the project stays. A path outside `work-copies/` is never freed.
- If the work is not pushed, `dismiss` frees nothing and prints one line that starts with `STUCK:` and names the reason. The remedy is to push the branch of the worker and run `factory dismiss <worker>` again.
- `dismiss --idle` is a dry run first: it lists the idle workers and changes nothing. In a terminal window the owner then picks which to dismiss. With no terminal window it only lists, and the pick step refuses (exit 4) inside a factory session (`FACTORY_SESSION` set). The remedy is to run `factory dismiss --idle` in a terminal window outside a factory session.

**Stop (F-7).** The safe way to stop a session is not known yet. The rule for the word "safe" comes first, in `docs/session-stop.md`, before any test. A way is **safe** when all four facts hold:
1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

Then a test runs in a throw-away session. It tries each way: `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. A busy session is the hard case (F-7), so it tries each way twice: once on an idle session, and once on a busy session (a tool runs and a background agent runs). The table has one row for each way and each case, with the four facts and the verdict "safe" or "not safe".

Then `factory worker stop` uses the way that is safe for the case of the worker. If the worker is busy and no way is safe for a busy worker, `worker stop` exits 3 ("not ready") and names what runs. Until the test: stop only an idle session (no tool, no agent and no prompt in flight), then send `kill -TERM`. The test is a task of the worker-control milestone (roadmap-v2).

### 4.12 Communication module

All text that reaches another session goes through one module, `src/comms/`, with one interface of four calls (F-12):
- `send`: write one numbered record into the inbox of a worker, then ring the doorbell in the worker pane;
- `deliver`: write one record into the inbox of a child node (the `file://` transport, §5.3);
- `report`: read the digest of a child node;
- `ping`: read the identity of a node, or `unknown` with a reason.

The rules:
- **The doorbell is constant.** The line typed into a pane has no message text. It names the inbox and tells the session to read it. The message is a numbered file, in the format of firstmate (a short header, then the exact text), with a `schema` field. The session acknowledges a record when it moves it to `handled/`. The worker finds its inbox through the variable `FACTORY_INBOX`, which the launch sets.
- **`factory inbox next` and `factory inbox ack <n>`** print the oldest unhandled record, and move record `n` to `handled/`. A plain `mv` also works. The commands keep the format private to factory.
- **Owner authority stays in the typed line.** `worker relay` types the owner prefix, the record number and a short hash of the record. A record alone never carries authority (§5.5).
- **Only this module types into a pane.** No code outside `src/comms/` calls `tmux send-keys`. The slash commands of a session reset (`/clear`, `/compact`) also go through it. A typed line is at most 300 characters. `worker reset --assignment` and `worker recover` send their text with `worker send`, never as typed text.
- **Nothing outside the folder reads or writes inbox files.** The file format is the contract. The folder can become a package when a second tool must import it.

### 4.13 Core and setup

factory has two kinds of files. The **core** is the metal: the code, and the fixed rules that every factory needs. A **setup** is the text and the scripts that a person adds on top of the core (F-16). A setup is code. Its role texts and its coordinator text are session instructions, and a session obeys them. Dean's own examples are setup (F-16a). The fixed rules are core (F-16d).

| Part | Kind | Rule |
|---|---|---|
| The priorities rule | setup | A person writes it. A second factory can take it from a shared setup. |
| The lifecycle of work (plan, build, review, fix, release) | setup | The recipe gives a default. A person can change it. |
| The review rules | setup | The recipe gives a default. A person can change it. |
| The role texts | setup | The recipe renders the role block. A person adds text outside the fixed rules, in the tracked files `setup/coordinator.md` and `setup/roles/worker.md`. |
| The scripts | setup | A script is a file of the setup. The owner accepts it (FAC-M6). |
| The fixed rules (the `safety` block) | core | It is the metal. An edit cannot remove it: `doctor` and `start` check its hash. |
| The role block that the recipe renders | core | The package renders it again when the setting or the package changes. |
| The factory part of the `.gitignore` | core | It keeps the private files out of git. A person adds lines outside it. |

- A setup adds text only outside the fixed rules.
- **The fixed rules are checked.** The `safety` block is a managed block with a hash in its marker. An edited or missing `safety` block stops `start` (exit 4) and fails `doctor`. The remedy is `factory upgrade --overwrite safety`. It renders the block again and keeps the old text in a new backup file in the state folder (at most 10 are kept; the same holds when `--overwrite` replaces a role block or the setup block). It stops with exit 4 inside a factory session, also with `--yes`. A block that is intact but differs from the text that the package renders now (a new package version, or a changed prefix) is rendered again with a notice. A role block that a person edited stays, with a warning.
- **The check needs the rendered text of each machine.** So `coordinator/CLAUDE.md` is not tracked (D-1). Every file that a person needs to make the factory again is in the tracked folder: the coordinator text in `setup/coordinator.md`, the worker role text in `setup/roles/worker.md`, the recipe choice with its list of approval points, the board config, and the setup files of FAC-M6. The mode of each point is per person and stays in the local file.
- **In this design the owner accepts the hash of `setup/coordinator.md` and of `setup/roles/worker.md`** (D-13). The setup acceptance of every setup file, and the upgrade rule (an upgrade never overwrites a setup file), come with FAC-M6.
- factory starts Claude Code only. The instruction-file check also covers the file names of other common agents, because a person may start another agent in the same folder (§4.3).

### 4.14 Extension points

factory has no review desk of its own, not even as an option (F-2, F-17). A person who wants a desk builds a reader on one of these extension points. Each point has a milestone.

| Extension point | What it gives | Milestone |
|---|---|---|
| Board connector contract | The operations of §4.10: item, decision, doc and changes. A new board kind implements it. | FAC-M3 (GitHub), FAC-M9 (Jira, Linear) |
| Event file | The digest of the node in `.factory/outbox/`, written by script (§5.4). A reader follows it. | FAC-M5 |
| `report --json` | The digest on demand, in the same format (§5.4). | FAC-M5 |
| Recipe registration | A recipe is registered in the recipe registry. This is a code path. A new recipe needs no change to the core (§4.9). | FAC-M6 |
| Setup files | A script and one line in the setup list. The owner accepts each file (§4.13). | FAC-M6 |

The event file and `report --json` hold these fields (§5.4): the node id, the layer, the factory version, the report schema version, the cursor, the state of each worker, the board counts by state and priority, the items in progress, the milestone events, each request with its origin path, and the reports of the child nodes.

A person with no code skill adds a desk reader as a setup file in FAC-M6. FAC-M5 adds a sample reader outside `src/`, in `examples/`. It reads the event file and `report --json` of a fixture node, and prints one line for each work item. A test runs it.

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
- A worker is a layer-0 node with no factory folder of its own. Its inbox and last-seen file live in the factory folder of its parent (`.factory/workers/<id>/`, `.factory/state/heartbeat/`).

### 5.3 Addresses

- A child is named by a relative path from its parent: `acme/acme-web/web-checkout`. A path is unique because each id is unique among its siblings.
- A transport says how to reach a node. factory has one transport: `file://<absolute path of the factory folder>`, on the same machine (F-13). It has the four calls of the comms module (§4.12): `send`, `deliver`, `report` and `ping`. The config refuses any other address, for example `ssh://` or `https://`. A remote transport can come later behind the same four calls, with no redesign.
- A parent reaches a worker only through the parent node of that worker. It never types into a grandchild's pane.

### 5.4 What goes up

`factory report --json --since <cursor>` returns one digest:
- node id, layer, factory version, report schema version, and the cursor for the next read;
- worker states and context use (from the last-seen files);
- board counts by state and priority, and the items in progress;
- milestone events since the cursor (PR ready, merged with SHA, released with version, blocked);
- the requests, each with its **origin path** (for example `acme/acme-web#D-4`);
- the reports of the node's own children, already merged (a rollup).

So a node at any depth sees its whole subtree in one call. The digest is also written to the event file `.factory/outbox/` by script, so the facts do not depend on the model's memory. The event file and `report --json` hold the fields that §4.14 lists.

### 5.5 What goes down

- **Assignments:** an assignment or a decision record goes to the inbox of a worker or a child node. `factory decide read` writes the decision record to the origin node's `inbox/`, through each node on the path. Each relay adds its own id to the record's `chain`.
- **Priorities:** a parent sends a `priorities` record. The child applies it to its board items and reports the result.
- **Inherited config:** the parent passes only items on an explicit list (limits, the writing style, the safety rules), kept as one constant. Owner identity, accounts and session settings are never passed. FAC-M8 tests this.
- **Owner authority** comes only from the owner. A record carries authority only when its `by` is the owner of the target node and it arrived through the parent channel. If a parent node has a different owner (a team lead over a member's node), its records arrive as **messages** (D-6): the child's owner decides them. "Request" stays the word for an item that waits for the owner (D-59). This is how a team works without a shared founder.
- In a worker pane, factory types only the one-line owner prefix and a pointer to the inbox record (`factory worker relay`). The record holds the text.

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
| A denial is final; another session does not do the denied step | yes | `worker send` and `worker relay` refuse a text that asks a worker to run a command that the node recorded as denied. |
| Never invent the owner's consent | yes | `worker relay` types owner input only for a decision that the owner recorded. A board answer counts only from the owner's own account, and only when the agents use another account. With a shared account, or with no team board, only `factory decide` counts: it needs a terminal window and refuses inside a factory session. `doctor` warns on a shared account. |
| Decisions stay private | yes | `doctor` fails when the decision store is public, and warns when it is not set (§4.10). |
| No secrets in output | yes | No command prints the value of a secret setting. `doctor` refuses a value that looks like a password or a token in a shared file of the factory folder. A list of running programs shows only the number, the run time and the name of each program. |
| Workers never ask the owner directly | yes (role texts) | none (the model follows the text) |
| The coordinator instructions never reach a worker | yes | The factory folder has no instruction file at its top. The coordinator text is in `coordinator/CLAUDE.md`, and no project copy or work copy is inside or above that folder (§4.3, the instruction-file rule). |
| The saved state changes only through factory | yes | `init` turns on a guard for the state folder. Every change of the saved state goes through factory, and factory refuses it when the guard is off. |
| Resource limits | yes | `worker new` checks the limits of the machine. |
| Look before typing into a session | yes | Before factory types into a session, it reads the screen of that session, refuses when a question box is open, clears the input line, and checks that the text arrived. Only one part of factory types into a session, and each typed text is short (§4.12). |
| Supported platforms only | no | Every command refuses on Windows outside WSL, the Linux part of Windows, and says how to use WSL (§4.7). |

Engineering note: the permission mode is auto mode. `session.permission_mode` accepts only `auto`, and every launch adds `--permission-mode auto`. "Never skip permissions" stops with exit 4.

Engineering note: the relay server is a proxy. Every launch clears `ANTHROPIC_BASE_URL`, then sets it only from `proxies` in the local config. The answer check is a health check; on failure the default is `stop`, and `direct` is the explicit choice. For a config in a parent folder, `doctor` sends no request and warns to run with `--home DIR`. For a factory folder that fails the registration check, `doctor` sends no request and the check fails. `doctor` warns when the variable is set in the shell. Output never shows user info, query strings or headers of the base URL.

Engineering note: the denied commands are a `denied` list in the state folder. Owner input is the owner prefix, typed only for a record in `decision-log.json` with `by: owner`. `decide read` records `by: owner` only under the same rules; the other account is `tracker.agent_account`, and "no team board" is the `local` board.

Engineering note: no command prints env values. A shared file is a file that the config repo tracks. Process lists show only pid, elapsed time and command name.

Engineering note: the state guard is a git hook of the state folder. `init` sets `core.hooksPath` to turn it on. Every state write goes through the state helper.

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

### 6.1 Software recipe: what counts as approval and assignment (D-52)

With `merge: delegated`, `pr merge` needs two proofs: the owner approved the work, and the owner assigned it to a worker or a track. The proof of approval is one of three forms:
1. **A decision.** A record in `decision-log.json` with `by: owner` that approves the work. The record names the work: a PR, an item or a track.
2. **An ask.** An ask item (§4.10) for the PR or the work item, with the answer `approve` from the owner's account. With `github`, the answer is the comment `/choose approve` or the label `choose:approve`. With `local`, the owner types `factory decide <D-n> approve` in a terminal window outside any factory session.
3. **An approved plan.** An ask or a decision item that names the plan file (its path and its commit SHA), answered `approve` through the owner input. With `github`, the answer is a comment or a label by the owner's account, read through the board connector. With `local`, it is `factory decide` from a terminal window outside a factory session. The plan text itself proves nothing.

The assignment is direct, by a decision, or by the board:
- Direct: the proof of approval names the worker or the track.
- By a decision: a second record by the owner names the worker or the track for that work.
- By the board: the owner's account sets the assignee or a `worker:<id>` label on the work item. `factory watch` reads the change through the board connector (§4.10).

Every board proof above (a comment answer, a label, an assignee) needs separate identities: the agents write with `tracker.agent_account`, not with the owner account (§4.10, "Board identity"). With a shared account, no board proof counts. Then only a decision recorded by `factory decide` from a terminal window outside a factory session proves approval or assignment.

These do not count:
- chat text;
- an answer, a label or an assignee change from another account;
- a record that names another PR or head SHA;
- a commit author or a `Status:` line in a file. Agents can commit with the owner's own account, so a commit author proves nothing;
- any board event while the agents and the owner share one account.

An approval in chat becomes a proof when the owner writes it in one of the three forms. With `merge: owner`, only a decision or an answered ask for that PR and head SHA counts; a plan does not.

An open question of the owner blocks the merge (D-52). `factory check` gives `NOT READY` while the PR has an open ask or an open request.

### 6.2 Software recipe: releases (D-57)

D-57 is answered: the release is an approval point of its own, with the values `owner` and `delegated` (OD-1). The default is `owner`: every release waits for the owner's go. With `release: delegated`, the proof is an **owner-approved release scope**: the items and the version that the owner approved for release. The owner writes the scope through the approval record writer (§6), with the same guards as a delegation. The scope is a record of its own kind. Its key is the node id, the real path of the factory folder, the project and the version. So a new scope never ends or changes a delegation, and the effective mode of §6 reads only delegation records. `factory release check` refuses (exit 4) when no owner-approved release scope names the version. The owner writes the scope with `factory release scope <project> <version>`, in a terminal window outside a factory session, and runs `factory release check` again. The approval of the work (§6.1) does not include the release. `release check` and `release verify` read only and publish nothing in every case. FAC-M5 builds the check and its test.

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
| 1 | assembly line | Not used as a name (D-59). A worker does all the stages for one track, so there is no line of stations. The ordered stages are the **work cycle** (§4.9). |
| 2 | functional cells | Not used as a name (D-59). The new word is **worker** (§4.1): a session that does all the stages for one track of one project. |
| 3 | linear sequential layout | Not used. The stages of a track run in order inside one worker, so the layout of the folders (§4.3) is not a line. |
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
2. It moves the Orchestrator text of `~/work/<workspace>/CLAUDE.md` into the tracked file `setup/coordinator.md` of the new factory folder, and keeps a copy in `.factory/backups/`. `init` renders it to `coordinator/CLAUDE.md`. It leaves no coordinator text in any `CLAUDE.md` on the path from a work copy to the root: the old file is removed, or it keeps only lines that every worker may read. The dry run shows this change, and the owner confirms it. Only then do the workers stop loading the Orchestrator instructions (F-3). Without this step, they still load them, because the file sits above every work copy.
3. It moves `decision-profile/` and the roadmaps to `.factory/`, keeps the git history (a `git mv` in the state repo), and writes `factory.yaml` from the facts in CLAUDE.md §13.
4. It imports the board and the On Dean items into the `local` board files. The review page and its scripts stay as the owner view, and the owner can still answer there. FAC-M3 moves the items into GitHub issues with a private repo as the decision store (F-2), and retires the page and its scripts.
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
| `respawn-map.md` | The last-seen files, `factory reboot` and the restore of §4.11 | FAC-M4 | planned |
| `orchestrator-resume.md` | `.factory/resume/` and `factory self reset` | FAC-M4 | planned |
| `roadmaps/` | `.factory/roadmaps/`; `adopt` moves the files | FAC-M2, FAC-M7 | planned |
| `board.json`, `board.md`, page | The `local` board files and `factory item`; then the board items | FAC-M5, FAC-M3 | planned |
| `lanes.json` | The last-seen files and `factory worker list` | FAC-M4 | planned |
| `on-dean.json`, `decision-log.json`, `on-dean.md` | `factory request`, `factory decide` and `.factory/decision-log.json` | FAC-M5 | planned |
| `board-detail.md`, `board-log-*.md`, `done.md` | The item body and its comments on the board; `item close` records the reason in the state repo | FAC-M5 | planned |
| `briefs/` | Assignments in `.factory/orders/`; `worker new --assignment` | FAC-M2, FAC-M4 | planned |
| `review/dean-review.html`, `review/README-decision-pages.md` | Kept as the owner view of the `local` period. Retired when the board UI shows the items and the decisions | FAC-M3 | planned |
| `boardlib.py`, `render-board.py`, `render-dean.py` | Kept for the `local` period. Retired: `factory item` and the board UI replace them | FAC-M3 | planned |
| `board-set.sh` | `factory item add|update|move|close` | FAC-M5 | planned |
| `lane-set.sh`, `lane-lib.sh` | `factory worker` commands and the last-seen files | FAC-M4 | planned |
| `state-commit.sh`, `git-hooks/pre-commit` | The state commit helper and the delete-guard hook that `init` installs | FAC-M5 | planned |
| `layout.sh`, `lane-summon.sh` | `factory layout` and `factory worker summon` | FAC-M4 | planned |
| `md-view.sh` | Retired, because the slot runs `factory item list` and needs no `glow` | FAC-M5 | planned |
| `lanes-refresh.sh`, `lanes-table.py` | `factory worker list` and `factory worker watch` | FAC-M4 | planned |
| `live_boxes.py` | `factory machine` | FAC-M4 | planned |
| `tmux-save-map.sh`, `tmux-restore-lanes.sh` | The last-seen files, and `factory start` on a dead server resumes the recorded workers (§4.11) | FAC-M4 | planned |
| `tmux.conf` | Retired, because `factory start` and `factory layout` set the options of each session, and the restore needs no resurrect plugin | FAC-M4 | planned |
| `scripts/test-*` | The test suite of the factory repo | FAC-M1 | done |
| `priorities/apply-labels.sh` | Retired, because it was a one-time script. `factory issues audit` finds unlabeled issues | FAC-M5 | planned |
| `decision-profile/` | `.factory/decision-profile/`; `adopt` moves the content | FAC-M2, FAC-M7 | planned |
| `state/`, `locks/` | `.factory/state/`, `.factory/locks/`; `factory lock run` | FAC-M2, FAC-M5 | planned |
| Global rules in `~/.claude/rules/devflow/` | Retired as a part of the setup, because devflow installs them and factory never writes there (§2.1). The role templates hold factory's own short rules | FAC-M2 | planned |

## 9. Decisions

### v1 (2026-11-01)

Dean accepted every recommendation in this table on 2026-11-01 (D-45 A, with the name `factory`; D-47 yes for the last-seen hook). D-46 B set the merge rule; D-52 replaced it for this workspace.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Language | (a) TypeScript on Node; (b) Bash like mars; (c) Go single binary; (d) Python | **(a).** It fits your engineering rules (Zod, Result types), devflow is TypeScript, and npm is the existing channel. Bash has no schemas and a JSON state model is hard in Bash 3.2. Go removes the Node need, but it is a new stack in your repos. |
| 2 | Name and package | (a) `factory`, npm `@dean0x/factory`; (b) another name | **(a), with a check.** The npm name `factory` is taken; `@dean0x/factory` is free (checked 2026-11-01). A company named Factory sells an AI coding agent, so people can confuse the two. |
| 3 | License | MIT, Apache-2.0, private | **MIT**, like mars and devflow. |
| 4 | Public or private | (a) private now, public later; (b) public now | **(a).** The repo `dean0x/factory` is private (D-49). It goes public when a team member installs it on a new machine, if Dean agrees. |
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
| D-49 | The code goes to the private repo `dean0x/factory`. No public visibility, no npm publish, no tag. |
| D-51 A | No second review of FAC-M1 now. The review of the v2 code covers the setup and upgrade code. The review of the FAC-M2 PR names `init`, `upgrade` and `doctor`, and its summary lists those files (roadmap, FAC-M2). |
| D-52 | This workspace: approved and assigned work merges when the checks pass. Releases are not part of it. factory offers the rule as an owner choice, the value `delegated` of the approval point `merge`. §6.1 lists the proofs. |
| D-53 | Dean accepted the proposals F-1 to F-10 as a set ("Changes from v1" above). |
| F-13 | One machine only for now. No `ssh://` transport, no remote readiness check and no remote child. The config refuses any address but `file://`. |
| D-56 | The build order is FAC-M2, M4, M5, M6, M7, then M3, M8, M10, M9 (roadmap-v2; FAC-M10 is the release milestone, added after the intent check). |

**D-57 is answered (v3).** F-6 asked whether "a-z" includes releases. The release is an approval point of its own, with the values `owner` and `delegated`. The proof for `delegated` is an owner-approved release scope (§6.2). FAC-M5 builds the release check.

### Intent fixes (2026-11-02, table IF)

An independent check of the design against Dean's notes found open points. The Orchestrator decided them. The decisions are final until Dean changes them.

| Id | Decision |
|---|---|
| IF-1 | The review page of today and its scripts stay as the owner view until FAC-M3. FAC-M7 keeps them. FAC-M3 retires them (§4.10, §8). |
| IF-2 | The proofs of approval follow D-52 as written: a decision, an ask or an approved plan. A plan counts only through an ask or decision item answered `approve` by the owner; a commit author is no proof. The assignment is direct, by a decision, or by an assignee or `worker:<id>` label that the owner's account sets. `check` gives NOT READY while a PR has an open ask or an open request (§6.1). |
| IF-3 | Releases have their own approval point, `release`, with the values `owner` and `delegated`. D-57 is answered (§6.2). |
| IF-4 | "Codex" in note F-3: factory starts Claude Code. The config names one agent command for each node, and only `claude` is built (§4.6). |
| IF-5 | Each layer has its own role template. FAC-M8 adds the template of layer 3. `doctor` warns when a layer has no template (§5.2). |
| IF-6 | The board connector reads comments, label changes, assignee changes and open or close changes. Card moves stay out for now. `start` starts `watch` (§4.10, §4.11). |
| IF-7 | The board scope is a node default plus an override for each project, as in devflow. `tracker set` and `tracker status` exist. Jira has `site` and `key` (§4.4, §4.10). |
| IF-8 | The word list of Dean ends with the heading "machinery and automation hardware". A table in §7.1 maps each of his 11 words. |
| IF-9 | The state repo can push to a private git remote that the owner names. `init --state-from` clones it on a second machine (§4.3). |
| IF-10 | A board event proves the owner only when the agents use another identity (`tracker.agent_account`). With a shared account, `doctor` warns and only `factory decide` from a terminal window outside a factory session counts (§4.10, §6.1). |

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
| R2 | On your own factory, a tracked instruction file or Claude settings file is a warning. On a received factory, the owner accepts such files with the setup text, by one hash (§4.3). |

## 10. Risks

- **Claude Code changes its hook events, status line JSON or CLI flags.** All Claude Code calls sit in one module, with a test that `doctor` runs against the installed version. The last-seen hook uses only documented hook events.
- **A dead proxy stops every worker that uses it.** The health check runs before each launch, the default is `stop` with a clear fix, and the views show which workers use a proxy (§4.6).
- **tmux typing is fragile.** factory types only one short line per message and keeps the text in the inbox. Each typed input is checked by a capture.
- **Board limits and cost.** The APIs of the board tools have rate limits, and reads cost time. `factory watch` reads at a fixed interval with a bound per run, and caches in `.factory/state/`. A board that does not answer is "unknown", never "no answer".
- **A false decision answer.** Anyone with access can comment on a decision item. `decide read` accepts only the owner's account, and records the author and the link. If the agents write with the owner's account, an agent can fake an answer. So an answer on the board counts only when `tracker.agent_account` is another account; else only `factory decide` counts.
- **A public decision store.** `doctor` fails on it (§4.10).
- **The renames and the schema 2 migration touch every part.** They come first in the roadmap, before more code uses the old names. The schema 1 → 2 migration has a test, and every name sits in `src/names.ts`.
- **Scope grows.** The roadmap builds the CLI in stages. Each stage is useful for this workspace before the next one starts. Other recipes and other boards wait until the `software` recipe on GitHub works.
- **Two copies of the setup during the move.** The adopt is one step with a dry run. The old page and scripts stay as the owner view of the `local` period and read the same `local` files, so there is one source of truth. FAC-M3 retires them, and a search finds no process that calls them.
- **The status line of the owner is a user setting.** A work copy setting replaces it. The wrapper of §4.6 passes its output through, and a test checks this.
- **A release publishes by mistake.** The publish job needs a protected environment, a gate script and a recorded decision id (§4.7).
