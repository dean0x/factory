import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkIds } from '../../src/names.js';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-intent-docs.sh');
const DOC_FILES = ['design.md', 'intent-trace.md', 'roadmap-v2.md', 'token-budget.md', 'glossary.md'];

/** The files above the docs folder that check 8 also reads. */
const TOP_FILES = ['README.md', 'CHANGELOG.md'];

let base: string;
let copy: string;

/** A copy of the docs that the check reads, in a folder of its own, with the README and the CHANGELOG above it. */
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'factory-docs-'));
  copy = join(base, 'docs');
  await mkdir(copy);
  for (const name of DOC_FILES) await cp(join(ROOT, 'docs', name), join(copy, name));
  await cp(join(ROOT, 'docs', 'research'), join(copy, 'research'), { recursive: true });
  for (const name of TOP_FILES) await cp(join(ROOT, name), join(base, name));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const check = (dir: string = copy, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync('sh', [SCRIPT, dir], { encoding: 'utf8', env });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

/** Changes one file of the copy. The change must alter the text, so a change of the docs fails the test loudly. */
const change = async (name: string, edit: (text: string) => string, folder: string = copy): Promise<void> => {
  const path = join(folder, name);
  const before = await readFile(path, 'utf8');
  const after = edit(before);
  expect(after).not.toBe(before);
  await writeFile(path, after);
};

/** The checks that failed, by number. */
const failedChecks = (out: string): string[] => [...out.matchAll(/^FAIL (\d+)/gm)].map((match) => match[1] ?? '');

describe('scripts/check-intent-docs.sh', () => {
  it('passes on the docs of the repo', () => {
    const result = check(join(ROOT, 'docs'));
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
    expect(result.out).toContain('all 10 checks passed');
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('runs in the exit check and has an npm script', async () => {
    expect(await readFile(join(ROOT, 'scripts', 'exit-check.sh'), 'utf8')).toContain('check-intent-docs.sh');
    const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['check:docs']).toBe('sh scripts/check-intent-docs.sh');
  });

  it('passes on the copy that the other tests change', () => {
    expect(check().code).toBe(0);
  });

  it('exits 1 for a section of the trace that is not a heading of the design, and names it', async () => {
    await change('intent-trace.md', (text) => text.replace('§4.2', '§99.9'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['1']);
    expect(result.out).toMatch(/intent-trace\.md line \d+: section 99\.9 is not a heading of design\.md/);
  });

  it('names only the first failure of a check', async () => {
    await change('intent-trace.md', (text) => `${text}\nSee §97.1 and §98.1.\n`);
    const result = check();
    expect(result.out).toContain('section 97.1');
    expect(result.out).not.toContain('98.1');
  });

  it('exits 1 for a milestone of the trace that the roadmap does not name', async () => {
    await change('intent-trace.md', (text) => `${text}\nSee FAC-M99.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain('FAC-M99 is not named in roadmap-v2.md');
  });

  it('exits 1 for a milestone of the roadmap with no heading', async () => {
    await change('roadmap-v2.md', (text) => text.replace('### FAC-M5:', '### Milestone M5:'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain('no heading for FAC-M5');
  });

  it('does not take the heading of FAC-M5b for the heading of FAC-M5', async () => {
    await change('roadmap-v2.md', (text) => text.replace('### FAC-M5:', '### Milestone M5:'));
    expect(check().out).toContain('roadmap-v2.md has no heading for FAC-M5\n');
  });

  it('exits 1 for a milestone with a letter that the trace names and the roadmap has no heading for', async () => {
    await change('roadmap-v2.md', (text) => text.replace('### FAC-M5b:', '### Milestone M5b:'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain('roadmap-v2.md has no heading for FAC-M5b');
  });

  it('exits 1 for a command of design 4.2 with no row in the Command map', async () => {
    await change('roadmap-v2.md', (text) => text.replace(/^\| `item`, `request`.*\n/m, ''));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toContain('the command request of design.md 4.2 has no row in the Command map');
  });

  it('reads the commands of the table of software recipe commands too', async () => {
    await change('roadmap-v2.md', (text) => text.replace(/^\| `check`.*\n/m, ''));
    const result = check();
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toContain('the command check of design.md 4.2 has no row in the Command map');
  });

  it('exits 1 for a desk row in design 4.2', async () => {
    await change('design.md', (text) => text.replace(/^(factory help words.*)$/m, '$1\nfactory desk render   # a review desk'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toMatch(/design\.md 4\.2 has a desk row \(line \d+\)/);
  });

  it('exits 1 for a desk row in the Command map', async () => {
    await change('roadmap-v2.md', (text) => text.replace('| `adopt` | FAC-M7 |', '| `adopt` | FAC-M7 |\n| `desk` | not built |'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toContain('the Command map of roadmap-v2.md has a desk row');
  });

  it('exits 1 for a table in design 7.1 that does not have 11 rows', async () => {
    await change('design.md', (text) => text.replace(/^\| 1 \| assembly line .*\n/m, ''));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['4']);
    expect(result.out).toContain('design.md 7.1 has 10 table rows, expected 11');
  });

  it('exits 1 for a Status in the parity table that is not planned, done or retired', async () => {
    await change('design.md', (text) => text.replace('| planned |', '| started |'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['5']);
    expect(result.out).toMatch(/design\.md line \d+: the Status "started" is not planned, done or retired/);
  });

  it('exits 1 for a token budget with 16 rows', async () => {
    await change('token-budget.md', (text) => text.replace(/^\| 17 \| .*\n/m, ''));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['6']);
    expect(result.out).toContain('token-budget.md has 16 job rows, expected 17');
  });

  it('exits 1 for a file under docs/research that holds the word lane, also in a sub-folder', async () => {
    await mkdir(join(copy, 'research', 'notes'), { recursive: true });
    await writeFile(join(copy, 'research', 'notes', 'extra.md'), 'First line.\nA Lane of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7']);
    expect(result.out).toContain(`${join(copy, 'research', 'notes', 'extra.md')}:2 holds the word lane`);
  });

  it('exits 1 for the plural lanes under docs/research', async () => {
    await writeFile(join(copy, 'research', 'extra.md'), 'Two lanes of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7']);
    expect(result.out).toContain(`${join(copy, 'research', 'extra.md')}:1 holds the word lane`);
  });

  it('accepts a word that only contains lane', async () => {
    await writeFile(join(copy, 'research', 'extra.md'), 'The plane has a laneway and a Planet.\n');
    expect(check().code).toBe(0);
  });

  it('exits 1 and names a file that is missing', async () => {
    await rm(join(copy, 'token-budget.md'));
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`the file ${join(copy, 'token-budget.md')} is missing`);
  });

  it('exits 1 and names a glossary that is missing, because check 10 reads it', async () => {
    await rm(join(copy, 'glossary.md'));
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`the file ${join(copy, 'glossary.md')} is missing`);
  });
});

/** A process that runs as root can read a file with mode 000, so the tests of an unreadable file do not apply to it. */
const isRoot = process.getuid?.() === 0;

describe.skipIf(isRoot)('scripts/check-intent-docs.sh, a file or a folder that cannot be read', () => {
  it.each(DOC_FILES)('exits 1 for the doc %s that cannot be read, and names it', async (name) => {
    const path = join(copy, name);
    await chmod(path, 0o000);
    const result = check();
    expect(result.code).toBe(1);
    expect(result.out).toContain(`the file ${path} cannot be read`);
    expect(result.out).not.toContain('all 10 checks passed');
  });

  it('fails check 7 and check 8 for a file under docs/research that cannot be read, and never prints its content', async () => {
    const path = join(copy, 'research', 'closed.md');
    await writeFile(path, 'See /Users/someone/work and the lane.\n');
    await chmod(path, 0o000);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7', '8']);
    expect(result.out).toContain(`the file ${path} cannot be read`);
    expect(result.out).not.toContain('someone');
  });

  it('fails check 8 for a README that cannot be read', async () => {
    const path = join(base, 'README.md');
    await chmod(path, 0o000);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toContain(`the file ${copy}/../README.md cannot be read`);
  });

  it('fails check 8 for a sub-folder of the docs that cannot be read', async () => {
    const folder = join(copy, 'research', 'closed');
    await mkdir(folder);
    await writeFile(join(folder, 'extra.md'), 'See /Users/someone/work.\n');
    await chmod(folder, 0o000);
    try {
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toContain('8');
      expect(result.out).toContain(`the folder ${folder} cannot be read`);
    } finally {
      await chmod(folder, 0o755);
    }
  });
});

describe('scripts/check-intent-docs.sh, an awk that stops with an error', () => {
  it('fails every check, so a check that did not run never shows as ok', async () => {
    const bin = join(base, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'awk'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    const result = check(copy, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(result.out).toContain('the check did not run');
    expect(result.out).not.toContain('all 10 checks passed');
  });
});

/** Synthetic local paths. The only name that check 8 accepts is `example`, so these use another name. */
const LOCAL_PATHS: ReadonlyArray<{ kind: string; text: string }> = [
  { kind: 'a user folder path', text: 'The work is in /Users/other/work/acme.' },
  { kind: 'a user folder path', text: 'The rule bans `/Users/` in a template.' },
  { kind: 'a home path with a name', text: '"address": "file:///home/other/work/acme"' },
  { kind: 'a private path', text: 'The files are in /private/tmp/work.' },
  { kind: 'a temp Claude path', text: 'The scratch folder is /tmp/claude-501/scratch.' },
];

/** Where check 8 reads: the docs folder, a sub-folder of it, and the two files above it. */
const PLACES: ReadonlyArray<{ place: string; folder: () => string; name: string }> = [
  { place: 'a doc', folder: () => copy, name: 'design.md' },
  { place: 'a doc in a sub-folder', folder: () => join(copy, 'research'), name: 'extra.md' },
  { place: 'the README', folder: () => base, name: 'README.md' },
  { place: 'the CHANGELOG', folder: () => base, name: 'CHANGELOG.md' },
];

describe('scripts/check-intent-docs.sh, check 8: no local machine paths', () => {
  describe.each(PLACES)('in $place', ({ folder, name }) => {
    const put = async (text: string): Promise<void> => {
      await mkdir(folder(), { recursive: true });
      const path = join(folder(), name);
      const before = await readFile(path, 'utf8').catch(() => '');
      await writeFile(path, `${before}\n${text}\n`);
    };

    it.each(LOCAL_PATHS)('exits 1 for $kind', async ({ kind, text }) => {
      await put(text);
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['8']);
      expect(result.out).toMatch(new RegExp(`${name}:\\d+ holds ${kind}`));
    });

    it('accepts the neutral name, a home form, a relative path and a path that is not local', async () => {
      await put(
        [
          'The neutral names are /Users/example/work and file:///home/example/work/acme.',
          'A home form is ~/work/acme or ~/.claude/projects.',
          'A relative path is docs/private/notes.md or src/Users/list.ts.',
          'A tool path is /opt/homebrew/bin and a name is /home-made.',
        ].join('\n'),
      );
      expect(check().code).toBe(0);
    });
  });

  it('exits 1 for a name that only starts with the neutral name', async () => {
    await change('design.md', (text) => `${text}\nSee /Users/example2/work.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
  });

  it('names the file and the line, and never the path', async () => {
    await change('design.md', (text) => `${text}\nSee /Users/someone/work.\n`);
    const result = check();
    expect(result.out).toMatch(/design\.md:\d+ holds a user folder path/);
    expect(result.out).not.toContain('someone');
  });

  it('names only the first failure of the check', async () => {
    await change('design.md', (text) => `${text}\nSee /Users/first/work and /Users/second/work.\n`);
    await change('README.md', (text) => `${text}\nSee /private/tmp/third.\n`, base);
    const result = check();
    expect(result.out).toContain('design.md:');
    expect(result.out).not.toContain('README.md:');
    expect(result.out).not.toContain('a private path');
  });

  it('passes when the README and the CHANGELOG are not above the docs folder', async () => {
    await rm(join(base, 'README.md'));
    await rm(join(base, 'CHANGELOG.md'));
    expect(check().code).toBe(0);
  });
});

/** More forms of a local path. Each text holds the name `someone`, which the output must never show. */
const MORE_LOCAL_PATHS: ReadonlyArray<{ form: string; kind: string; text: string }> = [
  { form: 'the encoded folder of a Claude project', kind: 'an encoded user folder path', text: 'The notes are in ~/.claude/projects/-Users-someone-work-acme/memory.' },
  { form: 'a WSL path', kind: 'a user folder path', text: 'The disk is /mnt/c/Users/someone/work.' },
  { form: 'a path under /var/home', kind: 'a home path with a name', text: 'The folder is /var/home/someone/work.' },
  { form: 'a Windows path', kind: 'a user folder path', text: String.raw`The folder is C:\Users\someone\work.` },
  { form: 'a Windows path with doubled backslashes', kind: 'a user folder path', text: String.raw`"path": "C:\\Users\\someone\\work"` },
  { form: 'a lower-case user folder path', kind: 'a user folder path', text: 'The folder is /users/someone/work.' },
  { form: 'a macOS temp folder', kind: 'a macOS temp path', text: 'The temp folder is /var/folders/ab/cdef/T/someone.' },
  { form: 'a plain temp path', kind: 'a temp path', text: 'The scratch file is /tmp/someone.txt.' },
];

describe('scripts/check-intent-docs.sh, check 8: more forms of a local path', () => {
  it.each(MORE_LOCAL_PATHS)('exits 1 for $form, and never prints the path', async ({ kind, text }) => {
    await change('design.md', (before) => `${before}\n${text}\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toMatch(new RegExp(`design\\.md:\\d+ holds ${kind}`));
    expect(result.out).not.toContain('someone');
  });

  it('accepts the neutral name in each form, and a relative path that holds a form', async () => {
    await change(
      'design.md',
      (before) =>
        `${before}\n${[
          'The neutral names are -Users-example-work, /mnt/c/Users/example/work, /var/home/example/work and /users/example/work.',
          String.raw`A Windows form is C:\Users\example\work and "C:\\Users\\example\\work".`,
          'A relative path is src/users/list.ts, docs/tmp/notes.md, lib/var/folders/x or a word like list-Users-view.',
        ].join('\n')}\n`,
    );
    expect(check().code).toBe(0);
  });

  it('exits 1 for a name that only starts with the neutral name, in the encoded form', async () => {
    await change('design.md', (before) => `${before}\nThe notes are in -Users-example2-work.\n`);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
  });
});

/** The folders below the docs folder, one inside the other, and the file in the last one. */
const nested = (folders: number, name = 'extra.md'): string => join(copy, ...Array.from({ length: folders }, (_, index) => `level${index + 1}`), name);

const putAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

describe('scripts/check-intent-docs.sh, check 8: every level and every dot file', () => {
  it.each([4, 5, 10])('finds a local path in a file %d folders below the docs folder', async (folders) => {
    await putAt(nested(folders), 'See /Users/someone/work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toContain(`extra.md:1 holds a user folder path`);
  });

  it('exits 1 and names a folder that is deeper than 10 levels, because it does not read it', async () => {
    await putAt(nested(11), 'See /Users/someone/work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toContain('deeper than 10 levels');
    expect(result.out).not.toContain('someone');
  });

  it('finds a local path in a dot file of the docs folder', async () => {
    await putAt(join(copy, '.notes.md'), 'See /Users/someone/work.\n');
    const result = check();
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toContain('.notes.md:1 holds a user folder path');
  });

  it('finds a local path in a file of a dot folder', async () => {
    await putAt(join(copy, 'research', '.hidden', 'extra.md'), 'See /Users/someone/work.\n');
    const result = check();
    expect(failedChecks(result.out)).toEqual(['8']);
    expect(result.out).toContain('extra.md:1 holds a user folder path');
  });

  it('passes for a deep tree and a dot file that hold no local path', async () => {
    await putAt(nested(10), 'No path here.\n');
    await putAt(join(copy, '.notes.md'), 'No path here.\n');
    expect(check().code).toBe(0);
  });
});

describe('scripts/check-intent-docs.sh, check 7: every level and every dot file of docs/research', () => {
  /** The folders below docs/research, one inside the other, and the file in the last one. */
  const nestedInResearch = (folders: number, name = 'extra.md'): string =>
    join(copy, 'research', ...Array.from({ length: folders }, (_, index) => `level${index + 1}`), name);

  it.each([6, 8])('finds the word lane in a file %d folders below docs/research', async (folders) => {
    await putAt(nestedInResearch(folders), 'First line.\nA lane of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7']);
    expect(result.out).toContain('extra.md:2 holds the word lane');
  });

  it('finds the word lane in a dot file of docs/research', async () => {
    await putAt(join(copy, 'research', '.notes.md'), 'Two lanes of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7']);
    expect(result.out).toContain('.notes.md:1 holds the word lane');
  });

  it('finds the word lane in a file of a dot folder of docs/research', async () => {
    await putAt(join(copy, 'research', '.hidden', 'extra.md'), 'A lane of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['7']);
    expect(result.out).toContain('extra.md:1 holds the word lane');
  });

  it('exits 1 and names a folder of docs/research that is deeper than 10 levels, because it does not read it', async () => {
    await putAt(nestedInResearch(11), 'A lane of work.\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toContain('7');
    expect(result.out).toContain('deeper than 10 levels');
    expect(result.out).not.toContain('extra.md:1 holds the word lane');
  });

  it('passes for a deep tree and a dot file that hold no word lane', async () => {
    await putAt(nestedInResearch(8), 'The plane has a laneway.\n');
    await putAt(join(copy, 'research', '.notes.md'), 'No such word here.\n');
    expect(check().code).toBe(0);
  });
});

describe('scripts/check-intent-docs.sh, check 9: the design has the headings for core and setup and for extension points', () => {
  const HEADINGS = ['Core and setup', 'Extension points'] as const;

  it.each(HEADINGS)('exits 1 when the heading "%s" is missing', async (title) => {
    await change('design.md', (text) => text.replace(new RegExp(`^(#+ (?:[0-9.]+ )?)${title}$`, 'm'), '$1Another title'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['9']);
    expect(result.out).toContain(`design.md has no heading "${title}"`);
  });

  it.each(HEADINGS)('exits 1 when "%s" is text and not a heading', async (title) => {
    await change('design.md', (text) => text.replace(new RegExp(`^#+ (?:[0-9.]+ )?${title}$`, 'm'), title));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['9']);
    expect(result.out).toContain(`design.md has no heading "${title}"`);
  });

  it.each(HEADINGS)('exits 1 when only a longer heading holds "%s"', async (title) => {
    await change('design.md', (text) => text.replace(new RegExp(`^(#+ (?:[0-9.]+ )?)${title}$`, 'm'), `$1${title} and more`));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['9']);
  });

  it('names the core heading first when both are missing', async () => {
    await change('design.md', (text) => text.replace(/^(#+ (?:[0-9.]+ )?)(Core and setup|Extension points)$/gm, '$1Another title'));
    const result = check();
    expect(failedChecks(result.out)).toEqual(['9']);
    expect(result.out).toContain('design.md has no heading "Core and setup"');
    expect(result.out).not.toContain('Extension points');
  });

  it.each(HEADINGS)('accepts "%s" as a heading with no number', async (title) => {
    await change('design.md', (text) => text.replace(new RegExp(`^(#+ )[0-9.]+ ${title}$`, 'm'), `$1${title}`));
    expect(check().code).toBe(0);
  });

  it.each(HEADINGS)('accepts "%s" with a dot after the section number', async (title) => {
    await change('design.md', (text) => text.replace(new RegExp(`^(#+ [0-9]+(?:\\.[0-9]+)*) ${title}$`, 'm'), `$1. ${title}`));
    expect(check().code).toBe(0);
  });

  it.each(HEADINGS)('exits 1 when "%s" is only a line in fenced code', async (title) => {
    await change('design.md', (text) =>
      text.replace(new RegExp(`^#+ (?:[0-9.]+ )?${title}$`, 'm'), ['```sh', `# ${title}`, '```'].join('\n')),
    );
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['9']);
    expect(result.out).toContain(`design.md has no heading "${title}"`);
  });
});

/**
 * Words of the software recipe list (Step 24 of the code change makes the list equal to `words.ts`), each with the word
 * that the script prints for it. The script prints a longer word by its first part, and a word in lower case, but it
 * keeps PR and CI in capital letters.
 */
const RECIPE_WORDS: ReadonlyArray<{ input: string; printed: string }> = [
  { input: 'merge', printed: 'merge' },
  { input: 'merged', printed: 'merged' },
  { input: 'pull request', printed: 'pull request' },
  { input: 'release', printed: 'release' },
  { input: 'release check', printed: 'release' },
  { input: 'release scope', printed: 'release' },
  { input: 'CI log', printed: 'ci log' },
  { input: 'PR', printed: 'PR' },
  { input: 'CI', printed: 'CI' },
  { input: 'git', printed: 'git' },
  { input: 'Git', printed: 'git' },
  { input: 'tmux', printed: 'tmux' },
  { input: 'TMUX', printed: 'tmux' },
];

describe('scripts/check-intent-docs.sh, check 10: the core command block holds no word of the software recipe', () => {
  it.each(RECIPE_WORDS)('exits 1 for the word "$input" in a line of the core command block, and prints "$printed"', async ({ input, printed }) => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, `$1 and the ${input}`));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toMatch(/design\.md line \d+: the core part "4\.2 Core commands" holds the software recipe word "/);
    expect(result.out).toContain(`the software recipe word "${printed}"`);
  });

  it.each(['merging', 'releasing', 'merges', 'PRs', 'CI logs'])('exits 1 for the form "%s" in a line of the core command block', async (form) => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, `$1 and the ${form}`));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out.toLowerCase()).toContain(`the software recipe word "${form.toLowerCase()}"`);
  });

  it('exits 1 when the core part of design 4.2 has no fenced code', async () => {
    await change('design.md', (text) => text.replace(/(\*\*Core commands\*\*[^\n]*\n\n)```\n[\s\S]*?\n```\n/, '$1The core commands are in a list.\n'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain('design.md 4.2 has no fenced code under "**Core commands**"');
  });

  it('accepts the recipe words in the table of software recipe commands', () => {
    const text = readFileSync(join(copy, 'design.md'), 'utf8');
    const recipe = text.slice(text.indexOf('**Software recipe commands**'));
    expect(recipe).toMatch(/factory pr merge/);
    expect(check().code).toBe(0);
  });

  it('accepts a word that only holds a recipe word', async () => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, '$1 and the ciphers, a prune, a premerge and a spring'));
    expect(check().code).toBe(0);
  });

  it('accepts git and tmux inside a longer word, such as .gitignore and a digit', async () => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, '$1 and a .gitignore, a digit and a tmuxinator'));
    expect(check().code).toBe(0);
  });

  it('accepts a lower-case pr and ci in the core table, because the recipe words PR and CI are upper case', async () => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, '$1 and a pr and a ci'));
    expect(check().code).toBe(0);
  });

  it('names the first hit only', async () => {
    await change('design.md', (text) =>
      text.replace(/^(factory doctor .*)$/m, '$1 and the merge').replace(/^(factory machine .*)$/m, '$1 and the release'),
    );
    const result = check();
    expect(result.out).toContain('"merge"');
    expect(result.out).not.toContain('"release"');
  });

  it('exits 1 when design 4.2 has no core command table', async () => {
    await change('design.md', (text) => text.replace('**Core commands**', '**Commands**'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain('design.md 4.2 has no core command table');
  });
});

