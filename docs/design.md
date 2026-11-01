# factory: design

Status: decided (D-45 A, D-46 B, D-47 yes; 2026-11-01) · Lane: factory-design · Date: 2026-11-01
Roadmap: `/Users/dean/Sandbox/.devflow/docs/orchestration/roadmaps/factory.md`

## Summary for Dean (one page)

**What factory is.** `factory` is a CLI. It creates and runs the orchestration setup of this workspace on any machine, for any person. One command (`factory init`) writes a node: the coordinator instructions, the lane protocol, the state files (board, items that wait on the owner, decision profile) and the tmux layout. Other commands do the multi-step jobs that the Orchestrator does by hand today. The CLI never contains a name, an account or a path. It reads them from the person who runs `init`.

**What is generic today, and what is not.** About 80% of the setup is generic: the protocol, the board and its checks, the pre-commit delete guard, the tmux layout, the restore hooks and the review page. The rest is tied to one person, one machine or one tool:
- Dean's name in titles and file names ("On Dean", `dean-review.html`, the founder prefix).
- The `dean0x/devflow` repo hardcoded in 3 scripts.
- `/Users/dean/...` paths in `tmux.conf`, the protocol and the respawn map.
- macOS tools (`lockf`, `memory_pressure`, `pmset`, `pbcopy`).
- devflow commands in the work cycle.
- Two reads of Claude Code's private files under `~/.claude`.

**devflow becomes optional.** The default setup uses a plain cycle (plan, build, review, fix, release) that plain Claude Code can do. devflow comes back as a "workflow pack": a small data file that maps each stage to a devflow command, and the evidence markers to devflow's PR comment markers. devflow itself does not change. The state folder moves from `.devflow/` to `.factory/`, because today devflow already writes its own `.devflow/` folder inside ours.

**Scripts save tokens.** The largest costs today are the merge gate (25–60k tokens each time), the status round (40–80k), a restart of all lanes (60–100k) and lane creation (20–30k). Each becomes one command with a short verdict as output, about 1–4k tokens. A rough total: 50–70% less Orchestrator spend on routine work.

**Layers.** Every level is the same kind of node: a session with an owner, a role, one parent (or none) and children. Reports and the items that wait on the owner go up as one versioned JSON digest. Decisions, priorities and owner authority go down as records in the child's inbox. A parent reads a child only through `factory report --json`, locally or over SSH. So a new layer later needs no redesign, and no level is "the top" by design.

**Safety is in the code, not only in the text.** factory can start a session only in auto mode. It has no flag that skips permissions. A proxy (for example Subswitch) is an explicit config option per node and per lane. A launch never takes a stray proxy variable from the shell, and it checks that the configured proxy answers before it starts the session. It types founder-authority input only for a decision that is recorded in the decision log. `factory doctor` checks the safety posture of each node.

**Decided** (details in §9). On 2026-11-01 Dean accepted every recommendation below (D-45 A, D-47 yes):
1. Language: TypeScript on Node 22+.
2. Name: binary `factory`, npm package `@dean0x/factory`. Note that a company named Factory sells an AI coding agent, so the name can confuse people.
3. License MIT. The repo stays private until the first team member installs it, then it goes public.
4. State folder `.factory/`, config file `factory.yaml`.
5. A small heartbeat hook replaces the reads under `~/.claude`.
6. Fix 5 conflicts in the current setup first (§1.3).

---

## 1. Inventory of the current setup

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
| `decision-profile/` | Founder decision wiki: index, format, log, 79 principles, 69 records | G (format), P (content) | "Dean" throughout; 11 principles scoped `devflow` |
| `state/`, `locks/` | Locks, caches, logs (names only read) | M, gitignored | none |
| Global rules in `~/.claude/rules/devflow/` | Engineering, quality, STE writing style | D | installed by devflow, not by the setup |

### 1.2 Dependencies on tools

Required: `tmux` (with TPM, resurrect, continuum), `git`, `gh`, `jq`, `python3` (stdlib only), Bash 3.2+, `glow`, Claude Code.
macOS only: `/usr/bin/lockf`, `memory_pressure`, `pmset`, `pbcopy`, `sysctl`.
Private Claude Code layout: `~/.claude/projects/<cwd>/*.jsonl` (lane activity), `~/.claude/sessions/<pid>.json` (session ids), and the text of Dean's status line (context percent).

### 1.3 Conflicts to fix before packaging

