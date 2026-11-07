import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** True while any process is left in the process group. A group with no process gives ESRCH. */
const groupExists = (group: number): boolean => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const errorOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the run did not fail');
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
    const group = Number(/PID:(\d+)/.exec(error.message)?.[1]);
    expect(group).toBeGreaterThan(1);
    for (let waited = 0; groupExists(group) && waited < GONE_MS; waited += GONE_STEP_MS) await sleep(GONE_STEP_MS);
    expect(groupExists(group)).toBe(false);
  }, CASE_MS);

  it('fails for a prompt that does not show within the prompt limit, and stops the group of the command (TP-8)', async () => {
    const error = await errorOf(
      runInTerminal(box, ['/bin/sh', '-c', 'echo busy; sleep 60'], {
        exchanges: [{ prompt: /Name: $/, answer: 'Ada' }],
        promptMs: 300,
      }),
    );
    expect(error.message).toContain('did not show in 300 ms');
    const group = Number(/PID:(\d+)/.exec(error.message)?.[1]);
    for (let waited = 0; groupExists(group) && waited < GONE_MS; waited += GONE_STEP_MS) await sleep(GONE_STEP_MS);
    expect(groupExists(group)).toBe(false);
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
