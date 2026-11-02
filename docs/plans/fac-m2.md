# FAC-M2 plan: names, home, roles and schema 2

Status: proposal · Plan branch: `fac-m2-plan` · Code branch: `fac-m2` · Design: `docs/design.md` v2 plus F-13 · Roadmap: `docs/roadmap-v2.md` FAC-M2 · Date: 2026-11-02

## Goal and exit check
The code uses the v2 names, the v2 home rule and the schema-2 config, before more code depends on the old ones. `factory up` starts a node. All nodes are on one machine (F-13).

Exit check (`scripts/exit-check.sh`, extended):
1. `npm pack` and `npm i -g <tgz>` with a throw-away HOME, as in FAC-M1.
2. Make a temp git repo `<tmp>/web`. In it, run `factory init --yes --owner-name "Test Owner"`. It makes `<tmp>/web-factory` with `web` as the first project.
3. Run `factory up --dry-run --home <tmp>/web-factory`. It exits 0 and runs no tmux command.
4. Run `factory doctor --home <tmp>/web-factory`. It exits 0.
5. Search the generated files and the `--help` output for the deny list and for the old words (§2). A match fails the check.

The criteria of roadmap-v2 FAC-M2 are the acceptance list. §12 maps each one to a test.

## Scope
In: the renames (F-1); the home rules, `init` and `factory up` (F-3); the role templates, `node.layer` and the `node` child commands (F-4); the native Windows refusal (F-5); config schema 2 with the recipe split (F-10); the schema 1 → 2 migration; `file://` addresses only (F-13).
Also in, from the intent check (§13a): the home index; the rule for a folder that holds several repos; the clone path of `--project URL`; the role of each layer; the glossary and `factory help words`; the three triage words in the deny list; the pane option `@cell`; the short-output helper; the docs check; the D-51 review scope.
Out (later milestones, in the build order of D-56):
- cells, `layout`, the board in the view slot, the heartbeat hook, the doorbell inbox (FAC-M4);
- the `local` tracker, `item`, `andon`, `decide`, `staging`, `inspect`, `pr`, `ship`, `checkout`, the report core (FAC-M5);
- the devflow variant (FAC-M6); `adopt` (FAC-M7);
- the `github` adapter, `watch`, `tracker` and `state` (FAC-M3);
- the rollup, `deliver`, `node tree` (FAC-M8).

Later milestones add optional config keys with no schema bump, because old configs stay valid: `session.agent` and `session.statusline` (FAC-M4), `approval.ship` and `tracker.agent_account` (FAC-M5), the tracker keys `site` and `key`, `recipe.projects[].tracker` and `state.remote` (FAC-M3, FAC-M9).

One PR (roadmap rule). There is no split: the renames and the schema change touch every module, and the roadmap keeps them in one PR so that the names test sees all of them at once.

The F-13 removals in the design and the roadmap are in this plan PR, not in the code PR. So the design is true before the code starts.

## 1. Changes to the design and the roadmap (this plan PR, F-13)
- Design "Changes from v1": a paragraph for F-13.
- Design §4.2: `init` gets `--layer N` (§6).
- Design §4.4: the schema-2 example shows `parent: null`.
- Design §4.5: the migration table gets the rows `parent: null` and `children[].address`.
- Design §4.8, firstmate idea 6: marked "skipped for now". factory keeps the rule that an unreadable child is "unknown".
- Design §5.1: the JSON example uses a `file://` parent address.
- Design §5.3: one transport, `file://`; the config refuses any other address.
- Design §5.7: "one machine" leaves the must-not-assume list. A new line: every address goes through the transport interface.
- Design §9: v1 row 9 is replaced by F-13, and the v2 table has an F-13 row.
- Roadmap FAC-M2: scope item 6 and an exit criterion for F-13. The tmux test uses `TMUX_TMPDIR` (§7).
- Roadmap FAC-M8: no `ssh://` transport. The exit criterion for an unreadable child replaces the SSH criterion.

PR #3 changes two lines next to design §4.8 idea 6. If PR #3 merges first, this branch takes a rebase with a small conflict there.

## 2. Renames (F-1)
All in `src/names.ts`, plus the template text and the tests.

| FAC-M1 name | FAC-M2 name |
|---|---|
| `roles.lane` "lane" | `roles.cell` "cell" |
| `roles.pack` "pack" | `roles.recipe` "recipe", `roles.variant` "variant" |
| `values.role` (`coordinator`) | gone; `node.layer` sets the role (§6) |
| `keys.root.lanes`, `keys.lane` | `keys.root.cells`, `keys.cell` |
| `keys.node.role` | `keys.node.layer` |
| `keys.project.pack`, `values.pack` | `keys.recipe.variant`, `values.variants` (`plain`) |
| `files.protocol` `protocol.md` | `files.worker` `worker.md` in `dirs.roles` `roles` |
| `blockNames.protocol` | `blockNames.worker` |
| `dirs.briefs` `briefs` | `dirs.orders` `orders` |
| placeholders `{{lane}}`, `{{pack}}`, `{{protocolFile}}`, `{{briefsDir}}` | `{{cell}}`, `{{recipe}}`, `{{workerFile}}`, `{{ordersDir}}` |

