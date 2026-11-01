# factory: design

Status: v2, decided (v1: D-45 A, D-46 B, D-47 yes on 2026-11-01; v2: D-49, D-51 A, D-52, D-53 on 2026-11-02) · Author: factory-design · Date: 2026-11-02
Roadmap: `docs/roadmap-v2.md` (proposal). It replaces FAC-M2 to FAC-M7 of the v1 roadmap.

## Changes from v1

Dean gave the feedback F-1 to F-10 on v1, and accepted the proposals as a set (D-53). v2 makes these changes:
1. **Names from a real factory (F-1).** A lane is now a **cell**. A workflow pack is now a **recipe**. node, owner and project stay. New factory words where they are clearer: `factory inspect` (merge gate), `factory ship` (release check), **andon** (an item that waits on the owner), **work order** (a brief or a decision that goes down), **changeover** (a clear or compact between phases), **staging** (the merge order). See §4.1 and §7.
2. **The team's tracker holds the board (F-2).** factory gets one tracker connector: GitHub (the default), Jira or Linear. A `local` connector keeps the items in files, for a node with no network or no tracker account, and it is the test double of the connector. The artifact review desk is optional. A decision is a labelled tracker item, and a script reads the answer. The decision store is private by default. See §4.10.
3. **The coordinator runs in its own home folder (F-3).** The node home is next to the projects, never inside a repo and never above the checkouts. `factory up` starts the coordinator. See §4.3.
4. **Same mechanics, one role per layer (F-4).** Layers count from the bottom: cells are layer 0. factory sets the role of a node from its layer. All children of a node are on one layer. See §5.
5. **macOS and Linux only (F-5).** See §4.7.
6. **The merge rule is an owner choice (F-6).** This workspace uses D-52. Releases always wait for the owner's go. See §6.
7. **One command stops a cell (F-7).** A test of the ways to stop a session comes first. Then `factory cell stop` uses the safe way. See §4.11.
8. **Cells live on the bench window (F-8).** The view window has the coordinator and one slot. See §4.11.
9. **The heartbeat hook replaces every read under `~/.claude` (F-9).** The instruction to avoid those reads goes away. See §4.6.
10. **One general core; the recipe sets the kind of factory (F-10).** factory ships the `software` recipe first, in two variants: plain Claude Code (the default) and devflow. The config schema gets a `recipe` block. See §4.4 and §4.9.

Other changes: D-49 put the code in the private repo `dean0x/factory`. D-51 A: no second review of FAC-M1; the review of the v2 code covers the setup and upgrade code.

After v2, F-13 (2026-11-02): **one machine only for now.** The `ssh://` transport, the remote readiness check and the remote child are out. The transport interface stays, with `file://` only, and the config refuses any other address. A remote transport can come later with no redesign. See §5.3.

## Summary for Dean (one page)

**What factory is.** `factory` is a CLI. It creates and runs the orchestration setup of this workspace on any machine, for any person. `factory init` writes a node: the coordinator instructions, the role templates, the decision profile and the config. `factory up` starts the tmux layout and the coordinator session. Other commands do the multi-step jobs that the Orchestrator does by hand today. The CLI never contains a name, an account or a path. It reads them from the person who runs `init`.

**One core, many kinds of factory.** The core knows nodes, layers, roles, sessions, the inbox and reports, the owner's decisions, the tracker, capacity and the state store. A **recipe** gives the rest: the role template of each layer, the work cycle, the gate checks, the kind of output and the tracker mapping. The first recipe is `software`: projects are git repos, the output is a PR, and the gate is the merge gate. It has two variants: plain Claude Code (the default) and devflow. Other recipes, for example research or content, come later.

**Names from a real factory.** A worker session is a **cell**. A cell does all the steps (plan to release) for one track of one project, as a work cell does for one product family. Items that wait on the owner are **andon** items. Briefs are **work orders**. The merge order is **staging**.

**The team's tracker, not our own desk.** The board, the andon items and the decisions live in GitHub, Jira or Linear. The owner answers a decision with a comment such as `/choose B`. A script reads the answer, so the coordinator spends no tokens on it. The decision store is private by default.

**Where things run.** The coordinator runs in the node home, a folder of its own next to the project folders. Cells run in the project checkouts. So a cell never loads the coordinator instructions. One project or many: the layout is the same.

