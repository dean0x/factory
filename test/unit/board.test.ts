import { join } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { files } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import { BOARD_HOME, BOARD_SECONDS, BOARD_TIME, CODEX_PATH, CODEX_SNAPSHOT, boardCommand, boardFixture } from '../helpers/board-fixture.js';
import { boardText, itemRecord } from '../helpers/board-node.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { captureSink } from '../helpers/sink.js';

const boardPath = join(layoutOf(BOARD_HOME).stateDir, files.board);

const expected = {
  schema: 'factory.board/v1', home: BOARD_HOME,
  requests: [{ id: 'D-1', title: 'Choose the view', options: ['a'], openedAt: BOARD_TIME, group: 'later', kind: 'decision', question: 'Which view?' }],
  queue: [{ position: 1, name: 'Ship the board', items: ['B-1'], note: 'Check the view', releaseGroup: 'Next', fields: { release: true } }],
  workers: [{
    id: 'alpha', project: 'web', pane: null, dead: false, state: 'unknown', contextPct: null, mark: null,
    itemId: 'B-1', itemTitle: 'Build the board', itemStatus: 'doing', stage: 'build', stageAt: BOARD_TIME,
    parkedCount: 0, paneLive: false, sessionState: 'unknown', activityAt: null, stalled: false, hold: 'none',
  }],
  items: [
    { id: 'B-1', title: 'Build the board', status: 'doing', stage: 'build', stageAt: BOARD_TIME, epic: 'Views' },
    { id: 'B-3', title: 'Next item', status: 'open', stage: null, stageAt: null, epic: null },
  ],
  itemsMore: 0,
  machine: {
    verdict: 'ok',
    facts: [
      { name: 'memory', value: 62, limit: 20, verdict: 'ok', note: null },
      { name: 'disk', value: 300, limit: 20, verdict: 'ok', note: null },
      { name: 'load', value: 2.2, limit: 8, verdict: 'ok', note: null },
      { name: 'cpus', value: 8, limit: null, verdict: 'ok', note: null },
    ],
    power: { source: 'ac', percent: 64 },
  },
  faults: [],
};

