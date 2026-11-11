import { describe, expect, it } from 'vitest';
import { ok } from '../../src/core/result.js';
import {
  acceptReason,
  checkRootSetup,
  checkSetupSet,
  mayAsk,
  notListedStop,
  settleSetup,
  type SetupCheck,
} from '../../src/commands/setup-check.js';
import { collectSetup } from '../../src/commands/init-received.js';
import { commands, env, maxSetupTextBytes, trackedFiles } from '../../src/names.js';
import { createFakeDeps, withFailingRemoves, withFailingWrites, type FakeDeps, type PromptHandler } from '../helpers/fake-deps.js';
import { gitHandler } from '../helpers/git-fake.js';
import { ACCEPTANCES, acceptFiles } from '../helpers/setup-acceptance.js';

const HOME = '/w/node';
const NODE = 'demo';
const COORDINATOR = 'setup/coordinator.md';
const WORKER = 'setup/roles/worker.md';
const INIT_REMEDY = 'Run "factory init" in a terminal window and accept the files.';
const CHANGE_REMEDY = 'Run "factory start" or "factory upgrade" in a terminal window outside a factory session.';

interface Setup {
  readonly tracked?: readonly string[];
  readonly noRepo?: boolean;
  readonly tty?: boolean;
  readonly stdoutTty?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly prompt?: PromptHandler;
  readonly links?: Record<string, string>;
}

