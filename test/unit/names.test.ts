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
} from '../../src/names.js';
import { commandTable, renderCommandHelp, renderHelp } from '../../src/cli/table.js';
import { runInit } from '../../src/commands/init.js';
import { fillTemplate } from '../../src/templates/fill.js';
import { fileTemplates } from '../../src/templates/index.js';
import { allBlocks } from '../helpers/blocks.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { oldWordsIn } from '../helpers/old-words.js';

const SRC = join(__dirname, '..', '..', 'src');
const NAMES_FILE = join(SRC, 'names.ts');

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
]);

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
    if (/^(node:|\.{1,2}\/)/.test(literal)) continue;
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

describe('words of the old names', () => {
  it('finds an old word in a text, in any case and in a plural', () => {
    expect(oldWordsIn('A Lane, two packs and a brief.')).toEqual(['Lane', 'packs', 'brief']);
    expect(oldWordsIn('Brief the cell. It was briefed.')).toEqual(['Brief', 'briefed']);
    expect(oldWordsIn('A package of plain words and a cell.')).toEqual([]);
  });

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
