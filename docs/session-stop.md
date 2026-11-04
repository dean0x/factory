# Session stop

This file holds the rule for the word "safe" and the table of the ways to stop a session (design section 4.11, F-7). The rule comes first. The table follows it. `scripts/check-session-stop.sh` checks this file.

## The rule for safe

A way to stop a session is **safe** when all four facts hold:

1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

How a test reads each fact:

- **Fact 1.** After the signal, `ps -p <pid>` shows no process for the session. `pgrep -f <marker>` shows no process that the session started and that still runs. No process of the background daemon holds the session: `claude agents --json` lists no row for the session id. A test never lists the environment of a process.
- **Fact 2.** A test never opens the transcript file. It reads fact 2 only indirectly: it runs `--resume <session id>` and asks for the last turn. Fact 2 is `yes` when the resumed session names the last turn.
- **Fact 3.** `--resume <session id>` starts and answers. Fact 3 is `no` when it fails, or when it starts an empty session.
- **Fact 4.** A cron or a background task is lost without a record when it ends or keeps running, and the resumed session does not name it. A test reads this from `pgrep -f <marker>` for the task and from the answer of the resumed session.

Each fact has one value:

- `yes`: the test observed that the fact holds.
- `no`: the test observed that the fact does not hold.
- `open`: the test did not observe the fact.
- `n/a`: the way does not exist, so the fact has no meaning.

The verdict follows the facts:

- `safe`: all four facts are `yes`, in a test that reached the case of the row.
- `not safe`: at least one fact is `no`. A fact that no test observed stays `open`. One fact that is `no` is enough, because the rule asks for all four facts.
- `not safe` for a row that no test reached: no fact is `no`, at least one fact is `open`, and the Probe cell starts with `not tested`. The run budget ended before the row. The factory never uses this way, so the row gets this verdict and not `open`. A fact that a test did observe keeps its value.
- `not available`: the way does not exist in the program. All four facts are `n/a`.
- `open`: at least one fact is `open`, or the test did not reach the case of the row, and the row is not one of the rows above. The notes under the table say why.

`scripts/check-session-stop.sh` fails while one verdict is `open`.

## The table

Idle means that no tool, no agent and no prompt is in flight. Busy means that a tool runs in the foreground and a background task runs. Each way has one row for each case, so the table has 12 rows. The Probe column names the runs in "The runs".

| Way | Case | 1 Process ends | 2 Transcript complete | 3 Resume works | 4 Nothing lost | Verdict | Probe |
|---|---|---|---|---|---|---|---|
| `/exit` | idle | yes | yes | yes | yes | safe | V2, V3 |
| `/exit` | busy | yes | yes | yes | yes | safe | I1, V1 |
| `/quit` | idle | open | open | open | open | not safe | not tested (alias of `/exit`) |
| `/quit` | busy | open | open | open | open | not safe | not tested (alias of `/exit`) |
| `/restart` | idle | no | yes | yes | yes | not safe | I1 |
| `/restart` | busy | no | open | open | open | not safe | I1 |
| `kill -TERM` | idle | yes | yes | yes | yes | safe | V1, V2 |
| `kill -TERM` | busy | yes | yes | yes | yes | safe | I2, V4, P1-1, P1-2 |
| `kill -INT` | idle | yes | open | open | open | not safe | not tested (fact 1 in I0b) |
| `kill -INT` | busy | yes | open | open | open | not safe | not tested (fact 1 in V4) |
| `agent view delete` | idle | no | open | open | open | not safe | V3 |
| `agent view delete` | busy | no | open | open | open | not safe | I2 |

## The safe way for each case

- Idle: `kill -TERM`. `/exit` is also safe.
- Busy: `kill -TERM`. `/exit` is also safe, but it opens a dialog and needs a second Enter (see the notes).
- If a case has no safe way, the stop code uses `kill -TERM` as the prompt fallback.

`kill -TERM` is the way for both cases because it needs no keystroke in the pane and no state of the screen. In every run of it the process ended before the first look, 4 to 6 seconds after the signal. The exit code was 143. The hook SessionEnd ran. Every process of a tool and of a background task was gone.

## Notes on the rows