describe('board', () => {
  it('prints the whole facts document and changes no file', async () => {
    const deps = await boardFixture();
    const before = [...deps.files];
    const result = await boardCommand(deps, ['board', '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toEqual(expected);
    expect([...deps.files]).toEqual(before);
    expect(deps.calls.some((call) => call.command === 'git')).toBe(false);
  });

  it('keeps the readable sections when the board file is broken', async () => {
    const deps = await boardFixture();
    deps.seed(boardPath, '{');
    const result = await boardCommand(deps, ['board', '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ requests: expected.requests, items: null, queue: null, machine: expected.machine });
    expect(result.json).toHaveProperty('faults', [
      { section: 'items', error: expect.stringContaining('board.json') },
      { section: 'queue', error: expect.stringContaining('board.json') },
    ]);
  });

  it.each(['requests', 'workers', 'board', 'machine', 'power', 'all'] as const)('limits a slow %s read to its own sections', async (source) => {
    const deps = await boardFixture();
    const waits: { readonly ms: number; readonly signal: AbortSignal | undefined; readonly expire: () => void }[] = [];
    deps.sleep = (ms, signal?: AbortSignal) => new Promise<void>((resolve) => {
      waits.push({ ms, signal, expire: resolve });
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const run = deps.run;
    const slowPrograms: Readonly<Record<string, string | undefined>> = { workers: 'tmux', machine: 'df', power: 'pmset' };
    deps.run = (command, args, options) => source === 'all' || command === slowPrograms[source] ? new Promise(() => {}) : run(command, args, options);
    const lstat = deps.fs.lstat;
    const slowPaths: Readonly<Record<string, string | undefined>> = { requests: join(layoutOf(BOARD_HOME).stateDir, files.waiting), board: boardPath };
    deps.fs.lstat = (path) => path === slowPaths[source] || (source === 'all' && Object.values(slowPaths).includes(path))
      ? new Promise(() => {}) : lstat(path);
    let finished = false;
    const pending = boardCommand(deps, ['board', '--json']).then((result) => { finished = true; return result; });
    await yieldTurn();
    deps.advance(3000);
    waits.forEach((wait) => wait.expire());
    await yieldTurn();
    expect(finished).toBe(true);
    const result = await pending;
    const sections: Readonly<Record<string, readonly string[]>> = {
      requests: ['requests'], workers: ['workers'], board: ['workers', 'items', 'queue'], machine: ['machine'], power: ['machine'],
      all: ['requests', 'workers', 'items', 'queue', 'machine'],
    };
    const hidden = sections[source] ?? [];
    expect(result.code).toBe(source === 'all' ? 1 : 0);
    expect(result.json).toEqual({
      ...expected,
      ...Object.fromEntries(hidden.map((section) => [section, null])),
      faults: hidden.map((section) => ({ section, error: 'Section read timed out.' })),
    });
    expect(waits).toHaveLength(5);
    expect(waits.every((wait) => wait.ms === 3000 && wait.signal?.aborted)).toBe(true);
  });

  it('caps each process call below the shortest pane time limit and cancels the deadline waits', async () => {
    const deps = await boardFixture();
    const signals: (AbortSignal | undefined)[] = [];
    deps.sleep = (_, signal?: AbortSignal) => new Promise<void>((resolve) => {
      signals.push(signal);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    const result = await boardCommand(deps, ['board']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('\n\nMachine\n');
    expect(deps.calls).toContainEqual(expect.objectContaining({ command: 'tmux', timeoutMs: 3000 }));
    expect(deps.calls.every((call) => call.timeoutMs !== undefined && call.timeoutMs <= 3000)).toBe(true);
    expect(signals).toHaveLength(5);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });

  it('prints a heading and a fault line for a section that cannot be read', async () => {
    const deps = await boardFixture();
    deps.seed(join(layoutOf(BOARD_HOME).stateDir, files.waiting), '{');
    const result = await boardCommand(deps, ['board']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Requests\n.*waiting\.json.*\n\nWorkers\n/);
    expect(result.stdout).toContain('\n\nBoard\n');
    expect(result.stdout).toContain('\n\nQueue\n');
    expect(result.stdout).toContain('\n\nMachine\n');
  });

  it.each(['39', '121', '40.5', 'NaN', '1e2'])('refuses width %s before it reads a home', async (width) => {
    const sink = captureSink();
    const code = await runCli(['board', '--width', width], createFakeDeps(), sink);
    expect(code).toBe(2);
    expect(sink.errors.join('')).toContain('--width');
  });

  it('ignores width with JSON output', async () => {
    const deps = await boardFixture();
    const result = await boardCommand(deps, ['board', '--json', '--width', 'not a width']);
    expect(result.code).toBe(0);
    expect(result.json).toEqual(expected);
  });

  it('cuts text lines to the minimum width and removes hidden characters', async () => {
    const deps = await boardFixture();
    deps.seed(boardPath, boardText([itemRecord('B-1', { title: `\u001b[31m\n\tLong${'x'.repeat(100)}` })]));
    const result = await boardCommand(deps, ['board', '--width', '40']);
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n').find((line) => line.startsWith('(no track)'))).toBe('(no track)  1      B-1 no stage: [31m  L');
    expect(result.stdout.split('\n').every((line) => line.length <= 40)).toBe(true);
  });

  it('caps open items at 500 and gives the count past the cap', async () => {
    const deps = await boardFixture();
    deps.seed(boardPath, boardText(Array.from({ length: 503 }, (_, index) => itemRecord(`B-${index + 1}`, { status: index === 0 ? 'done' : 'open' }))));
    const result = await boardCommand(deps, ['board', '--json']);
    expect(result.json).toMatchObject({ itemsMore: 2, items: expect.any(Array) });
    expect(result.json).toHaveProperty('items.length', 500);
    expect(result.json).toHaveProperty('items.0.id', 'B-2');
    expect(result.json).toHaveProperty('items.499.id', 'B-501');
  });

  it.each(['duplicate id', 'invalid UTF-8', 'link'])('does not expose items from a board with a %s', async (fault) => {
    const deps = await boardFixture();
    if (fault === 'duplicate id') deps.seed(boardPath, boardText([itemRecord('B-1'), itemRecord('B-1')]));
    if (fault === 'invalid UTF-8') deps.invalidUtf8.add(boardPath);
    if (fault === 'link') {
      const original = deps.fs.lstat;
      deps.fs.lstat = (path) => path === boardPath ? Promise.resolve({ ok: true, value: 'link' }) : original(path);
    }
    const result = await boardCommand(deps, ['board', '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ items: null, queue: null });
    expect(result.json).toHaveProperty('faults.length', 2);
  });

  it.each(['requests', 'workers'] as const)('keeps other sections when the %s source is a link', async (section) => {
    const deps = await boardFixture();
    const layout = layoutOf(BOARD_HOME);
    const path = section === 'requests' ? join(layout.stateDir, files.waiting) : layout.workersDir;
    const original = deps.fs.lstat;
    deps.fs.lstat = (candidate) => candidate === path ? Promise.resolve({ ok: true, value: 'link' }) : original(candidate);
    const result = await boardCommand(deps, ['board', '--json']);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      [section]: null,
      items: expected.items,
      queue: expected.queue,
      machine: expected.machine,
      faults: [{ section, error: expect.any(String) }],
    });
  });

  it('prints an error document when no home is found', async () => {
    const sink = captureSink();
    const code = await runCli(['board', '--json'], createFakeDeps({ cwd: '/empty' }), sink);
    expect(code).toBe(2);
    expect(sink.out.join('')).toContain('"schema": "factory.error/v1"');
  });
});
