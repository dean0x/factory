# Code Review Summary

**Branch**: fac-m1-skeleton -> main
**Date**: 2026-11-01_1608
**Gate level**: lean — **Focuses**: security, testing, reliability

## Merge Recommendation: CHANGES REQUESTED

The review found one HIGH issue in the Blocking category (Issue 1). The Merge Rules require changes for any HIGH issue in the Blocking category. The review found no CRITICAL issue. The security focus has a report.

The diff runs from base 8bda4f9 to head bd73d29. It contains 77 files. All 77 files are new in this branch. So every finding is in the Blocking category. The review found no Should Fix issue and no Pre-existing issue.

Fix Issue 1 first. Fix the other Blocking issues in the same cycle. Then run the next review cycle.

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 1 | 14 | 2 | 17 |
| Should Fix | - | 0 | 0 | - | 0 |
| Pre-existing | - | - | 0 | 0 | 0 |

## Blocking Issues

Each issue gives its location, its confidence and its source focus. The agent reports give the full text and the code samples:
- /Users/dean/Sandbox/factory/.devflow/docs/reviews/fac-m1-skeleton/2026-11-01_1608/security.md
- /Users/dean/Sandbox/factory/.devflow/docs/reviews/fac-m1-skeleton/2026-11-01_1608/reliability.md
- /Users/dean/Sandbox/factory/.devflow/docs/reviews/fac-m1-skeleton/2026-11-01_1608/testing.md

### HIGH

**Issue 1. The owner authority comes from a text prefix.**
- Location: `src/templates/coordinator.ts:19`, `src/templates/protocol.ts:12`
- Confidence: 80%. Source: security.
- Problem: The coordinator rule gives owner authority to any input that starts with the owner prefix. The rule does not say which channel must carry the prefix. The coordinator reads text from pull requests, issues, review comments and CI logs. Such text can claim owner authority for a merge or a release. The lane protocol at `protocol.ts:12` has the same gap for coordinator answers.
- Fix: Accept the prefix only in the typed input of the session. Add this rule to the Authority section and to the `safety` block. In `protocol.ts:12`, accept a coordinator message only when it comes from the coordinator session. Add a template unit test for these lines.

### MEDIUM

**Issue 2. The permission-mode check returns `ok` when it did not check.**
- Location: `src/commands/doctor.ts:157`, `:160`, `:168`. Related test: `test/unit/doctor.test.ts:236`.
- Confidence: 82%. Source: security.
- Problem: The check returns `ok` in three cases where it did not check the setting. At line 157, the node home is the user home, and the check reads nothing. At line 160, every list error returns `ok`, including EACCES and ENOTDIR. At line 168, an unreadable settings file is skipped without a message.
- Fix: At line 157, return the `notChecked` result. At line 160, return `ok` only when the settings folder does not exist. For any other error, return `warn`. At line 168, return `warn` and name the unreadable files. Change the test at line 236 to expect `warn`.

**Issue 3. The undo steps ignore their errors, and the message says that the files are clean.**
- Location: `src/commands/init.ts:311-321`, `src/commands/upgrade.ts:101`
- Confidence: 90%. Source: reliability.
- Problem: The init undo ignores the result of each `remove` and `writeText` call. The message always adds "(nothing was changed)". In `upgrade`, `abort` ignores the result of `unstageAll`. If `git reset` fails, the index keeps the staged upgrade content. The message still says "The files are as they were".
- Fix: Collect the failed undo steps, as `restore` in `src/upgrade/apply.ts:84-92` already does. Say "nothing was changed" only when no step failed. Otherwise, name each path that is not restored. Add one test for each case, with a fake `Fs` that fails the undo write.

