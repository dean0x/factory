# Token budget of the jobs

Design §3 lists 17 jobs that a command replaces. Each job has a figure "After": the new tokens that enter the context of the coordinator when the job runs as one command. This file keeps one row for each job. It is the base of the claim "50–70% less coordinator spend on routine work".

Rules:
- The default output of a job command has at most 20 lines, and the verdict is on the first line (roadmap rules). `--json` gives the full facts.
- The column "Budget" is the upper bound of the figure "After", in tokens. A row with no figure in design §3 gets the budget 1000, which the 20-line rule allows.
- The column "Measured" is the size of the default output on the fixture of the job. The size in tokens is the number of characters divided by 4. The cell shows `-` until the milestone that builds the job.
- `scripts/budget-check.sh` (FAC-M5) fails when a measured value is more than twice its budget. It passes for the jobs built so far.

| # | Job (design §3) | Command | Built in | After (design §3) | Budget | Measured |
|---|---|---|---|---|---|---|
| 1 | Merge gate and merge | `factory inspect <pr>`, `factory pr merge <pr>` | FAC-M5 | 2 calls, 3–6k | 6000 | - |
| 2 | Status round | `factory status` | FAC-M5 | 1–2 calls, 3–5k | 5000 | - |
| 3 | Restart of all cells | `factory cell restart --all` | FAC-M4 | 2 calls, 3–5k | 5000 | - |
| 4 | Cell creation | `factory cell new` | FAC-M4 | 1 call, 1–2k | 2000 | - |
| 5 | Board and owner-item updates | `factory item …`, `factory andon …` | FAC-M5 | 1–2 calls, 1–3k | 3000 | - |
| 6 | Reading the answers of the owner | `factory decide read` | FAC-M3 | 1 call, <1k | 1000 | - |
| 7 | Cell clear or compact, then re-brief | `factory cell changeover` | FAC-M4 | 1 call, 1k | 1000 | - |
| 8 | Release pre-check and post-check | `factory ship check`, `factory ship verify` | FAC-M5 | 1 call each, 2–3k | 3000 | - |
| 9 | Issue audit and labels | `factory issues audit` | FAC-M5 | 1 call plus the new issues only (no figure) | 1000 | - |
| 10 | Decision record and profile update | `factory decide read`, `factory decide <D-n> <option>` | FAC-M3, FAC-M5 | 1 call, 1–2k | 2000 | - |
| 11 | Worktree cleanup | `factory checkout clean` | FAC-M5 | 1 call, 1k | 1000 | - |
| 12 | Typed owner-authority input | `factory cell relay` | FAC-M4 | 1 call, <1k | 1000 | - |
| 13 | CI watch | `factory pr watch` | FAC-M5 | 1 call, <1k | 1000 | - |
| 14 | Stopped-cell watch and limit recovery | `factory cell watch`, `factory cell recover` | FAC-M4 | <1k plus (no figure) | 1000 | - |
| 15 | Move of an outside session into tmux | `factory cell adopt` | FAC-M4 | 1 call, <1k | 1000 | - |
| 16 | Resource check | built into `cell new`; `factory machine` | FAC-M4 | 0–1 call (no figure) | 1000 | - |
| 17 | Coordinator self-compact | `factory self changeover` | FAC-M4 | 1 call (no figure) | 1000 | - |
