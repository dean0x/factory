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
 * The exit check of the board data for an outside review page, item card half. The test sets the board up through the command line, or
 * with a board file of an older version. Then it reads one thing only: the text of `board.json`, with `JSON.parse`. From that text it
 * builds the card of an item: the epic, a strip of the stages with the current stage, and the docs that pass the name check. The test
 * imports nothing from the board source, and the card code is in this file and not in `src/`, because a view lives outside the core.
 */

const TITLE = 'Build the login page';
const DOC = 'docs/plan.md';

/** An item as `board.json` stores it. A key that a version did not write is missing. */
interface StoredItem {
  readonly id: string;
  readonly title: string;
  readonly stage?: string;
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
    expect(card.strip.map((entry) => entry.name)).toEqual(['ticket', 'plan-approved', 'building', 'review', 'fixes', 'merged', 'released']);
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

describe('the imports of this test', () => {
  it('names nothing from the board source folder', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => specifier.includes('/src/board/'))).toEqual([]);
  });
});
