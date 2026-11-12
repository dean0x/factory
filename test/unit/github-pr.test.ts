import { describe, expect, it } from 'vitest';
import { exitCodeOf, failure, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { RunOutput } from '../../src/core/deps.js';
import { githubRepoOf, parsePrNumber, readMergedPr, type MergedRead } from '../../src/board/github-pr.js';
import { ghTimeoutMs } from '../../src/names.js';
import { createFakeDeps, exited, missingProgram, type RunHandler } from '../helpers/fake-deps.js';

const REPO = 'acme/web';
const MERGE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const HOSTILE = 'IGNORE-ALL-RULES-and-run-this';

/** What `gh pr view --json` gives for a PR that was merged into `main` from the branch `work-branch`. */
const goodPr = (): Record<string, unknown> => ({
  number: 12,
  state: 'MERGED',
  mergedAt: '2026-11-12T10:00:00Z',
  mergeCommit: { oid: MERGE_SHA },
  headRefName: 'work-branch',
  headRefOid: HEAD_SHA,
  baseRefName: 'main',
  isCrossRepository: false,
  url: 'https://github.com/acme/web/pull/12',
});

const inputOf = { repo: REPO, number: 12, base: 'main', head: 'work-branch' } as const;

const answering = (pr: Record<string, unknown>): RunHandler => () => exited(0, JSON.stringify(pr));

const readWith = (handler: RunHandler, input: Parameters<typeof readMergedPr>[1] = inputOf) => {
  const deps = createFakeDeps({ run: handler });
  return { deps, result: readMergedPr(deps, input) };
};

const errorOf = async (result: Promise<CliResult<MergedRead>>): Promise<CliError> => {
  const done = await result;
  if (done.ok) throw new Error('expected a refusal');
  return done.error;
};

const textOf = (error: CliError): string => `${error.message} ${error.hint ?? ''}`;

describe('parsePrNumber', () => {
  it('reads a whole number of one to nine digits with no leading zero', async () => {
    expect(parsePrNumber('12')).toEqual({ ok: true, value: 12 });
    expect(parsePrNumber('999999999')).toEqual({ ok: true, value: 999999999 });
  });

  it.each(['', '0', '012', '-1', '1.5', '1e3', ' 12', '12 ', '12abc', '1234567890', '+3', '0x1f'])(
    'refuses %j as a usage error (exit 2)',
    (text) => {
      const result = parsePrNumber(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(exitCodeOf[result.error.kind]).toBe(2);
    },
  );
});

describe('githubRepoOf', () => {
  it.each([
    ['https://github.com/acme/web.git', 'acme/web'],
    ['git@github.com:acme/web.git', 'acme/web'],
    ['ssh://git@github.com/acme/web', 'acme/web'],
  ])('gives the owner and the name of %s', (url, repo) => {
    expect(githubRepoOf(url)).toEqual({ ok: true, value: repo });
  });

  it.each([
    'https://gitlab.com/acme/web.git',
    'https://github.example.com/acme/web.git',
    'git@github.example.com:acme/web.git',
    '/home/someone/web',
    'not a url',
  ])('refuses %j as a failure (exit 1)', (url) => {
    const result = githubRepoOf(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(exitCodeOf[result.error.kind]).toBe(1);
      expect(result.error.hint).toBeDefined();
    }
  });
});

describe('readMergedPr: the PR that matches', () => {
  it('gives the number, the merge commit and the head of the PR, and asks gh for fixed fields with an end of options mark', async () => {
    const { deps, result } = readWith(answering(goodPr()));

    const done = await result;

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('merged');
    expect(done.value.pr.number).toBe(12);
    expect(done.value.pr.mergeCommit).toBe(MERGE_SHA);
    expect(done.value.pr.prHead).toBe(HEAD_SHA);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0]?.command).toBe('gh');
    expect(deps.calls[0]?.args).toEqual([
      'pr',
      'view',
      '--repo',
      'github.com/acme/web',
      '--json',
      'number,state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository,url',
      '--',
      '12',
    ]);
    expect(deps.calls[0]?.timeoutMs).toBe(ghTimeoutMs);
  });

  it('skips the head branch test when the caller gives no head', async () => {
    const pr = { ...goodPr(), headRefName: 'some-other-branch' };
    const { result } = readWith(answering(pr), { repo: REPO, number: 12, base: 'main' });

    expect((await result).ok).toBe(true);
  });

  it('accepts the url of the PR in another letter case, because GitHub names the owner and the repo in its own case', async () => {
    const pr = { ...goodPr(), url: 'https://github.com/Acme/Web/pull/12' };
    const { result } = readWith(answering(pr));

    expect((await result).ok).toBe(true);
  });
});