const make = (setup: Setup = {}): FakeDeps => {
  const git = gitHandler({
    ...(setup.noRepo === true ? {} : { repos: { [HOME]: {} } }),
    tracked: { [HOME]: setup.tracked ?? [] },
  });
  const tty = setup.tty ?? false;
  const deps = createFakeDeps({
    env: { PATH: '/bin', XDG_STATE_HOME: '/state', HOME: '/users/me', ...setup.env },
    run: git.handler,
    stdinIsTTY: tty,
    stdoutIsTTY: setup.stdoutTty ?? tty,
    ...(setup.prompt === undefined ? {} : { prompt: setup.prompt }),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  deps.seedDir(HOME);
  for (const path of setup.tracked ?? []) deps.seed(`${HOME}/${path}`, 'text\n');
  return deps;
};

const own = (deps: FakeDeps, node: string | null = NODE): Promise<SetupCheck> =>
  checkRootSetup(deps, { home: HOME, node, received: false });

const received = (deps: FakeDeps, node: string | null = NODE): Promise<SetupCheck> =>
  checkRootSetup(deps, { home: HOME, node, received: true });

const storeOf = (deps: FakeDeps): string => deps.files.get(ACCEPTANCES) ?? '';

describe('setup check: an own root', () => {
  it('has an empty subject without a setup file, and with files that hold only white space', async () => {
    const deps = make();
    expect(await own(deps)).toEqual({ kind: 'empty' });
    deps.seed(`${HOME}/${COORDINATOR}`, '\n  \n');
    deps.seed(`${HOME}/${WORKER}`, '');
    expect(await own(deps)).toEqual({ kind: 'empty' });
  });

  it('finds no acceptance at all, and names the files and the command that makes the first acceptance', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    deps.seed(`${HOME}/${WORKER}`, 'Worker rules.\n');
    const check = await own(deps);
    expect(check).toMatchObject({ kind: 'unaccepted', stop: { remedy: INIT_REMEDY } });
    expect(check.kind === 'unaccepted' && check.stop.text).toBe(
      `the owner has not accepted the setup text: ${COORDINATOR}, ${WORKER}`,
    );
  });

  it('takes the files as accepted when the node id and the hash match, and gives the texts of the same bytes', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\r\n');
    await acceptFiles(deps, HOME, NODE, [COORDINATOR]);
    const check = await own(deps);
    expect(check.kind).toBe('accepted');
    expect(check.kind === 'accepted' && check.setup.texts).toEqual({ coordinator: 'Rules.\n', worker: null });
  });

  it('finds a change after an older acceptance, names the changed file and the accept command', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    await acceptFiles(deps, HOME, NODE, [COORDINATOR]);
    deps.seed(`${HOME}/${COORDINATOR}`, 'Other rules.\n');
    const check = await own(deps);
    expect(check.kind).toBe('changed');
    expect(check.kind === 'changed' && check.stop).toEqual({
      text: `the setup text changed since the owner accepted it: ${COORDINATOR}`,
      remedy: CHANGE_REMEDY,
    });
  });

  it('finds a change when a file is added or removed', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    await acceptFiles(deps, HOME, NODE, [COORDINATOR]);
    deps.seed(`${HOME}/${WORKER}`, 'Worker rules.\n');
    const added = await own(deps);
    expect(added.kind === 'changed' && added.stop.text).toContain(WORKER);
    await deps.fs.remove(`${HOME}/${WORKER}`);
    await deps.fs.remove(`${HOME}/${COORDINATOR}`);
    deps.seed(`${HOME}/${WORKER}`, 'Worker rules.\n');
    const swapped = await own(deps);
    expect(swapped.kind === 'changed' && swapped.stop.text).toContain(COORDINATOR);
  });

  it('finds a change for an acceptance under another node id, and says so', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    await acceptFiles(deps, HOME, 'other', [COORDINATOR]);
    const check = await own(deps);
    expect(check.kind === 'changed' && check.stop.text).toBe('the owner accepted the setup text for another node id');
  });

  it('is unusable without a node id when a file needs an acceptance, and empty when no file does', async () => {
    const deps = make();
    expect(await own(deps, null)).toEqual({ kind: 'empty' });
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    const check = await own(deps, null);
    expect(check.kind).toBe('unusable');
    expect(check.kind === 'unusable' && check.stop.text).toContain('factory.yaml is not valid');
    expect(check.kind === 'unusable' && check.stop.remedy).toContain('factory doctor');
  });

  it('is unusable when the store of the acceptances cannot be used', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    deps.seed(ACCEPTANCES, 'not json');
    const check = await own(deps);
    expect(check.kind).toBe('unusable');
    expect(check.kind === 'unusable' && check.stop.text).toContain('cannot be used');
  });

  it('keeps the error of a setup file that holds a block marker, and of one over the size bound (exit 1)', async () => {
    const deps = make();
    deps.seed(`${HOME}/${COORDINATOR}`, 'Fine.\n<!-- factory:begin safety v2 sha256=abc -->\n');
    const marker = await own(deps);
    expect(marker.kind === 'unusable' && marker.error).toMatchObject({
      kind: 'failure',
      message: 'setup/coordinator.md holds a line that starts a managed block',
    });
    deps.seed(`${HOME}/${COORDINATOR}`, 'x'.repeat(maxSetupTextBytes + 1));
    const large = await own(deps);
    expect(large.kind === 'unusable' && large.error).toMatchObject({
      kind: 'failure',
      message: `setup/coordinator.md is larger than ${maxSetupTextBytes} bytes`,
    });
  });

  it('stops on a link at a setup file or at the setup folder (exit 4), and reads nothing through it', async () => {
    const links: Record<string, string> = {};
    const deps = make({ links });
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    links[`${HOME}/setup`] = '/elsewhere/setup';
    const check = await own(deps);
    expect(check.kind === 'unusable' && check.error).toMatchObject({ kind: 'safety', message: expect.stringContaining('setup is a link') });
    const file: Record<string, string> = {};
    const direct = make({ links: file });
    direct.seed(`${HOME}/${WORKER}`, 'Worker rules.\n');
    file[`${HOME}/${WORKER}`] = '/elsewhere/worker.md';
    const linked = await own(direct);
    expect(linked.kind === 'unusable' && linked.error).toMatchObject({ kind: 'safety', message: expect.stringContaining(`${WORKER} is a link`) });
  });
});

