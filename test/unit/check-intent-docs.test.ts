import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const check = (dir: string = copy) => {
  const result = spawnSync('sh', [SCRIPT, dir], { encoding: 'utf8' });
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
const failedChecks = (out: string): string[] => [...out.matchAll(/^FAIL (\d)/gm)].map((match) => match[1] ?? '');

describe('scripts/check-intent-docs.sh', () => {
  it('passes on the docs of the repo', () => {
    const result = check(join(ROOT, 'docs'));
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
    expect(result.out).toContain('all 8 checks passed');
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
    await change('roadmap-v2.md', (text) => text.replace(/^\| `desk` .*\n/m, ''));
    const result = check();
    expect(result.code).toBe(1);
    expect(failedChecks(result.out)).toEqual(['3']);
    expect(result.out).toContain('the command desk of design.md 4.2 has no row in the Command map');
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
    expect(result.out).not.toContain('private');
  });

  it('passes when the README and the CHANGELOG are not above the docs folder', async () => {
    await rm(join(base, 'README.md'));
    await rm(join(base, 'CHANGELOG.md'));
    expect(check().code).toBe(0);
  });
});