- New names: the commands `up` and `node` (subcommands `children`, `add-child`, `remove-child`); the flags `yes`, `layer`, `recipe`; the env names `FACTORY_HOME`, `FACTORY_SESSION`, `XDG_STATE_HOME`; the tmux window names `view` and `bench`; the pane options `@factory_home`, `@node`, `@slot`, `@cell`; the block `manager`; the JSON ids `factory.up/v1` and `factory.node-children/v1`; the index file name `homes.json`; the help topic `words` and the list `terms` (§13a).
- The names test (`test/unit/names.test.ts`) keeps its stray-literal check. It also fails on the words `lane`, `pack` and `brief` (whole words, any case) in three places: the `--help` output of every command, every template, and the files that `init` writes. Template text must not use "brief" as a verb either. It also fails when a file under `src/` contains `@lane`.

## 3. Config schema 2 (F-10, F-13)
The keys are those of design §4.4, plus `parent`. Every object is strict.

**Core** (`src/config/schema.ts`; it parses all keys except the inside of `recipe`):
- `schema: 2`.
- `node`: `id` (slug), `layer` (integer 1–16). A node home is never layer 0: cells have no home.
- `owner`, `session`, `proxies`, `limits`: as schema 1.
- `cells`: a map from cell id to `{ proxy }`. It replaces `lanes`.
- `approval.land`: `each` (default) or `approved-work`.
- `tracker`: a union on `kind`.
  - `local`: no other key. The schema refuses `items`, `decisions` and `watch_interval`.
  - `github`, `jira`, `linear`, `desk`: `items` and `decisions` (1–200 chars) are required. `watch_interval` is `<n>m` or `<n>h` from 1m to 24h, default `5m`.
- `recipe`: the core reads only `recipe.id` and checks it against the recipe registry. Then it gives the whole block to that recipe's parser.
- `parent`: `null` (default) or `{ id, address }`.
- `children[]`: `{ id, address }`, at most 200.
- Cross checks: unique ids in `proxies`, `children` and the recipe projects; each `proxy` reference names a defined proxy.

**Addresses (F-13)** (`src/comms/address.ts`): an address must be `file://` plus an absolute path, with no host, no `..` segment, no `%`, no query, no fragment, no NUL, at most 4096 chars. Any other scheme fails with: "factory runs on one machine: use a file:// address". The message names the key, for example `children[1].address`.

**Recipe `software`** (`src/recipes/software/config.ts`, strict):
- `id: software`, `variant` (`plain` only; FAC-M6 adds `devflow` with no schema bump, because old configs stay valid).
- `projects[]`: `id`, optional `repo`, `path`, `default_branch`, `merge_method`, optional `variant`, `gate.checks`, optional `heavy_test`. The rules of schema 1 apply.

**Load** (`src/config/load.ts`): YAML parse → version check → core parse → recipe parse. Each step fails closed and names the key. The loaded type is `{ core, recipe }`, so later code never reads an untyped recipe block.

**Render** (`src/config/render.ts`): the schema-2 text with comments. `init` and `upgrade` use it.

## 4. State and layout
- `.factory/node.json`, `schema_version: 2`. The keys stay the same. The `blocks` map now names `worker` (layer 1 only), the role block of `CLAUDE.md` and `safety`.
- `src/state/layout.ts` gives the new paths: `roles/worker.md` and `orders/.gitkeep`. No module builds a state path by hand.
- `init` (layer 1) writes:

```
<home>/factory.yaml                    schema 2, tracker.kind: local, approval.land: each, parent: null
<home>/CLAUDE.md                       managed blocks: coordinator (layer 1) or manager (layer 2), safety; a layer above 2 gets safety only
<home>/.factory/node.json              schema_version 2
<home>/.factory/roles/worker.md        managed block: worker (layer 1 only)
<home>/.factory/board.json  waiting.json  decision-log.json   (as FAC-M1; the files of the local tracker)
<home>/.factory/decision-profile/README-format.md, index.md
<home>/.factory/roadmaps/README.md
<home>/.factory/orders/.gitkeep
<home>/.factory/.gitignore             state/ locks/ backups/
```
- The atomic write, the state repo and the deny list stay as in FAC-M1.

## 5. The schema 1 → 2 migration
Three parts. `upgrade` runs all three in one transaction, with the FAC-M1 backup and restore.