**Layers.** Every node has the same mechanics: the config, the report digest that goes up, the inbox that comes down, and the CLI. Each layer has its own role. Layer 0 is the cells (workers). Layer 1 is the coordinator. Layer 2 and up manage managers. A new top layer changes no node below it.

**Scripts save tokens.** The largest costs today are the merge gate (25–60k tokens each time), the status round (40–80k), a restart of all cells (60–100k) and cell creation (20–30k). Each becomes one command with a short verdict as output, about 1–4k tokens. A rough total: 50–70% less coordinator spend on routine work.

**Safety is in the code, not only in the text.** factory starts a session only in auto mode. It has no flag that skips permissions. A proxy is an explicit config option, checked before each launch. factory types owner-authority input only for a decision that the owner recorded. A decision answer counts only when it comes from the owner's tracker account. Releases always wait for the owner's go.

**Decided** (details in §9). v1: TypeScript on Node 22+; binary `factory`, npm package `@dean0x/factory`; MIT; state folder `.factory/` and config `factory.yaml`; the heartbeat hook. v2: the ten changes above.

---

## 1. Inventory of the current setup

This section describes the workspace setup as it is today. It uses the workspace words (lane, Orchestrator, On Dean), because those are the names in the files.

Paths are relative to `/Users/dean/Sandbox/.devflow/` unless they start with `/`.
Classes: **G** generic, **D** devflow-specific, **P** person-specific (names, accounts, paths), **M** machine-specific.

### 1.1 Parts

| Part | Job | Class | What ties it (file:line) |
|---|---|---|---|
| `/Users/dean/Sandbox/CLAUDE.md` | Orchestrator rules §1–§13 | G, D, P, M | "Dean", `dean0x` §13; founder prefix §12; `/Users/dean/Sandbox/.devflow` (`--add-dir`); session names `orchestrator:lanes`, `orchestrator:bench`; "10 CPUs, 64 GB", `lockf`, `pbcopy`, `sysctl`, `memory_pressure`; `/devflow:*` in §5 and §7 |
| `docs/orchestration/protocol.md` | Lane protocol: escalation, test lock, disk, context, PRs, style | G, D, P, M | `/Users/dean/Sandbox/.devflow/...` (L19–34); Node 24 and `/opt/homebrew/bin` (L34, devflow tests only); `vitest` (L25); devflow timeout rule (L54) |
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
| `scripts/tmux.conf` | Mouse, lane names on borders, resurrect, continuum | P, M | `/Users/dean/...` paths (L2, L3, L25, L26, L32) |
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
6. **The coordinator instructions reach every lane.** Claude Code loads every CLAUDE.md from the session folder up to the root. The Orchestrator instructions are in `/Users/dean/Sandbox/CLAUDE.md`, and every lane checkout is under `/Users/dean/Sandbox`. So each lane also loads them. factory puts the node home next to the checkouts, never above them (F-3, §4.3).

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
| State folder named `.devflow` | CLAUDE.md §11–§12; respawn-map | `.factory/`. Proof of the clash: devflow already wrote `/Users/dean/Sandbox/.devflow/.devflow/{curation,docs,features,memory}`. |
| `--add-dir /Users/dean/Sandbox/.devflow` | CLAUDE.md §12; restore L20 | `--add-dir <node home>/.factory`, from the config. |
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
  subswitch: { base_url: "http://127.0.0.1:<port>", health: "<path>" }