I checked each of these on the file.
1. **Merge authority (resolved).** `decision-profile/index.md:17` said "Merges, releases and priorities always wait for Dean", while CLAUDE.md §5 step 4 delegated merges to the Orchestrator. D-46 B (2026-11-01) ended the delegation: every merge waits for the owner's go.
2. **How to stop a session.** `respawn-map.md:7` says "press Ctrl+C twice". CLAUDE.md §12 says that Ctrl+C quits only the client, and uses `kill -TERM`.
3. **Where lanes live.** `respawn-map.md:3` puts lanes in `orchestrator:lanes`. CLAUDE.md §12 puts them on the bench.
4. **Context budget.** `protocol.md:46` uses 250k/350k tokens. CLAUDE.md §12 uses 30–35% and 40% of the window.
5. **Reads under `~/.claude`.** CLAUDE.md §1 tells lanes to avoid them. `lanes-table.py`, `tmux-save-map.sh`, `respawn-map.md:16` and CLAUDE.md §12 ("Moving a session") read there.

factory takes one answer for each. The answers: (1) every merge waits for the owner's go, and factory copies that default (D-46 B); (2) `kill -TERM`; (3) the bench; (4) the percent rule, because it works for every window size; (5) the heartbeat hook of §4.6.

## 2. The devflow connection

### 2.1 Ties

devflow (npm `devflow-kit`, MIT) installs commands, agents, skills, hooks and rules into `~/.claude`, and uses `.devflow/` in each project and `~/.devflow/` in HOME.

| Tie | Where | Default in factory |
|---|---|---|
| Cycle plan → implement → code-review → resolve | CLAUDE.md §5.2; protocol L47 | Stage ids `plan`, `build`, `review`, `fix`. The default pack uses plain Claude Code: plan mode, edits, a review subagent, fixes. |
| "code-review is for software; else a multi-lens audit" | CLAUDE.md §5.2 | Keep the rule. Each stage declares `applies_to: code | prose | any`. |
| Review and resolution summaries posted on the PR | CLAUDE.md §5.3, §5.4 | An evidence contract: one PR comment per stage, found by a marker. Default markers are `<!-- factory:review -->` and `<!-- factory:fix -->`. |
| One evidence comment per head | CLAUDE.md §5.2 | Optional. The default needs CI plus the review comment. |
| `/devflow:release` | CLAUDE.md §7 | A `release` stage. The default is the repo's own release script, named in `factory.yaml`. |
| Triage words (FIX_NOW, ESCALATED, CHANGES REQUESTED) | board-detail.md | Neutral words `blocker`, `fix`, `defer`, `ask`, `ready`. A pack maps its words to them. |
| Agent types Code, Validate, Test | protocol L32 | Role names: implementer, verifier, tester, reviewer. A pack maps them to its agent types. |
| State folder named `.devflow` | CLAUDE.md §11–§12; respawn-map | `.factory/`. Proof of the clash: devflow already wrote `/Users/dean/Sandbox/.devflow/.devflow/{curation,docs,features,memory}`. |
| `--add-dir /Users/dean/Sandbox/.devflow` | CLAUDE.md §12; restore L20 | `--add-dir <node home>/.factory`, from the config. |
| Lane name examples `devflow-*` | CLAUDE.md §4 | Keep the `<repo>-<track>` form; use neutral examples. |
| Default repo `dean0x/devflow` | board-set L91; boardlib L13, L240; render-dean L69 | `projects[].repo` in `factory.yaml`. A bare issue number is refused when the node has more than one project. |
| Rules in `~/.claude/rules/devflow/` (STE, read economy, quality) | HOME CLAUDE.md | factory writes its own short rules into the node CLAUDE.md and protocol. It never writes to `~/.claude/rules/`. |
| Profile seeded from devflow `preference-profile.md` | decision-profile/README-format.md:64 | factory ships an empty profile with its format. A pack may give a seed command. |
| devflow memory and curation hooks | protocol L19 | Resume files plus Claude Code auto-memory. No ledger by default. |
| devflow-repo rules inside the generic protocol | protocol L34 (Node 24), L54 (timeouts), L62 (standalone) | Move them to the devflow pack addendum or the devflow repo's CLAUDE.md. |
| Repo checks in the gate routine (Independent audit, ceiling diff) | orchestrator-resume.md:14 | A per-project `gate.checks` list in `factory.yaml`. |

The gate-level words `full`, `standard` and `lean` are not in the setup itself. They appear only in devflow product work, so there is no tie to replace.

### 2.2 Workflow packs

A pack is data plus prompt text. It has no code that factory runs, except its `install` and `detect` commands, and the user must confirm those. factory ships two packs: `plain` (the default) and `devflow`.

