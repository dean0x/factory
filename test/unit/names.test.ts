import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  address,
  claudeSettings,
  commands,
  dirs,
  env,
  files,
  flags,
  keys,
  marker,
  nodeCommands,
  program,
  roles,
  schema1,
  schemaIds,
  stateKeys,
  templateValues,
  terms,
  tmuxNames,
  values,
} from '../../src/names.js';
import { commandTable, renderCommandHelp, renderHelp } from '../../src/cli/table.js';
import { runInit } from '../../src/commands/init.js';
import { glossary } from '../../src/glossary.js';
import { recipes } from '../../src/recipes/index.js';
import { fillTemplate } from '../../src/templates/fill.js';
import { fileTemplates } from '../../src/templates/index.js';
import { allBlocks } from '../helpers/blocks.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { OLD_WORD_ENDINGS, OLD_WORD_LIST, oldWordsIn } from '../helpers/old-words.js';

const SRC = join(__dirname, '..', '..', 'src');
const NAMES_FILE = join(SRC, 'names.ts');
const EXIT_CHECK = join(__dirname, '..', '..', 'scripts', 'exit-check.sh');

/** An import path is no text for a user. */
const IMPORT_PATH = /^(node:|\.{1,2}\/)/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && path !== NAMES_FILE ? [path] : [];
  });