```

`factory recipe variant devflow --project P` checks `detect`, offers `install`, and writes the variant into the project entry in `factory.yaml`. The variant is per project, so one node can mix projects with and without devflow.

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

- **Node**: one session with a home folder, a layer and an owner. It has an optional parent and children. The coordinator is a node on layer 1.
- **Layer**: the level of a node, counted from the bottom. Layer 0 is the cells. The layer sets the role (§5).
- **Role**: the instructions, the commands and the reports of one layer. A role template from the recipe gives them.
- **Owner**: the person whose decisions the node carries. Each team member is the owner of their own nodes.
- **Cell**: a worker session (layer 0) in one checkout. It does all the stages of the work cycle for one track of one project.
- **Project**: a unit of work that the node manages. In the `software` recipe, a project is a git repo, with its own settings and variant.
- **Recipe**: the kind of factory: role templates, work cycle, gate checks, output kind and tracker mapping (§4.9).
- **Tracker**: the system that holds the board, the andon items and the decisions (§4.10).

Factory words, used where they are clearer than the generic word:
- **andon**: an item that waits on the owner (a decision or an action);
- **work order**: a brief or a decision record that goes down to a cell or a child node;
- **changeover**: a clear or compact of a session between phases;
- **staging**: the merge order;
- `inspect`: the merge gate check (quality inspection);
- `ship`: the release check and verify (shipping dock).

A single-project setup is a node with one project. A multi-project setup is a node with many. There is one code path for both.

### 4.2 Commands

```
factory init [--home DIR] [--name N] [--project PATH|URL]... [--recipe software] [--variant plain|devflow] [--layer N] [--yes]
factory up [--home DIR]                     # start or attach: tmux session, view and bench, coordinator (§4.11)
factory doctor [--fix]                      # tools, versions, platform, safety posture, hooks, tracker
factory upgrade [--dry-run]                 # migrate state and managed blocks (§4.5)
factory machine                             # CPU, memory, disk, load against the limits

factory project add|remove|list
factory recipe show
factory recipe variant <plain|devflow> [--project P]

factory cell new <name> --project P [--checkout PATH] [--order FILE]
factory cell list [--json]                  # the live cells table
factory cell send <cell> (--file F | --text T)   # inbox record plus a one-line doorbell
factory cell relay <cell> --decision D-n    # owner-authority input, from a recorded decision
factory cell changeover <cell> (--clear | --compact) [--order FILE]
factory cell stop|resume|restart <cell>|--all
factory cell summon <cell> [--for 15m]
factory cell watch | recover | adopt <name>
factory layout                              # build the view and bench windows again

factory item add|update|move|close|list|import ...   # tracker items: the board
factory andon add|list|close ...            # items that wait on the owner
factory decide ask <D-n> --options FILE     # a decision item in the decision store
factory decide read [<D-n>] [--principle ID]   # read answers by script; record them in the log and profile
factory decide <D-n> <option> [--note T]    # the owner answers in the CLI (the `local` tracker, §4.10)
factory staging set|show                    # the merge order
factory watch                               # bounded reads of new tracker comments; wakes the coordinator
factory desk render                         # optional artifact desk (§4.10)

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
```

The `software` recipe adds `inspect`, `pr`, `issues`, `ship` and `checkout`. Another recipe adds its own gate and output commands. The core commands are the same for every recipe.

Global flags: `--home PATH`, `--json`, `--quiet`, `--no-color`. A command finds the home in this order: `--home`; else `FACTORY_HOME`, which factory sets in every session that it starts; else a walk up from the current folder to `factory.yaml`.
Exit codes: `0` success, `1` failure, `2` usage error, `3` "not ready" (a gate verdict), `4` safety refusal. A gate verdict is not an error, so scripts can tell them apart.

### 4.3 Node home layout

The node home is a folder of its own, next to the project folders. It is never inside a git work tree, and it is never a parent of a project or a checkout. The coordinator session always runs in the home.

```
<workspace>/
  web/                          # project checkout (a git repo); a cell runs here
  web-search/                   # one more checkout of web, for a second cell
  api/                          # another project
  acme-factory/                 # the node home
    factory.yaml                # config, edited by people (YAML, comments allowed)
    CLAUDE.md                   # coordinator role template: managed blocks plus owner text
    .factory/                   # state; its own git repo with the delete-guard hook
      node.json                 # schema_version, created_with, block versions
      roles/worker.md           # the worker role template that every cell reads
      decision-log.json         # decisions read from the tracker, with the answer and its author
      staging.json              # the merge order
      board.json  waiting.json  # the items, only with the `local` tracker (§4.10)
      decision-profile/         # format, index, principles, decisions
      roadmaps/  orders/  resume/
      cells/<id>/inbox/         # work orders and records for each cell
      inbox/  outbox/           # messages from the parent, reports to the parent (§5)
      desk/                     # optional artifact desk (§4.10)
      state/  locks/            # gitignored: heartbeats, tracker cache, pane map, locks