1. **Config** (`src/migrate/config.ts`, a pure function from schema 1 to schema 2): the table of design §4.5.
   - `node.role: coordinator` becomes `node.layer: 1`. `lanes` becomes `cells`.
   - `projects[]` move to `recipe.projects[]`, with `recipe.id: software` and `recipe.variant: plain`. `pack` leaves each project.
   - It adds `tracker: { kind: local }`, `approval: { land: each }` and `parent: null`.
   - Each `children[].address` must pass the address rule (§3). Else the migration fails, names the child and changes nothing.
2. **State** (`src/migrate/state.ts`, a pure function): `schema_version` 1 → 2, and the `blocks` key `protocol` becomes `worker`.
3. **Files** (`src/migrate/files.ts`, new): a list of moves for each state step. For 1 → 2: `protocol.md` → `roles/worker.md`, and `briefs/` → `orders/`.
   - A move refuses when the target exists.
   - The `protocol` block in the moved file is a renamed block. If it is intact, `upgrade` replaces it with the current `worker` block. If someone edited it, `upgrade` refuses and shows the diff. Then `--overwrite protocol` replaces it.
   - The state commit records the moves, so git shows them as renames.

The upgrade order stays: plan → print (`--dry-run` stops here) → backup → config, state, files → validate every file → write → commit. On any error it restores the backup and exits 1.

**Fixture of a FAC-M1 node.** There is no 0.1.0 tag (D-49). `scripts/make-m1-fixture.sh` builds the tarball at commit 4849465 in a temp worktree. It runs `init` with "Test Owner" and a project `../web`, then copies the node without `.factory/.git` to `test/fixtures/node-0.1.0/`. The fixture is committed. The script runs by hand only; CI uses the committed fixture and needs no network. The migration test copies the fixture to a temp folder, makes the `web` repo, runs `git init` and a first commit in `.factory/`, and then runs `upgrade` and `doctor`.

## 6. Home rules and `init` (F-3, F-4)
New flags: `--yes`, `--recipe software` (the only value), `--layer N` (1–16, default 1).

Where the home is:
1. With `--home DIR`: that folder.
2. Else, when the current folder is inside a git work tree: the proposal is `<parent of the repo root>/<repo folder>-factory`. The repo root becomes the first project, before any `--project`.
   - On a TTY, `init` prints the proposal and asks "Create the node home here? [y/N]". Only `y` or `yes` goes on.
   - With `--yes`, it uses the proposal.
   - With no TTY and no `--yes`, it prints the proposal and exits 2.
3. Else, when the current folder is not a git work tree and holds git repos one level down (step 5.2): the proposal is `./<folder>-factory`, next to those repos. Each repo found becomes a project. The same TTY, `--yes` and exit 2 rules as in rule 2 apply. `init` never makes the current folder the home in this case.
4. Else: the current folder.

Refusals, all with exit 4 and a message that names the rule and the path:
- the home is inside a git work tree (a `git rev-parse --show-toplevel` from the nearest folder of the home that exists);
- the home is inside another node home: a parent folder has a `factory.yaml`. This changes the FAC-M1 rule, which gave a warning;
- the home is a project folder or a parent of one (a compare of real paths);
- the home holds a git repo one level down (step 5.2). This covers `init --home .` in a workspace folder, where no project is declared.

`init` still refuses when the home itself has a `factory.yaml`. The walk-ups stop at the file-system root or after 64 levels. The scan below the home reads at most 200 entries and follows no symbolic link.

New `Deps` parts: `stdinIsTTY` and `stdoutIsTTY` (booleans), `prompt(question)` (reads one line, at most 200 chars), and `runAttached(command, args)` (inherits the terminal, for `tmux attach`). The fakes get the same parts.

Home order for every command: `--home`, else `FACTORY_HOME`, else the walk-up, else the home index (step 5.1). `doctor` sends network checks only when the home comes from `--home` or is the current folder (SEC-S2 option A). `FACTORY_HOME` alone does not allow them, and a home from the index does not allow them either.

## 7. `factory up` (F-3)
Flags: `--home DIR`, `--dry-run`.

Steps:
1. Load the config. Check `tmux` (version 3.0 or newer, because `new-session` runs an argument list with no shell) and `claude` on PATH. A missing tool exits 1 and names it.
2. The session name is `node.id`. If `tmux has-session -t =<id>` finds it:
   - when its option `@factory_home` is this home: start nothing, then attach (step 6);
   - else exit 4: "a tmux session <id> belongs to another home".
3. The proxy check of design §4.6 for `session.proxy`. With `on_fail: stop` and no answer, exit 1 with the fix. With `direct`, launch with no proxy and print a warning.
4. The launch argument list comes from one pure function, `src/launch/argv.ts`. FAC-M4 uses it for cells:
   `env -u ANTHROPIC_BASE_URL [ANTHROPIC_BASE_URL=<base_url>] FACTORY_HOME=<home> FACTORY_SESSION=<node id> claude --permission-mode auto --effort <e> [--model <m>] --add-dir <project>...`
   - one `--add-dir` for each project, with the absolute path;
   - `--model` only when `session.model` is not `default`;
   - no skip flag can come from any input.
