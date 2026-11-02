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
7. **One board for many repos (F-19).** One GitHub project holds the issues of many repos in one board. FAC-M3 proves it with a real run (§4.10).
8. **Lifecycle (F-20, F-21).** The commands `start`, `shutdown`, `restart`, `reboot`, `status` and `dismiss` have a milestone and a test each. The design defines an idle worker (§4.2, §4.11).
9. **Leftovers.** The docs hold no local machine path (docs check 8). D-57 is answered: the release proof is an owner-approved release scope (§6.2).

## Changes from v1

Dean gave the feedback F-1 to F-10 on v1, and accepted the proposals as a set (D-53). v2 makes these changes:
1. **Names from a real factory (F-1).** A lane is now a **cell**. A workflow pack is now a **recipe**. node, owner and project stay. New factory words where they are clearer: `factory inspect` (merge gate), `factory ship` (release check), **andon** (an item that waits on the owner), **work order** (a brief or a decision that goes down), **changeover** (a clear or compact between phases), **staging** (the merge order). See §4.1 and §7.
2. **The team's tracker holds the board (F-2).** factory gets one tracker connector: GitHub (the default), Jira or Linear. A `local` connector keeps the items in files, for a node with no network or no tracker account, and it is the test double of the connector. factory has no review desk of its own, not even as an option (F-17). A decision is a labelled tracker item, and a script reads the answer. The decision store is private by default. See §4.10.
3. **The coordinator runs in its own home folder (F-3).** The node home is next to the projects, never inside a repo and never above the checkouts. `factory up` starts the coordinator. See §4.3.
4. **Same mechanics, one role per layer (F-4).** Layers count from the bottom: cells are layer 0. factory sets the role of a node from its layer. All children of a node are on one layer. See §5.
5. **macOS and Linux only (F-5).** See §4.7.
6. **The merge rule is an owner choice (F-6).** This workspace uses D-52. Releases wait for the owner's go: `approval.ship: each` is the only value until D-57 is decided. See §6.
7. **One command stops a cell (F-7).** A test of the ways to stop a session comes first. Then `factory cell stop` uses the safe way. See §4.11.
8. **Cells live on the bench window (F-8).** The view window has the coordinator and one slot. See §4.11.
9. **The heartbeat hook replaces every read under `~/.claude` (F-9).** The instruction to avoid those reads goes away. See §4.6.
10. **One general core; the recipe sets the kind of factory (F-10).** factory ships the `software` recipe first, in two variants: plain Claude Code (the default) and devflow. The config schema gets a `recipe` block. See §4.4 and §4.9.

Other changes: D-49 put the code in the private repo `dean0x/factory`. D-51 A: no second review of FAC-M1; the review of the v2 code covers the setup and upgrade code.

After v2, F-13 (2026-11-02): **one machine only for now.** The `ssh://` transport, the remote readiness check and the remote child are out. The transport interface stays, with `file://` only, and the config refuses any other address. A remote transport can come later with no redesign. See §5.3.

## Changes after the intent check (2026-11-02)

An independent check compared this design with every note from Dean. `docs/intent-trace.md` lists each note with its design section and its milestone. The check found gaps. The Orchestrator decided the open points (§9, table OD). The design now changes as follows:
1. A command finds the home from a project folder, through a per-user index outside `~/.claude` (§4.2, §4.3).
2. `init` in a folder that holds several repos proposes a home next to them. A project URL clones next to the home (§4.3).
3. The user picks the tracker at `init` and changes it with `factory tracker set`. A project can override the tracker of the node (§4.4, §4.10).
4. The proofs of D-52 are listed (§6.1). Releases get the key `approval.ship`, with `each` as the only value until D-57 is decided (§4.4, §6.2).
5. Each layer has its own role template. Layer 3 gets its own template in FAC-M8 (§4.9, §5.2).
6. The main session is a Claude Code session. A node names its agent command in the config (§4.6).
7. The coordinator reads comments, label changes, assignee changes and open or close changes from the tracker. `factory up` starts `factory watch` (§4.10, §4.11).
8. The communication module has its own section. It is the only code that types into a pane (§4.12, §5.3).
9. A parity table maps each part of today's setup to a command, a milestone or "retired". The adopt moves the coordinator text out of the folder above the checkouts (§8).
10. The state repo can push to a private remote, for a second machine of the same owner (§4.3).
11. Dean's shop-floor words have a table, and each new name has a plain description (§7.1, `docs/glossary.md`).
12. The release has its own milestone, with a protected-environment check (§4.7).

## Summary for Dean (one page)

**What factory is.** `factory` is a CLI. It creates and runs the orchestration setup of this workspace on any machine, for any person. `factory init` writes a node: the coordinator instructions, the role templates, the decision profile and the config. `factory up` starts the tmux layout and the coordinator session. Other commands do the multi-step jobs that the Orchestrator does by hand today. The CLI never contains a name, an account or a path. It reads them from the person who runs `init`.

**One core, many kinds of factory.** The core knows nodes, layers, roles, sessions, the inbox and reports, the owner's decisions, the tracker, capacity and the state store. A **recipe** gives the rest: the role template of each layer, the work cycle, the gate checks, the kind of output and the tracker mapping. The first recipe is `software`: projects are git repos, the output is a PR, and the gate is the merge gate. It has two variants: plain Claude Code (the default) and devflow. Other recipes, for example research or content, come later.

**Names from a real factory.** A worker session is a **cell**. A cell does all the steps (plan to release) for one track of one project, as a work cell does for one product family. Items that wait on the owner are **andon** items. Briefs are **work orders**. The merge order is **staging**.

**The team's tracker, not our own desk.** The board, the andon items and the decisions live in GitHub, Jira or Linear. The owner answers a decision with a comment such as `/choose B`. A script reads the answer, so the coordinator spends no tokens on it. The decision store is private by default.

**Where things run.** The coordinator runs in the node home, a folder of its own next to the project folders. Cells run in the project checkouts. So a cell never loads the coordinator instructions. One project or many: the layout is the same. The user can run `factory up` from any project folder, because `factory init` records where the home is.

**Layers.** Every node has the same mechanics: the config, the report digest that goes up, the inbox that comes down, and the CLI. Each layer has its own role. Layer 0 is the cells (workers). Layer 1 is the coordinator. Layer 2 manages coordinators. Each layer above 2 gets its own role when it becomes real. A new top layer changes no node below it.

**Scripts save tokens.** The largest costs today are the merge gate (25–60k tokens each time), the status round (40–80k), a restart of all cells (60–100k) and cell creation (20–30k). Each becomes one command with a short verdict as output, about 1–4k tokens. A rough total: 50–70% less coordinator spend on routine work.

**Safety is in the code, not only in the text.** factory starts a session only in auto mode. It has no flag that skips permissions. A proxy is an explicit config option, checked before each launch. factory types owner-authority input only for a decision that the owner recorded. A decision answer counts only when it comes from the owner's tracker account. Releases always wait for the owner's go.

**Decided** (details in §9). v1: TypeScript on Node 22+; binary `factory`, npm package `@dean0x/factory`; MIT; state folder `.factory/` and config `factory.yaml`; the heartbeat hook. v2: the ten changes above.

---

## 1. Inventory of the current setup

This section describes the workspace setup as it is today. It uses the workspace words (lane, Orchestrator, On Dean), because those are the names in the files.

Paths are relative to `~/Sandbox/.devflow/` unless they start with `~/` or `/`.
Classes: **G** generic, **D** devflow-specific, **P** person-specific (names, accounts, paths), **M** machine-specific.

### 1.1 Parts

| Part | Job | Class | What ties it (file:line) |
|---|---|---|---|
| `~/Sandbox/CLAUDE.md` | Orchestrator rules §1–§13 | G, D, P, M | "Dean", `dean0x` §13; founder prefix §12; `~/Sandbox/.devflow` (`--add-dir`); session names `orchestrator:lanes`, `orchestrator:bench`; "10 CPUs, 64 GB", `lockf`, `pbcopy`, `sysctl`, `memory_pressure`; `/devflow:*` in §5 and §7 |
| `docs/orchestration/protocol.md` | Lane protocol: escalation, test lock, disk, context, PRs, style | G, D, P, M | `~/Sandbox/.devflow/...` (L19–34); Node 24 and `/opt/homebrew/bin` (L34, devflow tests only); `vitest` (L25); devflow timeout rule (L54) |
| `docs/orchestration/status.md` | Status layout | G, P | "Waiting on Dean" (L42) |
| `docs/orchestration/respawn-map.md` | Lane, pane, folder and session-id table, plus the restart steps | G (steps), P, M (data) | pane ids, UUIDs, `--add-dir` path (L14), reads `~/.claude/sessions` (L16) |
| `docs/orchestration/orchestrator-resume.md` | The Orchestrator's resume block | instance data | devflow PR numbers |
| `roadmaps/README.md` and track roadmaps | Track arcs and their template | G (README); instance data | paths on line 2 of each track file |
| `board.json` → `board.md`, page | Board source of truth | G (schema), P (links) | `dean0x` issue links via boardlib |
| `lanes.json` | Hand-written lane facts | G | none |
| `on-dean.json`, `decision-log.json` → `on-dean.md` | Items that wait on the founder, and his decisions | G (schema), P (names) | file names, "# On Dean", artifact URL in the intro |
| `board-detail.md`, `board-log-<yyyy-mm>.md`, `done.md` | Item detail, log, append-only removals | G | none |
| `briefs/brief-<track>-<date>.md` | Lane briefs | G (shape) | paths and repos inside |
| `review/dean-review.html` | Review page: board, items, decision forms, docs drawer | G (template), P | "Dean" (L8); `dean0x` URLs in the data block |
| `review/README-decision-pages.md` | How the page and its database work | G, P | live artifact URL (L3) |
| `scripts/boardlib.py`, `render-board.py` | Board schema check, sort, release groups, render | G, P | `github.com/dean0x/{repo}` (boardlib L241), default repo `devflow` (L240), env `DEAN_DIR` |
| `scripts/render-dean.py` | On Dean file, page data block, `files.json` | G, P | `PR_URL = .../dean0x/devflow/pull/{}` (L69), "# On Dean" (L237) |
| `scripts/board-set.sh` | Only writer of `board.json`; locked; fails closed | G, P, M | `BOARD_REPO:-dean0x/devflow` (L91); `/usr/bin/lockf` (L35) |
| `scripts/lane-set.sh`, `lane-lib.sh` | Only writer of `lanes.json`; tmux helpers | G, M | `lockf`; session name `orchestrator` (lane-lib L3) |
| `scripts/state-commit.sh`, `git-hooks/pre-commit` | Commit helper; ID delete guard; `done.md` append-only | G | needs `core.hooksPath=scripts/git-hooks` |
| `scripts/layout.sh`, `lane-summon.sh`, `md-view.sh` | View and bench windows, pinned summon, glow viewer | G, M | session `orchestrator`; `/bin/zsh`; `glow` |
| `scripts/lanes-refresh.sh`, `lanes-table.py`, `live_boxes.py` | Live lanes table every 30 s; machine box | G, M | reads `~/.claude/projects/*.jsonl` (lanes-table L64); status-line regex `Context\s+\S+\s+(\d{1,3})%` (L82); `memory_pressure`, `pmset` (live_boxes L105–106); `pyenv` |
| `scripts/tmux-save-map.sh`, `tmux-restore-lanes.sh` | tmux-resurrect hooks: save the pane map, resume lanes | G, M | reads `~/.claude/sessions/*.json` (save-map L14); restore forces `--permission-mode auto` and `env -u ANTHROPIC_BASE_URL` (restore L20, L58) |
| `scripts/tmux.conf` | Mouse, lane names on borders, resurrect, continuum | P, M | absolute paths in the user folder (L2, L3, L25, L26, L32) |
| `scripts/test-*` | Tests with fixtures and a separate tmux server | G | none |
| `priorities/apply-labels.sh` | One-time label script | P | `R=dean0x/devflow`; fixed issue list |
| `decision-profile/` | Founder decision wiki: index, format, log, principles, records | G (format), P (content) | "Dean" throughout; some principles scoped `devflow` |
| `state/`, `locks/` | Locks, caches, logs (names only read) | M, gitignored | none |
| Global rules in `~/.claude/rules/devflow/` | Engineering, quality, STE writing style | D | installed by devflow, not by the setup |

### 1.2 Dependencies on tools