```

Why this layout: Claude Code loads every CLAUDE.md from the session folder up to the root. A cell runs in a checkout, and the home is not above the checkout. So the cell loads the project instructions and the worker role, never the coordinator instructions. The coordinator reads the projects through `--add-dir`.

`factory init`:
- In a git work tree, with no `--home`: it proposes `../<repo>-factory` and adds that repo as the first project. It asks on a TTY. With `--yes` it uses the proposal. With no TTY and no `--yes`, it prints the proposal and exits 2.
- In an empty folder, or with `--home DIR`: that folder becomes the home.
- It refuses (exit 4) a home inside a git work tree, a home inside another node home, and a home that is a parent of one of its projects. A child node home sits next to its parent home, not inside it.
- `factory up` then starts the session. The user never has to know the folder.

The CLI code, templates, recipes and scripts live in the installed package, never in the node home. An upgrade of the package does not touch state (an idea from firstmate's code-root and home split).

### 4.4 Config: `factory.yaml`

Schema 2 splits the core keys from the recipe keys. The core parses everything except `recipe`. The recipe parses its own block with its own schema.

```yaml
schema: 2
node:
  id: acme                   # unique among siblings; also the tmux session name
  layer: 1                   # set by factory; the role comes from the layer (§5)
owner:
  display: "{{from git config user.name}}"   # written by init, never by the template
  github: "{{from gh api user}}"
  prefix: "[From {owner}, typed by {node} at the owner's explicit instruction, {date}]"
session:
  permission_mode: auto      # the only value accepted (§6)
  effort: high
  model: default
  proxy: none                # none, or the id of an entry in `proxies` (§4.6)
proxies:                     # optional; no keys or tokens here (§6)
  - id: local
    base_url: http://127.0.0.1:8787   # becomes ANTHROPIC_BASE_URL for the session
    health: /health                   # path that must answer before a launch
    on_fail: stop                     # stop (default) | direct
cells:                       # optional per-cell overrides
  web-search: { proxy: none }
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count
  context_prepare_pct: 30
  context_max_pct: 40
approval:
  land: each                 # each (every merge waits for the owner) | approved-work (§6)
tracker:
  kind: github               # github | jira | linear | local | desk
  items: acme/web            # where work items live (a repo, a project key, a team)
  decisions: acme/decisions  # the decision store; private by default (§4.10)
  watch_interval: 5m         # `factory watch` read interval
recipe:
  id: software
  variant: plain             # default variant for every project
  projects:
    - id: web
      repo: acme/web
      path: ../web           # relative to the node home
      default_branch: main
      merge_method: squash
      variant: devflow       # optional per-project override
      gate: { checks: [] }   # extra repo checks for `factory inspect`
      heavy_test: "npm test" # runs under `factory lock run`
parent: null                 # or { id, address }; the address is file:// only (§5.3)
children: []                 # nodes this node manages, each { id, address } (§5)
```

- `tracker.kind: local` takes no other tracker key: the items and the decisions stay in `.factory/` (§4.10). The schema refuses `items`, `decisions` or `watch_interval` with `local`. Every other kind needs `items` and `decisions`.
- `approval.land` names the step that makes a finished output final. In the `software` recipe, that step is the merge. Shipping (a release) always waits for the owner's go; no config value changes that.
- The config holds no secrets. `factory doctor` refuses a config with a value that looks like a token. The schema is checked at load with a fixed schema (Zod). An unknown key or a bad value stops the command and names the key. It never falls back to a looser default (from firstmate's fail-closed parse).

### 4.5 Upgrades without loss of state

- **State has a version.** `node.json` holds `schema_version`, and `factory.yaml` holds `schema`. Each migration is one pure function from version N to N+1, with a test.
- **The upgrade order:** a dry run that prints the plan; a backup to `.factory/backups/<ts>/`; the migrations; a check of every file against the new schema; one commit in the state repo. If one step fails, factory restores the backup and stops.
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
| `children[].address` (any text) | the same value, only when it is a valid `file://` address. Else the migration stops and names the child (F-13) |
| `.factory/protocol.md` (block `protocol`) | `.factory/roles/worker.md` (block `worker`) |
| `.factory/briefs/` | `.factory/orders/` |
| `.factory/board.json`, `waiting.json` | kept in place: they are the files of the `local` tracker |

### 4.6 Claude Code integration

