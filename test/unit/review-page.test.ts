import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { files } from '../../src/names.js';
import { boardNode, boardText, itemRecord } from '../helpers/board-node.js';
import type { BoardRepo } from '../helpers/board-repo.js';
import { HOME } from '../helpers/guard-fixture.js';
import { captureSink } from '../helpers/sink.js';

/**
 * The exit check of the board data for an outside review page. The test uses the command line or files of an older version.
 * It reads only the texts of `board.json` and `waiting.json`, with `JSON.parse`, to build plain item and decision cards.
 * It imports nothing from the board source. The card code stays in this test, because a view lives outside the core.
 */

const TITLE = 'Build the login page';
const DOC = 'docs/plan.md';

/** An item as `board.json` stores it. A key that a version did not write is missing. */
interface StoredItem {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly stage?: string;
  /** An owner field of the sample setup. The board stores an owner field as a key of the item. */
  readonly priority?: string;
  readonly epic?: string;
  readonly stages?: readonly string[];
  readonly docs?: readonly string[];
}

interface Card {
  readonly title: string;
  readonly epic: string | null;
  /** The stages in the order of the stored copy. Exactly one entry is current, when the item is at a listed stage. */
  readonly strip: readonly { readonly name: string; readonly current: boolean }[];
  readonly docs: readonly string[];
}

/** Runs one command that must exit 0 with no error text. */
const mustRun = async (repo: BoardRepo, argv: readonly string[]): Promise<void> => {
  const sink = captureSink();
  const code = await runCli([...argv, '--home', HOME], repo.deps, sink);
  expect({ argv, code, error: sink.errors.join('') }).toEqual({ argv, code: 0, error: '' });
};

/** The items of the board file, read from its text alone. */
const itemsOf = (repo: BoardRepo): readonly StoredItem[] => (JSON.parse(repo.textOf(files.board) ?? '') as { items: StoredItem[] }).items;

const MAX_DOC_PATH_CHARS = 200;
const HIDDEN_OR_BACKSLASH = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u;

/**
 * The name check that the README gives to `docs`, as a view applies it: a plain relative path of at most 200 characters, with no
 * hidden character, no backslash, no part that starts with a dot, and not `factory.local.yaml` in any letter case. It reads the text
 * and no file. The file checks are the job of a view too, but this card never reads a file.
 */
const passesNameCheck = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_DOC_PATH_CHARS &&
  !HIDDEN_OR_BACKSLASH.test(path) &&
  path.split('/').every((part) => part !== '' && !part.startsWith('.')) &&
  path.toLowerCase() !== 'factory.local.yaml';

/** The card of a view. An item with none of the new keys gives no epic, an empty strip and no docs. A path that fails the name check is not shown. */
const cardOf = (item: StoredItem): Card => ({
  title: item.title,
  epic: item.epic ?? null,
  strip: (item.stages ?? []).map((name) => ({ name, current: name === item.stage })),
  docs: (item.docs ?? []).filter(passesNameCheck),
});

const currentOf = (card: Card): string[] => card.strip.filter((entry) => entry.current).map((entry) => entry.name);

const factoryWithItem = async (): Promise<BoardRepo> => {
  const repo = await boardNode();
  repo.deps.seed(join(HOME, DOC), '# Plan\n');
  await mustRun(repo, ['item', 'add', '--title', TITLE, '--epic', 'Launch', '--field', 'priority=P1']);
  await mustRun(repo, ['item', 'doc', 'B-1', DOC]);
  await mustRun(repo, ['item', 'move', 'B-1', '--stage', 'building']);
  return repo;
};

