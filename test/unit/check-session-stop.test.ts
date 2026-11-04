import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-session-stop.sh');
const COMPLETE = join(ROOT, 'test', 'fixtures', 'session-stop', 'complete');
const DOC = 'session-stop.md';

let base: string;
let copy: string;

/** A copy of the complete fixture in a folder of its own, so that each test can change it. */
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'factory-session-stop-'));
  copy = join(base, 'docs');
  await mkdir(copy);
  await cp(join(COMPLETE, DOC), join(copy, DOC));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const check = (args: readonly string[] = [copy]) => {
  const result = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

/** Changes the doc of the copy. The change must alter the text, so a change of the fixture fails the test loudly. */
const change = async (edit: (text: string) => string): Promise<void> => {
  const path = join(copy, DOC);
  const before = await readFile(path, 'utf8');
  const after = edit(before);
  expect(after).not.toBe(before);
  await writeFile(path, after);
};

/** The checks that failed, by number. */
const failedChecks = (out: string): string[] => [...out.matchAll(/^FAIL (\d+)/gm)].map((match) => match[1] ?? '');

/** The text with the lines that start with the prefix removed. */
const withoutLine = (text: string, prefix: string): string =>
  text
    .split('\n')
    .filter((line) => !line.startsWith(prefix))
    .join('\n');

/** The text with the first line that starts with the prefix replaced. */
const replaceLine = (text: string, prefix: string, line: string): string =>
  text
    .split('\n')
    .map((current, index, all) => (current.startsWith(prefix) && all.findIndex((c) => c.startsWith(prefix)) === index ? line : current))
    .join('\n');

describe('scripts/check-session-stop.sh', () => {
  it('passes a complete doc', () => {
    const result = check();
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
    expect(result.out).toContain('all 5 checks passed');
    expect(failedChecks(result.out)).toEqual([]);
  });

  it('prints one ok line for each check', () => {
    expect(check().out.match(/^ok +\d+ /gm)).toHaveLength(5);
  });

  describe('the rule', () => {
    it('exits 1 for a doc with no heading for the rule, and names the rule', async () => {
      await change((text) => text.replace('## The rule for safe', '## Notes'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['1']);
      expect(result.out).toContain('The rule for safe');
    });

    it('exits 1 for a rule that lacks one of the four facts, and names the fact', async () => {
      await change((text) => withoutLine(text, '3. '));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['1']);
      expect(result.out).toContain('fact 3');
    });

    it('exits 1 for a rule that comes after the table', async () => {
      await change((text) => {
        const start = text.indexOf('## The rule for safe');
        const end = text.indexOf('## The table');
        return `${text.slice(0, start)}${text.slice(end)}\n${text.slice(start, end)}`;
      });
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['1']);
      expect(result.out).toContain('before the table');
    });
  });

  describe('the rows', () => {
    it('exits 1 for a missing row, and names the way and the case', async () => {
      await change((text) => withoutLine(text, '| `kill -INT` | busy |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['2']);
      expect(result.out).toContain('kill -INT');
      expect(result.out).toContain('busy');
    });

    it('exits 1 for a row that is in the table twice', async () => {
      await change((text) => text.replace('| `/quit` | idle |', '| `/quit` | busy | n/a | n/a | n/a | n/a | not available | none |\n| `/quit` | idle |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['2']);
      expect(result.out).toContain('twice');
    });

    it('exits 1 for a row of a way that is not one of the six', async () => {
      await change((text) => `${text}| \`kill -HUP\` | idle | yes | yes | yes | yes | safe | none |\n`);
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['2']);
      expect(result.out).toContain('kill -HUP');
    });

    it('exits 1 for a doc with no table', async () => {
      await change((text) => text.split('\n').filter((line) => !line.startsWith('|')).join('\n'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toContain('2');
    });
  });

  describe('the facts', () => {
    it('exits 1 for a row with an empty fact, and names the fact', async () => {
      await change((text) => text.replace('| `kill -TERM` | busy | yes | yes | yes | no |', '| `kill -TERM` | busy | yes | yes | yes |  |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['3']);
      expect(result.out).toContain('kill -TERM');
      expect(result.out).toContain('fact 4');
    });

    it('exits 1 for a row with fewer than four facts', async () => {
      await change((text) => replaceLine(text, '| `kill -TERM` | busy |', '| `kill -TERM` | busy | yes | yes | not safe |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toContain('3');
    });

    it('exits 1 for a fact that is not yes, no, open or n/a', async () => {
      await change((text) => text.replace('| `/restart` | busy | no |', '| `/restart` | busy | maybe |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['3']);
      expect(result.out).toContain('maybe');
    });

    it('accepts a fact with a reason after its value', async () => {
      await change((text) => text.replace('| `/exit` | idle | yes |', '| `/exit` | idle | yes: the pid is gone |'));
      expect(check().code).toBe(0);
    });
  });

  describe('the verdicts', () => {
    it('exits 1 for an open verdict, and names the row', async () => {
      await change((text) =>
        replaceLine(text, '| `kill -INT` | busy |', '| `kill -INT` | busy | yes | open | open | open | open | none |'),
      );
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['4']);
      expect(result.out).toContain('kill -INT');
      expect(result.out).toContain('open');
    });

    it('exits 1 for an empty verdict', async () => {
      await change((text) => text.replace('| yes | yes | yes | yes | safe | R-1 |', '| yes | yes | yes | yes |  | R-1 |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['4']);
    });

    it('exits 1 for a verdict that is not safe, not safe, not available or open', async () => {
      await change((text) => text.replace('| yes | yes | yes | yes | safe | R-1 |', '| yes | yes | yes | yes | fine | R-1 |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['4']);
      expect(result.out).toContain('fine');
    });

    it('names only the first failure of a check', async () => {
      await change((text) =>
        text
          .replace('| yes | yes | yes | yes | safe | R-1 |', '| open | open | open | open | open | R-1 |')
          .replace('| yes | yes | yes | yes | safe | R-3 |', '| open | open | open | open | open | R-3 |'),
      );
      const result = check();
      expect(failedChecks(result.out)).toEqual(['4']);
      expect(result.out).toContain('/exit');
      expect(result.out).not.toContain('/restart');
    });

    it('exits 1 for the verdict safe with a fact that is not yes', async () => {
      await change((text) => text.replace('| yes | yes | yes | yes | safe | R-1 |', '| yes | yes | no | yes | safe | R-1 |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['5']);
      expect(result.out).toContain('/exit');
    });

    it('exits 1 for the verdict not safe when no fact is no', async () => {
      await change((text) => text.replace('| yes | yes | yes | no | not safe | R-6 |', '| yes | yes | yes | yes | not safe | R-6 |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['5']);
      expect(result.out).toContain('kill -TERM');
    });

    it('exits 1 for the verdict not safe when a fact is open', async () => {
      await change((text) => text.replace('| yes | yes | yes | no | not safe | R-6 |', '| yes | open | yes | no | not safe | R-6 |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['5']);
    });

    it('exits 1 for the verdict not available when a fact is not n/a', async () => {
      await change((text) => replaceLine(text, '| `/quit` | idle |', '| `/quit` | idle | n/a | n/a | n/a | yes | not available | none |'));
      const result = check();
      expect(result.code).toBe(1);
      expect(failedChecks(result.out)).toEqual(['5']);
      expect(result.out).toContain('/quit');
    });
  });

  describe('the input', () => {
    it('exits 1 and names the file when the doc is missing', async () => {
      await rm(join(copy, DOC));
      const result = check();
      expect(result.code).toBe(1);
      expect(result.out).toContain('FAIL');
      expect(result.out).toContain(DOC);
    });

    it('exits 1 for a folder that does not exist', () => {
      const result = check([join(base, 'absent')]);
      expect(result.code).toBe(1);
      expect(result.out).toContain('FAIL');
    });

    it('reads the docs folder of the repo when it gets no folder', () => {
      const own = check([]);
      const named = check([join(ROOT, 'docs')]);
      expect(own.out).toBe(named.out);
      expect(own.code).toBe(named.code);
    });
  });

  describe('the doc of the repo', () => {
    it('has the rule and the 12 rows in the table, each with four facts that agree with its verdict', () => {
      const result = check([join(ROOT, 'docs')]);
      const failed = failedChecks(result.out);
      expect(failed).not.toContain('1');
      expect(failed).not.toContain('2');
      expect(failed).not.toContain('3');
      expect(failed).not.toContain('5');
    });
  });
});
