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

- `safe`: all four facts are `yes`.
- `not safe`: all four facts are observed (none is `open`), and at least one is `no`.
- `not available`: the way does not exist in the program. All four facts are `n/a`.
- `open`: at least one fact is `open`.

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
| `kill -TERM` | busy | open | open | open | open | open | none |
| `kill -INT` | idle | open | open | open | open | open | none |
| `kill -INT` | busy | open | open | open | open | open | none |
| `agent view delete` | idle | open | open | open | open | open | none |
| `agent view delete` | busy | open | open | open | open | open | none |

## Which rows a probe can fill

Print mode (`claude -p`) has no TUI and no idle prompt. So no print probe can fill these rows, and they stay `open`:

- The rows of `/exit`, `/quit`, `/restart` and `agent view delete`. These ways need the TUI.
- The idle rows of `kill -TERM` and `kill -INT`. A print session has no idle prompt.

They stay `open` until the interactive runs of the TP-24 ask.

The two busy rows of the signals are the rows that print probes can fill. Three probes fill them:

- P1-1: `kill -TERM` on a busy print session.
- P1-2: `--resume` of the session of P1-1, for facts 2 to 4.
- P1-3: `kill -INT` on a busy print session.
