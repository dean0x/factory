import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestHash, type ManifestEntry } from '../../src/core/setup-acceptance.js';
import { boardKeys, hookNames, setupAcceptance, stateLock } from '../../src/names.js';
import { softwareQueueKey } from '../../src/recipes/software/words.js';
import { oldWordsIn } from '../helpers/old-words.js';
import { DIST, makeSandbox, removeOpenSandboxes, withoutHookNotice, withoutTmux, type RunResult, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const initNode = async (): Promise<void> => {
  const result = await box.run(['init', '--yes', '--home', box.node, '--name', 'demo', '--owner-name', 'Test Owner']);
  expect(result.code).toBe(0);
};

/** Run a program with a given environment. The sandbox runs the built program only, so a test of a copy needs this. */
const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, env, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });

const COORDINATOR_FILE =['coordinator', 'CLAUDE.md'] as const;

interface StoredAcceptance {
  manifest: unknown;
  hash: string;
}

/**
 * Record the acceptance of the setup files as they are on disk now. The owner does this in a terminal window with `start`
 * or `upgrade`, and the built binary has no terminal window, so the test writes the record of that step by hand.
 */
const acceptSetupFiles = async (): Promise<void> => {
  const store = join(box.root, 'home', '.local', 'state', 'factory', 'setup-acceptances.json');
  const stored = JSON.parse(await box.read(store)) as { acceptances: StoredAcceptance[] };
  const entries: ManifestEntry[] = [];
  for (const path of setupAcceptance.setupTextFiles) {
    const text = await box.read(join(box.node, path));
    entries.push({
      path,
      type: 'file',
      size: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      blob: null,
    });
  }
  const record = stored.acceptances[0];
  expect(record).toBeDefined();
  if (record === undefined) return;
  record.manifest = entries;
  record.hash = manifestHash(entries);
  await writeFile(store, JSON.stringify(stored));
};