/** Every `.ts` file under a folder, names.ts included. */
const allSourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return allSourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The text of every string literal. Template expressions and {{placeholders}} are blanked. */
const literalsOf = (source: string): string[] => {
  const code = stripComments(source);
  const tokens = [
    ...(code.match(/'(?:[^'\\\n]|\\.)*'/g) ?? []),
    ...(code.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []),
    ...(code.match(/`(?:[^`\\]|\\.)*`/g) ?? []),
  ];
  return tokens.map((token) =>
    token.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ').replace(/\{\{[A-Za-z]+\}\}/g, ' '),
  );
};

const flat = (...groups: readonly Record<string, unknown>[]): string[] =>
  groups.flatMap((group) => Object.values(group).flatMap((value) => (typeof value === 'string' ? [value] : [])));

/** Names that a string literal must never equal outside names.ts. */
const EXACT_NAMES = new Set([
  ...flat(
    commands,
    nodeCommands,
    flags,
    keys.root,
    keys.node,
    keys.owner,
    keys.session,
    keys.proxy,
    keys.worker,
    keys.limits,
    keys.project,
    keys.gate,
    keys.approval,
    keys.tracker,
    keys.recipe,
    keys.link,
    stateKeys,
    schema1.keys,
    { windowView: tmuxNames.windowView, windowBench: tmuxNames.windowBench, slotBoard: tmuxNames.slotBoard },
  ),
  ...values.approvalModes,
]);

/**
 * The approval point ids of every recipe. They are config keys, so no file may hold one as a literal,
 * except the approval file of a recipe (`src/recipes/<id>/approval.ts`), which owns the names of its recipe.
 */
const POINT_IDS = new Set(Object.values(recipes).flatMap((entry) => entry.approvalPoints.map((point) => point.id)));
const RECIPE_APPROVAL_FILE = /[\\/]recipes[\\/][^\\/]+[\\/]approval\.ts$/;

/** Names that a string literal must never hold as a part, matched as whole words. */
const WORD_NAMES = [
  program,
  ...flat(roles),
  dirs.profile,
  dirs.roadmaps,
  dirs.orders,
  dirs.backups,
  schema1.briefsDir,
];

/**
 * Names that a string literal must never hold as a part, matched as plain text.
 * The word "settings" (claudeSettings.prefix) is also plain prose, so it is not scanned.
 */
const TEXT_NAMES = [
  ...flat(files),
  schema1.protocolFile,
  dirs.state,
  dirs.claude,
  claudeSettings.suffix,
  env.proxyBaseUrl,
  env.home,
  env.session,
  tmuxNames.optionHome,
  tmuxNames.optionNode,
  tmuxNames.optionSlot,
  tmuxNames.optionWorker,
  marker.prefix,
  address.scheme,
];

/** These files call git, so they hold the words of git, for example its init command and its --quiet flag. */
const GIT_VOCABULARY_FILES = new Set([join(SRC, 'core', 'git.ts')]);

const violationsInText = (source: string, path: string): string[] => {
  const found: string[] = [];
  for (const literal of literalsOf(source)) {
    if (IMPORT_PATH.test(literal)) continue;
    if (POINT_IDS.has(literal) && !RECIPE_APPROVAL_FILE.test(path)) found.push(`"${literal}" is an approval point id`);
    if (!GIT_VOCABULARY_FILES.has(path)) {
      if (EXACT_NAMES.has(literal)) found.push(`"${literal}" is a name`);
      for (const flag of flat(flags)) {
        if (literal.includes(`--${flag}`)) found.push(`"${literal}" holds the flag --${flag}`);
      }
    }
    for (const word of WORD_NAMES) {
      // "Node.js" is the runtime, not the node of this tool.
      if (new RegExp(`(?<![A-Za-z0-9_-])${word}s?(?![A-Za-z0-9_-])(?!\\.js)`, 'i').test(literal)) {
        found.push(`"${literal}" holds the name ${word}`);
      }
    }
    for (const text of TEXT_NAMES) {
      if (literal.includes(text)) found.push(`"${literal}" holds the name ${text}`);
    }
    for (const id of flat(schemaIds)) {
      if (literal.includes(id)) found.push(`"${literal}" holds the schema id ${id}`);
    }
  }
  return found.map((message) => `${relative(SRC, path)}: ${message}`);
};

const violationsIn = (path: string): string[] => violationsInText(readFileSync(path, 'utf8'), path);

describe('names', () => {
  it('keeps every user-visible name out of the other source files', () => {
    const violations = sourceFiles(SRC).flatMap(violationsIn);
    expect(violations).toEqual([]);
  });

  it('scans the whole source tree', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(20);
  });

  it('reports a name literal in a source text', () => {
    const path = join(SRC, 'sample.ts');
    expect(violationsInText(`const a = '${commands.init}';`, path)).toEqual([`sample.ts: "${commands.init}" is a name`]);
    expect(violationsInText(`const a = '${files.config}';`, path)).toContain(
      `sample.ts: "${files.config}" holds the name ${files.config}`,
    );
    expect(violationsInText("const a = 'plain words';", path)).toEqual([]);
  });

  it('reads the string literals of a text, and leaves out comments, template expressions and placeholders', () => {
    const sample = (text: string): string[] => literalsOf(text);
    expect(sample("const a = 'factory.yaml';")).toEqual(['factory.yaml']);
    expect(sample('const a = `x ${y} {{worker}} z`;')).toEqual(['x     z']);
    expect(sample("// a 'comment'\nconst a = 1;")).toEqual([]);
  });
});

/** The values that appear more than once in a list. */
const duplicatesOf = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

/** Every string value of a tree of names, at any depth. */
const stringValuesOf = (tree: Readonly<Record<string, unknown>>): string[] =>
  Object.values(tree).flatMap((value) => {
    if (typeof value === 'string') return [value];
    return typeof value === 'object' && value !== null ? stringValuesOf(value as Record<string, unknown>) : [];
  });

/** Every property name of a tree of names, at any depth. */
const propertyNamesOf = (tree: Readonly<Record<string, unknown>>): string[] =>
  Object.entries(tree).flatMap(([name, value]) => [
    name,
    ...(typeof value === 'object' && value !== null ? propertyNamesOf(value as Record<string, unknown>) : []),
  ]);

describe('the role words and the terms', () => {
  /** The words that decision D-59 replaced in the roles and the terms. */
  const REPLACED_WORDS = ['cell', 'andon', 'staging', 'inspect', 'ship'];
  const replacedWord = new RegExp(`(?<![A-Za-z0-9_])(?:${REPLACED_WORDS.join('|')})(?:s|es)?(?![A-Za-z0-9_])`, 'i');

  it('holds no user value for a replaced word in the roles, the terms and the template values', () => {
    const userValues = [
      ...Object.values(roles),
      ...terms,
      ...Object.keys(templateValues),
      ...Object.values(templateValues),
    ];
    expect(userValues.filter((value) => replacedWord.test(value))).toEqual([]);
  });

  it('holds no replaced word in the config keys and the tmux names, at any depth', () => {
    const configNames = [...stringValuesOf(keys), ...propertyNamesOf(keys)];
    expect(configNames.filter((value) => replacedWord.test(value))).toEqual([]);
    expect(stringValuesOf(tmuxNames).filter((value) => replacedWord.test(value))).toEqual([]);
    expect(Object.keys(tmuxNames).filter((name) => replacedWord.test(name.replace(/([a-z])([A-Z])/g, '$1 $2')))).toEqual([]);
  });

  it('reads the values and the names of a nested tree of names', () => {
    const tree = { root: { cells: 'cells', other: 'plain' }, cell: { proxy: 'proxy' } };
    expect(stringValuesOf(tree)).toEqual(['cells', 'plain', 'proxy']);
    expect(propertyNamesOf(tree)).toEqual(['root', 'cells', 'other', 'cell', 'proxy']);
  });

  it('names the config key and the override group for the worker', () => {
    expect(keys.root.workers).toBe('workers');
    expect(keys.worker).toEqual({ proxy: 'proxy' });
  });

  it('finds a replaced word in a value, also as a plural, and leaves a longer word alone', () => {
    for (const value of ['cell', 'Cells', '@cell', 'ship', 'andon', 'staging', 'inspect']) {
      expect(replacedWord.test(value), value).toBe(true);
    }
    for (const value of ['worker', 'relationship', 'cellar', 'inspector']) {
      expect(replacedWord.test(value), value).toBe(false);
    }
  });

  it('has one worker role key and no role key or placeholder for a replaced word', () => {
    const workerKeys = Object.entries(roles)
      .filter(([, value]) => value === 'worker')
      .map(([key]) => key);
    expect(workerKeys).toEqual(['worker']);
    const keysOfRoles = [...Object.keys(roles), ...Object.keys(templateValues)];
    expect(keysOfRoles.filter((key) => REPLACED_WORDS.includes(key.toLowerCase()))).toEqual([]);
  });

  it('has no two role values that are equal', () => {
    expect(duplicatesOf(Object.values(roles))).toEqual([]);
  });

  it('has no two term values that are equal', () => {
    expect(duplicatesOf(terms)).toEqual([]);
  });

  it('reports a value that stands twice in a list', () => {
    expect(duplicatesOf(['node', 'worker', 'node', 'node'])).toEqual(['node']);
    expect(duplicatesOf(['node', 'worker'])).toEqual([]);
  });
});

describe('the word desk', () => {
  const DESK = /(?<![A-Za-z0-9_])desks?(?![A-Za-z0-9_])/i;

  it('is in no file of src, comments included', () => {
    const files = allSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found = files.filter((path) => DESK.test(readFileSync(path, 'utf8')));
    expect(found.map((path) => relative(SRC, path))).toEqual([]);
  });

  it('is found in a text that holds the word, also as a plural, and not in a longer word', () => {
    for (const text of ['a desk', 'The Desk row', 'two desks', '// a review desk']) {
      expect(DESK.test(text), text).toBe(true);
    }
    for (const text of ['a desktop', 'desk_top', 'a plain text']) {
      expect(DESK.test(text), text).toBe(false);
    }
  });
});

/**
 * The scan of the old words (D-59) covers: the help text of every command, `package.json`, the templates, the glossary,
 * the files that init writes, and the string literals of `src/commands` and `src/cli`. It does not cover import paths,
 * comments, the history of the docs, or the mapping tables of design 7 and 7.1, which name the old words on purpose.
 */
describe('words of the old names', () => {
  it('finds an old word in a text, in any case and in a plural', () => {
    expect(oldWordsIn('A Lane, two packs and a brief.')).toEqual(['Lane', 'packs', 'brief']);
    expect(oldWordsIn('Brief the cell. It was briefed.')).toEqual(['Brief', 'cell', 'briefed']);
    expect(oldWordsIn('A package of plain words and a relationship.')).toEqual([]);
  });

  it.each(OLD_WORD_LIST)('finds the old word "%s", also in a capital letter, a plural and a past form', (word) => {
    for (const form of [word, `${word[0]?.toUpperCase()}${word.slice(1)}`, `${word}s`, `${word}ed`]) {
      expect(oldWordsIn(`A line with ${form} in it.`), form).toHaveLength(1);
    }
  });

  it.each(['shipping', 'shipped', 'packing', 'briefing', 'inspecting'])('finds the -ing and -ped form "%s"', (form) => {
    expect(oldWordsIn(`We are ${form} it.`)).toHaveLength(1);
  });

  it.each(['package', 'relationship', 'cellar', 'inspector', 'unpacked', 'cell_count', 'stagingarea'])(
    'leaves the longer word "%s" alone',
    (word) => {
      expect(oldWordsIn(`A line with ${word} in it.`)).toEqual([]);
    },
  );

  it('keeps the old words out of the help of every command', () => {
    const texts = [renderHelp(), ...commandTable.map(renderCommandHelp)];
    expect(texts.flatMap(oldWordsIn)).toEqual([]);
  });

  it('keeps the old words out of package.json, which the npm page shows', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(oldWordsIn(text)).toEqual([]);
  });

  it('keeps the old words out of every template', () => {
    const texts = [...allBlocks.map((template) => template.body), ...Object.values(fileTemplates)];
    expect(texts.flatMap(oldWordsIn)).toEqual([]);
  });

  it('keeps the old words out of the glossary', () => {
    expect(glossary.length).toBeGreaterThan(10);
    expect(glossary.flatMap((word) => oldWordsIn(`${word.term} ${word.text}`))).toEqual([]);
  });

  it('keeps the old words out of the files that init writes', async () => {
    const { handler } = gitHandler({ gh: 'some-login' });
    const deps = createFakeDeps({ cwd: '/w', run: handler });
    const result = await runInit(deps, {
      home: '/w/node',
      name: undefined,
      ownerName: 'Test Owner',
      ownerGithub: undefined,
      projects: [],
      yes: false,
      recipe: undefined,
      layer: undefined,
    });
    expect(result.ok).toBe(true);
    expect(deps.files.size).toBeGreaterThan(10);
    for (const [path, text] of deps.files) {
      expect({ path, found: oldWordsIn(text) }).toEqual({ path, found: [] });
    }
  });
});

describe('the old words in the exit check', () => {
  const exitCheck = readFileSync(EXIT_CHECK, 'utf8');

  /** The value of a shell variable that a line of the script sets with double quotes: `name="value"`. */
  const shellValue = (script: string, name: string): string | undefined =>
    new RegExp(`^${name}="([^"\\n]*)"$`, 'm').exec(script)?.[1];

  it('has eight old words in the helper', () => {
    expect([...OLD_WORD_LIST]).toEqual(['lane', 'pack', 'brief', 'cell', 'andon', 'staging', 'inspect', 'ship']);
  });

  it('holds the same old words as the helper, in the same order', () => {
    expect(shellValue(exitCheck, 'old_word_list')?.split(' ')).toEqual([...OLD_WORD_LIST]);
  });

  it('holds the same word endings as the helper', () => {
    expect(shellValue(exitCheck, 'old_endings')?.split('|')).toEqual([...OLD_WORD_ENDINGS]);
  });

  it('holds the list on one line of code only, so the scans take their pattern from it', () => {
    const code = exitCheck.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    expect(code.filter((line) => /\blane\b/.test(line))).toEqual([`old_word_list="${OLD_WORD_LIST.join(' ')}"`]);
  });

  it('names the helper file in a comment', () => {
    expect(exitCheck).toMatch(/^#.*test\/helpers\/old-words\.ts/m);
  });

  it('reads a value of the script, and finds none for a name that the script does not set', () => {
    expect(shellValue('a="x y"\nb="z"\n', 'a')).toBe('x y');
    expect(shellValue('a="x y"\nb="z"\n', 'c')).toBeUndefined();
    expect(shellValue('# a="x"\n', 'a')).toBeUndefined();
  });
});