5. tmux calls, each an argument list with no shell:
   - `new-session -d -s <id> -n view -c <home> -- <launch argv>`, then set `remain-on-exit on` and the pane option `@node <id>` on that pane;
   - set the session option `@factory_home <home>`;
   - `split-window -h -t =<id>:view -c <home>` for the slot, with the pane option `@slot board`. The slot is an empty shell in FAC-M2; FAC-M4 shows the board there;
   - `new-window -d -t =<id> -n bench -c <home>`. Cells come in FAC-M4.
6. Attach: with a TTY and no `TMUX` env, `tmux attach -t =<id>`. Inside tmux, `switch-client -t =<id>`. With no TTY, print `Session <id> runs. Attach with: tmux attach -t <id>` and exit 0.

`--dry-run` prints the steps and the argument lists. It runs no tmux command, except `has-session` when tmux exists. It works without tmux and without `claude`, so the exit check runs on any CI runner. The output shows only the proxy id and `host:port` of a proxy.

`--json` gives `{ schema: "factory.up/v1", session, started, attached, proxy }`.

## 8. Roles, layers and children (F-4, F-13)
**Role templates** live in the package, in `src/recipes/software/roles/`:
- `worker.ts` (layer 0): the FAC-M1 protocol text, renamed. It has the sections Role, Questions and escalation, Milestones, Denial is final, Context budget, Heavy tests, Disk, and Writing.
- `coordinator.ts` (layer 1): the FAC-M1 coordinator text, renamed. It has the sections Role, Owner authority, Merges and releases, Cells, and State files.
- `manager.ts` (layer 2 only): new and short. It manages coordinators. It has the sections Role, Children, Priorities and capacity, Owner items, and Limits ("no PR-level work").
- `src/recipes/software/recipe.ts` maps the layers to templates: 0 → worker, 1 → coordinator, 2 → manager. A layer above 2 has no template: each layer has its own role, so the manager text does not serve layer 3 (decision OD-5). FAC-M8 ships the layer-3 template (`director`). `roleForLayer(layer)` is the only lookup. It returns the template, or `null` for a layer with no template.
- The `safety` block stays in the core (`src/templates/safety.ts`). Every role gets it. A node on a layer with no template gets the `safety` block and no role block: `init --layer 3` writes `CLAUDE.md` with that block only and prints a warning that names the layer.
- The upgrade spec takes the block list from the config layer, not from a fixed list. If the layer changes by hand, `doctor` warns that the role block does not match. `upgrade` then swaps an intact role block, and refuses an edited one without `--overwrite`.

**Transport** (`src/comms/`): `address.ts` (§3) and `transport.ts` with one interface. FAC-M2 has only `ping` on the `file://` transport. `ping` reads the child's `factory.yaml` with the normal config loader, and gives `{ id, layer, schema }` or `unknown` with a reason. `report` and `deliver` come in FAC-M8. The doorbell inbox of FAC-M4 goes into the same folder (research recommendation, PR #3).

**Commands:**
- `factory node children [--json]`: one row for each child: id, address, layer, and `ok` or `unknown`.
- `factory node add-child <path|file-address>`: it turns a path into a `file://` address and pings the child. It refuses (exit 4) when:
  - this node is on layer 1. The children of a coordinator are cells, and `cell new` makes them (FAC-M4);
  - the child's layer is not this layer minus 1;
  - the child is not reachable, or its schema is not the current one (the message says which side needs `factory upgrade`);
  - the id is already a child, or the child home is this home, inside it, or above it.
  It writes the entry through the `yaml` Document API, so the owner's comments stay. Then it checks the whole config again before the write.
- `factory node remove-child <id>`: it removes the entry the same way. It never touches the child's files.
- No command writes `parent`. The owner sets it by hand until FAC-M8.

## 9. Platforms (F-5)
`src/cli/run.ts` checks `deps.platform.os` before it runs any command, also `help` and `version`. On `win32` it prints "factory runs on macOS and Linux. Use WSL; factory runs there as on Linux." and exits 4.

## 10. Doctor changes
| id | Fail when | Warn when |
|---|---|---|
| `config` | schema-2 core or recipe parse fails | — |
| `home` | the home is inside a git work tree, inside another node home, or above a project (the `init` rules) | — |
| `blocks` | — | a block is missing or edited, or the role block does not match `node.layer` |
| `roles` | — | `node.layer` has no role template (a layer above 2); the message names the layer |
| `index` | — | the home index has an entry whose home is gone, or the index file is not readable |
| `tracker` | — | `tracker.kind` is not `local`: its connector comes in a later version |
| `children` | a child is on the wrong layer | a child is `unknown` |
| `tools` | Node is older than 22 | `tmux` is missing or older than 3.0 (names `up`); `git`, `gh` or `claude` is missing |

