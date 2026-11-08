import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardConnector, DecisionAskInput } from '../../src/board/contract.js';
import { createLocalBoard, unbuiltTracker, type TrackerCopy, type TrackerWrite } from '../../src/board/local.js';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { commands, files as fileNames, stateLock, values } from '../../src/names.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { boardRepo, LAYOUT, trackerSpy, type BoardRepo } from '../helpers/board-repo.js';
import { HOME, HOOK } from '../helpers/guard-fixture.js';
import { sampleBoard } from '../helpers/sample-config.js';

const QUEUE = 'merge';
const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);
const DOC_PATH = 'docs/design.md';
const GOVERNS = 'The local file governs.';

const START_BOARD = `${JSON.stringify({ [QUEUE]: [], items: [{ id: 'B-1', title: 'First', status: 'open', stage: 'ticket' }], tracks: [] }, null, 2)}\n`;

const DECISION: DecisionAskInput = {
  title: 'Pick a plan',
  question: 'Which plan do we build?',
  options: [{ key: 'a', text: 'Plan A' }],
};

const valueOf = <T>(result: CliResult<T>): T => {
  if (!result.ok) throw new Error(`expected a value, got: ${result.error.message}`);
  return result.value;
};

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected an error');
  return result.error;
};

const repoWith = async (board: string = START_BOARD): Promise<BoardRepo> => {
  const repo = await boardRepo({ board });
  repo.deps.seed(join(HOME, DOC_PATH), '# Design\n');
  return repo;
};

const connectorOf = (deps: Deps, tracker: TrackerCopy): BoardConnector =>
  createLocalBoard(deps, LAYOUT, { queueKey: QUEUE, recipe: softwareBoard, config: sampleBoard(), command: commands.start, tracker });

describe('a hosted tracker kind: the copy after the local commit (TP-67)', () => {
  it.each(values.trackerHosted)('M5-1b TP-67 commits the local files first, then warns once with the item and the rule, for %s', async (kind) => {
    const repo = await repoWith();
    const seen: number[] = [];
    const watching: Deps = {
      ...repo.deps,
      warn: (line) => {
        seen.push(repo.commits.length);
        repo.deps.warn(line);
      },
    };
    const added = valueOf(await connectorOf(watching, unbuiltTracker(kind)).addItem({ title: 'Second', fields: { priority: 'P1' } }));
    expect(added.id).toBe('B-2');
    expect(repo.commits.map((commit) => commit.staged)).toEqual([[fileNames.board]]);
    expect(seen).toEqual([1]);
    expect(repo.deps.warned).toHaveLength(1);
    const [line = ''] = repo.deps.warned;
    expect(line).toContain('B-2');
    expect(line).toContain(kind);
    expect(line).toContain(GOVERNS);
    expect(line).not.toContain('\n');
  });

  it('M5-1b TP-67 warns once when the copy works, with the item and the rule', async () => {
    const repo = await repoWith();
    const spy = trackerSpy('github');
    valueOf(await connectorOf(repo.deps, spy.tracker).addItem({ title: 'Second', fields: { priority: 'P1' } }));
    expect(spy.calls).toEqual([{ what: 'item added', id: 'B-2' }]);
    expect(repo.deps.warned).toHaveLength(1);
    expect(repo.deps.warned[0]).toContain('B-2');
    expect(repo.deps.warned[0]).toContain(GOVERNS);
  });

  type Write = (connector: BoardConnector) => Promise<CliResult<unknown>>;
  const WRITES: readonly (readonly [string, Write, TrackerWrite])[] = [
    ['item add', (c) => c.addItem({ title: 'Second', fields: { priority: 'P1' } }), { what: 'item added', id: 'B-2' }],
    ['item update', (c) => c.updateItem('B-1', { title: 'Changed' }), { what: 'item updated', id: 'B-1' }],
    ['item move to a state', (c) => c.moveItem('B-1', { state: 'doing' }), { what: 'item moved', id: 'B-1' }],
    ['item move to a stage', (c) => c.moveItem('B-1', { stage: 'building' }), { what: 'item moved', id: 'B-1' }],
    ['item close', (c) => c.closeItem('B-1'), { what: 'item closed', id: 'B-1' }],
    ['track add', (c) => c.addTrack({ id: 'core', name: 'Core', roadmap: true }), { what: 'track added', id: 'core' }],
    ['doc link', (c) => c.linkDoc({ id: 'B-1', path: DOC_PATH }), { what: 'doc linked', id: 'B-1' }],
    ['decision ask', (c) => c.askDecision(DECISION), { what: 'decision asked', id: 'D-1' }],
  ];

  it.each(WRITES)('M5-1b TP-67 copies %s once, with the id that the write made, and warns once', async (_name, write, copied) => {
    const repo = await repoWith();
    const spy = trackerSpy('github');
    expect((await write(connectorOf(repo.deps, spy.tracker))).ok).toBe(true);
    expect(spy.calls).toEqual([copied]);
    expect(repo.commits).toHaveLength(1);
    expect(repo.deps.warned).toHaveLength(1);
    expect(repo.deps.warned[0]).toContain(copied.id);
  });
});

