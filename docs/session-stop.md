# Session stop

This file holds the rule for the word "safe" and the table of the ways to stop a session (design section 4.11, F-7). The rule comes first. The table follows it. `scripts/check-session-stop.sh` checks this file.

## The rule for safe

A way to stop a session is **safe** when all four facts hold:

1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

How a test reads each fact:

- **Fact 1.** After the signal, `ps -p <pid>` shows no process for the session. `pgrep -f <marker>` shows no process that the session started and that still runs. No process of the background daemon holds the session. A test never lists the environment of a process.
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
- `not safe`: all four facts are observed (none is `open`), and at least one is `no`.
- `not available`: the way does not exist in the program. All four facts are `n/a`.
- `open`: at least one fact is `open`, or the test did not reach the case of the row. The notes under the table say why.

`scripts/check-session-stop.sh` fails while one verdict is `open`.

## The table

Idle means that no tool, no agent and no prompt is in flight. Busy means that a tool runs in the foreground and a background task runs. Each way has one row for each case, so the table has 12 rows.

| Way | Case | 1 Process ends | 2 Transcript complete | 3 Resume works | 4 Nothing lost | Verdict | Probe |
|---|---|---|---|---|---|---|---|
| `/exit` | idle | open | open | open | open | open | none |
| `/exit` | busy | open | open | open | open | open | none |
| `/quit` | idle | open | open | open | open | open | none |
| `/quit` | busy | open | open | open | open | open | none |
| `/restart` | idle | open | open | open | open | open | none |
| `/restart` | busy | open | open | open | open | open | none |
| `kill -TERM` | idle | open | open | open | open | open | none |
| `kill -TERM` | busy | yes | yes | yes | yes | open | P1-1, P1-2 |
| `kill -INT` | idle | open | open | open | open | open | none |
| `kill -INT` | busy | open | open | open | open | open | none |
| `agent view delete` | idle | open | open | open | open | open | none |
| `agent view delete` | busy | open | open | open | open | open | none |

## Notes on the rows

Print mode (`claude -p`) has no TUI and no idle prompt. So no print probe can fill these rows, and they stay `open` until the interactive runs of the TP-24 ask:

- Both rows of `/exit`, `/quit`, `/restart` and `agent view delete`. These ways need the TUI.
- The idle rows of `kill -TERM` and `kill -INT`. A print session has no idle prompt.

The row `kill -INT` busy is `open` because probe P1-3 did not run. The budget of three probe runs was used up before it. Run 1 failed at the command line, with no model call (see "The probes").

The row `kill -TERM` busy has four facts that are `yes`, and its verdict is `open`. The reason is the state of the session at the signal. The program blocks a standalone foreground `sleep`, so no foreground tool was in flight. At the signal the final turn had ended, and one background task still ran. The row says nothing about a signal that arrives while a foreground tool runs. It also says nothing about the TUI. The founder decides in the TP-24 ask whether print-mode rows count for a worker. After that decision, the verdict of this row is `safe`, or the row gets a new probe with a foreground tool in flight.

## The probes

All probes ran as `env -u ANTHROPIC_BASE_URL claude -p --model haiku`, with the normal login, in a new scratch folder. The folder had a project hook for PreToolUse that touches a marker file. A probe read facts 1 and 4 only with `ps -p` and `pgrep -f`.

| Run | What it did | Result | Tokens | Cost |
|---|---|---|---|---|
| 1 | Started a busy print session. | The command line failed: the option `--allowedTools` took the prompt as a second tool name. The program printed "Input must be provided" and made no model call. | 0 | 0 |
| P1-1 | Started a busy print session: one background `sleep 281`, and a foreground `sleep 111` that the program blocked. About 60 seconds after the start, `kill -TERM` went to the process id that the test started. | The marker file existed, so the hook ran. At the signal the turn had ended (a result line was printed) and the background task ran. The process was gone within 4 seconds and had exited with code 143. The background `sleep` was gone, and `pgrep -f` found no process with the session id or the probe tag. The program stopped its own task and wrote the events "stopped" and "killed" to its stream. | 6 in, 692 out, 32980 cache write, 64954 cache read | 0.00759 USD |
| P1-2 | `--resume` of the session of P1-1, with a prompt that asks for the last turn and the state of the background task. No tool was allowed. | The session resumed with the same session id. It named the last request, said that the tool calls were "started, blocked", and said that the background task was "stopped". | 2 in, 310 out, 752 cache write, 32980 cache read | 0.00823 USD |
| P1-3 | Not run. | The budget of three runs was used up. | - | - |

The cost is the field `total_cost_usd` of the result line of the run. The three runs together cost about 0.016 USD.

How the probes fill the row `kill -TERM` busy:

- Fact 1 is `yes`: the process ended after the signal, and no process of the session was left.
- Fact 2 is `yes`: the resumed session named the last turn. The test did not open the transcript.
- Fact 3 is `yes`: `--resume` worked.
- Fact 4 is `yes`: the background task ended with the session, and the resumed session named it as stopped. The loss has a record.

## Findings for the stop code and for the TP-24 ask

- The program blocks a standalone foreground `sleep N` in the Bash tool ("Blocked: standalone sleep"). A probe with a foreground tool in flight needs another slow command.
- In print mode the process stays alive after the final result while a background task runs. A hook event for the end of the turn (Stop) therefore does not mean that the process is idle. This is the known limit: the stop rule cannot see a background task after a Stop event.
- On `kill -TERM` the program stops its own background tasks and reports them as stopped. The resumed session knows the task as stopped.

## Open until the TP-24 ask

- The TUI rows and the idle rows.
- The busy `kill -INT` row (all four facts).
- The busy `kill -TERM` row with a foreground tool in flight.
- Whether print-mode kill rows count for a worker in the TUI.
