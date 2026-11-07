import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInTerminal, scriptGate } from './fake-terminal.js';
import { makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';

const gate = scriptGate();
if (gate === 'skip') console.warn('fake-terminal.test.ts is skipped: the program script is not installed.');

/** The time limit of one case: the longest run of the helper (90 s) and the time for the end of the run. */
const CASE_MS = 120_000;
/** The wait for a process group to be gone after the helper killed it. The wait has an upper bound. */
const GONE_MS = 3_000;
const GONE_STEP_MS = 50;

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

/**
 * True while any process is left in the process group. A group with no process gives ESRCH, and only that is "gone": EPERM
 * means that the group exists, and any other error (for example a TypeError for a group that is not a number) is thrown.
 */
const groupExists = (group: number): boolean => {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Block the event loop of the test process for `ms`: every timer, also the ones of the helper, then runs late. */
const blockEventLoop = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // The loop has an upper bound: the time.
  }
};

/** The process group of the command, read from the line `PID:<number>` of the screen in an error. NaN when the line is not there. */
const groupOf = (text: string): number => Number(/PID:(\d+)/.exec(text)?.[1]);

/**
 * Check that the group of the command is gone. The guard comes first: a group that is not a number or is too small would make
 * the check pass without a kill. The wait has an upper bound.
 */
const expectGroupGone = async (group: number): Promise<void> => {
  expect(group).toBeGreaterThan(1);
  for (let waited = 0; groupExists(group) && waited < GONE_MS; waited += GONE_STEP_MS) await sleep(GONE_STEP_MS);
  expect(groupExists(group)).toBe(false);
};

/** Kill a group that a test failed to stop, so a failed case leaves no process. A group that is gone is no fault. */
const killGroupAfterTest = (group: number): void => {
  if (!Number.isInteger(group) || group <= 1) return;
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const errorOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the run did not fail');
};

/**
 * Start a run while the first SIGKILL of the test process fails with EPERM. The run must fail. Returns its error and the target of
 * each SIGKILL that the run sent.
 */
const failAfterFirstKillFails = async (start: () => Promise<unknown>): Promise<{ error: Error; kills: number[] }> => {
  const real = process.kill.bind(process);
  const kills: number[] = [];
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 'SIGKILL') return real(pid, signal);
    kills.push(pid);
    if (kills.length === 1) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return real(pid, signal);
  });
  try {
    return { error: await errorOf(start()), kills };
  } finally {
    spy.mockRestore();
  }
};

it.runIf(gate === 'fail')('needs the program script, because the variable CI is set', () => {
  throw new Error('the program script is not installed, and the tests run with CI set');
});