/** A core part of check 10, with the means to put a line into it. */
interface CorePart {
  /** The name that the script prints for the part. */
  readonly name: string;
  readonly file: string;
  /** A line of the part. The tests put their lines under it. */
  readonly anchor: RegExp;
  /** A line in the form of the part (prose, a command in the fence, a table row or a glossary entry) that holds the text. */
  readonly row: (text: string) => string;
  /** A line of the part that starts with the text, as far as the form of the part allows. */
  readonly bare: (text: string) => string;
  /** The anchor is a line of fenced code. */
  readonly inFence: boolean;
  /** A heading that ends the part, and a heading that does not (none: each heading ends the part). */
  readonly ends: string;
  readonly deeper?: string;
  /** The line that starts with `Software recipe:` or `Engineering note:` is not checked in this part. */
  readonly exempt: boolean;
}

const identity = (text: string): string => text;

const CORE_PARTS: ReadonlyArray<CorePart> = [
  {
    name: 'Summary for Dean',
    file: 'design.md',
    anchor: /^\*\*Layers\.\*\* .*$/m,
    row: identity,
    bare: identity,
    inFence: false,
    ends: '## Another section',
    deeper: '### A deeper section',
    exempt: true,
  },
  {
    name: '4.1 Concepts',
    file: 'design.md',
    anchor: /^- \*\*Owner\*\*: .*$/m,
    row: identity,
    bare: identity,
    inFence: false,
    ends: '### Another section',
    deeper: '#### A deeper section',
    exempt: true,
  },
  {
    name: '4.2 Core commands',
    file: 'design.md',
    anchor: /^factory machine .*$/m,
    row: (text) => `factory doctor ${text}`,
    bare: identity,
    inFence: true,
    ends: '#### Another section',
    exempt: false,
  },
  {
    name: '6 Rules for every factory',
    file: 'design.md',
    anchor: /^\| Resource limits \|.*$/m,
    row: (text) => `| Extra rule | yes | ${text} |`,
    bare: (text) => `| ${text} | yes | none |`,
    inFence: false,
    ends: '#### Another section',
    exempt: false,
  },
  {
    name: 'Words of every factory',
    file: 'glossary.md',
    anchor: /^- \*\*proxy\*\*: .*$/m,
    row: (text) => `- **extra**: ${text}`,
    bare: identity,
    inFence: false,
    ends: '## Another section',
    deeper: '### A deeper section',
    exempt: true,
  },
];

