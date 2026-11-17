# Plan: the board model and the board mod

Status: active · Branch: `feat/board-mod` · Design: `docs/design.md` · Date: 2026-11-17

Marks: OBSERVED means seen in the code at `e3c85f4`. INFERRED means a conclusion.

## Goal and exit check

Goal: one command gives the whole board of a factory home, as facts and as text. A Claude Code mod in the factory repo draws that text in a pane beside the chat, and refreshes it.

Exit check:
1. `factory board --json` prints one `factory.board/v1` document: requests, queue, workers, open items, machine, and the faults of sections that could not be read.
2. `factory board --width 100` prints the text of the same sections. Each section has the same lines that its own command prints.
3. A contract test shows that each `factory board --json` section equals the JSON of its own command, for one fixture home.
4. `claude plugin validate plugins/factory-board` passes, and `claude plugin test plugins/factory-board` passes.
5. `claude plugin validate .` reads `.claude-plugin/marketplace.json` with no error.
6. `npm test`, typecheck and lint pass, with zero warnings.

## Scope

In:
- The command `factory board` (`--json`, `--width`, `--home`).
- The mod `plugins/factory-board/`: a pane, the `/board` command, and a header with the session's own context and limits.
- `.claude-plugin/marketplace.json` at the repo root.
- Unit tests, the contract test, the mod tests, and the docs.

Out:
- The planned live views parts: the workers table with the closed word list, the usage panel, the epic view, `worker list --follow`. The mod draws them when factory prints them. The mod needs no change for that.
- A status line entry or a band above the prompt. These are follow-ups.
- A shared file that a background writer refreshes (see 3.3).
- Changes to external board scripts. Those scripts can read `factory board --json` later.

## 1. Design decisions

### 1.1 The JSON stays facts

OBSERVED: the output rule is "the output gives facts only: a view makes its own state words" (`src/names.ts:1388-1394`). The design says the same for the live board.

So `factory board --json` gives fact rows only. It has no state word and no cell text. The mod does not build words from the facts. It draws the text view of factory (1.2).

### 1.2 One renderer

The text view of `factory board` is the only renderer of the board. It joins the views that exist today, by the same functions: `requestView`, `queueView`, `boardView` or `trackView`, the worker table (`cellsOf` in `src/commands/worker-list.ts`), and `machineOutput`.

The mod runs `factory board --width <columns>` and draws each line as it comes. So the tmux pane, the commands and the mod show the same strings. No word list exists twice.

### 1.3 The mod runs the command; no shared file

OBSERVED: the only follow loop (`src/board/follow.ts:68`) redraws only when `board.json` changes. It stops when stdout is not a terminal. No process runs a tick for a whole home.

So the mod runs `factory board` itself, on its own timer, and only while its pane is drawn. A shared file needs a writer process that nobody owns today. A writer in the follow pane ties the mod to one tmux pane. The cost of the run is one process start each 10 s for each open pane (INFERRED: small).

### 1.4 The schema id

The existing ids carry the command name: `factory.worker-list/v1`, `factory.machine/v1` (`src/names.ts:2214-2258`). So the id of `factory board` is `factory.board/v1`.

OBSERVED: the design (§4.15) plans `factory.board/v1` as the contract id of the board connector plugin. That plugin is not built (planned connector). The PR changes the planned connector id to `factory.board-connector/v1` in `docs/design.md`.

## 2. The command `factory board`

Files: `src/commands/board.ts` (new), `src/names.ts`, `src/cli/table.ts`, `src/commands/worker-list.ts`, `src/commands/request.ts`, `src/commands/queue.ts`, `src/commands/machine.ts`, `test/unit/board.test.ts` (new).

### 2.1 Inputs

- `--home <path>`: the usual `foundHomeOption`. The home comes from `locateHomeFolder`, as in `worker list`.
- `--width <n>`: the text width. A whole number from `boardWords.minWidth` (40) to `maxDisplayWidth` (120). Default `maxDisplayWidth`. A value out of range is a usage error (exit 2).
- `--json`: the global flag. With `--json`, `--width` has no effect.

### 2.2 The model

Behavior:
- Open the home once with `openBoard`, then read each section. The read takes no lock, as `item list` does (`src/commands/item.ts:483`).
- Build each section with the same pure function that its own command uses. Where a command builds its JSON inline, move that code into a named function in the same file, for example `workerRowsOf`, `requestRowsOf`, `queueRowsJsonOf`. Then both commands call it.
- A section that can not be read becomes `null`, and `faults` gets `{ section, error }`. The other sections still show. Exit 0 while one section reads. Exit 1 when no section reads.
- Items: open items only, each with `id`, `title`, `status`, `stage`, `stageAt`, `epic`. `epic` comes from the item record (`epicOf`, `src/commands/item.ts:215`). The list holds at most `boardWords.maxItems` (500) rows, and `itemsMore` gives the count past that number.

The document (key names go in `src/names.ts` as `boardDocKeys`):