describe('a hosted tracker kind: a copy that fails (TP-68)', () => {
  it('M5-1b TP-68 keeps the commit and the files, runs the copy outside the lock, and warns once with the item and the reason', async () => {
    const repo = await repoWith();
    const during: { locked: boolean; commits: number }[] = [];
    const spy = trackerSpy('jira', failure('the service is down'), () =>
      during.push({ locked: repo.deps.files.has(LOCK_FILE), commits: repo.commits.length }),
    );
    const added = await connectorOf(repo.deps, spy.tracker).addItem({ title: 'Second', fields: { priority: 'P1' } });
    expect(valueOf(added).id).toBe('B-2');
    expect(during).toEqual([{ locked: false, commits: 1 }]);
    expect(repo.commits).toHaveLength(1);
    expect(repo.textOf(fileNames.board)).toContain('"id": "B-2"');
    expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
    expect(repo.deps.warned).toHaveLength(1);
    const [line = ''] = repo.deps.warned;
    expect(line).toContain('B-2');
    expect(line).toContain('jira');
    expect(line).toContain('the service is down');
    expect(line).toContain(GOVERNS);
  });

  it('M5-1b TP-68 cleans the reason of the copy, so the warning is one line', async () => {
    const repo = await repoWith();
    const bidi = String.fromCodePoint(0x202e);
    const spy = trackerSpy('jira', failure(`down\nsecond line${bidi}`));
    valueOf(await connectorOf(repo.deps, spy.tracker).addItem({ title: 'Second', fields: { priority: 'P1' } }));
    expect(repo.deps.warned).toHaveLength(1);
    const [line = ''] = repo.deps.warned;
    expect(line).toContain('down second line');
    expect(line).not.toContain('\n');
    expect(line).not.toContain(bidi);
  });

  it('M5-1b TP-68 says that no board connector exists yet, with the placeholder of this version', async () => {
    const repo = await repoWith();
    valueOf(await connectorOf(repo.deps, unbuiltTracker('linear')).closeItem('B-1'));
    expect(repo.commits).toHaveLength(1);
    expect(repo.deps.warned).toHaveLength(1);
    expect(repo.deps.warned[0]).toContain('B-1');
    expect(repo.deps.warned[0]).toContain('linear');
  });
});

describe('a hosted tracker kind: a local write that fails or changes nothing (TP-69)', () => {
  it('M5-1b TP-69 makes no tracker call and no warning when the guard is off, and exits 4', async () => {
    const repo = await repoWith();
    repo.deps.files.delete(HOOK);
    const spy = trackerSpy('github');
    const error = errorOf(await connectorOf(repo.deps, spy.tracker).addItem({ title: 'Second', fields: { priority: 'P1' } }));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(spy.calls).toEqual([]);
    expect(repo.deps.warned).toEqual([]);
    expect(repo.commits).toEqual([]);
    expect(repo.textOf(fileNames.board)).toBe(START_BOARD);
  });

  it('M5-1b TP-69 makes no tracker call when the board is not readable, and exits 1', async () => {
    const repo = await repoWith('not json');
    const spy = trackerSpy('github');
    const error = errorOf(await connectorOf(repo.deps, spy.tracker).addTrack({ id: 'core', name: 'Core', roadmap: true }));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(spy.calls).toEqual([]);
    expect(repo.deps.warned).toEqual([]);
  });

  it('M5-1b TP-69 makes no tracker call when the input is refused before the lock, and exits 2', async () => {
    const repo = await repoWith();
    const spy = trackerSpy('github');
    const error = errorOf(await connectorOf(repo.deps, spy.tracker).addItem({ title: 'x'.repeat(101), fields: { priority: 'P1' } }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(spy.calls).toEqual([]);
    expect(repo.deps.warned).toEqual([]);
  });

  it('M5-1b TP-69 makes no tracker call and no warning for a write that changes nothing, because no commit was made', async () => {
    const repo = await repoWith();
    const spy = trackerSpy('github');
    const connector = connectorOf(repo.deps, spy.tracker);
    valueOf(await connector.updateItem('B-1', { title: 'First' }));
    valueOf(await connector.moveItem('B-1', { state: 'open' }));
    valueOf(await connector.moveItem('B-1', { stage: 'ticket' }));
    expect(repo.commits).toEqual([]);
    expect(spy.calls).toEqual([]);
    expect(repo.deps.warned).toEqual([]);
  });

  it('M5-1b TP-69 makes no tracker call for a read', async () => {
    const repo = await repoWith();
    const spy = trackerSpy('github');
    const connector = connectorOf(repo.deps, spy.tracker);
    valueOf(await connector.listItems({ all: true }));
    valueOf(await connector.listTracks());
    valueOf(await connector.readChanges(null));
    expect(spy.calls).toEqual([]);
    expect(repo.deps.warned).toEqual([]);
  });
});