describe('the card of an item, from the text of board.json alone', () => {
  it('shows the epic, a strip of the stages with the current stage marked, and the doc', async () => {
    const repo = await factoryWithItem();
    const [item] = itemsOf(repo);
    const card = cardOf(item as StoredItem);
    expect(card.title).toBe(TITLE);
    expect(card.epic).toBe('Launch');
    expect(card.strip.map((entry) => entry.name)).toEqual(['ticket', 'planning', 'plan-approved', 'building', 'review', 'fixes', 'merged', 'released']);
    expect(currentOf(card)).toEqual(['building']);
    expect(card.docs).toEqual([DOC]);
  });

  it('keeps the strip of the add and moves the current mark when the item moves to another stage', async () => {
    const repo = await factoryWithItem();
    const before = cardOf(itemsOf(repo)[0] as StoredItem);
    await mustRun(repo, ['item', 'move', 'B-1', '--stage', 'review']);
    const after = cardOf(itemsOf(repo)[0] as StoredItem);
    expect(after.strip.map((entry) => entry.name)).toEqual(before.strip.map((entry) => entry.name));
    expect(currentOf(after)).toEqual(['review']);
  });

  it('gives a card with no epic, an empty strip and no docs for an old item that a command moves', async () => {
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { title: TITLE, stage: 'building' })]) });
    await mustRun(repo, ['item', 'move', 'B-1', '--stage', 'review']);
    const [item] = itemsOf(repo);
    expect(item?.stage).toBe('review');
    expect(cardOf(item as StoredItem)).toEqual({ title: TITLE, epic: null, strip: [], docs: [] });
  });

  it('leaves a stored doc path out of the card when the path fails the name check of the README', async () => {
    const failing = [
      '/etc/plan.md',
      '../outside.md',
      'docs/../plan.md',
      '.factory/roles/worker.md',
      'docs/.draft.md',
      'Factory.Local.YAML',
      'docs\\plan.md',
      'docs/pl​an.md',
      `docs/${'a'.repeat(200)}.md`,
    ];
    const repo = await boardNode({ board: boardText([itemRecord('B-1', { title: TITLE, docs: [DOC, ...failing] })]) });
    await mustRun(repo, ['item', 'move', 'B-1', '--stage', 'review']);
    expect(cardOf(itemsOf(repo)[0] as StoredItem).docs).toEqual([DOC]);
  });
});

/** The key of a stored item that a view groups its columns by. */
type ColumnKey = 'status' | 'stage' | 'priority';

/** The columns of a view for one key: each value, with the ids of its items in the order of the `items` list. A view does not sort. */
const columnsOf = (items: readonly StoredItem[], key: ColumnKey): Readonly<Record<string, readonly string[]>> =>
  items.reduce<Readonly<Record<string, readonly string[]>>>((columns, item) => {
    const value = item[key] ?? '(none)';
    return { ...columns, [value]: [...(columns[value] ?? []), item.id] };
  }, {});

/** The state, stage and priority columns of the board file, read from its text alone. */
const columnsNow = (repo: BoardRepo) => {
  const items = itemsOf(repo);
  return { state: columnsOf(items, 'status'), stage: columnsOf(items, 'stage'), priority: columnsOf(items, 'priority') };
};

/** Four open items in the add order B-1 to B-4: B-1 and B-3 have priority P1 and stage building, B-2 and B-4 have P0 and the first stage. */
const factoryWithColumns = async (): Promise<BoardRepo> => {
  const repo = await boardNode();
  for (const priority of ['P1', 'P0', 'P1', 'P0']) await mustRun(repo, ['item', 'add', '--title', TITLE, '--field', `priority=${priority}`]);
  await mustRun(repo, ['item', 'move', 'B-1', '--stage', 'building']);
  await mustRun(repo, ['item', 'move', 'B-3', '--stage', 'building']);
  return repo;
};