**Issue 4. The init undo removes the whole created folder, including files from other writers.**
- Location: `src/commands/init.ts:319`, which calls `rm -rf` through `src/core/node-deps.ts:64`
- Confidence: 80%. Source: reliability.
- Problem: `planInit` sets `createdRoot` when the home does not exist. After a later failure, the undo removes `createdRoot` with `rm -rf`. The undo does not check that the folder holds only files of this run. For example, two `init` runs start for the same new home. Run A finishes. Run B fails at the rename of its staging folder. The undo of run B then removes the home, with the files of run A in it.
- Fix: Remove only the paths that this run created. These are the staging folder, and the state folder, CLAUDE.md and the config file when `touched` says so. Then remove the created folders up to `createdRoot` with a non-recursive `rmdir`. Add a `removeEmptyDir` method to `Fs`.

**Issue 5. `init` writes CLAUDE.md directly and keeps the old text only in memory.**
- Location: `src/commands/init.ts:345`, the write through `src/core/node-deps.ts:51`
- Confidence: 80%. Source: reliability.
- Problem: `writeText` calls `writeFile`. This call first empties the file, then writes the new text. `init` makes no backup of CLAUDE.md. If the process stops between these two steps, the user text is lost. Causes include Ctrl+C, SIGKILL, a crash and a power loss. The plan makes the state folder atomic with a rename. CLAUDE.md has no such protection.
- Fix: Add an atomic write method to `Fs`. Write the text to a temporary file in the same folder. Then rename the file over the target. Use this method for CLAUDE.md and the config file in `applyInit`. Also use it in `writeAll` and `restore`.

**Issue 6. Backups have no limit.**
- Location: `src/upgrade/apply.ts:59-81`
- Confidence: 85%. Source: reliability.
- Problem: Each upgrade that changes a file makes a full copy in `.factory/backups/<timestamp>/`. The copy includes `.factory/.git`, `.factory/state/` and `.factory/locks/`. No code removes old backups. Disk use grows with each upgrade. The README does not state a limit.
- Fix: Keep the last N backups, for example 5. Remove the older backups after a successful upgrade. Skip `.factory/state/` and `.factory/locks/`, because they hold runtime data. Optionally skip `.git` too. State the limit in `README.md`.

**Issue 7. The duplicate-project-id test passes for a different reason.**
- Location: `test/unit/init.test.ts:361-365`
- Confidence: 90%. Source: testing.
- Problem: The test gives the projects `/w/web` and `/other/web` to a home at `/w/node`. The second project path becomes `../../other/web`. The path rule at `src/config/schema.ts:33-38` rejects that path first. The test asserts only `result.ok === false`. If the duplicate-id check at `src/config/schema.ts:156` is removed, the test still passes.
- Fix: Put both projects at the same depth, for example `/w/web` and `/w/other/web`. Assert the message `projects.1.id: duplicate id`.

**Issue 8. The refusal tests check the failure signal, not its cause.**
- Location: `test/integration/upgrade.test.ts:73-76`, `test/integration/doctor.test.ts:82-90`, `test/integration/harness.ts:35`, `test/unit/init.test.ts:178-182`, `test/unit/doctor.test.ts:458-463`
- Confidence: 85%. Source: testing.
- Problem: These tests assert only exit code 1 or `ok: false`. A crash of the binary also gives exit code 1. The harness maps a spawn error, a timeout and a signal to code 1 at `harness.ts:35`. So these tests pass when the binary crashes. The secret case in `doctor` also passes when no check runs.
- Fix: In the harness, map a non-numeric error code to a value that no test expects, for example -1. Assert the cause next to the code. For example, assert that the `doctor` output contains the `secrets` note text, that the upgrade error text contains `--home DIR`, and that the init message contains `is not a folder`.

**Issue 9. The CRLF test does not check the verdict.**
- Location: `test/unit/blocks.test.ts:65-69`, `src/blocks/managed.ts:79`
- Confidence: 80%. Source: testing.
- Problem: The test asserts only `parsed.ok`. The parser keeps the carriage return at the end of each body line. So a CLAUDE.md with CRLF line ends gives the verdict `edited` for every block. `doctor` then warns about every block, and `upgrade` refuses every block.
- Fix: Recommended: treat CRLF line ends as intact. Strip the carriage return from each body line in `parseBlocks`. Then assert the `intact` verdict. If CRLF must count as edited, assert `edited` and rename the test.

