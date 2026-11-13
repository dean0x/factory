import { describe, expect, it } from 'vitest';
import { exitCodeOf, type CliError, type CliResult } from '../../src/cli/errors.js';
import type { CheckedRecord, RecipeProject, RecordCheckInput } from '../../src/recipes/entry.js';
import { recipes } from '../../src/recipes/index.js';
import { softwareBoard, mergedStage } from '../../src/recipes/software/board.js';
import { softwareRecordCheck } from '../../src/recipes/software/record.js';
import { createFakeDeps, exited, type RunCall, type RunHandler } from '../helpers/fake-deps.js';
import { publishRecipe } from '../helpers/publish-recipe.js';

const MERGE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

const goodPr = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 12,
  state: 'MERGED',
  mergedAt: '2026-11-12T10:00:00Z',
  mergeCommit: { oid: MERGE_SHA },
  headRefName: 'worker/alpha',
  headRefOid: HEAD_SHA,
  baseRefName: 'main',
  isCrossRepository: false,
  url: 'https://github.com/acme/web/pull/12',
  ...change,
});

const PROJECT: RecipeProject = { id: 'web', path: 'web', url: 'https://github.com/acme/web.git', default_branch: 'main' };

const inputOf = (change: Partial<RecordCheckInput> = {}): RecordCheckInput => ({
  ref: '12',
  project: PROJECT,
  cloneDir: '/h/node/web',
  branches: ['worker/alpha'],
  ...change,
});

/** What git knows about the clone: the remote head (`origin/main`) and the current branch. A part that is left out is unknown. */
interface CloneBranches {
  readonly originHead?: string;
  readonly currentBranch?: string;
}

/** The fake world: `gh` gives the PR, and git gives the branches of the clone that the test names, or nothing. */
const world = (pr: Record<string, unknown> = goodPr(), clone: CloneBranches = {}): { readonly calls: RunCall[]; readonly run: RunHandler } => {
  const calls: RunCall[] = [];
  const run: RunHandler = (call) => {
    calls.push(call);
    if (call.command === 'gh') return exited(0, JSON.stringify(pr));
    if (call.args.includes('--show-current')) return exited(0, `${clone.currentBranch ?? ''}\n`);
    if (call.args.includes('refs/remotes/origin/HEAD') && clone.originHead !== undefined) return exited(0, `${clone.originHead}\n`);
    return exited(128, '', 'fatal: not a ref');
  };
  return { calls, run };
};

const check = (fake: ReturnType<typeof world>, input: RecordCheckInput): Promise<CliResult<CheckedRecord>> =>
  softwareRecordCheck.check(createFakeDeps({ run: fake.run }), input);