Required: `tmux` (with TPM, resurrect, continuum), `git`, `gh`, `jq`, `python3` (stdlib only), Bash 3.2+, `glow`, Claude Code.
macOS only: `/usr/bin/lockf`, `memory_pressure`, `pmset`, `pbcopy`, `sysctl`.
Private Claude Code layout: `~/.claude/projects/<cwd>/*.jsonl` (lane activity), `~/.claude/sessions/<pid>.json` (session ids), and the text of Dean's status line (context percent).

### 1.3 Conflicts to fix before packaging

I checked each of these on the file. factory takes one answer for each.
1. **Merge authority.** D-46 B (2026-11-01) said that every merge waits for the owner's go. D-52 (2026-11-02) replaced it for this workspace: approved and assigned work merges when the gates pass. factory makes the rule an owner choice (F-6, §6).
2. **How to stop a session.** `respawn-map.md` said "press Ctrl+C twice". CLAUDE.md §12 says that Ctrl+C quits only the client, and uses `kill -TERM`. factory tests the ways first (F-7, §4.11).
3. **Where lanes live.** The respawn map put lanes in the view window. CLAUDE.md §12 puts them on the bench. factory uses the bench (F-8, §4.11). The respawn map line is fixed.
4. **Context budget.** `protocol.md` used 250k/350k tokens. CLAUDE.md §12 uses 30–35% and 40% of the window. factory uses the percent rule, because it works for every window size.
5. **Reads under `~/.claude`.** CLAUDE.md §1 told lanes to avoid them, but three scripts read there. factory replaces every read with the heartbeat hook (F-9, §4.6).
6. **The coordinator instructions reach every lane.** Claude Code loads every CLAUDE.md from the session folder up to the root. The Orchestrator instructions are in `~/Sandbox/CLAUDE.md`, and every lane checkout is under `~/Sandbox`. So each lane also loads them. factory puts the node home next to the checkouts, never above them (F-3, §4.3).

## 2. The devflow connection

### 2.1 Ties

devflow (npm `devflow-kit`, MIT) installs commands, agents, skills, hooks and rules into `~/.claude`, and uses `.devflow/` in each project and `~/.devflow/` in HOME. In factory, devflow is one variant of the `software` recipe (§4.9). The core knows nothing of devflow.

| Tie | Where | Default in factory |
|---|---|---|
| Cycle plan → implement → code-review → resolve | CLAUDE.md §5.2; protocol L47 | Stage ids `plan`, `build`, `review`, `fix`. The plain variant uses plain Claude Code: plan mode, edits, a review subagent, fixes. |
| "code-review is for software; else a multi-lens audit" | CLAUDE.md §5.2 | Keep the rule. Each stage declares `applies_to: code | prose | any`. |
| Review and resolution summaries posted on the PR | CLAUDE.md §5.3, §5.4 | An evidence contract: one PR comment per stage, found by a marker. The plain markers are `<!-- factory:review -->` and `<!-- factory:fix -->`. |
| One evidence comment per head | CLAUDE.md §5.2 | Optional. The plain variant needs CI plus the review comment. |
| `/devflow:release` | CLAUDE.md §7 | A `release` stage. The plain variant uses the repo's own release script, named in `factory.yaml`. |
| Triage words (FIX_NOW, ESCALATED, CHANGES REQUESTED) | board-detail.md | Neutral words `blocker`, `fix`, `defer`, `ask`, `ready`. A variant maps its words to them. |
| Agent types Code, Validate, Test | protocol L32 | Agent kinds: implementer, verifier, tester, reviewer. A variant maps them to its agent types. ("Role" now means the role of a layer, §5.) |
| State folder named `.devflow` | CLAUDE.md §11–§12; respawn-map | `.factory/`. Proof of the clash: devflow already wrote `~/Sandbox/.devflow/.devflow/{curation,docs,features,memory}`. |
| `--add-dir ~/Sandbox/.devflow` | CLAUDE.md §12; restore L20 | `--add-dir <node home>/.factory`, from the config. |
| Lane name examples `devflow-*` | CLAUDE.md §4 | Keep the `<project>-<track>` form for cells; use neutral examples. |
| Default repo `dean0x/devflow` | board-set L91; boardlib L13, L240; render-dean L69 | `recipe.projects[].repo` in `factory.yaml`. A bare issue number is refused when the node has more than one project. |
| Rules in `~/.claude/rules/devflow/` (STE, read economy, quality) | HOME CLAUDE.md | factory writes its own short rules into the role templates. It never writes to `~/.claude/rules/`. |
| Profile seeded from devflow `preference-profile.md` | decision-profile/README-format.md:64 | factory ships an empty profile with its format. A variant may give a seed command. |
| devflow memory and curation hooks | protocol L19 | Resume files plus Claude Code auto-memory. No ledger by default. |
| devflow-repo rules inside the generic protocol | protocol L34 (Node 24), L54 (timeouts), L62 (standalone) | Move them to the devflow variant's worker addendum or the devflow repo's CLAUDE.md. |
| Repo checks in the gate routine (Independent audit, ceiling diff) | orchestrator-resume.md:14 | A per-project `gate.checks` list in `factory.yaml`. |

The gate-level words `full`, `standard` and `lean` are not in the setup itself. They appear only in devflow product work, so there is no tie to replace.

### 2.2 devflow as a recipe variant

The devflow variant is data plus prompt text in the `software` recipe (§4.9). It has no code that factory runs, except its `install` and `detect` commands, and the user must confirm those.

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
evidence:                 # how `factory inspect` finds proof of each stage
  review:  "<!-- devflow:review-summary"
  fix:     "<!-- devflow:resolution-summary"
  release: "<!-- devflow:shipped"
verdicts: { FIX_NOW: fix, ESCALATED: ask, "CHANGES REQUESTED": blocker, READY: ready }
agents: { implementer: Code, verifier: Validate, tester: Test, reviewer: Review }
state_dirs: [".devflow/", "~/.devflow/"]   # factory refuses to use these and never deletes them
worker_addendum: addendum.md               # extra cell rules for repos that use devflow
profile_seed: /devflow:dynamic-profile
proxy_presets:                             # optional; copied into `proxies` on request (§4.6)
  subswitch: { base_url: "http://127.0.0.1:4141", health: /__subswitch/health }   # port 4141 is the default of `subswitch serve`
```

`factory recipe variant devflow --project P` checks `detect`, offers `install`, and writes the variant into the project entry in `factory.yaml`. The variant is per project, so one node can mix projects with and without devflow.

The triage words `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED` are devflow ties (§2.1). They appear only in this variant file. The deny list of the tests finds them in any other template or generated file.

The dependency goes one way: factory knows devflow's public surface (commands, markers, paths). devflow never knows factory. This keeps the founder rule "devflow stays standalone" (CLAUDE.md §8; `decision-profile/principles/devflow-standalone.md`).

## 3. Scripts that save tokens

Costs are rough, per use, for the new tokens that enter the coordinator context. They come from the step counts in CLAUDE.md and the inventory. "After" assumes one call with a short verdict as output.

| Job today | Steps today | Today | Command | After |
|---|---|---|---|---|
| Merge gate and merge (§5) | CI on the head SHA, behind-by, open threads (GraphQL), review and fix evidence, impact inventory over the diff, public-text check, pinned merge, board, commit, close issue | 12–18 calls, 25–60k | `factory inspect <pr>` then `factory pr merge <pr>` | 2 calls, 3–6k (the impact inventory stays a judgment; `inspect` prints the diff stat and the touched surfaces only) |
| Status round (§2, §3) | ListAgents, panes, worktrees, PRs and milestones per repo, board, roadmaps, message each lane, capture idle panes | 20–30 calls, 40–80k | `factory status` | 1–2 calls, 3–5k (cell replies still cost their own tokens) |
| Restart of all lanes (§12) | Per lane: capture, push check, CronList, stop, respawn, rename, re-brief | ~50 calls, 60–100k | `factory cell restart --all` | 2 calls, 3–5k |
| Lane creation (§12) | Resource check, worktree, pane, launch, wait, rename, protocol line, brief, board, lanes, respawn map, commit | 15–20 calls, 20–30k | `factory cell new <name> --project <p> --order <file>` | 1 call, 1–2k |
| Board and owner-item updates (§11) | Edit JSON, render, commit, republish, label sync | 5–8 calls, 8–15k | `factory item …`, `factory andon …` (tracker writes, labels built in) | 1–2 calls, 1–3k; no render step, because the tracker shows the board |
| Reading the owner's answers (§8) | Read the page database, record each decision, relay it | 3–6 calls, 5–10k | `factory decide read` (a script reads `/choose` comments and labels from the owner's account) | 1 call, <1k |
| Lane clear or compact, then re-brief (§12) | Capture, idle and pushed checks, resume file check, C-u, type, verify, protocol line, re-brief | 8–10 calls, 10–15k | `factory cell changeover <cell> --clear|--compact` | 1 call, 1k |
| Release pre-check and post-check (§7) | Version, changelog, package contents, registry; after: registry, clean install, smoke | 6–10 calls, 10–20k | `factory ship check <project>` / `factory ship verify <project> <version>` | 1 call each, 2–3k |
| Issue audit and labels (§8) | List issues, classify, apply labels | 5–10 calls, 30–100k | `factory issues audit` (finds unlabeled or conflicting issues; the model classifies only those) | 1 call plus the classification of new issues only |
| Decision record and profile update (§1) | Record file, log line, principle, decision-log row, commit | 4–6 calls, 8–15k | `factory decide read` records it; `--principle <id>` links a principle | 1 call, 1–2k (the principle wording stays a model job) |
| Worktree cleanup (§4) | List, check tip on remote, search board and resume files, remove | 5–8 calls, 5–10k | `factory checkout clean` (dry run by default) | 1 call, 1k |
| Typed founder-authority input (§12) | Map, capture, Escape/C-u, type, Enter, verify | 4–6 calls, 4–6k | `factory cell relay <cell> --decision <D-n>` | 1 call, <1k |
| CI watch (§10) | Monitor or loop on `gh pr checks`, then read | 2–4 calls, 3–8k | `factory pr watch <pr>` (exits when CI ends; for a background task) | 1 call, <1k |
| Stopped-lane watch and limit recovery (§11, §12) | Loop on `lanes-stopped.txt`; capture each lane; answer the dialog; nudge | 5–15k | `factory cell watch` (exits on a change); `factory cell recover` | <1k plus |
| Moving an outside session into tmux (§12) | ListAgents, session file, stop, resume, rename, protocol line | ~6 calls, ~6k | `factory cell adopt <name>` | 1 call, <1k |
| Resource check (§8) | 4 commands | 1–4 calls, 1–2k | built into `cell new`; `factory machine` | 0–1 call |
| Orchestrator self-compact (§12) | Resume file, C-u, queue `/compact` | ~3 calls, 3–5k | `factory self changeover` (checks the resume file, then queues `/compact`) | 1 call |

Rule for every command: the output is a short verdict for the model (`READY`, or `NOT READY: 2 open threads, CI pending`). `--json` gives the full facts. The default output never prints a diff, a log or a transcript.

The tracker removes most of the render scripts of today (`render-board.py`, `render-dean.py`, the page data block). The tracker UI shows the board and the andon items.

## 4. CLI shape

### 4.1 Concepts

- **Node**: one session with a layer and an owner. It has an optional parent and children. A node on layer 1 or above has a factory folder. A worker (layer 0) has none: its state lives in the factory folder of its parent. The coordinator is a node on layer 1. The word *node* stays because it fits a session on any layer.
- **Factory folder**: the folder of a node on layer 1 or above. It is a git repo of its own, the config repo. It holds the config, the setup text, the clones of the projects and the work copies (§4.3). In code and flags it is `home` or `root` (`--home`, `FACTORY_HOME`).
- **Layer**: the level of a node, counted from the bottom. Layer 0 is the workers. The layer sets the role (§5).
- **Role**: the instructions, the commands and the reports of one layer. A role text from the recipe gives them.
- **Owner**: the person whose decisions the node carries. Each team member is the owner of their own nodes.
- **Worker**: a session (layer 0) in one work copy. It does all the stages of the work cycle for one track of one project.
- **Work copy**: a git work tree of a project, in which one worker works. It is under `work-copies/` in the factory folder (§4.3).
- **Project**: a unit of work that the node manages. In the `software` recipe, a project is a git repo, with its own settings and setup.
- **Recipe**: the kind of factory: role texts, work cycle, approval points, output kind and board mapping (§4.9).
- **Board**: the system that holds the work items, the requests and the decisions (§4.10). The config key is `tracker`.
- **Approval point**: a step of the work that needs an approval. The recipe lists the points. The owner sets the mode of each point: `owner` or `delegated` (§6).

Factory words, used where they are clearer than the generic word:
- **request**: an item that waits for the owner (a decision or an action);
- **assignment**: a written task, or a decision record, that goes down to a worker or a child node;
- **session reset**: a clear or compact of a session between phases;
- **queue**: the order of the finished work that waits for an approval point;
- **check**: a check of one piece of finished work. It says `READY` or `NOT READY`, with the reasons. The software recipe checks a pull request with `factory check <pr>`;
- **release check**: the software recipe check before a release, and the check after it.

`docs/glossary.md` gives one plain sentence for each of these words, and `factory help words` prints them. The same file holds the plain-words table (D-11): for each jargon term, the plain word that user text uses. A test fails when a name has no entry or the entry has more than 25 words. §7.1 shows which of Dean's shop-floor words factory uses.

A factory with one project is a node with one project. A factory with many projects is a node with many. There is one code path for both.

### 4.2 Commands

```
factory init [--home DIR] [--name N] [--project PATH|URL]... [--recipe software] [--variant plain|devflow] [--layer N]
             [--tracker ID] [--items X] [--decisions X] [--state-from SRC] [--yes]
