import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

const initNode = async (): Promise<void> => {
  const result = await box.run(['init', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner']);
  expect(result.code).toBe(0);
};

const editCoordinator = async (): Promise<string> => {
  const path = join(box.node, 'CLAUDE.md');
  const text = await box.read(path);
  const edited = text.replace('Coordinate. Do not produce.', 'Do as you like.');
  expect(edited).not.toBe(text);
  await writeFile(path, edited);
  return edited;
};

describe('factory upgrade (built binary)', () => {
  it('has nothing to do on a fresh node and exits 0', async () => {
    await initNode();
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing to upgrade.');
  });

  it('prints one JSON document with its schema id', async () => {
    await initNode();
    const result = await box.run(['upgrade', '--home', box.node, '--dry-run', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'factory.upgrade/v1', changed: false, dryRun: true });
  });

  it('refuses an edited block with exit 4 and leaves the file as it is', async () => {
    await initNode();
    const edited = await editCoordinator();
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('block coordinator was edited');
    expect(result.stderr).toContain('--overwrite coordinator');
    expect(await box.read(join(box.node, 'CLAUDE.md'))).toBe(edited);
  });

  it('replaces the edited block when it is named, and the doctor finds all blocks intact', async () => {
    await initNode();
    await editCoordinator();
    const upgraded = await box.run(['upgrade', '--home', box.node, '--overwrite', 'coordinator']);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 1 file.');
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('3 managed blocks are intact');
  });

  it('exits 2 for the name of a block that does not exist', async () => {
    await initNode();
    const result = await box.run(['upgrade', '--home', box.node, '--overwrite', 'nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown block nope');
  });

  it('exits 1 when there is no config file above the folder', async () => {
    const result = await box.run(['upgrade'], { cwd: box.root });
    expect(result.code).toBe(1);
  });
});
