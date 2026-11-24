import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runInTerminal, scriptGate } from './fake-terminal.js';
import { DIST, tmuxSocketOf } from './harness.js';
import { hasTmux, LIFECYCLE_CASE_MS, SESSIONS, useLab } from './lifecycle-lab.js';

const gate = scriptGate();
if (!hasTmux) console.warn('relay.test.ts is skipped: tmux 3.0 or newer is not installed.');
if (gate === 'skip') console.warn('relay.test.ts is skipped: the program script is not installed.');

const lab = useLab();
const board = ['board:', '  states: [open, doing, done]', '  in_progress: doing', '  closed: done', ''].join('\n');
const typed = (id: 'alpha' | 'beta'): string => join(lab.outDir, `typed-${id}`);

const fromOwner = async (args: readonly string[], prompt: RegExp): Promise<void> => {
  const result = await runInTerminal(lab.box, [process.execPath, DIST, ...args, '--home', lab.box.node], {
    exchanges: [{ prompt, answer: 'y' }],
  });
  expect(result.code, result.screen).toBe(0);
};

const prepareRequest = async () => {
  for (const id of ['alpha', 'beta'] as const) {
    await writeFile(join(lab.outDir, `relay-input-${id}`), `${SESSIONS[id]}\n`);
  }
  await lab.node({ sessions: ['demo'] });
  // The pane start time has whole seconds. Give the lab settings a clearly earlier time.
  await utimes(join(lab.box.node, 'work-copies', 'web', 'alpha', '.claude', 'settings.local.json'), 1, 1);
  const config = join(lab.box.node, 'factory.yaml');
  await writeFile(config, `${(await readFile(config, 'utf8')).trimEnd()}\n${board}`);
  await fromOwner(['guard', 'confirm'], /Confirm this owner prefix\? \[y\/N\] $/);

  const caller = { TMUX_PANE: await lab.coordinatorPane(), FACTORY_SESSION: 'demo' };
  expect(caller.TMUX_PANE).toMatch(/^%\d+$/);
  const asked = await lab.factory('request', [
    'add', '--title', 'Pick', '--question', 'Which?', '--option', 'a=Yes', '--option', 'b=No',
  ], caller);
  expect(asked.code, asked.stderr).toBe(0);
  return caller;
};

const recordProof = z.object({ proof: z.literal('record'), option: z.literal('a'), at: z.iso.datetime() });
const relayArgs = ['relay', 'alpha', '--decision', 'D-1'] as const;

describe.skipIf(!hasTmux)('factory worker relay (built binary, separate tmux server)', () => {
  it.runIf(gate === 'fail')('needs the program script in CI', () => {
    throw new Error('the program script is not installed, and the tests run with CI set');
  });

  it.skipIf(gate !== 'run')('replaces the draft with one exact decision line in the target worker only', async () => {
    const caller = await prepareRequest();
    await fromOwner(['decide', 'D-1', 'a'], /Record the answer a for D-1\? \[y\/N\] $/);
    const read = await lab.factory('decide', ['read', 'D-1', '--json']);
    expect(read.code, read.stderr).toBe(0);
    const { at } = recordProof.parse(JSON.parse(read.stdout));
    const date = at.slice(0, 10);

    const alpha = await lab.livePaneOf('alpha');
    expect(alpha).toBeDefined();
    const draft = await lab.tmux(['-S', tmuxSocketOf(lab.box.root), 'send-keys', '-t', alpha?.pane ?? '', '-l', '--', 'Draft']);
    expect(draft.code, draft.stderr).toBe(0);

    const relayed = await lab.factory('worker', relayArgs, caller);

    expect(relayed.code, relayed.stderr).toBe(0);
    expect(await readFile(typed('alpha'), 'utf8')).toBe(
      `[From Test Owner, typed by demo at the owner's explicit instruction, ${date}] Decision D-1: a. Read it: factory decide read D-1\n`,
    );
    await expect(readFile(typed('beta'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, LIFECYCLE_CASE_MS);

  it.skipIf(gate !== 'run')('refuses a relayed answer and sends no line to the target worker', async () => {
    const caller = await prepareRequest();
    await writeFile(typed('alpha'), '');
    const closed = await lab.factory('request', ['close', 'D-1', '--relayed', '--decision', 'Yes'], caller);
    expect(closed.code, closed.stderr).toBe(0);

    const relayed = await lab.factory('worker', relayArgs, caller);

    expect(relayed.code, relayed.stderr).toBe(1);
    expect(relayed.stderr).toContain('answer relayed by the coordinator; no owner proof');
    expect(relayed.stderr).toContain('Use a decision that the owner records with "factory decide".');
    expect(await readFile(typed('alpha'), 'utf8')).toBe('');
  }, LIFECYCLE_CASE_MS);
});