```
{
  "schema": "factory.board/v1",
  "home": "<home path>",
  "requests": [ <the rows of request list --json> ] | null,
  "queue":    [ <the rows of queue show --json> ] | null,
  "workers":  [ <the worker rows of worker list --json> ] | null,
  "items":    [ { "id", "title", "status", "stage", "stageAt", "epic" } ] | null,
  "itemsMore": 0,
  "machine":  { "verdict", "facts", "power" } | null,
  "faults":   [ { "section": "machine", "error": "<text>" } ]
}
```

The document has no time field. A time field makes the output change on each run, and the facts give no use for it (INFERRED).

### 2.3 The text

Behavior:
- Print the sections in this order: requests, workers, board (items or tracks, as `item list` chooses), queue, machine.
- Each section starts with one heading line. The heading words go in `src/names.ts`. Sections have one blank line between them.
- Cut each line to `--width` with `displayLine` (`src/cli/output.ts:152`). Each view keeps its own line cap and its own "more" line.
- A faulted section prints its heading and one fault line.

Test (`test/unit/board.test.ts`, fake deps, a seeded home):
- `--json` gives the full document, compared with `toEqual`.
- The text is the heading lines plus the lines of each section view, for the same fixture.
- A broken `board.json` gives `items: null` and one fault. The other sections still show, and the exit is 0.
- `--width 39` and `--width 121` give a usage error. `--width 40` cuts each line to at most 40 characters.
- A home that is not found gives `factory.error/v1` with `--json`.

### 2.4 Registration

- Add `board` to `commands` (`src/names.ts:41-67`) and `schemaIds.board` (`src/names.ts:2214`).
- Add the `Command` entry to `commandTableFor` (`src/cli/table.ts:874`), as `machine` does (`src/cli/table.ts:490-495`).
- Put every new flag, word and number in `src/names.ts`. `test/unit/names.test.ts` fails on a stray literal.

## 3. The mod `plugins/factory-board/`

Files (all new):
- `plugins/factory-board/.claude-plugin/plugin.json`
- `plugins/factory-board/hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `plugins/factory-board/hooks/register.tsx`
- `plugins/factory-board/types/index.d.ts`: the `$.state` contract
- `plugins/factory-board/hooks/register.test.tsx`
- `plugins/factory-board/test/board.json`, `plugins/factory-board/test/board.txt`: the fixture output of `factory board` (3.5)
- `plugins/factory-board/README.md`
- `.claude-plugin/marketplace.json`

### 3.1 The manifest and options

`plugin.json`: `name: factory-board`, `version: 0.1.0`, a one-line description, `types: ./types/index.d.ts`, and `userConfig`:
- `command` (string, default `factory`): the factory program. A person sets a full path when `factory` is not on the PATH.
- `home` (string, default empty): the factory home. Empty means factory finds the home from the session folder.
- `refreshSeconds` (number, default 10, from 5 to 300).
- `open` (string, `options: ["asked", "auto"]`, default `asked`): `auto` opens the pane at session start.

### 3.2 Hooks

`session.start`:
- Register `/board`. A `command.run` hook for `/board` opens the pane with `$.ui.open({ id: "factory-board", title: "Factory board" })`.
- When `open` is `auto`, open the pane. OBSERVED in the API: a pane that the person did not ask for draws only from 144 columns (110 after one ask). Below that it waits. `/board` always opens it.
- Start one timer with `$.clock.every(refreshSeconds * 1000, tick)`.

`tick`:
- Do nothing when the pane is not drawn, or when a run is still open. So at most one run is open at a time.
- Run `[command, "board", "--width", <columns>]` with `$.process.run`. Add `["--home", home]` when `home` is set. Give `timeoutMs` as `refreshSeconds * 1000`, at most 30 000.
- `<columns>` is the last `bodyColumns` that the pane drew with, held to 40-120. A resize shows at the next tick.
- Exit 0: keep the lines, at most 400, in `$.state`. Keep the time of the run.
- A start failure: show one line: the command was not found, and set the `command` option.
- Another exit: show the first line of stderr, cut to the width. Keep the last good lines under it, marked with their time.

`ui.render` on `{ component: "Pane", requestId: "factory-board" }`:
- `const { Box, Text } = $.ui.resolve(e)`.
- First line, from the session itself: `context <n>% · 5h <n>% · 7d <n>% · updated <hh:mm:ss>`, from `$.session.usage()`. A missing value shows `?`.
- Then one `Text` for each line of factory, in `Box overflowX="scroll"`.
- The widget placement (desktop) shows the header and the request count from the command's summary line. A failed run also shows the fault and the last good time.

The mod does not run `factory board --json`. The text gives all that the pane draws. A later status line entry can use the JSON (follow-up).

### 3.3 Why no shared file

See 1.3. A file is a later option, when factory gets a process that runs for the whole home.

### 3.4 The `$.state` contract

`types/index.d.ts` declares, under `factory-board`: `lines: readonly string[]`, `fault: string | null`, `ranAt: string | null`, `columns: number`, `running: boolean`.

### 3.5 Tests of the mod

`register.test.tsx`, run by `claude plugin test plugins/factory-board`, with a mocked `$.process.run` that answers with `test/board.txt`. Loop each test over `['terminal', 'desktop']`.
- `/board` opens the pane, and the pane draws the header and each fixture line.
- A tick while a run is open starts no second run.
- A start failure draws the "command not found" line.
- An exit 1 draws the stderr line and keeps the last good lines.
- `open: auto` opens the pane at session start. `open: asked` does not.
- `home` set adds `--home <home>` to the argv.

### 3.6 Ship

`.claude-plugin/marketplace.json`:

```
{ "name": "factory",
  "owner": { "name": "dean0x" },
  "plugins": [ { "name": "factory-board", "source": "./plugins/factory-board",
                 "description": "A live factory board in a pane beside the chat" } ] }
