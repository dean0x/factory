import { describe, expect, it } from 'vitest';
import { exitCodeFor, failure, notReady, safetyRefusal, usageError } from '../../src/cli/errors.js';
import type { Command, Given } from '../../src/cli/table.js';
import { ok } from '../../src/core/result.js';
import { guardIds } from '../../src/names.js';
import type { BoardItem } from '../../src/board/contract.js';
import type { CheckedRecord, RecipeHost, WorkFacts, WorkHost } from '../../src/recipes/entry.js';
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
const mergeCommit = 'c'.repeat(40);
const branch = 'work/alpha';
const at = '2030-01-02T03:04:05.678Z';
const privateText = 'PRIVATE_GITHUB_TEXT\nMERGED';
const project = { id: 'web', path: 'web', url: 'https://github.com/acme/web.git', default_branch: 'main', merge_method: 'rebase' };
const openPr: ReadinessPr = {
  number: pr, url: `https://github.com/acme/web/pull/${ref}`, state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: branch, baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergedAt: null, mergeCommit: null,
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
const mergedPr = { ...openPr, state: 'MERGED', mergedAt: at, mergeCommit: { oid: mergeCommit } } as const;
const confirmationOf = ({ state, mergedAt, headRefOid, mergeCommit }: ReadinessPr) =>
  exited(0, JSON.stringify({ state, mergedAt, headRefOid, mergeCommit }));
const ownerProof = { kind: 'record', id: APPROVAL_ID, decider: 'owner' } as const;
const relayedProof = { kind: 'relayed', id: APPROVAL_ID, decider: 'coordinator' } as const;
const args = { head, home: '/factory', project: 'web' };
const boardItem: BoardItem = { id: item, title: 'Private title', status: 'open', track: null, stage: null, record: {} };
const workFacts: WorkFacts = { branches: [branch], project, cloneDir: '/factory/web', openRequests: [], headConflict: null, mode: 'owner' };
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
    project: () => mark('project', ok(project)),
    find: async () => mark('find', ok({ kind: 'found', item: boardItem })),
    facts: async () => mark('facts', ok({ ...workFacts, mode: options.mode ?? workFacts.mode })),
    approval: async () => mark('proof', ok(ownerProof)),
    record: async () => mark('record', ok(recordedWork(true))),
    writeEvent: async () => mark('event', ok('written')),
    ...options.work,
  });
  const host: RecipeHost = {
    registry: recipes,
    locateNode: async () => mark('locate', ok('/factory')),
    loadProject: async () => mark('load', ok(project)),
    openWork: options.open ?? (async () => mark('open', ok(work))),
  };
  const deps = createFakeDeps({ run: (call) => {
    if (call.args[0] === 'api') return mark('compare', exited(0, '{"behind_by":0}'));
    if (call.args[1] === 'merge') return mark('merge', options.merge?.(call) ?? exited(0));
    if (call.args.includes('state,mergedAt,headRefOid,mergeCommit')) return mark('confirm', options.confirm?.(call) ?? confirmationOf(mergedPr));
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

const beforeProof = ['open', 'caller', 'project', 'view', 'compare', 'find', 'facts'];
const eventName = `merge-${ref}-${head}.json`;
const ownerRecordLine = 'Proof: owner record. Decider: owner.';
const prRulesOffLine = 'The guard pr-rules is off. The check did not test the base branch.';

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

  it.each([
    [['merge'], 'factory pr merge needs exactly one PR number'],
    [['merge', ref, 'extra'], 'factory pr merge needs exactly one PR number'],
    [['merge', '01'], 'PR number: must be a whole number of one to nine digits, with no leading zero'],
  ] as const)('refuses invalid PR arguments before any work: %j', async (words, message) => {
    const world = setup();
    const result = await world.run(args, words);
    expect(result).toEqual(usageError(message, 'Run "factory pr --help".'));
    expect(result.ok ? result.value.exitCode : exitCodeFor(result.error)).toBe(2);
    expect(world.log).toEqual([]);
    expect(world.ghCalls).toEqual([]);
  });

  it('opens work before the caller check and binds the item before the proof read', async () => {
    const world = setup();
    const result = await output(world.run);
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/^MERGED AND RECORDED\b/);
    expect(world.log).toEqual([...beforeProof, 'proof', 'merge', 'confirm', 'record', 'event']);
    expect(world.calls).toContainEqual(['approval', { item, point, ref, head }]);
    expect(world.calls).toContainEqual(['record', { item, ref, head, project: project.id }]);
    expect(world.ghCalls[2]?.args).toEqual(['pr', 'merge', '--repo', 'github.com/acme/web', '--match-head-commit', head, '--rebase', '--', ref]);
    expect(world.ghCalls).toHaveLength(4);
  });

  it.each([ownerProof, relayedProof])('names $kind proof and $decider in the text, JSON and event', async (proof) => {
    const world = setup({ work: { approval: async () => ok(proof) } });
    const result = await output(world.run);
    expect(result.text).toContain(proof.kind === 'record' ? 'owner record' : 'relayed by the coordinator');
    if (proof.kind === 'relayed') expect(result.text).toContain('no owner proof');
    expect(result.json).toMatchObject({ schema: 'factory.pr-merge/v1', result: 'merged', pr, head, proof: proof.kind, decider: proof.decider });
    expect(world.calls.at(-1)).toEqual(['writeEvent', { name: eventName, fields: {
      schema: 'factory.merge-event/v1', kind: 'merge', item, pr, head, merge_commit: mergeCommit,
      proof: proof.kind, request: proof.id, decider: proof.decider, at,
    } }]);
  });

  it('writes a null merge commit when GitHub gives none', async () => {
    const world = setup({ confirm: () => confirmationOf({ ...mergedPr, mergeCommit: null }), work: { guards: { 'pr-rules': 'off' } } });
    expect(await output(world.run)).toMatchObject({ exitCode: 0 });
    expect(world.calls.at(-1)).toMatchObject(['writeEvent', { name: eventName, fields: { head, merge_commit: null } }]);
    expect(world.ghCalls).toHaveLength(4);
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
    const world = setup({ work: { project: () => usageError('the project does not exist') } });
    expect(await world.run()).toMatchObject({ ok: false, error: { kind: 'usage', message: 'the project does not exist' } });
    expect(world.log).toEqual(['open', 'caller']);
  });

  it('refuses an invalid project merge method before the merge call', async () => {
    const world = setup({ work: { facts: async () => ok({ ...workFacts, project: { ...project, merge_method: 'fast-forward' } }) } });
    const result = await world.run();
    expect(result).toEqual(failure('The project merge method is invalid.', 'Check the node and project with factory doctor. Run check again.'));
    expect(result.ok ? result.value.exitCode : exitCodeFor(result.error)).toBe(1);
    expect(world.ghCalls.map(({ args: call }) => call.slice(0, 2))).toEqual([['pr', 'view'], ['api', '--hostname']]);
  });

  it('treats missing gh on the first read as unreadable, without a probe', async () => {
    const world = setup({ read: () => missingProgram('gh') });
    expect(await output(world.run)).toMatchObject({ exitCode: 1, text: expect.stringMatching(/^UNREADABLE\n.*PR facts/) });
    expect(world.log).toEqual(beforeProof.slice(0, 4));
    expect(world.ghCalls).toHaveLength(1);
  });

  it('refuses a missing item with exit 1', async () => {
    const world = setup({ work: { find: async () => ok({ kind: 'lookup', cause: 'no item matches the reference or head branch' }) } });
    expect(await output(world.run)).toMatchObject({ exitCode: 1, text: expect.stringContaining('no item matches the reference or head branch') });
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find']);
  });

  it('refuses a moved head before proof or merge', async () => {
    const world = setup({ view: { headRefOid: moved } });
    expect(await output(world.run)).toMatchObject({ exitCode: 3, text: expect.stringMatching(/^HEAD MOVED\n/) });
    expect(world.log).toEqual(beforeProof.slice(0, 4));
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
    expect(world.calls).toEqual([['project', project.id]]);
  });

  it('names the absent proof and the non-proof sources before any merge', async () => {
    const world = setup({ work: { approval: async () => failure('there is no linked approval request', 'Use factory request add.') } });
    expect(await world.run()).toMatchObject({ ok: false, error: {
      kind: 'failure', message: expect.stringContaining('no linked approval request'), hint: expect.stringContaining('factory request add'),
    } });
    expect(world.log).toEqual(beforeProof);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find', 'facts', 'approval']);
  });

  it.each([
    { mode: 'delegated', admin: false, reason: 'Delegated proofs are not built' },
    { mode: 'owner', admin: true, reason: 'The PR and head need an owner store decision to go.' },
  ] as const)('refuses a relay in $mode mode with admin set to $admin', async ({ mode, admin, reason }) => {
    const world = setup({ mode, work: { approval: async () => ok(relayedProof) } });
    expect(await world.run({ ...args, admin })).toMatchObject({ ok: false, error: {
      kind: 'failure', message: expect.stringContaining(reason), hint: expect.stringContaining('factory decide'),
    } });
    expect(world.ghCalls.map(({ args: call }) => call[0])).toEqual(['pr', 'api']);
  });

  it('accepts an owner store decision in delegated mode', async () => {
    const world = setup({ mode: 'delegated' });
    expect(await output(world.run)).toMatchObject({ exitCode: 0 });
    expect(world.log).toContain('proof');
  });

  it.each([{}, { 'admin-merge': 'off' }] as const)('passes admin only when given with %j', async (guards) => {
    const normal = setup({ work: { guards } });
    await output(normal.run);
    expect(normal.ghCalls[2]?.args).not.toContain('--admin');
    const admin = setup({ work: { guards } });
    expect(await output(admin.run, { ...args, admin: true })).toMatchObject({ exitCode: 0 });
    expect(admin.ghCalls[2]?.args.filter((word) => word === '--admin')).toEqual(['--admin']);
    expect(admin.calls).toContainEqual(['approval', APPROVAL_LINK]);
  });

  it('requires an owner record for admin even when both approval guards are off', async () => {
    const world = setup({ work: { guards: { 'approval-merge': 'off', 'owner-go': 'off' } } });
    const result = await output(world.run, { ...args, admin: true });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain('The guard owner-go is off');
    expect(result.text).toContain('The guard approval-merge is off');
    expect(world.calls).toContainEqual(['approval', APPROVAL_LINK]);
  });

  it('names the untested base branch when only pr-rules is off', async () => {
    const world = setup({ work: { guards: { 'pr-rules': 'off' } } });
    const result = await output(world.run);
    expect(result.exitCode).toBe(0);
    expect(result.lines.map(({ text }) => text)).toEqual(['MERGED AND RECORDED', ownerRecordLine, prRulesOffLine]);
    expect(result.json).toMatchObject({ offLines: [prRulesOffLine] });
  });

  it.each([
    ['timeout', () => failure('time limit'), () => confirmationOf(mergedPr), 0, 1,
      ['MERGED AND RECORDED', ownerRecordLine]],
    ['no start', () => missingProgram('gh'), () => confirmationOf(openPr), 1, 3,
      ['NOT MERGED', 'The merge call failed. Check the PR state before any new merge call.'], true],
    ['non-zero', () => exited(1, privateText, privateText), () => confirmationOf(openPr), 1, 3,
      ['NOT MERGED', 'The merge call failed. Check the PR state before any new merge call.'], true],
    ['a head change', () => exited(1, privateText), () => confirmationOf({ ...openPr, headRefOid: moved }), 3, 1,
      ['HEAD MOVED', 'the PR head does not match the pin', 'Check the new head. Run check again.']],
    ['an unreadable view', () => exited(1), () => exited(0, privateText), 1, 3,
      ['UNKNOWN', 'Check the PR state before any new merge call.']],
    ['exit 0', () => exited(0), () => confirmationOf(openPr), 1, 3,
      ['NOT MERGED', `If GitHub merges the PR, run "factory item record ${item} --ref ${ref}".`], false],
  ] as const)('reports the confirmed state without a second merge call after %s', async (_case, merge, confirm, exitCode, reads, lines, callFailed?: boolean) => {
    const world = setup({ merge, confirm });
    const result = await output(world.run);
    expect(result.exitCode).toBe(exitCode);
    expect(result.lines.map(({ text }) => text)).toEqual(lines);
    if (callFailed !== undefined) expect(result.json).toMatchObject({ callFailed });
    expect(result.text).not.toContain('PRIVATE_GITHUB_TEXT');
    expect(JSON.stringify(result.json)).not.toContain('PRIVATE_GITHUB_TEXT');
    expect(world.log.filter((step) => step === 'merge')).toHaveLength(1);
    expect(world.log.filter((step) => step === 'confirm')).toHaveLength(reads);
    expect(world.log.includes('record')).toBe(exitCode === 0);
    expect(world.log.includes('event')).toBe(exitCode === 0);
  });

  it.each([
    { record: failure(privateText), exitCode: 1 },
    { record: safetyRefusal(privateText, privateText), exitCode: 4 },
  ])('keeps exit $exitCode and the record remedy when the record refuses', async ({ record, exitCode }) => {
    const world = setup({ work: { record: async () => record } });
    expect(await output(world.run)).toMatchObject({
      exitCode, text: `MERGED NOT RECORDED\nRun "factory item record ${item} --ref ${ref}".\n`,
    });
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find', 'facts', 'approval', 'record']);
  });

  it('keeps the proof stop when a rerun cannot record the merge', async () => {
    const world = setup({ view: mergedPr, work: {
      approval: async () => safetyRefusal(privateText, privateText), record: async () => failure(privateText),
    } });
    expect(await output(world.run)).toMatchObject({
      exitCode: 4, text: `MERGED NOT RECORDED\nRun "factory item record ${item} --ref ${ref}".\n`,
    });
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find', 'facts', 'approval', 'record']);
    expect(world.ghCalls.map(({ args: call }) => call[1])).toEqual(['view']);
  });

  it('repairs a missing record and event with the proof of the rerun and no merge call', async () => {
    const world = setup({ view: mergedPr, work: { approval: async () => ok(relayedProof) } });
    expect(await output(world.run)).toMatchObject({ exitCode: 0, text: expect.stringContaining('relayed by the coordinator') });
    expect(world.log).toEqual(['open', 'caller', 'project', 'view', 'find', 'facts', 'record', 'event']);
    expect(world.calls.at(-1)).toMatchObject(['writeEvent', { name: eventName, fields: {
      head, merge_commit: mergeCommit, proof: 'relayed', decider: 'coordinator',
    } }]);
    expect(world.ghCalls.map(({ args: call }) => call[1])).toEqual(['view']);
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

  it('records a rerun and writes no event when its proof read stops', async () => {
    const world = setup({ view: mergedPr, work: { approval: async () => safetyRefusal(privateText, privateText) } });
    expect(await output(world.run)).toMatchObject({
      exitCode: 4, text: 'MERGED AND RECORDED\nNo event file: the proof read refused.\n',
    });
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find', 'facts', 'approval', 'record']);
    expect(world.ghCalls.map(({ args: call }) => call[1])).toEqual(['view']);
  });

  it('names an outbox stop after the merged and recorded verdict', async () => {
    const world = setup({ work: { writeEvent: async () => safetyRefusal('the outbox is a link', 'Remove the link.') } });
    const result = await output(world.run);
    expect(result.exitCode).toBe(4);
    expect(result.text.split('\n').slice(0, 2)).toEqual(['MERGED AND RECORDED', 'Event file stop: the outbox is a link']);
    expect(world.calls.map(([step]) => step)).toEqual(['caller', 'project', 'find', 'facts', 'approval', 'record', 'writeEvent']);
  });

  it('reports an ordinary event failure as a warning after the record', async () => {
    const world = setup({ work: { writeEvent: async () => failure('no space left') } });
    expect(await output(world.run)).toMatchObject({ exitCode: 0, warnings: [expect.stringContaining('event file')] });
  });

  it.each(['find', 'facts'] as const)('keeps exit 4 in check and merge when %s stops', async (step) => {
    const world = setup({ work: { [step]: async () => safetyRefusal(privateText, privateText) } });
    const lines = ['UNREADABLE', 'could not read the work item or its requests', 'Check the board and its request links. Run check again.'];
    expect(await world.check()).toMatchObject({ ok: true, value: { exitCode: 4, lines: lines.map((text) => ({ text })) } });
    expect(await output(world.run)).toMatchObject({ exitCode: 4, text: `${lines.join('\n')}\n` });
    expect(world.ghCalls.map(({ args: call }) => call[0])).toEqual(['pr', 'api', 'pr', 'api']);
  });

  it('reports a fixed unreadable result when check cannot open the node', async () => {
    const world = setup({ open: async () => failure(privateText, privateText) });
    expect(await world.check()).toMatchObject({ ok: true, value: { exitCode: 1, lines: [
      { text: 'UNREADABLE' }, { text: 'could not read the node or its project' },
      { text: 'Check the node and project with factory doctor. Run check again.' },
    ] } });
    expect(world.ghCalls).toEqual([]);
  });

  it.each([
    { project: failure(privateText), exitCode: 1 },
    { project: safetyRefusal(privateText, privateText), exitCode: 4 },
  ])('keeps exit $exitCode when check cannot select the project', async ({ project: fault, exitCode }) => {
    const world = setup({ work: { project: () => fault } });
    expect(await world.check()).toMatchObject({ ok: true, value: { exitCode, lines: [
      { text: 'UNREADABLE' }, { text: 'could not read the node or its project' },
      { text: 'Check the node and project with factory doctor. Run check again.' },
    ] } });
    expect(world.ghCalls).toEqual([]);
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
