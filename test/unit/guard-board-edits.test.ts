import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { FactoryConfig } from '../../src/config/schema.js';
import { withGuards, type Deps } from '../../src/core/deps.js';
import { guardSourceFor } from '../../src/core/guard-source.js';
import { ok } from '../../src/core/result.js';
import { activeMachine, boardKeys, commands, files, guardIds, markLimits, maxFileBytes, nodeSendReasons, reservedFieldNames, schemaIds } from '../../src/names.js';
import { recipes } from '../../src/recipes/index.js';
import { mergedStage } from '../../src/recipes/software/board.js';
import { claimActiveMachine } from '../../src/state/active-machine.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import { BOARD_PATH, LAYOUT, type BoardRepo } from '../helpers/board-repo.js';
import { registerRoot } from '../helpers/fake-deps.js';
import { FAKE_GITHUB_TOKEN } from '../helpers/fake-secret.js';
import { HOME, linkAt } from '../helpers/guard-fixture.js';
import { FOLDER_ORIGINS, GUARD_STORE, guardStatesOf, guardStoreText, withGuardsOff, type GuardedSetup } from '../helpers/guarded-node.js';
import { sampleBoard, sampleConfigWithBoard } from '../helpers/sample-config.js';
import { captureSink } from '../helpers/sink.js';

const WORKER = 'alpha';
const START = boardText([itemRecord('B-1', { stage: 'ticket', lane: WORKER })], []);
const DOC = 'docs/design.md';
const DOT_DOC = 'docs/.hidden/notes.md';
const OTHER_MACHINE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** The setup of a node with the guard off and the matching owner record. */
const OFF: GuardedSetup = { off: [guardIds.boardEdits] };

/** The sample config with a tracker kind whose board lives at a provider. */
const hostedConfig = (): FactoryConfig => {
  const base = sampleConfigWithBoard();
  return { ...base, core: { ...base.core, tracker: { kind: 'jira', items: 'ACME', decisions: 'ACME-DEC', watch_interval: '5m' } } };
};

/** A board node whose local file holds each guard of the setup off, with the owner record unless the setup has none. */
const nodeOf = async (setup: GuardedSetup, origin: string, board = START, base: FactoryConfig = sampleConfigWithBoard()): Promise<BoardRepo> => {
  const off = setup.off ?? [];
  const config = withGuardsOff(base, off);
  const repo = await boardNode({ board, config });
  registerRoot(repo.deps, HOME, config.core.node.id, [], origin);
  if (setup.record !== false) repo.deps.seed(GUARD_STORE, guardStoreText(config.core.node.id, HOME, off, repo.deps.now()));
  return repo;
};

/** One command line of the node, with its exit code and its output. */
const runOn = async (deps: Deps, words: readonly string[]): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const sink = captureSink();
  const code = await runCli([...words, '--home', HOME], deps, sink);
  return { code, out: sink.out.join(''), err: sink.errors.join('') };
};

/** The docs of the item in the JSON output of an item command. */
const docsIn = (out: string): unknown => (JSON.parse(out) as { readonly item: { readonly docs: unknown } }).item.docs;