```

Install line, for the README: `/plugin install factory-board --marketplace dean0x/factory`.

OBSERVED: `package.json` `files` is an allow-list without `plugins/`. So the npm package does not carry the mod, and the mod ships only through the repo. That is correct: the mod has no use without the marketplace install.

## 4. The contract test

Files: `test/unit/board-contract.test.ts` (new).

Behavior, for one fixture home:
- Each section of `factory board --json` equals the JSON of its own command (`request list`, `queue show`, `worker list`, `machine`). So the model can not drift from the commands.
- Each section of the `factory board` text equals the text of its own command at the same width.
- The committed `plugins/factory-board/test/board.txt` equals `factory board --width 100` for the same fixture. So a change in factory text fails here until the mod fixture is refreshed. The test message names the command that refreshes it.

## 5. Docs

- `docs/design.md`:
  - Add "The board command and the board mod" to §4.11, after "The other views".
  - Change the planned connector id to `factory.board-connector/v1` in §4.15.
  - Correct "The other views": `--follow` has no redraw limit, and it ends on a signal or when the parent ends (OBSERVED, `src/board/follow.ts`).
- `README.md`: the `factory board` line in the command list, and an install section for the mod.
- `plugins/factory-board/README.md`: what it shows, the options, the install line, the update steps (`claude plugin update`, then `/reload-plugins`).
- `CHANGELOG.md`: one entry under the next version.

## 6. Steps (small commits on `feat/board-mod`)

1. Check the mod API on this build: a mod with `.tsx`, `$.process.run`, `userConfig` options, and `claude plugin validate` and `claude plugin test` from a repo folder. Record the result in the PR comment.
2. Move the inline JSON builders of `worker list`, `request list`, `queue show` and `machine` into named functions. No change in output. Run their unit test files.
3. Add the names, the `board` command and the JSON model, with `test/unit/board.test.ts`.
4. Add the text view and `--width`, with tests.
5. Add `test/unit/board-contract.test.ts`.
6. Add the mod, its contract, its fixture and its tests. Run `claude plugin validate` and `claude plugin test`.
7. Add `.claude-plugin/marketplace.json`, and run `claude plugin validate .`.
8. Docs and changelog.
9. Full suite under the shared lock, then typecheck and lint.

## 7. Checks

- One test file at a time while building: `npx vitest run test/unit/board.test.ts` and so on.
- The full suite only in step 9, under the shared lock, with the log in a file.
- `npx tsc --noEmit` and the lint script, with zero warnings.
- `claude plugin validate plugins/factory-board`, `claude plugin validate .`, `claude plugin test plugins/factory-board`.

## 8. PR split

One PR. The command and the mod are releasable together, and each is small (INFERRED: about 600 lines of code and 500 lines of tests). Split into two PRs (the command first, then the mod) only if the review finds it too large for one round.

## 9. Risks

- **The mod API is early access.** It changes between releases. Mitigation: the mod uses few calls (`$.ui.open`, `ui.render`, `$.clock.every`, `$.process.run`, `$.session.usage`, `$.command.register`). Step 1 checks each one on the current build.
- **`$.process.run` and permission.** INFERRED: a mod process run asks for no tool permission. Step 1 and the live check confirm it.
- **The PATH of the session.** `factory` may not be on the PATH that the mod gets. Mitigation: the `command` option and a clear fault line.
- **Narrow panes.** In a narrow terminal, an `auto` pane waits. Mitigation: `/board` opens it at any width, and the default is `asked`.
- **Run cost.** Each open pane starts one process each `refreshSeconds`. Mitigation: no run while the pane is not drawn, and at most one open run.
- **Text drift.** The mod fixture can drift from factory text. Mitigation: the contract test (4).

## 10. Later

- A status line entry or a band above the prompt, from `factory board --json`, for example "2 requests wait".
- Buttons, for example to run `factory worker summon`.
- The planned live views workers table and the usage panel show in the mod with no mod change.
- A home process that writes a shared board file, so that many panes read one file.

## 11. Decisions taken in this plan

- 1.1: the JSON stays facts, and the mod draws factory text.
- 1.3: no shared file. The mod runs the command.
- 1.4: `factory board` uses `factory.board/v1`. The planned connector id changes to `factory.board-connector/v1`.
- 3.1: the default of `open` is `asked`.