describe('the old words in the text of the commands', () => {
  /** The old words that a string literal of the source holds, with the file. Comments and import paths are not text. */
  const oldWordLiterals = (source: string, path: string): string[] =>
    literalsOf(source)
      .filter((literal) => !IMPORT_PATH.test(literal))
      .flatMap((literal) => oldWordsIn(literal).map((word) => `${relative(SRC, path)}: "${literal}" holds ${word}`));

  it('finds no old word in the string literals of src/commands and src/cli', () => {
    const files = [...allSourceFiles(join(SRC, 'commands')), ...allSourceFiles(join(SRC, 'cli'))];
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((path) => oldWordLiterals(readFileSync(path, 'utf8'), path))).toEqual([]);
  });

  it('finds an old word in a literal, and leaves comments, import paths and names of code alone', () => {
    const path = join(SRC, 'commands', 'sample.ts');
    expect(oldWordLiterals("const a = 'the staging folder';", path)).toEqual([
      'commands/sample.ts: "the staging folder" holds staging',
    ]);
    expect(oldWordLiterals('const a = `a ${x} brief`;', path)).toHaveLength(1);
    expect(oldWordLiterals("// the staging folder\nconst staging = 'plain';", path)).toEqual([]);
    expect(oldWordLiterals("import { a } from '../migrate/inspect.js';", path)).toEqual([]);
  });
});

