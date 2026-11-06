import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyMatches } from '../helpers/deny-list.js';
import { makeSandbox, removeOpenSandboxes, withoutHookNotice, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

/** A lock file that another command holds. Its time is one hour ahead, so host latency under load never makes it stale during the test. */
const writeHeldLock = async (lock: string): Promise<void> => {
  await writeFile(lock, '1\n');
  const ahead = new Date(Date.now() + 3_600_000);
  await utimes(lock, ahead, ahead);
};

/** The built binary has no terminal window, so a run that writes the hook settings needs the yes flag. */
const initArgs = (extra: readonly string[] = []): string[] => [
  'init',
  '--yes',
  '--home',
  box.node,
  '--name',
  'demo',
  '--owner-name',
  'Test Owner',
  ...extra,
];

const withoutYes = (args: readonly string[]): string[] => args.filter((arg) => arg !== '--yes');

/** The factory removes its setup text from the root repo. A run with the yes flag has nothing to accept then. */
const dropSetupText = async (): Promise<void> => {
  expect((await box.git(box.node, ['rm', '-q', '--', 'setup/coordinator.md', 'setup/roles/worker.md'])).code).toBe(0);
  expect((await box.git(box.node, ['commit', '-q', '-m', 'remove the setup text'])).code).toBe(0);
};

describe('factory init (built binary)', () => {
  it('creates the node and exits 0', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    const result = await box.run(initArgs(['--project', web]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Created the node "demo"');
    for (const name of [
      'factory.yaml',
      'factory.local.yaml',
      '.gitignore',
      'setup/coordinator.md',
      'setup/roles/worker.md',
      'coordinator/CLAUDE.md',
      '.factory/node.json',
      '.factory/roles/worker.md',
    ]) {
      expect(existsSync(join(box.node, name))).toBe(true);
    }
    expect(existsSync(join(box.node, 'CLAUDE.md'))).toBe(false);
    const config = await box.read(join(box.node, 'factory.yaml'));
    expect(config).toContain('repo: "acme/web"');
    expect(config).toContain('path: "web"');
    expect(existsSync(join(box.node, 'web', '.git'))).toBe(true);
  });

  it('accepts the setup text that it wrote on a new root, so a second init asks nothing and start --dry-run passes', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const store = join(box.root, 'home', '.local', 'state', 'factory', 'setup-acceptances.json');
    const stored = async (): Promise<Record<string, unknown>[]> =>
      (JSON.parse(await box.read(store)) as { acceptances: Record<string, unknown>[] }).acceptances;
    expect(await stored()).toEqual([
      expect.objectContaining({ root: await realpath(box.node), node: 'demo', file: 'setup/coordinator.md' }),
    ]);

    // No terminal window and no yes flag: a set without an acceptance would stop here with exit 4.
    const second = await box.run(['init'], { cwd: box.node });
    expect([second.code, second.stdout]).toEqual([0, expect.not.stringContaining('Accepted the setup text')]);
    expect((await box.run(['start', '--dry-run', '--home', box.node])).code).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it('prints the warning about an instruction file above the root on stderr before it acts, and still exits 0 (TP-33)', async () => {
    const above = join(box.root, 'CLAUDE.md');
    await writeFile(above, 'x\n');
    const result = await box.run(initArgs(['--json']));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('warning: Agent instruction files are in the factory folder or above it: ');
    expect(result.stderr).toContain(above);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'factory.init/v1' });
  });

  it('writes the url of a project from the origin of its repo, and keeps no local path in factory.yaml', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    const result = await box.run(initArgs(['--project', web]));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`The old folder ${await realpath(web)} keeps the work that is not pushed.`);
    const config = await box.read(join(box.node, 'factory.yaml'));
    expect(config).toContain('url: "git@github.com:acme/web.git"');
    expect(config).not.toContain(basename(box.root));
    expect(await box.read(join(box.node, 'factory.local.yaml'))).toContain('sources: {}');
    // The clone keeps the URL of the origin as it is. (The sandbox serves the repo from a folder by a rule of git.)
    expect(await box.git(join(box.node, 'web'), ['config', 'remote.origin.url'])).toMatchObject({
      stdout: 'git@github.com:acme/web.git\n',
    });
  });

  it('keeps git status of the root empty after init, the clones, a linked work copy and a temp folder (TP-11)', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    const api = await box.makeProject('api', 'https://github.com/acme/api.git');
    expect((await box.run(initArgs(['--project', web, '--project', api]))).code).toBe(0);
    expect((await box.git(box.node, ['status', '--porcelain', '-uall'])).stdout).toBe('');

    const copy = await box.git(join(box.node, 'web'), ['worktree', 'add', '-q', '-b', 'job-1', join(box.node, 'work-copies', 'job-1')]);
    expect(copy.code).toBe(0);
    await mkdir(join(box.node, '.factory.tmp-77'), { recursive: true });
    await writeFile(join(box.node, '.factory.tmp-77', 'left.txt'), 'x');
    expect((await box.git(box.node, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    expect((await box.git(box.node, ['ls-files'])).stdout.trim().split('\n').sort()).toEqual([
      '.gitignore',
      'factory.yaml',
      'setup/coordinator.md',
      'setup/roles/worker.md',
    ]);
  });

  it('makes the file tree of the root: the config files, the coordinator folder, the state folder and one folder for each clone', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    const api = await box.makeProject('api', 'https://github.com/acme/api.git');
    expect((await box.run(initArgs(['--project', web, '--project', api]))).code).toBe(0);
    expect((await readdir(box.node)).sort()).toEqual(
      ['.factory', '.git', '.gitignore', 'api', 'coordinator', 'factory.local.yaml', 'factory.yaml', 'setup', 'web'].sort(),
    );
    expect((await readdir(join(box.node, 'coordinator'))).sort()).toEqual(['.claude', 'CLAUDE.md']);
    expect((await readdir(join(box.node, 'coordinator', '.claude'))).sort()).toEqual(['settings.local.json']);
    for (const name of ['web', 'api']) expect(existsSync(join(box.node, name, '.git'))).toBe(true);
    // The old folders stay as they were.
    expect(existsSync(join(web, '.git'))).toBe(true);
    expect(existsSync(join(api, '.git'))).toBe(true);
  });

  it('writes the origin url of a project without its credentials, and warns', async () => {
    const web = await box.makeProject('web', 'https://deploy:SECRET-TOKEN@github.com/acme/web.git');
    const result = await box.run(initArgs(['--project', web]));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('holds credentials');
    const cloneConfig = await box.read(join(box.node, 'web', '.git', 'config'));
    for (const text of [result.stdout, result.stderr, await box.read(join(box.node, 'factory.yaml')), cloneConfig]) {
      expect(text).not.toContain('SECRET-TOKEN');
      expect(text).not.toContain('deploy');
    }
    expect(await box.read(join(box.node, 'factory.yaml'))).toContain('url: "https://github.com/acme/web.git"');
    expect(await box.read(join(box.node, 'factory.local.yaml'))).not.toContain('SECRET-TOKEN');
  });

  it('warns for a project with no origin, writes no url, and keeps its local source in the local file', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(initArgs(['--project', web]));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('cannot be shared with the repo of the project web');
    const shared = await box.read(join(box.node, 'factory.yaml'));
    expect(shared).not.toContain('url:');
    expect(shared).not.toContain(basename(box.root));
    const local = await box.read(join(box.node, 'factory.local.yaml'));
    expect(local).toContain('sources:');
    expect(local).toContain(`"web": "${await realpath(web)}"`);
    expect(existsSync(join(box.node, 'web', '.git'))).toBe(true);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('cannot be shared with the repo of the project web');
  });

  it('exits 2 for a project flag that holds credentials, clones nothing, and never repeats the value', async () => {
    const result = await box.run(initArgs(['--project', 'https://deploy:SECRET-TOKEN@github.com/acme/web.git']));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--project');
    expect(result.stderr).toContain('Use an https URL with no user name, or an ssh URL.');
    expect(result.stderr).not.toContain('SECRET-TOKEN');
    expect(result.stdout).not.toContain('SECRET-TOKEN');
    expect(existsSync(box.node)).toBe(false);
    expect(existsSync(join(box.root, 'web'))).toBe(false);
  });

  it('writes factory.local.yaml with mode 600 and keeps the personal keys out of factory.yaml', async () => {
    expect((await box.run(initArgs(['--owner-github', 'some-login']))).code).toBe(0);
    const path = join(box.node, 'factory.local.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const local = await box.read(path);
    expect(local).toContain('display: "Test Owner"');
    expect(local).toContain('github: "some-login"');
    const shared = await box.read(join(box.node, 'factory.yaml'));
    expect(shared).not.toContain('some-login');
    expect(shared).not.toMatch(/^owner:/m);
  });

  it('makes the first commit in the state repository', async () => {
    await box.run(initArgs());
    const log = await box.git(join(box.node, '.factory'), ['log', '--format=%s']);
    expect(log.stdout.trim()).toBe('chore: initialize the state');
    const status = await box.git(join(box.node, '.factory'), ['status', '--porcelain']);
    expect(status.stdout).toBe('');
  });

  it('makes the root a git repo of its own with a first commit of the three shared paths, and doctor exits 0 (TP-10)', async () => {
    const result = await box.run(initArgs());
    expect({ code: result.code, stderr: withoutHookNotice(result.stderr) }).toEqual({ code: 0, stderr: '' });
    expect((await box.git(box.node, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])).stdout).toBe('true\n\n');
    expect((await box.git(box.node, ['log', '--format=%s'])).stdout.trim()).toBe('chore: initialize the config repo');
    const tracked = await box.git(box.node, ['ls-files']);
    expect(tracked.stdout.trim().split('\n').sort()).toEqual([
      '.gitignore',
      'factory.yaml',
      'setup/coordinator.md',
      'setup/roles/worker.md',
    ]);
    expect((await box.git(box.node, ['status', '--porcelain'])).stdout).toBe('');
    const ignore = await box.read(join(box.node, '.gitignore'));
    expect(ignore.split('\n')).toEqual([
      '# factory:begin share list',
      '/*',
      '!/.gitignore',
      '!/factory.yaml',
      '!/setup/',
      '# factory:end share list',
      '',
    ]);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('the factory folder is the top folder of its own git work tree and holds the share list');
    expect(doctor.stdout).toContain('no temp folder of a stopped init in the factory folder');
  });

  it('ignores the private files, the state folder, the coordinator folder, the work copies and the clones, by git check-ignore (TP-69)', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    await mkdir(join(box.node, 'work-copies', 'job-1'), { recursive: true });
    await writeFile(join(box.node, 'work-copies', 'job-1', 'file.txt'), 'x');
    await mkdir(join(box.node, 'web'), { recursive: true });
    await writeFile(join(box.node, 'web', 'file.txt'), 'x');
    const ignored = [
      'factory.local.yaml',
      '.factory/node.json',
      'coordinator/CLAUDE.md',
      'work-copies/job-1/file.txt',
      'web/file.txt',
    ];
    const shared = ['.gitignore', 'factory.yaml', 'setup/coordinator.md', 'setup/roles/worker.md'];
    for (const path of ignored) {
      expect({ path, code: (await box.git(box.node, ['check-ignore', '-q', '--no-index', path])).code }).toEqual({ path, code: 0 });
    }
    for (const path of shared) {
      expect({ path, code: (await box.git(box.node, ['check-ignore', '-q', '--no-index', path])).code }).toEqual({ path, code: 1 });
    }
    expect((await box.git(box.node, ['status', '--porcelain', '-uall'])).stdout).toBe('');
  });

  it('keeps the lines of a person in .gitignore after the share list, and the git repo of the root clean', async () => {
    await mkdir(box.node, { recursive: true });
    await writeFile(join(box.node, '.gitignore'), '!/notes.md\n');
    await writeFile(join(box.node, 'notes.md'), 'My notes.\n');
    expect((await box.run(initArgs())).code).toBe(0);
    const ignore = await box.read(join(box.node, '.gitignore'));
    expect(ignore.startsWith('# factory:begin share list\n')).toBe(true);
    expect(ignore.endsWith('\n!/notes.md\n')).toBe(true);
    const tracked = await box.git(box.node, ['ls-files']);
    expect(tracked.stdout.trim().split('\n').sort()).toEqual([
      '.gitignore',
      'factory.yaml',
      'setup/coordinator.md',
      'setup/roles/worker.md',
    ]);
    expect((await box.git(box.node, ['status', '--porcelain'])).stdout).toBe('?? notes.md\n');
  });

  it('treats a second init in the same home as a registered root: a flag that names a value exits 2, a plain run exits 0', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const flagged = await box.run(initArgs());
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain('--name');
    const plain = await box.run(['init', '--home', box.node, '--yes']);
    expect([plain.code, plain.stderr]).toEqual([0, '']);
    expect(plain.stdout).toContain('is registered');
  });

  it('exits 2 with no terminal window and no yes flag, names the change and its target, and makes no root (TP-16)', async () => {
    const result = await box.run(withoutYes(initArgs()));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(join(box.node, 'coordinator', '.claude', 'settings.local.json'));
    expect(result.stderr).toContain('factory hook Stop');
    expect(result.stderr).toContain('factory hook statusline');
    expect(result.stderr).toContain('--yes');
    expect(existsSync(box.node)).toBe(false);
  });

  it('exits 2 for a registered root whose settings file is gone, with no terminal window and no yes flag, and writes nothing (TP-16)', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const folder = join(box.node, 'coordinator', '.claude');
    await rm(folder, { recursive: true, force: true });
    const result = await box.run(['init', '--home', box.node]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(join(folder, 'settings.local.json'));
    expect(existsSync(folder)).toBe(false);
    const again = await box.run(['init', '--home', box.node, '--yes']);
    expect(again.code).toBe(0);
    expect(existsSync(join(folder, 'settings.local.json'))).toBe(true);
  });

  it('refuses with exit 1 a folder inside a root that the factory list holds, names a remedy and creates nothing', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const inner = join(box.node, 'inner');
    const child = await box.run(['init', '--yes', '--home', inner, '--name', 'inner', '--owner-name', 'Test Owner']);
    expect(child.code).toBe(1);
    expect(child.stderr).toContain('is inside the factory folder');
    expect(child.stderr).toContain('Run "factory init" again with --home DIR to choose another folder.');
    expect(existsSync(inner)).toBe(false);
  });

  it('accepts a root beside a root that the factory list holds', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const beside = await box.run(['init', '--yes', '--home', join(box.root, 'other'), '--name', 'other', '--owner-name', 'Test Owner']);
    expect(beside.code).toBe(0);
  });

  it('exits 1 when the factory list cannot be written, makes no root, and lets a second init succeed (TP-74)', async () => {
    const stateHome = join(box.root, 'state');
    const listFolder = join(stateHome, 'factory');
    const lock = join(listFolder, 'homes.json.lock');
    // Another command holds the lock of the list. The write of the list is the last step of init, and it fails.
    await mkdir(listFolder, { recursive: true, mode: 0o700 });
    await writeHeldLock(lock);
    const failed = await box.run(initArgs(), { env: { XDG_STATE_HOME: stateHome } });
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain('Created the node');
    expect(failed.stderr).toContain('was not updated');
    expect(failed.stderr).toContain('holds the lock');
    expect(existsSync(box.node)).toBe(false);
    expect(await readdir(listFolder)).toEqual(['homes.json.lock']);

    await rm(lock);
    const again = await box.run(initArgs(), { env: { XDG_STATE_HOME: stateHome } });
    expect(again.code).toBe(0);
    expect(existsSync(join(box.node, 'factory.yaml'))).toBe(true);
  });

  it('prints a JSON document with a schema field for --json', async () => {
    const result = await box.run([...initArgs(), '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'factory.init/v1', nodeId: 'demo', committed: true });
  });

  it('exits 2 for an unknown command and for a missing owner name flag value', async () => {
    expect((await box.run(['frobnicate'])).code).toBe(2);
    expect((await box.run(['init', '--home'])).code).toBe(2);
  });

  it('exits 2 and names the flag when there is no owner name', async () => {
    await box.git(box.root, ['config', '--file', join(box.env['HOME'] ?? '', '.gitconfig'), '--unset', 'user.name']);
    const result = await box.run(['init', '--home', box.node, '--name', 'demo']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--owner-name');
  });

  it('writes files with none of the denied words', async () => {
    const web = await box.makeProject('web');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    for (const name of [
      'factory.yaml',
      '.gitignore',
      'setup/coordinator.md',
      'setup/roles/worker.md',
      'coordinator/CLAUDE.md',
      '.factory/node.json',
      '.factory/roles/worker.md',
      '.factory/decision-profile/README-format.md',
      '.factory/decision-profile/index.md',
      '.factory/roadmaps/README.md',
    ]) {
      expect({ name, found: denyMatches(await box.read(join(box.node, name))) }).toEqual({ name, found: [] });
    }
  });
});

describe('factory init: the approval points (built binary)', () => {
  const recordStore = (): string => join(box.env['HOME'] ?? '', '.local', 'state', 'factory', 'owner-records.json');

  it('writes owner for each point with no terminal window and no approval flag, and writes no approval record (TP-37)', async () => {
    const result = await box.run([...initArgs(), '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ approval: { merge: 'owner', release: 'owner' } });
    expect(result.stdout).not.toContain('factory upgrade');
    expect(await box.read(join(box.node, 'factory.local.yaml'))).toMatch(/approval:\n {2}merge: owner\n {2}release: owner\n/);
    expect(existsSync(recordStore())).toBe(false);
  });

  it('writes owner with the yes flag, also for a flag that names owner, and writes no approval record (TP-37)', async () => {
    const result = await box.run(initArgs(['--approval', 'merge=owner']));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Approval points: merge owner, release owner.');
    expect(existsSync(recordStore())).toBe(false);
  });

  it('exits 4 for a delegated choice with no terminal window, and makes no root and no record (TP-38)', async () => {
    const result = await box.run(withoutYes(initArgs(['--approval', 'merge=delegated'])));
    expect(result.code).toBe(4);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('terminal window outside a factory session');
    expect(existsSync(box.node)).toBe(false);
    expect(existsSync(recordStore())).toBe(false);
  });

  it('exits 2 for the yes flag with a delegated choice, and makes no root and no record (TP-81)', async () => {
    const result = await box.run(initArgs(['--approval', 'release=delegated']));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('with no --yes');
    expect(existsSync(box.node)).toBe(false);
    expect(existsSync(recordStore())).toBe(false);
  });

  it('exits 2 for a point that the recipe does not list, and makes no root', async () => {
    const result = await box.run(initArgs(['--approval', 'deploy=owner']));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('The points are: merge, release');
    expect(existsSync(box.node)).toBe(false);
  });

  it('shows the flag in the help of init', async () => {
    const result = await box.run(['init', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--approval POINT=MODE');
  });
});

describe('factory init: a workspace folder (built binary)', () => {
  const ownerArgs = ['--owner-name', 'Test Owner'];

  /** `ws/` holds the repos `web` and `api`, and `web-search` as a linked work tree of `web`. */
  const makeWorkspace = async (): Promise<string> => {
    const ws = join(box.root, 'ws');
    const web = await box.makeProject('ws/web', 'https://github.com/acme/web.git');
    await box.makeProject('ws/api', 'https://github.com/acme/api.git');
    await box.git(web, ['commit', '--allow-empty', '-q', '-m', 'first']);
    const linked = await box.git(web, ['worktree', 'add', '-q', '-b', 'search', join(ws, 'web-search')]);
    expect(linked.code).toBe(0);
    return ws;
  };

  it('makes ./<folder>-factory with the repos as projects, names the other checkout as skipped, and exits 0', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', '--yes', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('keeps the work that is not pushed');
    const home = join(ws, 'ws-factory');
    const config = await box.read(join(home, 'factory.yaml'));
    expect(config).toContain('path: "web"');
    expect(config).toContain('path: "api"');
    expect(config).not.toContain('web-search');
    expect(result.stdout).toContain('web-search');
    expect(result.stdout).toContain('one more work tree of the repo web');
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(false);
    for (const name of ['web', 'api']) expect(existsSync(join(home, name, '.git'))).toBe(true);
    expect((await box.git(home, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    const doctor = await box.run(['doctor', '--home', home]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('the top folder of its own git work tree');
  });

  it('makes the workspace folder the root for --home, with the repos of the folder as plain folders and no project', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', '--yes', '--home', '.', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(0);
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(true);
    expect(await box.read(join(ws, 'factory.yaml'))).toContain('projects: []');
    expect((await box.git(ws, ['status', '--porcelain', '-uall'])).stdout).toBe('');
  });

  it('prints the proposal and exits 2 without a terminal and without --yes', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('The proposed factory folder is');
    expect(result.stderr).toContain('ws-factory');
    expect(result.stderr).toContain('web-search');
    expect(existsSync(join(ws, 'ws-factory'))).toBe(false);
  });
});

describe('factory init: the home rules (built binary)', () => {
  const ownerArgs = ['--owner-name', 'Test Owner'];

  it('makes the node beside the work tree for --yes, with the work tree as the first project', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    const api = await box.makeProject('api', 'https://github.com/acme/api.git');
    const result = await box.run(['init', '--yes', ...ownerArgs, '--project', api], { cwd: web });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('keeps the work that is not pushed');
    const home = join(box.root, 'web-factory');
    const config = await box.read(join(home, 'factory.yaml'));
    expect(config).toContain('repo: "acme/web"');
    expect(config.indexOf('path: "web"')).toBeGreaterThan(0);
    expect(config.indexOf('path: "api"')).toBeGreaterThan(config.indexOf('path: "web"'));
    expect(existsSync(join(home, '.factory', 'roles', 'worker.md'))).toBe(true);
    for (const name of ['web', 'api']) expect(existsSync(join(home, name, '.git'))).toBe(true);
  });

  it('prints the proposal and exits 2 without a terminal and without --yes', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(['init', ...ownerArgs], { cwd: web });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('The proposed factory folder is');
    expect(result.stderr).toContain('web-factory');
    expect(result.stderr).toContain('--yes');
    expect(existsSync(join(box.root, 'web-factory'))).toBe(false);
  });

  it('uses the current folder when it is in no work tree', async () => {
    const result = await box.run(['init', '--yes', '--name', 'here', ...ownerArgs], { cwd: box.root });
    expect(result.code).toBe(0);
    expect(existsSync(join(box.root, 'factory.yaml'))).toBe(true);
  });

  it('accepts a home inside a git work tree: the root is a git repo of its own', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(['init', '--yes', '--home', join(web, 'node'), ...ownerArgs]);
    expect(result.code).toBe(0);
    expect((await box.git(join(web, 'node'), ['rev-parse', '--show-prefix'])).stdout).toBe('\n');
  });

  it('takes a work tree that is a folder of the root already as a project, and clones nothing', async () => {
    const holder = join(box.root, 'holder');
    await box.makeProject('holder/app');
    const result = await box.run(['init', '--yes', '--home', holder, ...ownerArgs, '--project', join(holder, 'app')]);
    expect(result.code).toBe(0);
    expect(await box.read(join(holder, 'factory.yaml'))).toContain('path: "app"');
    expect(result.stderr).not.toContain('The old folder');
    expect(result.stdout).not.toContain('Cloned into');
  });

  it.each(['coordinator', 'setup', 'work-copies', 'CLAUDE.md'])(
    'refuses with exit 4 a repo whose name the root keeps for itself (%s), clones nothing and writes nothing',
    async (name) => {
      const repo = await box.makeProject(name);
      const result = await box.run(['init', '--home', box.node, ...ownerArgs, '--project', repo]);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain(`the project folder name "${name}"`);
      expect(existsSync(box.node)).toBe(false);
    },
  );

  it('makes a node on layer 2 with the manager block, and doctor accepts it', async () => {
    const result = await box.run(initArgs(['--layer', '2']));
    expect(result.code).toBe(0);
    const claude = await box.read(join(box.node, 'coordinator', 'CLAUDE.md'));
    expect(claude).toContain('factory:begin manager');
    expect(claude).not.toContain('factory:begin coordinator');
    expect(existsSync(join(box.node, '.factory', 'roles', 'worker.md'))).toBe(false);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('3 managed blocks are intact');
  });

  it('makes a node on layer 3 with the safety block only, warns and names the layer, and doctor warns the same', async () => {
    const result = await box.run(initArgs(['--layer', '3']));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Layer 3 has no role template');
    const claude = await box.read(join(box.node, 'coordinator', 'CLAUDE.md'));
    expect(claude).toContain('factory:begin safety');
    expect(claude).not.toContain('factory:begin coordinator');
    expect(claude).not.toContain('factory:begin manager');
    expect(existsSync(join(box.node, '.factory', 'roles', 'worker.md'))).toBe(false);

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('layer 3 has no role template');
    expect(doctor.stdout).toContain('2 managed blocks are intact');
  });

  it.each(['0', '17', 'x'])('exits 2 for the layer "%s"', async (layer) => {
    const result = await box.run(initArgs(['--layer', layer]));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--layer');
    expect(existsSync(box.node)).toBe(false);
  });

  it('exits 2 for a recipe that does not exist', async () => {
    const result = await box.run(initArgs(['--recipe', 'research']));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--recipe');
  });

  it('finds the home from FACTORY_HOME', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const doctor = await box.run(['doctor'], { cwd: box.root, env: { FACTORY_HOME: box.node } });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain(join(box.node, 'factory.yaml'));
  });
});

describe('factory init: a received factory (built binary)', () => {
  /** Another machine: its own state folder, so it holds no factory list and no acceptance of the sender. */
  const second = (): Record<string, string> => ({ XDG_STATE_HOME: join(box.root, 'state-second') });
  const store = (name: string): string => join(box.root, 'state-second', 'factory', name);

  /**
   * The sender makes a factory with one project. A clone of its root is the received factory. It has no setup text unless
   * `keepSetup` is set, because the yes flag can not accept a received setup text.
   */
  const receivedFactory = async (
    options: { readonly keepSetup?: true; readonly edit?: (shared: string) => string } = {},
  ): Promise<string> => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    if (options.edit !== undefined) {
      const shared = join(box.node, 'factory.yaml');
      await writeFile(shared, options.edit(await box.read(shared)));
      expect((await box.git(box.node, ['commit', '-q', '-a', '-m', 'change the shared config'])).code).toBe(0);
    }
    if (options.keepSetup !== true) await dropSetupText();
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);
    return received;
  };

  it('clones each repo, registers the root, keeps factory.yaml byte-equal and git status clean, and doctor and start --dry-run exit 0 (TP-29)', async () => {
    const received = await receivedFactory();
    const shared = await box.read(join(received, 'factory.yaml'));
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect([result.code, withoutHookNotice(result.stderr)]).toEqual([0, '']);
    expect(result.stdout).toContain('Registered the received node "demo"');
    expect(await box.read(join(received, 'factory.yaml'))).toBe(shared);
    expect((await box.git(received, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    expect(existsSync(join(received, 'web', '.git'))).toBe(true);
    expect((await stat(join(received, 'factory.local.yaml'))).mode & 0o777).toBe(0o600);
    expect((await box.run(['doctor', '--home', received], { env: second() })).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', received], { env: second() })).code).toBe(0);
    const entries = JSON.parse(await box.read(store('homes.json'))) as { homes: { home: string; origin: string }[] };
    expect(entries.homes).toEqual([
      expect.objectContaining({ id: 'demo', origin: 'received', home: await realpath(received) }),
    ]);
  });

  it('exits 4 with the yes flag for a received setup text, names the command, and writes no acceptance (TP-143)', async () => {
    const received = await receivedFactory({ keepSetup: true });
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('Run "factory init" in a terminal window');
    expect(existsSync(store('setup-acceptances.json'))).toBe(false);
    expect(existsSync(store('owner-records.json'))).toBe(false);
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
    expect(existsSync(join(received, '.factory'))).toBe(false);
  });

  it('renders the shared limits into the coordinator text (TP-103)', async () => {
    const received = await receivedFactory();
    expect((await box.run(['init', '--yes'], { cwd: received, env: second() })).code).toBe(0);
    const coordinator = await box.read(join(received, 'coordinator', 'CLAUDE.md'));
    expect(coordinator).toContain('40');
    expect(existsSync(store('setup-acceptances.json'))).toBe(false);
  });

  it('renders the limits of the sender into the coordinator text, and start --dry-run launches with the model of the sender (TP-103)', async () => {
    const received = await receivedFactory({
      edit: (shared) =>
        shared
          .replace(/^( {2}model: ).*$/m, '$1opus')
          .replace(/^( {2}context_prepare_pct: ).*$/m, (_line, key: string) => `${key}33`)
          .replace(/^( {2}context_max_pct: ).*$/m, (_line, key: string) => `${key}55`),
    });
    expect(await box.read(join(received, 'factory.yaml'))).toContain('model: opus');
    expect((await box.run(['init', '--yes'], { cwd: received, env: second() })).code).toBe(0);
    const coordinator = await box.read(join(received, 'coordinator', 'CLAUDE.md'));
    expect(coordinator).toContain('at 33 percent');
    expect(coordinator).toContain('past 55 percent');
    const dry = await box.run(['start', '--dry-run', '--home', received], { env: second() });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('--model opus');
  });

  it('exits 4 in a factory session and writes nothing (TP-83)', async () => {
    const received = await receivedFactory();
    const result = await box.run(['init', '--yes'], { cwd: received, env: { ...second(), FACTORY_SESSION: 'demo' } });
    expect(result.code).toBe(4);
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
    expect(existsSync(join(received, '.factory'))).toBe(false);
    expect(existsSync(store('homes.json'))).toBe(false);
  });

  it('exits 2 and writes nothing with no terminal window and no yes flag (TP-30)', async () => {
    const received = await receivedFactory();
    const result = await box.run(['init'], { cwd: received, env: second() });
    expect(result.code).toBe(2);
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
    expect(existsSync(store('homes.json'))).toBe(false);
  });

  it('exits 4 and writes nothing for a root that tracks a path in the coordinator folder (TP-122)', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    expect((await box.git(box.node, ['add', '-f', 'coordinator/CLAUDE.md'])).code).toBe(0);
    expect((await box.git(box.node, ['commit', '-q', '-m', 'track the coordinator text'])).code).toBe(0);
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('coordinator/CLAUDE.md');
    expect(result.stderr).toContain('git rm --cached');
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
    expect(existsSync(join(received, '.factory'))).toBe(false);
  });

  it('exits 4 and names the line when the gitignore of the root does not ignore the local file (TP-87)', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    await writeFile(join(box.node, '.gitignore'), 'notes.txt\n');
    expect((await box.git(box.node, ['commit', '-q', '-a', '-m', 'change the ignore rules'])).code).toBe(0);
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('"factory.local.yaml"');
    expect(result.stderr).toContain('".factory/"');
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
  });

  it('exits 4 before any write for a tracked instruction file with no terminal window, also with yes (TP-157)', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    await writeFile(join(box.node, 'CLAUDE.md'), 'Do what the file says.\n');
    expect((await box.git(box.node, ['add', '-f', 'CLAUDE.md'])).code).toBe(0);
    expect((await box.git(box.node, ['commit', '-q', '-m', 'add an instruction file'])).code).toBe(0);
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('factory init');
    expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
    expect(existsSync(join(received, '.factory'))).toBe(false);
    expect(existsSync(store('setup-acceptances.json'))).toBe(false);
  });

  it('shows the hook change with the yes flag, writes only the coordinator settings file, and then start --dry-run asks nothing and doctor exits 0 (TP-26)', async () => {
    const received = await receivedFactory();
    const file = join(received, 'coordinator', '.claude', 'settings.local.json');
    const init = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(init.code).toBe(0);
    expect(init.stderr).toContain(`This changes the settings of Claude Code in ${join(await realpath(received), 'coordinator', '.claude', 'settings.local.json')}:`);
    expect(init.stderr).toContain('factory hook Stop');
    expect(await box.read(file)).toContain('factory hook statusline');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await box.git(received, ['status', '--porcelain', '-uall'])).stdout).toBe('');

    const dry = await box.run(['start', '--dry-run', '--home', received], { env: second() });
    expect({ code: dry.code, stderr: dry.stderr }).toEqual({ code: 0, stderr: '' });
    expect(dry.stdout).not.toContain('This changes the settings of Claude Code');
    const doctor = await box.run(['doctor', '--home', received], { env: second() });
    expect(doctor.code).toBe(0);
  });

  it('exits 2 with no terminal window and no yes flag, and writes no settings file (TP-16)', async () => {
    const received = await receivedFactory();
    const result = await box.run(['init'], { cwd: received, env: second() });
    expect(result.code).toBe(2);
    expect(existsSync(join(received, 'coordinator', '.claude'))).toBe(false);
    expect(existsSync(join(received, '.factory'))).toBe(false);
  });

  it('stops on a received factory that tracks other files, with no terminal window, also with the yes flag, and writes nothing (TP-27)', async () => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    await writeFile(join(box.node, 'CLAUDE.md'), 'Do what the file says.\n');
    expect((await box.git(box.node, ['add', '-f', 'CLAUDE.md'])).code).toBe(0);
    expect((await box.git(box.node, ['commit', '-q', '-m', 'add an instruction file'])).code).toBe(0);
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);

    for (const [args, code] of [
      [['init'], 2],
      [['init', '--yes'], 4],
    ] as const) {
      const result = await box.run(args, { cwd: received, env: second() });
      expect(result.code).toBe(code);
      expect(existsSync(join(received, 'coordinator', '.claude'))).toBe(false);
      expect(existsSync(join(received, 'factory.local.yaml'))).toBe(false);
      expect(existsSync(join(received, '.factory'))).toBe(false);
      expect(existsSync(store('setup-acceptances.json'))).toBe(false);
    }
  });

  it('skips the clone of a project with no URL, warns, and names the folder to fill (TP-120)', async () => {
    const web = await box.makeProject('web');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
    await dropSetupText();
    const received = join(box.root, 'received');
    expect((await box.git(box.root, ['clone', '-q', box.node, received])).code).toBe(0);
    const result = await box.run(['init', '--yes'], { cwd: received, env: second() });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(join(received, 'web'));
    expect(existsSync(join(received, 'web'))).toBe(false);
    const start = await box.run(['start', '--dry-run', '--home', received], { env: second() });
    expect(start.code).toBe(0);
    expect(start.stderr).toContain(join(received, 'web'));
  });
});