- factory starts a cell with `env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<proxy base_url>] FACTORY_HOME=<home> FACTORY_SESSION=<id> claude --permission-mode auto --effort <e> --add-dir <home>/.factory`, in the cell's checkout. It starts the coordinator the same way in the home, with one `--add-dir` for each project path.
- **Proxy.** A session uses a proxy only when the config names one: the cell's override in `cells.<id>.proxy`, else `session.proxy` of the node. The launch always clears a stray `ANTHROPIC_BASE_URL` from the shell, then sets it only from the config. So a proxy is always a choice that the config shows, never an accident of the shell.
- **Proxy check.** Before each launch, factory sends one bounded request to the proxy's `health` path. If the proxy does not answer, `on_fail` decides:
  - `stop` (the default): factory does not start the session. It prints the proxy id, the failed check and the fix, for example "start the proxy, or set `proxy: none` for this cell".
  - `direct`: factory starts the session with no proxy and records this in the cell state, so the views show it.
  This rule comes from a workspace lesson of 2026-10-16: a dead local proxy stopped all lanes for hours. The check stops that failure before it starts.
- `factory doctor` and `factory status` run the same check for each configured proxy. `doctor` sends it only when the config comes from `--home` or from the current folder. For a config found in a parent folder, it sends no request and warns: "Run with --home DIR to check the proxy". `doctor` prints `Config: <path>` first, to show which config it uses. `factory cell list` and the cells view show a Proxy column for each cell: `direct`, the proxy id, or `<id> (down)`.
- **Restore and restart.** `cell resume`, `cell restart` and the tmux restore hook use the same launch code, so they apply the same proxy rules and the same check.
- **Heartbeat hook (decided, D-47).** `factory cell new` writes a hook into the checkout's `.claude/settings.local.json`. `factory up` writes the same hook for the coordinator in the home. Claude Code calls the hook on SessionStart, Stop (the end of each turn) and PreCompact, and the status line command calls it too. The hook writes one line to `<home>/.factory/state/heartbeat/<session>`: the session id, the event, the time and the context percent. The context percent comes from the status line JSON that Claude Code passes, not from the screen text.
- **No reads under `~/.claude`.** The heartbeat file gives every fact that the scripts read under `~/.claude` today: the last activity (working, idle, stopped), the session id (to resume a cell after a restart) and the context percent. So no factory code and no role template reads or copies a file under `~/.claude`. The instruction "avoid reads under ~/.claude" is not necessary, and the templates do not contain it. A static test fails on any code path that opens a file there.

### 4.7 Language, platforms, install and distribution