**Issue 10. The restore-failure path of `upgrade` has no test.**
- Location: `src/commands/upgrade.ts:102-106`, `src/upgrade/apply.ts:84-92`. The init paths at `src/commands/init.ts:337-338` and `:341-342` also have no test.
- Confidence: 85%. Source: testing.
- Problem: When a restore write fails, the message must name the number of files that are not restored, and the backup folder. No test reaches this branch. The init undo has no test for a failed first commit or a failed rename of the staging folder.
- Fix: Add a test where `writeText` fails for `NODE_JSON`, then fails again for `CLAUDE` during the restore. Assert that the message names the file count and the backup path. Add an init test where the rename fails, and assert that the snapshot is unchanged. Write this test after Issue 3 is fixed, because it checks the corrected message.

**Issue 11. The JSON error document has no test.**
- Location: `src/cli/run.ts:62-64`
- Confidence: 85%. Source: testing.
- Problem: With `--json`, a failed command prints a `factory.error/v1` document on stdout. Scripts read this document. No test checks it. A change of its shape, or of the output stream, would not be seen.
- Fix: Add a test that runs `upgrade` with an invalid `--overwrite` value and `--json`. Assert exit code 2, the schema name `factory.error/v1`, and the `usage` error kind.

**Issue 12. The search for the home folder has no unit test.**
- Location: `src/core/home.ts:10-36`
- Confidence: 80%. Source: testing.
- Problem: No test calls `findNearestConfig` or `resolveHome` directly. These cases have no test: a child node inside the folder of a parent node; the 64-level bound; a folder named `factory.yaml`; a relative `--home`.
- Fix: Add `test/unit/home.test.ts` with the fake `Deps`. Seed `/w/factory.yaml` and `/w/node/factory.yaml`, and set the working folder to `/w/node/deep`. Assert that `resolveHome` returns `/w/node`.

**Issue 13. No test runs a state-changing upgrade with real git.**
- Location: `src/commands/upgrade.ts:124-128`, `test/integration/upgrade.test.ts`
- Confidence: 80%. Source: testing.
- Problem: The unit tests use a fake git handler. That handler does not model `.gitignore`. No test shows that the real commit holds the changed state file and not the backup folder. The backup folder lies inside the state repository. Only the `backups/` line of `.factory/.gitignore` keeps it out of `git add -A`. The integration tests change only CLAUDE.md, so they never commit.
- Fix: Add one integration test. Edit the protocol block in `.factory/protocol.md`. Run `upgrade --overwrite protocol`. Assert these results: exit code 0, a new commit `chore: upgrade the state` in `.factory`, a clean `git status --porcelain`, and no `backups/` path in `git show --name-only HEAD`.

**Issue 14. The guard tests have no positive control.**
- Location: `test/unit/names.test.ts:109-119`, `test/helpers/deny-list.ts:13-14`
- Confidence: 80%. Source: testing.
- Problem: The names guard and the deny-list tests assert an empty result. They also pass when the detector finds nothing. An empty source list, an empty name set or a broken pattern keeps them green.
- Fix: Add one positive case for each guard. Assert that the source list has more than 20 files. Assert that a known name literal is found. Assert that the deny list matches a known sample text.

**Issue 15. Three full-length token literals remain in the safety tests.**
- Location: `test/unit/safety.test.ts:12`, `:13`, `:21`
- Confidence: 82%. Source: testing.
- Problem: Lines 12, 13 and 21 of the `looksLikeToken` table contain full-length token literals. A secret scanner on push can flag these lines. An earlier commit replaced four such literals with run-time values, but these three remain.
- Fix: Build these values at run time, as the helper `FAKE_GITHUB_TOKEN` does. Do not write a full token literal in the source.