The other FAC-M1 checks stay. A migrated FAC-M1 node passes all of them.

## 11. Commands after FAC-M2
`init`, `up`, `doctor`, `upgrade`, `node children|add-child|remove-child`, `version`, `help`. Exit codes, global flags and `--json` stay as in FAC-M1.

## 12. Tests
| Roadmap criterion | Test |
|---|---|
| Names test; no `lane`, `pack` or `brief` in help or generated files | unit `names.test.ts`; integration `init.test.ts` scans the files |
| `init --yes` in a git work tree makes `../<repo>-factory` with the repo first | integration `init.test.ts` |
| `init` exits 4 inside a work tree, inside another home, above a project | integration `init.test.ts`, three cases; unit `init.test.ts` for the TTY prompt and exit 2 |
| `factory up` on a separate tmux server | integration `up.test.ts`: `TMUX_TMPDIR` in a temp folder, no `TMUX` env, a fake `claude` that writes its arguments and two facts (is `ANTHROPIC_BASE_URL` set; the `FACTORY_HOME` value) to a file, then sleeps at most 300 s. It asserts the session, the windows `view` and `bench`, auto mode, no inherited proxy variable, one `--add-dir` per project, and one launch after two `up` runs. Cleanup: `tmux kill-server` on that folder. The test skips with a note when tmux is missing |
| Role templates: deny list and required sections; `add-child` exits 4 for another layer | unit `templates.test.ts`; unit and integration `node.test.ts` |
| A FAC-M1 node upgrades to schema 2 with `tracker.kind: local`, then `doctor` exits 0 | integration `upgrade.test.ts` with `test/fixtures/node-0.1.0/` |
| Fake `win32`: every command exits 4 with the hint | unit `cli.test.ts`, a loop over the command table |
| `exit-check` with the v2 flow | `scripts/exit-check.sh` |
| F-13: no address but `file://` | unit `config-schema.test.ts` and `comms.test.ts`: `ssh://`, `https://`, a relative path, a host, `..`, `%`, a query; the migration of a schema-1 child with an `ssh://` address fails |
| Home index: `up --dry-run` from `web/` and `web/src` | unit `home-index.test.ts`; integration `up.test.ts` (step 5.1) |
| Workspace folder with two repos and a linked worktree | integration `init.test.ts` (step 5.2) |
| Clone path of `--project URL` | unit `init.test.ts` with the fake `run` (step 5.2) |
| `roleForLayer(3)` has no template; `init --layer 3`; `doctor` warning | unit `templates.test.ts`, `doctor.test.ts`; integration `init.test.ts` (step 5.3) |
| Glossary: every term has an entry of at most 25 words | unit `glossary.test.ts` (step 5.4) |
| Three triage words in the deny list | unit `templates.test.ts`; integration `init.test.ts` scans the files (step 5.5) |
| Pane option `@cell`, no `@lane` | unit `names.test.ts` (step 5.6) |
| Short-output helper | unit `short-output.test.ts` (step 5.7) |
| Docs check; review scope | `scripts/check-intent-docs.sh`, run by `exit-check.sh` (step 5.7); `scripts/check-review-scope.sh`, run after the review (steps 5.8 and 10) |

Other unit tests: the schema-2 core and recipe parsers (each key, strictness, the tracker union, cross checks); the config, state and file migrations, also a move onto an existing target, an edited `protocol` block, and the restore after a failure in the middle; `argv.ts` (proxy, no proxy, `direct`, model, the project list); the `up` plan with a fake `run` (new session, own session, a session of another home, proxy down); `ping` (ok, missing home, bad config, newer schema).

Test runs: a single test file runs without the lock. The full suite runs under the machine lock.

## 13. Steps (small commits on `fac-m2`)
1. `names.ts` renames, the template text and the names test. Every old test still passes with the new names.
2. Config schema 2: core, the recipe registry, the `software` recipe parser, the address rule, load and render.
3. State schema 2, layout, and the three migrations, with the fixture script and the committed fixture.
4. Role templates, `roleForLayer`, and the block list from the layer.
5. `init`: the home rules, the proposal, `--yes`, `--layer`, `--recipe`, and the new `Deps` parts.
5.1 to 5.7. The intent fixes of part A (§13a), each its own commit, in this order. Steps 6 to 8 can come between them. The `up --dry-run` case of step 5.1 is added in step 6.
6. `launch/argv.ts` and `factory up`, with the tmux integration test.
7. `comms/` and the `node` commands.
8. The platform refusal and the doctor checks.
9. `exit-check.sh`, CI (`ci.yml` installs tmux on the ubuntu and macOS runners), README, CHANGELOG (0.2.0, not released). A full local run of the CI steps under the lock. A Snyk code scan.
10. The review and resolve cycle. The summaries go in `docs/reviews/`. One review agent reads the FAC-M1 setup and upgrade code in full, not only the diff (§13a, step 5.8).