- **TypeScript on Node 22+**, built to one bundled file (from mars: dev mode from source, one bundled file for a release). Zod for config and state schemas, Result types and no throws in the logic (Dean's engineering rules). Commands come from one command table, not from three hand lists (a mars gap).
- **Platforms: macOS and Linux only (F-5).** factory needs tmux, git and a POSIX shell. On native Windows, `factory doctor` refuses with a hint: "Use WSL; factory runs there as on Linux". Every other command refuses with the same hint.
- **External tools:** `tmux`, `git`, `claude`, and the tracker CLI (`gh` for GitHub). factory replaces `jq`, `python3` and `glow` with its own code, so a new machine needs fewer tools. `doctor` checks the versions.
- **Portable parts:** the heavy-test lock uses `lockf` on macOS and `flock` on Linux. `factory machine` reads memory and load on both systems. The owner's clipboard command is a config value with a platform default.
- **Install:** `npm i -g @dean0x/factory`, or `npx @dean0x/factory init`, plus a Homebrew formula in `dean0x/homebrew-tap`. An `install.sh` for curl, with a SHA256 check (mars has none). The repo is private now (D-49), so none of these is public yet.
- **Release:** one `v*` tag runs the tests, checks that the version is the same in every place, makes the GitHub Release, publishes to npm and updates the tap (from mars `release.yml`). The version lives in one file only.

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

factory avoids these firstmate choices:
- Its workers skip permissions by default when no config file exists (`docs/configuration.md` L1370).
- Its config is scattered over many one-token files.
- It installs by `git clone`, with no versioned release and no migrations.
- It supports one person only, and it caps the hierarchy at two levels (`VISION.md` L7, L38).
- It supports many backends, and each one adds test and maintenance work.

### 4.9 Recipes: one core, the kind of factory comes from the recipe

The core is general. It knows nodes, layers and roles, sessions, the inbox and reports, the owner's decisions, the tracker, capacity and the state store. It knows nothing of git, PRs or CI.

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
roles:                       # role template per layer, counted from the bottom
  0: roles/worker.md
  1: roles/coordinator.md
  2: roles/manager.md        # also used for every layer above 2
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

**One adapter contract.** Every adapter gives the same small set of operations:
- item: add, update, move (change the state), close;
- decision: ask (an item with the options), read the answer;
- doc: attach a file or link a repo file;
- comments: read the new comments since a cursor.

**Adapters.**
- `github` (the default): issues plus a Projects board, through `gh`. factory already needs `gh` for the `software` recipe.
- `jira` and `linear`: the same contract, through their CLI or API.
- `local`: files in `.factory/` (`board.json` and `waiting.json`, as in the setup of today), for a node with no network or no tracker account. It has no comments and no watch: `comments read` returns nothing, and `factory watch` exits at once with a note. `factory item list` and `factory andon list` show the items; there is no other UI. The owner answers a decision in the CLI with `factory decide <D-n> <option>`. `local` is also the test double of the connector: the contract tests run against `local` and against each real adapter.
- `desk` (optional): the artifact review page of today, for an owner who wants it. It renders with `factory desk render`. The coordinator session publishes it and reads the answers, because the CLI has no Artifact tool.

**Decisions.**
- A decision is an item with the `decision` label. Its body has the question, the options and a recommendation.
- The owner answers with a comment `/choose <option>`, or with a label `choose:<option>`.
- `factory decide read` reads the answer with a script, not with model tokens. An answer counts only when its author is the owner's tracker account (`owner.github` for GitHub). The script records the decision in `decision-log.json`, with the comment link and the author.
- With `local`, `factory decide <D-n> <option>` records the answer with `by: owner`. It needs a TTY, and it refuses (exit 4) inside a session that factory started (factory sets `FACTORY_SESSION` at each launch). This guard stops a session from answering by accident. The owner's permission settings are the second guard.
- Designs and plans: the item links the repo file (GitHub shows Markdown), or the adapter attaches it.

**Comments and wake-up.** There is no live push to a local session without a webhook server. So `factory watch` reads new comments with the tracker CLI at a fixed interval (`tracker.watch_interval`), with a bound on the number of reads per run. It wakes the coordinator only when a new answer or a mention arrives.

**Privacy.** An issue in a public repo is public. Decision items can hold private facts. So the default decision store is a private repo, or private draft items in a private Project. `factory doctor` fails when the decision store is public, and warns when it is not set. The `local` store is private: it is the node's own state repo, with no remote.

### 4.11 Sessions in tmux: bench, view and stop

**Layout (F-8).** `factory up` makes one tmux session per node, named with the node id. It has two windows:
- **bench**: one pane for each cell. The cells keep running there.
- **view**: the coordinator, plus one slot. The slot shows the board, or a cell on request (`factory cell summon <cell> [--for 15m]`). When the time ends, the slot shows the board again.

`factory up` attaches when the session runs already. It never starts a second coordinator for the same home.

**Stop (F-7).** The safe way to stop a session is not known yet. So a test comes first, in a throw-away session. It tries each way: `/exit`, `/quit` (if it exists), `/restart`, `kill -TERM`, `kill -INT`, and the delete in the agent view. For each way, it records five facts:
1. Does the process end?
2. Does the background daemon keep the session?
3. Does `--resume` work after it?
4. Is the transcript complete?
5. Do crons and background agents survive?

Then `factory cell stop` uses the safe way that the test finds. Until the test: stop only an idle session (no tool, no agent and no prompt in flight), then send `kill -TERM`. The test is a task of the cell-control milestone (roadmap-v2).

## 5. Layers: same mechanics, one role per layer

### 5.1 The node

Every node has the same mechanics: `factory.yaml` and `node.json`, the report digest that goes up, the inbox that comes down, and the CLI. A node has an `id`, a `layer`, an `owner`, a `parent` (or null) and `children`. This is the node as `factory report --json` shows it; the files keep each fact once (`factory.yaml` holds identity, owner, layer, parent and children).

```json
{ "id": "acme-web", "layer": 1,
  "owner": { "display": "Ana", "github": "ana-x" },
  "parent": { "address": "file:///home/ana/work/acme-factory", "id": "acme" },
  "children": [
    { "kind": "cell", "id": "web-checkout", "pane": "@lane=web-checkout" },
    { "kind": "cell", "id": "web-search", "pane": "@lane=web-search" }
  ] }
```

(The pane option keeps the name `@lane` until the tmux scripts move into factory.)

### 5.2 Layers and roles (F-4)

- **Layers count from the bottom.** Cells are layer 0. Their managers are layer 1. The managers of layer-1 nodes are layer 2, and so on. A new top layer changes no node below it.
- **The role comes from the layer.** A node does not choose its role. factory sets it from `node.layer` and the recipe's role template for that layer.
- **One role template per layer.** Every node on one layer uses the same template. The `software` recipe ships three:
  - layer 0, **worker**: runs the work cycle (plain or devflow) on one track of one project. Text: `roles/worker.md`, which every cell reads.
  - layer 1, **coordinator**: manages cells across one or many projects (the Orchestrator today). Text: the managed blocks of the home's `CLAUDE.md`.
  - layer 2 and up, **manager**: a starting template for a manager of managers. It handles priorities, capacity and owner items across its children, and does no PR-level work. The owner edits it when that layer becomes real.
- **All children of a node are on one layer**, the layer just below it. `factory node add-child` refuses a child from another layer. `factory cell new` refuses on a node that is not on layer 1.
- A cell is a layer-0 node with no home of its own. Its inbox and heartbeat live in its parent's home (`.factory/cells/<id>/`, `.factory/state/heartbeat/`).

### 5.3 Addresses

- A child is named by a relative path from its parent: `acme/acme-web/web-checkout`. A path is unique because each id is unique among its siblings.
- A transport says how to reach a node. factory has one transport: `file://<absolute home path>`, on the same machine (F-13). It has three calls: `report`, `deliver` and `ping`. The config refuses any other address, for example `ssh://` or `https://`. A remote transport can come later behind the same three calls, with no redesign.
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
- **Inherited config:** the parent passes only items on an explicit list (limits, the writing style, the safety rules). Owner identity, accounts and session settings are never passed.
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
| A proxy only by explicit config, and only when it answers | yes | Every launch clears `ANTHROPIC_BASE_URL`, then sets it only from `proxies` in the config (§4.6). A health check runs before each launch and in `doctor` and `status`. On failure the default is `stop` with the fix in the message; `direct` is an explicit choice. `doctor` sends the check only when the config comes from `--home` or from the current folder. For a config in a parent folder, `doctor` sends no request and warns to run with `--home DIR`. `doctor` warns when the variable is set in the shell. |
| No proxy keys or tokens in output | yes | `proxies` holds no keys; `doctor` refuses token-like values there. Output shows only the proxy id and its host and port, never user info, query strings or headers of the base URL. |
| A denial is final; no laundering through another session | yes | `cell send` and `cell relay` refuse a text that asks a cell to run a command that the node recorded as denied (a `denied` list in state). |
| Never invent the owner's consent | yes | `cell relay` types the owner prefix only for a decision record in `decision-log.json` with `by: owner`. `decide read` records `by: owner` only for an answer from the owner's tracker account. With `local`, `factory decide` needs a TTY and refuses inside a session that factory started. |
| Decisions stay private | yes | `doctor` fails when the decision store is public, and warns when it is not set (§4.10). |
| No secrets in output | yes | No command prints env values. `doctor` refuses token-like values in `factory.yaml`. Process lists show only pid, elapsed time and command name. |
| Peers never ask the owner directly | yes (role templates) | none (model behavior) |
| One session per checkout | yes | `cell new` refuses a checkout that another cell uses. |
| The coordinator instructions never reach a cell | yes | `init` refuses a home inside a git work tree, inside another home, or above a project (§4.3). |
| Merges follow the owner's merge rule (F-6) | yes | `approval.land: each`: `pr merge` needs a recorded owner decision for that PR and head SHA. `approval.land: approved-work`: `pr merge` needs a recorded owner decision that approved the work and assigned it to a cell or track. In both cases it passes `--match-head-commit <full SHA>` only after `inspect` passed at that SHA, and refuses when the head changed. `--admin` only by the node, at the pinned head. |
| Releases need the owner's go | yes | `ship` commands only check; they do not publish. No config value changes this. |
| Never bypass the state hook | yes | `init` sets `core.hooksPath`; every state write commits through the helper, which refuses when the hook is off. |
| Never delete another cell's files; look before removing | yes | `checkout clean` is a dry run by default and refuses a worktree with unpushed work or a path that a cell or resume file names. |
| Resource limits; one heavy suite at a time | yes | `cell new` checks the limits; `lock run` takes the machine lock. |
| Look before typing; target by pane id | yes | Every typed input captures the pane first, refuses an open dialog, clears the input, and checks that the text arrived. |
| Supported platforms only | no | Every command refuses on native Windows, with the WSL hint (§4.7). |

The default for a new node is `approval.land: each`: every merge waits for the owner. The owner can choose `approved-work`. This workspace uses `approved-work` (D-52).

factory never reads or writes under `~/.claude/` (settings, rules, skills, transcripts or session files). It writes only to the node home and to each checkout's `.claude/settings.local.json` (the heartbeat hook, D-47).

## 7. Generic names

The setup uses Dean's name and devflow's words in many places. factory uses these names; a node shows the owner's display name in the views.

| Today | In factory |
|---|---|
| founder, Dean | owner (the display name from `factory.yaml`) |
| lane | cell |
| workflow pack | recipe (and its variant) |
| On Dean, `on-dean.json`, `dean-review.html` | andon items in the tracker; the optional desk |
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

Every user-visible name sits in `src/names.ts`, and a test fails on a stray literal. So a rename changes one file plus the tests.

## 8. Migration of this workspace

`factory adopt /Users/dean/Sandbox` imports the current setup into a node. A dry run comes first. The adopt runs only when all lanes are idle and pushed. It does these steps:
1. It makes a node home next to the projects, for example `/Users/dean/Sandbox/sandbox-factory`. The Orchestrator moves there from the workspace root. Then the lanes stop loading the Orchestrator instructions (F-3).
2. It moves `decision-profile/` and the roadmaps to `.factory/`, keeps the git history (a `git mv` in the state repo), and writes `factory.yaml` from the facts in CLAUDE.md §13.
3. It imports the board and the On Dean items into the tracker: GitHub issues plus a Projects board, with a private repo as the decision store (F-2). The review page becomes the optional desk, or goes away.
4. It sets `approval.land: approved-work` (D-52).
5. It adds the devflow variant to the devflow projects.
6. The lanes become cells on the bench window (F-8).
7. It keeps the old CLAUDE.md text outside the managed blocks, so Dean can delete the duplicate lines in one review.

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
| D-51 A | No second review of FAC-M1 now. The review of the v2 code covers the setup and upgrade code. |
| D-52 | This workspace: approved and assigned work merges when the gates pass. Releases still wait for the owner's go. factory offers the rule as an owner choice. |
| D-53 | Dean accepted the proposals F-1 to F-10 as a set ("Changes from v1" above). |
| F-13 | One machine only for now. No `ssh://` transport, no remote readiness check and no remote child. The config refuses any address but `file://`. |

Open point, not decided: F-6 asked whether "a-z" includes releases. D-52 says no. factory keeps releases behind the owner's go, with no config value to change it.

## 10. Risks

- **Claude Code changes its hook events, status line JSON or CLI flags.** All Claude Code calls sit in one adapter, with a test that `doctor` runs against the installed version. The heartbeat hook uses only documented hook events.
- **A dead proxy stops every cell that uses it.** The health check runs before each launch, the default is `stop` with a clear fix, and the views show which cells use a proxy (§4.6).
- **tmux typing is fragile.** factory types only one short line per message and keeps the text in the inbox. Each typed input is checked by a capture.
- **Tracker limits and cost.** The tracker APIs have rate limits, and reads cost time. `factory watch` reads at a fixed interval with a bound per run, and caches in `.factory/state/`. A tracker that does not answer is "unknown", never "no answer".
- **A false decision answer.** Anyone with access can comment on a decision item. `decide read` accepts only the owner's account, and records the author and the link.
- **A public decision store.** `doctor` fails on it (§4.10).
- **The renames and the schema 2 migration touch every part.** They come first in the roadmap, before more code uses the old names. The schema 1 → 2 migration has a test, and every name sits in `src/names.ts`.
- **Scope grows.** The roadmap ships the CLI in stages. Each stage is useful for this workspace before the next one starts. Other recipes and other trackers wait until the `software` recipe on GitHub works.
- **Two copies of the setup during the move.** The adopt is one step with a dry run, and the old scripts stop when the adopt is done.