describe('the pane options of tmux', () => {
  /** The pane option of FAC-M1 for a work track, and the pane option of the first schema 2 draft. */
  const OLD_PANE_OPTIONS = ['@lane', '@cell'];

  it('names the pane options, the worker option among them', () => {
    expect(tmuxNames.optionWorker).toBe('@worker');
    expect(tmuxNames.optionNode).toBe('@node');
    expect(tmuxNames.optionSlot).toBe('@slot');
    expect(tmuxNames.optionHome).toBe('@factory_home');
  });

  it('keeps every old pane option out of every file of src, names.ts and comments included', () => {
    const files = allSourceFiles(SRC);
    expect(files).toContain(NAMES_FILE);
    const found = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return OLD_PANE_OPTIONS.filter((option) => text.includes(option)).map((option) => `${relative(SRC, path)}: ${option}`);
    });
    expect(found).toEqual([]);
  });
});

describe('deny list', () => {
  it('matches a text that holds a denied name', () => {
    // Built at run time, so that this file does not hold the denied text itself.
    const folder = ['', 'Users', 'x'].join('/');
    const date = ['2026', '01', '01'].join('-');
    expect(denyMatches(`see ${folder} and ${date}`)).toEqual(['user folder', 'date of an event']);
    expect(denyMatches('plain words')).toEqual([]);
  });
});

