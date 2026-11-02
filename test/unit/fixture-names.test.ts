import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The names that a user folder path in a test file may use. They are neutral: no person owns them. A new fixture uses one of
 * them, or this list grows by a neutral name on purpose.
 */
const NEUTRAL_NAMES: readonly string[] = ['example', 'example2', 'me', 'other', 'owner', 'someone', 'first', 'second'];

/** The limits of the walk over the test folder. A walk that reaches a limit fails the test. */
const MAX_DEPTH = 8;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_000_000;

const TEST_DIR = join(__dirname, '..');

/**
 * A user folder path that starts at the root of a path: `/Users/<name>`, `/users/<name>` or `/home/<name>`. A folder with
 * the same name inside a longer path (`src/Users/list.ts`, `/w/fresh/home/other.txt`) is not a user folder.
 */
const USER_FOLDER = /(?<![\w.~$}-])\/(?:users|home)\/([A-Za-z0-9_.-]+)/gi;

/** The names in the user folder paths of a text, in lower case, without a dot or a dash at the end. */
const userFolderNames = (text: string): string[] =>
  [...text.matchAll(USER_FOLDER)].map((match) => (match[1] ?? '').replace(/[.-]+$/, '').toLowerCase());

/** The names in the user folder paths of a text that are not on the neutral list. */
const foreignNames = (text: string): string[] => userFolderNames(text).filter((name) => !NEUTRAL_NAMES.includes(name));

interface TestFiles {
  readonly paths: readonly string[];
  /** False when the walk stopped at a limit and did not read every file. */
  readonly complete: boolean;
}

const listTestFiles = (root: string): TestFiles => {
  const paths: string[] = [];
  let complete = true;
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) complete = false;
        else visit(full, depth + 1);
      } else if (entry.isFile()) {
        if (paths.length >= MAX_FILES || statSync(full).size > MAX_FILE_BYTES) complete = false;
        else paths.push(full);
      }
    }
  };
  visit(root, 0);
  return { paths, complete };
};

/** A user folder path built from parts, so that this file holds no such path of its own. */
const userPath = (root: string, name: string): string => `/${root}/${name}`;

describe('the user names in the test files', () => {
  it('uses only a neutral name in the user folder paths of the files under test/', () => {
    const files = listTestFiles(TEST_DIR);
    expect(files.complete, 'the walk reached a limit of depth, file count or file size').toBe(true);
    expect(files.paths.length, 'the walk found no file').toBeGreaterThan(0);
    const foreign = files.paths.flatMap((path) =>
      foreignNames(readFileSync(path, 'utf8')).map((name) => `${relative(TEST_DIR, path)}: "${name}"`),
    );
    expect(foreign, `use a name from the neutral list: ${NEUTRAL_NAMES.join(', ')}`).toEqual([]);
  });

  it('reads the fixtures folder and the helpers, not only the unit tests', () => {
    const names = listTestFiles(TEST_DIR).paths.map((path) => relative(TEST_DIR, path));
    expect(names.some((name) => name.startsWith('fixtures/'))).toBe(true);
    expect(names.some((name) => name.startsWith('helpers/'))).toBe(true);
    expect(names.some((name) => name.startsWith('unit/'))).toBe(true);
  });

  it.each(['Users', 'users', 'home'])('finds a name outside the neutral list in a /%s/ path', (root) => {
    expect(foreignNames(`HOME=${userPath(root, 'jordan')}`)).toEqual(['jordan']);
  });

  it('finds the name in any letter case, and in a file address', () => {
    expect(foreignNames(userPath('USERS', 'Jordan'))).toEqual(['jordan']);
    expect(foreignNames(`file://${userPath('Users', 'jordan')}`)).toEqual(['jordan']);
  });

  it('finds the name at the end of a quoted path and at the end of a sentence', () => {
    expect(foreignNames(`HOME: '${userPath('users', 'jordan')}'`)).toEqual(['jordan']);
    expect(foreignNames(`The folder is ${userPath('home', 'jordan')}.`)).toEqual(['jordan']);
    expect(foreignNames(`${userPath('Users', 'jordan')}/work`)).toEqual(['jordan']);
  });

  it('finds each foreign name when a text holds several paths', () => {
    const text = `${userPath('home', 'me')} ${userPath('home', 'jordan')} ${userPath('Users', 'sam')}`;
    expect(foreignNames(text)).toEqual(['jordan', 'sam']);
  });

  it.each(NEUTRAL_NAMES)('accepts the neutral name "%s", also with a capital letter', (name) => {
    const capital = `${name[0]?.toUpperCase()}${name.slice(1)}`;
    expect(foreignNames(userPath('Users', name))).toEqual([]);
    expect(foreignNames(userPath('home', capital))).toEqual([]);
  });

  it('does not read a folder named users or home inside a longer path', () => {
    expect(foreignNames('/w/fresh/home/other.txt')).toEqual([]);
    expect(foreignNames('A relative path is src/Users/list.ts.')).toEqual([]);
    expect(foreignNames('The rule bans `/Users/` in a template.')).toEqual([]);
  });
});
