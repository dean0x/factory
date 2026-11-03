import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyMatches } from '../helpers/deny-list.js';
import { makeSandbox, removeOpenSandboxes, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

afterAll(removeOpenSandboxes);

const initArgs = (extra: readonly string[] = []): string[] => [
  'init',
  '--home',
  box.node,
  '--name',
  'demo',
  '--owner-name',
  'Test Owner',
  ...extra,
];

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
    expect((await readdir(join(box.node, 'coordinator'))).sort()).toEqual(['CLAUDE.md']);
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
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
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

  it('refuses a second init in the same home with exit 1', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const second = await box.run(initArgs());
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('factory.yaml already exists');
  });

  it('refuses with exit 1 a folder inside a root that the factory list holds, names a remedy and creates nothing', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const inner = join(box.node, 'inner');
    const child = await box.run(['init', '--home', inner, '--name', 'inner', '--owner-name', 'Test Owner']);
    expect(child.code).toBe(1);
    expect(child.stderr).toContain('is inside the factory folder');
    expect(child.stderr).toContain('Choose another folder with --home DIR.');
    expect(existsSync(inner)).toBe(false);
  });

  it('accepts a root beside a root that the factory list holds', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const beside = await box.run(['init', '--home', join(box.root, 'other'), '--name', 'other', '--owner-name', 'Test Owner']);
    expect(beside.code).toBe(0);
  });

  it('exits 1 when the factory list cannot be written, makes no root, and lets a second init succeed (TP-74)', async () => {
    const stateHome = join(box.root, 'state');
    const listFolder = join(stateHome, 'factory');
    const lock = join(listFolder, 'homes.json.lock');
    // Another command holds the lock of the list. The write of the list is the last step of init, and it fails.
    await mkdir(listFolder, { recursive: true, mode: 0o700 });
    await writeFile(lock, '1\n');
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
    expect(result.stdout).toContain('one more checkout of the repo web');
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(false);
    for (const name of ['web', 'api']) expect(existsSync(join(home, name, '.git'))).toBe(true);
    expect((await box.git(home, ['status', '--porcelain', '-uall'])).stdout).toBe('');
    const doctor = await box.run(['doctor', '--home', home]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('the top folder of its own git work tree');
  });

  it('makes the workspace folder the root for --home, with the repos of the folder as plain folders and no project', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', '--home', '.', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(0);
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(true);
    expect(await box.read(join(ws, 'factory.yaml'))).toContain('projects: []');
    expect((await box.git(ws, ['status', '--porcelain', '-uall'])).stdout).toBe('');
  });

  it('prints the proposal and exits 2 without a terminal and without --yes', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('The proposed node home is');
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
    expect(result.stderr).toContain('The proposed node home is');
    expect(result.stderr).toContain('web-factory');
    expect(result.stderr).toContain('--yes');
    expect(existsSync(join(box.root, 'web-factory'))).toBe(false);
  });

  it('uses the current folder when it is in no work tree', async () => {
    const result = await box.run(['init', '--name', 'here', ...ownerArgs], { cwd: box.root });
    expect(result.code).toBe(0);
    expect(existsSync(join(box.root, 'factory.yaml'))).toBe(true);
  });

  it('accepts a home inside a git work tree: the root is a git repo of its own', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(['init', '--home', join(web, 'node'), ...ownerArgs]);
    expect(result.code).toBe(0);
    expect((await box.git(join(web, 'node'), ['rev-parse', '--show-prefix'])).stdout).toBe('\n');
  });

  it('takes a work tree that is a folder of the root already as a project, and clones nothing', async () => {
    const holder = join(box.root, 'holder');
    await box.makeProject('holder/app');
    const result = await box.run(['init', '--home', holder, ...ownerArgs, '--project', join(holder, 'app')]);
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