factory up [--home DIR]                     # start or attach: tmux session, windows, coordinator (§4.11); works from a project folder (§4.3)
factory doctor [--fix]                      # tools, versions, platform, safety posture, hooks, tracker
factory upgrade [--dry-run]                 # migrate state and managed blocks (§4.5)
factory machine                             # CPU, memory, disk, load against the limits
factory help words                          # the plain description of each factory word (docs/glossary.md)

factory project add|remove|list
factory recipe show                         # the project table of the coordinator, from the config
factory recipe variant <plain|devflow> [--project P]
factory tracker set <id> [--project P]      # change the tracker of the node, or of one project (§4.10)
factory tracker status                      # the tracker of each project, and the check of its decision store
factory state remote <url|path> | push | pull   # the private remote of the state repo (§4.3)

factory cell new <name> --project P [--checkout PATH] [--order FILE]
factory cell list [--json]                  # the live cells table
factory cell send <cell> (--file F | --text T)   # inbox record plus a one-line doorbell
factory cell relay <cell> --decision D-n    # owner-authority input, from a recorded decision
factory cell changeover <cell> (--clear | --compact) [--order FILE]
factory cell stop|resume|restart <cell>|--all
factory cell summon <cell> [--for 15m]
factory cell watch | recover | adopt <name>
factory inbox next | ack <n>                # read and acknowledge a record of the own inbox (§4.12)
factory layout                              # build the windows again

factory item add|update|move|close|list|import ...   # tracker items: the board
factory andon add|list|close ...            # items that wait on the owner
factory decide ask <D-n> --options FILE     # a decision item in the decision store
factory decide read [<D-n>] [--principle ID]   # read answers by script; record them in the log and profile
factory decide <D-n> <option> [--note T]    # the owner answers in the CLI (the `local` tracker, §4.10)
factory staging set|show                    # the merge order
factory watch                               # bounded reads of new tracker changes; wakes the coordinator (§4.10)
factory desk render                         # NOT BUILT, no milestone: no own review desk (F-2, §4.10)

factory inspect <pr> [--project P]          # merge-ready verdict at the current head
factory pr merge <pr>                       # pinned merge, then the bookkeeping
factory pr watch <pr>
factory issues audit [--project P]
factory ship check|verify <project> [<version>]
factory checkout list | status | sync <pr|branch> | clean [--apply]   # git across checkouts (D-55)
factory lock run -- <command>               # the shared heavy-test lock

factory status [--json]                     # digest for the owner
factory report [--json] [--since CURSOR]    # digest for the parent (§5)
factory node tree | children | add-child | remove-child
factory self changeover
factory adopt <path> [--dry-run]            # import the setup of today into a node (§8)
factory hook <event> | statusline           # called by Claude Code; not for people (§4.6)
```

The `software` recipe adds `inspect`, `pr`, `issues`, `ship` and `checkout`. Another recipe adds its own gate and output commands. The core commands are the same for every recipe.

Global flags: `--home PATH`, `--json`, `--quiet`, `--no-color`. A command finds the home in this order: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml`; else the home index, which matches the current folder to a project path (§4.3).
Output rule: the default output of a job command (a command that replaces a manual job of §3) has at most 20 lines, and the verdict is on the first line. `docs/token-budget.md` gives the size budget of each job.
Exit codes: `0` success, `1` failure, `2` usage error, `3` "not ready" (a gate verdict), `4` safety refusal. A gate verdict is not an error, so scripts can tell them apart.

### 4.3 Factory folder layout

The factory folder is a git repo of its own, the config repo. It holds the config of the factory and every file that a person needs to make the same factory on another machine (F-18, D-60). The clones of the projects, the coordinator folder and the work copies are inside it. It has no instruction file at its top.

```
~/work/acme/                        # the factory folder: a git repo, the config repo
  factory.yaml                      # shared config; tracked (§4.4)
  factory.local.yaml                # personal and one-machine config; ignored; mode 600
  .gitignore                        # the share list; tracked
  setup/
    coordinator.md                  # tracked: the coordinator text of the owner
  coordinator/
    CLAUDE.md                       # generated on each machine; ignored; the coordinator runs here
  web/  api/                        # clones of the project repos; ignored
  work-copies/
    web/web-search/                 # a work copy for one worker; ignored
  .factory/                         # private state repo with the delete-guard hook; ignored
    node.json                       # the factory marker: schema_version, created_with, block versions
    roles/worker.md                 # the worker role text that every worker reads
    decision-log.json               # decisions read from the board, with the answer and its author
    queue.json                      # the queue
    board.json  waiting.json        # the items, only with the `local` tracker (§4.10)
    decision-profile/               # format, index, principles, decisions
    roadmaps/  orders/  resume/
    workers/<id>/inbox/             # assignments and records for each worker
    inbox/  outbox/                 # messages from the parent, reports to the parent (§5)
    state/  locks/                  # ignored: last-seen files, board cache, pane map, locks
```

Why this layout: Claude Code loads every instruction file from the session folder up to the top of the file system. A worker runs in a work copy. The coordinator text is in `coordinator/`, and that folder is not above any work copy. The top of the factory folder holds no instruction file. So a worker loads the project instructions and the worker role text, and never the coordinator text. The coordinator reads the projects through `--add-dir`.

A person can run more than one factory on one machine, each in its own folder. A person can run one factory on more than one machine, from the same config repo. One machine is the active one at a time. In v3 nothing stops a second machine. FAC-M4 adds a warning, and FAC-M8 allows use from several machines at once.

The `.gitignore` is the share list. It ignores everything, and it allows `.gitignore`, `factory.yaml` and `setup/`. factory writes its part of the file between two marker lines. A person can add lines outside that part, and `upgrade` keeps them. The coordinator folder is not tracked (D-1): each machine renders `coordinator/CLAUDE.md` from the package and from `setup/coordinator.md`. So the rendered text can hold the owner prefix and the modes of each machine.

The coordinator writes in the coordinator folder, in the state folder and in the clones. It does not edit the config. The launch adds `--add-dir` for the state folder and for each project, and not for the top of the factory folder. A project path is one folder name. It never names the top of the factory folder, and it never names a reserved folder. The reserved names are `coordinator`, `work-copies`, `setup`, `factory.yaml`, `factory.local.yaml`, `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md`, in any letter case. A name with a leading dot is also not allowed.

`factory init`:
- Inside a project work tree, with no `--home`: it proposes a new factory folder next to the project folder (`../<repo>-factory`). It clones the repo into `<factory folder>/<repo>` from its origin, and it warns that the old folder keeps the work that is not pushed. With no origin, it clones from the local folder, keeps the local source in `sources` of the local file, and warns that the factory cannot be shared with this repo. It asks in a terminal window. With `--yes` it uses the proposal. With no terminal window and no `--yes`, it prints the proposal and exits 2.
- In a folder that is not a git work tree and holds git repos one level down (a workspace folder), with no `--home`: it proposes `./<folder>-factory`, next to those repos. It lists each repo as a project, and it clones each one into the new folder. When two folders are work trees of one repo, it lists the repo once and names the extra folder as skipped. It asks in a terminal window. With `--yes` it uses the proposal. With no terminal window and no `--yes`, it prints the proposal and exits 2.
- In an empty folder, or with `--home DIR`: that folder becomes the factory folder.
- It makes the folder a git repo and commits only the allowed files. It writes `factory.yaml` and `factory.local.yaml` (mode 600), writes `setup/coordinator.md` with a short comment when the file is absent, renders `coordinator/CLAUDE.md`, and registers the factory in the factory list. A child node folder sits in its own folder, never inside the folder of its parent.
- It refuses a new factory folder inside a folder that the factory list holds (error, exit 1).
- `--project URL` clones the repo into the factory folder: `<factory folder>/<repo name>`. The repo name is the last part of the URL, without `.git`. It must be one folder name that is not reserved. The clone runs `git clone` with an argument list and `--` before the URL, never through a shell, and with no submodule recursion. It refuses a target that exists and is not a clone of the same URL (error, exit 1). `init` makes every check that needs no cloned project, and counts all projects, before the first clone. If a later step fails, it removes only what this run made.
- A clone URL has these rules: it is `https`, `ssh` (also the scp form) or `file`. An `https` URL has no user name. A password, a token or a secret part in any URL form is refused, a leading hyphen is refused, and the message never repeats the value. Two entries with one clone URL in normal form (the same host and path, with or without `.git`, in the scp or https form), or with one path, are refused. `init` refuses a project flag with credentials (exit 2) before it clones. A URL that `init` reads from an origin loses its user name, and `init` prints a warning. The rules protect secrets, so they stay stops.
- A project with no shareable URL (no origin, a `file` URL, or a local path that the user types) works on this machine. `factory.yaml` never holds a local path or a `file` URL that `init` writes. `init` and `doctor` warn that the factory cannot be shared with that repo, and name the fix: add an origin and set `url`.
- `--tracker`, `--items` and `--decisions` choose the board at setup (§4.10). In a terminal window, `init` asks which board to use when `--tracker` is absent.
- `--approval <point>=<owner|delegated>` sets the mode of one approval point. In a terminal window, `init` asks for each point of the recipe, with `owner` as the default. With `--yes`, or with no terminal window and no flag, it writes `owner`. `--yes` with a flag that asks for `delegated` exits 2 and writes nothing. A `delegated` choice with no terminal window, or inside a factory session, exits 4 and writes nothing (§6).
- `--state-from SRC` clones a state repo (a git URL or a path) into `.factory/` instead of an empty one, and runs `doctor`. This is how a second machine gets the work state (FAC-M3).
- If a step fails, or if `init` cannot write the factory list, it exits 1 and removes only what this run made. A second `init` in the same folder then works. A file or folder that was there before the run stays as it was.
- `factory start` then starts the session. The user never has to know the folder.

