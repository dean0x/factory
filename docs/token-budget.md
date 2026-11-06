# Token budget of the jobs

Design §3 lists 17 jobs that a command replaces. Each job has a figure "After": the new tokens that enter the context of the coordinator when the job runs as one command. This file keeps one row for each job. It is the base of the claim "50–70% less coordinator spend on routine work".

Rules:
- The default output of a job command has at most 20 lines, and the verdict is on the first line (roadmap rules). `--json` gives the full facts.
- The column "Budget" is the upper bound of the figure "After", in tokens. A row with no figure in design §3 gets the budget 1000, which the 20-line rule allows.
- The column "Measured" is the size of the default output on the fixture of the job. The size in tokens is the number of characters divided by 4, rounded up. The text is the plain text that a person sees on a terminal without color. A unit test of each built job checks the entry against the output on the fixture of that test. The entry shows `-` until the milestone that builds the job.
- Row 14 measures `factory worker watch` on a fixture with two changes. `factory worker recover` comes in FAC-M5 and adds no figure before then.
- `scripts/budget-check.sh` (FAC-M5) fails when a measured value is more than twice its budget. It passes for the jobs built so far.

| # | Job (design §3) | Command | Built in | After (design §3) | Budget | Measured |
|---|---|---|---|---|---|---|
| 1 | Merge check and merge | `factory check <pr>`, `factory pr merge <pr>` | FAC-M5 | 2 calls, 3–6k | 6000 | - |
| 2 | Status round | `factory status` | FAC-M4 | 1–2 calls, 3–5k | 5000 | 42 |
| 3 | Restart of all workers | `factory reboot` | FAC-M4 | 2 calls, 3–5k | 5000 | 37 |
| 4 | Worker creation | `factory worker new` | FAC-M4 | 1 call, 1–2k | 2000 | 31 |
| 5 | Board and owner-item updates | `factory item …`, `factory request …` | FAC-M5 | 1–2 calls, 1–3k | 3000 | - |
| 6 | Reading the answers of the owner | `factory decide read` | FAC-M3 | 1 call, <1k | 1000 | - |
| 7 | Worker session reset, then a new assignment | `factory worker reset` | FAC-M4 | 1 call, 1k | 1000 | 74 |
| 8 | Release pre-check and post-check | `factory release check`, `factory release verify` | FAC-M5 | 1 call each, 2–3k | 3000 | - |
| 9 | Issue audit and labels | `factory issues audit` | FAC-M5 | 1 call plus the new issues only (no figure) | 1000 | - |
| 10 | Decision record and profile update | `factory decide read`, `factory decide <D-n> <option>` | FAC-M3, FAC-M5 | 1 call, 1–2k | 2000 | - |
| 11 | Work copy cleanup | `factory copies clean` | FAC-M5 | 1 call, 1k | 1000 | - |
| 12 | Typed owner-authority input | `factory worker relay` | FAC-M5 | 1 call, <1k | 1000 | - |
| 13 | CI watch | `factory pr watch` | FAC-M5 | 1 call, <1k | 1000 | - |
| 14 | Stopped-worker watch and limit recovery | `factory worker watch`, `factory worker recover` | FAC-M4 (watch), FAC-M5 (recover) | <1k plus (no figure) | 1000 | 15 |
| 15 | Move of an outside session into tmux | `factory worker adopt` | FAC-M7 | 1 call, <1k | 1000 | - |
| 16 | Resource check | built into `worker new`; `factory machine` | FAC-M4 | 0–1 call (no figure) | 1000 | 52 |
| 17 | Coordinator self-compact | `factory self reset` | FAC-M4 | 1 call (no figure) | 1000 | 14 |