```yaml
# packs/devflow/pack.yaml
id: devflow
version: 1
install: npx devflow-kit init --recommended   # shown to the user; runs only after a yes
detect: devflow --version
stages:
  plan:    { run: /devflow:plan,        applies_to: any }
  build:   { run: /devflow:implement,   applies_to: any }
  review:  { run: /devflow:code-review, applies_to: code }
  fix:     { run: /devflow:resolve,     applies_to: code }
  release: { run: /devflow:release }
evidence:                 # how `factory pr gate` finds proof of each stage
  review:  "<!-- devflow:review-summary"
  fix:     "<!-- devflow:resolution-summary"
  release: "<!-- devflow:shipped"
verdicts: { FIX_NOW: fix, ESCALATED: ask, "CHANGES REQUESTED": blocker, READY: ready }
roles: { implementer: Code, verifier: Validate, tester: Test, reviewer: Review }
state_dirs: [".devflow/", "~/.devflow/"]   # factory refuses to use these and never deletes them
protocol_addendum: addendum.md             # extra lane rules for repos that use devflow
profile_seed: /devflow:dynamic-profile
proxy_presets:                             # optional; copied into `proxies` on request (§4.6)
  subswitch: { base_url: "http://127.0.0.1:<port>", health: "<path>" }
```

`factory pack add devflow` checks `detect`, offers `install`, and writes the pack id into the project entry in `factory.yaml`. A pack is per project, so one node can mix projects with and without devflow.

The dependency goes one way: factory knows devflow's public surface (commands, markers, paths). devflow never knows factory. This keeps the founder rule "devflow stays standalone" (CLAUDE.md §8; `decision-profile/principles/devflow-standalone.md`).

## 3. Scripts that save tokens

Costs are rough, per use, for the new tokens that enter the Orchestrator context. They come from the step counts in CLAUDE.md and the inventory. "After" assumes one call with a short verdict as output.

| Job today | Steps today | Today | Command | After |
|---|---|---|---|---|
| Merge gate and merge (§5) | CI on the head SHA, behind-by, open threads (GraphQL), review and fix evidence, impact inventory over the diff, public-text check, pinned merge, board, commit, close issue | 12–18 calls, 25–60k | `factory pr gate <pr>` then `factory pr merge <pr>` | 2 calls, 3–6k (the impact inventory stays a judgment; the gate prints the diff stat and the touched surfaces only) |
| Status round (§2, §3) | ListAgents, panes, worktrees, PRs and milestones per repo, board, roadmaps, message each lane, capture idle panes | 20–30 calls, 40–80k | `factory status` | 1–2 calls, 3–5k (lane replies still cost their own tokens) |
| Restart of all lanes (§12) | Per lane: capture, push check, CronList, stop, respawn, rename, re-brief | ~50 calls, 60–100k | `factory lane restart --all` | 2 calls, 3–5k |
| Lane creation (§12) | Resource check, worktree, pane, launch, wait, rename, protocol line, brief, board, lanes, respawn map, commit | 15–20 calls, 20–30k | `factory lane new <name> --project <p> --brief <file>` | 1 call, 1–2k |
| Board and owner-item updates (§11) | Edit JSON, render, commit, republish, label sync | 5–8 calls, 8–15k | `factory board …`, `factory wait …`, `factory decide …` (render, commit and label sync built in) | 1–2 calls, 1–3k |
| Lane clear or compact, then re-brief (§12) | Capture, idle and pushed checks, resume file check, C-u, type, verify, protocol line, re-brief | 8–10 calls, 10–15k | `factory lane clear <lane>` / `factory lane compact <lane>` | 1 call, 1k |
| Release pre-check and post-check (§7) | Version, changelog, package contents, registry; after: registry, clean install, smoke | 6–10 calls, 10–20k | `factory release check <project>` / `factory release verify <project> <version>` | 1 call each, 2–3k |
| Issue audit and labels (§8) | List issues, classify, apply labels | 5–10 calls, 30–100k | `factory issues audit` (finds unlabeled or conflicting issues; the model classifies only those) | 1 call plus the classification of new issues only |
| Decision record and profile update (§1) | Record file, log line, principle, decision-log row, commit | 4–6 calls, 8–15k | `factory decide <D-n> <option> [--principle <id>]` | 1 call, 1–2k (the principle wording stays a model job) |
| Worktree cleanup (§4) | List, check tip on remote, search board and resume files, remove | 5–8 calls, 5–10k | `factory clean` (dry run by default) | 1 call, 1k |
| Typed founder-authority input (§12) | Map, capture, Escape/C-u, type, Enter, verify | 4–6 calls, 4–6k | `factory lane relay <lane> --decision <D-n>` | 1 call, <1k |
| CI watch (§10) | Monitor or loop on `gh pr checks`, then read | 2–4 calls, 3–8k | `factory pr watch <pr>` (exits when CI ends; for a background task) | 1 call, <1k |
| Stopped-lane watch and limit recovery (§11, §12) | Loop on `lanes-stopped.txt`; capture each lane; answer the dialog; nudge | 5–15k | `factory lane watch` (exits on a change); `factory lane recover` | <1k plus |
| Moving an outside session into tmux (§12) | ListAgents, session file, stop, resume, rename, protocol line | ~6 calls, ~6k | `factory lane adopt <name>` | 1 call, <1k |
| Resource check (§8) | 4 commands | 1–4 calls, 1–2k | built into `lane new`; `factory machine` | 0–1 call |
| Orchestrator self-compact (§12) | Resume file, C-u, queue `/compact` | ~3 calls, 3–5k | `factory self compact` (checks the resume file, then queues) | 1 call |

