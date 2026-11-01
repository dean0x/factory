# FAC-M1 plan: the skeleton CLI

Status: active · Branch: `fac-m1-skeleton` · Design: `docs/design.md` · Date: 2026-11-01

## Goal and exit check
`factory init` and `factory doctor` work from a packed tarball. Config and state have schemas with a version, and a migration framework with tests.

Exit check (`scripts/exit-check.sh`):
1. `npm pack` into a temp folder.
2. `npm i -g <tgz>` with a throw-away HOME, `npm_config_prefix` and `npm_config_cache` in that temp folder. The real HOME is never used.
3. Make a temp git repo for a project. Run `factory init --home <tmp>/node --name demo --owner-name "Test Owner" --project <tmp>/web`.
4. Run `factory doctor --home <tmp>/node`. Both commands exit 0.
5. Search the generated files for the deny list (§6). A match fails the check.

## Scope
In: `init`, `doctor`, `upgrade`, `version`, `help`; the config and state schemas; the migration runner; managed blocks; the secret scan; the proxy URL check and health check; the templates; CI; the exit check.
Out (later milestones): board, wait, decide, page (FAC-M2); lanes, tmux, launch, heartbeat hook (FAC-M3); GitHub commands (FAC-M4); packs (FAC-M5). `init` has no `--pack` flag yet.

One PR. There is no split: every part is needed for the exit check.

