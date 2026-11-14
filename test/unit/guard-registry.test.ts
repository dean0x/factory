import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardRowsFor, guardsFor, retiredGuardIds } from '../../src/guards/registry.js';
import type { Guard, GuardRow } from '../../src/guards/types.js';
import { blockNames, guardIds, guardKeys, guardKinds, guardValues } from '../../src/names.js';
import { blockTemplatesFor } from '../../src/templates/index.js';
import { blockInput, softwareRecipe } from '../helpers/blocks.js';
import { publishRecipe } from '../helpers/publish-recipe.js';
import { importPathsOf, topLevelNamesOf } from '../helpers/source-scan.js';

const REPO = join(__dirname, '..', '..');

const software = {
  guards: guardsFor(softwareRecipe),
  rows: guardRowsFor(softwareRecipe),
};

const idsOf = (items: readonly { readonly id: string }[]): string[] => items.map((item) => item.id);

const duplicatesOf = (ids: readonly string[]): string[] => ids.filter((id, index) => ids.indexOf(id) !== index);

const rowsOf = (guard: Guard): GuardRow[] => software.rows.filter((row) => row.guard === guard.id);

describe('the guards of a recipe', () => {
  it('lists the 28 core guards and the 3 guards of the software recipe, each once', () => {
    const ids = idsOf(software.guards);
    expect(ids).toHaveLength(31);
    expect(duplicatesOf(ids)).toEqual([]);
    expect(ids.slice(0, 28)).toEqual(Object.values(guardIds));
    const points = softwareRecipe.approvalPoints.map((point) => `approval-${point.id}`);
    expect(ids.slice(28).sort()).toEqual(['pr-rules', ...points].sort());
  });

  it('lists only the core guards for a recipe that names no guard', () => {
    expect(idsOf(guardsFor(publishRecipe))).toEqual(Object.values(guardIds));
    expect(guardRowsFor(publishRecipe).every((row) => !row.sites.some((site) => site.path.startsWith('src/recipes/')))).toBe(true);
  });

  it('gives no guard the id of an approval point', () => {
    const taken = new Set<string>(softwareRecipe.approvalPoints.map((point) => point.id));
    expect(idsOf(software.guards).filter((id) => taken.has(id))).toEqual([]);
  });

  it('retires no guard id yet', () => {
    expect(retiredGuardIds).toEqual([]);
  });

  it('gives each guard the key below the guards key, a missing key that means on, and no other value yet', () => {
    for (const guard of software.guards) {
      expect(guard.key).toBe(`${guardKeys.local}.${guard.id}`);
      expect(guard.whenMissing).toBe(guardValues.on);
      expect(guard.newNode).toBe(guardValues.on);
    }
  });

  it('gives each guard a name and one sentence about what it keeps safe', () => {
    for (const guard of software.guards) {
      expect(guard.name.trim(), guard.id).not.toBe('');
      expect(guard.keepsSafe.trim(), guard.id).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('marks a guard with the harm mark when one of its rows has it, and lists the kinds and the row ids of its rows', () => {
    for (const guard of software.guards) {
      const rows = rowsOf(guard);
      expect(guard.harm, guard.id).toBe(rows.some((row) => row.harm));
      expect(guard.rows, guard.id).toEqual(idsOf(rows));
      const kinds = Object.values(guardKinds).filter((kind) => rows.some((row) => row.kind === kind));
      expect(guard.kinds, guard.id).toEqual(kinds);
    }
  });
});

describe('the rows of the registry', () => {
  it('holds each row once, under a guard of the list', () => {
    expect(duplicatesOf(idsOf(software.rows))).toEqual([]);
    const guards = new Set(idsOf(software.guards));
    expect(software.rows.filter((row) => !guards.has(row.guard)).map((row) => row.id)).toEqual([]);
  });

  it('gives each row a name, a place where it applies, a kind and at least one site', () => {
    const kinds = new Set<string>(Object.values(guardKinds));
    for (const row of software.rows) {
      expect(row.name.trim(), row.id).not.toBe('');
      expect(row.applies.trim(), row.id).not.toBe('');
      expect(kinds.has(row.kind), row.id).toBe(true);
      expect(row.sites.length, row.id).toBeGreaterThan(0);
    }
  });

  it('cites for each site a source file and a symbol that the file declares at the top level', () => {
    const missing = software.rows.flatMap((row) =>
      row.sites.flatMap((site) => {
        const path = join(REPO, site.path);
        if (!existsSync(path)) return [`${row.id}: no file ${site.path}`];
        return topLevelNamesOf(readFileSync(path, 'utf8')).includes(site.symbol)
          ? []
          : [`${row.id}: ${site.path} declares no ${site.symbol}`];
      }),
    );
    expect(missing).toEqual([]);
  });

  it('cites no site twice in a row', () => {
    const twice = software.rows.filter((row) => duplicatesOf(row.sites.map((site) => `${site.path} ${site.symbol}`)).length > 0);
    expect(idsOf(twice)).toEqual([]);
  });

  it('keeps the rows of the core free of the software recipe: a row with a site in it is in the list of the recipe', () => {
    const coreRows = guardRowsFor(publishRecipe);
    const inSoftware = coreRows.filter((row) => row.sites.some((site) => site.path.startsWith('src/recipes/software/')));
    expect(idsOf(inSoftware)).toEqual([]);
    const recipeOnly = software.rows.filter((row) => !coreRows.some((core) => core.id === row.id));
    expect(recipeOnly.length).toBeGreaterThan(0);
  });

  it('imports nothing of the software recipe in the core registry', () => {
    const files = readdirSync(join(REPO, 'src', 'guards')).map((name) => join(REPO, 'src', 'guards', name));
    expect(files.length).toBeGreaterThan(1);
    const imports = files.flatMap((file) => importPathsOf(readFileSync(file, 'utf8')));
    expect(imports.filter((path) => path.includes('recipes/software'))).toEqual([]);
  });

  it('holds no source tag, planning id or absolute path in any text of the registry', () => {
    const tag = /\[[A-D]\d+|\b[A-Z]{1,2}-\d+\b|\b(?:AC|TP|PR)[- ]?\d+\b|\/Users\/|(?:^|\s)\/[a-z]/;
    const texts = [
      ...software.guards.flatMap((guard) => [guard.id, guard.name, guard.keepsSafe, guard.key, ...guard.related]),
      ...software.rows.flatMap((row) => [row.id, row.name, row.applies, ...row.sites.flatMap((site) => [site.symbol])]),
      ...software.rows.flatMap((row) => row.sites.map((site) => site.path)).filter((path) => !/^src\/[\w./-]+\.ts$/.test(path)),
    ];
    expect(texts.filter((text) => tag.test(text))).toEqual([]);
  });

  it('says what a row keeps safe, and never how to get around it', () => {
    const way = /\b(?:bypass|circumvent|defeat|evade|get around|work around)\b/i;
    const texts = software.rows.map((row) => `${row.id}: ${row.name}`);
    expect(texts.filter((text) => way.test(text))).toEqual([]);
  });

  it('pins the ids of the rows of each guard, so that a rename is a reviewed change', () => {
    const pinned = Object.fromEntries(
      software.guards.filter((guard) => guard.rows.length > 0).map((guard) => [guard.id, guard.rows]),
    );
    expect(pinned).toEqual({
      'approval-delegation': [
        'delegation-record',
        'delegation-store-fallback',
        'delegation-owner-channel',
        'delegation-no-flag',
        'delegation-move',
        'delegation-warning',
        'delegation-wait-text',
        'delegation-session-text',
      ],
      'approval-merge': ['merge-point-text', 'merge-head-text'],
      'approval-release': ['release-point-text'],
      'board-edits': [
        'board-flow-stages',
        'board-worker-field',
        'board-reserved-names',
        'board-hosted-refusal',
        'board-file-links',
        'board-commit-paths',
        'active-machine-mark',
        'board-single-store-text',
        'board-commands-text',
        'board-flow-stages-text',
        'board-worker-field-text',
        'board-reserved-names-text',
      ],
      'settings-check': [
        'settings-env-program',
        'settings-env-traffic',
        'settings-env-state',
        'settings-hooks-kept',
        'settings-commands',
        'settings-wide-allow',
        'settings-default-mode',
        'settings-mcp-approval',
        'settings-cross-session',
        'settings-other-warnings',
        'settings-check-fails-closed',
        'settings-work-copy',
      ],
      'settings-write': [
        'settings-write-consent',
        'settings-write-terminal',
        'settings-write-no-link',
        'settings-write-inside-folder',
        'settings-write-user-folder',
        'settings-write-changed',
      ],
      'clone-rules': [
        'clone-source',
        'clone-option-end',
        'clone-inside-folder',
        'clone-missing-folder',
        'clone-received-local',
        'clone-url',
        'clone-project-path',
        'clone-unique-targets',
      ],
      'context-limits': ['context-limits-text', 'context-no-self-compact'],
      'delete-guard': [
        'delete-hook',
        'delete-hook-install',
        'delete-hook-required',
        'delete-hook-warning',
        'no-lost-item-ids',
        'no-lost-item-ids-text',
      ],
      dismiss: [
        'dismiss-dry-run',
        'dismiss-pushed',
        'dismiss-endable',
        'dismiss-paths',
        'dismiss-no-force',
        'dismiss-inbox-ignored',
        'dismiss-closed-proof',
        'dismiss-work-item-unknown',
        'dismiss-dry-run-text',
        'dismiss-pushed-text',
        'dismiss-closed-proof-text',
        'dismiss-session-text',
        'dismiss-copy-reviews-text',
        'dismiss-review-results-text',
        'dismiss-unpushed-text',
      ],
      'file-link-safety': [
        'user-folder-never',
        'private-file-mode',
        'local-file-mode',
        'safe-write',
        'atomic-write-target',
        'checked-open',
        'folder-links',
        'init-upgrade-links',
        'copy-no-links',
        'reviews-folder',
        'exclude-file',
        'worker-record',
        'init-existing-plain',
        'init-race',
        'init-rollback',
        'clone-undo',
        'state-target-kept',
        'init-existing-writes',
        'init-temp-leftovers',
        'upgrade-backups',
        'upgrade-paths',
        'upgrade-keeps-repo',
        'migration-keeps-edits',
        'user-folder-text',
      ],
      'folder-trust': [
        'registration-check',
        'home-env-conflict',
        'unregistered-upgrade',
        'origin-received',
        'home-is-new',
        'home-outside-roots',
        'root-listed',
        'received-root-checks',
        'init-proposal-confirm',
        'existing-registration-ask',
        'instruction-files-warning',
        'trust-question-text',
      ],
      'git-safety': [
        'state-git-config',
        'state-git-hooks-off',
        'commit-named-paths',
        'work-tree-top',
        'state-repo-ready',
        'root-repo-init',
      ],
      'hook-runtime': [
        'hook-never-fails',
        'hook-silent-outside',
        'hook-session-identity',
        'statusline-command',
        'statusline-identity',
      ],
      'launch-commands': [
        'launch-values',
        'launch-fixed-argv',
        'launch-env-clean',
        'launch-folder-bounds',
        'worker-launch-bounds',
        'work-copy-exact-path',
        'child-no-shell',
        'agent-claude-only',
        'tmux-quoting',
        'run-shell-limits',
      ],
    });
  });
});

/**
 * The text of a text row, as the rendered blocks of a node on layer 1 hold it with every guard on. Each row names a piece
 * of that text. The piece must be in the block of each of its sites, so a row never cites a line that holds another rule.
 */
describe('the text rows of the registry', () => {
  const blocks = blockTemplatesFor(blockInput(1));
  const bodyOf = (name: string): string => blocks.find((block) => block.name === name)?.body ?? '';
  const BLOCK_OF_PATH: Readonly<Record<string, string>> = {
    'src/recipes/software/roles/coordinator.ts': blockNames.coordinator,
    'src/recipes/software/roles/worker.ts': blockNames.worker,
    'src/templates/safety.ts': blockNames.safety,
    'src/templates/work-rules.ts': blockNames.workRules,
  };

  const FRAGMENTS: Readonly<Record<string, readonly string[]>> = {
    'delegation-wait-text': ['waits for the owner, unless the owner delegated it.'],
    'delegation-session-text': ['A session never sets a delegation.'],
    'merge-point-text': ['A merge waits for the go of the owner.'],
    'merge-head-text': ['Merge only at the full head SHA that you checked, with CI green at that SHA.'],
    'release-point-text': ['A release waits for the go of the owner.'],
    'board-commands-text': [
      'Board files change only through the factory commands',
      'Only the coordinator changes the board.',
      'Only you change the board.',
    ],
    'board-flow-stages-text': ['The command refuses'],
    'board-worker-field-text': ['changes only through'],
    'board-reserved-names-text': ['Never set them in a field.'],
    'board-single-store-text': ['Keep no other copy.'],
    'context-limits-text': ['The context limits are in', 'finish the current step, save a checkpoint and report'],
    'context-no-self-compact': ['Do not compact or clear yourself.'],
    'no-lost-item-ids-text': ['Never remove an item from it.'],
    'dismiss-dry-run-text': ['It lists the files that the free deletes.'],
    'dismiss-pushed-text': ['its branch is pushed and its work copy is clean'],
    'dismiss-closed-proof-text': ['Do it only when the item of the worker is closed'],
    'dismiss-session-text': ['Tell the owner about each dismiss that you run in this session.'],
    'dismiss-copy-reviews-text': ['Copy each review file that the worker named from'],
    'dismiss-review-results-text': ['Put each review result in a file in the inbox folder'],
    'dismiss-unpushed-text': ['First check that no unpushed work remains.'],
    'user-folder-text': ['Do not open a file in the user config folder.'],
    'trust-question-text': ['names a trust question, tell the owner at once which pane waits'],
  };

  const textRows = software.rows.filter((row) => row.kind === guardKinds.text);

  it('has a piece of text for each text row, and for no other row', () => {
    expect(idsOf(textRows).sort()).toEqual(Object.keys(FRAGMENTS).sort());
  });

  it('finds the piece of each text row in the block of each of its sites', () => {
    const missing = textRows.flatMap((row) =>
      row.sites.flatMap((site) => {
        const block = BLOCK_OF_PATH[site.path];
        if (block === undefined) return [];
        const body = bodyOf(block);
        return (FRAGMENTS[row.id] ?? []).some((piece) => body.includes(piece)) ? [] : [`${row.id}: the ${block} block holds no piece`];
      }),
    );
    expect(missing).toEqual([]);
  });

  it('finds every piece in the text of the blocks of a node on layer 1', () => {
    const all = blocks.map((block) => block.body).join('\n');
    const missing = Object.entries(FRAGMENTS).flatMap(([id, pieces]) => pieces.filter((piece) => !all.includes(piece)).map((piece) => `${id}: ${piece}`));
    expect(missing).toEqual([]);
  });
});

describe('the top-level names of a source text', () => {
  it('finds a declaration that starts in the first column, and leaves an indented one and a comment out', () => {
    const source = [
      '// const hidden = 1;',
      'export const first = 1;',
      'const second = (): number => {',
      '  const inner = 2;',
      '  return inner;',
      '};',
      'export async function third() {}',
      'export interface Fourth {}',
      'type Fifth = string;',
    ].join('\n');
    expect(topLevelNamesOf(source)).toEqual(['first', 'second', 'third', 'Fourth', 'Fifth']);
  });
});
