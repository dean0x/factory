# Roadmap per track

Each track has one roadmap file in this folder: `<track>.md`.
The roadmap is the plan of the track from now to its goal. The board says what is left now.
The roadmap says where the track goes, in which order, and how we know that each step is done.

## Rules

- **One file per track.** A new track starts with its roadmap. A finished track keeps its file, marked `Status: complete`.
- **The lane that owns the track keeps it current.** Update it at each milestone event: done, re-scoped, blocked, or a new decision. Rewrite sections in place. The Done table keeps the history.
- **The coordinator checks it** at each session start, before each status to the owner, and when a lane reports a milestone. Every board item names its track and milestone, for example `API-M2`.
- **Dates:** only real external dates, for example a conference, a user commitment or a scheduled run. Other milestones say "after M<n>".
- **Exit criteria are checkable** on a primary source: a merged pull request, a published version, a configuration value or a stored record. "Looks done" is not an exit criterion.
- **Keep it short:** at most about 150 lines. Details live in issues, pull requests and the files of the lane. The roadmap links to them.

## Template

```markdown
# <Track> roadmap
Owner: <lane> · Checkout: <path> · Resume file: <path> · Updated: <yyyy-mm-dd> · Status: active | paused | complete

## Goal
<1-3 sentences: the end state, checkable.>

## Fixed dates and constraints
- <real external date or constraint, with its source>

## Milestones
| # | Milestone (outcome) | Exit criteria (checkable) | Items (issues / PRs / docs) | Depends on | Status | Target |
|---|---|---|---|---|---|---|
| M1 | ... | ... | #123, #456 | none | done / now / next / later / blocked | date or "after M0" |

## Now
Current milestone: M<n>. Next 3 steps:
1. ...

## Decisions needed
| Decision | Who | Blocks |
|---|---|---|

## Risks
- <risk>: <what we do about it>

## Done
| Milestone | Date | Evidence |
|---|---|---|
```
