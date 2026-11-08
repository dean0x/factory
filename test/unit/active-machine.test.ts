import { describe, expect, it } from 'vitest';
import { activeMachine, commands, files, privateFile, schemaIds } from '../../src/names.js';
import { layoutOf } from '../../src/state/layout.js';
import {
  claimActiveMachine,
  clearActiveMark,
  machineIdOf,
  markNamesThisMachine,
  readActiveMark,
} from '../../src/state/active-machine.js';
import { createFakeDeps, exited, type FakeDeps, type RunCall } from '../helpers/fake-deps.js';
import { withoutStateWords } from '../helpers/git-fake.js';

const HOME = '/h/node';
const LAYOUT = layoutOf(HOME);
const STATE = LAYOUT.stateDir;
const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_AT = '2029-12-31T10:00:00.000Z';
const NOW = '2030-01-02T03:04:05.678Z';

interface Setup {
  /** The status of the state repo as git prints it. Default: no change. */
  readonly status?: string;
  /** False: git has no identity. */
  readonly identity?: boolean;
  /** The exit code of the commit. Default: 0. */
  readonly commitExit?: number;
  /** False: the state folder is no git repo. */
  readonly repo?: boolean;
  /** False: the run-time folder is not there yet. */
  readonly runtime?: boolean;
  readonly links?: Record<string, string>;
}

/** A fake of git for the state repo: the status, the identity, and the exit code of every other call. */
const gitAnswer = (setup: Setup) => (call: RunCall) => {
  const command = withoutStateWords(call.args).slice(2).join(' ');
  if (command === 'status --porcelain -z --untracked-files=all --ignore-submodules=all') return exited(0, setup.status ?? '');  if (command === 'config user.name' || command === 'config user.email') {
    return setup.identity === false ? exited(1) : exited(0, 'Git User\n');
  }
  return exited(command.includes(' commit ') ? (setup.commitExit ?? 0) : 0);
};

const make = (setup: Setup = {}): FakeDeps => {
  const deps = createFakeDeps({
    run: gitAnswer(setup),
    ...(setup.links === undefined ? {} : { links: setup.links }),
  });
  deps.seedDir(STATE);
  if (setup.runtime !== false) deps.seedDir(LAYOUT.runtimeDir);
  if (setup.repo !== false) deps.seedDir(`${STATE}/.git`);
  return deps;
};

/** The git calls in the state repo, each one as the words after `-C <folder>`, without the reads. */
const writesOf = (deps: FakeDeps): string[] =>
  deps.calls
    .filter((call) => call.command === 'git' && call.args[1] === STATE)
    .map((call) => withoutStateWords(call.args).slice(2).join(' '))
    .filter((call) => /^(add|rm|reset)\b/.test(call) || call.includes(' commit '));

const markText = (machine: string, at: string): string =>
  `${JSON.stringify({
    [activeMachine.keys.schema]: schemaIds.activeMachine,
    [activeMachine.keys.machine]: machine,
    [activeMachine.keys.at]: at,
  })}\n`;

const markOf = (deps: FakeDeps): { machine: string; at: string } | undefined => {
  const text = deps.files.get(LAYOUT.activeMachineFile);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as Record<string, string>;
  return { machine: parsed[activeMachine.keys.machine] ?? '', at: parsed[activeMachine.keys.at] ?? '' };
};

const idOf = async (deps: FakeDeps): Promise<string> => {
  const made = await machineIdOf(deps, HOME);
  if (!made.ok) throw new Error(made.error.message);
  return made.value;
};