describe('setup check: a received root', () => {
  it('has an empty subject when git tracks no file apart from the config and the ignore file', async () => {
    const deps = make({ tracked: ['factory.yaml', '.gitignore'] });
    expect(await received(deps)).toEqual({ kind: 'empty' });
  });

  it('finds the setup file and the listed files without an acceptance, and names the files git tracks', async () => {
    const deps = make({ tracked: ['factory.yaml', COORDINATOR, 'scripts/run.sh'] });
    const check = await received(deps);
    expect(check.kind === 'unaccepted' && check.stop.text).toBe(
      `the owner has not accepted the files that git tracks: scripts/run.sh, ${COORDINATOR}`,
    );
  });

  it('accepts the files that were accepted, and finds a change of a listed file alone', async () => {
    const deps = make({ tracked: [COORDINATOR, 'scripts/run.sh'] });
    await acceptFiles(deps, HOME, NODE, [COORDINATOR, 'scripts/run.sh']);
    expect((await received(deps)).kind).toBe('accepted');
    deps.seed(`${HOME}/scripts/run.sh`, 'changed\n');
    const check = await received(deps);
    expect(check.kind === 'changed' && check.stop.text).toBe(
      'the files that git tracks changed since the owner accepted them: scripts/run.sh',
    );
  });

  it('does not let an empty setup file skip the acceptance of the listed files', async () => {
    const deps = make({ tracked: [COORDINATOR, 'scripts/run.sh'] });
    deps.seed(`${HOME}/${COORDINATOR}`, '\n');
    const check = await received(deps);
    expect(check.kind === 'unaccepted' && check.stop.text).toContain('scripts/run.sh');
    expect(check.kind === 'unaccepted' && check.stop.text).not.toContain(COORDINATOR);
  });

  it('stops when the folder is not the top of a git work tree, and when the list is at its cap', async () => {
    const none = await received(make({ noRepo: true }));
    expect(none.kind === 'unusable' && none.stop).toEqual(notListedStop(HOME));
    const tracked = Array.from({ length: trackedFiles.maxCount + 1 }, (_value, index) => `docs/f${index}.md`);
    const capped = await received(make({ tracked }));
    expect(capped.kind === 'unusable' && capped.error.kind).toBe('safety');
    expect(capped.kind === 'unusable' && capped.stop.text).toContain(String(trackedFiles.maxCount));
  });

  it('stops on a tracked link', async () => {
    const deps = make({ tracked: ['scripts/run.sh'], links: { [`${HOME}/scripts/run.sh`]: '/elsewhere/run.sh' } });
    deps.seed('/elsewhere/run.sh', 'text\n');
    const check = await received(deps);
    expect(check.kind === 'unusable' && check.stop.text).toContain('scripts/run.sh is a link');
  });
});

describe('setup check: a set that the caller lists', () => {
  it('gives the same answer as the check of the root for the same files', async () => {
    const deps = make({ tracked: [COORDINATOR] });
    const set = [COORDINATOR];
    expect(await checkSetupSet(deps, { home: HOME, set, node: NODE, received: true })).toEqual(await received(deps));
    expect(await checkSetupSet(deps, { home: HOME, set: [], node: NODE, received: true })).toEqual({ kind: 'empty' });
  });
});

describe('setup check: may this run ask?', () => {
  it.each([
    ['a terminal window for input and output', { tty: true }, false, true],
    ['a dry run', { tty: true }, true, false],
    ['a factory session', { tty: true, env: { [env.session]: 'demo' } }, false, false],
    ['no terminal window', {}, false, false],
    ['no terminal window for output', { tty: true, stdoutTty: false }, false, false],
    ['no terminal window for input', { tty: false, stdoutTty: true }, false, false],
  ])('%s', (_name, setup, dryRun, expected) => {
    expect(mayAsk(make(setup), dryRun)).toBe(expected);
  });
});