### LOW

**Issue 16. Config error text repeats config keys and YAML source text.**
- Location: `src/core/zod.ts:11-12`, `src/config/load.ts:18`, and the comment at `src/migrate/inspect.ts:63`
- Confidence: 90% (80% from security, plus 10% because the testing report flags the same line `src/config/load.ts:18`).
- Sources: security, testing.
- Problem: The helper `findTokenPaths` hides a key that looks like a token. The `config` check does not hide such keys. Zod puts raw record keys in the issue path. Some `yaml` parse errors contain source text. `doctor` prints this text, and `--json` puts it in `checks[].text`. The comments at `zod.ts:9` and in `src/migrate/inspect.ts` say that error text never repeats the input. Those comments are false. No test covers a parse error that contains source text.
- Fix: Send each key-path segment through one helper. The helper replaces a token-like segment with `<key>`. For YAML errors, print only the error code and the line number. Add a test for a parse error that contains source text. Correct the two comments.

**Issue 17. The CI actions are pinned to tags, not to full commit hashes.**
- Location: `.github/workflows/ci.yml:23`, `:26`
- Confidence: 85%. Source: security.
- Problem: `actions/checkout@v4` and `actions/setup-node@v4` are tags. A tag can move to new code, so CI can run code that was not reviewed. The impact is low now. The token is read-only, and the workflow uses no secrets. The impact grows when a release job with a package token is added.
- Fix: Pin each action to its full commit hash. Keep the tag in a comment. Let Dependabot update the pins.

## Suggestions (Lower Confidence)

1. `src/core/git.ts:71` (75%, reliability). The internal state commits run the global git hooks of the user. A hook that rejects the commit, or that runs longer than the 15-second limit, makes `init` undo its work and makes `upgrade` stop. Consider skipping hooks for this internal commit.
2. `src/cli/output.ts:81` (70%, security). Text output does not remove control characters. A planted `factory.yaml` can send terminal escape sequences through `projects[].path` (`src/config/schema.ts:33`). `doctor` prints that value at `src/commands/doctor.ts:260`.
3. `src/migrate/config.ts:4`, `src/migrate/state.ts:4` (70%, testing). No test checks that the real migration lists form a complete chain up to the current version.
4. `src/commands/doctor.ts:61`, `:92-94`, `:114-116` (70%, testing). No test covers the branches for an older config version or an older state version.
5. `src/core/home.ts:25`, `src/commands/doctor.ts:184` (65%, security). Without `--home`, `doctor` uses the nearest `factory.yaml` up to 64 levels above the folder. It then sends a GET request to a URL from that file. In an untrusted folder tree, another party chooses the URL.

## Action Plan

1. Fix Issue 1. Add the channel rule to both templates and to the `safety` block. Add the template unit test. This fix clears the HIGH issue, which blocks the merge.
2. Fix Issue 2. Make the check return `warn` when it did not check. Update the test at `test/unit/doctor.test.ts:236`.
3. Fix Issues 3 and 4 together. Collect the undo failures. Remove only the paths that this run created.
4. Fix Issue 5. Add the atomic write method and the `removeEmptyDir` method to `Fs` in one change, because both change the same interface.
5. Repair the weak tests: Issues 7, 8, 9 and 14. Remove the three token literals: Issue 15. Issue 8 also needs the harness change.
6. Add the undo and restore-failure tests: Issue 10. Write them after step 3.
7. Fix Issue 6. Add a backup limit, skip the runtime folders, and state the limit in `README.md`.
8. Add the missing tests: Issues 11, 12 and 13.
9. Fix Issues 16 and 17. Both are LOW, and both are small.
10. Run the next review cycle after these fixes.

## Convergence Status
**Cycle**: 1
**Prior Resolution**: none
**Prior FP Ratio**: N/A
**Assessment**: First cycle