const editCoordinator = async (): Promise<string> => {
  const path = join(box.node, ...COORDINATOR_FILE);
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

  describe('the delete guard of the state repo (TP-4, TP-5, TP-53)', () => {
    const stateOf = (): string => join(box.node, '.factory');
    const guardOf = async (): Promise<string> => join(await realpath(stateOf()), '.git', 'factory-guard');
    const headOf = async (): Promise<string> => (await box.git(stateOf(), ['rev-parse', 'HEAD'])).stdout.trim();

    it('names the missing guard in a dry run and changes nothing', async () => {
      await initNode();
      const hook = join(await guardOf(), 'pre-commit');
      await rm(hook);
      const dry = await box.run(['upgrade', '--home', box.node, '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.stdout).toContain('.factory/.git/factory-guard: write the delete guard hook and point core.hooksPath at it');
      expect(existsSync(hook)).toBe(false);
      expect(JSON.parse((await box.run(['upgrade', '--home', box.node, '--dry-run', '--json'])).stdout)).toMatchObject({
        changed: true,
        stateGuard: 'install',
      });
    });

    it('writes the missing guard and makes no backup and no commit when nothing else changes', async () => {
      await initNode();
      const hook = join(await guardOf(), 'pre-commit');
      const text = await box.read(hook);
      await rm(hook);
      const head = await headOf();
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Wrote the delete guard in .factory/.git/factory-guard.');
      expect(await box.read(hook)).toBe(text);
      expect((await stat(hook)).mode & 0o777).toBe(0o755);
      expect(await headOf()).toBe(head);
      expect(await readdir(stateOf())).not.toContain('backups');
      expect((await box.git(stateOf(), ['status', '--porcelain'])).stdout).toBe('');
      expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
    });

    it('repairs a setting that points elsewhere', async () => {
      await initNode();
      expect((await box.git(stateOf(), ['config', 'core.hooksPath', '/nonexistent'])).code).toBe(0);
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect((await box.git(stateOf(), ['config', 'core.hooksPath'])).stdout.trim()).toBe(await guardOf());
    });

    it('changes neither the setting, nor the guard folder, nor a backup when the ready check of the state repo refuses', async () => {
      await initNode();
      const state = stateOf();
      const guard = await guardOf();
      // The guard is off in two ways: another setting, and a missing hook file.
      expect((await box.git(state, ['config', '--local', 'core.hooksPath', '/nonexistent'])).code).toBe(0);
      await rm(join(guard, 'pre-commit'));
      // The state repo lacks a line of its .gitignore, so the upgrade has a file to commit, and a staged file stops the upgrade.
      await writeFile(join(state, '.gitignore'), 'state/\nlocks/\nbackups/\n');
      expect((await box.git(state, ['add', '.gitignore'])).code).toBe(0);
      expect((await box.git(state, ['commit', '-q', '-m', 'drop a line'])).code).toBe(0);
      await writeFile(join(state, 'note.txt'), 'staged');
      expect((await box.git(state, ['add', 'note.txt'])).code).toBe(0);
      const hooksBefore = await readdir(guard);

      const refused = await box.run(['upgrade', '--home', box.node]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('staged changes');
      expect((await box.git(state, ['config', '--local', 'core.hooksPath'])).stdout.trim()).toBe('/nonexistent');
      expect(await readdir(guard)).toEqual(hooksBefore);
      expect(await readdir(state)).not.toContain('backups');
      expect((await box.git(state, ['log', '--format=%s'])).stdout.trim().split('\n')[0]).toBe('drop a line');
    });

    it('names a hook file that stops, runs no hook, and the stopped hook does not run at a later commit', async () => {
      await initNode();
      const state = stateOf();
      const marker = join(box.root, 'old-hook-ran');
      const hooks = join(await realpath(state), '.git', 'hooks');
      await mkdir(hooks, { recursive: true });
      await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\n: > '${marker}'\n`);
      await chmod(join(hooks, 'pre-commit'), 0o755);
      expect((await box.git(state, ['config', '--local', '--unset', 'core.hooksPath'])).code).toBe(0);

      // Before the upgrade the hook runs at a commit.
      await writeFile(join(state, 'first.txt'), 'first');
      expect((await box.git(state, ['add', 'first.txt'])).code).toBe(0);
      expect((await box.git(state, ['commit', '-q', '-m', 'first'])).code).toBe(0);
      expect(existsSync(marker)).toBe(true);
      await rm(marker);

      const dry = await box.run(['upgrade', '--home', box.node, '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.stderr).toContain('.factory/.git/hooks/pre-commit');
      expect(dry.stderr).toContain('stop running');
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('.factory/.git/hooks/pre-commit');
      expect(existsSync(marker)).toBe(false);

      await writeFile(join(state, 'second.txt'), 'second');
      expect((await box.git(state, ['add', 'second.txt'])).code).toBe(0);
      expect((await box.git(state, ['commit', '-q', '-m', 'second'])).code).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    it('names the folder of a core.hooksPath of the global config, which the guard replaces', async () => {
      await initNode();
      const state = stateOf();
      const global = join(box.root, 'global-hooks');
      await mkdir(global);
      expect((await box.git(box.root, ['config', '--global', 'core.hooksPath', global])).code).toBe(0);
      expect((await box.git(state, ['config', '--local', '--unset', 'core.hooksPath'])).code).toBe(0);
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(`the hooks in ${global}, which core.hooksPath names`);
      expect((await box.git(state, ['config', 'core.hooksPath'])).stdout.trim()).toBe(await guardOf());
    });

    it('warns, exits 0 and leaves the folder of the link as it was when the guard folder is a link', async () => {
      await initNode();
      const guard = await guardOf();
      const elsewhere = join(box.root, 'elsewhere');
      await mkdir(elsewhere);
      await writeFile(join(elsewhere, 'keep.txt'), 'keep');
      await writeFile(join(elsewhere, 'pre-commit'), 'other hook');
      await rm(guard, { recursive: true });
      await symlink(elsewhere, guard);
      const dry = JSON.parse((await box.run(['upgrade', '--home', box.node, '--dry-run', '--json'])).stdout);
      expect(dry.stateGuard).toBe('unsupported');
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('The delete guard of .factory is off');
      expect(result.stderr).toContain('Move .factory/.git/factory-guard away.');
      expect(result.stderr).not.toContain('factory upgrade');
      expect((await readdir(elsewhere)).sort()).toEqual(['keep.txt', 'pre-commit']);
      expect(await box.read(join(elsewhere, 'pre-commit'))).toBe('other hook');
      expect((await lstat(guard)).isSymbolicLink()).toBe(true);
    });

    it('warns, exits 0 and leaves the .git file as it was when the .git entry of the state folder is a file', async () => {
      await initNode();
      const git = join(stateOf(), '.git');
      const moved = join(box.root, 'moved-git');
      await rename(git, moved);
      await writeFile(git, `gitdir: ${moved}\n`);
      const result = await box.run(['upgrade', '--home', box.node]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Make .factory/.git the git folder of .factory.');
      expect(result.stderr).not.toContain('factory upgrade');
      expect(await box.read(git)).toBe(`gitdir: ${moved}\n`);
    });
  });

  describe('the git steps of the state commit run no program that the state repo names (TP-17)', () => {
    const stateOf = (): string => join(box.node, '.factory');
    const markerOf = (name: string): string => join(box.root, 'markers', name);
    const writeProgram = async (path: string, marker: string): Promise<void> => {
      await writeFile(path, `#!/bin/sh\n: > '${marker}'\n`);
      await chmod(path, 0o755);
    };

    it('commits the upgrade with no file monitor program, no hook file and no guard program started', async () => {
      await initNode();
      const state = stateOf();
      // A read of the test uses the file monitor off, so that it leaves no marker of its own.
      const quiet = (args: readonly string[]): ReturnType<Sandbox['git']> => box.git(state, ['-c', 'core.fsmonitor=', ...args]);

      // The state repo lacks a line of its .gitignore, so the upgrade has a file to commit.
      await writeFile(join(state, '.gitignore'), 'state/\nlocks/\nbackups/\n');
      expect((await quiet(['add', '.gitignore'])).code).toBe(0);
      expect((await quiet(['commit', '-q', '-m', 'drop a line'])).code).toBe(0);
      const before = Number((await quiet(['rev-list', '--count', 'HEAD'])).stdout.trim());

      await mkdir(join(box.root, 'markers'));
      const monitor = join(box.root, 'file-monitor.sh');
      await writeProgram(monitor, markerOf('file-monitor'));
      expect((await quiet(['config', 'core.fsmonitor', monitor])).code).toBe(0);
      const hooks = join(await realpath(state), '.git', 'hooks');
      await mkdir(hooks, { recursive: true });
      await writeProgram(join(hooks, 'pre-commit'), markerOf('pre-commit'));
      await writeProgram(join(hooks, 'post-commit'), markerOf('post-commit'));

      // A copy of the built program that marks each start of the guard: git starts the guard only when the hooks are on.
      const source = await box.read(DIST);
      const lineEnd = source.indexOf('\n') + 1;
      const copy = join(box.root, 'factory-marked.js');
      const mark = `import { writeFileSync as markStart } from 'node:fs';\nif (process.argv.includes('guard')) markStart(${JSON.stringify(markerOf('guard'))}, '');\n`;
      await writeFile(copy, `${source.slice(0, lineEnd)}${mark}${source.slice(lineEnd)}`);

      const upgraded = await run('node', [copy, 'upgrade', '--home', box.node], box.root, withoutTmux(box.env));
      expect(upgraded.code, upgraded.stderr).toBe(0);

      expect(Number((await quiet(['rev-list', '--count', 'HEAD'])).stdout.trim())).toBe(before + 1);
      expect((await quiet(['show', '--name-only', '--format=', 'HEAD'])).stdout.split('\n')).toContain('.gitignore');
      for (const name of ['file-monitor', 'pre-commit', 'post-commit', 'guard']) {
        expect(existsSync(markerOf(name)), `${name} ran`).toBe(false);
      }
    });
  });

  it('renders a changed setup text into the setup block, and a changed prefix into the safety block (TP-76, TP-102)', async () => {
    await initNode();
    await writeFile(join(box.node, 'setup', 'coordinator.md'), 'Our team rules.\n');
    await acceptSetupFiles();
    const local = join(box.node, 'factory.local.yaml');
    const before = await box.read(local);
    expect(before).toContain('typed by');
    await writeFile(local, before.replace('typed by', 'sent by'));

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('block setup: render the text again');
    expect(result.stdout).toContain('block safety: render the text again');
    const claude = await box.read(join(box.node, ...COORDINATOR_FILE));
    expect(claude).toContain('Our team rules.');
    expect(claude).toContain('sent by');
    expect(claude.indexOf('factory:begin setup')).toBeGreaterThan(claude.indexOf('factory:end safety'));

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('5 managed blocks are intact');
    expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
  });

  it('exits 4 for a setup text that changed after the acceptance, with no terminal window, and writes nothing (TP-177)', async () => {
    await initNode();
    await writeFile(join(box.node, 'setup', 'coordinator.md'), 'Our team rules.\n');
    const claude = await box.read(join(box.node, ...COORDINATOR_FILE));
    for (const args of [
      ['upgrade', '--home', box.node],
      ['upgrade', '--home', box.node, '--yes'],
      ['upgrade', '--home', box.node, '--dry-run'],
    ]) {
      const result = await box.run(args);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('setup/coordinator.md');
      expect(result.stderr).toContain('Run "factory start" or "factory upgrade" in a terminal window outside a factory session.');
    }
    expect(await box.read(join(box.node, ...COORDINATOR_FILE))).toBe(claude);
    expect(existsSync(join(box.node, '.factory', 'backups'))).toBe(false);
  });

  it('exits 1 for a setup text that holds a marker line, and writes nothing (TP-102)', async () => {
    await initNode();
    await writeFile(join(box.node, 'setup', 'coordinator.md'), '<!-- factory:begin safety v2 sha256=abc -->\n');
    const claude = await box.read(join(box.node, ...COORDINATOR_FILE));
    for (const args of [['upgrade', '--home', box.node], ['upgrade', '--home', box.node, '--dry-run']]) {
      const result = await box.run(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('setup/coordinator.md holds a line that starts a managed block');
    }
    expect(await box.read(join(box.node, ...COORDINATOR_FILE))).toBe(claude);
    expect(existsSync(join(box.node, '.factory', 'backups'))).toBe(false);
  });

  it.each([
    ['the setup text', ['setup', 'coordinator.md'], 'setup/coordinator.md'],
    ['the coordinator CLAUDE.md', ['coordinator', 'CLAUDE.md'], 'coordinator/CLAUDE.md'],
    ['the coordinator folder', ['coordinator'], 'coordinator'],
    ['the setup folder', ['setup'], 'setup'],
  ])('exits 4 for a real link at %s, writes nothing and makes no backup, also in a dry run (TP-130)', async (_name, parts, shown) => {
    await initNode();
    const path = join(box.node, ...parts);
    const outside = join(box.root, 'outside');
    await rename(path, outside);
    await symlink(outside, path);
    for (const args of [['upgrade', '--home', box.node], ['upgrade', '--home', box.node, '--dry-run']]) {
      const result = await box.run(args);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain(`${shown} is a link, so factory does not use it`);
      expect(result.stderr).toContain('Replace the link with a plain file inside the factory folder, then run "factory doctor".');
    }
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(box.node, '.factory', 'backups'))).toBe(false);
  });

  it('exits 4 for a local file that is a link, before the mode fix (TP-147)', async () => {
    await initNode();
    const path = join(box.node, 'factory.local.yaml');
    const outside = join(box.root, 'outside.yaml');
    await rename(path, outside);
    await chmod(outside, 0o644);
    await symlink(outside, path);
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('factory.local.yaml is a link, so factory does not use it');
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
  });

  it('works for a node home under a linked parent folder, and stops only for a link below the home (TP-149)', async () => {
    const real = join(box.root, 'real-parent');
    const linked = join(box.root, 'linked-parent');
    await mkdir(real, { recursive: true });
    await symlink(real, linked);
    const home = join(linked, 'factory');
    const init = await box.run(['init', '--yes', '--home', home, '--name', 'demo', '--owner-name', 'Test Owner']);
    expect({ code: init.code, stderr: withoutHookNotice(init.stderr) }).toEqual({ code: 0, stderr: '' });
    const upgrade = await box.run(['upgrade', '--home', home]);
    expect(upgrade.code).toBe(0);
    expect(upgrade.stdout).toContain('Nothing to upgrade.');
    expect((await box.run(['doctor', '--home', home])).code).toBe(0);

    const claude = join(real, 'factory', 'coordinator', 'CLAUDE.md');
    await rename(claude, join(box.root, 'outside-claude.md'));
    await symlink(join(box.root, 'outside-claude.md'), claude);
    const stopped = await box.run(['upgrade', '--home', home]);
    expect(stopped.code).toBe(4);
    expect(stopped.stderr).toContain('coordinator/CLAUDE.md is a link');
  });

  it('stops with exit 4 and writes nothing for a copy of a node in a folder that the home index does not list', async () => {
    await initNode();
    const copy = join(box.root, 'copy-of-node');
    await cp(box.node, copy, { recursive: true });
    const before = await box.read(join(copy, 'factory.yaml'));
    for (const args of [['upgrade', '--home', copy], ['upgrade', '--home', copy, '--dry-run']]) {
      const result = await box.run(args);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('the factory list has no entry for');
    }
    expect(await box.read(join(copy, 'factory.yaml'))).toBe(before);
    expect(existsSync(join(copy, '.factory', 'backups'))).toBe(false);
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

  it('keeps an edited role block with a warning that names the flag, exits 0 and leaves the file as it is', async () => {
    await initNode();
    const edited = await editCoordinator();
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('block coordinator was edited');
    expect(result.stderr).toContain('--overwrite coordinator');
    expect(await box.read(join(box.node, ...COORDINATOR_FILE))).toBe(edited);
  });

  it('refuses an edited safety block with exit 4, names the overwrite command and leaves the file as it is', async () => {
    await initNode();
    const path = join(box.node, ...COORDINATOR_FILE);
    const text = await box.read(path);
    const start = text.indexOf('<!-- factory:begin safety');
    expect(start).toBeGreaterThan(-1);
    const edited = `${text.slice(0, start)}${text.slice(start).replace(/\n([^<\n][^\n]*)\n/, '\nEdited safety line.\n')}`;
    expect(edited).not.toBe(text);
    await writeFile(path, edited);

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('block safety was edited');
    expect(result.stderr).toContain('factory upgrade --overwrite safety');
    expect(await box.read(path)).toBe(edited);
  });

  it('exits 4 for the safety block with FACTORY_SESSION set, also with yes, and writes nothing (TP-132)', async () => {
    await initNode();
    const path = join(box.node, ...COORDINATOR_FILE);
    const text = await box.read(path);
    const at = text.indexOf('<!-- factory:begin safety');
    const edited = `${text.slice(0, at)}${text.slice(at).replace('Never skip permissions', 'Skip permissions')}`;
    expect(edited).not.toBe(text);
    await writeFile(path, edited);
    const backups = join(box.node, '.factory', 'backups');
    const before = existsSync(backups) ? (await readdir(backups)).sort() : [];

    for (const extra of [[], ['--yes'], ['--dry-run']]) {
      const result = await box.run(['upgrade', '--home', box.node, '--overwrite', 'safety', ...extra], {
        env: { FACTORY_SESSION: 'demo' },
      });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain('factory upgrade --overwrite safety');
      expect(result.stderr).toContain('terminal window');
    }
    expect(await box.read(path)).toBe(edited);
    expect(existsSync(backups) ? (await readdir(backups)).sort() : []).toEqual(before);
  });

  it('puts back an edited setup block with no flag, and keeps the old text in a backup file (TP-142)', async () => {
    await initNode();
    const path = join(box.node, ...COORDINATOR_FILE);
    const text = await box.read(path);
    const edited = text.replace('Write your own text', 'Changed by hand');
    expect(edited).not.toBe(text);
    await writeFile(path, edited);

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('setup (edited');
    expect(doctor.stdout).toContain('setup/coordinator.md');

    const upgraded = await box.run(['upgrade', '--home', box.node]);
    expect(upgraded.code).toBe(0);
    expect(await box.read(path)).toBe(text);
    const saved = (await readdir(join(box.node, '.factory', 'backups'))).filter((name) => name.endsWith('-block-setup.md'));
    expect(saved).toHaveLength(1);
    expect(await box.read(join(box.node, '.factory', 'backups', saved[0] ?? '?'))).toContain('Changed by hand');
    expect((await box.run(['doctor', '--home', box.node])).stdout).toContain('5 managed blocks are intact');
  });

  it('replaces the edited block when it is named, and the doctor finds all blocks intact', async () => {
    await initNode();
    await editCoordinator();
    const upgraded = await box.run(['upgrade', '--home', box.node, '--overwrite', 'coordinator']);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 1 file.');
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('5 managed blocks are intact');
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

    // The backup file of the replaced block is not a backup folder, and the count of 5 does not cover it.
    const names = (await readdir(join(stateDir, 'backups'))).filter((name) => !name.includes('-block-')).sort();
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

describe('factory upgrade of the queue key of the board (built binary, TP-30, TP-100, TP-101)', () => {
  const stateOf = (): string => join(box.node, '.factory');
  const boardFile = (): string => join(stateOf(), 'board.json');
  const lockFile = (): string => join(stateOf(), 'locks', `${stateLock.name}${stateLock.lock.suffix}`);

  /** A board in the form of the writers: the queue under `key`, and one open item for each id. */
  const boardWith = (key: string, ids: readonly string[]): string =>
    `${JSON.stringify({ [key]: [], items: ids.map((id) => ({ id, title: 'A title', status: 'open' })), tracks: [] }, null, 2)}\n`;

  /** A new node, with the board that an older factory left: the queue under the key "queue", committed in the state repo. */
  const leaveOldBoard = async (ids: readonly string[]): Promise<void> => {
    await initNode();
    await writeFile(boardFile(), boardWith(boardKeys.defaultQueue, ids));
    expect((await box.git(stateOf(), ['add', '-A'])).code).toBe(0);
    expect((await box.git(stateOf(), ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'an old board'])).code).toBe(0);
  };

  const subjects = async (): Promise<string[]> => (await box.git(stateOf(), ['log', '--format=%s'])).stdout.trim().split('\n');

  it('M5-1b TP-30 renames the key in the one upgrade commit, and then the board commands work', async () => {
    await leaveOldBoard(['B-1', 'B-2']);
    const blocked = await box.run(['item', 'list', '--home', box.node]);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('factory upgrade');

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(await box.read(boardFile())).toBe(boardWith(softwareQueueKey, ['B-1', 'B-2']));
    expect((await subjects()).slice(0, 2)).toEqual(['chore: upgrade the state', 'an old board']);
    expect((await box.git(stateOf(), ['show', '--stat', '--format=', 'HEAD'])).stdout).toContain('board.json');
    expect((await box.git(stateOf(), ['status', '--porcelain'])).stdout).toBe('');
    expect(existsSync(lockFile())).toBe(false);
    expect((await box.run(['item', 'list', '--home', box.node])).code).toBe(0);
    expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
  });

  it('M5-1b TP-30 exits 1, names board.json and changes nothing when the board has both keys', async () => {
    await initNode();
    const both = `{\n  "${boardKeys.defaultQueue}": [],\n  "${softwareQueueKey}": [],\n  "items": []\n}\n`;
    await writeFile(boardFile(), both);
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('board.json');
    expect(await box.read(boardFile())).toBe(both);
    expect(await readdir(stateOf())).not.toContain('backups');
  });

  it('M5-1b TP-101 exits 4 and changes no file when the new board text drops an item id that the last commit holds', async () => {
    await leaveOldBoard(['B-1', 'B-2']);
    // The work tree board lost an item, and git does not report it. Only the check against the last commit finds the loss.
    expect((await box.git(stateOf(), ['update-index', '--assume-unchanged', 'board.json'])).code).toBe(0);
    const short = boardWith(boardKeys.defaultQueue, ['B-1']);
    await writeFile(boardFile(), short);
    const head = (await box.git(stateOf(), ['rev-parse', 'HEAD'])).stdout.trim();

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('this change removes the item id B-2 from board.json');
    expect(result.stderr).toContain('factory upgrade');
    expect(await box.read(boardFile())).toBe(short);
    expect((await box.git(stateOf(), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect(await readdir(stateOf())).not.toContain('backups');
    expect(existsSync(lockFile())).toBe(false);
  });
});

describe('factory upgrade of a FAC-M1 node (the committed fixture)', () => {
  const FIXTURE = join(__dirname, '..', 'fixtures', 'node-0.1.0');
  /** The id of the node in `factory.yaml` of the fixture. */
  const FIXTURE_NODE_ID = 'demo';

  /** Commit every change of the state repository, as the owner would. */
  const commitAll = async (state: string, message: string): Promise<void> => {
    expect((await box.git(state, ['add', '-A'])).code).toBe(0);
    expect((await box.git(state, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message])).code).toBe(0);
  };

  /** The project of the fixture: a path beside the node folder and no clone URL. */
  const FIXTURE_PROJECT = [
    'projects:',
    '  - id: web',
    '    path: "../web"',
    '    default_branch: "main"',
    '    merge_method: squash',
    '    pack: plain',
    '    gate: { checks: [] }',
  ].join('\n');

  /**
   * Copy the fixture and start the state repository with a first commit. A node that lists a project is not upgraded
   * (decision D-3 B), so the copy lists none, unless the test asks for the project of the fixture.
   */
  const prepareOldNode = async (options: { withProject?: boolean } = {}): Promise<string> => {
    await cp(FIXTURE, box.node, { recursive: true });
    const marker = JSON.parse(await box.read(join(box.node, '.factory', 'node.json'))) as Record<string, unknown>;
    expect(marker['created_with']).toBe('0.1.0');
    expect(marker['schema_version']).toBe(1);
    if (options.withProject === true) {
      await box.makeProject('web');
    } else {
      const config = join(box.node, 'factory.yaml');
      const text = await box.read(config);
      expect(text).toContain(FIXTURE_PROJECT);
      await writeFile(config, text.replace(FIXTURE_PROJECT, 'projects: []'));
    }
    const state = join(box.node, '.factory');
    expect((await box.git(state, ['init', '-q'])).code).toBe(0);
    await commitAll(state, 'first');
    return state;
  };

  /**
   * A new node of the current version: its files are the oracle for the text of an upgraded node. It has the id of the node
   * of the fixture, because the worker text names the session of the coordinator by that id.
   */
  const freshNode = async (): Promise<string> => {
    const home = join(box.root, 'fresh');
    const result = await box.run(['init', '--yes', '--home', home, '--name', FIXTURE_NODE_ID, '--owner-name', 'Test Owner']);
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
    const upgraded = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 11 files.');
    expect(upgraded.stdout).toContain('Made the factory folder a git repo. Its first commit holds .gitignore, factory.yaml.');
    expect(existsSync(join(box.node, 'CLAUDE.md'))).toBe(false);
    expect(await box.read(join(box.node, ...COORDINATOR_FILE))).toContain('factory:begin coordinator');

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
    expect(node).toMatchObject({ schema_version: 2, blocks: { coordinator: 4, safety: 2, worker: 3 } });

    const changes = await box.git(state, ['diff', '--name-status', '-M', 'HEAD~1', 'HEAD']);
    expect(changes.stdout).toContain('protocol.md');
    expect(changes.stdout).toContain('roles/worker.md');
    expect(changes.stdout).toContain('roadmaps/README.md');
    expect(await box.read(join(state, '.gitignore'))).toBe('state/\nlocks/\nbackups/\nworkers/\ninbox/\n');
    expect(changes.stdout).toContain('.gitignore');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
    // The old state repo had no guard: the run wrote it into the git folder, and git does not track it.
    const guard = join(await realpath(state), '.git', 'factory-guard');
    expect(upgraded.stdout).toContain('Wrote the delete guard in .factory/.git/factory-guard.');
    expect((await box.git(state, ['config', 'core.hooksPath'])).stdout.trim()).toBe(guard);
    expect(await readdir(guard)).toEqual(['pre-applypatch', 'pre-commit', 'pre-merge-commit']);
    expect(changes.stdout).not.toContain('factory-guard');

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
  });

  it('gives the node the root repo and the .gitignore of a new node, writes no setup file, and registers the root (TP-23)', async () => {
    await prepareOldNode();
    const upgraded = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(upgraded.code).toBe(0);
    await freshNode();
    const fresh = join(box.root, 'fresh');

    expect(await box.read(join(box.node, '.gitignore'))).toBe(await box.read(join(fresh, '.gitignore')));
    const tracked = async (dir: string): Promise<string[]> => (await box.git(dir, ['ls-files'])).stdout.trim().split('\n');
    expect(await tracked(box.node)).toEqual(['.gitignore', 'factory.yaml']);
    expect((await box.git(box.node, ['log', '--format=%s'])).stdout.trim()).toBe('chore: initialize the config repo');
    expect((await box.git(box.node, ['status', '--porcelain'])).stdout).toBe('');
    // The private files stay out of the root repo, as git sees it.
    const ignored = await box.git(box.node, ['check-ignore', 'factory.local.yaml', '.factory', 'coordinator']);
    expect(ignored.stdout.trim().split('\n').sort()).toEqual(['.factory', 'coordinator', 'factory.local.yaml']);
    // A node from before the setup folder has no setup text, and upgrade writes none: only init writes the setup files.
    expect(existsSync(join(box.node, 'setup'))).toBe(false);

    const index = JSON.parse(await box.read(join(box.root, 'home', '.local', 'state', 'factory', 'homes.json'))) as {
      homes: { home: string; origin: string }[];
    };
    expect(index.homes.filter((entry) => entry.home.endsWith(`${sep}node`)).map((entry) => entry.origin)).toEqual(['own']);

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toMatch(/root\s+the factory folder is the top folder of its own git work tree and holds the share list/);
    expect(doctor.stdout).toMatch(/root-repo\s+the git repo of the factory folder tracks no path that must stay on this machine/);
    expect((await box.run(['upgrade', '--home', box.node])).stdout).toContain('Nothing to upgrade.');
  });

  it('keeps the lines of the person in the root .gitignore, and renders the factory part again (TP-117)', async () => {
    await prepareOldNode();
    const path = join(box.node, '.gitignore');
    const mine = '# my lines\ndist/\n';
    await writeFile(path, mine);
    expect((await box.run(['upgrade', '--home', box.node, '--yes'])).code).toBe(0);
    await freshNode();
    const part = await box.read(join(box.root, 'fresh', '.gitignore'));
    expect(await box.read(path)).toBe(`${part}\n${mine}`);

    const stale = (await box.read(path)).replace('!/factory.yaml', '!/old-name.yaml');
    expect(stale).not.toBe(await box.read(path));
    await writeFile(path, `${stale}!/notes.md\n`);
    const again = await box.run(['upgrade', '--home', box.node]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('.gitignore: render the share list again. Your lines stay as they are.');
    expect(await box.read(path)).toBe(`${part}\n${mine}!/notes.md\n`);
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
  });

  it('leaves no old word in the files of the upgraded node, and gives it the text of a new node', async () => {
    const state = await prepareOldNode();
    // The scan sees the old words before the upgrade, so an empty result afterwards is not a blind scan.
    const before = await oldWordsByFile(box.node);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'factory.yaml', '.factory/protocol.md', '.factory/roadmaps/README.md']),
    );

    const upgraded = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stderr).toBe('');

    expect(await oldWordsByFile(box.node)).toEqual({});
    const fresh = await freshNode();
    // A node from before the setup folder has no setup text, so only the worker block is the same.
    const workerBlockOf = (text: string): string => text.slice(0, text.indexOf('<!-- factory:end worker -->'));
    const upgradedWorker = workerBlockOf(await box.read(join(state, 'roles', 'worker.md')));
    expect(upgradedWorker).toContain('<!-- factory:begin worker v3 sha256=');
    expect(upgradedWorker).toContain('`factory lock run -- <command>`');
    expect(upgradedWorker).not.toContain('wait in a loop');
    expect(upgradedWorker).toBe(workerBlockOf(await box.read(join(fresh, 'roles', 'worker.md'))));
    expect(await box.read(join(state, 'roadmaps', 'README.md'))).toBe(
      await box.read(join(fresh, 'roadmaps', 'README.md')),
    );
  });

  it('keeps a roadmap README that the owner edited, says so, and leaves the edit out of the commit', async () => {
    const state = await prepareOldNode();
    const path = join(state, 'roadmaps', 'README.md');
    const edited = `${await box.read(path)}\n## Our own track rules\n`;
    await writeFile(path, edited);

    const upgraded = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(upgraded.code).toBe(0);
    expect(upgraded.stdout).toContain('Changed 10 files.');
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
    expect(result.stdout).toContain('move CLAUDE.md to coordinator/CLAUDE.md');
    expect(result.stdout).toContain('move .factory/protocol.md to .factory/roles/worker.md');
    expect(result.stdout).toContain('move .factory/briefs to .factory/orders');
    expect(result.stdout).toContain('replace .factory/roadmaps/README.md with the new text');
    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(before);
    expect((await readdir(state)).sort()).toContain('protocol.md');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
  });

  /** Edit one line of the protocol block, and commit it: the upgrade moves the file, so it needs a clean state repo. */
  const editProtocol = async (state: string): Promise<void> => {
    const path = join(state, 'protocol.md');
    const text = await box.read(path);
    const line = text.split('\n').find((candidate) => candidate.length > 30 && !candidate.startsWith('<!--')) ?? '';
    expect(line).not.toBe('');
    await writeFile(path, text.replace(line, 'My own rule for the workers.'));
    await commitAll(state, 'my rule for the workers');
  };

  it('keeps an edited protocol block with a warning that names the flag, and exits 0', async () => {
    const state = await prepareOldNode();
    await editProtocol(state);

    const kept = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(kept.code).toBe(0);
    expect(kept.stderr).toContain('block protocol was edited');
    expect(kept.stderr).toContain('--overwrite protocol');
    expect(await box.read(join(state, 'roles', 'worker.md'))).toContain('My own rule for the workers.');
  });

  it('replaces an edited protocol block when it is named, and the doctor exits 0', async () => {
    const state = await prepareOldNode();
    await editProtocol(state);

    const upgraded = await box.run(['upgrade', '--home', box.node, '--yes', '--overwrite', 'protocol']);
    expect(upgraded.code).toBe(0);
    expect(await box.read(join(state, 'roles', 'worker.md'))).not.toContain('My own rule for the workers.');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
  });

  it('names the kept protocol block again in the next run, and replaces it when it is named, and the doctor exits 0', async () => {
    const state = await prepareOldNode();
    await editProtocol(state);
    expect((await box.run(['upgrade', '--home', box.node, '--yes'])).code).toBe(0);

    const again = await box.run(['upgrade', '--home', box.node]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain('block protocol was edited');
    expect(again.stderr).toContain('--overwrite protocol');
    expect(again.stderr).not.toContain('is missing');

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.stdout).toContain('protocol (edited');
    expect(doctor.stdout).not.toContain('worker (missing');

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

    const refused = await box.run(['upgrade', '--home', box.node, '--yes']);
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
    expect((await box.run(['upgrade', '--home', box.node, '--yes'])).code).toBe(0);
    expect(await box.read(join(state, 'roles', 'worker.md'))).toContain('A note of the owner, outside the block.');
  });

  it('stops with exit 1 on a node that lists a project, names the init command, and changes no file (TP-62)', async () => {
    const state = await prepareOldNode({ withProject: true });
    const config = await box.read(join(box.node, 'factory.yaml'));
    const marker = await box.read(join(state, 'node.json'));

    for (const args of [['upgrade', '--home', box.node, '--yes'], ['upgrade', '--home', box.node, '--dry-run']]) {
      const result = await box.run(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lists a project');
      expect(result.stderr).toContain('factory init');
      expect(result.stderr).not.toContain('../web');
    }

    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(config);
    expect(await box.read(join(state, 'node.json'))).toBe(marker);
    expect(existsSync(join(box.node, 'factory.local.yaml'))).toBe(false);
    const names = (await readdir(state)).sort();
    expect(names).toContain('protocol.md');
    expect(names).not.toContain('roles');
    expect(names).not.toContain('backups');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('stops on a child with an ssh address, names the child, and changes nothing', async () => {
    const state = await prepareOldNode();
    const path = join(box.node, 'factory.yaml');
    const text = await box.read(path);
    expect(text).toContain('children: []');
    const edited = text.replace('children: []', 'children:\n  - id: team-a\n    address: "ssh://deploy@host/work"');
    await writeFile(path, edited);

    const result = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('children[0] "team-a"');
    expect(result.stderr).not.toContain('deploy@host');
    expect(await box.read(path)).toBe(edited);
    expect((await readdir(state)).sort()).toContain('protocol.md');
  });

  it('does not register the folder without a yes: exit 2 with no terminal, and nothing changes (TP-88)', async () => {
    const state = await prepareOldNode();
    const config = await box.read(join(box.node, 'factory.yaml'));
    const marker = await box.read(join(state, 'node.json'));

    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not in the factory list');
    expect(result.stderr).toContain('--yes');

    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(config);
    expect(await box.read(join(state, 'node.json'))).toBe(marker);
    expect((await readdir(state)).sort()).toContain('protocol.md');
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('exits 4 in a factory session, also with --yes, and writes nothing (TP-89)', async () => {
    const state = await prepareOldNode();
    const config = await box.read(join(box.node, 'factory.yaml'));
    const marker = await box.read(join(state, 'node.json'));

    const result = await box.run(['upgrade', '--home', box.node, '--yes'], { env: { FACTORY_SESSION: '1' } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('a factory session can not register it');
    expect(result.stderr).toContain('outside a factory session');

    expect(await box.read(join(box.node, 'factory.yaml'))).toBe(config);
    expect(await box.read(join(state, 'node.json'))).toBe(marker);
    expect((await readdir(state)).sort()).toContain('protocol.md');
  });

  it('counts the folder only when --home names it: the walk from inside it exits 4 (TP-72)', async () => {
    await prepareOldNode();
    const result = await box.run(['upgrade', '--yes'], { cwd: box.node });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('does not count: the factory list has no entry');
    expect(result.stderr).toContain('factory init');
  });

  it('registers the folder after the yes, so that start and doctor count it', async () => {
    await prepareOldNode();
    expect((await box.run(['upgrade', '--home', box.node, '--yes'])).code).toBe(0);
    const doctor = await box.run(['doctor'], { cwd: box.node });
    expect(doctor.code).toBe(0);
  });
});

describe('factory upgrade of the hook settings (built binary)', () => {
  const WORKER_ID = 'alpha';

  /** The settings of a factory that wrote the first four events only. */
  const withFourEvents = (settings: Record<string, unknown>): Record<string, unknown> => {
    const hooks = settings['hooks'] as Record<string, unknown>;
    return { ...settings, hooks: Object.fromEntries(hookNames.events.slice(0, 4).map((event) => [event, hooks[event]])) };
  };

  const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  /** The record of a worker as the file on disk holds it. The key names are written out: they are the file format. */
  const writeRecord = async (): Promise<void> => {
    const folder = join(box.node, '.factory', 'workers', WORKER_ID);
    await mkdir(join(folder, 'inbox'), { recursive: true });
    const record = {
      schema: 'factory.worker/v1',
      id: WORKER_ID,
      project: 'web',
      work_copy: join(box.node, 'work-copies', 'web', WORKER_ID),
      branch: `worker/${WORKER_ID}`,
      created_at: new Date().toISOString(),
    };
    await writeFile(join(folder, 'worker.json'), jsonText(record));
  };

  it('TP-8: with --yes, a work copy settings file and the coordinator settings file get the two new events, and a second run has nothing to do', async () => {
    await initNode();
    const coordinatorFile = join(box.node, 'coordinator', '.claude', 'settings.local.json');
    const current = JSON.parse(await box.read(coordinatorFile)) as Record<string, unknown>;
    expect(Object.keys(current['hooks'] as object)).toEqual(hookNames.events);
    const older = jsonText(withFourEvents(current));
    const copyFile = join(box.node, 'work-copies', 'web', WORKER_ID, '.claude', 'settings.local.json');
    await mkdir(join(box.node, 'work-copies', 'web', WORKER_ID, '.claude'), { recursive: true });
    await writeFile(coordinatorFile, older);
    await writeFile(copyFile, older);
    await writeRecord();

    const dry = await box.run(['upgrade', '--home', box.node, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`This changes the settings of Claude Code in ${copyFile}:`);
    expect(dry.stdout).toContain('hooks.Notification: add the command "factory hook Notification"');
    expect(await box.read(copyFile)).toBe(older);
    expect(await box.read(coordinatorFile)).toBe(older);

    const result = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Changed the hook settings in ${copyFile}.`);
    expect(JSON.parse(await box.read(copyFile))).toEqual(current);
    expect(JSON.parse(await box.read(coordinatorFile))).toEqual(current);

    const again = await box.run(['upgrade', '--home', box.node, '--yes']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing to upgrade.');
  });

  it('TP-6: with no terminal and no --yes, it writes no hook settings, warns with the remedy and exits 0', async () => {
    await initNode();
    const coordinatorFile = join(box.node, 'coordinator', '.claude', 'settings.local.json');
    const older = jsonText(withFourEvents(JSON.parse(await box.read(coordinatorFile)) as Record<string, unknown>));
    await writeFile(coordinatorFile, older);
    const result = await box.run(['upgrade', '--home', box.node]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('no consent');
    expect(result.stderr).toContain('--yes');
    expect(await box.read(coordinatorFile)).toBe(older);
  });
});