## 13a. Intent fixes (part A)

An independent check of the design against Dean's notes found gaps that belong to this PR. The roadmap FAC-M2 has the related exit criteria. These steps come after §13 step 5 and before the review. Each step is its own commit. A step lists its files, its behavior and its test. The design sections hold the full rules.

### 5.1 Home index (F-3b, design §4.3)
Files: `src/core/home-index.ts` (new), `src/core/home.ts`, `src/commands/init.ts`, `src/commands/doctor.ts`, `src/names.ts`, `test/unit/home-index.test.ts` (new), `test/integration/up.test.ts` (the case is added in step 6).

Behavior:
- The index file is `$XDG_STATE_HOME/factory/homes.json` when the variable holds an absolute path, else `$HOME/.local/state/factory/homes.json`. Both paths come from `deps.env`. The code refuses an index path under `$HOME/.claude/` (exit 4).
- The content is `{ "schema": 1, "homes": [ { "home", "id", "projects": [absolute path] } ] }`, parsed with Zod (strict). At most 200 homes and 200 projects for each home.
- `init` writes the entry after it writes the node. An entry for the same home replaces the old one. The write is atomic (a temp file and a rename), with file mode 0600 in a folder of mode 0700.
- `locateHome` gets a fourth source, `index` (`HomeSource` gets the value `index`). It runs after the walk-up finds nothing. It compares real paths. The deepest project path that contains the current folder wins. No match gives exit 2 with the hint "run `factory init` here, or use `--home DIR`". A tie between two homes gives exit 2 and names both. An index that cannot be read gives the same exit 2 and names the file.
- `doctor` treats the source `index` like a home in a parent folder: no network check, and a warning. A new check `index` warns on an entry whose home is gone.
- Every command gets this through `resolveHome`. No command reads the index by itself.

Test: unit tests for the match function (deepest wins, tie, no match, a path under `~/.claude`, a bad file, the bounds). Integration test with a temp HOME and a temp `XDG_STATE_HOME`: after `init --yes` in the repo `web`, `factory doctor` from `web/` and from `web/src` prints the `web-factory` config path. After step 6, the same test runs `up --dry-run` and checks exit 0. A folder in no entry gives exit 2 and the hint.

### 5.2 Workspace folder and clone path (F-3b, design §4.3)
Files: `src/commands/init.ts`, `src/core/git.ts`, `src/commands/doctor.ts` (the `home` check), `test/unit/init.test.ts`, `test/integration/init.test.ts`, `test/helpers/git-fake.ts`.

