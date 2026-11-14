import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  address,
  blockNames,
  boardKeys,
  boardTextLimits,
  checkIds,
  claudeSettingKeys,
  claudeSettings,
  commandLines,
  commands,
  coordinatorTemplateValues,
  decisionKeys,
  decisionLogKeys,
  dirs,
  env,
  files,
  flags,
  ghTimeoutMs,
  heavyLock,
  hookNames,
  instructionFiles,
  itemCommands,
  keys,
  lessonLimits,
  lockLine,
  lockWords,
  machineNames,
  marker,
  markLimits,
  maxFileBytes,
  maxSetupTextBytes,
  maxTrackLines,
  messageFile,
  messageHeader,
  messageHeaderLines,
  nodeCommands,
  nodeInbox,
  nodeSendReasons,
  permissionSkipList,
  powerKeys,
  powerSources,
  program,
  queueWords,
  relayedMarker,
  requestCommands,
  requestGroups,
  requestHash,
  requestRowKeys,
  reservedFieldNames,
  reservedRootNames,
  roleText,
  roles,
  schema1,
  schema2,
  schemaIds,
  sessionNames,
  setupAcceptance,
  stateKeys,
  templateValues,
  terms,
  tmuxNames,
  trackedFiles,
  typing,
  values,
  workItemDisplayKeys,
  workerRowKeys,
} from '../../src/names.js';
import { projectPathIssue } from '../../src/core/project-path.js';
import { commandTable, renderCommandHelp, renderHelp } from '../../src/cli/table.js';
import { glossary } from '../../src/glossary.js';
import { recipes } from '../../src/recipes/index.js';
import { mergeMethods, softwareProjectKeys } from '../../src/recipes/software/words.js';
import { fillTemplate } from '../../src/templates/fill.js';
import { fileTemplates } from '../../src/templates/index.js';
import { allBlocks } from '../helpers/blocks.js';
import { denyMatches } from '../helpers/deny-list.js';
import { createFakeDeps } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { OLD_WORD_ENDINGS, OLD_WORD_LIST, oldWordsIn } from '../helpers/old-words.js';
import { runInit } from '../helpers/package-registry.js';
import { JARGON_ERE, JARGON_PATTERNS, jargonIn } from '../helpers/plain-words.js';
import { MAX_OUTPUT_LINES } from '../helpers/short-output.js';
import { allSourceFiles, callsOf, importPathsOf, literalsOf, shellValue, stripComments } from '../helpers/source-scan.js';

const SRC = join(__dirname, '..', '..', 'src');
const NAMES_FILE = join(SRC, 'names.ts');
const GLOSSARY_FILE = join(SRC, 'glossary.ts');
const EXIT_CHECK = join(__dirname, '..', '..', 'scripts', 'exit-check.sh');
const INSTALL_CHECK = join(__dirname, '..', '..', 'scripts', 'install-check.sh');

/** An import path is no text for a user. */
const IMPORT_PATH = /^(node:|\.{1,2}\/)/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && path !== NAMES_FILE ? [path] : [];
  });

const flat = (...groups: readonly Record<string, unknown>[]): string[] =>
  groups.flatMap((group) => Object.values(group).flatMap((value) => (typeof value === 'string' ? [value] : [])));

/**
 * Flags that are plain words too, which the source uses for other things: `text` is the level of a line of output, `title`
 * and `stage` are keys of an item, `file` is the kind of an entry in a folder, and `closed` is a state of an item and of a pane. A
 * literal that equals one of them is no breach. A literal that holds the flag with its two dashes (`--text`) still is one: the check
 * of the flags below has no such exemption.
 */
const PLAIN_WORD_FLAGS: ReadonlySet<string> = new Set([flags.text, flags.title, flags.stage, flags.file, flags.closed]);

/** Subcommands that are plain words too: `tree` is also the kind of an entry in a git tree. A literal that equals one of them is no breach. */
const PLAIN_WORD_SUBCOMMANDS: ReadonlySet<string> = new Set([nodeCommands.tree]);

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
    keys.tracker,
    keys.recipe,
    keys.link,
    stateKeys,
    schema1.keys,
    { windowView: tmuxNames.windowView, windowWorkers: tmuxNames.windowWorkers, slotBoard: tmuxNames.slotBoard },
  ).filter((name) => !PLAIN_WORD_FLAGS.has(name) && !PLAIN_WORD_SUBCOMMANDS.has(name)),
  ...values.approvalModes,
]);

/**
 * The approval point ids of every recipe. They are config keys, so no file may hold one as a literal,
 * except the approval file and the words file of a recipe (`src/recipes/<id>/approval.ts` and `words.ts`),
 * which own the names of their recipe.
 */
const POINT_IDS = new Set(recipes.flatMap((entry) => entry.approvalPoints.map((point) => point.id)));
const RECIPE_APPROVAL_FILE = /[\\/]recipes[\\/][^\\/]+[\\/](?:approval|words)\.ts$/;

/**
 * The project key and the values of a recipe. They are config names, so the same rule holds for them.
 */
