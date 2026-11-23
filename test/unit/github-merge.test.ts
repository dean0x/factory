import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failure } from '../../src/cli/errors.js';
import { ghTimeoutMs } from '../../src/names.js';
import { confirmMerged, mergeArgv, runMerge } from '../../src/recipes/software/github-merge.js';
import { mergeMethods } from '../../src/recipes/software/words.js';
import { createFakeDeps, exited, missingProgram, type RunHandler } from '../helpers/fake-deps.js';
import { allSourceFiles, importPathsOf, literalsOf } from '../helpers/source-scan.js';

const SRC = join(__dirname, '..', '..', 'src');
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const TARGET = { repo: 'example/project', number: 12, head: HEAD };
const REQUEST = { ...TARGET, method: 'squash', admin: false } as const;
const MERGE_PREFIX = ['pr', 'merge', '--repo', 'github.com/example/project', '--match-head-commit', HEAD];
const VIEW_ARGS = ['pr', 'view', '--repo', 'github.com/example/project', '--json', 'state,mergedAt,headRefOid', '--', '12'];
const OPEN = { state: 'OPEN', mergedAt: null, headRefOid: HEAD };
const MERGED = { ...OPEN, state: 'MERGED', mergedAt: '2026-11-23T00:18:48Z' };
const reply = (value: unknown) => exited(0, JSON.stringify(value));
const sequence = (...answers: ReturnType<RunHandler>[]) => {
  let next = 0;
  return createFakeDeps({ run: () => answers[next++] ?? failure('unexpected call') });
};

describe('mergeArgv', () => {
  it.each(mergeMethods)('uses only the fixed merge arguments for %s', (method) => {
    expect(mergeArgv({ ...REQUEST, method })).toEqual({ ok: true, value: [...MERGE_PREFIX, `--${method}`, '--', '12'] });
  });

  it('adds the admin flag only when requested', () => {
    expect(mergeArgv({ ...REQUEST, admin: true })).toEqual({ ok: true, value: [...MERGE_PREFIX, '--squash', '--admin', '--', '12'] });
  });

  it.each(['a'.repeat(39), 'A'.repeat(40), `${HEAD.slice(1)}g`])('refuses a head that is not a full lowercase SHA: %s', (head) => {
    expect(mergeArgv({ ...REQUEST, head })).toEqual({ ok: false, error: {
      kind: 'usage', message: 'The head must be a full commit id of 40 lowercase hex digits.',
      hint: 'Give the full PR head. Run "factory pr merge --help" to see the options.',
    } });
  });

  it('refuses an invalid PR number', () => {
    expect(mergeArgv({ ...REQUEST, number: 0 })).toMatchObject({ ok: false, error: {
      kind: 'usage', message: 'PR number: must be a whole number of one to nine digits, with no leading zero',
    } });
  });

  it('refuses a repo with an extra path component', () => {
    expect(mergeArgv({ ...REQUEST, repo: 'example/project/other' })).toEqual({ ok: false, error: {
      kind: 'usage', message: 'The repo name is not valid for GitHub.',
      hint: 'Check the project URL. Run "factory doctor" to check the config.',
    } });
  });
});