/** Lines that start with the marks of an exempt line. A line of the software recipe or an engineering note may name a recipe word. */
const MARKED_LINES = [
  'Software recipe: the merge in the probe line',
  '- Engineering note: the git hook in the probe line',
  '> Software recipe: the release in the probe line',
  'Engineering note: tmux shows the PR in the probe line',
];

/** The number of the first line of a file of the copy that equals the line. */
const lineNumber = async (name: string, line: string): Promise<number> => {
  const lines = (await readFile(join(copy, name), 'utf8')).split('\n');
  expect(lines).toContain(line);
  return lines.indexOf(line) + 1;
};

describe.each(CORE_PARTS)('scripts/check-intent-docs.sh, check 10, the core part "$name"', (part) => {
  /** Puts lines under the anchor of the part. */
  const put = (lines: readonly string[]): Promise<void> =>
    change(part.file, (text) => text.replace(part.anchor, (anchor) => [anchor, ...lines].join('\n')));

  it('exits 1 for a recipe word, and names the file, the line and the word', async () => {
    const line = part.row('the merge in the probe line');
    await put([line]);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    const number = await lineNumber(part.file, line);
    expect(result.out).toContain(`${part.file} line ${number}: the core part "${part.name}" holds the software recipe word "merge"`);
  });

  it.each(['git', 'tmux'])('exits 1 for the word "%s"', async (word) => {
    await put([part.row(`the ${word} in the probe line`)]);
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain(`the core part "${part.name}" holds the software recipe word "${word}"`);
  });

  it('accepts a .gitignore, because git inside a longer word is not the word', async () => {
    await put([part.row('the .gitignore file in the probe line')]);
    expect(check().code).toBe(0);
  });

  if (part.exempt) {
    it.each(MARKED_LINES)('accepts the line "%s"', async (line) => {
      await put([part.bare(line)]);
      expect(check().code).toBe(0);
    });

    it('checks a line that has the mark only after other text', async () => {
      await put([part.bare('A note. Software recipe: the merge in the probe line')]);
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['10']);
    });
  } else {
    it.each(MARKED_LINES)('still checks the line "%s"', async (line) => {
      await put([part.bare(line)]);
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['10']);
      expect(result.out).toContain(`the core part "${part.name}" holds the software recipe word`);
    });
  }

  it('stays open over a heading in fenced code', async () => {
    const hit = part.row('the merge in the probe line');
    await put(part.inFence ? ['## Not a title', hit] : ['```', '## Not a title', '```', hit]);
    const result = check();
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain(`the core part "${part.name}" holds the software recipe word "merge"`);
  });

  it('ends at a heading of its level', async () => {
    const hit = part.row('the merge in the probe line');
    await put(part.inFence ? ['```', part.ends, '```', hit] : [part.ends, hit]);
    expect(failedChecks(check().out)).not.toContain('10');
  });

  if (part.deeper !== undefined) {
    it('stays open over a deeper heading', async () => {
      await put([part.deeper ?? '', part.row('the merge in the probe line')]);
      const result = check();
      expect(failedChecks(result.out)).toEqual(['10']);
      expect(result.out).toContain(`the core part "${part.name}" holds the software recipe word "merge"`);
    });
  }
});

