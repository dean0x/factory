# Session stop

A complete example for the check script. Every verdict is set and agrees with its facts. The values are made up.

## The rule for safe

A way to stop a session is **safe** when all four facts hold:

1. The process ends, and the background daemon does not keep the session.
2. The transcript is complete.
3. `--resume` works after it.
4. No cron and no background agent is lost without a record.

## The table

| Way | Case | 1 Process ends | 2 Transcript complete | 3 Resume works | 4 Nothing lost | Verdict | Probe |
|---|---|---|---|---|---|---|---|
| `/exit` | idle | yes | yes | yes | yes | safe | R-1 |
| `/exit` | busy | yes | yes | yes | no: a background task ended | not safe | R-2 |
| `/quit` | idle | n/a | n/a | n/a | n/a | not available | none |
| `/quit` | busy | n/a | n/a | n/a | n/a | not available | none |
| `/restart` | idle | yes | yes | yes | yes | safe | R-3 |
| `/restart` | busy | no | yes | yes | yes | not safe | R-4 |
| `kill -TERM` | idle | yes | yes | yes | yes | safe | R-5 |
| `kill -TERM` | busy | yes | yes | yes | no | not safe | R-6 |
| `kill -INT` | idle | yes | yes | yes | yes | safe | R-7 |
| `kill -INT` | busy | no | yes | yes | yes | not safe | R-8 |
| `agent view delete` | idle | yes | yes | yes | yes | safe | R-9 |
| `agent view delete` | busy | yes | no | yes | yes | not safe | R-10 |
