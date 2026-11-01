import { mkdir, readdir, writeFile } from 'node:fs/promises';
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

  it('keeps the last 5 backups, and leaves the run-time folders out of the new backup', async () => {
    await initNode();
    const stateDir = join(box.node, '.factory');
    await mkdir(join(stateDir, 'state'), { recursive: true });
    await writeFile(join(stateDir, 'state', 'run.json'), '{}');
    await mkdir(join(stateDir, 'locks'), { recursive: true });
    await writeFile(join(stateDir, 'locks', 'lane.lock'), '1');
    for (let day = 1; day <= 6; day += 1) {
      await mkdir(join(stateDir, 'backups', `2020-01-0${day}T00-00-00-000Z`), { recursive: true });
    }
    await editCoordinator();

    const upgraded = await box.run(['upgrade', '--home', box.node, '--overwrite', 'coordinator']);
    expect(upgraded.code).toBe(0);

    const names = (await readdir(join(stateDir, 'backups'))).sort();
    expect(names).toHaveLength(5);
    expect(names.slice(0, 4)).toEqual([3, 4, 5, 6].map((day) => `2020-01-0${day}T00-00-00-000Z`));
    const saved = await readdir(join(stateDir, 'backups', names[4] ?? '?', '.factory'));
    expect(saved).toContain('node.json');
    expect(saved).not.toContain('state');
    expect(saved).not.toContain('locks');
    expect(await box.read(join(stateDir, 'state', 'run.json'))).toBe('{}');
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