const RECIPE_NAMES = new Set<string>(
  [softwareProjectKeys.mergeMethod, ...mergeMethods].filter((name) => !POINT_IDS.has(name)),
);

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
    if (RECIPE_NAMES.has(literal) && !RECIPE_APPROVAL_FILE.test(path)) found.push(`"${literal}" is a name of a recipe`);
    if (!GIT_VOCABULARY_FILES.has(path)) {
      if (EXACT_NAMES.has(literal)) found.push(`"${literal}" is a name`);
      for (const flag of flat(flags)) {
        if (new RegExp(`--${flag}(?![A-Za-z0-9-])`).test(literal)) found.push(`"${literal}" holds the flag --${flag}`);
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

  it('leaves a flag that is a plain word alone as a word, and reports it with its two dashes', () => {
    const path = join(SRC, 'sample.ts');
    for (const flag of PLAIN_WORD_FLAGS) {
      expect(violationsInText(`const a = '${flag}';`, path)).toEqual([]);
      expect(violationsInText(`const a = 'use --${flag} here';`, path)).toEqual([`sample.ts: "use --${flag} here" holds the flag --${flag}`]);
    }
    expect(violationsInText(`const a = '${flags.home}';`, path)).toEqual([`sample.ts: "${flags.home}" is a name`]);
  });

  it('leaves a subcommand that is a plain word alone as a word', () => {
    const path = join(SRC, 'sample.ts');
    for (const word of PLAIN_WORD_SUBCOMMANDS) expect(violationsInText(`const a = '${word}';`, path)).toEqual([]);
    expect(violationsInText(`const a = '${nodeCommands.send}';`, path)).toEqual([`sample.ts: "${nodeCommands.send}" is a name`]);
  });

  it('reports a flag only as a whole flag, so the git flag --staged is not the flag --stage', () => {
    const path = join(SRC, 'sample.ts');
    expect(violationsInText("const a = 'git restore --staged';", path)).toEqual([]);
    expect(violationsInText(`const a = 'git restore --${flags.home}=x';`, path)).toHaveLength(1);
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

describe('the limits of the track list', () => {
  it('holds the track lines to the output cap minus the summary line, the table heading and the more-tracks line', () => {
    expect(maxTrackLines).toBe(MAX_OUTPUT_LINES - 3);
    expect(maxTrackLines).toBe(17);
  });
});

describe('the role words and the terms', () => {
  /** The old words that the names of the glossary replaced in the roles and the terms. */
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

/** The old words and the scanned jargon words that a text holds. */
const plainWordsIn = (text: string): string[] => [...oldWordsIn(text), ...jargonIn(text)];

/**
 * The scan of the old words covers: the help text of every command, `package.json`, the templates, the glossary,
 * the files that init writes, and the string literals of every folder of `src`. The scan of the jargon words covers
 * the same, apart from `package.json`. It does not cover import paths, comments, the history of the docs, or the mapping
 * tables of design 7 and 7.1, which name the old words on purpose.
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

  it('keeps the old words and the jargon words out of the help of every command', () => {
    const texts = [renderHelp(), ...commandTable.map(renderCommandHelp)];
    expect(texts.flatMap(plainWordsIn)).toEqual([]);
  });

  it('keeps the old words out of package.json, which the npm page shows', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(oldWordsIn(text)).toEqual([]);
  });

  it('keeps the package private, so that npm publish refuses it, and builds the program on a git install', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ private: true, scripts: { prepare: 'npm run build' } });
  });

  it('puts the quick-start guide in the files of the package, so that the link of the README resolves after an install', () => {
    const manifest: unknown = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ files: expect.arrayContaining(['docs/quick-start.md']) });
  });

  it('keeps the old words and the jargon words out of every template', () => {
    const texts = [...allBlocks.map((template) => template.body), ...Object.values(fileTemplates)];
    expect(texts.flatMap(plainWordsIn)).toEqual([]);
  });

  it('keeps the old words and the jargon words out of the glossary', () => {
    expect(glossary.length).toBeGreaterThan(10);
    expect(glossary.flatMap((word) => plainWordsIn(`${word.term} ${word.text}`))).toEqual([]);
  });

  it('keeps the old words and the jargon words out of the files that init writes', async () => {
    const { handler } = gitHandler({ gh: 'some-login' });
    const deps = createFakeDeps({ cwd: '/w', run: handler, env: { XDG_STATE_HOME: '/state', HOME: '/users/me' } });
    const result = await runInit(deps, {
      home: '/w/node',
      name: undefined,
      ownerName: 'Test Owner',
      ownerGithub: undefined,
      projects: [],
      yes: true,
      recipe: undefined,
      layer: undefined,
      approval: [],
    });
    expect(result.ok).toBe(true);
    expect(deps.files.size).toBeGreaterThan(10);
    // The state .gitignore names the folder of the event file by its name on disk, as a line of its own. Only that file may do so.
    const diskLine = `${dirs.outbox}/`;
    const stateGitignore = `/${dirs.state}/${files.gitignore}`;
    for (const [path, text] of deps.files) {
      const scanned = path.endsWith(stateGitignore)
        ? text
            .split('\n')
            .filter((line) => line !== diskLine)
            .join('\n')
        : text;
      expect({ path, found: plainWordsIn(scanned) }).toEqual({ path, found: [] });
    }
  });
});

describe('the old words in the exit check', () => {
  const exitCheck = readFileSync(EXIT_CHECK, 'utf8');

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

  it('holds the same jargon words as the plain-words helper, in the same order', () => {
    expect(shellValue(exitCheck, 'jargon_words')).toBe(JARGON_ERE);
    expect(JARGON_ERE.split('|')).toHaveLength(JARGON_PATTERNS.length);
  });

  it('names the plain-words helper in a comment, and scans the generated files and the help texts for the jargon words', () => {
    expect(exitCheck).toMatch(/^#.*test\/helpers\/plain-words\.ts/m);
    expect(exitCheck).toMatch(/^scan "a jargon word" /m);
  });

  it('writes the jargon words in a form that grep -E reads: no group with a question mark', () => {
    expect(JARGON_ERE).not.toContain('(?');
  });

  it('reads a value of the script, and finds none for a name that the script does not set', () => {
    expect(shellValue('a="x y"\nb="z"\n', 'a')).toBe('x y');
    expect(shellValue('a="x y"\nb="z"\n', 'c')).toBeUndefined();
    expect(shellValue('# a="x"\n', 'a')).toBeUndefined();
  });
});

describe('the flow and the clean-up of the exit check', () => {
  const lines = readFileSync(EXIT_CHECK, 'utf8').split('\n');
  const code = lines.filter((line) => !line.trimStart().startsWith('#'));

  it('removes one folder only: the one that its own mktemp made, behind a guard that tests the variable', () => {
    const removals = code.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /\brm\b/.test(line));
    expect(removals.map(({ line }) => line)).toEqual(['rm -rf "$tmp"']);
    const removal = removals[0]?.index ?? -1;
    expect(code[removal - 1]?.trim()).toBe('if [ -n "$tmp" ] && [ -d "$tmp" ]; then');
    const assignments = code.map((line) => line.trim()).filter((line) => /^tmp=/.test(line));
    expect(assignments).toEqual(['tmp=""', 'tmp="$(mktemp -d "${base%/}/factory-exit-check.XXXXXX")"']);
  });

  it('takes the base of its temp folder from FACTORY_TMP or TMPDIR', () => {
    expect(shellValue(lines.join('\n'), 'base')).toBe('${FACTORY_TMP:-${TMPDIR:-/tmp}}');
  });

  it('makes the factory folder with init --yes inside a repo whose https origin a local bare repo serves', () => {
    const text = code.join('\n');
    expect(text).toMatch(/origin_url="https:\/\//);
    expect(text).toMatch(/git config --file "\$GIT_CONFIG_GLOBAL" --add "url\.\$bare\.insteadOf" "\$origin_url"/);
    expect(text).toMatch(/git -C "\$web" remote add origin "\$origin_url"/);
    expect(text).toContain('cd "$web" && factory init --yes');
    expect(text).toContain('home="$tmp/web-factory"');
    expect(text).toContain('clone="$home/web"');
  });

  it('runs start --dry-run and doctor with no --home from the factory folder, the coordinator folder and the clone', () => {
    const text = code.join('\n');
    expect(text).toContain('for place in "$home" "$home/coordinator" "$clone"; do');
    expect(text).toMatch(/run_in "\$place" factory start --dry-run/);
    expect(text).toMatch(/run_in "\$place" factory doctor/);
    expect(code.filter((line) => line.includes('--home'))).toEqual([]);
  });

  it('runs the scans after the commands', () => {
    const text = code.join('\n');
    const doctor = text.indexOf('run_in "$place" factory doctor');
    expect(doctor).toBeGreaterThan(0);
    expect(text.indexOf('step "deny list"')).toBeGreaterThan(doctor);
  });
});

describe('the install check', () => {
  const codeOf = (text: string): string[] => text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  const exitCode = codeOf(readFileSync(EXIT_CHECK, 'utf8'));
  const installText = readFileSync(INSTALL_CHECK, 'utf8');
  const code = codeOf(installText);
  /** The code lines without indentation and without the && that joins the steps of a function. */
  const lines = code.map((line) => line.trim().replace(/ &&$/, ''));
  const exportNames = (all: string[]): string[] =>
    all.flatMap((line) => /^export ([A-Za-z_]+)=/.exec(line.trim())?.[1] ?? []).sort();
  const unsetLines = (all: string[]): string[] => all.filter((line) => /^unset\s/.test(line.trim()));
  const unsetNames = (all: string[]): string[] =>
    unsetLines(all).flatMap((line) => line.trim().slice('unset '.length).split(' '));

  it('removes one folder only: the one that its own mktemp made, behind a guard that tests the variable', () => {
    const removals = code.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /\brm\b/.test(line));
    expect(removals.map(({ line }) => line)).toEqual(['rm -rf "$tmp"']);
    const removal = removals[0]?.index ?? -1;
    expect(code[removal - 1]?.trim()).toBe('if [ -n "$tmp" ] && [ -d "$tmp" ]; then');
    const assignments = lines.filter((line) => /^tmp=/.test(line));
    expect(assignments).toEqual(['tmp=""', 'tmp="$(mktemp -d "${base%/}/factory-install-check.XXXXXX")"']);
  });

  it('stops on the first failure, and sets the clean-up trap before its mktemp', () => {
    expect(lines).toContain('set -euo pipefail');
    const trap = lines.indexOf('trap cleanup EXIT');
    expect(trap).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.startsWith('tmp="$(mktemp '))).toBeGreaterThan(trap);
  });

  it('isolates HOME, the npm prefix, the npm cache and the npm configs before it runs the first git or npm command', () => {
    const isolation = [
      'export HOME="$tmp/home"',
      'export npm_config_prefix="$tmp/prefix"',
      'export npm_config_cache="$tmp/npm-cache"',
      'export npm_config_userconfig="$tmp/npmrc"',
      'export npm_config_globalconfig="$tmp/npmrc-global"',
    ].map((line) => lines.indexOf(line));
    expect(isolation.filter((index) => index < 0)).toEqual([]);
    const unset = lines.findIndex((line) => /^unset\s/.test(line));
    expect(unset).toBeGreaterThan(-1);
    const isolated = Math.max(...isolation, unset);
    /** The lines that run git or npm, outside the quoted text and outside the checks that look for the program. */
    const runs = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !line.startsWith('command -v ') && /\b(git|npm)\s/.test(line.replace(/"[^"]*"/g, '')));
    expect(runs.length).toBeGreaterThan(5);
    expect(runs.filter(({ index }) => index <= isolated)).toEqual([]);
  });

  it('stops before its first git command when a git hook exports the names of a repo, or git settings come from the environment, so that npm can not write the source repo or read a setting of the caller', () => {
    const guard = lines.findIndex((line) => line.startsWith('for name in GIT_DIR '));
    expect(lines[guard]).toBe(
      'for name in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT; do',
    );
    expect(lines[guard + 1]).toMatch(/^\[ -z "\$\{!name\+set\}" \] \|\| fail /);
    const firstGit = lines.findIndex((line) => /\bgit (-C|-c|init|config|--git-dir)\b/.test(line));
    expect(firstGit).toBeGreaterThan(guard);
  });

  it('takes the base of its temp folder from FACTORY_TMP or TMPDIR, as the exit check does', () => {
    expect(shellValue(installText, 'base')).toBe('${FACTORY_TMP:-${TMPDIR:-/tmp}}');
  });

  it('exports the same names as the exit check', () => {
    expect(exportNames(exitCode)).toContain('HOME');
    expect(exportNames(exitCode)).toContain('npm_config_prefix');
    expect(exportNames(code)).toEqual(exportNames(exitCode));
  });

  it('unsets the names of the exit check, and the ssh agent socket, the two Claude credentials and the two npm token names', () => {
    expect(unsetLines(code)).toHaveLength(1);
    expect(unsetNames(exitCode).length).toBeGreaterThan(5);
    expect(unsetNames(code).sort()).toEqual(
      [
        ...unsetNames(exitCode),
        'SSH_AUTH_SOCK',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'NPM_TOKEN',
        'NODE_AUTH_TOKEN',
      ].sort(),
    );
  });

  describe('the removal of the inherited npm settings', () => {
    const start = lines.indexOf('shopt -s nocasematch');
    const end = lines.indexOf('shopt -u nocasematch');
    const block = lines.slice(start, end + 1);
    /** Run the removal block alone, in the shell that runs the check, with only the given environment. */
    const runBlock = (env: Record<string, string>): { status: number | null; stdout: string; stderr: string } => {
      const script = [
        'set -euo pipefail',
        'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
        ...block,
        'env',
      ].join('\n');
      const result = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    it('sits before the scratch exports, and switches the case-blind match off again before the commit check', () => {
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      expect(lines.indexOf('export HOME="$tmp/home"')).toBeGreaterThan(end);
      expect(lines.findIndex((line) => line.startsWith('sha="$(git '))).toBeGreaterThan(end);
    });

    it('removes every npm_config name in any letter case, and keeps the other names', () => {
      const result = runBlock({
        npm_config_registry: 'https://example.invalid/',
        NPM_CONFIG_OFFLINE: 'true',
        Npm_Config_Dry_Run: 'true',
        npm_config_cache: '/nowhere',
        npm_configuration: 'kept',
        NPMRC: 'kept',
        KEEP_ME: 'yes',
      });
      expect(result.status).toBe(0);
      const names = result.stdout.split('\n').map((line) => line.split('=')[0]);
      expect(names.filter((name) => /^npm_config_/i.test(name ?? ''))).toEqual([]);
      expect(names).toEqual(expect.arrayContaining(['npm_configuration', 'NPMRC', 'KEEP_ME']));
    });

    it('never passes on an npm_config name that is not a shell name, because bash can not unset it, and never prints its value', () => {
      const result = runBlock({ 'npm_config_//registry.npmjs.org/:_authToken': 'secret' });
      expect(result.status === 0 && result.stdout.includes('_authToken')).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('secret');
    });
  });

  it('takes the commit id from HEAD of this checkout, accepts 40 lower-case hex characters only, and quotes every use', () => {
    expect(lines.filter((line) => /^sha=/.test(line))).toEqual(['sha="$(git -C "$root" rev-parse HEAD)"']);
    expect(lines.some((line) => /^\[\[ "\$sha" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| fail /.test(line))).toBe(true);
    expect(code.join('\n')).toContain('^[0-9a-f]{40}$');
    expect(lines.filter((line) => line.replace(/"[^"]*"/g, '').includes('$sha'))).toEqual([]);
    expect(installText).not.toContain('${{');
  });

  it('writes nothing to the source repo: it only reads HEAD and pushes that commit with hooks off into the scratch bare repo', () => {
    const gitOnSource = lines.filter((line) => /\bgit\b/.test(line) && /\$\{?root\}?/.test(line));
    expect(gitOnSource).toEqual([
      'sha="$(git -C "$root" rev-parse HEAD)"',
      'git -c core.hooksPath=/dev/null -C "$root" push -q "$tmp/source.git" "$sha:refs/heads/install-proof"',
    ]);
    expect(lines.filter((line) => /\bbranch\s+-f\b|\bcheckout\b/.test(line))).toEqual([]);
    expect(lines).toContain('git --git-dir="$tmp/source.git" symbolic-ref HEAD refs/heads/install-proof');
  });

  it('packs the commit from the scratch bare repo, then installs that tarball, with the install scripts and the registry on', () => {
    expect(lines.filter((line) => /\bnpm pack\b/.test(line))).toEqual([
      'logged pack npm pack --no-audit --no-fund --pack-destination "$tmp/pack" "git+file://$tmp/source.git#$sha"',
    ]);
    const installs = lines.filter((line) => /\bnpm install\b/.test(line));
    expect(installs).toEqual(['logged install npm install --global --no-audit --no-fund "$tarball"']);
    expect(installs.filter((line) => line.includes('://'))).toEqual([]);
    expect(lines.filter((line) => /--ignore-scripts|--offline/.test(line))).toEqual([]);
  });

  it('installs only when the pack folder holds exactly one tarball, and fails closed on none or many', () => {
    expect(lines).toContain('shopt -s nullglob');
    expect(lines).toContain('files=("$tmp/pack"/*.tgz)');
    expect(lines).toContain('[ "${#files[@]}" -eq 1 ] || return 1');
    expect(lines.some((line) => /^tarball="\$\(pick_tarball\)" \|\| fail /.test(line))).toBe(true);
    const pick = lines.findIndex((line) => line.startsWith('tarball='));
    const install = lines.findIndex((line) => /\bnpm install\b/.test(line));
    expect(pick).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(pick);
  });

  it('finds factory in the scratch prefix, and fails unless the installed program is a file that runs and equals the build', () => {
    expect(lines).toContain('found="$(command -v factory || true)"');
    expect(lines.some((line) => /^\[ "\$found" = "\$npm_config_prefix\/bin\/factory" \] \|\| fail /.test(line))).toBe(true);
    expect(lines.some((line) => /^\[ -f "\$installed_js" \] \|\| fail /.test(line))).toBe(true);
    expect(lines.some((line) => /^\[ -x "\$installed_js" \] \|\| fail /.test(line))).toBe(true);
    const compares = lines.filter((line) => /\bcmp\b/.test(line));
    expect(compares).toHaveLength(1);
    expect(compares[0]).toMatch(/^cmp -s "\$installed_js" "\$root\/dist\/factory\.js" \|\| fail /);
    expect(lines).toContain(`printf 'registry=https://registry.npmjs.org/\\n' >"$npm_config_userconfig"`);
  });

  it('names the exit check in its header', () => {
    expect(installText).toMatch(/^#.*scripts\/exit-check\.sh/m);
  });
});

describe('the old words and the jargon words in the text of the source', () => {
  /** The folders that print text, and the top files of src. */
  const TEXT_FOLDERS = [
    'board',
    'commands',
    'cli',
    'config',
    'core',
    'upgrade',
    'blocks',
    'launch',
    'comms',
    'report',
    'migrate',
    'templates',
    'recipes',
    'state',
    'safety',
  ];

  /**
   * The keys and folder names of the older layouts. They are names of code that only the migration reads, so they stay
   * in `names.ts`.
   */
  const OLD_LAYOUT_NAMES: ReadonlySet<string> = new Set([
    ...Object.values(schema1.keys),
    schema1.briefsDir,
    schema2.workersKey,
  ]);

  /**
   * The names on disk that stay although the table of plain words has a plain word for them (the file name stays): the
   * folder of the last-seen files, and the folder of the report of a node. Only `names.ts` holds them, and text for a user says
   * "last seen" and "event file".
   */
  const DISK_NAMES: ReadonlySet<string> = new Set([dirs.heartbeat, dirs.outbox]);

  /**
   * The old words and the scanned jargon words that a string literal of the source holds, with the file. Comments and
   * import paths are not text. A name of an older layout in `names.ts` is no text either, and neither is a name on disk.
   */
  const plainWordHits = (source: string, path: string): string[] =>
    literalsOf(source)
      .filter((literal) => !IMPORT_PATH.test(literal))
      .filter((literal) => path !== NAMES_FILE || !(OLD_LAYOUT_NAMES.has(literal) || DISK_NAMES.has(literal)))
      .flatMap((literal) => plainWordsIn(literal).map((word) => `${relative(SRC, path)}: "${literal}" holds ${word}`));

  it('scans every folder that prints text, and the top files of src', () => {
    const scanned = allSourceFiles(SRC).map((path) => relative(SRC, path));
    for (const folder of TEXT_FOLDERS) {
      expect(scanned.some((path) => path.startsWith(`${folder}/`)), folder).toBe(true);
    }
    expect(scanned).toEqual(expect.arrayContaining(['names.ts', 'glossary.ts', 'main.ts']));
  });

  it('finds no old word and no jargon word in the string literals of src', () => {
    const files = allSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(60);
    expect(files.flatMap((path) => plainWordHits(readFileSync(path, 'utf8'), path))).toEqual([]);
  });

  /**
   * In user text, "request" means only the item that waits on the owner (the glossary entry, and the name of its term),
   * and "message" means only the record from another owner. The tmux command `display-message`, the recipe word
   * "pull request" and the phrase "messages between sessions" (the name of the agent feature that sends text from one
   * session to another) are other names. The note of the header of a file that `node send` writes states that the file is a
   * message: it is the one literal of `names.ts` that holds the word. A "checkout" of a project is a work copy, or a work
   * tree of git.
   */
  const wordRuleHits = (source: string, path: string): string[] =>
    literalsOf(source)
      .filter((literal) => !IMPORT_PATH.test(literal))
      .filter(
        (literal) =>
          literal !== 'display-message' &&
          !(path === NAMES_FILE && (literal === 'request' || literal === requestHash.tag || literal === messageHeader.notice)),
      )
      .map((literal) => literal.replace(/pull requests?/gi, ' ').replace(/messages between sessions/gi, ' '))
      .filter((literal) => path !== GLOSSARY_FILE && /(?<![A-Za-z0-9_])(?:requests?|messages?|checkouts?)(?![A-Za-z0-9_])/i.test(literal))
      .map((literal) => `${relative(SRC, path)}: "${literal}"`);

  it('uses the words request and message only in their own sense, and says work copy for a checkout', () => {
    const files = allSourceFiles(SRC);
    expect(files.flatMap((path) => wordRuleHits(readFileSync(path, 'utf8'), path))).toEqual([]);
  });

  it('finds the words request and message in other senses, and leaves the own senses alone', () => {
    const path = join(SRC, 'commands', 'sample.ts');
    expect(wordRuleHits("const a = 'a health request went out';", path)).toHaveLength(1);
    expect(wordRuleHits("const a = 'Accept it as a message.';", path)).toHaveLength(1);
    expect(wordRuleHits("const a = 'in its own checkout';", path)).toHaveLength(1);
    expect(wordRuleHits("const a = 'open a pull request';", path)).toEqual([]);
    expect(wordRuleHits("const a = 'display-message';", path)).toEqual([]);
    expect(wordRuleHits("const a = 'the messages between sessions need 2.1.224';", path)).toEqual([]);
    expect(wordRuleHits("const a = 'a message between sessions waits';", path)).toHaveLength(1);
    expect(wordRuleHits("const a = 'request';", NAMES_FILE)).toEqual([]);
    expect(wordRuleHits("const a = 'request';", path)).toHaveLength(1);
    expect(wordRuleHits("const a = 'a request waits';", GLOSSARY_FILE)).toEqual([]);
  });

  it('finds an old word or a jargon word in a literal, and leaves comments, import paths and names of code alone', () => {
    const path = join(SRC, 'commands', 'sample.ts');
    expect(plainWordHits("const a = 'the staging folder';", path)).toEqual([
      'commands/sample.ts: "the staging folder" holds staging',
    ]);
    expect(plainWordHits('const a = `a ${x} brief`;', path)).toHaveLength(1);
    expect(plainWordHits("const a = 'the owner record is stale';", path)).toEqual([
      'commands/sample.ts: "the owner record is stale" holds owner record',
    ]);
    expect(plainWordHits("// the staging folder\nconst staging = 'plain';", path)).toEqual([]);
    expect(plainWordHits("const schema1 = { keys: { lanes: 'lanes' } };", NAMES_FILE)).toEqual([]);
    expect(plainWordHits("const a = 'lanes';", path)).toHaveLength(1);
    expect(plainWordHits("const dirs = { heartbeat: 'heartbeat' };", NAMES_FILE)).toEqual([]);
    expect(plainWordHits("const a = 'heartbeat';", path)).toHaveLength(1);
    expect(plainWordHits("// the heartbeat\nconst heartbeat = 'plain';", path)).toEqual([]);
    expect(plainWordHits("import { a } from '../migrate/inspect.js';", path)).toEqual([]);
  });
});

describe('the words home and root for a factory folder in the text of the source', () => {
  /**
   * The words that the table of plain words rules out in user text for the folder of a factory: home and root, as whole
   * words. The flag `--home`, the variable `FACTORY_HOME`, and a name with a hyphen or an underscore are names of code,
   * so they do not match. The capital letters of `HOME` are the variable of the account.
   */
  const FOLDER_WORD = /(?<![A-Za-z0-9_$-])(?:[Hh]ome|[Rr]oot)s?(?![A-Za-z0-9_-])/;

  /**
   * The literals where the words stay, by exact value. Each one is a name of code and no text: the flag `home`, the
   * keys and the file name of the factory list (design 4.3 keeps `homes.json`), the key `root` of the record files,
   * and the id `root` of a doctor check.
   */
  const KEPT: ReadonlySet<string> = new Set<string>(['home', 'homes', 'homes.json', 'root']);

  const folderWordHits = (source: string, path: string): string[] =>
    literalsOf(source)
      .filter((literal) => !IMPORT_PATH.test(literal) && !KEPT.has(literal) && FOLDER_WORD.test(literal))
      .map((literal) => `${relative(SRC, path)}: "${literal}"`);

  it('finds no home and no root in the string literals of src', () => {
    const files = allSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(60);
    expect(files.flatMap((path) => folderWordHits(readFileSync(path, 'utf8'), path))).toEqual([]);
  });

  it('finds the words as whole words in a literal, and leaves names of code and comments alone', () => {
    const path = join(SRC, 'commands', 'sample.ts');
    expect(folderWordHits("const a = 'the root repo tracks it';", path)).toHaveLength(1);
    expect(folderWordHits("const a = 'a tmux session of another home';", path)).toHaveLength(1);
    expect(folderWordHits('const a = `the child homes ${x}`;', path)).toHaveLength(1);
    expect(folderWordHits("const a = 'Root folder';", path)).toHaveLength(1);
    expect(folderWordHits("const a = 'name it with --home';", path)).toEqual([]);
    expect(folderWordHits("const a = 'FACTORY_HOME';", path)).toEqual([]);
    expect(folderWordHits("const a = 'Set HOME to a folder';", path)).toEqual([]);
    expect(folderWordHits("const a = 'root-repo';", path)).toEqual([]);
    expect(folderWordHits("const a = 'homepage';", path)).toEqual([]);
    expect(folderWordHits("// the root repo\nconst root = 'plain';", path)).toEqual([]);
    expect(folderWordHits("import { a } from '../core/root-paths.js';", path)).toEqual([]);
  });
});

describe('the name of the worker window in the docs that a user reads', () => {
  /**
   * The README and the docs that explain the tool name the window `workers`. The old name `bench` stays only where the
   * design and the glossary quote it as an old word: `docs/design.md` (its history rows) and `docs/glossary.md`.
   */
  const USER_DOCS = ['README.md', 'docs/roadmap-v2.md', 'docs/token-budget.md', 'docs/quick-start.md'];
  const textOf = (name: string): string => readFileSync(join(__dirname, '..', '..', name), 'utf8');

  it.each(USER_DOCS)('does not name the old window bench in %s', (name) => {
    expect(textOf(name).match(/\bbench\b/gi) ?? []).toEqual([]);
  });

  it('names the window workers in the README', () => {
    expect(textOf('README.md')).toContain(`window \`${tmuxNames.windowWorkers}\``);
  });
});

describe('the install command builds the commit of the hand-over, not the tag name', () => {
  /**
   * A tag can move. So the command that builds the package takes the full commit SHA of the hand-over, which step 1 of the
   * guide proved is the commit of the tag. The tag stays the name of the hand-over and the target of that check.
   */
  const INSTALL_DOCS = ['README.md', 'docs/quick-start.md', 'CHANGELOG.md'];
  const SHA_DOCS = ['README.md', 'docs/quick-start.md'];
  const textOf = (name: string): string => readFileSync(join(__dirname, '..', '..', name), 'utf8');
  const gitUrlsOf = (text: string): string[] => text.match(/git\+(?:ssh|https):\/\/[^\s"'`]+/g) ?? [];

  it.each(INSTALL_DOCS)('ends every git URL of an install command with #<sha> in %s', (name) => {
    const urls = gitUrlsOf(textOf(name));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.endsWith('#<sha>'))).toEqual([]);
  });

  it.each(SHA_DOCS)('says once what <sha> is in %s', (name) => {
    const definitions = textOf(name).match(/`<sha>` is the full 40-character commit SHA/g) ?? [];
    expect(definitions).toHaveLength(1);
  });

  it('keeps the check of the tag with git ls-remote in the guide, for both paths', () => {
    const guide = textOf('docs/quick-start.md');
    expect(guide).toContain("git ls-remote https://github.com/dean0x/factory.git 'refs/tags/v0.2.0-ea.N^{}'");
    expect(guide).toContain('`git@github.com:dean0x/factory.git` in place of `https://github.com/dean0x/factory.git`');
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

  it('keeps the approval file apart: it imports only the names file, and the entry file of the recipe imports it', () => {
    const imports = importPathsOf(readFileSync(APPROVAL_FILE, 'utf8'));
    expect(imports.filter((path) => !path.endsWith('/names.js'))).toEqual([]);
    const entry = readFileSync(join(SRC, 'recipes', 'software', 'entry.ts'), 'utf8');
    expect(importPathsOf(entry)).toContain('./approval.js');
  });

  it('accepts the project key and the values of a recipe in its words file, and refuses them in other files', () => {
    const names = [softwareProjectKeys.mergeMethod, ...mergeMethods];
    expect(names).toEqual(['merge_method', 'squash', 'merge', 'rebase']);
    for (const name of names) {
      expect(violationsInText(`const a = '${name}';`, join(SRC, 'recipes', 'software', 'words.ts'))).toEqual([]);
      expect(violationsInText(`const a = '${name}';`, join(SRC, 'sample.ts')).length).toBeGreaterThan(0);
      expect(violationsInText(`const a = '${name}';`, join(SRC, 'recipes', 'software', 'recipe.ts')).length).toBeGreaterThan(0);
    }
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

describe('the writers of the approval record and of the setup acceptance', () => {
  const OWNER_RECORD = join(SRC, 'core', 'owner-record.ts');
  const SETUP_ACCEPTANCE = join(SRC, 'core', 'setup-acceptance.ts');
  const PRIVATE_FILE = join(SRC, 'core', 'private-file.ts');
  const HOME_INDEX = join(SRC, 'core', 'home-index.ts');

  const rel = (paths: readonly string[]): string[] => paths.map((path) => relative(SRC, path)).sort();
  const textOf = (path: string): string => stripComments(readFileSync(path, 'utf8'));
  const withText = (pattern: RegExp): string[] =>
    allSourceFiles(SRC).filter((path) => path !== NAMES_FILE && pattern.test(textOf(path)));
  const importPathsOf = (source: string): string[] =>
    [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');

  it('has the store file of the approval record in one module only: the owner record writer', () => {
    expect(rel(withText(/\bownerRecords\b/))).toEqual(['core/owner-record.ts']);
  });

  it('has the owner decision file and its names in one module only: the owner record writer', () => {
    expect(rel(withText(/\bownerDecisions\b/))).toEqual(['core/owner-record.ts']);
    expect(rel(withText(/\bfiles\.ownerDecisions\b/))).toEqual(['core/owner-record.ts']);
  });

  it('lets only the code of decide name the decision writer, and only decide call recordDecision', () => {
    const decide = 'commands/decide.ts';
    const callersOf = (pattern: RegExp, owners: readonly string[]): string[] =>
      rel(withText(pattern)).filter((path) => !owners.includes(path));
    expect(callersOf(/\bputDecision\b/, ['core/owner-record.ts', decide])).toEqual([]);
    // The definition in the local board and the type in the contract are no calls.
    expect(callersOf(/\brecordDecision\(/, ['board/local.ts', 'board/contract.ts', decide])).toEqual([]);
  });

  it('limits the key of the decisions folder to the state layout, the record path and the local board', () => {
    expect(rel(withText(/\bprofileDecisions\b/))).toEqual([
      'board/decision-record.ts',
      'board/local.ts',
      'state/layout.ts',
    ]);
    expect(rel(withText(/\bdirs\.decisions\b/))).toEqual(['state/layout.ts']);
  });

  it('reads the stage key in none of the decide sources', () => {
    const decideSources = [
      'commands/decide.ts',
      'board/decide.ts',
      'board/decision-record.ts',
      'core/owner-record.ts',
      'core/request-hash.ts',
      'board/local.ts',
    ];
    for (const path of decideSources) {
      const code = textOf(join(SRC, path));
      expect(code, path).not.toMatch(/\bstage\b/i);
      expect(code, path).not.toMatch(/\bboardKeys\b/);
    }
  });

  it('has the private file writer in the three modules that own a store, and in no other module', () => {
    expect(rel(withText(/\bchangePrivateFile\b/))).toEqual(
      rel([HOME_INDEX, OWNER_RECORD, SETUP_ACCEPTANCE, PRIVATE_FILE]),
    );
  });

  it('has one copy of the lock for the per-user files: the private file module', () => {
    const users = withText(/\blockSuffix\b|\blockAttempts\b|\blockStaleMs\b/);
    expect(rel(users)).toEqual(['core/private-file.ts']);
  });

  it('has one copy of the take-over of a stale lock: the file lock module, which the other locks call', () => {
    expect(rel(withText(/\bdropStaleLock\b|\bremoveSeenLock\b|\bdropStaleClaim\b/))).toEqual(['core/file-lock.ts']);
    expect(rel(withText(/\btakeLock\b/))).toEqual(['commands/lock.ts', 'core/file-lock.ts', 'core/private-file.ts', 'core/safe-write.ts']);
  });

  it('has no module that writes the approval record apart from the owner record writer', () => {
    const callersOf = (pattern: RegExp): string[] => rel(withText(pattern).filter((path) => path !== OWNER_RECORD));
    expect(callersOf(/\brecordScope\b/)).toEqual([]);
    // The code of init is the only caller of the delegation writer: it records the points that the owner sets.
    expect(callersOf(/\brecordDelegation\b/).filter((path) => !/^commands\/init[^/]*\.ts$/.test(path))).toEqual([]);
  });

  it('keeps the setup acceptance writer apart: it imports nothing of the approval store and names none of it', () => {
    const source = textOf(SETUP_ACCEPTANCE);
    expect(importPathsOf(source).filter((path) => /owner-record/.test(path))).toEqual([]);
    expect(source).not.toMatch(/\bownerRecords\b|\bfiles\.ownerRecords\b|\brecordDelegation\b|\brecordScope\b/);
  });

  it('keeps the owner record writer apart from the setup acceptance store, too', () => {
    const source = textOf(OWNER_RECORD);
    expect(importPathsOf(source).filter((path) => /setup-acceptance/.test(path))).toEqual([]);
    expect(source).not.toMatch(/\bsetupAcceptance\b|\bfiles\.setupAcceptances\b/);
  });

  it('has the setup acceptance store file in the setup acceptance writer only', () => {
    expect(rel(withText(/\bfiles\.setupAcceptances\b/))).toEqual(['core/setup-acceptance.ts']);
  });

  it('lets no module but the code of init pass the limits of init with yes to the setup acceptance writer', () => {
    const callers = withText(/\bfromInitYes\b/).filter((path) => path !== SETUP_ACCEPTANCE);
    expect(callers.filter((path) => !/commands\/init[^/]*\.ts$/.test(path))).toEqual([]);
  });

  it('gives both writers one guard: no factory session, and the terminal window', () => {
    for (const path of [OWNER_RECORD, SETUP_ACCEPTANCE]) {
      expect(textOf(path), relative(SRC, path)).toMatch(/\binFactorySession\(/);
      expect(textOf(path), relative(SRC, path)).toMatch(/\bstdinIsTTY\b/);
    }
  });
});

describe('the layers of the board source', () => {
  const BOARD_DIR = join(SRC, 'board');
  const LOWER_FOLDERS = ['state', 'core', 'workers'];

  /** The files that a source text imports from the board folder, from a file at `file`. */
  const boardImportsOf = (file: string, source: string): string[] =>
    importPathsOf(source)
      .filter((path) => path.startsWith('.'))
      .map((path) => resolve(dirname(file), path))
      .filter((target) => target === BOARD_DIR || target.startsWith(`${BOARD_DIR}${sep}`))
      .map((target) => relative(SRC, target));

  it('has a board folder with the files of the connector core, and scans it', () => {
    const scanned = allSourceFiles(BOARD_DIR).map((path) => relative(BOARD_DIR, path)).sort();
    expect(scanned).toEqual(expect.arrayContaining(['contract.ts', 'fields.ts', 'files.ts', 'stages.ts', 'tracks.ts']));
  });

  it('lets no file of src/state, src/core or src/workers import the board folder', () => {
    const found = LOWER_FOLDERS.flatMap((folder) => allSourceFiles(join(SRC, folder))).flatMap((path) =>
      boardImportsOf(path, readFileSync(path, 'utf8')).map((target) => `${relative(SRC, path)} imports ${target}`),
    );
    expect(found).toEqual([]);
  });

  it('finds each form of import of the board folder from a lower folder', () => {
    const file = join(SRC, 'state', 'sample.ts');
    const source = [
      "import { a } from '../board/local.js';",
      "export { b } from '../board/files';",
      "const c = await import('../board/stages.js');",
      "import '../board/tracks.js';",
      "import { d } from '../board/index.js';",
      "import { e } from './layout.js';",
      "import { f } from 'zod';",
    ].join('\n');
    expect(boardImportsOf(file, source)).toEqual([
      join('board', 'local.js'),
      join('board', 'files'),
      join('board', 'stages.js'),
      join('board', 'tracks.js'),
      join('board', 'index.js'),
    ]);
  });

  it('lets a board file import the work item port type of src/workers', () => {
    const file = join(BOARD_DIR, 'local.ts');
    expect(boardImportsOf(file, "import type { WorkItemPort } from '../workers/work-items.js';")).toEqual([]);
    expect(boardImportsOf(file, "import { a } from './files.js';")).toEqual([join('board', 'files.js')]);
  });

  it('parses JSON in the board folder with parseJsonText only', () => {
    const found = allSourceFiles(BOARD_DIR).filter((path) => /\bJSON\.parse\b/.test(stripComments(readFileSync(path, 'utf8'))));
    expect(found.map((path) => relative(SRC, path))).toEqual([]);
  });
});

describe('the work item port is a required parameter', () => {
  const COMMANDS = ['status.ts', 'dismiss.ts', 'worker-list.ts'].map((file) => join(SRC, 'commands', file));
  const codeOf = (path: string): string => stripComments(readFileSync(path, 'utf8'));

  it('holds no name of the unknown default in any source file', () => {
    const found = allSourceFiles(SRC).filter((path) => /\bunknownWorkItems\b/.test(codeOf(path)));
    expect(found.map((path) => relative(SRC, path))).toEqual([]);
  });

  it.each(COMMANDS)('gives the port parameter of %s no default', (path) => {
    expect(codeOf(path)).toMatch(/\bworkItems:\s*WorkItemPort\b/);
    expect(codeOf(path)).not.toMatch(/\bworkItems:\s*WorkItemPort\s*=/);
  });

  it('passes the port of the board at each call of status, dismiss and worker list', () => {
    const lastArguments = (file: string, name: string): (string | undefined)[] =>
      callsOf(readFileSync(join(SRC, file), 'utf8'), name).map((args) => args.at(-1)?.trim());
    expect(lastArguments('cli/table.ts', 'runStatus')).toEqual(['boardWorkItems(registry)']);
    expect(lastArguments('cli/table.ts', 'runDismiss')).toEqual(['boardWorkItems(registry)']);
    expect(lastArguments('commands/worker.ts', 'runWorkerList')).toEqual(['boardWorkItems(registry)']);
  });

  it('sets no flow-only mark in a command, and the port never reads the stage', () => {
    const files = allSourceFiles(join(SRC, 'commands')).concat(join(SRC, 'board', 'work-items.ts'));
    const found = files.flatMap((path) => literalsOf(readFileSync(path, 'utf8')).filter((literal) => /^(merged|released)$/i.test(literal)));
    expect(found).toEqual([]);
    expect(codeOf(join(SRC, 'board', 'work-items.ts'))).not.toMatch(/\bstage\b/i);
  });
});

describe('the caps that the change log and the pull request state', () => {
  it('holds the list of tracked files to 2,000 files', () => {
    expect(trackedFiles.maxCount).toBe(2000);
  });

  it('holds each file that factory reads to 1 MiB', () => {
    expect(maxFileBytes).toBe(1_048_576);
    expect(trackedFiles.maxFileBytes).toBe(1_048_576);
  });

  it('shows at most 16,384 bytes of one file and 262,144 bytes in all in the accept prompt', () => {
    expect(setupAcceptance.maxDisplayBytes).toBe(16_384);
    expect(setupAcceptance.maxDisplayTotalBytes).toBe(262_144);
  });
});

describe('the instruction files', () => {
  const textOf = (path: string): string => stripComments(readFileSync(path, 'utf8'));
  const withText = (pattern: RegExp): string[] =>
    allSourceFiles(SRC)
      .filter((path) => pattern.test(textOf(path)))
      .map((path) => relative(SRC, path))
      .sort();

  it('has one check id for them', () => {
    expect(checkIds.instructionFiles).toBe('instruction-files');
    expect(new Set(Object.values(checkIds)).size).toBe(Object.values(checkIds).length);
  });

  it('keeps every name of the list that can sit at the root in the reserved names, or starts it with a dot', () => {
    const reserved = reservedRootNames.map((name) => name.toLowerCase());
    for (const name of instructionFiles) {
      const first = name.split('/')[0] ?? '';
      expect({ name, kept: first.startsWith('.') || reserved.includes(first.toLowerCase()) }).toEqual({ name, kept: true });
    }
  });

  it('refuses the first part of each name of the list as the path of a project', () => {
    for (const name of instructionFiles) {
      const first = name.split('/')[0] ?? '';
      expect({ first, issue: projectPathIssue(first) }).not.toEqual({ first, issue: null });
    }
  });

  it('holds the list in names.ts: no other source file has the name of a listed file', () => {
    const others = ['CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md'].map((name) => `'${name}'`);
    for (const name of others) {
      expect({ name, files: withText(new RegExp(name.replace('.', '\\.'))).filter((path) => path !== 'names.ts') }).toEqual({
        name,
        files: [],
      });
    }
  });

  it('reads nothing under the user Claude folder: no source file takes the home of the user from the OS', () => {
    expect(withText(/\bhomedir\b|\buserInfo\b/)).toEqual([]);
  });

  it('keeps the readers from resolving links on the user Claude folder: root-content.ts, private-file.ts and git.ts call neither realPathOf nor isSameOrInsideFolder', () => {
    const readers = ['commands/root-content.ts', 'core/private-file.ts', 'core/git.ts'];
    expect(withText(/\brealPathOf\b|\bisSameOrInsideFolder\b/).filter((path) => readers.includes(path))).toEqual([]);
  });

  it('every use of the Claude folder name in src is on the allow list, and no template holds a user Claude path', () => {
    // dirs.claude is the only place of the folder name outside names.ts (see the test of the names above), so a path
    // below the user home and the Claude folder needs both words in one module. Another module with both is a new
    // reader of that folder, and this test makes a person look at it first.
    const joinsUserHome = ['core/instruction-files.ts', 'core/paths.ts', 'core/private-file.ts'];
    // These modules join the name with a folder that the command gives them: a session folder or a root. They never take
    // the home of the user, so the settings writer can not reach the user folder by a join.
    const joinsGivenFolder = ['commands/root-content.ts', 'core/claude-settings.ts', 'core/root-paths.ts'];
    const usesName = withText(/\bdirs\.claude\b/).filter((path) => path !== 'names.ts');
    expect(usesName).toEqual([...joinsGivenFolder, ...joinsUserHome].sort());
    expect(withText(/\benv\.userHome\b/).filter((path) => usesName.includes(path))).toEqual(joinsUserHome);
    expect(withText(/\buserHome\b/).filter((path) => joinsGivenFolder.includes(path))).toEqual([]);

    // A template can not name the folder: it has no value for it, and no text of a block or a file holds it.
    expect(Object.keys(templateValues)).not.toContain('claudeDir');
    expect(Object.values(templateValues)).not.toContain(dirs.claude);
    const texts = [...allBlocks.map((template) => template.body), ...Object.values(fileTemplates)];
    expect(texts.filter((text) => text.includes(dirs.claude))).toEqual([]);
  });
});

describe('the root checks', () => {
  const textOf = (path: string): string => stripComments(readFileSync(path, 'utf8'));
  const withText = (pattern: RegExp): string[] =>
    allSourceFiles(SRC)
      .filter((path) => pattern.test(textOf(path)))
      .map((path) => relative(SRC, path))
      .sort();

  it('has one check id for each root check, and no two ids are equal', () => {
    expect([checkIds.rootRepo, checkIds.rootFiles, checkIds.projectPaths, checkIds.permissionMode, checkIds.delegations]).toEqual([
      'root-repo',
      'root-files',
      'project-paths',
      'permission-mode',
      'delegations',
    ]);
    expect(new Set(Object.values(checkIds)).size).toBe(Object.values(checkIds).length);
  });

  it('holds the permission-skip list in names.ts: four items with their own labels, and the first is the bypass mode', () => {
    expect(permissionSkipList).toHaveLength(4);
    expect(new Set(permissionSkipList.map((item) => item.label)).size).toBe(permissionSkipList.length);
    expect(permissionSkipList[0]).toMatchObject({ kind: 'setting', path: ['permissions', 'defaultMode'], value: 'bypassPermissions' });
  });

  it('keeps the words of the skip list in names.ts: no other source file holds one', () => {
    const words = /bypassPermissions|dangerously-skip-permissions|skipDangerousModePermissionPrompt|dangerouslySkipPermissions/;
    expect(withText(words).filter((path) => path !== 'names.ts')).toEqual([]);
  });

  it('keeps the names of the settings that approve project MCP servers in names.ts', () => {
    expect(withText(/enableAllProjectMcpServers|enabledMcpjsonServers/).filter((path) => path !== 'names.ts')).toEqual([]);
  });
});

describe('the agent program', () => {
  const sources = allSourceFiles(SRC).map((path) => ({ file: relative(SRC, path), code: stripComments(readFileSync(path, 'utf8')) }));
  const withText = (pattern: RegExp): string[] => sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
  const callsIn = (names: readonly string[]): { readonly file: string; readonly args: readonly string[] }[] =>
    sources.flatMap(({ file, code }) => names.flatMap((name) => callsOf(code, name)).map((args) => ({ file, args })));

  it('starts a process in one module only: core/node-deps.ts', () => {
    expect(withText(/\bchild_process\b/)).toEqual(['core/node-deps.ts']);
  });

  it('holds the name of the agent program in no call that runs a program', () => {
    const agentName = /\btoolNames\.claude\b|\bvalues\.agent\b|['"`]claude['"`]/;
    const runs = callsIn(['run', 'runAttached', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
    expect(runs.filter(({ args }) => args.some((arg) => agentName.test(arg))).map(({ file }) => file)).toEqual([]);
  });

  it('uses the tool name of the agent program only to look for it on PATH and to name it in a message', () => {
    expect(withText(/\btoolNames\.claude\b/)).toEqual(['commands/doctor.ts', 'commands/launch-checks.ts', 'commands/start.ts']);
  });

  it('builds the program of a start from the agent input in launch/argv.ts, and from no name of a tool', () => {
    const argv = sources.find(({ file }) => file === 'launch/argv.ts')?.code ?? '';
    expect(argv).toMatch(/\binput\.agent\b/);
    expect(argv).not.toMatch(/\btoolNames\b|['"`]claude['"`]/);
  });

  it('gives every start the agent of the config: each call of a launch argument builder passes session.agent', () => {
    const calls = callsIn(['launchArgv', 'workerLaunchArgv']);
    expect(calls.length).toBeGreaterThan(0);
    for (const { file, args } of calls) {
      expect({ file, passesAgent: /\bagent:\s*[\w.]*\bsession\.agent\b/.test(args.join(' ')) }).toEqual({ file, passesAgent: true });
    }
  });
});

describe('the names of the sessions', () => {
  const valueOf = (result: ReturnType<typeof sessionNames.coordinator>): string | null => (result.ok ? result.value : null);

  it('names the session of the coordinator with the id of the node', () => {
    expect(sessionNames.coordinator('demo')).toEqual({ ok: true, value: 'demo' });
  });

  it('names the session of a worker with the id of the node, an underscore and the id of the worker', () => {
    expect(sessionNames.worker('demo', 'alpha')).toEqual({ ok: true, value: 'demo_alpha' });
  });

  it('gives a name that is one word for a flag: no space, no control character, no leading hyphen', () => {
    const longest = 'a'.repeat(40);
    for (const name of [valueOf(sessionNames.coordinator(longest)), valueOf(sessionNames.worker(longest, longest))]) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
  });

  // Ids may hold a hyphen. With a hyphen between the two ids, these pairs gave the same name on one machine.
  it.each([
    ['a worker of one node and the coordinator of another', valueOf(sessionNames.worker('web', 'api')), valueOf(sessionNames.coordinator('web-api'))],
    ['the workers of two nodes', valueOf(sessionNames.worker('a', 'b-c')), valueOf(sessionNames.worker('a-b', 'c'))],
  ])('gives different names to %s', (_, first, second) => {
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it('gives a worker name that holds no separator of a tmux target, so the name works as a part of a target', () => {
    const name = valueOf(sessionNames.worker('web-shop', 'api-2'));
    expect(name).not.toBeNull();
    expect(name).not.toMatch(/[:.]/);
  });

  const NOT_SLUGS = ['', 'Demo', 'a b', '-demo', '../demo', 'demo\n--x', '--dangerously-skip-permissions', '__proto__', 'a'.repeat(41)];

  it.each(NOT_SLUGS)('refuses the node id %j for the coordinator, and does not throw', (id) => {
    const result = sessionNames.coordinator(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a slug');
  });

  it.each(NOT_SLUGS)('refuses %j as the node id and as the worker id of a worker, and does not throw', (id) => {
    expect(sessionNames.worker(id, 'alpha').ok).toBe(false);
    expect(sessionNames.worker('demo', id).ok).toBe(false);
  });

  it('does not repeat a refused id in the error', () => {
    for (const result of [sessionNames.coordinator('Secret/Id'), sessionNames.worker('demo', 'Secret/Id'), sessionNames.worker('Secret/Id', 'alpha')]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toMatch(/secret/i);
    }
  });
});

describe('the heavy lock policy and the lock words', () => {
  it('waits 5 s between 1,080 tries, so a priority file counts for 90 minutes at most', () => {
    expect(heavyLock).toMatchObject({ waitMs: 5_000, attempts: 1_080, priorityMaxAgeMs: 5_400_000, mode: 0o600, maxPriorityBytes: 256 });
    expect(heavyLock.priorityMaxAgeMs).toBe(heavyLock.waitMs * heavyLock.attempts);
  });

  it('holds the child for 3 hours at most, and gives TERM 10 s before KILL, longer than the group stop of other runs', () => {
    expect(heavyLock).toMatchObject({ maxHoldMs: 10_800_000, killGraceMs: 10_000, startToleranceMs: 3_000, claimStaleMs: 60_000 });
  });

  it('starts every line with the command and the fixed word, and has no word twice', () => {
    const words = Object.values(lockWords);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(lockLine(word, 'x')).toBe(`factory lock run: ${word}. x`);
  });

  it('gives the worker text the lock command and the priority flag', () => {
    expect(templateValues['lockRunCommand']).toBe('factory lock run');
    expect(templateValues['lockPriorityFlag']).toBe('--priority');
  });
});

describe('the names of node send', () => {
  const parts = { senderId: 'parent', senderAddress: 'file:///work/parent', targetId: 'child' };

  it('adds the send subcommand, the file flag, a command line for remedies and a schema id', () => {
    expect(nodeCommands.send).toBe('send');
    expect(flags.file).toBe('file');
    expect(commandLines.nodeSend).toBe(`${commands.node} ${nodeCommands.send}`);
    expect(schemaIds.nodeSend).toBe(`${program}.node-send/v1`);
  });

  it('writes the header in this order: sender id, sender address, target id, then the note of no owner authority', () => {
    const lines = messageHeaderLines(parts);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`${messageHeader.senderId}parent`);
    expect(lines[1]).toBe(`${messageHeader.senderAddress}file:///work/parent`);
    expect(lines[2]).toBe(`${messageHeader.targetId}child`);
    expect(lines[3]).toBe(messageHeader.notice);
  });

  it('puts the node word and the owner word of the roles in the header, and the same note in each header', () => {
    expect(messageHeader.senderId).toContain(roles.node);
    expect(messageHeader.targetId).toContain(roles.node);
    expect(messageHeader.notice).toContain(roles.owner);
    expect(messageHeaderLines({ ...parts, targetId: 'other' })[3]).toBe(messageHeaderLines(parts)[3]);
  });

  it('caps the inbox of a child at 100 files and 8 MiB', () => {
    expect(nodeInbox).toEqual({ maxFiles: 100, maxBytes: 8 * 1_048_576 });
  });

  it('names the parts of a message file: a separator, a suffix and a count of random bytes', () => {
    expect(messageFile.separator).toMatch(/^[a-z0-9-]$/);
    expect(messageFile.suffix).toMatch(/^\.[a-z]+$/);
    expect(messageFile.randomBytes).toBeGreaterThanOrEqual(4);
  });

  it('has a fixed reason for each failure, with no placeholder and no line break', () => {
    const reasons = Object.values(nodeSendReasons);
    expect(Object.keys(nodeSendReasons).sort()).toEqual(
      ['controlChars', 'full', 'io', 'mismatch', 'notAnswering', 'notChild', 'notIgnored', 'removeFailed', 'token', 'unsafe'].sort(),
    );
    for (const reason of reasons) {
      expect(reason.trim()).toBe(reason);
      expect(reason).not.toBe('');
      expect(reason).not.toMatch(/[\r\n{}]/);
    }
    expect(duplicatesOf(reasons)).toEqual([]);
  });

  it('gives the send command and the inbox folder to the template texts, from the factory folder and from the coordinator folder', () => {
    expect(templateValues['nodeSendCommand']).toBe(`${program} ${commands.node} ${nodeCommands.send} <id> --${flags.file} FILE`);
    expect(templateValues['nodeInboxDir']).toBe(`${dirs.state}/${dirs.inbox}/`);
    expect(coordinatorTemplateValues['nodeInboxDir']).toBe(`../${dirs.state}/${dirs.inbox}/`);
    expect(coordinatorTemplateValues['nodeSendCommand']).toBe(templateValues['nodeSendCommand']);
  });

  it('gives the note of the header to the template texts, so that no text outside names.ts holds the word of the note', () => {
    expect(templateValues['inboxNotice']).toBe(messageHeader.notice);
    expect(coordinatorTemplateValues['inboxNotice']).toBe(messageHeader.notice);
  });
});

describe('the names of the board records', () => {
  it('gives the record, unassign and log commands a name for the remedy lines', () => {
    expect(commandLines.itemRecord).toBe(`${commands.item} ${itemCommands.record}`);
    expect(commandLines.itemUnassign).toBe(`${commands.item} ${itemCommands.unassign}`);
    expect(commandLines.requestLog).toBe(`${commands.request} ${requestCommands.log}`);
  });

  it('adds the log subcommand of request after the three older ones', () => {
    expect(Object.values(requestCommands)).toEqual(['add', 'list', 'close', 'log']);
  });

  it('adds the record and unassign subcommands of item after the five older ones', () => {
    expect(Object.values(itemCommands)).toEqual(['add', 'update', 'move', 'close', 'list', 'record', 'unassign']);
  });

  it('names the flags of the record and of the relayed close', () => {
    expect(flags.ref).toBe('ref');
    expect(flags.relayed).toBe('relayed');
  });

  it('reserves the two item keys, so that no owner field can take their name', () => {
    expect(boardKeys.mergedPrHead).toBe('merged_pr_head');
    expect(boardKeys.unassignedFrom).toBe('unassigned_from');
    expect(reservedFieldNames).toContain(boardKeys.mergedPrHead);
    expect(reservedFieldNames).toContain(boardKeys.unassignedFrom);
    expect(duplicatesOf(reservedFieldNames)).toEqual([]);
  });

  it('keeps the key and the fixed marker of a relayed close apart from the owner proof keys', () => {
    expect(decisionLogKeys.relayed).toBe('relayed');
    expect(decisionLogKeys.relayed).not.toBe(decisionLogKeys.by);
    expect(relayedMarker).toBe('owner answer, relayed by the coordinator, no owner proof');
  });

  it('caps the list of former workers of an item at 30', () => {
    expect(markLimits.maxFormerWorkers).toBe(30);
  });

  it('gives the gh time limit that init and the record check of the software recipe share', () => {
    expect(ghTimeoutMs).toBe(10_000);
  });
});

describe('the names of the board data for an outside review page', () => {
  it('names the flag of the epic of an item and the flag of the release group of a queue row', () => {
    expect(flags.epic).toBe('epic');
    expect(flags.releaseGroup).toBe('release-group');
  });

  it('names the keys of the epic, of the stage copy and of the release group', () => {
    expect(boardKeys.epic).toBe('epic');
    expect(boardKeys.stages).toBe('stages');
    expect(boardKeys.releaseGroup).toBe('release_group');
  });

  it('leaves the names release and kind free for an owner field', () => {
    expect(reservedFieldNames).not.toContain('release');
    expect(reservedFieldNames).not.toContain('kind');
  });

  it('caps an epic and a release group at 60 characters and the docs of one item at 10', () => {
    expect(boardTextLimits.maxEpicChars).toBe(60);
    expect(boardTextLimits.maxReleaseGroupChars).toBe(60);
    expect(boardTextLimits.maxItemDocs).toBe(10);
  });

  it('gives the grouped queue view a word for the heading of a group and a word for the rows with no group', () => {
    expect(queueWords.groupHeading).toBe('group');
    expect(queueWords.ungroupedHeading).toBe('no group');
  });
});

describe('the lessons file of the coordinator', () => {
  it('has one name for the file, in the state folder, and the coordinator texts write its path from their folder', () => {
    expect(files.lessons).toBe('lessons.md');
    expect(templateValues['lessonsFile']).toBe(`${dirs.state}/${files.lessons}`);
    expect(coordinatorTemplateValues['lessonsFile']).toBe(`../${dirs.state}/${files.lessons}`);
  });

  it('gives the file a name that no other file of the state folder has', () => {
    expect(Object.values(files).filter((name) => name === files.lessons)).toHaveLength(1);
  });

  it('holds at most 40 entries, and the texts get that number as a value', () => {
    expect(lessonLimits.maxEntries).toBe(40);
    expect(templateValues['maxLessons']).toBe('40');
    expect(coordinatorTemplateValues['maxLessons']).toBe('40');
  });

  it('holds at most 32768 bytes, and the texts get that number as a value', () => {
    expect(lessonLimits.maxBytes).toBe(32_768);
    expect(templateValues['maxLessonBytes']).toBe('32768');
    expect(coordinatorTemplateValues['maxLessonBytes']).toBe('32768');
  });
});

describe('the typed lines of a reset', () => {
  it('keeps the two typed lines as two constant lines', () => {
    expect(typing.lines).toEqual({ clear: '/clear', compact: '/compact' });
  });

  it('holds no typed line in any block, so a block has no hint for a compact', () => {
    for (const template of allBlocks) {
      for (const line of Object.values(typing.lines)) expect(template.body, `${template.name} ${line}`).not.toContain(line);
    }
  });
});

describe('the names of the data for a view outside the core', () => {
  it('names the key of the time of the last stage change, and reserves it so that no owner field can take its name', () => {
    expect(boardKeys.stageAt).toBe('stage_at');
    expect(reservedFieldNames).toContain(boardKeys.stageAt);
    expect(duplicatesOf(reservedFieldNames)).toEqual([]);
  });

  it('names the open time and the group of a request, the two groups, and the flag of the later group', () => {
    expect(decisionKeys.openedAt).toBe('opened_at');
    expect(decisionKeys.group).toBe('group');
    expect(Object.values(requestGroups)).toEqual(['now', 'later']);
    expect(flags.later).toBe(requestGroups.later);
  });

  it('fixes the keys of a worker row and of the display data of its work item', () => {
    expect(Object.values(workerRowKeys)).toEqual([
      'itemId',
      'itemTitle',
      'itemStatus',
      'stage',
      'stageAt',
      'parkedCount',
      'paneLive',
      'sessionState',
      'activityAt',
      'stalled',
    ]);
    expect(Object.values(workItemDisplayKeys)).toEqual(['title', 'stage', 'stageAt', 'status']);
    expect(duplicatesOf(Object.values(workerRowKeys))).toEqual([]);
  });

  it('fixes the keys of a request row, the key of the power reading and its sources', () => {
    expect(Object.values(requestRowKeys)).toEqual(['openedAt', 'group']);
    expect(Object.values(powerKeys)).toEqual(['power', 'source', 'percent']);
    expect(Object.values(powerSources)).toEqual(['ac', 'battery', 'unknown']);
  });

  it('names the programs, the files, the words and the bounds of the power reading of the machine check', () => {
    expect(machineNames.programs.pmset).toBe('pmset');
    expect(machineNames.pmsetArgs).toEqual(['-g', 'batt']);
    expect(machineNames.powerSupplyDir).toBe('/sys/class/power_supply');
    expect(Object.values(machineNames.supplyFiles)).toEqual(['type', 'scope', 'online', 'status', 'capacity']);
    expect(Object.values(machineNames.supplyWords)).toEqual(['Mains', 'USB', 'Battery', 'System', 'Discharging']);
    expect(machineNames.maxPowerSupplies).toBe(16);
    expect(machineNames.maxPowerFileBytes).toBe(64);
    expect(machineNames.maxPowerOutputChars).toBe(4_096);
  });
});

describe('the names of the role text delivery', () => {
  it('names the three keys of the one output object that the hook prints', () => {
    expect(hookNames.output).toEqual({
      hookSpecificOutput: 'hookSpecificOutput',
      hookEventName: 'hookEventName',
      additionalContext: 'additionalContext',
    });
  });

  it('names the setting that turns off every hook, the check id and the block name', () => {
    expect(claudeSettingKeys.disableAllHooks).toBe('disableAllHooks');
    expect(checkIds.roleDelivery).toBe('role-delivery');
    expect(blockNames.workRules).toBe('work-rules');
    expect(new Set(Object.values(blockNames)).size).toBe(Object.values(blockNames).length);
  });

  it('caps the delivered text at 9,000 characters and keeps the setup bound at 65,536 bytes', () => {
    expect(roleText.maxChars).toBe(9_000);
    expect(maxSetupTextBytes).toBe(65_536);
  });

  it('has one fixed refusal text', () => {
    expect(roleText.refusal).toBe('The factory role text did not arrive. Do no work. Tell the coordinator.');
  });

  it('has a source line of one line that names the package rules and the accepted setup file', () => {
    expect(roleText.sourceLine).not.toMatch(/[\r\n]/);
    expect(roleText.sourceLine).toContain('rules of the factory package');
    expect(roleText.sourceLine).toContain('setup/roles/worker.md');
  });

  it('has one fixed reason of one line for each of the nine faults and for the input of the hook, and no two are the same', () => {
    const reasons = Object.values(roleText.reasons);
    expect(Object.keys(roleText.reasons).sort()).toEqual(
      [
        'blockMarker',
        'configNotUsable',
        'inputNotUsable',
        'link',
        'notAccepted',
        'notPlainText',
        'notUtf8',
        'ownerOrMode',
        'readFailed',
        'tooLarge',
      ].sort(),
    );
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason).toMatch(/^[^\r\n]+$/);
  });

  it('keeps the old words and the jargon words out of its texts', () => {
    const texts = [roleText.sourceLine, roleText.refusal, ...Object.values(roleText.reasons)];
    expect(texts.flatMap(plainWordsIn)).toEqual([]);
  });

  it('names the size and the cap of a text that is too large, in the unit of the size', () => {
    expect(roleText.tooLargeText(12_345, 'bytes')).toBe('the role text has 12345 bytes, and the cap is 9000 characters');
    expect(roleText.tooLargeText(9_001, 'characters')).toBe('the role text has 9001 characters, and the cap is 9000 characters');
  });
});
