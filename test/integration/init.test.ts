import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    for (const name of ['factory.yaml', 'CLAUDE.md', '.factory/node.json', '.factory/roles/worker.md']) {
      expect(existsSync(join(box.node, name))).toBe(true);
    }
    const config = await box.read(join(box.node, 'factory.yaml'));
    expect(config).toContain('repo: "acme/web"');
    expect(config).toContain('path: "../web"');
  });

  it('makes the first commit in the state repository', async () => {
    await box.run(initArgs());
    const log = await box.git(join(box.node, '.factory'), ['log', '--format=%s']);
    expect(log.stdout.trim()).toBe('chore: initialize the state');
    const status = await box.git(join(box.node, '.factory'), ['status', '--porcelain']);
    expect(status.stdout).toBe('');
  });

  it('refuses a second init in the same home with exit 1', async () => {
    expect((await box.run(initArgs())).code).toBe(0);
    const second = await box.run(initArgs());
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('factory.yaml already exists');
  });

  it('refuses with exit 4 a folder below a parent that has a config file, and creates nothing', async () => {
    expect((await box.run(['init', '--home', box.root, '--name', 'parent', '--owner-name', 'Test Owner'])).code).toBe(0);
    const child = await box.run(initArgs());
    expect(child.code).toBe(4);
    expect(child.stderr).toContain('inside another node home');
    expect(child.stderr).toContain('factory.yaml exists');
    expect(existsSync(box.node)).toBe(false);
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
      'CLAUDE.md',
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
    const web = await box.makeProject('ws/web');
    await box.makeProject('ws/api');
    await box.git(web, ['commit', '--allow-empty', '-q', '-m', 'first']);
    const linked = await box.git(web, ['worktree', 'add', '-q', '-b', 'search', join(ws, 'web-search')]);
    expect(linked.code).toBe(0);
    return ws;
  };

  it('makes ./<folder>-factory with the repos as projects, names the other checkout as skipped, and exits 0', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', '--yes', ...ownerArgs], { cwd: ws });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    const home = join(ws, 'ws-factory');
    const config = await box.read(join(home, 'factory.yaml'));
    expect(config).toContain('path: "../web"');
    expect(config).toContain('path: "../api"');
    expect(config).not.toContain('web-search');
    expect(result.stdout).toContain('web-search');
    expect(result.stdout).toContain('one more checkout of the repo web');
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(false);
    const doctor = await box.run(['doctor', '--home', home]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('holds no git repo one level down');
  });

  it('exits 4 and names the rule for --home on the workspace folder', async () => {
    const ws = await makeWorkspace();
    const result = await box.run(['init', '--home', '.', ...ownerArgs], { cwd: ws });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('holds the git repo');
    expect(result.stderr).toContain('one level down');
    expect(existsSync(join(ws, 'factory.yaml'))).toBe(false);
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
    const api = await box.makeProject('api');
    const result = await box.run(['init', '--yes', ...ownerArgs, '--project', api], { cwd: web });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    const home = join(box.root, 'web-factory');
    const config = await box.read(join(home, 'factory.yaml'));
    expect(config).toContain('repo: "acme/web"');
    expect(config.indexOf('path: "../web"')).toBeGreaterThan(0);
    expect(config.indexOf('path: "../api"')).toBeGreaterThan(config.indexOf('path: "../web"'));
    expect(existsSync(join(home, '.factory', 'roles', 'worker.md'))).toBe(true);
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

  it('refuses with exit 4 a home inside a git work tree', async () => {
    const web = await box.makeProject('web');
    const result = await box.run(['init', '--home', join(web, 'node'), ...ownerArgs]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('inside the git work tree');
    expect(existsSync(join(web, 'node'))).toBe(false);
  });

  it('refuses with exit 4 a home that holds a project', async () => {
    const holder = join(box.root, 'holder');
    await box.makeProject('holder/app');
    const result = await box.run(['init', '--home', holder, ...ownerArgs, '--project', join(holder, 'app')]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('is the project folder');
    expect(existsSync(join(holder, 'factory.yaml'))).toBe(false);
  });

  it('makes a node on layer 2 with the manager block, and doctor accepts it', async () => {
    const result = await box.run(initArgs(['--layer', '2']));
    expect(result.code).toBe(0);
    const claude = await box.read(join(box.node, 'CLAUDE.md'));
    expect(claude).toContain('factory:begin manager');
    expect(claude).not.toContain('factory:begin coordinator');
    expect(existsSync(join(box.node, '.factory', 'roles', 'worker.md'))).toBe(false);
    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('2 managed blocks are intact');
  });

  it('makes a node on layer 3 with the safety block only, warns and names the layer, and doctor warns the same', async () => {
    const result = await box.run(initArgs(['--layer', '3']));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('Layer 3 has no role template');
    const claude = await box.read(join(box.node, 'CLAUDE.md'));
    expect(claude).toContain('factory:begin safety');
    expect(claude).not.toContain('factory:begin coordinator');
    expect(claude).not.toContain('factory:begin manager');
    expect(existsSync(join(box.node, '.factory', 'roles', 'worker.md'))).toBe(false);

    const doctor = await box.run(['doctor', '--home', box.node]);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain('layer 3 has no role template');
    expect(doctor.stdout).toContain('1 managed blocks are intact');
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