/** The parts that a test can take away by a change of one line, and empty by a change of the text under the start. */
const PART_EDITS: ReadonlyArray<{ name: string; file: string; rename: [RegExp, string]; empty: [RegExp, string] }> = [
  {
    name: 'Summary for Dean',
    file: 'design.md',
    rename: [/^## Summary for Dean \(one page\)$/m, '## A short summary'],
    empty: [/(## Summary for Dean \(one page\)\n)[\s\S]*?(\n## 1\. )/, '$1$2'],
  },
  {
    name: '4.1 Concepts',
    file: 'design.md',
    rename: [/^### 4\.1 Concepts$/m, '### 4.1 Ideas'],
    empty: [/(### 4\.1 Concepts\n)[\s\S]*?(\n### 4\.2 )/, '$1$2'],
  },
  {
    name: '6 Rules for every factory',
    file: 'design.md',
    rename: [/^\*\*Rules for every factory\*\*$/m, '**Rules**'],
    empty: [/(\*\*Rules for every factory\*\*\n)[\s\S]*?(\*\*Rules of the software recipe\*\*)/, '$1\n$2'],
  },
  {
    name: 'Words of every factory',
    file: 'glossary.md',
    rename: [/^## Words of every factory$/m, '## Words'],
    empty: [/(## Words of every factory\n)[\s\S]*?(\n## Words of the software recipe)/, '$1$2'],
  },
];

describe.each(PART_EDITS)('scripts/check-intent-docs.sh, check 10, the core part "$name" is needed', ({ name, file, rename, empty }) => {
  it('exits 1 and names the part when its heading or label is missing', async () => {
    await change(file, (text) => text.replace(rename[0], rename[1]));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain(`${file} has no core part "${name}"`);
  });

  it('exits 1 and names the part when it holds no line to check', async () => {
    await change(file, (text) => text.replace(empty[0], empty[1]));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toContain(`${file} holds no line to check in the core part "${name}"`);
  });
});

describe('scripts/check-intent-docs.sh, check 10: the lines of the core parts', () => {
  it('reads only the rows of the table "Rules for every factory", so the engineering note under it may name git', () => {
    const text = readFileSync(join(copy, 'design.md'), 'utf8');
    const part = text.slice(text.indexOf('**Rules for every factory**'), text.indexOf('**Rules of the software recipe**'));
    expect(part).toMatch(/^Engineering note: .*\bgit\b/m);
    expect(check().code).toBe(0);
  });

  it('names the hit of the design before the hit of the glossary', async () => {
    await change('glossary.md', (text) => text.replace(/^(- \*\*proxy\*\*: .*)$/m, '$1 Use the release.'));
    await change('design.md', (text) => text.replace(/^(\*\*Layers\.\*\* .*)$/m, '$1 Use the merge.'));
    const result = check();
    expect(result.out).toMatch(/design\.md line \d+: the core part "Summary for Dean" holds the software recipe word "merge"/);
    expect(result.out).not.toContain('glossary.md line');
  });

  it('reads the software recipe part of the glossary without a hit', () => {
    const text = readFileSync(join(copy, 'glossary.md'), 'utf8');
    expect(text.slice(text.indexOf('## Words of the software recipe'))).toMatch(/\bmerge\b/);
    expect(check().code).toBe(0);
  });
});

describe('TP-40: the docs of FAC-M4 PR 3 keep the rules of the docs script', () => {
  const docsText = (name: string): string => readFileSync(join(ROOT, 'docs', name), 'utf8');

  it('TP-40: keeps the word self in a row of the Command map, and factory self reset in the core commands of design 4.2', () => {
    const map = docsText('roadmap-v2.md').split('### Command map')[1]?.split('\n### ')[0] ?? '';
    expect(map).toMatch(/^\| .*`self`.* \| FAC-M4 \|$/m);
    const core = docsText('design.md').split('**Core commands**')[1]?.split('**Software recipe commands**')[0] ?? '';
    expect(core).toMatch(/^factory self reset\b/m);
  });

  it('TP-40: has no command of the removed inbox in the Command map or in design 4.2', () => {
    const map = docsText('roadmap-v2.md').split('### Command map')[1]?.split('\n### ')[0] ?? '';
    const commands = docsText('design.md').split('### 4.2 Commands')[1]?.split('### 4.3 ')[0] ?? '';
    expect(map).not.toMatch(/`inbox`|worker send/);
    expect(commands).not.toMatch(/^factory (?:inbox|worker send)\b/m);
  });

  it('TP-40: holds no tmux and no git word in the part "Words of every factory" of the glossary', () => {
    const text = docsText('glossary.md');
    const core = text.slice(text.indexOf('## Words of every factory'), text.indexOf('## Words of the software recipe'));
    expect(core.length).toBeGreaterThan(0);
    expect(core).not.toMatch(/\b(?:tmux|git)\b/i);
  });

  it('TP-40: passes the docs script on the docs of the repo', () => {
    expect(check(join(ROOT, 'docs')).code).toBe(0);
  });
});

const LABEL = 'Design v3 PR';
const LABEL_HEADING = '## Design v3 PR (after FAC-M2)';

describe('scripts/check-intent-docs.sh, check 2: the label "Design v3 PR"', () => {
  it('exits 1 when a row of the trace names the label and the roadmap has no heading for it', async () => {
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, '## Another section (after FAC-M2)'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toMatch(/intent-trace\.md line \d+: the label "Design v3 PR" is not a heading of roadmap-v2\.md/);
  });

  it.each([
    ['docs', 'Docs PR'],
    ['code', 'Code PR'],
  ])('exits 1 when the heading has no checkbox for the %s PR', async (kind, title) => {
    await change('roadmap-v2.md', (text) => text.replace(new RegExp(`- \\[[ xX]\\] ${title}`), '- [ ] Something else'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain(`roadmap-v2.md: the heading "${LABEL}" has no checkbox for the ${kind} PR`);
  });

  it('exits 1 when the two checkboxes are under another heading of the same level', async () => {
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, `${LABEL_HEADING}\n\n## Another section`));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain('has no checkbox for the docs PR');
  });

  it('accepts the two checkboxes under a deeper heading of the milestone', async () => {
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, `${LABEL_HEADING}\n\n### The two PRs`));
    expect(check().code).toBe(0);
  });

  it('accepts ticked checkboxes, also with a capital X', async () => {
    await change('roadmap-v2.md', (text) => text.replace(/- \[[ xX]\] Docs PR/, '- [X] Docs PR'));
    await change('roadmap-v2.md', (text) => text.replace(/- \[[ xX]\] Code PR/, '- [X] Code PR'));
    expect(check().code).toBe(0);
  });

  it('needs no heading when no row of the trace names the label', async () => {
    await change('intent-trace.md', (text) => text.split(LABEL).join('a later PR'));
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, '## Another section (after FAC-M2)'));
    expect(check().code).toBe(0);
  });
});

/** Puts lines at the start of the core command block of design 4.2. A `#` line in a fence is a shell comment, not a heading. */
const withCoreLines = (text: string, lines: string): string => text.replace(/(\*\*Core commands\*\*[^\n]*\n\n```\n)/, `$1${lines}\n`);

describe('scripts/check-intent-docs.sh, a comment or a heading in fenced code does not end a section', () => {
  it('check 3 still reads the software recipe commands after a comment line in the core block', async () => {
    await change('design.md', (text) => withCoreLines(text, '# a comment'));
    await change('roadmap-v2.md', (text) => text.replace(/^\| `check`.*\n/m, ''));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toContain('the command check of design.md 4.2 has no row in the Command map of roadmap-v2.md');
  });

  it('check 3 still finds a desk row after a comment line in the core block', async () => {
    await change('design.md', (text) => withCoreLines(text, '# a comment\nfactory desk render'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toMatch(/design\.md 4\.2 has a desk row \(line \d+\)/);
  });

  it('check 10 still finds a recipe word after a comment line in the core block', async () => {
    await change('design.md', (text) => withCoreLines(text, '# a comment\nfactory merge it'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toContain('10');
    expect(result.out).toMatch(/design\.md line \d+: the core part "4\.2 Core commands" holds the software recipe word "merge"/);
  });

  it('check 2 keeps the label section open over a heading line in fenced code', async () => {
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, `${LABEL_HEADING}\n\n\`\`\`\n## Another section\n\`\`\``));
    expect(check().code).toBe(0);
  });

  it.each([
    ['docs', 'Docs PR'],
    ['code', 'Code PR'],
  ])('check 2 does not count the checkbox for the %s PR when it is only in fenced code', async (kind, title) => {
    await change('roadmap-v2.md', (text) => text.replace(new RegExp(`^(- \\[[ xX]\\] ${title} .*\\n)`, 'm'), '```\n$1```\n'));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['2']);
    expect(result.out).toContain(`has no checkbox for the ${kind} PR`);
  });
});

