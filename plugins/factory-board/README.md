# Factory board mod

Show the factory board in a Claude Code pane beside the chat. Factory supplies all board text.
The mod adds this session's context percent, five-hour and seven-day limits, and the UTC time of the last good run.
A missing value shows `?`. A desktop widget shows this header and the request count instead of the board text.

## Install

Install factory first. Use a version that has `factory board`.
The mod uses the early-access mod API of Claude Code 2.1.326. Later builds can change this API.

At the prompt of a Claude Code terminal session, run:

```text
/plugin install factory-board --marketplace dean0x/factory
```

Accept the marketplace with `y`, then select the install scope and the options.
Run `/board` to open the pane. The default opens no pane until you ask.

## Options

Set these fields in the plugin options of Claude Code:

| Field | Default | Use |
| --- | --- | --- |
| `command` | `factory` | Program name without `/`, or an absolute path. Do not add arguments or shell quotes. |
| `home` | empty | Factory folder. With no value, factory finds the home from the session folder. |
| `refreshSeconds` | `10` | Whole seconds from 5 to 300. The mod holds a value outside this range to the nearest end. |
| `open` | `asked` | `asked` waits for `/board`. `auto` asks for a pane at session start. |

When factory is not on the session PATH, set `command` to its absolute path.
A path with spaces stays one argument. The mod does not start a shell.
An empty or blank `command` uses `factory`. A relative path shows an option hint and starts no program.
When an automatic pane has too little room, Claude Code leaves it undrawn. Run `/board` to open it at any width.

## Refresh and faults

The mod runs `factory board --width N` only while the pane is visible.
It uses the last body width, held from 40 to 120 columns. A resize takes effect at the next tick.
At most one run stays open. Each run has an explicit timeout: the refresh interval, at most 30 seconds.
The timer stops when the session ends.

The mod keeps at most 400 plain text lines. It removes terminal controls from process text.
A failed run shows one fault line and keeps the last good text with its UTC time.
A desktop widget also shows the fault and marks the request count with its last good time.
A later successful run clears the fault. No background writer or shared text file is required.
The pane reads no JSON and adds no board state words.

## Update

From a shell, run:

```sh
claude plugin update factory-board@factory
```

Then run `/reload-plugins` in the Claude Code session.
The mod ships through this repo's marketplace. The npm package does not contain it.

## Tests

From the repo root, run:

```sh
claude plugin validate plugins/factory-board
claude plugin validate .
claude plugin test plugins/factory-board
npx vitest run test/unit/board-contract.test.ts
```

The contract test compares `test/board.txt` with `factory board --width 100` for one shared fixture home.
It also checks `test/board.json` and `test/board.ts`. The mod test host imports code modules, so it uses the generated text export.
To refresh all three files after an intended text change, run:

```sh
UPDATE_BOARD_FIXTURE=1 npx vitest run test/unit/board-contract.test.ts
```
