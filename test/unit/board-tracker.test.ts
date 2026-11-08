import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardConnector, DecisionAskInput } from '../../src/board/contract.js';
import { createLocalBoard } from '../../src/board/local.js';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { Deps } from '../../src/core/deps.js';
import { commands, commandText, files as fileNames, stateLock, values } from '../../src/names.js';
import { softwareBoard } from '../../src/recipes/software/board.js';
import { boardRepo, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { withFsWatch } from '../helpers/fake-deps.js';
import { HOME, HOOK } from '../helpers/guard-fixture.js';
import { sampleBoard } from '../helpers/sample-config.js';

const QUEUE = 'merge';
const LOCK_FILE = join(LAYOUT.locksDir, `${stateLock.name}${stateLock.lock.suffix}`);
const DOC_PATH = 'docs/design.md';
const HOSTED_LINE = 'Hosted boards come in FAC-M3 (provider plugin).';

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

const repoWith = async (): Promise<BoardRepo> => {
  const repo = await boardRepo({ board: START_BOARD });
  repo.deps.seed(join(HOME, DOC_PATH), '# Design\n');
  return repo;
};

const connectorOf = (deps: Deps, tracker: string): BoardConnector =>
  createLocalBoard(deps, LAYOUT, { queueKey: QUEUE, recipe: softwareBoard, config: sampleBoard(), command: commands.start, tracker });

type Write = (connector: BoardConnector) => Promise<CliResult<unknown>>;

/** Each write of the connector, with input that the local connector accepts. */
const WRITES: readonly (readonly [string, Write])[] = [
  ['item add', (c) => c.addItem({ title: 'Second', fields: { priority: 'P1' } })],
  ['item update', (c) => c.updateItem('B-1', { title: 'Changed' })],
  ['item move to a state', (c) => c.moveItem('B-1', { state: 'doing' })],
  ['item move to a stage', (c) => c.moveItem('B-1', { stage: 'building' })],
  ['item close', (c) => c.closeItem('B-1')],
  ['track add', (c) => c.addTrack({ id: 'core', name: 'Core', roadmap: true })],
  ['doc link', (c) => c.linkDoc({ id: 'B-1', path: DOC_PATH })],
  ['decision ask', (c) => c.askDecision(DECISION)],
];

/** Each write of the connector, with input that the local connector refuses with exit 2. */
const BAD_WRITES: readonly (readonly [string, Write])[] = [
  ['item add', (c) => c.addItem({ title: 'x'.repeat(101), fields: { priority: 'P1' } })],
  ['item update', (c) => c.updateItem('nope', { title: 'Changed' })],
  ['item move', (c) => c.moveItem('nope', { state: 'unknown' })],
  ['item close', (c) => c.closeItem('nope')],
  ['track add', (c) => c.addTrack({ id: 'Bad Id', name: '', roadmap: true })],
  ['doc link', (c) => c.linkDoc({ id: 'B-1', path: '../outside.md' })],
  ['decision ask', (c) => c.askDecision({ title: '', question: '', options: [] })],
];

const FILES = [fileNames.board, fileNames.waiting, fileNames.decisionLog];

describe('a hosted tracker kind: each board write refuses with exit 4 and one line (TP-67)', () => {
  const CASES = values.trackerHosted.flatMap((kind) => WRITES.map(([name, write]) => [kind, name, write] as const));

  it.each(CASES)('M5-1b TP-67 %s: %s exits 4 with one line that says hosted boards come in FAC-M3 (provider plugin)', async (kind, _name, write) => {
    const repo = await repoWith();
    const error = errorOf(await write(connectorOf(repo.deps, kind)));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(kind);
    expect(error.message).toContain(HOSTED_LINE);
    expect(error.message).not.toContain('\n');
  });

  it('M5-1b TP-67 names the command to run again in the remedy line, and the local tracker kind', async () => {
    const repo = await repoWith();
    const error = errorOf(await connectorOf(repo.deps, 'github').addItem({ title: 'Second', fields: { priority: 'P1' } }));
    expect(error.hint).toContain(commandText(commands.start));
    expect(error.hint).toContain(values.trackerLocal);
    expect(error.hint).not.toContain('\n');
  });

  it.each(BAD_WRITES)('M5-1b TP-67 %s with bad input exits 4 too, because the refusal comes before the input check', async (_name, write) => {
    const repo = await repoWith();
    const error = errorOf(await write(connectorOf(repo.deps, 'jira')));
    expect(exitCodeOf[error.kind]).toBe(4);
    expect(error.message).toContain(HOSTED_LINE);
  });

  it('M5-1b TP-67 exits 4 for the hosted kind when the delete guard is off, because the refusal comes before the guard check', async () => {
    const repo = await repoWith();
    repo.deps.files.delete(HOOK);
    const error = errorOf(await connectorOf(repo.deps, 'linear').closeItem('B-1'));
    expect(error.message).toContain(HOSTED_LINE);
  });

  it('M5-1b TP-67 names the kind of the setup in the line, cleaned of control characters', async () => {
    const repo = await repoWith();
    const error = errorOf(await connectorOf(repo.deps, 'bad\nkind').closeItem('B-1'));
    expect(error.message).toContain('bad kind board');
    expect(error.message).not.toContain('\n');
  });
});

describe('a hosted tracker kind: a refused write changes nothing (TP-68)', () => {
  it.each(WRITES)('M5-1b TP-68 %s makes no commit, takes no lock, makes no copy and leaves the files byte for byte', async (_name, write) => {
    const repo = await repoWith();
    const before = new Map(repo.deps.files);
    const touched: string[] = [];
    const watched = withFsWatch(repo.deps, (method, path) => touched.push(`${method} ${path}`));
    expect((await write(connectorOf(watched, 'github'))).ok).toBe(false);
    expect(touched).toEqual([]);
    expect(repo.gitCommands()).toEqual([]);
    expect(repo.commits).toEqual([]);
    expect(repo.deps.files.has(LOCK_FILE)).toBe(false);
    expect(repo.deps.files).toEqual(before);
    expect(repo.deps.warned).toEqual([]);
  });

  it('M5-1b TP-68 leaves the board file, the waiting file and the decision log as they were after every refused write', async () => {
    const repo = await repoWith();
    const before = FILES.map((file) => repo.textOf(file));
    const connector = connectorOf(repo.deps, 'github');
    for (const [, write] of WRITES) await write(connector);
    expect(FILES.map((file) => repo.textOf(file))).toEqual(before);
    expect(repo.textOf(fileNames.board)).toBe(START_BOARD);
    expect(repo.commits).toEqual([]);
  });
});

describe('a hosted tracker kind reads the local files; the local kind writes (TP-69)', () => {
  it.each(values.trackerHosted)('M5-1b TP-69 reads the items, the tracks and the changes from the local files for %s, and exits 0', async (kind) => {
    const repo = await repoWith();
    const connector = connectorOf(repo.deps, kind);
    expect(connector.kind).toBe(kind);
    expect(valueOf(await connector.listItems({ all: true })).map((item) => item.id)).toEqual(['B-1']);
    expect(valueOf(await connector.listTracks())).toEqual([]);
    expect(valueOf(await connector.readChanges(null))).toEqual({ events: [], cursor: null });
    expect(repo.deps.warned).toEqual([]);
    expect(repo.commits).toEqual([]);
  });

  it.each(WRITES)('M5-1b TP-69 with the local kind, %s makes one commit and prints no tracker line', async (_name, write) => {
    const repo = await repoWith();
    const connector = connectorOf(repo.deps, values.trackerLocal);
    expect(connector.kind).toBe(values.trackerLocal);
    expect((await write(connector)).ok).toBe(true);
    expect(repo.commits).toHaveLength(1);
    expect(repo.deps.warned).toEqual([]);
  });

  it('M5-1b TP-69 with the local kind, a write that fails keeps its own exit kind and prints no tracker line', async () => {
    const repo = await repoWith();
    const error = errorOf(await connectorOf(repo.deps, values.trackerLocal).addItem({ title: 'x'.repeat(101), fields: { priority: 'P1' } }));
    expect(exitCodeOf[error.kind]).toBe(2);
    expect(repo.deps.warned).toEqual([]);
    expect(repo.commits).toEqual([]);
  });
});