describe('runMerge', () => {
  it('makes one call with its own time limit and no clone directory', async () => {
    const deps = sequence(exited(0, 'arbitrary text'));
    expect(await runMerge(deps, REQUEST)).toEqual({ ok: true, value: undefined });
    expect(deps.calls).toMatchObject([{
      command: 'gh', args: [...MERGE_PREFIX, '--squash', '--', '12'], timeoutMs: 60_000, cwd: undefined,
    }]);
    expect(deps.sleeps).toEqual([]);
  });

  it.each([
    ['time limit', failure('time limit')],
    ['no start', missingProgram('gh')],
    ['nonzero exit', exited(1, 'MERGED', 'arbitrary text')],
  ])('does not repeat a call after %s or return gh text', async (_name, answer) => {
    const deps = sequence(answer);
    expect(await runMerge(deps, REQUEST)).toEqual({ ok: false, error: {
      kind: 'failure', message: 'gh could not complete the merge call.',
      hint: 'Run "factory check 12" to check the PR state before a new merge call.',
    } });
    expect(deps.calls).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('does not start gh for an invalid pin', async () => {
    const deps = sequence();
    expect(await runMerge(deps, { ...REQUEST, head: HEAD.slice(1) })).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(deps.calls).toEqual([]);
  });
});

describe('confirmMerged', () => {
  it('reads again if gh exits zero and the PR is open', async () => {
    const deps = sequence(exited(0), reply(OPEN), reply(MERGED));
    await runMerge(deps, REQUEST);
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'merged' });
    expect(deps.calls.slice(1)).toMatchObject([1, 2].map(() => ({ command: 'gh', args: VIEW_ARGS, timeoutMs: ghTimeoutMs, cwd: undefined })));
    expect(deps.sleeps).toEqual([5_000]);
  });

  it('confirms a merge on the first read with no wait', async () => {
    const deps = sequence(reply(MERGED));
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'merged' });
    expect(deps.calls).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('stops on another head even if GitHub shows a merge time', async () => {
    const deps = sequence(reply({ ...MERGED, headRefOid: NEXT_HEAD }), reply(MERGED));
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'head-moved', head: NEXT_HEAD });
    expect(deps.calls).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('returns not merged if the third read shows an open PR', async () => {
    const deps = sequence(reply(OPEN), exited(0, 'not JSON'), reply(OPEN), reply(MERGED));
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'not-merged' });
    expect(deps.calls).toHaveLength(3);
    expect(deps.sleeps).toEqual([5_000, 5_000]);
  });

  it.each([
    ['an unreadable view', exited(1, 'MERGED')],
    ['a merged state without a merge time', reply({ ...MERGED, mergedAt: null })],
    ['an invalid merge time', reply({ ...MERGED, mergedAt: 'not a time' })],
    ['an invalid head', reply({ ...MERGED, headRefOid: HEAD.slice(1) })],
    ['a closed PR at the pin', reply({ ...OPEN, state: 'CLOSED' })],
  ])('returns unknown if the third read gives %s', async (_name, answer) => {
    const deps = sequence(exited(0, 'not JSON'), reply(OPEN), answer, reply(MERGED));
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'unknown' });
    expect(deps.calls).toHaveLength(3);
    expect(deps.sleeps).toEqual([5_000, 5_000]);
  });

  it('can confirm a merge after a failed call and an unreadable view', async () => {
    const deps = sequence(failure('time limit'), missingProgram('gh'), reply(MERGED));
    await runMerge(deps, REQUEST);
    expect(await confirmMerged(deps, TARGET)).toEqual({ kind: 'merged' });
    expect(deps.calls.map(({ args }) => args[1])).toEqual(['merge', 'view', 'view']);
    expect(deps.sleeps).toEqual([5_000]);
  });

  it('does not read GitHub for an invalid pin', async () => {
    const deps = sequence();
    expect(await confirmMerged(deps, { ...TARGET, head: HEAD.slice(1) })).toEqual({ kind: 'unknown' });
    expect(deps.calls).toEqual([]);
    expect(deps.sleeps).toEqual([]);
  });
});

describe('merge command source rules', () => {
  it('permits the admin literal only in the merge runner and forbids auto and delete-branch literals', () => {
    const flags = allSourceFiles(SRC).flatMap((file) => literalsOf(readFileSync(file, 'utf8'))
      .filter((literal) => /--(?:admin|auto|delete-branch)\b/.test(literal))
      .map((literal) => [relative(SRC, file), literal]));
    expect(flags).toEqual([[join('recipes', 'software', 'github-merge.ts'), '--admin']]);
  });

  it.each(['pr-watch.ts', 'github-pr.ts'])('keeps merge runner imports out of %s', (file) => {
    const source = readFileSync(join(SRC, 'recipes', 'software', file), 'utf8');
    expect(importPathsOf(source).filter((path) => /(?:^|\/)(?:github-merge|pr-merge)\.js$/.test(path))).toEqual([]);
  });
});