describe('the id of a machine', () => {
  it('makes a random UUID once, in the run-time folder, with a private mode', async () => {
    const deps = make();
    const id = await idOf(deps);
    expect(id).toMatch(activeMachine.idPattern);
    expect(id).toBe(FIRST_ID);
    expect(deps.files.get(LAYOUT.machineIdFile)).toBe(`${id}\n`);
    expect(deps.modes.get(LAYOUT.machineIdFile)).toBe(privateFile.fileMode);
  });

  it('gives the same id on the next call, and makes no new random text', async () => {
    const deps = make();
    const first = await idOf(deps);
    const second = await idOf(deps);
    expect(second).toBe(first);
    expect(deps.randomTexts).toHaveLength(1);
  });

  it('reads an id that is there, and writes nothing', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${OTHER_ID}\n`);
    expect(await idOf(deps)).toBe(OTHER_ID);
    expect(deps.randomTexts).toHaveLength(0);
  });

  it('makes the run-time folder with a private mode when it is not there', async () => {
    const deps = make({ runtime: false });
    await idOf(deps);
    expect(deps.dirs.has(LAYOUT.runtimeDir)).toBe(true);
    expect(deps.modes.get(LAYOUT.runtimeDir)).toBe(activeMachine.folderMode);
  });

  it('keeps the id of another writer that made the file between the check and the create', async () => {
    const deps = make();
    const racing: FakeDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        writeTextExclusive: async (path, text, mode) => {
          deps.seed(path, `${OTHER_ID}\n`);
          return deps.fs.writeTextExclusive(path, text, mode);
        },
      },
    };
    expect(await idOf(racing)).toBe(OTHER_ID);
    expect(deps.files.get(LAYOUT.machineIdFile)).toBe(`${OTHER_ID}\n`);
  });

  it('fails, and names the file, when the file holds no id', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, 'not an id\n');
    const made = await machineIdOf(deps, HOME);
    expect(made).toMatchObject({ ok: false, error: { message: expect.stringContaining(files.machineId) } });
    expect(deps.files.get(LAYOUT.machineIdFile)).toBe('not an id\n');
  });

  it('fails for a file that is a link, and writes nothing', async () => {
    const deps = make({ links: { [LAYOUT.machineIdFile]: '/elsewhere/id' } });
    const made = await machineIdOf(deps, HOME);
    expect(made).toMatchObject({ ok: false, error: { message: expect.stringContaining('is a link') } });
    expect(deps.randomTexts).toHaveLength(0);
  });
});

describe('the mark of the active machine: the read', () => {
  it('finds no file', async () => {
    expect(await readActiveMark(make(), HOME)).toEqual({ ok: true, value: { state: 'absent' } });
  });

  it('reads the machine and the time', async () => {
    const deps = make();
    deps.seed(LAYOUT.activeMachineFile, markText(OTHER_ID, OTHER_AT));
    expect(await readActiveMark(deps, HOME)).toMatchObject({
      ok: true,
      value: { state: 'valid', mark: { machine: OTHER_ID, at: OTHER_AT } },
    });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a machine that is not a UUID', markText('machine-one', OTHER_AT)],
    ['a time that is not a time', markText(OTHER_ID, 'yesterday')],
    ['a key that is not known', `${JSON.stringify({ extra: 1 })}\n`],
  ])('calls %s invalid, and keeps the text', async (_name, text) => {
    const deps = make();
    deps.seed(LAYOUT.activeMachineFile, text);
    expect(await readActiveMark(deps, HOME)).toMatchObject({ ok: true, value: { state: 'invalid', text } });
  });

  it('calls a file that is a link invalid, with no text', async () => {
    const deps = make({ links: { [LAYOUT.activeMachineFile]: '/elsewhere/mark' } });
    expect(await readActiveMark(deps, HOME)).toMatchObject({ ok: true, value: { state: 'invalid', text: null } });
  });
});

describe('the mark of the active machine: the claim', () => {
  it('writes the id of this machine and the time, and commits only the file of the mark', async () => {
    const deps = make();
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome).toEqual({ claimed: true, other: null });
    expect(markOf(deps)).toEqual({ machine: FIRST_ID, at: NOW });
    expect(deps.warned).toEqual([]);
    const writes = writesOf(deps);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toBe(`add -A -- ${files.activeMachine}`);
    expect(writes[1]).toContain(` commit -q -m ${activeMachine.commitMessages.set}`);
  });

  it('writes the file with the schema id of the mark', async () => {
    const deps = make();
    await claimActiveMachine(deps, HOME);
    const parsed = JSON.parse(deps.files.get(LAYOUT.activeMachineFile) ?? '{}') as Record<string, string>;
    expect(parsed[activeMachine.keys.schema]).toBe(schemaIds.activeMachine);
  });

  it('gives no warning, and marks again, when the mark names this machine', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    deps.seed(LAYOUT.activeMachineFile, markText(FIRST_ID, OTHER_AT));
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome).toEqual({ claimed: true, other: null });
    expect(deps.warned).toEqual([]);
    expect(markOf(deps)).toEqual({ machine: FIRST_ID, at: NOW });
  });

  it('warns once, with the other machine and its time, when the mark names another machine, and then takes the mark', async () => {
    const deps = make();
    deps.seed(LAYOUT.activeMachineFile, markText(OTHER_ID, OTHER_AT));
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome).toEqual({ claimed: true, other: { machine: OTHER_ID, at: OTHER_AT } });
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain(OTHER_ID);
    expect(deps.warned[0]).toContain(OTHER_AT);
    expect(deps.warned[0]).toContain('Run "factory shutdown" in this factory folder on that machine.');
    expect(markOf(deps)).toEqual({ machine: FIRST_ID, at: NOW });
  });

  it('warns that the mark is replaced when its text is not valid', async () => {
    const deps = make();
    deps.seed(LAYOUT.activeMachineFile, 'not json');
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome).toEqual({ claimed: true, other: null });
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain(files.activeMachine);
    expect(markOf(deps)?.machine).toBe(FIRST_ID);
  });

  it('warns, and writes and commits nothing, when the file of the mark is a link', async () => {
    const deps = make({ links: { [LAYOUT.activeMachineFile]: '/elsewhere/mark' } });
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome.claimed).toBe(false);
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain('is a link');
    expect(deps.files.has(LAYOUT.activeMachineFile)).toBe(false);
    expect(writesOf(deps)).toEqual([]);
  });

  it.each([
    ['the state folder is no git repo', { repo: false }, 'is not a git repository'],
    ['git has no identity', { identity: false }, 'git has no user.name and user.email'],
    ['the index holds a staged change', { status: 'M  board.json\0' }, 'staged changes'],
    ['the owner changed the file of the mark', { status: ` M ${files.activeMachine}\0` }, files.activeMachine],
  ] satisfies readonly (readonly [string, Setup, string])[])(
    'warns, and writes and commits nothing, when %s',
    async (_name, setup, reason) => {
      const deps = make(setup);
      const outcome = await claimActiveMachine(deps, HOME);
      expect(outcome.claimed).toBe(false);
      expect(deps.warned).toHaveLength(1);
      expect(deps.warned[0]).toContain(reason);
      expect(deps.files.has(LAYOUT.activeMachineFile)).toBe(false);
      expect(writesOf(deps)).toEqual([]);
    },
  );

  it('ends the warning with the command that tries again, which claims the mark also while the session runs', async () => {
    const deps = make({ identity: false });
    await claimActiveMachine(deps, HOME);
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain('Set both with "git config --global", then run "factory start" again.');
  });

  it('still warns about another machine when it can not commit the mark', async () => {
    const deps = make({ identity: false });
    deps.seed(LAYOUT.activeMachineFile, markText(OTHER_ID, OTHER_AT));
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome.other).toEqual({ machine: OTHER_ID, at: OTHER_AT });
    expect(deps.warned).toHaveLength(2);
    expect(deps.warned[0]).toContain(OTHER_ID);
    expect(deps.files.get(LAYOUT.activeMachineFile)).toBe(markText(OTHER_ID, OTHER_AT));
  });

  it('warns, clears the staged file and removes a new mark when the commit fails', async () => {
    const deps = make({ commitExit: 1 });
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome.claimed).toBe(false);
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain('cannot commit the state files');
    expect(deps.files.has(LAYOUT.activeMachineFile)).toBe(false);
    expect(writesOf(deps)).toContain(`reset -q -- ${files.activeMachine}`);
  });

  it('puts the old mark back when the commit fails', async () => {
    const deps = make({ commitExit: 1 });
    const old = markText(OTHER_ID, OTHER_AT);
    deps.seed(LAYOUT.activeMachineFile, old);
    await claimActiveMachine(deps, HOME);
    expect(deps.files.get(LAYOUT.activeMachineFile)).toBe(old);
  });

  it('warns, and writes nothing, when it can not make the id of the machine', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, 'not an id\n');
    const outcome = await claimActiveMachine(deps, HOME);
    expect(outcome).toEqual({ claimed: false, other: null });
    expect(deps.warned).toHaveLength(1);
    expect(deps.warned[0]).toContain(files.machineId);
    expect(writesOf(deps)).toEqual([]);
  });
});

describe('the mark of the active machine: who it names', () => {
  const withMark = (text: string): FakeDeps => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    deps.seed(LAYOUT.activeMachineFile, text);
    return deps;
  };

  it('is true for a valid mark that names this machine', async () => {
    expect(await markNamesThisMachine(withMark(markText(FIRST_ID, OTHER_AT)), HOME)).toBe(true);
  });

  it.each([
    ['names another machine', markText(OTHER_ID, OTHER_AT)],
    ['is not valid', 'not json'],
  ])('is false for a mark that %s', async (_name, text) => {
    expect(await markNamesThisMachine(withMark(text), HOME)).toBe(false);
  });

  it('is false when there is no mark', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    expect(await markNamesThisMachine(deps, HOME)).toBe(false);
  });

  it('is false when the id of the machine can not be read', async () => {
    const deps = withMark(markText(FIRST_ID, OTHER_AT));
    deps.seed(LAYOUT.machineIdFile, 'not an id\n');
    expect(await markNamesThisMachine(deps, HOME)).toBe(false);
  });
});

describe('the mark of the active machine in a state repo whose delete guard is off (TP-6)', () => {
  /** The git reads that tell a guard that is on from a guard that is off. The ready check of the state repo makes none of them. */
  const guardReadsOf = (deps: FakeDeps): string[] =>
    deps.calls
      .filter((call) => call.command === 'git')
      .map((call) => withoutStateWords(call.args).slice(2).join(' '))
      .filter((command) => command.includes('core.hooksPath') || command.startsWith('rev-parse --absolute-git-dir'));

  it('claims the mark and commits it, and reads no state of the guard', async () => {
    const deps = make();
    expect(deps.files.has(`${STATE}/.git/factory-guard/pre-commit`)).toBe(false);
    expect(await claimActiveMachine(deps, HOME)).toEqual({ claimed: true, other: null });
    expect(writesOf(deps)).toHaveLength(2);
    expect(guardReadsOf(deps)).toEqual([]);
  });

  it('clears the mark and commits the removal, and reads no state of the guard', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    deps.seed(LAYOUT.activeMachineFile, markText(FIRST_ID, OTHER_AT));
    expect(await clearActiveMark(deps, HOME, commands.start)).toEqual({ ok: true, value: 'cleared' });
    expect(writesOf(deps)).toHaveLength(2);
    expect(guardReadsOf(deps)).toEqual([]);
  });
});

describe('the mark of the active machine: the clear', () => {
  const marked = (machine: string): FakeDeps => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    deps.seed(LAYOUT.activeMachineFile, markText(machine, OTHER_AT));
    return deps;
  };

  it('removes the mark of this machine and commits the removal of that file only', async () => {
    const deps = marked(FIRST_ID);
    expect(await clearActiveMark(deps, HOME, commands.start)).toEqual({ ok: true, value: 'cleared' });
    expect(deps.files.has(LAYOUT.activeMachineFile)).toBe(false);
    const writes = writesOf(deps);
    expect(writes[0]).toBe(`add -A -- ${files.activeMachine}`);
    expect(writes[1]).toContain(` commit -q -m ${activeMachine.commitMessages.clear}`);
  });

  it('keeps the mark of another machine, and runs no git write', async () => {
    const deps = marked(OTHER_ID);
    expect(await clearActiveMark(deps, HOME, commands.start)).toEqual({ ok: true, value: 'other' });
    expect(deps.files.get(LAYOUT.activeMachineFile)).toBe(markText(OTHER_ID, OTHER_AT));
    expect(writesOf(deps)).toEqual([]);
  });

  it('does nothing when there is no mark', async () => {
    const deps = make();
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    expect(await clearActiveMark(deps, HOME, commands.start)).toEqual({ ok: true, value: 'absent' });
    expect(writesOf(deps)).toEqual([]);
  });

  it('puts the mark back and clears the index when the commit fails', async () => {
    const deps = marked(FIRST_ID);
    const before = deps.files.get(LAYOUT.activeMachineFile);
    const failing = createFakeDeps({ run: gitAnswer({ commitExit: 1 }) });
    for (const [path, text] of deps.files) failing.seed(path, text);
    failing.seedDir(`${STATE}/.git`);
    const cleared = await clearActiveMark(failing, HOME, commands.start);
    expect(cleared).toMatchObject({ ok: false, error: { message: expect.stringContaining('cannot commit the state files') } });
    expect(failing.files.get(LAYOUT.activeMachineFile)).toBe(before);
    expect(writesOf(failing)).toContain(`reset -q -- ${files.activeMachine}`);
  });

  it('fails with the reason, and removes nothing, when the state repo is not ready', async () => {
    const deps = make({ identity: false });
    deps.seed(LAYOUT.machineIdFile, `${FIRST_ID}\n`);
    deps.seed(LAYOUT.activeMachineFile, markText(FIRST_ID, OTHER_AT));
    const cleared = await clearActiveMark(deps, HOME, commands.start);
    expect(cleared).toMatchObject({ ok: false, error: { message: expect.stringContaining('git has no user.name') } });
    expect(deps.files.has(LAYOUT.activeMachineFile)).toBe(true);
  });
});