Behavior:
- `listRepoChildren(deps, dir)` in `src/core/git.ts` reads at most 200 entries, follows no symbolic link, and returns each child folder that `isWorkTreeRoot` accepts. `commonDirOf(deps, dir)` runs `git rev-parse --git-common-dir`. Two folders with the same common dir are one repo: the main checkout is the project, and the others are returned as `skipped` with the reason.
- `init` rule 3 of §6 uses this list: the proposal, the project list, the confirmation, `--yes` and exit 2 are as in rule 2. The output names each skipped folder.
- The refusal "the home holds a git repo one level down" uses the same list. It applies to `--home DIR` and to rule 4.
- `--project URL`: the accepted forms are `https://`, `ssh://` and `user@host:path`. The repo name is the last part of the URL without `.git`. It must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`. Else exit 2. The target is `<folder of the home>/<repo name>`. `gitClone` runs `git clone -- <url> <target>` through `deps.run` with a time limit of 300 s. If the target exists and is a git repo with the same `remote.origin.url`, `init` reuses it. If it exists in any other way, exit 4 and name the path. The project path in the config is relative to the home (`../<repo name>`).

Test: integration test (the roadmap criterion): a temp folder with the git repos `web/` and `api/`, and `web-search/` as a linked worktree of `web`. `init --yes` makes `./<folder>-factory` and lists `web` and `api`, and names `web-search` as skipped. `init --home .` there exits 4 and names the rule. Without a TTY and without `--yes`, exit 2 with the proposal. Unit test with a fake `run`: the clone argument list has `--` before the URL; the target is next to the home; a target that exists and has another origin gives exit 4; a name with `..` or with `-` as its first character gives exit 2.

### 5.3 Role of each layer (decision OD-5, design §4.9 and §5.2)
Files: `src/recipes/software/recipe.ts`, `src/recipes/software/roles/manager.ts`, `src/commands/init.ts`, `src/upgrade/spec.ts`, `src/commands/doctor.ts`, `test/unit/templates.test.ts`, `test/unit/doctor.test.ts`, `test/integration/init.test.ts`.

Behavior: as in §8. `roleForLayer(layer)` returns the worker, coordinator or manager template for 0, 1 and 2, and `null` above 2. The upgrade spec lists no role block for a layer with no template. `init --layer 3` writes the `safety` block only and prints a warning that names the layer. `doctor` adds the check `roles` (§10).

Test: unit tests for the four calls of `roleForLayer` (0, 1, 2, 3); the block list for layer 3; the `doctor` warning with the layer in the message; an integration test of `init --layer 3`.

### 5.4 Glossary and `factory help words` (F-1c, F-1d, design §4.1 and §7)
Files: `docs/glossary.md` (the text is ready; the format is `- **term**: sentence`), `src/glossary.ts` (new), `src/names.ts` (the list `terms`), `src/cli/run.ts` (the help topic `words`), `test/unit/glossary.test.ts` (new).

Behavior:
- `terms` lists these 13 names: node, owner, project, layer, cell, recipe, variant, andon, work order, changeover, staging, inspect, ship.
- `src/glossary.ts` holds one sentence for each term, equal to the line in `docs/glossary.md`. No text in it may match the deny list.
- `factory help words` prints one line for each term, `<term>: <sentence>`, after a first line `factory words`. `--json` gives `{ schema: "factory.words/v1", words: [ { term, text } ] }`. Exit 0.

Test: for each term of `names.terms`, an entry exists in `src/glossary.ts` and in `docs/glossary.md`, the two texts are equal, and the entry has at most 25 words (split on white space). The output of `help words` has the 13 terms and no deny-list word. A term that is added to `terms` with no entry fails the test.

### 5.5 Triage words in the deny list (O-1h, design §2.2)
Files: `test/helpers/deny-list.ts`, `test/unit/templates.test.ts`, `test/integration/init.test.ts`.

Behavior: `DENY_PATTERNS` gets three patterns, case sensitive and with word edges: `FIX_NOW`, `ESCALATED` and `CHANGES REQUESTED` (name: "workflow triage word"). The devflow variant file of FAC-M6 is the only file that may hold them. The command `desk render` is not built (design §4.2), so there is nothing to change in the code. The names test already fails on a command that the command table lacks.

Test: a unit case shows that each of the three words is matched. Every template and every file that `init` writes passes the deny list again.

### 5.6 Pane option `@cell` (F-1, design §4.11 and §5.1)
Files: `src/names.ts`, `test/unit/names.test.ts`.

Behavior: `names` gets the pane option `@cell` next to `@factory_home`, `@node` and `@slot`. FAC-M4 sets it on each bench pane. No file under `src/` uses `@lane`.

Test: the names test asserts the value `@cell` and fails when any file under `src/` contains `@lane`.

### 5.7 Short-output helper, token budget and docs check (O-1g, design §3 and §4.2)
Files: `test/helpers/short-output.ts` (new), `test/unit/short-output.test.ts` (new), `docs/token-budget.md` (the text is ready), `scripts/check-intent-docs.sh` (new), `scripts/exit-check.sh`, `package.json`.

Behavior:
- `expectShortOutput(text)` fails when the output has more than 20 lines, when the first line is empty, or when the first line has more than 120 characters. Tests of a job command call it. In FAC-M2 it applies to the default output of `up` (not the dry run, which prints the plan) and of `node children`.
- `scripts/check-intent-docs.sh` uses POSIX shell with `grep` and `awk`, and no other tool. It exits 1 and names the first failure of each check:
  1. Each `§n` or `§n.m` in `docs/intent-trace.md` is a heading of `docs/design.md`.
  2. Each `FAC-M<n>` in the trace is named in `docs/roadmap-v2.md`. Each milestone from FAC-M2 up has a heading there.
  3. The first word of each command line in the §4.2 code block of the design has a row in the "Command map" of the roadmap.
  4. The table of design §7.1 has 11 rows.
  5. The Status column of the parity table in design §8.1 holds only `planned`, `done` or `retired`.
  6. `docs/token-budget.md` has one row for each of the 17 jobs of design §3.
  7. No file under `docs/research/` holds the whole word `lane`.
- `exit-check.sh` runs the script.

Test: the unit test for the helper (20 lines pass, 21 lines fail, an empty first line fails, a first line of 121 characters fails). The docs check runs in `exit-check.sh` and in CI. A fixture copy of the docs with one broken reference shows exit 1.

### 5.8 Review of the setup and upgrade code (D-51 A, design §9)
Files: `docs/reviews/fac-m2-review-summary.md` (written by the review), `scripts/check-review-scope.sh` (new).

Behavior: D-51 A moved the review of the FAC-M1 setup and upgrade code into the review of this PR. In step 10, one review agent reads these files in full, not only the diff: `src/commands/init.ts`, `src/commands/upgrade.ts`, `src/commands/doctor.ts`, `src/upgrade/apply.ts`, `src/upgrade/plan.ts` and `src/upgrade/spec.ts`. Its findings go into the one review summary. The summary has a section "Setup and upgrade code (D-51 A)" that lists those six paths. `scripts/check-review-scope.sh <summary>` exits 1 and names each path that the summary does not list.

Test: the script runs on a fixture summary with all paths (exit 0) and on one with a path removed (exit 1). The Orchestrator runs it on the real summary before the merge.

## 14. Risks
- **The PR is large.** The steps are separate commits, so the review can read them one by one. The names test catches a stray old word.
- **tmux differs between macOS and Linux runners.** The test needs tmux 3.0 or newer, and skips with a note when tmux is missing. CI installs tmux on both runners, so the test runs there.
- **The fixture goes stale if someone edits it by hand.** The fixture script makes it again. The test checks the `created_with: 0.1.0` field.
- **`yaml` Document edits can change the layout of the file.** A test checks that the owner's comments and the key order stay after `add-child` and `remove-child`.
- **A user starts two nodes with the same id on one machine.** `up` refuses through the `@factory_home` check (exit 4).

## 15. Later milestones: research recommendations (accepted, D-55; not FAC-M2)
Dean accepted both, and roadmap-v2 now has their scope and exit criteria.
- **Doorbell inbox** goes into FAC-M4. It lives in `src/comms/`, next to the `file://` transport of FAC-M2.
- **`factory checkout list|status|sync|clean`** for the coordinator goes into FAC-M5. `factory clean` becomes `factory checkout clean`, so one command has the job. The design §3, §4.2 and §6 use the new name.