Rule for every command: the output is a short verdict for the model (`READY`, or `NOT READY: 2 open threads, CI pending`). `--json` gives the full facts. The default output never prints a diff, a log or a transcript.

## 4. CLI shape

### 4.1 Concepts

- **Node**: one coordinator session and its home folder. A node has an owner, a role, an optional parent and children.
- **Owner**: the person whose decisions the node carries. Each team member is the owner of their own nodes.
- **Lane**: a worker session in one checkout. It is a leaf child of a node.
- **Project**: a repo that the node manages, with its own settings and pack.
- **Pack**: a workflow pack (§2.2).

A single-project setup is a node with one project. A multi-project setup is a node with many. There is one code path for both.

### 4.2 Commands

```
factory init [--name N] [--project PATH|URL]... [--pack plain|devflow] [--yes]
factory doctor [--fix]                      # tools, versions, safety posture, hooks
factory upgrade [--dry-run]                 # migrate state and managed blocks (§4.5)
factory machine                             # CPU, memory, disk, load against the limits

factory project add|remove|list
factory pack add|remove|list

factory lane new <name> --project P [--checkout PATH] [--brief FILE]
factory lane list [--json]                  # the live lanes table
factory lane send <lane> (--file F | --text T)   # inbox record plus a one-line doorbell
factory lane relay <lane> --decision D-n    # owner-authority input, from a recorded decision
factory lane clear|compact <lane> [--rebrief FILE]
factory lane stop|resume|restart <lane>|--all
factory lane summon <lane> [--for 15m]
factory lane watch | recover | adopt <name>
factory layout                              # build the tmux view and bench

factory board set|new|done|remove|merge ... # the port of board-set.sh
factory wait add|list|close ...             # items that wait on the owner (today: On Dean)
factory decide <D-n> <option> [--note T]    # record a decision, update the log and profile
factory page render                         # write the review page and its data block

factory pr gate <pr> [--project P]          # merge-ready verdict at the current head
factory pr merge <pr>                       # pinned merge, then the bookkeeping
factory pr watch <pr>
factory issues audit [--project P]
factory release check|verify <project> [<version>]
factory clean [--apply]
factory lock run -- <command>               # the shared heavy-test lock

factory status [--json]                     # digest for the owner
factory report [--json] [--since CURSOR]    # digest for the parent (§5)
factory node tree | children | add-child | remove-child
factory self compact
```

Global flags: `--home PATH` (else walk up from the current folder to find `factory.yaml`), `--json`, `--quiet`, `--no-color`.
Exit codes: `0` success, `1` failure, `2` usage error, `3` "not ready" (a gate verdict), `4` safety refusal. A gate verdict is not an error, so scripts can tell them apart.

The review page needs the Artifact tool, so the CLI only renders it. The coordinator session publishes it and reads the answers.

### 4.3 Node home layout

```
<node home>/
  factory.yaml                # config, edited by people (YAML, comments allowed)
  CLAUDE.md                   # coordinator instructions: managed blocks plus owner text
  .factory/                   # state; its own git repo with the delete-guard hook
    node.json                 # id, role, owner, parent, children, schema_version
    protocol.md               # lane protocol: managed blocks plus addenda
    board.json  board.md  board-detail.md  board-log-<yyyy-mm>.md  done.md
    waiting.json  decision-log.json  waiting.md
    decision-profile/         # format, index, principles, decisions
    roadmaps/  briefs/  resume/
    review/page.html  review/files.json
    inbox/  outbox/           # messages from the parent, reports to the parent (§5)
    state/  locks/            # gitignored: caches, heartbeats, pane map, locks
```

