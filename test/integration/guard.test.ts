import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInTerminal, scriptGate } from './fake-terminal.js';
import { DIST, makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';
import { scaled } from './load.js';

const gate = scriptGate();
if (gate === 'skip') console.warn('guard.test.ts is skipped: the program script is not installed.');

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

describe('factory guard (built binary)', () => {
  it.runIf(gate === 'fail')('needs the program script, because the variable CI is set', () => {
    throw new Error('the program script is not installed, and the tests run with CI set');
  });

  it.skipIf(gate !== 'run')('confirms the owner prefix and keeps a local guard off for an own factory', async () => {
    const init = await box.run(['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner']);
    expect(init.code, init.stderr).toBe(0);

    const confirmed = await runInTerminal(box, [process.execPath, DIST, 'guard', 'confirm', '--home', box.node], {
      cwd: box.node,
      exchanges: [{ prompt: /Confirm this owner prefix\? \[y\/N\] $/, answer: 'y' }],
    });
    expect(confirmed.code, confirmed.screen).toBe(0);

    const set = await runInTerminal(box, [process.execPath, DIST, 'guard', 'set', 'install-rules', 'off', '--home', box.node], {
      cwd: box.node,
      exchanges: [{ prompt: /Turn these guards off\? \[y\/N\] $/, answer: 'y' }],
    });
    expect(set.code, set.screen).toBe(0);

    const storeFolder = join(box.env['HOME'] ?? '', '.local', 'state', 'factory');
    expect((await stat(join(storeFolder, 'guard-records.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(storeFolder)).mode & 0o777).toBe(0o700);

    const listed = await box.run(['guard', 'list', '--json', '--home', box.node]);
    expect(listed.code, listed.stderr).toBe(0);
    const report: unknown = JSON.parse(listed.stdout);
    expect(report).toMatchObject({
      guards: expect.arrayContaining([expect.objectContaining({ id: 'install-rules', value: 'off', source: 'local' })]),
    });

    const start = await box.run(['start', '--dry-run', '--home', box.node]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain('Dry run');
    expect(start.stdout).not.toContain('owner prefix has no record');
  }, scaled(120_000));
});