**How a command finds the factory folder (F-3).** The order is: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml` (at most 64 levels). The projects are inside the factory folder, so the walk finds it from a clone, from the coordinator folder and from a work copy. Then the registration check runs (D-5). A `factory.yaml` counts only when three things are true:
1. The factory list has an entry for its folder.
2. The `id` of that entry is the `node.id` of the config.
3. The factory marker `.factory/node.json` is present and valid.

A config in a clone that someone else wrote has no entry, so it runs no command and gets no proxy check. If the check fails, `start`, `doctor`, `node` and `upgrade` exit 4. They name the file and the reason, and they print one remedy: `factory init` in the factory folder (no entry, another node id, or a missing or broken factory marker), or "run the command from the factory folder, or name it with --home" (a clone that holds its own `factory.yaml`). `init` on the factory folder registers a received or a moved factory (see "Share a factory"). The check applies to the walk, to `--home` and to `FACTORY_HOME`.

The factory list is a per-user file: `$XDG_STATE_HOME/factory/homes.json`, or `~/.local/state/factory/homes.json` when the variable is not set. It is outside `~/.claude`. Its folder has mode 700 and its file has mode 600, and a reader refuses a file of another user or a file that others can write. Each entry holds the folder path, the node id, the absolute path of each project and the origin (`own` or `received`). A folder that no longer exists is ignored, and `doctor` warns. A work copy does not enter the factory list. Several factories on one machine each have their own entry, and each resolves its own folder.

**The instruction-file rule (F-17, D-60).** Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the session folder and from every folder above it (the memory page of the Claude Code documentation, https://code.claude.com/docs/en/memory). `AGENTS.md` is the file name that other common agents load. factory starts Claude Code only, and the warning names `AGENTS.md` too, because a person may start another agent in the same folder. `doctor` warns when the factory folder, or any folder above it, holds one of these three files. The walk stops at 64 levels, and an unreadable folder gives a warning, not a failure. `start` and `init` print the same warning before they act. The limit: factory never reads under `~/.claude`, so it cannot see the instructions of the user level. A warning is enough here, because the file is the choice of the user in the user's own folders.

#### Share a factory

A factory can travel from one machine or person to another through git (F-18f, D-60).

- **What travels in git.** `factory.yaml` (the node, the board config, the recipe name and the projects, `session`, `limits`; the approval points come with the installed recipe) and the `setup/` folder (the coordinator text now; more setup files in FAC-M6).
- **What does not travel.** `factory.local.yaml` (personal values, credentials and values of one machine), `coordinator/` (each machine renders it from the package and from `setup/coordinator.md`), the clones and the work copies (each machine clones them), and the work state in `.factory/` (items, decisions, workers) until FAC-M3 moves it with `init --state-from`.
- **The one command.** Clone the config repo, then run `factory init` in it. `init` clones each repo, registers the factory on this machine, and asks only for the personal values: the account (the owner fields) and the mode of each approval point that the owner wants to delegate. Then `factory start` works.
- **Publish the config repo.** Add a remote to the factory folder and push: `git remote add origin <url>`, then `git push -u origin main`. Only the files of the share list go out.
- **A project with no origin.** A project with no origin, or with a local source that the user types, works on this machine, but the factory cannot be shared with it. Its local source stays in `factory.local.yaml` (key `sources`), never in `factory.yaml`. `init` and `doctor` say so.
- **A received factory is a trust boundary.** The files of another machine or person are not trusted until the owner accepts them. The lighter rule of the user's own clones does not apply to them. `init` on a received or moved factory checks the tracked paths and the ignore rules before it writes anything. A tracked local file, a tracked state path or a tracked `coordinator/` path stops the command on every factory, until the owner acts. `init` records in the factory list whether the factory is your own or received. A moved factory counts as received, because `init` cannot tell a moved factory of your own from a copy of another one (D-16). On a received factory, `init` lists every other file that the config repo tracks (apart from `factory.yaml` and `.gitignore`), and the owner accepts them together with the setup text. An absent or empty setup file does not skip them. On your own factory, a tracked instruction file or Claude settings file gives a warning only (R2). A setting that skips permission prompts, or that changes the session marker, stops on every factory.
- **The setup text needs the owner.** The text of `setup/coordinator.md` goes into session instructions. So the owner accepts its hash at the first `init`, and again after each change (D-13). After a change, `factory start` in a terminal window shows each added, removed and changed file with its text, and asks. With no terminal window, it stops and names the command (R1). With no acceptance at all, the command to run is `factory init` in a terminal window. Only `init` makes a first acceptance. `init --yes` prints the file, its hash, the folder, the node id and the reason, and accepts the setup text alone, only when no acceptance exists yet for this folder and no other tracked file is in the set. `--yes` never answers the prompt for the other tracked files of a received factory. With no terminal window, `init` stops there, also with `--yes`, and names the command. If the owner answers no in a terminal window, `init` goes on, and `start` stops until the owner accepts. The prompt shows the full text of each new or changed file, or a diff against the accepted version when git still has it. A file past the display bound is not shown in part: the prompt says so, names the path and the command to read it, and keeps no as the default. A control character shows as a visible escape.
- **Links and outside paths.** factory refuses a link, or a path that resolves outside the factory folder, in `setup/`, in `coordinator/` and in the backup of a block.
- **Your own coordinator text.** Write it in `setup/coordinator.md`, not in `coordinator/CLAUDE.md`. `init` and `upgrade` render the first file into the second. `doctor` warns about text in `coordinator/CLAUDE.md` that does not travel.

#### Stops and warnings

Factory gets in the way as little as possible (F-17). Each check is in one of three classes (F-17c):
- **A security stop (exit 4).** Only a check at a security boundary stops a command. A stop prints one line with the reason and one line with the command that fixes it. A stop with no remedy is not allowed.
- **An error (exit 1, or exit 2 for a usage error).** The command cannot run at all, for example on a platform that factory does not support. The errors of the URL and path rules also print a remedy line. Other errors keep their text.
- **A warning (exit 0).** Every other check warns. `doctor` shows the warning, and the command goes on.

A received factory is a trust boundary, so its checks are stops. The lighter rule, a warning, applies to the user's own clones. The security stops are:
- the registration check;
- the approval record guard and the session marker: a `delegated` choice with no terminal window, or inside a factory session;
- an edited or missing safety block (the remedy is `factory upgrade --overwrite safety`, which keeps the old text in a backup file);
- a local file or a state folder that git tracks or does not ignore, and a tracked path under `coordinator/` on every factory;
- on a received factory: a tracked file that the owner has not accepted, a tracked link in that set, a tracked path under a clone folder, a list of tracked files at its cap, and a file over its size cap;
- a setup file with no accepted hash, when the owner does not accept it in a terminal window;
- a link, or a path that resolves outside the factory folder, in `setup/`, `coordinator/` or the backup of a block;
- `upgrade --overwrite safety` inside a factory session;
- a value that looks like a password or a token in a tracked file;
- a setting that skips permission prompts in a checked settings file (also after an acceptance), and a checked settings file that sets or clears `FACTORY_SESSION`;
- a clone URL with credentials or with a scheme that is not allowed;
- a project path that is outside the factory folder or reserved;
- a local file that another account owns, that others can write, or that is a link.

These are warnings: a rule that allows a whole tool (for example `Bash` or `*`) in a settings file; a setting that approves project MCP servers; a tracked instruction file or Claude settings file on your own factory; a project with no shareable URL; a settings file in a clone with no skip setting; an instruction file above the factory folder; and a local file with a mode that others can read (see §4.4). A factory folder under a linked parent folder works. The link rule checks only the paths below the real folder.

Section 6 says what the approval record guard, the session marker, the setup accept prompt and the origin of a factory list entry do not prove.

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
  agent: claude              # the agent command of this node; only `claude` is built (§4.6)
  permission_mode: auto      # the only value accepted (§6)
  effort: high
  model: default
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count        # adapts to each machine
  context_prepare_pct: 30
  context_max_pct: 40
  idle_after: 2h             # FAC-M4: a worker with no activity for this time may be idle (§4.11)
tracker:                     # the default board of the node; a project can override it (§4.10)
  kind: github               # github | jira | linear | local
  items: acme/web            # where work items live (a repo, or a project or team scope)
  decisions: acme/decisions  # the decision store; private by default (§4.10)
  site: null                 # jira only: the base URL of the Jira site
  key: null                  # jira: the project key; linear: the team key
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
      variant: devflow       # optional per-project override
      tracker: { kind: jira, items: WEB, site: "https://acme.atlassian.net", key: WEB }   # optional override (§4.10)
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
  api: ~/code/api
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
| `sources` | local | True for one machine only. It holds a local path, which never goes into the shared file. |
| `state.remote` (FAC-M3) | local | It names the private place of the work state of one owner. |

**The project entry.** `url` is optional: the clone URL (§4.3). `repo` is optional: the GitHub owner and name, for the board. `path` is one folder name, and it is not a reserved name (§4.3). The recipe parses these keys. The core parses the file around them.

**Mode 600.** `init` writes the local file with mode 600. `start`, `init`, `node` and `upgrade` set a mode that has only group or other read bits back to 600, and print a notice. They stop (exit 4) when the file has a group or other write bit, when another account owns it, or when it is a link (D-14). `doctor` and every dry run only warn, and name the `chmod` command. With `factory.yaml` and no `factory.local.yaml`, `start`, `doctor` and `node` exit 2 and name `init`.

- `tracker.kind: local` takes no other tracker key: the items and the decisions stay in `.factory/` (§4.10). The schema refuses `items`, `decisions`, `site`, `key` or `watch_interval` with `local`. Every other kind needs `items` and `decisions`. `jira` also needs `site` and `key`. `linear` also needs `key`.
- A project can name its own `tracker` with `kind`, `items`, `site` and `key`. The decision store stays the one of the node, so the owner answers in one place. A project with no `tracker` uses the one of the node. The `tracker.decisions` key names a place, not the records, so it stays shared (D-9). With the `local` board the records stay in the private `.factory/`.
- `session.agent` is the program that factory starts for a session. Only `claude` is accepted now. All starts of the agent use this value (§4.6).
- `approval` maps each approval point of the recipe to `owner` or `delegated`. A point that the file does not name is `owner`. The schema refuses a point that the recipe does not list. §6 says what each value means and what proves `delegated`.
- The shared file holds no secret and no local path. `factory doctor` refuses a tracked file with a value that looks like a password or a token. The schema is checked at load with a fixed schema (Zod). An unknown key or a bad value stops the command and names the key. It never falls back to a looser default (from firstmate's fail-closed parse).
- A FAC-M2 config (the key `cells` or `approval.land`) is refused with a message to make the factory again with `init`.

### 4.5 Upgrades without loss of state

- **State has a version.** `node.json` holds `schema_version`, and `factory.yaml` holds `schema`. Each migration is one pure function from version N to N+1, with a test.
- **The upgrade order:** a dry run that prints the plan, warns when the home breaks a home rule, and checks every new file against the new schema; a backup to `.factory/backups/<ts>/`; the migrations; one commit in the state repo with the files that the upgrade wrote or moved. If one step fails, factory restores the backup and stops.
- **Managed blocks.** `CLAUDE.md` and the role templates contain blocks between `<!-- factory:begin <name> v<n> sha256=<hash> -->` and `<!-- factory:end <name> -->`. An upgrade rewrites only these blocks. The owner's text outside them stays. If the hash shows a hand edit inside a block, factory stops and shows the diff. The owner then moves the edit out of the block or accepts the loss with `--overwrite <name>`.
- **No downgrade of state.** An older CLI refuses a newer `schema_version`, with a message.
- **Parents and children can run different versions.** The report schema has its own version, and a parent reads every report version back to the oldest supported one.

**The schema 1 → 2 migration** (the first real migration; a FAC-M1 node has schema 1):

| Schema 1 | Schema 2 |
|---|---|
| `node.role: coordinator` | `node.layer: 1` |
| `lanes.<id>` | `cells.<id>` |
| `projects[]` | `recipe.projects[]`, with `recipe.id: software` |
| `projects[].pack: plain` | `recipe.variant: plain` (a per-project `variant` only when it differs) |
| (none) | `tracker.kind: local`. The owner moves to a team tracker later with `factory item import` |
| (none) | `approval.land: each` |
| (none) | `parent: null` |
| `children[]` with entries | The migration stops and changes nothing, because the children of layer 1 are cells. A child whose address is not a valid `file://` address is named (F-13). The owner removes the entries, or sets `node.layer: 2` after the upgrade and adds the nodes with `factory node add-child` |
| `.factory/protocol.md` (block `protocol`) | `.factory/roles/worker.md` (block `worker`) |
| `.factory/briefs/` | `.factory/orders/` |
| `.factory/board.json`, `waiting.json` | kept in place: they are the files of the `local` tracker |

### 4.6 Claude Code integration