describe('template placeholders', () => {
  it('leaves no placeholder in a filled template', () => {
    const texts = [...allBlocks.map((template) => template.body), ...Object.values(fileTemplates)];
    for (const text of texts) {
      expect(text.match(/\{\{[^}]*\}\}/g) ?? []).toEqual([]);
    }
  });

  it('fills a placeholder and its capitalized form', () => {
    expect(fillTemplate(['The {{worker}} and the {{Worker}}.'], { worker: 'worker' })).toBe('The worker and the Worker.');
  });

  it('leaves an unknown placeholder in the text', () => {
    expect(fillTemplate(['A {{unknown}} word.'], {})).toBe('A {{unknown}} word.');
  });

  it('builds the paths of the state files from the constants', () => {
    expect(templateValues['nodeFile']).toBe(`${dirs.state}/${files.nodeState}`);
    expect(templateValues['ownerPrefixKey']).toBe(`${keys.root.owner}.${keys.owner.prefix}`);
    expect(templateValues['profileDir']).toBe(`${dirs.state}/${dirs.profile}/`);
  });

  it('puts the program name in the safety block', () => {
    const safety = allBlocks.find((template) => template.name === 'safety');
    expect(safety?.body).toContain(`${program[0]?.toUpperCase()}${program.slice(1)} enforces them`);
  });
});