describe('the guard of board edits', () => {
  describe.each(FOLDER_ORIGINS)('in %s', (_folder, origin) => {
    it.each(guardStatesOf(guardIds.boardEdits))('item move to a stage that only a flow sets stops with exit 2 and no commit only while the guard counts as on: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      const result = await runOn(repo.deps, ['item', 'move', 'B-1', '--stage', mergedStage]);
      expect(result.code, result.err).toBe(on ? 2 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 1);
      expect(repo.textOf(files.board)?.includes(`"stage": "${mergedStage}"`)).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.boardEdits))('item update changes the worker of an item that names one only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      const result = await runOn(repo.deps, ['item', 'update', 'B-1', '--field', 'lane=beta']);
      expect(result.code, result.err).toBe(on ? 2 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 1);
      expect(repo.textOf(files.board)?.includes('"lane": "beta"')).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.boardEdits))('item doc links a path with a part that starts with a dot only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      repo.deps.seed(join(HOME, DOT_DOC), '# Notes\n');
      const result = await runOn(repo.deps, ['item', 'doc', 'B-1', DOT_DOC]);
      expect(result.code, result.err).toBe(on ? 4 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 1);
      expect(repo.textOf(files.board)?.includes(DOT_DOC)).toBe(!on);
    });

    it.each(guardStatesOf(guardIds.boardEdits))('the item view always hides the local config and shows the dot path only while the guard counts as off: %s', async (_state, setup, on) => {
      const docs = [DOT_DOC, files.localConfig, files.localConfig.toUpperCase()];
      const repo = await nodeOf(setup, origin, boardText([itemRecord('B-1', { stage: 'ticket', docs })], []));
      repo.deps.seed(join(HOME, DOC), '# Design\n');
      const result = await runOn(repo.deps, ['item', 'doc', 'B-1', DOC, '--json']);
      expect(result.code, result.err).toBe(0);
      expect(docsIn(result.out)).toEqual(on ? [DOC] : [DOT_DOC, DOC]);
    });

    it.each(guardStatesOf(guardIds.boardEdits))('track add and queue set for a hosted tracker kind write the local files only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin, START, hostedConfig());
      const track = await runOn(repo.deps, ['track', 'add', 'core', '--name', 'Core']);
      expect(track.code, track.err).toBe(on ? 4 : 0);
      const queue = await runOn(repo.deps, ['queue', 'set', 'Docs', '--item', 'B-1']);
      expect(queue.code, queue.err).toBe(on ? 4 : 0);
      expect(repo.commits).toHaveLength(on ? 0 : 2);
    });

    it.each(guardStatesOf(guardIds.boardEdits))('item note and item close with a reason for a hosted tracker kind write the local board only while the guard counts as off: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin, START, hostedConfig());
      const note = await runOn(repo.deps, ['item', 'note', 'B-1', 'Work started']);
      const commitsAfterNote = repo.commits.length;
      const close = await runOn(repo.deps, ['item', 'close', 'B-1', '--reason', 'Work is complete']);

      expect([note.code, close.code], `${note.err}${close.err}`).toEqual(on ? [4, 4] : [0, 0]);
      expect(commitsAfterNote).toBe(on ? 0 : 1);
      expect(repo.commits).toHaveLength(on ? 0 : 2);

      if (on) {
        for (const result of [note, close]) {
          expect(result.err).toContain('The jira board is not in this version.');
          expect(result.err).toContain('Set the tracker kind to local in the config, then run "factory item" again.');
        }
      }
    });

    it.each(guardStatesOf(guardIds.boardEdits))('the claim of the active machine warns about another machine only while the guard counts as on, and claims the mark with every value: %s', async (_state, setup, on) => {
      const repo = await nodeOf(setup, origin);
      repo.deps.seed(LAYOUT.activeMachineFile, `${JSON.stringify({ schema: schemaIds.activeMachine, machine: OTHER_MACHINE, at: '2029-12-31T10:00:00.000Z' })}\n`);
      const deps = withGuards(repo.deps, guardSourceFor(repo.deps, HOME, recipes, commands.start));
      const claimed = await claimActiveMachine(deps, HOME);
      expect(claimed).toMatchObject({ ok: true, value: { claimed: true } });
      expect(repo.deps.warned.some((line) => line.includes(OTHER_MACHINE))).toBe(on);
      expect(repo.deps.files.get(LAYOUT.activeMachineFile)?.includes(OTHER_MACHINE)).toBe(false);
      expect(repo.deps.files.get(LAYOUT.activeMachineFile)).toContain(`"${activeMachine.keys.machine}"`);
    });
  });

  describe.each(FOLDER_ORIGINS)('in %s, with the guard off and a matching record', (_folder, origin) => {
    it.each([
      ['a path above the factory folder', '../outside.md'],
      ['a path with a backslash', 'docs\\design.md'],
      ['a file over the size limit', 'docs/big.md'],
    ])('item doc still refuses %s with exit 2, because the doc link keeps its form and its size bound', async (_name, path) => {
      const repo = await nodeOf(OFF, origin);
      repo.deps.seed(join(HOME, 'docs/big.md'), 'x'.repeat(maxFileBytes + 1));
      const result = await runOn(repo.deps, ['item', 'doc', 'B-1', path]);
      expect(result.code, result.err).toBe(2);
      expect(repo.commits).toEqual([]);
    });

    it('item doc still stops with exit 4 for a doc in a linked folder, because a doc link stays in the factory folder', async () => {
      const repo = await nodeOf(OFF, origin);
      repo.deps.seed(join(HOME, DOC), '# Design\n');
      const result = await runOn(linkAt(repo.deps, join(HOME, 'docs')), ['item', 'doc', 'B-1', DOC]);
      expect(result.code, result.err).toBe(4);
      expect(repo.commits).toEqual([]);
    });

    it.each([
      ['on', [guardIds.boardEdits], 4],
      ['off', [guardIds.boardEdits, guardIds.secrets], 0],
    ] as const)('item doc checks a file below a dot folder with secrets %s', async (_state, off, exit) => {
      const repo = await nodeOf({ off: [...off] }, origin);
      repo.deps.seed(join(HOME, DOT_DOC), `# Notes\n${FAKE_GITHUB_TOKEN}\n`);
      const before = new Map(repo.deps.files);
      const result = await runOn(repo.deps, ['item', 'doc', 'B-1', DOT_DOC]);
      expect(result.code, result.err).toBe(exit);
      expect(`${result.out}${result.err}`.includes(FAKE_GITHUB_TOKEN)).toBe(false);
      if (exit === 4) {
        expect(result.err).toContain(nodeSendReasons.token);
        expect(repo.commits).toEqual([]);
        expect(repo.deps.files).toEqual(before);
      } else {
        expect(repo.commits).toHaveLength(1);
        expect(repo.textOf(files.board)).toContain(DOT_DOC);
      }
    });

    it('item doc refuses a file that becomes a link before the read', async () => {
      const repo = await nodeOf(OFF, origin);
      const full = join(HOME, DOT_DOC);
      repo.deps.seed(full, '# Notes\n');
      const fs: Deps['fs'] = {
        ...repo.deps.fs,
        openChecked: async (path, request) => path === full ? ok({ state: 'link' }) : repo.deps.fs.openChecked(path, request),
      };
      const result = await runOn({ ...repo.deps, fs }, ['item', 'doc', 'B-1', DOT_DOC]);
      expect(result.code, result.err).toBe(4);
      expect(repo.commits).toEqual([]);
    });

    it('item doc still stops with exit 4 for the local config, because it holds the owner prefix, and a path with a dot part goes', async () => {
      const repo = await nodeOf(OFF, origin);
      repo.deps.seed(join(HOME, DOT_DOC), '# Notes\n');
      const local = await runOn(repo.deps, ['item', 'doc', 'B-1', files.localConfig]);
      expect(local.code, local.err).toBe(4);
      expect(repo.commits).toEqual([]);
      const dot = await runOn(repo.deps, ['item', 'doc', 'B-1', DOT_DOC]);
      expect(dot.code, dot.err).toBe(0);
      expect(repo.textOf(files.board)?.includes(DOT_DOC)).toBe(true);
      expect(repo.textOf(files.board)?.includes(files.localConfig)).toBe(false);
    });

    it('item add still stops with exit 4 for a board file that is a link, because a board read and write stay in the state folder', async () => {
      const repo = await nodeOf(OFF, origin);
      const result = await runOn(linkAt(repo.deps, BOARD_PATH), ['item', 'add', '--title', 'New', '--field', 'priority=P1']);
      expect(result.code, result.err).toBe(4);
      expect(repo.commits).toEqual([]);
    });

    it('item update still stops with exit 1 when the new board text is over the size cap of a board file', async () => {
      const item = (pad: string) => boardText([itemRecord('B-1', { stage: 'ticket', notes: pad })], []);
      const board = item('x'.repeat(maxFileBytes - 8 - Buffer.byteLength(item(''), 'utf8')));
      const repo = await nodeOf(OFF, origin, board);
      const result = await runOn(repo.deps, ['item', 'update', 'B-1', '--title', 'A title that makes the board text too large']);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain(String(maxFileBytes));
      expect(repo.commits).toEqual([]);
      expect(repo.textOf(files.board)).toBe(board);
    });

    it('item update still refuses an empty worker value with exit 2, because no board write holds an empty value', async () => {
      const repo = await nodeOf(OFF, origin);
      const result = await runOn(repo.deps, ['item', 'update', 'B-1', '--field', 'lane=']);
      expect(result.code, result.err).toBe(2);
      expect(repo.commits).toEqual([]);
    });

    const full = Array.from({ length: markLimits.maxFormerWorkers }, (_, i) => `worker-${i + 1}`);
    it.each([
      ['a full list', full, 2, `${markLimits.maxFormerWorkers} former workers`],
      ['a list with a value that is not text', [7], 1, 'is not a list of text'],
    ])('item update keeps the worker if the former-worker mark has %s', async (_name, former, code, reason) => {
      const board = boardText([itemRecord('B-1', { lane: WORKER, [boardKeys.unassignedFrom]: former })], []);
      const repo = await nodeOf(OFF, origin, board);
      const result = await runOn(repo.deps, ['item', 'update', 'B-1', '--field', 'lane=beta']);
      expect(result.code, result.err).toBe(code);
      expect(result.err).toContain(reason);
      expect(repo.commits).toEqual([]);
      expect(repo.textOf(files.board)).toBe(board);
    });

    it('item update keeps an existing former-worker mark once when the list is full', async () => {
      const former = [WORKER, ...full.slice(1)];
      const board = boardText([itemRecord('B-1', { lane: WORKER, [boardKeys.unassignedFrom]: former })], []);
      const repo = await nodeOf(OFF, origin, board);
      const result = await runOn(repo.deps, ['item', 'update', 'B-1', '--field', 'lane=beta']);
      expect(result.code, result.err).toBe(0);
      const stored: unknown = JSON.parse(repo.textOf(files.board) ?? 'null');
      expect(stored).toMatchObject({ items: [{ lane: 'beta', [boardKeys.unassignedFrom]: former }] });
    });

    it('item move stops with exit 1 and makes no change if the config has a reserved field name', async () => {
      const board = sampleBoard();
      const reserved = sampleConfigWithBoard({ ...board, fields: [...(board.fields ?? []), { name: reservedFieldNames[0] ?? '', target: 'item', kind: 'token', required: false }] });
      const repo = await nodeOf(OFF, origin, START, reserved);
      const result = await runOn(repo.deps, ['item', 'move', 'B-1', '--stage', mergedStage]);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain('board.fields.4.name');
      expect(repo.commits).toEqual([]);
      expect(repo.textOf(files.board)).toBe(START);
    });
  });
});
