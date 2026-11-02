import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-intent-docs.sh');
const DOC_FILES = ['design.md', 'intent-trace.md', 'roadmap-v2.md', 'token-budget.md'];

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
    expect(result.out).toMatch(/the command \S+ of design\.md 4\.2 has no row in the Command map/);
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

/** Words of the software recipe list (Step 24 of the code change makes the list equal to `words.ts`). */
const RECIPE_WORDS = ['merge', 'merged', 'pull request', 'release', 'release check', 'release scope', 'CI log', 'PR', 'CI'] as const;

describe('scripts/check-intent-docs.sh, check 10: the core command table holds no word of the software recipe', () => {
  it.each(RECIPE_WORDS)('exits 1 for the word "%s" in a line of the core command table', async (word) => {
    await change('design.md', (text) => text.replace(/^(factory machine .*)$/m, `$1 and the ${word}`));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['10']);
    expect(result.out).toMatch(/design\.md line \d+: the core command table holds the software recipe word "/);
  });

  it.each(['merging', 'releasing', 'merges', 'PRs', 'CI logs'])('exits 1 for the form "%s" in a line of the core command table', async (form) => {
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
    await change('roadmap-v2.md', (text) => text.replace(`- [ ] ${title}`, '- [ ] Something else'));
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

  it('accepts ticked checkboxes', async () => {
    await change('roadmap-v2.md', (text) => text.replace('- [ ] Docs PR', '- [x] Docs PR'));
    await change('roadmap-v2.md', (text) => text.replace('- [ ] Code PR', '- [X] Code PR'));
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
    expect(result.out).toMatch(/design\.md line \d+: the core command table holds the software recipe word "merge"/);
  });

  it('check 2 keeps the label section open over a heading line in fenced code', async () => {
    await change('roadmap-v2.md', (text) => text.replace(LABEL_HEADING, `${LABEL_HEADING}\n\n\`\`\`\n## Another section\n\`\`\``));
    expect(check().code).toBe(0);
  });

  it.each([
    ['docs', 'Docs PR'],
    ['code', 'Code PR'],
  ])('check 2 does not count the checkbox for the %s PR when it is only in fenced code', async (kind, title) => {
    await change('roadmap-v2.md', (text) => text.replace(new RegExp(`^(- \\[ \\] ${title} .*\\n)`, 'm'), '```\n$1```\n'));
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
  'F-17a', 'F-17b', 'F-17c',
  'F-18a', 'F-18b', 'F-18c', 'F-18d', 'F-18e', 'F-18f',
  'F-19a', 'F-19b',
  'F-20a', 'F-20b',
  'F-21a', 'F-21b', 'F-21c',
  'D-57', 'D-59', 'D-60',
] as const;

/** A milestone cell of a row names a milestone or the label. A cell that starts with "None." names neither. */
const MILESTONE_OR_LABEL = /FAC-M\d+|Design v3 PR/;

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
  });

  it('names no command, script or key of the setup of today in a code span', () => {
    const spans = [...trace.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    const stale = spans.filter(
      (span) => /^(?:cell|up|ship|inspect|checkout|desk)(?:[ -]|$)/.test(span) || /approval\.ship|check-cell-paths|approved-work/.test(span),
    );
    expect(stale).toEqual([]);
  });

  it('does not say that the command map marks a desk', () => {
    expect(trace).not.toMatch(/marked "not built, no milestone"/);
  });
});
