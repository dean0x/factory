# Resolution Summary

**Branch**: fac-m2 -> main
**Date**: 2026-11-02T12:40:00Z
**Review**: .devflow/docs/reviews/fac-m2/2026-11-02_1004
**Command**: /resolve
**Gate level**: lean (Triage ran without the level line; Polish skipped by the lean row; the Orchestrator chose to fix all 38 items that Triage marked to fix now)

## Decisions Citations

- Owner decision (Dean, through the Orchestrator, 2026-11-02): fix all blocking, should-fix and suggestion items in this PR, in one round. B-01 migrates `factory.yaml` in place and keeps the comments and the key order of the owner.
- Owner decision (Dean, through the Orchestrator, 2026-11-02), SG-01: keep any proxy host for FAC-M2, state in the README that the proxy host receives the API traffic of the coordinator, and add a `doctor` warning for a host that is not loopback in FAC-M5.
- Owner decision D-60 (2026-11-02): design v3 makes the factory one folder that holds the coordinator folder and the projects. It replaces the FAC-M2 home placement code in a later PR. No item was skipped for it.

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 41 |
| Fixed | 38 |
| False Positive | 1 |
| By Design | 1 |
| Deferred | 0 |
| Blocked | 0 |
| Escalated | 1 |
| Duplicates Collapsed | 0 |

## Verification
| Command | Result |
|---------|--------|
| typecheck | PASS |
| build | PASS |
| full test suite (36 files, 1421 tests) | PASS |
| exit check | PASS |
| shellcheck | NOT RUN locally (CI runs it) |

Test plan: 5 stale after the fixes, 5 verified again; CI verifies all 9.

Regression tests added: each behavior fix has a test that failed first (see the batch reports).

Final gate: PASS

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| [HIGH] B-01 upgrade keeps the comments and key order of factory.yaml | src/upgrade/apply.ts:226 | 0bad822 |
| [MEDIUM] B-02 doctor sends no proxy request for a refused home | src/commands/doctor.ts:423 | f0d4ac5 |
| [MEDIUM] B-03 init runs every check that needs no clone before the first clone | src/commands/init.ts:497 | 8092bfa, b3b5e6d |
| [MEDIUM] B-04 doctor skips the user settings folder by real path | src/commands/doctor.ts:263 | 649e6aa |
| [MEDIUM] B-05 up keeps the session when the coordinator ends at once | src/commands/up.ts:204 | a8ecaa7 |
| [MEDIUM] B-06 up test checks the session environment through tmux | test/integration/up.test.ts:137 | 99e0049 |
| [MEDIUM] B-07 integration harness uses its own tmux server | test/integration/harness.ts:77 | 1d0750e |
| [MEDIUM] B-08 upgraded node text is checked; unchanged roadmap README replaced | test/integration/upgrade.test.ts:124 | 7ebc04d, 35bbf70 |
| [MEDIUM] B-09 init stops in a node home before any proposal | src/commands/init-home.ts:87 | 3cf9af8, fb8201e |
| [MEDIUM] B-10 upgrade stops with a remedy when a layer 1 node lists children | src/migrate/config.ts:78 | 8ca6cb0 |
| [MEDIUM] B-11 secrets check accepts a long file address | src/safety/secrets.ts:11 | d6de7c6 |
| [MEDIUM] B-12 upgrade warns when the home breaks the home rules | src/commands/upgrade.ts:40 | 99e5521 |
| [LOW] B-13 home index written with private modes; shared index refused | src/core/home-index.ts:107 | ec50281 |
| [LOW] B-14 reads stop at the size limit (bytes) | src/core/home-index.ts:87 | 9ff68f7 |
| [LOW] B-15 failed init removes the empty folders it made above a clone | src/commands/init-clone.ts:97 | a0fc24f |
| [LOW] B-16 home index lock; doctor warns when the home is not in the index | src/core/home-index.ts:109 | dab736b |
| [LOW] B-17 add-child refuses a child with the id of this node | src/commands/node.ts:134 | 720a2d2 |
| [LOW] B-18 init counts all projects before any clone | src/commands/init.ts:160 | 22dace7 |
| [LOW] B-19 nested ternary removed | src/commands/up.ts:294 | 4e1bb9c |
| [LOW] B-20 up tests decided by tmux state, not by a fixed wait | test/integration/up.test.ts:163 | d943715 |
| [LOW] B-21 exit code 2 for no node home stated in CHANGELOG and README | src/core/home.ts:59 | 82e36c6 |
| [LOW] B-22 glossary names the orders folder and marks features not built yet | src/glossary.ts:29 | 551cde9 |
| [MEDIUM] S-01 upgrade dry run runs the schema checks | src/commands/upgrade.ts:93 | 99e5521 |
| [MEDIUM] S-02 upgrade commits only its own files; refuses a dirty state repo | src/commands/upgrade.ts:114 | 6815552 |
| [LOW] S-03 backup copies a linked file; a failed backup is removed | src/upgrade/apply.ts:88 | 6c91e3d |
| [LOW] S-04 control characters replaced in errors, the init question and internal errors | src/cli/run.ts:27 | 6aab647, 6cd69f6 |
| [LOW] S-05 tokenizer test name says what it checks; TP-1 and TP-8 corrected | test/unit/names.test.ts:168 | d069946 |
| SG-02 state commits run with no git hook | src/core/git.ts:175 | f7dd291 |
| SG-03 project value with a colon in the user part refused | src/commands/init.ts:137 | 7f48626 |
| SG-05 test for a child on a layer that is too low | test/unit/node.test.ts:157 | 720a2d2 |
| SG-06 README and CHANGELOG match how init treats URL credentials | test/unit/init.test.ts:1212 | ce4e529 |
| SG-07 clone time limit has a clear message | src/core/git.ts:162 | 2d799f5 |
| SG-08 gone homes dropped when the index is full | src/core/home-index.ts:109 | 2197cdb |
| SG-09 second up says when the coordinator has ended | src/commands/up.ts:270 | d8eda25 |
| SG-10 upgrade JSON gives the old block name | src/commands/upgrade.ts:79 | 99e5521 |
| SG-11 upgrade records the home in the home index | src/commands/upgrade.ts | c9c60aa |
| SG-13 upgrade abort does not restore when the commit landed | src/commands/upgrade.ts:155 | 6815552 |
| SG-14 leftover staging folder named in the refusal | src/commands/init.ts:394 | c23d64e |