describe('the approval points of a recipe', () => {
  const CORE_FOLDERS = ['core', 'config', 'templates'].map((folder) => join(SRC, folder));
  const APPROVAL_FILE = join(SRC, 'recipes', 'software', 'approval.ts');
  /** The forms merge, merges, merged, release, releases and released, as whole words, in any case. */
  const RECIPE_WORD = /\b(?:merge[sd]?|release[sd]?)\b/gi;
  /** An import of `approval.ts` inside a folder of a recipe, from any place. */
  const APPROVAL_IMPORT = /(?:^|\/)[^/.][^/]*\/approval(?:\.js)?$/;

  /** The lines of a source text that hold a recipe word, in a string or in a comment. */
  const recipeWordLines = (source: string): string[] =>
    source.split('\n').flatMap((line, index) => (line.match(RECIPE_WORD) === null ? [] : [`line ${index + 1}: ${line.trim()}`]));

  /** The module path of every import, re-export and dynamic import of a source text. */
  const importPathsOf = (source: string): string[] =>
    [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

  const filesIn = (folders: readonly string[]): string[] => folders.flatMap(allSourceFiles);

  it('finds no merge or release word in any string or comment of src/core, src/config or src/templates', () => {
    const found = filesIn(CORE_FOLDERS).flatMap((path) =>
      recipeWordLines(readFileSync(path, 'utf8')).map((line) => `${relative(SRC, path)} ${line}`),
    );
    expect(found).toEqual([]);
  });

  it('scans the three core folders', () => {
    const scanned = filesIn(CORE_FOLDERS).map((path) => relative(SRC, path));
    expect(scanned).toEqual(expect.arrayContaining(['core/result.ts', 'config/schema.ts', 'templates/index.ts']));
  });

  it('finds the recipe words in all their forms, and leaves longer words alone', () => {
    for (const text of ['A merge.', "// 'Merges'", 'a merged change', 'the Release', 'two RELEASES', 'it released']) {
      expect(recipeWordLines(text), text).toHaveLength(1);
    }
    for (const text of ['merge_method', 'mergeMethod', 'releasing', 'merging', 'the unreleased', 'prerelease']) {
      expect(recipeWordLines(text), text).toEqual([]);
    }
  });

  it('lets no file of src/core or src/config import the approval file of a recipe', () => {
    const found = filesIn([join(SRC, 'core'), join(SRC, 'config')]).filter((path) =>
      importPathsOf(readFileSync(path, 'utf8')).some((importPath) => APPROVAL_IMPORT.test(importPath)),
    );
    expect(found.map((path) => relative(SRC, path))).toEqual([]);
  });

  it('reads the module path of each form of import', () => {
    const source = [
      "import { a } from '../recipes/software/approval.js';",
      "export { b } from '../recipes/software/approval';",
      "const c = await import('../recipes/software/approval.js');",
      "import '../recipes/software/approval.js';",
      "import { d } from '../recipes/index.js';",
    ].join('\n');
    const paths = importPathsOf(source);
    expect(paths).toHaveLength(5);
    expect(paths.filter((path) => APPROVAL_IMPORT.test(path))).toHaveLength(4);
  });

  it('keeps the approval file apart: it imports only the names file, and the registry imports it', () => {
    const imports = importPathsOf(readFileSync(APPROVAL_FILE, 'utf8'));
    expect(imports.filter((path) => !path.endsWith('/names.js'))).toEqual([]);
    const registry = readFileSync(join(SRC, 'recipes', 'index.ts'), 'utf8');
    expect(importPathsOf(registry).some((path) => APPROVAL_IMPORT.test(path))).toBe(true);
  });

  it('accepts the approval point ids in the approval file of a recipe, and refuses them in other files', () => {
    const ids = [...POINT_IDS];
    expect(ids).toEqual(expect.arrayContaining(['merge', 'release']));
    for (const id of ids) {
      expect(violationsInText(`const a = '${id}';`, APPROVAL_FILE)).toEqual([]);
      expect(violationsInText(`const a = '${id}';`, join(SRC, 'sample.ts'))).toEqual([
        `sample.ts: "${id}" is an approval point id`,
      ]);
      expect(violationsInText(`const a = '${id}';`, join(SRC, 'recipes', 'software', 'recipe.ts'))).toHaveLength(1);
    }
  });

  it('still scans the approval file for the other names', () => {
    expect(violationsInText(`const a = '${commands.init}';`, APPROVAL_FILE)).toEqual([
      'recipes/software/approval.ts: "init" is a name',
    ]);
  });

  it('names the two modes of an approval point in the names file', () => {
    expect(values.approvalModes).toEqual(['owner', 'delegated']);
    expect(violationsInText("const a = 'delegated';", join(SRC, 'sample.ts'))).toEqual(['sample.ts: "delegated" is a name']);
  });
});