- **`/exit` busy.** A typed `/exit` ran at once, while a foreground tool ran. The program did not queue it. A dialog appeared: "Background work is running. The following will stop when you exit", with a list of the shells, and three options: "1. Exit and stop tasks" (the default), "2. Move to background and exit" and "3. Stay". Enter on the default ended the process with exit code 0. The row is for the default option. Option 2 keeps the session in the background by design. No run chose it, so no run read its facts.
- **`/exit` idle.** No dialog. The process ended with exit code 0 and printed the line "Resume this session with: claude ... --resume <session id>".
- **`/quit`.** The command picker lists `/exit (quit)`, so `/quit` is an alias of `/exit`. No run typed `/quit`. The factory does not use it, so both rows have the verdict for a row that no test reached.
- **`/restart` idle.** The process did not end. It started itself again with the same process id, with the argument `--resume <session id>`, and the session went on ("Session resumed"). The hook SessionStart ran again. The resumed session named its first request, so facts 2, 3 and 4 are `yes`. Fact 1 is `no`: the way does not stop the process.
- **`/restart` busy.** The text `/restart` was queued behind the running tool ("ctrl+x ctrl+s to send now" showed under it). The send-now key interrupted the turn and moved the foreground tool to the background. Then the program refused: "Can't restart while work is running in the background". The process did not end, so fact 1 is `no`. No resume followed, so the other facts stay `open`.
- **`kill -TERM`.** The process ended with exit code 143 and the hook SessionEnd ran. In the busy run the foreground tool and the background shell were gone at the first look. The resumed session said "Background shell command didn't finish before the previous session ended" and named the background job as stopped. The foreground tool showed as interrupted. This is the record that fact 4 asks for.
- **`kill -INT`.** In an idle run (I0b) the process ended with exit code 0 and the hook SessionEnd ran. In a busy run (V4) the process ended with exit code 0, and the tool processes were gone. The program does not cancel the turn and go on: SIGINT ends the process. No resume followed the busy run, and I0b had no transcript, so facts 2, 3 and 4 are `open`.
- **`agent view delete`.** The agent view (`claude agents`) lists only background sessions. A foreground session in a pane has no row in it, in the idle case and in the busy case. `claude agents --json` does list the pane session (kind `interactive`), but the view shows 0 rows. There was nothing to delete, so the key ctrl+x was not pressed. The process stayed. Fact 1 is `no` for a worker in a pane. A session moved to the background by option 2 of the `/exit` dialog could be deleted in the view. No run tested that.
- **Fact 4 in the runs.** Every busy run used a background shell task (`node sleeper.js`). No run used a cron or a background subagent, so the value of fact 4 holds for a background shell task only. In the idle runs no task existed.

## The runs

The interactive runs ran in a scratch tmux server on its own socket, as `env -u ANTHROPIC_BASE_URL claude --model haiku --permission-mode auto`, with the normal login. Each run started with the variables that a parent Claude session sets removed with `env -u` (the markers of a child session, the session id and the messaging socket and token of the parent). A run that kept them saved no transcript (see the findings). The runs used a project hook in `.claude/settings.local.json` that touched a file with the name of the hook event, and `claude agents --json` for the daemon. A run read facts 1 and 4 only with `ps -p`, `pgrep -f` and `claude agents --json`.

| Run | What it did | Result |
|---|---|---|
| I0a | Start attempt 1, through the command of `tmux new-session`. | The process ended at once. No screen was seen, no prompt was sent, no model call was made. The cause is not known. |
| I0b | Start attempt 2, in a pane with the markers of the parent session. | The screen warned "Transcript saving is off" (the marker of a child session). No prompt was sent, no model call was made. `/restart` ran: same process id. `kill -INT` ended the process (exit 0). Not a valid session for facts 2 to 4. |
| I1 | New conversation A. One prompt, then `/restart`, a question about the first request, a busy prompt (a background `node sleeper.js 900` and a foreground `node sleeper.js 300`), `/restart` typed while busy, a new foreground tool, then `/exit` and Enter on the default option of the dialog. | See the rows `/restart` and `/exit` busy. The process ended (exit 0). `pgrep -f` found no shell and no `node`. `claude agents --json` listed no row. |
| V1 | Resume 1 of A. A question about the last request and the shells. Then `kill -TERM` (idle). | The resumed session named the interrupted foreground command, and the two shells as stopped. The process ended (exit 143). |
| V2 | Resume 2 of A. A question about the last answer. Then `/exit` (idle). | The resumed session quoted the last answer of V1. The process ended (exit 0). |
| V3 | Resume 3 of A. A question about the last answer. The agent view was open in a second window. Then `/exit`. | The resumed session quoted the last answer of V2. The agent view showed 0 rows while V3 was idle. |
| I2 | New conversation B. A busy prompt (background `node sleeper.js 900`, foreground `node sleeper.js 600`). The agent view showed 0 rows. Then `kill -TERM` with the foreground tool in flight. | The process ended (exit 143). The shell and the `node` processes were gone. `claude agents --json` listed no row. |
| V4 | Resume 4 of B. A question about the last request and the shells. A new busy prompt. Then `kill -INT`. | The resumed session named the interrupted foreground command and the background job as stopped. After `kill -INT` the process ended (exit 0), and the tool processes were gone. |
| P1-1 | The print probe: `kill -TERM` on a busy print session. | See "The print probes". |
| P1-2 | The print probe: `--resume` of P1-1. | See "The print probes". |