Extra fixes found during resolve: a tmux argument that ends in `;` is escaped (7b12554); the design states the FAC-M5 proxy warning (de68dee); docs for the upgrade commit, index and clone limit (68cc079).

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| SG-04 owner-authority tests miss the manager block | test/unit/templates.test.ts:185 | templates.test.ts:84-99 and 185-201 pin the same safety block for every role, including layer 2. |

## By Design
| Issue | File:Line | Rationale (decision/doc) |
|-------|-----------|--------------------------|
| SG-12 home lookup order | src/core/home.ts:44 | README.md:65-70 and the comment at home.ts:37-41 document the order; on the FACTORY_HOME path doctor sends no proxy request. |

## Fix Separately
None.

## Deferred to Tech Debt
None.

## Escalations
| Issue | File:Line | Security Concern |
|-------|-----------|-----------------|
| SG-01 any http or https proxy host is accepted | src/safety/proxy.ts:11 | The proxy host receives the coordinator's API traffic. Owner decision (via the Orchestrator): keep it for FAC-M2, state the risk in the README (4f98b4f), and add a doctor warning for a non-loopback host to FAC-M5 with a unit test (roadmap, trace row Gap 19, design §4.6). |

## Blocked
None.

## Duplicates
None.

## Intent check (after the resolve)

The intent check of PR #5 found two FAC-M2 asks that were not met and six small items. These changes close them:
- The package description says "sessions", and the names test and the exit check search `package.json` for the old words.
- The README says that the package is not published yet, and that merges and releases wait for the owner by default.
- The config refuses the tracker kind `desk`: factory has no review desk of its own (F-17).
- The docs check finds the word "lanes" as well as "lane".
- This file records the resolution in the repo.
- The lookup of the home from the folder that holds several repos moves to the design v3 PR, because D-60 replaces the home placement (`docs/intent-trace.md`).
- Dean answered the glossary question (D-59). The rename comes in the design v3 PR (`docs/roadmap-v2.md`).

## Replaced by design v3 (D-60)
No remaining item changed only the home placement rules, so none was skipped. These fixed items touch home placement and stay correct for the FAC-M2 rules that this PR ships; design v3 will replace that code: B-03 (part: the home-beside-projects checks), B-09, B-12, B-15, and the exit 4 for a parent node home (fb8201e).