/** The asks of the design v3 feedback, each with one row in the trace. */
const DESIGN_V3_ASKS = [
  'F-14a', 'F-14b', 'F-14c',
  'F-15a', 'F-15b', 'F-15c',
  'F-16a', 'F-16b', 'F-16c', 'F-16d',
  'F-17a', 'F-17b', 'F-17c', 'F-17d',
  'F-18a', 'F-18b', 'F-18c', 'F-18d', 'F-18e', 'F-18f',
  'F-19a', 'F-19b',
  'F-20a', 'F-20b',
  'F-21a', 'F-21b', 'F-21c',
  'D-57', 'D-59', 'D-60',
] as const;

/** A milestone cell of a row starts with a milestone or the label. A cell that only names one later in its text, such as "None. FAC-M5 dropped this ask", does not. */
const MILESTONE_OR_LABEL = /^(?:FAC-M\d+[a-z]?|Design v3 PR)\b/;

/** The rows of the tables of the trace, by ask id, as five cells each. */
const traceRows = (text: string): Map<string, string[]> => {
  const rows = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Ask id')) continue;
    const cells = line.slice(1, line.length - 1).split('|').map((cell) => cell.trim());
    rows.set(cells[0] ?? '', cells);
  }
  return rows;
};

describe('docs/intent-trace.md: the rows of the design v3 feedback', () => {
  const trace = readFileSync(join(ROOT, 'docs', 'intent-trace.md'), 'utf8');
  const rows = traceRows(trace);
  const cell = (id: string, index: number): string => rows.get(id)?.[index] ?? '';

  it('has one row for each ask, and no ask id twice', () => {
    const ids = trace.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Ask id')).map((line) => line.split('|')[1]?.trim() ?? '');
    expect(new Set(ids).size).toBe(ids.length);
    expect(DESIGN_V3_ASKS.filter((id) => !rows.has(id))).toEqual([]);
  });

  it.each(DESIGN_V3_ASKS)('gives the row %s a design section, a milestone or the label, and a status', (id) => {
    expect(cell(id, 2), 'no design section').toMatch(/§\d|"(?:Core and setup|Extension points)"/);
    expect(cell(id, 3), 'no milestone and no label').toMatch(MILESTONE_OR_LABEL);
    expect(cell(id, 4)).toMatch(/^(?:covered|not applicable: .+)$/);
  });

  it.each([
    ['F-14c', ['Design v3 PR']],
    ['F-15b', ['D-60', 'F-18a']],
    ['F-16d', ['Design v3 PR']],
    ['F-17c', ['Design v3 PR']],
    ['F-18e', ['FAC-M3', 'init --state-from']],
    ['F-18f', ['Design v3 PR', 'FAC-M3']],
    ['F-20b', ['FAC-M4']],
    ['F-21c', ['FAC-M4', 'FAC-M7']],
  ] as const)('names in the row %s: %j', (id, words) => {
    const text = `${cell(id, 3)} ${cell(id, 4)}`;
    for (const word of words) expect(text).toContain(word);
  });

  it('refuses a milestone cell that names no milestone and no label', () => {
    const oldCell = 'None. D-60 replaces this ask: see F-18a';
    const mutated = traceRows(trace.replace(cell('F-15b', 3), oldCell));
    expect(mutated.get('F-15b')?.[3]).toBe(oldCell);
    expect(mutated.get('F-15b')?.[3]).not.toMatch(MILESTONE_OR_LABEL);
    expect(cell('F-15b', 3)).toMatch(MILESTONE_OR_LABEL);
    expect('FAC-M5b: the usage view').toMatch(MILESTONE_OR_LABEL);
    expect('None. FAC-M5 dropped this ask').not.toMatch(MILESTONE_OR_LABEL);
    expect('None; not in the Design v3 PR').not.toMatch(MILESTONE_OR_LABEL);
  });

  it('names no command, script or key of the setup of today in a code span', () => {
    const spans = [...trace.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    const stale = spans.filter(
      (span) => /^(?:cell|up|ship|inspect|checkout|desk)(?:[ -]|$)/.test(span) || /approval\.ship|check-cell-paths|approved-work/.test(span),
    );
    expect(stale).toEqual([]);
  });

  it('does not say in any cell that a desk is marked as not built', () => {
    const marksDesk = (cell: string): boolean => /\bdesk\b/i.test(cell) && /\bnot built\b/i.test(cell);
    expect(marksDesk('The command map marks a desk, marked "not built, no milestone"')).toBe(true);
    expect(marksDesk('The desk row is Not Built yet')).toBe(true);
    expect(marksDesk('None. The command map has no desk row')).toBe(false);
    expect(trace.split('\n').flatMap((line) => line.split('|')).filter(marksDesk)).toEqual([]);
  });
});

describe('docs/roadmap-v2.md: the resource check of worker new (TP-136)', () => {
  const roadmap = readFileSync(join(ROOT, 'docs', 'roadmap-v2.md'), 'utf8');

  it('says that worker new warns, and still starts, when a resource limit fails or a machine fact is unknown', () => {
    expect(roadmap).toContain(
      '`worker new` refuses a work copy that another worker uses, and warns (exit 0, the worker still starts) when a resource limit fails or a machine fact is unknown (fake machine facts).',
    );
  });

  it('does not say that worker new refuses when a resource limit fails', () => {
    expect(roadmap).not.toContain('and refuses when a resource limit fails');
  });
});

describe('docs of M5-1b: the board of each track (TP-94, TP-106, TP-107, TP-109)', () => {
  const docsText = (name: string): string => readFileSync(join(ROOT, 'docs', name), 'utf8');
  const design = docsText('design.md');
  const roadmap = docsText('roadmap-v2.md');
  const glossary = docsText('glossary.md');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const part = (text: string, from: string, to: string): string => text.split(from)[1]?.split(to)[0] ?? '';

  it('TP-94: lists the review page command, the board archive and the page answer as criteria of FAC-M5b', () => {
    const later = part(roadmap, '### FAC-M5b: ', '\n### ');
    expect(later).toMatch(/^- \[ \] Review page command \(TB-5\)\./m);
    expect(later).toMatch(/^- \[ \] Board archive\./m);
    expect(later).toMatch(/^- \[ \] Page answer \(TB-5\)\./m);
  });

  it('TP-94: lists the criteria of tracks and stages in FAC-M5, and the track views of M5-1c', () => {
    const board = part(roadmap, '### FAC-M5: ', '\n### ');
    expect(board).toMatch(/^- \[ \] Tracks and stages \(TB-7, M5-1b\)\./m);
    expect(board).toMatch(/^- \[ \] Track views \(M5-1c, TB-1 to TB-3\)\./m);
  });

  it('TP-94: says in design 4.10 that the review page is an owner view that only reads in M5-1b', () => {
    const connector = part(design, '### 4.10 Board connector', '\n### 4.11');
    expect(connector).toContain('The review desk page of today is a supported owner view, and the owner can choose it.');
    expect(connector).toContain(
      'In M5-1b the page only reads. A page answer is a board event. It shows and wakes, and records nothing (D-142 A).',
    );
    expect(connector).not.toContain('A page answer that records through the owner store');
  });

  it('TP-94: says in step 4 of the migration that the page only reads the local files, and that FAC-M3 keeps the page', () => {
    const migration = part(design, '## 8. Migration of this workspace', '\n## 9. Decisions');
    expect(migration).toContain(
      'In M5-1b the page only reads the local files. A page answer is a board event. It shows and wakes, and records nothing (D-142 A).',
    );
    expect(migration).not.toContain('A page answer that records through the owner store');
    expect(migration).toContain('It does not retire the page (TB-5).');
  });

  it('TP-94: gives the terms track and stage in design 4.1 and in the glossary, and calls the steps of the work cycle steps', () => {
    const concepts = part(design, '### 4.1 Concepts', '\n### 4.2');
    expect(concepts).toMatch(/^- \*\*Track\*\*: a named stream of work with its own roadmap\. A worker is not a track\./m);
    expect(concepts).toMatch(/^- \*\*Stage\*\*: where a work item is on the board\. It is not a step of the work cycle/m);
    expect(concepts).toContain('It does all the steps of the work cycle for one track of one project.');
    expect(glossary).toMatch(/^- \*\*track\*\*: A track is a named stream of work with its own roadmap\. A worker is not a track\./m);
    expect(glossary).toMatch(/^- \*\*stage\*\*: A stage is where a work item is on the board\. It is not a step of the work cycle\./m);
    expect(design.split('\n').filter((line) => /work cycle/i.test(line) && /\b(?:the|all) stages of the work cycle\b/i.test(line))).toEqual([]);
  });

  it('TP-94: records the direction about the board of each track in one decision row that has no D-n id', () => {
    const decisions = design.split('## 9. Decisions')[1] ?? '';
    const rows = decisions.split('\n').filter((line) => line.startsWith('| TB-5 to TB-7 |'));
    expect(rows).toHaveLength(1);
    const [row = ''] = rows;
    const id = row.split('|')[1]?.trim() ?? '';
    expect(id).not.toMatch(/^D-\d+$/);
    expect(row).toContain('His words: "');
    expect(row).toContain('supersedes the part of F-17 (Changes in v3, point 6) and the part of F-2 (Changes from v1, point 2)');
  });

  it('TP-94: gives each note of the direction a row in the intent trace', () => {
    const trace = docsText('intent-trace.md');
    for (let n = 1; n <= 8; n += 1) expect(trace).toMatch(new RegExp(`\\bTB-${n}\\b`));
  });

  it('TP-106: tells in the README and in design 4.2 that --json removes only hidden characters from string values', () => {
    const sentence =
      'In `--json` output, only control, bidi and invisible characters are removed from string values. A line break stays as an escape, and no string is cut to a width.';
    expect(readme).toContain(sentence);
    expect(part(design, '### 4.2 Commands', '### 4.3 ')).toContain(sentence);
  });

  it('TP-107: names the dismiss idle window of M5-2 in the Check item of FAC-M5', () => {
    const board = part(roadmap, '### FAC-M5: ', '\n### ');
    const item = board.split('\n').find((line) => line.startsWith('2. **Check (F-6).**')) ?? '';
    expect(item).toContain(
      'The dismiss idle window (M5-2): `dismiss --idle` reads the board again just before each stop, and not once before all stops.',
    );
    expect(item).toContain('M5-1b states this as a limit.');
  });

  it('TP-109: adds no decide row to the Commands table of the README and no decide command to the guide', () => {
    const commands = part(readme, '## Commands', '\n### Make a factory');
    expect(commands).not.toMatch(/^\| `factory decide/m);
    expect(docsText('quick-start.md')).not.toContain('factory decide');
  });

  it('keeps the count of the doctor checks the same in the README and in the CHANGELOG as in the program', () => {
    const count = Object.keys(checkIds).length;
    expect(readme).toContain(`\`factory doctor\` runs ${count} checks.`);
    expect(part(changelog, '## 0.2.0 (not released)', '\n## 0.1.0 (not released)')).toContain(`\`factory doctor\` runs ${count} checks.`);
    expect(readme).toContain(`- \`${checkIds.boardSize}\`:`);
  });

  it('changes the CHANGELOG only in the section of 0.2.0 for the local board', () => {
    const current = part(changelog, '## 0.2.0 (not released)', '\n## 0.1.0 (not released)');
    expect(current).toContain('\nThe local board\n');
    expect(current).toContain('`boardQueueKey`');
    expect(current).toContain('`examples`');
    expect(current).not.toContain('No command reads the file yet');
    expect(changelog.split('## 0.1.0 (not released)')[1] ?? '').not.toContain('boardQueueKey');
  });
});