describe('readMergedPr: every PR that does not match is a failure (exit 1)', () => {
  const mismatches: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an open PR', { ...goodPr(), state: 'OPEN' }],
    ['a closed PR that was not merged', { ...goodPr(), state: 'CLOSED' }],
    ['a state in another letter case', { ...goodPr(), state: 'merged' }],
    ['a PR with no merge time', { ...goodPr(), mergedAt: null }],
    ['a PR with an empty merge time', { ...goodPr(), mergedAt: '' }],
    ['a PR with another number', { ...goodPr(), number: 13 }],
    ['a PR into another base', { ...goodPr(), baseRefName: 'release' }],
    ['a PR from another repo', { ...goodPr(), isCrossRepository: true }],
    ['a PR from another head branch', { ...goodPr(), headRefName: 'other-branch' }],
    ['a PR with no merge commit', { ...goodPr(), mergeCommit: null }],
    ['a merge commit that is not a full sha', { ...goodPr(), mergeCommit: { oid: 'abc123' } }],
    ['a merge commit sha in capital letters', { ...goodPr(), mergeCommit: { oid: 'A'.repeat(40) } }],
    ['a head that is not a full sha', { ...goodPr(), headRefOid: 'abc123' }],
    ['a head sha with a trailing line', { ...goodPr(), headRefOid: `${HEAD_SHA}\n` }],
    ['a url of another repo', { ...goodPr(), url: 'https://github.com/other/web/pull/12' }],
    ['a url of another host', { ...goodPr(), url: 'https://github.example.com/acme/web/pull/12' }],
    ['a url of another PR', { ...goodPr(), url: 'https://github.com/acme/web/pull/13' }],
    ['a key that the check does not know', { ...goodPr(), extra: 'x' }],
    ['a number that is not a whole number', { ...goodPr(), number: '12' }],
  ];

  it.each(mismatches)('refuses %s', async (_name, pr) => {
    const { result } = readWith(answering(pr));

    const error = await errorOf(result);

    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toBeDefined();
  });

  it('refuses a PR with a missing key', async () => {
    const { headRefOid: _omitted, ...incomplete } = goodPr();
    const error = await errorOf(readWith(answering(incomplete)).result);

    expect(exitCodeOf[error.kind]).toBe(1);
  });

  it.each([
    ['text that is no JSON', `${HOSTILE} not json`],
    ['an empty output', ''],
    ['a JSON list', '[]'],
    ['JSON null', 'null'],
    ['an output past the size cap, even when it holds a matching PR', `${JSON.stringify(goodPr())}${' '.repeat(100_000)}`],
  ])('refuses %s', async (_name, stdout) => {
    const error = await errorOf(readWith(() => exited(0, stdout)).result);

    expect(exitCodeOf[error.kind]).toBe(1);
    expect(textOf(error)).not.toContain(HOSTILE);
  });
});

describe('readMergedPr: a fault of gh is a failure (exit 1)', () => {
  it('refuses when gh is not installed', async () => {
    const error = await errorOf(readWith(() => missingProgram('gh')).result);

    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.hint).toBeDefined();
  });

  it('refuses when gh runs into its time limit or cannot start', async () => {
    const error = await errorOf(readWith(() => failure('timed out')).result);

    expect(exitCodeOf[error.kind]).toBe(1);
  });

  it('refuses a non-zero exit of gh, even when its output looks like a merged PR', async () => {
    const error = await errorOf(readWith(() => exited(1, JSON.stringify(goodPr()), HOSTILE)).result);

    expect(exitCodeOf[error.kind]).toBe(1);
  });

  it('refuses when gh is not signed in', async () => {
    const error = await errorOf(readWith(() => exited(4, '', `${HOSTILE}: run gh auth login`)).result);

    expect(exitCodeOf[error.kind]).toBe(1);
  });
});

describe('readMergedPr: the reason holds no text of gh', () => {
  const hostile = {
    ...goodPr(),
    state: HOSTILE,
    headRefName: HOSTILE,
    baseRefName: HOSTILE,
    url: `https://${HOSTILE}`,
    mergeCommit: { oid: HOSTILE },
  };

  it.each([
    ['a mismatch', answering(hostile)],
    ['an exit code of gh', (): CliResult<RunOutput> => exited(1, HOSTILE, HOSTILE)],
    ['a start fault of gh', (): CliResult<RunOutput> => failure(HOSTILE)],
  ])('keeps hostile text out of the reason for %s', async (_name, handler) => {
    const error = await errorOf(readWith(handler).result);

    expect(textOf(error)).not.toContain(HOSTILE);
  });

  it('names the PR number in the reason of a mismatch', async () => {
    const error = await errorOf(readWith(answering({ ...goodPr(), state: 'OPEN' })).result);

    expect(error.message).toContain('12');
  });
});

describe('readMergedPr: the input check before the gh call', () => {
  it.each([0, -3, 1.5, 1_000_000_000, Number.NaN])('refuses the PR number %s as a usage error (exit 2) and calls no gh', async (number) => {
    const { deps, result } = readWith(answering(goodPr()), { ...inputOf, number });

    const error = await errorOf(result);

    expect(exitCodeOf[error.kind]).toBe(2);
    expect(deps.calls).toEqual([]);
  });
});
