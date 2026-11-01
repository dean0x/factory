import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { denyMatches } from '../helpers/deny-list.js';
import { makeSandbox, type Sandbox } from './harness.js';

let box: Sandbox;

beforeEach(async () => {
  box = await makeSandbox();
});

afterEach(async () => {
  await box.remove();
});

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
    for (const name of ['factory.yaml', 'CLAUDE.md', '.factory/node.json', '.factory/protocol.md']) {
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

  it('succeeds in a folder below a parent that has a config file, with a warning', async () => {
    expect((await box.run(['init', '--home', box.root, '--name', 'parent', '--owner-name', 'Test Owner'])).code).toBe(0);
    const child = await box.run(initArgs());
    expect(child.code).toBe(0);
    expect(child.stderr).toContain(join(box.root, 'factory.yaml'));
    const state = JSON.parse(await box.read(join(box.node, '.factory', 'node.json'))) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(['blocks', 'created_with', 'schema_version']);
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
      '.factory/protocol.md',
      '.factory/decision-profile/README-format.md',
      '.factory/decision-profile/index.md',
      '.factory/roadmaps/README.md',
    ]) {
      expect({ name, found: denyMatches(await box.read(join(box.node, name))) }).toEqual({ name, found: [] });
    }
  });
});