describe.skipIf(gate !== 'run')('the fake terminal (script)', () => {
  it('gives the command a terminal on its standard input and output, and ends with the exit code (TP-18)', async () => {
    const result = await runInTerminal(box, ['/bin/sh', '-c', 'test -t 0 && test -t 1 && echo TTY']);
    expect(result.screen).toContain('TTY');
    expect(result.screen).toMatch(/(?:^|\n)EXIT:0\n/);
    expect(result.code).toBe(0);
  }, CASE_MS);

  it('passes the exit code of the command', async () => {
    const result = await runInTerminal(box, ['/bin/sh', '-c', 'exit 7']);
    expect(result.code).toBe(7);
  }, CASE_MS);

  it('quotes each word, so a quote, a dollar sign and a back tick reach the command as text (TP-8)', async () => {
    const word = `it's $HOME \`id\` ; "q" *`;
    const result = await runInTerminal(box, ['/bin/sh', '-c', 'printf "<%s>" "$1"', 'sh', word]);
    expect(result.screen).toContain(`<${word}>`);
    expect(result.code).toBe(0);
  }, CASE_MS);

  it('writes each answer only after its prompt shows, in the order of the exchanges', async () => {
    const result = await runInTerminal(
      box,
      ['/bin/sh', '-c', 'printf "Name: "; read name; printf "Sure? [y/N] "; read sure; echo "got:$name:$sure"'],
      {
        exchanges: [
          { prompt: /Name: $/, answer: 'Ada' },
          { prompt: /Sure\? \[y\/N\] $/, answer: (shown) => (shown.includes('Sure?') ? 'y' : 'n') },
        ],
      },
    );
    expect(result.screen).toContain('got:Ada:y');
    expect(result.code).toBe(0);
  }, CASE_MS);

  it('fails at once for a prompt that no exchange names, shows the screen, and stops the group of the command (TP-8)', async () => {
    const started = Date.now();
    const error = await errorOf(
      runInTerminal(box, ['/bin/sh', '-c', 'printf "Continue? [y/N] "; sleep 60'], {
        exchanges: [{ prompt: /Name: $/, answer: 'Ada' }],
        promptMs: 30_000,
      }),
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error.message).toContain('no exchange names');
    expect(error.message).toContain('Continue? [y/N]');
    await expectGroupGone(groupOf(error.message));
  }, CASE_MS);

  it('counts the prompt limit from the start of the command, and stops the group of the command (TP-8)', async () => {
    const error = await errorOf(
      runInTerminal(box, ['/bin/sh', '-c', 'echo busy; sleep 60'], {
        exchanges: [{ prompt: /Name: $/, answer: 'Ada' }],
        promptMs: 300,
      }),
    );
    expect(error.message).toContain('did not show in 300 ms');
    await expectGroupGone(groupOf(error.message));
  }, CASE_MS);

  it('ends at the run limit in wall time when a timer is late, and stops a command that ignores the hangup (TP-8)', async () => {
    const blockMs = 2_000;
    const pidFile = join(box.root, 'command.pid');
    // The block starts in the check phase of the loop. The next turn then runs the due timer of the helper before the poll phase
    // that reads the pipes, so the helper reads an empty screen, hits its deadline, and meets the PID line only after the kills.
    setImmediate(() => blockEventLoop(blockMs));
    const started = Date.now();
    const error = await errorOf(
      // The command writes the group of its shell, then ends in `sleep`, which ignores the hangup of the closed terminal.
      runInTerminal(box, ['/bin/sh', '-c', 'trap "" HUP; echo $PPID > "$1"; exec sleep 30', 'sh', pidFile], { totalMs: 1_000 }),
    );
    const elapsed = Date.now() - started;
    const group = Number((await box.read(pidFile)).trim());
    try {
      expect(error.message).toContain('did not end in 1000 ms');
      // A loop that counts steps runs on for the rest of its steps after the late timer. A deadline in wall time ends at once.
      expect(elapsed).toBeLessThan(blockMs + 500);
      await expectGroupGone(group);
    } finally {
      killGroupAfterTest(group);
    }
  }, CASE_MS);

  it('runs every kill and keeps the error of the run when the first kill fails (TP-8)', async () => {
    const { error, kills } = await failAfterFirstKillFails(() =>
      runInTerminal(box, ['/bin/sh', '-c', 'printf "Continue? [y/N] "; sleep 60']),
    );
    try {
      expect(error.message).toContain('no exchange names');
      expect(kills).toHaveLength(2);
    } finally {
      killGroupAfterTest(groupOf(error.message));
    }
  }, CASE_MS);

  it('fails a run that worked when a kill fails, and still runs the other kill (TP-8)', async () => {
    const { error, kills } = await failAfterFirstKillFails(() => runInTerminal(box, ['/bin/true']));
    expect(error.message).toContain('EPERM');
    expect(kills).toHaveLength(2);
  }, CASE_MS);

  it('drops TMUX from the environment of the command, as the sandbox does for each command (TP-8)', async () => {
    const result = await runInTerminal(box, ['/bin/sh', '-c', 'printf "<%s>" "${TMUX-unset}"'], {
      env: { TMUX: '/private/tmux-user,1,0' },
    });
    expect(result.screen).toContain('<unset>');
  }, CASE_MS);

  it('fails when the command ends before the last prompt', async () => {
    const error = await errorOf(
      runInTerminal(box, ['/bin/sh', '-c', 'echo done'], { exchanges: [{ prompt: /Name: $/, answer: 'Ada' }] }),
    );
    expect(error.message).toContain('ended before the prompt');
  }, CASE_MS);

  it('stops before it spawns anything when HOME is not inside the sandbox root (TP-8)', async () => {
    const error = await errorOf(runInTerminal(box, ['/bin/true'], { env: { HOME: '/nonexistent-home' } }));
    expect(error.message).toContain('HOME');
    expect(error.message).toContain('not inside the sandbox root');
  }, CASE_MS);
});
