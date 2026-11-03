import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { oldWordsIn } from '../helpers/old-words.js';
import { makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

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

  it('exits 2, names init and writes nothing when factory.yaml has no factory.local.yaml next to it', async () => {
    await initNode();
    await rm(join(box.node, 'factory.local.yaml'));
    const before = await box.read(join(box.node, 'factory.yaml'));
    for (const args of [['upgrade', '--home', box.node], ['upgrade', '--home', box.node, '--dry-run']]) {
      const result = await box.run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('factory.local.yaml not found');
      expect(result.stderr).toContain('factory init');
    }
    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(before);
    expect(existsSync(join(box.node, 'factory.local.yaml'))).toBe(false);
  });

  it('exits 4 for a local file that others can write, names the chmod command and changes no mode', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o660);
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('chmod 600 factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o660);
  });

  it('sets a local file that others can read back to mode 600 with a notice, and goes on', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    await chmod(path, 0o644);
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
    await writeFile(join(stateDir, 'locks', 'worker.lock'), '1');
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

  it('exits 2 when there is no config file above the folder and no entry of the home index', async () => {
    const result = await box.run(['upgrade'], { cwd: box.root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--home DIR');
  });
});

describe('factory upgrade of a FAC-M1 node (the committed fixture)', () => {
  const FIXTURE = join(__dirname, '..', 'fixtures', 'node-0.1.0');

  /** Commit every change of the state repository, as the owner would. */
  const commitAll = async (state: string, message: string): Promise<void> => {
    expect((await box.git(state, ['add', '-A'])).code).toBe(0);
    expect((await box.git(state, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])).code).toBe(0);
  };

  /** Copy the fixture, make the web project, and start the state repository with a first commit. */
  const prepareOldNode = async (): Promise<string> => {
    await cp(FIXTURE, box.node, { recursive: true });
    const marker = JSON.parse(await box.read(join(box.node, '.factory', 'node.json'))) as Record<string, unknown>;
    expect(marker['created_with']).toBe('0.1.0');
    expect(marker['schema_version']).toBe(1);
    await box.makeProject('web');
    const state = join(box.node, '.factory');
    expect((await box.git(state, ['init', '-q'])).code).toBe(0);
    await commitAll(state, 'first');
    return state;
  };

  /** A new node of the current version: its files are the oracle for the text of an upgraded node. */
  const freshNode = async (): Promise<string> => {
    const home = join(box.root, 'fresh');
    const result = await box.run(['init', '--home', home, '--name', 'fresh', '--owner-name', 'Test Owner']);
    expect(result.code).toBe(0);
    return join(home, '.factory');
  };

  /** The files of a node that the tool writes. The state repository and the backups are left out. */
  const nodeFiles = async (home: string): Promise<string[]> => {
    const entries = await readdir(home, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => {
        const parts = relative(home, path).split(sep);
        return !parts.includes('.git') && !(parts[0] === '.factory' && parts[1] === 'backups');
      })
      .sort();
  };

  /**
   * The old words (lane, pack, brief) in the files of a node, for each file. A comment of factory.yaml is text of the
   * owner, which the upgrade keeps, so the scan skips the comments there.
   */
  const oldWordsByFile = async (home: string): Promise<Record<string, string[]>> => {
    const found: Record<string, string[]> = {};
    for (const path of await nodeFiles(home)) {
      const raw = await box.read(path);
      const text = path.endsWith('.yaml') ? raw.replace(/(^|\s)#.*$/gm, '') : raw;
      const words = oldWordsIn(text);
      if (words.length > 0) found[relative(home, path)] = words;
    }
    return found;
  };

  it('upgrades to schema 2 with a local tracker, and then the doctor exits 0', async () => {
    const state = await prepareOldNode();
    const upgraded = await box.run(['upgrade', '--home', box.node]);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 8 files.');

    const config = await box.read(join(box.node, 'factory.yaml'));
    expect(config).toContain('schema: 2');
    expect(config).toContain('layer: 1');
    expect(config).toContain('tracker:\n  kind: local');
    expect(config).toContain('recipe:\n  id: software');
    expect(config).not.toMatch(/^\s*(?:role|lanes|pack|owner|parent|children|proxies):/m);
    const local = await box.read(join(box.node, 'factory.local.yaml'));
    expect(local).toContain('schema: 1');
    expect(local).toContain('parent: null');
    expect(local).toContain('owner:');
    expect((await stat(join(box.node, 'factory.local.yaml'))).mode & 0o777).toBe(0o600);

    const names = (await readdir(state)).sort();
    expect(names).not.toContain('protocol.md');
    expect(names).not.toContain('briefs');
    expect(names).toContain('orders');
    expect(await readdir(join(state, 'roles'))).toEqual(['worker.md']);
    const node = JSON.parse(await box.read(join(state, 'node.json'))) as Record<string, unknown>;
    expect(node).toMatchObject({ schema_version: 2, blocks: { coordinator: 2, safety: 2, worker: 1 } });

    const changes = await box.git(state, ['diff', '--name-status', '-M', 'HEAD~1', 'HEAD']);
    expect(changes.stdout).toContain('protocol.md');
    expect(changes.stdout).toContain('roles/worker.md');
    expect(changes.stdout).toContain('roadmaps/README.md');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
  });

  it('leaves no old word in the files of the upgraded node, and gives it the text of a new node', async () => {
    const state = await prepareOldNode();
    // The scan sees the old words before the upgrade, so an empty result afterwards is not a blind scan.
    const before = await oldWordsByFile(box.node);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'factory.yaml', '.factory/protocol.md', '.factory/roadmaps/README.md']),
    );

    const upgraded = await box.run(['upgrade', '--home', box.node]);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stderr).toBe('');

    expect(await oldWordsByFile(box.node)).toEqual({});
    const fresh = await freshNode();
    expect(await box.read(join(state, 'roles', 'worker.md'))).toBe(await box.read(join(fresh, 'roles', 'worker.md')));
    expect(await box.read(join(state, 'roadmaps', 'README.md'))).toBe(
      await box.read(join(fresh, 'roadmaps', 'README.md')),
    );
  });

  it('keeps a roadmap README that the owner edited, says so, and leaves the edit out of the commit', async () => {
    const state = await prepareOldNode();
    const path = join(state, 'roadmaps', 'README.md');
    const edited = `${await box.read(path)}\n## Our own track rules\n`;
    await writeFile(path, edited);

    const upgraded = await box.run(['upgrade', '--home', box.node]);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 7 files.');
    expect(upgraded.stderr).toContain('.factory/roadmaps/README.md was edited, so factory keeps it');
    expect(upgraded.stderr).toContain('factory help words');
    expect(await box.read(path)).toBe(edited);
    expect((await box.git(state, ['status', '--porcelain'])).stdout.trim()).toBe('M roadmaps/README.md');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
  });

  it('shows the plan in a dry run and changes no file', async () => {
    const state = await prepareOldNode();
    const before = await box.read(join(box.node, 'factory.yaml'));
    const result = await box.run(['upgrade', '--home', box.node, '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('move .factory/protocol.md to .factory/roles/worker.md');
    expect(result.stdout).toContain('move .factory/briefs to .factory/orders');
    expect(result.stdout).toContain('replace .factory/roadmaps/README.md with the new text');
    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(before);
    expect((await readdir(state)).sort()).toContain('protocol.md');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('refuses an edited protocol block with exit 4 until it is named', async () => {
    const state = await prepareOldNode();
    const path = join(state, 'protocol.md');
    const text = await box.read(path);
    const line = text.split('\n').find((candidate) => candidate.length > 30 && !candidate.startsWith('<!--')) ?? '';
    expect(line).not.toBe('');
    await writeFile(path, text.replace(line, 'My own rule for the workers.'));

    const refused = await box.run(['upgrade', '--home', box.node]);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain('block protocol was edited');
    expect(refused.stderr).toContain('--overwrite protocol');
    expect((await readdir(state)).sort()).toContain('protocol.md');

    // The upgrade moves the file, so a change of the owner in it must be in a commit before the upgrade runs.
    await commitAll(state, 'my rule for the workers');
    const upgraded = await box.run(['upgrade', '--home', box.node, '--overwrite', 'protocol']);
    expect(upgraded.code).toBe(0);
    expect(await box.read(join(state, 'roles', 'worker.md'))).not.toContain('My own rule for the workers.');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
  });

  it('refuses an uncommitted change in a file that the upgrade moves, and changes nothing', async () => {
    const state = await prepareOldNode();
    const path = join(state, 'protocol.md');
    const edited = `${await box.read(path)}\nA note of the owner, outside the block.\n`;
    await writeFile(path, edited);
    const config = await box.read(join(box.node, 'factory.yaml'));
    const marker = await box.read(join(state, 'node.json'));

    const refused = await box.run(['upgrade', '--home', box.node]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('.factory has changes in files that the upgrade changes: protocol.md');
    expect(refused.stderr).toContain('Commit them');

    expect(await box.read(path)).toBe(edited);
    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(config);
    expect(await box.read(join(state, 'node.json'))).toBe(marker);
    const names = (await readdir(state)).sort();
    expect(names).toContain('briefs');
    expect(names).not.toContain('roles');
    expect(names).not.toContain('orders');
    expect(names).not.toContain('backups');
    expect((await box.git(state, ['log', '--format=%s'])).stdout.trim()).toBe('first');

    await commitAll(state, 'a note of the owner');
    expect((await box.run(['upgrade', '--home', box.node])).code).toBe(0);
    expect(await box.read(join(state, 'roles', 'worker.md'))).toContain('A note of the owner, outside the block.');
  });

  it('stops on a child with an ssh address, names the child, and changes nothing', async () => {
    const state = await prepareOldNode();
    const path = join(box.node, 'factory.yaml');
    const text = await box.read(path);
    expect(text).toContain('children: []');
    const edited = text.replace('children: []', 'children:\n  - id: team-a\n    address: "ssh://deploy@host/work"');
    await writeFile(path, edited);

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('children[0] "team-a"');
    expect(result.stderr).not.toContain('deploy@host');
    expect(await box.read(path)).toBe(edited);
    expect((await readdir(state)).sort()).toContain('protocol.md');
  });
});