const errorOf = <T>(result: CliResult<T>): CliError => {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

const ghCalls = (fake: ReturnType<typeof world>): RunCall[] => fake.calls.filter((call) => call.command === 'gh');

describe('the record check in the registry', () => {
  it('is held by the software recipe, with a stage that the board of the recipe lists', () => {
    const entry = recipes.find((candidate) => candidate.id === 'software');
    expect(entry?.recordCheck).toBe(softwareRecordCheck);
    expect(softwareRecordCheck.stage).toBe(mergedStage);
    expect(softwareBoard.stages).toContain(softwareRecordCheck.stage);
  });

  it('is not held by a recipe that gives none', () => {
    expect(publishRecipe.recordCheck).toBeUndefined();
  });

  it('gives the words for the help of the command', () => {
    expect(softwareRecordCheck.summary).toBe('record a merged PR');
    expect(softwareRecordCheck.refHelp).toContain('the number of the PR');
    expect(softwareRecordCheck.refHelp).toContain('never merges a PR');
  });
});

describe('the software record check: the reference', () => {
  it('gives a PR number of one to nine digits as the checked reference', () => {
    expect(softwareRecordCheck.parseRef('12')).toEqual({ ok: true, value: '12' });
  });

  it.each(['', '0', '012', '-1', '1.5', ' 12', '12abc', '1234567890'])('refuses %j as a usage error (exit 2)', (text) => {
    const result = softwareRecordCheck.parseRef(text);
    expect(exitCodeOf[errorOf(result).kind]).toBe(2);
  });
});

describe('the software record check: a merged PR (AC-1, AC-2)', () => {
  it('gives the stage, the checked reference, the head of the PR and a summary with the merge commit', async () => {
    const fake = world();
    const done = await check(fake, inputOf());
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value).toMatchObject({ stage: 'merged', ref: '12', head: HEAD_SHA, summary: `PR 12, merge commit ${MERGE_SHA}` });
    expect(done.value.head).not.toBe(MERGE_SHA);
  });

  it('reads the repo from the URL of the project and the base from the default branch of the project', async () => {
    const fake = world();
    await check(fake, inputOf());
    expect(ghCalls(fake)).toHaveLength(1);
    expect(ghCalls(fake)[0]?.args).toContain('github.com/acme/web');
    expect(fake.calls.filter((call) => call.command === 'git')).toEqual([]);
  });

  it('takes the base from the remote head of the clone when the project names no default branch', async () => {
    const fake = world(goodPr(), { originHead: 'origin/main' });
    const done = await check(fake, inputOf({ project: { id: 'web', path: 'web', url: PROJECT.url } }));
    expect(done.ok).toBe(true);
    expect(ghCalls(fake)).toHaveLength(1);
  });

  it('tests the head branch only when the item gives branches', async () => {
    const other = goodPr({ headRefName: 'worker/beta' });
    expect(exitCodeOf[errorOf(await check(world(other), inputOf())).kind]).toBe(1);
    expect((await check(world(other), inputOf({ branches: undefined }))).ok).toBe(true);
  });

  it('passes a PR from any one of the branches that the item gives, and refuses a PR from another branch', async () => {
    const branches = ['worker/alpha', 'worker/beta'];
    expect((await check(world(goodPr({ headRefName: 'worker/beta' })), inputOf({ branches }))).ok).toBe(true);
    expect(exitCodeOf[errorOf(await check(world(goodPr({ headRefName: 'worker/gamma' })), inputOf({ branches }))).kind]).toBe(1);
  });

  it('refuses every PR when the list of branches is empty, so an empty list never lets a PR pass', async () => {
    expect(exitCodeOf[errorOf(await check(world(), inputOf({ branches: [] }))).kind]).toBe(1);
  });

  it.each([
    ['a PR that is not merged', goodPr({ state: 'OPEN', mergedAt: null, mergeCommit: null })],
    ['another PR number', goodPr({ number: 13 })],
    ['another base branch', goodPr({ baseRefName: 'release' })],
    ['a PR from another repo', goodPr({ isCrossRepository: true })],
  ])('refuses %s with exit 1', async (_name, pr) => {
    expect(exitCodeOf[errorOf(await check(world(pr), inputOf())).kind]).toBe(1);
  });
});

describe('the software record check: the faults that stop before gh runs', () => {
  it.each(['0', '012', 'abc'])('refuses the reference %j with exit 2 and calls neither gh nor git', async (ref) => {
    const fake = world();
    expect(exitCodeOf[errorOf(await check(fake, inputOf({ ref }))).kind]).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['a project URL that is not on GitHub', { ...PROJECT, url: 'https://gitlab.com/acme/web.git' }],
    ['a project with no URL', { id: 'web', path: 'web', default_branch: 'main' }],
  ])('refuses %s with exit 1 and calls neither gh nor git', async (_name, project) => {
    const fake = world();
    expect(exitCodeOf[errorOf(await check(fake, inputOf({ project }))).kind]).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['the clone gives no branch', {}],
    ['the clone gives only its current branch', { currentBranch: 'main' }],
  ])('refuses a project with no default branch when %s for the remote head, with exit 1, the remedy and no gh', async (_name, clone) => {
    const fake = world(goodPr(), clone);
    const error = errorOf(await check(fake, inputOf({ project: { id: 'web', path: 'web', url: PROJECT.url } })));
    expect(exitCodeOf[error.kind]).toBe(1);
    expect(error.message).toContain('names no default branch');
    expect(error.hint).toContain('default_branch');
    expect(ghCalls(fake)).toEqual([]);
  });
});