## Decisions taken in this plan (for the Orchestrator to check)
- The F-13 doc removals are in this plan PR, so the design is true before the code. Cost: a small rebase conflict with PR #3 at design §4.8.
- Schema 2 has `parent` now (design §5.7: from day one), so FAC-M8 needs no schema 3. No command writes it yet.
- `init --layer N` makes a layer-2 node. The design said only "set by factory"; the flag is how.
- `node add-child` refuses on layer 1, because cells are the children there.
- The tmux test uses `TMUX_TMPDIR`, not a `-L` flag in the product. The roadmap text now says so.
- The software recipe accepts only the `plain` variant until FAC-M6.
- Network checks in `doctor` do not trust `FACTORY_HOME` alone (SEC-S2 option A stays strict).
- The non-`local` tracker kinds parse now, and `doctor` warns that their connector comes later. So FAC-M3 needs no schema bump.
- Intent fixes (§13a): `init --project URL` clones in FAC-M2 now, next to the home. A layer above 2 has no role template until FAC-M8, so `roleForLayer(3)` returns `null` and `init --layer 3` writes the `safety` block only. The home index is a cache in `$XDG_STATE_HOME`, never a source of truth for network checks.

## Resume here (updated 2026-11-02)
- Plan PR #4 and research PR #3 are merged. D-55, D-56 and the intent fixes (brief of 2026-11-02, OD-1 to OD-10) are in the design, the roadmap, `docs/intent-trace.md` and this plan.
- Branch `fac-m2` (pushed, head 05c1690, base `main` f2aa733). Update it only by a merge of main; never rebase or force push. No PR yet; the PR targets `main`.
- Done: §13 steps 1–9 and §13a steps 5.1–5.8 (the 5.8 review itself is still to do), plus the temp cleanup of the integration tests and the clone undo of `init`. Harden (FIXED: home rules in `up`, two doc fixes) and Evaluate (aligned; the fixture version check is added) are done. The four Harden items that the Orchestrator chose are fixed (4bdf4f0, 07f55ad, ffc5844, c62d9c9). Each changed test file passes alone; typecheck is clean; Snyk: 0 issues in `src`. The full suite and `npm run exit-check` have not run yet.
- Open Harden items for the step 10 review (the report gives the outcome of each): `mkdir` keeps the mode of an existing index folder and the temp file is 0644 until the chmod; `readHomeIndex` and the child ping read the whole file before the size limit; an empty parent folder of a clone can stay after the undo; a cleanup message can name a session that is gone; `doctor` sends the proxy health GET for a config in a git work tree; two `init` runs at the same time can lose an index entry; `node add-child` accepts its own id.
- Next, the devflow implement gates at level lean: Validate (full suite and exit check under the machine lock, Node 24), Test against `.devflow/docs/evidence-fac-m2.md`, then the PR to `main`, CI, and the evidence verify. Then step 10: `/devflow:code-review` with the D-51 review of the six setup and upgrade files (§13a 5.8), `sh scripts/check-review-scope.sh` on the summary, and `/devflow:resolve`.
- Known for the report: CI on Linux is the first shellcheck and mawk run of the new sh scripts; `up --dry-run` runs `tmux has-session` (isolated in the exit check); a leftover temp folder from a failed run stays (Orchestrator decision: macOS removes it).
- Brief every subagent: no `python3` in any form, no `/tmp` (use the scratchpad), single test files only (only Validate runs the full suite, under the lock), Node 24 on PATH, Edit tool for edits.
