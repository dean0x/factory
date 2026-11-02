import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-review-scope.sh');
const HEADING = 'Setup and upgrade code (D-51 A)';
const PATHS = [
  'src/commands/init.ts',
  'src/commands/upgrade.ts',
  'src/commands/doctor.ts',
  'src/upgrade/apply.ts',
  'src/upgrade/plan.ts',
  'src/upgrade/spec.ts',
];

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'factory-scope-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A review summary: the section of the six paths between two other sections. */
const summaryOf = (listed: readonly string[], level = '##'): string =>
  [
    '# Review summary',
    '',
    `${level} Findings`,
    '',
    'No finding in `src/upgrade/spec.ts` here counts, because this is not the section.',
    '',
    `${level} ${HEADING}`,
    '',
    'One agent read these files in full:',
    ...listed.map((path) => `- \`${path}\``),
    '',
    `${level} Verdict`,
    '',
    'Ready.',
    '',
  ].join('\n');

const check = async (text: string | null) => {
  const file = join(folder, 'summary.md');
  if (text !== null) await writeFile(file, text);
  const result = spawnSync('sh', [SCRIPT, file], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

describe('scripts/check-review-scope.sh', () => {
  it('exits 0 for a summary that lists all six paths', async () => {
    const result = await check(summaryOf(PATHS));
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
    expect(result.out).toContain('lists all 6 paths');
  });

  it.each(PATHS)('exits 1 and names the path %s when the summary does not list it', async (path) => {
    const result = await check(summaryOf(PATHS.filter((candidate) => candidate !== path)));
    expect(result.code).toBe(1);
    const named = result.out.split('\n').filter((line) => /^ {5}\S/.test(line)).map((line) => line.trim());
    expect(named).toEqual([path]);
  });

  it('names every path that is not listed', async () => {
    const result = await check(summaryOf(PATHS.slice(0, 3)));
    expect(result.code).toBe(1);
    const named = result.out.split('\n').filter((line) => /^ {5}\S/.test(line)).map((line) => line.trim());
    expect(named).toEqual(PATHS.slice(3));
  });

  it('exits 1 and names the missing section, and all six paths, for a summary with no such section', async () => {
    const result = await check('# Review summary\n\n## Findings\n\n' + PATHS.map((path) => `- ${path}`).join('\n') + '\n');
    expect(result.code).toBe(1);
    expect(result.out).toContain('the section is missing');
    for (const path of PATHS) expect(result.out).toContain(path);
  });

  it('does not count a path that the summary lists in another section', async () => {
    const result = await check(summaryOf(PATHS.filter((path) => path !== 'src/upgrade/spec.ts')));
    expect(result.code).toBe(1);
    expect(result.out).toContain('src/upgrade/spec.ts');
  });

  it('does not count a longer name that holds the path', async () => {
    const longer = PATHS.map((path) => (path === 'src/commands/init.ts' ? 'src/commands/init.tsx' : path));
    const result = await check(summaryOf(longer));
    expect(result.code).toBe(1);
    expect(result.out).toContain('     src/commands/init.ts');
    const prefixed = PATHS.map((path) => (path === 'src/upgrade/plan.ts' ? 'old/src/upgrade/plan.ts' : path));
    expect((await check(summaryOf(prefixed))).code).toBe(1);
  });

  it('accepts a path at the end of a sentence and a path in a table cell', async () => {
    const text = [
      `## ${HEADING}`,
      '',
      `The agent read ${PATHS[0]}, ${PATHS[1]}, ${PATHS[2]}. Then it read ${PATHS[3]}.`,
      '',
      '| File | Result |',
      '|---|---|',
      `| ${PATHS[4]} | read |`,
      `| ${PATHS[5]} | read |`,
      '',
    ].join('\n');
    expect((await check(text)).code).toBe(0);
  });

  it('reads the section to the next heading of the same level, and keeps lower headings in it', async () => {
    const text = [
      `## ${HEADING}`,
      '',
      PATHS.slice(0, 3).map((path) => `- ${path}`).join('\n'),
      '',
      '### Second pass',
      '',
      PATHS.slice(3).map((path) => `- ${path}`).join('\n'),
      '',
      '## Verdict',
      '',
    ].join('\n');
    expect((await check(text)).code).toBe(0);
  });

  it('exits 1 and names the file when the summary does not exist', async () => {
    const result = await check(null);
    expect(result.code).toBe(1);
    expect(result.out).toContain('summary.md is missing');
  });

  it('exits 2 with a usage line when it has no argument', () => {
    const result = spawnSync('sh', [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});
