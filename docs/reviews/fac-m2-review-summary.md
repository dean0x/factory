# Code Review Summary

**Branch**: fac-m2 -> main (PR #5)
**Range**: f2aa733 to 928af07
**Date**: 2026-11-02
**Cycle**: 1
**Gate level**: lean. **Focus areas**: security, testing, reliability, regression, setup and upgrade.
**Status**: resolved. All blocking findings are fixed. The resolution is in `docs/reviews/fac-m2-resolution-summary.md`.

## Merge Recommendation: CHANGES REQUESTED

This recommendation was for the reviewed range. It asked for a fix of the 22 blocking findings before the merge.

Finding B-01 is the only HIGH finding. The upgrade removes comments from the file factory.yaml.

Three reviews gave the verdict "approved with conditions." Each condition is a blocking finding. This summary does not give approval.

Fix B-01 first. Fix the other blocking findings in the same cycle. Then run the next review cycle.

## Issue Summary

| Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|----------|----------|------|--------|-----|-------|
| Blocking | 0 | 1 | 11 | 10 | 22 |
| Should Fix | - | 0 | 2 | 3 | 5 |
| Pre-existing | - | - | 0 | 0 | 0 |

There are 14 suggestions. They have lower confidence and no severity.

The five reviews listed 44 items. Three items were duplicates. This summary lists each unique finding once.

## Blocking Issues

Each finding gives its location, its confidence and its sources. Each finding also gives its effect and its fix.

### HIGH

**B-01. The upgrade removes comments from factory.yaml.**
- Location: src/upgrade/apply.ts:226; src/upgrade/spec.ts:67
- Confidence: 95%. Source: regression review. The effect was reproduced.
- Effect: The upgrade writes factory.yaml again from typed values. Comments, blank lines and the key order are removed. The plan and the success message do not say so. Only the backup keeps the comments. Old backups are removed after five upgrades.
- Fix: Change the YAML document, as src/config/edit.ts does. Check the text with parseConfigText before the write. If the full rewrite stays, add a warning line to the plan. Describe the rewrite in the README and in the CHANGELOG.
- Note: The setup and upgrade review found no finding in src/upgrade/spec.ts. That review did not test comment preservation.

### MEDIUM

**B-02. doctor sends the proxy request for a config in a git work tree.**
- Location: src/commands/doctor.ts:417-423 (line 423 in the security review)
- Confidence: 85%. Sources: security review; setup and upgrade review; open item (e).
- Effect: For a factory.yaml in a git work tree, doctor sends one GET request. The host and the path come from that file. The request has no credential and follows no redirect. The host learns that the command ran. The up command refuses the same home.
- Fix: Run checkHomeLocation first. Send the request only when the source is a flag or the current folder, and the location check passes. Reuse the result in checkHome. Add a test that asserts no fetch call. Update section 6, line 697, of the design document.

**B-03. init clones before it runs the cheap checks.**
- Location: src/commands/init.ts:497-513
- Confidence: 90%. Source: setup and upgrade review. The security review found no security effect.
- Effect: With --project and a URL, each clone can take up to five minutes. The undo then removes the clone. These checks run after the clones: --name, --owner-github, existing factory.yaml or .factory, CLAUDE.md blocks, and a repo one level down. The code rule says that a bad value must fail before any clone.
- Fix: Move these checks before runClones. Keep describeProjects and checkHomeApart after the clones. Add one test for each moved check. Each test asserts that no clone runs.

**B-04. doctor reads the Claude Code settings folder in some cases.**
- Location: src/commands/doctor.ts:263-269
- Confidence: 85%. Source: setup and upgrade review.
- Effect: checkPermissionMode skips the user folder only on an exact text match. It does not handle links or letter case on macOS. In these cases doctor lists and reads the settings*.json files in that folder. The design says that factory does not read files in that folder.
- Fix: Create one helper in src/core/paths.ts. It compares real paths and ignores letter case on macOS, as indexPathOf does (src/core/home-index.ts:56-79). Use the helper in both places. Add tests with a linked .claude folder and with a different letter case.

**B-05. up reports an ended session as a session that stays.**
- Location: src/commands/up.ts:204-216; src/launch/tmux.ts:56-58
- Confidence: 85%. Sources: reliability review; open item (d).
- Effect: If the launch ends before remain-on-exit is set, tmux removes the session. The message then says that the session stays. It gives a kill command for a session that does not exist. The reason for the exit is not shown.
- Fix: Check the session with has-session before the message is chosen. Start claude by its absolute path, as found by the PATH search. Or give env the PATH of this process. Optionally, set remain-on-exit in the same tmux call as new-session. Check this on tmux 3.0. Add a test for a session that ends by itself.
- Note: The PATH case was found by reading the code. It was not run.

**B-06. The session environment test cannot show a failed step.**
- Location: test/integration/up.test.ts:137
- Confidence: 85%. Source: testing review.
- Effect: The test checks only the coordinator pane. That pane unsets the variable itself. The test passes when the session environment step fails or is removed. A variable in other panes or windows is not found.
- Fix: After waitForLaunch, read show-environment for ANTHROPIC_BASE_URL on the real server. Expect the removal marker. Optionally, run env in a new window of the session. Check its output, with a fixed time limit.

**B-07. The integration harness does not isolate tmux.**
- Location: test/integration/harness.ts:77-87; test/integration/home-index.test.ts:64
- Confidence: 85%. Source: testing review.
- Effect: The harness does not set TMUX_TMPDIR. The dry-run test asks the default tmux server of the machine about a session. The result depends on the machine. The test checks only the exit code, the empty error output and the words "Dry run". So it passes in both cases.
- Fix: Set TMUX_TMPDIR in the harness environment to a folder in the test root. Create the folder. Use the same setting in test/integration/up.test.ts.

**B-08. The upgrade test does not check the text of the files.**
- Location: test/integration/upgrade.test.ts:124
- Confidence: 80%. Source: testing review.
- Effect: The test checks keys, file moves, versions, git status and the doctor exit code. It does not check text. The fixture file .factory/roadmaps/README.md keeps the old word "lane" four times after the upgrade. The upgrade does not change that file. New track roadmaps copy the old word. The body of the renamed worker block is not checked.
- Fix: After the upgrade, scan every node file, except .git and backups, with the old-word pattern from test/unit/names.test.ts. Check that roles/worker.md holds the current worker block body. Then either replace the README if it holds the 0.1.0 text. Or record the README as owner text in the test and the docs.
- Note: The regression review found that the code gives the renamed block its new body. This finding is a gap in the test.

**B-09. init in an existing node home proposes a home inside the home.**
- Location: src/commands/init-home.ts:87
- Confidence: 92%. Source: regression review. The effect was reproduced.
- Effect: chooseHome counts the .factory state repo as a project. So init proposes a new home inside the node home. The check for an existing home runs later, so its message is lost. For a home with no owner name, the command now exits with code 2, not code 1.
- Fix: In chooseHome, do not propose the current folder when it holds factory.yaml or .factory. Skip dirs.state in the scan, as checkHomeHoldsNoRepo does. Move the factory.yaml and .factory checks into checkOptions, before the layer and owner checks. Add a test for this case.

**B-10. The migration keeps children on layer 1, and doctor then fails.**
- Location: src/migrate/config.ts:32 and :78; check at src/commands/doctor.ts:200
- Confidence: 88%. Source: regression review. The effect was reproduced.
- Effect: Schema 1 allowed children on the coordinator. The migration sets node.layer to 1 and keeps the children. Children of layer 1 are cells, so each child fails the layer check. After the upgrade, doctor exits with code 1 and a children failure. The plan gives no warning. CHANGELOG line 14 says that doctor passes after the upgrade.
- Fix: Choose one option, and test it. Option a: stop the migration with a clear message when children is not empty. The message gives two remedies. Remove the entries, or set node.layer to 2 by hand, and run upgrade again. Option b: keep the children, and add a warning line to the plan with the same remedies. Then make the CHANGELOG statement conditional.

**B-11. doctor reports a valid file address as a token.**
- Location: src/config/schema.ts:122; src/safety/secrets.ts:11
- Confidence: 90%. Source: regression review. The effect was reproduced.
- Effect: The base64-run test counts "/" as a part of a run. A long absolute path that has a digit matches the test. A valid file:// address then fails the secrets check. doctor reports the value as a token and asks the owner to remove it. The add-child command writes such addresses.
- Fix: Skip the base64-run test for parent.address and children[].address. The schema already requires a file:// path for these values. Keep the known-prefix and hex tests. Or split each run at "/" before the base64 test. Add a doctor test with a macOS-style address that has a digit.

**B-12. upgrade does not check the home location.**
- Location: src/commands/upgrade.ts:40-46; CHANGELOG.md:14; src/commands/doctor.ts:139
- Confidence: 85%. Sources: regression review; setup and upgrade review (suggestion, merged here).
- Effect: A 0.1.0 home inside a git work tree, or inside another node home, upgrades with exit code 0. Then the doctor home check fails with exit code 1. The up command refuses with exit code 4. The upgrade gives no warning and no remedy. The setup review adds that the upgrade rewrites a config inside a repo, which up refuses to use.
- Fix: After the plan, run checkHomeLocation and checkHomeApart. If one fails, add a warning line to the plan. The line gives the remedy: move the home beside the repo. Change CHANGELOG line 14, so that it applies to homes that follow the rules. Add the remedy to the README section "Upgrade a node".

### LOW

**B-13. The home index folder and temp file have the wrong mode.**
- Location: src/core/home-index.ts:107, 119-121; src/core/node-deps.ts:47-51, 96-97
- Confidence: 85%. Sources: security review; setup and upgrade review (open item a, confirmed).
- Effect: mkdir sets the mode only on a folder that it creates. An existing state folder keeps its mode. The temp file gets the default mode, and the mode is set after the write. The temp name uses only the process id, so it is predictable. The write does not use an exclusive create. So an existing link at that name can change where the write goes. The index holds paths, not credentials. A user who can write to an existing folder can change which home a command uses. The risk is low. The state folder must already have the wrong permissions.
- Fix: Create the temp file with its final mode and an exclusive open (flag wx). Remove an old temp file first. After mkdir, set mode 0700 on the factory folder only. Refuse an index folder or file that another user owns or can write. Correct the comment at line 107.

**B-14. The size limit is checked after the full read.**
- Location: src/core/home-index.ts:87-89; src/comms/transport.ts:34 (through src/migrate/inspect.ts:83)
- Confidence: 85%. Sources: security review; setup and upgrade review (open item b, confirmed); reliability review (suggestion).
- Effect: readHomeIndex reads the whole file, then checks its length. The check counts UTF-16 units, not bytes. The child ping reads each child factory.yaml with no limit. doctor and node children ping up to 200 children. A very large file makes the command slow and use much memory. No data is sent out. The files belong to the user.
- Fix: Add a bounded read, for example readTextLimited(path, maxBytes). The function reads maxBytes plus one byte. It fails when it reads that extra byte. Use it in readHomeIndex and in inspectFile. Count bytes.

**B-15. An empty parent folder stays after a failed init.**
- Location: src/commands/init-clone.ts:97, 107; src/commands/init.ts:305, 505. Setup review locations: src/commands/init.ts:503-516; src/commands/init-clone.ts:107, 128-144.
- Confidence: 90%. Sources: reliability review (blocking); setup and upgrade review (should fix; open item c).
- Effect: The clone target is the parent folder of the home plus the repo name. git clone creates the missing parent folders. The undo removes only the clone. After a failed init with a URL project and a home below a missing folder, empty folders stay. No data is lost, and a second run works. The git step was not run in the reliability review, so this finding rests on code reading.
- Fix: Before runClones, find the top missing folder above the parent of the home. Create it, and record it for the undo. After undoClones, remove the empty folders, deepest first.

**B-16. Two init runs at the same time can lose an index entry.**
- Location: src/core/home-index.ts:109-122 (setup review: lines 113-121)
- Confidence: 85%. Sources: reliability review; setup and upgrade review (open item f, confirmed).
- Effect: recordHome reads, adds and writes the index with no lock. If two runs write at the same time, the last write wins, and the other entry is lost. From a project folder of the lost home, commands fail with a usage error that names --home. The --home option still works. The doctor index check (src/commands/doctor.ts:159) reports only gone homes. It does not report a missing entry.
- Fix: Add a lock file beside the index. Create it with open and the wx flag. Retry a fixed number of times, for example 20 times, 50 ms apart. Treat a lock that is older than a fixed age as stale. Make the index check warn when the current home is not in the index. The warning states the fix.

**B-17. add-child accepts a child with the id of its own node.**
- Location: src/commands/node.ts:134-141
- Confidence: 85%. Source: reliability review (open item g). The setup and upgrade review did not cover this file.
- Effect: The check compares the child id only with the ids of the other children. It does not compare the child id with config.core.node.id. up uses the node id as the tmux session name. A parent and its child always run on one machine. So both cannot run with one id. The second up refuses to start.
- Fix: Refuse when the child id equals config.core.node.id. Give a hint to change the id in the child config. Add a unit test.

**B-18. The project count is checked after the clones.**
- Location: src/commands/init.ts:160, 466, 505; src/commands/init-clone.ts:96
- Confidence: 85%. Source: reliability review.
- Effect: planProjects counts only the --project values. A workspace scan can add up to 200 repos. MAX_PROJECTS is 100. The total is counted after the owner accepts the proposal and after every clone runs. This breaks the rule that a bad value must fail before any clone. It is the same rule as B-03, with different checks.
- Fix: Before runClones, count the projects, and refuse when the count is above MAX_PROJECTS. Or refuse the proposal in chooseHome when the scan finds more than MAX_PROJECTS repos.

**B-19. A nested ternary in up.**
- Location: src/commands/up.ts:294-298
- Confidence: 95%. Source: reliability review.
- Effect: The arrival value uses a nested ternary. The project rules forbid nested ternaries. The behavior does not change.
- Fix: Use a small function with if and return. Or use a switch on the value of how.

**B-20. The up test uses a fixed wait as its check.**
- Location: test/integration/up.test.ts:163-171; also lines 123 and 192
- Confidence: 85%. Source: testing review (open item h).
- Effect: The test waits 600 ms. Then it counts the lines in launches. A launch that comes after 600 ms still passes. So a false pass is possible. A flaky failure is not likely.
- Fix: Take a list-panes snapshot. Run up with --json again. Expect started to be false, and expect the same snapshot. Remove both sleeps. This saves about 1.2 seconds.

**B-21. The exit code for "no node home" changed, and the CHANGELOG does not say so.**
- Location: src/core/home.ts:59; README.md:160
- Confidence: 90%. Source: regression review.
- Effect: When no node home is found, doctor, upgrade, up and node exit with code 2, not code 1. The CHANGELOG does not say so. Scripts that check for exit code 1 fail. The README exit-code table describes code 2 only as a wrong command line.
- Fix: Add one CHANGELOG line: A command that finds no node home now exits with code 2. It was code 1. Change row 2 of the README exit-code table.

**B-22. The help glossary does not match this version.**
- Location: src/glossary.ts:29; docs/glossary.md:15
- Confidence: 82%. Source: regression review.
- Effect: The glossary says that a work order is a file in the inbox. This version writes work orders to .factory/orders/. Some terms describe checks that no command of this version has. The node term does not match the README.
- Fix: Change the work order sentence to: It is a file in .factory/orders/. Mark the later terms as later, or remove them until a command uses them. Make the node sentence match the README.

## Should Fix Issues

**S-01. The upgrade dry run does not check the migrated files.** MEDIUM
- Location: src/commands/upgrade.ts:93-94 (check at lines 135-138); src/upgrade/spec.ts:52-60
- Confidence: 88%. Source: setup and upgrade review.
- Effect: The dry run returns before the schema check of the migrated factory.yaml and state file. The block plan checks only the node key. A dry run can show a clean plan, and the real run can then fail. Nothing is written in either case.
- Fix: Run both pure functions before the dry-run return. Return their errors in the dry run too. Add a dry-run case to test/unit/upgrade.test.ts:425.

**S-02. The upgrade commit covers the whole state repo.** MEDIUM
- Location: src/commands/upgrade.ts:114-116, 152-157; src/core/git.ts:174-182
- Confidence: 85%. Source: setup and upgrade review.
- Effect: commitAll runs git add -A in .factory. Other changes that are not committed enter the commit "chore: upgrade the state". The abort step clears the index, even when the upgrade staged nothing. The work-tree text stays, so no content is lost. No lock exists, and the state repo is not checked for a clean state.
- Fix: Before the backup, read git status --porcelain in .factory. If it is not empty, refuse, and tell the owner to commit first. Stage only the paths that the upgrade wrote or moved. Set a flag before commitAll. In abort, clear the index only when the flag is set.

**S-03. The backup refuses links that other steps write through.** LOW
- Location: src/upgrade/apply.ts:88-99; src/core/node-deps.ts:68-80
- Confidence: 85%. Source: setup and upgrade review.
- Effect: init writes through a linked CLAUDE.md. upgrade cannot run on that home, because backup stops at a link. The error names the top folder, not the entry. A failed backup leaves a partial folder with a valid timestamp name. That folder counts toward the five kept backups.
- Fix: Choose one link rule. The recommended rule: refuse a linked factory.yaml, CLAUDE.md or roles/worker.md in init, upgrade and doctor. Give a clear message. Name the entry in the copy error. Remove the partial backup folder when backup fails.

**S-04. Error text and prompts skip the control-character filter.** LOW
- Location: src/cli/run.ts:27-28 (existing code); new callers at src/commands/init-home.ts:43-50, src/commands/node.ts:133, src/core/home-index.ts (unusable, tie)
- Confidence: 80%. Source: security review.
- Effect: renderText filters control characters. renderError and the prompt do not. The new messages show folder names, YAML keys and index paths. Special characters in these names can change how the error or the question looks.
- Fix: Export printable from src/cli/output.ts. Apply it to error.message and error.hint in renderError. Apply it to the question in confirmProposal before deps.prompt.

**S-05. A test name claims more than its test checks.** LOW
- Location: test/unit/names.test.ts:168; PR test plan rows TP-1 and TP-8
- Confidence: 90%. Source: testing review (open item i).
- Effect: The test named "finds a name literal in a file that is not names.ts" calls only literalsOf. It reads no file and checks no skip. The test plan row TP-1 names test/integration/init.test.ts, which holds only the deny-list scan. Row TP-8 says "method:local". The continuous integration (CI) pipeline runs the exit check instead.
- Fix: Rename the test, for example: takes the string literals out of a source text, and skips comments and placeholders. In the test plan, name scripts/exit-check.sh for rows TP-1 and TP-8. The CI pipeline runs that script.

## Suggestions (Lower Confidence)

1. src/safety/proxy.ts:11-19 (65%, security). up sends API traffic to any base_url. The cloned-repo rule does not cover a config from an extracted archive. Fix: accept only loopback hosts, or ask the owner once for another host.
2. src/core/git.ts:175-179 (60%, security). The state commit runs the git hooks of the state folder. Fix: set core.hooksPath to an empty folder in the -c options.
3. src/commands/init.ts:137 (60%, security). A value with a user name and a password, but no scheme, is read as a path. The error repeats it. Fix: pass the value through withoutUserinfo, or refuse an @ before a : and give a URL hint.
4. test/unit/templates.test.ts:185 (65%, testing). The owner-authority tests cover only layer 1. Fix: add a layer 2 test for the rule that a child's report carries no authority.
5. test/unit/node.test.ts:157; src/commands/node.ts:134 (60%, testing). No test adds a child below the required layer. Fix: add a parent on layer 3 with a child on layer 1.
6. test/unit/init.test.ts:1212 (70%, testing). The README and the PR body say that init warns for a password in a URL. The tests show a refusal. Fix: align the README line and the PR body with the tested behavior.
7. src/core/git.ts:162-170 (70%, reliability). A clone can wait for an ssh prompt until the five-minute limit. The message then says "cannot run git: SIGTERM". Fix (synthesis, not in the review): name the time limit in the message.
8. src/core/home-index.ts:109 (65%, reliability). recordHome does not remove entries of gone homes. After 200 homes, every init shows a warning. Fix (synthesis, not in the review): remove entries of gone homes when the index is written.
9. src/commands/up.ts:270-299 (60%, reliability). A second up on a session whose coordinator pane ended says only that the session runs. Fix (synthesis, not in the review): say that the coordinator ended.
10. src/commands/upgrade.ts:79 (70%, regression). The JSON entry for the renamed block has no old name. Fix: add a renamedFrom field.
11. src/commands/upgrade.ts (65%, regression). upgrade does not add a 0.1.0 home to the index. Commands from a project folder beside it exit with code 2. Fix: warn at upgrade time, or add an index entry.
12. src/core/home.ts:44 (65%, regression). FACTORY_HOME takes precedence over a factory.yaml in the current folder. Inside a session, doctor in another node folder checks the session node. Fix: none given. The README documents the order. Decide whether to show a warning.
13. src/commands/upgrade.ts:155-156 (70%, setup and upgrade). gitStep stops git after 15 seconds. If git stops after it writes the commit, abort restores the old files, but HEAD keeps the upgrade commit. Fix: record HEAD before the commit. Restore the files only when HEAD did not move.
14. src/commands/init.ts:394, 434 (70%, setup and upgrade). An interrupted init leaves a folder named .factory.tmp-<pid>. The next init and doctor refuse, and the message does not say what the folder is. Fix: name leftover staging folders in the refusal, or remove one whose process is not running.

## Setup and upgrade code (D-51 A)

Each file lists its findings from all five reviews. "No finding" means that no review raised an item for the file.

- src/commands/init.ts: findings B-03 (MEDIUM, lines 497-513), B-15 (LOW, lines 503-516), B-18 (LOW, lines 160, 466, 505). Suggestions 3 (line 137) and 14 (lines 394, 434).
- src/commands/upgrade.ts: findings S-01 (MEDIUM, lines 93-94), S-02 (MEDIUM, lines 114-116, 152-157), B-12 (MEDIUM, lines 40-46). Suggestions 10 (line 79), 11 and 13 (lines 155-156).
- src/commands/doctor.ts: findings B-02 (MEDIUM, lines 417-423) and B-04 (MEDIUM, lines 263-269). The file also shows results from other causes. These are the children check at line 200 (B-10) and the home check at line 139 (B-12). The index check at line 159 is part of the fix for B-16.
- src/upgrade/apply.ts: findings B-01 (HIGH, line 226) and S-03 (LOW, lines 88-99).
- src/upgrade/plan.ts: no finding. The setup and upgrade review checked the file moves, the block plan, the refusal rule and the diff line limit. The regression review found the plan lines correct.
- src/upgrade/spec.ts: findings B-01 (HIGH, line 67) and S-01 (lines 52-60). The setup and upgrade review found no finding in this file. The regression review reproduced the comment loss, so B-01 stands.

## Open Harden items

| Item | Outcome | Severity | Finding |
|------|---------|----------|---------|
| (a) index folder mode and temp file mode | Confirmed. The index holds paths, not credentials. The risk is integrity, and only when an existing folder is open to other users. | LOW | B-13 |
| (b) whole-file read before the size limit | Confirmed. The index checks the size after a full read. The child ping has no limit. | LOW | B-14 |
| (c) empty clone parent folder after undo | Confirmed by code reading. The git step was not run. No data is lost. | LOW | B-15 |
| (d) cleanup message names a gone session | Confirmed by the reliability review. The setup and upgrade review did not cover up.ts. | MEDIUM | B-05 |
| (e) doctor proxy request for a config in a git work tree | Confirmed. up refuses the same home before it reads the config. | MEDIUM | B-02 |
| (f) concurrent init loses an index entry | Confirmed. The index write has no lock. The --home option still works. | LOW | B-16 |
| (g) add-child accepts its own id | Confirmed by the reliability review. The setup and upgrade review did not cover node.ts. | LOW | B-17 |
| (h) fixed 600 ms wait in the up test | Confirmed. A late launch can pass. A flaky failure is not likely. | LOW | B-20 |
| (i) names.test.ts test names | Partly confirmed. One name claims more than its test. The other two parts are not issues. Test plan rows TP-1 and TP-8 name the wrong proof. | LOW | S-05, should fix, not blocking |

The setup and upgrade review counted seven open items in the plan's resume block. This table lists nine items.

## Duplicate Findings

- B-02: the security review, the setup and upgrade review, and open item (e).
- B-13: the security review and open item (a).
- B-14: the security review, open item (b), and the size part of a reliability suggestion.
- B-15: the reliability review (blocking), the setup and upgrade review (should fix), and open item (c).
- B-16: the reliability review and open item (f).
- B-12: the regression review and the setup and upgrade suggestion on the home location rule.
- Not merged, because the checks differ: B-03 and B-18 (both check the order of steps). S-02 and suggestion 2 (both in the state commit, with different concerns). B-13 and S-03 (different code). B-04 and the security result for the index compare (different functions).
- Totals: the five reviews listed 44 items: 23 blocking, 6 should fix and 15 suggestions. Three duplicates were merged. They remove one blocking item, one should-fix item and one suggestion. The result is 41 items: 22, 5 and 14.

## Conflicts Between Reviews

1. src/upgrade/spec.ts: the setup and upgrade review found no finding. The regression review reproduced the comment loss. B-01 keeps HIGH.
2. B-15: the setup and upgrade review rated it should fix. The reliability review rated it blocking. The blocking rating is kept. The git step was not run, so the finding rests on code reading.
3. B-03: the security review found no security effect. The setup and upgrade review rated it MEDIUM for cost and rule reasons. MEDIUM is kept, with no security severity.
4. B-05 and B-17: the setup and upgrade review says that these files are outside its scope. The reliability findings are kept.
5. B-08: the regression review found that the code gives the block its new body. The testing review found that the test does not check it. The code is correct. B-08 is a gap in the test.
6. B-04: the security review says the index path compare holds. The setup and upgrade review found a separate compare in doctor. Both stand.
7. The regression review says that three findings were reproduced. Its text marks four. All four are treated as reproduced.

## Coverage and Limits

- Gate level lean. Five focus areas ran. The TypeScript, architecture and documentation focus areas did not run as separate reviews.
- The testing review did not run the full test suite.
- The reliability review could not run the git step for B-15. The check was denied.
- The PATH case in B-05 was found by reading code. It was not run.
- Scores: security 8/10, testing 8/10, reliability 8/10, regression 6/10, setup and upgrade 7/10.

## Checks That Pass

- URL user information is never printed or written. The config keeps only the clone folder and the owner and name.
- The session environment change applies to one session only. It runs right after new-session. It does not use the global scope.
- The real-path compare for the index (indexPathOf) passes.
- The init safety checks run before the clone. The other checks run after it (B-03).
- The upgrade moves, the block rename, the restore and the refusal of edited blocks are sound.
- The new code has no throw in its logic. It uses result types and fixed loop bounds.
- The CI workflow uses read-only permissions and pinned actions.

## Convergence Status
**Cycle**: 1
**Prior Resolution**: none
**Prior FP Ratio**: N/A
**Assessment**: First cycle. No finding is resolved. All 22 blocking findings are new. Not converged. The review converges when a later cycle shows zero open blocking findings and no new blocking finding.