- **The main session is a Claude Code session (F-3).** Dean's note says "Codex"; the decision is that factory starts Claude Code. The config names one agent command for each node (`session.agent`), so another agent CLI can come later behind the adapter of §10. Only `claude` is built now.
- factory starts a cell with `env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<proxy base_url>] FACTORY_HOME=<home> FACTORY_SESSION=<id> <session.agent> --permission-mode auto --effort <e> --add-dir <home>/.factory`, in the cell's checkout. `<session.agent>` is `claude`. It starts the coordinator the same way in the home, with one `--add-dir` for each project path.
- **Proxy.** A session uses a proxy only when the config names one: the cell's override in `cells.<id>.proxy`, else `session.proxy` of the node. The launch always clears a stray `ANTHROPIC_BASE_URL` from the shell, then sets it only from the config. So a proxy is always a choice that the config shows, never an accident of the shell.
- **Proxy check.** Before each launch, factory sends one bounded request to the proxy's `health` path. If the proxy does not answer, `on_fail` decides:
  - `stop` (the default): factory does not start the session. It prints the proxy id, the failed check and the fix, for example "start the proxy, or set `proxy: none` for this cell".
  - `direct`: factory starts the session with no proxy and records this in the cell state, so the views show it.
  This rule comes from a workspace lesson of 2026-10-16: a dead local proxy stopped all lanes for hours. The check stops that failure before it starts.
- **Proxy presets (D-45).** The devflow variant ships the preset for Subswitch. The health path is `/__subswitch/health`, and the default port is 4141 (`subswitch serve --port N` changes it). The preset gives `base_url: http://127.0.0.1:<port>` with that port. So the owner changes one number. FAC-M6 tests the preset against a stub server. FAC-M7 runs one cell of this workspace through the real Subswitch.
- `factory doctor` and `factory status` run the same check for each configured proxy. `doctor` sends it only when the config comes from `--home` or from the current folder, and the home is outside every git work tree and every other node home (the rule of `up`). For a config found in a parent folder, it sends no request and warns: "Run with --home DIR to check the proxy". For a home that fails the place rule, it sends no request and the proxy check says why. The proxy host receives the API traffic of the coordinator, so from FAC-M5 `doctor` warns when a proxy host is not loopback (`127.0.0.1`, `::1` or `localhost`). `doctor` prints `Config: <path>` first, to show which config it uses. `factory cell list` and the cells view show a Proxy column for each cell: `direct`, the proxy id, or `<id> (down)`.
- **Restore and restart.** `cell resume`, `cell restart` and the restore after a reboot (§4.11) use the same launch code, so they apply the same proxy rules and the same check.
- **Heartbeat hook (decided, D-47).** `factory cell new` writes a hook into the checkout's `.claude/settings.local.json`. `factory up` writes the same hook for the coordinator in the home. Claude Code calls the hook on SessionStart, Stop (the end of each turn) and PreCompact, and the status line command calls it too. The hook writes one line to `<home>/.factory/state/heartbeat/<session>`: the session id, the event, the time and the context percent. The context percent comes from the status line JSON that Claude Code passes, not from the screen text.
- **The status line is a user setting.** An entry in `settings.local.json` replaces the status line of the owner in that checkout. So factory writes only a wrapper, `factory hook statusline`. It records the percent from the JSON on its stdin, runs the command named in `session.statusline` with the same stdin, and prints the output of that command unchanged. With no `session.statusline`, it prints one short line, `context N%`. factory never reads the settings of the owner to find the command (§6), so the owner names it in the config. If the status line JSON has no percent field in the installed Claude Code, this section names the other source before the hook ships.
- **Consent for every settings write.** factory never edits user-level Claude Code settings. Before it writes the hook or the status line wrapper, the command (`init`, `up` or `cell new`) prints the exact change and the target file. The target is project or local scope only: `.claude/settings.json` or `.claude/settings.local.json` in the home or the checkout. The write needs a yes on a TTY, or `--yes`. With no TTY and no `--yes`, the command writes nothing, prints the change, and exits 2. A status line command that the owner set before keeps working, because the wrapper passes its output through.
- **Fixtures from the real program.** FAC-M4 captures one payload for each hook event and one status line payload from the installed Claude Code. It commits them as test fixtures. The hook tests parse these fixtures, so the claim "the percent comes from the status line" rests on a real payload, not on a made-up one.
- **No reads under `~/.claude`.** The heartbeat file gives every fact that the scripts read under `~/.claude` today: the last activity (working, idle, stopped), the session id (to resume a cell after a restart) and the context percent. So no factory code and no role template reads or copies a file under `~/.claude`. The instruction "avoid reads under ~/.claude" is not necessary, and the templates do not contain it. A static test fails on any code path that opens a file there.

### 4.7 Language, platforms, install and distribution