describe('setup check: settle the setup text before a command renders it', () => {
  const yes: PromptHandler = () => ok('y');
  const no: PromptHandler = () => ok('n');
  const reason = acceptReason('start');

  /** A root whose text the owner accepted and a pull changed. */
  const changed = async (setup: Setup): Promise<FakeDeps> => {
    const deps = make(setup);
    deps.seed(`${HOME}/${COORDINATOR}`, 'First rules.\n');
    await acceptFiles(deps, HOME, NODE, [COORDINATOR]);
    deps.seed(`${HOME}/${COORDINATOR}`, 'Second rules.\n');
    return deps;
  };

  const settle = async (deps: FakeDeps, dryRun = false) =>
    settleSetup(deps, { home: HOME, node: NODE, check: await own(deps), dryRun, reason });

  it('needs nothing for an empty subject, and gives the accepted texts for an accepted one', async () => {
    const deps = make({ tty: true, prompt: yes });
    expect(await settle(deps)).toEqual(ok({ texts: { coordinator: null, worker: null }, accepted: false, warnings: [] }));
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    await acceptFiles(deps, HOME, NODE, [COORDINATOR]);
    expect(await settle(deps)).toEqual(ok({ texts: { coordinator: 'Rules.\n', worker: null }, accepted: false, warnings: [] }));
    expect(deps.prompts).toEqual([]);
  });

  it('writes the acceptance of a change after a yes, and gives the texts of the bytes that it hashed', async () => {
    const deps = await changed({ tty: true, prompt: yes });
    const settled = await settle(deps);
    expect(settled).toEqual(ok({ texts: { coordinator: 'Second rules.\n', worker: null }, accepted: true, warnings: [] }));
    expect(deps.prompts).toHaveLength(1);
    const set = await collectSetup(deps, HOME, [COORDINATOR], commands.init);
    expect(JSON.parse(storeOf(deps)).acceptances).toEqual([
      expect.objectContaining({ node: NODE, hash: set.ok ? set.value.collected.manifest.hash : '', reason }),
    ]);
  });

  it('counts a change as accepted when only the lock file stays, and gives a warning that names the lock file', async () => {
    const deps = await changed({ tty: true, prompt: yes });
    const settled = await settleSetup(withFailingRemoves(deps, (path) => path === `${ACCEPTANCES}.lock`), {
      home: HOME,
      node: NODE,
      check: await own(deps),
      dryRun: false,
      reason,
    });
    expect(settled).toMatchObject({
      ok: true,
      value: { texts: { coordinator: 'Second rules.\n' }, accepted: true, warnings: [expect.stringContaining(`${ACCEPTANCES}.lock`)] },
    });
    expect(JSON.parse(storeOf(deps)).acceptances).toEqual([expect.objectContaining({ node: NODE, reason })]);
  });

  it('stops with the old failure text when the lock file stays and the write fails', async () => {
    const deps = await changed({ tty: true, prompt: yes });
    const failing = withFailingWrites(
      withFailingRemoves(deps, (path) => path === `${ACCEPTANCES}.lock`),
      (path) => path === ACCEPTANCES,
    );
    const before = storeOf(deps);
    const settled = await settleSetup(failing, { home: HOME, node: NODE, check: await own(deps), dryRun: false, reason });
    expect(settled).toMatchObject({ ok: false, error: { kind: 'failure', message: expect.stringContaining('The setup acceptance was not written') } });
    expect(storeOf(deps)).toBe(before);
  });

  it('stops with the accept command after a no, and writes nothing', async () => {
    const deps = await changed({ tty: true, prompt: no });
    const before = storeOf(deps);
    const settled = await settle(deps);
    expect(settled).toMatchObject({ ok: false, error: { kind: 'safety', hint: CHANGE_REMEDY } });
    expect(storeOf(deps)).toBe(before);
  });

  it.each([
    ['a factory session', { tty: true, env: { [env.session]: 'demo' } }, false],
    ['a dry run', { tty: true }, true],
    ['no terminal window', {}, false],
    ['no terminal window for output', { tty: true, stdoutTty: false }, false],
  ])('asks nothing and writes nothing with %s, and names the accept command', async (_name, setup, dryRun) => {
    const deps = await changed({ ...setup, prompt: yes });
    const before = storeOf(deps);
    expect(await settle(deps, dryRun)).toMatchObject({ ok: false, error: { kind: 'safety', hint: CHANGE_REMEDY } });
    expect(deps.prompts).toEqual([]);
    expect(storeOf(deps)).toBe(before);
  });

  it('never makes a first acceptance, also on a terminal window: it stops and names init', async () => {
    const deps = make({ tty: true, prompt: yes });
    deps.seed(`${HOME}/${COORDINATOR}`, 'Rules.\n');
    expect(await settle(deps)).toMatchObject({ ok: false, error: { kind: 'safety', hint: INIT_REMEDY } });
    expect(deps.prompts).toEqual([]);
    expect(deps.files.has(ACCEPTANCES)).toBe(false);
  });

  it('gives the error of an unusable check as it is', async () => {
    const deps = make({ tty: true, prompt: yes });
    deps.seed(`${HOME}/${COORDINATOR}`, 'x'.repeat(maxSetupTextBytes + 1));
    expect(await settle(deps)).toMatchObject({ ok: false, error: { kind: 'failure' } });
  });

  it('asks nothing for a change when the node id is unknown', async () => {
    const deps = await changed({ tty: true, prompt: yes });
    const check = await own(deps);
    expect(await settleSetup(deps, { home: HOME, node: null, check, dryRun: false, reason })).toMatchObject({
      ok: false,
      error: { kind: 'safety' },
    });
    expect(deps.prompts).toEqual([]);
  });
});