describe('the columns of an outside review page that reads board.json', () => {
  it('shows each state, stage and priority column in the board order, before and after item rank', async () => {
    const repo = await factoryWithColumns();
    expect(columnsNow(repo)).toEqual({
      state: { open: ['B-1', 'B-2', 'B-3', 'B-4'] },
      stage: { building: ['B-1', 'B-3'], ticket: ['B-2', 'B-4'] },
      priority: { P1: ['B-1', 'B-3'], P0: ['B-2', 'B-4'] },
    });

    await mustRun(repo, ['item', 'rank', 'B-3', '--first']);
    expect(columnsNow(repo)).toEqual({
      state: { open: ['B-3', 'B-1', 'B-2', 'B-4'] },
      stage: { building: ['B-3', 'B-1'], ticket: ['B-2', 'B-4'] },
      priority: { P1: ['B-3', 'B-1'], P0: ['B-2', 'B-4'] },
    });

    await mustRun(repo, ['item', 'rank', 'B-4', '--after', 'B-3']);
    expect(columnsNow(repo)).toEqual({
      state: { open: ['B-3', 'B-4', 'B-1', 'B-2'] },
      stage: { building: ['B-3', 'B-1'], ticket: ['B-4', 'B-2'] },
      priority: { P1: ['B-3', 'B-1'], P0: ['B-4', 'B-2'] },
    });

    await mustRun(repo, ['item', 'rank', 'B-3', '--last']);
    expect(columnsNow(repo)).toEqual({
      state: { open: ['B-4', 'B-1', 'B-2', 'B-3'] },
      stage: { building: ['B-1', 'B-3'], ticket: ['B-4', 'B-2'] },
      priority: { P1: ['B-1', 'B-3'], P0: ['B-4', 'B-2'] },
    });
  });

  it('keeps the board order in each column after item move --state, not the order of the moves', async () => {
    const repo = await factoryWithColumns();
    await mustRun(repo, ['item', 'rank', 'B-4', '--first']);
    await mustRun(repo, ['item', 'move', 'B-3', '--state', 'doing']);
    await mustRun(repo, ['item', 'move', 'B-4', '--state', 'doing']);
    expect(itemsOf(repo).map((item) => item.id)).toEqual(['B-4', 'B-1', 'B-2', 'B-3']);
    expect(columnsNow(repo)).toEqual({
      state: { doing: ['B-4', 'B-3'], open: ['B-1', 'B-2'] },
      stage: { building: ['B-1', 'B-3'], ticket: ['B-4', 'B-2'] },
      priority: { P1: ['B-1', 'B-3'], P0: ['B-4', 'B-2'] },
    });
  });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const recordsOf = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const textOf = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** The requests come from the file text, not from command output or a board reader. */
const requestsOf = (repo: BoardRepo): readonly Record<string, unknown>[] => {
  const waiting: unknown = JSON.parse(repo.textOf(files.waiting) ?? '');
  return isRecord(waiting) ? recordsOf(waiting['items']) : [];
};

const decisionCardOf = (request: Record<string, unknown>) => ({
  title: textOf(request['title']),
  question: textOf(request['question']),
  kind: ['decision', 'command', 'information'].find((kind) => kind === request['kind']) ?? 'decision',
  fields: recordsOf(request['fields']).map((field) => ({ label: textOf(field['label']), text: textOf(field['text']) })),
  docs: Array.isArray(request['docs'])
    ? request['docs'].filter((path: unknown): path is string => typeof path === 'string' && passesNameCheck(path))
    : [],
  options: recordsOf(request['options']).map((option) => ({
    key: textOf(option['key']),
    text: textOf(option['text']),
    recommended: option['rec'] === true,
    askerReason: textOf(option['why']),
  })),
});

const OLD_REQUEST = {
  id: 'D-1', title: 'Pick a plan', question: 'Which plan do we use?',
  options: [{ key: 'a', text: 'Plan A', rec: true }, { key: 'b', text: 'Plan B' }],
};

const firstDecisionCard = (repo: BoardRepo) => decisionCardOf(requestsOf(repo)[0] ?? {});

const factoryWithRequest = async (kind: string): Promise<BoardRepo> => {
  const repo = await boardNode();
  repo.deps.seed(join(HOME, DOC), '# Plan\n');
  await mustRun(repo, [
    'request', 'add', '--title', OLD_REQUEST.title, '--question', OLD_REQUEST.question,
    '--option', 'a=Plan A', '--option', 'b=Plan B', '--recommend', 'a', '--kind', kind,
    '--field', 'Scope=Web=API', '--field', 'Cost=Small', '--why', 'a=Fits=now', '--doc', DOC,
  ]);
  return repo;
};

describe('the card of a decision, from the text of waiting.json alone', () => {
  it.each(['decision', 'command', 'information'])('shows kind %s, ordered fields, docs and the reasons of the asker', async (kind) => {
    const repo = await factoryWithRequest(kind);
    expect(firstDecisionCard(repo)).toEqual({
      title: OLD_REQUEST.title, question: OLD_REQUEST.question, kind,
      fields: [{ label: 'Scope', text: 'Web=API' }, { label: 'Cost', text: 'Small' }],
      docs: [DOC],
      options: [
        { key: 'a', text: 'Plan A', recommended: true, askerReason: 'Fits=now' },
        { key: 'b', text: 'Plan B', recommended: false, askerReason: null },
      ],
    });
  });

  it.each([
    OLD_REQUEST,
    { ...OLD_REQUEST, opened_at: '2030-01-02T03:04:05.678Z', group: 'later' },
  ])('gives the same card for an older request with no context keys: %j', async (request) => {
    const repo = await boardNode({ waiting: JSON.stringify({ intro: '', groups: [], items: [request] }) });
    expect(firstDecisionCard(repo)).toEqual({
      title: OLD_REQUEST.title, question: OLD_REQUEST.question, kind: 'decision', fields: [], docs: [],
      options: [
        { key: 'a', text: 'Plan A', recommended: true, askerReason: null },
        { key: 'b', text: 'Plan B', recommended: false, askerReason: null },
      ],
    });
  });

  it('leaves a doc path out when the path fails the name check, without a file read', async () => {
    const request = { ...OLD_REQUEST, docs: [DOC, '../outside.md', 'Factory.Local.YAML', 'docs/.draft.md'] };
    const repo = await boardNode({ waiting: JSON.stringify({ intro: '', groups: [], items: [request] }) });
    expect(firstDecisionCard(repo).docs).toEqual([DOC]);
  });
});

describe('the imports of this test', () => {
  it('names nothing from the board source folder', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => specifier.includes('/src/board/'))).toEqual([]);
  });
});