- **TypeScript on Node 22+**, built to one bundled file (from mars: dev mode from source, one bundled file for a release). Zod for config and state schemas, Result types and no throws in the logic (Dean's engineering rules). Commands come from one command table, not from three hand lists (a mars gap).
- **Platforms: macOS and Linux only (F-5).** factory needs tmux, git and a POSIX shell. On native Windows, `factory doctor` refuses with a hint: "Use WSL; factory runs there as on Linux". Every other command refuses with the same hint.
- **External tools:** `tmux`, `git`, `claude`, and the tracker CLI (`gh` for GitHub). factory replaces `jq`, `python3` and `glow` with its own code, so a new machine needs fewer tools. `doctor` checks the versions.
- **Portable parts:** the heavy-test lock uses `lockf` on macOS and `flock` on Linux. `factory machine` reads memory and load on both systems. The owner's clipboard command is a config value with a platform default. CI runs the full suite on an Ubuntu and a macOS runner. Tests of `lock run` and `machine` run both system paths with fixtures.
- **Install:** `npm i -g @dean0x/factory`, or `npx @dean0x/factory init`, plus a Homebrew formula in `dean0x/homebrew-tap`. An `install.sh` for curl, with a SHA256 check (mars has none). The repo is private now (D-49), so none of these is public yet. FAC-M10 builds them.
- **Release:** one `v*` tag runs the tests, checks that the version is the same in every place, makes the GitHub Release, publishes to npm and updates the tap (from mars `release.yml`). The version lives in one file only.
- **The publish is gated (D-45).** The publish job runs in a protected environment (`npm-publish`) whose required reviewer is the owner. The job starts with a gate script. The script fails unless `docs/release-approval.md` holds a line `Decision: D-<n>` and the tag version equals the version in `package.json`. So a tag alone never publishes. The repo stays private until the owner records a decision id in `docs/release-approval.md`. FAC-M10 tests the workflow with a script and checks the environment with a read-only `gh api` call.

### 4.8 What factory takes from mars and from firstmate

From **mars**:
1. Walk up from the current folder to find the config, and one "require workspace" guard (`lib/config.sh:12-27`, `:128-134`).
2. Dev mode from source, one bundled file for release (`mars:16-31`, `build.sh`).
3. One tag fans out to GitHub Release, npm and the Homebrew tap (`.github/workflows/release.yml`).
4. An installer that is safe to run again, with env overrides and a final `--version` check (`install.sh`).
5. TTY-aware output with an ASCII fallback, and spinners that do nothing on a pipe (`lib/ui.sh`).
6. Batch commands that continue after a failure and give a count at the end (`lib/commands/clone.sh:96-110`).
7. Black-box tests that run the real entry point in a temp folder (`test/test_integration.sh`).

factory avoids the mars gaps: a `version` field that is never read, no `--json`, only exit codes 0 and 1, `eval` of user input, and commands registered in three places.

From **firstmate** (github.com/kunchenguid/firstmate, MIT, read as untrusted data):
1. The code root and the private home are separate. The home is selected with one variable (`docs/configuration.md` L19–30).
2. A durable inbox plus a one-line doorbell, instead of long text typed into a pane (`bin/fm-send.sh`, `bin/fm-task-inbox-lib.sh`).
3. Node identity markers and a one-line registry entry for each child (`.agents/skills/secondmate-provisioning/SKILL.md` L16–40).
4. An explicit list of config items that a parent passes down, and items that it never passes (`bin/fm-config-inherit-lib.sh`).
5. A script-written upward channel, so a report does not depend on the model's memory (`docs/secondmate-parent-channel.md`).
6. Skipped for now (F-13: one machine only): a readiness check before the first use of a remote host (`docs/remote-secondmates.md`). factory keeps one part of it: a child home that factory cannot read is "unknown", never "dead".
7. A fail-closed config parse (`docs/configuration.md` L1380–1382).
8. Upgrades by fast-forward only. A dirty home is reported and not touched (`bin/fm-update.sh`).

**Where each idea lands (D-55).** Dean accepted the analysis, so each idea has a milestone:
- Idea 1: FAC-M1 and FAC-M2 (`--home`, the walk up, the home index of §4.3).
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

The core is general. It knows nodes, layers and roles, sessions, the inbox and reports, the owner's decisions, the tracker, capacity and the state store. It uses git only to keep its own state (the `.factory/` repo). It knows nothing of PRs, CI or the git repos of projects. A test recipe with no git and a document as output runs `init`, `up --dry-run`, `doctor` and `report`, and no core, config or comms file imports a recipe (FAC-M6).

A recipe gives the parts that depend on the kind of work:
- the role template of each layer (§5.2);
- the work cycle: the stages, their order, and the proof that each stage ran;
- the gate checks before an output is final;
- the kind of output (a PR, a document, a data set);
- the tracker mapping: which item kinds, labels and states the recipe uses;
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
  kinds:  { work: issue, decision: "issue+label:decision", andon: "issue+label:andon" }
  states: { next: Todo, progress: In Progress, done: Done }
variants: [plain, devflow]   # variants/plain.yaml (default), variants/devflow.yaml (§2.2)
```

- A recipe is data plus prompt text. It runs no code, except the `install` and `detect` commands of a variant, and only after the user confirms them.
- factory ships one recipe first: `software`. Its parts are the projects as git repos, the checkouts and worktrees, PRs, the merge gate, CI and releases. The plain variant uses plain Claude Code. The devflow variant maps the stages to the devflow commands (§2.2).
- Other recipes, for example research or content, come later. They need no change to the core.
- Cost (F-10): medium now, high later. The split is mostly in this design and in the config schema. The FAC-M1 code already keeps the software parts in a few modules.

### 4.10 Tracker connector

factory does not build its own review desk. The board, the andon items and the decisions live in the team's tracker. The owner chooses the tracker in `tracker.kind`.

**One board for many repos (F-19a).** Can one board show the work of many repos? Yes. One GitHub project can hold the issues of many repos in one board. Factory uses one project for all the repos of a factory. FAC-M3 verifies this with a real run on two repos before the board connector ships. Jira and Linear follow in FAC-M9.
- **The bound.** One list call reads one board. It uses `--limit <cap+1>`. If the board holds more than the cap, the output has a line "more than <cap>" and does not print the rest.
- **The filter.** The server filters the list (`--query`), also by repo. The reader does not filter the full list.
- **The owner rule.** The owner of the project must reach every repo that the factory lists. The board shows only the items of the listed repos.
- **The token scopes.** A read needs `read:project`. A write needs `project`.
- **The items of the factory itself.** With `local` they are in `.factory`. With `github` they are issues of the config repo.

**The choice of the tracker (F-2).** The user picks the tracker at setup, as in devflow. `init` asks "Which tracker?" on a TTY (`github`, `jira`, `linear`, `local`) and takes `--tracker <id>`, `--items` and `--decisions`. Later, `factory tracker set <id> [--project P]` changes it, and `factory tracker status` prints the tracker of each project and the result of the privacy check. `init` and `tracker set` check the decision store before they write anything. They exit 4 when the store is public. A node has one default tracker, and a project can override it (as devflow does: one machine can work on a Jira repo and a GitHub repo side by side). `item add --project P` goes to the tracker of P. The decision store is always the one of the node.

**One adapter contract.** Every adapter gives the same small set of operations:
- item: add, update, move (change the state), close;
- decision: ask (an item with the options), read the answer;
- doc: attach a file, or link a repo file;
- changes: read comments, label changes, assignee changes and open or close changes since a cursor, each with its author.

**Adapters.**
- `github` (the default): issues plus a Projects board, through `gh`. factory already needs `gh` for the `software` recipe.
- `jira` and `linear`: the same contract, through their CLI or API. `jira` needs `site` and `key`; `linear` needs `key` (§4.4).
- `local`: files in `.factory/` (`board.json` and `waiting.json`, as in the setup of today), for a node with no network or no tracker account. It has no changes and no watch: `changes read` returns nothing, and `factory watch` exits at once with a note. `factory item list` and `factory andon list` show the items; there is no other UI. The owner answers a decision in the CLI with `factory decide <D-n> <option>`. `local` is also the test double of the connector: the contract tests run against `local` and against each real adapter. In this workspace, the review page and the scripts of today stay as the owner view during the `local` period. They read the `local` files (the same format as today). FAC-M3 retires them.
- No review desk. Dean said that the factory has no review desk of its own, not even as an option (F-2, F-17). No tracker kind and no command makes one.

**Decisions.**
- A decision is an item with the `decision` label. Its body has the question, the options and a recommendation.
- The owner answers with a comment `/choose <option>`, or with a label `choose:<option>`.
- `factory decide read` reads the answer with a script, not with model tokens. An answer counts only when its author is the owner's tracker account (`owner.github` for GitHub). The script records the decision in `decision-log.json`, with the comment link and the author.
- With `local`, `factory decide <D-n> <option>` records the answer with `by: owner`. It needs a TTY, and it refuses (exit 4) inside a session that factory started (factory sets `FACTORY_SESSION` at each launch). This guard stops a session from answering by accident. The owner's permission settings are the second guard.
- An *ask* is a decision item for one PR or one work item. The owner answers `approve` or `refuse` in the same way. §6.1 says which answers count as an approval.

**Tracker identity.** The author of a tracker event proves the owner only when the agents write with another identity. If the cells and the coordinator use the owner's own account, an agent can post a comment, a label or an assignee that looks like the owner's.
- `tracker.agent_account` names the identity that the agents use: a machine user, or a GitHub App with its own token.
- A tracker event counts as an owner proof only when two things are true: its author is the owner account, and `tracker.agent_account` is set to another account.
- When `tracker.agent_account` is unset, or equal to the owner account, the account is *shared*. Then `doctor` warns, and no tracker event counts as a proof: no comment answer, no label and no assignee. Only `factory decide <D-n> <option>` from a TTY outside a factory session counts. With a shared account, `factory decide` works with every tracker kind. It records `by: owner` in the decision log and adds a comment to the item that says the answer came from the CLI. That comment is a record, not a proof.
- With `local`, there are no tracker events, so only `factory decide` counts in every case.
- The setup text (README and `factory doctor`) tells the owner how to make a machine user or an app for the agents.
- Designs and plans: the `doc` operation links the repo file (GitHub shows Markdown), or attaches it.

**Changes and wake-up (F-2).** There is no live push to a local session without a webhook server. So `factory watch` calls `changes read` with the tracker CLI at a fixed interval (`tracker.watch_interval`), with a bound on the number of reads per run. The coordinator reads these owner actions:
- a comment `/choose <option>`, and a mention of the coordinator;
- a label added or removed, for example `choose:<option>` or `ready` (a work item is ready);
- an issue or item opened or closed.

An event counts only when its author is the owner's tracker account. An event from another account wakes nobody, and the digest counts it as "other". With a shared account (see "Tracker identity"), an owner event still wakes the coordinator, but it never counts as a proof. An assignee change is read, because it is a proof of assignment (§6.1). A card moved on a Projects board is not read for now; the owner uses a label for that signal. `watch` calls no model. For each new owner event, it writes one record into `.factory/inbox/` and rings one constant doorbell line in the coordinator pane (§4.12). `factory up` starts `factory watch` in the window `ops` (§4.11).

**Privacy.** An issue in a public repo is public. Decision items can hold private facts. So the default decision store is a private repo, or private draft items in a private Project. `factory doctor` fails when the decision store is public, and warns when it is not set. The `local` store is private: it is the node's own state repo, with no remote.

### 4.11 Sessions in tmux: bench, view and stop

**Layout (F-8).** `factory up` makes one tmux session per node, named with the node id. It has these windows:
- **bench**: one pane for each cell. The cells keep running there.
- **view**: the coordinator, plus one slot. The slot shows the board, or a cell on request (`factory cell summon <cell> [--for 15m]`). When the time ends, the slot shows the board again.
- **ops**: `factory watch` (§4.10). The window exists only when the tracker is not `local`, because `local` has nothing to watch. `up --dry-run` lists it.

`factory up` attaches when the session runs already. It never starts a second coordinator for the same home. The pane options are `@factory_home`, `@node`, `@slot` and `@cell` (the cell id, on a bench pane).

**After a reboot.** A reboot kills the tmux server. `factory up` on a dead server starts the coordinator, and then runs `cell restart --all` from the heartbeat files. Each cell resumes with the session id that its heartbeat file holds. So a reboot needs no tmux-resurrect scripts.

**Stop (F-7).** The safe way to stop a session is not known yet. The rule for the word "safe" comes first, in `docs/session-stop.md`, before any test. A way is **safe** when all four facts hold:
1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

Then a test runs in a throw-away session. It tries each way: `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. A busy session is the hard case (F-7), so it tries each way twice: once on an idle session, and once on a busy session (a tool runs and a background agent runs). The table has one row for each way and each case, with the four facts and the verdict "safe" or "not safe".

Then `factory cell stop` uses the way that is safe for the case of the cell. If the cell is busy and no way is safe for a busy cell, `cell stop` exits 3 ("not ready") and names what runs. Until the test: stop only an idle session (no tool, no agent and no prompt in flight), then send `kill -TERM`. The test is a task of the cell-control milestone (roadmap-v2).

### 4.12 Communication module

All text that reaches another session goes through one module, `src/comms/`, with one interface of four calls (F-12):
- `send`: write one numbered record into the inbox of a cell, then ring the doorbell in the cell pane;
- `deliver`: write one record into the inbox of a child node (the `file://` transport, §5.3);
- `report`: read the digest of a child node;
- `ping`: read the identity of a node, or `unknown` with a reason.

The rules:
- **The doorbell is constant.** The line typed into a pane has no message text. It names the inbox and tells the session to read it. The message is a numbered file, in the format of firstmate (a short header, then the exact text), with a `schema` field. The session acknowledges a record when it moves it to `handled/`. The cell finds its inbox through the variable `FACTORY_INBOX`, which the launch sets.
- **`factory inbox next` and `factory inbox ack <n>`** print the oldest unhandled record, and move record `n` to `handled/`. A plain `mv` also works. The commands keep the format private to factory.
- **Owner authority stays in the typed line.** `cell relay` types the owner prefix, the record number and a short hash of the record. A record alone never carries authority (§5.5).
- **Only this module types into a pane.** No code outside `src/comms/` calls `tmux send-keys`. The slash commands of `changeover` (`/clear`, `/compact`) also go through it. A typed line is at most 300 characters. `cell changeover --order` and `cell recover` send their text with `cell send`, never as typed text.
- **Nothing outside the folder reads or writes inbox files.** The file format is the contract. The folder can become a package when a second tool must import it.

### 4.13 Core and setup

factory has two kinds of files. The **core** is the metal: the code, and the fixed rules that every factory needs. A **setup** is the text and the scripts that a person adds on top of the core (F-16). A setup is code. Its role texts and its coordinator text are session instructions, and a session obeys them. Dean's own examples are setup (F-16a). The fixed rules are core (F-16d).

| Part | Kind | Rule |
|---|---|---|
| The priorities rule | setup | A person writes it. A second factory can take it from a shared setup. |
| The lifecycle of work (plan, build, review, fix, release) | setup | The recipe gives a default. A person can change it. |
| The review rules | setup | The recipe gives a default. A person can change it. |
| The role texts | setup | The recipe renders the role block. A person adds text outside the core blocks. |
| The scripts | setup | A script is a file of the setup. The owner accepts it (FAC-M6). |
| The fixed rules (the `safety` block) | core | It is the metal. An edit cannot remove it: `doctor` and `start` check its hash. |
| The role block that the recipe renders | core | The package renders it again when the setting or the package changes. |
| The factory part of the `.gitignore` | core | It keeps the private files out of git. A person adds lines outside it. |

- A setup adds text only outside the core blocks.
- **The fixed rules are checked.** The `safety` block is a managed block with a hash in its marker. An edited or missing `safety` block stops `start` (exit 4) and fails `doctor`. The remedy is `factory upgrade --overwrite safety`. It renders the block again and keeps the old text in a new backup file in the state folder (at most 10 are kept). It runs only in a terminal window, outside a factory session. A block that is intact but differs from the text that the package renders now (a new package version, or a changed prefix) is rendered again with a notice. A role block that a person edited stays, with a warning.
- **The check needs the rendered text of each machine.** So `coordinator/CLAUDE.md` is not tracked (D-1). Every file that a person needs to make the factory again is in the tracked folder: the coordinator text in `setup/coordinator.md`, the recipe choice with its list of approval points, the board config, and the setup files of FAC-M6. The mode of each point is per person and stays in the local file.
- **In this design the owner accepts the hash of `setup/coordinator.md`** (D-13). The setup acceptance of every setup file, and the upgrade rule (an upgrade never overwrites a setup file), come with FAC-M6.
- factory starts Claude Code only. The instruction-file warning also names `AGENTS.md`, because other common agents load that file (§4.3).

### 4.14 Extension points

factory has no review desk of its own, not even as an option (F-2, F-17). A person who wants a desk builds a reader on one of these extension points. Each point has a milestone.

| Extension point | What it gives | Milestone |
|---|---|---|
| Board connector contract | The operations of §4.10: item, decision, doc and changes. A new board kind implements it. | FAC-M3 (GitHub), FAC-M9 (Jira, Linear) |
| Event file | The digest of the node in `.factory/outbox/`, written by script (§5.4). A reader follows it. | FAC-M5 |
| `report --json` | The digest on demand, in the same format (§5.4). | FAC-M5 |
| Recipe registration | A recipe is registered in the recipe registry. This is a code path. A new recipe needs no change to the core (§4.9). | FAC-M6 |
| Setup files | A script and one line in the setup list. The owner accepts each file (§4.13). | FAC-M6 |

A person with no code skill adds a desk reader as a setup file in FAC-M6. FAC-M5 ships a sample reader outside `src/`. It reads the event file and `report --json`, and prints one line for each work item.

## 5. Layers: same mechanics, one role per layer

### 5.1 The node

Every node has the same mechanics: `factory.yaml` and `node.json`, the report digest that goes up, the inbox that comes down, and the CLI. A node has an `id`, a `layer`, an `owner`, a `parent` (or null) and `children`. This is the node as `factory report --json` shows it; the files keep each fact once (`factory.yaml` holds identity, owner, layer, parent and children).

```json
{ "id": "acme-web", "layer": 1,
  "owner": { "display": "Ana", "github": "ana-x" },
  "parent": { "address": "file:///home/example/work/acme-factory", "id": "acme" },
  "children": [
    { "kind": "cell", "id": "web-checkout", "pane": "@cell=web-checkout" },
    { "kind": "cell", "id": "web-search", "pane": "@cell=web-search" }
  ] }
```

### 5.2 Layers and roles (F-4)

- **Layers count from the bottom.** Cells are layer 0. Their managers are layer 1. The managers of layer-1 nodes are layer 2, and so on. A new top layer changes no node below it.
- **The role comes from the layer.** A node does not choose its role. factory sets it from `node.layer` and the recipe's role template for that layer.
- **Each layer has its own role template.** Every node on one layer uses the same template. A node on another layer uses another template, because a different layer works differently (F-4). The `software` recipe ships these:
  - layer 0, **worker**: runs the work cycle (plain or devflow) on one track of one project. Text: `roles/worker.md`, which every cell reads.
  - layer 1, **coordinator**: manages cells across one or many projects (the Orchestrator today). Text: the managed blocks of the home's `CLAUDE.md`. One block, `projects`, lists the projects of the node: the id, the variant and the stage-to-command map of each. `init`, `recipe variant` and `upgrade` write it from `recipe.projects[]`. So the coordinator knows that it runs one plain project, one devflow project, or both. Two coordinators with different project sets have the same text except this block.
  - layer 2, **manager**: manages coordinators. It handles priorities, capacity and owner items across its children, and does no PR-level work. A first template, which the owner edits when that layer becomes real.
  - layer 3, **director**: manages managers. FAC-M8 ships a separate template for it.
  - A layer above 3 has no template yet. A node on a layer with no template gets the `safety` block and no role block. `doctor` warns and names the layer. The recipe or the owner adds the template, and no node below changes.
- **All children of a node are on one layer**, the layer just below it. `factory node add-child` refuses a child from another layer. `factory cell new` refuses on a node that is not on layer 1.
- A cell is a layer-0 node with no home of its own. Its inbox and heartbeat live in its parent's home (`.factory/cells/<id>/`, `.factory/state/heartbeat/`).

### 5.3 Addresses

- A child is named by a relative path from its parent: `acme/acme-web/web-checkout`. A path is unique because each id is unique among its siblings.
- A transport says how to reach a node. factory has one transport: `file://<absolute home path>`, on the same machine (F-13). It has the four calls of the comms module (§4.12): `send`, `deliver`, `report` and `ping`. The config refuses any other address, for example `ssh://` or `https://`. A remote transport can come later behind the same four calls, with no redesign.
- A parent reaches a cell only through the cell's own parent node. It never types into a grandchild's pane.

### 5.4 What goes up

`factory report --json --since <cursor>` returns one digest:
- node id, layer, factory version, report schema version, and the cursor for the next read;
- cell states and context use (from the heartbeat files);
- tracker counts by state and priority, and the items in progress;
- milestone events since the cursor (PR ready, merged with SHA, released with version, blocked);
- the andon items, each with its **origin path** (for example `acme/acme-web#D-4`);
- the reports of the node's own children, already merged (a rollup).

So a node at any depth sees its whole subtree in one call. The digest is also written to `.factory/outbox/` by script, so the facts do not depend on the model's memory.

### 5.5 What goes down

- **Work orders:** a brief or a decision record goes to the inbox of a cell or a child node. `factory decide read` writes the decision record to the origin node's `inbox/`, through each node on the path. Each relay adds its own id to the record's `chain`.
- **Priorities:** a parent sends a `priorities` record. The child applies it to its tracker items and reports the result.
- **Inherited config:** the parent passes only items on an explicit list (limits, the writing style, the safety rules), kept as one constant. Owner identity, accounts and session settings are never passed. FAC-M8 tests this.
- **Owner authority** comes only from the owner. A record carries authority only when its `by` is the owner of the target node and it arrived through the parent channel. If a parent node has a different owner (a team lead over a member's node), its records arrive as **requests**: the child's owner decides them. This is how a team works without a shared founder.
- In a cell pane, factory types only the one-line owner prefix and a pointer to the inbox record (`factory cell relay`). The record holds the text.

### 5.6 Where state lives, and how a parent reads it

Each node keeps its state in its own home (§4.3). A parent never reads or writes a child's files directly, except through `deliver` into the child's inbox. It reads the child only through `report`. Then the file format inside a node can change at an upgrade, and only the versioned report format is a contract.

### 5.7 What the CLI does now, so that a layer needs no redesign

- `factory.yaml` has `node.layer`, `parent` and `children` from day one, also in a node with no parent.
- Every owner item and every event carries an origin path, also at depth 1.
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

Each standing rule goes into a new setup in two ways. The text goes into the managed blocks of `CLAUDE.md` and the role templates. Where a script can enforce the rule, factory enforces it in code, so a model error cannot break it.

| Rule | Text (managed block) | Code enforcement |
|---|---|---|
| Every session runs in auto mode | yes | `session.permission_mode` accepts only `auto`. Every launch adds `--permission-mode auto`. |
| Never skip permissions | yes | factory has no flag or config value that adds the skip flag. `doctor` reports a node or checkout whose settings set the bypass mode. |
| A proxy only by explicit config, and only when it answers | yes | Every launch clears `ANTHROPIC_BASE_URL`, then sets it only from `proxies` in the config (§4.6). A health check runs before each launch and in `doctor` and `status`. On failure the default is `stop` with the fix in the message; `direct` is an explicit choice. `doctor` sends the check only when the config comes from `--home` or from the current folder, and the home is outside every git work tree and every other node home. For a config in a parent folder, `doctor` sends no request and warns to run with `--home DIR`. For a home in a git work tree or in another node home, `doctor` sends no request and the home check fails. `doctor` warns when the variable is set in the shell. |
| No proxy keys or tokens in output | yes | `proxies` holds no keys; `doctor` refuses token-like values there. Output shows only the proxy id and its host and port, never user info, query strings or headers of the base URL. |
| A denial is final; no laundering through another session | yes | `cell send` and `cell relay` refuse a text that asks a cell to run a command that the node recorded as denied (a `denied` list in state). |
| Never invent the owner's consent | yes | `cell relay` types the owner prefix only for a decision record in `decision-log.json` with `by: owner`. `decide read` records `by: owner` only for an answer from the owner's tracker account, and only when the agents use another account (`tracker.agent_account`). With a shared account, or with `local`, only `factory decide` counts: it needs a TTY and refuses inside a session that factory started. `doctor` warns on a shared account. |
| Decisions stay private | yes | `doctor` fails when the decision store is public, and warns when it is not set (§4.10). |
| No secrets in output | yes | No command prints env values. `doctor` refuses token-like values in `factory.yaml`. Process lists show only pid, elapsed time and command name. |
| Peers never ask the owner directly | yes (role templates) | none (model behavior) |
| One session per checkout | yes | `cell new` refuses a checkout that another cell uses. |
| The coordinator instructions never reach a cell | yes | `init` refuses a home inside a git work tree, inside another home, or above a project (§4.3). |
| Merges follow the owner's merge rule (F-6) | yes | `approval.land: each`: `pr merge` needs an owner decision or an answered ask for that PR and head SHA. `approval.land: approved-work`: `pr merge` needs one proof of approval and one proof of assignment (§6.1). In both cases it passes `--match-head-commit <full SHA>` only after `inspect` passed at that SHA, and refuses when the head changed. `--admin` only by the node, at the pinned head. |
| Releases need the owner's go | yes | `approval.ship: each` is the only accepted value (§6.2). `ship` commands only check; they do not publish. |
| Never bypass the state hook | yes | `init` sets `core.hooksPath`; every state write commits through the helper, which refuses when the hook is off. |
| Never delete another cell's files; look before removing | yes | `checkout clean` is a dry run by default and refuses a worktree with unpushed work or a path that a cell or resume file names. |
| Resource limits; one heavy suite at a time | yes | `cell new` checks the limits; `lock run` takes the machine lock. |
| Look before typing; target by pane id | yes | Every typed input captures the pane first, refuses an open dialog, clears the input, and checks that the text arrived. Only `src/comms/` types into a pane, and a typed line has at most 300 characters (§4.12). |
| Supported platforms only | no | Every command refuses on native Windows, with the WSL hint (§4.7). |

The default for a new node is `approval.land: each`: every merge waits for the owner. The owner can choose `approved-work`. This workspace uses `approved-work` (D-52).

factory never reads or writes under `~/.claude/` (settings, rules, skills, transcripts or session files). It writes only to three places: the node home, each checkout's `.claude/settings.local.json` (the heartbeat hook, D-47), and the per-user home index of §4.3, which is outside `~/.claude`.

### 6.1 What counts as approval and assignment (D-52)

With `approval.land: approved-work`, `pr merge` needs two proofs: the owner approved the work, and the owner assigned it to a cell or a track. The proof of approval is one of three forms:
1. **A decision.** A record in `decision-log.json` with `by: owner` that approves the work. The record names the work: a PR, an item or a track.
2. **An ask.** An ask item (§4.10) for the PR or the work item, with the answer `approve` from the owner's account. With `github`, the answer is the comment `/choose approve` or the label `choose:approve`. With `local`, the owner types `factory decide <D-n> approve` in a terminal outside any factory session.
3. **An approved plan.** An ask or a decision item that names the plan file (its path and its commit SHA), answered `approve` through the owner channel. With `github`, the answer is a comment or a label by the owner's account, read through the adapter. With `local`, it is `factory decide` from a TTY outside a factory session. The plan text itself proves nothing.

The assignment is direct, by a decision, or by the tracker:
- Direct: the proof of approval names the cell or the track.
- By a decision: a second record by the owner names the cell or the track for that work.
- By the tracker: the owner's account sets the assignee or a `cell:<id>` label on the work item. `factory watch` reads the change through the adapter (§4.10).

Every tracker proof above (a comment answer, a label, an assignee) needs separate identities: the agents write with `tracker.agent_account`, not with the owner account (§4.10, "Tracker identity"). With a shared account, no tracker proof counts. Then only a decision recorded by `factory decide` from a TTY outside a factory session proves approval or assignment.

These do not count:
- chat text;
- an answer, a label or an assignee change from another account;
- a record that names another PR or head SHA;
- a commit author or a `Status:` line in a file. Agents can commit with the owner's own account, so a commit author proves nothing;
- any tracker event while the agents and the owner share one account.

An approval in chat becomes a proof when the owner records it in one of the three forms. With `approval.land: each`, only a decision or an answered ask for that PR and head SHA counts; a plan does not.

An open question of the owner blocks the merge (D-52). `factory inspect` gives `NOT READY` while the PR has an open ask or an open andon item.

### 6.2 Releases (D-57)

D-52 does not cover releases. Whether the owner's approval of work includes the release is an open question: **D-57**, which Dean has not answered. Until he answers, the key `approval.ship` accepts `each` only. Every release waits for the owner's go. The schema refuses any other value and names the key. If Dean answers that approved work includes the release, a later version adds a value and a test. `ship check|verify` read only and publish nothing in every case.

## 7. Generic names

The setup uses Dean's name and devflow's words in many places. factory uses these names; a node shows the owner's display name in the views.

| Today | In factory |
|---|---|
| founder, Dean | owner (the display name from `factory.yaml`) |
| lane | cell |
| workflow pack | recipe (and its variant) |
| On Dean, `on-dean.json`, `dean-review.html` | andon items in the tracker (the `local` files and the old page until FAC-M3) |
| board, `board.json` | tracker items |
| merge order | staging |
| brief | work order (`.factory/orders/`) |
| clear or compact between phases | changeover |
| merge gate | `factory inspect` |
| release check and verify | `factory ship check|verify` |
| Orchestrator | coordinator (the layer-1 role); the session name is the node id |
| lane protocol | worker role template (`.factory/roles/worker.md`) |
| `.devflow/` (workspace state) | `.factory/` |
| `DEAN_DIR` | `FACTORY_HOME` |
| `/devflow:plan` … `/devflow:release` | stages `plan`, `build`, `review`, `fix`, `release` |
| Code, Validate, Test agents | implementer, verifier, tester agent kinds |

Every user-visible name sits in `src/names.ts`, and a test fails on a stray literal. So a rename changes one file plus the tests. Every name of the table in §4.1 has a plain description in `docs/glossary.md` (at most 25 words), and `factory help words` prints them.

### 7.1 Dean's shop-floor words (F-1)

Dean found 11 words for the physical layout of a factory. The list ends with the heading "machinery and automation hardware", which has no items. The paste has no missing text. So no word comes from that heading. Each row says where factory uses the word or why it does not. Dean can change any row; the answer then goes into a decision record.

| # | His word | In factory |
|---|---|---|
| 1 | assembly line | Not used as a name. A cell does all the stages for one track, so there is no line of stations. The ordered stages are the **work cycle** (§4.9). |
| 2 | functional cells | Used as **cell** (§4.1): a worker session that does all the stages for one track of one project. |
| 3 | linear sequential layout | Not used. The stages of a track run in order inside one cell, so the layout of the folders (§4.3) is not a line. |
| 4 | receiving inbound docks | Used in meaning: the `inbox/` folder is where work orders arrive (§4.12). The name stays `inbox`, because it is the plain word. |
| 5 | staging areas | Used as **staging**: the merge order (§4.1). |
| 6 | workstation cells | Used as **cell**, the same word as row 2. |
| 7 | buffer zones | Used in meaning: the `Todo` state of the tracker is where work waits for a cell (§4.9, `tracker.states`). The name is not used. |
| 8 | quality inspection | Used as `factory inspect`, the merge gate (§4.2). |
| 9 | pack out | Not used as a name. The package check before a release is a part of `factory ship check`. |
| 10 | shipping docks (his text: "chipping docks") | Used as `factory ship`: the release check and verify (§4.2). |
| 11 | metrology lab | Used in meaning: `factory doctor` checks the tools and `factory machine` measures the machine (§4.2). The name is not used. |

## 8. Migration of this workspace

`factory adopt ~/Sandbox` imports the current setup into a node. A dry run comes first. The adopt runs only when all lanes are idle and pushed. It does these steps (FAC-M7):
1. It makes a node home next to the projects, for example `~/Sandbox/sandbox-factory`. The Orchestrator moves there from the workspace root.
2. It moves the Orchestrator text of `~/Sandbox/CLAUDE.md` into the `CLAUDE.md` of the new home, and keeps a copy in `.factory/backups/`. It leaves no coordinator text in any `CLAUDE.md` on the path from a cell checkout to the root: the old file is removed, or it keeps only lines that every cell may read. The dry run shows this change, and the owner confirms it. Only then do the lanes stop loading the Orchestrator instructions (F-3). Without this step, they still load them, because the file sits above every checkout.
3. It moves `decision-profile/` and the roadmaps to `.factory/`, keeps the git history (a `git mv` in the state repo), and writes `factory.yaml` from the facts in CLAUDE.md §13.
4. It imports the board and the On Dean items into the `local` tracker files. The review page and its scripts stay as the owner view, and the owner can still answer there. FAC-M3 moves the items into GitHub issues with a private repo as the decision store (F-2), and retires the page and its scripts.
5. It sets `approval.land: approved-work` (D-52).
6. It adds the devflow variant to the devflow projects.
7. The lanes become cells on the bench window (F-8).
8. It runs one cell through the real Subswitch and records the run (D-45).

### 8.1 Parity table

Each part of the setup of today (§1.1) has an owner in factory: a command, a milestone, or "retired, because X". The column Status is `planned` until the milestone ends. Then it is `done` or `retired`. A row is due at the last milestone that it names, in build order. `scripts/check-parity.sh <milestone>` reads this table and fails on any due row whose Status is not `done` or `retired`. At the end of FAC-M7 it must pass for FAC-M7. At the end of FAC-M3 it must pass for all rows.

| Part (§1.1) | In factory | Milestone | Status |
|---|---|---|---|
| `~/Sandbox/CLAUDE.md` | The `coordinator` and `safety` blocks of the home `CLAUDE.md`; `adopt` moves the text (step 2) | FAC-M2, FAC-M7 | planned |
| `protocol.md` | The worker role template `.factory/roles/worker.md` | FAC-M2 | planned |
| `status.md` | The output of `factory status` | FAC-M5 | planned |
| `respawn-map.md` | The heartbeat files, `cell restart --all` and the restore of §4.11 | FAC-M4 | planned |
| `orchestrator-resume.md` | `.factory/resume/` and `factory self changeover` | FAC-M4 | planned |
| `roadmaps/` | `.factory/roadmaps/`; `adopt` moves the files | FAC-M2, FAC-M7 | planned |
| `board.json`, `board.md`, page | The `local` tracker files and `factory item`; then the tracker items | FAC-M5, FAC-M3 | planned |
| `lanes.json` | The heartbeat files and `factory cell list` | FAC-M4 | planned |
| `on-dean.json`, `decision-log.json`, `on-dean.md` | `factory andon`, `factory decide` and `.factory/decision-log.json` | FAC-M5 | planned |
| `board-detail.md`, `board-log-*.md`, `done.md` | The item body and its comments in the tracker; `item close` records the reason in the state repo | FAC-M5 | planned |
| `briefs/` | Work orders in `.factory/orders/`; `cell new --order` | FAC-M2, FAC-M4 | planned |
| `review/dean-review.html`, `review/README-decision-pages.md` | Kept as the owner view of the `local` period. Retired when the tracker UI shows the items and the decisions | FAC-M3 | planned |
| `boardlib.py`, `render-board.py`, `render-dean.py` | Kept for the `local` period. Retired: `factory item` and the tracker UI replace them | FAC-M3 | planned |
| `board-set.sh` | `factory item add|update|move|close` | FAC-M5 | planned |
| `lane-set.sh`, `lane-lib.sh` | `factory cell` commands and the heartbeat files | FAC-M4 | planned |
| `state-commit.sh`, `git-hooks/pre-commit` | The state commit helper and the delete-guard hook that `init` installs | FAC-M5 | planned |
| `layout.sh`, `lane-summon.sh` | `factory layout` and `factory cell summon` | FAC-M4 | planned |
| `md-view.sh` | Retired, because the slot runs `factory item list` and needs no `glow` | FAC-M5 | planned |
| `lanes-refresh.sh`, `lanes-table.py` | `factory cell list` and `factory cell watch` | FAC-M4 | planned |
| `live_boxes.py` | `factory machine` | FAC-M4 | planned |
| `tmux-save-map.sh`, `tmux-restore-lanes.sh` | The heartbeat files, and `factory up` on a dead server runs `cell restart --all` (§4.11) | FAC-M4 | planned |
| `tmux.conf` | Retired, because `factory up` and `factory layout` set the options of each session, and the restore needs no resurrect plugin | FAC-M4 | planned |
| `scripts/test-*` | The test suite of the factory repo | FAC-M1 | done |
| `priorities/apply-labels.sh` | Retired, because it was a one-time script. `factory issues audit` finds unlabeled issues | FAC-M5 | planned |
| `decision-profile/` | `.factory/decision-profile/`; `adopt` moves the content | FAC-M2, FAC-M7 | planned |
| `state/`, `locks/` | `.factory/state/`, `.factory/locks/`; `factory lock run` | FAC-M2, FAC-M5 | planned |
| Global rules in `~/.claude/rules/devflow/` | Retired as a part of the setup, because devflow installs them and factory never writes there (§2.1). The role templates hold factory's own short rules | FAC-M2 | planned |

## 9. Decisions

### v1 (2026-11-01)

Dean accepted every recommendation in this table on 2026-11-01 (D-45 A, with the name `factory`; D-47 yes for the heartbeat hook). D-46 B set the merge rule; D-52 replaced it for this workspace.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Language | (a) TypeScript on Node; (b) Bash like mars; (c) Go single binary; (d) Python | **(a).** It fits your engineering rules (Zod, Result types), devflow is TypeScript, and npm is the existing channel. Bash has no schemas and a JSON state model is hard in Bash 3.2. Go removes the Node need, but it is a new stack in your repos. |
| 2 | Name and package | (a) `factory`, npm `@dean0x/factory`; (b) another name | **(a), with a check.** The npm name `factory` is taken; `@dean0x/factory` is free (checked 2026-11-01). A company named Factory sells an AI coding agent, so people can confuse the two. |
| 3 | License | MIT, Apache-2.0, private | **MIT**, like mars and devflow. |
| 4 | Public or private | (a) private now, public later; (b) public now | **(a).** The repo `dean0x/factory` is private (D-49). It goes public when a team member installs it on a new machine, if Dean agrees. |
| 5 | State folder and config | (a) `.factory/` and `factory.yaml`; (b) other names | **(a).** Never `.devflow/`, because devflow writes there. |
| 6 | Where a single-project node lives | (a) always a separate node folder; (b) also inside the repo | **(a).** v2 makes it a rule: the home is never inside a repo (F-3). |
| 7 | Heartbeat hook | (a) factory writes a hook in each checkout's `.claude/settings.local.json`; (b) keep the reads of Claude Code's private files | **(a).** v2: it replaces every read under `~/.claude` (F-9). |
| 8 | Conflicts of §1.3 | my proposals in §1.3 | **Accept them.** v2 updates the answers (§1.3). |
| 9 | Remote transport | (a) SSH only at first; (b) a small server | **Replaced by F-13 (2026-11-02):** one machine only for now, with `file://` addresses only. |
| 10 | Python and glow | (a) port the Python scripts and the viewer into factory; (b) keep them as external tools | **(a).** Fewer tools on a new machine and one test suite. The tracker removes most of the render scripts (F-2). |
| 11 | Team defaults | (a) each member owns a root; a lead's node sends requests (§5.5); (b) one shared owner | **(a).** No name or account is fixed, and nobody acts on another person's authority. |
| 12 | Where the Subswitch settings live | (a) factory core has only a generic `proxies` entry; a preset ships in the devflow variant; (b) the preset is in factory core | **(a).** The default setup then names no devflow tool. |

### v2 (2026-11-02)

| Id | Decision |
|---|---|
| D-49 | The code goes to the private repo `dean0x/factory`. No public visibility, no npm publish, no tag. |
| D-51 A | No second review of FAC-M1 now. The review of the v2 code covers the setup and upgrade code. The review of the FAC-M2 PR names `init`, `upgrade` and `doctor`, and its summary lists those files (roadmap, FAC-M2). |
| D-52 | This workspace: approved and assigned work merges when the gates pass. Releases are not part of it. factory offers the rule as an owner choice. §6.1 lists the proofs. |
| D-53 | Dean accepted the proposals F-1 to F-10 as a set ("Changes from v1" above). |
| F-13 | One machine only for now. No `ssh://` transport, no remote readiness check and no remote child. The config refuses any address but `file://`. |
| D-56 | The build order is FAC-M2, M4, M5, M6, M7, then M3, M8, M10, M9 (roadmap-v2; FAC-M10 is the release milestone, added after the intent check). |

**Open point: D-57.** F-6 asked whether "a-z" includes releases. Dean has not answered. The question is on his page. Until he answers, `approval.ship` accepts `each` only (§6.2). The roadmap lists D-57 under "Decisions needed", before FAC-M5.

### Intent fixes (2026-11-02, table OD)

An independent check of the design against Dean's notes found open points. The Orchestrator decided them. The decisions are final until Dean changes them.

| Id | Decision |
|---|---|
| OD-1 | The review page of today and its scripts stay as the owner view until FAC-M3. FAC-M7 keeps them. FAC-M3 retires them (§4.10, §8). |
| OD-2 | The proofs of approval follow D-52 as written: a decision, an ask or an approved plan. A plan counts only through an ask or decision item answered `approve` by the owner; a commit author is no proof. The assignment is direct, by a decision, or by an assignee or `cell:<id>` label that the owner's account sets. `inspect` gives NOT READY while a PR has an open ask or andon item (§6.1). |
| OD-3 | Releases: `approval.ship: each`, the only value. D-57 stays open (§6.2). |
| OD-4 | "Codex" in note F-3: factory starts Claude Code. The config names one agent command for each node, and only `claude` is built (§4.6). |
| OD-5 | Each layer has its own role template. FAC-M8 ships the template of layer 3. `doctor` warns when a layer has no template (§5.2). |
| OD-6 | The tracker adapter reads comments, label changes, assignee changes and open or close changes. Card moves stay out for now. `up` starts `watch` (§4.10, §4.11). |
| OD-7 | The tracker scope is a node default plus an override for each project, as in devflow. `tracker set` and `tracker status` exist. Jira has `site` and `key` (§4.4, §4.10). |
| OD-8 | The word list of Dean ends with the heading "machinery and automation hardware". A table in §7.1 maps each of his 11 words. |
| OD-9 | The state repo can push to a private git remote that the owner names. `init --state-from` clones it on a second machine (§4.3). |
| OD-10 | A tracker event proves the owner only when the agents use another identity (`tracker.agent_account`). With a shared account, `doctor` warns and only `factory decide` from a TTY outside a factory session counts (§4.10, §6.1). |

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

- **Claude Code changes its hook events, status line JSON or CLI flags.** All Claude Code calls sit in one adapter, with a test that `doctor` runs against the installed version. The heartbeat hook uses only documented hook events.
- **A dead proxy stops every cell that uses it.** The health check runs before each launch, the default is `stop` with a clear fix, and the views show which cells use a proxy (§4.6).
- **tmux typing is fragile.** factory types only one short line per message and keeps the text in the inbox. Each typed input is checked by a capture.
- **Tracker limits and cost.** The tracker APIs have rate limits, and reads cost time. `factory watch` reads at a fixed interval with a bound per run, and caches in `.factory/state/`. A tracker that does not answer is "unknown", never "no answer".
- **A false decision answer.** Anyone with access can comment on a decision item. `decide read` accepts only the owner's account, and records the author and the link. If the agents write with the owner's account, an agent can fake an answer. So a tracker answer counts only when `tracker.agent_account` is another account; else only `factory decide` counts.
- **A public decision store.** `doctor` fails on it (§4.10).
- **The renames and the schema 2 migration touch every part.** They come first in the roadmap, before more code uses the old names. The schema 1 → 2 migration has a test, and every name sits in `src/names.ts`.
- **Scope grows.** The roadmap ships the CLI in stages. Each stage is useful for this workspace before the next one starts. Other recipes and other trackers wait until the `software` recipe on GitHub works.
- **Two copies of the setup during the move.** The adopt is one step with a dry run. The old page and scripts stay as the owner view of the `local` period and read the same `local` files, so there is one source of truth. FAC-M3 retires them, and a search finds no process that calls them.
- **The status line of the owner is a user setting.** A checkout setting replaces it. The wrapper of §4.6 passes its output through, and a test checks this.
- **A release publishes by mistake.** The publish job needs a protected environment, a gate script and a recorded decision id (§4.7).
