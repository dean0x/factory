import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recipes } from '../../src/recipes/index.js';
import { softwareWordList } from '../../src/recipes/software/words.js';
import { OLD_WORD_LIST } from '../helpers/old-words.js';
import { softwareWordsIn } from '../helpers/software-words.js';
import { allSourceFiles, importPathsOf, literalsOf, shellValue } from '../helpers/source-scan.js';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const RECIPES = join(SRC, 'recipes');

const insideRecipes = (path: string): boolean => path.startsWith(`${RECIPES}${sep}`);

/** The target of every relative import of a source file that is inside a recipe folder (`src/recipes/<id>/`). */
const recipeFolderImports = (file: string, source: string): string[] =>
  importPathsOf(source)
    .filter((path) => path.startsWith('.'))
    .map((path) => resolve(dirname(file), path))
    .filter((target) => {
      const inside = relative(RECIPES, target);
      return !inside.startsWith('..') && inside.includes(sep);
    })
    .map((target) => relative(SRC, target));

const coreFiles = (): string[] => allSourceFiles(SRC).filter((path) => !insideRecipes(path));

describe('the word list of the software recipe (TP-97)', () => {
  it('holds the words of the recipe, with the abbreviations', () => {
    expect([...softwareWordList]).toEqual([
      'merge',
      'pull request',
      'release',
      'release check',
      'release scope',
      'CI log',
      'PR',
      'CI',
    ]);
  });

  it('is the list of the recipe entry', () => {
    const entry = recipes.find((candidate) => candidate.id === 'software');
    expect(entry?.words).toEqual([...softwareWordList]);
  });

  it('finds each word in all its forms, in any case, and the abbreviations in capital letters only', () => {
    const hits = [
      'A merge.',
      'two Merges',
      'a merged change',
      'the merging',
      'Pull Request',
      'pull requests',
      'the RELEASE',
      'released',
      'release check',
      'the release scope',
      'the CI log',
      'ci logs',
      'a PR',
      'many PRs',
      'run CI',
    ];
    for (const text of hits) expect(softwareWordsIn(text), text).not.toEqual([]);
  });

  it('leaves longer words, names of code and other words alone', () => {
    const clean = [
      'merge_method',
      'mergeMethod',
      'unreleased',
      'prerelease',
      'pr',
      'ci',
      'PROXY',
      'CIRCLE',
      'a pull of the request',
      'the proxy',
    ];
    for (const text of clean) expect(softwareWordsIn(text), text).toEqual([]);
  });

  it('reads the string literals and leaves the comments to the authors', () => {
    expect(literalsOf("const a = 'a merged change';").flatMap(softwareWordsIn)).toEqual(['merged']);
    expect(literalsOf("// a merged change\nconst a = 'plain';").flatMap(softwareWordsIn)).toEqual([]);
  });
});

describe('no software word in the core (TP-97)', () => {
  it('scans the names file, the glossary, the state files and the templates', () => {
    const scanned = coreFiles().map((path) => relative(SRC, path));
    expect(scanned).toEqual(
      expect.arrayContaining(['names.ts', 'glossary.ts', 'state/files.ts', 'templates/safety.ts', 'templates/index.ts', 'core/result.ts']),
    );
    expect(scanned.filter((path) => path.startsWith(`recipes${sep}`))).toEqual([]);
  });

  it('finds no word of the list in the string literals of src outside src/recipes', () => {
    const found = coreFiles().flatMap((path) =>
      literalsOf(readFileSync(path, 'utf8')).flatMap((literal) =>
        softwareWordsIn(literal).map((word) => `${relative(SRC, path)}: "${word}" in "${literal.slice(0, 80)}"`),
      ),
    );
    expect(found).toEqual([]);
  });

  it('finds no word of the list in the core part of docs/glossary.md', () => {
    const lines = readFileSync(join(ROOT, 'docs', 'glossary.md'), 'utf8').split('\n');
    const start = lines.indexOf('## Words of every factory');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    const part = end < 0 ? rest : rest.slice(0, end);
    expect(part.filter((line) => line.startsWith('- **')).length).toBeGreaterThan(20);
    expect(part.flatMap((line) => softwareWordsIn(line).map((word) => `"${word}" in "${line.slice(0, 60)}"`))).toEqual([]);
  });

  it('holds the words in the recipe: its glossary, its safety lines and its project key', () => {
    const entry = recipes.find((candidate) => candidate.id === 'software');
    expect(entry?.glossary.flatMap((word) => softwareWordsIn(`${word.term} ${word.text}`)).length).toBeGreaterThan(0);
    expect(entry?.safetyLines.flatMap(softwareWordsIn).length).toBeGreaterThan(0);
    expect(entry?.projectKeys).toEqual(['merge_method']);
    expect(entry?.initProjectKeys).toEqual(['url', 'repo', 'default_branch', 'gate']);
  });
});

describe('no import of a recipe folder from the core (TP-137)', () => {
  it('finds no import of src/recipes/<id>/ in a file outside src/recipes', () => {
    const found = coreFiles().flatMap((path) =>
      recipeFolderImports(path, readFileSync(path, 'utf8')).map((target) => `${relative(SRC, path)} imports ${target}`),
    );
    expect(found).toEqual([]);
  });

  it('lets a file outside src/recipes import the registry file src/recipes/index.ts', () => {
    const importers = coreFiles().filter((path) =>
      importPathsOf(readFileSync(path, 'utf8')).some((importPath) => resolve(dirname(path), importPath).startsWith(join(RECIPES, 'index'))),
    );
    expect(importers.map((path) => relative(SRC, path))).toEqual(expect.arrayContaining(['config/schema.ts', 'cli/table.ts']));
  });

  it('reads each form of import, and finds a recipe folder only', () => {
    const file = join(SRC, 'commands', 'sample.ts');
    const source = [
      "import { a } from '../recipes/software/words.js';",
      "export { b } from '../recipes/software/config';",
      "const c = await import('../recipes/other/recipe.js');",
      "import '../recipes/software/approval.js';",
      "import { d } from '../recipes/index.js';",
      "import { e } from '../config/schema.js';",
      "import { f } from 'zod';",
    ].join('\n');
    expect(recipeFolderImports(file, source)).toEqual([
      join('recipes', 'software', 'words.js'),
      join('recipes', 'software', 'config'),
      join('recipes', 'other', 'recipe.js'),
      join('recipes', 'software', 'approval.js'),
    ]);
  });
});

describe('the copies of the word lists in the shell scripts (TP-150)', () => {
  const exitCheck = readFileSync(join(ROOT, 'scripts', 'exit-check.sh'), 'utf8');
  const docsCheck = readFileSync(join(ROOT, 'scripts', 'check-intent-docs.sh'), 'utf8');

  it('holds the same software words in docs check 10 as the recipe, in the same order', () => {
    expect(shellValue(docsCheck, 'software_words')?.split('|')).toEqual([...softwareWordList]);
  });

  it('names the file of the recipe words in a comment of docs check 10', () => {
    expect(docsCheck).toMatch(/^#.*src\/recipes\/software\/words\.ts/m);
  });

  it('holds the same old words in the exit check as the helper, in the same order', () => {
    expect(shellValue(exitCheck, 'old_word_list')?.split(' ')).toEqual([...OLD_WORD_LIST]);
  });

  it('finds no list for a name that the script does not set', () => {
    expect(shellValue(docsCheck, 'no_such_list')).toBeUndefined();
  });
});
