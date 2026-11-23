import { describe, expect, it } from 'vitest';
import { failure, notReady, safetyRefusal, usageError } from '../../src/cli/errors.js';
import type { Command, Given } from '../../src/cli/table.js';
import { ok } from '../../src/core/result.js';
import { guardIds } from '../../src/names.js';
import type { BoardItem } from '../../src/board/contract.js';
import type { CheckedRecord, RecipeHost, WorkHost } from '../../src/recipes/entry.js';
import { recipes } from '../../src/recipes/index.js';
import { checkCommandFor } from '../../src/recipes/software/check.js';
import { proofNeedOf } from '../../src/recipes/software/pr-merge.js';
import type { ReadinessPr } from '../../src/recipes/software/merge-ready.js';
import { prCommandFor } from '../../src/recipes/software/pr-command.js';
import { APPROVAL_ID, APPROVAL_LINK } from '../helpers/approval-go.js';
import { createFakeDeps, exited, missingProgram, type RunHandler } from '../helpers/fake-deps.js';
import { budgetRow, tokensOf } from '../helpers/token-budget.js';
import { fakeWorkHost } from '../helpers/work-host.js';

const { item, ref, head, point } = APPROVAL_LINK;
const pr = Number(ref);
const moved = 'b'.repeat(40);
const branch = 'work/alpha';
const at = '2030-01-02T03:04:05.678Z';
const privateText = 'PRIVATE_GITHUB_TEXT\nMERGED';
const project = { id: 'web', path: 'web', url: 'https://github.com/acme/web.git', default_branch: 'main', merge_method: 'rebase' };
const openPr: ReadinessPr = {
  number: pr, url: `https://github.com/acme/web/pull/${ref}`, state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: branch, baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergedAt: null,
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
const mergedPr = { ...openPr, state: 'MERGED', mergedAt: at } as const;
const confirmationOf = ({ state, mergedAt, headRefOid }: ReadinessPr) => exited(0, JSON.stringify({ state, mergedAt, headRefOid }));
const ownerProof = { kind: 'record', id: APPROVAL_ID, decider: 'owner' } as const;
const relayedProof = { kind: 'relayed', id: APPROVAL_ID, decider: 'coordinator' } as const;
const args = { head, home: '/factory', project: 'web' };
const boardItem: BoardItem = { id: item, title: 'Private title', status: 'open', track: null, stage: null, record: {} };
const checked = { head, stage: 'merged', ref, summary: 'PR at the pin' } as CheckedRecord;
const recordedWork = (changed: boolean) => ({ checked, recorded: { item: boardItem, changed }, offGuards: [] });
const givenOf = (words: readonly string[], flags: Readonly<Record<string, string | boolean>>): Given => ({
  positionals: () => words,
  afterTerminator: () => [],
  bool: (name) => flags[name] === true,
  string: (name) => typeof flags[name] === 'string' ? flags[name] : undefined,
  strings: () => [],
});

interface Setup {
  readonly view?: Partial<ReadinessPr>;
  readonly mode?: 'owner' | 'delegated';
  readonly work?: Partial<WorkHost>;
  readonly project?: RecipeHost['loadProject'];
  readonly open?: RecipeHost['openWork'];
  readonly merge?: RunHandler;
  readonly confirm?: RunHandler;
  readonly read?: RunHandler;
}

const setup = (options: Setup = {}) => {
  const log: string[] = [];
  const mark = <T>(step: string, result: T): T => { log.push(step); return result; };
  const { work, calls } = fakeWorkHost({
    caller: async () => mark('caller', ok(undefined)),
    find: async () => mark('find', ok({ kind: 'found', item: boardItem })),
    facts: async () => mark('facts', ok({ branches: [branch], project, cloneDir: '/factory/web', openRequests: [], headConflict: null, mode: options.mode ?? 'owner' })),
    approval: async ({ need }) => mark(`proof:${need}`, ok(ownerProof)),
    record: async () => mark('record', ok(recordedWork(true))),
    writeEvent: async () => mark('event', ok('written')),
    ...options.work,
  });
  const host: RecipeHost = {
    registry: recipes,
    locateNode: async () => mark('locate', ok('/factory')),
    loadProject: options.project ?? (async () => mark('project', ok(project))),
    openWork: options.open ?? (async () => mark('open', ok(work))),
  };
  const deps = createFakeDeps({ run: (call) => {
    if (call.args[0] === 'api') return mark('compare', exited(0, '{"behind_by":0}'));
    if (call.args[1] === 'merge') return mark('merge', options.merge?.(call) ?? exited(0));
    if (call.args.includes('state,mergedAt,headRefOid')) return mark('confirm', options.confirm?.(call) ?? confirmationOf(mergedPr));
    return mark('view', options.read?.(call) ?? exited(0, JSON.stringify({ ...openPr, ...options.view })));
  } });
  const command: Command = prCommandFor(host);
  const run = (flags: Readonly<Record<string, string | boolean>> = args, words: readonly string[] = ['merge', ref]) => command.run(givenOf(words, flags), deps);
  const check = () => checkCommandFor(host).run(givenOf([ref], args), deps);
  return { run, check, calls, log, ghCalls: deps.calls, command };
};

const output = async (run: ReturnType<typeof setup>['run'], flags?: Readonly<Record<string, string | boolean>>) => {
  const result = await run(flags);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return { ...result.value, text: result.value.lines.map(({ text }) => `${text}\n`).join('') };
};

const beforeProof = ['open', 'caller', 'locate', 'project', 'view', 'compare', 'find', 'facts'];
const eventName = `merge-${ref}-${head}.json`;

const proofRows = [
  { owner: true, pointOn: true, mode: 'owner', regular: 'go' },
  { owner: true, pointOn: true, mode: 'delegated', regular: 'owner-record' },
  { owner: true, pointOn: false, mode: 'owner', regular: 'none' },
  { owner: true, pointOn: false, mode: 'delegated', regular: 'none' },
  { owner: false, pointOn: true, mode: 'owner', regular: 'none' },
  { owner: false, pointOn: true, mode: 'delegated', regular: 'none' },
  { owner: false, pointOn: false, mode: 'owner', regular: 'none' },
  { owner: false, pointOn: false, mode: 'delegated', regular: 'none' },
] as const;
const adminRows = [{ admin: false, adminOn: true }, { admin: false, adminOn: false },
  { admin: true, adminOn: true }, { admin: true, adminOn: false }] as const;

it.each(proofRows.flatMap((row) => adminRows.map((adminRow) => ({ ...row, ...adminRow }))))(
  'uses the expected proof and off lines for %j', ({ owner, pointOn, mode, regular, admin, adminOn }) => {
    const policy = proofNeedOf({ 'owner-go': owner ? 'on' : 'off', 'approval-merge': pointOn ? 'on' : 'off',
      'admin-merge': adminOn ? 'on' : 'off' }, mode, admin);
    expect(policy.need).toBe(admin && adminOn ? 'owner-record' : regular);
    expect(policy.offLines.map((line) => line.split('. ')[0])).toEqual([
      ...(owner ? [] : ['The guard owner-go is off']),
      ...(pointOn ? [] : ['The guard approval-merge is off']),
      ...(admin && !adminOn ? ['The guard admin-merge is off'] : []),
    ]);
  },
);

describe('pr merge', () => {
  it.each<Readonly<Record<string, string | boolean>>>([{ home: args.home }, { ...args, head: head.slice(0, 7) }, { ...args, head: head.toUpperCase() }])(
    'requires a full lowercase head before any work: %j', async (flags) => {
      const world = setup();
      expect(await world.run(flags)).toMatchObject({ ok: false, error: { kind: 'usage', message: expect.stringContaining('40 lowercase hex digits') } });
      expect(world.log).toEqual([]);
      expect(world.ghCalls).toEqual([]);
    },
  );

  it('opens work before the caller check and binds the item before the proof read', async () => {
    const world = setup();
    const result = await output(world.run);
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^MERGED AND RECORDED\b/);
    expect(world.log).toEqual([...beforeProof, 'proof:go', 'merge', 'confirm', 'record', 'event']);
    expect(world.calls).toContainEqual(['approval', { item, point, ref, head, need: 'go' }]);
    expect(world.calls).toContainEqual(['record', { item, ref, head, project: project.id }]);
    expect(world.ghCalls[2]?.args).toEqual(['pr', 'merge', '--repo', 'github.com/acme/web', '--match-head-commit', head, '--rebase', '--', ref]);
  });

  it.each([ownerProof, relayedProof])('names $kind proof and $decider in the text, JSON and event', async (proof) => {
    const world = setup({ work: { approval: async () => ok(proof) } });
    const result = await output(world.run);
    expect(result.text).toContain(proof.kind === 'record' ? 'owner record' : 'relayed by the coordinator');
    if (proof.kind === 'relayed') expect(result.text).toContain('no owner proof');
    expect(result.json).toMatchObject({ schema: 'factory.pr-merge/v1', result: 'merged', pr, head, proof: proof.kind, decider: proof.decider });
    expect(world.calls.at(-1)).toEqual(['writeEvent', { name: eventName, fields: {
      schema: 'factory.merge-event/v1', kind: 'merge', item, pr, head, merge_commit: null,
      proof: proof.kind, request: proof.id, decider: proof.decider, at,
    } }]);
  });

  it.each([
    [usageError('caller refusal', 'Use the coordinator pane.'), 'usage'],
    [notReady('caller refusal', 'Use the coordinator pane.'), 'not-ready'],
    [safetyRefusal('caller refusal', 'Use a terminal window.'), 'safety'],
  ])('preserves a caller refusal and runs no external command', async (refusal, kind) => {
    const world = setup({ work: { caller: async () => refusal } });
    expect(await world.run()).toMatchObject({ ok: false, error: { kind, message: 'caller refusal', hint: expect.stringContaining('Use') } });
    expect(world.log).toEqual(['open']);
    expect(world.calls).toEqual([['caller']]);
    expect(world.ghCalls).toEqual([]);
  });

  it('stops when work cannot open', async () => {
    const world = setup({ open: async () => failure('could not open work') });
    expect(await world.run()).toMatchObject({ ok: false, error: { message: 'could not open work' } });
    expect(world.log).toEqual([]);
  });

  it('stops when the project cannot load', async () => {
    const world = setup({ project: async () => usageError('the project does not exist') });
    expect(await world.run()).toMatchObject({ ok: false, error: { kind: 'usage', message: 'the project does not exist' } });
    expect(world.log).toEqual(['open', 'caller', 'locate']);
  });

  it('treats missing gh on the first read as unreadable, without a probe', async () => {
    const world = setup({ read: () => missingProgram('gh') });
    expect(await output(world.run)).toMatchObject({ exitCode: 1, text: expect.stringMatching(/^UNREADABLE\n.*PR facts/) });
    expect(world.log).toEqual(beforeProof.slice(0, 5));
    expect(world.ghCalls).toHaveLength(1);
  });

  it('refuses a missing item with exit 1', async () => {
    const world = setup({ work: { find: async () => ok({ kind: 'lookup', cause: 'no item matches the reference or head branch' }) } });
    expect(await output(world.run)).toMatchObject({ exitCode: 1, text: expect.stringContaining('no item matches the reference or head branch') });
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'find']);
  });

  it('refuses a moved head before proof or merge', async () => {
    const world = setup({ view: { headRefOid: moved } });
    expect(await output(world.run)).toMatchObject({ exitCode: 3, text: expect.stringMatching(/^HEAD MOVED\n/) });
    expect(world.log).toEqual(beforeProof.slice(0, 5));
  });

  it.each([
    [{ number: pr + 1 }, 'gh gave another PR'],
    [{ url: `https://github.com/acme/other/pull/${ref}` }, 'the PR is not in this repo'],
    [{ isCrossRepository: true }, 'the PR comes from another repo'],
  ] as const)('checks PR identity with all guards off: %j', async (view, reason) => {
    const guards = { [guardIds.sessionChecks]: 'off', [guardIds.ownerGo]: 'off', 'approval-merge': 'off', 'admin-merge': 'off', 'pr-rules': 'off' } as const;
    const world = setup({ view, work: { guards } });
    expect(await output(world.run)).toMatchObject({ exitCode: 3, text: expect.stringContaining(reason) });
    expect(world.ghCalls).toHaveLength(1);
    expect(world.calls).toEqual([]);
  });

  it('names the absent proof and the non-proof sources before any merge', async () => {
    const world = setup({ work: { approval: async () => failure('there is no linked approval request', 'Use factory request add.') } });
    expect(await world.run()).toMatchObject({ ok: false, error: {
      kind: 'failure', message: expect.stringContaining('no linked approval request'), hint: expect.stringContaining('factory request add'),
    } });
    expect(world.log).toEqual(beforeProof);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'find', 'facts', 'approval']);
  });

  it('requires an owner store decision in delegated mode and names the absent proofs', async () => {
    const world = setup({ mode: 'delegated', work: { approval: async () => failure('this reference and head need an owner store decision') } });
    expect(await world.run()).toMatchObject({ ok: false, error: {
      kind: 'failure', message: expect.stringContaining('Delegated proofs are not built'),
    } });
    expect(world.calls.at(-1)).toEqual(['approval', { item, point, ref, head, need: 'owner-record' }]);
    expect(world.ghCalls).toHaveLength(2);
  });

  it('accepts an owner store decision in delegated mode', async () => {
    const world = setup({ mode: 'delegated' });
    expect(await output(world.run)).toMatchObject({ exitCode: 0 });
    expect(world.log).toContain('proof:owner-record');
  });

  it.each([{}, { 'admin-merge': 'off' }] as const)('passes admin only when given with %j', async (guards) => {
    const normal = setup({ work: { guards } });
    await output(normal.run);
    expect(normal.ghCalls[2]?.args).not.toContain('--admin');
    const admin = setup({ work: { guards } });
    expect(await output(admin.run, { ...args, admin: true })).toMatchObject({ exitCode: 0 });
    expect(admin.ghCalls[2]?.args.filter((word) => word === '--admin')).toEqual(['--admin']);
    expect(admin.calls).toContainEqual(['approval', { ...APPROVAL_LINK, need: guards['admin-merge'] === 'off' ? 'go' : 'owner-record' }]);
  });

  it('requires an owner record for admin even when both approval guards are off', async () => {
    const world = setup({ work: { guards: { 'approval-merge': 'off', 'owner-go': 'off' } } });
    const result = await output(world.run, { ...args, admin: true });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('The guard owner-go is off');
    expect(result.text).toContain('The guard approval-merge is off');
    expect(world.calls).toContainEqual(['approval', { ...APPROVAL_LINK, need: 'owner-record' }]);
  });

  it.each([
    ['timeout', () => failure('time limit'), () => confirmationOf(mergedPr), 'MERGED AND RECORDED', 0, 1],
    ['no start', () => missingProgram('gh'), () => confirmationOf(openPr), 'NOT MERGED', 1, 3],
    ['non-zero', () => exited(1, privateText), () => confirmationOf({ ...openPr, headRefOid: moved }), 'HEAD MOVED', 3, 1],
    ['unreadable', () => exited(1), () => exited(0, privateText), 'UNKNOWN', 1, 3],
    ['exit 0', () => exited(0), () => confirmationOf(openPr), 'NOT MERGED', 1, 3],
  ] as const)('never repeats the merge call after %s', async (_case, merge, confirm, verdict, exitCode, reads) => {
    const world = setup({ merge, confirm, work: { guards: { 'pr-rules': 'off' } } });
    const result = await output(world.run);
    expect(result.exitCode).toBe(exitCode);
    expect(result.text.split('\n')[0]).toBe(verdict);
    expect(result.text).not.toContain(privateText);
    expect(world.log.filter((step) => step === 'merge')).toHaveLength(1);
    expect(world.log.filter((step) => step === 'confirm')).toHaveLength(reads);
    expect(world.log.includes('record')).toBe(exitCode === 0);
    expect(world.log.includes('event')).toBe(exitCode === 0);
  });

  it('gives the record remedy and writes no event when the record refuses', async () => {
    const world = setup({ work: { record: async () => failure('the locked record refused') } });
    const result = await output(world.run);
    expect(result).toMatchObject({ exitCode: 1, text: expect.stringMatching(/^MERGED NOT RECORDED\n/) });
    expect(result.text).toContain(`factory item record ${item} --ref ${ref}`);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'find', 'facts', 'approval', 'record']);
  });

  it('repairs a missing record and event with the proof of the rerun and no merge call', async () => {
    const world = setup({ view: mergedPr, work: { approval: async () => ok(relayedProof) } });
    expect(await output(world.run)).toMatchObject({ exitCode: 0, text: expect.stringContaining('relayed by the coordinator') });
    expect(world.log).toEqual(['open', 'caller', 'locate', 'project', 'view', 'find', 'facts', 'record', 'event']);
    expect(world.calls.at(-1)).toMatchObject(['writeEvent', { name: eventName, fields: { proof: 'relayed', decider: 'coordinator' } }]);
  });

  it('writes the first event only after a rerun repairs the failed record', async () => {
    let merged = false;
    let records = 0;
    const world = setup({
      merge: () => { merged = true; return exited(0); },
      read: () => exited(0, JSON.stringify(merged ? mergedPr : openPr)),
      work: { record: async () => ++records === 1 ? failure('the record refused') : ok(recordedWork(true)) },
    });
    expect(await output(world.run)).toMatchObject({ exitCode: 1, text: expect.stringMatching(/^MERGED NOT RECORDED\n/) });
    expect(world.calls.filter(([step]) => step === 'writeEvent')).toEqual([]);
    expect(await output(world.run)).toMatchObject({ exitCode: 0, text: expect.stringMatching(/^MERGED AND RECORDED\n/) });
    expect(world.calls.filter(([step]) => step === 'writeEvent')).toHaveLength(1);
    expect(world.ghCalls.filter(({ args: call }) => call[1] === 'merge')).toHaveLength(1);
  });

  it('records a rerun and writes no event when its proof read refuses', async () => {
    const world = setup({ view: mergedPr, work: { approval: async () => failure('no proof') } });
    const result = await output(world.run);
    expect(result).toMatchObject({ exitCode: 0, text: expect.stringContaining('No event file') });
    expect(result.text.split('\n').filter((line) => line.includes('No event file'))).toHaveLength(1);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'find', 'facts', 'approval', 'record']);
    expect(world.ghCalls).toHaveLength(1);
  });

  it('names an outbox stop after the merged and recorded verdict', async () => {
    const world = setup({ work: { writeEvent: async () => safetyRefusal('the outbox is a link', 'Remove the link.') } });
    const result = await output(world.run);
    expect(result.exitCode).toBe(4);
    expect(result.text.split('\n').slice(0, 2)).toEqual(['MERGED AND RECORDED', 'Event file stop: the outbox is a link']);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'find', 'facts', 'approval', 'record', 'writeEvent']);
  });

  it('reports an ordinary event failure as a warning after the record', async () => {
    const world = setup({ work: { writeEvent: async () => failure('no space left') } });
    expect(await output(world.run)).toMatchObject({ exitCode: 0, warnings: [expect.stringContaining('event file')] });
  });

  it('keeps the check and merge output within the token budget', async () => {
    const world = setup();
    const check = await world.check();
    expect(check).toMatchObject({ ok: true, value: { exitCode: 0, lines: [{ text: 'READY' }] } });
    if (!check.ok) throw new Error(check.error.message);
    const merge = await output(world.run);
    expect(merge.exitCode).toBe(0);
    const checkText = check.value.lines.map(({ text }) => `${text}\n`).join('');
    const tokens = tokensOf(checkText + merge.text);
    const { budget, measured } = budgetRow(1);
    expect(tokens).toBeLessThan(budget);
    expect(tokens).toBe(measured);
  });
});
