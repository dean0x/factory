# Resolution Summary

**Branch**: fac-m1-skeleton -> main
**Date**: 2026-11-01T14:22:14Z
**Review**: .devflow/docs/reviews/fac-m1-skeleton/2026-11-01_1608
**Command**: /resolve
**Gate level**: lean (Triage got the level; Polish skipped)

## Decisions Citations

- Owner decision (Dean, through the Orchestrator, 2026-11-01): `doctor` sends a network check only for a config from `--home` or from the current folder. For a config found in a parent folder, it skips the network checks with a warning, and it always prints the config path that it uses. — batch C, SEC-S2
- Lane decision: `upgrade` keeps the last 5 backups and removes older ones only after a successful upgrade. The backup copy leaves out `.factory/state/` and `.factory/locks/`, because `upgrade` never writes there. — batch A, REL-4
- Lane decision: a block rewrite in a file with CRLF line ends writes the block with LF line ends. The file stays valid and reads as intact. CRLF output is a follow-up candidate. — batch G, TST-9
- Design rule applied: authority comes only from the owner, through the owner channel (docs/design.md). — batch B, SEC-1

## Statistics
| Metric | Value |
|--------|-------|
| Total Issues | 26 |
| Fixed | 17 |
| False Positive | 0 |
| By Design | 1 |
| Deferred | 7 |
| Blocked | 0 |
| Escalated | 0 |
| Duplicates Collapsed | 1 |

_(One issue, SEC-S2, was escalated. The owner decided it, and it is fixed, so it counts in Fixed.)_

## Verification
| Command | Result |
|---------|--------|
| `npm run build` (node 24) | PASS |
| `tsc --noEmit` | PASS |
| lint (no lint script) | SKIPPED |
| `npm test` under the test lock: 16 files, 430 tests | PASS |
| `npm run exit-check` under the test lock (doctor: 11 ok, 0 warnings, 0 failures) | PASS |
| Snyk code scan of the repository | PASS: 2 Low findings, both local HTTP test servers in tests; accepted before; no new finding |

Validated head: 140c0bf246dfc23f6beba471dd245160ea679fab.

Regression tests added: 62 (368 tests before, 430 after)

Push: skipped (local only; no remote). CI gate, test-plan evidence and merge readiness: skipped (no PR).

Final gate: PASS

## Fixed Issues
| Issue | File:Line | Commit |
|-------|-----------|--------|
| [HIGH] The templates accepted owner authority from text with the owner prefix on any channel. Now only typed session input carries it. | src/templates/coordinator.ts:19, src/templates/protocol.ts:12 | 29c06c7 |
| [MEDIUM] The permission-mode check gave `ok` when it did not check. | src/commands/doctor.ts:157 | d2493a1 |
| [MEDIUM] The undo steps ignored their errors, and the message said that nothing changed. | src/commands/init.ts:311, src/commands/upgrade.ts:101 | ce54c4d |
| [MEDIUM] The init undo removed the whole created folder. | src/commands/init.ts:319 | 85dd53f, ce54c4d |
| [MEDIUM] `init` wrote CLAUDE.md in place. It now writes atomically. | src/commands/init.ts:345 | 85dd53f, ce54c4d |
| [MEDIUM] Backups had no limit. | src/upgrade/apply.ts:59 | c5a214a, eb927dd |
| [MEDIUM] The duplicate-project-id test passed for another reason. | test/unit/init.test.ts:361 | 140c0bf |
| [MEDIUM] The refusal tests checked only the failure signal. | test/integration/harness.ts:35 | 140c0bf |
| [MEDIUM] The restore-failure path and the init rename and commit failures had no test. | src/commands/upgrade.ts:102 | 8468c83, ce54c4d |
| [MEDIUM] The guard tests had no positive control. | test/unit/names.test.ts:109 | cf84a51 |
| [MEDIUM] Three full-length token literals stayed in the safety tests. | test/unit/safety.test.ts:12 | 8e40300 |
| [MEDIUM] A CRLF file read every block as edited. | src/blocks/managed.ts:79 | dc6e85e |
| [LOW] Config error text repeated config keys and YAML source text. | src/core/zod.ts:11, src/config/load.ts:18 | 7d5447a, 1b2bcc2, c8de104 |
| [LOW] The CI actions were pinned to tags. | .github/workflows/ci.yml:23 | 5783add |
| Text output did not replace control characters. | src/cli/output.ts:81 | ef39764 |
| `doctor` sent a network check for a config found in a parent folder. | src/core/home.ts:25, src/commands/doctor.ts:184 | d2493a1, c9d83a9 |
| The token check did not find Google API keys. | src/safety/secrets.ts:1 | 8e40300 |

Follow-through commits (no new issue): 748b630 merges the new atomic-write tests into `test/unit/node-deps.test.ts`; eb927dd moves the run-time folder paths into `Layout`; c9d83a9 updates README.md and docs/design.md for the `doctor` change.

## False Positives
| Issue | File:Line | Reasoning |
|-------|-----------|-----------|
| (none) | | |

## By Design
| Issue | File:Line | Rationale (decision/doc) |
|-------|-----------|--------------------------|
| The backup copy stops on a symlink, socket or FIFO. | src/core/node-deps.ts:44 | The comment at src/core/node-deps.ts:31-34 says that the copied tree holds only files and folders. The refusal keeps the backup inside the tree, and it runs before any write, so nothing changes. |

## Fix Separately
| Issue | File:Line | Reason | Tracked |
|-------|-----------|--------|---------|
| The JSON error document `factory.error/v1` has no test. | src/cli/run.ts:62 | severity tier: DEFER (lean) | local |
| The home search has no unit test of its own. | src/core/home.ts:10 | severity tier: DEFER (lean) | local |
| No test runs a state-changing upgrade with real git. | src/commands/upgrade.ts:124 | severity tier: DEFER (lean); `.factory/.gitignore` already lists `backups/` | local |
| No chain test for the real migration lists. | src/migrate/config.ts:4 | severity tier: DEFER (lean) | local |
| The older-version branches of `doctor` have no test. | src/commands/doctor.ts:92 | severity tier: DEFER (lean) | local |
| The internal state commits run the global git hooks of the user. | src/core/git.ts:71 | severity tier: DEFER (lean); a failing hook makes the command undo or stop | local |
| No lock stops two runs that write the same home. | src/commands/upgrade.ts:94 | severity tier: DEFER (lean); lanes come in FAC-M2 | local |

## Deferred to Tech Debt
| Issue | File:Line | Risk Factor |
|-------|-----------|-------------|
| (none) | | |

## Escalations
| Issue | File:Line | Security Concern |
|-------|-----------|-----------------|
| `doctor` sent a network check for a config found in a parent folder. | src/core/home.ts:25 | Needed an owner decision on the trust model. Decided: option A (see Decisions Citations). Fixed in d2493a1. |

## Blocked
| Issue | File:Line | Blocker |
|-------|-----------|---------|
| (none) | | |

## Duplicates
| Issue | Duplicate Of | File:Line |
|-------|-------------|-----------|
| No test shows that a parse error hides the file text. | SEC-3 | src/migrate/inspect.ts:63, src/config/load.ts:18 |