The CLI code, templates and scripts live in the installed package, never in the node home. An upgrade of the package does not touch state (an idea from firstmate's code-root and home split).

### 4.4 Config: `factory.yaml`

```yaml
schema: 1
node:
  id: acme-web               # unique among siblings; also the tmux session name
  role: coordinator
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
  - id: subswitch
    base_url: http://127.0.0.1:8787   # becomes ANTHROPIC_BASE_URL for the session
    health: /health                   # path that must answer before a launch
    on_fail: stop                     # stop (default) | direct
lanes:                       # optional per-lane overrides
  web-checkout: { proxy: none }
limits:
  memory_free_min_pct: 20
  disk_free_min_gb: 20
  load_max: cpu_count
  context_prepare_pct: 30
  context_max_pct: 40
projects:
  - id: web
    repo: acme/web
    path: ../web             # relative to the node home
    default_branch: main
    merge_method: squash
    pack: plain
    gate: { checks: [] }     # extra repo checks for `factory pr gate`
    heavy_test: "npm test"   # runs under `factory lock run`
children: []                 # nodes this node manages (§5)
```

The config holds no secrets. `factory doctor` refuses a config with a value that looks like a token. The schema is checked at load with a fixed schema (Zod). An unknown key or a bad value stops the command and names the key. It never falls back to a looser default (from firstmate's fail-closed parse).

### 4.5 Upgrades without loss of state

- **State has a version.** `node.json` holds `schema_version`. Each migration is one pure function from version N to N+1, with a test.
- **The upgrade order:** a dry run that prints the plan; a backup to `.factory/backups/<ts>/`; the migrations; a check of every file against the new schema; one commit in the state repo. If one step fails, factory restores the backup and stops.
- **Managed blocks.** `CLAUDE.md` and `protocol.md` contain blocks between `<!-- factory:begin <name> v<n> sha=<hash> -->` and `<!-- factory:end <name> -->`. An upgrade rewrites only these blocks. The owner's text outside them stays. If the hash shows a hand edit inside a block, factory stops and shows the diff. The owner then moves the edit out of the block or accepts the loss with `--overwrite <name>`.
- **No downgrade of state.** An older CLI refuses a newer `schema_version`, with a message.
- **Parents and children can run different versions.** The report schema has its own version, and a parent reads every report version back to the oldest supported one.

### 4.6 Claude Code integration

- factory starts sessions with `env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<proxy base_url>] claude --permission-mode auto --effort <e> --add-dir <home>/.factory`.
- **Proxy.** A session uses a proxy only when the config names one: the lane's override in `lanes.<id>.proxy`, else `session.proxy` of the node. The launch always clears a stray `ANTHROPIC_BASE_URL` from the shell, then sets it only from the config. So a proxy is always a choice that the config shows, never an accident of the shell.
- **Proxy check.** Before each launch, factory sends one bounded request to the proxy's `health` path. If the proxy does not answer, `on_fail` decides:
  - `stop` (the default): factory does not start the session. It prints the proxy id, the failed check and the fix, for example "start the proxy, or set `proxy: none` for this lane".
  - `direct`: factory starts the session with no proxy and records this in the lane state, so the views show it.
  This rule comes from a workspace lesson of 2026-10-16: a dead local proxy stopped all lanes for hours. The check stops that failure before it starts.
- `factory doctor` and `factory status` run the same check for each configured proxy. `doctor` sends it only when the config comes from `--home` or from the current folder. For a config found in a parent folder, it sends no request and warns: "Run with --home DIR to check the proxy". `doctor` prints `Config: <path>` first, to show which config it uses. `factory lane list` and the lanes view show a Proxy column for each lane: `direct`, the proxy id, or `<id> (down)`.
- **Restore and restart.** `lane resume`, `lane restart` and the tmux restore hook use the same launch code, so they apply the same proxy rules and the same check.
- **Heartbeat hook (recommended, a decision for Dean).** `factory lane new` writes a hook into the checkout's `.claude/settings.local.json`. On SessionStart, Stop and PreCompact, the hook writes one line (session id, event, time) to `<home>/.factory/state/heartbeat/<lane>`. This replaces the reads of `~/.claude/projects/*.jsonl` and `~/.claude/sessions/*.json`. It also gives the lane state (working, idle, compacting) without a transcript parse. The context percent comes from the status line JSON that Claude Code passes to the hook or status line command, not from the screen text.
- Today the lanes table reads the last-write time and entry flags of each transcript, with no message text. Dean allowed this in D-21 (2026-10-28). So the hook is not a fix for a broken rule. It removes a tie to a private file layout, and it works for a new user who has made no such decision.
- Until Dean decides, all reads of Claude Code's private layout sit in one adapter module, so one change fixes them when Claude Code changes its layout.

### 4.7 Language, install and distribution

- **TypeScript on Node 22+**, built to one bundled file (from mars: dev mode from source, one bundled file for a release). Zod for config and state schemas, Result types and no throws in the logic (Dean's engineering rules). Commands come from one command table, not from three hand lists (a mars gap).
- **External tools:** `tmux`, `git`, `gh` and `claude`. factory replaces `jq`, `python3` and `glow` with its own code, so a new machine needs fewer tools. `doctor` checks the versions.
- **Portable parts:** the heavy-test lock uses `lockf` on macOS and `flock` on Linux. `factory machine` reads memory and load on both systems. The owner's clipboard command is a config value with a platform default.
- **Install:** `npm i -g @dean0x/factory`, or `npx @dean0x/factory init`, plus a Homebrew formula in `dean0x/homebrew-tap` (the tap already takes a `repository_dispatch` from a release). An `install.sh` for curl, with a SHA256 check (mars has none).
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
6. A readiness check before the first use of a remote host. An unreachable host is "unknown", never "dead", and never replaced by a local copy (`docs/remote-secondmates.md`).
7. A fail-closed config parse (`docs/configuration.md` L1376–1378).
8. Upgrades by fast-forward only. A dirty home is reported and not touched (`bin/fm-update.sh`).

factory avoids these firstmate choices:
- Its workers skip permissions by default when no config file exists (`docs/configuration.md` L1368).
- Its config is scattered over many one-token files.
- It installs by `git clone`, with no versioned release and no migrations.
- It supports one person only, and it caps the hierarchy at two levels (`VISION.md` L7, L38).
- It supports many backends, and each one adds test and maintenance work.

## 5. Layers: one node model at any depth

### 5.1 The node

Every level is the same kind of thing: a node with `id`, `role`, `owner`, `parent` (or null), and `children`. Lanes are leaf children. A node that manages other nodes is the same program with different children.

```json
{ "schema_version": 1,
  "id": "acme-web", "role": "coordinator",
  "owner": { "display": "Ana", "github": "ana-x" },
  "parent": { "address": "ssh://hub.local/~/factory/acme", "id": "acme" },
  "children": [
    { "kind": "lane", "id": "web-checkout", "pane": "@lane=web-checkout" },
    { "kind": "node", "id": "acme-mobile", "address": "file:///Users/ana/factory/mobile" }
  ] }
```

### 5.2 Addresses

- A child is named by a relative path from its parent: `acme/acme-web/web-checkout`. A path is unique because each id is unique among its siblings.
- A transport says how to reach a node: `file://<home>` (same machine) or `ssh://<host>/<home>` (another machine). Each transport has the same three calls: `report`, `deliver` and `ping`. The remote side runs `factory --home <home> report --json` over SSH, so no extra server is necessary. Other transports can come later behind the same three calls.
- A parent reaches a lane only through the lane's own node. It never types into a grandchild's pane.

### 5.3 What goes up

`factory report --json --since <cursor>` returns one digest:
- node id, factory version, report schema version, and the cursor for the next read;
- lane states and context use;
- board counts by status and priority, and the items in progress;
- milestone events since the cursor (PR ready, merged with SHA, released with version, blocked);
- the items that wait on an owner, each with its **origin path** (for example `acme/acme-web#D-4`);
- the reports of the node's own children, already merged (a rollup).

So a node at any depth sees its whole subtree in one call. The digest is also written to `.factory/outbox/` by script, so the facts do not depend on the model's memory.

### 5.4 What goes down

- **Decisions:** `factory decide acme/acme-web#D-4 B` writes a decision record to the origin node's `inbox/`, through each node on the path. Each relay adds its own id to the record's `chain`.
- **Priorities:** a parent sends a `priorities` record. The child applies it to its board and reports the result.
- **Inherited config:** the parent passes only items on an explicit list (limits, the writing style, the safety rules). Owner identity, accounts and session settings are never passed.
- **Owner authority** comes only from the owner. A record carries authority only when its `by` is the owner of the target node and it arrived through the parent channel. If a parent node has a different owner (a team lead over a member's node), its records arrive as **requests**: the child's owner decides them. This is how a team works without a shared founder.
- In a lane pane, factory types only the one-line owner prefix and a pointer to the inbox record (`factory lane relay`). The record holds the text.

### 5.5 Where state lives, and how a parent reads it

Each node keeps its state in its own home (§4.3). A parent never reads or writes a child's files directly, except through `deliver` into the child's inbox. It reads the child only through `report`. Then the file format inside a node can change at an upgrade, and only the versioned report format is a contract.

### 5.6 What the CLI does now, so that a layer needs no redesign

- `node.json` has `parent` and `children` from day one, also in a node with no parent.
- Every owner item and every event carries an origin path, also at depth 1.
- `factory status` is a view of `factory report`. There is one code path, not two.
- The tmux session name is the node id, not a fixed `orchestrator`. Two nodes on one machine do not collide.
- The heavy-test lock is per machine and is shared by every node on it.

What the CLI must not assume:
- a fixed top level, or a fixed depth;
- one machine;
- one owner for the whole tree;
- that a parent is a Claude session (a person with only the CLI can be a parent);
- that a parent and its child run the same factory version.

## 6. Safety defaults

Each standing rule goes into a new setup in two ways. The text goes into the managed blocks of `CLAUDE.md` and `protocol.md`. Where a script can enforce the rule, factory enforces it in code, so a model error cannot break it.

| Rule | Text (managed block) | Code enforcement |
|---|---|---|
| Every session runs in auto mode | yes | `session.permission_mode` accepts only `auto`. Every launch adds `--permission-mode auto`. |
| Never skip permissions | yes | factory has no flag or config value that adds the skip flag. `doctor` reports a node or checkout whose settings set the bypass mode. |
| A proxy only by explicit config, and only when it answers | yes | Every launch clears `ANTHROPIC_BASE_URL`, then sets it only from `proxies` in the config (§4.6). A health check runs before each launch and in `doctor` and `status`. On failure the default is `stop` with the fix in the message; `direct` is an explicit choice. `doctor` sends the check only when the config comes from `--home` or from the current folder. For a config in a parent folder, `doctor` sends no request and warns to run with `--home DIR`. `doctor` warns when the variable is set in the shell. |
| No proxy keys or tokens in output | yes | `proxies` holds no keys; `doctor` refuses token-like values there. Output shows only the proxy id and its host and port, never user info, query strings or headers of the base URL. |
| A denial is final; no laundering through another session | yes | `lane send` and `lane relay` refuse a text that asks a lane to run a command that the node recorded as denied (a `denied` list in state). |
| Never invent the owner's consent | yes | `lane relay` types the owner prefix only for a decision record in `decision-log.json` with `by: owner`. |
| No secrets in output | yes | No command prints env values. `doctor` refuses token-like values in `factory.yaml`. Process lists show only pid, elapsed time and command name. |
| Peers never ask the owner directly | yes (protocol) | none (model behavior) |
| One session per checkout | yes | `lane new` refuses a checkout that another lane uses. |
| Every merge waits for the owner's go; pinned merges; `--admin` only by the node | yes | `pr merge` needs a recorded owner decision for that PR and head SHA. It always passes `--match-head-commit <full SHA>`, and only after `pr gate` passed at that SHA. If the head changes after the go, it refuses. |
| Releases need the owner's go | yes | `release` commands only check; they do not publish. |
| Never bypass the state hook | yes | `init` sets `core.hooksPath`; every state write commits through the helper, which refuses when the hook is off. |
| Never delete another lane's files; look before removing | yes | `clean` is a dry run by default and refuses a worktree with unpushed work or a path that a lane or resume file names. |
| Resource limits; one heavy suite at a time | yes | `lane new` checks the limits; `lock run` takes the machine lock. |
| Look before typing; target by pane id | yes | Every typed input captures the pane first, refuses an open dialog, clears the input, and checks that the text arrived. |

factory never writes to `~/.claude/` (settings, rules or skills). It writes only to the node home and to the checkout's `.claude/settings.local.json` (the heartbeat hook, if Dean accepts §4.6).

## 7. Generic names

The setup uses Dean's name and devflow's words in many places. factory uses these names; a node shows the owner's display name in the views.

| Today | In factory |
|---|---|
| founder, Dean | owner (the display name from `factory.yaml`) |
| On Dean, `on-dean.json`, `dean-review.html` | Waiting on you, `waiting.json`, `review/page.html` |
| Orchestrator | coordinator (the role); the session name is the node id |
| `.devflow/` (workspace state) | `.factory/` |
| `DEAN_DIR` | `FACTORY_HOME` |
| `/devflow:plan` … `/devflow:release` | stages `plan`, `build`, `review`, `fix`, `release` |
| Code, Validate, Test agents | implementer, verifier, tester roles |

## 8. Migration of this workspace

`factory adopt /Users/dean/Sandbox` imports the current setup into a node. It moves `.devflow/docs/orchestration/*` and `decision-profile/` to `.factory/`, renames the files of §7, keeps the git history (a `git mv` in the state repo), and writes `factory.yaml` from the facts in CLAUDE.md §13. It adds the devflow pack to the devflow projects. It keeps the old CLAUDE.md text outside the managed blocks, so Dean can delete the duplicate lines in one review. A dry run comes first. The adopt runs only when all lanes are idle and pushed.

## 9. Decisions

Dean accepted every recommendation in this table on 2026-11-01 (D-45 A, with the name `factory`; D-47 yes for the heartbeat hook, which comes with FAC-M3). D-46 B sets the merge rule.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Language | (a) TypeScript on Node; (b) Bash like mars; (c) Go single binary; (d) Python | **(a).** It fits your engineering rules (Zod, Result types), devflow is TypeScript, and npm is the existing channel. Bash has no schemas and a JSON state model is hard in Bash 3.2. Go removes the Node need, but it is a new stack in your repos. |
| 2 | Name and package | (a) `factory`, npm `@dean0x/factory`; (b) another name | **(a), with a check.** The npm name `factory` is taken; `@dean0x/factory` is free (checked 2026-11-01). A company named Factory sells an AI coding agent, so people can confuse the two. If that matters to you, choose a new name before M1. |
| 3 | License | MIT, Apache-2.0, private | **MIT**, like mars and devflow. |
| 4 | Public or private | (a) private now, public later; (b) public now | **(a).** Make the repo public when a team member installs it on a new machine (M7). The GitHub repo itself is your decision; this lane created none. |
| 5 | State folder and config | (a) `.factory/` and `factory.yaml`; (b) other names | **(a).** Never `.devflow/`, because devflow writes there. |
| 6 | Where a single-project node lives | (a) always a separate node folder; (b) also inside the repo (`<repo>/.factory/`, gitignored) | **(a) first.** One layout for all cases. (b) can come later if people ask. |
| 7 | Heartbeat hook | (a) factory writes a hook in each checkout's `.claude/settings.local.json`; (b) keep the reads of Claude Code's private files | **(a).** It is stable and needs no reads under `~/.claude`. Your D-21 allows the metadata reads today, so (b) is safe for you, but it ties factory to a private layout. It is a security config change, so it needs your yes. |
| 8 | Conflicts of §1.3 | my proposals in §1.3 | **Accept them.** Merge authority is decided by D-46 B: every merge waits for the owner's go, and factory copies that default. |
| 9 | Remote transport | (a) SSH only at first; (b) a small server | **(a).** No new service and no new port. |
| 10 | Python and glow | (a) port the Python scripts and the viewer into factory; (b) keep them as external tools | **(a).** Fewer tools on a new machine and one test suite. |
| 11 | Team defaults | (a) each member owns a root; a lead's node sends requests (§5.4); (b) one shared owner | **(a).** No name or account is fixed, and nobody acts on another person's authority. |
| 12 | Where the Subswitch settings live | (a) factory core has only a generic `proxies` entry; a `subswitch` preset (base URL, health path) ships in the devflow pack; (b) the preset is in factory core | **(a).** The default setup then names no devflow tool, and a devflow user gets the preset with `factory pack add devflow`. If Subswitch is not part of devflow, (b) is simpler. |

## 10. Risks

- **Claude Code changes its private layout or its CLI flags.** All Claude Code calls sit in one adapter, with a test that `doctor` runs against the installed version.
- **A dead proxy stops every lane that uses it.** The health check runs before each launch, the default is `stop` with a clear fix, and the views show which lanes use a proxy (§4.6).
- **tmux typing is fragile.** factory types only one short line per message and keeps the text in the inbox. Each typed input is checked by a capture.
- **Scope grows.** The roadmap ships the CLI in stages. Each stage is useful for this workspace before the next one starts.
- **Two copies of the setup during the move.** The adopt is one step with a dry run, and the old scripts stop when the adopt is done.