describe('factory init: a folder that holds both config files (built binary)', () => {
  const listFile = (): string => join(box.root, 'home', '.local', 'state', 'factory', 'homes.json');
  const listed = async (): Promise<{ home: string; id: string; origin?: string }[]> =>
    (JSON.parse(await box.read(listFile())) as { homes: { home: string; id: string; origin?: string }[] }).homes;
  const commitCount = async (folder: string): Promise<number> =>
    Number((await box.git(folder, ['rev-list', '--count', 'HEAD'])).stdout.trim());

  /** The factory of the test, made by `init` and registered. */
  const registered = async (): Promise<void> => {
    const web = await box.makeProject('web', 'git@github.com:acme/web.git');
    expect((await box.run(initArgs(['--project', web]))).code).toBe(0);
  };

  /** The same factory in another place: the folder moves, and the factory list keeps the old place. It has no setup text. */
  const moved = async (): Promise<string> => {
    await registered();
    await dropSetupText();
    const place = join(box.root, 'moved');
    await rename(box.node, place);
    return place;
  };

  it('registers a moved factory, keeps the local file byte-equal, and doctor and start --dry-run exit 0 (TP-82)', async () => {
    const place = await moved();
    const local = await box.read(join(place, 'factory.local.yaml'));
    const result = await box.run(['init', '--yes'], { cwd: place });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('The node id demo is in the factory list for another factory folder');
    expect(result.stdout).toContain('Registered the node "demo"');
    expect(result.stdout).toContain('has no entry');
    expect(await box.read(join(place, 'factory.local.yaml'))).toBe(local);
    expect((await box.git(place, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    expect((await box.run(['doctor', '--home', place])).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', place])).code).toBe(0);
    const entries = await listed();
    expect(entries.map((entry) => entry.origin)).toEqual(['own', 'received']);
    expect(entries.map((entry) => entry.id)).toEqual(['demo', 'demo']);
  });

  it('says nothing about delegations when the local file asks for none (TP-82)', async () => {
    const place = await moved();
    const result = await box.run(['init', '--yes'], { cwd: place });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('delegat');
  });

  it('says that each delegation must be set again and names the command, and counts the point as owner (TP-82)', async () => {
    const place = await moved();
    const local = join(place, 'factory.local.yaml');
    await writeFile(local, (await box.read(local)).replace('merge: owner', 'merge: delegated'), { mode: 0o600 });
    const result = await box.run(['init', '--yes', '--json'], { cwd: place });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as { approval: Record<string, string>; warnings: string[] };
    expect(report.approval).toMatchObject({ merge: 'owner', release: 'owner' });
    const text = report.warnings.join('\n');
    expect(text).toContain('delegated at: merge');
    expect(text).toContain('run "factory init" in a terminal window outside a factory session');
  });

  it('exits 4 in a factory session on a moved root and writes nothing (TP-83)', async () => {
    const place = await moved();
    const before = await box.read(listFile());
    const result = await box.run(['init', '--yes'], { cwd: place, env: { FACTORY_SESSION: 'demo' } });
    expect(result.code).toBe(4);
    expect(await box.read(listFile())).toBe(before);
  });

  it('exits 1 and changes nothing when the factory list cannot be written (TP-95)', async () => {
    const place = await moved();
    const stateHome = join(box.root, 'state-locked');
    await mkdir(join(stateHome, 'factory'), { recursive: true, mode: 0o700 });
    await writeHeldLock(join(stateHome, 'factory', 'homes.json.lock'));
    const local = await box.read(join(place, 'factory.local.yaml'));
    const marker = await box.read(join(place, '.factory', 'node.json'));
    const result = await box.run(['init', '--yes'], { cwd: place, env: { XDG_STATE_HOME: stateHome } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('holds the lock');
    expect(await box.read(join(place, 'factory.local.yaml'))).toBe(local);
    expect(await box.read(join(place, '.factory', 'node.json'))).toBe(marker);
    expect((await box.git(place, ['status', '--porcelain', '-uall'])).stdout).toBe('');
  });

  it('registers a folder whose entry has another node id, with the origin received (TP-84)', async () => {
    await registered();
    await dropSetupText();
    const config = join(box.node, 'factory.yaml');
    const text = await box.read(config);
    expect(text).toMatch(/^ {2}id: demo\b/m);
    await writeFile(config, text.replace(/^( {2}id: )demo\b/m, '$1other'));
    const refused = await box.run(['doctor', '--home', box.node]);
    expect(refused.code).toBe(4);
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('another id');
    const real = await realpath(box.node);
    const entries = (await listed()).filter((entry) => entry.home === real);
    expect(entries).toEqual([expect.objectContaining({ id: 'other', origin: 'received' })]);
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
  });

  it('exits 4 and changes nothing for a folder whose id changed after the first init, with no terminal window and the yes flag (TP-170)', async () => {
    await registered();
    const config = join(box.node, 'factory.yaml');
    await writeFile(config, (await box.read(config)).replace(/^( {2}id: )demo\b/m, '$1other'));
    const before = await listed();
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('factory init');
    expect(await listed()).toEqual(before);
  });

  it('makes the state folder again when it is missing, and commits it (TP-85)', async () => {
    await registered();
    await rm(join(box.node, '.factory'), { recursive: true, force: true });
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(4);
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(0);
    expect(existsSync(join(box.node, '.factory', 'node.json'))).toBe(true);
    expect(await commitCount(join(box.node, '.factory'))).toBe(1);
    expect((await box.git(join(box.node, '.factory'), ['status', '--porcelain'])).stdout).toBe('');
    expect((await box.git(box.node, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', box.node])).code).toBe(0);
    expect((await listed()).map((entry) => entry.origin)).toEqual(['own']);
  });

  it('writes a broken marker again and commits only the marker (TP-96)', async () => {
    await registered();
    const state = join(box.node, '.factory');
    const marker = join(state, 'node.json');
    const board = await box.read(join(state, 'board.json'));
    await writeFile(marker, '{not json');
    await box.git(state, ['add', 'node.json']);
    await box.git(state, ['commit', '-m', 'break the marker']);
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(4);
    const before = await commitCount(state);
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.factory/node.json');
    expect(await commitCount(state)).toBe(before + 1);
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
    expect(await box.read(join(state, 'board.json'))).toBe(board);
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', box.node])).code).toBe(0);
  });

  it('writes a missing marker again, keeps the other files, and start --dry-run then exits 0 (TP-96)', async () => {
    await registered();
    const state = join(box.node, '.factory');
    const marker = join(state, 'node.json');
    const board = await box.read(join(state, 'board.json'));
    await rm(marker);
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(4);
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('.factory/node.json');
    expect(existsSync(marker)).toBe(true);
    expect(await box.read(join(state, 'board.json'))).toBe(board);
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', box.node])).code).toBe(0);
  });

  it('writes a marker that was broken and not committed, and makes no commit, since git holds the same text (TP-96)', async () => {
    await registered();
    const state = join(box.node, '.factory');
    await writeFile(join(state, 'node.json'), '{not json');
    const before = await commitCount(state);
    const result = await box.run(['init', '--yes', '--json'], { cwd: box.node });
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { warnings: string[] }).warnings.join('\n')).not.toContain('not committed');
    expect(await commitCount(state)).toBe(before);
    expect((await box.git(state, ['status', '--porcelain'])).stdout).toBe('');
    expect((await box.run(['doctor', '--home', box.node])).code).toBe(0);
    expect((await box.run(['start', '--dry-run', '--home', box.node])).code).toBe(0);
  });

  it('exits 4 and changes nothing when .factory is a file (TP-119)', async () => {
    await registered();
    await rm(join(box.node, '.factory'), { recursive: true, force: true });
    await writeFile(join(box.node, '.factory'), 'not a folder');
    const result = await box.run(['init', '--yes'], { cwd: box.node });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('.factory');
    expect(await box.read(join(box.node, '.factory'))).toBe('not a folder');
  });

  it('sets an approval point again on a registered root, and writes the record after the entry in the factory list (TP-181)', async () => {
    await registered();
    const result = await box.run(['init', '--yes', '--approval', 'merge=owner'], { cwd: box.node });
    expect([result.code, result.stderr]).toEqual([0, '']);
    expect(await listed()).toHaveLength(1);
  });
});