## 1. Package
- `package.json`: name `@dean0x/factory`, version `0.1.0`, `bin: { factory: "dist/factory.js" }`, `type: module`, `engines.node >=22`, license MIT, `files: ["dist/factory.js", "LICENSE", "README.md", "CHANGELOG.md"]`.
- **No runtime dependencies.** esbuild bundles everything into `dist/factory.js` (from mars: one file for a release). So `npm i -g <tgz>` needs no network.
- Dev dependencies: `typescript`, `@types/node`, `vitest`, `esbuild`, `zod`, `yaml`.
- The version lives only in `package.json`. The build injects it with esbuild `define` (`__FACTORY_VERSION__`).
- Scripts: `build` (`node build.mjs`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:unit`, `test:integration` (needs the build), `exit-check` (`bash scripts/exit-check.sh`).
- `tsconfig.json`: like devflow (ES2022, strict), plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`, `module`/`moduleResolution` `NodeNext`.

## 2. Source layout

```
src/
  main.ts                 entry: argv → command table → exit code; the only place with process.exit
  cli/table.ts            the command table: name, summary, flags (node:util parseArgs config), run
  cli/output.ts           TTY-aware text output, --json, --quiet, --no-color, ASCII fallback (from mars ui.sh)
  cli/errors.ts           CliError kinds → exit codes
  core/result.ts          Result<T, E> = { ok: true, value } | { ok: false, error }; helpers
  core/deps.ts            Deps interface: fs, run (spawn with args, no shell), env, fetch, now, platform, cwd
  core/node-deps.ts       the real Deps; the only module that imports node:fs/child_process
  core/home.ts            find the node home: --home, else walk up from cwd to factory.yaml (mars config.sh)
  config/schema.ts        Zod schema of factory.yaml, schema 1
  config/load.ts          read → YAML parse → version check → migrate check → Zod parse
  config/render.ts        factory.yaml text with comments, from a typed config
  state/schema.ts         Zod schema of .factory/node.json, schema_version 1
  state/layout.ts         every path inside a node home, from one function
  state/files.ts          initial board.json, waiting.json, decision-log.json
  migrate/runner.ts       generic chain runner (§5)
  migrate/config.ts       the config migration list (empty at schema 1)
  migrate/state.ts        the state migration list (empty at schema_version 1)
  blocks/managed.ts       render, parse and verify managed blocks (§4)
  templates/*.ts          template text as exported strings (§6)
  safety/secrets.ts       token-like value scan
  safety/proxy.ts         proxy URL rules, redaction, health check
  commands/init.ts
  commands/doctor.ts      runs checks; each check is a pure function over Deps
  commands/upgrade.ts
  commands/version.ts
test/
  unit/*.test.ts          schema, migrations, blocks, secrets, proxy, home, each doctor check (fake Deps)
  integration/*.test.ts   black-box runs of dist/factory.js in temp folders (from mars test_integration.sh)
scripts/exit-check.sh
build.mjs
.github/workflows/ci.yml
```

Rules for the code (Dean's engineering rules):
- No throw in logic. Every fallible function returns a `Result`. `main.ts` maps errors to exit codes.
- Parse at the boundary: YAML and JSON go through Zod once, then the types are trusted.
- All I/O goes through `Deps`, so every command has unit tests with a fake.
- `run` never uses a shell: it takes a command and an argument array.
- Every loop and wait has a fixed bound. The walk up stops at the file-system root or after 64 levels.
- No reads under `~/.claude`.

## 3. Commands

| Command | Flags | Result |
|---|---|---|
| `factory init` | `--home DIR` (default cwd), `--name ID`, `--owner-name N`, `--owner-github LOGIN`, `--project PATH` (repeatable) | Writes a node (§6). Refuses when `factory.yaml` exists in the home or in a parent folder. |
| `factory doctor` | `--home DIR` | Runs the checks of §7. Exit 0 when no check fails (warnings allowed), else 1. |
| `factory upgrade` | `--home DIR`, `--dry-run`, `--overwrite NAME` (repeatable) | Migrates config and state, and refreshes managed blocks (§5). |
| `factory version` / `--version` | — | Prints the version. |
| `factory help` / `--help` / no args | — | Help from the command table. Unknown command: help to stderr, exit 2. |

Global flags: `--json`, `--quiet`, `--no-color`. `--home` is a flag of each command that needs a node.
Exit codes: 0 success; 1 failure; 2 usage error; 3 not ready (unused in FAC-M1); 4 safety refusal.
`--json` output has a `schema` field, for example `factory.doctor/v1`.

`init` takes no interactive input. Each default comes from a flag or from the system:
- `--name`: else the home folder name, made into a slug (`^[a-z0-9][a-z0-9-]{0,39}$`).
- `--owner-name`: else `git config user.name`, else the command fails and names the flag.
- `--owner-github`: else `gh api user --jq .login` if `gh` exists, else unset.
- For each project: the path must be a git work tree. `id` is the folder name as a slug. `repo` comes from the `origin` URL when it is a GitHub URL, else unset. `default_branch` comes from `origin/HEAD`, else the current branch, else `main`. `path` is stored relative to the home.

## 4. Managed blocks
Form:
```
<!-- factory:begin <name> v<n> sha256=<hex of body> -->
<body>
<!-- factory:end <name> -->
```
- `render(name, version, body)`, `parse(text)` → blocks with position, and `verify(block)` → intact or edited.
- `init` writes the blocks into `CLAUDE.md` and `.factory/protocol.md`. If `CLAUDE.md` exists, `init` keeps its text and adds the blocks at the end.
- `upgrade` rewrites a block when the template version is newer and the block is intact. It refuses on an edited block, shows the diff in short, and needs `--overwrite <name>` to replace it.
- `.factory/node.json` records each block's name and version.

## 5. Schemas and migrations

**`factory.yaml`, schema 1.** The keys are those of design §4.4. Every object is strict: an unknown key is an error.
- `schema: 1`.
- `node`: `id` (slug), `role` (`coordinator`).
- `owner`: `display` (1–80 chars), optional `github` (GitHub login form), `prefix` (it must contain `{owner}`).
- `session`: `permission_mode` (the literal `auto`), `effort` (`low|medium|high|xhigh|max`), `model` (string), `proxy` (`none` or a proxy id).
- `proxies[]`: `id` (slug), `base_url`, `health` (a path that starts with `/`), `on_fail` (`stop|direct`, default `stop`).
  - `base_url` is `http` or `https`, with no user info, no query and no fragment.
- `lanes`: a map from lane id to `{ proxy }`.
- `limits`: `memory_free_min_pct` (0–90), `disk_free_min_gb` (0–10000), `load_max` (`cpu_count` or a number), `context_prepare_pct` and `context_max_pct` (1–100, prepare < max).
- `projects[]`: `id`, `repo` (optional, `owner/name`), `path` (relative, no `..` that leaves the home's parent), `default_branch`, `merge_method` (`squash|merge|rebase`), `pack` (`plain` only in FAC-M1), `gate.checks` (string list), optional `heavy_test`.
- `children[]`: empty in FAC-M1 (the schema accepts `{ id, address }` for FAC-M7).
- Cross checks: ids are unique; each `proxy` reference names a defined proxy.

**`.factory/node.json`, schema_version 1:** `{ schema_version, created_with, blocks: { <name>: <version> } }`.
Identity, owner, parent and children live only in `factory.yaml`, so they are not stored twice. This refines design §4.3.

**Migration runner** (`migrate/runner.ts`):
- A migration is `{ from: n, to: n + 1, apply(raw: unknown): Result<unknown> }`, a pure function.
- `plan(current, target, list)` checks that the chain has no gap, and returns the steps.
- `run(raw, steps)` applies them in order and stops at the first error.
- A version newer than the CLI supports is an error that says "upgrade factory".
- An older version in `doctor` is an error that says "run factory upgrade". Normal commands refuse to run on an old version.
- `upgrade` does: plan → print (`--dry-run` stops here) → back up `factory.yaml` and `.factory/` to `.factory/backups/<timestamp>/` (excluding `backups/`) → migrate → validate every file → write → commit in the state repo. On any error it restores the backup and exits 1.
- The lists are empty at version 1. The tests use fixture lists (1→2→3, a gap, a failure in the middle, a newer version).

## 6. What `init` writes

```
<home>/factory.yaml
<home>/CLAUDE.md                       managed blocks: coordinator, safety
<home>/.factory/node.json
<home>/.factory/protocol.md            managed block: protocol
<home>/.factory/board.json             { "merge": [], "items": [] }
<home>/.factory/waiting.json           { "intro": "", "groups": [], "items": [] }
<home>/.factory/decision-log.json      { "rows": [] }
<home>/.factory/decision-profile/README-format.md, index.md
<home>/.factory/roadmaps/README.md
<home>/.factory/briefs/.gitkeep
<home>/.factory/.gitignore             state/ locks/ backups/
```
- **Atomic:** `init` writes into `<home>/.factory.tmp-<pid>/`, then renames it to `.factory/`, and writes `factory.yaml` and `CLAUDE.md` last. On an error it removes the temp folder and changes nothing else (from firstmate's seeding with rollback).
- **State repo:** `git init` in `.factory/`. When the user has a git identity, `init` makes the first commit. Else it prints a warning, and `doctor` repeats it.
- **Templates.** These are generic texts made from the current setup:
  - `coordinator`: the role (coordinate, delegate, verify claims on the primary source), the owner-authority prefix, merges and releases wait for the owner's go, and the state files with relative paths.
  - `safety`: the rules of design §6, including the proxy rule.
  - `protocol`: the lane protocol (escalation, milestones, denial is final, context budget in percent, heavy-test lock, disk, writing style), with no devflow-specific rules.
  - `decision-profile/README-format.md`: the format, with no content.
  - `roadmaps/README.md`: the roadmap format.
- **Deny list:** no template or generated file contains `dean`, `Dean`, `dean0x`, `/Users/`, `Sandbox`, `devflow`, `Subswitch`, a machine size, or a session id. A unit test checks every template. The exit check checks the generated files. The owner's own name comes only from the flags or from git.

## 7. Doctor checks (FAC-M1)
Each check has an id, a level (`ok`, `warn`, `fail`) and one line of text. No check prints a value from the environment or a secret.

| id | Fail when | Warn when |
|---|---|---|
| `config` | `factory.yaml` is missing, does not parse or does not validate | — |
| `config-version` | schema is newer than supported, or older (needs upgrade) | — |
| `state` | `node.json` is missing or invalid, or its version needs an upgrade | — |
| `blocks` | — | a managed block is missing or edited by hand |
| `secrets` | a config value looks like a token (`sk-ant-`, `ghp_`, `gho_`, `github_pat_`, `xox[abp]-`, `AKIA`, a 40+ char base64 or hex string) | — |
| `permission-mode` | a `.claude/settings*.json` in the home sets `bypassPermissions` or a skip flag | — |
| `proxy-env` | — | `ANTHROPIC_BASE_URL` is set in the shell (factory clears it at launch; the name only, never the value) |
| `proxy:<id>` | a proxy in use with `on_fail: stop` does not answer its health path | it does not answer and `on_fail: direct` |
| `tools` | Node is older than 22 | `git`, `tmux`, `gh` or `claude` is missing (names the later commands that need it) |
| `state-repo` | `.factory` is not a git repo | no commit yet, or no git identity |
| `projects` | a project path is not a git work tree | — |

The health check sends one GET with a 3-second limit (`AbortSignal.timeout`), and treats any HTTP answer below 500 as up. The output shows only the proxy id and `host:port`.

## 8. CI (`.github/workflows/ci.yml`)
- Triggers: push to `main`, pull requests to `main`.
- Matrix: `ubuntu-latest` and `macos-latest`, Node 22.
- Steps: checkout, setup-node with npm cache, `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run test:integration`, `npm run exit-check`.
- A ubuntu-only step runs `shellcheck scripts/*.sh`.
- Until the repo exists, I run the same steps locally. The full test run goes under the heavy-test lock.

## 9. Tests
- **Unit** (fake `Deps`): config schema (valid, each invalid key, strictness, cross checks, the proxy URL rules); state schema; migration runner (chain, gap, failure, newer); managed blocks (render and parse round trip, edit detection, keep owner text); secret scan (true and false matches); proxy redaction and health check (a local `node:http` server: up, 500, no answer); home walk-up; init plan; each doctor check; the template deny list.
- **Integration** (built `dist/factory.js`, temp folders, `HOME` set to a temp folder):
  - `init` then `doctor` exit 0, and `init` twice refuses;
  - `doctor --json` has the schema field;
  - an edited block gives a warning, and `upgrade` refuses it without `--overwrite`;
  - a bad config gives exit 1 with the key name;
  - an unknown command gives exit 2.
- **Exit check:** the steps under "Goal and exit check", also in CI.

## 10. Steps (small local commits on `fac-m1-skeleton`)
1. Package, tsconfig, build, vitest config, Result, Deps, `main.ts`, command table, `version` and `help`.
2. Config schema, load and render, with tests.
3. State schema, migration runner, with tests.
4. Managed blocks, templates and the deny-list test.
5. `init`, with unit and integration tests.
6. Safety: secrets and proxy. Then `doctor`, with tests.
7. `upgrade`, with tests.
8. CI workflow, `exit-check.sh`, README, CHANGELOG, LICENSE.
9. A full local run of the CI steps under the lock. A Snyk code scan.
10. The review and resolve cycle. The summaries go in `docs/reviews/`.

## 11. Risks
- **Template text grows too large.** Keep each block short. FAC-M2 and FAC-M3 add text when the commands that need it exist.
- **`npm i -g` with a temp HOME writes outside the temp folder.** Set `npm_config_prefix`, `npm_config_cache` and `npm_config_userconfig` to temp paths. Check that nothing changes in the real HOME, by an mtime list of `~/.npm` and the global prefix before and after.
- **The macOS runner has a different `git` default branch or no `tmux`.** The tests set `init.defaultBranch`, and a missing tool is only a warning.