The count of launches: 2 new conversations that took a prompt (I1, I2), 2 start attempts that took no prompt and made no model call (I0a, I0b), 4 resumes (V1 to V4), and 1 window of `claude agents` (no conversation, no model call). The status line of each session showed 0.00 to 0.02 USD. The whole set of runs cost below 0.1 USD.

## The print probes

All three probes ran as `env -u ANTHROPIC_BASE_URL claude -p --model haiku`, with the normal login, in a new scratch folder. The folder had a project hook for PreToolUse that touches a marker file.

| Run | What it did | Result | Tokens | Cost |
|---|---|---|---|---|
| 1 | Started a busy print session. | The command line failed: the option `--allowedTools` took the prompt as a second tool name. The program printed "Input must be provided" and made no model call. | 0 | 0 |
| P1-1 | Started a busy print session: one background `sleep 281`, and a foreground `sleep 111` that the program blocked. About 60 seconds after the start, `kill -TERM` went to the process id that the test started. | The marker file existed, so the hook ran. At the signal the turn had ended (a result line was printed) and the background task ran. The process was gone within 4 seconds and had exited with code 143. The background `sleep` was gone, and `pgrep -f` found no process with the session id or the probe tag. The program stopped its own task and wrote the events "stopped" and "killed" to its stream. | 6 in, 692 out, 32980 cache write, 64954 cache read | 0.00759 USD |
| P1-2 | `--resume` of the session of P1-1, with a prompt that asks for the last turn and the state of the background task. No tool was allowed. | The session resumed with the same session id. It named the last request, said that the tool calls were "started, blocked", and said that the background task was "stopped". | 2 in, 310 out, 752 cache write, 32980 cache read | 0.00823 USD |
| P1-3 | Not run. | The budget of three print runs was used up. | - | - |

The cost is the field `total_cost_usd` of the result line of the run. The print runs together cost about 0.016 USD. The interactive run I2 later gave the case that the print probes lacked: a foreground tool in flight at the signal.

## Findings for the stop code

- **The launch environment.** A session that inherits the marker of a child session saves no transcript, so `--resume` has nothing to read. The TUI shows the warning "Transcript saving is off". A worker that the factory starts from a command that itself runs inside a Claude session inherits those markers, and the same holds for the messaging socket and token of that session. The launch path of the workers must remove them.
- **Hook events: idle.** A session at the prompt shows the hook event SessionStart (after a start, a resume or a restart) or Stop (after a turn) as its last event. About 2 seconds after Stop, the hook SubagentStop can follow. The cause is not known. It matches the prompt suggestion that the input box shows. The check for idle must skip SubagentStop.
- **Hook events: busy.** UserPromptSubmit starts a turn. PreToolUse and PostToolUse follow it. While a foreground tool runs, the last event is PreToolUse.
- **No Stop after an interrupt.** When the user interrupts a turn (the send-now key in the run I1), no Stop event comes. The last event stays PostToolUse. About 60 seconds later the hook Notification ran. The stop code counts this state as busy. That is the safe side.
- **Stop does not prove idle.** In print mode the process stays alive after the final result while a background task runs. In the TUI, `claude agents --json` shows `status: "busy"` for a session whose prompt looks idle while a background shell runs, and `status: "idle"` when nothing runs. The plan does not use this field. It is a second signal that the hook events lack.
- **SessionEnd runs on every way that ended a session.** `/exit`, `kill -TERM` and `kill -INT` all ran it. `/restart` did not run it. It ran SessionStart again instead.
- **`/restart` keeps the process id.** The process starts itself again in place. The new argument list has `--resume <session id>` and has lost `--session-id` and `--name`. It also carried `--allowed-tools mcp__computer-use__*` options that the launch command did not have. The cause is not known.
- **Typed text queues while a tool runs.** The text `/restart` waited behind the tool. `/exit` ran at once. A stop through the keys of the pane differs for each command. A signal does not.
- **The program blocks a standalone foreground `sleep N`** in the Bash tool ("Blocked: standalone sleep"). A test with a foreground tool in flight needs another slow command.
- **The program stops its own background tasks** when the session ends, and the resumed session knows them as stopped. This holds for `kill -TERM` and for `/exit` with the default option. After `kill -INT` the tool processes were gone, but no resume followed.

## Not tested

- The facts 2, 3 and 4 of `kill -INT` in both cases. Fact 1 is `yes` in both cases.
- `/quit`. It is an alias of `/exit`.
- The agent view with a session that option 2 of the `/exit` dialog moved to the background.
- A cron and a background subagent in the busy case (fact 4).
- The facts 2, 3 and 4 of `/restart` busy.
